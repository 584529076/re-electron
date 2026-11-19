// comfyui-tool-store.js — AI 工具注册表
//
// 从 resources/comfyui-workflows/*.schema.json 加载 schema；
// 同目录的 workflow JSON 按 schema.workflowFile 字段加载。
// 提供 list / get / getWorkflow 三个查询函数。
//
// 2026-11 改造：
//   - loadAll 时对每个 schema 做「nodeId 存在性」前置校验；节点缺失的工具直接标 broken，
//     这样 renderer 的工具列表会提前标红禁用，不会等用户点了才在 applier 里 warn。
//   - 新增 reloadAll() / importTool() 支持「图形化导入向导」免重启刷新。
//   - 字段级（inputs[field]）缺失只记 warning（rgthree 等动态 slot 节点没有静态字段），
//     不标 broken，避免误伤。

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getWorkflowsDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'resources', 'comfyui-workflows');
    return path.join(__dirname, 'resources', 'comfyui-workflows');
}

// 内存注册表：id → schema（带 _broken / _error / _validationProblems）
const _tools = new Map();
// 缓存 workflow JSON：id → { json, broken, error, path }
const _workflows = new Map();

// 探测 workflow 里的宽高常量节点（这些节点的 width/height 是写死的常量，适合暴露成表单）
// 只处理「数字常量」；连线（数组）说明宽高由上游/输入图决定，不暴露。
const SIZE_NODE_PRIORITY = [
    'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage', 'EmptySVDLatentImage',
    'EmptyMochiLatentImage', 'EmptyLTXVLatentVideo', 'EmptyHunyuanLatentVideo',
    'ImageResize+', 'ImageResizeKJv2', 'LatentUpscaleBy', 'LatentUpscale', 'ImageScale', 'ImageScaleBy',
];
function detectSizeNode(workflow) {
    const cands = [];
    for (const [id, node] of Object.entries(workflow || {})) {
        if (!node || !node.inputs) continue;
        const w = node.inputs.width, h = node.inputs.height;
        if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) continue;
        const cls = String(node.class_type || '');
        const pi = SIZE_NODE_PRIORITY.findIndex(p => p.toLowerCase() === cls.toLowerCase());
        if (pi < 0) continue;
        cands.push({ id: String(id), cls, w, h, pr: pi });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.pr - b.pr);
    return cands[0];
}

// 若 schema 没有显式声明 width/height，且 workflow 有宽高常量节点，自动注入两个 size 字段。
// 默认值取自 workflow JSON —— 这样「接入对应工作流的默认宽高参数」自动覆盖所有工具，
// 也无需为每个 schema 手写字段。显式声明（如 qwen_image_nsfw）优先，不覆盖。
function ensureSizeFields(schema, workflow) {
    if (!Array.isArray(schema.formFields)) schema.formFields = [];
    const hasW = schema.formFields.some(f => f && (f.id === 'width' || (f.field === 'width' && f.nodeId)));
    const hasH = schema.formFields.some(f => f && (f.id === 'height' || (f.field === 'height' && f.nodeId)));
    if (hasW && hasH) return false;
    const det = detectSizeNode(workflow);
    if (!det) return false;
    const note = `自动探测自节点 ${det.id} (${det.cls})`;
    if (!hasW) schema.formFields.push({
        id: 'width', label: '宽度', type: 'number', nodeId: det.id, field: 'width',
        default: det.w, min: 64, max: 4096, step: 8, panel: 'size', note,
    });
    if (!hasH) schema.formFields.push({
        id: 'height', label: '高度', type: 'number', nodeId: det.id, field: 'height',
        default: det.h, min: 64, max: 4096, step: 8, panel: 'size', note,
    });
    schema._autoSizeNode = det.id;
    return true;
}

// ============ schema 前置校验 ============
// 返回 { errors: [...], warnings: [...] }
// errors 里的 nodeId 缺失 → 工具标 broken；warnings 只记录不拦截。
function validateSchema(schema, workflow) {
    const errors = [];
    const warnings = [];
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        errors.push({ target: 'workflow', reason: 'workflow JSON 不是对象' });
        return { errors, warnings };
    }
    const nodeExists = (id) => (id != null && workflow[String(id)] != null);
    const fieldExists = (id, field) => {
        const n = workflow[String(id)];
        return !!(n && n.inputs && Object.prototype.hasOwnProperty.call(n.inputs, field));
    };

    // placeholder 是老机制残留：applier 对它缺节点本就是 warn 跳过，
    // 真正生效的是 formFields（如 positive_prompt→节点664）。所以这里降级为 warning，
    // 不因历史遗留的失效 placeholder 误伤实际可用的工具。
    for (const [ph, mapping] of Object.entries(schema.placeholders || {})) {
        if (!mapping || mapping.nodeId == null) continue;
        if (!nodeExists(mapping.nodeId)) {
            warnings.push({ target: `placeholder:${ph}`, reason: `占位符节点 ${mapping.nodeId} 不存在（旧机制残留，可安全删除该 placeholder）` });
        } else if (mapping.field && !fieldExists(mapping.nodeId, mapping.field)) {
            warnings.push({ target: `placeholder:${ph}`, reason: `节点 ${mapping.nodeId} 无输入字段 ${mapping.field}` });
        }
    }

    for (const f of (schema.formFields || [])) {
        const id = f.id || '(unnamed)';
        if (f.type === 'lora') {
            if (f.nodeId != null && !nodeExists(f.nodeId)) errors.push({ target: id, reason: `Lora 节点 ${f.nodeId} 不存在` });
            if (f.weightNodeId != null && !nodeExists(f.weightNodeId)) errors.push({ target: id, reason: `Lora 权重节点 ${f.weightNodeId} 不存在` });
        } else if (f.type === 'loraMulti') {
            if (f.powerLoraLoaderNodeId != null) {
                if (!nodeExists(f.powerLoraLoaderNodeId)) errors.push({ target: id, reason: `Power Lora 节点 ${f.powerLoraLoaderNodeId} 不存在` });
            } else {
                for (const nid of (f.nodeIds || [])) {
                    if (!nodeExists(nid)) errors.push({ target: id, reason: `Lora 节点 ${nid} 不存在` });
                }
            }
        } else if (f.nodeId != null) {
            if (!nodeExists(f.nodeId)) {
                errors.push({ target: id, reason: `节点 ${f.nodeId} 不存在` });
            } else if (f.field && !fieldExists(f.nodeId, f.field)) {
                warnings.push({ target: id, reason: `节点 ${f.nodeId} 无输入字段 ${f.field}（可能是动态端口）` });
            }
        }
    }

    if (schema.modelField && schema.modelField.nodeId != null && !nodeExists(schema.modelField.nodeId)) {
        errors.push({ target: 'modelField', reason: `节点 ${schema.modelField.nodeId} 不存在` });
    }
    for (const o of (schema.outputNodes || [])) {
        if (o.nodeId != null && !nodeExists(o.nodeId)) errors.push({ target: `output:${o.nodeId}`, reason: `输出节点 ${o.nodeId} 不存在` });
    }
    return { errors, warnings };
}

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
            if (!schema.id || !schema.workflowFile || !Array.isArray(schema.formFields)) {
                throw new Error('schema 缺 id / workflowFile / formFields');
            }
            if (schema.id !== toolId) {
                console.warn(`[comfyui-tool-store] ${name} 的 id 字段(${schema.id}) 与文件名不一致，使用文件名`);                schema.id = toolId;
            }
            schema._loadedAt = Date.now();
            schema._broken = false;
            schema._error = null;
            schema._schemaPath = schemaPath;
            schema._validationProblems = [];
            _tools.set(toolId, schema);
        } catch (e) {
            console.warn(`[comfyui-tool-store] 加载 ${schemaPath} 失败: ${e.message}`);
            _tools.set(toolId, {
                id: toolId, name: toolId, description: 'schema 解析失败',
                _loadedAt: Date.now(), _broken: true, _error: e.message, _schemaPath: schemaPath,
                formFields: [], outputNodes: [], _validationProblems: [],
            });
        }
    }
    // 配套 workflow JSON + 前置校验
    for (const [toolId, schema] of _tools) {
        if (schema._broken) continue;
        const wfPath = path.join(dir, schema.workflowFile);
        try {
            if (!fs.existsSync(wfPath)) throw new Error('找不到文件: ' + wfPath);
            if (wfPath.includes('..')) throw new Error('workflowFile 非法: ' + schema.workflowFile);
            const txt = fs.readFileSync(wfPath, 'utf-8');
            const json = JSON.parse(txt);
            _workflows.set(toolId, { json, broken: false, error: null, path: wfPath });

            // 2026-11：若 schema 未显式定义 width/height，从 workflow 探测宽高常量节点自动注入
            ensureSizeFields(schema, json);

            const validation = validateSchema(schema, json);
            const errTargets = new Set((validation.errors || []).map(e => `${e.target}|${e.reason}`));
            schema._validationProblems = [...(validation.errors || []), ...(validation.warnings || [])].map(p => ({
                ...p,
                severity: errTargets.has(`${p.target}|${p.reason}`) ? 'error' : 'warning',
            }));
            if (validation.errors.length) {
                const summary = validation.errors.map(e => `${e.target}: ${e.reason}`).join('; ');
                schema._broken = true;
                schema._error = '工作流与 schema 不匹配（节点缺失）: ' + summary;
                console.warn(`[comfyui-tool-store] ${toolId} 校验失败: ${summary}`);
            }
        } catch (e) {
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
            validationProblems: (t._validationProblems || []).slice(),
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
    const mainModel = extractMainModel(t);
    return {
        id: t.id, name: t.name, description: t.description || '',
        mode: t.mode || 'sfw',
        accepts: Array.isArray(t.accepts) ? t.accepts : [],
        placeholders: t.placeholders || {},
        models: Array.isArray(t.models) ? t.models.slice() : [],
        modelField: t.modelField || null,
        mainModel,
        formFields: (t.formFields || []).map(f => ({ ...f })),
        outputNodes: (t.outputNodes || []).map(o => ({ ...o })),
        broken: !!t._broken, error: t._error,
        validationProblems: (t._validationProblems || []).slice(),
        coverUrl: cover.url,
        coverFallback: cover.fallback,
    };
}

function extractMainModel(t) {
    const wf = _workflows.get(t.id);
    if (!wf || !wf.json) return '';
    try {
        if (t.modelField && t.modelField.nodeId) {
            const n = wf.json[t.modelField.nodeId];
            if (n && n.inputs && n.inputs[t.modelField.field]) {
                return String(n.inputs[t.modelField.field]).trim();
            }
        }
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

function resolveCover(t) {
    const fallback = t.coverFallback || { icon: 'fa-image', gradient: ['#6b7280', '#374151'] };
    const dir = getWorkflowsDir();
    const exts = ['.png', '.jpg', '.jpeg', '.webp'];
    const candidates = [];
    if (t.cover) {
        if (t.cover.includes('..')) return { url: null, fallback };
        candidates.push(path.join(dir, t.cover));
    }
    for (const ext of exts) candidates.push(path.join(dir, t.id + '.cover' + ext));
    for (const full of candidates) {
        try {
            if (fs.existsSync(full)) return { url: 'file:///' + full.replace(/\\/g, '/'), fallback };
        } catch (e) { /* 继续 */ }
    }
    return { url: null, fallback };
}

function getWorkflow(toolId) {
    const wf = _workflows.get(toolId);
    if (!wf) return { ok: false, error: `工具 ${toolId} 不存在` };
    if (wf.broken) return { ok: false, error: wf.error || 'workflow 加载失败' };
    return { ok: true, workflow: JSON.parse(JSON.stringify(wf.json)) };
}

// ============ 免重启刷新 ============
function reloadAll() {
    loadAll();
    return listTools();
}

// ============ 图形化导入：保存新工具 ============
// payload: { id, name, description, mode, accepts, models, formFields, outputNodes, placeholders?, workflow }
function importTool(payload) {
    try {
        if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload 必填' };
        const id = String(payload.id || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_\-]{0,63}$/.test(id)) {
            return { ok: false, error: '工具 ID 只能含字母/数字/下划线/横线，且以字母开头（≤64 字符）' };
        }
        const workflow = payload.workflow;
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || !Object.keys(workflow).length) {
            return { ok: false, error: 'workflow 必须是 ComfyUI API 格式 JSON 对象（含节点）' };
        }
        for (const [nodeId, node] of Object.entries(workflow)) {
            if (!node || typeof node !== 'object' || !node.class_type) {
                return { ok: false, error: `节点 ${nodeId} 缺 class_type，不是合法的 API 格式 workflow` };
            }
        }
        const dir = getWorkflowsDir();
        const wfFile = `${id}.json`;
        const schemaFile = `${id}.schema.json`;
        const wfPath = path.join(dir, wfFile);
        const schemaPath = path.join(dir, schemaFile);
        if (fs.existsSync(wfPath) || fs.existsSync(schemaPath)) {
            return { ok: false, error: `工具 ID ${id} 已存在，请换一个 ID` };
        }
        const schema = {
            id,
            name: String(payload.name || id).slice(0, 80),
            description: String(payload.description || '').slice(0, 300),
            mode: payload.mode === 'nsfw' ? 'nsfw' : 'sfw',
            accepts: Array.isArray(payload.accepts) ? payload.accepts.filter(x => ['text', 'image', 'video'].includes(x)) : [],
            coverFallback: payload.coverFallback || { icon: 'fa-wand-magic-sparkles', gradient: ['#6366f1', '#ec4899'] },
            workflowFile: wfFile,
            models: Array.isArray(payload.models) ? payload.models : [],
            modelField: payload.modelField || null,
            placeholders: payload.placeholders || {},
            formFields: Array.isArray(payload.formFields) ? payload.formFields : [],
            outputNodes: Array.isArray(payload.outputNodes) ? payload.outputNodes : [],
        };
        if (!schema.outputNodes.length) {
            return { ok: false, error: '请至少指定一个输出节点（outputNodes）' };
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(wfPath, JSON.stringify(workflow, null, 2), 'utf-8');
        fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf-8');
        reloadAll();
        const tool = getTool(id);
        if (!tool) return { ok: false, error: '工具已写入但加载失败，请检查 schema' };
        return {
            ok: true, tool,
            broken: !!tool.broken,
            error: tool.error || null,
            validationProblems: tool.validationProblems || [],
        };
    } catch (e) {
        return { ok: false, error: '导入失败: ' + e.message };
    }
}

module.exports = {
    loadAll, listTools, getTool, getWorkflow, getWorkflowsDir,
    reloadAll, importTool, validateSchema, detectSizeNode, ensureSizeFields,
};
