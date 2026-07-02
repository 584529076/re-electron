'use strict';
/**
 * KVDb — 极简的 key/value 持久化（基于 better-sqlite3）
 *
 * 设计原则：
 * - 同步 API（better-sqlite3 本身就是同步的；不要包成 async 反而绕）
 * - 单表 kv，value 用 JSON 编码（保持灵活，可存任意 JSON）
 * - 写入用事务包 INSERT OR REPLACE
 * - 路径在构造函数传入，不在内部拼，便于测试和隔离
 *
 * 不用 ORM（knex/prisma/drizzle），手写 SQL 完爆这个体量。
 */

// db.js — D:\re-electron 副本
// canonical: C:\Users\cool\.openclaw\shared\db.js （ai-workbench 也用同一份）
// better-sqlite3 同步 API，KVDb 单表，WAL 模式
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

class KVDb {
  /**
   * @param {string} dbPath sqlite 文件绝对路径（不存在会自动创建；已存在但非 sqlite 则当作损坏 → 备份 + 重建）
   */
  constructor(dbPath) {
    if (!dbPath) throw new Error('KVDb: dbPath 必填');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.path = dbPath;

    // 自愈：文件存在但不是合法 sqlite → 改名为 .corrupt-<ts> 后重建
    if (fs.existsSync(dbPath)) {
      const fd = fs.openSync(dbPath, 'r');
      const head = Buffer.alloc(15);
      fs.readSync(fd, head, 0, 15, 0);
      fs.closeSync(fd);
      const sig = head.toString('utf8');
      if (sig !== 'SQLite format 3') {
        try {
          fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
        } catch {
          // rename 失败：硬删（极少见）
          try { fs.unlinkSync(dbPath); } catch {}
        }
      }
    }

    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');    // 读并发不阻塞写
    this._db.pragma('synchronous = NORMAL');  // 性能/安全折中
    this._db.exec(SCHEMA);
    this._stmtGet = this._db.prepare('SELECT value FROM kv WHERE key = ?');
    this._stmtSet = this._db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)');
    this._stmtDel = this._db.prepare('DELETE FROM kv WHERE key = ?');
    this._stmtAll = this._db.prepare('SELECT key, value FROM kv');
  }

  /**
   * 取一个 key；找不到或解析失败返回 defaultValue
   * @param {string} key
   * @param {*} [defaultValue=null]
   * @returns {*}
   */
  get(key, defaultValue = null) {
    const row = this._stmtGet.get(key);
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch {
      return defaultValue;
    }
  }

  /**
   * 写一个 key；value 会被 JSON.stringify
   * value === null 或 undefined 时删除该 key
   * 写入包在事务里
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    if (value === null || value === undefined) {
      this._db.transaction(() => {
        this._stmtDel.run(key);
      })();
      return;
    }
    const encoded = JSON.stringify(value);
    const now = Date.now();
    this._db.transaction(() => {
      this._stmtSet.run(key, encoded, now);
    })();
  }

  /**
   * 取所有 kv，返回对象拷贝
   * @returns {Object}
   */
  all() {
    const out = {};
    for (const row of this._stmtAll.all()) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        // 跳过损坏的 value（不抛）
      }
    }
    return out;
  }

  /**
   * 执行事务（原子提交/回滚）
   * 包装 better-sqlite3 的 transaction，依赖本类内的 exec / query
   * @template T
   * @param {() => T} fn
   * @returns {T} fn 的返回值
   */
  transaction(fn) {
    return this._db.transaction(fn)();
  }

  /**
   * 关库（主进程退出时调）
   */
  close() {
    try {
      this._db.close();
    } catch {
      // ignore
    }
  }

  /**
   * 执行任意 SQL（INSERT/UPDATE/DELETE/CREATE 等写操作）
   * 仅供主进程调用 —— 渲染进程走 IPC，不直接碰这层。
   * @param {string} sql
   * @param  {...any} params
   * @returns {{ changes: number, lastInsertRowid: number|bigint }}
   */
  exec(sql, ...params) {
    const stmt = this._db.prepare(sql);
    const info = stmt.run(...params);
    // SQLite 自增 id 可能返回 bigint，转成 number（小项目 id 不会超 2^53）
    const lid = info.lastInsertRowid;
    const lastInsertRowid = (typeof lid === 'bigint') ? Number(lid) : lid;
    return { changes: info.changes, lastInsertRowid };
  }

  /**
   * 执行查询 SQL，返回所有行
   * @param {string} sql
   * @param  {...any} params
   * @returns {Array<Object>}
   */
  query(sql, ...params) {
    const stmt = this._db.prepare(sql);
    return stmt.all(...params);
  }
}

module.exports = { KVDb };
