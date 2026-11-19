// workflow-manager.js — 工作流管理页（两栏：左工作流列表 / 右节点信息与默认值）
// 由工具集右上角「工作流管理」按钮进入，属于工作台的子页（Tab 都不高亮）。
'use strict';
(function () {
    'use strict';
    const api = window.api || {};
    const esc = (s) => {
        const d = window.dUtil || {};
        if (typeof d.escapeHtml === 'function') return d.escapeHtml(s);
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    };

    let tools = [];
    let currentId = null;
    let workflowCache = new Map(); // toolId → workflow JSON
    let bound = false;

    function bindOnce() {
        if (bound) return;
        bound = true;
        const btn = (document.getElementById('dwpBtnWorkflowManager'));
        if (btn) btn.addEventListener('click', () => {
            if (typeof window.dwpSwitchView === 'function') window.dwpSwitchView('manage');
            loadTools();
        });
        const back = document.getElementById('wfmBack');
        if (back) back.addEventListener('click', () => {
            if (typeof window.dwpSwitchView === 'function') window.dwpSwitchView('tools');
        });
        const list = document.getElementById('wfmList');
        if (list) list.addEventListener('click', e => {
            const item = e.target.closest('.wfm-item');
            if (!item) return;
            selectTool(item.getAttribute('data-tool-id'));
        });
    }

    async function loadTools() {
        bindOnce();
        if (!api.tools || typeof api.tools.list !== 'function') return;
        try {
            const r = await api.tools.list();
            tools = (r && r.ok) ? (r.tools || []) : [];
        } catch (e) { tools = []; }
        renderList();
    }

    function renderList() {
        const list = document.getElementById('wfmList');
        const count = document.getElementById('wfmCount');
        if (!list) return;
        if (count) count.textContent = tools.length ? String(tools.length) : '';
        if (!tools.length) {
            list.innerHTML = '<div class="dwp-tool-rail-empty">暂无工作流</div>';
            return;
        }
        list.innerHTML = tools.map(t => {
            const bad = !!t.broken;
            const active = t.id === currentId;
            const icon = (t.coverUrl && !bad)
                ? `<img src="${esc(t.coverUrl)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='◆';">`
                : `<i class="fa-solid ${bad ? 'fa-triangle-exclamation' : 'fa-diagram-project'}"></i>`;
            const mode = String(t.mode || 'sfw').toUpperCase();
            return `<button type="button" class="wfm-item dwp-tool-rail-item${active ? ' active' : ''}" data-tool-id="${esc(t.id)}"${bad ? ' title="' + esc(t.error || '损坏') + '"' : ''}>
                <span class="dwp-tool-rail-icon">${icon}</span>
                <span class="dwp-tool-rail-meta"><span class="dwp-tool-rail-name" title="${esc(t.name || t.id)}">${esc(t.name || t.id)}${bad ? ' ⚠' : ''}</span><span class="dwp-tool-rail-mode ${esc(mode.toLowerCase())}">${esc(mode)}${bad ? ' · 损坏' : ''}</span></span>
            </button>`;
        }).join('');
    }

    async function selectTool(id) {
        currentId = id;
        renderList();
        const t = tools.find(x => x.id === id) || {};
        const title = document.getElementById('wfmTitle');
        const subtitle = document.getElementById('wfmSubtitle');
        const body = document.getElementById('wfmBody');
        if (title) title.textContent = t.name || id;
        if (subtitle) subtitle.textContent = t.description || (t.id || '');
        if (body) body.innerHTML = '<div class="dwp-form-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>正在加载节点…</span></div>';
        if (!api.tools || typeof api.tools.getWorkflow !== 'function') {
            if (body) body.innerHTML = '<div class="dwp-form-empty">当前环境不支持读取 workflow（接口不可用）</div>';
            return;
        }
        try {
            let wf = workflowCache.get(id);
            if (!wf) {
                const r = await api.tools.getWorkflow(id);
                if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
                wf = r.workflow;
                workflowCache.set(id, wf);
            }
            renderNodes(wf, t);
        } catch (e) {
            if (body) body.innerHTML = '<div class="dwp-form-empty">加载失败：' + esc(e.message) + '</div>';
        }
    }

    function renderNodes(wf, tool) {
        const body = document.getElementById('wfmBody');
        if (!body) return;
        const ids = Object.keys(wf || {});
        if (!ids.length) { body.innerHTML = '<div class="dwp-form-empty">该工作流没有节点</div>'; return; }
        // schema 里声明的可编辑字段 → 标注
        const editable = new Map();
        for (const f of ((tool.formFields) || [])) {
            if (f.nodeId != null && f.field) {
                const k = String(f.nodeId) + '.' + f.field;
                editable.set(k, f);
            }
        }
        // 输出节点标注
        const outSet = new Set(((tool.outputNodes) || []).map(o => String(o.nodeId)));

        const html = ids.map(nodeId => {
            const node = wf[nodeId] || {};
            const cls = String(node.class_type || '(未知节点)');
            const inputs = node.inputs || {};
            const inputKeys = Object.keys(inputs);
            const isOut = outSet.has(String(nodeId));
            const rows = inputKeys.length ? inputKeys.map(k => {
                let v = inputs[k];
                let vHtml;
                if (Array.isArray(v)) {
                    vHtml = `<span class="wfm-val-link">← 节点 ${esc(String(v[0]))}${v[1] != null ? ' : ' + esc(String(v[1])) : ''}</span>`;
                } else if (v && typeof v === 'object') {
                    vHtml = `<code>${esc(JSON.stringify(v))}</code>`;
                } else if (typeof v === 'string') {
                    vHtml = `<code>${esc(v)}</code>`;
                } else {
                    vHtml = `<code>${esc(String(v))}</code>`;
                }
                const ef = editable.get(String(nodeId) + '.' + k);
                const badge = ef ? `<span class="wfm-editable" title="schema 可编辑字段">可编辑 · ${esc(ef.label || ef.id)}</span>` : '';
                return `<div class="wfm-input-row"><span class="wfm-input-key">${esc(k)}</span><span class="wfm-input-val">${vHtml}${badge}</span></div>`;
            }).join('') : '<div class="wfm-input-row"><span class="wfm-input-val wfm-muted">（无输入）</span></div>';
            return `<div class="wfm-node">
                <div class="wfm-node-head"><span class="wfm-node-id">#${esc(nodeId)}</span><strong>${esc(cls)}</strong>${isOut ? '<span class="wfm-out-badge">输出</span>' : ''}</div>
                <div class="wfm-node-body">${rows}</div>
            </div>`;
        }).join('');
        body.innerHTML = `<div class="wfm-nodes">${html}</div>`;
    }

    // 工作台打开时若 manage 视图残留，重置为 tools（switchView 在 engineering-flow.js 里已处理 closed 事件）
    window.workflowManager = { loadTools, selectTool };

    // 脚本在 body 末尾加载，DOM 已就绪，立即绑定按钮事件
    // （注意：click 处理函数里引用的 window.dwpSwitchView 在 engineering-flow.js 中定义，
    //   后者在本脚本之后加载；点击事件在用户交互时才触发，那时已定义，无时序问题）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindOnce);
    } else {
        bindOnce();
    }
})();
