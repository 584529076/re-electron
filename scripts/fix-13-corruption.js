// scripts/fix-13-corruption.js
// 修复 module 13 修删 bug: 4 个 铁律 (13.002.001-004) 应删除但被留下
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function main() {
    let cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    console.log('  initial:', cats.length);

    // 删除 parent_code=null 且 title 以"铁律"开头的 4 个孤儿
    const toDelete = cats.filter(c =>
        c.module_code === '13' &&
        c.parent_code === null &&
        /^铁律/.test(c.title)
    );
    console.log('  待删 4 个铁律:', toDelete.length);
    for (const c of toDelete) {
        console.log('    [' + c.code + '] ' + c.title);
    }

    const newCats = cats.filter(c => !toDelete.includes(c));

    // 验证
    const cm = new Map();
    for (const c of newCats) cm.set(c.code, (cm.get(c.code) || 0) + 1);
    const dupes = [...cm.entries()].filter(([k, v]) => v > 1);
    console.log('  重复 code:', dupes.length);
    if (dupes.length) for (const [k] of dupes) console.log('    ' + k);

    const orphans = newCats.filter(c => c.parent_code && !cm.has(c.parent_code));
    console.log('  orphans:', orphans.length);
    if (orphans.length) for (const o of orphans.slice(0, 5)) console.log('    ' + o.code + ' parent=' + o.parent_code);

    console.log('  final: ' + newCats.length + ' (变化 ' + (newCats.length - cats.length) + ')');
    fs.writeFileSync(CATS_PATH, JSON.stringify(newCats, null, 2), 'utf8');
    console.log('✓ 完成');
}

main();
