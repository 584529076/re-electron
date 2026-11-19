'use strict';

const credentials = new Map();           // 精确 URL → Basic auth（资源站播放用）
const originCredentials = new Map();    // origin → Basic auth（NAS 扫描 / 跨子路径播放用）

function mediaUrlKey(address) {
    const url = address instanceof URL ? address : new URL(String(address));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `${url.origin}${url.pathname}${url.search}`;
}

function rememberPlaybackCredentials(address) {
    try {
        const url = address instanceof URL ? address : new URL(String(address));
        if (!['http:', 'https:'].includes(url.protocol) || (!url.username && !url.password)) return false;
        const user = decodeURIComponent(url.username || '');
        const password = decodeURIComponent(url.password || '');
        const key = mediaUrlKey(url);
        if (!key) return false;
        credentials.set(key, `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
        return true;
    } catch (_) {
        return false;
    }
}

function getPlaybackAuthorization(address) {
    try {
        return credentials.get(mediaUrlKey(address)) || '';
    } catch (_) {
        return '';
    }
}

/**
 * 按 origin 注册凭证（NAS 扫描等场景，URL 不带 credentials，Chromium fetch 会拒绝，
 * 所以走 webRequest.onBeforeSendHeaders 钩子按 origin 注入 Authorization）。
 * @param {string} origin 形如 "http://192.168.0.100:5005"
 * @param {string} basicAuthHeader 形如 "Basic YWRtaW46YWRtaW4xMjM="
 * @returns {boolean}
 */
function rememberOriginCredentials(origin, basicAuthHeader) {
    if (!origin || !basicAuthHeader) return false;
    originCredentials.set(origin, basicAuthHeader);
    return true;
}

/**
 * 清空某个 origin 的凭证（设置变更时调用）
 * @param {string} origin
 */
function clearOriginCredentials(origin) {
    if (origin) originCredentials.delete(origin);
}

/**
 * 按 origin 查 Basic auth 头（NAS BFS、跨子路径图片/视频播放用）
 * @param {string|URL} address
 * @returns {string}
 */
function getOriginAuthorization(address) {
    try {
        const url = address instanceof URL ? address : new URL(String(address));
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        return originCredentials.get(url.origin) || '';
    } catch (_) {
        return '';
    }
}

module.exports = {
    rememberPlaybackCredentials,
    getPlaybackAuthorization,
    rememberOriginCredentials,
    clearOriginCredentials,
    getOriginAuthorization,
};
