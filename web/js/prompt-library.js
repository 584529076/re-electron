// prompt-library.js — 提示词库（tag 模型）
//
// 入口：window.promptLibrary.open() —— 由顶部导航「提示词库」按钮调用（script.js switchMainView）
//
// 页面结构（单列，无侧栏）：
//   promptLibraryPage
//   ├── pl-topbar   (标题 / 计数 / 新建提示词)
//   └── pl-body
//       ├── pl-toolbar  (搜索 + tag filter chips 横向滚动)
//       └── pl-grid     (提示词卡片网格；每个卡顶上是 tag pills)
//
// 数据层：api.promptLibrary.* (prompt_library_tags + prompt_library + prompt_library_tag_map)
//   与 NSFW 标签系统（prompt_menu / prompt_items）完全隔离，互不影响。

'use strict';

(function () {
    const api = window.api || {};

    // ========== 状态 ==========
    const _state = {
        tags: [],          // [{ id, name, count }]  —— id 在新模型下无意义，仅占位
        items: [],         // [{ id, title, content, tag_names: [], created_at, updated_at }]
        totalCount: 0,     // 条目总数（来自 tag:list.total；用于「全部」chip 计数）
        currentTagName: '', // '' = 全部；否则为标签名（按 name 索引，不再用 id）
        itemFilter: '',    // 搜索（title / content / tag_names 模糊匹配）
    };

    // ========== helpers ==========
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        let c = document.getElementById('plToastContainer');
        if (!c) {
            c = document.createElement('div');
            c.id = 'plToastContainer';
            c.style.cssText = 'position:fixed; top:80px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:8px;';
            document.body.appendChild(c);
        }
        const t = document.createElement('div');
        const bg = type === 'error' ? '#fee2e2' : type === 'success' ? '#dcfce7' : '#e0e7ff';
        const fg = type === 'error' ? '#dc2626' : type === 'success' ? '#059669' : '#4338ca';
        const bd = type === 'error' ? '#fecaca' : type === 'success' ? '#bbf7d0' : '#c7d2fe';
        t.style.cssText = `padding:10px 16px; background:${bg}; color:${fg}; border:1px solid ${bd}; border-radius:6px; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,.08);`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2400);
        setTimeout(() => t.remove(), 2800);
    }

    function fmtDate(ts) {
        if (!ts) return '';
        const d = new Date(Number(ts) * 1000);
        if (isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function tagByName(name) { return _state.tags.find(t => t.name === name) || null; }

    // ========== 入口 ==========
    function open() {
        if (!document.getElementById('promptLibraryPage')) createPage();
        const page = document.getElementById('promptLibraryPage');
        if (page) page.hidden = false;
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
        // 每次进入都重置搜索 + 当前 tag（确保数据最新）
        _state.itemFilter = '';
        const searchInput = document.getElementById('plSearchInput');
        if (searchInput) searchInput.value = '';
        reloadAll();
        try { window.dispatchEvent(new CustomEvent('promptLibrary:opened')); } catch (e) {}
    }

    function close() {
        const page = document.getElementById('promptLibraryPage');
        if (page) page.hidden = true;
        const main = document.querySelector('main');
        if (main) main.style.display = '';
        try { window.dispatchEvent(new CustomEvent('promptLibrary:closed')); } catch (e) {}
    }

    function isOpen() {
        const page = document.getElementById('promptLibraryPage');
        return !!(page && !page.hidden);
    }

    // ========== DOM 骨架 ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'promptLibraryPage';
        page.className = 'prompt-library-page';
        page.hidden = true;
        page.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
        page.innerHTML = `
            <div class="pl-topbar">
                <h2 class="set-topbar-title"><i class="fa-solid fa-bookmark" style="color:#6366f1;"></i> 提示词库</h2>
                <span id="plHeaderSub" class="set-topbar-sub"></span>
                <span class="set-topbar-spacer"></span>
                <input id="plSearchInput" class="pl-search-input-topbar" type="text" placeholder="搜索标题 / 内容 / 标签…" autocomplete="off">
                <span class="set-topbar-actions">
                    <button id="plBtnNewItem" class="btn btn-sm btn-primary"><i class="fa-solid fa-plus"></i> 新建提示词</button>
                </span>
            </div>
            <div class="pl-body">
                <div class="pl-toolbar">
                    <div id="plTagChips" class="pl-tag-chips"></div>
                </div>
                <div id="plGrid" class="pl-grid"></div>
            </div>
        `;
        document.body.appendChild(page);

        page.querySelector('#plBtnNewItem').addEventListener('click', () => openItemModal(null));

        const search = page.querySelector('#plSearchInput');
        search.addEventListener('input', () => {
            _state.itemFilter = search.value.trim().toLowerCase();
            renderItems();
        });
    }

    // ========== 数据加载 ==========
    async function loadTags() {
        if (!api.promptLibrary || !api.promptLibrary.tagList) { _state.tags = []; _state.totalCount = 0; return; }
        const r = await api.promptLibrary.tagList();
        _state.tags = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        _state.totalCount = (r && r.ok && Number(r.total)) || 0;
        if (r && !r.ok) showToast(r.error || '加载标签失败', 'error');
    }

    async function loadItems() {
        if (!api.promptLibrary || !api.promptLibrary.itemList) { _state.items = []; return; }
        const r = await api.promptLibrary.itemList(_state.currentTagName || '');
        _state.items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        if (r && !r.ok) showToast(r.error || '加载提示词失败', 'error');
    }

    async function reloadAll() {
        await loadTags();
        // 当前选中的 tag 若已被删（从 tags 列表里找不到了），回退到「全部」
        if (_state.currentTagName && !tagByName(_state.currentTagName)) _state.currentTagName = '';
        await loadItems();
        renderTagChips();
        renderItems();
        renderHeaderSub();
    }

    function renderHeaderSub() {
        const el = document.getElementById('plHeaderSub');
        if (!el) return;
        const tagLabel = _state.currentTagName
            ? `· 当前标签：${_state.currentTagName}`
            : '';
        el.textContent = `${_state.tags.length} 个标签 · ${_state.items.length} 条提示词 ${tagLabel}`.trim();
    }

    // ========== Tag filter chips ==========
    function renderTagChips() {
        const box = document.getElementById('plTagChips');
        if (!box) return;
        const sorted = [..._state.tags].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
        // 「全部」计数用条目总数，不能用 tag 出现次数之和（一条多 tag 会重复计数）
        const items = [{ name: '', label: '全部', count: _state.totalCount }, ...sorted.map(t => ({ name: t.name, label: t.name, count: t.count }))];
        box.innerHTML = items.map(t => {
            const active = (_state.currentTagName || '') === t.name ? ' active' : '';
            const dataName = escapeHtml(t.name);
            const icon = t.name === '' ? 'fa-layer-group' : 'fa-tag';
            return `<button class="pl-tag-chip${active}" data-tag-name="${dataName}"><i class="fa-solid ${icon}"></i>${escapeHtml(t.label)}<span class="pl-tag-chip-count">${t.count || 0}</span></button>`;
        }).join('');
        box.querySelectorAll('.pl-tag-chip').forEach(el => {
            el.addEventListener('click', () => selectTag(el.dataset.tagName || ''));
        });
    }

    async function selectTag(name) {
        if ((_state.currentTagName || '') === (name || '')) return;
        _state.currentTagName = name || '';
        await loadItems();
        renderTagChips();
        renderItems();
        renderHeaderSub();
    }

    // ========== 卡片网格 ==========
    function filteredItems() {
        const f = _state.itemFilter;
        if (!f) return _state.items;
        return _state.items.filter(it =>
            String(it.prompt_zh || '').toLowerCase().includes(f) ||
            String(it.prompt_en || '').toLowerCase().includes(f) ||
            (Array.isArray(it.tag_names) && it.tag_names.some(t => t.toLowerCase().includes(f))));
    }

    function renderItems() {
        const grid = document.getElementById('plGrid');
        if (!grid) return;
        grid.innerHTML = '';
        const list = filteredItems();

        if (!_state.items.length) {
            grid.appendChild(buildEmpty({
                icon: 'fa-bookmark',
                title: '还没有任何提示词',
                desc: '把好用的 AI 生图提示词存下来，方便复盘复用',
                btn: '新建第一条',
                onClick: () => openItemModal(null),
            }));
            return;
        }
        if (!list.length) {
            grid.appendChild(buildEmpty({
                icon: 'fa-magnifying-glass',
                title: '没有匹配的提示词',
                desc: '换个关键词试试，或清空搜索框',
                btn: null,
            }));
            return;
        }

        for (const it of list) {
            grid.appendChild(buildCard(it));
        }
    }

    function buildCard(it) {
        const card = document.createElement('div');
        card.className = 'pl-prompt-card';
        const tagPillsHTML = (it.tag_names || []).map(t =>
            `<span class="pl-prompt-tag" data-tag-name="${escapeHtml(t)}" title="按此标签筛选">${escapeHtml(t)}</span>`
        ).join('');

        // 中/英两段；为空则不渲染该段
        const sections = [];
        if (it.prompt_zh && it.prompt_zh.trim()) {
            sections.push(buildSectionHTML('zh', '中文', it.prompt_zh));
        }
        if (it.prompt_en && it.prompt_en.trim()) {
            sections.push(buildSectionHTML('en', 'English', it.prompt_en));
        }
        if (!sections.length) {
            sections.push('<div class="pl-prompt-empty">（暂无内容）</div>');
        }

        card.innerHTML = `
            <div class="pl-prompt-card-head">
                <div class="pl-prompt-tags">${tagPillsHTML || '<span class="pl-prompt-tags-empty">无标签</span>'}</div>
                <div class="pl-prompt-actions">
                    <button class="pl-prompt-action-btn" data-act="edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    <button class="pl-prompt-action-btn" data-act="del" title="删除"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="pl-prompt-sections">${sections.join('')}</div>
            <div class="pl-prompt-meta"><i class="fa-regular fa-clock"></i> ${fmtDate(it.updated_at || it.created_at)}</div>
        `;

        card.addEventListener('click', e => {
            const actBtn = e.target.closest('[data-act]');
            if (actBtn) {
                const act = actBtn.dataset.act;
                if (act === 'edit') openItemModal(it);
                else if (act === 'del') deleteItem(it);
                return;
            }
            // 段内复制按钮：data-lang 标记 zh / en
            const langBtn = e.target.closest('[data-lang]');
            if (langBtn) {
                e.stopPropagation();
                copyLang(it, langBtn.dataset.lang);
                return;
            }
            // 段内展开/收起：data-toggle
            const togBtn = e.target.closest('[data-toggle]');
            if (togBtn) {
                e.stopPropagation();
                const sec = togBtn.closest('.pl-prompt-section');
                if (sec) sec.classList.toggle('expanded');
                return;
            }
            const tagEl = e.target.closest('.pl-prompt-tag');
            if (tagEl) {
                e.stopPropagation();
                filterByTagName(tagEl.dataset.tagName);
            }
        });
        return card;
    }

    // 单段（中或英）HTML；折叠时显示 5 行预览 + 渐隐遮罩，展开后看完整
    function buildSectionHTML(lang, label, content) {
        return `
            <div class="pl-prompt-section" data-lang="${lang}">
                <div class="pl-prompt-section-head">
                    <span class="pl-prompt-section-lang">${escapeHtml(label)}</span>
                    <span class="pl-prompt-section-spacer"></span>
                    <button class="pl-prompt-section-btn" data-toggle="body" title="展开/收起"><i class="fa-solid fa-chevron-down"></i></button>
                    <button class="pl-prompt-section-btn" data-lang="${lang}" title="复制${escapeHtml(label)}"><i class="fa-solid fa-copy"></i></button>
                </div>
                <pre class="pl-prompt-section-body">${escapeHtml(content)}</pre>
            </div>
        `;
    }

    async function copyLang(it, lang) {
        const text = (lang === 'zh') ? (it.prompt_zh || '') : (it.prompt_en || '');
        if (!text) { showToast('该段为空，无内容可复制', 'error'); return; }
        try {
            await navigator.clipboard.writeText(text);
            showToast(lang === 'zh' ? '中文已复制' : 'English copied', 'success');
        } catch (e) {
            showToast('复制失败：' + (e.message || e), 'error');
        }
    }

    function buildEmpty({ icon, title, desc, btn, onClick }) {
        const box = document.createElement('div');
        box.className = 'pl-empty';
        box.innerHTML = `
            <i class="fa-solid ${icon}"></i>
            <div class="pl-empty-title">${escapeHtml(title)}</div>
            <div class="pl-empty-desc">${escapeHtml(desc)}</div>
        `;
        if (btn) {
            const b = document.createElement('button');
            b.className = 'pl-empty-btn';
            b.innerHTML = `<i class="fa-solid fa-plus"></i> ${escapeHtml(btn)}`;
            b.addEventListener('click', onClick);
            box.appendChild(b);
        }
        return box;
    }

    async function filterByTagName(name) {
        // 直接用 name 索引（大小写不敏感匹配到 tags 列表里）
        const tag = _state.tags.find(t => t.name.toLowerCase() === String(name || '').toLowerCase());
        if (!tag) return;
        await selectTag(tag.name);
        // 清空搜索框，避免搜索过滤叠加导致误以为没数据
        const search = document.getElementById('plSearchInput');
        if (search) { search.value = ''; _state.itemFilter = ''; renderItems(); }
    }

    // ========== Tag 输入控件（pill + autocomplete 下拉）==========
    // 挂载到指定 container 内。available: [{ id, name, count }]，selected: string[]
    // 设计要点：
    //   - input 元素只创建一次，永不销毁（避免 innerHTML 把 input 干掉再重建的焦点丢失问题）
    //   - pills 是 display 容器里 input 之前的兄弟节点；增删 pill 不动 input
    //   - 状态：tagState.selected（最终保存的依据），永远是真值
    function mountTagInput({ container, available, selected }) {
        // 清空容器，注入结构
        container.innerHTML = '';
        container.className = 'pl-tag-input';
        const display = document.createElement('div');
        display.className = 'pl-tag-input-pills';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pl-tag-input-field';
        input.autocomplete = 'off';
        input.placeholder = '输入标签后回车，或点下方选择已有标签';
        display.appendChild(input);
        const dropdown = document.createElement('div');
        dropdown.className = 'pl-tag-dropdown';
        dropdown.hidden = true;
        container.appendChild(display);
        container.appendChild(dropdown);

        const tagState = {
            selected: [...selected],
            query: '',
            highlight: -1,
            filtered: [],
        };

        function rebuildPills() {
            // 移除 display 里现有的所有 pill（不动 input）
            display.querySelectorAll('.pl-tag-pill').forEach(el => el.remove());
            // 在 input 之前插入新 pill（顺序按 selected 数组）
            for (const name of tagState.selected) {
                const pill = document.createElement('span');
                pill.className = 'pl-tag-pill';
                pill.dataset.name = name;
                const text = document.createElement('span');
                text.className = 'pl-tag-pill-text';
                text.textContent = name;
                pill.appendChild(text);
                const x = document.createElement('button');
                x.type = 'button';
                x.className = 'pl-tag-pill-x';
                x.setAttribute('aria-label', '移除标签');
                x.textContent = '×';
                pill.appendChild(x);
                display.insertBefore(pill, input);
            }
            input.placeholder = tagState.selected.length ? '继续输入…' : '输入标签后回车，或点下方选择已有标签';
        }

        function rebuildDropdown() {
            dropdown.innerHTML = '';
            if (!tagState.filtered.length) { dropdown.hidden = true; return; }
            dropdown.hidden = false;
            tagState.filtered.forEach((t, i) => {
                const item = document.createElement('div');
                item.className = 'pl-tag-dropdown-item' + (i === tagState.highlight ? ' active' : '');
                item.dataset.idx = String(i);
                const label = document.createElement('span');
                label.className = 'pl-tag-dropdown-label';
                label.textContent = t.name;
                const count = document.createElement('span');
                count.className = 'pl-tag-dropdown-count';
                count.textContent = String(t.count || 0);
                item.appendChild(label);
                item.appendChild(count);
                // 用 mousedown 而非 click：避免 input blur 抢先关闭 dropdown
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    addTag(tagState.filtered[i].name);
                });
                item.addEventListener('mouseenter', () => {
                    tagState.highlight = i;
                    // 只更新高亮 class，避免重建 DOM 导致 mouseenter 抖动
                    dropdown.querySelectorAll('.pl-tag-dropdown-item').forEach((el, j) => {
                        el.classList.toggle('active', j === i);
                    });
                });
                dropdown.appendChild(item);
            });
        }

        function updateDropdown() {
            const q = tagState.query.toLowerCase().trim();
            const selLower = new Set(tagState.selected.map(s => s.toLowerCase()));
            tagState.filtered = available
                .filter(t => !selLower.has(String(t.name).toLowerCase()))
                .filter(t => !q || String(t.name).toLowerCase().includes(q))
                .slice(0, 8);
            rebuildDropdown();
        }

        function addTag(name) {
            const trimmed = String(name || '').trim();
            if (!trimmed) return;
            if (tagState.selected.some(s => s.toLowerCase() === trimmed.toLowerCase())) return;
            tagState.selected.push(trimmed);
            tagState.query = '';
            tagState.highlight = -1;
            input.value = '';
            rebuildPills();
            updateDropdown();
            // 保持焦点在 input，确保用户能连续输入
            input.focus();
        }

        function removeTag(name) {
            tagState.selected = tagState.selected.filter(s => s !== name);
            rebuildPills();
            updateDropdown();
        }

        function onKeyDown(e) {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                if (tagState.highlight >= 0 && tagState.filtered[tagState.highlight]) {
                    addTag(tagState.filtered[tagState.highlight].name);
                } else if (tagState.query.trim()) {
                    addTag(tagState.query.trim());
                }
            } else if (e.key === 'Backspace' && !tagState.query && tagState.selected.length) {
                e.preventDefault();
                tagState.selected.pop();
                rebuildPills();
                updateDropdown();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (tagState.filtered.length) {
                    tagState.highlight = Math.min(tagState.highlight + 1, tagState.filtered.length - 1);
                    rebuildDropdown();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (tagState.filtered.length) {
                    tagState.highlight = Math.max(tagState.highlight - 1, -1);
                    rebuildDropdown();
                }
            } else if (e.key === 'Escape') {
                dropdown.hidden = true;
            }
        }

        input.addEventListener('input', (e) => {
            tagState.query = e.target.value;
            tagState.highlight = -1;
            updateDropdown();
        });
        input.addEventListener('keydown', onKeyDown);
        input.addEventListener('focus', updateDropdown);

        // 点击 pill 上的 × 移除；点击其它区域把焦点交给 input
        display.addEventListener('click', (e) => {
            const btn = e.target.closest('.pl-tag-pill-x');
            if (btn) {
                const pill = btn.closest('.pl-tag-pill');
                if (pill && pill.dataset.name) removeTag(pill.dataset.name);
                return;
            }
            // 点击 pill 文本或空白 → focus 到 input
            if (e.target !== input) input.focus();
        });

        // 点外部关闭 dropdown
        function onDocMouseDown(e) {
            if (!container.contains(e.target)) dropdown.hidden = true;
        }
        document.addEventListener('mousedown', onDocMouseDown);

        // 初始渲染
        rebuildPills();
        updateDropdown();

        return {
            getSelected: () => [...tagState.selected],
            focus: () => input.focus(),
            destroy: () => document.removeEventListener('mousedown', onDocMouseDown),
        };
    }

    // ========== 提示词 CRUD ==========
    let _activeTagInput = null;

    function openItemModal(item) {
        const editing = !!item;
        const initialTags = editing ? (item.tag_names || []) : [];

        const overlay = buildModal({
            title: editing ? '编辑提示词' : '新建提示词',
            wide: true,
            body: `
                <label class="pl-field">
                    <span class="pl-field-label">中文提示词</span>
                    <textarea id="plItemZh" placeholder="如：电影感人像，夕阳侧逆光，胶片质感…" rows="6">${escapeHtml(editing ? (item.prompt_zh || '') : '')}</textarea>
                </label>
                <label class="pl-field">
                    <span class="pl-field-label">英文提示词</span>
                    <textarea id="plItemEn" placeholder="如：cinematic portrait, golden hour rim light, film grain…" rows="6">${escapeHtml(editing ? (item.prompt_en || '') : '')}</textarea>
                </label>
                <label class="pl-field">
                    <span class="pl-field-label">标签</span>
                    <div id="plTagInputMount"></div>
                    <span class="pl-field-hint">回车或逗号创建新标签；点击下拉列表复用已有标签；× 移除；Backspace 删最后一个</span>
                </label>
            `,
            onSubmit: async () => {
                const promptZh = overlay.querySelector('#plItemZh').value.trim();
                const promptEn = overlay.querySelector('#plItemEn').value.trim();
                const tagNames = _activeTagInput ? _activeTagInput.getSelected() : [];
                if (!promptZh && !promptEn) { showToast('中英文提示词至少填一个', 'error'); return false; }
                const payload = { prompt_zh: promptZh, prompt_en: promptEn, tag_names: tagNames };
                const r = editing
                    ? await api.promptLibrary.itemUpdate({ id: item.id, ...payload })
                    : await api.promptLibrary.itemAdd(payload);
                if (!r || !r.ok) { showToast((r && r.error) || '保存失败', 'error'); return false; }
                showToast(editing ? '提示词已更新' : '提示词已保存', 'success');
                await reloadAll();
                return true;
            },
            onClose: () => {
                if (_activeTagInput) { _activeTagInput.destroy(); _activeTagInput = null; }
            },
        });
        _activeTagInput = mountTagInput({
            container: overlay.querySelector('#plTagInputMount'),
            available: _state.tags,
            selected: initialTags,
        });
        // 默认焦点：标题输入框。但若用户已经点过 tag input（active 在 overlay 内）则不抢焦点。
        // 用 0ms 异步让 setSelected 链路先跑完
        setTimeout(() => {
            const active = document.activeElement;
            if (active && active !== document.body && overlay.contains(active)) return;
            const t = overlay.querySelector('#plItemZh');
            if (t) t.focus();
        }, 0);
    }

    async function deleteItem(item) {
        const preview = (item.prompt_zh || item.prompt_en || '').slice(0, 30);
        if (!confirm(`确定删除提示词「${preview}…」？`)) return;
        const r = await api.promptLibrary.itemDelete(item.id);
        if (!r || !r.ok) { showToast((r && r.error) || '删除失败', 'error'); return; }
        showToast('已删除', 'success');
        await reloadAll();
    }

    // ========== 通用 modal ==========
    function buildModal({ title, body, onSubmit, onClose, wide }) {
        const overlay = document.createElement('div');
        overlay.className = 'pl-modal-overlay';
        overlay.innerHTML = `
            <div class="pl-modal${wide ? ' pl-modal-wide' : ''}">
                <div class="pl-modal-head">
                    <span>${escapeHtml(title)}</span>
                    <button class="pl-modal-close" type="button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="pl-modal-body">${body}</div>
                <div class="pl-modal-foot">
                    <button class="btn btn-sm" data-act="cancel">取消</button>
                    <button class="btn btn-sm btn-primary" data-act="ok">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        function destroy() {
            document.removeEventListener('keydown', onKey);
            if (onClose) try { onClose(); } catch (e) {}
            overlay.remove();
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.stopPropagation(); destroy(); }
        }
        document.addEventListener('keydown', onKey);

        overlay.addEventListener('click', e => {
            if (e.target === overlay) destroy();
        });
        overlay.querySelector('.pl-modal-close').addEventListener('click', destroy);
        overlay.querySelector('[data-act="cancel"]').addEventListener('click', destroy);

        const okBtn = overlay.querySelector('[data-act="ok"]');
        okBtn.addEventListener('click', async () => {
            okBtn.disabled = true;
            try {
                const done = await onSubmit();
                if (done) destroy();
            } catch (e) {
                showToast('保存失败：' + (e.message || e), 'error');
            } finally {
                okBtn.disabled = false;
            }
        });
        // 单行 INPUT 回车提交；textarea 内 Ctrl/Cmd+Enter 提交（普通 Enter 是换行）
        overlay.addEventListener('keydown', e => {
            if (e.target.classList && e.target.classList.contains('pl-tag-input-field')) return;
            if (e.target.tagName === 'INPUT') {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    okBtn.click();
                }
            } else if (e.target.tagName === 'TEXTAREA') {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    okBtn.click();
                }
            }
        });
        return overlay;
    }

    // ========== 暴露 ==========
    window.promptLibrary = { open, close, isOpen };
})();