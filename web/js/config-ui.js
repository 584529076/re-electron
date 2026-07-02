// config-ui.js — D-25 配置管理 UI
// 作用：动态从 SQLite 拉 config，构建 tab 菜单 + 弹"配置管理"模态
// 不动 script.js 现有逻辑（瀑布流、提示词、标签、NAS BFS、cache 全部保留）
//
// 对外接口（挂到 window.configUI）：
//   - init({ onTabChange, onLoadResource, getCurrentSource }) 启动入口
//   - openManageModal() 打开配置管理模态
//
// 内部职责：
//   - 拉 config → 渲染顶部 tab
//   - tab 点击 → 通知 onTabChange
//   - 模态：增删改 tab，每行可改 name / source.type / 各种路径
//   - 保存 → 调 window.api.config.set → 重新拉 → 重建 tab
'use strict';

(function () {
    const api = window.api || {};
    if (!api.config) {
        console.warn('[config-ui] window.api.config 不可用（纯浏览器模式），功能禁用');
        return;
    }

    // ========= 状态 =========
    let _config = null;          // { version, tabs: [...], activeTabId }
    let _callbacks = null;        // { onTabChange, onLoadResource, getCurrentSource }
    let _saveDebounce = null;

    // ========= 初始化 =========
    async function init(callbacks) {
        _callbacks = callbacks || {};
        // 直接拉 config 并在 renderTabs 之前把 activeTabId 强制改成 tabs[0]
        // 避免 reload() 用磁盘里残留的旧 activeTabId 触发一次错误 tab 的加载
        const r = await api.config.get();
        if (!r.ok) {
            console.error('[config-ui] 拉 config 失败：', r.error);
            return;
        }
        _config = r.config;
        if (_config && Array.isArray(_config.tabs) && _config.tabs.length > 0) {
            _config.activeTabId = _config.tabs[0].id;
        }
        renderTabs();
        bindManageButton();
    }

    // 仅重读 config + 重渲 tabs，**不覆盖 _callbacks**。给 settings.js 保存后用，
    // 避免 init({}) 把主页面传的 onTabChange 抹掉导致 gallery 不刷新
    async function refresh() {
        await reload();
    }

    async function reload() {
        const r = await api.config.get();
        if (!r.ok) {
            console.error('[config-ui] 拉 config 失败：', r.error);
            return;
        }
        _config = r.config;
        renderTabs();
        bindManageButton();
    }

    function getActiveTab() {
        if (!_config) return null;
        return _config.tabs.find((t) => t.id === _config.activeTabId) || _config.tabs[0] || null;
    }

    // ========= 顶部 tab 渲染 =========
    function renderTabs() {
        const container = document.querySelector('.tab-container');
        if (!container) return;
        container.innerHTML = '';
        if (!_config || !Array.isArray(_config.tabs)) return;

        _config.tabs.forEach((tab) => {
            const el = document.createElement('div');
            el.className = 'tab-item';
            el.setAttribute('role', 'tab');
            el.setAttribute('aria-selected', tab.id === _config.activeTabId ? 'true' : 'false');
            el.setAttribute('tabindex', tab.id === _config.activeTabId ? '0' : '-1');
            el.dataset.tab = tab.id;
            el.textContent = tab.name;
            el.title = `${tab.name} (${describeSource(tab.source)})`;
            if (tab.id === _config.activeTabId) el.classList.add('active');

            el.addEventListener('click', () => selectTab(tab.id));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(tab.id); }
            });
            container.appendChild(el);
        });

        // 触发一次默认 tab 加载
        if (_config.tabs.length > 0) {
            selectTab(_config.activeTabId, true);
        }
    }

    function describeSource(src) {
        if (!src) return '无';
        if (src.type === 'nas') return `NAS: ${src.path || ''}`;
        if (src.type === 'local') return `本地: ${src.path || ''}`;
        if (src.type === 'network') {
            const n = (src.urls || '').split(/\r?\n/).filter(Boolean).length;
            return `网络: ${n} URL`;
        }
        return src.type;
    }

    function selectTab(tabId, isFirstLoad = false) {
        if (!_config) return;
        const tab = _config.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        _config.activeTabId = tabId;
        // 更新 active 样式
        document.querySelectorAll('.tab-item').forEach((el) => {
            const isActive = el.dataset.tab === tabId;
            el.classList.toggle('active', isActive);
            el.setAttribute('aria-selected', isActive ? 'true' : 'false');
            el.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        // 通知外部
        if (_callbacks && _callbacks.onTabChange) {
            _callbacks.onTabChange(tab, isFirstLoad);
        }
    }

    // ========= 配置管理按钮 =========
    function bindManageButton() {
        // 复用顶部 .controls 容器，加「配置」「提示词生成」按钮
        const controls = document.querySelector('.controls');
        if (!controls) {
            console.warn('[config-ui] .controls 容器不存在，跳过 bindManageButton');
            return;
        }
        console.log('[config-ui] bindManageButton 开始执行，controls 子节点数=', controls.children.length, 'firstChild=', controls.firstChild && controls.firstChild.nodeName);

        // D-31: 改为 appendChild 到末尾，不依赖 firstChild / nextSibling
        if (!document.getElementById('btnConfig')) {
            const btn = document.createElement('button');
            btn.id = 'btnConfig';
            btn.className = 'btn';
            btn.title = '管理 Tab 配置（增删改 + 切换资源路径）';
            btn.innerHTML = '<i class="fa-solid fa-gear"></i> 配置';
            btn.addEventListener('click', openManageModal);
            controls.appendChild(btn);
            console.log('[config-ui] btnConfig 已 append');
        }

        if (!document.getElementById('btnPromptGen')) {
            const pgBtn = document.createElement('button');
            pgBtn.id = 'btnPromptGen';
            pgBtn.className = 'btn';
            pgBtn.title = '提示词自动生成（Ollama 本地 LLM）';
            pgBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 提示词生成';
            pgBtn.addEventListener('click', () => {
                if (window.promptGen && window.promptGen.open) {
                    window.promptGen.open();
                } else {
                    alert('提示词生成模块未加载');
                }
            });
            controls.appendChild(pgBtn);
            console.log('[config-ui] btnPromptGen 已 append');
        }
    }

    // D-27: 从提示词生成页返回时显示瀑布流
    function showGallery() {
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = '';
        if (header) header.style.display = '';
    }

    // ========= 配置管理模态 =========
    function openManageModal() {
        if (!_config) return;
        // 已有就刷内容
        let modal = document.getElementById('configModal');
        if (!modal) {
            modal = createModal();
            document.body.appendChild(modal);
        }
        renderModalBody(modal);
        modal.classList.add('active');
    }

    function closeManageModal() {
        const modal = document.getElementById('configModal');
        if (modal) modal.classList.remove('active');
    }

    function createModal() {
        const overlay = document.createElement('div');
        overlay.id = 'configModal';
        overlay.className = 'modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <div class="modal" style="max-width: 880px; width: 92%; max-height: 88vh; display:flex; flex-direction:column;">
                <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center;">
                    <span><i class="fa-solid fa-gear"></i> Tab 配置管理</span>
                    <button id="btnAddTab" class="btn btn-sm btn-primary" type="button">
                        <i class="fa-solid fa-plus"></i> 新增 Tab
                    </button>
                </div>
                <div class="modal-body" id="configModalBody" style="overflow:auto; flex:1;"></div>
                <div class="modal-footer">
                    <button id="btnConfigCancel" class="btn" type="button">取消</button>
                    <button id="btnConfigSave" class="btn btn-primary" type="button">
                        <i class="fa-solid fa-check"></i> 保存
                    </button>
                </div>
            </div>
        `;
        // 关闭（点背景）
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeManageModal(); });
        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) closeManageModal();
        });
        // 按钮
        overlay.querySelector('#btnAddTab').addEventListener('click', () => addTabRow(overlay));
        overlay.querySelector('#btnConfigCancel').addEventListener('click', closeManageModal);
        overlay.querySelector('#btnConfigSave').addEventListener('click', () => saveConfig(overlay));
        return overlay;
    }

    function renderModalBody(modal) {
        const body = modal.querySelector('#configModalBody');
        body.innerHTML = '';
        _config.tabs.forEach((tab, idx) => {
            const row = buildTabRow(tab, idx);
            body.appendChild(row);
        });
        // ComfyUI 服务 section（在 tab 列表之后追加）
        const sep = document.createElement('div');
        sep.style.cssText = 'margin: 18px 0 12px; padding-top: 14px; border-top: 2px dashed #6366f1; display:flex; align-items:center; gap:8px;';
        sep.innerHTML = '<span style="color:#a5b4fc; font-weight:600; font-size:13px;"><i class="fa-solid fa-image"></i> ComfyUI 服务（AI 生图）</span>';
        body.appendChild(sep);
        body.appendChild(buildComfySection());
    }

    function buildTabRow(tab, idx) {
        const row = document.createElement('div');
        row.className = 'config-tab-row';
        row.style.cssText = 'border:1px solid #444; border-radius:6px; padding:12px; margin-bottom:10px; background:#1a1a1a;';
        row.dataset.tabId = tab.id;

        const src = tab.source || { type: 'nas' };
        row.innerHTML = `
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                <input class="cfg-name" type="text" value="${escapeHtml(tab.name)}" placeholder="Tab 名称" style="flex:1; padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px;">
                <select class="cfg-type" style="padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px;">
                    <option value="nas" ${src.type === 'nas' ? 'selected' : ''}>NAS (HTTP 目录)</option>
                    <option value="local" ${src.type === 'local' ? 'selected' : ''}>本地目录</option>
                    <option value="network" ${src.type === 'network' ? 'selected' : ''}>网络 URL 列表</option>
                </select>
                <button class="btn btn-sm cfg-up" title="上移" type="button"><i class="fa-solid fa-arrow-up"></i></button>
                <button class="btn btn-sm cfg-down" title="下移" type="button"><i class="fa-solid fa-arrow-down"></i></button>
                <button class="btn btn-sm cfg-del" title="删除此 Tab" type="button" style="background:#a33;color:#fff;"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="cfg-source-fields">
                ${renderSourceFields(src)}
            </div>
        `;

        // 切换 type → 重新渲染 source 字段
        const typeSel = row.querySelector('.cfg-type');
        typeSel.addEventListener('change', () => {
            const newType = typeSel.value;
            const cur = readSourceFromRow(row);
            cur.type = newType;
            row.querySelector('.cfg-source-fields').innerHTML = renderSourceFields(cur);
        });

        // 上下移
        row.querySelector('.cfg-up').addEventListener('click', () => moveTab(idx, -1));
        row.querySelector('.cfg-down').addEventListener('click', () => moveTab(idx, +1));
        // 删
        row.querySelector('.cfg-del').addEventListener('click', () => {
            if (_config.tabs.length <= 1) {
                showToast('至少保留 1 个 Tab', 'error');
                return;
            }
            _config.tabs.splice(idx, 1);
            renderModalBody(document.getElementById('configModal'));
        });

        return row;
    }

    function renderSourceFields(src) {
        // D-26: 统一 path 字段（nas = http URL，local = 文件夹路径）
        if (src.type === 'nas') {
            return `
                <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">路径（HTTP 根 URL + 远程目录）
                    <input class="cfg-path" type="text" value="${escapeHtml(src.path || '')}" placeholder="http://192.168.0.109:5005/home/小芋/003 AI出图/" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                </label>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-top:6px;">
                    <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">图片扩展名（逗号分隔）
                        <input class="cfg-imgExts" type="text" value="${escapeHtml((src.imgExts || []).join(','))}" placeholder="jpg,jpeg,png" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">视频扩展名
                        <input class="cfg-videoExts" type="text" value="${escapeHtml((src.videoExts || []).join(','))}" placeholder="mp4,webm" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                    </label>
                </div>
                <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa; margin-top:6px;">最大递归深度
                    <input class="cfg-maxDepth" type="number" value="${Number(src.maxDepth) || 10}" min="1" max="20" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                </label>
            `;
        } else if (src.type === 'local') {
            return `
                <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">本地路径
                    <div style="display:flex; gap:6px;">
                        <input class="cfg-path" type="text" value="${escapeHtml(src.path || '')}" placeholder="D:\\Download\\▶LTX2.3最新工作流整合+模型\\测试素材" style="flex:1; padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                        <button class="btn btn-sm cfg-pick" type="button"><i class="fa-solid fa-folder-open"></i> 选目录</button>
                    </div>
                </label>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-top:6px;">
                    <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">图片扩展名
                        <input class="cfg-imgExts" type="text" value="${escapeHtml((src.imgExts || []).join(','))}" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">视频扩展名
                        <input class="cfg-videoExts" type="text" value="${escapeHtml((src.videoExts || []).join(','))}" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                    </label>
                </div>
                <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa; margin-top:6px;">最大递归深度
                    <input class="cfg-maxDepth" type="number" value="${Number(src.maxDepth) || 10}" min="1" max="20" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px;">
                </label>
            `;
        } else if (src.type === 'network') {
            return `
                <label style="display:flex; flex-direction:column; gap:3px; font-size:12px; color:#aaa;">URL 列表（每行一个）
                    <textarea class="cfg-urls" rows="6" placeholder="https://example.com/img1.jpg&#10;https://example.com/video1.mp4" style="padding:5px 8px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:3px; font-family:monospace;">${escapeHtml(src.urls || '')}</textarea>
                </label>
            `;
        }
        return '<div style="color:#f88;">未实现的 source.type</div>';
    }

    function readSourceFromRow(row) {
        const type = row.querySelector('.cfg-type').value;
        const out = { type };
        if (type === 'nas' || type === 'local') {
            out.path = row.querySelector('.cfg-path')?.value || '';
            out.imgExts = splitExts(row.querySelector('.cfg-imgExts')?.value);
            out.videoExts = splitExts(row.querySelector('.cfg-videoExts')?.value);
            out.maxDepth = Number(row.querySelector('.cfg-maxDepth')?.value) || 10;
        } else if (type === 'network') {
            out.urls = row.querySelector('.cfg-urls')?.value || '';
        }
        return out;
    }

    function splitExts(s) {
        return String(s || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    }

    function addTabRow(modal) {
        const newId = 'tab-' + Date.now().toString(36);
        const newTab = {
            id: newId,
            name: '新 Tab',
            source: { type: 'nas', path: '', imgExts: ['jpg', 'jpeg', 'png', 'gif', 'webp'], videoExts: ['mp4', 'webm'], maxDepth: 10 },
        };
        _config.tabs.push(newTab);
        renderModalBody(modal);
    }

    function moveTab(idx, dir) {
        const j = idx + dir;
        if (j < 0 || j >= _config.tabs.length) return;
        const tmp = _config.tabs[idx];
        _config.tabs[idx] = _config.tabs[j];
        _config.tabs[j] = tmp;
        renderModalBody(document.getElementById('configModal'));
    }

    async function saveConfig(modal) {
        // 收集每行
        const rows = modal.querySelectorAll('.config-tab-row');
        const tabs = [];
        const seenIds = new Set();
        for (const row of rows) {
            const name = row.querySelector('.cfg-name').value.trim();
            const oldId = row.dataset.tabId;
            if (!name) { showToast('Tab 名称不能为空', 'error'); return; }
            if (seenIds.has(oldId)) { showToast(`Tab id 重复: ${oldId}`, 'error'); return; }
            seenIds.add(oldId);
            const source = readSourceFromRow(row);
            tabs.push({ id: oldId, name, source });
        }
        if (tabs.length === 0) { showToast('至少保留 1 个 Tab', 'error'); return; }

        // 保留 activeTabId（如果还存在）
        const newCfg = { version: 1, tabs, activeTabId: tabs.find((t) => t.id === _config.activeTabId) ? _config.activeTabId : tabs[0].id };
        const r = await api.config.set(newCfg);
        if (!r.ok) {
            showToast('保存失败：' + r.error, 'error');
            return;
        }
        _config = newCfg;
        renderTabs();
        closeManageModal();
        showToast('配置已保存（重启也保留）', 'success');
    }

    function showToast(msg, type) {
        // 复用 script.js 的 toast 容器；不依赖 script.js 内部实现
        const c = document.getElementById('toast-container');
        if (!c) { console.log('[toast]', msg); return; }
        const t = document.createElement('div');
        t.className = 'toast' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========= ComfyUI 服务 section =========
    // 渲染 + 绑定事件：4 个输入框 + 启动/停止 + 状态点
    // 数据落 api.comfyui.configGet/Set；启动/停止走 start/stop；状态轮询走 status
    function buildComfySection() {
        const wrap = document.createElement('div');
        wrap.id = 'comfyuiSection';
        wrap.style.cssText = 'border:1px solid #4338ca; border-radius:8px; padding:14px; background:#1e1b4b; color:#e0e7ff;';

        wrap.innerHTML = `
            <div style="font-size:12px; color:#a5b4fc; margin-bottom:10px;">
                配置本地 ComfyUI 服务（用户自装）。配置后可点「启动」由本应用拉起 ComfyUI 子进程。
            </div>
            <div style="display:grid; grid-template-columns: 110px 1fr auto; gap:8px; align-items:center; margin-bottom:8px;">
                <label style="font-size:12px; color:#c7d2fe;">Python 路径</label>
                <input id="cfgComfyPython" type="text" placeholder="D:\\ComfyUI\\venv\\Scripts\\python.exe" style="padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px; font-size:12px; font-family:monospace;">
                <button id="cfgComfyPythonPick" class="btn btn-sm" type="button" title="选择 python.exe"><i class="fa-solid fa-folder-open"></i></button>

                <label style="font-size:12px; color:#c7d2fe;">ComfyUI 目录</label>
                <input id="cfgComfyDir" type="text" placeholder="D:\\ComfyUI（需含 main.py）" style="padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px; font-size:12px; font-family:monospace;">
                <button id="cfgComfyDirPick" class="btn btn-sm" type="button" title="选择 ComfyUI 根目录"><i class="fa-solid fa-folder-open"></i></button>

                <label style="font-size:12px; color:#c7d2fe;">监听端口</label>
                <input id="cfgComfyPort" type="number" value="8188" min="1" max="65535" style="padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px; font-size:12px;">
                <span></span>

                <label style="font-size:12px; color:#c7d2fe;">输出目录</label>
                <input id="cfgComfyOutput" type="text" placeholder="（可选）ComfyUI 输出拷贝目录" style="padding:6px 10px; background:#0d0d0d; color:#eee; border:1px solid #333; border-radius:4px; font-size:12px; font-family:monospace;">
                <button id="cfgComfyOutputPick" class="btn btn-sm" type="button" title="选择输出目录"><i class="fa-solid fa-folder-open"></i></button>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding-top:10px; border-top:1px solid #312e81;">
                <span id="cfgComfyStatusDot" style="width:10px; height:10px; border-radius:50%; background:#6b7280; display:inline-block;"></span>
                <span id="cfgComfyStatusText" style="font-size:12px; color:#a5b4fc; flex:1;">未启动</span>
                <button id="cfgComfyStart" class="btn btn-sm btn-primary" type="button"><i class="fa-solid fa-play"></i> 启动</button>
                <button id="cfgComfyStop" class="btn btn-sm" type="button" style="background:#a33; color:#fff; display:none;"><i class="fa-solid fa-stop"></i> 停止</button>
                <button id="cfgComfySave" class="btn btn-sm" type="button" style="background:#10b981; color:#fff;"><i class="fa-solid fa-check"></i> 保存配置</button>
                <button id="cfgComfyOpenOutput" class="btn btn-sm" type="button" title="打开媒体输出目录"><i class="fa-solid fa-folder-tree"></i> 打开输出</button>
            </div>
            <div id="cfgComfyWfList" style="font-size:11px; color:#a5b4fc; margin-top:10px; padding-top:10px; border-top:1px dashed #312e81;"></div>
        `;

        // 异步加载：配置 + workflows
        (async () => {
            const cfgR = await api.comfyui.configGet();
            const cfg = (cfgR && cfgR.ok) ? cfgR.config : {};
            wrap.querySelector('#cfgComfyPython').value = cfg.pythonPath || '';
            wrap.querySelector('#cfgComfyDir').value = cfg.comfyDir || '';
            wrap.querySelector('#cfgComfyPort').value = cfg.port || 8188;
            wrap.querySelector('#cfgComfyOutput').value = cfg.outputDir || '';

            const wfR = await api.comfyui.listWorkflows();
            const wfDiv = wrap.querySelector('#cfgComfyWfList');
            if (wfR && wfR.ok && Array.isArray(wfR.workflows)) {
                wfDiv.innerHTML = '<div style="margin-bottom:4px;">已加载 workflow：</div>' + wfR.workflows.map(w => {
                    const dot = w.broken ? '<span style="color:#f87171;">● 损坏</span>' : (w.hasPositive ? '<span style="color:#34d399;">● 就绪</span>' : '<span style="color:#fbbf24;">● 缺占位符</span>');
                    return `<div style="padding:2px 0;">${dot} <b>${escapeHtml(w.name)}</b> (${w.mode}) — ${escapeHtml(w.defaultResolution || '?')} — ${escapeHtml(w.notes || '')}</div>`;
                }).join('');
            } else {
                wfDiv.textContent = '无法读取 workflow 列表';
            }

            // 状态点初始化
            refreshComfyStatus(wrap);
        })();

        // 事件绑定
        wrap.querySelector('#cfgComfyPythonPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickPython();
            if (r && r.ok && r.path) wrap.querySelector('#cfgComfyPython').value = r.path;
        });
        wrap.querySelector('#cfgComfyDirPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickComfyDir();
            if (r && r.ok && r.path) wrap.querySelector('#cfgComfyDir').value = r.path;
        });
        wrap.querySelector('#cfgComfyOutputPick').addEventListener('click', async () => {
            const r = await api.comfyui.pickOutputDir();
            if (r && r.ok && r.path) wrap.querySelector('#cfgComfyOutput').value = r.path;
        });
        wrap.querySelector('#cfgComfySave').addEventListener('click', async () => {
            const out = {
                pythonPath: wrap.querySelector('#cfgComfyPython').value.trim(),
                comfyDir: wrap.querySelector('#cfgComfyDir').value.trim(),
                port: Number(wrap.querySelector('#cfgComfyPort').value) || 8188,
                outputDir: wrap.querySelector('#cfgComfyOutput').value.trim(),
            };
            const r = await api.comfyui.configSet(out);
            if (r && r.ok) showToast('ComfyUI 配置已保存', 'success');
            else showToast('保存失败：' + (r && r.error), 'error');
        });
        wrap.querySelector('#cfgComfyStart').addEventListener('click', async () => {
            // 先 save 再 start（保证用最新值）
            const out = {
                pythonPath: wrap.querySelector('#cfgComfyPython').value.trim(),
                comfyDir: wrap.querySelector('#cfgComfyDir').value.trim(),
                port: Number(wrap.querySelector('#cfgComfyPort').value) || 8188,
                outputDir: wrap.querySelector('#cfgComfyOutput').value.trim(),
            };
            const sv = await api.comfyui.configSet(out);
            if (!sv || !sv.ok) { showToast('配置保存失败：' + (sv && sv.error), 'error'); return; }
            wrap.querySelector('#cfgComfyStart').disabled = true;
            const r = await api.comfyui.start(out);
            wrap.querySelector('#cfgComfyStart').disabled = false;
            if (r && r.ok) {
                showToast('ComfyUI 已启动（PID ' + (r.pid || '外部') + '）', 'success');
            } else {
                showToast('启动失败：' + (r && r.error), 'error');
            }
            refreshComfyStatus(wrap);
        });
        wrap.querySelector('#cfgComfyStop').addEventListener('click', async () => {
            const r = await api.comfyui.stop();
            if (r && r.ok) showToast('ComfyUI 已停止', 'success');
            else showToast('停止失败：' + (r && r.error), 'error');
            refreshComfyStatus(wrap);
        });
        wrap.querySelector('#cfgComfyOpenOutput').addEventListener('click', async () => {
            const r = await api.comfyui.openOutputDir();
            if (r && !r.ok) showToast('打开失败：' + r.error, 'error');
        });

        return wrap;
    }

    async function refreshComfyStatus(wrap) {
        if (!wrap) wrap = document.getElementById('comfyuiSection');
        if (!wrap) return;
        const dot = wrap.querySelector('#cfgComfyStatusDot');
        const txt = wrap.querySelector('#cfgComfyStatusText');
        const btnStart = wrap.querySelector('#cfgComfyStart');
        const btnStop = wrap.querySelector('#cfgComfyStop');
        if (!dot || !txt) return;
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

    // ========= 对外 =========
    window.configUI = {
        init,
        refresh,        // settings.js 保存后用：重读 config + 重渲 tabs，保留 _callbacks
        getActiveTab,
        openManageModal,
        closeManageModal,
        showGallery,  // D-27: 给 prompt-gen 用
        refreshComfyStatus,  // ComfyUI: 给 prompt-gen 调（弹框打开时也会自动调一次）
    };
})();
