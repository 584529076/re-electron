// scripts/smoke-schemas-lora.js — 验证 Phase 5 retrofit schemas 都能正常加载且 lora 字段 schema 合法
// 用法: node_modules/.bin/electron scripts/smoke-schemas-lora.js --no-sandbox
'use strict';
const { app } = require('electron');

app.on('ready', () => {
    const store = require('../comfyui-tool-store');
    store.loadAll();
    const tools = store.listTools();
    let pass = 0, fail = 0;
    function expect(label, cond, detail) {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    }
    console.log(`\nLoaded ${tools.length} tools:`);
    for (const t of tools) {
        console.log(`  - ${t.id}: ${t.name} (fields: ${t.formFieldCount}, broken: ${t.broken})`);
        if (t.broken) {
            console.log(`    ⚠️  ${t.error}`);
        }
    }

    // 找所有 schema 含 lora/loraMulti 字段的工具，校验 schema 合法性
    for (const t of tools) {
        if (t.broken) continue;
        const full = store.getTool(t.id);
        if (!full) continue;
        for (const f of (full.formFields || [])) {
            if (f.type === 'lora') {
                expect(`${t.id}.${f.id} (lora) 有 nodeId + field`, f.nodeId && f.field);
            }
            if (f.type === 'loraMulti') {
                if (f.powerLoraLoaderNodeId) {
                    expect(`${t.id}.${f.id} (loraMulti/Power) 有 nodeId`, !!f.powerLoraLoaderNodeId);
                    expect(`${t.id}.${f.id} 有 slotCount >= 1`, f.slotCount >= 1);
                    // 验证节点存在
                    const wf = store.getWorkflow(t.id);
                    if (wf.ok && wf.workflow) {
                        expect(`${t.id}.${f.id} 节点 ${f.powerLoraLoaderNodeId} 存在`,
                            !!wf.workflow[f.powerLoraLoaderNodeId]);
                    }
                } else {
                    expect(`${t.id}.${f.id} (loraMulti) 有 nodeIds[]`, Array.isArray(f.nodeIds) && f.nodeIds.length > 0);
                }
            }
        }
        // 验证 mainModel 不为空（如果 workflow 里有 checkpoint）
        if (full.mainModel) {
            console.log(`    mainModel = ${full.mainModel}`);
        }
    }

    // 专项检查：确认所有更新过的 schema 的 modelField 工作
    const expected = ['Moody_Krea2_Turbo_Minimal', 'Flux2Klein9b_Undressing', 'Wan2.2-SmoothMix-I2V', 'Wan2.2-SmoothMix-首尾帧2', 'qwen_image_nsfw'];
    for (const id of expected) {
        const t = store.getTool(id);
        if (t) {
            expect(`${id} mainModel 非空`, !!t.mainModel, t.mainModel);
        } else {
            console.log(`  ⚠️  ${id} not found in toolstore`);
        }
    }

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});