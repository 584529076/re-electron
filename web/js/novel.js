// web/js/novel.js — AI 小说模块渲染端 UI
//
// 设计：
//   - IIFE 模式，导出 window.novel = { open, close, isOpen, ... }
//   - 监听 ainovel:event:update 实时刷新列表 / 详情
//   - 三 Tab：大纲 / 章节 / 日志
//   - 新建小说弹窗 + 章节查看/编辑弹窗
//   - 不依赖 workbench.js / task-queue.js / settings.js 任何内部 API（除通用 window.showToast）

(function () {
    'use strict';

    const esc = (s) => (window.dUtil && window.dUtil.escapeHtml)
        ? window.dUtil.escapeHtml(s) : String(s == null ? '' : s);
    const toast = (msg, type) => {
        if (window.showToast) window.showToast(msg, type || 'info');
        else console.log('[novel]', msg);
    };

    // ===== State =====
    const _st = {
        open: false,
        novels: [],
        activeNovelId: null,
        // Phase 3: 默认 tab 改为「工作台」(workspace)
        activeTab: 'workspace',
        providerConfig: null,
        // Phase 3: 成果 tab 的子模式（'view' 卡片视图 / 'edit' 表单编辑）
        artifactsMode: 'view',
    };

    // ===== 流式生成状态（同一时刻只允许一个 in-flight generation，避免重复提交 / 串流） =====
    const _stream = {
        active: false,
        kind: null,        // 'outline' | 'chapter'
        novelId: null,
        chapterId: null,
        jobId: null,       // 由 generation_started 事件回填，用于过滤 chunk
        skill: null,
        startedAt: 0,
        accumulated: '',
        timerHandle: null,
        $pane: null,       // 当前被流式视图覆盖的 tab pane
        $buf: null,        // <pre> buffer 元素（直接 textContent 追加）
        $elapsed: null,    // elapsed label
        // 章节列表缓存（流结束后重渲染时用）
        _lastChapters: null,
    };

    // ===== Pipeline 状态（Phase 2：多 agent 协作）=====
    // _stream 仍是底层 chunk 接收器；_pipeline 是 UI 顶层结构（一个 pipeline = 一棵树：phases × agents）
    const _pipeline = {
        active: false,
        kind: null,           // 'outline' | 'chapter'
        novelId: null,
        chapterId: null,
        jobId: null,
        startedAt: 0,
        totalCost: 0,         // 累加各 agent 的 cost_usd
        totalAgents: 0,
        totalPhases: 0,
        finishedAgents: 0,
        transitionText: '',
        phases: [],           // [{name, index, status, agents:[{name, role, status, tokens, duration_ms, accumulated, cost}]}]
        $pane: null,          // 覆盖的 tab pane
        $root: null,          // .novel-pipeline 容器
        $head: null,
        $elapsed: null,
        $cost: null,
        $phases: null,        // .novel-pipeline-phases 容器
        timerHandle: null,
    };
    const _AGENT_ICONS = {
        'style-analyst':       '🎨',
        'world-architect':     '🌍',
        'character-architect': '👤',
        'plot-architect':      '📖',
        'theme-architect':     '🔮',
        'outline-synthesizer': '🧩',
        'outline-reviewer':    '🧐',
        'scene-planner':       '🎬',
        'chapter-streamer':    '✍️',
        'continuity-checker':  '🔗',
        'style-editor':        '🖋️',
        'quality-reviewer':    '⭐',
    };

    // ===== Auto-progression UI 状态（Phase 2）=====
    const _auto = {
        active: false,
        paused: false,
        currentChapterNo: 0,
        totalChapters: 0,
        completedChapters: 0,
    };

    // ===== DOM refs (lazy) =====
    let $root, $list, $empty, $detail;
    let $tabOutline, $tabChapters, $tabLog, $tabWorkspace, $tabArtifacts, $tabKnowledge, $tabScheduler, $tabWorkflow;
    let $newModal, $newFormStyle, $newCustomStyleRow;
    let $chapterModal, $chapterView, $chapterEdit, $chapterContent, $chapterTextarea;
    let $logModal, $logMeta, $logRequest, $logResponse, $logError, $logErrorWrap;
    let $btnExportTxt, $btnDelete;
    let $providerBadge, $wordCurrent, $wordTarget, $wordProgress;

    function _ensureDom() {
        if ($root) return;
        $root = document.getElementById('novel');
        $list = document.getElementById('novelList');
        $empty = document.getElementById('novelEmpty');
        $detail = document.getElementById('novelDetail');
        $tabWorkspace = document.getElementById('novelTabWorkspace');
        $tabWorkflow = document.getElementById('novelTabWorkflow');
        $tabArtifacts = document.getElementById('novelTabArtifacts');
        $tabKnowledge = document.getElementById('novelTabKnowledge');
        $tabOutline = document.getElementById('novelTabOutline');
        $tabChapters = document.getElementById('novelTabChapters');
        $tabLog = document.getElementById('novelTabLog');
        $tabScheduler = document.getElementById('novelTabScheduler');
        $newModal = document.getElementById('novelNewModal');
        $newFormStyle = document.getElementById('novelFormStyle');
        $newCustomStyleRow = document.getElementById('novelFormCustomStyleRow');
        $chapterModal = document.getElementById('novelChapterModal');
        $chapterView = document.getElementById('novelChapterView');
        $chapterEdit = document.getElementById('novelChapterEdit');
        $chapterContent = document.getElementById('novelChapterContent');
        $chapterTextarea = document.getElementById('novelChapterTextarea');
        $logModal = document.getElementById('novelLogModal');
        $logMeta = document.getElementById('novelLogMeta');
        $logRequest = document.getElementById('novelLogRequest');
        $logResponse = document.getElementById('novelLogResponse');
        $logError = document.getElementById('novelLogError');
        $logErrorWrap = document.getElementById('novelLogErrorWrap');
        $btnExportTxt = document.getElementById('novelBtnExportTxt');
        $btnDelete = document.getElementById('novelBtnDelete');
        $providerBadge = document.getElementById('novelProviderBadge');
        $wordCurrent = document.getElementById('novelWordCurrent');
        $wordTarget = document.getElementById('novelWordTarget');
        $wordProgress = document.getElementById('novelWordProgress');

        // 新建按钮
        document.getElementById('novelBtnNew').addEventListener('click', () => _openNewModal());
        // 新建 modal
        document.getElementById('novelNewCancel').addEventListener('click', _closeNewModal);
        document.getElementById('novelNewCancel2').addEventListener('click', _closeNewModal);
        document.getElementById('novelNewSubmit').addEventListener('click', _submitNew);
        $newFormStyle.addEventListener('change', () => {
            $newCustomStyleRow.hidden = $newFormStyle.value !== '自定义';
        });
        // tabs
        document.querySelectorAll('.novel-tab').forEach(btn => {
            btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
        });
        // 删除按钮
        $btnDelete.addEventListener('click', _confirmDeleteActive);
        // 导出按钮
        $btnExportTxt.addEventListener('click', _exportActive);
        // 章节 modal
        document.getElementById('novelChapterClose').addEventListener('click', _closeChapterModal);
        document.getElementById('novelChapterCancel').addEventListener('click', _closeChapterModal);
        document.getElementById('novelChapterEditBtn').addEventListener('click', _enterChapterEdit);
        document.getElementById('novelChapterSaveBtn').addEventListener('click', _saveChapterEdit);
        // 日志详情 modal
        document.getElementById('novelLogClose').addEventListener('click', _closeLogDetail);
        document.getElementById('novelLogCloseFoot').addEventListener('click', _closeLogDetail);
        document.getElementById('novelLogCopyReq').addEventListener('click', () => _copyLogText($logRequest && $logRequest.textContent));
        document.getElementById('novelLogCopyRes').addEventListener('click', () => _copyLogText($logResponse && $logResponse.textContent));
        // OpenClaw 模式：用户反馈
        document.querySelectorAll('.novel-feedback-btn').forEach(btn => {
            btn.addEventListener('click', () => _onFeedbackVote(btn.dataset.vote));
        });
        document.getElementById('novelLogSubmitFeedback').addEventListener('click', _onSubmitFeedback);
        document.getElementById('novelLogOpenAgentConfig').addEventListener('click', _openAgentConfigFromLog);
        document.getElementById('novelLogFlushMemory').addEventListener('click', _onFlushMemory);
        // Agent 配置 modal
        document.getElementById('novelAgentConfigClose').addEventListener('click', _closeAgentConfig);
        document.querySelectorAll('.novel-config-tab').forEach(tab => {
            tab.addEventListener('click', () => _switchConfigTab(tab.dataset.file));
        });
        document.getElementById('novelConfigReload').addEventListener('click', _reloadConfigTab);
        document.getElementById('novelConfigSave').addEventListener('click', _saveConfigTab);
        // ESC 关闭
        if ($logModal) $logModal.addEventListener('click', (e) => {
            if (e.target === $logModal) _closeLogDetail();
        });

        // 事件订阅
        if (window.api && window.api.ainovel && window.api.ainovel.onUpdate) {
            window.api.ainovel.onUpdate((ev) => {
                // Sprint W: 工作面板钩子（最早期，让 stream 节点能 in-place 更新）
                try { _wfOnEvent(ev.type, ev); } catch (wfE) { /* best effort */ }
                if (!ev || !ev.type) return;
                // —— Pipeline 事件（Phase 2：多 agent）——
                if (ev.type === 'pipeline_started')  { _onPipelineStarted(ev); return; }
                if (ev.type === 'phase_started')     { _onPhaseStarted(ev);    return; }
                if (ev.type === 'agent_started')     { _onAgentStarted(ev);    return; }
                if (ev.type === 'agent_chunk')       { _onAgentChunk(ev);      return; }
                if (ev.type === 'agent_finished')    { _onAgentFinished(ev);   return; }
                if (ev.type === 'agent_failed')      { _onAgentFailed(ev);     return; }
                if (ev.type === 'phase_finished')    { _onPhaseFinished(ev);   return; }
                if (ev.type === 'pipeline_finished') { _onPipelineFinished(ev); return; }
                if (ev.type === 'pipeline_failed')   { _onPipelineFailed(ev);  return; }

                // —— Auto-progression 事件（Phase 2）——
                if (ev.type === 'auto_started')        { _onAutoStarted(ev);       return; }
                if (ev.type === 'auto_chapter_started'){ _onAutoChapterStarted(ev);return; }
                if (ev.type === 'auto_chapter_failed') { _onAutoChapterFailed(ev); return; }
                if (ev.type === 'auto_paused')         { _onAutoPaused(ev);        return; }
                if (ev.type === 'auto_resumed')        { _onAutoResumed(ev);       return; }
                if (ev.type === 'auto_cancelled')      { _onAutoCancelled(ev);     return; }
                if (ev.type === 'auto_finished')       { _onAutoFinished(ev);      return; }
                if (ev.type === 'auto_overseer_decided') { _onAutoOverseerDecided(ev); return; }
                if (ev.type === 'auto_overseer_failed') { _onAutoOverseerFailed(ev); return; }

                // —— Phase 3: 知识库抽取事件 ——
                if (ev.type === 'knowledge_extracting')         { _onKnowledgeExtracting(ev);         return; }
                if (ev.type === 'knowledge_extracted')          { _onKnowledgeExtracted(ev);          return; }
                if (ev.type === 'knowledge_extraction_failed')  { _onKnowledgeExtractionFailed(ev);   return; }
                if (ev.type === 'task_artifact_updated')        { _onTaskArtifactUpdated(ev);         return; }

                // —— Phase 4-A: 故事架构事件 ——
                if (ev.type === 'architecture_generated')          { _onArchitectureGenerated(ev);          return; }
                if (ev.type === 'architecture_generation_failed')  { _onArchitectureGenerationFailed(ev);  return; }
                if (ev.type === 'architecture_regenerating')       { _onArchitectureRegenerating(ev);      return; }

                // —— Phase 4-B/4-C/4-D: 圣经 + 架构钩子事件 ——
                if (ev.type === 'bible_committed')                 { _onBibleCommitted(ev);                 return; }
                if (ev.type === 'bible_update_failed')             { _onBibleUpdateFailed(ev);              return; }
                if (ev.type === 'chapter_pre_write_warnings')      { _onChapterPreWriteWarnings(ev);        return; }

                // —— 旧 single-skill 流式事件（仅 chapter-streamer 还在 emit stream；作 fallback 用）——
                if (ev.type === 'generation_started') {
                    if (_pipeline.active) return;   // pipeline 模式优先，旧 view 不渲染
                    _onGenerationStarted(ev);
                    return;
                }
                if (ev.type === 'stream') {
                    if (_pipeline.active && ev.skill === 'chapter-writer') return; // pipeline view 自己接管
                    _onStreamChunk(ev);
                    return;
                }
                if (ev.type === 'generation_failed') {
                    if (_pipeline.active) return;
                    _onGenerationFailed(ev);
                    return;
                }

                // 其余生命周期事件
                if (ev.type === 'novel_added' || ev.type === 'novel_removed' ||
                    ev.type === 'outline_generated' || ev.type === 'chapter_generated' ||
                    ev.type === 'chapter_updated' || ev.type === 'outline_updated') {
                    // 关闭 stream / pipeline 视图（如果是当前 novel）
                    const wasStreaming = _stream.active && ev.novelId === _stream.novelId;
                    if (wasStreaming) _endStream(true);
                    const wasPipeline = _pipeline.active && ev.novelId === _pipeline.novelId;
                    if (wasPipeline) _endPipeline(true, '完成');
                    // Phase 3: outline / chapter 已生成 → 清空 pipeline 历史 state，
                    // 让工作台 Tab 切回 idle 视图（否则 Panel 1 仍显示旧的 pipeline 树）
                    if (ev.type === 'outline_generated' || ev.type === 'chapter_generated') {
                        if (ev.novelId === _st.activeNovelId) {
                            _pipeline.phases = [];
                        }
                    }
                    _refreshList();
                    if (_st.activeNovelId && ev.novelId === _st.activeNovelId) {
                        _renderDetail();
                    }
                    if (ev.type === 'chapter_generated') {
                        toast('章节生成完成', 'success');
                    } else if (ev.type === 'outline_generated') {
                        toast('大纲生成完成', 'success');
                        // 全自动模式：大纲生成后自动开始连续写章节（无需用户点按钮）
                        _autoChainAfterOutlineIfEnabled(ev.novelId);
                    }
                }
            });
        }
    }

    // ===== Open / Close =====
    function open() {
        _ensureDom();
        if (_st.open) return;
        _st.open = true;
        $root.hidden = false;
        _refreshProviderBadge();
        _refreshList();
        window.dispatchEvent(new CustomEvent('novel:opened'));
    }

    function close() {
        if (!$root) return;
        if (!_st.open) return;
        _st.open = false;
        $root.hidden = true;
        window.dispatchEvent(new CustomEvent('novel:closed'));
    }

    function isOpen() {
        return _st.open === true;
    }

    // ===== List =====
    async function _refreshList() {
        if (!$list) return;
        try {
            const r = await window.api.ainovel.list();
            _st.novels = (r && r.ok && Array.isArray(r.novels)) ? r.novels : [];
        } catch (e) {
            console.warn('[novel] list 失败：', e.message);
            _st.novels = [];
        }
        _renderList();
    }

    function _renderList() {
        if (!$list) return;
        if (!_st.novels.length) {
            $list.innerHTML = '<div class="novel-list-empty">还没有小说</div>';
            _renderEmpty();
            return;
        }
        $list.innerHTML = _st.novels.map(n => {
            const statusLabel = ({planning:'规划中', outlining:'生成大纲', writing:'写作中', paused:'暂停', completed:'完成'})[n.status] || n.status;
            const pct = n.target_word_count ? Math.min(100, Math.round((n.current_word_count || 0) / n.target_word_count * 100)) : 0;
            const isActive = _st.activeNovelId === n.id;
            return `<div class="novel-list-item ${isActive ? 'active' : ''}" data-id="${esc(n.id)}" role="listitem">
                <div class="novel-list-item-title">${esc(n.title)}</div>
                <div class="novel-list-item-meta">
                    <span class="novel-status-pill novel-status-${esc(n.status || 'planning')}">${esc(statusLabel)}</span>
                    <span class="novel-list-item-progress">${(n.current_word_count || 0).toLocaleString()} / ${(n.target_word_count || 0).toLocaleString()} 字 (${pct}%)</span>
                </div>
            </div>`;
        }).join('');
        $list.querySelectorAll('.novel-list-item').forEach(el => {
            el.addEventListener('click', () => {
                _st.activeNovelId = el.dataset.id;
                _renderList();
                _renderDetail();
            });
        });
        _renderEmpty();
    }

    function _renderEmpty() {
        if (!$empty || !$detail) return;
        if (_st.novels.length === 0 || !_st.activeNovelId) {
            $empty.hidden = false;
            $detail.hidden = true;
            if ($btnExportTxt) $btnExportTxt.disabled = true;
        } else {
            $empty.hidden = true;
            $detail.hidden = false;
            if ($btnExportTxt) $btnExportTxt.disabled = false;
        }
    }

    // ===== Provider badge =====
    async function _refreshProviderBadge() {
        if (!$providerBadge) return;
        try {
            const r = await window.api.ainovel.getProviderConfig();
            const c = r && r.config;
            _st.providerConfig = c;
            if (!c) {
                $providerBadge.textContent = '未配置 LLM';
                $providerBadge.className = 'novel-provider-badge novel-provider-badge-warn';
            } else {
                $providerBadge.textContent = `${c.provider} · ${c.model}`;
                $providerBadge.className = 'novel-provider-badge novel-provider-badge-ok';
            }
        } catch (e) {
            $providerBadge.textContent = '配置读取失败';
            $providerBadge.className = 'novel-provider-badge novel-provider-badge-warn';
        }
    }

    // ===== Stream Lifecycle =====
// 由用户点击「生成大纲 / 重新生成 / 章节 生成」调用：先 mark in-flight，
// 把对应 tab pane 换成流式预览，再 fire-and-forget IPC（实际完成由事件驱动）。
function _startStream(kind, novelId, chapterId) {
    if (_stream.active) {
        toast('已有生成任务进行中，请等待完成', 'warn');
        return false;
    }
    _stream.active = true;
    _stream.kind = kind;
    _stream.novelId = novelId;
    _stream.chapterId = chapterId || null;
    _stream.jobId = null;            // 由 generation_started 事件回填
    _stream.skill = kind === 'outline' ? 'outline-architect' : 'chapter-writer';
    _stream.startedAt = Date.now();
    _stream.accumulated = '';

    // Phase 3: 切到工作台 tab，pane 用 workspace 内的「当前任务」panel body
    _stream.$pane = _getWorkspaceTaskBody();
    if (_st.activeTab !== 'workspace') {
        _switchTab('workspace');
    }
    if (!_stream.$pane) {
        // fallback: 用整个 workspace pane（_renderWorkspace 还没跑过的边界情况）
        _stream.$pane = $tabWorkspace;
        $tabWorkspace.classList.add('active');
    }
    _renderStreamingView();

    if (_stream.timerHandle) clearInterval(_stream.timerHandle);
    _stream.timerHandle = setInterval(_updateElapsed, 200);
    return true;
}

function _endStream(success, errorMsg) {
    if (_stream.timerHandle) { clearInterval(_stream.timerHandle); _stream.timerHandle = null; }
    const wasActive = _stream.active;
    const kind = _stream.kind;
    _stream.active = false;
    _stream.jobId = null;
    _stream.kind = null;
    _stream.novelId = null;
    _stream.chapterId = null;
    _stream.accumulated = '';
    _stream.skill = null;
    _stream.$pane = null;
    _stream.$buf = null;
    _stream.$elapsed = null;
    if (!wasActive) return;
    if (!success && errorMsg) toast(errorMsg, 'error');
    // 重新拉详情并渲染对应 tab（大纲已生成 / 章节已写入）
    if (_st.activeNovelId) _renderDetail();
}

function _renderStreamingView() {
    if (!_stream.$pane) return;
    const kindLabel = _stream.kind === 'outline' ? '大纲' : '章节正文';
    const targetLabel = _stream.kind === 'chapter' && _stream.chapterId
        ? '第 ' + _chapterNoFromId(_stream.chapterId) + ' 章'
        : '';
    _stream.$pane.innerHTML = `
        <div class="novel-streaming">
            <div class="novel-streaming-head">
                <span><i class="fa-solid fa-wand-magic-sparkles novel-streaming-icon"></i> 正在生成${targetLabel}${targetLabel ? ' ' + kindLabel : kindLabel}…</span>
                <span class="novel-streaming-elapsed">已等待 0.0s</span>
            </div>
            <div class="novel-streaming-hint">实时流式输出（${_stream.kind === 'outline' ? '完成后自动解析为 JSON 表单' : '完成后自动保存到章节'}）</div>
            <pre class="novel-streaming-buffer">（等待首个 token…）</pre>
        </div>`;
    _stream.$buf = _stream.$pane.querySelector('.novel-streaming-buffer');
    _stream.$elapsed = _stream.$pane.querySelector('.novel-streaming-elapsed');
}

function _updateElapsed() {
    if (!_stream.$elapsed) return;
    const sec = (Date.now() - _stream.startedAt) / 1000;
    _stream.$elapsed.textContent = `已等待 ${sec.toFixed(1)}s`;
}

function _onGenerationStarted(ev) {
    // 匹配 in-flight job（novelId 必须一致；chapter 必须一致）
    if (!_stream.active) return;          // 已经被别的 flow 抢先结束
    if (ev.novelId !== _stream.novelId) return;
    if (ev.skill && ev.skill !== _stream.skill) return;
    if (_stream.kind === 'chapter' && ev.chapterId !== _stream.chapterId) return;
    _stream.jobId = ev.jobId || _stream.jobId;
}

function _onStreamChunk(ev) {
    if (!_stream.active) return;
    if (ev.novelId !== _stream.novelId) return;
    if (ev.jobId && _stream.jobId && ev.jobId !== _stream.jobId) return;
    if (ev.chapterId && _stream.kind === 'chapter' && ev.chapterId !== _stream.chapterId) return;
    _stream.accumulated = ev.accumulated || (_stream.accumulated + (ev.chunk || ''));
    if (_stream.$buf) _stream.$buf.textContent = _stream.accumulated;
    // buffer 滚动到底
    if (_stream.$buf && _stream.$buf.scrollHeight > _stream.$buf.clientHeight) {
        _stream.$buf.scrollTop = _stream.$buf.scrollHeight;
    }
}

function _onGenerationFailed(ev) {
    if (!_stream.active) return;
    if (ev.novelId !== _stream.novelId) return;
    if (_stream.kind === 'chapter' && ev.chapterId !== _stream.chapterId) return;
    _endStream(false, '生成失败：' + (ev.error || '未知错误'));
}

function _chapterNoFromId(chapterId) {
    // 流式视图需要展示「第 N 章」，从缓存或上次拉的 _st 里查
    if (_stream._lastChapters) {
        const ch = _stream._lastChapters.find(c => c.id === chapterId);
        if (ch) return ch.chapter_no;
    }
    return '?';
}

// ===== Pipeline Lifecycle（Phase 2：多 agent 协作 UI）=====
function _startPipeline(kind, novelId, chapterId) {
    if (_stream.active || _pipeline.active) {
        toast('已有生成任务进行中，请等待完成', 'warn');
        return false;
    }
    _pipeline.active = true;
    _pipeline.kind = kind;
    _pipeline.novelId = novelId;
    _pipeline.chapterId = chapterId || null;
    _pipeline.jobId = null;
    _pipeline.startedAt = Date.now();
    _pipeline.totalCost = 0;
    _pipeline.totalAgents = 0;
    _pipeline.totalPhases = 0;
    _pipeline.finishedAgents = 0;
    _pipeline.transitionText = '';
    _pipeline.phases = [];

    // Phase 3: pipeline view 切到「工作台」tab，pane 用 workspace 内的「当前任务」panel body
    _pipeline.$pane = _getWorkspaceTaskBody();
    if (_st.activeTab !== 'workspace') {
        _switchTab('workspace');
    }
    if (!_pipeline.$pane) {
        // fallback: 用整个 workspace pane（_renderWorkspace 还没跑过的边界情况）
        _pipeline.$pane = $tabWorkspace;
        $tabWorkspace.classList.add('active');
    }
    _renderPipelineView();

    if (_pipeline.timerHandle) clearInterval(_pipeline.timerHandle);
    _pipeline.timerHandle = setInterval(_updatePipelineElapsed, 200);
    return true;
}

function _endPipeline(success, statusText) {
    if (_pipeline.timerHandle) { clearInterval(_pipeline.timerHandle); _pipeline.timerHandle = null; }
    const wasActive = _pipeline.active;
    _pipeline.active = false;
    _pipeline.jobId = null;
    if (!wasActive) return;
    // 替换 head 状态
    if (_pipeline.$head) {
        const label = success !== false ? (statusText || '已完成') : ('失败：' + (statusText || '未知错误'));
        const cls = success !== false ? 'pipeline-head-done' : 'pipeline-head-failed';
        const oldHTML = _pipeline.$head.innerHTML;
        _pipeline.$head.classList.add(cls);
        // 在 head 右侧追加状态
        if (!_pipeline.$head.querySelector('.novel-pipeline-status')) {
            const span = document.createElement('span');
            span.className = 'novel-pipeline-status';
            span.textContent = label;
            _pipeline.$head.appendChild(span);
        }
    }
    // 把所有 running 状态的 agent 标 done
    for (const ph of _pipeline.phases) {
        for (const a of ph.agents) {
            if (a.status === 'running') {
                a.status = success !== false ? 'done' : 'failed';
                _updateAgentCardDOM(a);
            }
        }
    }
    // 详情刷新由 outline_generated / chapter_generated 等持久化完成事件触发。
    // pipeline_finished 发生在大纲写入 DB 之前，不能在这里读取详情，否则会把空数据渲染回界面。
}

function _renderPipelineView() {
    if (!_pipeline.$pane) return;
    _pipeline.$pane.innerHTML = `
        <div class="novel-pipeline">
            <div class="novel-pipeline-head">
                <span class="novel-pipeline-title"><i class="fa-solid fa-diagram-project"></i> 多 Agent 协作 · ${_pipeline.kind === 'outline' ? '大纲生成' : '章节生成'}</span>
                <span class="novel-pipeline-elapsed">已等待 0.0s</span>
                <span class="novel-pipeline-cost">$0.0000</span>
            </div>
            <div class="novel-pipeline-hint">实时显示各 agent 调用进度；评审不通过会自动重写</div>
            <div class="novel-pipeline-progress"><span class="dot-running"></span><span class="progress-text">等待启动...</span></div>
            <div class="novel-pipeline-phases"></div>
        </div>`;
    _pipeline.$root = _pipeline.$pane.querySelector('.novel-pipeline');
    _pipeline.$head = _pipeline.$pane.querySelector('.novel-pipeline-head');
    _pipeline.$elapsed = _pipeline.$pane.querySelector('.novel-pipeline-elapsed');
    _pipeline.$cost = _pipeline.$pane.querySelector('.novel-pipeline-cost');
    _pipeline.$phases = _pipeline.$pane.querySelector('.novel-pipeline-phases');
    _pipeline.$progress = _pipeline.$pane.querySelector('.novel-pipeline-progress');
    _pipeline.$progressText = _pipeline.$pane.querySelector('.progress-text');
}

function _updatePipelineElapsed() {
    if (!_pipeline.$elapsed) return;
    const sec = (Date.now() - _pipeline.startedAt) / 1000;
    _pipeline.$elapsed.textContent = `已等待 ${sec.toFixed(1)}s`;

    // 1) 实时进度文案：明确当前 agent 阶段和阶段间的整理等待
    if (_pipeline.$progressText) {
        const total = _pipeline.totalAgents;
        const done = _pipeline.finishedAgents;
        let running = 0;
        for (const ph of _pipeline.phases) {
            for (const a of ph.agents) if (a.status === 'running') running++;
        }
        const current = [..._pipeline.phases].reverse().find(ph => ph.status === 'running')
            || _pipeline.phases[_pipeline.phases.length - 1];
        const currentLabel = current ? _phaseDisplayName(current.name) : '';
        let text = _pipeline.transitionText;
        if (running > 0) {
            text = `正在执行 ${currentLabel} · ${done}/${total} agents 完成 · ${running} 个调用中`;
        } else if (!text && current) {
            const phaseAgentsDone = current.agents.length > 0 && current.agents.every(a =>
                a.status === 'done' || a.status === 'failed'
            );
            text = phaseAgentsDone
                ? `${currentLabel} · agents 已返回，正在汇总结果…`
                : `${currentLabel} · 正在准备 agent 调用…`;
        } else if (!text) {
            text = '任务已接收，正在准备多 Agent 协作…';
        }
        if (_pipeline.$progressText.textContent !== text) _pipeline.$progressText.textContent = text;
    }

    // 2) 更新所有 running agent 卡片（让「调用中 X.Xs · ~N 字」实时刷新）
    for (const ph of _pipeline.phases) {
        for (const a of ph.agents) {
            if (a.status === 'running') _updateAgentCardDOM(a);
        }
    }
}

function _onPipelineStarted(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    _pipeline.jobId = ev.jobId || _pipeline.jobId;
    _pipeline.totalPhases = ev.totalPhases || _pipeline.totalPhases;
    _pipeline.transitionText = '任务已接收，正在准备多 Agent 协作…';
    if (_pipeline.$progressText) _pipeline.$progressText.textContent = _pipeline.transitionText;
}

function _onPhaseStarted(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = {
        name: ev.phaseName,
        index: ev.phaseIndex,
        status: 'running',
        agents: (ev.agents || []).map(name => ({
            name, role: '', status: 'idle',
            tokens: { prompt: 0, completion: 0 },
            duration_ms: 0,
            accumulated: '',
            cost: 0,
        })),
    };
    _pipeline.phases.push(phase);
    _pipeline.totalAgents += phase.agents.length;
    _pipeline.transitionText = '';
    _renderPhaseRow(phase);
    if (_pipeline.$progressText) {
        _pipeline.$progressText.textContent = `${_phaseDisplayName(phase.name)} · 正在启动 agent…`;
    }
}

function _onAgentStarted(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = _pipeline.phases.find(p => p.index === ev.phaseIndex);
    if (!phase) return;
    let agent = phase.agents.find(a => a.name === ev.agentName);
    if (!agent) {
        // 后到的 agent（如评审循环重写时多出来的）
        agent = {
            name: ev.agentName, role: ev.role || '',
            status: 'idle', tokens: { prompt: 0, completion: 0 },
            duration_ms: 0, accumulated: '', cost: 0,
            startedAt: 0,
        };
        phase.agents.push(agent);
        _pipeline.totalAgents += 1;
        _renderAgentCard(phase, agent);
    } else {
        agent.role = ev.role || agent.role;
    }
    agent.status = 'running';
    agent.startedAt = Date.now();
    _updateAgentCardDOM(agent);
}

function _onAgentChunk(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = _pipeline.phases.find(p => p.index === ev.phaseIndex);
    if (!phase) return;
    const agent = phase.agents.find(a => a.name === ev.agentName);
    if (!agent) return;
    agent.accumulated = ev.accumulated || (agent.accumulated + (ev.chunk || ''));
    _updateAgentCardDOM(agent);
}

function _onAgentFinished(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = _pipeline.phases.find(p => p.index === ev.phaseIndex);
    if (!phase) return;
    const agent = phase.agents.find(a => a.name === ev.agentName);
    if (!agent) return;
    agent.status = 'done';
    if (ev.tokens) agent.tokens = { prompt: ev.tokens.prompt || 0, completion: ev.tokens.completion || 0 };
    agent.duration_ms = ev.duration_ms || 0;
    agent.cost = ev.cost_usd || 0;
    agent.output = ev.output || agent.output;
    _pipeline.totalCost += agent.cost;
    _pipeline.finishedAgents += 1;
    _updateAgentCardDOM(agent);
    _updatePipelineCost();
}

function _onAgentFailed(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = _pipeline.phases.find(p => p.index === ev.phaseIndex);
    if (!phase) return;
    const agent = phase.agents.find(a => a.name === ev.agentName);
    if (!agent) return;
    agent.status = 'failed';
    agent.error = ev.error;
    _pipeline.finishedAgents += 1;
    _updateAgentCardDOM(agent);
}

function _onPhaseFinished(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    const phase = _pipeline.phases.find(p => p.index === ev.phaseIndex);
    if (!phase) return;
    phase.status = 'done';
    _updatePhaseRowDOM(phase);
    _pipeline.transitionText = `✓ ${_phaseDisplayName(phase.name)} 已完成 · 正在整理结果，准备下一阶段…`;
    if (_pipeline.$progressText) _pipeline.$progressText.textContent = _pipeline.transitionText;
}

function _onPipelineFinished(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    _endPipeline(true, '已完成');
}

function _onPipelineFailed(ev) {
    if (!_pipeline.active) return;
    if (ev.novelId !== _pipeline.novelId) return;
    if (ev.jobId && _pipeline.jobId && ev.jobId !== _pipeline.jobId) return;
    _endPipeline(false, ev.error || '未知错误');
}

function _renderPhaseRow(phase) {
    if (!_pipeline.$phases) return;
    const $row = document.createElement('div');
    // 切 tab 回来时重建：根据 phase.done 决定初始 class
    $row.className = 'novel-pipeline-phase ' + (phase.done ? 'phase-done' : 'phase-running');
    $row.dataset.phaseIndex = String(phase.index);
    const headIconClass = phase.done ? 'fa-solid fa-check' : 'fa-solid fa-circle-notch fa-spin';
    $row.innerHTML = `
        <div class="novel-phase-head">
            <i class="${headIconClass}"></i>
            <span class="novel-phase-name"></span>
            <span class="novel-phase-count"></span>
        </div>
        <div class="novel-agent-grid"></div>`;
    $row.querySelector('.novel-phase-name').textContent = _phaseDisplayName(phase.name);
    $row.querySelector('.novel-phase-count').textContent = `${phase.agents.length} agents`;
    _pipeline.$phases.appendChild($row);
    phase.$row = $row;
    phase.$grid = $row.querySelector('.novel-agent-grid');
    for (const agent of phase.agents) _renderAgentCard(phase, agent);
}

function _updatePhaseRowDOM(phase) {
    if (!phase || !phase.$row) return;
    phase.$row.classList.remove('phase-running');
    phase.$row.classList.add('phase-done');
    const $head = phase.$row.querySelector('.novel-phase-head');
    if ($head) {
        const $icon = $head.querySelector('i');
        if ($icon) { $icon.classList.remove('fa-circle-notch', 'fa-spin'); $icon.classList.add('fa-check'); }
    }
}

function _renderAgentCard(phase, agent) {
    if (!phase || !phase.$grid) return;
    const $card = document.createElement('div');
    $card.className = 'novel-agent-card agent-idle';
    $card.dataset.agentName = agent.name;
    $card.innerHTML = `
        <div class="novel-agent-head">
            <span class="novel-agent-icon"></span>
            <span class="novel-agent-name"></span>
            <span class="novel-agent-role"></span>
        </div>
        <div class="novel-agent-status">等待中…</div>
        <details class="novel-agent-detail" hidden>
            <summary>查看输出</summary>
            <pre class="novel-agent-output"></pre>
        </details>`;
    const icon = _AGENT_ICONS[agent.name] || '🤖';
    $card.querySelector('.novel-agent-icon').textContent = icon;
    $card.querySelector('.novel-agent-name').textContent = agent.name;
    $card.querySelector('.novel-agent-role').textContent = agent.role || '';
    phase.$grid.appendChild($card);
    agent.$card = $card;
    // 切 tab 回来时重建卡片：按 agent 当前真实 status 初始化（避免重新显示"等待中…"）
    if (agent.status && agent.status !== 'idle') {
        _updateAgentCardDOM(agent);
    }
}

function _updateAgentCardDOM(agent) {
    if (!agent.$card) return;
    const $card = agent.$card;
    $card.classList.remove('agent-idle', 'agent-running', 'agent-done', 'agent-failed');
    $card.classList.add('agent-' + agent.status);
    const $status = $card.querySelector('.novel-agent-status');
    if ($status) {
        let text = '';
        if (agent.status === 'idle')        text = '等待中…';
        else if (agent.status === 'running') {
            const elapsed = agent.startedAt ? ((Date.now() - agent.startedAt) / 1000).toFixed(1) : '0.0';
            const chars = (agent.accumulated || '').length;
            text = `调用中 ${elapsed}s${chars > 0 ? ` · ~${chars} 字` : ''}`;
        }
        else if (agent.status === 'done') {
            const dur = agent.duration_ms ? (agent.duration_ms / 1000).toFixed(1) + 's' : '';
            const tok = (agent.tokens.prompt || 0) + (agent.tokens.completion || 0);
            text = `✓ ${dur} · ${tok} tok` + (agent.cost ? ` · $${agent.cost.toFixed(4)}` : '');
        }
        else if (agent.status === 'failed')  text = '✗ ' + (agent.error || '失败');
        $status.textContent = text;
    }
    // 对 chapter-streamer 这种输出长文本的 agent，显示 streaming buffer
    const isStreamer = agent.name === 'chapter-streamer';
    if (isStreamer && (agent.status === 'running' || agent.status === 'done')) {
        let $pre = $card.querySelector('.novel-agent-stream');
        if (!$pre) {
            $pre = document.createElement('pre');
            $pre.className = 'novel-agent-stream';
            $card.appendChild($pre);
        }
        $pre.textContent = agent.accumulated || '';
        if ($pre.scrollHeight > $pre.clientHeight) $pre.scrollTop = $pre.scrollHeight;
    }
    // 输出 summary（成功 agent 可以查看完整输出）
    if (agent.status === 'done' && agent.output && !isStreamer) {
        const $detail = $card.querySelector('.novel-agent-detail');
        const $pre = $card.querySelector('.novel-agent-output');
        if ($detail && $pre) {
            $detail.hidden = false;
            try {
                $pre.textContent = JSON.stringify(agent.output, null, 2);
            } catch {
                $pre.textContent = String(agent.output);
            }
        }
    }
}

function _updatePipelineCost() {
    if (!_pipeline.$cost) return;
    _pipeline.$cost.textContent = '$' + _pipeline.totalCost.toFixed(4);
}

function _phaseDisplayName(name) {
    const map = {
        'phase-A1-style':       '阶段 1 · 风格分析',
        'phase-A2-world':       '阶段 2 · 世界设定',
        'phase-A3-character':   '阶段 3 · 人物设计',
        'phase-B1-theme':       '阶段 4 · 主题分析',
        'phase-B2-plot':        '阶段 5 · 剧情结构',
        'phase-C-synthesize':   '阶段 6 · 大纲汇聚',
        'phase-C-revise':       '阶段 6 · 大纲修订',
        'phase-D-review':       '阶段 7 · 评审循环',
        'phase-A-plan':         '阶段 1 · 场景规划',
        'phase-B-write':        '阶段 2 · 章节写作',
        'phase-C-review':       '阶段 3 · 评审',
        'phase-B-rewrite-2':    '阶段 2 · 章节重写',
        'phase-B-rewrite-3':    '阶段 2 · 章节重写',
    };
    return map[name] || name;
}

// ===== Detail (Tabs) =====
    async function _renderDetail() {
        if (!_st.activeNovelId) return;
        try {
            const r = await window.api.ainovel.get(_st.activeNovelId);
            if (!r || !r.ok) {
                toast(r && r.error || '加载失败', 'error');
                return;
            }
            // Phase 4-A: 同时加载架构（不影响其他 tab 性能，仅 artifacts/knowledge 用）
            try {
                const ar = await window.api.ainovel.getArchitecture(_st.activeNovelId);
                if (ar && ar.ok) r.architecture = ar.architecture;
            } catch (e) { /* 架构缺失不阻塞 */ }
            _renderHeader(r);
            // Phase 3: 5 个 tab 分发
            if (_st.activeTab === 'workspace') {
                _renderWorkspace(r);
            } else if (_st.activeTab === 'workflow') {
                await _renderWorkflow(r);
            } else if (_st.activeTab === 'artifacts') {
                _renderArtifacts(r);
            } else if (_st.activeTab === 'knowledge') {
                await _renderKnowledge(r);
            } else if (_st.activeTab === 'chapters') {
                _renderChapters(r);
            } else if (_st.activeTab === 'log') {
                await _renderLog(r);
            } else if (_st.activeTab === 'scheduler') {
                await _renderScheduler(r);
            } else if (_st.activeTab === 'outline') {
                // 旧大纲编辑表单（从成果 tab 点「编辑大纲」触发）
                _renderOutline(r);
            }
        } catch (e) {
            console.error('[novel] renderDetail:', e);
            toast('加载失败：' + e.message, 'error');
        }
    }

    function _renderHeader(r) {
        const nv = r.novel;
        if ($wordProgress) $wordProgress.hidden = false;
        if ($wordCurrent) $wordCurrent.textContent = (nv.current_word_count || 0).toLocaleString();
        if ($wordTarget) $wordTarget.textContent = (nv.target_word_count || 0).toLocaleString();
    }

    // ============================================================
    // Phase 3: 工作台 Tab（默认）
    // ============================================================
    // 结构：3 个面板
    //   1. 当前任务 — running 时显示 pipeline view，idle 时显示操作按钮 + 上次摘要
    //   2. 计划与策略 — Phase A 跑完后显示 3 候选世界 / 3 候选主角（占位，Sprint M 完整化）
    //   3. 最近产出 — 最近一次大纲/章节生成的关键摘录
    // Phase 3: 取工作台 Panel 1「当前任务」body 元素（pipeline / stream view 容器）
    function _getWorkspaceTaskBody() {
        return document.getElementById('novelWsCurrentTaskBody');
    }

    function _renderWorkspace(r) {
        if (!$tabWorkspace) return;
        const nv = r.novel;
        const outline = r.outline;
        const chapters = (r.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no);
        const hasOutline = !!(outline && (outline.world_setting || outline.structure || outline.chapter_list));
        const doneChapters = chapters.filter(c => c.status === 'done').length;
        const pendingChapters = chapters.length - doneChapters;
        const status = nv.status || 'planning';
        const isRunning = (_pipeline.active && _pipeline.novelId === _st.activeNovelId) ||
                          (_stream.active && _stream.novelId === _st.activeNovelId);

        $tabWorkspace.innerHTML = `
<div class="novel-workspace">
  <!-- Panel 1: 当前任务（pipeline / stream view 容器在这里）-->
  <section class="novel-workspace-panel" id="novelWsCurrentTask">
    <div class="novel-workspace-head">
      <span class="novel-workspace-head-title"><i class="fa-solid fa-bolt"></i> 当前任务</span>
      <span class="novel-workspace-head-meta">
        <span class="novel-status-pill novel-status-${esc(status)}">${esc(({planning:'规划中',outlining:'生成大纲',writing:'写作中',paused:'暂停',completed:'完成'})[status] || status)}</span>
        ${hasOutline ? `<span class="novel-workspace-progress">大纲已生成 · ${chapters.length} 章 / 已完成 ${doneChapters}</span>` : ''}
      </span>
    </div>
    <div class="novel-workspace-body" id="novelWsCurrentTaskBody">
      ${isRunning
        ? '<div class="novel-workspace-hint"><i class="fa-solid fa-circle-info"></i> 正在加载任务视图…</div>'
        : _renderWorkspaceIdleActions(hasOutline, pendingChapters, chapters)}
    </div>
  </section>

  <!-- Panel 2: 计划与策略（Phase A 候选物）-->
  <section class="novel-workspace-panel" id="novelWsPlanStrategy">
    <div class="novel-workspace-head">
      <span class="novel-workspace-head-title"><i class="fa-solid fa-lightbulb"></i> 计划与策略</span>
      <span class="novel-workspace-head-meta"><span class="novel-workspace-hint-mini">发散阶段的候选产物（Phase A 跑完后显示）</span></span>
    </div>
    <div class="novel-workspace-body" id="novelWsPlanStrategyBody">
      ${hasOutline
        ? _renderWorkspacePlanStrategyBody(outline)
        : `<div class="novel-workspace-empty"><i class="fa-regular fa-lightbulb"></i><p>暂无候选物。生成大纲后，Phase A 的 3 候选世界 / 3 候选主角会出现在这里。</p></div>`}
    </div>
  </section>

  <!-- Panel 3: 最近产出 -->
  <section class="novel-workspace-panel" id="novelWsRecentOutputs">
    <div class="novel-workspace-head">
      <span class="novel-workspace-head-title"><i class="fa-solid fa-scroll"></i> 最近产出</span>
      <span class="novel-workspace-head-meta">
        ${hasOutline ? `<button class="btn btn-sm" id="novelWsGoArtifacts"><i class="fa-solid fa-arrow-up-right-from-square"></i> 查看完整成果</button>` : ''}
      </span>
    </div>
    <div class="novel-workspace-body" id="novelWsRecentOutputsBody">
      ${hasOutline
        ? _renderWorkspaceRecentOutputs(outline, chapters)
        : `<div class="novel-workspace-empty"><i class="fa-regular fa-scroll"></i><p>暂无产出。生成大纲后这里会显示世界观摘要、主题 chips、最近章节摘要预览。</p></div>`}
    </div>
  </section>
</div>`;

        // idle 态操作按钮绑定
        if (!isRunning) {
            const btnGen = document.getElementById('novelWsBtnGenOutline');
            if (btnGen) btnGen.addEventListener('click', _generateOutline);
            const btnRegen = document.getElementById('novelWsBtnRegenOutline');
            if (btnRegen) btnRegen.addEventListener('click', () => {
                if (confirm('确认重新生成大纲？现有大纲会被覆盖。')) _generateOutline();
            });
            const btnAuto = document.getElementById('novelWsBtnAutoStart');
            if (btnAuto) btnAuto.addEventListener('click', _startAutoFromWorkspace);
            const btnRewrite = document.getElementById('novelWsBtnRewriteChapter');
            if (btnRewrite) btnRewrite.addEventListener('click', _rewriteLatestChapter);
        }
        const btnGo = document.getElementById('novelWsGoArtifacts');
        if (btnGo) btnGo.addEventListener('click', () => _switchTab('artifacts'));

        // Phase 3 关键修复：如果 pipeline / stream 正在运行，把 pipeline view 渲染进 Panel 1 body
        // 这样切 tab 回来时，_renderWorkspace 重写 outer panels，但 Panel 1 body 的 pipeline DOM
        // 由 _renderPipelineView / _renderStreamingView 重新注入，状态完整保留
        // 边界：pipeline 已完成（active=false）但 phases 还在 → 显示最终 pipeline 状态
        if (_pipeline.novelId === _st.activeNovelId &&
            (_pipeline.active || (_pipeline.phases && _pipeline.phases.length > 0))) {
            _pipeline.$pane = _getWorkspaceTaskBody();
            _renderPipelineView();
            // 重建 phase rows + agent cards（基于 _pipeline.phases 当前状态）
            _pipeline.$phases.innerHTML = '';
            for (const phase of _pipeline.phases) {
                phase.$row = null;
                phase.$grid = null;
                _renderPhaseRow(phase);
            }
            // 标记完成态（_endPipeline 会写状态文本；这里再确认一次）
            if (!_pipeline.active && _pipeline.$head) {
                const $status = _pipeline.$head.querySelector('.novel-pipeline-status');
                if (!$status) {
                    const span = document.createElement('span');
                    span.className = 'novel-pipeline-status';
                    span.textContent = '已完成';
                    _pipeline.$head.appendChild(span);
                    _pipeline.$head.classList.add('pipeline-head-done');
                }
            }
            // 重启计时器（_endPipeline 会清掉）
            if (!_pipeline.timerHandle && _pipeline.active) {
                _pipeline.timerHandle = setInterval(_updatePipelineElapsed, 200);
            }
        } else if (_stream.novelId === _st.activeNovelId &&
                   (_stream.active || _stream.accumulated)) {
            _stream.$pane = _getWorkspaceTaskBody();
            _renderStreamingView();
            if (!_stream.timerHandle && _stream.active) {
                _stream.timerHandle = setInterval(_updateElapsed, 200);
            }
        }
    }

    // idle 态操作面板：3 个主要操作（生成大纲 / 重新生成 / 自动写作）
    function _renderWorkspaceIdleActions(hasOutline, pendingChapters, chapters) {
        const lastChapter = (chapters || []).filter(c => c.status === 'done').slice(-1)[0];
        const summary = lastChapter ? `上次完成：第 ${lastChapter.chapter_no} 章「${esc(lastChapter.title || '')}」` : '';
        if (!hasOutline) {
            return `
<div class="novel-workspace-actions">
  <button class="btn btn-primary" id="novelWsBtnGenOutline"><i class="fa-solid fa-wand-magic-sparkles"></i> 开始生成大纲</button>
  <p class="novel-workspace-action-hint"><i class="fa-solid fa-circle-info"></i> 4 阶段多 agent 协作：发散构思 → 主题深化 → 汇聚 → 评审循环。预计 3-5 分钟。</p>
</div>`;
        }
        return `
<div class="novel-workspace-actions">
  ${pendingChapters > 0 ? `<button class="btn btn-primary" id="novelWsBtnAutoStart"><i class="fa-solid fa-forward"></i> 开始自动写作（${pendingChapters} 章待写）</button>` : '<span class="novel-workspace-done-pill"><i class="fa-solid fa-check-circle"></i> 所有章节已完成</span>'}
  ${lastChapter ? `<button class="btn" id="novelWsBtnRewriteChapter"><i class="fa-solid fa-arrows-rotate"></i> 重写第 ${lastChapter.chapter_no} 章</button>` : ''}
  <button class="btn" id="novelWsBtnRegenOutline"><i class="fa-solid fa-diagram-project"></i> 重新生成大纲</button>
</div>
${summary ? `<div class="novel-workspace-summary">${summary}</div>` : ''}`;
    }

    // 计划与策略：从 outline 解析候选物（Phase A 输出）
    // outline.world_setting / outline.global_characters 通常包含结构化数据
    function _renderWorkspacePlanStrategyBody(outline) {
        const chars = safeJson(outline.global_characters) || [];
        const themes = safeJson(outline.themes) || [];
        // 抽取候选世界（如果有 worldCandidates 字段）
        const worldCandidates = safeJson(outline.worldCandidates) || [];
        const charCandidates = safeJson(outline.characterCandidates) || [];
        let html = '';
        if (worldCandidates.length) {
            html += `<div class="novel-ws-candidates">
                <div class="novel-ws-candidates-head">🌍 候选世界（Phase A 发散）</div>
                <div class="novel-ws-candidates-grid">${worldCandidates.map((w, i) => `
                    <details class="novel-ws-candidate">
                        <summary>候选 ${i+1}：${esc(w.name || w.title || '未命名')}</summary>
                        <pre>${esc(JSON.stringify(w, null, 2))}</pre>
                    </details>`).join('')}</div></div>`;
        }
        if (charCandidates.length) {
            html += `<div class="novel-ws-candidates">
                <div class="novel-ws-candidates-head">👤 候选主角（Phase A 发散）</div>
                <div class="novel-ws-candidates-grid">${charCandidates.map((c, i) => `
                    <details class="novel-ws-candidate">
                        <summary>候选 ${i+1}：${esc(c.name || '未命名')}</summary>
                        <pre>${esc(JSON.stringify(c, null, 2))}</pre>
                    </details>`).join('')}</div></div>`;
        }
        if (!html) {
            html = `<div class="novel-workspace-empty-mini">
                <i class="fa-regular fa-lightbulb"></i>
                <p>本大纲来自单 skill 调用，无 Phase A 发散候选物。</p>
                <p class="novel-workspace-hint-mini">下次重新生成大纲将启用 7 个 agent 协作模式，候选物会自动展示。</p>
            </div>`;
        }
        if (themes.length) {
            html += `<div class="novel-ws-themes">
                <div class="novel-ws-candidates-head">🔮 主题与母题</div>
                <div class="novel-ws-theme-chips">${themes.map(t => `<span class="novel-ws-theme-chip">${esc(t)}</span>`).join('')}</div>
            </div>`;
        }
        return html;
    }

    // 最近产出：世界观前 200 字 + 主题 chips + 章节摘要预览
    function _renderWorkspaceRecentOutputs(outline, chapters) {
        const ws = outline.world_setting || '';
        const wsPreview = ws.length > 200 ? ws.slice(0, 200) + '…' : ws;
        const themes = safeJson(outline.themes) || [];
        const doneChapters = chapters.filter(c => c.status === 'done').slice(-3);
        let html = `
<div class="novel-ws-output-section">
  <div class="novel-ws-output-label"><i class="fa-solid fa-globe"></i> 世界观（前 200 字）</div>
  <div class="novel-ws-output-text">${esc(wsPreview || '（尚未填写）')}</div>
</div>
${themes.length ? `<div class="novel-ws-output-section">
  <div class="novel-ws-output-label"><i class="fa-solid fa-tags"></i> 主题</div>
  <div class="novel-ws-theme-chips">${themes.map(t => `<span class="novel-ws-theme-chip">${esc(t)}</span>`).join('')}</div>
</div>` : ''}`;
        if (doneChapters.length) {
            html += `<div class="novel-ws-output-section">
  <div class="novel-ws-output-label"><i class="fa-regular fa-file-lines"></i> 最近完成章节</div>
  <div class="novel-ws-recent-chapters">${doneChapters.map(c => `
    <div class="novel-ws-recent-chapter" data-id="${esc(c.id)}">
      <div class="novel-ws-recent-chapter-head">
        <span class="novel-ws-recent-chapter-no">#${c.chapter_no}</span>
        <span class="novel-ws-recent-chapter-title">${esc(c.title || '(未命名)')}</span>
        <span class="novel-ws-recent-chapter-words">${(c.actual_word_count || 0).toLocaleString()} 字</span>
      </div>
      <div class="novel-ws-recent-chapter-summary">${esc((c.summary || '').slice(0, 120))}${(c.summary || '').length > 120 ? '…' : ''}</div>
    </div>`).join('')}</div>
</div>`;
        }
        return html;
    }

    // 工作台 → 开始自动写作（跳转章节 Tab）
    async function _startAutoFromWorkspace() {
        _switchTab('chapters');
        // 渲染章节 Tab 后再触发 auto start
        setTimeout(async () => {
            try {
                const r = await window.api.ainovel.autoStart(_st.activeNovelId);
                if (!r || !r.ok) {
                    toast(r && r.error || '自动写作启动失败', 'error');
                }
            } catch (e) {
                toast('启动失败：' + e.message, 'error');
            }
        }, 200);
    }

    // 工作台 → 重写最新完成的章节
    async function _rewriteLatestChapter() {
        try {
            const r = await window.api.ainovel.get(_st.activeNovelId);
            if (!r || !r.ok) return;
            const doneChapters = (r.chapters || []).filter(c => c.status === 'done').sort((a,b) => b.chapter_no - a.chapter_no);
            const last = doneChapters[0];
            if (!last) { toast('没有已完成的章节可重写', 'warn'); return; }
            if (!confirm(`确认重写第 ${last.chapter_no} 章「${last.title}」？现有正文会被覆盖。`)) return;
            _switchTab('chapters');
            _generateChapter(last.id);
        } catch (e) {
            toast('操作失败：' + e.message, 'error');
        }
    }

    // ============================================================
    // Phase 3: 成果 Tab（卡片视图 + 编辑切换）
    // ============================================================
    // 默认 view 模式：6 种卡片（世界观 / 主冲突 / 结构 / 主题 / 人物 / 章节）
    // 编辑模式：复用 _renderOutline 表单
    function _renderArtifactsArchitecture(arch) {
        if (!arch) return '';
        const threads = (arch.plot_threads || []).filter(Boolean);
        const arcs = (arch.character_arcs || []).filter(Boolean);
        const themeTracks = (arch.theme_tracks || []).filter(Boolean);
        const fores = (arch.foreshadowing_seed || []).filter(Boolean);
        const threeAct = arch.three_act || '';
        if (!threeAct && !threads.length && !arcs.length && !themeTracks.length && !fores.length) {
            return ''; // 架构为空就不渲染
        }
        return `
  <div class="novel-artifact-card novel-artifact-architecture">
    <div class="novel-artifact-card-head">
      <i class="fa-solid fa-layer-group"></i> 故事架构
      <span class="novel-artifact-architecture-badge">Phase 4-A</span>
    </div>
    <div class="novel-artifact-card-body">
      ${threeAct ? `<div class="novel-arch-threeact">${esc(threeAct).replace(/\n/g, '<br>')}</div>` : ''}
      ${threads.length ? `<div class="novel-arch-section">
        <div class="novel-arch-section-head"><i class="fa-solid fa-diagram-project"></i> 剧情子线（${threads.length}）</div>
        <div class="novel-arch-threads">
          ${threads.map(t => `
            <div class="novel-arch-thread">
              <span class="novel-arch-thread-id">${esc(t.id || 'PT')}</span>
              <span class="novel-arch-thread-name">${esc(t.name || '')}</span>
              <span class="novel-arch-thread-range">第 ${t.intro_ch || '?'} 章 → 第 ${t.resolve_ch || '?'} 章</span>
              ${t.description ? `<div class="novel-arch-thread-desc">${esc(t.description)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${arcs.length ? `<div class="novel-arch-section">
        <div class="novel-arch-section-head"><i class="fa-solid fa-route"></i> 人物弧线（${arcs.length}）</div>
        <div class="novel-arch-arcs">
          ${arcs.map(a => `
            <div class="novel-arch-arc">
              <div class="novel-arch-arc-name">${esc(a.name || '未命名')}</div>
              <div class="novel-arch-arc-row"><span class="novel-arch-arc-label">起点</span>${esc(a.start || '')}</div>
              <div class="novel-arch-arc-row"><span class="novel-arch-arc-label novel-arch-arc-mid">中点</span>${esc(a.midpoint || '')}</div>
              <div class="novel-arch-arc-row"><span class="novel-arch-arc-label novel-arch-arc-end">终点</span>${esc(a.end || '')}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${themeTracks.length ? `<div class="novel-arch-section">
        <div class="novel-arch-section-head"><i class="fa-solid fa-bullseye"></i> 主题落点（${themeTracks.length}）</div>
        <div class="novel-arch-themes">
          ${themeTracks.map(t => `
            <div class="novel-arch-theme">
              <div class="novel-arch-theme-name">${esc(t.theme || '')}</div>
              ${t.act1_manifestation ? `<div><span class="novel-arch-act-label act1">第一幕</span>${esc(t.act1_manifestation)}</div>` : ''}
              ${t.act2_manifestation ? `<div><span class="novel-arch-act-label act2">第二幕</span>${esc(t.act2_manifestation)}</div>` : ''}
              ${t.act3_manifestation ? `<div><span class="novel-arch-act-label act3">第三幕</span>${esc(t.act3_manifestation)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${fores.length ? `<div class="novel-arch-section">
        <div class="novel-arch-section-head"><i class="fa-solid fa-seedling"></i> 伏笔种子（${fores.length}）</div>
        <div class="novel-arch-fores">
          ${fores.map(f => `
            <div class="novel-arch-fore">
              <span class="novel-arch-fore-id">${esc(f.id || 'F')}</span>
              <span class="novel-arch-fore-desc">${esc(f.description || '')}</span>
              <span class="novel-arch-fore-range">埋 ${f.planted_chapter_estimate || '?'} · 收 ${f.payoff_chapter_estimate || '?'}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}
      <div class="novel-arch-actions">
        <button class="btn btn-sm" id="novelArchBtnRegen"><i class="fa-solid fa-arrows-rotate"></i> 重新提取架构</button>
        ${arch.user_edited ? '<span class="novel-arch-edited">用户已编辑</span>' : ''}
      </div>
    </div>
  </div>`;
    }

    function _renderArtifacts(r) {
        if (!$tabArtifacts) return;
        const outline = r.outline;
        const chapters = (r.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no);
        const hasOutline = !!(outline && (outline.world_setting || outline.structure));

        if (!hasOutline) {
            $tabArtifacts.innerHTML = `
<div class="novel-artifacts-empty">
  <i class="fa-solid fa-landmark"></i>
  <h3>还没有成果</h3>
  <p>生成大纲后，这里会以卡片形式展示世界观、主冲突、人物、章节等结构化内容。</p>
  <button class="btn btn-primary" id="novelArtifactsBtnGen"><i class="fa-solid fa-wand-magic-sparkles"></i> 开始生成大纲</button>
</div>`;
            const btn = document.getElementById('novelArtifactsBtnGen');
            if (btn) btn.addEventListener('click', _generateOutline);
            return;
        }

        if (_st.artifactsMode === 'edit') {
            // 复用大纲表单到 artifacts pane（Phase 3: 成果 Tab 编辑模式）
            const html = `
<div class="novel-artifacts">
  <div class="novel-artifacts-toolbar">
    <button class="btn" id="novelArtifactsBtnView"><i class="fa-solid fa-eye"></i> 返回卡片视图</button>
  </div>
</div>`;
            $tabArtifacts.innerHTML = html;
            // 把表单直接渲染到 artifacts pane（避免污染 $tabOutline）
            const $wrap = $tabArtifacts.querySelector('.novel-artifacts');
            const $form = document.createElement('div');
            $wrap.appendChild($form);
            _renderOutlineForm($form, r);
            document.getElementById('novelArtifactsBtnView').addEventListener('click', () => {
                _st.artifactsMode = 'view';
                _renderDetail();
            });
            return;
        }

        // view 模式：卡片视图
        const chars = safeJson(outline.global_characters) || [];
        const themes = safeJson(outline.themes) || [];
        const chapList = safeJson(outline.chapter_list) || [];

        $tabArtifacts.innerHTML = `
<div class="novel-artifacts">
  <div class="novel-artifacts-toolbar">
    <button class="btn btn-primary" id="novelArtifactsBtnEdit"><i class="fa-solid fa-pen"></i> 编辑大纲</button>
    <button class="btn" id="novelArtifactsBtnRegen"><i class="fa-solid fa-arrows-rotate"></i> 重新生成</button>
  </div>

  <div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-solid fa-globe"></i> 世界观</div>
    <div class="novel-artifact-card-body novel-artifact-prose">${esc(outline.world_setting || '（空）').replace(/\n/g, '<br>')}</div>
  </div>

  <div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-solid fa-swords"></i> 主冲突</div>
    <div class="novel-artifact-card-body novel-artifact-prose">${esc(outline.main_conflict || '（空）').replace(/\n/g, '<br>')}</div>
  </div>

  <div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-solid fa-diagram-project"></i> 结构</div>
    <div class="novel-artifact-card-body novel-artifact-prose">${esc(outline.structure || '（空）').replace(/\n/g, '<br>')}</div>
  </div>

  ${themes.length ? `<div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-solid fa-tags"></i> 主题</div>
    <div class="novel-artifact-card-body"><div class="novel-artifact-chips">${themes.map(t => `<span class="novel-artifact-chip">${esc(t)}</span>`).join('')}</div></div>
  </div>` : ''}

  ${_renderArtifactsArchitecture(r.architecture)}

  ${chars.length ? `<div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-solid fa-users"></i> 主要人物（${chars.length}）</div>
    <div class="novel-artifact-card-body">
      <div class="novel-artifact-char-grid">
        ${chars.map((c, i) => `<details class="novel-artifact-char">
          <summary>
            <span class="novel-artifact-char-name">${esc(c.name || '未命名')}</span>
            <span class="novel-artifact-char-role">${esc(c.role || '')}</span>
          </summary>
          <div class="novel-artifact-char-body">
            ${c.archetype ? `<div><strong>原型：</strong>${esc(c.archetype)}</div>` : ''}
            ${c.motivation ? `<div><strong>动机：</strong>${esc(c.motivation)}</div>` : ''}
            ${c.psychology ? `<div><strong>心理：</strong>${esc(c.psychology)}</div>` : ''}
            ${c.arc ? `<div><strong>弧光：</strong>${esc(c.arc)}</div>` : ''}
            ${c.description ? `<div class="novel-artifact-char-desc">${esc(c.description)}</div>` : ''}
            ${!c.archetype && !c.motivation && !c.psychology && !c.arc && !c.description ? `<pre class="novel-artifact-char-json">${esc(JSON.stringify(c, null, 2))}</pre>` : ''}
          </div>
        </details>`).join('')}
      </div>
    </div>
  </div>` : ''}

  <div class="novel-artifact-card">
    <div class="novel-artifact-card-head"><i class="fa-regular fa-file-lines"></i> 章节列表（${chapters.length}）</div>
    <div class="novel-artifact-card-body">
      <div class="novel-artifact-chapter-grid">
        ${chapters.map(c => {
            const statusLabel = ({pending:'待写',outlining:'大纲',writing:'生成中',done:'完成'})[c.status] || c.status;
            const sum = (c.summary || '').slice(0, 80);
            return `<div class="novel-artifact-chapter" data-id="${esc(c.id)}">
              <div class="novel-artifact-chapter-head">
                <span class="novel-artifact-chapter-no">#${c.chapter_no}</span>
                <span class="novel-artifact-chapter-title">${esc(c.title || '(未命名)')}</span>
                <span class="novel-status-pill novel-status-${esc(c.status || 'pending')}">${esc(statusLabel)}</span>
              </div>
              <div class="novel-artifact-chapter-meta">${(c.actual_word_count || 0).toLocaleString()} 字</div>
              ${sum ? `<div class="novel-artifact-chapter-summary">${esc(sum)}${(c.summary || '').length > 80 ? '…' : ''}</div>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>
  </div>
</div>`;

        // 绑定 toolbar
        document.getElementById('novelArtifactsBtnEdit').addEventListener('click', () => {
            _st.artifactsMode = 'edit';
            _renderDetail();
        });
        document.getElementById('novelArtifactsBtnRegen').addEventListener('click', () => {
            if (confirm('确认重新生成大纲？现有大纲会被覆盖。')) _generateOutline();
        });
        // 章节卡点击 → 切到章节 Tab
        $tabArtifacts.querySelectorAll('.novel-artifact-chapter').forEach(el => {
            el.addEventListener('click', () => _switchTab('chapters'));
        });
        // Phase 4-A: 架构重提按钮
        const archBtn = document.getElementById('novelArchBtnRegen');
        if (archBtn) {
            archBtn.addEventListener('click', async () => {
                if (!confirm('基于现有大纲重新提取架构？架构会被覆盖。')) return;
                const res = await window.api.ainovel.regenerateArchitecture(_st.activeNovelId);
                if (res && res.ok) {
                    toast('架构重提任务已启动', 'success');
                    if (_st.activeTab !== 'workspace') _switchTab('workspace');
                } else {
                    toast((res && res.error) || '重提失败', 'error');
                }
            });
        }
    }

    // ============================================================
    // Phase 3: 知识库 Tab
    // ============================================================
    // 6 个 section：角色档案 / 设定 / 时间线 / 伏笔 / 现实校验 / 参考设定
    // Sprint M：异步加载 _ainovel_knowledge 表中已有的条目（角色/设定/时间线从 outline + chapters 直接展示）
    // Sprint N：4 个 agent 抽取后写入 knowledge 表，本函数读取并展示
    async function _renderKnowledge(r) {
        if (!$tabKnowledge) return;
        const outline = r.outline;
        const chapters = (r.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no);
        const chars = safeJson((outline && outline.global_characters) || '[]') || [];
        const hasOutline = !!(outline && (outline.world_setting || outline.structure));

        // 异步加载知识库数据（伏笔 / 现实校验 / 参考设定）
        let foreshadowings = [], verifications = [], references = [];
        try {
            const r1 = await window.api.ainovel.getKnowledge(_st.activeNovelId, 'foreshadowing');
            if (r1 && r1.ok) foreshadowings = r1.items || [];
            const r2 = await window.api.ainovel.getKnowledge(_st.activeNovelId, 'verification');
            if (r2 && r2.ok) verifications = r2.items || [];
            const r3 = await window.api.ainovel.getKnowledge(_st.activeNovelId, 'reference');
            if (r3 && r3.ok) references = r3.items || [];
        } catch (e) {
            console.warn('[novel] load knowledge items:', e.message);
        }

        $tabKnowledge.innerHTML = `
<div class="novel-knowledge">
  <div class="novel-knowledge-toolbar">
    <button class="btn btn-primary" id="novelKnowledgeBtnRefresh" title="调用 4 个 agent 抽取伏笔 / 现实校验 / 参考设定">
      <i class="fa-solid fa-arrows-rotate"></i> 刷新知识库
    </button>
    <button class="btn btn-sm" id="novelKnowledgeBtnExpand">展开全部</button>
    <button class="btn btn-sm" id="novelKnowledgeBtnCollapse">收起全部</button>
    <span class="novel-knowledge-stats" id="novelKnowledgeStats">
      伏笔 ${foreshadowings.length} · 校验 ${verifications.length} · 参考 ${references.length}
    </span>
  </div>

  <!-- Section 1: 角色档案 -->
  <details class="novel-knowledge-section" open>
    <summary><i class="fa-solid fa-users"></i> 角色档案（${chars.length}）</summary>
    <div class="novel-knowledge-body">
      ${chars.length ? chars.map(c => `<div class="novel-knowledge-char">
        <div class="novel-knowledge-char-name">${esc(c.name || '未命名')}</div>
        <div class="novel-knowledge-char-role">${esc(c.role || '')}</div>
        ${c.description ? `<div class="novel-knowledge-char-desc">${esc(c.description)}</div>` : ''}
      </div>`).join('') : '<div class="novel-knowledge-empty">暂无角色档案</div>'}
    </div>
  </details>

  <!-- Section 2: 设定 / 世界观 -->
  <details class="novel-knowledge-section">
    <summary><i class="fa-solid fa-globe"></i> 设定 / 世界观</summary>
    <div class="novel-knowledge-body">
      ${hasOutline && outline.world_setting
        ? `<div class="novel-knowledge-prose">${esc(outline.world_setting).replace(/\n/g, '<br>')}</div>`
        : '<div class="novel-knowledge-empty">暂无世界观</div>'}
    </div>
  </details>

  <!-- Section 3: 剧情时间线 -->
  <details class="novel-knowledge-section">
    <summary><i class="fa-solid fa-timeline"></i> 剧情时间线（${chapters.length} 章）</summary>
    <div class="novel-knowledge-body">
      ${chapters.length ? `<div class="novel-knowledge-timeline">
        ${chapters.map(c => `<div class="novel-knowledge-timeline-node ${c.status === 'done' ? 'done' : (c.status === 'writing' ? 'writing' : 'pending')}">
          <div class="novel-knowledge-timeline-dot"></div>
          <div class="novel-knowledge-timeline-content">
            <div class="novel-knowledge-timeline-no">第 ${c.chapter_no} 章</div>
            <div class="novel-knowledge-timeline-title">${esc(c.title || '(未命名)')}</div>
            ${c.summary ? `<div class="novel-knowledge-timeline-summary">${esc((c.summary || '').slice(0, 60))}${(c.summary || '').length > 60 ? '…' : ''}</div>` : ''}
            <div class="novel-knowledge-timeline-status">${({pending:'待写',outlining:'大纲',writing:'生成中',done:'完成'})[c.status] || c.status}</div>
          </div>
        </div>`).join('')}
      </div>` : '<div class="novel-knowledge-empty">暂无章节时间线</div>'}
    </div>
  </details>

  <!-- Section 4: 伏笔追踪 -->
  <details class="novel-knowledge-section">
    <summary><i class="fa-solid fa-eye"></i> 伏笔追踪（${foreshadowings.length}）</summary>
    <div class="novel-knowledge-body" id="novelKnowledgeForeshadowingBody">
      ${_renderKnowledgeForeshadowingList(foreshadowings)}
    </div>
  </details>

  <!-- Section 5: 现实设定校验 -->
  <details class="novel-knowledge-section">
    <summary><i class="fa-solid fa-magnifying-glass"></i> 现实设定校验（${verifications.length}）</summary>
    <div class="novel-knowledge-body" id="novelKnowledgeVerificationBody">
      ${_renderKnowledgeVerificationList(verifications)}
    </div>
  </details>

  <!-- Section 6: 参考设定类型 -->
  <details class="novel-knowledge-section">
    <summary><i class="fa-solid fa-bookmark"></i> 参考设定类型（${references.length}）</summary>
    <div class="novel-knowledge-body" id="novelKnowledgeReferenceBody">
      ${_renderKnowledgeReferenceList(references)}
    </div>
  </details>
</div>`;

        // 工具栏
        document.getElementById('novelKnowledgeBtnRefresh').addEventListener('click', _refreshKnowledge);
        document.getElementById('novelKnowledgeBtnExpand').addEventListener('click', () => {
            $tabKnowledge.querySelectorAll('.novel-knowledge-section').forEach(s => s.open = true);
        });
        document.getElementById('novelKnowledgeBtnCollapse').addEventListener('click', () => {
            $tabKnowledge.querySelectorAll('.novel-knowledge-section').forEach(s => s.open = false);
        });
        // 单条 resolve / delete 按钮
        _wireKnowledgeItemActions();
    }

    // 伏笔列表渲染
    function _renderKnowledgeForeshadowingList(items) {
        if (!items.length) {
            return `<div class="novel-knowledge-empty"><i class="fa-regular fa-eye"></i><p>暂无伏笔。点击「刷新知识库」调用 extract-foreshadowings agent 抽取。</p></div>`;
        }
        return `<div class="novel-knowledge-foreshadowings">${items.map(f => {
            const planted = f.meta && f.meta.plantedInChapter ? `埋设：第 ${f.meta.plantedInChapter} 章` : '';
            const payoff = f.meta && f.meta.expectedPayoff ? `预期：${esc(f.meta.expectedPayoff)}` : '';
            const conf = f.meta && f.meta.confidence ? `<span class="novel-knowledge-confidence novel-knowledge-conf-${esc(f.meta.confidence)}">${esc(f.meta.confidence)}</span>` : '';
            return `<div class="novel-knowledge-foreshadowing ${f.resolved ? 'resolved' : ''}" data-id="${esc(f.id)}">
                <div class="novel-knowledge-foreshadowing-head">
                    <span class="novel-knowledge-foreshadowing-title">${esc(f.title || '伏笔')}</span>
                    ${conf}
                    <span class="novel-knowledge-foreshadowing-status">${f.resolved ? '✓ 已回收' : '○ 未回收'}</span>
                </div>
                ${f.detail ? `<div class="novel-knowledge-foreshadowing-detail">${esc(f.detail)}</div>` : ''}
                <div class="novel-knowledge-foreshadowing-meta">
                    ${planted ? `<span>${esc(planted)}</span>` : ''}
                    ${payoff ? `<span>${payoff}</span>` : ''}
                </div>
                <div class="novel-knowledge-foreshadowing-actions">
                    <button class="btn btn-sm" data-act="toggle-resolved"><i class="fa-solid fa-${f.resolved ? 'undo' : 'check'}"></i> ${f.resolved ? '标未回收' : '标已回收'}</button>
                    <button class="btn btn-sm novel-danger-btn" data-act="delete"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    // 现实校验列表渲染
    function _renderKnowledgeVerificationList(items) {
        if (!items.length) {
            return `<div class="novel-knowledge-empty"><i class="fa-regular fa-magnifying-glass"></i><p>暂无校验结果。点击「刷新知识库」调用 reality-check agent + 网络搜索。</p></div>`;
        }
        return `<div class="novel-knowledge-verifications">${items.map(v => {
            const verdict = v.meta && v.meta.verdict ? v.meta.verdict : 'uncertain';
            const verdictLabel = { confirmed: '✓ 已确认', conflicted: '✗ 冲突', uncertain: '? 待定' }[verdict] || verdict;
            const sources = v.meta && Array.isArray(v.meta.sources) ? v.meta.sources : [];
            return `<div class="novel-knowledge-verification" data-id="${esc(v.id)}">
                <div class="novel-knowledge-verification-head">
                    <span class="novel-knowledge-verification-title">${esc(v.title || '事实主张')}</span>
                    <span class="novel-knowledge-verdict novel-knowledge-verdict-${esc(verdict)}">${esc(verdictLabel)}</span>
                </div>
                ${v.detail ? `<div class="novel-knowledge-verification-statement">${esc(v.detail)}</div>` : ''}
                ${v.meta && v.meta.searchResult ? `<div class="novel-knowledge-verification-result"><strong>搜索摘要：</strong>${esc(v.meta.searchResult)}</div>` : ''}
                ${sources.length ? `<div class="novel-knowledge-verification-sources">${sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="novel-knowledge-source">${esc(s.title || s.url)}</a>`).join(' · ')}</div>` : ''}
                <div class="novel-knowledge-verification-actions">
                    <button class="btn btn-sm novel-danger-btn" data-act="delete"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    // 参考设定列表渲染
    function _renderKnowledgeReferenceList(items) {
        if (!items.length) {
            return `<div class="novel-knowledge-empty"><i class="fa-regular fa-bookmark"></i><p>暂无参考设定。点击「刷新知识库」调用 extract-references agent 抽取。</p></div>`;
        }
        return `<div class="novel-knowledge-references">${items.map(r => {
            const elements = r.meta && Array.isArray(r.meta.elements) ? r.meta.elements : [];
            return `<div class="novel-knowledge-reference" data-id="${esc(r.id)}">
                <div class="novel-knowledge-reference-head">
                    <span class="novel-knowledge-reference-genre">${esc(r.title || '类型')}</span>
                </div>
                ${elements.length ? `<div class="novel-knowledge-reference-chips">${elements.map(e => `<span class="novel-artifact-chip">${esc(e)}</span>`).join('')}</div>` : ''}
                ${r.detail ? `<div class="novel-knowledge-reference-note">${esc(r.detail)}</div>` : ''}
                <div class="novel-knowledge-reference-actions">
                    <button class="btn btn-sm novel-danger-btn" data-act="delete"><i class="fa-solid fa-trash"></i> 删除</button>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    // 单条 item 操作（resolve / delete）
    function _wireKnowledgeItemActions() {
        if (!$tabKnowledge) return;
        $tabKnowledge.querySelectorAll('[data-act="toggle-resolved"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const $item = btn.closest('[data-id]');
                if (!$item) return;
                const id = $item.dataset.id;
                const wasResolved = $item.classList.contains('resolved');
                try {
                    const r = await window.api.ainovel.updateKnowledge(id, { resolved: !wasResolved });
                    if (!r || !r.ok) {
                        toast(r && r.error || '更新失败', 'error');
                        return;
                    }
                    _renderKnowledgeForActiveNovel();
                } catch (e) {
                    toast('更新失败：' + e.message, 'error');
                }
            });
        });
        $tabKnowledge.querySelectorAll('[data-act="delete"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const $item = btn.closest('[data-id]');
                if (!$item) return;
                const id = $item.dataset.id;
                if (!confirm('确认删除此条目？')) return;
                try {
                    const r = await window.api.ainovel.deleteKnowledge(id);
                    if (!r || !r.ok) {
                        toast(r && r.error || '删除失败', 'error');
                        return;
                    }
                    _renderKnowledgeForActiveNovel();
                } catch (e) {
                    toast('删除失败：' + e.message, 'error');
                }
            });
        });
    }

    // 重新拉取数据并刷新知识库 Tab
    async function _renderKnowledgeForActiveNovel() {
        try {
            const r = await window.api.ainovel.get(_st.activeNovelId);
            if (r && r.ok) await _renderKnowledge(r);
        } catch (e) {
            toast('刷新失败：' + e.message, 'error');
        }
    }

    // 刷新知识库（触发后台 agent 抽取）
    async function _refreshKnowledge() {
        if (!_st.activeNovelId) return;
        const $btn = document.getElementById('novelKnowledgeBtnRefresh');
        if ($btn) {
            $btn.disabled = true;
            $btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 抽取中…';
        }
        try {
            const r = await window.api.ainovel.extractKnowledge(_st.activeNovelId, ['foreshadowing', 'verification', 'reference']);
            if (!r || !r.ok) {
                toast(r && r.error || '触发抽取失败', 'error');
                if ($btn) {
                    $btn.disabled = false;
                    $btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 刷新知识库';
                }
                return;
            }
            toast('知识库抽取任务已提交（Sprint N 后真实运行）', 'info');
        } catch (e) {
            toast('触发失败：' + e.message, 'error');
        } finally {
            // Sprint N 后改成监听 knowledge_extracted 事件再恢复按钮
            setTimeout(() => {
                if ($btn) {
                    $btn.disabled = false;
                    $btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 刷新知识库';
                }
            }, 3000);
        }
    }

    function _renderOutline(r) {
        const outline = r.outline;
        if (!outline) {
            $tabOutline.innerHTML = `
                <div class="novel-outline-empty">
                    <i class="fa-solid fa-diagram-project"></i>
                    <p>还没有大纲。点击下方按钮生成</p>
                    <button class="btn btn-primary" id="novelBtnGenOutline">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 生成大纲
                    </button>
                </div>`;
            const btn = document.getElementById('novelBtnGenOutline');
            if (btn) btn.addEventListener('click', _generateOutline);
            return;
        }
        _renderOutlineForm($tabOutline, r);
    }

    // 把大纲表单渲染到任意 pane（Phase 3: 成果 tab edit 模式复用）
    function _renderOutlineForm($pane, r) {
        if (!$pane) return;
        const outline = r.outline;
        const chapters = safeJson(outline.chapter_list) || [];
        const chars = safeJson(outline.global_characters) || [];
        const themes = safeJson(outline.themes) || [];
        $pane.innerHTML = `
            <div class="novel-outline-grid">
                <div class="novel-field">
                    <label>结构</label>
                    <textarea data-field="structure" rows="2">${esc(outline.structure || '')}</textarea>
                </div>
                <div class="novel-field">
                    <label>主题</label>
                    <textarea data-field="themes" rows="2">${esc(Array.isArray(themes) ? themes.join('、') : themes || '')}</textarea>
                </div>
                <div class="novel-field">
                    <label>主冲突</label>
                    <textarea data-field="main_conflict" rows="2">${esc(outline.main_conflict || '')}</textarea>
                </div>
                <div class="novel-field">
                    <label>世界观</label>
                    <textarea data-field="world_setting" rows="4">${esc(outline.world_setting || '')}</textarea>
                </div>
                <div class="novel-field novel-field-wide">
                    <label>主要人物（JSON 数组，可编辑）</label>
                    <textarea data-field="global_characters" rows="6">${esc(JSON.stringify(chars, null, 2))}</textarea>
                </div>
                <div class="novel-field novel-field-wide">
                    <label>章节列表（JSON 数组，可编辑）</label>
                    <textarea data-field="chapter_list" rows="10">${esc(JSON.stringify(chapters, null, 2))}</textarea>
                </div>
            </div>
            <div class="novel-outline-actions">
                <button class="btn" id="novelBtnSaveOutline"><i class="fa-solid fa-check"></i> 保存大纲</button>
                <button class="btn" id="novelBtnRegenOutline"><i class="fa-solid fa-arrows-rotate"></i> 重新生成</button>
            </div>`;
        const saveBtn = $pane.querySelector('#novelBtnSaveOutline');
        const regenBtn = $pane.querySelector('#novelBtnRegenOutline');
        if (saveBtn) saveBtn.addEventListener('click', _saveOutline);
        if (regenBtn) regenBtn.addEventListener('click', _generateOutline);
    }

    function _renderChapters(r) {
        const chapters = (r.chapters || []).slice().sort((a, b) => a.chapter_no - b.chapter_no);
        _stream._lastChapters = chapters; // 缓存：流式视图里用 chapterId 找 chapter_no
        if (!chapters.length) {
            $tabChapters.innerHTML = '<div class="novel-outline-empty"><i class="fa-regular fa-file-lines"></i><p>暂无章节</p></div>';
            return;
        }
        const pendingCount = chapters.filter(c => c.status === 'pending').length;
        const hasPending = pendingCount > 0;
        $tabChapters.innerHTML = `
            <div class="novel-auto-bar" id="novelAutoBar">
                <label class="novel-auto-toggle">
                    <input type="checkbox" id="novelAutoToggle" ${_auto.active ? 'checked' : ''} ${hasPending ? '' : 'disabled'}>
                    <span>自动写作</span>
                </label>
                <div class="novel-auto-progress" id="novelAutoProgress" ${_auto.active ? '' : 'hidden'}>
                    <span id="novelAutoProgressLabel">${_auto.active ? `第 ${_auto.currentChapterNo} 章` : ''}</span>
                    <progress id="novelAutoProgressBar" value="${_auto.completedChapters || 0}" max="${_auto.totalChapters || 1}"></progress>
                    <span id="novelAutoProgressCount">${_auto.completedChapters || 0} / ${_auto.totalChapters || 0}</span>
                    <button id="novelAutoBtn" class="btn btn-sm"><i class="fa-solid fa-pause"></i> ${_auto.paused ? '继续' : '暂停'}</button>
                    <button id="novelAutoCancelBtn" class="btn btn-sm novel-danger-btn"><i class="fa-solid fa-stop"></i> 取消</button>
                </div>
                <span class="novel-auto-status" id="novelAutoStatus">${hasPending ? `共 ${chapters.length} 章 / 待写 ${pendingCount}` : '所有章节已完成'}</span>
            </div>
            <table class="novel-chapter-table">
                <thead>
                    <tr>
                        <th style="width:60px;">#</th>
                        <th>标题</th>
                        <th style="width:100px;">状态</th>
                        <th style="width:120px;">字数</th>
                        <th style="width:200px;">操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${chapters.map(ch => {
                        const statusLabel = ({pending:'待写', outlining:'大纲', writing:'生成中', done:'完成'})[ch.status] || ch.status;
                        return `<tr data-id="${esc(ch.id)}">
                            <td>${ch.chapter_no}</td>
                            <td>${esc(ch.title || '(未命名)')}</td>
                            <td><span class="novel-status-pill novel-status-${esc(ch.status || 'pending')}">${esc(statusLabel)}</span></td>
                            <td>${(ch.actual_word_count || 0).toLocaleString()}</td>
                            <td class="novel-chapter-actions">
                                <button class="btn btn-sm" data-act="gen" ${ch.status === 'writing' ? 'disabled' : ''}>
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> 生成
                                </button>
                                <button class="btn btn-sm" data-act="view" ${ch.status !== 'done' ? 'disabled' : ''}>
                                    <i class="fa-regular fa-eye"></i> 查看
                                </button>
                                <button class="btn btn-sm" data-act="edit" ${ch.status !== 'done' ? 'disabled' : ''}>
                                    <i class="fa-solid fa-pen"></i> 编辑
                                </button>
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>`;
        $tabChapters.querySelectorAll('button[data-act]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tr = btn.closest('tr');
                const chapterId = tr.dataset.id;
                const act = btn.dataset.act;
                if (act === 'gen') _generateChapter(chapterId);
                else if (act === 'view') _viewChapter(chapterId, false);
                else if (act === 'edit') _viewChapter(chapterId, true);
            });
        });
        // 自动模式控件
        _wireAutoBar();
    }

    async function _renderLog(r) {
        try {
            const lr = await window.api.ainovel.listGenerations(_st.activeNovelId);
            const list = (lr && lr.ok && Array.isArray(lr.generations)) ? lr.generations : [];
            if (!list.length) {
                $tabLog.innerHTML = '<div class="novel-outline-empty"><i class="fa-regular fa-receipt"></i><p>暂无生成记录</p></div>';
                return;
            }
            $tabLog.innerHTML = `
                <div class="novel-log-hint"><i class="fa-solid fa-circle-info"></i> 点击任意行查看完整输入输出</div>
                <table class="novel-log-table">
                    <thead>
                        <tr>
                            <th style="width:155px;">时间</th>
                            <th style="width:130px;">中文名</th>
                            <th>Skill / Agent</th>
                            <th>Provider / 模型</th>
                            <th style="width:110px;">Tokens (in/out)</th>
                            <th style="width:70px;">耗时</th>
                            <th style="width:80px;">费用</th>
                            <th style="width:60px;">状态</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${list.map(g => {
                            const ts = g.created_at ? new Date(g.created_at * 1000).toLocaleString() : '—';
                            const tokens = `${g.prompt_tokens || 0} / ${g.completion_tokens || 0}`;
                            const cost = g.cost_usd != null ? '$' + Number(g.cost_usd).toFixed(4) : '—';
                            const dur = g.duration_ms != null ? Math.round(g.duration_ms / 100) / 10 + 's' : '—';
                            const statusLabel = g.status === 'ok' ? '✓' : '✗';
                            const displayName = g.display_name || g.skill || '—';
                            // Phase 2 元数据：phase / agent_name / round
                            const meta = [];
                            if (g.phase) meta.push(esc(g.phase));
                            if (g.agent_name && g.agent_name !== g.skill) meta.push(`<span class="novel-log-agent">${esc(g.agent_name)}</span>`);
                            if (g.round && g.round > 1) meta.push(`<span class="novel-log-round">R${g.round}</span>`);
                            const metaHtml = meta.length ? `<div class="novel-log-meta-inline">${meta.join(' · ')}</div>` : '';
                            return `<tr class="novel-log-row novel-log-row-${esc(g.status || 'ok')}" data-id="${esc(g.id)}" title="点击查看完整输入输出">
                                <td>${esc(ts)}</td>
                                <td><span class="novel-log-display-name">${esc(displayName)}</span></td>
                                <td>
                                    <div class="novel-log-skill">${esc(g.skill || '')}</div>
                                    ${metaHtml}
                                </td>
                                <td>${esc(g.provider || '')} / ${esc(g.model || '')}</td>
                                <td>${tokens}</td>
                                <td>${dur}</td>
                                <td>${cost}</td>
                                <td class="novel-log-status-cell">${statusLabel}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>`;
            // 行点击 → 打开详情
            $tabLog.querySelectorAll('tr.novel-log-row').forEach(tr => {
                tr.addEventListener('click', () => {
                    const id = tr.dataset.id;
                    if (id) _openLogDetail(id);
                });
            });
        } catch (e) {
            $tabLog.innerHTML = '<div class="novel-outline-empty">加载日志失败：' + esc(e.message) + '</div>';
        }
    }

    // ============================================================
    // Sprint H: 调度器 Tab（黑板 / 任务图 / 收件箱 / 编剧）
    // ============================================================
    const _sched = { section: 'blackboard', inboxAgent: '', agents: [] };

    async function _renderScheduler(r) {
        if (!$tabScheduler) return;
        const novelId = _st.activeNovelId;
        if (!novelId) return;
        const api = window.api.ainovel;

        // 调度模式（director / pipeline）
        let mode = 'pipeline';
        try { const mr = await api.getDirectorMode(); if (mr && mr.mode) mode = mr.mode; } catch (e) { /* 默认 pipeline */ }

        // 全自动连写开关
        const autoChain = await _loadAutoChainPref();
        const oversight = await _loadOversightPref();

        $tabScheduler.innerHTML = `
            <div class="novel-sched-bar">
                <div class="novel-sched-mode">
                    <span class="novel-sched-mode-label">调度模式</span>
                    <label class="novel-sched-radio">
                        <input type="radio" name="novelSchedMode" value="pipeline" ${mode === 'pipeline' ? 'checked' : ''}>
                        <span>固定流水线</span>
                    </label>
                    <label class="novel-sched-radio">
                        <input type="radio" name="novelSchedMode" value="director" ${mode === 'director' ? 'checked' : ''}>
                        <span>编剧自主调度（LLM）</span>
                    </label>
                    <span class="novel-sched-mode-hint">${mode === 'director'
                        ? '由 novel-director 决定调用哪些 agent；失败自动回退流水线'
                        : '按固定 Phase 顺序跑 18 个 agent（稳定，兼容旧行为）'}</span>
                    <label class="novel-sched-radio" style="margin-left:18px;">
                        <input type="checkbox" id="novelSchedAutoChain" ${autoChain ? 'checked' : ''}>
                        <span>大纲后自动连写章节</span>
                    </label>
                    <label class="novel-sched-radio" style="margin-left:8px;">
                        <input type="checkbox" id="novelSchedOversight" ${oversight ? 'checked' : ''}>
                        <span>每章后让编剧监督决策</span>
                    </label>
                </div>
                <button class="btn btn-sm" type="button" data-sched-act="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
            </div>
            <div class="novel-sched-subnav">
                <button class="novel-sched-subtab ${_sched.section === 'blackboard' ? 'active' : ''}" type="button" data-sched-tab="blackboard"><i class="fa-solid fa-chalkboard"></i> 黑板</button>
                <button class="novel-sched-subtab ${_sched.section === 'tasks' ? 'active' : ''}" type="button" data-sched-tab="tasks"><i class="fa-solid fa-list-check"></i> 任务图</button>
                <button class="novel-sched-subtab ${_sched.section === 'inbox' ? 'active' : ''}" type="button" data-sched-tab="inbox"><i class="fa-solid fa-inbox"></i> 收件箱</button>
                <button class="novel-sched-subtab ${_sched.section === 'director' ? 'active' : ''}" type="button" data-sched-tab="director"><i class="fa-solid fa-clapperboard"></i> 编剧</button>
            </div>
            <div id="novelSchedBody" class="novel-sched-body"><div class="novel-config-hint-loading">加载中…</div></div>`;

        // 模式切换
        $tabScheduler.querySelectorAll('input[name="novelSchedMode"]').forEach(el => {
            el.addEventListener('change', async () => {
                if (!el.checked) return;
                try {
                    const sr = await api.setDirectorMode(el.value);
                    if (sr && sr.ok) { toast('调度模式已切换为：' + (el.value === 'director' ? '编剧自主调度' : '固定流水线'), 'success'); _renderScheduler(r); }
                    else toast((sr && sr.error) || '切换失败', 'error');
                } catch (e) { toast('切换失败：' + e.message, 'error'); }
            });
        });
        $tabScheduler.querySelectorAll('[data-sched-tab]').forEach(btn => {
            btn.addEventListener('click', () => { _sched.section = btn.dataset.schedTab; _renderScheduler(r); });
        });
        const $autoChain = document.getElementById('novelSchedAutoChain');
        if ($autoChain) $autoChain.addEventListener('change', async () => {
            await _setAutoChainPref($autoChain.checked);
            toast($autoChain.checked ? '已开启：大纲生成后将自动开始连写章节' : '已关闭：大纲生成后需手动点「开始自动写作」', 'success');
        });
        const $oversight = document.getElementById('novelSchedOversight');
        if ($oversight) $oversight.addEventListener('change', async () => {
            await _setOversightPref($oversight.checked);
            toast($oversight.checked ? '已开启：每章完成后编剧 LLM 会决定下一步' : '已关闭：自动连写不询问编剧', 'success');
        });
        const $refresh = $tabScheduler.querySelector('[data-sched-act="refresh"]');
        if ($refresh) $refresh.addEventListener('click', () => _renderScheduler(r));

        const $body = document.getElementById('novelSchedBody');
        if (!$body) return;
        try {
            if (_sched.section === 'blackboard') await _renderSchedBlackboard($body, novelId);
            else if (_sched.section === 'tasks') await _renderSchedTasks($body, novelId);
            else if (_sched.section === 'inbox') await _renderSchedInbox($body, novelId);
            else await _renderSchedDirector($body, novelId);
        } catch (e) {
            $body.innerHTML = '<div class="novel-outline-empty">加载失败：' + esc(e.message) + '</div>';
        }
    }

    async function _renderSchedBlackboard($body, novelId) {
        const r = await window.api.ainovel.blackboardList(novelId);
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
        $body.innerHTML = `
            <div class="novel-sched-hint"><i class="fa-solid fa-circle-info"></i>
                黑板是所有 agent 共享的项目级状态。每条 key 的摘要会自动注入到每个 agent 的 system prompt。</div>
            <div class="novel-sched-addrow">
                <input type="text" id="novelBbKey" class="novel-sched-input" placeholder="key（如 outline / protagonist_state）">
                <input type="text" id="novelBbValue" class="novel-sched-input novel-sched-input-wide" placeholder="value">
                <button class="btn btn-sm btn-primary" type="button" data-bb-act="write"><i class="fa-solid fa-plus"></i> 写入</button>
            </div>
            ${items.length ? `<table class="novel-log-table">
                <thead><tr><th style="width:180px;">Key</th><th>Value</th><th style="width:110px;">Owner</th><th style="width:60px;">v</th><th style="width:150px;">更新时间</th><th style="width:50px;"></th></tr></thead>
                <tbody>${items.map(it => `<tr>
                    <td><code>${esc(it.key)}</code></td>
                    <td class="novel-sched-val">${esc(String(it.value || '').slice(0, 300))}</td>
                    <td>${esc(it.owner || '—')}</td>
                    <td>${it.version || 1}</td>
                    <td>${it.updated_at ? esc(new Date(it.updated_at * 1000).toLocaleString()) : '—'}</td>
                    <td><button class="btn btn-sm" type="button" data-bb-del="${esc(it.key)}" title="删除"><i class="fa-solid fa-trash"></i></button></td>
                </tr>`).join('')}</tbody>
            </table>` : '<div class="novel-outline-empty"><i class="fa-regular fa-chalkboard"></i><p>黑板为空</p></div>'}`;

        const $w = $body.querySelector('[data-bb-act="write"]');
        if ($w) $w.addEventListener('click', async () => {
            const k = (document.getElementById('novelBbKey').value || '').trim();
            const v = document.getElementById('novelBbValue').value || '';
            if (!k) { toast('key 不能为空', 'warn'); return; }
            const wr = await window.api.ainovel.blackboardWrite(novelId, k, v, 'user');
            if (wr && wr.ok) { toast('已写入黑板', 'success'); _renderSchedBlackboard($body, novelId); }
            else toast((wr && wr.error) || '写入失败', 'error');
        });
        $body.querySelectorAll('[data-bb-del]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const key = btn.dataset.bbDel;
                if (!confirm(`删除黑板条目「${key}」？`)) return;
                const dr = await window.api.ainovel.blackboardClear(novelId, key);
                if (dr && dr.ok) { toast('已删除', 'success'); _renderSchedBlackboard($body, novelId); }
                else toast((dr && dr.error) || '删除失败', 'error');
            });
        });
    }

    const _TASK_STATUS_LABEL = {
        pending: '待处理', in_progress: '进行中', completed: '已完成', failed: '失败', blocked: '被阻塞',
    };

    async function _renderSchedTasks($body, novelId) {
        const r = await window.api.ainovel.taskList(novelId);
        const tasks = (r && r.ok && Array.isArray(r.tasks)) ? r.tasks : [];
        $body.innerHTML = `
            <div class="novel-sched-hint"><i class="fa-solid fa-circle-info"></i>
                任务图带依赖：blockedBy 全部完成后任务才可被 agent claim。编剧模式下由 novel-director 自动创建。</div>
            <div class="novel-sched-addrow">
                <input type="text" id="novelTaskSubject" class="novel-sched-input novel-sched-input-wide" placeholder="任务标题">
                <input type="text" id="novelTaskOwner" class="novel-sched-input" placeholder="owner（agent 名，可空）">
                <button class="btn btn-sm btn-primary" type="button" data-task-act="create"><i class="fa-solid fa-plus"></i> 新建</button>
            </div>
            ${tasks.length ? `<table class="novel-log-table">
                <thead><tr><th style="width:110px;">ID</th><th>标题</th><th style="width:130px;">Owner</th><th style="width:90px;">状态</th><th style="width:130px;">依赖</th><th style="width:150px;">更新时间</th></tr></thead>
                <tbody>${tasks.map(t => `<tr class="novel-sched-task-${esc(t.status || 'pending')}">
                    <td><code>${esc(String(t.id).slice(0, 10))}</code></td>
                    <td>${esc(t.subject || '')}${t.description ? `<div class="novel-log-meta-inline">${esc(String(t.description).slice(0, 120))}</div>` : ''}</td>
                    <td>${esc(t.owner || '—')}</td>
                    <td><span class="novel-sched-pill novel-sched-pill-${esc(t.status || 'pending')}">${esc(_TASK_STATUS_LABEL[t.status] || t.status || '')}</span></td>
                    <td>${(t.blockedBy && t.blockedBy.length) ? esc(t.blockedBy.map(x => String(x).slice(0, 6)).join(', ')) : '—'}</td>
                    <td>${t.updated_at ? esc(new Date(t.updated_at * 1000).toLocaleString()) : '—'}</td>
                </tr>`).join('')}</tbody>
            </table>` : '<div class="novel-outline-empty"><i class="fa-regular fa-rectangle-list"></i><p>暂无任务</p></div>'}`;

        const $c = $body.querySelector('[data-task-act="create"]');
        if ($c) $c.addEventListener('click', async () => {
            const subject = (document.getElementById('novelTaskSubject').value || '').trim();
            const owner = (document.getElementById('novelTaskOwner').value || '').trim();
            if (!subject) { toast('任务标题不能为空', 'warn'); return; }
            const cr = await window.api.ainovel.taskCreate(novelId, { subject, owner: owner || null });
            if (cr && cr.ok) { toast('任务已创建', 'success'); _renderSchedTasks($body, novelId); }
            else toast((cr && cr.error) || '创建失败', 'error');
        });
    }

    async function _renderSchedInbox($body, novelId) {
        // agent 列表（缓存）
        if (!_sched.agents.length) {
            try {
                const sr = await window.api.ainovel.listSkills();
                _sched.agents = (sr && sr.ok && Array.isArray(sr.skills)) ? sr.skills : [];
            } catch (e) { _sched.agents = []; }
        }
        if (!_sched.inboxAgent && _sched.agents.length) _sched.inboxAgent = _sched.agents[0].name;
        const agent = _sched.inboxAgent;
        let msgs = [];
        if (agent) {
            const r = await window.api.ainovel.inboxList(novelId, agent);
            msgs = (r && r.ok && Array.isArray(r.messages)) ? r.messages : [];
        }
        $body.innerHTML = `
            <div class="novel-sched-hint"><i class="fa-solid fa-circle-info"></i>
                收件箱是 agent 之间的定向消息通道。未读消息会在该 agent 下次执行时自动注入 system prompt。</div>
            <div class="novel-sched-addrow">
                <select id="novelInboxAgent" class="novel-sched-input">
                    ${_sched.agents.map(a => `<option value="${esc(a.name)}" ${a.name === agent ? 'selected' : ''}>${esc(a.displayName || a.name)}（${esc(a.name)}）</option>`).join('')}
                </select>
                <input type="text" id="novelInboxText" class="novel-sched-input novel-sched-input-wide" placeholder="给该 agent 留言（下次执行时注入）">
                <button class="btn btn-sm btn-primary" type="button" data-inbox-act="send"><i class="fa-solid fa-paper-plane"></i> 发送</button>
                <button class="btn btn-sm" type="button" data-inbox-act="markread"><i class="fa-solid fa-check-double"></i> 全部已读</button>
            </div>
            ${msgs.length ? `<table class="novel-log-table">
                <thead><tr><th style="width:150px;">时间</th><th style="width:130px;">来自</th><th style="width:80px;">类型</th><th>内容</th><th style="width:60px;">已读</th></tr></thead>
                <tbody>${msgs.map(m => `<tr class="${m.read ? '' : 'novel-sched-unread'}">
                    <td>${m.ts ? esc(new Date(m.ts * 1000).toLocaleString()) : '—'}</td>
                    <td>${esc(m.from || '—')}</td>
                    <td>${esc(m.kind || 'note')}</td>
                    <td>${esc(String(m.text || '').slice(0, 400))}</td>
                    <td>${m.read ? '✓' : '<span class="novel-sched-dot"></span>'}</td>
                </tr>`).join('')}</tbody>
            </table>` : '<div class="novel-outline-empty"><i class="fa-regular fa-envelope"></i><p>该 agent 暂无消息</p></div>'}`;

        const $sel = document.getElementById('novelInboxAgent');
        if ($sel) $sel.addEventListener('change', () => { _sched.inboxAgent = $sel.value; _renderSchedInbox($body, novelId); });
        const $send = $body.querySelector('[data-inbox-act="send"]');
        if ($send) $send.addEventListener('click', async () => {
            const text = (document.getElementById('novelInboxText').value || '').trim();
            if (!text) { toast('消息内容不能为空', 'warn'); return; }
            const sr = await window.api.ainovel.inboxSend(novelId, { to: _sched.inboxAgent, from: 'user', text, kind: 'user-note' });
            if (sr && sr.ok) { toast('已投递', 'success'); _renderSchedInbox($body, novelId); }
            else toast((sr && sr.error) || '投递失败', 'error');
        });
        const $mr = $body.querySelector('[data-inbox-act="markread"]');
        if ($mr) $mr.addEventListener('click', async () => {
            const rr = await window.api.ainovel.inboxMarkRead(novelId, _sched.inboxAgent, null);
            if (rr && rr.ok) { toast('已全部标记为已读', 'success'); _renderSchedInbox($body, novelId); }
            else toast((rr && rr.error) || '操作失败', 'error');
        });
    }

    async function _renderSchedDirector($body, novelId) {
        const ovLog = _oversightLog.get(novelId) || [];
        $body.innerHTML = `
            <div class="novel-sched-hint"><i class="fa-solid fa-circle-info"></i>
                直接给编剧（novel-director）下一个高层目标，由它自己决定调用哪些 agent、怎么拆任务。</div>
            <div class="novel-sched-director">
                <textarea id="novelDirectorGoal" class="novel-sched-textarea" rows="4"
                    placeholder="例如：重写第 3 章，强化女主的动机冲突，并把伏笔『铜钥匙』埋进去。"></textarea>
                <div class="novel-sched-addrow">
                    <button class="btn btn-primary" type="button" data-dir-act="run"><i class="fa-solid fa-play"></i> 交给编剧</button>
                    <span id="novelDirectorStatus" class="novel-sched-mode-hint"></span>
                </div>
                <div id="novelDirectorOut" class="novel-sched-director-out" hidden></div>
            </div>
            <div class="novel-sched-hint" style="margin-top:18px;"><i class="fa-solid fa-clapperboard"></i>
                <strong>编剧全程监督日志</strong>（自动连写开启 + 每章后监督开启时产生）</div>
            ${ovLog.length ? `<table class="novel-log-table">
                <thead><tr><th style="width:140px;">时间</th><th style="width:80px;">章节</th><th style="width:110px;">动作</th><th>理由 / 注入</th></tr></thead>
                <tbody>${ovLog.map(o => {
                    const actionLabel = { continue: '继续', pause: '暂停', rewrite_last: '重写', inject_note: '注入约束', abort: '中止' }[o.action] || o.action;
                    const tag = o.action;
                    return `<tr class="novel-sched-task-${tag === 'continue' ? 'completed' : tag === 'pause' ? 'paused' : tag === 'abort' ? 'failed' : 'in_progress'}">
                        <td>${esc(new Date(o.ts).toLocaleTimeString())}</td>
                        <td>第 ${esc(String(o.afterChapterNo || '?'))} 章后</td>
                        <td><span class="novel-sched-pill novel-sched-pill-${tag === 'continue' ? 'completed' : tag === 'pause' ? 'pending' : tag === 'abort' ? 'failed' : 'in_progress'}">${esc(actionLabel)}</span></td>
                        <td class="novel-sched-val">
                            ${o.reason ? `<div>${esc(o.reason)}</div>` : ''}
                            ${o.note ? `<div class="novel-log-meta-inline" style="margin-top:4px;">→ ${esc(o.note)}</div>` : ''}
                        </td>
                    </tr>`;
                }).join('')}</tbody>
            </table>` : '<div class="novel-outline-empty"><i class="fa-regular fa-clapperboard"></i><p>暂无监督决策记录。开启「每章后让编剧监督决策」并自动连写后会累积。</p></div>'}`;

        const $run = $body.querySelector('[data-dir-act="run"]');
        const $status = document.getElementById('novelDirectorStatus');
        const $out = document.getElementById('novelDirectorOut');
        if ($run) $run.addEventListener('click', async () => {
            const goal = (document.getElementById('novelDirectorGoal').value || '').trim();
            if (!goal) { toast('请先写清楚目标', 'warn'); return; }
            $run.disabled = true;
            if ($status) $status.textContent = '编剧调度中…（最多 8 轮）';
            if ($out) { $out.hidden = true; $out.innerHTML = ''; }
            try {
                const rr = await window.api.ainovel.runDirector(novelId, goal);
                if (rr && rr.ok) {
                    const o = rr.output || {};
                    const hist = Array.isArray(o.toolHistory) ? o.toolHistory : [];
                    if ($out) {
                        $out.hidden = false;
                        $out.innerHTML = `
                            <div class="novel-sched-director-summary"><strong>编剧总结：</strong>${esc(o.summary || '（无）')}</div>
                            ${hist.length ? `<table class="novel-log-table">
                                <thead><tr><th style="width:60px;">轮次</th><th>调用工具</th><th style="width:70px;">结果</th><th>错误</th></tr></thead>
                                <tbody>${hist.map(h => `<tr>
                                    <td>${h.turn != null ? h.turn + 1 : '—'}</td>
                                    <td><code>${esc(h.name || '')}</code></td>
                                    <td>${h.ok ? '✓' : '✗'}</td>
                                    <td>${esc(h.error || '')}</td>
                                </tr>`).join('')}</tbody>
                            </table>` : '<div class="novel-sched-mode-hint">编剧本轮没有调用任何工具。</div>'}`;
                    }
                    if ($status) $status.textContent = `完成，共调用 ${hist.length} 次工具`;
                    toast('编剧调度完成', 'success');
                } else {
                    if ($status) $status.textContent = '';
                    toast((rr && rr.error) || '调度失败', 'error');
                }
            } catch (e) {
                if ($status) $status.textContent = '';
                toast('调度失败：' + e.message, 'error');
            } finally {
                $run.disabled = false;
            }
        });
    }

    function _switchTab(tab) {
        const prevTab = _st.activeTab;
        _st.activeTab = tab;
        document.querySelectorAll('.novel-tab').forEach(b => {
            const active = b.dataset.tab === tab;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.novel-tab-pane').forEach(p => p.classList.remove('active'));
        // Phase 3: 5 个 tab pane 切换
        if (tab === 'workflow') {
            $tabWorkflow && $tabWorkflow.classList.add('active');
            // Sprint W 跨 tab 缓冲：从其他 tab 切回 workflow 时一次性 flush 累积的事件
            if (prevTab !== 'workflow') _wfFlushPending();
        }
        else if (tab === 'workspace') $tabWorkspace && $tabWorkspace.classList.add('active');
        else if (tab === 'artifacts') $tabArtifacts && $tabArtifacts.classList.add('active');
        else if (tab === 'knowledge') $tabKnowledge && $tabKnowledge.classList.add('active');
        else if (tab === 'chapters') $tabChapters && $tabChapters.classList.add('active');
        else if (tab === 'log') $tabLog && $tabLog.classList.add('active');
        else if (tab === 'scheduler') $tabScheduler && $tabScheduler.classList.add('active');
        else if (tab === 'outline') $tabOutline && $tabOutline.classList.add('active');
        _renderDetail();
    }

    // ===== Outline Actions =====
    async function _generateOutline() {
        if (!_st.activeNovelId) return;
        // Pipeline 模式优先；旧 _stream 作为 fallback
        if (_pipeline.active || _stream.active) {
            toast('已有生成任务进行中，请等待完成', 'warn');
            return;
        }
        if (!_startPipeline('outline', _st.activeNovelId, null)) return;
        try {
            const r = await window.api.ainovel.generateOutline(_st.activeNovelId);
            if (!r || !r.ok) {
                _endPipeline(false, r && r.error || '生成失败');
                return;
            }
        } catch (e) {
            _endPipeline(false, '生成失败：' + e.message);
        }
    }

    async function _saveOutline() {
        // Phase 3: 查找当前活跃的大纲表单 pane（可能是 $tabOutline 或 $tabArtifacts）
        let $formPane = $tabOutline;
        if ($tabArtifacts && _st.activeTab === 'artifacts' && _st.artifactsMode === 'edit') {
            $formPane = $tabArtifacts;
        }
        if (!$formPane) return;
        const fields = {};
        $formPane.querySelectorAll('[data-field]').forEach(el => {
            const key = el.dataset.field;
            let val = el.value.trim();
            if (key === 'global_characters' || key === 'chapter_list' || key === 'themes') {
                try { val = JSON.parse(val); }
                catch { toast(`${key} 不是合法 JSON，未保存`, 'error'); return; }
            }
            fields[key] = val;
        });
        try {
            const r = await window.api.ainovel.updateOutline(_st.activeNovelId, fields);
            if (!r || !r.ok) {
                toast(r && r.error || '保存失败', 'error');
                return;
            }
            toast('大纲已保存', 'success');
            // Phase 3: 保存成功后切回成果卡片视图
            if (_st.activeTab === 'artifacts' && _st.artifactsMode === 'edit') {
                _st.artifactsMode = 'view';
                _renderDetail();
            }
        } catch (e) {
            toast('保存失败：' + e.message, 'error');
        }
    }

    // ===== Chapter Actions =====
    async function _generateChapter(chapterId) {
        if (!_st.activeNovelId) return;
        if (_pipeline.active || _stream.active) {
            toast('已有生成任务进行中，请等待完成', 'warn');
            return;
        }
        if (!_startPipeline('chapter', _st.activeNovelId, chapterId)) return;
        try {
            const r = await window.api.ainovel.writeChapter(_st.activeNovelId, chapterId);
            if (!r || !r.ok) {
                _endPipeline(false, r && r.error || '生成失败');
                return;
            }
            // 成功路径由 chapter_generated / pipeline_failed 事件驱动
        } catch (e) {
            _endPipeline(false, '生成失败：' + e.message);
        }
    }

    async function _viewChapter(chapterId, startEdit) {
        if (!_st.activeNovelId) return;
        try {
            const r = await window.api.ainovel.get(_st.activeNovelId);
            if (!r || !r.ok) return;
            const ch = (r.chapters || []).find(c => c.id === chapterId);
            if (!ch || !ch.content) {
                toast('章节暂无内容', 'warn');
                return;
            }
            $chapterContent.textContent = ch.content;
            $chapterTextarea.value = ch.content;
            _chapterEditingId = chapterId;
            document.getElementById('novelChapterModalTitle').innerHTML =
                `<i class="fa-regular fa-file-lines"></i> 第 ${ch.chapter_no} 章 ${esc(ch.title || '')}`;
            _enterChapterView();
            if (startEdit) _enterChapterEdit();
            $chapterModal.style.display = 'flex';
            $chapterModal.classList.add('active');
        } catch (e) {
            toast('加载失败：' + e.message, 'error');
        }
    }

    let _chapterEditingId = null;
    function _enterChapterView() {
        $chapterView.hidden = false;
        $chapterEdit.hidden = true;
        document.getElementById('novelChapterEditBtn').hidden = false;
        document.getElementById('novelChapterSaveBtn').hidden = true;
    }
    function _enterChapterEdit() {
        $chapterView.hidden = true;
        $chapterEdit.hidden = false;
        document.getElementById('novelChapterEditBtn').hidden = true;
        document.getElementById('novelChapterSaveBtn').hidden = false;
        $chapterTextarea.focus();
    }
    async function _saveChapterEdit() {
        if (!_chapterEditingId) return;
        try {
            const r = await window.api.ainovel.updateChapter(_st.activeNovelId, _chapterEditingId, {
                content: $chapterTextarea.value,
            });
            if (!r || !r.ok) {
                toast(r && r.error || '保存失败', 'error');
                return;
            }
            toast('已保存', 'success');
            _enterChapterView();
        } catch (e) {
            toast('保存失败：' + e.message, 'error');
        }
    }
    function _closeChapterModal() {
        $chapterModal.style.display = 'none';
        $chapterModal.classList.remove('active');
    }

    // ===== Log Detail Modal =====
    async function _openLogDetail(generationId) {
        if (!$logModal) return;
        // 先清空 + 显示加载态
        $logMeta.innerHTML = '<div class="novel-log-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> 加载中…</div>';
        if ($logRequest) $logRequest.textContent = '';
        if ($logResponse) $logResponse.textContent = '';
        if ($logErrorWrap) $logErrorWrap.hidden = true;
        $logModal.style.display = 'flex';
        $logModal.classList.add('active');

        try {
            const r = await window.api.ainovel.getGeneration(generationId);
            if (!r || !r.ok) {
                $logMeta.innerHTML = '<div class="novel-log-loading">加载失败：' + esc(r && r.error || '未知错误') + '</div>';
                return;
            }
            const g = r.generation;
            _renderLogDetail(g);
        } catch (e) {
            $logMeta.innerHTML = '<div class="novel-log-loading">加载失败：' + esc(e.message) + '</div>';
        }
    }

    function _renderLogDetail(g) {
        const ts = g.created_at ? new Date(g.created_at * 1000).toLocaleString() : '—';
        const dur = g.duration_ms != null ? (g.duration_ms / 1000).toFixed(1) + 's' : '—';
        const tokens = `${g.prompt_tokens || 0} / ${g.completion_tokens || 0}`;
        const cost = g.cost_usd != null ? '$' + Number(g.cost_usd).toFixed(4) : '—';
        const statusBadge = g.status === 'ok'
            ? '<span class="novel-status-pill novel-status-done">成功</span>'
            : '<span class="novel-status-pill novel-status-completed" style="background:#fee2e2;color:#991b1b;border-color:#fecaca;">失败</span>';

        // 元数据 grid
        const metaItems = [
            { label: 'ID', value: g.id },
            { label: '时间', value: ts },
            { label: '中文名', value: g.display_name || '—' },
            { label: 'Skill', value: g.skill || '' },
            { label: 'Provider', value: g.provider || '' },
            { label: '模型', value: g.model || '' },
            { label: 'Tokens (in/out)', value: tokens },
            { label: '耗时', value: dur },
            { label: '费用', value: cost },
            { label: '状态', value: statusBadge },
        ];
        if (g.phase) metaItems.push({ label: 'Phase', value: g.phase });
        if (g.agent_name && g.agent_name !== g.skill) metaItems.push({ label: 'Agent', value: g.agent_name });
        if (g.round && g.round > 1) metaItems.push({ label: '轮次', value: 'R' + g.round });
        if (g.chapter_id) metaItems.push({ label: 'Chapter', value: g.chapter_id.slice(0, 8) + '…' });

        $logMeta.innerHTML = `
            <div class="novel-log-meta-grid">
                ${metaItems.map(m => `
                    <div class="novel-log-meta-item">
                        <div class="novel-log-meta-label">${esc(m.label)}</div>
                        <div class="novel-log-meta-value">${m.value}</div>
                    </div>
                `).join('')}
            </div>`;

        if ($logRequest) {
            $logRequest.textContent = g.raw_request || '（无输入）';
        }
        if ($logResponse) {
            $logResponse.textContent = g.raw_response || '（无输出）';
        }
        if ($logErrorWrap && $logError) {
            if (g.error_msg) {
                $logErrorWrap.hidden = false;
                $logError.textContent = g.error_msg;
            } else {
                $logErrorWrap.hidden = true;
                $logError.textContent = '';
            }
        }

        const titleEl = document.getElementById('novelLogModalTitle');
        if (titleEl) {
            const dn = g.display_name || g.skill || '日志';
            titleEl.innerHTML = `<i class="fa-regular fa-receipt"></i> ${esc(dn)} · ${esc(ts)}`;
        }

        // OpenClaw：保存当前 log 引用 + 重置反馈状态 + 加载历史反馈
        _currentLog = g;
        _currentFeedbackVote = null;
        document.querySelectorAll('.novel-feedback-btn').forEach(btn => btn.classList.remove('active-up', 'active-down'));
        const commentEl = document.getElementById('novelLogFeedbackComment');
        if (commentEl) commentEl.value = '';
        _renderFeedbackCurrent(null);
        _loadExistingFeedback(g);
    }
    async function _loadExistingFeedback(g) {
        if (!g || !g.novel_id || !g.skill) return;
        try {
            const list = await window.api.ainovel.listAgentFeedback({ novelId: g.novel_id, skill: g.skill, limit: 5 });
            if (list && list.length) {
                const latest = list[0];
                const v = latest.vote === 'up' ? '👍' : '👎';
                _renderFeedbackCurrent(latest.vote, latest.comment);
                // 同步高亮按钮
                document.querySelectorAll('.novel-feedback-btn').forEach(btn => {
                    btn.classList.remove('active-up', 'active-down');
                    if (btn.dataset.vote === latest.vote) {
                        btn.classList.add(latest.vote === 'up' ? 'active-up' : 'active-down');
                    }
                });
                _currentFeedbackVote = latest.vote;
            }
        } catch (e) {
            // 静默失败
        }
    }

    function _closeLogDetail() {
        if (!$logModal) return;
        $logModal.style.display = 'none';
        $logModal.classList.remove('active');
    }

    // ===== OpenClaw 模式：用户反馈 =====
    let _currentLog = null;
    let _currentFeedbackVote = null;
    function _onFeedbackVote(vote) {
        _currentFeedbackVote = vote;
        document.querySelectorAll('.novel-feedback-btn').forEach(btn => {
            btn.classList.remove('active-up', 'active-down');
            if (btn.dataset.vote === vote) {
                btn.classList.add(vote === 'up' ? 'active-up' : 'active-down');
            }
        });
    }
    async function _onSubmitFeedback() {
        if (!_currentLog) return;
        if (!_currentFeedbackVote) {
            toast('请先点 👍 或 👎', 'warn');
            return;
        }
        const commentEl = document.getElementById('novelLogFeedbackComment');
        const comment = commentEl ? commentEl.value.trim() : '';
        const btn = document.getElementById('novelLogSubmitFeedback');
        if (btn) btn.disabled = true;
        try {
            const r = await window.api.ainovel.saveAgentFeedback({
                novelId: _currentLog.novel_id,
                skill: _currentLog.skill,
                vote: _currentFeedbackVote,
                comment,
                generationId: _currentLog.id,
            });
            if (r && r.ok) {
                toast('反馈已提交，下次生成会读取', 'success');
                _renderFeedbackCurrent(_currentFeedbackVote, comment);
            } else {
                toast('提交失败：' + (r && r.error || '未知错误'), 'error');
            }
        } catch (e) {
            toast('提交失败：' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }
    function _renderFeedbackCurrent(vote, comment) {
        const el = document.getElementById('novelLogFeedbackCurrent');
        if (!el) return;
        if (!vote) {
            el.textContent = '';
            return;
        }
        el.textContent = `当前记录：${vote === 'up' ? '👍' : '👎'}${comment ? ' ' + comment : ''}`;
    }
    async function _openAgentConfigFromLog() {
        if (!_currentLog || !_currentLog.skill) {
            toast('当前日志没有 skill', 'warn');
            return;
        }
        _openAgentConfig(_currentLog.skill);
    }
    async function _onFlushMemory() {
        if (!_currentLog || !_currentLog.skill) {
            toast('当前日志没有 skill', 'warn');
            return;
        }
        try {
            const r = await window.api.ainovel.flushMemory({
                skill: _currentLog.skill,
                novelId: _currentLog.novel_id,
                force: true,
            });
            if (r && r.flushed) {
                toast(`提炼完成：${r.fileCount} 个文件，${r.bytes} 字节`, 'success');
            } else {
                toast(`未触发（${r && r.bytes || 0} 字节 < 阈值 ${r && r.threshold || '?'}）`, 'info');
            }
        } catch (e) {
            toast('提炼失败：' + e.message, 'error');
        }
    }

    // ===== OpenClaw 模式：Agent 配置编辑 =====
    let _currentConfig = null;   // { skill, files: { 'SOUL.md': '...', ... } }
    let _currentConfigFile = 'SOUL.md';
    function _openAgentConfig(skill) {
        const modal = document.getElementById('novelAgentConfigModal');
        const title = document.getElementById('novelAgentConfigTitle');
        if (!modal) return;
        if (title) title.innerHTML = `<i class="fa-solid fa-folder-open"></i> Agent 配置 — ${esc(skill)}`;
        modal.style.display = 'flex';
        modal.classList.add('active');
        _loadAgentConfigToEditor(skill);
    }
    function _closeAgentConfig() {
        const modal = document.getElementById('novelAgentConfigModal');
        if (!modal) return;
        modal.style.display = 'none';
        modal.classList.remove('active');
        _currentConfig = null;
    }
    async function _loadAgentConfigToEditor(skill) {
        try {
            const r = await window.api.ainovel.getAgentConfig(skill);
            if (!r || r.error) {
                toast('读取配置失败：' + (r && r.error || '未知'), 'error');
                return;
            }
            _currentConfig = r;
            _switchConfigTab('SOUL.md');
        } catch (e) {
            toast('读取配置失败：' + e.message, 'error');
        }
    }
    function _switchConfigTab(file) {
        _currentConfigFile = file;
        document.querySelectorAll('.novel-config-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.file === file);
        });
        const editor = document.getElementById('novelConfigEditor');
        if (editor && _currentConfig) {
            editor.value = _currentConfig.files[file] || '';
        }
        const hint = document.getElementById('novelConfigHint');
        if (hint) hint.textContent = '';
    }
    function _reloadConfigTab() {
        _switchConfigTab(_currentConfigFile);
        toast('已重新加载', 'info');
    }
    async function _saveConfigTab() {
        if (!_currentConfig) return;
        const editor = document.getElementById('novelConfigEditor');
        const hint = document.getElementById('novelConfigHint');
        if (!editor) return;
        const content = editor.value;
        try {
            const r = await window.api.ainovel.saveAgentConfig(_currentConfig.skill, _currentConfigFile, content);
            if (r && r.ok) {
                if (hint) {
                    hint.textContent = `已保存（${r.bytes} 字节）`;
                    hint.className = 'novel-config-hint success';
                }
                _currentConfig.files[_currentConfigFile] = content;
            } else {
                if (hint) {
                    hint.textContent = '保存失败：' + (r && r.error || '未知');
                    hint.className = 'novel-config-hint error';
                }
            }
        } catch (e) {
            if (hint) {
                hint.textContent = '保存失败：' + e.message;
                hint.className = 'novel-config-hint error';
            }
        }
    }

    function _copyLogText(text) {
        if (!text) { toast('内容为空', 'warn'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                () => toast('已复制到剪贴板', 'success'),
                () => _fallbackCopy(text)
            );
        } else {
            _fallbackCopy(text);
        }
    }

    function _fallbackCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            toast('已复制到剪贴板', 'success');
        } catch (e) {
            toast('复制失败：' + e.message, 'error');
        }
    }

    // ===== New Novel =====
    function _openNewModal() {
        document.getElementById('novelFormTitle').value = '';
        document.getElementById('novelFormCoreIdea').value = '';
        document.getElementById('novelFormStyle').value = '玄幻';
        document.getElementById('novelFormCustomStyle').value = '';
        document.getElementById('novelFormCustomStyleRow').hidden = true;
        document.getElementById('novelFormTargetWords').value = '1000000';
        document.getElementById('novelFormChapterCount').value = '30';
        // 修复「modal 出现但点不中输入」：display:none → flex 与 .active 类同帧触发，
        // 浏览器对"从无到有"的 opacity/visibility 过渡初始化不可靠，会出现元素已渲染
        // 但 visibility:hidden 的中间态——视觉可见但不吃 pointer events。
        // 拆成两帧：先把 display 落地（用 reflow 强制 commit），下一帧再加 .active。
        $newModal.style.display = 'flex';
        void $newModal.offsetHeight;
        requestAnimationFrame(() => {
            $newModal.classList.add('active');
            // 顺手把焦点落到第一个输入框，省一次点击
            const $t = document.getElementById('novelFormTitle');
            if ($t) $t.focus({ preventScroll: true });
        });
    }
    function _closeNewModal() {
        // 先去掉 .active 让过渡正着走（opacity 1→0、visibility visible→hidden），
        // 再 display:none。避免快速二次打开时过渡状态叠加导致 visibility 卡在 hidden。
        $newModal.classList.remove('active');
        $newModal.style.display = 'none';
    }
    async function _submitNew() {
        const title = document.getElementById('novelFormTitle').value.trim();
        const coreIdea = document.getElementById('novelFormCoreIdea').value.trim();
        if (!title) { toast('标题必填', 'warn'); return; }
        if (!coreIdea) { toast('核心创意必填', 'warn'); return; }
        const payload = {
            title,
            core_idea: coreIdea,
            style: document.getElementById('novelFormStyle').value,
            custom_style: document.getElementById('novelFormCustomStyle').value.trim(),
            pov: document.getElementById('novelFormPov').value,
            tone: document.getElementById('novelFormTone').value,
            target_word_count: parseInt(document.getElementById('novelFormTargetWords').value) || 1000000,
            chapter_target_count: parseInt(document.getElementById('novelFormChapterCount').value) || 30,
        };
        try {
            const r = await window.api.ainovel.create(payload);
            if (!r || !r.ok) {
                toast(r && r.error || '创建失败', 'error');
                return;
            }
            toast('已创建，开始生成大纲...', 'success');
            _closeNewModal();
            _st.activeNovelId = r.novelId;
            await _refreshList();
            await _renderDetail();
            // 用流式模式触发大纲生成（防重复 + 实时预览）；失败由 generation_failed 事件驱动
            _generateOutline();
        } catch (e) {
            toast('创建失败：' + e.message, 'error');
        }
    }

    // ===== Delete Active =====
    async function _confirmDeleteActive() {
        if (!_st.activeNovelId) return;
        const nv = _st.novels.find(n => n.id === _st.activeNovelId);
        if (!nv) return;
        if (!confirm(`确认删除小说「${nv.title}」？所有大纲、章节、生成日志会一并删除，无法恢复。`)) return;
        try {
            const r = await window.api.ainovel.delete(_st.activeNovelId);
            if (!r || !r.ok) {
                toast(r && r.error || '删除失败', 'error');
                return;
            }
            _st.activeNovelId = null;
            toast('已删除', 'success');
            await _refreshList();
        } catch (e) {
            toast('删除失败：' + e.message, 'error');
        }
    }

    // ===== Export =====
    async function _exportActive() {
        if (!_st.activeNovelId) return;
        try {
            const r = await window.api.ainovel.exportTxt(_st.activeNovelId);
            if (!r || !r.ok) {
                if (r && r.error && r.error !== '已取消') toast(r.error, 'error');
                return;
            }
            toast('已导出到 ' + r.path, 'success');
        } catch (e) {
            toast('导出失败：' + e.message, 'error');
        }
    }

    function safeJson(s) {
        if (Array.isArray(s)) return s;
        if (typeof s !== 'string') return null;
        try { return JSON.parse(s); } catch { return null; }
    }

    // ===== Settings Pane（由 settings.js 的 renderAiNovelPane 调用，渲染 provider 配置表单）=====
    const _PROVIDER_URL_HINT = {
        openai:    'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com',
        ollama:    'http://localhost:11434',
    };

    async function renderIntoSettings(container) {
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'novel-settings-wrap';
        wrap.innerHTML = `
            <div class="novel-settings-subnav">
                <button class="novel-settings-subtab active" data-subtab="llm" type="button">
                    <i class="fa-solid fa-microchip"></i> LLM 配置
                </button>
                <button class="novel-settings-subtab" data-subtab="agents" type="button">
                    <i class="fa-solid fa-robot"></i> Agent 配置
                </button>
            </div>
            <div class="novel-settings-subpanes">
                <div class="novel-settings-subpane active" data-subpane="llm"></div>
                <div class="novel-settings-subpane" data-subpane="agents"></div>
            </div>
        `;
        container.appendChild(wrap);

        const llmPane = wrap.querySelector('[data-subpane="llm"]');
        const agentsPane = wrap.querySelector('[data-subpane="agents"]');

        // 子 Tab 切换
        wrap.querySelector('.novel-settings-subnav').addEventListener('click', (e) => {
            const btn = e.target.closest('.novel-settings-subtab');
            if (!btn) return;
            const key = btn.dataset.subtab;
            wrap.querySelectorAll('.novel-settings-subtab').forEach(b => {
                b.classList.toggle('active', b === btn);
            });
            wrap.querySelectorAll('.novel-settings-subpane').forEach(p => {
                p.classList.toggle('active', p.dataset.subpane === key);
            });
        });

        await _renderLLMSettingsPane(llmPane);
        _renderAgentSettingsPane(agentsPane);
    }

    // ========== LLM 配置 子面板（原 renderIntoSettings 主体）==========
    async function _renderLLMSettingsPane(container) {
        container.innerHTML = `
            <div class="novel-settings-card">
                <h3><i class="fa-solid fa-microchip"></i> LLM Provider 配置</h3>
                <p class="novel-settings-hint">配置 AI 小说使用的 LLM 服务。API Key 本地明文存储于本机数据库，仅本机可读。</p>
                <div class="novel-settings-form">
                    <div class="novel-form-row">
                        <label>Provider 类型</label>
                        <select id="ainovelProvider">
                            <option value="openai">OpenAI 兼容（GPT / DeepSeek / Moonshot）</option>
                            <option value="anthropic">Anthropic（Claude）</option>
                            <option value="ollama">Ollama（本地）</option>
                        </select>
                    </div>
                    <div class="novel-form-row">
                        <label>Base URL</label>
                        <input id="ainovelBaseUrl" type="text" placeholder="https://api.openai.com/v1">
                        <div class="novel-settings-hint" id="ainovelBaseUrlHint"></div>
                    </div>
                    <div class="novel-form-row" id="ainovelApiKeyRow">
                        <label>API Key</label>
                        <input id="ainovelApiKey" type="password" placeholder="sk-...">
                    </div>
                    <div class="novel-form-row">
                        <label>模型</label>
                        <div class="novel-model-row">
                            <input id="ainovelModel" type="text" placeholder="gpt-4o-mini" class="novel-model-input">
                            <button id="ainovelFetchModels" class="btn btn-sm" type="button"><i class="fa-solid fa-list"></i> 拉取模型列表</button>
                        </div>
                        <select id="ainovelModelSelect" class="novel-model-select" hidden></select>
                    </div>
                    <div class="novel-form-row novel-form-grid">
                        <div>
                            <label>Temperature</label>
                            <input id="ainovelTemperature" type="number" min="0" max="2" step="0.1" value="0.8">
                        </div>
                        <div>
                            <label>Max Tokens</label>
                            <input id="ainovelMaxTokens" type="number" min="256" max="32000" step="256" value="4000">
                        </div>
                    </div>
                    <div class="novel-settings-actions">
                        <button id="ainovelTestBtn" class="btn" type="button"><i class="fa-solid fa-plug"></i> 测试连接</button>
                        <button id="ainovelSaveBtn" class="btn btn-primary" type="button"><i class="fa-solid fa-check"></i> 保存</button>
                        <span id="ainovelTestResult" class="novel-settings-result"></span>
                    </div>
                </div>
            </div>`;

        const $provider = container.querySelector('#ainovelProvider');
        const $baseUrl = container.querySelector('#ainovelBaseUrl');
        const $apiKey = container.querySelector('#ainovelApiKey');
        const $apiKeyRow = container.querySelector('#ainovelApiKeyRow');
        const $model = container.querySelector('#ainovelModel');
        const $modelSelect = container.querySelector('#ainovelModelSelect');
        const $fetchModels = container.querySelector('#ainovelFetchModels');
        const $temp = container.querySelector('#ainovelTemperature');
        const $maxTokens = container.querySelector('#ainovelMaxTokens');
        const $testBtn = container.querySelector('#ainovelTestBtn');
        const $saveBtn = container.querySelector('#ainovelSaveBtn');
        const $result = container.querySelector('#ainovelTestResult');
        const $baseUrlHint = container.querySelector('#ainovelBaseUrlHint');

        function _syncProviderUI() {
            const p = $provider.value;
            $baseUrl.placeholder = _PROVIDER_URL_HINT[p] || '';
            $apiKeyRow.hidden = (p === 'ollama');
            $baseUrlHint.textContent = (p === 'anthropic')
                ? 'Anthropic 路径会自动补 /v1/messages'
                : (p === 'ollama' ? '本地 Ollama 服务地址' : '');
        }
        $provider.addEventListener('change', _syncProviderUI);

        function _readCfg() {
            return {
                provider: $provider.value,
                base_url: $baseUrl.value.trim(),
                api_key: $apiKey.value.trim(),
                model: $model.value.trim(),
                temperature: parseFloat($temp.value) || 0.8,
                max_tokens: parseInt($maxTokens.value) || 4000,
            };
        }
        function _setResult(text, kind) {
            $result.textContent = text || '';
            $result.className = 'novel-settings-result' + (kind ? ' novel-settings-result-' + kind : '');
        }

        try {
            const r = await window.api.ainovel.getProviderConfig();
            const c = (r && r.ok && r.config) || null;
            if (c) {
                $provider.value = c.provider || 'openai';
                $baseUrl.value = c.base_url || '';
                $apiKey.value = c.api_key || '';
                $model.value = c.model || '';
                $temp.value = c.temperature != null ? c.temperature : 0.8;
                $maxTokens.value = c.max_tokens != null ? c.max_tokens : 4000;
            } else {
                $provider.value = 'openai';
            }
            _syncProviderUI();
        } catch (e) {
            console.warn('[novel-settings] load config:', e);
            _syncProviderUI();
        }

        $fetchModels.addEventListener('click', async () => {
            _setResult('正在拉取模型列表…', 'loading');
            try {
                const r = await window.api.ainovel.testProvider(_readCfg());
                if (!r || !r.ok) {
                    _setResult('✗ ' + (r && r.error || '失败'), 'error');
                    return;
                }
                const models = (r.models || []).filter(Boolean);
                if (!models.length) {
                    _setResult('未返回模型列表', 'warn');
                    $modelSelect.hidden = true;
                    return;
                }
                $modelSelect.innerHTML = '<option value="">— 选择已拉取的模型 —</option>' +
                    models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
                $modelSelect.hidden = false;
                $modelSelect.onchange = () => {
                    if ($modelSelect.value) $model.value = $modelSelect.value;
                };
                _setResult(`✓ 找到 ${models.length} 个模型`, 'ok');
            } catch (e) {
                _setResult('✗ ' + e.message, 'error');
            }
        });

        $testBtn.addEventListener('click', async () => {
            _setResult('正在测试连接…', 'loading');
            try {
                const r = await window.api.ainovel.testProvider(_readCfg());
                if (r && r.ok) _setResult('✓ 连接成功', 'ok');
                else _setResult('✗ ' + (r && r.error || '连接失败'), 'error');
            } catch (e) {
                _setResult('✗ ' + e.message, 'error');
            }
        });

        $saveBtn.addEventListener('click', async () => {
            const cfg = _readCfg();
            if (!cfg.model) { toast('请填写模型名', 'warn'); return; }
            try {
                const r = await window.api.ainovel.setProviderConfig(cfg);
                if (!r || !r.ok) { toast(r && r.error || '保存失败', 'error'); return; }
                toast('已保存', 'success');
                _st.providerConfig = cfg;
                if ($providerBadge) {
                    $providerBadge.textContent = `${cfg.provider} · ${cfg.model}`;
                    $providerBadge.className = 'novel-provider-badge novel-provider-badge-ok';
                }
            } catch (e) {
                toast('保存失败：' + e.message, 'error');
            }
        });
    }

    // ========== Agent 配置 子面板 ==========
    // 左侧 Agent 列表 + 右侧 4 子 Tab（SOUL/IDENTITY/AGENTS/MEMORY）编辑器
    // 复用 ainovel:getAgentConfig / saveAgentConfig。
    function _renderAgentSettingsPane(container) {
        container.innerHTML = `
            <div class="novel-settings-card novel-agents-card">
                <h3><i class="fa-solid fa-robot"></i> Agent 配置</h3>
                <p class="novel-settings-hint">查看和修改每个 Agent 的 SOUL / IDENTITY / AGENTS / MEMORY 文件。修改后保存即可生效，下一次该 Agent 执行任务时会读到最新内容。</p>
                <div class="novel-agents-layout">
                    <div class="novel-agents-list-col">
                        <div class="novel-agents-list-head">所有 Agent</div>
                        <div class="novel-agents-list-body" id="novelAgentsListBody">
                            <div class="novel-agents-list-loading">加载中…</div>
                        </div>
                    </div>
                    <div class="novel-agents-editor-col">
                        <div class="novel-agents-editor-head">
                            <span id="novelAgentsCurrentName">请选择左侧 Agent</span>
                            <span class="novel-agents-current-file" id="novelAgentsCurrentFile"></span>
                        </div>
                        <div class="novel-config-tabs" id="novelAgentsTabs">
                            <button class="novel-config-tab active" data-file="SOUL.md" type="button">SOUL 人格</button>
                            <button class="novel-config-tab" data-file="IDENTITY.md" type="button">IDENTITY 身份</button>
                            <button class="novel-config-tab" data-file="AGENTS.md" type="button">AGENTS SOP</button>
                            <button class="novel-config-tab" data-file="MEMORY.md" type="button">MEMORY 经验</button>
                        </div>
                        <textarea id="novelAgentsEditor" class="novel-config-editor" spellcheck="false" placeholder="选择左侧 Agent 开始编辑"></textarea>
                        <div class="novel-config-actions">
                            <button class="btn btn-sm" id="novelAgentsReload" type="button" disabled><i class="fa-solid fa-rotate"></i> 重新加载</button>
                            <button class="btn btn-sm btn-primary" id="novelAgentsSave" type="button" disabled><i class="fa-solid fa-save"></i> 保存</button>
                            <span class="novel-config-hint" id="novelAgentsHint"></span>
                        </div>
                    </div>
                </div>
            </div>`;

        const $listBody = container.querySelector('#novelAgentsListBody');
        const $name = container.querySelector('#novelAgentsCurrentName');
        const $file = container.querySelector('#novelAgentsCurrentFile');
        const $editor = container.querySelector('#novelAgentsEditor');
        const $tabs = container.querySelector('#novelAgentsTabs');
        const $reload = container.querySelector('#novelAgentsReload');
        const $save = container.querySelector('#novelAgentsSave');
        const $hint = container.querySelector('#novelAgentsHint');

        const _state = {
            skill: '',     // 当前选中 Agent
            file: 'SOUL.md',
            cache: {},     // { 'SOUL.md': '...' }
            dirty: false,
        };
        // skillName → {displayName, description}（来自 listSkills，仅用于显示）
        const _agentListCache = {};

        function _setHint(text, kind) {
            $hint.textContent = text || '';
            $hint.className = 'novel-config-hint' + (kind ? ' novel-config-hint-' + kind : '');
        }
        function _syncButtons() {
            $reload.disabled = !_state.skill;
            $save.disabled = !_state.skill || !_state.dirty;
        }
        function _markDirty() {
            _state.dirty = true;
            _setHint('有未保存的修改', 'warn');
            _syncButtons();
        }
        function _switchFile(file) {
            _state.file = file;
            $tabs.querySelectorAll('.novel-config-tab').forEach(b => {
                const active = b.dataset.file === file;
                b.classList.toggle('active', active);
            });
            $editor.value = (_state.cache[file] != null) ? _state.cache[file] : '';
            $file.textContent = file;
            _state.dirty = false;
            _setHint(_state.skill ? `已加载 ${file}` : '', _state.skill ? 'ok' : '');
            _syncButtons();
        }
        async function _loadAgent(skill) {
            _state.skill = skill;
            _state.cache = {};
            _state.dirty = false;
            // 显示中文名（来自 listSkills 缓存），没有就回退 id
            const displayName = (_agentListCache[skill] && _agentListCache[skill].displayName) || skill;
            $name.textContent = displayName;
            $name.dataset.skillId = skill;
            $listBody.querySelectorAll('.novel-agents-item').forEach(el => {
                el.classList.toggle('active', el.dataset.skill === skill);
            });
            $editor.value = '加载中…';
            $editor.disabled = true;
            _setHint('正在加载…', 'loading');
            try {
                const r = await window.api.ainovel.getAgentConfig(skill);
                if (!r || r.error) {
                    $editor.value = '';
                    $editor.disabled = false;
                    _setHint((r && r.error) || '加载失败', 'error');
                    _switchFile(_state.file);
                    return;
                }
                // engine 返回 {skill, dir, files: {'SOUL.md':..., 'IDENTITY.md':..., 'AGENTS.md':..., 'MEMORY.md':...}}
                const files = (r && r.files) || {};
                _state.cache = {
                    'SOUL.md': files['SOUL.md'] || '',
                    'IDENTITY.md': files['IDENTITY.md'] || '',
                    'AGENTS.md': files['AGENTS.md'] || '',
                    'MEMORY.md': files['MEMORY.md'] || '',
                };
                $editor.disabled = false;
                _switchFile(_state.file);
            } catch (e) {
                $editor.disabled = false;
                _setHint('加载失败：' + e.message, 'error');
                _switchFile(_state.file);
            }
        }
        async function _saveAgent() {
            if (!_state.skill) return;
            _setHint('正在保存…', 'loading');
            $save.disabled = true;
            try {
                const r = await window.api.ainovel.saveAgentConfig(_state.skill, _state.file, $editor.value);
                if (!r || !r.ok) {
                    _setHint((r && r.error) || '保存失败', 'error');
                    $save.disabled = false;
                    return;
                }
                _state.cache[_state.file] = $editor.value;
                _state.dirty = false;
                _setHint(`已保存 ${_state.file}`, 'ok');
                _syncButtons();
            } catch (e) {
                _setHint('保存失败：' + e.message, 'error');
                $save.disabled = false;
            }
        }
        $tabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.novel-config-tab');
            if (!btn) return;
            if (btn.dataset.file === _state.file) return;
            // 切文件前若 dirty，先写入当前文件再切换
            if (_state.dirty) {
                _saveAgent().then(() => _switchFile(btn.dataset.file));
            } else {
                _switchFile(btn.dataset.file);
            }
        });
        $editor.addEventListener('input', () => {
            if (!_state.skill) return;
            if ($editor.value !== (_state.cache[_state.file] || '')) {
                _markDirty();
            } else if (_state.dirty) {
                _state.dirty = false;
                _setHint(`已加载 ${_state.file}`, 'ok');
                _syncButtons();
            }
        });
        $reload.addEventListener('click', () => {
            if (!_state.skill) return;
            _loadAgent(_state.skill);
        });
        $save.addEventListener('click', _saveAgent);

        // 加载 skill 列表
        (async () => {
            try {
                const r = await window.api.ainovel.listSkills();
                const skills = (r && r.ok && r.skills) || [];
                if (!skills.length) {
                    $listBody.innerHTML = '<div class="novel-agents-list-empty">暂无可管理的 Agent</div>';
                    return;
                }
                // 缓存 displayName 给 _loadAgent 用
                skills.forEach(s => { _agentListCache[s.name] = s; });
                $listBody.innerHTML = skills.map(s =>
                    `<button class="novel-agents-item" type="button" data-skill="${esc(s.name)}">
                        <span class="novel-agents-item-name">${esc(s.displayName || s.name)}</span>
                        <span class="novel-agents-item-id">${esc(s.name)}</span>
                        <span class="novel-agents-item-desc">${esc((s.description || '').slice(0, 80))}</span>
                    </button>`
                ).join('');
                $listBody.addEventListener('click', (e) => {
                    const item = e.target.closest('.novel-agents-item');
                    if (!item) return;
                    _loadAgent(item.dataset.skill);
                });
            } catch (e) {
                $listBody.innerHTML = '<div class="novel-agents-list-empty">加载失败：' + esc(e.message || '未知') + '</div>';
            }
        })();
    }

    // ===== Auto-progression 事件处理（Phase 2）=====
    function _wireAutoBar() {
        const $toggle = document.getElementById('novelAutoToggle');
        const $btn = document.getElementById('novelAutoBtn');
        const $cancelBtn = document.getElementById('novelAutoCancelBtn');
        if ($toggle) {
            $toggle.addEventListener('change', async () => {
                if (_auto.active) {
                    // 已经在跑 — 切 checkbox 不应有副作用；忽略
                    $toggle.checked = true;
                    return;
                }
                if (!_st.activeNovelId) return;
                try {
                    const r = await window.api.ainovel.autoStart(_st.activeNovelId);
                    if (!r || !r.ok) {
                        toast(r && r.error || '启动自动模式失败', 'error');
                        $toggle.checked = false;
                    }
                } catch (e) {
                    toast('启动失败：' + e.message, 'error');
                    $toggle.checked = false;
                }
            });
        }
        if ($btn) {
            $btn.addEventListener('click', async () => {
                if (!_st.activeNovelId) return;
                if (!_auto.active) return;
                try {
                    if (_auto.paused) {
                        await window.api.ainovel.autoResume(_st.activeNovelId);
                    } else {
                        await window.api.ainovel.autoPause(_st.activeNovelId);
                    }
                } catch (e) {
                    toast('操作失败：' + e.message, 'error');
                }
            });
        }
        if ($cancelBtn) {
            $cancelBtn.addEventListener('click', async () => {
                if (!_st.activeNovelId) return;
                if (!_auto.active) return;
                if (!confirm('确认取消自动写作？当前章节会完成，但不会开新章节。')) return;
                try {
                    await window.api.ainovel.autoCancel(_st.activeNovelId);
                } catch (e) {
                    toast('取消失败：' + e.message, 'error');
                }
            });
        }
    }

    function _refreshAutoBarUI() {
        const $toggle = document.getElementById('novelAutoToggle');
        const $progress = document.getElementById('novelAutoProgress');
        const $label = document.getElementById('novelAutoProgressLabel');
        const $bar = document.getElementById('novelAutoProgressBar');
        const $count = document.getElementById('novelAutoProgressCount');
        const $btn = document.getElementById('novelAutoBtn');
        const $cancelBtn = document.getElementById('novelAutoCancelBtn');
        const $status = document.getElementById('novelAutoStatus');
        if (!$toggle || !$progress) return;
        $toggle.checked = _auto.active;
        $progress.hidden = !_auto.active;
        if ($label) $label.textContent = _auto.currentChapterNo ? `第 ${_auto.currentChapterNo} 章` : '';
        if ($bar) { $bar.value = _auto.completedChapters; $bar.max = _auto.totalChapters || 1; }
        if ($count) $count.textContent = `${_auto.completedChapters} / ${_auto.totalChapters}`;
        if ($btn) {
            $btn.innerHTML = '<i class="fa-solid fa-' + (_auto.paused ? 'play' : 'pause') + '"></i> ' + (_auto.paused ? '继续' : '暂停');
        }
        if ($cancelBtn) $cancelBtn.disabled = !_auto.active;
        if ($status) {
            $status.textContent = _auto.active ? '自动写作进行中…' : '手动模式';
        }
    }

    function _onAutoStarted(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.active = true;
        _auto.paused = false;
        _auto.totalChapters = ev.totalChapters || 0;
        _auto.completedChapters = ev.completedChapters || 0;
        _auto.currentChapterNo = 0;
        toast('已启动自动写作模式', 'success');
        _refreshAutoBarUI();
    }

    function _onAutoChapterStarted(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.currentChapterNo = ev.chapterNo || 0;
        _refreshAutoBarUI();
        // 切到章节 tab 看实时进度
        if (_st.activeTab !== 'chapters') _switchTab('chapters');
    }

    function _onAutoChapterFailed(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast(`第 ${ev.chapterNo} 章失败：${ev.error || '未知错误'}（15s 后自动重试）`, 'warn');
    }

    function _onAutoPaused(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.paused = true;
        toast('自动写作已暂停', 'info');
        _refreshAutoBarUI();
    }

    function _onAutoResumed(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.paused = false;
        toast('已继续', 'info');
        _refreshAutoBarUI();
    }

    function _onAutoCancelled(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.active = false;
        _auto.paused = false;
        toast('已取消', 'info');
        _refreshAutoBarUI();
    }

    function _onAutoFinished(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        _auto.active = false;
        _auto.paused = false;
        _auto.completedChapters = ev.totalChapters || _auto.completedChapters;
        toast(`🎉 自动写作完成，共 ${ev.totalWords || 0} 字`, 'success');
        _refreshAutoBarUI();
        _renderDetail();
    }

    // 全自动连写：在大纲生成完成后自动调 autoStart，无需用户点「开始自动写作」
    // 用户偏好（落 _ainovel_settings）默认 false；要开就在调度器面板顶部那个开关
    let _autoChainPref = null;  // null = 未加载；true / false = 用户显式设置
    async function _loadAutoChainPref() {
        if (_autoChainPref !== null) return _autoChainPref;
        try {
            const r = await window.api.ainovel.getSetting && window.api.ainovel.getSetting('auto_chain_after_outline');
            _autoChainPref = !!(r && r.value === 'true');  // 默认 false（要勾选才自动连写）
        } catch (e) { _autoChainPref = false; }
        return _autoChainPref;
    }
    async function _setAutoChainPref(v) {
        _autoChainPref = !!v;
        try {
            await window.api.ainovel.setSetting && window.api.ainovel.setSetting('auto_chain_after_outline', v ? 'true' : 'false');
        } catch (e) { /* best effort */ }
    }
    async function _autoChainAfterOutlineIfEnabled(novelId) {
        const enabled = await _loadAutoChainPref();
        if (!enabled) return;
        if (!novelId) return;
        if (_auto && _auto.active) return;        // 已经在跑，不重复触发
        // 延迟 1.5s，让 _renderDetail 先把 idle 视图渲染出来 + 用户能看到大纲 toast
        setTimeout(async () => {
            try {
                const r = await window.api.ainovel.autoStart(novelId);
                if (r && r.ok) {
                    // 成功 → autoStarted 事件会 toast「已启动自动写作模式」
                } else if (r && /自动模式已在运行/.test(r.error || '')) {
                    // 已经在跑（极少见但防御一下）
                } else if (r && /没有待写章节/.test(r.error || '')) {
                    console.info('[novel] autoChain: 大纲生成后无 pending 章节，跳过');
                } else if (r && r.error) {
                    console.warn('[novel] autoChain autoStart failed:', r.error);
                    toast('自动连写启动失败：' + r.error + '（你仍可手动点「开始自动写作」）', 'warn');
                }
            } catch (e) {
                console.warn('[novel] autoChain throw:', e.message);
            }
        }, 1500);
    }

    // 编剧监督开关：每章完成后让 LLM 决定下一步
    let _oversightPref = null;
    async function _loadOversightPref() {
        if (_oversightPref !== null) return _oversightPref;
        try {
            const r = await window.api.ainovel.getSetting && window.api.ainovel.getSetting('auto_oversight_enabled');
            _oversightPref = r && r.value === 'true';  // 默认 false（不破坏现有用户）
        } catch (e) { _oversightPref = false; }
        return _oversightPref;
    }
    async function _setOversightPref(v) {
        _oversightPref = !!v;
        try {
            await window.api.ainovel.setSetting && window.api.ainovel.setSetting('auto_oversight_enabled', v ? 'true' : 'false');
        } catch (e) { /* best effort */ }
    }

    // oversight 决策日志（最近 50 条，按 novelId 分组）
    const _oversightLog = new Map();  // novelId → Array<{ts, action, reason, note}>
    function _pushOversightLog(novelId, entry) {
        if (!_oversightLog.has(novelId)) _oversightLog.set(novelId, []);
        const arr = _oversightLog.get(novelId);
        arr.unshift({ ts: Date.now(), ...entry });
        if (arr.length > 50) arr.length = 50;
    }
    function _onAutoOverseerDecided(ev) {
        _pushOversightLog(ev.novelId, {
            action: ev.action || '?',
            reason: ev.reason || '',
            note: ev.note || '',
            afterChapterNo: ev.afterChapterNo,
        });
        if (ev.novelId === _st.activeNovelId) {
            const label = { continue: '继续', pause: '暂停', rewrite_last: '重写上一章', inject_note: '注入约束', abort: '中止' }[ev.action] || ev.action;
            const shortReason = (ev.reason || '').slice(0, 80);
            toast(`🎬 编剧监督：第 ${ev.afterChapterNo || '?'} 章后 → ${label}（${shortReason}）`, 'info');
            // 如果当前在调度器 tab 的导演子面板，刷新
            if (_sched.section === 'director') {
                try { _renderDirectorSubtab && _renderDirectorSubtab(); } catch (e) { /* ignore */ }
            }
        }
    }
    function _onAutoOverseerFailed(ev) {
        if (ev.novelId === _st.activeNovelId) {
            toast('编剧监督失败（已默认 continue）：' + (ev.error || ''), 'warn');
        }
    }

    // ===== Phase 3: 知识库事件 handlers =====
    function _onKnowledgeExtracting(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast(`知识库抽取中：${(ev.kinds || []).join(' / ')}`, 'info');
        // 切到知识库 tab 看实时进度
        if (_st.activeTab !== 'knowledge') _switchTab('knowledge');
    }

    function _onKnowledgeExtracted(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        const kindLabel = { foreshadowing: '伏笔', verification: '现实校验', reference: '参考设定' }[ev.kind] || ev.kind;
        if (ev.kind !== 'stub') {
            toast(`${kindLabel}抽取完成：${ev.count || 0} 条`, 'success');
        }
        // 重新拉取并刷新知识库
        if (_st.activeTab === 'knowledge') _renderKnowledgeForActiveNovel();
    }

    function _onKnowledgeExtractionFailed(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        const kindLabel = { foreshadowing: '伏笔', verification: '现实校验', reference: '参考设定' }[ev.kind] || ev.kind;
        if (ev.kind !== 'stub') {
            toast(`${kindLabel}抽取失败：${ev.error || '未知错误'}`, 'error');
        }
    }

    function _onTaskArtifactUpdated(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        // 大纲/章节变更 → 刷新当前 tab（统一刷新逻辑）
        if (_st.activeTab === 'workspace' || _st.activeTab === 'artifacts' || _st.activeTab === 'knowledge') {
            _renderDetail();
        }
    }

    // ===== Phase 4-A: 故事架构事件 handlers =====
    function _onArchitectureGenerated(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast(`故事架构已生成（${ev.plotThreadCount || 0} 子线 / ${ev.foreshadowingSeedCount || 0} 伏笔种子）`, 'success');
        // 刷新当前 tab（artifacts 展示新架构；workspace 也更新最近产出区）
        if (_st.activeTab === 'artifacts' || _st.activeTab === 'workspace' || _st.activeTab === 'knowledge') {
            _renderDetail();
        }
    }

    function _onArchitectureGenerationFailed(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast(`架构生成失败：${ev.error || '未知错误'}`, 'error');
    }

    function _onArchitectureRegenerating(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast('架构重提任务已启动', 'info');
        if (_st.activeTab !== 'workspace') _switchTab('workspace');
    }

    // ===== Phase 4-B/4-C/4-D: 圣经 + 钩子事件 handlers =====
    function _onBibleCommitted(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        const retried = ev.retried ? '（重试成功）' : '';
        toast(`圣经已提交 ${retried}（rev ${ev.revision}）：${ev.characterCount || 0} 人物 / ${ev.threadCount || 0} 子线 / ${ev.foreshadowingCount || 0} 伏笔`, 'success');
        // 知识库 Tab 可见新伏笔；如果用户在 artifacts 也刷新（架构可能关联）
        if (_st.activeTab === 'knowledge' || _st.activeTab === 'artifacts') {
            _renderDetail();
        }
    }

    function _onBibleUpdateFailed(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        toast(`圣经提交失败：${ev.error || '未知错误'}`, 'error');
    }

    function _onChapterPreWriteWarnings(ev) {
        if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
        const ws = (ev.warnings || []);
        if (!ws.length) return;
        const warnCount = ws.filter(w => w.severity === 'warn').length;
        if (warnCount > 0) {
            toast(`第 ${ev.chapterId ? '?' : ''}章写作前检测到 ${warnCount} 条架构警告`, 'warn');
        }
    }

    // ============================================================
// Sprint W: 工作面板（实时时间线 + 时间倒放）
// ============================================================
const _wf = {
    events: [],            // 当前面板里的事件（ts asc）
    filters: { kind: '', agent: '', status: '' },
    autoScroll: true,      // 自动滚动到底
    userScrolledUp: false, // 用户是否手动向上滚过（暂停自动滚动直到滚回底部）
    replayMode: false,     // 是否处于"时间倒放"模式
    replayLimit: 200,
    replayLoaded: 0,       // 已加载的条数
    replayTotal: 0,        // 总条数
    agentCache: [],        // agent 列表缓存（用于过滤下拉）
    nodeByEvId: new Map(), // event_id → DOM 节点
    streamNodeByKey: new Map(), // agentName|chapterId|jobId → stream 节点 DOM（key 升级：避免并行 reviewer 互盖）
    loadingMore: false,    // 防抖：倒放加载中
    seenIds: new Set(),    // 防重复（实时 append + 历史拉取）
    lastLiveTs: 0,         // 最新事件的 ts（倒放时定位"现在"位置用）
    pendingEvents: [],     // 跨 tab 缓冲（不在 workflow tab 时累积，切回时一次性 flush）
    pendingCap: 500,       // pendingEvents 上限（避免内存爆）
};

const _WF_KIND_LABEL = {
    agent: 'agent', stream: '流式输出', phase: '阶段', overseer: '编剧',
    blackboard: '黑板', inbox: '收件箱', task: '任务图', auto: '自动写作',
    outline: '大纲', chapter: '章节', novel: '小说',
};
const _WF_STATUS_LABEL = { pending: 'pending', running: '运行中', completed: '完成', failed: '失败' };
const _WF_STATUS_COLOR = {
    running: '#3b82f6',     // 蓝
    completed: '#10b981',   // 绿
    failed: '#ef4444',      // 红
    pending: '#9ca3af',     // 灰
};

async function _renderWorkflow(r) {
    if (!$tabWorkflow) return;
    const novelId = _st.activeNovelId;
    if (!novelId) {
        $tabWorkflow.innerHTML = '<div class="novel-outline-empty"><i class="fa-regular fa-timeline"></i><p>请先选择一本小说</p></div>';
        return;
    }
    const api = window.api.ainovel;

    // agent 列表（用于过滤下拉）
    if (!_wf.agentCache.length) {
        try {
            const sr = await api.listSkills();
            _wf.agentCache = (sr && sr.ok && Array.isArray(sr.skills)) ? sr.skills : [];
        } catch (e) { _wf.agentCache = []; }
    }

    // 拉最近 100 条历史事件（desc）
    let listRes = null;
    try { listRes = await api.listWorkflowEvents(novelId, { limit: 100, offset: 0 }); }
    catch (e) { listRes = { ok: false, error: e.message || String(e) }; }
    if (!listRes || !listRes.ok) {
        $tabWorkflow.innerHTML = '<div class="novel-outline-empty"><i class="fa-solid fa-circle-exclamation"></i><p>加载失败：' + esc(listRes && listRes.error || '未知') + '</p></div>';
        return;
    }

    // 倒序拉到 → 升序排列
    _wf.events = (listRes.events || []).slice().reverse();
    // 流式节点：从 input JSON 提取 lastText 作为初始预览（这样刷新后也能看到最近的内容）
    for (const e of _wf.events) _wfExtractLastText(e);
    _wf.seenIds = new Set(_wf.events.map(e => e.id));
    if (_wf.events.length) _wf.lastLiveTs = _wf.events[_wf.events.length - 1].ts;

    // 拉统计
    let stats = null;
    try { stats = await api.getWorkflowStats(novelId); } catch (e) { /* best effort */ }
    const totalCount = (stats && stats.tsRange && stats.tsRange.total) || listRes.total || _wf.events.length;

    $tabWorkflow.innerHTML = `
        <div class="novel-wf-toolbar">
            <label class="novel-wf-toggle" title="新事件出现时自动滚动到底">
                <input type="checkbox" id="novelWfAutoScroll" ${_wf.autoScroll ? 'checked' : ''}>
                <i class="fa-solid fa-arrow-down"></i> 自动滚动
            </label>
            <label class="novel-wf-filter">
                <span>类型</span>
                <select id="novelWfFilterKind">
                    <option value="">全部</option>
                    ${Object.keys(_WF_KIND_LABEL).map(k => `<option value="${esc(k)}" ${_wf.filters.kind === k ? 'selected' : ''}>${esc(_WF_KIND_LABEL[k])}</option>`).join('')}
                </select>
            </label>
            <label class="novel-wf-filter">
                <span>Agent</span>
                <select id="novelWfFilterAgent">
                    <option value="">全部</option>
                    ${_wf.agentCache.map(a => `<option value="${esc(a.name)}" ${_wf.filters.agent === a.name ? 'selected' : ''}>${esc(a.displayName || a.name)}</option>`).join('')}
                </select>
            </label>
            <label class="novel-wf-filter">
                <span>状态</span>
                <select id="novelWfFilterStatus">
                    <option value="">全部</option>
                    <option value="running" ${_wf.filters.status === 'running' ? 'selected' : ''}>运行中</option>
                    <option value="completed" ${_wf.filters.status === 'completed' ? 'selected' : ''}>完成</option>
                    <option value="failed" ${_wf.filters.status === 'failed' ? 'selected' : ''}>失败</option>
                </select>
            </label>
            <span class="novel-wf-count">${totalCount} 条事件</span>
            <div class="novel-wf-toolbar-right">
                <button class="btn btn-sm" type="button" id="novelWfBtnReplay" title="从头开始按时间顺序回放"><i class="fa-solid fa-backward"></i> 时间倒放</button>
                <button class="btn btn-sm" type="button" id="novelWfBtnRefresh" title="刷新"><i class="fa-solid fa-rotate"></i> 刷新</button>
            </div>
        </div>
        <div id="novelWfReplayBanner" class="novel-wf-replay-banner" hidden>
            <i class="fa-solid fa-backward"></i> 倒放模式 · 已加载 ${_wf.replayLoaded} / ${_wf.replayTotal} 条 · 向上滚动加载更早的事件
            <button class="btn btn-sm" type="button" id="novelWfBtnExitReplay"><i class="fa-solid fa-xmark"></i> 回到实时</button>
        </div>
        <div class="novel-wf-timeline" id="novelWfTimeline">
            <div class="novel-wf-empty-line"></div>
            ${_wf.events.map(_wfRenderNodeHTML).join('')}
            <div class="novel-wf-empty-line"></div>
        </div>`;

    // 节点 → DOM 缓存
    _wfRebuildNodeCache();
    _wfApplyFiltersClient();

    // 工具栏交互
    document.getElementById('novelWfAutoScroll').addEventListener('change', (e) => {
        _wf.autoScroll = e.target.checked;
        _wf.userScrolledUp = false;
    });
    ['novelWfFilterKind', 'novelWfFilterAgent', 'novelWfFilterStatus'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            _wf.filters.kind = document.getElementById('novelWfFilterKind').value;
            _wf.filters.agent = document.getElementById('novelWfFilterAgent').value;
            _wf.filters.status = document.getElementById('novelWfFilterStatus').value;
            _wfApplyFiltersClient();
        });
    });
    document.getElementById('novelWfBtnRefresh').addEventListener('click', () => _renderWorkflow(r));
    document.getElementById('novelWfBtnReplay').addEventListener('click', () => _wfStartReplay(novelId, r));
    const $exitReplay = document.getElementById('novelWfBtnExitReplay');
    if ($exitReplay) $exitReplay.addEventListener('click', () => _wfExitReplay(r));

    // 节点展开
    _wfBindNodeClicks();

    // 滚动监听（用户手动向上滚 → 暂停自动滚动）
    const $tl = document.getElementById('novelWfTimeline');
    if ($tl) {
        $tl.addEventListener('scroll', () => {
            if (_wf.replayMode) return;  // 倒放模式由自己的加载触发器管
            const fromBottom = $tl.scrollHeight - $tl.scrollTop - $tl.clientHeight;
            _wf.userScrolledUp = fromBottom > 80;
            // 向上滚动到底（最早事件）→ 提示可以加载更早的
            if ($tl.scrollTop < 100 && _wf.events.length >= 100 && !_wf.loadingMore) {
                _wfLoadOlderHistory(novelId, r);
            }
        });
    }

    // 初始：自动滚到底
    if (_wf.autoScroll) requestAnimationFrame(() => $tl && ($tl.scrollTop = $tl.scrollHeight));
}

// 渲染单个事件为 HTML（不绑事件，事件统一在 _wfBindNodeClicks 里挂）
// 从 event 中提取要直接显示的文字内容（input/output/payload 字段的智能提取）
function _wfExtractText(ev) {
    if (!ev) return { text: '', cls: '' };
    // 1) 失败：error 优先显示
    if (ev.error) return { text: String(ev.error), cls: 'is-error' };
    // 2) 流式节点（kind=stream 或 kind=agent 且有累积 _lastText）：直接从 ev._lastText 取
    if (ev._lastText != null && String(ev._lastText).length > 0) {
        return { text: String(ev._lastText), cls: '' };
    }
    // 3) 解析 output（可能是 JSON 字符串或对象）
    const parse = (s) => { if (!s) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch (e) { return null; } };
    const out = parse(ev.output);
    if (out) {
        if (typeof out === 'string') return { text: out, cls: '' };
        // 常见字段：text / content / answer / markdown
        const t = out.text || out.content || out.answer || out.markdown || out.body;
        if (typeof t === 'string' && t.length > 0) return { text: t, cls: '' };
    }
    // 4) 解析 payload（fallback，事件级 payload 可能有 text/value 等）
    const pay = parse(ev.payload);
    if (pay) {
        if (typeof pay === 'string') return { text: pay, cls: '' };
        const t = pay.text || pay.value || pay.description || pay.subject || pay.reason || pay.note;
        if (typeof t === 'string' && t.length > 0) return { text: t, cls: '' };
    }
    // 5) running 状态 + agent_started：显示摘要作占位
    if (ev.status === 'running') {
        return { text: '', cls: 'is-hint' };  // 空 + hint 样式
    }
    return { text: '', cls: '' };
}

// 渲染单个事件为 HTML（极简两段式：dot + body，body 内只有 agent 名 + 纯文字正文，无任何 chrome）
// Sprint W 重构：去掉所有 meta 行（time/phase/dur/char-count/status-pill），只留 [dot] [agent-name] [text]
function _wfRenderNodeHTML(ev) {
    // 过滤：没 agent 没文字 又不是 running 的"噪音"行直接跳过
    // （例如 overseer_decided 无 agent、phase_started 无 agent、blackboard_written 无 text — 都不渲染）
    const hasAgent = !!(ev.agent && String(ev.agent).trim());
    const extracted = _wfExtractText(ev);
    const initialText = extracted.text || '';
    const isRunning = ev.status === 'running';
    if (!initialText && !hasAgent && !isRunning) return '';

    const kindClass = `novel-wf-kind-${esc(ev.kind || 'other')}`;
    const agentName = ev.agent || '—';
    const textCls = extracted.cls ? ` ${extracted.cls}` : '';

    // 极简节点：dot + body(body = agent 名 + 文字)。无任何背景/边框/阴影。
    const textBlock = `<div class="novel-wf-text${textCls}" data-stream-text>${esc(initialText)}</div>`;

    return `
        <div class="novel-wf-node novel-wf-status-${esc(ev.status || 'pending')} ${kindClass}" data-ev-id="${esc(ev.id)}" data-ev-agent="${esc(ev.agent || '')}" data-ev-status="${esc(ev.status || '')}" data-ev-kind="${esc(ev.kind || '')}">
            <div class="novel-wf-dot"></div>
            <div class="novel-wf-body">
                <div class="novel-wf-head">
                    <span class="novel-wf-agent" data-agent="${esc(agentName)}">${esc(agentName)}</span>
                </div>
                ${textBlock}
            </div>
        </div>`;
}

// 从 input JSON 提取 lastText（流式节点的最近累积文本），渲染端用
// 适用于 kind=stream（旧 chapter-writer 流式事件）+ kind=agent（新 agent_chunk 累积的事件）
function _wfExtractLastText(ev) {
    if (!ev || !ev.input || ev._lastText != null) return;
    if (ev.kind !== 'stream' && ev.kind !== 'agent') return;
    try {
        const inp = typeof ev.input === 'string' ? JSON.parse(ev.input) : ev.input;
        if (inp && typeof inp.lastText === 'string') ev._lastText = inp.lastText;
    } catch (e) { /* ignore */ }
}

// 节点 → DOM 缓存（stream running 节点复用）
function _wfRebuildNodeCache() {
    _wf.nodeByEvId.clear();
    _wf.streamNodeByKey.clear();
    document.querySelectorAll('#novelWfTimeline .novel-wf-node').forEach(node => {
        const id = node.dataset.evId;
        if (id) _wf.nodeByEvId.set(id, node);
    });
}

function _wfApplyFiltersClient() {
    const nodes = document.querySelectorAll('#novelWfTimeline .novel-wf-node');
    let visible = 0;
    nodes.forEach(node => {
        const ok =
            (!_wf.filters.kind || node.dataset.evKind === _wf.filters.kind) &&
            (!_wf.filters.agent || node.dataset.evAgent === _wf.filters.agent) &&
            (!_wf.filters.status || node.dataset.evStatus === _wf.filters.status);
        node.style.display = ok ? '' : 'none';
        if (ok) visible++;
    });
    const $count = document.querySelector('.novel-wf-count');
    if ($count) $count.textContent = visible + ' / ' + _wf.events.length + ' 条事件';
}

// 节点点击绑定 — 已废弃（不再有 expand 按钮，所有内容直接展开显示）
// 保留空函数以兼容旧调用点
function _wfBindNodeClicks() {
    /* no-op: input/output 已经直接渲染在工作面板里，不需要点击展开 */
}

// 全局事件 → 工作面板（实时）
// Sprint W 重构：按事件类型分发到 4 个 handler（agent_started/chunk/finished/failed）
// 每个 agent 一次运行 = 一个节点；in-place UPDATE 不重新查询 DB
function _wfOnEvent(evType, ev) {
    if (!_st.activeNovelId || ev.novelId !== _st.activeNovelId) return;
    if (_wf.replayMode) return;        // 倒放模式不接收实时事件

    // 跨 tab 缓冲：如果不在 workflow tab，存到 pendingEvents，等切回来时一次性 flush
    if (_st.activeTab !== 'workflow') {
        _wf.pendingEvents.push({ evType, ev, ts: Date.now() });
        if (_wf.pendingEvents.length > _wf.pendingCap) _wf.pendingEvents.shift();
        return;
    }

    switch (evType) {
        case 'agent_started':
            _wfHandleAgentStarted(ev);
            break;
        case 'agent_chunk':
        case 'stream':                  // 兼容旧的 'stream' 事件（chapter-writer 老路径）
            _wfHandleAgentChunk(ev);
            break;
        case 'agent_finished':
            _wfHandleAgentFinished(ev);
            break;
        case 'agent_failed':
            _wfHandleAgentFailed(ev);
            break;
        // overseer / blackboard / inbox / task 等其他事件类型暂不渲染到工作面板
        default:
            break;
    }
}

// agent_started：创建一个新节点（status=running），用 agentName|chapterId|jobId 作为 key
function _wfHandleAgentStarted(ev) {
    const agentName = ev.agentName || ev.agent || ev.skill || '—';
    const key = _wfKeyFor(ev);
    // 同一个 key 已经存在 running 节点 → 防御（避免重复 created）
    if (_wf.streamNodeByKey.has(key)) return;

    // 用与 engine 一致的 id 格式（_wfIdFor 生成的 wf-novelId-agentName-jobId-run），
    // 这样 live stub 与 DB 行 id 相同，跨刷新 / 跨 tab 切换都能去重（同一行只显示一次）
    const stableId = ev.id || `wf-${ev.novelId}-${agentName}-${ev.jobId || 'run'}-run`;
    const stub = {
        id: stableId,
        novel_id: ev.novelId,
        ts: Math.floor((ev.startedAt || Date.now()) / 1000),
        kind: 'agent',
        agent: agentName,
        phase: ev.phase || ev.phaseName || null,
        status: 'running',
        summary: agentName,
        parent_id: null,
        duration_ms: null,
        error: null,
    };
    const $node = _wfAppendNodeHTML(stub);
    if ($node) {
        _wf.streamNodeByKey.set(key, $node);
        _wf.nodeByEvId.set(stub.id, $node);
        $node._streamText = '';
    }
}

// agent_chunk / stream：in-place 更新文字（不查 DB，不重建节点）
function _wfHandleAgentChunk(ev) {
    const key = _wfKeyFor(ev);
    let $node = _wf.streamNodeByKey.get(key);
    if (!$node) {
        // 防御：没看到 agent_started 就来 chunk — 补建一个 stub
        _wfHandleAgentStarted(ev);
        $node = _wf.streamNodeByKey.get(key);
    }
    if (!$node) return;
    _wfUpdateStreamNode($node, ev);
}

// agent_finished：把 running 节点标记为 completed，定格文字
function _wfHandleAgentFinished(ev) {
    const key = _wfKeyFor(ev);
    const $node = _wf.streamNodeByKey.get(key);
    if (!$node) {
        // 没有 running 节点 → 防御建一个 completed 节点
        _wfHandleAgentStarted(ev);
    }
    const $n = _wf.streamNodeByKey.get(key);
    if (!$n) return;

    // 最终文字：优先 ev.output.text/_wfExtractFinalText，其次 $n._streamText（流式累积）
    const finalText = _wfExtractFinalText(ev) || $n._streamText || '';
    const $txt = $n.querySelector('[data-stream-text]');
    if ($txt) {
        if ($txt._lastRenderedText !== finalText) {
            $txt.textContent = finalText;
            $txt._lastRenderedText = finalText;
        }
        // completed 时移除 error / hint class
        $txt.classList.remove('is-error', 'is-hint');
    }

    // 状态：running → completed
    $n.dataset.evStatus = 'completed';
    $n.classList.remove('novel-wf-status-running');
    $n.classList.add('novel-wf-status-completed');
    const $dot = $n.querySelector('.novel-wf-dot');
    if ($dot) $dot.classList.add('novel-wf-dot-completed');
    // 关闭闪烁光标动画（如果 CSS 是依赖 ::after，可通过移除 status class 关掉）
}

// agent_failed：把 running 节点标记为 failed + 显示 error 文字
function _wfHandleAgentFailed(ev) {
    const key = _wfKeyFor(ev);
    let $node = _wf.streamNodeByKey.get(key);
    if (!$node) {
        _wfHandleAgentStarted(ev);
        $node = _wf.streamNodeByKey.get(key);
    }
    if (!$node) return;

    const errText = (ev && ev.error) ? String(ev.error) : 'agent 调用失败';
    const $txt = $node.querySelector('[data-stream-text]');
    if ($txt) {
        $txt.textContent = errText;
        $txt._lastRenderedText = errText;
        $txt.classList.add('is-error');
        $txt.classList.remove('is-hint');
    }
    $node.dataset.evStatus = 'failed';
    $node.classList.remove('novel-wf-status-running');
    $node.classList.add('novel-wf-status-failed');
    const $dot = $node.querySelector('.novel-wf-dot');
    if ($dot) $dot.classList.add('novel-wf-dot-failed');
}

// key 生成：agentName|chapterId|jobId（包含 agentName 是关键，避免并行 reviewer 互相覆盖）
function _wfKeyFor(ev) {
    const agent = ev.agentName || ev.agent || ev.skill || '?';
    return `${agent}|${ev.chapterId || ev.chapterNo || ''}|${ev.jobId || ''}`;
}

// 从 ev.output 智能提取最终文字（fallback 到 ev._streamText）
function _wfExtractFinalText(ev) {
    if (!ev) return '';
    const parse = (s) => { if (!s) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch (e) { return null; } };
    const out = parse(ev.output);
    if (out) {
        if (typeof out === 'string') return out;
        const t = out.text || out.content || out.answer || out.markdown || out.body;
        if (typeof t === 'string' && t.length > 0) return t;
    }
    return '';
}

// 切到 workflow tab 时一次性 flush pending 事件（避免切换期间事件丢失）
function _wfFlushPending() {
    if (!_wf.pendingEvents.length) return;
    // 复制并清空，避免在 handler 里又 push 形成递归
    const pending = _wf.pendingEvents.slice();
    _wf.pendingEvents = [];
    for (const { evType, ev } of pending) {
        try { _wfOnEvent(evType, ev); } catch (e) { /* best effort */ }
    }
}

// 追加一个新节点到时间线末尾
// 防御：如果 DOM 里已有同 id 的节点（live event 与历史行同 id，或重复 emit），直接返回旧的、不重复插入
function _wfAppendNodeHTML(ev) {
    const $tl = document.getElementById('novelWfTimeline');
    if (!$tl) return null;
    // 先查重：同 id 已存在 → 复用旧的（避免重复插入导致两个相同 id 的节点）
    const sel = `.novel-wf-node[data-ev-id="${CSS.escape(ev.id)}"]`;
    let $newNode = $tl.querySelector(sel);
    if ($newNode) {
        // 同步 dataset 字段（live event 可能更新 agent/status/kind 等）
        $newNode.dataset.evAgent = ev.agent || '';
        $newNode.dataset.evStatus = ev.status || '';
        $newNode.dataset.evKind = ev.kind || '';
        _wf.nodeByEvId.set(ev.id, $newNode);
        return $newNode;
    }
    const html = _wfRenderNodeHTML(ev);
    if (!html) return null;  // 噪音行（无 agent 无文字 非 running）→ 不渲染
    // 插入到 .novel-wf-empty-line（最末）之前
    const $lastEmpty = $tl.querySelector('.novel-wf-empty-line:last-child');
    if ($lastEmpty) {
        $lastEmpty.insertAdjacentHTML('beforebegin', html);
    } else {
        $tl.insertAdjacentHTML('beforeend', html);
    }
    $newNode = $tl.querySelector(sel);
    if ($newNode) {
        _wf.nodeByEvId.set(ev.id, $newNode);
        // 节点加进入场动画 + 应用过滤
        $newNode.classList.add('novel-wf-node-enter');
        if (!_wfPassFilter($newNode)) $newNode.style.display = 'none';
    }
    _wfMaybeAutoScroll();
    return $newNode;
}

function _wfPassFilter($node) {
    return (!_wf.filters.kind || $node.dataset.evKind === _wf.filters.kind)
        && (!_wf.filters.agent || $node.dataset.evAgent === _wf.filters.agent)
        && (!_wf.filters.status || $node.dataset.evStatus === _wf.filters.status);
}

// 增量更新流式节点（in-place）
let _wfStreamUpdateRaf = null;
const _wfStreamPending = new Map(); // node → 最新 ev
function _wfUpdateStreamNode($node, ev) {
    _wfStreamPending.set($node, ev);
    if (_wfStreamUpdateRaf) return;
    _wfStreamUpdateRaf = requestAnimationFrame(() => {
        _wfStreamUpdateRaf = null;
        for (const [n, e] of _wfStreamPending) {
            // 优先用 ev.accumulated（_makeChunkEmitter 透传的全文）；fallback 用 chunk delta 拼
            const fullText = (e.accumulated != null)
                ? String(e.accumulated)
                : ((n._streamText || '') + (e.chunk && (e.chunk.delta || e.chunk.text) || ''));
            n._streamText = fullText;
            const acc = fullText.length;
            n._streamAccum = acc;

            // 把累积全文直接铺到正文区（纯文字，chat-like）
            const $prev = n.querySelector('[data-stream-text]');
            if ($prev) {
                // 节流：如果跟上次一样就跳过（避免重复 textContent 设置）
                if ($prev._lastRenderedText !== fullText) {
                    $prev.textContent = fullText;
                    $prev._lastRenderedText = fullText;
                    // 自动滚到最新内容（仅当滚动条已经在底部时）
                    const nearBottom = $prev.scrollHeight - $prev.scrollTop - $prev.clientHeight < 40;
                    if (nearBottom) $prev.scrollTop = $prev.scrollHeight;
                }
            }
            // meta 行字数同步
            const $cnt = n.querySelector('[data-stream-count]');
            if ($cnt && $cnt.textContent !== `${acc} 字`) $cnt.textContent = acc > 0 ? `${acc} 字` : '';

            n.classList.remove('novel-wf-node-flash');
            void n.offsetWidth;
            n.classList.add('novel-wf-node-flash');
        }
        _wfStreamPending.clear();
        _wfMaybeAutoScroll();
    });
}

// 自动滚动到底（除非用户在向上看）
function _wfMaybeAutoScroll() {
    if (!_wf.autoScroll || _wf.userScrolledUp || _wf.replayMode) return;
    const $tl = document.getElementById('novelWfTimeline');
    if (!$tl) return;
    requestAnimationFrame(() => { $tl.scrollTop = $tl.scrollHeight; });
}

// 加载更早的历史（用户向上滚到底时触发）
async function _wfLoadOlderHistory(novelId, r) {
    if (_wf.loadingMore || _wf.replayMode) return;
    _wf.loadingMore = true;
    try {
        const listRes = await window.api.ainovel.listWorkflowEvents(novelId, { limit: 100, offset: _wf.events.length });
        if (listRes && listRes.ok && listRes.events && listRes.events.length) {
            // listWorkflowEvents 返回 desc；反转成 asc 并检查去重
            const older = listRes.events.slice().reverse();
            let added = 0;
            for (const e of older) {
                if (_wf.seenIds.has(e.id)) continue;
                _wfExtractLastText(e);
                _wf.seenIds.add(e.id);
                _wf.events.unshift(e);
                added++;
            }
            if (added > 0) {
                // 顶部插入
                const $tl = document.getElementById('novelWfTimeline');
                const $first = $tl.querySelector('.novel-wf-node');
                const html = older.slice(0, added).map(_wfRenderNodeHTML).reverse().join('');
                if ($first) $first.insertAdjacentHTML('beforebegin', html);
                else $tl.insertAdjacentHTML('afterbegin', html);
                _wfRebuildNodeCache();
                _wfApplyFiltersClient();
                _wfBindNodeClicks();
            }
        }
    } catch (e) { /* best effort */ }
    finally { _wf.loadingMore = false; }
}

// 时间倒放
async function _wfStartReplay(novelId, r) {
    _wf.replayMode = true;
    _wf.replayLoaded = 0;
    _wf.replayTotal = 0;
    // 先拉总数
    try {
        const stats = await window.api.ainovel.getWorkflowStats(novelId);
        _wf.replayTotal = (stats && stats.tsRange && stats.tsRange.total) || 0;
    } catch (e) { _wf.replayTotal = 0; }
    // 拉最早的一批（ts asc, offset=0）
    const res = await window.api.ainovel.listWorkflowReplay(novelId, { limit: _wf.replayLimit, offset: 0 });
    if (!res || !res.ok) {
        _wf.replayMode = false;
        toast('倒放加载失败：' + ((res && res.error) || '未知'), 'error');
        return;
    }
    _wf.events = (res.events || []).slice();
    for (const e of _wf.events) _wfExtractLastText(e);
    _wf.seenIds = new Set(_wf.events.map(e => e.id));
    _wf.replayLoaded = _wf.events.length;
    _wfRenderWorkflowReplayed(r);
    toast(`已加载 ${_wf.replayLoaded} 条最早事件，向上滚动加载更早的`, 'info');
}

// 倒放模式加载更早
async function _wfLoadMoreReplay(novelId, r) {
    if (_wf.loadingMore || !_wf.replayMode) return;
    _wf.loadingMore = true;
    try {
        const res = await window.api.ainovel.listWorkflowReplay(novelId, {
            limit: _wf.replayLimit,
            offset: _wf.replayLoaded,
        });
        if (res && res.ok && res.events && res.events.length) {
            const added = res.events.filter(e => !_wf.seenIds.has(e.id));
            for (const e of added) { _wfExtractLastText(e); _wf.seenIds.add(e.id); }
            _wf.events.push(...added);
            _wf.replayLoaded = _wf.events.length;
            // 追加到时间线
            const $tl = document.getElementById('novelWfTimeline');
            const $lastEmpty = $tl.querySelector('.novel-wf-empty-line:last-child');
            const html = added.map(_wfRenderNodeHTML).join('');
            if ($lastEmpty) $lastEmpty.insertAdjacentHTML('beforebegin', html);
            else $tl.insertAdjacentHTML('beforeend', html);
            _wfRebuildNodeCache();
            _wfApplyFiltersClient();
            _wfBindNodeClicks();
            // 顶部 banner 更新
            const $banner = document.getElementById('novelWfReplayBanner');
            if ($banner) $banner.innerHTML = `<i class="fa-solid fa-backward"></i> 倒放模式 · 已加载 ${_wf.replayLoaded} / ${_wf.replayTotal} 条 · 向上滚动加载更早的事件 <button class="btn btn-sm" type="button" id="novelWfBtnExitReplay"><i class="fa-solid fa-xmark"></i> 回到实时</button>`;
            const $exit = document.getElementById('novelWfBtnExitReplay');
            if ($exit) $exit.addEventListener('click', () => _wfExitReplay(r));
        } else {
            toast('已加载全部历史事件', 'info');
        }
    } catch (e) { /* best effort */ }
    finally { _wf.loadingMore = false; }
}

function _wfRenderWorkflowReplayed(r) {
    if (!$tabWorkflow) return;
    $tabWorkflow.innerHTML = `
        <div class="novel-wf-toolbar">
            <label class="novel-wf-toggle">
                <input type="checkbox" disabled>
                <i class="fa-solid fa-arrow-down"></i> 自动滚动（倒放模式禁用）
            </label>
            <span class="novel-wf-count">${_wf.replayLoaded} / ${_wf.replayTotal} 条（最早到最新）</span>
            <div class="novel-wf-toolbar-right">
                <button class="btn btn-sm" type="button" id="novelWfBtnExitReplay"><i class="fa-solid fa-xmark"></i> 回到实时</button>
            </div>
        </div>
        <div class="novel-wf-replay-banner">
            <i class="fa-solid fa-backward"></i> 倒放模式 · 已加载 ${_wf.replayLoaded} / ${_wf.replayTotal} 条 · 向上滚动加载更早的事件
        </div>
        <div class="novel-wf-timeline" id="novelWfTimeline">
            <div class="novel-wf-empty-line"></div>
            ${_wf.events.map(_wfRenderNodeHTML).join('')}
            <div class="novel-wf-empty-line"></div>
        </div>`;
    _wfRebuildNodeCache();
    _wfBindNodeClicks();
    const $tl = document.getElementById('novelWfTimeline');
    if ($tl) {
        $tl.scrollTop = 0;  // 倒放起点是最早事件
        $tl.addEventListener('scroll', () => {
            if ($tl.scrollTop < 100 && _wf.replayLoaded < _wf.replayTotal && !_wf.loadingMore) {
                _wfLoadMoreReplay(_st.activeNovelId, r);
            }
        });
    }
    const $exit = document.getElementById('novelWfBtnExitReplay');
    if ($exit) $exit.addEventListener('click', () => _wfExitReplay(r));
}

function _wfExitReplay(r) {
    _wf.replayMode = false;
    _renderWorkflow(r);
    toast('已回到实时模式', 'success');
}

// ===== Export API =====
    window.novel = {
        open,
        close,
        isOpen,
        renderIntoSettings,
        // expose for testing / external
        _state: _st,
    };
})();