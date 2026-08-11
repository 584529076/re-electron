// test-novel-render-debug.js — 模拟 outline 生成后，验证 getNovel 返回的数据
// 不开 Electron，直接 require novel-engine + db.KVDb

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { KVDb } = require('./db');
const novelEngine = require('./novel-engine');

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 're-novel-render-'));
}

test('novel render debug: simulate outline generation → getNovel → 验证数据完整性', async () => {
    const dir = mkTmp();
    const dbPath = path.join(dir, 'novels.db');
    const store = new KVDb(dbPath);

    // 1. bootstrap engine（建表）
    const events = [];
    novelEngine.bootstrap({
        store,
        notify: (channel, payload) => events.push({ channel, payload }),
    });

    // 2. 创建小说
    const createRes = novelEngine.createNovel({
        title: '测试小说',
        style: '玄幻',
        custom_style: null,
        core_idea: '主角逆袭',
        pov: '第三人称',
        tone: '热血',
        target_word_count: 1000000,
        chapter_target_count: 30,
    });
    assert.equal(createRes.ok, true, 'createNovel should succeed');
    const novelId = createRes.novelId;
    console.log('[1] created novel:', novelId);

    // 3. 模拟 outline pipeline 完成后的存储（手动模拟引擎内部 SQL）
    // 直接调 updateOutline（与 _runOutlinePipeline 末尾的 SQL 等价）
    const outlineData = {
        structure: '三幕式：建置→对抗→结局',
        world_setting: '这是一个宏大的玄幻世界，有九重天。每一重天都有独特的法则和强者。主角从最低重天崛起，目标是登顶九重天。',
        main_conflict: '主角必须战胜最强的对手才能回家',
        themes: ['逆袭', '友情', '命运'],
        global_characters: JSON.stringify([
            { name: '林轩', role: '主角', description: '出身卑微', arc: '从弱到强' },
            { name: '苏晴', role: '女主', description: '神秘女子', arc: '帮助主角' },
        ]),
        chapter_list: JSON.stringify([
            { chapter_no: 1, title: '第一章', summary: '主角觉醒', target_word_count: 3000 },
            { chapter_no: 2, title: '第二章', summary: '遇到女主', target_word_count: 3000 },
            { chapter_no: 3, title: '第三章', summary: '首次战斗', target_word_count: 3000 },
        ]),
    };
    const updateRes = novelEngine.updateOutline(novelId, outlineData);
    assert.equal(updateRes.ok, true, 'updateOutline should succeed');
    console.log('[2] outline stored');

    // 4. 模拟创建 chapter 行（与引擎 _runOutlinePipeline 末尾等价）
    const chapters = JSON.parse(outlineData.chapter_list);
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, outline, target_word_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ch-test-1', novelId, 1, chapters[0].title, chapters[0].summary, chapters[0].target_word_count, 'pending'
    );
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, outline, target_word_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ch-test-2', novelId, 2, chapters[1].title, chapters[1].summary, chapters[1].target_word_count, 'pending'
    );
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, outline, target_word_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'ch-test-3', novelId, 3, chapters[2].title, chapters[2].summary, chapters[2].target_word_count, 'pending'
    );
    console.log('[3] chapters inserted');

    // 5. 关键测试：getNovel 返回的数据结构
    const getRes = novelEngine.getNovel(novelId);
    console.log('[4] getNovel result:', JSON.stringify({
        ok: getRes.ok,
        novel_exists: !!getRes.novel,
        outline_exists: !!getRes.outline,
        outline_keys: getRes.outline ? Object.keys(getRes.outline) : [],
        chapter_count: getRes.chapters ? getRes.chapters.length : 0,
    }, null, 2));

    assert.equal(getRes.ok, true, 'getNovel should succeed');
    assert.ok(getRes.novel, 'novel should exist');
    assert.ok(getRes.outline, 'outline should exist');
    assert.equal(getRes.chapters.length, 3, 'should have 3 chapters');

    // 6. 验证 outline 字段（这是渲染端期望的）
    const outline = getRes.outline;
    console.log('[5] outline fields:', {
        structure: outline.structure,
        world_setting_length: (outline.world_setting || '').length,
        themes_raw: outline.themes,                  // DB 存储的字符串
        global_characters_raw: outline.global_characters, // DB 存储的字符串
        chapter_list_raw: outline.chapter_list,     // DB 存储的字符串
    });

    // 7. 模拟渲染端 safeJson 解析
    const safeJson = (s) => {
        if (Array.isArray(s)) return s;
        if (typeof s !== 'string') return null;
        try { return JSON.parse(s); } catch { return null; }
    };

    const themes = safeJson(outline.themes);
    const chars = safeJson(outline.global_characters);
    const chapList = safeJson(outline.chapter_list);

    console.log('[6] parsed arrays:', {
        themes: themes,
        chars: chars,
        chapList: chapList,
    });

    assert.ok(Array.isArray(themes) && themes.length === 3, 'themes should parse');
    assert.ok(Array.isArray(chars) && chars.length === 2, 'chars should parse');
    assert.ok(Array.isArray(chapList) && chapList.length === 3, 'chapList should parse');

    // 8. 模拟 _renderWorkspace 检查
    const hasOutline = !!(outline && (outline.world_setting || outline.structure || outline.chapter_list));
    assert.equal(hasOutline, true, 'hasOutline should be true after outline stored');
    console.log('[7] workspace hasOutline:', hasOutline);

    console.log('\n✅ ALL ASSERTIONS PASSED — 数据流正确');
});