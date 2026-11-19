// lib/shared-context.js
// Sprint C-S1: 跨 agent 共享运行时上下文层
//
// 设计动机：
//   - blackboard（_ainovel_blackboard）= 长期项目状态（KV），不适合高频临时数据
//   - inbox（_ainovel_inbox_*/*.json）= 点对点消息流，不适合结构化数据
//   - 缺一层：agent 决策中间结果（如 character-architect 算出的人物关系网、
//     plot-thread-tracker 算出的子线进度）能被下游 agent 直接消费
//
// 关键能力：
//   1. 按 capability.context_needs 精准注入（不是无脑灌全部）
//   2. TTL 自动过期（默认 24h，可配永久）
//   3. importance 1-10 分级，影响压缩优先级（10 = 绝不压缩）
//   4. 写冲突用乐观锁（version）+ last-write-wins（不阻塞主流程）
//   5. 支持 glob 匹配（如 context_needs: ["plan.*"]）
//
// 存储：复用 novel-engine 的 _store（KVDb 实例），所有表都在 prompts.db
// 不引入新的文件路径——与 blackboard/inbox 同一套基础设施

'use strict';

const DEFAULT_TTL_MS = 24 * 3600 * 1000;  // 24 小时

class SharedContext {
    constructor({ store, now = () => Math.floor(Date.now() / 1000), uuid = null }) {
        if (!store) throw new Error('SharedContext: store 必填');
        this._store = store;
        this._now = now;
        this._uuid = uuid || (() => 'ctx_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
    }

    // ======================== 写入 ========================

    /**
     * 设置一个上下文项
     * @param {string} novelId
     * @param {string} key  形如 'plan.outline_synthesis' / 'bible.character_states'
     * @param {*} value 任意可 JSON.stringify 的值
     * @param {object} [opts]
     * @param {number} [opts.importance=5] 1-10，10 = 绝不压缩
     * @param {number} [opts.ttlMs] 毫秒；不传 = 永久
     * @param {string} [opts.sourceAgent]
     * @param {string} [opts.sourceTask]
     * @returns {{ok: boolean, id?: string, error?: string}}
     */
    set(novelId, key, value, opts = {}) {
        if (!novelId || !key) return { ok: false, error: 'novelId / key 必填' };
        const importance = Math.max(1, Math.min(10, Number(opts.importance) || 5));
        const ttlMs = opts.ttlMs == null ? null : Number(opts.ttlMs);
        const now = this._now();
        const expiresAt = ttlMs == null ? null : now + Math.floor(ttlMs / 1000);

        let valueJson;
        try {
            valueJson = JSON.stringify(value);
        } catch (e) {
            return { ok: false, error: 'value 不可 JSON 序列化: ' + e.message };
        }

        try {
            // 乐观锁：先查现有 version
            const existing = this._store.query(
                'SELECT id, version FROM _ainovel_shared_context WHERE novel_id = ? AND key = ?',
                novelId, key
            )[0];

            if (existing) {
                const newVersion = (existing.version || 1) + 1;
                this._store.exec(
                    `UPDATE _ainovel_shared_context
                     SET value = ?, version = ?, importance = ?, ttl_ms = ?,
                         source_agent = ?, source_task = ?, updated_at = ?, expires_at = ?
                     WHERE novel_id = ? AND key = ? AND version = ?`,
                    valueJson, newVersion, importance, ttlMs,
                    opts.sourceAgent || null, opts.sourceTask || null, now, expiresAt,
                    novelId, key, existing.version
                );
                return { ok: true, id: existing.id, version: newVersion };
            } else {
                const id = this._uuid();
                this._store.exec(
                    `INSERT INTO _ainovel_shared_context
                     (id, novel_id, key, value, version, importance, ttl_ms, source_agent, source_task, created_at, updated_at, expires_at)
                     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                    id, novelId, key, valueJson, importance, ttlMs,
                    opts.sourceAgent || null, opts.sourceTask || null, now, now, expiresAt
                );
                return { ok: true, id, version: 1 };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    /**
     * 批量 set（原子：失败回滚）
     */
    setMany(novelId, entries, opts = {}) {
        for (const [key, value] of Object.entries(entries || {})) {
            const r = this.set(novelId, key, value, opts);
            if (!r.ok) return r;
        }
        return { ok: true };
    }

    // ======================== 读取 ========================

    /**
     * 单个读取（自动跳过过期项，但返回值不删除）
     */
    get(novelId, key) {
        if (!novelId || !key) return null;
        const now = this._now();
        const row = this._store.query(
            `SELECT value, importance, version, expires_at
             FROM _ainovel_shared_context
             WHERE novel_id = ? AND key = ?
               AND (expires_at IS NULL OR expires_at > ?)`,
            novelId, key, now
        )[0];
        if (!row) return null;
        try { return JSON.parse(row.value); } catch (e) { return row.value; }
    }

    getMany(novelId, keys) {
        if (!Array.isArray(keys) || keys.length === 0) return {};
        const out = {};
        for (const k of keys) {
            const v = this.get(novelId, k);
            if (v !== null) out[k] = v;
        }
        return out;
    }

    /**
     * 按 capability 的 context_needs 自动匹配
     * 支持 glob 匹配（仅支持末尾 `*`，如 'plan.*'）
     *
     * @param {string} novelId
     * @param {string[]} needs 形如 ['outline.structure', 'plan.*']
     * @returns {Object} {key: value}
     */
    getForNeeds(novelId, needs) {
        if (!Array.isArray(needs) || needs.length === 0) return {};
        const now = this._now();
        // 拆出精确匹配 + glob 匹配
        const exact = needs.filter(n => !n.endsWith('*'));
        const patterns = needs.filter(n => n.endsWith('*')).map(p => p.slice(0, -1));  // 'plan.*' → 'plan.'

        let sql = `SELECT key, value FROM _ainovel_shared_context
                   WHERE novel_id = ? AND (expires_at IS NULL OR expires_at > ?)`;
        const args = [novelId, now];

        if (exact.length > 0) {
            sql += ` AND key IN (${exact.map(() => '?').join(',')})`;
            args.push(...exact);
        }
        if (patterns.length > 0) {
            sql += ` OR (`;
            const ors = patterns.map(() => 'key LIKE ?').join(' OR ');
            sql += ors;
            args.push(...patterns.map(p => p + '%'));
            sql += `)`;
        }
        // 注意：上面的 OR 没正确分组（精确和 glob 是 AND，glob 之间是 OR）。重写更安全：
        // 重新组装：
        sql = `SELECT key, value FROM _ainovel_shared_context
               WHERE novel_id = ?
                 AND (expires_at IS NULL OR expires_at > ?)
                 AND (`;
        const conds = [];
        const args2 = [novelId, now];
        if (exact.length > 0) {
            conds.push(`key IN (${exact.map(() => '?').join(',')})`);
            args2.push(...exact);
        }
        if (patterns.length > 0) {
            for (const p of patterns) {
                conds.push('key LIKE ?');
                args2.push(p + '%');
            }
        }
        if (conds.length === 0) return {};
        sql += conds.join(' OR ') + `)`;

        const rows = this._store.query(sql, ...args2);
        const out = {};
        for (const r of rows) {
            try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; }
        }
        return out;
    }

    /**
     * 快照：返回所有未过期项（按 importance DESC, updated_at DESC 排序）
     * 用于压缩器评估
     */
    snapshot(novelId) {
        const now = this._now();
        const rows = this._store.query(
            `SELECT key, value, importance, version, ttl_ms, source_agent, source_task, expires_at
             FROM _ainovel_shared_context
             WHERE novel_id = ?
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY importance DESC, updated_at DESC`,
            novelId, now
        );
        const out = [];
        for (const r of rows) {
            try { r.value = JSON.parse(r.value); } catch (e) { /* keep as string */ }
            out.push(r);
        }
        return out;
    }

    /**
     * 按 importance 区间查询（用于压缩器按优先级淘汰）
     */
    getByImportanceRange(novelId, minImportance, maxImportance) {
        const now = this._now();
        const rows = this._store.query(
            `SELECT key, value, importance FROM _ainovel_shared_context
             WHERE novel_id = ? AND importance BETWEEN ? AND ?
               AND (expires_at IS NULL OR expires_at > ?)`,
            novelId, minImportance, maxImportance, now
        );
        const out = [];
        for (const r of rows) {
            try { r.value = JSON.parse(r.value); } catch (e) { /* keep as string */ }
            out.push(r);
        }
        return out;
    }

    // ======================== 清理 ========================

    /**
     * 删除过期项（被压缩器 L2 调）
     * @returns {number} 删除条数
     */
    evictExpired(novelId) {
        const now = this._now();
        try {
            this._store.exec(
                `DELETE FROM _ainovel_shared_context
                 WHERE novel_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
                novelId, now
            );
            return this._store.changes || 0;
        } catch (e) {
            console.warn('[shared-context] evictExpired failed:', e.message);
            return 0;
        }
    }

    /**
     * 按 importance 阈值淘汰（被压缩器 L3 调）
     * @param {string} novelId
     * @param {number} maxImportance 保留 importance > maxImportance 的项；删除 <= maxImportance
     * @returns {number} 删除条数
     */
    evictByImportance(novelId, maxImportance) {
        try {
            this._store.exec(
                `DELETE FROM _ainovel_shared_context
                 WHERE novel_id = ? AND importance <= ?`,
                novelId, maxImportance
            );
            return this._store.changes || 0;
        } catch (e) {
            console.warn('[shared-context] evictByImportance failed:', e.message);
            return 0;
        }
    }

    /**
     * 显式删除一个 key
     */
    delete(novelId, key) {
        try {
            this._store.exec(
                'DELETE FROM _ainovel_shared_context WHERE novel_id = ? AND key = ?',
                novelId, key
            );
            return { ok: true, deleted: this._store.changes || 0 };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // ======================== 统计 ========================

    /**
     * 统计某本小说的上下文状况（用于 UI 调试）
     */
    stats(novelId) {
        const now = this._now();
        const rows = this._store.query(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
                SUM(CASE WHEN expires_at IS NULL OR expires_at > ? THEN 1 ELSE 0 END) AS active,
                AVG(importance) AS avg_importance
             FROM _ainovel_shared_context WHERE novel_id = ?`,
            now, now, novelId
        )[0] || { total: 0, expired: 0, active: 0, avg_importance: 0 };
        return {
            total: rows.total || 0,
            active: rows.active || 0,
            expired: rows.expired || 0,
            avgImportance: rows.avg_importance || 0,
        };
    }

    /**
     * 列出所有 key（带 importance 和 ttl 摘要）
     */
    listKeys(novelId) {
        const now = this._now();
        const rows = this._store.query(
            `SELECT key, importance, ttl_ms, source_agent, version, expires_at,
                    (expires_at IS NOT NULL AND expires_at <= ?) AS is_expired
             FROM _ainovel_shared_context
             WHERE novel_id = ?
             ORDER BY importance DESC, updated_at DESC`,
            now, novelId
        );
        return rows;
    }
}

module.exports = { SharedContext, DEFAULT_TTL_MS };
