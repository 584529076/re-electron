// settings.js — 统一设置页（新页面，非弹框）
//
// 入口：window.settings.open({ tab }) —— 由主页面「配置」按钮 / 提示词生成页「模型」「配置」按钮调用
// tab ∈ { 'resources', 'prompts', 'comfyui', 'llm' }
//
// 页面结构：
//   settingsPage
//   ├── settingsHeader    (返回 / 标题 / 当前 tab 副标题)
//   └── settingsBody
//       ├── settingsMenu  (左：竖向 4 个 tab 项)
//       └── settingsContent (右：根据 _currentTab 渲染对应内容)
//
// 设计原则：
//   - 复用现有各模块的 IPC API（api.config / api.llm / api.comfyui / api.nsfw）
//   - 不删除 prompt-gen 页面的「模型」「配置」按钮（用户明确要求暂时保留）
//   - 简单 tab 内联渲染，复杂 openConfigModal 暂用「打开原编辑器」按钮跳转到原弹框

'use strict';

(function () {
    const api = window.api || {};

    // ========== 状态 ==========
    let _currentTab = 'resources';

    // ---- 提示词管理子页面共享 state（4 个子模块共用）----
    let menuItems = [];             // 分类树数据
    const _menuById = new Map();    // id → node（路径查询、深度计算用）
    let _menuLoaded = false;
    let _assembleRule = null;       // 拼装规则：[{ menuId, sortOrder }]；null = 未加载
    let _assembleRuleLoaded = false;
    let _sceneTemplates = [];       // 场景模板缓存
    let _sceneLoaded = false;
    const _menuTreeExpanded = new Set();
    let menuEditingId = null;       // 分类配置：当前编辑的分类
    let _lastCreateParentId = 0;    // 分类配置：连续新增记忆
    let itemEditingId = null;       // 提示词配置：当前编辑的提示词
    let _lastCreateItemCatId = 0;   // 提示词配置：连续新增记忆
    let currentItemCatId = null;    // 提示词配置：当前展示的分类 id
    let _itemTreeCollapsed = new Set(); // 提示词配置：左侧分类树折叠的父节点 id（默认全部折叠）
    // _exclTreeExpanded（互斥分类树展开）— 渲染时新建 Set，渲染完丢弃

    // ========== 共享 helpers ==========
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function esc(s) { return escapeHtml(s); }

    async function loadMenu() {
        if (!api.promptMenu || !api.promptMenu.list) return;
        const r = await api.promptMenu.list();
        if (!r.ok) { menuItems = []; _menuById.clear(); _menuLoaded = true; return; }
        menuItems = r.items || [];
        _menuById.clear();
        for (const it of menuItems) _menuById.set(it.id, it);
        _menuLoaded = true;
    }

    async function loadAssembleRule(force) {
        if (_assembleRuleLoaded && !force) return _assembleRule || [];
        if (!api.assembleRule || !api.assembleRule.get) return [];
        const r = await api.assembleRule.get();
        _assembleRuleLoaded = true;
        _assembleRule = (r && r.ok && Array.isArray(r.rule)) ? r.rule : [];
        return _assembleRule;
    }

    // 拼装规则保存/清空后回调主页面（与原 cfgModal 行为一致）
    function liveAssembleAndUpdate() {
        if (typeof window.promptGenLiveAssembleAndUpdate === 'function') {
            try { window.promptGenLiveAssembleAndUpdate(); } catch (e) {}
        }
    }

    // ========== 入口 ==========
    function open(opts) {
        opts = opts || {};
        const wantTab = opts.tab;
        if (wantTab && TAB_DEFS.some(t => t.id === wantTab)) _currentTab = wantTab;
        else _currentTab = 'resources';
        if (!document.getElementById('settingsPage')) createPage();
        showPage();
        renderMenu();
        renderContent();
    }

    function close() {
        const page = document.getElementById('settingsPage');
        if (page) page.style.display = 'none';
        // 恢复主页和 header
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = '';
        if (header) header.style.display = '';
    }

    // ========== tab 定义 ==========
    const TAB_DEFS = [
        { id: 'resources', icon: 'fa-folder-tree',   label: '资源管理' },
        { id: 'prompts',   icon: 'fa-tags',          label: '提示词管理' },
        { id: 'comfyui',   icon: 'fa-image',         label: 'ComfyUI 服务' },
        { id: 'llm',       icon: 'fa-microchip',     label: 'LLM 服务' },
    ];

    function tabDef(id) { return TAB_DEFS.find(t => t.id === id) || TAB_DEFS[0]; }

    // ========== DOM ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'settingsPage';
        page.style.cssText = 'position:fixed; inset:0; background:#f5f6f8; z-index:200; display:none; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        page.innerHTML = `
            <!-- 顶部 bar -->
            <div style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; box-shadow:0 1px 2px rgba(0,0,0,0.04); flex-shrink:0;">
                <button id="setBtnBack" class="btn" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                <h2 id="setHeaderTitle" style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-gear" style="color:#6366f1;"></i> 设置</h2>
                <span id="setHeaderSub" style="margin-right:12px; font-size:12px; color:#6b7280;"></span>
            </div>

            <!-- 两列主体 -->
            <div style="display:flex; flex:1; min-height:0;">
                <!-- 左：菜单 -->
                <div id="settingsMenu" style="width:220px; flex-shrink:0; border-right:1px solid #e5e7eb; background:#ffffff; overflow-y:auto; padding:14px 0;"></div>
                <!-- 右：内容 -->
                <div id="settingsContent" style="flex:1; overflow:auto; background:#f9fafb;"></div>
            </div>
        `;
        document.body.appendChild(page);
        page.querySelector('#setBtnBack').addEventListener('click', close);
    }

    function showPage() {
        const page = document.getElementById('settingsPage');
        if (page) page.style.display = 'flex';
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = 'none';
        if (header) header.style.display = 'none';
    }

    // ========== 左菜单渲染 ==========
    function renderMenu() {
        const menu = document.getElementById('settingsMenu');
        if (!menu) return;
        menu.innerHTML = '';
        for (const t of TAB_DEFS) {
            const isActive = t.id === _currentTab;
            const row = document.createElement('div');
            row.style.cssText = 'padding:9px 18px; cursor:pointer; font-size:14px; display:flex; align-items:center; gap:10px; border-left:3px solid ' + (isActive ? '#6366f1' : 'transparent') + '; background:' + (isActive ? '#eef2ff' : 'transparent') + '; color:' + (isActive ? '#4338ca' : '#374151') + '; font-weight:' + (isActive ? '500' : '400') + ';';
            row.innerHTML = '<i class="fa-solid ' + t.icon + '" style="width:16px; text-align:center; color:' + (isActive ? '#6366f1' : '#9ca3af') + ';"></i><span>' + escapeHtml(t.label) + '</span>';
            row.addEventListener('click', () => {
                if (_currentTab === t.id) return;
                _currentTab = t.id;
                renderMenu();
                renderContent();
            });
            menu.appendChild(row);
        }
        // 更新头部副标题
        const sub = document.getElementById('setHeaderSub');
        if (sub) sub.textContent = tabDef(_currentTab).label;
    }

    // ========== 右内容分发 ==========
    function renderContent() {
        const c = document.getElementById('settingsContent');
        if (!c) return;
        c.innerHTML = '';
        const renderer = CONTENT_RENDERERS[_currentTab];
        if (renderer) renderer(c);
    }

    const CONTENT_RENDERERS = {
        resources: renderResourcesPane,
        prompts: renderPromptsPane,
        comfyui: renderComfyuiPane,
        llm: renderLlmPane,
    };

    // ========== 各 tab 渲染 ==========

    // ===== 资源管理 (Tab 配置) =====
    function renderAssetsStorageCard(container) {
        const card = createCard('资产存储', '配置 AI 工具生成图片的默认保存目录。锁定 Tab「资产」绑定此目录，可改路径但 Tab 本身不能删除。');
        const body = document.createElement('div');
        body.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
        card.appendChild(body);

        const dirRow = document.createElement('div');
        dirRow.style.cssText = 'display:flex; gap:8px; align-items:center;';
        dirRow.innerHTML = `
            <span style="font-size:12px; color:#6b7280; width:80px; flex-shrink:0;">当前目录</span>
            <input id="setAssetsDir" type="text" readonly value="(加载中...)" style="flex:1; padding:7px 11px; background:#f9fafb; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; font-family:monospace;">
            <span id="setAssetsDirBadge" style="display:none; padding:2px 8px; border-radius:10px; background:#eef2ff; color:#4338ca; font-size:11px; font-weight:500;">默认</span>
            <button id="setAssetsDirPick" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-open"></i> 更改</button>
            <button id="setAssetsDirOpen" class="btn btn-sm" type="button" title="打开目录"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            <button id="setAssetsDirReset" class="btn btn-sm" type="button" title="恢复默认 (userData/assets)"><i class="fa-solid fa-rotate-left"></i></button>
        `;
        body.appendChild(dirRow);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px; color:#6b7280; line-height:1.6; padding:8px 10px; background:#f9fafb; border-radius:6px;';
        hint.innerHTML = '<i class="fa-solid fa-circle-info" style="color:#6366f1;"></i> 默认指向 <code>app.getPath(\'userData\')/assets</code>（packaged）或 <code>__dirname/assets</code>（dev）。AI 工具生成的结果会自动保存到本目录，并附带 <code>.meta.json</code> 旁路元数据（含 workflow / 模型 / LORA / 提示词 / 耗时 / 显存峰值）。';
        body.appendChild(hint);

        container.appendChild(card);

        // 拉取 + 绑定事件
        (async () => {
            if (!api.config || typeof api.config.assetsGet !== 'function') {
                const inp = card.querySelector('#setAssetsDir');
                if (inp) { inp.value = '(api.config.assetsGet 不可用)'; }
                return;
            }
            const r = await api.config.assetsGet();
            if (!r || !r.ok) {
                const inp = card.querySelector('#setAssetsDir');
                if (inp) { inp.value = '(加载失败: ' + (r && r.error || '未知') + ')'; }
                return;
            }
            const inp = card.querySelector('#setAssetsDir');
            inp.value = r.resolvedDir || '';
            const badge = card.querySelector('#setAssetsDirBadge');
            if (badge) badge.style.display = r.isDefault ? 'inline-block' : 'none';
        })();

        card.querySelector('#setAssetsDirPick').addEventListener('click', async () => {
            if (!api.config || typeof api.config.assetsPick !== 'function') {
                showToast('目录选择接口不可用', 'error'); return;
            }
            const r = await api.config.assetsPick();
            if (!r || !r.ok) { if (r && r.error) showToast('选择目录失败: ' + r.error, 'error'); return; }
            if (r.canceled) return;
            const sr = await api.config.assetsSet({ dir: r.path });
            if (!sr || !sr.ok) { showToast('保存失败: ' + (sr && sr.error || '未知'), 'error'); return; }
            card.querySelector('#setAssetsDir').value = sr.resolvedDir || r.path;
            const badge = card.querySelector('#setAssetsDirBadge');
            if (badge) badge.style.display = sr.isDefault ? 'inline-block' : 'none';
            showToast('资产目录已更改', 'success');
        });

        card.querySelector('#setAssetsDirOpen').addEventListener('click', async () => {
            if (!api.config || typeof api.config.assetsOpen !== 'function') return;
            const r = await api.config.assetsOpen();
            if (!r || !r.ok) showToast('打开目录失败: ' + (r && r.error || '未知'), 'error');
        });

        card.querySelector('#setAssetsDirReset').addEventListener('click', async () => {
            if (!api.config || typeof api.config.assetsSet !== 'function') return;
            const sr = await api.config.assetsSet({ dir: '' });  // 空 = 恢复默认
            if (!sr || !sr.ok) { showToast('重置失败: ' + (sr && sr.error || '未知'), 'error'); return; }
            card.querySelector('#setAssetsDir').value = sr.resolvedDir || '';
            const badge = card.querySelector('#setAssetsDirBadge');
            if (badge) badge.style.display = sr.isDefault ? 'inline-block' : 'none';
            showToast('已恢复默认目录', 'success');
        });
    }
    function renderResourcesPane(container) {
        // 资产存储 section（在最顶部）
        renderAssetsStorageCard(container);
        const card = createCard('资源管理 — Tab 配置', '管理顶部 Tab 的资源路径（NAS / 本地 / 网络 URL），调整顺序或新增 / 删除。「资产」Tab 由上方「资产存储」配置绑定，不可在此处删除或修改路径。');
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex; gap:8px; margin-bottom:14px;';
        toolbar.innerHTML = '<button id="rsAddTabBtn" class="btn btn-sm btn-primary"><i class="fa-solid fa-plus"></i> 新增 Tab</button>';
        card.appendChild(toolbar);

        const body = document.createElement('div');
        card.appendChild(body);

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; gap:8px; margin-top:18px; padding-top:14px; border-top:1px dashed #e5e7eb;';
        footer.innerHTML = '<button id="rsCancelBtn" class="btn btn-sm">取消</button><button id="rsSaveBtn" class="btn btn-sm btn-primary" style="margin-left:auto;"><i class="fa-solid fa-check"></i> 保存</button>';
        card.appendChild(footer);

        container.appendChild(card);

        // 拉 config
        let cfg = null;
        (async () => {
            if (!api.config) {
                body.innerHTML = '<div style="color:#dc2626; font-size:13px;">window.api.config 不可用</div>';
                return;
            }
            const r = await api.config.get();
            if (!r.ok) {
                body.innerHTML = '<div style="color:#dc2626; font-size:13px;">拉 config 失败：' + escapeHtml(r.error || '未知') + '</div>';
                return;
            }
            cfg = r.config;
            renderRows();
        })();

        function renderRows() {
            body.innerHTML = '';
            if (!cfg || !Array.isArray(cfg.tabs)) {
                body.innerHTML = '<div style="color:#9ca3af;">暂无 Tab 配置</div>';
                return;
            }
            cfg.tabs.forEach((tab, idx) => body.appendChild(buildTabRow(tab, idx)));
        }

        function buildTabRow(tab, idx) {
            const row = document.createElement('div');
            row.className = 'set-rs-row';
            const locked = !!tab.locked;
            row.style.cssText = 'border:1px solid ' + (locked ? '#a5b4fc' : '#e5e7eb') + '; border-radius:8px; padding:14px; margin-bottom:12px; background:' + (locked ? '#eef2ff' : '#ffffff') + ';';
            row.dataset.tabId = tab.id;
            const src = tab.source || { type: 'nas' };
            const lockBadge = locked ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:#6366f1;color:#ffffff;font-size:11px;font-weight:500;"><i class="fa-solid fa-lock" style="font-size:9px;"></i>系统锁定</span>' : '';
            const delBtn = locked ? '' : '<button class="btn btn-sm rs-del" title="删除" style="background:#fee2e2; color:#dc2626; border:1px solid #fecaca;"><i class="fa-solid fa-trash"></i></button>';
            const typeSelect = locked
                ? `<span style="padding:7px 11px; background:#e5e7eb; color:#4b5563; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">${src.type === 'local' ? '本地目录' : (src.type === 'nas' ? 'NAS' : '网络')}</span>`
                : `<select class="rs-type" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                        <option value="nas" ${src.type === 'nas' ? 'selected' : ''}>NAS (HTTP 目录)</option>
                        <option value="local" ${src.type === 'local' ? 'selected' : ''}>本地目录</option>
                        <option value="network" ${src.type === 'network' ? 'selected' : ''}>网络 URL 列表</option>
                    </select>`;
            row.innerHTML = `
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                    <input class="rs-name" type="text" value="${escapeAttr(tab.name)}" placeholder="Tab 名称" style="flex:1; padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                    ${typeSelect}
                    ${lockBadge}
                    <button class="btn btn-sm rs-up" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                    <button class="btn btn-sm rs-down" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                    ${delBtn}
                </div>
                <div class="rs-source-fields"></div>
            `;
            const fields = row.querySelector('.rs-source-fields');
            if (locked) {
                // 锁定 tab：不渲染可编辑的 source 字段，而是显示绑定信息
                fields.innerHTML = `
                    <div style="padding:10px 12px; background:#ffffff; border:1px dashed #a5b4fc; border-radius:6px; font-size:12px; color:#4338ca;">
                        <i class="fa-solid fa-link" style="margin-right:4px;"></i>
                        路径由「资产存储」配置绑定，<strong>此处不可修改</strong>。如需调整，请在设置 → 资源管理 → 「资产存储」中修改路径。
                    </div>
                `;
                // 锁定 tab 的 up/down 仍允许
                row.querySelector('.rs-up').addEventListener('click', () => { moveTab(idx, -1); });
                row.querySelector('.rs-down').addEventListener('click', () => { moveTab(idx, +1); });
                return row;
            }
            fields.innerHTML = renderSourceFields(src);

            // 事件委托：点击「选择地址」按钮 → 弹目录选择对话框 → 写入 .rs-path
            // （fields.innerHTML 在 type 切换时会重渲，用委托避免每次重新绑）
            fields.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-action="pick-local-path"]');
                if (!btn) return;
                const pathInput = fields.querySelector('.rs-path');
                if (!pathInput) return;
                if (!api.config || typeof api.config.pickDir !== 'function') {
                    showToast('目录选择接口不可用', 'error');
                    return;
                }
                const r = await api.config.pickDir();
                if (!r || !r.ok) {
                    if (r && r.error) showToast('选择目录失败: ' + r.error, 'error');
                    return;
                }
                if (r.canceled) return;
                pathInput.value = r.path || '';
            });

            row.querySelector('.rs-type').addEventListener('change', (e) => {
                const cur = readSourceFromRow(row);
                cur.type = e.target.value;
                fields.innerHTML = renderSourceFields(cur);
            });
            row.querySelector('.rs-up').addEventListener('click', () => { moveTab(idx, -1); });
            row.querySelector('.rs-down').addEventListener('click', () => { moveTab(idx, +1); });
            row.querySelector('.rs-del').addEventListener('click', () => {
                if (cfg.tabs.length <= 1) { showToast('至少保留 1 个 Tab', 'error'); return; }
                cfg.tabs.splice(idx, 1);
                renderRows();
            });
            return row;
        }

        function moveTab(idx, dir) {
            const j = idx + dir;
            if (j < 0 || j >= cfg.tabs.length) return;
            const tmp = cfg.tabs[idx];
            cfg.tabs[idx] = cfg.tabs[j];
            cfg.tabs[j] = tmp;
            renderRows();
        }

        // 工具栏按钮
        toolbar.querySelector('#rsAddTabBtn').addEventListener('click', () => {
            const newId = 'tab-' + Date.now().toString(36);
            cfg.tabs.push({
                id: newId, name: '新 Tab',
                source: { type: 'nas', path: '', imgExts: ['jpg','jpeg','png','gif','webp'], videoExts: ['mp4','webm'], maxDepth: 10 },
            });
            renderRows();
        });
        footer.querySelector('#rsCancelBtn').addEventListener('click', () => {
            renderRows();
        });
        footer.querySelector('#rsSaveBtn').addEventListener('click', async () => {
            const rows = body.querySelectorAll('.set-rs-row');
            const tabs = [];
            const seenIds = new Set();
            for (const row of rows) {
                const name = row.querySelector('.rs-name').value.trim();
                const oldId = row.dataset.tabId;
                if (!name) { showToast('Tab 名称不能为空', 'error'); return; }
                if (seenIds.has(oldId)) { showToast(`Tab id 重复: ${oldId}`, 'error'); return; }
                seenIds.add(oldId);
                // 锁定 tab：保留 cfg.tabs 里的 source + locked 标记，不让用户改路径
                const orig = cfg.tabs.find(t => t.id === oldId);
                if (orig && orig.locked) {
                    tabs.push({ id: oldId, name, locked: true, source: orig.source });
                } else {
                    tabs.push({ id: oldId, name, source: readSourceFromRow(row) });
                }
            }
            const newCfg = { version: 1, tabs, activeTabId: tabs.find(t => t.id === cfg.activeTabId) ? cfg.activeTabId : tabs[0].id };
            const r = await api.config.set(newCfg);
            if (!r.ok) { showToast('保存失败：' + r.error, 'error'); return; }
            cfg = newCfg;
            showToast('配置已保存（重启也保留）', 'success');
            // 通知主页面：重建顶部 tab + 重新加载当前
            // 用 refresh() 而非 init({})，避免 init 把主页面传的 onTabChange 回调清空导致 gallery 不刷新
            if (window.configUI && typeof window.configUI.refresh === 'function') {
                try { await window.configUI.refresh(); } catch (e) {}
            } else if (window.configUI && typeof window.configUI.init === 'function') {
                // 兜底：旧版 config-ui 没有 refresh
                try { await window.configUI.init({}); } catch (e) {}
            }
        });
    }

    function renderSourceFields(src) {
        if (src.type === 'nas') {
            return `
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280; margin-bottom:8px;">路径（HTTP 根 URL + 远程目录）
                    <input class="rs-path" type="text" value="${escapeAttr(src.path || '')}" placeholder="http://192.168.0.109:5005/home/小芋/003 AI出图/" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                </label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
                    <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">图片扩展名
                        <input class="rs-imgExts" type="text" value="${escapeAttr((src.imgExts || []).join(','))}" placeholder="jpg,jpeg,png" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">视频扩展名
                        <input class="rs-videoExts" type="text" value="${escapeAttr((src.videoExts || []).join(','))}" placeholder="mp4,webm" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                    </label>
                </div>
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">最大递归深度
                    <input class="rs-maxDepth" type="number" value="${Number(src.maxDepth) || 10}" min="1" max="20" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; width:120px;">
                </label>
            `;
        } else if (src.type === 'local') {
            return `
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280; margin-bottom:8px;">本地路径
                    <div style="display:flex; gap:6px;">
                        <input class="rs-path" type="text" value="${escapeAttr(src.path || '')}" placeholder="D:\\Download\\素材" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; flex:1; min-width:0;">
                        <button type="button" data-action="pick-local-path" style="padding:6px 14px; background:#0ea5e9; color:#ffffff; border:1px solid #0284c7; border-radius:6px; cursor:pointer; white-space:nowrap; font-size:13px; flex-shrink:0;"><i class="fa-solid fa-folder-open"></i> 选择地址</button>
                    </div>
                </label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
                    <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">图片扩展名
                        <input class="rs-imgExts" type="text" value="${escapeAttr((src.imgExts || []).join(','))}" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">视频扩展名
                        <input class="rs-videoExts" type="text" value="${escapeAttr((src.videoExts || []).join(','))}" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                    </label>
                </div>
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">最大递归深度
                    <input class="rs-maxDepth" type="number" value="${Number(src.maxDepth) || 10}" min="1" max="20" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; width:120px;">
                </label>
            `;
        } else if (src.type === 'network') {
            return `
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280;">URL 列表（每行一个）
                    <textarea class="rs-urls" rows="6" placeholder="https://example.com/img1.jpg\nhttps://example.com/video1.mp4" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; font-family:monospace;">${escapeHtml(src.urls || '')}</textarea>
                </label>
            `;
        }
        return '<div style="color:#dc2626;">未实现的 source.type</div>';
    }

    function readSourceFromRow(row) {
        const type = row.querySelector('.rs-type').value;
        const out = { type };
        if (type === 'nas' || type === 'local') {
            out.path = row.querySelector('.rs-path')?.value || '';
            out.imgExts = splitExts(row.querySelector('.rs-imgExts')?.value);
            out.videoExts = splitExts(row.querySelector('.rs-videoExts')?.value);
            out.maxDepth = Number(row.querySelector('.rs-maxDepth')?.value) || 10;
        } else if (type === 'network') {
            out.urls = row.querySelector('.rs-urls')?.value || '';
        }
        return out;
    }

    function splitExts(s) {
        return String(s || '').split(/[,\s]+/).map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    }

    // ===== ComfyUI 服务 =====
    function renderComfyuiPane(container) {
        const card = document.createElement('div');
        card.style.cssText = 'background:#ffffff; border-radius:10px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.06); max-width:920px;';

        card.innerHTML = `
            <div style="margin-bottom:14px;">
                <div style="font-size:16px; font-weight:600; color:#1f2937;"><i class="fa-solid fa-image" style="color:#6366f1;"></i> ComfyUI 服务</div>
                <div style="font-size:12px; color:#6b7280; margin-top:6px; line-height:1.6;">
                    配置本地 ComfyUI 服务（用户自装）。配置后可点「启动」由本应用拉起 ComfyUI 子进程。
                </div>
            </div>
            <div style="display:grid; grid-template-columns:120px 1fr auto; gap:10px; align-items:center; margin-bottom:14px;">
                <label style="font-size:12px; color:#6b7280;">Python 路径</label>
                <input id="setComfyPython" type="text" placeholder="D:\\ComfyUI\\venv\\Scripts\\python.exe" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; font-family:monospace;">
                <button id="setComfyPythonPick" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-open"></i></button>

                <label style="font-size:12px; color:#6b7280;">ComfyUI 目录</label>
                <input id="setComfyDir" type="text" placeholder="D:\\ComfyUI（需含 main.py）" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; font-family:monospace;">
                <button id="setComfyDirPick" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-open"></i></button>

                <label style="font-size:12px; color:#6b7280;">监听端口</label>
                <input id="setComfyPort" type="number" value="8188" min="1" max="65535" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                <span></span>

                <label style="font-size:12px; color:#6b7280;">输出目录</label>
                <input id="setComfyOutput" type="text" placeholder="（可选）ComfyUI 输出拷贝目录" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; font-family:monospace;">
                <button id="setComfyOutputPick" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-open"></i></button>
            </div>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding-top:14px; border-top:1px solid #e5e7eb;">
                <span id="setComfyStatusDot" style="width:10px; height:10px; border-radius:50%; background:#6b7280; display:inline-block;"></span>
                <span id="setComfyStatusText" style="font-size:12px; color:#6b7280; flex:1;">未启动</span>
                <button id="setComfyStart" class="btn btn-sm btn-primary" type="button"><i class="fa-solid fa-play"></i> 启动</button>
                <button id="setComfyStop" class="btn btn-sm" type="button" style="background:#dc2626; color:#fff; display:none;"><i class="fa-solid fa-stop"></i> 停止</button>
                <button id="setComfySave" class="btn btn-sm" type="button" style="background:#10b981; color:#fff;"><i class="fa-solid fa-check"></i> 保存配置</button>
                <button id="setComfyOpenOutput" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-tree"></i> 打开输出</button>
            </div>
            <div id="setComfyWfList" style="font-size:11px; color:#6b7280; margin-top:14px; padding-top:12px; border-top:1px dashed #e5e7eb;"></div>
        `;
        container.appendChild(card);

        if (!api.comfyui) {
            card.querySelector('#setComfyWfList').textContent = 'window.api.comfyui 不可用';
            return;
        }

        // 加载配置 + workflows
        (async () => {
            const cfgR = await api.comfyui.configGet();
            const cfg = (cfgR && cfgR.ok) ? cfgR.config : {};
            card.querySelector('#setComfyPython').value = cfg.pythonPath || '';
            card.querySelector('#setComfyDir').value = cfg.comfyDir || '';
            card.querySelector('#setComfyPort').value = cfg.port || 8188;
            card.querySelector('#setComfyOutput').value = cfg.outputDir || '';

            if (api.comfyui.listWorkflows) {
                const wfR = await api.comfyui.listWorkflows();
                const wfDiv = card.querySelector('#setComfyWfList');
                if (wfR && wfR.ok && Array.isArray(wfR.workflows)) {
                    wfDiv.innerHTML = '<div style="margin-bottom:6px; font-weight:500;">已加载 workflow：</div>' + wfR.workflows.map(w => {
                        const dot = w.broken ? '<span style="color:#f87171;">● 损坏</span>' : (w.hasPositive ? '<span style="color:#34d399;">● 就绪</span>' : '<span style="color:#fbbf24;">● 缺占位符</span>');
                        return `<div style="padding:3px 0;">${dot} <b>${escapeHtml(w.name)}</b> (${w.mode}) — ${escapeHtml(w.defaultResolution || '?')} — ${escapeHtml(w.notes || '')}</div>`;
                    }).join('');
                } else {
                    wfDiv.textContent = '无法读取 workflow 列表';
                }
            }
            refreshStatus();
        })();

        function readCfgFromForm() {
            return {
                pythonPath: card.querySelector('#setComfyPython').value.trim(),
                comfyDir: card.querySelector('#setComfyDir').value.trim(),
                port: Number(card.querySelector('#setComfyPort').value) || 8188,
                outputDir: card.querySelector('#setComfyOutput').value.trim(),
            };
        }

        // 事件
        card.querySelector('#setComfyPythonPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickPython();
            if (r && r.ok && r.path) card.querySelector('#setComfyPython').value = r.path;
        });
        card.querySelector('#setComfyDirPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickComfyDir();
            if (r && r.ok && r.path) card.querySelector('#setComfyDir').value = r.path;
        });
        card.querySelector('#setComfyOutputPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickOutputDir();
            if (r && r.ok && r.path) card.querySelector('#setComfyOutput').value = r.path;
        });
        card.querySelector('#setComfySave').addEventListener('click', async () => {
            const r = await api.comfyui.configSet(readCfgFromForm());
            if (r && r.ok) showToast('ComfyUI 配置已保存', 'success');
            else showToast('保存失败：' + (r && r.error), 'error');
        });
        card.querySelector('#setComfyStart').addEventListener('click', async () => {
            const btn = card.querySelector('#setComfyStart');
            btn.disabled = true;
            const sv = await api.comfyui.configSet(readCfgFromForm());
            if (!sv || !sv.ok) { showToast('配置保存失败：' + (sv && sv.error), 'error'); btn.disabled = false; return; }
            const r = await api.comfyui.start(readCfgFromForm());
            btn.disabled = false;
            if (r && r.ok) showToast('ComfyUI 已启动（PID ' + (r.pid || '外部') + '）', 'success');
            else showToast('启动失败：' + (r && r.error), 'error');
            refreshStatus();
        });
        card.querySelector('#setComfyStop').addEventListener('click', async () => {
            const r = await api.comfyui.stop();
            if (r && r.ok) showToast('ComfyUI 已停止', 'success');
            else showToast('停止失败：' + (r && r.error), 'error');
            refreshStatus();
        });
        card.querySelector('#setComfyOpenOutput').addEventListener('click', async () => {
            if (api.comfyui.openOutputDir) {
                const r = await api.comfyui.openOutputDir();
                if (r && !r.ok) showToast('打开失败：' + r.error, 'error');
            }
        });

        async function refreshStatus() {
            const dot = card.querySelector('#setComfyStatusDot');
            const txt = card.querySelector('#setComfyStatusText');
            const btnStart = card.querySelector('#setComfyStart');
            const btnStop = card.querySelector('#setComfyStop');
            const r = await api.comfyui.status();
            if (!r || !r.ok) {
                dot.style.background = '#6b7280';
                txt.textContent = '状态未知';
                return;
            }
            if (r.running) {
                dot.style.background = '#10b981';
                const pidStr = r.pid ? `PID ${r.pid}` : '外部';
                txt.innerHTML = `<span style="color:#34d399;">● 运行中（${pidStr}, 端口 ${r.port}）</span>`;
                if (btnStart) btnStart.style.display = 'none';
                if (btnStop) btnStop.style.display = '';
            } else {
                dot.style.background = r.lastError ? '#ef4444' : '#6b7280';
                txt.innerHTML = r.lastError
                    ? `<span style="color:#fca5a5;">● 未运行（${escapeHtml(r.lastError)}）</span>`
                    : '<span style="color:#9ca3af;">● 未启动</span>';
                if (btnStart) btnStart.style.display = '';
                if (btnStop) btnStop.style.display = 'none';
            }
        }
    }

    // ===== LLM 服务 =====
    function renderLlmPane(container) {
        const card = createCard('LLM 服务', '配置本地 Ollama LLM（baseUrl / 模型 / temperature）。');
        const body = document.createElement('div');
        card.appendChild(body);

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex; gap:8px; margin-top:18px; padding-top:14px; border-top:1px dashed #e5e7eb;';
        footer.innerHTML = '<button id="llmCancelBtn" class="btn btn-sm">关闭</button><button id="llmSaveBtn" class="btn btn-sm btn-primary" style="margin-left:auto;"><i class="fa-solid fa-check"></i> 保存</button>';
        card.appendChild(footer);

        container.appendChild(card);

        if (!api.llm) {
            body.innerHTML = '<div style="color:#dc2626; font-size:13px;">window.api.llm 不可用</div>';
            return;
        }

        let cfg = null;
        let models = [];

        body.innerHTML = `
            <div style="display:grid; gap:14px;">
                <label style="display:flex; flex-direction:column; gap:6px; font-size:13px; color:#374151;">
                    Ollama 地址
                    <input id="llmBaseUrl" type="text" value="http://localhost:11434" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:13px; color:#374151;">
                    模型
                    <select id="llmModelSel" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                        <option value="">（加载中…）</option>
                    </select>
                    <span id="llmModelHint" style="font-size:11px; color:#9ca3af;"></span>
                </label>
                <label style="display:flex; flex-direction:column; gap:6px; font-size:13px; color:#374151;">
                    Temperature（0-1）
                    <input id="llmTemp" type="number" step="0.1" min="0" max="1" value="0.7" style="padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; width:140px;">
                </label>
            </div>
            <div style="margin-top:20px; padding:12px 14px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; font-size:12px; color:#6b7280;">
                <i class="fa-solid fa-circle-info" style="color:#6366f1;"></i> 系统提示词已内置。模型未显示？检查 <code>ollama serve</code> 是否在跑。
            </div>
        `;

        (async () => {
            const cr = await api.llm.configGet();
            if (cr.ok) cfg = cr.config;
            const mr = await api.llm.listModels();
            if (mr.ok) models = mr.models || [];
            // 填充表单
            if (cfg) {
                body.querySelector('#llmBaseUrl').value = cfg.baseUrl || 'http://localhost:11434';
                body.querySelector('#llmTemp').value = cfg.temperature ?? 0.7;
            }
            const sel = body.querySelector('#llmModelSel');
            if (!models.length) {
                sel.innerHTML = '<option value="">（Ollama 未连接，请先启动 ollama serve）</option>';
                body.querySelector('#llmModelHint').textContent = '没有可用模型';
            } else {
                sel.innerHTML = models.map(m => `<option value="${escapeAttr(m.name)}">${escapeHtml(m.name)} (${(m.size/1e9).toFixed(1)}GB)</option>`).join('');
                if (cfg && cfg.model) sel.value = cfg.model;
                body.querySelector('#llmModelHint').textContent = `共 ${models.length} 个已下载模型`;
            }
        })();

        footer.querySelector('#llmCancelBtn').addEventListener('click', close);
        footer.querySelector('#llmSaveBtn').addEventListener('click', async () => {
            const out = {
                baseUrl: body.querySelector('#llmBaseUrl').value.trim(),
                model: body.querySelector('#llmModelSel').value,
                temperature: Number(body.querySelector('#llmTemp').value) || 0.7,
            };
            const r = await api.llm.configSet(out);
            if (r.ok) {
                showToast('已保存', 'success');
                // 通知 promptGen 刷新（如果存在）
                if (window.promptGen && typeof window.promptGen.refreshOllamaStatus === 'function') {
                    try { await window.promptGen.refreshOllamaStatus(); } catch (e) {}
                }
            } else {
                showToast('保存失败：' + r.error, 'error');
            }
        });
    }

    // ===== 提示词管理 =====
    // 视图切换：cards（4 子模块入口）↔ sub（具体子模块页面，顶部带面包屑）
    function renderPromptsPane(container) {
        const SUB_MODULES = [
            { tab: 'menu',  icon: 'fa-layer-group',     name: '分类配置',   desc: '增删改分类、上级关系、必选规则、互斥规则、互斥组',  available: true  },
            { tab: 'item',  icon: 'fa-tags',            name: '提示词配置', desc: '单个提示词的 CRUD、Excel 批量导入、下载模板',     available: true  },
            { tab: 'rule',  icon: 'fa-arrow-down-1-9',  name: '拼装规则',   desc: '选择要拼装的一级分类并设置顺序',                  available: true  },
            { tab: 'scene', icon: 'fa-image',           name: '场景模板',   desc: 'md 导入的场景模板，启用/禁用/编辑/删除',          available: true  },
            { tab: 'assoc', icon: 'fa-link',            name: '关联管理',   desc: '提示词之间的强联动/弱联动/互斥规则、Excel 批量导入', available: true },
        ];

        let view = 'cards';      // 'cards' | 'sub'
        let currentSub = null;    // 'menu' | 'item' | 'rule' | 'scene'

        const SUB_RENDERERS = {
            rule: renderSubModuleRule,
            scene: renderSubModuleScene,
            item: renderSubModuleItem,
            menu: renderSubModuleMenu,
            assoc: renderSubModuleAssoc,
        };

        function paintCards() {
            container.innerHTML = '';
            const card = document.createElement('div');
            card.style.cssText = 'background:#ffffff; border-radius:10px; padding:0; box-shadow:0 1px 3px rgba(0,0,0,0.06); overflow:hidden; max-width:920px;';

            const subHtml = SUB_MODULES.map(m => {
                const disabled = !m.available;
                const cursorStyle = disabled ? 'cursor:not-allowed;opacity:0.55;' : 'cursor:pointer;';
                const badge = disabled ? '<span style="font-size:10px;color:#9ca3af;background:#f3f4f6;padding:1px 6px;border-radius:8px;flex-shrink:0;">即将推出</span>' : '<i class="fa-solid fa-arrow-right" style="color:#9ca3af; font-size:12px;"></i>';
                return `
                    <div class="set-prompt-card" data-tab="${escapeAttr(m.tab)}" style="padding:14px 16px; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; ${cursorStyle} transition:all 0.15s;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:36px; height:36px; border-radius:8px; background:#eef2ff; color:#6366f1; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0;">
                                <i class="fa-solid ${escapeAttr(m.icon)}"></i>
                            </div>
                            <div style="flex:1; min-width:0;">
                                <div style="font-size:13px; font-weight:600; color:#1f2937; margin-bottom:2px;">${escapeHtml(m.name)}</div>
                                <div style="font-size:11px; color:#6b7280; line-height:1.5;">${escapeHtml(m.desc)}</div>
                            </div>
                            ${badge}
                        </div>
                    </div>
                `;
            }).join('');

            card.innerHTML = `
                <div style="padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#f9fafb; display:flex; align-items:center; gap:12px;">
                    <div style="flex:1;">
                        <div style="font-size:15px; font-weight:600; color:#1f2937;"><i class="fa-solid fa-tags" style="color:#6366f1;"></i> 提示词管理</div>
                        <div style="font-size:12px; color:#6b7280; margin-top:4px;">点击下方任一子模块打开对应的编辑界面</div>
                    </div>
                    <button id="promptsOpenFullBtn" class="btn btn-sm" type="button" title="打开原弹框编辑器（兼容入口）" style="font-size:12px;"><i class="fa-solid fa-up-right-from-square"></i> 打开完整编辑器</button>
                </div>
                <div style="padding:16px 20px; display:grid; grid-template-columns:repeat(2, 1fr); gap:10px;">${subHtml}</div>
            `;
            container.appendChild(card);

            card.querySelectorAll('.set-prompt-card').forEach(el => {
                const tab = el.dataset.tab;
                const mod = SUB_MODULES.find(x => x.tab === tab);
                if (!mod || !mod.available) return;  // 不可用的不绑事件
                el.addEventListener('mouseenter', () => {
                    el.style.borderColor = '#6366f1';
                    el.style.background = '#f5f3ff';
                });
                el.addEventListener('mouseleave', () => {
                    el.style.borderColor = '#e5e7eb';
                    el.style.background = '#ffffff';
                });
                el.addEventListener('click', () => {
                    view = 'sub';
                    currentSub = tab;
                    paint();
                });
            });

            card.querySelector('#promptsOpenFullBtn').addEventListener('click', () => {
                if (typeof window.promptGenOpenConfigModal !== 'function') {
                    showToast('提示词编辑器未暴露为全局函数（请确认 prompt-gen.js 已加载）', 'error');
                    return;
                }
                window.promptGenOpenConfigModal({ tab: 'menu' });
            });
        }

        function paintSub() {
            container.innerHTML = '';
            const wrap = document.createElement('div');
            wrap.style.cssText = 'background:#ffffff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.06); max-width:1100px; display:flex; flex-direction:column; min-height:560px; overflow:visible;';

            const mod = SUB_MODULES.find(x => x.tab === currentSub);
            const subName = mod ? mod.name : currentSub;
            const inModalFn = window.promptGenOpenConfigModal;

            wrap.innerHTML = `
                <div style="padding:10px 16px; border-bottom:1px solid #e5e7eb; background:#f9fafb; display:flex; align-items:center; gap:8px; flex-shrink:0; position:sticky; top:0; z-index:5;">
                    <button id="setPromptsBackBtn" class="btn btn-sm" type="button" style="font-size:12px;"><i class="fa-solid fa-arrow-left"></i> 提示词管理</button>
                    <span style="color:#9ca3af;">/</span>
                    <span style="font-size:14px; font-weight:500; color:#1f2937;">${escapeHtml(subName)}</span>
                    <div style="flex:1;"></div>
                    <button id="setPromptsOpenInModal" class="btn btn-sm" type="button" title="在原弹框中打开（兜底）" style="font-size:12px;"><i class="fa-solid fa-up-right-from-square"></i> 在弹框中打开</button>
                </div>
                <div id="setPromptsSubBody" style="flex:1; overflow:auto; background:#f9fafb;"></div>
            `;
            container.appendChild(wrap);

            wrap.querySelector('#setPromptsBackBtn').addEventListener('click', () => {
                view = 'cards';
                currentSub = null;
                paint();
            });
            wrap.querySelector('#setPromptsOpenInModal').addEventListener('click', () => {
                if (typeof inModalFn !== 'function') {
                    showToast('提示词编辑器未暴露为全局函数（请确认 prompt-gen.js 已加载）', 'error');
                    return;
                }
                inModalFn({ tab: currentSub });
            });

            const body = wrap.querySelector('#setPromptsSubBody');
            const renderer = SUB_RENDERERS[currentSub];
            if (typeof renderer === 'function') {
                renderer(body);
            } else {
                body.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:80px 0;font-size:13px;">该子模块尚未迁移到本页</div>';
            }
        }

        function paint() {
            if (view === 'cards') paintCards();
            else paintSub();
        }
        paint();
    }

    // ===== 拼装规则子页面（阶段 1）=====
    // 复制自 prompt-gen.js:3129-3282；删除 cfgModal 依赖、改用共享 state
    function renderSubModuleRule(container) {
        container.innerHTML = '';
        const root = document.createElement('div');
        root.style.cssText = 'display:flex; flex-direction:column; height:100%;';

        // info 横幅
        const banner = document.createElement('div');
        banner.style.cssText = 'padding:12px 18px; border-bottom:1px solid #e5e7eb; background:#ffffff; display:flex; align-items:center; gap:10px;';
        banner.innerHTML = `
            <i class="fa-solid fa-circle-info" style="color:#6366f1; font-size:14px;"></i>
            <div style="font-size:12px; color:#374151; line-height:1.6; flex:1;">
                拼装规则：选择要拼装的一级分类并设置顺序。右侧「生成结果」会按这个顺序拼接选中的提示词内容（同级按选择顺序拼接），未选中的规则项会自动跳过。
            </div>
        `;
        root.appendChild(banner);

        // 主体：左右两栏
        const body = document.createElement('div');
        body.style.cssText = 'display:flex; flex:1; min-height:0;';
        body.innerHTML = `
            <div style="width:280px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:14px 16px; background:#ffffff;">
                <div style="font-size:12px; color:#6b7280; margin-bottom:8px; font-weight:500;">可选分类（任意 depth）</div>
                <div id="setRuleAvailable"></div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:14px 18px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                    <div style="font-size:12px; color:#6b7280; font-weight:500;">拼装顺序（从左到右拼接）</div>
                    <div>
                        <button id="setRuleClearBtn" class="btn btn-sm" type="button" style="font-size:11px;">清空</button>
                        <button id="setRuleSaveBtn" class="btn btn-sm" type="button" style="background:#6366f1; color:#fff; border:none; font-size:11px; padding:4px 10px;"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                    </div>
                </div>
                <div id="setRuleSelected"></div>
            </div>
        `;
        root.appendChild(body);
        container.appendChild(root);

        const availEl = root.querySelector('#setRuleAvailable');
        const selEl = root.querySelector('#setRuleSelected');

        function depthOf(cat, cache) {
            if (cache.has(cat.id)) return cache.get(cat.id);
            if (!cat.parent_id || cat.parent_id === 0) { cache.set(cat.id, 0); return 0; }
            const parent = _menuById.get(cat.parent_id);
            if (!parent) { cache.set(cat.id, 0); return 0; }
            const d = depthOf(parent, cache) + 1;
            cache.set(cat.id, d);
            return d;
        }

        function renderRulePaneLocal() {
            const allCats = Array.from(_menuById.values())
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            const selected = Array.isArray(_assembleRule) ? _assembleRule.slice() : [];
            const selectedIds = new Set(selected.map(r => r.menuId));
            renderRuleAvailable(availEl, allCats, selectedIds);
            renderRuleSelected(selEl, selected);
        }

        function renderRuleAvailable(host, allCats, selectedIds) {
            host.innerHTML = '';
            if (!allCats.length) {
                host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 0;">暂无分类</div>';
                return;
            }
            const depthCache = new Map();
            for (const cat of allCats) {
                const isSel = selectedIds.has(cat.id);
                const depth = depthOf(cat, depthCache);
                const depthLabel = depth === 0 ? 'L1' : depth === 1 ? 'L2' : 'L3';
                const indent = depth * 16;
                const icon = depth === 0 ? 'fa-layer-group' : depth === 1 ? 'fa-folder-tree' : 'fa-tag';
                const color = depth === 0 ? '#6366f1' : depth === 1 ? '#0ea5e9' : '#94a3b8';
                const item = document.createElement('div');
                item.style.cssText = `padding:6px 10px 6px ${10 + indent}px;margin-bottom:3px;border-radius:5px;cursor:${isSel ? 'default' : 'pointer'};font-size:12px;background:${isSel ? '#f3f4f6' : '#fff'};border:1px solid ${isSel ? '#e5e7eb' : 'transparent'};color:${isSel ? '#9ca3af' : '#1f2937'};display:flex;align-items:center;justify-content:space-between;transition:background 0.1s;`;
                item.innerHTML = `<span style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="font-size:9px;font-weight:700;color:${color};background:${color}15;padding:1px 4px;border-radius:3px;flex-shrink:0;">${depthLabel}</span><i class="fa-solid ${icon}" style="color:${isSel ? '#9ca3af' : color};font-size:10px;flex-shrink:0;"></i><span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(cat.category_name || cat.name || ('分类 #' + cat.id))}</span></span>${isSel ? '<i class="fa-solid fa-check" style="color:#9ca3af;font-size:10px;flex-shrink:0;"></i>' : '<i class="fa-solid fa-plus" style="color:#d1d5db;font-size:10px;flex-shrink:0;"></i>'}`;
                if (!isSel) {
                    item.addEventListener('mouseenter', () => { item.style.background = '#f9fafb'; item.style.borderColor = '#e5e7eb'; });
                    item.addEventListener('mouseleave', () => { item.style.background = '#fff'; item.style.borderColor = 'transparent'; });
                    item.addEventListener('click', () => {
                        if (!_assembleRule) _assembleRule = [];
                        _assembleRule.push({ menuId: cat.id, sortOrder: _assembleRule.length });
                        renderRulePaneLocal();
                    });
                }
                host.appendChild(item);
            }
        }

        function renderRuleSelected(host, selected) {
            host.innerHTML = '';
            if (!selected.length) {
                host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:8px 0;text-align:center;">还没选顺序。左边点 + 加进这里。</div>';
                return;
            }
            const depthCache = new Map();
            for (let i = 0; i < selected.length; i++) {
                const r = selected[i];
                const cat = _menuById.get(r.menuId);
                const depth = cat ? depthOf(cat, depthCache) : 0;
                const depthLabel = depth === 0 ? 'L1' : depth === 1 ? 'L2' : 'L3';
                const color = depth === 0 ? '#6366f1' : depth === 1 ? '#0ea5e9' : '#94a3b8';
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;border-radius:6px;background:#eef2ff;border:1px solid #c7d2fe;font-size:13px;';
                row.innerHTML = `
                    <span style="background:#6366f1;color:#fff;border-radius:4px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex-shrink:0;">${i + 1}</span>
                    <span style="font-size:9px;font-weight:700;color:${color};background:${color}15;padding:1px 4px;border-radius:3px;flex-shrink:0;">${depthLabel}</span>
                    <span style="flex:1;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><i class="fa-solid ${depth === 0 ? 'fa-layer-group' : depth === 1 ? 'fa-folder-tree' : 'fa-tag'}" style="color:${color};margin-right:6px;font-size:11px;"></i>${escapeHtml(cat ? (cat.category_name || cat.name || ('分类 #' + cat.id)) : '已删除分类 #' + r.menuId)}</span>
                    <button class="setRuleUp" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:2px 6px;" title="上移"><i class="fa-solid fa-arrow-up"></i></button>
                    <button class="setRuleDown" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:2px 6px;" title="下移"><i class="fa-solid fa-arrow-down"></i></button>
                    <button class="setRuleRemove" data-idx="${i}" style="background:transparent;border:none;cursor:pointer;color:#dc2626;padding:2px 6px;" title="删除"><i class="fa-solid fa-xmark"></i></button>
                `;
                host.appendChild(row);
            }
            host.onclick = (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                const idx = parseInt(btn.getAttribute('data-idx'), 10);
                if (isNaN(idx)) return;
                if (btn.classList.contains('setRuleUp')) {
                    if (idx > 0) {
                        const tmp = _assembleRule[idx - 1];
                        _assembleRule[idx - 1] = _assembleRule[idx];
                        _assembleRule[idx] = tmp;
                        renderRulePaneLocal();
                    }
                } else if (btn.classList.contains('setRuleDown')) {
                    if (idx < _assembleRule.length - 1) {
                        const tmp = _assembleRule[idx + 1];
                        _assembleRule[idx + 1] = _assembleRule[idx];
                        _assembleRule[idx] = tmp;
                        renderRulePaneLocal();
                    }
                } else if (btn.classList.contains('setRuleRemove')) {
                    _assembleRule.splice(idx, 1);
                    renderRulePaneLocal();
                }
            };
        }

        // 按钮事件
        root.querySelector('#setRuleSaveBtn').addEventListener('click', async () => {
            const r = await api.assembleRule.set(_assembleRule || []);
            if (r && r.ok) {
                showToast('拼装规则已保存', 'success');
                liveAssembleAndUpdate();
            } else {
                showToast('保存失败：' + (r && r.error || '未知错误'), 'error');
            }
        });
        root.querySelector('#setRuleClearBtn').addEventListener('click', () => {
            _assembleRule = [];
            renderRulePaneLocal();
            liveAssembleAndUpdate();
        });

        // 初次加载：拉 menu + 拼装规则
        (async () => {
            await loadMenu();
            await loadAssembleRule(true);
            renderRulePaneLocal();
        })();
    }

    // ===== 待实现的子页面（阶段 2/3/4 占位）=====
    // ===== 分类配置子页面（阶段 4）=====
    // 复制自 prompt-gen.js:2314-2920；cfg* → setMenu*；
    // 用户确认：上级分类选择器改成内联展开（不弹模态框）
    function renderSubModuleMenu(container) {
        container.innerHTML = '';
        const root = document.createElement('div');
        root.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#ffffff;';

        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'padding:10px 16px; border-bottom:1px solid #e5e7eb; background:#f9fafb; display:flex; align-items:center; gap:8px; flex-shrink:0;';
        toolbar.innerHTML = `
            <button id="setMenuAddBtn" class="btn btn-sm" type="button" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-plus"></i> 新增分类</button>
            <span style="font-size:11px;color:#6b7280;">点左侧树进入编辑；点「新增」开始连续新增（保留上次 parent）</span>
        `;
        root.appendChild(toolbar);

        const body = document.createElement('div');
        body.style.cssText = 'display:flex; flex:1; min-height:0; overflow:hidden;';
        body.innerHTML = `
            <div style="width:220px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:10px 0; background:#fafafa;">
                <div id="setMenuTree" style="font-size:13px; padding:0 8px;"></div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:16px 18px;">
                <div id="setMenuEmpty" style="text-align:center; color:#9ca3af; margin-top:60px; font-size:13px;">
                    <i class="fa-solid fa-folder-open" style="font-size:28px; margin-bottom:10px; display:block; color:#d1d5db;"></i>
                    选择左侧分类查看详情<br>或点击「新增分类」添加
                </div>
                <div id="setMenuForm" style="display:none;"></div>
            </div>
        `;
        root.appendChild(body);
        container.appendChild(root);

        function expandPathTo(menuId) {
            if (!menuId) return;
            const byId = new Map(menuItems.map(m => [m.id, m]));
            let cur = byId.get(Number(menuId));
            while (cur && cur.parent_id) {
                _menuTreeExpanded.add(Number(cur.parent_id));
                cur = byId.get(Number(cur.parent_id));
            }
        }

        function renderMenuTree() {
            const el = document.getElementById('setMenuTree');
            if (!el) return;
            el.innerHTML = '';
            if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
            if (menuEditingId) expandPathTo(menuEditingId);
            const byParent = {};
            for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
            for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            function walk(pid, depth) {
                const children = byParent[pid] || [];
                for (const it of children) {
                    const hasChildren = (byParent[it.id] || []).length > 0;
                    const isExpanded = _menuTreeExpanded.has(it.id);
                    const isSel = menuEditingId === it.id;
                    const div = document.createElement('div');
                    div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#eef2ff;color:#4338ca;font-weight:500;' : '');
                    if (!isSel) {
                        div.addEventListener('mouseenter', () => { div.style.background = '#eef2ff'; });
                        div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                    }
                    const indent = '<span style="flex-shrink:0;width:' + (depth * 14) + 'px;"></span>';
                    const chevron = hasChildren
                        ? '<span class="setMenuChevron" data-id="' + it.id + '" style="flex-shrink:0;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;cursor:pointer;user-select:none;">' + (isExpanded ? '▼' : '▶') + '</span>'
                        : '<span style="flex-shrink:0;width:14px;height:14px;display:inline-block;"></span>';
                    const folder = '<i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;flex-shrink:0;"></i>';
                    const name = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>';
                    const grp = (it.exclusive_group || '').trim();
                    const grpBadge = grp ? '<span title="互斥组：' + esc(grp) + '" style="flex-shrink:0;font-size:10px;line-height:1.4;padding:1px 6px;background:#ede9fe;color:#6d28d9;border-radius:8px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#' + esc(grp) + '</span>' : '';
                    const reqDot = it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '';
                    div.innerHTML = indent + chevron + folder + name + grpBadge + reqDot;
                    div.title = it.description || it.category_name;
                    div.addEventListener('click', (ev) => {
                        if (ev.target.closest('.setMenuChevron')) return;
                        showMenuForm(it.id);
                    });
                    el.appendChild(div);
                    if (hasChildren && isExpanded) walk(it.id, depth + 1);
                }
            }
            walk(0, 0);
            el.querySelectorAll('.setMenuChevron').forEach(span => {
                span.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const id = Number(span.getAttribute('data-id'));
                    if (_menuTreeExpanded.has(id)) _menuTreeExpanded.delete(id);
                    else _menuTreeExpanded.add(id);
                    renderMenuTree();
                });
            });
        }

        function showMenuForm(id, opts) {
            opts = opts || {};
            menuEditingId = id;
            if (id) _lastCreateParentId = 0;
            const it = id ? menuItems.find(x => x.id === id) : null;
            document.getElementById('setMenuEmpty').style.display = 'none';
            const form = document.getElementById('setMenuForm');

            const keepCreating = !id && !!opts.keepCreating;
            form.style.display = 'block';

            // 禁用集合（防自循环）
            const disabledIds = new Set();
            if (id) {
                disabledIds.add(id);
                const selfPid = it.pid_list || '';
                for (const x of menuItems) {
                    if (x.id !== id && (x.pid_list || '').startsWith(selfPid)) disabledIds.add(x.id);
                }
            }

            const byParent = {};
            for (const x of menuItems) { const p = x.parent_id || 0; (byParent[p] = byParent[p] || []).push(x); }
            for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);

            const defaultParentId = it ? (it.parent_id || 0) : (opts.defaultParentId || 0);
            const finalDefaultParentId = disabledIds.has(Number(defaultParentId)) ? 0 : defaultParentId;

            const _pathMapLocal = new Map(menuItems.map(m => [m.id, m]));
            function _pathOfLocal(mid) {
                if (!mid) return '';
                const segs = [];
                let cur = _pathMapLocal.get(Number(mid));
                while (cur) {
                    segs.unshift(cur.category_name);
                    cur = cur.parent_id ? _pathMapLocal.get(Number(cur.parent_id)) : null;
                }
                return segs.join(' > ');
            }
            const _initM = _pathMapLocal.get(finalDefaultParentId);
            const initialParentDisplayText = _initM ? (_pathOfLocal(finalDefaultParentId) + '  #' + finalDefaultParentId) : '（根级，无上级）';

            function defaultSortFor(parentId) {
                const sibs = byParent[parentId] || [];
                if (!sibs.length) return 0;
                return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
            }
            const defaultSort = it ? (it.sort_order || 0) : defaultSortFor(finalDefaultParentId);

            const existingGroups = Array.from(new Set(
                menuItems.map(m => (m.exclusive_group || '').trim()).filter(Boolean)
            )).sort((a, b) => a.localeCompare(b, 'zh-CN'));
            const groupDatalistHtml = existingGroups.map(g => '<option value="' + esc(g) + '">').join('');

            form.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑分类' : (keepCreating ? '新增分类 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增分类')) + '</span>' + (id ? '<button id="setMenuDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
                '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类名称 *</label><input id="setMenuNameInp" type="text" value="' + esc((id || !keepCreating) ? (it ? it.category_name : '') : '') + '" placeholder="如：人物、场景、风格' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
                // 上级分类：显示框 + 「选择分类」按钮（点开后内联展开 picker，非弹框）
                '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">上级分类</label>' +
                    '<div style="display:flex;gap:6px;align-items:stretch;">' +
                        '<input type="hidden" id="setMenuParentSel" value="' + (finalDefaultParentId || 0) + '">' +
                        '<input type="text" id="setMenuParentDisplay" value="' + esc(initialParentDisplayText) + '" readonly tabindex="-1" placeholder="（根级，无上级）" style="flex:1;min-width:0;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#f9fafb;color:#374151;box-sizing:border-box;font-family:inherit;cursor:default;">' +
                        '<button type="button" id="setMenuPickBtn" style="flex-shrink:0;padding:7px 14px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;color:#374151;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background 0.15s;">选择分类 <i id="setMenuPickChev" class="fa-solid fa-chevron-down" style="margin-left:4px;font-size:10px;"></i></button>' +
                    '</div>' +
                    // 内联展开容器（默认隐藏）
                    '<div id="setMenuParentPicker" style="display:none;margin-top:6px;border:1px solid #d1d5db;border-radius:7px;background:#fafafa;max-height:280px;overflow-y:auto;"></div>' +
                    (id ? '<div style="font-size:11px;color:#9ca3af;margin-top:3px;">编辑模式下"自己及后代"已自动置灰，避免循环引用</div>' : (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的父；改这里会重算排序</div>' : '')) +
                '</div>' +
                '<div style="margin-bottom:10px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">分类描述</label><textarea id="setMenuDescInp" rows="2" placeholder="可选，用于说明此分类的用途" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it ? it.description : '') : '') + '</textarea></div>' +
                '<div style="margin-bottom:14px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">排序权重</label><input id="setMenuSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
                '<div style="margin-bottom:14px;"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;user-select:none;"><input id="setMenuReqInp" type="checkbox" ' + ((id || !keepCreating) ? ((it && it.is_required) ? 'checked' : '') : '') + ' style="cursor:pointer;"><span>是否必选</span><span style="font-size:11px;color:#9ca3af;">勾选后该分类下的提示词为必选项</span></label></div>' +
                '<div style="margin-bottom:10px;padding:10px 12px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;">' +
                    '<div style="font-size:11px;font-weight:600;color:#92400e;margin-bottom:6px;display:flex;align-items:center;gap:4px;"><i class="fa-solid fa-shield-halved"></i> 校验规则（用于拼装时实时冲突检查）</div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">数量规则（tag_required）</label>' +
                        '<input id="setMenuTagReqInp" type="text" value="' + esc((id || !keepCreating) ? (it ? (it.tag_required || '') : '') : '') + '" placeholder="留空 = 不限制" list="setMenuTagReqPresets" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">' +
                        '<datalist id="setMenuTagReqPresets"><option value="必选 1 个"><option value="必选 1-2 个"><option value="必选 2-3 个"><option value="必选 3 个"><option value="选 1-3 个"><option value="选 2-3 个"><option value="选 2-4 个"></datalist>' +
                        '<div style="font-size:11px;color:#6b7280;margin-top:3px;">格式：「必选 N 个」或「选 N-M 个」。拼装时超出范围会警告。</div>' +
                    '</div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">互斥分类（exclusive_with · 可多选）</label>' +
                        '<div id="setMenuExclBox" style="display:flex;flex-wrap:wrap;gap:5px;padding:5px 6px;border:1px solid #d1d5db;border-radius:5px;background:#fff;min-height:30px;align-items:center;box-sizing:border-box;">' +
                            '<span id="setMenuExclEmpty" style="font-size:12px;color:#d1d5db;">（无）</span>' +
                        '</div>' +
                        '<div id="setMenuExclTree" style="max-height:200px;overflow-y:auto;border:1px solid #d1d5db;border-radius:5px;background:#fafafa;padding:6px 8px;margin-top:5px;box-sizing:border-box;"></div>' +
                        '<div id="setMenuExclWarn" style="font-size:11px;color:#dc2626;margin-top:4px;display:none;"></div>' +
                        '<div style="font-size:11px;color:#6b7280;margin-top:4px;line-height:1.5;">' +
                            '选择本分类与哪些分类互斥（拼装时，本分类下的提示词与所选分类下的提示词不能同时出现）。<br>' +
                            '· 互斥关系对子分类同样生效（在 L1 上设互斥，则 L1 下所有子分类的提示词都受此约束）<br>' +
                            '· 不可与本分类或上级分类互斥' +
                        '</div>' +
                    '</div>' +
                    '<div style="margin-top:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">互斥组（exclusive_group · 同组内互斥）</label>' +
                        '<input id="setMenuExclGroupInp" type="text" value="' + esc(it ? (it.exclusive_group || '') : '') + '" placeholder="留空 = 不参与组互斥" list="setMenuExclGroupPresets" maxlength="32" style="width:100%;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">' +
                        '<datalist id="setMenuExclGroupPresets">' + groupDatalistHtml + '</datalist>' +
                        '<div style="font-size:11px;color:#6b7280;margin-top:3px;line-height:1.5;">' +
                            '填写一个组名（如「体型」），所有同名的分类在拼装时互斥。比逐个配对更省事。<br>' +
                            '· 组名区分大小写<br>' +
                            '· 不继承祖先：要在子分类也设上组名才生效' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;"><button id="setMenuSaveBtn" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="setMenuCancelBtn" class="btn btn-sm">取消</button></div>';

            const parentSel = form.querySelector('#setMenuParentSel');
            const parentDisplay = form.querySelector('#setMenuParentDisplay');
            const parentPickBtn = form.querySelector('#setMenuPickBtn');
            const parentPickerHost = form.querySelector('#setMenuParentPicker');
            const parentPickChev = form.querySelector('#setMenuPickChev');
            const _parentTreeExpanded = new Set();
            let _pickerOpen = false;

            function getSelectedParentId() {
                return Number(parentSel.value) || 0;
            }
            function parentPathOf(mid) {
                if (!mid) return '';
                const segs = [];
                let cur = menuByIdForPath.get(Number(mid));
                while (cur) {
                    segs.unshift(cur.category_name);
                    cur = cur.parent_id ? menuByIdForPath.get(Number(cur.parent_id)) : null;
                }
                return segs.join(' > ');
            }
            function updateParentDisplay() {
                const selId = getSelectedParentId();
                if (!selId) { parentDisplay.value = '（根级，无上级）'; return; }
                const m = menuByIdForPath.get(selId);
                parentDisplay.value = (m ? (parentPathOf(selId) + '  #' + selId) : '（根级，无上级）');
            }
            function triggerParentChange() {
                if (!id) {
                    const newPid = getSelectedParentId();
                    form.querySelector('#setMenuSortInp').value = defaultSortFor(newPid);
                }
                checkAncestorConflict();
            }

            // 内联 picker —— 替代原 openParentPickerModal
            function renderPickerTreeInline(host) {
                host.innerHTML = '';
                if (!menuItems.length) {
                    host.innerHTML = '<div style="font-size:13px;color:#9ca3af;padding:24px;text-align:center;">（暂无分类）</div>';
                    return;
                }
                const selId = getSelectedParentId();
                if (selId) {
                    const byIdAuto = new Map(menuItems.map(m => [m.id, m]));
                    let cur = byIdAuto.get(selId);
                    while (cur && cur.parent_id) {
                        _parentTreeExpanded.add(Number(cur.parent_id));
                        cur = byIdAuto.get(Number(cur.parent_id));
                    }
                }
                const childrenOf = {};
                for (const m of menuItems) {
                    const p = m.parent_id || 0;
                    (childrenOf[p] = childrenOf[p] || []).push(m);
                }
                for (const k in childrenOf) {
                    childrenOf[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
                }
                const hasChildrenSet = new Set();
                for (const k in childrenOf) {
                    for (const ch of childrenOf[k]) hasChildrenSet.add(ch.id);
                }
                function makeRow(rid, name, depth, isSel, isDisabled, hasChildren, isExpanded) {
                    const wrap = document.createElement('div');
                    wrap.dataset.catId = String(rid);
                    wrap.dataset.disabled = isDisabled ? '1' : '0';
                    let bg = '';
                    if (isSel) bg = 'background:#eef2ff;font-weight:600;';
                    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:13px;color:' + (isDisabled ? '#9ca3af' : '#374151') + ';cursor:' + (isDisabled ? 'not-allowed' : 'pointer') + ';' + bg;
                    if (!isDisabled && !isSel) {
                        wrap.addEventListener('mouseenter', () => { wrap.style.background = '#f3f4f6'; });
                        wrap.addEventListener('mouseleave', () => { wrap.style.background = 'transparent'; });
                    }
                    wrap.style.paddingLeft = (depth * 18 + 12) + 'px';
                    const chev = document.createElement('span');
                    chev.dataset.chev = '1';
                    chev.style.cssText = 'flex-shrink:0;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:#6b7280;font-size:10px;user-select:none;' + (hasChildren ? 'cursor:pointer;' : '');
                    chev.textContent = hasChildren ? (isExpanded ? '▼' : '▶') : '';
                    wrap.appendChild(chev);
                    const lbl = document.createElement('span');
                    lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    lbl.textContent = (depth === 0 ? '📁 ' : '') + name + '  #' + rid;
                    if (isDisabled) lbl.title = '不可选（自己或后代）';
                    wrap.appendChild(lbl);
                    if (isSel) {
                        const tag = document.createElement('span');
                        tag.style.cssText = 'font-size:11px;color:#4f46e5;font-weight:500;flex-shrink:0;';
                        tag.textContent = '✓ 当前';
                        wrap.appendChild(tag);
                    }
                    return wrap;
                }
                host.appendChild(makeRow(0, '（根级，无上级）', 0, selId === 0, false, false, false));
                const ordered = [];
                (function dfs(pid, depth) {
                    for (const ch of childrenOf[pid] || []) {
                        ordered.push({ m: ch, depth });
                        dfs(ch.id, depth + 1);
                    }
                })(0, 0);
                for (const { m, depth } of ordered) {
                    if (m.parent_id && !_parentTreeExpanded.has(Number(m.parent_id))) continue;
                    host.appendChild(makeRow(
                        m.id, m.category_name, depth,
                        Number(m.id) === selId,
                        disabledIds.has(m.id),
                        hasChildrenSet.has(m.id),
                        _parentTreeExpanded.has(m.id)
                    ));
                }
            }

            function setPickerOpen(open) {
                _pickerOpen = open;
                parentPickerHost.style.display = open ? 'block' : 'none';
                // FA 7.x SVG icon：className 是只读 SVGAnimatedString，用 setAttribute('class', ...) 才能改
                if (parentPickChev) parentPickChev.setAttribute('class', 'fa-solid ' + (open ? 'fa-chevron-up' : 'fa-chevron-down'));
                if (open) renderPickerTreeInline(parentPickerHost);
            }

            parentPickBtn.addEventListener('click', () => setPickerOpen(!_pickerOpen));

            // 委托：chevron 优先 → 行选中（点中自动收起 picker）
            parentPickerHost.addEventListener('click', (ev) => {
                const chev = ev.target.closest('[data-chev="1"]');
                if (chev) {
                    const row = chev.closest('[data-cat-id]');
                    if (!row) return;
                    const rid = Number(row.dataset.catId);
                    if (!rid) return;
                    if (_parentTreeExpanded.has(rid)) _parentTreeExpanded.delete(rid);
                    else _parentTreeExpanded.add(rid);
                    renderPickerTreeInline(parentPickerHost);
                    return;
                }
                const row = ev.target.closest('[data-cat-id]');
                if (!row) return;
                if (row.dataset.disabled === '1') return;
                const rid = Number(row.dataset.catId);
                parentSel.value = String(rid);
                updateParentDisplay();
                triggerParentChange();
                setPickerOpen(false);
            });

            // 互斥分类（exclusive_with）
            const exclBox = form.querySelector('#setMenuExclBox');
            const exclEmpty = form.querySelector('#setMenuExclEmpty');
            const exclTree = form.querySelector('#setMenuExclTree');
            const exclWarn = form.querySelector('#setMenuExclWarn');
            const parseExcl = window.parseExclusiveWith || function (s) { return String(s || '').split(',').map(x => Number(String(x).trim())).filter(n => Number.isFinite(n) && n > 0); };
            const formatExcl = window.formatExclusiveWith || function (arr) { return (arr || []).map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0).join(','); };
            const formatExclGroup = window.formatExclusiveGroup || function (s) { return String(s == null ? '' : s).trim(); };
            let selectedExclIds = new Set(parseExcl(it ? it.exclusive_with : ''));

            const selfAndAncestorIds = new Set();
            if (id) {
                const byIdTmp = new Map(menuItems.map(m => [m.id, m]));
                let cur = byIdTmp.get(Number(id));
                while (cur) {
                    selfAndAncestorIds.add(Number(cur.id));
                    cur = cur.parent_id ? byIdTmp.get(Number(cur.parent_id)) : null;
                }
            }

            const menuByIdForPath = new Map(menuItems.map(m => [m.id, m]));
            function pathOf(mid) {
                const m = menuByIdForPath.get(mid);
                if (!m) return '#' + mid;
                const segs = [];
                let cur = m;
                while (cur) {
                    segs.unshift(cur.category_name);
                    cur = cur.parent_id ? menuByIdForPath.get(cur.parent_id) : null;
                }
                return segs.join(' > ');
            }

            function renderExclChips() {
                Array.from(exclBox.querySelectorAll('.setMenuExclChip')).forEach(n => n.remove());
                if (!selectedExclIds.size) { exclEmpty.style.display = ''; return; }
                exclEmpty.style.display = 'none';
                for (const eid of selectedExclIds) {
                    const chip = document.createElement('span');
                    chip.className = 'setMenuExclChip';
                    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;font-size:12px;color:#4338ca;line-height:1.4;';
                    const lbl = document.createElement('span');
                    lbl.textContent = pathOf(eid) + ' #' + eid;
                    lbl.title = '点击 × 移除';
                    chip.appendChild(lbl);
                    const x = document.createElement('span');
                    x.textContent = '×';
                    x.style.cssText = 'cursor:pointer;color:#6366f1;font-weight:700;font-size:14px;line-height:1;padding:0 4px;border-radius:50%;user-select:none;';
                    x.addEventListener('mouseenter', () => { x.style.background = '#c7d2fe'; });
                    x.addEventListener('mouseleave', () => { x.style.background = 'transparent'; });
                    x.addEventListener('click', () => {
                        selectedExclIds.delete(eid);
                        renderExclChips();
                        renderExclTree();
                        checkAncestorConflict();
                    });
                    chip.appendChild(x);
                    exclBox.appendChild(chip);
                }
            }

            const _exclTreeExpanded = new Set();

            function renderExclTree() {
                exclTree.innerHTML = '';
                if (!menuItems.length) {
                    exclTree.innerHTML = '<div style="font-size:12px;color:#9ca3af;padding:4px;">（暂无分类）</div>';
                    return;
                }
                const byIdAuto = new Map(menuItems.map(m => [m.id, m]));
                for (const eid of selectedExclIds) {
                    let cur = byIdAuto.get(Number(eid));
                    while (cur && cur.parent_id) {
                        _exclTreeExpanded.add(Number(cur.parent_id));
                        cur = byIdAuto.get(Number(cur.parent_id));
                    }
                }
                const childrenOf = {};
                for (const m of menuItems) {
                    const p = m.parent_id || 0;
                    (childrenOf[p] = childrenOf[p] || []).push(m);
                }
                for (const k in childrenOf) {
                    childrenOf[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
                }
                const hasChildrenSet = new Set();
                for (const k in childrenOf) {
                    if (k !== '0' || childrenOf[k].length) {
                        for (const ch of childrenOf[k]) hasChildrenSet.add(ch.id);
                    }
                }
                const ordered = [];
                (function dfs(pid, depth) {
                    for (const ch of childrenOf[pid] || []) {
                        ordered.push({ m: ch, depth });
                        dfs(ch.id, depth + 1);
                    }
                })(0, 0);
                for (const { m, depth } of ordered) {
                    if (m.parent_id && !_exclTreeExpanded.has(Number(m.parent_id))) continue;
                    const hasChildren = hasChildrenSet.has(m.id);
                    const isExpanded = _exclTreeExpanded.has(m.id);
                    const isSelfOrAncestor = selfAndAncestorIds.has(m.id);
                    const checked = selectedExclIds.has(m.id);
                    const wrap = document.createElement('div');
                    wrap.style.cssText = 'display:flex;align-items:center;gap:5px;padding:2px 0 2px ' + (depth * 14) + 'px;font-size:12px;';
                    const chevron = hasChildren
                        ? '<span class="setMenuExclChevron" data-id="' + m.id + '" style="flex-shrink:0;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;color:#9ca3af;font-size:10px;cursor:pointer;user-select:none;">' + (isExpanded ? '▼' : '▶') + '</span>'
                        : '<span style="flex-shrink:0;width:14px;height:14px;display:inline-block;"></span>';
                    wrap.innerHTML = chevron;
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.id = 'setMenuExclCb_' + m.id;
                    cb.value = m.id;
                    cb.checked = checked;
                    cb.disabled = isSelfOrAncestor;
                    cb.style.cssText = 'cursor:' + (isSelfOrAncestor ? 'not-allowed' : 'pointer') + ';flex-shrink:0;';
                    cb.addEventListener('change', () => {
                        if (cb.checked) selectedExclIds.add(m.id);
                        else selectedExclIds.delete(m.id);
                        renderExclChips();
                        checkAncestorConflict();
                    });
                    const lbl = document.createElement('label');
                    lbl.htmlFor = 'setMenuExclCb_' + m.id;
                    const baseColor = isSelfOrAncestor ? '#d1d5db' : (depth === 0 ? '#374151' : '#6b7280');
                    const fontWeight = depth === 0 ? ';font-weight:500;' : '';
                    lbl.style.cssText = 'cursor:' + (isSelfOrAncestor ? 'not-allowed' : 'pointer') + ';color:' + baseColor + fontWeight + 'user-select:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    lbl.textContent = (depth === 0 ? '📁 ' : (depth === 1 ? '├─ ' : '└─ ')) + m.category_name + '  #' + m.id;
                    if (isSelfOrAncestor) lbl.title = '本分类或上级分类，不可互斥（会产生循环）';
                    wrap.appendChild(cb);
                    wrap.appendChild(lbl);
                    exclTree.appendChild(wrap);
                }
                exclTree.querySelectorAll('.setMenuExclChevron').forEach(span => {
                    span.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        const mid = Number(span.getAttribute('data-id'));
                        if (_exclTreeExpanded.has(mid)) _exclTreeExpanded.delete(mid);
                        else _exclTreeExpanded.add(mid);
                        renderExclTree();
                    });
                });
            }

            function checkAncestorConflict() {
                exclWarn.style.display = 'none';
                exclWarn.textContent = '';
                if (!selectedExclIds.size) return;
                const newParentId = Number(form.querySelector('#setMenuParentSel').value) || 0;
                if (!newParentId) return;
                const byId = new Map(menuItems.map(m => [m.id, m]));
                const conflicts = [];
                let cur = byId.get(newParentId);
                while (cur) {
                    if (selectedExclIds.has(cur.id)) conflicts.push({ aid: cur.id, ancName: cur.category_name });
                    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
                }
                if (conflicts.length) {
                    const msg = conflicts.map(c => '「' + c.ancName + '」(id=' + c.aid + ')').join('、');
                    exclWarn.textContent = '⚠ 不可与上级分类互斥：' + msg;
                    exclWarn.style.display = '';
                }
            }

            renderExclChips();
            renderExclTree();
            checkAncestorConflict();

            form.querySelector('#setMenuSaveBtn').addEventListener('click', async () => {
                const name = form.querySelector('#setMenuNameInp').value.trim();
                if (!name) { showToast('分类名称不能为空', 'error'); return; }
                if (selectedExclIds.size) {
                    const newParentId = Number(form.querySelector('#setMenuParentSel').value) || 0;
                    if (newParentId) {
                        const byId = new Map(menuItems.map(m => [m.id, m]));
                        const conflicts = [];
                        let cur = byId.get(newParentId);
                        while (cur) {
                            if (selectedExclIds.has(cur.id)) conflicts.push({ aid: cur.id, ancName: cur.category_name });
                            cur = cur.parent_id ? byId.get(cur.parent_id) : null;
                        }
                        if (conflicts.length) {
                            const msg = conflicts.map(c => '「' + c.ancName + '」(id=' + c.aid + ')').join('、');
                            showToast('互斥分类冲突：不可与上级分类互斥 ' + msg, 'error');
                            return;
                        }
                    }
                }
                const payload = {
                    category_name: name,
                    parent_id: Number(form.querySelector('#setMenuParentSel').value) || 0,
                    description: form.querySelector('#setMenuDescInp').value.trim(),
                    sort_order: Number(form.querySelector('#setMenuSortInp').value) || 0,
                    is_required: form.querySelector('#setMenuReqInp').checked,
                    tag_required: form.querySelector('#setMenuTagReqInp').value.trim(),
                    exclusive_with: formatExcl(Array.from(selectedExclIds)),
                    exclusive_group: formatExclGroup(form.querySelector('#setMenuExclGroupInp').value),
                };
                let r;
                if (menuEditingId) r = await api.promptMenu.update({ id: menuEditingId, ...payload });
                else r = await api.promptMenu.add(payload);
                if (r.ok) {
                    showToast(menuEditingId ? '修改成功' : '添加成功', 'success');
                    await loadMenu();
                    renderMenuTree();
                    if (menuEditingId) {
                        _lastCreateParentId = 0;
                        showMenuForm(menuEditingId);
                    } else {
                        _lastCreateParentId = payload.parent_id;
                        showMenuForm(null, { defaultParentId: _lastCreateParentId, keepCreating: true });
                    }
                } else showToast(r.error || '操作失败', 'error');
            });
            form.querySelector('#setMenuCancelBtn').addEventListener('click', () => {
                document.getElementById('setMenuForm').style.display = 'none';
                document.getElementById('setMenuEmpty').style.display = 'block';
                menuEditingId = null;
                _lastCreateParentId = 0;
                renderMenuTree();
            });
            if (id) {
                form.querySelector('#setMenuDelBtn').addEventListener('click', async () => {
                    if (!confirm('删除分类会同时删除其所有子分类，确定删除？')) return;
                    const r = await api.promptMenu.delete(id);
                    if (r.ok) {
                        showToast('已删除（' + r.deleted + '项）', 'success');
                        await loadMenu();
                        menuEditingId = null;
                        renderMenuTree();
                        showMenuForm(null);
                    } else showToast(r.error || '删除失败', 'error');
                });
            }
            // 重渲左侧树（高亮当前选中）
            renderMenuTree();
        }

        // 新增按钮
        toolbar.querySelector('#setMenuAddBtn').addEventListener('click', () => {
            const parentId = _lastCreateParentId || menuEditingId || 0;
            const keepCreating = !!_lastCreateParentId;
            menuEditingId = null;
            showMenuForm(null, { defaultParentId: parentId, keepCreating });
        });

        // 初次加载
        (async () => {
            await loadMenu();
            renderMenuTree();
        })();
    }
    // ===== 提示词配置子页面（阶段 3）=====
    // 复制自 prompt-gen.js:2922-3108 + Excel 导入逻辑（2171-2266）
    // cfg* 前缀 → setItem* 避免冲突；用模块共享 state；新增 / 导入按钮内联。
    function renderSubModuleItem(container) {
        container.innerHTML = '';
        const root = document.createElement('div');
        root.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#ffffff;';

        // 顶部 toolbar
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'padding:10px 16px; border-bottom:1px solid #e5e7eb; background:#f9fafb; display:flex; align-items:center; gap:8px; flex-shrink:0;';
        toolbar.innerHTML = `
            <button id="setItemAddBtn" class="btn btn-sm" type="button" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-plus"></i> 新增提示词</button>
            <button id="setItemBatchAddBtn" class="btn btn-sm" type="button" title="粘贴一段文本，按中英文逗号自动分割为多个提示词" style="background:#10b981;color:#fff;border:none;"><i class="fa-solid fa-list-ol"></i> 批量添加</button>
            <button id="setItemImportTplBtn" class="btn btn-sm" type="button" title="下载 Excel 导入模板（含表头+示例+现有分类参考）"><i class="fa-solid fa-download"></i> 下载模板</button>
            <button id="setItemImportBtn" class="btn btn-sm" type="button" title="从 Excel/CSV 批量导入提示词" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-file-import"></i> Excel 导入</button>
            <input type="file" id="setItemImportFile" accept=".xlsx,.xls,.csv" style="display:none;">
            <span id="setItemImportStatus" style="margin-left:auto; font-size:11px; color:#6b7280; align-self:center;"></span>
        `;
        root.appendChild(toolbar);

        // 主体：左树 + 右内容
        const body = document.createElement('div');
        body.style.cssText = 'display:flex; flex:1; min-height:0; overflow:hidden;';
        body.innerHTML = `
            <div style="width:220px; border-right:1px solid #e5e7eb; overflow-y:auto; padding:10px 0; background:#fafafa;">
                <div id="setItemTree" style="font-size:13px; padding:0 8px;"></div>
            </div>
            <div style="flex:1; overflow-y:auto; padding:14px 18px;">
                <div id="setItemList" style="margin-bottom:14px;"></div>
                <div id="setItemFormWrap" style="display:none;"></div>
            </div>
        `;
        root.appendChild(body);
        container.appendChild(root);

        // 一次性事件委托：左树的所有点击（行选中 / chevron 折叠）都走这里，避免对动态创建的 <i> 绑定事件
        const treeEl = document.getElementById('setItemTree');
        if (treeEl && !treeEl._treeDelegated) {
            treeEl._treeDelegated = true;
            treeEl.addEventListener('click', async (e) => {
                // 1) 折叠切换（chevron）
                const chev = e.target.closest('[data-toggle-cat]');
                if (chev) {
                    e.stopPropagation();
                    const id = Number(chev.dataset.toggleCat);
                    if (_itemTreeCollapsed.has(id)) _itemTreeCollapsed.delete(id);
                    else _itemTreeCollapsed.add(id);
                    renderItemTree();
                    return;
                }
                // 2) 行选中
                const row = e.target.closest('[data-cat-id]');
                if (row) {
                    const id = Number(row.dataset.catId);
                    currentItemCatId = id;
                    _lastCreateItemCatId = 0;
                    _expandAncestorsOf(id);
                    renderItemTree();
                    await loadItemList(id);
                }
            });
        }

        async function loadItemTree() {
            await loadMenu();
            // 默认全部折叠
            _itemTreeCollapsed = _getAllParentIds();
            renderItemTree();
            if (menuItems.length) {
                const byParent = {};
                for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
                for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
                function firstId(pid) {
                    const children = byParent[pid] || [];
                    return children.length ? firstId(children[0].id) : pid;
                }
                const firstCatId = firstId(0);
                if (firstCatId) {
                    currentItemCatId = firstCatId;
                    // 展开首分类的所有祖先，让用户能看到当前选中
                    _expandAncestorsOf(firstCatId);
                    renderItemTree();
                    await loadItemList(firstCatId);
                }
            }
        }

        function renderItemTree() {
            const el = document.getElementById('setItemTree');
            if (!el) return;
            el.innerHTML = '';
            if (!menuItems.length) { el.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 4px;">暂无分类</div>'; return; }
            const byParent = {};
            for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
            for (const k in byParent) byParent[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
            function walk(pid, depth) {
                const children = byParent[pid] || [];
                for (const it of children) {
                    const hasChildren = (byParent[it.id] || []).length > 0;
                    const isCollapsed = _itemTreeCollapsed.has(it.id);
                    const div = document.createElement('div');
                    div.dataset.catId = String(it.id);
                    const isSel = currentItemCatId === it.id;
                    div.style.cssText = 'padding:5px 6px;border-radius:6px;cursor:pointer;margin-bottom:1px;display:flex;align-items:center;gap:5px;' + (isSel ? 'background:#ede9fe;color:#6d28d9;font-weight:500;' : '');
                    if (!isSel) {
                        div.addEventListener('mouseenter', () => { div.style.background = '#ede9fe'; });
                        div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
                    }
                    // 折叠切换按钮：有 children 的节点显示 chevron，否则占位缩进
                    // 用 <span> 包一层并设 inline-block，确保点击区域稳定（<i> + FontAwesome ::before 有时不可靠）
                    const chevHtml = hasChildren
                        ? `<span data-toggle-cat="${it.id}" title="${isCollapsed ? '展开' : '收起'}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:16px;flex-shrink:0;margin-left:${depth * 14}px;cursor:pointer;color:#6b7280;border-radius:3px;"><i class="fa-solid fa-chevron-${isCollapsed ? 'right' : 'down'}" style="font-size:10px;pointer-events:none;"></i></span>`
                        : `<span style="display:inline-block;width:14px;flex-shrink:0;margin-left:${depth * 14}px;"></span>`;
                    div.innerHTML = chevHtml + '<i class="fa-solid fa-folder' + (it.parent_id ? '-open' : '') + '" style="color:' + (it.parent_id ? '#f59e0b' : '#6366f1') + ';font-size:11px;"></i><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.category_name) + '</span>' + (it.is_required ? '<span title="必选" style="flex-shrink:0;width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;margin-left:2px;"></span>' : '');
                    div.title = it.description || it.category_name;
                    el.appendChild(div);
                    // 折叠时跳过子节点
                    if (hasChildren && !isCollapsed) {
                        walk(it.id, depth + 1);
                    }
                }
            }
            walk(0, 0);
        }

        // 获取所有有子节点的父节点 id（用于「默认全部折叠」初始化）
        function _getAllParentIds() {
            const ids = new Set();
            const byParent = {};
            for (const it of menuItems) { const p = it.parent_id || 0; (byParent[p] = byParent[p] || []).push(it); }
            for (const id in byParent) {
                if (byParent[id].length > 0) ids.add(Number(id));
            }
            return ids;
        }

        // 展开 catId 节点的所有祖先（用于选中时保证可见）
        function _expandAncestorsOf(catId) {
            let p = (menuItems.find(x => x.id === catId) || {}).parent_id;
            while (p && p !== 0) {
                _itemTreeCollapsed.delete(p);
                const parent = menuItems.find(x => x.id === p);
                p = parent ? parent.parent_id : 0;
            }
        }

        async function loadItemList(catId) {
            const r = await api.promptItems.list(catId);
            const items = r.ok ? r.items : [];
            const catName = (menuItems.find(x => x.id === catId) || {}).category_name || '';
            const listEl = document.getElementById('setItemList');
            const wrap = document.getElementById('setItemFormWrap');
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
                chip.title = (it.content || '') + (it.description ? '\n\n说明：' + it.description : '');
                chip.addEventListener('click', () => showItemForm(it.id));
                chips.appendChild(chip);
            }
            listEl.appendChild(chips);
            wrap.style.display = 'none';
            wrap.innerHTML = '';
        }

        function showItemForm(id, opts) {
            opts = opts || {};
            itemEditingId = id;
            const wrap = document.getElementById('setItemFormWrap');
            wrap.style.display = 'block';
            const keepCreating = !id && !!opts.keepCreating;
            const allItems = [];
            // 预览图状态：fileName=已上传文件名；dataUrl=用户刚选的图 base64；removed=点了「清除」
            const _pv = { fileName: '', dataUrl: '', mime: '', removed: false };
            (async () => {
                if (currentItemCatId) {
                    const r = await api.promptItems.list(currentItemCatId);
                    if (r.ok) allItems.push(...r.items);
                }
                const it = id ? (allItems.find(x => x.id === id) || { category_id: opts.defaultCatId || currentItemCatId || 0 }) : { category_id: opts.defaultCatId || currentItemCatId || 0 };

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
                const defaultCatId = it.category_id || 0;
                const flatOrdered = [];
                function dfs(pid) { for (const ch of (byParent[pid] || [])) { flatOrdered.push(ch); dfs(ch.id); } }
                dfs(0);
                function renderCatOption(x) {
                    const depth = depthOf(x);
                    const indent = '　　'.repeat(Math.max(0, depth));
                    const prefix = depth === 0 ? '' : (siblingIdx[x.id].isLast ? '└─ ' : '├─ ');
                    const sel = (Number(x.id) === Number(defaultCatId)) ? ' selected' : '';
                    return '<option value="' + x.id + '"' + sel + '>' + indent + prefix + esc(x.category_name) + '</option>';
                }
                const catOptionsHtml = flatOrdered.map(renderCatOption).join('') || '<option value="0" disabled>（暂无分类）</option>';

                function defaultSortForItem(catId) {
                    if (!catId) return 0;
                    const sibs = allItems.filter(x => (x.category_id || 0) === catId);
                    if (!sibs.length) return 0;
                    return Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
                }
                const defaultSort = id ? (it.sort_order || 0) : defaultSortForItem(defaultCatId);

                wrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;border-top:1px solid #f3f4f6;padding-top:12px;"><span style="font-size:14px;font-weight:500;color:#374151;">' + (id ? '编辑提示词' : (keepCreating ? '新增提示词 <span style="font-size:11px;color:#059669;font-weight:400;margin-left:6px;">· 连续新增模式</span>' : '新增提示词')) + '</span>' + (id ? '<button id="setItemDelBtn" class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;margin-left:auto;"><i class="fa-solid fa-trash"></i> 删除</button>' : '') + '</div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">所属分类 *</label><select id="setItemCatSel" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;font-family:inherit;">' + catOptionsHtml + '</select>' + (keepCreating ? '<div style="font-size:11px;color:#059669;margin-top:3px;">· 保持上次选择的分类；改这里会重算排序</div>' : '') + '</div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">提示词名称 *</label><input id="setItemNameInp" type="text" value="' + esc((id || !keepCreating) ? (it.name || '') : '') + '" placeholder="如：柔光、暖色调' + (keepCreating ? '（保存后保持此位置，可连着输入下一个）' : '') + '" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;box-sizing:border-box;' + (keepCreating ? 'border-color:#10b981;' : '') + '"></div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">内容</label><textarea id="setItemContentInp" rows="2" placeholder="提示词正文内容" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.content || '') : '') + '</textarea></div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">说明</label><textarea id="setItemDescInp" rows="2" placeholder="可选，说明此提示词的用途或效果" style="width:100%;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;resize:vertical;box-sizing:border-box;">' + esc((id || !keepCreating) ? (it.description || '') : '') + '</textarea></div>' +
                    '<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">敏感度</label><select id="setItemSensSel" style="width:160px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;background:#fff;"><option value="sfw"' + (((id || !keepCreating) ? (it.sensitivity || 'nsfw') : 'nsfw') === 'sfw' ? ' selected' : '') + '>SFW （安全）</option><option value="nsfw"' + (((id || !keepCreating) ? (it.sensitivity || 'nsfw') : 'nsfw') === 'nsfw' ? ' selected' : '') + '>NSFW （成人）</option></select><span style="font-size:11px;color:#9ca3af;margin-left:8px;">默认 NSFW</span></div>' +
                    '<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">排序权重</label><input id="setItemSortInp" type="number" value="' + defaultSort + '" min="0" style="width:120px;padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;font-size:13px;' + (keepCreating ? 'border-color:#10b981;' : '') + '"><span style="font-size:11px;color:#9ca3af;margin-left:6px;">越小越靠前' + (id ? '' : ' · 新增自动取同级最大 +1') + '</span></div>' +
                    '<div style="margin-bottom:12px;"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:3px;">预览图 <span style="color:#9ca3af;font-weight:400;">（可选，仅 1 张，jpg/png/webp，≤2MB）</span></label><div style="display:flex;gap:10px;align-items:center;"><div id="setItemPvThumb" style="width:160px;height:90px;border:1px dashed #d1d5db;border-radius:6px;background:#f9fafb center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;">暂无预览图</div><div style="display:flex;flex-direction:column;gap:6px;"><input id="setItemPvFile" type="file" accept="image/jpeg,image/png,image/webp" style="font-size:12px;max-width:220px;"><button id="setItemPvClearBtn" type="button" class="btn btn-sm" style="display:none;background:#fee2e2;color:#dc2626;border:1px solid #fecaca;"><i class="fa-solid fa-xmark"></i> 清除预览图</button></div></div></div>' +
                    '<div style="display:flex;gap:8px;"><button id="setItemSaveBtn" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-floppy-disk"></i> 保存' + (keepCreating ? '并继续' : '') + '</button><button id="setItemCancelBtn" class="btn btn-sm">取消</button></div>';

                // ---- 预览图：编辑模式拉已有；新增模式清空 ----
                const pvThumb = wrap.querySelector('#setItemPvThumb');
                const pvFile = wrap.querySelector('#setItemPvFile');
                const pvClearBtn = wrap.querySelector('#setItemPvClearBtn');
                const _setPvThumb = (dataUrl, hasImage) => {
                    if (hasImage) {
                        pvThumb.style.backgroundImage = 'url(' + dataUrl + ')';
                        pvThumb.textContent = '';
                    } else {
                        pvThumb.style.backgroundImage = '';
                        pvThumb.textContent = '暂无预览图';
                    }
                };
                if (id) {
                    const cur = allItems.find(x => x.id === id);
                    const fn = (cur && cur.preview_image) || '';
                    if (fn) {
                        api.promptPreview.read({ fileName: fn }).then(r => {
                            if (r && r.ok) {
                                _pv.fileName = fn;
                                _setPvThumb(r.dataUrl, true);
                                pvClearBtn.style.display = '';
                            } else {
                                _setPvThumb(null, false);
                            }
                        });
                    } else {
                        _setPvThumb(null, false);
                    }
                } else {
                    _setPvThumb(null, false);
                }
                pvFile.addEventListener('change', async () => {
                    const f = pvFile.files && pvFile.files[0];
                    if (!f) return;
                    if (f.size > 2 * 1024 * 1024) {
                        showToast('预览图不能超过 2MB', 'error');
                        pvFile.value = '';
                        return;
                    }
                    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                        showToast('仅支持 jpg / png / webp', 'error');
                        pvFile.value = '';
                        return;
                    }
                    try {
                        const r = await window._compressImageToBase64(f, 100 * 1024);
                        _pv.dataUrl = r.dataBase64;
                        _pv.mime = r.mime;
                        _pv.removed = false;
                        _setPvThumb('data:' + r.mime + ';base64,' + r.dataBase64, true);
                        pvClearBtn.style.display = '';
                        if (r.compressed) {
                            showToast(`已压缩：${(r.originalSize/1024).toFixed(0)}KB → ${(r.finalSize/1024).toFixed(0)}KB`, 'success');
                        }
                    } catch (e) {
                        showToast('图片处理失败: ' + (e && e.message || e), 'error');
                        pvFile.value = '';
                    }
                });
                pvClearBtn.addEventListener('click', () => {
                    _pv.fileName = '';
                    _pv.dataUrl = '';
                    _pv.removed = true;
                    _setPvThumb(null, false);
                    pvClearBtn.style.display = 'none';
                    pvFile.value = '';
                });

                const catSel = wrap.querySelector('#setItemCatSel');
                if (!id) {
                    catSel.addEventListener('change', () => {
                        const newCatId = Number(catSel.value) || 0;
                        api.promptItems.list(newCatId).then(rr => {
                            const sibs = (rr.ok && rr.items) ? rr.items : [];
                            let ns = 0;
                            if (sibs.length) ns = Math.max(...sibs.map(s => s.sort_order || 0)) + 1;
                            wrap.querySelector('#setItemSortInp').value = ns;
                        });
                    });
                }

                wrap.querySelector('#setItemSaveBtn').addEventListener('click', async () => {
                    const name = wrap.querySelector('#setItemNameInp').value.trim();
                    if (!name) { showToast('提示词名称不能为空', 'error'); return; }
                    const payload = { name, category_id: Number(wrap.querySelector('#setItemCatSel').value) || 0, content: wrap.querySelector('#setItemContentInp').value.trim(), description: wrap.querySelector('#setItemDescInp').value.trim(), sort_order: Number(wrap.querySelector('#setItemSortInp').value) || 0, sensitivity: wrap.querySelector('#setItemSensSel').value };
                    let r;
                    if (itemEditingId) r = await api.promptItems.update({ id: itemEditingId, ...payload });
                    else r = await api.promptItems.add(payload);
                    if (!r.ok) { showToast(r.error || '操作失败', 'error'); return; }

                    // ---- 预览图后处理 ----
                    const newId = itemEditingId || r.id;
                    if (_pv.removed) {
                        await api.promptItems.update({ id: newId, preview_clear: true });
                    } else if (_pv.dataUrl) {
                        const up = await api.promptPreview.upload({
                            mime: _pv.mime,
                            dataBase64: _pv.dataUrl,
                            itemId: newId,
                        });
                        if (up && up.ok) {
                            await api.promptItems.update({ id: newId, preview_file: up.fileName });
                        } else if (up && up.error) {
                            showToast('预览图上传失败: ' + up.error, 'error');
                        }
                    }

                    showToast(itemEditingId ? '修改成功' : '添加成功', 'success');
                    await loadItemList(currentItemCatId);
                    if (itemEditingId) {
                        _lastCreateItemCatId = 0;
                        showItemForm(null);
                    } else {
                        _lastCreateItemCatId = payload.category_id;
                        showItemForm(null, { defaultCatId: _lastCreateItemCatId, keepCreating: true });
                    }
                });
                wrap.querySelector('#setItemCancelBtn').addEventListener('click', () => { wrap.style.display = 'none'; wrap.innerHTML = ''; itemEditingId = null; _lastCreateItemCatId = 0; });
                if (id) {
                    wrap.querySelector('#setItemDelBtn').addEventListener('click', async () => {
                        if (!confirm('确定删除此提示词？')) return;
                        const r = await api.promptItems.delete(id);
                        if (r.ok) { showToast('已删除', 'success'); itemEditingId = null; _lastCreateItemCatId = 0; await loadItemList(currentItemCatId); showItemForm(null); }
                        else showToast(r.error || '删除失败', 'error');
                    });
                }
            })();
        }

        // ---- 新增按钮：进入连续新增模式 ----
        toolbar.querySelector('#setItemAddBtn').addEventListener('click', () => {
            const defaultCatId = _lastCreateItemCatId || currentItemCatId || 0;
            showItemForm(null, { defaultCatId, keepCreating: !!_lastCreateItemCatId });
        });

        // ---- 批量添加按钮：弹多行文本框，按中英文逗号分割入库 ----
        toolbar.querySelector('#setItemBatchAddBtn').addEventListener('click', () => {
            // 只用 currentItemCatId（左侧当前选中的分类），不能用 _lastCreateItemCatId 否则会导到错分类
            const catId = currentItemCatId;
            if (!catId) { showToast('请先在左侧选中一个分类', 'error'); return; }
            const catName = (menuItems.find(x => x.id === catId) || {}).category_name || '';
            showBatchAddModal(catId, catName);
        });

        function showBatchAddModal(catId, catName) {
            let overlay = document.getElementById('setBatchAddModal');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'setBatchAddModal';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10002;display:flex;align-items:center;justify-content:center;';
                overlay.innerHTML = `
                    <div style="background:#fff;border-radius:10px;width:680px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
                        <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:8px;background:#f9fafb;">
                            <span style="font-size:14px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-list-ol" style="color:#10b981;margin-right:6px;"></i>批量添加提示词</span>
                            <span id="setBatchAddCatBadge" style="font-size:12px;color:#6b7280;margin-left:6px;"></span>
                            <button id="setBatchAddClose" style="background:transparent;border:none;cursor:pointer;color:#6b7280;font-size:16px;margin-left:auto;"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <div style="padding:14px 18px;flex:1;display:flex;flex-direction:column;min-height:0;">
                            <div style="font-size:12px;color:#6b7280;margin-bottom:8px;line-height:1.6;">
                                粘贴一段文本，系统按 <strong style="color:#374151;">中文「，」</strong> 与 <strong style="color:#374151;">英文「,」</strong> 自动分割成多个提示词，名称与内容均使用分割后的文本。
                                <br>空段、同名段会被自动跳过。
                            </div>
                            <textarea id="setBatchAddInput" placeholder="示例：&#10;1girl, masterpiece, best quality&#10;red dress, long hair, smile&#10;outdoor, sunlight, cinematic lighting&#10;..." style="flex:1;min-height:260px;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:system-ui,-apple-system,sans-serif;line-height:1.6;resize:vertical;box-sizing:border-box;"></textarea>
                            <div style="display:flex;align-items:center;gap:12px;margin-top:10px;font-size:12px;color:#374151;">
                                <span style="font-weight:500;">敏感度：</span>
                                <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
                                    <input type="radio" name="setBatchAddSens" value="sfw" checked style="cursor:pointer;"> SFW
                                </label>
                                <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
                                    <input type="radio" name="setBatchAddSens" value="nsfw" style="cursor:pointer;"> NSFW
                                </label>
                                <span id="setBatchAddCount" style="margin-left:auto;font-weight:500;color:#6b7280;">已识别 0 个提示词</span>
                            </div>
                        </div>
                        <div style="padding:12px 18px;border-top:1px solid #e5e7eb;display:flex;gap:8px;justify-content:flex-end;background:#fafafa;">
                            <button id="setBatchAddCancel" class="btn">取消</button>
                            <button id="setBatchAddSubmit" class="btn btn-primary" disabled style="background:#10b981;border:none;"><i class="fa-solid fa-check"></i> 确定添加</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(overlay);

                const input = overlay.querySelector('#setBatchAddInput');
                const countEl = overlay.querySelector('#setBatchAddCount');
                const submitBtn = overlay.querySelector('#setBatchAddSubmit');
                const close = () => overlay.style.display = 'none';
                overlay.querySelector('#setBatchAddClose').addEventListener('click', close);
                overlay.querySelector('#setBatchAddCancel').addEventListener('click', close);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
                // 实时识别计数
                input.addEventListener('input', () => {
                    const n = _parseBatchPrompts(input.value).length;
                    countEl.textContent = `已识别 ${n} 个提示词`;
                    countEl.style.color = n > 0 ? '#059669' : '#6b7280';
                    submitBtn.disabled = n === 0;
                });
                submitBtn.addEventListener('click', async () => {
                    const list = _parseBatchPrompts(input.value);
                    if (!list.length) { showToast('没有可添加的提示词', 'error'); return; }
                    const sensEl = overlay.querySelector('input[name="setBatchAddSens"]:checked');
                    const sensitivity = sensEl ? String(sensEl.value) : 'sfw';
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 添加中...';
                    const result = await doBatchAdd(list, catId, sensitivity);
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> 确定添加';
                    if (result.success > 0) {
                        showToast(`批量添加完成：成功 ${result.success} 个${result.skip ? `，跳过 ${result.skip} 个` : ''}${result.fail ? `，失败 ${result.fail} 个` : ''}`, 'success');
                        input.value = '';
                        countEl.textContent = '已识别 0 个提示词';
                        countEl.style.color = '#6b7280';
                        submitBtn.disabled = true;
                        await loadItemList(catId);
                        // 关闭弹框
                        close();
                    } else {
                        showToast(`添加失败：${result.errors.slice(0, 3).join('；')}`, 'error');
                    }
                });
            }
            // 弹框显示前：刷新 catBadge + 清空输入
            const badge = overlay.querySelector('#setBatchAddCatBadge');
            if (badge) badge.innerHTML = `目标分类：<strong style="color:#6366f1;">${esc(catName)}</strong>`;
            const input = overlay.querySelector('#setBatchAddInput');
            const countEl = overlay.querySelector('#setBatchAddCount');
            const submitBtn = overlay.querySelector('#setBatchAddSubmit');
            if (input) input.value = '';
            if (countEl) { countEl.textContent = '已识别 0 个提示词'; countEl.style.color = '#6b7280'; }
            if (submitBtn) submitBtn.disabled = true;
            overlay.style.display = 'flex';
            // 自动聚焦
            setTimeout(() => { if (input) input.focus(); }, 30);
        }

        // 解析批量输入：按中英文逗号分割，trim，去空，去重（保持顺序）
        function _parseBatchPrompts(text) {
            if (!text) return [];
            const parts = String(text).split(/[,，]/);
            const seen = new Set();
            const out = [];
            for (let p of parts) {
                p = String(p || '').trim();
                if (!p) continue;
                if (seen.has(p)) continue;
                seen.add(p);
                out.push(p);
            }
            return out;
        }

        // 批量入库：循环调 api.promptItems.add
        async function doBatchAdd(list, catId, sensitivity) {
            const sens = sensitivity === 'nsfw' ? 'nsfw' : 'sfw';
            const result = { success: 0, fail: 0, skip: 0, errors: [] };
            for (let i = 0; i < list.length; i++) {
                const text = list[i];
                try {
                    const r = await api.promptItems.add({
                        category_id: catId,
                        name: text,
                        content: text,
                        description: '',
                        sort_order: 0,
                        sensitivity: sens,
                    });
                    if (r && r.ok) {
                        result.success++;
                    } else {
                        // 唯一约束冲突（同分类下同名）视为跳过，不算失败
                        const errMsg = (r && r.error) || '未知错误';
                        if (/unique|conflict|UNIQUE/i.test(errMsg)) {
                            result.skip++;
                        } else {
                            result.fail++;
                            result.errors.push(`「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」: ${errMsg}`);
                        }
                    }
                } catch (e) {
                    result.fail++;
                    result.errors.push(`「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」: ${e && e.message || '异常'}`);
                }
            }
            return result;
        }

        // ---- Excel 导入 / 模板下载 ----
        toolbar.querySelector('#setItemImportBtn').addEventListener('click', () => {
            document.getElementById('setItemImportFile').click();
        });
        toolbar.querySelector('#setItemImportFile').addEventListener('change', onItemImportFileSelected);
        toolbar.querySelector('#setItemImportTplBtn').addEventListener('click', downloadItemTemplate);

        async function onItemImportFileSelected(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const status = document.getElementById('setItemImportStatus');
            if (status) status.textContent = '正在解析 ' + file.name + ' ...';
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    if (typeof XLSX === 'undefined') {
                        showToast('SheetJS 未加载', 'error');
                        if (status) status.textContent = '';
                        return;
                    }
                    const data = new Uint8Array(ev.target.result);
                    const wb = XLSX.read(data, { type: 'array' });
                    const firstSheet = wb.SheetNames[0];
                    if (!firstSheet) { showToast('Excel 没有可读的工作表', 'error'); if (status) status.textContent = ''; return; }
                    const sheet = wb.Sheets[firstSheet];
                    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                    if (!rows.length) { showToast('Excel 没有任何数据行', 'error'); if (status) status.textContent = ''; return; }
                    if (status) status.textContent = '正在导入 ' + rows.length + ' 行 ...';
                    const r = await api.promptItems.import(rows);
                    if (!r.ok) {
                        showToast('导入失败：' + r.error, 'error');
                        if (status) status.textContent = '';
                        return;
                    }
                    const parts = [];
                    if (r.imported) parts.push('新增 ' + r.imported);
                    if (r.updated) parts.push('更新 ' + r.updated);
                    if (r.catsCreated) parts.push('自动建分类 ' + r.catsCreated);
                    if (r.skipped) parts.push('跳过 ' + r.skipped);
                    showToast('导入完成：' + (parts.join('，') || '无变化'), 'success');
                    if (status) status.textContent = parts.join('，') || '导入完成';
                    if (r.skippedDetails && r.skippedDetails.length) {
                        console.warn('[item-import] 跳过详情：', r.skippedDetails);
                    }
                    await loadMenu();
                    if (currentItemCatId) {
                        renderItemTree();
                        await loadItemList(currentItemCatId);
                    } else {
                        await loadItemTree();
                    }
                } catch (err) {
                    console.error('[item-import] 解析异常：', err);
                    showToast('解析失败：' + err.message, 'error');
                    if (status) status.textContent = '';
                } finally {
                    e.target.value = '';
                }
            };
            reader.onerror = () => {
                showToast('读取文件失败', 'error');
                if (status) status.textContent = '';
                e.target.value = '';
            };
            reader.readAsArrayBuffer(file);
        }

        async function downloadItemTemplate() {
            if (typeof XLSX === 'undefined') {
                showToast('SheetJS 未加载，无法生成模板', 'error');
                return;
            }
            try {
                const headerRow = ['分类名称', '提示词名称', '提示词内容', '描述', '排序', '敏感度'];
                const exampleRows = [
                    ['人物', '示例：年轻女性', 'a young woman, detailed face, natural lighting', '示例描述，可删除本行', 0, 'nsfw'],
                    ['场景', '示例：咖啡厅', 'in a coffee shop, warm light, indoor', '示例描述，可删除本行', 0, 'sfw'],
                ];
                const ws1 = XLSX.utils.aoa_to_sheet([headerRow, ...exampleRows]);
                ws1['!cols'] = [
                    { wch: 18 }, { wch: 22 }, { wch: 50 }, { wch: 30 }, { wch: 8 }, { wch: 10 },
                ];

                const catResp = await api.promptMenu.list();
                const catRows = [['现有分类名（导入时若不存在会自动创建为根级分类）']];
                if (catResp && catResp.ok && Array.isArray(catResp.items)) {
                    catResp.items
                        .slice()
                        .sort((a, b) => String(a.category_name).localeCompare(String(b.category_name), 'zh'))
                        .forEach(c => catRows.push([c.category_name]));
                }
                const ws2 = XLSX.utils.aoa_to_sheet(catRows);
                ws2['!cols'] = [{ wch: 40 }];

                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws1, '提示词');
                XLSX.utils.book_append_sheet(wb, ws2, '分类参考');
                XLSX.writeFile(wb, 'prompt_items_template.xlsx');
                showToast('模板已下载', 'success');
            } catch (e) {
                console.error('[item-template] 生成失败：', e);
                showToast('生成模板失败：' + e.message, 'error');
            }
        }

        // 初次加载
        loadItemTree();
    }
    // ===== 场景模板子页面（阶段 2）=====
    // 复制自 prompt-gen.js:3291-3776；删除 cfgModal 依赖、改用共享 state；
    // cfg* 前缀的 DOM id → setScene* 避免与原弹框同屏时冲突。
    // 内部子弹框（编辑、提示词 picker）保留为独立 overlay（z-index 10000/10001）。
    function renderSubModuleScene(container) {
        container.innerHTML = '';
        const root = document.createElement('div');
        root.style.cssText = 'display:flex; flex-direction:column; height:100%; background:#ffffff;';

        // 顶部 header（标题 + 总数 + 启用数 + 刷新按钮）
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 18px; border-bottom:1px solid #e5e7eb; background:#f9fafb; display:flex; align-items:center; gap:12px; flex-shrink:0;';
        header.innerHTML = `
            <div style="font-size:13px;color:#374151;flex:1;">
                场景模板：md 导入的 <span id="setSceneCount" style="font-weight:600;color:#6366f1;">0</span> 个预设场景，可启用/禁用、编辑内容或删除
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
                <div style="font-size:12px;color:#6b7280;">
                    <span id="setSceneEnabledCount" style="color:#059669;font-weight:600;">0</span> 已启用
                </div>
                <button id="setSceneRefreshBtn" class="btn btn-sm" type="button" style="font-size:11px;padding:4px 10px;" title="强制从主进程重新拉取数据"><i class="fa-solid fa-rotate"></i> 刷新</button>
            </div>
        `;
        root.appendChild(header);

        // 列表容器
        const listWrap = document.createElement('div');
        listWrap.id = 'setSceneList';
        listWrap.style.cssText = 'flex:1; overflow-y:auto; padding:14px 18px;';
        root.appendChild(listWrap);

        container.appendChild(root);

        // 刷新按钮
        header.querySelector('#setSceneRefreshBtn').addEventListener('click', () => {
            _sceneLoaded = false;
            renderScenePaneLocal(true);
        });

        // ---- 加载 / 渲染 ----
        async function renderScenePaneLocal(force) {
            if (!force && _sceneLoaded) {
                _renderSceneList(listWrap, _sceneTemplates);
                return;
            }
            listWrap.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
            if (!api.sceneTemplateList) {
                listWrap.innerHTML = '<div style="color:#dc2626;text-align:center;padding:40px 0;font-size:13px;">场景模板 API 未暴露</div>';
                return;
            }
            const r = await api.sceneTemplateList();
            if (!r || !r.ok) {
                listWrap.innerHTML = '<div style="color:#dc2626;text-align:center;padding:40px 0;font-size:13px;">加载失败：' + esc((r && r.error) || '未知') + '</div>';
                return;
            }
            _sceneTemplates = r.rows || [];
            _sceneLoaded = true;
            _renderSceneList(listWrap, _sceneTemplates);
        }

        function _renderSceneList(host, rows) {
            const totalEl = document.getElementById('setSceneCount');
            const enabledEl = document.getElementById('setSceneEnabledCount');
            if (totalEl) totalEl.textContent = String(rows.length);
            if (enabledEl) enabledEl.textContent = String(rows.filter(r => r.enabled).length);
            if (!rows.length) {
                host.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:40px 0;font-size:13px;">暂无场景模板</div>';
                return;
            }
            host.innerHTML = '';
            for (const t of rows) {
                const itemIds = Array.isArray(t.item_ids) ? t.item_ids : [];
                const descPreview = (t.description || '').split(String.fromCharCode(10))[0].slice(0, 80);
                const card = document.createElement('div');
                card.style.cssText = `padding:12px 14px;margin-bottom:10px;border-radius:8px;background:${t.enabled ? '#fff' : '#f9fafb'};border:1px solid #e5e7eb;opacity:${t.enabled ? '1' : '0.7'};display:flex;align-items:flex-start;gap:12px;transition:all 0.1s;`;
                card.innerHTML = `
                    <label style="display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;margin-top:2px;" title="${t.enabled ? '已启用，点击禁用' : '已禁用，点击启用'}">
                        <input type="checkbox" class="setSceneToggle" ${t.enabled ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:#6366f1;">
                    </label>
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                            <span style="font-size:13px;font-weight:600;color:#1f2937;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
                            <span style="font-size:10px;color:#6b7280;background:#f3f4f6;padding:1px 6px;border-radius:3px;flex-shrink:0;">${esc(t.source || 'manual')}</span>
                            <span style="font-size:10px;color:#9ca3af;flex-shrink:0;">${itemIds.length} 项</span>
                        </div>
                        <div style="font-size:11px;color:#6b7280;line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${esc(descPreview)}${(t.description || '').length > 80 ? '...' : ''}</div>
                    </div>
                    <div style="display:flex;gap:4px;flex-shrink:0;">
                        <button class="setSceneEdit btn btn-sm" style="background:#eef2ff;color:#6366f1;border:1px solid #c7d2fe;font-size:11px;padding:4px 10px;" title="编辑"><i class="fa-solid fa-pen"></i></button>
                        <button class="setSceneDel btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-size:11px;padding:4px 10px;" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                `;
                // 启用切换
                card.querySelector('.setSceneToggle').addEventListener('change', async (e) => {
                    const enabled = e.target.checked;
                    const r = await api.sceneTemplateToggleEnabled({ id: t.id, enabled });
                    if (r && r.ok) {
                        t.enabled = r.enabled;
                        _renderSceneList(host, _sceneTemplates);
                        showToast(t.enabled ? '已启用' : '已禁用', 'success');
                    } else {
                        e.target.checked = !enabled;
                        showToast('操作失败：' + ((r && r.error) || '未知'), 'error');
                    }
                });
                // 编辑
                card.querySelector('.setSceneEdit').addEventListener('click', () => editSceneTemplateInline(t, host));
                // 删除
                card.querySelector('.setSceneDel').addEventListener('click', async () => {
                    if (!confirm(`确认删除场景模板「${t.name}」？此操作不可恢复。`)) return;
                    const r = await api.sceneTemplateDelete({ id: t.id });
                    if (r && r.ok) {
                        _sceneTemplates = _sceneTemplates.filter(x => x.id !== t.id);
                        _renderSceneList(host, _sceneTemplates);
                        showToast('已删除', 'success');
                    } else {
                        showToast('删除失败：' + ((r && r.error) || '未知'), 'error');
                    }
                });
                host.appendChild(card);
            }
        }

        // ---- 提示词 picker（独立 overlay，z-index 10001）----
        // 3 列：分类树 | items 列表 | 已选 chips；顶部跨分类搜索
        async function pickSceneItemsInline(initialIds, onConfirm) {
            const old = document.getElementById('setScenePickerModal');
            if (old) old.remove();

            const [catResp, itemResp] = await Promise.all([
                api.promptMenu.list(),
                api.promptItems.listAll(),
            ]);
            if (!catResp || !catResp.ok) { showToast('分类加载失败', 'error'); return; }
            if (!itemResp || !itemResp.ok) { showToast('提示词加载失败', 'error'); return; }

            const allCats = (catResp.items || catResp.menu || []).filter(c => c && c.id != null);
            const allItems = (itemResp.items || []);

            const itemsByCat = new Map();
            for (const it of allItems) {
                const cid = it.category_id;
                if (!itemsByCat.has(cid)) itemsByCat.set(cid, []);
                itemsByCat.get(cid).push(it);
            }
            const childrenOf = (pid) => allCats.filter(c => (c.parent_id || 0) === (pid || 0))
                .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);

            const overlay = document.createElement('div');
            overlay.id = 'setScenePickerModal';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10001;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:#fff;border-radius:10px;width:880px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
                    <div style="padding:12px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:10px;background:#f9fafb;">
                        <span style="font-size:14px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-list-check" style="color:#6366f1;margin-right:6px;"></i>选择提示词</span>
                        <input id="setScenePickerSearch" type="text" placeholder="搜索提示词名称（跨分类）..." style="flex:1;padding:6px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;margin-left:10px;">
                        <span id="setScenePickerCount" style="font-size:12px;color:#059669;font-weight:600;">已选 0 项</span>
                        <button id="setScenePickerClear" class="btn btn-sm" style="font-size:11px;padding:3px 8px;" title="清空已选"><i class="fa-solid fa-eraser"></i> 清空</button>
                        <button id="setScenePickerClose" style="background:transparent;border:none;cursor:pointer;color:#6b7280;font-size:16px;margin-left:4px;"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div style="display:flex;flex:1;min-height:0;overflow:hidden;">
                        <div id="setScenePickerTree" style="width:220px;border-right:1px solid #e5e7eb;overflow-y:auto;padding:8px 6px;background:#fafafa;font-size:12px;"></div>
                        <div id="setScenePickerItems" style="flex:1;overflow-y:auto;padding:10px 14px;background:#fff;"></div>
                        <div style="width:220px;border-left:1px solid #e5e7eb;display:flex;flex-direction:column;background:#fafafa;">
                            <div style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;color:#374151;background:#fff;">已选提示词</div>
                            <div id="setScenePickerSelected" style="flex:1;overflow-y:auto;padding:8px 10px;"></div>
                        </div>
                    </div>
                    <div style="padding:10px 18px;border-top:1px solid #e5e7eb;background:#fafafa;display:flex;justify-content:flex-end;gap:8px;">
                        <button id="setScenePickerCancel" class="btn btn-sm">取消</button>
                        <button id="setScenePickerConfirm" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-check"></i> 确定</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const state = {
                selectedIds: new Set((initialIds || []).map(x => Number(x)).filter(x => x > 0)),
                currentCatId: null,
                searchTerm: '',
            };

            function renderTree() {
                const host = document.getElementById('setScenePickerTree');
                if (!host) return;
                host.innerHTML = '';
                const allLi = document.createElement('div');
                allLi.style.cssText = `padding:5px 8px;margin-bottom:4px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;color:${state.currentCatId === null && !state.searchTerm ? '#6366f1' : '#1f2937'};background:${state.currentCatId === null && !state.searchTerm ? '#eef2ff' : 'transparent'};`;
                allLi.innerHTML = '<i class="fa-solid fa-layer-group" style="margin-right:5px;font-size:10px;"></i>全部分类';
                allLi.addEventListener('click', () => {
                    state.currentCatId = null; state.searchTerm = '';
                    document.getElementById('setScenePickerSearch').value = '';
                    renderTree(); renderItems();
                });
                host.appendChild(allLi);

                const l1 = childrenOf(0);
                for (const cat of l1) renderTreeNode(host, cat, 0);
                if (l1.length === 0) {
                    host.innerHTML += '<div style="color:#9ca3af;font-size:11px;padding:6px 8px;">暂无分类</div>';
                }
            }

            function renderTreeNode(parent, cat, depth) {
                const isLeaf = childrenOf(cat.id).length === 0;
                const isSel = state.currentCatId === cat.id;
                const node = document.createElement('div');
                node.style.cssText = `padding:4px ${8 + depth * 12}px;margin-bottom:2px;border-radius:4px;cursor:pointer;font-size:12px;color:${isSel ? '#6366f1' : '#374151'};background:${isSel ? '#eef2ff' : 'transparent'};font-weight:${depth === 0 ? '600' : '400'};`;
                const icon = depth === 0 ? 'fa-folder-tree' : depth === 1 ? 'fa-folder' : 'fa-tag';
                const itemCount = (itemsByCat.get(cat.id) || []).length;
                node.innerHTML = `<i class="fa-solid ${icon}" style="margin-right:5px;font-size:10px;color:${isSel ? '#6366f1' : '#9ca3af'};"></i>${escapeHtml(cat.category_name || cat.name || '#' + cat.id)}<span style="color:#9ca3af;margin-left:4px;font-size:10px;">(${itemCount})</span>`;
                if (isLeaf) {
                    node.addEventListener('click', () => { state.currentCatId = cat.id; renderTree(); renderItems(); });
                } else {
                    let expanded = depth < 1;
                    if (expanded) {
                        const subWrap = document.createElement('div');
                        parent.appendChild(node);
                        parent.appendChild(subWrap);
                        for (const child of childrenOf(cat.id)) renderTreeNode(subWrap, child, depth + 1);
                    }
                    node.addEventListener('click', () => {
                        if (!node._expanded) {
                            node._expanded = true;
                            const subWrap = document.createElement('div');
                            subWrap.className = 'set-scene-picker-subwrap';
                            node.after(subWrap);
                            for (const child of childrenOf(cat.id)) renderTreeNode(subWrap, child, depth + 1);
                        } else {
                            const sub = node.nextElementSibling;
                            if (sub && sub.className === 'set-scene-picker-subwrap') sub.remove();
                            node._expanded = false;
                        }
                    });
                }
                parent.appendChild(node);
            }

            function renderItems() {
                const host = document.getElementById('setScenePickerItems');
                if (!host) return;
                host.innerHTML = '';

                let items;
                if (state.searchTerm) {
                    const term = state.searchTerm.toLowerCase();
                    items = allItems.filter(it => (it.name || '').toLowerCase().includes(term));
                    if (items.length > 200) items = items.slice(0, 200);
                } else if (state.currentCatId != null) {
                    items = itemsByCat.get(state.currentCatId) || [];
                } else {
                    const l1Ids = allCats.filter(c => (c.parent_id || 0) === 0).map(c => c.id);
                    const seen = new Set();
                    items = [];
                    for (const id of l1Ids) {
                        for (const it of (itemsByCat.get(id) || [])) {
                            if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
                        }
                    }
                }

                if (!items.length) {
                    host.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:20px;text-align:center;">' + (state.searchTerm ? '无匹配结果' : '该分类下暂无提示词') + '</div>';
                    return;
                }

                for (const it of items) {
                    const isSel = state.selectedIds.has(Number(it.id));
                    const row = document.createElement('label');
                    row.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:7px 8px;margin-bottom:3px;border-radius:5px;cursor:pointer;background:${isSel ? '#eef2ff' : 'transparent'};border:1px solid ${isSel ? '#c7d2fe' : 'transparent'};font-size:12px;transition:background 0.1s;`;
                    row.innerHTML = `
                        <input type="checkbox" ${isSel ? 'checked' : ''} style="width:14px;height:14px;cursor:pointer;accent-color:#6366f1;margin-top:2px;flex-shrink:0;">
                        <div style="flex:1;min-width:0;">
                            <div style="color:#1f2937;font-weight:${isSel ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(it.name || '')}</div>
                            ${it.category_name ? `<div style="color:#9ca3af;font-size:10px;margin-top:1px;">${escapeHtml(it.category_name)}</div>` : ''}
                        </div>
                    `;
                    row.addEventListener('click', (e) => {
                        if (e.target.tagName !== 'INPUT') {
                            const cb = row.querySelector('input[type=checkbox]');
                            cb.checked = !cb.checked;
                        }
                        toggleSelect(Number(it.id), row.querySelector('input[type=checkbox]').checked);
                    });
                    host.appendChild(row);
                }
            }

            function renderSelected() {
                const host = document.getElementById('setScenePickerSelected');
                const countEl = document.getElementById('setScenePickerCount');
                if (countEl) countEl.textContent = '已选 ' + state.selectedIds.size + ' 项';
                if (!host) return;
                if (state.selectedIds.size === 0) {
                    host.innerHTML = '<div style="color:#9ca3af;font-size:11px;padding:12px;text-align:center;">从中间或左侧勾选提示词</div>';
                    return;
                }
                const itemMap = new Map(allItems.map(it => [Number(it.id), it]));
                const selected = Array.from(state.selectedIds).map(id => {
                    const it = itemMap.get(id);
                    return { id, name: it ? (it.name + (it.category_name ? '  ·  ' + it.category_name : '')) : ('#' + id + ' (已删除)') };
                }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
                host.innerHTML = '';
                for (const s of selected) {
                    const chip = document.createElement('div');
                    chip.style.cssText = 'display:flex;align-items:flex-start;gap:4px;padding:4px 6px;margin-bottom:4px;border-radius:4px;background:#eef2ff;border:1px solid #c7d2fe;font-size:11px;line-height:1.4;';
                    chip.innerHTML = `<span style="flex:1;color:#1f2937;word-break:break-all;">${escapeHtml(s.name)}</span><button class="set-scene-picker-remove" data-id="${s.id}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:0 2px;font-size:12px;flex-shrink:0;" title="移除"><i class="fa-solid fa-xmark"></i></button>`;
                    host.appendChild(chip);
                }
                host.querySelectorAll('.set-scene-picker-remove').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const id = Number(btn.getAttribute('data-id'));
                        toggleSelect(id, false);
                    });
                });
            }

            function toggleSelect(id, checked) {
                if (checked) state.selectedIds.add(id);
                else state.selectedIds.delete(id);
                renderSelected();
                renderItems();
            }

            document.getElementById('setScenePickerSearch').addEventListener('input', (e) => {
                state.searchTerm = e.target.value;
                renderItems();
            });
            document.getElementById('setScenePickerClear').addEventListener('click', () => {
                state.selectedIds.clear();
                renderSelected();
                renderItems();
            });
            const cancel = () => overlay.remove();
            document.getElementById('setScenePickerClose').addEventListener('click', cancel);
            document.getElementById('setScenePickerCancel').addEventListener('click', cancel);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
            document.getElementById('setScenePickerConfirm').addEventListener('click', () => {
                const ids = Array.from(state.selectedIds);
                try { onConfirm && onConfirm(ids); } catch (e) { console.warn('[pickSceneItemsInline] onConfirm err:', e); }
                cancel();
            });

            renderTree();
            renderItems();
            renderSelected();
        }

        // ---- 编辑场景模板（独立 overlay，z-index 10000）----
        function editSceneTemplateInline(t, host) {
            const old = document.getElementById('setSceneEditModal');
            if (old) old.remove();
            const overlay = document.createElement('div');
            overlay.id = 'setSceneEditModal';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center;';
            const initialIds = (t.item_ids || []).map(x => Number(x)).filter(x => x > 0);
            const state = { selectedItemIds: new Set(initialIds), itemMeta: new Map() };
            overlay.innerHTML = `
                <div style="background:#fff;border-radius:10px;width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.3);font-family:system-ui,-apple-system,sans-serif;overflow:hidden;">
                    <div style="padding:12px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;background:#f9fafb;">
                        <span style="font-size:14px;font-weight:600;color:#1f2937;"><i class="fa-solid fa-pen" style="color:#6366f1;margin-right:6px;"></i>编辑场景模板</span>
                        <button id="setSceneEditClose" style="margin-left:auto;background:transparent;border:none;cursor:pointer;color:#6b7280;font-size:16px;"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div style="padding:16px 18px;overflow-y:auto;flex:1;">
                        <div style="margin-bottom:12px;">
                            <label style="display:block;font-size:12px;font-weight:500;color:#374151;margin-bottom:4px;">名称</label>
                            <input id="setSceneEditName" type="text" value="${esc(t.name)}" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:inherit;">
                        </div>
                        <div style="margin-bottom:12px;">
                            <label style="display:block;font-size:12px;font-weight:500;color:#374151;margin-bottom:4px;">描述 / 提示词参考文本</label>
                            <textarea id="setSceneEditDesc" rows="6" style="width:100%;padding:7px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:5px;box-sizing:border-box;font-family:'Menlo','Consolas',monospace;resize:vertical;">${esc(t.description || '')}</textarea>
                        </div>
                        <div style="margin-bottom:8px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                                <label style="font-size:12px;font-weight:500;color:#374151;">引用的提示词 <span id="setSceneEditItemCount" style="color:#6366f1;font-weight:600;">(${initialIds.length})</span></label>
                                <button id="setScenePickBtn" class="btn btn-sm" type="button" style="font-size:11px;padding:3px 8px;"><i class="fa-solid fa-list-check"></i> 选择提示词...</button>
                            </div>
                            <div id="setSceneEditItemChips" style="min-height:40px;max-height:140px;overflow-y:auto;padding:6px 8px;border:1px solid #d1d5db;border-radius:5px;background:#fafafa;font-size:11px;line-height:1.5;"></div>
                            <div id="setSceneEditItemLoading" style="font-size:11px;color:#6b7280;margin-top:3px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在加载已选项...</div>
                        </div>
                    </div>
                    <div style="padding:10px 18px;border-top:1px solid #e5e7eb;background:#fafafa;display:flex;justify-content:flex-end;gap:8px;">
                        <button id="setSceneEditCancel" class="btn btn-sm">取消</button>
                        <button id="setSceneEditSave" class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            function renderChips() {
                const chipsHost = document.getElementById('setSceneEditItemChips');
                const cnt = document.getElementById('setSceneEditItemCount');
                if (cnt) cnt.textContent = '(' + state.selectedItemIds.size + ')';
                if (!chipsHost) return;
                if (state.selectedItemIds.size === 0) {
                    chipsHost.innerHTML = '<div style="color:#9ca3af;font-size:11px;text-align:center;padding:8px 0;">还没选，点上方「选择提示词」按钮</div>';
                    return;
                }
                const sorted = Array.from(state.selectedItemIds).map(id => {
                    const meta = state.itemMeta.get(id);
                    return { id, name: meta ? meta.name : '#' + id + ' (加载中...)', cat: meta ? meta.category_name : '' };
                }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
                chipsHost.innerHTML = '';
                for (const s of sorted) {
                    const chip = document.createElement('div');
                    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 6px 3px 8px;margin:2px;border-radius:4px;background:#eef2ff;border:1px solid #c7d2fe;font-size:11px;max-width:100%;';
                    chip.innerHTML = `<span style="color:#1f2937;word-break:break-all;flex:1;"><span style="font-weight:500;">${escapeHtml(s.name)}</span>${s.cat ? ` <span style="color:#9ca3af;font-size:10px;">· ${escapeHtml(s.cat)}</span>` : ''}</span><button class="set-scene-chip-remove" data-id="${s.id}" style="background:transparent;border:none;cursor:pointer;color:#6366f1;padding:0 2px;font-size:11px;line-height:1;flex-shrink:0;" title="移除"><i class="fa-solid fa-xmark"></i></button>`;
                    chipsHost.appendChild(chip);
                }
                chipsHost.querySelectorAll('.set-scene-chip-remove').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        state.selectedItemIds.delete(Number(btn.getAttribute('data-id')));
                        renderChips();
                    });
                });
            }

            // 初次加载：批量回显已选 prompt 名称
            (async () => {
                const loadingEl = document.getElementById('setSceneEditItemLoading');
                try {
                    if (initialIds.length > 0 && api.promptItems && api.promptItems.getByIds) {
                        const r = await api.promptItems.getByIds(initialIds);
                        if (r && r.ok && r.items) {
                            for (const it of r.items) {
                                state.itemMeta.set(Number(it.id), { name: it.name || '', category_name: it.category_name || '' });
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[editSceneTemplateInline] getByIds err:', e);
                } finally {
                    if (loadingEl) loadingEl.style.display = 'none';
                    renderChips();
                }
            })();

            // 打开 picker
            document.getElementById('setScenePickBtn').addEventListener('click', async () => {
                await pickSceneItemsInline(Array.from(state.selectedItemIds), (newIds) => {
                    state.selectedItemIds = new Set(newIds.map(x => Number(x)).filter(x => x > 0));
                    const missing = Array.from(state.selectedItemIds).filter(id => !state.itemMeta.has(id));
                    if (missing.length > 0 && api.promptItems && api.promptItems.getByIds) {
                        api.promptItems.getByIds(missing).then(r => {
                            if (r && r.ok && r.items) {
                                for (const it of r.items) {
                                    state.itemMeta.set(Number(it.id), { name: it.name || '', category_name: it.category_name || '' });
                                }
                                renderChips();
                            }
                        });
                    }
                    renderChips();
                });
            });

            const close = () => overlay.remove();
            document.getElementById('setSceneEditClose').addEventListener('click', close);
            document.getElementById('setSceneEditCancel').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            document.getElementById('setSceneEditSave').addEventListener('click', async () => {
                const name = document.getElementById('setSceneEditName').value.trim();
                const description = document.getElementById('setSceneEditDesc').value;
                if (!name) { showToast('名称不能为空', 'error'); return; }
                const item_ids = Array.from(state.selectedItemIds);
                const r = await api.sceneTemplateUpdate({ id: t.id, name, description, item_ids });
                if (r && r.ok) {
                    const idx = _sceneTemplates.findIndex(x => x.id === t.id);
                    if (idx >= 0) {
                        _sceneTemplates[idx] = { ..._sceneTemplates[idx], name, description, item_ids };
                    }
                    _renderSceneList(host, _sceneTemplates);
                    showToast('已保存', 'success');
                    close();
                } else {
                    showToast('保存失败：' + ((r && r.error) || '未知'), 'error');
                }
            });
        }

        // 初次渲染
        renderScenePaneLocal(false);
    }

    // ===== 关联管理子页面（原 prompt-gen.js 顶部按钮 + 全屏 overlay 迁入）=====
    // 直接调用 window.openAssociationManager({ container })，把整张关联管理表内联到子页面内容区
    function renderSubModuleAssoc(container) {
        const fn = window.openAssociationManager;
        if (typeof fn !== 'function') {
            container.innerHTML = '<div style="color:#dc2626; padding:20px;">openAssociationManager 未暴露（请确认 prompt-gen.js 已加载）</div>';
            return;
        }
        fn({ container });
    }

    // ========== 工具 ==========
    function createCard(title, desc) {
        const card = document.createElement('div');
        card.style.cssText = 'background:#ffffff; border-radius:10px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.06); max-width:920px;';
        card.innerHTML = `
            <div style="margin-bottom:18px;">
                <div style="font-size:16px; font-weight:600; color:#1f2937;"><i class="fa-solid fa-folder-tree" style="color:#6366f1;"></i> ${escapeHtml(title)}</div>
                ${desc ? '<div style="font-size:12px; color:#6b7280; margin-top:6px; line-height:1.6;">' + escapeHtml(desc) + '</div>' : ''}
            </div>
        `;
        return card;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    function escapeAttr(s) { return escapeHtml(s); }

    function showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        // 兜底：用 settings 页内的简易 toast
        let c = document.getElementById('setToastContainer');
        if (!c) {
            c = document.createElement('div');
            c.id = 'setToastContainer';
            c.style.cssText = 'position:fixed; top:80px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:8px;';
            document.body.appendChild(c);
        }
        const t = document.createElement('div');
        const bg = type === 'error' ? '#fee2e2' : type === 'success' ? '#dcfce7' : '#e0e7ff';
        const fg = type === 'error' ? '#dc2626' : type === 'success' ? '#059669' : '#4338ca';
        const bd = type === 'error' ? '#fecaca' : type === 'success' ? '#bbf7d0' : '#c7d2fe';
        t.style.cssText = `padding:10px 16px; background:${bg}; color:${fg}; border:1px solid ${bd}; border-radius:6px; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,0.08);`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; }, 2400);
        setTimeout(() => t.remove(), 2800);
    }

    // ========== 暴露 ==========
    window.settings = { open, close };
})();
