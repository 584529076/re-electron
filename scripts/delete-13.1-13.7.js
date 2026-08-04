// scripts/delete-13.1-13.7.js
// module 13 修改: 删除 13.1（使用原则）和 13.7（高级技巧）
// 13.1 = [13.002.000.000] 使用原则（含 4 个 L3）
// 13.7 = [13.010.000.000] 高级技巧（含 3 个 L3）
// 后续 L2 重新编号: 13.3 → 13.1, 13.4 → 13.2, 13.5 → 13.3, 13.6 → 13.4, 13.7 → 13.5
// 所有 L3 子项 code 同步更新
// 只动 module 13，不影响其它模块
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const moduleCode = '13';

    console.log('▶ delete-13.1-13.7');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // 1) 找 module 13 所有 L2 条目
    const l2Entries = cats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    console.log('  L2 总数:', l2Entries.length);
    for (const c of l2Entries) {
        const kids = cats.filter(k => k.parent_code === c.code).length;
        console.log('    [' + c.code + '] L2 ' + c.title + ' (kids:' + kids + ')');
    }

    // 2) 标记待删
    const deleteOrigL2 = new Set([
        '13.002.000.000',  // 13.1 使用原则
        '13.010.000.000',  // 13.7 高级技巧
    ]);
    console.log('  待删除:');
    for (const c of l2Entries.filter(c => deleteOrigL2.has(c.code))) {
        const kids = cats.filter(k => k.parent_code === c.code).length;
        console.log('    [' + c.code + '] L2 ' + c.title + ' (kids:' + kids + ')');
    }

    // 3) 计算 codeMap
    const codeMap = new Map();
    const toKeep = l2Entries.filter(c => !deleteOrigL2.has(c.code));
    for (let i = 0; i < toKeep.length; i++) {
        const oldL2 = toKeep[i];
        const newIdx = i + 1;
        const newL2Code = `${moduleCode}.${String(newIdx).padStart(3, '0')}.000.000`;
        codeMap.set(oldL2.code, newL2Code);
    }
    console.log('  映射:');
    for (const [old, neu] of codeMap) {
        const oldEnt = l2Entries.find(c => c.code === old);
        console.log('    ' + old + ' → ' + neu + '  ' + (oldEnt ? oldEnt.title : ''));
    }

    // 4) 计算所有 module 13 条目的 origCode → newCode 映射
    const codeRename = new Map();
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const segs = c.code.split('.');
        const seg2 = segs[1];
        const seg3 = segs[2];
        const seg4 = segs[3];
        const origL2 = `${moduleCode}.${String(seg2).padStart(3, '0')}.000.000`;

        if (deleteOrigL2.has(c.code)) {
            codeRename.set(c.code, null);
        } else if (codeMap.has(c.code)) {
            const newL2 = codeMap.get(c.code);
            const newSeg2 = newL2.split('.')[1];
            const newCode = `${moduleCode}.${newSeg2}.${seg3}.${seg4}`;
            codeRename.set(c.code, newCode);
        } else if (codeMap.has(origL2)) {
            // 子项跟着新 L2 调整
            const newL2 = codeMap.get(origL2);
            const newSeg2 = newL2.split('.')[1];
            const newCode = `${moduleCode}.${newSeg2}.${seg3}.${seg4}`;
            codeRename.set(c.code, newCode);
        }
    }

    console.log('');
    console.log('=== Rename 映射 (' + codeRename.size + ' 项) ===');
    const sortedRenames = [...codeRename.entries()].sort((a, b) => {
        if (a[1] === null && b[1] !== null) return -1;
        if (a[1] !== null && b[1] === null) return 1;
        return a[0].localeCompare(b[0]);
    });
    for (const [oldC, newC] of sortedRenames.slice(0, 12)) {
        const ent = cats.find(c => c.code === oldC);
        console.log('    ' + oldC + ' → ' + (newC === null ? '(删除)' : newC) + '  ' + (ent ? ent.title.slice(0, 30) : ''));
    }
    if (sortedRenames.length > 12) console.log('    ... 共 ' + sortedRenames.length + ' 项');

    // 5) 应用 code 变更
    const newCats = [];
    for (const c of cats) {
        if (!codeRename.has(c.code)) {
            newCats.push(c);
            continue;
        }
        const newCode = codeRename.get(c.code);
        if (newCode === null) {
            continue;
        }
        c.code = newCode;
        newCats.push(c);
    }

    // 6) 应用 parent_code 变更
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

    // 7) 验证
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

    // 8) 显示新 module 13 L2 列表
    console.log('');
    console.log('=== Module 13 新 L2 列表 ===');
    const newL2 = newCats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    for (const c of newL2) {
        const kids = newCats.filter(k => k.parent_code === c.code).length;
        console.log('  [' + c.code + '] L2 ' + c.title + ' (' + kids + ' sub-items)');
    }

    console.log('');
    console.log('  final: ' + newCats.length + ' (变化 ' + (newCats.length - cats.length) + ')');
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();
