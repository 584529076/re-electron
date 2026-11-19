// web/js/foreshadows.js
// Sprint 7.2: 伏笔系统 前端面板
// 列出伏笔（按状态分组）+ 手动 CRUD + AI 建议 + Roadmap 导出

'use strict';

(function () {
    if (!window.ForeshadowsPanel) window.ForeshadowsPanel = {};

    let _novelId = null;

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const _STATUS_LABEL = { planted: '已埋设', progressing: '进行中', resolved: '已回收', abandoned: '已放弃' };
    const _STATUS_ORDER = ['planted', 'progressing', 'resolved', 'abandoned'];

    async function render($container, novelId, novel) {
        _novelId = novelId;
        if (!$container) return;
        $container.innerHTML = '<div class="fs-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载伏笔…</div>';
        let list = [];
        try {
            const r = await window.api.ainovel.listForeshadows(novelId);
            list = (r && r.ok && Array.isArray(r.foreshadows)) ? r.foreshadows : [];
        } catch (e) {
            $container.innerHTML = '<div class="fs-empty">加载失败：' + _esc(e.message) + '</div>';
            return;
        }
        _draw($container, list, novel);
    }

    function _draw($container, list, novel) {
        const byStatus = { planted: [], progressing: [], resolved: [], abandoned: [] };
        for (const f of list) byStatus[f.status || 'planted'].push(f);

        const html = `
            <div class="fs-header">
                <div class="fs-hint">
                    <i class="fa-solid fa-circle-info"></i>
                    伏笔状态：<strong>planted</strong>（已埋设）→ <strong>progressing</strong>（进行中）→ <strong>resolved</strong>（已回收）/ <strong>abandoned</strong>（已放弃）
                </div>
                <div class="fs-actions">
                    <button type="button" class="btn btn-sm" data-fs-act="add"><i class="fa-solid fa-plus"></i> 新建</button>
                    <button type="button" class="btn btn-sm" data-fs-act="suggest"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 建议本章伏笔</button>
                    <button type="button" class="btn btn-sm" data-fs-act="roadmap"><i class="fa-solid fa-map"></i> 导出 Roadmap</button>
                    <button type="button" class="btn btn-sm" data-fs-act="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
                </div>
            </div>
            <div class="fs-status" id="fsStatus"></div>
            ${list.length ? _renderByStatus(byStatus) : '<div class="fs-empty">暂无伏笔。可点击"新建"手动添加，或"AI 建议本章伏笔"自动扫描。</div>'}
        `;
        $container.innerHTML = html;
        _wire($container);
    }

    function _renderByStatus(byStatus) {
        return `
            <div class="fs-groups">
                ${_STATUS_ORDER.map(status => {
                    const arr = byStatus[status];
                    if (!arr.length) return '';
                    return `
                    <div class="fs-group" data-status="${status}">
                        <div class="fs-group-head">
                            <span class="fs-group-label">${_esc(_STATUS_LABEL[status] || status)}</span>
                            <span class="fs-group-count">${arr.length}</span>
                        </div>
                        <div class="fs-list">
                            ${arr.map(f => _renderItem(f)).join('')}
                        </div>
                    </div>`;
                }).join('')}
            </div>`;
    }

    function _renderItem(f) {
        return `
        <div class="fs-item" data-id="${_esc(f.id)}">
            <div class="fs-item-head">
                <input type="text" class="fs-item-name" data-field="name" value="${_esc(f.name)}" placeholder="伏笔名">
                <span class="fs-item-range">第 ${f.plantChapter} 章${f.targetChapter ? ' → 第 ' + f.targetChapter + ' 章' : ''}</span>
                <select class="fs-item-status" data-field="status">
                    <option value="planted" ${f.status === 'planted' ? 'selected' : ''}>planted</option>
                    <option value="progressing" ${f.status === 'progressing' ? 'selected' : ''}>progressing</option>
                    <option value="resolved" ${f.status === 'resolved' ? 'selected' : ''}>resolved</option>
                    <option value="abandoned" ${f.status === 'abandoned' ? 'selected' : ''}>abandoned</option>
                </select>
                <button type="button" class="fs-item-act" data-act="save" title="保存"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="fs-item-act fs-item-act-danger" data-act="delete" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
            <textarea class="fs-item-desc" data-field="description" rows="2" placeholder="伏笔描述">${_esc(f.description || '')}</textarea>
            ${f.events && f.events.length ? `
                <div class="fs-item-events">
                    <strong>事件：</strong>
                    ${f.events.map(e => `<span class="fs-event">第${e.chapter}章: ${_esc(e.note || '')}</span>`).join(' ')}
                </div>
            ` : ''}
            ${f.resolution ? `<div class="fs-item-resolution"><strong>回收：</strong>${_esc(f.resolution)}</div>` : ''}
        </div>`;
    }

    function _wire($container) {
        $container.querySelectorAll('[data-fs-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.fsAct;
                if (act === 'add') _add($container);
                else if (act === 'suggest') _suggest($container);
                else if (act === 'roadmap') _roadmap();
                else if (act === 'refresh') render($container, _novelId);
            });
        });
        $container.querySelectorAll('.fs-item').forEach(item => {
            const id = item.dataset.id;
            item.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const act = btn.dataset.act;
                    if (act === 'save') {
                        const patch = {
                            name: item.querySelector('[data-field="name"]').value.trim(),
                            description: item.querySelector('[data-field="description"]').value.trim(),
                            status: item.querySelector('[data-field="status"]').value,
                        };
                        if (!patch.name) { if (window.toast) window.toast('名称必填', 'warn'); return; }
                        const r = await window.api.ainovel.updateForeshadow(_novelId, id, patch);
                        if (r && r.ok) { if (window.toast) window.toast('已保存', 'success', 1200); }
                        else if (window.toast) window.toast('保存失败：' + (r && r.error || '未知'), 'error');
                    } else if (act === 'delete') {
                        if (!window.confirm('确认删除该伏笔？')) return;
                        const r = await window.api.ainovel.deleteForeshadow(_novelId, id);
                        if (r && r.ok) render($container, _novelId);
                    }
                });
            });
        });
    }

    async function _add($container) {
        const name = window.prompt('伏笔名称：');
        if (!name) return;
        const plantChapter = window.prompt('埋设章节号：', '1');
        if (!plantChapter) return;
        const targetChapter = window.prompt('预计回收章节号（留空跳过）：', '');
        const description = window.prompt('描述：', '') || '';
        const r = await window.api.ainovel.createForeshadow(_novelId, {
            name,
            description,
            plantChapter: parseInt(plantChapter, 10),
            targetChapter: targetChapter ? parseInt(targetChapter, 10) : null,
        });
        if (r && r.ok) render($container, _novelId);
        else if (window.toast) window.toast('创建失败：' + (r && r.error || '未知'), 'error');
    }

    async function _suggest($container) {
        const chStr = window.prompt('扫描哪一章？（输入章节号）', '');
        if (!chStr) return;
        const chapterNo = parseInt(chStr, 10);
        if (!Number.isFinite(chapterNo)) { if (window.toast) window.toast('无效章节号', 'warn'); return; }
        const $status = $container.querySelector('#fsStatus');
        if ($status) $status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 扫描第 ' + chapterNo + ' 章中…';
        const r = await window.api.ainovel.suggestForeshadows(_novelId, chapterNo);
        if (!r || !r.ok) {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> ' + (r && r.error || '失败');
            if (window.toast) window.toast('扫描失败：' + (r && r.error || '未知'), 'error');
            return;
        }
        const out = r.output || {};
        const planted = out.planted || [];
        const paid = out.paid || [];
        const progressing = out.progressing || [];
        if (!planted.length && !paid.length && !progressing.length) {
            if ($status) $status.innerHTML = '本章无伏笔变化';
            if (window.toast) window.toast('本章无伏笔', 'info');
            return;
        }
        // 简单展示：自动采纳 planted，询问 progressing/paid
        if (planted.length) {
            const items = planted.map(p => ({
                name: p.id || p.name,
                description: p.description,
                plantChapter: p.plant_chapter || chapterNo,
                targetChapter: p.target_chapter_estimate || null,
            }));
            const ar = await window.api.ainovel.confirmForeshadows(_novelId, items);
            if (ar && ar.ok) {
                if (window.toast) window.toast('已采纳 ' + ar.adopted.length + ' 条新伏笔', 'success');
            }
        }
        if ($status) $status.innerHTML = `AI 扫描结果：<strong>${planted.length}</strong> 新埋伏笔，<strong>${progressing.length}</strong> 推进，<strong>${paid.length}</strong> 回收`;
        render($container, _novelId);
    }

    async function _roadmap() {
        const r = await window.api.ainovel.generateForeshadowRoadmap(_novelId);
        if (!r || !r.ok) return;
        const md = r.markdown || '';
        // 弹窗显示 markdown
        const w = window.open('', '_blank', 'width=720,height=600');
        if (w) {
            w.document.write('<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:24px;">' + _esc(md) + '</pre>');
            w.document.title = 'Foreshadows.md';
        } else if (window.toast) {
            window.toast('请允许弹窗以查看 Roadmap', 'warn');
        }
    }

    window.ForeshadowsPanel = { render };
})();