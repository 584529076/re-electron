// workbench-loras.js — 工作台 LORA 模块（独立于右栏其他参数）
//
// 用途：把工具 schema 中的 lora + loraMulti 字段集中到一个统一模块，
//       替代原本零散分散在右栏的「select + chip」控件。
// 入口：window.workbenchLoras.mount(toolDetail, displayModels, paramsContainer)
//
// 视觉：
//   LORA 模块（独立卡片，在右栏最顶部）
//   ├── 标题 LORA
//   ├── 字段 1（label）
//   │   ├── 已选预览 chips（封面 + 名字 + 权重 + 删除）：一排多个，超出换行
//   │   └── [+ 选择 Lora] 按钮
//   ├── 字段 2 ...（多字段并列时也按"字段分组"堆叠）
//   └── 全局 [清空] 按钮（可选）
//
// 弹框：
//   ├── 顶部 标题 + 搜索 + 关闭
//   ├── 分类 tabs：全部 / 人物卡 / 服装卡 / ...
//   ├── 主体 cover grid（封面 + 名字 + 复选框，多选）
//   └── 底部 已选 N 个 + 确定
//
// 状态：读写都走 window.aiToolsEmbedded 提供的 getLoraMultiState / setLoraMultiState
//       / getLoraSingleState / setLoraSingleState，原始 DOM 与 _loraMultiState 自动同步。
'use strict';

(function () {
    const api = window.api || {};
    const dUtil = window.dUtil || { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) };
    const { escapeHtml, escapeAttr } = dUtil;
    const aiTools = window.aiToolsEmbedded || {};

    // Lora 分类（与 loras.js 保持一致，但内置在模块内不依赖外部模块）。
    // 渲染顺序按「常用在前」排列，第一个「全部」是默认 tab。
    // "compatible" 是虚拟分类：按当前工具 schema.models 过滤的子集，
    // 设为占位符 '__compatible'，renderPickerTabs 时按 displayModels 动态计算 count。
    const LORA_TYPES = [
        { id: '',            label: '全部',     icon: 'fa-layer-group' },
        { id: '__compatible', label: '推荐',    icon: 'fa-wand-magic-sparkles' },
        { id: 'character',   label: '人物卡',   icon: 'fa-user' },
        { id: 'clothing',    label: '服装卡',   icon: 'fa-shirt' },
        { id: 'animal',      label: '动物卡',   icon: 'fa-paw' },
        { id: 'body_part',   label: '人体部位', icon: 'fa-hand' },
        { id: 'pose',        label: '姿势卡',   icon: 'fa-person-walking' },
        { id: 'concept',     label: '概念卡',   icon: 'fa-lightbulb' },
        { id: 'style',       label: '风格卡',   icon: 'fa-palette' },
        { id: 'general',     label: '通用',     icon: 'fa-globe' },
    ];

    // ========== 状态 ==========
    const _state = {
        toolDetail: null,        // 当前工具 schema
        displayModels: [],       // 用于按模型过滤 lora 列表
        loraFields: [],          // [{ id, type, label, multi, weightEditable }]
        loraCache: [],           // 全部 lora（cover 通过 loras:readCover 异步取）
        coverCache: {},          // id -> { url, loading, error }
        picker: {
            open: false,
            fieldId: null,        // 正在编辑的字段 id
            fieldType: null,     // 'lora' | 'loraMulti'
            fieldMulti: false,   // true = loraMulti，可多选；false = lora，单选
            typeFilter: '',      // 当前选中的分类 tab
            search: '',
            selectedIds: [],      // 当前弹框里的临时选中
        },
    };

    // ========== 工具 ==========
    function _showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        console.log('[workbench-loras]', type || 'info', msg);
    }

    function _fmtWeight(w) {
        if (typeof w !== 'number' || !Number.isFinite(w)) return '';
        const s = w.toFixed(2).replace(/\.?0+$/, '');
        return s || '1';
    }

    // 读取字段当前选中（返回 [{id, weight}] 数组）
    function _readFieldSelected(field) {
        if (field.type === 'loraMulti') {
            const arr = aiTools.getLoraMultiState ? aiTools.getLoraMultiState(field.id) : [];
            return arr.map(x => ({ id: Number(x.id), weight: x.weight }));
        }
        // lora 单选
        if (field.type === 'lora' && aiTools.getLoraSingleState) {
            const s = aiTools.getLoraSingleState(field.id);
            if (!s.id) return [];
            return [{ id: Number(s.id), weight: s.weight }];
        }
        return [];
    }

    function _writeFieldSelected(field, items) {
        if (field.type === 'loraMulti') {
            aiTools.setLoraMultiState(field.id, items);
            return;
        }
        // lora 单选：取第一项
        if (field.type === 'lora') {
            const it = items[0] || {};
            aiTools.setLoraSingleState(field.id, { id: it.id || null, weight: it.weight != null ? it.weight : null });
            return;
        }
    }

    // ========== 入口：把 LORA 模块挂到右栏 ==========
    // paramsContainer：#dwpFormParams 节点（模块会插到容器最顶部）
    function mount(toolDetail, displayModels, paramsContainer) {
        if (!paramsContainer) return;
        _state.toolDetail = toolDetail;
        _state.displayModels = Array.isArray(displayModels) ? displayModels : [];
        _state.loraFields = (toolDetail && toolDetail.formFields || [])
            .filter(f => f && (f.type === 'lora' || f.type === 'loraMulti'))
            .map(f => ({
                id: f.id,
                type: f.type,
                label: f.label || f.id,
                multi: f.type === 'loraMulti',
                weightEditable: f.type === 'loraMulti', // 单选 lora 的权重由 schema.defaultWeight 控制，不开放编辑
            }));
        // 没有 lora 字段就直接不渲染（保持右栏原样）
        if (!_state.loraFields.length) {
            unmount(paramsContainer);
            return;
        }
        _ensureHost(paramsContainer);
        _reloadLoraList().then(() => {
            _renderSection();
        });
    }

    function unmount(paramsContainer) {
        const old = document.getElementById('dwpLoraModuleHost');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        _state.toolDetail = null;
        _state.loraFields = [];
    }

    function _ensureHost(container) {
        let host = document.getElementById('dwpLoraModuleHost');
        if (!host) {
            host = document.createElement('div');
            host.id = 'dwpLoraModuleHost';
            host.className = 'dwp-lora-module';
            // 插到容器最顶部
            if (container.firstChild) {
                container.insertBefore(host, container.firstChild);
            } else {
                container.appendChild(host);
            }
        }
        host.innerHTML = '';
        // 标题
        const title = document.createElement('div');
        title.className = 'dwp-lora-module-title';
        title.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i><span>LORA</span>';
        host.appendChild(title);
    }

    async function _reloadLoraList() {
        // 永远加载全量 lora（picker 顶部「全部」tab 需要看到所有 lora）。
        // "推荐" tab 会按 displayModels 二次过滤（不修改 cache，只过滤 pool）。
        // 这样跟 loras.js 库页面一致：默认看全量，想筛选再切 tab。
        try {
            if (!api.loras || typeof api.loras.list !== 'function') {
                _state.loraCache = [];
                return;
            }
            const r = await api.loras.list({ limit: 100000 });
            if (r && r.ok && Array.isArray(r.loras)) {
                _state.loraCache = r.loras;
            } else {
                _state.loraCache = [];
                if (r && r.error) console.warn('[workbench-loras] lora 列表为空:', r.error);
            }
        } catch (e) {
            console.warn('[workbench-loras] 加载 lora 列表失败:', e && e.message);
            _state.loraCache = [];
        }
    }

    // 判断 lora 是否与当前工具的 displayModels 兼容
    // 兼容条件：lora_type === 'general' || base_model ∈ displayModels
    //          || compatible_models 与 displayModels 有交集
    function _isCompatibleWithTool(lora) {
        const targets = _state.displayModels || [];
        if (!targets.length) return true; // 没指定模型 = 全部视为兼容
        if ((lora.lora_type || 'general') === 'general') return true;
        if (targets.includes(lora.base_model)) return true;
        const cm = Array.isArray(lora.compatible_models) ? lora.compatible_models : [];
        return cm.some(m => targets.includes(m));
    }

    // ========== 渲染：每个 lora 字段一个 slot ==========
    function _renderSection() {
        const host = document.getElementById('dwpLoraModuleHost');
        if (!host) return;
        // 清掉旧的 slot 行（保留 title）
        host.querySelectorAll('.dwp-lora-slot').forEach(n => n.remove());

        for (const field of _state.loraFields) {
            const slot = document.createElement('div');
            slot.className = 'dwp-lora-slot';
            slot.dataset.fieldId = field.id;
            slot.innerHTML = `
                    <div class="dwp-lora-slot-head">
                        <span class="dwp-lora-slot-label">${escapeHtml(field.label)}${field.multi ? '' : ' <em style="color:#9ca3af; font-style:normal; font-size:11px;">（单选）</em>'}</span>
                        <div class="dwp-lora-slot-actions">
                            ${field.multi ? `<button type="button" class="dwp-lora-clear-btn" title="清空已选"><i class="fa-solid fa-trash-can"></i></button>` : ''}
                            <button type="button" class="dwp-lora-pick-btn btn btn-primary" type="button"><i class="fa-solid fa-plus"></i> 选择 Lora</button>
                        </div>
                    </div>
                    <div class="dwp-lora-slot-cards"></div>
                `;
            host.appendChild(slot);

            const cardsBox = slot.querySelector('.dwp-lora-slot-cards');
            const pickBtn = slot.querySelector('.dwp-lora-pick-btn');
            const clearBtn = slot.querySelector('.dwp-lora-clear-btn');

            pickBtn.addEventListener('click', () => _openPicker(field));
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    _writeFieldSelected(field, []);
                    _renderSlotCards(field, cardsBox);
                });
            }
            _renderSlotCards(field, cardsBox);
        }
    }

    function _renderSlotCards(field, cardsBox) {
        if (!cardsBox) return;
        cardsBox.innerHTML = '';
        const items = _readFieldSelected(field);
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'dwp-lora-empty';
            empty.innerHTML = '<i class="fa-regular fa-circle-dot"></i> 未选择 Lora';
            cardsBox.appendChild(empty);
            return;
        }
        for (const it of items) {
            const lora = _state.loraCache.find(l => Number(l.id) === Number(it.id));
            const card = document.createElement('div');
            card.className = 'dwp-lora-card';
            const loraType = lora ? (lora.lora_type || 'general') : '';
            const displayName = lora ? (lora.display_name || lora.name || `#${it.id}`) : `#${it.id}`;
            card.dataset.loraId = it.id;
            // 紧凑两行布局：上方一行 = 小封面 + 名字/类型，删除按钮 absolute 顶右角；
            // 下方一行 = 整行权重输入。X 和权重在物理上分两行，互不重叠。
            card.innerHTML = `
                    <div class="dwp-lora-card-top">
                        <div class="dwp-lora-card-cover" data-lora-cover-id="${it.id}">
                            <i class="fa-solid fa-image"></i>
                        </div>
                        <div class="dwp-lora-card-info">
                            <div class="dwp-lora-card-name" title="${escapeAttr(lora ? (lora.name || '') : '')}">${escapeHtml(displayName)}</div>
                            <div class="dwp-lora-card-meta">${escapeHtml(_labelOfType(loraType))}</div>
                        </div>
                    </div>
                    ${field.weightEditable ? `
                    <div class="dwp-lora-card-weight-row">
                        <span class="dwp-lora-card-weight-label">权重</span>
                        <input type="number" class="dwp-lora-card-weight" step="0.05" min="0" max="2" value="${it.weight != null ? escapeAttr(String(it.weight)) : ''}" placeholder="推荐值" title="权重（覆盖 lora.recommended_weight）" />
                    </div>
                    ` : ''}
                    <button type="button" class="dwp-lora-card-remove" title="移除"><i class="fa-solid fa-xmark"></i></button>
                `;
            cardsBox.appendChild(card);

            // 异步加载封面
            _fillCover(card.querySelector('[data-lora-cover-id]'), it.id);

            // 事件
            card.querySelector('.dwp-lora-card-remove').addEventListener('click', () => {
                const cur = _readFieldSelected(field);
                _writeFieldSelected(field, cur.filter(x => Number(x.id) !== Number(it.id)));
                _renderSlotCards(field, cardsBox);
            });
            if (field.weightEditable) {
                const wInp = card.querySelector('.dwp-lora-card-weight');
                wInp.addEventListener('change', () => {
                    const cur = _readFieldSelected(field);
                    const item = cur.find(x => Number(x.id) === Number(it.id));
                    if (!item) return;
                    if (wInp.value === '' || wInp.value == null) {
                        item.weight = undefined;
                    } else {
                        const w = Number(wInp.value);
                        if (Number.isFinite(w) && w >= 0) item.weight = w;
                    }
                    // 写回（loraMulti 走 setLoraMultiState，单选不开放权重，跳过）
                    if (field.type === 'loraMulti') {
                        aiTools.setLoraMultiState(field.id, cur);
                    }
                });
            }
        }
    }

    function _fillCover(hostEl, loraId) {
        if (!hostEl || !api.loras || typeof api.loras.readCover !== 'function') return;
        const cached = _state.coverCache[loraId];
        if (cached && cached.url) {
            hostEl.innerHTML = `<img src="${escapeAttr(cached.url)}" alt="" />`;
            return;
        }
        if (cached && cached.loading) return; // 防抖
        _state.coverCache[loraId] = { loading: true };
        api.loras.readCover(loraId).then(r => {
            if (r && r.ok && r.url) {
                _state.coverCache[loraId] = { url: r.url };
                // hostEl 可能已被新卡片替换，只更新当前
                const cur = document.querySelector(`[data-lora-cover-id="${loraId}"]`);
                if (cur && !cur.querySelector('img')) {
                    cur.innerHTML = `<img src="${escapeAttr(r.url)}" alt="" />`;
                }
            } else {
                _state.coverCache[loraId] = { error: true };
            }
        }).catch(() => { _state.coverCache[loraId] = { error: true }; });
    }

    function _labelOfType(typeId) {
        const t = LORA_TYPES.find(x => x.id === typeId);
        return t ? t.label : (typeId || '通用');
    }

    // ========== 弹框 ==========
    function _openPicker(field) {
        _state.picker.fieldId = field.id;
        _state.picker.fieldType = field.type;
        _state.picker.fieldMulti = field.multi;
        _state.picker.typeFilter = '';
        _state.picker.search = '';
        // 单选预填：当前已选第一项；多选预填：当前全部
        _state.picker.selectedIds = _readFieldSelected(field).map(x => Number(x.id));

        _ensurePickerModal();
        _renderPickerTabs();
        _renderPickerList();
        const modal = document.getElementById('dwpLoraPicker');
        modal.style.display = 'flex';
        _state.picker.open = true;
        // 自动 focus 搜索框
        const s = modal.querySelector('#dwpLoraPickerSearch');
        if (s) setTimeout(() => s.focus(), 30);
    }

    function _closePicker() {
        const modal = document.getElementById('dwpLoraPicker');
        if (modal) modal.style.display = 'none';
        _state.picker.open = false;
    }

    function _ensurePickerModal() {
        let modal = document.getElementById('dwpLoraPicker');
        if (modal) return;
        modal = document.createElement('div');
        modal.id = 'dwpLoraPicker';
        modal.className = 'dwp-lora-picker';
        modal.innerHTML = `
            <div class="dwp-lora-picker-panel" onclick="event.stopPropagation();">
                <div class="dwp-lora-picker-head">
                    <div class="dwp-lora-picker-title"><i class="fa-solid fa-puzzle-piece"></i> 选择 Lora</div>
                    <input id="dwpLoraPickerSearch" type="text" placeholder="搜索名称 / 显示名" />
                    <button id="dwpLoraPickerClose" class="dwp-lora-picker-close" type="button"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div id="dwpLoraPickerTabs" class="dwp-lora-picker-tabs"></div>
                <div id="dwpLoraPickerGrid" class="dwp-lora-picker-grid"></div>
                <div class="dwp-lora-picker-foot">
                    <span id="dwpLoraPickerCount" class="dwp-lora-picker-count">已选 0 个</span>
                    <div class="dwp-lora-picker-foot-actions">
                        <button id="dwpLoraPickerClear" type="button" class="btn btn-sm">清空</button>
                        <button id="dwpLoraPickerOk" type="button" class="btn btn-sm btn-primary"><i class="fa-solid fa-check"></i> 确定</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // 事件
        modal.addEventListener('click', _closePicker);
        modal.querySelector('#dwpLoraPickerClose').addEventListener('click', _closePicker);
        modal.querySelector('#dwpLoraPickerOk').addEventListener('click', _onPickerOk);
        modal.querySelector('#dwpLoraPickerClear').addEventListener('click', () => {
            _state.picker.selectedIds = [];
            _renderPickerList();
        });
        let searchTimer = null;
        modal.querySelector('#dwpLoraPickerSearch').addEventListener('input', (e) => {
            clearTimeout(searchTimer);
            const v = e.target.value.trim().toLowerCase();
            searchTimer = setTimeout(() => {
                _state.picker.search = v;
                _renderPickerList();
            }, 100);
        });
    }

    function _renderPickerTabs() {
        const tabs = document.getElementById('dwpLoraPickerTabs');
        if (!tabs) return;
        const showCompatible = (_state.displayModels || []).length > 0;
        tabs.innerHTML = LORA_TYPES.filter(t => showCompatible || t.id !== '__compatible').map(t => {
            let count;
            if (!t.id) {
                count = _state.loraCache.length;
            } else if (t.id === '__compatible') {
                count = _state.loraCache.filter(_isCompatibleWithTool).length;
            } else {
                count = _state.loraCache.filter(l => (l.lora_type || 'general') === t.id).length;
            }
            const active = _state.picker.typeFilter === t.id;
            return `<button type="button" class="dwp-lora-picker-tab${active ? ' active' : ''}" data-type="${escapeAttr(t.id)}">
                <i class="fa-solid ${t.icon}"></i> ${escapeHtml(t.label)}
                <span class="dwp-lora-picker-tab-count">${count}</span>
            </button>`;
        }).join('');
        tabs.querySelectorAll('.dwp-lora-picker-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _state.picker.typeFilter = btn.dataset.type;
                _renderPickerTabs();
                _renderPickerList();
            });
        });
    }

    function _renderPickerList() {
        const grid = document.getElementById('dwpLoraPickerGrid');
        const count = document.getElementById('dwpLoraPickerCount');
        if (!grid) return;
        let pool = _state.loraCache.slice();
        const tf = _state.picker.typeFilter;
        if (tf === '__compatible') {
            pool = pool.filter(_isCompatibleWithTool);
        } else if (tf) {
            pool = pool.filter(l => (l.lora_type || 'general') === tf);
        }
        if (_state.picker.search) {
            const s = _state.picker.search;
            pool = pool.filter(l =>
                (l.name || '').toLowerCase().includes(s) ||
                (l.display_name || '').toLowerCase().includes(s)
            );
        }
        // 按 display_name / name 排序
        pool.sort((a, b) => {
            const an = (a.display_name || a.name || '').toLowerCase();
            const bn = (b.display_name || b.name || '').toLowerCase();
            return an.localeCompare(bn, 'zh');
        });
        if (!pool.length) {
            grid.innerHTML = '<div class="dwp-lora-picker-empty">无匹配 Lora</div>';
        } else {
            grid.innerHTML = pool.map(l => {
                const id = Number(l.id);
                const checked = _state.picker.selectedIds.includes(id);
                const meta = _labelOfType(l.lora_type) + (l.recommended_weight != null ? ' · 权 ' + _fmtWeight(l.recommended_weight) : '');
                return `
                    <label class="dwp-lora-picker-card${checked ? ' checked' : ''}" data-lora-id="${id}">
                        <input type="checkbox" data-pick-id="${id}" ${checked ? 'checked' : ''} />
                        <div class="dwp-lora-picker-card-cover" data-lora-cover-id="${id}">
                            <i class="fa-solid fa-image"></i>
                        </div>
                        <div class="dwp-lora-picker-card-info">
                            <div class="dwp-lora-picker-card-name">${escapeHtml(l.display_name || l.name)}</div>
                            <div class="dwp-lora-picker-card-meta">${escapeHtml(meta)}</div>
                        </div>
                    </label>
                `;
            }).join('');
            // 异步封面
            grid.querySelectorAll('[data-lora-cover-id]').forEach(el => {
                const id = Number(el.dataset.loraCoverId);
                _fillCover(el, id);
            });
            // 卡片是 <label> 包裹 <input type="checkbox">：
            //   - 点击卡片任何位置（封面、名字、meta）→ 浏览器原生把 click 转发给 checkbox，
            //     checkbox 切换 checked，change 事件冒泡上来 → _onPickerCheckChange 更新 state。
            //   - 直接点 checkbox → 同上路径。
            // 所以这里只需要监听 change，不要再额外绑 click，
            // 否则会「原生切一次 + 我的 listener 再切一次 = 还原」，看起来点了没反应。
            grid.querySelectorAll('input[data-pick-id]').forEach(cb => {
                cb.addEventListener('change', () => _onPickerCheckChange(cb));
            });
        }
        if (count) count.textContent = `已选 ${_state.picker.selectedIds.length} 个`;
    }

    function _onPickerCheckChange(cb) {
        const id = Number(cb.dataset.pickId);
        if (_state.picker.fieldMulti) {
            if (cb.checked) {
                if (!_state.picker.selectedIds.includes(id)) _state.picker.selectedIds.push(id);
            } else {
                _state.picker.selectedIds = _state.picker.selectedIds.filter(x => x !== id);
            }
        } else {
            // 单选：勾上时覆盖；取消勾选时清空（与原生 select 一致）
            if (cb.checked) {
                _state.picker.selectedIds = [id];
                // 同步 UI：把其他卡片的勾选去掉
                const grid = document.getElementById('dwpLoraPickerGrid');
                if (grid) {
                    grid.querySelectorAll('input[data-pick-id]').forEach(o => {
                        if (Number(o.dataset.pickId) !== id) o.checked = false;
                    });
                    grid.querySelectorAll('.dwp-lora-picker-card').forEach(c => {
                        c.classList.toggle('checked', Number(c.dataset.loraId) === id);
                    });
                }
            } else {
                _state.picker.selectedIds = [];
            }
        }
        // 高亮当前卡片
        const grid = document.getElementById('dwpLoraPickerGrid');
        if (grid) {
            const card = grid.querySelector(`.dwp-lora-picker-card[data-lora-id="${id}"]`);
            if (card) card.classList.toggle('checked', cb.checked);
        }
        const count = document.getElementById('dwpLoraPickerCount');
        if (count) count.textContent = `已选 ${_state.picker.selectedIds.length} 个`;
    }

    function _onPickerOk() {
        const fieldId = _state.picker.fieldId;
        const field = _state.loraFields.find(f => f.id === fieldId);
        if (!field) { _closePicker(); return; }
        // 组装新的 items（保留已存在的 weight）
        const prev = _readFieldSelected(field);
        const prevMap = new Map(prev.map(p => [Number(p.id), p]));
        const items = _state.picker.selectedIds.map(id => {
            const p = prevMap.get(Number(id));
            return { id: Number(id), weight: p && p.weight != null ? p.weight : undefined };
        });
        _writeFieldSelected(field, items);
        _closePicker();
        // 重新渲染对应 slot
        const slot = document.querySelector(`.dwp-lora-slot[data-field-id="${CSS.escape(fieldId)}"]`);
        if (slot) _renderSlotCards(field, slot.querySelector('.dwp-lora-slot-cards'));
    }

    // ========== 暴露 ==========
    window.workbenchLoras = {
        mount,
        unmount,
        refresh: () => _renderSection(),
    };
})();