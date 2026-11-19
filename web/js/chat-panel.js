// chat-panel.js — Sprint 9.1: AI 助理聊天面板
// 浮动右侧面板：会话列表 + 消息区 + 工具调用卡片 + 用户确认弹窗
'use strict';

(function () {
    if (window.__chatPanelLoaded) return;
    window.__chatPanelLoaded = true;

    const state = {
        novelId: null,
        sessions: [],
        activeSessionId: null,
        messages: [],
        pendingConfirm: null,   // { toolCallId, name, args }
        sending: false,
        open: false,
    };

    const $ = (sel) => document.querySelector(sel);

    // ===== 渲染骨架（首次创建） =====
    function ensurePanel() {
        if (document.getElementById('chatPanel')) return;

        const html = `
<div id="chatPanel" class="chat-panel chat-panel--closed">
  <div class="chat-panel__header">
    <div class="chat-panel__title">AI 助理</div>
    <div class="chat-panel__header-actions">
      <button class="chat-panel__btn" data-act="newSession" title="新建会话">＋</button>
      <button class="chat-panel__btn" data-act="close" title="关闭">×</button>
    </div>
  </div>
  <div class="chat-panel__body">
    <div class="chat-panel__sessions" id="chatPanelSessions"></div>
    <div class="chat-panel__messages" id="chatPanelMessages"></div>
    <div class="chat-panel__input">
      <textarea id="chatPanelInput" placeholder="问点什么...（Shift+Enter 换行）" rows="2"></textarea>
      <button class="chat-panel__send" data-act="send">发送</button>
    </div>
  </div>
</div>
<div id="chatPanelFab" class="chat-panel-fab" title="AI 助理">💬</div>
<div id="chatPanelConfirmModal" class="chat-modal chat-modal--hidden">
  <div class="chat-modal__inner">
    <h3>确认破坏性操作</h3>
    <p id="chatConfirmText" class="chat-modal__text"></p>
    <div class="chat-modal__actions">
      <button class="chat-btn chat-btn--secondary" data-act="cancelConfirm">取消</button>
      <button class="chat-btn chat-btn--danger" data-act="confirmTool">确认执行</button>
    </div>
  </div>
</div>
        `;
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div);
        attachHandlers();
    }

    function attachHandlers() {
        document.body.addEventListener('click', (ev) => {
            const target = ev.target.closest('[data-act]');
            if (!target) return;
            const act = target.getAttribute('data-act');
            switch (act) {
                case 'open': toggle(true); break;
                case 'close': toggle(false); break;
                case 'newSession': newSession(); break;
                case 'selectSession': selectSession(target.getAttribute('data-session-id')); break;
                case 'deleteSession': deleteSession(target.getAttribute('data-session-id')); break;
                case 'send': sendMessage(); break;
                case 'confirmTool': confirmTool(true); break;
                case 'cancelConfirm': confirmTool(false); break;
            }
        });

        document.getElementById('chatPanelFab').addEventListener('click', () => toggle(!state.open));

        document.getElementById('chatPanelInput').addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                sendMessage();
            }
        });

        // 监听后端事件
        if (window.api && window.api.ainovel && window.api.ainovel.onUpdate) {
            window.api.ainovel.onUpdate((ev) => {
                if (!ev || !ev.type) return;
                if (ev.type === 'chat_tool_confirm_required' && ev.payload && ev.payload.sessionId === state.activeSessionId) {
                    showConfirmModal(ev.payload);
                } else if (ev.type === 'chat_final' && ev.payload && ev.payload.sessionId === state.activeSessionId) {
                    // 刷新 session 拿到最新消息
                    reloadActive();
                } else if (ev.type === 'chat_paused' && ev.payload && ev.payload.sessionId === state.activeSessionId) {
                    state.sending = false;
                    appendSystemMessage('⏸️ 已暂停：' + (ev.payload.reason || '等待用户确认'));
                    renderMessages();
                } else if (ev.type === 'chat_failed' && ev.payload && ev.payload.sessionId === state.activeSessionId) {
                    state.sending = false;
                    appendSystemMessage('❌ 失败：' + (ev.payload.error || ''));
                    renderMessages();
                }
            });
        }
    }

    function toggle(open) {
        state.open = open !== undefined ? open : !state.open;
        const panel = document.getElementById('chatPanel');
        if (!panel) return;
        panel.classList.toggle('chat-panel--closed', !state.open);
        if (state.open) reloadSessions();
    }

    async function reloadSessions() {
        if (!state.novelId || !window.api || !window.api.ainovel) return;
        const r = await window.api.ainovel.chatListSessions(state.novelId);
        if (r && r.ok) {
            state.sessions = r.sessions || [];
            renderSessions();
        }
    }

    function renderSessions() {
        const cont = document.getElementById('chatPanelSessions');
        if (!cont) return;
        if (!state.sessions.length) {
            cont.innerHTML = '<div class="chat-panel__empty">还没有会话，点击 ＋ 新建</div>';
            return;
        }
        cont.innerHTML = state.sessions.map(s => {
            const active = s.id === state.activeSessionId ? ' chat-session--active' : '';
            const t = (s.title || '新会话').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
            const time = s.lastMessageAt ? new Date(s.lastMessageAt * 1000).toLocaleString('zh-CN', { hour12: false }).slice(0, 16) : '';
            return `<div class="chat-session${active}" data-act="selectSession" data-session-id="${s.id}">
  <div class="chat-session__title">${t}</div>
  <div class="chat-session__meta">${time} · ${s.messagesCount || 0} 条</div>
  <button class="chat-session__delete" data-act="deleteSession" data-session-id="${s.id}" title="删除">×</button>
</div>`;
        }).join('');
    }

    async function newSession() {
        if (!state.novelId) return;
        const r = await window.api.ainovel.chatCreateSession(state.novelId, '新会话');
        if (r && r.ok && r.session) {
            state.activeSessionId = r.session.id;
            state.messages = [];
            await reloadSessions();
            renderMessages();
        }
    }

    async function selectSession(sessionId) {
        state.activeSessionId = sessionId;
        const r = await window.api.ainovel.chatGetSession(sessionId);
        if (r && r.messages) {
            state.messages = r.messages;
            renderMessages();
        }
        renderSessions();
    }

    async function deleteSession(sessionId) {
        if (!confirm('删除此会话？')) return;
        await window.api.ainovel.chatDeleteSession(sessionId);
        if (state.activeSessionId === sessionId) {
            state.activeSessionId = null;
            state.messages = [];
            renderMessages();
        }
        reloadSessions();
    }

    async function reloadActive() {
        if (!state.activeSessionId) return;
        const r = await window.api.ainovel.chatGetSession(state.activeSessionId);
        if (r && r.messages) {
            state.messages = r.messages;
            renderMessages();
        }
    }

    async function sendMessage(opts = {}) {
        if (state.sending) return;
        const input = document.getElementById('chatPanelInput');
        const text = (input.value || '').trim();
        if (!text && !opts.confirmedToolIds) return;

        if (!state.activeSessionId) {
            await newSession();
        }
        if (!state.activeSessionId) return;

        state.sending = true;
        if (text) {
            appendMessage({ role: 'user', content: text });
            input.value = '';
        }
        appendSystemMessage('⏳ 思考中...');
        renderMessages();

        try {
            const confirmedToolIds = opts.confirmedToolIds || [];
            const r = await window.api.ainovel.chatSendMessage(state.activeSessionId, text, { confirmedToolIds });
            if (!r || !r.ok) {
                state.sending = false;
                appendSystemMessage('❌ ' + (r && r.error ? r.error : '发送失败'));
                renderMessages();
                return;
            }
            if (r.paused) {
                state.sending = false;
                appendSystemMessage('⏸️ 等待确认...');
            } else if (r.content) {
                state.sending = false;
                appendMessage({ role: 'assistant', content: r.content });
            } else {
                state.sending = false;
            }
            await reloadActive();
        } catch (e) {
            state.sending = false;
            appendSystemMessage('❌ ' + (e.message || String(e)));
            renderMessages();
        }
    }

    function appendMessage(msg) {
        // 移除"思考中"占位
        state.messages = state.messages.filter(m => !(m.role === 'system' && (m.content || '').includes('⏳')));
        state.messages.push(msg);
    }

    function appendSystemMessage(text) {
        state.messages = state.messages.filter(m => !(m.role === 'system' && (m.content || '').includes('⏳')));
        state.messages.push({ role: 'system', content: text });
    }

    function renderMessages() {
        const cont = document.getElementById('chatPanelMessages');
        if (!cont) return;
        if (!state.messages.length) {
            cont.innerHTML = '<div class="chat-panel__empty">有什么需要帮忙的？试着问："这个项目有哪些章节？"</div>';
            return;
        }
        cont.innerHTML = state.messages.map(m => renderMessage(m)).join('');
        cont.scrollTop = cont.scrollHeight;
    }

    function renderMessage(m) {
        const content = (m.content || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
        if (m.role === 'user') {
            return `<div class="chat-msg chat-msg--user"><div class="chat-msg__bubble">${content}</div></div>`;
        }
        if (m.role === 'assistant') {
            let html = `<div class="chat-msg chat-msg--assistant"><div class="chat-msg__bubble">${content || '(空回复)'}</div>`;
            if (m.toolCall) {
                const args = JSON.stringify(m.toolCall.args || {});
                html += `<div class="chat-msg__tool">🔧 调用工具: <code>${m.toolCall.name}</code> · ${args.slice(0, 200)}${args.length > 200 ? '...' : ''}</div>`;
            }
            html += '</div>';
            return html;
        }
        if (m.role === 'tool') {
            const r = m.toolResult || {};
            const res = r.result || {};
            const ok = res.ok !== false;
            const text = ok ? JSON.stringify(res).slice(0, 300) : (res.error || '失败');
            return `<div class="chat-msg chat-msg--tool"><div class="chat-msg__tool-result">${ok ? '✓' : '✗'} ${escape(text)}</div></div>`;
        }
        if (m.role === 'system') {
            return `<div class="chat-msg chat-msg--system">${content}</div>`;
        }
        return '';
    }

    function escape(s) {
        return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
    }

    function showConfirmModal(payload) {
        state.pendingConfirm = payload;
        const modal = document.getElementById('chatPanelConfirmModal');
        const text = document.getElementById('chatConfirmText');
        const args = JSON.stringify(payload.args || {});
        text.innerHTML = `工具 <code>${payload.name}</code> 是<strong>破坏性操作</strong>，将执行：<br><pre>${escape(args)}</pre><br>确认执行吗？`;
        modal.classList.remove('chat-modal--hidden');
    }

    async function confirmTool(ok) {
        const modal = document.getElementById('chatPanelConfirmModal');
        modal.classList.add('chat-modal--hidden');
        if (!ok || !state.pendingConfirm) {
            state.pendingConfirm = null;
            return;
        }
        const tcId = state.pendingConfirm.toolCallId;
        state.pendingConfirm = null;
        await sendMessage({ confirmedToolIds: [tcId] });
    }

    // ===== 公共 API =====
    window.ChatPanel = {
        setNovel: (novelId) => {
            state.novelId = novelId;
            if (state.open) reloadSessions();
        },
        open: () => toggle(true),
        close: () => toggle(false),
        isOpen: () => state.open,
        ensurePanel,
    };

    // 启动时初始化面板
    document.addEventListener('DOMContentLoaded', () => {
        ensurePanel();
    });
})();