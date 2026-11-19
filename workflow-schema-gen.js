// workflow-schema-gen.js — 从 ComfyUI API 格式 workflow 自动生成 schema 草稿
//
// 供「图形化导入工作流向导」使用：解析 workflow 的节点与连线，
// 推断可编辑字段、类型、默认值、范围、输出节点，产出可人工微调的 schema。
// 纯静态分析，不执行任何 workflow 代码。
//
// 关键能力：
//   1) 反向追溯「哪些输入是死的常量、哪些是从其它节点连过来的」——只暴露常量输入。
//      连线形状：inputs[field] = ["<上游节点ID>", <输出槽>]（数组即连线，不用暴露）。
//   2) 按 class_type 白名单决定哪些节点/字段值得暴露，并给类型/范围/默认值。
//   3) 识别 LoraLoader / Power Lora Loader → lora / loraMulti 字段。
//   4) 识别输出节点（SaveImage / VHS_VideoCombine / PreviewText 等）→ outputNodes。
//   5) 识别 textarea（CLIPTextEncode.text）作为主提示词字段。

'use strict';

const { extractModels } = require('./comfyui-workflow-meta');

// class_type → 可暴露字段规则
// fields: [{ field, id(默认同field), type, default?, min?, max?, step?, note?, label? }]
const NODE_RULES = {
    // ---- 采样器 ----
    KSampler: {
        label: 'K 采样器',
        fields: [
            { field: 'seed', id: 'seed', type: 'number', default: -1, min: -1, max: 4294967295, randomizable: true, note: '-1 = 每次随机' },
            { field: 'steps', type: 'number', default: 20, min: 1, max: 150, step: 1 },
            { field: 'cfg', type: 'number', default: 8, min: 0, max: 100, step: 0.5 },
            { field: 'sampler_name', type: 'select', optionsFromInput: true },
            { field: 'scheduler', type: 'select', optionsFromInput: true },
            { field: 'denoise', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
        ],
    },
    KSamplerAdvanced: {
        label: 'K 采样器(高级)',
        fields: [
            { field: 'noise_seed', id: 'seed', type: 'number', default: -1, min: -1, max: 4294967295, randomizable: true, note: '-1 = 每次随机' },
            { field: 'steps', type: 'number', default: 20, min: 1, max: 150, step: 1 },
            { field: 'cfg', type: 'number', default: 8, min: 0, max: 100, step: 0.5 },
            { field: 'sampler_name', type: 'select', optionsFromInput: true },
            { field: 'scheduler', type: 'select', optionsFromInput: true },
            { field: 'denoise', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
        ],
    },
    // ---- 文本编码 ----
    CLIPTextEncode: {
        label: '文本编码',
        fields: [
            { field: 'text', id: 'positive_prompt', type: 'textarea', rows: 6, primary: true, note: '主提示词（负向提示词可另加字段）' },
        ],
    },
    // ---- 潜空间 ----
    EmptyLatentImage: {
        label: '空 Latent',
        fields: [
            { field: 'width', id: 'width', type: 'number', default: 1024, min: 64, max: 4096, step: 8, panel: 'size' },
            { field: 'height', id: 'height', type: 'number', default: 1024, min: 64, max: 4096, step: 8, panel: 'size' },
            { field: 'batch_size', type: 'number', default: 1, min: 1, max: 64, step: 1 },
        ],
    },
    EmptySD3LatentImage: {
        label: '空 Latent (SD3)',
        fields: [
            { field: 'width', id: 'width', type: 'number', default: 1024, min: 64, max: 4096, step: 8, panel: 'size' },
            { field: 'height', id: 'height', type: 'number', default: 1024, min: 64, max: 4096, step: 8, panel: 'size' },
        ],
    },
    // ---- 模型加载 ----
    CheckpointLoaderSimple: {
        label: '主模型',
        fields: [{ field: 'ckpt_name', type: 'model', note: '主模型（模型字段，由 Lora 兼容过滤使用）' }],
    },
    UNETLoader: {
        label: 'UNet 模型',
        fields: [{ field: 'unet_name', type: 'model', note: 'UNet/DiT 模型' }],
    },
    VAELoader: {
        label: 'VAE',
        fields: [{ field: 'vae_name', type: 'model' }],
    },
    LoraLoader: {
        label: 'Lora',
        fields: [
            { field: 'lora_name', id: 'lora_1', type: 'lora', note: '单 Lora（可在向导里改成 loraMulti）' },
            { field: 'strength_model', type: 'number', default: 1, min: -2, max: 2, step: 0.05, role: 'loraWeight' },
            { field: 'strength_clip', type: 'number', default: 1, min: -2, max: 2, step: 0.05, role: 'loraWeightClip' },
        ],
    },
    // ---- 图像/视频输入 ----
    LoadImage: {
        label: '加载图片',
        fields: [{ field: 'image', id: 'start_image', type: 'image', required: true, accept: 'image/*', primary: true, note: '上传后自动放到 ComfyUI 的 input 目录' }],
    },
    // ---- Primitive 节点（很多工作流用它传 seed / 尺寸 / 文本） ----
    PrimitiveInt: {
        label: '整数',
        fields: [{ field: 'value', type: 'number', default: 0, min: 0, max: 4294967295 }],
    },
    PrimitiveStringMultiline: {
        label: '多行文本',
        fields: [{ field: 'value', id: 'positive_prompt', type: 'textarea', rows: 6, primary: true }],
    },
};

// Power Lora Loader（rgthree）等动态 slot 节点：类前缀匹配
const PREFIX_RULES = [
    {
        match: /power.?lora/i,
        build: (nodeId, node) => [{
            id: `loras_${nodeId}`,
            label: `Power Lora Loader (节点 ${nodeId})`,
            type: 'loraMulti',
            powerLoraLoaderNodeId: String(nodeId),
            slotCount: Math.max(1, Math.min(20, inferSlotCount(node))),
            default: [],
            group: 'Lora 叠加',
            filterByModel: true,
        }],
    },
];

// 输出节点 class_type → 输出类型
const OUTPUT_RULES = {
    SaveImage: 'image', PreviewImage: 'image', SaveAnimatedWEBP: 'image', SaveAnimatedPNG: 'image',
    VHS_VideoCombine: 'video', SaveVideo: 'video',
    PreviewAny: 'text', PreviewText: 'text', SaveText: 'text',
    'llama_cpp_instruct_adv': 'text',
};

function inferSlotCount(node) {
    const inputs = node.inputs || {};
    let max = 0;
    for (const k of Object.keys(inputs)) {
        const m = /^lora_(\d+)$/.exec(k);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max || 5;
}

// 判断 input 值是否为「连线」（数组 = 来自上游节点，不暴露）
function isLink(v) {
    return Array.isArray(v);
}

// select 的 options：尝试从同 workflow 内其它节点的同名输入值收集（如 sampler_name）
function collectOptionsForField(workflow, field) {
    const opts = new Set();
    for (const node of Object.values(workflow)) {
        const v = node && node.inputs && node.inputs[field];
        if (typeof v === 'string' && v.trim() && !isLink(v)) opts.add(v.trim());
    }
    return Array.from(opts);
}

/**
 * 从 workflow 生成 schema 草稿。
 * @param {Object} workflow  ComfyUI API 格式 JSON
 * @param {Object} [opts]    { id?, name? }
 * @returns {{ ok:boolean, schema?:Object, preview?:Object, error?:string }}
 */
function generateSchema(workflow, opts) {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        return { ok: false, error: 'workflow 必须是对象' };
    }
    const nodeIds = Object.keys(workflow);
    if (!nodeIds.length) return { ok: false, error: 'workflow 没有节点' };
    // 校验 API 格式：每个节点都必须有 class_type（普通 UI 格式导出的 JSON 没有此字段）
    for (const nid of nodeIds) {
        const n = workflow[nid];
        if (!n || typeof n !== 'object' || !n.class_type) {
            return { ok: false, error: `节点 ${nid} 缺 class_type —— 请用 ComfyUI 的「Save (API Format)」导出，不要用普通 Save` };
        }
    }

    const formFields = [];
    const warnings = [];
    const usedIds = new Set();
    const modelFields = [];

    function uniqueId(base) {
        let id = base;
        let n = 2;
        while (usedIds.has(id)) id = `${base}_${n++}`;
        usedIds.add(id);
        return id;
    }

    for (const nodeId of nodeIds) {
        const node = workflow[nodeId];
        if (!node || !node.class_type) continue;
        const cls = String(node.class_type);

        // 1) 前缀规则（Power Lora Loader 等）
        let handledByPrefix = false;
        for (const rule of PREFIX_RULES) {
            if (rule.match.test(cls)) {
                for (const f of rule.build(nodeId, node)) {
                    formFields.push({ ...f, id: uniqueId(f.id), nodeId: String(nodeId) });
                }
                handledByPrefix = true;
                break;
            }
        }
        if (handledByPrefix) continue;

        // 2) 精确规则
        const rule = NODE_RULES[cls];
        if (!rule) continue;
        for (const spec of rule.fields) {
            const raw = node.inputs && node.inputs[spec.field];
            if (raw === undefined) continue;                 // 字段不存在
            if (isLink(raw)) continue;                        // 连到上游，不暴露

            const f = {
                id: uniqueId(spec.id || spec.field),
                label: spec.label || `${rule.label || cls} · ${spec.field}`,
                type: spec.type,
                nodeId: String(nodeId),
                field: spec.field,
            };
            if (spec.primary) f.panel = 'primary';
            if (spec.panel) f.panel = spec.panel;
            if (spec.rows) f.rows = spec.rows;
            if (spec.required) f.required = true;
            if (spec.accept) f.accept = spec.accept;
            if (spec.group) f.group = spec.group;
            if (spec.note) f.note = spec.note;
            if (spec.randomizable) f.randomizable = true;

            if (spec.type === 'model') {
                f.type = 'select';
                if (raw != null && raw !== '') f.default = String(raw);
                modelFields.push({ nodeId: String(nodeId), field: spec.field, currentValue: String(raw || '') });
                f.note = (f.note || '') + '（模型字段，可在向导里删除此表单项只保留 modelField）';
            } else if (spec.type === 'select') {
                const options = spec.optionsFromInput ? collectOptionsForField(workflow, spec.field) : [];
                if (options.length) f.options = options;
                if (typeof raw === 'string') f.default = raw;
            } else if (spec.type === 'number') {
                const num = Number(raw);
                if (Number.isFinite(num)) f.default = spec.default != null && spec.randomizable ? spec.default : num;
                else if (spec.default != null) f.default = spec.default;
                if (spec.min != null) f.min = spec.min;
                if (spec.max != null) f.max = spec.max;
                if (spec.step != null) f.step = spec.step;
            } else if (spec.type === 'textarea' || spec.type === 'text') {
                f.default = typeof raw === 'string' ? raw : '';
            } else if (spec.role === 'loraWeight' || spec.role === 'loraWeightClip') {
                // Lora 权重字段由 lora 字段接管，不单独暴露
                continue;
            }
            formFields.push(f);
        }
    }

    // 3) 输出节点
    const outputNodes = [];
    for (const nodeId of nodeIds) {
        const node = workflow[nodeId];
        const type = node && OUTPUT_RULES[String(node.class_type)];
        if (type) outputNodes.push({ nodeId: String(nodeId), type, classType: String(node.class_type) });
    }
    if (!outputNodes.length) {
        warnings.push('未识别到标准输出节点（SaveImage / VHS_VideoCombine / PreviewText 等），请在向导里手动指定输出节点');
    }

    // 4) 主模型字段（用于 Lora 兼容过滤）
    const mainModel = modelFields.find(m => /unet|ckpt/i.test(m.field)) || modelFields[0] || null;

    // 5) 推断 accepts（有 LoadImage → image；有 textarea → text）
    const accepts = [];
    if (formFields.some(f => f.type === 'image')) accepts.push('image');
    if (formFields.some(f => f.type === 'textarea' || f.type === 'text')) accepts.push('text');
    if (outputNodes.some(o => o.type === 'video')) accepts.push('video');

    // 5.5) 宽高字段（size 栏顶部）：workflow 有宽高常量节点但 schema 没显式定义时，
    //      生成 width/height 字段接入该节点默认值（与 tool-store 的 detectSizeNode 逻辑一致）
    const SIZE_PRIORITY = ['EmptyLatentImage','EmptySD3LatentImage','EmptyFlux2LatentImage','EmptySVDLatentImage','ImageResize+','ImageResizeKJv2','LatentUpscaleBy','ImageScale'];
    let sizeNode = null;
    for (const pri of SIZE_PRIORITY) {
        const found = Object.entries(workflow).find(([, n]) => n && String(n.class_type || '').toLowerCase() === pri.toLowerCase()
            && typeof n.inputs?.width === 'number' && typeof n.inputs?.height === 'number');
        if (found) { sizeNode = { id: String(found[0]), ...found[1].inputs }; break; }
    }
    if (sizeNode && !formFields.some(f => f.id === 'width')) {
        formFields.push({ id: 'width', label: '宽度', type: 'number', nodeId: sizeNode.id, field: 'width', default: sizeNode.width, min: 64, max: 4096, step: 8, panel: 'size', note: `自动探测自节点 ${sizeNode.id}` });
    }
    if (sizeNode && !formFields.some(f => f.id === 'height')) {
        formFields.push({ id: 'height', label: '高度', type: 'number', nodeId: sizeNode.id, field: 'height', default: sizeNode.height, min: 64, max: 4096, step: 8, panel: 'size', note: `自动探测自节点 ${sizeNode.id}` });
    }

    // 6) 占位符映射（把 textarea 里含 <POSITIVE_PROMPT> 的字段标出来，兼容旧习惯）
    const placeholders = {};
    for (const f of formFields) {
        const node = workflow[f.nodeId];
        const raw = node && node.inputs && node.inputs[f.field];
        if (typeof raw === 'string' && raw.includes('<POSITIVE_PROMPT>')) {
            placeholders['<POSITIVE_PROMPT>'] = { nodeId: f.nodeId, field: f.field, role: 'prompt' };
        }
    }

    const id = (opts && opts.id) || 'imported_workflow';
    const schema = {
        id,
        name: (opts && opts.name) || '导入的工作流',
        description: `由向导自动生成 · ${nodeIds.length} 个节点 · ${formFields.length} 个可编辑字段`,
        mode: 'sfw',
        accepts,
        coverFallback: { icon: 'fa-wand-magic-sparkles', gradient: ['#6366f1', '#ec4899'] },
        workflowFile: `${id}.json`,
        models: [],
        modelField: mainModel ? { nodeId: mainModel.nodeId, field: mainModel.field } : null,
        placeholders,
        formFields,
        outputNodes: outputNodes.map(({ nodeId, type }) => ({ nodeId, type })),
    };

    return {
        ok: true,
        schema,
        preview: {
            generatedAt: new Date().toISOString(),
            nodeCount: nodeIds.length,
            nodeTypes: Array.from(new Set(Object.values(workflow).map(n => n && n.class_type).filter(Boolean))),
            formFields,
            outputNodes,
            modelFields,
            accepts,
            warnings,
            modelsFound: extractModels(workflow),
        },
    };
}

module.exports = { generateSchema, NODE_RULES, OUTPUT_RULES };
