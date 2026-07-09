// scripts/smoke-applier-lora.js — 验证 Phase 3 applier 新增 lora / loraMulti 字段类型
// 用法: node_modules/.bin/electron scripts/smoke-applier-lora.js --no-sandbox
'use strict';
const { app } = require('electron');

app.on('ready', () => {
    const { applyFormToWorkflow } = require('../comfyui-workflow-applier');

    // 假 workflow：节点 10 = LoraLoader，节点 11/12 = 链式 LoraLoader
    const wf = {
        '10': { class_type: 'LoraLoader', inputs: { lora_name: 'OLD.safetensors', strength_model: 1.0, strength_clip: 1.0, model: ['8', 0], clip: ['8', 1] } },
        '11': { class_type: 'LoraLoader', inputs: { lora_name: '', strength_model: 1.0, strength_clip: 1.0, model: ['10', 0], clip: ['10', 1] } },
        '12': { class_type: 'LoraLoader', inputs: { lora_name: '', strength_model: 1.0, strength_clip: 1.0, model: ['11', 0], clip: ['11', 1] } },
    };

    // 假 loraLookup
    const lookup = (id) => {
        const map = {
            101: { basename: 'char_lora.safetensors', weight: 0.75 },
            102: { basename: 'style_lora.safetensors', weight: 0.5 },
            103: { basename: 'pose_lora.safetensors', weight: 0.9 },
        };
        return map[id] || null;
    };

    let pass = 0, fail = 0;
    function expect(label, cond, detail) {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    }

    // ===== Case 1: 单 lora（基本场景）=====
    console.log('\n[Case 1] 单 lora 写入');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightNodeId: '10', weightField: 'strength_model',
                // 不设 defaultWeight → 应该用 lora.recommended_weight
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { char_lora: 101 }, { loraLookup: lookup });
        expect('ok=true', r.ok === true, JSON.stringify(r.warnings));
        expect('lora_name 已替换', r.workflow['10'].inputs.lora_name === 'char_lora.safetensors');
        expect('strength_model = 0.75 (来自 lora.recommended_weight)', r.workflow['10'].inputs.strength_model === 0.75);
    }

    // ===== Case 2: 单 lora，未选（保持 workflow 默认）=====
    console.log('\n[Case 2] 单 lora 未选 → 不动 workflow');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightNodeId: '10', weightField: 'strength_model',
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { char_lora: '' }, { loraLookup: lookup });
        expect('ok=true', r.ok === true);
        expect('lora_name 保留原值 OLD.safetensors', r.workflow['10'].inputs.lora_name === 'OLD.safetensors');
    }

    // ===== Case 3: 单 lora + defaultWeight 覆盖 lora.weight =====
    console.log('\n[Case 3] defaultWeight 优先级 > lora.weight');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightField: 'strength_model',
                defaultWeight: 0.6,
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { char_lora: 101 }, { loraLookup: lookup });
        expect('strength_model = 0.6 (defaultWeight 覆盖)', r.workflow['10'].inputs.strength_model === 0.6);
    }

    // ===== Case 4: loraMulti 顺序写入 3 节点 =====
    console.log('\n[Case 4] loraMulti 顺序写 3 节点');
    {
        const schema = {
            formFields: [{
                id: 'stack', type: 'loraMulti',
                nodeIds: ['10', '11', '12'],
                weightFields: ['strength_model', 'strength_model', 'strength_model'],
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { stack: [101, 102, 103] }, { loraLookup: lookup });
        expect('ok=true', r.ok === true, JSON.stringify(r.warnings));
        expect('节点10 lora_name = char_lora', r.workflow['10'].inputs.lora_name === 'char_lora.safetensors');
        expect('节点11 lora_name = style_lora', r.workflow['11'].inputs.lora_name === 'style_lora.safetensors');
        expect('节点12 lora_name = pose_lora', r.workflow['12'].inputs.lora_name === 'pose_lora.safetensors');
        expect('节点10 strength = 0.75', r.workflow['10'].inputs.strength_model === 0.75);
        expect('节点11 strength = 0.5', r.workflow['11'].inputs.strength_model === 0.5);
        expect('节点12 strength = 0.9', r.workflow['12'].inputs.strength_model === 0.9);
    }

    // ===== Case 5: loraMulti 选的少于节点数 =====
    console.log('\n[Case 5] loraMulti 部分填写');
    {
        const schema = {
            formFields: [{
                id: 'stack', type: 'loraMulti',
                nodeIds: ['10', '11', '12'],
                weightFields: ['strength_model', 'strength_model', 'strength_model'],
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { stack: [101] }, { loraLookup: lookup });
        expect('节点10 被写入', r.workflow['10'].inputs.lora_name === 'char_lora.safetensors');
        expect('节点11 保留原值', r.workflow['11'].inputs.lora_name === '');
        expect('节点12 保留原值', r.workflow['12'].inputs.lora_name === '');
    }

    // ===== Case 6: 字段类型混合 =====
    console.log('\n[Case 6] lora + 传统 text 字段同 schema');
    {
        const schema = {
            formFields: [
                { id: 'prompt', type: 'textarea', nodeId: '11', field: 'lora_name' },  // 故意冲突！
                { id: 'char', type: 'lora', nodeId: '10', field: 'lora_name' },
            ],
        };
        const r = applyFormToWorkflow(wf, schema, { prompt: 'MANUAL', char: 101 }, { loraLookup: lookup });
        expect('prompt（textarea）写入 11 节点', r.workflow['11'].inputs.lora_name === 'MANUAL');
        expect('char（lora）写入 10 节点', r.workflow['10'].inputs.lora_name === 'char_lora.safetensors');
    }

    // ===== Case 7: lora id 找不到 → warning =====
    console.log('\n[Case 7] 无效 lora id');
    {
        const schema = {
            formFields: [{ id: 'x', type: 'lora', nodeId: '10', field: 'lora_name' }],
        };
        const r = applyFormToWorkflow(wf, schema, { x: 9999 }, { loraLookup: lookup });
        expect('warnings 包含 lora id=9999', r.warnings.some(w => w.reason && w.reason.includes('9999')));
        expect('原 workflow 不被破坏', r.workflow['10'].inputs.lora_name === 'OLD.safetensors');
    }

    // ===== Case 8: 缺 loraLookup → 警告但不崩 =====
    console.log('\n[Case 8] 不传 loraLookup');
    {
        const schema = {
            formFields: [{ id: 'x', type: 'lora', nodeId: '10', field: 'lora_name' }],
        };
        const r = applyFormToWorkflow(wf, schema, { x: 101 });
        expect('warnings 包含 lora id=101', r.warnings.some(w => w.reason && w.reason.includes('101')));
    }

    // ===== Case 9: Power Lora Loader (rgthree) =====
    console.log('\n[Case 9] Power Lora Loader 5 slot');
    {
        const wfPLL = {
            '822': {
                class_type: 'Power Lora Loader (rgthree)',
                inputs: {
                    lora_1: { on: true, lora: 'old1.safetensors', strength: 1 },
                    lora_2: { on: true, lora: 'old2.safetensors', strength: 1 },
                    lora_3: { on: false, lora: '', strength: 0 },
                    model: ['800', 0],
                    clip: ['801', 0],
                },
            },
        };
        const schema = {
            formFields: [{
                id: 'loras', type: 'loraMulti',
                powerLoraLoaderNodeId: '822',
                slotCount: 5,
            }],
        };
        // 选 3 个 → 写 lora_1/2/3，lora_4/5 关闭
        const r = applyFormToWorkflow(wfPLL, schema, { loras: [101, 102, 103] }, { loraLookup: lookup });
        expect('ok=true', r.ok === true, JSON.stringify(r.warnings));
        const l1 = r.workflow['822'].inputs.lora_1;
        expect('lora_1.on=true', l1.on === true);
        expect('lora_1.lora=char_lora', l1.lora === 'char_lora.safetensors');
        expect('lora_1.strength=0.75', l1.strength === 0.75);
        const l2 = r.workflow['822'].inputs.lora_2;
        expect('lora_2.lora=style_lora', l2.lora === 'style_lora.safetensors');
        expect('lora_2.strength=0.5', l2.strength === 0.5);
        const l3 = r.workflow['822'].inputs.lora_3;
        expect('lora_3.lora=pose_lora', l3.lora === 'pose_lora.safetensors');
        const l4 = r.workflow['822'].inputs.lora_4;
        expect('lora_4.on=false', l4.on === false);
        expect('lora_4.lora=""', l4.lora === '');
        const l5 = r.workflow['822'].inputs.lora_5;
        expect('lora_5.on=false', l5.on === false);
    }

    // ===== Case 10: Power Lora Loader 选少于 slot 数 =====
    console.log('\n[Case 10] Power Lora Loader 只选 1 个');
    {
        const wfPLL = {
            '822': {
                class_type: 'Power Lora Loader (rgthree)',
                inputs: {
                    lora_1: { on: true, lora: 'old.safetensors', strength: 1 },
                    lora_2: { on: true, lora: 'old.safetensors', strength: 1 },
                    model: ['800', 0],
                    clip: ['801', 0],
                },
            },
        };
        const schema = {
            formFields: [{
                id: 'loras', type: 'loraMulti',
                powerLoraLoaderNodeId: '822',
                slotCount: 5,
            }],
        };
        const r = applyFormToWorkflow(wfPLL, schema, { loras: [101] }, { loraLookup: lookup });
        expect('lora_1.lora=char_lora', r.workflow['822'].inputs.lora_1.lora === 'char_lora.safetensors');
        expect('lora_2.on=false', r.workflow['822'].inputs.lora_2.on === false);
        expect('lora_3.on=false', r.workflow['822'].inputs.lora_3.on === false);
        expect('lora_4.on=false', r.workflow['822'].inputs.lora_4.on === false);
        expect('lora_5.on=false', r.workflow['822'].inputs.lora_5.on === false);
    }

    // ===== Case 11: 单 lora 新格式 {id, weight} 覆盖 recommended_weight =====
    console.log('\n[Case 11] 单 lora 新格式权重覆盖');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightField: 'strength_model',
                // 不设 defaultWeight，验证 formValue.weight 优先级最高
            }],
        };
        const r = applyFormToWorkflow(wf, schema,
            { char_lora: { id: 101, weight: 0.42 } },
            { loraLookup: lookup });
        expect('ok=true', r.ok === true, JSON.stringify(r.warnings));
        expect('lora_name 已替换', r.workflow['10'].inputs.lora_name === 'char_lora.safetensors');
        expect('strength_model = 0.42 (formValue.weight 覆盖)', r.workflow['10'].inputs.strength_model === 0.42);
    }

    // ===== Case 12: 单 lora 新格式 weight=null/缺省 → 退回 lora.recommended_weight =====
    console.log('\n[Case 12] 单 lora 新格式 weight 缺省 → 用 lora.weight');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightField: 'strength_model',
            }],
        };
        // weight 字段缺失
        const r1 = applyFormToWorkflow(wf, schema,
            { char_lora: { id: 101 } },
            { loraLookup: lookup });
        expect('weight 缺省 → strength_model = 0.75 (lora.weight)',
            r1.workflow['10'].inputs.strength_model === 0.75);
        // weight 显式 null
        const r2 = applyFormToWorkflow(wf, schema,
            { char_lora: { id: 101, weight: null } },
            { loraLookup: lookup });
        expect('weight=null → strength_model = 0.75 (lora.weight)',
            r2.workflow['10'].inputs.strength_model === 0.75);
    }

    // ===== Case 13: 单 lora 新格式 weight + schema.defaultWeight 同存时，formValue.weight 优先 =====
    console.log('\n[Case 13] formValue.weight > schema.defaultWeight > lora.weight');
    {
        const schema = {
            formFields: [{
                id: 'char_lora', type: 'lora',
                nodeId: '10', field: 'lora_name',
                weightField: 'strength_model',
                defaultWeight: 0.6,
            }],
        };
        // formValue.weight 存在（最高优先）
        const r1 = applyFormToWorkflow(wf, schema,
            { char_lora: { id: 101, weight: 0.42 } },
            { loraLookup: lookup });
        expect('formValue.weight=0.42 覆盖 defaultWeight=0.6 / lora.weight=0.75',
            r1.workflow['10'].inputs.strength_model === 0.42);
        // formValue.weight 缺省 → defaultWeight
        const r2 = applyFormToWorkflow(wf, schema,
            { char_lora: { id: 101 } },
            { loraLookup: lookup });
        expect('formValue.weight 缺省 → schema.defaultWeight=0.6',
            r2.workflow['10'].inputs.strength_model === 0.6);
    }

    // ===== Case 14: loraMulti 新格式 [{id, weight}] 部分覆盖 =====
    console.log('\n[Case 14] loraMulti 新格式部分覆盖');
    {
        const schema = {
            formFields: [{
                id: 'stack', type: 'loraMulti',
                nodeIds: ['10', '11', '12'],
                weightFields: ['strength_model', 'strength_model', 'strength_model'],
            }],
        };
        // 只对第 2 个给覆盖
        const r = applyFormToWorkflow(wf, schema, {
            stack: [
                { id: 101 },                              // 用 lora.weight=0.75
                { id: 102, weight: 1.5 },                 // 覆盖成 1.5
                { id: 103, weight: null },                // 缺省 → lora.weight=0.9
            ],
        }, { loraLookup: lookup });
        expect('节点10 strength = 0.75 (lora 默认)', r.workflow['10'].inputs.strength_model === 0.75);
        expect('节点11 strength = 1.5 (formValue 覆盖)', r.workflow['11'].inputs.strength_model === 1.5);
        expect('节点12 strength = 0.9 (lora 默认)', r.workflow['12'].inputs.strength_model === 0.9);
    }

    // ===== Case 15: loraMulti 新旧格式混用 =====
    console.log('\n[Case 15] loraMulti 新旧格式混用');
    {
        const schema = {
            formFields: [{
                id: 'stack', type: 'loraMulti',
                nodeIds: ['10', '11', '12'],
                weightFields: ['strength_model', 'strength_model', 'strength_model'],
            }],
        };
        const r = applyFormToWorkflow(wf, schema, {
            stack: [101, { id: 102, weight: 0.3 }, 103],
        }, { loraLookup: lookup });
        expect('节点10 strength = 0.75 (裸 id)', r.workflow['10'].inputs.strength_model === 0.75);
        expect('节点11 strength = 0.3 (带 weight)', r.workflow['11'].inputs.strength_model === 0.3);
        expect('节点12 strength = 0.9 (裸 id)', r.workflow['12'].inputs.strength_model === 0.9);
    }

    // ===== Case 16: Power Lora Loader 新格式权重 =====
    console.log('\n[Case 16] Power Lora Loader 新格式权重');
    {
        const wfPLL = {
            '822': {
                class_type: 'Power Lora Loader (rgthree)',
                inputs: {
                    lora_1: { on: true, lora: 'old1.safetensors', strength: 1 },
                    lora_2: { on: true, lora: 'old2.safetensors', strength: 1 },
                    model: ['800', 0], clip: ['801', 0],
                },
            },
        };
        const schema = {
            formFields: [{
                id: 'loras', type: 'loraMulti',
                powerLoraLoaderNodeId: '822',
                slotCount: 5,
            }],
        };
        const r = applyFormToWorkflow(wfPLL, schema, {
            loras: [
                { id: 101, weight: 0.42 },
                { id: 102, weight: 1.5 },
                { id: 103 },
            ],
        }, { loraLookup: lookup });
        expect('Power Lora[1] strength = 0.42', r.workflow['822'].inputs.lora_1.strength === 0.42);
        expect('Power Lora[2] strength = 1.5', r.workflow['822'].inputs.lora_2.strength === 1.5);
        expect('Power Lora[3] strength = 0.9 (lora 默认)', r.workflow['822'].inputs.lora_3.strength === 0.9);
    }

    // ===== Case 17: 单 lora 未选（new shape null）→ 不动 workflow =====
    console.log('\n[Case 17] 单 lora 新格式 null / {} → 不动');
    {
        const schema = {
            formFields: [{ id: 'x', type: 'lora', nodeId: '10', field: 'lora_name' }],
        };
        const r1 = applyFormToWorkflow(wf, schema, { x: null }, { loraLookup: lookup });
        expect('null → 保留原值', r1.workflow['10'].inputs.lora_name === 'OLD.safetensors');
        const r2 = applyFormToWorkflow(wf, schema, { x: {} }, { loraLookup: lookup });
        expect('{} → 保留原值', r2.workflow['10'].inputs.lora_name === 'OLD.safetensors');
        const r3 = applyFormToWorkflow(wf, schema, {}, { loraLookup: lookup });
        expect('缺字段 → 保留原值', r3.workflow['10'].inputs.lora_name === 'OLD.safetensors');
    }

    // ===== Case 18: loraMulti 全部未选 =====
    console.log('\n[Case 18] loraMulti 空数组 → 不动');
    {
        const schema = {
            formFields: [{
                id: 'stack', type: 'loraMulti',
                nodeIds: ['10', '11', '12'],
                weightFields: ['strength_model', 'strength_model', 'strength_model'],
            }],
        };
        const r = applyFormToWorkflow(wf, schema, { stack: [] }, { loraLookup: lookup });
        expect('空数组 → 节点10 lora_name 保留', r.workflow['10'].inputs.lora_name === 'OLD.safetensors');
        expect('空数组 → 节点11 lora_name 保留', r.workflow['11'].inputs.lora_name === '');
    }

    // ===== Case 19: weight="" → 视为缺省 =====
    console.log('\n[Case 19] weight 缺省哨兵');
    {
        const schema = {
            formFields: [{ id: 'x', type: 'lora', nodeId: '10', field: 'lora_name', weightField: 'strength_model' }],
        };
        const r = applyFormToWorkflow(wf, schema,
            { x: { id: 101, weight: '' } },
            { loraLookup: lookup });
        expect('weight="" → 用 lora.weight=0.75', r.workflow['10'].inputs.strength_model === 0.75);
    }

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});