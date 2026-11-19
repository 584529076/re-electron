// web/js/skill-config.js
// Sprint 6.4: Skill 开关 UI（全局 modal）
// 通过 window.api.ainovel.listSkills() 拉列表，toggleSkill(name, bool) 持久化
// 分类展示：polish / review / outline / chapter / general

'use strict';

(function () {
    if (!window.SkillConfig) window.SkillConfig = {};

    const _CAT_LABEL = {
        polish: '润色',
        review: '评审',
        outline: '大纲',
        chapter: '章节',
        general: '通用',
        other: '其它',
    };
    const _CAT_ORDER = ['polish', 'review', 'outline', 'chapter', 'general', 'other'];
    const _CAT_DESC = {
        polish: '润色类：自动注入到所有写作/修订路径（humanizer / 去 AI 痕迹）',
        review: '评审类：用于事实核查、风格检查的辅助 skill',
        outline: '大纲生成 / 修订',
        chapter: '章节写作 / 段落修订',
        general: '通用 / 跨域 skill',
    };

    let _modalEl = null;
    let _onChangeCb = null;

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * 初始化：注入一个全局 modal + 一个触发按钮
     * @param {object} opts
     *   - triggerSelector: 触发按钮的 CSS 选择器（默认 'body' 末尾追加一个浮动按钮）
     *   - onChange: (skillName, enabled) => void  — toggle 后回调
     */
    function init(opts = {}) {
        if (_modalEl) return;
        _onChangeCb = typeof opts.onChange === 'function' ? opts.onChange : null;

        // 注入 modal 容器
        const div = document.createElement('div');
        div.id = 'novelSkillConfigModal';
        div.className = 'skill-config-modal';
        div.hidden = true;
        div.innerHTML = `
            <div class="skill-config-overlay" data-act="close"></div>
            <div class="skill-config-panel">
                <div class="skill-config-head">
                    <span class="skill-config-title">
                        <i class="fa-solid fa-sliders"></i> Skill 开关
                    </span>
                    <button type="button" class="skill-config-close" data-act="close" title="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="skill-config-hint">
                    <i class="fa-solid fa-circle-info"></i>
                    <div>
                        启用 skill 后，会在对应 agent 调用时按 category 自动注入 system prompt。
                        <br><strong>polish</strong> 类（如人称润色）会对<strong>所有写作/修订路径</strong>自动注入；
                        其它 category 仅注入到<strong>同 category</strong>的 agent。
                    </div>
                </div>
                <div class="skill-config-summary" id="skillConfigSummary"></div>
                <div class="skill-config-body" id="skillConfigBody">
                    <div class="skill-config-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>
                </div>
            </div>`;
        document.body.appendChild(div);
        _modalEl = div;

        // 绑定关闭
        _modalEl.querySelectorAll('[data-act="close"]').forEach(el => {
            el.addEventListener('click', _close);
        });

        // 注入浮动触发按钮（若无指定 triggerSelector）
        if (!opts.triggerSelector) {
            const btn = document.createElement('button');
            btn.id = 'skillConfigFab';
            btn.className = 'skill-config-fab';
            btn.type = 'button';
            btn.title = 'Skill 开关';
            btn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
            btn.addEventListener('click', _open);
            document.body.appendChild(btn);
        } else {
            const trig = document.querySelector(opts.triggerSelector);
            if (trig) trig.addEventListener('click', (e) => { e.preventDefault(); _open(); });
        }
    }

    async function _open() {
        if (!_modalEl) return;
        _modalEl.hidden = false;
        await _render();
    }

    function _close() {
        if (_modalEl) _modalEl.hidden = true;
    }

    async function _render() {
        const $body = document.getElementById('skillConfigBody');
        const $summary = document.getElementById('skillConfigSummary');
        if (!$body) return;
        $body.innerHTML = '<div class="skill-config-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>';
        let skills = [];
        try {
            const r = await window.api.ainovel.listSkills();
            skills = (r && r.ok && Array.isArray(r.skills)) ? r.skills : [];
        } catch (e) {
            $body.innerHTML = '<div class="skill-config-empty">加载失败：' + _esc(e.message || '未知') + '</div>';
            return;
        }
        if (!skills.length) {
            $body.innerHTML = '<div class="skill-config-empty">暂无 skill</div>';
            return;
        }

        // 统计
        const enabled = skills.filter(s => s.enabled).length;
        $summary.innerHTML = `
            <span class="skill-config-stat"><strong>${skills.length}</strong> 个 skill</span>
            <span class="skill-config-stat"><strong>${enabled}</strong> 个已启用</span>
            <button type="button" class="skill-config-bulk" data-bulk="enable-all"><i class="fa-solid fa-check-double"></i> 全部启用</button>
            <button type="button" class="skill-config-bulk" data-bulk="disable-all"><i class="fa-solid fa-ban"></i> 全部关闭</button>`;
        $summary.querySelectorAll('[data-bulk]').forEach(btn => {
            btn.addEventListener('click', () => _bulkToggle(skills, btn.dataset.bulk === 'enable-all'));
        });

        // 分组
        const groups = {};
        for (const s of skills) {
            const cat = s.category || 'other';
            if (!groups[cat]) groups[cat] = [];
            groups[cat].push(s);
        }
        const orderedCats = _CAT_ORDER.filter(c => groups[c]);
        // 任何未在 _CAT_ORDER 里的 category 也补上
        Object.keys(groups).forEach(c => { if (!orderedCats.includes(c)) orderedCats.push(c); });

        $body.innerHTML = orderedCats.map(cat => {
            const items = groups[cat].sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
            const catEnabled = items.filter(s => s.enabled).length;
            return `
            <div class="skill-config-cat" data-cat="${_esc(cat)}">
                <div class="skill-config-cat-head">
                    <span class="skill-config-cat-name">${_esc(_CAT_LABEL[cat] || cat)}</span>
                    <span class="skill-config-cat-count">${catEnabled}/${items.length}</span>
                    <span class="skill-config-cat-desc">${_esc(_CAT_DESC[cat] || '')}</span>
                    <button type="button" class="skill-config-cat-bulk" data-cat-bulk="enable" data-cat="${_esc(cat)}">启用本类</button>
                    <button type="button" class="skill-config-cat-bulk" data-cat-bulk="disable" data-cat="${_esc(cat)}">关闭本类</button>
                </div>
                <div class="skill-config-list">
                    ${items.map(s => _renderSkillRow(s)).join('')}
                </div>
            </div>`;
        }).join('');

        // 行 toggle 事件
        $body.querySelectorAll('.skill-config-row [data-toggle]').forEach(el => {
            el.addEventListener('change', () => _toggleOne(el.dataset.toggle, el.checked, skills));
        });
        // 分类级 bulk
        $body.querySelectorAll('[data-cat-bulk]').forEach(btn => {
            btn.addEventListener('click', () => _bulkToggleCategory(groups[btn.dataset.cat] || [], btn.dataset.catBulk === 'enable'));
        });
    }

    function _renderSkillRow(s) {
        return `
        <div class="skill-config-row" data-name="${_esc(s.name)}">
            <label class="skill-config-switch">
                <input type="checkbox" data-toggle="${_esc(s.name)}" ${s.enabled ? 'checked' : ''}>
                <span class="skill-config-slider"></span>
            </label>
            <div class="skill-config-row-info">
                <div class="skill-config-row-name">
                    <span class="skill-config-row-display">${_esc(s.displayName || s.name)}</span>
                    <span class="skill-config-row-id">${_esc(s.name)}</span>
                </div>
                <div class="skill-config-row-desc">${_esc((s.description || '').slice(0, 160))}</div>
            </div>
        </div>`;
    }

    async function _toggleOne(name, enabled, _allSkills) {
        try {
            const r = await window.api.ainovel.toggleSkill(name, enabled);
            if (!r || !r.ok) {
                if (window.toast) window.toast('切换失败：' + (r && r.error || '未知'), 'error');
                await _render();
                return;
            }
            if (window.toast) window.toast(enabled ? '已启用' : '已关闭', 'success', 1500);
            if (_onChangeCb) _onChangeCb(name, enabled);
            // 局部更新 summary 计数（避免重渲染闪烁）
            await _render();
        } catch (e) {
            if (window.toast) window.toast('切换失败：' + e.message, 'error');
            await _render();
        }
    }

    async function _bulkToggle(skills, enable) {
        const targets = skills.filter(s => s.enabled !== enable);
        if (!targets.length) {
            if (window.toast) window.toast('无需变更', 'info', 1200);
            return;
        }
        for (const s of targets) {
            try { await window.api.ainovel.toggleSkill(s.name, enable); } catch (e) { /* ignore one fail */ }
        }
        if (window.toast) window.toast(`已${enable ? '启用' : '关闭'} ${targets.length} 个 skill`, 'success');
        await _render();
    }

    async function _bulkToggleCategory(items, enable) {
        const targets = items.filter(s => s.enabled !== enable);
        if (!targets.length) {
            if (window.toast) window.toast('本类无需变更', 'info', 1200);
            return;
        }
        for (const s of targets) {
            try { await window.api.ainovel.toggleSkill(s.name, enable); } catch (e) { /* */ }
        }
        if (window.toast) window.toast(`已${enable ? '启用' : '关闭'} ${targets.length} 个`, 'success');
        await _render();
    }

    window.SkillConfig = {
        init,
        open: _open,
        close: _close,
        refresh: _render,
    };
})();