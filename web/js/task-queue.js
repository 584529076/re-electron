// web/js/task-queue.js
// D-QUEUE：任务队列浮层 UI
//
// 提供：
//   window.taskQueue.open() / close() / toggle()
//   - 角标点击 → 切抽屉
//   - 任务卡（pending/running/done/failed/cancelled 5 态）
//   - 拖拽 pending 重排
//   - 缩略图点开看大图
//   - 取消 / 删除 / 全清已完成
//
// 依赖：
//   window.api.taskQueue.* （preload.js 暴露）
//   window.dUtil.escapeHtml/escapeAttr （util/path.js）
//   window.showToast （script.js 全局函数）

(function () {
    'use strict';

    const esc = (s) => (window.dUtil && window.dUtil.escapeHtml) ? window.dUtil.escapeHtml(s) : String(s == null ? '' : s);

    // ===== 状态 =====
    const _st = {
        items: [],         // [{ queue_id, status, ...row }]
        pendingRanks: {},  // queueId → 0-based 位置（用于显示「第 N 位」）
        open: false,
    };
    // D-QUEUE-FIX-FLASH：跨 refresh 持久化的「已加载缩略图」缓存。
    // _st.items 每次 refresh 都会被整体替换（_thumbLoading 这种挂在 item 上的标志会丢），
    // 之前就会重复发起 resultReadAsDataUrl + replaceChild，导致已显示好的 <img> 被替换成新元素
    // 重新解码一次，肉眼看到一闪。改成 Map 后，refresh 多少次都不会重复拉同一张卡的缩略图。
    // 任务被删除时由 _optimisticRemove / 'removed' 事件清理。
    const _loadedThumbs = new Map(); // queueId -> { result_path, result_text }

    // ===== DOM 引用（init 时一次性拿） =====
    let $btn = null;        // #navTaskQueue
    let $badge = null;     // .nav-task-text（pill 内的「任务 N」文字）
    let $drawer = null;    // #taskQueueDrawer
    let $list = null;      // #taskQueueList
    let $count = null;     // .task-drawer-count
    let $closeBtn = null;  // #taskCloseBtn
    let $clearBtn = null;  // #taskClearDoneBtn
    let $progress = null;  // #taskQueueTotalProgress
    let $progressBar = null;
    let $progressText = null;
    let $previewOverlay = null;

    function _initDom() {
        if ($btn) return; // 已 init
        $btn = document.getElementById('navTaskQueue');
        $badge = $btn && $btn.querySelector('.nav-task-text');
        $drawer = document.getElementById('taskQueueDrawer');
        $list = document.getElementById('taskQueueList');
        $count = $drawer && $drawer.querySelector('.task-drawer-count');
        $closeBtn = document.getElementById('taskCloseBtn');
        $clearBtn = document.getElementById('taskClearDoneBtn');
        $progress = document.getElementById('taskQueueTotalProgress');
        $progressBar = $progress && $progress.querySelector('.task-drawer-progress-bar-fill');
        $progressText = $progress && $progress.querySelector('.task-drawer-progress-text');

        // 角标点击 → toggle 抽屉
        if ($btn) {
            $btn.addEventListener('click', () => {
                toggle();
            });
        }
        if ($closeBtn) $closeBtn.addEventListener('click', close);
        if ($clearBtn) $clearBtn.addEventListener('click', clearDone);

        // 大图预览浮层（只创建一次）
        if (!document.getElementById('taskPreviewOverlay')) {
            const ov = document.createElement('div');
            ov.id = 'taskPreviewOverlay';
            ov.className = 'task-preview-overlay';
            ov.setAttribute('role', 'dialog');
            ov.setAttribute('aria-label', '任务结果预览');
            document.body.appendChild(ov);
            ov.addEventListener('click', (e) => {
                // 点击背景关闭
                if (e.target === ov) closePreview();
            });
            $previewOverlay = ov;
        } else {
            $previewOverlay = document.getElementById('taskPreviewOverlay');
        }
        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if ($previewOverlay && $previewOverlay.classList.contains('open')) {
                    closePreview();
                } else if (_st.open) {
                    close();
                }
            }
        });
    }

    // ===== 列表拉取 & 重排 =====
    async function refresh() {
        try {
            const r = await window.api.taskQueue.list({ limit: 200 });
            if (!r || !r.ok) return;
            _st.items = (r.items || []).slice();
            // D-QUEUE-FIX-FLASH：清理 _loadedThumbs 中已被删除的任务（list 里不再出现），
            // 避免 Map 无限增长。保留仍在列表里的项。
            if (_loadedThumbs.size) {
                const liveIds = new Set(_st.items.map(it => it.queue_id));
                for (const qid of _loadedThumbs.keys()) {
                    if (!liveIds.has(qid)) _loadedThumbs.delete(qid);
                }
            }
            // 计算 pending 位置（按 enqueued_at ASC，越早越前）
            _st.pendingRanks = {};
            let rank = 0;
            for (const it of _st.items) {
                if (it.status === 'pending') {
                    _st.pendingRanks[it.queue_id] = rank++;
                }
            }
            updateBadge();
            if (_st.open) render();
        } catch (e) {
            console.warn('[task-queue] refresh failed:', e.message);
        }
    }

    function updateBadge() {
        if (!$btn) return;
        const active = _st.items.filter(it => it.status === 'pending' || it.status === 'running').length;
        const running = _st.items.some(it => it.status === 'running');
        // 文字「任务 N」—— >99 显示 99+
        if ($badge) $badge.textContent = '任务 ' + (active > 99 ? '99+' : String(active));
        // 4 态配色：
        //   - 0 任务 → idle（灰）
        //   - >0 无 running → pending（蓝紫）
        //   - 有 running → running（琥珀 + 脉冲）
        $btn.classList.remove('nav-task-status-idle', 'nav-task-status-pending', 'nav-task-status-running');
        if (active <= 0) {
            $btn.classList.add('nav-task-status-idle');
        } else if (running) {
            $btn.classList.add('nav-task-status-running');
        } else {
            $btn.classList.add('nav-task-status-pending');
        }
        // 抽屉开关 → 高亮描边（与 idle/pending/running 本体配色叠加）
        if (_st.open) $btn.classList.add('active');
        else $btn.classList.remove('active');
    }

    // ===== 抽屉开关 =====
    function open() {
        if (!$drawer) _initDom();
        $drawer.classList.add('task-drawer-open');
        _st.open = true;
        updateBadge();
        render();
    }
    function close() {
        if (!$drawer) return;
        $drawer.classList.remove('task-drawer-open');
        _st.open = false;
        updateBadge();
    }
    function toggle() {
        if (_st.open) close(); else open();
    }

    // ===== 渲染列表 =====
    function render() {
        if (!$list || !$count) return;
        if (!_st.items.length) {
            $list.innerHTML = `
                <div class="task-drawer-empty">
                    <i class="fa-regular fa-clipboard" aria-hidden="true"></i>
                    暂无任务。在工作台点击「立即生成」会出现在这里。
                </div>`;
            $count.textContent = '0';
            if ($progress) $progress.hidden = true;
            return;
        }
        // 排序：running 第一 → pending 按 position ASC → 其余 enqueued_at DESC
        const items = _st.items.slice().sort((a, b) => {
            const order = (s) => ({ running: 0, pending: 1, done: 2, failed: 3, cancelled: 4 }[s] != null
                ? { running: 0, pending: 1, done: 2, failed: 3, cancelled: 4 }[s] : 5);
            const ra = order(a.status), rb = order(b.status);
            if (ra !== rb) return ra - rb;
            if (a.status === 'pending') return (a.position - b.position);
            return (b.enqueued_at - a.enqueued_at);
        });

        // 总进度（running 显示一个 indeterminate 横条；prompt_id 已知时给个静态估算）
        const total = items.filter(i => i.status !== 'cancelled').length;
        const done = items.filter(i => i.status === 'done').length;
        if ($progress && $progressBar && $progressText) {
            const running = items.filter(i => i.status === 'running').length;
            if (running > 0) {
                $progress.hidden = false;
                // 没具体 progress 数值时给个 indeterminate —— bar 用特殊 class
                $progressBar.classList.add('task-card-progress-undetermined');
                $progressBar.style.width = '';
                const pct = total ? Math.round((done / total) * 100) : 0;
                $progressText.textContent = `${done}/${total}`;
            } else {
                $progress.hidden = true;
                $progressBar.classList.remove('task-card-progress-undetermined');
            }
        }
        $count.textContent = String(items.length);

        $list.innerHTML = items.map(_cardHtml).join('');
        _bindCardEvents();
        _lazyLoadThumbs();
    }

    function _cardHtml(it) {
        const status = it.status || 'pending';
        // D-QUEUE-FIX-THUMB-REFRESH：list IPC 不再返 result_path（避免 payload 过重），
        // refresh 之后 _st.items 是新对象，it.result_path 又是 null。如果 _loadedThumbs 已缓存该 qid 的 dataUrl，
        // 把它回填到 it 上，保证 _thumbHtml() 直接渲染 <img> 而非占位 —— 否则第二次 render 会陷入
        // 「_loadedThumbs 已有 → 不发 IPC → placeholder 不替换」的循环。
        if (status === 'done' && _loadedThumbs.has(it.queue_id)) {
            const cached = _loadedThumbs.get(it.queue_id);
            if (cached.result_path) it.result_path = cached.result_path;
            if (cached.result_text) it.result_text = cached.result_text;
        }
        const cardClass = `task-card task-card-${status}${status === 'pending' ? ' task-card-draggable' : ''}`;
        const badge = _statusBadgeHtml(status);
        const isPending = status === 'pending';
        const rank = isPending ? (_st.pendingRanks[it.queue_id] || 0) : null;
        const rankHtml = (isPending && rank > 0)
            ? `<span class="task-status-badge task-status-pending" title="队列位置"><i class="fa-solid fa-hourglass-half"></i> 第 ${rank + 1} 位</span>`
            : '';
        const meta = _formatMeta(it);
        const errorHtml = (status === 'failed' && it.error_msg)
            ? `<div class="task-card-meta task-card-meta-error">${esc(it.error_msg)}</div>`
            : '';
        const timeStr = _formatTime(it);
        const thumb = _thumbHtml(it);
        const cancelable = isPending || status === 'running';
        const removable = status === 'done' || status === 'failed' || status === 'cancelled';
        const actionsHtml = `
            <div class="task-card-actions">
                ${cancelable ? `<button class="task-card-action task-card-action-danger" data-act="cancel" data-qid="${esc(it.queue_id)}" title="取消"><i class="fa-solid fa-xmark"></i></button>` : ''}
                ${removable ? `<button class="task-card-action task-card-action-danger" data-act="remove" data-qid="${esc(it.queue_id)}" title="删除"><i class="fa-solid fa-trash"></i></button>` : ''}
            </div>`;
        const dragHandle = isPending
            ? `<span class="task-card-drag-handle" data-qid="${esc(it.queue_id)}" title="拖动排序"><i class="fa-solid fa-grip-vertical"></i></span>`
            : '';
        const progressHtml = status === 'running'
            ? `<div class="task-card-progress" hidden><span class="task-card-progress-bar task-card-progress-undetermined"></span></div>`
            : '';
        return `
            <div class="${cardClass}" data-qid="${esc(it.queue_id)}">
                ${dragHandle}
                ${thumb}
                <div class="task-card-body">
                    <div class="task-card-head">
                        <span class="task-card-tool" title="${esc(it.tool_label || it.tool_id)}">${esc(it.tool_label || it.tool_id)}</span>
                        ${badge}
                        ${rankHtml}
                    </div>
                    <div class="task-card-meta">${esc(meta)}</div>
                    ${errorHtml}
                    ${progressHtml}
                    <div class="task-card-foot">
                        <span class="task-card-time">${esc(timeStr)}</span>
                    </div>
                </div>
                ${actionsHtml}
            </div>`;
    }

    function _statusBadgeHtml(status) {
        const map = {
            pending:   { cls: 'task-status-pending',   icon: 'fa-hourglass-half', text: '排队中' },
            running:   { cls: 'task-status-running',   icon: 'fa-spinner',        text: '生成中' },
            done:      { cls: 'task-status-done',      icon: 'fa-circle-check',   text: '完成' },
            failed:    { cls: 'task-status-failed',    icon: 'fa-triangle-exclamation', text: '失败' },
            cancelled: { cls: 'task-status-cancelled', icon: 'fa-circle-xmark',  text: '已取消' },
        };
        const m = map[status] || map.pending;
        return `<span class="task-status-badge ${m.cls}"><i class="fa-solid ${m.icon}"></i> ${m.text}</span>`;
    }

    function _formatMeta(it) {
        // 简化为「工具 → 表单参数摘要」：取 form_values 第一个非空字段值
        let formSummary = '';
        try {
            const fv = JSON.parse(it.form_values || '{}');
            const keys = Object.keys(fv).filter(k => fv[k] != null && String(fv[k]).length > 0);
            if (keys.length) {
                const vals = keys.map(k => {
                    let v = fv[k];
                    if (typeof v === 'object') {
                        if (Array.isArray(v)) return `${k}: [${v.length}]`;
                        return `${k}: {...}`;
                    }
                    const sv = String(v);
                    return `${k}: ${sv.length > 22 ? sv.slice(0, 22) + '…' : sv}`;
                });
                formSummary = vals.slice(0, 2).join(' · ');
            }
        } catch (e) {}
        return formSummary || '(无参数)';
    }

    function _formatTime(it) {
        const ts = (it.status === 'running' && it.started_at ? it.started_at : null)
            || (it.status === 'pending' ? it.enqueued_at : null)
            || (it.finished_at || null)
            || it.enqueued_at;
        if (!ts) return '';
        const d = new Date(Number(ts) * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function _thumbHtml(it) {
        // done: 显示缩略图（如果是 data URL 直接渲染；否则通过 IPC 读）
        if (it.status !== 'done') {
            const iconCls = it.status === 'running' ? 'fa-spinner' : (it.status === 'failed' ? 'fa-triangle-exclamation' : (it.status === 'cancelled' ? 'fa-circle-xmark' : 'fa-hourglass-half'));
            const cls = it.status === 'running' ? 'task-card-thumb task-card-thumb-loading' : 'task-card-thumb';
            return `<div class="${cls}"><i class="fa-solid ${iconCls}" aria-hidden="true"></i></div>`;
        }
        // 落盘产物的 fileUrl（2026-11 流式，优先）
        if (it.fileUrl) {
            const isVideo = /^data:video\//i.test(it.result_mime || '') || /\.(mp4|webm|mov|mkv|avi)$/i.test(it.fileUrl);
            if (isVideo) {
                return `<div class="task-card-thumb" data-qid="${esc(it.queue_id)}" data-act="preview"><video src="${esc(it.fileUrl)}" muted playsinline preload="metadata"></video></div>`;
            }
            return `<div class="task-card-thumb" data-qid="${esc(it.queue_id)}" data-act="preview"><img alt="" src="${esc(it.fileUrl)}"></div>`;
        }
        // done + 有 result_path 是 data URL → 直接渲染（兼容旧 payload 含 result_path 的场景）
        if (it.result_path && /^data:/i.test(it.result_path)) {
            const isVideo = /^data:video\//i.test(it.result_path);
            if (isVideo) {
                return `<div class="task-card-thumb" data-qid="${esc(it.queue_id)}" data-act="preview"><video src="${esc(it.result_path)}" muted playsinline preload="metadata"></video></div>`;
            }
            return `<div class="task-card-thumb" data-qid="${esc(it.queue_id)}" data-act="preview"><img alt="" src="${esc(it.result_path)}"></div>`;
        }
        // done + result_text 在 payload 里 → 直接渲染
        if (it.result_text) {
            return `<div class="task-card-thumb" data-qid="${esc(it.queue_id)}" data-act="preview-text"><div class="task-card-thumb-text">${esc(it.result_text)}</div></div>`;
        }
        // done + 只有 has_result_* 标志（list IPC 不再返 result_path / result_text） →
        // 先放占位，由 _lazyLoadThumbs 后台异步拉
        const act = it.has_result_text ? 'preview-text' : 'preview';
        const icon = it.has_result_text ? 'fa-quote-right' : 'fa-image';
        return `<div class="task-card-thumb task-card-thumb-loading" data-qid="${esc(it.queue_id)}" data-act="${act}"><i class="fa-solid ${icon}" aria-hidden="true"></i></div>`;
    }

    // 后台异步补拉 done 卡的缩略图（D-QUEUE：list 不再返 result_path，避免大量 done 任务时 IPC payload 过重）
    function _lazyLoadThumbs() {
        if (!$list) return;
        // D-QUEUE-FIX-FLASH：去掉「!it.result_path && !it.result_text」的过滤，改成查 _loadedThumbs：
        // 旧版本里 _st.items 每次 refresh 都被整体替换，新 item 上 result_path=null，所以每次 render
        // 都会重发 IPC + replaceChild → 已显示的 <img> 被替换一次，肉眼看到闪。
        // 现在用进程级 Map 记住「哪些 queueId 已经加载过 result_path / result_text」，
        // 重复 render 直接跳过；只对「从未加载过」的目标发 IPC。
        const targets = _st.items.filter(it =>
            it.status === 'done' &&
            (it.has_result_path || it.has_result_text) &&
            !_loadedThumbs.has(it.queue_id)
        );
        if (!targets.length) return;
        for (const it of targets) {
            const qid = it.queue_id;
            // 占位 Map（防并发：同一 qid 短时间内不会重复发）
            if (_loadedThumbs.has(qid) && _loadedThumbs.get(qid)._loading) continue;
            _loadedThumbs.set(qid, { _loading: true });
            // 2026-11 流式缩略图：优先用 resultItems（落盘产物返回 fileUrl，零 base64 开销），
            // 兼容老 resultReadAsDataUrl（dataUrl）
            const loadItems = (window.api.taskQueue.resultItems
                ? window.api.taskQueue.resultItems(qid).then(r => {
                    if (!r || !r.ok || !Array.isArray(r.items) || !r.items.length) return null;
                    const it0 = r.items.find(x => x.kind === 'text') || r.items[0];
                    return {
                        ok: true,
                        fileUrl: it0.fileUrl || null,
                        dataUrl: it0.dataUrl || null,
                        text: it0.text || null,
                        mime: it0.mime || null,
                    };
                })
                : Promise.resolve(null));
            loadItems.then(r => (r && r.ok) ? r : window.api.taskQueue.resultReadAsDataUrl(qid)).then((r) => {
                if (!r || !r.ok) {
                    // 失败就清掉占位，下次 render 重试
                    _loadedThumbs.delete(qid);
                    return;
                }
                // 成功：写入持久缓存 + 当前 item
                _loadedThumbs.set(qid, {
                    fileUrl: r.fileUrl || null,
                    result_path: r.dataUrl || null,
                    result_text: r.text || null,
                    result_mime: r.mime || null,
                });
                it.fileUrl = r.fileUrl || null;
                it.result_path = r.dataUrl || null;
                it.result_text = r.text || null;
                it.result_mime = r.mime || null;
                // 该 card 可能已被删除/重排，找不到就放弃
                const placeholder = $list.querySelector(`.task-card-thumb[data-qid="${qid}"]`);
                if (!placeholder) return;
                const card = placeholder.closest('.task-card');
                if (!card) return;
                const tmp = document.createElement('div');
                tmp.innerHTML = _thumbHtml(it);
                const fresh = tmp.firstElementChild;
                if (fresh) card.replaceChild(fresh, placeholder);
            }).catch(() => { _loadedThumbs.delete(qid); });
        }
    }

    // ===== 事件绑定（重渲染后调用） =====
    function _bindCardEvents() {
        if (!$list) return;
        // 操作按钮
        $list.querySelectorAll('button[data-act]').forEach((btn) => {
            const act = btn.getAttribute('data-act');
            const qid = btn.getAttribute('data-qid');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (act === 'cancel') cancelTask(qid);
                else if (act === 'remove') removeTask(qid);
            });
        });
        // 缩略图点开 → IPC 读结果
        $list.querySelectorAll('.task-card-thumb[data-act="preview"]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                openPreview(el.getAttribute('data-qid'));
            });
        });
        $list.querySelectorAll('.task-card-thumb[data-act="preview-text"]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                openPreview(el.getAttribute('data-qid'), { textOnly: true });
            });
        });
        // 拖拽手柄
        $list.querySelectorAll('.task-card-drag-handle').forEach((handle) => {
            handle.addEventListener('mousedown', (e) => _dragStart(e, handle.getAttribute('data-qid')));
        });
        $list.querySelectorAll('.task-card-draggable').forEach((card) => {
            card.addEventListener('dragover', _dragOver);
            card.addEventListener('dragleave', _dragLeave);
            card.addEventListener('drop', _drop);
            card.addEventListener('dragend', _dragEnd);
            // HTML5 dnd 备用（手柄也走 HTML5 dnd）
            card.setAttribute('draggable', 'true');
            card.addEventListener('dragstart', (e) => {
                _dragSrcId = card.getAttribute('data-qid');
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', _dragSrcId); } catch {}
                card.classList.add('task-card-dragging');
            });
        });
    }

    // ===== 操作 =====
    async function cancelTask(qid) {
        try {
            const r = await window.api.taskQueue.cancel(qid);
            if (!r || !r.ok) {
                if (window.showToast) window.showToast('取消失败：' + (r && r.error || '未知'), 'error');
            }
        } catch (e) {
            if (window.showToast) window.showToast('取消失败：' + e.message, 'error');
        }
    }

    async function removeTask(qid) {
        // D-QUEUE：乐观更新 —— 点击瞬间就把卡片从本地状态抹掉 + 重绘，
        // 给「立刻响应」的视觉反馈；IPC 在后台跑，失败再回滚（refresh 兜底）。
        _optimisticRemove(qid);
        try {
            const r = await window.api.taskQueue.remove(qid);
            if (!r || !r.ok) {
                if (window.showToast) window.showToast('删除失败：' + (r && r.error || '未知'), 'error');
                // 回滚：从服务端权威拉一次
                refresh();
            }
            // 成功的话主进程会再 push 一份 'removed'，refresh 是幂等的
        } catch (e) {
            if (window.showToast) window.showToast('删除失败：' + e.message, 'error');
            refresh();
        }
    }

    function _optimisticRemove(qid) {
        const idx = _st.items.findIndex(i => i.queue_id === qid);
        if (idx < 0) return;
        _st.items.splice(idx, 1);
        delete _st.pendingRanks[qid];
        // D-QUEUE-FIX-FLASH：清掉已加载缩略图缓存（任务已删，留着也是浪费内存）
        _loadedThumbs.delete(qid);
        updateBadge();
        if (_st.open) render();
    }

    async function clearDone() {
        const ids = _st.items.filter(i => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled').map(i => i.queue_id);
        if (!ids.length) {
            if (window.showToast) window.showToast('没有可清理的任务', 'info');
            return;
        }
        for (const qid of ids) {
            await removeTask(qid);
        }
        if (window.showToast) window.showToast(`已清理 ${ids.length} 条任务`, 'success');
    }

    // ===== 拖拽（pointer events 自实现，避免 HTML5 dnd 在 nested drag handle 时的边缘情况） =====
    let _dragSrcId = null;

    function _dragStart(e, qid) {
        e.preventDefault();
        _dragSrcId = qid;
        const src = $list.querySelector(`.task-card[data-qid="${qid}"]`);
        if (src) src.classList.add('task-card-dragging');
        document.addEventListener('mousemove', _dragMove);
        document.addEventListener('mouseup', _dragEnd);
    }
    function _dragMove(e) {
        if (!_dragSrcId) return;
        // 高亮落在的卡片
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        const card = el.closest('.task-card.task-card-draggable');
        $list.querySelectorAll('.task-card.task-card-drag-over').forEach(c => c.classList.remove('task-card-drag-over'));
        if (card && card.getAttribute('data-qid') !== _dragSrcId) {
            card.classList.add('task-card-drag-over');
        }
    }
    function _dragOver(e) {
        if (_dragSrcId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
    }
    function _dragLeave(e) {
        const card = e.currentTarget;
        card.classList.remove('task-card-drag-over');
    }
    async function _drop(e) {
        e.preventDefault();
        const targetId = e.currentTarget.getAttribute('data-qid');
        const srcId = _dragSrcId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        e.currentTarget.classList.remove('task-card-drag-over');
        if (!srcId || !targetId || srcId === targetId) return;
        try {
            await window.api.taskQueue.reorder(srcId, targetId);
        } catch (err) {
            if (window.showToast) window.showToast('重排失败：' + err.message, 'error');
        }
    }
    function _dragEnd() {
        document.removeEventListener('mousemove', _dragMove);
        document.removeEventListener('mouseup', _dragEnd);
        if (_dragSrcId) {
            const src = $list.querySelector(`.task-card[data-qid="${_dragSrcId}"]`);
            if (src) src.classList.remove('task-card-dragging');
        }
        $list.querySelectorAll('.task-card.task-card-drag-over').forEach(c => c.classList.remove('task-card-drag-over'));
        _dragSrcId = null;
    }

    // ===== 大图预览 =====
    let _thumbCache = new Map(); // queueId → { kind, dataUrl, text, mime }

    async function openPreview(queueId, opts) {
        if (!$previewOverlay) return;
        opts = opts || {};
        $previewOverlay.classList.add('open');
        // 先放 loading
        $previewOverlay.innerHTML = '<div style="color:#fff;font-size:13px;"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>';
        // 缓存命中
        const cached = _thumbCache.get(queueId);
        if (cached) {
            _showPreviewContent(cached);
            return;
        }
        try {
            // 2026-11 流式：优先 resultItems（fileUrl），兼容老 dataUrl
            let entry = null;
            if (window.api.taskQueue.resultItems) {
                const ri = await window.api.taskQueue.resultItems(queueId);
                if (ri && ri.ok && Array.isArray(ri.items) && ri.items.length) {
                    const it0 = ri.items.find(x => x.kind === 'text') || ri.items[0];
                    entry = {
                        kind: it0.kind || (it0.fileUrl || it0.dataUrl ? 'image' : 'text'),
                        dataUrl: it0.dataUrl || null,
                        fileUrl: it0.fileUrl || null,
                        text: it0.text || null,
                        mime: it0.mime || null,
                    };
                }
            }
            if (!entry) {
                const r = await window.api.taskQueue.resultReadAsDataUrl(queueId);
                if (!r || !r.ok) {
                    if (window.showToast) window.showToast(r && r.error || '读取失败', 'error');
                    $previewOverlay.classList.remove('open');
                    return;
                }
                entry = { kind: r.kind || (r.dataUrl ? (/^data:video\//i.test(r.dataUrl) ? 'video' : 'image') : 'image'), dataUrl: r.dataUrl, fileUrl: null, text: r.text, mime: r.mime };
            }
            _thumbCache.set(queueId, entry);
            _showPreviewContent(entry);
        } catch (e) {
            if (window.showToast) window.showToast('读取失败：' + e.message, 'error');
            $previewOverlay.classList.remove('open');
        }
    }
    function _showPreviewContent(entry) {
        if (!$previewOverlay) return;
        if (entry.text) {
            $previewOverlay.innerHTML = `<pre style="color:#fff;background:rgba(15,23,42,.85);padding:24px;border-radius:8px;max-width:90vw;max-height:90vh;overflow:auto;white-space:pre-wrap;font-family:inherit;font-size:13px;">${esc(entry.text)}</pre>`;
        } else if (entry.dataUrl || entry.fileUrl) {
            const src = entry.fileUrl || entry.dataUrl;
            if (entry.kind === 'video') {
                $previewOverlay.innerHTML = `<video src="${esc(src)}" controls autoplay></video>`;
            } else {
                $previewOverlay.innerHTML = `<img alt="" src="${esc(src)}">`;
            }
        } else {
            $previewOverlay.innerHTML = '<div style="color:#fff;">无可显示内容</div>';
        }
    }
    function closePreview() {
        if (!$previewOverlay) return;
        // 释放视频对象
        const vid = $previewOverlay.querySelector('video');
        if (vid) try { vid.pause(); vid.src = ''; } catch {}
        $previewOverlay.innerHTML = '';
        $previewOverlay.classList.remove('open');
    }

    // ===== 事件订阅 =====
    function _onQueueEvent(ev) {
        if (!ev || !ev.type) return;
        if (ev.type === 'added' || ev.type === 'status' || ev.type === 'result' || ev.type === 'removed' || ev.type === 'reordered') {
            // 重新拉表保持权威（无需自己算状态机）
            refresh();
        } else if (ev.type === 'progress') {
            // 进度事件不影响状态，只更新进度条
            if (_st.open && $progressBar && $progressText && ev.queueId) {
                const v = Number(ev.value) || 0;
                const m = Number(ev.max) || 0;
                if (m > 0) {
                    const pct = Math.max(0, Math.min(100, Math.round((v / m) * 100)));
                    $progressBar.classList.remove('task-card-progress-undetermined');
                    $progressBar.style.width = pct + '%';
                    $progressText.textContent = pct + '%';
                }
            }
        }
    }

    // ===== 暴露 =====
    window.taskQueue = {
        open, close, toggle, refresh,
        _updateFromEvent: _onQueueEvent,
        getState: () => ({ count: _st.items.length, open: _st.open }),
        clearThumbCache: () => _thumbCache.clear(),
    };

    // ===== 初始化 =====
    function bootstrap() {
        _initDom();
        // 事件订阅（主进程 push）
        try {
            if (window.api.taskQueue && window.api.taskQueue.onUpdate) {
                window.api.taskQueue.onUpdate(_onQueueEvent);
            }
        } catch (e) {}
        // 启动拉一次（含脚本加载时已经入队的 pending）
        refresh();
        // 兜底：每 4s 轮询一次，捕获事件流丢失的情况
        setInterval(refresh, 4000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
