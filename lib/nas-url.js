'use strict';

// lib/nas-url.js — NAS URL 拼接工具（主进程内部使用，含明文密码）
//
// 提取自 resource-station.js:nasUrl + getNasConfig，让 main.js 的资源 Tab 配置
// 也能复用同一套拼接逻辑。**此模块只能在主进程引用**，不要暴露给渲染端。

const NAS_CONFIG_KEY = 'resourceStation:nasConfig';

/**
 * 从 KV store 读 NAS 配置（含明文密码）。仅主进程内部使用。
 * @param {{ get: (k: string) => any }} store
 */
function readNasConfig(store) {
    const cfg = (store && typeof store.get === 'function' && store.get(NAS_CONFIG_KEY)) || {};
    return {
        scheme: cfg.scheme === 'https' ? 'https' : 'http',
        host: String(cfg.host || '').trim(),
        port: Number(cfg.port) || 0,
        username: String(cfg.username || ''),
        password: String(cfg.password || ''),
    };
}

/**
 * 把用户输入的「相对路径」或「完整 URL」规范化成完整 URL。
 * - 已以 http(s):// 开头 → 原样解析为 URL（向后兼容）
 * - 相对路径 → 用 cfg 拼成完整 URL
 * - 输入为空 / cfg 无 host → 返回 null
 *
 * @param {string} input
 * @param {{ scheme: string, host: string, port: number, username: string, password: string }|null|undefined} cfg
 * @returns {URL|null}
 */
function resolveNasUrl(input, cfg) {
    const value = String(input == null ? '' : input).trim();
    if (!value) return null;
    if (!cfg || !cfg.host) return null;
    if (/^https?:\/\//i.test(value)) {
        try { return new URL(value); } catch (_) { return null; }
    }
    const port = Number(cfg.port) || 0;
    let relative = value.replace(/\\/g, '/');
    const escapedHost = String(cfg.host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostPrefix = new RegExp('^' + escapedHost + (port ? '(?::' + port + ')?' : '') + '(?=/|$)', 'i');
    relative = relative.replace(hostPrefix, '');
    if (!relative.startsWith('/')) relative = '/' + relative;
    const url = new URL(relative, `${cfg.scheme || 'http'}://${cfg.host}${port ? ':' + port : ''}`);
    if (cfg.username || cfg.password) {
        url.username = encodeURIComponent(cfg.username || '');
        url.password = encodeURIComponent(cfg.password || '');
    }
    return url;
}

/**
 * 把完整 URL 拆成 baseUrl + rootDir（兼容老的 nasConfig 消费方）。
 * @param {URL|null} url
 * @returns {{ baseUrl: string, rootDir: string }|null}
 */
function splitNasUrl(url) {
    if (!url) return null;
    const rootDir = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
    // baseUrl 不内嵌凭证：Chromium fetch() / <img src> 拒绝带凭证的 URL；
    // 由主进程 webRequest 钩子按 origin 注入 Authorization 头。
    return { baseUrl: url.origin, rootDir };
}

/**
 * 便利方法：一步完成「读 cfg → 解析 input → 拆分」，主进程 IPC handler 用。
 * - 完整 URL：原样拆 baseUrl + rootDir（不带凭证）
 * - 相对路径：用 NAS 地址配置拼出完整 URL（也不带凭证）
 * - 凭证走 origin 注册 + webRequest 钩子注入 Authorization 头
 *
 * @param {{ get: (k: string) => any }} store
 * @param {string} input
 * @returns {{ ok: true, baseUrl: string, rootDir: string } | { ok: false, error: string }}
 */
function resolveNasSource(store, input) {
    const value = String(input == null ? '' : input).trim();
    if (!value) return { ok: false, error: 'nas 类型需 path' };
    if (/^https?:\/\//i.test(value)) {
        const m = value.match(/^https?:\/\/(?:[^/@]*@)?([^/]+)(\/.*)?$/i);
        if (!m) return { ok: false, error: 'nas path 格式错误：需 http://host:port/rootDir' };
        // baseUrl 永远不带凭证；用户在 URL 里写 user:pass@ 这种用法被剥离，凭证走 origin 注册路径
        const baseUrl = value.match(/^https?:\/\//i)[0] + m[1];
        return { ok: true, baseUrl, rootDir: m[2] || '/' };
    }
    const cfg = readNasConfig(store);
    if (!cfg.host) return { ok: false, error: 'NAS 配置缺失，请前往【设置 → 资源管理 → NAS 地址】配置' };
    const url = resolveNasUrl(value, cfg);
    if (!url) return { ok: false, error: 'NAS 相对路径解析失败' };
    const split = splitNasUrl(url);
    return { ok: true, baseUrl: split.baseUrl, rootDir: split.rootDir };
}

module.exports = {
    NAS_CONFIG_KEY,
    readNasConfig,
    resolveNasUrl,
    splitNasUrl,
    resolveNasSource,
};