// test-director-mock.js — Sprint H：LLM-driven 多 agent 协作框架
// 覆盖：H1 Skill-as-Tool / H2 黑板 / H3 收件箱 / H4 任务图 / H5 编剧循环 / H6 模式开关 + fallback
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');
const novelEngine = require('./novel-engine');
const novel = require('./novel');

// ---- 测试用 store：与 KVDb 同接口（exec / query / path），但走 Node 内置 sqlite ----
// 不用 db.js 的 KVDb，因为 better-sqlite3 是按 Electron ABI 编译的，纯 node 下 require 会失败。
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
        // node:sqlite 返回 null-prototype 对象，转成普通对象方便 assert.deepEqual
        return this._db.prepare(sql).all(...params).map(r => Object.assign({}, r));
    }
}

// ---- 一次性 bootstrap 到临时 sqlite（真 DB，不 mock）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-h-'));
const store = new TestStore(path.join(TMP, 'test.sqlite'));
novelEngine.bootstrap({ store, notify: () => {} });

const NOVEL_A = 'novel-aaa';
const NOVEL_B = 'novel-bbb';

process.on('exit', () => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

// ============ H1: Skill-as-Tool ============

test('H1: _renderSkillAsToolSpec 渲染 whenToUse / inputSchema / outputSchema', () => {
    const spec = novelEngine._renderSkillAsToolSpec({
        name: 'demo-skill',
        displayName: '演示',
        whenToUse: '当需要演示时',
        inputSchema: '{ "x": "string" }',
        outputSchema: '{ "y": "string" }',
    });
    assert.ok(spec.includes('demo-skill'), '含 skill 名');
    assert.ok(spec.includes('当需要演示时'), '含 whenToUse');
    assert.ok(spec.includes('"x": "string"'), '含 inputSchema');
    assert.ok(spec.includes('"y": "string"'), '含 outputSchema');
    console.log('✅ H1-1: skill 渲染成 tool spec');
});

test('H1: registerSkill 未给 whenToUse 时回落到 description', () => {
    novelEngine.registerSkill({
        name: '__test_fallback_skill',
        description: '这是描述',
        systemPrompt: 'x',
        run: async () => ({ ok: true }),
    });
    const s = novelEngine.listSkills().find(x => x.name === '__test_fallback_skill');
    assert.ok(s, 'skill 已注册');
    const spec = novelEngine._renderDirectorToolbox();
    assert.ok(spec.includes('__test_fallback_skill'), 'toolbox 含新 skill');
    console.log('✅ H1-2: whenToUse 回落 description');
});

test('H1: director toolbox 含 3 个元工具且不含自己', () => {
    const box = novelEngine._renderDirectorToolbox();
    assert.ok(box.includes('taskCreate'), '含 taskCreate');
    assert.ok(box.includes('inboxSend'), '含 inboxSend');
    assert.ok(box.includes('blackboardWrite'), '含 blackboardWrite');
    assert.ok(!box.includes('### novel-director'), 'toolbox 不应含 director 自身');
    console.log('✅ H1-3: toolbox 完整且排除自身');
});

// ============ H2: Blackboard ============

test('H2: 黑板 write / read / list / version 递增', () => {
    let r = novelEngine.blackboardWrite(NOVEL_A, 'protagonist', '林晚，28 岁，考古学者');
    assert.equal(r.ok, true);
    assert.equal(r.version, 1, '首次写入 version=1');

    r = novelEngine.blackboardWrite(NOVEL_A, 'protagonist', '林晚，29 岁（修订）', 'character-architect');
    assert.equal(r.version, 2, '覆盖写入 version 递增');

    const rd = novelEngine.blackboardRead(NOVEL_A, 'protagonist');
    assert.equal(rd.ok, true);
    assert.ok(rd.value.includes('29 岁'), '读到最新值');
    assert.equal(rd.owner, 'character-architect', 'owner 已更新');

    const list = novelEngine.blackboardList(NOVEL_A);
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 1, 'UNIQUE(novel_id,key) 生效，只有一条');
    console.log('✅ H2-1: 黑板读写 + 版本号');
});

test('H2: 黑板按 novel 物理隔离（A 不串味到 B）', () => {
    novelEngine.blackboardWrite(NOVEL_B, 'protagonist', '陈舟，男，程序员');
    const a = novelEngine.blackboardRead(NOVEL_A, 'protagonist');
    const b = novelEngine.blackboardRead(NOVEL_B, 'protagonist');
    assert.ok(a.value.includes('林晚'), 'A 保持自己的值');
    assert.ok(b.value.includes('陈舟'), 'B 保持自己的值');
    assert.equal(novelEngine.blackboardList(NOVEL_B).items.length, 1, 'B 只有自己的条目');
    console.log('✅ H2-2: 跨 novel 隔离');
});

test('H2: 黑板超长 value 被拒绝', () => {
    const huge = 'x'.repeat(9000);
    const r = novelEngine.blackboardWrite(NOVEL_A, 'huge', huge);
    assert.equal(r.ok, false, '超过 8000 字符应拒绝');
    assert.ok(/字符上限/.test(r.error), '错误信息说明原因');
    console.log('✅ H2-3: 超长 value 被拒');
});

test('H2: blackboardSummary 截断到上限内', () => {
    for (let i = 0; i < 40; i++) {
        novelEngine.blackboardWrite(NOVEL_A, 'k' + i, '值'.repeat(150));
    }
    const sum = novelEngine.blackboardSummary(NOVEL_A);
    assert.ok(sum.length <= 1800, `摘要应被截断，实际 ${sum.length}`);
    assert.ok(sum.includes('被截断'), '含截断提示');
    console.log('✅ H2-4: 摘要截断，长度', sum.length);
});

test('H2: 黑板摘要被注入 system prompt', () => {
    const skill = { name: 'chapter-streamer', systemPrompt: '原始指令', temperature: 0.8 };
    const composed = novelEngine._composeSystemPrompt(skill, NOVEL_A);
    assert.ok(composed.system.includes('项目黑板'), 'system 含黑板段标记');
    assert.ok(composed.system.includes('protagonist'), 'system 含黑板 key');
    assert.ok(composed.system.includes('原始指令'), '保留原始 systemPrompt');
    console.log('✅ H2-5: 黑板注入 system prompt');
});

test('H2: blackboardClear 单 key / 全清', () => {
    novelEngine.blackboardWrite(NOVEL_B, 'tmp1', 'a');
    novelEngine.blackboardWrite(NOVEL_B, 'tmp2', 'b');
    novelEngine.blackboardClear(NOVEL_B, 'tmp1');
    assert.equal(novelEngine.blackboardRead(NOVEL_B, 'tmp1').ok, false, 'tmp1 已删');
    assert.equal(novelEngine.blackboardRead(NOVEL_B, 'tmp2').ok, true, 'tmp2 还在');
    novelEngine.blackboardClear(NOVEL_B);
    assert.equal(novelEngine.blackboardList(NOVEL_B).items.length, 0, '全清后为空');
    console.log('✅ H2-6: 清理语义正确');
});

// ============ H3: Inbox ============

test('H3: 收件箱 send / list / read 未读语义', () => {
    novelEngine._storeRootForMemory = TMP;
    let r = novelEngine.inboxSend(NOVEL_A, {
        to: 'chapter-streamer', from: 'outline-reviewer',
        text: '第 5 章与第 8 章时间线冲突，请注意', kind: 'review-issue',
    });
    assert.equal(r.ok, true, '投递成功');

    const list = novelEngine.inboxList(NOVEL_A, 'chapter-streamer');
    assert.equal(list.messages.length, 1, '收件箱有 1 条');
    assert.equal(list.messages[0].read, false, '默认未读');

    // read 默认会标记为已读
    const read1 = novelEngine.inboxRead(NOVEL_A, 'chapter-streamer');
    assert.equal(read1.messages.length, 1, '首次读到 1 条未读');
    const read2 = novelEngine.inboxRead(NOVEL_A, 'chapter-streamer');
    assert.equal(read2.messages.length, 0, '再读为 0（已标记已读）');
    console.log('✅ H3-1: 收件箱未读语义');
});

test('H3: inboxRead markAsRead:false 不消费未读', () => {
    novelEngine._storeRootForMemory = TMP;
    novelEngine.inboxSend(NOVEL_A, { to: 'style-editor', from: 'user', text: '别用网络流行语' });
    const peek1 = novelEngine.inboxRead(NOVEL_A, 'style-editor', { markAsRead: false });
    const peek2 = novelEngine.inboxRead(NOVEL_A, 'style-editor', { markAsRead: false });
    assert.equal(peek1.messages.length, 1);
    assert.equal(peek2.messages.length, 1, 'peek 不消费');
    console.log('✅ H3-2: peek 不消费未读');
});

test('H3: 未读消息被注入 system prompt', () => {
    novelEngine._storeRootForMemory = TMP;
    novelEngine.inboxSend(NOVEL_A, {
        to: 'plot-architect', from: 'novel-director', text: '把主线冲突提前到第 3 章',
    });
    const skill = { name: 'plot-architect', systemPrompt: '原始', temperature: 0.7 };
    const composed = novelEngine._composeSystemPrompt(skill, NOVEL_A);
    assert.ok(composed.system.includes('未读同事消息'), '含未读消息段');
    assert.ok(composed.system.includes('提前到第 3 章'), '含消息正文');
    // 注入用 peek，不应消费掉未读
    const still = novelEngine.inboxRead(NOVEL_A, 'plot-architect', { markAsRead: false });
    assert.equal(still.messages.length, 1, '注入后仍未读');
    console.log('✅ H3-3: 未读注入且不消费');
});

test('H3: inboxMarkRead(null) 全部标记已读', () => {
    novelEngine._storeRootForMemory = TMP;
    novelEngine.inboxSend(NOVEL_A, { to: 'quality-reviewer', from: 'user', text: 'm1' });
    novelEngine.inboxSend(NOVEL_A, { to: 'quality-reviewer', from: 'user', text: 'm2' });
    const r = novelEngine.inboxMarkRead(NOVEL_A, 'quality-reviewer', null);
    assert.equal(r.ok, true);
    assert.equal(r.marked, 2, '两条都被标记');
    assert.equal(novelEngine.inboxRead(NOVEL_A, 'quality-reviewer', { markAsRead: false }).messages.length, 0);
    console.log('✅ H3-4: 全部已读');
});

test('H3: 收件箱按 novel 物理隔离（不同目录）', () => {
    novelEngine._storeRootForMemory = TMP;
    novelEngine.inboxSend(NOVEL_B, { to: 'chapter-streamer', from: 'user', text: 'B 书的消息' });
    const a = novelEngine.inboxList(NOVEL_A, 'chapter-streamer');
    const b = novelEngine.inboxList(NOVEL_B, 'chapter-streamer');
    assert.ok(!a.messages.some(m => m.text.includes('B 书')), 'A 收不到 B 的消息');
    assert.equal(b.messages.length, 1, 'B 只有自己的');
    assert.notEqual(novelEngine._inboxDir(NOVEL_A), novelEngine._inboxDir(NOVEL_B), '目录物理隔离');
    console.log('✅ H3-5: 收件箱跨 novel 隔离');
});

test('H3: agentName 做路径穿越防御', () => {
    novelEngine._storeRootForMemory = TMP;
    const r = novelEngine.inboxSend(NOVEL_A, { to: '../../evil', from: 'user', text: 'x' });
    assert.equal(r.ok, true, '不崩溃');
    const dir = novelEngine._inboxDir(NOVEL_A);
    const files = fs.readdirSync(dir);
    assert.ok(!files.some(f => f.includes('..')), '文件名不含 ..');
    console.log('✅ H3-6: 路径穿越已防御，文件名=', files.filter(f => f.includes('evil')));
});

// ============ H4: Task List ============

test('H4: taskCreate / taskList / taskGet', () => {
    const c = novelEngine.taskCreate(NOVEL_A, {
        subject: '写第 1 章', description: '按大纲写', owner: 'chapter-streamer',
    });
    assert.equal(c.ok, true);
    assert.ok(c.id.startsWith('t_'), 'id 前缀');

    const g = novelEngine.taskGet(c.id);
    assert.equal(g.ok, true);
    assert.equal(g.task.subject, '写第 1 章');
    assert.equal(g.task.status, 'pending', '初始 pending');
    assert.deepEqual(g.task.blockedBy, [], 'blockedBy 反序列化为数组');

    const l = novelEngine.taskList(NOVEL_A);
    assert.ok(l.tasks.length >= 1);
    console.log('✅ H4-1: 任务 CRUD');
});

test('H4: claim → complete 状态机', () => {
    const c = novelEngine.taskCreate(NOVEL_A, { subject: '校对第 1 章' });
    const claimed = novelEngine.taskClaim(c.id, 'continuity-checker');
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.status, 'in_progress');
    assert.equal(claimed.task.owner, 'continuity-checker', 'claim 时写入 owner');

    // 二次 claim 应被拒绝
    const again = novelEngine.taskClaim(c.id, 'other-agent');
    assert.equal(again.ok, false, '已 claim 的任务不能重复 claim');

    const done = novelEngine.taskComplete(c.id, { verdict: 'pass' });
    assert.equal(done.task.status, 'completed');
    console.log('✅ H4-2: claim/complete 状态机 + 防重复 claim');
});

test('H4: blockedBy 未完成时拒绝 claim，完成后放行', () => {
    const t1 = novelEngine.taskCreate(NOVEL_A, { subject: '先生成大纲' });
    const t2 = novelEngine.taskCreate(NOVEL_A, { subject: '再写第 1 章', blockedBy: [t1.id] });

    const blocked = novelEngine.taskClaim(t2.id, 'chapter-streamer');
    assert.equal(blocked.ok, false, '依赖未完成应拒绝');
    assert.ok(/未完成/.test(blocked.error), '错误说明依赖未完成');

    novelEngine.taskClaim(t1.id, 'outline-synthesizer');
    novelEngine.taskComplete(t1.id, { ok: true });

    const now = novelEngine.taskClaim(t2.id, 'chapter-streamer');
    assert.equal(now.ok, true, '依赖完成后可 claim');
    assert.equal(now.task.status, 'in_progress');
    console.log('✅ H4-3: 依赖门控生效');
});

test('H4: taskFail 记录错误', () => {
    const t = novelEngine.taskCreate(NOVEL_A, { subject: '会失败的任务' });
    novelEngine.taskClaim(t.id, 'x');
    const f = novelEngine.taskFail(t.id, 'LLM 超时');
    assert.equal(f.task.status, 'failed');
    assert.ok(String(f.task.result).includes('LLM 超时'), 'result 记录错误');
    console.log('✅ H4-4: 失败态');
});

test('H4: taskReady 只返回可执行任务', () => {
    const NOVEL_C = 'novel-ccc';
    const a = novelEngine.taskCreate(NOVEL_C, { subject: 'A', owner: 'w1' });
    const b = novelEngine.taskCreate(NOVEL_C, { subject: 'B', owner: 'w1', blockedBy: [a.id] });
    const ready = novelEngine.taskReady(NOVEL_C, 'w1');
    assert.equal(ready.ok, true);
    const ids = (ready.tasks || []).map(t => t.id);
    assert.ok(ids.includes(a.id), 'A 无依赖应 ready');
    assert.ok(!ids.includes(b.id), 'B 被 A 阻塞，不应 ready');
    console.log('✅ H4-5: ready 过滤被阻塞任务');
});

test('H4: 任务按 novel 隔离', () => {
    const before = novelEngine.taskList(NOVEL_B).tasks.length;
    novelEngine.taskCreate(NOVEL_A, { subject: '只属于 A 的任务' });
    assert.equal(novelEngine.taskList(NOVEL_B).tasks.length, before, 'B 的任务数不变');
    console.log('✅ H4-6: 任务跨 novel 隔离');
});

// ============ H5: Director tool-call 解析 + 循环 ============

test('H5: _parseDirectorResponse 解析单个 tool call', () => {
    const text = `我先分析风格。
<<<TOOL_CALL>>>{"name":"style-analyst","args":{"novelId":"x"}}<<<END>>>`;
    const p = novelEngine._parseDirectorResponse(text);
    assert.equal(p.toolCalls.length, 1);
    assert.equal(p.toolCalls[0].name, 'style-analyst');
    assert.equal(p.done, null, '无 DONE 标记');
    console.log('✅ H5-1: 单 tool call 解析');
});

test('H5: _parseDirectorResponse 解析并行多个 tool call', () => {
    const text = `<<<TOOL_CALL>>>{"name":"world-architect","args":{}}<<<END>>>
<<<TOOL_CALL>>>{"name":"character-architect","args":{}}<<<END>>>
<<<TOOL_CALL>>>{"name":"blackboardWrite","args":{"key":"phase","value":"A"}}<<<END>>>`;
    const p = novelEngine._parseDirectorResponse(text);
    assert.equal(p.toolCalls.length, 3, '3 个并行调用');
    assert.deepEqual(p.toolCalls.map(c => c.name),
        ['world-architect', 'character-architect', 'blackboardWrite']);
    console.log('✅ H5-2: 并行 tool call 解析');
});

test('H5: _parseDirectorResponse 解析 DONE 标记', () => {
    const p = novelEngine._parseDirectorResponse('<<<DONE>>>{"summary":"大纲已生成"}<<<DONE>>>');
    assert.ok(p.done, '识别到 done');
    assert.equal(p.done.summary, '大纲已生成');
    console.log('✅ H5-3: DONE 解析');
});

test('H5: _parseDirectorResponse 对坏 JSON / 空输入健壮', () => {
    const bad = novelEngine._parseDirectorResponse('<<<TOOL_CALL>>>{这不是JSON<<<END>>>');
    assert.equal(bad.toolCalls.length, 0, '坏 JSON 被忽略而非抛错');

    const mixed = novelEngine._parseDirectorResponse(
        '<<<TOOL_CALL>>>{坏<<<END>>>\n<<<TOOL_CALL>>>{"name":"ok-skill","args":{}}<<<END>>>'
    );
    assert.equal(mixed.toolCalls.length, 1, '坏的丢弃、好的保留');
    assert.equal(mixed.toolCalls[0].name, 'ok-skill');

    assert.deepEqual(novelEngine._parseDirectorResponse(null), { toolCalls: [], done: null });
    assert.deepEqual(novelEngine._parseDirectorResponse('纯自然语言，没有标记'), { toolCalls: [], done: null });
    console.log('✅ H5-4: 解析器健壮性');
});

test('H5: _directorExecuteTool 执行 3 个元工具', async () => {
    novelEngine._storeRootForMemory = TMP;
    const results = [];

    const r1 = await novelEngine._directorExecuteTool(NOVEL_A,
        { name: 'blackboardWrite', args: { key: 'dir_test', value: '编剧写的' } }, results);
    assert.equal(r1.ok, true);
    assert.equal(novelEngine.blackboardRead(NOVEL_A, 'dir_test').value, '编剧写的');

    const r2 = await novelEngine._directorExecuteTool(NOVEL_A,
        { name: 'taskCreate', args: { subject: '编剧建的任务' } }, results);
    assert.equal(r2.ok, true);
    assert.ok(r2.id.startsWith('t_'));

    const r3 = await novelEngine._directorExecuteTool(NOVEL_A,
        { name: 'inboxSend', args: { to: 'scene-planner', text: '注意节奏' } }, results);
    assert.equal(r3.ok, true);
    console.log('✅ H5-5: 元工具执行');
});

test('H5: _directorExecuteTool 未知工具返回错误而不抛', async () => {
    const r = await novelEngine._directorExecuteTool(NOVEL_A,
        { name: 'no-such-tool', args: {} }, []);
    assert.equal(r.ok, false);
    assert.ok(/未知工具/.test(r.error));
    console.log('✅ H5-6: 未知工具优雅失败');
});

test('H5: director 循环 — mock LLM 两轮后 DONE', async () => {
    const origStream = novel.generateStream;
    let turn = 0;
    novel.generateStream = async (opts, onChunk) => {
        turn++;
        if (turn === 1) {
            return { ok: true, text: '<<<TOOL_CALL>>>{"name":"blackboardWrite","args":{"key":"loop_test","value":"turn1"}}<<<END>>>' };
        }
        return { ok: true, text: '<<<DONE>>>{"summary":"循环测试完成"}<<<DONE>>>' };
    };
    try {
        const ctx = { novelId: NOVEL_A, provider: { provider: 'mock', model: 'm' }, signal: null };
        const r = await novelEngine._runDirectorLoop(NOVEL_A, { goal: '测试循环' }, ctx);
        assert.equal(r.ok, true);
        assert.equal(r.summary, '循环测试完成');
        assert.equal(r.toolHistory.length, 1, '执行了 1 次工具');
        assert.equal(turn, 2, 'LLM 被调用 2 轮');
        assert.equal(novelEngine.blackboardRead(NOVEL_A, 'loop_test').value, 'turn1', '工具真的生效了');
    } finally {
        novel.generateStream = origStream;
    }
    console.log('✅ H5-7: 循环 → 工具 → DONE');
});

test('H5: director 循环 — 达到最大轮次不死循环', async () => {
    const origStream = novel.generateStream;
    let calls = 0;
    novel.generateStream = async () => {
        calls++;
        // 永远只调工具，从不 DONE
        return { ok: true, text: '<<<TOOL_CALL>>>{"name":"blackboardWrite","args":{"key":"spin","value":"' + calls + '"}}<<<END>>>' };
    };
    try {
        const ctx = { novelId: NOVEL_A, provider: { provider: 'mock', model: 'm' }, signal: null };
        const r = await novelEngine._runDirectorLoop(NOVEL_A, { goal: '死循环测试' }, ctx);
        assert.equal(r.ok, true, '超轮次仍返回 ok（带说明）');
        assert.ok(/最大轮次/.test(r.summary), 'summary 说明达到上限');
        assert.equal(calls, novelEngine.DIRECTOR_MAX_TURNS, `恰好 ${novelEngine.DIRECTOR_MAX_TURNS} 轮后停止`);
    } finally {
        novel.generateStream = origStream;
    }
    console.log('✅ H5-8: 最大轮次保护');
});

test('H5: director 循环 — LLM 报错优雅返回', async () => {
    const origStream = novel.generateStream;
    novel.generateStream = async () => { throw new Error('连接超时'); };
    try {
        const ctx = { novelId: NOVEL_A, provider: { provider: 'mock', model: 'm' }, signal: null };
        const r = await novelEngine._runDirectorLoop(NOVEL_A, { goal: 'x' }, ctx);
        assert.equal(r.ok, false);
        assert.ok(/连接超时/.test(r.error), '透出底层错误');
    } finally {
        novel.generateStream = origStream;
    }
    console.log('✅ H5-9: LLM 失败不抛穿');
});

test('H5: director 循环 — LLM 既不调工具也不 DONE 时不卡死', async () => {
    const origStream = novel.generateStream;
    let calls = 0;
    novel.generateStream = async () => {
        calls++;
        return { ok: true, text: '嗯……我觉得这本小说很有意思。' };
    };
    try {
        const ctx = { novelId: NOVEL_A, provider: { provider: 'mock', model: 'm' }, signal: null };
        const r = await novelEngine._runDirectorLoop(NOVEL_A, { goal: 'x' }, ctx);
        assert.equal(r.ok, true);
        assert.equal(r.toolHistory.length, 0, '没有工具被执行');
        assert.equal(calls, novelEngine.DIRECTOR_MAX_TURNS, '重试到上限后退出');
    } finally {
        novel.generateStream = origStream;
    }
    console.log('✅ H5-10: 空回复不卡死');
});

// ============ H6: 模式开关 + fallback ============

test('H6: 调度模式默认 pipeline，可切换、可持久化', () => {
    assert.equal(novelEngine.getDirectorMode(), 'pipeline', '默认 pipeline');

    const r = novelEngine.setDirectorMode('director');
    assert.equal(r.ok, true);
    assert.equal(novelEngine.getDirectorMode(), 'director', '切换后读到 director');

    const bad = novelEngine.setDirectorMode('nonsense');
    assert.equal(bad.ok, false, '非法值被拒');
    assert.equal(novelEngine.getDirectorMode(), 'director', '非法值不污染现有配置');

    novelEngine.setDirectorMode('pipeline');
    assert.equal(novelEngine.getDirectorMode(), 'pipeline');
    console.log('✅ H6-1: 模式开关');
});

test('H6: pipeline 模式下不调 director，直接跑 fallback', async () => {
    novelEngine.setDirectorMode('pipeline');
    let fallbackRan = false;
    const r = await novelEngine._directorOrPipeline(NOVEL_A, '目标', async () => {
        fallbackRan = true;
        return { pipelineOutput: true };
    });
    assert.equal(r.via, 'pipeline');
    assert.equal(fallbackRan, true, 'fallback 执行了');
    assert.deepEqual(r.result, { pipelineOutput: true });
    console.log('✅ H6-2: pipeline 模式直通');
});

test('H6: director 模式失败时自动 fallback 回 pipeline', async () => {
    novelEngine.setDirectorMode('director');
    const origStream = novel.generateStream;
    novel.generateStream = async () => { throw new Error('provider 挂了'); };
    let fallbackRan = false;
    try {
        const r = await novelEngine._directorOrPipeline(NOVEL_A, '目标', async () => {
            fallbackRan = true;
            return { pipelineOutput: true };
        });
        assert.equal(r.via, 'pipeline-fallback', 'director 失败后走 fallback');
        assert.equal(fallbackRan, true, 'fallback 兜底执行');
    } finally {
        novel.generateStream = origStream;
        novelEngine.setDirectorMode('pipeline');
    }
    console.log('✅ H6-3: director 失败自动兜底');
});

test('H6: _extractOutlineFromDirector 从 skillResults 回收大纲', () => {
    const outline = { world: '架空唐朝', characters: [{ name: '林晚' }], chapter_list: [{ no: 1 }] };
    const got = novelEngine._extractOutlineFromDirector(NOVEL_A, {
        skillResults: [
            { skill: 'style-analyst', output: { output: { tone: '冷峻' } } },
            { skill: 'outline-synthesizer', output: { output: outline } },
        ],
    });
    assert.ok(got, '回收到大纲');
    assert.equal(got.world, '架空唐朝');
    console.log('✅ H6-4: 从 director 结果回收大纲');
});

test('H6: _extractOutlineFromDirector 没有可用结果时返回 null（触发兜底）', () => {
    const got = novelEngine._extractOutlineFromDirector('novel-never-existed', { skillResults: [] });
    assert.equal(got, null, '拿不到则返回 null，让调用方兜底');
    console.log('✅ H6-5: 无结果返回 null');
});

test('H6: _extractChapterFromDirector 回收正文并算字数', () => {
    const content = '林晚推开门，'.repeat(20);
    const got = novelEngine._extractChapterFromDirector(NOVEL_A, 'ch-x', {
        skillResults: [{ skill: 'chapter-streamer', output: { output: { content } } }],
    });
    assert.ok(got, '回收到正文');
    assert.equal(got.content, content);
    assert.ok(got.wordCount > 0, '字数已计算');
    console.log('✅ H6-6: 回收章节正文，字数=', got.wordCount);
});

test('H6: _extractChapterFromDirector 忽略过短的伪正文', () => {
    const got = novelEngine._extractChapterFromDirector('novel-never-existed', 'ch-y', {
        skillResults: [{ skill: 'chapter-streamer', output: { output: { content: '好的' } } }],
    });
    assert.equal(got, null, '过短内容不算有效正文');
    console.log('✅ H6-7: 过短正文被拒');
});

// ============ 联调：删除小说时清理 H2/H3/H4 数据 ============

test('联调: deleteNovel 级联清理黑板 / 任务 / 收件箱', () => {
    novelEngine._storeRootForMemory = TMP;
    const NID = 'novel-to-delete';
    store.exec(
        `INSERT INTO _ainovel_novels (id, title, core_idea, target_word_count) VALUES (?, ?, ?, ?)`,
        NID, '待删除的书', '一个用来验证级联清理的核心点子', 100000
    );
    novelEngine.blackboardWrite(NID, 'k', 'v');
    novelEngine.taskCreate(NID, { subject: 't' });
    novelEngine.inboxSend(NID, { to: 'chapter-streamer', from: 'user', text: 'hi' });
    const inboxDir = novelEngine._inboxDir(NID);
    assert.ok(fs.existsSync(inboxDir), '删除前 inbox 目录存在');

    const r = novelEngine.deleteNovel(NID);
    assert.equal(r.ok, true);
    assert.equal(novelEngine.blackboardList(NID).items.length, 0, '黑板已清');
    assert.equal(novelEngine.taskList(NID).tasks.length, 0, '任务已清');
    assert.ok(!fs.existsSync(inboxDir), 'inbox 目录已删');
    console.log('✅ 联调-1: 级联清理完整');
});
