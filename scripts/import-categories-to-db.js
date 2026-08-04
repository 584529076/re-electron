// scripts/import-categories-to-db.js
// 从 01-完整分类树-ASCII.md 解析 L1/L2/L3/L4 层级，并导入到 prompt_menu 表
// 严格保留层级关系（按 │ └── ├── 树形符号识别）
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MD_PATH = 'D:\\nsfw-prompt-templates-asian解析文件\\01-完整分类树-ASCII.md';
const DB_PATH = 'D:\\re-electron\\prompts\\prompts.db';

function main() {
    console.log('▶ import-categories-to-db');
    const md = fs.readFileSync(MD_PATH, 'utf8');
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    // 1) 解析 markdown 中的 ``` 树形代码块
    // 每块：└── 0 00-范例  [00.000.000.000]
    //       ├── 0.1 ...  [00.004.000.000]
    //       │   ├── 0.1.1 ...  [00.004.001.000]
    const codeBlocks = [];
    const blockRe = /```\n([\s\S]*?)\n```/g;
    let m;
    while ((m = blockRe.exec(md)) !== null) {
        codeBlocks.push(m[1]);
    }
    console.log('  找到代码块数:', codeBlocks.length);

    // 2) 解析每行得到 (level, label, code)
    // 行的格式：
    //   └── 0 00-范例  [00.000.000.000]
    //   │   ├── 0.1.1 ...  [00.004.001.000]
    // 先去掉前导 ├── └── │ 字符，再数 leading 空格段（4 空格 = 1 级）
    // 简化：扫描每一行
    const nodes = [];
    for (const block of codeBlocks) {
        for (const rawLine of block.split('\n')) {
            if (!rawLine.trim()) continue;
            // 找 │ 字符位置确定深度
            // 计算前导符号：可能含 ├──  └──  │   │
            // 算法：先剥掉 ├──  └──  → level 0；剥掉每对 "│   " → level +1
            let s = rawLine;
            let level = 0;

            // 1) 顶层一定是 ├── 或 └──（无 │ 前缀），level 起始 0
            //    子项可能是 "    ├── ..." 或 "    │   ├── ..." 之类
            //
            // 实际规律：
            //   └── 0 00-范例                  ← level 0
            //       ├── 0.1 校园...            ← level 1（首部 4 空格）
            //       │   ├── 0.1.1 范例 C01    ← level 2（4 空格 + 1 个 │   ）
            //       │   │   ├── 0.1.1.1 ...   ← level 3（4 空格 + 2 个 │   ）
            //
            // 算法：数 │   出现次数 = level - 1，首部 4 空格 = level 1 标志
            // 即 level = (│   出现次数) + (首部 4 空格 ? 1 : 0)
            s = s.replace(/[│|]/g, '|');
            // 移除 └──  ├──  └  ├
            s = s.replace(/[└├]──/g, 'X');
            s = s.replace(/[└├]/g, 'X');
            // 计算 level
            const startsWithIndent = /^\s{4}/.test(s);
            const pipeMatches = s.match(/\|/g) || [];
            level = pipeMatches.length + (startsWithIndent ? 1 : 0);

            // 提取名称和 code
            // 格式：X 0 00-范例  [00.000.000.000]
            //       X 0.1 校园题材专题（12例）  [00.004.000.000]
            // 剥掉到 X 之前的所有前导（空格 + 可能的 │   × N）
            const afterX = s.replace(/^\s*(?:\|[^X]*?)*X\s*/, '').trim();
            // 解析 [code]
            const codeMatch = afterX.match(/\[(\d{2}\.\d{3}\.\d{3}\.\d{3})\]/);
            if (!codeMatch) continue;
            const code = codeMatch[1];
            // 名称 = code 之前的内容
            const name = afterX.slice(0, codeMatch.index).trim();
            // 名称格式：'0 00-范例' 或 '0.1 校园题材专题' 或 '0.1.1 范例 C01：...'
            // 提取纯名称（去掉前导编号）
            const cleanName = name.replace(/^\d+(\.\d+)*\s+/, '').trim();
            if (!cleanName) continue;
            nodes.push({ level, code, name: cleanName, raw: name });
        }
    }

    console.log('  解析节点数:', nodes.length);

    // 3) 验证：每个节点的 level 都比上一个 <=level 大
    let lastLevel = -1;
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].level > lastLevel + 1) {
            console.log('  !! level gap at #' + i + ': prev=' + lastLevel + ' curr=' + nodes[i].level + ' (' + nodes[i].code + ' ' + nodes[i].name + ')');
        }
        lastLevel = nodes[i].level;
    }

    // 4) 排序：保持 markdown 中出现的顺序
    // 5) 用栈建立父子关系
    //    stack[k] = { code, name, level }
    //    当遇到 level == stack.length 时 push
    //    当遇到 level < stack.length 时 pop 到 level
    const stack = [];
    const tree = [];   // 树形 [{node, children: []}, ...]
    const idMap = new Map();   // code -> db id
    let sortOrder = 0;

    // 先用栈建立完整树（不分配 id）
    const rootStack = [];
    const rootTree = [];
    for (const n of nodes) {
        // pop 直到栈深度 = level
        while (rootStack.length > n.level) rootStack.pop();
        if (rootStack.length === n.level) {
            // push 当前
            const entry = { node: n, children: [] };
            if (rootStack.length === 0) {
                rootTree.push(entry);
            } else {
                rootStack[rootStack.length - 1].children.push(entry);
            }
            rootStack.push(entry);
        }
    }

    // 6) 递归插入到 db
    const insStmt = db.prepare(`
        INSERT INTO prompt_menu (category_name, parent_id, description, pid_list, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updStmt = db.prepare('UPDATE prompt_menu SET pid_list = ? WHERE id = ?');

    let count = 0;
    function insertTree(entries, parentId, parentPidList) {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const n = entry.node;
            const r = insStmt.run(n.name, parentId, '', '', i, 0, '', '', '', '');
            const newId = Number(r.lastInsertRowid);
            const pidList = parentPidList + newId + '/';
            updStmt.run(pidList, newId);
            idMap.set(n.code, { id: newId, pid_list: pidList, name: n.name, level: n.level });
            count++;
            if (entry.children.length) {
                insertTree(entry.children, newId, pidList);
            }
        }
    }

    db.transaction(() => {
        // 先清空 prompt_menu（避免重复导入）
        db.exec('DELETE FROM prompt_menu');
        db.exec("DELETE FROM sqlite_sequence WHERE name='prompt_menu'");
        insertTree(rootTree, 0, '/');
    })();

    console.log('  插入 prompt_menu: ' + count + ' 条');

    // 7) 验证
    const checkRows = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu').get();
    console.log('  实际写入行数:', checkRows.c);

    const orphans = db.prepare(`
        SELECT m.id, m.category_name, m.parent_id
        FROM prompt_menu m
        WHERE m.parent_id != 0 AND NOT EXISTS (SELECT 1 FROM prompt_menu p WHERE p.id = m.parent_id)
    `).all();
    console.log('  orphans:', orphans.length);

    const dupes = db.prepare(`
        SELECT id, COUNT(*) c FROM prompt_menu GROUP BY id HAVING c > 1
    `).all();
    console.log('  重复 id:', dupes.length);

    // 按 level 统计
    const byLevel = db.prepare(`
        SELECT
            (LENGTH(pid_list) - LENGTH(REPLACE(pid_list, '/', ''))) AS depth,
            COUNT(*) AS c
        FROM prompt_menu
        GROUP BY depth
        ORDER BY depth
    `).all();
    console.log('  层级分布:');
    for (const r of byLevel) console.log('    depth=' + r.depth + '  ' + r.c + ' 条');

    db.close();
    console.log('✓ 完成');
}

main();
