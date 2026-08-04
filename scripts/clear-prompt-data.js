// scripts/clear-prompt-data.js
// 一次性脚本：备份并清空 prompt_items / prompt_menu
//
// 触发场景：D-NSFW-A 开始前清空存量测试数据，给新方案一个干净起点。
//
// 用法：  node scripts/clear-prompt-data.js [--yes]
//   --yes   跳过确认（CI/向导调用时使用）
//   默认交互：打印预览 + 等用户输入 y/N
//
// 备份位置：<repo>/backups/prompt-data-<unix-ts>.json
// 备份内容：{ prompt_menu: [...], prompt_items: [...],
//             counts: {...}, meta: { version, generated_at, ... } }
//
// 影响范围（仅修改）：
//   - prompt_items      ：DELETE 后自增 id 重置
//   - prompt_menu       ：DELETE 后自增 id 重置
// 不修改：
//   - prompt_associations（部分将成孤儿，已打印告警）
//   - scene_templates   （item_ids 内可能含失效 id，已打印告警）

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'prompts', 'prompts.db');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');

const SKIP_CONFIRM = process.argv.includes('--yes');

function fmtRow(row) {
  // 转成纯 JSON-safe 对象（Buffer → base64，BigInt → number）
  return JSON.parse(JSON.stringify(row, (_, v) => {
    if (typeof v === 'bigint') return Number(v);
    if (Buffer.isBuffer(v)) return v.toString('base64');
    return v;
  }));
}

function main() {
  console.log('▶ clear-prompt-data.js');
  console.log('  DB:    ' + DB_PATH);
  console.log('  Backup dir: ' + BACKUP_DIR);
  console.log('');

  if (!fs.existsSync(DB_PATH)) {
    console.error('!! DB 不存在: ' + DB_PATH);
    process.exit(1);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');

  // 1. 现状
  const menuCount = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c;
  const itemCount = db.prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c;
  const assocCount = db.prepare('SELECT COUNT(*) AS c FROM prompt_associations').get().c;
  const sceneCount = db.prepare('SELECT COUNT(*) AS c FROM scene_templates').get().c;

  const orphanAssoc = db.prepare(`
    SELECT COUNT(*) AS c FROM prompt_associations pa
    WHERE NOT EXISTS (SELECT 1 FROM prompt_items i WHERE i.id = pa.prompt_a_id)
       OR NOT EXISTS (SELECT 1 FROM prompt_items i WHERE i.id = pa.prompt_b_id)
  `).get().c;
  const scenesWithItemIds = db.prepare(`
    SELECT COUNT(*) AS c FROM scene_templates WHERE item_ids IS NOT NULL AND item_ids != '' AND item_ids != '[]'
  `).get().c;

  console.log('=== 现状 ===');
  console.log('  prompt_menu       : ' + menuCount + ' 行');
  console.log('  prompt_items      : ' + itemCount + ' 行');
  console.log('  prompt_associations: ' + assocCount + ' 行（其中 ' + orphanAssoc + ' 将在清除 items 后成孤儿）');
  console.log('  scene_templates   : ' + sceneCount + ' 行（其中 ' + scenesWithItemIds + ' 行的 item_ids 可能含失效 id）');
  console.log('');

  if (menuCount === 0 && itemCount === 0) {
    console.log('DB 已经是空的，无需操作。');
    db.close();
    return;
  }

  // 2. 备份
  const menuRows = db.prepare('SELECT * FROM prompt_menu ORDER BY id').all().map(fmtRow);
  const itemRows = db.prepare('SELECT * FROM prompt_items ORDER BY id').all().map(fmtRow);

  const ts = Math.floor(Date.now() / 1000);
  const backupFile = path.join(BACKUP_DIR, 'prompt-data-' + ts + '.json');
  const backupPayload = {
    meta: {
      generated_at: new Date().toISOString(),
      source: 'clear-prompt-data.js',
      note: '备份于清空 prompt_items / prompt_menu 之前',
      menu_count: menuCount,
      item_count: itemCount,
      db_path: DB_PATH,
    },
    prompt_menu: menuRows,
    prompt_items: itemRows,
  };

  fs.writeFileSync(backupFile, JSON.stringify(backupPayload, null, 2), 'utf8');
  console.log('=== 备份 ===');
  console.log('  写入: ' + backupFile);
  console.log('  大小: ' + (fs.statSync(backupFile).size / 1024).toFixed(1) + ' KB');
  console.log('');

  // 3. 确认
  if (!SKIP_CONFIRM) {
    console.log('即将执行 DELETE FROM prompt_items / prompt_menu，并重置 sqlite_sequence。');
    console.log('（prompt_associations / scene_templates 不动）');
    process.stdout.write('继续？ [y/N] ');
    const stdin = require('fs').readFileSync(0, 'utf8').trim().toLowerCase();
    if (stdin !== 'y' && stdin !== 'yes') {
      console.log('已取消。备份文件保留，可手动恢复。');
      db.close();
      process.exit(0);
    }
  }

  // 4. 删除 + 重置自增（node:sqlite 没有 .transaction()，用 BEGIN/COMMIT 包裹）
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM prompt_items');
    db.exec('DELETE FROM prompt_menu');
    // prompt_items / prompt_menu 都注册在 sqlite_sequence 中（auto-increment 表）
    db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('prompt_items','prompt_menu')`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // 5. 验证
  const afterMenu = db.prepare('SELECT COUNT(*) AS c FROM prompt_menu').get().c;
  const afterItem = db.prepare('SELECT COUNT(*) AS c FROM prompt_items').get().c;

  console.log('=== 完成 ===');
  console.log('  prompt_menu  : ' + menuCount + ' → ' + afterMenu);
  console.log('  prompt_items : ' + itemCount + ' → ' + afterItem);
  console.log('');
  if (orphanAssoc > 0) {
    console.log('⚠ 告警: prompt_associations 有 ' + orphanAssoc + ' 条将以孤儿形式残留（不影响 schema 安全）。');
  }
  if (scenesWithItemIds > 0) {
    console.log('⚠ 告警: scene_templates 有 ' + scenesWithItemIds + ' 行的 item_ids 含失效 id（可在向导跑完后重置）。');
  }
  console.log('');
  console.log('恢复命令：从 ' + backupFile + ' 读 JSON，按表重新 INSERT 即可（保留 backupFile 以便回滚）');

  db.close();
}

main();
