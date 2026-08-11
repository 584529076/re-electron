// test-overseer-mock.js — Sprint H+: 编剧全程监督（oversight）核心逻辑
// 覆盖：解析器白名单 / 防注入 / 防死循环 / 暂停 / 重写 / 中止
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');
const novelEngine = require('./novel-engine');

class TestStore {
    constructor(dbPath) {
        this.path = dbPath;
        this._db = new DatabaseSync(dbPath);
    }
    exec(sql, ...params) {
        const info = this._db.prepare(sql).run(...params);
        const lid = info.lastInsertRowid;
        return { changes: Number(info.changes), lastInsertRowid: typeof lid === 'bigint' ? Number(lid) : lid };
    }
    query(sql, ...params) {
        return this._db.prepare(sql).all(...params).map(r => Object.assign({}, r));
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-overseer-'));
const store = new TestStore(path.join(TMP, 'test.sqlite'));
novelEngine.bootstrap({ store, notify: () => {} });
novelEngine._storeRootForMemory = TMP;
const NOVEL = 'novel-overseer';

process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ============ 解析器 ============

test('O1: _parseOversightDecision 解析合法 JSON', () => {
    const text = '思考了一下...\n<<<OVERSEERS>>>{"action":"continue","reason":"一切正常","note":""}<<<END>>>\nEND';
    const d = novelEngine._parseOversightDecision(text);
    assert.equal(d.action, 'continue');
    assert.equal(d.reason, '一切正常');
    assert.equal(d.note, '');
});

test('O1: _parseOversightDecision 解析各 action', () => {
    for (const a of ['continue', 'pause', 'rewrite_last', 'inject_note', 'abort']) {
        const text = `<<<OVERSEERS>>>{"action":"${a}","reason":"r","note":"n"}<<<END>>>`;
        const d = novelEngine._parseOversightDecision(text);
        assert.equal(d.action, a, `${a} 应被接受`);
    }
});

test('O1: _parseOversightDecision 非法 action 回落 continue', () => {
    const text = `<<<OVERSEERS>>>{"action":"delete_everything","reason":"r","note":""}<<<END>>>`;
    const d = novelEngine._parseOversightDecision(text);
    assert.equal(d.action, 'continue', '非法 action 必须回落');
});

test('O1: _parseOversightDecision 坏 JSON 回落 continue', () => {
    const text = `<<<OVERSEERS>>>{这不是JSON}<<<END>>>`;
    const d = novelEngine._parseOversightDecision(text);
    assert.equal(d.action, 'continue');
    assert.ok(/parse/.test(d.reason), 'reason 说明解析失败');
});

test('O1: _parseOversightDecision 无标记回落 continue', () => {
    const d = novelEngine._parseOversightDecision('我先思考一下再说');
    assert.equal(d.action, 'continue');
    assert.ok(/no decision marker/.test(d.reason));
});

test('O1: _parseOversightDecision reason/note 长度截断', () => {
    const longReason = 'r'.repeat(500);
    const longNote = 'n'.repeat(800);
    const text = `<<<OVERSEERS>>>{"action":"continue","reason":"${longReason}","note":"${longNote}"}<<<END>>>`;
    const d = novelEngine._parseOversightDecision(text);
    assert.ok(d.reason.length <= 200, `reason 截断到 ≤200，实际 ${d.reason.length}`);
    assert.ok(d.note.length <= 500, `note 截断到 ≤500，实际 ${d.note.length}`);
});

test('O1: _parseOversightDecision 输入空字符串/null 不崩（返回 null 让上层 fallback）', () => {
    assert.equal(novelEngine._parseOversightDecision(''), null);
    assert.equal(novelEngine._parseOversightDecision(null), null);
    assert.equal(novelEngine._parseOversightDecision(undefined), null);
});

// ============ 决策应用：continue / pause / inject_note / abort ============

test('O2: _applyOversightDecision continue 不改状态', async () => {
    const s = novelEngine._ensureAuto(NOVEL);
    s.active = true;
    s.paused = false;
    const r = await novelEngine._applyOversightDecision(NOVEL, { action: 'continue', reason: '', note: '' });
    assert.equal(r, 'continue');
    assert.equal(s.paused, false);
    s.active = false;
});

test('O2: _applyOversightDecision pause 设置 paused=true', async () => {
    const s = novelEngine._ensureAuto(NOVEL);
    s.active = true; s.paused = false;
    const r = await novelEngine._applyOversightDecision(NOVEL, { action: 'pause', reason: '剧情跑偏', note: '' });
    assert.equal(r, 'pause');
    assert.equal(s.paused, true, 'pause 后 paused=true');
    s.active = false;
});

test('O2: _applyOversightDecision inject_note 写入黑板', async () => {
    const before = novelEngine.blackboardList(NOVEL).items.length;
    const r = await novelEngine._applyOversightDecision(NOVEL, {
        action: 'inject_note', reason: '补充设定', note: '林晚左眼有旧伤疤',
    });
    assert.equal(r, 'continue');
    const after = novelEngine.blackboardList(NOVEL).items.length;
    assert.equal(after, before + 1, '黑板多一条');
    // 直接查 overseer_note_* 写入的那一条（避免排序问题）
    const items = novelEngine.blackboardList(NOVEL).items;
    const overseerNote = items.find(it => String(it.key).startsWith('overseer_note_'));
    assert.ok(overseerNote, '应存在 overseer_note_* 条目');
    assert.equal(overseerNote.value, '林晚左眼有旧伤疤');
    assert.equal(overseerNote.owner, 'auto-overseer');
});

test('O2: _applyOversightDecision abort 终止并清 active', async () => {
    const s = novelEngine._ensureAuto(NOVEL);
    s.active = true;
    const r = await novelEngine._applyOversightDecision(NOVEL, { action: 'abort', reason: '检测到死循环', note: '' });
    assert.equal(r, 'abort');
    assert.equal(s.active, false, 'abort 后 active=false');
});

// ============ 决策应用：rewrite_last + 防死循环 ============

test('O3: _applyOversightDecision rewrite_last 把最近 done 章改回 pending', async () => {
    // setup：写一个 novel + 一章 done
    store.exec(
        `INSERT INTO _ainovel_novels (id, title, core_idea, target_word_count, status) VALUES (?, ?, ?, ?, ?)`,
        'novel-rw', '测试', '点子', 100000, 'writing'
    );
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, status, actual_word_count)
         VALUES (?, ?, ?, ?, 'done', 2000)`,
        'ch-1', 'novel-rw', 1, '第 1 章'
    );
    const s = novelEngine._ensureAuto('novel-rw');
    s.active = true; s.completedChapters = 1;

    const r = await novelEngine._applyOversightDecision('novel-rw', {
        action: 'rewrite_last', reason: '主角人设漂移',
        note: '林晚应该更冷峻，禁止撒娇',
    });
    assert.equal(r, 'continue', 'rewrite_last 返回 continue 让 loop 继续');

    // 章节应该变回 pending
    const ch = store.query(`SELECT status FROM _ainovel_chapters WHERE id = 'ch-1'`)[0];
    assert.equal(ch.status, 'pending', '章节被重置为 pending');

    // 黑板应有 overseer_rewrite_ch1 注入
    const bb = novelEngine.blackboardRead('novel-rw', 'overseer_rewrite_ch1');
    assert.ok(bb && bb.ok && bb.value.includes('林晚应该更冷峻'));

    // completedChapters 应该 -1
    assert.equal(s.completedChapters, 0, 'completedChapters 已减 1');
    s.active = false;
});

test('O3: _applyOversightDecision rewrite_last 防死循环（同一章连续 3 次自动 continue）', async () => {
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, status, actual_word_count)
         VALUES (?, ?, ?, ?, 'done', 2000)`,
        'ch-loop', 'novel-rw', 2, '第 2 章'
    );
    const s = novelEngine._ensureAuto('novel-rw');
    s.active = true; s.completedChapters = 1;
    s.lastRewriteChapterNo = 2;
    s.lastRewriteCount = 2;  // 已经连续 2 次重写第 2 章

    const r = await novelEngine._applyOversightDecision('novel-rw', {
        action: 'rewrite_last', reason: '还是不满意', note: '再改',
    });
    assert.equal(r, 'continue', '防死循环触发，回落 continue');

    // 章节不应该被重置（因为被防住）
    const ch = store.query(`SELECT status FROM _ainovel_chapters WHERE id = 'ch-loop'`)[0];
    assert.equal(ch.status, 'done', '防死循环时章节保持 done');
    s.active = false;
});

test('O3: rewrite_last 切换到新章节号时重置计数', async () => {
    const s = novelEngine._ensureAuto('novel-rw');
    s.active = true; s.lastRewriteChapterNo = 1; s.lastRewriteCount = 5;

    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, status, actual_word_count)
         VALUES (?, ?, ?, ?, 'done', 2000)`,
        'ch-3', 'novel-rw', 3, '第 3 章'
    );

    await novelEngine._applyOversightDecision('novel-rw', {
        action: 'rewrite_last', reason: 'r', note: 'n',
    });
    assert.equal(s.lastRewriteChapterNo, 3, '章节号已切换');
    assert.equal(s.lastRewriteCount, 1, '新章节号，计数重置为 1');

    const ch = store.query(`SELECT status FROM _ainovel_chapters WHERE id = 'ch-3'`)[0];
    assert.equal(ch.status, 'pending', '新章节被重置');
    s.active = false;
});

// ============ _runOversight 在没有 LLM 配置时安全返回 null ============

test('O4: _runOversight 无 provider 配置时返回 null', async () => {
    // 当前 store 没 provider → 应安全返回 null
    const d = await novelEngine._runOversight(NOVEL, { afterChapterNo: 1 });
    assert.equal(d, null, '无 provider 时静默跳过 oversight');
});

// ============ 清理 ============

test('O-cleanup: deleteNovel 清理 _autoState', () => {
    // _autoState 是 Map，不在 DB 里，进程退出时自然清理；这里只测基础 deleteNovel 仍然 ok
    const r = novelEngine.deleteNovel(NOVEL);
    assert.equal(r.ok, true);
});