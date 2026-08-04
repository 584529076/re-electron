// scripts/clear-all-nsfw-imported.js
// 清空 NSFW 模板导入相关的 5 张表：
//   prompt_menu, prompt_items, prompt_examples,
//   prompt_import_history, prompt_associations
// （保留 scene_templates 不动）
// 备份到 backups/clear-all-nsfw-imported-<ts>.json

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'prompts', 'prompts.db');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');

const TABLES = ['prompt_menu', 'prompt_items', 'prompt_examples', 'prompt_import_history', 'prompt_associations'];

function main() {
    const db = new DatabaseSync(DB_PATH);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, 'clear-all-nsfw-imported-' + ts + '.json');

    console.log('▶ clear-all-nsfw-imported');
    console.log('  db:', DB_PATH);
    console.log('  backup:', backupPath);

    const backup = {};
    for (const t of TABLES) {
        backup[t] = db.prepare('SELECT * FROM ' + t).all();
        console.log('  备份 ' + t + ':', backup[t].length, '行');
    }
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf-8');
    console.log('  ✓ 备份已写入');

    // 删 + 重置自增
    db.exec('BEGIN');
    try {
        for (const t of TABLES) {
            const r = db.exec('DELETE FROM ' + t);
            console.log('  ✓ ' + t + ' 已清空');
        }
        try {
            db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map(t => `'${t}'`).join(',')})`);
            console.log('  ✓ sqlite_sequence 已重置');
        } catch (e) {
            console.log('  ⚠ sqlite_sequence 重置失败:', e.message);
        }
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }

    console.log('\n=== 清理后状态 ===');
    for (const t of TABLES) {
        const c = db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
        console.log('  ' + t + ': ' + c + ' 行');
    }
    const st = db.prepare('SELECT COUNT(*) AS c FROM scene_templates').get().c;
    console.log('  scene_templates (保留):', st, '行');
    console.log('\n✓ 完成');
}

main();