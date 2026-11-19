'use strict';
const { readNasConfig, resolveNasUrl } = require('./nas-url');
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mkv|mov|avi|wmv|ts)$/i;
const nameKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
function urlKey(value) { try { const u = new URL(value); u.username = ''; u.password = ''; u.hash = ''; return u.href; } catch { return ''; } }
function abortCheck(signal) { if (signal?.aborted) throw Object.assign(new Error('已停止导入'), { name: 'AbortError' }); }

// DOMParser runs in an isolated, network-disabled document; NAS scripts are never executed.
function parseDirectoryDocument(text, xml) {
    const doc = new DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
    if (xml) {
        if (doc.getElementsByTagName('parsererror').length) throw new Error('NAS 目录响应不是有效 XML');
        return [...doc.getElementsByTagNameNS('*', 'response')].flatMap(node => {
            const props = [...node.getElementsByTagNameNS('*', 'propstat')].filter(p => /\s2\d\d\s/.test(p.getElementsByTagNameNS('*', 'status')[0]?.textContent || ''));
            if (!props.length) return [];
            return [{ href: node.getElementsByTagNameNS('*', 'href')[0]?.textContent || '', directory: props.some(p => p.getElementsByTagNameNS('*', 'collection').length > 0) }];
        });
    }
    if (doc.querySelector('input[type="password"]')) throw new Error('NAS 返回登录页面，请检查 NAS 地址中的账号和密码');
    return [...doc.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), directory: /\/$/.test(a.getAttribute('href').split(/[?#]/)[0]) }));
}
async function createDirectoryParser() {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'nas-directory-parser' } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, cb) => cb({ cancel: true }));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try { await win.loadURL('about:blank'); } catch (e) { win.destroy(); throw e; }
    return { parse: (text, xml) => win.webContents.executeJavaScript(`(${parseDirectoryDocument.toString()})(${JSON.stringify(text)},${!!xml})`), close: () => { if (!win.isDestroyed()) win.destroy(); } };
}
function childEntries(entries, parent) {
    const base = new URL(parent), seen = new Set(), result = [];
    for (const entry of entries) {
        try {
            if (!entry.href || /^[?#]/.test(entry.href)) continue;
            const u = new URL(entry.href, base);
            if (u.origin !== base.origin || u.username || u.password || u.search || u.hash) continue;
            const parentPath = decodeURIComponent(base.pathname), fullPath = decodeURIComponent(u.pathname);
            if (!fullPath.startsWith(parentPath)) continue;
            const relative = fullPath.slice(parentPath.length).replace(/\/$/, '');
            // Only direct children. This excludes parent links, traversal, and cross-directory links.
            if (!relative || relative.includes('/') || relative.includes('\\') || relative === '.' || relative === '..' || /[\u0000-\u001f]/.test(relative)) continue;
            if (entry.directory && !u.pathname.endsWith('/')) u.pathname += '/';
            if (seen.has(u.href)) continue;
            seen.add(u.href); result.push({ url: u.href, name: relative, directory: !!entry.directory });
        } catch { /* Ignore malformed/out-of-scope links. */ }
    }
    return result;
}
class NasFolderImporter {
    constructor({ store, library, actors, fetcher = (...args) => require('electron').net.fetch(...args), parserFactory = createDirectoryParser }) {
        Object.assign(this, { store, library, actors, fetcher, parserFactory });
    }
    async run(address, { signal, onProgress = () => {} } = {}) {
        const config = readNasConfig(this.store);
        if (!config.host) throw new Error('请先在设置 → NAS 地址中配置服务器和账号');
        const text = String(address || '').trim();
        if (!text || text.length > 4000) throw new Error('请输入有效的 NAS 目录地址');
        const root = resolveNasUrl(text, config), configured = resolveNasUrl('/', config);
        if (!root || root.origin !== configured.origin || !['http:', 'https:'].includes(root.protocol)) throw new Error('目录必须位于设置中配置的 NAS 服务器');
        if (root.search || root.hash) throw new Error('目录地址不能包含查询参数或锚点');
        root.username = ''; root.password = ''; if (!root.pathname.endsWith('/')) root.pathname += '/';
        const authorization = config.username ? 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64') : '';
        const result = { added: 0, skipped: 0, linked: 0, actorsCreated: 0, actorsMatched: 0, directories: 0, failed: 0, errors: [], ignoredRootFiles: 0, canceled: false };
        const emit = current => onProgress({ ...result, errors: undefined, current });
        const failed = (where, error) => { result.failed++; if (result.errors.length < 200) result.errors.push({ path: where, message: error.message }); };
        const parser = await this.parserFactory();
        const known = new Map(), exactUrls = new Set();
        for (const video of this.library.list()) for (const s of video.sources || []) { const key = urlKey(s.url); if (key) known.set(key, video); exactUrls.add(s.url); }
        const actorNames = new Map();
        const indexActor = actor => { for (const n of [actor.name, ...(actor.aliases || [])]) { const key = nameKey(n); if (!key) continue; const list = actorNames.get(key) || []; if (!list.some(a => a.id === actor.id)) list.push(actor); actorNames.set(key, list); } };
        this.actors.list().forEach(indexActor);
        const request = async (url, method) => {
            abortCheck(signal);
            const controller = new AbortController(), abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(abort, 20000);
            try {
                let current = url;
                for (let hop = 0; hop < 4; hop++) {
                    const response = await this.fetcher(current, { method, redirect: 'manual', signal: controller.signal, headers: { ...(authorization ? { Authorization: authorization } : {}), ...(method === 'PROPFIND' ? { Depth: '1', 'Content-Type': 'application/xml' } : { Accept: 'text/html' }) }, ...(method === 'PROPFIND' ? { body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' } : {}) });
                    if ([301,302,307,308].includes(response.status)) {
                        const next = new URL(response.headers.get('location'), current); await response.body?.cancel();
                        if (next.origin !== root.origin || next.username || next.password || next.search || next.hash || decodeURIComponent(next.pathname).replace(/\/$/, '') !== decodeURIComponent(new URL(url).pathname).replace(/\/$/, '')) throw new Error('NAS 目录重定向到了其他地址，已停止此目录');
                        current = next.href; continue;
                    }
                    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
                    const reader = response.body.getReader(), chunks = []; let size = 0;
                    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8 * 1024 * 1024) throw new Error('目录列表超过 8 MB，请拆分目录导入'); chunks.push(Buffer.from(part.value)); } }
                    finally { await reader.cancel().catch(() => {}); }
                    return { status: response.status, text: Buffer.concat(chunks).toString('utf8'), url: current };
                }
                throw new Error('目录重定向次数过多');
            } catch (error) { if (signal?.aborted) abortCheck(signal); if (controller.signal.aborted) throw new Error('读取目录超时（20 秒）'); throw error; }
            finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        };
        const read = async url => {
            if (++result.directories > 10000) throw new Error('目录数量超过 10000，请拆分目录导入');
            const response = await request(url, 'GET');
            if (response.status === 401) throw new Error('无权读取目录（HTTP 401），请检查 NAS 账号权限');
            if (response.status >= 200 && response.status < 300) {
                const entries = childEntries(await parser.parse(response.text, false), response.url);
                if (entries.length) return entries;
            }
            // WebDAV servers may not expose an HTML directory index.
            const dav = await request(url, 'PROPFIND');
            if (dav.status === 207) return childEntries(await parser.parse(dav.text, true), dav.url);
            if ([401,403].includes(dav.status)) throw new Error(`无权读取目录（HTTP ${dav.status}），请检查 NAS 账号权限`);
            if (response.status === 200 && [405,501].includes(dav.status)) return [];
            throw new Error(`无法列出 NAS 目录（HTTP ${dav.status}），请确认目录存在且允许目录浏览或 WebDAV`);
        };
        try {
            emit('正在读取演员目录…');
            const entries = await read(root.href); abortCheck(signal);
            const folders = entries.filter(e => e.directory);
            result.ignoredRootFiles = entries.filter(e => !e.directory && VIDEO_EXTENSIONS.test(e.name)).length;
            if (!folders.length) throw new Error('未找到演员子目录。请选择包含多个“演员姓名”文件夹的上级目录');
            for (const folder of folders) {
                abortCheck(signal); emit(`正在匹配演员：${folder.name}`);
                if (folder.name.length > 80 || /[,，、\n]/.test(folder.name)) { failed(folder.name, new Error('演员目录名请使用单个完整姓名（最多 80 字）')); continue; }
                const matches = actorNames.get(nameKey(folder.name)) || [];
                if (matches.length > 1) { failed(folder.name, new Error('名称或别名匹配到多个演员，请先整理重复演员')); continue; }
                let actor = matches[0];
                if (actor) result.actorsMatched++;
                else { actor = this.actors.save({ name: folder.name }); indexActor(actor); result.actorsCreated++; }
                const queue = [{ ...folder, depth: 0 }], seen = new Set();
                for (let i = 0; i < queue.length; i++) {
                    abortCheck(signal); const dir = queue[i]; if (seen.has(dir.url)) continue; seen.add(dir.url);
                    emit(`正在导入 ${actor.name}：${dir.name}`);
                    let children;
                    try { children = await read(dir.url); } catch (error) { if (signal?.aborted) throw error; failed(`${folder.name}/${dir.name}`, error); continue; }
                    for (const file of children) {
                        abortCheck(signal);
                        if (file.directory) { if (dir.depth >= 20) failed(file.name, new Error('子目录超过 20 层，请单独整理后导入')); else queue.push({ ...file, depth: dir.depth + 1 }); continue; }
                        if (!VIDEO_EXTENSIONS.test(file.name)) continue;
                        if ((result.added + result.skipped) % 25 === 0) { emit(`正在导入 ${actor.name}：${file.name}`); await new Promise(setImmediate); abortCheck(signal); }
                        if (result.added + result.skipped >= 50000) throw new Error('单次最多处理 50000 个视频，请拆分目录导入');
                        try {
                            const key = urlKey(file.url), existing = known.get(key);
                            if (existing) {
                                if (!existing.actors.some(n => nameKey(n) === nameKey(actor.name))) { existing.actors.push(actor.name); this.library.save(existing); result.linked++; }
                                result.skipped++; continue;
                            }
                            // Reuse the manual metadata path, including playback credentials and normal validation.
                            const playback = new URL(file.url); if (config.username) { playback.username = config.username; playback.password = config.password; }
                            const { video } = this.library.addMetadata({ title: file.name.replace(VIDEO_EXTENSIONS, ''), actors: [actor.name], playbackUrl: playback.href }, false, exactUrls);
                            known.set(key, video); video.sources.forEach(s => exactUrls.add(s.url)); result.added++;
                        } catch (error) { failed(`${actor.name}/${file.name}`, error); }
                    }
                }
            }
        } catch (error) { if (signal?.aborted) result.canceled = true; else if (result.actorsCreated || result.actorsMatched) failed('导入', error); else throw error; }
        finally { parser.close(); }
        emit(result.canceled ? '已停止，已导入的记录会保留' : '导入完成'); return result;
    }
}
module.exports = { NasFolderImporter, parseDirectoryDocument, childEntries, nameKey, urlKey };
