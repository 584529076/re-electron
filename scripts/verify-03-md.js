// scripts/verify-03-md.js — 验证 03-裸露液体.md 导入结果
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'prompts', 'prompts.db'), { readonly: true });

console.log('=== 1. L1 根 + L2 章节 ===');
const l1 = db.prepare("SELECT id, category_name FROM prompt_menu WHERE tag_exclusive_group = 'nsfw-template'").all();
l1.forEach(c => console.log('  L1 id=' + c.id + ' ' + c.category_name));
const l1Id = l1[0] && l1[0].id;
const l2 = db.prepare('SELECT id, category_name, description FROM prompt_menu WHERE parent_id = ? ORDER BY sort_order').all(l1Id);
l2.forEach(c => console.log('  L2 id=' + c.id + ' ' + c.category_name));

console.log('\n=== 2. L1-L6 互斥分组 ===');
const levels = db.prepare("SELECT id, category_name FROM prompt_menu WHERE tag_exclusive_group = '裸露等级' ORDER BY category_name").all();
console.log('  共 ' + levels.length + ' 个 Level');
levels.forEach(l => console.log('    id=' + l.id + ' ' + l.category_name));

console.log('\n=== 3. 场景模板（前 10 条） ===');
const scenes = db.prepare("SELECT name, description FROM scene_templates WHERE source = 'md-import' ORDER BY id LIMIT 10").all();
scenes.forEach(s => console.log('  ' + s.name + ' | ' + s.description.split(String.fromCharCode(10))[0]));

console.log('\n=== 4. 附录 C 关联（前 10 条） ===');
// 注意：prompt_a_id / prompt_b_id 可能指向 prompt_items.id 或 prompt_menu.id（分类级关联）
// 用 UNION 兼容两种
const assocs = db.prepare(`
    SELECT a.id, a.reason,
           COALESCE(ia.name, ma.category_name, 'id=' || a.prompt_a_id) as a_name,
           COALESCE(ib.name, mb.category_name, 'id=' || a.prompt_b_id) as b_name
    FROM prompt_associations a
    LEFT JOIN prompt_items ia ON a.prompt_a_id = ia.id
    LEFT JOIN prompt_menu ma ON a.prompt_a_id = ma.id
    LEFT JOIN prompt_items ib ON a.prompt_b_id = ib.id
    LEFT JOIN prompt_menu mb ON a.prompt_b_id = mb.id
    WHERE a.source = 'md-import'
    ORDER BY a.id
`).all();
console.log('  共 ' + assocs.length + ' 条');
assocs.forEach(a => console.log('  [' + a.a_name + ']  ↔  [' + a.b_name + ']   |   ' + a.reason));

console.log('\n=== 5. tag_required 分布（md-import 分类下） ===');
const reqs = db.prepare(`
    WITH RECURSIVE tree(id) AS (
        SELECT id FROM prompt_menu WHERE tag_exclusive_group = 'nsfw-template'
        UNION ALL
        SELECT m.id FROM prompt_menu m JOIN tree ON m.parent_id = tree.id
    )
    SELECT category_name, tag_required FROM prompt_menu
    WHERE tag_required != '' AND id IN (SELECT id FROM tree)
    ORDER BY id
`).all();
console.log('  共 ' + reqs.length + ' 条');
reqs.forEach(c => console.log('  ' + c.category_name + ' → ' + c.tag_required));

console.log('\n=== 6. 数量统计 ===');
// 用 CTE 递归找 root 下所有子分类
console.log('  md-import 分类:  ' + db.prepare(`
    WITH RECURSIVE tree(id) AS (
        SELECT id FROM prompt_menu WHERE tag_exclusive_group = 'nsfw-template'
        UNION ALL
        SELECT m.id FROM prompt_menu m JOIN tree ON m.parent_id = tree.id
    )
    SELECT COUNT(*) c FROM tree
`).get().c);
console.log('  md-import items:  ' + db.prepare(`
    WITH RECURSIVE tree(id) AS (
        SELECT id FROM prompt_menu WHERE tag_exclusive_group = 'nsfw-template'
        UNION ALL
        SELECT m.id FROM prompt_menu m JOIN tree ON m.parent_id = tree.id
    )
    SELECT COUNT(*) c FROM prompt_items WHERE category_id IN (SELECT id FROM tree)
`).get().c);
console.log('  md-import scenes: ' + db.prepare("SELECT COUNT(*) c FROM scene_templates WHERE source = 'md-import'").get().c);
console.log('  md-import assoc:  ' + db.prepare("SELECT COUNT(*) c FROM prompt_associations WHERE source = 'md-import'").get().c);

db.close();
