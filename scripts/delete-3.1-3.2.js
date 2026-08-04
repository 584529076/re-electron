// scripts/delete-3.1-3.2.js (v3 - 干净版本)
// 删除 module 03 的 L2 第 1、2 个条目，并对后续项重新编号
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    console.log('▶ delete-3.1-3.2 (v3)');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    const moduleCode = '03';

    // Step 1: 找 module 03 所有 L2 条目，按 code 排序
    const l2Entries = cats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));

    console.log('  L2 总数:', l2Entries.length);

    if (l2Entries.length < 3) {
        console.error('!! L2 条目不足');
        process.exit(1);
    }

    // Step 2: 标记删除集（原 code）
    const deleteOrigCodes = new Set();
    for (let i = 0; i < 2; i++) {
        deleteOrigCodes.add(l2Entries[i].code);
    }
    console.log('  待删除:');
    for (const c of l2Entries.slice(0, 2)) {
        console.log(`    [${c.code}] ${c.title}`);
    }

    // Step 3: 计算 codeMap（仅对 module 03 的 L2 后半段）
    // toKeep 中第 0 个 → 新 L2 编号 1
    // toKeep 中第 1 个 → 新 L2 编号 2
    const codeMap = new Map(); // oldL2Code → newL2Code
    const toKeep = l2Entries.slice(2);
    for (let i = 0; i < toKeep.length; i++) {
        const oldL2 = toKeep[i];
        const newIdx = i + 1;
        const newL2Code = `${moduleCode}.${String(newIdx).padStart(3, '0')}.000.000`;
        codeMap.set(oldL2.code, newL2Code);
    }
    console.log('  映射:');
    for (const [old, neu] of codeMap) {
        const oldEnt = l2Entries.find(c => c.code === old);
        console.log(`    ${old} → ${neu}  ${oldEnt.title}`);
    }

    // Step 4: 应用映射 — 先收集所有 module 03 条目的原 code → 新 code 映射
    const codeRename = new Map(); // origCode → newCode (or null for delete)
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const segs = c.code.split('.');
        const seg2 = parseInt(segs[1], 10);
        const seg3 = parseInt(segs[2], 10);
        const seg4 = parseInt(segs[3], 10);
        const origL2 = `${moduleCode}.${String(seg2).padStart(3, '0')}.000.000`;

        if (deleteOrigCodes.has(origL2)) {
            codeRename.set(c.code, null);  // 标记删除
        } else if (codeMap.has(origL2)) {
            const newL2 = codeMap.get(origL2);
            const newL2Seg = newL2.split('.')[1];
            const newCode = `${moduleCode}.${newL2Seg}.${String(seg3).padStart(3, '0')}.${String(seg4).padStart(3, '0')}`;
            codeRename.set(c.code, newCode);
        }
    }

    // Step 5: 先应用 code 变更（基于原 code 查找 codeRename）
    const newCats = [];
    const removedSet = new Set();
    for (const c of cats) {
        if (c.module_code === moduleCode) {
            const newCode = codeRename.get(c.code);
            if (newCode === null) {
                removedSet.add(c.code);
                continue;  // 删除
            }
            if (newCode !== undefined && newCode !== c.code) {
                c.code = newCode;
            }
        }
        newCats.push(c);
    }

    // Step 6: 应用 parent_code 变更（基于原 code 查找 codeRename）
    for (const c of newCats) {
        if (c.parent_code && codeRename.has(c.parent_code)) {
            const newPC = codeRename.get(c.parent_code);
            if (newPC === null) {
                // parent 被删除 - 这种情况下应已删除，但保险起见设为 null
                c.parent_code = null;
            } else {
                c.parent_code = newPC;
            }
        }
    }

    // Step 7: 验证
    console.log('');
    console.log('=== 验证 ===');
    const cm = new Map();
    for (const c of newCats) cm.set(c.code, (cm.get(c.code) || 0) + 1);
    const dupes = [...cm.entries()].filter(([k, v]) => v > 1);
    console.log('  重复 code:', dupes.length);
    if (dupes.length) for (const [k] of dupes) console.log('    ' + k);

    const orphans = newCats.filter(c => c.parent_code && !cm.has(c.parent_code));
    console.log('  orphans:', orphans.length);
    if (orphans.length) for (const o of orphans.slice(0, 5)) console.log('    ' + o.code + ' parent=' + o.parent_code);

    // 显示新的 module 03 L2 列表
    console.log('');
    console.log('=== Module 03 新 L2 列表 ===');
    const newL2 = newCats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    for (const c of newL2) {
        const kids = newCats.filter(k => k.parent_code === c.code).length;
        console.log(`  [${c.code}] ${c.title} (${kids} sub-items)`);
    }

    console.log('');
    console.log(`  final: ${newCats.length} (删除 ${cats.length - newCats.length})`);
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();