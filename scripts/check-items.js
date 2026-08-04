const Database = require('better-sqlite3');
const db = new Database('D:/re-electron/prompts/prompts.db');

// 检查 prompt_items 表
const cols = db.prepare("PRAGMA table_info(prompt_items)").all();
console.log('prompt_items columns:', cols.map(c => c.name).join(', '));

const cnt = db.prepare("SELECT COUNT(*) c FROM prompt_items").get().c;
console.log('prompt_items total:', cnt);

if (cnt > 0) {
  const sample = db.prepare("SELECT id, category_id, name, sort_order, sensitivity FROM prompt_items ORDER BY id LIMIT 10").all();
  console.log('first 10 items:');
  sample.forEach(r => console.log('  ', r));
  
  // 看每个 category 的统计
  const byCat = db.prepare("SELECT category_id, COUNT(*) c FROM prompt_items GROUP BY category_id ORDER BY c DESC LIMIT 15").all();
  console.log('top categories by item count:');
  byCat.forEach(r => console.log('  cat=' + r.category_id, 'count=' + r.c));
}

// 比对 category_id 是否真的在 prompt_menu 里
const orphans = db.prepare(`
  SELECT i.id, i.category_id, i.name FROM prompt_items i
  LEFT JOIN prompt_menu m ON m.id = i.category_id
  WHERE m.id IS NULL
`).all();
console.log('items with missing category_id:', orphans.length);
if (orphans.length) orphans.slice(0, 5).forEach(r => console.log('  orphan:', r));
