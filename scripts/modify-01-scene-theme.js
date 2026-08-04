// scripts/modify-01-scene-theme.js
// 修改 01-场景主题 下的层级结构：
//   - 删除 索引 [01.002.000.000]
//   - 提升 场景篇 [01.002.001.000] 为 L2 (parent = 01.000.000.000)
//   - 将 [01.002.002.000] ~ [01.002.026.000] 的 parent 改为 01.002.001.000
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    console.log('▶ modify-01-scene-theme');
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    const idxCode = '01.002.000.000';   // 索引
    const scCode = '01.002.001.000';    // 场景篇
    const moduleRootCode = '01.000.000.000';

    // Step 1: 验证必要条目存在
    const idx = cats.find(c => c.code === idxCode);
    const sc = cats.find(c => c.code === scCode);
    if (!idx) { console.error('!! 找不到 ' + idxCode); process.exit(1); }
    if (!sc) { console.error('!! 找不到 ' + scCode); process.exit(1); }

    // Step 2: 把 场景篇 的 parent 改为 module root，level 改为 2
    console.log(`  场景篇 [${scCode}] 提升:`);
    console.log(`    parent: ${sc.parent_code} → ${moduleRootCode}`);
    console.log(`    level:  ${sc.level} → 2`);
    sc.parent_code = moduleRootCode;
    sc.level = 2;

    // Step 3: 把 25 个 sub-items 的 parent 从 idx 改为 sc
    const children = cats.filter(c => c.parent_code === idxCode);
    console.log(`  索引子项 (待重 parent): ${children.length}`);
    let moved = 0;
    for (const ch of children) {
        const oldP = ch.parent_code;
        ch.parent_code = scCode;
        moved++;
        console.log(`    [${ch.code}] ${ch.title.slice(0, 30)}  parent: ${oldP} → ${scCode}`);
    }

    // Step 4: 删除 索引 (此时已无子项引用它)
    const idxIdx = cats.indexOf(idx);
    cats.splice(idxIdx, 1);
    console.log(`  删除 [${idxCode}] 索引`);

    // Step 5: 验证
    console.log('');
    console.log('=== 验证 ===');
    const orphanCheck = new Map(cats.map(c => [c.code, c]));
    let orphans = 0;
    for (const c of cats) {
        if (c.parent_code && !orphanCheck.has(c.parent_code)) {
            console.log(`  ORPHAN: [${c.code}] parent=${c.parent_code}`);
            orphans++;
        }
    }
    console.log('  orphans:', orphans);

    // 重复 code 检查
    const codeMap = new Map();
    for (const c of cats) codeMap.set(c.code, (codeMap.get(c.code) || 0) + 1);
    const dupes = [...codeMap.entries()].filter(([k, v]) => v > 1);
    console.log('  重复 code:', dupes.length);
    if (dupes.length) for (const [k] of dupes) console.log('    ' + k);

    // 显示新 module 01 L2
    console.log('');
    console.log('=== Module 01 L2 列表 ===');
    const l2 = cats.filter(c => c.module_code === '01' && c.level === 2).sort((a, b) => a.code.localeCompare(b.code));
    for (const c of l2) {
        const kids = cats.filter(k => k.parent_code === c.code).length;
        console.log(`  [${c.code}] L2 ${c.title} (${kids} sub-items)`);
    }

    console.log('');
    console.log('  final:', cats.length);
    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();