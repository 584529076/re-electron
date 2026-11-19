// lib/context-compressor.js
// Sprint C-S1: 上下文压缩机制
//
// 设计动机：
//   _composeSystemPrompt 注入 10 段内容（SOUL/IDENTITY/AGENTS/MEMORY/反馈/黑板/inbox/共享上下文/USER/raw）。
//   随项目推进，MEMORY 自然增长、黑板 KV 累积、shared_context 加入后膨胀更快。
//   不压缩的后果：
//     1. 单次 LLM 调用 system prompt 20-50K 字符，成本翻倍
//     2. 国产模型 32K context 限制会爆
//     3. 长 prompt 反而降低模型注意力对关键信息的聚焦度
//
// 5 级压缩策略（从轻到重）：
//   L1 truncate_tail    —— 截断 MEMORY 尾部，超软阈时触发，0 成本
//   L2 evict_expired     —— 清掉 shared_context 过期项，0 成本
//   L3 importance_filter —— 总预算超 80% 时按 importance 淘汰低优先级 shared_context，0 成本
//   L4 head_truncate     —— 黑板摘要超 1500 字时头部截断，0 成本
//   L5 llm_summarize     —— 总预算超 90% 且其他策略不够时调 LLM 摘要，1 次 LLM 调用
//
// 预算配置：
//   默认 + per-novel 可覆盖。每 section 有 soft（建议） + hard（绝对上限）双阈值。
//   硬上限超了强制 L5 summarize（不能让 LLM 报 context 超限错误）。
//
// 集成方式：
//   _composeSystemPrompt 在拼装前先 estimate(), 超预算自动 compress(), 并 emit context_compressed 事件。

'use strict';

// 默认预算（soft 触发压缩，hard 强制压缩）
const DEFAULT_BUDGET = Object.freeze({
    total_system_prompt_bytes: 16000,    // 软上限
    hard_limit_bytes: 32000,             // 硬上限（超了强制 L5 summarize）

    sections: {
        SOUL:             { hard: 4000 },
        IDENTITY:         { hard: 2000 },
        AGENTS:           { hard: 6000 },
        MEMORY_GLOBAL:    { soft: 3000, hard: 8000 },
        MEMORY_PER_NOVEL: { soft: 3000, hard: 10000 },
        FEEDBACK:         { hard: 2000, maxItems: 5 },
        BLACKBOARD:       { soft: 1500, hard: 3000 },
        INBOX:            { hard: 2000, maxItems: 8 },
        SHARED_CTX:       { soft: 4000, hard: 8000 },
        USER_SHARED:      { hard: 1000 },
        RAW_DIRECTIVE:    { hard: 2000 },
    },
});

// 策略级别
const STRATEGY = {
    TRUNCATE_TAIL:    'truncate_tail',     // L1
    EVICT_EXPIRED:    'evict_expired',     // L2
    IMPORTANCE_FILTER:'importance_filter', // L3
    HEAD_TRUNCATE:    'head_truncate',     // L4
    LLM_SUMMARIZE:    'llm_summarize',     // L5
    AUTO:             'auto',
};

class ContextCompressor {
    /**
     * @param {object} opts
     * @param {object} opts.sharedContext   SharedContext 实例（用于 L2/L3）
     * @param {object} [opts.budget]        per-novel 预算覆盖
     * @param {Function} [opts.summarizeLLM] (text, sectionKey) => Promise<string>  L5 用
     * @param {Function} [opts.uuid]
     * @param {Function} [opts.now]
     */
    constructor({ sharedContext, budget = null, summarizeLLM = null, uuid = null, now = null } = {}) {
        this._sc = sharedContext;
        this._budget = budget || {};
        this._summarizeLLM = summarizeLLM;
        this._uuid = uuid || (() => 'cmp_' + Math.random().toString(36).slice(2, 10));
        this._now = now || (() => Math.floor(Date.now() / 1000));
    }

    /**
     * 合并默认预算 + per-novel 覆盖
     */
    _mergedBudget(novelId) {
        const ovr = this._budget[novelId] || {};
        return {
            total_system_prompt_bytes: ovr.total_system_prompt_bytes || DEFAULT_BUDGET.total_system_prompt_bytes,
            hard_limit_bytes: ovr.hard_limit_bytes || DEFAULT_BUDGET.hard_limit_bytes,
            sections: Object.assign({}, DEFAULT_BUDGET.sections, ovr.sections || {}),
        };
    }

    /**
     * 估算一个 sections 数组的总大小（按 section 名匹配预算 key）
     * @param {Array<{key: string, content: string}>} sections
     */
    estimate(sections) {
        const bySection = {};
        let total = 0;
        for (const s of sections) {
            const bytes = Buffer.byteLength(s.content || '', 'utf8');
            bySection[s.key] = bytes;
            total += bytes;
        }
        return { total_bytes: total, by_section: bySection };
    }

    /**
     * 核心入口：估算 + 自动压缩（如需要）
     * @param {string} novelId
     * @param {Array<{key: string, content: string, importance?: number}>} sections
     * @returns {{sections, compression: object|null, totalBytes: number}}
     */
    async maybeCompress(novelId, sections) {
        const budget = this._mergedBudget(novelId);
        const est = this.estimate(sections);
        const softLimit = budget.total_system_prompt_bytes;
        const hardLimit = budget.hard_limit_bytes;

        if (est.total_bytes <= softLimit) {
            return { sections, compression: null, totalBytes: est.total_bytes };
        }

        // 超预算：按 L1→L5 顺序尝试
        const result = await this.compress(novelId, sections, STRATEGY.AUTO, budget);
        return {
            sections: result.sections,
            compression: { strategy: STRATEGY.AUTO, ...result.summary },
            totalBytes: this.estimate(result.sections).total_bytes,
        };
    }

    /**
     * 执行压缩（按 strategy 或 AUTO 链式）
     * @returns {{sections, summary: {saved_bytes, actions: []}}}
     */
    async compress(novelId, sections, strategy = STRATEGY.AUTO, budget = null) {
        budget = budget || this._mergedBudget(novelId);
        const beforeBytes = this.estimate(sections).total_bytes;
        const actions = [];
        let workingSections = sections.slice();

        // 按顺序尝试各级策略，每级如果仍超预算则继续
        const order = strategy === STRATEGY.AUTO
            ? [STRATEGY.TRUNCATE_TAIL, STRATEGY.EVICT_EXPIRED, STRATEGY.IMPORTANCE_FILTER, STRATEGY.HEAD_TRUNCATE, STRATEGY.LLM_SUMMARIZE]
            : [strategy];

        for (const strat of order) {
            const before = this.estimate(workingSections).total_bytes;

            if (strat === STRATEGY.TRUNCATE_TAIL) {
                workingSections = this._l1TruncateTail(workingSections, budget, actions);
            } else if (strat === STRATEGY.EVICT_EXPIRED) {
                this._l2EvictExpired(novelId, actions);
            } else if (strat === STRATEGY.IMPORTANCE_FILTER) {
                this._l3ImportanceFilter(novelId, budget, actions);
            } else if (strat === STRATEGY.HEAD_TRUNCATE) {
                workingSections = this._l4HeadTruncate(workingSections, budget, actions);
            } else if (strat === STRATEGY.LLM_SUMMARIZE) {
                if (typeof this._summarizeLLM === 'function') {
                    workingSections = await this._l5LlmSummarize(workingSections, budget, actions);
                }
                // 没有 summarizeLLM 就跳过
            }

            const after = this.estimate(workingSections).total_bytes;
            // 如果已达到软上限以下就停
            if (after <= budget.total_system_prompt_bytes) break;
            // 如果已达到硬上限以下且已用 L5 就停
            if (strat === STRATEGY.LLM_SUMMARIZE && after <= budget.hard_limit_bytes) break;
        }

        const afterBytes = this.estimate(workingSections).total_bytes;
        const summary = {
            saved_bytes: beforeBytes - afterBytes,
            before_bytes: beforeBytes,
            after_bytes: afterBytes,
            actions,
        };

        // 审计日志（外部可监听 workflow_events）
        return { sections: workingSections, summary };
    }

    // ======================== L1 truncate_tail ========================

    _l1TruncateTail(sections, budget, actions) {
        const out = [];
        for (const s of sections) {
            const sec = budget.sections[s.key];
            if (!sec || !sec.soft) {
                out.push(s);
                continue;
            }
            const bytes = Buffer.byteLength(s.content || '', 'utf8');
            const softBytes = sec.soft;
            if (bytes <= softBytes) {
                out.push(s);
                continue;
            }
            // 截断到 soft 字节（含标记）
            const truncated = this._truncateToBytes(s.content, softBytes);
            const keptBytes = Buffer.byteLength(truncated, 'utf8');
            out.push(Object.assign({}, s, {
                content: truncated,
                _truncated: true,
                _originalBytes: bytes,
            }));
            actions.push({
                section: s.key,
                action: STRATEGY.TRUNCATE_TAIL,
                kept_bytes: keptBytes,
                dropped_bytes: bytes - keptBytes,
            });
        }
        return out;
    }

    /**
     * 按字节截断，保证「返回值（含 marker）的字节数 <= maxBytes」。
     * 不会切坏 UTF-8 多字节字符（遇到续字节就回退到字符边界）。
     *
     * @param {string} text
     * @param {number} maxBytes  返回值的字节上限（含 marker）
     * @param {string} [marker]  截断标记，计入预算
     */
    _truncateToBytes(text, maxBytes, marker = '\n\n[...truncated...]') {
        text = String(text == null ? '' : text);
        if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

        const markerBytes = Buffer.byteLength(marker, 'utf8');
        // marker 本身就超预算 → 退化为纯截断（不加 marker）
        const budget = maxBytes - markerBytes;
        if (budget <= 0) {
            return Buffer.from(text, 'utf8')
                .slice(0, this._utf8Boundary(Buffer.from(text, 'utf8'), Math.max(0, maxBytes)))
                .toString('utf8');
        }

        const buf = Buffer.from(text, 'utf8');
        const end = this._utf8Boundary(buf, budget);
        return buf.slice(0, end).toString('utf8') + marker;
    }

    /**
     * 找 <= max 的最近 UTF-8 字符边界
     */
    _utf8Boundary(buf, max) {
        let end = Math.min(max, buf.length);
        // buf[end] 是第一个被排除的字节；若它是续字节(10xxxxxx)说明切在字符中间，回退
        while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
        return end;
    }

    /**
     * 取尾部 <= maxBytes 的片段（不切坏 UTF-8）
     */
    _tailToBytes(text, maxBytes) {
        const buf = Buffer.from(String(text == null ? '' : text), 'utf8');
        if (buf.length <= maxBytes) return buf.toString('utf8');
        let start = buf.length - maxBytes;
        // 若起点落在字符中间（续字节），向后推到下一个字符起点
        while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;
        return buf.slice(start).toString('utf8');
    }

    // ======================== L2 evict_expired ========================

    _l2EvictExpired(novelId, actions) {
        if (!this._sc) return;
        const before = this._sc.stats(novelId);
        const deleted = this._sc.evictExpired(novelId);
        if (deleted > 0) {
            actions.push({
                section: 'SHARED_CTX',
                action: STRATEGY.EVICT_EXPIRED,
                evicted: deleted,
                before_active: before.active,
            });
        }
    }

    // ======================== L3 importance_filter ========================

    _l3ImportanceFilter(novelId, budget, actions) {
        if (!this._sc) return;
        const stats = this._sc.stats(novelId);
        if (stats.active === 0) return;
        // 删除 importance <= 3 的项；仍不够再降阈值
        for (const maxImp of [3, 2, 1]) {
            const deleted = this._sc.evictByImportance(novelId, maxImp);
            if (deleted > 0) {
                actions.push({
                    section: 'SHARED_CTX',
                    action: STRATEGY.IMPORTANCE_FILTER,
                    threshold: maxImp,
                    evicted: deleted,
                });
            }
            // 检查是否足够（粗略估算：每条约 500 字节）
            const remaining = this._sc.stats(novelId).active;
            const projectedBytes = remaining * 500;
            if (projectedBytes <= budget.sections.SHARED_CTX.soft) break;
        }
    }

    // ======================== L4 head_truncate ========================

    _l4HeadTruncate(sections, budget, actions) {
        const out = [];
        for (const s of sections) {
            const sec = budget.sections[s.key];
            if (!sec || !sec.hard) {
                out.push(s);
                continue;
            }
            const bytes = Buffer.byteLength(s.content || '', 'utf8');
            if (bytes <= sec.hard) {
                out.push(s);
                continue;
            }
            // 已经在 L1 处理过 soft；如果还超 hard，做 head + tail 双向截断
            // 预算分配：sep + head + tail <= hard
            const SEP = '\n\n[...middle truncated...]\n\n';
            const sepBytes = Buffer.byteLength(SEP, 'utf8');
            const half = Math.max(0, Math.floor((sec.hard - sepBytes) / 2));
            const head = this._truncateToBytes(s.content, half, '');
            const tail = this._tailToBytes(s.content, half);
            const combined = head + SEP + tail;
            out.push(Object.assign({}, s, {
                content: combined,
                _truncated: 'head_tail',
                _originalBytes: bytes,
            }));
            actions.push({
                section: s.key,
                action: STRATEGY.HEAD_TRUNCATE,
                hard_limit_bytes: sec.hard,
                dropped_bytes: bytes - Buffer.byteLength(combined, 'utf8'),
            });
        }
        return out;
    }

    // ======================== L5 llm_summarize ========================

    async _l5LlmSummarize(sections, budget, actions) {
        const out = [];
        for (const s of sections) {
            const sec = budget.sections[s.key];
            if (!sec || !sec.hard) {
                out.push(s);
                continue;
            }
            const bytes = Buffer.byteLength(s.content || '', 'utf8');
            if (bytes <= sec.hard) {
                out.push(s);
                continue;
            }
            // 调 LLM 摘要
            try {
                const summary = await this._summarizeLLM(s.content, s.key);
                // 再检查：摘要后可能仍超 hard，做 head 截断
                let finalContent = summary;
                if (Buffer.byteLength(finalContent, 'utf8') > sec.hard) {
                    finalContent = this._truncateToBytes(summary, sec.hard);
                }
                out.push(Object.assign({}, s, {
                    content: finalContent,
                    _summarized: true,
                    _originalBytes: bytes,
                }));
                actions.push({
                    section: s.key,
                    action: STRATEGY.LLM_SUMMARIZE,
                    hard_limit_bytes: sec.hard,
                    original_bytes: bytes,
                    summarized_bytes: Buffer.byteLength(finalContent, 'utf8'),
                });
            } catch (e) {
                // LLM 失败：fallback 到 head_truncate
                console.warn(`[context-compressor] L5 summarize failed for ${s.key}:`, e.message);
                out.push(s);
                actions.push({
                    section: s.key,
                    action: STRATEGY.LLM_SUMMARIZE,
                    failed: true,
                    error: e.message,
                });
            }
        }
        return out;
    }

    // ======================== 配置 ========================

    setBudget(novelId, budgetOverride) {
        this._budget[novelId] = Object.assign({}, this._budget[novelId] || {}, budgetOverride);
    }

    getBudget(novelId) {
        return this._mergedBudget(novelId);
    }

    /**
     * 同步压缩（L1-L4，不调 LLM）
     * 用于 _composeSystemPrompt 这种必须保持同步签名的入口
     * 如需 L5 摘要，请用 await compress()
     */
    _runSyncCompress(novelId, sections, budget) {
        const beforeBytes = this.estimate(sections).total_bytes;
        const actions = [];
        let workingSections = sections.slice();

        workingSections = this._l1TruncateTail(workingSections, budget, actions);
        this._l2EvictExpired(novelId, actions);
        this._l3ImportanceFilter(novelId, budget, actions);
        workingSections = this._l4HeadTruncate(workingSections, budget, actions);

        const afterBytes = this.estimate(workingSections).total_bytes;
        return {
            sections: workingSections,
            summary: {
                saved_bytes: beforeBytes - afterBytes,
                before_bytes: beforeBytes,
                after_bytes: afterBytes,
                actions,
            },
        };
    }
}

module.exports = {
    ContextCompressor,
    DEFAULT_BUDGET,
    STRATEGY,
};
