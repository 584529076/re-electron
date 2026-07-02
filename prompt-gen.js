// prompt-gen.js — D-27 提示词自动生成器 UI
//
// 布局（3 列）：
//   [1] 模块列表          [2] 标签选择器            [3] 生成结果
//   - 12 个模块（左边）    - 当前模块的标签（芯片）   - 完整提示词
//   - 选模块 → 显示标签    - 多选                     - 复制/保存/重新生成
//                                                  - 取消按钮
//                                                  - 历史抽屉
//
// 入口：window.promptGen.open()  —— 由 config-ui.js 的「提示词生成」按钮调用
'use strict';

(function () {
    const api = window.api || {};
    if (!api.llm) {
        console.warn('[prompt-gen] window.api.llm 不可用，模块禁用');
        return;
    }

    // ========== 状态 ==========
    let _menuTree = [];              // prompt_menu 全部扁平 [{id,parent_id,category_name,pid_list,...}]
    let _l1Children = {};            // { [l1Id]: [childMenu] }  急查表
    let _l3Children = {};            // { [l2Id]: [childMenu] }
    let _menuById = new Map();      // D-33: id → node 快查表（替代 _menuTree.find）
    let _l1Roots = [];               // D-33: 顶层分类缓存（filter+sort 一次，renderL1 不再每次算）
    let _selectedItems = new Map();  // itemId → item （选中项，原 _selectedTags 改名）
    let _currentL1Id = null;
    let _currentL2Id = null;
    let _llmConfig = null;           // { baseUrl, model, temperature, mode, systemPrompts }
    let _availableModels = [];       // Ollama 拉到的模型列表
    let _activeJobId = null;         // 当前生成任务的 jobId
    let _resultText = '';            // 当前生成结果
    let _lastGeneratedItems = [];    // 上次生成的项快照（用于历史）

    // ========== 入口 ==========
    async function open() {
        _injectPromptGenLightCss();
        if (!document.getElementById('promptGenPage')) {
            createPage();
        }
        // 拉数据
        await Promise.all([loadMenuTree(), loadLlmConfig()]);
        showPage();
        renderL1();
        // 默认选第一个 L1 + 第一个 L2
        if (_menuTree.length > 0) {
            const firstL1 = _l1Roots[0];  // D-33: 用缓存，不重新 filter
            if (firstL1) {
                selectL1(firstL1.id);
                const firstL2 = (_l1Children[firstL1.id] || [])[0];
                if (firstL2) selectL2(firstL2.id);
            }
        }
        await refreshOllamaStatus();
        // D-30: 检测 NSFW 模板是否已导入
        checkNsfwTemplates();
    }

    async function checkNsfwTemplates() {
        const r = await api.nsfw.listTemplates();
        if (!r.ok) {
            // 未导入：提示一次（不拦住）
            const meta = document.getElementById('pgResultMeta');
            if (meta) {
                meta.textContent = '⚠️ 未导入 NSFW 模板 → 点「模型」→「导入本地 NSFW 模板」即可启用「拼装」按钮';
                meta.style.color = '#dc2626';
            }
        } else if (r.meta) {
            const meta = document.getElementById('pgResultMeta');
            if (meta) {
                meta.textContent = `✅ 已加载 NSFW 模板: ${r.meta.count} 词条 / ${r.meta.moduleCount} 模块`;
                meta.style.color = '#059669';
            }
        }
    }

    function close() {
        const page = document.getElementById('promptGenPage');
        if (page) page.style.display = 'none';
        if (window.configUI && window.configUI.showGallery) {
            window.configUI.showGallery();
        }
    }

    // ========== DOM 创建 ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'promptGenPage';
        page.style.cssText = 'position:fixed; inset:0; background:#f5f6f8; z-index:200; display:none; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        page.innerHTML = `
            <div id="pgHeaderBar" style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; box-shadow:0 1px 2px rgba(0,0,0,0.04);">
                <button id="pgBtnBack" class="btn" title="返回瀑布流页" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                <h2 style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-wand-magic-sparkles" style="color:#6366f1;"></i> 提示词自动生成</h2>
                <!-- D-29: SFW / NSFW 模式切换 -->
                <div id="pgModeTabs" style="display:inline-flex; background:#f3f4f6; border-radius:8px; padding:3px; margin-right:12px;">
                    <button data-mode="sfw" class="pgModeTab" style="padding:5px 14px; font-size:12px; font-weight:500; border:none; background:#ffffff; color:#1f2937; border-radius:6px; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.05);"><i class="fa-solid fa-shield-halved"></i> SFW</button>
                    <button data-mode="nsfw" class="pgModeTab" style="padding:5px 14px; font-size:12px; font-weight:500; border:none; background:transparent; color:#6b7280; border-radius:6px; cursor:pointer;"><i class="fa-solid fa-fire"></i> NSFW</button>
                </div>
                <span id="pgOllamaStatus" style="margin-right:12px; font-size:12px; color:#9ca3af;">● Ollama 未连接</span>
                <button id="pgBtnSettings" class="btn" title="LLM 配置"><i class="fa-solid fa-gear"></i> 模型</button>
                <button id="pgBtnConfig" class="btn" title="分类配置" style="margin-left:8px;"><i class="fa-solid fa-folder-tree"></i> 配置</button>
                <button id="pgBtnHistory" class="btn" title="生成历史" style="margin-left:8px;"><i class="fa-solid fa-clock-rotate-left"></i> 历史</button>
            </div>
            <div style="display:flex; flex:1; min-height:0;">
                <!-- D-31: 1. 一级分类列表 -->
                <div id="pgL1List" style="width:180px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:10px 0; background:#ffffff;"></div>
                <!-- D-31: 2. 二级分类列表（随 L1 联动；无数据时隐藏） -->
                <div id="pgL2List" style="display:none; width:180px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:10px 0; background:#fafafa;"></div>
                <!-- D-31: 3. 内容区：L2 自带数据 + L3 竖向列表 -->
                <div style="flex:1; display:flex; flex-direction:column; min-width:0; background:#f9fafb;">
                    <div id="pgContentTitle" style="padding:12px 18px; font-size:13px; color:#374151; border-bottom:1px solid #e5e7eb; background:#ffffff; display:flex; align-items:center; gap:8px;">
                        <i class="fa-solid fa-folder-open" style="color:#6366f1;"></i>
                        <span id="pgContentBreadcrumb" style="flex:1;">请选择左侧分类</span>
                    </div>
                    <div id="pgContent" style="flex:1; overflow-y:auto; padding:14px 18px;"></div>
                    <div style="padding:10px 18px; border-top:1px solid #e5e7eb; display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:#ffffff;">
                        <span id="pgSelectedCount" style="font-size:12px; color:#6b7280;">已选 0 个项</span>
                        <button id="pgBtnClear" class="btn btn-sm">清空选择</button>
                        <span style="flex:1"></span>
                        <button id="pgBtnGenerate" class="btn btn-primary"><i class="fa-solid fa-wand-magic-sparkles"></i> 生成提示词</button>
                        <button id="pgBtnAssemble" class="btn" style="background:#10b981; color:#ffffff; border:1px solid #059669; margin-left:6px;" title="从本地 NSFW 模板拼装（零 LLM 依赖，< 10ms）"><i class="fa-solid fa-puzzle-piece"></i> 拼装</button>
                        <button id="pgBtnCancel" class="btn" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca; display:none;"><i class="fa-solid fa-xmark"></i> 取消</button>
                    </div>
                    <div id="pgModeBanner" style="display:none; padding:6px 18px; font-size:11px; color:#dc2626; background:#fef2f2; border-top:1px solid #fecaca;">
                        <i class="fa-solid fa-triangle-exclamation"></i> NSFW 模式已启用 · 基于 <a href="https://github.com/ShuaiHui/nsfw-prompt-templates-asian" target="_blank" style="color:#dc2626; text-decoration:underline;">ShuaiHui/nsfw-prompt-templates-asian</a> 组装规则
                    </div>
                </div>
                <!-- 3. 生成结果 -->
                <div style="width:420px; border-left:1px solid #e5e7eb; display:flex; flex-direction:column; background:#ffffff;">
                    <div style="padding:12px 16px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between;">
                        <span style="font-size:14px; color:#374151; font-weight:500;">生成结果</span>
                        <span id="pgResultMeta" style="font-size:11px; color:#9ca3af;"></span>
                    </div>
                    <textarea id="pgResult" style="flex:1; padding:14px 16px; background:#fafafa; color:#1f2937; border:none; resize:none; font-size:14px; line-height:1.7; font-family:inherit;" placeholder="点击「生成提示词」开始..."></textarea>
                    <div style="padding:10px 14px; border-top:1px solid #e5e7eb; display:flex; gap:6px; flex-wrap:wrap; background:#ffffff;">
                        <button id="pgBtnCopy" class="btn btn-sm"><i class="fa-solid fa-copy"></i> 复制</button>
                        <button id="pgBtnSave" class="btn btn-sm btn-primary" disabled><i class="fa-solid fa-floppy-disk"></i> 保存到提示词库</button>
                        <button id="pgBtnRegen" class="btn btn-sm" disabled><i class="fa-solid fa-rotate"></i> 重新生成</button>
                        <button id="pgBtnRefine" class="btn btn-sm" disabled style="background:#8b5cf6; color:#ffffff; border:1px solid #7c3aed;" title="把当前拼装结果发给 LLM 润色"><i class="fa-solid fa-wand-magic"></i> 拼装后优化</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(page);

        // 绑定
        page.querySelector('#pgBtnBack').addEventListener('click', close);
        page.querySelector('#pgBtnGenerate').addEventListener('click', doGenerate);
        page.querySelector('#pgBtnAssemble').addEventListener('click', doAssemble);
        page.querySelector('#pgBtnCancel').addEventListener('click', doCancel);
        page.querySelector('#pgBtnCopy').addEventListener('click', doCopy);
        page.querySelector('#pgBtnSave').addEventListener('click', doSave);
        page.querySelector('#pgBtnRegen').addEventListener('click', doGenerate);
        page.querySelector('#pgBtnRefine').addEventListener('click', doRefine);
        page.querySelector('#pgBtnClear').addEventListener('click', doClear);
        page.querySelector('#pgBtnSettings').addEventListener('click', openSettingsModal);
        page.querySelector('#pgBtnConfig').addEventListener('click', openConfigModal);
        page.querySelector('#pgBtnHistory').addEventListener('click', openHistoryDrawer);
        // D-29: mode 切换
        page.querySelectorAll('.pgModeTab').forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.mode;
                await api.llm.configSet({ mode });
                _llmConfig = _llmConfig ? { ..._llmConfig, mode } : { mode };
                updateModeUI();
                // D-31: 模式切换后重新加载中间内容区，让 chip 按 sensitivity 过滤
                loadAndRenderContent();
                showToast(`已切换到 ${mode.toUpperCase()} 模式`, 'success');
            });
        });
    }

    // D-29: 模式 UI 同步
    function updateModeUI() {
        const mode = (_llmConfig && _llmConfig.mode) || 'sfw';
        document.querySelectorAll('.pgModeTab').forEach(b => {
            const active = b.dataset.mode === mode;
            if (active) {
                b.style.background = mode === 'nsfw' ? '#fee2e2' : '#ffffff';
                b.style.color = mode === 'nsfw' ? '#dc2626' : '#1f2937';
                b.style.boxShadow = '0 1px 2px rgba(0,0,0,0.08)';
            } else {
                b.style.background = 'transparent';
                b.style.color = '#6b7280';
                b.style.boxShadow = 'none';
            }
        });
        // 头部 bar 颜色提示
        const bar = document.getElementById('pgHeaderBar');
        if (bar) {
            if (mode === 'nsfw') {
                bar.style.background = 'linear-gradient(to right, #fff5f5, #ffffff)';
                bar.style.borderBottom = '1px solid #fecaca';
            } else {
                bar.style.background = '#ffffff';
                bar.style.borderBottom = '1px solid #e5e7eb';
            }
        }
        // 结果区 placeholder 文字调整
        const result = document.getElementById('pgResult');
        if (result) {
            result.placeholder = mode === 'nsfw'
                ? 'NSFW 模式已启动\n选择 2-3 个标签 → 「生成提示词」 → 输出 JAV 风格英文 prompt'
                : '点击「生成提示词」开始...';
        }
        // banner 显隐
        const banner = document.getElementById('pgModeBanner');
        if (banner) banner.style.display = mode === 'nsfw' ? 'block' : 'none';
    }

    function showPage() {
        const page = document.getElementById('promptGenPage');
        if (page) page.style.display = 'flex';
        // 隐藏瀑布流
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = 'none';
        if (header) header.style.display = 'none';
    }

    // ========== 数据加载 ==========
    async function loadMenuTree() {
        const r = await api.promptMenu.list();
        if (!r.ok) { _menuTree = []; _menuById = new Map(); _l1Roots = []; return; }
        _menuTree = r.items || [];
        // D-33: 一次性建好 byId Map + l1 根列表，后面 _menuTree.find 改 _menuById.get（O(1)）
        _menuById = new Map(_menuTree.map(x => [x.id, x]));
        _l1Roots = _menuTree.filter(x => !x.parent_id || x.parent_id === 0)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        // 建子表：L1 (parent_id=0) → L2， L2 → L3
        _l1Children = {};   // 实际都是 L2 们
        _l3Children = {};
        for (const n of _menuTree) {
            const p = n.parent_id || 0;
            if (p === 0) continue;
            // 判断这个节点是 L2 还是 L3：如果父是 root，就是 L2，否则是 L3
            const parent = _menuById.get(p);  // D-33: O(1) 取代 O(n) find
            if (parent && (!parent.parent_id || parent.parent_id === 0)) {
                (_l1Children[p] = _l1Children[p] || []).push(n);  // n 是 L2
            } else {
                (_l3Children[p] = _l3Children[p] || []).push(n);  // n 是 L3
            }
        }
        // 每个子表排序
        const sortFn = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
        for (const k in _l1Children) _l1Children[k].sort(sortFn);
        for (const k in _l3Children) _l3Children[k].sort(sortFn);
    }

    async function loadLlmConfig() {
        const r = await api.llm.configGet();
        if (r.ok) _llmConfig = r.config;
        updateModeUI();
    }

    async function refreshOllamaStatus() {
        const r = await api.llm.listModels();
        const status = document.getElementById('pgOllamaStatus');
        if (r.ok) {
            _availableModels = r.models;
            status.style.color = '#7c7';
            status.textContent = `● Ollama 在线 | ${r.models.length} 个模型`;
            if (!_llmConfig.model && r.models.length > 0) {
                // 自动选第一个
                _llmConfig.model = r.models[0].name;
                await api.llm.configSet({ model: r.models[0].name });
                status.textContent += ` (已选: ${r.models[0].name})`;
            }
        } else {
            status.style.color = '#f88';
            status.textContent = `● Ollama 未连接: ${r.error}`;
        }
    }

 

    // ========== 渲染：L1 一级分类 ==========
    function renderL1() {
        const c = document.getElementById('pgL1List');
        if (!c) return;
        c.innerHTML = '';
        const l1s = _l1Roots;  // D-33: loadMenuTree 时已算好，不再每次 filter+sort
        if (!l1s.length) {
            c.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 10px;">暂无分类</div>';
            return;
        }
        // D-33: documentFragment 批建，避免 N 次 appendChild 触发 N 次 reflow
        const frag = document.createDocumentFragment();
        for (const l1 of l1s) {
            const sel = l1.id === _currentL1Id;
            const req = l1.is_required ? 1 : 0;
            const row = document.createElement('div');
            row.style.cssText = 'padding:7px 10px;border-radius:6px;margin-bottom:2px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px;' + (sel ? 'background:#eef2ff;color:#4338ca;font-weight:500;' : 'color:#374151;');
            row.innerHTML = '<i class="fa-solid fa-layer-group" style="color:' + (sel ? '#6366f1' : '#9ca3af') + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(l1.category_name) + '</span>' + (req ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;"></span>' : '');
            row.addEventListener('click', () => selectL1(l1.id));
            frag.appendChild(row);
        }
        c.appendChild(frag);
    }

    function renderL2() {
        const c = document.getElementById('pgL2List');
        if (!c) return;
        const l2s = _l1Children[_currentL1Id] || [];  // D-33: loadMenuTree 时已排序，不再每次 sort
        // D-31: 优化 —— 无二级分类时隐藏整个 L2 栏
        if (!l2s.length) {
            c.style.display = 'none';
            c.innerHTML = '';
            return;
        }
        c.style.display = 'block';
        c.innerHTML = '';
        // D-33: documentFragment 批建
        const frag = document.createDocumentFragment();
        for (const l2 of l2s) {
            const sel = l2.id === _currentL2Id;
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 10px;border-radius:6px;margin-bottom:2px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px;' + (sel ? 'background:#ede9fe;color:#6d28d9;font-weight:500;' : 'color:#374151;');
            row.innerHTML = '<i class="fa-solid fa-folder' + (sel ? '-open' : '') + '" style="color:' + (sel ? '#7c3aed' : '#f59e0b') + ';font-size:11px;"></i><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(l2.category_name) + '</span>';
            row.addEventListener('click', () => selectL2(l2.id));
            frag.appendChild(row);
        }
        c.appendChild(frag);
    }

    function selectL1(l1Id) {
        _currentL1Id = l1Id;
        const l2s = _l1Children[l1Id] || [];
        _currentL2Id = l2s[0] ? l2s[0].id : null;
        renderL1();
        renderL2();
        loadAndRenderContent();   // D-31: L1 也可能有自带数据，直接拉一次
    }

    async function selectL2(l2Id) {
        _currentL2Id = l2Id;
        renderL2();
        await loadAndRenderContent();
    }

    async function loadAndRenderContent() {
        const l1 = _menuById.get(_currentL1Id);  // D-33: O(1) 替代 _menuTree.find
        const l2 = _menuById.get(_currentL2Id);
        // 面包屑：L1 始终显示，L2 只有选中时才拼
        const breadcrumb = (l1 ? l1.category_name : '') + (l2 ? ' > ' + l2.category_name : '');
        document.getElementById('pgContentBreadcrumb').textContent = breadcrumb;

        // D-31: 决定“当前节点 id”—— L1/L2/L3 都可能
        // 优先级：L2 > L1 > null
        const currentNodeId = _currentL2Id || _currentL1Id || null;
        if (!currentNodeId) {
            document.getElementById('pgContent').innerHTML = '<div style="color:#9ca3af;text-align:center;padding:80px 0;font-size:13px;">请选择左侧分类</div>';
            return;
        }

        // 拉当前节点 + 它下面所有子节点的 items
        const childIds = (_l3Children[currentNodeId] || []).map(x => x.id);
        const r = await api.promptItems.listByCategories([currentNodeId, ...childIds]);
        const itemMap = r.ok ? r.map : {};

        const currentItems = itemMap[currentNodeId] || [];
        const childList = _l3Children[currentNodeId] || [];  // D-33: loadMenuTree 时已排序

        const content = document.getElementById('pgContent');
        content.innerHTML = '';

        // 1) 当前节点（L1/L2）自带数据
        if (currentItems.length) {
            const nodeName = (_menuById.get(currentNodeId) || {}).category_name || '';  // D-33: O(1) 替代 _menuTree.find
            renderItemSection(content, nodeName + '（自带数据）', currentItems);
        }

        // 2) 子节点（仅 L2 下才有 L3；L1 没有 L2 时 childList 为空）
        if (!childList.length && !currentItems.length) {
            content.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:50px 0;font-size:13px;"><i class="fa-solid fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;color:#e5e7eb;"></i>此分类下暂无数据</div>';
            return;
        }
        for (const c of childList) {
            const items = itemMap[c.id] || [];
            renderItemSection(content, c.category_name, items);
        }
        updateSelectedCount();
    }

    function renderItemSection(container, title, items) {
        // D-31: 按当前模式（SFW/NSFW）过滤 sensitivity
        const mode = (_llmConfig && _llmConfig.mode) || 'sfw';
        items = items.filter(it => (it.sensitivity || 'nsfw') === mode);
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:20px;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 0 8px;border-bottom:1px solid #e5e7eb;margin-bottom:8px;';
        header.innerHTML = '<i class="fa-solid fa-tag" style="color:#6366f1;font-size:11px;"></i><span style="font-size:13px;font-weight:600;color:#374151;">' + escHtml(title) + '</span><span style="font-size:11px;color:#9ca3af;margin-left:4px;">(' + items.length + '项)</span>';
        section.appendChild(header);
        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
        if (!items.length) {
            chips.innerHTML = '<span style="font-size:12px;color:#d1d5db;">（暂无数据）</span>';
        }
        for (const it of items) {
            const sel = _selectedItems.has(it.id);
            const chip = document.createElement('div');
            chip.dataset.itemId = String(it.id);  // D-33: 让 toggleItem 能定位这个 chip 改样式
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px 6px 13px;border-radius:5px;cursor:pointer;user-select:none;font-size:12px;border:1px solid ' + (sel ? '#6366f1' : '#d1d5db') + ';background:' + (sel ? '#6366f1' : '#fff') + ';color:' + (sel ? '#ffffff' : '#374151') + ';box-shadow:' + (sel ? '0 2px 4px rgba(99,102,241,0.3)' : '0 1px 1px rgba(0,0,0,0.04)') + ';transition:all 0.1s;'; if (!sel) { chip.addEventListener('mouseenter', () => { chip.style.background = '#f3f4f6'; chip.style.borderColor = '#9ca3af'; }); chip.addEventListener('mouseleave', () => { chip.style.background = '#fff'; chip.style.borderColor = '#d1d5db'; }); };
            chip.innerHTML = '<span style="font-weight:500;">' + escHtml(it.name) + '</span>';
            chip.title = it.content || it.name;
            chip.addEventListener('click', () => toggleItem(it));
            chips.appendChild(chip);
        }
        section.appendChild(chips);
        container.appendChild(section);
    }

    function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    function toggleItem(it) {
        const wasSel = _selectedItems.has(it.id);
        if (wasSel) _selectedItems.delete(it.id);
        else _selectedItems.set(it.id, it);
        // D-33: 增量更新 — 只改 1 个 chip 样式 + 计数，不重建 content、也不调 IPC
        // 原实现：loadAndRenderContent() — 会重建所有 chip、重绑事件、多一次 IPC
        //       70+ 项的分类页里点一下能看到 50-100ms 卡顿
        const chip = document.querySelector(`#pgContent [data-item-id="${it.id}"]`);
        if (chip) applyChipSelectedStyle(chip, !wasSel);
        updateSelectedCount();
    }

    function applyChipSelectedStyle(chip, sel) {
        // 与 renderItemSection 里 chip.style.cssText 的初始样式保持同步
        if (sel) {
            chip.style.borderColor = '#6366f1';
            chip.style.background = '#6366f1';
            chip.style.color = '#ffffff';
            chip.style.boxShadow = '0 2px 4px rgba(99,102,241,0.3)';
        } else {
            chip.style.borderColor = '#d1d5db';
            chip.style.background = '#fff';
            chip.style.color = '#374151';
            chip.style.boxShadow = '0 1px 1px rgba(0,0,0,0.04)';
        }
    }

    function updateSelectedCount() {
        const c = document.getElementById('pgSelectedCount');
        if (c) c.textContent = '已选 ' + _selectedItems.size + ' 个项';
    }

    function doClear() {
        _selectedItems.clear();
        loadAndRenderContent();
        updateSelectedCount();
    }

    // ========== 生成 ==========
    async function doGenerate() {
        if (_selectedItems.size === 0) {
            showToast('请至少选 1 个项', 'error');
            return;
        }
        if (!_llmConfig || !_llmConfig.model) {
            showToast('请先在「模型」里选一个 Ollama 模型', 'error');
            return;
        }
        _activeJobId = 'gen-' + Date.now();
        setGeneratingUI(true);
        const result = document.getElementById('pgResult');
        result.value = '正在生成...';
        const meta = document.getElementById('pgResultMeta');
        meta.textContent = '模型: ' + _llmConfig.model + ' | 项: ' + _selectedItems.size + ' 个';

        const items = Array.from(_selectedItems.values());
        const r = await api.llm.generate({
            tags: items,
            modules: _modules,
            jobId: _activeJobId,
        });

        setGeneratingUI(false);
        if (r.ok) {
            result.value = r.text;
            _resultText = r.text;
            _lastGeneratedItems = items;
            document.getElementById('pgBtnSave').disabled = false;
            document.getElementById('pgBtnRegen').disabled = false;
            showToast('生成完成（已自动保存到历史）', 'success');
        } else if (r.cancelled) {
            result.value = '（已取消）';
            showToast('已取消', 'error');
        } else {
            result.value = '生成失败: ' + r.error;
            showToast('生成失败：' + r.error, 'error');
        }
    }

    async function doCancel() {
        if (!_activeJobId) return;
        await api.llm.cancel(_activeJobId);
        _activeJobId = null;
    }

    // ========== D-30: 本地拼装 / 拼装后 LLM 优化 ==========
    async function doAssemble() {
        const result = document.getElementById('pgResult');
        const meta = document.getElementById('pgResultMeta');
        const tagIds = Array.from(_selectedItems.keys());
        const btnAssemble = document.getElementById('pgBtnAssemble');
        const btnRefine = document.getElementById('pgBtnRefine');
        if (btnAssemble) btnAssemble.disabled = true;
        result.value = '正在拼装...';
        const t0 = Date.now();
        const r = await api.nsfw.assemble({ tagIds });
        const ms = Date.now() - t0;
        if (btnAssemble) btnAssemble.disabled = false;
        if (!r.ok) {
            result.value = `拼装失败: ${r.error}`;
            showToast('拼装失败：' + r.error, 'error');
            if (btnRefine) btnRefine.disabled = true;
            return;
        }
        result.value = r.text;
        _resultText = r.text;
        _lastGeneratedTags = Array.from(_selectedTags.values());
        document.getElementById('pgBtnSave').disabled = false;
        document.getElementById('pgBtnRegen').disabled = false;
        if (btnRefine) btnRefine.disabled = false;
        const ruleInfo = (r.rulesApplied && r.rulesApplied.length > 0)
            ? ` | 规则: ${r.rulesApplied.length} 条`
            : '';
        meta.textContent = `拼装: ${r.wordCount} 词 | ${ms}ms${ruleInfo}`;
        showToast(`拼装完成 (${ms}ms)`, 'success');
    }

    async function doRefine() {
        const result = document.getElementById('pgResult');
        const meta = document.getElementById('pgResultMeta');
        const tagIds = Array.from(_selectedTags.keys());
        const btnRefine = document.getElementById('pgBtnRefine');
        const btnAssemble = document.getElementById('pgBtnAssemble');
        if (!_llmConfig || !_llmConfig.model) {
            showToast('请先在「模型」里选一个 Ollama 模型', 'error');
            return;
        }
        if (btnRefine) btnRefine.disabled = true;
        if (btnAssemble) btnAssemble.disabled = true;
        setGeneratingUI(true);
        result.value = '正在拼装 + LLM 优化...';
        const r = await api.nsfw.assembleAndRefine({
            tagIds,
            mode: _mode || 'sfw',
        });
        setGeneratingUI(false);
        if (btnRefine) btnRefine.disabled = false;
        if (btnAssemble) btnAssemble.disabled = false;
        if (!r.ok) {
            const partialInfo = r.assembled ? `\n\n[拼装结果 ${r.assembled.wordCount} 词]\n${r.assembled.text}` : '';
            result.value = `拼装+优化失败: ${r.error}${partialInfo}`;
            showToast('优化失败：' + r.error, 'error');
            return;
        }
        result.value = r.refined.text;
        _resultText = r.refined.text;
        _lastGeneratedTags = Array.from(_selectedTags.values());
        document.getElementById('pgBtnSave').disabled = false;
        document.getElementById('pgBtnRegen').disabled = false;
        const a = r.assembled;
        meta.textContent = `拼装 ${a.wordCount} 词 + LLM(${r.refined.model})优化 | 原 ${r.refined.text.split(/\s+/).filter(Boolean).length} 词`;
        showToast('拼装+优化完成', 'success');
    }

    async function doImportTemplates(btn) {
        if (!btn) return;
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 导入中...';
        try {
            const r = await api.nsfw.importTemplates('D:\\nsfw-prompt-templates-asian-main');
            if (!r.ok) {
                showToast('导入失败：' + r.error, 'error');
                btn.innerHTML = oldHtml;
                btn.disabled = false;
                return;
            }
            const summary = Object.entries(r.byModule)
                .map(([k, v]) => `${k}:${v}`).join(' / ');
            showToast(`已导入 ${r.count} 词条（${r.moduleCount} 模块）`, 'success');
            btn.innerHTML = `<i class="fa-solid fa-check"></i> 已导入 ${r.count}`;
        } catch (e) {
            showToast('导入异常：' + e.message, 'error');
            btn.innerHTML = oldHtml;
            btn.disabled = false;
        }
    }

    function setGeneratingUI(isGen) {
        const btnGen = document.getElementById('pgBtnGenerate');
        const btnCancel = document.getElementById('pgBtnCancel');
        if (isGen) {
            btnGen.disabled = true;
            btnCancel.style.display = '';
        } else {
            btnGen.disabled = false;
            btnCancel.style.display = 'none';
        }
    }

    // ========== 复制 / 保存 / 重生成 ==========
    async function doCopy() {
        const result = document.getElementById('pgResult');
        if (!result.value) {
            showToast('没有可复制的内容', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(result.value);
            showToast('已复制到剪贴板', 'success');
        } catch {
            result.select();
            document.execCommand('copy');
            showToast('已复制（兼容模式）', 'success');
        }
    }

    async function doSave() {
        const result = document.getElementById('pgResult');
        if (!result.value || result.value.startsWith('正在生成')) {
            showToast('没有可保存的内容', 'error');
            return;
        }
        const id = 'gen-' + Date.now().toString(36);
        const tags = _lastGeneratedTags.map(t => t.name);
        const r = await api.prompts.writeOne(id, result.value, tags);
        if (r.ok) {
            showToast('已保存到提示词库（id: ' + id + '）', 'success');
        } else {
            showToast('保存失败：' + r.error, 'error');
        }
    }

    // ========== 设置模态（模型选择） ==========
    function openSettingsModal() {
        let modal = document.getElementById('pgSettingsModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pgSettingsModal';
            modal.className = 'modal-overlay';
            modal.style.cssText = 'background:rgba(15,23,42,0.4); backdrop-filter:blur(2px);';
            modal.innerHTML = `
                <div class="modal" style="max-width:520px; width:90%; background:#ffffff; color:#1f2937; border-radius:12px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);">
                    <div class="modal-header" style="background:#ffffff; color:#1f2937; border-bottom:1px solid #e5e7eb; font-weight:600;"><i class="fa-solid fa-gear" style="color:#6366f1;"></i> LLM 配置（Ollama 本地）</div>
                    <div class="modal-body" id="pgSettingsBody" style="padding:18px; background:#ffffff;"></div>
                    <div class="modal-footer" style="background:#f9fafb; border-top:1px solid #e5e7eb;">
                        <button id="pgBtnSettingsClose" class="btn">关闭</button>
                        <button id="pgBtnSettingsSave" class="btn btn-primary"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#pgBtnSettingsClose').addEventListener('click', () => modal.classList.remove('active'));
            modal.querySelector('#pgBtnSettingsSave').addEventListener('click', async () => {
                const baseUrl = modal.querySelector('#pgCfgBaseUrl').value.trim();
                const model = modal.querySelector('#pgCfgModel').value;
                const temperature = Number(modal.querySelector('#pgCfgTemp').value) || 0.7;
                await api.llm.configSet({ baseUrl, model, temperature });
                _llmConfig = { ..._llmConfig, baseUrl, model, temperature };
                showToast('已保存', 'success');
                modal.classList.remove('active');
                await refreshOllamaStatus();
            });
        }
        // 渲染
        const body = modal.querySelector('#pgSettingsBody');
        const models = _availableModels;
        body.innerHTML = `
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#374151;">
                Ollama 地址
                <input id="pgCfgBaseUrl" type="text" value="${_llmConfig?.baseUrl || 'http://localhost:11434'}" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
            </label>
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#374151;">
                模型（从 ${models.length} 个已下载模型中选）
                <select id="pgCfgModel" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
                    ${models.length === 0 ? '<option value="">(Ollama 未连接，请先启动 ollama serve)</option>' :
                        models.map(m => `<option value="${m.name}" ${_llmConfig?.model === m.name ? 'selected' : ''}>${m.name} (${(m.size/1e9).toFixed(1)}GB)</option>`).join('')
                    }
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:14px; font-size:13px; color:#aaa;">
                Temperature（0-1）
                <input id="pgCfgTemp" type="number" step="0.1" min="0" max="1" value="${_llmConfig?.temperature ?? 0.7}" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
            </label>
            <div style="font-size:11px; color:#6b7280; padding:8px 0; border-top:1px solid #e5e7eb; background:#f9fafb; margin:0 -18px -18px -18px; padding:12px 18px; border-radius:0 0 12px 12px;">
                <i class="fa-solid fa-circle-info"></i> 系统提示词已内置，模型未显示？检查 <code>ollama serve</code> 是否在跑。
                <div style="margin-top:8px; display:flex; gap:6px; align-items:center;">
                    <button id="pgBtnFetchReadme" class="btn btn-sm" type="button"><i class="fa-solid fa-cloud-arrow-down"></i> 同步 NSFW 仓库 README</button>
                    <button id="pgBtnImportTemplates" class="btn btn-sm" type="button" style="margin-left:6px;" title="从本地 D:\\nsfw-prompt-templates-asian-main 导入 NSFW 模板到数据库"><i class="fa-solid fa-database"></i> 导入本地 NSFW 模板</button>
                    <span id="pgReadmeStatus" style="font-size:11px; color:#9ca3af;"></span>
                </div>
            </div>
        `;
        modal.classList.add('active');
        // 刷新 README 状态
        api.nsfw.getSource().then((r) => {
            const status = modal.querySelector('#pgReadmeStatus');
            if (!status) return;
            if (r.ok && r.meta && r.meta.readmeCachedAt) {
                const t = new Date(r.meta.readmeCachedAt).toLocaleString('zh-CN');
                status.textContent = `上次同步: ${t} (${(r.meta.readmeCachedSize/1024).toFixed(1)}KB)`;
            } else {
                status.textContent = '未同步';
            }
        });
        // 绑定同步按钮
        const fetchBtn = modal.querySelector('#pgBtnFetchReadme');
        // 绑定导入本地模板按钮
        const importBtn = modal.querySelector('#pgBtnImportTemplates');
        if (importBtn) {
            importBtn.addEventListener('click', async () => {
                await doImportTemplates(importBtn);
            });
        }
        if (fetchBtn) {
            fetchBtn.addEventListener('click', async () => {
                fetchBtn.disabled = true;
                fetchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 同步中...';
                const fr = await api.nsfw.fetchReadme();
                fetchBtn.disabled = false;
                fetchBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> 同步 NSFW 仓库 README';
                if (fr.ok) {
                    showToast(fr.cached ? 'README 已是最新' : 'README 同步完成', 'success');
                    const status = modal.querySelector('#pgReadmeStatus');
                    if (status && fr.meta) {
                        const t = new Date(fr.meta.readmeCachedAt).toLocaleString('zh-CN');
                        status.textContent = `上次同步: ${t} (${(fr.meta.readmeCachedSize/1024).toFixed(1)}KB)`;
                    }
                } else {
                    showToast('同步失败：' + fr.error, 'error');
                }
            });
        }
    }

    // ========== 历史抽屉 ==========
    async function openHistoryDrawer() {
        let drawer = document.getElementById('pgHistoryDrawer');
        if (!drawer) {
            drawer = document.createElement('div');
            drawer.id = 'pgHistoryDrawer';
            drawer.style.cssText = 'position:fixed; right:0; top:0; bottom:0; width:440px; background:#ffffff; border-left:1px solid #e5e7eb; z-index:300; transform:translateX(100%); transition:transform 0.2s; display:flex; flex-direction:column; box-shadow:-4px 0 12px rgba(0,0,0,0.08);';
            drawer.innerHTML = `
                <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between; background:#f9fafb;">
                    <span style="font-size:15px; color:#1f2937; font-weight:600;"><i class="fa-solid fa-clock-rotate-left" style="color:#6366f1;"></i> 生成历史</span>
                    <div>
                        <button id="pgBtnHistoryClear" class="btn btn-sm" style="margin-right:6px;">清空</button>
                        <button id="pgBtnHistoryClose" class="btn btn-sm">×</button>
                    </div>
                </div>
                <div id="pgHistoryList" style="flex:1; overflow-y:auto; padding:12px; background:#f5f6f8;"></div>
            `;
            document.body.appendChild(drawer);
            drawer.querySelector('#pgBtnHistoryClose').addEventListener('click', () => { drawer.style.transform = 'translateX(100%)'; });
            drawer.querySelector('#pgBtnHistoryClear').addEventListener('click', async () => {
                if (confirm('清空所有生成历史？')) {
                    await api.promptHistory.clear();
                    renderHistory();
                    showToast('已清空', 'success');
                }
            });
        }
        drawer.style.transform = 'translateX(0)';
        renderHistory();
    }

    async function renderHistory() {
        const list = document.getElementById('pgHistoryList');
        const r = await api.promptHistory.list();
        if (!r.ok || r.history.length === 0) {
            list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:40px;">还没有生成历史</div>';
            return;
        }
        list.innerHTML = '';
        for (const h of r.history) {
            const card = document.createElement('div');
            card.style.cssText = 'background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-bottom:10px; box-shadow:0 1px 2px rgba(0,0,0,0.04);';
            const tagList = h.tags.map(t => t.name).join('、');
            const time = new Date(h.ts).toLocaleString('zh-CN');
            card.innerHTML = `
                <div style="font-size:11px; color:#9ca3af; margin-bottom:6px;">${time} · ${h.model || '?'}</div>
                <div style="font-size:12px; color:#4338ca; margin-bottom:8px; font-weight:500;">${tagList || '(无标签)'}</div>
                <div style="font-size:13px; color:#374151; line-height:1.5; max-height:80px; overflow:hidden;">${h.text.slice(0, 150)}${h.text.length > 150 ? '...' : ''}</div>
                <div style="margin-top:8px; display:flex; gap:6px;">
                    <button class="btn btn-sm pgHistLoad" data-id="${h.id}">载入</button>
                    <button class="btn btn-sm pgHistCopy" data-id="${h.id}">复制</button>
                    <button class="btn btn-sm pgHistSave" data-id="${h.id}">保存到库</button>
                </div>
            `;
            list.appendChild(card);
        }
        // 绑定按钮
        list.querySelectorAll('.pgHistLoad').forEach(b => b.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                document.getElementById('pgResult').value = h.text;
                _resultText = h.text;
                _lastGeneratedTags = h.tags;
                document.getElementById('pgBtnSave').disabled = false;
                showToast('已载入到生成结果', 'success');
            }
        }));
        list.querySelectorAll('.pgHistCopy').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                await navigator.clipboard.writeText(h.text);
                showToast('已复制', 'success');
            }
        }));
        list.querySelectorAll('.pgHistSave').forEach(b => b.addEventListener('click', async (e) => {
            const id = e.currentTarget.dataset.id;
            const h = r.history.find(x => x.id === id);
            if (h) {
                const newId = 'gen-' + Date.now().toString(36);
                const tags = h.tags.map(t => t.name);
                const wr = await api.prompts.writeOne(newId, h.text, tags);
                if (wr.ok) showToast('已保存到提示词库', 'success');
                else showToast('保存失败：' + wr.error, 'error');
            }
        }));
    }

    // ========== D-28 浅色主题覆盖 ==========
function _injectPromptGenLightCss() {
    if (document.getElementById('pgLightCss')) return;
    const style = document.createElement('style');
    style.id = 'pgLightCss';
    style.textContent = `
        /* 顶部 header 按钮 */
        #promptGenPage #pgBtnBack,
        #promptGenPage #pgBtnSettings,
        #promptGenPage #pgBtnHistory,
        #promptGenPage #pgBtnGenerate,
        #promptGenPage #pgBtnCancel,
        #promptGenPage #pgBtnClear,
        #promptGenPage #pgBtnCopy,
        #promptGenPage #pgBtnSave,
        #promptGenPage #pgBtnRegen,
        #promptGenPage #pgBtnSettingsClose,
        #promptGenPage #pgBtnSettingsSave,
        #promptGenPage #pgBtnHistoryClear,
        #promptGenPage #pgBtnHistoryClose,
        #pgHistoryDrawer .pgHistLoad,
        #pgHistoryDrawer .pgHistCopy,
        #pgHistoryDrawer .pgHistSave {
            background: #ffffff !important;
            color: #374151 !important;
            border: 1px solid #d1d5db !important;
        }
        #promptGenPage #pgBtnGenerate,
        #promptGenPage #pgBtnSave {
            background: #6366f1 !important;
            color: #ffffff !important;
            border: 1px solid #4f46e5 !important;
        }
        #promptGenPage #pgBtnGenerate:hover,
        #promptGenPage #pgBtnSave:hover {
            background: #4f46e5 !important;
        }
        #promptGenPage #pgBtnSettingsSave {
            background: #6366f1 !important;
            color: #ffffff !important;
            border: 1px solid #4f46e5 !important;
        }
        #promptGenPage #pgBtnCancel {
            background: #fef2f2 !important;
            color: #dc2626 !important;
            border: 1px solid #fecaca !important;
        }
        #promptGenPage .btn:hover {
            background: #f3f4f6 !important;
        }
        .pgModeTab:hover { background: rgba(99,102,241,0.08) !important; }
        .pgModeTab[data-mode="nsfw"]:hover { background: rgba(220,38,38,0.08) !important; }
        #pgModeBanner a:hover { color: #991b1b !important; }
        #pgSettingsModal .modal {
            background: #ffffff !important;
        }
        #pgSettingsModal .modal-header,
        #pgSettingsModal .modal-body,
        #pgSettingsModal .modal-footer {
            background: inherit !important;
            color: inherit !important;
        }
    `;
    document.head.appendChild(style);
}

// ========== D-31 配置弹窗（分类配置 / 提示词配置） ==========
async function openConfigModal() {
    const overlay = document.createElement('div');
    overlay.id = 'cfgModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;';
    // 注入 hover CSS（避免 inline JS 在模板字符串里被 node 报语法错）
    if (!document.getElementById('cfgHoverStyle')) {
        const st = document.createElement('style');
        st.id = 'cfgHoverStyle';
        st.textContent = '.cfgHoverBtn{background:#f3f4f6;border:1px solid #d1d5db;color:#374151;cursor:pointer;padding:5px 12px;border-radius:6px;font-size:12px;transition:background 0.1s;}.cfgHoverBtn:hover{background:#e5e7eb;}';
        document.head.appendChild(st);
    }
    overlay.innerHTML = `
        <div id="cfgPanel" style="background:#fff;border-radius:12px;width:780px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
            <div style="padding:12px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px;background:#f9fafb;">
                <span style="font-size:15px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-folder-tree" style="color:#6366f1;"></i> 配置管理</span>
                <div style="display:inline-flex;background:#f3f4f6;border-radius:8px;padding:3px;gap:2px;">
                    <button id="cfgTabMenu" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:#fff;color:#1f2937;box-shadow:0 1px 2px rgba(0,0,0,0.08);"><i class="fa-solid fa-layer-group"></i> 分类配置</button>
                    <button id="cfgTabItem" class="cfgTabBtn" style="padding:5px 14px;font-size:12px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:transparent;color:#6b7280;"><i class="fa-solid fa-tags"></i> 提示词配置</button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;margin-left:auto;">
                    <button id="cfgAddBtn" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-plus"></i> 新增</button>
                    <button id="cfgCloseBtn" class="btn btn-sm cfgHoverBtn" title="关闭">关闭</button>
                </div>
            </div>
            <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                <!-- ===== 分类配置内容 ===== -->
                <div id="cfgMenuPane" style="display:flex;flex:1;min-height:0;">
                    <div style="width:210px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:10px 0;background:#fafafa;">
                        <div id="cfgMenuTree" style="font-size:13px;padding:0 8px;"></div>
                    </div>
                    <div style="flex:1;overflow-y:auto;padding:16px 18px;">
                        <div id="cfgMenuEmpty" style="text-align:center;color:#9ca3af;margin-top:60px;font-size:13px;">
                            <i class="fa-solid fa-folder-open" style="font-size:28px;margin-bottom:10px;display:block;color:#d1d5db;"></i>
                            选择左侧分类查看详情<br>或点击「新增」添加
                        </div>
                        <div id="cfgMenuForm" style="display:none;"></div>
                    </div>
                </div>
                <!-- ===== 提示词配置内容 ===== -->
                <div id="cfgItemPane" style="display:none;flex:1;min-height:0;flex-direction:column;">
                    <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                        <div style="width:210px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:10px 0;background:#fafafa;">
                            <div id="cfgItemTree" style="font-size:13px;padding:0 8px;"></div>
                        </div>
                        <div style="flex:1;overflow-y:auto;padding:14px 18px;">
                            <div id="cfgItemList" style="margin-bottom:14px;"></div>
                            <div id="cfgItemFormWrap" style="display:none;"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let menuItems = [];
    let menuEditingId = null;
    let _lastCreateParentId = 0;   // D-31-r2: 「连续新增」模式 — 保存后保留上次选的 parent，下一个自动 sort+1
    let itemEditingId = null;
    let _lastCreateItemCatId = 0;  // D-31-r3: 提示词「连续新增」 — 保存后保留上次选的 category_id
    let currentTab = 'menu';   // 'menu' | 'item'
    let currentItemCatId = null;

    // ---- helpers ----
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function findFirstLeaf(items, byParent) {
        if (!items.length) return null;
        // 找第一个有孩子的节点，递归到叶子
        function walk(pid) {
            const children = byParent[pid] || [];
            if (!children.length) return pid === 0 ? null : pid;
            return walk(children[0].id);
        }
        return walk(0);
    }

    // ---- Tab 切换 ----
    function switchTab(tab) {
        currentTab = tab;
        document.querySelectorAll('.cfgTabBtn').forEach(b => {
            const isActive = b.id === 'cfgTabMenu' ? tab === 'menu' : tab === 'item';
            b.style.background = isActive ? '#fff' : 'transparent';
            b.style.color = isActive ? '#1f2937' : '#6b7280';
            b.style.boxShadow = isActive ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
        });
        const menuPane = document.getElementById('cfgMenuPane');
        const itemPane = document.getElementById('cfgItemPane');
        if (menuPane) menuPane.style.display = tab === 'menu' ? 'flex' : 'none';
        if (itemPane) itemPane.style.display = tab === 'item' ? 'flex' : 'none';
        const addBtn = document.getElementById('cfgAddBtn');
        if (addBtn) {
            addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> ' + (tab === 'menu' ? '新增分类' : '新增提示词');
        }
        if (tab === 'item') {
            loadItemTree();
        }
    }

    document.getElementById('cfgTabMenu').addEventListener('click', () => switchTab('menu'));
    document.getElementById('cfgTabItem').addEventListener('click', () => switchTab('item'));

    // ---- 全局按钮 ----
    document.getElementById('cfgCloseBtn').addEventListener('click', () => { overlay.remove(); _lastCreateParentId = 0; _lastCreateItemCatId = 0; menuEditingId = null; itemEditingId = null; });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); _lastCreateParentId = 0; _lastCreateItemCatId = 0; menuEditingId = null; itemEditingId = null; } });
    // D-31-r2: 「新增分类」按钮 —— 跳出编辑态，进入「纯新增 / 连续新增」模式
    //   - 优先用 _lastCreateParentId（刚保存过新增的"上次 parent"）→ 连续新增模式
    //   - 退而用 menuEditingId（点左侧时设的"上次点过的节点"）→ 全新表单但 parent = 它
    //   - 都没有 → 全新根级表单
    //   - 点新增会清掉 menuEditingId（跳出编辑意图）
    document.getElementById('cfgAddBtn').addEventListener('click', () => {
        if (currentTab === 'menu') {
            // 优先顺序：连续新增记忆 > 左侧点选 > 根级
            const parentId = _lastCreateParentId || menuEditingId || 0;
            const keepCreating = _lastCreateParentId !== 0;
            // 跳出编辑意图
            menuEditingId = null;
            showMenuForm(null, { defaultParentId: parentId, keepCreating });
        } else {
            // D-31-r3: 提示词「连续新增」 —— 跳出编辑，优先用 _lastCreateItemCatId > currentItemCatId > 0
            const catId = _lastCreateItemCatId || currentItemCatId || 0;
            const keepCreating = _lastCreateItemCatId !== 0;
            itemEditingId = null;
            showItemForm(null, { defaultCatId: catId, keepCreating });
        }
    });

    // ===================== 分类配置 =====================
    async function loadMenu() {
        const r = await window.api.promptMenu.list();
        menuItems = r.ok ? r.items : [];
        renderMenuTree();
    }

    function renderMenuTree() {
        const el = document.getElementById('cfgMenuTree');
        if (!el) return;
        el.innerHTML = '';
        if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
        const byParent = {};
        for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
        for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
        function walk(pid, depth) {
            const children = byParent[pid] || [];
            for (const it of children) {
                const div = document.createElement('div');
                const isSel = menuEditingId === it.id;
                div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#eef2ff;color:#4338ca;font-weight:500;' : '');
                if (!isSel) {
                    div.addEventListener('mouseenter', () => { div.style.background = '#eef2ff'; });
                    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                }
                div.innerHTML = '<span style="color:#d1d5db;font-size:11px;margin-left:' + (depth*14) + 'px;display:inline-block;width:10px;"></span><i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>' + (it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '');
                div.title = it.description || it.category_name;
                div.addEventListener('click', () => showMenuForm(it.id));
                el.appendChild(div);
                walk(it.id, depth+1);
            }
        }
        walk(0, 0);
    }

    // D-31: 树形下拉 + 默认上级 + 默认排序
    //   opts.defaultParentId —— 新增时希望默认选中的父节点（来自左侧树当前选中 / 上次保存）
    //   opts.keepCreating    —— 「连续新增」模式：清空 name/desc/reqCheck，但保留 parent + sort+1
    //                            （仅在 id=null 时生效）
    function showMenuForm(id, opts) {
        opts = opts || {};
        menuEditingId = id;
        // D-31-r2: 点左侧某个分类（进入编辑）会中断「连续新增」记忆
        if (id) _lastCreateParentId = 0;
        const it = id ? menuItems.find(x => x.id === id) : null;
        document.getElementById('cfgMenuEmpty').style.display = 'none';
        const form = document.getElementById('cfgMenuForm');

        // D-31-r2: 「连续新增」模式 —— 编辑模式忽略 keepCreating（编辑一定要带原值）
        const keepCreating = !id && !!opts.keepCreating;
        form.style.display = 'block';

        // ---- 1) 算"禁用集合"：编辑节点自己 + 它的所有后代（防自循环）----
        // 后端已有同款防护（main.js 里的 pid_list 起始判断），前端再防一次体验更好
        const disabledIds = new Set();
        if (id) {
            disabledIds.add(id);
            const selfPid = it.pid_list || '';
            for (const x of menuItems) {
                if (x.id !== id && (x.pid_list || '').startsWith(selfPid)) disabledIds.add(x.id);
            }
        }

        // ---- 2) 按 pid_list 计算每个节点的深度，构建"├─ / └─" 树形 option ----
        // pid_list 形如 "/1/4/9/"，去掉首尾两个 / 后剩余段数 = 深度
        // 根节点 pid_list="/" → 0；L1="/1/" → 0；L2="/1/3/" → 1；L3="/1/3/5/" → 2
        function depthOf(node) {
            const pl = node.pid_list || '/';
            if (pl === '/' || pl === '') return 0;
            return Math.max(0, (pl.match(/\//g) || []).length - 2);
        }
        // 按 parent_id 分桶 + 每桶内按 sort_order 排序
        const byParent = {};
        for (const x of menuItems) { const p = x.parent_id || 0; (byParent[p] = byParent[p] || []).push(x); }
        for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        // 每个节点在 sibling 里的位置（用于画 ├─ / └─）
        const siblingIdx = {};
        for (const k in byParent) {
            const arr = byParent[k];
            arr.forEach((node, i) => { siblingIdx[node.id] = { index: i, isLast: i === arr.length - 1 }; });
        }

        // ---- 3) 决定本次表单"上级分类"默认选中 ----
        // 编辑：用 item.parent_id
        // 新增：优先用 opts.defaultParentId（来自「新增」按钮 / 左侧选中），否则 0
        // 必须在 renderOption 之前定义（renderOption 闭包引用 defaultParentId）
        const defaultParentId = it
            ? (it.parent_id || 0)
            : (opts.defaultParentId || 0);
        // 如果 defaultParentId 指向一个被禁用的 id（不可能发生在新增，但可能发生在"编辑时改了 defaultParentId"等场景），回退到 0
        const finalDefaultParentId = disabledIds.has(Number(defaultParentId)) ? 0 : defaultParentId;

        // ---- 4) 决定本次"排序权重"默认值 ----
        // 编辑：保留原值
        // 新增：当前父节点下所有兄弟的 max sort_order + 1；没有兄弟时 0
        function defaultSortFor(parentId) {
            // 根级 (parentId=0) 也要算根级下 L1 们的 max+1，不应短路返回 0
            const sibs = byParent[parentId] || [];
            if (!sibs.length) return 0;
            return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
        }
        const defaultSort = it
            ? (it.sort_order || 0)
            : defaultSortFor(finalDefaultParentId);

        // ---- 5) 渲染上级分类下拉：纯 option + 字符树（不用 optgroup，select 不支持嵌套，label 还会和 option 重复）----
        // 顺序：DFS 拍平（按 L1 顺序、每个 L1 内递归子节点）
        // 视觉：L1 不画前缀（它在最外层）；L2+ 画 全角空格缩进 + ├─/└─ + 名字
        function renderOption(x) {
            if (disabledIds.has(x.id)) return '';   // 跳过禁用项（不会出现在下拉里）
            const depth = depthOf(x);
            const indent = '　　'.repeat(Math.max(0, depth));   // 每层 2 个全角空格
            const prefix = depth === 0 ? '' : (siblingIdx[x.id].isLast ? '└─ ' : '├─ ');
            const sel = (Number(x.id) === Number(finalDefaultParentId)) ? ' selected' : '';
            return '<option value="' + x.id + '"' + sel + '>' + indent + prefix + esc(x.category_name) + '</option>';
        }
        // DFS 拍平（先 L1，递归每个 L1 的子树）
        const flatOrdered = [];
        function dfs(pid) {
            for (const ch of (byParent[pid] || [])) {
                flatOrdered.push(ch);
                dfs(ch.id);
            }
        }
        dfs(0);
        // 拼接所有 option
        const optionHtml = flatOrdered.map(renderOption).join('');
        // 空库时给个提示（但仍然让根级 option 存在，这样选 0 也行）
        const finalOptionHtml = optionHtml || '<option value="0" disabled>（暂无分类）</option>';

        // （defaultParentId / finalDefaultParentId / defaultSortFor / defaultSort 已在上面 renderOption 之前定义过——
        //   见 "3) 决定本次表单上级分类默认选中" 和 "4) 排序权重默认值"）

        form.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑分类' : (keepCreating ? '新增分类 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增分类')) + '</span>' + (id ? '<button id="cfgMenuDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类名称 *</label><input id="cfgMenuNameInp" type="text" value="' + esc((id || !keepCreating) ? (it ? it.category_name : '') : '') + '" placeholder="如：人物、场景、风格' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">上级分类</label><select id="cfgMenuParentSel" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;font-family:inherit;"><option value="0"' + (Number(finalDefaultParentId) === 0 ? ' selected' : '') + '>（根级，无上级）</option>' + finalOptionHtml + '</select>' + (id ? '<div style="font-size:11px;color:#9ca3af;margin-top:3px;">编辑模式下"自己及后代"已自动隐藏，避免循环引用</div>' : (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的父；改这里会重算排序</div>' : '')) + '</div>' +
            '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类描述</label><textarea id="cfgMenuDescInp" rows="2" placeholder="可选，用于说明此分类的用途" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it ? it.description : '') : '') + '</textarea></div>' +
            '<div style="margin-bottom:14px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">排序权重</label><input id="cfgMenuSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
            '<div style="margin-bottom:14px;"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;user-select:none;"><input id="cfgMenuReqInp" type="checkbox" ' + ((id || !keepCreating) ? ((it && it.is_required) ? 'checked' : '') : '') + ' style="cursor:pointer;"><span>是否必选</span><span style="font-size:11px;color:#9ca3af;">勾选后该分类下的提示词为必选项</span></label></div>' +
            '<div style="display:flex;gap:8px;"><button id="cfgMenuSaveBtn" class="btn btn-sm btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="cfgMenuCancelBtn" class="btn btn-sm cfgHoverBtn">取消</button></div>';

        // D-31: 改 parent 时重算 sort_order（仅在新增模式下；编辑不动）
        const parentSel = form.querySelector('#cfgMenuParentSel');
        if (!id) {
            parentSel.addEventListener('change', () => {
                const newPid = Number(parentSel.value) || 0;
                form.querySelector('#cfgMenuSortInp').value = defaultSortFor(newPid);
            });
        }
        form.querySelector('#cfgMenuSaveBtn').addEventListener('click', async () => {
            const name = form.querySelector('#cfgMenuNameInp').value.trim();
            if (!name) { showToast('分类名称不能为空', 'error'); return; }
            const payload = { category_name: name, parent_id: Number(form.querySelector('#cfgMenuParentSel').value)||0, description: form.querySelector('#cfgMenuDescInp').value.trim(), sort_order: Number(form.querySelector('#cfgMenuSortInp').value)||0, is_required: form.querySelector('#cfgMenuReqInp').checked };
            let r;
            if (menuEditingId) r = await window.api.promptMenu.update({ id: menuEditingId, ...payload });
            else r = await window.api.promptMenu.add(payload);
            if (r.ok) {
                showToast(menuEditingId ? '修改成功' : '添加成功', 'success');
                await loadMenu();
                // D-31-r2: 新增保存后 → 连续新增模式（保留 parent + sort+1，清 name/desc/req）
                // 编辑/删除后 → 回到空表单
                if (menuEditingId) {
                    _lastCreateParentId = 0;
                    showMenuForm(null);
                } else {
                    _lastCreateParentId = payload.parent_id;
                    showMenuForm(null, { defaultParentId: _lastCreateParentId, keepCreating: true });
                }
            }
            else showToast(r.error||'操作失败', 'error');
        });
        form.querySelector('#cfgMenuCancelBtn').addEventListener('click', () => { document.getElementById('cfgMenuForm').style.display='none'; document.getElementById('cfgMenuEmpty').style.display='block'; menuEditingId = null; _lastCreateParentId = 0; });
        if (id) {
            form.querySelector('#cfgMenuDelBtn').addEventListener('click', async () => {
                if (!confirm('删除分类会同时删除其所有子分类，确定删除？')) return;
                const r = await window.api.promptMenu.delete(id);
                if (r.ok) { showToast('已删除（'+r.deleted+'项）', 'success'); await loadMenu(); showMenuForm(null); }
                else showToast(r.error||'删除失败', 'error');
            });
        }
    }

    // ===================== 提示词配置 =====================
    async function loadItemTree() {
        await loadMenu();
        renderItemTree();
        // 默认自动选中第一个分类
        if (menuItems.length) {
            const byParent = {};
            for (const it of menuItems) { const p = it.parent_id||0; (byParent[p] = byParent[p]||[]).push(it); }
            for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
            function firstId(pid) {
                const children = byParent[pid]||[];
                return children.length ? firstId(children[0].id) : pid;
            }
            const firstCatId = firstId(0);
            if (firstCatId) { currentItemCatId = firstCatId; await loadItemList(firstCatId); }
        }
    }

    function renderItemTree() {
        const el = document.getElementById('cfgItemTree');
        if (!el) return;
        el.innerHTML = '';
        if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
        const byParent = {};
        for (const it of menuItems) { const p = it.parent_id||0; (byParent[p] = byParent[p]||[]).push(it); }
        for (const k in byParent) byParent[k].sort((a,b) => (a.sort_order||0)-(b.sort_order||0)||a.id-b.id);
        function walk(pid, depth) {
            const children = byParent[pid]||[];
            for (const it of children) {
                const div = document.createElement('div');
                const isSel = currentItemCatId === it.id;
                div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#ede9fe;color:#6d28d9;font-weight:500;' : '');
                if (!isSel) {
                    div.addEventListener('mouseenter', () => { div.style.background = '#ede9fe'; });
                    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                }
                div.innerHTML = '<span style="color:#d1d5db;font-size:11px;margin-left:' + (depth*14) + 'px;display:inline-block;width:10px;"></span><i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>' + (it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '');
                div.title = it.description || it.category_name;
                div.addEventListener('click', async () => { currentItemCatId = it.id; _lastCreateItemCatId = 0; renderItemTree(); await loadItemList(it.id); });
                el.appendChild(div);
                walk(it.id, depth+1);
            }
        }
        walk(0, 0);
    }

    async function loadItemList(catId) {
        const r = await window.api.promptItems.list(catId);
        const items = r.ok ? r.items : [];
        const catName = (menuItems.find(x=>x.id===catId)||{}).category_name || '';
        const listEl = document.getElementById('cfgItemList');
        const wrap = document.getElementById('cfgItemFormWrap');
        listEl.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;"><i class="fa-solid fa-tag" style="color:#6366f1;font-size:12px;"></i><span style="font-size:13px;font-weight:600;color:#374151;">' + esc(catName) + '</span><span style="font-size:11px;color:#9ca3af;">(' + items.length + '项)</span></div>';
        const chips = document.createElement('div');
        chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
        if (!items.length) {
            chips.innerHTML = '<span style="font-size:12px;color:#d1d5db;">（暂无数据，点「新增」添加）</span>';
        }
        for (const it of items) {
            const chip = document.createElement('div');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 10px 6px 12px;border-radius:14px;cursor:pointer;user-select:none;font-size:12px;border:1px solid #d1d5db;background:#fff;color:#374151;';
            chip.innerHTML = '<span style="font-weight:500;">' + esc(it.name) + '</span>';
            chip.title = (it.content||'') + (it.description ? '\n\n说明：'+it.description : '');
            chip.addEventListener('click', () => showItemForm(it.id, catId));
            chips.appendChild(chip);
        }
        listEl.appendChild(chips);
        wrap.style.display = 'none';
        wrap.innerHTML = '';
    }

    // D-31-r3: 提示词表单 —— 树形分类下拉 + 默认 cat + 默认 sort + 「连续新增」模式
    //   opts.defaultCatId —— 新增时希望默认选中的 cat（来自 cfgAddBtn 透传）
    //   opts.keepCreating  —— 「连续新增」模式：清 name/content/desc，保留 cat + sort+1
    function showItemForm(id, opts) {
        opts = opts || {};
        itemEditingId = id;
        const wrap = document.getElementById('cfgItemFormWrap');
        wrap.style.display = 'block';
        const keepCreating = !id && !!opts.keepCreating;
        const allItems = [];
        (async () => {
            if (currentItemCatId) {
                const r = await window.api.promptItems.list(currentItemCatId);
                if (r.ok) allItems.push(...r.items);
            }
            const it = id ? allItems.find(x=>x.id===id)||{category_id:opts.defaultCatId||currentItemCatId||0} : {category_id:opts.defaultCatId||currentItemCatId||0};

            // ---- 树形 catOptions（与 showMenuForm 同步：pid_list 算深度 + ├─/└─ + 全角空格）----
            function depthOf(node) {
                const pl = node.pid_list || '/';
                if (pl === '/' || pl === '') return 0;
                return Math.max(0, (pl.match(/\//g) || []).length - 2);
            }
            const byParent = {};
            for (const x of menuItems) { const p = x.parent_id || 0; (byParent[p] = byParent[p] || []).push(x); }
            for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            const siblingIdx = {};
            for (const k in byParent) {
                const arr = byParent[k];
                arr.forEach((node, i) => { siblingIdx[node.id] = { index: i, isLast: i === arr.length - 1 }; });
            }
            // 决定默认选中：编辑用 it.category_id；新增用 opts.defaultCatId || currentItemCatId || 0
            const defaultCatId = it.category_id || 0;
            // DFS 拍平
            const flatOrdered = [];
            function dfs(pid) { for (const ch of (byParent[pid] || [])) { flatOrdered.push(ch); dfs(ch.id); } }
            dfs(0);
            // 渲染每个 option（深度 + 字符连接符 + selected）
            function renderCatOption(x) {
                const depth = depthOf(x);
                const indent = '　　'.repeat(Math.max(0, depth));
                const prefix = depth === 0 ? '' : (siblingIdx[x.id].isLast ? '└─ ' : '├─ ');
                const sel = (Number(x.id) === Number(defaultCatId)) ? ' selected' : '';
                return '<option value="' + x.id + '"' + sel + '>' + indent + prefix + esc(x.category_name) + '</option>';
            }
            const catOptionsHtml = flatOrdered.map(renderCatOption).join('') || '<option value="0" disabled>（暂无分类）</option>';

            // ---- 「同级 max+1」sort 计算 ----
            // item 的"同级"=同一 category_id 下的所有 item
            function defaultSortForItem(catId) {
                if (!catId) return 0;
                const sibs = allItems.filter(x => (x.category_id || 0) === catId);
                if (!sibs.length) return 0;
                return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
            }
            // 编辑保留原值；新增按 defaultCatId 算
            const defaultSort = id
                ? (it.sort_order || 0)
                : defaultSortForItem(defaultCatId);

            wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;border-top:1px solid #f3f4f6;padding-top:12px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑提示词' : (keepCreating ? '新增提示词 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增提示词')) + '</span>' + (id ? '<button id="cfgItemDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">所属分类 *</label><select id="cfgItemCatSel" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;font-family:inherit;">' + catOptionsHtml + '</select>' + (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的分类；改这里会重算排序</div>' : '') + '</div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">提示词名称 *</label><input id="cfgItemNameInp" type="text" value="' + esc((id || !keepCreating) ? (it.name||'') : '') + '" placeholder="如：柔光、暖色调' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">内容</label><textarea id="cfgItemContentInp" rows="2" placeholder="提示词正文内容" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.content||'') : '') + '</textarea></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">说明</label><textarea id="cfgItemDescInp" rows="2" placeholder="可选，说明此提示词的用途或效果" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.description||'') : '') + '</textarea></div>' +
                '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">敏感度</label><select id="cfgItemSensSel" style="width:160px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;"><option value="sfw"' + (((id || !keepCreating) ? (it.sensitivity||'nsfw') : 'nsfw')==='sfw'?' selected':'') + '>SFW （安全）</option><option value="nsfw"' + (((id || !keepCreating) ? (it.sensitivity||'nsfw') : 'nsfw')==='nsfw'?' selected':'') + '>NSFW （成人）</option></select><span style="font-size:11px;color:#9ca3af;margin-left:8px;">默认 NSFW</span></div>' +
                '<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">排序权重</label><input id="cfgItemSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
                '<div style="display:flex;gap:8px;"><button id="cfgItemSaveBtn" class="btn btn-sm btn-primary"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="cfgItemCancelBtn" class="btn btn-sm cfgHoverBtn">取消</button></div>';

            // 改 cat 时重算 sort（仅新增）
            const catSel = wrap.querySelector('#cfgItemCatSel');
            if (!id) {
                catSel.addEventListener('change', () => {
                    const newCatId = Number(catSel.value) || 0;
                    // 拉一下该 cat 下的 items（可能要补一次 list 调用）
                    window.api.promptItems.list(newCatId).then(rr => {
                        const sibs = (rr.ok && rr.items) ? rr.items : [];
                        let ns = 0;
                        if (sibs.length) ns = Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
                        wrap.querySelector('#cfgItemSortInp').value = ns;
                    });
                });
            }

            wrap.querySelector('#cfgItemSaveBtn').addEventListener('click', async () => {
                const name = wrap.querySelector('#cfgItemNameInp').value.trim();
                if (!name) { showToast('提示词名称不能为空', 'error'); return; }
                const payload = { name, category_id: Number(wrap.querySelector('#cfgItemCatSel').value)||0, content: wrap.querySelector('#cfgItemContentInp').value.trim(), description: wrap.querySelector('#cfgItemDescInp').value.trim(), sort_order: Number(wrap.querySelector('#cfgItemSortInp').value)||0, sensitivity: wrap.querySelector('#cfgItemSensSel').value };
                let r;
                if (itemEditingId) r = await window.api.promptItems.update({ id: itemEditingId, ...payload });
                else r = await window.api.promptItems.add(payload);
                if (r.ok) {
                    showToast(itemEditingId ? '修改成功' : '添加成功', 'success');
                    await loadItemList(currentItemCatId);
                    // D-31-r3: 新增保存后 → 连续新增（保留 cat + sort+1）
                    if (itemEditingId) {
                        _lastCreateItemCatId = 0;
                        showItemForm(null);
                    } else {
                        _lastCreateItemCatId = payload.category_id;
                        showItemForm(null, { defaultCatId: _lastCreateItemCatId, keepCreating: true });
                    }
                }
                else showToast(r.error||'操作失败', 'error');
            });
            wrap.querySelector('#cfgItemCancelBtn').addEventListener('click', () => { wrap.style.display='none'; wrap.innerHTML=''; itemEditingId = null; _lastCreateItemCatId = 0; });
            if (id) {
                wrap.querySelector('#cfgItemDelBtn').addEventListener('click', async () => {
                    if (!confirm('确定删除此提示词？')) return;
                    const r = await window.api.promptItems.delete(id);
                    if (r.ok) { showToast('已删除', 'success'); itemEditingId = null; _lastCreateItemCatId = 0; await loadItemList(currentItemCatId); showItemForm(null); }
                    else showToast(r.error||'删除失败', 'error');
                });
            }
        })();
    }

    // ---- 初始化：加载分类配置 ----
    await loadMenu();
    // 默认打开分类配置 Tab（Tab=menu）
    switchTab('menu');
}
// ========== toast ==========
    function showToast(msg, type) {
        const c = document.getElementById('toast-container');
        if (!c) { console.log('[toast]', msg); return; }
        const t = document.createElement('div');
        t.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ========== 暴露 ==========
    window.promptGen = { open, close };
})();
