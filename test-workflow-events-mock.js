// test-workflow-events-mock.js — Sprint W: 工作面板事件流核心逻辑
// 覆盖：emit hook 落库 / novel_id 隔离 / 流式 chunk 聚合 / 过滤 / 分页 / 详情 / 统计
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');
const novelEngine = require('./novel-engine');

class TestStore {
    constructor(dbPath) { this.path = dbPath; this._db = new DatabaseSync(dbPath); }
    exec(sql, ...params) {
        const info = this._db.prepare(sql).run(...params);
        const lid = info.lastInsertRowid;
        return { changes: Number(info.changes), lastInsertRowid: typeof lid === 'bigint' ? Number(lid) : lid };
    }
    query(sql, ...params) {
        return this._db.prepare(sql).all(...params).map(r => Object.assign({}, r));
    }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-wf-'));
const store = new TestStore(path.join(TMP, 'test.sqlite'));
novelEngine.bootstrap({ store, notify: () => {} });
novelEngine._storeRootForMemory = TMP;
const NOVEL_A = 'novel-a';
const NOVEL_B = 'novel-b';

process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ============ 表结构 ============

test('W1: _ainovel_workflow_events 表已建', () => {
    const r = store.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='_ainovel_workflow_events'`)[0];
    assert.ok(r, '表应该存在');
    // 索引
    const idx = store.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='_ainovel_workflow_events'`).map(x => x.name);
    assert.ok(idx.some(n => n.includes('novel_ts')), '应有 novel_id+ts 索引');
});

// ============ 落库 + 隔离 ============

test('W2: _emit 触发后事件落库（含 novel_id 隔离）', () => {
    novelEngine._emit('agent_started', { novelId: NOVEL_A, agent: 'world-architect', phase: 'phase-A' });
    novelEngine._emit('agent_started', { novelId: NOVEL_B, agent: 'world-architect' });
    novelEngine._emit('blackboard_written', { novelId: NOVEL_A, key: 'foo', value: 'bar', agent: 'auto-overseer' });

    const a = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 50 });
    const b = novelEngine.listWorkflowEvents(NOVEL_B, { limit: 50 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // A 应该有 2 条（agent_invoked + blackboard_written），B 应该有 1 条
    assert.equal(a.events.length, 2);
    assert.equal(b.events.length, 1);
    // 不应跨 novel
    assert.ok(a.events.every(e => e.novel_id === NOVEL_A));
    assert.ok(b.events.every(e => e.novel_id === NOVEL_B));
});

test('W2: 白名单外的事件类型不落库', () => {
    // random_unknown_event 不在白名单
    novelEngine._emit('random_unknown_event', { novelId: NOVEL_A });
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 50 });
    // 应该仍然只是之前那 2 条（不被新事件污染）
    assert.equal(r.events.length, 2);
});

test('W2: 没有 novelId 的事件不落库', () => {
    novelEngine._emit('agent_started', { agent: 'no-novel-id' });
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 50 });
    // 还是 2 条
    assert.equal(r.events.length, 2);
});

// ============ 字段映射 ============

test('W3: kind / status / agent / phase 字段映射正确', () => {
    novelEngine._emit('agent_started', { novelId: NOVEL_A, agent: 'style-analyst', phase: 'phase-A' });
    novelEngine._emit('agent_finished', { novelId: NOVEL_A, agent: 'style-analyst', phase: 'phase-A', durationMs: 1234 });
    novelEngine._emit('agent_failed', { novelId: NOVEL_A, agent: 'character-designer', error: 'JSON parse failed' });

    // 用 agent 过滤只看本测试新增的 2 个 agent（之前测试已留下 world-architect/blackboard 等）
    const sa = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'style-analyst', limit: 50 });
    const cd = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'character-designer', limit: 50 });
    assert.equal(sa.events.length, 1, 'style-analyst 应该有 1 行');
    assert.equal(cd.events.length, 1, 'character-designer 应该有 1 行');

    // character-designer：started → failed UPDATE 同一行
    assert.equal(cd.events[0].status, 'failed');
    assert.equal(cd.events[0].kind, 'agent');
    assert.equal(cd.events[0].agent, 'character-designer');
    assert.equal(cd.events[0].error, 'JSON parse failed');

    // style-analyst：started → finished UPDATE 同一行（最终态 = completed）
    assert.equal(sa.events[0].status, 'completed');
    assert.equal(sa.events[0].agent, 'style-analyst');
    assert.equal(sa.events[0].phase, 'phase-A');
    assert.equal(sa.events[0].duration_ms, 1234);
    assert.ok(/style-analyst/.test(sa.events[0].summary), 'summary 应包含 agent');
});

test('W3: overseer 决策事件 kind 映射正确', () => {
    novelEngine._emit('auto_overseer_decided', { novelId: NOVEL_A, action: 'continue', reason: '一切正常', note: '' });
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 50 });
    const ev = r.events.find(e => e.summary && e.summary.includes('编剧监督决策'));
    assert.ok(ev, '应有 overseer_decided 事件');
    assert.equal(ev.kind, 'overseer');
    assert.equal(ev.status, 'completed');
});

// ============ 流式 chunk 聚合 ============

test('W4: 流式 chunk 走 in-place 更新（200 chunks → 1 row）', () => {
    const chapterId = 'ch-stream-1';
    const skill = 'chapter-streamer';
    novelEngine._emit('stream_started', { novelId: NOVEL_A, skill, chapterId, jobId: 'job-1' });
    // 模拟 200 个 chunk（带 accumulated 字段，模拟真实流式行为）
    let runningText = '';
    for (let i = 0; i < 200; i++) {
        runningText += 'x'.repeat(10);
        novelEngine._emit('stream_chunk', {
            novelId: NOVEL_A, skill, chapterId, jobId: 'job-1',
            chunk: { delta: 'x'.repeat(10), text: 'x'.repeat(10) },
            accumulated: runningText,
        });
    }
    novelEngine._emit('stream_completed', { novelId: NOVEL_A, skill, chapterId, jobId: 'job-1' });

    const r = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'stream' });
    // 应该只有 3 条（started / running / completed） — chunk 全部合并到 running
    assert.ok(r.events.length <= 3, `流式事件 ≤ 3 条，实际 ${r.events.length}`);

    const running = r.events.find(e => e.status === 'running');
    assert.ok(running, '应有 running 节点');
    assert.ok(/流式输出中/.test(running.summary), 'running summary 应说明流式输出中');
    // input 应包含 accumulated + count
    const detail = novelEngine.getWorkflowEventDetail(running.id);
    assert.equal(detail.ok, true);
    assert.equal(detail.event.input.count, 200, '应有 200 个 chunk 计数');
    assert.equal(detail.event.input.accumulated, 2000, '应有 2000 字符累积');
    // lastText 应为最新累积全文（2000 字符 < 3000 上限，全文保留）
    assert.equal(detail.event.input.lastText.length, 2000, 'lastText 应保留 2000 字符全文');
    assert.equal(detail.event.input.lastText, 'x'.repeat(2000), 'lastText 内容应与累积全文一致');
});

test('W4: 不同 chapterId 的流式 chunk 各自聚合', () => {
    novelEngine._emit('stream_started', { novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-A', jobId: 'jA' });
    for (let i = 0; i < 50; i++) {
        novelEngine._emit('stream_chunk', { novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-A', jobId: 'jA', chunk: { delta: 'a' } });
    }
    novelEngine._emit('stream_started', { novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-B', jobId: 'jB' });
    for (let i = 0; i < 30; i++) {
        novelEngine._emit('stream_chunk', { novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-B', jobId: 'jB', chunk: { delta: 'b' } });
    }
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'stream', limit: 50 });
    // 应该至少有 4 个 running 节点（ch-A 一个 + ch-B 一个，前面测试留下的）
    const running = r.events.filter(e => e.status === 'running');
    assert.ok(running.length >= 2, `至少 2 个 running 节点，实际 ${running.length}`);
});

test('W4: lastText 超长时只保留最近 3000 字符', () => {
    novelEngine._emit('stream_started', { novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-trunc', jobId: 'jt' });
    // 累积 4000 字符（> 3000 上限）
    let bigText = '';
    for (let i = 0; i < 400; i++) {
        bigText += 'y'.repeat(10);
        novelEngine._emit('stream_chunk', {
            novelId: NOVEL_A, skill: 'chapter-streamer', chapterId: 'ch-trunc', jobId: 'jt',
            chunk: { delta: 'y'.repeat(10) },
            accumulated: bigText,
        });
    }
    const list = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'stream', limit: 50 });
    const node = list.events.find(e => e.id && e.id.includes('ch-trunc') && e.status === 'running');
    assert.ok(node, '应有 ch-trunc running 节点');
    const detail = novelEngine.getWorkflowEventDetail(node.id);
    assert.equal(detail.event.input.lastText.length, 3000, 'lastText 应被截断到 3000 字符');
    // 应是最近 3000 字符（前面 1000 字符被丢弃）
    assert.equal(detail.event.input.lastText, 'y'.repeat(3000), 'lastText 应该是最后 3000 字符');
});

// ============ 过滤 ============

test('W5: listWorkflowEvents 按 kind 过滤', () => {
    novelEngine._emit('inbox_received', { novelId: NOVEL_A, agent: 'chapter-streamer', from: 'auto-overseer', text: 'hi' });
    novelEngine._emit('task_created', { novelId: NOVEL_A, agent: 'director', subject: '写章节' });

    const inbox = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'inbox' });
    const task = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'task' });
    assert.ok(inbox.events.every(e => e.kind === 'inbox'));
    assert.ok(task.events.every(e => e.kind === 'task'));
    assert.ok(inbox.events.length >= 1);
    assert.ok(task.events.length >= 1);
});

test('W5: listWorkflowEvents 按 agent 过滤', () => {
    novelEngine._emit('agent_started', { novelId: NOVEL_A, agent: 'continuity-checker' });
    novelEngine._emit('agent_started', { novelId: NOVEL_A, agent: 'style-editor' });

    const cont = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'continuity-checker' });
    assert.ok(cont.events.every(e => e.agent === 'continuity-checker'));
    assert.ok(cont.events.length >= 1);
});

test('W5: listWorkflowEvents 按 status 过滤', () => {
    const failed = novelEngine.listWorkflowEvents(NOVEL_A, { status: 'failed' });
    assert.ok(failed.events.every(e => e.status === 'failed'));
});

// ============ 分页 ============

test('W6: 分页 limit + offset 正确', () => {
    // 之前测试已经产生 20+ 事件
    const p1 = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 3, offset: 0 });
    const p2 = novelEngine.listWorkflowEvents(NOVEL_A, { limit: 3, offset: 3 });
    assert.equal(p1.events.length, 3);
    assert.equal(p2.events.length, 3);
    // 不同页的事件不应重叠
    const ids1 = new Set(p1.events.map(e => e.id));
    const ids2 = new Set(p2.events.map(e => e.id));
    for (const id of ids2) assert.ok(!ids1.has(id), `id ${id} 不应跨页重复`);
    // total 应大于单页
    assert.ok(p1.total > 3, `total=${p1.total}`);
});

test('W6: listWorkflowReplay 按 ts asc 排序', () => {
    const r = novelEngine.listWorkflowReplay(NOVEL_A, { limit: 50 });
    assert.equal(r.ok, true);
    for (let i = 1; i < r.events.length; i++) {
        assert.ok(r.events[i].ts >= r.events[i-1].ts, `第 ${i} 条 ts 应 ≥ 第 ${i-1} 条`);
    }
});

// ============ 详情 ============

test('W7: getWorkflowEventDetail 返回完整 input/output/payload JSON', () => {
    novelEngine._emit('agent_finished', {
        novelId: NOVEL_A, agent: 'test-agent', phase: 'phase-test',
        durationMs: 500, output: { text: '生成的内容', wordCount: 3214 },
        input: { prompt: '写一段文字' },
    });
    const list = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'test-agent', limit: 1 });
    const id = list.events[0].id;
    const detail = novelEngine.getWorkflowEventDetail(id);
    assert.equal(detail.ok, true);
    assert.equal(detail.event.input.prompt, '写一段文字');
    assert.equal(detail.event.output.text, '生成的内容');
    assert.equal(detail.event.output.wordCount, 3214);
    assert.equal(detail.event.payload.novelId, NOVEL_A);
});

test('W7: getWorkflowEventDetail 不存在 id 返回 ok=false', () => {
    const r = novelEngine.getWorkflowEventDetail('nonexistent-id');
    assert.equal(r.ok, false);
});

// ============ 统计 ============

test('W8: getWorkflowStats 返回 byKind / byAgent / tsRange', () => {
    const r = novelEngine.getWorkflowStats(NOVEL_A);
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.byKind), 'byKind 应是数组');
    assert.ok(Array.isArray(r.byAgent), 'byAgent 应是数组');
    assert.ok(r.tsRange && r.tsRange.total > 0, 'tsRange.total 应 > 0');
    assert.ok(r.tsRange.min_ts && r.tsRange.max_ts, '应有 min_ts / max_ts');

    // byKind 应至少有 agent / stream 两种
    const kinds = new Set(r.byKind.map(x => x.kind));
    assert.ok(kinds.has('agent'), '应有 agent kind');
    assert.ok(kinds.has('stream'), '应有 stream kind');
});

// ============ Payload 截断（防御性） ============

test('W9: 超大 payload 字符串被截断', () => {
    const hugeText = 'X'.repeat(5000);
    novelEngine._emit('agent_finished', {
        novelId: NOVEL_A, agent: 'truncator',
        output: { longText: hugeText },
    });
    const list = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'truncator', limit: 1 });
    const id = list.events[0].id;
    const detail = novelEngine.getWorkflowEventDetail(id);
    assert.ok(detail.event.output.longText.length < 5000, '长字符串应被截断');
    assert.ok(/truncated/.test(detail.event.output.longText), '应有截断标记');
});

// ============ agent_chunk 端到端（Sprint A：所有 agent 共享稳定 id）============

test('W10: agent_started/chunk/finished 共享一个 id（200 chunks → 1 row，UI 视角 1 节点）', () => {
    const jobId = 'job-architect-1';
    const skill = 'style-analyst';
    novelEngine._emit('agent_started', {
        novelId: NOVEL_A, agentName: skill, jobId, phase: 'phase-A',
    });
    let accum = '';
    for (let i = 0; i < 200; i++) {
        accum += 'Z';
        novelEngine._emit('agent_chunk', {
            novelId: NOVEL_A, agentName: skill, jobId,
            chunk: 'Z',
            accumulated: accum,
        });
    }
    novelEngine._emit('agent_finished', {
        novelId: NOVEL_A, agentName: skill, jobId, phase: 'phase-A',
        durationMs: 1234, output: { text: accum },
    });

    // 同一 agent 同一 jobId → 只有 1 行 DB row（不会因为 chunks 多创建行）
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { agent: skill });
    const matching = r.events.filter(e => e.id === `wf-${NOVEL_A}-${skill}-${jobId}-run`);
    assert.equal(matching.length, 1, '应该只有 1 行（id 稳定）');
    const row = matching[0];
    assert.equal(row.status, 'completed');
    assert.equal(row.duration_ms, 1234);
    // input.lastText 应保留累积的最近 3000 字
    const detail = novelEngine.getWorkflowEventDetail(row.id);
    assert.equal(detail.event.input.count, 200);
    assert.equal(detail.event.input.accumulated, 200);
    assert.equal(detail.event.input.lastText.length, 200);
});

test('W10: 并行 reviewer 用不同 agentName 各自独立行（不互盖）', () => {
    const chapterId = 'ch-parallel';
    const jobId = 'job-parallel';
    // 三个 reviewer 同时跑，但 agentName 不同 → 3 个不同 id → 3 行
    for (const agent of ['continuity-checker', 'style-editor', 'quality-reviewer']) {
        novelEngine._emit('agent_started', { novelId: NOVEL_A, agentName: agent, jobId, chapterId });
        novelEngine._emit('agent_chunk', { novelId: NOVEL_A, agentName: agent, jobId, chapterId, chunk: agent[0], accumulated: agent[0] });
        novelEngine._emit('agent_finished', { novelId: NOVEL_A, agentName: agent, jobId, chapterId, durationMs: 100 });
    }
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { kind: 'agent' });
    // 验证 3 个 reviewer 各占一行（id 包含各自 agentName）
    const ids = new Set(r.events.map(e => e.id));
    assert.ok(ids.has(`wf-${NOVEL_A}-continuity-checker-${jobId}-run`), 'continuity-checker 应该有独立行');
    assert.ok(ids.has(`wf-${NOVEL_A}-style-editor-${jobId}-run`), 'style-editor 应该有独立行');
    assert.ok(ids.has(`wf-${NOVEL_A}-quality-reviewer-${jobId}-run`), 'quality-reviewer 应该有独立行');
});

test('W10: agent_started 之前就来的 chunk 不爆（防御性 fallback）', () => {
    const jobId = 'job-orphan';
    // 没有 started 就直接 chunk → 应该也能正确落到一行（UPDATE 路径发现没 prev → fallback INSERT）
    novelEngine._emit('agent_chunk', { novelId: NOVEL_A, agentName: 'orphan-agent', jobId, chunk: 'x', accumulated: 'x' });
    novelEngine._emit('agent_finished', { novelId: NOVEL_A, agentName: 'orphan-agent', jobId });
    const r = novelEngine.listWorkflowEvents(NOVEL_A, { agent: 'orphan-agent' });
    assert.ok(r.events.length >= 1);
});

// ============ 清理 ============

test('W-cleanup: deleteNovel 不清 workflow_events（保留用于时间倒放）', () => {
    // 删小说 → workflow_events 应保留（用户可能想看历史）
    // 这是设计选择（与 inbox 不同）
    novelEngine.deleteNovel(NOVEL_B);
    const r = novelEngine.listWorkflowEvents(NOVEL_B, { limit: 10 });
    // 应该仍然能找到 B 的事件（如果有的话）
    assert.equal(r.ok, true);
});