// orchestrator/task-graph.js
// Sprint C-S1: DAG 引擎
//
// 核心能力：
//   1. 节点增删改查 + 依赖追踪
//   2. 拓扑排序：getReady() 返回依赖已满足的节点
//   3. 死锁检测：hasCycle() 防止 plan 含循环依赖
//   4. 状态机：pending → in_progress → completed / failed / skipped
//   5. 序列化：toJSON() / fromJSON() 便于持久化和传输
//
// Task 节点 schema（参考计划）：
//   {
//     id: 't_xxx',
//     type: 'agent_call' | 'decision' | 'aggregate',
//     capability: 'outline.synthesis',
//     input: {...},
//     depends_on: ['t_yyy', 't_zzz'],
//     budget: { soft_limit_tokens, soft_limit_usd },
//     fallback_strategy: 'retry' | 'reassign' | 'skip',
//     status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped',
//     result: any,         // 完成后填充
//     error: string,
//     matched_agent: string,  // router 匹配后填充
//     started_at: number,
//     finished_at: number,
//   }

'use strict';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped']);

class TaskGraph {
    constructor() {
        this._nodes = new Map();  // id → task
        this._dependents = new Map();  // id → Set<id>（反向索引，addNode 时维护）
    }

    /**
     * 添加节点
     * @param {object} task  必填 id, capability；其他字段可选
     * @returns {string} taskId
     */
    addNode(task) {
        if (!task || !task.id) throw new Error('task.id 必填');
        if (!task.capability && task.type !== 'aggregate') {
            throw new Error(`task ${task.id}: capability 必填（aggregate 类型除外）`);
        }
        const full = Object.assign({
            type: 'agent_call',
            input: {},
            depends_on: [],
            budget: {},
            fallback_strategy: 'reassign',
            status: 'pending',
            created_at: Date.now(),
        }, task);
        this._nodes.set(task.id, full);

        // 维护反向索引
        for (const dep of full.depends_on) {
            if (!this._dependents.has(dep)) this._dependents.set(dep, new Set());
            this._dependents.get(dep).add(task.id);
        }
        return task.id;
    }

    removeNode(taskId) {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        this._nodes.delete(taskId);
        // 清理反向索引
        for (const dep of node.depends_on) {
            const deps = this._dependents.get(dep);
            if (deps) {
                deps.delete(taskId);
                if (deps.size === 0) this._dependents.delete(dep);
            }
        }
        // 清理依赖此节点的引用
        const dependents = this._dependents.get(taskId);
        if (dependents) {
            for (const depId of dependents) {
                const depNode = this._nodes.get(depId);
                if (depNode) {
                    depNode.depends_on = depNode.depends_on.filter(d => d !== taskId);
                }
            }
            this._dependents.delete(taskId);
        }
        return true;
    }

    getNode(taskId) {
        return this._nodes.get(taskId) || null;
    }

    updateNode(taskId, patch) {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        // 如果 depends_on 变了，需要重建反向索引
        if (patch.depends_on && JSON.stringify(patch.depends_on) !== JSON.stringify(node.depends_on)) {
            // 清理旧的
            for (const dep of node.depends_on) {
                const deps = this._dependents.get(dep);
                if (deps) {
                    deps.delete(taskId);
                    if (deps.size === 0) this._dependents.delete(dep);
                }
            }
            // 建立新的
            for (const dep of patch.depends_on) {
                if (!this._dependents.has(dep)) this._dependents.set(dep, new Set());
                this._dependents.get(dep).add(taskId);
            }
        }
        Object.assign(node, patch);
        return true;
    }

    size() {
        return this._nodes.size;
    }

    all() {
        return Array.from(this._nodes.values());
    }

    /**
     * 依赖已满足且状态为 pending 的节点
     */
    getReady() {
        const out = [];
        for (const node of this._nodes.values()) {
            if (node.status !== 'pending') continue;
            const depsOk = node.depends_on.every(d => {
                const depNode = this._nodes.get(d);
                if (!depNode) return false;  // 依赖的节点不存在 = 不就绪
                return TERMINAL_STATUSES.has(depNode.status);
            });
            if (depsOk) out.push(node);
        }
        return out;
    }

    /**
     * 标记完成
     */
    markDone(taskId, result = null) {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        node.status = 'completed';
        node.result = result;
        node.finished_at = Date.now();
        return true;
    }

    /**
     * 标记失败
     */
    markFailed(taskId, error = '') {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        node.status = 'failed';
        node.error = String(error || '');
        node.finished_at = Date.now();
        return true;
    }

    /**
     * 标记跳过（被 critic/supervisor 决定放弃）
     */
    markSkipped(taskId, reason = '') {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        node.status = 'skipped';
        node.error = String(reason || '');
        node.finished_at = Date.now();
        return true;
    }

    /**
     * 标记开始
     */
    markStarted(taskId) {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        node.status = 'in_progress';
        node.started_at = Date.now();
        return true;
    }

    /**
     * 把任意状态拉回 pending（retry 用）。失败重试前调用一次。
     * 警告：会清掉 attempts 结果，慎用。
     */
    resetToPending(taskId) {
        const node = this._nodes.get(taskId);
        if (!node) return false;
        node.status = 'pending';
        node.started_at = null;
        node.completed_at = null;
        node.error = null;
        node.result = null;
        return true;
    }

    /**
     * 是否全部完成（终态）
     */
    isAllDone() {
        for (const node of this._nodes.values()) {
            if (!TERMINAL_STATUSES.has(node.status)) return false;
        }
        return true;
    }

    /**
     * 失败节点（用于 orchestrator 决定下一步）
     */
    getFailed() {
        return Array.from(this._nodes.values()).filter(n => n.status === 'failed');
    }

    /**
     * 跳过节点
     */
    getSkipped() {
        return Array.from(this._nodes.values()).filter(n => n.status === 'skipped');
    }

    /**
     * 死锁检测：检查是否存在循环依赖
     * 用 DFS 三色标记：white(0)未访问 / gray(1)访问中 / black(2)完成
     */
    hasCycle() {
        const COLOR = { WHITE: 0, GRAY: 1, BLACK: 2 };
        const color = new Map();
        for (const id of this._nodes.keys()) color.set(id, COLOR.WHITE);

        const dfs = (id) => {
            color.set(id, COLOR.GRAY);
            const node = this._nodes.get(id);
            if (node) {
                for (const dep of node.depends_on) {
                    const c = color.get(dep);
                    if (c === COLOR.WHITE) {
                        if (dfs(dep)) return true;
                    } else if (c === COLOR.GRAY) {
                        return true;  // 找到环
                    }
                }
            }
            color.set(id, COLOR.BLACK);
            return false;
        };

        for (const id of this._nodes.keys()) {
            if (color.get(id) === COLOR.WHITE) {
                if (dfs(id)) return true;
            }
        }
        return false;
    }

    /**
     * 拓扑排序（用于可视化 + 调试）
     */
    topologicalSort() {
        const indeg = new Map();
        for (const id of this._nodes.keys()) indeg.set(id, 0);
        for (const node of this._nodes.values()) {
            for (const dep of node.depends_on) {
                if (this._nodes.has(dep)) {
                    indeg.set(node.id, (indeg.get(node.id) || 0) + 1);
                }
            }
        }
        const queue = [];
        for (const [id, deg] of indeg.entries()) {
            if (deg === 0) queue.push(id);
        }
        const result = [];
        while (queue.length > 0) {
            const id = queue.shift();
            result.push(id);
            // 当前节点完成后，它的所有直接下游节点 indeg -1
            const dependents = this._dependents.get(id);
            if (dependents) {
                for (const depId of dependents) {
                    if (!this._nodes.has(depId)) continue;
                    const newDeg = (indeg.get(depId) || 0) - 1;
                    indeg.set(depId, newDeg);
                    if (newDeg === 0) queue.push(depId);
                }
            }
        }
        return result;
    }

    /**
     * 序列化（用于持久化到 settings 或调试）
     */
    toJSON() {
        return {
            nodes: Array.from(this._nodes.values()),
            ts: Date.now(),
        };
    }

    /**
     * 反序列化
     */
    static fromJSON(obj) {
        const g = new TaskGraph();
        if (!obj || !Array.isArray(obj.nodes)) return g;
        for (const node of obj.nodes) {
            g.addNode(node);
        }
        return g;
    }
}

module.exports = { TaskGraph, TERMINAL_STATUSES };
