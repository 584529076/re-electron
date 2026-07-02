// test-promptgen.js — D-27 提示词生成器测试（Node 24，0 依赖）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PROMPT_MODULES, DEFAULT_PROMPT_TAGS, DEFAULT_LLM_CONFIG } = require('./prompt-seed');

// ========== 模块设计 ==========
test('模块: 恰好 12 个', () => {
    assert.equal(DEFAULT_PROMPT_MODULES.length, 12);
});
test('模块: 都有 id/name/order', () => {
    for (const m of DEFAULT_PROMPT_MODULES) {
        assert.ok(m.id, '缺 id');
        assert.ok(m.name, '缺 name');
        assert.ok(Number.isInteger(m.order), 'order 应是整数');
    }
});
test('模块: id 唯一', () => {
    const ids = new Set(DEFAULT_PROMPT_MODULES.map(m => m.id));
    assert.equal(ids.size, DEFAULT_PROMPT_MODULES.length);
});
test('模块: order 1-12 连续', () => {
    const orders = DEFAULT_PROMPT_MODULES.map(m => m.order).sort((a, b) => a - b);
    assert.deepEqual(orders, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

// ========== 标签设计 ==========
test('标签: 恰好 70 个', () => {
    assert.equal(DEFAULT_PROMPT_TAGS.length, 70);
});
test('标签: id 唯一', () => {
    const ids = new Set(DEFAULT_PROMPT_TAGS.map(t => t.id));
    assert.equal(ids.size, DEFAULT_PROMPT_TAGS.length);
});
test('标签: id 格式 = module:name', () => {
    for (const t of DEFAULT_PROMPT_TAGS) {
        assert.match(t.id, /^[a-z_]+:[a-z0-9_]+$/, `非法 id: ${t.id}`);
        assert.ok(t.module, '缺 module');
        assert.ok(t.name, '缺 name');
        assert.ok(Number.isInteger(t.order), 'order 应是整数');
    }
});
test('标签: module 字段都在已定义模块中', () => {
    const modIds = new Set(DEFAULT_PROMPT_MODULES.map(m => m.id));
    for (const t of DEFAULT_PROMPT_TAGS) {
        assert.ok(modIds.has(t.module), `标签 ${t.id} 的 module ${t.module} 不在模块列表中`);
    }
});
test('标签: 各模块数量', () => {
    const expected = { env: 8, light: 6, style: 8, subject: 6, character: 8, body: 4, hair: 6, expression: 4, clothing: 6, angle: 4, tone: 5, mood: 5 };
    const actual = {};
    for (const t of DEFAULT_PROMPT_TAGS) actual[t.module] = (actual[t.module] || 0) + 1;
    assert.deepEqual(actual, expected);
});

// ========== LLM 默认配置 ==========
test('LLM: 默认 baseUrl = http://localhost:11434', () => {
    assert.equal(DEFAULT_LLM_CONFIG.baseUrl, 'http://localhost:11434');
});
test('LLM: 默认 model 空（用户首次启动时从 Ollama 拉）', () => {
    assert.equal(DEFAULT_LLM_CONFIG.model, '');
});
test('LLM: 默认 temperature 0.7', () => {
    assert.equal(DEFAULT_LLM_CONFIG.temperature, 0.7);
});
test('LLM: 系统提示词含关键指令', () => {
    const sp = DEFAULT_LLM_CONFIG.systemPrompt;
    assert.ok(sp.length > 50, '系统提示词太短');
    assert.match(sp, /提示词/);
    assert.match(sp, /不.*拼接|不.*简单/);
    assert.match(sp, /\d/);  // 包含字数限制数字
});

// ========== Ollama 客户端（错误路径） ==========
test('Ollama: listModels 不可用时返回 ok:false', async () => {
    const { listModels } = require('./llm');
    // 用一个不存在的端口
    const r = await listModels('http://localhost:1');
    assert.equal(r.ok, false);
    assert.ok(r.error);
});
test('Ollama: generate 没指定 model 报错', async () => {
    const { generate } = require('./llm');
    const r = await generate({ model: '', prompt: 'x', jobId: 't1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /model/);
});
test('Ollama: cancelJob 无效 id 返回 false', () => {
    const { cancelJob } = require('./llm');
    assert.equal(cancelJob('not-exist'), false);
});

// ========== Prompt 构造（用户 prompt 字符串拼装逻辑） ==========
function buildUserPrompt(tags, modules) {
    const lines = [];
    for (const m of (modules || [])) {
        const ts = (tags || []).filter(t => t.module === m.id);
        if (ts.length > 0) {
            lines.push(`【${m.name}】${ts.map(t => t.name).join('、')}`);
        }
    }
    return lines.length > 0
        ? `请基于以下标签组合，撰写一段详细的 AI 绘图提示词：\n\n${lines.join('\n')}`
        : '请自由创作一段详细的 AI 绘图提示词。';
}

test('Prompt: 多模块拼装', () => {
    const tags = [
        { id: 'env:campus', module: 'env', name: '校园' },
        { id: 'light:warm_sun', module: 'light', name: '暖阳' },
    ];
    const mods = [
        { id: 'env', name: '环境' },
        { id: 'light', name: '光照' },
    ];
    const p = buildUserPrompt(tags, mods);
    assert.match(p, /【环境】校园/);
    assert.match(p, /【光照】暖阳/);
    assert.match(p, /AI 绘图提示词/);
});
test('Prompt: 空标签 → 自由创作', () => {
    const p = buildUserPrompt([], [{ id: 'env', name: '环境' }]);
    assert.match(p, /自由创作/);
});
test('Prompt: 模块顺序按传入顺序', () => {
    const tags = [
        { id: 'env:campus', module: 'env', name: '校园' },
        { id: 'mood:warm', module: 'mood', name: '温馨' },
    ];
    const mods = [
        { id: 'env', name: '环境' },
        { id: 'mood', name: '氛围' },
    ];
    const p = buildUserPrompt(tags, mods);
    const envIdx = p.indexOf('【环境】');
    const moodIdx = p.indexOf('【氛围】');
    assert.ok(envIdx < moodIdx, '环境应在氛围之前');
});

// ========== splitExts 沿用（已被 D-26 测过） ==========
function splitExts(s) {
    return String(s || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}
test('splitExts: D-26 兼容', () => {
    assert.deepEqual(splitExts('jpg, jpeg, png'), ['jpg', 'jpeg', 'png']);
});
