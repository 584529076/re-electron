// web/js/block-editor.js
// Sprint 6.3: 章节段落级 Block 编辑器
// 渲染 chapters 为 block 列表，hover 出现工具条：编辑 / AI 修订 / 删除 / 后插入

'use strict';

(function () {
    // 在 novel 命名空间下挂载
    if (!window.NovelBlocks) window.NovelBlocks = {};

    let _activeNovelId = null;
    let _activeChapterId = null;
    let _blocks = [];              // 当前章节的 blocks 数组
    let _currentEditingBlockId = null;
    let _revisingBlockId = null;

    /**
     * 初始化：把 chapter modal 改造成 block 列表 + 工具条
     */
    function init({ $chapterContent, $chapterModal, $chapterTextarea, toast }) {
        // 保存原 view：把章节 view 容器包裹一层
        const originalParent = $chapterContent.parentElement;
        if (!originalParent) return;

        // 创建 block 容器
        const blockContainer = document.createElement('div');
        blockContainer.id = 'novelBlockContainer';
        blockContainer.className = 'novel-block-container';
        blockContainer.hidden = true;   // 默认隐藏；用户切换到 block 模式时显示
        originalParent.appendChild(blockContainer);

        // 在 modal header 加切换按钮
        const modalTitle = document.getElementById('novelChapterModalTitle');
        if (modalTitle) {
            const switchBtn = document.createElement('button');
            switchBtn.id = 'novelBlockViewToggle';
            switchBtn.className = 'btn btn-sm novel-block-view-toggle';
            switchBtn.innerHTML = '<i class="fa-solid fa-layer-group"></i> 段落视图';
            switchBtn.title = '切换段落级 block 编辑视图';
            modalTitle.appendChild(switchBtn);
            switchBtn.addEventListener('click', () => _toggleView());
        }
    }

    let _rawView = true;
    function _toggleView() {
        _rawView = !_rawView;
        const blockContainer = document.getElementById('novelBlockContainer');
        const $chapterContent = document.getElementById('novelChapterContent');
        const toggleBtn = document.getElementById('novelBlockViewToggle');
        if (_rawView) {
            // 显示原文
            if (blockContainer) blockContainer.hidden = true;
            if ($chapterContent) $chapterContent.hidden = false;
            if (toggleBtn) toggleBtn.classList.remove('active');
        } else {
            // 显示 block 视图
            if (blockContainer) blockContainer.hidden = false;
            if ($chapterContent) $chapterContent.hidden = true;
            if (toggleBtn) toggleBtn.classList.add('active');
            _renderBlocks();
        }
    }

    /**
     * 加载并渲染指定章节的 blocks
     */
    async function loadChapter(novelId, chapterId) {
        _activeNovelId = novelId;
        _activeChapterId = chapterId;
        if (!novelId || !chapterId) {
            _blocks = [];
            return;
        }
        try {
            const r = await window.api.ainovel.getChapterBlocks(novelId, chapterId);
            if (r && r.ok && Array.isArray(r.blocks)) {
                _blocks = r.blocks;
            } else {
                _blocks = [];
            }
        } catch (e) {
            console.error('[block-editor] loadChapter failed:', e);
            _blocks = [];
        }
        if (!_rawView) _renderBlocks();
    }

    function _renderBlocks() {
        const container = document.getElementById('novelBlockContainer');
        if (!container) return;
        if (!_blocks.length) {
            container.innerHTML = '<div class="novel-block-empty"><i class="fa-regular fa-file-lines"></i><p>本章节暂无段落</p></div>';
            return;
        }
        container.innerHTML = _blocks.map((b, idx) => {
            const typeLabel = { paragraph: '段', dialogue: '对', scene_break: '切' }[b.block_type] || '段';
            const preview = (b.content || '').slice(0, 80).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
            return `
                <div class="novel-block" data-id="${esc(b.id)}" data-type="${esc(b.block_type)}">
                    <div class="novel-block-meta">
                        <span class="novel-block-idx">#${idx + 1}</span>
                        <span class="novel-block-type">${typeLabel}</span>
                        <span class="novel-block-pos">pos=${b.position}</span>
                    </div>
                    <div class="novel-block-content" data-id="${esc(b.id)}">${preview}${(b.content || '').length > 80 ? '…' : ''}</div>
                    <div class="novel-block-toolbar">
                        <button data-act="edit" title="编辑该段"><i class="fa-solid fa-pen"></i> 编辑</button>
                        <button data-act="revise" title="AI 修订该段"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 修订</button>
                        <button data-act="insert-after" title="在后插入新段"><i class="fa-solid fa-plus"></i> 插入</button>
                        <button data-act="delete" title="删除该段" class="novel-block-danger"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>`;
        }).join('');
        _wireToolbar(container);
    }

    function _wireToolbar(container) {
        container.querySelectorAll('.novel-block-toolbar button[data-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const block = btn.closest('.novel-block');
                if (!block) return;
                const blockId = block.dataset.id;
                const act = btn.dataset.act;
                if (act === 'edit') _editBlock(blockId);
                else if (act === 'revise') _reviseBlock(blockId);
                else if (act === 'insert-after') _insertAfterBlock(blockId);
                else if (act === 'delete') _deleteBlock(blockId);
            });
        });
    }

    async function _editBlock(blockId) {
        const block = _blocks.find(b => b.id === blockId);
        if (!block) return;
        const newText = window.prompt('编辑该段内容：', block.content || '');
        if (newText === null) return; // 用户取消
        try {
            const r = await window.api.ainovel.replaceBlock(_activeNovelId, _activeChapterId, blockId, newText);
            if (!r || !r.ok) {
                alert('保存失败：' + (r && r.error || '未知错误'));
                return;
            }
            await loadChapter(_activeNovelId, _activeChapterId);
            _renderBlocks();
            if (window.toast) window.toast('段落已更新', 'success');
        } catch (e) {
            alert('保存失败：' + e.message);
        }
    }

    async function _reviseBlock(blockId) {
        const block = _blocks.find(b => b.id === blockId);
        if (!block) return;
        const feedback = window.prompt('AI 修订意见（留空则润色）：', '润色这段文字，使其更生动自然。');
        if (feedback === null) return;
        _revisingBlockId = blockId;
        if (window.toast) window.toast('AI 修订中…请稍候', 'info');
        try {
            const r = await window.api.ainovel.reviseBlock(_activeNovelId, _activeChapterId, blockId, feedback);
            _revisingBlockId = null;
            if (!r || !r.ok) {
                alert('AI 修订失败：' + (r && r.error || '未知错误'));
                return;
            }
            await loadChapter(_activeNovelId, _activeChapterId);
            _renderBlocks();
            if (window.toast) window.toast('段落已 AI 修订', 'success');
        } catch (e) {
            _revisingBlockId = null;
            alert('AI 修订失败：' + e.message);
        }
    }

    async function _insertAfterBlock(blockId) {
        const text = window.prompt('新段落内容：', '');
        if (text === null || !text.trim()) return;
        try {
            const r = await window.api.ainovel.insertBlock(_activeNovelId, _activeChapterId, blockId, text, 'paragraph');
            if (!r || !r.ok) {
                alert('插入失败：' + (r && r.error || '未知错误'));
                return;
            }
            await loadChapter(_activeNovelId, _activeChapterId);
            _renderBlocks();
            if (window.toast) window.toast('段落已插入', 'success');
        } catch (e) {
            alert('插入失败：' + e.message);
        }
    }

    async function _deleteBlock(blockId) {
        if (!window.confirm('确定删除该段落？此操作可逆，但会修改章节内容。')) return;
        try {
            const r = await window.api.ainovel.deleteBlock(_activeNovelId, _activeChapterId, blockId);
            if (!r || !r.ok) {
                alert('删除失败：' + (r && r.error || '未知错误'));
                return;
            }
            await loadChapter(_activeNovelId, _activeChapterId);
            _renderBlocks();
            if (window.toast) window.toast('段落已删除', 'success');
        } catch (e) {
            alert('删除失败：' + e.message);
        }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // 导出 API
    window.NovelBlocks = {
        init,
        loadChapter,
        toggleView: _toggleView,
        renderBlocks: _renderBlocks,
        getBlocks: () => _blocks,
    };
})();
