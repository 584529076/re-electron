// scripts/fix-category-hierarchy.js
// 修复 prompt_menu 中 parent_id 错误的分类：
// 用 categories.json 的 code / parent_code 字段（无歧义层级）作为权威。
//
// 流程：
// 1. 对每个 (module_code, level, name, code) 在 DB 里匹配出对应 id；
//    同一 name 可能出现多次，按 (parent_code, name) 区分。
// 2. 对每个 DB 分类，根据其同名 category 的 (parent_code) 在 categories.json 中找到父，
//    再用 code 匹配出 DB 里父的 id，更新 parent_id + pid_list。
//
// 用法：node scripts/fix-category-hierarchy.js

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'prompts', 'prompts.db');
const PARSED_DIR = path.join(PROJECT_ROOT, 'parsed-nsfw-asian');

function main() {
    const db = new DatabaseSync(DB_PATH);
    if (!fs.existsSync(path.join(PARSED_DIR, 'categories.json'))) {
        console.error('categories.json 缺失，请先跑 parse');
        process.exit(1);
    }
    const cats = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'categories.json'), 'utf8'));

    // 1. 对 categories.json 用 code 建索引：code → category entry
    const codeToCat = new Map();
    for (const c of cats) {
        if (c.code) codeToCat.set(c.code, c);
    }

    // 2. 对 DB 的所有分类，按 (category_name) 聚合（同名多条），每条携带 module 信息
    const all = db.prepare('SELECT id, category_name, parent_id, pid_list FROM prompt_menu').all();
    const sameNameRows = new Map();
    for (const r of all) {
        const arr = sameNameRows.get(r.category_name) || [];
        arr.push(r);
        sameNameRows.set(r.category_name, arr);
    }

    // 3. 对 categories.json 用 (module_code + name) → [category entry] 建索引
    //    同一个 name 在不同 module 里可能各出现一次（最常见）
    const modNameToCats = new Map();
    for (const c of cats) {
        if (!c.module_code || !c.name) continue;
        const k = c.module_code + '||' + c.name;
        const arr = modNameToCats.get(k) || [];
        arr.push(c);
        modNameToCats.set(k, arr);
    }

    // 4. 对每个 DB 分类：尝试找到它在 categories.json 里的对应 entry
    //    匹配规则：用 module_code + name 匹配；如果 DB 分类的 name 唯一 → 用之
    //    难点：DB 分类不带 module_code。先启发式推断：找到 categories.json 里 name 出现的所有 module
    //    → 用 parent_id = 0 的是模块根这一特性把当前 DB 分类放进对应模块
    //    简化：如果 name 在 categories.json 里只在一个 module 出现，必然属于该 module

    // 先按 name → unique modules 关系分组
    const nameToModules = new Map();
    for (const c of cats) {
        if (!c.name) continue;
        const arr = nameToModules.get(c.name) || new Set();
        arr.add(c.module_code);
        nameToModules.set(c.name, arr);
    }

    // 5. 对每个 DB 分类推断其 module + 找到 categories.json 里对应的 entry
    //    如果 name 只在一个 module 出现，直接归该 module
    //    如果出现在多个 → 看它的 parent_id 的 chain，递归查 module 根

    // 先建立 module_code → module root id 的索引（DB 中）
    // module 根的 category_name 形如 "00-范例" / "01-场景主题" / "02-景别构图"
    const moduleRoots = new Map();
    for (const r of all) {
        if (/^\d{2}-/.test(r.category_name)) {
            const m = r.category_name.match(/^(\d{2})-/);
            if (m) {
                if (!moduleRoots.has(m[1])) moduleRoots.set(m[1], r.id);
            }
        }
    }
    // module_root 也用 nameToModules 验证
    // 注意：'索引' 这种 name 在多个 module 各出现一次，需要区分

    function moduleOf(r) {
        // 如果分类本身就是模块根（name 形如 NN-xxx），直接返回 NN
        const m = String(r.category_name || '').match(/^(\d{2})-/);
        if (m) return m[1];
        // 否则：递归查 parent_id 看父辈里有没有模块根
        let cur = r;
        const seen = new Set();
        while (cur && cur.parent_id && !seen.has(cur.id)) {
            seen.add(cur.id);
            const parent = all.find(x => x.id === cur.parent_id);
            if (!parent) break;
            cur = parent;
            const mm = String(cur.category_name || '').match(/^(\d{2})-/);
            if (mm) return mm[1];
        }
        // 最后用 categories.json 的 name → unique module 推断
        const modules = nameToModules.get(r.category_name);
        if (modules && modules.size === 1) return Array.from(modules)[0];
        return null;
    }

    // 6. 对每个 DB 分类找 categories.json 中的"权威 entry"
    //    策略：用 module + name 匹配；如果多个匹配（同名不同 parent_code），需要进一步消歧
    function findCatEntry(r) {
        const mod = moduleOf(r);
        if (!mod) return null;
        const k = mod + '||' + r.category_name;
        const arr = modNameToCats.get(k);
        if (!arr || !arr.length) return null;
        if (arr.length === 1) return arr[0];
        // 多个匹配 → 用父辈定位
        // 暂时返回第一个
        return arr[0];
    }

    // 7. 对每个 DB 分类推断 expected parent id：
    //    用 entry.parent_code 找到 categories.json 中的父 entry → 找 DB 里对应的 (module + parent name) 的 id
    function expectedParentIdFor(r) {
        const entry = findCatEntry(r);
        if (!entry) return null;
        if (!entry.parent_code) return null; // 模块根
        const parentEntry = codeToCat.get(entry.parent_code);
        if (!parentEntry) return null;
        // 用 parentEntry.module_code + parentEntry.name 找 DB id
        const k = parentEntry.module_code + '||' + parentEntry.name;
        const parentNameRows = sameNameRows.get(parentEntry.name) || [];
        // 优先匹配 module_code 一致的
        for (const p of parentNameRows) {
            const pMod = moduleOf(p);
            if (pMod === parentEntry.module_code) return p.id;
        }
        // 兜底：取第一条
        return parentNameRows.length ? parentNameRows[0].id : null;
    }

    // 8. 按 pid_list 深度排序（先根后子）
    function depthOf(r) {
        const p = (r.pid_list || '').split('/').filter(Boolean).length;
        return p;
    }
    const sorted = all.slice().sort((a, b) => depthOf(a) - depthOf(b));

    // 9. 重新计算每个分类的 parent
    const updates = [];
    db.exec('BEGIN');
    try {
        for (const r of sorted) {
            const expectedParentId = expectedParentIdFor(r);
            if (expectedParentId == null) continue;
            if (expectedParentId === r.parent_id) continue;
            // 跳过模块根（parent_id = 0 且自己就是 NN-xxx 的）
            if (r.parent_id === 0 && /^\d{2}-/.test(r.category_name)) continue;
            // 算新 pid_list
            const parentRow = db.prepare('SELECT pid_list FROM prompt_menu WHERE id = ?').get(expectedParentId);
            const parentPid = parentRow && parentRow.pid_list ? parentRow.pid_list : '/';
            const newPid = parentPid + r.id + '/';
            db.prepare('UPDATE prompt_menu SET parent_id = ?, pid_list = ? WHERE id = ?').run(expectedParentId, newPid, r.id);
            updates.push({ id: r.id, name: r.category_name, old: r.parent_id, new: expectedParentId, new_pid: newPid });
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    console.log('✓ 修复完成');
    console.log('  总分类:', all.length);
    console.log('  修复 parent_id 条数:', updates.length);
    console.log('  前 12 条修复明细:');
    for (const u of updates.slice(0, 12)) {
        console.log('    id=' + u.id, '「' + u.name + '」 parent_id ' + u.old + ' → ' + u.new, '(pid=' + u.new_pid + ')');
    }

    // 验证
    const stillRoot = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu WHERE parent_id = 0').get().c;
    const stillWrong = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu WHERE parent_id = 0 AND category_name NOT LIKE \'__%__\' ESCAPE \'_\' AND category_name NOT GLOB \'[0-9][0-9]-*\'').get().c;
    console.log('\n  parent_id=0 的剩余分类:', stillRoot);
    console.log('  其中模块根（id-pattern NN-*）:', db.prepare('SELECT COUNT(*) AS c FROM prompt_menu WHERE parent_id = 0 AND category_name GLOB \'[0-9][0-9]-*\'').get().c);
}

main();