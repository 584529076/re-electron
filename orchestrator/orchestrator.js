// orchestrator/orchestrator.js
// Sprint 2: 主入口 — run(plan)
//
// 设计：
//   1. plan.tasks 解析为 TaskGraph
//   2. 死锁检测（hasCycle）→ throw
//   3. 循环：从 graph.getReady() 取出可跑 task → capability-router.match → scheduler.dispatch
//   4. 等任一 task 完成 → 标记 done / failed / cancelled
//   5. 失败时 L1 retry（同 agent 重试 maxRetries 次） → L2 fallback（用 fallback agent）
//   6. 全图 done / 无 ready 且 running 空 → 结束
//
// 复用：
//   - TaskGraph（orchestrator/task-graph.js）
//   - CapabilityRouter（orchestrator/capability-router.js）
//   - Scheduler（orchestrator/scheduler.js）
//   - 调用方注入 executor：async (task, agentName, {signal, attempt}) => result
//     这是 novel-engine 的 _runAgent 的薄包装层
//
// 事件（emit）：
//   - orchestrator_started {novelId, totalTasks, planName}
//   - orchestrator_task_started {taskId, capability, agentName, attempt}
//   - orchestrator_task_finished {taskId, result}
//   - orchestrator_task_failed {taskId, error, willRetry, fallback}
//   - orchestrator_task_skipped {taskId, reason}
//   - orchestrator_finished {novelId, result, stats}
//   - orchestrator_failed {novelId, error, stats}

'use strict';

const { TaskGraph, TERMINAL_STATUSES } = require('./task-graph');
const { Scheduler } = require('./scheduler');

const DEFAULT_MAX_RETRIES = 2;   // L1 retry 次数（同 agent）
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;   // 5 分钟单 task 超时

class Orchestrator {
    /**
     * @param {object} opts
     * @param {CapabilityRouter} opts.router
     * @param {Scheduler}        [opts.scheduler]   默认 new Scheduler({maxParallel: 3})
     * @param {Function}         opts.executor      async (task, agentName, {signal, attempt}) => result
     * @param {Function}         [opts.emit]        (eventName, payload) => void
     * @param {number}           [opts.maxRetries=2]
     * @param {number}           [opts.taskTimeoutMs=5*60*1000]
     * @param {Function}         [opts.criticInvoke]    async (input) => critic agent result；L3 用
     * @param {Function}         [opts.supervisorInvoke] async (input) => supervisor agent result；L4 用
     * @param {Function}         [opts.isCriticalTask]  (task) => boolean；L4 skip 决策依据
     * @param {Function}         [opts.resolveResume]   () => Promise<{action: 'resume'|'abort'|'modify', plan?}>, L5 用
     */
    constructor({ router, executor, scheduler = null, emit = null, maxRetries = DEFAULT_MAX_RETRIES, taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
                  criticInvoke = null, supervisorInvoke = null, isCriticalTask = null, resolveResume = null } = {}) {
        if (!router) throw new Error('Orchestrator: router 必填');
        if (typeof executor !== 'function') throw new Error('Orchestrator: executor 必填');
        this._router = router;
        this._executor = executor;
        this._scheduler = scheduler || new Scheduler({ maxParallel: DEFAULT_MAX_PARALLEL });
        this._emit = emit || (() => {});
        this._maxRetries = maxRetries;
        this._taskTimeoutMs = taskTimeoutMs;

        // Sprint 5: 5 级失败恢复相关钩子（都为可选，缺失时优雅降级到 L2）
        this._criticInvoke = criticInvoke;
        this._supervisorInvoke = supervisorInvoke;
        this._isCriticalTask = isCriticalTask || (() => true);  // 默认所有 task 都是 critical
        this._resolveResume = resolveResume;

        // 当前运行的 plan 状态
        this._currentPlan = null;     // {novelId, plan, graph, scheduler, taskAgents}
        this._cancelled = false;
        this._paused = false;         // Sprint 5: L5 暂停
        this._pauseResolver = null;   // 暂停时主循环 await 这；resume/abort 由外部调 _resume() resolve
    }

    /**
     * 主入口
     * @param {object} plan
     * @param {string} [plan.name]
     * @param {string} [plan.novelId]
     * @param {Array<object>} plan.tasks  TaskGraph 节点
     * @returns {Promise<{ok, graph, stats}>}
     */
    async run(plan) {
        // 错误路径统一返回 stats={dispatched:0,completed:0,failed:0,retried:0,fallback:0,skipped:0}
        // 让调用方（novel-engine 的 outline/chapter pipeline）安全访问 result.stats.failed
        const emptyStats = () => ({ dispatched: 0, completed: 0, failed: 0, retried: 0, fallback: 0, skipped: 0 });

        if (!plan || !Array.isArray(plan.tasks)) {
            return { ok: false, error: 'plan.tasks 必填数组', graph: null, stats: emptyStats() };
        }
        if (this._currentPlan) {
            return { ok: false, error: '已有 plan 在运行；请先 cancel()', graph: null, stats: emptyStats() };
        }

        // 1. 解析 → graph
        const graph = new TaskGraph();
        try {
            for (const t of plan.tasks) {
                if (!t || !t.id) return { ok: false, error: 'plan.tasks 每项 id 必填', graph, stats: emptyStats() };
                if (!t.capability) return { ok: false, error: `task ${t.id}: capability 必填`, graph, stats: emptyStats() };
                graph.addNode({
                    id: t.id,
                    capability: t.capability,
                    depends_on: t.depends_on || [],
                    input: t.input || {},
                    budget: t.budget || null,
                    maxRetries: typeof t.maxRetries === 'number' ? t.maxRetries : this._maxRetries,
                    fallback: Array.isArray(t.fallback) ? t.fallback : null,
                    // 业务字段
                    label: t.label || t.id,
                    meta: t.meta || {},
                });
            }
        } catch (e) {
            return { ok: false, error: 'TaskGraph 构造失败: ' + e.message, graph, stats: emptyStats() };
        }

        // 2. 死锁检测
        if (graph.hasCycle()) {
            return { ok: false, error: 'plan 含循环依赖', graph, stats: emptyStats() };
        }

        this._currentPlan = { novelId: plan.novelId || null, plan, graph, taskAgents: new Map(), taskAttempts: new Map() };
        this._cancelled = false;
        this._paused = false;
        this._pauseResolver = null;
        const startedAt = Date.now();
        const stats = { dispatched: 0, completed: 0, failed: 0, retried: 0, fallback: 0, skipped: 0 };

        this._emit('orchestrator_started', {
            novelId: plan.novelId || null,
            planName: plan.name || null,
            totalTasks: plan.tasks.length,
            startedAt,
        });

        try {
            // 3. 主循环
            while (!graph.isAllDone()) {
                // Sprint 5: 暂停检测 —— 等待 _resume() / cancel()
                if (this._paused && !this._cancelled) {
                    this._emit('orchestrator_paused', {
                        novelId: plan.novelId || null,
                        reason: 'awaiting user decision (L5)',
                    });
                    await new Promise((resolve) => { this._pauseResolver = resolve; });
                }

                const ready = graph.getReady();

                if (this._cancelled) {
                    // 取消：把所有 pending → skipped
                    for (const t of ready) graph.markSkipped(t.id, 'cancelled');
                    break;
                }

                // 3a. 派发 ready
                for (const task of ready) {
                    await this._dispatchTask(task, stats);
                }

                // 3b. 如果还有 running 的，等任意一个完成
                if (!graph.isAllDone() && this._scheduler.status().running.length > 0) {
                    await this._scheduler.waitForAny();
                }

                // 3c. 拉取 finished，处理结果
                const finished = this._scheduler.collectFinished();
                for (const r of finished) {
                    if (r.error) {
                        const willRetry = await this._handleFailure(r, graph, stats);
                        if (!willRetry) {
                            stats.failed++;
                            graph.markFailed(r.taskId, r.error.message || String(r.error));
                        }
                    } else {
                        stats.completed++;
                        graph.markDone(r.taskId, r.result);
                        this._emit('orchestrator_task_finished', { taskId: r.taskId, result: r.result });
                    }
                }

                // 3d. 同时检查：若没有 running 且 queue 空，且没有 ready task 还没处理
                // → 说明剩下的 pending 都是依赖未满足（但还没失败）的；继续下一轮让 ready 自然填充
                const freshReady = graph.getReady();
                if (!graph.isAllDone() &&
                    this._scheduler.status().running.length === 0 &&
                    this._scheduler.status().queued.length === 0 &&
                    freshReady.length === 0) {
                    // 真正的死锁：所有 pending 的依赖都已 failed/skipped（不可解）
                    // 注意：freshReady 用最新的 getReady()，避免上一轮的 ready 还没消化完就误判
                    let hasUnresolved = false;
                    for (const t of graph.all()) {
                        if (t.status === 'pending') {
                            // 检查依赖是否都已 terminal（completed/failed/skipped）
                            const depsTerminal = t.depends_on.every(d => {
                                const dep = graph.getNode(d);
                                return dep && ['completed', 'failed', 'skipped'].includes(dep.status);
                            });
                            if (depsTerminal) {
                                // 依赖都终态了但还是 pending — 不可解（应该不会出现，但防御）
                                graph.markSkipped(t.id, 'unresolvable-dependencies');
                                hasUnresolved = true;
                            }
                            // 否则依赖还有 in_progress 的（理论上不会到这里，因为 freshReady.length === 0）
                            // 或依赖都不是终态的（无解）
                        }
                    }
                    if (hasUnresolved) break;
                    // 否则进入下一轮迭代，让 freshReady 自然填充
                }
            }

            const finished = Date.now();
            const result = {
                ok: !this._cancelled && graph.getFailed().length === 0,
                graph,
                stats: Object.assign({ durationMs: finished - startedAt }, stats),
            };
            this._emit('orchestrator_finished', {
                novelId: plan.novelId || null,
                ok: result.ok,
                stats: result.stats,
            });
            return result;
        } catch (e) {
            this._emit('orchestrator_failed', { novelId: plan.novelId || null, error: e.message || String(e), stats });
            return { ok: false, error: e.message || String(e), graph, stats };
        } finally {
            this._currentPlan = null;
        }
    }

    /**
     * 取消正在运行的 plan（标记 cancelled；下个循环迭代所有 pending → skipped）
     */
    cancel(reason = 'user-cancelled') {
        this._cancelled = true;
        if (this._currentPlan && this._currentPlan.graph) {
            for (const t of this._currentPlan.graph.all()) {
                if (t.status === 'in_progress' && this._scheduler) {
                    this._scheduler.cancel(t.id);
                }
            }
        }
        // 如果主循环正在等 pause，唤醒它（让其退出）
        if (this._pauseResolver) {
            try { this._pauseResolver(); } catch (e) {}
            this._pauseResolver = null;
        }
        this._emit('orchestrator_cancelled', { reason });
    }

    /**
     * Sprint 5: 暂停整个 plan（L5 触发时调用）
     * 主循环会 await 一个内部 promise；外部 _resume(action) 后主循环继续。
     */
    pause(reason = 'plan_paused') {
        if (this._cancelled) return;
        this._paused = true;
        this._emit('orchestrator_pause_requested', { reason });
    }

    /**
     * Sprint 5: 恢复 paused plan
     * @param {string} action  'resume' | 'abort' | 'modify'
     */
    resume(action = 'resume', extra = null) {
        if (!this._paused) return false;
        this._paused = false;
        if (action === 'abort') {
            this.cancel('user-abort-from-pause');
            if (this._pauseResolver) { try { this._pauseResolver(); } catch (e) {} this._pauseResolver = null; }
            return true;
        }
        this._emit('orchestrator_resumed', { action, extra });
        if (this._pauseResolver) { try { this._pauseResolver(); } catch (e) {} this._pauseResolver = null; }
        return true;
    }

    /**
     * Sprint 5: 当前是否处于 paused 状态
     */
    isPaused() {
        return this._paused;
    }

    /**
     * 当前状态（IPC / 调试）
     */
    status() {
        if (!this._currentPlan) return { running: false };
        const g = this._currentPlan.graph;
        return {
            running: true,
            novelId: this._currentPlan.novelId,
            planName: this._currentPlan.plan.name || null,
            taskSummary: {
                total: g.size(),
                pending: g.all().filter(t => t.status === 'pending').length,
                in_progress: g.all().filter(t => t.status === 'in_progress').length,
                completed: g.all().filter(t => t.status === 'completed').length,
                failed: g.all().filter(t => t.status === 'failed').length,
                skipped: g.all().filter(t => t.status === 'skipped').length,
            },
            scheduler: this._scheduler.status(),
        };
    }

    /**
     * Sprint 4: 给前端 DAG 可视化用的完整 plan 快照。
     * 包含每个 task 的 id/capability/status/depends_on/agentName/attempt + meta，
     * 以及 edges（[{from, to}]）便于画箭头。
     * @returns {{novelId, planName, tasks, edges} | null}
     */
    getPlanSnapshot() {
        if (!this._currentPlan) return null;
        const g = this._currentPlan.graph;
        const tasks = g.all().map(t => ({
            id: t.id,
            capability: t.capability,
            type: t.type || 'agent_call',
            status: t.status,
            depends_on: Array.isArray(t.depends_on) ? t.depends_on.slice() : [],
            agentName: this._currentPlan.taskAgents.get(t.id) || null,
            attempt: this._currentPlan.taskAttempts.get(t.id) || 1,
            input: t.input || null,
            meta: t.meta || {},
            result: t.result || null,
            error: t.error || null,
        }));
        const edges = [];
        for (const t of tasks) {
            for (const d of t.depends_on) edges.push({ from: d, to: t.id });
        }
        return {
            novelId: this._currentPlan.novelId,
            planName: this._currentPlan.plan.name || null,
            tasks,
            edges,
        };
    }

    /**
     * Sprint 4: 历史 plan 列表（最近 N 个，用于 DAG 历史回放）。
     * 暂时只暴露当前 plan；如果以后需要历史 plan 可以加个 _planHistory 数组。
     */
    listPlans() {
        if (!this._currentPlan) return [];
        return [{
            novelId: this._currentPlan.novelId,
            planName: this._currentPlan.plan.name || null,
            active: true,
            tasks: this._currentPlan.plan.tasks.length,
        }];
    }

    // ======================== 内部 ========================

    /**
     * 把 task 派到 scheduler
     */
    async _dispatchTask(task, stats) {
        // 路由：已选过 agent 的（重试 / fallback）直接用；否则 match
        let agentName = this._currentPlan.taskAgents.get(task.id);
        let excludeAgents = task._excludeAgents || [];
        // attempt：本次运行的尝试序号（首次 = 1；_handleFailure 已把它设到下一次）
        const attempt = this._currentPlan.taskAttempts.get(task.id) || 1;
        try {
            agentName = this._router.match(task.capability, { excludeAgents, taskId: task.id, novelId: this._currentPlan.novelId });
        } catch (e) {
            // NO_CANDIDATE：无可用 agent。必须 markFailed，否则 task 留在 pending → 死循环
            this._currentPlan.graph.markFailed(task.id, e.message || String(e));
            stats.failed++;
            this._emit('orchestrator_task_failed', { taskId: task.id, error: e.message, willRetry: false, fallback: null });
            return false;
        }

        this._currentPlan.taskAgents.set(task.id, agentName);
        // 不要在 _dispatchTask 里再自增 attempt —— _handleFailure 已经设好了"下一次"序号
        this._currentPlan.taskAttempts.set(task.id, attempt);

        graph_markStarted_safe(this._currentPlan.graph, task.id);
        stats.dispatched++;

        // ★ 解析 task.input：支持 function(inputCtx) → object
        //    供下游 phase 用 graph 的 outputs 拼装自己的 input
        const resolvedInput = this._resolveTaskInput(task, this._currentPlan.graph);

        this._emit('orchestrator_task_started', {
            taskId: task.id,
            capability: task.capability,
            agentName,
            attempt,
        });

        // 注入超时 + 已解析 input
        const executor = this._wrapExecutor(task, agentName, attempt, resolvedInput);

        try {
            await this._scheduler.dispatch(task, agentName, executor, resolvedInput);
            return true;
        } catch (e) {
            // 队列满 → 直接标记失败
            this._currentPlan.graph.markFailed(task.id, e.message);
            stats.failed++;
            this._emit('orchestrator_task_failed', { taskId: task.id, error: e.message, willRetry: false });
            return false;
        }
    }

    /**
     * 解析 task.input：
     *   - 函数 (inputCtx) => object → 调一次，把结果作为 resolved input
     *     inputCtx 暴露 { task, graph, novelId, jobId }
     *   - 普通对象 → 直接返回
     *   - undefined → 返回空对象
     */
    _resolveTaskInput(task, graph) {
        if (typeof task.input === 'function') {
            try {
                const ctx = {
                    task,
                    graph,
                    novelId: this._currentPlan.novelId,
                    jobId: this._currentPlan.plan && this._currentPlan.plan.jobId || null,
                };
                const resolved = task.input(ctx);
                return resolved == null ? {} : resolved;
            } catch (e) {
                console.warn(`[orchestrator] task ${task.id} input resolver threw:`, e.message);
                return {};
            }
        }
        return task.input || {};
    }

    _wrapExecutor(task, agentName, attempt, resolvedInput = {}) {
        const self = this;
        return async (t, agent, ctx, input) => {
            const { signal } = ctx;
            // 用 AbortController 触发超时 — 不留 unhandled rejection
            const timeoutAc = new AbortController();
            const composedSignal = signal
                ? composeSignals(signal, timeoutAc.signal)
                : timeoutAc.signal;

            let timer = null;
            const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    try { timeoutAc.abort('task-timeout'); } catch {}
                    reject(new Error(`task ${task.id} 超时（${self._taskTimeoutMs}ms）`));
                }, self._taskTimeoutMs);
                if (typeof timer.unref === 'function') timer.unref();
            });

            // 关键：attach noop catch 防止 timeoutPromise 变成 unhandled rejection
            // （race 已 settle 后 timeoutPromise 的 reject 会被吞掉）
            timeoutPromise.catch(() => { /* handled by race */ });

            try {
                // 用 resolve 出的 input（fallback 到 wrapExecutor 闭包里的 resolvedInput）
                const effectiveInput = input != null ? input : resolvedInput;
                // ★ 防御：如果 task.meta 没有 novelId（plan-builder 漏填），从 plan.novelId 兜底
                //   并补到 meta 和 input 里，避免 executor 抛「task meta 缺 novelId」
                const meta = (t && t.meta) || {};
                if (!meta.novelId && self._currentPlan && self._currentPlan.novelId) {
                    t.meta = Object.assign({}, meta, { novelId: self._currentPlan.novelId });
                }
                if (effectiveInput && !effectiveInput.novelId && self._currentPlan && self._currentPlan.novelId) {
                    effectiveInput.novelId = self._currentPlan.novelId;
                }
                const result = await Promise.race([
                    self._executor(t, agent, { signal: composedSignal, attempt }, effectiveInput),
                    timeoutPromise,
                ]);
                if (timer) clearTimeout(timer);
                return result;
            } finally {
                if (timer) clearTimeout(timer);
            }
        };
    }

    /**
     * 处理 task 失败：L1 retry（同 agent 重试）/ L2 fallback（换 agent）
     * @returns {Promise<boolean>} true 表示 task 还会再跑（重试 / fallback）
     */
    async _handleFailure(finished, graph, stats) {
        const task = graph.getNode(finished.taskId);
        if (!task) return false;
        const attempt = this._currentPlan.taskAttempts.get(task.id) || 1;
        const maxRetries = task.maxRetries || this._maxRetries;

        // L1: 同 agent retry（如果还没到上限）
        if (attempt <= maxRetries) {
            this._currentPlan.taskAttempts.set(task.id, attempt + 1);
            stats.retried++;
            this._emit('orchestrator_task_failed', {
                taskId: task.id,
                error: finished.error.message,
                willRetry: true,
                fallback: false,
                attempt: attempt + 1,
                level: 'L1_retry',
            });
            // 重新派发（graph 把它从 failed 拉回 pending）
            graph.resetToPending(task.id);
            await this._dispatchTask(task, stats);
            return true;
        }

        // L2: fallback agent
        const excludeAgents = (task._excludeAgents || []).concat([finished.agentName]);
        const fallbackList = task.fallback || this._router.getFallback(task.capability, { fromAgent: finished.agentName, usedAgents: excludeAgents });
        if (fallbackList.length > 0) {
            const newAgent = fallbackList[0];
            this._currentPlan.taskAgents.set(task.id, newAgent);
            const maxRet = task.maxRetries || this._maxRetries;
            this._currentPlan.taskAttempts.set(task.id, maxRet + 1);
            task._excludeAgents = excludeAgents;
            stats.fallback++;
            this._emit('orchestrator_task_failed', {
                taskId: task.id,
                error: finished.error.message,
                willRetry: true,
                fallback: true,
                newAgent,
                level: 'L2_fallback',
            });
            graph.resetToPending(task.id);
            await this._dispatchTask(task, stats);
            return true;
        }

        // L3: critic 评估
        const criticVerdict = await this._invokeCritic(task, finished, graph);
        if (criticVerdict && criticVerdict.recoverable && criticVerdict.suggestedAction === 'retry') {
            // recoverable → 重试（不同 input），但仍要有限度 —— 简单起见 L3 走 1 次
            const l3Max = 1;
            const l3Attempt = this._currentPlan.taskAttempts.get(task.id) || attempt;
            if (l3Attempt <= maxRetries + 1 + l3Max) {
                this._currentPlan.taskAttempts.set(task.id, l3Attempt + 1);
                stats.retried++;
                this._emit('orchestrator_task_failed', {
                    taskId: task.id,
                    error: finished.error.message,
                    willRetry: true,
                    fallback: false,
                    level: 'L3_critic_retry',
                    criticVerdict,
                });
                graph.resetToPending(task.id);
                await this._dispatchTask(task, stats);
                return true;
            }
        }

        // L4: supervisor 决策（skip non-critical / 进入 L5）
        const supervisorVerdict = await this._invokeSupervisor(task, finished, graph, criticVerdict);
        if (supervisorVerdict && supervisorVerdict.verdict === 'skip' &&
            supervisorVerdict.taskIds && supervisorVerdict.taskIds.includes(task.id)) {
            // 非关键任务 → skip
            graph.markSkipped(task.id, supervisorVerdict.reason || 'supervisor skip (L4)');
            stats.skipped++;
            this._emit('orchestrator_task_skipped', {
                taskId: task.id,
                reason: supervisorVerdict.reason || 'L4 skip',
                level: 'L4_supervisor_skip',
            });
            return true;   // 已 markSkipped，不再 markFailed
        }

        // L5: 暂停 plan + 通知用户
        if (this._resolveResume) {
            try {
                this.pause('L5_critical_failure');
                const decision = await this._resolveResume({
                    task,
                    error: finished.error.message,
                    criticVerdict,
                    supervisorVerdict,
                });
                if (decision && decision.action === 'abort') {
                    this.cancel('user-abort-from-L5');
                    this._emit('orchestrator_task_failed', {
                        taskId: task.id,
                        error: finished.error.message,
                        willRetry: false,
                        level: 'L5_user_abort',
                    });
                    return false;
                }
                if (decision && decision.action === 'skip') {
                    graph.markSkipped(task.id, decision.reason || 'user-skip-from-L5');
                    stats.skipped++;
                    return true;
                }
                // resume / 其他：fall through 标 failed
            } catch (e) {
                // resolveResume 抛错 → 仍标 failed
            }
        } else {
            // 无 resolveResume 钩子：暂停主循环，等外部 _resume()
            this.pause('L5_critical_failure');
            this._emit('orchestrator_paused_awaiting_user', {
                taskId: task.id,
                error: finished.error.message,
                criticVerdict,
                supervisorVerdict,
            });
            // 等待 resume —— 主循环会自己处理；这里直接 markFailed 让主循环推进
        }

        // 真的失败
        this._emit('orchestrator_task_failed', {
            taskId: task.id,
            error: finished.error.message,
            willRetry: false,
            fallback: false,
            level: 'L5_final_fail',
        });
        return false;
    }

    // ====== Sprint 5: L3 / L4 钩子 ======

    /**
     * 调 critic agent 评估失败 task
     * 返回 null 表示 critic 不可用 / 调用失败 → caller 跳过 L3
     */
    async _invokeCritic(task, finished, graph) {
        if (!this._criticInvoke) return null;
        try {
            const recentHistory = graph.all()
                .filter(t => t.status === 'completed' || t.status === 'failed')
                .slice(-5)
                .map(t => ({ id: t.id, status: t.status, error: t.error || null }));
            const input = {
                taskId: task.id,
                taskContext: {
                    id: task.id,
                    capability: task.capability,
                    agentName: finished.agentName,
                    attempt: this._currentPlan.taskAttempts.get(task.id) || 1,
                    error: finished.error.message,
                },
                recentHistory,
            };
            const r = await this._criticInvoke(input);
            if (r && r.ok && r.output) return r.output;
        } catch (e) {
            this._emit('orchestrator_critic_error', { taskId: task.id, error: e.message });
        }
        return null;
    }

    /**
     * 调 supervisor agent 决策 skip / 进入 L5
     * 返回 null 表示 supervisor 不可用 → caller 默认所有 task critical → 进入 L5
     */
    async _invokeSupervisor(task, finished, graph, criticVerdict) {
        if (!this._supervisorInvoke) return null;
        try {
            const planSummary = {
                goal: this._currentPlan.plan.name || '',
                totalTasks: graph.size(),
                doneTasks: graph.all().filter(t => t.status === 'completed').length,
                failedTasks: graph.all().filter(t => t.status === 'failed').map(t => ({
                    id: t.id, capability: t.capability, error: t.error,
                })),
                remainingTasks: graph.all()
                    .filter(t => t.status === 'pending' || t.status === 'in_progress')
                    .map(t => ({ id: t.id, capability: t.capability })),
            };
            const failedTasks = [{
                id: task.id,
                capability: task.capability,
                agentName: finished.agentName,
                error: finished.error.message,
                criticVerdict,
            }];
            const input = { planSummary, failedTasks };
            const r = await this._supervisorInvoke(input);
            if (r && r.ok && r.output) return r.output;
        } catch (e) {
            this._emit('orchestrator_supervisor_error', { taskId: task.id, error: e.message });
        }
        return null;
    }
}

// 辅助：把 task 在 graph 里从任意状态拉回 pending（用于 retry）
function graph_markStarted_safe(graph, taskId) {
    // markStarted 内部应该把状态设为 in_progress；这里依赖 TaskGraph 实现
    try { graph.markStarted(taskId); } catch (e) { /* 如果已是 pending 也会 OK */ }
}

/**
 * 组合两个 AbortSignal：任一 abort 时，返回的 signal 也 abort。
 * 若任一已 abort，立即 abort 返回值。
 */
function composeSignals(a, b) {
    const ac = new AbortController();
    const propagate = (reason) => {
        if (ac.signal.aborted) return;
        try { ac.abort(reason); } catch {}
    };
    if (a && a.aborted) propagate(a.reason || 'compose-abort');
    else if (a) a.addEventListener('abort', () => propagate(a.reason || 'compose-abort'), { once: true });
    if (b && b.aborted) propagate(b.reason || 'compose-abort');
    else if (b) b.addEventListener('abort', () => propagate(b.reason || 'compose-abort'), { once: true });
    return ac.signal;
}

module.exports = {
    Orchestrator,
    DEFAULT_MAX_RETRIES,
    DEFAULT_MAX_PARALLEL,
    DEFAULT_TASK_TIMEOUT_MS,
};