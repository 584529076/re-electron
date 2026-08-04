// scripts/full-renumber-codes.js
// 全量按 parent_code 链重算视觉层级，再分配干净 code。
// 完成后 active 分类获得 MM.SSS[.SSS[.SSS]] 形式；wrapper/removed 拿 _w 后缀。
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

function padCode(parts) {
    // parts[0] = module (1-2 digit), parts[1+] = 3-digit zero-pad
    if (!parts || !parts.length) return null;
    const head = String(Number(parts[0])).padStart(2, '0');
    const tail = parts.slice(1).map(p => String(Number(p)).padStart(3, '0'));
    return [head, ...tail].join('.');
}

function main() {
    const cats = JSON.parse(fs.readFileSync(CATS_PATH, 'utf8'));

    // 1. 用现有 parent_code 链重建树（不依赖当前 code 字段）
    //    module root = level=1
    const moduleRoot = cats.find(c => c.level === 1);
    if (!moduleRoot) { console.error('No module root'); return; }
    const moduleNum = String(Number(moduleRoot.code)).padStart(2, '0');

    // 2. 按 parent_code 分桶
    const childrenByCode = new Map();  // parent_code (raw) → entries
    const byCode = new Map();
    for (const c of cats) {
        byCode.set(c.code, c);
    }
    for (const c of cats) {
        const key = c.parent_code || '__ROOT__';
        if (!childrenByCode.has(key)) childrenByCode.set(key, []);
        childrenByCode.get(key).push(c);
    }

    // 3. 用 wrapperLike 标记哪些应该被排除（视为 removed）
    //    这些会被附加 _w 后缀，active 分类拿新 padding code
    // 4. DFS 走 module 根，按视觉层级对 active 编号，wrapper 平级挂到 module 根（拿 _w 后缀避免冲）
    const newCode = new Map();  // 原始 entry → 新 code
    const wrapperNewCode = new Map();

    function visit(parentCode, prefixParts, depth) {
        const kids = childrenByCode.get(parentCode) || [];
        // 排序：按当前 code 字符串稳定排
        kids.sort((a, b) => String(a.code).localeCompare(String(b.code)));
        let pos = 1;
        for (const k of kids) {
            const newParts = [...prefixParts, pos];
            const padded = padCode(newParts);
            if (wrapperLike(k.title)) {
                wrapperNewCode.set(k.code, padded + '_w' + (wrapperNewCode.has(k.code) ? 'r' : ''));
            } else {
                newCode.set(k.code, padded);
                // 递归处理子节点
                visit(k.code, newParts, depth + 1);
            }
            pos++;
        }
    }
    visit(moduleRoot.code, [moduleNum], 1);

    // 5. 重置 module 根（新 code 等于 padded module number）
    const newRootCode = moduleNum;

    // 6. 应用新 code + 修复 parent_code
    const usedCodes = new Set([newRootCode, ...newCode.values(), ...wrapperNewCode.values()]);

    // 给所有 wrapper 一个唯一 code：base + _w + 计数
    const wrapperSeen = new Map();
    for (const c of cats) {
        if (!wrapperNewCode.has(c.code) && !(c.level === 1)) continue;
        let base = wrapperNewCode.get(c.code);
        const cnt = wrapperSeen.get(base) || 0;
        let finalCode = base + (cnt > 0 ? 'r'.repeat(cnt) : '');
        while (usedCodes.has(finalCode) && finalCode !== c.code) {
            finalCode += 'r';
        }
        c.code = finalCode;
        usedCodes.add(finalCode);
        wrapperSeen.set(base, cnt + 1);
    }

    // module 根重置
    moduleRoot.code = newRootCode;

    // active 分类赋值
    for (const c of cats) {
        if (!newCode.has(c.code)) continue;  // 已处理或 wrapper
        c.code = newCode.get(c.code);
        usedCodes.add(c.code);
    }

    // 7. 修复 parent_code：把指向旧 wrapper 的 parent 改为指向 module 根
    const allCodes = new Set(cats.map(c => c.code));
    for (const c of cats) {
        if (!c.parent_code) continue;
        if (allCodes.has(c.parent_code)) continue;  // OK
        // parent 不存在 → 设为 module 根
        c.parent_code = newRootCode;
    }

    // 8. 写入
    fs.writeFileSync(CATS_PATH, JSON.stringify(cats, null, 2), 'utf8');

    // 验证
    const counts = new Map();
    for (const c of cats) counts.set(c.code, (counts.get(c.code) || 0) + 1);
    const dups = [...counts.entries()].filter(([k, v]) => v > 1);
    const renumbered = cats.filter(c => !/_w/.test(c.code) && c.level !== 1).length;
    const wrappers = cats.filter(c => /_w/.test(c.code)).length;
    const stillWr = cats.filter(c => /_w/.test(c.code) && !wrapperLike(c.title)).length;
    const stillAc = cats.filter(c => !/_w/.test(c.code) && wrapperLike(c.title) && c.level !== 1).length;

    console.log('总条数:', cats.length);
    console.log('重复 code:', dups.length);
    console.log('active (重排):', renumbered);
    console.log('wrapper (_w 后缀):', wrappers);
    console.log('仍错（_w 但非 wrapper）:', stillWr);
    console.log('仍错（clean 但 wrapper）:', stillAc);
}

main();
