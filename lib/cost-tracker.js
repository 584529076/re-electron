// lib/cost-tracker.js
// Sprint C-S1: 实时成本追踪（每本小说）
//
// 设计要点：
//   - 每次 _runAgent 完成后调一次 track()
//   - 内存累计 + 异步落 DB（每 5 秒批量写一次，避免每次 _runAgent 都写 DB 卡顿）
//   - 软阈值检查（默认 5 元）：超了 shouldWarn → true，让 _emit 通知前端
//   - 提供 snapshot 给 cost-governor 决策（Sprint 5 用）
//
// 与 _ainovel_budget 表的对应字段：
//   total_tokens_used, total_cost_usd, total_calls, soft_warning_threshold_usd, soft_warning_sent, compression_count

'use strict';

const DEFAULT_SOFT_THRESHOLD_USD = 5.0;
const FLUSH_INTERVAL_MS = 5000;

class CostTracker {
    /**
     * @param {object} opts
     * @param {object} opts.store       KVDb 实例
     * @param {Function} [opts.now]
     * @param {Function} [opts.uuid]
     */
    constructor({ store, now = null, uuid = null } = {}) {
        if (!store) throw new Error('CostTracker: store 必填');
        this._store = store;
        this._now = now || (() => Math.floor(Date.now() / 1000));
        this._uuid = uuid || (() => 'ct_' + Math.random().toString(36).slice(2, 10));
        // 内存累计缓存：novelId → {tokens, cost, calls, lastFlush}
        this._cache = new Map();
        this._flushTimer = null;
        this._listeners = [];  // (event) => void，event = {type: 'threshold_warn', novelId, totalCost}
        this._startFlushTimer();
    }

    /**
     * 取（或初始化）某本小说的内存条目。
     * total* = 累计总量（含 DB 里已有的），d* = 尚未落盘的增量。
     */
    _entry(novelId) {
        let c = this._cache.get(novelId);
        if (c) return c;
        let base = { tokens: 0, cost: 0, calls: 0, threshold: DEFAULT_SOFT_THRESHOLD_USD, warned: false };
        try {
            const row = this._store.query('SELECT * FROM _ainovel_budget WHERE novel_id = ?', novelId)[0];
            if (row) {
                base = {
                    tokens: row.total_tokens_used || 0,
                    cost: row.total_cost_usd || 0,
                    calls: row.total_calls || 0,
                    threshold: row.soft_warning_threshold_usd || DEFAULT_SOFT_THRESHOLD_USD,
                    warned: !!row.soft_warning_sent,
                };
            }
        } catch (e) { /* 表可能还没建，按 0 起算 */ }
        c = {
            totalTokens: base.tokens, totalCost: base.cost, totalCalls: base.calls,
            dTokens: 0, dCost: 0, dCalls: 0,
            threshold: base.threshold, warningSent: base.warned,
        };
        this._cache.set(novelId, c);
        return c;
    }

    /**
     * 追踪一次 agent 调用的成本
     * @param {string} novelId
     * @param {object} cost  {promptTokens, completionTokens, costUsd}
     */
    track(novelId, cost) {
        if (!novelId) return;
        const c = this._entry(novelId);
        const tk = (cost.promptTokens || 0) + (cost.completionTokens || 0);
        const usd = cost.costUsd || 0;

        c.totalTokens += tk; c.dTokens += tk;
        c.totalCost += usd;  c.dCost += usd;
        c.totalCalls += 1;   c.dCalls += 1;

        // 软阈值检查（基于累计总量，不受 flush 清零影响）
        if (!c.warningSent && c.totalCost >= c.threshold) {
            c.warningSent = true;
            this._emit({ type: 'threshold_warn', novelId, totalCost: c.totalCost, threshold: c.threshold });
        }
    }

    /**
     * 获取累计快照（cost-governor 用）
     */
    snapshot(novelId) {
        const c = this._entry(novelId);
        return {
            tokens: c.totalTokens,
            cost: c.totalCost,
            calls: c.totalCalls,
            threshold: c.threshold,
            warningSent: c.warningSent,
            pendingFlush: { tokens: c.dTokens, cost: c.dCost, calls: c.dCalls },
        };
    }

    /**
     * 设置软阈值（per-novel）
     */
    setThreshold(novelId, usd) {
        const c = this._entry(novelId);
        c.threshold = Number(usd) || DEFAULT_SOFT_THRESHOLD_USD;
        if (c.totalCost < c.threshold) c.warningSent = false;
        return c.threshold;
    }

    /**
     * 检查是否应软提醒
     */
    shouldWarn(novelId) {
        const c = this._entry(novelId);
        return c.totalCost >= c.threshold && !c.warningSent;
    }

    /**
     * 重置软提醒标记（用户已读后前端调）
     */
    acknowledgeWarn(novelId) {
        const c = this._entry(novelId);
        c.warningSent = true;
        try {
            this._store.exec(
                `UPDATE _ainovel_budget SET soft_warning_sent = 1, updated_at = ? WHERE novel_id = ?`,
                this._now(), novelId
            );
        } catch (e) { /* ignore */ }
    }

    /**
     * 记录一次压缩触发（用于 compression_count 字段）
     */
    trackCompression(novelId) {
        const c = this._entry(novelId);
        c.compressions = (c.compressions || 0) + 1;
        try {
            this._store.exec(
                `INSERT INTO _ainovel_budget (novel_id, compression_count, updated_at)
                 VALUES (?, 1, ?)
                 ON CONFLICT(novel_id) DO UPDATE SET
                   compression_count = compression_count + 1,
                   updated_at = excluded.updated_at`,
                novelId, this._now()
            );
        } catch (e) { /* ignore */ }
    }

    /**
     * 订阅事件（外部用来响应 threshold_warn 等）
     */
    on(handler) {
        this._listeners.push(handler);
        return () => {
            const i = this._listeners.indexOf(handler);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }

    _emit(event) {
        for (const l of this._listeners) {
            try { l(event); } catch (e) { /* best effort */ }
        }
    }

    // ======================== 内部：异步批量落 DB ========================

    _startFlushTimer() {
        if (this._flushTimer) return;
        this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
        // 不要因为这个定时器阻止进程退出（测试 / CLI 场景）
        if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
        // Node 退出时最后 flush 一次（stop() 时会解绑，避免测试里堆积监听器）
        if (typeof process !== 'undefined' && process.on) {
            this._beforeExit = () => this._flush(true);
            process.on('beforeExit', this._beforeExit);
        }
    }

    /**
     * 把内存累计刷到 DB（增量更新）
     */
    _flush(sync = false) {
        for (const [novelId, c] of this._cache.entries()) {
            if (c.dCalls === 0 && c.dCost === 0 && c.dTokens === 0) continue;
            try {
                this._store.exec(
                    `INSERT INTO _ainovel_budget
                     (novel_id, total_tokens_used, total_cost_usd, total_calls,
                      soft_warning_threshold_usd, soft_warning_sent, compression_count, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT compression_count FROM _ainovel_budget WHERE novel_id = ?), 0), ?)
                     ON CONFLICT(novel_id) DO UPDATE SET
                       total_tokens_used = total_tokens_used + excluded.total_tokens_used,
                       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
                       total_calls = total_calls + excluded.total_calls,
                       soft_warning_threshold_usd = excluded.soft_warning_threshold_usd,
                       soft_warning_sent = excluded.soft_warning_sent,
                       updated_at = excluded.updated_at`,
                    novelId, c.dTokens, c.dCost, c.dCalls,
                    c.threshold, c.warningSent ? 1 : 0, novelId, this._now()
                );
                // 只清增量，累计总量保留在内存
                c.dTokens = 0;
                c.dCost = 0;
                c.dCalls = 0;
            } catch (e) {
                console.warn('[cost-tracker] flush failed for', novelId, e.message);
            }
        }
    }

    /**
     * 立即强制 flush（被 novel-engine bootstrap 退出前调）
     */
    flushNow() {
        this._flush(true);
    }

    /**
     * 停止定时器（测试或退出时）
     */
    stop() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._beforeExit && typeof process !== 'undefined' && process.removeListener) {
            process.removeListener('beforeExit', this._beforeExit);
            this._beforeExit = null;
        }
    }
}

module.exports = { CostTracker, DEFAULT_SOFT_THRESHOLD_USD, FLUSH_INTERVAL_MS };
