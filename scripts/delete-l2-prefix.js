// scripts/delete-l2-prefix.js
// 删除指定 module 的前 N 个 L2 条目，并对后续项重新编号
// 用法: node delete-l2-prefix.js <moduleCode> <count>
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const args = process.argv.slice(2);
    const moduleCode = args[0];
    const deleteCount = parseInt(args[1], 10);

    if (!moduleCode || !deleteCount) {
        console.error('用法: node delete-l2-prefix.js <moduleCode> <count>');
        console.error('例:   node delete-l2-prefix.js 04 2');
        process.exit(1);
    }

    console.log(`▶ delete-l2-prefix module=${moduleCode} count=${deleteCount}`);
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // Step 1: 找 module 所有 L2 条目
    const l2Entries = cats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));

    console.log('  L2 总数:', l2Entries.length);

    if (l2Entries.length <= deleteCount) {
        console.error(`!! L2 条目 (${l2Entries.length}) 不足 ${deleteCount}`);
        process.exit(1);
    }

    // Step 2: 标记删除集
    const deleteOrigL2 = new Set();
    for (let i = 0; i < deleteCount; i++) {
        deleteOrigL2.add(l2Entries[i].code);
    }
    console.log('  待删除:');
    for (const c of l2Entries.slice(0, deleteCount)) {
        console.log(`    [${c.code}] ${c.title}`);
    }

    // Step 3: 计算 codeMap
    const codeMap = new Map();
    const toKeep = l2Entries.slice(deleteCount);
    for (let i = 0; i < toKeep.length; i++) {
        const newIdx = i + 1;
        const newL2Code = `${moduleCode}.${String(newIdx).padStart(3, '0')}.000.000`;
        codeMap.set(toKeep[i].code, newL2Code);
    }
    console.log('  映射 (' + codeMap.size + ' 项):');
    for (const [old, neu] of codeMap) {
        const oldEnt = l2Entries.find(c => c.code === old);
        console.log(`    ${old} → ${neu}  ${oldEnt.title}`);
    }

    // Step 4: 计算每个 module 条目的 origCode → newCode 映射
    const codeRename = new Map();
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const segs = c.code.split('.');
        const seg2 = parseInt(segs[1], 10);
        const seg3 = parseInt(segs[2], 10);
        const seg4 = parseInt(segs[3], 10);
        const origL2 = `${moduleCode}.${String(seg2).padStart(3, '0')}.000.000`;

        if (deleteOrigL2.has(origL2)) {
            codeRename.set(c.code, null);
        } else if (codeMap.has(origL2)) {
            const newL2 = codeMap.get(origL2);
            const newL2Seg = newL2.split('.')[1];
            const newCode = `${moduleCode}.${newL2Seg}.${String(seg3).padStart(3, '0')}.${String(seg4).padStart(3, '0')}`;
            codeRename.set(c.code, newCode);
        }
    }

    // Step 5: 应用 code 变更
    const newCats = [];
    for (const c of cats) {
        if (c.module_code === moduleCode) {
            const newCode = codeRename.get(c.code);
            if (newCode === null) continue;  // 删除
            if (newCode !== undefined && newCode !== c.code) {
                c.code = newCode;
            }
        }
        newCats.push(c);
    }

    // Step 6: 应用 parent_code 变更
    for (const c of newCats) {
        if (c.parent_code && codeRename.has(c.parent_code)) {
            const newPC = codeRename.get(c.parent_code);
            if (newPC === null) {
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

    console.log('');
    console.log(`=== Module ${moduleCode} 新 L2 列表 ===`);
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