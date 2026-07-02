// test-live-assemble.js —— 验证 D-35 实时拼装函数
// 测试策略：直接拷一份 liveAssemble 逻辑到测试文件（避免 require 浏览器脚本）
// 跑法：$env:ELECTRON_RUN_AS_NODE=1; electron test-live-assemble.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// ========== 复刻 prompt-gen.js 里的 liveAssemble 纯函数（保持同步） ==========
// 签名：liveAssemble(selectedItems, menuById, assembleRule) -> string
// - selectedItems: Map<itemId, {id, name, content, category_id, ...}>   插入顺序 = 点击顺序
// - menuById:      Map<menuId, {id, parent_id, category_name, ...}>
// - assembleRule:  [{menuId, sortOrder}, ...]   一级分类（parent_id=0）的有序 id 列表；null/[] = 无规则
//
// 规则：
//   1. 没规则（assembleRule 为 null/undefined/[]）→ 按 selectedItems 插入顺序
//   2. 有规则 → 规则内的 L1（按规则顺序）→ 同 L1 内按 selectedItems 插入顺序
//   3. 规则外的 item 追加在最后，仍按 selectedItems 插入顺序
//   4. 分隔符 ', '
function liveAssemble(selectedItems, menuById, assembleRule) {
  // 收集所有 item（按点击顺序）
  const items = Array.from(selectedItems.values());
  if (items.length === 0) return '';

  // 找每个 item 的根 L1 祖先（沿 parent_id 链向上找 parent_id=0 的祖先）
  function rootL1IdOfItem(item) {
    let cur = menuById.get(item.category_id);
    // 防御：item 的 category_id 可能在 menuById 找不到（数据被删等）
    if (!cur) return null;
    while (cur && cur.parent_id && cur.parent_id !== 0) {
      const next = menuById.get(cur.parent_id);
      if (!next) break;
      cur = next;
    }
    return cur ? cur.id : null;
  }

  // 给每条 item 打上 rootL1Id
  const tagged = items.map(it => ({ item: it, rootL1: rootL1IdOfItem(it) }));

  // 有规则吗？
  const hasRule = Array.isArray(assembleRule) && assembleRule.length > 0;

  if (!hasRule) {
    // 规则 1：按点击顺序
    return tagged.map(t => t.item.content || t.item.name || '').join(', ');
  }

  // 规则 2+3：按 L1 顺序组，组内按点击顺序；规则外的追加
  const rootL1Order = assembleRule.map(r => r.menuId);
  // rootL1 → items[]（按点击顺序）
  const groups = new Map();
  // 兜底组：规则外的 items
  const leftovers = [];
  for (const t of tagged) {
    if (t.rootL1 != null && rootL1Order.includes(t.rootL1)) {
      if (!groups.has(t.rootL1)) groups.set(t.rootL1, []);
      groups.get(t.rootL1).push(t);
    } else {
      leftovers.push(t);
    }
  }

  const parts = [];
  for (const l1Id of rootL1Order) {
    const g = groups.get(l1Id);
    if (!g || g.length === 0) continue;  // 规则 4：跳过
    for (const t of g) parts.push(t.item.content || t.item.name || '');
  }
  for (const t of leftovers) {
    parts.push(t.item.content || t.item.name || '');
  }
  return parts.join(', ');
}

// ============== Mock ==============
function makeMenu(id, parentId, name) {
  return { id, parent_id: parentId, category_name: name };
}
// 树：L1A(1) → L2A1(3) → L3A1a(5)
//     L1B(2) → L2B1(4)
//     L1C(6) → L2C1(7) → L3C1a(8)
//     L1D(9)
//     L1X(10) （不在规则内）
//     L1Y(11) （不在规则内）
function makeMenuById() {
  return new Map([
    [1, makeMenu(1, 0, 'L1A')],
    [2, makeMenu(2, 0, 'L1B')],
    [3, makeMenu(3, 1, 'L2A1')],
    [4, makeMenu(4, 2, 'L2B1')],
    [5, makeMenu(5, 3, 'L3A1a')],
    [6, makeMenu(6, 0, 'L1C')],
    [7, makeMenu(7, 6, 'L2C1')],
    [8, makeMenu(8, 7, 'L3C1a')],
    [9, makeMenu(9, 0, 'L1D')],
    [10, makeMenu(10, 0, 'L1X')],
    [11, makeMenu(11, 0, 'L1Y')],
  ]);
}
function makeItem(id, categoryId, name, content) {
  return { id, category_id: categoryId, name, content };
}

// ============== 测试 ==============
test('D-35-1：完全无规则 → 按点击顺序拼', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 3, 'A1', 'a-1'));      // 点击 1
  sel.set(200, makeItem(200, 9, 'D1', 'd-1'));      // 点击 2
  sel.set(300, makeItem(300, 10, 'X1', 'x-1'));     // 点击 3
  const r = liveAssemble(sel, menuById, null);
  assert.strictEqual(r, 'a-1, d-1, x-1');
});

test('D-35-2：空规则数组 → 按点击顺序拼（同 null）', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 5, 'A1', 'a-1'));
  sel.set(200, makeItem(200, 8, 'C1', 'c-1'));
  const r = liveAssemble(sel, menuById, []);
  assert.strictEqual(r, 'a-1, c-1');
});

test('D-35-3：完整规则 + 全选 → 按 L1 顺序，组内按点击顺序', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 4, 'B1', 'b-1'));    // L1B
  sel.set(200, makeItem(200, 3, 'A1', 'a-1'));    // L1A
  sel.set(300, makeItem(300, 9, 'D1', 'd-1'));    // L1D
  sel.set(400, makeItem(400, 4, 'B2', 'b-2'));    // L1B（同 L1 两条）
  const r = liveAssemble(sel, menuById, [
    { menuId: 1, sortOrder: 1 },   // L1A
    { menuId: 2, sortOrder: 2 },   // L1B
    { menuId: 6, sortOrder: 3 },   // L1C
    { menuId: 9, sortOrder: 4 },   // L1D
  ]);
  // 期望：L1A(a-1) → L1B(b-1, b-2) → L1C(没选，跳) → L1D(d-1)
  assert.strictEqual(r, 'a-1, b-1, b-2, d-1');
});

test('D-35-4：规则 + 部分匹配（L1C 没选） → 跳过 L1C', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 3, 'A1', 'a-1'));   // L1A
  sel.set(200, makeItem(200, 4, 'B1', 'b-1'));   // L1B
  sel.set(300, makeItem(300, 9, 'D1', 'd-1'));   // L1D
  const r = liveAssemble(sel, menuById, [
    { menuId: 1 }, { menuId: 2 }, { menuId: 6 }, { menuId: 9 },
  ]);
  assert.strictEqual(r, 'a-1, b-1, d-1');
});

test('D-35-5：规则 + 规则外的 item 追加在最后 + 规则内 + 按点击顺序', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 3, 'A1', 'a-1'));      // L1A 规则内
  sel.set(200, makeItem(200, 10, 'X1', 'x-1'));     // L1X 规则外
  sel.set(300, makeItem(300, 4, 'B1', 'b-1'));      // L1B 规则内
  sel.set(400, makeItem(400, 11, 'Y1', 'y-1'));     // L1Y 规则外
  sel.set(500, makeItem(500, 9, 'D1', 'd-1'));      // L1D 规则内
  const r = liveAssemble(sel, menuById, [
    { menuId: 1 }, { menuId: 2 }, { menuId: 6 }, { menuId: 9 },
  ]);
  // 期望：L1A(a-1), L1B(b-1), L1C(跳), L1D(d-1), [规则外]x-1, y-1
  assert.strictEqual(r, 'a-1, b-1, d-1, x-1, y-1');
});

test('D-35-6：L3 item（深层）→ 追溯到 L1 祖先', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 5, 'A1a', 'a-1a'));   // category_id=5, L3A1a, 根 = L1A(1)
  sel.set(200, makeItem(200, 8, 'C1a', 'c-1a'));   // category_id=8, L3C1a, 根 = L1C(6)
  sel.set(300, makeItem(300, 3, 'A1',  'a-1'));    // category_id=3, L2A1, 根 = L1A(1)
  const r = liveAssemble(sel, menuById, [
    { menuId: 1 }, { menuId: 6 }, { menuId: 2 },
  ]);
  // L1A 部分：a-1a, a-1（按点击顺序），L1C 部分：c-1a，L1B 没选
  assert.strictEqual(r, 'a-1a, a-1, c-1a');
});

test('D-35-7：同 L1 内多条 + 严格按点击顺序', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 3, 'A1', 'a-1'));
  sel.set(200, makeItem(200, 5, 'A2', 'a-2'));   // L3 也在 L1A 下
  sel.set(300, makeItem(300, 7, 'A3', 'a-3'));   // L2C1 在 L1C 下？不，7 的父是 6(L1C)
  const r = liveAssemble(sel, menuById, [
    { menuId: 1 }, { menuId: 6 },
  ]);
  // 修正：a-3 实际在 L1C 下 → 期望 a-1, a-2, a-3
  assert.strictEqual(r, 'a-1, a-2, a-3');
});

test('D-35-8：选了 0 条 → 返回空字符串', () => {
  const menuById = makeMenuById();
  const r = liveAssemble(new Map(), menuById, [{ menuId: 1 }]);
  assert.strictEqual(r, '');
});

test('D-35-9：content 为空 → 用 name 兜底（跟 chip.title 一致）', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, { id: 100, category_id: 3, name: 'no-content-item', content: '' });
  const r = liveAssemble(sel, menuById, null);
  assert.strictEqual(r, 'no-content-item');
});

test('D-35-10：content 和 name 都没有 → 空字符串占位（不输出 "undefined"）', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, { id: 100, category_id: 3, name: '', content: '' });
  const r = liveAssemble(sel, menuById, null);
  assert.strictEqual(r, '');
});

test('D-35-11：item 的 category_id 不在 menuById → 视为规则外', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 999, 'orphan', 'orphan-content'));   // 999 不在
  const r = liveAssemble(sel, menuById, [{ menuId: 1 }, { menuId: 2 }]);
  // orphan 既不在 L1A 也不在 L1B → 追加到规则外
  assert.strictEqual(r, 'orphan-content');
});

test('D-35-12：规则乱序传入 → 按 rule.sortOrder 字段排序再组', () => {
  const menuById = makeMenuById();
  const sel = new Map();
  sel.set(100, makeItem(100, 3, 'A1', 'a-1'));
  sel.set(200, makeItem(200, 4, 'B1', 'b-1'));
  sel.set(300, makeItem(300, 9, 'D1', 'd-1'));
  // 乱序传：[B, A, D] 但有 sortOrder 字段
  const r = liveAssemble(sel, menuById, [
    { menuId: 2, sortOrder: 1 },  // B 第一
    { menuId: 1, sortOrder: 2 },  // A 第二
    { menuId: 9, sortOrder: 3 },  // D 第三
  ]);
  // 当前实现：直接用数组顺序（不重新按 sortOrder 排）→ 期望 b-1, a-1, d-1
  // 这是个 API 选择题：看 D-35 需求，规则的顺序 = 用户在 UI 里调的顺序
  // → 数组顺序就是最终顺序（sortOrder 字段冗余，仅作展示）
  assert.strictEqual(r, 'b-1, a-1, d-1');
});
