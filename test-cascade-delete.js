// test-cascade-delete.js —— 验证 prompt:menu:delete 级联删除分类 + 提示词
// D-33: 删除一个分类 → 该分类下 + 所有子分类 + 提示词都删
// 跑法：node --test --test-force-exit test-cascade-delete.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { test } = require('node:test');
const Database = require('better-sqlite3');

// ============== 准备：临时 sqlite + 直接 import main.js 的 delete 逻辑 ==============
// 不用起 Electron，直接拿 db.js + 复刻 delete 的 SQL（main.js 里 delete 是同步 SQL，
// 不依赖 Electron 自身，方便纯 Node 测）

const { KVDb } = require('./db');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 're-electron-cascade-'));
const DB_PATH = path.join(TMP_DIR, 'test.db');
let store = new KVDb(DB_PATH);

// 初始化 prompt_menu + prompt_items schema（跟 main.js 一致）
// 注意：KVDb.exec 走 db.prepare().run()，不支持 DEFAULT (strftime(...)) 这种带括号的复杂表达式
// 改走 native better-sqlite3 db.exec()，它支持多语句 + 复杂 DEFAULT
function ensureTables() {
  store._db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_menu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_name TEXT NOT NULL,
      parent_id INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      pid_list TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_required INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_menu_parent ON prompt_menu(parent_id);
    CREATE INDEX IF NOT EXISTS idx_prompt_menu_pidlist ON prompt_menu(pid_list);
    CREATE TABLE IF NOT EXISTS prompt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      content TEXT DEFAULT '',
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      sensitivity TEXT DEFAULT 'nsfw',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_items_cat ON prompt_items(category_id);
  `);
}
// 复刻 main.js 的 buildPidList
function buildPidList(parentId, newId) {
  let prefix;
  if (!parentId || parentId === 0) {
    prefix = '/';
  } else {
    const row = store.query('SELECT pid_list FROM prompt_menu WHERE id = ?', parentId);
    if (!row.length) return '/';
    prefix = row[0].pid_list || '/';
    if (!prefix.endsWith('/')) prefix += '/';
  }
  return prefix + newId + '/';
}
// 复刻 main.js 的 menu:add
function addCategory(name, parentId = 0) {
  const sortOrder = (store.query('SELECT MAX(sort_order) AS m FROM prompt_menu WHERE parent_id = ?', parentId)[0] || { m: 0 }).m + 1;
  const r = store.exec(
    'INSERT INTO prompt_menu (category_name, parent_id, description, pid_list, sort_order, is_required) VALUES (?, ?, ?, ?, ?, ?)',
    name, parentId, '', '', sortOrder, 0
  );
  const newId = r.lastInsertRowid;
  const pidList = buildPidList(parentId, newId);
  store.exec('UPDATE prompt_menu SET pid_list = ? WHERE id = ?', pidList, newId);
  return newId;
}
// 复刻 item:add
function addItem(name, catId, content = '') {
  return store.exec(
    'INSERT INTO prompt_items (category_id, name, content, description, sort_order, sensitivity) VALUES (?, ?, ?, ?, ?, ?)',
    catId, name, content, '', 0, 'nsfw'
  ).lastInsertRowid;
}
// 复刻 main.js 的 menu:delete（修后版本）
function deleteCategory(id) {
  const nid = Number(id);
  if (!nid) return { ok: false, error: 'id 必填' };
  const cur = store.query('SELECT pid_list FROM prompt_menu WHERE id = ?', nid);
  if (!cur.length) return { ok: false, error: `分类 id=${nid} 不存在` };
  const pid = cur[0].pid_list || '/';
  const catRows = store.query('SELECT id FROM prompt_menu WHERE id = ? OR pid_list LIKE ?', nid, pid + '%');
  const catIds = catRows.map(r => r.id);
  const r = store.transaction(() => {
    if (catIds.length) {
      const placeholders = catIds.map(() => '?').join(',');
      store.exec('DELETE FROM prompt_items WHERE category_id IN (' + placeholders + ')', ...catIds);
    }
    return store.exec('DELETE FROM prompt_menu WHERE id = ? OR pid_list LIKE ?', nid, pid + '%');
  });
  return { ok: true, deleted: r.changes, catsDeleted: catIds.length };
}

// ============== 测试 ==============

test('前置：建一棵 3 层分类树 + 提示词', () => {
  ensureTables();
  // 树：
  //   人物(1)──亚洲人(3)──校园(5)
  //        └──欧美人(4)
  //   场景(2)──街道(6)
  const c1 = addCategory('人物');          // id=1
  const c2 = addCategory('场景');          // id=2
  const c3 = addCategory('亚洲人', c1);    // id=3
  const c4 = addCategory('欧美人', c1);    // id=4
  const c5 = addCategory('校园', c3);      // id=5
  const c6 = addCategory('街道', c2);      // id=6
  // 提示词：每个分类都加 1-2 个
  addItem('柔光', c1, 'soft light');                  // 人物下
  addItem('大眼睛', c1, 'big eyes');                   // 人物下
  addItem('日本校园', c5, 'japanese school uniform'); // 校园下
  addItem('学生妹', c5, 'schoolgirl');                 // 校园下
  addItem('咖啡馆', c6, 'cafe');                       // 街道下
  // 验证数据库初始状态
  assert.strictEqual(store.query('SELECT COUNT(*) AS c FROM prompt_menu')[0].c, 6, '应有 6 个分类');
  assert.strictEqual(store.query('SELECT COUNT(*) AS c FROM prompt_items')[0].c, 5, '应有 5 个提示词');
});

// 改写成：每个 test 内部自己 setup/teardown
test('D-33-1：删 L1「人物」级联删 4 分类 + 4 提示词', () => {
  // 重置 DB
  store = new KVDb(DB_PATH);  // 重连（schema 已建好）
  // 清空数据
  store.exec('DELETE FROM prompt_items');
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name IN ('prompt_menu','prompt_items')");

  // 重新建树
  const c1 = addCategory('人物');
  const c2 = addCategory('场景');
  const c3 = addCategory('亚洲人', c1);
  const c4 = addCategory('欧美人', c1);
  const c5 = addCategory('校园', c3);
  const c6 = addCategory('街道', c2);
  addItem('柔光', c1, 'soft light');
  addItem('大眼睛', c1, 'big eyes');
  addItem('日本校园', c5, 'japanese school uniform');
  addItem('学生妹', c5, 'schoolgirl');
  addItem('咖啡馆', c6, 'cafe');

  // 删「人物」
  const r = deleteCategory(c1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.catsDeleted, 4, '应删 4 个分类（人物+亚洲人+欧美人+校园）');

  // 验证：菜单只剩「场景」和「街道」
  const remaining = store.query('SELECT category_name FROM prompt_menu ORDER BY id').map(x => x.category_name);
  assert.deepStrictEqual(remaining, ['场景', '街道'], '应只剩 场景/街道');

  // 验证：提示词只剩「咖啡馆」(挂在 街道 下)
  const items = store.query('SELECT name FROM prompt_items ORDER BY id').map(x => x.name);
  assert.deepStrictEqual(items, ['咖啡馆'], '应只剩挂在 街道 下的「咖啡馆」');
});

test('D-33-2：删 L2「亚洲人」级联删自己 + 校园 2 分类 + 2 提示词（不影响人物/欧美人）', () => {
  // 重置
  store = new KVDb(DB_PATH);
  store.exec('DELETE FROM prompt_items');
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name IN ('prompt_menu','prompt_items')");

  const c1 = addCategory('人物');
  const c2 = addCategory('场景');
  const c3 = addCategory('亚洲人', c1);
  const c4 = addCategory('欧美人', c1);
  const c5 = addCategory('校园', c3);
  const c6 = addCategory('街道', c2);
  addItem('柔光', c1, 'soft light');
  addItem('大眼睛', c1, 'big eyes');
  addItem('日本校园', c5, 'japanese school uniform');
  addItem('学生妹', c5, 'schoolgirl');
  addItem('咖啡馆', c6, 'cafe');

  // 删「亚洲人」(L2)
  const r = deleteCategory(c3);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.catsDeleted, 2, '应删 2 个分类（亚洲人+校园）');

  // 验证菜单：人物/场景/欧美人/街道（id 顺序：1, 2, 4, 6）
  const remaining = store.query('SELECT category_name FROM prompt_menu ORDER BY id').map(x => x.category_name);
  assert.deepStrictEqual(remaining, ['人物', '场景', '欧美人', '街道']);

  // 验证提示词：人物下的「柔光/大眼睛」+ 街道下的「咖啡馆」（删了校园下的日本校园/学生妹）
  const items = store.query('SELECT name FROM prompt_items ORDER BY id').map(x => x.name);
  assert.deepStrictEqual(items, ['柔光', '大眼睛', '咖啡馆']);
});

test('D-33-3：删 L3「校园」只删自己 + 2 提示词（不影响父级）', () => {
  store = new KVDb(DB_PATH);
  store.exec('DELETE FROM prompt_items');
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name IN ('prompt_menu','prompt_items')");

  const c1 = addCategory('人物');
  const c2 = addCategory('场景');
  const c3 = addCategory('亚洲人', c1);
  const c4 = addCategory('欧美人', c1);
  const c5 = addCategory('校园', c3);
  const c6 = addCategory('街道', c2);
  addItem('柔光', c1, 'soft light');
  addItem('大眼睛', c1, 'big eyes');
  addItem('日本校园', c5, 'japanese school uniform');
  addItem('学生妹', c5, 'schoolgirl');
  addItem('咖啡馆', c6, 'cafe');

  // 删「校园」(L3)
  const r = deleteCategory(c5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.catsDeleted, 1, '应只删 1 个分类');

  const items = store.query('SELECT name FROM prompt_items ORDER BY id').map(x => x.name);
  assert.deepStrictEqual(items, ['柔光', '大眼睛', '咖啡馆'], '校园下的 2 个提示词被删');
});

test('D-33-4：删没提示词的分类 → 也不报错', () => {
  store = new KVDb(DB_PATH);
  store.exec('DELETE FROM prompt_items');
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name IN ('prompt_menu','prompt_items')");

  const c1 = addCategory('空分类');
  const c2 = addCategory('另一个');
  // c1 下没提示词
  const r = deleteCategory(c1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.catsDeleted, 1);
  const remaining = store.query('SELECT category_name FROM prompt_menu').map(x => x.category_name);
  assert.deepStrictEqual(remaining, ['另一个']);
});

test('D-33-5：删不存在的 id → 报错', () => {
  const r = deleteCategory(9999);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不存在/);
});

test('D-33-6：删 id=0 / null → 报错', () => {
  assert.strictEqual(deleteCategory(0).ok, false);
  assert.strictEqual(deleteCategory(null).ok, false);
});

test('D-33-7：原子性 — 中间 SQL 失败时全部回滚（模拟）', () => {
  // 模拟 transaction 失败：用 monkey-patch 拦截第二条 SQL 让它抛错
  store = new KVDb(DB_PATH);
  store.exec('DELETE FROM prompt_items');
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name IN ('prompt_menu','prompt_items')");

  const c1 = addCategory('人物');
  addItem('A', c1);
  addItem('B', c1);

  // 数一下当前有几行
  const beforeMenus = store.query('SELECT COUNT(*) AS c FROM prompt_menu')[0].c;
  const beforeItems = store.query('SELECT COUNT(*) AS c FROM prompt_items')[0].c;
  assert.strictEqual(beforeMenus, 1);
  assert.strictEqual(beforeItems, 2);

  // 拦截 prompt_items DELETE，让它抛错
  const realExec = store.exec.bind(store);
  store.exec = (sql, ...params) => {
    if (sql.includes('DELETE FROM prompt_items')) {
      throw new Error('模拟删除提示词失败');
    }
    return realExec(sql, ...params);
  };

  let threw = false;
  try {
    deleteCategory(c1);
  } catch (e) {
    threw = true;
    assert.match(e.message, /模拟删除提示词失败/);
  }
  assert.strictEqual(threw, true, '应抛错');
  store.exec = realExec;  // 还原

  // 验证：数据完全没变（事务回滚）
  const afterMenus = store.query('SELECT COUNT(*) AS c FROM prompt_menu')[0].c;
  const afterItems = store.query('SELECT COUNT(*) AS c FROM prompt_items')[0].c;
  assert.strictEqual(afterMenus, 1, '菜单应回滚（人物仍在）');
  assert.strictEqual(afterItems, 2, '提示词应回滚（A/B 都在）');
});
