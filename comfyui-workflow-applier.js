// comfyui-workflow-applier.js — 把 schema + formValues 注入到 workflow JSON
//
// 流程：
//   1) clone workflow（深拷贝，避免污染原对象）
//   2) 替换 schema.placeholders 声明的所有占位符（按 nodeId.field 验证存在性）
//   3) 用 schema.formFields 把表单值写到对应节点的 inputs[field]
//
// 返回 { ok, workflow, warnings: [{nodeId, field, reason}] }
// 不修改任何外部对象，调用方拿到的 workflow 是新对象。
//
// 新增字段类型（Phase 3 Lora）：
//   - lora      单 Lora：formValues[id] 是 Lora id（数字），查 loraLookup 转 basename 写到 node.inputs[field]
//               同节点可写权重（weightNodeId/weightField 或 schema.defaultWeight）
//   - loraMulti 多 Lora：formValues[id] 是 Lora id 数组，按顺序写入 nodeIds[i].inputs[field]
//               每个节点可单独配 weightFields[i]
// options.loraLookup(id) → { basename, weight } | null  由 main.js 注入 loras-store 适配

'use strict';

function applyFormToWorkflow(workflowJson, schema, formValues, options) {
    const warnings = [];
    options = options || {};
    const loraLookup = typeof options.loraLookup === 'function' ? options.loraLookup : () => null;
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
        // Phase 3: lora / loraMulti 走专用分支（不需要传统 nodeId/field 必填校验）
        if (field.type === 'lora') {
            applyLoraField(workflow, field, formValues[field.id], loraLookup, warnings);
            continue;
        }
        if (field.type === 'loraMulti') {
            applyLoraMultiField(workflow, field, formValues[field.id], loraLookup, warnings);
            continue;
        }

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

// 单 Lora 注入：写 lora_name + 可选 strength
// formValues 支持两种形态（向后兼容）：
//   - 老格式：loraId = 101（裸 number，仅指定 id）
//   - 新格式：loraId = { id: 101, weight: 0.85 }（带本次调用的权重覆盖）
// 权重优先级：formValue.weight ?? schema.defaultWeight ?? lora.recommended_weight ?? 1.0
function applyLoraField(workflow, field, formValue, loraLookup, warnings) {
    if (!field.nodeId || !field.field) {
        warnings.push({ type: 'formField', fieldId: field.id, reason: 'lora 字段缺 nodeId / field' });
        return;
    }
    const item = _normalizeLoraItem(formValue);
    if (!item) return;  // 没选 → 不写节点 inputs（保留 workflow 默认值 / 占位符）
    const node = workflow[field.nodeId];
    if (!node) {
        warnings.push({ type: 'formField', fieldId: field.id, reason: `节点 ${field.nodeId} 不存在` });
        return;
    }
    const lora = loraLookup(item.id);
    if (!lora || !lora.basename) {
        warnings.push({ type: 'formField', fieldId: field.id, reason: `lora id=${item.id} 不存在或无文件` });
        return;
    }
    node.inputs = node.inputs || {};
    node.inputs[field.field] = lora.basename;
    const weight = _resolveWeight(item.weight, field.defaultWeight, lora.weight);
    const wNode = field.weightNodeId ? workflow[field.weightNodeId] : node;
    const wField = field.weightField || 'strength_model';
    if (wNode && wField) {
        wNode.inputs = wNode.inputs || {};
        wNode.inputs[wField] = Number(weight) || 1.0;
    }
}

// 多 Lora 注入：按顺序写到多个 LoraLoader 节点
// formValues 支持两种形态（向后兼容）：
//   - 老格式：ids = [101, 102]（裸 number 数组）
//   - 新格式：ids = [{ id: 101, weight: 0.8 }, { id: 102, weight: 0.6 }]
function applyLoraMultiField(workflow, field, formValue, loraLookup, warnings) {
    const items = Array.isArray(formValue) ? formValue.map(_normalizeLoraItem).filter(Boolean) : [];

    // Power Lora Loader (rgthree) 特殊分支：
    // inputs.lora_N = { on, lora, strength } 单 dict；strength 是单个值（不分 model/clip）
    if (field.powerLoraLoaderNodeId) {
        const node = workflow[field.powerLoraLoaderNodeId];
        if (!node) {
            warnings.push({ type: 'formField', fieldId: field.id, reason: `Power Lora 节点 ${field.powerLoraLoaderNodeId} 不存在` });
            return;
        }
        const slotCount = Number(field.slotCount) || 5;
        node.inputs = node.inputs || {};
        // 动态 slot 的 rgthree Power Lora Loader：inputs 里可能有 "➕ Add Lora" 字段，
        // 表示已添加的 slot 数。当 slotCount > 当前 count 时需要写入这个字段让节点认识新 slot。
        const usedCount = items.length;
        const addKey = Object.keys(node.inputs).find(k => /Add Lora/i.test(k));
        if (addKey) {
            node.inputs[addKey] = Math.max(usedCount, slotCount);
        }
        for (let i = 1; i <= slotCount; i++) {
            const slotKey = `lora_${i}`;
            const item = items[i - 1];
            if (item) {
                const lora = loraLookup(item.id);
                if (!lora || !lora.basename) {
                    warnings.push({ type: 'formField', fieldId: field.id, reason: `Power Lora[${i}] id=${item.id} 不存在` });
                    node.inputs[slotKey] = { on: false, lora: '', strength: 0 };
                    continue;
                }
                const weight = _resolveWeight(item.weight, field.defaultWeight, lora.weight);
                node.inputs[slotKey] = { on: true, lora: lora.basename, strength: Number(weight) || 1.0 };
            } else {
                // 未用 slot → 关闭
                node.inputs[slotKey] = { on: false, lora: '', strength: 0 };
            }
        }
        return;
    }

    const nodeIds = Array.isArray(field.nodeIds) ? field.nodeIds : [];
    const weightFields = Array.isArray(field.weightFields) ? field.weightFields : [];
    const loraFieldName = field.field || 'lora_name';
    if (!nodeIds.length) {
        warnings.push({ type: 'formField', fieldId: field.id, reason: 'loraMulti 缺 nodeIds' });
        return;
    }
    if (!items.length) return; // 用户没选 → 不动 workflow
    for (let i = 0; i < nodeIds.length; i++) {
        if (i >= items.length) break; // 用户选的少于节点数
        const item = items[i];
        if (!item) continue;
        const lora = loraLookup(item.id);
        if (!lora || !lora.basename) {
            warnings.push({ type: 'formField', fieldId: field.id, reason: `loraMulti[${i}] id=${item.id} 不存在` });
            continue;
        }
        const nNode = workflow[nodeIds[i]];
        if (!nNode) {
            warnings.push({ type: 'formField', fieldId: field.id, reason: `loraMulti[${i}] 节点 ${nodeIds[i]} 不存在` });
            continue;
        }
        nNode.inputs = nNode.inputs || {};
        nNode.inputs[loraFieldName] = lora.basename;
        const wField = weightFields[i];
        if (wField) {
            const weight = _resolveWeight(item.weight, field.defaultWeight, lora.weight);
            nNode.inputs[wField] = Number(weight) || 1.0;
        }
    }
}

// ========== helpers ==========
// 把 formValue 归一成 {id, weight}（接受老格式 number / 老格式 array）
function _normalizeLoraItem(v) {
    if (v == null || v === '' || v === 0) return null;
    if (typeof v === 'number') return { id: Number(v), weight: undefined };
    if (typeof v === 'object') {
        const id = Number(v.id);
        if (!id || Number.isNaN(id)) return null;
        const w = v.weight;
        return { id, weight: (w != null && w !== '' && !Number.isNaN(Number(w))) ? Number(w) : undefined };
    }
    return null;
}

// 权重解析优先级：用户覆盖 → schema 默认 → lora 推荐 → 1.0
function _resolveWeight(itemWeight, schemaDefault, loraWeight) {
    if (itemWeight != null && !Number.isNaN(itemWeight)) return itemWeight;
    if (schemaDefault != null) return schemaDefault;
    if (loraWeight != null) return loraWeight;
    return 1.0;
}

module.exports = { applyFormToWorkflow };
