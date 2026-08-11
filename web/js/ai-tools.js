// ai-tools.js — AI 工具（声明式 ComfyUI workflow 表单）
//
// 入口：window.aiTools.open() —— 由 script.js 的「AI 工具」按钮调用
// 数据：api.tools.list() / api.tools.get(id) / api.tools.run({toolId, formValues})
// 事件：api.comfyui.onProgress / onComplete / onError 复用 prompt-gen 的同款
//
// 页面结构：
//   aiToolsPage
//   ├── atHeaderBar     (返回主页 / 标题 / ComfyUI 状态)  ← 两视图共用
//   ├── atGallery       (默认显示，工具卡片网格)
//   └── atDetail        (点击卡片后显示，含返回按钮 + 表单 + 结果图)

'use strict';

(function () {
    const api = window.api || {};
    if (!api.tools) { console.warn('[ai-tools] window.api.tools 不可用'); return; }
    if (!api.comfyui) { console.warn('[ai-tools] window.api.comfyui 不可用'); return; }

    // ========== 状态 ==========
    let _tools = [];              // 工具列表（含 coverUrl / coverFallback）
    let _t2iToolIds = [];         // 文生图（Text-to-Image）工具 id 列表：用于「生成图片」按钮跳转
    let _currentTool = null;      // 当前选中工具的完整 schema
    let _currentImage = null;     // { dataUrl, filename, mime }
    let _currentJobId = null;     // 当前 job
    let _currentJobCtx = null;    // { toolId, toolName, formValues, mode } — 用于结果自动存档
    let _comfyStatus = null;      // { running, port, ... }
    let _unsubs = [];             // comfyui 事件订阅
    let _view = 'gallery';        // 'gallery' | 'detail'
    let _embeddedMode = false;    // 嵌入到任意 host 时跳过 open/close 创建 fullscreen overlay
    let _loraMultiState = {};    // { fieldId: [{id, weight}, ...] } — loraMulti 字段的当前选中列表（每个 item 带 weight 覆盖，undefined = 用 lora.recommended_weight）

    // ========== 入口 ==========
    async function open() {
        if (!document.getElementById('aiToolsPage')) createPage();
        // 加载工具列表
        const r = await api.tools.list();
        if (r && r.ok) _tools = r.tools || [];
        // 检测文生图工具（无 image 上传字段 + 有 textarea 字段 + 输出是 image）
        _t2iToolIds = (_tools || []).filter(isTextToImageTool).map(t => t.id);
        renderGallery();
        // 默认进 gallery
        showPage();
        showGallery();
        await refreshComfyStatus();
        subscribeComfyEvents();
    }

    function close(opts) {
        // D-NAVBAR：opts.silent=true 用于顶部导航主动切页时调用，避免触发 workbench 自动回退
        const silent = !!(opts && opts.silent);
        const page = document.getElementById('aiToolsPage');
        if (page) page.style.display = 'none';
        // D-NAVBAR：只恢复 main，不再碰 header（header 全平台持久可见）
        const main = document.querySelector('main');
        if (main) main.style.display = '';
        for (const u of _unsubs) { try { u && u(); } catch (e) {} }
        _unsubs = [];
        if (_currentJobId) {
            try { api.comfyui.cancel(_currentJobId); } catch (e) {}
            _currentJobId = null;
        }
        // D-LAYOUT：通知 workbench 关闭（如果是从工作台进去的，workbench 会决定是否重开）
        if (!silent) {
            try {
                window.dispatchEvent(new CustomEvent('workbench:requestReturn', { detail: { source: 'aiTools' } }));
            } catch (e) {}
        }
        // D-NAVBAR：通知 nav active 态同步
        try {
            window.dispatchEvent(new CustomEvent('aiTools:closed', { detail: { silent } }));
        } catch (e) {}
    }

    // D-NAVBAR：暴露 isOpen() 给 switchMainView 用
    function isOpen() {
        const page = document.getElementById('aiToolsPage');
        return !!(page && page.style.display !== 'none');
    }

    // ========== DOM ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'aiToolsPage';
        // D-NAVBAR：top 用 var(--header-height) 让位给顶部导航栏（header 持久可见，不再 inset:0 全屏覆盖）
        page.style.cssText = 'position:fixed; top:var(--header-height); left:0; right:0; bottom:0; background:#f5f6f8; z-index:200; display:none; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        page.innerHTML = `
            <!-- 顶部 bar（两视图共用） -->
            <div id="atHeaderBar" style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; box-shadow:0 1px 2px rgba(0,0,0,0.04); flex-shrink:0;">
                <button id="atBtnBack" class="btn" title="返回瀑布流页" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                <h2 id="atHeaderTitle" style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-toolbox" style="color:#0ea5e9;"></i> AI 工具</h2>
                <span id="atComfyStatus" style="margin-right:12px; font-size:12px; color:#9ca3af;">● ComfyUI 未启动</span>
            </div>

            <!-- Gallery 视图（默认） -->
            <div id="atGallery" style="flex:1; overflow-y:auto; padding:24px; background:#f5f6f8; display:none;">
                <div style="width:100%;">
                    <div style="margin-bottom:20px;">
                        <h3 style="margin:0; color:#1f2937; font-size:18px; font-weight:600;">选择工具</h3>
                        <p style="margin:4px 0 0 0; color:#6b7280; font-size:13px;">点击卡片进入对应工具的配置和生图界面</p>
                    </div>
                    <div id="atGalleryGrid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:18px;"></div>
                </div>
            </div>

            <!-- Detail 视图 -->
            <div id="atDetail" style="flex:1; display:none; flex-direction:column; min-height:0;">
                <!-- 子 header（detail 视图的"顶部 bar"） -->
                <div style="display:flex; align-items:center; padding:12px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; flex-shrink:0;">
                    <button id="atBtnBackToGallery" class="btn" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 工具列表</button>
                    <div style="flex:1;">
                        <div id="atDetailName" style="font-size:15px; font-weight:600; color:#1f2937;">（未选择工具）</div>
                        <div id="atDetailDesc" style="font-size:12px; color:#6b7280; margin-top:2px;"></div>
                    </div>
                    <span id="atDetailComfyStatus" style="margin-right:12px; font-size:12px; color:#9ca3af;">● ComfyUI 未启动</span>
                </div>
                <div style="display:flex; flex:1; min-height:0;">
                    <!-- 中：动态表单 -->
                    <div style="flex:1; display:flex; flex-direction:column; min-width:0; background:#f9fafb; overflow:hidden;">
                        <div id="atForm" style="flex:1; overflow-y:auto; padding:18px;"></div>
                        <div style="padding:12px 18px; border-top:1px solid #e5e7eb; display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:#ffffff;">
                            <span id="atRunMeta" style="font-size:12px; color:#6b7280; flex:1;">就绪</span>
                            <button id="atBtnReset" class="btn btn-sm">重置表单</button>
                            <button id="atBtnRun" class="btn btn-primary" disabled><i class="fa-solid fa-play"></i> 运行</button>
                            <button id="atBtnCancel" class="btn btn-sm" style="display:none; background:#fef2f2; color:#dc2626; border:1px solid #fecaca;" title="中断当前生成任务"><i class="fa-solid fa-stop"></i> 暂停生成</button>
                        </div>
                    </div>
                    <!-- 右：结果区 -->
                    <div style="width:420px; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; background:#ffffff;">
                        <div style="padding:12px 16px; border-bottom:1px solid #e5e7eb;">
                            <span style="font-size:14px; color:#374151; font-weight:500;">生成结果</span>
                        </div>
                        <div id="atResultImage" style="flex:1; display:flex; flex-direction:column; padding:14px; background:#fafafa; min-height:0;">
                            <div id="atResultImageEmpty" style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#9ca3af; font-size:12px;">
                                <i class="fa-solid fa-image" style="font-size:48px; color:#e5e7eb; margin-bottom:12px;"></i>
                                <div>点底部「运行」调本地 ComfyUI 出图 / 出文本</div>
                                <div style="font-size:11px; color:#d1d5db; margin-top:6px;">需先在「提示词生成 → 模型」配置 ComfyUI 并启动</div>
                            </div>
                            <div id="atResultImageLoaded" style="flex:1; display:none; flex-direction:column; min-height:0;">
                                <div id="atResultMediaHost" style="flex:1; display:flex; align-items:center; justify-content:center; background:#1f2937; border-radius:6px; overflow:hidden; min-height:0;">
                                    <img id="atResultMediaImg" style="max-width:100%; max-height:100%; object-fit:contain; display:block;" />
                                    <video id="atResultMediaVideo" controls style="max-width:100%; max-height:100%; object-fit:contain; display:none;"></video>
                                </div>
                                <div id="atResultImageMeta" style="font-size:11px; color:#6b7280; padding:6px 0;"></div>
                                <div style="display:flex; gap:6px; padding-top:6px;">
                                    <button id="atBtnSaveImageAs" class="btn btn-sm" disabled><i class="fa-solid fa-download"></i> 另存为</button>
                                </div>
                            </div>
                            <div id="atResultTextLoaded" style="flex:1; display:none; flex-direction:column; min-height:0;">
                                <textarea id="atResultTextArea" readonly style="flex:1; width:100%; padding:12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; line-height:1.6; font-family:system-ui, -apple-system, &quot;Segoe UI&quot;, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, sans-serif; resize:none; box-sizing:border-box; min-height:0;"></textarea>
                                <div id="atResultTextMeta" style="font-size:11px; color:#6b7280; padding:6px 0;"></div>
                                <div style="display:flex; gap:6px; padding-top:6px; flex-wrap:wrap;">
                                    <button id="atBtnCopyText" class="btn btn-sm" disabled><i class="fa-solid fa-copy"></i> 复制</button>
                                    <button id="atBtnSaveTextAs" class="btn btn-sm" disabled><i class="fa-solid fa-download"></i> 另存为 .txt</button>
                                    <button id="atBtnSaveTextToLibrary" class="btn btn-sm" disabled title="保存到提示词库"><i class="fa-solid fa-database"></i> 保存到提示词库</button>
                                    <button id="atBtnGenImageFromText" class="btn btn-sm" disabled style="display:none;" title="跳转到文生图工具，提示词自动填入"><i class="fa-solid fa-wand-magic-sparkles"></i> 生成图片</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(page);

        // 绑定
        page.querySelector('#atBtnBack').addEventListener('click', close);
        page.querySelector('#atBtnBackToGallery').addEventListener('click', showGallery);
        page.querySelector('#atBtnRun').addEventListener('click', runTool);
        page.querySelector('#atBtnReset').addEventListener('click', () => { if (_currentTool) renderForm(_currentTool); });
        page.querySelector('#atBtnCancel').addEventListener('click', cancelTool);
        page.querySelector('#atBtnSaveImageAs').addEventListener('click', saveCurrentImageAs);
        page.querySelector('#atBtnCopyText').addEventListener('click', copyCurrentText);
        page.querySelector('#atBtnSaveTextAs').addEventListener('click', saveCurrentTextAs);
        page.querySelector('#atBtnSaveTextToLibrary').addEventListener('click', saveCurrentTextToLibrary);
        page.querySelector('#atBtnGenImageFromText').addEventListener('click', genImageFromCurrentText);
        // 点击生图结果图片/视频 → 放大查看
        const atResultImgEl = page.querySelector('#atResultMediaImg');
        if (atResultImgEl) {
            atResultImgEl.style.cursor = 'zoom-in';
            atResultImgEl.addEventListener('click', () => {
                if (atResultImgEl.src) openMediaZoomModal(atResultImgEl.src, 'image/*');
            });
        }
        const atResultVidEl = page.querySelector('#atResultMediaVideo');
        if (atResultVidEl) {
            atResultVidEl.style.cursor = 'zoom-in';
            atResultVidEl.addEventListener('click', () => {
                if (atResultVidEl.src) openMediaZoomModal(atResultVidEl.src, atResultVidEl.currentSrc || 'video/mp4');
            });
        }
    }

    function showPage() {
        const page = document.getElementById('aiToolsPage');
        if (page) page.style.display = 'flex';
        // D-NAVBAR：main 仍然隐藏（ai-tools 是全屏 overlay 覆盖 main），但 header 保持可见
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
        // D-NAVBAR：通知 nav active 态同步
        try {
            window.dispatchEvent(new CustomEvent('aiTools:opened'));
        } catch (e) {}
    }

    // ========== 视图切换 ==========
    function showGallery() {
        _view = 'gallery';
        const gallery = document.getElementById('atGallery');
        const detail = document.getElementById('atDetail');
        const headerBar = document.getElementById('atHeaderBar');
        if (gallery) gallery.style.display = 'block';
        if (detail) detail.style.display = 'none';
        if (headerBar) headerBar.style.display = 'flex';   // 恢复顶部 bar
        // 取消进行中的 job（避免后台跑浪费）
        if (_currentJobId) {
            try { api.comfyui.cancel(_currentJobId); } catch (e) {}
            _currentJobId = null;
        }
    }

    function showDetail() {
        _view = 'detail';
        const gallery = document.getElementById('atGallery');
        const detail = document.getElementById('atDetail');
        const headerBar = document.getElementById('atHeaderBar');
        if (gallery) gallery.style.display = 'none';
        if (detail) detail.style.display = 'flex';
        if (headerBar) headerBar.style.display = 'none';   // 隐藏顶部 bar（detail 自己的子 header 接管）
    }

    // ========== 字段分组（D-WORKBENCH 三栏分发）==========
    // 把 formField 归到 primary / size / params 三栏：
    //   primary → 左栏（主输入）：textarea / image / video
    //   size    → 中栏底部（输出尺寸）：type=number 且 id 是 width / height
    //   params  → 右栏（参数微调）：其他所有（number / select / lora / loraMulti / text / ...）
    // schema 可以显式写 `panel: "primary" | "size" | "params"` 覆盖默认规则。
    const _PRIMARY_ORDER = { textarea: 0, image: 1, video: 2 };
    function _classifyField(field) {
        if (!field) return 'params';
        if (field.panel === 'primary' || field.panel === 'size' || field.panel === 'params') return field.panel;
        if (field.type === 'textarea' || field.type === 'image' || field.type === 'video') return 'primary';
        if (field.type === 'number' && (field.id === 'width' || field.id === 'height')) return 'size';
        return 'params';
    }
    function _primarySortKey(field) {
        return _PRIMARY_ORDER[field.type] !== undefined ? _PRIMARY_ORDER[field.type] : 99;
    }

    // 生成三个独立 HTML 片段，给工作台三栏分别塞入：
    //   primary：按 textarea → image → video 顺序，无 group header（主输入面板是平的）
    //   size：width + height 紧凑横排
    //   params：保持原 group + ungrouped 结构
    function renderEmbeddedFormSections(tool) {
        const fields = (tool && tool.formFields) || [];
        const primary = fields.filter(f => _classifyField(f) === 'primary').sort((a, b) => _primarySortKey(a) - _primarySortKey(b));
        const size = fields.filter(f => _classifyField(f) === 'size');
        const params = fields.filter(f => _classifyField(f) === 'params');
        return {
            primary: primary.map(f => renderField(f)).join(''),
            size: size.map(f => renderField(f)).join(''),
            params: _renderParamsHtml(params),
        };
    }

    function _renderParamsHtml(fields) {
        const groups = {};
        const ungrouped = [];
        for (const f of fields) {
            if (f.group) {
                if (!groups[f.group]) groups[f.group] = [];
                groups[f.group].push(f);
            } else {
                ungrouped.push(f);
            }
        }
        let html = '';
        for (const f of ungrouped) html += renderField(f);
        for (const g of Object.keys(groups)) {
            for (const f of groups[g]) html += renderField(f);
        }
        return html;
    }

    // ========== Gallery（工具卡片网格）==========
    function renderGallery() {
        const grid = document.getElementById('atGalleryGrid');
        if (!grid) return;
        if (!_tools.length) {
            grid.innerHTML = '<div style="grid-column:1/-1; padding:60px 0; text-align:center; color:#9ca3af; font-size:13px;"><i class="fa-solid fa-toolbox" style="font-size:48px; color:#e5e7eb; display:block; margin-bottom:12px;"></i>没有可用的工具。<br>请在 resources/comfyui-workflows/ 目录添加 schema 文件</div>';
            return;
        }
        grid.innerHTML = _tools.map(t => renderToolCard(t)).join('');
        grid.querySelectorAll('.at-card').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.dataset.id;
                if (id) selectTool(id);
            });
        });
    }

    function renderToolCard(t) {
        const broken = t.broken;
        const fallback = t.coverFallback || { icon: 'fa-image', gradient: ['#6b7280', '#374151'] };
        const grad = Array.isArray(fallback.gradient) && fallback.gradient.length >= 2
            ? fallback.gradient
            : ['#6b7280', '#374151'];
        const [c1, c2] = grad;
        const iconClass = escapeAttr(fallback.icon || 'fa-image');
        // 封面渲染：
        //  - 有 coverUrl → <img>，加载失败时 CSS 隐藏 img + 显示 fallback（避免 innerHTML 转义灾难）
        //  - 无 coverUrl → 直接显示 fallback
        const fallbackDiv = `<div class="at-card-fallback" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, ${c1}, ${c2});"><i class="fa-solid ${iconClass}" style="font-size:56px; color:rgba(255,255,255,0.7);"></i></div>`;
        const coverArea = t.coverUrl
            ? `<div style="position:relative; width:100%; height:100%;">
                 <img src="${escapeAttr(t.coverUrl)}" alt="" style="width:100%; height:100%; object-fit:cover; display:block;" onerror="this.style.display='none'; var fb=this.nextElementSibling; if(fb) fb.style.display='flex';" />
                 <div class="at-card-fallback" style="position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:linear-gradient(135deg, ${c1}, ${c2});"><i class="fa-solid ${iconClass}" style="font-size:56px; color:rgba(255,255,255,0.7);"></i></div>
               </div>`
            : fallbackDiv;
        return `
            <div class="at-card${broken ? ' broken' : ''}" data-id="${escapeAttr(t.id)}">
                <!-- 封面 -->
                <div class="at-card-cover" style="height:180px; position:relative; overflow:hidden; background:linear-gradient(135deg, ${c1}, ${c2});">
                    ${coverArea}
                    <div style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.55); color:#ffffff; padding:3px 10px; border-radius:10px; font-size:11px; font-weight:500; z-index:2;">${escapeHtml((t.mode || 'sfw').toUpperCase())}</div>
                    ${broken ? '<div style="position:absolute; top:10px; right:10px; background:#dc2626; color:#ffffff; padding:3px 10px; border-radius:10px; font-size:11px; font-weight:500; z-index:2;">损坏</div>' : ''}
                </div>
                <!-- 信息 -->
                <div style="padding:14px 16px 16px 16px;">
                    <div style="font-size:15px; font-weight:600; color:#1f2937; margin-bottom:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(t.name || t.id)}</div>
                    <div style="font-size:12px; color:#6b7280; line-height:1.5; height:36px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">${escapeHtml(t.description || '（无描述）')}</div>
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-top:12px; padding-top:10px; border-top:1px solid #f3f4f6;">
                        <span style="font-size:11px; color:#9ca3af;">${t.formFieldCount || 0} 字段</span>
                        <span style="font-size:12px; color:#0ea5e9; font-weight:500;">打开 <i class="fa-solid fa-arrow-right" style="font-size:10px;"></i></span>
                    </div>
                </div>
            </div>
        `;
    }

    async function selectTool(id) {
        const r = await api.tools.get(id);
        if (!r || !r.ok) {
            showToast('加载工具失败: ' + ((r && r.error) || '未知'), 'error');
            return;
        }
        _currentTool = r.tool;
        _loraMultiState = {};  // Phase 3：切换工具时清空 loraMulti 选中
        document.getElementById('atDetailName').textContent = _currentTool.name;
        document.getElementById('atDetailDesc').textContent = _currentTool.description || '';
        renderForm(_currentTool);
        // 重置结果区（用 removeAttribute 而不是 src=''，避免 Chrome 把空 src 解析成"加载当前页"）
        _currentImage = null;
        clearMediaElement();
        clearTextElement();
        document.getElementById('atBtnSaveImageAs').disabled = true;
        document.getElementById('atBtnCopyText').disabled = true;
        document.getElementById('atBtnSaveTextAs').disabled = true;
        document.getElementById('atBtnSaveTextToLibrary').disabled = true;
        const genImgBtn = document.getElementById('atBtnGenImageFromText');
        if (genImgBtn) { genImgBtn.disabled = true; genImgBtn.style.display = 'none'; }
        showImageWaiting();
        showPage();
        showDetail();
    }

    // ========== 动态表单 ==========
    function renderForm(tool, container) {
        const form = container || document.getElementById('atForm');
        if (!form) return;
        if (tool.broken) {
            form.innerHTML = `<div style="padding:20px; color:#dc2626;">工具加载失败：${escapeHtml(tool.error || '未知')}</div>`;
            return;
        }
        // 顶部 banner：工作流主模型（用于 Lora 字段按模型过滤的提示）
        // 优先展示 schema.models（声明的适配模型枚举）；缺省时回退到从 workflow JSON 抽出的 basename
        let html = '';
        const displayModels = (Array.isArray(tool.models) && tool.models.length) ? tool.models : (tool.mainModel ? [tool.mainModel] : []);
        if (displayModels.length) {
            html += `<div style="margin-bottom:14px; padding:8px 12px; background:#fef3c7; border-left:3px solid #f59e0b; border-radius:4px; font-size:12px; color:#92400e;">
                <i class="fa-solid fa-microchip" style="margin-right:4px;"></i>
                工作流主模型：<strong>${escapeHtml(displayModels.join(' / '))}</strong>
                <span style="margin-left:8px; color:#a16207; font-size:11px;">（Lora 选择器会自动按这些模型筛选）</span>
            </div>`;
        }
        // 复用三栏分发逻辑（settings.js 走 legacy 单容器；工作台走三栏分发）
        const sections = renderEmbeddedFormSections(tool);
        html += sections.primary + sections.size + sections.params;
        form.innerHTML = html;
        // 初始化 lora / loraMulti 字段（异步加载选项 + 初始 chip 渲染）
        initLoraFields(tool, displayModels);
        // 绑定 data-action 按钮（pick-image / pick-loras / clear-loras / clear-lora / randomize）
        bindFormActions(form, fields, displayModels);
        // 监听输入：textarea / input / select 任一变化都重新计算「运行」按钮 enable 状态
        // （之前没监听，导致 default="" 的工具如 Wan2.2，用户输入提示词后按钮仍是 disabled）
        if (!form._atInputBound) {
            form.addEventListener('input', updateRunButtonState);
            form.addEventListener('change', updateRunButtonState);
            form._atInputBound = true;
        }
        // 每次重渲染后同步按钮 enable
        updateRunButtonState();
    }

    // ========== 表单 data-action 绑定（pick-image / pick-loras / clear-* / randomize）==========
    // 抽离出来给工作台三栏分发场景复用：工作台用 renderEmbeddedFormSections 拼三块 HTML，
    // 但内部不再调这些绑定，所以单独暴露给 aiToolsEmbedded。
    // 参数：
    //   formEl: 已写入 HTML 的容器（renderForm 场景是单一 form；工作台场景是三栏各自一个）
    //   fields: tool.formFields（用于 loraMulti 字段定位）
    //   displayModels: 工作流主模型数组（用于 lora 按模型筛选）
    function bindFormActions(formEl, fields, displayModels) {
        if (!formEl) return;
        const fieldsArr = fields || [];
        const models = displayModels || [];
        // 绑定 random 按钮
        formEl.querySelectorAll('[data-action="randomize"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fieldId = btn.dataset.field;
                const input = document.getElementById(`at-field-${fieldId}`);
                if (input) {
                    input.value = Math.floor(Math.random() * 4294967296);
                    updateRunButtonState();
                }
            });
        });
        // 绑定「选择图片」按钮（image 类型字段）
        formEl.querySelectorAll('[data-action="pick-image"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const fieldId = btn.dataset.field;
                if (!api.comfyui || typeof api.comfyui.pickImage !== 'function') {
                    showToast('图片选择接口不可用', 'error');
                    return;
                }
                const r = await api.comfyui.pickImage();
                if (!r || !r.ok) {
                    if (r && r.error) showToast('选择图片失败: ' + r.error, 'error');
                    return;
                }
                if (r.canceled) return;
                const input = document.getElementById(`at-field-${fieldId}`);
                if (input) {
                    // 优先用 comfyuiName（main 端复制到 input 目录后的最终名），
                    // 复制失败时回退到原 basename
                    input.value = r.comfyuiName || r.name || r.path || '';
                    // D-MID-COMPARE：把用户挑的原图绝对路径挂到 data 属性上，
                    // 工作台 compare 模式会读这个属性再去 IPC 读图渲染左侧原图
                    if (r.path) input.dataset.sourcePath = r.path;
                    else delete input.dataset.sourcePath;
                    updateRunButtonState();
                    // D-MID-COMPARE：表单值变了，工作台要刷新对比按钮 enable + 重新加载输入图缓存
                    if (window.workbench && typeof window.workbench.refreshCompareAvailability === 'function') {
                        try { window.workbench.refreshCompareAvailability(); } catch (e) {}
                    }
                    if (r.copied) {
                        showToast(`已复制到 ComfyUI input: ${r.comfyuiName}`, 'success');
                    } else if (r.copyError) {
                        showToast(`未自动复制（${r.copyError}），请手动放到 ComfyUI input 目录`, 'error');
                    }
                }
            });
        });
        // ========== D-WORKBENCH-ASSET-MODULE：image/video 卡片 picker 绑定 ==========
        // 两个入口共用同一份 picker：点击空态区 / 点击「替换」按钮。
        // 图片走 api.comfyui.pickImage()；视频走隐藏的 <input type="file">（无 pickVideo IPC）。
        formEl.querySelectorAll('[data-action="asset-pick"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const fieldId = btn.dataset.field;
                const module = formEl.querySelector(`.dwp-asset-module[data-field-id="${CSS.escape(fieldId)}"]`);
                if (!module) return;
                const assetType = module.dataset.assetType; // 'image' | 'video'
                if (assetType === 'image') {
                    await _pickImageForAsset(fieldId, module);
                } else {
                    // 视频：触发隐藏的 file input
                    const fileInput = module.querySelector(`[data-asset-file="${CSS.escape(fieldId)}"]`);
                    if (fileInput) fileInput.click();
                }
            });
        });
        // 视频 file input change → 读 blob → 生成预览 + 写隐藏 input
        formEl.querySelectorAll('[data-asset-file]').forEach(fi => {
            fi.addEventListener('change', (e) => {
                const fieldId = fi.dataset.assetFile;
                const module = formEl.querySelector(`.dwp-asset-module[data-field-id="${CSS.escape(fieldId)}"]`);
                const file = fi.files && fi.files[0];
                if (!file || !module) return;
                _setAssetPreviewVideo(fieldId, module, file);
            });
        });
        // 删除按钮：清空 hidden input / dataset.sourcePath / 预览 DOM
        formEl.querySelectorAll('[data-action="asset-remove"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const fieldId = btn.dataset.field;
                const module = formEl.querySelector(`.dwp-asset-module[data-field-id="${CSS.escape(fieldId)}"]`);
                if (!module) return;
                _clearAssetPreview(fieldId, module);
                updateRunButtonState();
                if (window.workbench && typeof window.workbench.refreshCompareAvailability === 'function') {
                    try { window.workbench.refreshCompareAvailability(); } catch (e) {}
                }
            });
        });
        // 「选择 Lora」按钮（loraMulti）
        formEl.querySelectorAll('[data-action="pick-loras"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fieldId = btn.dataset.field;
                const f = fieldsArr.find(x => x && x.id === fieldId && x.type === 'loraMulti');
                if (!f) return;
                openLoraMultiPicker(f, models);
            });
        });
        // 「清空 Lora」按钮（loraMulti）
        formEl.querySelectorAll('[data-action="clear-loras"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fieldId = btn.dataset.field;
                const f = fieldsArr.find(x => x && x.id === fieldId && x.type === 'loraMulti');
                if (!f) return;
                _loraMultiState[f.id] = [];
                renderLoraMultiChips(f);
                updateRunButtonState();
            });
        });
        // 「清除单个 lora」按钮（lora 单选）
        formEl.querySelectorAll('[data-action="clear-lora"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const fieldId = btn.dataset.field;
                const el = document.getElementById(`at-field-${fieldId}`);
                if (el) {
                    el.value = '';
                    el.dataset.loraName = '';
                    const wEl = document.getElementById(`at-field-${fieldId}-weight`);
                    if (wEl) { wEl.value = ''; wEl.disabled = true; }
                    updateRunButtonState();
                }
            });
        });
    }

    // ========== D-WORKBENCH-ASSET-MODULE：image/video 上传卡片辅助函数 ==========
    // 这几个函数只服务 asset 模块（pick / preview / clear），与 ai-tools.js 其余逻辑解耦。
    // 关键不变量：
    //   - 隐藏 input `#at-field-{id}` 始终存 basename（兼容 collectFormValues）
    //   - dataset.sourcePath 始终存用户原图绝对路径（仅 image 有意义；用于 compare 模式）
    //   - 预览 DOM 与 input 值严格同步（input 空 → 预览隐藏；input 有值 → 预览显示）

    // 把 input 切换到「已选」状态：隐藏空态、显示预览卡、设值（basename）
    function _showAssetSelected(fieldId, module, fileName, metaText) {
        const empty = module.querySelector('.dwp-asset-empty');
        const card = module.querySelector(`[data-asset-card="${CSS.escape(fieldId)}"]`);
        const nameEl = module.querySelector(`[data-asset-name="${CSS.escape(fieldId)}"]`);
        const metaEl = module.querySelector(`[data-asset-meta="${CSS.escape(fieldId)}"]`);
        const replaceBtn = module.querySelector(`.dwp-asset-replace-btn[data-field="${CSS.escape(fieldId)}"]`);
        if (empty) empty.style.display = 'none';
        if (card) card.style.display = '';
        if (nameEl) { nameEl.textContent = fileName || ''; nameEl.title = fileName || ''; }
        if (metaEl) metaEl.textContent = metaText || '';
        if (replaceBtn) replaceBtn.style.display = '';
    }

    // 把 input 切回「空态」：隐藏预览卡、显示空态、清空 file input
    function _showAssetEmpty(fieldId, module) {
        const empty = module.querySelector('.dwp-asset-empty');
        const card = module.querySelector(`[data-asset-card="${CSS.escape(fieldId)}"]`);
        const thumb = module.querySelector(`[data-asset-thumb="${CSS.escape(fieldId)}"]`);
        const fileInput = module.querySelector(`[data-asset-file="${CSS.escape(fieldId)}"]`);
        const replaceBtn = module.querySelector(`.dwp-asset-replace-btn[data-field="${CSS.escape(fieldId)}"]`);
        if (empty) empty.style.display = '';
        if (card) card.style.display = 'none';
        if (replaceBtn) replaceBtn.style.display = 'none';
        // 释放 blob URL（避免内存泄漏），清掉 thumbnail 子节点
        if (thumb) {
            const vid = thumb.querySelector('video');
            if (vid) {
                try { vid.pause(); } catch (e) {}
                if (vid.dataset && vid.dataset.blobUrl) {
                    try { URL.revokeObjectURL(vid.dataset.blobUrl); } catch (e) {}
                }
                vid.removeAttribute('src');
                vid.load();
            }
            thumb.innerHTML = '<i class="fa-solid fa-image"></i>';
            thumb.classList.remove('loading');
        }
        if (fileInput) fileInput.value = '';
    }

    // 图片 picker：弹原生对话框 → 复制到 ComfyUI input → IPC 读 dataURL 渲染缩略图
    async function _pickImageForAsset(fieldId, module) {
        if (!api.comfyui || typeof api.comfyui.pickImage !== 'function') {
            showToast('图片选择接口不可用', 'error');
            return;
        }
        const thumb = module.querySelector(`[data-asset-thumb="${CSS.escape(fieldId)}"]`);
        if (thumb) thumb.classList.add('loading');
        try {
            const r = await api.comfyui.pickImage();
            if (!r || !r.ok) {
                if (r && r.error) showToast('选择图片失败: ' + r.error, 'error');
                if (thumb) thumb.classList.remove('loading');
                return;
            }
            if (r.canceled) {
                if (thumb) thumb.classList.remove('loading');
                return;
            }
            const input = document.getElementById(`at-field-${fieldId}`);
            if (input) {
                input.value = r.comfyuiName || r.name || r.path || '';
                if (r.path) input.dataset.sourcePath = r.path;
                else delete input.dataset.sourcePath;
            }
            const meta = [];
            if (r.comfyuiName) meta.push('已复制到 input');
            const sizeKB = r.size ? Math.round(r.size / 1024) : 0;
            if (sizeKB) meta.push(sizeKB + ' KB');
            _showAssetSelected(fieldId, module, r.comfyuiName || r.name || r.path || '已选择', meta.join(' · '));
            // 异步加载缩略图（用本地 file path 读 dataURL）
            if (thumb) {
                thumb.innerHTML = '';
                if (r.path && typeof api.comfyui.imageReadAsDataUrl === 'function') {
                    api.comfyui.imageReadAsDataUrl({ path: r.path }).then(rr => {
                        if (rr && rr.ok && rr.dataUrl) {
                            thumb.innerHTML = `<img src="${rr.dataUrl}" alt="" />`;
                        } else {
                            thumb.innerHTML = '<i class="fa-solid fa-image"></i>';
                        }
                        thumb.classList.remove('loading');
                    }).catch(() => {
                        thumb.innerHTML = '<i class="fa-solid fa-image"></i>';
                        thumb.classList.remove('loading');
                    });
                } else {
                    thumb.innerHTML = '<i class="fa-solid fa-image"></i>';
                    thumb.classList.remove('loading');
                }
            }
            if (r.copied) showToast(`已复制到 ComfyUI input: ${r.comfyuiName}`, 'success');
            else if (r.copyError) showToast(`未自动复制（${r.copyError}），请手动放到 ComfyUI input 目录`, 'error');
            updateRunButtonState();
            if (window.workbench && typeof window.workbench.refreshCompareAvailability === 'function') {
                try { window.workbench.refreshCompareAvailability(); } catch (e) {}
            }
        } catch (e) {
            if (thumb) thumb.classList.remove('loading');
            showToast('选择图片失败: ' + (e && e.message || '未知'), 'error');
        }
    }

    // 视频 picker：浏览器原生 file input → blob URL 渲染预览
    // 当前没有 pickVideo IPC，value 用 file.name（ComfyUI 端需要再 stage 一份，目前未自动化）。
    // 用户仍可在视频字段上看到预览 + 文件名；提交时会以 basename 写入 workflow（与图片一致）。
    function _setAssetPreviewVideo(fieldId, module, file) {
        const input = document.getElementById(`at-field-${fieldId}`);
        if (input) {
            input.value = file.name || '';
            delete input.dataset.sourcePath; // 视频不参与 compare
        }
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        const meta = `${(file.type || 'video/*').replace('video/', '')} · ${sizeMB} MB`;
        _showAssetSelected(fieldId, module, file.name, meta);
        const thumb = module.querySelector(`[data-asset-thumb="${CSS.escape(fieldId)}"]`);
        if (thumb) {
            thumb.classList.add('loading');
            const blobUrl = URL.createObjectURL(file);
            thumb.innerHTML = `<video src="${blobUrl}" muted playsinline preload="metadata"></video>`;
            const vid = thumb.querySelector('video');
            if (vid) vid.dataset.blobUrl = blobUrl;
            // 第一帧加载完移除 loading
            if (vid) {
                vid.addEventListener('loadeddata', () => {
                    thumb.classList.remove('loading');
                }, { once: true });
                // 兜底：5 秒后还没 loadeddata 也移除 loading
                setTimeout(() => thumb.classList.remove('loading'), 5000);
            }
        }
        updateRunButtonState();
    }

    // 清除预览：hidden input 清空 / file input 清空 / 释放 blob URL
    function _clearAssetPreview(fieldId, module) {
        const input = document.getElementById(`at-field-${fieldId}`);
        if (input) {
            input.value = '';
            delete input.dataset.sourcePath;
        }
        _showAssetEmpty(fieldId, module);
    }

    // ========== lora / loraMulti 字段初始化 ===========
    // 1) lora 单选：异步加载 Lora 列表填 select
    // 2) loraMulti：渲染初始空 chip 列表
    // 抽离出来给工作台三栏分发场景复用。
    function initLoraFields(tool, displayModels) {
        const fields = (tool && tool.formFields) || [];
        const models = (displayModels && displayModels.length)
            ? displayModels
            : ((Array.isArray(tool && tool.models) && tool.models.length) ? tool.models
                : (tool && tool.mainModel ? [tool.mainModel] : []));
        const loraFields = fields.filter(f => f && f.type === 'lora');
        for (const f of loraFields) {
            loadLoraOptionsForField(f, models);
        }
        const loraMultiFields = fields.filter(f => f && f.type === 'loraMulti');
        for (const f of loraMultiFields) {
            renderLoraMultiChips(f);
        }
    }

    function renderField(field) {
        const id = `at-field-${field.id}`;
        let value = field.default !== undefined ? field.default : '';
        // randomizable 字段的 -1 是"随机"哨兵：渲染时换成真实随机数（用户看得到种子，便于复现）
        if (field.randomizable && typeof value === 'number' && value < 0) {
            value = Math.floor(Math.random() * 4294967296);
        }
        let widget = '';
        let extraWidget = '';
        if (field.type === 'text') {
            widget = `<input id="${id}" type="text" value="${escapeAttr(String(value))}" style="${inputStyle()}" />`;
        } else if (field.type === 'textarea') {
            widget = `<textarea id="${id}" rows="${field.rows || 4}" style="${inputStyle()}; resize:vertical; font-family:inherit; line-height:1.6;">${escapeHtml(String(value))}</textarea>`;
        } else if (field.type === 'number') {
            const minAttr = field.min !== undefined ? `min="${field.min}"` : '';
            const maxAttr = field.max !== undefined ? `max="${field.max}"` : '';
            const stepAttr = field.step !== undefined ? `step="${field.step}"` : '';
            widget = `<input id="${id}" type="number" value="${value}" ${minAttr} ${maxAttr} ${stepAttr} style="${inputStyle()}" />`;
        } else if (field.type === 'select') {
            const opts = (field.options || []).map(o =>
                `<option value="${escapeAttr(String(o))}" ${String(o) === String(value) ? 'selected' : ''}>${escapeHtml(String(o))}</option>`
            ).join('');
            widget = `<select id="${id}" style="${inputStyle()}">${opts}</select>`;
        } else if (field.type === 'image' || field.type === 'video') {
            // D-WORKBENCH-ASSET-MODULE：图片/视频上传卡片（视觉参考 LORA 模块）。
            // - 空态：虚线占位 + 中央图标 + 「选择图片/视频」按钮
            // - 已选：缩略图（图片 dataURL / 视频 blob URL）+ 文件名 + 类型 + 替换/删除按钮
            // - hidden input #at-field-{id}：保留用于 collectFormValues 取 basename 写入 workflow
            // - dataset.sourcePath：传给工作台 compare 模式（仅图片有意义）
            const isVideo = field.type === 'video';
            const accept = isVideo ? 'video/*' : 'image/*';
            const emptyIcon = isVideo ? 'fa-film' : 'fa-image';
            const emptyTitle = isVideo ? '未选择视频' : '未选择图片';
            const emptyBtnText = isVideo ? '选择视频' : '选择图片';
            const emptyBtnIcon = isVideo ? 'fa-folder-open' : 'fa-folder-open';
            // hidden input 存 basename（提交时 collectFormValues 直接取 .value）
            widget = `
                <div class="dwp-asset-module ${isVideo ? 'dwp-asset-module-video' : ''}" data-field-id="${escapeAttr(field.id)}" data-asset-type="${field.type}">
                    <div class="dwp-asset-module-title">
                        <i class="fa-solid ${isVideo ? 'fa-film' : 'fa-image'}"></i>
                        <span>${isVideo ? '视频' : '图片'}</span>
                    </div>
                    <div class="dwp-asset-slot">
                        <div class="dwp-asset-slot-head">
                            <span class="dwp-asset-slot-label">${escapeHtml(field.label)}</span>
                            <div class="dwp-asset-slot-actions">
                                <button type="button" class="dwp-asset-replace-btn" data-action="asset-pick" data-field="${escapeAttr(field.id)}" style="display:none;"><i class="fa-solid fa-rotate"></i> 替换</button>
                            </div>
                        </div>
                        <!-- 空态：整块可点击触发 picker（图片走 IPC 弹原生对话框；视频走下方隐藏 file input） -->
                        <div class="dwp-asset-empty" data-action="asset-pick" data-field="${escapeAttr(field.id)}">
                            <i class="fa-solid ${emptyIcon}"></i>
                            <div>${escapeHtml(emptyTitle)}</div>
                            <div class="dwp-asset-empty-btn"><i class="fa-solid ${emptyBtnIcon}"></i> ${escapeHtml(emptyBtnText)}</div>
                        </div>
                        <!-- 已选预览：缩略图 + 文件名/类型 + 删除按钮 -->
                        <div class="dwp-asset-card" data-asset-card="${escapeAttr(field.id)}" style="display:none;">
                            <div class="dwp-asset-card-thumb" data-asset-thumb="${escapeAttr(field.id)}">
                                <i class="fa-solid ${emptyIcon}"></i>
                            </div>
                            <div class="dwp-asset-card-info">
                                <div class="dwp-asset-card-name" data-asset-name="${escapeAttr(field.id)}"></div>
                                <div class="dwp-asset-card-meta" data-asset-meta="${escapeAttr(field.id)}"></div>
                            </div>
                            <button type="button" class="dwp-asset-card-remove" data-action="asset-remove" data-field="${escapeAttr(field.id)}" title="移除"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <!-- 隐藏的 file input（视频用）+ 隐藏的 basename input（兼容 collectFormValues） -->
                        <input class="dwp-asset-file-input" type="file" accept="${escapeAttr(accept)}" data-asset-file="${escapeAttr(field.id)}" tabindex="-1" />
                        <input id="${id}" type="hidden" value="${escapeAttr(String(value || ''))}" />
                    </div>
                </div>
            `;
            extraWidget = '';
        } else if (field.type === 'lora') {
            // Phase 3：单 Lora 选择器
            // 渲染为空 select，async loadLoraOptionsForField 会异步填充选项
            // value 存 lora id（数字）；data-lora-name 存显示名（仅 UI 用，applier 用 id 查 basename）
            widget = `<select id="${id}" data-lora-type="single" data-field-id="${escapeAttr(field.id)}" style="${inputStyle()}"><option value="">（加载中…）</option></select>`;
            // 权重显示（只读，会跟随选中 Lora 的 recommended_weight 自动填）
            const weightId = `${id}-weight`;
            extraWidget = `<input id="${weightId}" type="number" step="0.05" min="0" max="2" placeholder="权重" style="margin-left:6px; width:80px; padding:8px 10px; background:#f9fafb; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;" disabled />
                <button type="button" data-action="clear-lora" data-field="${escapeAttr(field.id)}" title="清除选择" style="margin-left:4px; padding:8px 10px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:12px;"><i class="fa-solid fa-xmark"></i></button>`;
        } else if (field.type === 'loraMulti') {
            // Phase 3：多 Lora 选择器
            // 已选 chip 列表 + 选 Lora / 清空 按钮
            // _loraMultiState 升级为 [{id, weight}, ...]（每个 item 可选 weight 覆盖）；
            // field.default 兼容老 schema 的数字数组写法。
            const initial = Array.isArray(field.default) ? field.default.slice() : [];
            _loraMultiState[field.id] = initial.map(v => {
                if (v && typeof v === 'object') {
                    const w = v.weight;
                    return { id: Number(v.id), weight: (w != null && w !== '' && !Number.isNaN(Number(w))) ? Number(w) : undefined };
                }
                return { id: Number(v), weight: undefined };
            }).filter(x => x.id && !Number.isNaN(x.id));
            widget = `<div id="${id}" data-lora-type="multi" data-field-id="${escapeAttr(field.id)}" style="min-height:40px; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; background:#ffffff; display:flex; flex-wrap:wrap; gap:6px; align-items:center;"></div>`;
            extraWidget = `<button type="button" data-action="pick-loras" data-field="${escapeAttr(field.id)}" style="margin-left:6px; padding:8px 14px; background:#0ea5e9; color:#ffffff; border:1px solid #0284c7; border-radius:6px; cursor:pointer; white-space:nowrap; font-size:13px;"><i class="fa-solid fa-plus"></i> 选择 Lora</button>
                <button type="button" data-action="clear-loras" data-field="${escapeAttr(field.id)}" title="清空" style="margin-left:4px; padding:8px 10px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:6px; cursor:pointer; font-size:12px;"><i class="fa-solid fa-trash"></i></button>`;
        } else {
            widget = `<input id="${id}" type="text" value="${escapeAttr(String(value))}" style="${inputStyle()}" />`;
        }
        const randomBtn = field.randomizable
            ? `<button type="button" data-action="randomize" data-field="${field.id}" title="随机" style="margin-left:6px; padding:6px 10px; background:#fef3c7; color:#92400e; border:1px solid #fde68a; border-radius:4px; cursor:pointer;">🎲</button>`
            : '';
        const note = field.note ? `<div style="font-size:11px; color:#9ca3af; margin-top:4px;">${escapeHtml(field.note)}</div>` : '';
        // D-WORKBENCH-ASSET-MODULE：image / video 字段的 widget 是完整模块（含自己的标题 + 标签），
        // 不再套外层 label / flex 容器，直接返回。note 也保留在模块底。
        if (field.type === 'image' || field.type === 'video') {
            return `<div style="margin-bottom:14px;">${widget}${note}</div>`;
        }
        return `
            <div style="margin-bottom:14px;">
                <label for="${id}" style="display:block; font-size:13px; color:#374151; margin-bottom:6px; font-weight:500;">${escapeHtml(field.label)}</label>
                <div style="display:flex; align-items:center;">
                    <div style="flex:1; min-width:0;">${widget}</div>
                    ${randomBtn}${extraWidget}
                </div>
                ${note}
            </div>
        `;
    }

    function inputStyle() {
        return 'width:100%; padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box;';
    }

    function collectFormValues(container, tool) {
        const t = tool || _currentTool;
        if (!t) return {};
        const values = {};
        const root = container || document;
        for (const field of (t.formFields || [])) {
            // Phase 3：lora / loraMulti 从内部 state 取（id 数组 / 单 id），不走 DOM value
            if (field.type === 'lora') {
                const el = (container && container.querySelector)
                    ? container.querySelector('#at-field-' + field.id)
                    : document.getElementById(`at-field-${field.id}`);
                const weightEl = document.getElementById(`at-field-${field.id}-weight`);
                const id = el ? Number(el.value) : NaN;
                let weight = null;
                // 仅当 weight 输入可用且填了合法数字才捕获（null = 用 lora.recommended_weight / schema.defaultWeight）
                if (weightEl && !weightEl.disabled) {
                    const w = Number(weightEl.value);
                    if (Number.isFinite(w) && w >= 0) weight = w;
                }
                if (id && !Number.isNaN(id)) {
                    values[field.id] = { id, weight };
                } else {
                    values[field.id] = { id: null, weight: null };
                }
                continue;
            }
            if (field.type === 'loraMulti') {
                values[field.id] = (_loraMultiState[field.id] || []).slice();
                continue;
            }
            const el = (container && container.querySelector)
                ? container.querySelector('#at-field-' + field.id)
                : document.getElementById(`at-field-${field.id}`);
            if (!el) continue;
            let v = el.value;
            if (field.type === 'number') {
                v = v === '' ? field.default : Number(v);
            } else if (field.type === 'image') {
                // 取 basename（兼容 \ 和 /）：用户可能输入了完整路径，或点了「选择图片」拿到本地全路径
                if (v) {
                    const parts = String(v).split(/[\\\/]/);
                    v = parts[parts.length - 1] || v;
                }
            }
            values[field.id] = v;
        }
        return values;
    }

    // ========== Phase 3: Lora 字段辅助 ==========
    // 拉候选 Lora 列表并填充单选 select（按 model 数组过滤；filterModels: 来自 schema.models，
    // 多模型工作流如 ["ZIB","ZIT"] 会与 LORA.compatible_models 求交集）
    async function loadLoraOptionsForField(field, filterModels) {
        const sel = document.getElementById(`at-field-${field.id}`);
        if (!sel) return;
        const filterEnabled = field.filterByModel !== false;  // 默认 true
        const targets = filterEnabled ? (filterModels || []) : [];
        const r = await api.loras.listByModel(targets);
        if (!r || !r.ok) {
            sel.innerHTML = `<option value="">（Lora 库加载失败）</option>`;
            return;
        }
        const loras = r.loras || [];
        if (!loras.length) {
            sel.innerHTML = `<option value="">（Lora 库为空）</option>`;
            return;
        }
        // 按 display_name → name 排序
        const sorted = loras.slice().sort((a, b) => {
            const an = (a.display_name || a.name || '').toLowerCase();
            const bn = (b.display_name || b.name || '').toLowerCase();
            return an.localeCompare(bn, 'zh');
        });
        sel.innerHTML = `<option value="">（不选）</option>` +
            sorted.map(l => {
                const label = (l.display_name || l.name) + (l.recommended_weight != null ? ` (${formatLoraWeight(l.recommended_weight)})` : '');
                return `<option value="${l.id}" data-lora-name="${escapeAttr(l.name)}" data-lora-weight="${l.recommended_weight != null ? l.recommended_weight : 1.0}">${escapeHtml(label)}</option>`;
            }).join('');
        // 默认选中 schema.default（lora id）
        if (field.default != null && field.default !== '') {
            sel.value = String(field.default);
            const opt = sel.options[sel.selectedIndex];
            const weightEl = document.getElementById(`at-field-${field.id}-weight`);
            if (weightEl && opt) {
                weightEl.value = opt.dataset.loraWeight || '';
                weightEl.disabled = false;
            }
        }
        // 监听变化：自动填权重
        sel.addEventListener('change', () => {
            const opt = sel.options[sel.selectedIndex];
            const weightEl = document.getElementById(`at-field-${field.id}-weight`);
            if (weightEl) {
                if (opt && opt.value) {
                    weightEl.value = opt.dataset.loraWeight || '';
                    weightEl.disabled = false;
                } else {
                    weightEl.value = '';
                    weightEl.disabled = true;
                }
            }
            updateRunButtonState();
        });
    }

    function formatLoraWeight(w) {
        if (typeof w !== 'number') return '1';
        const s = w.toFixed(2).replace(/\.?0+$/, '');
        return s || '1';
    }

    // 渲染 loraMulti 字段的 chip 列表（每个 chip 自带权重输入框）
    function renderLoraMultiChips(field) {
        const wrap = document.getElementById(`at-field-${field.id}`);
        if (!wrap) return;
        const items = _loraMultiState[field.id] || [];
        if (!items.length) {
            wrap.innerHTML = '<span style="font-size:12px; color:#9ca3af;">（未选 Lora）</span>';
            return;
        }
        const chipBaseStyle = 'display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:#f3e8ff; color:#6b21a8; border-radius:3px; font-size:12px;';
        // chip 用 #id 占位（先），weight 始终保留（用户改了就持久化）
        wrap.innerHTML = items.map(it => `
            <span data-lora-chip-id="${it.id}" style="${chipBaseStyle}">
                <i class="fa-solid fa-puzzle-piece"></i>
                <span class="chip-label">#${it.id}</span>
                <input type="number" data-chip-weight-id="${it.id}" value="${it.weight != null ? escapeAttr(String(it.weight)) : ''}" step="0.05" min="0" max="2" placeholder="权" title="权重（覆盖 recommended_weight）" style="width:46px; margin:0 4px; padding:1px 4px; border:1px solid #d1d5db; border-radius:4px; font-size:11px; color:#1f2937;" />
                <i class="fa-solid fa-xmark" data-remove-lora-multi="${it.id}" style="cursor:pointer; opacity:0.7; margin-left:4px;" title="移除"></i>
            </span>
        `).join('');
        // 移除
        wrap.querySelectorAll('[data-remove-lora-multi]').forEach(el => {
            el.addEventListener('click', () => {
                const rmId = Number(el.dataset.removeLoraMulti);
                _loraMultiState[field.id] = (_loraMultiState[field.id] || []).filter(x => x.id !== rmId);
                renderLoraMultiChips(field);
                updateRunButtonState();
            });
        });
        // 权重变化 → 写回 state（undefined = 清空覆盖，applier 会回退到 recommended_weight）
        wrap.querySelectorAll('[data-chip-weight-id]').forEach(inp => {
            inp.addEventListener('change', () => {
                const id = Number(inp.dataset.chipWeightId);
                const arr = _loraMultiState[field.id] || [];
                const item = arr.find(x => x.id === id);
                if (!item) return;
                if (inp.value === '' || inp.value == null) {
                    item.weight = undefined;
                } else {
                    const w = Number(inp.value);
                    if (Number.isFinite(w) && w >= 0) item.weight = w;
                }
            });
        });
        // 后台异步拉名字刷新（best-effort）—— 同步换上 display_name，weight 保留
        api.loras.list({ limit: 100000 }).then(r => {
            if (!r || !r.ok) return;
            const all = r.loras || [];
            const map = new Map(all.map(l => [l.id, l]));
            // 二次渲染前再读一次 state（可能被外部改动）
            const cur = _loraMultiState[field.id] || [];
            if (!cur.length) return;
            wrap.innerHTML = cur.map(it => {
                const l = map.get(it.id);
                const label = l ? (l.display_name || l.name) : `#${it.id}`;
                return `
                    <span data-lora-chip-id="${it.id}" style="${chipBaseStyle}">
                        <i class="fa-solid fa-puzzle-piece"></i>
                        <span class="chip-label">${escapeHtml(label)}</span>
                        <input type="number" data-chip-weight-id="${it.id}" value="${it.weight != null ? escapeAttr(String(it.weight)) : ''}" step="0.05" min="0" max="2" placeholder="权" title="权重（覆盖 recommended_weight）" style="width:46px; margin:0 4px; padding:1px 4px; border:1px solid #d1d5db; border-radius:4px; font-size:11px; color:#1f2937;" />
                        <i class="fa-solid fa-xmark" data-remove-lora-multi="${it.id}" style="cursor:pointer; opacity:0.7; margin-left:4px;" title="移除"></i>
                    </span>
                `;
            }).join('');
            wrap.querySelectorAll('[data-remove-lora-multi]').forEach(el => {
                el.addEventListener('click', () => {
                    const rmId = Number(el.dataset.removeLoraMulti);
                    _loraMultiState[field.id] = (_loraMultiState[field.id] || []).filter(x => x.id !== rmId);
                    renderLoraMultiChips(field);
                    updateRunButtonState();
                });
            });
            wrap.querySelectorAll('[data-chip-weight-id]').forEach(inp => {
                inp.addEventListener('change', () => {
                    const id = Number(inp.dataset.chipWeightId);
                    const arr = _loraMultiState[field.id] || [];
                    const item = arr.find(x => x.id === id);
                    if (!item) return;
                    if (inp.value === '' || inp.value == null) {
                        item.weight = undefined;
                    } else {
                        const w = Number(inp.value);
                        if (Number.isFinite(w) && w >= 0) item.weight = w;
                    }
                });
            });
        }).catch(() => {});
    }

    // 打开 loraMulti 选择 modal（可搜索 + 多选）
    function openLoraMultiPicker(field, filterModels) {
        const filterEnabled = field.filterByModel !== false;
        const initial = (_loraMultiState[field.id] || []).slice();
        // 复用 loras.js 风格的 modal
        let modal = document.getElementById('atLoraMultiPicker');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'atLoraMultiPicker';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:420; display:none; align-items:center; justify-content:center; padding:20px;';
            modal.innerHTML = `
                <div onclick="event.stopPropagation();" style="background:#ffffff; border-radius:10px; width:min(640px, 100%); max-height:85vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3); overflow:hidden;">
                    <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:12px;">
                        <h3 style="margin:0; flex:1; color:#1f2937; font-size:15px; font-weight:600;">选择 Lora（可多选，顺序即叠加顺序）</h3>
                        <input id="atLoraMultiSearch" type="text" placeholder="🔍 搜索" style="width:180px; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:12px;" />
                        <button id="atLoraMultiClose" class="btn btn-sm"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div id="atLoraMultiList" style="flex:1; overflow-y:auto; padding:8px;"></div>
                    <div style="padding:10px 18px; border-top:1px solid #e5e7eb; background:#f9fafb; display:flex; justify-content:space-between; align-items:center;">
                        <span id="atLoraMultiCount" style="font-size:12px; color:#6b7280;"></span>
                        <button id="atLoraMultiOk" class="btn btn-sm btn-primary"><i class="fa-solid fa-check"></i> 确定</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.addEventListener('click', () => { modal.style.display = 'none'; });
            modal.querySelector('#atLoraMultiClose').addEventListener('click', () => { modal.style.display = 'none'; });
            modal.querySelector('#atLoraMultiOk').addEventListener('click', () => {
                // 把勾选的 checkbox 转成 [{id, weight}]。每个新 item 的默认 weight 取
                // 该 lora 的 recommended_weight（来自 pool）；对已经在 initial 里的 item
                // 保留之前的 weight 覆盖。
                const checkedIds = Array.from(modal.querySelectorAll('input[data-pick-id]:checked')).map(el => Number(el.dataset.pickId));
                const poolMap = new Map((modal._pool || []).map(l => [l.id, l]));
                const prevMap = new Map(((modal._prevSelected || [])).map(it => [it.id, it]));
                const items = checkedIds.map(id => {
                    const prev = prevMap.get(id);
                    if (prev) return { id, weight: prev.weight };
                    const l = poolMap.get(id);
                    const def = l && l.recommended_weight != null ? l.recommended_weight : undefined;
                    return { id, weight: def };
                });
                const cb = modal._onConfirm;
                if (cb) cb(items);
                modal.style.display = 'none';
            });
            const searchInput = modal.querySelector('#atLoraMultiSearch');
            let timer = null;
            searchInput.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    const v = searchInput.value.trim().toLowerCase();
                    renderPickerList(modal._pool, modal._selected, v);
                }, 100);
            });
        }
        modal._field = field;
        // 保留原字段名 _modelBasename 但现在存的是数组（schema.models）
        modal._modelBasename = Array.isArray(filterModels) ? filterModels.slice() : [];
        modal._filterEnabled = filterEnabled;
        // _selected 升级成 [{id, weight}] 结构（_prevSelected 在 Ok 时用作「保留之前覆盖」的回查源）
        modal._prevSelected = initial.slice();
        modal._selected = initial.slice();
        // 加载 Lora 列表
        const targets = filterEnabled ? (Array.isArray(filterModels) ? filterModels : []) : [];
        api.loras.listByModel(targets).then(r => {
            const list = (r && r.ok && r.loras) ? r.loras : [];
            modal._pool = list;
            renderPickerList(list, modal._selected, '');
        });
        modal._onConfirm = (items) => {
            _loraMultiState[field.id] = items;
            renderLoraMultiChips(field);
            updateRunButtonState();
        };
        modal.style.display = 'flex';
    }

    function renderPickerList(pool, selected, filter) {
        const list = document.getElementById('atLoraMultiList');
        const modal = document.getElementById('atLoraMultiPicker');
        if (!list || !modal) return;
        let items = (pool || []).slice();
        if (filter) {
            items = items.filter(l => (l.name || '').toLowerCase().includes(filter) || (l.display_name || '').toLowerCase().includes(filter));
        }
        if (!items.length) {
            list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:30px; font-size:12px;">' + ((pool || []).length === 0 ? 'Lora 库为空' : '无匹配') + '</div>';
        } else {
            list.innerHTML = items.map(l => {
                // selected 可能是 [{id, weight}]，比较用 .some(x => x.id === id)
                const checked = (selected || []).some(x => x && x.id === l.id) ? 'checked' : '';
                const label = l.display_name || l.name;
                const weight = l.recommended_weight != null ? ` (${formatLoraWeight(l.recommended_weight)})` : '';
                const model = l.base_model ? ` · ${l.base_model}` : '';
                return `
                    <label style="display:flex; align-items:center; padding:8px 10px; border-radius:6px; cursor:pointer; transition:background 0.1s;"
                           onmouseenter="this.style.background='#f9fafb';"
                           onmouseleave="this.style.background='transparent';">
                        <input type="checkbox" data-pick-id="${l.id}" ${checked} style="margin-right:10px; cursor:pointer;" />
                        <span style="flex:1; font-size:13px; color:#1f2937;">${escapeHtml(label)}${weight}<span style="color:#9ca3af; font-size:11px;">${model}</span></span>
                    </label>
                `;
            }).join('');
        }
        const count = document.getElementById('atLoraMultiCount');
        if (count) count.textContent = `已选 ${(selected || []).length} 个`;
        list.querySelectorAll('input[data-pick-id]').forEach(el => {
            el.addEventListener('change', () => {
                const id = Number(el.dataset.pickId);
                if (el.checked) {
                    // 已在 selected 里就不重复添加（即使内部 weight 变了）
                    if (!modal._selected.some(x => x && x.id === id)) {
                        const poolMap = new Map((modal._pool || []).map(l => [l.id, l]));
                        const l = poolMap.get(id);
                        const def = l && l.recommended_weight != null ? l.recommended_weight : undefined;
                        modal._selected.push({ id, weight: def });
                    }
                } else {
                    modal._selected = modal._selected.filter(x => x && x.id !== id);
                }
                if (count) count.textContent = `已选 ${modal._selected.length} 个`;
            });
        });
    }

    // 判断一个工具是否为「文生图」工具：
    //   1) 没有 image 类型字段（不依赖图片上传）
    //   2) 有 textarea / text 字段（可输入 prompt）
    //   3) 输出节点包含 image 类型（产物是图片，不是视频/文本）
    // 用 listTools 返回的轻量摘要（fieldTypes / outputNodeTypes），避免对每个工具二次 get。
    function isTextToImageTool(t) {
        if (!t) return false;
        const fields = Array.isArray(t.fieldTypes) ? t.fieldTypes : [];
        let hasPromptField = false;
        for (const f of fields) {
            if (!f) continue;
            if (f.type === 'image') return false;
            if (f.type === 'textarea' || f.type === 'text') hasPromptField = true;
        }
        if (!hasPromptField) return false;
        const outs = Array.isArray(t.outputNodeTypes) ? t.outputNodeTypes : [];
        return outs.some(o => o && o.type === 'image');
    }

    function updateRunButtonState() {
        const btn = document.getElementById('atBtnRun');
        if (!btn) return;
        let hasContent = false;
        if (_currentTool) {
            for (const field of (_currentTool.formFields || [])) {
                // textarea 或 image 字段任一有值即视为「有内容」（image 至少需要选了图）
                if (field.type === 'textarea' || field.type === 'image') {
                    const el = document.getElementById(`at-field-${field.id}`);
                    if (el && el.value.trim()) { hasContent = true; break; }
                }
            }
        }
        const comfyOk = !!(_comfyStatus && _comfyStatus.running);
        // 有 prompt 即可点；ComfyUI 没跑时 runTool 会自动启动
        btn.disabled = !hasContent;
        if (!hasContent) {
            btn.title = '请填入提示词';
        } else if (!comfyOk) {
            btn.title = '点击自动启动 ComfyUI 并生图';
        } else {
            btn.title = '运行';
        }
    }

    // ========== ComfyUI 状态 / 事件订阅 ==========
    async function refreshComfyStatus() {
        let r = null;
        try { r = await api.comfyui.status(); } catch (e) {}
        // 计算状态文字 + 颜色
        let color = '#9ca3af', text = '● ComfyUI 未启动';
        if (r) {
            _comfyStatus = r;
            if (r.running) { color = '#059669'; text = `● ComfyUI 运行中 (${r.port || '?'})`; }
            else if (r.lastError) { color = '#dc2626'; text = `● ComfyUI 启动失败: ${r.lastError}`; }
        } else {
            _comfyStatus = null;
        }
        // 同步更新两个状态指示器（顶部 bar 用的 + detail 子 header 用的）
        const els = [
            document.getElementById('atComfyStatus'),
            document.getElementById('atDetailComfyStatus'),
        ].filter(Boolean);
        for (const el of els) { el.style.color = color; el.textContent = text; }
        updateRunButtonState();
    }

    function subscribeComfyEvents() {
        for (const u of _unsubs) { try { u && u(); } catch (e) {} }
        _unsubs = [];
        if (typeof api.comfyui.onProgress === 'function') {
            _unsubs.push(api.comfyui.onProgress(onComfyProgress));
            _unsubs.push(api.comfyui.onComplete(onComfyComplete));
            _unsubs.push(api.comfyui.onError(onComfyError));
            _unsubs.push(api.comfyui.onExit(onComfyExit));
        }
    }

    // ========== 运行 ==========
    async function runTool() {
        if (!_currentTool) return;
        const formValues = collectFormValues();
        // 验证：必填检查（MVP 简化：所有 textarea 必填；image 字段按 schema.required 判断）
        for (const field of (_currentTool.formFields || [])) {
            if (field.type === 'textarea' || (field.type === 'image' && field.required)) {
                const v = formValues[field.id];
                if (!v || !String(v).trim()) {
                    showToast(`请填「${field.label}」`, 'error');
                    return;
                }
            }
        }

        const btn = document.getElementById('atBtnRun');
        const meta = document.getElementById('atRunMeta');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 启动中...'; }
        // 1) 自动启动 ComfyUI（如果没有运行）
        await refreshComfyStatus();
        if (!_comfyStatus || !_comfyStatus.running) {
            if (meta) { meta.textContent = 'ComfyUI 未启动，正在自动启动（大模型冷启可能需 30-120s）...'; meta.style.color = '#0ea5e9'; }
            const sr = await api.comfyui.start({});  // 传空对象 → 后端用 KVDb 里的 cfg
            if (!sr || !sr.ok) {
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 运行'; }
                if (meta) { meta.textContent = 'ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'); meta.style.color = '#dc2626'; }
                showToast('ComfyUI 启动失败: ' + ((sr && sr.error) || '未知'), 'error');
                await refreshComfyStatus();
                return;
            }
            await refreshComfyStatus();
        }
        // 2) 提交
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成中...'; }
        if (meta) { meta.textContent = '提交生图任务...'; meta.style.color = '#0ea5e9'; }
        const r = await api.tools.run({ toolId: _currentTool.id, formValues });
        if (!r || !r.ok) {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 运行'; }
            if (meta) { meta.textContent = '运行失败: ' + ((r && r.error) || '未知'); meta.style.color = '#dc2626'; }
            showToast('运行失败: ' + ((r && r.error) || '未知'), 'error');
            return;
        }
        _currentJobId = r.jobId;
        // 记录上下文：complete 时用于自动存档
        _currentJobCtx = {
            toolId: _currentTool.id,
            toolName: (_currentTool && _currentTool.name) || _currentTool.id,
            formValues: formValues,
            mode: (_currentTool && _currentTool.mode) || 'sfw',
        };
        if (meta) { meta.textContent = `jobId=${r.jobId} | 等待结果...`; }
        // 显示「暂停生成」按钮（运行中可见；结束/错误时再隐藏）
        const cancelBtn = document.getElementById('atBtnCancel');
        if (cancelBtn) cancelBtn.style.display = '';
        showImageWaiting();
    }

    // 暂停生成：调主进程 comfyui:cancel（abort AbortController）+ 重置 UI
    async function cancelTool() {
        if (!_currentJobId) return;
        const jobId = _currentJobId;
        const cancelBtn = document.getElementById('atBtnCancel');
        const meta = document.getElementById('atRunMeta');
        if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 暂停中...'; }
        try {
            await api.comfyui.cancel(jobId);
        } catch (e) {
            // 即便后端失败也要把 UI 复位
            console.warn('[ai-tools] cancel 调用失败:', e && e.message);
        }
        // 清状态（onComfyError 也会再清一次，但这里是用户主动行为，UI 要立刻响应）
        _currentJobId = null;
        _currentJobCtx = null;
        const runBtn = document.getElementById('atBtnRun');
        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="fa-solid fa-play"></i> 运行'; }
        if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.disabled = false; cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> 暂停生成'; }
        if (meta) { meta.textContent = '已暂停生成'; meta.style.color = '#6b7280'; }
        showToast('已暂停生成', 'info');
    }

    // 复位取消按钮：让 onComfyComplete / onComfyError 等收尾场景统一隐藏
    function hideCancelButton() {
        const cancelBtn = document.getElementById('atBtnCancel');
        if (cancelBtn) {
            cancelBtn.style.display = 'none';
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = '<i class="fa-solid fa-stop"></i> 暂停生成';
        }
    }

    function showImageWaiting() {
        const empty = document.getElementById('atResultImageEmpty');
        const loadedImg = document.getElementById('atResultImageLoaded');
        const loadedText = document.getElementById('atResultTextLoaded');
        if (empty) empty.style.display = 'flex';
        if (loadedImg) loadedImg.style.display = 'none';
        if (loadedText) loadedText.style.display = 'none';
    }

    function showImageLoaded() {
        const empty = document.getElementById('atResultImageEmpty');
        const loadedImg = document.getElementById('atResultImageLoaded');
        const loadedText = document.getElementById('atResultTextLoaded');
        if (empty) empty.style.display = 'none';
        if (loadedImg) loadedImg.style.display = 'flex';
        if (loadedText) loadedText.style.display = 'none';
    }

    function showTextLoaded() {
        const empty = document.getElementById('atResultImageEmpty');
        const loadedImg = document.getElementById('atResultImageLoaded');
        const loadedText = document.getElementById('atResultTextLoaded');
        if (empty) empty.style.display = 'none';
        if (loadedImg) loadedImg.style.display = 'none';
        if (loadedText) loadedText.style.display = 'flex';
    }

    function onComfyProgress(payload) {
        if (!payload || payload.jobId !== _currentJobId) return;
        const meta = document.getElementById('atRunMeta');
        if (meta) meta.textContent = `采样中 ${payload.value || '?'}/${payload.max || '?'}...`;
    }

    function onComfyComplete(payload) {
        if (!payload || payload.jobId !== _currentJobId) return;
        const kind = payload.kind || 'image';   // 旧版 payload 无 kind → 视为 image
        _currentImage = { kind, dataUrl: payload.dataUrl, filename: payload.filename, mime: payload.mime, text: payload.text || null };
        _currentJobId = null;
        hideCancelButton();
        const metaEl = kind === 'text' ? document.getElementById('atResultTextMeta') : document.getElementById('atResultImageMeta');
        if (kind === 'text') {
            renderTextFromPayload(payload);
        } else {
            renderMediaFromPayload(payload);
        }
        if (metaEl) {
            const sizeKB = Math.round((payload.meta && payload.meta.fileSize ? payload.meta.fileSize : 0) / 1024);
            if (kind === 'text') {
                const len = (payload.text || '').length;
                metaEl.textContent = `${payload.filename} | ${len} 字符 | 文本`;
            } else {
                const m = (payload.mime || '').startsWith('video/') ? '视频' : '图片';
                metaEl.textContent = `${payload.filename} | ${sizeKB} KB | ${m}`;
            }
        }
        if (kind === 'text') {
            showTextLoaded();
            document.getElementById('atBtnCopyText').disabled = false;
            document.getElementById('atBtnSaveTextAs').disabled = false;
            document.getElementById('atBtnSaveTextToLibrary').disabled = false;
            // 「生成图片」按钮：仅在有文生图工具时显示
            const genImgBtn = document.getElementById('atBtnGenImageFromText');
            if (genImgBtn) {
                if (_t2iToolIds.length > 0) {
                    genImgBtn.style.display = '';
                    genImgBtn.disabled = false;
                } else {
                    genImgBtn.style.display = 'none';
                }
            }
        } else {
            showImageLoaded();
            document.getElementById('atBtnSaveImageAs').disabled = false;
        }
        const btn = document.getElementById('atBtnRun');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 运行'; }
        const meta = document.getElementById('atRunMeta');
        if (meta) { meta.textContent = '完成'; meta.style.color = '#059669'; }
        refreshComfyStatus().catch(() => {});
        showToast(kind === 'text' ? '文本生成完成' : '生图完成', 'success');
        // 自动存档到资产目录（不阻塞 UI；text 不存档）
        if (kind === 'image') autoSaveAsset(payload);
    }

    async function autoSaveAsset(payload) {
        try {
            if (!payload || !payload.dataUrl) return;
            const ctx = _currentJobCtx || {};
            const m = payload.meta || {};
            // 提取 prompt 字段：找第一个 textarea 类型 field 的值
            let promptText = '';
            try {
                const fv = ctx.formValues || {};
                const ff = (_currentTool && _currentTool.formFields) || [];
                for (const f of ff) {
                    if (f && f.type === 'textarea' && typeof fv[f.id] === 'string') {
                        promptText = fv[f.id];
                        break;
                    }
                }
            } catch {}
            // Phase 4：从 formValues 提取本次用到的 Lora id（lora 单选 + loraMulti 多选）。
            // formValues 可能是老格式（裸 number）或新格式（{id, weight}），兼容处理。
            // usedLoras 本地存 [{id, weight}]，weight 是用户覆盖（null = 用 lora 推荐 / schema 默认）。
            const usedLoras = [];
            try {
                const fv = ctx.formValues || {};
                const ff = (_currentTool && _currentTool.formFields) || [];
                for (const f of ff) {
                    if (!f) continue;
                    if (f.type === 'lora') {
                        const raw = fv[f.id];
                        const itemObj = (raw && typeof raw === 'object') ? raw : null;
                        const id = itemObj ? Number(itemObj.id) : Number(raw);
                        if (id && !Number.isNaN(id) && !usedLoras.some(x => x.id === id)) {
                            const weight = itemObj && itemObj.weight != null ? Number(itemObj.weight) : null;
                            usedLoras.push({ id, weight: (Number.isFinite(weight) ? weight : null) });
                        }
                    } else if (f.type === 'loraMulti' && Array.isArray(fv[f.id])) {
                        for (const raw of fv[f.id]) {
                            const itemObj = (raw && typeof raw === 'object') ? raw : null;
                            const id = itemObj ? Number(itemObj.id) : Number(raw);
                            if (id && !Number.isNaN(id) && !usedLoras.some(x => x.id === id)) {
                                const weight = itemObj && itemObj.weight != null ? Number(itemObj.weight) : null;
                                usedLoras.push({ id, weight: (Number.isFinite(weight) ? weight : null) });
                            }
                        }
                    }
                }
            } catch {}
            // 异步查 Lora 详情（basename + 推荐权重 + 用户覆盖的 weight）写入 meta；查不到就只存 id
            let usedLoraDetails = usedLoras.map(x => ({ id: x.id, weight: x.weight }));
            try {
                const all = await api.loras.list({ limit: 100000 });
                if (all && all.ok && Array.isArray(all.loras)) {
                    const map = new Map(all.loras.map(l => [l.id, l]));
                    usedLoraDetails = usedLoras.map(x => {
                        const l = map.get(x.id);
                        if (!l) return { id: x.id, weight: x.weight };
                        return {
                            id: x.id,
                            name: l.name,
                            display_name: l.display_name || '',
                            lora_type: l.lora_type || '',
                            recommended_weight: l.recommended_weight != null ? l.recommended_weight : null,
                            weight: x.weight,  // 用户本次覆盖
                        };
                    });
                }
            } catch {}
            const meta = {
                toolId: ctx.toolId || '',
                toolName: ctx.toolName || '',
                mode: ctx.mode || (m.mode || null),
                prompt: promptText,
                formValues: ctx.formValues || {},
                usedLoras: usedLoraDetails,
                workflow: {
                    checkpoints: (m.models && m.models.checkpoints) || [],
                    loras: (m.models && m.models.loras) || [],
                    vaes: (m.models && m.models.vaes) || [],
                },
                timing: {
                    elapsedMs: m.elapsedMs || 0,
                    startedAt: m.startedAt || null,
                },
                vram: {
                    peakBytes: m.vramPeakBytes || 0,
                },
                node: m.node || null,
                source: 'ai-tools',
            };
            // 文件名：tool-id + 时间戳
            const stem = `${ctx.toolId || 'tool'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
            const r = await api.comfyui.saveAsset({
                filename: stem,
                mime: payload.mime || 'image/png',
                dataUrl: payload.dataUrl,
                meta,
            });
            if (r && r.ok) {
                console.log('[ai-tools] 已自动存档:', r.assetPath, '|', (r.size / 1024).toFixed(1) + 'KB');
            } else if (r && r.error) {
                console.warn('[ai-tools] 自动存档失败:', r.error);
            }
        } catch (e) {
            console.warn('[ai-tools] autoSaveAsset 异常:', e && e.message);
        } finally {
            _currentJobCtx = null;
        }
    }

    function onComfyError(payload) {
        if (!payload) return;
        if (payload.jobId && payload.jobId !== _currentJobId) return;
        _currentJobId = null;
        hideCancelButton();
        const meta = document.getElementById('atRunMeta');
        if (meta) { meta.textContent = 'ComfyUI 错误: ' + (payload.message || '未知'); meta.style.color = '#dc2626'; }
        const btn = document.getElementById('atBtnRun');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 运行'; }
        showToast('ComfyUI: ' + (payload.message || '失败'), 'error');
    }

    function onComfyExit(payload) {
        const els = [
            document.getElementById('atComfyStatus'),
            document.getElementById('atDetailComfyStatus'),
        ].filter(Boolean);
        for (const el of els) { el.style.color = '#dc2626'; el.textContent = `● ComfyUI 已退出`; }
        _comfyStatus = { running: false };
    }

    function saveCurrentImageAs() {
        if (!_currentImage) return;
        const { dataUrl, filename, mime } = _currentImage;
        const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
        if (!m) { showToast('图片数据格式异常', 'error'); return; }
        const base64 = m[2];
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const defaultName = filename || `ai-tool-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`;
        api.comfyui.saveAs({ defaultName, mime, dataBase64: base64 }).then(r => {
            if (r && r.ok) showToast('已保存到 ' + (r.path || '本地'), 'success');
            else showToast('另存为失败: ' + ((r && r.error) || '未知'), 'error');
        });
    }

    // 复制当前文本结果到剪贴板
    async function copyCurrentText() {
        if (!_currentImage || _currentImage.kind !== 'text') return;
        const text = _currentImage.text || '';
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // 兜底：textarea + execCommand
                const ta = document.getElementById('atResultTextArea');
                if (ta) { ta.removeAttribute('readonly'); ta.select(); document.execCommand('copy'); ta.setAttribute('readonly', 'readonly'); ta.blur(); }
            }
            showToast('已复制到剪贴板', 'success');
        } catch (e) {
            showToast('复制失败: ' + (e && e.message || '未知'), 'error');
        }
    }

    // 另存当前文本为 .txt 文件
    function saveCurrentTextAs() {
        if (!_currentImage || _currentImage.kind !== 'text') return;
        const text = _currentImage.text || '';
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stem = `${_currentJobCtx && _currentJobCtx.toolId ? _currentJobCtx.toolId : 'ai-tool'}-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
        const defaultName = `${stem}.txt`;
        // 走 saveAs（main 端拿 base64 → 写盘）；文本用 utf8 编码（先转 base64）
        const base64 = btoa(unescape(encodeURIComponent(text)));
        api.comfyui.saveAs({ defaultName, mime: 'text/plain', dataBase64: base64 }).then(r => {
            if (r && r.ok) showToast('已保存到 ' + (r.path || '本地'), 'success');
            else showToast('另存为失败: ' + ((r && r.error) || '未知'), 'error');
        });
    }

    // 从当前文本结果跳转到文生图工具，提示词自动填入第一个 textarea 字段
    async function genImageFromCurrentText() {
        if (!_currentImage || _currentImage.kind !== 'text') return;
        if (!_t2iToolIds.length) {
            showToast('未找到文生图工具（需要在 resources/comfyui-workflows/ 添加 schema）', 'error');
            return;
        }
        const text = _currentImage.text || '';
        const targetId = _t2iToolIds[0];
        const targetMeta = (_tools || []).find(t => t.id === targetId);
        const targetName = targetMeta ? (targetMeta.name || targetId) : targetId;

        // 1) 跳转到目标工具（selectTool 内部会渲染表单 + 清空结果区）
        await selectTool(targetId);
        if (!_currentTool) return;

        // 2) 找第一个 textarea 字段（约定为「提示词」主输入）
        let targetField = null;
        for (const f of _currentTool.formFields || []) {
            if (f.type === 'textarea') { targetField = f; break; }
        }
        if (!targetField) {
            showToast('目标工具没有可填的提示词字段', 'error');
            return;
        }

        // 3) 覆盖默认值
        const el = document.getElementById('at-field-' + targetField.id);
        if (!el) {
            showToast('目标工具表单未渲染，跳转失败', 'error');
            return;
        }
        el.value = text;
        updateRunButtonState();
        showToast(`已跳转到「${targetName}」，提示词已自动填入`, 'success');
    }

    // 保存当前文本到提示词库（KVDb-based api.prompts，与主生成页右上角「提示词库」按钮同一个表）
    // 写入字段：id, prompt, tags（不带分类）
    async function saveCurrentTextToLibrary() {
        if (!_currentImage || _currentImage.kind !== 'text') return;
        const text = (_currentImage.text || '').trim();
        if (!text) { showToast('文本为空，无法保存', 'error'); return; }

        const btn = document.getElementById('atBtnSaveTextToLibrary');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...'; }
        try {
            // id 用「工具id + 时间戳」方便溯源，tags 带上工具名 + mode
            const ts36 = Date.now().toString(36);
            const toolId = (_currentJobCtx && _currentJobCtx.toolId) || 'ai-tool';
            const id = `${toolId}-${ts36}`;
            const toolName = (_currentJobCtx && _currentJobCtx.toolName) || 'AI 工具';
            const mode = (_currentJobCtx && _currentJobCtx.mode) || 'sfw';
            const tags = [toolName, mode, '反推'];
            const r = await api.prompts.writeOne(id, text, tags);
            if (!r || !r.ok) {
                throw new Error((r && r.error) || '保存失败');
            }
            showToast(`已保存到提示词库（id: ${id}）`, 'success');
        } catch (e) {
            showToast('保存失败: ' + (e && e.message || '未知'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-database"></i> 保存到提示词库'; }
        }
    }

    // 放大查看生图结果（点击图片/视频打开全屏 modal）
    function openMediaZoomModal(src, mime) {
        if (!src) return;
        const isVideo = (mime || '').startsWith('video/');
        let overlay = document.getElementById('atImgZoomOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'atImgZoomOverlay';
            overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:100000; display:flex; align-items:center; justify-content:center; cursor:zoom-out;';
            overlay.innerHTML = `
                <img id="atImgZoomImg" style="max-width:95vw; max-height:95vh; object-fit:contain; box-shadow:0 8px 32px rgba(0,0,0,0.5); border-radius:6px; background:#111827;" />
                <video id="atImgZoomVideo" controls style="max-width:95vw; max-height:95vh; object-fit:contain; box-shadow:0 8px 32px rgba(0,0,0,0.5); border-radius:6px; background:#111827; display:none;"></video>
                <button id="atImgZoomClose" title="关闭 (Esc)" style="position:absolute; top:18px; right:22px; width:40px; height:40px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); background:rgba(0,0,0,0.5); color:#ffffff; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-xmark"></i></button>
            `;
            document.body.appendChild(overlay);

            const close = () => {
                overlay.style.display = 'none';
                // 关闭时停掉视频
                const v = overlay.querySelector('#atImgZoomVideo');
                if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
            };
            overlay.addEventListener('click', (e) => {
                if (e.target.closest('#atImgZoomClose') || e.target.id === 'atImgZoomImg' || e.target.id === 'atImgZoomVideo' || e.target === overlay) {
                    close();
                }
            });
            overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
            overlay.tabIndex = -1;
        }
        const img = overlay.querySelector('#atImgZoomImg');
        const vid = overlay.querySelector('#atImgZoomVideo');
        if (isVideo) {
            if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
            if (vid) { vid.src = src; vid.style.display = 'block'; }
        } else {
            if (vid) { vid.pause(); vid.removeAttribute('src'); vid.style.display = 'none'; vid.load(); }
            if (img) { img.src = src; img.style.display = 'block'; }
        }
        overlay.style.display = 'flex';
        overlay.focus();
    }

    // 渲染生图/视频结果到结果区（按 mime 自动切换 img/video）
    function renderMediaFromPayload(payload) {
        const mime = payload.mime || '';
        const dataUrl = payload.dataUrl || '';
        const img = document.getElementById('atResultMediaImg');
        const vid = document.getElementById('atResultMediaVideo');
        if ((mime || '').startsWith('video/')) {
            if (img) { img.removeAttribute('src'); img.style.display = 'none'; }
            if (vid) { vid.src = dataUrl; vid.style.display = 'block'; vid.load(); }
        } else {
            if (vid) { vid.pause(); vid.removeAttribute('src'); vid.style.display = 'none'; vid.load(); }
            if (img) { img.src = dataUrl; img.style.display = 'block'; }
        }
    }

    // 渲染文本结果到结果区（textarea 显示 + meta 行）
    function renderTextFromPayload(payload) {
        const ta = document.getElementById('atResultTextArea');
        if (ta) ta.value = payload.text || '';
    }

    function clearMediaElement() {
        const img = document.getElementById('atResultMediaImg');
        const vid = document.getElementById('atResultMediaVideo');
        if (img) { img.removeAttribute('src'); img.style.display = 'block'; }
        if (vid) { vid.pause(); vid.removeAttribute('src'); vid.style.display = 'none'; vid.load(); }
    }

    function clearTextElement() {
        const ta = document.getElementById('atResultTextArea');
        if (ta) ta.value = '';
    }

    // ========== 嵌入模式 API ==========
    // 暴露给工作台作为可复用模块（renderForm / collectFormValues 支持任意 container）
    function _ensureEmbeddedShell() {
        let shell = document.getElementById('atEmbeddedForm');
        if (shell) return shell;
        shell = document.createElement('div');
        shell.id = 'atEmbeddedForm';
        shell.style.cssText = 'display:flex; flex-direction:column; min-height:0;';
        return shell;
    }
    function renderEmbeddedForm(tool, container) {
        const host = container || document.body;
        let shell = host.querySelector('#atEmbeddedForm');
        if (!shell) {
            shell = _ensureEmbeddedShell();
            host.appendChild(shell);
        }
        shell.innerHTML = '';
        renderForm(tool, shell);
        return shell;
    }

    // ========== utils ==========
    // D-WORKBENCH：转义工具统一从 window.dUtil 取（共享，避免 4 处漂移）
    const { escapeHtml, escapeAttr } = window.dUtil;
    function showToast(msg, type) {
        // 复用 script.js 的全局 toast（如果有）
        if (window.showToast) { window.showToast(msg, type); return; }
        // 兜底：alert
        alert(msg);
    }

    // ========== 暴露 ==========
    // jumpToTool(toolId, prefill?) — 从外部跳转到指定工具，可选预填字段
    //   prefill: { [fieldId]: { type, value?, srcPath?, dataUrl? } }
    //     - text/textarea：直接 value
    //     - image：
    //         优先 dataUrl（base64 流，兼容 file:// / blob: / http(s): 任意来源）
    //         回退 srcPath（已知磁盘路径，main 端 fs.copyFileSync 复制）
    //         都缺时兜底填 basename
    async function jumpToTool(toolId, prefill) {
        await open();                  // 确保 aiToolsPage 已创建
        await selectTool(toolId);      // 渲染表单 + 切到 detail 视图
        if (!_currentTool) return;
        const fields = _currentTool.formFields || [];
        prefill = prefill || {};
        for (const f of fields) {
            const pf = prefill[f.id];
            if (!pf) continue;
            const el = document.getElementById('at-field-' + f.id);
            if (!el) continue;
            if (pf.type === 'image' || f.type === 'image') {
                let stagedName = '';
                // 优先用 dataUrl（兼容任意来源）
                if (pf.dataUrl && typeof api.comfyui.stageImageData === 'function') {
                    const r = await api.comfyui.stageImageData({ dataUrl: pf.dataUrl });
                    if (r && r.ok && r.comfyuiName) {
                        stagedName = r.comfyuiName;
                        if (r.copyError) showToast(`图片未复制到 ComfyUI input：${r.copyError}`, 'error');
                    } else {
                        showToast('复制图片到 ComfyUI 失败: ' + ((r && r.error) || '未知'), 'error');
                    }
                }
                // 回退到 srcPath
                if (!stagedName && pf.srcPath && typeof api.comfyui.stageImage === 'function') {
                    const src = pf.srcPath;
                    const r = await api.comfyui.stageImage({ srcPath: src });
                    if (r && r.ok && r.comfyuiName) {
                        stagedName = r.comfyuiName;
                        if (r.copyError) showToast(`图片未自动复制：${r.copyError}`, 'error');
                    } else {
                        showToast('复制图片到 ComfyUI 失败: ' + ((r && r.error) || '未知'), 'error');
                    }
                }
                // 兜底：填 basename
                if (!stagedName) {
                    stagedName = String(pf.srcPath || pf.value || '').split(/[\\/]/).pop();
                }
                if (stagedName) el.value = stagedName;
            } else {
                el.value = pf.value !== undefined ? pf.value : '';
            }
        }
        updateRunButtonState();
    }

    window.aiTools = { open, close, isOpen, jumpToTool };
    window.aiToolsEmbedded = {
        renderForm,
        collectFormValues,
        renderEmbeddedForm,
        renderEmbeddedFormSections,
        // D-WORKBENCH-PICKIMAGE：工作台三栏分发场景需要主动调这两个
        bindFormActions,
        initLoraFields,
        // D-WORKBENCH-LORA-MODULE：工作台 LORA 模块读写 lora / loraMulti 状态
        // （替代旧的「select + chip」控件，统一用封面预览 + 弹框多选）
        getLoraMultiState: (fieldId) => (_loraMultiState[fieldId] || []).slice(),
        setLoraMultiState: (fieldId, items) => {
            _loraMultiState[fieldId] = Array.isArray(items) ? items.slice() : [];
            // 同步刷新 chip 容器（以防旧 UI 仍然可见）
            // 注意：_currentTool 在 workbench 路径下可能为 null，找不到字段就直接跳过
            const f = (_currentTool && _currentTool.formFields || [])
                .find(x => x && x.id === fieldId);
            if (f && f.type === 'loraMulti') {
                try { renderLoraMultiChips(f); } catch (e) { /* 字段 wrapper 不在 DOM 时忽略 */ }
            }
            try { updateRunButtonState(); } catch (e) {}
        },
        // 单选 lora：读写 at-field-{id} select 值与 at-field-{id}-weight input 值
        getLoraSingleState: (fieldId) => {
            const sel = document.getElementById('at-field-' + fieldId);
            const weightEl = document.getElementById('at-field-' + fieldId + '-weight');
            const id = sel ? Number(sel.value) : NaN;
            let weight = null;
            if (weightEl && !weightEl.disabled) {
                const w = Number(weightEl.value);
                if (Number.isFinite(w) && w >= 0) weight = w;
            }
            return { id: (id && !Number.isNaN(id)) ? id : null, weight };
        },
        setLoraSingleState: (fieldId, { id, weight } = {}) => {
            const sel = document.getElementById('at-field-' + fieldId);
            if (sel) {
                if (id == null) {
                    sel.value = '';
                } else {
                    sel.value = String(id);
                }
                // 触发 change 监听以同步 weight input（loadLoraOptionsForField 已绑定）
                try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
            }
            const weightEl = document.getElementById('at-field-' + fieldId + '-weight');
            if (weightEl) {
                if (weight == null) {
                    weightEl.value = '';
                } else {
                    weightEl.value = String(weight);
                }
            }
            try { updateRunButtonState(); } catch (e) {}
        },
    };
})();
