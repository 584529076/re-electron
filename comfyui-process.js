// comfyui-process.js — ComfyUI 子进程生命周期管理
// 本 app 之前从未 spawn 过任何子进程（Ollama 都是用户外部启的）；
// 这是首个 child_process 持有者，要保证：
//   1) 路径校验（python.exe / main.py 都存在；拒绝 .. 段）
//   2) 端口 TCP 探活（被占 + 不可达 = 报错；被占 + 可达 = 复用）
//   3) 启动等待（轮询 /system_stats 最多 30s）
//   4) 进程退出监听（非 0 退出 → 推 comfyui:event:exit + abort all jobs）
//   5) Windows 必须用 taskkill /T /F 杀进程树

'use strict';

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { app } = require('electron');

const { COMFYUI_STATUS, COMFYUI_JOBS, notifyRenderer, abortAllJobs } = require('./comfyui-state');

let _child = null;          // 当前 ChildProcess 句柄
let _userInitiatedStop = false;  // 用户主动 stop 时标记，避免触发 exit 事件

// ComfyUI 启动后等待 /system_stats 可达的最大时长
// Qwen-Image / Flux 类大模型首次启动要加载 ~17GB UNet 到 VRAM，冷启慢；30s 经常不够
const STARTUP_TIMEOUT_MS = 120 * 1000;  // 120s

// ========= 路径校验 =========

function validatePathNoTraversal(p) {
    if (!p || typeof p !== 'string') return '路径为空';
    if (p.includes('..')) return '路径不能包含 .. 段';
    return null;
}

function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config 必填' };
    const { pythonPath, comfyDir, port } = cfg;
    if (!pythonPath) return { ok: false, error: 'Python 路径未配置' };
    if (!comfyDir) return { ok: false, error: 'ComfyUI 目录未配置' };

    const t1 = validatePathNoTraversal(pythonPath);
    if (t1) return { ok: false, error: `Python 路径: ${t1}` };
    const t2 = validatePathNoTraversal(comfyDir);
    if (t2) return { ok: false, error: `ComfyUI 目录: ${t2}` };

    if (!fs.existsSync(pythonPath)) return { ok: false, error: `Python 不存在: ${pythonPath}` };
    // Windows: 必须是 .exe
    if (process.platform === 'win32' && !/\.exe$/i.test(pythonPath)) {
        return { ok: false, error: `Python 路径必须指向 .exe: ${pythonPath}` };
    }
    if (!fs.existsSync(comfyDir)) return { ok: false, error: `ComfyUI 目录不存在: ${comfyDir}` };
    if (!fs.existsSync(path.join(comfyDir, 'main.py'))) {
        return { ok: false, error: `ComfyUI 目录下找不到 main.py: ${comfyDir}` };
    }
    const p = Number(port) || 8188;
    if (p < 1 || p > 65535) return { ok: false, error: `端口非法: ${port}` };
    return { ok: true };
}

// ========= TCP 端口探活 =========

function tcpProbe(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const sock = net.connect({ host, port });
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch {}
            resolve(ok);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
    });
}

// GET /system_stats，验真身是 ComfyUI
async function probeComfyUI(port) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return false;
        const j = await r.json();
        return !!(j && (j.system || j.devices || j.python_version || j.comfyui_version));
    } catch {
        return false;
    }
}

// ========= 启动 / 停止 / 状态 =========

async function startService(cfg) {
    const v = validateConfig(cfg);
    if (!v.ok) return v;

    // 已跑着？直接返回
    if (COMFYUI_STATUS.running && _child && !_child.killed) {
        return { ok: true, pid: COMFYUI_STATUS.pid, port: COMFYUI_STATUS.port, alreadyRunning: true };
    }

    const port = Number(cfg.port) || 8188;

    // 端口已被别的 ComfyUI 占用？试 /system_stats
    const portOpen = await tcpProbe('127.0.0.1', port);
    if (portOpen) {
        const isComfy = await probeComfyUI(port);
        if (isComfy) {
            // 复用外部启动的 ComfyUI；不 spawn 子进程
            COMFYUI_STATUS.running = true;
            COMFYUI_STATUS.pid = null;
            COMFYUI_STATUS.port = port;
            COMFYUI_STATUS.startedAt = Date.now();
            COMFYUI_STATUS.lastError = null;
            return { ok: true, pid: null, port, external: true };
        }
        return { ok: false, error: `端口 ${port} 已被其他进程占用，但不是 ComfyUI` };
    }

    // 真正 spawn
    const args = ['main.py', '--port', String(port), '--listen', '127.0.0.1'];
    if (cfg.extraArgs && Array.isArray(cfg.extraArgs)) args.push(...cfg.extraArgs);

    try {
        _child = spawn(cfg.pythonPath, args, {
            cwd: cfg.comfyDir,
            detached: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) {
        COMFYUI_STATUS.lastError = `spawn 失败: ${e.message}`;
        return { ok: false, error: COMFYUI_STATUS.lastError };
    }

    _userInitiatedStop = false;
    COMFYUI_STATUS.running = true;
    COMFYUI_STATUS.pid = _child.pid;
    COMFYUI_STATUS.port = port;
    COMFYUI_STATUS.startedAt = Date.now();
    COMFYUI_STATUS.lastError = null;

    // 落 PID 文件（crash 排查用）
    try {
        const pidFile = path.join(getPromptsDirForLog(), 'comfyui.pid');
        fs.writeFileSync(pidFile, String(_child.pid));
    } catch {}

    // 收集 stdout/stderr
    _child.stdout?.on('data', (chunk) => {
        process.stdout.write(`[comfyui] ${chunk}`);
    });
    _child.stderr?.on('data', (chunk) => {
        process.stderr.write(`[comfyui!] ${chunk}`);
    });

    // 进程退出监听
    _child.on('exit', (code, signal) => {
        const userStopped = _userInitiatedStop;
        const crashed = !userStopped && code !== 0 && code !== null;
        if (crashed) {
            COMFYUI_STATUS.lastError = `ComfyUI 退出 (code=${code}, signal=${signal})`;
        } else {
            COMFYUI_STATUS.lastError = userStopped ? null : (COMFYUI_STATUS.lastError || `ComfyUI 已停止 (code=${code})`);
        }
        COMFYUI_STATUS.running = false;
        COMFYUI_STATUS.pid = null;
        // 清理 PID 文件
        try {
            const pidFile = path.join(getPromptsDirForLog(), 'comfyui.pid');
            if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch {}
        // 推 exit 事件 + abort jobs
        if (!userStopped) {
            notifyRenderer('comfyui:event:exit', { pid: COMFYUI_STATUS.pid, code, signal });
            abortAllJobs('ComfyUI exited');
        }
        _child = null;
    });

    // 等 /system_stats 可达
    const ready = await waitForReady(port, STARTUP_TIMEOUT_MS);
    if (!ready) {
        // 启动失败，杀掉
        await killTree(_child.pid);
        _child = null;
        COMFYUI_STATUS.running = false;
        COMFYUI_STATUS.pid = null;
        return { ok: false, error: 'ComfyUI 启动超时（30s 内 /system_stats 未就绪）' };
    }

    return { ok: true, pid: _child.pid, port };
}

async function stopService() {
    if (!_child && !COMFYUI_STATUS.running) {
        return { ok: true, alreadyStopped: true };
    }
    _userInitiatedStop = true;
    if (_child && _child.pid) {
        await killTree(_child.pid);
    }
    // 如果是 external 模式（无 child），只清状态
    COMFYUI_STATUS.running = false;
    COMFYUI_STATUS.pid = null;
    COMFYUI_STATUS.startedAt = null;
    return { ok: true };
}

function getStatus() {
    return {
        running: COMFYUI_STATUS.running,
        pid: COMFYUI_STATUS.pid,
        port: COMFYUI_STATUS.port,
        startedAt: COMFYUI_STATUS.startedAt,
        lastError: COMFYUI_STATUS.lastError,
        uptimeMs: COMFYUI_STATUS.startedAt ? Date.now() - COMFYUI_STATUS.startedAt : 0,
    };
}

async function healthCheck() {
    const port = COMFYUI_STATUS.port;
    if (!port) return { ok: false, error: '服务未配置端口' };
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const stats = await r.json();
        return { ok: true, stats };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ========= 内部 =========

async function waitForReady(port, timeoutMs = STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probeComfyUI(port)) return true;
        // 进程已死？
        if (_child === null || _child.killed) return false;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

function killTree(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        if (process.platform === 'win32') {
            // /T = tree, /F = force
            exec(`taskkill /pid ${pid} /T /F`, (err) => {
                // 即使 taskkill 报"进程未找到"也当作成功
                resolve();
            });
        } else {
            try { process.kill(-pid, 'SIGTERM'); } catch {}
            try { process.kill(pid, 'SIGTERM'); } catch {}
            setTimeout(() => {
                try { process.kill(pid, 'SIGKILL'); } catch {}
                resolve();
            }, 3000);
        }
    });
}

function getPromptsDirForLog() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'prompts');
    return path.join(__dirname, 'prompts');
}

module.exports = {
    startService,
    stopService,
    getStatus,
    healthCheck,
    validateConfig,
};
