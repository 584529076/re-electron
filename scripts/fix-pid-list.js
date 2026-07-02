/**
 * 重建 prompt_menu.pid_list
 *   pid_list = 父链路径串，例 "/1/4/9/"
 *   算法：从 parent_id 出发往上找根，拼出完整路径
 *   根节点（parent_id=0）→ pid_list = "/<自己的id>/"
 *
 * 用法：node scripts/fix-pid-list.js [--dry-run]
 *   --dry-run: 只打印会改的，不真正写库
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const dryRun = process.argv.includes('--dry-run');

// 用 Node 内置 sqlite（避免 better-sqlite3 编译版本不匹配问题）
const { DatabaseSync } = require('node:sqlite');

// 默认 db 路径
const dbPath = path.join(__dirname, '..', 'prompts', 'prompts.db');
if (!fs.existsSync(dbPath)) {
    console.error('找不到 db 文件:', dbPath);
    process.exit(1);
}
console.log('db:', dbPath);
console.log(dryRun ? '模式: DRY-RUN (不写库)' : '模式: 写库');
console.log('');

const db = new DatabaseSync(dbPath);

const all = db.prepare('SELECT id, parent_id, pid_list FROM prompt_menu').all();
const byId = new Map(all.map(r => [r.id, r]));

// 缓存已算好的 pid_list（递归时复用，避免父节点没及时算好就出错）
const cache = new Map();
function buildPidList(parentId, id, depth) {
    if (depth > 20) return '/' + id + '/';  // 防自循环
    if (!parentId || parentId === 0) return '/' + id + '/';
    if (cache.has(parentId)) {
        const prefix = cache.get(parentId);
        if (prefix && prefix.endsWith('/')) return prefix + id + '/';
        return prefix + '/' + id + '/';
    }
    const p = byId.get(parentId);
    if (!p) return '/' + id + '/';  // 父节点不存在（孤儿），按根处理
    // 递归算父的 pid_list
    const parentPl = buildPidList(p.parent_id || 0, p.id, (depth || 0) + 1);
    cache.set(p.id, parentPl);
    if (parentPl.endsWith('/')) return parentPl + id + '/';
    return parentPl + '/' + id + '/';
}

let fixed = 0, skipped = 0, sample = [];
for (const r of all) {
    cache.clear();  // 每个节点独立算（避免节点间干扰）
    const expected = buildPidList(r.parent_id || 0, r.id, 0);
    if (r.pid_list !== expected) {
        if (sample.length < 8) sample.push({ id: r.id, old: r.pid_list, new: expected });
        if (!dryRun) {
            db.prepare('UPDATE prompt_menu SET pid_list = ? WHERE id = ?').run(expected, r.id);
        }
        fixed++;
    } else {
        skipped++;
    }
}

console.log('扫描结果:');
console.log('  共 ' + all.length + ' 条');
console.log('  需修正 ' + fixed + ' 条');
console.log('  已是最新 ' + skipped + ' 条');
if (sample.length) {
    console.log('');
    console.log('变更样例 (前 8 条):');
    for (const s of sample) console.log('  id=' + s.id, '|', JSON.stringify(s.old), '→', JSON.stringify(s.new));
}

if (dryRun) {
    console.log('');
    console.log('[dry-run] 未实际写库。去掉 --dry-run 再跑一次执行。');
} else {
    console.log('');
    console.log('✓ 已更新 ' + fixed + ' 条 pid_list');
}

db.close();
