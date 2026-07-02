// test-perf.js —— 性能基准：模拟 N=200 / N=500 分类时的几个热点函数
// 对比修复前 vs 修复后的耗时
// 跑法：$env:ELECTRON_RUN_AS_NODE=1; electron test-perf.js

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { KVDb } = require('./db');

const DB_PATH = path.join(os.tmpdir(), 're-electron-perf.db');
try { fs.unlinkSync(DB_PATH); } catch {}
try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}

const store = new KVDb(DB_PATH);
// 模拟 prompt_menu schema
store._db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_name TEXT NOT NULL,
    parent_id INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    pid_list TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_required INTEGER DEFAULT 0
  );
`);

function makeTree(n) {
  // 模拟 n 个分类：1 个根 + n-1 个平铺 L2（简化，不做深层）
  store.exec('DELETE FROM prompt_menu');
  store.exec("DELETE FROM sqlite_sequence WHERE name='prompt_menu'");
  // 根
  store.exec("INSERT INTO prompt_menu (category_name, parent_id, pid_list, sort_order) VALUES ('ROOT', 0, '/1/', 1)");
  for (let i = 2; i <= n; i++) {
    store.exec('INSERT INTO prompt_menu (category_name, parent_id, pid_list, sort_order) VALUES (?, 1, ?, ?)',
      `cat-${i}`, `/1/${i}/`, i);
  }
  return store.query('SELECT id, category_name, parent_id, pid_list FROM prompt_menu');
}

// ============ 1) 测 main.js rebuildAllPidLists 的旧实现 ============
function rebuildAllPidLists_OLD(all) {
  function getNode(id) { return all.find(x => x.id === id); }  // ← O(n)
  const cache = {};
  function calc(id, stack) {
    if (cache[id]) return cache[id];
    if (stack.has(id)) return '/';
    stack.add(id);
    const node = getNode(id);
    if (!node) return '/';
    const parent = node.parent_id || 0;
    const parentPath = parent === 0 ? '/' : calc(parent, stack);
    const pl = parentPath + id + '/';
    cache[id] = pl;
    return pl;
  }
  const out = [];
  for (const r of all) {
    out.push({ id: r.id, pl: calc(r.id, new Set()) });
  }
  return out;
}

// ============ 2) 测 main.js rebuildAllPidLists 的新实现（Map）============
function rebuildAllPidLists_NEW(all) {
  const byId = new Map(all.map(x => [x.id, x]));  // ← O(1)
  const cache = {};
  function calc(id, stack) {
    if (cache[id]) return cache[id];
    if (stack.has(id)) return '/';
    stack.add(id);
    const node = byId.get(id);
    if (!node) return '/';
    const parent = node.parent_id || 0;
    const parentPath = parent === 0 ? '/' : calc(parent, stack);
    const pl = parentPath + id + '/';
    cache[id] = pl;
    return pl;
  }
  const out = [];
  for (const r of all) {
    out.push({ id: r.id, pl: calc(r.id, new Set()) });
  }
  return out;
}

// ============ 3) 测 prompt-gen.js loadMenuTree 的旧实现 ============
function buildChildren_OLD(tree) {
  const _l1Children = {};
  const _l3Children = {};
  for (const n of tree) {
    const p = n.parent_id || 0;
    if (p === 0) continue;
    const parent = tree.find(x => x.id === p);  // ← O(n)
    if (parent && (!parent.parent_id || parent.parent_id === 0)) {
      (_l1Children[p] = _l1Children[p] || []).push(n);
    } else {
      (_l3Children[p] = _l3Children[p] || []).push(n);
    }
  }
  return { _l1Children, _l3Children };
}

// ============ 4) 测 prompt-gen.js loadMenuTree 的新实现（Map）============
function buildChildren_NEW(tree) {
  const _l1Children = {};
  const _l3Children = {};
  const byId = new Map(tree.map(x => [x.id, x]));  // ← O(1)
  for (const n of tree) {
    const p = n.parent_id || 0;
    if (p === 0) continue;
    const parent = byId.get(p);
    if (parent && (!parent.parent_id || parent.parent_id === 0)) {
      (_l1Children[p] = _l1Children[p] || []).push(n);
    } else {
      (_l3Children[p] = _l3Children[p] || []).push(n);
    }
  }
  return { _l1Children, _l3Children };
}

// ============ 5) 测 nsfw-assembler.js mustHave 循环里的 O(n²) ============
function pickOld(pool, chosen, num, rand) {
  // pool.filter(p => !chosen.includes(p))  ← O(chosen × pool)
  const picked = [];
  for (let i = 0; i < num; i++) {
    const available = pool.filter(p => !chosen.includes(p));
    if (!available.length) break;
    picked.push(available[Math.floor(rand() * available.length)]);
    chosen.push(picked[picked.length - 1]);
  }
  return picked;
}

function pickNew(pool, chosen, num, rand) {
  // pool.filter(p => !chosenSet.has(p.id))  ← O(pool)
  const chosenSet = new Set(chosen.map(x => x.id));
  const picked = [];
  for (let i = 0; i < num; i++) {
    const available = pool.filter(p => !chosenSet.has(p.id));
    if (!available.length) break;
    const p = available[Math.floor(rand() * available.length)];
    picked.push(p);
    chosenSet.add(p.id);
  }
  return picked;
}

// ============== 跑 benchmark ==============
function bench(label, fn, n) {
  const t0 = Date.now();
  fn();
  const ms = Date.now() - t0;
  console.log(`  ${label}: ${ms}ms`);
  return ms;
}

console.log('=== Perf benchmark ===\n');
for (const n of [500, 2000, 5000, 10000]) {
  console.log(`N = ${n}:`);
  const tree = makeTree(n);
  // 跑 100 次取平均
  const ITER = 100;
  function avgMs(fn) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) fn();
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6 / ITER;
  }
  console.log(`  rebuildAllPidLists_OLD: ${avgMs(() => rebuildAllPidLists_OLD(tree)).toFixed(3)}ms / iter`);
  console.log(`  rebuildAllPidLists_NEW: ${avgMs(() => rebuildAllPidLists_NEW(tree)).toFixed(3)}ms / iter`);
  console.log(`  buildChildren_OLD:      ${avgMs(() => buildChildren_OLD(tree)).toFixed(3)}ms / iter`);
  console.log(`  buildChildren_NEW:      ${avgMs(() => buildChildren_NEW(tree)).toFixed(3)}ms / iter`);
  console.log();
}

console.log('=== nsfw-assembler pick benchmark (per call avg over 100 runs) ===');
for (const [poolN, numPick] of [[500, 5], [2000, 8], [5000, 10]]) {
  const pool = Array.from({ length: poolN }, (_, i) => ({ id: i, name: 'tag-' + i, weight: 0.5 }));
  const ITER = 100;
  function avgMs(fn) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) fn();
    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6 / ITER;
  }
  console.log(`  pool=${poolN}, pick=${numPick}:`);
  console.log(`    pickOld (includes): ${avgMs(() => pickOld(pool, [], numPick, Math.random)).toFixed(3)}ms / iter`);
  console.log(`    pickNew (Set):      ${avgMs(() => pickNew(pool, [], numPick, Math.random)).toFixed(3)}ms / iter`);
  console.log();
}

console.log('Done');
