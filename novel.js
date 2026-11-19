// novel.js — AI 小说模块的 LLM Provider Adapter（独立模块，不依赖 llm.js / comfyui-*）
//
// 设计：
//   - 三个 provider（OpenAI 兼容 / Anthropic / Ollama）统一接口
//   - AbortController 透传：上层（ainovel:cancel*）可中断
//   - 内置价目表（USD/1M tokens），成本审计写到 _ainovel_generations
//   - Ollama 没有 token 计数，按 text.length 估算（标记 estimated）
//
// 调用方：novel-engine.js 的 skill 通过 novelEngine.generate(...) 间接调用
'use strict';

// HTTP 请求走本文件下方的 _fetch() 工具（优先用 Node 18+ 内置 globalThis.fetch，
// 兜底才动态 require('undici')）。模块顶部不要直接 require undici / node-fetch —— 这俩
// 包不一定装在依赖里，写在顶部 require 链会让 main.js 启动直接抛
// "Cannot find module 'undici'"。
//
// 历史原因：旧版这里写的是
//   const { fetch: nodeFetch } = require('undici') || require('node-fetch') || globalThis;
// 但 || 短路只在 require 返回 falsy 时才走下一个分支，require 抛错会直接终止模块加载，
// 后面的 node-fetch / globalThis 永远不会执行。已删除。

// 内置价目表（USD / 1M tokens）。仅主流模型；未列出的模型 cost 记 null。
// 来源：各厂商公开价目表（2026-01）。anthropic / openai 实时定价若有变动以厂商为准。
const PRICING = {
    // OpenAI 兼容（含 GPT-4o / GPT-5 / DeepSeek / Moonshot 等）
    'gpt-4o':                  { input: 2.50, output: 10.00 },
    'gpt-4o-mini':             { input: 0.15, output: 0.60 },
    'gpt-5':                   { input: 5.00, output: 15.00 },
    'gpt-5-mini':              { input: 0.50, output: 2.00 },
    'o1':                      { input: 15.00, output: 60.00 },
    'o1-mini':                 { input: 3.00, output: 12.00 },
    'o3-mini':                 { input: 1.10, output: 4.40 },
    'deepseek-chat':           { input: 0.14, output: 0.28 },
    'deepseek-reasoner':       { input: 0.55, output: 2.19 },
    'moonshot-v1-8k':          { input: 2.00, output: 2.00 },
    'moonshot-v1-32k':         { input: 4.00, output: 4.00 },
    'moonshot-v1-128k':        { input: 6.00, output: 6.00 },
    // Anthropic
    'claude-opus-4-6':         { input: 15.00, output: 75.00 },
    'claude-sonnet-4-6':       { input: 3.00, output: 15.00 },
    'claude-haiku-4-5-20251001':{ input: 1.00, output: 5.00 },
    'claude-3-5-sonnet-latest':{ input: 3.00, output: 15.00 },
    'claude-3-5-haiku-latest': { input: 0.80, output: 4.00 },
};

// 模型名归一化（用于价目表查找）：去除 ':<size>' 等后缀，转小写
function _normalizeModel(model) {
    if (!model) return '';
    return String(model).toLowerCase().split(':')[0].trim();
}

function _estimateCost(model, promptTokens, completionTokens) {
    const key = _normalizeModel(model);
    const p = PRICING[key];
    if (!p || promptTokens == null || completionTokens == null) return null;
    return (promptTokens / 1e6) * p.input + (completionTokens / 1e6) * p.output;
}

// 估算 token 数（中英文混合粗算）：约 1 token / 1.5 字符（中文偏多）
function _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 2.0);
}

/**
 * 统一 generate() 接口
 * @param {Object} opts
 * @param {'openai'|'anthropic'|'ollama'} opts.provider
 * @param {string} opts.base_url  e.g. 'https://api.openai.com/v1' / 'http://localhost:11434'
 * @param {string} [opts.api_key]
 * @param {string} opts.model
 * @param {string} [opts.system]
 * @param {string} opts.user
 * @param {number} [opts.temperature=0.8]
 * @param {number} [opts.max_tokens=4000]
 * @param {number} [opts.thinking_budget=0]  Anthropic extended thinking 的 budget_tokens；>0 启用
 * @param {string} [opts.reasoning_effort]  OpenAI o1/o3 的推理强度：'low'|'medium'|'high'
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   text: string,                  // 最终回答文本
 *   thinking?: string,              // 思考过程（Anthropic / DeepSeek / Ollama<think>）
 *   prompt_tokens: number|null,
 *   completion_tokens: number|null,
 *   reasoning_tokens?: number|null, // OpenAI o1/o3 的 reasoning_tokens
 *   cost_usd: number|null,
 *   duration_ms: number,
 *   estimated: boolean,
 *   raw: any,
 * }>}
 */
async function generate(opts) {
    const provider = opts.provider;
    const baseUrl = (opts.base_url || '').replace(/\/+$/, '');
    const apiKey = opts.api_key || '';
    const model = opts.model || '';
    const system = opts.system || '';
    const user = opts.user || '';
    const temperature = opts.temperature != null ? Number(opts.temperature) : 0.8;
    const maxTokens = opts.max_tokens != null ? Number(opts.max_tokens) : 4000;
    const thinkingBudget = opts.thinking_budget != null ? Number(opts.thinking_budget) : 0;
    const reasoningEffort = opts.reasoning_effort || null;
    const signal = opts.signal || null;

    if (!provider) throw new Error('novel.generate: provider 必填');
    if (!baseUrl) throw new Error('novel.generate: base_url 必填');
    if (!model) throw new Error('novel.generate: model 必填');
    if (!user) throw new Error('novel.generate: user prompt 必填');

    const startedAt = Date.now();

    let result;
    if (provider === 'openai') {
        result = await _openai({
            baseUrl, apiKey, model, system, user, temperature, maxTokens,
            reasoningEffort, signal,
        });
    } else if (provider === 'anthropic') {
        result = await _anthropic({
            baseUrl, apiKey, model, system, user, temperature, maxTokens,
            thinkingBudget, signal,
        });
    } else if (provider === 'ollama') {
        result = await _ollama({
            baseUrl, model, system, user, temperature, maxTokens,
            // Ollama 本地推理模型（如 deepseek-r1/qwq）通过 <think>...</think> 输出，
            // 在 _ollamaStream/_ollama 非流式里做后处理
            parseThinkTags: thinkingBudget > 0, signal,
        });
    } else {
        throw new Error('novel.generate: 未知 provider: ' + provider);
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = _estimateCost(model, result.prompt_tokens, result.completion_tokens);
    return {
        text: result.text,
        thinking: result.thinking || '',
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        reasoning_tokens: result.reasoning_tokens || null,
        cost_usd: costUsd,
        duration_ms: durationMs,
        estimated: !!result.estimated,
        raw: result.raw,
    };
}

// 检测 OpenAI 模型是否是 reasoning 类（o1 / o3 / deepseek-reasoner）
function _isReasoningOpenAIModel(model) {
    if (!model) return false;
    const m = String(model).toLowerCase();
    return m.startsWith('o1') || m.startsWith('o3') || m.includes('deepseek-reasoner') || m.includes('deepseek-r1');
}

// OpenAI 兼容（Chat Completions）
async function _openai(args) {
    const { baseUrl, apiKey, model, system, user, temperature, maxTokens, reasoningEffort, signal } = args;
    const url = baseUrl + '/chat/completions';
    const isReasoning = _isReasoningOpenAIModel(model);
    const body = {
        model,
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
        ],
        stream: false,
    };
    if (isReasoning) {
        // reasoning 模型：只支持 max_completion_tokens，不支持 temperature / top_p 等
        body.max_completion_tokens = maxTokens;
        if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    } else {
        body.temperature = temperature;
        body.max_tokens = maxTokens;
    }
    const res = await _fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('OpenAI HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const text = msg.content || '';
    // reasoning 内容：OpenAI 官方 o1/o3 系列用 reasoning_content；DeepSeek 也有该字段
    const thinking = msg.reasoning_content || '';
    const promptTokens = data?.usage?.prompt_tokens || null;
    const completionTokens = data?.usage?.completion_tokens || null;
    const reasoningTokens = data?.usage?.reasoning_tokens || null;
    return {
        text, thinking,
        prompt_tokens: promptTokens, completion_tokens: completionTokens,
        reasoning_tokens: reasoningTokens,
        raw: data,
    };
}

// Anthropic Messages API
// thinkingBudget > 0 启用 extended thinking：会把所有 reasoning 块合并为单一 thinking 字段返回
async function _anthropic(args) {
    const { baseUrl, apiKey, model, system, user, temperature, maxTokens, thinkingBudget, signal } = args;
    const url = baseUrl + '/v1/messages';
    const useThinking = thinkingBudget && thinkingBudget > 0;
    const body = {
        model,
        system: system || undefined,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxTokens,
    };
    if (useThinking) {
        // Anthropic 强制 max_tokens > budget_tokens，否则 400
        if (maxTokens <= thinkingBudget) {
            body.max_tokens = thinkingBudget + 4096;
        }
        body.thinking = { type: 'enabled', budget_tokens: Number(thinkingBudget) };
        // 启用 thinking 时不允许同时设 temperature（Anthropic 规则）
        // 不写 temperature 字段，由 API 用默认 1.0
    } else {
        body.temperature = temperature;
    }
    const res = await _fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('Anthropic HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    const data = await res.json();
    let text = '';
    let thinking = '';
    if (Array.isArray(data?.content)) {
        for (const c of data.content) {
            if (c?.type === 'text' && c.text) text += c.text;
            else if (c?.type === 'thinking' && c.thinking) thinking += c.thinking;
        }
    }
    const promptTokens = data?.usage?.input_tokens || null;
    const completionTokens = data?.usage?.output_tokens || null;
    return {
        text, thinking,
        prompt_tokens: promptTokens, completion_tokens: completionTokens,
        raw: data,
    };
}

// Ollama Chat API
// 本地推理模型（deepseek-r1 / qwq 等）会在 content 里输出 <think>...</think> 标签；
// parseThinkTags=true 时把 <think> 块剥离到 thinking 字段
async function _ollama(args) {
    const { baseUrl, model, system, user, temperature, maxTokens, parseThinkTags, signal } = args;
    const url = baseUrl + '/api/chat';
    const body = {
        model,
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
        ],
        stream: false,
        options: {
            temperature,
            num_predict: maxTokens,
        },
    };
    const res = await _fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('Ollama HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    const data = await res.json();
    let rawText = data?.message?.content || '';
    let thinking = '';
    if (parseThinkTags) {
        const split = _splitThinkTags(rawText);
        thinking = split.thinking;
        rawText = split.text;
    }
    // Ollama 不返回 token 数；按字符估算
    const promptTokens = _estimateTokens((system || '') + user);
    const completionTokens = _estimateTokens(rawText);
    return {
        text: rawText,
        thinking,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        estimated: true,
        raw: data,
    };
}

// 把 <think>...</think> 块从 text 中剥离
// 多个 <think> 块全部合并到 thinking
function _splitThinkTags(text) {
    if (!text || text.indexOf('<think>') === -1) return { text: text || '', thinking: '' };
    let thinking = '';
    let out = '';
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('<think>', i);
        if (start === -1) { out += text.slice(i); break; }
        out += text.slice(i, start);
        const end = text.indexOf('</think>', start);
        if (end === -1) { thinking += text.slice(start + 7); break; }
        thinking += text.slice(start + 7, end);
        i = end + 8;
    }
    return { text: out.trim(), thinking: thinking.trim() };
}

/**
 * 测试 provider 连通性，并返回可用模型列表
 * @param {Object} opts 同 generate，但 api_key 可选（Ollama 不需要）
 * @returns {Promise<{ ok, models?, error? }>}
 */
async function testProvider(opts) {
    const provider = opts.provider;
    const baseUrl = (opts.base_url || '').replace(/\/+$/, '');
    if (!provider || !baseUrl) return { ok: false, error: 'provider / base_url 必填' };

    try {
        if (provider === 'openai') {
            const url = baseUrl + '/models';
            const res = await _fetch(url, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + (opts.api_key || '') },
                signal: opts.signal || null,
            });
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            const data = await res.json();
            const models = (data?.data || []).map(m => m.id).filter(Boolean);
            return { ok: true, models };
        } else if (provider === 'anthropic') {
            // Anthropic 无公开 list models 接口；返回固定推荐列表
            const fixed = Object.keys(PRICING).filter(k => k.startsWith('claude-'));
            return { ok: true, models: fixed, note: 'Anthropic 不提供 list API；返回内置推荐列表' };
        } else if (provider === 'ollama') {
            const url = baseUrl + '/api/tags';
            const res = await _fetch(url, { method: 'GET', signal: opts.signal || null });
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            const data = await res.json();
            const models = (data?.models || []).map(m => m.name).filter(Boolean);
            return { ok: true, models };
        }
        return { ok: false, error: '未知 provider' };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

// fetch polyfill（Node 18+ 内置；老版本兜底）
async function _fetch(url, opts) {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch(url, opts);
    }
    const undici = require('undici');
    return undici.fetch(url, opts);
}

/**
 * 判断 provider + model 是否支持思考 / 推理 tokens
 * 返回：
 *   'extended' — Anthropic 风格 extended thinking（参数 budget_tokens）
 *   'reasoning' — OpenAI 风格 reasoning_effort（o1/o3）/ DeepSeek 风格 reasoning_content
 *   'think-tags' — Ollama 本地推理模型用 <think>...</think> 标签
 *   null       — 不支持
 */
function supportsThinking(provider, model) {
    if (!provider) return null;
    if (provider === 'anthropic') {
        // 所有 Claude 4 系列都支持 extended thinking（早期 3.x 不支持）
        const m = String(model || '').toLowerCase();
        if (m.includes('claude-3') && !m.includes('claude-3-7')) return null;
        return 'extended';
    }
    if (provider === 'openai') {
        return _isReasoningOpenAIModel(model) ? 'reasoning' : null;
    }
    if (provider === 'ollama') {
        // 启发式：模型名包含 deepseek-r1 / qwq / qwen3 / reasoner 等
        const m = String(model || '').toLowerCase();
        if (m.includes('deepseek-r1') || m.includes('qwq') || m.includes('qwen3') || m.includes('reasoner')) {
            return 'think-tags';
        }
        return null;
    }
    return null;
}

module.exports = {
    generate,
    generateStream,
    testProvider,
    supportsThinking,
    // 暴露给 main.js 的工具
    PRICING,
    _normalizeModel,
    _estimateCost,
    _isReasoningOpenAIModel,
    _splitThinkTags,
};

// ============ SSE / NDJSON 流式支持 ============
// generateStream(opts, onChunk) — 与 generate() 同一组参数，但每收到一段 text delta
// 就回调 onChunk(deltaText, accumulatedText)。最终返回 { text, prompt_tokens,
// completion_tokens, cost_usd, duration_ms, estimated, raw }，形状与 generate() 一致
// （不破坏调用方）。

async function generateStream(opts, onChunk) {
    const provider = opts.provider;
    const baseUrl = (opts.base_url || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('novel.generateStream: base_url 必填');
    if (typeof onChunk !== 'function') throw new Error('novel.generateStream: onChunk 必填');

    const startedAt = Date.now();
    const onThinkingChunk = (typeof opts.onThinkingChunk === 'function') ? opts.onThinkingChunk : null;
    const thinkingBudget = opts.thinking_budget != null ? Number(opts.thinking_budget) : 0;
    const reasoningEffort = opts.reasoning_effort || null;
    let result;
    if (provider === 'openai') {
        result = await _openaiStream({
            baseUrl, apiKey: opts.api_key, model: opts.model,
            system: opts.system, user: opts.user,
            temperature: opts.temperature, maxTokens: opts.max_tokens,
            reasoningEffort, signal: opts.signal,
        }, onChunk, onThinkingChunk);
    } else if (provider === 'anthropic') {
        result = await _anthropicStream({
            baseUrl, apiKey: opts.api_key, model: opts.model,
            system: opts.system, user: opts.user,
            temperature: opts.temperature, maxTokens: opts.max_tokens,
            thinkingBudget, signal: opts.signal,
        }, onChunk, onThinkingChunk);
    } else if (provider === 'ollama') {
        result = await _ollamaStream({
            baseUrl, model: opts.model,
            system: opts.system, user: opts.user,
            temperature: opts.temperature, maxTokens: opts.max_tokens,
            parseThinkTags: thinkingBudget > 0,
            signal: opts.signal,
        }, onChunk, onThinkingChunk);
    } else {
        throw new Error('novel.generateStream: 未知 provider: ' + provider);
    }

    const durationMs = Date.now() - startedAt;
    const costUsd = _estimateCost(opts.model, result.prompt_tokens, result.completion_tokens);
    return {
        text: result.text,
        thinking: result.thinking || '',
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        reasoning_tokens: result.reasoning_tokens || null,
        cost_usd: costUsd,
        duration_ms: durationMs,
        estimated: !!result.estimated,
        raw: result.raw,
    };
}

// —— 流读取辅助 ——
// OpenAI / Anthropic 用 SSE（事件以 \n\n 分隔）；Ollama 用 NDJSON（每行一个 JSON）。
async function _readSse(res, onEvent) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        // 老 node fallback：整段读
        const text = await res.text();
        if (text.trim()) onEvent(text);
        return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (raw.trim()) onEvent(raw);
        }
    }
    if (buffer.trim()) onEvent(buffer);
}

async function _readNdjson(res, onLine) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text();
        text.split('\n').forEach(l => { if (l.trim()) onLine(l); });
        return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim()) onLine(line);
        }
    }
    if (buffer.trim()) onLine(buffer);
}

// OpenAI 兼容（Chat Completions stream）
// DeepSeek reasoner / R1 等兼容 OpenAI 接口的推理模型会在 delta.reasoning_content 输出思考；
// OpenAI 官方 o1/o3 的 reasoning_tokens 不在流里（仅最终 usage），所以 stream 里只能拿到输出文本
async function _openaiStream(args, onChunk, onThinkingChunk) {
    const { baseUrl, apiKey, model, system, user, temperature, maxTokens, reasoningEffort, signal } = args;
    const isReasoning = _isReasoningOpenAIModel(model);
    const body = {
        model,
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
        ],
        stream: true,
    };
    if (isReasoning) {
        body.max_completion_tokens = maxTokens;
        if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    } else {
        body.temperature = temperature;
        body.max_tokens = maxTokens;
    }
    // 很多 OpenAI 兼容实现支持 stream_options.include_usage，让末尾再发一段 usage
    body.stream_options = { include_usage: true };
    const res = await _fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (apiKey || ''),
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('OpenAI HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    let accumulated = '';
    let thinkingAccum = '';
    let promptTokens = null;
    let completionTokens = null;
    let reasoningTokens = null;
    let raw = null;
    await _readSse(res, (evt) => {
        for (const line of evt.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const obj = JSON.parse(payload);
                raw = obj;
                const delta = obj?.choices?.[0]?.delta || {};
                // reasoning_content：DeepSeek / 部分 OpenAI 兼容实现
                if (delta.reasoning_content) {
                    thinkingAccum += delta.reasoning_content;
                    if (onThinkingChunk) onThinkingChunk(delta.reasoning_content, thinkingAccum);
                }
                if (delta.content) {
                    accumulated += delta.content;
                    onChunk(delta.content, accumulated);
                }
                // OpenAI 在 stream_options.include_usage 时，最后一个 chunk 会带 usage 字段
                if (obj?.usage) {
                    if (obj.usage.prompt_tokens != null) promptTokens = obj.usage.prompt_tokens;
                    if (obj.usage.completion_tokens != null) completionTokens = obj.usage.completion_tokens;
                    if (obj.usage.reasoning_tokens != null) reasoningTokens = obj.usage.reasoning_tokens;
                }
            } catch {}
        }
    });
    return {
        text: accumulated, thinking: thinkingAccum,
        prompt_tokens: promptTokens, completion_tokens: completionTokens,
        reasoning_tokens: reasoningTokens, raw,
    };
}

// Anthropic Messages API stream
// thinkingBudget > 0 启用 extended thinking：会处理 content_block_delta 的
//   delta.type === 'thinking_delta'（传 onThinkingChunk）
//   delta.type === 'text_delta'（传 onChunk）
async function _anthropicStream(args, onChunk, onThinkingChunk) {
    const { baseUrl, apiKey, model, system, user, temperature, maxTokens, thinkingBudget, signal } = args;
    const useThinking = thinkingBudget && thinkingBudget > 0;
    const body = {
        model,
        system: system || undefined,
        messages: [{ role: 'user', content: user }],
        max_tokens: maxTokens || 4096,
        stream: true,
    };
    if (useThinking) {
        if ((maxTokens || 4096) <= thinkingBudget) {
            body.max_tokens = thinkingBudget + 4096;
        }
        body.thinking = { type: 'enabled', budget_tokens: Number(thinkingBudget) };
    } else {
        body.temperature = temperature;
    }
    const res = await _fetch(baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('Anthropic HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    let accumulated = '';
    let thinkingAccum = '';
    let promptTokens = null;
    let completionTokens = null;
    let raw = null;
    await _readSse(res, (evt) => {
        // SSE 事件可多行：event: ... \n data: ... \n
        let eventType = '';
        let dataLine = '';
        for (const line of evt.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) eventType = trimmed.slice(6).trim();
            else if (trimmed.startsWith('data:')) dataLine = trimmed.slice(5).trim();
        }
        if (!dataLine) return;
        try {
            const obj = JSON.parse(dataLine);
            raw = obj;
            if (eventType === 'content_block_delta') {
                const d = obj?.delta;
                if (d?.type === 'thinking_delta' && d.thinking) {
                    thinkingAccum += d.thinking;
                    if (onThinkingChunk) onThinkingChunk(d.thinking, thinkingAccum);
                } else if (d?.type === 'text_delta' && d.text) {
                    accumulated += d.text;
                    onChunk(d.text, accumulated);
                }
            } else if (eventType === 'message_delta' && obj?.usage) {
                if (obj.usage.input_tokens != null) promptTokens = obj.usage.input_tokens;
                if (obj.usage.output_tokens != null) completionTokens = obj.usage.output_tokens;
            }
        } catch {}
    });
    return {
        text: accumulated, thinking: thinkingAccum,
        prompt_tokens: promptTokens, completion_tokens: completionTokens, raw,
    };
}

// Ollama Chat API stream（NDJSON）
// 本地推理模型（deepseek-r1 / qwq 等）通过 <think>...</think> 输出思考；
// parseThinkTags=true 时一边累加一边把 think 块切到 thinkingAccum
async function _ollamaStream(args, onChunk, onThinkingChunk) {
    const { baseUrl, model, system, user, temperature, maxTokens, parseThinkTags, signal } = args;
    const body = {
        model,
        messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
        ],
        stream: true,
        options: { temperature, num_predict: maxTokens },
    };
    const res = await _fetch(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error('Ollama HTTP ' + res.status + ': ' + (errText || res.statusText).slice(0, 500));
    }
    let accumulated = '';
    let thinkingAccum = '';
    let promptTokens = null;
    let completionTokens = null;
    let raw = null;
    // think-tag 解析器：维护一个状态机，跟踪是否在 <think>...</think> 内部
    let inThink = false;
    let tagBuf = '';
    await _readNdjson(res, (line) => {
        try {
            const obj = JSON.parse(line);
            raw = obj;
            const delta = obj?.message?.content || '';
            if (!delta) {
                if (obj?.done) {
                    if (obj.prompt_eval_count != null) promptTokens = obj.prompt_eval_count;
                    if (obj.eval_count != null) completionTokens = obj.eval_count;
                }
                return;
            }
            if (!parseThinkTags) {
                accumulated += delta;
                onChunk(delta, accumulated);
                return;
            }
            // 增量解析 <think>...</think>
            for (const ch of delta) {
                if (inThink) {
                    tagBuf += ch;
                    if (tagBuf.endsWith('</think>')) {
                        // 切出 thinking 块
                        const thinkContent = tagBuf.slice(0, -8);
                        thinkingAccum += thinkContent;
                        if (onThinkingChunk) onThinkingChunk(thinkContent, thinkingAccum);
                        tagBuf = '';
                        inThink = false;
                    }
                } else {
                    tagBuf += ch;
                    if (tagBuf.endsWith('<think>')) {
                        // 把 <think> 之前的部分作为 output flush
                        const outPart = tagBuf.slice(0, -7);
                        if (outPart) {
                            accumulated += outPart;
                            onChunk(outPart, accumulated);
                        }
                        tagBuf = '';
                        inThink = true;
                    } else if (tagBuf.length > 12) {
                        // buffer 太长且不在 think 中 → flush
                        accumulated += tagBuf;
                        onChunk(tagBuf, accumulated);
                        tagBuf = '';
                    }
                }
            }
            if (obj?.done) {
                if (obj.prompt_eval_count != null) promptTokens = obj.prompt_eval_count;
                if (obj.eval_count != null) completionTokens = obj.eval_count;
            }
        } catch {}
    });
    // 流结束：flush tagBuf
    if (parseThinkTags && tagBuf) {
        if (inThink) {
            thinkingAccum += tagBuf;
            if (onThinkingChunk) onThinkingChunk(tagBuf, thinkingAccum);
        } else {
            accumulated += tagBuf;
            onChunk(tagBuf, accumulated);
        }
    }
    // 兜底：Ollama 没回 usage 时按字符估算
    if (promptTokens == null) promptTokens = _estimateTokens((system || '') + user);
    if (completionTokens == null) completionTokens = _estimateTokens(accumulated);
    return {
        text: accumulated, thinking: thinkingAccum,
        prompt_tokens: promptTokens, completion_tokens: completionTokens,
        estimated: true, raw,
    };
}