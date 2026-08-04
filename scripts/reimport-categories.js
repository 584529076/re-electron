/**
 * Re-import categories from markdown using dot-count rules:
 *  - 0 dots in prefix → L1 (root)
 *  - 1 dot          → L2 (child of L1 with same leading integer)
 *  - 2 dots         → L3 (child of L2 with first two segments)
 *  - 3 dots         → L4 (child of L3 with first three segments)
 *
 * Hierarchy is determined ONLY by the numeric prefix in the line, e.g.:
 *   "└── 0   00-范例"            prefix "0"           → L1
 *   "├── 0.1 校园题材专题"       prefix "0.1"         → L2 (parent "0")
 *   "├── 0.1.1 范例 C01"        prefix "0.1.1"       → L3 (parent "0.1")
 *   "├── 10.2.1.1 ..."          prefix "10.2.1.1"    → L4 (parent "10.2.1")
 *
 * The bracketed code like [01.002.001.000] is reference data and is ignored
 * for hierarchy (it can disagree with the prefix's first two digits, e.g. L2
 * "0.1" might carry bracket code "00.004.000.000").
 *
 * Source file is NEVER modified.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SRC = 'D:/nsfw-prompt-templates-asian解析文件/01-完整分类树-ASCII.md';
const DB = 'D:/re-electron/prompts/prompts.db';

// ---------- 1. Parse markdown to entries ----------
const md = fs.readFileSync(SRC, 'utf8');

// Extract each fenced code block as one module/tree.
const blocks = [];
const blockRe = /```\n([\s\S]*?)```/g;
let m;
while ((m = blockRe.exec(md)) !== null) {
  blocks.push(m[1]);
}
console.log(`source code blocks: ${blocks.length}`);

// Parse a line. The lines all look like (note leading whitespace + tree chars):
//   "└── 0 00-范例  [00.000.000.000]"
//   "    ├── 0.1 校园题材专题（12例）  [00.004.000.000]"
//   "    │   ├── 0.1.1 范例 C01...  [00.004.001.000]"
//   "    │   │   └── 0.1.1.1 ..."        (rare 4-level)
// We pull out the "└──"/"├──" marker, the prefix code, the name and the optional bracket code.
// Regex tolerates any indentation/whitespace before the tree marker.
const LINE_RE = /^[ \t│]*[├└]──[ \t]+(\d+(?:\.\d+)*)[ \t]+(.+?)(?:[ \t]+\[([0-9.]+)\])?[ \t]*$/;

const entries = [];
for (const block of blocks) {
  const lines = block.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const lm = LINE_RE.exec(line);
    if (!lm) continue; // skip non-tree lines (none expected, but be safe)
    const prefix = lm[1];
    const name = lm[2].trim();
    const bracket = lm[3] || null;
    const dots = (prefix.match(/\./g) || []).length;
    if (dots > 3) {
      console.warn(`skipping >3-dot line: "${line}"`);
      continue;
    }
    entries.push({
      prefix,
      name,
      bracket,
      level: dots, // 0=L1, 1=L2, 2=L3, 3=L4
    });
  }
}
console.log(`parsed entries: ${entries.length}`);

// ---------- 2. Count by level ----------
const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
entries.forEach(e => counts[e.level]++);
console.log(
  `levels — L1:${counts[0]} L2:${counts[1]} L3:${counts[2]} L4:${counts[3]}`,
);

// ---------- 3. Connect by prefix nesting ----------
// For each entry with prefix "A.B.C.D":
//   - L1:     parent = null (root)
//   - L2:     parent_prefix = first segment ("A")             → look up L1
//   - L3:     parent_prefix = first two segments ("A.B")       → look up L2
//   - L4:     parent_prefix = first three segments ("A.B.C")   → look up L3
function parentPrefixOf(prefix) {
  const segs = prefix.split('.');
  if (segs.length <= 1) return null;
  return segs.slice(0, -1).join('.');
}

// Build a map prefix → entry for quick parent lookup during tree construction.
// First pass: only structural map.
const prefixToEntry = new Map();
entries.forEach(e => prefixToEntry.set(e.prefix, e));

// ---------- 4. Open DB and clear prompt_menu ----------
const db = new Database(DB);
db.pragma('foreign_keys = OFF');
const tableInfo = db.prepare('PRAGMA table_info(prompt_menu)').all();
console.log(`prompt_menu columns: ${tableInfo.map(c => c.name).join(', ')}`);

const before = db.prepare('SELECT COUNT(*) as c FROM prompt_menu').get().c;
console.log(`rows before: ${before}`);

db.exec('DELETE FROM prompt_menu');
db.exec("DELETE FROM sqlite_sequence WHERE name='prompt_menu'");

// ---------- 5. Insert in dependency order: L1, L2, L3, L4 ----------
const insertStmt = db.prepare(`
  INSERT INTO prompt_menu
    (category_name, parent_id, description, pid_list, sort_order,
     is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group,
     created_at, updated_at)
  VALUES
    (@name, @parent_id, @description, @pid_list, @sort_order,
     0, 0, NULL, NULL, NULL,
     @now, @now)
`);

const now = new Date().toISOString();

// Insert L1 entries first (parents unknown for now; will be set later via id)
// Actually we insert level-by-level: each level needs ids from previous level(s).
// We need to insert parents before children. Since prefixToEntry maps prefix → entry,
// and parent of an entry is the prefix-with-last-segment-removed, we can compute
// the parent_id AFTER the parent has been inserted (which means we need to know
// the id we gave the parent). Solution: two-pass:
//   pass A: insert all entries with placeholder parent_id=NULL
//   pass B: walk again, look up the now-existing parent_id, UPDATE the row.
const placeholder = db.transaction(() => {
  let sortL1 = 0, sortL2 = 0, sortL3 = 0, sortL4 = 0;
  let lastL1Id = null, lastL2Id = null, lastL3Id = null;
  const sortCounters = { 0: 0, 1: 0, 2: 0, 3: 0 };

  // Important: prefix IDs come from DB autoincrement. To respect insertion order
  // matching the prefix-nested ordering, insert sorted by level-then-prefix.
  // Simpler: group by level and insert each group.
  const byLevel = { 0: [], 1: [], 2: [], 3: [] };
  entries.forEach(e => byLevel[e.level].push(e));

  // Sort each level by numeric prefix ordering so siblings follow source order.
  for (const lvl of [0, 1, 2, 3]) {
    byLevel[lvl].sort((a, b) => {
      const as = a.prefix.split('.').map(Number);
      const bs = b.prefix.split('.').map(Number);
      for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const av = as[i] ?? -1;
        const bv = bs[i] ?? -1;
        if (av !== bv) return av - bv;
      }
      return 0;
    });
  }

  // We need a way to remember each entry's rowid after insertion for parent_id.
  const prefixToId = new Map();

  for (const lvl of [0, 1, 2, 3]) {
    for (const e of byLevel[lvl]) {
      const sort_order = ++sortCounters[lvl];
      const info = insertStmt.run({
        name: e.name,
        parent_id: null,                    // patched in pass B
        description: e.bracket ? `[${e.bracket}]` : null,
        pid_list: null,                     // built in pass B
        sort_order,
        now,
      });
      prefixToId.set(e.prefix, Number(info.lastInsertRowid));
    }
  }

  // Pass B: fill in parent_id / pid_list
  const updateStmt = db.prepare(`
    UPDATE prompt_menu
       SET parent_id = @parent_id,
           pid_list  = @pid_list
     WHERE id = @id
  `);

  function buildPidList(parentId, newId, parentPid) {
    // For root: /<id>/
    if (!parentId) return `/${newId}/`;
    return `${parentPid}${newId}/`;
  }

  for (const e of entries) {
    const myId = prefixToId.get(e.prefix);
    const parentPrefix = parentPrefixOf(e.prefix);
    let parentId = null;
    let parentPid = null;
    if (parentPrefix) {
      parentId = prefixToId.get(parentPrefix) ?? null;
      const parentRow = parentId
        ? db.prepare('SELECT pid_list FROM prompt_menu WHERE id = ?').get(parentId)
        : null;
      parentPid = parentRow ? parentRow.pid_list : null;
    }
    const newPid = buildPidList(parentId, myId, parentPid);
    updateStmt.run({ id: myId, parent_id: parentId, pid_list: newPid });
  }

  return prefixToId;
});

const result = placeholder();
const byPrefixCount = new Map();
entries.forEach(e => byPrefixCount.set(e.prefix, result.get(e.prefix)));

// Sanity: print first few rows.
const sample = db.prepare(`
  SELECT id, category_name, parent_id, pid_list, sort_order, description
    FROM prompt_menu
   ORDER BY id
   LIMIT 12
`).all();
console.log('sample rows:');
sample.forEach(r =>
  console.log(
    `  id=${r.id} parent=${r.parent_id ?? 'NULL'} pid=${r.pid_list} sort=${r.sort_order} desc=${r.description} name=${r.category_name}`,
  ),
);

// Verify all parents resolved (no orphans).
const orphans = db
  .prepare(
    `SELECT id, category_name, parent_id
       FROM prompt_menu
      WHERE parent_id IS NOT NULL
        AND parent_id NOT IN (SELECT id FROM prompt_menu)`,
  )
  .all();
console.log(`orphan rows: ${orphans.length}`);

// Print level distribution in DB.
const lvlRows = db
  .prepare(
    `SELECT
       (LENGTH(pid_list) - LENGTH(REPLACE(pid_list, '/', ''))) - 2 AS depth,
       COUNT(*) AS cnt
       FROM prompt_menu
      GROUP BY depth
      ORDER BY depth`,
  )
  .all();
console.log('DB depth distribution:');
lvlRows.forEach(r => console.log(`  depth=${r.depth} count=${r.cnt}`));

console.log('done.');
db.close();
