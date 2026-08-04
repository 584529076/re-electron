// scripts/full-nsfw-import.js
// 跑一次完整入库（模拟前端向导的 prompt:nsfwImport:execute）。
// 用 node:sqlite，路径与 smoke 测试一致，但不限制条数。

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'prompts', 'prompts.db');
const PARSED_DIR = path.join(PROJECT_ROOT, 'parsed-nsfw-asian');

const normPath = p => String(p || '').replace(/\s*\/\s*/g, ' / ').trim();
// 用 normPath 后的 ' / ' split（避免 category name 含 '/' 时 lastIndexOf 误判）
const deriveParentPath = p => {
    const parts = String(p || '').split(' / ').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join(' / ');
};

let _db = null;
function db() {
    if (!_db) _db = new DatabaseSync(DB_PATH);
    return _db;
}

function buildPathIndexFromExistingMenu() {
    const idx = new Map();
    // path → id：从 prompt_menu 现存记录重建（pid_list 是 /1/4/12/ 形式）
    const all = db().prepare('SELECT id, category_name, parent_id, pid_list FROM prompt_menu').all();
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

function runFullImport({ categories, items, associations, examples }) {
    const start = Date.now();
    const stats = { categories_created: 0, categories_skipped: 0, items_created: 0, items_updated: 0, items_skipped: 0, associations_created: 0, examples_imported: 0 };
    const pathToId = buildPathIndexFromExistingMenu();
    const pathToIdWrite = new Map(pathToId);

    db().exec('BEGIN');
    try {
        // 1. categories
        const sortedCats = categories.slice().sort((x, y) => (x.level || 1) - (y.level || 1));
        for (const c of sortedCats) {
            const path = String(c.path || c.name || '').trim();
            const name = String(c.name || path).trim();
            if (!path) continue;
            const np = normPath(path);
            if (pathToIdWrite.has(np)) { stats.categories_skipped++; continue; }
            const parentPath = normPath(deriveParentPath(path));
            const parentId = pathToIdWrite.get(parentPath) || 0;
            try {
                const r = db().prepare(`INSERT INTO prompt_menu
                    (category_name, parent_id, description, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(name, parentId, String(c.description || '').slice(0, 4000), 0, c.is_required ? 1 : 0, '', '', '', '');
                const newId = r.lastInsertRowid;
                const parentRow = parentId === 0 ? null : db().prepare('SELECT pid_list FROM prompt_menu WHERE id = ?').get(parentId);
                const pid = (!parentRow || !parentRow.pid_list || parentRow.pid_list === '/') ? '/' : parentRow.pid_list;
                db().prepare('UPDATE prompt_menu SET pid_list = ? WHERE id = ?').run(pid + newId + '/', newId);
                pathToIdWrite.set(np, newId);
                stats.categories_created++;
            } catch (e) {
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
            const aliases = Array.isArray(it.aliases) ? JSON.stringify(it.aliases) : (typeof it.aliases === 'string' ? it.aliases : '[]');
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
            } catch (e) {}
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

        db().exec('COMMIT');
        return { stats, duration_ms: dur };
    } catch (e) {
        db().exec('ROLLBACK');
        throw e;
    }
}

function main() {
    if (!fs.existsSync(DB_PATH)) { console.error('DB missing'); process.exit(1); }
    if (!fs.existsSync(PARSED_DIR)) { console.error('PARSED_DIR missing'); process.exit(1); }

    console.log('▶ full-nsfw-import (all 14 modules, no sample limit)');
    const cats  = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'categories.json'), 'utf8'));
    const items = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'items.json'), 'utf8'));
    const assocs= JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'associations-preview.json'), 'utf8'));
    const examples = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, 'examples.json'), 'utf8'));

    console.log('  input sizes:', JSON.stringify({cats: cats.length, items: items.length, assocs: assocs.length, examples: examples.length}));

    const before = {
        cats: db().prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c,
        items: db().prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c,
        assocs: db().prepare('SELECT COUNT(*) AS c FROM prompt_associations').get().c,
        examples: db().prepare('SELECT COUNT(*) AS c FROM prompt_examples').get().c,
    };
    console.log('  BEFORE:', before);

    const r = runFullImport({ categories: cats, items, associations: assocs, examples });
    console.log('  result:', JSON.stringify(r.stats), 'in', (r.duration_ms/1000).toFixed(1), 's');

    const after = {
        cats: db().prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c,
        items: db().prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c,
        assocs: db().prepare('SELECT COUNT(*) AS c FROM prompt_associations').get().c,
        examples: db().prepare('SELECT COUNT(*) AS c FROM prompt_examples').get().c,
        history: db().prepare('SELECT COUNT(*) AS c FROM prompt_import_history').get().c,
    };
    console.log('  AFTER:', after);

    console.log('\n  delta:', JSON.stringify({
        cats: after.cats - before.cats,
        items: after.items - before.items,
        assocs: after.assocs - before.assocs,
        examples: after.examples - before.examples,
    }));

    console.log('\n✓ full import pass done');
}

main();
