// scripts/fix-05-corruption.js
// 修复 module 05 修改脚本造成的 corruption:
//   - 删除原本应删的 5.1/5.2 (level=2, parent=05.000.000.000 的重复项)
//   - 把新增的 5.1~5.8 (level=3, parent=null) 提升为 level=2, parent=05.000.000.000
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    const moduleCode = '05';
    const moduleRoot = '05.000.000.000';

    console.log('▶ fix-05-corruption');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // 1) 删除原本应删的 5.1/5.2（这些是旧 L2，本应删但被 bug 留下）
    //    特征：code 是 05.001/002.000.000, level=2, parent=moduleRoot
    const toDelete = [];
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        if ((c.code === '05.001.000.000' || c.code === '05.002.000.000') && c.level === 2) {
            toDelete.push(c);
        }
    }
    console.log('  待删 (原 5.1/5.2):', toDelete.length);
    for (const c of toDelete) {
        console.log(`    [${c.code}] L${c.level} ${c.title} (parent=${c.parent_code})`);
    }

    // 2) 修正新增的 5.1~5.8（这些是 L3 提升来的，code=05.001~008.000.000, level=3, parent=null）
    //    应改为 level=2, parent=moduleRoot
    const toPromote = [];
    for (const c of cats) {
        if (c.module_code !== moduleCode) continue;
        const seg2 = parseInt(c.code.split('.')[1], 10);
        if (seg2 >= 1 && seg2 <= 8 && c.level === 3 && c.code.endsWith('.000.000')) {
            toPromote.push(c);
        }
    }
    console.log('  待提升 (新 5.1~5.8):', toPromote.length);
    for (const c of toPromote) {
        console.log(`    [${c.code}] L${c.level} ${c.title} (parent=${c.parent_code})`);
    }

    // 3) 应用修复
    const newCats = cats.filter(c => !toDelete.includes(c));
    for (const c of newCats) {
        if (toPromote.includes(c)) {
            c.level = 2;
            c.parent_code = moduleRoot;
        }
    }

    // 4) 验证
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

    // 5) 显示新 module 05
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
