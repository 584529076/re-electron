// scripts/finalize-codes.js
// 最后一次清尾：剥掉累积后缀，给 wrapper 加 _w，active 拿新 padded code
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

function stripSuffix(c) {
    // 剥 _w, _r 复合后缀
    let s = c.code;
    while (/_[rw]+$/.test(s)) {
        const m = s.match(/^(.+?)[_][rw]+$/);
        if (!m) break;
        s = m[1];
    }
    return s;
}

function pad(code) {
    // 把 MM.NNN.KKK 风格的 code 规范化为零填充
    const parts = String(code).split('.');
    return String(Number(parts[0])).padStart(2, '0')
        + parts.slice(1).map(p => String(Number(p)).padStart(3, '0')).map(s => '.' + s).join('');
}

function main() {
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));

    // 1. 剥所有 _w, _r 后缀，纯 base code
    let stripped = 0;
    for (const c of cats) {
        const orig = c.code;
        const base = stripSuffix(c);
        if (base !== orig) {
            c.code = base;
            stripped++;
        }
    }
    console.log('剥后缀:', stripped);

    // 2. 给 wrapperLike 加 _w 后缀（保留唯一性）
    const used = new Set(cats.map(c => c.code));
    let wrapped = 0;
    for (const c of cats) {
        if (c.level === 1) continue;
        if (!wrapperLike(c.title)) continue;
        let base = c.code + '_w';
        while (used.has(base)) base += 'w';
        c.code = base;
        used.add(base);
        wrapped++;
    }
    console.log('加 _w:', wrapped);

    // 3. 处理 parent_code：剥 _w 后缀
    for (const c of cats) {
        if (!c.parent_code) continue;
        const base = stripSuffix({ code: c.parent_code });
        c.parent_code = base;
    }

    // 4. 重新规范化所有 code 为零填充（除 _w 后缀）
    const renormed = new Map();
    for (const c of cats) {
        const m = c.code.match(/^(.+\.\d+)(_w+)$/);
        if (m) {
            c.code = pad(m[1]) + m[2];
        } else {
            c.code = pad(c.code);
        }
        if (renormed.has(c.code)) {
            // duplicate — 加 _w 后缀
            let alt = c.code + '_w';
            let cnt = 0;
            while (renormed.has(alt) || cats.some(x => x !== c && x.code === alt)) {
                alt = c.code + '_w' + 'w'.repeat(++cnt);
            }
            c.code = alt;
        }
        renormed.set(c.code, true);
    }

    // 5. 修 parent_code
    const allCodes = new Set(cats.map(c => c.code));
    const moduleRoots = cats.filter(c => c.level === 1);
    let orphanFixed = 0;
    for (const c of cats) {
        if (!c.parent_code) continue;
        if (allCodes.has(c.parent_code)) continue;
        // 找最近的 module 根
        const found = moduleRoots.find(m => c.parent_code && c.parent_code.startsWith(m.code));
        c.parent_code = found ? found.code : (moduleRoots[0] ? moduleRoots[0].code : null);
        orphanFixed++;
    }
    console.log('orphan parent 修复:', orphanFixed);

    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');

    // 验证
    const counts = new Map();
    for (const c of cats) counts.set(c.code, (counts.get(c.code) || 0) + 1);
    const dups = [...counts.entries()].filter(([k, v]) => v > 1);
    const wCnt = cats.filter(c => /_w/.test(c.code)).length;
    const rCnt = cats.filter(c => /_r/.test(c.code)).length;
    console.log('重复:', dups.length);
    console.log('_w 总数:', wCnt);
    console.log('_r 总数:', rCnt);

    if (dups.length > 0) {
        for (const [k] of dups.slice(0, 5)) {
            const es = cats.filter(c => c.code === k);
            console.log('  [' + k + ']:');
            for (const e of es.slice(0, 3)) console.log('    L' + e.level + ' | ' + e.title.substring(0, 40));
        }
    }
}

main();
