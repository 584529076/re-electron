// orchestrator/capability-router.js
// Sprint 2: 按 capability 路由 task 到具体 agent。
//
// 设计要点：
//   - 输入：capability 字符串 + 可选排除列表（重试时排除刚失败的 agent）
//   - 输出：agent 名字（registry.json 中的 key）
//   - 决策优先级：
//       1. cost_per_call 升序（prompt + completion 总和最小）
//       2. 同 cost 时按定义顺序（registry.json 写入顺序）
//   - 失败兜底：调用方可通过 getFallback() 拿到链式 fallback 列表
//   - audit：每次匹配写 _ainovel_capability_log（task-supervisor / cost-controller 后续会读）
//
// 复用：registry.json 的结构与 shared-context.js 的 expect 一致（_meta + agents）

'use strict';

class CapabilityRouter {
    /**
     * @param {object} opts
     * @param {object} opts.registry      registry.json 解析后的对象（含 _meta）
     * @param {object} [opts.store]       KVDb 实例（可选，用于 capability_log 审计）
     * @param {Function} [opts.uuid]
     * @param {Function} [opts.now]
     */
    constructor({ registry, store = null, uuid = null, now = null } = {}) {
        if (!registry || typeof registry !== 'object') {
            throw new Error('CapabilityRouter: registry 必填');
        }
        this._meta = registry._meta || {};
        this._registry = registry;
        this._store = store;
        this._uuid = uuid || (() => 'rlog_' + Math.random().toString(36).slice(2, 10));
        this._now = now || (() => Math.floor(Date.now() / 1000));
        // 倒排索引：capability → [agentName, ...]（按 registry 写入顺序）
        this._index = this._buildIndex();
    }

    _buildIndex() {
        const idx = new Map();
        for (const [agentName, def] of Object.entries(this._registry)) {
            if (agentName === '_meta') continue;
            if (!def || !Array.isArray(def.capabilities)) continue;
            for (const cap of def.capabilities) {
                if (!idx.has(cap)) idx.set(cap, []);
                idx.get(cap).push(agentName);
            }
        }
        return idx;
    }

    /**
     * 列出能提供指定 capability 的所有 agent
     * @returns {string[]}  agent 名字列表
     */
    candidates(capability) {
        return (this._index.get(capability) || []).slice();
    }

    /**
     * 给定 capability + 排除列表，返回按 cost 升序排好的所有候选 agent。
     * @param {string} capability
     * @param {string[]} [excludeAgents]
     * @returns {Array<{agent, def, cost}>}
     */
    _rank(capability, excludeAgents = []) {
        const exclude = new Set(excludeAgents);
        const cands = (this._index.get(capability) || [])
            .filter(n => !exclude.has(n))
            .map(agentName => {
                const def = this._registry[agentName] || {};
                const cost = (def.cost_per_call && (
                    (def.cost_per_call.prompt_tokens || 0) +
                    (def.cost_per_call.completion_tokens || 0)
                )) || 0;
                return { agent: agentName, def, cost };
            });
        // cost 升序 + 同 cost 时维持原顺序（registry 写入顺序）
        cands.sort((a, b) => a.cost - b.cost);
        return cands;
    }

    /**
     * 匹配主 agent（最便宜且未被排除的）。
     * @param {string} capability
     * @param {object} [opts]
     * @param {string[]} [opts.excludeAgents]   被排除的 agent（重试用）
     * @param {string} [opts.taskId]            写 capability_log 时关联 task_id
     * @param {string} [opts.novelId]
     * @returns {string} agent 名字
     * @throws {Error} 无可用 agent
     */
    match(capability, opts = {}) {
        const ranked = this._rank(capability, opts.excludeAgents || []);
        if (ranked.length === 0) {
            const err = new Error(`无 agent 能提供 capability: ${capability}`);
            err.code = 'NO_CANDIDATE';
            err.capability = capability;
            err.excludeAgents = opts.excludeAgents || [];
            throw err;
        }
        const chosen = ranked[0].agent;
        this._audit(capability, ranked.map(r => r.agent), chosen, opts);
        return chosen;
    }

    /**
     * 取 fallback 链。
     *
     * 只使用 fromAgent 显式声明的 fallback 链（registry.json 中 agent 的 fallback 字段）。
     * 不会自动用 cost 排序的 candidates 兜底 —— L2 fallback 是"显式声明的备用 agent"，
     * 不是"猜一个便宜的试试"。
     *
     * @param {string} capability
     * @param {object} [opts]
     * @param {string} [opts.fromAgent]   上次失败的 agent；从它的 def.fallback 出发
     * @param {string[]} [opts.usedAgents]  已经用过的 agent（避免循环 fallback）
     * @returns {string[]}                排序后的 fallback agent 列表
     */
    getFallback(capability, opts = {}) {
        const usedAgents = opts.usedAgents || [];
        const fromAgent = opts.fromAgent || null;
        const all = this._index.get(capability) || [];
        const used = new Set(usedAgents);
        const ordered = [];

        // 只用 fromAgent 声明的 fallback 链
        if (fromAgent && this._registry[fromAgent]) {
            const fb = this._registry[fromAgent].fallback || [];
            for (const name of fb) {
                if (used.has(name)) continue;
                if (all.includes(name) && !ordered.includes(name)) ordered.push(name);
            }
        }
        return ordered;
    }

    /**
     * 全部 agent 元数据（调试 / 测试用）
     */
    listAgents() {
        return Object.entries(this._registry)
            .filter(([k]) => k !== '_meta')
            .map(([agentName, def]) => ({ agent: agentName, def }));
    }

    /**
     * 审计日志（_ainovel_capability_log 表）
     */
    _audit(capability, candidates, chosen, opts) {
        if (!this._store) return;
        try {
            const row = {
                id: this._uuid(),
                novel_id: opts.novelId || null,
                capability,
                matched_agent: chosen,
                alternatives: JSON.stringify(candidates),
                task_id: opts.taskId || null,
                created_at: this._now(),
            };
            this._store.exec(
                `INSERT INTO _ainovel_capability_log
                 (id, novel_id, capability, matched_agent, alternatives, task_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                row.id, row.novel_id, row.capability, row.matched_agent,
                row.alternatives, row.task_id, row.created_at
            );
        } catch (e) {
            // 审计失败不影响主流程
            console.warn('[capability-router] audit failed:', e.message);
        }
    }

    /**
     * 重新加载 registry（运行时可热更新）
     */
    reload(newRegistry) {
        this._registry = newRegistry;
        this._meta = newRegistry._meta || {};
        this._index = this._buildIndex();
    }
}

module.exports = { CapabilityRouter };