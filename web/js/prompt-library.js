// prompt-library.js — 提示词配方库（内置配方只读 + 自定义配方增删改）
//
// 入口：window.promptLibrary.open() —— 由顶部导航「提示词库」按钮调用（script.js switchMainView）
// 保留原提示词库的菜单位置、页面外壳与开关生命周期；内容区为配方卡片。
// 数据来源：
//   - 内置配方：web/js/recipes-data.js → window.RECIPES_DATA.items（只读）
//   - 自定义配方：api.recipes.* → prompts.db 的 __custom_recipes__（可增删改，持久化）
//
// 历史：v1 曾存 localStorage['pl_custom_recipes_v1']，启动时自动迁移到 db。

'use strict';

(function () {
    const LS_KEY = 'pl_custom_recipes_v1';
    const api = window.api || {};

    const _state = { filter: '', custom: [], selectedId: '' };
    let _cpsDataCache = null;

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function showToast(msg, type) {
        if (window.showToast) { window.showToast(msg, type); return; }
        let c = document.getElementById('plToastContainer');
        if (!c) {
            c = document.createElement('div');
            c.id = 'plToastContainer';
            c.style.cssText = 'position:fixed;top:80px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
            document.body.appendChild(c);
        }
        const t = document.createElement('div');
        t.style.cssText = 'padding:10px 16px;background:' + (type === 'error' ? '#fee2e2' : '#dcfce7') +
            ';color:' + (type === 'error' ? '#dc2626' : '#059669') + ';border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.08);';
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2200);
        setTimeout(() => t.remove(), 2600);
    }

    // ========== 数据 ==========
    function builtinRecipes() {
        return (window.RECIPES_DATA && Array.isArray(window.RECIPES_DATA.items)) ? window.RECIPES_DATA.items : [];
    }

    function loadCustom() {
        return _state.custom.slice();
    }

    // 从 db 加载自定义配方；顺带把旧 localStorage 数据迁移过来（一次性）
    async function reloadCustom() {
        try {
            let arr = [];
            if (api.recipes && api.recipes.list) {
                const r = await api.recipes.list();
                if (r && r.ok && Array.isArray(r.items)) arr = r.items;
            }
            // 迁移 v1 localStorage → db
            if (!arr.length) {
                let old = [];
                try {
                    const raw = localStorage.getItem(LS_KEY);
                    old = raw ? JSON.parse(raw) : [];
                } catch (e) {}
                if (Array.isArray(old) && old.length && api.recipes && api.recipes.save) {
                    for (const x of old) { try { await api.recipes.save(x); } catch (e) {} }
                    try { localStorage.removeItem(LS_KEY); } catch (e) {}
                    const r2 = await api.recipes.list();
                    if (r2 && r2.ok && Array.isArray(r2.items)) arr = r2.items;
                }
            }
            _state.custom = arr;
        } catch (e) {
            _state.custom = [];
        }
    }

    async function saveCustom(arr) {
        // arr 是当前完整列表，直接逐条 save + 删除差集，由主线程负责持久化
        _state.custom = arr.slice();
        if (!api.recipes) return;
        try {
            const ids = new Set(arr.map(x => String(x.id)));
            const existing = await api.recipes.list();
            if (existing && existing.ok && Array.isArray(existing.items)) {
                for (const old of existing.items) {
                    if (!ids.has(String(old.id))) { try { await api.recipes.delete(old.id); } catch (e) {} }
                }
            }
            for (const x of arr) { try { await api.recipes.save(x); } catch (e) {} }
        } catch (e) {}
    }

    function allRecipes() {
        // 内置只读 + 自定义可编辑，用 _custom 标记区分
        // 注意：必须保留 patch 字段，右侧详情要用它编译正向/负向/参数
        const builtin = builtinRecipes().map(r => ({
            id: r.id, name: r.name, desc: r.desc, model: r.model, patch: r.patch, _custom: false
        }));
        const custom = loadCustom().map(r => ({
            id: r.id, name: r.name, desc: r.desc, model: r.model,
            patch: r.patch,
            positive: r.positive, negative: r.negative, param: r.param,  // 文本型（生成器保存）
            _custom: true, _ts: r._ts
        }));
        return builtin.concat(custom);
    }

    // ========== 入口（外壳语义保持不变）==========
    async function open() {
        if (!document.getElementById('promptLibraryPage')) createPage();
        _state.filter = '';
        _state.selectedId = '';
        const search0 = document.getElementById('plSearchInput');
        if (search0) search0.value = '';
        await reloadCustom();
        renderItems();
        renderDetail(null);
        const page = document.getElementById('promptLibraryPage');
        if (page) page.hidden = false;
        const main = document.querySelector('main');
        if (main) main.style.display = 'none';
        try { window.dispatchEvent(new CustomEvent('promptLibrary:opened')); } catch (e) {}
    }

    function close() {
        closeModal();
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

    // ========== DOM 外壳 ==========
    function createPage() {
        const page = document.createElement('div');
        page.id = 'promptLibraryPage';
        page.className = 'prompt-library-page';
        page.hidden = true;
        page.innerHTML = `
            <div class="pl-topbar">
                <h2 class="set-topbar-title"><i class="fa-solid fa-bookmark" style="color:#6366f1;"></i> 提示词配方库</h2>
                <span id="plHeaderSub" class="set-topbar-sub"></span>
                <span class="set-topbar-spacer"></span>
                <input id="plSearchInput" class="pl-search-input-topbar" type="text" placeholder="搜索配方名称 / 说明…" autocomplete="off">
                <span class="set-topbar-actions">
                    <button id="plBtnNew" class="btn btn-sm btn-primary"><i class="fa-solid fa-plus"></i> 新建配方</button>
                </span>
            </div>
            <div class="pl-body pl-body-split">
                <div class="pl-grid-wrap">
                    <div id="plGrid" class="pl-grid recipe-lib-grid"></div>
                </div>
                <aside id="plDetail" class="pl-detail">
                    <div class="pl-detail-empty"><i class="fa-solid fa-bookmark"></i><span>点击左侧配方卡片<br>查看正向 / 负向 / 采样参数</span></div>
                </aside>
            </div>
        `;
        document.body.appendChild(page);

        page.querySelector('#plBtnNew').addEventListener('click', () => openModal(null));
        const search = page.querySelector('#plSearchInput');
        search.addEventListener('input', () => {
            _state.filter = search.value.trim().toLowerCase();
            renderItems();
        });
    }

    // ========== 配方详情：用 CPS 引擎编译 patch ==========
    function cpsData() {
        if (_cpsDataCache) return _cpsDataCache;
        const D = window.CPS_DATA || {};
        const j = (k) => D[k] || {};
        const POSES = {};
        [['light', 'pose_light'], ['mid', 'pose_mid'], ['service', 'pose_service']].forEach(pair => {
            const d = D['data/poses-' + pair[0] + '.json'];
            if (d && Array.isArray(d.poses) && d.poses.length) {
                (d.poses || []).forEach(ps => {
                    ps._multi = (ps.group === 'mp');
                    ps._duo = !ps._multi && ((pair[0] === 'light') ? (ps.group === 'cp') : (ps.male === true));
                });
                POSES[pair[0]] = d;
            }
        });
        let models = j('data/models.json');
        if (!models.models || !models.models.length) {
            models = { version: 1, models: [{
                id: '_none', name: '默认', file: '', arch: 'sdxl', prefix: '', negativeBase: '',
                sampler: { steps: 28, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', width: 832, height: 1216 },
                tokenBudget: 200, forceNegGroups: []
            }] };
        }
        _cpsDataCache = {
            models, characters: j('data/characters.json'), clothing: j('data/clothing.json'),
            scenes: j('data/scenes.json'), features: j('data/features.json'), styles: j('data/styles.json'),
            poses: POSES, negatives: j('data/negatives.json'), lora: j('data/lora.json') || { items: [] }
        };
        return _cpsDataCache;
    }

    // 编译配方详情：
    // - 文本型（从生成器保存，带 positive/negative/param）：直接返回存好的内容
    // - patch 型（内置/自定义配方）：用 CPS 引擎编译
    function compileRecipe(r) {
        if (!r) return null;
        // 文本型：直接构造 build 形状
        if (r.positive !== undefined || r.param !== undefined) {
            return {
                positive: r.positive || '',
                negative: r.negative || '',
                param: r.param || {},
                sources: null,
                dropped: null,
                _textMode: true
            };
        }
        const CPS = window.CPS;
        if (!CPS || !r.patch) return null;
        try {
            const data = cpsData();
            let st = CPS.defaultState(data);
            st = CPS.applyRecipe(st, r, { models: data.models.models, loraFiles: [] });
            const b = CPS.build(st, data, {});
            return b;
        } catch (e) {
            console.warn('[配方详情] 编译失败:', e);
            return null;
        }
    }

    function paramRows(b) {
        const p = (b && b.param) || {};
        const stat = (b && b._textMode)
            ? ''
            : '<div style="grid-column:1/-1">已用 <b>' + (b && b.sources ? b.sources.length : '—') + '</b> 条 · 丢弃 <b>' + (b && b.dropped ? b.dropped.length : '—') + '</b> 条</div>';
        return '<div>尺寸 <b>' + escapeHtml(p.width || '—') + '×' + escapeHtml(p.height || '—') + '</b></div>' +
            '<div>步数 <b>' + escapeHtml(p.steps != null ? p.steps : '—') + '</b></div>' +
            '<div>CFG <b>' + escapeHtml(p.cfg != null ? p.cfg : '—') + '</b></div>' +
            '<div>采样 <b>' + escapeHtml(p.sampler || '—') + '</b></div>' +
            '<div>调度 <b>' + escapeHtml(p.scheduler || '—') + '</b></div>' + stat;
    }

    function renderDetail(r) {
        const box = document.getElementById('plDetail');
        if (!box) return;
        if (!r) {
            // 未选中：整个详情块隐藏，不占位
            box.style.display = 'none';
            return;
        }
        box.style.display = '';
        const b = compileRecipe(r);
        const positive = b ? (b.positive || '') : '';
        const negative = b ? (b.negative || '') : '';
        const errNote = b ? '' : '<div class="pl-detail-warn">该配方无有效 patch 数据（自定义配方需先编辑补充），仅显示基本信息。</div>';
        box.innerHTML =
            '<div class="pl-detail-head">' +
            '<div class="pl-detail-title">' + escapeHtml(r.name) + '</div>' +
            '<div class="pl-detail-sub">' + escapeHtml(r.desc || '') + '</div>' +
            '</div>' + errNote +
            '<div class="pl-detail-block">' +
            '<div class="pl-detail-block-head"><span>正向 PROMPT</span>' +
            '<button class="pl-detail-copy" data-copy="pos" title="复制正向提示词">复制</button></div>' +
            '<textarea class="pl-detail-text" data-pane="pos" spellcheck="false" readonly>' + escapeHtml(positive) + '</textarea>' +
            '</div>' +
            '<div class="pl-detail-block">' +
            '<div class="pl-detail-block-head"><span>负向 PROMPT</span>' +
            '<button class="pl-detail-copy" data-copy="neg" title="复制负向提示词">复制</button></div>' +
            '<textarea class="pl-detail-text neg" data-pane="neg" spellcheck="false" readonly>' + escapeHtml(negative) + '</textarea>' +
            '</div>' +
            '<div class="pl-detail-block">' +
            '<div class="pl-detail-block-head"><span>采样参数</span></div>' +
            '<div class="pl-detail-params">' + paramRows(b) + '</div>' +
            '</div>';

        box.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', () => {
                const pane = btn.dataset.copy === 'pos' ? box.querySelector('[data-pane=pos]') : box.querySelector('[data-pane=neg]');
                const txt = pane ? pane.value : '';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt).then(() => showToast('已复制 ' + txt.length + ' 字符', 'success')).catch(() => showToast('复制失败', 'error'));
                } else {
                    showToast('当前环境不支持剪贴板', 'error');
                }
            });
        });
    }

    function selectRecipe(r) {
        // 再次点击已选中的卡片 → 取消选中（隐藏详情）
        const rid = String(r.id || '');
        if (_state.selectedId === rid) {
            _state.selectedId = '';
            document.querySelectorAll('.pl-recipe-card').forEach(c => c.classList.remove('selected'));
            renderDetail(null);
            return;
        }
        _state.selectedId = rid;
        document.querySelectorAll('.pl-recipe-card').forEach(c => c.classList.toggle('selected', c.dataset.rid === _state.selectedId));
        renderDetail(r);
    }

    // ========== 渲染 ==========
    function filtered() {
        const all = allRecipes();
        const f = _state.filter;
        if (!f) return all;
        return all.filter(r =>
            String(r.name || '').toLowerCase().includes(f) ||
            String(r.desc || '').toLowerCase().includes(f) ||
            String(r.model || '').toLowerCase().includes(f));
    }

    function modelKind(m) {
        if (m === 'pony') return '写实 Pony';
        if (m === 'illustrious') return '动漫 IL';
        return m ? String(m) : '通用';
    }

    function renderItems() {
        const grid = document.getElementById('plGrid');
        if (!grid) return;
        const sub = document.getElementById('plHeaderSub');
        const all = allRecipes();
        const customN = all.filter(r => r._custom).length;
        if (sub) sub.textContent = '共 ' + all.length + ' 套（内置 ' + (all.length - customN) + ' · 自定义 ' + customN + '）';

        const list = filtered();
        grid.innerHTML = '';
        if (!list.length) {
            grid.innerHTML = '<div class="pl-empty" style="grid-column:1/-1"><i class="fa-solid fa-magnifying-glass"></i>' +
                '<div class="pl-empty-title">没有匹配的配方</div><div class="pl-empty-desc">换个关键词试试，或新建一个</div></div>';
            return;
        }
        for (const r of list) grid.appendChild(buildCard(r));
    }

    function buildCard(r) {
        const card = document.createElement('div');
        card.className = 'pl-recipe-card' + (_state.selectedId === String(r.id || '') ? ' selected' : '');
        card.dataset.rid = String(r.id || '');
        const badge = r._custom
            ? '<span class="pl-recipe-badge custom">自定义</span>'
            : '<span class="pl-recipe-badge">内置</span>';
        const actions = r._custom
            ? '<span class="pl-recipe-actions">' +
              '<button class="pl-recipe-act" data-act="edit" title="编辑"><i class="fa-solid fa-pen"></i></button>' +
              '<button class="pl-recipe-act" data-act="del" title="删除"><i class="fa-solid fa-trash"></i></button>' +
              '</span>'
            : '';
        card.innerHTML =
            '<div class="pl-recipe-head"><span class="pl-recipe-name">' + escapeHtml(r.name) + '</span>' +
            actions + '</div>' +
            '<div class="pl-recipe-meta-row">' + badge +
            '<span class="pl-recipe-model">' + escapeHtml(modelKind(r.model)) + '</span></div>' +
            '<div class="pl-recipe-desc">' + escapeHtml(r.desc || '') + '</div>' +
            '<div class="pl-recipe-id">' + escapeHtml(r.id || '') + '</div>';

        card.addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (btn) {
                e.stopPropagation();
                const act = btn.dataset.act;
                if (act === 'edit') openModal(r);
                else if (act === 'del') deleteRecipe(r);
                return;
            }
            // 点卡片本体：选中并在右侧展示详情
            selectRecipe(r);
        });
        return card;
    }

    // ========== 增删改 ==========
    function genId() {
        return 'U' + Date.now().toString(36).toUpperCase();
    }

    function openModal(recipe) {
        const editing = !!recipe;
        const overlay = document.createElement('div');
        overlay.className = 'pl-modal-overlay';
        overlay.id = 'plRecipeModal';
        overlay.innerHTML =
            '<div class="pl-modal">' +
            '<div class="pl-modal-head"><span>' + (editing ? '编辑配方' : '新建配方') + '</span>' +
            '<button class="pl-modal-close" data-close><i class="fa-solid fa-xmark"></i></button></div>' +
            '<div class="pl-modal-body">' +
            '<div class="pl-field"><label class="pl-field-label">名称 <em>*</em></label>' +
            '<input id="plfName" type="text" maxlength="40" placeholder="例如：深夜咖啡馆 · 暖光"></div>' +
            '<div class="pl-field"><label class="pl-field-label">说明</label>' +
            '<textarea id="plfDesc" style="min-height:80px" maxlength="200" placeholder="一句话描述这套配方的效果"></textarea></div>' +
            '<div class="pl-field"><label class="pl-field-label">模型</label>' +
            '<select id="plfModel">' +
            '<option value="pony">写实 Pony</option>' +
            '<option value="illustrious">动漫 IL</option>' +
            '<option value="">通用</option>' +
            '</select></div>' +
            '</div>' +
            '<div class="pl-modal-foot">' +
            '<button class="btn btn-sm" data-close>取消</button>' +
            '<button class="btn btn-sm btn-primary" id="plfSave">' + (editing ? '保存' : '新建') + '</button>' +
            '</div></div>';
        document.body.appendChild(overlay);

        overlay.querySelector('#plfName').value = editing ? (recipe.name || '') : '';
        overlay.querySelector('#plfDesc').value = editing ? (recipe.desc || '') : '';
        overlay.querySelector('#plfModel').value = editing ? (recipe.model || '') : 'pony';

        overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
        overlay.querySelector('#plfSave').addEventListener('click', async () => {
            const name = overlay.querySelector('#plfName').value.trim();
            if (!name) { showToast('请填写名称', 'error'); return; }
            const desc = overlay.querySelector('#plfDesc').value.trim();
            const model = overlay.querySelector('#plfModel').value;
            const arr = loadCustom();
            // 保留文本型配方已有的 positive/negative/param（编辑时不能丢）
            const extra = {};
            if (recipe) {
                if (recipe.positive !== undefined) extra.positive = recipe.positive;
                if (recipe.negative !== undefined) extra.negative = recipe.negative;
                if (recipe.param !== undefined) extra.param = recipe.param;
                if (recipe.patch !== undefined) extra.patch = recipe.patch;
            }
            if (editing) {
                const i = arr.findIndex(x => String(x.id) === String(recipe.id));
                const merged = Object.assign({ id: recipe.id, name, desc, model, _ts: Date.now() }, extra);
                if (i >= 0) arr[i] = merged;
                else arr.push(merged);
            } else {
                arr.unshift({ id: genId(), name, desc, model, _ts: Date.now() });
            }
            await saveCustom(arr);
            closeModal();
            renderItems();
            showToast(editing ? '已保存配方' : '已新建配方', 'success');
        });
    }

    function closeModal() {
        const m = document.getElementById('plRecipeModal');
        if (m) m.remove();
    }

    async function deleteRecipe(recipe) {
        if (!window.confirm('确定删除配方「' + recipe.name + '」？')) return;
        const arr = loadCustom().filter(x => String(x.id) !== String(recipe.id));
        await saveCustom(arr);
        renderItems();
        showToast('已删除配方', 'success');
    }

    // ========== 暴露（script.js 依赖：open/close/isOpen）==========
    window.promptLibrary = { open, close, isOpen };
})();
