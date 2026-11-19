// i18n.js — Sprint 9.2: 极简 i18n（仅关键 UI + chat）
// 用法：window.I18n.t('key')，自动从 localStorage 读取语言偏好
'use strict';

(function () {
    if (window.__i18nLoaded) return;
    window.__i18nLoaded = true;

    const STORAGE_KEY = 'ainovel-ui-lang';

    const dict = {
        zh: {
            'chat.title': 'AI 助理',
            'chat.newSession': '新建会话',
            'chat.close': '关闭',
            'chat.send': '发送',
            'chat.input.placeholder': '问点什么...（Shift+Enter 换行）',
            'chat.empty.sessions': '还没有会话，点击 ＋ 新建',
            'chat.empty.messages': '有什么需要帮忙的？试着问："这个项目有哪些章节？"',
            'chat.confirm.title': '确认破坏性操作',
            'chat.confirm.run': '确认执行',
            'chat.confirm.cancel': '取消',
            'chat.tool.pendingConfirm': '⏸️ 等待确认...',
            'chat.tool.paused': '⏸️ 已暂停',
            'chat.error': '❌ 失败',
            'project.language.zh': '中文',
            'project.language.en': '英文',
            'project.badge.zh': 'ZH',
            'project.badge.en': 'EN',
            'config.pending.title': '待确认的配置变更',
            'config.pending.apply': '应用',
            'config.pending.dismiss': '忽略',
        },
        en: {
            'chat.title': 'AI Assistant',
            'chat.newSession': 'New chat',
            'chat.close': 'Close',
            'chat.send': 'Send',
            'chat.input.placeholder': 'Ask anything... (Shift+Enter for newline)',
            'chat.empty.sessions': 'No sessions yet. Click + to create one.',
            'chat.empty.messages': 'How can I help? Try asking: "How many chapters does this project have?"',
            'chat.confirm.title': 'Confirm destructive action',
            'chat.confirm.run': 'Confirm',
            'chat.confirm.cancel': 'Cancel',
            'chat.tool.pendingConfirm': '⏸️ Awaiting confirmation...',
            'chat.tool.paused': '⏸️ Paused',
            'chat.error': '❌ Error',
            'project.language.zh': 'Chinese',
            'project.language.en': 'English',
            'project.badge.zh': 'ZH',
            'project.badge.en': 'EN',
            'config.pending.title': 'Pending config changes',
            'config.pending.apply': 'Apply',
            'config.pending.dismiss': 'Dismiss',
        },
    };

    let currentLang = 'zh';

    function load() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored && dict[stored]) currentLang = stored;
        } catch (e) { /* */ }
    }

    function save(lang) {
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* */ }
    }

    function setLang(lang) {
        if (!dict[lang]) return false;
        currentLang = lang;
        save(lang);
        // 通知监听者
        document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang } }));
        return true;
    }

    function getLang() {
        return currentLang;
    }

    function t(key, fallback) {
        const d = dict[currentLang] || dict.zh;
        return d[key] || (fallback !== undefined ? fallback : key);
    }

    function tFor(key, lang) {
        const d = dict[lang] || dict.zh;
        return d[key] || key;
    }

    load();

    window.I18n = {
        t,
        tFor,
        getLang,
        setLang,
        languages: Object.keys(dict),
    };
})();