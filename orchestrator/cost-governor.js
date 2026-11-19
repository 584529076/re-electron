// orchestrator/cost-governor.js
// Sprint 5: 软成本治理（per-novel）
//
// 设计要点：
//   - 不设硬阈值 —— 用户决策"软提醒 + 降级建议"
//   - 包装 CostTracker：snapshot / shouldWarn / shouldAdvise
//   - 应在每 task 完成时调 onTaskCost() 累计
//   - 触发 advisory 时调 cost-controller agent（已在 Sprint 3 注册）拿降级建议
//   - 持久化 advisory 历史到 _ainovel_cost_advisory 表（可选），便于事后审计
//
// verdict 档位（与 cost-controller IDENTITY.md 对齐）：
//   - "ok"        : 累计 < 50% 阈值，不打扰
//   - "advisory"  : 50%–100%，emit 温和建议
//   - "urgent"    : > 100%，强烈建议降级（但仍不阻断）
//
// 5 级失败恢复中 cost-governor 的角色：
//   - L3 / L4 决策时调用 governor 提供 cost snapshot
//   - governor 返回 verdict = urgent 时，task-supervisor 可选地 skip best-effort 任务

'use strict';

const ADVISORY_COOLDOWN_MS = 60000;        // 同一本小说 advisory 最多 1 分钟 1 次
const DEFAULT_URGENT_RATIO = 1.0;          // urgent 阈值（成本/软阈值）
const DEFAULT_ADVISORY_RATIO = 0.5;        // advisory 阈值
const COST_CONTROLLER_CAP = 'cost.advisory';

class CostGovernor {
    /**
     * @param {object} opts
     * @param {object} opts.costTracker   CostTracker 实例
     * @param {Function} [opts.invokeAgent]   async (capability, input) => result
     * @param {Function} [opts.emit]         event emitter
     * @param {Function} [opts.now]
     */
    constructor({ costTracker, invokeAgent = null, emit = null, now = null } = {}) {
        if (!costTracker) throw new Error('CostGovernor: costTracker 必填');
        this._tracker = costTracker;
        this._invokeAgent = invokeAgent || (async () => ({ ok: false, error: 'no invokeAgent' }));
        this._emit = emit || (() => {});
        this._now = now || (() => Date.now());

        // 每本小说最近 advisory 时间戳（防止 LLM advisory 调用过频）
        this._lastAdvisoryAt = new Map();
    }

    // ===== 决策辅助 =====

    /**
     * 当前累计是否触发 soft warn（>= 100% 阈值）
     */
    shouldWarn(novelId) {
        const snap = this._tracker.snapshot(novelId);
        const threshold = snap.threshold || 0.0001;
        return (snap.cost / threshold) >= DEFAULT_URGENT_RATIO;
    }

    /**
     * 当前累计是否触发 advisory（>= 50% 阈值）
     */
    shouldAdvise(novelId) {
        const snap = this._tracker.snapshot(novelId);
        const threshold = snap.threshold || 0.0001;
        return (snap.cost / threshold) >= DEFAULT_ADVISORY_RATIO;
    }

    /**
     * 取累计快照
     */
    snapshot(novelId) {
        return this._tracker.snapshot(novelId);
    }

    /**
     * 估算剩余 plan 的预期成本（按 registry 的 cost_per_call）
     * @param {Array<{capability}>} remainingTasks
     * @param {object} registry      agents/registry.json 内容
     * @returns {{expected: number, byCapability: Record<string, number>}}
     */
    estimateRemaining(remainingTasks, registry = {}) {
        let total = 0;
        const byCapability = {};
        for (const t of remainingTasks || []) {
            const cap = t.capability || '';
            // 找最便宜候选的成本
            const candidates = Object.entries(registry)
                .filter(([k, def]) => k !== '_meta' && Array.isArray(def.capabilities) && def.capabilities.includes(cap));
            let cost = 0;
            if (candidates.length > 0) {
                const priced = candidates.map(([_, def]) => {
                    const p = def.cost_per_call || {};
                    const tk = (p.prompt_tokens || 0) + (p.completion_tokens || 0);
                    // 粗估 USD：4 美元 / 1M tokens（按主流 gpt-4 价位，可被覆盖）
                    return tk * 4 / 1_000_000;
                }).sort((a, b) => a - b);
                cost = priced[0];
            }
            total += cost;
            byCapability[cap] = (byCapability[cap] || 0) + cost;
        }
        return { expected: total, byCapability };
    }

    /**
     * 计算档位（ok / advisory / urgent）
     */
    computeVerdict(novelId) {
        const snap = this._tracker.snapshot(novelId);
        const t = snap.threshold || 0.0001;
        const ratio = snap.cost / t;
        if (ratio >= DEFAULT_URGENT_RATIO) return 'urgent';
        if (ratio >= DEFAULT_ADVISORY_RATIO) return 'advisory';
        return 'ok';
    }

    /**
     * 调 cost-controller agent 拿降级建议（带冷却）
     * @returns {Promise<{ok: bool, verdict, advisory, error?}>}
     */
    async getAdvisoryDecision(novelId, planSummary = null) {
        // 冷却
        const last = this._lastAdvisoryAt.get(novelId) || 0;
        if (this._now() - last < ADVISORY_COOLDOWN_MS) {
            return { ok: false, error: 'cooldown', verdict: 'ok', advisory: null };
        }
        const snap = this._tracker.snapshot(novelId);
        const input = {
            budgetSnapshot: {
                totalTokens: snap.tokens,
                totalCostUsd: snap.cost,
                totalCalls: snap.calls,
                softThresholdUsd: snap.threshold,
                warningSent: snap.warningSent,
                pendingFlush: snap.pendingFlush,
            },
            planSummary: planSummary || { remainingTasks: [], goal: '' },
        };
        let result;
        try {
            result = await this._invokeAgent(COST_CONTROLLER_CAP, input);
        } catch (e) {
            this._emit({ type: 'cost_governor_error', novelId, error: e.message });
            return { ok: false, error: e.message, verdict: 'ok', advisory: null };
        }
        this._lastAdvisoryAt.set(novelId, this._now());

        // result 形如 { ok, output: {verdict, advisory:{...}}, raw, ... }
        if (!result || !result.ok) {
            return { ok: false, error: (result && result.error) || 'agent 失败', verdict: 'ok', advisory: null };
        }
        const out = result.output || {};
        const verdict = ['ok', 'advisory', 'urgent'].includes(out.verdict) ? out.verdict : 'ok';
        const advisory = out.advisory || null;

        // 持久化 advisory（供事后审计 / 用户查）
        try {
            this._emit({
                type: 'cost_advisory',
                novelId,
                verdict,
                advisory,
                snapshot: input.budgetSnapshot,
                at: this._now(),
            });
        } catch (e) { /* best effort */ }

        return { ok: true, verdict, advisory };
    }

    /**
     * 把 advisory 中的建议展开成可执行的调度动作
     * （orchestrator._handleFailure 用 —— non-critical task 可被建议 skip）
     * @param {object} advisory   cost-controller 返回的 advisory 对象
     * @param {object} task       当前失败 task
     * @returns {{shouldSkip: bool, reason: string}|null}
     */
    applyAdvisoryToTask(advisory, task) {
        if (!advisory || !Array.isArray(advisory.suggestions)) return null;
        for (const sug of advisory.suggestions) {
            if (sug.type === 'skip_task' && Array.isArray(sug.taskIds) && sug.taskIds.includes(task.id)) {
                return {
                    shouldSkip: true,
                    reason: 'cost-controller 建议降级：' + (sug.reason || 'skip'),
                };
            }
            if (sug.type === 'downgrade_agent' && sug.from === task.agentName) {
                return {
                    shouldSkip: false,  // 不 skip，但可考虑换 agent（这里只 signal）
                    reason: 'cost-controller 建议换 agent 到：' + (sug.to || '?') + '（saving $' + sug.saving + '）',
                };
            }
        }
        return null;
    }
}

module.exports = {
    CostGovernor,
    ADVISORY_COOLDOWN_MS,
    DEFAULT_URGENT_RATIO,
    DEFAULT_ADVISORY_RATIO,
    COST_CONTROLLER_CAP,
};