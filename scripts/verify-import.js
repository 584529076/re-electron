const Database = require('better-sqlite3');
const db = new Database('D:/re-electron/prompts/prompts.db');
const q = (sql, p = []) => db.prepare(sql).all(p);

console.log('--- 0.1 family (L2 + L3 children under 00-范例) ---');
const l00 = q('SELECT id FROM prompt_menu WHERE category_name = ?', ['00-范例'])[0];
console.log('  00-范例 id =', l00.id);
console.log('  L2 children of 00-范例:');
q('SELECT id, category_name, parent_id, pid_list FROM prompt_menu WHERE parent_id = ? ORDER BY id', [l00.id]).forEach(r => {
  console.log('    id=' + r.id + ' ' + r.pid_list + ' ' + r.category_name);
});
console.log('');

const l01 = q('SELECT id FROM prompt_menu WHERE category_name LIKE ?', ['01-场景主题'])[0];
console.log('--- 01-场景主题 (L1) and its L2 children ---');
console.log('  01-场景主题 id =', l01.id);
q('SELECT id, category_name, parent_id, pid_list FROM prompt_menu WHERE parent_id = ? ORDER BY id', [l01.id]).slice(0, 6).forEach(r => {
  console.log('    id=' + r.id + ' ' + r.pid_list + ' ' + r.category_name);
});
console.log('');

console.log('--- pick an L2 (1.1 场景篇) and list its L3 children ---');
const l11 = q('SELECT id, category_name FROM prompt_menu WHERE category_name LIKE ?', ['1.1 %'])[0];
if (l11) {
  console.log('  ' + l11.category_name + ' id =', l11.id);
  q('SELECT id, category_name, parent_id, pid_list FROM prompt_menu WHERE parent_id = ? ORDER BY id', [l11.id]).slice(0, 8).forEach(r => {
    console.log('    id=' + r.id + ' ' + r.pid_list + ' ' + r.category_name);
  });
}
console.log('');

console.log('--- 11-瑕疵细节 L2 entries (note: source file has many) ---');
const l11m = q('SELECT id FROM prompt_menu WHERE category_name = ?', ['11-瑕疵细节'])[0];
console.log('  11-瑕疵细节 id =', l11m.id);
q('SELECT id, category_name, parent_id, pid_list FROM prompt_menu WHERE parent_id = ? ORDER BY id', [l11m.id]).slice(0, 20).forEach(r => {
  console.log('    id=' + r.id + ' ' + r.pid_list + ' ' + r.category_name);
});
console.log('');

console.log('--- L4 examples (4-deep pid_list) ---');
const fours = q(`SELECT id, category_name, parent_id, pid_list FROM prompt_menu
                 WHERE pid_list LIKE '/%/%/%/%/%' ORDER BY id LIMIT 8`);
console.log('  found:', fours.length);
fours.forEach(r => console.log('    id=' + r.id + ' ' + r.pid_list + ' ' + r.category_name));
