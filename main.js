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
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const { COMFYUI_STATUS, COMFYUI_JOBS, setSender: setComfySender, abortAllJobs: abortAllComfyJobs } = require('./comfyui-state');

let mainWindow = null;
let store = null;         // KVDb 实例（prompt 存储）
let configStore = null;   // KVDb 实例（config 存储，跟 prompts 同一份 db）
let promptsDir = null;    // 兼容老行为：保留 prompts 目录

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        backgroundColor: '#000',
        title: 'ReElectron — 瀑布流媒体加载器',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'web', 'index.html'));

    // ComfyUI: 把 webContents 注册成事件 sender
    setComfySender((channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
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
    ensureMediaDir();             // ComfyUI: media/ 子目录
    ensureAssetsDir();            // 资产存储目录（用户可在设置改）
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
            for (const entry of entries) {
                if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
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
                    // file:// 协议（Electron 主进程读本地文件给 web 用）
                    collected.push({
                        type,
                        src: 'file:///' + full.replace(/\\/g, '/'),
                        id: `local-${stableHash(full)}`,
                        fileName: entry.name,
                    });
                }
            }
        }
        frontier = nextFrontier;
    }
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

app.whenReady().then(() => {
    initStore();
    createWindow();
});

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
}
// 原 try 块已删：在脚本加载期 store 还是 null，会抛 "Cannot read properties of null"
// 改在 initStore() 里统一调

// ========== D-36: 提示词关联规则 + 场景模板 ==========
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
    // D-40: 场景模板加 enabled 列（兼容老库）
    const stCols = store.query("PRAGMA table_info(scene_templates)");
    if (stCols.length && !stCols.some(c => c.name === 'enabled')) {
        store.exec("ALTER TABLE scene_templates ADD COLUMN enabled INTEGER DEFAULT 1");
    }
    console.log('[D-36] 关联规则 + 场景模板表已就绪');
}

ipcMain.handle('prompt:item:list', async (_e, payload) => {
    try {
        const catId = payload && payload.category_id;
        // LEFT JOIN prompt_menu 把分类的 tag_required / tag_exclusive_group 一并返回
        // 这样前端校验（互斥组 / 数量规则）无需再查分类表
        let rows;
        if (catId) {
            rows = store.query(
                `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity,
                        m.category_name, m.tag_required, m.tag_exclusive_group, m.exclusive_with, m.exclusive_group
                   FROM prompt_items i
                   LEFT JOIN prompt_menu m ON m.id = i.category_id
                  WHERE i.category_id = ?
                  ORDER BY i.sort_order ASC, i.id ASC`,
                Number(catId)
            );
        } else {
            rows = store.query(
                `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity,
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
            `SELECT i.id, i.category_id, i.name, i.content, i.description, i.sort_order, i.sensitivity,
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
            'INSERT INTO prompt_items (category_id, name, content, description, sort_order, sensitivity) VALUES (?, ?, ?, ?, ?, ?)',
            Number(payload.category_id), payload.name, payload.content || '', payload.description || '', Number(payload.sort_order) || 0, payload.sensitivity || 'nsfw'
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
        store.exec(
            'UPDATE prompt_items SET name=?, content=?, description=?, sort_order=?, sensitivity=?, category_id=?, updated_at=strftime(\'%s\',\'now\') WHERE id=?',
            name, content, description, sortOrder, sensitivity, categoryId, id
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
        const r = store.exec('DELETE FROM prompt_items WHERE id = ?', nid);
        return { ok: true, deleted: r.changes };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('prompt:item:get', async (_e, id) => {
    try {
        const rows = store.query('SELECT id, category_id, name, content, description, sort_order, sensitivity FROM prompt_items WHERE id = ?', Number(id) || 0);
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
            `SELECT id, category_id, name, content, description, sort_order, sensitivity
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
            `SELECT i.id, i.category_id, i.name, i.sensitivity,
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
                    "UPDATE prompt_items SET content=?, description=?, sort_order=?, sensitivity=?, updated_at=strftime('%s','now') WHERE id=?",
                    content, description, sortOrder, sensitivity, existing[0].id
                );
                updated++;
            } else {
                store.exec(
                    'INSERT INTO prompt_items (category_id, name, content, description, sort_order, sensitivity) VALUES (?, ?, ?, ?, ?, ?)',
                    catId, name, content, description, sortOrder, sensitivity
                );
                imported++;
            }
        }
        return { ok: true, imported, updated, skipped, catsCreated, skippedDetails: skippedDetails.slice(0, 20) };
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

ipcMain.handle('tools:run', async (_e, payload) => {
    try {
        const toolId = payload && payload.toolId;
        const formValues = (payload && payload.formValues) || {};
        if (!toolId) return { ok: false, error: 'toolId 必填' };
        // 1) 拿 schema + workflow
        const schema = comfyuiToolStore.getTool(toolId);
        if (!schema) return { ok: false, error: `工具 ${toolId} 不存在` };
        const wfr = comfyuiToolStore.getWorkflow(toolId);
        if (!wfr.ok) return { ok: false, error: wfr.error };
        // 2) 应用 form values
        const ar = comfyuiApplier.applyFormToWorkflow(wfr.workflow, schema, formValues);
        if (!ar.ok) return { ok: false, error: ar.error, warnings: ar.warnings };
        // 3) 没跑就先自动启动
        if (!COMFYUI_STATUS.running) {
            const cfg = getComfyConfig();
            const sr = await comfyuiProcess.startService(cfg);
            if (!sr || !sr.ok) return { ok: false, error: (sr && sr.error) || 'ComfyUI 启动失败' };
        }
        // 4) 提交
        const port = COMFYUI_STATUS.port;
        const clientId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cfg = getComfyConfig();
        const handle = comfyuiWs.startJob({
            port,
            workflowJson: ar.workflow,
            clientId,
            mode: schema.mode || 'sfw',
            timeoutMs: cfg.jobTimeoutMs,
            // 优先从 schema.outputNodes 指定的节点取产物（避免取到 PreviewImage 等辅助节点的预览图）
            preferredNodeIds: (schema.outputNodes || []).map(n => n.nodeId),
            // 传完整 outputNodes（含 type）让 startJob 决定走文本还是图片路径
            outputNodes: schema.outputNodes || [],
        });
        return { ok: true, jobId: handle.jobId, warnings: ar.warnings };
    } catch (e) { return { ok: false, error: e.message }; }
});

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
