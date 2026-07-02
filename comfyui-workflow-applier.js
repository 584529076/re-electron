// comfyui-workflow-applier.js — 把 schema + formValues 注入到 workflow JSON
//
// 流程：
//   1) clone workflow（深拷贝，避免污染原对象）
//   2) 替换 schema.placeholders 声明的所有占位符（按 nodeId.field 验证存在性）
//   3) 用 schema.formFields 把表单值写到对应节点的 inputs[field]
//
// 返回 { ok, workflow, warnings: [{nodeId, field, reason}] }
// 不修改任何外部对象，调用方拿到的 workflow 是新对象。

'use strict';

function applyFormToWorkflow(workflowJson, schema, formValues) {
    const warnings = [];
    if (!workflowJson || typeof workflowJson !== 'object') {
        return { ok: false, error: 'workflowJson 必填', warnings };
    }
    if (!schema || !Array.isArray(schema.formFields)) {
        return { ok: false, error: 'schema.formFields 必填', warnings };
    }
    formValues = formValues || {};

    // 1) 深拷贝
    let txt;
    try { txt = JSON.stringify(workflowJson); }
    catch (e) { return { ok: false, error: 'workflow 序列化失败: ' + e.message, warnings }; }
    const workflow = JSON.parse(txt);

    // 2) 占位符替换（schema.placeholders 声明的）
    const placeholders = schema.placeholders || {};
    for (const ph of Object.keys(placeholders)) {
        const mapping = placeholders[ph] || {};
        const nodeId = mapping.nodeId;
        const field = mapping.field;
        // 占位符值在 formValues 里以 placeholder 名（或 nodeId+field 拼成 'node_5_text'）做 key
        const valueKey = mapping.role === 'prompt' && formValues.positive_prompt !== undefined && ph === '<POSITIVE_PROMPT>'
            ? 'positive_prompt'
            : ph;
        const value = formValues[valueKey];
        if (value == null) {
            warnings.push({ type: 'placeholder', placeholder: ph, reason: 'formValues 缺值' });
            continue;
        }
        // 验证节点存在
        const node = workflow[nodeId];
        if (!node) {
            warnings.push({ type: 'placeholder', placeholder: ph, reason: `节点 ${nodeId} 不存在` });
            continue;
        }
        // 直接覆盖（占位符只在 workflow JSON 里方便人读，实际以 schema.formFields 为准）
        node.inputs = node.inputs || {};
        node.inputs[field] = String(value);
    }

    // 3) formFields 覆盖写入
    for (const field of schema.formFields) {
        if (!field.nodeId || !field.field) {
            warnings.push({ type: 'formField', fieldId: field.id, reason: '缺 nodeId / field' });
            continue;
        }
        const node = workflow[field.nodeId];
        if (!node) {
            warnings.push({ type: 'formField', fieldId: field.id, reason: `节点 ${field.nodeId} 不存在` });
            continue;
        }
        node.inputs = node.inputs || {};

        // 优先用 formValues[field.id]，否则用 schema.default
        let value = formValues[field.id];
        if (value === undefined || value === null || value === '') {
            value = field.default;
        }
        if (value === undefined || value === null) continue; // 跳过，没值就不写

        // 类型校验 / 转换
        if (field.type === 'number') {
            const n = Number(value);
            if (Number.isNaN(n)) {
                warnings.push({ type: 'formField', fieldId: field.id, reason: '不是合法数字' });
                continue;
            }
            if (field.min !== undefined && n < field.min) value = field.min;
            if (field.max !== undefined && n > field.max) value = field.max;
            value = n;
            // 兜底：randomizable 字段若收到 < 0（schema 用 -1 表示"随机"哨兵），
            // 强制替换为真实随机 uint32。ComfyUI KSampler 不接受 -1。
            if (field.randomizable && value < 0) {
                value = Math.floor(Math.random() * 4294967296);
                warnings.push({ type: 'formField', fieldId: field.id, reason: '随机哨兵 -1 已替换为 ' + value });
            }
        } else if (field.type === 'boolean') {
            value = !!value;
        } else if (field.type === 'select') {
            if (Array.isArray(field.options) && !field.options.includes(value)) {
                warnings.push({ type: 'formField', fieldId: field.id, reason: `值 ${value} 不在 options` });
                continue;
            }
        } else {
            value = String(value);
        }
        node.inputs[field.field] = value;
    }

    return { ok: true, workflow, warnings };
}

module.exports = { applyFormToWorkflow };
