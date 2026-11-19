// orchestrator/scheduler.js
// Sprint 2: Worker Pool，并发受限的 task 调度器。
//
// 设计要点：
//   - maxParallel 同时最多跑 N 个 task
//   - dispatch(task, agentName, executor)  立刻尝试；满载则排队（maxQueueSize 上限）
//   - executor(task, agentName) → Promise<result>  由调用方注入
//   - collectFinished() 拉取所有已完成的 task（一次性消费，不阻塞新任务）
//   - waitForAny()        等任何一个 task 完成（pool 喂食用）
//   - cancel(taskId)       抢占：调用 executor.abortSignal.abort()
//   - pause() / resume()   全局暂停/恢复
//
// 与 _runAgent 的关系：scheduler 不直接调 LLM。调用方传入一个
//   async (task, agentName, { signal }) => result
// 闭包，在里面调 _runAgent 即可。这样保留 _runAgent 的所有 event / cost 追踪逻辑。
//
// 复用：与 novel-engine 的 TaskGraph 解耦——只暴露 (task, agentName) → result 的契约。

'use strict';

class Scheduler {
    /**
     * @param {object} [opts]
     * @param {number} [opts.maxParallel=3]    同时最多跑的 task 数
     * @param {number} [opts.maxQueueSize=50]  队列上限（满了 dispatch 抛 QUEUE_FULL）
     * @param {Function} [opts.now]
     * @param {Function} [opts.uuid]
     */
    constructor({ maxParallel = 3, maxQueueSize = 50, now = null, uuid = null } = {}) {
        if (maxParallel < 1) throw new Error('Scheduler: maxParallel 必须 >= 1');
        if (maxQueueSize < 0) throw new Error('Scheduler: maxQueueSize 必须 >= 0');
        this._maxParallel = maxParallel;
        this._maxQueueSize = maxQueueSize;
        this._now = now || (() => Date.now());
        this._uuid = uuid || (() => 'job_' + Math.random().toString(36).slice(2, 10));

        // running: Map<taskId, {task, agentName, signal, promise, resolveFinished, rejectFinished, startedAt}>
        this._running = new Map();
        // queue:   Array<{task, agentName, executor, resolveDispatch}>
        this._queue = [];
        // 暂停态：dispatch 时把 executor 排到 _queue 也立即返回，等到 resume 再真正派发
        this._paused = false;

        // 统计
        this._stats = {
            dispatched: 0,     // 真正进入 running 的次数
            queued: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            dropped: 0,
        };

        this._listeners = new Map();  // event → Set<fn>
    }

    // ======================== Public API ========================

    /**
     * 派发一个 task。
     *
     * @param {object} task          TaskGraph 节点（有 .id）
     * @param {string} agentName     路由选中的 agent
     * @param {Function} executor    async (task, agentName, {signal}, input) => result
     *                              executor 必须能从 signal 监听 abort
     * @param {object} [input]       调度时已解析好的 task input（透传给 executor 第 4 参）
     * @returns {Promise<void>}     不等 task 完成，只等"进入 running 或 抛错"
     */
    dispatch(task, agentName, executor, input = null) {
        if (!task || !task.id) throw new Error('Scheduler.dispatch: task.id 必填');
        if (typeof executor !== 'function') throw new Error('Scheduler.dispatch: executor 必填');

        // 已派发过（避免同一 taskId 重复进队列）
        if (this._running.has(task.id) || this._queue.some(q => q.task.id === task.id)) {
            throw new Error(`Scheduler.dispatch: task ${task.id} 已派发过`);
        }

        // 暂停中 → 直接排队（不占 running 槽位）
        if (this._paused) {
            if (this._queue.length >= this._maxQueueSize) {
                this._stats.dropped++;
                throw new Error('Scheduler: 队列满（暂停中）');
            }
            this._stats.queued++;
            // queued 立刻 resolve —— 调用方只关心"是否成功入队"
            this._queue.push({ task, agentName, executor, input });
            return Promise.resolve();
        }

        // 有空槽位 → 立即派发
        if (this._running.size < this._maxParallel) {
            this._stats.dispatched++;
            this._launch(task, agentName, executor, input);
            return Promise.resolve();
        }

        // 满载 → 排队
        if (this._queue.length >= this._maxQueueSize) {
            this._stats.dropped++;
            throw new Error('Scheduler: 队列满');
        }
        this._stats.queued++;
        // 同上，queued 立即 resolve
        this._queue.push({ task, agentName, executor, input });
        return Promise.resolve();
    }

    /**
     * 等任何一个 running task 完成。
     * 无人 running 且队列空 → 返回 {taskId: null, reason: 'idle'}
     *
     * @returns {Promise<{taskId: string|null, reason?: string, error?: Error}>}
     */
    waitForAny() {
        if (this._running.size === 0) {
            return Promise.resolve({ taskId: null, reason: this._queue.length === 0 ? 'idle' : 'queue-only' });
        }
        return new Promise(resolve => {
            // 任何完成都会 emit task_finished → 这里一次性 resolve 后立刻 off
            const handler = (event) => {
                this.off('task_finished', handler);
                this.off('task_failed', handler);
                this.off('task_cancelled', handler);
                resolve(event);
            };
            this.on('task_finished', handler);
            this.on('task_failed', handler);
            this.on('task_cancelled', handler);
        });
    }

    /**
     * 拉取已完成的 task 结果（一次性消费）。
     * @returns {Array<{taskId, agentName, result, error, finishedAt}>}
     */
    collectFinished() {
        const out = [];
        if (!this._finished || !this._finishedKeys) return out;
        for (const id of Array.from(this._finishedKeys)) {
            const r = this._finished.get(id);
            if (r) {
                out.push(r);
                this._finished.delete(id);
                this._finishedKeys.delete(id);
            }
        }
        return out;
    }

    /**
     * 取消 task（如果在队列中直接丢弃；如果在 running 则 abort）
     * @param {string} taskId
     * @returns {boolean} 是否真的发出了取消信号
     */
    cancel(taskId) {
        // 队列里
        const qIdx = this._queue.findIndex(q => q.task.id === taskId);
        if (qIdx >= 0) {
            const item = this._queue.splice(qIdx, 1)[0];
            this._stats.cancelled++;
            this._emit('task_cancelled', { taskId, reason: 'cancelled-from-queue', agentName: item.agentName });
            this._tryFillSlots();
            return true;
        }
        // 正在跑
        const running = this._running.get(taskId);
        if (running) {
            try {
                if (running.ac && typeof running.ac.abort === 'function') running.ac.abort('cancelled');
            } catch (e) { /* ignore */ }
            // stats.cancelled 在 executor 因 abort reject 时会递增
            return true;
        }
        return false;
    }

    /**
     * 暂停（不再派发新的到 running，但队列里的仍排着）
     */
    pause() { this._paused = true; this._emit('paused', {}); }

    /**
     * 恢复（按 maxParallel 重新派发队列里的）
     */
    resume() {
        this._paused = false;
        this._tryFillSlots();
        this._emit('resumed', {});
    }

    /**
     * 当前状态（调试 / IPC）
     */
    status() {
        return {
            running: Array.from(this._running.keys()).map(id => ({
                taskId: id,
                agentName: this._running.get(id).agentName,
                startedAt: this._running.get(id).startedAt,
                elapsedMs: this._now() - this._running.get(id).startedAt,
            })),
            queued: this._queue.map(q => q.task.id),
            paused: this._paused,
            stats: Object.assign({}, this._stats),
            maxParallel: this._maxParallel,
            maxQueueSize: this._maxQueueSize,
        };
    }

    /**
     * 事件订阅
     */
    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
        return () => this.off(event, handler);
    }
    off(event, handler) {
        const set = this._listeners.get(event);
        if (set) set.delete(handler);
    }

    // ======================== 内部 ========================

    _launch(task, agentName, executor, input = null) {
        // AbortSignal for cancel
        const ac = new AbortController();
        const signal = ac.signal;
        const jobId = this._uuid();
        const startedAt = this._now();

        let resolveFinished, rejectFinished;
        const donePromise = new Promise((res, rej) => { resolveFinished = res; rejectFinished = rej; });

        const entry = { task, agentName, ac, signal, jobId, startedAt, resolveFinished, rejectFinished, promise: donePromise };
        this._running.set(task.id, entry);

        this._emit('task_started', { taskId: task.id, agentName, jobId, startedAt });

        // 标志：executor 是否已经 settle（resolve/reject 任一）—— 防止 reject 来得比 resolve 晚时
        // 两次落库
        let settled = false;

        // 立刻起跑（不要 await，让 promise 在 event loop 内排上）
        Promise.resolve()
            .then(() => executor(task, agentName, { signal }, input))
            .then(
                (result) => {
                    if (settled) return;
                    settled = true;
                    this._running.delete(task.id);
                    // 即使 resolve 来了，只要 signal 已 abort，仍按 cancelled 处理
                    if (signal.aborted) {
                        this._stats.cancelled++;
                        this._emit('task_cancelled', { taskId: task.id, agentName, reason: signal.reason || 'aborted' });
                        resolveFinished({ taskId: task.id, error: new Error('cancelled') });
                    } else {
                        this._stats.completed++;
                        const finishedAt = this._now();
                        if (!this._finished) this._finished = new Map();
                        if (!this._finishedKeys) this._finishedKeys = new Set();
                        this._finished.set(task.id, {
                            taskId: task.id, agentName, result,
                            error: null, finishedAt,
                        });
                        this._finishedKeys.add(task.id);
                        this._emit('task_finished', { taskId: task.id, agentName, result, finishedAt });
                        resolveFinished({ taskId: task.id, result });
                    }
                    this._tryFillSlots();
                },
                (error) => {
                    if (settled) return;
                    settled = true;
                    this._running.delete(task.id);
                    if (signal.aborted) {
                        this._stats.cancelled++;
                        this._emit('task_cancelled', { taskId: task.id, agentName, reason: signal.reason || 'aborted' });
                        resolveFinished({ taskId: task.id, error });
                    } else {
                        this._stats.failed++;
                        if (!this._finished) this._finished = new Map();
                        if (!this._finishedKeys) this._finishedKeys = new Set();
                        this._finished.set(task.id, {
                            taskId: task.id, agentName, result: null,
                            error: error instanceof Error ? error : new Error(String(error)),
                            finishedAt: this._now(),
                        });
                        this._finishedKeys.add(task.id);
                        this._emit('task_failed', { taskId: task.id, agentName, error: error.message || String(error) });
                        resolveFinished({ taskId: task.id, error });
                    }
                    this._tryFillSlots();
                }
            );
    }

    _tryFillSlots() {
        if (this._paused) return;
        while (this._running.size < this._maxParallel && this._queue.length > 0) {
            const next = this._queue.shift();
            this._stats.dispatched++;
            this._launch(next.task, next.agentName, next.executor, next.input);
        }
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (!set) return;
        for (const fn of set) {
            try { fn(payload); } catch (e) { /* best effort */ }
        }
    }
}

module.exports = { Scheduler };