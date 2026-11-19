// orchestrator/event-bus.js
// Sprint C-S1: 内部事件总线（包装 novel-engine 的 _emit）
//
// 设计要点：
//   - 不引入新事件系统——orchestrator 仍调 novel-engine 的 _emit()（走原有 IPC + workflow_events 通道）
//   - 但提供 .on() 接口给 orchestrator 内部组件订阅（如 scheduler 等待某个 task 完成事件）
//   - 同步触发：handler 抛错不影响主流程

'use strict';

class EventBus {
    constructor() {
        this._handlers = new Map();  // type → Set<handler>
        this._wildcardHandlers = new Set();  // 订阅所有事件
    }

    /**
     * 订阅事件
     * @param {string|string[]} type  事件名，支持数组
     * @param {Function} handler  (event) => void
     * @returns {Function} unsubscribe
     */
    on(type, handler) {
        if (typeof handler !== 'function') throw new Error('handler 必须是函数');
        const types = Array.isArray(type) ? type : [type];
        for (const t of types) {
            if (t === '*') {
                this._wildcardHandlers.add(handler);
            } else {
                if (!this._handlers.has(t)) this._handlers.set(t, new Set());
                this._handlers.get(t).add(handler);
            }
        }
        return () => {
            for (const t of types) {
                if (t === '*') {
                    this._wildcardHandlers.delete(handler);
                } else {
                    this._handlers.get(t)?.delete(handler);
                }
            }
        };
    }

    /**
     * 单次订阅
     */
    once(type, handler) {
        const unsub = this.on(type, (event) => {
            unsub();
            handler(event);
        });
        return unsub;
    }

    /**
     * 触发事件（同步）
     */
    emit(type, payload) {
        const event = { type, payload, ts: Date.now() };
        const handlers = this._handlers.get(type);
        if (handlers) {
            for (const h of handlers) {
                try { h(event); } catch (e) { console.warn(`[event-bus] handler error for ${type}:`, e.message); }
            }
        }
        for (const h of this._wildcardHandlers) {
            try { h(event); } catch (e) { /* ignore */ }
        }
    }

    /**
     * 取消所有订阅
     */
    clear() {
        this._handlers.clear();
        this._wildcardHandlers.clear();
    }

    /**
     * 调试用
     */
    listenerCount(type) {
        if (type === '*') return this._wildcardHandlers.size;
        return (this._handlers.get(type) || new Set()).size;
    }
}

module.exports = { EventBus };
