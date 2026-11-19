// web/js/arcs.js
// Sprint 7.1: 卷层级大纲 前端面板
// 渲染 _ainovel_arcs 列表 + 生成/重生成/追加 操作

'use strict';

(function () {
    if (!window.ArcsPanel) window.ArcsPanel = {};

    let _novelId = null;
    let _chapterCount = 30;

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function render($container, novelId, novel) {
        _novelId = novelId;
        _chapterCount = (novel && novel.chapter_target_count) || 30;
        if (!$container) return;
        $container.innerHTML = '<div class="arcs-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载卷结构…</div>';
        let arcs = [];
        try {
            const r = await window.api.ainovel.listArcs(novelId);
            arcs = (r && r.ok && Array.isArray(r.arcs)) ? r.arcs : [];
        } catch (e) {
            $container.innerHTML = '<div class="arcs-empty">加载失败：' + _esc(e.message) + '</div>';
            return;
        }
        _draw($container, arcs);
    }

    function _draw($container, arcs) {
        const html = `
            <div class="arcs-header">
                <div class="arcs-hint">
                    <i class="fa-solid fa-circle-info"></i>
                    卷(arc)是大纲的中间层级：每卷覆盖连续的章节区间，总和必须 == 总章节数。
                </div>
                <div class="arcs-actions">
                    <button type="button" class="btn btn-sm" data-arcs-act="generate-skeleton"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成卷骨架</button>
                    <button type="button" class="btn btn-sm" data-arcs-act="add-manual"><i class="fa-solid fa-plus"></i> 手动添加</button>
                    <button type="button" class="btn btn-sm" data-arcs-act="append"><i class="fa-solid fa-forward"></i> 追加新卷</button>
                    <button type="button" class="btn btn-sm" data-arcs-act="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
                </div>
            </div>
            <div class="arcs-status" id="arcsStatus"></div>
            ${arcs.length ? _renderArcsList(arcs) : '<div class="arcs-empty">暂无卷。可点击上方"AI 生成卷骨架"自动生成。</div>'}
        `;
        $container.innerHTML = html;
        _wire($container, arcs);
    }

    function _renderArcsList(arcs) {
        return `
            <div class="arcs-list">
                ${arcs.map((a, i) => `
                    <div class="arcs-item" data-arc-id="${_esc(a.id)}">
                        <div class="arcs-item-head">
                            <span class="arcs-item-idx">#${i + 1}</span>
                            <input type="text" class="arcs-item-title" data-field="title" value="${_esc(a.title)}" placeholder="卷标题">
                            <span class="arcs-item-range">第 ${a.startCh} - ${a.endCh} 章（${a.endCh - a.startCh + 1} 章）</span>
                            <button type="button" class="arcs-item-act" data-act="save" title="保存"><i class="fa-solid fa-check"></i></button>
                            <button type="button" class="arcs-item-act" data-act="generate" title="生成此卷章纲"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                            <button type="button" class="arcs-item-act arcs-item-act-danger" data-act="delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                        </div>
                        <div class="arcs-item-body">
                            <label class="arcs-item-label">卷目标</label>
                            <input type="text" class="arcs-item-goal" data-field="goal" value="${_esc(a.goal || '')}" placeholder="一句话卷目标">
                            ${a.summary ? `<div class="arcs-item-summary"><strong>摘要：</strong>${_esc(a.summary.slice(0, 300))}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>`;
    }

    function _wire($container, arcs) {
        $container.querySelectorAll('[data-arcs-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.arcsAct;
                if (act === 'generate-skeleton') _generateSkeleton($container);
                else if (act === 'add-manual') _addManual($container);
                else if (act === 'append') _append($container);
                else if (act === 'refresh') render($container, _novelId, { chapter_target_count: _chapterCount });
            });
        });
        $container.querySelectorAll('.arcs-item').forEach(item => {
            const arcId = item.dataset.arcId;
            item.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const act = btn.dataset.act;
                    if (act === 'save') {
                        const title = item.querySelector('[data-field="title"]').value.trim();
                        const goal = item.querySelector('[data-field="goal"]').value.trim();
                        if (!title) { if (window.toast) window.toast('标题不能为空', 'warn'); return; }
                        const r = await window.api.ainovel.updateArc(_novelId, arcId, { title, goal });
                        if (r && r.ok) { if (window.toast) window.toast('已保存', 'success', 1200); }
                        else if (window.toast) window.toast('保存失败：' + (r && r.error || '未知'), 'error');
                    } else if (act === 'generate') {
                        _generateArcOutline(arcId);
                    } else if (act === 'delete') {
                        if (!window.confirm('确认删除该卷？')) return;
                        const r = await window.api.ainovel.deleteArc(_novelId, arcId);
                        if (r && r.ok) render($container, _novelId, { chapter_target_count: _chapterCount });
                    }
                });
            });
        });
    }

    async function _generateSkeleton($container) {
        const $status = $container.querySelector('#arcsStatus');
        if ($status) $status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 正在生成卷骨架…';
        const r = await window.api.ainovel.generateArcSkeleton(_novelId, { chapterCount: _chapterCount });
        if (r && r.ok) {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-check"></i> 已生成 ' + r.arcs.length + ' 个卷';
            if (window.toast) window.toast('已生成卷骨架', 'success');
            render($container, _novelId, { chapter_target_count: _chapterCount });
        } else {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> 生成失败：' + (r && r.error || '未知');
            if (window.toast) window.toast('生成失败：' + (r && r.error || '未知'), 'error');
        }
    }

    async function _addManual($container) {
        const title = window.prompt('卷标题：');
        if (!title) return;
        const goal = window.prompt('卷目标（一句话）：', '') || '';
        const range = window.prompt('章节范围（如 "1-12"）：', '');
        if (!range) return;
        const m = range.match(/^\s*(\d+)\s*[-–]\s*(\d+)\s*$/);
        if (!m) { if (window.toast) window.toast('格式错误，应为 "起始-结束"', 'warn'); return; }
        const startCh = parseInt(m[1], 10);
        const endCh = parseInt(m[2], 10);
        const r = await window.api.ainovel.createArc(_novelId, { title, goal, startCh, endCh });
        if (r && r.ok) render($container, _novelId, { chapter_target_count: _chapterCount });
        else if (window.toast) window.toast('创建失败：' + (r && r.error || '未知'), 'error');
    }

    async function _append($container) {
        const countStr = window.prompt('追加多少章？', '10');
        if (!countStr) return;
        const count = parseInt(countStr, 10);
        if (!Number.isFinite(count) || count < 1) { if (window.toast) window.toast('无效数字', 'warn'); return; }
        const goal = window.prompt('新卷目标：', '') || '';
        const $status = $container.querySelector('#arcsStatus');
        if ($status) $status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 追加中…';
        const r = await window.api.ainovel.appendArc(_novelId, { chapterCount: count, goal });
        if (r && r.ok) {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-check"></i> 已追加新卷（' + r.chapters.length + ' 章）';
            if (window.toast) window.toast('已追加新卷', 'success');
            _chapterCount += count;
            render($container, _novelId, { chapter_target_count: _chapterCount });
        } else {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> 追加失败：' + (r && r.error || '未知');
            if (window.toast) window.toast('追加失败：' + (r && r.error || '未知'), 'error');
        }
    }

    async function _generateArcOutline(arcId) {
        const $status = document.getElementById('arcsStatus');
        if ($status) $status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 生成章节大纲中…';
        const r = await window.api.ainovel.generateArcOutline(_novelId, { arcId });
        if (r && r.ok) {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-check"></i> 已生成 ' + r.chapters.length + ' 章大纲';
            if (window.toast) window.toast('已生成章节大纲', 'success');
        } else {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> 生成失败：' + (r && r.error || '未知');
            if (window.toast) window.toast('生成失败：' + (r && r.error || '未知'), 'error');
        }
    }

    window.ArcsPanel = {
        render,
    };
})();