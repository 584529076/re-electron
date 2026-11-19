// agent-loop.js - Sprint 9.1: AI 助理 Agent Loop
// 实现工具调用循环：user → assistant(tool_call) → tool_result → ... → 最终回复
// 关键特性：
//  - 截断检测（finish_reason == "length"）
//  - 工具失败注入诊断提示（让模型重试 1 次）
//  - 破坏性工具需要 explicit confirm（前端弹窗 + 用户授权）
//  - 每次 tool_call 后通过 _recordGeneration 记账
//  - 通过 _emit('chat_*') 推送流式事件给前端

'use strict';

const { _buildChatTools, toolsToOpenAISchema, buildToolsSystemPrompt } = require('./chat-tools');

const MAX_ROUNDS = 8;             // 单次 sendMessage 最多 tool_call 轮
const TOOL_RETRY_ON_FAIL = 1;     // 同一工具失败重试次数
const MAX_HISTORY_MESSAGES = 20;  // 单次 send 最多带 20 条历史消息

class AgentLoop {
    constructor(opts) {
        this.novel = opts.novel;                  // LLM 调用模块（novel.js）
        // novel-engine API；如果 engine 没有 _store 但有 getStore()，自动注入
        this.engine = opts.engine;
        if (!this.engine._store && typeof this.engine.getStore === 'function') {
            this.engine = Object.assign({}, this.engine, { _store: this.engine.getStore() });
        }
        this.getProviderConfig = opts.getProviderConfig;
        this._emit = opts._emit || (() => {});    // event emitter
        this._recordGeneration = opts._recordGeneration || (() => {});
        this.tools = _buildChatTools(this.engine);
        this.toolMap = new Map(this.tools.map(t => [t.name, t]));
    }

    // 主入口：处理 user message，返回 assistant 最终回复
    async run(sessionId, userMessage, opts = {}) {
        const session = this.engine.getChatSession(sessionId);
        if (!session) return { ok: false, error: '会话不存在' };
        const novelId = session.novelId;

        // 1. 追加 user message
        this.engine.appendChatMessage(sessionId, { role: 'user', content: userMessage });

        // 2. 加载历史（truncate 到 N 条以控制 prompt 体积）
        this.engine.trimChatHistory(sessionId, MAX_HISTORY_MESSAGES);
        const fresh = this.engine.getChatSession(sessionId);
        const history = fresh.messages;

        // 3. 构建 messages 给 LLM
        const systemPrompt = this._buildSystemPrompt(novelId);
        const llmMessages = [{ role: 'system', content: systemPrompt }];
        for (const m of history) {
            if (m.role === 'system') continue;  // system 已在 systemPrompt 里
            if (m.role === 'user') {
                llmMessages.push({ role: 'user', content: m.content || '' });
            } else if (m.role === 'assistant') {
                if (m.toolCall) {
                    llmMessages.push({
                        role: 'assistant',
                        content: m.content || '',
                        tool_calls: [{
                            id: m.toolCall.id,
                            type: 'function',
                            function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.args || {}) },
                        }],
                    });
                } else {
                    llmMessages.push({ role: 'assistant', content: m.content || '' });
                }
            } else if (m.role === 'tool') {
                llmMessages.push({
                    role: 'tool',
                    tool_call_id: m.toolResult.toolCallId,
                    content: typeof m.toolResult.result === 'string' ? m.toolResult.result : JSON.stringify(m.toolResult.result),
                });
            }
        }

        // 4. 主循环：调用 LLM，处理 tool_call，直到 final answer
        const openaiTools = toolsToOpenAISchema(this.tools);
        const cfg = this.getProviderConfig() || {};
        // 没有 provider 配置时直接返回错误（避免 null deref）
        if (!cfg.provider || !cfg.model) {
            this._emit('chat_failed', { sessionId, novelId, error: '未配置 LLM provider' });
            return { ok: false, error: '未配置 LLM provider' };
        }
        let round = 0;
        let totalTokens = 0;
        let totalCost = 0;
        let lastError = null;
        const toolFailures = new Map(); // toolName → failureCount

        while (round < MAX_ROUNDS) {
            round++;
            let llmRes;
            try {
                llmRes = await this.novel.generate({
                    provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
                    model: cfg.model,
                    system: systemPrompt,
                    user: this._formatUserField(llmMessages.slice(1)),  // 非标准：novel.generate 接 user 字段
                    temperature: 0.7, max_tokens: 2000,
                    tools: openaiTools,
                });
            } catch (e) {
                lastError = e;
                // 写 generation 记录
                this._recordGeneration({
                    novel_id: novelId, skill: 'chat-agent', agent_name: 'chat-agent',
                    provider: cfg.provider, model: cfg.model,
                    status: 'failed', error_msg: e.message || String(e),
                    raw_request: JSON.stringify({ sessionId, round }).slice(0, 500),
                    raw_response: null,
                });
                this._emit('chat_failed', { sessionId, novelId, error: e.message || String(e) });
                return { ok: false, error: e.message || String(e) };
            }

            // 记录 tokens
            totalTokens += (llmRes.prompt_tokens || 0) + (llmRes.completion_tokens || 0);
            totalCost += (llmRes.cost_usd || 0);
            this._recordGeneration({
                novel_id: novelId, skill: 'chat-agent', agent_name: 'chat-agent',
                provider: cfg.provider, model: cfg.model,
                prompt_tokens: llmRes.prompt_tokens,
                completion_tokens: llmRes.completion_tokens,
                cost_usd: llmRes.cost_usd,
                status: llmRes.finish_reason === 'length' ? 'warn' : 'ok',
                error_msg: llmRes.finish_reason === 'length' ? 'truncated' : null,
                raw_request: JSON.stringify({ sessionId, round }).slice(0, 500),
                raw_response: (llmRes.text || '').slice(0, 500),
            });

            // 5. 解析 tool_call
            const toolCalls = this._extractToolCalls(llmRes);
            if (!toolCalls.length) {
                // 没有 tool_call：final answer
                const finalText = llmRes.text || '';
                this.engine.appendChatMessage(sessionId, { role: 'assistant', content: finalText });
                this._emit('chat_final', { sessionId, novelId, content: finalText, tokens: totalTokens, rounds: round });
                this.engine.updateChatSession(sessionId, {
                    totalTokens: (session.totalTokens || 0) + totalTokens,
                    totalCostUsd: (session.totalCostUsd || 0) + totalCost,
                });
                return { ok: true, content: finalText, rounds: round, tokens: totalTokens, truncated: llmRes.finish_reason === 'length' };
            }

            // 6. 处理 tool_calls
            this._emit('chat_tool_calls', { sessionId, novelId, toolCalls: toolCalls.map(t => ({ name: t.name, args: t.args })) });

            // 先记录 assistant 的 tool_call 消息
            for (const tc of toolCalls) {
                this.engine.appendChatMessage(sessionId, {
                    role: 'assistant', content: llmRes.text || '',
                    toolCall: { id: tc.id, name: tc.name, args: tc.args },
                });
            }

            // 执行工具
            for (const tc of toolCalls) {
                let toolResult;
                const failureKey = tc.name;
                let retries = toolFailures.get(failureKey) || 0;

                // 破坏性工具：检查用户已确认
                const toolDef = this.toolMap.get(tc.name);
                if (!toolDef) {
                    toolResult = { ok: false, error: `未知工具: ${tc.name}` };
                } else if (toolDef.requiresConfirm && !(opts.confirmedToolIds || []).includes(tc.id)) {
                    // 推 SSE 让前端弹窗确认；不执行
                    this._emit('chat_tool_confirm_required', {
                        sessionId, novelId, toolCallId: tc.id, name: tc.name, args: tc.args,
                    });
                    toolResult = { ok: false, error: '需要用户确认才能执行（破坏性操作）', pendingConfirm: true, toolCallId: tc.id };
                    // 标记到 toolFailures，让循环能在本轮结束后停
                    toolFailures.set(tc.name, (toolFailures.get(tc.name) || 0) + 1);
                } else {
                    // 执行
                    try {
                        const params = Object.assign({ novelId }, tc.args || {});
                        const r = await toolDef.run(params);
                        toolResult = r;
                    } catch (e) {
                        toolResult = { ok: false, error: e.message || String(e) };
                    }
                    if (!toolResult.ok) {
                        retries++;
                        toolFailures.set(failureKey, retries);
                        if (retries > TOOL_RETRY_ON_FAIL) {
                            // 超过重试：注入诊断提示
                            this.engine.appendChatMessage(sessionId, {
                                role: 'system', content: `[诊断] 工具 ${tc.name} 已重试 ${retries} 次仍失败：${toolResult.error}。请尝试其他工具或改变策略。`,
                            });
                        }
                    }
                }

                // 记录 tool_result
                this.engine.appendChatMessage(sessionId, {
                    role: 'tool',
                    toolResult: { toolCallId: tc.id, result: toolResult },
                });
                this._emit('chat_tool_result', { sessionId, novelId, toolCallId: tc.id, name: tc.name, result: toolResult });
            }

            // 7. 重新拉 messages（因追加了 assistant + tool）
            const refreshed = this.engine.getChatSession(sessionId);
            llmMessages.length = 1; // 留 system
            for (const m of refreshed.messages) {
                if (m.role === 'system') continue;
                if (m.role === 'user') {
                    llmMessages.push({ role: 'user', content: m.content || '' });
                } else if (m.role === 'assistant') {
                    if (m.toolCall) {
                        llmMessages.push({
                            role: 'assistant', content: m.content || '',
                            tool_calls: [{
                                id: m.toolCall.id, type: 'function',
                                function: { name: m.toolCall.name, arguments: JSON.stringify(m.toolCall.args || {}) },
                            }],
                        });
                    } else {
                        llmMessages.push({ role: 'assistant', content: m.content || '' });
                    }
                } else if (m.role === 'tool') {
                    llmMessages.push({
                        role: 'tool',
                        tool_call_id: m.toolResult.toolCallId,
                        content: typeof m.toolResult.result === 'string' ? m.toolResult.result : JSON.stringify(m.toolResult.result),
                    });
                }
            }

            // 检查是否有 pending confirm（破坏性）→ 停
            const hasPendingConfirm = Array.from(toolFailures.entries()).some(([k, v]) => v > 0 && this.toolMap.get(k) && this.toolMap.get(k).requiresConfirm);
            if (hasPendingConfirm) {
                this._emit('chat_paused', { sessionId, novelId, reason: 'pending_confirm' });
                return { ok: true, paused: true, reason: 'pending_confirm', rounds: round };
            }
        }

        // 超过 MAX_ROUNDS
        this._emit('chat_failed', { sessionId, novelId, error: '超过最大轮次' });
        return { ok: false, error: `超过最大轮次 ${MAX_ROUNDS}`, rounds: round };
    }

    _buildSystemPrompt(novelId) {
        const novel = this.engine.getNovel(novelId);
        const title = (novel && novel.novel) ? novel.novel.title : '';
        const lang = (novel && novel.novel && novel.novel.language) || 'zh';
        const langHint = lang === 'en'
            ? '\n## Language\nReply in English unless user switches to Chinese.'
            : '\n## 语言\n除非用户切换为英文，否则用中文回复。';
        return buildToolsSystemPrompt(this.tools) + langHint + `\n\n当前项目：${title || '未命名'}（id=${novelId}）`;
    }

    _formatUserField(messages) {
        // novel.generate 接 user 字段；这里把 messages 序列化成文本
        // （其实 LLM 调用应直接传 messages，但 novel.generate 是简化接口）
        return messages.map(m => {
            if (m.role === 'user') return `[USER] ${m.content}`;
            if (m.role === 'assistant') {
                if (m.tool_calls) {
                    return `[ASSISTANT_TOOL_CALL] ${m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join('; ')}`;
                }
                return `[ASSISTANT] ${m.content || ''}`;
            }
            if (m.role === 'tool') return `[TOOL_RESULT ${m.tool_call_id}] ${m.content}`;
            return '';
        }).filter(Boolean).join('\n\n');
    }

    _extractToolCalls(llmRes) {
        // 解析 llmRes.tool_calls（OpenAI 格式）或从 text 中识别
        if (Array.isArray(llmRes.tool_calls) && llmRes.tool_calls.length) {
            return llmRes.tool_calls.map(tc => ({
                id: tc.id,
                name: tc.function && tc.function.name,
                args: tc.function && tc.function.arguments ? safeParseJson(tc.function.arguments, {}) : {},
            }));
        }
        // 国产模型 fallback：从 text 中识别 <tool_call>{...}</tool_call> 或 <<<TOOL_CALL>>>...<<<END>>>
        const text = llmRes.text || '';
        const calls = [];
        const OPEN_TAG = '<tool_call>';
        const CLOSE_TAG = '</tool_call>';
        const OPEN2 = '<<<TOOL_CALL>>>';
        const CLOSE2 = '<<<END>>>';
        if (text.includes(OPEN_TAG)) {
            const open = text.indexOf(OPEN_TAG);
            while (open !== -1) {
                const close = text.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
                if (close === -1) break;
                const inner = text.slice(open + OPEN_TAG.length, close).trim();
                const obj = safeParseJson(inner, null);
                if (obj && obj.name) {
                    calls.push({
                        id: obj.id || `tc-${Date.now()}-${calls.length}`,
                        name: obj.name,
                        args: obj.args || obj.parameters || {},
                    });
                }
                open = text.indexOf(OPEN_TAG, close + CLOSE_TAG.length);
            }
        } else if (text.includes(OPEN2)) {
            let open = text.indexOf(OPEN2);
            while (open !== -1) {
                const close = text.indexOf(CLOSE2, open + OPEN2.length);
                if (close === -1) break;
                const inner = text.slice(open + OPEN2.length, close).trim();
                const obj = safeParseJson(inner, null);
                if (obj && obj.name) {
                    calls.push({
                        id: obj.id || `tc-${Date.now()}-${calls.length}`,
                        name: obj.name,
                        args: obj.args || obj.parameters || {},
                    });
                }
                open = text.indexOf(OPEN2, close + CLOSE2.length);
            }
        }
        return calls;
    }
}

function safeParseJson(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
}

module.exports = { AgentLoop };