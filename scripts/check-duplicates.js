const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('prompts/prompts.db');

console.log('=== 重复分类统计 ===');
const dups = db.prepare("SELECT category_name, COUNT(*) as c FROM prompt_menu GROUP BY category_name HAVING c > 1 ORDER BY c DESC LIMIT 10").all();
for (const d of dups) console.log(d.c + 'x', d.category_name);

console.log('\n=== 重复分类的 items 分布 ===');
const dupNames = dups.slice(0, 5).map(d => d.category_name);
for (const n of dupNames) {
    const cats = db.prepare('SELECT id FROM prompt_menu WHERE category_name = ? ORDER BY id').all(n);
    console.log('--- ' + n + ' ids:', cats.map(c => c.id).join(','));
    const placeholders = cats.map(() => '?').join(',');
    const itemCounts = db.prepare(`SELECT category_id, COUNT(*) as c FROM prompt_items WHERE category_id IN (${placeholders}) GROUP BY category_id`).all(...cats.map(c => c.id));
    for (const ic of itemCounts) console.log('  cat_id=' + ic.category_id, 'items=' + ic.c);
}

// 总统计
console.log('\n=== 总计 ===');
console.log('prompt_menu 总数:', db.prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c);
console.log('  其中唯一 name:', db.prepare('SELECT COUNT(DISTINCT category_name) AS c FROM prompt_menu').get().c);
console.log('prompt_items 总数:', db.prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c);
console.log('  其中 category_id 指向孤岛（name 唯一但有重复行）的:', '需进一步分析');