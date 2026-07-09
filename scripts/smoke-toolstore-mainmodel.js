// scripts/smoke-toolstore-mainmodel.js — 验证 Phase 3 getTool 提取 mainModel
// 用法: node_modules/.bin/electron scripts/smoke-toolstore-mainmodel.js --no-sandbox
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

app.on('ready', () => {
    // 准备临时 workflows 目录
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolstore-mm-'));
    const wfDir = path.join(tmpRoot, 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });

    // Case A: 显式 modelField
    const wfA = {
        '5': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'someOther.safetensors' } },
        '99': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'krea2_turbo_v1.safetensors' } },
    };
    fs.writeFileSync(path.join(wfDir, 'tool_a.json'), JSON.stringify(wfA));
    fs.writeFileSync(path.join(wfDir, 'tool_a.schema.json'), JSON.stringify({
        id: 'tool_a',
        name: 'Tool A (explicit modelField)',
        workflowFile: 'tool_a.json',
        modelField: { nodeId: '99', field: 'ckpt_name' },
        formFields: [],
        outputNodes: [],
    }));

    // Case B: 自动检测 CheckpointLoaderSimple
    const wfB = {
        '5': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1dev.safetensors' } },
        '8': { class_type: 'LoraLoader', inputs: { lora_name: 'foo.safetensors' } },
    };
    fs.writeFileSync(path.join(wfDir, 'tool_b.json'), JSON.stringify(wfB));
    fs.writeFileSync(path.join(wfDir, 'tool_b.schema.json'), JSON.stringify({
        id: 'tool_b',
        name: 'Tool B (auto-detect)',
        workflowFile: 'tool_b.json',
        formFields: [],
        outputNodes: [],
    }));

    // Case C: workflow 没有 CheckpointLoaderSimple → mainModel 为空
    const wfC = {
        '10': { class_type: 'KSampler', inputs: {} },
    };
    fs.writeFileSync(path.join(wfDir, 'tool_c.json'), JSON.stringify(wfC));
    fs.writeFileSync(path.join(wfDir, 'tool_c.schema.json'), JSON.stringify({
        id: 'tool_c',
        name: 'Tool C (no checkpoint)',
        workflowFile: 'tool_c.json',
        formFields: [],
        outputNodes: [],
    }));

    // 临时替换 comfyui-tool-store 的工作流目录（用 monkey patch：重写 getWorkflowsDir）
    const store = require('../comfyui-tool-store');
    // 直接替换内部 getWorkflowsDir 不行（被闭包持有），只能改 fs.readdirSync 的目录？
    // 简单办法：把 schema 放到默认目录的临时拷贝里测
    // 不，更简单：直接用 getWorkflowsDir 返回的目录，并在里面放 schema
    const defaultDir = require('../comfyui-tool-store');  // 确保已 require
    const realDir = path.join(__dirname, '..', 'resources', 'comfyui-workflows');
    // 拷贝我们的 schema 到真实目录（临时），跑完后删掉
    const tmpSchemas = [];
    for (const id of ['tool_a', 'tool_b', 'tool_c']) {
        const src = path.join(wfDir, id + '.schema.json');
        const dst = path.join(realDir, id + '.schema.json');
        const wfDst = path.join(realDir, id + '.json');
        fs.copyFileSync(src, dst);
        fs.copyFileSync(path.join(wfDir, id + '.json'), wfDst);
        tmpSchemas.push({ schema: dst, wf: wfDst });
    }
    try {
        store.loadAll();
        let pass = 0, fail = 0;
        function expect(label, cond, detail) {
            if (cond) { console.log('  ✅', label); pass++; }
            else { console.log('  ❌', label, '|', detail || ''); fail++; }
        }
        console.log('\n[Case A] 显式 modelField → 节点 99');
        const a = store.getTool('tool_a');
        expect('mainModel = krea2_turbo_v1.safetensors', a.mainModel === 'krea2_turbo_v1.safetensors', a.mainModel);
        expect('modelField 回传给前端', a.modelField && a.modelField.nodeId === '99');

        console.log('\n[Case B] 自动检测 → 节点 5');
        const b = store.getTool('tool_b');
        expect('mainModel = flux1dev.safetensors', b.mainModel === 'flux1dev.safetensors', b.mainModel);

        console.log('\n[Case C] 无 checkpoint → mainModel 为空');
        const c = store.getTool('tool_c');
        expect('mainModel = ""', c.mainModel === '', c.mainModel);

        console.log(`\n=== ${pass} pass / ${fail} fail ===`);
        app.exit(fail > 0 ? 1 : 0);
    } finally {
        // 清理临时 schema
        for (const f of tmpSchemas) {
            try { fs.unlinkSync(f.schema); } catch (e) {}
            try { fs.unlinkSync(f.wf); } catch (e) {}
        }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
        // 重载 store 恢复默认 schema 列表
        try { store.loadAll(); } catch (e) {}
    }
});