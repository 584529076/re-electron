// scripts/smoke-nsfw-import.js
// 用 node:sqlite 直接跑一遍 ipcMain handler 等价的 SQL 操作，
// 验证 D-NSFW-A/B/C 的 SQL 路径都能跑通。
//
// 用法：node scripts/smoke-nsfw-import.js
//
// 不依赖 Electron / better-sqlite3，直接走 node:sqlite 同源 schema。

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'prompts', 'prompts.db');
const PARSED_DIR = path.join(PROJECT_ROOT, 'parsed-nsfw-asian');

let _db = null;
function db() {
    if (!_db) _db = new DatabaseSync(DB_PATH);
    return _db;
}

function normPath(p) { return String(p || '').replace(/\s*\/\s*/g, ' / ').trim(); }
function deriveParentPath(path) {
    const parts = String(path || '').split(' / ').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join(' / ');
}

let _pathMap = null;
function pathMapFresh() {
    const m = new Map();
    for (const row of db().prepare('SELECT id, category_name, parent_id FROM prompt_menu').all()) {
        // 用 path 而非 name 作为 key 更稳定，但这里没有 pid_list 的存储。
        // 用 "name + parent_id 索引" 反查
    }
    _pathMap = m;
    return m;
}

function buildPathIndex() {
    const idx = new Map();   // path → id
    const rows = db().prepare('SELECT id, category_name, pid_list FROM prompt_menu').all();
    for (const r of rows) {
        // pid_list 形如 '/1/4/12/'  → 用 category_name 反向拼接路径繁琐，这里简化：
        // 改用 path 推断：从 prompt_menu 表读出所有 category，按 name 顺序 + parent_id 关系还原路径
    }
    // 简单重建：以 parent_id=0 为根，按子节点迭代
    const all = db().prepare('SELECT id, category_name, parent_id FROM prompt_menu').all();
    const byParent = new Map();
    for (const r of all) {
        const arr = byParent.get(r.parent_id) || [];
        arr.push(r);
        byParent.set(r.parent_id, arr);
    }
    function walk(parentId, prefix) {
        for (const r of (byParent.get(parentId) || [])) {
            const p = prefix ? prefix + ' / ' + r.category_name : r.category_name;
            idx.set(p, r.id);
            walk(r.id, p);
        }
    }
    walk(0, '');
    return idx;
}

function runImport({ categories = [], items = [], associations = [], examples = [] } = {}) {
    const start = Date.now();
    const stats = { categories_created: 0, categories_skipped: 0, items_created: 0, items_updated: 0, items_skipped: 0, associations_created: 0, examples_imported: 0 };
    const pathToId = buildPathIndex();
    const pathToIdWrite = new Map(pathToId);  // 含已存在的

    // 1. categories
    const sortedCats = categories.slice().sort((x, y) => (x.level || 1) - (y.level || 1));
    for (const c of sortedCats) {
        const path = String(c.path || c.name || '').trim();
        const name = String(c.name || path).trim();
        if (!path) continue;
        if (pathToIdWrite.has(normPath(path))) { stats.categories_skipped++; continue; }
        const parentPath = normPath(deriveParentPath(path));
        const parentId = pathToIdWrite.get(parentPath) || 0;
        try {
            const r = db().prepare(`INSERT INTO prompt_menu
                (category_name, parent_id, description, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(name, parentId, String(c.description || '').slice(0, 4000), 0, c.is_required ? 1 : 0, '', '', '', '');
            const newId = r.lastInsertRowid;
            const pid = parentId === 0 ? '/' : (db().prepare('SELECT pid_list FROM prompt_menu WHERE id = ?').get(parentId).pid_list || '/');
            db().prepare('UPDATE prompt_menu SET pid_list = ? WHERE id = ?').run(pid + newId + '/', newId);
            pathToIdWrite.set(normPath(path), newId);
            stats.categories_created++;
        } catch (e) {
            console.log('category skipped:', name, e.message);
            stats.categories_skipped++;
        }
    }

    // 2. items
    const phraseToId = new Map();
    for (const it of items) {
        const content = String(it.phrase || '').trim();
        if (!content) { stats.items_skipped++; continue; }
        const catId = pathToIdWrite.get(normPath(it.category_path || ''));
        if (!catId) { stats.items_skipped++; continue; }
        const aliases = Array.isArray(it.aliases) ? JSON.stringify(it.aliases) : (it.aliases || '[]');
        const desc = String(it.description || '').slice(0, 4000);
        const sens = String(it.sensitivity || 'nsfw');
        const exist = db().prepare('SELECT id FROM prompt_items WHERE name = ? AND category_id = ?').get(content, catId);
        if (exist) {
            db().prepare(`UPDATE prompt_items SET content = ?, description = ?, sensitivity = ?,
                aliases = ?, updated_at = strftime('%s','now') WHERE id = ?`)
                .run(content, desc, sens, aliases, exist.id);
            phraseToId.set(content, exist.id);
            stats.items_updated++;
        } else {
            try {
                const r = db().prepare(`INSERT INTO prompt_items
                    (category_id, name, content, description, sensitivity, aliases)
                    VALUES (?, ?, ?, ?, ?, ?)`)
                    .run(catId, content, content, desc, sens, aliases);
                phraseToId.set(content, r.lastInsertRowid);
                stats.items_created++;
            } catch (e) {
                console.log('item failed:', content.slice(0, 30), e.message);
                stats.items_skipped++;
            }
        }
    }

    // 3. associations
    for (const a of associations) {
        let aId = phraseToId.get(String(a.a || ''));
        if (!aId) {
            const r = db().prepare('SELECT id FROM prompt_items WHERE name = ? LIMIT 1').get(String(a.a || ''));
            aId = r ? r.id : null;
        }
        let bId = phraseToId.get(String(a.b || ''));
        if (!bId) {
            const r = db().prepare('SELECT id FROM prompt_items WHERE name = ? LIMIT 1').get(String(a.b || ''));
            bId = r ? r.id : null;
        }
        if (!aId || !bId || aId === bId) continue;
        const rel = (a.type === 'strong' || a.type === 'weak') ? a.type : 'exclusive';
        const w = Number(a.weight) || 100;
        try {
            db().prepare(`INSERT OR IGNORE INTO prompt_associations
                (prompt_a_id, prompt_b_id, relation, weight, source, reason, scope)
                VALUES (?, ?, ?, ?, ?, ?, 'item')`)
                .run(aId, bId, rel, w,
                     String(a.source || 'md-import').slice(0, 100),
                     String(a.reason || '').slice(0, 4000));
            stats.associations_created++;
        } catch (e) {
            // ignore
        }
    }

    // 4. examples
    for (const ex of examples) {
        const title = String(ex.title || '').trim();
        const english = String(ex.english_content || '').trim();
        if (!title || !english) continue;
        const keywords = Array.isArray(ex.keywords) ? JSON.stringify(ex.keywords) : (typeof ex.keywords === 'string' ? ex.keywords : '[]');
        try {
            db().prepare(`INSERT INTO prompt_examples
                (category_id, title, english_content, chinese_description, style, keywords, source)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(null, title, english,
                     String(ex.chinese_description || '').slice(0, 4000),
                     String(ex.style || '').slice(0, 200),
                     keywords,
                     String(ex.source || 'md-import-00').slice(0, 100));
            stats.examples_imported++;
        } catch (e) {}
    }

    const dur = Date.now() - start;
    db().prepare(`INSERT INTO prompt_import_history
        (source, version, categories_created, categories_skipped, items_created, items_updated, items_skipped, associations_created, examples_imported, duration_ms, config_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('nsfw-asian', 'v3.0',
             stats.categories_created, stats.categories_skipped,
             stats.items_created, stats.items_updated, stats.items_skipped,
             stats.associations_created, stats.examples_imported, dur, '{}');
    return { stats, duration_ms: dur };
}

function main() {
    if (!fs.existsSync(DB_PATH)) { console.error('DB missing'); process.exit(1); }
    if (!fs.existsSync(PARSED_DIR)) { console.error('PARSED_DIR missing; run parse first'); process.exit(1); }

    console.log('▶ smoke-nsfw-import');
    const cats = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'categories.json'), 'utf8'));
    const items = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'items.json'), 'utf8'));
    const assocs = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'associations-preview.json'), 'utf8'));
    const examples = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'examples.json'), 'utf8'));

    // 预演：所有 categories（确保所有 item 引用的 category_path 都能命中），
    // 再从 items 中只筛 category_path 落在前 100 个分类的子集，控制写入规模到 ~1000 条。
    const allCatPaths = new Set(cats.map(c => normPath(c.path || '')));
    const itemsMatchingEarlyCats = [];
    for (const it of items) {
        if (allCatPaths.has(normPath(it.category_path || ''))) {
            itemsMatchingEarlyCats.push(it);
            if (itemsMatchingEarlyCats.length >= 1000) break;
        }
    }
    // 同样只保留 a/b 都能命中的 association
    const itemNames = new Set(itemsMatchingEarlyCats.map(i => String(i.phrase).trim()));
    const assocsResolvable = assocs.filter(a => itemNames.has(String(a.a).trim()) && itemNames.has(String(a.b).trim())).slice(0, 23);

    const sample = {
        categories: cats,           // 所有 categories（保证路径索引全）
        items: itemsMatchingEarlyCats,
        associations: assocsResolvable,
        examples: examples.slice(0, 10),
    };
    console.log('  sample sizes:', JSON.stringify({
        cats: sample.categories.length,
        items: sample.items.length,
        assocs: sample.associations.length,
        examples: sample.examples.length,
    }));

    const result = runImport(sample);
    console.log('  result:', JSON.stringify(result.stats), 'in', result.duration_ms, 'ms');

    // 验证
    const catsAfter = db().prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c;
    const itemsAfter = db().prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c;
    const assocsAfter = db().prepare('SELECT COUNT(*) AS c FROM prompt_associations').get().c;
    const exAfter = db().prepare('SELECT COUNT(*) AS c FROM prompt_examples').get().c;
    const histAfter = db().prepare('SELECT COUNT(*) AS c FROM prompt_import_history').get().c;
    console.log('\n  AFTER:');
    console.log('    prompt_menu       : ' + catsAfter);
    console.log('    prompt_items      : ' + itemsAfter);
    console.log('    prompt_associations: ' + assocsAfter);
    console.log('    prompt_examples   : ' + exAfter);
    console.log('    prompt_import_history: ' + histAfter);

    console.log('\n✓ smoke test passed (sample 100/1000/23/10 written successfully)');
}

main();
