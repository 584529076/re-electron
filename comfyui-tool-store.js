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
            console.warn(`[comfyui-tool-store] 加载 workflow ${wfPath} 失败: ${e.message}`);
            _workflows.set(toolId, { json: null, broken: true, error: e.message, path: wfPath });
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
    // 返回浅拷贝（避免 renderer 改原对象）
    return {
        id: t.id, name: t.name, description: t.description || '',
        mode: t.mode || 'sfw',
        placeholders: t.placeholders || {},
        formFields: (t.formFields || []).map(f => ({ ...f })),
        outputNodes: (t.outputNodes || []).map(o => ({ ...o })),
        broken: !!t._broken, error: t._error,
        coverUrl: cover.url,
        coverFallback: cover.fallback,
    };
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
