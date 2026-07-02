// scripts/import-03-md.js — 一次性导入 03-裸露液体.md 到 SQLite
// 用法：node scripts/import-03-md.js [md_path] [db_path]
//   md_path 默认：D:\nsfw-prompt-templates-asian-main\03-裸露液体.md
//   db_path 默认：D:\re-electron\prompts\prompts.db
//
// 幂等：重复执行不会产生重复行（用 UNIQUE 约束 + INSERT OR IGNORE）

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MD_PATH = process.argv[2] || path.join('D:', 'nsfw-prompt-templates-asian-main', '03-裸露液体.md');
const DB_PATH = process.argv[3] || path.join(__dirname, '..', 'prompts', 'prompts.db');

// ========== 1. 解析 .md ==========

function parseMd(mdText) {
    const lines = mdText.split(/\r?\n/);
    const l2Chapters = [];   // [{ name, code: '①', title: '...', l3: [...] }]
    let curL2 = null;
    let curL3 = null;
    let inCode = false;
    let codeBuf = [];
    let descBuf = [];

    function flushL3() {
        if (curL3) {
            curL3.prompts = (curL3.prompts || []).concat(extractPrompts(codeBuf));
            curL3.description = (curL3.description || '') + descBuf.join('\n').trim();
            curL3 = null;
        }
        codeBuf = [];
        descBuf = [];
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // H1: # xxx → 跳过（伪章节）
        if (/^#\s+/.test(trimmed) && !/^##/.test(trimmed)) {
            flushL3();
            curL2 = null;
            continue;
        }

        // H2: ## 👙 ① 裸露分级（6级梯度）
        let m = /^##\s+(.+)$/.exec(trimmed);
        if (m) {
            flushL3();
            const full = m[1].trim();
            const codeMatch = /([①②③④⑤⑥⑦⑧⑨])/.exec(full);
            // 跳过没有 ①②③ 圆圈数字的伪章节（如 "裸露/液体词库"、"索引"）
            if (!codeMatch) {
                curL2 = null;
                continue;
            }
            const code = codeMatch[1];
            // 去 emoji 和章节号，保留有意义的标题
            const title = full.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/^[①②③④⑤⑥⑦⑧⑨]\s*/, '').replace(/（.*?）/, '').trim();
            curL2 = { name: full, code, title, l3: [] };
            l2Chapters.push(curL2);
            continue;
        }

        // H3: ### Level 1 — 包裹感（全遮/暗示） 或 ### # 子标题
        m = /^###\s+(.+)$/.exec(trimmed);
        if (m) {
            flushL3();
            const full = m[1].trim();
            curL3 = { name: full, prompts: [], description: '' };
            if (curL2) curL2.l3.push(curL3);
            continue;
        }

        // 代码块
        if (trimmed.startsWith('```')) {
            if (!inCode) {
                inCode = true;
                codeBuf = [];
            } else {
                inCode = false;
                // 累积到 curL3.prompts
                if (curL3) {
                    curL3.prompts = (curL3.prompts || []).concat(extractPrompts(codeBuf));
                } else if (curL2) {
                    // 没有 L3 的代码块 → 用 L2 名字当 L3
                    const autoL3 = { name: curL2.title, prompts: extractPrompts(codeBuf), description: '' };
                    curL2.l3.push(autoL3);
                }
                codeBuf = [];
            }
            continue;
        }

        if (inCode) {
            codeBuf.push(line);
            continue;
        }

        // 描述行：**搭配要点**：... 或 > 适用：... 或 核心原理...
        if (curL3) {
            const descMatch = /^(\*\*搭配要点\*\*|核心原理|铁律)：(.+)$/.exec(trimmed);
            if (descMatch) {
                descBuf.push(descMatch[2].trim());
                continue;
            }
            // > 引用作为补充说明
            if (trimmed.startsWith('> ')) {
                descBuf.push(trimmed.slice(2).trim());
                continue;
            }
        }
    }
    flushL3();
    return l2Chapters;
}

function extractPrompts(codeLines) {
    const text = codeLines.join('\n');
    // 提示词用逗号分隔，每条去掉前后空格和引号
    return text
        .split(/[,\n]/)
        .map(s => s.trim().replace(/^[「"'`]+|[」"'`]+$/g, ''))
        .filter(s => s && s.length > 1 && !/^[\s\-—:]+$/.test(s));
}

// ========== 2. 通用表格扫描 ==========

function parseTables(mdText) {
    const lines = mdText.split(/\r?\n/);
    const tables = [];   // [{ header: [str], rows: [[str]], lineStart: int }]
    let curTable = null;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed.startsWith('|')) {
            if (curTable) { tables.push(curTable); curTable = null; }
            continue;
        }
        const cells = trimmed.split('|').map(s => s.trim()).filter((s, idx, arr) => {
            // 过滤首尾空 cell（markdown 表格前后 |）
            if (idx === 0 && s === '') return false;
            if (idx === arr.length - 1 && s === '') return false;
            return true;
        });
        if (cells.length < 2) continue;
        // 分割行 | --- | --- |
        if (/^[\s—\-:]+$/.test(cells[0])) {
            if (curTable) curTable.lineEnd = i;
            continue;
        }
        if (!curTable) {
            curTable = { header: cells, rows: [], lineStart: i };
        } else {
            curTable.rows.push(cells);
        }
    }
    if (curTable) tables.push(curTable);
    return tables;
}

// ========== 3. 解析 ④ 场景适配表 / ⑤ 姿势联动表 → scene_templates ==========

function parseSceneTables(mdText) {
    const tables = parseTables(mdText);
    const scenes = [];
    for (const t of tables) {
        const h = t.header.map(s => s.replace(/\s+/g, ''));
        // 场景模板表：列名包含 场景 + 推荐等级 + 核心关键词
        if (!(h[0] === '场景' || h[0] === '姿势变体') || !h.includes('推荐等级') && !h.includes('说明')) continue;
        for (const row of t.rows) {
            if (row.length < 3) continue;
            const name = (row[0] || '').replace(/\*\*/g, '').trim();
            const level = (row[1] || '').trim();
            const kwCell = (row[2] || '').trim();
            const avoidCell = (row[3] || '').trim();
            if (!name || name === '#') continue;
            const keywords = extractCodeList(kwCell);
            const avoid = (avoidCell.match(/[❌❎✖]?\s*([^,，;；|]+)/g) || [])
                .map(s => s.replace(/^[❌❎✖\s]+/, '').trim())
                .filter(Boolean);
            if (name) scenes.push({ name, level, keywords, avoid });
        }
    }
    return scenes;
}

function extractCodeList(s) {
    const matches = s.match(/`([^`]+)`/g) || [];
    const all = matches.map(m => m.slice(1, -1));
    if (all.length === 0) {
        return s.split(/[,,;;\n]/).map(x => x.trim()).filter(Boolean);
    }
    return all.flatMap(m => m.split(/[,\n]/).map(x => x.trim()).filter(Boolean));
}

// ========== 4. 解析 附录 C 禁止组合表 → exclusive 关联 ==========

function parseForbiddenTable(mdText) {
    const tables = parseTables(mdText);
    const forbidden = [];
    for (const t of tables) {
        const h = t.header.map(s => s.replace(/\s+/g, ''));
        // 附录 C 表：列名包含 禁止组合 + 原因
        if (!h.includes('禁止组合') || !h.includes('原因')) continue;
        for (const row of t.rows) {
            if (row.length < 3) continue;
            const num = (row[0] || '').trim();
            const combo = (row[1] || '').trim();
            const reason = (row[2] || '').replace(/^理由[:：]\s*/, '').trim();
            if (!combo || num === '#') continue;
            // 解析：A + B 里的 A 和 B（去掉 backtick 和空格）
            const parts = combo.split('+').map(s => s.replace(/`/g, '').trim()).filter(Boolean);
            if (parts.length >= 2) {
                forbidden.push({ a: parts[0], b: parts[1], reason });
            } else if (parts.length === 1) {
                // 单边禁止（如 "精液无量词"）→ 映射到分类
                forbidden.push({ a: parts[0], b: 'cum', reason: reason || '无量词' });
            }
        }
    }
    return forbidden;
}

// ========== 4. 解析 数量限制（从 L3 description 提取） ==========

function extractQuantityRule(name, description) {
    // 匹配 "必选 1-2 个" / "选 2-3 个" / "必选其一" / "选 1 个"
    const text = (name + ' ' + description).replace(/\s+/g, ' ');
    let m = /必选\s*([\d\-]+)\s*个/.exec(text);
    if (m) return `必选 ${m[1]} 个`;
    m = /选\s*([\d\-]+)\s*个/.exec(text);
    if (m) return `选 ${m[1]} 个`;
    m = /必选其一/.exec(text);
    if (m) return '必选其一';
    m = /必选\s*\d+-\d+\s*个/.exec(text);
    if (m) return m[0];
    m = /关键[！!]/.exec(text);
    if (m) return '关键！必选';
    return '';
}

// ========== 5. SQLite 操作 ==========

function openDb() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`[ERR] DB not found: ${DB_PATH}`);
        process.exit(1);
    }
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    return db;
}

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_menu (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_name TEXT NOT NULL,
            parent_id INTEGER DEFAULT 0,
            description TEXT DEFAULT '',
            pid_list TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            tag_required TEXT DEFAULT '',
            tag_exclusive_group TEXT DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_parent ON prompt_menu(parent_id)`);
    // 老库兼容：补 tag_required / tag_exclusive_group
    const menuCols = db.prepare("PRAGMA table_info(prompt_menu)").all();
    if (menuCols.length) {
        if (!menuCols.some(c => c.name === 'tag_required')) db.exec("ALTER TABLE prompt_menu ADD COLUMN tag_required TEXT DEFAULT ''");
        if (!menuCols.some(c => c.name === 'tag_exclusive_group')) db.exec("ALTER TABLE prompt_menu ADD COLUMN tag_exclusive_group TEXT DEFAULT ''");
        if (!menuCols.some(c => c.name === 'pid_list')) db.exec("ALTER TABLE prompt_menu ADD COLUMN pid_list TEXT DEFAULT ''");
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            content TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0,
            description TEXT DEFAULT '',
            sensitivity TEXT DEFAULT 'nsfw',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_items_cat ON prompt_items(category_id)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_items_cat_name ON prompt_items(category_id, name)`);
    // 老库兼容：补 description / sensitivity
    const itemCols = db.prepare("PRAGMA table_info(prompt_items)").all();
    if (itemCols.length) {
        if (!itemCols.some(c => c.name === 'description')) db.exec("ALTER TABLE prompt_items ADD COLUMN description TEXT DEFAULT ''");
        if (!itemCols.some(c => c.name === 'sensitivity')) db.exec("ALTER TABLE prompt_items ADD COLUMN sensitivity TEXT DEFAULT 'nsfw'");
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_associations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_a_id INTEGER NOT NULL,
            prompt_b_id INTEGER NOT NULL,
            relation TEXT NOT NULL CHECK(relation IN ('strong','weak','exclusive')),
            weight INTEGER DEFAULT 50,
            source TEXT DEFAULT 'manual',
            reason TEXT DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(prompt_a_id, prompt_b_id, relation)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS scene_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            item_ids TEXT DEFAULT '[]',
            source TEXT DEFAULT 'manual',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
}

function getOrCreateCategory(db, name, parentId, description, sortOrder, tagRequired, tagExclusiveGroup, overwriteMeta) {
    // 规范化名字（去 emoji，trim）
    const cleanName = String(name || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/^[①②③④⑤⑥⑦⑧⑨]\s*/, '').replace(/（.*?）/, '').trim();
    if (!cleanName) return null;
    const existing = db.prepare('SELECT id, description, tag_required, tag_exclusive_group FROM prompt_menu WHERE category_name = ? AND parent_id = ?').get(cleanName, parentId);
    if (existing) {
        if (overwriteMeta) {
            // md-import 模式：总是用新值覆盖（即使空）
            db.prepare(`UPDATE prompt_menu SET
                description = ?, tag_required = ?, tag_exclusive_group = ?,
                sort_order = ?, updated_at = strftime('%s','now')
                WHERE id = ?`).run(
                description || '', tagRequired || '', tagExclusiveGroup || '',
                sortOrder, existing.id
            );
        } else {
            // 增量模式：只在新值非空时更新
            db.prepare(`UPDATE prompt_menu SET
                description = CASE WHEN ? != '' THEN ? ELSE description END,
                tag_required = CASE WHEN ? != '' THEN ? ELSE tag_required END,
                tag_exclusive_group = CASE WHEN ? != '' THEN ? ELSE tag_exclusive_group END,
                sort_order = ?,
                updated_at = strftime('%s','now')
                WHERE id = ?`).run(
                description, description, tagRequired, tagRequired, tagExclusiveGroup, tagExclusiveGroup,
                sortOrder, existing.id
            );
        }
        return existing.id;
    }
    const r = db.prepare('INSERT INTO prompt_menu (category_name, parent_id, description, sort_order, tag_required, tag_exclusive_group) VALUES (?, ?, ?, ?, ?, ?)').run(
        cleanName, parentId, description || '', sortOrder, tagRequired || '', tagExclusiveGroup || ''
    );
    return Number(r.lastInsertRowid);
}

function getOrCreateItem(db, categoryId, name, content, sortOrder, sensitivity) {
    name = String(name || '').trim();
    if (!name) return null;
    const existing = db.prepare('SELECT id FROM prompt_items WHERE category_id = ? AND name = ?').get(categoryId, name);
    if (existing) {
        db.prepare(`UPDATE prompt_items SET content = ?, sort_order = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(
            content || name, sortOrder, existing.id
        );
        return existing.id;
    }
    const r = db.prepare('INSERT INTO prompt_items (category_id, name, content, sort_order, sensitivity) VALUES (?, ?, ?, ?, ?)').run(
        categoryId, name, content || name, sortOrder, sensitivity || 'nsfw'
    );
    return Number(r.lastInsertRowid);
}

function getItemIdByName(db, name) {
    if (!name) return null;
    const row = db.prepare('SELECT id FROM prompt_items WHERE name = ? LIMIT 1').get(String(name).trim());
    return row ? row.id : null;
}

function getCategoryIdByName(db, name) {
    if (!name) return null;
    const row = db.prepare('SELECT id FROM prompt_menu WHERE category_name = ? LIMIT 1').get(String(name).trim());
    return row ? row.id : null;
}

function upsertAssociation(db, aId, bId, relation, weight, reason, source) {
    if (!aId || !bId || aId === bId) return false;
    // UNIQUE(a, b, relation) 用 a<b 保证双向
    const lo = Math.min(aId, bId), hi = Math.max(aId, bId);
    try {
        db.prepare('INSERT OR IGNORE INTO prompt_associations (prompt_a_id, prompt_b_id, relation, weight, reason, source) VALUES (?, ?, ?, ?, ?, ?)').run(
            lo, hi, relation, weight || 50, reason || '', source || 'md-import'
        );
        return true;
    } catch (e) {
        return false;
    }
}

function upsertSceneTemplate(db, name, description, itemIdsJson, source) {
    if (!name) return null;
    const existing = db.prepare('SELECT id FROM scene_templates WHERE name = ?').get(name);
    if (existing) {
        db.prepare(`UPDATE scene_templates SET description = ?, item_ids = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(
            description || '', itemIdsJson, existing.id
        );
        return existing.id;
    }
    const r = db.prepare('INSERT INTO scene_templates (name, description, item_ids, source) VALUES (?, ?, ?, ?)').run(
        name, description || '', itemIdsJson, source || 'md-import'
    );
    return Number(r.lastInsertRowid);
}

// 解析附录 C 里的 token：先 item 名 → 再分类名（含匹配）→ 都没有就建占位 item
function resolveForbiddenToken(db, token, placeholderCatId) {
    if (!token) return null;
    const t = String(token).trim();
    if (!t) return null;
    // 1. item 名精确匹配
    let id = getItemIdByName(db, t);
    if (id) return id;
    // 2. 分类名包含 token
    id = getCategoryIdByName(db, t);
    if (id) return id;
    // 3. 分类名 LIKE 匹配（中文触发词 → 找包含它的 L3 分类）
    const likeRow = db.prepare("SELECT id FROM prompt_menu WHERE category_name LIKE ? ORDER BY id LIMIT 1").get('%' + t + '%');
    if (likeRow) return likeRow.id;
    // 4. 建占位 item（放在 placeholderCatId 下）
    const r = db.prepare('INSERT INTO prompt_items (category_id, name, content, sort_order, sensitivity) VALUES (?, ?, ?, ?, ?)').run(
        placeholderCatId, t, t, 0, 'nsfw'
    );
    return Number(r.lastInsertRowid);
}

// ========== 6. 主流程 ==========

function cleanL3Name(name) {
    // 1) 提取括号里的"选/必选"作为 tag_required
    // 2) 移除其他括号（包括 English alias、说明等）
    // 3) 去掉 # 前缀、emoji、章节号（支持 ⑧ / ⑧.1 / ⑧.1.1 形式）、前导破折号
    let s = String(name || '');
    // 匹配括号里包含"选/必选/个"的内容（避免误匹配 Level 1-2、Cum 等）
    const parenMatch = s.match(/[（(]([^）)]*(?:必?选|个)[^）)]*)[）)]/);
    if (parenMatch) {
        const inside = parenMatch[1];
        if (inside.length <= 20) {
            // 留作 tag_required，由 splitL3Name 提取
        }
    }
    s = s.replace(/[（(][^）)]*[）)]/g, ''); // 去所有括号
    s = s.replace(/^#+\s*/, '')             // 去 # ## 等前缀
         .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')  // 去 emoji
         .replace(/^[①②③④⑤⑥⑦⑧⑨](?:\.\d+)*\.?\s*/, '')  // 去章节号 + 可选 .N.N.N 后缀
         .replace(/^[—\-–]+\s*/, '')        // 去前导 em-dash
         .replace(/\s*[—\-–]\s*/g, '—')     // 合并多重 em-dash
         .replace(/\s+/g, ' ')
         .trim();
    return s;
}

// 返回 { name, tag_required } 二元组
function splitL3Name(name) {
    return { name: cleanL3Name(name), tag_required: extractParenRule(name) };
}

function extractParenRule(name) {
    // 只在括号内含"选/必选"或以"个"结尾的数字限定才算数量限制
    // 避免误匹配"推荐等级 Level 1-2""(Cum)""(Breast Milk)"等
    const m = String(name || '').match(/[（(]([^）)]+)[）)]/);
    if (!m) return '';
    const inside = m[1].trim();
    if (inside.length > 20) return '';
    if (!/必?选|个/.test(inside)) return '';
    return inside;
}

function main() {
    console.log('[import-03-md] MD:', MD_PATH);
    console.log('[import-03-md] DB:', DB_PATH);

    if (!fs.existsSync(MD_PATH)) {
        console.error('[ERR] MD not found:', MD_PATH);
        process.exit(1);
    }
    const mdText = fs.readFileSync(MD_PATH, 'utf-8');

    const db = openDb();
    ensureSchema(db);

    // 清理：删除 source='md-import' 的旧数据（categories/items/assocs/scenes）
    // 不删用户手工建的，只清本次导入的
    console.log('[clean] 清掉 source=md-import 的旧数据...');
    db.exec("DELETE FROM prompt_associations WHERE source = 'md-import'");
    db.exec("DELETE FROM scene_templates WHERE source = 'md-import'");
    // 删：根 L1 / 占位 / 场景分类 / 残留的"索引""裸露/液体词库"等伪章节（这些是上次跑漏的）
    const oldImportedCatIds = db.prepare("SELECT id, parent_id FROM prompt_menu WHERE tag_exclusive_group = 'nsfw-template' OR category_name = '禁忌占位词（自动建）' OR category_name = '裸露液体（md-import）' OR category_name LIKE '场景：%' OR category_name IN ('裸露/液体词库', '索引', '附录 A：液体真实感检查清单', '附录 B：液体组合场景速查', '附录 C：禁止组合', '裸露分级', '衣物状态', '部位裸露', '场景适配', '裸露×姿势联动', '女性生殖器专项', '男性生殖器专项', '液体专项')").all();
    if (oldImportedCatIds.length > 0) {
        // 递归找所有子分类（避免删除 root 时子分类变孤儿）
        const allCatIds = new Set(oldImportedCatIds.map(c => c.id));
        let added = true;
        while (added) {
            added = false;
            const childRows = db.prepare(`SELECT id FROM prompt_menu WHERE parent_id IN (${[...allCatIds].map(() => '?').join(',')})`).all(...allCatIds);
            for (const r of childRows) {
                if (!allCatIds.has(r.id)) { allCatIds.add(r.id); added = true; }
            }
        }
        const ids = [...allCatIds];
        const placeholders = ids.map(() => '?').join(',');
        db.exec(`DELETE FROM prompt_items WHERE category_id IN (${placeholders})`, ...ids);
        db.exec(`DELETE FROM prompt_menu WHERE id IN (${placeholders})`, ...ids);
    }
    // 清理 L1-L6 上次的 tag_exclusive_group 标记（因为 root 也被删了会重新建，但子分类需要重新打）
    db.exec("UPDATE prompt_menu SET tag_exclusive_group = '' WHERE tag_exclusive_group = '裸露等级'");

    const l2List = parseMd(mdText);
    console.log(`[parse] 解析到 ${l2List.length} 个 L2 章节`);

    // 建立 L2 → 互斥分组（"裸露等级" 章节下的 Level1~Level6 互相排斥）
    const EXCL_GROUP_NUDE_LEVEL = '裸露等级';
    const isNudeLevel = (name) => /^Level\s+\d/.test(cleanL3Name(name));

    // 创建根 L1 分类
    const rootL1Id = getOrCreateCategory(db, '裸露液体（md-import）', 0, '从 03-裸露液体.md 导入的词库', 0, '', 'nsfw-template', true);
    console.log(`[root] L1 根分类 id=${rootL1Id}`);

    const stats = { l2: 0, l3: 0, items: 0, scenes: 0, assoc: 0, forbidden: 0, duplicate: 0 };
    const nudeLevelCatIds = [];

    // ===== 导入 L2 + L3 + items =====
    db.transaction(() => {
        l2List.forEach((l2, l2Idx) => {
            const l2Name = l2.title || l2.name;
            const l2Id = getOrCreateCategory(db, l2Name, rootL1Id, '', l2Idx * 100, '', '', true);
            if (!l2Id) return;
            stats.l2++;
            console.log(`  L2[${l2Idx}] ${l2Name} → id=${l2Id}, ${l2.l3.length} L3`);

            l2.l3.forEach((l3, l3Idx) => {
                const split = splitL3Name(l3.name);
                const l3Name = split.name;
                if (!l3Name) return;
                // tag_required 优先级：括号里提取的 > description 里提取的
                const tagReq = split.tag_required || extractQuantityRule(l3Name, l3.description);
                // 互斥分组（仅 Level 1~6 标裸露等级）
                const exclGroup = isNudeLevel(l3Name) ? EXCL_GROUP_NUDE_LEVEL : '';
                const l3Id = getOrCreateCategory(db, l3Name, l2Id, l3.description || '', l3Idx, tagReq, exclGroup, true);
                if (!l3Id) return;
                stats.l3++;
                if (exclGroup) nudeLevelCatIds.push({ name: l3Name, id: l3Id });

                l3.prompts.forEach((p, pIdx) => {
                    const itemId = getOrCreateItem(db, l3Id, p, p, pIdx, 'nsfw');
                    if (itemId) stats.items++;
                });
            });
        });

        // ===== 4 场景适配 / 5 姿势联动 → scene_templates =====
        const scenes = parseSceneTables(mdText);
        console.log(`[parse] 解析到 ${scenes.length} 个场景/姿势`);
        scenes.forEach((sc, idx) => {
            // 把 keywords 里的每条都加成 prompt_items（挂在 "场景关键词" 这个特殊 L3 下）
            // 同时建 scene_template
            const itemIds = [];
            sc.keywords.forEach((kw, kwIdx) => {
                // 找或建一个隐藏的 "场景关键词-<场景名>" 分类
                const sceneCatName = `场景：${sc.name}`;
                const sceneCatId = getOrCreateCategory(db, sceneCatName, rootL1Id, `推荐等级 ${sc.level}`, idx * 10, '', '', true);
                const itemId = getOrCreateItem(db, sceneCatId, kw, kw, kwIdx, 'nsfw');
                if (itemId) itemIds.push(itemId);
            });
            if (itemIds.length > 0) {
                const description = `推荐等级：${sc.level}\n禁忌：${sc.avoid.join('、') || '无'}`;
                upsertSceneTemplate(db, sc.name, description, JSON.stringify(itemIds), 'md-import');
                stats.scenes++;
            }
        });

        // ===== L1-L6 互斥：只设 tag_exclusive_group，不建 item 级关联（运行时查） =====
        // （L1-L6 的 tag_exclusive_group='裸露等级' 已在 getOrCreateCategory 时设置）

        // ===== 附录 C 禁止组合 → exclusive 关联 =====
        // 先建一个"禁忌占位"分类（parent=rootL1Id），用于收容找不到的英文短语
        const placeholderCatId = getOrCreateCategory(db, '禁忌占位词（自动建）', rootL1Id, '附录 C 禁止组合里出现的英文短语，没匹配到现有 item 的临时条目', 9999, '', '', true);
        const forbidden = parseForbiddenTable(mdText);
        console.log(`[parse] 解析到 ${forbidden.length} 条禁止组合`);
        forbidden.forEach((f) => {
            const aId = resolveForbiddenToken(db, f.a, placeholderCatId);
            const bId = resolveForbiddenToken(db, f.b, placeholderCatId);
            if (aId && bId) {
                if (upsertAssociation(db, aId, bId, 'exclusive', 100, f.reason || '附录 C 禁止组合', 'md-import')) {
                    stats.forbidden++;
                }
            } else {
                console.log(`  [skip] 找不到关联词: ${f.a} / ${f.b}`);
            }
        });
    })();

    console.log('\n[import-03-md] 完成：');
    console.log(`  L2 章节:    ${stats.l2}`);
    console.log(`  L3 子分类:  ${stats.l3}`);
    console.log(`  提示词 items: ${stats.items}`);
    console.log(`  场景模板:   ${stats.scenes}`);
    console.log(`  L1-L6 互斥关联: ${stats.assoc}`);
    console.log(`  附录 C 禁止关联: ${stats.forbidden}`);

    // 校验
    const verify = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM prompt_menu WHERE parent_id = ?) AS l2,
            (SELECT COUNT(*) FROM prompt_items) AS items,
            (SELECT COUNT(*) FROM prompt_associations WHERE source = 'md-import') AS assoc,
            (SELECT COUNT(*) FROM scene_templates WHERE source = 'md-import') AS scenes
    `).get(rootL1Id);
    console.log('\n[verify] 库里实际数量：', verify);

    db.close();
}

main();
