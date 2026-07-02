// test-nsfw.js — D-29 NSFW 模式测试
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NSFW_SYSTEM_PROMPT, NSFW_SOURCE_META } = require('./nsfw-system');

// ========== NSFW system prompt 内容完整性 ==========
test('NSFW system: 含 14 模块组装顺序', () => {
    const sp = NSFW_SYSTEM_PROMPT;
    // 必选 7 项
    assert.match(sp, /场景\+主题|scene \+ theme/);
    assert.match(sp, /景别|shot/);
    assert.match(sp, /裸露|nudity/);
    assert.match(sp, /服装|clothing/);
    assert.match(sp, /光影|lighting/);
    assert.match(sp, /姿势|pose/);
    assert.match(sp, /画质|quality/);
});
test('NSFW system: 含核心规则 6 条', () => {
    const sp = NSFW_SYSTEM_PROMPT;
    assert.match(sp, /裸露词 \+ 姿势词|裸露.*姿势/);
    assert.match(sp, /设备与画质|设备.*画质/);
    assert.match(sp, /冲突|panties|pussy/);
    assert.match(sp, /sheer|see-through|transparent/);
    assert.match(sp, /液体|最小量|drop|streak/);
    assert.match(sp, /纹身|皮肤融合|6/);
});
test('NSFW system: 输出语言 = 英文', () => {
    const sp = NSFW_SYSTEM_PROMPT;
    assert.match(sp, /英文|English/);
});
test('NSFW system: 词数控制在 150-250', () => {
    const sp = NSFW_SYSTEM_PROMPT;
    assert.match(sp, /150-250|150.*250/);
});
test('NSFW system: 不用任何具体 NSFW 词条', () => {
    // 验证 system prompt 不包含具体成人词条（避免内置受限内容）
    const sp = NSFW_SYSTEM_PROMPT.toLowerCase();
    const banned = ['naked', 'nipple', 'vagina', 'penis', 'orgasm', 'cum'];
    for (const b of banned) {
        assert.ok(!sp.includes(b), `system prompt 不应含具体词 "${b}"`);
    }
    // 只包含规则框架
    assert.match(sp, /l[1-6]/);  // 裸露等级
});

// ========== NSFW source meta ==========
test('NSFW meta: 含仓库信息', () => {
    assert.equal(NSFW_SOURCE_META.repo, 'ShuaiHui/nsfw-prompt-templates-asian');
    assert.ok(NSFW_SOURCE_META.url.startsWith('https://'));
    assert.equal(NSFW_SOURCE_META.license, 'MIT');
});
test('NSFW meta: 声明不下载具体模板', () => {
    assert.match(NSFW_SOURCE_META.note, /不下载|不存储/);
});

// ========== Ollama 客户端 + NSFW prompt 拼装（沿用 D-27 逻辑） ==========
function pickSystemPrompt(cfg, mode) {
    if (cfg.systemPrompts) return cfg.systemPrompts[mode] || '';
    if (cfg.systemPrompt) return mode === 'sfw' ? cfg.systemPrompt : '';
    return '';
}

test('mode 切换: sfw 走 sfw system', () => {
    const cfg = { mode: 'sfw', systemPrompts: { sfw: 'A', nsfw: 'B' } };
    assert.equal(pickSystemPrompt(cfg, 'sfw'), 'A');
});
test('mode 切换: nsfw 走 nsfw system', () => {
    const cfg = { mode: 'nsfw', systemPrompts: { sfw: 'A', nsfw: 'B' } };
    assert.equal(pickSystemPrompt(cfg, 'nsfw'), 'B');
});
test('mode 切换: 老 schema 兼容 (systemPrompt 字符串)', () => {
    const cfg = { mode: 'sfw', systemPrompt: 'old' };
    assert.equal(pickSystemPrompt(cfg, 'sfw'), 'old');
    assert.equal(pickSystemPrompt(cfg, 'nsfw'), '');
});
test('mode 切换: 缺 mode 默认 sfw', () => {
    const cfg = { systemPrompts: { sfw: 'A', nsfw: 'B' } };
    assert.equal(pickSystemPrompt(cfg, 'sfw'), 'A');
});

// ========== README 缓存逻辑 ==========
test('README 缓存: 24h 内命中', () => {
    const meta = { readmeCachedAt: Date.now() - 23 * 3600 * 1000 };
    const isHit = meta.readmeCachedAt && (Date.now() - meta.readmeCachedAt) < 24 * 3600 * 1000;
    assert.equal(isHit, true);
});
test('README 缓存: 超过 24h 失效', () => {
    const meta = { readmeCachedAt: Date.now() - 25 * 3600 * 1000 };
    const isHit = meta.readmeCachedAt && (Date.now() - meta.readmeCachedAt) < 24 * 3600 * 1000;
    assert.equal(isHit, false);
});

// ========== 完整 userPrompt 构造（D-27 + D-29 共用） ==========
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

test('userPrompt: 多模块多标签', () => {
    const tags = [
        { id: 'env:cafe', module: 'env', name: '咖啡馆' },
        { id: 'light:warm_sun', module: 'light', name: '暖阳' },
    ];
    const mods = [{ id: 'env', name: '环境' }, { id: 'light', name: '光照' }];
    const p = buildUserPrompt(tags, mods);
    assert.match(p, /【环境】咖啡馆/);
    assert.match(p, /【光照】暖阳/);
});
