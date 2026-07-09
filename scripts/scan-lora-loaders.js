// scripts/scan-lora-loaders.js — 扫描所有 workflow JSON 找出 LoraLoader 节点
// 用法: node scripts/scan-lora-loaders.js
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'resources', 'comfyui-workflows');
const entries = fs.readdirSync(dir);

for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.schema.json') || name.endsWith('.cover.png')) continue;
    if (name.includes('cover')) continue;
    const full = path.join(dir, name);
    let wf;
    try { wf = JSON.parse(fs.readFileSync(full, 'utf-8')); }
    catch (e) { console.log(`[skip] ${name}: ${e.message}`); continue; }
    const loraNodes = [];
    for (const [nid, node] of Object.entries(wf)) {
        if (!node || typeof node !== 'object') continue;
        const cls = String(node.class_type || '');
        if (/LoraLoader|PowerLoraLoader/i.test(cls)) {
            loraNodes.push({
                nodeId: nid,
                classType: cls,
                inputs: {
                    lora_name: node.inputs && node.inputs.lora_name,
                    strength_model: node.inputs && node.inputs.strength_model,
                    strength_clip: node.inputs && node.inputs.strength_clip,
                },
            });
        }
    }
    const ckpt = [];
    for (const [nid, node] of Object.entries(wf)) {
        if (!node || typeof node !== 'object') continue;
        const cls = String(node.class_type || '');
        if (/CheckpointLoader/i.test(cls) && node.inputs && node.inputs.ckpt_name) {
            ckpt.push({ nodeId: nid, classType: cls, ckpt_name: node.inputs.ckpt_name });
        }
    }
    console.log(`\n=== ${name} ===`);
    console.log('  CheckpointLoader:', JSON.stringify(ckpt));
    console.log('  LoraLoader 数量:', loraNodes.length);
    for (const ln of loraNodes) console.log('   ', JSON.stringify(ln));
}