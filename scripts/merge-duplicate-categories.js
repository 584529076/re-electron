// scripts/merge-duplicate-categories.js
// 合并 prompt_menu 中 (parent_id, category_name) 重复的行：
// 1. 找出每个 (parent_id, category_name) 分组里的多条记录
// 2. 选 id 最小的作为 canonical
// 3. 把其它记录的 prompt_items.category_id / prompt_associations / prompt_examples.category_id 全部 reassign 到 canonical
// 4. 删除非 canonical 记录
//
// 用法：node scripts/merge-duplicate-categories.js

'use strict';

const { DatabaseSync } = require('node:sqlite');

const DB_PATH = 'D:/re-electron/prompts/prompts.db';

function main() {
    const db = new DatabaseSync(DB_PATH);

    // 1. 找所有重复的 (parent_id, category_name)
    const dups = db.prepare(`
        SELECT parent_id, category_name, COUNT(*) as c, GROUP_CONCAT(id, ',') AS ids
        FROM prompt_menu
        GROUP BY parent_id, category_name
        HAVING c > 1
    `).all();

    console.log('重复分组:', dups.length, '组');

    let totalMerged = 0;
    db.exec('BEGIN');
    try {
        for (const d of dups) {
            const ids = d.ids.split(',').map(Number).sort((a, b) => a - b);
            const canonical = ids[0];
            const others = ids.slice(1);

            // 2. reassign items
            for (const oid of others) {
                // 把 category_id = oid 的 item 改为 canonical（但同 canonical 已经存在的 name 不重复）
                // 先看 canonical 当前已有的 (name, category_id) — 跳过已存在的避免 UNIQUE 冲突
                const dupItems = db.prepare('SELECT id, name FROM prompt_items WHERE category_id = ?').all(oid);
                for (const it of dupItems) {
                    const exists = db.prepare('SELECT id FROM prompt_items WHERE category_id = ? AND name = ?').get(canonical, it.name);
                    if (exists) {
                        // 删除 oid 的这一条（保留 canonical 那条）
                        db.prepare('DELETE FROM prompt_items WHERE id = ?').run(it.id);
                    } else {
                        db.prepare('UPDATE prompt_items SET category_id = ? WHERE id = ?').run(canonical, it.id);
                    }
                }
                // 3. reassign examples (category_id 指向 oid 的)
                const exCount = db.prepare('SELECT COUNT(*) AS c FROM prompt_examples WHERE category_id = ?').get(oid).c;
                if (exCount) db.prepare('UPDATE prompt_examples SET category_id = ? WHERE category_id = ?').run(canonical, oid);

                // 4. 删除重复分类
                db.prepare('DELETE FROM prompt_menu WHERE id = ?').run(oid);
                totalMerged++;
            }
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    console.log('合并完成，删除', totalMerged, '条重复分类');

    const finalCount = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c;
    console.log('剩余 prompt_menu:', finalCount);

    // 再次验证：parent_id=0 还剩多少
    const stillRoot = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu WHERE parent_id = 0').get().c;
    console.log('parent_id=0 的剩余:', stillRoot);
}

main();