// test-novel-chapter-pipeline-mock.js — mock LLM，跑完整 chapter pipeline，验证事件流 + 数据持久化

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { KVDb } = require('./db');
const novelEngine = require('./novel-engine');
const novel = require('./novel');

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 're-novel-ch-pipeline-'));
}

// Mock novel.generateStream：模拟真实 validate 行为，必须 onChunk 是函数
const _origGenerateStream = novel.generateStream;
novel.generateStream = async (opts, onChunk) => {
    // 模拟真实 novel.generateStream 的 onChunk 必填校验（line 294）
    if (typeof onChunk !== 'function') {
        throw new Error('novel.generateStream: onChunk 必填');
    }
    const user = opts.user || '';
    const sys = opts.system || '';
    let text = '';
    const sysHint = sys.slice(0, 30);

    // 场景规划师
    if (sys.includes('场景规划师') || user.includes('【本章任务】')) {
        text = JSON.stringify({
            scenes: [
                { index: 1, goal: '主角登场', conflict: '内心挣扎', charactersInvolved: ['测试主角'], keyDialogue: '', transition: '' },
                { index: 2, goal: '冲突展开', conflict: '外部威胁', charactersInvolved: ['测试主角'], keyDialogue: '', transition: '' },
            ],
            totalEstimatedWords: 3000,
        });
    }
    // 章节写作（流式）
    else if (sys.includes('专业小说家')) {
        text = '## 测试章1\n\n这是测试章节的第一段。主角登场，背景说明。\n\n这是第二段。冲突开始展开。\n\n这是第三段。高潮与转折。';
    }
    // 连续性审查
    else if (sys.includes('连续性审查员')) {
        text = JSON.stringify({ approved: true, issues: [], summary: 'OK' });
    }
    // 文风编辑
    else if (sys.includes('文风编辑')) {
        text = JSON.stringify({ approved: true, toneScore: 8, issues: [], suggestions: '' });
    }
    // 质量评审
    else if (sys.includes('小说质量评审')) {
        text = JSON.stringify({ approved: true, score: 8, pacing: 8, grammar: 8, immersion: 8, hook: 8, feedback: 'OK' });
    }
    // Phase 4-C: 圣经 3 个 updater
    else if (sys.includes('人物状态追踪员')) {
        text = JSON.stringify({
            updates: [
                { name: '测试主角', status: 'alive', location: '测试地点', motivation: '推进剧情', knowledge: '发现秘密', relationship_changes: '与师父关系变化' },
            ],
        });
    } else if (sys.includes('剧情进度追踪员')) {
        text = JSON.stringify({
            threads: [
                { id: 'PT001', current_ch: 1, progress_pct: 30, last_event: '本章关键事件' },
            ],
            new_threads: [],
        });
    } else if (sys.includes('伏笔追踪员')) {
        text = JSON.stringify({
            planted: [
                { id: 'F001', description: '本章埋设的伏笔', planted_ch: 1, payoff_ch_estimate: 10, status: 'planted' },
            ],
            paid: [],
        });
    } else {
        text = JSON.stringify({});
    }

    if (onChunk) onChunk(text, text);
    return { text, prompt_tokens: 100, completion_tokens: 100, cost_usd: 0.001, duration_ms: 100, estimated: false };
};

// Mock novel.generate（用于章节摘要生成）
const _origGenerate = novel.generate;
novel.generate = async (opts) => {
    return { text: '本章测试摘要。', prompt_tokens: 50, completion_tokens: 50, cost_usd: 0.0005, duration_ms: 50, estimated: false };
};

test('full chapter pipeline (mock LLM): 验证事件流 + 数据持久化 + 生命周期', async () => {
    const dir = mkTmp();
    const dbPath = path.join(dir, 'novels.db');
    const store = new KVDb(dbPath);

    const events = [];
    novelEngine.bootstrap({
        store,
        notify: (channel, payload) => events.push({ channel, payload }),
    });

    // 配置 provider
    novelEngine.setProviderConfig({
        provider: 'mock',
        model: 'mock-model',
        temperature: 0.5,
        max_tokens: 4000,
    });

    // 1. 创建小说
    const createRes = novelEngine.createNovel({
        title: '章节 pipeline 测试',
        style: '玄幻',
        custom_style: null,
        core_idea: '测试',
        pov: '第三人称',
        tone: '热血',
        target_word_count: 100000,
        chapter_target_count: 2,
    });
    const novelId = createRes.novelId;

    // 2. 直接写入 outline（跳过 outline pipeline，专注于 chapter pipeline 验证）
    store.exec(
        `INSERT INTO _ainovel_outlines (novel_id, structure, world_setting, main_conflict, themes, global_characters, chapter_list, raw_outline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        novelId,
        '三幕式',
        '测试世界观',
        '测试冲突',
        JSON.stringify(['测试主题']),
        JSON.stringify([{ name: '测试主角', role: '主角', description: '测试', arc: '成长' }]),
        JSON.stringify([
            { chapter_no: 1, title: '测试章1', summary: '主角登场', target_word_count: 3000 },
            { chapter_no: 2, title: '测试章2', summary: '冲突展开', target_word_count: 3000 },
        ]),
        'mock outline'
    );

    // 3. 创建 chapter 行
    const { KVDb: _ignore } = { KVDb }; // noop for require already loaded
    const chapterRows = store.query('SELECT * FROM _ainovel_chapters WHERE novel_id = ? ORDER BY chapter_no', novelId);
    assert.equal(chapterRows.length, 0, 'chapters should not be pre-created when we wrote outline manually');

    // 手动创建 chapter 行（outline pipeline 才会批量创建）
    const crypto = require('crypto');
    const chapterId = crypto.randomUUID();
    store.exec(
        `INSERT INTO _ainovel_chapters (id, novel_id, chapter_no, title, outline, target_word_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        chapterId,
        novelId,
        1,
        '测试章1',
        '主角登场',
        3000,
        'pending'
    );
    novelEngine.dropContext(novelId); // 让新 chapter 被加载

    // 4. 跑 chapter pipeline
    console.log('[start] chapter pipeline for chapter 1...');
    let result;
    try {
        result = await novelEngine.callSkill('chapter-writer', { novelId, chapterId }, { novelId });
        console.log('[done] ok:', result && result.ok, 'words:', result && result.word_count);
    } catch (e) {
        console.error('[failed]', e.message);
        console.error('event 流:', events.map(e => `${e.payload.type}${e.payload.kind ? '/' + e.payload.kind : ''}${e.payload.agentName ? ' (' + e.payload.agentName + ')' : ''}${e.payload.pipeline ? ' [' + e.payload.pipeline + ']' : ''}`).join('\n'));
        throw e;
    }

    // 5. 列出关键事件
    console.log('\n=== 事件流（关键节点）===');
    const keyEvents = events.filter(e =>
        ['pipeline_started', 'pipeline_finished', 'pipeline_failed',
         'phase_started', 'phase_finished',
         'agent_started', 'agent_finished',
         'chapter_generated'].includes(e.payload.type)
    );
    keyEvents.forEach((e, i) => {
        const p = e.payload;
        const tag = [
            p.type,
            p.pipeline ? `[${p.pipeline}]` : '',
            p.phaseName || '',
            p.phaseIndex != null ? `#${p.phaseIndex}` : '',
            p.agentName || '',
            p.round != null && p.round > 1 ? `round=${p.round}` : '',
        ].filter(Boolean).join(' ');
        console.log(`  ${i + 1}. ${tag}`);
    });

    // ===== 断言 1：pipeline_started 只发一次 =====
    const pipelineStarted = events.filter(e => e.payload.type === 'pipeline_started' && e.payload.pipeline === 'chapter');
    assert.equal(pipelineStarted.length, 1, 'pipeline_started must emit exactly once for chapter pipeline');
    console.log(`\n✅ pipeline_started 只发一次（共 ${pipelineStarted.length} 次）`);

    // ===== 断言 2：pipeline_finished 只发一次 =====
    const pipelineFinished = events.filter(e => e.payload.type === 'pipeline_finished' && e.payload.pipeline === 'chapter');
    assert.equal(pipelineFinished.length, 1, 'pipeline_finished must emit exactly once for chapter pipeline');
    console.log(`✅ pipeline_finished 只发一次（共 ${pipelineFinished.length} 次）`);

    // ===== 断言 3：chapter_generated 在 pipeline_finished 之后 =====
    const finishedIdx = events.findIndex(e => e.payload.type === 'pipeline_finished' && e.payload.pipeline === 'chapter');
    const generatedIdx = events.findIndex(e => e.payload.type === 'chapter_generated');
    assert.ok(finishedIdx >= 0, 'pipeline_finished must exist');
    assert.ok(generatedIdx >= 0, 'chapter_generated must exist');
    assert.ok(generatedIdx > finishedIdx, `chapter_generated (${generatedIdx}) must come after pipeline_finished (${finishedIdx})`);
    console.log(`✅ 事件顺序正确：pipeline_finished(${finishedIdx}) → chapter_generated(${generatedIdx})`);

    // ===== 断言 4：scene-planner 跑在 chapter-streamer 之前 =====
    const scenePlannerStart = events.findIndex(e => e.payload.type === 'agent_started' && e.payload.agentName === 'scene-planner');
    const chapterStreamerStart = events.findIndex(e => e.payload.type === 'agent_started' && e.payload.agentName === 'chapter-streamer');
    assert.ok(scenePlannerStart >= 0, 'scene-planner must start');
    assert.ok(chapterStreamerStart >= 0, 'chapter-streamer must start');
    assert.ok(scenePlannerStart < chapterStreamerStart, 'scene-planner must run before chapter-streamer');
    console.log(`✅ 阶段顺序正确：scene-planner(${scenePlannerStart}) → chapter-streamer(${chapterStreamerStart})`);

    // ===== 断言 5：3 个 reviewer 在 chapter-streamer 之后 =====
    const reviewerStartIdx = events.findIndex(e =>
        e.payload.type === 'agent_started' &&
        ['continuity-checker', 'style-editor', 'quality-reviewer'].includes(e.payload.agentName)
    );
    const chapterStreamerFinishIdx = events.findIndex(e =>
        e.payload.type === 'agent_finished' && e.payload.agentName === 'chapter-streamer'
    );
    assert.ok(reviewerStartIdx > chapterStreamerFinishIdx, 'reviewers must start after chapter-streamer finished');
    console.log(`✅ 评审阶段顺序正确：chapter-streamer 完成后才启动 reviewer(${reviewerStartIdx})`);

    // ===== 断言 6：所有 reviewer 在 pipeline_finished 之前完成 =====
    const reviewerFinishIdxs = events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.payload.type === 'agent_finished' &&
            ['continuity-checker', 'style-editor', 'quality-reviewer'].includes(e.payload.agentName))
        .map(({ i }) => i);
    assert.ok(reviewerFinishIdxs.length >= 3, 'all 3 reviewers must finish');
    for (const idx of reviewerFinishIdxs) {
        assert.ok(idx < finishedIdx, `reviewer finish(${idx}) must come before pipeline_finished(${finishedIdx})`);
    }
    console.log(`✅ 所有 reviewer 完成早于 pipeline_finished`);

    // ===== 断言 7：phase index 唯一（不重复）=====
    const phaseStartIdxs = events
        .filter(e => e.payload.type === 'phase_started')
        .map(e => e.payload.phaseIndex);
    const uniqueIdxs = new Set(phaseStartIdxs);
    assert.equal(uniqueIdxs.size, phaseStartIdxs.length, `phase index must be unique, got [${phaseStartIdxs.join(',')}]`);
    console.log(`✅ phase index 唯一：[${phaseStartIdxs.join(', ')}]`);

    // ===== 断言 8：章节内容已持久化 =====
    const chapterRow = store.query('SELECT * FROM _ainovel_chapters WHERE id = ?', chapterId)[0];
    assert.ok(chapterRow, 'chapter row must exist');
    assert.equal(chapterRow.status, 'done', 'chapter status must be done');
    assert.ok(chapterRow.content && chapterRow.content.length > 0, 'chapter content must be persisted');
    assert.ok(chapterRow.actual_word_count > 0, `actual_word_count must be > 0, got ${chapterRow.actual_word_count}`);
    console.log(`\n✅ 数据正确持久化：status=${chapterRow.status}, 字数=${chapterRow.actual_word_count}`);

    // ===== 断言 9：current_word_count 已更新 =====
    const novelRow = store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0];
    assert.ok(novelRow.current_word_count > 0, 'novel current_word_count must be > 0');
    console.log(`✅ 小说累计字数已更新：${novelRow.current_word_count}`);

    // ===== 断言 10：Phase 4-B：圣经已提交 =====
    const stateRes = novelEngine.getNovelState(novelId);
    assert.ok(stateRes.ok, 'getNovelState should be ok');
    assert.ok(stateRes.state, 'state should exist');
    assert.equal(stateRes.state.last_chapter_no, 1, 'last_chapter_no should be 1');
    assert.ok(stateRes.state.expected_revision >= 1, `expected_revision must be >= 1, got ${stateRes.state.expected_revision}`);
    console.log(`\n✅ 圣经已原子提交：rev=${stateRes.state.expected_revision}, last_ch=${stateRes.state.last_chapter_no}`);

    // ===== 断言 11：Phase 4-C：圣经内含人物/子线/伏笔 =====
    assert.ok(stateRes.state.character_states && Object.keys(stateRes.state.character_states).length > 0, 'character_states should have entries');
    assert.ok(Array.isArray(stateRes.state.active_plot_threads) && stateRes.state.active_plot_threads.length > 0, 'active_plot_threads should have entries');
    assert.ok(Array.isArray(stateRes.state.planted_foreshadowing) && stateRes.state.planted_foreshadowing.length > 0, 'planted_foreshadowing should have entries');
    console.log(`✅ 圣经数据完整：${Object.keys(stateRes.state.character_states).length} 人物 / ${stateRes.state.active_plot_threads.length} 子线 / ${stateRes.state.planted_foreshadowing.length} 伏笔`);

    // ===== 断言 12：Phase 4-C：bible_committed 事件已 emit =====
    const bibleCommitted = events.find(e => e.payload.type === 'bible_committed');
    assert.ok(bibleCommitted, 'bible_committed event must be emitted');
    assert.equal(bibleCommitted.payload.novelId, novelId, 'bible_committed novelId');
    assert.equal(bibleCommitted.payload.chapterId, chapterId, 'bible_committed chapterId');
    assert.ok(bibleCommitted.payload.revision >= 1, 'revision in event');
    console.log(`✅ bible_committed 事件已 emit (rev ${bibleCommitted.payload.revision})`);

    // ===== 断言 13：chapter_generated 含 bibleUpdated =====
    const chapterGen = events.find(e => e.payload.type === 'chapter_generated');
    assert.ok(chapterGen, 'chapter_generated must exist');
    assert.equal(chapterGen.payload.bibleUpdated, true, 'bibleUpdated must be true');
    console.log(`✅ chapter_generated.bibleUpdated = true`);

    console.log('\n🎉 完整 chapter pipeline（Phase 4-A/B/C/D 全链路）流程正确');
});

// 清理 mock
test.after(() => {
    novel.generateStream = _origGenerateStream;
    novel.generate = _origGenerate;
});