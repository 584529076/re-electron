'use strict';
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.wmv', '.ts']);
const CODE_RE = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,12}[-_]\d{2,7}(?:[-_]\d+)?)(?=$|[^A-Za-z0-9])/i;
const canonical = value => process.platform === 'win32' ? path.resolve(String(value)).toLowerCase() : path.resolve(String(value));
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const normalizeCode = value => String(value || '').toUpperCase().replace(/[_\s-]/g, '');
const extractCode = value => String(value || '').match(CODE_RE)?.[1]?.toUpperCase().replace(/_/g, '-') || '';
const normalizeText = value => String(value || '')
    .toLocaleLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function similarity(a, b) {
    const left = normalizeText(a), right = normalizeText(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const leftTokens = new Set(left.split(' ')), rightTokens = new Set(right.split(' '));
    const common = [...leftTokens].filter(x => rightTokens.has(x)).length;
    return common / Math.max(leftTokens.size, rightTokens.size);
}

function titleSimilarity(a, b) {
    const strip = value => normalizeText(String(value || '').replace(CODE_RE, ' ').replace(/\.(mp4|mkv|avi|wmv|mov|webm|m4v|ts)$/i, '').replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|h265)\b/gi, '')).replace(/\s/g, '');
    const left = strip(a), right = strip(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (Math.min(left.length, right.length) >= 6 && (left.includes(right) || right.includes(left))) return 0.95;
    const grams = text => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
    const l = grams(left), r = grams(right);
    return l.size && r.size ? 2 * [...l].filter(x => r.has(x)).length / (l.size + r.size) : 0;
}

// Compare the actor's catalog code with code-shaped tokens in each search result.
// Exact normalized codes rank first; small spelling differences remain reviewable.
function resultCodeSimilarity(code, result) {
    const target = normalizeCode(code);
    const tokens = [result.code || '', ...Array.from(`${result.title || ''} ${result.fileTitle || ''}`.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,12}[-_ ]?\d{2,7})(?=$|[^A-Za-z0-9])/g), match => match[1])].map(normalizeCode).filter(Boolean);
    let best = 0;
    for (const token of tokens) {
        if (token === target) return 1;
        if (token.match(/^[A-Z]+/)?.[0] !== target.match(/^[A-Z]+/)?.[0]) continue;
        let row = Array.from({ length: target.length + 1 }, (_, i) => i);
        for (let i = 1; i <= token.length; i++) {
            const next = [i];
            for (let j = 1; j <= target.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (token[i - 1] === target[j - 1] ? 0 : 1));
            row = next;
        }
        const score = 1 - row[target.length] / Math.max(target.length, token.length);
        if (score >= 0.7) best = Math.max(best, score);
    }
    return best;
}

class MatchAssistant {
    constructor({ store, library, actors, dialog, getWindow, sources = [] }) {
        this.store = store;
        this.library = library;
        this.actors = actors;
        this.dialog = dialog;
        this.getWindow = getWindow;
        this.sources = sources;
        store.exec('CREATE TABLE IF NOT EXISTS resource_match_files (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    }

    list() {
        return this.store.query('SELECT data FROM resource_match_files ORDER BY rowid DESC').map(row => JSON.parse(row.data));
    }

    get(id) {
        const row = this.store.query('SELECT data FROM resource_match_files WHERE id = ?', String(id))[0];
        if (!row) throw new Error('匹配记录不存在，请重新扫描');
        return JSON.parse(row.data);
    }

    save(file) {
        this.store.exec('UPDATE resource_match_files SET data=? WHERE id=?', JSON.stringify(file), file.id);
        return file;
    }

    async chooseFolders() {
        const answer = await this.dialog.showOpenDialog(this.getWindow(), {
            title: '选择演员文件夹',
            properties: ['openDirectory', 'multiSelections'],
            buttonLabel: '扫描'
        });
        return answer.canceled ? [] : answer.filePaths;
    }

    async scan(paths = []) {
        if (!paths.length) return { canceled: true, files: [] };
        const known = new Set(this.list().map(file => canonical(file.path)));
        const queue = paths.map(current => ({ current, actorHint: clean(path.basename(path.resolve(current)), 100) })), files = [];
        const errors = [];
        while (queue.length) {
            const { current, actorHint } = queue.pop();
            let stat;
            try { stat = await fs.lstat(current); } catch (error) { errors.push({ path: current, message: error.message }); continue; }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                let entries;
                try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (error) { errors.push({ path: current, message: error.message }); continue; }
                queue.push(...entries.filter(entry => entry.isDirectory() || (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))).map(entry => ({ current: path.join(current, entry.name), actorHint })));
                continue;
            }
            if (!stat.isFile() || !VIDEO_EXTENSIONS.has(path.extname(current).toLowerCase()) || known.has(canonical(current))) continue;
            const title = clean(path.basename(current, path.extname(current)), 200);
            const file = {
                id: randomUUID(),
                path: path.resolve(current),
                fileName: path.basename(current),
                title,
                code: extractCode(title),
                actorHint,
                actorId: '',
                size: stat.size,
                duration: 0,
                status: 'pending',
                candidates: [],
                confirmedVideoId: '',
                confirmedCandidate: null,
                scannedAt: Date.now()
            };
            const actorMatches = this.matchActors(actorHint);
            file.actorMatches = actorMatches;
            if (actorMatches.length === 1 && actorMatches[0].score >= 100) file.actorId = actorMatches[0].id;
            this.store.exec('INSERT OR IGNORE INTO resource_match_files(id,path,data) VALUES(?,?,?)', file.id, canonical(file.path), JSON.stringify(file));
            known.add(canonical(file.path));
            files.push(file);
        }
        return { canceled: false, files, errors };
    }

    matchActors(actorHint) {
        const actorList = this.actors?.list?.() || [];
        const hint = normalizeText(actorHint);
        if (!hint) return [];
        const exact = [], partial = [];
        for (const actor of actorList) {
            const names = [actor.name, ...(actor.aliases || [])].filter(name => normalizeText(name));
            const hit = names.find(name => normalizeText(name) === hint);
            if (hit) exact.push({ id: actor.id, name: actor.name, matched: hit, score: 100 });
            else if (names.some(name => normalizeText(name).includes(hint) || hint.includes(normalizeText(name)))) partial.push({ id: actor.id, name: actor.name, matched: names.find(name => normalizeText(name).includes(hint) || hint.includes(normalizeText(name))), score: 65 });
        }
        return [...exact, ...partial.filter(item => !exact.some(hit => hit.id === item.id))].slice(0, 10);
    }

    resolveActor(file) {
        const actors = this.actors.list();
        if (file.actorId) return actors.find(actor => actor.id === file.actorId) || null;
        const exact = this.matchActors(file.actorHint).filter(actor => actor.score === 100);
        return exact.length === 1 ? actors.find(actor => actor.id === exact[0].id) : null;
    }

    actorVideos(actor) {
        const names = new Set([actor.name, ...(actor.aliases || [])].map(normalizeText));
        return this.library.list().filter(video => video.code && (video.actors || []).some(name => names.has(normalizeText(name))));
    }

    selectActor(fileId, actorId) {
        const file = this.get(fileId);
        if (file.status === 'confirmed') throw new Error('已关联文件不能更换演员');
        this.actors.get(actorId);
        file.actorId = actorId;
        file.candidates = [];
        file.errors = [];
        file.status = 'pending';
        return this.save(file);
    }

    async webCandidates(file) {
        const results = [];
        for (const source of this.sources) {
            try {
                const found = await source.adapter.search(file.title, { limit: 25 });
                results.push(...found.map(candidate => ({ ...candidate, source: source.id, sourceLabel: source.label })));
            } catch (error) {
                results.push({ error: true, message: `${source.label}：${error.message}` });
            }
        }
        return results;
    }

    async suggest(fileId) {
        const file = this.get(fileId);
        if (file.status === 'confirmed') return file;
        file.actorMatches = this.matchActors(file.actorHint);
        const actor = this.resolveActor(file);
        file.candidates = [];
        file.errors = [];
        if (!actor) {
            file.status = 'actor_required';
            file.errors = ['文件夹名称未唯一匹配到数据库演员，请选择演员后重新搜索。'];
            return this.save(file);
        }
        file.actorId = actor.id;
        const videos = this.actorVideos(actor);
        const web = videos.length && this.sources.length ? await this.webCandidates(file) : [];
        const best = new Map();
        for (const candidate of web.filter(item => !item.error)) {
            for (const video of videos) {
                const codeScore = resultCodeSimilarity(video.code, candidate);
                if (!codeScore) continue;
                const titleScore = Math.max(titleSimilarity(file.title, candidate.title), titleSimilarity(file.title, candidate.fileTitle));
                const item = { id: randomUUID(), kind: 'local', videoId: video.id, actorId: actor.id,
                    actor: actor.name, code: video.code, title: file.title, libraryTitle: video.title,
                    resultTitle: candidate.title, fileTitle: candidate.fileTitle || '',
                    sourceLabel: candidate.sourceLabel, sourceUrl: candidate.sourceUrl || '',
                    codeScore, titleScore, score: Math.round(codeScore * 100) };
                const old = best.get(video.id);
                if (!old || item.codeScore > old.codeScore || (item.codeScore === old.codeScore && item.titleScore > old.titleScore)) best.set(video.id, item);
            }
        }
        const current = this.get(fileId);
        if (current.status === 'confirmed') return current;
        // An actor changed while the website request was in flight: discard stale results.
        if (current.actorId && current.actorId !== actor.id) return current;
        file.candidates = [...best.values()].sort((a, b) => b.codeScore - a.codeScore || b.titleScore - a.titleScore || a.code.localeCompare(b.code)).slice(0, 5);
        file.errors = web.filter(item => item.error).map(item => item.message);
        if (!videos.length) file.errors.push('该演员在数据库中没有带番号的作品。');
        else if (!this.sources.length) file.errors.push('没有配置搜索数据源。');
        file.status = 'candidates';
        file.matchedAt = Date.now();
        return this.save(file);
    }

    async confirmBatch(selections = []) {
        if (!Array.isArray(selections)) throw new Error('选择列表格式无效');
        const fileIds = new Set(), videoIds = new Set();
        for (const selected of selections) {
            if (!selected || fileIds.has(selected.fileId)) throw new Error('每个文件最多选择一个作品');
            if (videoIds.has(selected.videoId)) throw new Error('同一番号不能同时选择多个文件，请调整选择后确认');
            fileIds.add(selected.fileId); videoIds.add(selected.videoId);
            const file = this.get(selected.fileId);
            if (!VIDEO_EXTENSIONS.has(path.extname(file.path).toLowerCase()) || !(await fs.stat(file.path)).isFile()) throw new Error(`视频文件不存在：${file.path}`);
        }
        return this.store.transaction(() => {
            const saved = [];
            for (const selected of selections) {
                const file = this.get(selected.fileId);
                const candidate = file.candidates.find(item => item.id === selected.candidateId && item.videoId === selected.videoId);
                if (!candidate) throw new Error('候选已变化，请重新搜索并选择');
                const actor = this.resolveActor(file);
                const video = actor && this.actorVideos(actor).find(item => item.id === selected.videoId);
                if (!video || normalizeCode(candidate.code) !== normalizeCode(video.code)) throw new Error('演员或番号资料已变化，请重新匹配');
                const owner = this.library.list().find(item => item.sources.some(source => source.path && canonical(source.path) === canonical(file.path)));
                if (owner && owner.id !== video.id) throw new Error(`文件已绑定到 ${owner.code || owner.title}，请先处理原绑定`);
                if (!owner) {
                    const source = this.library.playbackSource(file.path);
                    source.label = '本地文件'; source.size = file.size;
                    video.sources.push(source);
                }
                video.title = file.title;
                this.library.save(video);
                file.confirmedVideoId = video.id;
                file.confirmedCandidate = candidate;
                file.status = 'confirmed'; file.confirmedAt = Date.now();
                saved.push(this.save(file));
            }
            return { confirmed: saved.length, files: saved };
        });
    }

    async confirm(fileId, videoId) {
        const candidate = this.get(fileId).candidates.find(item => item.videoId === videoId);
        if (!candidate) throw new Error('请先搜索并选择候选作品');
        return (await this.confirmBatch([{ fileId, videoId, candidateId: candidate.id }])).files[0];
    }

    reset(fileId) {
        const file = this.get(fileId);
        file.candidates = [];
        file.errors = [];
        file.status = 'pending';
        file.confirmedVideoId = '';
        file.confirmedCandidate = null;
        file.matchedAt = 0;
        file.confirmedAt = 0;
        return this.save(file);
    }

    clearAll() {
        this.store.exec('DELETE FROM resource_match_files');
        return { cleared: true };
    }

    ignore(fileId) {
        const file = this.get(fileId);
        file.status = 'ignored';
        file.confirmedVideoId = '';
        file.confirmedCandidate = null;
        return this.save(file);
    }
}

module.exports = { MatchAssistant, extractCode, titleSimilarity, resultCodeSimilarity };
