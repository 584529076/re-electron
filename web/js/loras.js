// loras.js — Lora 库页面（管理 / 浏览 / 编辑 / 删除）
//
// 入口：window.lorasPage.open() — 由 script.js 的「Lora 库」按钮调用
// 数据：api.loras.* (Phase 1 IPC) + 本地状态
//
// 布局：
//   lorasPage
//   ├── headerBar       返回主页 + 标题 + "+ 新建 Lora"
//   ├── sidebar         类型分类 (all + 8 types) + 每类计数
//   ├── toolbar         搜索框 + 模型筛选下拉 + 类型 chips
//   ├── grid            Lora 卡片网格
//   └── modals (按需创建)
//       ├── detailModal   详情查看 + 编辑/删除/复制示例提示词
//       ├── editModal     新建/编辑表单
//       └── pickerModal   推荐搭配 Lora 多选

'use strict';

(function () {
    const api = window.api || {};
    if (!api.loras) { console.warn('[loras] window.api.loras 不可用'); return; }

    // ========== 状态 ==========
    const _types = [
        { id: 'character',  label: '人物卡',     icon: 'fa-user' },
        { id: 'clothing',   label: '服装卡',     icon: 'fa-shirt' },
        { id: 'animal',     label: '动物卡',     icon: 'fa-paw' },
        { id: 'body_part',  label: '人体部位',   icon: 'fa-hand' },
        { id: 'pose',       label: '姿势卡',     icon: 'fa-person-walking' },
        { id: 'concept',    label: '概念卡',     icon: 'fa-lightbulb' },
        { id: 'style',      label: '风格卡',     icon: 'fa-palette' },
        { id: 'general',    label: '通用',       icon: 'fa-globe' },
    ];

    // ========== 适配模型枚举（schema 的 models 字段共用）==========
    // Lora 表单「适配模型」多选下拉选项，同时也是 workflow schema.models 的允许取值。
    // 与 workflow 端保持一致后，AI 工具按 schema.models 筛选 Lora 时才能精确命中。
    const _ADAPTIVE_MODEL_OPTIONS = [
        'ZIT', 'ZIB', 'Krea2', 'Kelin2',
        'Flux', 'Flux2', 'Qwen',
        'Wan2.1', 'Wan2.2', 'Anime',
        'boogu',
    ];
    // 多选下拉的 checkbox 列表 HTML（缓存，renderEditForm 时直接拼）
    const _adaptiveModelOptionsHtml = _ADAPTIVE_MODEL_OPTIONS.map(m =>
        `<label data-adaptive-model="${escapeAttr(m)}" style="display:flex; align-items:center; padding:6px 14px; cursor:pointer; font-size:13px; color:#1f2937; transition:background 0.1s;" onmouseenter="this.style.background='#f9fafb';" onmouseleave="this.style.background='#ffffff';">
            <input type="checkbox" value="${escapeAttr(m)}" style="margin-right:8px; cursor:pointer;" />
            <span>${escapeHtml(m)}</span>
        </label>`
    ).join('');
    let _loras = [];                  // 当前已加载的全量列表（不含 model 二次筛选）
    let _filter = { type: '', searchText: '', model: '' };
    let _currentDetail = null;        // 详情 modal 里的当前 Lora
    let _editMode = 'create';         // 'create' | 'edit'
    let _editBuffer = null;           // 编辑表单的临时数据
    let _editCoverUrl = '';           // 预览用（blob URL 或 file://）
    let _pairingPickerCallback = null;

    // ========== 入口 ==========
    async function open() {
        if (!document.getElementById('lorasPage')) createPage();
        showPage();
        await reloadAll();
    }

    function close() {
        const page = document.getElementById('lorasPage');
        if (page) page.style.display = 'none';
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = '';
        if (header) header.style.display = '';
    }

    function showPage() {
        const page = document.getElementById('lorasPage');
        if (page) page.style.display = 'flex';
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (main) main.style.display = 'none';
        if (header) header.style.display = 'none';
    }

    async function reloadAll() {
        const grid = document.getElementById('lpGrid');
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1; padding:60px 0; text-align:center; color:#9ca3af; font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
        const r = await api.loras.list({ limit: 100000 });
        if (!r || !r.ok) {
            if (grid) grid.innerHTML = `<div style="grid-column:1/-1; padding:60px 0; text-align:center; color:#dc2626; font-size:13px;">加载失败: ${escapeHtml((r && r.error) || '未知')}</div>`;
            _loras = [];
        } else {
            _loras = r.loras || [];
        }
        renderSidebarCounts();
        applyFilter();
    }

    // ========== DOM ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'lorasPage';
        page.style.cssText = 'position:fixed; inset:0; background:#f5f6f8; z-index:200; display:none; flex-direction:column; color:#1a1a1a; font-family:system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;';
        page.innerHTML = `
            <div id="lpHeaderBar" style="display:flex; align-items:center; padding:14px 20px; border-bottom:1px solid #e5e7eb; background:#ffffff; box-shadow:0 1px 2px rgba(0,0,0,0.04); flex-shrink:0;">
                <button id="lpBtnBack" class="btn" style="margin-right:14px;"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                <h2 style="margin:0; flex:1; color:#1f2937; font-size:18px; font-weight:600;"><i class="fa-solid fa-puzzle-piece" style="color:#0ea5e9;"></i> Lora 库</h2>
                <span id="lpTotalCount" style="font-size:12px; color:#6b7280; margin-right:12px;"></span>
                <button id="lpBtnNew" class="btn btn-primary"><i class="fa-solid fa-plus"></i> 新建 Lora</button>
            </div>
            <div style="display:flex; flex:1; min-height:0;">
                <div id="lpSidebar" style="width:200px; flex-shrink:0; background:#ffffff; border-right:1px solid #e5e7eb; overflow-y:auto; padding:8px 0;"></div>
                <div style="flex:1; display:flex; flex-direction:column; min-width:0; background:#f5f6f8;">
                    <div id="lpToolbar" style="padding:14px 18px; border-bottom:1px solid #e5e7eb; background:#ffffff; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                        <input id="lpSearch" type="text" placeholder="🔍 搜索名称 / 显示名"
                               style="flex:1; min-width:200px; padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box;" />
                        <select id="lpModelFilter" style="padding:8px 12px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; min-width:180px;">
                            <option value="">所有模型</option>
                        </select>
                    </div>
                    <div id="lpGrid" style="flex:1; overflow-y:auto; padding:18px; display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:14px; align-content:start;"></div>
                </div>
            </div>
        `;
        document.body.appendChild(page);

        // 绑定
        page.querySelector('#lpBtnBack').addEventListener('click', close);
        page.querySelector('#lpBtnNew').addEventListener('click', () => openEditModal('create'));
        const searchInput = page.querySelector('#lpSearch');
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                _filter.searchText = searchInput.value.trim();
                applyFilter();
            }, 150);
        });
        page.querySelector('#lpModelFilter').addEventListener('change', (e) => {
            _filter.model = e.target.value;
            applyFilter();
        });
    }

    // ========== 侧栏（类型分类 + 计数）==========
    function renderSidebar() {
        const sidebar = document.getElementById('lpSidebar');
        if (!sidebar) return;
        const html = [];
        html.push(renderSidebarItem({ id: '', label: '全部 Lora', icon: 'fa-layer-group' }, _loras.length, _filter.type === ''));
        for (const t of _types) {
            const count = _loras.filter(l => l.lora_type === t.id).length;
            html.push(renderSidebarItem(t, count, _filter.type === t.id));
        }
        sidebar.innerHTML = html.join('');
        sidebar.querySelectorAll('.lp-sidebar-item').forEach(el => {
            el.addEventListener('click', () => {
                _filter.type = el.dataset.type;
                renderSidebar();
                applyFilter();
            });
        });
    }

    function renderSidebarCounts() {
        renderSidebar();
        const total = document.getElementById('lpTotalCount');
        if (total) total.textContent = `${_loras.length} 个`;
        const sel = document.getElementById('lpModelFilter');
        if (!sel) return;
        // 适配模型下拉：
        //   1) 前置固定展示 _ADAPTIVE_MODEL_OPTIONS 10 个枚举（与表单下拉、schema.models 完全一致）
        //   2) 后续追加 loras 里现存但不在枚举里的字符串 —— 给旧数据留兼容入口
        //   3) _ADAPTIVE_MODEL_OPTIONS 顺序固定；剩余项按字母序排
        const fromLoras = new Set();
        for (const l of _loras) {
            if (l.base_model) fromLoras.add(l.base_model);
            if (Array.isArray(l.compatible_models)) for (const m of l.compatible_models) fromLoras.add(String(m));
        }
        const enumSet = new Set(_ADAPTIVE_MODEL_OPTIONS);
        const legacy = Array.from(fromLoras).filter(m => !enumSet.has(m)).sort();
        const list = [..._ADAPTIVE_MODEL_OPTIONS, ...legacy];
        const current = _filter.model;
        sel.innerHTML = '<option value="">所有模型</option>' + list.map(m => `<option value="${escapeAttr(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    }

    function renderSidebarItem(t, count, active) {
        const badgeColor = count > 0 ? '#0ea5e9' : '#d1d5db';
        const textColor = active ? '#0ea5e9' : '#374151';
        const bg = active ? '#f0f9ff' : 'transparent';
        const weight = active ? '600' : '400';
        return `
            <div class="lp-sidebar-item" data-type="${escapeAttr(t.id)}"
                 style="display:flex; align-items:center; padding:10px 16px; cursor:pointer; background:${bg}; color:${textColor}; font-size:13px; font-weight:${weight}; transition:background 0.12s;"
                 onmouseenter="this.style.background='${active ? '#f0f9ff' : '#f9fafb'}';"
                 onmouseleave="this.style.background='${active ? '#f0f9ff' : 'transparent'}';">
                <i class="fa-solid ${t.icon}" style="margin-right:10px; width:16px; text-align:center; color:${active ? '#0ea5e9' : '#9ca3af'};"></i>
                <span style="flex:1;">${escapeHtml(t.label)}</span>
                <span style="font-size:11px; background:${badgeColor}; color:#ffffff; padding:1px 8px; border-radius:10px; min-width:24px; text-align:center;">${count}</span>
            </div>
        `;
    }

    // ========== 过滤 + 渲染卡片网格 ==========
    function applyFilter() {
        const grid = document.getElementById('lpGrid');
        if (!grid) return;
        let list = _loras.slice();
        if (_filter.type) list = list.filter(l => l.lora_type === _filter.type);
        if (_filter.searchText) {
            const q = _filter.searchText.toLowerCase();
            list = list.filter(l => (l.name || '').toLowerCase().includes(q) || (l.display_name || '').toLowerCase().includes(q));
        }
        if (_filter.model) {
            const m = _filter.model;
            list = list.filter(l => l.base_model === m || (Array.isArray(l.compatible_models) && l.compatible_models.includes(m)) || l.lora_type === 'general');
        }
        if (!list.length) {
            grid.innerHTML = `<div style="grid-column:1/-1; padding:80px 0; text-align:center; color:#9ca3af; font-size:13px;">
                <i class="fa-solid fa-puzzle-piece" style="font-size:48px; color:#e5e7eb; display:block; margin-bottom:12px;"></i>
                没有匹配的 Lora<br>
                <span style="font-size:11px; color:#d1d5db; margin-top:6px; display:block;">${_loras.length === 0 ? '点右上角「新建 Lora」开始' : '尝试调整筛选条件'}</span>
            </div>`;
            return;
        }
        grid.innerHTML = list.map(renderLoraCard).join('');
        grid.querySelectorAll('.lp-card').forEach(el => {
            el.addEventListener('click', () => {
                const id = Number(el.dataset.id);
                const lora = _loras.find(x => x.id === id);
                if (lora) openDetailModal(lora);
            });
        });
    }

    function renderLoraCard(l) {
        const typeObj = _types.find(t => t.id === l.lora_type) || { label: l.lora_type, icon: 'fa-tag' };
        // 适配模型：base_model + compatible_models[]，每个独立 chip（多模型时自动换行）
        const allModels = [l.base_model, ...(Array.isArray(l.compatible_models) ? l.compatible_models : [])].filter(Boolean);
        const modelTags = allModels.map(m =>
            `<span style="display:inline-block; font-size:10px; padding:2px 6px; background:#fef3c7; color:#92400e; border-radius:3px;">${escapeHtml(m)}</span>`
        ).join('');
        const generalBadge = l.lora_type === 'general' ? `<span style="display:inline-block; font-size:10px; padding:2px 6px; background:#d1fae5; color:#065f46; border-radius:3px;">通用</span>` : '';
        const linkBadge = l.link_type === 'hardlink' ? '<i class="fa-solid fa-link" title="硬链接" style="color:#10b981; font-size:10px;"></i>'
                       : l.link_type === 'symlink' ? '<i class="fa-solid fa-link" title="符号链接" style="color:#3b82f6; font-size:10px;"></i>'
                       : l.link_type === 'copy' ? '<i class="fa-solid fa-copy" title="复制" style="color:#f59e0b; font-size:10px;"></i>'
                       : l.link_type === '' ? '<i class="fa-solid fa-circle-exclamation" title="未链接" style="color:#dc2626; font-size:10px;"></i>'
                       : '';
        const coverArea = l.cover_image
            ? `<img data-cover-id="${l.id}" alt="" style="width:100%; height:100%; object-fit:cover; display:block;" />`
            : `<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #0ea5e9, #6366f1);"><i class="fa-solid ${typeObj.icon}" style="font-size:48px; color:rgba(255,255,255,0.7);"></i></div>`;
        return `
            <div class="lp-card" data-id="${l.id}" style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08); cursor:pointer; transition:transform 0.15s, box-shadow 0.15s;"
                 onmouseenter="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 14px rgba(0,0,0,0.12)';"
                 onmouseleave="this.style.transform=''; this.style.boxShadow='0 1px 3px rgba(0,0,0,0.08)';">
                <div style="position:relative; aspect-ratio:3/4; background:#f3f4f6; overflow:hidden;">
                    ${coverArea}
                    <div style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.65); color:#ffffff; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:500;">
                        <i class="fa-solid ${typeObj.icon}" style="margin-right:3px;"></i>${escapeHtml(typeObj.label)}
                    </div>
                    <div style="position:absolute; top:8px; right:8px; background:rgba(255,255,255,0.92); padding:2px 6px; border-radius:10px;">${linkBadge}</div>
                </div>
                <div style="padding:10px 12px;">
                    <div style="font-size:13px; font-weight:600; color:#1f2937; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeAttr(l.name)}">${escapeHtml(l.display_name || l.name)}</div>
                    <div style="font-size:11px; color:#6b7280; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeAttr(l.name)}">${escapeHtml(l.name)}</div>
                    <div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
                        ${modelTags}${generalBadge}
                    </div>
                </div>
            </div>
        `;
    }

    function formatWeight(w) {
        if (typeof w !== 'number') return '1.0';
        return w.toFixed(2).replace(/\.?0+$/, '') || '1';
    }

    // 异步加载 cover 图片 URL（每次重渲染后调用）
    async function loadCoverImages() {
        const imgs = document.querySelectorAll('#lpGrid img[data-cover-id]');
        for (const img of imgs) {
            const id = Number(img.dataset.coverId);
            const r = await api.loras.readCover(id);
            if (r && r.ok && r.url) {
                img.src = r.url;
            } else {
                // 失败时显示 icon fallback
                const lora = _loras.find(x => x.id === id);
                const typeObj = _types.find(t => t.id === (lora && lora.lora_type)) || { icon: 'fa-tag' };
                const parent = img.parentElement;
                img.remove();
                const fb = document.createElement('div');
                fb.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #0ea5e9, #6366f1);';
                fb.innerHTML = `<i class="fa-solid ${typeObj.icon}" style="font-size:48px; color:rgba(255,255,255,0.7);"></i>`;
                parent.appendChild(fb);
            }
        }
    }

    // 重写 applyFilter 在渲染后调用 loadCoverImages
    const _origApply = applyFilter;
    applyFilter = function () {
        _origApply();
        loadCoverImages().catch(() => {});
    };

    // ========== 详情 Modal ==========
    async function openDetailModal(lora) {
        _currentDetail = lora;
        let modal = document.getElementById('lpDetailModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'lpDetailModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:400; display:none; align-items:center; justify-content:center; padding:20px;';
            modal.innerHTML = `
                <div onclick="event.stopPropagation();" style="background:#ffffff; border-radius:10px; width:min(900px, 100%); max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3); overflow:hidden;">
                    <div id="lpDetailBody" style="flex:1; overflow-y:auto;"></div>
                    <div style="padding:12px 18px; border-top:1px solid #e5e7eb; display:flex; gap:8px; background:#f9fafb; flex-shrink:0;">
                        <button id="lpDetailBtnClose" class="btn btn-sm" style="margin-left:auto;"><i class="fa-solid fa-xmark"></i> 关闭</button>
                        <button id="lpDetailBtnDelete" class="btn btn-sm" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca;"><i class="fa-solid fa-trash"></i> 删除</button>
                        <button id="lpDetailBtnEdit" class="btn btn-sm btn-primary"><i class="fa-solid fa-pen"></i> 编辑</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.addEventListener('click', () => closeDetailModal());
            modal.querySelector('#lpDetailBtnClose').addEventListener('click', closeDetailModal);
            modal.querySelector('#lpDetailBtnDelete').addEventListener('click', onDeleteLora);
            modal.querySelector('#lpDetailBtnEdit').addEventListener('click', onEditFromDetail);
        }
        renderDetailBody(lora);
        modal.style.display = 'flex';
    }

    function closeDetailModal() {
        const modal = document.getElementById('lpDetailModal');
        if (modal) modal.style.display = 'none';
        // 复位删除按钮：onDeleteLora 成功路径会改写为「删除中...」并 disable，
        // 关闭 modal 时统一还原，避免下次 openDetailModal 沿用旧的禁用态。
        const delBtn = document.getElementById('lpDetailBtnDelete');
        if (delBtn) {
            delBtn.disabled = false;
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除';
        }
        _currentDetail = null;
    }

    async function renderDetailBody(l) {
        const body = document.getElementById('lpDetailBody');
        if (!body) return;
        const typeObj = _types.find(t => t.id === l.lora_type) || { label: l.lora_type, icon: 'fa-tag' };
        const allCompatible = [l.base_model, ...(Array.isArray(l.compatible_models) ? l.compatible_models : [])].filter(Boolean);
        const compatibleChips = allCompatible.length ? allCompatible.map(m => `<span style="display:inline-block; font-size:11px; padding:3px 8px; background:#fef3c7; color:#92400e; border-radius:3px; margin-right:4px; margin-bottom:4px;">${escapeHtml(m)}</span>`).join('') : '<span style="color:#9ca3af; font-size:12px;">未指定</span>';
        const triggerChips = (l.trigger_words || '').split(',').map(s => s.trim()).filter(Boolean).map(t => `<span style="display:inline-block; font-size:11px; padding:3px 8px; background:#e0f2fe; color:#0c4a6e; border-radius:3px; margin-right:4px; margin-bottom:4px;">${escapeHtml(t)}</span>`).join('') || '<span style="color:#9ca3af; font-size:12px;">无</span>';
        const pairingChips = await renderPairingChips(l.recommended_pairings || []);
        const linkStatus = l.link_type === 'hardlink' ? '<span style="color:#10b981;"><i class="fa-solid fa-link"></i> 硬链接</span>'
                         : l.link_type === 'symlink' ? '<span style="color:#3b82f6;"><i class="fa-solid fa-link"></i> 符号链接</span>'
                         : l.link_type === 'copy' ? '<span style="color:#f59e0b;"><i class="fa-solid fa-copy"></i> 已复制</span>'
                         : '<span style="color:#dc2626;"><i class="fa-solid fa-circle-exclamation"></i> 未链接到 ComfyUI</span>';
        const coverHtml = await renderCoverHtml(l.id, 220);

        body.innerHTML = `
            <div style="display:flex; padding:20px; gap:20px;">
                <div style="flex-shrink:0; width:240px;">
                    <div id="lpDetailCover" style="width:240px; aspect-ratio:3/4; background:#f3f4f6; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center;">${coverHtml}</div>
                </div>
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <span style="display:inline-flex; align-items:center; font-size:11px; padding:3px 10px; background:#0ea5e9; color:#ffffff; border-radius:10px; font-weight:500;">
                            <i class="fa-solid ${typeObj.icon}" style="margin-right:4px;"></i>${escapeHtml(typeObj.label)}
                        </span>
                        <span style="font-size:11px; color:#6b7280;">${linkStatus}</span>
                    </div>
                    <h3 style="margin:0 0 4px 0; color:#1f2937; font-size:18px; font-weight:600;">${escapeHtml(l.display_name || l.name)}</h3>
                    <div style="font-size:12px; color:#6b7280; margin-bottom:14px; word-break:break-all;">${escapeHtml(l.name)}</div>

                    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:10px 16px; font-size:12px;">
                        <div><span style="color:#9ca3af;">推荐权重：</span><strong>${formatWeight(l.recommended_weight)}</strong></div>
                        <div><span style="color:#9ca3af;">文件大小：</span><strong>${formatSize(l.file_size)}</strong></div>
                    </div>

                    <div style="margin-top:14px;">
                        <div style="font-size:11px; color:#9ca3af; margin-bottom:6px; font-weight:500;">适配模型</div>
                        <div>${compatibleChips}</div>
                    </div>

                    <div style="margin-top:14px;">
                        <div style="font-size:11px; color:#9ca3af; margin-bottom:6px; font-weight:500;">唤醒词</div>
                        <div>${triggerChips}</div>
                    </div>

                    <div style="margin-top:14px;">
                        <div style="font-size:11px; color:#9ca3af; margin-bottom:6px; font-weight:500;">推荐搭配</div>
                        <div>${pairingChips}</div>
                    </div>

                    <div style="margin-top:14px;">
                        <div style="font-size:11px; color:#9ca3af; margin-bottom:6px; font-weight:500;">示例提示词</div>
                        <div style="position:relative;">
                            <textarea readonly style="width:100%; min-height:80px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:6px; font-size:12px; line-height:1.6; resize:vertical; background:#f9fafb; box-sizing:border-box; font-family:inherit;">${escapeHtml(l.sample_prompt || '')}</textarea>
                            <button id="lpCopySamplePrompt" class="btn btn-sm" style="position:absolute; top:6px; right:6px; padding:3px 8px; font-size:11px;"><i class="fa-solid fa-copy"></i> 复制</button>
                        </div>
                    </div>

                    ${l.description ? `<div style="margin-top:14px;"><div style="font-size:11px; color:#9ca3af; margin-bottom:6px; font-weight:500;">备注</div><div style="font-size:12px; color:#374151; line-height:1.6;">${escapeHtml(l.description)}</div></div>` : ''}
                </div>
            </div>
        `;
        const copyBtn = document.getElementById('lpCopySamplePrompt');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const text = l.sample_prompt || '';
                if (!text) { showToast('示例提示词为空', 'error'); return; }
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(() => showToast('已复制', 'success')).catch(() => showToast('复制失败', 'error'));
                } else {
                    const ta = copyBtn.previousElementSibling;
                    if (ta) { ta.removeAttribute('readonly'); ta.select(); document.execCommand('copy'); ta.setAttribute('readonly', 'readonly'); ta.blur(); showToast('已复制', 'success'); }
                }
            });
        }
    }

    async function renderCoverHtml(loraId, maxHeight) {
        const r = await api.loras.readCover(loraId);
        if (r && r.ok && r.url) {
            return `<img src="${escapeAttr(r.url)}" style="width:100%; height:100%; object-fit:cover; display:block;" />`;
        }
        const lora = _loras.find(x => x.id === loraId);
        const typeObj = _types.find(t => t.id === (lora && lora.lora_type)) || { icon: 'fa-tag' };
        return `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #0ea5e9, #6366f1);"><i class="fa-solid ${typeObj.icon}" style="font-size:64px; color:rgba(255,255,255,0.7);"></i></div>`;
    }

    async function renderPairingChips(pairingIds) {
        if (!Array.isArray(pairingIds) || !pairingIds.length) {
            return '<span style="color:#9ca3af; font-size:12px;">无</span>';
        }
        const ids = pairingIds.filter(id => !_loras.find(l => l.id === id)); // 先取不在已加载列表的（少见：可能是删除后残留）
        const known = _loras.filter(l => pairingIds.includes(l.id));
        const fetched = [];
        if (ids.length) {
            for (const id of ids) {
                const r = await api.loras.get(id);
                if (r && r.ok && r.lora) fetched.push(r.lora);
            }
        }
        const all = [...known, ...fetched];
        if (!all.length) return '<span style="color:#9ca3af; font-size:12px;">（已删除）</span>';
        return all.map(l => `<span data-pairing-id="${l.id}" class="lp-pairing-chip" style="display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:3px 8px; background:#f3e8ff; color:#6b21a8; border-radius:3px; margin-right:4px; margin-bottom:4px; cursor:pointer;"><i class="fa-solid fa-link"></i>${escapeHtml(l.display_name || l.name)}</span>`).join('');
    }

    function formatSize(bytes) {
        if (!bytes) return '—';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    async function onDeleteLora() {
        if (!_currentDetail) return;
        const l = _currentDetail;
        if (!confirm(`确定删除「${l.display_name || l.name}」？\n\n会同步删除资产目录里的文件和 ComfyUI/models/loras/ 里的链接，此操作不可撤销。`)) return;
        const btn = document.querySelector('#lpDetailBtnDelete');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 删除中...'; }
        try {
            const r = await api.loras.delete(l.id);
            if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
            showToast('已删除', 'success');
            closeDetailModal();
            await reloadAll();
        } catch (e) {
            showToast('删除失败: ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除'; }
        }
    }

    function onEditFromDetail() {
        if (!_currentDetail) return;
        openEditModal('edit', _currentDetail);
    }

    // ========== 编辑/新建 Modal ==========
    function openEditModal(mode, lora) {
        _editMode = mode;
        if (mode === 'create') {
            _editBuffer = {
                name: '',
                display_name: '',
                lora_type: 'character',
                base_model: '',
                compatible_models: [],
                recommended_weight: 1.0,
                recommended_pairings: [],
                trigger_words: '',
                sample_prompt: '',
                description: '',
                cover_image: '',
                _srcPath: '',
                _srcSize: 0,
                _coverPath: '',
            };
        } else {
            _editBuffer = {
                id: lora.id,
                name: lora.name,
                display_name: lora.display_name || '',
                lora_type: lora.lora_type || 'character',
                base_model: lora.base_model || '',
                compatible_models: Array.isArray(lora.compatible_models) ? lora.compatible_models.slice() : [],
                recommended_weight: lora.recommended_weight || 1.0,
                recommended_pairings: Array.isArray(lora.recommended_pairings) ? lora.recommended_pairings.slice() : [],
                trigger_words: lora.trigger_words || '',
                sample_prompt: lora.sample_prompt || '',
                description: lora.description || '',
                cover_image: lora.cover_image || '',
                _srcPath: '',
                _srcSize: lora.file_size || 0,
                _coverPath: '',
            };
        }
        let modal = document.getElementById('lpEditModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'lpEditModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:410; display:none; align-items:center; justify-content:center; padding:20px;';
            modal.innerHTML = `
                <div onclick="event.stopPropagation();" style="background:#ffffff; border-radius:10px; width:min(680px, 100%); max-height:92vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3); overflow:hidden;">
                    <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; background:#f9fafb;">
                        <h3 id="lpEditTitle" style="margin:0; flex:1; color:#1f2937; font-size:16px; font-weight:600;"></h3>
                        <button id="lpEditBtnCancel" class="btn btn-sm"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div id="lpEditForm" style="flex:1; overflow-y:auto; padding:18px;"></div>
                    <div style="padding:12px 18px; border-top:1px solid #e5e7eb; display:flex; gap:8px; background:#f9fafb; flex-shrink:0;">
                        <button id="lpEditBtnSave" class="btn btn-primary" style="margin-left:auto;"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.addEventListener('click', () => closeEditModal());
            modal.querySelector('#lpEditBtnCancel').addEventListener('click', closeEditModal);
            modal.querySelector('#lpEditBtnSave').addEventListener('click', onSaveLora);
        }
        document.getElementById('lpEditTitle').textContent = mode === 'create' ? '新建 Lora' : '编辑 Lora';
        renderEditForm();
        modal.style.display = 'flex';
    }

    function closeEditModal() {
        const modal = document.getElementById('lpEditModal');
        if (modal) modal.style.display = 'none';
        _editBuffer = null;
    }

    function renderEditForm() {
        const form = document.getElementById('lpEditForm');
        if (!form || !_editBuffer) return;
        const b = _editBuffer;
        const isEdit = _editMode === 'edit';
        const typeOpts = _types.map(t => `<option value="${t.id}" ${t.id === b.lora_type ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
        const compatChips = b.compatible_models.map((m) => `
            <span data-compat-value="${escapeAttr(m)}" style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:#fef3c7; color:#92400e; border-radius:3px; font-size:12px;">
                ${escapeHtml(m)}
                <i class="fa-solid fa-xmark" data-remove-compat-value="${escapeAttr(m)}" style="cursor:pointer; opacity:0.7;"></i>
            </span>
        `).join('');
        const triggerWords = (b.trigger_words || '').split(',').map(s => s.trim()).filter(Boolean);
        const triggerChips = triggerWords.map((t, i) => `
            <span style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:#e0f2fe; color:#0c4a6e; border-radius:3px; font-size:12px; margin-right:4px; margin-bottom:4px;">
                ${escapeHtml(t)}
                <i class="fa-solid fa-xmark" data-remove-trigger="${i}" style="cursor:pointer; opacity:0.7;"></i>
            </span>
        `).join('');
        form.innerHTML = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
                <div>
                    <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">显示名</label>
                    <input id="lpInDisplayName" type="text" value="${escapeAttr(b.display_name)}" placeholder="友好名（可重）" style="${inputStyle()}" />
                </div>
                <div>
                    <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">类型</label>
                    <select id="lpInType" style="${inputStyle()}">${typeOpts}</select>
                </div>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">Lora 文件 <span style="color:#dc2626;">*</span> ${isEdit ? '<span style="font-size:11px; color:#9ca3af;">（编辑模式不可更换）</span>' : ''}</label>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button type="button" id="lpBtnPickFile" class="btn btn-sm" ${isEdit ? 'disabled' : ''}><i class="fa-solid fa-folder-open"></i> 选择文件</button>
                    <span id="lpFileName" style="font-size:12px; color:#6b7280; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${isEdit ? escapeHtml(b.name) : '未选择'}</span>
                    <span id="lpFileSize" style="font-size:11px; color:#9ca3af;">${b._srcSize ? formatSize(b._srcSize) : ''}</span>
                </div>
            </div>

            <!-- 适配模型：单一多选下拉（之前是「主适配模型」+「适配模型 chip 输入」双字段）。
                 枚举固定为 _ADAPTIVE_MODEL_OPTIONS，与 workflow schema.models 完全对齐，
                 AI 工具筛选 Lora 时按这套枚举做交集匹配。 -->
            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">
                    适配模型 <span style="color:#9ca3af; font-weight:400;">（多选；点击「+ 选择模型」打勾即可，已选的标签可点 × 移除）</span>
                </label>
                <div id="lpCompatWrap" style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; min-height:42px; background:#ffffff;">
                    ${compatChips || '<span style="font-size:12px; color:#9ca3af;">未选择（点击下方按钮添加）</span>'}
                </div>
                <div style="position:relative; margin-top:6px;">
                    <button type="button" id="lpBtnCompatDropdown" class="btn btn-sm" style="width:100%; justify-content:center;">
                        <i class="fa-solid fa-plus"></i> 选择模型
                        <span style="margin-left:auto; font-size:11px; color:#6b7280;">${b.compatible_models.length ? '已选 ' + b.compatible_models.length + ' 个' : ''}</span>
                    </button>
                    <div id="lpCompatDropdownMenu" style="display:none; position:absolute; top:100%; left:0; right:0; z-index:20; background:#ffffff; border:1px solid #d1d5db; border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.10); padding:6px 0; margin-top:4px; max-height:240px; overflow-y:auto;">
                        ${_adaptiveModelOptionsHtml}
                    </div>
                </div>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">推荐权重</label>
                <input id="lpInWeight" type="number" min="0" max="2" step="0.05" value="${b.recommended_weight}" style="${inputStyle()}; max-width:160px;" />
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">唤醒词（逗号分隔）</label>
                <div id="lpTriggerWrap" style="display:flex; flex-wrap:wrap; align-items:center; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; min-height:38px; background:#ffffff;">
                    ${triggerChips}
                    <input id="lpInTrigger" type="text" placeholder="输入 + Enter" style="border:none; outline:none; flex:1; min-width:120px; font-size:13px; padding:2px 4px; background:transparent;" />
                </div>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">推荐搭配 Lora</label>
                <div id="lpPairingsWrap" style="display:flex; flex-wrap:wrap; align-items:center; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; min-height:38px; background:#ffffff; gap:4px;"></div>
                <button type="button" id="lpBtnPickPairings" class="btn btn-sm" style="margin-top:6px;"><i class="fa-solid fa-plus"></i> 选择 Lora</button>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">示例提示词</label>
                <textarea id="lpInSample" rows="4" style="${inputStyle()}; resize:vertical; line-height:1.6; font-family:inherit;">${escapeHtml(b.sample_prompt || '')}</textarea>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">备注</label>
                <textarea id="lpInDesc" rows="2" style="${inputStyle()}; resize:vertical; line-height:1.5; font-family:inherit;">${escapeHtml(b.description || '')}</textarea>
            </div>

            <div style="margin-top:14px;">
                <label style="display:block; font-size:12px; color:#374151; margin-bottom:4px; font-weight:500;">封面图</label>
                <div style="display:flex; align-items:center; gap:10px;">
                    <div id="lpCoverPreview" style="width:64px; height:64px; background:#f3f4f6; border-radius:6px; overflow:hidden; display:flex; align-items:center; justify-content:center; flex-shrink:0; border:1px solid #e5e7eb;">
                        <i class="fa-solid fa-image" style="color:#d1d5db; font-size:20px;"></i>
                    </div>
                    <button type="button" id="lpBtnPickCover" class="btn btn-sm"><i class="fa-solid fa-folder-open"></i> 选择封面</button>
                    <button type="button" id="lpBtnClearCover" class="btn btn-sm" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca;"><i class="fa-solid fa-trash"></i> 清除</button>
                </div>
            </div>
        `;

        // 绑定
        if (!isEdit) {
            document.getElementById('lpBtnPickFile').addEventListener('click', onPickFile);
        }
        document.getElementById('lpBtnPickCover').addEventListener('click', onPickCover);
        document.getElementById('lpBtnClearCover').addEventListener('click', onClearCover);
        document.getElementById('lpBtnPickPairings').addEventListener('click', onPickPairings);
        bindCompatModelsMultiSelect();
        bindTriggerChips();
        renderPairingsChips();
        // 编辑模式下显示已有封面
        if (isEdit && b.id) loadCoverPreview(b.id);
        // 文本/数字输入实时刷到 buffer：renderEditForm 在 chip 增删、trigger Enter 等
        // 场景会被重入调用，重建 <input> 时会从 buffer 读 value——若不实时同步，
        // 用户在「显示名」里输的字符会被重建的 input 抹掉（也连带丢保存）。
        bindInputsToBuffer();
    }

    // 把表单输入实时同步到 _editBuffer，防止 renderEditForm 重入时丢字段。
    // 每次 renderEditForm 重建 innerHTML 后旧 input 会被丢弃、新 input 重新绑，无 listener 泄漏。
    function bindInputsToBuffer() {
        const dn = document.getElementById('lpInDisplayName');
        if (dn) dn.addEventListener('input', () => { if (_editBuffer) _editBuffer.display_name = dn.value; });
        const wt = document.getElementById('lpInWeight');
        if (wt) wt.addEventListener('input', () => { if (_editBuffer) _editBuffer.recommended_weight = wt.value; });
        const sp = document.getElementById('lpInSample');
        if (sp) sp.addEventListener('input', () => { if (_editBuffer) _editBuffer.sample_prompt = sp.value; });
        const ds = document.getElementById('lpInDesc');
        if (ds) ds.addEventListener('input', () => { if (_editBuffer) _editBuffer.description = ds.value; });
    }

    function inputStyle() {
        return 'width:100%; padding:8px 12px; background:#ffffff; color:#1f2937; border:1px solid #d1d5db; border-radius:6px; font-size:13px; box-sizing:border-box;';
    }

    async function loadCoverPreview(loraId) {
        const r = await api.loras.readCover(loraId);
        if (r && r.ok && r.url) {
            const el = document.getElementById('lpCoverPreview');
            if (el) el.innerHTML = `<img src="${escapeAttr(r.url)}" style="width:100%; height:100%; object-fit:cover; display:block;" />`;
        }
    }

    async function onPickFile() {
        const r = await api.loras.pickFile();
        if (!r || r.canceled) return;
        if (!r.ok) { showToast('选择失败: ' + (r.error || '未知'), 'error'); return; }
        _editBuffer._srcPath = r.path;
        _editBuffer._srcSize = r.size || 0;
        if (!_editBuffer.name) _editBuffer.name = r.name;
        const fn = document.getElementById('lpFileName');
        const fs2 = document.getElementById('lpFileSize');
        if (fn) fn.textContent = r.name;
        if (fs2) fs2.textContent = formatSize(r.size || 0);
    }

    async function onPickCover() {
        const r = await api.loras.pickCover();
        if (!r || r.canceled) return;
        if (!r.ok) { showToast('选择失败: ' + (r.error || '未知'), 'error'); return; }
        _editBuffer._coverPath = r.path;
        // 预览用 file:// URL（需要绝对路径；如果是 Windows 路径加 file:///）
        const url = 'file:///' + String(r.path).replace(/\\/g, '/');
        const el = document.getElementById('lpCoverPreview');
        if (el) el.innerHTML = `<img src="${escapeAttr(url)}" style="width:100%; height:100%; object-fit:cover; display:block;" />`;
    }

    async function onClearCover() {
        _editBuffer._coverPath = '';
        const el = document.getElementById('lpCoverPreview');
        if (el) el.innerHTML = '<i class="fa-solid fa-image" style="color:#d1d5db; font-size:20px;"></i>';
        // 如果是编辑模式且 buffer.id 存在，则同步清 DB 的 cover_image
        if (_editMode === 'edit' && _editBuffer && _editBuffer.id) {
            const r = await api.loras.clearCover(_editBuffer.id);
            if (r && r.ok) showToast('封面已清除', 'success');
        }
    }

    // ========== 「适配模型」多选下拉 ==========
    // checkbox 切换 → 直接更新 _editBuffer.compatible_models（数组去重）。
    // 点击 chip 上的 × → 从数组移除并重渲。
    function bindCompatModelsMultiSelect() {
        if (!_editBuffer) return;
        const btn = document.getElementById('lpBtnCompatDropdown');
        const menu = document.getElementById('lpCompatDropdownMenu');
        if (!btn || !menu) return;
        // 打开 / 关闭 dropdown
        const toggle = (force) => {
            const open = force != null ? force : (menu.style.display === 'none');
            menu.style.display = open ? 'block' : 'none';
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle();
        });
        // 点击外部关闭
        document.addEventListener('click', (e) => {
            if (menu.style.display === 'block' && !menu.contains(e.target) && e.target !== btn) {
                menu.style.display = 'none';
            }
        });
        // 选项 checkbox：toggle 选中
        menu.querySelectorAll('input[type="checkbox"][data-adaptive-model-checkbox]').length || initCheckboxes();

        function initCheckboxes() {
            // 第一次进入：给 checkbox 加 data attr + 同步初始 checked 状态
            menu.querySelectorAll('label[data-adaptive-model]').forEach(label => {
                const v = label.dataset.adaptiveModel;
                const cb = label.querySelector('input[type="checkbox"]');
                cb.dataset.adaptiveModelCheckbox = '1';
                cb.checked = _editBuffer.compatible_models.includes(v);
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        if (!_editBuffer.compatible_models.includes(v)) _editBuffer.compatible_models.push(v);
                    } else {
                        _editBuffer.compatible_models = _editBuffer.compatible_models.filter(x => x !== v);
                    }
                    renderEditForm();
                });
                // 点击 label 时（toggle 之外）也要能勾选
                label.addEventListener('click', (e) => {
                    if (e.target === cb) return;  // checkbox 自带 change，避免重复
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                });
            });
        }

        // 已选 chip 上的 × 按钮移除
        // 用事件委托到稳定的父节点 #lpCompatWrap：chip 内部的 × 是 <i class="fa-xmark">，
        // Font Awesome 会在渲染时把它替换成 <svg>，原先绑在 <i> 上的 listener 会成为孤儿。
        // 委托到父节点后，无论 FA 怎么替换子节点，删除逻辑仍然触发。
        // 用 dataset 标记去重，避免多次调用 bindCompatModelsMultiSelect 累积 listener。
        const wrap = document.getElementById('lpCompatWrap');
        if (wrap && !wrap.dataset.compatXDelegated) {
            wrap.dataset.compatXDelegated = '1';
            wrap.addEventListener('click', (e) => {
                const x = e.target && e.target.closest && e.target.closest('[data-remove-compat-value]');
                if (!x || !wrap.contains(x)) return;
                const v = x.dataset.removeCompatValue;
                _editBuffer.compatible_models = _editBuffer.compatible_models.filter(y => y !== v);
                renderEditForm();
            });
        }
    }

    // 唤醒词同理
    function flushTriggerInputToBuffer() {
        if (!_editBuffer) return;
        const input = document.getElementById('lpInTrigger');
        if (!input) return;
        const raw = (input.value || '').trim();
        if (!raw) return;
        const parts = raw.split(/[,,]/).map(s => s.trim()).filter(Boolean);
        const cur = (_editBuffer.trigger_words || '').split(',').map(s => s.trim()).filter(Boolean);
        let changed = false;
        for (const v of parts) {
            if (!cur.includes(v)) {
                cur.push(v);
                changed = true;
            }
        }
        if (changed) {
            _editBuffer.trigger_words = cur.join(',');
            input.value = '';
            renderEditForm();
        }
    }

    function bindTriggerChips() {
        const wrap = document.getElementById('lpTriggerWrap');
        const input = document.getElementById('lpInTrigger');
        if (!wrap || !input) return;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const v = input.value.trim();
                if (!v) return;
                const cur = (_editBuffer.trigger_words || '').split(',').map(s => s.trim()).filter(Boolean);
                if (!cur.includes(v)) {
                    cur.push(v);
                    _editBuffer.trigger_words = cur.join(',');
                }
                input.value = '';
                renderEditForm();
                setTimeout(() => { const i = document.getElementById('lpInTrigger'); if (i) i.focus(); }, 0);
            }
        });
        // 防御：blur 时 flush
        input.addEventListener('blur', () => flushTriggerInputToBuffer());
        wrap.querySelectorAll('[data-remove-trigger]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = Number(el.dataset.removeTrigger);
                const cur = (_editBuffer.trigger_words || '').split(',').map(s => s.trim()).filter(Boolean);
                cur.splice(idx, 1);
                _editBuffer.trigger_words = cur.join(',');
                renderEditForm();
            });
        });
    }

    function renderPairingsChips() {
        const wrap = document.getElementById('lpPairingsWrap');
        if (!wrap) return;
        const ids = _editBuffer.recommended_pairings || [];
        if (!ids.length) {
            wrap.innerHTML = '<span style="font-size:12px; color:#9ca3af;">未选择</span>';
            return;
        }
        wrap.innerHTML = '';
        ids.forEach((id, idx) => {
            const lora = _loras.find(l => l.id === id);
            const displayName = lora ? (lora.display_name || lora.name) : `#${id}`;
            const span = document.createElement('span');
            span.style.cssText = 'display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:#f3e8ff; color:#6b21a8; border-radius:3px; font-size:12px;';
            span.innerHTML = `${escapeHtml(displayName)} <i class="fa-solid fa-xmark" data-remove-pairing="${idx}" style="cursor:pointer; opacity:0.7;"></i>`;
            wrap.appendChild(span);
        });
        wrap.querySelectorAll('[data-remove-pairing]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = Number(el.dataset.removePairing);
                _editBuffer.recommended_pairings.splice(idx, 1);
                renderPairingsChips();
            });
        });
    }

    function onPickPairings() {
        openPairingPickerModal((selectedIds) => {
            _editBuffer.recommended_pairings = selectedIds;
            renderPairingsChips();
        }, _editBuffer.recommended_pairings || [], _editBuffer.id);
    }

    // ========== 推荐搭配多选 Modal ==========
    function openPairingPickerModal(cb, initialSelected, excludeLoraId) {
        _pairingPickerCallback = cb;
        let modal = document.getElementById('lpPairingPicker');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'lpPairingPicker';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:420; display:none; align-items:center; justify-content:center; padding:20px;';
            modal.innerHTML = `
                <div onclick="event.stopPropagation();" style="background:#ffffff; border-radius:10px; width:min(600px, 100%); max-height:80vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3); overflow:hidden;">
                    <div style="padding:14px 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; gap:12px;">
                        <h3 style="margin:0; flex:1; color:#1f2937; font-size:15px; font-weight:600;">选择推荐搭配</h3>
                        <input id="lpPickerSearch" type="text" placeholder="🔍 搜索" style="width:200px; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:12px;" />
                        <button id="lpPickerClose" class="btn btn-sm"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div id="lpPickerList" style="flex:1; overflow-y:auto; padding:12px;"></div>
                    <div style="padding:10px 18px; border-top:1px solid #e5e7eb; background:#f9fafb; display:flex; justify-content:space-between; align-items:center;">
                        <span id="lpPickerCount" style="font-size:12px; color:#6b7280;"></span>
                        <button id="lpPickerOk" class="btn btn-sm btn-primary"><i class="fa-solid fa-check"></i> 确定</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.addEventListener('click', () => closePairingPicker());
            modal.querySelector('#lpPickerClose').addEventListener('click', closePairingPicker);
            modal.querySelector('#lpPickerOk').addEventListener('click', () => {
                const checked = Array.from(document.querySelectorAll('#lpPickerList input[data-pick-id]:checked')).map(el => Number(el.dataset.pickId));
                if (_pairingPickerCallback) _pairingPickerCallback(checked);
                closePairingPicker();
            });
            const searchInput = modal.querySelector('#lpPickerSearch');
            let t = null;
            searchInput.addEventListener('input', () => {
                clearTimeout(t);
                t = setTimeout(() => renderPickerList(searchInput.value.trim().toLowerCase()), 100);
            });
        }
        // 暂存当前选中和排除 id
        modal._selectedIds = initialSelected.slice();
        modal._excludeId = excludeLoraId || null;
        renderPickerList('');
        modal.style.display = 'flex';
    }

    function renderPickerList(filter) {
        const list = document.getElementById('lpPickerList');
        const modal = document.getElementById('lpPairingPicker');
        if (!list || !modal) return;
        const excludeId = modal._excludeId;
        const selected = modal._selectedIds;
        let pool = _loras.filter(l => l.id !== excludeId);
        if (filter) {
            pool = pool.filter(l => (l.name || '').toLowerCase().includes(filter) || (l.display_name || '').toLowerCase().includes(filter));
        }
        if (!pool.length) {
            list.innerHTML = '<div style="color:#9ca3af; text-align:center; padding:30px;">无匹配</div>';
        } else {
            list.innerHTML = pool.map(l => {
                const typeObj = _types.find(t => t.id === l.lora_type) || { label: l.lora_type, icon: 'fa-tag' };
                const checked = selected.includes(l.id) ? 'checked' : '';
                return `
                    <label style="display:flex; align-items:center; padding:8px 10px; border-radius:6px; cursor:pointer; transition:background 0.1s;"
                           onmouseenter="this.style.background='#f9fafb';"
                           onmouseleave="this.style.background='transparent';">
                        <input type="checkbox" data-pick-id="${l.id}" ${checked} style="margin-right:10px; cursor:pointer;" />
                        <i class="fa-solid ${typeObj.icon}" style="margin-right:8px; color:#9ca3af;"></i>
                        <span style="flex:1; font-size:13px; color:#1f2937;">${escapeHtml(l.display_name || l.name)}</span>
                        <span style="font-size:11px; color:#9ca3af;">${escapeHtml(l.name)}</span>
                    </label>
                `;
            }).join('');
        }
        const count = document.getElementById('lpPickerCount');
        if (count) count.textContent = `已选 ${selected.length} 个`;
        list.querySelectorAll('input[data-pick-id]').forEach(el => {
            el.addEventListener('change', () => {
                const id = Number(el.dataset.pickId);
                if (el.checked) {
                    if (!modal._selectedIds.includes(id)) modal._selectedIds.push(id);
                } else {
                    modal._selectedIds = modal._selectedIds.filter(x => x !== id);
                }
                if (count) count.textContent = `已选 ${modal._selectedIds.length} 个`;
            });
        });
    }

    function closePairingPicker() {
        const modal = document.getElementById('lpPairingPicker');
        if (modal) modal.style.display = 'none';
        _pairingPickerCallback = null;
    }

    // ========== 保存（新建/编辑）==========
    async function onSaveLora() {
        if (!_editBuffer) return;
        // 唤醒词 input 仍是自由文本 + Enter 拆 chip 的模式，所以保存时保留 flushTriggerInputToBuffer，
        // 防止用户输入「a,b」不按 Enter 直接点保存丢字。
        flushTriggerInputToBuffer();
        // 适配模型已迁到 checkbox 多选下拉（在 bindCompatModelsMultiSelect 里即点即改 buffer），
        // 这里不需要再 flush 文本。
        // 收集字段
        _editBuffer.display_name = (document.getElementById('lpInDisplayName').value || '').trim();
        _editBuffer.lora_type = document.getElementById('lpInType').value;
        // base_model 在表单上不再有 input —— 新规约只用 compatible_models 枚举数组。
        // 为保持 DB 兼容，置为空字符串（lodrs-store 那侧 base_model 列 DEFAULT '' 没影响）。
        _editBuffer.base_model = '';
        _editBuffer.compatible_models = (_editBuffer.compatible_models || [])
            .map(s => String(s).trim())
            .filter(v => _ADAPTIVE_MODEL_OPTIONS.includes(v));  // 仅保留合法枚举值
        _editBuffer.recommended_weight = Number(document.getElementById('lpInWeight').value) || 1.0;
        _editBuffer.sample_prompt = document.getElementById('lpInSample').value || '';
        _editBuffer.description = document.getElementById('lpInDesc').value || '';

        const btn = document.getElementById('lpEditBtnSave');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...'; }
        try {
            let record;
            if (_editMode === 'create') {
                if (!_editBuffer._srcPath) throw new Error('请先选择 Lora 文件');
                if (!_editBuffer.name) _editBuffer.name = _editBuffer._srcPath.split(/[\\/]/).pop();
                const meta = {
                    name: _editBuffer.name,
                    display_name: _editBuffer.display_name,
                    lora_type: _editBuffer.lora_type,
                    base_model: _editBuffer.base_model,
                    compatible_models: _editBuffer.compatible_models,
                    recommended_weight: _editBuffer.recommended_weight,
                    recommended_pairings: _editBuffer.recommended_pairings,
                    trigger_words: _editBuffer.trigger_words,
                    sample_prompt: _editBuffer.sample_prompt,
                    description: _editBuffer.description,
                };
                const r = await api.loras.add({ meta, srcPath: _editBuffer._srcPath });
                if (!r || !r.ok) throw new Error((r && r.error) || '新建失败');
                record = r.lora;
                if (record._linkError) showToast('已入库，但链接到 ComfyUI 失败: ' + record._linkError, 'error');
            } else {
                const patch = {
                    display_name: _editBuffer.display_name,
                    lora_type: _editBuffer.lora_type,
                    base_model: _editBuffer.base_model,
                    compatible_models: _editBuffer.compatible_models,
                    recommended_weight: _editBuffer.recommended_weight,
                    recommended_pairings: _editBuffer.recommended_pairings,
                    trigger_words: _editBuffer.trigger_words,
                    sample_prompt: _editBuffer.sample_prompt,
                    description: _editBuffer.description,
                };
                const r = await api.loras.update({ id: _editBuffer.id, patch });
                if (!r || !r.ok) throw new Error((r && r.error) || '更新失败');
                record = r.lora;
            }
            // 封面处理
            if (_editBuffer._coverPath) {
                const cr = await api.loras.setCover({ id: record.id, srcPath: _editBuffer._coverPath });
                if (!cr || !cr.ok) throw new Error((cr && cr.error) || '封面上传失败');
            }
            showToast(_editMode === 'create' ? '已创建' : '已更新', 'success');
            closeEditModal();
            await reloadAll();
        } catch (e) {
            showToast('保存失败: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> 保存'; }
        }
    }

    // ========== utils ==========
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    function escapeAttr(s) { return escapeHtml(s); }
    function showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        console.log('[loras]', type || 'info', msg);
    }

    // ========== 暴露 ==========
    window.lorasPage = { open, close };
})();