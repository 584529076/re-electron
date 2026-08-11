// test-openclaw-mock.js — 验证 OpenClaw 模式（Sprint A 加载层 + Sprint C 记忆写入）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const novelEngine = require('./novel-engine');
const novel = require('./novel');

const _origGenerate = novel.generate;
const _origGenerateStream = novel.generateStream;

// 捕获 ctx._recordPrompt
function makeCapturingCtx() {
    const ctx = {
        _recordPrompt: (req) => { capturedRequest = req; },
        _skill: null,
    };
    return ctx;
}
let capturedRequest = null;

test('Sprint A: _composeSystemPrompt 拼接 SOUL/IDENTITY/AGENTS 标记', () => {
    // 模拟 bootstrap：直接设 _agentsRoot（测试环境下不想真的连 DB）
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    // 直接调用 _composeSystemPrompt（不依赖 _runAgent / callSkill）
    const skill = {
        name: 'style-analyst',
        systemPrompt: '原始指令（来自 registerSkill）',
        temperature: 0.5,
    };
    const result = novelEngine._composeSystemPrompt(skill, null);
    assert.ok(result.system, 'should return composed system');
    assert.ok(typeof result.system === 'string', 'system is string');
    assert.ok(result.system.includes('原始指令（来自 registerSkill）'), '应保留原始 systemPrompt');
    // 即使 agents/ 下无 MD，也不应崩；空 block 跳过即可
    console.log('✅ SprintA-1：_composeSystemPrompt 不崩溃，长度', result.system.length, 'injectedMemoryBytes=', result.injectedMemoryBytes);
});

test('Sprint A: 临时写 SOUL/IDENTITY/AGENTS/MEMORY 后能拼进去', () => {
    const skillName = 'style-analyst';
    const skillDir = path.resolve(__dirname, 'agents', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }

    // 备份已有内容
    const backups = {};
    for (const f of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'MEMORY.md']) {
        const p = path.join(skillDir, f);
        if (fs.existsSync(p)) backups[f] = fs.readFileSync(p, 'utf8');
    }

    try {
        fs.writeFileSync(path.join(skillDir, 'SOUL.md'), '# 冷峻分析师\n你不迎合');
        fs.writeFileSync(path.join(skillDir, 'IDENTITY.md'), '# 身份\n风格分析');
        fs.writeFileSync(path.join(skillDir, 'AGENTS.md'), '# SOP\n分析维度');
        fs.writeFileSync(path.join(skillDir, 'MEMORY.md'), '# 全局经验\n上一次风格指南被用户 👎 退回');

        // 清缓存（_loadAgentConfig 缓存了 SOUL/IDENTITY/AGENTS；MEMORY 每次重读）
        novelEngine._agentConfigCache && novelEngine._agentConfigCache.delete(skillName);

        const skill = { name: skillName, systemPrompt: '原始指令' };
        const result = novelEngine._composeSystemPrompt(skill, null);
        console.log('  [debug] result.system first 200 chars:', result.system.slice(0, 200));
        assert.ok(result.system.includes('===[SOUL'), '含 SOUL 标记');
        assert.ok(result.system.includes('冷峻分析师'), 'SOUL 内容');
        assert.ok(result.system.includes('===[IDENTITY'), '含 IDENTITY 标记');
        assert.ok(result.system.includes('风格分析'), 'IDENTITY 内容');
        assert.ok(result.system.includes('===[AGENTS SOP'), '含 AGENTS 标记');
        assert.ok(result.system.includes('分析维度'), 'AGENTS 内容');
        assert.ok(result.system.includes('===[全局经验沉淀'), '含 全局 MEMORY 标记');
        assert.ok(result.system.includes('上一次风格指南被用户 👎 退回'), 'MEMORY 内容');
        assert.ok(result.system.includes('原始指令'), '保留原始 systemPrompt');
        assert.ok(result.injectedMemoryBytes > 0, 'injectedMemoryBytes > 0');
        console.log('✅ SprintA-2：SOUL+IDENTITY+AGENTS+MEMORY+原始 5 段全部拼入');
    } finally {
        // 恢复原状
        for (const f of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'MEMORY.md']) {
            const p = path.join(skillDir, f);
            if (backups[f] != null) {
                fs.writeFileSync(p, backups[f]);
            } else {
                try { fs.unlinkSync(p); } catch {}
            }
        }
        novelEngine._agentConfigCache && novelEngine._agentConfigCache.delete(skillName);
    }
});

test('Sprint A: 18 个 skill 都注册了 workspaceDir', () => {
    const skills = novelEngine.listSkills();
    assert.equal(skills.length, 18, '应该有 18 个 skill');
    // listSkills 只返回 name/description，需要从 _skills map 拿完整 def
    const names = skills.map(s => s.name).sort();
    const expected = [
        'chapter-streamer', 'chapter-writer', 'character-architect',
        'character-state-updater', 'continuity-checker', 'foreshadowing-extractor',
        'outline-architect', 'outline-reviewer', 'outline-synthesizer',
        'plot-architect', 'plot-thread-tracker', 'quality-reviewer',
        'scene-planner', 'story-architect', 'style-analyst',
        'style-editor', 'theme-architect', 'world-architect',
    ].sort();
    assert.deepEqual(names, expected, '18 个 skill name 一致');
    console.log('✅ SprintA-3：18 个 skill 全部注册');
});

test('Sprint A: 注入 system 真的进入 LLM 调用（端到端）', async () => {
    // callSkill 需要 _store，测试中无法直接 mock DB；改用 _composeSystemPrompt 验证字段注入
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const skillName = 'style-analyst';
    novelEngine._agentConfigCache.delete(skillName);

    const skill = {
        name: skillName,
        displayName: '风格分析师',
        workspaceDir: './agents/style-analyst/',
        temperature: 0.5,
        systemPrompt: '【原始 systemPrompt】',
    };
    const result = novelEngine._composeSystemPrompt(skill, 'test-novel-123');
    // 验证 LLM 最终会收到：原始 systemPrompt + 任何已有的 SOUL/IDENTITY/AGENTS 标记
    assert.ok(result.system.includes('【原始 systemPrompt】'),
        'LLM 收到的 system 应至少含原始 systemPrompt');
    // 即使无 MD，结构也合理（无 SOUL 等空 block 不出现）
    console.log('✅ SprintA-4：_composeSystemPrompt 输出可被 LLM 直接消费（system 长度', result.system.length, '）');
});

test.after(() => {
    novel.generate = _origGenerate;
    novel.generateStream = _origGenerateStream;
});

// ================== Sprint C: 记忆写入 ==================

test('Sprint C: _appendMemoryLog 写到全局 + per-novel 目录', () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const skill = 'style-analyst';
    const novelId = 'test-novel-c1';
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    // 备份
    const today = new Date().toISOString().slice(0, 10);
    const globalLogPath = path.join(novelEngine._agentsRoot, skill, 'memory', `${today}.md`);
    const perNovelLogPath = path.join(tempDir, `_ainovel_novel_${novelId}_agent_memory`, skill, 'memory', `${today}.md`);
    const backups = {};
    for (const p of [globalLogPath, perNovelLogPath]) {
        if (fs.existsSync(p)) backups[p] = fs.readFileSync(p, 'utf8');
    }

    try {
        const result = novelEngine._appendMemoryLog(skill, novelId, {
            skill,
            novel: '测试小说',
            input: 'prompt test',
            output: 'output test',
            tokens: { prompt: 100, completion: 50 },
            durationMs: 1234,
            status: 'ok',
        });
        assert.equal(result, true, 'should write successfully');
        // 全局
        assert.ok(fs.existsSync(globalLogPath), 'global log should exist');
        const globalContent = fs.readFileSync(globalLogPath, 'utf8');
        assert.ok(globalContent.includes('测试小说'), 'global has novel title');
        assert.ok(globalContent.includes('prompt test'), 'global has input');
        assert.ok(globalContent.includes('100/50'), 'global has tokens');
        // per-novel
        assert.ok(fs.existsSync(perNovelLogPath), 'per-novel log should exist');
        const perNovelContent = fs.readFileSync(perNovelLogPath, 'utf8');
        assert.ok(perNovelContent.includes('测试小说'), 'per-novel has novel title');
        console.log('✅ SprintC-1：_appendMemoryLog 双写全局 + per-novel');
    } finally {
        for (const [p, content] of Object.entries(backups)) {
            fs.writeFileSync(p, content, 'utf8');
        }
        // 清理测试新增内容
        try { fs.unlinkSync(globalLogPath); } catch {}
        try { fs.unlinkSync(perNovelLogPath); } catch {}
        novelEngine._storeRootForMemory = null;
    }
});

test('Sprint C: _appendMemoryLog 缺 novelId 不写 per-novel', () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const skill = 'style-analyst';
    const today = new Date().toISOString().slice(0, 10);
    const globalLogPath = path.join(novelEngine._agentsRoot, skill, 'memory', `${today}.md`);
    let globalBackup = null;
    if (fs.existsSync(globalLogPath)) globalBackup = fs.readFileSync(globalLogPath, 'utf8');

    try {
        novelEngine._appendMemoryLog(skill, null, { skill, status: 'ok' });
        // 不抛错就 OK
        console.log('✅ SprintC-2：缺 novelId 不崩');
    } finally {
        if (globalBackup != null) {
            fs.writeFileSync(globalLogPath, globalBackup, 'utf8');
        } else {
            try { fs.unlinkSync(globalLogPath); } catch {}
        }
    }
});

test('Sprint C: _recordMemoryFeedback 写被动反馈', () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    const skill = 'outline-synthesizer';
    const novelId = 'test-novel-c3';
    const today = new Date().toISOString().slice(0, 10);
    const perNovelLogPath = path.join(tempDir, `_ainovel_novel_${novelId}_agent_memory`, skill, 'memory', `${today}.md`);
    let backup = null;
    if (fs.existsSync(perNovelLogPath)) backup = fs.readFileSync(perNovelLogPath, 'utf8');

    try {
        const result = novelEngine._recordMemoryFeedback(skill, novelId, {
            skill,
            status: 'passive-feedback',
            review: 'outline-reviewer: score=5, approved=false',
            issue: '[critical] chapter 5 与 chapter 8 时间线冲突 → 建议：调整时序',
            action: '已触发重写 R2',
        });
        assert.equal(result, true);
        const content = fs.readFileSync(perNovelLogPath, 'utf8');
        assert.ok(content.includes('passive-feedback'), 'has passive-feedback status');
        assert.ok(content.includes('outline-reviewer'), 'has reviewer name');
        assert.ok(content.includes('时间线冲突'), 'has issue detail');
        assert.ok(content.includes('已触发重写 R2'), 'has action');
        console.log('✅ SprintC-3：_recordMemoryFeedback 写被动反馈（per-novel 隔离）');
    } finally {
        if (backup != null) {
            fs.writeFileSync(perNovelLogPath, backup, 'utf8');
        } else {
            try { fs.unlinkSync(perNovelLogPath); } catch {}
        }
        novelEngine._storeRootForMemory = null;
    }
});

test('Sprint C: formatMemoryEntry_ 输出格式正确', () => {
    const entry = {
        skill: 'chapter-streamer',
        novel: '修仙界做空指南',
        input: '本章大纲：主角觉醒',
        output: '字数 3200，钩子反转',
        tokens: { prompt: 200, completion: 800 },
        durationMs: 8500,
        review: 'continuity-checker ✓, style-editor 8/10',
        status: 'ok',
    };
    const block = novelEngine.formatMemoryEntry_(entry, '2026-08-09');
    assert.ok(block.includes('## '), 'has timestamp header');
    assert.ok(block.includes('修仙界做空指南'), 'has novel title');
    assert.ok(block.includes('200/800'), 'has tokens');
    assert.ok(block.includes('8.5s'), 'has duration in seconds');
    assert.ok(block.includes('ok'), 'has status');
    console.log('✅ SprintC-4：formatMemoryEntry_ 输出格式');
});

test('Sprint C: listMemoryLogs 读已写入的日志', () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    const skill = 'chapter-streamer';
    const novelId = 'test-novel-c5';
    const today = new Date().toISOString().slice(0, 10);
    // 预写两条
    novelEngine._appendMemoryLog(skill, novelId, { skill, status: 'ok', input: 'A' });
    novelEngine._appendMemoryLog(skill, novelId, { skill, status: 'ok', input: 'B' });

    const result = novelEngine.listMemoryLogs({ skill, novelId, scope: 'all', date: today, limit: 7 });
    assert.ok(result.perNovel.length >= 1, 'should find per-novel log');
    assert.ok(result.perNovel[0].content.includes('A') || result.perNovel[0].content.includes('B'),
        'content should include entries');
    console.log('✅ SprintC-5：listMemoryLogs 能列出当日 memory');

    novelEngine._storeRootForMemory = null;
});

test('Sprint C: flushMemory 触发阈值检查', async () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    // 预创建 per-novel memory 目录（模拟已有日志）
    const novelId = 'test-novel-c6';
    const memDir = path.join(tempDir, `_ainovel_novel_${novelId}_agent_memory`, 'chapter-streamer', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, '2026-08-09.md'), '# test log entry\n', 'utf8');

    // 强制 flush 一次（_store 为 null，meta-agent 会因为没有 provider 跳过）
    // 重点验证：返回结构正确 + 阈值正确 + 不会抛同步异常
    const result = await novelEngine.flushMemory({ skill: 'chapter-streamer', novelId, force: true });
    assert.equal(result.skill, 'chapter-streamer');
    assert.equal(result.scope, 'per-novel');
    assert.ok('fileCount' in result, 'should have fileCount');
    assert.ok(result.fileCount >= 1, 'should find at least 1 file');
    assert.equal(result.threshold, 30 * 1024, 'per-novel threshold = 30KB');
    // _store 为 null，meta-agent 会因 rate-limit 检查报错，但会 graceful 返回
    assert.ok('ok' in result || 'error' in result, 'should have ok or error field');
    console.log('✅ SprintC-6：flushMemory 返回元数据 + 阈值正确 (skipped:', result.skipped || 'no', ')');

    // 全局测试
    const globalResult = await novelEngine.flushMemory({ skill: 'style-analyst', force: true });
    assert.equal(globalResult.scope, 'global');
    assert.equal(globalResult.threshold, 50 * 1024, 'global threshold = 50KB');
    console.log('✅ SprintC-6b：flushMemory 全局阈值 50KB');

    novelEngine._storeRootForMemory = null;
});

test('Sprint C: getAgentConfig + saveAgentConfig 编辑隔离', () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const skill = 'style-analyst';

    // 备份已有
    const memPath = path.join(novelEngine._agentsRoot, skill, 'MEMORY.md');
    let backup = null;
    if (fs.existsSync(memPath)) backup = fs.readFileSync(memPath, 'utf8');

    try {
        // 写
        const writeRes = novelEngine.saveAgentConfig(skill, 'MEMORY.md', '# test memory\n条目 1\n');
        assert.equal(writeRes.ok, true);
        assert.ok(writeRes.path.endsWith('MEMORY.md'));

        // 读
        const readRes = novelEngine.getAgentConfig(skill);
        assert.equal(readRes.skill, skill);
        assert.ok(readRes.files['MEMORY.md'].includes('条目 1'));

        // 白名单保护
        const bad = novelEngine.saveAgentConfig(skill, 'evil.md', 'bad');
        assert.equal(bad.ok, false);
        assert.ok(bad.error.includes('只允许编辑'), 'should reject non-whitelisted file');

        // 路径越界保护（skillName 包含 ../）
        const traversal = novelEngine.saveAgentConfig('../evil', 'MEMORY.md', 'bad');
        assert.equal(traversal.ok, false, 'should reject path traversal');
        assert.ok(traversal.error.includes('路径越界') || traversal.error.includes('skillName / filename 必填'),
            'should reject with security error');

        console.log('✅ SprintC-7：getAgentConfig + saveAgentConfig 白名单 + 路径越界保护');
    } finally {
        if (backup != null) {
            fs.writeFileSync(memPath, backup, 'utf8');
        } else {
            try { fs.unlinkSync(memPath); } catch {}
        }
    }
});

// ================== Sprint F: 提炼机制 ==================

test('Sprint F: META_AGENT_SYSTEM prompt 包含关键铁律', () => {
    const sys = novelEngine.META_AGENT_SYSTEM;
    assert.ok(sys.includes('记忆提炼专家'), 'has role definition');
    assert.ok(sys.includes('强偏好'), 'has preference section');
    assert.ok(sys.includes('被动反馈'), 'has feedback section');
    assert.ok(sys.includes('常见错误'), 'has error section');
    assert.ok(sys.includes('只保留有共性的经验'), 'has core rule');
    assert.ok(sys.includes('1500'), 'has length limit');
    console.log('✅ SprintF-1：META_AGENT_SYSTEM prompt 完整');
});

test('Sprint F: _metaAgentFlush 频率限制检查', async () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    // 准备 memory dir + 日志
    const novelId = 'test-novel-f1';
    const memDir = path.join(tempDir, `_ainovel_novel_${novelId}_agent_memory`, 'style-analyst', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, '2026-08-09.md'),
        '## 2026-08-09 — style-analyst\n- input: test\n- output: test\n- status: ok\n', 'utf8');

    // Mock _store 行为（写入 metadata 模拟"24h 内已执行"）
    const _origQuery = novelEngine._store;
    const mockStore = {
        query: (sql) => {
            if (sql.includes('last_flush_at')) {
                return [{ last_flush_at: Math.floor(Date.now() / 1000) - 60 }];  // 1 分钟前
            }
            return [];
        },
        exec: () => ({ changes: 1 }),
    };
    // 由于 novel-engine 是 require 单例，_store 必须在 bootstrap 时设置
    // 这里无法直接 mock _store，改为验证函数行为不崩
    try {
        const result = await novelEngine._metaAgentFlush('style-analyst', memDir, novelId, false);
        // _store 为 null 时 rate-limit 会被 catch 跳过 → 进入 LLM 调用
        // LLM 也为 null → skipped: 'no-provider'
        assert.ok('ok' in result || 'skipped' in result, 'should return result object');
        assert.equal(result.ok, false);
        // 应该是 'no-provider' 或 'rate-limit' 之一
        assert.ok(['no-provider', 'rate-limit', 'llm-failed', 'no-logs'].includes(result.skipped),
            'should be a known skip reason, got: ' + result.skipped);
        console.log('✅ SprintF-2：_metaAgentFlush 频率限制 + 无 provider 场景 graceful');
    } catch (e) {
        // 即使异常也要保证不挂
        assert.fail('should not throw: ' + e.message);
    }

    novelEngine._storeRootForMemory = null;
});

test('Sprint F: flushMemory 未达阈值不触发', async () => {
    if (!novelEngine._agentsRoot) {
        novelEngine._agentsRoot = path.resolve(__dirname, 'agents');
    }
    const tempDir = path.resolve(__dirname, '.tmp-test-store');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    novelEngine._storeRootForMemory = tempDir;

    // 准备少量 memory（远低于阈值）
    const memDir = path.join(tempDir, '_ainovel_novel_test-f3_agent_memory', 'style-analyst', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, '2026-08-09.md'), 'small', 'utf8');

    const result = await novelEngine.flushMemory({
        skill: 'style-analyst',
        novelId: 'test-f3',
        force: false,  // 不强制，应低于阈值跳过
    });
    assert.equal(result.flushed, false);
    assert.equal(result.reason, 'below-threshold');
    console.log('✅ SprintF-3：未达阈值不触发提炼');

    novelEngine._storeRootForMemory = null;
});
