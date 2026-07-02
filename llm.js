// llm.js — D-27 Ollama 客户端
//
// 功能：
//   - listModels(baseUrl)：拉本地 Ollama 已下载的模型
//   - generate({baseUrl, model, system, prompt, signal})：流式/非流式生成（支持取消）
//
// 协议：Ollama 原生 API
//   - GET  /api/tags        拉模型列表
//   - POST /api/chat        OpenAI 兼容 chat（messages 格式）
//   - POST /api/generate    简单 prompt → response
//
// 取消机制：
//   - 主进程拿 AbortController 调 fetch，signal 触发则 abort
//   - 主进程在 LLM_JOBS Map 里维护 jobId → AbortController，IPC cancel 时 abort 对应 job
'use strict';

const { LLM_JOBS } = require('./llm-state');

/**
 * 拉本地 Ollama 已下载的模型列表
 * @param {string} baseUrl
 * @returns {Promise<{ok, models: [{name, size, modified_at}], error?}>}
 */
async function listModels(baseUrl) {
    const url = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/tags';
    try {
        const r = await fetch(url, { method: 'GET' });
        if (!r.ok) return { ok: false, error: `Ollama 返回 ${r.status}` };
        const data = await r.json();
        const models = (data.models || []).map((m) => ({
            name: m.name,
            size: m.size || 0,
            modified_at: m.modified_at || '',
            family: m.details?.family || '',
        }));
        return { ok: true, models };
    } catch (e) {
        return { ok: false, error: `无法连接 Ollama: ${e.message}` };
    }
}

/**
 * 调用 Ollama 生成提示词
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} opts.system        系统提示词
 * @param {string} opts.prompt        用户输入（标签拼装）
 * @param {string} opts.jobId         任务 id（用于取消）
 * @param {number} [opts.temperature=0.7]
 * @returns {Promise<{ok, text, error?}>}
 */
async function generate({ baseUrl, model, system, prompt, jobId, temperature }) {
    if (!model) return { ok: false, error: '未指定 model' };
    const url = (baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
    const controller = new AbortController();
    LLM_JOBS.set(jobId, controller);

    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: system || '' },
                    { role: 'user', content: prompt },
                ],
                stream: false,
                options: { temperature: temperature ?? 0.7 },
            }),
        });
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            return { ok: false, error: `Ollama 返回 ${r.status}: ${t.slice(0, 200)}` };
        }
        const data = await r.json();
        const text = data?.message?.content || '';
        return { ok: true, text };
    } catch (e) {
        if (e.name === 'AbortError') return { ok: false, error: '已取消', cancelled: true };
        return { ok: false, error: `生成失败: ${e.message}` };
    } finally {
        LLM_JOBS.delete(jobId);
    }
}

/**
 * 取消一个生成任务
 * @param {string} jobId
 * @returns {boolean} 是否找到并取消了
 */
function cancelJob(jobId) {
    const c = LLM_JOBS.get(jobId);
    if (!c) return false;
    try { c.abort(); } catch {}
    LLM_JOBS.delete(jobId);
    return true;
}

module.exports = { listModels, generate, cancelJob };
