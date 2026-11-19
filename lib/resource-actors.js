'use strict';
const fs = require('fs/promises'), path = require('path');
const { randomUUID } = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const { validateUrl, download, parseHtml } = require('./dramaface');
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const names = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/)).map(x => clean(x, 100)).filter(Boolean))];
class ActorLibrary {
    constructor(store, videos) {
        this.store = store; this.videos = videos;
        this.directory = path.join(path.dirname(store.path), 'resource-artwork');
        store.exec('CREATE TABLE IF NOT EXISTS resource_actors (id TEXT PRIMARY KEY, name_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    }
    list() { return this.store.query('SELECT data FROM resource_actors ORDER BY rowid DESC').map(row => JSON.parse(row.data)); }
    get(id) { const row = this.store.query('SELECT data FROM resource_actors WHERE id = ?', String(id))[0]; if (!row) throw new Error('演员资料不存在'); return JSON.parse(row.data); }
    deletionPlan(target = {}) {
        const normalize = value => clean(value, 100).toLocaleLowerCase();
        let actor;
        if (target.id) actor = this.get(target.id);
        else {
            const name = clean(target.name, 100); if (!name) throw new Error('请选择要删除的演员');
            actor = this.list().find(a => [a.name, ...(a.aliases || [])].some(n => normalize(n) === normalize(name))) || { name, aliases: [] };
        }
        const associatedNames = new Set([actor.name, ...(actor.aliases || [])].map(normalize));
        const works = this.videos.list().filter(video => video.actors.some(n => associatedNames.has(normalize(n))));
        if (!actor.id && !works.length) throw new Error('演员及关联作品已不存在，请刷新列表');
        const videoIds = works.map(v => v.id).sort();
        return { id: actor.id || null, name: actor.name, videoIds, sharedCount: works.filter(v => v.actors.some(n => !associatedNames.has(normalize(n)))).length,
            signature: JSON.stringify([actor.id || null, actor.name, [...associatedNames].sort(), videoIds]) };
    }
    removeWithWorks(target, expectedSignature) {
        return this.store._db.transaction(() => {
            const plan = this.deletionPlan(target);
            if (!expectedSignature || plan.signature !== expectedSignature) throw new Error('演员或关联作品已变化，请重新点击删除并确认');
            for (const id of plan.videoIds) this.videos.remove(id);
            if (plan.id) this.store.exec('DELETE FROM resource_actors WHERE id = ?', plan.id);
            return { actorId: plan.id, name: plan.name, deletedVideoIds: plan.videoIds };
        })();
    }
    localImage(url) { if (!url) return ''; try { const file = fileURLToPath(url); if (path.dirname(path.resolve(file)) === path.resolve(this.directory)) return url; } catch {} throw new Error('请通过上传按钮选择演员图片'); }
    save(input) {
        const old = input.id ? this.get(input.id) : null;
        const name = clean(input.name, 100); if (!name) throw new Error('请填写演员姓名');
        const value = { ...(old || {}), id: old?.id || randomUUID(), name, updatedAt: Date.now() };
        for (const field of ['birthday', 'nationality', 'birthplace', 'height', 'gender', 'description']) value[field] = clean(input[field], field === 'description' ? 12000 : 200);
        value.aliases = names(input.aliases); value.cover = this.localImage(input.cover || '');
        value.photos = [...new Set((input.photos || []).map(url => this.localImage(url)))].slice(0, 100);
        value.sourceUrl = input.sourceUrl ? validateUrl(input.sourceUrl) : old?.sourceUrl || '';
        const duplicate = this.list().find(a => a.id !== value.id && (a.name.toLocaleLowerCase() === name.toLocaleLowerCase() || (value.sourceUrl && a.sourceUrl === value.sourceUrl)));
        if (duplicate) throw new Error('演员已存在，请编辑现有演员资料');
        this.store._db.transaction(() => {
            this.store.exec('INSERT INTO resource_actors(id,name_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name_key=excluded.name_key,data=excluded.data', value.id, name.toLocaleLowerCase(), JSON.stringify(value));
            if (old && old.name !== name) for (const video of this.videos.list()) if (video.actors.includes(old.name)) { video.actors = [...new Set(video.actors.map(n => n === old.name ? name : n))]; this.videos.save(video); }
        })();
        return value;
    }
    async storeImage(bytes) {
        const { nativeImage } = require('electron');
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error('图片格式无效');
        const size = image.getSize();
        const scaled = size.width > 2000 || size.height > 2000 ? image.resize(size.width >= size.height ? { width: 2000 } : { height: 2000 }) : image;
        await fs.mkdir(this.directory, { recursive: true });
        const destination = path.join(this.directory, `actor-${randomUUID()}.jpg`);
        await fs.writeFile(destination, scaled.toJPEG(88), { flag: 'wx' });
        return pathToFileURL(destination).href;
    }
    async upload(paths) {
        const results = [];
        for (const file of paths.slice(0, 100)) { if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('演员图片不能超过 8 MB'); results.push(await this.storeImage(await fs.readFile(file))); }
        return results;
    }
    async importUrl(address, progress = () => {}) {
        const url = validateUrl(address);
        progress('正在读取演员页面…');
        const page = await download(url), parsed = await parseHtml(page.bytes.toString('utf8'), page.url);
        const existing = this.list().find(a => a.sourceUrl === url || a.name.toLocaleLowerCase() === parsed.name.toLocaleLowerCase());
        const warnings = [], remoteImages = [...new Set([parsed.cover, ...parsed.photos].filter(Boolean))].slice(0, 101);
        const imageMap = { ...(existing?.imageMap || {}) }; let cursor = 0, completed = 0;
        await Promise.all(Array.from({ length: 3 }, async () => {
            while (cursor < remoteImages.length) {
                const source = remoteImages[cursor++];
                try { if (!imageMap[source]) imageMap[source] = await this.storeImage((await download(source, true)).bytes); }
                catch (error) { warnings.push(`图片未缓存：${source}（${error.message}）`); }
                completed++; progress(`正在缓存图片 ${completed}/${remoteImages.length}…`);
            }
        }));
        // Re-read existing actor after downloads; preserve edits made while the import was running.
        const latest = existing ? this.get(existing.id) : null;
        const input = { ...parsed, id: latest?.id, cover: latest?.cover || imageMap[parsed.cover] || '', photos: [...new Set([...(latest?.photos || []), ...parsed.photos.map(url => imageMap[url]).filter(Boolean)])] };
        if (latest) for (const key of ['name','aliases','birthday','nationality','birthplace','height','gender','description']) if (latest[key]?.length) input[key] = latest[key];
        progress('正在保存演员和作品资料…');
        let actor, added = 0;
        this.store._db.transaction(() => {
            actor = this.save(input); actor.details = { ...parsed.details, ...latest?.details }; actor.imageMap = imageMap;
            this.store.exec('UPDATE resource_actors SET data=? WHERE id=?', JSON.stringify(actor), actor.id);
            for (const work of parsed.works) { const result = this.videos.addMetadata({ ...work, actors: [actor.name], sourceUrl: url }, true); if (result.added) added++; }
        })();
        return { actor, added, totalWorks: parsed.works.length, warnings };
    }
}
module.exports = { ActorLibrary };
