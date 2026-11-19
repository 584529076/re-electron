'use strict';
const PAGE_HOSTS = new Set(['dramaface.com', 'www.dramaface.com']);
const IMAGE_HOSTS = new Set([...PAGE_HOSTS, 'img.kkkkkkkkk.net']);
function validateUrl(value, image = false) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(image ? IMAGE_HOSTS : PAGE_HOSTS).has(url.hostname)) throw new Error('目前支持 dramaface.com 的公开演员资料页面');
    if (!image && !/^\/(info|model)\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) throw new Error('请输入 /info/姓名 或 /model/姓名 格式的演员页面地址');
    url.hash = ''; url.search = '';
    return url.href;
}
async function download(url, image = false, fetcher = require('electron').net.fetch) {
    let current = validateUrl(url, image);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
        for (let hop = 0; hop < 5; hop++) {
            const response = await fetcher(current, { redirect: 'manual', signal: controller.signal, headers: { Accept: image ? 'image/*' : 'text/html', Referer: 'https://www.dramaface.com/' } });
            if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); current = validateUrl(new URL(response.headers.get('location'), current).href, image); continue; }
            if (!response.ok) { await response.body?.cancel(); throw new Error(`网站返回 HTTP ${response.status}`); }
            const max = image ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
            const reader = response.body.getReader(), chunks = []; let size = 0;
            try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new Error('网页或图片超过大小限制'); chunks.push(Buffer.from(part.value)); } }
            finally { await reader.cancel().catch(() => {}); }
            return { bytes: Buffer.concat(chunks), url: current };
        }
        throw new Error('网站重定向次数过多');
    } finally { clearTimeout(timer); }
}
// Executed only in an isolated, network-disabled Chromium document. Never execute site scripts.
function parseDocument(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = node => node?.textContent?.trim() || '';
    let person = {};
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try { const data = JSON.parse(script.textContent); const nodes = Array.isArray(data) ? data : data['@graph'] || [data]; const found = nodes.find(n => n['@type'] === 'Person' && n.name); if (found) { person = found; break; } } catch {}
    }
    const root = doc.querySelector('.profile-container');
    const name = text(root?.querySelector('.profile-left .name')) || person.name;
    if (!name || !root) throw new Error('未识别到演员资料，页面可能需要登录或网站结构已变化');
    const details = {};
    for (const item of root.querySelectorAll('.info-item')) { const label = text(item.querySelector('strong')).replace(/[:：]$/, ''); if (label) details[label] = text(item).slice(text(item.querySelector('strong')).length).trim(); }
    const base = new URL('/', pageUrl).href;
    const absolute = value => { try { const url = new URL(value, base); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
    const cover = absolute(person.image || root.querySelector('.profile-left img')?.getAttribute('src') || '');
    const photos = [...new Set([...root.querySelectorAll('.profile-gallery img')].map(img => absolute(img.getAttribute('data-src') || img.getAttribute('src'))).filter(Boolean))];
    const works = [...root.querySelectorAll('.fanhao-list .fh-item:not(.header)')].map(row => ({ code: text(row.querySelector('.code')), title: text(row.querySelector('.code')), duration: (parseFloat(text(row.querySelector('.runtime'))) || 0) * 60, releaseDate: text(row.querySelector('.release')), studio: text(row.querySelector('.company')) })).filter(w => w.code);
    return { name, aliases: [details['英文名'], details['中文名'], details['呢称'], details['昵称']].filter(Boolean), birthday: String(person.birthDate || details['生日'] || '').slice(0, 10), nationality: details['国籍'] || person.nationality || '', birthplace: details['出生地'] || person.birthPlace?.name || '', height: details['身高'] || person.height || '', gender: details['性别'] || '', description: person.description || text(root.querySelector('.ibo')), details, cover, photos, works, sourceUrl: pageUrl };
}
async function parseHtml(html, url) {
    const { BrowserWindow } = require('electron');
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'actor-parser' } });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
        await window.loadURL('about:blank');
        return await window.webContents.executeJavaScript(`(${parseDocument.toString()})(${JSON.stringify(html)},${JSON.stringify(url)})`);
    } finally { window.destroy(); }
}
module.exports = { validateUrl, download, parseDocument, parseHtml };
