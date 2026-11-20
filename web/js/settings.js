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
        // D-NAVBAR：通知 nav active 态同步
        try {
            window.dispatchEvent(new CustomEvent('settings:opened'));
        } catch (e) {}
    }

    function close() {
        const page = document.getElementById('settingsPage');
        if (page) page.hidden = true;
        // D-NAVBAR：只恢复 main，不再碰 header（header 全平台持久可见）
        const main = document.querySelector('main');
        if (main) main.style.display = '';
        // D-NAVBAR：通知 nav active 态同步
        try {
            window.dispatchEvent(new CustomEvent('settings:closed'));
        } catch (e) {}
    }

    // D-NAVBAR：暴露 isOpen() 给 switchMainView 用
    function isOpen() {
        const page = document.getElementById('settingsPage');
        return !!(page && !page.hidden);
    }

    // ========== tab 定义 ==========
    const TAB_DEFS = [
        { id: 'resources', icon: 'fa-folder-tree',   label: '资源管理' },
        { id: 'loras',     icon: 'fa-puzzle-piece',  label: 'LORA 库管理' },
        { id: 'comfyui',   icon: 'fa-image',         label: 'ComfyUI 服务' },
        { id: 'llm',       icon: 'fa-microchip',     label: 'LLM 服务' },
        { id: 'ainovel',   icon: 'fa-book',          label: 'AI 小说' },
        { id: 'nas',       icon: 'fa-hard-drive',    label: 'NAS 地址' },
        { id: 'systeminfo', icon: 'fa-circle-info',  label: '系统信息' },
        { id: 'envcheck',   icon: 'fa-shield-halved', label: '环境检查' },
    ];

    function tabDef(id) { return TAB_DEFS.find(t => t.id === id) || TAB_DEFS[0]; }

    // ========== DOM ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'settingsPage';
        // DWP 视觉基线：class-based 外层骨架（与工作台三栏对齐），内联控件/表单保持原状。
        page.className = 'settings-page';
        page.hidden = true;
        page.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
        page.innerHTML = `
            <!-- 顶部 bar -->
            <div class="set-topbar">
                <h2 id="setHeaderTitle" class="set-topbar-title"><i class="fa-solid fa-gear" style="color:#6366f1;"></i> 设置</h2>
                <span id="setHeaderSub" class="set-topbar-sub"></span>
                <span class="set-topbar-spacer"></span>
                <span class="set-topbar-actions"></span>
            </div>

            <!-- 两列主体 -->
            <div class="set-body">
                <!-- 左：菜单 -->
                <div id="settingsMenu" class="set-menu"></div>
                <!-- 右：内容 -->
                <div id="settingsContent" class="set-content"></div>
            </div>
        `;
        document.body.appendChild(page);
    }

    function showPage() {
        const page = document.getElementById('settingsPage');
        if (page) page.hidden = false;
        // D-NAVBAR：main 仍然隐藏（settings 是全屏 overlay 覆盖 main），但 header 保持可见
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
    }

    // ========== 左菜单渲染 ==========
    function renderMenu() {
        const menu = document.getElementById('settingsMenu');
        if (!menu) return;
        menu.innerHTML = '';
        for (const t of TAB_DEFS) {
            const isActive = t.id === _currentTab;
            const row = document.createElement('div');
            row.className = 'set-menu-item' + (isActive ? ' active' : '');
            row.innerHTML = '<i class="fa-solid ' + t.icon + '"></i><span>' + escapeHtml(t.label) + '</span>';
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
        loras: renderLorasPane,
        comfyui: renderComfyuiPane,
        llm: renderLlmPane,
        ainovel: renderAiNovelPane,
        nas: renderNasPane,
        systeminfo: renderSysteminfoPane,
        envcheck: renderEnvCheckPane,
    };

    // ===== LORA 库管理顶级 tab（D-LAYOUT：原 fullscreen overlay lorasPage 嵌入到 settings content 区）=====
    // 与资源管理 / ComfyUI / LLM 服务 平级
    async function renderLorasPane(container) {
        // settingsContent 是 flex:1; overflow:auto（line 135），无固定高度。
        // Lora root 要求 height:100% + min-height:0 才能让侧栏 + grid 正确铺满 + grid 自带 overflow-y:auto 滚动。
        // setLorasWrap 是真正的内容区域：position:absolute 占满整个 settingsContent（避开灰色外层）。
        // 10px 留白交给 lorasModuleRoot（外层大盒子）处理，避免 setLorasWrap 出现灰色空隙。
        const wrap = document.createElement('div');
        wrap.id = 'setLorasWrap';
        wrap.style.cssText = 'position:absolute; top:0; left:0; right:0; bottom:0; display:flex; flex-direction:column; min-height:0; background:#ffffff;';
        container.style.position = 'relative';
        container.appendChild(wrap);

        if (window.lorasModule && typeof window.lorasModule.renderInto === 'function') {
            try {
                await window.lorasModule.renderInto(wrap);
                return;
            } catch (e) {
                console.error('[settings] lorasModule.renderInto 失败:', e);
                wrap.innerHTML = `<div style="padding:60px 20px; text-align:center; color:#dc2626; font-size:13px;">加载 Lora 模块失败，请刷新页面或重启应用后重试。</div>`;
                return;
            }
        }
        // 兜底：loras.js 未加载（用户文案不暴露源文件名，仅记录到 console 供排查）
        console.warn('[settings] LORA 模块未加载：window.lorasModule.renderInto 不可用');
        wrap.innerHTML = `<div style="padding:60px 20px; text-align:center; color:#9ca3af; font-size:13px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:48px; color:#e5e7eb; display:block; margin-bottom:12px;"></i>
            Lora 模块暂不可用，请刷新页面或重启应用后重试。
        </div>`;
    }

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
            if (src.type === 'nas') _wireNasPreview(row, fields);

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
                if (cur.type === 'nas') _wireNasPreview(row, fields);
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
                <label style="display:flex; flex-direction:column; gap:4px; font-size:12px; color:#6b7280; margin-bottom:8px;">路径（完整 URL 或相对路径；相对路径会自动用「NAS 地址」拼接）
                    <input class="rs-path" type="text" value="${escapeAttr(src.path || '')}" placeholder="/home/MyFolder/003 AI出图/" style="padding:6px 10px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                </label>
                <div class="rs-nas-preview" style="font-size:12px; color:#059669; padding:6px 10px; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:6px; margin-bottom:8px; font-family:monospace; word-break:break-all;">
                    <i class="fa-solid fa-link"></i> 实际 URL: <span class="rs-nas-preview-url">—</span>
                </div>
                <div class="rs-nas-warn" style="display:none; font-size:12px; color:#b91c1c; padding:6px 10px; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; margin-bottom:8px; align-items:center; gap:6px;">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <span class="rs-nas-warn-text" style="flex:1;"></span>
                    <button type="button" class="rs-nas-warn-goto" style="padding:2px 8px; background:#dc2626; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">前往配置</button>
                </div>
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

    // NAS 路径预览 + 未配置警告。行级异步函数，从 api.resourceStation.nasConfigGet() 拉配置
    // 然后在用户键入时实时拼接预览；不每键调 IPC，仅首次拉一次缓存 cfg。
    async function _wireNasPreview(row, fields) {
        if (!api.resourceStation || typeof api.resourceStation.nasConfigGet !== 'function') return;
        const pathInput = fields.querySelector('.rs-path');
        const previewEl = fields.querySelector('.rs-nas-preview');
        const previewUrlEl = fields.querySelector('.rs-nas-preview-url');
        const warnEl = fields.querySelector('.rs-nas-warn');
        const warnTextEl = fields.querySelector('.rs-nas-warn-text');
        const gotoBtn = fields.querySelector('.rs-nas-warn-goto');
        if (!pathInput || !previewEl || !previewUrlEl || !warnEl || !warnTextEl) return;

        let cfg = null;

        const render = () => {
            const val = (pathInput.value || '').trim();
            if (!val) {
                previewUrlEl.textContent = '（空 — 输入路径以预览实际 URL）';
                previewEl.style.display = 'block';
                warnEl.style.display = 'none';
                return;
            }
            if (/^https?:\/\//i.test(val)) {
                // 完整 URL：直接展示原文
                previewUrlEl.textContent = val;
                previewEl.style.display = 'block';
                warnEl.style.display = 'none';
                return;
            }
            if (cfg && cfg.host) {
                const scheme = cfg.scheme || 'http';
                const port = cfg.port ? ':' + cfg.port : '';
                const auth = cfg.username
                    ? (cfg.username + (cfg.hasPassword ? ':***' : '') + '@')
                    : '';
                let rel = val.replace(/\\/g, '/');
                if (!rel.startsWith('/')) rel = '/' + rel;
                previewUrlEl.textContent = `${scheme}://${auth}${cfg.host}${port}${rel}`;
                previewEl.style.display = 'block';
                warnEl.style.display = 'none';
            } else {
                previewEl.style.display = 'none';
                warnTextEl.textContent = 'NAS 地址未配置。相对路径需要先在【设置 → 资源管理 → NAS 地址】配置 NAS 详情后才能解析。';
                warnEl.style.display = 'flex';
            }
        };

        const reload = async () => {
            try {
                const r = await api.resourceStation.nasConfigGet();
                cfg = (r && r.ok) ? (r.data || null) : null;
            } catch (_) { cfg = null; }
            render();
        };

        if (gotoBtn) {
            gotoBtn.addEventListener('click', () => {
                // 切到资源管理面板并滚动到 NAS 地址设置
                const navBtn = document.querySelector('[data-nav="resources"]') || document.querySelector('[data-nav="settings"]');
                if (navBtn) navBtn.click();
                setTimeout(() => {
                    const target = document.getElementById('setNasHost');
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 250);
            });
        }
        pathInput.addEventListener('input', render);
        await reload();
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

                <label style="font-size:12px; color:#6b7280;">任务并发数</label>
                <input id="setComfyConcurrency" type="number" value="1" min="1" max="8" step="1" style="padding:7px 11px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">
                <span style="font-size:11px; color:#9ca3af; line-height:1.4;">1=串行；&gt;1 并行提交，需显存足够，改后新任务生效</span>
            </div>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding-top:14px; border-top:1px solid #e5e7eb;">
                <span id="setComfyStatusDot" style="width:10px; height:10px; border-radius:50%; background:#6b7280; display:inline-block;"></span>
                <span id="setComfyStatusText" style="font-size:12px; color:#6b7280; flex:1;">未启动</span>
                <button id="setComfyStart" class="btn btn-sm btn-primary" type="button"><i class="fa-solid fa-play"></i> 启动</button>
                <button id="setComfyStop" class="btn btn-sm" type="button" style="background:#dc2626; color:#fff; display:none;"><i class="fa-solid fa-stop"></i> 停止</button>
                <button id="setComfySave" class="btn btn-sm" type="button" style="background:#10b981; color:#fff;"><i class="fa-solid fa-check"></i> 保存配置</button>
                <button id="setComfyOpenOutput" class="btn btn-sm" type="button"><i class="fa-solid fa-folder-tree"></i> 打开输出</button>
            </div>
        `;
        container.appendChild(card);

        if (!api.comfyui) {
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
            card.querySelector('#setComfyConcurrency').value = cfg.concurrency || 1;

            refreshStatus();
        })();

        function readCfgFromForm() {
            return {
                pythonPath: card.querySelector('#setComfyPython').value.trim(),
                comfyDir: card.querySelector('#setComfyDir').value.trim(),
                port: Number(card.querySelector('#setComfyPort').value) || 8188,
                outputDir: card.querySelector('#setComfyOutput').value.trim(),
                concurrency: Math.min(Math.max(Number(card.querySelector('#setComfyConcurrency').value) || 1, 1), 8),
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
            // D-NAVBAR-COMFY：同步刷新顶部导航栏徽章（settings.js 操作不影响事件触发时机）
            if (typeof window.refreshNavComfyStatus === 'function') window.refreshNavComfyStatus();
        });
        card.querySelector('#setComfyStop').addEventListener('click', async () => {
            const r = await api.comfyui.stop();
            if (r && r.ok) showToast('ComfyUI 已停止', 'success');
            else showToast('停止失败：' + (r && r.error), 'error');
            refreshStatus();
            // D-NAVBAR-COMFY：同步刷新顶部导航栏徽章
            if (typeof window.refreshNavComfyStatus === 'function') window.refreshNavComfyStatus();
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

    // ===== 系统信息（D-SYSINFO：读取主进程聚合的硬件 / 环境信息） =====
    // 缓存最近一次拉到的数据，切走 tab 再切回来直接渲染缓存；点「刷新」强制重拉。
    let _systeminfoCache = null;
    let _systeminfoLoading = false;

    function _formatBytes(n) {
        if (n == null || !Number.isFinite(Number(n))) return null;
        const num = Number(n);
        if (num <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let v = num; let i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }
    function _formatUptime(sec) {
        const n = Number(sec);
        if (!Number.isFinite(n) || n < 0) return null;
        const d = Math.floor(n / 86400);
        const h = Math.floor((n % 86400) / 3600);
        const m = Math.floor((n % 3600) / 60);
        const parts = [];
        if (d) parts.push(`${d} 天`);
        if (h) parts.push(`${h} 小时`);
        parts.push(`${m} 分`);
        return parts.join(' ');
    }
    function _valEl(value, mutedFallback) {
        if (value == null || value === '') {
            return `<span class="si-value si-muted">${escapeHtml(mutedFallback || '未安装')}</span>`;
        }
        return `<span class="si-value">${escapeHtml(String(value))}</span>`;
    }
    function _skeletonBar(width) {
        return `<span class="si-skel" style="width:${width || '70%'};"></span>`;
    }
    // CJK 字符宽度 ≈ 1em，ASCII ≈ 0.55em；统一换算成 em 得到稳定列宽
    function _labelWidthEm(labels) {
        let max = 0;
        for (const l of labels) {
            let em = 0;
            for (const ch of String(l)) em += /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(ch) ? 1 : 0.55;
            if (em > max) max = em;
        }
        return Math.max(4, max + 1.2); // 至少 4em，再加 1.2em 留点空隙
    }

    // 全局统一列宽：把页面里所有可能出现的标签都塞进来，取最宽那个。
    // 所有 .si-body 共享同一个 --si-label-w，跨模块的标签左边缘对齐。
    const _SYSINFO_LABEL_W = _labelWidthEm([
        // 操作系统
        '平台', '内核', '架构', '主机名', '运行时长',
        // 处理器
        '型号', '核心数', '主频',
        // 内存
        '已用 / 可用',
        // 开发环境（工具名 + CUDA 子块）
        'Git', 'Python', 'Node', 'npm', 'FFmpeg',
        'CUDA 驱动', 'CUDA 版本', 'nvcc 路径',
        // Electron 运行时
        'Electron', 'Chromium', 'V8',
        // 显卡子卡（保证 GPU 内的 dl/dt/dd 标签也跟其他模块对齐）
        '厂商', '显存', '驱动',
    ]);
    function _row(label, value, mutedFallback) {
        return `<div class="si-row"><span class="si-label">${escapeHtml(label)}</span>${_valEl(value, mutedFallback)}</div>`;
    }
    function _cardHeader(iconCls, title, badge) {
        return `<div class="si-head"><span class="si-head-icon"><i class="fa-solid ${iconCls}"></i></span><span class="si-head-title">${escapeHtml(title)}</span>${badge ? `<span class="si-head-badge">${escapeHtml(badge)}</span>` : ''}</div>`;
    }
    function _openBody(labelWidthEm) {
        return `<div class="si-body" style="--si-label-w:${labelWidthEm.toFixed(2)}em;">`;
    }

    function _memoryBarHtml(memory) {
        const total = Number(memory.totalBytes);
        const used = Number(memory.usedBytes);
        if (!Number.isFinite(total) || total <= 0) return '';
        const pct = Math.max(0, Math.min(100, (used / total) * 100));
        // 颜色：< 70% 绿 / 70-90 黄 / > 90 红
        const color = pct < 70 ? '#22c55e' : pct < 90 ? '#eab308' : '#ef4444';
        return `<div class="si-meter">
            <div class="si-meter-track"><div class="si-meter-fill" style="width:${pct.toFixed(1)}%; background:${color};"></div></div>
            <span class="si-meter-text">${pct.toFixed(1)}%</span>
        </div>`;
    }

    function _gpuItemsHtml(gpus) {
        if (!Array.isArray(gpus) || gpus.length === 0) {
            return `<div class="si-empty"><i class="fa-regular fa-circle-xmark"></i> 未检测到真实显卡</div>`;
        }
        const items = gpus.map(g => {
            const vram = _formatBytes(g.vramBytes);
            return `
                <div class="si-gpu">
                    <div class="si-gpu-head">
                        <i class="fa-solid fa-tv"></i>
                        <span class="si-gpu-name">${escapeHtml(g.model || '未知显卡')}</span>
                    </div>
                    <dl class="si-gpu-grid" style="--si-gpu-label-w:${_SYSINFO_LABEL_W.toFixed(2)}em;">
                        <dt>厂商</dt><dd>${escapeHtml(g.vendor || '未知')}</dd>
                        <dt>显存</dt><dd>${escapeHtml(vram || '未知')}</dd>
                        <dt>驱动</dt><dd>${escapeHtml(g.driverVersion || '未知')}</dd>
                    </dl>
                </div>
            `;
        }).join('');
        return `<div class="si-gpu-list">${items}</div>`;
    }

    function _toolRowHtml(name, t) {
        if (!t) t = {};
        const ok = !!t.available;
        const verText = ok ? (t.version || '已安装') : '未安装';
        const pathTip = t.path ? ` title="${escapeAttr(t.path)}"` : '';
        const pathHtml = t.path ? `<span class="si-tool-path"${pathTip}>${escapeHtml(t.path)}</span>` : '';
        return `
            <div class="si-tool ${ok ? 'ok' : 'no'}">
                <span class="si-dot"></span>
                <span class="si-tool-name">${escapeHtml(name)}</span>
                <span class="si-tool-ver ${ok ? '' : 'si-muted'}">${escapeHtml(verText)}</span>
                ${pathHtml}
            </div>
        `;
    }

    function _buildSkeletonHtml() {
        const sk = (n) => Array.from({ length: n }).map(() =>
            `<div class="si-row"><span class="si-label">${_skeletonBar('50%')}</span>${_skeletonBar('80%')}</div>`
        ).join('');
        const skGpu = `<div class="si-skel-block"><div class="si-gpu"><div class="si-gpu-head">${_skeletonBar('40%')}</div><div class="si-gpu-grid">${_skeletonBar('30%')}${_skeletonBar('50%')}</div></div></div>`;
        const skTools = ['Git', 'Python', 'Node', 'npm', 'FFmpeg'].map(n =>
            `<div class="si-tool"><span class="si-dot"></span><span class="si-tool-name">${escapeHtml(n)}</span>${_skeletonBar('60%')}</div>`
        ).join('');
        return `
            <div class="si-grid">
                <section class="si-card">${_cardHeader('fa-desktop', '操作系统')}<div class="si-body">${sk(5)}</div></section>
                <section class="si-card">${_cardHeader('fa-microchip', '处理器')}<div class="si-body">${sk(3)}</div></section>
                <section class="si-card">${_cardHeader('fa-memory', '内存')}<div class="si-body">${sk(3)}</div></section>
                <section class="si-card">${_cardHeader('fa-tv', '显卡')}<div class="si-body">${skGpu}</div></section>
                <section class="si-card">${_cardHeader('fa-terminal', '开发环境')}<div class="si-body">${skTools}</div></section>
                <section class="si-card">${_cardHeader('fa-window-maximize', 'Electron 运行时')}<div class="si-body">${sk(4)}</div></section>
            </div>
        `;
    }

    function _buildInfoHtml(d) {
        const os = d.os || {};
        const cpu = d.cpu || {};
        const memory = d.memory || {};
        const cuda = d.cuda || {};
        const env = d.env || {};
        const gpuCount = Array.isArray(d.gpus) ? d.gpus.length : 0;

        return `
            <div class="si-grid">
                <section class="si-card">
                    ${_cardHeader('fa-desktop', '操作系统')}
                    ${_openBody(_SYSINFO_LABEL_W)}
                        ${_row('平台', os.distro || (os.platform === 'win32' ? 'Windows' : os.platform === 'darwin' ? 'macOS' : 'Linux'))}
                        ${_row('内核', os.kernel || os.release)}
                        ${_row('架构', os.arch)}
                        ${_row('主机名', os.hostname)}
                        ${_row('运行时长', _formatUptime(os.uptimeSec))}
                    </div>
                </section>

                <section class="si-card">
                    ${_cardHeader('fa-microchip', '处理器')}
                    ${_openBody(_SYSINFO_LABEL_W)}
                        ${_row('型号', cpu.model || cpu.brand)}
                        ${_row('核心数', cpu.cores != null ? `${cpu.cores} 核` : null)}
                        ${_row('主频', cpu.speedMHz ? `${(cpu.speedMHz / 1000).toFixed(2)} GHz` : null)}
                    </div>
                </section>

                <section class="si-card">
                    ${_cardHeader('fa-memory', '内存', memory.totalBytes ? _formatBytes(memory.totalBytes) : null)}
                    ${_openBody(_SYSINFO_LABEL_W)}
                        ${_row('已用 / 可用', `${_formatBytes(memory.usedBytes) || '—'} / ${_formatBytes(memory.freeBytes) || '—'}`)}
                        ${_memoryBarHtml(memory)}
                    </div>
                </section>

                <section class="si-card">
                    ${_cardHeader('fa-tv', '显卡', gpuCount > 0 ? `${gpuCount} 张` : null)}
                    <div class="si-body">${_gpuItemsHtml(d.gpus || [])}</div>
                </section>

                <section class="si-card">
                    ${_cardHeader('fa-terminal', '开发环境')}
                    ${_openBody(_SYSINFO_LABEL_W)}
                        ${_toolRowHtml('Git',    d.tools && d.tools.git)}
                        ${_toolRowHtml('Python', d.tools && d.tools.python)}
                        ${_toolRowHtml('Node',   d.tools && d.tools.node)}
                        ${_toolRowHtml('npm',    d.tools && d.tools.npm)}
                        ${_toolRowHtml('FFmpeg', d.tools && d.tools.ffmpeg)}
                        <div class="si-subgroup">
                            <div class="si-subgroup-title">CUDA / GPU 工具链</div>
                            ${_row('CUDA 驱动', cuda.driverVersion, '不可用')}
                            ${_row('CUDA 版本', cuda.cudaVersion,   '不可用')}
                            ${_row('nvcc 路径', cuda.nvccPath,     '不可用')}
                        </div>
                    </div>
                </section>

                <section class="si-card">
                    ${_cardHeader('fa-window-maximize', 'Electron 运行时')}
                    ${_openBody(_SYSINFO_LABEL_W)}
                        ${_row('Electron', env.electron, '未知')}
                        ${_row('Node',     env.node,     '未知')}
                        ${_row('Chromium', env.chrome,   '未知')}
                        ${_row('V8',       env.v8,       '未知')}
                    </div>
                </section>
            </div>
        `;
    }

    function _mountTopbarRefresh(onClick) {
        const actions = document.querySelector('.set-topbar-actions');
        if (!actions) return null;
        actions.innerHTML = '';
        const btn = document.createElement('button');
        btn.id = 'setSysinfoRefreshBtn';
        btn.className = 'btn btn-sm';
        btn.type = 'button';
        btn.innerHTML = '<i class="fa-solid fa-rotate"></i> 刷新';
        btn.addEventListener('click', onClick);
        actions.appendChild(btn);
        return btn;
    }


    async function renderNasPane(container) {
        const card = document.createElement('div');
        card.className = 'set-card';
        card.innerHTML = `<div class="set-card-head">
    <h3 class="set-card-title"><i class="fa-solid fa-hard-drive" style="color:#6366f1;"></i> NAS 地址</h3>
    <p class="set-card-desc">保存后，资源站添加视频时只需填写真实资源路径（例如 /home/MyFile/.../video.mp4），系统会自动拼上 NAS 协议、地址、端口和账号密码。</p>
</div>
<div style="display:grid; gap:14px; max-width:760px;">
    <div style="display:grid; grid-template-columns:120px 1fr 160px; gap:10px;">
        <label>协议<select id="setNasProtocol" style="width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:6px;"><option value="http">HTTP</option><option value="https">HTTPS</option></select></label>
        <label>IP / 主机名<input id="setNasHost" placeholder="192.168.0.100" style="width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:6px;"></label>
        <label>端口<input id="setNasPort" type="number" min="1" max="65535" placeholder="5005" style="width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:6px;"></label>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <label>账号<input id="setNasUser" autocomplete="off" style="width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:6px;"></label>
        <label>密码<input id="setNasPassword" type="password" autocomplete="new-password" placeholder="" style="width:100%; padding:7px 9px; border:1px solid #d1d5db; border-radius:6px;"></label>
    </div>
    <div style="display:flex; align-items:center; gap:10px; padding-top:14px; border-top:1px dashed #e5e7eb;">
        <span id="setNasStatus" style="font-size:13px; color:#6b7280;"></span>
        <button id="setNasClearCreds" class="btn btn-sm" type="button">清除账号密码</button>
        <button id="setNasSave" class="btn btn-sm btn-primary" style="margin-left:auto;"><i class="fa-solid fa-check"></i> 保存</button>
    </div>
</div>`;
        container.appendChild(card);

        const q = selector => card.querySelector(selector);
        if (!api.resourceStation || typeof api.resourceStation.nasConfigGet !== 'function') {
            q('#setNasStatus').textContent = 'resourceStation API 不可用';
            return;
        }

        const load = async () => {
            const result = await api.resourceStation.nasConfigGet();
            if (!result?.ok) {
                q('#setNasStatus').textContent = '加载失败：' + (result?.error || '未知错误');
                return;
            }
            const cfg = result.data || {};
            q('#setNasProtocol').value = cfg.scheme || 'http';
            q('#setNasHost').value = cfg.host || '';
            q('#setNasPort').value = cfg.port || '';
            q('#setNasUser').value = cfg.username || '';
            q('#setNasPassword').value = '';
            q('#setNasPassword').placeholder = cfg.hasPassword ? '已保存，留空则不修改' : '';
            q('#setNasStatus').textContent = cfg.host
                ? '已配置：' + (cfg.scheme || 'http') + '://' + cfg.host + (cfg.port ? ':' + cfg.port : '')
                : '未配置';
        };
        await load();

        const readPayload = () => ({
            scheme: q('#setNasProtocol').value,
            host: q('#setNasHost').value.trim(),
            port: q('#setNasPort').value,
            username: q('#setNasUser').value.trim(),
            password: q('#setNasPassword').value,
            keepPassword: !q('#setNasPassword').value,
        });

        q('#setNasSave').addEventListener('click', async () => {
            const button = q('#setNasSave');
            button.disabled = true;
            try {
                const result = await api.resourceStation.nasConfigSet(readPayload());
                if (!result?.ok) throw new Error(result?.error || '保存失败');
                q('#setNasPassword').value = '';
                await load();
                showToast('NAS 地址已保存', 'success');
            } catch (error) {
                showToast(error.message, 'error');
            } finally { button.disabled = false; }
        });

        q('#setNasClearCreds').addEventListener('click', async () => {
            const button = q('#setNasClearCreds');
            button.disabled = true;
            try {
                const payload = { ...readPayload(), username: '', password: '', clearCredentials: true, keepPassword: false };
                const result = await api.resourceStation.nasConfigSet(payload);
                if (!result?.ok) throw new Error(result?.error || '清除失败');
                await load();
                showToast('已清除账号密码', 'success');
            } catch (error) {
                showToast(error.message, 'error');
            } finally { button.disabled = false; }
        });
    }

    // ===== 环境检查（系统信息菜单下面）=====
    function renderEnvCheckPane(container) {
        const card = createCard('环境检查', '选择从网盘下载并解压后的 ComfyUI 根目录，软件会自动识别 Python 环境、ComfyUI 核心、插件和模型，确认后写入设置。');
        container.appendChild(card);

        const body = document.createElement('div');
        body.style.cssText = 'display:flex; flex-direction:column; gap:14px; margin-top:14px;';
        card.appendChild(body);

        // 步骤1：选择根目录
        const pickRow = document.createElement('div');
        pickRow.style.cssText = 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
        pickRow.innerHTML = `
            <button id="ecPick" class="btn btn-sm btn-primary" type="button" style="background:#4f46e5;color:#fff;"><i class="fa-solid fa-folder-open"></i> 选择解压根目录</button>
            <input id="ecRoot" type="text" readonly placeholder="例如 D:\\RxAi-ComfyUI（python_embeded 和 ComfyUI 所在目录）" style="flex:1; min-width:240px; padding:7px 11px; background:#f9fafb; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:12px; font-family:monospace;">
        `;
        body.appendChild(pickRow);

        const result = document.createElement('div');
        result.id = 'ecResult';
        body.appendChild(result);

        const apiOk = !!(api.envCheck && typeof api.envCheck.scan === 'function');
        let scanData = null;

        if (!apiOk) {
            result.innerHTML = '<div style="padding:20px; color:#dc2626; font-size:12px;">环境检查接口不可用，请重启应用。</div>';
            return;
        }

        document.getElementById('ecPick').addEventListener('click', async () => {
            const pr = await api.envCheck.pickRoot();
            if (!pr || !pr.ok) { showToast((pr && pr.error) || '选择失败', 'error'); return; }
            if (pr.canceled) return;
            document.getElementById('ecRoot').value = pr.path;
            result.innerHTML = '<div style="padding:20px; color:#6b7280; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在扫描…</div>';
            const sr = await api.envCheck.scan(pr.path);
            if (!sr || !sr.ok) { result.innerHTML = `<div style="padding:20px; color:#dc2626; font-size:12px;">扫描失败：${escapeHtml((sr && sr.error) || '未知')}</div>`; return; }
            scanData = sr;
            renderScanResult();
        });

        function fmtSize(bytes) {
            if (!bytes) return '0 B';
            const u = ['B', 'KB', 'MB', 'GB', 'TB'];
            let v = bytes, i = 0;
            while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
            return v.toFixed(1) + ' ' + u[i];
        }
        function row(ok, label, detail) {
            const icon = ok ? '<i class="fa-solid fa-circle-check" style="color:#10b981;"></i>' : '<i class="fa-solid fa-circle-xmark" style="color:#ef4444;"></i>';
            return `<div style="display:flex; gap:10px; align-items:flex-start; padding:7px 0; border-bottom:1px solid #f1f5f9; font-size:12px;">
                <span style="flex-shrink:0;">${icon}</span>
                <span><b style="color:#334155;">${escapeHtml(label)}</b>${detail ? `<br><span style="color:#94a3b8; word-break:break-all;">${escapeHtml(detail)}</span>` : ''}</span>
            </div>`;
        }
        function renderScanResult() {
            if (!scanData) return;
            const s = scanData;
            const plugins = s.plugins.filter(p => p.looksLikePlugin);
            const models = s.models || {};
            let html = '<div style="padding:14px 16px; background:#fbfcfe; border:1px solid #e6eaf0; border-radius:9px;">';
            html += row(s.python.found, 'Python 环境', s.python.found ? `${s.python.path}${s.python.hasSitePackages ? ' · 依赖库完整' : ' · ⚠ 缺少 site-packages'}` : '未找到 python.exe（请确认 Python 环境包已解压）');
            html += row(s.comfy.found, 'ComfyUI 核心', s.comfy.found ? s.comfy.path : '未找到 main.py / comfy 目录（请确认 ComfyUI 核心已解压）');
            if (s.comfy.found) {
                html += row(plugins.length > 0, '插件', plugins.length ? `检测到 ${plugins.length} 个：${plugins.slice(0, 8).map(p => escapeHtml(p.name)).join('、')}${plugins.length > 8 ? ' …' : ''}` : 'custom_nodes 里没有检测到插件（可稍后单独下载解压）');
                html += row((models.totalCount || 0) > 0, '模型', models.exists ? `${models.totalCount || 0} 个 · ${fmtSize(models.totalBytes)}${(models.symlinks || []).some(x => !x.valid) ? ' · ⚠ 存在失效的符号链接' : ''}` : '未找到 models 目录');
            }
            for (const p of (s.problems || [])) html += row(false, '问题', p);
            html += '</div>';

            if (s.config && s.config.canApply) {
                html += `<div style="display:flex; gap:10px; align-items:center; margin-top:14px; padding-top:14px; border-top:1px solid #e5e7eb;">
                    <button id="ecApply" class="btn btn-sm btn-primary" type="button" style="background:#059669;color:#fff;"><i class="fa-solid fa-check"></i> 确认安装并应用</button>
                    <span style="font-size:11px; color:#9ca3af;">应用后会自动填写 ComfyUI 服务的 Python 路径和目录</span>
                </div>`;
            } else {
                html += '<div style="margin-top:14px; padding:10px 12px; background:#fef2f2; border-radius:6px; color:#b91c1c; font-size:12px;">上面的必需项未全部通过，暂不能应用。请补齐后重新扫描。</div>';
            }
            result.innerHTML = html;
            const applyBtn = document.getElementById('ecApply');
            if (applyBtn) applyBtn.addEventListener('click', async () => {
                applyBtn.disabled = true;
                applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 应用中…';
                try {
                    const ar = await api.envCheck.apply({ pythonPath: s.config.pythonPath, comfyDir: s.config.comfyDir });
                    if (!ar || !ar.ok) { showToast((ar && ar.error) || '应用失败', 'error'); }
                    else { showToast('环境已应用，Python 路径和 ComfyUI 目录已写入设置', 'success'); }
                } catch (e) { showToast('应用失败：' + e.message, 'error'); }
                finally { applyBtn.disabled = false; applyBtn.innerHTML = '<i class="fa-solid fa-check"></i> 确认安装并应用'; }
            });
        }
    }

    async function renderSysteminfoPane(container) {
        container.style.position = 'relative';
        const wrap = document.createElement('div');
        container.appendChild(wrap);

        // 渲染骨架（骨架本身有高度，避免遮罩盖住空白导致跳变）
        wrap.innerHTML = _buildSkeletonHtml();

        // 顶部「刷新」按钮（每次渲染先清空，避免重复挂）
        const refreshBtn = _mountTopbarRefresh(async () => {
            if (_systeminfoLoading) return;
            await _fetchAndRender(wrap, refreshBtn, true);
        });

        if (_systeminfoCache) {
            // 已有缓存：直接渲染缓存，不重拉
            wrap.innerHTML = _buildInfoHtml(_systeminfoCache);
            return;
        }
        // 首次进入自动拉一次
        await _fetchAndRender(wrap, refreshBtn, false);
    }

    async function _fetchAndRender(wrap, refreshBtn, isManual) {
        _systeminfoLoading = true;
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 刷新中…';
        }
        // 手动刷新时显示 loading 遮罩；首次进入直接覆盖骨架
        let overlay = null;
        if (isManual) {
            overlay = document.createElement('div');
            overlay.className = 'si-loading';
            overlay.innerHTML = '<i class="fa-solid fa-spinner"></i>';
            wrap.style.position = 'relative';
            wrap.appendChild(overlay);
        }
        const t0 = Date.now();
        try {
            const r = await api.systeminfo.get();
            if (r && r.ok) {
                _systeminfoCache = r.data;
            } else {
                _systeminfoCache = null;
                if (window.showToast) showToast('系统信息获取失败：' + (r && r.error || '未知错误'), 'error');
            }
        } catch (e) {
            _systeminfoCache = null;
            if (window.showToast) showToast('系统信息获取失败：' + e.message, 'error');
        }
        // 手动刷新至少停留 250ms，避免闪一下
        const elapsed = Date.now() - t0;
        if (isManual && elapsed < 250) await new Promise(r => setTimeout(r, 250 - elapsed));
        wrap.innerHTML = _systeminfoCache ? _buildInfoHtml(_systeminfoCache) : _buildSkeletonHtml();
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> 刷新';
        }
        _systeminfoLoading = false;
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

    // ========== 工具 ==========
    function createCard(title, desc) {
        const card = document.createElement('div');
        // DWP 视觉基线：class-based 卡片骨架，与工作台 .dwp-panel 对齐。
        card.className = 'set-card';
        card.innerHTML = `
            <div class="set-card-head">
                <h3 class="set-card-title"><i class="fa-solid fa-folder-tree" style="color:#6366f1;"></i> ${escapeHtml(title)}</h3>
                ${desc ? '<p class="set-card-desc">' + escapeHtml(desc) + '</p>' : ''}
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

    // ===== AI 小说（依赖 novel.js 暴露的 renderIntoSettings；不重复维护 provider 配置 UI）=====
    async function renderAiNovelPane(container) {
        // settingsContent 是普通 flow 容器；wrap 占满可用空间以便内嵌的设置卡可滚动
        const wrap = document.createElement('div');
        wrap.className = 'set-ainovel-wrap';
        wrap.style.cssText = 'position:absolute; top:0; left:0; right:0; bottom:0; overflow-y:auto; background:#ffffff;';
        container.style.position = 'relative';
        container.appendChild(wrap);

        if (window.novel && typeof window.novel.renderIntoSettings === 'function') {
            try {
                await window.novel.renderIntoSettings(wrap);
                return;
            } catch (e) {
                console.error('[settings] novel.renderIntoSettings 失败：', e);
                wrap.innerHTML = `<div style="padding:60px 20px; text-align:center; color:#dc2626; font-size:13px;">加载 AI 小说配置失败，请刷新页面或重启应用后重试。</div>`;
                return;
            }
        }
        wrap.innerHTML = `<div style="padding:60px 20px; text-align:center; color:#6b7280; font-size:13px;">novel.js 未加载</div>`;
    }

    // ========== 暴露 ==========
    window.settings = { open, close, isOpen };
})();
