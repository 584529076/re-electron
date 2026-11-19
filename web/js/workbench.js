// workbench.js — DWP 三栏 AI 创作工作台
//
// 结构：
//   [顶栏]   返回资产库 / 工具下拉 / ComfyUI 状态 / 查看历史 / 设置
//   [左栏]   提示词草稿 + 提示词生成器入口 + 上传字段
//   [中栏]   当前输出（空态 / 进度 / 结果）
//   [右栏]   工具 schema 表单 + 「立即生成」CTA
//   [覆盖层] dwpPromptGenHost：内嵌 prompt-gen 弹层
//
// 状态机：_state.toolId / _state.formValues / _state.midState
// 对外 API：window.workbench = { open, close, isOpen, setTool, applyFormToResult, focusPrompt }
'use strict';

(function () {
    const api = window.api || {};
    const dUtil = window.dUtil || { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) };
    const { escapeHtml, escapeAttr } = dUtil;

    const _state = {
        toolId: '',
        toolList: [],          // [{ id, name, mode, coverUrl, coverFallback, formFieldCount, fieldTypes, outputNodeTypes }]
        toolDetail: null,      // 当前选中工具完整 schema
        formValues: {},        // 收集的 formValues
        midState: 'idle',      // 'idle' | 'queued' | 'running' | 'done'
        midJobId: null,        // D-QUEUE：实际是 queueId（沿用字段名避免大改他处引用）
        midQueuePosition: -1,  // D-QUEUE：在 pending 队列中的位置（-1 不在 pending）
        midMeta: null,
        midResult: null,       // { kind, dataUrl, filename, mime, text, artifacts:[] }
        midArtifactIndex: 0,   // 2026-11 多产物翻页索引
        midQueueId: null,      // 2026-11 当前结果所属 queueId（落盘产物另存为用）
        midMode: 'preview',    // D-MID-COMPARE: 'preview' | 'compare'
        midCompareInput: null, // D-MID-COMPARE: { dataUrl, mime, sourcePath } 输入图缓存
        comfyStatus: null,     // { running, port, lastError }
        comfyUnsubs: [],
        // D-MID-AUTO-MATCH：缓存「所有」已知任务的 metadata + 结果（key = queueId）。
        // 不依赖 midJobId：当用户切工具 / 改表单时，按 tool_id + form_values 找一条 done 任务
        // 自动回显结果到中栏（解决「旧任务结果在切工具/改表单后消失」的体验问题）。
        // midJobId 仍负责当前正在跑/排队任务的进度联动；这两个 map 是独立的辅助层。
        midTasksByJobId: new Map(),     // queueId → { tool_id, form_values, status, tool_label, enqueued_at }
        midResultsByJobId: new Map(),   // queueId → { kind, dataUrl, mime, text, filename, meta }
    };

    // ========== 入口 ==========
    function open() {
        const wb = document.getElementById('workbench');
        if (!wb) return;
        wb.hidden = false;
        bindStaticEventsOnce();
        refreshComfyStatus().catch(() => {});
        subscribeComfyEvents();
        // D-MID-AUTO-MATCH：并行加载工具列表 + 历史任务 metadata，
        // 保证 setTool() 调用前 midTasksByJobId 已就绪（否则首次自动匹配会漏命中）
        Promise.all([
            loadToolList(),
            _loadInitialTasksForAutoMatch(),
        ]).then(() => {
            // 优先用上次选中的工具
            const lastId = localStorage.getItem('workbench.lastToolId') || '';
            if (lastId && _state.toolList.some(t => t.id === lastId)) {
                setTool(lastId);
            } else if (_state.toolList.length) {
                setTool(_state.toolList[0].id);
            }
        }).catch(err => console.error('[workbench] loadToolList:', err));
        try { window.dispatchEvent(new CustomEvent('workbench:opened')); } catch (e) {}
    }

    function close() {
        const wb = document.getElementById('workbench');
        if (wb) wb.hidden = true;
        cancelCurrentJob({ silent: true });
        if (_state.promptGenOpen) closePromptGenOverlay();
        try { window.dispatchEvent(new CustomEvent('workbench:closed')); } catch (e) {}
    }

    function isOpen() {
        const wb = document.getElementById('workbench');
        return !!(wb && !wb.hidden);
    }

    // ========== 顶部 + 全局静态事件 ==========
    let _staticBound = false;
    function bindStaticEventsOnce() {
        if (_staticBound) return;
        _staticBound = true;
        const btnHistory = document.getElementById('dwpBtnHistory');
        if (btnHistory) btnHistory.addEventListener('click', () => {
            // 2026-11：查看历史 = 打开工作台自己的任务队列抽屉（生成历史），
            // 不再跳到资产库页面。drawer 展示全部 pending/running/done/failed/cancelled 任务。
            if (window.taskQueue && typeof window.taskQueue.open === 'function') {
                window.taskQueue.open();
                return;
            }
            // 兜底：drawer 尚未就绪时，等 DOMContentLoaded 后再试一次
            const retry = () => {
                if (window.taskQueue && typeof window.taskQueue.open === 'function') window.taskQueue.open();
                else if (window.switchMainView) window.switchMainView('assets');
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true });
            else retry();
        });
        const toolSel = document.getElementById('dwpToolSelect');
        if (toolSel) toolSel.addEventListener('change', (e) => setTool(e.target.value));
        // 2026-11 方案 B：左侧工具 rail 点击切换（事件委托，rail 节点是静态的）
        const railList = document.getElementById('dwpToolRailList');
        if (railList) railList.addEventListener('click', (e) => {
            const item = e.target.closest('.dwp-tool-rail-item');
            if (!item || item.disabled) return;
            const id = item.getAttribute('data-tool-id');
            if (id) setTool(id);
        });
        const btnRun = document.getElementById('dwpBtnRun');
        if (btnRun) btnRun.addEventListener('click', runJob);
        const btnReset = document.getElementById('dwpBtnReset');
        if (btnReset) btnReset.addEventListener('click', () => {
            if (_state.toolDetail) {
                renderFormInto(_state.toolDetail);
                _state.formValues = {};
                updateRunButtonState();
            }
        });
        const btnCancel = document.getElementById('dwpBtnCancel');
        if (btnCancel) btnCancel.addEventListener('click', cancelCurrentJob);
        const btnPromptGen = document.getElementById('dwpBtnPromptGen');
        if (btnPromptGen) btnPromptGen.addEventListener('click', openPromptGenOverlay);
        const btnSaveAs = document.getElementById('dwpBtnSaveAs');
        if (btnSaveAs) btnSaveAs.addEventListener('click', saveResultAs);
        const btnReuse = document.getElementById('dwpBtnReuse');
        if (btnReuse) btnReuse.addEventListener('click', () => {
            if (!_state.toolDetail) return;
            runJob();
        });
        // 2026-11 图形化导入向导
        const btnImport = document.getElementById('dwpBtnImportWorkflow');
        if (btnImport) btnImport.addEventListener('click', openImportWizard);
        const wfClose = document.getElementById('wfImpClose');
        if (wfClose) wfClose.addEventListener('click', closeImportWizard);
        const wfPick = document.getElementById('wfImpPick');
        if (wfPick) wfPick.addEventListener('click', wizardPickFile);
        const wfBack = document.getElementById('wfImpBack');
        if (wfBack) wfBack.addEventListener('click', () => {
            const s1 = document.getElementById('wfImpStep1'), s2 = document.getElementById('wfImpStep2');
            if (s1) s1.hidden = false; if (s2) s2.hidden = true;
        });
        const wfSave = document.getElementById('wfImpSave');
        if (wfSave) wfSave.addEventListener('click', wizardSave);
        // D-MID-ZOOM：中栏图片滚轮缩放 + 拖拽平移（仅图片；视频/文本不生效）
        setupImageZoomOnce();
        // D-MID-COMPARE：预览/对比模式切换
        bindMidModeToggleOnce();
    }

    // ========== 中栏图片缩放 / 拖拽 ==========
    // 滚轮：以光标为中心放大/缩小；范围 [0.2, 10]
    // 左键拖拽：仅在已缩放时启用，把图片平移
    // 仅当 #dwpResultImage 当前可见（视频/文本时不响应）
    // 新图片加载完自动 reset（img load 事件）
    let _zoomInited = false;
    function setupImageZoomOnce() {
        if (_zoomInited) return;
        const host = document.querySelector('.dwp-media-host');
        const img = document.getElementById('dwpResultImage');
        const vid = document.getElementById('dwpResultVideo');
        if (!host || !img || !vid) return;
        _zoomInited = true;

        const MIN_SCALE = 0.2;
        const MAX_SCALE = 10;
        const STEP = 1.15;     // 每次滚轮缩放倍数
        const IMG_TRANSITION = 'transform 0.12s ease-out';

        let scale = 1, tx = 0, ty = 0;
        let dragging = false, dragStartX = 0, dragStartY = 0, startTx = 0, startTy = 0;

        function isImageActive() {
            // 仅在图片为当前结果时响应（视频 / 文本模式直接忽略）
            return !img.hidden && vid.hidden;
        }
        function apply() {
            img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
            const zoomed = scale !== 1 || tx !== 0 || ty !== 0;
            host.classList.toggle('dwp-zoomed', zoomed);
        }
        function reset() {
            scale = 1; tx = 0; ty = 0;
            apply();
        }
        function onWheel(e) {
            if (!isImageActive()) return;
            // 只响应垂直滚轮；左右滚轮不动（避免与水平滚动冲突）
            if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? STEP : 1 / STEP;
            const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
            if (next === scale) return;
            // 以光标为中心缩放：调整 translate 让光标下方的像素保持原位
            const rect = img.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = e.clientX - cx;
            const dy = e.clientY - cy;
            const ratio = next / scale;
            tx = dx - (dx - tx) * ratio;
            ty = dy - (dy - ty) * ratio;
            scale = next;
            apply();
        }
        function onMouseDown(e) {
            if (!isImageActive()) return;
            if (e.button !== 0) return;
            // 没缩放时不进入拖拽，避免误拦截（让点击能穿透到其它元素）
            if (scale === 1 && tx === 0 && ty === 0) return;
            e.preventDefault();
            dragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            startTx = tx;
            startTy = ty;
            host.classList.add('dwp-dragging');
            // 拖拽中关掉 transition，避免跟随感
            img.style.transition = 'none';
        }
        function onMouseMove(e) {
            if (!dragging) return;
            e.preventDefault();
            tx = startTx + (e.clientX - dragStartX);
            ty = startTy + (e.clientY - dragStartY);
            apply();
        }
        function onMouseUp() {
            if (!dragging) return;
            dragging = false;
            host.classList.remove('dwp-dragging');
            img.style.transition = IMG_TRANSITION;
        }
        function onImgLoad() {
            // 新图片加载完，重置缩放
            reset();
            img.style.transition = IMG_TRANSITION;
        }

        host.addEventListener('wheel', onWheel, { passive: false });
        host.addEventListener('mousedown', onMouseDown);
        // mousemove / mouseup 挂 document，保证光标移出 host 也能继续拖
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        img.addEventListener('load', onImgLoad);
        // 双击图片 reset（顺手的小工具）
        img.addEventListener('dblclick', reset);
    }

    // ========== 中栏模式切换（预览 / 对比） ==========
    // D-MID-COMPARE：仅当 result 是图片 + 输入图字段有值时，才能进入对比模式；
    // 进入对比模式后，输出图作为底图，输入图叠在上面用 clip-path 切左半；
    // 鼠标在内容区移动时按 cursor X 切分；鼠标移出 / 未进入时输入图完全 clip 不可见（只剩输出图）。
    let _midModeBound = false;
    function bindMidModeToggleOnce() {
        if (_midModeBound) return;
        const btnPreview = document.getElementById('dwpModePreview');
        const btnCompare = document.getElementById('dwpModeCompare');
        if (!btnPreview || !btnCompare) return;
        _midModeBound = true;
        btnPreview.addEventListener('click', () => setMidMode('preview'));
        btnCompare.addEventListener('click', () => {
            if (btnCompare.disabled) return;
            setMidMode('compare');
        });
        // 内容区 mouse 移动 / 进入 / 离开
        const host = document.querySelector('.dwp-media-host');
        if (host) {
            host.addEventListener('mouseenter', onCompareHostEnter);
            host.addEventListener('mousemove', onCompareHostMove);
            host.addEventListener('mouseleave', onCompareHostLeave);
        }
    }

    // 切模式：preview ↔ compare（仅在内部条件满足时可进入 compare）
    function setMidMode(mode) {
        if (mode !== 'preview' && mode !== 'compare') return;
        if (mode === 'compare' && !canEnterCompareMode()) return;
        _state.midMode = mode;
        const btnPreview = document.getElementById('dwpModePreview');
        const btnCompare = document.getElementById('dwpModeCompare');
        if (btnPreview && btnCompare) {
            btnPreview.classList.toggle('active', mode === 'preview');
            btnPreview.setAttribute('aria-selected', mode === 'preview' ? 'true' : 'false');
            btnCompare.classList.toggle('active', mode === 'compare');
            btnCompare.setAttribute('aria-selected', mode === 'compare' ? 'true' : 'false');
        }
        applyMidMode();
    }

    function canEnterCompareMode() {
        // 条件：当前 midResult 是图片 + 当前工具的 image 字段有值（多张取第一张）
        const r = _state.midResult;
        if (!r) return false;
        const isImage = r.kind === 'image' || (r.mime || '').startsWith('image/');
        if (!isImage) return false;
        const inputPath = _getFirstImageInputPath();
        return !!inputPath;
    }

    // 从左栏 formFields 中找第一个 image 字段，取其 dataset.sourcePath
    function _getFirstImageInputPath() {
        if (!_state.toolDetail) return '';
        const fields = _state.toolDetail.formFields || [];
        for (const f of fields) {
            if (!f) continue;
            if (f.type !== 'image') continue;
            const el = document.getElementById('at-field-' + f.id);
            if (!el) continue;
            const v = (el.value || '').trim();
            if (!v) continue;
            const p = el.dataset && el.dataset.sourcePath ? el.dataset.sourcePath : '';
            return p || v; // 拿不到 sourcePath 退化用 value（如果是绝对路径也能用）
        }
        return '';
    }

    function applyMidMode() {
        const host = document.querySelector('.dwp-media-host');
        const img = document.getElementById('dwpResultImage');
        const vid = document.getElementById('dwpResultVideo');
        if (!host || !img || !vid) return;
        const isImage = !img.hidden && vid.hidden;
        if (_state.midMode === 'compare' && isImage) {
            ensureCompareOverlay();
            host.classList.add('dwp-compare');
            // 加载输入图（异步）；完成后会激活 overlay
            loadCompareInputImage();
        } else {
            host.classList.remove('dwp-compare');
            host.classList.remove('dwp-compare-active');
            const overlay = host.querySelector('.dwp-compare-input-wrap');
            if (overlay) overlay.style.clipPath = 'inset(0 100% 0 0)';
        }
    }

    function ensureCompareOverlay() {
        const host = document.querySelector('.dwp-media-host');
        if (!host) return;
        if (host.querySelector('.dwp-compare-input-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'dwp-compare-input-wrap';
        wrap.style.clipPath = 'inset(0 100% 0 0)';
        const inputImg = document.createElement('img');
        inputImg.className = 'dwp-compare-input';
        inputImg.alt = '对比输入';
        wrap.appendChild(inputImg);
        const divider = document.createElement('div');
        divider.className = 'dwp-compare-divider';
        divider.innerHTML = '<div class="dwp-compare-handle"><i class="fa-solid fa-arrows-left-right"></i></div>';
        const labelIn = document.createElement('div');
        labelIn.className = 'dwp-compare-label label-input';
        labelIn.textContent = '原图';
        const labelOut = document.createElement('div');
        labelOut.className = 'dwp-compare-label label-output';
        labelOut.textContent = '生成';
        // 顺序：底图（输出）在 #dwpResultImage，已存在；上层 wrap -> divider -> 标签
        host.appendChild(wrap);
        host.appendChild(divider);
        host.appendChild(labelIn);
        host.appendChild(labelOut);
    }

    async function loadCompareInputImage() {
        const path = _getFirstImageInputPath();
        if (!path || !api.comfyui || typeof api.comfyui.imageReadAsDataUrl !== 'function') return;
        const host = document.querySelector('.dwp-media-host');
        if (!host) return;
        const wrap = host.querySelector('.dwp-compare-input-wrap');
        const inputImg = wrap ? wrap.querySelector('img.dwp-compare-input') : null;
        if (!inputImg) return;
        // 如果已缓存同路径，直接复用
        if (_state.midCompareInput && _state.midCompareInput.sourcePath === path && _state.midCompareInput.dataUrl) {
            inputImg.src = _state.midCompareInput.dataUrl;
            return;
        }
        inputImg.removeAttribute('src');
        try {
            const r = await api.comfyui.imageReadAsDataUrl({ path });
            if (r && r.ok && r.dataUrl) {
                _state.midCompareInput = { sourcePath: path, dataUrl: r.dataUrl, size: r.size };
                // 可能用户已切回 preview，做个二次校验
                if (_state.midMode === 'compare' && _state.midResult && _state.midResult.kind === 'image') {
                    inputImg.src = r.dataUrl;
                }
            }
        } catch (e) {
            console.warn('[workbench] loadCompareInputImage 失败:', e && e.message);
        }
    }

    function onCompareHostEnter() {
        if (_state.midMode !== 'compare') return;
        const host = document.querySelector('.dwp-media-host');
        if (host) host.classList.add('dwp-compare-active');
    }
    function onCompareHostMove(e) {
        if (_state.midMode !== 'compare') return;
        const host = document.querySelector('.dwp-media-host');
        const wrap = host && host.querySelector('.dwp-compare-input-wrap');
        const divider = host && host.querySelector('.dwp-compare-divider');
        if (!host || !wrap) return;
        const rect = host.getBoundingClientRect();
        if (!rect.width) return;
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const pct = (x / rect.width) * 100;
        // 输入图被 clip 切左：从右侧开始裁掉 (100 - pct)%，保留左 pct%
        wrap.style.clipPath = `inset(0 ${Math.max(0, 100 - pct).toFixed(2)}% 0 0)`;
        if (divider) {
            divider.style.left = pct.toFixed(2) + '%';
        }
    }
    function onCompareHostLeave() {
        if (_state.midMode !== 'compare') return;
        const host = document.querySelector('.dwp-media-host');
        const wrap = host && host.querySelector('.dwp-compare-input-wrap');
        if (!host || !wrap) return;
        // 鼠标离开：完全 clip 输入图，只剩输出图
        wrap.style.clipPath = 'inset(0 100% 0 0)';
        host.classList.remove('dwp-compare-active');
    }

    // 暴露给其他模块：表单值变化后通知刷新对比按钮可点状态
    function refreshCompareAvailability() {
        const btnCompare = document.getElementById('dwpModeCompare');
        if (!btnCompare) return;
        const ok = canEnterCompareMode();
        btnCompare.disabled = !ok;
        btnCompare.title = ok ? '切换到对比模式（左：原图，右：生成）' : '需要输入图 + 当前输出是图片才能对比';
        // 如果当前就在 compare 但条件不再满足，强制回 preview
        if (_state.midMode === 'compare' && !ok) {
            setMidMode('preview');
        }
    }
    async function loadToolList() {
        if (!api.tools || typeof api.tools.list !== 'function') {
            _state.toolList = [];
            renderToolSelect();
            return;
        }
        const r = await api.tools.list();
        _state.toolList = (r && r.ok) ? (r.tools || []) : [];
        renderToolSelect();
    }

    function renderToolSelect() {
        const sel = document.getElementById('dwpToolSelect');
        // 兼容旧下拉框（hidden 但仍保留，供外部 get/set 引用）
        if (sel) {
            if (!_state.toolList.length) {
                sel.innerHTML = '<option value="">（暂无可用工具）</option>';
                sel.disabled = true;
            } else {
                sel.disabled = false;
                sel.innerHTML = _state.toolList.map(t => {
                    const bad = !!t.broken;
                    const label = escapeHtml(t.name || t.id) + (t.mode ? ' · ' + escapeHtml(t.mode.toUpperCase()) : '');
                    return `<option value="${escapeAttr(t.id)}"${bad ? ' disabled' : ''}>${bad ? '⚠ ' : ''}${label}${bad ? '（不可用）' : ''}</option>`;
                }).join('');
                if (_state.toolId) sel.value = _state.toolId;
            }
        }
        // 2026-11 方案 B：左侧工具 rail
        renderToolRail();
    }

    // 2026-11 方案 B：渲染左侧竖排工具 rail
    function renderToolRail() {
        const list = document.getElementById('dwpToolRailList');
        const count = document.getElementById('dwpToolRailCount');
        if (!list) return;
        if (count) count.textContent = _state.toolList.length ? String(_state.toolList.length) : '';
        if (!_state.toolList.length) {
            list.innerHTML = '<div class="dwp-tool-rail-empty">暂无工具<br>点上方「导入工作流」添加</div>';
            return;
        }
        list.innerHTML = _state.toolList.map(t => {
            const bad = !!t.broken;
            const active = t.id === _state.toolId;
            const icon = (t.coverUrl && !bad)
                ? `<img src="${escapeAttr(t.coverUrl)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='\\u2728';">`
                : `<i class="fa-solid ${bad ? 'fa-triangle-exclamation' : escapeAttr((t.coverFallback && t.coverFallback.icon) || 'fa-wand-magic-sparkles')}"></i>`;
            const mode = String(t.mode || 'sfw').toUpperCase();
            const name = escapeHtml(t.name || t.id) + (bad ? ' ⚠' : '');
            return `<button type="button" class="dwp-tool-rail-item${active ? ' active' : ''}" data-tool-id="${escapeAttr(t.id)}"${bad ? ' disabled title="' + escapeAttr(t.error || '工具损坏') + '"' : ''} aria-pressed="${active}">
                <span class="dwp-tool-rail-icon">${icon}</span>
                <span class="dwp-tool-rail-meta"><span class="dwp-tool-rail-name" title="${escapeAttr(t.name || t.id)}">${name}</span><span class="dwp-tool-rail-mode ${escapeAttr(mode.toLowerCase())}">${escapeHtml(mode)}${bad ? ' · 不可用' : ''}</span></span>
            </button>`;
        }).join('');
        _scrollRailToActive();
    }

    // 切换工具后同步 rail 选中态并滚动到可见
    function _syncToolRailSelection() {
        const list = document.getElementById('dwpToolRailList');
        if (!list) return;
        list.querySelectorAll('.dwp-tool-rail-item').forEach(el => {
            const active = el.getAttribute('data-tool-id') === _state.toolId;
            el.classList.toggle('active', active);
            el.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        _scrollRailToActive();
    }
    function _scrollRailToActive() {
        const list = document.getElementById('dwpToolRailList');
        if (!list) return;
        const active = list.querySelector('.dwp-tool-rail-item.active');
        if (active && typeof active.scrollIntoView === 'function') {
            try { active.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        }
    }

    // ========== 2026-11 图形化导入工作流向导 ==========
    let _wizardDraft = null; // { filePath, workflow, schema, preview }
    function openImportWizard() {
        const modal = document.getElementById('wfImportModal');
        if (!modal) { console.warn('[workbench] 导入向导 DOM 不存在'); return; }
        modal.style.display = 'flex';
        modal.classList.add('active');
        const s1 = document.getElementById('wfImpStep1'), s2 = document.getElementById('wfImpStep2');
        if (s1) s1.hidden = false; if (s2) s2.hidden = true;
        const msg = document.getElementById('wfImpPickMsg'); if (msg) msg.textContent = '';
        _wizardDraft = null;
        // 2026-11 用户期望：点「导入工作流」直接拉起资源管理器，
        // 选完文件再进向导（字段勾选/改名），跳过第 1 步手动再点一次。
        wizardPickFile();
    }
    function closeImportWizard() {
        const modal = document.getElementById('wfImportModal');
        if (modal) { modal.classList.remove('active'); modal.style.display = 'none'; }
        _wizardDraft = null;
    }
    async function wizardPickFile() {
        const msg = document.getElementById('wfImpPickMsg');
        if (!api.tools || typeof api.tools.pickWorkflowFile !== 'function') {
            if (msg) msg.textContent = '当前环境不支持导入（接口不可用）';
            return;
        }
        if (msg) { msg.style.color = '#6b7280'; msg.textContent = '正在读取…'; }
        try {
            const r = await api.tools.pickWorkflowFile();
            if (!r || !r.ok) { if (msg) { msg.style.color = '#dc2626'; msg.textContent = (r && r.error) || '读取失败'; } return; }
            if (r.canceled) { closeImportWizard(); return; } // 用户取消选文件 → 关闭弹窗
            const gen = await api.tools.generateSchema({ workflow: r.workflow, id: r.suggestedId, name: r.suggestedId });
            if (!gen || !gen.ok) { if (msg) { msg.style.color = '#dc2626'; msg.textContent = (gen && gen.error) || '解析失败'; } return; }
            _wizardDraft = { filePath: r.filePath, workflow: r.workflow, schema: gen.schema, preview: gen.preview };
            renderWizardDraft();
        } catch (e) {
            if (msg) { msg.style.color = '#dc2626'; msg.textContent = '导入失败: ' + (e && e.message); }
        }
    }
    function renderWizardDraft() {
        const d = _wizardDraft; if (!d) return;
        const s1 = document.getElementById('wfImpStep1'), s2 = document.getElementById('wfImpStep2');
        if (s1) s1.hidden = true; if (s2) s2.hidden = false;
        const idI = document.getElementById('wfImpId'); if (idI) idI.value = d.schema.id || '';
        const nameI = document.getElementById('wfImpName'); if (nameI) nameI.value = d.schema.name || '';
        const modeI = document.getElementById('wfImpMode'); if (modeI) modeI.value = d.schema.mode || 'sfw';
        const p = d.preview || {};
        const summary = document.getElementById('wfImpSummary');
        if (summary) summary.innerHTML = `识别到 <b>${p.nodeCount || 0}</b> 个节点、<b>${(p.formFields || []).length}</b> 个可编辑字段；输出节点 <b>${(p.outputNodes || []).length}</b> 个。节点类型：${escapeHtml((p.nodeTypes || []).slice(0, 8).join('、') || '—')}`;
        const fieldsBox = document.getElementById('wfImpFields');
        if (fieldsBox) {
            fieldsBox.innerHTML = (p.formFields || []).length
                ? p.formFields.map((f, i) => `<label style="display:flex; gap:8px; align-items:flex-start; padding:5px 2px; font-size:12px; cursor:pointer;">
                     <input type="checkbox" data-wf-field="${i}" checked style="margin-top:2px;">
                     <span><b>${escapeHtml(f.label || f.id)}</b> <span style="color:#9ca3af;">· ${escapeHtml(f.type)} · 节点 ${escapeHtml(f.nodeId)}.${escapeHtml(f.field)}</span>${f.note ? `<br><span style="color:#9ca3af;">${escapeHtml(f.note)}</span>` : ''}</span>
                   </label>`).join('')
                : '<div style="color:#9ca3af; padding:10px; font-size:12px;">未识别到标准可编辑节点；可在生成后手动编辑 schema.json 补充 formFields</div>';
        }
        const outs = document.getElementById('wfImpOutputs');
        if (outs) outs.innerHTML = '输出：' + ((p.outputNodes || []).map(o => `${escapeHtml(o.nodeId)} → ${escapeHtml(o.type)}`).join('、') || '<span style="color:#dc2626;">未识别，请手动指定</span>');
        const warn = document.getElementById('wfImpWarn');
        if (warn) warn.innerHTML = (p.warnings || []).map(w => '⚠ ' + escapeHtml(w)).join('<br>');
    }
    async function wizardSave() {
        const d = _wizardDraft; if (!d) return;
        const btn = document.getElementById('wfImpSave');
        if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
        try {
            const id = (document.getElementById('wfImpId').value || '').trim();
            const name = (document.getElementById('wfImpName').value || '').trim();
            const mode = document.getElementById('wfImpMode').value;
            const schema = JSON.parse(JSON.stringify(d.schema));
            schema.id = id; schema.name = name || id; schema.mode = mode;
            // 只保留用户勾选的字段
            const checks = Array.from(document.querySelectorAll('#wfImpFields input[data-wf-field]'));
            const chosen = new Set(checks.filter(c => c.checked).map(c => Number(c.getAttribute('data-wf-field'))));
            schema.formFields = (d.preview.formFields || []).filter((f, i) => chosen.has(i));
            const r = await api.tools.import({ ...schema, workflow: d.workflow });
            if (!r || !r.ok) { showToast('导入失败: ' + ((r && r.error) || '未知'), 'error'); return; }
            closeImportWizard();
            await loadToolList();
            if (r.tool && !r.tool.broken) {
                await setTool(r.tool.id);
                showToast('已导入并启用：' + (r.tool.name || id), 'success');
            } else {
                showToast('已导入，但校验有问题：' + (r.error || '请检查 schema'), 'error');
            }
        } catch (e) {
            showToast('导入失败: ' + (e && e.message), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存并启用'; }
        }
    }

    // ========== 切换工具 ==========
    async function setTool(toolId) {
        if (!toolId) return;
        if (_state.toolId === toolId && _state.toolDetail) {
            return; // noop
        }
        // 注意：切工具 ≠ 取消正在跑的任务。任务的生命周期由任务队列引擎串行管理，
        // 工作台这里只切换「输入表单」和「当前要用的工具 ID」。原任务继续在队列里跑，
        // 用户可以回原工具看进度，也可以从右侧抽屉看。
        _state.toolId = toolId;
        _state.toolDetail = null;
        _state.formValues = {};
        try { localStorage.setItem('workbench.lastToolId', toolId); } catch (e) {}
        const sel = document.getElementById('dwpToolSelect');
        if (sel) sel.value = toolId;
        _syncToolRailSelection();
        if (!api.tools || typeof api.tools.get !== 'function') return;
        const r = await api.tools.get(toolId);
        if (!r || !r.ok) {
            const desc = document.getElementById('dwpToolDescription');
            if (desc) desc.textContent = (r && r.error) || '加载工具失败';
            return;
        }
        _state.toolDetail = r.tool;
        const desc = document.getElementById('dwpToolDescription');
        if (desc) desc.textContent = _state.toolDescription();
        renderFormInto(_state.toolDetail);
        // 表单换了：对比输入图缓存作废。
        // midState / midResult / midJobId 保留：这些字段跟着队列里的任务走，
        // 跟当前选的工具没关系，不应该因为切工具就被清掉。
        _state.midCompareInput = null;
        updateMidStage();
        updateRunButtonState();
        // D-MID-AUTO-MATCH：切完工具后立即检查当前 tool + form 是否匹配某条历史任务
        // —— 切回原工具/原表单能立即看到上次结果，不必重跑
        _refreshMidResultForCurrentState();
    }

    _state.toolDescription = function () {
        const t = _state.toolDetail;
        if (!t) return '请选择工具';
        return (t.description || '') + (t.mode ? ` · ${t.mode.toUpperCase()}` : '');
    };

    // ========== 表单渲染 ==========
    function renderFormInto(tool) {
        const primary = document.getElementById('dwpFormPrimary');
        const sizeBox = document.getElementById('dwpFormSize');
        const sizeBody = sizeBox ? sizeBox.querySelector('.dwp-form-size-body') : null;
        const params = document.getElementById('dwpFormParams');
        if (!primary || !params) return;

        // 清空三栏
        primary.innerHTML = '';
        if (sizeBody) sizeBody.innerHTML = '';
        if (sizeBox) sizeBox.hidden = true;
        params.innerHTML = '';

        if (!tool || tool.broken) {
            primary.innerHTML = `<div class="dwp-form-empty">工具加载失败：${escapeHtml((tool && tool.error) || '未知')}</div>`;
            return;
        }

        const api = window.aiToolsEmbedded;
        if (!api || typeof api.renderEmbeddedFormSections !== 'function') {
            primary.innerHTML = '<div class="dwp-form-empty">AI 工具模块未就绪</div>';
            return;
        }
        let sections;
        try {
            sections = api.renderEmbeddedFormSections(tool);
        } catch (e) {
            console.error('[workbench] renderEmbeddedFormSections 失败:', e);
            primary.innerHTML = `<div class="dwp-form-empty">表单渲染失败：${escapeHtml(e.message || String(e))}</div>`;
            return;
        }

        // 左栏：主输入（textarea / image / video），无则显示空态
        if (sections.primary.trim()) {
            primary.innerHTML = sections.primary;
        } else {
            primary.innerHTML = '<div class="dwp-form-empty"><i class="fa-regular fa-keyboard"></i><span>此工具无需额外输入素材</span></div>';
        }

        // 中栏底部：尺寸控件（width + height），仅当工具同时有这两个字段时显示
        if (sections.size.trim() && sizeBody) {
            sizeBody.innerHTML = sections.size;
            if (sizeBox) sizeBox.hidden = false;
        }

        // 右栏：参数微调
        if (sections.params.trim()) {
            params.innerHTML = sections.params;
        } else {
            params.innerHTML = '<div class="dwp-form-empty"><i class="fa-solid fa-sliders"></i><span>此工具无额外参数</span></div>';
        }

        // D-WORKBENCH-PICKIMAGE：renderEmbeddedFormSections 只产 HTML，不绑事件；
        // 这里主动调 bindFormActions 把 pick-image / pick-loras / randomize / clear-* 全部接上。
        // 同时 initLoraFields 异步加载 lora select 选项 + 渲染 loraMulti 初始 chip。
        const displayModels = (Array.isArray(tool.models) && tool.models.length)
            ? tool.models
            : (tool.mainModel ? [tool.mainModel] : []);
        const allContainers = [primary, sizeBody, params].filter(Boolean);
        for (const c of allContainers) {
            try {
                if (typeof api.bindFormActions === 'function') {
                    api.bindFormActions(c, tool.formFields || [], displayModels);
                }
            } catch (e) {
                console.warn('[workbench] bindFormActions 失败:', e && e.message);
            }
        }
        try {
            if (typeof api.initLoraFields === 'function') {
                api.initLoraFields(tool, displayModels);
            }
        } catch (e) {
            console.warn('[workbench] initLoraFields 失败:', e && e.message);
        }

        // D-WORKBENCH-LORA-MODULE：把 lora / loraMulti 字段的原始 DOM（select + chips + 按钮）
        // 从右栏 params 里隐藏，由独立 LORA 模块接管 UI。
        // 隐藏策略：对 params 容器下所有包含 lora 字段 id 的直接子 div 套上 display:none，
        // 但保留原始 DOM 节点（id、dataset、event listener 全保留），
        // 这样 ai-tools 内部的 _loraMultiState / select 监听 / collectFormValues 都还能工作。
        const loraIds = (tool.formFields || [])
            .filter(f => f && (f.type === 'lora' || f.type === 'loraMulti'))
            .map(f => f.id);
        if (loraIds.length && params) {
            const loraIdSet = new Set(loraIds);
            const hideWrap = document.createElement('div');
            hideWrap.className = 'dwp-lora-originals-hidden';
            hideWrap.style.cssText = 'display:none !important;';
            // 找到 params 的直接子 div 里包含 at-field-{loraId} 的那些，移动到 hideWrap
            const directChildren = Array.from(params.children);
            for (const child of directChildren) {
                if (!child.querySelector) continue;
                let isLora = false;
                for (const id of loraIds) {
                    if (child.querySelector('#at-field-' + id) || child.querySelector(`[data-field-id="${id}"]`)) {
                        isLora = true;
                        break;
                    }
                }
                if (isLora) hideWrap.appendChild(child);
            }
            if (hideWrap.childElementCount > 0) {
                params.appendChild(hideWrap);
            }
        }

        // 挂 LORA 独立模块到右栏顶部
        if (typeof window.workbenchLoras !== 'undefined' && typeof window.workbenchLoras.mount === 'function' && params) {
            try {
                window.workbenchLoras.mount(tool, displayModels, params);
            } catch (e) {
                console.warn('[workbench] LORA 模块挂载失败:', e && e.message);
            }
        }

        // 监听三栏的 input/change 同步按钮 enable
        const containers = [primary, sizeBody, params].filter(Boolean);
        for (const c of containers) {
            if (c._dwpBound) continue;
            c._dwpBound = true;
            c.addEventListener('input', () => {
                _state.formValues = collectForm();
                updateRunButtonState();
                // D-MID-COMPARE：image 字段变化 → 刷新对比按钮可用性 + 重载输入图缓存
                refreshCompareAvailability();
                if (_state.midMode === 'compare') {
                    _state.midCompareInput = null; // 路径变了，下次渲染前重新加载
                    loadCompareInputImage();
                }
                // D-MID-AUTO-MATCH：表单输入后检查是否匹配某条 done 任务
                // （已 debounce 150ms，连续输入不会频繁触发匹配检查）
                _refreshMidResultForCurrentState();
            });
            c.addEventListener('change', () => {
                _state.formValues = collectForm();
                updateRunButtonState();
                refreshCompareAvailability();
                if (_state.midMode === 'compare') {
                    _state.midCompareInput = null;
                    loadCompareInputImage();
                }
                // D-MID-AUTO-MATCH：select / checkbox 变化立即检查
                _refreshMidResultForCurrentState();
            });
        }
        _state.formValues = collectForm();
        // 表单换工具后立即刷新一次
        refreshCompareAvailability();
    }

    function collectForm() {
        if (!_state.toolDetail) return {};
        if (window.aiToolsEmbedded && typeof window.aiToolsEmbedded.collectFormValues === 'function') {
            try {
                // 字段分布在三个容器，但 collectFormValues 用 document 兜底查询即可
                return window.aiToolsEmbedded.collectFormValues(null, _state.toolDetail) || {};
            } catch (e) {
                console.warn('[workbench] collectFormValues 失败:', e);
                return {};
            }
        }
        return {};
    }

    // ========== 提示词：写入左栏 textarea ==========
    // 提示词 textarea 现在按工具动态渲染在 #dwpFormPrimary；写入后通知表单重算 + 同步按钮。
    function applyPromptToForm(text) {
        if (!_state.toolDetail) {
            showToast('请先选择工具', 'error');
            return;
        }
        const fields = _state.toolDetail.formFields || [];
        // 1) 找第一个 textarea 字段，写入 text
        const target = fields.find(f => f && f.type === 'textarea') || fields.find(f => f && f.type === 'text');
        if (!target) {
            showToast('该工具没有可写入的提示词字段', 'error');
            return;
        }
        const el = document.getElementById('at-field-' + target.id);
        if (el) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        _state.formValues = collectForm();
        updateRunButtonState();
    }

    // 找到左栏主输入区里的 prompt textarea（供 focus / 提示词生成器回填）
    function _primaryPromptEl() {
        if (!_state.toolDetail) return null;
        const fields = _state.toolDetail.formFields || [];
        const target = fields.find(f => f && f.type === 'textarea');
        return target ? document.getElementById('at-field-' + target.id) : null;
    }

    // ========== 提示词生成器弹层（ComfyPromptStudio 嵌入版）==========
    // 点击入口后，把 CPS 的完整界面以 iframe 形式铺进 host；CPS 点「采用提示词」
    // 时通过 postMessage 把 positive 回传，这里写入左栏 textarea，回到原链路。
    let _cpsMsgBound = false;
    function openPromptGenOverlay() {
        const host = document.getElementById('dwpPromptGenHost');
        if (!host) return;
        host.hidden = false;
        _state.promptGenOpen = true;

        // 复用已创建的 iframe
        let frame = host.querySelector('iframe.cps-frame');
        if (!frame) {
            frame = document.createElement('iframe');
            frame.className = 'cps-frame';
            frame.src = '../cps-embed/ui/index.html?embed=1';
            frame.setAttribute('allow', 'clipboard-read; clipboard-write');
            frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#0e0f12;';
            host.appendChild(frame);
        }
        frame.style.display = '';

        // 监听 CPS 消息（只绑定一次）：回传提示词 / 请求关闭
        if (!_cpsMsgBound) {
            _cpsMsgBound = true;
            window.addEventListener('message', (ev) => {
                const d = ev.data;
                if (!d) return;
                // 只接受来自 CPS iframe 的消息
                const f = host.querySelector('iframe.cps-frame');
                if (!f || ev.source !== f.contentWindow) return;

                // CPS 左上角「关闭提示词生成器」按钮 → 返回工作台
                if (d.type === 'cps:close') {
                    closePromptGenOverlay();
                    return;
                }
                // CPS「保存到库」→ 把正向/负向/参数写入提示词库的自定义配方
                if (d.type === 'cps:saveToLibrary') {
                    (async () => {
                        try {
                            const payload = {
                                id: 'U' + Date.now().toString(36).toUpperCase(),
                                name: String(d.name || '未命名'),
                                desc: String(d.desc || ''),
                                model: (d.param && d.param.model) || '',
                                positive: String(d.positive || ''),
                                negative: String(d.negative || ''),
                                param: d.param || null
                            };
                            let r = { ok: false };
                            if (window.api && window.api.recipes && window.api.recipes.save) {
                                r = await window.api.recipes.save(payload);
                            }
                            if (r && r.ok) {
                                showToast('已保存到提示词库：' + payload.name, 'success');
                            } else {
                                showToast('保存失败：' + ((r && r.error) || '未知原因'), 'error');
                            }
                        } catch (e) {
                            showToast('保存失败：' + (e && e.message), 'error');
                        }
                    })();
                    return;
                }
                if (d.type !== 'cps:prompt') return;

                const text = String(d.positive || '');
                const el = _primaryPromptEl();
                if (el) {
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (_state.toolDetail) {
                    _state.formValues = collectForm();
                    updateRunButtonState();
                }
                showToast(d.negative ? '已填入提示词（含负向，见 CPS 面板）' : '已填入提示词', 'success');
                closePromptGenOverlay();
            });
        }
    }

    function closePromptGenOverlay() {
        const host = document.getElementById('dwpPromptGenHost');
        if (!host) return;
        host.hidden = true;
        const frame = host.querySelector('iframe.cps-frame');
        if (frame) frame.style.display = 'none';
        _state.promptGenOpen = false;
    }

    // ========== 中栏状态机 ==========
    function updateMidStage() {
        const empty = document.getElementById('dwpOutputEmpty');
        const running = document.getElementById('dwpOutputRunning');
        const media = document.getElementById('dwpOutputMedia');
        if (!empty || !running || !media) return;
        const subtitle = document.getElementById('dwpOutputSubtitle');
        if (_state.midState === 'running') {
            empty.hidden = true;
            running.hidden = false;
            media.hidden = true;
            // 切到 running 时强制回 preview
            _state.midMode = 'preview';
            applyMidMode();
            refreshCompareAvailability();
            _hideMidQueueBadge();
            if (subtitle) subtitle.textContent = '正在生成中…';
        } else if (_state.midState === 'queued') {
            // D-QUEUE：保持上次结果继续可见（重要：避免用户以为旧任务被取消）。
            // 没有上次结果时退回空态显示。
            const pos = (_state.midQueuePosition != null && _state.midQueuePosition >= 0)
                ? _state.midQueuePosition + 1 : null;
            if (_state.midResult) {
                empty.hidden = true;
                running.hidden = true;
                media.hidden = false;
                renderResult(_state.midResult);
                if (subtitle) {
                    subtitle.textContent = pos
                        ? `新任务已加入队列（第 ${pos} 位）· 当前展示的是上次结果`
                        : '新任务已加入队列 · 当前展示的是上次结果';
                }
                // 在中栏右上角显示排队徽标
                _ensureMidQueueBadge(pos);
            } else {
                empty.hidden = false;
                running.hidden = true;
                media.hidden = true;
                _state.midMode = 'preview';
                applyMidMode();
                refreshCompareAvailability();
                if (subtitle) {
                    subtitle.textContent = pos
                        ? `已加入队列（第 ${pos} 位）`
                        : '已加入队列';
                }
                _ensureMidQueueBadge(pos);
            }
        } else if (_state.midState === 'done' && _state.midResult) {
            empty.hidden = true;
            running.hidden = true;
            media.hidden = false;
            renderResult(_state.midResult);
            _hideMidQueueBadge();
            if (subtitle) subtitle.textContent = '生成完成，可以继续修改后重新生成';
        } else {
            empty.hidden = false;
            running.hidden = true;
            media.hidden = true;
            // idle 时也强制回 preview
            _state.midMode = 'preview';
            applyMidMode();
            refreshCompareAvailability();
            _hideMidQueueBadge();
            if (subtitle) subtitle.textContent = '生成结果会显示在这里';
        }
        // 立即生成 / 重新生成 / 另存为 的显隐依赖生成状态
        updateActionButtons();
    }

    // D-QUEUE：中栏顶部「排队中」徽标（仅当有旧结果时挂出来提示新任务排队中）
    let _midQueueBadgeEl = null;
    function _ensureMidQueueBadge(pos) {
        if (!_midQueueBadgeEl) {
            const head = document.querySelector('.dwp-output-column .dwp-column-head');
            if (!head) return;
            _midQueueBadgeEl = document.createElement('span');
            _midQueueBadgeEl.className = 'dwp-mid-queue-badge';
            _midQueueBadgeEl.setAttribute('role', 'status');
            head.appendChild(_midQueueBadgeEl);
        }
        _midQueueBadgeEl.textContent = pos ? `排队中 #${pos}` : '排队中';
        _midQueueBadgeEl.hidden = false;
    }
    function _hideMidQueueBadge() {
        if (_midQueueBadgeEl) _midQueueBadgeEl.hidden = true;
    }

    // 右栏生成栏按钮显隐 + 文字：
    //   D-QUEUE：队列机制下任务并发由后端串行控制，前端不需要禁用「立即生成」。
    //   idle / queued / running 三态都允许点击入队，按钮文案区分：
    //     idle          → 「立即生成」（首次入队）
    //     queued/running → 「再排一个」（追加到队列）
    //   done：隐藏「立即生成」，显示「重新生成」+「另存为」
    function updateActionButtons() {
        const btnRun = document.getElementById('dwpBtnRun');
        const btnReuse = document.getElementById('dwpBtnReuse');
        const btnSaveAs = document.getElementById('dwpBtnSaveAs');
        const hasResult = _state.midState === 'done' && !!_state.midResult;
        const isBusy = _state.midState === 'running' || _state.midState === 'queued';
        if (btnRun) {
            btnRun.hidden = hasResult;
            if (!hasResult) {
                btnRun.disabled = false; // 队列机制下不再禁用
                if (isBusy) {
                    btnRun.innerHTML = '<i class="fa-solid fa-layer-group"></i> 再排一个';
                } else {
                    // idle：复位文字 + 普通图标
                    btnRun.innerHTML = '<i class="fa-solid fa-palette"></i> 立即生成';
                    // 没内容时 updateRunButtonState 会禁用
                    updateRunButtonState();
                }
            }
        }
        if (btnReuse) btnReuse.hidden = !hasResult;
        if (btnSaveAs) btnSaveAs.hidden = !hasResult;
    }

    function renderResult(result) {
        const img = document.getElementById('dwpResultImage');
        const vid = document.getElementById('dwpResultVideo');
        const text = document.getElementById('dwpResultText');
        const meta = document.getElementById('dwpResultMeta');
        if (!img || !vid || !text || !meta) return;
        img.hidden = true; img.removeAttribute('src');
        vid.hidden = true; vid.removeAttribute('src');
        text.hidden = true; text.value = '';
        if (result.kind === 'text') {
            text.hidden = false;
            text.value = result.text || '';
            meta.textContent = `文本结果 · ${(result.text || '').length} 字符`;
        } else if ((result.mime || '').startsWith('video/')) {
            vid.hidden = false;
            // 2026-11 流式：优先 fileUrl（本地文件），回退 dataUrl
            vid.src = result.fileUrl || result.dataUrl || '';
            meta.textContent = `${result.filename || 'video'} · ${result.mime}`;
        } else {
            img.hidden = false;
            img.src = result.fileUrl || result.dataUrl || '';
            const sizeKB = result.size ? Math.round(result.size / 1024) : 0;
            meta.textContent = `${result.filename || 'image'} · ${result.mime || 'image/png'}${sizeKB ? ' · ' + sizeKB + ' KB' : ''}`;
        }
        // D-MID-COMPARE：新结果来后刷新对比按钮可点状态 + 强制回 preview（避免残留状态）
        _state.midMode = 'preview';
        const btnPreview = document.getElementById('dwpModePreview');
        const btnCompare = document.getElementById('dwpModeCompare');
        if (btnPreview && btnCompare) {
            btnPreview.classList.add('active');
            btnPreview.setAttribute('aria-selected', 'true');
            btnCompare.classList.remove('active');
            btnCompare.setAttribute('aria-selected', 'false');
        }
        applyMidMode();
        refreshCompareAvailability();
    }

    // ========== 运行 / 取消 ==========
    function updateRunButtonState() {
        const btn = document.getElementById('dwpBtnRun');
        if (!btn) return;
        const hasContent = !!_state.toolDetail && hasAnyFormContent();
        // D-QUEUE：队列机制下 midState=running/queued 时按钮不再禁用（允许继续入队），
        // 仅当「没有工具」或「表单没填」时才置灰。
        btn.disabled = !hasContent;
        // 必填主输入未填时，给 #dwpRunMeta 一行灰色提示，避免误以为按钮坏了
        const meta = document.getElementById('dwpRunMeta');
        if (meta && _state.midState === 'idle' && !hasContent && _state.toolDetail) {
            const missing = _missingRequiredAssets();
            if (missing.length) {
                meta.textContent = `请先选择 ${missing.join(' / ')}`;
                meta.style.color = '#94a3b8';
            }
        }
    }

    // 列出当前工具里「image/video/file」主输入字段里还没填的（required 优先，按字段 label 报名字）
    function _missingRequiredAssets() {
        if (!_state.toolDetail) return [];
        const missing = [];
        for (const f of _state.toolDetail.formFields || []) {
            if (!f) continue;
            if (f.type !== 'image' && f.type !== 'video' && f.type !== 'file') continue;
            if (!f.required) continue;
            const el = document.getElementById('at-field-' + f.id);
            if (el && (el.value || '').trim()) continue;
            if (f.type === 'image' || f.type === 'video') {
                const card = document.querySelector(
                    `.dwp-asset-card[data-asset-card="${CSS.escape(f.id)}"]`
                );
                if (card) {
                    const cs = window.getComputedStyle(card);
                    if (cs.display !== 'none' && cs.visibility !== 'hidden') continue;
                }
            }
            missing.push(f.label || (f.type === 'image' ? '图片' : f.type === 'video' ? '视频' : '文件'));
        }
        return missing;
    }

    function hasAnyFormContent() {
        if (!_state.toolDetail) return false;
        for (const f of _state.toolDetail.formFields || []) {
            if (!f) continue;
            // 主路径：任意字段的隐藏 input.value 非空即视为「有内容」。
            // 这样 number/seed、select 默认选项、lora 选中、文本字段都能算上，
            // 不再因为「只有 image 字段但还没选」就拒绝整个按钮。
            // 主输入字段（textarea/image/video/file）保持原判定的语义：
            //   - 没填：value 为空，按钮置灰（除非其它字段填了）
            //   - 填了：value 非空，按钮启用
            const el = document.getElementById('at-field-' + f.id);
            if (el && (el.value || '').trim()) return true;
            // 兜底：dwp-asset-module 的 .dwp-asset-card 显隐也算「已选」。
            if (f.type === 'image' || f.type === 'video') {
                const card = document.querySelector(
                    `.dwp-asset-card[data-asset-card="${CSS.escape(f.id)}"]`
                );
                if (card) {
                    const cs = window.getComputedStyle(card);
                    if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
                }
            }
        }
        return false;
    }

    async function runJob() {
        if (!_state.toolDetail) return;
        _state.formValues = collectForm();
        const btn = document.getElementById('dwpBtnRun');
        const meta = document.getElementById('dwpRunMeta');
        if (meta) { meta.textContent = '正在准备...'; meta.style.color = '#0ea5e9'; }
        // 走任务队列：先看 ComfyUI 是否在跑，没跑就顺手启动（队列本身也会启动，这里只是给用户更快反馈）
        await refreshComfyStatus();
        if (!_state.comfyStatus || !_state.comfyStatus.running) {
            if (meta) meta.textContent = 'ComfyUI 未启动，正在自动启动...';
            if (api.comfyui && typeof api.comfyui.start === 'function') {
                const sr = await api.comfyui.start({});
                if (!sr || !sr.ok) {
                    if (meta) { meta.textContent = 'ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'); meta.style.color = '#dc2626'; }
                    showToast('ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'), 'error');
                    return;
                }
                await refreshComfyStatus();
            }
        }
        // 透明入队；立刻返回 queueId，前端显示「已加入队列（第 N 位）」
        const r = await api.taskQueue.enqueue({ toolId: _state.toolId, formValues: _state.formValues });
        if (!r || !r.ok) {
            _state.midState = 'idle';
            updateMidStage();
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-palette"></i> 立即生成'; }
            if (meta) { meta.textContent = '提交失败: ' + ((r && r.error) || '未知'); meta.style.color = '#dc2626'; }
            showToast('运行失败: ' + ((r && r.error) || '未知'), 'error');
            return;
        }
        _state.midJobId = r.queueId;          // 实际是 queueId（沿用字段名）
        _state.midQueuePosition = (r.position != null) ? r.position : -1;
        _state.midState = (r.position === 0) ? 'running' : 'queued';
        updateMidStage();
        setProgress(0, _state.midState === 'queued' ? '已加入队列' : '提交任务...');
        // D-QUEUE：不再强制置灰 + spinner。updateActionButtons 已经按 midState 更新按钮。
        // 用户可以继续点「再排一个」往队列里追加。
        if (meta) {
            const pos = _state.midQueuePosition + 1;
            meta.textContent = _state.midState === 'queued'
                ? `已加入队列（第 ${pos} 位）`
                : '提交任务...';
            meta.style.color = '#0ea5e9';
        }
    }

    async function cancelCurrentJob(opts) {
        const silent = opts && opts.silent;
        // D-QUEUE：取消走 taskQueue.cancel（midJobId 实际存的是 queueId）
        if (_state.midJobId && api.taskQueue && typeof api.taskQueue.cancel === 'function') {
            try { await api.taskQueue.cancel(_state.midJobId); } catch (e) {}
        } else if (_state.midJobId && api.comfyui && typeof api.comfyui.cancel === 'function') {
            // 兜底：老 comfyui 端取消接口（理论不会跑到这里）
            try { await api.comfyui.cancel(_state.midJobId); } catch (e) {}
        }
        _state.midJobId = null;
        _state.midQueuePosition = -1;
        if (!silent) {
            _state.midState = 'idle';
            updateMidStage();
            const btn = document.getElementById('dwpBtnRun');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-palette"></i> 立即生成'; }
            const meta = document.getElementById('dwpRunMeta');
            if (meta) { meta.textContent = '已取消'; meta.style.color = '#94a3b8'; }
        }
    }

    function setProgress(ratio, text) {
        const bar = document.getElementById('dwpProgressBar');
        if (bar) bar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
        const t = document.getElementById('dwpProgressText');
        if (t) t.textContent = text || '';
    }

    // ========== ComfyUI 状态 / 事件 ==========
    async function refreshComfyStatus() {
        // 仅用于内部状态判定（runJob 自动启动 ComfyUI 时用）。
        // ComfyUI 状态徽章已迁移到公共导航栏右侧（#navComfyStatus），此处不再维护 DOM。
        try {
            _state.comfyStatus = await api.comfyui && api.comfyui.status ? await api.comfyui.status() : null;
        } catch (e) {
            _state.comfyStatus = null;
        }
    }

    function subscribeComfyEvents() {
        // D-QUEUE：原 comfyui:event:* 渠道已迁到 taskQueue:event:update；
        // 这里只订阅队列事件即可（每个 queueId 全程由队列引擎串行分配 / 收尾）。
        for (const u of _state.comfyUnsubs) { try { u && u(); } catch (e) {} }
        _state.comfyUnsubs = [];
        if (!api.taskQueue || typeof api.taskQueue.onUpdate !== 'function') {
            console.warn('[workbench] subscribeComfyEvents: api.taskQueue.onUpdate not available');
            return;
        }
        _state.comfyUnsubs.push(api.taskQueue.onUpdate(_handleQueueEvent));
    }

    function _handleQueueEvent(ev) {
        if (!ev || !ev.queueId) return;

        // D-MID-AUTO-MATCH：'added' 事件绕过 midJobId 过滤，缓存所有任务的 metadata。
        // 用于「当前 tool + form 是否匹配某条历史任务」的检测 —— 不依赖当前 midJobId。
        if (ev.type === 'added' && ev.task) {
            _cacheTaskFromEvent(ev.queueId, ev.task);
            return;
        }

        // 'result' 事件：所有任务的结果都缓存到 midResultsByJobId（懒加载索引），
        // 只有 ev.queueId === _state.midJobId 的结果才真正渲染到中栏。
        if (ev.type === 'result') {
            _handleResultEvent(ev);
            return;
        }

        // 'status' / 'progress'：只关心当前正在跑的任务，避免旧任务的回调误触发 UI。
        if (ev.queueId !== _state.midJobId) return;

        if (ev.type === 'status') {
            const s = ev.status;
            if (s === 'running') {
                _state.midState = 'running';
                setProgress(0, '生成中...');
                const meta = document.getElementById('dwpRunMeta');
                if (meta) { meta.textContent = '生成中...'; meta.style.color = '#0ea5e9'; }
                updateMidStage();
            } else if (s === 'failed' || s === 'cancelled') {
                _state.midJobId = null;
                _state.midQueuePosition = -1;
                _state.midState = 'idle';
                updateMidStage();
                const btn = document.getElementById('dwpBtnRun');
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-palette"></i> 立即生成'; }
                const meta = document.getElementById('dwpRunMeta');
                if (meta) {
                    const msg = s === 'cancelled' ? '已取消' : ('错误: ' + (ev.error_msg || '未知'));
                    meta.textContent = msg;
                    meta.style.color = s === 'cancelled' ? '#94a3b8' : '#dc2626';
                }
                if (s === 'failed') showToast('ComfyUI: ' + (ev.error_msg || '失败'), 'error');
            }
        } else if (ev.type === 'progress') {
            const max = ev.max || 1;
            const v = ev.value || 0;
            setProgress(v / max, `采样中 ${v}/${max}`);
        }
    }

    // D-MID-AUTO-MATCH：从 'added' 事件里把 task metadata 塞进 midTasksByJobId
    // form_values 可能是 JSON 字符串或已解析对象，这里统一转成对象
    function _cacheTaskFromEvent(qid, task) {
        let fv = task.form_values;
        if (typeof fv === 'string') {
            try { fv = JSON.parse(fv); } catch (e) { fv = {}; }
        }
        if (!fv || typeof fv !== 'object') fv = {};
        _state.midTasksByJobId.set(qid, {
            tool_id: task.tool_id,
            form_values: fv,
            status: task.status,
            tool_label: task.tool_label,
            enqueued_at: task.enqueued_at,
        });
    }

    // D-MID-AUTO-MATCH：处理 'result' 事件 —— 读 result dataUrl，缓存到 map，
    // 仅当 queueId === midJobId 时才把结果塞进 _state.midResult 并更新中栏。
    async function _handleResultEvent(ev) {
        const qid = ev.queueId;
        try {
            // 2026-11 多产物：优先用 resultItems 拿全量产物列表（含落盘路径）
            const result = await _loadResultForTask(qid);
            if (!result) {
                console.warn('[workbench] result read failed qid=', qid);
                return;
            }
            // 缓存到所有任务索引（自动匹配按需取用）
            _state.midResultsByJobId.set(qid, result);
            const t = _state.midTasksByJobId.get(qid);
            if (t) t.status = 'done';

            // 只渲染当前任务的结果到中栏
            if (qid !== _state.midJobId) return;

            _applyResultToMid(result, qid);
        } catch (e) {
            console.warn('[workbench] result read failed:', e.message);
            if (qid === _state.midJobId) {
                _state.midState = 'idle';
                updateMidStage();
            }
        }
    }

    // 2026-11：加载任务的完整结果（多产物），返回统一 shape
    // { kind, dataUrl, filename, mime, text, meta, artifacts:[{kind,dataUrl,mime,filename,text}] }
    async function _loadResultForTask(qid) {
        if (api.taskQueue && typeof api.taskQueue.resultItems === 'function') {
            try {
                const r = await api.taskQueue.resultItems(qid);
                if (r && r.ok && Array.isArray(r.items) && r.items.length) {
                    const artifacts = r.items.map(it => ({
                        kind: it.kind || (it.dataUrl || it.fileUrl ? (it.mime || '').startsWith('video/') ? 'video' : 'image' : 'text'),
                        dataUrl: it.dataUrl || '',
                        fileUrl: it.fileUrl || '',
                        mime: it.mime || 'image/png',
                        filename: it.filename || '',
                        text: it.text || '',
                        size: it.size || 0,
                    }));
                    const first = artifacts[0];
                    return {
                        kind: first.kind, dataUrl: first.dataUrl, fileUrl: first.fileUrl,
                        filename: first.filename, mime: first.mime, text: first.text, meta: {}, artifacts,
                    };
                }
            } catch (e) { /* 回退老接口 */ }
        }
        // 回退：老 resultReadAsDataUrl 单产物接口
        if (api.taskQueue && typeof api.taskQueue.resultReadAsDataUrl === 'function') {
            const r = await api.taskQueue.resultReadAsDataUrl(qid);
            if (!r || !r.ok) return null;
            const kind = r.kind || (r.dataUrl ? 'image' : 'text');
            return {
                kind, dataUrl: r.dataUrl || '', filename: '',
                mime: r.mime || 'image/png', text: r.text || '', meta: {},
                artifacts: [{ kind, dataUrl: r.dataUrl || '', mime: r.mime || 'image/png', text: r.text || '', filename: '' }],
            };
        }
        return null;
    }

    // 把结果渲染到中栏并更新状态 + 自动存档
    async function _applyResultToMid(result, qid) {
        _state.midResult = result;
        _state.midQueueId = qid || null;
        _state.midJobId = null;
        _state.midQueuePosition = -1;
        _state.midState = 'done';
        _state.midArtifactIndex = 0;
        renderResult(result);
        updateMidStage();
        _renderArtifactNav();
        const meta = document.getElementById('dwpRunMeta');
        const artCount = (result.artifacts || []).length;
        if (meta) {
            meta.textContent = '完成 · ' + (result.kind === 'text' ? '文本输出' : (artCount > 1 ? `${artCount} 个产物` : '产物已生成'));
            meta.style.color = '#059669';
        }
        const btn = document.getElementById('dwpBtnRun');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-palette"></i> 立即生成'; }
        showToast('生成完成', 'success');
        try {
            await autoSaveSidecar({
                dataUrl: result.dataUrl || '', mime: result.mime || 'image/png',
                meta: result.meta || {}, kind: result.kind, text: result.text || '', filename: result.filename || '',
            }, result.kind);
        } catch (e) { /* 兜底，静默失败 */ }
    }

    // 2026-11 多产物：中栏产物翻页导航（仅当 >1 个产物时显示）
    function _renderArtifactNav() {
        let nav = document.getElementById('dwpArtifactNav');
        const host = document.getElementById('dwpOutputStage');
        const result = _state.midResult;
        const total = result && result.artifacts ? result.artifacts.length : 0;
        if (!host) return;
        if (total <= 1) { if (nav) nav.remove(); return; }
        if (!nav) {
            nav = document.createElement('div');
            nav.id = 'dwpArtifactNav';
            nav.style.cssText = 'position:absolute; bottom:8px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:10px; background:rgba(15,23,42,.75); color:#fff; border-radius:20px; padding:5px 12px; font-size:12px; z-index:5;';
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
            host.appendChild(nav);
        }
        const idx = _state.midArtifactIndex || 0;
        nav.innerHTML = `<button type="button" data-artifact="prev" style="background:none;border:none;color:#fff;cursor:pointer;font-size:15px;">‹</button>`
            + `<span>${idx + 1} / ${total}</span>`
            + `<button type="button" data-artifact="next" style="background:none;border:none;color:#fff;cursor:pointer;font-size:15px;">›</button>`;
        nav.querySelectorAll('button').forEach(b => {
            b.onclick = () => {
                const dir = b.getAttribute('data-artifact') === 'next' ? 1 : -1;
                _state.midArtifactIndex = (idx + dir + total) % total;
                const a = result.artifacts[_state.midArtifactIndex];
                if (a) {
                    _state.midResult = { ..._state.midResult, ...a };
                    renderResult(_state.midResult);
                    _renderArtifactNav();
                }
            };
        });
    }

    async function autoSaveSidecar(payload, kind) {
        if (kind !== 'image' || !payload || !payload.dataUrl) return;
        if (!api.comfyui || typeof api.comfyui.saveAsset !== 'function') return;
        try {
            const m = payload.meta || {};
            let promptText = '';
            for (const f of (_state.toolDetail && _state.toolDetail.formFields) || []) {
                if (f && f.type === 'textarea' && typeof _state.formValues[f.id] === 'string') {
                    promptText = _state.formValues[f.id];
                    break;
                }
            }
            const meta = {
                toolId: _state.toolId,
                toolName: (_state.toolDetail && _state.toolDetail.name) || _state.toolId,
                mode: (_state.toolDetail && _state.toolDetail.mode) || (m.mode || 'sfw'),
                prompt: promptText,
                formValues: _state.formValues,
                workflow: {
                    checkpoints: (m.models && m.models.checkpoints) || [],
                    loras: (m.models && m.models.loras) || [],
                    vaes: (m.models && m.models.vaes) || [],
                },
                timing: { elapsedMs: m.elapsedMs || 0, startedAt: m.startedAt || null },
                vram: { peakBytes: m.vramPeakBytes || 0 },
                source: 'workbench',
            };
            const stem = `${_state.toolId}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
            const r = await api.comfyui.saveAsset({
                filename: stem,
                mime: payload.mime || 'image/png',
                dataUrl: payload.dataUrl,
                meta,
            });
            if (r && r.ok) console.log('[workbench] 自动存档:', r.assetPath);
        } catch (e) {
            console.warn('[workbench] autoSaveSidecar:', e && e.message);
        }
    }

    // ========== 另存为 ==========
    function saveResultAs() {
        if (!_state.midResult) return;
        const r = _state.midResult;
        // 2026-11 落盘产物：优先走零内存 file-copy 路径（含多产物当前索引）
        if (_state.midQueueId && api.taskQueue && typeof api.taskQueue.resultSaveAs === 'function') {
            const hasFileArtifact = (r.artifacts || []).some(a => a.fileUrl || a.dataUrl) || r.fileUrl;
            if (hasFileArtifact && r.kind !== 'text') {
                api.taskQueue.resultSaveAs({
                    queueId: _state.midQueueId,
                    index: _state.midArtifactIndex || 0,
                }).then(out => {
                    if (out && out.canceled) return;
                    if (out && out.ok) showToast('已保存到 ' + (out.path || '本地'), 'success');
                    else showToast('另存为失败: ' + ((out && out.error) || '未知'), 'error');
                }).catch(e => showToast('另存为失败: ' + e.message, 'error'));
                return;
            }
        }
        if (r.kind === 'text') {
            const base64 = btoa(unescape(encodeURIComponent(r.text || '')));
            const stem = `${_state.toolId}-${Date.now()}`;
            if (api.comfyui && api.comfyui.saveAs) {
                api.comfyui.saveAs({ defaultName: stem + '.txt', mime: 'text/plain', dataBase64: base64 }).then(out => {
                    if (out && out.ok) showToast('已保存到 ' + (out.path || '本地'), 'success');
                    else showToast('另存为失败: ' + ((out && out.error) || '未知'), 'error');
                });
            }
            return;
        }
        const m = /^data:([^;]+);base64,(.*)$/.exec(r.dataUrl || '');
        if (!m) { showToast('图片数据格式异常', 'error'); return; }
        const base64 = m[2];
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const defaultName = r.filename || `dwp-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`;
        if (api.comfyui && api.comfyui.saveAs) {
            api.comfyui.saveAs({ defaultName, mime: r.mime, dataBase64: base64 }).then(out => {
                if (out && out.ok) showToast('已保存到 ' + (out.path || '本地'), 'success');
                else showToast('另存为失败: ' + ((out && out.error) || '未知'), 'error');
            });
        }
    }

    // ========== toast 兼容 ==========
    function showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        alert(msg);
    }

    // ========== D-MID-AUTO-MATCH：当前 tool + form 命中历史 done 任务时自动回显 ==========
    // 场景：用户在工作台切换工具 / 修改表单 → 如果新表单 = 之前某条已 done 任务的 form，
    //       把那条任务的结果回显到中栏；不再要求用户重跑。
    // 边界：midState='running'|'queued' 时不动（当前任务接管中栏）；无匹配时清掉旧结果，
    //       避免「过时结果残留」误导用户。

    let _refreshDebounce = null;
    let _refreshCallId = 0;
    function _refreshMidResultForCurrentState() {
        // 防抖：表单 input 会高频触发；debounce 150ms 等用户停手再检测
        if (_refreshDebounce) clearTimeout(_refreshDebounce);
        _refreshDebounce = setTimeout(_actuallyRefreshMidResult, 150);
    }

    async function _actuallyRefreshMidResult() {
        _refreshDebounce = null;
        const thisCall = ++_refreshCallId;
        // 当前任务正在跑/排队，不动中栏
        if (_state.midState === 'running' || _state.midState === 'queued') return;
        // 必须有当前工具（否则没东西可匹配）
        if (!_state.toolId || !_state.toolDetail) return;

        const currentForm = _state.formValues || {};
        // 2026-11 放宽匹配：先本地缓存找（忽略 seed 等随机字段）
        let matchQid = _findMatchingTaskLocal(currentForm);
        // 本地缓存没命中 → 按需查库（突破 500 条缓存上限）
        if (!matchQid && api.taskQueue && typeof api.taskQueue.findByForm === 'function') {
            try {
                const r = await api.taskQueue.findByForm({ toolId: _state.toolId, formValues: currentForm });
                if (thisCall !== _refreshCallId) return;
                if (r && r.ok && r.queueId) matchQid = r.queueId;
            } catch (e) { /* 查库失败忽略，退回无匹配 */ }
        }

        if (matchQid) {
            const result = await _ensureResultCached(matchQid);
            // await 期间两件事可能发生，都得拦下来：
            //   1) 用户又改了表单 → thisCall 过期
            //   2) 用户点了立即生成 → midState 已切到 running/queued，自动匹配不该再覆盖
            if (thisCall !== _refreshCallId) return;
            if (_state.midState === 'running' || _state.midState === 'queued') return;
            if (result && (result.dataUrl || result.fileUrl || result.text)) {
                _state.midResult = result;
                _state.midQueueId = matchQid;
                _state.midState = 'done';
                _state.midArtifactIndex = 0;
                renderResult(result);
                updateMidStage();
                _renderArtifactNav();
                return;
            }
        }

        // 没匹配：清掉当前显示的结果（避免「过时结果残留」）
        // 同上，await 后再确认 midState 仍可改
        if (thisCall !== _refreshCallId) return;
        if (_state.midState === 'running' || _state.midState === 'queued') return;
        if (_state.midState === 'done' && _state.midResult) {
            _state.midResult = null;
            _state.midState = 'idle';
            updateMidStage();
        }
    }

    function _formValuesMatch(stored, current) {
        // 用 sorted-key JSON 比较（避免 key 顺序差异导致 false negative）
        try {
            const normalize = (obj) => {
                if (obj == null || typeof obj !== 'object') return obj;
                if (Array.isArray(obj)) return obj.map(normalize);
                const sorted = {};
                const keys = Object.keys(obj).sort();
                for (const k of keys) sorted[k] = normalize(obj[k]);
                return sorted;
            };
            return JSON.stringify(normalize(stored)) === JSON.stringify(normalize(current));
        } catch (e) {
            return false;
        }
    }

    // 2026-11 忽略随机字段的归一化（与后端 taskQueue:findByForm 保持一致）
    const _IGNORE_RANDOM_KEYS = new Set(['seed', 'seed_1st', 'seed_2nd', 'seed_high', 'seed_low']);
    function _normalizeFormForMatch(obj) {
        try {
            if (obj == null || typeof obj !== 'object') return JSON.stringify(obj);
            const sorted = {};
            for (const k of Object.keys(obj).sort()) {
                if (_IGNORE_RANDOM_KEYS.has(k)) continue; // 忽略 seed 等随机字段
                const v = obj[k];
                if (Array.isArray(v)) {
                    sorted[k] = v.map(x => (x && typeof x === 'object' && 'id' in x ? x.id : x));
                } else {
                    sorted[k] = v;
                }
            }
            return JSON.stringify(sorted);
        } catch (e) { return ''; }
    }
    function _findMatchingTaskLocal(currentForm) {
        const target = _normalizeFormForMatch(currentForm);
        let matchQid = null, matchAt = -1;
        for (const [qid, task] of _state.midTasksByJobId) {
            if (task.tool_id !== _state.toolId || task.status !== 'done') continue;
            if (_normalizeFormForMatch(task.form_values) !== target) continue;
            const ts = task.enqueued_at || 0;
            if (ts > matchAt) { matchAt = ts; matchQid = qid; }
        }
        return matchQid;
    }

    // 启动时拉一次历史任务列表（带 form_values，KB 级可接受），填进 midTasksByJobId
    // 用于 open() 完成后立即能匹配历史任务；result dataUrl 按需懒加载（_ensureResultCached）
    async function _loadInitialTasksForAutoMatch() {
        if (!api.taskQueue || typeof api.taskQueue.list !== 'function') return;
        try {
            const r = await api.taskQueue.list({ limit: 500 });
            if (!r || !r.ok || !Array.isArray(r.items)) return;
            for (const t of r.items) {
                _cacheTaskFromEvent(t.queue_id, t);
            }
        } catch (e) {
            console.warn('[workbench] _loadInitialTasksForAutoMatch:', e && e.message);
        }
    }

    // 懒加载：cached 命中直接返回；否则调 IPC 读完整结果并缓存
    async function _ensureResultCached(qid) {
        if (_state.midResultsByJobId.has(qid)) return _state.midResultsByJobId.get(qid);
        const result = await _loadResultForTask(qid);
        if (result) _state.midResultsByJobId.set(qid, result);
        return result;
    }

    // ========== 暴露 ==========
    window.workbench = {
        open, close, isOpen, setTool,
        applyFormToResult: applyPromptToForm,
        focusPrompt: () => {
            const el = _primaryPromptEl();
            if (el) { el.focus(); el.select(); }
        },
        // D-WORKBENCH-PICKIMAGE：ai-tools.js 在 pickImage 成功后调这个，
        // 让对比按钮 enable 状态实时更新 + 重新加载输入图缓存
        refreshCompareAvailability,
    };
})();
