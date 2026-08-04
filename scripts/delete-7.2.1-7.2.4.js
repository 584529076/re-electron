// scripts/delete-7.2.1-7.2.4.js
// module 07 修改: 删除 7.2.1（规则一：方向匹配）和 7.2.4（组合公式）
// 后续 L3 重新编号: 7.2.2 → 7.2.1, 7.2.3 → 7.2.2
// 只动 module 07，不影响其它模块
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const moduleCode = '07';
    const targetL2 = '07.002.000.000';  // 眼神专项

    console.log('▶ delete-7.2.1-7.2.4');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // 1) 找目标 L2 下的所有 L3
    const l3InL2 = cats
        .filter(c => c.module_code === moduleCode && c.parent_code === targetL2)
        .sort((a, b) => a.code.localeCompare(b.code));
    console.log('  L2 ' + targetL2 + ' 下 L3 总数:', l3InL2.length);
    for (const c of l3InL2) {
        const kids = cats.filter(k => k.parent_code === c.code).length;
        console.log('    [' + c.code + '] L3 ' + c.title + ' (kids:' + kids + ')');
    }

    // 2) 标记待删
    const deleteOrigCodes = new Set([
        '07.002.001.000',  // 规则一：方向匹配
        '07.002.004.000',  // 组合公式
    ]);

    // 3) 计算 codeMap: 7.2.2 → 7.2.1, 7.2.3 → 7.2.2
    const codeMap = new Map();
    const toKeep = l3InL2.filter(c => !deleteOrigCodes.has(c.code));
    for (let i = 0; i < toKeep.length; i++) {
        const oldL3 = toKeep[i];
        const newIdx = i + 1;
        const newL3Code = `${targetL2.split('.')[0]}.${targetL2.split('.')[1]}.${String(newIdx).padStart(3, '0')}.000`;
        codeMap.set(oldL3.code, newL3Code);
    }
    console.log('  映射:');
    for (const [old, neu] of codeMap) {
        const oldEnt = l3InL2.find(c => c.code === old);
        console.log('    ' + old + ' → ' + neu + '  ' + (oldEnt ? oldEnt.title : ''));
    }

    // 4) 计算所有 module 07 条目的 origCode → newCode 映射
    //    - 7.2.1 / 7.2.4 → null（删除）
    //    - 7.2.2 → 7.2.1
    //    - 7.2.2.X → 7.2.1.X
    //    - 7.2.3 → 7.2.2
    const codeRename = new Map();
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const segs = c.code.split('.');
        const seg2 = segs[1];
        const seg3 = segs[2];
        const seg4 = segs[3];
        const origL3 = `${moduleCode}.${seg2}.${seg3}.000`;

        if (deleteOrigCodes.has(c.code)) {
            codeRename.set(c.code, null);
        } else if (codeMap.has(c.code)) {
            const newL3 = codeMap.get(c.code);
            const newSeg3 = newL3.split('.')[2];
            const newCode = `${moduleCode}.${seg2}.${newSeg3}.${seg4}`;
            codeRename.set(c.code, newCode);
        } else if (segs[1] === '002' && seg4 !== '000' && codeMap.has(origL3)) {
            // 子项（如 07.002.002.001）跟着新 L3 调整
            const newL3 = codeMap.get(origL3);
            const newSeg3 = newL3.split('.')[2];
            const newCode = `${moduleCode}.${seg2}.${newSeg3}.${seg4}`;
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
    for (const [oldC, newC] of sortedRenames) {
        const ent = cats.find(c => c.code === oldC);
        console.log('    ' + oldC + ' → ' + (newC === null ? '(删除)' : newC) + '  ' + (ent ? ent.title.slice(0, 30) : ''));
    }

    // 5) 应用 code 变更
    const newCats = [];
    for (const c of cats) {
        if (!codeRename.has(c.code)) {
            newCats.push(c);
            continue;
        }
        const newCode = codeRename.get(c.code);
        if (newCode === null) {
            continue;  // 删除
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

    // 8) 显示新 7.2 列表
    console.log('');
    console.log('=== 7.2 眼神专项 新 L3 列表 ===');
    const newL3 = newCats
        .filter(c => c.module_code === moduleCode && c.parent_code === targetL2)
        .sort((a, b) => a.code.localeCompare(b.code));
    for (const c of newL3) {
        const l4Kids = newCats.filter(k => k.parent_code === c.code).sort((a, b) => a.code.localeCompare(b.code));
        console.log('  [' + c.code + '] L3 ' + c.title + (l4Kids.length > 0 ? ' (' + l4Kids.length + ' L4)' : ''));
        for (const k of l4Kids) {
            console.log('    [' + k.code + '] L4 ' + k.title);
        }
    }

    console.log('');
    console.log('  final: ' + newCats.length + ' (变化 ' + (newCats.length - cats.length) + ')');
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();
