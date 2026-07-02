// comfyui-workflow-meta.js — 从 workflow JSON 提取模型 / LORA / VAE 元数据
//
// 扫描节点的 class_type，识别 CheckpointLoaderSimple / LoraLoader / VAELoader 等，
// 从 inputs.ckpt_name / lora_name / vae_name / strength_model / strength_clip 抽元数据。
// 返回结构化清单 + 原始 class_type，便于在结果页展示「本张图用了什么」。
//
// 注：节点 ID 在被应用 schema 表单替换后可能改变（inputs 注入），所以这里接受任意
// workflow JSON（无论是否已注入 prompt），只读 inputs 里的字符串值即可。

'use strict';

// class_type → 字段提取规则
const NODE_RULES = [
    {
        // 主模型加载器
        type: 'checkpoint',
        classes: ['CheckpointLoaderSimple', 'CheckpointLoader', 'unCLIPCheckpointLoader'],
        fields: ['ckpt_name'],
    },
    {
        type: 'lora',
        classes: ['LoraLoader', 'LoraLoaderModelOnly'],
        // 多 LORA 可能链式，每节点最多 1 个；多 model/clip 强度字段
        fields: ['lora_name'],
        extraFields: ['strength_model', 'strength_clip', 'strength'],
    },
    {
        type: 'vae',
        classes: ['VAELoader'],
        fields: ['vae_name'],
    },
];

/**
 * @param {Object} workflow  ComfyUI API format workflow
 * @returns {{ checkpoints: string[], loras: Array<{name, strengthModel?, strengthClip?}>, vaes: string[], nodes: Array<{nodeId, classType, type, name, ...extras}> }}
 */
function extractModels(workflow) {
    const out = {
        checkpoints: [],
        loras: [],
        vaes: [],
        nodes: [],
    };
    if (!workflow || typeof workflow !== 'object') return out;
    const cpSet = new Set();
    const vaeSet = new Set();
    const loraMap = new Map(); // name → { name, strengthModel, strengthClip }
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node || typeof node !== 'object') continue;
        const classType = String(node.class_type || '');
        const inputs = node.inputs || {};
        if (!classType || !inputs) continue;
        for (const rule of NODE_RULES) {
            if (!rule.classes.includes(classType)) continue;
            const name = pickStr(inputs, rule.fields);
            if (!name) continue;
            const entry = { nodeId, classType, type: rule.type, name };
            if (rule.extraFields) {
                for (const ef of rule.extraFields) {
                    if (inputs[ef] != null) entry[ef] = inputs[ef];
                }
            }
            out.nodes.push(entry);
            if (rule.type === 'checkpoint' && !cpSet.has(name)) {
                cpSet.add(name);
                out.checkpoints.push(name);
            } else if (rule.type === 'vae' && !vaeSet.has(name)) {
                vaeSet.add(name);
                out.vaes.push(name);
            } else if (rule.type === 'lora') {
                const prev = loraMap.get(name) || { name };
                if (entry.strength_model != null) prev.strengthModel = entry.strength_model;
                if (entry.strength_clip != null) prev.strengthClip = entry.strength_clip;
                if (entry.strength != null && prev.strengthModel == null) prev.strengthModel = entry.strength;
                loraMap.set(name, prev);
            }
            break; // 匹配一条规则就跳出
        }
    }
    out.loras = Array.from(loraMap.values());
    return out;
}

function pickStr(inputs, fields) {
    for (const f of fields) {
        const v = inputs[f];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

/**
 * 从 prompt 文本里粗略提取 LORA 触发词（<lora:name:strength>），供展示。
 * 返回 [{ name, strength }]
 */
function extractLoraTriggers(text) {
    if (!text || typeof text !== 'string') return [];
    const out = [];
    const re = /<lora:([^:>]+)(?::([\d.]+))?>/g;
    let m;
    while ((m = re.exec(text)) != null) {
        out.push({ name: m[1].trim(), strength: m[2] ? parseFloat(m[2]) : null });
    }
    return out;
}

module.exports = { extractModels, extractLoraTriggers };