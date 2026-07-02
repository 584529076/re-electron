// comfyui-ws.js — ComfyUI 任务跟踪（HTTP 轮询实现）
//
// 原本设计用 WebSocket 监听 /ws?clientId=<uuid>；Electron 32 用 Node 20.16，
// 全局 WebSocket 不可用，且不想为这一个特性加 ws 依赖。
// 改用 HTTP 轮询 /history/<prompt_id>：每 1.5s 拉一次，发现 outputs 出现
// 就 GET /view 拿图片，转 data URL，emit 'complete'。
//
// 事件：on('progress', cb) | on('complete', cb) | on('error', cb) | on('close', cb)
// 用 EventEmitter 风格，可在 job 结束或外部 cancel 时移除。

'use strict';

const { EventEmitter } = require('events');
const { COMFYUI_JOBS, notifyRenderer, abortAllJobs } = require('./comfyui-state');
const { extractModels } = require('./comfyui-workflow-meta');

const POLL_INTERVAL_MS = 1500;
const STATS_INTERVAL_MS = 2000; // 2s 一次采 /system_stats 拿 VRAM
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 启动一个任务跟踪：POST /prompt 拿到 promptId，注册到 COMFYUI_JOBS，
 * 启动轮询。返回 { jobId, promptId }。
 *
 * @param {Object} opts
 * @param {string} opts.port            ComfyUI 端口
 * @param {Object} opts.workflowJson    workflow 完整 JSON（已注入 placeholder）
 * @param {string} opts.clientId        UUID，每 job 一个
 * @param {AbortSignal} [opts.signal]   外部 abort 触发 cancel
 * @param {number} [opts.timeoutMs]     超时（默认 10min）
 * @param {string} [opts.mode]          'sfw' | 'nsfw'，日志用
 * @param {string[]} [opts.preferredNodeIds]  优先取结果的节点 ID 列表（schema.outputNodes 里的 nodeId）
 *                                            一个 workflow 有多个输出节点时（如 VHS_VideoCombine + PreviewImage），
 *                                            优先从这些节点取第一个产物，避免取到 PreviewImage 的预览小图
 * @param {Array<{nodeId,type}>} [opts.outputNodes]  schema.outputNodes 全量（含 type）
 *                                            任意一项 type === 'text' 时走文本输出路径（llama.cpp/PreviewText 这类）
 */
function startJob(opts) {
    const { port, workflowJson, clientId, signal, timeoutMs, mode, preferredNodeIds, outputNodes } = opts;
    const jobId = `cui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ac = new AbortController();
    const ee = new EventEmitter();
    const startedAt = Date.now();
    let pollTimer = null;
    let statsTimer = null;     // 周期采样 /system_stats 拿 vram 峰值
    let timeoutTimer = null;
    let lastNode = null;
    let vramPeakBytes = 0;     // 整次 job 的 VRAM 峰值（取所有采样点最大值）

    // 把外部 signal 接到我们的 ac
    if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    // 1) POST /prompt
    (async () => {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflowJson, client_id: clientId }),
                signal: ac.signal,
            });
            if (!r.ok) {
                const text = await r.text().catch(() => '');
                throw new Error(`POST /prompt 失败: HTTP ${r.status} ${text.slice(0, 200)}`);
            }
            const j = await r.json();
            if (!j || !j.prompt_id) throw new Error('ComfyUI 返回缺 prompt_id');
            const promptId = j.prompt_id;
            COMFYUI_JOBS.set(jobId, { ac, ws: null, promptId, startedAt, mode });
            ee.emit('started', { jobId, promptId });
            // 启动轮询 + 超时
            pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
            // 周期采 /system_stats 抓 VRAM 峰值（用于结果元数据）
            statsTimer = setInterval(() => sampleStats(), STATS_INTERVAL_MS);
            timeoutTimer = setTimeout(() => {
                ac.abort('timeout');
            }, timeoutMs || DEFAULT_TIMEOUT_MS);
        } catch (e) {
            cleanup();
            const msg = e && e.message || String(e);
            ee.emit('error', { jobId, code: 'submit_failed', message: msg });
            notifyRenderer('comfyui:event:error', { jobId, code: 'submit_failed', message: msg });
        }
    })();

    // 2) 轮询 /history/<prompt_id>
    async function pollOnce() {
        if (ac.signal.aborted) { cleanup(); return; }
        const job = COMFYUI_JOBS.get(jobId);
        if (!job) { cleanup(); return; }
        const promptId = job.promptId;
        try {
            const r = await fetch(`http://127.0.0.1:${port}/history/${encodeURIComponent(promptId)}`, { signal: ac.signal });
            if (!r.ok) {
                // 还在跑（404 / 空）= 正常
                if (r.status === 404 || r.status === 400) return;
                throw new Error(`/history HTTP ${r.status}`);
            }
            const data = await r.json();
            const entry = data && data[promptId];
            if (!entry) return; // 还没数据，继续轮询
            // entry.status = { completed, status_str: 'success' | 'error' }
            if (entry.status && entry.status.completed) {
                if (entry.status.status_str === 'error') {
                    const msg = (entry.status.messages && entry.status.messages.length)
                        ? entry.status.messages.map(m => (m[0] || '') + ': ' + (m[1] || '')).join('\n')
                        : 'ComfyUI 报告错误';
                    throw new Error(msg);
                }
                // success：按 outputNodes 类型分发
                //   - 有 type === 'text' 的输出节点 → 走文本路径（llama.cpp/PreviewText 等）
                //   - 否则走图片路径（SaveImage / VHS_VideoCombine 等）
                const hasTextOutput = Array.isArray(outputNodes) && outputNodes.some(n => n && n.type === 'text');
                if (hasTextOutput) {
                    const texts = extractTextOutput(entry, preferredNodeIds);
                    if (!texts.length) throw new Error('ComfyUI 成功但 outputs 中找不到文本产物');
                    const text = texts[0];
                    const meta = {
                        width: null, height: null,
                        node: lastNode,
                        mode: mode || null,
                        fileSize: Buffer.byteLength(text, 'utf8'),
                        elapsedMs: Date.now() - startedAt,
                        vramPeakBytes,
                        models: extractModels(workflowJson),
                    };
                    ee.emit('complete', {
                        jobId, promptId,
                        kind: 'text',
                        text,
                        filename: `node-${(outputNodes.find(n => n && n.type === 'text') || {}).nodeId || '9'}-text.txt`,
                        mime: 'text/plain',
                        dataUrl: null,
                        meta,
                    });
                    notifyRenderer('comfyui:event:complete', {
                        jobId, promptId,
                        kind: 'text',
                        text,
                        filename: `node-${(outputNodes.find(n => n && n.type === 'text') || {}).nodeId || '9'}-text.txt`,
                        mime: 'text/plain',
                        dataUrl: null,
                        meta,
                    });
                } else {
                    // success：拉 outputs → 拿图片
                    const images = extractImages(entry, preferredNodeIds);
                    if (!images.length) throw new Error('ComfyUI 成功但 outputs 中找不到 image/gif/video 产物');
                    // 取第一张
                    const img = images[0];
                    const buf = await fetchImage(port, img);
                    const mime = mimeFromFilename(img.filename);
                    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
                    const meta = {
                        width: null, height: null,
                        node: lastNode,
                        mode: mode || null,
                        fileSize: buf.length,
                        elapsedMs: Date.now() - startedAt,
                        vramPeakBytes,
                        models: extractModels(workflowJson),
                    };
                    ee.emit('complete', { jobId, promptId, kind: 'image', dataUrl, filename: img.filename, mime, meta });
                    notifyRenderer('comfyui:event:complete', { jobId, promptId, kind: 'image', dataUrl, filename: img.filename, mime, meta });
                }
                cleanup();
            } else {
                // 还在跑，发个 progress（无更细粒度就发 value/max = 0/0）
                notifyRenderer('comfyui:event:progress', { jobId, value: 0, max: 0, node: lastNode });
            }
        } catch (e) {
            if (ac.signal.aborted) { cleanup(); return; }
            const msg = e && e.message || String(e);
            ee.emit('error', { jobId, code: 'poll_failed', message: msg });
            notifyRenderer('comfyui:event:error', { jobId, code: 'poll_failed', message: msg });
            cleanup();
        }
    }

    function cleanup() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        ac.abort('cleanup');
        COMFYUI_JOBS.delete(jobId);
        ee.emit('close', { jobId });
    }

    // 外部 ac.abort() 触发 → 关轮询
    ac.signal.addEventListener('abort', () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    });

    // 采 /system_stats：找当前 VRAM 峰值，更新 vramPeakBytes
    async function sampleStats() {
        if (ac.signal.aborted) return;
        try {
            const r = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: ac.signal });
            if (!r.ok) return;
            const j = await r.json();
            // devices[*].vram_usage 单卡值；取最大一张卡
            const devices = Array.isArray(j && j.devices) ? j.devices : [];
            let peak = 0;
            for (const d of devices) {
                const v = Number(d && d.vram_usage);
                if (Number.isFinite(v) && v > peak) peak = v;
            }
            if (peak > vramPeakBytes) vramPeakBytes = peak;
        } catch {
            // 单次失败忽略，下一次继续
        }
    }

    return {
        jobId,
        ee,
        cancel: (reason) => ac.abort(reason || 'user cancel'),
    };
}

function extractTextOutput(historyEntry, preferredNodeIds) {
    // 文本节点（llama_cpp_instruct_adv / PreviewText / SaveText / DisplayString 等）的 history 输出形状不固定：
    //   - 旧版：outputs[nodeId] = { text: ["the prompt"] }       （小写，数组）
    //   - 新版：outputs[nodeId] = { STRING: ["the prompt"] }     （大写，ComfyUI 类型系统）
    //   - 部分自定义节点：outputs[nodeId] = { result: "..." }     （字符串直接挂）
    //   - 还有：outputs[nodeId] = { string: "..." }              （小写字符串）
    // 全部收集，按 preferredNodeIds 优先。
    const out = [];
    const outputs = historyEntry && historyEntry.outputs;
    if (!outputs) return out;
    const preferred = Array.isArray(preferredNodeIds) ? preferredNodeIds.map(String) : [];
    const preferredSet = new Set(preferred);
    const KEYS = ['text', 'STRING', 'result', 'string'];
    function collect(o) {
        if (!o) return;
        for (const key of KEYS) {
            const v = o[key];
            if (Array.isArray(v)) {
                for (const t of v) if (typeof t === 'string' && t.length) out.push(t);
            } else if (typeof v === 'string' && v.length) {
                out.push(v);
            }
        }
    }
    // 第一遍：preferred 节点
    for (const nodeId of preferred) {
        collect(outputs[nodeId]);
    }
    // 第二遍：剩余节点
    for (const nodeId of Object.keys(outputs)) {
        if (preferredSet.has(String(nodeId))) continue;
        collect(outputs[nodeId]);
    }
    return out;
}

function extractImages(historyEntry, preferredNodeIds) {
    // ComfyUI history 输出：{ outputs: { [nodeId]: { images|gifs|videos: [{ filename, subfolder, type, format }, ...] } } }
    // VHS_VideoCombine / VHS_VideoCombineFromAudio 等节点把视频产物放进 gifs[]（不管格式是 mp4/webm/gif），
    // 部分新版本用 videos[]，标准 SaveImage 用 images[]。三者都收集。
    //
    // preferredNodeIds（来自 schema.outputNodes）指定的节点优先返回，避免取到 PreviewImage 这类辅助节点的预览小图。
    // 例如 I2V workflow 同时有 PreviewImage(244) + VHS_VideoCombine(245)，preferredNodeIds=['245'] 时先取视频。
    const out = [];
    const outputs = historyEntry && historyEntry.outputs;
    if (!outputs) return out;
    const preferred = Array.isArray(preferredNodeIds) ? preferredNodeIds.map(String) : [];
    const preferredSet = new Set(preferred);
    // 第一遍：按 preferredNodeIds 顺序收（即使节点没有输出也只是跳过，不影响后续）
    for (const nodeId of preferred) {
        const o = outputs[nodeId];
        if (!o) continue;
        for (const key of ['images', 'gifs', 'videos']) {
            if (Array.isArray(o[key])) {
                for (const img of o[key]) {
                    out.push({
                        filename: img.filename,
                        subfolder: img.subfolder || '',
                        type: img.type || 'output',
                        format: img.format || '',
                    });
                }
            }
        }
    }
    // 第二遍：收剩余节点（跳过已收的 preferred）
    for (const nodeId of Object.keys(outputs)) {
        if (preferredSet.has(String(nodeId))) continue;
        const o = outputs[nodeId];
        if (!o) continue;
        for (const key of ['images', 'gifs', 'videos']) {
            if (Array.isArray(o[key])) {
                for (const img of o[key]) {
                    out.push({
                        filename: img.filename,
                        subfolder: img.subfolder || '',
                        type: img.type || 'output',
                        format: img.format || '',
                    });
                }
            }
        }
    }
    return out;
}

async function fetchImage(port, img) {
    const qs = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || '',
        type: img.type || 'output',
    });
    const r = await fetch(`http://127.0.0.1:${port}/view?${qs.toString()}`);
    if (!r.ok) throw new Error(`/view HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
}

function mimeFromFilename(fn) {
    const ext = (fn.split('.').pop() || '').toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    if (ext === 'mkv') return 'video/x-matroska';
    return 'application/octet-stream';
}

module.exports = { startJob, mimeFromFilename };
