// test-novel-pipeline-mock.js — mock LLM，跑完整 outline pipeline，验证事件流 + 数据持久化

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 're-novel-pipeline-'));
}

// Mock novel.generateStream：返回固定 JSON
const _origGenerate = novel.generateStream;
novel.generateStream = async (opts, onChunk) => {
    const user = opts.user || '';
    const sys = opts.system || '';
    let text = '';
    // 调试：看每个 agent 实际传入什么
    const sysHint = sys.slice(0, 30);
    console.log(`[mock] agent call: system="${sysHint}..." user="${user.slice(0, 40)}..."`);
    // 评审 agent：单独匹配（任何含「评估维度」「资深文学编辑」「审查」关键词都当 reviewer）
    if (sys.includes('资深文学编辑') || sys.includes('审查') || user.includes('【评估维度】') || user.includes('【当前大纲】')) {
        text = JSON.stringify({
            approved: true,
            score: 8,
            feedback: [{ issue: '测试', severity: 'low', suggestion: '无' }],
        });
    } else if (sys.includes('资深故事架构师') || user.includes('【已合成大纲】')) {
        // Phase 4-A: story-architect
        text = JSON.stringify({
            three_act: '【第一幕·建置】起止章节 1-3，主角登场。【第二幕·对抗】起止章节 4-8，冲突升级。【第三幕·结局】起止章节 9-10，高潮收束。',
            plot_threads: [
                { id: 'PT001', name: '主线', description: '测试主线', intro_ch: 1, resolve_ch: 10, status: 'active' },
                { id: 'PT002', name: '副线', description: '测试副线', intro_ch: 2, resolve_ch: 9, status: 'active' },
            ],
            character_arcs: [
                { name: '测试主角', start: '初始', midpoint: '转折', end: '成长' },
            ],
            theme_tracks: [
                { theme: '命运', act1_manifestation: 'A1', act2_manifestation: 'A2', act3_manifestation: 'A3' },
            ],
            foreshadowing_seed: [
                { id: 'F001', description: '主角玉佩预示身世', planted_chapter_estimate: 1, payoff_chapter_estimate: 10 },
            ],
        });
    } else if (sys.includes('资深小说策划师') || sys.includes('大纲综合') || user.includes('【上次评审反馈】')) {
        // 大纲综合 synthesizer — 优先于风格匹配（synthesizer user 也含【小说基本信息】）
        text = JSON.stringify({
            structure: '三幕式',
            world_setting: '这是一个测试世界观',
            main_conflict: '测试冲突',
            themes: ['测试主题1', '测试主题2'],
            global_characters: [
                { name: '测试主角', role: '主角', description: '测试', arc: '成长' },
            ],
            chapter_list: [
                { chapter_no: 1, title: '测试章1', summary: '测试', target_word_count: 3000 },
                { chapter_no: 2, title: '测试章2', summary: '测试', target_word_count: 3000 },
            ],
            selectionRationale: '测试',
        });
    } else if (sys.includes('场景规划师') || sys.includes('场景') || user.includes('【场景')) {
        text = JSON.stringify({
            scenes: [
                { index: 1, goal: '目标', conflict: '张力', charactersInvolved: ['主角'], keyDialogue: '', transition: '' },
            ],
        });
    } else if (user.includes('【小说基本信息】') || sys.includes('文学风格分析师') || sys.includes('风格')) {
        // 风格分析师
        text = JSON.stringify({
            styleAttributes: ['冷硬', '诗意'],
            comparableReferences: ['《雪国》'],
            narrativeVoice: '克制的第一人称',
            vocabularyHints: [],
            avoidances: [],
        });
    } else if (sys.includes('世界设定') || user.includes('【世界设定任务】')) {
        text = JSON.stringify({
            candidates: [
                { name: '候选世界A', era: '现代', setting: '城市', specialRules: '无', hook: '主角觉醒', conflictPotential: 'A vs B' },
            ],
        });
    } else if (sys.includes('人物设计') || user.includes('【人物设计任务】')) {
        text = JSON.stringify({
            candidates: [
                { name: '候选主角A', role: '主角', archetype: '英雄', psychology: '内向', motivation: '复仇', arc: '成长', description: '测试' },
            ],
        });
    } else if (sys.includes('主题') || user.includes('【主题任务】')) {
        text = JSON.stringify({
            themes: ['命运', '选择'],
            motifs: ['镜子', '雨'],
            symbolicElements: ['光', '暗'],
        });
    } else if (sys.includes('剧情') || user.includes('【剧情任务】')) {
        text = JSON.stringify({
            candidates: [
                { name: '剧情A', structure: '线性', mainConflict: 'A vs B', keyBeats: ['起', '承', '转', '合'], arcForCharacters: '主角成长' },
            ],
        });
    } else {
        // 默认 fallback：返回有效 JSON，让 skill 不报错
        text = JSON.stringify({});
    }
    if (onChunk) onChunk(text, text);
    return { text, prompt_tokens: 100, completion_tokens: 100, cost_usd: 0.001, duration_ms: 100 };
};

test('full outline pipeline (mock LLM): 验证事件流 + 数据持久化', async () => {
    const dir = mkTmp();
    const dbPath = path.join(dir, 'novels.db');
    const store = new KVDb(dbPath);

    const events = [];
    novelEngine.bootstrap({
        store,
        notify: (channel, payload) => events.push({ channel, payload }),
    });

    // 配置 provider（mock 必需）
    novelEngine.setProviderConfig({
        provider: 'mock',
        model: 'mock-model',
        temperature: 0.5,
        max_tokens: 4000,
    });

    // 创建小说
    const createRes = novelEngine.createNovel({
        title: '完整 pipeline 测试',
        style: '玄幻',
        custom_style: null,
        core_idea: '测试',
        pov: '第三人称',
        tone: '热血',
        target_word_count: 100000,
        chapter_target_count: 2,
    });
    const novelId = createRes.novelId;
    console.log('[1] novel:', novelId);

    // 跑 outline pipeline
    console.log('[2] 开始跑 outline pipeline（mock）...');
    try {
        // 通过 outline-architect skill 调用（thin wrapper → _runOutlinePipeline）
        const result = await novelEngine.callSkill('outline-architect', { novelId }, { novelId });
        console.log('[3] pipeline 完成，result ok:', result && result.ok);
    } catch (e) {
        console.error('[3] pipeline 失败:', e.message);
        console.error('event 流:', events.map(e => `${e.channel}/${e.payload.type}`).join('\n'));
        throw e;
    }

    // 列出所有事件
    console.log('\n=== 事件流 ===');
    events.forEach((e, i) => {
        console.log(`  ${i+1}. ${e.payload.type}${e.payload.kind ? '/' + e.payload.kind : ''}${e.payload.agentName ? ' (' + e.payload.agentName + ')' : ''}${e.payload.pipeline ? ' [' + e.payload.pipeline + ']' : ''}`);
    });

    // 关键检查：outline_generated 必须发出
    const outlineGenEvent = events.find(e => e.payload.type === 'outline_generated');
    assert.ok(outlineGenEvent, 'should emit outline_generated event');
    console.log('\n✅ outline_generated event 已发出');

    // 关键检查：pipeline_finished 必须发出（在 outline_generated 之前）
    const pipelineFinishedIdx = events.findIndex(e => e.payload.type === 'pipeline_finished');
    const outlineGenIdx = events.findIndex(e => e.payload.type === 'outline_generated');
    assert.ok(pipelineFinishedIdx >= 0, 'should emit pipeline_finished event');
    assert.ok(outlineGenIdx > pipelineFinishedIdx, 'outline_generated must come after pipeline_finished');
    const reviewerStartedIdx = events.findIndex(e =>
        e.payload.type === 'agent_started' && e.payload.agentName === 'outline-reviewer'
    );
    assert.ok(reviewerStartedIdx > 0, 'outline reviewer should start');
    assert.ok(reviewerStartedIdx < pipelineFinishedIdx, 'reviewer must run before pipeline_finished');
    console.log(`✅ 评审阶段在 pipeline_finished 前执行：reviewer(${reviewerStartedIdx}) → pipeline_finished(${pipelineFinishedIdx})`);
    console.log(`✅ 事件顺序正确：pipeline_finished(${pipelineFinishedIdx}) → outline_generated(${outlineGenIdx})`);

    // 验证数据持久化
    const getRes = novelEngine.getNovel(novelId);
    console.log('\n=== getNovel 返回 ===');
    console.log({
        ok: getRes.ok,
        novel_status: getRes.novel && getRes.novel.status,
        outline_exists: !!getRes.outline,
        outline_keys: getRes.outline ? Object.keys(getRes.outline) : [],
        outline_world_setting: getRes.outline ? getRes.outline.world_setting : null,
        outline_chapter_list: getRes.outline ? getRes.outline.chapter_list : null,
        chapter_count: getRes.chapters ? getRes.chapters.length : 0,
    });

    assert.ok(getRes.outline, 'outline should be persisted to DB');
    assert.equal(getRes.outline.world_setting, '这是一个测试世界观', 'world_setting should match mock');
    assert.equal(getRes.chapters.length, 2, 'should have 2 chapters created');
    console.log('\n✅ 数据正确持久化到 DB');

    // Phase 4-A: 验证架构已生成
    const archRes = novelEngine.getArchitecture(novelId);
    console.log('\n=== 架构 ===');
    console.log({
        ok: archRes.ok,
        arch_exists: !!archRes.architecture,
        three_act_present: !!(archRes.architecture && archRes.architecture.three_act),
        plot_threads_count: archRes.architecture ? (archRes.architecture.plot_threads || []).length : 0,
        foreshadowing_count: archRes.architecture ? (archRes.architecture.foreshadowing_seed || []).length : 0,
    });
    assert.ok(archRes.ok, 'getArchitecture should return ok');
    assert.ok(archRes.architecture, 'architecture should be persisted to DB');
    assert.ok(archRes.architecture.three_act && archRes.architecture.three_act.includes('第一幕'), 'three_act should be persisted');
    assert.equal((archRes.architecture.plot_threads || []).length, 2, 'should have 2 plot_threads from mock');
    assert.equal((archRes.architecture.foreshadowing_seed || []).length, 1, 'should have 1 foreshadowing_seed from mock');
    console.log('✅ 故事架构已正确持久化到 DB');

    // Phase 4-A: 验证 architecture_generated 事件已 emit（在 outline_generated 之后）
    const archGenIdx = events.findIndex(e => e.payload.type === 'architecture_generated');
    assert.ok(archGenIdx > 0, 'architecture_generated should be emitted');
    assert.ok(archGenIdx > outlineGenIdx, 'architecture_generated must come after outline_generated');
    console.log(`✅ 架构事件顺序正确：outline_generated(${outlineGenIdx}) → architecture_generated(${archGenIdx})`);

    console.log('\n🎉 完整 pipeline 流程正确');
});

// 清理 mock
test.after(() => {
    novel.generateStream = _origGenerate;
});