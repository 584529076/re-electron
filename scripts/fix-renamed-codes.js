// scripts/fix-renamed-codes.js
// 反向修复被错误改 _r 的 active banner
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

    let swapCount = 0;
    // 任一 wrapper-like 的（含 L2 wrapper / 文件名回声 / 装饰行 / TOC）
    // 与非 wrapper-like 配对时，确保 wrapper 拿 _r 后缀
    for (let i = 0; i < cats.length; i++) {
        const c = cats[i];
        const m = c.code.match(/^(.+)_r+$/);
        if (!m) continue;
        const baseCode = m[1];
        const others = cats.filter(x => x !== c && x.code === baseCode);
        if (others.length !== 1) continue;
        const other = others[0];
        // c 拿 _r，other 拿 clean code → 检查是否错了
        const cIsWrapper = wrapperLike(c.title);
        const otherIsWrapper = wrapperLike(other.title);
        if (otherIsWrapper && !cIsWrapper) {
            const tmpCode = c.code;
            c.code = other.code;
            other.code = tmpCode;
            swapCount++;
        }
    }
    console.log('交换了', swapCount, '对');

    // 修孤儿 parent_code
    const allCodes = new Set(cats.map(c => c.code));
    let orphanFixed = 0;
    for (const c of cats) {
        if (c.parent_code && !allCodes.has(c.parent_code)) {
            c.parent_code = null;
            orphanFixed++;
        }
    }
    console.log('孤儿 parent_code 修复:', orphanFixed);

    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');

    // 验证
    const counts = new Map();
    for (const c of cats) counts.set(c.code, (counts.get(c.code) || 0) + 1);
    const remain = [...counts.entries()].filter(([k, v]) => v > 1);
    console.log('剩余冲突:', remain.length);
    if (remain.length) {
        for (const [k] of remain) {
            const es = cats.filter(c => c.code === k);
            console.log('  [' + k + ']:');
            for (const e of es) console.log('    L' + e.level + ' | ' + e.title);
        }
    }
}

main();
