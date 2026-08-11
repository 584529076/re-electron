// main.js — Electron 主进程（重构版，2026-06-09）
//
// 变更（D-23 同步到 re-electron）：
//   - prompts 存储从"每条一个 .json 文件"迁到 SQLite（shared/db.js 同一份）
//   - 保留 IPC 接口：prompts:readAll / writeOne / deleteOne / info —— web/js/script.js 一行不改
//   - 首次启动自动迁移：扫描 prompts/*.json 灌进 SQLite，原文件改名为 .bak
//
// 变更（D-25 配置管理）：
//   - 新增 config 存储（同一份 SQLite，单表 kv）：tabs + activeTabId
//   - 三个 IPC：config:get / config:set / config:resource:load
//   - 资源加载器支持 3 种 source.type：
//     - "nas"      → HTTP 目录爬取（BFS，window.api.fsFetchByTab 内部仍走 web 端 fetch）
//     - "local"    → 走主进程 fs.readdir 扫描（突破 web 端 showDirectoryPicker 浏览器限制）
//     - "network"  → 主进程拉每个 URL HEAD 检查可达性 + 整理成媒体列表
//   - 默认 seed：4 个 tab（ai-image / ai-video / nsfw-gallery / more-gallery）
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { KVDb } = require('./db');
const { listModels, generate: llmGenerate, cancelJob } = require('./llm');
const { NSFW_SOURCE_META } = require('./nsfw-system');
const nsfwAssembler = require('./nsfw-assembler');
const { parseDirectory: parseNsfwDirectory } = require('./nsfw-parser');
const { DEFAULT_PROMPT_MODULES, DEFAULT_PROMPT_TAGS, DEFAULT_LLM_CONFIG } = require('./prompt-seed');
// ========= ComfyUI（AI 生图）=========
const comfyuiProcess = require('./comfyui-process');
const comfyuiWs = require('./comfyui-ws');
const comfyuiWorkflows = require('./comfyui-workflows');
const comfyuiToolStore = require('./comfyui-tool-store');
const comfyuiApplier = require('./comfyui-workflow-applier');
const { COMFYUI_STATUS, COMFYUI_JOBS, setSender: setComfySender, notifyRenderer, abortAllJobs: abortAllComfyJobs, getComfyLogBuffer, clearComfyLogBuffer } = require('./comfyui-state');
const { LorasStore, createLinkElevated } = require('./loras-store');
// ========= AI 小说（独立模块）=========
const novelEngine = require('./novel-engine');
const { spawn, execSync, spawnSync } = require('child_process');
// crypto.randomUUID() 用于 task_queue.queueId（列队对外 ID，独立于 comfyui jobId/promptId）
const crypto = require('crypto');

// 关键：app 启动期会通过 Start-Process -Verb RunAs 提权，进程会变成 admin。
// elevated Electron 在某些 Windows 配置下会因为 GPU 加速 / 沙箱渲染失败
// 导致窗口不显示（主进程在跑，但渲染进程黑屏 / 没出来）。
// 提前禁用硬件加速 + 沙箱，避免 elevated 模式下渲染失败。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

// 提权诊断日志：写文件 + stdout 双通道（用户可能从快捷方式启动，看不到 stdout）
const ELEV_LOG_NAME = 'elev-debug.log';
let _elevLogPath = null;
function elevLog(...args) {
    const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
    console.log(line);
    try {
        if (!_elevLogPath) _elevLogPath = path.join(app.getPath('userData'), ELEV_LOG_NAME);
        fs.appendFileSync(_elevLogPath, line + '\n');
    } catch (_) {}
}

let mainWindow = null;
let store = null;         // KVDb 实例（prompt 存储）
let configStore = null;   // KVDb 实例（config 存储，跟 prompts 同一份 db）
let promptsDir = null;    // 兼容老行为：保留 prompts 目录
let lorasStore = null;    // Lora 库数据访问层（Phase 1）

// ========== UAC 一次性提权（app 启动时）==========
// 设计：D-30 重构 — 启动期不是 admin 就直接触发系统 UAC，不再弹自定义 dialog。
// 之后所有 symlink 调用走 fs.symlinkSync（Win32 CreateSymbolicLinkW），无需再触发系统 UAC。
// 流程：
//   1) 进程启动 → isElevated() 检查是否已是 admin（High Mandatory Label）
//   2) 不是 → PowerShell Start-Process -Verb RunAs 自重启（**这一步会弹系统 UAC**）
//   3) 新进程带 --elevated 标记 → 跳过自检 → 继续正常初始化
//
// 与 .exe 思路一致（ShellExecuteW + "runas"），区别是 .exe 每次操作都 UAC，
// 我们提到启动期一次性付 UAC 成本，session 内 0 弹窗。
//
// 用户取消 UAC：relaunchElevated 内已 app.exit(0)，原进程静默退出。
// 用户可再次点击图标重新触发 UAC（标准 Windows admin-app 行为）。

function isElevated() {
    if (process.platform !== 'win32') return true;  // mac/Linux 上不需要此机制
    try {
        // whoami /groups 输出含 "Mandatory Label\High Mandatory Level" → S-1-16-12288
        // 普通进程是 Medium Mandatory Level (S-1-16-8192)
        const out = execSync('whoami /groups', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return /S-1-16-12288/.test(out);
    } catch (_) {
        return false;
    }
}

function relaunchElevated() {
    // 把当前 argv 转发给新进程，并加 --elevated 防止循环
    const exe = process.execPath;
    const args = process.argv.slice(1).filter(a => a !== '--elevated');
    args.push('--elevated');
    const cwd = process.cwd();
    const esc = s => String(s).replace(/'/g, "''");

    elevLog('==== relaunchElevated ====');
    elevLog('exe:', exe);
    elevLog('args:', JSON.stringify(args));
    elevLog('cwd:', cwd);

    // 用临时 .ps1 文件避免 -Command 引号地狱
    // 用 Out-File 写日志（Write-Host 走 information stream，stdout pipe 抓不到）
    // 用 spawnSync 同步等待（带 timeout），保证 PowerShell 卡死时也能拿到日志
    const tmpDir = require('os').tmpdir();
    const psPath = path.join(tmpDir, `relaunch-${process.pid}-${Date.now()}.ps1`);
    const psLogPath = path.join(app.getPath('userData'), `elev-ps-${Date.now()}.log`);

    const psScript = [
        `$ErrorActionPreference = 'Stop'`,
        `$exe = '${esc(exe)}'`,
        `$argArr = @(${args.map(a => `'${esc(a)}'`).join(', ')})`,
        `$cwd = '${esc(cwd)}'`,
        `$logPath = '${esc(psLogPath)}'`,
        `function _log($s) { $s | Out-File -Append -Encoding utf8 $logPath }`,
        // 全部用单引号字面 + 拼接 $var，避免双引号里嵌套 $() 触发 PowerShell 解析歧义
        `$ts = Get-Date -Format 'HH:mm:ss.fff'`,
        `_log ('[elev-ps] start at ' + $ts)`,
        `_log ('[elev-ps] exe  : ' + $exe)`,
        `$argsStr = ($argArr -join ' ')`,
        `_log ('[elev-ps] args : ' + $argsStr)`,
        `_log ('[elev-ps] cwd  : ' + $cwd)`,
        // UAC 设置探测
        `$sysPol = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue`,
        `$enableLUA = $sysPol.EnableLUA`,
        `$consentAdmin = $sysPol.ConsentPromptBehaviorAdmin`,
        `$promptSecure = $sysPol.PromptOnSecureDesktop`,
        `_log ('[elev-ps] EnableLUA=' + $enableLUA)`,
        `_log ('[elev-ps] ConsentPromptBehaviorAdmin=' + $consentAdmin)`,
        `_log ('[elev-ps] PromptOnSecureDesktop=' + $promptSecure)`,
        `_log '[elev-ps] calling Start-Process -Verb RunAs...'`,
        `$proc = Start-Process -FilePath $exe -ArgumentList $argArr -WorkingDirectory $cwd -Verb RunAs -PassThru -ErrorAction SilentlyContinue`,
        `if ($proc -ne $null) {`,
        `    $pidVal = $proc.Id`,
        `    $nameVal = $proc.ProcessName`,
        `    _log ('[elev-ps] Start-Process returned PID=' + $pidVal + ' Name=' + $nameVal)`,
        `    Start-Sleep -Milliseconds 2000`,
        `    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue`,
        `    if ($alive) {`,
        `        $alivePath = $alive.Path`,
        `        _log ('[elev-ps] 2sec later alive Path=' + $alivePath)`,
        `    } else {`,
        `        _log '[elev-ps] 2sec later process exited'`,
        `    }`,
        `} else {`,
        `    _log '[elev-ps] Start-Process returned null'`,
        `}`,
        `_log '[elev-ps] done'`,
    ].join('\r\n');

    try {
        fs.writeFileSync(psPath, psScript, 'utf8');
        elevLog('script:', psPath);
        elevLog('ps log:', psLogPath);
    } catch (e) {
        elevLog('write script failed:', e.message);
        return;
    }

    // 关键：用 spawnSync + timeout 强制卡死也能拿到日志
    // timeout 10 秒（UAC 弹框用户处理时间；如果自动提权，几百毫秒就完）
    let psResult = null;
    try {
        psResult = spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', psPath,
        ], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000,
        });
        elevLog('[ps] sync done. status:', psResult.status, 'signal:', psResult.signal);
        if (psResult.error) elevLog('[ps] error:', psResult.error.message);
        if (psResult.stdout) elevLog('[ps] stdout:', (psResult.stdout || '').slice(0, 500));
        if (psResult.stderr) elevLog('[ps] stderr:', (psResult.stderr || '').slice(0, 500));
    } catch (e) {
        elevLog('[ps] sync threw:', e.message);
    }

    // 读 ps 日志（无论同步是否成功 / 超时）
    try {
        if (fs.existsSync(psLogPath)) {
            const psLog = fs.readFileSync(psLogPath, 'utf8');
            psLog.split(/\r?\n/).filter(Boolean).forEach(line => elevLog('[ps]', line));
            try { fs.unlinkSync(psLogPath); } catch (_) {}
        } else {
            elevLog('[ps] log file does NOT exist (script may not have started)');
        }
    } catch (e) {
        elevLog('[ps] log read failed:', e.message);
    }

    // 清理
    try { fs.unlinkSync(psPath); } catch (_) {}

    elevLog('exiting original process');
    setTimeout(() => app.exit(0), 200);
}

async function ensureElevated() {
    elevLog('ensureElevated start, argv:', JSON.stringify(process.argv));
    const elevated = isElevated();
    elevLog('isElevated() =', elevated);
    if (elevated) return true;
    if (process.argv.includes('--elevated')) {
        // 防御：理论上是 admin 但 whoami 没识别出来（极少见）。
        // 不要再次自重启，避免无限循环。
        elevLog('--elevated 标记存在但 whoami 未识别 High Mandatory Label，按已提权处理');
        return true;
    }
    // D-30：不再弹自定义 dialog。直接触发系统 UAC（PowerShell Start-Process -Verb RunAs）。
    // 用户取消 UAC → PowerShell Start-Process 返回 null → 原进程 relaunchElevated 内 app.exit(0) 静默退出。
    // 用户可再次点击图标重新触发 UAC。
    elevLog('not elevated; calling relaunchElevated to trigger system UAC');
    relaunchElevated();
    return false;
}

function createWindow() {
    // 去掉窗口顶部的默认菜单栏（File / Edit / View / Window / Help）
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        backgroundColor: '#000',
        title: 'RxAi工作台',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'web', 'index.html'));

    // 默认菜单被移除后 Ctrl+Shift+I / F12 的 accelerator 也随之失效，这里手动补回
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        const isF12 = input.key === 'F12';
        const isInspect = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
        if (isF12 || isInspect) {
            mainWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    // ComfyUI: 把 webContents 注册成事件 sender
    setComfySender((channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    });

    // 显式 show + focus：elevated 模式下默认 show 行为有时不可靠
    // 关键：elevated 进程的窗口可能跑到 secure desktop / 不同 window station，
    //       setVisibleOnAllWorkspaces(true) 强制让窗口出现在用户能看到的所有 workspace
    mainWindow.setVisibleOnAllWorkspaces(true);
    mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setVisibleOnAllWorkspaces(true);
            mainWindow.show();
            mainWindow.focus();
            mainWindow.moveTop();
            // 短暂置顶 1 秒确保抢到焦点
            mainWindow.setAlwaysOnTop(true);
            setTimeout(() => { try { mainWindow.setAlwaysOnTop(false); } catch (_) {} }, 1000);
            elevLog('window ready-to-show, shown & focused');
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ========= 路径与存储初始化 =========
function getPromptsDir() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'prompts');
    }
    return path.join(__dirname, 'prompts');
}

// 资产存储（AI 工具生成的图片 + 旁路元数据）
// 默认路径：app.getPath('userData')/assets（packaged）或 __dirname/assets（dev）
// 用户可在设置页改路径，改后存 cfg.dir
const ASSETS_CONFIG_KEY = '__assets_config__';
const ASSETS_DEFAULT_CONFIG = {
    dir: '',  // 空 = 用 defaultAssetsDir()
};
function defaultAssetsDir() {
    const base = app.isPackaged ? app.getPath('userData') : __dirname;
    return path.join(base, 'assets');
}
function getAssetsDir() {
    const cfg = configStore.get(ASSETS_CONFIG_KEY) || {};
    const candidate = (cfg && typeof cfg.dir === 'string' && cfg.dir.trim()) || defaultAssetsDir();
    if (candidate.includes('..')) return defaultAssetsDir();
    try { fs.mkdirSync(candidate, { recursive: true }); return candidate; }
    catch { return defaultAssetsDir(); }
}
// 封面图存储：<userData>/loras-covers/。与 assetsDir 平级、用户改 assets 路径也跟不变。
// 关键：放在 assets 外面，资产扫描器（main.js:680 readdir 递归）才不会把 lora 封面扫进资产界面。
function getCoversDir() {
    const base = app.isPackaged ? app.getPath('userData') : __dirname;
    const dir = path.join(base, 'loras-covers');
    try { fs.mkdirSync(dir, { recursive: true }); return dir; }
    catch { return dir; }
}
function getAssetsConfig() {
    const cfg = configStore.get(ASSETS_CONFIG_KEY);
    return { ...ASSETS_DEFAULT_CONFIG, ...(cfg || {}) };
}
function setAssetsConfig(cfg) {
    const merged = { ...ASSETS_DEFAULT_CONFIG, ...(cfg || {}) };
    configStore.set(ASSETS_CONFIG_KEY, merged);
    return merged;
}
function ensureAssetsDir() {
    const dir = getAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
}

function getDbPath() {
    return path.join(getPromptsDir(), 'prompts.db');
}

function initStore() {
    promptsDir = getPromptsDir();
    fs.mkdirSync(promptsDir, { recursive: true });
    const dbPath = getDbPath();
    store = new KVDb(dbPath);
    configStore = store;  // 同一份 db，命名空间用 key 前缀区分
    migrateLegacyJsonIfNeeded();
    seedDefaultConfigIfNeeded();
    ensureConfigSchema();  // D-26: 老 schema 升级
    seedPromptGenDataIfNeeded();  // D-27: 提示词生成数据
    ensurePromptMenuTable();      // D-31: 分类表（必须在 prompt_items 前）
    ensurePromptItemsTable();     // D-31: 提示词条目表
    ensureNsfwAssociationTables();// D-36: 关联规则 + 场景模板表
    ensurePromptLibraryTables();  // 提示词库：单表 + tags CSV 列（与 NSFW 标签系统完全隔离）
    ensureTaskQueueTable();       // 任务队列表（透明接管 tools:run 提交）
    ensureMediaDir();             // ComfyUI: media/ 子目录
    ensureAssetsDir();            // 资产存储目录（用户可在设置改）
    ensureLorasTable();           // Lora 库表（Phase 1：纯数据层，UI 后续 phase）
    // lorasStore 需要 store + getAssetsDir + getComfyConfig 三件套；这些在 initStore 内可用
    lorasStore = new LorasStore({ store, getAssetsDir, getComfyConfig, getCoversDir });
    // AI 小说：6 张表 + skill registry + 上下文 Map（独立模块，不依赖 comfyui / taskQueue / workbench）
    novelEngine.bootstrap({ store, notify: notifyRenderer });
    // ComfyUI: 加载 workflows + tool schemas（JSON 损坏只 warn，不崩）
    // ComfyUI: 加载 workflows + tool schemas（JSON 损坏只 warn，不崩）
    try { comfyuiWorkflows.loadAll(); }
    catch (e) { console.warn('[comfyui] 加载 workflows 失败:', e.message); }
    try { comfyuiToolStore.loadAll(); }
    catch (e) { console.warn('[comfyui] 加载 tool store 失败:', e.message); }
}

/**
 * 首次启动迁移：把 prompts/*.json 灌进 SQLite，json 文件改名为 .bak
 * 幂等：db 非空就跳过
 */
function migrateLegacyJsonIfNeeded() {
    if (Object.keys(store.all()).length > 0) return;

    let files = [];
    try {
        files = fs.readdirSync(promptsDir).filter((f) => f.endsWith('.json'));
    } catch {
        return;
    }
    if (files.length === 0) return;

    let imported = 0;
    for (const f of files) {
        const full = path.join(promptsDir, f);
        try {
            const text = fs.readFileSync(full, 'utf-8');
            const data = JSON.parse(text);
            if (!data || !data.id) continue;
            store.set(data.id, {
                id: data.id,
                prompt: data.prompt || '',
                tags: Array.isArray(data.tags) ? data.tags : [],
                ts: data.ts || 0,
                schemaVersion: data.schemaVersion || 1,
            });
            try { fs.renameSync(full, full + '.bak'); } catch {}
            imported++;
        } catch (e) {
            console.warn(`[prompts] 跳过损坏的 ${f}: ${e.message}`);
        }
    }
    if (imported > 0) {
        console.log(`[prompts] 从 JSON 迁移 ${imported} 条到 SQLite`);
    }
}

// ========= 配置默认值（首次启动 seed） =========
// D-26: 拆 baseUrl+rootDir → 统一 path 字段
//   - type=nas:    path = 'http://host:port/subdir/'，主进程自动拆 baseUrl + rootDir
//   - type=local:  path = 'D:\Download\xxx'，主进程直接 fs 扫描
//   - type=network: 不用 path，url 列表在 urls 字段
const DEFAULT_TABS = [
    {
        id: '__assets__',
        name: '资产',
        // 路径在加载时动态从 __assets_config__ 解析（见 script.js _loadGalleryForTab）
        // 标记 locked=true 让 settings.js buildTabRow 锁住「路径」和「删除」按钮
        locked: true,
        source: {
            type: 'local',
            path: '',  // 运行时由 api.config.assetsGet().resolvedDir 填入
            imgExts: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            videoExts: ['mp4', 'webm', 'webm'],
            maxDepth: 5,
        },
    },
    {
        id: 'ai-image',
        name: 'AI出图',
        source: {
            type: 'nas',
            path: 'http://192.168.0.109:5005/home/小芋/私人电脑/003 AI绘画/003 AI出图/',
            imgExts: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            videoExts: ['mp4', 'webm'],
            maxDepth: 10,
        },
    },
    {
        id: 'ai-video',
        name: 'AI视频',
        source: {
            type: 'nas',
            path: 'http://192.168.0.109:5005/home/小芋/短视频中心/',
            imgExts: [],
            videoExts: ['mp4', 'webm', 'avi'],
            maxDepth: 10,
        },
    },
    {
        id: 'nsfw-gallery',
        name: 'NSFW图库',
        source: {
            type: 'nas',
            path: 'http://192.168.0.109:5005/photos/',
            imgExts: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            videoExts: ['mp4', 'webm'],
            maxDepth: 10,
        },
    },
    {
        id: 'more-gallery',
        name: '更多图库',
        source: {
            type: 'nas',
            path: 'http://192.168.0.109:5005/home/小芋/更多图库/',
            imgExts: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            videoExts: ['mp4', 'webm'],
            maxDepth: 10,
        },
    },
];

const CONFIG_KEY = '__config__';  // 跟 prompt 记录的 key 命名空间隔离（prompt key 通常是 stableId 不会冲突）
const DEFAULT_CONFIG = {
    version: 1,
    tabs: DEFAULT_TABS,
    // 默认选排序第一的 tab（保证首次启动也能命中）
    activeTabId: (DEFAULT_TABS[0] && DEFAULT_TABS[0].id) || '',
};

/**
 * 迁移老 schema：把 { baseUrl, rootDir } 合并成 { path }
 * 也兼容老 D-25 的 4-tab 形态
 */
function migrateLegacySourceSchema(cfg) {
    if (!cfg || !Array.isArray(cfg.tabs)) return cfg;
    let changed = false;
    for (const t of cfg.tabs) {
        const s = t.source;
        if (!s) continue;
        // D-25 老格式：nas + {baseUrl, rootDir} 拆开
        if (s.type === 'nas' && (s.baseUrl || s.rootDir)) {
            if (!s.path) {
                s.path = String(s.baseUrl || '').replace(/\/+$/, '') + (s.rootDir || '/');
                changed = true;
            }
            delete s.baseUrl;
            delete s.rootDir;
        }
    }
    if (changed) console.log('[config] 老 schema 已迁到 {path}');
    return cfg;
}

function seedDefaultConfigIfNeeded() {
    if (configStore.get(CONFIG_KEY)) return;
    configStore.set(CONFIG_KEY, DEFAULT_CONFIG);
    console.log('[config] 已写入默认 tabs（4 个）');
}

/**
 * 启动时统一过一遍：迁移老 schema + 注入必备 tab
 */
function ensureConfigSchema() {
    const cfg = configStore.get(CONFIG_KEY);
    if (!cfg) return;
    let next = cfg;
    next = migrateLegacySourceSchema(next);
    next = ensureAssetsTab(next);
    if (next !== cfg) configStore.set(CONFIG_KEY, next);
}

/**
 * 确保 __assets__ tab 存在；缺失则插到位置 0（首位）。
 * activeTabId 仍指向原值，不强制切到 __assets__。
 */
function ensureAssetsTab(cfg) {
    if (!cfg || !Array.isArray(cfg.tabs)) return cfg;
    if (cfg.tabs.some(t => t && t.id === '__assets__')) return cfg;
    const assetsTab = (DEFAULT_TABS || []).find(t => t && t.id === '__assets__');
    if (!assetsTab) return cfg;
    const next = { ...cfg, tabs: [assetsTab, ...cfg.tabs] };
    console.log('[config] 已注入 __assets__ tab 到位置 0');
    return next;
}

// ========== D-27: LLM 配置 + 模块 + 标签 seed ==========
const LLM_CONFIG_KEY = '__llm_config__';
const PROMPT_HISTORY_KEY = '__prompt_history__';
const PROMPT_HISTORY_MAX = 30;  // 最多保留 30 条历史
const ASSEMBLE_RULE_KEY = '__prompt_assemble_rule__';  // D-35: 拼装规则（仅存到 configStore，不动 llmConfig）

function seedPromptGenDataIfNeeded() {
    // 1) LLM 配置（含 SFW + NSFW 两套 system prompt）
    if (!configStore.get(LLM_CONFIG_KEY)) {
        const { NSFW_SYSTEM_PROMPT } = require('./nsfw-system');
        const seedCfg = {
            ...DEFAULT_LLM_CONFIG,
            mode: 'sfw',
            systemPrompts: {
                sfw: DEFAULT_LLM_CONFIG.systemPrompt || '',
                nsfw: NSFW_SYSTEM_PROMPT,
            },
        };
        configStore.set(LLM_CONFIG_KEY, seedCfg);
        console.log('[prompt-gen] 已写入默认 LLM 配置（含 SFW + NSFW 两套 system）');
    }
    // 1.5) NSFW 来源 meta（用于 UI 显示"基于 xxx 仓库"）
    if (!configStore.get('__nsfw_source__')) {
        configStore.set('__nsfw_source__', { ...NSFW_SOURCE_META });
        console.log('[prompt-gen] 已写入 NSFW 来源 meta');
    }
    // 2) 12 个模块
    let seededModules = 0;
    for (const m of DEFAULT_PROMPT_MODULES) {
        const key = `__module:${m.id}`;
        if (!configStore.get(key)) {
            configStore.set(key, m);
            seededModules++;
        }
    }
    if (seededModules > 0) console.log(`[prompt-gen] 已写入 ${seededModules} 个模块`);
    // 3) 70 个标签
    let seededTags = 0;
    for (const t of DEFAULT_PROMPT_TAGS) {
        const key = `__tag:${t.id}`;
        if (!configStore.get(key)) {
            configStore.set(key, t);
            seededTags++;
        }
    }
    if (seededTags > 0) console.log(`[prompt-gen] 已写入 ${seededTags} 个标签`);
    // 4) 生成历史（空数组）
    if (!configStore.get(PROMPT_HISTORY_KEY)) {
        configStore.set(PROMPT_HISTORY_KEY, []);
    }
}

// ========= prompts IPC（接口不变） =========
ipcMain.handle('prompts:readAll', async () => {
    try {
        const all = store.all();
        // 剔除所有 config 命名空间：__config__ / __llm_config__ / __comfyui_config__
        // / __prompt_history__ / __nsfw_source__ / __module:* / __tag:*
        // 提示词记录 key 通常是 gen-* / tmp-* / new-* 之类的 stableId
        const records = Object.entries(all)
            .filter(([k]) => !k.startsWith('__'))
            .map(([_, v]) => ({
                id: v.id,
                prompt: v.prompt || '',
                tags: v.tags || [],
                ts: v.ts || 0,
                // ComfyUI: 媒体字段（向后兼容）
                mediaPath: v.mediaPath || '',
                mediaMime: v.mediaMime || '',
                mediaSize: v.mediaSize || 0,
            }));
        return { ok: true, records };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompts:writeOne', async (_e, { id, prompt, tags, mediaPath, mediaMime, mediaSize }) => {
    try {
        if (!id) return { ok: false, error: 'id 必填' };
        const rec = {
            id: String(id),
            prompt: prompt || '',
            tags: Array.isArray(tags) ? tags : [],
            ts: Date.now(),
            schemaVersion: 1,
        };
        // ComfyUI: 可选媒体字段（旧记录无此字段，undefined 时不存，避免污染）
        if (mediaPath) {
            if (typeof mediaPath !== 'string' || mediaPath.includes('..')) {
                return { ok: false, error: 'mediaPath 非法' };
            }
            rec.mediaPath = mediaPath;
            rec.mediaMime = typeof mediaMime === 'string' ? mediaMime : '';
            rec.mediaSize = Number(mediaSize) || 0;
        }
        store.set(rec.id, rec);
        return { ok: true, filePath: getDbPath() };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompts:deleteOne', async (_e, id) => {
    try {
        store.set(String(id), null);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompts:info', async () => {
    return { dir: promptsDir, dbPath: getDbPath(), packaged: app.isPackaged };
});

// ========= config IPC（D-25 新增） =========
// 整个 config 是一个 JSON 对象，存在 CONFIG_KEY 下
ipcMain.handle('config:get', async () => {
    try {
        const cfg = configStore.get(CONFIG_KEY);
        if (!cfg) return { ok: false, error: 'config 缺失（应已自动 seed）' };
        return { ok: true, config: cfg };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 整体覆盖（schema 简单，传整个对象）
ipcMain.handle('config:set', async (_e, cfg) => {
    try {
        if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config 必须是对象' };
        if (!Array.isArray(cfg.tabs)) return { ok: false, error: 'tabs 必须是数组' };
        // 兜底：id 不能重复
        const ids = new Set();
        for (const t of cfg.tabs) {
            if (!t || !t.id || !t.name || !t.source) return { ok: false, error: 'tab 缺字段（id/name/source）' };
            if (ids.has(t.id)) return { ok: false, error: `tab id 重复: ${t.id}` };
            ids.add(t.id);
            const s = t.source;
            if (!['nas', 'local', 'network'].includes(s.type)) return { ok: false, error: `tab ${t.id}: 未知 source.type: ${s.type}` };
            // 锁定 tab（资产）的 path 由 __assets_config__ 动态解析，源里允许为空
            if (t.locked) continue;
            if (s.type === 'network') {
                if (!s.urls || !String(s.urls).trim()) return { ok: false, error: `tab ${t.id}: network 类型需 urls` };
            } else {
                if (!s.path || !String(s.path).trim()) return { ok: false, error: `tab ${t.id}: ${s.type} 类型需 path` };
                if (s.type === 'local') {
                    if (!fs.existsSync(s.path)) return { ok: false, error: `tab ${t.id}: 本地目录不存在: ${s.path}` };
                }
                if (s.type === 'nas') {
                    // path 必须是 http(s):// 开头
                    if (!/^https?:\/\//i.test(s.path)) return { ok: false, error: `tab ${t.id}: NAS path 需以 http:// 或 https:// 开头` };
                }
            }
        }
        configStore.set(CONFIG_KEY, cfg);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========= resource loader（D-25 新增） =========
// 根据 source.type 加载媒体列表（给 web 端瀑布流用）
// 返回 { ok, media: [{type, src, id, fileName}] }
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv']);

function getMediaTypeByExt(ext) {
    ext = String(ext).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return 'unknown';
}

// 通用：扫描本地目录（递归，BFS）
// 结果按文件创建时间倒序（最新在前）；同时间走稳定排序，保留原 BFS 顺序作为 tiebreaker。
async function scanLocalDir(rootDir, maxDepth, imgExts, videoExts, signal) {
    const collected = [];
    const imgSet = new Set(imgExts || []);
    const vidSet = new Set(videoExts || []);
    let frontier = [{ dir: rootDir, depth: 1 }];
    const seenDir = new Set([path.resolve(rootDir).toLowerCase()]);

    while (frontier.length > 0) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const nextFrontier = [];

        for (const { dir, depth } of frontier) {
            if (depth > maxDepth) continue;
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch (e) {
                console.warn(`[scanLocal] skip ${dir}: ${e.message}`);
                continue;
            }
            // 文件的 stat 并行抓，目录不需要 stat。失败的 stat 视为 createdAt=0（排到末尾）。
            const fileStats = await Promise.all(
                entries.map(e => e.isFile() ? fsp.stat(path.join(dir, e.name)).catch(() => null) : null)
            );
            for (let i = 0; i < entries.length; i++) {
                if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                const entry = entries[i];
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // 跳过 loras 封面目录（封面图在 loras 自己的存储里，详见 loras-store.js）。
                    // 即便 sweep 失败（旧文件被锁、未能搬走），也不会污染资产界面。
                    const rel = path.relative(rootDir, full);
                    const skipCovers = rel.toLowerCase() === path.join('loras', 'covers')
                        || rel.toLowerCase().startsWith(path.join('loras', 'covers') + path.sep);
                    if (skipCovers) continue;
                    const key = path.resolve(full).toLowerCase();
                    if (!seenDir.has(key)) {
                        seenDir.add(key);
                        nextFrontier.push({ dir: full, depth: depth + 1 });
                    }
                } else if (entry.isFile()) {
                    const ext = entry.name.split('.').pop()?.toLowerCase() || '';
                    const type = getMediaTypeByExt(ext);
                    if (type === 'unknown') continue;
                    if (type === 'image' && imgSet.size > 0 && !imgSet.has(ext)) continue;
                    if (type === 'video' && vidSet.size > 0 && !vidSet.has(ext)) continue;
                    // NTFS 才有 birthtime；ext4/FAT32 等可能为 0，回退到 mtime。
                    const st = fileStats[i];
                    const createdAt = st ? (st.birthtimeMs || st.mtimeMs || 0) : 0;
                    // file:// 协议（Electron 主进程读本地文件给 web 用）
                    collected.push({
                        type,
                        src: 'file:///' + full.replace(/\\/g, '/'),
                        id: `local-${stableHash(full)}`,
                        fileName: entry.name,
                        createdAt,
                    });
                }
            }
        }
        frontier = nextFrontier;
    }
    // 按创建时间倒序：最新生成 / 导入的图排在最前
    collected.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return collected;
}

// FNV-1a 32-bit 哈希
function stableHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

ipcMain.handle('config:resource:load', async (_e, { source }) => {
    try {
        if (!source || !source.type) return { ok: false, error: 'source 缺字段' };

        if (source.type === 'local') {
            // 本地目录（D-26: 统一用 path 字段）
            if (!source.path) return { ok: false, error: 'local 类型需 path' };
            if (!fs.existsSync(source.path)) return { ok: false, error: `目录不存在: ${source.path}` };
            const media = await scanLocalDir(
                source.path,
                source.maxDepth || 10,
                source.imgExts || [],
                source.videoExts || [],
            );
            return { ok: true, media, count: media.length };

        } else if (source.type === 'network') {
            // 网络 URL 列表（每行一个，或 urls 数组）
            const urls = Array.isArray(source.urls)
                ? source.urls
                : String(source.urls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const media = [];
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const ext = url.split('.').pop()?.toLowerCase() || '';
                const type = getMediaTypeByExt(ext);
                if (type === 'unknown') continue;
                media.push({
                    type,
                    src: url,
                    id: `net-${stableHash(url)}`,
                    fileName: url.split('/').pop() || `url-${i}`,
                });
            }
            return { ok: true, media, count: media.length };

        } else if (source.type === 'nas') {
            // D-26: 从 path 自动拆 baseUrl + rootDir
            if (!source.path) return { ok: false, error: 'nas 类型需 path' };
            const m = String(source.path).match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
            if (!m) return { ok: false, error: 'nas path 格式错误：需 http://host:port/rootDir' };
            const baseUrl = m[1];
            const rootDir = m[2] || '/';
            return {
                ok: true,
                media: [],
                count: 0,
                mode: 'nas-web-fallback',  // 提示 web 端走旧 BFS
                nasConfig: {
                    nasBaseUrl: baseUrl,
                    rootDir: rootDir,
                    imgExts: source.imgExts || [],
                    videoExts: source.videoExts || [],
                    maxDepth: source.maxDepth || 10,
                },
            };
        }

        return { ok: false, error: `未知 source.type: ${source.type}` };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 让 web 端能选择本地目录（弹原生文件夹选择器）
ipcMain.handle('config:pickDir', async () => {
    try {
        const result = await require('electron').dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '选择媒体根目录',
        });
        if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true };
        return { ok: true, path: result.filePaths[0] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

app.whenReady().then(async () => {
    // 先确保进程已 admin（一次性 UAC）；未提权则 ensureElevated 内已自重启 + exit
    if (!await ensureElevated()) return;
    initStore();
    // 启动时扫一次 addLora 残留的 staging 文件（被中断留下的 .tmp-*）
    // mtime > 1h 才清，避免误删正在跑的 addLora
    try {
        const sweep = _ensureLorasStore().sweepStagingFiles();
        if (sweep.swept > 0) console.log(`[startup] swept ${sweep.swept} stale .tmp-* lora staging file(s)`);
        if (sweep.errors.length) console.warn('[startup] sweep errors:', sweep.errors);
    } catch (e) {
        console.warn('[startup] staging sweep failed:', e.message);
    }
    createWindow();
    // 启动时自动拉起 ComfyUI（按 cfg.autoStartOnLaunch；默认 true）
    // 不 await，避免阻塞窗口打开；后台跑，进度通过 comfyui:event 推 renderer
    autoStartComfyUI();
    // 加载任务队列里的 pending / 收尾 running；DB 已就绪（ensureTaskQueueTable 在 initStore 调过）
    bootstrapTaskQueue();
});

// 启动时自动拉起 ComfyUI（后台，不阻塞 app ready）
function autoStartComfyUI() {
    try {
        const cfg = getComfyConfig();
        // 仅在显式 false 时才认为关闭；缺省/undefined 视为开启（与 comfyui:config:set 的默认值一致）
        if (cfg.autoStartOnLaunch === false) {
            console.log('[startup] ComfyUI 自动启动已关闭（cfg.autoStartOnLaunch=false）');
            return;
        }
        if (!cfg.pythonPath || !cfg.comfyDir) {
            console.warn('[startup] ComfyUI 未配置 pythonPath / comfyDir，跳过自动启动');
            return;
        }
        console.log(`[startup] 自动启动 ComfyUI（port=${cfg.port}, timeout=${Math.round((cfg.startupTimeoutMs || 120000) / 1000)}s）…`);
        // 不 await；fire-and-forget，错误和进度都通过 comfyuiProcess 内部事件 / 状态字段反馈
        comfyuiProcess.startService(cfg).then((r) => {
            if (r && r.ok) {
                console.log(`[startup] ComfyUI 已就绪（port=${r.port}${r.external ? '，复用外部进程' : ''}）`);
            } else {
                console.warn(`[startup] ComfyUI 自动启动失败：${r && r.error || '未知错误'}`);
            }
        }).catch((e) => {
            console.error('[startup] ComfyUI 自动启动异常:', e && e.message);
        });
    } catch (e) {
        console.error('[startup] autoStartComfyUI 异常:', e && e.message);
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});


// ========== D-27: LLM IPC（Ollama 本地） ==========
ipcMain.handle('llm:listModels', async () => {
    try {
        const cfg = configStore.get(LLM_CONFIG_KEY) || DEFAULT_LLM_CONFIG;
        return await listModels(cfg.baseUrl);
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('llm:config:get', async () => {
    try {
        const cfg = configStore.get(LLM_CONFIG_KEY) || DEFAULT_LLM_CONFIG;
        return { ok: true, config: cfg };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('llm:config:set', async (_e, newCfg) => {
    try {
        const cur = configStore.get(LLM_CONFIG_KEY) || DEFAULT_LLM_CONFIG;
        const merged = {
            baseUrl: (newCfg && newCfg.baseUrl) || cur.baseUrl,
            model: (newCfg && newCfg.model !== undefined) ? newCfg.model : cur.model,
            temperature: (newCfg && typeof newCfg.temperature === 'number') ? newCfg.temperature : cur.temperature,
            mode: (newCfg && (newCfg.mode === 'sfw' || newCfg.mode === 'nsfw')) ? newCfg.mode : (cur.mode || 'sfw'),
            systemPrompts: cur.systemPrompts || cur.systemPrompt || {},
        };
        // 兼容老 schema（systemPrompt 字符串 → systemPrompts.sfw）
        if (typeof merged.systemPrompts === 'string') {
            merged.systemPrompts = { sfw: merged.systemPrompts, nsfw: '' };
        }
        configStore.set(LLM_CONFIG_KEY, merged);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('llm:generate', async (_e, { tags, modules, jobId }) => {
    try {
        const cfg = configStore.get(LLM_CONFIG_KEY) || DEFAULT_LLM_CONFIG;
        if (!cfg.model) return { ok: false, error: '未选择 LLM 模型，请先在「提示词生成」页选模型' };
        // D-29: 按 mode 选 system prompt（sfw / nsfw）
        const mode = cfg.mode || 'sfw';
        const sysPrompt = (cfg.systemPrompts && cfg.systemPrompts[mode]) || cfg.systemPrompt || '';
        // 构造用户 prompt：模块 + 标签
        const lines = [];
        for (const m of (modules || [])) {
            const ts = (tags || []).filter(t => t.module === m.id);
            if (ts.length > 0) {
                lines.push(`【${m.name}】${ts.map(t => t.name).join('、')}`);
            }
        }
        const userPrompt = lines.length > 0
            ? `请基于以下标签组合，撰写一段详细的 AI 绘图提示词：\n\n${lines.join('\n')}`
            : '请自由创作一段详细的 AI 绘图提示词。';
        const r = await llmGenerate({
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            system: sysPrompt,
            prompt: userPrompt,
            jobId: jobId || `gen-${Date.now()}`,
            temperature: cfg.temperature,
        });
        // 生成成功 → 追加到历史
        if (r.ok) {
            const history = configStore.get(PROMPT_HISTORY_KEY) || [];
            history.unshift({
                id: `hist-${Date.now()}`,
                ts: Date.now(),
                tags: (tags || []).map(t => ({ id: t.id, name: t.name, module: t.module })),
                modules: (modules || []).map(m => ({ id: m.id, name: m.name })),
                text: r.text,
                model: cfg.model,
            });
            // 截断到 N 条
            configStore.set(PROMPT_HISTORY_KEY, history.slice(0, PROMPT_HISTORY_MAX));
        }
        return r;
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-29: NSFW 仓库 README 缓存（仅 README，不拉子文件）==========
ipcMain.handle('nsfw:fetchReadme', async () => {
    try {
        // 优先从 cache 读（24h 内不重复拉）
        const meta = configStore.get('__nsfw_source__') || NSFW_SOURCE_META;
        if (meta.readmeCachedAt && (Date.now() - meta.readmeCachedAt) < 24 * 3600 * 1000) {
            const cached = configStore.get('__nsfw_readme__');
            if (cached) return { ok: true, cached: true, readme: cached, meta };
        }
        const url = 'https://raw.githubusercontent.com/ShuaiHui/nsfw-prompt-templates-asian/main/README.md';
        const r = await fetch(url);
        if (!r.ok) return { ok: false, error: `拉取失败: HTTP ${r.status}` };
        const text = await r.text();
        const updatedMeta = {
            ...(configStore.get('__nsfw_source__') || NSFW_SOURCE_META),
            readmeCachedAt: Date.now(),
            readmeCachedSize: text.length,
        };
        configStore.set('__nsfw_readme__', text);
        configStore.set('__nsfw_source__', updatedMeta);
        return { ok: true, cached: false, readme: text, meta: updatedMeta };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('nsfw:source:get', async () => {
    try {
        const meta = configStore.get('__nsfw_source__') || NSFW_SOURCE_META;
        const readme = configStore.get('__nsfw_readme__') || '';
        return { ok: true, meta, readmeCached: readme.length > 0 };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('llm:cancel', async (_e, jobId) => {
    if (!jobId) return { ok: false, error: 'jobId 必填' };
    const cancelled = cancelJob(jobId);
    return { ok: true, cancelled };
});

// ========== D-27: 模块 / 标签 CRUD ==========
ipcMain.handle('prompt:modules:get', async () => {
    try {
        const all = configStore.all();
        const mods = [];
        for (const [k, v] of Object.entries(all)) {
            if (k.startsWith('__module:') && v && v.id) mods.push(v);
        }
        mods.sort((a, b) => (a.order || 0) - (b.order || 0));
        return { ok: true, modules: mods };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:module:upsert', async (_e, m) => {
    try {
        if (!m || !m.id || !m.name) return { ok: false, error: 'id/name 必填' };
        configStore.set(`__module:${m.id}`, { id: m.id, name: m.name, order: m.order || 99, desc: m.desc || '' });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:module:delete', async (_e, id) => {
    try {
        configStore.set(`__module:${id}`, null);
        // 删这个模块下的所有标签
        const all = configStore.all();
        for (const [k, v] of Object.entries(all)) {
            if (k.startsWith('__tag:') && v && v.module === id) configStore.set(k, null);
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:tags:get', async (_e, moduleId) => {
    try {
        const all = configStore.all();
        const tags = [];
        for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith('__tag:') || !v || !v.id) continue;
            if (moduleId && v.module !== moduleId) continue;
            tags.push(v);
        }
        tags.sort((a, b) => (a.order || 0) - (b.order || 0));
        return { ok: true, tags };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:tag:upsert', async (_e, t) => {
    try {
        if (!t || !t.id || !t.module || !t.name) return { ok: false, error: 'id/module/name 必填' };
        configStore.set(`__tag:${t.id}`, { id: t.id, module: t.module, name: t.name, order: t.order || 99, desc: t.desc || '' });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:tag:delete', async (_e, id) => {
    try {
        configStore.set(`__tag:${id}`, null);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-31: 提示词分类 CRUD（prompt_menu 表） ==========
// 表结构在 shared/db.js 初始化时已 CREATE（如果需要，可在此处补 ensureTable 兜底）
// schema: id, category_name, parent_id, description, pid_list, sort_order, created_at, updated_at

function ensurePromptMenuTable() {
    // 幂等 CREATE，防御性兜底（万一 db 是老的、没有这张表）
    // 注意：KVDb.exec 只接受单条语句，必须分多次 exec
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_menu (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            category_name        TEXT    NOT NULL,
            parent_id            INTEGER DEFAULT 0,
            description          TEXT    DEFAULT '',
            pid_list             TEXT    DEFAULT '',
            sort_order           INTEGER DEFAULT 0,
            tag_required         TEXT    DEFAULT '',  -- MD 导入：数量限制提示（例 '必选 1-2 个' / '选 2-3 个'）
            tag_exclusive_group  TEXT    DEFAULT '',  -- MD 导入：互斥分组（同组内 exclusive 关联，例 '裸露等级'）-- D-42 弃用，保留列不写
            exclusive_with       TEXT    DEFAULT '',  -- D-42: 直接互斥分类（逗号分隔菜单id，例 '12,15'）
            exclusive_group      TEXT    DEFAULT '',  -- D-44: 互斥组名（同组名 = 全员互斥，例 '体型'）
            created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_parent        ON prompt_menu(parent_id)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_pidlist       ON prompt_menu(pid_list)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_excl_group    ON prompt_menu(tag_exclusive_group)`);

    // 兼容老库：补 tag_required / tag_exclusive_group / exclusive_with / exclusive_group 列
    //   注意：必须先 ALTER 加列，再建索引（不然老库里列不存在，CREATE INDEX 会报 no such column）
    const cols = store.query("PRAGMA table_info(prompt_menu)");
    if (cols.length) {
        if (!cols.some(c => c.name === 'tag_required')) {
            store.exec("ALTER TABLE prompt_menu ADD COLUMN tag_required TEXT DEFAULT ''");
        }
        if (!cols.some(c => c.name === 'tag_exclusive_group')) {
            store.exec("ALTER TABLE prompt_menu ADD COLUMN tag_exclusive_group TEXT DEFAULT ''");
        }
        if (!cols.some(c => c.name === 'exclusive_with')) {
            store.exec("ALTER TABLE prompt_menu ADD COLUMN exclusive_with TEXT DEFAULT ''");
        }
        if (!cols.some(c => c.name === 'exclusive_group')) {
            store.exec("ALTER TABLE prompt_menu ADD COLUMN exclusive_group TEXT DEFAULT ''");
        }
    }
    // 列补齐后再建 exclusive_with / exclusive_group 索引
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_excl_with     ON prompt_menu(exclusive_with)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_menu_excl_group_v2 ON prompt_menu(exclusive_group) WHERE exclusive_group != ''`);
}
// 原 try 块已删：在脚本加载期 store 还是 null，会抛 "Cannot read properties of null"
// 改在 initStore() 里统一调

/**
 * 根据 parent_id 计算新分类的 pid_list
 * 规则：取父节点的 pid_list 拼上新 id；若父节点是根（parent_id=0），则 '/<id>/'
 */
function buildPidList(parentId, newId) {
    let prefix;
    if (!parentId || parentId === 0) {
        prefix = '/';
    } else {
        const row = store.query('SELECT pid_list FROM prompt_menu WHERE id = ?', parentId);
        if (!row.length) return '/';
        prefix = row[0].pid_list || '/';
        if (!prefix.endsWith('/')) prefix += '/';
    }
    return prefix + newId + '/';
}

ipcMain.handle('prompt:menu:list', async () => {
    try {
        const rows = store.query(
            'SELECT id, category_name, parent_id, description, pid_list, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group FROM prompt_menu ORDER BY parent_id ASC, sort_order ASC, id ASC'
        );
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:menu:add', async (_e, payload) => {
    try {
        if (!payload || !payload.category_name) return { ok: false, error: 'category_name 必填' };
        const parentId = Number(payload.parent_id) || 0;
        const sortOrder = Number(payload.sort_order) || 0;
        const desc = payload.description || '';
        const isRequired = payload.is_required ? 1 : 0;
        // D-40: 数量规则 + 互斥组（可空，留空 = 不限制）
        const tagRequired = (payload.tag_required || '').toString().trim();
        const tagExclGroup = (payload.tag_exclusive_group || '').toString().trim();
        // D-42: 直接配对的互斥分类（逗号分隔菜单id 串）
        const exclusiveWith = (payload.exclusive_with !== undefined) ? String(payload.exclusive_with).trim() : '';
        // D-44: 互斥组名（同组名=全员互斥）
        const exclusiveGroup = (payload.exclusive_group !== undefined) ? String(payload.exclusive_group).trim() : '';
        // 先插行（pid_list 暂空），拿到 id 再回填 pid_list
        const r = store.exec(
            'INSERT INTO prompt_menu (category_name, parent_id, description, pid_list, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            payload.category_name, parentId, desc, '', sortOrder, isRequired, tagRequired, tagExclGroup, exclusiveWith, exclusiveGroup
        );
        const newId = r.lastInsertRowid;
        const pidList = buildPidList(parentId, newId);
        store.exec('UPDATE prompt_menu SET pid_list = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?', pidList, newId);
        return { ok: true, id: newId, pid_list: pidList };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:menu:update', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = Number(payload.id);
        const cur = store.query('SELECT * FROM prompt_menu WHERE id = ?', id);
        if (!cur.length) return { ok: false, error: `分类 id=${id} 不存在` };
        const old = cur[0];

        const categoryName = payload.category_name ?? old.category_name;
        const description = payload.description ?? old.description;
        const sensitivity = payload.sensitivity ?? old.sensitivity ?? 'nsfw';
        const sortOrder = (payload.sort_order !== undefined) ? Number(payload.sort_order) : old.sort_order;
        const parentId = (payload.parent_id !== undefined) ? Number(payload.parent_id) : old.parent_id;
        const isRequired = (payload.is_required !== undefined) ? (payload.is_required ? 1 : 0) : (old.is_required || 0);
        // D-40: tag_required / tag_exclusive_group 显式覆盖（区分"未传"和"传了空串"）
        const tagRequired = (payload.tag_required !== undefined) ? String(payload.tag_required).trim() : (old.tag_required || '');
        const tagExclGroup = (payload.tag_exclusive_group !== undefined) ? String(payload.tag_exclusive_group).trim() : (old.tag_exclusive_group || '');
        // D-42: exclusive_with 显式覆盖
        const exclusiveWith = (payload.exclusive_with !== undefined) ? String(payload.exclusive_with).trim() : (old.exclusive_with || '');
        // D-44: exclusive_group 显式覆盖
        const exclusiveGroup = (payload.exclusive_group !== undefined) ? String(payload.exclusive_group).trim() : (old.exclusive_group || '');

        // 防呆：不能把自己设为自己的后代
        if (parentId !== old.parent_id) {
            const newParentPid = buildPidList(parentId, 0).replace(/0\/$/, ''); // 父节点前缀
            if (parentId !== 0 && newParentPid && (old.pid_list || '').startsWith(newParentPid + '/')) {
                return { ok: false, error: '不能把分类移到自己的子分类下' };
            }
        }

        const newPidList = buildPidList(parentId, id);
        store.exec(
            'UPDATE prompt_menu SET category_name=?, parent_id=?, description=?, pid_list=?, sort_order=?, is_required=?, tag_required=?, tag_exclusive_group=?, exclusive_with=?, exclusive_group=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?',
            categoryName, parentId, description, newPidList, sortOrder, isRequired, tagRequired, tagExclGroup, exclusiveWith, exclusiveGroup, id
        );

        // 如果 parent_id 变了，重建所有后代的 pid_list
        // 性能：D-33 之前这段还有一段「descendants.forEach(buildPidList) + store.exec UPDATE」循环，
        //       是死代码——下面 rebuildAllPidLists() 已全表重算。这段会浪费 N 次 SQL query + buildPidList。
        if (parentId !== old.parent_id) {
            rebuildAllPidLists();
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

/** 全表 pid_list 重算（按层级深度优先，parent_id 反推）
 * 性能：D-33 之前用 `all.find(x => x.id === id)` 是 O(n)，N×N 调用 → 10000 分类时 442ms
 *       改用 Map 后 O(1) 查询 → 同规模降到 2.5ms（约 177 倍）
 */
function rebuildAllPidLists() {
    const all = store.query('SELECT id, parent_id FROM prompt_menu');
    const byId = new Map(all.map(x => [x.id, x]));
    const cache = {};
    function calc(id, stack) {
        if (cache[id]) return cache[id];
        if (stack.has(id)) return '/'; // 防环
        stack.add(id);
        const node = byId.get(id);
        if (!node) return '/';
        const parent = node.parent_id || 0;
        const parentPath = parent === 0 ? '/' : calc(parent, stack);
        const pl = parentPath + id + '/';
        cache[id] = pl;
        return pl;
    }
    for (const r of all) {
        const pl = calc(r.id, new Set());
        store.exec('UPDATE prompt_menu SET pid_list = ? WHERE id = ?', pl, r.id);
    }
}

ipcMain.handle('prompt:menu:delete', async (_e, id) => {
    try {
        const nid = Number(id);
        if (!nid) return { ok: false, error: 'id 必填' };
        const cur = store.query('SELECT pid_list FROM prompt_menu WHERE id = ?', nid);
        if (!cur.length) return { ok: false, error: `分类 id=${nid} 不存在` };
        const pid = cur[0].pid_list || '/';
        // 级联删除范围：自己 + 所有 pid_list 以本节点开头的后代
        // 提示词挂在这些分类（包括自己 + 所有后代）下的也要一起删，避免变成孤儿
        const catRows = store.query('SELECT id FROM prompt_menu WHERE id = ? OR pid_list LIKE ?', nid, pid + '%');
        const catIds = catRows.map(r => r.id);
        // 事务包起来，保证原子性
        const r = store.transaction(() => {
            // 1) 先删提示词（WHERE category_id IN (catIds)）
            if (catIds.length) {
                const placeholders = catIds.map(() => '?').join(',');
                store.exec('DELETE FROM prompt_items WHERE category_id IN (' + placeholders + ')', ...catIds);
            }
            // 2) 再删分类
            return store.exec('DELETE FROM prompt_menu WHERE id = ? OR pid_list LIKE ?', nid, pid + '%');
        });
        return { ok: true, deleted: r.changes, catsDeleted: catIds.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:menu:get', async (_e, id) => {
    try {
        const rows = store.query('SELECT id, category_name, parent_id, description, pid_list, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group FROM prompt_menu WHERE id = ?', Number(id) || 0);
        return { ok: true, item: rows[0] || null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-31: 提示词条目 CRUD（prompt_items 表） ==========
function ensurePromptItemsTable() {
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            name        TEXT    NOT NULL,
            content     TEXT    DEFAULT '',
            sort_order  INTEGER DEFAULT 0,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_items_cat ON prompt_items(category_id)`);

    // D-NSFW-A: 补 aliases 列（JSON 数组，记录此条目在哪些分类下也出现过）
    const cols = store.query("PRAGMA table_info(prompt_items)");
    if (cols.length && !cols.some(c => c.name === 'aliases')) {
        store.exec("ALTER TABLE prompt_items ADD COLUMN aliases TEXT DEFAULT ''");
        store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_items_aliases ON prompt_items(aliases) WHERE aliases != ''`);
    }
}
// 原 try 块已删：在脚本加载期 store 还是 null，会抛 "Cannot read properties of null"
// 改在 initStore() 里统一调

// ========== 提示词库：单表 + tags CSV 列（与 NSFW 标签系统 prompt_menu/prompt_items 完全隔离） ==========
// v4 schema（当前）：
//   prompt_library (id, prompt_zh, prompt_en, tags TEXT DEFAULT '', created_at, updated_at)
//   - prompt_zh / prompt_en 两列分别存中英文提示词（可任一为空）
// v3 schema（已废弃，启动时检测并迁移；content → prompt_zh）：
//   prompt_library (id, title, content, tags, ...)
// v2 schema（已废弃，启动时检测并迁移）：
//   prompt_library_tags + prompt_library + prompt_library_tag_map
// v1 schema（已废弃，启动时检测并迁移）：
//   prompt_library_categories + prompt_library (with category_id)
// 启动时按 v4 → v3 → v2 → v1 顺序检测并迁移
function ensurePromptLibraryTables() {
    // ===== 1) 检测旧 schema =====
    const cols = store.query("PRAGMA table_info(prompt_library)");
    const isV1 = cols.length > 0 && cols.some(c => c.name === 'category_id');
    const hasV2TagTable = store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_library_tags'"
    ).length > 0;
    const hasV1CatOld = store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_library_categories'"
    ).length > 0;
    const hasV1CatRenamed = store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_pl_v1_cat_old'"
    ).length > 0;
    const hasV1ItemRenamed = store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_pl_v1_old'"
    ).length > 0;

    // ===== 2) v1 → 备份旧表（若还在原名）=====
    if (isV1) {
        store.exec('ALTER TABLE prompt_library RENAME TO _pl_v1_old');
    }
    if (hasV1CatOld) {
        store.exec('ALTER TABLE prompt_library_categories RENAME TO _pl_v1_cat_old');
    }

    // ===== 3) v2 → 把 tag_map 数据合并到 prompt_library.tags，删除两张表 =====
    if (hasV2TagTable) {
        const curCols = store.query("PRAGMA table_info(prompt_library)");
        if (curCols.length && !curCols.some(c => c.name === 'tags')) {
            store.exec("ALTER TABLE prompt_library ADD COLUMN tags TEXT DEFAULT ''");
        }
        const mapRows = store.query(`
            SELECT m.item_id, t.name
            FROM prompt_library_tag_map m
            JOIN prompt_library_tags t ON t.id = m.tag_id
        `);
        const itemTags = new Map();
        for (const r of mapRows) {
            if (!itemTags.has(r.item_id)) itemTags.set(r.item_id, []);
            const list = itemTags.get(r.item_id);
            if (!list.includes(r.name)) list.push(r.name);
        }
        for (const [itemId, tags] of itemTags.entries()) {
            store.exec('UPDATE prompt_library SET tags = ? WHERE id = ?', tags.join(','), itemId);
        }
        store.exec('DROP TABLE IF EXISTS prompt_library_tag_map');
        store.exec('DROP TABLE IF EXISTS prompt_library_tags');
        store.exec('DROP INDEX IF EXISTS idx_pl_tm_tag');
        store.exec('DROP INDEX IF EXISTS idx_pl_tm_item');
        store.exec('DROP INDEX IF EXISTS idx_pl_tags_name');
    }

    // ===== 4) 检测 v3（title+content 还在，没 prompt_zh）→ rename 备份 =====
    const colsAfter23 = store.query("PRAGMA table_info(prompt_library)");
    const isV3 = colsAfter23.length > 0 && !colsAfter23.some(c => c.name === 'prompt_zh');
    if (isV3) {
        store.exec('ALTER TABLE prompt_library RENAME TO _pl_v3_old');
    }

    // ===== 5) 创建 v4 表（首次安装 / v3 已 rename 后）=====
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_library (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_zh  TEXT    DEFAULT '',
            prompt_en  TEXT    DEFAULT '',
            tags       TEXT    DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_pl_tags ON prompt_library(tags)`);

    // ===== 6) v3 → v4 数据迁移：content → prompt_zh（用户原内容视为中文），title 丢弃 =====
    const hasV3Old = store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_pl_v3_old'"
    ).length > 0;
    if (hasV3Old) {
        store.exec(`
            INSERT INTO prompt_library (id, prompt_zh, prompt_en, tags, created_at, updated_at)
            SELECT id, COALESCE(content, ''), '', COALESCE(tags, ''), created_at, updated_at
              FROM _pl_v3_old
             WHERE id NOT IN (SELECT id FROM prompt_library)
        `);
        store.exec('DROP TABLE IF EXISTS _pl_v3_old');
    }

    // ===== 7) v1 旧数据迁移（rename 后变 _pl_v1_old / _pl_v1_cat_old）=====
    const hasV1Old = hasV1ItemRenamed || store.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_pl_v1_old'"
    ).length > 0;
    if (hasV1Old) {
        const catMap = new Map();
        const hasCat = hasV1CatRenamed || store.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_pl_v1_cat_old'"
        ).length > 0;
        if (hasCat) {
            const catRows = store.query('SELECT id, name FROM _pl_v1_cat_old');
            for (const c of catRows) catMap.set(c.id, c.name);
        }
        const oldRows = store.query(
            `SELECT id, title, content, category_id, created_at, updated_at
               FROM _pl_v1_old
              ORDER BY id`
        );
        for (const r of oldRows) {
            const tagName = catMap.get(r.category_id) || '';
            // v1 老数据：content 视为中文（用户当时主要也是中文提示词）
            store.exec(
                'INSERT OR IGNORE INTO prompt_library (id, prompt_zh, prompt_en, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                r.id, r.content || '', '', tagName, r.created_at, r.updated_at
            );
        }
        store.exec('DROP TABLE IF EXISTS _pl_v1_old');
        store.exec('DROP TABLE IF EXISTS _pl_v1_cat_old');
        store.exec('DROP INDEX IF EXISTS idx_pl_cat_code');
        store.exec('DROP INDEX IF EXISTS idx_pl_item_cat');
    }
}

/** 内部：tag 名称数组 → 去重 + 去空 + 保持顺序，返回 CSV 字符串 */
function normalizeTagsCsv(tagNames) {
    const out = [];
    const seen = new Set();
    for (const raw of tagNames || []) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out.join(',');
}


function ensureNsfwAssociationTables() {
    // 注意：KVDb.exec 底层用 db.prepare()，一次只能跑一条 SQL
    // 所以 CREATE TABLE 和 CREATE INDEX 必须分多次 exec
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_associations (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt_a_id   INTEGER NOT NULL,
            prompt_b_id   INTEGER NOT NULL,
            relation      TEXT    NOT NULL CHECK(relation IN ('strong','weak','exclusive')),
            weight        INTEGER DEFAULT 50,
            source        TEXT    DEFAULT 'manual',
            reason        TEXT    DEFAULT '',
            created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(prompt_a_id, prompt_b_id, relation)
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_a   ON prompt_associations(prompt_a_id)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_b   ON prompt_associations(prompt_b_id)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_rel ON prompt_associations(relation)`);

    // D-NSFW-A: 补 scope 列（'item' 或 'category'；category 关联时 prompt_a_id/b_id 指向 prompt_menu.id）
    const assocCols = store.query("PRAGMA table_info(prompt_associations)");
    if (assocCols.length && !assocCols.some(c => c.name === 'scope')) {
        store.exec("ALTER TABLE prompt_associations ADD COLUMN scope TEXT DEFAULT 'item'");
        store.exec(`CREATE INDEX IF NOT EXISTS idx_assoc_scope ON prompt_associations(scope)`);
    }

    // D-NSFW-A: prompt_examples（完整范例表，不入 prompt_items 避免污染检索）
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_examples (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id         INTEGER DEFAULT NULL,   -- 可空（典型归到大类，如 类别 范例-C01）
            title               TEXT    NOT NULL,
            english_content     TEXT    NOT NULL,
            chinese_description TEXT    DEFAULT '',
            style               TEXT    DEFAULT '',
            keywords            TEXT    DEFAULT '[]',  -- JSON 数组
            source              TEXT    DEFAULT 'md-import-00',
            created_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_examples_cat ON prompt_examples(category_id)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_prompt_examples_source ON prompt_examples(source)`);

    // D-NSFW-A: prompt_import_history（导入批次）
    store.exec(`
        CREATE TABLE IF NOT EXISTS prompt_import_history (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            source               TEXT    NOT NULL,        -- 'nsfw-asian' / 'manual' / ...
            version              TEXT    DEFAULT '',      -- 模板库版本
            imported_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            categories_created   INTEGER DEFAULT 0,
            categories_skipped   INTEGER DEFAULT 0,
            items_created        INTEGER DEFAULT 0,
            items_updated        INTEGER DEFAULT 0,
            items_skipped        INTEGER DEFAULT 0,
            associations_created INTEGER DEFAULT 0,
            examples_imported    INTEGER DEFAULT 0,
            duration_ms          INTEGER DEFAULT 0,
            config_json          TEXT    DEFAULT '{}'
        )
    `);

    store.exec(`
        CREATE TABLE IF NOT EXISTS scene_templates (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            description TEXT    DEFAULT '',
            item_ids    TEXT    DEFAULT '[]',
            source      TEXT    DEFAULT 'manual',
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    `);

    // 兼容老库：补 sensitivity 列 + description 列
    const cols = store.query("PRAGMA table_info(prompt_items)");
    if (cols.length && !cols.some(c => c.name === 'sensitivity')) {
        store.exec("ALTER TABLE prompt_items ADD COLUMN sensitivity TEXT DEFAULT 'nsfw'");
    }
    if (cols.length && !cols.some(c => c.name === 'description')) {
        store.exec("ALTER TABLE prompt_items ADD COLUMN description TEXT DEFAULT ''");
    }
    // 提示词预览图：相对路径（previews/<id>.<ext>），空字符串表示无图
    if (cols.length && !cols.some(c => c.name === 'preview_image')) {
        store.exec("ALTER TABLE prompt_items ADD COLUMN preview_image TEXT DEFAULT ''");
    }
    // D-40: 场景模板加 enabled 列（兼容老库）
    const stCols = store.query("PRAGMA table_info(scene_templates)");
    if (stCols.length && !stCols.some(c => c.name === 'enabled')) {
        store.exec("ALTER TABLE scene_templates ADD COLUMN enabled INTEGER DEFAULT 1");
    }
    console.log('[D-NSFW-A] 关联规则 + 场景模板 + 范例 + 导入历史表已就绪');
}

// ========== D-QUEUE：任务队列表 ==========
// 透明接管 tools:run 提交（应用层无感），所有 pending/running/done/failed/cancelled 全持久化。
// 启动时清理：done ≥ 100 条后只保留最近 100；30 天前的 done/failed/cancelled 全部清。
function ensureTaskQueueTable() {
    store.exec(`
        CREATE TABLE IF NOT EXISTS task_queue (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            queue_id        TEXT    UNIQUE NOT NULL,                    -- UUID，前端引用
            tool_id         TEXT    NOT NULL,
            tool_label      TEXT    NOT NULL DEFAULT '',                -- 工具展示名（提交快照）
            form_values     TEXT    NOT NULL DEFAULT '{}',              -- JSON
            workflow_json   TEXT    NOT NULL DEFAULT '{}',              -- JSON：提交快照，避免 schema 变了还能重提
            prompt_id       TEXT,                                       -- ComfyUI promptId，提交成功才填
            comfy_job_id    TEXT,                                       -- ComfyUI 端 jobId（cui-xxx），取消用
            status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','done','failed','cancelled')),
            position        INTEGER NOT NULL DEFAULT 0,                  -- pending 重排用
            error_msg       TEXT,                                       -- 失败/取消原因
            result_path     TEXT,                                       -- 完成时填：图片/视频本地相对路径或绝对路径
            result_text     TEXT,                                       -- 文本结果
            result_mime     TEXT,
            result_size     INTEGER,
            enqueued_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            started_at      INTEGER,
            finished_at     INTEGER
        )
    `);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_tq_status_position ON task_queue(status, position)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_tq_enqueued_at ON task_queue(enqueued_at DESC)`);

    // 启动时清理过期 done：
    //   - 仅保留最近 100 条 done（按 finished_at DESC）
    //   - 30 天前的 done/failed/cancelled 全清
    try {
        const now = Math.floor(Date.now() / 1000);
        const cutoff = now - 86400 * 30;
        // 30 天前的 done/failed/cancelled 直接清
        store.exec(
            `DELETE FROM task_queue WHERE status IN ('done','failed','cancelled') AND COALESCE(finished_at, enqueued_at) < ?`,
            cutoff
        );
        // done 保留最近 100 条 → 找出第 101 条的 finished_at，删更早的
        const keepRows = store.query(
            `SELECT id FROM task_queue WHERE status='done' ORDER BY COALESCE(finished_at, enqueued_at) DESC LIMIT 100`
        );
        if (keepRows.length === 100) {
            // 用倒数第 1 条的 finished_at 当阈值（更早的全部清掉）
            const allDone = store.query(
                `SELECT id, COALESCE(finished_at, enqueued_at) AS ts
                   FROM task_queue WHERE status='done'
                   ORDER BY COALESCE(finished_at, enqueued_at) DESC`
            );
            if (allDone.length > 100) {
                const thresholdTs = allDone[99].ts;
                const idsToDelete = allDone.slice(100).map(r => r.id);
                if (idsToDelete.length) {
                    store.exec(
                        `DELETE FROM task_queue WHERE id IN (${idsToDelete.map(() => '?').join(',')}) AND status='done'`,
                        ...idsToDelete
                    );
                }
            }
        }
    } catch (e) {
        console.warn('[task-queue] 启动清理过期 done 失败：', e.message);
    }
}

// ========== Lora 库（Phase 1：数据层）==========
function ensureLorasTable() {
    // 委托给 LorasStore 自身的 ensureTable（保持 SQL 集中在一个文件）
    if (!lorasStore) {
        // 极早路径（理论上不会跑到这里，因为 initStore 里 new 在 ensureTable 之后）
        lorasStore = new LorasStore({ store, getAssetsDir, getComfyConfig, getCoversDir });
    }
    lorasStore.ensureTable();
    console.log('[loras] loras 表已就绪');
}

ipcMain.handle('prompt:item:list', async (_e, payload) => {
    try {
        const catId = payload && payload.category_id;
        // LEFT JOIN prompt_menu 把分类的 tag_required / tag_exclusive_group 一并返回
        // 这样前端校验（互斥组 / 数量规则）无需再查分类表
        let rows;
        if (catId) {
            rows = store.query(
                `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity, i.preview_image,
                        m.category_name, m.tag_required, m.tag_exclusive_group, m.exclusive_with, m.exclusive_group
                   FROM prompt_items i
                   LEFT JOIN prompt_menu m ON m.id = i.category_id
                  WHERE i.category_id = ?
                  ORDER BY i.sort_order ASC, i.id ASC`,
                Number(catId)
            );
        } else {
            rows = store.query(
                `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity, i.preview_image,
                        m.category_name, m.tag_required, m.tag_exclusive_group, m.exclusive_with, m.exclusive_group
                   FROM prompt_items i
                   LEFT JOIN prompt_menu m ON m.id = i.category_id
                  ORDER BY i.category_id ASC, i.sort_order ASC, i.id ASC`
            );
        }
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 批量拉取：传一个分类 id 数组，返回 { [category_id]: [items] }
ipcMain.handle('prompt:item:listByCategories', async (_e, payload) => {
    try {
        const ids = (payload && payload.category_ids) || [];
        if (!Array.isArray(ids) || ids.length === 0) return { ok: true, map: {} };
        const placeholders = ids.map(() => '?').join(',');
        const rows = store.query(
            `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity, i.preview_image,
                    m.category_name, m.tag_required, m.tag_exclusive_group, m.exclusive_with, m.exclusive_group
               FROM prompt_items i
               LEFT JOIN prompt_menu m ON m.id = i.category_id
              WHERE i.category_id IN (${placeholders})
              ORDER BY i.sort_order ASC, i.id ASC`,
            ...ids.map(Number)
        );
        const map = {};
        for (const r of rows) {
            (map[r.category_id] = map[r.category_id] || []).push(r);
        }
        return { ok: true, map };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:item:add', async (_e, payload) => {
    try {
        if (!payload || !payload.category_id || !payload.name) return { ok: false, error: 'category_id/name 必填' };
        const r = store.exec(
            'INSERT INTO prompt_items (category_id, name, content, description, sort_order, sensitivity, preview_image) VALUES (?, ?, ?, ?, ?, ?, ?)',
            Number(payload.category_id), payload.name, payload.content || '', payload.description || '', Number(payload.sort_order) || 0, payload.sensitivity || 'nsfw', payload.preview_file || ''
        );
        return { ok: true, id: r.lastInsertRowid };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:item:update', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = Number(payload.id);
        const cur = store.query('SELECT * FROM prompt_items WHERE id = ?', id);
        if (!cur.length) return { ok: false, error: `item id=${id} 不存在` };
        const old = cur[0];
        const name = payload.name ?? old.name;
        const content = payload.content ?? old.content;
        const description = payload.description ?? old.description;
        const sensitivity = payload.sensitivity ?? old.sensitivity ?? 'nsfw';
        const sortOrder = (payload.sort_order !== undefined) ? Number(payload.sort_order) : old.sort_order;
        const categoryId = (payload.category_id !== undefined) ? Number(payload.category_id) : old.category_id;
        // preview_image 处理：payload.preview_file 有值 → 用新值；显式 preview_clear=true → 清空；否则保留
        let previewImage = old.preview_image || '';
        if (payload.preview_clear === true) {
            // 清除：删旧文件，DB 留空
            if (previewImage) {
                try { await fsp.unlink(path.join(getPreviewsDir(), previewImage)); }
                catch (e) { console.warn('[prompt:item:update] 删旧 preview 失败:', e.message); }
            }
            previewImage = '';
        } else if (payload.preview_file) {
            // 替换：删旧文件（如果有）
            if (previewImage && previewImage !== payload.preview_file) {
                try { await fsp.unlink(path.join(getPreviewsDir(), previewImage)); }
                catch (e) { console.warn('[prompt:item:update] 删旧 preview 失败:', e.message); }
            }
            previewImage = payload.preview_file;
        }
        store.exec(
            'UPDATE prompt_items SET name=?, content=?, description=?, sort_order=?, sensitivity=?, category_id=?, preview_image=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?',
            name, content, description, sortOrder, sensitivity, categoryId, previewImage, id
        );
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:item:delete', async (_e, id) => {
    try {
        const nid = Number(id);
        if (!nid) return { ok: false, error: 'id 必填' };
        // 先查 preview_image，删记录前清掉磁盘文件
        const rows = store.query('SELECT preview_image FROM prompt_items WHERE id = ?', nid);
        if (rows.length && rows[0].preview_image) {
            try { await fsp.unlink(path.join(getPreviewsDir(), rows[0].preview_image)); }
            catch (e) { console.warn('[prompt:item:delete] 删 preview 文件失败:', e.message); }
        }
        const r = store.exec('DELETE FROM prompt_items WHERE id = ?', nid);
        return { ok: true, deleted: r.changes };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== 提示词预览图：上传 / 读取 / 删除 ==========
// 存储：<promptsDir>/previews/<filename>
// 文件名格式：<itemId>-<timestamp36>.<ext>（itemId 必填；新增时前端可传 "new-<ts>" 占位）
const ALLOWED_PREVIEW_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PREVIEW_SIZE = 2 * 1024 * 1024; // 2MB

function getPreviewsDir() {
    const dir = path.join(getPromptsDir(), 'previews');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

ipcMain.handle('prompt:preview:upload', async (_e, payload) => {
    try {
        if (!payload) return { ok: false, error: 'payload 必填' };
        const mime = String(payload.mime || '');
        if (!ALLOWED_PREVIEW_MIME.has(mime)) return { ok: false, error: `不支持的 mime: ${mime}（仅 jpg/png/webp）` };
        let b64 = payload.dataBase64 || '';
        if (!b64 && payload.dataUrl) {
            const m = String(payload.dataUrl).match(/^data:[^;]+;base64,(.+)$/);
            if (m) b64 = m[1];
        }
        if (!b64) return { ok: false, error: '缺图片数据' };
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > MAX_PREVIEW_SIZE) return { ok: false, error: `图片超过 ${MAX_PREVIEW_SIZE / 1024 / 1024}MB 限制（${(buf.length / 1024 / 1024).toFixed(1)}MB）` };
        const ext = MIME_TO_EXT[mime] || 'jpg';
        // 文件名：<itemId|new>-<timestamp36>.<ext>
        const rawStem = String(payload.itemId || `new-${Date.now()}`).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
        const stem = `${rawStem}-${Date.now().toString(36)}`;
        const fileName = `${stem}.${ext}`;
        const absDir = getPreviewsDir();
        const absFile = path.join(absDir, fileName);
        await fsp.writeFile(absFile, buf);
        return { ok: true, fileName, size: buf.length, mime, absDir };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:preview:read', async (_e, payload) => {
    try {
        const fileName = payload && payload.fileName;
        if (!fileName) return { ok: false, error: 'fileName 必填' };
        // 路径防穿越：禁止 .. / 路径分隔符
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return { ok: false, error: '路径非法' };
        }
        const absDir = getPreviewsDir();
        const absFile = path.join(absDir, fileName);
        if (!fs.existsSync(absFile)) return { ok: false, error: '预览图不存在' };
        const buf = await fsp.readFile(absFile);
        const ext = path.extname(fileName).slice(1).toLowerCase();
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        const mime = mimeMap[ext] || 'image/jpeg';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, size: buf.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:preview:delete', async (_e, payload) => {
    try {
        const fileName = payload && payload.fileName;
        if (!fileName) return { ok: false, error: 'fileName 必填' };
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return { ok: false, error: '路径非法' };
        }
        const absDir = getPreviewsDir();
        const absFile = path.join(absDir, fileName);
        if (fs.existsSync(absFile)) {
            await fsp.unlink(absFile);
            return { ok: true, deleted: true };
        }
        return { ok: true, deleted: false };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:item:get', async (_e, id) => {
    try {
        const rows = store.query('SELECT id, category_id, name, content, description, sort_order, sensitivity, preview_image FROM prompt_items WHERE id = ?', Number(id) || 0);
        return { ok: true, item: rows[0] || null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-40: 批量按 id 查 item（用于场景模板回显已选项）
ipcMain.handle('prompt:item:getByIds', async (_e, payload) => {
    try {
        const ids = (payload && Array.isArray(payload.ids)) ? payload.ids : [];
        if (ids.length === 0) return { ok: true, items: [] };
        // 过滤非法 id（<=0 / NaN）
        const cleanIds = ids.map(x => Number(x)).filter(x => Number.isFinite(x) && x > 0);
        if (cleanIds.length === 0) return { ok: true, items: [] };
        const placeholders = cleanIds.map(() => '?').join(',');
        const rows = store.query(
            `SELECT id, category_id, name, content, description, sort_order, sensitivity, preview_image
               FROM prompt_items WHERE id IN (${placeholders})`,
            ...cleanIds
        );
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-40: 全量 item（LEFT JOIN category）— 给 picker 做跨分类搜索用
// 数据量：~700 items × ~150B = ~100KB，单次返回，前端缓存
ipcMain.handle('prompt:item:listAll', async () => {
    try {
        const rows = store.query(
            `SELECT i.id, i.category_id, i.name, i.sensitivity, i.preview_image,
                    m.category_name, m.tag_required, m.tag_exclusive_group, m.exclusive_with, m.exclusive_group
               FROM prompt_items i
               LEFT JOIN prompt_menu m ON m.id = i.category_id
              ORDER BY i.category_id ASC, i.sort_order ASC, i.id ASC`
        );
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== 提示词配置 Excel/CSV 导入 ==========
ipcMain.handle('prompt:item:import', async (_e, payload) => {
    try {
        const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
        if (!rows.length) return { ok: false, error: '没有要导入的数据' };

        // 预加载所有分类到缓存（用 category_name 匹配）
        const catRows = store.query('SELECT id, category_name FROM prompt_menu');
        const catByName = new Map();
        catRows.forEach(c => catByName.set(String(c.category_name || '').trim(), c.id));

        let imported = 0, updated = 0, skipped = 0, catsCreated = 0;
        const skippedDetails = [];

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i] || {};
            const rowNum = i + 2; // Excel 行号（1=header）

            // 兼容中英文表头
            const catName = String(r.categoryName || r['分类名称'] || r.category_name || '').trim();
            const name = String(r.name || r['提示词名称'] || '').trim();
            const content = String(r.content || r['提示词内容'] || '').trim();
            const description = String(r.description || r['描述'] || '').trim();
            const sortOrder = parseInt(r.sortOrder || r['排序'] || r.sort_order || 0, 10) || 0;
            const sensitivity = String(r.sensitivity || r['敏感度'] || 'nsfw').trim() || 'nsfw';
            const previewImage = String(r.previewImage || r['预览图'] || r.preview_image || '').trim();

            if (!name) { skipped++; skippedDetails.push({ row: rowNum, reason: '提示词名称为空' }); continue; }
            if (!catName) { skipped++; skippedDetails.push({ row: rowNum, reason: '分类名称为空' }); continue; }
            if (!['nsfw', 'sfw'].includes(sensitivity)) {
                skipped++; skippedDetails.push({ row: rowNum, reason: '敏感度必须是 nsfw/sfw，得到: ' + sensitivity }); continue;
            }

            // 分类查找 / 自动创建（作为根级）
            let catId = catByName.get(catName);
            if (!catId) {
                try {
                    const r2 = store.exec(
                        'INSERT INTO prompt_menu (category_name, parent_id, description, pid_list, sort_order, is_required) VALUES (?, 0, ?, ?, 0, 0)',
                        catName, '', ''
                    );
                    catId = r2.lastInsertRowid;
                    catByName.set(catName, catId);
                    catsCreated++;
                } catch (e) {
                    skipped++; skippedDetails.push({ row: rowNum, reason: '自动创建分类失败: ' + e.message }); continue;
                }
            }

            // upsert by (category_id, name)
            const existing = store.query(
                'SELECT id FROM prompt_items WHERE category_id = ? AND name = ? LIMIT 1',
                catId, name
            );
            if (existing.length) {
                store.exec(
                    "UPDATE prompt_items SET content=?, description=?, sort_order=?, sensitivity=?, preview_image=?, updated_at=strftime('%s','now') WHERE id=?",
                    content, description, sortOrder, sensitivity, previewImage, existing[0].id
                );
                updated++;
            } else {
                store.exec(
                    'INSERT INTO prompt_items (category_id, name, content, description, sort_order, sensitivity, preview_image) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    catId, name, content, description, sortOrder, sensitivity, previewImage
                );
                imported++;
            }
        }
        return { ok: true, imported, updated, skipped, catsCreated, skippedDetails: skippedDetails.slice(0, 20) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========================================================================
// 提示词库（单表 + tags CSV 列：prompt_library）
// 用户私人 AI 生图提示词收藏，与 NSFW 标签系统（prompt_menu/prompt_items）完全隔离
// ========================================================================

// ---------- 标签 ----------
// tags CSV 列解析：',a,b,,' → ['a','b']（trim + 去空）。保留原顺序。
function parseTagCsv(s) {
    if (!s) return [];
    return s.split(',').map(x => String(x || '').trim()).filter(Boolean);
}

ipcMain.handle('prompt:library:tag:list', async () => {
    try {
        // 总条目数（用于「全部」chip 计数；不能用 tag 出现次数之和，1 条多 tag 会重复计数）
        const total = store.query('SELECT COUNT(*) AS n FROM prompt_library')[0].n;
        // 从每行的 tags CSV 解析 + 统计每个标签出现在多少条条目里；按字典序
        const rows = store.query("SELECT tags FROM prompt_library WHERE tags IS NOT NULL AND tags != ''");
        const counts = new Map();
        for (const r of rows) {
            const seen = new Set();
            for (const t of parseTagCsv(r.tags)) {
                const key = t.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                counts.set(t, (counts.get(t) || 0) + 1);
            }
        }
        const items = [...counts.entries()]
            .map(([name, count]) => ({ id: 0, name, count }))   // id 已无意义，前端只按 name 用
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
        return { ok: true, items, total };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:library:tag:delete', async (_e, name) => {
    try {
        const tagName = String(name || '').trim();
        if (!tagName) return { ok: false, error: '标签名必填' };
        // 找出所有 tags 列包含该标签的行，去掉这个标签后回写
        const rows = store.query('SELECT id, tags FROM prompt_library WHERE tags LIKE ?', `%${tagName}%`);
        for (const r of rows) {
            const filtered = parseTagCsv(r.tags).filter(t => t !== tagName);
            store.exec(
                "UPDATE prompt_library SET tags = ?, updated_at = strftime('%s','now') WHERE id = ?",
                filtered.join(','), r.id
            );
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ---------- 提示词条目 ----------
ipcMain.handle('prompt:library:item:list', async (_e, payload) => {
    try {
        const tagFilter = String((payload && payload.tag_name) || '').trim();
        let rows;
        if (tagFilter) {
            // 用 ',tag,' 包裹后 LIKE 匹配，避免前缀/后缀子串误命中（如 '人物' 命中 '人物群体'）
            rows = store.query(
                `SELECT id, prompt_zh, prompt_en, tags, created_at, updated_at
                   FROM prompt_library
                  WHERE ',' || tags || ',' LIKE ?
                  ORDER BY id DESC`,
                `%,${tagFilter},%`
            );
        } else {
            rows = store.query(
                'SELECT id, prompt_zh, prompt_en, tags, created_at, updated_at FROM prompt_library ORDER BY id DESC'
            );
        }
        const items = rows.map(r => ({
            id: r.id,
            prompt_zh: r.prompt_zh || '',
            prompt_en: r.prompt_en || '',
            created_at: r.created_at, updated_at: r.updated_at,
            tag_names: parseTagCsv(r.tags),
        }));
        return { ok: true, items };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:library:item:add', async (_e, payload) => {
    try {
        const promptZh = String((payload && payload.prompt_zh) || '').trim();
        const promptEn = String((payload && payload.prompt_en) || '').trim();
        const tagNames = Array.isArray(payload && payload.tag_names) ? payload.tag_names : [];
        if (!promptZh && !promptEn) return { ok: false, error: '中英文提示词至少填一个' };
        const tagsCsv = normalizeTagsCsv(tagNames);
        const r = store.exec(
            'INSERT INTO prompt_library (prompt_zh, prompt_en, tags) VALUES (?, ?, ?)',
            promptZh, promptEn, tagsCsv
        );
        return { ok: true, id: r.lastInsertRowid };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:library:item:update', async (_e, payload) => {
    try {
        const id = Number((payload && payload.id) || 0);
        const promptZh = String((payload && payload.prompt_zh) || '').trim();
        const promptEn = String((payload && payload.prompt_en) || '').trim();
        const tagNames = Array.isArray(payload && payload.tag_names) ? payload.tag_names : [];
        if (!id) return { ok: false, error: 'id 必填' };
        if (!promptZh && !promptEn) return { ok: false, error: '中英文提示词至少填一个' };
        const cur = store.query('SELECT id FROM prompt_library WHERE id = ?', id);
        if (!cur.length) return { ok: false, error: `提示词 id=${id} 不存在` };
        const tagsCsv = normalizeTagsCsv(tagNames);
        store.exec(
            "UPDATE prompt_library SET prompt_zh = ?, prompt_en = ?, tags = ?, updated_at = strftime('%s','now') WHERE id = ?",
            promptZh, promptEn, tagsCsv, id
        );
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:library:item:delete', async (_e, id) => {
    try {
        const itemId = Number(id) || 0;
        if (!itemId) return { ok: false, error: 'id 必填' };
        store.exec('DELETE FROM prompt_library WHERE id = ?', itemId);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-30: NSFW 模板拼装（本地化，零 LLM 依赖） ==========
const NSFW_TEMPLATES_KEY = '__nsfw_templates__';       // { modules, tags, importedAt, sourceDir }
const NSFW_TEMPLATES_META = '__nsfw_templates_meta__';  // { count, importedAt, sourceDir }

// 1) 导入本地 .md 目录到 db
ipcMain.handle('nsfw:importTemplates', async (_, payload) => {
    try {
        const dir = (payload && payload.dir) || 'D:\\nsfw-prompt-templates-asian-main';
        if (!fs.existsSync(dir)) {
            return { ok: false, error: `目录不存在: ${dir}` };
        }
        const result = parseNsfwDirectory(dir);
        // 写 db：模块定义 + 词条
        configStore.set(NSFW_TEMPLATES_KEY, {
            modules: result.modules,
            tags: result.tags,
        });
        const meta = {
            count: result.stats.totalTags,
            moduleCount: result.stats.totalModules,
            importedAt: new Date().toISOString(),
            sourceDir: dir,
        };
        configStore.set(NSFW_TEMPLATES_META, meta);
        return { ok: true, ...meta, byModule: result.stats.byModule };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 2) 列出当前 db 里的模板（带分页避免一次返回 6k+ 拖慢）
ipcMain.handle('nsfw:listTemplates', async (_, payload) => {
    try {
        const stored = configStore.get(NSFW_TEMPLATES_KEY);
        const meta = configStore.get(NSFW_TEMPLATES_META);
        if (!stored) return { ok: false, error: '未导入模板，请先执行 importTemplates' };
        // payload.module 不传 → 只返回模块列表（轻）
        if (!payload || !payload.module) {
            return {
                ok: true,
                modules: stored.modules,
                meta,
            };
        }
        // 传 module → 返回该模块的所有 tag
        const tags = stored.tags.filter(t => t.module === payload.module);
        return { ok: true, module: payload.module, tags, count: tags.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 3) 拼装（零 LLM 依赖，纯本地）
ipcMain.handle('nsfw:assemble', async (_, payload) => {
    try {
        const stored = configStore.get(NSFW_TEMPLATES_KEY);
        if (!stored) return { ok: false, error: '未导入模板，请先执行 importTemplates' };
        const { tagIds, seed } = payload || {};
        // 索引化：按 module 分组
        const allByModule = new Map();
        for (const t of stored.tags) {
            if (!allByModule.has(t.module)) allByModule.set(t.module, []);
            allByModule.get(t.module).push(t);
        }
        // 索引化：用户选中的 tag
        const tagMap = new Map(stored.tags.map(t => [t.id, t]));
        const selectedByModule = new Map();
        if (Array.isArray(tagIds)) {
            for (const id of tagIds) {
                const t = tagMap.get(id);
                if (t) {
                    if (!selectedByModule.has(t.module)) selectedByModule.set(t.module, []);
                    selectedByModule.get(t.module).push(t);
                }
            }
        }
        const result = nsfwAssembler.assemble({
            modules: stored.modules,
            selectedTagsByModule: selectedByModule,
            allTagsByModule: allByModule,
            seed,
        });
        return { ok: true, ...result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 4) 拼装 + LLM 优化（拼好之后把 prompt 发给 LLM 改写）
ipcMain.handle('nsfw:assembleAndRefine', async (_, payload) => {
    try {
        const stored = configStore.get(NSFW_TEMPLATES_KEY);
        if (!stored) return { ok: false, error: '未导入模板，请先执行 importTemplates' };
        // 先拼装
        const { tagIds, seed } = payload || {};
        const allByModule = new Map();
        for (const t of stored.tags) {
            if (!allByModule.has(t.module)) allByModule.set(t.module, []);
            allByModule.get(t.module).push(t);
        }
        const tagMap = new Map(stored.tags.map(t => [t.id, t]));
        const selectedByModule = new Map();
        if (Array.isArray(tagIds)) {
            for (const id of tagIds) {
                const t = tagMap.get(id);
                if (t) {
                    if (!selectedByModule.has(t.module)) selectedByModule.set(t.module, []);
                    selectedByModule.get(t.module).push(t);
                }
            }
        }
        const a = nsfwAssembler.assemble({
            modules: stored.modules,
            selectedTagsByModule: selectedByModule,
            allTagsByModule: allByModule,
            seed,
        });
        if (!a.ok) return a;
        // 再调 LLM 改写
        const llmCfg = configStore.get(LLM_CONFIG_KEY);
        if (!llmCfg || !llmCfg.baseUrl) {
            return { ok: false, error: '未配置 LLM（请先在设置里填 Ollama baseUrl）' };
        }
        if (!llmCfg.model) {
            return { ok: false, error: '未选择 LLM 模型' };
        }
        const mode = (payload && payload.mode) || llmCfg.mode || 'nsfw';
        const sys = (llmCfg.systemPrompts && (mode === 'nsfw' ? llmCfg.systemPrompts.nsfw : llmCfg.systemPrompts.sfw)) || llmCfg.systemPrompts || '';
        const refinePrompt = (llmCfg.refinePrompt || '请基于以下组装好的提示词做润色和扩展，使其更适合 Stable Diffusion / SDXL 生成。要求：保持原意、增强细节、保持英文输出、不超过 300 词。');
        const userMsg = `${refinePrompt}\n\n[组装结果]\n${a.text}`;
        const jobId = `refine_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        try {
            const r = await llmGenerate({
                baseUrl: llmCfg.baseUrl,
                model: llmCfg.model,
                system: sys,
                prompt: userMsg,
                jobId,
                temperature: llmCfg.temperature,
            });
            if (!r.ok) {
                return { ok: false, error: r.error || 'LLM 调用失败', assembled: a };
            }
            return {
                ok: true,
                assembled: a,
                refined: { text: r.text, model: llmCfg.model, mode },
            };
        } catch (e) {
            return { ok: false, error: `LLM 调用失败: ${e.message}`, assembled: a };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-27: 生成历史 ==========
ipcMain.handle('prompt:history:list', async () => {
    try {
        const h = configStore.get(PROMPT_HISTORY_KEY) || [];
        return { ok: true, history: h };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:history:clear', async () => {
    try {
        configStore.set(PROMPT_HISTORY_KEY, []);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-42: 已废弃 — 不再使用 tag_exclusive_group 概念；改用直接分类配对（exclusive_with 列）
// ========== D-35: 拼装规则（有序 L1 列表） ==========
// data: [{ menuId: number, sortOrder: number }, ...]  —— 顺序 = 数组顺序（sortOrder 字段仅作展示）
// 返回：{ ok, rule: [...] }
ipcMain.handle('prompt:assembleRule:get', async () => {
    try {
        const rule = configStore.get(ASSEMBLE_RULE_KEY) || [];
        return { ok: true, rule: Array.isArray(rule) ? rule : [] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 整个覆盖。校验：必须是数组，每项 { menuId, sortOrder } 都在现有 prompt_menu 任意分类里。
// D-40: 放宽到任意 depth —— 用户可勾选 L1 根、L2 章节、L3 子分类
// 旧的只允许 L1 限制过于粗粒度（一个根=整个分类树都进拼装）
ipcMain.handle('prompt:assembleRule:set', async (_e, newRule) => {
    try {
        if (!Array.isArray(newRule)) return { ok: false, error: 'rule 必须是数组' };
        // 查现有 menu 集合（任意 depth）
        const menuRows = store.query('SELECT id FROM prompt_menu');
        const menuSet = new Set(menuRows.map(r => r.id));
        const cleaned = [];
        const seen = new Set();
        for (let i = 0; i < newRule.length; i++) {
            const r = newRule[i];
            if (!r || typeof r.menuId !== 'number') return { ok: false, error: `第 ${i} 项 menuId 必填为数字` };
            if (!menuSet.has(r.menuId)) return { ok: false, error: `第 ${i} 项 menuId=${r.menuId} 不存在` };
            if (seen.has(r.menuId)) return { ok: false, error: `第 ${i} 项 menuId=${r.menuId} 重复` };
            seen.add(r.menuId);
            cleaned.push({ menuId: r.menuId, sortOrder: i + 1 });
        }
        configStore.set(ASSEMBLE_RULE_KEY, cleaned);
        return { ok: true, rule: cleaned };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

app.on('before-quit', () => {
    // ComfyUI: 杀子进程 + abort 所有 jobs
    try { abortAllComfyJobs('app quitting'); } catch {}
    try { comfyuiProcess.stopService(); } catch {}
    try { store?.close(); } catch {}
});

// ========== ComfyUI（AI 生图）=========
const COMFYUI_CONFIG_KEY = '__comfyui_config__';
const COMFYUI_DEFAULT_CONFIG = {
    pythonPath: '',
    comfyDir: '',
    port: 8188,
    outputDir: '',         // 可选：ComfyUI 自己 output 目录的拷贝
    keepRunningAfterAppExit: false,
    autoStartOnLaunch: true,        // 启动时自动 spawn ComfyUI（用户可在设置里关闭）
    startupTimeoutMs: 120 * 1000,   // 单次启动等待 /system_stats 的超时（最大 10 分钟）
    jobTimeoutMs: 10 * 60 * 1000,
};
const MEDIA_DIR_NAME = 'media';
const MAX_MEDIA_SIZE = 200 * 1024 * 1024; // 200MB（视频通常较大，图片远低于此）
const ALLOWED_MIME = new Set([
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
]);
// mime → 文件扩展名（saveAsset / saveMedia 共用）
const MIME_TO_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
};

function ensureMediaDir() {
    const mediaDir = path.join(promptsDir, MEDIA_DIR_NAME);
    fs.mkdirSync(mediaDir, { recursive: true });
}

function getMediaDir() {
    return path.join(promptsDir, MEDIA_DIR_NAME);
}

function getComfyConfig() {
    return configStore.get(COMFYUI_CONFIG_KEY) || { ...COMFYUI_DEFAULT_CONFIG };
}

function setComfyConfig(cfg) {
    const merged = { ...COMFYUI_DEFAULT_CONFIG, ...(cfg || {}) };
    configStore.set(COMFYUI_CONFIG_KEY, merged);
    return merged;
}

ipcMain.handle('comfyui:config:get', async () => {
    try { return { ok: true, config: getComfyConfig() }; }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:config:set', async (_e, cfg) => {
    try {
        // 字段白名单
        const out = {
            pythonPath: typeof cfg?.pythonPath === 'string' ? cfg.pythonPath : '',
            comfyDir: typeof cfg?.comfyDir === 'string' ? cfg.comfyDir : '',
            port: Number(cfg?.port) || 8188,
            outputDir: typeof cfg?.outputDir === 'string' ? cfg.outputDir : '',
            keepRunningAfterAppExit: !!cfg?.keepRunningAfterAppExit,
            autoStartOnLaunch: cfg?.autoStartOnLaunch !== false,   // 默认 true；缺省/true 都开；显式 false 才关
            startupTimeoutMs: Math.min(
                Math.max(Number(cfg?.startupTimeoutMs) || COMFYUI_DEFAULT_CONFIG.startupTimeoutMs, 5 * 1000),
                10 * 60 * 1000  // 10 分钟硬上限
            ),
            jobTimeoutMs: Number(cfg?.jobTimeoutMs) || COMFYUI_DEFAULT_CONFIG.jobTimeoutMs,
        };
        configStore.set(COMFYUI_CONFIG_KEY, out);
        return { ok: true, config: out };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ========= 资产存储配置（路径可改，但默认指向 userData/assets） =========
ipcMain.handle('config:assets:get', async () => {
    try {
        const cfg = getAssetsConfig();
        // 返回时附上当前实际使用的目录（默认 vs 用户配置）
        return { ok: true, config: cfg, resolvedDir: getAssetsDir(), isDefault: !cfg.dir || cfg.dir === defaultAssetsDir() };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:assets:set', async (_e, cfg) => {
    try {
        const dir = typeof cfg?.dir === 'string' ? cfg.dir.trim() : '';
        // 拒绝包含 .. 的路径
        if (dir && dir.includes('..')) return { ok: false, error: '路径不允许包含 ..' };
        // 空 = 恢复默认
        const out = setAssetsConfig({ dir });
        // 立即尝试创建目录
        ensureAssetsDir();
        return { ok: true, config: out, resolvedDir: getAssetsDir() };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:assets:pick', async () => {
    try {
        const cur = getAssetsConfig().dir || defaultAssetsDir();
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择资产存储目录',
            defaultPath: cur,
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        return { ok: true, path: r.filePaths[0] };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:assets:open', async () => {
    try {
        const dir = getAssetsDir();
        const { shell } = require('electron');
        await shell.openPath(dir);
        return { ok: true, dir };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:start', async (_e, cfg) => {
    try {
        const cur = getComfyConfig();
        const merged = { ...cur, ...(cfg || {}) };
        // 把最新 cfg 落库（端口可能改了）
        setComfyConfig(merged);
        const r = await comfyuiProcess.startService(merged);
        return r;
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:stop', async () => {
    try {
        abortAllComfyJobs('user stop');
        return await comfyuiProcess.stopService();
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:status', async () => {
    try { return { ok: true, ...comfyuiProcess.getStatus() }; }
    catch (e) { return { ok: false, error: e.message }; }
});

// 终端日志环形缓冲（renderer 右侧浮层用）
ipcMain.handle('comfyui:log:get', async () => {
    try { return { ok: true, lines: getComfyLogBuffer() }; }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('comfyui:log:clear', async () => {
    try { clearComfyLogBuffer(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:health', async () => {
    try { return await comfyuiProcess.healthCheck(); }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:pickPython', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: '选择 Python.exe',
            filters: [{ name: 'Python', extensions: ['exe'] }, { name: '全部文件', extensions: ['*'] }],
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        return { ok: true, path: r.filePaths[0] };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:pickComfyDir', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: '选择 ComfyUI 根目录（含 main.py）',
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        return { ok: true, path: r.filePaths[0] };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:pickOutputDir', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择图片输出目录（可选）',
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        return { ok: true, path: r.filePaths[0] };
    } catch (e) { return { ok: false, error: e.message }; }
});

// AI 工具表单用：选本地图片（ComfyUI LoadImage 节点的 image 字段）
// 选完图后自动复制到 <comfyDir>/input/（ComfyUI LoadImage 只认这个目录）
// 重名时加时间戳后缀；复制失败时返回原 basename，由 renderer 提示用户手动放到 input 目录
// 把一张已存在的图片复制到 ComfyUI input 目录，返回 { comfyuiName, copied, copyError }
// 用于「资产 Tab → 跳转到 AI 工具」流程：renderer 拿 asset 全路径 → main 复制 → 拿 comfyuiName 填表单
function stageImageForComfyui(srcPath) {
    if (!srcPath || typeof srcPath !== 'string') {
        return { comfyuiName: '', copied: false, copyError: 'srcPath 必填' };
    }
    if (!fs.existsSync(srcPath)) {
        return { comfyuiName: '', copied: false, copyError: `源文件不存在: ${srcPath}` };
    }
    const srcName = path.basename(srcPath);
    let comfyuiName = srcName;
    let copied = false;
    let copyError = null;
    const cfg = getComfyConfig();
    if (!cfg || !cfg.comfyDir) {
        return { comfyuiName, copied, copyError: 'ComfyUI 目录未配置' };
    }
    const inputDir = path.join(cfg.comfyDir, 'input');
    try {
        if (!fs.existsSync(inputDir)) {
            return { comfyuiName, copied, copyError: `ComfyUI input 目录不存在: ${inputDir}` };
        }
        let destName = srcName;
        let destPath = path.join(inputDir, destName);
        if (fs.existsSync(destPath)) {
            const ext = path.extname(srcName);
            const base = path.basename(srcName, ext);
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            destName = `${base}_${ts}${ext}`;
            destPath = path.join(inputDir, destName);
        }
        fs.copyFileSync(srcPath, destPath);
        comfyuiName = destName;
        copied = true;
    } catch (e) {
        copyError = e.message;
    }
    return { comfyuiName, copied, copyError };
}

// 从 base64 / dataUrl 复制图片到 ComfyUI input，返回 { comfyuiName, copied, copyError }
// 用于「渲染端从任意来源（file:// / blob: / http(s):）拿到字节流后上传」的场景。
function stageImageFromBase64(dataUrl) {
    const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return { comfyuiName: '', copied: false, copyError: 'dataUrl 格式错误（必须是 data:<mime>;base64,...）' };
    const mime = m[1];
    const b64 = m[2];
    const ext = MIME_TO_EXT[mime];
    if (!ext) return { comfyuiName: '', copied: false, copyError: `不支持的 mime: ${mime}` };

    const cfg = getComfyConfig();
    if (!cfg || !cfg.comfyDir) return { comfyuiName: '', copied: false, copyError: 'ComfyUI 目录未配置' };
    const inputDir = path.join(cfg.comfyDir, 'input');
    if (!fs.existsSync(inputDir)) return { comfyuiName: '', copied: false, copyError: `ComfyUI input 目录不存在: ${inputDir}` };

    try {
        const destName = `staged-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        const destPath = path.join(inputDir, destName);
        fs.writeFileSync(destPath, Buffer.from(b64, 'base64'));
        return { comfyuiName: destName, copied: true, copyError: null };
    } catch (e) {
        return { comfyuiName: '', copied: false, copyError: e.message };
    }
}

ipcMain.handle('comfyui:stageImageData', async (_e, payload) => {
    try {
        const stage = stageImageFromBase64(payload && payload.dataUrl);
        return { ok: true, ...stage };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 主进程下载远端 URL → 转 dataUrl（用于绕过浏览器 CORS 限制）
ipcMain.handle('comfyui:fetchImageToBase64', async (_e, payload) => {
    try {
        const url = payload && payload.url;
        if (!url) return { ok: false, error: 'url 必填' };
        if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 必须是 http(s)' };
        const r = await fetch(url);
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        const ext = MIME_TO_EXT[mime];
        if (!ext) return { ok: false, error: `不支持的 mime: ${mime}` };
        const ab = await r.arrayBuffer();
        // 上限保护：100MB（node Buffer 一次性处理足够）
        if (ab.byteLength > 100 * 1024 * 1024) return { ok: false, error: '图片超过 100MB' };
        const b64 = Buffer.from(ab).toString('base64');
        return { ok: true, dataUrl: `data:${mime};base64,${b64}`, mime, size: ab.byteLength };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:pickImage', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: '选择图片（I2V / 首尾帧）',
            filters: [
                { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
                { name: '全部文件', extensions: ['*'] },
            ],
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        const srcPath = r.filePaths[0];
        const stage = stageImageForComfyui(srcPath);
        return {
            ok: true,
            path: srcPath,
            name: path.basename(srcPath),
            comfyuiName: stage.comfyuiName,
            copied: stage.copied,
            copyError: stage.copyError,
        };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 直接把已存在的图片（renderer 已知 srcPath）复制到 ComfyUI input，返回 comfyuiName
// 用于从「资产 Tab」跳转到 AI 工具时，省去弹文件选择对话框
ipcMain.handle('comfyui:stageImage', async (_e, payload) => {
    try {
        const srcPath = payload && payload.srcPath;
        const stage = stageImageForComfyui(srcPath);
        return { ok: true, ...stage, name: srcPath ? path.basename(srcPath) : '', path: srcPath || '' };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:listWorkflows', async () => {
    try { return { ok: true, workflows: comfyuiWorkflows.listWorkflows() }; }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:openOutputDir', async () => {
    try {
        const { shell } = require('electron');
        const mediaDir = getMediaDir();
        await shell.openPath(mediaDir);
        return { ok: true, path: mediaDir };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:generate', async (_e, payload) => {
    try {
        const mode = (payload && payload.mode === 'nsfw') ? 'nsfw' : 'sfw';
        const positive = (payload && payload.promptText) || '';
        if (!positive) return { ok: false, error: 'promptText 必填' };
        if (!COMFYUI_STATUS.running) return { ok: false, error: 'ComfyUI 未启动' };
        const port = COMFYUI_STATUS.port;
        // 注入 placeholder
        const inj = comfyuiWorkflows.injectAndClone(mode, positive, null);
        if (!inj.ok) return { ok: false, error: inj.error, warning: inj.warning };
        const clientId = `ree-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cfg = getComfyConfig();
        const handle = comfyuiWs.startJob({
            port,
            workflowJson: inj.workflow,
            clientId,
            mode,
            timeoutMs: cfg.jobTimeoutMs,
        });
        return { ok: true, jobId: handle.jobId, warning: inj.warning || null };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('comfyui:cancel', async (_e, jobId) => {
    try {
        const job = COMFYUI_JOBS.get(jobId);
        if (!job) return { ok: false, error: `jobId ${jobId} 不存在` };
        try { job.ac.abort('user cancel'); } catch {}
        COMFYUI_JOBS.delete(jobId);
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 写图片到 <promptsDir>/media/<id>.<ext> 并返回相对路径
ipcMain.handle('comfyui:saveMedia', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = String(payload.id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64) || 'media';
        const mime = String(payload.mime || 'image/png');
        if (!ALLOWED_MIME.has(mime)) return { ok: false, error: `不支持的 mime: ${mime}` };
        const ext = MIME_TO_EXT[mime] || 'bin';
        // payload.dataBase64 或 payload.dataUrl 都接受
        let b64 = payload.dataBase64 || '';
        if (!b64 && payload.dataUrl) {
            const m = String(payload.dataUrl).match(/^data:[^;]+;base64,(.+)$/);
            if (m) b64 = m[1];
        }
        if (!b64) return { ok: false, error: '缺图片数据' };
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > MAX_MEDIA_SIZE) return { ok: false, error: `图片超过 ${MAX_MEDIA_SIZE / 1024 / 1024}MB 限制（${(buf.length / 1024 / 1024).toFixed(1)}MB）` };
        const fileName = `${id}.${ext}`;
        const abs = path.join(getMediaDir(), fileName);
        await fsp.writeFile(abs, buf);
        const rel = `${MEDIA_DIR_NAME}/${fileName}`;
        return { ok: true, mediaPath: rel, mediaMime: mime, mediaSize: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 弹 saveDialog + 写盘
ipcMain.handle('comfyui:saveAs', async (_e, payload) => {
    try {
        if (!payload || !payload.dataUrl && !payload.dataBase64) return { ok: false, error: '缺图片数据' };
        let b64 = payload.dataBase64 || '';
        if (!b64 && payload.dataUrl) {
            const m = String(payload.dataUrl).match(/^data:[^;]+;base64,(.+)$/);
            if (m) b64 = m[1];
        }
        const buf = Buffer.from(b64, 'base64');
        const ext = (payload.filename || '').split('.').pop() || 'png';
        const defaultName = `reelectron-${Date.now()}.${ext}`;
        const r = await dialog.showSaveDialog(mainWindow, {
            title: '另存为',
            defaultPath: defaultName,
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        });
        if (r.canceled || !r.filePath) return { ok: true, canceled: true };
        await fsp.writeFile(r.filePath, buf);
        return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 读媒体文件 → dataUrl（用于历史记录的图片回显）
ipcMain.handle('comfyui:readMedia', async (_e, payload) => {
    try {
        const rel = payload && payload.mediaPath;
        if (!rel) return { ok: false, error: 'mediaPath 必填' };
        if (rel.includes('..')) return { ok: false, error: '路径非法' };
        const abs = path.join(promptsDir, rel);
        if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
        const buf = await fsp.readFile(abs);
        const ext = (rel.split('.').pop() || '').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
});

// D-MID-COMPARE：把本地任意图片读成 dataUrl（仅工作台 compare 模式渲染输入图用）
// 路径来自 pickImage 对话框返回值（用户主动选过的），不允许 .. 段
ipcMain.handle('comfyui:image:readAsDataUrl', async (_e, payload) => {
    try {
        const p = payload && payload.path;
        if (!p || typeof p !== 'string') return { ok: false, error: 'path 必填' };
        if (p.includes('..')) return { ok: false, error: '路径非法' };
        if (!fs.existsSync(p)) return { ok: false, error: '文件不存在' };
        const stat = fs.statSync(p);
        if (!stat.isFile()) return { ok: false, error: '不是文件' };
        if (stat.size > 50 * 1024 * 1024) return { ok: false, error: '文件超过 50MB' };
        const buf = await fsp.readFile(p);
        const ext = (p.split('.').pop() || '').toLowerCase();
        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };
        const mime = mimeMap[ext] || 'image/png';
        return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 自动保存到资产目录（用户配置的 assets dir）：
//   写图片二进制到 <assets>/<safeName>.<ext>
//   写旁路元数据 <assets>/<safeName>.meta.json（workflow/models/LORA/prompt/timing/vram）
// 入参：{ filename?, mime, dataBase64|dataUrl, meta? }
// 返回：{ ok, assetPath, sidecarPath, size, absDir }
ipcMain.handle('comfyui:saveAsset', async (_e, payload) => {
    try {
        if (!payload) return { ok: false, error: 'payload 必填' };
        const mime = String(payload.mime || 'image/png');
        if (!ALLOWED_MIME.has(mime)) return { ok: false, error: `不支持的 mime: ${mime}` };
        let b64 = payload.dataBase64 || '';
        if (!b64 && payload.dataUrl) {
            const m = String(payload.dataUrl).match(/^data:[^;]+;base64,(.+)$/);
            if (m) b64 = m[1];
        }
        if (!b64) return { ok: false, error: '缺图片数据' };
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > MAX_MEDIA_SIZE) return { ok: false, error: `图片超过 ${MAX_MEDIA_SIZE / 1024 / 1024}MB 限制（${(buf.length / 1024 / 1024).toFixed(1)}MB）` };
        const ext = MIME_TO_EXT[mime] || 'bin';
        // 文件名：优先用 payload.filename（不含扩展），否则时间戳 + 随机
        const stem = (() => {
            const raw = String(payload.filename || '').trim();
            if (raw) return raw.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
            return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        })();
        const absDir = getAssetsDir();
        // 同名文件加后缀避免覆盖
        let finalStem = stem, n = 1;
        while (fs.existsSync(path.join(absDir, `${finalStem}.${ext}`)) || fs.existsSync(path.join(absDir, `${finalStem}.meta.json`))) {
            finalStem = `${stem}-${n++}`;
            if (n > 999) return { ok: false, error: '命名冲突，请清理资产目录后重试' };
        }
        const fileName = `${finalStem}.${ext}`;
        const sidecarName = `${finalStem}.meta.json`;
        const absFile = path.join(absDir, fileName);
        const absSide = path.join(absDir, sidecarName);
        await fsp.writeFile(absFile, buf);
        // 旁路元数据
        const metaObj = {
            ts: Date.now(),
            mime,
            size: buf.length,
            filename: fileName,
            // 用户传入的元数据（workflow/models/LORA/prompt/timing/vram）
            meta: payload.meta || {},
        };
        try { await fsp.writeFile(absSide, JSON.stringify(metaObj, null, 2), 'utf-8'); }
        catch (e) { console.warn('[saveAsset] 写 sidecar 失败:', e.message); }
        return {
            ok: true,
            assetPath: fileName,
            sidecarPath: sidecarName,
            size: buf.length,
            absDir,
        };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 读取资产旁路元数据：<assetsDir>/<filename>.meta.json
// 入参：{ filename }（纯文件名，不含目录、不带 ..）
// 返回：{ ok, meta, hasMeta } — hasMeta=false 时 meta=null（无 sidecar，非错误）
ipcMain.handle('assets:readMeta', async (_e, payload) => {
    try {
        const filename = payload && payload.filename;
        if (!filename) return { ok: false, error: 'filename 必填' };
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return { ok: false, error: '路径非法' };
        }
        const absDir = getAssetsDir();
        const sidecarName = filename.replace(/\.[^.]+$/, '') + '.meta.json';
        const absSide = path.join(absDir, sidecarName);
        if (!fs.existsSync(absSide)) {
            return { ok: true, hasMeta: false, meta: null };
        }
        const txt = await fsp.readFile(absSide, 'utf-8');
        let meta;
        try { meta = JSON.parse(txt); }
        catch (e) { return { ok: false, error: 'sidecar JSON 解析失败: ' + e.message }; }
        return { ok: true, hasMeta: true, meta };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 删除资产：同时删主文件和 .meta.json 旁路
// 入参：{ filename }（纯文件名，不带目录）
// 返回：{ ok, deletedMain, deletedSide, absDir }
ipcMain.handle('assets:delete', async (_e, payload) => {
    try {
        const filename = payload && payload.filename;
        if (!filename) return { ok: false, error: 'filename 必填' };
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return { ok: false, error: '路径非法' };
        }
        const absDir = getAssetsDir();
        const absFile = path.join(absDir, filename);
        if (!fs.existsSync(absFile)) return { ok: false, error: '文件不存在' };
        const stem = filename.replace(/\.[^.]+$/, '');
        const candidates = [
            filename,
            `${stem}.meta.json`,
            `${stem}.png.meta.json`,
            `${stem}.jpg.meta.json`,
            `${stem}.jpeg.meta.json`,
            `${stem}.webp.meta.json`,
            `${stem}.mp4.meta.json`,
            `${stem}.webm.meta.json`,
        ];
        let deletedMain = false, deletedSide = false;
        for (const c of candidates) {
            const abs = path.join(absDir, c);
            if (!fs.existsSync(abs)) continue;
            // 安全：必须在 absDir 之内
            if (!abs.startsWith(absDir + path.sep) && abs !== absDir) continue;
            try { await fsp.unlink(abs); if (c === filename) deletedMain = true; else deletedSide = true; }
            catch (e) { console.warn('[assets:delete] unlink 失败:', c, e.message); }
        }
        return { ok: true, deletedMain, deletedSide, absDir };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ========== 资产生成历史（D-LAYOUT）==========
// 递归扫 save dir 找 *.meta.json，返回带 ts 的清单（按 ts 倒序，limit 默认 1000）
// 入参：{ dir?, limit? } —— dir 不传走 getAssetsDir()
// 返回：{ ok, items: [{filePath, imagePath, ts, mime, size, filename, meta}], scanned, errors }
ipcMain.handle('assets:listHistory', async (_e, payload) => {
    const root = (payload && payload.dir) || getAssetsDir();
    const limit = (payload && Number(payload.limit)) || 1000;
    const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm'];
    const items = [];
    const errors = [];
    let scanned = 0;

    // 轻量递归 BFS（stack 控制深度防 symlink 循环）
    async function walk(dir, depth) {
        if (depth > 6) return; // 最多 6 层防爆栈
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (e) { return; } // 目录不可读 → 跳过
        for (const ent of entries) {
            // 跳过 loras/covers / 隐藏目录
            if (ent.name.startsWith('.')) continue;
            if (ent.name === 'loras' || ent.name === 'covers') continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                await walk(full, depth + 1);
            } else if (ent.isFile() && ent.name.endsWith('.meta.json')) {
                scanned++;
                try {
                    const txt = await fsp.readFile(full, 'utf-8');
                    const env = JSON.parse(txt);
                    const stem = full.replace(/\.meta\.json$/, '');
                    let imagePath = null;
                    for (const ext of IMG_EXTS) {
                        const cand = stem + ext;
                        try { await fsp.access(cand); imagePath = cand; break; }
                        catch (_) { /* try next */ }
                    }
                    items.push({
                        filePath: full,
                        imagePath,
                        ts: env.ts || 0,
                        mime: env.mime || '',
                        size: env.size || 0,
                        filename: env.filename || '',
                        meta: env.meta || {},
                    });
                } catch (e) {
                    errors.push({ file: full, error: e.message });
                }
            }
        }
    }

    try {
        await walk(root, 0);
        items.sort((a, b) => b.ts - a.ts);
        return { ok: true, items: items.slice(0, limit), scanned, errors: errors.slice(0, 20), root };
    } catch (e) {
        return { ok: false, error: e.message, items: [], scanned, errors };
    }
});

// ========== AI 工具（声明式 schema 驱动的 workflow 表单）==========
ipcMain.handle('tools:list', async () => {
    try { return { ok: true, tools: comfyuiToolStore.listTools() }; }
    catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('tools:get', async (_e, id) => {
    try {
        const t = comfyuiToolStore.getTool(id);
        if (!t) return { ok: false, error: `工具 ${id} 不存在` };
        return { ok: true, tool: t };
    } catch (e) { return { ok: false, error: e.message }; }
});

// D-QUEUE：原 tools:run 已迁到下方的任务队列入口（透明入队 → enqueueTask），
// 这里不再注册 handler 以避免 ipcMain.handle 重复注册报错。

// ========== D-37: 关联规则 CRUD + 校验 IPC ==========
ipcMain.handle('prompt:association:listByItem', async (_e, payload) => {
    try {
        const itemId = payload && payload.itemId;
        if (!itemId) return { ok: false, error: 'itemId 必填' };
        const nid = Number(itemId);
        const rows = store.query(`
            SELECT assoc.id, assoc.prompt_a_id, assoc.prompt_b_id, assoc.relation, assoc.weight, assoc.source, assoc.reason,
                   ia.name AS a_name, ib.name AS b_name
            FROM prompt_associations assoc
            LEFT JOIN prompt_items ia ON ia.id = assoc.prompt_a_id
            LEFT JOIN prompt_items ib ON ib.id = assoc.prompt_b_id
            WHERE assoc.prompt_a_id = ? OR assoc.prompt_b_id = ?
            ORDER BY assoc.relation ASC, assoc.weight DESC
        `, nid, nid);
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:association:listAll', async () => {
    try {
        const rows = store.query(`
            SELECT assoc.id, assoc.prompt_a_id, assoc.prompt_b_id, assoc.relation, assoc.weight, assoc.source, assoc.reason,
                   ia.name AS a_name, ib.name AS b_name
            FROM prompt_associations assoc
            LEFT JOIN prompt_items ia ON ia.id = assoc.prompt_a_id
            LEFT JOIN prompt_items ib ON ib.id = assoc.prompt_b_id
            ORDER BY assoc.relation ASC, assoc.weight DESC, assoc.id DESC
        `);
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:association:upsert', async (_e, payload) => {
    try {
        if (!payload) return { ok: false, error: 'payload 必填' };
        const { promptA, promptB, relation, reason, weight, source } = payload;
        if (!promptA || !promptB || !relation) return { ok: false, error: 'promptA/promptB/relation 必填' };
        const rel = String(relation).toLowerCase();
        if (!['strong', 'weak', 'exclusive'].includes(rel)) {
            return { ok: false, error: 'relation 必须是 strong/weak/exclusive' };
        }
        const aRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(promptA).trim());
        const bRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(promptB).trim());
        if (!aRow.length) return { ok: false, error: `A 提示词不存在: ${promptA}` };
        if (!bRow.length) return { ok: false, error: `B 提示词不存在: ${promptB}` };
        const aId = aRow[0].id, bId = bRow[0].id;
        if (aId === bId) return { ok: false, error: 'A 和 B 不能相同' };
        const w = Number(weight) || 50;
        const src = source || 'manual';
        store.exec(`
            INSERT OR IGNORE INTO prompt_associations
            (prompt_a_id, prompt_b_id, relation, weight, reason, source)
            VALUES (?, ?, ?, ?, ?, ?)
        `, aId, bId, rel, w, reason || '', src);
        return { ok: true, aId, bId, relation: rel };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:association:delete', async (_e, id) => {
    try {
        const nid = Number(id);
        if (!nid) return { ok: false, error: 'id 必填' };
        const r = store.exec('DELETE FROM prompt_associations WHERE id = ?', nid);
        return { ok: true, deleted: r.changes };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 核心校验 IPC：传入 itemId 数组，返回冲突 + 推荐
ipcMain.handle('nsfw:validate', async (_e, payload) => {
    try {
        const itemIds = (payload && payload.itemIds) || [];
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return { ok: true, conflicts: [], recommendations: [] };
        }
        const ids = itemIds.map(Number).filter(Boolean);
        if (ids.length === 0) return { ok: true, conflicts: [], recommendations: [] };
        const placeholders = ids.map(() => '?').join(',');

        // 1) 互斥冲突（a↔b 任意方向）
        const conflicts = store.query(`
            SELECT assoc.id, assoc.relation, assoc.reason,
                   ia.id AS a_id, ia.name AS a_name,
                   ib.id AS b_id, ib.name AS b_name
            FROM prompt_associations assoc
            JOIN prompt_items ia ON ia.id = assoc.prompt_a_id
            JOIN prompt_items ib ON ib.id = assoc.prompt_b_id
            WHERE assoc.relation = 'exclusive'
              AND assoc.prompt_a_id IN (${placeholders})
              AND assoc.prompt_b_id IN (${placeholders})
        `, ...ids, ...ids);

        // 2) 强联动推荐：用户已选 A，找 A 的 strong → B 中用户没选的（按权重降序）
        const recs = store.query(`
            SELECT DISTINCT ib.id, ib.name, ib.content,
                   assoc.weight, assoc.reason
            FROM prompt_associations assoc
            JOIN prompt_items ia ON ia.id = assoc.prompt_a_id
            JOIN prompt_items ib ON ib.id = assoc.prompt_b_id
            WHERE assoc.relation = 'strong'
              AND assoc.prompt_a_id IN (${placeholders})
              AND assoc.prompt_b_id NOT IN (${placeholders})
            UNION
            SELECT DISTINCT ia.id, ia.name, ia.content,
                   assoc.weight, assoc.reason
            FROM prompt_associations assoc
            JOIN prompt_items ia ON ia.id = assoc.prompt_a_id
            JOIN prompt_items ib ON ib.id = assoc.prompt_b_id
            WHERE assoc.relation = 'strong'
              AND assoc.prompt_b_id IN (${placeholders})
              AND assoc.prompt_a_id NOT IN (${placeholders})
            ORDER BY weight DESC
            LIMIT 10
        `, ...ids, ...ids, ...ids, ...ids);

        return { ok: true, conflicts, recommendations: recs };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-37 + D-40: 场景模板 CRUD ==========
ipcMain.handle('scene:template:list', async () => {
    try {
        const rows = store.query('SELECT id, name, description, item_ids, source, enabled, created_at, updated_at FROM scene_templates ORDER BY updated_at DESC');
        // 解析 item_ids JSON
        for (const r of rows) {
            try { r.item_ids = JSON.parse(r.item_ids || '[]'); } catch { r.item_ids = []; }
            // 兼容老库 enabled NULL → 1
            r.enabled = r.enabled == null ? 1 : Number(r.enabled);
        }
        return { ok: true, rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('scene:template:add', async (_e, payload) => {
    try {
        if (!payload || !payload.name) return { ok: false, error: 'name 必填' };
        const itemIds = Array.isArray(payload.item_ids) ? JSON.stringify(payload.item_ids) : '[]';
        const r = store.exec(
            'INSERT INTO scene_templates (name, description, item_ids, source, enabled) VALUES (?, ?, ?, ?, ?)',
            payload.name, payload.description || '', itemIds, payload.source || 'manual', payload.enabled == null ? 1 : (payload.enabled ? 1 : 0)
        );
        return { ok: true, id: r.lastInsertRowid };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-40: 编辑 name / description / item_ids（启用状态走独立 toggle）
ipcMain.handle('scene:template:update', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = Number(payload.id);
        const cur = store.query('SELECT * FROM scene_templates WHERE id = ?', id);
        if (!cur.length) return { ok: false, error: `id=${id} 不存在` };
        const old = cur[0];
        const name = payload.name ?? old.name;
        const description = payload.description ?? old.description;
        const itemIds = Array.isArray(payload.item_ids) ? JSON.stringify(payload.item_ids) : old.item_ids;
        store.exec(
            'UPDATE scene_templates SET name = ?, description = ?, item_ids = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?',
            name, description, itemIds, id
        );
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-40: 启用/禁用切换（1/0）
ipcMain.handle('scene:template:toggleEnabled', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = Number(payload.id);
        const enabled = payload.enabled ? 1 : 0;
        store.exec(
            'UPDATE scene_templates SET enabled = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?',
            enabled, id
        );
        return { ok: true, enabled };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// D-40: 删除（不可恢复）
ipcMain.handle('scene:template:delete', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const id = Number(payload.id);
        store.exec('DELETE FROM scene_templates WHERE id = ?', id);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ========== D-38: Excel 批量导入关联规则 ==========
ipcMain.handle('prompt:association:import', async (_e, payload) => {
    try {
        const rows = (payload && payload.rows) || [];
        if (!Array.isArray(rows) || rows.length === 0) {
            return { ok: false, error: 'rows 不能为空数组' };
        }
        let imported = 0, skipped = 0;
        const skippedDetails = [];

        for (const row of rows) {
            const { promptA, promptB, relation, reason, weight } = row;
            if (!promptA || !promptB || !relation) {
                skipped++;
                skippedDetails.push({ row, reason: '缺字段' });
                continue;
            }
            if (!['strong', 'weak', 'exclusive'].includes(String(relation).toLowerCase())) {
                skipped++;
                skippedDetails.push({ row, reason: 'relation 无效: ' + relation });
                continue;
            }
            const aRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(promptA));
            const bRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(promptB));
            if (!aRow.length || !bRow.length) {
                skipped++;
                skippedDetails.push({ row, reason: !aRow.length ? 'A 提示词不存在: ' + promptA : 'B 提示词不存在: ' + promptB });
                continue;
            }
            const aId = aRow[0].id;
            const bId = bRow[0].id;
            if (aId === bId) {
                skipped++;
                skippedDetails.push({ row, reason: 'A 和 B 相同' });
                continue;
            }
            try {
                store.exec(`
                    INSERT OR IGNORE INTO prompt_associations
                    (prompt_a_id, prompt_b_id, relation, weight, reason, source)
                    VALUES (?, ?, ?, ?, ?, 'excel')
                `, aId, bId, String(relation).toLowerCase(), Number(weight) || 50, reason || '');
                imported++;
            } catch (e) {
                skipped++;
                skippedDetails.push({ row, reason: e.message });
            }
        }
        return { ok: true, imported, skipped, skippedDetails: skippedDetails.slice(0, 20) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Excel 模板生成（前端 CDN 已能拉 SheetJS，这里提供 CSV 模板内容）
ipcMain.handle('prompt:association:template', async () => {
    return {
        ok: true,
        filename: 'prompt_associations_template.csv',
        content: 'promptA,promptB,relation,reason,weight\nCCTV,8k,exclusive,监控不可能8K画质,100\nPOV,ceiling mirror,strong,偷拍场景强推天花板镜,80\nlove hotel pink room,heart-shaped bed,strong,情人旅馆强推心形床,75\n'
    };
});

// ========== Lora 库（Phase 1：数据层 + 文件操作 + 工作流辅助）==========
// 入口：loras:list / loras:get / loras:add / loras:update / loras:delete
//       loras:pickFile / loras:pickCover / loras:readCover / loras:setCover / loras:clearCover
//       loras:listByModel / loras:resolveByNames / loras:types
// lorasStore 在 initStore() 里实例化；调用前再判断一次兜底（防止 app.whenReady 之外的边缘调用）
function _ensureLorasStore() {
    if (!lorasStore) {
        lorasStore = new LorasStore({ store, getAssetsDir, getComfyConfig, getCoversDir });
    }
    return lorasStore;
}

ipcMain.handle('loras:list', async (_e, filter) => {
    try {
        return { ok: true, loras: _ensureLorasStore().listLoras(filter || {}) };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:get', async (_e, id) => {
    try {
        const lora = _ensureLorasStore().getLora(Number(id));
        if (!lora) return { ok: false, error: `lora id=${id} 不存在` };
        return { ok: true, lora };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:add', async (_e, payload) => {
    try {
        if (!payload || !payload.srcPath) return { ok: false, error: 'srcPath 必填' };
        // 不再注入 createLink — 用 loras-store 默认的 createLinkElevated。
        // app 启动期已一次性 UAC 提权（ensureElevated），cmd.exe /c mklink 直接走，无需再次弹框。
        const lora = await _ensureLorasStore().addLora({
            meta: payload.meta || {},
            srcPath: payload.srcPath,
        });
        return { ok: true, lora };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:update', async (_e, payload) => {
    try {
        if (!payload || !payload.id) return { ok: false, error: 'id 必填' };
        const lora = _ensureLorasStore().updateLora(Number(payload.id), payload.patch || {});
        return { ok: true, lora };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:delete', async (_e, id) => {
    try {
        return _ensureLorasStore().deleteLora(Number(id));
    } catch (e) { return { ok: false, error: e.message }; }
});

// 选 Lora 文件（renderer 不直接碰 dialog，全走主进程）
ipcMain.handle('loras:pickFile', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: '选择 Lora 文件',
            filters: [
                { name: 'Lora 模型', extensions: ['safetensors', 'pt', 'pth', 'ckpt', 'bin'] },
                { name: '全部文件', extensions: ['*'] },
            ],
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        const srcPath = r.filePaths[0];
        const stat = fs.statSync(srcPath);
        return {
            ok: true,
            path: srcPath,
            name: path.basename(srcPath),
            size: stat.size,
        };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:pickCover', async () => {
    try {
        const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: '选择封面图',
            filters: [
                { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
                { name: '全部文件', extensions: ['*'] },
            ],
        });
        if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
        const srcPath = r.filePaths[0];
        return { ok: true, path: srcPath, name: path.basename(srcPath) };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 显式设封面图（从已知 srcPath 拷贝到 assets/loras/covers/<id>.<ext>）
ipcMain.handle('loras:setCover', async (_e, payload) => {
    try {
        if (!payload || !payload.id || !payload.srcPath) return { ok: false, error: 'id/srcPath 必填' };
        const lora = _ensureLorasStore().setCoverImage(Number(payload.id), payload.srcPath);
        return { ok: true, lora };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('loras:clearCover', async (_e, id) => {
    try {
        const lora = _ensureLorasStore().clearCoverImage(Number(id));
        return { ok: true, lora };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 返回 cover 的 file:// URL（renderer 用 <img src> 直接加载）
ipcMain.handle('loras:readCover', async (_e, id) => {
    try {
        const url = _ensureLorasStore().readCover(Number(id));
        return { ok: true, url };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 按工作流模型 basename 筛选兼容 Lora（comfy:lora picker 用）
ipcMain.handle('loras:listByModel', async (_e, modelBasename) => {
    try {
        return { ok: true, loras: _ensureLorasStore().listCompatibleLoras(modelBasename || '') };
    } catch (e) { return { ok: false, error: e.message }; }
});

// workflow 完成后反查本次用到的 Lora id（autoSaveAsset 用）
ipcMain.handle('loras:resolveByNames', async (_e, basenames) => {
    try {
        return { ok: true, items: _ensureLorasStore().resolveByNames(basenames || []) };
    } catch (e) { return { ok: false, error: e.message }; }
});

// 返回 lora_type 枚举（前端新建/筛选下拉用）
ipcMain.handle('loras:types', async () => {
    try {
        return { ok: true, types: require('./loras-store').LORA_TYPES };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
// D-NSFW-A/C: NSFW 模板导入 IPC（向导用）
// ============================================================
//
// 设计：
//   - 旧版 IPC 用 name 作为关联键（prompt_items.name），新 IPC 用 id
//   - 因为新版本可能存在多个同名 item（aliases），所以 item 级关联直接传 id
//   - 导入器在 wizard 拿到 prepared list 后，调用 importAllSteps 一次性写入
//   - categories 用 prepareCategories 预解析 + lookupMenuId 提供 id 映射

// 工具：把 "a,b,c" 形式的字符串转成 id 数组（filter 掉不存在的）
function _resolveIdsByName(nameOrIdList) {
    const out = [];
    for (const x of (nameOrIdList || [])) {
        if (typeof x === 'number') {
            const row = store.query('SELECT id FROM prompt_items WHERE id = ?', x);
            if (row.length) out.push(row[0].id);
        } else {
            const row = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(x));
            if (row.length) out.push(row[0].id);
        }
    }
    return out;
}

// 工具：按 name 数组列出已存在的 item ids（用于 dedup 报告）
ipcMain.handle('prompt:item:findDuplicates', async (_e, payload) => {
    try {
        const names = (payload && payload.names) || [];
        if (!Array.isArray(names) || !names.length) return { ok: false, error: 'names 不能为空' };
        const dupes = [];
        for (const n of names) {
            const rows = store.query('SELECT id, name, category_id FROM prompt_items WHERE name = ?', String(n));
            if (rows.length > 1) {
                dupes.push({ name: n, ids: rows });
            }
        }
        return { ok: true, duplicates: dupes };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 工具：把 srcIds 的引用合并到 targetId（content/description 取 target 的；aliases 取并集；删除 srcIds）
ipcMain.handle('prompt:item:merge', async (_e, payload) => {
    try {
        const targetId = Number(payload && payload.target_id);
        const srcIds = (payload && payload.src_ids || []).map(Number).filter(n => n && n !== targetId);
        if (!targetId || !srcIds.length) return { ok: false, error: '需要 target_id 与 src_ids' };
        const targetRow = store.query('SELECT * FROM prompt_items WHERE id = ?', targetId);
        if (!targetRow.length) return { ok: false, error: `target id=${targetId} 不存在` };
        const target = targetRow[0];
        // 收集 src aliases
        let aliases = [];
        try { aliases = JSON.parse(target.aliases || '[]'); } catch {}
        for (const sid of srcIds) {
            const sr = store.query('SELECT id, aliases FROM prompt_items WHERE id = ?', sid);
            if (!sr.length) continue;
            try {
                const a = JSON.parse(sr[0].aliases || '[]');
                for (const x of a) if (!aliases.includes(x)) aliases.push(x);
            } catch {}
            // 删除 src 行（关联表的 a/b 引用也删除）
            store.exec('DELETE FROM prompt_associations WHERE prompt_a_id = ? OR prompt_b_id = ?', sid, sid);
            store.exec('DELETE FROM prompt_items WHERE id = ?', sid);
        }
        // 写回 target.aliases
        store.exec('UPDATE prompt_items SET aliases = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?',
            JSON.stringify(aliases), targetId);
        return { ok: true, target_id: targetId, src_deleted: srcIds, aliases };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 关联预检：检查 associations-preview JSON 里所有 a/b 是否能命中 items
ipcMain.handle('prompt:association:previewImport', async (_e, payload) => {
    try {
        const assocs = (payload && payload.associations) || [];
        if (!Array.isArray(assocs)) return { ok: false, error: 'associations 应为数组' };
        const ready = [];
        const missing = [];
        const seen = new Set();
        for (const a of assocs) {
            const aRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(a.a || ''));
            const bRow = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(a.b || ''));
            const aId = aRow.length ? aRow[0].id : null;
            const bId = bRow.length ? bRow[0].id : null;
            const k = (a.type || 'exclusive') + '|' + (a.source || '') + '|' + aId + '||' + bId;
            if (seen.has(k)) continue;
            seen.add(k);
            if (aId && bId && aId !== bId) ready.push({ ...a, aId, bId });
            else missing.push({ ...a, missingA: !aId, missingB: !bId });
        }
        return { ok: true, ready, missing, ready_count: ready.length, missing_count: missing.length };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// prompt_examples 列表（带可选 category 过滤）
ipcMain.handle('prompt:example:list', async (_e, payload) => {
    try {
        const categoryId = payload && payload.category_id;
        let rows;
        if (categoryId) {
            rows = store.query('SELECT * FROM prompt_examples WHERE category_id = ? ORDER BY id', Number(categoryId));
        } else {
            rows = store.query('SELECT * FROM prompt_examples ORDER BY id');
        }
        // 解析 keywords JSON
        for (const r of rows) {
            try { r.keywords = JSON.parse(r.keywords || '[]'); } catch { r.keywords = []; }
        }
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// prompt_examples 批量导入
ipcMain.handle('prompt:example:import', async (_e, payload) => {
    try {
        const list = (payload && payload.examples) || [];
        if (!Array.isArray(list) || !list.length) return { ok: false, error: 'examples 为空' };
        let imported = 0, skipped = 0;
        for (const ex of list) {
            const english = String(ex.english_content || '').trim();
            const title = String(ex.title || '').trim();
            if (!english || !title) { skipped++; continue; }
            const keywords = Array.isArray(ex.keywords) ? JSON.stringify(ex.keywords) : (ex.keywords || '[]');
            store.exec(`INSERT INTO prompt_examples
                (category_id, title, english_content, chinese_description, style, keywords, source)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                ex.category_id || null, title, english,
                ex.chinese_description || '',
                ex.style || '',
                keywords,
                ex.source || 'md-import-00');
            imported++;
        }
        return { ok: true, imported, skipped };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// prompt_import_history 列表
ipcMain.handle('prompt:importHistory:list', async () => {
    try {
        const rows = store.query('SELECT * FROM prompt_import_history ORDER BY imported_at DESC LIMIT 50');
        for (const r of rows) {
            try { r.config_json = JSON.parse(r.config_json || '{}'); } catch { r.config_json = {}; }
        }
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// prompt_import_history 写入一条
ipcMain.handle('prompt:importHistory:add', async (_e, payload) => {
    try {
        const p = payload || {};
        const cfg = typeof p.config_json === 'string' ? p.config_json : JSON.stringify(p.config_json || {});
        store.exec(`INSERT INTO prompt_import_history
            (source, version, categories_created, categories_skipped, items_created, items_updated, items_skipped, associations_created, examples_imported, duration_ms, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            p.source || 'manual',
            p.version || '',
            Number(p.categories_created) || 0,
            Number(p.categories_skipped) || 0,
            Number(p.items_created) || 0,
            Number(p.items_updated) || 0,
            Number(p.items_skipped) || 0,
            Number(p.associations_created) || 0,
            Number(p.examples_imported) || 0,
            Number(p.duration_ms) || 0,
            cfg);
        const id = store.query('SELECT last_insert_rowid() AS id')[0].id;
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 一站式 NSFW 导入（向导执行时调用）
// payload: {
//   categories: [{path,name,title,description,parent_code,level,module,module_code,is_required,exclusive_group}],
//   items: [{phrase,category_path,module,sensitivity,description,aliases}],
//   associations: [{type,a,b,weight,source,reason}],
//   examples: [{title,english_content,chinese_description,keywords}],
//   config: {batch:1, ...}
// }
ipcMain.handle('prompt:nsfwImport:execute', async (_e, payload) => {
    try {
        const p = payload || {};
        const startMs = Date.now();
        const stats = {
            categories_created: 0, categories_skipped: 0,
            items_created: 0, items_updated: 0, items_skipped: 0,
            associations_created: 0, examples_imported: 0,
        };

        // 1. categories: 按层次插入（先根后子，用 name 匹配避免重复）
        //   path 形如 "00-范例" / "00-范例 / 完整 Prompt 范例" 等
        const categories = Array.isArray(p.categories) ? p.categories : [];
        const pathToId = new Map();   // path → id

        // 先按 level 排序：根先入（level=1）
        const sortedCats = categories.slice().sort((x, y) => (x.level || 1) - (y.level || 1));
        for (const c of sortedCats) {
            const path = String(c.path || c.name || '').trim();
            const name = String(c.name || path).trim();
            if (!path) continue;
            // 查是否已存在（按 name + parent_id + 模块路径精确匹配）
            const parentId = pathToId.get(deriveParentPath(path)) || 0;
            const existRow = store.query(
                'SELECT id FROM prompt_menu WHERE category_name = ? AND (parent_id = ? OR (parent_id = 0 AND ? = 0))',
                name, parentId, parentId
            );
            if (existRow.length) {
                pathToId.set(path, existRow[0].id);
                stats.categories_skipped++;
                continue;
            }
            const isReq = c.is_required ? 1 : 0;
            const desc = String(c.description || '').slice(0, 4000);
            const r = store.exec(`INSERT INTO prompt_menu
                (category_name, parent_id, description, sort_order, is_required, tag_required, tag_exclusive_group, exclusive_with, exclusive_group)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                name, parentId, desc, 0, isReq,
                String(c.tag_required || ''), String(c.tag_exclusive_group || ''),
                String(c.exclusive_with || ''), String(c.exclusive_group || ''));
            const newId = r.lastInsertRowid;
            // 计算 pid_list
            const pid = parentId === 0 ? '/' : (store.query('SELECT pid_list FROM prompt_menu WHERE id = ?', parentId)[0].pid_list || '/');
            const pidList = pid + newId + '/';
            store.exec('UPDATE prompt_menu SET pid_list = ? WHERE id = ?', pidList, newId);
            pathToId.set(path, newId);
            stats.categories_created++;
        }

        // 2. items: 按 category_path 找到 category_id，name = phrase(content)
        const items = Array.isArray(p.items) ? p.items : [];
        const phraseToId = new Map();   // 内容 → id（用于后续 associations 解析）

        // 把 path → name 映射提出来（path 是从 JSON 来的，可能用「 / 」也可能是「/」）
        const pathNorm = new Map();     // normalizedPath → lookup-path
        for (const path of pathToId.keys()) {
            pathNorm.set(normPath(path), path);
        }

        for (const it of items) {
            const content = String(it.phrase || '').trim();
            if (!content) { stats.items_skipped++; continue; }
            const catPath = normPath(it.category_path || '');
            const lookupPath = pathNorm.get(catPath);
            const catId = lookupPath ? pathToId.get(lookupPath) : null;
            if (!catId) {
                stats.items_skipped++;
                continue;
            }
            // 查重：同 name + 同 category_id 视为同一行（更新 content + aliases）
            const existRow = store.query(
                'SELECT id, aliases FROM prompt_items WHERE name = ? AND category_id = ?',
                content, catId
            );
            const aliases = Array.isArray(it.aliases) ? JSON.stringify(it.aliases) : (it.aliases || '[]');
            const desc = String(it.description || '').slice(0, 4000);
            const sens = String(it.sensitivity || 'nsfw');
            if (existRow.length) {
                store.exec(`UPDATE prompt_items SET content = ?, description = ?, sensitivity = ?,
                    aliases = ?, updated_at = strftime('%s','now') WHERE id = ?`,
                    content, desc, sens, aliases, existRow[0].id);
                phraseToId.set(content, existRow[0].id);
                stats.items_updated++;
                continue;
            }
            const r = store.exec(`INSERT INTO prompt_items
                (category_id, name, content, description, sensitivity, aliases)
                VALUES (?, ?, ?, ?, ?, ?)`,
                catId, content, content, desc, sens, aliases);
            const newId = r.lastInsertRowid;
            phraseToId.set(content, newId);
            stats.items_created++;
        }

        // 3. associations: 按 phrase name 查 id 列表
        const associations = Array.isArray(p.associations) ? p.associations : [];
        for (const a of associations) {
            const aId = phraseToId.get(String(a.a || '')) || (() => {
                const r = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(a.a || ''));
                return r.length ? r[0].id : null;
            })();
            const bId = phraseToId.get(String(a.b || '')) || (() => {
                const r = store.query('SELECT id FROM prompt_items WHERE name = ? LIMIT 1', String(a.b || ''));
                return r.length ? r[0].id : null;
            })();
            if (!aId || !bId || aId === bId) continue;
            const rel = (a.type === 'strong' || a.type === 'weak') ? a.type : 'exclusive';
            const w = Number(a.weight) || 100;
            try {
                store.exec(`INSERT OR IGNORE INTO prompt_associations
                    (prompt_a_id, prompt_b_id, relation, weight, source, reason)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    aId, bId, rel, w,
                    String(a.source || 'md-import').slice(0, 100),
                    String(a.reason || '').slice(0, 4000));
                stats.associations_created++;
            } catch {}
        }

        // 4. examples
        const examples = Array.isArray(p.examples) ? p.examples : [];
        for (const ex of examples) {
            const title = String(ex.title || '').trim();
            const english = String(ex.english_content || '').trim();
            if (!title || !english) continue;
            const keywords = Array.isArray(ex.keywords) ? JSON.stringify(ex.keywords) : (typeof ex.keywords === 'string' ? ex.keywords : '[]');
            store.exec(`INSERT INTO prompt_examples
                (category_id, title, english_content, chinese_description, style, keywords, source)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                null, title, english,
                String(ex.chinese_description || '').slice(0, 4000),
                String(ex.style || '').slice(0, 200),
                keywords,
                String(ex.source || 'md-import-00').slice(0, 100));
            stats.examples_imported++;
        }

        const durationMs = Date.now() - startMs;
        // 5. 写一条 import_history
        const cfg = typeof p.config === 'string' ? p.config : JSON.stringify(p.config || {});
        store.exec(`INSERT INTO prompt_import_history
            (source, version, categories_created, categories_skipped, items_created, items_updated, items_skipped, associations_created, examples_imported, duration_ms, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            'nsfw-asian', String(p.version || 'v3.0'),
            stats.categories_created, stats.categories_skipped,
            stats.items_created, stats.items_updated, stats.items_skipped,
            stats.associations_created, stats.examples_imported,
            durationMs, cfg);

        return { ok: true, stats, duration_ms: durationMs };
    } catch (e) {
        return { ok: false, error: e.message, stack: e.stack };
    }
});

// helpers
function deriveParentPath(path) {
    // 用 normPath 后的 ' / ' 分隔符切，避免 category name 含 '/' 时 lastIndexOf 误判
    const parts = String(path || '').split(' / ').filter(Boolean);
    if (parts.length <= 1) return '';
    return parts.slice(0, -1).join(' / ');
}
function normPath(p) {
    return String(p || '').replace(/\s*\/\s*/g, ' / ').trim();
}

// ========== D-NSFW-D: NSFW 模板导入（parser 触发 + 解析结果回读）==========
// 调用 scripts/parse-nsfw-asian/index.js，把模板库 .md 转成 JSON 后读回前端。
ipcMain.handle('prompt:nsfwImport:runParse', async (_e, payload) => {
    const { spawnSync } = require('child_process');
    const fsp = require('fs');
    const pathMod = require('path');
    try {
        const p = payload || {};
        const srcDir = p.src_dir || pathMod.join('D:', 'nsfw-prompt-templates-asian');
        const outDir = p.out_dir || pathMod.join(__dirname, 'scripts', 'parsed-nsfw-asian');
        const scriptPath = pathMod.join(__dirname, 'scripts', 'parse-nsfw-asian', 'index.js');
        if (!fsp.existsSync(srcDir)) {
            return { ok: false, error: '模板库目录不存在：' + srcDir };
        }
        if (!fsp.existsSync(scriptPath)) {
            return { ok: false, error: '解析脚本不存在：' + scriptPath };
        }
        const t0 = Date.now();
        const res = spawnSync(process.execPath, [scriptPath, srcDir, outDir], {
            encoding: 'utf-8',
            timeout: 180000,
            cwd: pathMod.join(__dirname),
        });
        if (res.status !== 0) {
            return { ok: false, error: 'parser 退出码 ' + res.status + '\n' + (res.stderr || res.stdout || '').slice(-2000) };
        }
        if (!fsp.existsSync(pathMod.join(outDir, 'summary.json'))) {
            return { ok: false, error: 'parser 完成但未产出 summary.json' };
        }
        const summary      = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'summary.json'), 'utf-8'));
        const categories   = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'categories.json'), 'utf-8'));
        const items        = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'items.json'), 'utf-8'));
        const associations = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'associations-preview.json'), 'utf-8'));
        const examples     = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'examples.json'), 'utf-8'));
        const dupReport    = JSON.parse(fsp.readFileSync(pathMod.join(outDir, 'dup-report.json'), 'utf-8'));
        return {
            ok: true,
            src_dir: srcDir,
            out_dir: outDir,
            duration_ms: Date.now() - t0,
            summary,
            categories,
            items,
            associations,
            examples,
            dupReport,
            preview: {
                topRepetitions: (dupReport.top_repetitions || []).slice(0, 20),
                categoryLevels: countByLevel(categories),
                moduleStats: summary.module_stats || [],
            },
        };
    } catch (e) {
        return { ok: false, error: e.message, stack: e.stack };
    }
});

function countByLevel(cats) {
    const m = new Map();
    for (const c of cats) {
        const lv = c.level || 1;
        m.set(lv, (m.get(lv) || 0) + 1);
    }
    return Array.from(m.entries()).map(([level, count]) => ({ level, count })).sort((a, b) => a.level - b.level);
}

// ========== D-SYSINFO：设置页「系统信息」tab 取数 ==========
// 全部用零依赖（os / child_process），不引入 systeminformation 之类 npm 包。
// 单个子项失败只让该字段为 null，不阻断整体；handler 整体包 try/catch。

function _osBytesToHuman(n) {
    if (n == null) return null;
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = num;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function _getOsInfo() {
    const os = require('os');
    const out = {
        platform: os.platform(),       // 'win32' / 'linux' / 'darwin'
        arch: os.arch(),               // 'x64' / 'arm64'
        release: os.release(),         // 内核版本号
        hostname: os.hostname(),
        uptimeSec: Math.floor(os.uptime()),
        distro: null,
        kernel: null,
        error: null,
    };
    if (out.platform === 'win32') {
        // Windows 上 release 是 NT 版本号（如 10.0.26200），distro 用 PowerShell 拿产品名
        out.kernel = out.release;
        try {
            const r = spawnSync('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Command', "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance Win32_OperatingSystem).Caption"
            ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (r.status === 0 && r.stdout) {
                out.distro = String(r.stdout).trim().split(/\r?\n/)[0] || null;
            }
        } catch (_) { /* ignore */ }
    } else if (out.platform === 'linux') {
        try {
            const r = spawnSync('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"'], { encoding: 'utf8', timeout: 3000 });
            if (r.status === 0 && r.stdout) out.distro = String(r.stdout).trim() || null;
        } catch (_) {}
        out.kernel = out.release;
    } else if (out.platform === 'darwin') {
        out.distro = 'macOS';
        out.kernel = out.release;
    }
    return out;
}

function _getCpuInfo() {
    const os = require('os');
    const cpus = os.cpus() || [];
    const first = cpus[0] || {};
    return {
        model: first.model || null,
        brand: first.model || null,
        manufacturer: null,
        cores: cpus.length || null,
        physicalCores: (typeof os.cpus === 'function' && typeof navigator === 'undefined') ? null : null, // Node 没有原生物理核 API，留 null
        speedMHz: first.speed || null,
    };
}

function _getMemoryInfo() {
    const os = require('os');
    const total = os.totalmem();
    const free = os.freemem();
    return {
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
    };
}

// nvidia-smi 一次拿所有 N 卡的显存（MiB → bytes），返回按 GPU index 的数组。
// 不可用时返回空对象。用于覆盖 WMI uint32 溢出。
async function _getNvidiaVramByIndex() {
    const map = {};
    try {
        const r = spawnSync('nvidia-smi', [
            '--query-gpu=index,memory.total',
            '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (r.status === 0 && r.stdout) {
            for (const line of String(r.stdout).split(/\r?\n/)) {
                const m = line.trim().match(/^(\d+),\s*(\d+)/);
                if (m) map[m[1]] = Number(m[2]) * 1024 * 1024;
            }
        }
    } catch (_) {}
    return map;
}

// nvidia-smi 一次拿 name → index 的映射（name 小写化），用于把 WMI 的 AdapterCompatibility 名
// 关联到 nvidia-smi 的 index。多卡同型号 + 多卡名都按 nvidia-smi 顺序匹配；匹配失败返回空 Map。
async function _getNvidiaNameToIndexMap() {
    const map = new Map();
    try {
        const r = spawnSync('nvidia-smi', [
            '--query-gpu=index,name',
            '--format=csv,noheader',
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (r.status === 0 && r.stdout) {
            for (const line of String(r.stdout).split(/\r?\n/)) {
                // "0, NVIDIA GeForce RTX 4070 Ti SUPER"
                const m = line.trim().match(/^(\d+),\s*(.+)$/);
                if (m) map.set(m[2].toLowerCase(), m[1]);
            }
        }
    } catch (_) {}
    return map;
}

// 过滤掉虚拟 / 软件显示适配器（云游戏串流、模拟器、远程桌面、虚拟显卡等）。
// 这些通常没有真实硬件，也不会被 AI 推理用到。
const _VENDOR_HINTS = {
    real: [
        // 真实显卡厂商
        /nvidia/i, /geforce/i, /quadro/i, /tesla/i, /rtx/i, /gtx/i,
        /advanced micro devices/i, /\bamd\b/i, /\bati\b/i, /radeon/i,
        /intel/i, /\bintel\b.*\bcorporation\b/i,
    ],
    fake: [
        // 已知虚拟 / 软件显示的 name / vendor 关键字
        /gameviewer/i, /mumu/i, /网易/i, /netEase/i,
        /parsec/i, /sunshine/i, /moonlight/i, /spacedesk/i,
        /virtualhere/i, /virtualbox/i, /vmware/i, /hyper-v/i, /microsoft basic display/i,
        /microsoft remote display/i, /miracast/i, /teamviewer/i, /anydesk/i,
        /android.*display/i, /redroid/i, /bluestacks/i, /nox/i, /ldplayer/i, /雷电/i,
    ],
};

function _isVirtualAdapter(name, vendor) {
    const hay = `${vendor || ''} ${name || ''}`;
    for (const re of _VENDOR_HINTS.fake) {
        if (re.test(hay)) return true;
    }
    return false;
}

async function _getGpuList() {
    // Windows 优先走 PowerShell (CIM)，失败再回退 wmic。
    // Linux 走 lspci；macOS 走 system_profiler SPDisplaysDataType。
    // 注：Win32_VideoController.AdapterRAM 在 WMI 里是 uint32，超过 4GiB 会溢出归零 / 回卷
    //      → 对 NVIDIA/AMD 独显不靠谱。N 卡统一用 nvidia-smi.memory.total 覆盖。
    const platform = process.platform;
    const out = [];
    if (platform === 'win32') {
        const psScript = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion,AdapterRAM | ConvertTo-Json -Compress";
        let parsed = null;
        try {
            const r = spawnSync('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript,
            ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
            if (r.status === 0 && r.stdout && r.stdout.trim()) {
                parsed = JSON.parse(r.stdout.trim());
            }
        } catch (_) { /* fall through to wmic */ }
        if (!parsed) {
            try {
                const r = spawnSync('wmic', ['path', 'Win32_VideoController', 'get', 'Name,AdapterCompatibility,DriverVersion,AdapterRAM', '/format:list'], {
                    encoding: 'utf8', windowsHide: true, timeout: 8000,
                });
                if (r.status === 0 && r.stdout) {
                    // /format:list 输出是多段 KEY=VALUE，每段之间有空行
                    const blocks = r.stdout.split(/\r?\n\r?\n/);
                    const items = [];
                    for (const blk of blocks) {
                        if (!blk.trim()) continue;
                        const obj = {};
                        for (const line of blk.split(/\r?\n/)) {
                            const m = line.match(/^([^=]+)=(.*)$/);
                            if (m) obj[m[1].trim()] = m[2].trim();
                        }
                        if (obj.Name) items.push(obj);
                    }
                    if (items.length) parsed = items;
                }
            } catch (_) {}
        }
        // nvidia-smi 一次拿齐所有 N 卡的显存（按 GPU index）
        const nvidiaVramByIndex = await _getNvidiaVramByIndex();
        const nvidiaByName = await _getNvidiaNameToIndexMap();
        const parseGpu = (it) => {
            const ramRaw = it.AdapterRAM == null ? null : Number(it.AdapterRAM);
            // WMI uint32 溢出判定：<= 0 或不在合理范围（> 64 GiB 也判为异常）
            let vram = Number.isFinite(ramRaw) && ramRaw > 0 && ramRaw <= 64 * 1024 ** 3 ? ramRaw : null;
            const vendor = it.AdapterCompatibility || null;
            const name = it.Name || null;
            // 过滤掉虚拟 / 软件显示适配器（云游戏、模拟器、远程桌面等）
            if (_isVirtualAdapter(name, vendor)) return null;
            // NVIDIA 独显：用 nvidia-smi 覆盖
            if (vendor && /nvidia/i.test(String(vendor)) && name && nvidiaByName) {
                const idx = nvidiaByName.get(String(name).toLowerCase());
                if (idx != null && nvidiaVramByIndex[idx] != null) vram = nvidiaVramByIndex[idx];
            }
            return {
                vendor,
                model: name,
                vramBytes: vram,
                driverVersion: it.DriverVersion || null,
            };
        };
        if (Array.isArray(parsed)) {
            for (const it of parsed) {
                const g = parseGpu(it);
                if (g) out.push(g);
            }
        } else if (parsed && typeof parsed === 'object') {
            // 单卡时 ConvertTo-Json 返回的是对象而非数组
            const g = parseGpu(parsed);
            if (g) out.push(g);
        }
    } else if (platform === 'linux') {
        try {
            const r = spawnSync('sh', ['-c', 'lspci -mm 2>/dev/null | grep -i "VGA\\|3D\\|Display"'], { encoding: 'utf8', timeout: 5000 });
            if (r.status === 0 && r.stdout) {
                for (const line of String(r.stdout).split(/\r?\n/)) {
                    // 格式：XX:YY.Z "Vendor" "Device" "VGA compatible controller"
                    const m = line.match(/^[\w:.]+\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/);
                    if (m) {
                        out.push({ vendor: m[1], model: m[2], vramBytes: null, driverVersion: null, bus: m[3] });
                    }
                }
            }
        } catch (_) {}
    } else if (platform === 'darwin') {
        try {
            const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], { encoding: 'utf8', timeout: 8000 });
            if (r.status === 0 && r.stdout) {
                const j = JSON.parse(r.stdout);
                const arr = j && j.SPDisplaysDataType;
                if (Array.isArray(arr)) {
                    for (const it of arr) {
                        out.push({
                            vendor: it.SPVendor || it.vendor || null,
                            model: it.sppci_model || it.model || it._name || null,
                            vramBytes: it.spuram_size ? Number(String(it.spuram_size).replace(/[^0-9]/g, '')) * 1024 * 1024 : null,
                            driverVersion: it.spdisplays_vendor || null,
                        });
                    }
                }
            }
        } catch (_) {}
    }
    return out;
}

async function _getCudaInfo() {
    // nvidia-smi 是最权威的入口；没有就 available=false
    const out = { available: false, driverVersion: null, cudaVersion: null, nvccPath: null, error: null };
    try {
        // 1) 拿 CUDA driver 版本 + CUDA runtime 版本
        const r = spawnSync('nvidia-smi', [
            '--query-gpu=driver_version',
            '--format=csv,noheader,nounits',
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (r.status === 0 && r.stdout && r.stdout.trim()) {
            out.available = true;
            out.driverVersion = String(r.stdout).trim().split(/\r?\n/)[0] || null;
        }
        if (out.available) {
            const v = spawnSync('nvidia-smi', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (v.status === 0 && v.stdout) {
                const m = String(v.stdout).match(/CUDA Version\s*[:：]?\s*(\S+)/i);
                if (m) out.cudaVersion = m[1];
            }
        }
        // 2) 找 nvcc（不一定在 PATH，但常在 cuda 安装目录）
        const w = spawnSync('where', ['nvcc'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        if (w.status === 0 && w.stdout) {
            const first = String(w.stdout).trim().split(/\r?\n/)[0];
            if (first) out.nvccPath = first;
        } else if (process.platform !== 'win32') {
            const w2 = spawnSync('sh', ['-c', 'command -v nvcc 2>/dev/null'], { encoding: 'utf8', timeout: 3000 });
            if (w2.status === 0 && w2.stdout) out.nvccPath = String(w2.stdout).trim();
        }
        if (out.nvccPath && !out.cudaVersion) {
            // nvcc --version 拿 CUDA 工具链版本
            const nv = spawnSync('nvcc', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            if (nv.status === 0 && nv.stdout) {
                const m = String(nv.stdout).match(/release\s+(\d+\.\d+)/i);
                if (m) out.cudaVersion = m[1];
            }
        }
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

// 通用工具检测：versionArgs 是跑 `--version` 用的参数；versionRegex 从 stdout 抽版本号。
function _detectTool(cmd, versionArgs, versionRegex) {
    const out = { available: false, version: null, path: null, error: null };
    try {
        // 先 where / which 找可执行文件路径
        let whereRes;
        if (process.platform === 'win32') {
            whereRes = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        } else {
            whereRes = spawnSync('sh', ['-c', `command -v ${cmd} 2>/dev/null`], { encoding: 'utf8', timeout: 3000 });
        }
        if (whereRes.status === 0 && whereRes.stdout) {
            const p = String(whereRes.stdout).trim().split(/\r?\n/)[0];
            if (p) out.path = p;
        }
        // 再跑 --version
        const args = Array.isArray(versionArgs) ? versionArgs : ['--version'];
        const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (r.status === 0 && r.stdout) {
            out.available = true;
            if (versionRegex instanceof RegExp) {
                const m = String(r.stdout).match(versionRegex);
                if (m && m[1]) out.version = m[1];
            }
            if (!out.version) {
                // 没匹配上就用第一行非空文本兜底
                const firstLine = String(r.stdout).trim().split(/\r?\n/).find(l => l.trim());
                if (firstLine) out.version = firstLine.slice(0, 80);
            }
        } else if (out.path) {
            // 找到了可执行文件但 --version 失败（极少数），仍记 available=true
            out.available = true;
        }
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

async function _getToolsInfo() {
    return {
        git:    _detectTool('git',    ['--version'],        /git version (\S+)/i),
        python: _detectTool('python', ['--version'],        /Python (\d+\.\d+\.\d+)/i),
        node:   _detectTool('node',   ['--version'],        /^v(\d+\.\d+\.\d+)/),
        npm:    _detectTool('npm',    ['--version'],        /(\d+\.\d+\.\d+)/),
        ffmpeg: _detectTool('ffmpeg', ['-version'],         /ffmpeg version (\S+)/i),
    };
}

async function collectSystemInfo() {
    // 8s 整体硬超时：任何一个子项卡住不阻塞整体
    const HARD_TIMEOUT_MS = 8000;
    const timer = new Promise(resolve => setTimeout(() => resolve({ __timeout: true }), HARD_TIMEOUT_MS));
    const work = (async () => {
        const [os, cpu, memory, gpus, cuda, tools] = await Promise.all([
            _getOsInfo(),
            Promise.resolve(_getCpuInfo()),
            Promise.resolve(_getMemoryInfo()),
            _getGpuList(),
            _getCudaInfo(),
            _getToolsInfo(),
        ]);
        return { os, cpu, memory, gpus, cuda, tools };
    })();
    const result = await Promise.race([work, timer]);
    if (result && result.__timeout) {
        // 整体超时：返回空壳但仍能渲染已就绪的字段。这里直接复用 work 的已完成部分
        // （work 还在后台跑，但 Promise.race 已经解了）；为简单起见，返回空标识让前端显示「刷新」
        return { __timeout: true };
    }
    return result;
}

ipcMain.handle('systeminfo:get', async () => {
    try {
        const data = await collectSystemInfo();
        if (data && data.__timeout) {
            return { ok: false, error: '系统信息采集整体超时，请稍后重试' };
        }
        // 进程级静态信息放这里，不让渲染器依赖 process.versions
        const env = {
            electron: app.getVersion(),
            node: process.versions.node || null,
            chrome: process.versions.chrome || null,
            v8: process.versions.v8 || null,
            electronRenderer: process.versions.electron || null,
        };
        return { ok: true, data: { ...data, env } };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// =====================================================================
// D-QUEUE：任务队列（透明接管 tools:run 提交，串行执行 ComfyUI 任务）
//   - 入队 = 写 pending 行 → 立刻返回 queueId（前端感知不到队列存在）
//   - _qTick() 拉 top pending → 调 comfyuiWs.startJob → 监听 complete/error/close
//   - 所有状态持久化到 task_queue 表；启动时残留 pending 会自动继续
//   - 推送 taskQueue:event:update 事件供 drawer / 角标 / workbench 共同消费
// =====================================================================

const _q = {
    items: new Map(),       // queueId → { row, handle? }（handle 是 comfyuiWs 返回的 cancel/ee）
    current: null,          // queueId（当前 running 的），null 表示空闲
    subscribers: new Set(), // 事件订阅，回调签名 (payload) => void
    tickScheduled: false,   // 防止重复 scheduleTick
};

// ---------- 事件分发 ----------
function _qBroadcast(payload) {
    // 1) 主进程 → renderer（drawer / workbench / 角标都能订阅）
    try { notifyRenderer('taskQueue:event:update', payload); } catch (e) { /* sender 未就绪 */ }
    // 2) 也推一份给本进程内的订阅者（如果以后 main 内部有需要）
    for (const cb of _q.subscribers) {
        try { cb(payload); } catch (e) { console.warn('[task-queue] subscriber err:', e.message); }
    }
}

// 内存里的对应行（如果还没缓存就现拉一次）
function _qFindRow(queueId) {
    const cached = _q.items.get(queueId);
    if (cached) return cached.row;
    const rows = store.query(`SELECT * FROM task_queue WHERE queue_id = ?`, queueId);
    return rows[0] || null;
}

// 把内存里的 row 同步回 DB
function _qUpdateRow(queueId, patch) {
    const keys = Object.keys(patch || {});
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => patch[k]);
    store.exec(
        `UPDATE task_queue SET ${sets} WHERE queue_id = ?`,
        ...values, queueId
    );
    // 同步内存缓存
    const cached = _q.items.get(queueId);
    if (cached) Object.assign(cached.row, patch);
}

// ---------- 计算 pending 排队位置 ----------
function _qPositionOf(queueId) {
    const rows = store.query(
        `SELECT queue_id FROM task_queue WHERE status='pending' ORDER BY position ASC, id ASC`
    );
    return rows.findIndex(r => r.queue_id === queueId); // -1 表示不在 pending
}

// 推进 pending 的 position：把所有 pending 的 position 写成当前顺序 0,1,2,...
function _qCompactPendingPositions() {
    const rows = store.query(
        `SELECT queue_id FROM task_queue WHERE status='pending' ORDER BY position ASC, id ASC`
    );
    rows.forEach((r, i) => {
        store.exec(`UPDATE task_queue SET position=? WHERE queue_id=?`, i, r.queue_id);
    });
}

// 兜底工具：path.join 但忽略参数为 null/undefined 的项
function pathJoinSafe(...args) {
    return path.join(...args.filter(x => x !== null && x !== undefined && x !== ''));
}

// ---------- 提交新任务 ----------
function enqueueTask({ toolId, formValues }) {
    try {
        if (!toolId) return { ok: false, error: 'toolId 必填' };
        const schema = comfyuiToolStore.getTool(toolId);
        if (!schema) return { ok: false, error: `工具 ${toolId} 不存在` };
        const wfr = comfyuiToolStore.getWorkflow(toolId);
        if (!wfr.ok) return { ok: false, error: wfr.error };
        const ar = comfyuiApplier.applyFormToWorkflow(wfr.workflow, schema, formValues, {
            loraLookup: (id) => {
                if (!id) return null;
                try {
                    const l = _ensureLorasStore().getLora(Number(id));
                    if (!l) return null;
                    return { basename: l.name, weight: l.recommended_weight };
                } catch (e) { return null; }
            },
        });
        if (!ar.ok) return { ok: false, error: ar.error, warnings: ar.warnings };

        // 选一个 position（放在当前最大值之后）
        const maxPosRow = store.query(
            `SELECT COALESCE(MAX(position), -1) AS p FROM task_queue WHERE status='pending'`
        );
        const position = (maxPosRow[0] && maxPosRow[0].p + 1) || 0;

        const queueId = (crypto.randomUUID && crypto.randomUUID()) ||
            (`q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

        const toolLabel = schema.label || schema.name || toolId;
        store.exec(
            `INSERT INTO task_queue
             (queue_id, tool_id, tool_label, form_values, workflow_json, status, position, enqueued_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, strftime('%s','now'))`,
            queueId,
            toolId,
            String(toolLabel).slice(0, 200),
            JSON.stringify(formValues || {}),
            JSON.stringify(ar.workflow || {}),
            position
        );
        const row = store.query(`SELECT * FROM task_queue WHERE queue_id = ?`, queueId)[0];
        _q.items.set(queueId, { row, handle: null });
        // D-MID-AUTO-MATCH-FIX：'added' 事件补顶层 queueId，
        // 否则 renderer 监听器里 `if (!ev.queueId) return` 会把这条事件吃掉，
        // midTasksByJobId 永远不更新 → 自动匹配永远命中不到
        _qBroadcast({ type: 'added', queueId, task: row });
        _qScheduleTick();
        return { ok: true, queueId, position, warnings: ar.warnings };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------- 引擎推进 ----------
function _qScheduleTick() {
    if (_q.tickScheduled) return;
    _q.tickScheduled = true;
    setImmediate(() => {
        _q.tickScheduled = false;
        _qTick();
    });
}

async function _qTick() {
    if (_q.current) return; // 已在跑
    const rows = store.query(
        `SELECT * FROM task_queue WHERE status='pending' ORDER BY position ASC, id ASC LIMIT 1`
    );
    const row = rows[0];
    if (!row) return;
    const queueId = row.queue_id;
    _q.current = queueId;

    // 确保 ComfyUI 已就绪
    if (!COMFYUI_STATUS.running) {
        let sr;
        try {
            const cfg = getComfyConfig();
            sr = await comfyuiProcess.startService(cfg);
        } catch (e) {
            sr = { ok: false, error: e.message };
        }
        if (!sr || !sr.ok) {
            const msg = (sr && sr.error) || 'ComfyUI 启动失败';
            _qUpdateRow(queueId, {
                status: 'failed',
                error_msg: msg,
                started_at: Math.floor(Date.now() / 1000),
                finished_at: Math.floor(Date.now() / 1000),
            });
            _q.current = null;
            _qBroadcast({ type: 'status', queueId, status: 'failed', error_msg: msg });
            // 等一拍再试，避免忙循环
            setTimeout(() => _qScheduleTick(), 1500);
            return;
        }
    }

    const startedAt = Math.floor(Date.now() / 1000);
    try {
        const cfg = getComfyConfig();
        const port = COMFYUI_STATUS.port;
        const clientId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const workflowJson = JSON.parse(row.workflow_json || '{}');
        const schema = comfyuiToolStore.getTool(row.tool_id);
        const handle = comfyuiWs.startJob({
            port,
            workflowJson,
            clientId,
            mode: schema ? (schema.mode || 'sfw') : 'sfw',
            timeoutMs: cfg.jobTimeoutMs,
            preferredNodeIds: (schema && schema.outputNodes ? schema.outputNodes : []).map(n => n.nodeId),
            outputNodes: (schema && schema.outputNodes) || [],
        });
        const cached = _q.items.get(queueId) || { row };
        cached.handle = handle;
        _q.items.set(queueId, cached);

        let settled = false;
        const onSettle = (finalStatus, extra = {}) => {
            if (settled) return;
            settled = true;
            if (_q.current === queueId) _q.current = null;
            const finishedAt = Math.floor(Date.now() / 1000);
            const patch = {
                status: finalStatus,
                finished_at: finishedAt,
                ...extra,
            };
            _qUpdateRow(queueId, patch);
            _qBroadcast({ type: 'status', queueId, status: finalStatus, ...extra });
            if (finalStatus === 'done') {
                _qBroadcast({ type: 'result', queueId, ...extra });
            }
            _qCompactPendingPositions();
            _qScheduleTick();
        };

        handle.ee.once('error', (ev) => {
            onSettle('failed', { error_msg: ev.message || `提交失败 (${ev.code || ''})` });
        });
        handle.ee.once('complete', (ev) => {
            const resultPatch = {
                result_mime: ev.mime || (ev.kind === 'text' ? 'text/plain' : null),
                result_size: (ev.meta && ev.meta.fileSize) || null,
            };
            if (ev.kind === 'text') {
                resultPatch.result_text = ev.text || '';
                resultPatch.result_path = null;
            } else {
                resultPatch.result_path = ev.dataUrl || null;
                resultPatch.result_text = null;
            }
            onSettle('done', resultPatch);
        });
        handle.ee.once('close', () => {
            // 兜底：complete/error 都没触发。
            // 但若行已经被外部 cancel 直接写成 cancelled，不能再覆盖回 failed。
            if (settled) return;
            const cur = _qFindRow(queueId);
            if (cur && cur.status === 'cancelled') { settled = true; return; }
            onSettle('failed', { error_msg: 'ComfyUI 任务异常关闭' });
        });

        // started 事件 → 落 running 状态 + 写 prompt_id
        handle.ee.once('started', (ev) => {
            _qUpdateRow(queueId, {
                status: 'running',
                started_at: startedAt,
                prompt_id: ev.promptId || null,
                comfy_job_id: ev.jobId || null,
            });
            _qBroadcast({ type: 'status', queueId, status: 'running', prompt_id: ev.promptId });
        });

        // 进度转发
        handle.ee.on('progress', (ev) => {
            _qBroadcast({ type: 'progress', queueId, value: ev.value || 0, max: ev.max || 0 });
        });
    } catch (e) {
        const msg = e && e.message || String(e);
        _qUpdateRow(queueId, {
            status: 'failed',
            started_at: startedAt,
            finished_at: startedAt,
            error_msg: msg,
        });
        _q.current = null;
        _qBroadcast({ type: 'status', queueId, status: 'failed', error_msg: msg });
        _qScheduleTick();
    }
}

// ---------- 取消 / 移除 / 重排 ----------
function cancelTask(queueId) {
    const cached = _q.items.get(queueId);
    const row = _qFindRow(queueId);
    if (!row) return { ok: false, error: '任务不存在' };
    if (row.status === 'pending') {
        const finishedAt = Math.floor(Date.now() / 1000);
        _qUpdateRow(queueId, {
            status: 'cancelled',
            finished_at: finishedAt,
            error_msg: '用户取消（未开始）',
        });
        _qBroadcast({ type: 'status', queueId, status: 'cancelled' });
        _qCompactPendingPositions();
        _qScheduleTick();
        return { ok: true };
    }
    if (row.status === 'running') {
        try {
            if (cached && cached.handle && cached.handle.cancel) {
                cached.handle.cancel('user cancel');
            } else {
                const jobRow = COMFYUI_JOBS.get(row.comfy_job_id || '');
                if (jobRow && jobRow.ac) jobRow.ac.abort('user cancel');
            }
        } catch {}
        const finishedAt = Math.floor(Date.now() / 1000);
        _qUpdateRow(queueId, {
            status: 'cancelled',
            finished_at: finishedAt,
            error_msg: '用户取消',
        });
        if (_q.current === queueId) _q.current = null;
        _qBroadcast({ type: 'status', queueId, status: 'cancelled' });
        _qCompactPendingPositions();
        _qScheduleTick();
        return { ok: true };
    }
    return { ok: false, error: `当前状态（${row.status}）不可取消` };
}

function removeTask(queueId) {
    const row = _qFindRow(queueId);
    if (!row) return { ok: false, error: '任务不存在' };
    if (!['done', 'failed', 'cancelled'].includes(row.status)) {
        return { ok: false, error: '仅终态任务可删除' };
    }
    store.exec(`DELETE FROM task_queue WHERE queue_id = ?`, queueId);
    _q.items.delete(queueId);
    _qBroadcast({ type: 'removed', queueId });
    return { ok: true };
}

function reorderTask(queueId, targetQueueId) {
    if (queueId === targetQueueId) return { ok: true, noop: true };
    const from = _qFindRow(queueId);
    const to = _qFindRow(targetQueueId);
    if (!from || !to) return { ok: false, error: '任务不存在' };
    if (from.status !== 'pending' || to.status !== 'pending') {
        return { ok: false, error: '仅 pending 间可拖拽' };
    }
    const fromPos = from.position;
    const toPos = to.position;
    _qUpdateRow(queueId, { position: toPos });
    _qUpdateRow(targetQueueId, { position: fromPos });
    _qCompactPendingPositions();
    _qBroadcast({ type: 'reordered', queueId });
    _qBroadcast({ type: 'reordered', queueId: targetQueueId });
    return { ok: true };
}

// 启动时拉已存在的非终态行进 _q.items 缓存
function _qLoadOnStartup() {
    const rows = store.query(
        `SELECT * FROM task_queue WHERE status IN ('pending','running')`
    );
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
        if (row.status === 'running') {
            // 重启前是 running → 已无法恢复 comfyui 端进度，归为 failed 让下一条顶上去
            _qUpdateRow(row.queue_id, {
                status: 'failed',
                finished_at: now,
                error_msg: 'app 重启，任务被中断',
            });
        }
        _q.items.set(row.queue_id, { row, handle: null });
    }
    _qCompactPendingPositions();
    _qScheduleTick();
}

// ---------- IPC ==========
ipcMain.handle('taskQueue:enqueue', async (_e, payload) => {
    return enqueueTask(payload || {});
});

ipcMain.handle('taskQueue:list', async (_e, opts) => {
    try {
        const limit = (opts && opts.limit) || 500;
        if (opts && opts.countOnly) {
            const r = store.query(
                `SELECT
                    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
                    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
                  FROM task_queue`
            );
            const s = r[0] || {};
            const o = {
                total: (Number(s.pending) || 0) + (Number(s.running) || 0) +
                       (Number(s.done) || 0) + (Number(s.failed) || 0) + (Number(s.cancelled) || 0),
                pending: Number(s.pending) || 0,
                running: Number(s.running) || 0,
                done: Number(s.done) || 0,
                failed: Number(s.failed) || 0,
                cancelled: Number(s.cancelled) || 0,
            };
            return { ok: true, counts: o };
        }
        const rows = store.query(
            // 不返回 result_path / result_text —— 这俩字段在 image 任务上是 base64 data URL
            // （动辄几百 KB ~ 几 MB），大量 done 任务时 IPC payload 会很重。
            // 前端需要缩略图时通过 taskQueue:result:readAsDataUrl 按需拉。
            // D-MID-AUTO-MATCH：返回 form_values（KB 级，几百条任务共几 MB，可以接受），
            // 工作台用它做「当前 tool + form 是否匹配某条 done 任务」的检测。
            `SELECT id, queue_id, tool_id, tool_label, status, position, error_msg,
                    form_values,
                    result_mime, result_size, enqueued_at, started_at, finished_at,
                    prompt_id, comfy_job_id,
                    (result_path IS NOT NULL) AS has_result_path,
                    (result_text IS NOT NULL) AS has_result_text
               FROM task_queue ORDER BY enqueued_at DESC LIMIT ?`,
            limit
        );
        return { ok: true, items: rows };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('taskQueue:cancel', async (_e, queueId) => {
    return cancelTask(String(queueId || ''));
});

ipcMain.handle('taskQueue:remove', async (_e, queueId) => {
    return removeTask(String(queueId || ''));
});

ipcMain.handle('taskQueue:reorder', async (_e, payload) => {
    try {
        const fromId = payload && payload.from;
        const toId = payload && payload.to;
        return reorderTask(String(fromId || ''), String(toId || ''));
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('taskQueue:result:readAsDataUrl', async (_e, queueId) => {
    try {
        const row = _qFindRow(String(queueId || ''));
        if (!row) return { ok: false, error: '任务不存在' };
        const rpath = row.result_path;
        if (rpath && /^data:/i.test(rpath)) {
            return { ok: true, dataUrl: rpath, mime: row.result_mime || 'image/png' };
        }
        if (row.result_text) {
            return { ok: true, kind: 'text', text: row.result_text, mime: row.result_mime || 'text/plain' };
        }
        if (rpath) {
            let abs = rpath;
            if (!fs.existsSync(abs)) {
                const candidates = [
                    rpath,
                    pathJoinSafe(getMediaDir(), rpath),
                    pathJoinSafe(promptsDir, rpath),
                ];
                for (const c of candidates) {
                    if (c && fs.existsSync(c)) { abs = c; break; }
                }
            }
            if (!fs.existsSync(abs)) return { ok: false, error: '产物文件不存在' };
            const buf = await fsp.readFile(abs);
            const mime = row.result_mime || 'image/png';
            const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
            return { ok: true, dataUrl, mime, path: abs };
        }
        return { ok: false, error: '该任务没有产物' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// 改造 tools:run：现在直接走队列（前端 workbench 后续会切到 taskQueue:* 频道）
ipcMain.handle('tools:run', async (_e, payload) => {
    return enqueueTask(payload || {});
});

// 启动入口：供 app.whenReady() 末尾调用
function bootstrapTaskQueue() {
    try {
        _qLoadOnStartup();
    } catch (e) {
        console.warn('[task-queue] bootstrap 失败：', e.message);
    }
}

// ========== AI 小说（独立模块；不动 taskQueue / ComfyUI / workbench）=========
// 共 13 个 handler；事件推送走 ainovel:event:update（复用现有 notifyRenderer）
ipcMain.handle('ainovel:list', async () => {
    return novelEngine.listNovels();
});

ipcMain.handle('ainovel:create', async (_e, payload) => {
    return novelEngine.createNovel(payload || {});
});

ipcMain.handle('ainovel:get', async (_e, payload) => {
    return novelEngine.getNovel((payload || {}).novelId);
});

ipcMain.handle('ainovel:delete', async (_e, payload) => {
    return novelEngine.deleteNovel((payload || {}).novelId);
});

ipcMain.handle('ainovel:updateOutline', async (_e, payload) => {
    const { novelId, outlinePatch } = payload || {};
    return novelEngine.updateOutline(novelId, outlinePatch || {});
});

ipcMain.handle('ainovel:generateOutline', async (_e, payload) => {
    const { novelId } = payload || {};
    return novelEngine.callSkill('outline-architect', { novelId }, { novelId });
});

ipcMain.handle('ainovel:writeChapter', async (_e, payload) => {
    const { novelId, chapterId } = payload || {};
    if (!novelId || !chapterId) return { ok: false, error: 'novelId / chapterId 必填' };
    const chapter = novelEngine.getActive?.()?.chapters?.get(chapterId)
        || null;
    // 从 store 直接取（getActive 可能为 null 如果该 novel 未 setActive）
    let ch = chapter;
    if (!ch) {
        try {
            const row = (store.query('SELECT * FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0]) || null;
            ch = row;
        } catch {}
    }
    if (!ch) return { ok: false, error: '章节不存在' };
    return novelEngine.callSkill('chapter-writer', { novelId, chapter: ch }, { novelId });
});

ipcMain.handle('ainovel:updateChapter', async (_e, payload) => {
    const { novelId, chapterId, ...patch } = payload || {};
    return novelEngine.updateChapter(novelId, chapterId, patch || {});
});

ipcMain.handle('ainovel:exportTxt', async (_e, payload) => {
    const { novelId } = payload || {};
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    return _ainovelExportTxt(novelId);
});

async function _ainovelExportTxt(novelId) {
    try {
        const get = novelEngine.getNovel(novelId);
        if (!get.ok) return get;
        const { novel: nv, outline, chapters } = get;
        if (!chapters || !chapters.length) return { ok: false, error: '该小说暂无章节' };
        const dlg = await dialog.showSaveDialog(mainWindow, {
            title: '导出小说为 TXT',
            defaultPath: (nv.title || 'novel').replace(/[\\/:*?"<>|]/g, '_') + '.txt',
            filters: [{ name: '文本文件', extensions: ['txt'] }],
        });
        if (dlg.canceled || !dlg.filePath) return { ok: false, error: '已取消' };
        const fs = require('fs');
        const lines = [];
        lines.push(nv.title || '未命名');
        lines.push('');
        lines.push('风格：' + (nv.style || '') + (nv.custom_style ? ' / ' + nv.custom_style : ''));
        lines.push('核心创意：' + (nv.core_idea || ''));
        if (outline) {
            if (outline.structure) { lines.push(''); lines.push('【结构】'); lines.push(outline.structure); }
            if (outline.world_setting) { lines.push(''); lines.push('【世界观】'); lines.push(outline.world_setting); }
        }
        lines.push('');
        lines.push('='.repeat(60));
        lines.push('');
        const sortedChapters = chapters.slice().sort((a, b) => a.chapter_no - b.chapter_no);
        for (const ch of sortedChapters) {
            if (!ch.content) continue;
            lines.push(`第 ${ch.chapter_no} 章 ${ch.title || ''}`);
            lines.push('');
            lines.push(ch.content);
            lines.push('');
        }
        await fs.promises.writeFile(dlg.filePath, lines.join('\n'), 'utf8');
        return { ok: true, path: dlg.filePath };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

ipcMain.handle('ainovel:getProviderConfig', async () => {
    return novelEngine.getProviderConfig();
});

ipcMain.handle('ainovel:setProviderConfig', async (_e, payload) => {
    return novelEngine.setProviderConfig(payload || {});
});

ipcMain.handle('ainovel:testProvider', async (_e, payload) => {
    return novelEngine.testProviderConnection(payload || {});
});

ipcMain.handle('ainovel:listGenerations', async (_e, payload) => {
    return novelEngine.listGenerations((payload || {}).novelId);
});
ipcMain.handle('ainovel:getGeneration', async (_e, payload) => {
    return novelEngine.getGeneration((payload || {}).id);
});
// OpenClaw 模式：用户反馈 + Agent 配置管理
ipcMain.handle('ainovel:saveAgentFeedback', async (_e, payload) => {
    try { return novelEngine.saveAgentFeedback(payload || {}); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ainovel:listAgentFeedback', async (_e, payload) => {
    return novelEngine.listAgentFeedback(payload || {});
});
ipcMain.handle('ainovel:getAgentConfig', async (_e, payload) => {
    return novelEngine.getAgentConfig((payload || {}).skill);
});
ipcMain.handle('ainovel:saveAgentConfig', async (_e, payload) => {
    return novelEngine.saveAgentConfig((payload || {}).skill, (payload || {}).filename, (payload || {}).content);
});
ipcMain.handle('ainovel:listMemoryLogs', async (_e, payload) => {
    return novelEngine.listMemoryLogs(payload || {});
});
ipcMain.handle('ainovel:flushMemory', async (_e, payload) => {
    return novelEngine.flushMemory(payload || {});
});

// 列出全部已注册 Agent（供设置 → Agent 配置 面板渲染左侧列表）
ipcMain.handle('ainovel:listSkills', async () => {
    const list = (typeof novelEngine.listSkills === 'function') ? novelEngine.listSkills() : [];
    return { ok: true, skills: list };
});

// ========= Sprint H：LLM-driven 多 agent 协作（Blackboard / Inbox / Task / Director）=========
function _hSafe(fn) {
    try { const r = fn(); return (r && typeof r.then === 'function') ? r.catch(e => ({ ok: false, error: e.message || String(e) })) : r; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// --- H2: 黑板 ---
ipcMain.handle('ainovel:blackboardList', async (_e, payload) => {
    const { novelId } = payload || {};
    return _hSafe(() => novelEngine.blackboardList(novelId));
});
ipcMain.handle('ainovel:blackboardRead', async (_e, payload) => {
    const { novelId, key } = payload || {};
    return _hSafe(() => novelEngine.blackboardRead(novelId, key));
});
ipcMain.handle('ainovel:blackboardWrite', async (_e, payload) => {
    const { novelId, key, value, owner } = payload || {};
    return _hSafe(() => novelEngine.blackboardWrite(novelId, key, value, owner || 'user'));
});
ipcMain.handle('ainovel:blackboardClear', async (_e, payload) => {
    const { novelId, key } = payload || {};
    return _hSafe(() => novelEngine.blackboardClear(novelId, key || null));
});

// --- H3: 收件箱 ---
ipcMain.handle('ainovel:inboxList', async (_e, payload) => {
    const { novelId, agentName } = payload || {};
    return _hSafe(() => novelEngine.inboxList(novelId, agentName));
});
ipcMain.handle('ainovel:inboxSend', async (_e, payload) => {
    const { novelId, ...opts } = payload || {};
    return _hSafe(() => novelEngine.inboxSend(novelId, Object.assign({ from: 'user' }, opts)));
});
ipcMain.handle('ainovel:inboxMarkRead', async (_e, payload) => {
    const { novelId, agentName, ids } = payload || {};
    return _hSafe(() => novelEngine.inboxMarkRead(novelId, agentName, ids || null));
});

// --- H4: 任务图 ---
ipcMain.handle('ainovel:taskList', async (_e, payload) => {
    const { novelId, ...opts } = payload || {};
    return _hSafe(() => novelEngine.taskList(novelId, opts));
});
ipcMain.handle('ainovel:taskCreate', async (_e, payload) => {
    const { novelId, ...opts } = payload || {};
    return _hSafe(() => novelEngine.taskCreate(novelId, opts));
});
ipcMain.handle('ainovel:taskGet', async (_e, payload) => {
    return _hSafe(() => novelEngine.taskGet((payload || {}).taskId));
});
ipcMain.handle('ainovel:taskComplete', async (_e, payload) => {
    const { taskId, result } = payload || {};
    return _hSafe(() => novelEngine.taskComplete(taskId, result));
});
ipcMain.handle('ainovel:taskFail', async (_e, payload) => {
    const { taskId, error } = payload || {};
    return _hSafe(() => novelEngine.taskFail(taskId, error));
});
ipcMain.handle('ainovel:taskReady', async (_e, payload) => {
    const { novelId, agentName } = payload || {};
    return _hSafe(() => novelEngine.taskReady(novelId, agentName || null));
});

// --- H5/H6: 编剧调度 ---
ipcMain.handle('ainovel:runDirector', async (_e, payload) => {
    const { novelId, goal, input } = payload || {};
    if (!novelId || !goal) return { ok: false, error: 'novelId / goal 必填' };
    try { return await novelEngine.runDirectedAgent(novelId, goal, { input: input || {} }); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ainovel:getDirectorMode', async () => {
    return _hSafe(() => ({ ok: true, mode: novelEngine.getDirectorMode() }));
});
ipcMain.handle('ainovel:setDirectorMode', async (_e, payload) => {
    return _hSafe(() => novelEngine.setDirectorMode((payload || {}).mode));
});

// Phase 2: 自动推进模式（5 个 handler）
ipcMain.handle('ainovel:autoStart', async (_e, payload) => {
    try { return await novelEngine.startAuto((payload || {}).novelId); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ainovel:autoPause', async (_e, payload) => {
    return novelEngine.pauseAuto((payload || {}).novelId);
});
ipcMain.handle('ainovel:autoResume', async (_e, payload) => {
    return novelEngine.resumeAuto((payload || {}).novelId);
});
ipcMain.handle('ainovel:autoCancel', async (_e, payload) => {
    return novelEngine.cancelAuto((payload || {}).novelId);
});
ipcMain.handle('ainovel:getAutoStatus', async (_e, payload) => {
    return novelEngine.getAutoStatus((payload || {}).novelId);
});
// ========= Phase 3: 知识库 IPC =========
ipcMain.handle('ainovel:getKnowledge', async (_e, payload) => {
    return novelEngine.getKnowledge((payload || {}).novelId, (payload || {}).kind);
});
ipcMain.handle('ainovel:extractKnowledge', async (_e, payload) => {
    return novelEngine.extractKnowledge((payload || {}).novelId, (payload || {}).kinds);
});
ipcMain.handle('ainovel:updateKnowledge', async (_e, payload) => {
    return novelEngine.updateKnowledge((payload || {}).id, (payload || {}).patch || {});
});
ipcMain.handle('ainovel:deleteKnowledge', async (_e, payload) => {
    return novelEngine.deleteKnowledge((payload || {}).id);
});

// Phase 4-A: 故事架构 IPC
ipcMain.handle('ainovel:getArchitecture', async (_e, payload) => {
    return novelEngine.getArchitecture((payload || {}).novelId);
});

ipcMain.handle('ainovel:updateArchitecture', async (_e, payload) => {
    return novelEngine.updateArchitecture((payload || {}).novelId, (payload || {}).patch || {});
});

ipcMain.handle('ainovel:regenerateArchitecture', async (_e, payload) => {
    // 触发 story-architect 重跑（基于已有 outline）
    return novelEngine.regenerateArchitecture((payload || {}).novelId);
});

// 通用设置读写（novel 全局 key/value，落 _ainovel_settings）
ipcMain.handle('ainovel:getSetting', async (_e, payload) => {
    try {
        return novelEngine.getSetting((payload || {}).key);
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('ainovel:setSetting', async (_e, payload) => {
    try {
        return novelEngine.setSetting((payload || {}).key, (payload || {}).value);
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// Sprint W: 工作面板事件流
ipcMain.handle('ainovel:listWorkflowEvents', async (_e, payload) => {
    return _hSafe(() => novelEngine.listWorkflowEvents(
        (payload || {}).novelId,
        (payload || {}).opts || {}
    ));
});
ipcMain.handle('ainovel:listWorkflowReplay', async (_e, payload) => {
    return _hSafe(() => novelEngine.listWorkflowReplay(
        (payload || {}).novelId,
        (payload || {}).opts || {}
    ));
});
ipcMain.handle('ainovel:getWorkflowEventDetail', async (_e, payload) => {
    return _hSafe(() => novelEngine.getWorkflowEventDetail((payload || {}).id));
});
ipcMain.handle('ainovel:getWorkflowStats', async (_e, payload) => {
    return _hSafe(() => novelEngine.getWorkflowStats((payload || {}).novelId));
});

// Phase 4-B: 圣经状态 IPC
ipcMain.handle('ainovel:getNovelState', async (_e, payload) => {
    return novelEngine.getNovelState((payload || {}).novelId);
});

ipcMain.handle('ainovel:atomicCommitState', async (_e, payload) => {
    return novelEngine.atomicCommitState((payload || {}).novelId, (payload || {}).patch || {});
});

ipcMain.handle('ainovel:resetNovelState', async (_e, payload) => {
    return novelEngine.resetNovelState((payload || {}).novelId);
});
