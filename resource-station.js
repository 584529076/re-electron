'use strict';

const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { TorrentFiles, normalizeTorrentUrl } = require('./lib/resource-torrents');
const { MatchAssistant } = require('./lib/match-assistant');
const { createSources } = require('./lib/match-sources');
const { rememberPlaybackCredentials, clearOriginCredentials, rememberOriginCredentials } = require('./lib/media-auth');
const { NAS_CONFIG_KEY, readNasConfig, resolveNasUrl } = require('./lib/nas-url');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.wmv', '.ts']);
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const tags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/)).map(x => clean(x, 80)).filter(Boolean))].slice(0, 50);
const canonical = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);

class ResourceLibrary {
    constructor(store) {
        this.store = store;
        this.torrentFiles = new TorrentFiles(store);
        store.exec('CREATE TABLE IF NOT EXISTS resource_videos (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    }
    list() {
        return this.store.query('SELECT data FROM resource_videos ORDER BY rowid DESC').map(row => JSON.parse(row.data));
    }
    get(id) {
        const row = this.store.query('SELECT data FROM resource_videos WHERE id = ?', String(id))[0];
        if (!row) throw new Error('视频记录不存在，请刷新后重试');
        return JSON.parse(row.data);
    }
    save(video) {
        this.store.exec('UPDATE resource_videos SET data = ? WHERE id = ?', JSON.stringify(video), video.id);
        return video;
    }
    getNasConfig() {
        const cfg = this.store.get(NAS_CONFIG_KEY) || {};
        return {
            scheme: cfg.scheme === 'https' ? 'https' : 'http',
            host: clean(cfg.host, 253),
            port: Number(cfg.port) || 0,
            username: clean(cfg.username, 200),
            hasPassword: !!cfg.password,
        };
    }

    setNasConfig(input = {}) {
        const host = clean(input.host, 253);
        if (!host) {
            // 清空 NAS 配置时，同步清掉 origin 凭证缓存
            const oldCfg = this.store.get(NAS_CONFIG_KEY) || {};
            if (oldCfg.host) {
                const oldOrigin = `${oldCfg.scheme === 'https' ? 'https' : 'http'}://${oldCfg.host}${oldCfg.port ? ':' + oldCfg.port : ''}`;
                try { clearOriginCredentials(oldOrigin); } catch (_) {}
            }
            this.store.set(NAS_CONFIG_KEY, null);
            return this.getNasConfig();
        }
        if (!/^[a-z0-9._-]+$/i.test(host)) throw new Error('NAS 地址只支持 IP 或主机名');
        const port = Number(input.port);
        if (input.port !== '' && input.port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('NAS 端口无效');
        const scheme = input.scheme === 'https' ? 'https' : 'http';
        const existing = this.store.get(NAS_CONFIG_KEY) || {};
        const clearCredentials = !!input.clearCredentials;
        const keepCredentials = !clearCredentials && (input.keepPassword === true || (!String(input.password ?? '').trim() && !input.clearCredentials));
        const username = clearCredentials ? '' : (clean(input.username, 200) || (keepCredentials ? clean(existing.username, 200) : ''));
        const password = clearCredentials ? '' : (String(input.password ?? '').trim().slice(0, 200) || (keepCredentials ? String(existing.password || '') : ''));
        const finalCfg = { scheme, host, port: Number.isInteger(port) && port > 0 ? port : 0, username, password };
        this.store.set(NAS_CONFIG_KEY, finalCfg);
        // 凭证变更：清旧 origin 注册，按新 origin 重新注册（让 webRequest 钩子拿新凭证）
        try {
            const oldOrigin = existing.host ? `${existing.scheme === 'https' ? 'https' : 'http'}://${existing.host}${existing.port ? ':' + existing.port : ''}` : '';
            if (oldOrigin) clearOriginCredentials(oldOrigin);
            if (finalCfg.host && finalCfg.username) {
                const newOrigin = `${finalCfg.scheme}://${finalCfg.host}${finalCfg.port ? ':' + finalCfg.port : ''}`;
                const auth = 'Basic ' + Buffer.from(`${finalCfg.username}:${finalCfg.password}`).toString('base64');
                rememberOriginCredentials(newOrigin, auth);
            }
        } catch (_) { /* 凭证缓存失败不影响 setNasConfig 返回值 */ }
        return this.getNasConfig();
    }

    nasUrl(address) {
        // 行为完全保留：委托到 lib/nas-url.js 的纯函数实现（与原实现 1:1）
        return resolveNasUrl(address, readNasConfig(this.store));
    }

    playbackSource(address, previous) {
        const value = clean(address, 4000); if (!value) return null;
        let url;
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
        const isWindowsPath = /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
        if (isUrl) {
            try { url = new URL(value); }
            catch { throw new Error('播放地址格式不支持'); }
        } else if (isWindowsPath) {
            url = pathToFileURL(path.resolve(value));
        } else {
            const nas = this.nasUrl(value);
            if (nas) url = nas;
            else if (path.isAbsolute(value)) url = pathToFileURL(path.resolve(value));
            else throw new Error('播放地址需为 NAS 资源路径、HTTP(S) 链接或本地绝对路径');
        }
        if (url.protocol !== 'file:' && (url.username || url.password)) rememberPlaybackCredentials(url);
        const file = url.protocol === 'file:' ? require('url').fileURLToPath(url) : '';
        return { id: previous?.url === url.href ? previous.id : randomUUID(), label: previous?.label || '原画', path: file, url: url.href };
    }

    addMetadata(input = {}, merge = false, knownSourceUrls = null) {
        const code = clean(input.code, 100);
        const existing = code && this.list().find(v => v.code?.toUpperCase() === code.toUpperCase());
        if (existing) {
            if (!merge) throw new Error('该番号已存在，请编辑已有视频资料');
            existing.actors = [...new Set([...existing.actors, ...tags(input.actors)])];
            for (const field of ['releaseDate', 'studio', 'sourceUrl']) if (!existing[field]) existing[field] = clean(input[field], 4000);
            if (!existing.duration) existing.duration = Number(input.duration) || 0;
            this.save(existing); return { video: existing, added: false };
        }
        if (!clean(input.title || code)) throw new Error('请填写视频名称');
        const source = this.playbackSource(input.playbackUrl);
        if (source && (knownSourceUrls ? knownSourceUrls.has(source.url) : this.list().some(v => v.sources.some(s => s.url === source.url)))) throw new Error('该播放地址已经在资源库中');
        const video = { id: randomUUID(), title: clean(input.title || code, 200), code, description: clean(input.description, 4000), actors: tags(input.actors), categories: tags(input.categories), region: clean(input.region), year: clean(input.year), type: clean(input.type) || '电影', releaseDate: clean(input.releaseDate), studio: clean(input.studio), sourceUrl: clean(input.sourceUrl, 4000), cover: '', backdrop: '', sources: source ? [source] : [], addedAt: Date.now(), lastPlayedAt: 0, position: 0, duration: Math.max(0, Number(input.duration) || 0), watched: false };
        video.torrentUrl = normalizeTorrentUrl(input.torrentUrl);
        video.torrents = this.torrentFiles.resolve(input.torrents);
        this.store.exec('INSERT INTO resource_videos(id,path,data) VALUES(?,?,?)', video.id, source?.path ? canonical(source.path) : `metadata:${video.id}`, JSON.stringify(video));
        return { video, added: true };
    }
    async importPaths(paths) {
        const result = { added: 0, skipped: 0, errors: [] };
        const queue = [...paths];
        const known = new Set(this.list().flatMap(v => v.sources.filter(s => s.path).map(s => canonical(s.path))));
        while (queue.length) {
            const filename = queue.pop();
            try {
                const stat = await fs.lstat(filename);
                if (stat.isSymbolicLink()) continue;
                if (stat.isDirectory()) {
                    const entries = await fs.readdir(filename, { withFileTypes: true });
                    queue.push(...entries.filter(e => e.isDirectory() || (e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))).map(e => path.join(filename, e.name)));
                    continue;
                }
                if (!stat.isFile() || !VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase())) { result.skipped++; continue; }
                if (known.has(canonical(filename))) { result.skipped++; continue; }
                const source = { id: randomUUID(), label: '原画', path: path.resolve(filename), url: pathToFileURL(path.resolve(filename)).href, size: stat.size };
                const title = path.basename(filename, path.extname(filename));
                const code = title.match(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,12}[-_]\d{2,7}(?:[-_]\d+)?)(?=$|[^A-Za-z0-9])/i)?.[1]?.toUpperCase() || '';
                const matched = code && this.list().find(v => v.code?.toUpperCase() === code && !v.sources.length);
                if (matched) { matched.sources = [source]; this.store.exec('UPDATE resource_videos SET path=?,data=? WHERE id=?', canonical(filename), JSON.stringify(matched), matched.id); known.add(canonical(filename)); result.added++; continue; }
                const video = { id: randomUUID(), title, code, releaseDate: '', studio: '', description: '', actors: [], categories: [], region: '', year: '', type: '电影', cover: '', backdrop: '', sources: [source], addedAt: Date.now(), lastPlayedAt: 0, position: 0, duration: 0, watched: false };
                this.store.exec('INSERT INTO resource_videos (id, path, data) VALUES (?, ?, ?)', video.id, canonical(filename), JSON.stringify(video));
                known.add(canonical(filename));
                result.added++;
            } catch (error) { result.errors.push({ path: filename, message: error.message }); }
        }
        return result;
    }
    update(id, input = {}) {
        const video = this.get(id);
        if (!clean(input.title)) throw new Error('请填写视频名称');
        for (const key of ['title', 'description', 'region', 'year', 'type']) video[key] = clean(input[key], key === 'description' ? 4000 : 200);
        video.actors = tags(input.actors);
        video.categories = tags(input.categories);
        if (input.torrentUrl !== undefined) video.torrentUrl = normalizeTorrentUrl(input.torrentUrl);
        if (input.torrents !== undefined) video.torrents = this.torrentFiles.resolve(input.torrents);
        for (const field of ['code','releaseDate','studio']) if (input[field] !== undefined) video[field] = clean(input[field], 200);
        if (input.duration !== undefined) { const duration = Number(input.duration); if (!Number.isFinite(duration) || duration < 0) throw new Error('时长必须为有效的秒数'); video.duration = duration; }
        if (video.code && this.list().some(v => v.id !== id && v.code?.toUpperCase() === video.code.toUpperCase())) throw new Error('该番号已存在');
        if (input.playbackUrl !== undefined) {
            const source = this.playbackSource(input.playbackUrl, video.sources[0]);
            if (source && this.list().some(v => v.id !== id && v.sources.some(s => s.url === source.url))) throw new Error('该播放地址已存在');
            const changed = source?.id !== video.sources[0]?.id;
            video.sources = source ? [source, ...video.sources.slice(1).filter(s => s.url !== source.url)] : [];
            if (changed) { video.autoBackdrop = ''; video.autoBackdropSourceId = ''; video.position = 0; video.watched = false; }
            this.store.exec('UPDATE resource_videos SET path=? WHERE id=?', source?.path ? canonical(source.path) : `metadata:${video.id}`, video.id);
        }
        return this.save(video);
    }
    progress(id, input = {}) {
        const video = this.get(id);
        const position = Number(input.position), duration = Number(input.duration);
        if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration <= 0) return video;
        video.position = Math.min(position, duration);
        video.duration = duration;
        video.watched = position / duration >= 0.95;
        video.lastPlayedAt = Date.now();
        return this.save(video);
    }
    async addSource(id, filename, label) {
        const video = this.get(id);
        if (!clean(label, 40)) throw new Error('请填写清晰度名称，例如 1080P');
        if (!VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase()) || !(await fs.stat(filename)).isFile()) throw new Error('请选择视频文件');
        if (this.list().some(v => v.sources.some(s => s.path && canonical(s.path) === canonical(filename)))) throw new Error('该文件已经在资源库中');
        video.sources.push({ id: randomUUID(), label: clean(label, 40), path: path.resolve(filename), url: pathToFileURL(path.resolve(filename)).href });
        return this.save(video);
    }
    removeSource(id, sourceId) {
        const video = this.get(id);
        if (video.sources[0]?.id === sourceId) throw new Error('主视频不能移除，请移除整个资源记录');
        video.sources = video.sources.filter(s => s.id !== sourceId);
        return this.save(video);
    }
    remove(id) { this.store.exec('DELETE FROM resource_videos WHERE id = ?', String(id)); }
    async saveBackdrop(id, sourceId, dataUrl, field = 'autoBackdrop', expectedUrl) {
        const initial = this.get(id);
        const validSource = video => field === 'cover' ? video.sources.some(source => source.id === sourceId && source.url === expectedUrl) : video.sources[0]?.id === sourceId;
        if (!validSource(initial)) throw new Error('视频来源已变化，请重新截取');
        if (field === 'cover' && initial.cover) return { id, sourceId, url: initial.cover, skipped: true };
        if (typeof dataUrl !== 'string' || dataUrl.length > 2800000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error('截图格式或大小无效');
        const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
        if (bytes.length < 4 || bytes.length > 2 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('截图不是有效的 JPEG');
        const artworkDir = path.join(path.dirname(this.store.path), 'resource-artwork');
        await fs.mkdir(artworkDir, { recursive: true });
        const destination = path.join(artworkDir, `${initial.id}-auto-${randomUUID()}.jpg`);
        await fs.writeFile(destination, bytes, { flag: 'wx' });
        try {
            // Re-read after I/O: do not overwrite concurrent metadata or playback updates.
            const current = this.get(id);
            if (!validSource(current)) throw new Error('视频来源已变化，请重新截取');
            if (field === 'cover' && current.cover) { await fs.unlink(destination); return { id, sourceId, url: current.cover, skipped: true }; }
            current[field] = pathToFileURL(destination).href;
            if (field === 'autoBackdrop') current.autoBackdropSourceId = sourceId;
            this.save(current);
            return { id, sourceId, url: current[field] };
        } catch (error) { await fs.unlink(destination).catch(() => {}); throw error; }
    }
}

function registerResourceStation({ ipcMain, dialog, getWindow, store }) {
    const library = new ResourceLibrary(store);
    const actors = new (require('./lib/resource-actors').ActorLibrary)(store, library);
    const matcher = new MatchAssistant({ store, library, actors, dialog, getWindow, sources: createSources((() => {
        const configPath = path.join(require('electron').app?.isPackaged ? process.resourcesPath : __dirname, 'resources', 'match-sources.json');
        try { return JSON.parse(require('fs').readFileSync(configPath, 'utf8')); }
        catch (error) { console.warn('[MatchAssistant] 使用默认数据源：', error.message); return undefined; }
    })()) });
    let importingActor = false;
    let importing = false;
    const handle = (name, fn) => ipcMain.handle(`resourceStation:${name}`, async (event, ...args) => {
        if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: '无权访问资源库' };
        try { return { ok: true, data: await fn(...args) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    const choose = options => dialog.showOpenDialog(getWindow(), options);
    handle('list', () => library.list());

    const nasImporter = new (require('./lib/resource-nas-import').NasFolderImporter)({ store, library, actors });
    let nasJob = null;
    handle('nasImport', async input => {
        if (nasJob) throw new Error('已有 NAS 目录正在导入，请等待完成或停止后重试');
        if (!input || typeof input.requestId !== 'string' || input.requestId.length > 100) throw new Error('导入请求无效');
        const job = { id: input.requestId, controller: new AbortController() }; nasJob = job;
        try { return await nasImporter.run(input.path, { signal: job.controller.signal, onProgress: progress => {
            const win = getWindow(); if (!win || win.isDestroyed()) { job.controller.abort(); return; }
            win.webContents.send('resourceStation:nasImportProgress', { ...progress, requestId: job.id });
        } }); } finally { if (nasJob === job) nasJob = null; }
    });
    handle('nasImportCancel', requestId => { if (nasJob?.id === requestId) nasJob.controller.abort(); return { canceled: true }; });
    handle('nasConfigGet', () => library.getNasConfig());
    handle('nasConfigSet', input => library.setNasConfig(input));
    handle('torrentUpload', async () => { const selected=await choose({title:'上传种子文件',properties:['openFile'],filters:[{name:'种子文件',extensions:['torrent']}]});return selected.canceled?null:library.torrentFiles.upload(selected.filePaths[0]); });
    handle('torrentExport', async (videoId, attachmentId) => {
        const video=library.get(videoId);if(!video.torrents?.some(item=>item.id===attachmentId))throw new Error('作品没有这个种子附件');
        const file=library.torrentFiles.get(attachmentId);
        const selected=await dialog.showSaveDialog(getWindow(),{title:'保存种子文件',defaultPath:file.name,filters:[{name:'种子文件',extensions:['torrent']}]});
        if(selected.canceled||!selected.filePath)return {canceled:true};await library.torrentFiles.export(attachmentId,selected.filePath);return {canceled:false};
    });
    handle('addMetadata', input => library.addMetadata(input).video);
    handle('videoDuration', (id, sourceId, duration) => {
        const current = library.get(id), seconds = Number(duration);
        if (current.sources[0]?.id !== sourceId || !Number.isFinite(seconds) || seconds <= 0) throw new Error('视频时长无效');
        if (!current.duration) { current.duration = seconds; library.save(current); }
        return { id, duration: current.duration };
    });
    handle('actorList', () => actors.list());
    handle('actorSave', input => actors.save(input));
    handle('actorRemove', async target => {
        if (importingActor) throw new Error('演员资料正在导入，请完成后再删除');
        const plan = actors.deletionPlan(target);
        const answer = await dialog.showMessageBox(getWindow(), {
            type: 'warning', title: '确认删除演员',
            message: `永久删除演员“${plan.name}”及其 ${plan.videoIds.length} 条关联作品？`,
            detail: `确认后将直接删除数据库记录，不进入回收站，无法撤销。${plan.sharedCount ? `其中 ${plan.sharedCount} 条作品同时关联其他演员，也会整条删除。` : ''}\n原始视频文件不会删除。`,
            buttons: ['取消', '删除演员及关联作品'], defaultId: 0, cancelId: 0, noLink: true
        });
        if (answer.response !== 1) return { canceled: true };
        if (importingActor) throw new Error('演员资料正在导入，请完成后重新确认删除');
        return { canceled: false, ...actors.removeWithWorks(target, plan.signature) };
    });
    handle('actorImages', async () => { const chosen = await choose({ title: '选择演员封面或写真', properties: ['openFile','multiSelections'], filters: [{ name: '图片', extensions: ['jpg','jpeg','png','webp'] }] }); return chosen.canceled ? [] : actors.upload(chosen.filePaths); });
    handle('actorImport', async url => {
        if (importingActor) throw new Error('正在导入演员，请稍候');
        importingActor = true;
        try { return await actors.importUrl(url, message => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('resourceStation:actorImportProgress', message); }); }
        finally { importingActor = false; }
    });
    handle('matchScan', async () => matcher.scan(await matcher.chooseFolders()));
    handle('matchConfirmBatch', selections => matcher.confirmBatch(selections));
    handle('matchActor', (fileId, actorId) => matcher.selectActor(fileId, actorId));
    handle('matchList', () => matcher.list());
    handle('matchSuggest', fileId => matcher.suggest(fileId));
    handle('matchConfirm', (fileId, videoId, candidate) => matcher.confirm(fileId, videoId, candidate));
    handle('matchIgnore', fileId => matcher.ignore(fileId));
    handle('matchReset', fileId => matcher.reset(fileId));
    handle('matchClear', () => matcher.clearAll());
    handle('saveCover', (id, sourceId, dataUrl, sourceUrl) => library.saveBackdrop(id, sourceId, dataUrl, 'cover', sourceUrl));
    handle('saveBackdrop', (id, sourceId, dataUrl) => library.saveBackdrop(id, sourceId, dataUrl));
    handle('import', async mode => {
        if (importing) throw new Error('正在导入，请稍候');
        importing = true;
        try {
            const selection = await choose({ title: mode === 'folder' ? '选择视频文件夹（包含子文件夹）' : '选择视频文件', properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS].map(x => x.slice(1)) }] });
            return selection.canceled ? null : await library.importPaths(selection.filePaths);
        } finally { importing = false; }
    });
    handle('update', (id, data) => library.update(id, data));
    handle('progress', (id, data) => library.progress(id, data));
    handle('remove', id => {
        if (importingActor) throw new Error('演员资料正在导入，请完成后再删除作品');
        library.remove(id);
        return { deletedVideoIds: [id] };
    });
    handle('addSource', async (id, label) => {
        library.get(id);
        const selection = await choose({ title: '选择对应清晰度的视频版本', properties: ['openFile'], filters: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS].map(x => x.slice(1)) }] });
        return selection.canceled ? null : library.addSource(id, selection.filePaths[0], label);
    });
    handle('removeSource', (id, sourceId) => library.removeSource(id, sourceId));
    handle('image', async (id, field) => {
        if (!['cover', 'backdrop'].includes(field)) throw new Error('图片类型无效');
        const selection = await choose({ title: field === 'cover' ? '选择海报 / 封面' : '选择首页背景', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
        if (selection.canceled) return null;
        const filename = selection.filePaths[0];
        const stat = await fs.stat(filename);
        if (stat.size > 8 * 1024 * 1024) throw new Error('请选择小于 8 MB 的图片');
        const extension = path.extname(filename).slice(1).toLowerCase();
        if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) throw new Error('图片格式无效');
        // Keep managed artwork outside JSON records: progress writes must stay small.
        const video = library.get(id);
        const artworkDir = path.join(path.dirname(store.path), 'resource-artwork');
        await fs.mkdir(artworkDir, { recursive: true });
        const destination = path.join(artworkDir, `${video.id}-${field}-${randomUUID()}.${extension}`);
        await fs.copyFile(filename, destination);
        video[field] = pathToFileURL(destination).href;
        return library.save(video);
    });
    // Existing records keep their NAS credentials. Register them before the first playback request.
    for (const video of library.list()) {
        for (const source of video.sources || []) {
            if (source?.url) {
                try { const u = new URL(source.url); if (u.username || u.password) rememberPlaybackCredentials(u); }
                catch (_) {}
            }
        }
    }

    return library;
}

module.exports = { ResourceLibrary, registerResourceStation };
