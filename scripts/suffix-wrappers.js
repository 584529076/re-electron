// scripts/suffix-wrappers.js
// 把所有 wrapperLike 条目统一加 _w 后缀，与 active code 分离
'use strict';

const fs = require('fs');
const path = require('path');

const CATS_PATH = path.join(__dirname, 'parsed-nsfw-asian', 'categories.json');

function wrapperLike(t) {
    if (!t) return false;
    if (/（情色向）|（专项）|（专项词库）|提示词库|^[\w ]+词库|（核心模块|（v\d+\.\d+）/i.test(t)) return true;
    if (/索引|目录|快速定位|快查|速查/i.test(t)) return true;
    if (/^═{3,}|─{3,}|^═/.test(t)) return true;
    if (/\.md\s*[—–-].{20,}/.test(t)) return true;
    return false;
}

function main() {
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));
    const used = new Set(cats.map(c => c.code));
    let renamed = 0;
    for (const c of cats) {
        if (!wrapperLike(c.title)) continue;
        if (c.level === 1) continue;  // 模块根不管
        let newCode = c.code + '_w';
        while (used.has(newCode)) newCode += 'r';
        if (newCode !== c.code) {
            c.code = newCode;
            used.add(newCode);
            renamed++;
        }
    }

    // 修 orphan parent_code
    const allCodes = new Set(cats.map(c => c.code));
    const moduleRoot = cats.find(c => c.level === 1);
    let orphanFixed = 0;
    for (const c of cats) {
        if (!c.parent_code) continue;
        if (allCodes.has(c.parent_code)) continue;
        c.parent_code = moduleRoot ? moduleRoot.code : null;
        orphanFixed++;
    }

    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');

    const counts = new Map();
    for (const c of cats) counts.set(c.code, (counts.get(c.code) || 0) + 1);
    const dups = [...counts.entries()].filter(([k, v]) => v > 1);

    console.log('改名 wrapper 数:', renamed);
    console.log('修 orphan parent_code:', orphanFixed);
    console.log('剩余重复 code:', dups.length);
    console.log('总 _w 后缀:', cats.filter(c => /_w/.test(c.code)).length);
}

main();
