// comfyui-ws.js — ComfyUI 任务跟踪（WebSocket 进度 + HTTP 完成检测 + 产物落盘）
//
// 设计（2026-11 改造）：
//   - 进度：WebSocket 连 /ws?clientId=<uuid>，监听 progress / executing 事件，
//     拿真实 value/max 与当前节点；WS 不可用（老版 ComfyUI / 连接失败）时优雅降级为
//     旧的“0/0 心跳”轮询，不阻塞任务。
//   - 完成：仍用 HTTP 轮询 /history/<prompt_id>（WS 的 executed 事件不保证给出完整 outputs）。
//   - 取消：先 POST /cancel {prompt_id}（新 ComfyUI），失败回退 POST /interrupt {}，
//     真正让 GPU 上的图停下来；同时 ac.abort() 停本地轮询。
//   - 产物：全部落盘到 artifactsDir（默认 <promptsDir>/media/results），complete 事件带
//     artifacts 数组 [{path, filename, mime, size, kind, text?, inlineDataUrl?}]，
//     不再把 base64 全量塞进 DB —— 解除大图/视频的内存与 IPC 瓶颈。
//     落盘失败时回退 inlineDataUrl，保证产物不丢。
//
// 事件：on('started'|'progress'|'complete'|'error'|'close', cb)
// 返回：{ jobId, ee, cancel(reason) }

'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { COMFYUI_JOBS, notifyRenderer } = require('./comfyui-state');
const { extractModels } = require('./comfyui-workflow-meta');

const POLL_INTERVAL_MS = 1500;
const STATS_INTERVAL_MS = 2000;      // 2s 一次采 /system_stats 拿 VRAM
const WS_RECONNECT_MS = 3000;        // WS 断线重连间隔
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {Object} opts
 * @param {number} opts.port
 * @param {Object} opts.workflowJson
 * @param {string} opts.clientId
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.mode]                 'sfw' | 'nsfw'
 * @param {string[]} [opts.preferredNodeIds]   优先取结果的节点 ID
 * @param {Array<{nodeId,type}>} [opts.outputNodes]
 * @param {string} [opts.artifactsDir]         产物落盘目录（绝对路径）
 */
function startJob(opts) {
    const {
        port, workflowJson, clientId, signal, timeoutMs,
        mode, preferredNodeIds, outputNodes, artifactsDir,
    } = opts || {};
    const jobId = `cui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ac = new AbortController();
    const ee = new EventEmitter();
    const startedAt = Date.now();
    let pollTimer = null;
    let statsTimer = null;
    let timeoutTimer = null;
    let ws = null;
    let wsReconnectTimer = null;
    let wsClosedByUs = false;
    let lastNode = null;
    let lastProgress = { value: 0, max: 0 };
    let vramPeakBytes = 0;
    let settled = false;
    let handleRef = null;   // 指向最终返回的 handle，供旧 cancel 频道调用真取消

    if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }

    // ---------- 1) WebSocket 进度 ----------
    function connectWS() {
        if (ac.signal.aborted || settled) return;
        let url;
        try {
            url = `ws://127.0.0.1:${port}/ws?clientId=${encodeURIComponent(clientId)}`;
            ws = new WebSocket(url);
        } catch (e) {
            scheduleWSReconnect();
            return;
        }
        const job = COMFYUI_JOBS.get(jobId);
        if (job) job.ws = ws;

        ws.on('open', () => { /* 连上即可，ComfyUI 不主动推历史进度 */ });

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (ac.signal.aborted || settled) return;
            switch (msg.type) {
                case 'progress':
                    lastProgress = { value: Number(msg.value) || 0, max: Number(msg.max) || 0 };
                    ee.emit('progress', { ...lastProgress, node: msg.node || lastNode });
                    notifyRenderer('comfyui:event:progress', {
                        jobId, ...lastProgress, node: msg.node || lastNode,
                    });
                    break;
                case 'executing': {
                    const node = msg.node != null ? String(msg.node) : null;
                    // node === null 表示本次 prompt 执行结束（ComfyUI 约定）
                    if (node) {
                        lastNode = node;
                        ee.emit('progress', { ...lastProgress, node });
                        notifyRenderer('comfyui:event:progress', {
                            jobId, ...lastProgress, node,
                        });
                    }
                    break;
                }
                case 'execution_error': {
                    const detail = msg.exception_message || msg.error || 'ComfyUI 执行出错';
                    failJob('execution_error', String(detail));
                    break;
                }
                default:
                    break;
            }
        });

        ws.on('close', () => {
            if (wsClosedByUs || ac.signal.aborted || settled) return;
            scheduleWSReconnect();
        });
        ws.on('error', () => { /* close 事件里统一处理重连，避免重复 */ });
    }

    function scheduleWSReconnect() {
        if (ac.signal.aborted || settled || wsReconnectTimer) return;
        wsReconnectTimer = setTimeout(() => {
            wsReconnectTimer = null;
            connectWS();
        }, WS_RECONNECT_MS);
    }

    // ---------- 2) POST /prompt ----------
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
            COMFYUI_JOBS.set(jobId, {
                ac, ws: null, promptId, startedAt, mode,
                cancelFn: (reason) => { if (handleRef) handleRef.cancel(reason); },
            });
            connectWS();
            ee.emit('started', { jobId, promptId });
            pollTimer = setInterval(() => pollOnce(), POLL_INTERVAL_MS);
            statsTimer = setInterval(() => sampleStats(), STATS_INTERVAL_MS);
            timeoutTimer = setTimeout(() => {
                // 超时：真取消 + 发 error 让上层把任务收尾为 failed（否则永远卡 running）
                interruptComfy(port, promptId).catch(() => {});
                failJob('timeout', `任务超时（${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 60000)} 分钟）`);
            }, timeoutMs || DEFAULT_TIMEOUT_MS);
        } catch (e) {
            if (ac.signal.aborted) return;
            cleanup();
            const msg = e && e.message || String(e);
            ee.emit('error', { jobId, code: 'submit_failed', message: msg });
            notifyRenderer('comfyui:event:error', { jobId, code: 'submit_failed', message: msg });
        }
    })();

    // ---------- 3) 轮询 /history ----------
    async function pollOnce() {
        if (ac.signal.aborted || settled) { cleanup(); return; }
        const job = COMFYUI_JOBS.get(jobId);
        if (!job) { cleanup(); return; }
        const promptId = job.promptId;
        try {
            const r = await fetch(`http://127.0.0.1:${port}/history/${encodeURIComponent(promptId)}`, { signal: ac.signal });
            if (!r.ok) {
                if (r.status === 404 || r.status === 400) return; // 还在跑
                throw new Error(`/history HTTP ${r.status}`);
            }
            const data = await r.json();
            const entry = data && data[promptId];
            if (!entry) return;
            if (entry.status && entry.status.completed) {
                if (entry.status.status_str === 'error') {
                    const msg = (entry.status.messages && entry.status.messages.length)
                        ? entry.status.messages.map(m => (m[0] || '') + ': ' + (m[1] || '')).join('\n')
                        : 'ComfyUI 报告错误';
                    throw new Error(msg);
                }
                settled = true;
                await deliverResult(entry, promptId);
                cleanup();
            } else if (!ws || ws.readyState !== WebSocket.OPEN) {
                // WS 不可用时的降级心跳（避免进度条完全不动）
                notifyRenderer('comfyui:event:progress', { jobId, ...lastProgress, node: lastNode, fallback: true });
            }
        } catch (e) {
            if (ac.signal.aborted || settled) { cleanup(); return; }
            failJob('poll_failed', e && e.message || String(e));
        }
    }

    async function deliverResult(entry, promptId) {
        const meta = {
            width: null, height: null,
            node: lastNode,
            mode: mode || null,
            elapsedMs: Date.now() - startedAt,
            vramPeakBytes,
            models: extractModels(workflowJson),
            progress: lastProgress,
        };
        const hasTextOutput = Array.isArray(outputNodes) && outputNodes.some(n => n && n.type === 'text');
        if (hasTextOutput) {
            const texts = extractTextOutput(entry, preferredNodeIds);
            if (!texts.length) throw new Error('ComfyUI 成功但 outputs 中找不到文本产物');
            const artifacts = texts.map((t, i) => ({
                path: null, kind: 'text', text: t,
                filename: `node-${(preferredNodeIds && preferredNodeIds[0]) || '9'}-text-${i}.txt`,
                mime: 'text/plain', size: Buffer.byteLength(t, 'utf8'),
            }));
            meta.fileSize = artifacts[0].size;
            const payload = {
                jobId, promptId, kind: 'text', text: texts[0],
                filename: artifacts[0].filename, mime: 'text/plain',
                dataUrl: null, artifacts, meta,
            };
            ee.emit('complete', payload);
            notifyRenderer('comfyui:event:complete', { ...payload, artifacts: artifacts.map(stripInline) });
            return;
        }

        const images = extractImages(entry, preferredNodeIds);
        if (!images.length) throw new Error('ComfyUI 成功但 outputs 中找不到 image/gif/video 产物');
        const artifacts = [];
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            let buf;
            try {
                buf = await fetchImage(port, img);
                const mime = mimeFromFilename(img.filename);
                const fileName = await persistArtifact(buf, img.filename, mime);
                artifacts.push({
                    path: fileName ? fileName.abs : null,
                    relPath: fileName ? fileName.rel : null,
                    kind: /^video\//.test(mime) ? 'video' : 'image',
                    filename: img.filename, mime, size: buf.length,
                    inlineDataUrl: fileName ? null : `data:${mime};base64,${buf.toString('base64')}`,
                });
            } catch (e) {
                // 单个产物失败不影响其它产物
                artifacts.push({
                    path: null, kind: 'image', filename: img.filename,
                    mime: mimeFromFilename(img.filename), size: 0,
                    error: e.message,
                });
            }
        }
        const first = artifacts.find(a => !a.error) || artifacts[0];
        meta.fileSize = artifacts.reduce((s, a) => s + (a.size || 0), 0);
        meta.artifactCount = artifacts.length;
        const payload = {
            jobId, promptId, kind: first && first.kind === 'video' ? 'video' : 'image',
            dataUrl: first && first.inlineDataUrl ? first.inlineDataUrl : null,
            filename: first && first.filename, mime: first && first.mime,
            artifacts, meta,
        };
        ee.emit('complete', payload);
        // notifyRenderer 不带 inlineDataUrl（可能很大），前端按需通过 IPC 读文件
        notifyRenderer('comfyui:event:complete', { ...payload, artifacts: artifacts.map(stripInline) });
    }

    function stripInline(a) {
        const { inlineDataUrl, ...rest } = a;
        return rest;
    }

    async function persistArtifact(buf, originalFilename, mime) {
        if (!artifactsDir) return null;
        try {
            await fsp.mkdir(artifactsDir, { recursive: true });
            const ext = (MIME_EXT[mime] || (originalFilename.split('.').pop() || 'bin')).replace(/^\./, '');
            const name = `result-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            const abs = path.join(artifactsDir, name);
            await fsp.writeFile(abs, buf, { flag: 'wx' });
            return { abs, rel: path.join('results', name) };
        } catch (e) {
            return null; // 回退 inlineDataUrl
        }
    }

    function failJob(code, message) {
        if (settled) return;
        settled = true;
        cleanup();
        ee.emit('error', { jobId, code, message });
        notifyRenderer('comfyui:event:error', { jobId, code, message });
    }

    function cleanup() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
        if (ws) {
            try { wsClosedByUs = true; ws.close(); } catch {}
            ws = null;
        }
        ac.abort('cleanup');
        const job = COMFYUI_JOBS.get(jobId);
        if (job) job.ws = null;
        if (!settled) ee.emit('close', { jobId });
    }

    // 外部 ac.abort() → 停 local timers（不在这里 close ws，cancel() 里统一处理）
    ac.signal.addEventListener('abort', () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    });

    async function sampleStats() {
        if (ac.signal.aborted || settled) return;
        try {
            const r = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: ac.signal });
            if (!r.ok) return;
            const j = await r.json();
            const devices = Array.isArray(j && j.devices) ? j.devices : [];
            let peak = 0;
            for (const d of devices) {
                const v = Number(d && d.vram_usage);
                if (Number.isFinite(v) && v > peak) peak = v;
            }
            if (peak > vramPeakBytes) vramPeakBytes = peak;
        } catch { /* 单次失败忽略 */ }
    }

    const handle = {
        jobId,
        ee,
        promptId: () => (COMFYUI_JOBS.get(jobId) || {}).promptId || null,
        cancel: (reason) => {
            const promptId = (COMFYUI_JOBS.get(jobId) || {}).promptId || null;
            settled = true;
            // 真取消：让 ComfyUI 停 GPU
            interruptComfy(port, promptId).catch(() => {});
            try { wsClosedByUs = true; if (ws) ws.close(); } catch {}
            ac.abort(reason || 'user cancel');
            ee.emit('close', { jobId });
        },
    };
    // 返回句柄；cancelFn 已在 POST /prompt 时挂到 COMFYUI_JOBS 条目上
    handleRef = handle;
    return handle;
}

// 真取消：新 ComfyUI 用 POST /cancel {prompt_id}；老版回退 POST /interrupt {}
async function interruptComfy(port, promptId) {
    const base = `http://127.0.0.1:${port}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
        if (promptId) {
            const r = await fetch(`${base}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_id: promptId }),
                signal: ctrl.signal,
            });
            if (r.ok) return true;
        }
    } catch { /* 老版无 /cancel */ }
    try {
        const r = await fetch(`${base}/interrupt`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: '{}', signal: ctrl.signal,
        });
        return r.ok;
    } catch { return false; }
    finally { clearTimeout(t); }
}

function extractTextOutput(historyEntry, preferredNodeIds) {
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
            } else if (typeof v === 'string' && v.length) out.push(v);
        }
    }
    for (const nodeId of preferred) collect(outputs[nodeId]);
    for (const nodeId of Object.keys(outputs)) {
        if (preferredSet.has(String(nodeId))) continue;
        collect(outputs[nodeId]);
    }
    return out;
}

function extractImages(historyEntry, preferredNodeIds) {
    const out = [];
    const outputs = historyEntry && historyEntry.outputs;
    if (!outputs) return out;
    const preferred = Array.isArray(preferredNodeIds) ? preferredNodeIds.map(String) : [];
    const preferredSet = new Set(preferred);
    function collectFrom(o) {
        if (!o) return;
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
    for (const nodeId of preferred) collectFrom(outputs[nodeId]);
    for (const nodeId of Object.keys(outputs)) {
        if (preferredSet.has(String(nodeId))) continue;
        collectFrom(outputs[nodeId]);
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

const MIME_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi',
};

function mimeFromFilename(fn) {
    const ext = (fn.split('.').pop() || '').toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'bmp') return 'image/bmp';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    if (ext === 'mkv') return 'video/x-matroska';
    return 'application/octet-stream';
}

module.exports = {
    startJob, mimeFromFilename,
    extractImages, extractTextOutput, fetchImage, interruptComfy,
};
