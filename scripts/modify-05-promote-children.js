// scripts/modify-05-promote-children.js
// module 05 修改:
//   - 删除 [05.001.000.000] 光影氛围词库
//   - 删除 [05.002.000.000] 索引（容器）
//   - 提升 5.2 的 8 个 L3 子项为 L2，新 code [05.001.000.000]~[05.008.000.000]
//   - 同步更新孙子项的 code 和 parent_code
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const moduleCode = '05';
    const moduleRoot = '05.000.000.000';

    console.log('▶ modify-05-promote-children');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // 1) 找待删 L2 与待提升的 L3
    const l2ToDelete = new Set([
        '05.001.000.000',  // 光影氛围词库
        '05.002.000.000',  // 索引
    ]);

    const l2Ent = cats.filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    console.log('  原 L2:');
    for (const c of l2Ent) {
        const kids = cats.filter(k => k.parent_code === c.code).length;
        console.log(`    [${c.code}] ${c.title} (kids:${kids})`);
    }

    const l3ToPromote = cats
        .filter(c => c.module_code === moduleCode && c.level === 3 && l2ToDelete.has(c.parent_code))
        .sort((a, b) => a.code.localeCompare(b.code));

    console.log('  待提升 L3 → L2:');
    for (let i = 0; i < l3ToPromote.length; i++) {
        const old = l3ToPromote[i].code;
        const seg2 = String(i + 1).padStart(3, '0');
        const newCode = `${moduleCode}.${seg2}.000.000`;
        console.log(`    ${old} → ${newCode}  ${l3ToPromote[i].title}`);
    }

    // 2) 计算所有 module 05 条目的 origCode → newCode 映射
    // 规则:
    //   - 若是 5.1/5.2 本体 → null（删除）
    //   - 若是 5.2.X 的 L3 → 新 L2 code
    //   - 若是 5.2.X.Y 的 L4 → 替换 seg2 为新 L2 的 seg2（seg3 保持 X, seg4 保持 Y）
    //   - 若是 5.2.5.1 这类有具体 seg3 的 → seg3 不变
    //   - seg3 不为 0 的子项 code 也得跟着新 L2 code 调整
    const codeRename = new Map(); // origCode → newCode | null

    // L3 → 新 L2 映射（按原始顺序）
    const promoteMap = new Map();
    for (let i = 0; i < l3ToPromote.length; i++) {
        const oldCode = l3ToPromote[i].code;
        const seg2 = String(i + 1).padStart(3, '0');
        promoteMap.set(oldCode, `${moduleCode}.${seg2}.000.000`);
    }

    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const segs = c.code.split('.');
        const seg2 = segs[1];
        const seg3 = segs[2];
        const seg4 = segs[3];

        // 1) 本体 5.1 / 5.2 → 删除
        if (l2ToDelete.has(c.code)) {
            codeRename.set(c.code, null);
            continue;
        }

        // 2) 5.2 下的 L3 → 提升为新 L2
        if (promoteMap.has(c.code)) {
            codeRename.set(c.code, promoteMap.get(c.code));
            continue;
        }

        // 3) 5.2 的孙子项（5.2.1.X / 5.2.5.Y 等）→ 替换 seg2
        //    找到其祖先 L3（用 seg2/seg3 拼成 5.2.5.000 / 5.2.1.000）
        const ancestorL3 = `${moduleCode}.${seg2}.${seg3}.000`;
        if (promoteMap.has(ancestorL3)) {
            const newL2Code = promoteMap.get(ancestorL3);
            const newSeg2 = newL2Code.split('.')[1];
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
    for (const [oldC, newC] of sortedRenames) {
        const ent = cats.find(c => c.code === oldC);
        console.log(`    ${oldC} → ${newC === null ? '(删除)' : newC}  ${ent ? ent.title.slice(0, 30) : ''}`);
    }

    // 3) 应用 code 变更
    const newCats = [];
    for (const c of cats) {
        if (c.module_code !== moduleCode) {
            newCats.push(c);
            continue;
        }
        const newCode = codeRename.get(c.code);
        if (newCode === null || newCode === undefined) {
            // 不在映射中（其他 L2/L3/L4 不属于 5.1/5.2 体系）→ 保留
            newCats.push(c);
        } else if (newCode === null) {
            // 标记删除
            continue;
        } else {
            c.code = newCode;
            newCats.push(c);
        }
    }

    // 4) 调整被提升 L3 的 level 和 parent_code
    for (const c of newCats) {
        if (c.module_code !== moduleCode) continue;
        if (promoteMap.has(c.code)) {
            c.level = 2;
            c.parent_code = moduleRoot;
        }
    }

    // 5) 调整 parent_code（基于原 code 查找 codeRename）
    for (const c of newCats) {
        if (c.module_code !== moduleCode) continue;
        if (c.parent_code && codeRename.has(c.parent_code)) {
            const newPC = codeRename.get(c.parent_code);
            if (newPC === null) {
                // parent 被删除（5.1/5.2）— 但其子项已被 promoteMap 处理或保留
                // 唯一可能的孤儿是被删 L2 的子项
                console.log(`  WARN parent 引用已删 code: [${c.code}] parent=${c.parent_code}`);
                c.parent_code = null;
            } else {
                c.parent_code = newPC;
            }
        }
    }

    // 6) 验证
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

    // 7) 显示新 module 05 结构
    console.log('');
    console.log('=== Module 05 新 L2 列表 ===');
    const newL2 = newCats
        .filter(c => c.module_code === moduleCode && c.level === 2)
        .sort((a, b) => a.code.localeCompare(b.code));
    for (const c of newL2) {
        const kids = newCats.filter(k => k.parent_code === c.code);
        console.log(`  [${c.code}] L2 ${c.title} (${kids.length} sub-items)`);
        for (const k of kids.sort((a, b) => a.code.localeCompare(b.code))) {
            const gkids = newCats.filter(g => g.parent_code === k.code).length;
            console.log(`    [${k.code}] L${k.level} ${k.title}${gkids > 0 ? ` (${gkids} L4)` : ''}`);
        }
    }

    console.log('');
    console.log(`  final: ${newCats.length} (变化 ${newCats.length - cats.length})`);
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();
