// comfyui-state.js — ComfyUI 主进程全局状态
// 仿 llm-state.js 的轻量 Map / Object 容器，跨模块共享。
//
//   COMFYUI_STATUS      当前服务状态（startService / stopService 维护）
//   COMFYUI_JOBS        jobId → job handle（用于 cancel + 跨模块查询）
//   notifyRenderer()    向主窗口推 comfyui:event:* 事件
//   broadcastExit()     ComfyUI 进程崩溃时推 exit 事件 + abort 所有 jobs
//
// 注意：本文件**只**持有状态，不直接依赖 electron。
//       main.js / comfyui-process.js / comfyui-ws.js 各自 import 自己需要的那部分。

'use strict';

// ========= 状态对象 =========
// shape:
//   {
//     running:   boolean,        // 服务已就绪（/system_stats 可达）= true
//     starting:  boolean,        // 子进程已 spawn，但 /system_stats 尚未就绪
//                                // running=true 时 starting 必然 false；反之亦然
//     pid:       number | null,
//     port:      number | null,
//     startedAt: number | null,  // ms timestamp（spawn 时刻，starting 进入时刻）
//     lastError: string | null,
//     // 子进程 spawn 出来的 handle 存在 process.js 自己 module 内（不暴露）
//   }
const COMFYUI_STATUS = {
    running: false,
    starting: false,
    pid: null,
    port: null,
    startedAt: null,
    lastError: null,
};

// jobId → { ac: AbortController, ws: WebSocket|null, promptId, startedAt, mode }
//   - ac:  用来标记 job 是否被外部取消（comfyui:cancel handler .abort()）
//   - ws:  客户端 WS 句柄，comfyui-ws.js 持有，cancel 时关闭
//   - promptId: ComfyUI 返回的 prompt_id
const COMFYUI_JOBS = new Map();

// ========= 终端日志环形缓冲（被 process.js 喂入；main.js / renderer 读取） =========
// 设计目的：右侧浮层终端控制台展示 ComfyUI stdout/stderr。
// - 喂入：process.js 在 _child.stdout/stderr on('data') 里调 appendComfyLog
// - 读取：main.js 暴露 comfyui:log:get IPC 给 renderer 拉取初始缓冲
// - 实时推送：每次 append 顺手 notifyRenderer('comfyui:event:log', ...)，
//   renderer 开着面板就追加，不开就丢弃（缓冲还在，下次开再拉）
// - 容量：保留最近 N 条（chunk 维度，不切行），溢出丢头
const COMFYUI_LOG_BUFFER = [];
const COMFYUI_LOG_MAX = 2000;

function appendComfyLog(stream, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const entry = { stream: stream === 'stderr' ? 'stderr' : 'stdout', text, ts: Date.now() };
    COMFYUI_LOG_BUFFER.push(entry);
    if (COMFYUI_LOG_BUFFER.length > COMFYUI_LOG_MAX) {
        COMFYUI_LOG_BUFFER.splice(0, COMFYUI_LOG_BUFFER.length - COMFYUI_LOG_MAX);
    }
    notifyRenderer('comfyui:event:log', entry);
}

function getComfyLogBuffer() {
    return COMFYUI_LOG_BUFFER.slice();
}

function clearComfyLogBuffer() {
    COMFYUI_LOG_BUFFER.length = 0;
}

// ========= 推送工具（被 process.js 触发，main.js 注入 sender） =========
let _sender = null;

/** 由 main.js 启动时注入 BrowserWindow.webContents */
function setSender(fn) {
    _sender = typeof fn === 'function' ? fn : null;
}

/** 推一个事件到 renderer；不传 sender 时静默丢弃 */
function notifyRenderer(event, payload) {
    if (!_sender) return;
    try {
        _sender(event, payload);
    } catch (e) {
        // sender 可能在 quit 中，吞掉
    }
}

/** 关闭所有 in-flight job（ComfyUI 进程崩溃时调用） */
function abortAllJobs(reason) {
    for (const [jobId, job] of COMFYUI_JOBS.entries()) {
        try { job.ac?.abort(reason || 'ComfyUI exited'); } catch {}
        try { job.ws?.close(); } catch {}
        COMFYUI_JOBS.delete(jobId);
    }
}

module.exports = {
    COMFYUI_STATUS,
    COMFYUI_JOBS,
    setSender,
    notifyRenderer,
    abortAllJobs,
    appendComfyLog,
    getComfyLogBuffer,
    clearComfyLogBuffer,
};
