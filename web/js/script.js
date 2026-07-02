const CONFIG = {
    batchSize: 20,          
    preloadBatch: 6,        
    retryCount: 2,          
    loadPriority: 'high',   
    storageKeys: {
        imgWidth: 'waterfall_img_width',
        localHandle: 'waterfall_local_handle',
        networkUrls: 'waterfall_network_urls',
        sourceType: 'waterfall_source_type'
    },
    // 媒体文件类型配置
    mediaTypes: {
        images: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"],
        videos: ["mp4", "webm", "avi", "mov", "mkv", "flv", "wmv"]
    },
    // ========== D-25 变更：nasConfig 改为动态来源 ==========
    // Tab 资源路径不再写死，从 SQLite 拉（main.js 启动 seed 默认 4 个 tab）
    // 老 CONFIG.nasConfig[tabId] 逻辑改为：window.configUI.getActiveTab()?.source
    nasConfig: {} // 留空；实际 tab 配置走 window.api.config.get()
};

/**
 * 稳定 ID 生成器（严重8）
 * - 使用 FNV-1a 32-bit 哈希，避免 Date.now()+随机串导致“同文件不同 ID”
 * - local 用 name+size+lastModified 作为 key（同一文件不同时间选入会识别为同一项）
 * - net 用原始 URL 作为 key
 * - NAS 直接用路径，天然稳定，不走这个
 */
function stableId(prefix, ...parts) {
    const s = parts.join('|');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `${prefix}-${(h >>> 0).toString(36)}`;
}

const state = {
 media: [], //改为media，包含图片和视频
 loadedCount:0,
 isLoading: false,
 preloadedMedia: [],
 sourceType: 'demo',
 localDirHandle: null,
 columnHeights: [],
 columns: [],
 imgWidth:300,
 renderedIds: new Set(),
 activeTab: 'ai-image', // 新增：当前激活的Tab
 isScanningNas: false, // 新增：标记是否正在扫描NAS
 // ========= 新增：可取消的扫描控制器（严重1） =========
 nasScanController: null,
 // ========= 新增：blob URL追踪（严重2） =========
 trackedBlobUrls: new Set(),
    // ========= 新增：当前 Tab 的 NAS缓存信息 =========
 nasScanEpoch:0, // 单调递增，用于让过期的回调自动失效
};

// ========= 新增：blob URL集中管理（严重2） =========
function trackBlobUrl(url) {
 if (typeof url === 'string' && url.startsWith('blob:')) {
 state.trackedBlobUrls.add(url);
 }
 return url;
}

function revokeAllBlobUrls() {
 for (const url of state.trackedBlobUrls) {
 try { URL.revokeObjectURL(url); } catch (_) { /*静默忽略 */ }
 }
 state.trackedBlobUrls.clear();
}

// ========= 新增：轻量 IndexedDB缓存封装（严重4） =========
// 只用于 NAS扫描结果缓存，按 Tab 分 key，存路径列表 + 时间戳
const NAS_CACHE_DB = 'waterfall_nas_cache';
const NAS_CACHE_STORE = 'scans';
const NAS_CACHE_TTL_MS =60 *60 *1000; //1 小时

// ========= 提示词存储（Electron 版：本地 JSON 文件） =========
// 数据落在 <项目根>/prompts/ 里，每个媒体一个 .json
// 文件名用 id 的 base64url 编码，避免路径分隔符 / 中文问题
// 如以 window.api 不可用（纯浏览器模式），fallback 到原 IndexedDB 实现
function _hasElectronApi() {
    return typeof window !== 'undefined' && window.api && window.api.prompts;
}

// IndexedDB 原实现保留为 fallback（纯浏览器打开 web/index.html 时还能用）
const PROMPT_DB = 'waterfall_prompts';
const PROMPT_STORE = 'prompts';
function openPromptDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PROMPT_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(PROMPT_STORE)) {
                db.createObjectStore(PROMPT_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function _idbRead(id) {
    try {
        const db = await openPromptDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(PROMPT_STORE, 'readonly');
            const req = tx.objectStore(PROMPT_STORE).get(id);
            req.onsuccess = () => {
                if (!req.result) return resolve({ prompt: '', tags: [] });
                resolve({ prompt: req.result.prompt || '', tags: Array.isArray(req.result.tags) ? req.result.tags : [] });
            };
            req.onerror = () => resolve({ prompt: '', tags: [] });
        });
    } catch { return { prompt: '', tags: [] }; }
}
async function _idbWrite(id, prompt, tags) {
    try {
        const db = await openPromptDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(PROMPT_STORE, 'readwrite');
            tx.objectStore(PROMPT_STORE).put({ id, prompt: prompt || '', tags: Array.isArray(tags) ? tags : [], ts: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return true;
    } catch { return false; }
}

// 内存缓存（避免每次都打磁盘 / IDB）
const _metaCache = new Map();
let _allRecordsCache = null;  // D-33: prompts:readAll 全表结果缓存，写/删时清

async function readMediaMeta(id) {
    if (_metaCache.has(id)) return _metaCache.get(id);
    let meta;
    if (_hasElectronApi()) {
        // D-33: 原来每次未命中都调 readAll 全表拉，89 条 JSON.parse + .find。
        //       现在一次性全表拉完缓存到 _allRecordsCache，后续读单条只查 Map。
        if (!_allRecordsCache) {
            const result = await window.api.prompts.readAll();
            _allRecordsCache = (result && result.records) || [];
        }
        const rec = _allRecordsCache.find(r => r.id === id);
        meta = rec ? { prompt: rec.prompt || '', tags: rec.tags || [] } : { prompt: '', tags: [] };
    } else {
        meta = await _idbRead(id);
    }
    _metaCache.set(id, meta);
    return meta;
}
async function writeMediaMeta(id, prompt, tags) {
    const data = { prompt: prompt || '', tags: Array.isArray(tags) ? tags : [] };
    _metaCache.set(id, data);
    // D-33: 本地记录同步维护（写后下次 readAll 不会等）
    if (_allRecordsCache) {
        const idx = _allRecordsCache.findIndex(r => r.id === id);
        const rec = { id, prompt: data.prompt, tags: data.tags, ts: Date.now() };
        if (idx >= 0) _allRecordsCache[idx] = rec;
        else _allRecordsCache.push(rec);
    }
    if (_hasElectronApi()) {
        const result = await window.api.prompts.writeOne(id, data.prompt, data.tags);
        return !!result.ok;
    }
    return _idbWrite(id, data.prompt, data.tags);
}
// 兼容旧名
async function readPrompt(id) { const r = await readMediaMeta(id); return r.prompt; }
async function writePrompt(id, prompt) { return writeMediaMeta(id, prompt, []); }

function openNasCacheDb() {
 return new Promise((resolve, reject) => {
 const req = indexedDB.open(NAS_CACHE_DB,1);
 req.onupgradeneeded = () => {
 const db = req.result;
 if (!db.objectStoreNames.contains(NAS_CACHE_STORE)) {
 db.createObjectStore(NAS_CACHE_STORE, { keyPath: 'tabId' });
 }
 };
 req.onsuccess = () => resolve(req.result);
 req.onerror = () => reject(req.error);
 });
}

async function readNasCache(tabId) {
 try {
 const db = await openNasCacheDb();
 return await new Promise((resolve, reject) => {
 const tx = db.transaction(NAS_CACHE_STORE, 'readonly');
 const req = tx.objectStore(NAS_CACHE_STORE).get(tabId);
 req.onsuccess = () => {
 const rec = req.result;
 if (!rec) return resolve(null);
 if (Date.now() - (rec.ts ||0) > NAS_CACHE_TTL_MS) return resolve(null);
 resolve(rec.media || null);
 };
 req.onerror = () => reject(req.error);
 });
 } catch (err) {
 console.warn('读取NAS缓存失败:', err);
 return null;
 }
}

async function writeNasCache(tabId, media) {
 try {
 const db = await openNasCacheDb();
 await new Promise((resolve, reject) => {
 const tx = db.transaction(NAS_CACHE_STORE, 'readwrite');
 tx.objectStore(NAS_CACHE_STORE).put({ tabId, media, ts: Date.now() });
 tx.oncomplete = () => resolve();
 tx.onerror = () => reject(tx.error);
 });
 } catch (err) {
 console.warn('写入NAS缓存失败:', err);
 }
}

const els = {
    gallery: document.getElementById('gallery'),
    sentinel: document.getElementById('sentinel'),
    slider: document.getElementById('widthSlider'),
    widthValue: document.getElementById('widthValue'),
    btnLocal: document.getElementById('btnLocal'),
    btnNet: document.getElementById('btnNet'),
    modal: document.getElementById('networkModal'),
    netInput: document.getElementById('networkInput'),
    btnCancelNet: document.getElementById('btnCancelNet'),
    btnConfirmNet: document.getElementById('btnConfirmNet'),
    toastContainer: document.getElementById('toast-container'),
    emptyState: document.getElementById('emptyState'),
    fallbackInput: document.getElementById('fallbackInput'),
    previewModal: document.getElementById('mediaPreviewModal'),
    previewImage: document.getElementById('previewImage'),
    previewVideo: document.getElementById('previewVideo'),
    closePreviewBtn: document.querySelector('.close-preview'),
    promptTextarea: document.getElementById('promptTextarea'),
    promptDisplay: document.getElementById('promptDisplay'),
    promptStatus: document.getElementById('promptStatus'),
    promptFileName: document.getElementById('promptFileName'),
    promptHeaderActions: document.getElementById('promptHeaderActions'),
    btnPromptEdit: document.getElementById('btnPromptEdit'),
    btnRefToImg: document.getElementById('btnRefToImg'),
    btnRefToVideo: document.getElementById('btnRefToVideo'),
    btnReversePrompt: document.getElementById('btnReversePrompt'),
    btnDeleteAsset: document.getElementById('btnDeleteAsset'),
    // 二次确认弹框
    confirmModal: document.getElementById('confirmModal'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalBody: document.getElementById('confirmModalBody'),
    confirmModalOk: document.getElementById('confirmModalOk'),
    confirmModalCancel: document.getElementById('confirmModalCancel'),
    tagsList: document.getElementById('tagsList'),
    tagsInput: document.getElementById('tagsInput'),
    btnTagAdd: document.getElementById('btnTagAdd'),
    scanLoading: document.getElementById('scanLoading'),
    // 元信息（资产 Tab 自动回显）
    metaWorkflow: document.getElementById('metaWorkflow'),
    metaModel: document.getElementById('metaModel'),
    metaLora: document.getElementById('metaLora'),
    metaVae: document.getElementById('metaVae'),
    metaVaeRow: document.getElementById('metaVaeRow'),
    metaSource: document.getElementById('metaSource'),
    metaSourceRow: document.getElementById('metaSourceRow'),
    metaTool: document.getElementById('metaTool'),
    metaToolRow: document.getElementById('metaToolRow'),
    metaMode: document.getElementById('metaMode'),
    metaModeRow: document.getElementById('metaModeRow'),
    metaTiming: document.getElementById('metaTiming'),
    metaTimingRow: document.getElementById('metaTimingRow'),
    metaVram: document.getElementById('metaVram'),
    metaVramRow: document.getElementById('metaVramRow'),
    metaTs: document.getElementById('metaTs'),
    metaTsRow: document.getElementById('metaTsRow'),
    metaPlaceholder: document.getElementById('metaPlaceholder'),
    tabContainer: document.querySelector('.tab-container'), // 新增：Tab容器
    tabItems: document.querySelectorAll('.tab-item') // 新增：所有Tab项
};

// 初始化函数
function init() {
    console.log('初始化瀑布流媒体加载器');
    console.log('浏览器支持FileSystem API:', 'showDirectoryPicker' in window);
    
    // 初始化图片宽度
    const savedWidth = localStorage.getItem(CONFIG.storageKeys.imgWidth);
    if (savedWidth) {
        state.imgWidth = parseInt(savedWidth);
        els.slider.value = state.imgWidth;
        els.widthValue.textContent = `${state.imgWidth}px`;
        document.documentElement.style.setProperty('--img-width', `${state.imgWidth}px`);
    }

    // 初始化瀑布流列
    initWaterfallColumns();
    
    // 绑定事件
    bindEvents();
    
    // 初始化空状态
    updateEmptyState();

    // ========== D-25 变更 ==========
    // 不在这里直接 loadNasGalleryByTab —— configUI.init() 会拉 config、渲染顶部 tab、
    // 然后通过 onTabChange 回调通知外部触发资源加载
    if (window.configUI) {
        window.configUI.init({
            onTabChange: (tab, isFirstLoad) => {
                if (!isFirstLoad) state.activeTab = tab.id;
                // 把 active tab 同步到 state（用于 readMediaMeta 等逻辑）
                state.activeTab = tab.id;
                // 触发资源加载
                if (window._galleryLoader) {
                    window._galleryLoader(tab);
                }
            }
        });
    }

    // D-31: 绑定写死的「配置」「提示词生成」按钮
    // D-配置整合：btnConfig 改用新 settings 页（tab=resources 资源管理）
    const btnConfig = document.getElementById('btnConfig');
    console.log('[script.js] btnConfig 元素:', btnConfig);
    if (btnConfig) {
        btnConfig.addEventListener('click', () => {
            console.log('[script.js] btnConfig 被点击');
            if (window.settings && typeof window.settings.open === 'function') {
                window.settings.open({ tab: 'resources' });
            } else if (window.configUI && window.configUI.openManageModal) {
                // 兜底：settings.js 未加载时退回旧弹框
                window.configUI.openManageModal();
            } else {
                console.error('[script.js] 设置页 / 旧弹框均不可用');
                alert('设置模块未加载');
            }
        });
    }
    const btnPromptGen = document.getElementById('btnPromptGen');
    console.log('[script.js] btnPromptGen 元素:', btnPromptGen);
    if (btnPromptGen) {
        btnPromptGen.addEventListener('click', () => {
            console.log('[script.js] btnPromptGen 被点击');
            if (window.promptGen && window.promptGen.open) {
                window.promptGen.open();
            } else {
                console.error('[script.js] window.promptGen 不可用');
                alert('提示词生成模块未加载');
            }
        });
    }
    const btnAiTools = document.getElementById('btnAiTools');
    if (btnAiTools) {
        btnAiTools.addEventListener('click', () => {
            if (window.aiTools && window.aiTools.open) {
                window.aiTools.open();
            } else {
                alert('AI 工具模块未加载');
            }
        });
    }
}

/**
 * 初始化瀑布流列（轻微12）
 * 滑块在 input 事件中连续改 --img-width，再同步读 offsetWidth 会出现拿旧值的情况
 * 这里用 rAF 等下一帧布局稳定后再读
 */
function initWaterfallColumns() {
    els.gallery.innerHTML = '';
    state.columns = [];
    state.columnHeights = [];

    const compute = () => {
        const containerWidth = els.gallery.offsetWidth || window.innerWidth - 20;
        const columnGap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--column-gap')) || 10;
        const columnWidth = state.imgWidth + columnGap;
        const columnCount = Math.max(1, Math.floor(containerWidth / columnWidth));
        for (let i = 0; i < columnCount; i++) {
            const column = document.createElement('div');
            column.className = 'gallery-column';
            els.gallery.appendChild(column);
            state.columns.push(column);
            state.columnHeights.push(0);
        }
    };

    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(compute);
    } else {
        compute();
    }
}

/**
 * 获取最短列索引
 */
function getShortestColumnIndex() {
    // 深拷贝列高度数组，避免并发修改导致的计算偏差
    const heights = [...state.columnHeights];
    const minHeight = Math.min(...heights);
    // 找到第一个最短列（保证顺序性）
    return heights.findIndex(height => height === minHeight);
}

/**
 * 判断文件类型（图片/视频）
 */
function getMediaTypeByExt(ext) {
    ext = ext.toLowerCase();
    if (CONFIG.mediaTypes.images.includes(ext)) return 'image';
    if (CONFIG.mediaTypes.videos.includes(ext)) return 'video';
    return 'unknown';
}

/**
 * 预加载单个媒体文件（严重5 + 7 + 8 改造点）
 * 内部已并发，但被 renderBatch 用信号量槽位调度实现跨批并发
 */
async function preloadOneMedia(mediaData) {
    if (state.renderedIds.has(mediaData.id)) return null;
    try {
        if (mediaData.type === 'image') {
            const r = await preloadSingleImage(mediaData.src);
            return { ...r, id: mediaData.id, src: mediaData.src, mediaType: 'image' };
        }
        if (mediaData.type === 'video') {
            const r = await preloadSingleVideo(mediaData.src);
            return { ...r, id: mediaData.id, src: mediaData.src, mediaType: 'video' };
        }
    } catch (err) {
        console.error(`媒体预加载失败 ${mediaData.id}:`, err);
    }
    return null;
}

/**
 * 批量预加载媒体文件（保留为"批内并发"的纯工具，被 renderBatch 流水线调度使用）
 * 注：原"批间串行"问题已通过 renderBatch 的信号量槽位 + rAF 渲染解决
 */
async function preloadMediaBatch(startIndex, endIndex) {
    const preloadPromises = [];
    for (let i = startIndex; i < endIndex && i < state.media.length; i++) {
        preloadPromises.push(preloadOneMedia(state.media[i]));
    }
    const results = (await Promise.all(preloadPromises)).filter(Boolean);
    state.preloadedMedia = results;
    return results.length;
}

/**
 * 预加载单张图片（严重7 + 严重9）
 * - 30s 超时避免 NAS 不可达时永久 pending
 * - settled 守卫避免 onload/onerror/timeout 多次决出
 * - crossOrigin 改 'anonymous'（'use-credentials' 需服务端 CORS 凭证头，跨域 NAS 多半不支持）
 */
function preloadSingleImage(src, retry = 0) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.loading = CONFIG.loadPriority;
        img.decoding = 'async';

        let settled = false;
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            console.warn(`图片加载超时 (重试${retry}): ${src}`);
            if (retry < CONFIG.retryCount) {
                finish(() => resolve(preloadSingleImage(src, retry + 1)));
            } else {
                finish(() => reject(new Error(`图片加载超时: ${src}`)));
            }
        }, 30000);

        img.onload = () => finish(() => {
            console.log(`图片预加载成功: ${src}`);
            resolve({ width: img.width, height: img.height, element: img });
        });
        img.onerror = () => finish(() => {
            console.warn(`图片加载失败 (重试${retry}): ${src}`);
            if (retry < CONFIG.retryCount) {
                resolve(preloadSingleImage(src, retry + 1));
            } else {
                reject(new Error(`图片加载失败: ${src}`));
            }
        });

        img.src = src;
    });
}

/**
 * 预加载单个视频（仅获取尺寸信息）（严重7 + 严重9）
 */
function preloadSingleVideo(src, retry = 0) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.preload = 'metadata';

        let settled = false;
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            console.warn(`视频元数据加载超时 (重试${retry}): ${src}`);
            if (retry < CONFIG.retryCount) {
                finish(() => resolve(preloadSingleVideo(src, retry + 1)));
            } else {
                finish(() => reject(new Error(`视频元数据加载超时: ${src}`)));
            }
        }, 30000);

        video.onloadedmetadata = () => finish(() => {
            console.log(`视频元数据加载成功: ${src}`);
            resolve({ width: video.videoWidth, height: video.videoHeight, element: video });
        });
        video.onerror = () => finish(() => {
            console.warn(`视频加载失败 (重试${retry}): ${src}`);
            if (retry < CONFIG.retryCount) {
                resolve(preloadSingleVideo(src, retry + 1));
            } else {
                reject(new Error(`视频加载失败: ${src}`));
            }
        });

        video.src = src;
    });
}

/**
 * 渲染预加载的媒体文件
 */
function renderPreloadedMedia() {
    if (state.preloadedMedia.length === 0) return 0;
    
    let rendered = 0;
    const columnGap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--column-gap'));
    
    // 遍历所有预加载媒体
    for (const preloaded of state.preloadedMedia) {
        if (state.renderedIds.has(preloaded.id)) continue;
        
        const shortestColIndex = getShortestColumnIndex();
        const wrapper = document.createElement('div');
        wrapper.className = 'media-item';
        wrapper.dataset.id = preloaded.id;
        
        // 计算缩放后的高度
        const scaleRatio = state.imgWidth / preloaded.width;
        const scaledHeight = preloaded.height * scaleRatio;
        
        if (preloaded.mediaType === 'image') {
            // 渲染图片
            preloaded.element.alt = preloaded.id;
            preloaded.element.style.width = '100%';
            preloaded.element.style.height = 'auto';
            wrapper.appendChild(preloaded.element);

            // 绑定预览事件
            preloaded.element.addEventListener('click', () => {
                const meta = state.media.find(m => m.id === preloaded.id);
                showMediaPreview(preloaded.src, 'image', preloaded.id, meta && meta.fileName);
            });
        } else if (preloaded.mediaType === 'video') {
            // 渲染视频
            const video = preloaded.element;
            video.controls = false; // 瀑布流中不显示控制条
            video.style.width = '100%';
            video.style.height = 'auto';
            video.loop = false;
            video.muted = true; // 静音（避免自动播放声音）
            video.poster = ''; // 可以自定义视频封面

            // 添加播放图标叠加层
            const overlay = document.createElement('div');
            overlay.className = 'video-overlay';
            overlay.innerHTML = '<i class="fa-solid fa-play"></i>';

            wrapper.appendChild(video);
            wrapper.appendChild(overlay);

            // 绑定预览事件
            const onVideoClick = () => {
                const meta = state.media.find(m => m.id === preloaded.id);
                showMediaPreview(preloaded.src, 'video', preloaded.id, meta && meta.fileName);
            };
            video.addEventListener('click', onVideoClick);
            overlay.addEventListener('click', (e) => {
                e.stopPropagation();
                onVideoClick();
            });
        }
        
        state.columns[shortestColIndex].appendChild(wrapper);
        
        // 更新列高度
        state.columnHeights[shortestColIndex] += scaledHeight + columnGap;
        state.renderedIds.add(preloaded.id);
        rendered++;
    }
    
    state.loadedCount += rendered;
    return rendered;
}

/**
 * 批量渲染媒体文件（严重5 流水线化）
 * - 维持 preloadBatch 个并发槽位，preload 与 render 流水线
 * - preload 完一个就 push 到 renderQueue，rAF 中串行消费渲染
 * - 批内并发 + 批间并发（不单批 await）
 */
const _renderQueue = [];
let _renderScheduled = false;
function _scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        if (_renderQueue.length === 0) return;
        state.preloadedMedia = _renderQueue.splice(0, _renderQueue.length);
        renderPreloadedMedia();
    });
}

async function renderBatch() {
    if (state.isLoading || state.loadedCount >= state.media.length) return;

    state.isLoading = true;
    els.sentinel.style.display = 'flex';

    try {
        const batchEnd = Math.min(state.loadedCount + CONFIG.batchSize, state.media.length);
        const total = batchEnd - state.loadedCount;
        if (total <= 0) return;

        const slots = Math.min(CONFIG.preloadBatch, total);
        let cursor = state.loadedCount;
        let renderDoneTotal = 0;

        const workers = Array.from({ length: slots }, async () => {
            while (true) {
                if (cursor >= batchEnd) return;
                const i = cursor++;
                const m = state.media[i];
                if (!m) continue;
                const r = await preloadOneMedia(m);
                if (r) {
                    _renderQueue.push(r);
                    _scheduleRender();
                    renderDoneTotal++;
                }
            }
        });

        await Promise.all(workers);

    } catch (err) {
        console.error('渲染批次失败:', err);
        showToast('媒体文件加载出错，已跳过错误文件');
    } finally {
        // 等最后一帧渲染完
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        state.isLoading = false;
        updateEmptyState();

        if (state.loadedCount >= state.media.length) {
            els.sentinel.style.display = 'none';
        } else {
            checkScrollAndLoad();
        }
    }
}

// ========= 预览模态中的提示词 + 标签逻辑 =========
let _currentPreviewId = null;
let _currentPrompt = '';   // 内存中的最新值（未保存到 DB 的可能与 DB 不一致）
let _currentTags = [];
let _savePromptTimer = null;
let _isEditingPrompt = false; // 是否在编辑模式
let _previewMeta = null;       // 完整 {src, type, id, fileName} 以供「参考生图/视频」按钮使用

function _setPromptStatus(text, cls) {
    if (!els.promptStatus) return;
    els.promptStatus.textContent = text;
    els.promptStatus.classList.remove('saving', 'saved', 'error');
    if (cls) els.promptStatus.classList.add(cls);
}

function _renderPromptDisplay() {
    const text = _currentPrompt || '';
    if (!text) {
        els.promptDisplay.textContent = '未填写 —— 点右上「编辑」开始';
        els.promptDisplay.classList.add('empty');
    } else {
        els.promptDisplay.textContent = text;
        els.promptDisplay.classList.remove('empty');
    }
}

function _renderTags() {
    els.tagsList.innerHTML = '';
    if (!_currentTags || _currentTags.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'tag-empty';
        empty.textContent = '暂无标签';
        els.tagsList.appendChild(empty);
        return;
    }
    _currentTags.forEach((t, idx) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.setAttribute('role', 'listitem');
        tag.textContent = t;
        const rm = document.createElement('span');
        rm.className = 'tag-remove';
        rm.setAttribute('role', 'button');
        rm.setAttribute('aria-label', `删除标签 ${t}`);
        rm.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        rm.addEventListener('click', () => _removeTag(idx));
        tag.appendChild(rm);
        els.tagsList.appendChild(tag);
    });
}

async function _addTag(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (_currentTags.includes(t)) {
        _setPromptStatus(`标签「${t}」已存在`, 'error');
        return;
    }
    if (_currentTags.length >= 50) {
        _setPromptStatus('最多 50 个标签', 'error');
        return;
    }
    _currentTags.push(t);
    _renderTags();
    await _saveMetaDebounced();
}

async function _removeTag(idx) {
    if (idx < 0 || idx >= _currentTags.length) return;
    _currentTags.splice(idx, 1);
    _renderTags();
    await _saveMetaDebounced();
}

async function _saveMetaNow() {
    if (!_currentPreviewId) return false;
    _setPromptStatus('保存中…', 'saving');
    const ok = await writeMediaMeta(_currentPreviewId, _currentPrompt, _currentTags);
    _setPromptStatus(ok ? '已保存' : '保存失败', ok ? 'saved' : 'error');
    return ok;
}

function _saveMetaDebounced() {
    _setPromptStatus('编辑中…', 'saving');
    if (_savePromptTimer) clearTimeout(_savePromptTimer);
    _savePromptTimer = setTimeout(_saveMetaNow, 500);
}

function _enterPromptEdit() {
    if (_isEditingPrompt) return;
    _isEditingPrompt = true;
    els.promptDisplay.hidden = true;
    els.promptTextarea.hidden = false;
    els.promptTextarea.value = _currentPrompt;
    // 头按钮组换为「保存 / 取消」
    els.promptHeaderActions.innerHTML = `
        <button id="btnPromptSave" class="btn btn-sm btn-primary" type="button" title="保存（Ctrl/Cmd+S）">
            <i class="fa-solid fa-check" aria-hidden="true"></i> 保存
        </button>
        <button id="btnPromptCancel" class="btn btn-sm" type="button" title="取消（Esc）">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i> 取消
        </button>
    `;
    els.promptTextarea.focus();
    els.promptTextarea.setSelectionRange(els.promptTextarea.value.length, els.promptTextarea.value.length);
}

async function _exitPromptEdit(save) {
    if (!_isEditingPrompt) return;
    if (save) {
        _currentPrompt = els.promptTextarea.value;
        await _saveMetaNow();
        _renderPromptDisplay();
    }
    _isEditingPrompt = false;
    els.promptTextarea.hidden = true;
    els.promptDisplay.hidden = false;
    // 恢复头按钮为「编辑」（事件代理在 bindEvents 里统一处理，不需要再绑）
    els.promptHeaderActions.innerHTML = `
        <button id="btnPromptEdit" class="btn btn-sm" type="button" title="编辑提示词">
            <i class="fa-solid fa-pen" aria-hidden="true"></i> 编辑
        </button>
    `;
}

/**
 * 重置元信息面板（资产 Tab 切换媒体时调用）
 */
function _resetMetaPanel() {
    if (els.metaWorkflow) els.metaWorkflow.textContent = '—';
    if (els.metaModel) els.metaModel.textContent = '—';
    if (els.metaLora) els.metaLora.textContent = '—';
    if (els.metaVae) els.metaVae.textContent = '—';
    if (els.metaSource) els.metaSource.textContent = '—';
    if (els.metaTool) els.metaTool.textContent = '—';
    if (els.metaMode) els.metaMode.textContent = '—';
    if (els.metaTiming) els.metaTiming.textContent = '—';
    if (els.metaVram) els.metaVram.textContent = '—';
    if (els.metaTs) els.metaTs.textContent = '—';
    // 默认隐藏可选项
    ['metaVaeRow', 'metaSourceRow', 'metaToolRow', 'metaModeRow', 'metaTimingRow', 'metaVramRow', 'metaTsRow'].forEach(k => {
        if (els[k]) els[k].style.display = 'none';
    });
    if (els.metaPlaceholder) {
        els.metaPlaceholder.style.display = 'block';
        els.metaPlaceholder.textContent = '点开「资产」Tab 下的图片/视频自动回显保存的工作流、模型、提示词等元数据';
    }
}

/**
 * 从资产 .meta.json 回显到右侧 Module 2 各行
 * @param {Object} meta  完整 sidecar JSON { ts, mime, size, filename, meta: {...} }
 */
function _populateMetaPanel(sidecar) {
    if (!sidecar) {
        if (els.metaPlaceholder) {
            els.metaPlaceholder.style.display = 'block';
            els.metaPlaceholder.textContent = '该资产没有保存的元数据（无 .meta.json 旁路文件）';
        }
        return;
    }
    const m = sidecar.meta || {};
    const wf = m.workflow || {};
    const timing = m.timing || {};
    const vram = m.vram || {};

    // 工作流（mode + tool）
    if (els.metaWorkflow) {
        const parts = [];
        if (m.mode) parts.push(m.mode.toUpperCase());
        if (m.toolName) parts.push(m.toolName);
        else if (m.toolId) parts.push(m.toolId);
        els.metaWorkflow.textContent = parts.length ? parts.join(' · ') : (wf.checkpoints && wf.checkpoints.length ? wf.checkpoints[0] : '—');
    }
    // 模型
    if (els.metaModel) {
        els.metaModel.textContent = (wf.checkpoints && wf.checkpoints.length) ? wf.checkpoints.join(', ') : '—';
    }
    // LORA
    if (els.metaLora) {
        if (wf.loras && wf.loras.length) {
            els.metaLora.textContent = wf.loras.map(l => {
                if (l.strengthModel != null && l.strengthClip != null && l.strengthModel !== l.strengthClip) {
                    return `${l.name}(m:${l.strengthModel}/c:${l.strengthClip})`;
                }
                if (l.strengthModel != null) return `${l.name}(${l.strengthModel})`;
                return l.name;
            }).join(', ');
        } else {
            els.metaLora.textContent = '—';
        }
    }
    // VAE
    if (wf.vaes && wf.vaes.length) {
        if (els.metaVaeRow) els.metaVaeRow.style.display = 'flex';
        if (els.metaVae) els.metaVae.textContent = wf.vaes.join(', ');
    }
    // 来源
    if (m.source) {
        if (els.metaSourceRow) els.metaSourceRow.style.display = 'flex';
        if (els.metaSource) {
            const map = { 'ai-tools': 'AI 工具' };
            els.metaSource.textContent = map[m.source] || m.source;
        }
    }
    // 工具
    if (m.toolName) {
        if (els.metaToolRow) els.metaToolRow.style.display = 'flex';
        if (els.metaTool) els.metaTool.textContent = `${m.toolName}${m.toolId ? ` (${m.toolId})` : ''}`;
    }
    // 模式
    if (m.mode) {
        if (els.metaModeRow) els.metaModeRow.style.display = 'flex';
        if (els.metaMode) els.metaMode.textContent = m.mode.toUpperCase();
    }
    // 耗时
    if (timing.elapsedMs != null && timing.elapsedMs > 0) {
        if (els.metaTimingRow) els.metaTimingRow.style.display = 'flex';
        if (els.metaTiming) {
            const sec = (timing.elapsedMs / 1000).toFixed(1);
            els.metaTiming.textContent = `${sec}s (${timing.elapsedMs}ms)`;
        }
    }
    // 显存峰值
    if (vram.peakBytes != null && vram.peakBytes > 0) {
        if (els.metaVramRow) els.metaVramRow.style.display = 'flex';
        if (els.metaVram) {
            const gb = vram.peakBytes / (1024 * 1024 * 1024);
            els.metaVram.textContent = gb >= 1 ? `${gb.toFixed(2)} GB` : `${(vram.peakBytes / (1024 * 1024)).toFixed(0)} MB`;
        }
    }
    // 生成时间
    if (sidecar.ts) {
        if (els.metaTsRow) els.metaTsRow.style.display = 'flex';
        if (els.metaTs) {
            try { els.metaTs.textContent = new Date(sidecar.ts).toLocaleString(); }
            catch { els.metaTs.textContent = String(sidecar.ts); }
        }
    }
    // 提示词回显（如果提示词库没记录，旁路里有时填入 Module 4）
    if (m.prompt && typeof m.prompt === 'string' && !_currentPrompt) {
        _currentPrompt = m.prompt;
        _renderPromptDisplay();
    }
    if (els.metaPlaceholder) els.metaPlaceholder.style.display = 'none';
}

/**
 * 显示媒体预览（图片/视频）—— 2026-06-08 重构为 4 模块
 */
function showMediaPreview(src, type, mediaId, fileName) {
    // 退出上一个预览时如有未保存编辑则冲刷
    if (_isEditingPrompt) {
        // 同步保存当前编辑内容
        _currentPrompt = els.promptTextarea.value;
    }
    if (_savePromptTimer) {
        clearTimeout(_savePromptTimer);
        _savePromptTimer = null;
        _saveMetaNow();
    }
    // 如果还在编辑模式强制退出（取消）
    if (_isEditingPrompt) _exitPromptEdit(false);

    els.previewModal.classList.add('active');

    if (type === 'image') {
        els.previewImage.src = src;
        els.previewImage.style.display = 'block';
        els.previewVideo.style.display = 'none';
        els.previewVideo.pause();
    } else if (type === 'video') {
        els.previewVideo.src = src;
        els.previewVideo.style.display = 'block';
        els.previewImage.style.display = 'none';
        els.previewVideo.play().catch(err => {
            console.warn('视频自动播放失败:', err);
        });
    }

    // Module 1: 文件名
    _previewMeta = { src, type, id: mediaId, fileName };
    els.promptFileName.textContent = fileName || '（未命名）';
    els.promptFileName.title = fileName || '';

    // 删除按钮：仅在「资产」Tab（锁定 Tab）下显示
    if (els.btnDeleteAsset) {
        const onAssetTab = state.activeTab === '__assets__';
        els.btnDeleteAsset.style.display = onAssetTab ? 'inline-flex' : 'none';
        els.btnDeleteAsset.disabled = false;
        els.btnDeleteAsset.innerHTML = '<i class="fa-solid fa-trash"></i> 删除资产';
    }

    // 视频生成 / 反推提示词：仅资源是图片时显示（视频资源无意义）
    const isImage = type === 'image';
    if (els.btnRefToVideo) els.btnRefToVideo.style.display = isImage ? 'inline-flex' : 'none';
    if (els.btnReversePrompt) els.btnReversePrompt.style.display = isImage ? 'inline-flex' : 'none';

    // Module 2: 重置 + 异步回显资产 .meta.json
    _resetMetaPanel();
    const isAssetTab = state.activeTab === '__assets__';
    if (isAssetTab && fileName && _hasElectronApi() && window.api.assets && window.api.assets.readMeta) {
        window.api.assets.readMeta(fileName).then(r => {
            // 切换到别的资产时丢弃旧响应
            if (_previewMeta && _previewMeta.fileName !== fileName) return;
            if (r && r.ok) _populateMetaPanel(r.meta);
            else _populateMetaPanel(null);
        }).catch(e => {
            console.warn('[assets.readMeta] 异常:', e && e.message);
            _populateMetaPanel(null);
        });
    }

    // Module 3 / 4: 加载
    _currentPreviewId = mediaId || null;
    _currentPrompt = '';
    _currentTags = [];
    _renderPromptDisplay();
    _renderTags();
    _setPromptStatus('加载中…', 'saving');
    if (mediaId) {
        readMediaMeta(mediaId).then(meta => {
            if (_currentPreviewId !== mediaId) return; // 已被切换
            _currentPrompt = meta.prompt || '';
            _currentTags = meta.tags || [];
            _renderPromptDisplay();
            _renderTags();
            _setPromptStatus('就绪', null);
        });
    } else {
        _setPromptStatus('就绪（无 ID）', null);
    }
}

/**
 * 加载本地媒体文件
 */
async function loadLocalMedia() {
 if ('showDirectoryPicker' in window) {
 try {
 const handle = await window.showDirectoryPicker({
 mode: 'read',
 types: [{
 description: 'Media Files',
 accept: {
 'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'],
 'video/*': ['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.wmv']
 }
 }]
 });
 //严重2：换数据源前先释放旧 blob URL
 revokeAllBlobUrls();
 state.localDirHandle = handle;
 state.sourceType = 'local';
 state.media = [];
 state.loadedCount =0;
 state.renderedIds.clear();
 els.gallery.innerHTML = '';
            
            initWaterfallColumns();
            
            els.scanLoading.classList.add('active');
            const scanResult = await scanDirectoryWithProgress(handle);
            state.media = scanResult.media;
            els.scanLoading.classList.remove('active');
            
            localStorage.setItem(CONFIG.storageKeys.sourceType, 'local');
            
            if (state.media.length === 0) {
                showToast('扫描完成，未找到可加载的媒体文件');
            } else {
                const imageCount = state.media.filter(m => m.type === 'image').length;
                const videoCount = state.media.filter(m => m.type === 'video').length;
                showToast(`扫描完成，共找到 ${imageCount} 张图片和 ${videoCount} 个视频，正在渲染...`);
            }
            
            await renderBatch();
            updateEmptyState();

        } catch (err) {
            els.scanLoading.classList.remove('active');
            if (err.name !== 'AbortError') {
                console.error('FileSystem API失败:', err);
                showToast('目录访问失败，切换到文件选择模式');
                els.fallbackInput.click();
            }
        }
    } else {
        els.fallbackInput.click();
    }
}

/**
 * 带进度的目录扫描函数（支持图片+视频）
 * 严重6：增加 maxDepth 限制，默认 10 层，与 NAS 对齐
 * 严重8：ID 改为基于 name+size+lastModified 的稳定哈希，不再使用 Date.now+随机串
 */
async function scanDirectoryWithProgress(dirHandle, maxDepth = 10, currentDepth = 1) {
    const media = [];
    let fileCount = 0;
    if (currentDepth > maxDepth) {
        console.warn(`达到最大扫描深度 ${maxDepth}，停止递归 ${dirHandle.name || ''}`);
        return { media, fileCount };
    }

    const entries = [];
    for await (const entry of dirHandle.values()) {
        entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (const entry of entries) {
        if (entry.kind === 'file') {
            const name = entry.name.toLowerCase();
            const ext = name.split('.').pop() || '';
            const mediaType = getMediaTypeByExt(ext);

            if (mediaType === 'image' || mediaType === 'video') {
                try {
                    const file = await entry.getFile();
                    const url = trackBlobUrl(URL.createObjectURL(file));
                    const uniqueId = stableId('local', file.name, String(file.size), String(file.lastModified));
                    media.push({
                        type: mediaType,
                        src: url,
                        id: uniqueId,
                        fileName: entry.name
                    });
                    fileCount++;
                } catch (err) {
                    console.error(`读取文件失败 ${entry.name}:`, err);
                }
            }
        } else if (entry.kind === 'directory') {
            // 递归扫描子目录（深度+1）
            const subDirResult = await scanDirectoryWithProgress(entry, maxDepth, currentDepth + 1);
            media.push(...subDirResult.media);
            fileCount += subDirResult.media.length;
        }
    }

    return { media, fileCount };
}

/**
 * 加载网络媒体文件
 */
function loadNetworkMedia(urls) {
 //严重2：换数据源前先释放旧 blob URL
 revokeAllBlobUrls();
 state.sourceType = 'network';
 state.media = [];
    state.loadedCount = 0;
    state.renderedIds.clear();
    els.gallery.innerHTML = '';
    
    initWaterfallColumns();
    
    // 处理URL列表
    const validUrls = urls.filter(url => url.trim()).map((url, index) => {
        const ext = url.split('.').pop()?.toLowerCase() || '';
        const mediaType = getMediaTypeByExt(ext);
        if (mediaType === 'unknown') return null;
        
        return {
            type: mediaType,
            src: url.trim(),
            id: `network-${index}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        };
    }).filter(Boolean);
    
    if (validUrls.length === 0) {
        showToast('未输入有效媒体URL');
        updateEmptyState();
        return;
    }
    
    state.media = validUrls;
    // 轻微13：存原始多行字符串，保留用户换行/空格排版
    localStorage.setItem(CONFIG.storageKeys.networkUrls, urls.join('\n'));
    localStorage.setItem(CONFIG.storageKeys.sourceType, 'network');
    
    const imageCount = validUrls.filter(m => m.type === 'image').length;
    const videoCount = validUrls.filter(m => m.type === 'video').length;
    showToast(`准备加载 ${imageCount} 张图片和 ${videoCount} 个视频`);
    
    renderBatch();
    updateEmptyState();
}

/**
 *加载NAS媒体库（重写：可取消 +缓存 + BFS并发）
 */

// ========== D-25 变更：统一 tab 加载器，支持 3 种 source.type ==========
async function _loadGalleryForTab(tab) {
    if (!tab || !tab.source) return;
    const src = tab.source;
    // 取 config 里的 active tab id，跟 state 对齐
    state.activeTab = tab.id;

    // 「资产」tab 是锁定 tab：路径从 __assets_config__ 动态解析
    if (tab.id === '__assets__') {
        if (!window.api || !window.api.config || typeof window.api.config.assetsGet !== 'function') {
            if (typeof showToast === 'function') showToast('资产存储接口不可用', 'error');
            return;
        }
        const ar = await window.api.config.assetsGet();
        if (!ar || !ar.ok) {
            if (typeof showToast === 'function') showToast('拉资产配置失败: ' + (ar && ar.error || '未知'), 'error');
            return;
        }
        const realPath = ar.resolvedDir || '';
        if (!realPath) {
            if (typeof showToast === 'function') showToast('资产目录未配置', 'error');
            return;
        }
        // 用 effective src 替换路径（不动原 tab 对象，避免污染缓存）
        const effSrc = { ...src, type: 'local', path: realPath };
        const effTab = { ...tab, source: effSrc };
        await _loadLocalOrNetworkTab(effTab);
        return;
    }

    if (src.type === 'nas') {
        // NAS：复用老的 loadNasGalleryByTab（构造一个假 tabId 参数）
        await loadNasGalleryByTab(tab.id);
        return;
    }

    await _loadLocalOrNetworkTab(tab);
}

// 抽出 local / network 的加载逻辑，给「资产」tab 复用（动态路径注入）
async function _loadLocalOrNetworkTab(tab) {
    const src = tab.source;
    if (state.nasScanController) {
        try { state.nasScanController.abort(); } catch (_) {}
        state.nasScanController = null;
    }
    state.nasScanEpoch += 1;
    state.isScanningNas = false;

    revokeAllBlobUrls();
    state.sourceType = src.type;
    state.media = [];
    state.loadedCount = 0;
    state.renderedIds.clear();
    state.preloadedMedia = [];
    els.gallery.innerHTML = '';
    initWaterfallColumns();

    if (typeof showToast === 'function') showToast(`正在加载 ${tab.name} ...`);
    const r = await window.api.config.loadResource(src);
    if (!r.ok) {
        if (typeof showToast === 'function') showToast('加载失败：' + r.error);
        updateEmptyState();
        return;
    }
    if (!r.media || r.media.length === 0) {
        if (typeof showToast === 'function') showToast(`${tab.name} 无可加载资源`);
        state.media = [];
        updateEmptyState();
        return;
    }
    state.media = r.media;
    await renderBatch();
    updateEmptyState();
    if (typeof showToast === 'function') {
        const img = r.media.filter(m => m.type === 'image').length;
        const vid = r.media.filter(m => m.type === 'video').length;
        showToast(`已加载 ${img} 张图片 / ${vid} 个视频`);
    }
}
window._galleryLoader = _loadGalleryForTab;

async function loadNasGalleryByTab(tabId) {
 // ========== D-25 变更：从 configUI 拿当前 tab 的 source ==========
 const _d25Tab = (window.configUI && window.configUI.getActiveTab && window.configUI.getActiveTab()) || null;
 if (!_d25Tab || !_d25Tab.source) { if (typeof showToast === 'function') showToast('该标签页暂无配置（请先在「配置」中设置）'); return; }
 if (_d25Tab.source.type !== 'nas') { if (typeof showToast === 'function') showToast('请用配置管理：此 Tab 资源类型已变'); return; }
 const nasConfig = _d25Tab.source; // 后面老代码引用 nasConfig（不会冲突，原 CONFIG.nasConfig[tabId] 已废弃）


 // ==========严重1：取消上一次仍在飞的扫描 ==========
 if (state.nasScanController) {
 try { state.nasScanController.abort(); } catch (_) {}
 state.nasScanController = null;
 }
 state.isScanningNas = false; // 让上一次递归尽快退出
 state.nasScanEpoch +=1; // 让上一次剩余回调的写入失效
 const myEpoch = state.nasScanEpoch;

 const controller = new AbortController();
 state.nasScanController = controller;

 //切 Tab 时清空旧内容并释放旧 blob URL（严重2）
 revokeAllBlobUrls();
 state.activeTab = tabId;
 state.media = [];
 state.loadedCount =0;
 state.renderedIds.clear();
 state.preloadedMedia = [];
 els.gallery.innerHTML = '';

 initWaterfallColumns();

 // [D-25] const nasConfig 改在函数头声明

 // ==========严重4：先查缓存 ==========
 const cached = await readNasCache(tabId);
 if (cached && cached.length >0 && !controller.signal.aborted) {
 state.media = cached;
 state.sourceType = 'nas';
 const imageCount = cached.filter(m => m.type === 'image').length;
 const videoCount = cached.filter(m => m.type === 'video').length;
 showToast(`NAS缓存命中：${imageCount} 张图片，${videoCount} 个视频`);
 await renderBatch();
 return;
 }

 state.isScanningNas = true;
 els.scanLoading.classList.add('active');

 try {
 const media = await scanNasBfs(nasConfig, controller.signal, (currentPath, depth) => {
 if (myEpoch !== state.nasScanEpoch) return; // 过期的进度回调直接忽略
 const label = els.scanLoading.querySelector('span');
 if (label) label.textContent = `正在扫描：${currentPath}（当前深度：${depth}）`;
 });

 if (myEpoch !== state.nasScanEpoch) return; // 自己已被更新的扫描取代
 if (controller.signal.aborted) return;

 state.media = media;
 state.sourceType = 'nas';

 if (state.media.length ===0) {
 showToast('NAS目录中未找到媒体文件');
 } else {
 const imageCount = state.media.filter(m => m.type === 'image').length;
 const videoCount = state.media.filter(m => m.type === 'video').length;
 showToast(`NAS加载完成：${imageCount} 张图片，${videoCount} 个视频`);
 //写缓存（不 await，避免阻塞渲染）
 writeNasCache(tabId, media);
 }

 await renderBatch();
 } catch (err) {
 if (err && err.name === 'AbortError') {
 console.log('NAS扫描已取消');
 } else {
 console.error('加载NAS失败:', err);
 showToast('NAS媒体加载失败，请检查连接');
 }
 } finally {
 if (myEpoch === state.nasScanEpoch) {
 state.isScanningNas = false;
 els.scanLoading.classList.remove('active');
 updateEmptyState();
 }
 }
}

/**
 * BFS 同层并发扫描 NAS目录（严重3）
 * - 同层并发=4，避免一次性拉爆 NAS服务
 * - 每层结束后才进入下一层，UI反馈更清晰
 * - 支持 signal 中断、超时8s
 */
async function scanNasBfs(nasConfig, signal, onProgress) {
 const concurrency =4;
 const perFetchTimeoutMs =8000;
 const collected = [];
 // BFS队列：每个元素是 [dirPath, depth]
 let frontier = [[nasConfig.rootDir,1]];

 while (frontier.length >0) {
 if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

 const nextFrontier = [];
 const seenDir = new Set();

 // 同层并发拉取
 const tasks = frontier.map(async ([dirPath, depth]) => {
 if (depth > nasConfig.maxDepth) return;
 if (signal.aborted) return;
 try {
 const dirUrl = `${nasConfig.nasBaseUrl}${dirPath}`;
 const res = await fetch(dirUrl, {
 credentials: 'omit', // 严重9：默认不发送 cookie，跨域 NAS 多半不支持 CORS 凭证
 signal,
 // 部分浏览器不支持 AbortSignal.timeout，这里手动兜底
 });
 if (!res.ok) return;
 //手动超时
 const html = await Promise.race([
 res.text(),
 new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), perFetchTimeoutMs)),
 ]);
 if (signal.aborted) return;

 const doc = new DOMParser().parseFromString(html, 'text/html');
 const links = Array.from(doc.querySelectorAll('a'));

 if (onProgress) onProgress(dirPath, depth);

 for (const link of links) {
 if (signal.aborted) return;
 const href = link.getAttribute('href');
 if (!href || href === '../') continue;
 const fullPath = dirPath + href;
 if (href.endsWith('/')) {
 if (!seenDir.has(fullPath)) {
 seenDir.add(fullPath);
 nextFrontier.push([fullPath, depth +1]);
 }
 } else {
 const ext = href.split('.').pop()?.toLowerCase() || '';
 if (nasConfig.imgExts && nasConfig.imgExts.includes(ext)) {
 collected.push({
 type: 'image',
 src: `${nasConfig.nasBaseUrl}${fullPath}`,
 id: `nas-${fullPath}`,
 fileName: href,
 });
 } else if (nasConfig.videoExts && nasConfig.videoExts.includes(ext)) {
 collected.push({
 type: 'video',
 src: `${nasConfig.nasBaseUrl}${fullPath}`,
 id: `nas-${fullPath}`,
 fileName: href,
 });
 }
 }
 }
 } catch (err) {
 if (err && err.name === 'AbortError') throw err;
 console.warn(`NAS目录 ${dirPath}扫描失败:`, err.message || err);
 }
 });

 // 控制同层并发
 await runWithConcurrency(tasks, concurrency);
 frontier = nextFrontier;
 }

 return collected;
}

async function runWithConcurrency(tasks, limit) {
 const results = new Array(tasks.length);
 let cursor =0;
 const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
 while (true) {
 const i = cursor++;
 if (i >= tasks.length) return;
 try { results[i] = await tasks[i](); } catch (err) { results[i] = err; }
 }
 });
 await Promise.all(workers);
 // 如果其中有 AbortError，向上抛
 for (const r of results) {
 if (r && r.name === 'AbortError') throw r;
 }
}

/**
 * 显示提示框
 */
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    
    // 触发动画
    setTimeout(() => toast.classList.add('show'), 10);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * 更新空状态显示
 */
function updateEmptyState() {
    if (state.media.length === 0 && !state.isLoading && !state.isScanningNas) {
        els.emptyState.style.display = 'block';
    } else {
        els.emptyState.style.display = 'none';
    }
}

/**
 * 检查滚动位置并加载更多
 */
function checkScrollAndLoad() {
    if (state.isLoading || state.loadedCount >= state.media.length) return;
    
    const sentinelRect = els.sentinel.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    
    // 当加载指示器进入视口底部200px范围内时加载更多
    if (sentinelRect.top < viewportHeight + 200) {
        renderBatch();
    }
}

/**
 * 绑定所有事件
 */
function bindEvents() {
    // 滑块控制
    els.slider.addEventListener('input', function() {
        state.imgWidth = parseInt(this.value);
        els.widthValue.textContent = `${state.imgWidth}px`;
        document.documentElement.style.setProperty('--img-width', `${state.imgWidth}px`);
        localStorage.setItem(CONFIG.storageKeys.imgWidth, state.imgWidth);
        
        // 重新初始化列并重新渲染
        initWaterfallColumns();
        state.loadedCount = 0;
        state.renderedIds.clear();
        state.preloadedMedia = [];
        if (state.media.length > 0) {
            renderBatch();
        }
    });

    // 滚动加载 — D-33: 加 rAF 节流，原实现滚动时每帧都调 checkScrollAndLoad（内部 getBoundingClientRect 同步 reflow）
    let _scrollTick = false;
    window.addEventListener('scroll', () => {
        if (_scrollTick) return;
        _scrollTick = true;
        requestAnimationFrame(() => {
            _scrollTick = false;
            checkScrollAndLoad();
        });
    }, { passive: true });
    let _resizeTimer = null;
    window.addEventListener('resize', () => {
        // D-33: 原版每次 resize 都立即全量重列，拖窗时同 1 帧多次触发。200ms debounce
        if (_resizeTimer) clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            initWaterfallColumns();
            state.loadedCount = 0;
            state.renderedIds.clear();
            state.preloadedMedia = [];
            if (state.media.length > 0) {
                renderBatch();
            }
        }, 200);
    });

    // 本地文件选择（D-31: btnLocal 已隐藏，加 null 守卫）
    if (els.btnLocal) els.btnLocal.addEventListener('click', loadLocalMedia);
    
    // 回退文件选择
 els.fallbackInput.addEventListener('change', async function(e) {
 const files = Array.from(this.files);
 if (files.length ===0) return;

 //严重2：换数据源前先释放旧 blob URL
 revokeAllBlobUrls();
 state.media = [];
        state.loadedCount = 0;
        state.renderedIds.clear();
        els.gallery.innerHTML = '';
        
        initWaterfallColumns();
        
        // 处理选中的文件
        for (const file of files) {
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            const mediaType = getMediaTypeByExt(ext);
            if (mediaType === 'unknown') continue;
            
 const url = trackBlobUrl(URL.createObjectURL(file));
 const uniqueId = `${Date.now()}-${file.name}-${Math.random().toString(36).substr(2,9)}`;
 state.media.push({
 type: mediaType,
 src: url,
 id: uniqueId,
 fileName: file.name
 });
        }
        
        if (state.media.length === 0) {
            showToast('未选择有效媒体文件');
        } else {
            const imageCount = state.media.filter(m => m.type === 'image').length;
            const videoCount = state.media.filter(m => m.type === 'video').length;
            showToast(`选择了 ${imageCount} 张图片和 ${videoCount} 个视频`);
        }
        
        state.sourceType = 'local';
        localStorage.setItem(CONFIG.storageKeys.sourceType, 'local');
        
        await renderBatch();
        updateEmptyState();
        
        // 清空input值，允许重新选择相同文件
        this.value = '';
    });

    // 网络媒体（D-31: btnNet 已隐藏，加 null 守卫）
    if (els.btnNet) els.btnNet.addEventListener('click', () => {
        // 轻微13：兼容旧版 JSON 数组格式，读取后保留换行
        const saved = localStorage.getItem(CONFIG.storageKeys.networkUrls);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                els.netInput.value = Array.isArray(parsed) ? parsed.join('\n') : parsed;
            } catch (_) {
                // 不是 JSON，说明本身就是字符串（新版格式或裸文本）
                els.netInput.value = saved;
            }
        }
        els.modal.classList.add('active');
    });
    
    els.btnCancelNet.addEventListener('click', () => {
        els.modal.classList.remove('active');
    });
    
    els.btnConfirmNet.addEventListener('click', () => {
        const urls = els.netInput.value.split('\n').filter(url => url.trim());
        loadNetworkMedia(urls);
        els.modal.classList.remove('active');
    });

    // ========= 预览弹窗事件绑定 =========
    // 关闭预览（冲刷未保存编辑 + 暂停视频）
    function _closePreview() {
        // 如果处于编辑模式，提示取消不保存
        if (_isEditingPrompt) {
            const ok = confirm('提示词还在编辑中，确定关闭不保存吗？');
            if (!ok) return;
            _exitPromptEdit(false);
        }
        if (_savePromptTimer) {
            clearTimeout(_savePromptTimer);
            _savePromptTimer = null;
            _saveMetaNow();
        }
        els.previewModal.classList.remove('active');
        els.previewVideo.pause();
        _currentPreviewId = null;
        _previewMeta = null;
    }
    els.closePreviewBtn.addEventListener('click', _closePreview);

    // 点击预览背景关闭
    els.previewModal.addEventListener('click', (e) => {
        if (e.target === els.previewModal) _closePreview();
    });

    // ESC 退出编辑/关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && els.previewModal.classList.contains('active')) {
            if (_isEditingPrompt) {
                e.preventDefault();
                _exitPromptEdit(false);
            } else {
                _closePreview();
            }
        }
    });

    // Module 1: 3 个动作按钮（参考生图仍为占位；视频生成 / 反推提示词已接 AI 工具）
    els.btnRefToImg.addEventListener('click', () => {
        if (!_previewMeta) return;
        showToast(`参考生图：将以「${_previewMeta.fileName}」为参考生成新图（后端待接）`);
    });
    // 视频生成 → 跳转 Wan2.2-SmoothMix-I2V（仅图片）
    els.btnRefToVideo.addEventListener('click', () => {
        if (!_previewMeta || _previewMeta.type !== 'image') return;
        _jumpToAiToolWithImage('Wan2.2-SmoothMix-I2V', 'start_image', '视频生成');
    });
    // 反推提示词 → 跳转 Prompt_Inversion（仅图片）
    els.btnReversePrompt.addEventListener('click', () => {
        if (!_previewMeta || _previewMeta.type !== 'image') return;
        _jumpToAiToolWithImage('Prompt_Inversion', 'image', '反推提示词');
    });

    // Module 1: 删除资产（仅资产 Tab 显示）
    els.btnDeleteAsset.addEventListener('click', () => {
        if (!_previewMeta || !_previewMeta.fileName) return;
        const fileName = _previewMeta.fileName;
        if (typeof window._showConfirm !== 'function') {
            // 兜底：万一 confirmModal 未注入，用原生 confirm
            if (!confirm(`确定删除资产「${fileName}」吗？该操作不可恢复。`)) return;
            _doDeleteAsset(fileName);
            return;
        }
        window._showConfirm({
            title: '删除资产',
            body: `确定删除资产「<strong>${fileName.replace(/</g, '&lt;')}</strong>」吗？<br><br>将同时删除 .meta.json 旁路元数据，<strong style="color:#dc2626;">该操作不可恢复</strong>。`,
            okText: '确认删除',
            onOk: () => _doDeleteAsset(fileName),
        });
    });

    async function _doDeleteAsset(fileName) {
        if (!_hasElectronApi() || !window.api.assets || typeof window.api.assets.delete !== 'function') {
            showToast('删除接口不可用', 'error');
            return;
        }
        const btn = els.btnDeleteAsset;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 删除中…'; }
        try {
            const r = await window.api.assets.delete(fileName);
            if (!r || !r.ok) {
                showToast('删除失败: ' + ((r && r.error) || '未知'), 'error');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除资产'; }
                return;
            }
            showToast('资产已删除', 'success');
            // 关闭预览 + 刷新当前 Tab（资产 Tab）
            _closePreview();
            if (window._galleryLoader && state.activeTab) {
                const tab = (window.configUI && window.configUI.getActiveTab && window.configUI.getActiveTab()) || null;
                if (tab) await window._galleryLoader(tab);
            }
        } catch (e) {
            showToast('删除异常: ' + (e && e.message || '未知'), 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除资产'; }
        }
    }

    // 从任意 tab 弹框跳转到 AI 工具并预填图片（通用 dataUrl 流）
    // toolId: 目标 schema id（如 'Wan2.2-SmoothMix-I2V' / 'Prompt_Inversion'）
    // imageFieldId: 目标工具中 type=image 的字段 id（如 'start_image' / 'image'）
    // actionName: 中文按钮名（用于 toast 显示）
    async function _jumpToAiToolWithImage(toolId, imageFieldId, actionName) {
        if (!_previewMeta) {
            showToast('缺少资源信息', 'error');
            return;
        }
        if (!_hasElectronApi()) {
            showToast('Electron API 不可用', 'error');
            return;
        }
        // 1) 把预览图（任意来源）转 dataUrl —— 兼容资产 tab、本地目录、网络 tab、blob URL
        let dataUrl;
        try {
            dataUrl = await _resolvePreviewImageAsDataUrl();
        } catch (e) {
            showToast(`${actionName}：${e && e.message || '图像加载失败'}`, 'error');
            return;
        }
        // 2) 关预览
        _closePreview();
        // 3) 跳转 + 预填（jumpToTool 内部调 stageImageData 写到 ComfyUI input 并填 comfyuiName）
        if (!window.aiTools || typeof window.aiTools.jumpToTool !== 'function') {
            showToast('AI 工具入口不可用', 'error');
            return;
        }
        showToast(`${actionName}：跳转到 AI 工具「${toolId}」...`, 'info');
        try {
            await window.aiTools.jumpToTool(toolId, {
                [imageFieldId]: { type: 'image', dataUrl },
            });
        } catch (e) {
            showToast(`跳转失败: ${e && e.message || '未知'}`, 'error');
        }
    }

    // 把当前预览图（_previewMeta.src，任意来源）转 dataUrl
    //   - 已是 data: → 直接返回
    //   - file: / blob: / http(s): → fetch → blob → FileReader
    //   - http(s) 跨域被浏览器拒绝时 → 回退到主进程 fetchImageToBase64（带 url 直接走 Node fetch）
    async function _resolvePreviewImageAsDataUrl() {
        const src = (_previewMeta && _previewMeta.src) || '';
        if (!src) throw new Error('无图像源');
        if (src.startsWith('data:')) return src;
        // 先尝试直 fetch（file/blob/同源 http 通常 OK）
        try {
            const r = await fetch(src);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const blob = await r.blob();
            return await _blobToDataUrl(blob);
        } catch (directErr) {
            // 跨域 http 走主进程代理
            if (/^https?:\/\//i.test(src) && window.api.comfyui && typeof window.api.comfyui.fetchImageToBase64 === 'function') {
                const r = await window.api.comfyui.fetchImageToBase64({ url: src });
                if (r && r.ok) return r.dataUrl;
                throw new Error('主进程下载失败: ' + ((r && r.error) || '未知'));
            }
            throw new Error(directErr && directErr.message || '图像加载失败');
        }
    }

    function _blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Base64 转换失败'));
            reader.readAsDataURL(blob);
        });
    }

    // 通用二次确认弹框（暴露到 window 供 Module 1 按钮复用）
    window._showConfirm = function ({ title, body, okText, onOk }) {
        if (!els.confirmModal) {
            // 兜底
            if (confirm(title + '\n\n' + (body || ''))) onOk && onOk();
            return;
        }
        els.confirmModalTitle.textContent = title || '确认';
        els.confirmModalBody.innerHTML = body || '';
        if (els.confirmModalOk) els.confirmModalOk.textContent = okText || '确认';
        // .media-preview-overlay 默认 opacity:0/visibility:hidden，需要 .active 才可见
        els.confirmModal.classList.add('active');
        els.confirmModal.style.display = 'flex';
        // 一次性监听：避免重复绑定叠加
        const okHandler = () => {
            els.confirmModal.classList.remove('active');
            els.confirmModal.style.display = 'none';
            cleanup();
            try { onOk && onOk(); } catch (e) { console.warn(e); }
        };
        const cancelHandler = () => {
            els.confirmModal.classList.remove('active');
            els.confirmModal.style.display = 'none';
            cleanup();
        };
        function cleanup() {
            els.confirmModalOk.removeEventListener('click', okHandler);
            els.confirmModalCancel.removeEventListener('click', cancelHandler);
            els.confirmModal.removeEventListener('click', bgHandler);
        }
        function bgHandler(e) {
            if (e.target === els.confirmModal) cancelHandler();
        }
        els.confirmModalOk.addEventListener('click', okHandler);
        els.confirmModalCancel.addEventListener('click', cancelHandler);
        els.confirmModal.addEventListener('click', bgHandler);
    };

    // Module 3: 标签
    els.btnTagAdd.addEventListener('click', () => {
        const v = els.tagsInput.value;
        els.tagsInput.value = '';
        _addTag(v);
        els.tagsInput.focus();
    });
    els.tagsInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            els.btnTagAdd.click();
        }
    });

    // Module 4: 提示词编辑（事件代理：避免 innerHTML 重建按钮后 listener 丢失）
    els.promptHeaderActions.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        if (t.id === 'btnPromptEdit') _enterPromptEdit();
        else if (t.id === 'btnPromptSave') _exitPromptEdit(true);
        else if (t.id === 'btnPromptCancel') _exitPromptEdit(false);
    });
    els.promptDisplay.addEventListener('dblclick', _enterPromptEdit); // 双击也能进编辑
    // Ctrl/Cmd+S 在编辑模式中保存
    els.promptTextarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            if (_isEditingPrompt) _exitPromptEdit(true);
        }
    });

    // Tab切换（轻微11：ARIA 同步 + 键盘导航）
    els.tabItems.forEach((tab, idx) => {
        const select = () => {
            els.tabItems.forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
                t.setAttribute('tabindex', '-1');
            });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            tab.setAttribute('tabindex', '0');
            loadNasGalleryByTab(tab.dataset.tab);
        };
        tab.addEventListener('click', select);
        tab.addEventListener('keydown', (e) => {
            let next = null;
            if (e.key === 'ArrowRight') next = els.tabItems[(idx + 1) % els.tabItems.length];
            else if (e.key === 'ArrowLeft') next = els.tabItems[(idx - 1 + els.tabItems.length) % els.tabItems.length];
            else if (e.key === 'Home') next = els.tabItems[0];
            else if (e.key === 'End') next = els.tabItems[els.tabItems.length - 1];
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); return; }
            if (next) { e.preventDefault(); next.focus(); select(); }
        });
    });

    // 初始化时触发一次滚动检查
    checkScrollAndLoad();
}

// 启动应用
window.addEventListener('DOMContentLoaded', init);
