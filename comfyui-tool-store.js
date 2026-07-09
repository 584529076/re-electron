// comfyui-tool-store.js — AI 工具注册表
//
// 从 resources/comfyui-workflows/*.schema.json 加载 schema；
// 同目录的 workflow JSON 按 schema.workflowFile 字段加载。
// 提供 list / get / getWorkflow 三个查询函数。
//
// Schema 形状见 qwen_image_nsfw.schema.json；formFields 每项带 nodeId+field 声明
// 可编辑节点 input，由 main.js 的 tools:run handler 调 applier 注入。

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getWorkflowsDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'resources', 'comfyui-workflows');
    return path.join(__dirname, 'resources', 'comfyui-workflows');
}

// 内存注册表：id → { id, name, description, mode, workflowFile, placeholders, formFields, outputNodes, _loadedAt, _broken, _error }
const _tools = new Map();
// 缓存 workflow JSON：id → { json, broken, error, path }
const _workflows = new Map();

function loadAll() {
    _tools.clear();
    _workflows.clear();
    const dir = getWorkflowsDir();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        console.warn('[comfyui-tool-store] 读 ' + dir + ' 失败: ' + e.message);
        return;
    }
    for (const name of entries) {
        if (!name.endsWith('.schema.json')) continue;
        const schemaPath = path.join(dir, name);
        const toolId = name.replace(/\.schema\.json$/, '');
        try {
            const txt = fs.readFileSync(schemaPath, 'utf-8');
            const schema = JSON.parse(txt);
            // 校验必备字段
            if (!schema.id || !schema.workflowFile || !Array.isArray(schema.formFields)) {
                throw new Error('schema 缺 id / workflowFile / formFields');
            }
            if (schema.id !== toolId) {
                console.warn(`[comfyui-tool-store] ${name} 的 id 字段(${schema.id}) 与文件名不一致，使用文件名`);
                schema.id = toolId;
            }
            schema._loadedAt = Date.now();
            schema._broken = false;
            schema._error = null;
            schema._schemaPath = schemaPath;
            _tools.set(toolId, schema);
        } catch (e) {
            console.warn(`[comfyui-tool-store] 加载 ${schemaPath} 失败: ${e.message}`);
            _tools.set(toolId, {
                id: toolId, name: toolId, description: 'schema 解析失败',
                _loadedAt: Date.now(), _broken: true, _error: e.message, _schemaPath: schemaPath,
                formFields: [], outputNodes: [],
            });
        }
    }
    // 配套加载 workflow JSON（懒加载策略：只读不 parse，要用时再 parse）
    for (const [toolId, schema] of _tools) {
        if (schema._broken) continue;
        const wfPath = path.join(dir, schema.workflowFile);
        try {
            if (!fs.existsSync(wfPath)) throw new Error('找不到文件: ' + wfPath);
            const txt = fs.readFileSync(wfPath, 'utf-8');
            const json = JSON.parse(txt);
            _workflows.set(toolId, { json, broken: false, error: null, path: wfPath });
        } catch (e) {
            // workflow 缺失/损坏也要把工具标记为 broken，这样 listTools 能告诉 renderer「这个工具不能用」
            // 避免用户在 dropdown 选了一个点了之后才报 ENOENT
            console.warn(`[comfyui-tool-store] 加载 workflow ${wfPath} 失败: ${e.message}`);
            _workflows.set(toolId, { json: null, broken: true, error: e.message, path: wfPath });
            schema._broken = true;
            schema._error = 'workflow 文件缺失或损坏: ' + (schema.workflowFile || '?') + ' — ' + e.message;
        }
    }
}

function listTools() {
    const out = [];
    for (const t of _tools.values()) {
        const cover = resolveCover(t);
        // 列出 formFields / outputNodes 的轻量摘要（仅 type + id），让 renderer 在不开二次 get 的情况下
        // 判断工具类型（例如「是否文生图」—— 仅看是否含 image 字段 + 是否有 textarea + 输出是 image）。
        const fieldTypes = (t.formFields || []).map(f => ({ id: f.id, type: f.type }));
        const outputNodeTypes = (t.outputNodes || []).map(n => ({ nodeId: n.nodeId, type: n.type }));
        out.push({
            id: t.id,
            name: t.name,
            description: t.description || '',
            mode: t.mode || 'sfw',
            accepts: Array.isArray(t.accepts) ? t.accepts : [],
            broken: !!t._broken,
            error: t._error,
            formFieldCount: (t.formFields || []).length,
            fieldTypes,
            outputNodeTypes,
            coverUrl: cover.url,
            coverFallback: cover.fallback,
        });
    }
    return out;
}

function getTool(id) {
    const t = _tools.get(id);
    if (!t) return null;
    const cover = resolveCover(t);
    // 从 workflow JSON 静态值里提取主模型 basename（用于 Lora 字段按模型过滤的 UI 提示）
    const mainModel = extractMainModel(t);
    // 返回浅拷贝（避免 renderer 改原对象）
    return {
        id: t.id, name: t.name, description: t.description || '',
        mode: t.mode || 'sfw',
        accepts: Array.isArray(t.accepts) ? t.accepts : [],
        placeholders: t.placeholders || {},
        // schema 显式声明的适配模型（来自 LORA 适配模型枚举：ZIT/ZIB/Krea2/Kelin2/Flux/Flux2/Qwen/Wan2.1/Wan2.2/Anime）
        // 多模型工作流（如 ZIB+ZIT 双采）传数组；缺省为空数组时回退到 mainModel（按 JSON 静态值提取）
        models: Array.isArray(t.models) ? t.models.slice() : [],
        modelField: t.modelField || null,
        mainModel,
        formFields: (t.formFields || []).map(f => ({ ...f })),
        outputNodes: (t.outputNodes || []).map(o => ({ ...o })),
        broken: !!t._broken, error: t._error,
        coverUrl: cover.url,
        coverFallback: cover.fallback,
    };
}

// 从 workflow JSON 提取主模型 basename（节点静态值）
// 优先级：1) schema.modelField 显式声明 2) 第一个 CheckpointLoaderSimple 的 ckpt_name
function extractMainModel(t) {
    const wf = _workflows.get(t.id);
    if (!wf || !wf.json) return '';
    try {
        // 1) schema.modelField
        if (t.modelField && t.modelField.nodeId) {
            const n = wf.json[t.modelField.nodeId];
            if (n && n.inputs && n.inputs[t.modelField.field]) {
                return String(n.inputs[t.modelField.field]).trim();
            }
        }
        // 2) 扫 CheckpointLoaderSimple / CheckpointLoader / UNETLoader (Flux/Wan) / UnetLoaderGGUF
        for (const [, node] of Object.entries(wf.json)) {
            if (!node || typeof node !== 'object') continue;
            const cls = String(node.class_type || '');
            let modelName = '';
            if (cls === 'CheckpointLoaderSimple' || cls === 'CheckpointLoader' || cls === 'unCLIPCheckpointLoader') {
                modelName = node.inputs && node.inputs.ckpt_name;
            } else if (cls === 'UNETLoader' || cls === 'UnetLoaderGGUF') {
                modelName = node.inputs && node.inputs.unet_name;
            }
            if (modelName && typeof modelName === 'string' && modelName.trim()) return modelName.trim();
        }
    } catch (e) { /* ignore */ }
    return '';
}

// 解析封面：优先级
//   1) schema.cover 显式指定（相对 workflows 目录）
//   2) <toolId>.cover.{png,jpg,jpeg,webp} 同目录约定（最常用）
//   3) 都没有 → url=null，renderer 用 fallback（gradient+icon）
function resolveCover(t) {
    const fallback = t.coverFallback || { icon: 'fa-image', gradient: ['#6b7280', '#374151'] };
    const dir = getWorkflowsDir();
    const exts = ['.png', '.jpg', '.jpeg', '.webp'];
    const candidates = [];
    // 1) 显式路径
    if (t.cover) candidates.push(path.join(dir, t.cover));
    // 2) 约定：<toolId>.cover.<ext>
    for (const ext of exts) candidates.push(path.join(dir, t.id + '.cover' + ext));
    for (const full of candidates) {
        try {
            if (fs.existsSync(full)) {
                return { url: 'file:///' + full.replace(/\\/g, '/'), fallback };
            }
        } catch (e) { /* 继续尝试下一个 */ }
    }
    return { url: null, fallback };
}

function getWorkflow(toolId) {
    const wf = _workflows.get(toolId);
    if (!wf) return { ok: false, error: `工具 ${toolId} 不存在` };
    if (wf.broken) return { ok: false, error: wf.error || 'workflow 加载失败' };
    // 返回深拷贝，避免被 renderer 改原对象
    return { ok: true, workflow: JSON.parse(JSON.stringify(wf.json)) };
}

module.exports = {
    loadAll,
    listTools,
    getTool,
    getWorkflow,
};
