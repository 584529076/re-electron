// 共享工具：HTML 转义 + Windows 路径 → file:// URI
// 历史背景：workbench/ai-tools/prompt-gen/loras 各自重复实现过 escapeHtml/escapeAttr/toFileUri。
// 本文件抽取统一实现，挂到 window.dUtil，其他模块统一引用，避免漂移。
//
// 注意：必须在 workbench.js / ai-tools.js / prompt-gen.js / loras.js 之前加载（index.html 中）。

(function () {
    'use strict';

    // HTML 实体转义（& < > " '）
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 属性转义：等同 escapeHtml（保留为独立名字便于阅读模板字符串）
    function escapeAttr(s) {
        return escapeHtml(s);
    }

    // Windows 路径 → file:// URI（D:/re-electron/...png → file:///D:/re-electron/...png）
    // encodeURIComponent 路径段，避免空格 / 中文 触发 img load 失败
    // 注意：盘符 'D:' 段不 encode（保留 ':'），否则 file:///D%3A/... 浏览器虽能容错但显示不规范
    function toFileUri(absPath) {
        if (!absPath) return '';
        let p = String(absPath).replace(/\\/g, '/');
        // Windows 盘符路径：补一个 leading /，让 split 后 parts[0]='', parts[1]='D:'
        if (/^[a-zA-Z]:\//.test(p)) p = '/' + p;
        else if (!/^\//.test(p)) p = '/' + p;
        const parts = p.split('/');
        // parts[0] 空 + parts[1] 盘符 不 encode；其余 path 段 encode
        return 'file://' + parts.map((seg, i) => (i <= 1) ? seg : encodeURIComponent(seg)).join('/');
    }

    // 暴露
    window.dUtil = {
        escapeHtml,
        escapeAttr,
        toFileUri,
    };
})();