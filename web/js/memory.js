// web/js/memory.js
// Sprint 7.3: 叙事记忆 前端面板
// 列出记忆（按 chapter 排序 + 按 importance 染色）+ 手动 CRUD + AI 提取

'use strict';

(function () {
    if (!window.MemoryPanel) window.MemoryPanel = {};

    let _novelId = null;

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const _CAT_LABEL = { character: '人物', location: '地点', item: '物品', event: '事件', promise: '承诺', other: '其他' };

    async function render($container, novelId, novel) {
        _novelId = novelId;
        if (!$container) return;
        $container.innerHTML = '<div class="mem-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载记忆…</div>';
        let list = [];
        try {
            const r = await window.api.ainovel.listMemory(novelId, {});
            list = (r && r.ok && Array.isArray(r.memories)) ? r.memories : [];
        } catch (e) {
            $container.innerHTML = '<div class="mem-empty">加载失败：' + _esc(e.message) + '</div>';
            return;
        }
        _draw($container, list, novel);
    }

    function _draw($container, list, novel) {
        // 按 chapter 分组
        const byChapter = {};
        for (const m of list) {
            const ch = m.chapter || 0;
            if (!byChapter[ch]) byChapter[ch] = [];
            byChapter[ch].push(m);
        }
        const chapters = Object.keys(byChapter).map(Number).sort((a, b) => a - b);

        const html = `
            <div class="mem-header">
                <div class="mem-hint">
                    <i class="fa-solid fa-circle-info"></i>
                    叙事记忆：每章后由 AI 自动提取的关键细节，按 importance 排序注入 system prompt。
                </div>
                <div class="mem-actions">
                    <button type="button" class="btn btn-sm" data-mem-act="add"><i class="fa-solid fa-plus"></i> 新建记忆</button>
                    <button type="button" class="btn btn-sm" data-mem-act="extract"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 提取本章记忆</button>
                    <button type="button" class="btn btn-sm" data-mem-act="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
                </div>
            </div>
            <div class="mem-status" id="memStatus"></div>
            ${list.length ? _renderByChapter(chapters, byChapter) : '<div class="mem-empty">暂无记忆。</div>'}
        `;
        $container.innerHTML = html;
        _wire($container);
    }

    function _renderByChapter(chapters, byChapter) {
        return `
            <div class="mem-timeline">
                ${chapters.map(ch => `
                    <div class="mem-chapter" data-chapter="${ch}">
                        <div class="mem-chapter-head">第 ${ch} 章 · ${byChapter[ch].length} 条记忆</div>
                        <div class="mem-list">
                            ${byChapter[ch].map(m => _renderItem(m)).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>`;
    }

    function _renderItem(m) {
        return `
        <div class="mem-item" data-id="${_esc(m.id)}">
            <div class="mem-item-head">
                <span class="mem-item-cat">${_esc(_CAT_LABEL[m.category] || m.category || '其他')}</span>
                <input type="number" class="mem-item-imp" data-field="importance" min="1" max="10" value="${m.importance}" title="importance 1-10">
                <span class="mem-item-snippet" title="${_esc(m.snippet || '')}">${_esc((m.snippet || '').slice(0, 80))}</span>
                <button type="button" class="mem-item-act" data-act="save" title="保存"><i class="fa-solid fa-check"></i></button>
                <button type="button" class="mem-item-act mem-item-act-danger" data-act="delete" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
            <textarea class="mem-item-content" data-field="content" rows="2">${_esc(m.content)}</textarea>
        </div>`;
    }

    function _wire($container) {
        $container.querySelectorAll('[data-mem-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                const act = btn.dataset.memAct;
                if (act === 'add') _add($container);
                else if (act === 'extract') _extract($container);
                else if (act === 'refresh') render($container, _novelId);
            });
        });
        $container.querySelectorAll('.mem-item').forEach(item => {
            const id = item.dataset.id;
            item.querySelectorAll('[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const act = btn.dataset.act;
                    if (act === 'save') {
                        const importance = parseInt(item.querySelector('[data-field="importance"]').value, 10);
                        const content = item.querySelector('[data-field="content"]').value.trim();
                        if (!content) { if (window.toast) window.toast('内容必填', 'warn'); return; }
                        const r = await window.api.ainovel.updateMemory(_novelId, id, { content, importance: Number.isFinite(importance) ? importance : 5 });
                        if (r && r.ok) { if (window.toast) window.toast('已保存', 'success', 1200); }
                        else if (window.toast) window.toast('保存失败：' + (r && r.error || '未知'), 'error');
                    } else if (act === 'delete') {
                        if (!window.confirm('确认删除该记忆？')) return;
                        const r = await window.api.ainovel.deleteMemory(_novelId, id);
                        if (r && r.ok) render($container, _novelId);
                    }
                });
            });
        });
    }

    async function _add($container) {
        const content = window.prompt('记忆内容：');
        if (!content) return;
        const chapter = window.prompt('来源章节号：', '1');
        if (!chapter) return;
        const importance = parseInt(window.prompt('重要性 (1-10)：', '5') || '5', 10);
        const r = await window.api.ainovel.createMemory(_novelId, {
            content, importance,
            chapter: parseInt(chapter, 10),
        });
        if (r && r.ok) render($container, _novelId);
        else if (window.toast) window.toast('创建失败：' + (r && r.error || '未知'), 'error');
    }

    async function _extract($container) {
        const chStr = window.prompt('从哪一章提取？', '');
        if (!chStr) return;
        const chapterNo = parseInt(chStr, 10);
        if (!Number.isFinite(chapterNo)) { if (window.toast) window.toast('无效章节号', 'warn'); return; }
        const $status = $container.querySelector('#memStatus');
        if ($status) $status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 提取第 ' + chapterNo + ' 章记忆…';
        const r = await window.api.ainovel.extractMemory(_novelId, chapterNo);
        if (!r || !r.ok) {
            if ($status) $status.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> ' + (r && r.error || '失败');
            if (window.toast) window.toast('提取失败：' + (r && r.error || '未知'), 'error');
            return;
        }
        if ($status) $status.innerHTML = '已采纳 <strong>' + r.adopted + '</strong> / ' + r.extracted + ' 条记忆';
        if (window.toast) window.toast('已采纳 ' + r.adopted + ' 条记忆', 'success');
        render($container, _novelId);
    }

    window.MemoryPanel = { render };
})();