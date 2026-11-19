// novel-engine.js — AI 小说模块引擎
//
// 职责：
//   - Skill Registry（注册/调用/编排）
//   - DB Schema 初始化（6 张 _ainovel_* 表）
//   - 上下文隔离（每个 novelId 一个独立 context Map）
//   - 大纲/章节生成（调用 novel.js provider adapter）
//   - 生成日志（写 _ainovel_generations）
//   - notifyRenderer 推 ainovel:event:update 事件
//
// 完全独立：不依赖 llm.js / comfyui-* / task-queue-* / workbench.js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const novel = require('./novel');

// Sprint C-S1: 引入基础设施层
const chapterIntegrity = require('./lib/chapter-integrity');
const { SharedContext } = require('./lib/shared-context');
const { ContextCompressor, STRATEGY } = require('./lib/context-compressor');
const { CostTracker } = require('./lib/cost-tracker');
const { TaskGraph } = require('./orchestrator/task-graph');
const { EventBus } = require('./orchestrator/event-bus');
// Sprint C-S2: 引入 orchestrator（capability 路由 + DAG 执行 + retry/fallback）
const { CapabilityRouter } = require('./orchestrator/capability-router');
const { Scheduler } = require('./orchestrator/scheduler');
const { Orchestrator } = require('./orchestrator/orchestrator');
const { buildOutlinePlan, buildChapterPlan } = require('./orchestrator/plan-builders');

const PROVIDER_CONFIG_KEY = 'ainovel:provider:main';

// ====== Sprint C-S1: 全局基础设施实例 ======
// 这些在 bootstrap() 时被实例化，bootstrap 之前调用相关函数会抛错或 noop
let _sharedContext = null;       // SharedContext 实例
let _contextCompressor = null;   // ContextCompressor 实例
let _costTracker = null;         // CostTracker 实例
let _capabilityRegistry = null;  // 加载后的 registry.json 内容
let _protocolsMd = '';           // _shared/PROTOCOLS.md 内容（注入用）

// ====== Sprint C-S2: Orchestrator 实例 ======
let _capabilityRouter = null;    // CapabilityRouter 实例（按 capability 选 agent）
let _orchestrator = null;        // Orchestrator 实例（DAG 驱动 + retry/fallback）

// ====== Schema 初始化 ======
function ensureTables(store) {
    const SCHEMA = [
        `CREATE TABLE IF NOT EXISTS _ainovel_novels (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            style           TEXT,
            custom_style    TEXT,
            core_idea       TEXT NOT NULL,
            pov             TEXT,
            tone            TEXT,
            target_word_count INTEGER NOT NULL,
            current_word_count INTEGER NOT NULL DEFAULT 0,
            chapter_target_count INTEGER,
            status          TEXT NOT NULL DEFAULT 'planning',
            cover_path      TEXT,
            created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE TABLE IF NOT EXISTS _ainovel_outlines (
            novel_id          TEXT PRIMARY KEY,
            structure         TEXT,
            world_setting     TEXT,
            main_conflict     TEXT,
            themes            TEXT,
            global_characters TEXT,
            chapter_list      TEXT,
            raw_outline       TEXT,
            user_edited       INTEGER NOT NULL DEFAULT 0,
            updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE TABLE IF NOT EXISTS _ainovel_chapters (
            id                TEXT PRIMARY KEY,
            novel_id          TEXT NOT NULL,
            chapter_no        INTEGER NOT NULL,
            title             TEXT,
            outline           TEXT,
            content           TEXT,
            target_word_count INTEGER,
            actual_word_count INTEGER NOT NULL DEFAULT 0,
            status            TEXT NOT NULL DEFAULT 'pending',
            summary           TEXT,
            user_edited       INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            UNIQUE(novel_id, chapter_no)
        )`,
        `CREATE TABLE IF NOT EXISTS _ainovel_generations (
            id                TEXT PRIMARY KEY,
            novel_id          TEXT NOT NULL,
            chapter_id        TEXT,
            skill             TEXT NOT NULL,
            provider          TEXT NOT NULL,
            model             TEXT NOT NULL,
            prompt_tokens     INTEGER,
            completion_tokens INTEGER,
            cost_usd          REAL,
            duration_ms       INTEGER,
            raw_request       TEXT,
            raw_response      TEXT,
            status            TEXT NOT NULL DEFAULT 'ok',
            error_msg         TEXT,
            created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE TABLE IF NOT EXISTS _ainovel_provider_config (
            key               TEXT PRIMARY KEY,
            provider          TEXT NOT NULL,
            base_url          TEXT,
            api_key           TEXT,
            model             TEXT NOT NULL,
            temperature       REAL DEFAULT 0.8,
            max_tokens        INTEGER DEFAULT 4000,
            updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE TABLE IF NOT EXISTS _ainovel_style_guides (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            description       TEXT,
            is_builtin        INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        // Phase 3: 知识库表（伏笔 / 现实校验 / 参考设定抽取结果 + 内部使用的人物/设定/时间线缓存）
        `CREATE TABLE IF NOT EXISTS _ainovel_knowledge (
            id          TEXT PRIMARY KEY,
            novel_id    TEXT NOT NULL,
            kind        TEXT NOT NULL,           -- 'foreshadowing' | 'character' | 'setting' | 'verification' | 'reference' | 'timeline'
            title       TEXT NOT NULL,
            detail      TEXT,                    -- 主描述
            meta        TEXT,                    -- JSON: 伏笔关联章节、设定来源、可信度等
            resolved    INTEGER NOT NULL DEFAULT 0,  -- 伏笔/设定是否回收
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        // Phase 4-A: 故事架构表（顶层抽象：3 幕 + 关键节拍 + 子线 + 人物弧线 + 主题落点 + 伏笔种子）
        `CREATE TABLE IF NOT EXISTS _ainovel_architecture (
            novel_id           TEXT PRIMARY KEY,
            three_act          TEXT,                     -- 三幕结构全文（建置/对抗/结局 + 关键节拍）
            plot_threads       TEXT,                     -- JSON: [{id, name, intro_ch, resolve_ch, status, description}]
            character_arcs     TEXT,                     -- JSON: [{name, start, midpoint, end}]
            theme_tracks       TEXT,                     -- JSON: [{theme, act1_manifestation, act2_manifestation, act3_manifestation}]
            foreshadowing_seed TEXT,                     -- JSON: [{id, description, planted_chapter_estimate, payoff_chapter_estimate}]
            raw_architecture   TEXT,                     -- AI 原始响应
            user_edited        INTEGER NOT NULL DEFAULT 0,
            updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        // Phase 4-B: 圣经状态表（跨章节持久化的「剧情当前状态」）
        // 章节写作后会被原子提交（atomic commit）—— revision 自增，失败回滚
        `CREATE TABLE IF NOT EXISTS _ainovel_novel_state (
            novel_id              TEXT PRIMARY KEY,
            global_summary        TEXT,                  -- 全局摘要（最近 3-5 章 + 关键剧情线）
            character_states      TEXT,                  -- JSON: {角色名: {status, location, motivation, last_chapter}}
            active_plot_threads   TEXT,                  -- JSON: [{id, name, current_ch, progress_pct, last_event}]
            planted_foreshadowing TEXT,                  -- JSON: [{id, description, planted_ch, status:planted|paid|abandoned, payoff_ch_estimate}]
            retired_characters    TEXT,                  -- JSON: [角色名]（已退场/已死亡）
            last_chapter_no       INTEGER NOT NULL DEFAULT 0,
            expected_revision     INTEGER NOT NULL DEFAULT 0,   -- 乐观锁：commit 时检查 +1
            updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        // ===== Sprint 7.1: 卷(arc)层级大纲 =====
        // Arc 是介于"全书大纲"和"单章大纲"之间的结构层：
        //   start_ch / end_ch  - 该卷覆盖的章节范围 [start_ch, end_ch]（闭区间）
        //   goal                - 卷目标（一句话）
        //   summary             - 完结后懒生成的卷摘要
        // 约束：sum(end_ch - start_ch + 1) == chapter_count（生成后强制修正）
        `CREATE TABLE IF NOT EXISTS _ainovel_arcs (
            id            TEXT PRIMARY KEY,
            novel_id      TEXT NOT NULL,
            title         TEXT NOT NULL,
            goal          TEXT,
            start_ch      INTEGER NOT NULL,
            end_ch        INTEGER NOT NULL,
            summary       TEXT,
            order_index   INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_arcs_novel ON _ainovel_arcs(novel_id, order_index)`,
        `CREATE INDEX IF NOT EXISTS idx_arcs_range ON _ainovel_arcs(novel_id, start_ch, end_ch)`,
        // ===== Sprint 7.2: 伏笔系统 =====
        // 状态机: planted → progressing → resolved / abandoned
        // events 字段存 JSON 数组 [{chapter, note, created_at}] 用于追踪伏笔生命周期
        `CREATE TABLE IF NOT EXISTS _ainovel_foreshadows (
            id               TEXT PRIMARY KEY,
            novel_id         TEXT NOT NULL,
            name             TEXT NOT NULL,
            description      TEXT,
            plant_chapter    INTEGER NOT NULL,
            target_chapter   INTEGER,             -- 预计回收章号（0/null = 未知）
            status           TEXT NOT NULL DEFAULT 'planted',  -- planted/progressing/resolved/abandoned
            events           TEXT,                 -- JSON: [{chapter, note, created_at}]
            resolution       TEXT,                 -- 回收时的描述
            created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_fs_novel ON _ainovel_foreshadows(novel_id, status)`,
        `CREATE INDEX IF NOT EXISTS idx_fs_plant ON _ainovel_foreshadows(novel_id, plant_chapter)`,
        `CREATE INDEX IF NOT EXISTS idx_fs_target ON _ainovel_foreshadows(novel_id, target_chapter)`,
        // ===== Sprint 7.3: 叙事记忆 =====
        // 章节写作后由 memory-extractor 提取关键细节（人物动机 / 地点描述 / 物品设定 / 未兑现承诺）
        // importance 1-10 影响压缩优先级
        `CREATE TABLE IF NOT EXISTS _ainovel_memory_entries (
                id            TEXT PRIMARY KEY,
                novel_id      TEXT NOT NULL,
                content       TEXT NOT NULL,
                category      TEXT,                 -- character/location/item/event/promise/other
                chapter       INTEGER NOT NULL,     -- 来源章号
                position      INTEGER,             -- 段落在原文中的位置
                snippet       TEXT,                 -- 原文片段（前 200 字）
                importance    INTEGER NOT NULL DEFAULT 5,
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )`,
        `CREATE INDEX IF NOT EXISTS idx_memory_novel ON _ainovel_memory_entries(novel_id, chapter)`,
        `CREATE INDEX IF NOT EXISTS idx_memory_cat ON _ainovel_memory_entries(novel_id, category)`,
        `CREATE INDEX IF NOT EXISTS idx_memory_imp ON _ainovel_memory_entries(novel_id, importance DESC)`,
        // ===== Sprint 8.2: 写作冲突（事实核查失败且重试耗尽）=====
        // 当 continuity-checker 在 max retries 后仍失败时，保存冲突报告而非强制通过。
        // user_action 字段记录用户处理结果：null=未处理；retry/force_review/modify_outline/modify_foreshadow/dismiss
        `CREATE TABLE IF NOT EXISTS _ainovel_writing_conflicts (
                id            TEXT PRIMARY KEY,
                novel_id      TEXT NOT NULL,
                chapter_id    TEXT NOT NULL,
                chapter_no    INTEGER,
                report        TEXT NOT NULL,         -- JSON：{ issues: [...], sources: [...], attempts: N, lastContent: '...' }
                attempts      INTEGER NOT NULL DEFAULT 1,
                user_action   TEXT,                  -- retry / force_review / modify_outline / modify_foreshadow / dismiss / NULL=未处理
                resolved_at   INTEGER,
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_novel ON _ainovel_writing_conflicts(novel_id, chapter_id)`,
        `CREATE INDEX IF NOT EXISTS idx_conflict_open ON _ainovel_writing_conflicts(novel_id, user_action)`,
        // ===== Sprint 8.3: 关系图谱（character/organization/worldview 间关系）=====
        // 由 relation-extractor agent 从章节正文推断 + 用户手动编辑
        `CREATE TABLE IF NOT EXISTS _ainovel_relations (
                id            TEXT PRIMARY KEY,
                novel_id      TEXT NOT NULL,
                source_type   TEXT NOT NULL,        -- character / organization / worldview
                source_id     TEXT NOT NULL,
                source_name   TEXT,                  -- 冗余存储（避免 join character 表）
                target_type   TEXT NOT NULL,
                target_id     TEXT NOT NULL,
                target_name   TEXT,
                label         TEXT,                  -- 关系标签：朋友/敌人/师徒/...
                strength      INTEGER NOT NULL DEFAULT 5,  -- 1-10
                source        TEXT DEFAULT 'manual',-- manual / ai-inferred
                chapter_no    INTEGER,              -- 来源章号（ai-inferred 时记录）
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                UNIQUE(novel_id, source_type, source_id, target_type, target_id, label)
            )`,
        `CREATE INDEX IF NOT EXISTS idx_rel_novel ON _ainovel_relations(novel_id)`,
        `CREATE INDEX IF NOT EXISTS idx_rel_source ON _ainovel_relations(novel_id, source_type, source_id)`,
        `CREATE INDEX IF NOT EXISTS idx_rel_target ON _ainovel_relations(novel_id, target_type, target_id)`,
        // ===== Sprint 9.1: AI 助理 chat 会话 =====
        // 每条 message 是一个 JSON 对象 [{role, content, tool_call?, tool_result?, ts, error?}]
        `CREATE TABLE IF NOT EXISTS _ainovel_chat_sessions (
                id            TEXT PRIMARY KEY,
                novel_id      TEXT NOT NULL,
                title         TEXT,                  -- 用户/AI 起的会话标题
                messages      TEXT NOT NULL DEFAULT '[]',
                status        TEXT NOT NULL DEFAULT 'active',  -- active / archived
                total_tokens  INTEGER NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0,
                last_message_at INTEGER,
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            )`,
        `CREATE INDEX IF NOT EXISTS idx_chat_novel ON _ainovel_chat_sessions(novel_id, updated_at DESC)`,
        // ===== Sprint 9.2: AI 改已填字段的待确认变更 =====
        // 当 AI 输出与 _ainovel_outlines / _ainovel_novels 现有字段冲突时，
        // 不直接写回，而是落盘到 _ainovel_pending_config_changes 让用户确认。
        `CREATE TABLE IF NOT EXISTS _ainovel_pending_config_changes (
                id            TEXT PRIMARY KEY,
                novel_id      TEXT NOT NULL,
                field         TEXT NOT NULL,         -- title / type / writing_style / writing_pov / story_synopsis / world_setting / main_conflict / themes
                current_value TEXT,
                proposed_value TEXT NOT NULL,
                reason        TEXT,                  -- AI 给的理由
                status        TEXT NOT NULL DEFAULT 'pending',  -- pending / accepted / dismissed
                source        TEXT NOT NULL DEFAULT 'chat-agent',  -- chat-agent / review
                created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                resolved_at   INTEGER
            )`,
        `CREATE INDEX IF NOT EXISTS idx_pcc_novel ON _ainovel_pending_config_changes(novel_id, status)`,
    ];
    for (const sql of SCHEMA) store.exec(sql);

    // Phase 3: 知识库索引
    store.exec(`CREATE INDEX IF NOT EXISTS idx_ainovel_knowledge ON _ainovel_knowledge(novel_id, kind)`);

    // Phase 2：pipeline/agent 元数据列。SQLite 无 IF NOT EXISTS for ALTER，
    // 用 PRAGMA table_info 探测后跳过。失败不致命（老库升级）。
    _ensureColumn(store, '_ainovel_generations', 'phase', 'TEXT');
    _ensureColumn(store, '_ainovel_generations', 'agent_name', 'TEXT');
    _ensureColumn(store, '_ainovel_generations', 'round', 'INTEGER DEFAULT 1');
    _ensureColumn(store, '_ainovel_generations', 'display_name', 'TEXT');
    // Phase 4: OpenClaw 模式 — 用户反馈 + 注入 memory 大小
    _ensureColumn(store, '_ainovel_generations', 'user_vote', 'TEXT');
    _ensureColumn(store, '_ainovel_generations', 'feedback_comment', 'TEXT');
    _ensureColumn(store, '_ainovel_generations', 'injected_memory_bytes', 'INTEGER');

    // Sprint X: thinking / reasoning 支持
    _ensureColumn(store, '_ainovel_provider_config', 'thinking_budget', 'INTEGER DEFAULT 0');
    _ensureColumn(store, '_ainovel_provider_config', 'reasoning_effort', 'TEXT');
    _ensureColumn(store, '_ainovel_provider_config', 'thinking_enabled_skills', 'TEXT');  // JSON 数组，指定哪些 skill 默认开 thinking；空/null = 全部用 provider 默认

    // Phase 4: OpenClaw 模式 — 3 张新表（用户反馈 + 提炼元数据 × 2）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_agent_feedback (
        id              TEXT PRIMARY KEY,
        novel_id        TEXT NOT NULL,
        skill           TEXT NOT NULL,
        generation_id   TEXT,
        vote            TEXT NOT NULL,
        comment         TEXT,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_ainovel_feedback
        ON _ainovel_agent_feedback(novel_id, skill, created_at DESC)`);

    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_memory_metadata (
        skill                   TEXT PRIMARY KEY,
        last_global_flush_at    INTEGER,
        global_memory_bytes     INTEGER NOT NULL DEFAULT 0,
        total_flush_count       INTEGER NOT NULL DEFAULT 0
    )`);

    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_novel_memory_metadata (
        novel_id        TEXT NOT NULL,
        skill           TEXT NOT NULL,
        last_flush_at   INTEGER,
        memory_bytes    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (novel_id, skill)
    )`);

    // Sprint H2: Blackboard（项目级共享黑板）
    // 每条 (novel_id, key) 一条记录；value 是文本/JSON；owner 是写入的 agent
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_blackboard (
        id          TEXT PRIMARY KEY,
        novel_id    TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        owner       TEXT,
        version     INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(novel_id, key)
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_ainovel_blackboard
        ON _ainovel_blackboard(novel_id, key)`);

    // Sprint H4: Task List（编剧调度）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_tasks (
        id              TEXT PRIMARY KEY,
        novel_id        TEXT NOT NULL,
        subject         TEXT NOT NULL,
        description     TEXT,
        owner           TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        blocks          TEXT NOT NULL DEFAULT '[]',
        blocked_by      TEXT NOT NULL DEFAULT '[]',
        payload         TEXT,
        result          TEXT,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_ainovel_tasks
        ON _ainovel_tasks(novel_id, status, owner)`);

    // Sprint H6: 通用设置（调度模式开关等）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT,
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);

    // Sprint W: 工作面板事件流（每本小说的 agent 全链路事件持久化）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_workflow_events (
        id          TEXT PRIMARY KEY,
        novel_id    TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        agent       TEXT,
        phase       TEXT,
        status      TEXT NOT NULL,
        summary     TEXT,
        parent_id   TEXT,
        duration_ms INTEGER,
        input       TEXT,
        output      TEXT,
        error       TEXT,
        payload     TEXT
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_events_novel_ts ON _ainovel_workflow_events(novel_id, ts)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_events_kind ON _ainovel_workflow_events(kind)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_events_parent ON _ainovel_workflow_events(parent_id)`);

    // Sprint C-S1-A: capability 匹配审计（orchestrator 选了哪个 agent 来跑某个 capability）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_capability_log (
        id              TEXT PRIMARY KEY,
        novel_id        TEXT NOT NULL,
        capability      TEXT NOT NULL,
        matched_agent   TEXT NOT NULL,
        alternatives    TEXT,              -- JSON: 候选列表 + 排序原因
        task_id         TEXT,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_capability_log_novel ON _ainovel_capability_log(novel_id, created_at DESC)`);

    // Sprint C-S1-B: 每本小说的软成本预算（不设硬阈值，超阈值时提醒 + 调 cost-controller 决策）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_budget (
        novel_id                    TEXT PRIMARY KEY,
        total_tokens_used           INTEGER NOT NULL DEFAULT 0,
        total_cost_usd              REAL NOT NULL DEFAULT 0,
        total_calls                 INTEGER NOT NULL DEFAULT 0,
        soft_warning_threshold_usd  REAL NOT NULL DEFAULT 5.0,   -- 默认 5 元软提醒
        soft_warning_sent           INTEGER NOT NULL DEFAULT 0, -- 是否已发过提醒（避免重复刷屏）
        compression_count           INTEGER NOT NULL DEFAULT 0, -- 累计触发压缩次数
        updated_at                  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);

    // Sprint C-S1-C: 共享上下文层（跨 agent 共享运行时决策中间结果）
    // 与 blackboard 区别：blackboard = 长期 KV；shared_context = 临时结构化 JSON，TTL 可配置，importance 1-10
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_shared_context (
        id              TEXT PRIMARY KEY,
        novel_id        TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT,                     -- JSON 序列化
        version         INTEGER NOT NULL DEFAULT 1,
        importance      INTEGER NOT NULL DEFAULT 5, -- 1-10，影响压缩优先级（10=绝不压缩）
        ttl_ms          INTEGER,                  -- null = 永久；否则 expires_at = created_at + ttl_ms
        source_agent    TEXT,
        source_task     TEXT,
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        expires_at      INTEGER,
        UNIQUE(novel_id, key)
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_shared_ctx_importance ON _ainovel_shared_context(novel_id, importance DESC)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_shared_ctx_expires ON _ainovel_shared_context(novel_id, expires_at)`);

    // Sprint C-S1-D: 压缩审计（记录每次 _composeSystemPrompt 触发了哪些压缩策略）
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_compression_log (
        id          TEXT PRIMARY KEY,
        novel_id    TEXT NOT NULL,
        skill       TEXT NOT NULL,
        strategy    TEXT NOT NULL,           -- 'truncate_tail' | 'evict_expired' | 'importance_filter' | 'head_truncate' | 'llm_summarize' | 'auto'
        saved_bytes INTEGER NOT NULL DEFAULT 0,
        actions     TEXT,                   -- JSON: 详细动作列表
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_compression_log_novel ON _ainovel_compression_log(novel_id, created_at DESC)`);

    // ★ Sprint 6.1: Block 模型（章节段落级编辑 + AI 段落修订）
    // 章节正文按 "\n\n" 切段；每个 block 有稳定 ID + 段落顺序 + 内容哈希
    store.exec(`CREATE TABLE IF NOT EXISTS _ainovel_chapter_blocks (
        id              TEXT PRIMARY KEY,
        chapter_id      TEXT NOT NULL,
        novel_id        TEXT NOT NULL,
        position        INTEGER NOT NULL,
        block_type      TEXT NOT NULL DEFAULT 'paragraph',  -- paragraph / dialogue / scene_break
        content         TEXT NOT NULL,
        content_hash    TEXT,                                -- fnv 哈希（脏检查）
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(chapter_id, position)
    )`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_chapter ON _ainovel_chapter_blocks(chapter_id, position)`);
    store.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_novel ON _ainovel_chapter_blocks(novel_id)`);
    // 给 _ainovel_chapters 加 blocks_hash 列（章节级脏检查标记）
    _ensureColumn(store, '_ainovel_chapters', 'blocks_hash', 'TEXT');
    for (const column of ['handoff_json', 'state_snapshot', 'draft_content', 'draft_meta']) {
        _ensureColumn(store, '_ainovel_chapters', column, 'TEXT');
    }
    _ensureColumn(store, '_ainovel_chapters', 'continuity_dirty', 'INTEGER NOT NULL DEFAULT 0');
    // Sprint 9.2: novels + outlines 加 language 列
    _ensureColumn(store, '_ainovel_novels', 'language', "TEXT NOT NULL DEFAULT 'zh'");
    _ensureColumn(store, '_ainovel_outlines', 'prompts_lang', "TEXT NOT NULL DEFAULT 'zh'");
}

function _ensureColumn(store, table, col, decl) {
    try {
        const rows = store.query(`PRAGMA table_info(${table})`);
        if (rows.some(r => r.name === col)) return;
        store.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        console.log(`[novel-engine] schema migrate: ${table}.${col} added`);
    } catch (e) {
        console.warn(`[novel-engine] schema migrate ${table}.${col} failed:`, e.message);
    }
}

// ====== Skill Registry ======
const _skills = new Map();

// ====== Agent Workspace（OpenClaw 风格配置） ======
// 每个 agent 有独立工作区目录，含 SOUL/IDENTITY/AGENTS/MEMORY 4 个 MD
// 启动时一次性读 SOUL/IDENTITY/AGENTS 入缓存（很少变）
// 每次 agent 调用前读最新 MEMORY（用户可能手编）
const _agentConfigCache = new Map();        // skillName → {soul, identity, agents, mtime}
let _agentsRoot = null;                       // 启动时设置
let _storeRootForMemory = null;               // per-novel memory 落盘的根目录
const _MAX_INJECTED_MEMORY_CHARS = 3000;     // 单段注入 MEMORY 上限
const _MAX_INJECTED_FEEDBACK_ITEMS = 5;      // 注入用户反馈条数上限
const _MAX_INJECTED_BLACKBOARD_CHARS = 1500; // 黑板摘要注入上限
const _MAX_INJECTED_INBOX_MESSAGES = 8;      // 未读消息注入条数上限
const _MAX_BLACKBOARD_VALUE_CHARS = 8000;    // 单条黑板 value 长度上限

function _readMdIfExists(absPath) {
    try {
        if (!fs.existsSync(absPath)) return '';
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) return '';
        return fs.readFileSync(absPath, 'utf8');
    } catch (e) {
        console.warn('[novel-engine] read MD failed:', absPath, e.message);
        return '';
    }
}

function _loadAgentConfig(skillName) {
    if (!skillName) return { soul: '', identity: '', agents: '' };
    if (_agentConfigCache.has(skillName)) return _agentConfigCache.get(skillName);
    if (!_agentsRoot) return { soul: '', identity: '', agents: '' };
    const dir = path.join(_agentsRoot, skillName);
    const cfg = {
        soul: _readMdIfExists(path.join(dir, 'SOUL.md')),
        identity: _readMdIfExists(path.join(dir, 'IDENTITY.md')),
        agents: _readMdIfExists(path.join(dir, 'AGENTS.md')),
    };
    _agentConfigCache.set(skillName, cfg);
    if (cfg.soul || cfg.identity || cfg.agents) {
        console.log(`[novel-engine] agent config loaded: ${skillName}`);
    }
    return cfg;
}

// ====== Memory 日志写入（OpenClaw 模式 Phase 4-Sprint C） ======
// 每次 agent 调用后自动 append 一条到 memory/YYYY-MM-DD.md
// 全局路径：agents/<skill>/memory/YYYY-MM-DD.md
// per-novel 路径：<store>/_ainovel_novel_<id>_agent_memory/<skill>/memory/YYYY-MM-DD.md
function _appendMemoryLog(skillName, novelId, entry) {
    if (!skillName || !entry) return false;
    const date = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const block = formatMemoryEntry_(entry, date);
    if (!block) return false;
    let wroteAny = false;
    // 全局
    if (_agentsRoot) {
        const dir = path.join(_agentsRoot, skillName, 'memory');
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, `${date}.md`), block, 'utf8');
            wroteAny = true;
        } catch (e) {
            console.warn(`[novel-engine] global memory log write failed: ${skillName}`, e.message);
        }
    }
    // per-novel
    if (_storeRootForMemory && novelId) {
        const dir = path.join(_storeRootForMemory, `_ainovel_novel_${novelId}_agent_memory`, skillName, 'memory');
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(path.join(dir, `${date}.md`), block, 'utf8');
            wroteAny = true;
        } catch (e) {
            console.warn(`[novel-engine] per-novel memory log write failed: ${skillName}/${novelId}`, e.message);
        }
    }
    return wroteAny;
}

function formatMemoryEntry_(entry, date) {
    if (!entry || typeof entry !== 'object') return '';
    const t = entry.timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const lines = [`## ${t} — ${entry.skill || 'unknown'}`];
    if (entry.novel) lines.push(`- novel: ${entry.novel}`);
    if (entry.input) lines.push(`- input: ${String(entry.input).slice(0, 200)}`);
    if (entry.output) lines.push(`- output: ${String(entry.output).slice(0, 200)}`);
    if (entry.tokens) lines.push(`- tokens: ${entry.tokens.prompt || 0}/${entry.tokens.completion || 0}`);
    if (entry.durationMs != null) lines.push(`- duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
    if (entry.review) lines.push(`- review: ${entry.review}`);
    if (entry.status) lines.push(`- status: ${entry.status}`);
    if (entry.issue) lines.push(`- issue: ${entry.issue}`);
    if (entry.action) lines.push(`- action: ${entry.action}`);
    lines.push('');
    return lines.join('\n');
}

// 记录被动反馈（reviewer 退回时自动写一条）
function _recordMemoryFeedback(skillName, novelId, feedbackEntry) {
    if (!skillName || !novelId) return false;
    const dir = _storeRootForMemory
        ? path.join(_storeRootForMemory, `_ainovel_novel_${novelId}_agent_memory`, skillName, 'memory')
        : null;
    if (!dir) return false;
    const date = new Date().toISOString().slice(0, 10);
    const block = formatMemoryEntry_(feedbackEntry, date);
    if (!block) return false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${date}.md`), block, 'utf8');
        console.log(`[novel-engine] passive feedback recorded: ${skillName}/${novelId}`);
        return true;
    } catch (e) {
        console.warn(`[novel-engine] passive feedback write failed:`, e.message);
        return false;
    }
}

// 每次调用前都读最新 MEMORY（不缓存，反映手编）
function _loadAgentMemory(skillName, novelId) {
    const result = { global: '', perNovel: '' };
    if (_agentsRoot) {
        const globalPath = path.join(_agentsRoot, skillName, 'MEMORY.md');
        result.global = _readMdIfExists(globalPath).slice(-_MAX_INJECTED_MEMORY_CHARS);
    }
    if (_storeRootForMemory && novelId) {
        const perNovelPath = path.join(_storeRootForMemory, `_ainovel_novel_${novelId}_agent_memory`, skillName, 'MEMORY.md');
        result.perNovel = _readMdIfExists(perNovelPath).slice(-_MAX_INJECTED_MEMORY_CHARS);
    }
    return result;
}

// 查最近 N 条用户反馈
function _loadRecentFeedback(novelId, skillName, limit) {
    if (!_store || !novelId) return [];
    try {
        return _store.query(
            `SELECT vote, comment, created_at FROM _ainovel_agent_feedback
              WHERE novel_id = ? AND skill = ?
              ORDER BY created_at DESC LIMIT ?`,
            novelId, skillName, limit
        );
    } catch (e) {
        return [];
    }
}

// 拼最终 system prompt：SOUL + IDENTITY + AGENTS + 全局MEMORY + per-novel MEMORY + 反馈 + USER + 原始 systemPrompt
// Sprint C-S1 改造：
//   1. 每段标记 section key（用于 context-compressor 估算预算）
//   2. 注入 shared_context（按 skill 的 context_needs 精准拉取）
//   3. 注入 PROTOCOLS.md（_shared/PROTOCOLS.md，全 agent 共享的协作协议）
//   4. 跑 context-compressor 做预算控制，超 16K 自动 L1→L5 压缩
function _composeSystemPrompt(skill, novelId) {
    const cfg = _loadAgentConfig(skill.name);
    const mem = _loadAgentMemory(skill.name, novelId);
    const feedback = _loadRecentFeedback(novelId, skill.name, _MAX_INJECTED_FEEDBACK_ITEMS);
    const userMd = _agentsRoot ? _readMdIfExists(path.join(_agentsRoot, '_shared', 'USER.md')) : '';

    // sections 数组：每段带 key（用于 compressor 按段估算）
    const sections = [];

    if (cfg.soul) sections.push({
        key: 'SOUL',
        content: `===[SOUL 人格/价值观/边界]===\n${cfg.soul}`
    });
    if (cfg.identity) sections.push({
        key: 'IDENTITY',
        content: `===[IDENTITY 身份/能力清单]===\n${cfg.identity}`
    });
    if (cfg.agents) sections.push({
        key: 'AGENTS',
        content: `===[AGENTS SOP 工作流程]===\n${cfg.agents}`
    });
    if (mem.global) sections.push({
        key: 'MEMORY_GLOBAL',
        content: `===[全局经验沉淀（agents/${skill.name}/MEMORY.md 最近 ${_MAX_INJECTED_MEMORY_CHARS} 字）]===\n${mem.global}`
    });
    if (mem.perNovel) sections.push({
        key: 'MEMORY_PER_NOVEL',
        content: `===[本小说经验沉淀（本 novel MEMORY.md 最近 ${_MAX_INJECTED_MEMORY_CHARS} 字）]===\n${mem.perNovel}`
    });
    if (feedback.length) {
        const fbLines = feedback.map(f => {
            const t = new Date((f.created_at || 0) * 1000).toISOString().slice(0, 10);
            const v = f.vote === 'up' ? '👍' : '👎';
            const c = f.comment ? `：${f.comment}` : '';
            return `${t} ${v}${c}`;
        }).join('\n');
        sections.push({
            key: 'FEEDBACK',
            content: `===[用户反馈（最近 ${feedback.length} 条，按时间倒序）]===\n${fbLines}`
        });
    }
    // Sprint H2: 注入项目黑板摘要（仅在有 novelId 时）
    if (novelId) {
        const bbSummary = blackboardSummary(novelId);
        if (bbSummary) sections.push({
            key: 'BLACKBOARD',
            content: `===[项目黑板（最近 ${_MAX_INJECTED_BLACKBOARD_CHARS} 字摘要）]===\n${bbSummary}`
        });
    }
    // Sprint H3: 注入未读同事消息（仅在有 novelId 时）
    if (novelId) {
        const inbox = inboxRead(novelId, skill.name, { markAsRead: false, limit: _MAX_INJECTED_INBOX_MESSAGES });
        if (inbox.ok && inbox.messages && inbox.messages.length) {
            const msgLines = inbox.messages.map(m => {
                const ts = new Date((m.ts || 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
                return `[${ts}] ${m.from || '?'} → 你: ${m.text}`;
            }).join('\n');
            sections.push({
                key: 'INBOX',
                content: `===[未读同事消息（最近 ${inbox.messages.length} 条，已注入但未标记已读）]===\n${msgLines}`
            });
        }
    }
    // ★ Sprint C-S1-C: 注入共享上下文（按 skill 的 context_needs 精准拉取）
    if (novelId && _sharedContext && _capabilityRegistry && _capabilityRegistry[skill.name]) {
        const needs = _capabilityRegistry[skill.name].context_needs || [];
        if (needs.length > 0) {
            const ctxData = _sharedContext.getForNeeds(novelId, needs);
            const ctxKeys = Object.keys(ctxData);
            if (ctxKeys.length > 0) {
                const ctxBlock = ctxKeys.map(k => {
                    const v = ctxData[k];
                    let serialized;
                    try { serialized = JSON.stringify(v); } catch (e) { serialized = String(v); }
                    return `[${k}]\n${serialized.slice(0, 800)}`;
                }).join('\n\n');
                sections.push({
                    key: 'SHARED_CTX',
                    content: `===[共享上下文（按 ${skill.name} 的 context_needs 拉取，共 ${ctxKeys.length} 项）]===\n${ctxBlock}`
                });
            }
        }
    }
    if (userMd) sections.push({
        key: 'USER_SHARED',
        content: `===[共享用户偏好（agents/_shared/USER.md）]===\n${userMd}`
    });
    // ★ Sprint C-S1: 注入协作协议（所有 agent 必读，限制 500 字符）
    if (_protocolsMd) {
        const protoShort = _protocolsMd.length > 500 ? _protocolsMd.slice(0, 500) + '\n\n[...协议已截断...]' : _protocolsMd;
        sections.push({
            key: 'PROTOCOLS',
            content: `===[协作协议（agents/_shared/PROTOCOLS.md）]===\n${protoShort}`
        });
    }
    // ★ Sprint 6.2: 注入已启用 skill（按 category 决定）
    // 规则：
    //  - global-assistant / novel-director → 注入所有 enabled skill
    //  - 其他 skill → 注入同 category 的 enabled skill + polish 类 enabled skill
    if (_store) {
        const myCategory = skill.category || 'general';
        const isGlobal = (skill.name === 'global-assistant' || skill.name === 'novel-director');
        let injected = [];
        if (isGlobal) {
            injected = _getEnabledSkills(null); // 全部
        } else {
            // 同 category 的 enabled skill
            injected = _getEnabledSkills(myCategory);
            // 加上 polish 类（对所有写作路径生效）
            const polish = _getEnabledSkills('polish');
            for (const p of polish) {
                if (!injected.find(x => x.name === p.name)) injected.push(p);
            }
        }
        // 过滤掉 self（自己的 systemPrompt 已经走 RAW_DIRECTIVE 段）
        injected = injected.filter(s => s.name !== skill.name && s.systemPrompt);
        if (injected.length) {
            const lines = injected.map(s => `--- [已启用 skill: ${s.name}${s.displayName ? ' / ' + s.displayName : ''}（category=${s.category}）] ---\n${s.systemPrompt}`);
            sections.push({
                key: 'ENABLED_SKILLS',
                content: `===[已启用的额外 skill（共 ${injected.length} 个）]===\n${lines.join('\n\n')}`
            });
        }
    }

    if (skill.systemPrompt) sections.push({
        key: 'RAW_DIRECTIVE',
        content: `===[原始指令]===\n${skill.systemPrompt}`
    });

    // ★ Sprint C-S1: 预算控制（异步，但实际估算很快所以同步也行）
    // 为保持同步签名：先做同步的 L1/L2/L3/L4，异步 L5 暂跳过（如需 L5 调 LLM，调用方需用 await _composeSystemPromptAsync）
    let finalSections = sections;
    let compressedBytes = 0;
    if (_contextCompressor) {
        const est = _contextCompressor.estimate(sections);
        const budget = _contextCompressor.getBudget(novelId || '_default_');
        if (est.total_bytes > budget.total_system_prompt_bytes) {
            // 同步压缩（L1+L2+L3+L4，不调 LLM）
            const result = _contextCompressor._runSyncCompress(novelId, sections, budget);
            finalSections = result.sections;
            compressedBytes = result.summary.saved_bytes;
            // 落审计 + emit 事件
            if (novelId && result.summary.actions.length > 0) {
                try {
                    _store.exec(
                        `INSERT INTO _ainovel_compression_log
                         (id, novel_id, skill, strategy, saved_bytes, actions, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        'cmp_' + Math.random().toString(36).slice(2, 10),
                        novelId, skill.name, 'auto', compressedBytes,
                        JSON.stringify(result.summary.actions),
                        Math.floor(Date.now() / 1000)
                    );
                    if (_costTracker) _costTracker.trackCompression(novelId);
                } catch (e) { /* best effort */ }
            }
            if (_emit && result.summary.actions.length > 0) {
                _emit('context_compressed', {
                    novelId,
                    skill: skill.name,
                    savedBytes: compressedBytes,
                    actions: result.summary.actions,
                });
            }
        }
    }

    const finalSystem = finalSections.map(s => s.content).join('\n\n');
    const memBytes = (mem.global.length + mem.perNovel.length) * 2;
    return { system: finalSystem, injectedMemoryBytes: memBytes, compressedBytes };
}

function registerSkill(def) {
    if (!def || !def.name) throw new Error('skill.name 必填');
    if (_skills.has(def.name)) console.warn(`[novel-engine] skill ${def.name} 已存在，将被覆盖`);
    // Sprint H1：Skill-as-Tool 声明字段（被编剧 novel-director 当工具调用）
    //   whenToUse  — 一句话说明擅长什么；注入到 director 的工具描述
    //   inputSchema / outputSchema — JSON Schema 形状；用于 LLM 生成合规 tool call
    //   tools      — 该 skill 自己可调用的子工具（保留位；当前未启用）
    // Sprint 6.2：category（用于 polish 类自动注入）
    _skills.set(def.name, Object.assign({
        whenToUse: def.description || '',
        inputSchema: null,
        outputSchema: null,
        tools: [],
        category: 'general',
    }, def));
}

// 把 skill 渲染成「工具描述」，给 novel-director 的 system prompt 用。
// 形式类似 OpenAI tool schema，但只是 markdown 段落，LLM 按文本约定返回 tool_call JSON。
function _renderSkillAsToolSpec(skill) {
    if (!skill || !skill.name) return '';
    // schema 允许两种写法：字符串（手写的示例 JSON）或对象（结构化 schema）
    const renderSchema = (s) => {
        if (typeof s === 'string') return '```json\n' + s + '\n```';
        try { return '```json\n' + JSON.stringify(s, null, 2) + '\n```'; }
        catch (e) { return '  (schema 序列化失败)'; }
    };
    const lines = [];
    lines.push(`### ${skill.name}${skill.displayName ? '（' + skill.displayName + '）' : ''}`);
    if (skill.whenToUse) lines.push(`- 何时使用：${skill.whenToUse}`);
    if (skill.inputSchema) {
        lines.push('- 输入：');
        lines.push(renderSchema(skill.inputSchema));
    }
    if (skill.outputSchema) {
        lines.push('- 输出：');
        lines.push(renderSchema(skill.outputSchema));
    }
    if (Array.isArray(skill.tools) && skill.tools.length) {
        lines.push('- 可用子工具：' + skill.tools.join(', '));
    }
    return lines.join('\n');
}

function listSkills() {
    return Array.from(_skills.values()).map(s => ({
        name: s.name,
        displayName: s.displayName || '',
        description: s.description,
        category: s.category || 'general',
        enabled: _isSkillEnabled(s.name),
    }));
}

// ====== Sprint 6.2: Skill 开关系统 ======
// skill toggle 存于 _ainovel_settings KV（key=skill_config.<skill_name>，value="1" 表示启用）
// 默认全部 disabled（功能性 AI 不自动注入任何 skill）
function _isSkillEnabled(skillName) {
    if (!_store) return false;
    try {
        const rows = _store.query(
            `SELECT value FROM _ainovel_settings WHERE key = ?`,
            'skill_config.' + skillName
        );
        return rows.length > 0 && rows[0].value === '1';
    } catch (e) {
        return false;
    }
}

function _setSkillEnabled(skillName, enabled) {
    if (!_store) return { ok: false, error: '_store 未初始化' };
    if (!skillName) return { ok: false, error: 'skillName 必填' };
    const key = 'skill_config.' + skillName;
    const now = _now();
    if (enabled) {
        // INSERT OR REPLACE
        _store.exec(
            `INSERT INTO _ainovel_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            key, '1', now
        );
    } else {
        _store.exec(`DELETE FROM _ainovel_settings WHERE key = ?`, key);
    }
    return { ok: true, skill: skillName, enabled: !!enabled };
}

// 获取所有 enabled skill（按 category 过滤）
function _getEnabledSkills(filterCategory) {
    const out = [];
    for (const s of _skills.values()) {
        if (!_isSkillEnabled(s.name)) continue;
        if (filterCategory && s.category !== filterCategory) continue;
        out.push(s);
    }
    return out;
}

// 渲染 enabled skill 的内容（用于 system prompt 注入）
function _renderEnabledSkillContent(filterCategory) {
    const enabled = _getEnabledSkills(filterCategory);
    if (!enabled.length) return '';
    return enabled
        .filter(s => s.systemPrompt)
        .map(s => `--- [Skill: ${s.name}${s.displayName ? ' / ' + s.displayName : ''}] ---\n${s.systemPrompt}`)
        .join('\n\n');
}

// ====== Sprint H2: Blackboard（项目级共享黑板） ======
// 每条记录 (novel_id, key) → value（字符串/JSON 序列化）。owner = 写入 agent。
// 内存缓存仅加速读，写后立刻落 SQLite，保证重启后不丢。
const _blackboardCache = new Map(); // novelId → Map(key → {value, owner, version, updated_at})

function _newBlackboardId() {
    return 'bb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function _bbKey(novelId, key) { return novelId + '||' + key; }

function _blackboardGetCache(novelId) {
    if (_blackboardCache.has(novelId)) return _blackboardCache.get(novelId);
    const map = new Map();
    try {
        const rows = _store.query(
            'SELECT key, value, owner, version, updated_at FROM _ainovel_blackboard WHERE novel_id = ?',
            novelId
        );
        for (const r of rows) map.set(r.key, r);
    } catch (e) {
        console.warn('[novel-engine] blackboard load failed:', e.message);
    }
    _blackboardCache.set(novelId, map);
    return map;
}

function blackboardWrite(novelId, key, value, owner) {
    if (!novelId || !key) return { ok: false, error: 'novelId/key 必填' };
    const v = String(value == null ? '' : value);
    if (v.length > _MAX_BLACKBOARD_VALUE_CHARS) {
        return { ok: false, error: `value 超过 ${_MAX_BLACKBOARD_VALUE_CHARS} 字符上限` };
    }
    try {
        const now = Math.floor(Date.now() / 1000);
        const map = _blackboardGetCache(novelId);
        const existing = map.get(key);
        const version = existing ? (existing.version + 1) : 1;
        const id = existing && existing.id ? existing.id : _newBlackboardId();
        _store.exec(
            `INSERT INTO _ainovel_blackboard(id, novel_id, key, value, owner, version, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(novel_id, key) DO UPDATE SET
                value = excluded.value, owner = excluded.owner,
                version = excluded.version, updated_at = excluded.updated_at`,
            id, novelId, key, v, owner || null, version, now
        );
        map.set(key, { id, key, value: v, owner: owner || null, version, updated_at: now });
        return { ok: true, version };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function blackboardRead(novelId, key) {
    if (!novelId || !key) return { ok: false, error: 'novelId/key 必填' };
    const map = _blackboardGetCache(novelId);
    const row = map.get(key);
    return row ? { ok: true, key, value: row.value, owner: row.owner, version: row.version, updated_at: row.updated_at } : { ok: false, error: 'key 不存在' };
}

function blackboardList(novelId) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const map = _blackboardGetCache(novelId);
    const items = Array.from(map.values()).map(r => ({
        key: r.key, value: r.value, owner: r.owner, version: r.version, updated_at: r.updated_at,
    })).sort((a, b) => b.updated_at - a.updated_at);
    return { ok: true, items };
}

function blackboardSummary(novelId, maxChars) {
    const cap = maxChars || _MAX_INJECTED_BLACKBOARD_CHARS;
    const list = blackboardList(novelId);
    if (!list.ok || !list.items.length) return '';
    const lines = [];
    let used = 0;
    for (const it of list.items) {
        const snippet = (it.value || '').length > 200 ? (it.value.slice(0, 200) + '…') : (it.value || '');
        const line = `[${it.key}] (v${it.version}, ${it.owner || '-'}): ${snippet}`;
        if (used + line.length > cap) {
            lines.push(`…（还有 ${list.items.length - lines.length} 条被截断）`);
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join('\n');
}

function blackboardClear(novelId, key) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    try {
        if (key) {
            _store.exec('DELETE FROM _ainovel_blackboard WHERE novel_id = ? AND key = ?', novelId, key);
        } else {
            _store.exec('DELETE FROM _ainovel_blackboard WHERE novel_id = ?', novelId);
        }
        _blackboardCache.delete(novelId);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 在小说被删除时清缓存（main.js 调用）
function _dropBlackboardCache(novelId) {
    _blackboardCache.delete(novelId);
    _inboxCache.delete(novelId);
}

// ====== Sprint H3: Inbox（per-novel 文件收件箱） ======
// 每本小说一个目录：<storeRoot>/_ainovel_inbox_<novelId>/<agentName>.json
// 文件内容：{messages: [{id, from, to, text, kind, ref, ts, read}]}
// 与黑板互补：黑板是「共享状态」，inbox 是「点对点消息」。每条消息投递 = append 数组。
const _inboxCache = new Map(); // novelId → Map(agentName → array)

function _inboxDir(novelId) {
    if (!_storeRootForMemory) return null;
    return path.join(_storeRootForMemory, `_ainovel_inbox_${novelId}`);
}

function _inboxPath(novelId, agentName) {
    const dir = _inboxDir(novelId);
    if (!dir) return null;
    return path.join(dir, agentName + '.json');
}

// 文件名净化：只留字母数字 _ -，并折叠掉所有点（杜绝 ../ 与隐藏文件）
function _safeAgentName(name) {
    const s = String(name || 'unknown')
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .replace(/^_+/, '')
        .slice(0, 64);
    return s || 'unknown';
}

function _loadInboxFile(novelId, agentName) {
    const cache = _inboxCache.get(novelId) || new Map();
    if (cache.has(agentName)) return cache.get(agentName);
    const safe = _safeAgentName(agentName);
    const p = _inboxPath(novelId, safe);
    let msgs = [];
    if (p && fs.existsSync(p)) {
        try {
            const raw = fs.readFileSync(p, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.messages)) msgs = parsed.messages;
        } catch (e) {
            console.warn('[novel-engine] inbox read failed:', agentName, e.message);
        }
    }
    cache.set(safe, msgs);
    _inboxCache.set(novelId, cache);
    return msgs;
}

function _persistInbox(novelId, agentName, msgs) {
    const safe = _safeAgentName(agentName);
    const p = _inboxPath(novelId, safe);
    if (!p) return false;
    const dir = _inboxDir(novelId);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ messages: msgs }, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.warn('[novel-engine] inbox write failed:', agentName, e.message);
        return false;
    }
}

function _newInboxId() {
    return 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function inboxSend(novelId, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!opts || !opts.to) return { ok: false, error: 'opts.to 必填' };
    const from = opts.from || 'system';
    const to = _safeAgentName(opts.to);
    const text = String(opts.text || '');
    if (!text) return { ok: false, error: 'text 必填' };
    if (text.length > 4000) return { ok: false, error: 'text 超过 4000 字符' };
    const msgs = _loadInboxFile(novelId, to);
    const entry = {
        id: _newInboxId(),
        from: String(from).slice(0, 64),
        to,
        text,
        kind: opts.kind || 'note',
        ref: opts.ref || null,
        ts: Math.floor(Date.now() / 1000),
        read: false,
    };
    msgs.push(entry);
    if (_persistInbox(novelId, to, msgs)) return { ok: true, id: entry.id };
    return { ok: false, error: '写入失败' };
}

// opts.markAsRead 默认 true（省略 opts 时也标记已读）；注入 system prompt 时显式传 false 以免消费未读
function inboxRead(novelId, agentName, opts) {
    if (!novelId || !agentName) return { ok: false, error: 'novelId/agentName 必填' };
    const safe = _safeAgentName(agentName);
    const msgs = _loadInboxFile(novelId, safe);
    const markAsRead = !opts || opts.markAsRead !== false;
    const limit = (opts && opts.limit) ? Math.max(1, opts.limit | 0) : 0;
    let unread = msgs.filter(m => !m.read);
    if (limit) unread = unread.slice(0, limit);
    if (markAsRead) {
        for (const m of unread) m.read = true;
        _persistInbox(novelId, safe, msgs);
    }
    return { ok: true, messages: unread };
}

function inboxList(novelId, agentName) {
    if (!novelId || !agentName) return { ok: false, error: 'novelId/agentName 必填' };
    const safe = _safeAgentName(agentName);
    const msgs = _loadInboxFile(novelId, safe);
    return { ok: true, messages: msgs.slice() };
}

// ids = null / 省略 → 标记该 agent 的全部未读为已读
function inboxMarkRead(novelId, agentName, ids) {
    if (!novelId || !agentName) return { ok: false, error: 'novelId/agentName 必填' };
    const safe = _safeAgentName(agentName);
    const msgs = _loadInboxFile(novelId, safe);
    let n = 0;
    if (ids == null) {
        for (const m of msgs) if (!m.read) { m.read = true; n++; }
    } else {
        const set = new Set(ids);
        for (const m of msgs) if (set.has(m.id) && !m.read) { m.read = true; n++; }
    }
    if (n) _persistInbox(novelId, safe, msgs);
    return { ok: true, marked: n };
}

// ====== Sprint H4: Task List（编剧用任务图） ======
// 状态机：pending → in_progress → completed / failed
// blocks / blocked_by 是任务 ID 数组（JSON 字符串）
const _VALID_TASK_STATUS = ['pending', 'in_progress', 'completed', 'failed', 'blocked'];

function _newTaskId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function _normalizeTaskRow(r) {
    if (!r) return null;
    let blocks = [], blockedBy = [];
    try { blocks = JSON.parse(r.blocks || '[]'); } catch (e) { blocks = []; }
    try { blockedBy = JSON.parse(r.blocked_by || '[]'); } catch (e) { blockedBy = []; }
    return Object.assign({}, r, { blocks, blocked_by: blockedBy, blockedBy });
}

function taskCreate(novelId, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!opts || !opts.subject) return { ok: false, error: 'opts.subject 必填' };
    const id = _newTaskId();
    const blocks = JSON.stringify(Array.isArray(opts.blocks) ? opts.blocks : []);
    const blockedBy = JSON.stringify(Array.isArray(opts.blockedBy) ? opts.blockedBy : []);
    const payload = opts.payload != null ? JSON.stringify(opts.payload) : null;
    try {
        _store.exec(
            `INSERT INTO _ainovel_tasks(id, novel_id, subject, description, owner, status, blocks, blocked_by, payload)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
            id, novelId, String(opts.subject).slice(0, 200),
            opts.description ? String(opts.description).slice(0, 2000) : null,
            opts.owner || null, blocks, blockedBy, payload
        );
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function taskList(novelId, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const filter = opts || {};
    let sql = 'SELECT * FROM _ainovel_tasks WHERE novel_id = ?';
    const args = [novelId];
    if (filter.status) { sql += ' AND status = ?'; args.push(filter.status); }
    if (filter.owner) { sql += ' AND owner = ?'; args.push(filter.owner); }
    sql += ' ORDER BY created_at ASC LIMIT 500';
    let rows = [];
    try { rows = _store.query(sql, ...args); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, tasks: rows.map(_normalizeTaskRow) };
}

function taskGet(taskId) {
    if (!taskId) return { ok: false, error: 'taskId 必填' };
    let row = null;
    try { row = _store.query('SELECT * FROM _ainovel_tasks WHERE id = ?', taskId)[0] || null; } catch (e) { return { ok: false, error: e.message }; }
    if (!row) return { ok: false, error: 'task 不存在' };
    return { ok: true, task: _normalizeTaskRow(row) };
}

// 原子 claim：pending → in_progress；返回最新任务对象。
// 如果在 blocked_by 列表里有任何任务不是 completed/failed，则拒绝 claim。
function taskClaim(taskId, agentName) {
    if (!taskId) return { ok: false, error: 'taskId 必填' };
    const cur = taskGet(taskId);
    if (!cur.ok) return cur;
    const t = cur.task;
    if (t.status !== 'pending') return { ok: false, error: `当前 status=${t.status}，无法 claim` };
    if (Array.isArray(t.blockedBy) && t.blockedBy.length) {
        for (const dep of t.blockedBy) {
            const depRes = taskGet(dep);
            if (!depRes.ok) return { ok: false, error: `依赖任务 ${dep} 不存在` };
            if (depRes.task.status !== 'completed' && depRes.task.status !== 'failed') {
                return { ok: false, error: `依赖任务 ${dep} 未完成（${depRes.task.status}）` };
            }
        }
    }
    try {
        const now = Math.floor(Date.now() / 1000);
        _store.exec(
            `UPDATE _ainovel_tasks SET status = 'in_progress', owner = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
            agentName || t.owner || null, now, taskId
        );
        return taskGet(taskId);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function taskComplete(taskId, result) {
    if (!taskId) return { ok: false, error: 'taskId 必填' };
    try {
        const now = Math.floor(Date.now() / 1000);
        const payload = result != null ? JSON.stringify(result) : null;
        _store.exec(
            `UPDATE _ainovel_tasks SET status = 'completed', result = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
            payload, now, taskId
        );
        return taskGet(taskId);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function taskFail(taskId, errorMsg) {
    if (!taskId) return { ok: false, error: 'taskId 必填' };
    try {
        const now = Math.floor(Date.now() / 1000);
        _store.exec(
            `UPDATE _ainovel_tasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
            JSON.stringify({ error: String(errorMsg || '') }), now, taskId
        );
        return taskGet(taskId);
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 「我可执行的任务」：owner 匹配 + 所有依赖完成 + status=pending
function taskReady(novelId, agentName) {
    const list = taskList(novelId, { owner: agentName, status: 'pending' });
    if (!list.ok) return list;
    const ready = [];
    for (const t of list.tasks) {
        let ok = true;
        for (const dep of (t.blockedBy || [])) {
            const depRes = taskGet(dep);
            if (!depRes.ok || (depRes.task.status !== 'completed' && depRes.task.status !== 'failed')) { ok = false; break; }
        }
        if (ok) ready.push(t);
    }
    return { ok: true, tasks: ready };
}

// ====== Context Isolation ======
const _contexts = new Map(); // novelId → context
let _activeNovelId = null;
let _store = null;
let _notify = null;

// ====== Sprint C-S1: Capability Registry 加载器 ======
/**
 * 加载 agents/registry.json 到 _capabilityRegistry
 * 失败不致命——返回 null，后续注入 shared_context 时降级为 noop
 * @returns {object|null} registry 内容（含 _meta 和 agent 列表）
 */
function _loadCapabilityRegistry() {
    if (!_agentsRoot) return null;
    const p = path.join(_agentsRoot, 'registry.json');
    try {
        if (!fs.existsSync(p)) {
            console.warn(`[novel-engine] registry.json not found at ${p}, shared_context 注入降级`);
            return null;
        }
        const raw = fs.readFileSync(p, 'utf8');
        const obj = JSON.parse(raw);
        const meta = obj._meta || {};
        const agents = Object.assign({}, obj);
        delete agents._meta;
        console.log(`[novel-engine] capability registry loaded: ${Object.keys(agents).length} agents (v${meta.version || '?'})`);
        return obj;
    } catch (e) {
        console.warn('[novel-engine] registry.json load failed:', e.message);
        return null;
    }
}

/**
 * 加载 _shared/PROTOCOLS.md 到 _protocolsMd
 * 失败不致命——返回空字符串
 */
function _loadProtocols() {
    if (!_agentsRoot) return '';
    const p = path.join(_agentsRoot, '_shared', 'PROTOCOLS.md');
    return _readMdIfExists(p);
}

function bootstrap({ store, notify }) {
    _store = store;
    _notify = notify || (() => {});
    ensureTables(store);
    // OpenClaw 模式：定位 agents 目录 + store 根（per-novel memory 落盘点）
    _agentsRoot = path.resolve(__dirname, 'agents');
    if (store && store.path) {
        _storeRootForMemory = path.dirname(store.path);
    }
    // Sprint C-S1: 初始化基础设施层
    _capabilityRegistry = _loadCapabilityRegistry();
    _protocolsMd = _loadProtocols();
    _sharedContext = new SharedContext({ store });
    _costTracker = new CostTracker({ store });
    _contextCompressor = new ContextCompressor({
        sharedContext: _sharedContext,
        // summarizeLLM 暂未提供——需要时由调用方注入（L5 策略需要）
        summarizeLLM: null,
    });
    // 订阅 cost-tracker 的 threshold_warn：转 _emit 给前端
    if (_costTracker && _notify) {
        _costTracker.on((ev) => {
            if (ev.type === 'threshold_warn') {
                _emit('budget_threshold_warn', {
                    novelId: ev.novelId,
                    totalCostUsd: ev.totalCost,
                    message: `累计成本已达 $${ev.totalCost.toFixed(2)}，建议关注。`,
                });
            }
        });
    }

    // Sprint C-S2: 初始化 orchestrator
    //   - CapabilityRouter 从 _capabilityRegistry 加载（已 Sprint S1 加载）
    //   - Scheduler 默认 maxParallel=3，可调
    //   - Orchestrator 用 novel._runAgent 作为 executor，注入 novelId 闭包
    if (_capabilityRegistry) {
        _capabilityRouter = new CapabilityRouter({ registry: _capabilityRegistry, store });
    }
    if (_capabilityRouter) {
        const scheduler = new Scheduler({ maxParallel: 3 });
        _orchestrator = new Orchestrator({
            router: _capabilityRouter,
            scheduler,
            executor: _makeOrchestratorExecutor(),
            emit: (type, payload) => {
                // orchestrator 事件透传到 _emit（前端订阅 ainovel:event:update）
                _emit(type, payload || {});
            },
            maxRetries: 1,           // L1 同 agent 重试一次
            taskTimeoutMs: 5 * 60 * 1000,
            // Sprint 5: 5 级失败恢复
            criticInvoke: _makeCriticInvoke(),
            supervisorInvoke: _makeSupervisorInvoke(),
            isCriticalTask: _isCriticalTask,
        });
    }

    _registerNovelDirector();
    _registerSupervisorCriticCost();
    console.log(`[novel-engine] agents root: ${_agentsRoot}`);
    console.log(`[novel-engine] per-novel memory root: ${_storeRootForMemory || '(unresolved)'}`);
    console.log(`[novel-engine] shared_context: ${_sharedContext ? 'ready' : 'disabled'}`);
    console.log(`[novel-engine] cost_tracker: ${_costTracker ? 'ready' : 'disabled'}`);
    console.log(`[novel-engine] context_compressor: ${_contextCompressor ? 'ready' : 'disabled'}`);
    console.log(`[novel-engine] protocols.md: ${_protocolsMd ? 'loaded (' + _protocolsMd.length + ' chars)' : 'not found'}`);
    console.log(`[novel-engine] capability_router: ${_capabilityRouter ? 'ready' : 'disabled'}`);
    console.log(`[novel-engine] orchestrator: ${_orchestrator ? 'ready' : 'disabled'}`);
}

/**
 * 构造 orchestrator 用的 executor：闭包 novelId + 调用 _runAgent。
 *
 * orchestrator 的 executor 签名：
 *   async (task, agentName, { signal, attempt }, input) => result
 *
 * _runAgent 签名：
 *   async (novelId, agentName, input, opts) => { output, content, prompt_tokens, ... }
 *
 * opts 里需要的：phaseIndex / phaseName / role / round / jobId / chapterId / onChunk
 * 这些从 task.meta 读（由 plan-builder 在构造 plan 时填好）。
 */
function _makeOrchestratorExecutor() {
    return async (task, agentName, { signal, attempt }, input) => {
        const meta = task.meta || {};
        const novelId = meta.novelId || task.novelId || null;
        if (!novelId) throw new Error('orchestrator executor: task meta 缺 novelId');
        const opts = {
            phaseIndex: typeof meta.phaseIndex === 'number' ? meta.phaseIndex : 0,
            phaseName: meta.phaseName || task.label || task.id,
            role: meta.role || '',
            round: attempt || 1,
            jobId: meta.jobId || null,
            chapterId: meta.chapterId || null,
            signal,
        };
        // chapter-streamer 是流式的，需要 onChunk（plan-builder 已注入 meta.onChunk）
        if (agentName === 'chapter-streamer' && typeof meta.onChunk === 'function') {
            opts.onChunk = meta.onChunk;
        }
        return await _runAgent(novelId, agentName, input || {}, opts);
    };
}

/**
 * Sprint 5: L3 critic 钩子。
 * 输入 {taskId, taskContext, recentHistory} → 调 critic agent → 返回 {output: {recoverable, suggestedAction, ...}}
 */
function _makeCriticInvoke() {
    return async (input) => {
        // orchestrator 调时知道 task，但不知道 novelId —— 从 _orchestrator._currentPlan 拿
        const novelId = _orchestrator && _orchestrator._currentPlan ? _orchestrator._currentPlan.novelId : null;
        if (!novelId) return { ok: false, error: 'critic: 找不到 novelId' };
        if (!_skills.has('critic')) _registerSupervisorCriticCost();
        try {
            const r = await _runAgent(novelId, 'critic', input, {
                phaseName: 'recovery-L3',
                signal: null,
                round: 1,
            });
            return r;
        } catch (e) {
            return { ok: false, error: e.message };
        }
    };
}

/**
 * Sprint 5: L4 supervisor 钩子。
 * 输入 {planSummary, failedTasks} → 调 task-supervisor → 返回 {output: {verdict, nextActions}}
 */
function _makeSupervisorInvoke() {
    return async (input) => {
        const novelId = _orchestrator && _orchestrator._currentPlan ? _orchestrator._currentPlan.novelId : null;
        if (!novelId) return { ok: false, error: 'supervisor: 找不到 novelId' };
        if (!_skills.has('task-supervisor')) _registerSupervisorCriticCost();
        try {
            const r = await _runAgent(novelId, 'task-supervisor', input, {
                phaseName: 'recovery-L4',
                signal: null,
                round: 1,
            });
            return r;
        } catch (e) {
            return { ok: false, error: e.message };
        }
    };
}

/**
 * Sprint 5: 关键任务判定（L4 skip 决策依据）。
 * 默认：所有 task 都 critical（不轻易 skip）。可通过 _ainovel_settings.non_critical_capabilities 配置豁免。
 */
function _isCriticalTask(task) {
    try {
        const row = _store && _store.query("SELECT value FROM _ainovel_settings WHERE key = 'non_critical_capabilities'")[0];
        if (!row || !row.value) return true;
        let list;
        try { list = JSON.parse(row.value); } catch (e) { return true; }
        if (!Array.isArray(list)) return true;
        // capability 在豁免列表里 → non-critical（可 skip）
        return !list.includes(task.capability);
    } catch (e) {
        return true;
    }
}

/**
 * 通过 orchestrator 跑一个 plan（IPC / 调试用）。
 *
 * @param {object} plan    { name, novelId, tasks }
 * @returns {Promise<{ok, graph, stats, error?}>}
 */
async function runOrchestratorPlan(plan) {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    return _orchestrator.run(plan);
}

/**
 * 取消当前 orchestrator plan（IPC / 调试用）。
 * @param {string} [reason]
 */
function cancelOrchestratorPlan(reason = 'user-cancelled') {
    for (const run of _chapterRuns.values()) run.controller.abort(new Error('用户已停止写作'));
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    _orchestrator.cancel(reason);
    return { ok: true };
}

/**
 * Sprint 5: 暂停当前 plan（L5 触发时调用）
 */
function pauseOrchestratorPlan(reason = 'user-paused') {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    _orchestrator.pause(reason);
    return { ok: true };
}

/**
 * Sprint 5: 恢复 paused plan
 * @param {string} action  'resume' | 'abort' | 'modify'
 */
function resumeOrchestratorPlan(action = 'resume', extra = null) {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    const r = _orchestrator.resume(action, extra);
    return { ok: r };
}

/**
 * Sprint 5: 取当前 cost 快照（前端用）
 */
function getCostSnapshot(novelId) {
    if (!_costTracker) return { ok: false, error: 'cost-tracker 未初始化' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    return { ok: true, snapshot: _costTracker.snapshot(novelId) };
}

/**
 * Sprint 5: 设置 per-novel 软阈值
 */
function setCostThreshold(novelId, usd) {
    if (!_costTracker) return { ok: false, error: 'cost-tracker 未初始化' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const t = _costTracker.setThreshold(novelId, usd);
    return { ok: true, threshold: t };
}

/**
 * Sprint 5: 取所有 orchestrator 事件统计（含 pause 状态、cost 累计）
 */
function getOrchestratorFullStatus() {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    const status = _orchestrator.status();
    status.paused = _orchestrator.isPaused();
    if (_orchestrator._currentPlan && _orchestrator._currentPlan.novelId && _costTracker) {
        status.cost = _costTracker.snapshot(_orchestrator._currentPlan.novelId);
    }
    return status;
}

/**
 * 当前 orchestrator 状态（IPC / 调试用）。
 */
function getOrchestratorStatus() {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化' };
    return _orchestrator.status();
}

// Sprint 4: 当前 plan 完整快照（含每个 task 的 status / depends_on / agentName）—— 前端 DAG 可视化用
function getOrchestratorPlanSnapshot() {
    if (!_orchestrator) return { ok: false, error: 'orchestrator 未初始化', snapshot: null };
    const snap = _orchestrator.getPlanSnapshot();
    return { ok: !!snap, snapshot: snap };
}

/**
 * 当前注册的 capability 列表（IPC / 调试用）。
 */
function listCapabilities() {
    if (!_capabilityRouter) return [];
    const out = [];
    for (const [cap, agents] of _capabilityRouter._index.entries()) {
        out.push({ capability: cap, agents });
    }
    return out;
}

/**
 * 把 orchestrator 的 TaskGraph 结果转换为旧的 `out` 对象：
 *   out['phase-A1-style']['style-analyst'] = { output, raw, ... }
 *
 * @param {TaskGraph} graph
 * @param {Array<[taskId, agentName]>} map   要包含哪些 task；顺序无所谓
 * @returns {object}
 */
function _graphToPipelineOutputs(graph, map) {
    const out = {};
    for (const [taskId, agentName] of map) {
        const node = graph.getNode(taskId);
        if (!node) continue;
        out[taskId] = {
            [agentName]: node.result || {},
        };
    }
    return out;
}

/**
 * 旧的 outline phases 数组（兜底用 — orchestrator 不可用时走这里）。
 * 原始结构，保留以保证无 registry 时仍能工作。
 */
function _legacyOutlinePhases(novelId) {
    return [
        { name: 'phase-A1-style', agents: { name: 'style-analyst', role: '风格分析', input: { novelId } } },
        { name: 'phase-A2-world', agents: { name: 'world-architect', role: '世界设定', input: { novelId } } },
        { name: 'phase-A3-character', agents: { name: 'character-architect', role: '人物设计', input: { novelId } } },
        { name: 'phase-B1-theme', agents: { name: 'theme-architect', role: '主题分析', input: { novelId } } },
        { name: 'phase-B2-plot', agents: { name: 'plot-architect', role: '剧情结构', input: { novelId } } },
        { name: 'phase-C-synthesize', agents: { name: 'outline-synthesizer', role: '大纲综合', input: { novelId } } },
        { name: 'phase-D-review', agents: { name: 'outline-reviewer', role: '大纲评审', input: { novelId } } },
    ];
}

// ====== Sprint H5: novel-director（编剧） ======
// 唯一的"调度者"skill。它能在自己 system prompt 里看到其他 18 个 skill 的工具描述，
// 通过 LLM tool-call 循环来调度其他 agent 完成任务。
// 不依赖 provider 原生 tool calling（Ollama/OpenAI 兼容/Anthropic 都用同一个文本约定）：
//   - 调用：<<<TOOL_CALL>>>{"name":"<tool>","args":{...}}<<<END>>>
//   - 结束：<<<DONE>>>{"summary":"..."}<<<

const DIRECTOR_TOOL_PREFIX = '<<<TOOL_CALL>>>';
const DIRECTOR_TOOL_SUFFIX = '<<<END>>>';
const DIRECTOR_DONE_MARKER = '<<<DONE>>>';
const DIRECTOR_PLAN_PREFIX = '<<<PLAN_READY>>>';
const DIRECTOR_PLAN_SUFFIX = '<<<END>>>';
const DIRECTOR_MAX_TURNS = 8;

// 把所有「可被调度」的 skill 渲染成 markdown 段落，作为 director system prompt 的一部分
function _renderDirectorToolbox() {
    const skip = new Set(['novel-director']);  // 排除自己
    const blocks = [];
    for (const s of _skills.values()) {
        if (skip.has(s.name)) continue;
        blocks.push(_renderSkillAsToolSpec(s));
    }
    // 追加 3 个内置元工具
    blocks.push(`### taskCreate（内置元工具）
- 何时使用：创建一条持久化任务，写到本小说任务图里。worker 通过 taskReady 自动 claim。
- 输入：{"subject": str, "description"?: str, "owner"?: str, "blocks"?: [taskId], "blockedBy"?: [taskId], "payload"?: any}
- 输出：{"ok": true, "id": "t_..."}`);
    blocks.push(`### inboxSend（内置元工具）
- 何时使用：向某个 agent 的收件箱投递一条消息。agent 下次执行时会自动注入未读消息。
- 输入：{"to": str, "from"?: str, "text": str, "kind"?: str, "ref"?: str}
- 输出：{"ok": true, "id": "msg_..."}`);
    blocks.push(`### blackboardWrite（内置元工具）
- 何时使用：把跨 agent 共享的关键状态写到黑板（项目级）。所有 agent 都能在下一次 system prompt 看到摘要。
- 输入：{"key": str, "value": str, "owner"?: str}
- 输出：{"ok": true, "version": int}`);
    return blocks.join('\n\n');
}

function _directorSystemPrompt() {
    return `你是【编剧 novel-director】，负责把用户的写作目标拆成可执行的 agent 任务。

## 1. 你的工作方式
1. 先读项目黑板（已注入到上方）和最近章节（也已注入）。
2. 把目标拆成 1 个或多个子任务，决定串行/并行、用哪个 agent、是否需要在 taskCreate 写依赖。
3. 每次回复**只能输出两种东西之一**：
   - 一个或多个工具调用：
     ${DIRECTOR_TOOL_PREFIX}{"name":"<tool>","args":{...}}${DIRECTOR_TOOL_SUFFIX}
   - 完成标记：${DIRECTOR_DONE_MARKER}{"summary":"<简短总结>"}${DIRECTOR_DONE_MARKER}
4. **不要**在两次工具调用之间夹带自然语言（除非必须解释为什么调这个工具，且应尽量短）。
5. 每个 tool call 的"args"必须符合下方 inputSchema。

## 2. 你可调用的工具（其余 18 个 skill + 3 元工具）

${_renderDirectorToolbox()}

## 3. 行为准则
- 调研/拆解尽量并行（一次回复里发多个 ${DIRECTOR_TOOL_PREFIX}）。
- 长任务先 taskCreate + 设 owner，让 worker 自己 claim；不要替 worker 跑长任务。
- 失败时：先 ${DIRECTOR_TOOL_PREFIX}blackboardWrite 把失败原因记到黑板${DIRECTOR_TOOL_SUFFIX}，再决定 retry / fallback / ${DIRECTOR_DONE_MARKER}。
- 当任务已完成且不需要再做任何事 → 输出 ${DIRECTOR_DONE_MARKER}。

## 4. 上下文来源
- 上方「项目黑板」段：当前小说所有跨 agent 共享状态摘要。
- 上方「未读同事消息」段：其他 agent 投递给你的消息。
- 注入的 chapters/outline 由当前任务相关字段决定。`;
}

// 解析 LLM 文本回复里的 tool calls（按约定标记）
function _parseDirectorResponse(text) {
    if (typeof text !== 'string') return { toolCalls: [], done: null };
    const toolCalls = [];
    const re = new RegExp(escapeRegExp_(DIRECTOR_TOOL_PREFIX) + '([\\s\\S]*?)' + escapeRegExp_(DIRECTOR_TOOL_SUFFIX), 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        try {
            const obj = JSON.parse(m[1].trim());
            if (obj && obj.name) toolCalls.push(obj);
        } catch (e) {
            // 忽略单条解析失败
        }
    }
    let done = null;
    const doneRe = new RegExp(escapeRegExp_(DIRECTOR_DONE_MARKER) + '([\\s\\S]*?)' + escapeRegExp_(DIRECTOR_DONE_MARKER));
    const dm = text.match(doneRe);
    if (dm) {
        try { done = JSON.parse(dm[1].trim()); } catch (e) { done = { summary: dm[1].trim() }; }
    }
    return { toolCalls, done };
}

// Sprint 3: 解析 director v2 模式输出的 PLAN_READY 标记
// 返回 { ok: true, plan: {goal, tasks:[{id, capability, depends_on, ...}]} } 或 { ok: false, error }
function _parseDirectorPlan(text) {
    if (typeof text !== 'string') return { ok: false, error: 'text 不是字符串' };
    const re = new RegExp(escapeRegExp_(DIRECTOR_PLAN_PREFIX) + '\\s*([\\s\\S]*?)\\s*' + escapeRegExp_(DIRECTOR_PLAN_SUFFIX));
    const m = text.match(re);
    if (!m) return { ok: false, error: '未找到 PLAN_READY 标记' };
    const parsed = _tryParseJson(m[1]);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'plan JSON 解析失败' };
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return { ok: false, error: 'plan 缺少 tasks 数组' };

    const tasks = [];
    const seen = new Set();
    for (const t of parsed.tasks) {
        if (!t || typeof t !== 'object') continue;
        if (!t.id || !t.capability) continue;
        const id = String(t.id);
        if (seen.has(id)) continue;
        seen.add(id);
        tasks.push({
            id,
            capability: String(t.capability),
            depends_on: Array.isArray(t.depends_on) ? t.depends_on.map(String) : [],
            input: (t.input && typeof t.input === 'object') ? t.input : {},
            priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
            maxRetries: typeof t.maxRetries === 'number' ? t.maxRetries : 1,
            fallbackStrategy: ['retry', 'reassign', 'skip'].includes(t.fallbackStrategy) ? t.fallbackStrategy : 'retry',
        });
    }
    if (tasks.length === 0) return { ok: false, error: 'plan 中无有效 task（id/capability 缺失）' };

    return { ok: true, plan: { goal: String(parsed.goal || ''), tasks } };
}

function escapeRegExp_(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 执行一条 tool call。返回 {ok, output} 或 {ok:false, error}
async function _directorExecuteTool(novelId, call, skillResults) {
    const name = call.name;
    const args = call.args || {};
    try {
        if (name === 'taskCreate') {
            return taskCreate(novelId, args);
        } else if (name === 'inboxSend') {
            return inboxSend(novelId, args);
        } else if (name === 'blackboardWrite') {
            return blackboardWrite(novelId, args.key, args.value, args.owner || 'novel-director');
        } else if (_skills.has(name)) {
            // 真实 skill：走 _runAgent 拿到 output
            const out = await _runAgent(novelId, name, args, { phaseName: 'director-loop', phaseIndex: -1 });
            skillResults.push({ skill: name, output: out });
            return { ok: true, output: out && (out.output || out.content || out.text || out) };
        } else {
            return { ok: false, error: '未知工具：' + name };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 注册编剧 skill（bootstrap 时调用）
function _registerNovelDirector() {
    if (_skills.has('novel-director')) return;
    registerSkill({
        name: 'novel-director',
        displayName: '编剧',
        workspaceDir: './agents/novel-director/',
        description: '协调其他 agent 完成复杂写作任务。拆解 + 调度 + 综合。',
        whenToUse: '当用户给出高层目标（写章节/生成大纲/重写某段），需要协调多个 agent 协作时。',
        tools: ['taskCreate', 'inboxSend', 'blackboardWrite'],
        temperature: 0.4,
        systemPrompt: _directorSystemPrompt(),
        run: async (input, ctx) => {
            // 不通过 registerSkill 的 run 执行；走 _runDirectorLoop
            const result = await _runDirectorLoop(ctx.novelId, input, ctx);
            return { ok: true, output: result, raw: JSON.stringify(result).slice(0, 4000) };
        },
    });
}

// 注册 Sprint 3 新增的 3 个监督/评审/成本 agent（bootstrap 时调用）
function _registerSupervisorCriticCost() {
    if (!_skills.has('task-supervisor')) {
        registerSkill({
            name: 'task-supervisor',
            displayName: '任务监督员',
            workspaceDir: './agents/task-supervisor/',
            description: '审视当前 plan 进度，对未完成任务给出 continue/replan/skip/abort 决策',
            temperature: 0.3,
            systemPrompt: `你是任务监督员（Task Supervisor）。当前 plan 中部分任务已完成、部分待执行，部分可能失败。请基于现状给出下一步决策。

【决策档位】
- "continue"：当前节奏正常，继续按 plan 走
- "replan"：需要调整 task 列表（追加新 task 或移除现有 task），输出 updatedTasks
- "skip"：某些任务可以跳过（标 taskIds）
- "abort"：整体终止（成本失控 / 循环依赖 / 计划已无意义）

【输出格式】严格 JSON（不要 markdown 包裹）：
{
  "verdict": "continue" | "replan" | "skip" | "abort",
  "reason": "一句话解释",
  "confidence": 0.0-1.0,
  "nextActions": [
    { "type": "skip", "taskIds": ["t2","t5"], "reason": "..." },
    { "type": "replan", "updatedTasks": [{ "id": "t9", "capability": "...", "depends_on": ["t8"] }] }
  ]
}`,
            run: async (input, ctx) => {
                const novelRow = ctx.novel;
                const userPrompt = `【任务监督请求】

小说：${novelRow.title}

【当前 plan 摘要】
${JSON.stringify(input.planSummary || {}, null, 2).slice(0, 3000)}

【已失败任务】
${JSON.stringify(input.failedTasks || [], null, 2).slice(0, 1500)}

【当前成本快照】
${JSON.stringify(input.costSnapshot || {}, null, 2).slice(0, 800)}

请输出 JSON 决策。`;
                const cfg = ctx.provider;
                ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
                const res = await novel.generateStream(_buildStreamOpts(ctx, {
                    provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
                    model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
                    temperature: ctx._skill.temperature, max_tokens: 1500,
                    signal: ctx.signal,
                }), (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); });
                const parsed = _tryParseJson(res.text) || { verdict: 'continue', reason: 'parse_failed', confidence: 0.0 };
                return {
                    output: parsed,
                    raw: res.text,
                    text: res.text,
                    prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
                    cost_usd: res.cost_usd, estimated: res.estimated,
                };
            },
        });
    }

    if (!_skills.has('critic')) {
        registerSkill({
            name: 'critic',
            displayName: '评审员',
            workspaceDir: './agents/critic/',
            description: '对失败任务评估可恢复性，给出 retry/reassign/skip/abort 建议',
            temperature: 0.2,
            systemPrompt: `你是评审员（Critic）。一个 agent 任务失败了，请判断失败性质并给出处理建议。

【错误分类】
- "transient"：网络抖动 / 超时，重试通常可恢复
- "parse_failed"：LLM 输出格式错误（JSON 坏、标记缺失），可换 prompt 策略
- "llm_refused"：LLM 拒绝执行（policy / 内容审核），不可重试同 prompt
- "input_bad"：上游输入有问题（缺失字段 / schema 不符），需修复 input
- "logic_fail"：LLM 跑了但输出不对，需重新设计 prompt 或换 agent
- "fatal"：结构性失败（agent 不存在 / capability 无 fallback），必须放弃

【输出格式】严格 JSON（不要 markdown 包裹）：
{
  "error_type": "transient" | "parse_failed" | "llm_refused" | "input_bad" | "logic_fail" | "fatal",
  "recoverable": true | false,
  "suggestedAction": "retry" | "reassign" | "skip" | "abort",
  "reasoning": "一两句话解释",
  "estimatedCost": 0.05,      // 估算 USD
  "confidence": 0.0-1.0
}`,
            run: async (input, ctx) => {
                const novelRow = ctx.novel;
                const userPrompt = `【任务失败待评审】

小说：${novelRow.title}

【失败任务】
${JSON.stringify(input.taskContext || {}, null, 2).slice(0, 2000)}

【最近重试历史】
${JSON.stringify(input.recentHistory || [], null, 2).slice(0, 1500)}

请输出 JSON 评审结果。`;
                const cfg = ctx.provider;
                ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
                const res = await novel.generateStream(_buildStreamOpts(ctx, {
                    provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
                    model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
                    temperature: ctx._skill.temperature, max_tokens: 1200,
                    signal: ctx.signal,
                }), (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); });
                const parsed = _tryParseJson(res.text) || {
                    error_type: 'fatal', recoverable: false,
                    suggestedAction: 'abort', reasoning: 'parse_failed',
                    estimatedCost: 0, confidence: 0,
                };
                return {
                    output: parsed,
                    raw: res.text,
                    text: res.text,
                    prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
                    cost_usd: res.cost_usd, estimated: res.estimated,
                };
            },
        });
    }

    if (!_skills.has('cost-controller')) {
        registerSkill({
            name: 'cost-controller',
            displayName: '成本控制员',
            workspaceDir: './agents/cost-controller/',
            description: '累计成本超软阈值时输出降级建议；不硬阻断，只 advisory',
            temperature: 0.2,
            systemPrompt: `你是成本控制员（Cost Controller）。当前小说累计成本已接近或超过软阈值，请评估并给出降级建议。

【原则】
- 软提醒 > 硬阻断：只 advisory，最终决策权在用户 / task-supervisor
- 降级建议要具体：不要说"少花点钱"，要说"哪几个 task 可以 skip / 哪个 capability 可换便宜 agent"
- 关键任务优先花钱：核心剧情章 > 旁支描写章

【输出格式】严格 JSON（不要 markdown 包裹）：
{
  "verdict": "ok" | "advisory" | "urgent",
  "advisory": {
    "currentCost": 12.34,
    "softThreshold": 5.0,
    "overBudget": true,
    "suggestions": [
      { "type": "skip_task", "taskIds": ["t2","t5"], "reason": "..." },
      { "type": "downgrade_agent", "from": "expensive-agent", "to": "cheap-agent", "saving": 1.5 },
      { "type": "reduce_max_tokens", "taskIds": ["t3"], "currentMax": 12000, "suggestedMax": 6000 }
    ]
  }
}`,
            run: async (input, ctx) => {
                const novelRow = ctx.novel;
                const userPrompt = `【成本评估请求】

小说：${novelRow.title}

【预算快照】
${JSON.stringify(input.budgetSnapshot || {}, null, 2).slice(0, 1500)}

【剩余 plan 摘要】
${JSON.stringify(input.planSummary || {}, null, 2).slice(0, 2000)}

请输出 JSON 成本建议。`;
                const cfg = ctx.provider;
                ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
                const res = await novel.generateStream(_buildStreamOpts(ctx, {
                    provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
                    model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
                    temperature: ctx._skill.temperature, max_tokens: 1500,
                    signal: ctx.signal,
                }), (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); });
                const parsed = _tryParseJson(res.text) || { verdict: 'ok', advisory: { suggestions: [] } };
                return {
                    output: parsed,
                    raw: res.text,
                    text: res.text,
                    prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
                    cost_usd: res.cost_usd, estimated: res.estimated,
                };
            },
        });
    }
}

// 编剧调度循环
async function _runDirectorLoop(novelId, input, ctx) {
    const goal = (input && input.goal) ? String(input.goal) : '';
    const provider = ctx && ctx.provider ? ctx.provider : _getProviderConfig();
    if (!provider) return { ok: false, error: '未配置 LLM provider' };
    const skillResults = [];
    const toolHistory = [];
    let doneSummary = null;
    let lastText = '';

    // 把目标 + 当前黑板摘要打包成 user prompt
    const bb = blackboardList(novelId);
    const bbBrief = bb.ok ? bb.items.slice(0, 10).map(i => `[${i.key}]: ${(i.value || '').slice(0, 120)}`).join('\n') : '';
    const ctxBrief = ctx && ctx.outline ? `outline: ${(ctx.outline.title || ctx.outline.structure || '').slice(0, 200)}` : '';

    let userPrompt = `【用户目标】\n${goal}\n\n`;
    if (bbBrief) userPrompt += `【当前项目黑板（前 10 条）】\n${bbBrief}\n\n`;
    if (ctxBrief) userPrompt += `【当前大纲】\n${ctxBrief}\n\n`;
    userPrompt += `请按 system prompt 约定调度工具。输出格式：${DIRECTOR_TOOL_PREFIX}{...}${DIRECTOR_TOOL_SUFFIX} 或 ${DIRECTOR_DONE_MARKER}{...}${DIRECTOR_DONE_MARKER}。`;

    for (let turn = 0; turn < DIRECTOR_MAX_TURNS; turn++) {
        _emit('director_turn_started', { novelId, turn, goal });
        let res;
        try {
            res = await novel.generateStream({
                provider: provider.provider,
                base_url: provider.base_url,
                api_key: provider.api_key,
                model: provider.model,
                system: ctx._skill ? ctx._skill.systemPrompt : _directorSystemPrompt(),
                user: userPrompt,
                temperature: 0.4,
                max_tokens: 4000,
                signal: ctx.signal || null,
            }, (chunk) => {
                _emit('director_chunk', { novelId, turn, chunk });
            });
        } catch (e) {
            return { ok: false, error: 'LLM 调用失败：' + e.message, toolHistory, skillResults };
        }
        if (!res || !res.ok) {
            return { ok: false, error: (res && res.error) || 'LLM 无响应', toolHistory, skillResults };
        }
        lastText = res.text || '';
        _emit('director_turn_finished', { novelId, turn, text: lastText.slice(0, 4000) });

        const parsed = _parseDirectorResponse(lastText);
        if (parsed.done) {
            doneSummary = parsed.done.summary || parsed.done.summary_v2 || JSON.stringify(parsed.done);
            break;
        }
        if (!parsed.toolCalls.length) {
            // LLM 没调工具也没给 done marker — 视为软失败，再给一次机会
            userPrompt += '\n\n（你既没调用工具也没输出 DONE。请要么调工具，要么输出 DONE。）';
            continue;
        }
        // 执行所有 tool calls
        const results = [];
        for (const call of parsed.toolCalls) {
            const r = await _directorExecuteTool(novelId, call, skillResults);
            results.push({ name: call.name, ok: r.ok, error: r.error || null, output: r.output });
            toolHistory.push({ turn, name: call.name, ok: r.ok, error: r.error || null });
        }
        // 把结果塞回下一轮 user prompt
        userPrompt += '\n\n【工具结果】\n' +
            results.map(r => {
                const out = (r.output && typeof r.output === 'object') ? JSON.stringify(r.output).slice(0, 800) : String(r.output || '').slice(0, 800);
                return `${r.name}: ${r.ok ? 'OK' : 'FAIL: ' + r.error}\n${out}`;
            }).join('\n');
    }

    if (!doneSummary) doneSummary = `达到最大轮次（${DIRECTOR_MAX_TURNS}）未完成，最后 LLM 输出：${lastText.slice(0, 200)}`;
    return { ok: true, summary: doneSummary, toolHistory, skillResults };
}

// _runDirectedAgent 是 IPC / 旧 generateOutline / writeChapter 的入口
async function _runDirectedAgent(novelId, goal, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!_skills.has('novel-director')) _registerNovelDirector();
    const ctx = _loadContext(novelId);
    if (!ctx) return { ok: false, error: '小说不存在' };
    const provider = _getProviderConfig();
    if (!provider) return { ok: false, error: '未配置 LLM provider' };
    const director = _skills.get('novel-director');
    const composed = _composeSystemPrompt(director, novelId);
    const effectiveSkill = Object.assign({}, director, { systemPrompt: composed.system });
    const ctx2 = {
        novel: ctx.novel,
        outline: ctx.outline,
        chapters: ctx.chapters,
        provider,
        signal: (opts && opts.signal) || null,
        store: _store,
        novelId,
        _skill: effectiveSkill,
        _recordPrompt: opts && opts._recordPrompt || (() => {}),
    };
    try {
        const out = await director.run.call(director, { goal, ...(opts && opts.input || {}) }, ctx2);
        _emit('director_finished', { novelId, summary: out && out.output && out.output.summary });
        return { ok: true, output: out && out.output };
    } catch (e) {
        _emit('director_failed', { novelId, error: e.message });
        return { ok: false, error: e.message };
    }
}

// ====== End Director ======

// ====== Sprint H6: 调度模式开关（director / pipeline）======
// 'pipeline'（默认，兼容旧行为）：走硬编码的 _runOutlinePipeline / _runChapterPipeline
// 'director'：先让 novel-director LLM 自主调度；失败自动 fallback 回 pipeline
const DIRECTOR_MODE_KEY = 'director_mode';
const _VALID_DIRECTOR_MODES = ['pipeline', 'director'];

function getDirectorMode() {
    if (!_store) return 'pipeline';
    try {
        const row = _store.query('SELECT value FROM _ainovel_settings WHERE key = ?', DIRECTOR_MODE_KEY)[0];
        const v = row && row.value;
        return _VALID_DIRECTOR_MODES.includes(v) ? v : 'pipeline';
    } catch (e) {
        return 'pipeline';
    }
}

function setDirectorMode(mode) {
    if (!_VALID_DIRECTOR_MODES.includes(mode)) {
        return { ok: false, error: `mode 必须是 ${_VALID_DIRECTOR_MODES.join(' / ')}` };
    }
    if (!_store) return { ok: false, error: 'store 未初始化' };
    _store.exec(
        `INSERT INTO _ainovel_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        DIRECTOR_MODE_KEY, mode, _now()
    );
    _emit('director_mode_changed', { mode });
    return { ok: true, mode };
}

// ====== Sprint 3: 动态 plan 模式（director.plan() → orchestrator）======
// 'off' (默认): 不调 director.plan()，直接用静态 buildOutlinePlan / buildChapterPlan
// 'outline'  : 大纲生成时先尝试 director.plan()，失败 fallback 静态
// 'chapter'  : 章节生成时先尝试 director.plan()，失败 fallback 静态
// 'all'      : 两者都先尝试 director.plan()
const DYNAMIC_PLAN_MODE_KEY = 'dynamic_plan_mode';
const _VALID_DYNAMIC_PLAN_MODES = ['off', 'outline', 'chapter', 'all'];

function getDynamicPlanMode() {
    if (!_store) return 'off';
    try {
        const row = _store.query('SELECT value FROM _ainovel_settings WHERE key = ?', DYNAMIC_PLAN_MODE_KEY)[0];
        const v = row && row.value;
        return _VALID_DYNAMIC_PLAN_MODES.includes(v) ? v : 'off';
    } catch (e) {
        return 'off';
    }
}

function setDynamicPlanMode(mode) {
    if (!_VALID_DYNAMIC_PLAN_MODES.includes(mode)) {
        return { ok: false, error: `mode 必须是 ${_VALID_DYNAMIC_PLAN_MODES.join(' / ')}` };
    }
    if (!_store) return { ok: false, error: 'store 未初始化' };
    _store.exec(
        `INSERT INTO _ainovel_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        DYNAMIC_PLAN_MODE_KEY, mode, _now()
    );
    _emit('dynamic_plan_mode_changed', { mode });
    return { ok: true, mode };
}

// 让 director LLM 输出 PLAN_READY 标记，解析为 plan。
// 失败 / 未启用 / LLM 出错都返回 null，调用方应 fallback 静态 plan。
// opts = { kind: 'outline' | 'chapter', chapterId?: string }
async function _tryGenerateDirectorPlan(novelId, opts = {}) {
    const mode = getDynamicPlanMode();
    if (mode === 'off') return null;
    if (mode === 'outline' && opts.kind !== 'outline') return null;
    if (mode === 'chapter' && opts.kind !== 'chapter') return null;

    if (!_skills.has('novel-director')) _registerNovelDirector();
    const director = _skills.get('novel-director');
    if (!director) return null;

    const ctx = _loadContext(novelId);
    if (!ctx) return null;
    const provider = _getProviderConfig();
    if (!provider) return null;

    // 构造目标字符串，让 director 知道要做什么
    let goal;
    if (opts.kind === 'chapter') {
        goal = `为小说《${ctx.novel.title}》的第 ${opts.chapterId || '?'} 章生成写作 plan`;
    } else {
        goal = `为小说《${ctx.novel.title}》生成完整大纲的 plan`;
    }

    try {
        const composed = _composeSystemPrompt(director, novelId);
        const userPrompt = goal + '\n\n【指令】\n请按 system prompt 的 v2 模式输出 PLAN_READY 标记，包裹一份完整 plan JSON。不要输出其它内容。';
        const res = await novel.generateStream(_buildStreamOpts({ provider, signal: null }, {
            provider: provider.provider,
            base_url: provider.base_url,
            api_key: provider.api_key,
            model: provider.model,
            system: composed.system,
            user: userPrompt,
            temperature: 0.4,
            max_tokens: 4000,
        }), null);
        if (!res || !res.ok) {
            console.warn('[director.plan] LLM 调用失败:', res && res.error);
            return null;
        }
        const parsed = _parseDirectorPlan(res.text);
        if (!parsed.ok) {
            console.warn('[director.plan] 解析失败:', parsed.error);
            return null;
        }

        // 转换为 orchestrator 期望的 plan shape
        const tasks = parsed.plan.tasks.map(t => ({
            id: t.id,
            type: 'agent_call',
            capability: t.capability,
            depends_on: t.depends_on,
            input: () => t.input,                    // 函数形式，让 orchestrator 在 dispatch 时求值
            priority: t.priority,
            maxRetries: t.maxRetries,
            fallbackStrategy: t.fallbackStrategy,
            meta: { novelId, source: 'director-plan' },
        }));
        return { goal: parsed.plan.goal, tasks, source: 'director-plan' };
    } catch (e) {
        console.warn('[director.plan] exception:', e && e.message);
        return null;
    }
}

// 通用 key/value 设置读写（用于渲染端偏好持久化，如 auto_chain_after_outline）
function getSetting(key) {
    if (!key) return { ok: false, error: 'key 必填' };
    if (!_store) return { ok: false, error: 'store 未初始化' };
    try {
        const row = _store.query('SELECT value FROM _ainovel_settings WHERE key = ?', key)[0];
        return { ok: true, value: row ? row.value : null };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
function setSetting(key, value) {
    if (!key) return { ok: false, error: 'key 必填' };
    if (!_store) return { ok: false, error: 'store 未初始化' };
    try {
        _store.exec(
            `INSERT INTO _ainovel_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            key, value == null ? '' : String(value), _now()
        );
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// 统一入口：先试 director，失败/未开启则 fallback 到 pipeline
// fallbackFn 必须返回 pipeline 的原始结果结构
async function _directorOrPipeline(novelId, goal, fallbackFn, opts = {}) {
    const mode = getDirectorMode();
    if (mode !== 'director') {
        return { via: 'pipeline', result: await fallbackFn() };
    }
    try {
        const r = await _runDirectedAgent(novelId, goal, opts);
        if (r && r.ok) {
            _emit('director_dispatch_ok', { novelId, goal: String(goal).slice(0, 120) });
            return { via: 'director', result: r.output, directorRaw: r };
        }
        _emit('director_dispatch_fallback', { novelId, reason: (r && r.error) || 'director 返回 ok=false' });
    } catch (e) {
        _emit('director_dispatch_fallback', { novelId, reason: e.message });
    }
    // fallback
    return { via: 'pipeline-fallback', result: await fallbackFn() };
}

function _loadContext(novelId) {
    if (!novelId) return null;
    if (_contexts.has(novelId)) return _contexts.get(novelId);
    const novel = (_store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0]) || null;
    if (!novel) return null;
    const outline = (_store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) || null;
    const chapters = _store.query('SELECT * FROM _ainovel_chapters WHERE novel_id = ? ORDER BY chapter_no', novelId);
    const ctx = {
        novel,
        outline,
        chapters: new Map(chapters.map(c => [c.id, c])),
        workingMemory: { lastGeneration: null },
    };
    _contexts.set(novelId, ctx);
    return ctx;
}

function dropContext(novelId) {
    _contexts.delete(novelId);
    if (_activeNovelId === novelId) _activeNovelId = null;
}

// LRU 保护：超过 10 个不活跃 context 自动淘汰
function _enforceContextLimit(max = 10) {
    if (_contexts.size <= max) return;
    const keys = Array.from(_contexts.keys());
    const dropCount = _contexts.size - max;
    for (let i = 0; i < dropCount; i++) {
        if (keys[i] !== _activeNovelId) _contexts.delete(keys[i]);
    }
}

function setActive(novelId) {
    _activeNovelId = novelId;
    _loadContext(novelId);
}

function getActive() {
    return _activeNovelId ? _contexts.get(_activeNovelId) : null;
}

// ====== Helpers ======
function _uuid() {
    return crypto.randomUUID();
}

function _now() {
    return Math.floor(Date.now() / 1000);
}

function _getProviderConfig() {
    if (!_store) return null;
    const row = (_store.query('SELECT * FROM _ainovel_provider_config WHERE key = ?', PROVIDER_CONFIG_KEY)[0]) || null;
    if (!row) return null;
    let enabledSkills = [];
    if (row.thinking_enabled_skills) {
        try { enabledSkills = JSON.parse(row.thinking_enabled_skills); } catch (e) { enabledSkills = []; }
    }
    return {
        provider: row.provider,
        base_url: row.base_url,
        api_key: row.api_key,
        model: row.model,
        temperature: row.temperature,
        max_tokens: row.max_tokens,
        thinking_budget: row.thinking_budget || 0,
        reasoning_effort: row.reasoning_effort || null,
        thinking_enabled_skills: enabledSkills,
    };
}

function _setProviderConfig(cfg) {
    const now = _now();
    const enabledSkills = Array.isArray(cfg.thinking_enabled_skills) ? JSON.stringify(cfg.thinking_enabled_skills) : null;
    _store.exec(
        `INSERT INTO _ainovel_provider_config (key, provider, base_url, api_key, model, temperature, max_tokens,
            thinking_budget, reasoning_effort, thinking_enabled_skills, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           api_key = excluded.api_key,
           model = excluded.model,
           temperature = excluded.temperature,
           max_tokens = excluded.max_tokens,
           thinking_budget = excluded.thinking_budget,
           reasoning_effort = excluded.reasoning_effort,
           thinking_enabled_skills = excluded.thinking_enabled_skills,
           updated_at = excluded.updated_at`,
        PROVIDER_CONFIG_KEY,
        cfg.provider,
        cfg.base_url || null,
        cfg.api_key || null,
        cfg.model,
        cfg.temperature != null ? cfg.temperature : 0.8,
        cfg.max_tokens != null ? cfg.max_tokens : 4000,
        cfg.thinking_budget != null ? Number(cfg.thinking_budget) : 0,
        cfg.reasoning_effort || null,
        enabledSkills,
        now
    );
}

function _recordGeneration(rec) {
    _store.exec(
        `INSERT INTO _ainovel_generations
            (id, novel_id, chapter_id, skill, display_name, provider, model, prompt_tokens, completion_tokens,
             cost_usd, duration_ms, raw_request, raw_response, status, error_msg, phase, agent_name, round,
             injected_memory_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        _uuid(),
        rec.novel_id,
        rec.chapter_id || null,
        rec.skill,
        rec.display_name || null,
        rec.provider,
        rec.model,
        rec.prompt_tokens || null,
        rec.completion_tokens || null,
        rec.cost_usd || null,
        rec.duration_ms || null,
        rec.raw_request || null,
        rec.raw_response || null,
        rec.status || 'ok',
        rec.error_msg || null,
        rec.phase || null,
        rec.agent_name || null,
        rec.round || null,
        rec.injected_memory_bytes || null,
        _now()
    );
    // ★ Sprint C-S1: 同步累加成本到内存缓存（cost-tracker 每 5 秒批量落 DB）
    if (_costTracker && rec.novel_id) {
        _costTracker.track(rec.novel_id, {
            promptTokens: rec.prompt_tokens || 0,
            completionTokens: rec.completion_tokens || 0,
            costUsd: rec.cost_usd || 0,
        });
    }
    // OpenClaw Phase 4-Sprint C: 写 memory 日志（全局 + per-novel）
    // 失败也不阻塞主流程（catch 内已 warn）
    try {
        // 查 novel 标题（仅供 memory 日志可读，不影响主流程）
        const novelRow = _store.query('SELECT title FROM _ainovel_novels WHERE id = ?', rec.novel_id)[0];
        _appendMemoryLog(rec.skill, rec.novel_id, {
            skill: rec.skill,
            novel: novelRow ? novelRow.title : null,
            chapterId: rec.chapter_id || null,
            phase: rec.phase || null,
            round: rec.round || null,
            input: rec.raw_request ? String(rec.raw_request).slice(0, 200) : null,
            output: rec.raw_response ? String(rec.raw_response).slice(0, 200) : null,
            tokens: { prompt: rec.prompt_tokens, completion: rec.completion_tokens },
            durationMs: rec.duration_ms,
            status: rec.status,
            error: rec.error_msg || null,
        });
    } catch (e) {
        console.warn('[novel-engine] _recordGeneration memory log hook failed:', e.message);
    }
}

function _emit(type, payload) {
    // Sprint W: 镜像落库（工作面板事件流），失败不影响主流程
    try { _persistWorkflowEvent(type, payload); } catch (e) { /* best effort */ }
    try { _notify('ainovel:event:update', { type, ...payload }); }
    catch (e) { console.warn('[novel-engine] notify failed:', e.message); }
}

// ============ Sprint W: 工作面板事件持久化 ============

const _WF_KIND_RE = /^(agent|stream|phase|overseer|blackboard|inbox|task|auto|outline|chapter|novel|knowledge|architecture|bible)/;

// 哪些 event type 应该落库（白名单 + 过滤掉太频繁的）
// 注意：实际 emit 的事件名是 agent_started/finished, phase_started/finished, pipeline_started/finished/failed（不要跟 _completed 混淆）
const _WF_PERSISTABLE = new Set([
    // agent / pipeline（与 _runPipeline 实际 emit 对齐）
    'agent_started', 'agent_chunk', 'agent_thinking_chunk', 'agent_finished', 'agent_failed',
    'pipeline_started', 'pipeline_finished', 'pipeline_failed', 'chapter_progress',
    'phase_started', 'phase_finished',
    'stream_started', 'stream_chunk', 'stream_completed',
    // 编剧监督
    'overseer_decided', 'overseer_failed',
    // 黑板 / 收件箱 / 任务图
    'blackboard_written', 'inbox_received',
    'task_created', 'task_claimed', 'task_completed', 'task_failed',
    // 自动写作
    'auto_started', 'auto_chapter_started', 'auto_chapter_failed',
    'auto_paused', 'auto_resumed', 'auto_finished', 'auto_cancelled',
    'auto_overseer_decided', 'auto_overseer_failed',
    // 生命周期
    'outline_generated', 'outline_updated',
    'chapter_generated', 'chapter_updated',
    'novel_added', 'novel_removed',
]);

// 流式聚合：按 (novel_id, agent, chapter_id) 合并；新 chunk 走 in-place 更新而不是新增 row
function _wfStreamKey(payload) {
    return `${payload.novelId || ''}|${payload.skill || payload.agent || ''}|${payload.chapterId || payload.chapterNo || ''}`;
}
const _wfRunningStream = new Map();  // key → event_id（最新 running 行）

function _wfKindFor(type) {
    // 大部分情况 kind = type；overseer 子类优先于 auto
    if (type === 'auto_overseer_decided' || type === 'auto_overseer_failed' || type.startsWith('overseer_')) return 'overseer';
    if (type.startsWith('auto_')) return 'auto';
    if (type.startsWith('phase_')) return 'phase';
    if (type.startsWith('task_')) return 'task';
    if (type.startsWith('blackboard_')) return 'blackboard';
    if (type.startsWith('inbox_')) return 'inbox';
    if (type.startsWith('stream_')) return 'stream';
    if (type.startsWith('agent_')) return 'agent';
    return type;
}
function _wfStatusFor(type) {
    if (/_failed$/.test(type)) return 'failed';
    if (/(^|_)(invoked|started|chunk|running|received|written|created|claimed)$/.test(type)) return 'running';
    return 'completed';
}
function _wfAgentFor(type, payload) {
    // 兼容多种命名：真实 emit 用 agentName（_runAgent / callSkill），测试代码常用 agent
    return payload.agentName || payload.agent || payload.skill || payload.to || payload.owner || null;
}
function _wfPhaseFor(type, payload) {
    return payload.phase || null;
}
function _wfSummaryFor(type, payload) {
    const a = _wfAgentFor(type, payload);
    const label = {
        agent_started: '开始调用', agent_chunk: '流式输出中', agent_thinking_chunk: '思考中', agent_finished: '调用完成', agent_failed: '调用失败',
        pipeline_started: '流水线开始', pipeline_finished: '流水线完成', pipeline_failed: '流水线失败',
        phase_started: '阶段开始', phase_finished: '阶段完成',
        stream_started: '开始流式输出', stream_chunk: '流式输出中', stream_completed: '流式输出完成',
        overseer_decided: '编剧监督决策', overseer_failed: '编剧监督失败',
        blackboard_written: '写入黑板', inbox_received: '收到消息',
        task_created: '任务创建', task_claimed: '任务认领', task_completed: '任务完成', task_failed: '任务失败',
        auto_started: '启动自动写作', auto_chapter_started: '开始写章节', auto_chapter_failed: '章节失败',
        auto_paused: '自动写作暂停', auto_resumed: '自动写作继续', auto_finished: '自动写作完成', auto_cancelled: '自动写作取消',
        auto_overseer_decided: '编剧监督决策', auto_overseer_failed: '编剧监督失败',
        outline_generated: '大纲生成完成', outline_updated: '大纲更新',
        chapter_generated: '章节生成完成', chapter_updated: '章节更新',
        novel_added: '新建小说', novel_removed: '删除小说',
    }[type] || type;
    if (a) return `[${a}] ${label}`;
    return label;
}

function _wfIdFor(novelId, type, payload) {
    // 流式 chunk 用稳定 key（按 novelId+skill+chapterId）— 同一 agent 同一次运行共享 id
    if (type === 'stream_chunk' || type === 'stream_started') {
        return `wf-${novelId}-${payload.skill || '?'}-${payload.chapterId || payload.chapterNo || '?'}-${payload.jobId || 'run'}`;
    }
    if (type === 'stream_completed') {
        return `wf-${novelId}-${payload.skill || '?'}-${payload.chapterId || payload.chapterNo || '?'}-${payload.jobId || 'run'}-done`;
    }
    // 所有 agent_* 事件共享一个稳定 id（一次 agent 运行 = 一行 DB row）
    // 这样 UI 上一个 agent 只有一个节点，不会被 started/chunk/finished 三次出现
    if (type === 'agent_started' || type === 'agent_chunk' || type === 'agent_thinking_chunk' || type === 'agent_finished' || type === 'agent_failed') {
        const agentKey = payload.agentName || payload.agent || '?';
        return `wf-${novelId}-${agentKey}-${payload.jobId || 'run'}-run`;
    }
    return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function _persistWorkflowEvent(type, payload) {
    if (!_store) return;
    if (!_WF_PERSISTABLE.has(type)) return;
    const novelId = payload && payload.novelId;
    if (!novelId) return;

    const id = _wfIdFor(novelId, type, payload);
    const ts = Math.floor((payload && payload.startedAt) || Date.now());
    const kind = _wfKindFor(type);
    const status = _wfStatusFor(type);
    const agent = _wfAgentFor(type, payload);
    const phase = _wfPhaseFor(type, payload);
    const summary = _wfSummaryFor(type, payload);
    const error = (payload && payload.error) ? String(payload.error).slice(0, 2000) : null;
    const durationMs = (payload && payload.durationMs) ? Number(payload.durationMs) : null;

    // 先把 inputJson / outputJson / payloadJson 算出来（下面 stream_completed 分支也要用）
    const inputJson = payload
        ? JSON.stringify(_wfTruncFor(
            payload.input !== undefined ? payload.input : payload,
            'input'
        ))
        : null;
    const outputJson = payload && payload.output !== undefined
        ? JSON.stringify(_wfTruncFor(payload.output, 'output'))
        : null;
    const payloadJson = payload ? JSON.stringify(_wfTruncFor(payload, 'payload')) : null;

    // 流式 chunk：in-place 更新（按 id），不新增行
    if (type === 'stream_chunk') {
        const prev = _store.query(
            `SELECT id, summary, input FROM _ainovel_workflow_events WHERE id = ?`, id
        )[0];
        if (prev) {
            // 合并：summary = "<原摘要> + N chars"; input = delta 累加
            const prevInput = (() => { try { return prev.input ? JSON.parse(prev.input) : null; } catch (e) { return null; } })();
            const deltaLen = payload && payload.chunk && (payload.chunk.delta || payload.chunk.text || '').length || 0;
            const newAccum = (prevInput && prevInput.accumulated) || 0;
            const newCount = (prevInput && prevInput.count) || 0;
            // lastText：累积文本的最近 3000 字（用于工作面板直接铺开显示，避免每次刷新只能看到 lastDelta）
            const fullText = (payload && payload.accumulated != null)
                ? String(payload.accumulated)
                : String(payload.chunk && (payload.chunk.delta || payload.chunk.text) || '');
            const mergedInput = {
                accumulated: newAccum + deltaLen,
                count: newCount + 1,
                lastDelta: String(payload.chunk && (payload.chunk.delta || payload.chunk.text) || '').slice(0, 500),
                lastText: fullText.length > 3000 ? fullText.slice(-3000) : fullText,
            };
            const newSummary = `流式输出中 (+${mergedInput.accumulated} chars, ${mergedInput.count} chunks)`;
            _store.exec(
                `UPDATE _ainovel_workflow_events
                    SET summary = ?, status = 'running', input = ?, ts = ?
                  WHERE id = ?`,
                newSummary, JSON.stringify(mergedInput), ts, id
            );
            return;
        }
        // 没找到前置 running 行 → 当作新事件（防御）
    }

    // agent_chunk：所有 agent 的流式 chunk 走 in-place UPDATE
    // 与 stream_chunk 类似，但 payload 结构不同（chunk 是 string，不是 {delta/text}）
    if (type === 'agent_chunk') {
        const prev = _store.query(
            `SELECT id, summary, input FROM _ainovel_workflow_events WHERE id = ?`, id
        )[0];
        if (prev) {
            const prevInput = (() => { try { return prev.input ? JSON.parse(prev.input) : null; } catch (e) { return null; } })();
            const chunkStr = payload && payload.chunk != null ? String(payload.chunk) : '';
            const deltaLen = chunkStr.length;
            const newAccum = (prevInput && prevInput.accumulated) || 0;
            const newCount = (prevInput && prevInput.count) || 0;
            // fullText 优先用 payload.accumulated，否则用拼接
            const fullText = (payload && payload.accumulated != null)
                ? String(payload.accumulated)
                : chunkStr;
            const mergedInput = {
                accumulated: (payload && payload.accumulated != null) ? String(payload.accumulated).length : (newAccum + deltaLen),
                count: newCount + 1,
                lastDelta: chunkStr.slice(0, 500),
                lastText: fullText.length > 3000 ? fullText.slice(-3000) : fullText,
            };
            const newSummary = `[${payload.agentName || 'agent'}] 流式输出中 (+${mergedInput.accumulated} chars)`;
            _store.exec(
                `UPDATE _ainovel_workflow_events
                    SET summary = ?, status = 'running', input = ?, ts = ?
                  WHERE id = ?`,
                newSummary, JSON.stringify(mergedInput), ts, id
            );
            return;
        }
        // 没找到前置 running 行 → 当作新事件（防御）
    }

    // agent_thinking_chunk：推理 / extended thinking 的 token chunk
    // 与 agent_chunk 走同一条 in-place UPDATE 行（共享 id），但累积到 input.thinkingText / input.thinkingCount
    if (type === 'agent_thinking_chunk') {
        const prev = _store.query(
            `SELECT id, summary, input FROM _ainovel_workflow_events WHERE id = ?`, id
        )[0];
        if (prev) {
            const prevInput = (() => { try { return prev.input ? JSON.parse(prev.input) : null; } catch (e) { return null; } })();
            const chunkStr = payload && payload.chunk != null ? String(payload.chunk) : '';
            const fullThinking = (payload && payload.accumulated != null)
                ? String(payload.accumulated)
                : ((prevInput && prevInput.thinkingText) || '') + chunkStr;
            const mergedInput = Object.assign({}, prevInput || {}, {
                thinkingText: fullThinking.length > 5000 ? fullThinking.slice(-5000) : fullThinking,
                thinkingCount: ((prevInput && prevInput.thinkingCount) || 0) + 1,
                thinkingLastDelta: chunkStr.slice(0, 500),
            });
            const newSummary = `[${payload.agentName || 'agent'}] 思考中 (+${mergedInput.thinkingCount} chunks)`;
            _store.exec(
                `UPDATE _ainovel_workflow_events
                    SET summary = ?, status = 'running', input = ?, ts = ?
                  WHERE id = ?`,
                newSummary, JSON.stringify(mergedInput), ts, id
            );
            return;
        }
        // 没找到前置 running 行 → 当作新事件（防御）
    }

    // stream_completed：用不同 id（避免覆盖 running 节点）
    if (type === 'stream_completed') {
        const newId = id + '-done';
        // 写一行 completed；running 行保持不变（已经在 UPDATE path 处理）
        try {
            _store.exec(
                `INSERT OR IGNORE INTO _ainovel_workflow_events
                    (id, novel_id, ts, kind, agent, phase, status, summary, parent_id, duration_ms, input, output, error, payload)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                newId, novelId, ts, kind, agent, phase, 'completed',
                `流式输出完成（${payload && payload.totalChars ? payload.totalChars : '?'} chars）`,
                payload && payload.parentId ? payload.parentId : null,
                durationMs,
                inputJson, outputJson, error, payloadJson
            );
            return;
        } catch (e) { /* fallthrough to normal insert */ }
    }

    // agent_finished / agent_failed：UPDATE 已有的 running 行（agent_started 创建的那一行）
    // 保留 input.lastText（累积正文），只更新 status / output / error / summary / duration
    if (type === 'agent_finished' || type === 'agent_failed') {
        try {
            const finishedStatus = type === 'agent_finished' ? 'completed' : 'failed';
            const agentName = payload.agentName || payload.agent || 'agent';
            const finishedSummary = type === 'agent_finished'
                ? `[${agentName}] 调用完成 (${durationMs || '?'}ms)`
                : `[${agentName}] 调用失败`;
            // 用 UPDATE 而不是 INSERT OR REPLACE — 保留 input.lastText 等运行时的字段
            const updated = _store.exec(
                `UPDATE _ainovel_workflow_events
                    SET status = ?, summary = ?, output = ?, error = ?,
                        duration_ms = COALESCE(?, duration_ms), ts = ?, payload = ?
                  WHERE id = ?`,
                finishedStatus, finishedSummary, outputJson, error, durationMs, ts, payloadJson, id
            );
            if (updated && updated.changes > 0) return;
            // 没找到前置 started 行 → 落到默认 INSERT OR REPLACE
        } catch (e) { /* fallthrough */ }
    }

    try {
        _store.exec(
            `INSERT OR REPLACE INTO _ainovel_workflow_events
                (id, novel_id, ts, kind, agent, phase, status, summary, parent_id, duration_ms, input, output, error, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, novelId, ts, kind, agent, phase, status, summary,
            payload && payload.parentId ? payload.parentId : null,
            durationMs, inputJson, outputJson, error, payloadJson
        );
    } catch (e) {
        // 表可能还没建好（旧 bootstrap 路径）— 不抛
    }
}

// 把 payload 截断到合理大小（避免每条 1MB JSON 入库）
function _wfTruncFor(obj, _kind) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length > 2000) {
            out[k] = v.slice(0, 2000) + `...[truncated ${v.length - 2000} chars]`;
        } else if (k === 'chunk' || k === 'raw' || k === 'raw_request' || k === 'raw_response') {
            // 流式 chunk / 完整 prompt-response 不入 workflow_events（在 generations 表）
            out[k] = '[see _ainovel_generations]';
        } else {
            out[k] = v;
        }
    }
    return out;
}

// 工作面板：分页 + 过滤（默认按 ts desc 取最近 N 条）
function listWorkflowEvents(novelId, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    const o = opts || {};
    const limit = Math.max(1, Math.min(500, (o.limit != null ? o.limit : 100) | 0));
    const offset = Math.max(0, (o.offset != null ? o.offset : 0) | 0);
    const where = ['novel_id = ?'];
    const params = [novelId];
    if (o.kind) { where.push('kind = ?'); params.push(o.kind); }
    if (o.agent) { where.push('agent = ?'); params.push(o.agent); }
    if (o.status) { where.push('status = ?'); params.push(o.status); }
    if (o.since) { where.push('ts >= ?'); params.push(o.since | 0); }
    if (o.until) { where.push('ts <= ?'); params.push(o.until | 0); }
    const sql = `SELECT id, novel_id, ts, kind, agent, phase, status, summary, parent_id, duration_ms, error, input, output
                   FROM _ainovel_workflow_events
                  WHERE ${where.join(' AND ')}
                  ORDER BY ts DESC
                  LIMIT ? OFFSET ?`;
    const rows = _store.query(sql, ...params, limit, offset);
    const total = (_store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_workflow_events WHERE ${where.join(' AND ')}`,
        ...params
    )[0]).c;
    // output/input 是 JSON 字符串，前端拿到直接用即可（不需要预解析）
    return { ok: true, events: rows, total, limit, offset };
}

// 工作面板：时间倒放（按 ts asc 分页，从最早的开始加载）
function listWorkflowReplay(novelId, opts) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    const o = opts || {};
    const limit = Math.max(1, Math.min(500, (o.limit != null ? o.limit : 100) | 0));
    const offset = Math.max(0, (o.offset != null ? o.offset : 0) | 0);
    const where = ['novel_id = ?'];
    const params = [novelId];
    if (o.since) { where.push('ts >= ?'); params.push(o.since | 0); }
    if (o.until) { where.push('ts <= ?'); params.push(o.until | 0); }
    // desc → asc 转换：offset 仍是"跳过多少条最近的"
    const sql = `SELECT id, novel_id, ts, kind, agent, phase, status, summary, parent_id, duration_ms, error, input, output
                   FROM _ainovel_workflow_events
                  WHERE ${where.join(' AND ')}
                  ORDER BY ts ASC
                  LIMIT ? OFFSET ?`;
    const rows = _store.query(sql, ...params, limit, offset);
    const total = (_store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_workflow_events WHERE ${where.join(' AND ')}`,
        ...params
    )[0]).c;
    return { ok: true, events: rows, total, limit, offset };
}

// 工作面板：单条详情（完整 input/output/payload JSON）
function getWorkflowEventDetail(id) {
    if (!id) return { ok: false, error: 'id 必填' };
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    const row = _store.query(`SELECT * FROM _ainovel_workflow_events WHERE id = ?`, id)[0];
    if (!row) return { ok: false, error: '事件不存在' };
    const parse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return s; } };
    return {
        ok: true,
        event: {
            ...row,
            input: parse(row.input),
            output: parse(row.output),
            payload: parse(row.payload),
        },
    };
}

// 工作面板：聚合统计（每种 kind / agent 的事件数）
function getWorkflowStats(novelId) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    const byKind = _store.query(
        `SELECT kind, COUNT(*) AS c FROM _ainovel_workflow_events WHERE novel_id = ? GROUP BY kind ORDER BY c DESC`,
        novelId
    );
    const byAgent = _store.query(
        `SELECT COALESCE(agent, '(none)') AS agent, COUNT(*) AS c FROM _ainovel_workflow_events WHERE novel_id = ? GROUP BY agent ORDER BY c DESC LIMIT 20`,
        novelId
    );
    const tsRange = _store.query(
        `SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts, COUNT(*) AS total FROM _ainovel_workflow_events WHERE novel_id = ?`,
        novelId
    )[0] || {};
    return { ok: true, byKind, byAgent, tsRange };
}

// 流式任务跟踪：{ novelId → Set<jobId> }，让 main 端可以 cancel / 防重复
const _runningJobs = new Map(); // novelId → Set<jobId>

function _newJobId(novelId) {
    return `${novelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _jobStart(novelId, jobId, skill) {
    if (!_runningJobs.has(novelId)) _runningJobs.set(novelId, new Set());
    _runningJobs.get(novelId).add(jobId);
    _emit('generation_started', { novelId, jobId, skill, startedAt: Date.now() });
}

function _jobEnd(novelId, jobId) {
    const set = _runningJobs.get(novelId);
    if (set) { set.delete(jobId); if (!set.size) _runningJobs.delete(novelId); }
}

function _isJobRunning(novelId) {
    const set = _runningJobs.get(novelId);
    return !!(set && set.size);
}

function _makeChunkEmitter(novelId, jobId, skill) {
    return (chunk, accumulated) => {
        _emit('stream', { novelId, jobId, skill, chunk, accumulated });
    };
}

// Sprint X: 思考 / 推理 配置 helper
// 给 skill.run() 调用 novel.generateStream 时使用，自动从 ctx.provider 拿 thinking_budget
// / reasoning_effort，并按 thinking_enabled_skills 决定当前 agent 是否启用
// 同时把 ctx._thinkingChunk 钩成 onThinkingChunk 回调（不需要 skill.run() 手动接入）
function _buildStreamOpts(ctx, baseOpts) {
    const cfg = (ctx && ctx.provider) || {};
    const skillName = (ctx && ctx.agentName) || '';
    const enabledSkills = Array.isArray(cfg.thinking_enabled_skills) ? cfg.thinking_enabled_skills : [];
    const thinkingEnabled = enabledSkills.indexOf(skillName) !== -1;
    const thinkingBudget = thinkingEnabled ? (cfg.thinking_budget || 0) : 0;
    const opts = Object.assign({}, baseOpts, {
        thinking_budget: thinkingBudget,
        reasoning_effort: cfg.reasoning_effort || null,
    });
    if (thinkingBudget > 0 || (cfg.reasoning_effort && /^o[13]|^deepseek/i.test(opts.model || ''))) {
        opts.onThinkingChunk = (chunk, acc) => {
            if (ctx._thinkingChunk) ctx._thinkingChunk(chunk, acc);
        };
    }
    return opts;
}

// ============ Phase 2: Pipeline 编排 ============
// 设计：
//   - _runAgent(novelId, agentName, input, opts) — 包装单个 agent skill 调用，
//     发出 agent_started / agent_chunk / agent_finished / agent_failed 事件，
//     写 _ainovel_generations 时带上 phase / agent_name / round 列。
//   - _runPipeline(novelId, pipelineName, phases) — 通用编排：依次跑每个 phase，
//     phase 内支持并行（agents 是数组就 Promise.all）。每个 phase 开始前 emit
//     phase_started，完成后 emit phase_finished。整个 pipeline 入口/出口各 emit
//     pipeline_started/finished/failed。
//
// 与 Phase 1 skill.callSkill 的关系：
//   - 老 skill 仍走 callSkill（被 outline-architect / chapter-writer 这俩原 skill 用）
//   - 新 agent 走 _runAgent（被 pipeline 用）
//   - 两者都依赖 _skills 注册；_runAgent 实际上等于 callSkill 的 event-rich 版本

async function _runAgent(novelId, agentName, input, opts = {}) {
    const skill = _skills.get(agentName);
    if (!skill) throw new Error('agent 不存在：' + agentName);

    const ctx = _loadContext(novelId);
    if (!ctx) throw new Error('小说不存在：' + novelId);

    const provider = _getProviderConfig();
    if (!provider) throw new Error('未配置 LLM provider（请到「设置 → AI 小说」配置）');

    const phaseIndex = opts.phaseIndex != null ? opts.phaseIndex : 0;
    const phaseName = opts.phaseName || '';
    const round = opts.round || 1;
    const role = opts.role || '';
    // Sprint W: 一次 agent 运行的稳定标识 — 所有相关事件都带，让前端 _wfKeyFor 算出同一 key，
    // 同一次运行的 running / chunk / finished 复用同一个 DOM 节点做 in-place 更新。
    const runJobId = opts.jobId || null;
    const runChapterId = opts.chapterId || null;

    _emit('agent_started', {
        novelId, agentName, phaseIndex, phaseName, role,
        jobId: runJobId,
        chapterId: runChapterId,
    });

    const t0 = Date.now();
    let accumulated = '';
    let thinkingAccumulated = '';
    let capturedRequest = null;  // 捕获 skill.run() 内部的 system+user，存入 raw_request
    let composed = { injectedMemoryBytes: 0 };
    const extraOnChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
    const extraOnThinkingChunk = typeof opts.onThinkingChunk === 'function' ? opts.onThinkingChunk : null;
    const chunkBatch = chapterIntegrity.batchChunks((chunk, acc) => {
        accumulated = acc;
        // Sprint W: chunk 必须带 jobId / chapterId，前端才能复用 running 节点做 in-place 更新
        _emit('agent_chunk', { novelId, agentName, phaseIndex, chunk, accumulated, jobId: runJobId, chapterId: runChapterId });
        if (extraOnChunk) extraOnChunk(chunk, acc);
    });
    const onChunk = chunkBatch.push;
    const thinkingBatch = chapterIntegrity.batchChunks((chunk, acc) => {
        thinkingAccumulated = acc;
        _emit('agent_thinking_chunk', { novelId, agentName, phaseIndex, chunk, accumulated: acc, jobId: runJobId, chapterId: runChapterId });
        if (extraOnThinkingChunk) extraOnThinkingChunk(chunk, acc);
    });
    const onThinkingChunk = thinkingBatch.push;

    try {
        // OpenClaw 模式：拼最终 system（SOUL + IDENTITY + AGENTS + MEMORY + 反馈 + USER + 原始 systemPrompt）
        composed = _composeSystemPrompt(skill, novelId);
        const effectiveSkill = Object.assign({}, skill, { systemPrompt: composed.system + (_chapterRuns.has(novelId)
            ? '\n【事实来源优先级】本次输入的前章正文、章节交接及写作前状态是事实依据；共享消息与历史经验不能覆盖它们。不得使用后续章节的事实。' : '') });

        const ctx2 = {
            novel: ctx.novel,
            outline: ctx.outline,
            chapters: ctx.chapters,
            provider,
            signal: opts.signal && _chapterRuns.get(novelId)
                ? AbortSignal.any([opts.signal, _chapterRuns.get(novelId).controller.signal])
                : opts.signal || _chapterRuns.get(novelId)?.controller.signal || null,
            storyState: _chapterRuns.get(novelId)?.base,
            store: _store,
            novelId,
            phase: phaseName,
            agentName,
            round,
            _chunk: onChunk,
            // 思考 / 推理 token 回调（skill.run() 通过 novel.generateStream 的 opts.onThinkingChunk 接入）
            _thinkingChunk: onThinkingChunk,
            // 把当前 skill def 注入 ctx，agent run（箭头函数 this 失效）内通过 ctx._skill.systemPrompt / temperature 取值
            _skill: effectiveSkill,
            // skill.run() 在调 novel.generateStream 前应调用 ctx._recordPrompt({system, user})
            // 闭包写入 capturedRequest，本函数末尾写入 raw_request
            _recordPrompt: (req) => { capturedRequest = req; },
        };
        if (_chapterRuns.has(novelId)) {
            if (agentName === 'chapter-streamer') _chapterProgress(novelId, input.currentDraft ? 'review' : 'write', input.currentDraft ? '正在修订问题段落' : '正在写正文', '草稿生成后还会进行衔接检查');
            if (chapterIntegrity.REVIEWERS.includes(agentName)) _chapterProgress(novelId, 'review', '正在检查章节衔接', '核对剧情、人物状态和语言过渡');
        }
        const out = await skill.run.call(skill, input, ctx2);
        chunkBatch.flush(); thinkingBatch.flush();
        if (agentName === 'chapter-streamer' && out.content && _chapterRuns.has(novelId)) {
            _checkpointChapter(novelId, out.content, { stage: 'draft', scenes: input.scenes || [] });
        }
        const duration = Date.now() - t0;

        // 写日志（带 phase/agent/round）
        _recordGeneration({
            novel_id: novelId,
            chapter_id: opts.chapterId || null,
            skill: agentName,
            display_name: skill.displayName || null,
            provider: provider.provider,
            model: provider.model,
            prompt_tokens: out.prompt_tokens || null,
            completion_tokens: out.completion_tokens || null,
            cost_usd: out.cost_usd || null,
            duration_ms: duration,
            raw_request: (opts.rawRequest || (capturedRequest ? JSON.stringify(capturedRequest) : '') || '').slice(0, 5000),
            raw_response: (out.raw || accumulated || '').slice(0, 5000),
            status: 'ok',
            phase: phaseName,
            agent_name: agentName,
            round,
            injected_memory_bytes: composed.injectedMemoryBytes,
        });

        _emit('agent_finished', {
            novelId, agentName, phaseIndex, phaseName, role,
            output: out.output || out.content || out.text || out,
            tokens: { prompt: out.prompt_tokens, completion: out.completion_tokens },
            duration_ms: duration,
            cost_usd: out.cost_usd,
            // Sprint W: 复用同一次 agent 运行的稳定标识（与 started/chunk 同一组），保证 in-place 更新。
            jobId: runJobId,
            chapterId: runChapterId,
        });
        return out;
    } catch (e) {
        chunkBatch.flush(); thinkingBatch.flush();
        if (agentName === 'chapter-streamer' && accumulated && _chapterRuns.has(novelId) && !input.currentDraft) {
            _checkpointChapter(novelId, accumulated, { stage: 'partial', scenes: input.scenes || [] });
        }
        const duration = Date.now() - t0;
        _recordGeneration({
            novel_id: novelId,
            chapter_id: opts.chapterId || null,
            skill: agentName,
            provider: provider.provider,
            model: provider.model,
            duration_ms: duration,
            // 失败时也保存 LLM 实际输出，便于 debug JSON 解析失败 / token 截断等
            raw_request: (opts.rawRequest || (capturedRequest ? JSON.stringify(capturedRequest) : '') || '').slice(0, 5000),
            raw_response: (accumulated || '').slice(0, 5000),
            display_name: skill.displayName || null,
            status: 'failed',
            error_msg: e.message || String(e),
            phase: phaseName,
            agent_name: agentName,
            round,
            injected_memory_bytes: composed.injectedMemoryBytes,
        });
        _emit('agent_failed', {
            novelId, agentName, phaseIndex, phaseName, role,
            error: e.message || String(e),
            // 把 raw_response 也带上，前端日志面板能直接看到
            raw_response: (accumulated || '').slice(0, 5000),
            // Sprint W: 复用同一次 agent 运行的稳定标识（与 started/chunk 同一组）。
            jobId: runJobId,
            chapterId: runChapterId,
        });
        throw e;
    }
}

/**
 * 通用 pipeline 编排。
 * phases: [{
 *   name: 'phase-A',
 *   agents: [{ name, role, input, opts? }]    // 并行
 * } | {
 *   name: 'phase-B',
 *   agents: { name, role, input, opts? }      // 串行（单个）
 * }]
 * pipeline: 'outline' | 'chapter' | string  — 标签写到日志
 * 返回：每个 phase 完成后可访问的 ctx；最后一个 phase 的输出为返回值。
 */
async function _runPipeline(novelId, pipeline, phases, baseOpts = {}) {
    const jobId = baseOpts.jobId || _newJobId(novelId);
    const ctxBag = { ...baseOpts.sharedCtx || {}, jobId, novelId, pipeline, outputs: {} };
    const ownsLifecycle = baseOpts.manageLifecycle !== false;
    const phaseIndexOffset = baseOpts.phaseIndexOffset || 0;

    if (ownsLifecycle) {
        _jobStart(novelId, jobId, pipeline);
        _emit('pipeline_started', { novelId, jobId, pipeline, totalPhases: phases.length });
    }

    try {
        for (let i = 0; i < phases.length; i++) {
            const ph = phases[i];
            const agentSpecs = Array.isArray(ph.agents) ? ph.agents : [ph.agents];
            const agentNames = agentSpecs.map(a => a.name);

            _emit('phase_started', {
                novelId, jobId, pipeline, phaseIndex: phaseIndexOffset + i,
                phaseName: ph.name, agents: agentNames,
            });

            let phaseOutputs;
            if (agentSpecs.length === 1) {
                // 单个 agent 直接 await（避免 Promise.all 包装）
                const spec = agentSpecs[0];
                const out = await _runAgent(novelId, spec.name, spec.input, {
                    phaseIndex: phaseIndexOffset + i,
                    phaseName: ph.name,
                    role: spec.role || '',
                    round: spec.round || 1,
                    chapterId: baseOpts.chapterId,
                    jobId,
                    onChunk: baseOpts.onChunk,
                    signal: baseOpts.signal,
                });
                phaseOutputs = { [spec.name]: out };
            } else {
                // 多 agent 并行
                phaseOutputs = {};
                const results = await Promise.allSettled(agentSpecs.map(spec =>
                    _runAgent(novelId, spec.name, spec.input, {
                        phaseIndex: phaseIndexOffset + i,
                        phaseName: ph.name,
                        role: spec.role || '',
                        round: spec.round || 1,
                        chapterId: baseOpts.chapterId,
                        jobId,
                        onChunk: baseOpts.onChunk,
                    signal: baseOpts.signal,
                    }).then(out => ({ name: spec.name, out }))
                ));
                for (const r of results) {
                    if (r.status === 'fulfilled') {
                        phaseOutputs[r.value.name] = r.value.out;
                    } else {
                        // 并行中一个失败 — 把错误信息也丢进 phaseOutputs 让 phase handler 决策
                        const failedName = agentSpecs[results.indexOf(r)].name;
                        phaseOutputs[failedName] = { __error: r.reason && r.reason.message || String(r.reason) };
                    }
                }
            }

            // 把 phase outputs 写进 ctxBag.outputs[name] 给下游用
            ctxBag.outputs[ph.name] = phaseOutputs;

            _emit('phase_finished', {
                novelId, jobId, pipeline, phaseIndex: phaseIndexOffset + i,
                phaseName: ph.name, summary: ph.summary && ph.summary(phaseOutputs) || '',
            });

            // phase hook（可选）：允许 phase 在结束时检查输出决定是否中断
            if (typeof ph.onAfter === 'function') {
                const cont = await ph.onAfter(phaseOutputs, ctxBag);
                if (cont === false) break;
            }
        }

        if (ownsLifecycle) {
            _emit('pipeline_finished', { novelId, jobId, pipeline, result: ctxBag.outputs });
        }
        return ctxBag.outputs;
    } catch (e) {
        if (ownsLifecycle) {
            _emit('pipeline_failed', { novelId, jobId, pipeline, error: e.message || String(e) });
        }
        throw e;
    } finally {
        if (ownsLifecycle) _jobEnd(novelId, jobId);
    }
}

// JSON 解析助手：允许 ```json ... ``` 包裹 + 状态机修复未转义引号。
// 解析失败会自动用更高 temperature 重试一次（emit 不走 _runAgent — 由 agent 内部决定是否报事件）
//
// 中文 LLM 经常在 string value 内部用未转义的 " （如 "...的"伪神时代""），导致 JSON.parse 失败。
// 状态机思路：单遍扫描，遇到 " 时根据上下文判断是字符串边界还是字符串内嵌。
//   - inString=false 遇到 " → 进入字符串
//   - inString=true 遇到 " → 看后续非空字符
//       - , ] } : 或 EOF → 真正的字符串结束
//       - 其他（含中文 / 字母 / 数字） → 字符串内嵌引号，转义为 \"
function _tryParseJson(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text;
    let t = String(text).trim();
    // 去 ```json ... ``` 包裹
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    // 策略 1：直接尝试
    try { return JSON.parse(t); } catch {}
    // 策略 2：去掉首尾非 JSON 字符后再试（容忍前后散文）
    const trimMore = t.replace(/^[\s\S]*?(\{)/, '$1').replace(/(\})[\s\S]*$/, '$1');
    try { return JSON.parse(trimMore); } catch {}
    // 策略 3：状态机修复
    const repaired = _repairJsonStrings(t);
    try { return JSON.parse(repaired); } catch {}
    // 策略 4：抓第一个 {...} 或 [...] 块（修复后）
    const m = repaired.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    // 策略 5：尝试补全不完整的 JSON（截断场景）— 见 _tryCompleteTruncatedJson
    const completed = _tryCompleteTruncatedJson(t);
    if (completed) { try { return JSON.parse(completed); } catch {} }
    return null;
}

/**
 * Tier 2.5：尝试补全被截断的 JSON（max_tokens 截断场景）
 * 思路：状态机扫描，遇到未关闭的 { [ " 时自动补全
 * 仅在 JSON 看起来被截断（最后字符不是 } ] "）时触发
 */
function _tryCompleteTruncatedJson(text) {
    if (!text) return null;
    const trimmed = text.trim();
    // 已经完整闭合？跳过。注意：不能用 /[}\]"'\`]\s*$/ —— 字符串内部末尾的 "
    // （如 `"world_setting": "`）也会匹配，导致无法补全。只对真正的闭合符 } ] 短路。
    if (/[}\]]\s*$/.test(trimmed)) {
        // 仍交给状态机跑一遍，确保不是 `"xxx}` 这种字符串内含 } 的伪闭合
        // （_repairJsonStrings 已能处理这种情况，所以这里可以直接 return null）
        return null;
    }
    let stack = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') {
            if (!inString) inString = true;
            else {
                // 看后续判断是否真的结束
                let j = i + 1;
                while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
                const next = trimmed[j];
                if (next === undefined || next === ',' || next === ']' || next === '}' || next === ':') {
                    inString = false;
                }
                // 否则保持 inString=true（说明 " 是字符串内的）
            }
        } else if (!inString) {
            if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
            else if (c === '}' || c === ']') stack.pop();
        }
    }
    if (!stack.length && !inString) return null;  // 没有需要补全的
    // 补全
    let result = trimmed;
    // 字符串未关闭 → 补一个 "
    if (inString) result += '"';
    // 补全所有未关闭的 { [
    while (stack.length) {
        const closer = stack.pop();
        // 每次补 } 之前，清理尾部不完整的键值对
        if (closer === '}') {
            const trimmed = result.trimEnd();
            // 情况 1：结尾是 `:` → 整个键值对的 value 缺失，需要连 key 一起删
            // 情况 2：结尾是 `,` → 孤立的逗号
            if (trimmed.endsWith(':')) {
                // 从最后一个 `,`（或 `{`）之后开始截
                const lastComma = trimmed.lastIndexOf(',');
                const lastOpenBrace = trimmed.lastIndexOf('{');
                const cutStart = Math.max(lastComma, lastOpenBrace);
                if (cutStart >= 0 && cutStart > trimmed.length * 0.3) {
                    result = trimmed.slice(0, cutStart).trimEnd();
                    // 去掉孤立的 , 或 :
                    if (result.endsWith(',') || result.endsWith(':')) {
                        result = result.slice(0, -1).trimEnd();
                    }
                } else {
                    // 没有安全的截断点，整段丢弃
                    result = trimmed.slice(0, lastOpenBrace + 1);
                }
            } else if (trimmed.endsWith(',')) {
                result = trimmed.slice(0, -1).trimEnd();
            } else if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
                // 结尾是其他字符（数字、true、null 等），保持原样
            }
        }
        result += closer;
    }
    return result;
}

/**
 * 状态机修复 JSON 字符串内部未转义的 "。
 * 仅处理 LLM 在中文 string value 内部漏 escape 引号的简单场景。
 *
 * ⚠️ 局限：
 * - 不能修复 LLM 把 ASCII , : 等结构字符嵌进 string value 的情况（如 "...族印",族印..."）
 *   那种是 LLM 输出本身结构损坏，必须改 prompt 解决。
 * - 本函数只是兜底，主防线是各 agent 的 systemPrompt 强制要求 LLM 正确 escape。
 */
function _repairJsonStrings(text) {
    let inString = false;
    let escape = false;
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escape) { result += c; escape = false; continue; }
        if (c === '\\') { result += c; escape = true; continue; }
        if (c === '"') {
            if (!inString) {
                // 字符串开始
                inString = true;
                result += c;
            } else {
                // 字符串内的 "：看后续非空字符判断是边界还是内嵌
                let j = i + 1;
                while (j < text.length && /\s/.test(text[j])) j++;
                const next = text[j];
                if (next === undefined || next === ',' || next === ']' || next === '}' || next === ':') {
                    // 真正的字符串结束
                    inString = false;
                    result += c;
                } else {
                    // 字符串内嵌的非法 "，转义
                    result += '\\"';
                }
            }
        } else {
            result += c;
        }
    }
    return result;
}

// ============ JSON 防御体系 Tier 2-4 ============
// 把 _tryParseJson 包装为多策略 parser，自动调用 LLM 修复，最后兜底默认值
// 设计目标：parse 失败不可阻塞 pipeline（agent 输出一定是 object，不能 null）

/**
 * Tier 2: 多策略 JSON 解析（同步，不调 LLM）
 * @returns {object|null} 成功 → object；失败 → null
 */
function _multiStrategyParse(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text;
    const parsed1 = _tryParseJson(text);
    if (parsed1) return parsed1;
    return null;  // _tryParseJson 内部已经做了多策略尝试
}

/**
 * Tier 3: 调用 LLM 修复坏 JSON
 * @param {string} brokenText 损坏的 JSON 文本
 * @param {string} agentName agent 名字（用于日志）
 * @param {object} cfg provider 配置
 * @returns {object|null} 修复后的 object，失败 → null
 */
async function _repairJsonWithLlm(brokenText, agentName, cfg) {
    if (!cfg || !brokenText) return null;
    const sys = `你是 JSON 修复工具。把【损坏的 JSON 文本】修复为严格合法的 JSON。
【严格要求】
- 严禁修改原意，只能补全语法（补关闭的括号、引号、逗号）
- 严禁删除有效字段（即使格式略有不准也保留，用字符串包起来）
- 严禁在 string value 内部嵌入未转义引号，全部转为 \"
- 严禁任何解释/前缀/后缀，直接输出 \`\`\`json ... \`\`\` 包裹的 JSON
- 如果文本明显是大量 markdown/散文而非 JSON，返回空对象 {}`;
    const user = `【损坏的 JSON 文本】（来自 ${agentName} agent）：\n\`\`\`\n${brokenText.slice(0, 6000)}\n\`\`\`\n\n请输出修复后的 JSON（用 \`\`\`json ... \`\`\` 包裹）。`;
    try {
        const res = await novel.generate({
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: sys, user,
            temperature: 0.1, max_tokens: 8000,
        });
        const repaired = _multiStrategyParse(res.text || '');
        return repaired;
    } catch (e) {
        console.warn(`[json-defense] LLM repair failed for ${agentName}:`, e.message);
        return null;
    }
}

/**
 * Tier 4: 兜底默认值（永远不返回 null）
 * 根据 agentName 返回合理空 schema，让 pipeline 不抛错继续跑
 */
function _fallbackForAgent(agentName) {
    const fallbacks = {
        'outline-synthesizer': { structure: '', world_setting: '', main_conflict: '', themes: [], global_characters: [], chapter_list: [], __parseFailed: true, selectionRationale: 'JSON 解析失败，已使用占位数据。请重新生成。' },
        'style-analyst': { styleAttributes: [], comparableReferences: [], narrativeVoice: '', vocabularyHints: [], avoidances: [], __parseFailed: true },
        'world-architect': { candidates: [], __parseFailed: true },
        'character-architect': { candidates: [], __parseFailed: true },
        'plot-architect': { candidates: [], __parseFailed: true },
        'theme-architect': { themes: [], motifs: [], symbolicElements: [], __parseFailed: true },
        'outline-reviewer': { approved: false, score: 0, feedback: [{ issue: 'JSON 解析失败，无法评审', severity: 'critical', suggestion: '重新生成' }], __parseFailed: true },
        'scene-planner': { scenes: [], __parseFailed: true },
        'continuity-checker': { approved: true, issues: [], summary: 'JSON 解析失败，跳过审查', __parseFailed: true },
        'style-editor': { approved: true, toneScore: 0, issues: [], suggestions: '', __parseFailed: true },
        'quality-reviewer': { approved: true, score: 0, pacing: 0, grammar: 0, immersion: 0, hook: 0, feedback: 'JSON 解析失败', __parseFailed: true },
        'story-architect': { three_act: '', plot_threads: [], character_arcs: [], theme_tracks: [], foreshadowing_seed: [], __parseFailed: true },
        'character-state-updater': { updates: [], __parseFailed: true },
        'plot-thread-tracker': { threads: [], new_threads: [], __parseFailed: true },
        'foreshadowing-extractor': { planted: [], paid: [], __parseFailed: true },
    };
    return fallbacks[agentName] || { __parseFailed: true, raw: '' };
}

/**
 * 4 层 JSON 防御主入口（异步，因 Tier 3 调 LLM）
 * @param {string} text LLM 原始输出
 * @param {string} agentName
 * @param {object} cfg provider config（用于 Tier 3 LLM 修复）
 * @returns {Promise<{output: object, raw: string, parseFailed: boolean, repairMethod: string}>}
 *   永远返回 output（极端 fallback），parseFailed=true 表示走了兜底
 */
async function _safeParseAgentOutput(text, agentName, cfg) {
    const raw = text || '';
    // Tier 2: 多策略解析
    let parsed = _multiStrategyParse(raw);
    let repairMethod = parsed ? 'tier2-direct' : null;
    // Tier 3: LLM 自愈
    if (!parsed && cfg) {
        console.warn(`[json-defense] tier2 failed for ${agentName}, attempting LLM repair...`);
        parsed = await _repairJsonWithLlm(raw, agentName, cfg);
        if (parsed) repairMethod = 'tier3-llm-repair';
    }
    // Tier 4: 兜底
    if (!parsed) {
        console.error(`[json-defense] all tiers failed for ${agentName}, using fallback defaults`);
        const fb = _fallbackForAgent(agentName);
        // 把 raw 也带上，方便调试
        fb.__raw = raw.slice(0, 2000);
        return { output: fb, raw, parseFailed: true, repairMethod: 'tier4-fallback' };
    }
    return { output: parsed, raw, parseFailed: false, repairMethod };
}

// ====== Novel CRUD ======
function listNovels() {
    const rows = _store.query(
        `SELECT id, title, style, status, current_word_count, target_word_count,
                chapter_target_count, updated_at, created_at
           FROM _ainovel_novels ORDER BY updated_at DESC`
    );
    return { ok: true, novels: rows };
}

function createNovel(payload) {
    if (!payload.title || !String(payload.title).trim()) return { ok: false, error: '标题必填' };
    if (!payload.core_idea || !String(payload.core_idea).trim()) return { ok: false, error: '主旨必填' };
    const targetWords = Math.max(10000, Math.min(5000000, Number(payload.target_word_count) || 1000000));
    const id = _uuid();
    const now = _now();
    _store.exec(
        `INSERT INTO _ainovel_novels
            (id, title, style, custom_style, core_idea, pov, tone,
             target_word_count, chapter_target_count, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        String(payload.title).trim(),
        payload.style || null,
        payload.custom_style || null,
        String(payload.core_idea).trim(),
        payload.pov || null,
        payload.tone || null,
        targetWords,
        payload.chapter_target_count || null,
        'planning',
        now,
        now
    );
    _emit('novel_added', { novelId: id });
    return { ok: true, novelId: id };
}

function getNovel(novelId) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const novel = (_store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0]) || null;
    if (!novel) return { ok: false, error: '小说不存在' };
    const outline = (_store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) || null;
    const chapters = _store.query('SELECT * FROM _ainovel_chapters WHERE novel_id = ? ORDER BY chapter_no', novelId);
    return { ok: true, novel, outline, chapters };
}

function deleteNovel(novelId) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    // cascade
    _store.exec('DELETE FROM _ainovel_chapters WHERE novel_id = ?', novelId);
    _store.exec('DELETE FROM _ainovel_outlines WHERE novel_id = ?', novelId);
    _store.exec('DELETE FROM _ainovel_generations WHERE novel_id = ?', novelId);
    _store.exec('DELETE FROM _ainovel_novels WHERE id = ?', novelId);
    // Sprint H: 清理黑板 / 任务图 / 收件箱（黑板+任务在库里，inbox 是文件）
    try { _store.exec('DELETE FROM _ainovel_blackboard WHERE novel_id = ?', novelId); } catch (e) { /* 表可能不存在 */ }
    try { _store.exec('DELETE FROM _ainovel_tasks WHERE novel_id = ?', novelId); } catch (e) { /* 同上 */ }
    // Sprint 7.1: 清理 arcs
    try { _store.exec('DELETE FROM _ainovel_arcs WHERE novel_id = ?', novelId); } catch (e) { /* */ }
    try {
        const dir = _inboxDir(novelId);
        if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { console.warn('[novel-engine] 清理 inbox 目录失败:', e.message); }
    _dropBlackboardCache(novelId);
    dropContext(novelId);
    _emit('novel_removed', { novelId });
    return { ok: true };
}

// ===== Sprint 7.1: Arcs（卷）CRUD =====
// Arc = 大纲的中间层级。一卷覆盖 [start_ch, end_ch] 区间。
// 约束：所有 arc 的区间必须连续覆盖 [1, chapter_count]，没有空隙也不能超出。
function listArcs(novelId) {
    if (!_store) return [];
    const rows = _store.query('SELECT * FROM _ainovel_arcs WHERE novel_id = ? ORDER BY order_index ASC, start_ch ASC', novelId);
    return rows.map(_rowToArc);
}

function getArc(novelId, arcId) {
    if (!_store) return null;
    const row = _store.query('SELECT * FROM _ainovel_arcs WHERE id = ? AND novel_id = ?', arcId, novelId)[0];
    return row ? _rowToArc(row) : null;
}

function _rowToArc(row) {
    return {
        id: row.id,
        novelId: row.novel_id,
        title: row.title,
        goal: row.goal || '',
        startCh: row.start_ch,
        endCh: row.end_ch,
        summary: row.summary || '',
        orderIndex: row.order_index,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function createArc(novelId, payload) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!payload || !payload.title) return { ok: false, error: 'title 必填' };
    const startCh = parseInt(payload.startCh, 10);
    const endCh = parseInt(payload.endCh, 10);
    if (!Number.isFinite(startCh) || !Number.isFinite(endCh) || startCh < 1 || endCh < startCh) {
        return { ok: false, error: '章节范围无效' };
    }
    // 区间重叠校验
    const overlap = _store.query(
        `SELECT id FROM _ainovel_arcs WHERE novel_id = ? AND NOT (end_ch < ? OR start_ch > ?)`,
        novelId, startCh, endCh
    );
    if (overlap.length) return { ok: false, error: '区间与现有 arc 重叠' };
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    const orderIndex = _store.query('SELECT COALESCE(MAX(order_index), 0) + 1 AS m FROM _ainovel_arcs WHERE novel_id = ?', novelId)[0].m;
    _store.exec(
        `INSERT INTO _ainovel_arcs (id, novel_id, title, goal, start_ch, end_ch, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, novelId, payload.title, payload.goal || null, startCh, endCh, orderIndex, now, now
    );
    return { ok: true, arc: getArc(novelId, id) };
}

function updateArc(novelId, arcId, patch) {
    if (!_store) return { ok: false, error: '未初始化' };
    const arc = getArc(novelId, arcId);
    if (!arc) return { ok: false, error: 'arc 不存在' };
    const sets = [];
    const vals = [];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
    if (patch.goal !== undefined) { sets.push('goal = ?'); vals.push(patch.goal || null); }
    if (patch.summary !== undefined) { sets.push('summary = ?'); vals.push(patch.summary || null); }
    if (patch.startCh !== undefined || patch.endCh !== undefined) {
        const newStart = parseInt(patch.startCh !== undefined ? patch.startCh : arc.startCh, 10);
        const newEnd = parseInt(patch.endCh !== undefined ? patch.endCh : arc.endCh, 10);
        if (!Number.isFinite(newStart) || !Number.isFinite(newEnd) || newStart < 1 || newEnd < newStart) {
            return { ok: false, error: '章节范围无效' };
        }
        // 区间重叠校验（排除自身）
        const overlap = _store.query(
            `SELECT id FROM _ainovel_arcs WHERE novel_id = ? AND id != ? AND NOT (end_ch < ? OR start_ch > ?)`,
            novelId, arcId, newStart, newEnd
        );
        if (overlap.length) return { ok: false, error: '区间与现有 arc 重叠' };
        sets.push('start_ch = ?'); vals.push(newStart);
        sets.push('end_ch = ?'); vals.push(newEnd);
    }
    if (patch.orderIndex !== undefined) { sets.push('order_index = ?'); vals.push(parseInt(patch.orderIndex, 10) || 0); }
    if (!sets.length) return { ok: true, arc };
    sets.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000));
    vals.push(arcId);
    _store.exec(`UPDATE _ainovel_arcs SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return { ok: true, arc: getArc(novelId, arcId) };
}

function deleteArc(novelId, arcId) {
    if (!_store) return { ok: false, error: '未初始化' };
    const arc = getArc(novelId, arcId);
    if (!arc) return { ok: false, error: 'arc 不存在' };
    _store.exec('DELETE FROM _ainovel_arcs WHERE id = ?', arcId);
    return { ok: true };
}

// 调整小说的章节数（追加卷时调用）
function setNovelChapterCount(novelId, count) {
    if (!_store) return { ok: false, error: '未初始化' };
    const c = parseInt(count, 10);
    if (!Number.isFinite(c) || c < 1) return { ok: false, error: '章节数无效' };
    _store.exec(`UPDATE _ainovel_novels SET chapter_target_count = ?, updated_at = ? WHERE id = ?`,
        c, Math.floor(Date.now() / 1000), novelId);
    return { ok: true };
}

// ===== Sprint 7.2: 伏笔系统 CRUD =====
// 状态机：planted → progressing → resolved/abandoned
// 同名+同 plant_chapter 视为重复，update 而非 create
function listForeshadows(novelId, statusFilter) {
    if (!_store) return [];
    let rows;
    if (statusFilter) {
        rows = _store.query('SELECT * FROM _ainovel_foreshadows WHERE novel_id = ? AND status = ? ORDER BY plant_chapter', novelId, statusFilter);
    } else {
        rows = _store.query('SELECT * FROM _ainovel_foreshadows WHERE novel_id = ? ORDER BY plant_chapter', novelId);
    }
    return rows.map(_rowToForeshadow);
}

function _rowToForeshadow(row) {
    let events = [];
    try { events = row.events ? JSON.parse(row.events) : []; } catch (e) { events = []; }
    return {
        id: row.id,
        novelId: row.novel_id,
        name: row.name,
        description: row.description || '',
        plantChapter: row.plant_chapter,
        targetChapter: row.target_chapter || null,
        status: row.status || 'planted',
        events,
        resolution: row.resolution || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function createForeshadow(novelId, payload) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!payload || !payload.name) return { ok: false, error: 'name 必填' };
    const plantChapter = parseInt(payload.plantChapter, 10);
    if (!Number.isFinite(plantChapter) || plantChapter < 1) return { ok: false, error: 'plantChapter 必填且 >= 1' };
    // 同名 + 同 plant_chapter 视为重复
    const existing = _store.query(
        'SELECT id FROM _ainovel_foreshadows WHERE novel_id = ? AND name = ? AND plant_chapter = ?',
        novelId, payload.name, plantChapter
    );
    if (existing.length) {
        return updateForeshadow(novelId, existing[0].id, payload);
    }
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    const status = payload.status || 'planted';
    const targetChapter = payload.targetChapter ? parseInt(payload.targetChapter, 10) : null;
    _store.exec(
        `INSERT INTO _ainovel_foreshadows (id, novel_id, name, description, plant_chapter, target_chapter, status, events, resolution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, novelId, payload.name, payload.description || null, plantChapter,
        Number.isFinite(targetChapter) ? targetChapter : null,
        status, JSON.stringify(payload.events || []), payload.resolution || null, now, now
    );
    return { ok: true, foreshadow: getForeshadow(novelId, id) };
}

function getForeshadow(novelId, id) {
    if (!_store) return null;
    const row = _store.query('SELECT * FROM _ainovel_foreshadows WHERE id = ? AND novel_id = ?', id, novelId)[0];
    return row ? _rowToForeshadow(row) : null;
}

function updateForeshadow(novelId, id, patch) {
    if (!_store) return { ok: false, error: '未初始化' };
    const fs = getForeshadow(novelId, id);
    if (!fs) return { ok: false, error: 'foreshadow 不存在' };
    const sets = [];
    const vals = [];
    if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description || null); }
    if (patch.targetChapter !== undefined) {
        const tc = patch.targetChapter ? parseInt(patch.targetChapter, 10) : null;
        sets.push('target_chapter = ?'); vals.push(Number.isFinite(tc) ? tc : null);
    }
    if (patch.status !== undefined && ['planted', 'progressing', 'resolved', 'abandoned'].includes(patch.status)) {
        sets.push('status = ?'); vals.push(patch.status);
    }
    if (patch.events !== undefined) {
        sets.push('events = ?'); vals.push(JSON.stringify(patch.events || []));
    }
    if (patch.resolution !== undefined) {
        sets.push('resolution = ?'); vals.push(patch.resolution || null);
    }
    if (!sets.length) return { ok: true, foreshadow: fs };
    sets.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000));
    vals.push(id);
    _store.exec(`UPDATE _ainovel_foreshadows SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return { ok: true, foreshadow: getForeshadow(novelId, id) };
}

function deleteForeshadow(novelId, id) {
    if (!_store) return { ok: false, error: '未初始化' };
    _store.exec('DELETE FROM _ainovel_foreshadows WHERE id = ?', id);
    return { ok: true };
}

/**
 * 添加一个事件到伏笔生命周期。
 * 如果事件 chapter >= targetChapter 且 status='planted' → 自动推进到 'progressing'
 */
function pushForeshadowEvent(novelId, id, evt) {
    const fs = getForeshadow(novelId, id);
    if (!fs) return { ok: false, error: 'foreshadow 不存在' };
    const ev = { chapter: parseInt(evt.chapter, 10), note: String(evt.note || ''), created_at: Math.floor(Date.now() / 1000) };
    const events = fs.events.concat([ev]);
    const patch = { events };
    if (fs.status === 'planted' && fs.targetChapter && ev.chapter >= fs.targetChapter) {
        patch.status = 'progressing';
    }
    return updateForeshadow(novelId, id, patch);
}

/**
 * 标记伏笔为已解决（resolved）
 */
function resolveForeshadow(novelId, id, resolution) {
    return updateForeshadow(novelId, id, { status: 'resolved', resolution: resolution || '' });
}

/**
 * 批量采纳 AI 建议的伏笔列表
 */
function bulkAdoptForeshadows(novelId, items) {
    const adopted = [];
    const errors = [];
    for (const it of (items || [])) {
        const r = createForeshadow(novelId, it);
        if (r.ok) adopted.push(r.foreshadow);
        else errors.push({ item: it, error: r.error });
    }
    return { ok: true, adopted, errors };
}

/**
 * 生成 Foreshadows.md 路线图
 */
function generateForeshadowRoadmap(novelId) {
    const list = listForeshadows(novelId);
    if (!list.length) return '# 伏笔路线图\n\n（暂无伏笔）\n';
    const groups = { planted: [], progressing: [], resolved: [], abandoned: [] };
    for (const f of list) groups[f.status].push(f);
    const lines = ['# 伏笔路线图', ''];
    const render = (label, items) => {
        if (!items.length) return;
        lines.push(`## ${label}（${items.length}）`);
        for (const f of items) {
            lines.push(`- **${f.name}**（埋设 第 ${f.plantChapter} 章${f.targetChapter ? ' / 预计回收 第 ' + f.targetChapter + ' 章' : ''}）`);
            if (f.description) lines.push(`  - ${f.description}`);
            if (f.resolution) lines.push(`  - **回收**：${f.resolution}`);
        }
        lines.push('');
    };
    render('已埋设（planted）', groups.planted);
    render('进行中（progressing）', groups.progressing);
    render('已回收（resolved）', groups.resolved);
    render('已放弃（abandoned）', groups.abandoned);
    return lines.join('\n');
}

// ===== Sprint 7.3: 叙事记忆 CRUD =====
// 每条记忆是"章后提取的关键细节"，按 importance 注入到 system prompt
function listMemory(novelId, opts = {}) {
    if (!_store) return [];
    const { minImportance, maxImportance, category, chapter, limit } = opts;
    const conds = ['novel_id = ?'];
    const params = [novelId];
    if (Number.isFinite(minImportance)) { conds.push('importance >= ?'); params.push(minImportance); }
    if (Number.isFinite(maxImportance)) { conds.push('importance <= ?'); params.push(maxImportance); }
    if (category) { conds.push('category = ?'); params.push(category); }
    if (Number.isFinite(chapter)) { conds.push('chapter = ?'); params.push(chapter); }
    let sql = `SELECT * FROM _ainovel_memory_entries WHERE ${conds.join(' AND ')} ORDER BY importance DESC, chapter ASC`;
    if (Number.isFinite(limit)) sql += ` LIMIT ${parseInt(limit, 10)}`;
    return _store.query(sql, ...params).map(_rowToMemory);
}

function _rowToMemory(row) {
    return {
        id: row.id,
        novelId: row.novel_id,
        content: row.content,
        category: row.category || 'other',
        chapter: row.chapter,
        position: row.position || null,
        snippet: row.snippet || '',
        importance: row.importance || 5,
        createdAt: row.created_at,
    };
}

function createMemory(novelId, payload) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!payload || !payload.content) return { ok: false, error: 'content 必填' };
    const chapter = parseInt(payload.chapter, 10);
    if (!Number.isFinite(chapter) || chapter < 1) return { ok: false, error: 'chapter 必填且 >= 1' };
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    const importance = Number.isFinite(payload.importance) ? Math.max(1, Math.min(10, payload.importance)) : 5;
    _store.exec(
        `INSERT INTO _ainovel_memory_entries (id, novel_id, content, category, chapter, position, snippet, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, novelId, payload.content, payload.category || 'other',
        chapter, payload.position || null, (payload.snippet || '').slice(0, 200),
        importance, now
    );
    return { ok: true, memory: getMemory(novelId, id) };
}

function getMemory(novelId, id) {
    if (!_store) return null;
    const row = _store.query('SELECT * FROM _ainovel_memory_entries WHERE id = ? AND novel_id = ?', id, novelId)[0];
    return row ? _rowToMemory(row) : null;
}

function updateMemory(novelId, id, patch) {
    if (!_store) return { ok: false, error: '未初始化' };
    const mem = getMemory(novelId, id);
    if (!mem) return { ok: false, error: 'memory 不存在' };
    const sets = [];
    const vals = [];
    if (patch.content !== undefined) { sets.push('content = ?'); vals.push(patch.content); }
    if (patch.category !== undefined) { sets.push('category = ?'); vals.push(patch.category); }
    if (patch.snippet !== undefined) { sets.push('snippet = ?'); vals.push(patch.snippet.slice(0, 200)); }
    if (patch.importance !== undefined) {
        sets.push('importance = ?'); vals.push(Math.max(1, Math.min(10, patch.importance)));
    }
    if (!sets.length) return { ok: true, memory: mem };
    vals.push(id);
    _store.exec(`UPDATE _ainovel_memory_entries SET ${sets.join(', ')} WHERE id = ?`, ...vals);
    return { ok: true, memory: getMemory(novelId, id) };
}

function deleteMemory(novelId, id) {
    if (!_store) return { ok: false, error: '未初始化' };
    _store.exec('DELETE FROM _ainovel_memory_entries WHERE id = ?', id);
    return { ok: true };
}

/**
 * token 预算：根据章节数动态计算
 * 参考 AiXiaoShuo: max(2000, min(20000, chapters * 1000))
 */
function calcMemoryMaxTokens(novelId) {
    const novel = getNovel(novelId);
    if (!novel || !novel.ok) return 4000;
    const ch = novel.novel.chapter_target_count || 30;
    return Math.max(2000, Math.min(20000, ch * 1000));
}

/**
 * 把 memory 列表格式化为注入到 system prompt 的字符串
 * 按 importance DESC 排序，按 maxTokens 截断
 */
function renderMemoryForInjection(novelId, maxTokens) {
    if (!_store) return '';
    const budget = maxTokens || calcMemoryMaxTokens(novelId);
    // 1 token ≈ 2 个中文字符 ≈ 4 字节。预算按字符粗估：budget * 2 chars
    const maxChars = budget * 2;
    const list = listMemory(novelId);
    const lines = [];
    let used = 0;
    for (const m of list) {
        // 格式：[第X章|imp=Y|cat=...] content  (原文："snippet前80字")
        const head = `[第${m.chapter}章|imp=${m.importance}|cat=${m.category}] `;
        const tail = m.snippet ? ` (原文："${m.snippet.slice(0, 80)}")` : '';
        const line = head + m.content + tail;
        if (used + line.length > maxChars) {
            // 截断这条本身
            const room = Math.max(0, maxChars - used - head.length - 5);
            if (room < 20) break;
            lines.push(head + m.content.slice(0, room) + '...');
            used = maxChars;
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join('\n');
}

// ====== Sprint 8.2: 写作冲突（事实核查自动重写耗尽时落盘）======
// 当 continuity-checker 在 max retries 后仍失败时，调用 saveWritingConflict 持久化
// 报告（包含 issues 数组、尝试次数等），不再强制将章节标记为 done。
// 前端通过 SSE 事件 writing_conflict 收到通知，弹出冲突面板让用户决策。
function _rowToConflict(row) {
    if (!row) return null;
    let report = null;
    try { report = row.report ? JSON.parse(row.report) : null; } catch (e) { report = { __parseFailed: true, raw: row.report }; }
    return {
        id: row.id,
        novelId: row.novel_id,
        chapterId: row.chapter_id,
        chapterNo: row.chapter_no,
        report,
        attempts: row.attempts || 1,
        userAction: row.user_action || null,
        resolvedAt: row.resolved_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function saveWritingConflict(novelId, chapterId, report, attempts) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!novelId || !chapterId) return { ok: false, error: 'novelId / chapterId 必填' };
    const chapterRow = _store.query('SELECT chapter_no FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0];
    const chapterNo = chapterRow ? chapterRow.chapter_no : null;
    // 同章节已有未处理冲突则 update（避免堆积）
    const existing = _store.query(
        `SELECT id FROM _ainovel_writing_conflicts WHERE novel_id = ? AND chapter_id = ? AND user_action IS NULL LIMIT 1`,
        novelId, chapterId
    )[0];
    const now = Math.floor(Date.now() / 1000);
    const reportJson = JSON.stringify(report || {});
    const att = Number.isFinite(attempts) ? attempts : 1;
    if (existing) {
        _store.exec(
            `UPDATE _ainovel_writing_conflicts SET report = ?, attempts = ?, updated_at = ? WHERE id = ?`,
            reportJson, att, now, existing.id
        );
        const r = _store.query(`SELECT * FROM _ainovel_writing_conflicts WHERE id = ?`, existing.id)[0];
        return { ok: true, conflict: _rowToConflict(r), updated: true };
    }
    const id = _uuid();
    _store.exec(
        `INSERT INTO _ainovel_writing_conflicts (id, novel_id, chapter_id, chapter_no, report, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, novelId, chapterId, chapterNo, reportJson, att, now, now
    );
    const row = _store.query(`SELECT * FROM _ainovel_writing_conflicts WHERE id = ?`, id)[0];
    return { ok: true, conflict: _rowToConflict(row) };
}

function listWritingConflicts(novelId, opts = {}) {
    if (!_store) return [];
    const onlyOpen = opts.onlyOpen !== false; // 默认只返回未处理冲突
    const rows = onlyOpen
        ? _store.query(
            `SELECT * FROM _ainovel_writing_conflicts WHERE novel_id = ? AND user_action IS NULL ORDER BY created_at DESC`,
            novelId
        )
        : _store.query(
            `SELECT * FROM _ainovel_writing_conflicts WHERE novel_id = ? ORDER BY created_at DESC LIMIT 100`,
            novelId
        );
    return rows.map(_rowToConflict);
}

function getWritingConflict(conflictId) {
    if (!_store) return null;
    const row = _store.query(`SELECT * FROM _ainovel_writing_conflicts WHERE id = ?`, conflictId)[0];
    return row ? _rowToConflict(row) : null;
}

function getOpenConflictForChapter(novelId, chapterId) {
    if (!_store) return null;
    const row = _store.query(
        `SELECT * FROM _ainovel_writing_conflicts WHERE novel_id = ? AND chapter_id = ? AND user_action IS NULL ORDER BY created_at DESC LIMIT 1`,
        novelId, chapterId
    )[0];
    return row ? _rowToConflict(row) : null;
}

// 标记冲突为已处理。action: retry / force_review / modify_outline / modify_foreshadow / dismiss
function resolveWritingConflict(conflictId, action) {
    if (!_store) return { ok: false, error: '未初始化' };
    const VALID = ['retry', 'force_review', 'modify_outline', 'modify_foreshadow', 'dismiss'];
    if (!VALID.includes(action)) return { ok: false, error: '无效 action: ' + action };
    const row = _store.query(`SELECT * FROM _ainovel_writing_conflicts WHERE id = ?`, conflictId)[0];
    if (!row) return { ok: false, error: '冲突不存在' };
    if (row.user_action) return { ok: false, error: '冲突已处理', conflict: _rowToConflict(row) };
    const now = Math.floor(Date.now() / 1000);
    _store.exec(
        `UPDATE _ainovel_writing_conflicts SET user_action = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
        action, now, now, conflictId
    );
    // Resolving a report does not bypass chapter review and state persistence.
    const updated = _store.query(`SELECT * FROM _ainovel_writing_conflicts WHERE id = ?`, conflictId)[0];
    _emit('writing_conflict_resolved', {
        novelId: row.novel_id, chapterId: row.chapter_id, conflictId, action,
    });
    return { ok: true, conflict: _rowToConflict(updated) };
}

// 重试前清掉旧冲突（让 saveWritingConflict 能重新插入）
function clearWritingConflicts(novelId, chapterId) {
    if (!_store) return 0;
    const before = _store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_writing_conflicts WHERE novel_id = ? AND chapter_id = ?`,
        novelId, chapterId
    )[0].c;
    _store.exec(
        `DELETE FROM _ainovel_writing_conflicts WHERE novel_id = ? AND chapter_id = ? AND user_action IS NULL`,
        novelId, chapterId
    );
    return before;
}

// ====== Sprint 8.3: 关系图谱（character/organization/worldview 间关系）======
// 由 relation-extractor skill 从章节正文推断 + 用户手动编辑。
// 用于力导向 Canvas 图谱渲染：节点 = entity，边 = relation。
const VALID_REL_TYPES = ['character', 'organization', 'worldview'];

function _rowToRelation(row) {
    if (!row) return null;
    return {
        id: row.id,
        novelId: row.novel_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceName: row.source_name || '',
        targetType: row.target_type,
        targetId: row.target_id,
        targetName: row.target_name || '',
        label: row.label || '',
        strength: row.strength || 5,
        source: row.source || 'manual',
        chapterNo: row.chapter_no || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function listRelations(novelId, opts = {}) {
    if (!_store) return [];
    let q = `SELECT * FROM _ainovel_relations WHERE novel_id = ?`;
    const params = [novelId];
    if (opts.sourceType) { q += ` AND source_type = ?`; params.push(opts.sourceType); }
    if (opts.targetType) { q += ` AND target_type = ?`; params.push(opts.targetType); }
    q += ` ORDER BY strength DESC, created_at DESC`;
    const rows = _store.query(q, ...params);
    return rows.map(_rowToRelation);
}

function getRelation(id) {
    if (!_store) return null;
    const row = _store.query(`SELECT * FROM _ainovel_relations WHERE id = ?`, id)[0];
    return row ? _rowToRelation(row) : null;
}

function createRelation(novelId, payload) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const required = ['sourceType', 'sourceId', 'targetType', 'targetId'];
    for (const f of required) {
        if (!payload || !payload[f]) return { ok: false, error: `${f} 必填` };
    }
    if (!VALID_REL_TYPES.includes(payload.sourceType)) return { ok: false, error: 'sourceType 必须是 character/organization/worldview' };
    if (!VALID_REL_TYPES.includes(payload.targetType)) return { ok: false, error: 'targetType 必须是 character/organization/worldview' };
    if (payload.sourceType === payload.targetType && payload.sourceId === payload.targetId) {
        return { ok: false, error: '源和目标不能是同一实体' };
    }
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    const strength = Number.isFinite(payload.strength) ? Math.max(1, Math.min(10, payload.strength)) : 5;
    const source = payload.source || 'manual';
    const chapterNo = Number.isFinite(payload.chapterNo) ? payload.chapterNo : null;
    try {
        _store.exec(
            `INSERT INTO _ainovel_relations (id, novel_id, source_type, source_id, source_name, target_type, target_id, target_name, label, strength, source, chapter_no, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, novelId,
            payload.sourceType, payload.sourceId, payload.sourceName || '',
            payload.targetType, payload.targetId, payload.targetName || '',
            payload.label || '', strength, source, chapterNo, now, now
        );
    } catch (e) {
        // UNIQUE 冲突：相同 (novel, source_type, source_id, target_type, target_id, label) 已存在
        if (String(e.message).includes('UNIQUE')) {
            // 改 update（强化 strength 等）
            const existing = _store.query(
                `SELECT id FROM _ainovel_relations WHERE novel_id = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND label = ?`,
                novelId, payload.sourceType, payload.sourceId, payload.targetType, payload.targetId, payload.label || ''
            )[0];
            if (existing) {
                _store.exec(
                    `UPDATE _ainovel_relations SET strength = ?, source_name = COALESCE(?, source_name), target_name = COALESCE(?, target_name), source = ?, chapter_no = ?, updated_at = ? WHERE id = ?`,
                    strength, payload.sourceName || null, payload.targetName || null, source, chapterNo, now, existing.id
                );
                const row = _store.query(`SELECT * FROM _ainovel_relations WHERE id = ?`, existing.id)[0];
                return { ok: true, relation: _rowToRelation(row), updated: true };
            }
        }
        return { ok: false, error: e.message };
    }
    const row = _store.query(`SELECT * FROM _ainovel_relations WHERE id = ?`, id)[0];
    return { ok: true, relation: _rowToRelation(row) };
}

function updateRelation(id, patch) {
    if (!_store) return { ok: false, error: '未初始化' };
    const row = _store.query(`SELECT * FROM _ainovel_relations WHERE id = ?`, id)[0];
    if (!row) return { ok: false, error: '关系不存在' };
    const fields = [];
    const vals = [];
    const allowed = ['label', 'strength', 'sourceName', 'targetName'];
    for (const f of allowed) {
        if (patch[f] !== undefined) {
            const col = f === 'sourceName' ? 'source_name' : (f === 'targetName' ? 'target_name' : f);
            fields.push(`${col} = ?`);
            if (f === 'strength') {
                vals.push(Math.max(1, Math.min(10, Number(patch[f]) || 5)));
            } else {
                vals.push(patch[f]);
            }
        }
    }
    if (!fields.length) return { ok: false, error: 'patch 为空' };
    fields.push('updated_at = ?');
    vals.push(Math.floor(Date.now() / 1000));
    vals.push(id);
    _store.exec(`UPDATE _ainovel_relations SET ${fields.join(', ')} WHERE id = ?`, ...vals);
    const updated = _store.query(`SELECT * FROM _ainovel_relations WHERE id = ?`, id)[0];
    return { ok: true, relation: _rowToRelation(updated) };
}

function deleteRelation(id) {
    if (!_store) return { ok: false, error: '未初始化' };
    const r = _store.query(`SELECT id FROM _ainovel_relations WHERE id = ?`, id)[0];
    if (!r) return { ok: false, error: '关系不存在' };
    _store.exec(`DELETE FROM _ainovel_relations WHERE id = ?`, id);
    return { ok: true };
}

// 批量从 AI 推断结果入库（重复则 update 而非报错）
function bulkAdoptRelations(novelId, items) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!Array.isArray(items)) return { ok: false, error: 'items 必须是数组' };
    const adopted = [];
    const failed = [];
    for (const item of items) {
        const r = createRelation(novelId, Object.assign({ source: 'ai-inferred' }, item));
        if (r.ok) adopted.push(r.relation);
        else failed.push({ item, error: r.error });
    }
    return { ok: true, adopted: adopted.length, failed: failed.length, errors: failed };
}

// ====== Sprint 9.1: AI 助理 chat 会话 CRUD ======
function _rowToChatSession(row) {
    if (!row) return null;
    let messages = [];
    try { messages = row.messages ? JSON.parse(row.messages) : []; } catch (e) { messages = []; }
    return {
        id: row.id,
        novelId: row.novel_id,
        title: row.title || '',
        status: row.status || 'active',
        messages,
        totalTokens: row.total_tokens || 0,
        totalCostUsd: row.total_cost_usd || 0,
        lastMessageAt: row.last_message_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function listChatSessions(novelId) {
    if (!_store) return [];
    const rows = _store.query(
        `SELECT * FROM _ainovel_chat_sessions WHERE novel_id = ? ORDER BY COALESCE(last_message_at, updated_at) DESC`,
        novelId
    );
    return rows.map(_rowToChatSession);
}

function createChatSession(novelId, title) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    _store.exec(
        `INSERT INTO _ainovel_chat_sessions (id, novel_id, title, messages, status, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, '[]', 'active', ?, ?, ?)`,
        id, novelId, title || '新会话', now, now, now
    );
    const row = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, id)[0];
    return { ok: true, session: _rowToChatSession(row) };
}

function getChatSession(sessionId) {
    if (!_store) return null;
    const row = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    return row ? _rowToChatSession(row) : null;
}

function deleteChatSession(sessionId) {
    if (!_store) return { ok: false, error: '未初始化' };
    const r = _store.query(`SELECT id FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    if (!r) return { ok: false, error: '会话不存在' };
    _store.exec(`DELETE FROM _ainovel_chat_sessions WHERE id = ?`, sessionId);
    return { ok: true };
}

function appendChatMessage(sessionId, message) {
    if (!_store) return { ok: false, error: '未初始化' };
    const row = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    if (!row) return { ok: false, error: '会话不存在' };
    let messages = [];
    try { messages = row.messages ? JSON.parse(row.messages) : []; } catch (e) { messages = []; }
    if (!message || !message.role) return { ok: false, error: 'message.role 必填' };
    const stamped = Object.assign({
        ts: Math.floor(Date.now() / 1000),
    }, message);
    messages.push(stamped);
    const now = Math.floor(Date.now() / 1000);
    _store.exec(
        `UPDATE _ainovel_chat_sessions SET messages = ?, last_message_at = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(messages), now, now, sessionId
    );
    return { ok: true, message: stamped, messagesCount: messages.length };
}

function updateChatSession(sessionId, patch) {
    if (!_store) return { ok: false, error: '未初始化' };
    const row = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    if (!row) return { ok: false, error: '会话不存在' };
    const fields = [];
    const vals = [];
    if (patch.title !== undefined) { fields.push('title = ?'); vals.push(patch.title); }
    if (patch.status !== undefined) { fields.push('status = ?'); vals.push(patch.status); }
    if (patch.totalTokens !== undefined) { fields.push('total_tokens = ?'); vals.push(patch.totalTokens); }
    if (patch.totalCostUsd !== undefined) { fields.push('total_cost_usd = ?'); vals.push(patch.totalCostUsd); }
    if (!fields.length) return { ok: false, error: 'patch 为空' };
    fields.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000));
    vals.push(sessionId);
    _store.exec(`UPDATE _ainovel_chat_sessions SET ${fields.join(', ')} WHERE id = ?`, ...vals);
    const updated = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    return { ok: true, session: _rowToChatSession(updated) };
}

// 截断消息历史（保留 system + 最近 N 条）
function trimChatHistory(sessionId, maxMessages) {
    if (!_store) return { ok: false, error: '未初始化' };
    const row = _store.query(`SELECT * FROM _ainovel_chat_sessions WHERE id = ?`, sessionId)[0];
    if (!row) return { ok: false, error: '会话不存在' };
    let messages = [];
    try { messages = row.messages ? JSON.parse(row.messages) : []; } catch (e) { messages = []; }
    if (messages.length <= maxMessages) return { ok: true, trimmed: 0 };
    const system = messages.filter(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    const kept = others.slice(-Math.max(0, maxMessages - system.length));
    const finalMessages = system.concat(kept);
    _store.exec(`UPDATE _ainovel_chat_sessions SET messages = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(finalMessages), Math.floor(Date.now() / 1000), sessionId);
    return { ok: true, trimmed: messages.length - finalMessages.length, messagesCount: finalMessages.length };
}

// ====== Sprint 9.1: AI 助理 Agent Loop ======
// 接收 user message → 调用 LLM（带工具）→ 处理 tool_calls → 循环至 final answer
// 每次调用通过 _recordGeneration 记账；通过 _emit('chat_*') 推送 SSE 事件

let _agentLoop = null;
function _getAgentLoop() {
    if (!_agentLoop) {
        // Lazy load 避免循环依赖
        const { AgentLoop } = require('./orchestrator/agent-loop');
        // 把内部 _store 暴露给 engine，让 chat-tools 可以直接 query 章节/伏笔等表
        const engineWithStore = Object.assign({}, module.exports, { _store, getStore: () => _store });
        _agentLoop = new AgentLoop({
            novel,
            engine: engineWithStore,
            getProviderConfig: () => {
                const r = getProviderConfig();
                return r && r.config ? r.config : null;
            },
            _emit,
            _recordGeneration,
        });
    }
    return _agentLoop;
}

async function sendChatMessage(sessionId, userMessage, opts = {}) {
    if (!_store) return { ok: false, error: '未初始化' };
    const session = getChatSession(sessionId);
    if (!session) return { ok: false, error: '会话不存在' };
    const loop = _getAgentLoop();
    return loop.run(sessionId, userMessage, opts || {});
}

// ====== Sprint 9.2: 配置变更（AI 改已填字段时的待确认清单） ======
function _rowToConfigChange(row) {
    if (!row) return null;
    return {
        id: row.id,
        novelId: row.novel_id,
        field: row.field,
        currentValue: row.current_value || '',
        proposedValue: row.proposed_value || '',
        reason: row.reason || '',
        status: row.status || 'pending',
        source: row.source || 'chat-agent',
        createdAt: row.created_at,
        resolvedAt: row.resolved_at || null,
    };
}

function listPendingConfigChanges(novelId, opts = {}) {
    if (!_store) return [];
    let q = `SELECT * FROM _ainovel_pending_config_changes WHERE novel_id = ?`;
    const params = [novelId];
    if (opts.status) { q += ` AND status = ?`; params.push(opts.status); }
    else { q += ` AND status = 'pending'`; }
    q += ` ORDER BY created_at DESC LIMIT 100`;
    const rows = _store.query(q, ...params);
    return rows.map(_rowToConfigChange);
}

function createPendingConfigChange(novelId, payload) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!novelId || !payload || !payload.field || payload.proposedValue === undefined) {
        return { ok: false, error: 'novelId/field/proposedValue 必填' };
    }
    const id = _uuid();
    const now = Math.floor(Date.now() / 1000);
    _store.exec(
        `INSERT INTO _ainovel_pending_config_changes (id, novel_id, field, current_value, proposed_value, reason, status, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id, novelId, payload.field, payload.currentValue || null, String(payload.proposedValue), payload.reason || '', payload.source || 'chat-agent', now
    );
    const row = _store.query(`SELECT * FROM _ainovel_pending_config_changes WHERE id = ?`, id)[0];
    _emit('config_change_proposed', { novelId, change: _rowToConfigChange(row) });
    return { ok: true, change: _rowToConfigChange(row) };
}

function resolveConfigChange(changeId, action) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!['accepted', 'dismissed'].includes(action)) return { ok: false, error: 'action 必须 accepted 或 dismissed' };
    const row = _store.query(`SELECT * FROM _ainovel_pending_config_changes WHERE id = ?`, changeId)[0];
    if (!row) return { ok: false, error: '变更不存在' };
    if (row.status !== 'pending') return { ok: false, error: '已处理', change: _rowToConfigChange(row) };
    const now = Math.floor(Date.now() / 1000);
    _store.exec(
        `UPDATE _ainovel_pending_config_changes SET status = ?, resolved_at = ? WHERE id = ?`,
        action, now, changeId
    );
    const updated = _store.query(`SELECT * FROM _ainovel_pending_config_changes WHERE id = ?`, changeId)[0];
    _emit('config_change_resolved', { novelId: row.novel_id, changeId, action });
    return { ok: true, change: _rowToConfigChange(updated) };
}

// 批量接受（applyChanges 一次性应用）
function applyConfigChanges(novelId, ids) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'ids 必填' };
    const accepted = [];
    const failed = [];
    for (const id of ids) {
        const row = _store.query(`SELECT * FROM _ainovel_pending_config_changes WHERE id = ?`, id)[0];
        if (!row || row.novel_id !== novelId || row.status !== 'pending') {
            failed.push({ id, error: '无效或已处理' });
            continue;
        }
        // 真正改 novels / outlines
        let applyOk = true, applyErr = null;
        try {
            if (row.field === 'title' || row.field === 'type' || row.field === 'writing_style' || row.field === 'writing_pov' || row.field === 'core_idea') {
                const col = row.field === 'writing_style' ? 'custom_style' : (row.field === 'core_idea' ? 'core_idea' : row.field);
                _store.exec(`UPDATE _ainovel_novels SET ${col} = ?, updated_at = ? WHERE id = ?`, row.proposed_value, Math.floor(Date.now() / 1000), novelId);
            } else if (['structure', 'world_setting', 'main_conflict', 'themes', 'story_synopsis'].includes(row.field)) {
                _store.exec(`UPDATE _ainovel_outlines SET ${row.field} = ?, updated_at = ? WHERE novel_id = ?`, row.proposed_value, Math.floor(Date.now() / 1000), novelId);
            } else {
                applyOk = false;
                applyErr = '未知字段：' + row.field;
            }
        } catch (e) {
            applyOk = false;
            applyErr = e.message;
        }
        if (applyOk) {
            _store.exec(
                `UPDATE _ainovel_pending_config_changes SET status = 'accepted', resolved_at = ? WHERE id = ?`,
                Math.floor(Date.now() / 1000), id
            );
            accepted.push(id);
        } else {
            failed.push({ id, error: applyErr });
        }
    }
    if (accepted.length) {
        _emit('config_changes_applied', { novelId, acceptedIds: accepted });
    }
    return { ok: true, accepted, failed };
}

function dismissConfigChanges(novelId, ids) {
    if (!_store) return { ok: false, error: '未初始化' };
    const now = Math.floor(Date.now() / 1000);
    if (!ids || !Array.isArray(ids) || !ids.length) {
        // ids 为空 → dismiss 该 novel 所有 pending
        _store.exec(
            `UPDATE _ainovel_pending_config_changes SET status = 'dismissed', resolved_at = ? WHERE novel_id = ? AND status = 'pending'`,
            now, novelId
        );
        return { ok: true, dismissedAll: true };
    }
    const placeholders = ids.map(() => '?').join(',');
    _store.exec(
        `UPDATE _ainovel_pending_config_changes SET status = 'dismissed', resolved_at = ? WHERE novel_id = ? AND id IN (${placeholders}) AND status = 'pending'`,
        now, novelId, ...ids
    );
    return { ok: true, dismissedIds: ids };
}

/**
 * 校验 arc 集合是否连续覆盖 [1, chapter_count]
 * 返回 { ok, gaps, overflow, coverage }：gaps=[未覆盖区间], overflow=[超出区间], coverage=已覆盖比例
 */
function validateArcs(novelId, chapterCount) {
    if (!chapterCount || chapterCount < 1) return { ok: false, error: 'chapterCount 必填' };
    const arcs = listArcs(novelId);
    const covered = new Set();
    let overflow = [];
    for (const a of arcs) {
        for (let c = a.startCh; c <= a.endCh; c++) {
            if (c > chapterCount) overflow.push({ arc: a.id, ch: c });
            else covered.add(c);
        }
    }
    const gaps = [];
    for (let c = 1; c <= chapterCount; c++) {
        if (!covered.has(c)) gaps.push(c);
    }
    return {
        ok: gaps.length === 0 && overflow.length === 0,
        gaps,
        overflow,
        coverage: covered.size / chapterCount,
        arcs: arcs.length,
    };
}

/**
 * 强校验 + 自动修正：合并相邻 arc 或重排尾卷，确保连续覆盖 [1, chapterCount]。
 * 用于 arc-skeleton 写入前的兜底。
 */
function _normalizeArcs(novelId, chapterCount, desiredArcs) {
    // 1. 先清空该 novel 现有 arcs
    _store.exec('DELETE FROM _ainovel_arcs WHERE novel_id = ?', novelId);
    // 2. 按 desiredArcs 顺序写入
    let order = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const a of desiredArcs) {
        const id = a.id || _uuid();
        _store.exec(
            `INSERT INTO _ainovel_arcs (id, novel_id, title, goal, start_ch, end_ch, order_index, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, novelId, a.title || `卷 ${order + 1}`, a.goal || null,
            a.startCh, a.endCh, order++, now, now
        );
    }
    // 3. 校验
    const v = validateArcs(novelId, chapterCount);
    if (!v.ok) {
        console.warn(`[arcs] normalize 仍不连续: gaps=${JSON.stringify(v.gaps)} overflow=${JSON.stringify(v.overflow)}`);
    }
    return listArcs(novelId);
}

function updateOutline(novelId, patch) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const existing = (_store.query('SELECT novel_id FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) || null;
    const fields = ['structure', 'world_setting', 'main_conflict', 'themes', 'global_characters', 'chapter_list', 'raw_outline'];
    const sets = [];
    const vals = [];
    for (const f of fields) {
        if (patch && patch[f] !== undefined) {
            sets.push(`${f} = ?`);
            vals.push(typeof patch[f] === 'object' ? JSON.stringify(patch[f]) : patch[f]);
        }
    }
    if (!sets.length) return { ok: false, error: 'patch 为空' };
    sets.push('user_edited = 1');
    sets.push('updated_at = ?');
    vals.push(_now());
    if (existing) {
        _store.exec(`UPDATE _ainovel_outlines SET ${sets.join(', ')} WHERE novel_id = ?`, ...vals, novelId);
    } else {
        _store.exec(
            `INSERT INTO _ainovel_outlines (novel_id, ${fields.filter(f => patch[f] !== undefined).map(f => f).join(', ')}, user_edited, updated_at)
             SELECT ?, ${fields.filter(f => patch[f] !== undefined).map(() => '?').join(', ')}, 1, ?
             WHERE NOT EXISTS (SELECT 1 FROM _ainovel_outlines WHERE novel_id = ?)`,
            novelId, ...fields.filter(f => patch[f] !== undefined).map(f =>
                typeof patch[f] === 'object' ? JSON.stringify(patch[f]) : patch[f]
            ), _now(), novelId
        );
    }
    _store.exec(`UPDATE _ainovel_chapters SET continuity_dirty = 1, draft_meta = NULL WHERE novel_id = ? AND status = 'done'`, novelId);
    dropContext(novelId); // 让下次 load 重新拉
    _emit('outline_updated', { novelId });
    return { ok: true };
}

function updateChapter(novelId, chapterId, patch) {
    if (!novelId || !chapterId) return { ok: false, error: 'novelId / chapterId 必填' };
    const row = (_store.query('SELECT * FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0]) || null;
    if (!row) return { ok: false, error: '章节不存在' };

    const newContent = patch.content !== undefined ? patch.content : row.content;
    const newTitle = patch.title !== undefined ? patch.title : row.title;
    const newWordCount = newContent ? _countWords(newContent) : row.actual_word_count;

    _store.exec(
        `UPDATE _ainovel_chapters SET title = ?, content = ?, actual_word_count = ?, user_edited = 1, updated_at = ? WHERE id = ?`,
        newTitle,
        newContent,
        newWordCount,
        _now(),
        chapterId
    );

    // Sprint 6.1: 同步 blocks（若 content 变化）
    if (patch.content !== undefined && newContent !== row.content) {
        try {
            _syncChapterBlocks(novelId, chapterId, newContent || '');
        } catch (e) {
            console.error('[updateChapter] _syncChapterBlocks 失败:', e.message);
        }
    }

    if (patch.content !== undefined && newContent !== row.content) _invalidateChapterContinuity(novelId, chapterId);
    // 重新统计小说的 current_word_count
    const total = (_store.query(
        `SELECT COALESCE(SUM(actual_word_count), 0) AS total FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
        novelId
    )[0]).total;
    _store.exec(`UPDATE _ainovel_novels SET current_word_count = ?, updated_at = ? WHERE id = ?`, total, _now(), novelId);

    dropContext(novelId);
    _emit('chapter_updated', { novelId, chapterId });
    return { ok: true };
}

function _countWords(text) {
    if (!text) return 0;
    // 中文字数 + 英文单词数
    const cnChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enWords = (text.match(/[A-Za-z]+/g) || []).length;
    const otherChars = text.length - cnChars - enWords;
    return cnChars + enWords + Math.ceil(otherChars / 3);
}

// ====== Sprint 6.1: Block 模型工具函数 ======
// fnv-1a 32 位哈希（用于内容脏检查；无需 crypto，简单快速）
function _fnvHash(str) {
    if (!str) return '0';
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

function _newBlockId() {
    return 'blk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 按 "\n\n" 分段（无空行退化为 "\n"）；自动检测对话（"…"）与场景切换（"***"）
function _splitChapterToBlocks(content) {
    if (!content) return [];
    // 第一步：按 "\n\n" 切；若全是单 \n，则退化到按 \n 切
    let chunks = content.split(/\n\n+/).map(s => s.trim()).filter(s => s.length > 0);
    if (chunks.length <= 1 && content.includes('\n')) {
        chunks = content.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
    }
    return chunks.map((text, idx) => {
        let blockType = 'paragraph';
        if (/^[\*\-]{3,}\s*$/.test(text) || /^\s*\*\s*\*\s*\*\s*$/.test(text)) {
            blockType = 'scene_break';
        } else if (/^[「『"][^」』"]+[」』"]/.test(text) || /[""][^""]+[""]/.test(text)) {
            // 简单对话检测：首字符是引号对
            blockType = 'dialogue';
        }
        return {
            id: _newBlockId(),
            position: idx,
            block_type: blockType,
            content: text,
            content_hash: _fnvHash(text),
        };
    });
}

// 从 blocks 数组重组为完整 content（block 间用 "\n\n" 分隔；scene_break 自带格式）
function _blocksToContent(blocks) {
    if (!blocks || !blocks.length) return '';
    return blocks.map(b => {
        if (b.block_type === 'scene_break') return '***';
        return b.content;
    }).join('\n\n');
}

// 计算章节的 blocks_hash（所有 block content_hash 拼接后取 fnv）
function _calcBlocksHash(blocks) {
    if (!blocks || !blocks.length) return '';
    const concat = blocks.map(b => (b.content_hash || _fnvHash(b.content))).join('|');
    return _fnvHash(concat);
}

// 把指定 chapter 的 blocks 同步到 _ainovel_chapter_blocks（diff：删除旧/插入新/更新变）
// 返回最终的 blocks 数组（按 position 排序）
function _syncChapterBlocks(novelId, chapterId, content) {
    if (!novelId || !chapterId) return [];
    const desired = _splitChapterToBlocks(content);
    const blocksHash = _calcBlocksHash(desired);

    // 读取已有 blocks
    const existing = _store.query(
        `SELECT id, position, block_type, content, content_hash FROM _ainovel_chapter_blocks
          WHERE chapter_id = ? ORDER BY position`,
        chapterId
    );

    // 简单策略：position 数变化或第一个/最后一个 hash 变化 → 重建
    const needRebuild = existing.length !== desired.length
        || (existing[0] && existing[0].content_hash !== desired[0].content_hash)
        || (existing[existing.length - 1] && existing[existing.length - 1].content_hash !== desired[desired.length - 1].content_hash);

    if (needRebuild) {
        // 整段重建（事务）
        _store.exec('SAVEPOINT novel_blocks_sync');
        try {
            _store.exec('DELETE FROM _ainovel_chapter_blocks WHERE chapter_id = ?', chapterId);
            const stmt = (() => {
                const now = _now();
                const rows = desired.map((b, i) => ({
                    id: b.id, chapter_id: chapterId, novel_id: novelId,
                    position: i, block_type: b.block_type, content: b.content,
                    content_hash: b.content_hash, now,
                }));
                return rows;
            })();
            for (const r of stmt) {
                _store.exec(
                    `INSERT INTO _ainovel_chapter_blocks (id, chapter_id, novel_id, position, block_type, content, content_hash, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    r.id, r.chapter_id, r.novel_id, r.position, r.block_type, r.content, r.content_hash, r.now, r.now
                );
            }
            _store.exec('RELEASE SAVEPOINT novel_blocks_sync');
        } catch (e) {
            _store.exec('ROLLBACK TO SAVEPOINT novel_blocks_sync');
            _store.exec('RELEASE SAVEPOINT novel_blocks_sync');
            throw e;
        }
    } else {
        // 局部更新：仅写 content 变化的 block
        for (let i = 0; i < desired.length; i++) {
            const d = desired[i];
            const e = existing[i];
            if (e && e.content_hash !== d.content_hash) {
                _store.exec(
                    `UPDATE _ainovel_chapter_blocks SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
                    d.content, d.content_hash, _now(), e.id
                );
            } else if (!e) {
                _store.exec(
                    `INSERT INTO _ainovel_chapter_blocks (id, chapter_id, novel_id, position, block_type, content, content_hash, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    d.id, chapterId, novelId, i, d.block_type, d.content, d.content_hash, _now(), _now()
                );
            }
        }
    }

    // 更新 _ainovel_chapters.blocks_hash
    try {
        _store.exec(`UPDATE _ainovel_chapters SET blocks_hash = ? WHERE id = ?`, blocksHash, chapterId);
    } catch (e) { /* 列可能不存在 */ }

    return desired;
}

// 读取指定章节的 blocks（按 position 排序）；空时按 content 懒生成
function _getChapterBlocks(novelId, chapterId) {
    if (!chapterId) return [];
    let blocks = _store.query(
        `SELECT id, position, block_type, content, content_hash FROM _ainovel_chapter_blocks
          WHERE chapter_id = ? ORDER BY position`,
        chapterId
    );
    if (blocks && blocks.length) return blocks;
    // 懒生成
    const row = _store.query('SELECT content FROM _ainovel_chapters WHERE id = ?', chapterId)[0];
    if (!row) return [];
    return _syncChapterBlocks(novelId, chapterId, row.content || '');
}

// 单 block 替换：更新 content + content_hash，重算 chapter.blocks_hash
function _replaceBlock(novelId, chapterId, blockId, newContent) {
    if (!chapterId || !blockId) return { ok: false, error: 'chapterId/blockId 必填' };
    const blk = _store.query(
        `SELECT id, position FROM _ainovel_chapter_blocks WHERE id = ? AND chapter_id = ?`,
        blockId, chapterId
    )[0];
    if (!blk) return { ok: false, error: 'block 不存在' };
    const text = String(newContent || '');
    const hash = _fnvHash(text);
    _store.exec(
        `UPDATE _ainovel_chapter_blocks SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
        text, hash, _now(), blockId
    );
    // 重组 content → 更新 _ainovel_chapters.content
    const allBlocks = _store.query(
        `SELECT content, block_type FROM _ainovel_chapter_blocks WHERE chapter_id = ? ORDER BY position`,
        chapterId
    );
    const newFullContent = _blocksToContent(allBlocks);
    const wordCount = _countWords(newFullContent);
    _store.exec(
        `UPDATE _ainovel_chapters SET content = ?, actual_word_count = ?, user_edited = 1, updated_at = ? WHERE id = ?`,
        newFullContent, wordCount, _now(), chapterId
    );
    _store.exec(`UPDATE _ainovel_chapters SET blocks_hash = ? WHERE id = ?`, _calcBlocksHash(allBlocks), chapterId);
    dropContext(novelId);
    _invalidateChapterContinuity(novelId, chapterId);
    _emit('chapter_block_replaced', { novelId, chapterId, blockId });
    _emit('chapter_updated', { novelId, chapterId });
    return { ok: true };
}

// 删除单 block（重排 position）
function _deleteBlock(novelId, chapterId, blockId) {
    if (!chapterId || !blockId) return { ok: false, error: 'chapterId/blockId 必填' };
    const blk = _store.query(
        `SELECT id, position FROM _ainovel_chapter_blocks WHERE id = ? AND chapter_id = ?`,
        blockId, chapterId
    )[0];
    if (!blk) return { ok: false, error: 'block 不存在' };
    _store.exec('DELETE FROM _ainovel_chapter_blocks WHERE id = ?', blockId);
    // 重排 position（后面的 position 减 1；用临时负偏移避免 UNIQUE 冲突）
    try { _store.exec('BEGIN'); } catch (e) { /* */ }
    try {
        _store.exec(
            `UPDATE _ainovel_chapter_blocks SET position = -(position)
              WHERE chapter_id = ? AND position > ?`,
            chapterId, blk.position
        );
        _store.exec(
            `UPDATE _ainovel_chapter_blocks SET position = -position - 1
              WHERE chapter_id = ? AND position < 0`,
            chapterId
        );
        const allBlocks = _store.query(
            `SELECT content, block_type FROM _ainovel_chapter_blocks WHERE chapter_id = ? ORDER BY position`,
            chapterId
        );
        const newFullContent = _blocksToContent(allBlocks);
        const wordCount = _countWords(newFullContent);
        _store.exec(
            `UPDATE _ainovel_chapters SET content = ?, actual_word_count = ?, user_edited = 1, updated_at = ? WHERE id = ?`,
            newFullContent, wordCount, _now(), chapterId
        );
        _store.exec(`UPDATE _ainovel_chapters SET blocks_hash = ? WHERE id = ?`, _calcBlocksHash(allBlocks), chapterId);
        try { _store.exec('COMMIT'); } catch (e) { /* */ }
    } catch (e) {
        try { _store.exec('ROLLBACK'); } catch (e2) { /* */ }
        throw e;
    }
    dropContext(novelId);
    _invalidateChapterContinuity(novelId, chapterId);
    _emit('chapter_block_deleted', { novelId, chapterId, blockId });
    _emit('chapter_updated', { novelId, chapterId });
    return { ok: true };
}

// 在指定 block 后插入新 block（afterBlockId=null 表示在开头插入）
function _insertBlockAfter(novelId, chapterId, afterBlockId, newContent, blockType) {
    if (!chapterId) return { ok: false, error: 'chapterId 必填' };
    const text = String(newContent || '');
    const hash = _fnvHash(text);
    let afterPos = -1;
    if (afterBlockId) {
        const after = _store.query(
            `SELECT position FROM _ainovel_chapter_blocks WHERE id = ? AND chapter_id = ?`,
            afterBlockId, chapterId
        )[0];
        if (!after) return { ok: false, error: 'afterBlock 不存在' };
        afterPos = after.position;
    }
    try {
        // 后面的 position +1（用负数临时偏移避免 UNIQUE 冲突；然后再 +2 回正）
        _store.exec(
            `UPDATE _ainovel_chapter_blocks SET position = -(position + 1)
              WHERE chapter_id = ? AND position > ?`,
            chapterId, afterPos
        );
        _store.exec(
            `UPDATE _ainovel_chapter_blocks SET position = -position + 1
              WHERE chapter_id = ? AND position < 0`,
            chapterId
        );
        const newPos = afterPos + 1;
        const newId = _newBlockId();
        _store.exec(
            `INSERT INTO _ainovel_chapter_blocks (id, chapter_id, novel_id, position, block_type, content, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newId, chapterId, novelId, newPos,
            blockType || 'paragraph',
            text, hash, _now(), _now()
        );
        const allBlocks = _store.query(
            `SELECT content, block_type FROM _ainovel_chapter_blocks WHERE chapter_id = ? ORDER BY position`,
            chapterId
        );
        const newFullContent = _blocksToContent(allBlocks);
        const wordCount = _countWords(newFullContent);
        _store.exec(
            `UPDATE _ainovel_chapters SET content = ?, actual_word_count = ?, user_edited = 1, updated_at = ? WHERE id = ?`,
            newFullContent, wordCount, _now(), chapterId
        );
        _store.exec(`UPDATE _ainovel_chapters SET blocks_hash = ? WHERE id = ?`, _calcBlocksHash(allBlocks), chapterId);
        dropContext(novelId);
        _invalidateChapterContinuity(novelId, chapterId);
    _emit('chapter_block_inserted', { novelId, chapterId, blockId: newId, position: newPos });
        _emit('chapter_updated', { novelId, chapterId });
        return { ok: true, blockId: newId, position: newPos };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

// 读取指定章节（带 blocks 数组）
function _getChapterWithBlocks(novelId, chapterId) {
    if (!chapterId) return null;
    const row = _store.query('SELECT * FROM _ainovel_chapters WHERE id = ?', chapterId)[0];
    if (!row) return null;
    const blocks = _getChapterBlocks(novelId, chapterId);
    return { ...row, blocks };
}

// 异步：单 block AI 修订（用 LLM 重写该段，保持其他 block 不变）
async function _reviseBlockAsync(novelId, chapterId, blockId, feedback) {
    if (!chapterId || !blockId) return { ok: false, error: 'chapterId/blockId 必填' };
    const blk = _store.query(
        `SELECT id, position, block_type, content FROM _ainovel_chapter_blocks WHERE id = ? AND chapter_id = ?`,
        blockId, chapterId
    )[0];
    if (!blk) return { ok: false, error: 'block 不存在' };

    // 上下文：前后各 1 段
    const ctxBlocks = _store.query(
        `SELECT position, content FROM _ainovel_chapter_blocks WHERE chapter_id = ? AND position BETWEEN ? AND ? ORDER BY position`,
        chapterId, Math.max(0, blk.position - 1), blk.position + 1
    );

    const chapterRow = _store.query('SELECT title, novel_id FROM _ainovel_chapters WHERE id = ?', chapterId)[0];
    const novelRow = chapterRow ? _store.query('SELECT title, style, pov FROM _ainovel_novels WHERE id = ?', chapterRow.novel_id)[0] : null;

    const userPrompt = `【小说】${novelRow ? novelRow.title : ''}
【风格】${novelRow ? (novelRow.style || '') : ''}
【视角】${novelRow ? (novelRow.pov || '') : ''}
【章节】${chapterRow ? chapterRow.title : ''}

【上一段（如有）】
${ctxBlocks.length > 1 && ctxBlocks[0].position === blk.position - 1 ? ctxBlocks[0].content : '（无）'}

【待修订段落】
${blk.content}

【下一段（如有）】
${ctxBlocks.length > 1 && ctxBlocks[ctxBlocks.length - 1].position === blk.position + 1 ? ctxBlocks[ctxBlocks.length - 1].content : '（无）'}

【修订意见】
${feedback || '润色这段文字，使其更生动自然。'}

【要求】
1. 只输出修订后的段落正文，不要任何解释、不要 markdown 包裹
2. 保持段落的核心含义、长度（±30%）与叙事位置
3. 若该段是场景切换或对话，保留原有标记`;

    try {
        const cfg = _getProviderConfig();
        const res = await novel.generate({
            provider: cfg.provider,
            base_url: cfg.base_url,
            api_key: cfg.api_key,
            model: cfg.model,
            system: '你是文学编辑，专注于单段落的精细修订。保持上下文衔接自然，不要改变情节走向。',
            user: userPrompt,
            temperature: 0.6,
            max_tokens: Math.max(2000, Math.min(4000, blk.content.length * 3 + 500)),
            signal: null,
        });
        const newText = (res.text || '').trim();
        if (!newText) return { ok: false, error: 'AI 返回为空' };

        _store.exec(
            `UPDATE _ainovel_chapter_blocks SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
            newText, _fnvHash(newText), _now(), blockId
        );

        // 重组 content
        const allBlocks = _store.query(
            `SELECT content, block_type FROM _ainovel_chapter_blocks WHERE chapter_id = ? ORDER BY position`,
            chapterId
        );
        const newFullContent = _blocksToContent(allBlocks);
        const wordCount = _countWords(newFullContent);
        _store.exec(
            `UPDATE _ainovel_chapters SET content = ?, actual_word_count = ?, user_edited = 1, updated_at = ? WHERE id = ?`,
            newFullContent, wordCount, _now(), chapterId
        );
        _store.exec(`UPDATE _ainovel_chapters SET blocks_hash = ? WHERE id = ?`, _calcBlocksHash(allBlocks), chapterId);

        dropContext(novelId);
        _emit('chapter_block_revised', { novelId, chapterId, blockId });
        _emit('chapter_updated', { novelId, chapterId });
        _recordGeneration({
            novel_id: novelId,
            skill: 'block-revision',
            prompt_tokens: res.prompt_tokens || 0,
            completion_tokens: res.completion_tokens || 0,
            cost_usd: (res.cost_usd || 0),
            raw_request: userPrompt,
            raw_response: newText,
        });
        return { ok: true, newContent: newText, prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens };
    } catch (e) {
        _emit('chapter_block_revise_failed', { novelId, chapterId, blockId, error: e.message });
        return { ok: false, error: e.message || String(e) };
    }
}

// ====== Skills ======
// Skill 1: outline-architect
// ============ Outline Pipeline (Phase 2) ============
// 7 个 agent 协作：style-analyst / world-architect / character-architect /
// plot-architect / theme-architect / outline-synthesizer / outline-reviewer。
// 旧的 outline-architect skill 保留为 thin wrapper，调 _runOutlinePipeline。

// 所有 agent 必须遵守的 JSON 引号硬性规则（中文 LLM 经常在 string value 内部
// 漏 escape "，导致 JSON.parse 失败 → 整个 pipeline 失败 → outline 写不进 DB。
// 这条规则 append 到每个 agent 的 systemPrompt 末尾）
const JSON_QUOTE_RULE = `

【JSON 引号硬性要求 - 必读】
所有字符串值内部禁止使用原始 " 双引号。如需引号，请二选一：
  ① 中文引号：「」 或 『』
  ② 转义形式：\\"

正确示例："description": "主角说：「我是皮特」"
正确示例："description": "主角说：\\"我是皮特\\""
错误示例（绝对禁止）："description": "主角说："我是皮特""（未转义引号会破坏 JSON，导致整个流程失败）`;

// ---- Agent 1: style-analyst ----
registerSkill({
    name: 'style-analyst',
    displayName: '风格分析师',
    workspaceDir: './agents/style-analyst/',
    description: '从用户的风格选择 + 核心创意中，提取具体的写作风格属性',
    temperature: 0.4,
    systemPrompt: `你是文学风格分析师，擅长把"玄幻""都市""科幻"这种宽泛标签细化为可执行的写作指南。

【任务】
根据用户提供的【小说基本信息】，输出一份结构化的【风格指南】，供后续 agent 严格遵循。

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "styleAttributes": ["细腻描写", "对话驱动", "动作场面紧凑", ...],   // 5-10 个
  "comparableReferences": ["金庸", "阿西莫夫", ...],                // 1-3 个可比作者/作品（仅作风格参考，禁止抄原文）
  "narrativeVoice": "第三人称限知视角，沉静克制",                    // 一句话
  "vocabularyHints": ["古风词汇", "学术术语"],                       // 建议词汇取向
  "avoidances": ["网络流行语", "过度煽情"]                            // 应避免的元素
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const userPrompt = `【小说基本信息】
- 标题：${novelRow.title}
- 风格：${novelRow.style || '未指定'}${novelRow.custom_style ? '\n- 风格补充：' + novelRow.custom_style : ''}
- 核心创意：${novelRow.core_idea}
- 视角：${novelRow.pov || '未指定'}
- 基调：${novelRow.tone || '未指定'}

请输出 JSON 风格指南。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 2000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || {};
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 2: world-architect ----
registerSkill({
    name: 'world-architect',
    displayName: '世界架构师',
    workspaceDir: './agents/world-architect/',
    description: '设计 3 个候选世界设定（不同方向）',
    temperature: 0.95,
    systemPrompt: `你是世界设定架构师。任务：根据核心创意 + 风格指南，输出 3 个**完全不同方向**的世界设定供汇聚阶段择优。

【输出要求】
严格 JSON：
{
  "candidates": [
    {
      "name": "候选方案标题",
      "era": "时代 / 年代设定",
      "setting": "主要故事发生的地点 / 空间类型（100-150 字）",
      "specialRules": ["规则 1", "规则 2", ...],   // 这个世界独有的运行规则 / 魔法 / 科技 / 社会制度
      "hook": "这个世界最吸引人的卖点（一句话）",
      "conflictPotential": "这个世界能孕育的核心冲突类型"
    },
    { ... 3 个 ... }
  ]
}

要求：
- 3 个候选之间要明显不同（不同年代 / 不同科技水平 / 不同社会制度 / 不同空间），便于汇聚阶段挑选组合
- 每个 specialRules 数组 3-5 条
- 不要直接照搬热门 IP 的世界（避免抄袭）；可以从历史时期 / 神话原型 / 科学假设里取材${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const style = input.styleGuide || {};
        const userPrompt = `【核心创意】${novelRow.core_idea}
【风格】${novelRow.style || ''} / ${novelRow.custom_style || ''}
【风格指南】${JSON.stringify(style, null, 0)}

请设计 3 个不同方向的世界设定。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 3000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || { candidates: [] };
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 3: character-architect ----
registerSkill({
    name: 'character-architect',
    displayName: '人物架构师',
    workspaceDir: './agents/character-architect/',
    description: '设计 3 个候选主角方案 + 主要配角',
    temperature: 0.95,
    systemPrompt: `你是人物设计师。任务：根据核心创意 + 风格指南，输出 3 个**完全不同性格 / 背景**的主角方案。

【输出要求】
严格 JSON：
{
  "candidates": [
    {
      "name": "主角名",
      "role": "主角",
      "archetype": "英雄原型 / 反英雄 / 反派成长 / 普通人觉醒 ...",
      "psychology": "内在性格（MBTI 倾向 / 核心恐惧 / 核心欲望）",
      "motivation": "驱动主角行动的内在 / 外在动力",
      "arc": "人物成长轨迹（起点 → 变化 → 终点）",
      "supportingCast": [
        { "name": "配角名", "role": "导师 / 对手 / 同伴 / 爱人", "description": "100字以内简介" },
        ... 2-4 个 ...
      ]
    },
    { ... 3 个 ... }
  ]
}

要求：
- 3 个主角之间性格 / 出身 / 动机差异显著（e.g. 复仇者 / 求知者 / 反叛者）
- arc 要清晰可执行，不要写"主角成长为英雄"这种空话
- supportingCast 2-4 个核心配角${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const style = input.styleGuide || {};
        const userPrompt = `【核心创意】${novelRow.core_idea}
【风格】${novelRow.style || ''}
【风格指南】${JSON.stringify(style, null, 0)}

请设计 3 个不同性格 / 背景的主角方案。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 3000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || { candidates: [] };
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 4: plot-architect ----
registerSkill({
    name: 'plot-architect',
    displayName: '剧情架构师',
    workspaceDir: './agents/plot-architect/',
    description: '基于世界+人物方案设计 3 个候选剧情结构',
    temperature: 0.85,
    systemPrompt: `你是剧情结构师。任务：基于世界设定 + 主角方案，设计 3 个不同类型的剧情走向。

【输出要求】
严格 JSON：
{
  "candidates": [
    {
      "name": "剧情走向标题",
      "structure": "三幕式 / 起承转合 / 英雄之旅 12 阶段 / 自由结构（200字内）",
      "mainConflict": "核心冲突一句话",
      "keyBeats": ["开端：...", "第一转折：...", "高潮：...", "结局：...", ...],  // 5-8 个关键节拍
      "arcForCharacters": "在这个剧情下，主角 / 配角的命运如何演变（150字内）"
    },
    { ... 3 个 ... }
  ]
}

要求：
- 3 个候选剧情方向要明显不同（如：复仇线 / 探索线 / 政治阴谋线）
- keyBeats 要具体到事件级，不要写"主角成长"这种笼统词
- 剧情结构要自洽，能让 5-8 拍完整形成一条故事线${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const style = input.styleGuide || {};
        const worlds = input.worlds || { candidates: [] };
        const characters = input.characters || { candidates: [] };
        const userPrompt = `【核心创意】${novelRow.core_idea}
【风格】${novelRow.style || ''}
【候选世界】${JSON.stringify(worlds.candidates || [], null, 0).slice(0, 3000)}
【候选主角】${JSON.stringify(characters.candidates || [], null, 0).slice(0, 3000)}

请基于以上候选世界 + 主角方案，设计 3 个不同类型的剧情走向。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 3000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || { candidates: [] };
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 5: theme-architect ----
registerSkill({
    name: 'theme-architect',
    displayName: '主题架构师',
    workspaceDir: './agents/theme-architect/',
    description: '提取核心主题 / 母题 / 象征元素',
    temperature: 0.6,
    systemPrompt: `你是主题分析师。任务：从核心创意 + 风格指南中提取贯穿全书的主题 / 母题 / 象征元素。

【输出要求】
严格 JSON：
{
  "themes": ["命运 vs 自由意志", "人性的灰色地带", ...],   // 3-5 个核心主题
  "motifs": ["镜子", "雨", "面具", ...],                  // 5-8 个反复出现的意象
  "symbolicElements": [
    { "symbol": "镜子", "meaning": "自我审视", "usage": "主角每次重大抉择前出现" },
    ...
  ],
  "coreQuestion": "全书围绕的核心哲学问题（一句话）"   // e.g. "命运能被改变吗？"
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const style = input.styleGuide || {};
        const userPrompt = `【核心创意】${novelRow.core_idea}
【风格】${novelRow.style || ''}
【风格指南】${JSON.stringify(style, null, 0)}

请提取贯穿全书的主题 / 母题 / 象征元素。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 1500,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || {};
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 6: outline-synthesizer ----
// 接收所有上游产物（style / worlds / characters / plots / themes），
// 选出最佳组合 + 生成最终大纲 JSON（与 Phase 1 outline-architect 同 schema）。
registerSkill({
    name: 'outline-synthesizer',
    displayName: '大纲综合器',
    workspaceDir: './agents/outline-synthesizer/',
    description: '综合所有上游 agent 产物，生成最终大纲',
    temperature: 0.4,
    systemPrompt: `你是资深小说策划师 / 编辑。任务：从所有候选方案中**挑选最优组合**，综合成可执行的整本小说大纲。

【输入物】
- 风格指南（写作约束）
- 3 个候选世界设定
- 3 个候选主角方案
- 3 个候选剧情走向
- 主题 / 母题 / 象征元素

【任务】
1. 选 1 个世界 + 1 个主角 + 1 个剧情走向（说明选择理由）
2. 综合成结构化大纲：
{
  "structure": "整体结构方案（200字内，如'三幕式：建置→对抗→结局'）",
  "world_setting": "世界观设定（300-600字）",
  "main_conflict": "主冲突 + 主角核心矛盾（100-200字）",
  "themes": ["主题词1", "主题词2", ...],
  "global_characters": [
    { "name": "...", "role": "...", "description": "...", "arc": "..." },
    ... 3-8 个核心人物 ...
  ],
  "chapter_list": [
    { "chapter_no": 1, "title": "...", "summary": "本章节关键事件（80-150字）", "target_word_count": 3000 },
    ...
  ],
  "selectionRationale": "为什么选这 3 个方案（100字内）"
}

【关键要求】
- 章节数 = 用户 chapter_target_count（如未指定则 30 章，可 ±5）
- 每章 target_word_count 2500-4000 字
- summary 必须具体到本章节的关键事件，不要写"主角冒险"这种笼统
- 人物 arc 完整（起点→变化→终点）
- 章节顺序：开端→发展→高潮→结局；章节之间有钩子
- 全书总字数应接近目标字数

【输出格式铁律 — 必须遵守，否则视为失败】
1. **严禁任何 prose 解释** — 不要写"好的，我来为您..."或"以下是..."。直接输出 JSON
2. **严禁 markdown 包裹** — 不要用 \`\`\`json ... \`\`\` 包裹，直接输出裸 JSON
3. **严禁中途中断** — 输出前先在心里规划好整体长度，确保 JSON 完整闭合（所有 { } [ ] " 都成对）
4. **结构字段必填非空** — "structure" 必须是 50-200 字的实质内容，绝不能为空字符串
5. **如果内容过多** — 优先压缩每章 summary 到 60-100 字（而不是省略章节）
6. **修订模式输出** — 如有 lastReview，把改进点写进对应字段值里，不要额外加 revisedFeedback 字段

【修订模式】
如果【上次评审反馈】不为空，请优先解决反馈中提到的所有问题，并简述在 revisedFeedback 中。${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const { styleGuide, worlds, characters, plots, themes, lastReview, round } = input;
        const userPrompt = `【小说基本信息】
- 标题：${novelRow.title}
- 风格：${novelRow.style || ''}${novelRow.custom_style ? ' / ' + novelRow.custom_style : ''}
- 核心创意：${novelRow.core_idea}
- 视角：${novelRow.pov || ''}
- 基调：${novelRow.tone || ''}
- 目标字数：${novelRow.target_word_count}
- 预计章节数：${novelRow.chapter_target_count || 30}

【风格指南】${JSON.stringify(styleGuide || {}, null, 0)}

【候选世界】${JSON.stringify((worlds && worlds.candidates) || [], null, 0).slice(0, 2500)}
【候选主角】${JSON.stringify((characters && characters.candidates) || [], null, 0).slice(0, 2500)}
【候选剧情】${JSON.stringify((plots && plots.candidates) || [], null, 0).slice(0, 2500)}
【主题 / 母题】${JSON.stringify(themes || {}, null, 0).slice(0, 1000)}

${lastReview ? `【上次评审反馈】\n${lastReview}\n请针对反馈改进。` : ''}
${round && round > 1 ? `【当前是第 ${round} 轮修订】` : ''}

请输出 JSON 大纲。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 16000,
            signal: ctx.signal,
        }), onChunk);
        // 4 层 JSON 防御（替代旧的 _tryParseJson + throw）
        const safeResult = await _safeParseAgentOutput(res.text, 'outline-synthesizer', cfg);
        if (safeResult.parseFailed) {
            // 不再 throw；标记输出为 fallback，pipeline 继续（评审会发现空数据并要求重写）
            console.error(`[outline-synthesizer] JSON 解析全失败，使用 fallback；repairMethod=${safeResult.repairMethod}`);
        }
        return {
            output: safeResult.output,
            raw: res.text,
            text: res.text,
            parseFailed: safeResult.parseFailed,
            repairMethod: safeResult.repairMethod,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ====== Sprint 7.1: Arcs（卷）3 个 skill ======
// ---- arc-skeleton: 全书一次性生成卷骨架 ----
registerSkill({
    name: 'arc-skeleton',
    displayName: '卷骨架生成器',
    workspaceDir: './agents/arc-skeleton/',
    description: '把整本小说拆分为若干"卷(arc)"，每卷覆盖连续的章节区间',
    category: 'outline',
    temperature: 0.5,
    inputSchema: {
        novelId: 'string',
        title: 'string',
        type: 'string',
        synopsis: 'string',
        writing_style: 'string',
        chapter_count: 'number',
        context: 'object?',
    },
    outputSchema: {
        arcs: [{ title: 'string', goal: 'string', start_ch: 'number', end_ch: 'number' }],
    },
    whenToUse: '生成全书卷骨架（一卷=一段连续的章节区间）。仅在第 1 阶段调用一次。',
    run: async (ctx) => {
        const cfg = _getProviderConfig(ctx);
        const userPrompt = `【输入】
novelId: ${ctx.input.novelId || ''}
title: ${ctx.input.title || ''}
type: ${ctx.input.type || ''}
synopsis: ${ctx.input.synopsis || ''}
writing_style: ${ctx.input.writing_style || ''}
chapter_count: ${ctx.input.chapter_count}

${ctx.input.context ? `【附加上下文】\n${typeof ctx.input.context === 'string' ? ctx.input.context : JSON.stringify(ctx.input.context)}` : ''}

【输出】严格 JSON：
{ "arcs": [{ "title": "...", "goal": "...", "start_ch": 1, "end_ch": 12 }, ...] }
约束：所有 arc 区间之和必须 == chapter_count；从 1 开始；end_ch == chapter_count。`;
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generate(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 2000,
            signal: ctx.signal,
        }));
        const parsed = _tryParseJson(res.text);
        const arcs = (parsed && Array.isArray(parsed.arcs)) ? parsed.arcs : [];
        // 兜底：如果解析失败，给一个单 arc
        if (!arcs.length) {
            return {
                output: { arcs: [{ title: '主卷', goal: ctx.input.synopsis || '', start_ch: 1, end_ch: ctx.input.chapter_count || 1 }], __parseFailed: true },
                raw: res.text, text: res.text,
                prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
                cost_usd: res.cost_usd, estimated: res.estimated,
            };
        }
        return {
            output: { arcs },
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- arc-outline-generator: 单卷章节 outline ----
registerSkill({
    name: 'arc-outline-generator',
    displayName: '单卷大纲生成器',
    workspaceDir: './agents/arc-outline-generator/',
    description: '为一卷(arc)生成章节级 outline',
    category: 'outline',
    temperature: 0.5,
    inputSchema: {
        novelId: 'string',
        arcId: 'string',
        arc_title: 'string',
        arc_goal: 'string',
        arc_start_ch: 'number',
        arc_end_ch: 'number',
        prev_arc_summary: 'string?',
        next_arc_goal: 'string?',
        context: 'object?',
    },
    outputSchema: {
        chapters: [{ chapter_no: 'number', title: 'string', summary: 'string', goal: 'string', conflict: 'string', hook: 'string', pov: 'string', key_events: 'array' }],
    },
    whenToUse: '为一卷生成章节级 outline。每次对应一卷，可重复调用。',
    run: async (ctx) => {
        const cfg = _getProviderConfig(ctx);
        const userPrompt = `【输入】
novelId: ${ctx.input.novelId || ''}
arcId: ${ctx.input.arcId || ''}
arc_title: ${ctx.input.arc_title || ''}
arc_goal: ${ctx.input.arc_goal || ''}
arc_start_ch: ${ctx.input.arc_start_ch}
arc_end_ch: ${ctx.input.arc_end_ch}
prev_arc_summary: ${ctx.input.prev_arc_summary || '（无）'}
next_arc_goal: ${ctx.input.next_arc_goal || '（无）'}

${ctx.input.context ? `【附加上下文】\n${typeof ctx.input.context === 'string' ? ctx.input.context : JSON.stringify(ctx.input.context)}` : ''}

【输出】严格 JSON：
{ "chapters": [{ "chapter_no": ${ctx.input.arc_start_ch}, "title": "...", "summary": "...", "goal": "...", "conflict": "...", "hook": "...", "pov": "...", "key_events": [...] }, ...] }
约束：必须生成 (arc_end_ch - arc_start_ch + 1) 章；章序连续；summary 必须具体。`;
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generate(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 6000,
            signal: ctx.signal,
        }));
        const parsed = _tryParseJson(res.text);
        const chapters = (parsed && Array.isArray(parsed.chapters)) ? parsed.chapters : [];
        return {
            output: { chapters },
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- arc-summary: 单卷完结后懒生成摘要 ----
registerSkill({
    name: 'arc-summary',
    displayName: '卷摘要生成器',
    workspaceDir: './agents/arc-summary/',
    description: '为一卷已完结的章节生成 400-800 字卷摘要',
    category: 'outline',
    temperature: 0.5,
    inputSchema: {
        novelId: 'string',
        arcId: 'string',
        arc_title: 'string',
        arc_goal: 'string',
        arc_start_ch: 'number',
        arc_end_ch: 'number',
        chapters: 'array',
    },
    outputSchema: {
        summary: 'string',
        key_events: [{ at_chapter: 'number', event: 'string' }],
    },
    whenToUse: 'arc 完结时懒调用，生成卷摘要（仅一次）。',
    run: async (ctx) => {
        const cfg = _getProviderConfig(ctx);
        // 拼接章节正文摘要（每章取首 300 字）
        const chapSummaries = (ctx.input.chapters || []).map(ch => `第${ch.chapter_no}章 ${ch.title || ''}：${(ch.content || ch.summary || '').slice(0, 300)}`).join('\n\n');
        const userPrompt = `【输入】
arc_title: ${ctx.input.arc_title || ''}
arc_goal: ${ctx.input.arc_goal || ''}
arc_start_ch: ${ctx.input.arc_start_ch}
arc_end_ch: ${ctx.input.arc_end_ch}

【章节摘要】
${chapSummaries.slice(0, 4000)}

【输出】严格 JSON：
{ "summary": "400-800 字第三人称叙事摘要", "key_events": [{ "at_chapter": 5, "event": "..." }, ...] }`;
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generate(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 2000,
            signal: ctx.signal,
        }));
        const parsed = _tryParseJson(res.text);
        return {
            output: parsed || { summary: '', key_events: [] },
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ====== Sprint 7.2: foreshadowing-extractor 已由原 Agent 15 注册（Phase 4-C）======
// 注：原注册在 line 5915+，覆盖不到这里的 category 字段。
// 因此我们在这里添加 category='review' 到现有注册。
// ---- Agent 7: outline-reviewer ----
registerSkill({
    name: 'outline-reviewer',
    displayName: '大纲评审员',
    workspaceDir: './agents/outline-reviewer/',
    description: '审查大纲一致性 / 原创性 / 结构质量',
    temperature: 0.3,
    systemPrompt: `你是资深文学编辑。任务：对【当前大纲】做严格审查。

【评估维度】
1. **一致性**：世界观内部规则是否自洽？人物设定是否矛盾？
2. **原创性**：是否直接照搬热门 IP / 网文套路 / 既有小说？给出相似 IP 名称（如有）
3. **结构**：章节数 / 字数分配 / 高潮位置 / 钩子设置是否合理？
4. **可执行性**：每个章节的 summary 是否足够具体到能据此写作？
5. **人物 arc**：主角 / 主要配角成长轨迹是否完整？

【输出要求】
严格 JSON：
{
  "approved": true | false,
  "score": 0-10,
  "feedback": [
    { "issue": "...", "severity": "critical | major | minor", "suggestion": "具体怎么改" },
    ...
  ],
  "summary": "一句话总评"
}

【判定阈值】
- score >= 7 → approved=true（可接受）
- score < 7 → approved=false，给出 critical / major 级 feedback 让 synthesizer 修订

【原创性红线】
如果发现严重照搬（如直接复制"哈利波特""三体""凡人修仙传"等已有作品的设定），必须标 severity=critical 并指出是哪部作品（仅作标记，禁止抄袭原文 / 设定 / 人物原型）。${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const outline = input.outline || {};
        const userPrompt = `【当前大纲】
${JSON.stringify(outline, null, 2).slice(0, 6000)}

请按 5 个维度审查并输出 JSON。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 2000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text) || { approved: false, score: 0, feedback: [], summary: '解析失败' };
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 8: story-architect（Phase 4-A：从已合成的大纲抽出顶层架构）----
// 输入：已稳定的大纲（synthesizer 产物），输出：3 幕 + 子线 + 人物弧线 + 主题落点 + 伏笔种子
registerSkill({
    name: 'story-architect',
    displayName: '故事架构师',
    workspaceDir: './agents/story-architect/',
    description: '从已合成大纲抽取顶层故事架构（3 幕/子线/弧线/主题/伏笔种子）',
    temperature: 0.5,
    systemPrompt: `你是资深故事架构师。任务：从已合成的【大纲】中抽取**顶层故事架构**，供后续章节写作严格对齐。

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "three_act": "完整三幕结构描述（600-1200字）。格式：\\n【第一幕·建置】起止章节+核心事件+主角初始状态+主要伏笔\\n【第二幕·对抗】起止章节+核心冲突+中点转折+人物成长\\n【第三幕·结局】起止章节+高潮+收束+主题升华",
  "plot_threads": [
    {
      "id": "PT001",
      "name": "主线剧情名",
      "description": "一句话说明这条线讲什么",
      "intro_ch": 1,                // 引入章节号
      "resolve_ch": 25,             // 计划回收章节号（可调）
      "status": "active"            // 固定 "active"
    },
    { ... 3-5 条 ... }
  ],
  "character_arcs": [
    {
      "name": "角色名",
      "start": "起点状态（性格/处境/认知）",
      "midpoint": "中点转折（被什么事件改变）",
      "end": "终点状态（成长/牺牲/觉醒等）"
    },
    { ... 所有主要角色 ... }
  ],
  "theme_tracks": [
    {
      "theme": "主题词",
      "act1_manifestation": "在第一幕如何体现",
      "act2_manifestation": "在第二幕如何深化",
      "act3_manifestation": "在第三幕如何收束/升华"
    },
    { ... 2-4 个主题 ... }
  ],
  "foreshadowing_seed": [
    {
      "id": "F001",
      "description": "伏笔内容（一句话）",
      "planted_chapter_estimate": 2,    // 预计在哪章埋设
      "payoff_chapter_estimate": 18     // 预计在哪章回收
    },
    { ... 5-10 个 ... }
  ]
}

【关键要求】
- plot_threads 必须 3-5 条，至少 1 条主线 + 1-2 条副线
- character_arcs 必须覆盖大纲中所有主要角色
- foreshadowing_seed 是种子，写作时由 agent 动态扩展（5-10 个够开局）
- arc 三段必须事件级具体，不能写"主角成长"这种空话
- 用中文 ID：PT001 / F001 等保持结构化，便于后续 agent 引用

【修订模式】
如果【上次评审反馈】不为空，请优先解决反馈中提到的所有问题。${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const outline = input.outline || {};
        const lastReview = input.lastReview || '';
        const userPrompt = `【已合成大纲】
${JSON.stringify(outline, null, 2).slice(0, 6000)}

${lastReview ? `【上次评审反馈】\n${lastReview}\n请针对反馈改进。` : ''}

请输出 JSON 顶层架构。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 12000,
            signal: ctx.signal,
        }), onChunk);
        // 4 层 JSON 防御
        const safeResult = await _safeParseAgentOutput(res.text, 'story-architect', cfg);
        if (safeResult.parseFailed) {
            console.error(`[story-architect] JSON 解析全失败，使用 fallback；repairMethod=${safeResult.repairMethod}`);
        }
        return {
            output: safeResult.output,
            raw: res.text,
            text: res.text,
            parseFailed: safeResult.parseFailed,
            repairMethod: safeResult.repairMethod,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- outline-architect 改为 thin wrapper：director 优先 + pipeline fallback ----
registerSkill({
    name: 'outline-architect',
    displayName: '大纲生成（兼容）',
    workspaceDir: './agents/outline-architect/',
    description: 'Phase 2: 多 agent 协作生成大纲（thin wrapper）',
    whenToUse: '需要从零生成一份完整大纲（世界观 + 人物 + 剧情 + 章节列表）时。',
    inputSchema: '{ "novelId": "string" }',
    outputSchema: '{ "ok": true, "outline": {...} }',
    systemPrompt: '(wrapper)',
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const novelId = novelRow.id;
        const goal = `为小说《${novelRow.title || '未命名'}》生成一份完整大纲：包含世界观、主要人物、剧情主线、分章节列表。`;
        const dispatched = await _directorOrPipeline(
            novelId,
            goal,
            () => _runOutlinePipeline(novelId)
        );
        // Sprint 11: orchestrator 忙 → _runOutlinePipeline 返回 { ok:false, via:'busy' }
        // 不要继续往下走"假装成功"，直接透传失败
        if (dispatched.result && dispatched.result.ok === false && dispatched.result.via === 'busy') {
            return dispatched.result;
        }
        if (dispatched.via === 'director') {
            // director 模式：从黑板 / skillResults 里回收 synthesizer 的产出
            const outline = _extractOutlineFromDirector(novelId, dispatched.result);
            if (outline) {
                return {
                    ok: true, outline, via: 'director',
                    directorSummary: dispatched.result && dispatched.result.summary,
                    prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, duration_ms: 0,
                };
            }
            // director 跑完但没拿到可用大纲 → 兜底跑 pipeline
            _emit('director_dispatch_fallback', { novelId, reason: 'director 未产出可用 outline' });
            const out = await _runOutlinePipeline(novelId);
            // 兜底也被 busy 挡
            if (out && out.ok === false) return out;
            const synth = out['phase-C-synthesize'] || {};
            const parsed = synth['outline-synthesizer'] || {};
            return {
                ok: true, outline: parsed.output || {}, via: 'pipeline-fallback',
                prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, duration_ms: 0,
            };
        }
        // pipeline / pipeline-fallback：兼容 Phase 1 调用方
        const out = dispatched.result || {};
        const synth = out['phase-C-synthesize'] || {};
        const parsed = synth['outline-synthesizer'] || {};
        return {
            ok: true,
            outline: parsed.output || {},
            via: dispatched.via,
            prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, duration_ms: 0,
        };
    },
});

// director 模式下，从 skillResults / 黑板里回收 outline-synthesizer 的产出
function _extractOutlineFromDirector(novelId, directorResult) {
    // 1. 优先从 director 的 skillResults 里找 outline-synthesizer
    const results = (directorResult && directorResult.skillResults) || [];
    for (let i = results.length - 1; i >= 0; i--) {
        const r = results[i];
        if (r.skill !== 'outline-synthesizer') continue;
        const o = r.output && (r.output.output || r.output);
        if (o && typeof o === 'object' && (o.chapter_list || o.world || o.characters)) return o;
    }
    // 2. 退而求其次：黑板上的 outline key
    try {
        const bb = blackboardRead(novelId, 'outline');
        if (bb && bb.ok && bb.value) {
            const parsed = _tryParseJson(bb.value);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (e) { /* ignore */ }
    // 3. DB 里已落盘的 outline（director 可能已经通过 skill 写库）
    try {
        const row = _store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0];
        if (row && row.chapter_list) {
            return {
                world: _safeJson(row.world, null),
                characters: _safeJson(row.characters, null),
                chapter_list: _safeJson(row.chapter_list, []),
            };
        }
    } catch (e) { /* ignore */ }
    return null;
}

// ---- Outline Pipeline 编排 ----
// 设计：A → B → C → D 串行（不并行）。理由：
//   - Phase A 风格 → 世界 → 人物：每个后置 agent 的输入是前置 agent 的输出，
//     并行跑会导致风格/世界/人物互相打架（玄幻风格下生成低魔世界 等不一致）
//   - Phase B 主题 → 剧情：先想清楚"这故事想说啥"再设计"怎么讲"
//   - Phase C 综合 / D 评审 不变
// 6 个串行阶段（A1/A2/A3/B1/B2/C） + 1 个手动循环 D = totalPhases 7
async function _runOutlinePipeline(novelId) {
    // ★ Sprint C-S2: 改用 orchestrator 执行 6 个核心 phase。
    //   story-architect 是非阻塞增强，只能在大纲可用后单独运行。
    //   原硬编码 phases 数组保留为文档注释，不参与执行
    //
    //   原始 phase 结构（仅文档）：
    //     A1 风格 → A2 世界 → A3 人物 → B1 主题 → B2 剧情 → C 综合 → D 评审循环
    //   新结构：
    //     A1..C 由 orchestrator 调度
    //     D 评审循环、E 架构提取仍在 _runOutlinePipeline 里 imperative 跑
    //
    // const phases = [
    //     { name: 'phase-A1-style',     agents: { name: 'style-analyst', ... } },
    //     { name: 'phase-A2-world',     ... },
    //     { name: 'phase-A3-character', ... },
    //     { name: 'phase-B1-theme',     ... },
    //     { name: 'phase-B2-plot',      ... },
    //     { name: 'phase-C-synthesize', ... },
    //     { name: 'phase-D-review',     ... },  // 循环，不进 DAG
    // ];

    // Sprint 11: 防御性早期返回 — orchestrator 正在跑别的 plan 时直接拒绝（不 emit pipeline_started）。
    // 修复：用户在 outline 生成期间重复点击 "生成大纲" 按钮 → 第二次 callSkill 通过 _isJobRunning 检查
    // （竞态：第一次的 _jobStart 还没执行）→ 进入 _runOutlinePipeline → emit pipeline_started →
    // orchestrator 拒绝 → emit pipeline_failed。前端看到 "失败" 但实际第一次 pipeline 仍在跑。
    if (_orchestrator && _orchestrator._currentPlan) {
        return { ok: false, error: '已有大纲生成任务进行中，请等待完成', via: 'busy' };
    }

    const jobId = _newJobId(novelId);
    _jobStart(novelId, jobId, 'outline');
    _emit('pipeline_started', { novelId, jobId, pipeline: 'outline', totalPhases: 7 });

    try {
        let out;
        if (_orchestrator) {
            // ===== Sprint C-S2 路径：orchestrator 跑 A1..C =====
            // Sprint 3: 先尝试 director.plan() 拿动态 plan，失败 fallback 静态 buildOutlinePlan
            let plan = await _tryGenerateDirectorPlan(novelId, { kind: 'outline' });
            if (!plan) plan = buildOutlinePlan(novelId);
            const result = await _orchestrator.run(plan);
            if (!result.ok) {
                // orchestrator 早期错误返回（plan 校验失败 / 已有 plan 在跑）可能没有 stats
                // 安全默认值，避免 result.stats.failed 自身抛 "Cannot read properties of undefined"
                const stats = result.stats || { failed: 0, completed: 0, dispatched: 0 };
                _emit('pipeline_failed', {
                    novelId, jobId, pipeline: 'outline',
                    error: stats.failed > 0
                        ? `orchestrator: ${stats.failed} task 失败`
                        : (result.error || 'orchestrator 退出'),
                });
                throw new Error(`outline pipeline 失败（${stats.failed} task${result.error ? ' / ' + result.error : ''}）`);
            }
            // 把 graph 结果转换为旧的 `out` 形状，下游 review loop 仍能消费
            out = _graphToPipelineOutputs(result.graph, [
                ['phase-A1-style', 'style-analyst'],
                ['phase-A2-world', 'world-architect'],
                ['phase-A3-character', 'character-architect'],
                ['phase-B1-theme', 'theme-architect'],
                ['phase-B2-plot', 'plot-architect'],
                ['phase-C-synthesize', 'outline-synthesizer'],
            ]);
        } else {
            // ===== 兜底路径：旧 _runPipeline（registry 没加载 / orchestrator 没初始化时）=====
            const phases = _legacyOutlinePhases(novelId);
            out = await _runPipeline(novelId, 'outline', phases.slice(0, 6), {
                jobId,
                manageLifecycle: false,
            });
        }

    // Phase D 循环（最多 3 轮）— 保持 imperative；D 是条件循环不进 DAG
    let round = 1;
    let finalReview = null;
    let phaseIndex = 6;
    while (round <= 3) {
        const reviewPhaseName = 'phase-D-review';
        _emit('phase_started', {
            novelId, jobId, pipeline: 'outline', phaseIndex,
            phaseName: reviewPhaseName, agents: ['outline-reviewer'], round,
        });
        const reviewInput = { outline: out['phase-C-synthesize']['outline-synthesizer'].output };
        const reviewOut = await _runAgent(novelId, 'outline-reviewer', reviewInput, {
            phaseIndex, phaseName: reviewPhaseName, role: '大纲评审', round, jobId,
        });
        const review = reviewOut.output || {};
        finalReview = review;
        _emit('phase_finished', {
            novelId, jobId, pipeline: 'outline', phaseIndex,
            phaseName: reviewPhaseName,
            summary: review.score != null ? `评分 ${review.score}/10` : '', round,
        });
        if (review.approved) break;
        if (round >= 3) {
            out['phase-C-synthesize']['outline-synthesizer'].output.__reviewLimitReached = true;
            break;
        }
        // 不通过 → 回到 C 修订
        const synthInput = {
            styleGuide: out['phase-A1-style']['style-analyst'].output,
            worlds: out['phase-A2-world']['world-architect'].output,
            characters: out['phase-A3-character']['character-architect'].output,
            themes: out['phase-B1-theme']['theme-architect'].output,
            plots: out['phase-B2-plot']['plot-architect'].output,
            lastReview: (review.feedback || []).map(f => `[${f.severity}] ${f.issue} → ${f.suggestion}`).join('\n'),
            round: round + 1,
        };
        const revisePhaseIndex = phaseIndex + 1;
        const revisePhaseName = 'phase-C-revise';
        _emit('phase_started', {
            novelId, jobId, pipeline: 'outline', phaseIndex: revisePhaseIndex,
            phaseName: revisePhaseName, agents: ['outline-synthesizer'], round: round + 1,
        });
        const synthOut = await _runAgent(novelId, 'outline-synthesizer', synthInput, {
            phaseIndex: revisePhaseIndex,
            phaseName: revisePhaseName,
            role: '大纲修订',
            round: round + 1,
            jobId,
        });
        out['phase-C-synthesize']['outline-synthesizer'] = synthOut;
        out['phase-C-synthesize']['outline-synthesizer'].__round = round + 1;
        _emit('phase_finished', {
            novelId, jobId, pipeline: 'outline', phaseIndex: revisePhaseIndex,
            phaseName: revisePhaseName, summary: '修订稿已生成', round: round + 1,
        });
        phaseIndex = revisePhaseIndex + 1;
        round++;
    }
    out['phase-D-review'] = { 'outline-reviewer': { output: finalReview } };

    // 持久化最终大纲
    const synthOut = out['phase-C-synthesize']['outline-synthesizer'];
    const parsed = synthOut.output || {};
    const novelRow = (_store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0]);
    if (!novelRow) throw new Error('小说不存在：' + novelId);

    const existing = (_store.query('SELECT novel_id FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) || null;
    if (existing) {
        _store.exec(
            `UPDATE _ainovel_outlines SET structure=?, world_setting=?, main_conflict=?, themes=?, global_characters=?, chapter_list=?, raw_outline=?, updated_at=? WHERE novel_id=?`,
            parsed.structure || null,
            parsed.world_setting || null,
            parsed.main_conflict || null,
            Array.isArray(parsed.themes) ? JSON.stringify(parsed.themes) : (parsed.themes || null),
            Array.isArray(parsed.global_characters) ? JSON.stringify(parsed.global_characters) : (parsed.global_characters || null),
            Array.isArray(parsed.chapter_list) ? JSON.stringify(parsed.chapter_list) : (parsed.chapter_list || null),
            synthOut.raw || synthOut.text || '',
            _now(),
            novelId
        );
    } else {
        _store.exec(
            `INSERT INTO _ainovel_outlines (novel_id, structure, world_setting, main_conflict, themes, global_characters, chapter_list, raw_outline, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            novelId,
            parsed.structure || null,
            parsed.world_setting || null,
            parsed.main_conflict || null,
            Array.isArray(parsed.themes) ? JSON.stringify(parsed.themes) : (parsed.themes || null),
            Array.isArray(parsed.global_characters) ? JSON.stringify(parsed.global_characters) : (parsed.global_characters || null),
            Array.isArray(parsed.chapter_list) ? JSON.stringify(parsed.chapter_list) : (parsed.chapter_list || null),
            synthOut.raw || synthOut.text || '',
            _now()
        );
    }

    // 创建 chapter 行
    if (Array.isArray(parsed.chapter_list)) {
        for (const ch of parsed.chapter_list) {
            const chapterId = _uuid();
            _store.exec(
                `INSERT OR IGNORE INTO _ainovel_chapters (id, novel_id, chapter_no, title, outline, target_word_count, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                chapterId, novelId,
                Number(ch.chapter_no) || 0,
                ch.title || null,
                ch.summary || null,
                Number(ch.target_word_count) || 3000,
                'pending'
            );
        }
    }

    _store.exec(`UPDATE _ainovel_novels SET status = 'writing', updated_at = ? WHERE id = ?`, _now(), novelId);
    dropContext(novelId);
    _emit('pipeline_finished', { novelId, jobId, pipeline: 'outline', result: out });
    _emit('outline_generated', { novelId, jobId, reviewScore: finalReview && finalReview.score, rounds: round });

    // ============ Phase 4-A: 故事架构层（顶层架构抽取）============
    // 在 outline pipeline 完成后，单独跑一个 story-architect agent
    // 抽取 3 幕结构 / 子线 / 弧线 / 主题 / 伏笔种子，持久化到 _ainovel_architecture
    // 注意：架构失败不应阻塞用户（用户已有可用大纲），仅 emit 警告
    let archResult = null;
    let archError = null;
    try {
        const archPhaseIndex = 4;
        const archPhaseName = 'phase-E-architecture';
        _emit('phase_started', {
            novelId, jobId, pipeline: 'outline', phaseIndex: archPhaseIndex,
            phaseName: archPhaseName, agents: ['story-architect'],
        });
        const archOut = await _runAgent(novelId, 'story-architect', { outline: parsed }, {
            phaseIndex: archPhaseIndex,
            phaseName: archPhaseName,
            role: '架构提取',
            jobId,
        });
        archResult = archOut;
        const archParsed = archOut.output || {};
        const archExisting = (_store.query('SELECT novel_id FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0]) || null;
        const archCols = [
            'three_act', 'plot_threads', 'character_arcs', 'theme_tracks', 'foreshadowing_seed', 'raw_architecture', 'updated_at',
        ];
        const archValues = [
            archParsed.three_act || null,
            JSON.stringify(archParsed.plot_threads || []),
            JSON.stringify(archParsed.character_arcs || []),
            JSON.stringify(archParsed.theme_tracks || []),
            JSON.stringify(archParsed.foreshadowing_seed || []),
            archOut.raw || archOut.text || '',
            _now(),
        ];
        if (archExisting) {
            const sets = archCols.map(c => `${c}=?`).join(', ');
            _store.exec(
                `UPDATE _ainovel_architecture SET ${sets} WHERE novel_id=?`,
                ...archValues, novelId
            );
        } else {
            const cols = ['novel_id', ...archCols].join(', ');
            const placeholders = archCols.map(() => '?').join(', ');
            _store.exec(
                `INSERT INTO _ainovel_architecture (${cols}) VALUES (?, ${placeholders})`,
                novelId, ...archValues
            );
        }
        _emit('phase_finished', {
            novelId, jobId, pipeline: 'outline', phaseIndex: archPhaseIndex,
            phaseName: archPhaseName,
            summary: `架构已生成（${(archParsed.plot_threads || []).length} 子线 / ${(archParsed.foreshadowing_seed || []).length} 伏笔种子）`,
        });
        _emit('architecture_generated', {
            novelId, jobId,
            plotThreadCount: (archParsed.plot_threads || []).length,
            foreshadowingSeedCount: (archParsed.foreshadowing_seed || []).length,
        });
    } catch (e) {
        archError = e.message || String(e);
        console.warn(`[novel-engine] story-architect failed for novel ${novelId}:`, archError);
        _emit('architecture_generation_failed', { novelId, jobId, error: archError });
        // 不抛：架构失败不影响 outline 已完成状态
    }

    if (archResult) out['phase-E-architecture'] = { 'story-architect': archResult };
    return out;
    } catch (e) {
        _emit('pipeline_failed', { novelId, jobId, pipeline: 'outline', error: e.message || String(e) });
        throw e;
    } finally {
        _jobEnd(novelId, jobId);
    }
}

// ============ Chapter Pipeline (Phase 2) ============
// 5 个 agent 协作：scene-planner / chapter-streamer（流式写正文）/ continuity-checker /
// style-editor / quality-reviewer。chapter-writer skill 保留为 thin wrapper，调 _runChapterPipeline。

// ---- Agent 1: scene-planner ----
registerSkill({
    name: 'scene-planner',
    displayName: '场景规划师',
    workspaceDir: './agents/scene-planner/',
    description: '把章节大纲拆分为 3-5 个场景分镜',
    temperature: 0.5,
    systemPrompt: `你是一位小说场景规划师。任务：把一章的【章节大纲】细化为 3-5 个**具体场景**。

【任务说明】
章节大纲是粗线条的目标与转折。你要把这一章拆成一系列连续场景，每个场景 ≈ 600-1200 字（按章节目标字数动态调整），整体加起来 ≈ 章节目标字数。

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "scenes": [
    {
      "index": 1,
      "goal": "本场景要达成的叙事目标",
      "conflict": "场景内的张力/冲突",
      "charactersInvolved": ["主角名", "配角名"],
      "keyDialogue": "一句代表性对话示例（可选）",
      "transition": "如何过渡到下一场景（如时间跳转 / 地点切换 / 视角聚焦转移）"
    }
  ],
  "totalEstimatedWords": 3500
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const outline = ctx.outline;
        const chapter = input.chapter;
        const characters = outline?.global_characters ? safeJson(outline.global_characters) : [];
        // 衔接上下文：前 1 章结尾 + 后 1 章大纲，避免场景断层
        const allChapters = Array.from(ctx.chapters.values()).sort((a, b) => a.chapter_no - b.chapter_no);
        const idx = allChapters.findIndex(c => c.id === chapter.id);
        const prevChapter = idx > 0 ? allChapters[idx - 1] : null;
        const nextChapter = idx >= 0 && idx < allChapters.length - 1 ? allChapters[idx + 1] : null;
        const userPrompt = `【全书背景】
- 风格：${novelRow.style || ''} / ${novelRow.custom_style || ''}
- 视角：${novelRow.pov || ''}
- 基调：${novelRow.tone || ''}
- 世界观：${outline?.world_setting || ''}
- 主冲突：${outline?.main_conflict || ''}
- 主要人物：${Array.isArray(characters) ? characters.map(c => c.name + '（' + c.role + '）').join('、') : ''}
- 整体结构：${outline?.structure || '（未指定）'}

${prevChapter ? `【前章衔接（必须延续）】
${chapterIntegrity.boundary(prevChapter)}
- 本章开篇必须从前章结尾自然过渡，不能凭空开始` : '（这是第一章）'}

${nextChapter ? `【下章预告（结尾要为它铺垫）】
- 第 ${nextChapter.chapter_no} 章《${nextChapter.title || ''}》：${nextChapter.outline || nextChapter.summary || '（无）'}` : ''}

【本章任务】
- 章节号：第 ${chapter.chapter_no} 章
- 章节名：${chapter.title || '（请起一个）'}
- 大纲：${chapter.outline || '（无）'}
- 目标字数：${chapter.target_word_count || 3000} 字

${_chapterPlanningContext(novelRow.id, chapter.chapter_no)}
【写作前已发生的状态】
${JSON.stringify(ctx.storyState || {})}

请输出 JSON 场景分镜（3-5 个场景，合计字数 ≈ 章节目标字数）。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 2000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text);
        if (!parsed || !Array.isArray(parsed.scenes) || !parsed.scenes.length || parsed.scenes.some(v => !v || typeof v.goal !== 'string')) throw new Error('场景规划结果无效，请重试');
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 2: chapter-streamer（流式写正文）----
registerSkill({
    name: 'chapter-streamer',
    displayName: '章节写手',
    workspaceDir: './agents/chapter-streamer/',
    description: '根据场景分镜 + 全文上下文流式写出章节正文',
    temperature: 0.85,
    systemPrompt: `你是一位专业小说家。根据全书设定、章节交接和场景分镜写完整正文。
保持因果、人物知识、伤势、物品、称谓和叙事视角一致。开篇自然接续前章未完动作、对话与情绪。
允许有依据的转场、时间跳跃和视角切换；不要机械重复时间地点或每章重述五要素。
收到【待修订原稿】时，只修复评审指出的问题及必要的相邻过渡，保留其余剧情、措辞和段落，返回完整修订正文。
只输出小说正文，不输出解释、JSON或章节标题。字数接近目标，不能复述前章已经发生的事件。`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const outline = ctx.outline;
        const chapter = input.chapter;
        if (!chapter) return { ok: false, error: '缺少 chapter' };

        // 前 5 章摘要 + 后 2 章梗概（扩大上下文，避免与近章重复/断层）
        const allChapters = Array.from(ctx.chapters.values()).sort((a, b) => a.chapter_no - b.chapter_no);
        const idx = allChapters.findIndex(c => c.id === chapter.id);
        const before = allChapters.slice(Math.max(0, idx - 5), idx);
        const after = allChapters.slice(idx + 1, idx + 3);
        const prevChapter = idx > 0 ? allChapters[idx - 1] : null;  // 紧邻前章，用于注入末尾原文

        // 故事弧线定位：根据章节号推断当前在第几幕
        const totalChapters = allChapters.length;
        let arcPosition = '';
        if (totalChapters > 0) {
            const pct = chapter.chapter_no / totalChapters;
            arcPosition = `全书章节进度 ${Math.round(pct * 100)}%，具体节奏以结构方案和分卷计划为准`;
        }

        const characters = outline?.global_characters ? safeJson(outline.global_characters) : [];
        const themes = outline?.themes ? safeJson(outline.themes) : [];
        const scenes = input.scenes || [];

        // ===== 连贯性上下文注入：前章末尾原文 + 圣经状态 =====
        // 1) 前章末尾原文（最后 ~1500 字）：用于术语/人物状态/场景衔接
        const prevTail = prevChapter && prevChapter.content
            ? String(prevChapter.content).slice(-1500)
            : '';
        // 2) 圣经状态：人物/伏笔/剧情线（从 DB 取，缺则跳过）
        let bibleBlock = '';
        try {
            const st = ctx.storyState ? { ok: true, state: ctx.storyState } : getNovelState(novelRow.id);
            if (st && st.ok && st.state) {
                const s = st.state;
                const charStateLines = Object.entries(s.character_states || {})
                    .map(([name, st]) => `  - ${name}: ${JSON.stringify(st)}`)
                    .join('\n');
                const threadLines = (s.active_plot_threads || [])
                    .map(t => `  - ${t.id || '?'}: ${t.description || ''} (progress=${t.progress_pct || 0}%, last_ch=${t.last_chapter || '?'})`)
                    .join('\n');
                const foreLines = (s.planted_foreshadowing || [])
                    .filter(f => f.status !== 'paid' && f.status !== 'abandoned')
                    .map(f => `  - ${f.id || '?'}: ${f.description || ''} (埋设于第 ${f.planted_ch || '?'} 章，预计回收于第 ${f.payoff_ch_estimate || '?'} 章)`)
                    .join('\n');
                bibleBlock = `【圣经状态（必须遵守）】
人物状态：
${charStateLines || '  （无）'}
剧情线：
${threadLines || '  （无）'}
未回收伏笔：
${foreLines || '  （无）'}`;
            }
        } catch (e) { /* 圣经缺失不阻塞 */ }

        const userPrompt = `【全书信息】
- 标题：${novelRow.title}
- 风格：${novelRow.style || ''}${novelRow.custom_style ? ' / ' + novelRow.custom_style : ''}
- 核心创意：${novelRow.core_idea}
- 视角：${novelRow.pov || ''}
- 基调：${novelRow.tone || ''}
- 世界观：${outline?.world_setting || ''}
- 主冲突：${outline?.main_conflict || ''}
- 主题：${Array.isArray(themes) ? themes.join('、') : ''}
- 主要人物：${Array.isArray(characters) ? characters.map(c => `${c.name}（${c.role}）：${c.description || ''}；arc=${c.arc || ''}`).join('\n  ') : ''}

【结构方案】
${outline?.structure || ''}

${_chapterPlanningContext(novelRow.id, chapter.chapter_no)}

【故事弧线定位】
${arcPosition || '（章节序号未知）'}
- 当前是第 ${chapter.chapter_no} 章 / 共 ${totalChapters || '?'} 章

【近 5 章摘要（避免重复 / 承接上文）】
${before.length ? before.map(c => `第 ${c.chapter_no} 章《${c.title || ''}》：${c.summary || c.outline || ''}`).join('\n') : '（这是开篇前 5 章）'}

${chapterIntegrity.boundary(prevChapter)}

${bibleBlock}

【场景分镜（按顺序写）】
${scenes.map((s, i) => `场景 ${i + 1}：${s.goal || ''}
  冲突：${s.conflict || ''}
  出场：${(s.charactersInvolved || []).join('、') || '—'}
  关键对话：${s.keyDialogue || '—'}
  过渡：${s.transition || ''}`).join('\n\n') || '（无场景分镜，按章节大纲直接写）'}

【本章任务】
- 章节号：第 ${chapter.chapter_no} 章
- 章节名：${chapter.title || '（请起一个）'}
- 本章大纲：${chapter.outline || ''}
- 目标字数：${chapter.target_word_count || 3000} 字

${after.length ? `【下一章预告】\n下一章：${after[0].title || ''} - ${after[0].outline || after[0].summary || ''}\n（本章结尾要为下一章铺垫）` : '（这是最后一章，请给出完整结局）'}

${input.currentDraft ? `\n【待修订原稿】\n${input.currentDraft}\n` : ''}
${input.lastReview ? `\n【上一轮评审反馈（必须改进）】\n${input.lastReview}\n` : ''}
请按 system 提示输出本章正文（纯文本，开头为标题）。`;

        const cfg = ctx.provider;
        const maxTokens = Math.max(cfg.max_tokens || 4000, Math.ceil((chapter.target_word_count || 3000) * 1.5));
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider,
            base_url: cfg.base_url,
            api_key: cfg.api_key,
            model: cfg.model,
            system: ctx._skill.systemPrompt,
            user: userPrompt,
            temperature: cfg.temperature != null ? cfg.temperature : ctx._skill.temperature,
            max_tokens: Math.min(maxTokens, 16000),
            signal: ctx.signal,
        }), onChunk);

        // 解析正文：去掉首行 markdown 标题
        let content = (res.text || '').trim();
        content = content.replace(/^#\s*[^\n]*\n+/, '');
        const wordCount = _countWords(content);

        return {
            output: { content, wordCount, scenes },
            raw: res.text,
            text: res.text,
            content,                       // 直接返回 content 方便 phase handler 取
            wordCount,
            scenes,
            prompt_tokens: res.prompt_tokens,
            completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd,
            estimated: res.estimated,
        };
    },
});

// ---- Agent 3: continuity-checker ----
registerSkill({
    name: 'continuity-checker',
    displayName: '连续性审查员',
    workspaceDir: './agents/continuity-checker/',
    description: '对照前几章摘要检查本章的连贯性（人物 / 时间线 / 伏笔）',
    category: 'polish',
    temperature: 0.3,
    systemPrompt: `你是小说连续性审查员。任务：检查本章正文与【前几章摘要】+【本章大纲】是否一致。

【检查维度】
- 人物状态 / 名字 / 称呼是否前后一致
- 时间线是否合理（不能回退或跳跃不合逻辑）
- 已埋的伏笔 / 设定是否被违反
- 本章大纲列出的事件是否都有体现

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "approved": true,                   // bool：是否通过
  "issues": [
    { "type": "人物|时间线|伏笔|事件遗漏", "detail": "具体问题描述", "severity": "critical|major|minor" }
  ],
  "summary": "一两句话总结本章连续性状况"
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const outline = ctx.outline;
        const allChapters = Array.from(ctx.chapters.values()).sort((a, b) => a.chapter_no - b.chapter_no);
        const idx = allChapters.findIndex(c => c.id === input.chapterId);
        const before = allChapters.slice(Math.max(0, idx - 5), idx);
        const prevChapter = idx > 0 ? allChapters[idx - 1] : null;
        const prevTail = prevChapter && prevChapter.content
            ? String(prevChapter.content).slice(-1500)
            : '';
        const userPrompt = `【本章基本信息】
- 章节号：第 ${input.chapterNo} 章
- 章节名：${input.chapterTitle || ''}
- 大纲：${input.chapterOutline || ''}

【全书架构（必须对照）】
- 整体结构：${outline?.structure || '（未指定）'}
- 世界观：${(outline?.world_setting || '').slice(0, 600)}
- 主冲突：${outline?.main_conflict || ''}
- 主题：${(() => { try { return Array.isArray(JSON.parse(outline?.themes || '[]')) ? JSON.parse(outline.themes).join('、') : (outline?.themes || ''); } catch { return outline?.themes || ''; } })()}

【近 5 章摘要（连续性 / 时间线 / 伏笔一致性）】
${before.length ? before.map(c => `第 ${c.chapter_no} 章《${c.title || ''}》：${c.summary || c.outline || ''}`).join('\n') : '（这是开篇前 5 章）'}

${chapterIntegrity.boundary(prevChapter)}
【写作前人物与剧情状态】
${JSON.stringify(ctx.storyState || {})}

【本章正文】
${(input.content || '')}

【检查要求 — 在原有 6 项基础上新增连贯性专项】
1. 人物状态 / 名字 / 称呼是否前后一致
2. 时间线是否合理
3. 是否违反全书架构（结构 / 世界观规则 / 主冲突方向）
4. 主题是否被本章推进 / 是否漂离
5. 已知伏笔是否被本章合理处理
6. 本章大纲列出的事件是否都有体现
7. **【术语锁定】**对比紧邻前章末尾原文，本章出现的所有专有名词（人名/地名/灵庄名/符名/丹药名/势力名/法宝名）是否原样沿用？若有改名/翻译/缩写，标记为 critical issue 并指出前章原名与本章错名。
8. **【状态承接】**前章末尾主角处于什么状态（昏迷/清醒/受伤/能说话吗/在哪里），本章开篇是否承接？若出现无承接的跳变，标记为 critical issue。
9. 检查前章末尾与本章开头的动作、对话、指代及情绪是否自然衔接；区分矛盾与合理转场。
10. 不要求前500字机械重述全部时间地点。称谓允许已建立的别名；检查无依据的改名。
11. 每项问题给出原文证据与具体修复建议，只有实际矛盾或重要因果缺失才判 major/critical。
请输出 JSON 评审结果。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 1500,
            signal: ctx.signal,
        }), onChunk);
        const parsed = chapterIntegrity.reviewOutput(_tryParseJson(res.text), ctx.agentName || ctx._skill.name);
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 4: style-editor ----
registerSkill({
    name: 'style-editor',
    displayName: '文风编辑',
    workspaceDir: './agents/style-editor/',
    description: '检查本章语气 / 文风 / 词汇是否符合全书风格',
    category: 'polish',
    temperature: 0.3,
    systemPrompt: `你是文风编辑。任务：检查本章的【语气、词汇、句式】是否匹配【全书风格指南 + 基调 + 视角】。

【检查维度】
- 视角是否一致（不要中途切换第一/第三人称）
- 基调是否稳定（不要突然过度煽情或冷幽默）
- 词汇是否符合风格（玄幻题材用了都市网络流行语就扣分；学术题材用了口语化表达就扣分）
- 句式节奏是否符合全书风格

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "approved": true,
  "toneScore": 8,                     // 0-10
  "issues": [
    { "type": "视角|基调|词汇|句式", "detail": "具体问题", "severity": "critical|major|minor" }
  ],
  "suggestions": "可执行的修改建议（给 chapter-streamer 重写用）"
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const userPrompt = `【全书风格】
- 风格标签：${novelRow.style || ''} / ${novelRow.custom_style || ''}
- 视角：${novelRow.pov || ''}
- 基调：${novelRow.tone || ''}

【前章交接与语言样本】
${chapterIntegrity.boundary(Array.from(ctx.chapters.values()).filter(c => c.chapter_no < (ctx.chapters.get(input.chapterId)?.chapter_no || 0)).sort((a, b) => b.chapter_no - a.chapter_no)[0])}
重点对照本章开头：叙述距离、人物口吻、称谓、指代和句式节奏；合理情绪变化不算文风错误。

【本章正文】
${(input.content || '')}

请输出 JSON 文风评估。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 1500,
            signal: ctx.signal,
        }), onChunk);
        const parsed = chapterIntegrity.reviewOutput(_tryParseJson(res.text), ctx.agentName || ctx._skill.name);
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 5: quality-reviewer ----
registerSkill({
    name: 'quality-reviewer',
    displayName: '质量评审员',
    workspaceDir: './agents/quality-reviewer/',
    description: '综合打分（节奏 / 语法 / 沉浸感 / 钩子）',
    category: 'review',
    temperature: 0.3,
    systemPrompt: `你是小说质量评审。任务：从【节奏、语法、沉浸感、章节钩子】四个维度对本章打分。

【评分维度（各 0-10）】
- pacing：场景切换是否自然，节奏是否有张有弛
- grammar：语法 / 错别字 / 标点
- immersion：是否能让读者投入
- hook：章节结尾钩子是否吸引人继续读

【输出要求】
严格 JSON 格式（不要 markdown 包裹）：
{
  "approved": true,                   // 总分 ≥ 6 视为通过
  "score": 7.5,                       // 综合分 = 四维平均
  "pacing": 7,
  "grammar": 8,
  "immersion": 7,
  "hook": 8,
  "feedback": "整体评价 + 给 chapter-streamer 重写的反馈"
}${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const userPrompt = `【章节信息】
- 章节号：第 ${input.chapterNo} 章
- 章节名：${input.chapterTitle || ''}
- 目标字数：${input.targetWordCount || 3000}

【本章正文】
${(input.content || '')}

请输出 JSON 评分。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 1500,
            signal: ctx.signal,
        }), onChunk);
        const parsed = chapterIntegrity.reviewOutput(_tryParseJson(res.text), ctx.agentName || ctx._skill.name);
        return {
            output: parsed,
            raw: res.text,
            text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 13: character-state-updater（Phase 4-C：从章节正文提取人物状态变更）----
registerSkill({
    name: 'character-state-updater',
    displayName: '人物状态追踪员',
    workspaceDir: './agents/character-state-updater/',
    description: '从章节正文抽取人物状态变化（位置/动机/认知）',
    temperature: 0.3,
    systemPrompt: `你是小说人物状态追踪员。任务：从已写章节的【正文】中抽取**主要角色的状态变更**，输出 JSON 供「圣经」持久化。

【输出要求】
严格 JSON（不要 markdown）：
{
  "updates": [
    {
      "name": "角色名",
      "status": "alive|dead|missing|injured",         // 本章结尾状态
      "location": "当前位置（城市/场所）",
      "motivation": "当前主要动机（一句话）",
      "knowledge": "本章获得的关键认知/秘密",          // 可空
      "relationship_changes": "关系变化（如有，如'主角对师父由信任转为怀疑'）"  // 可空
    }
  ]
}

【关键要求】
- 只输出本章有明确变化或重要的角色（不要列出所有提及的角色）
- 状态枚举严格按 alive/dead/missing/injured；其他写 status 自由文本
- 若本章无新角色状态变化，返回 {"updates": []}
- 用中文输出${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const content = input.content || '';
        const chapterNo = input.chapterNo || '?';
        const charList = input.characterList || [];
        const userPrompt = `【章节号】第 ${chapterNo} 章
【主要角色】${charList.join('、') || '（无）'}

【章节正文】
${content}

请输出本章人物状态变更的 JSON。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 4000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text);
        if (!parsed) throw new Error('状态提取结果无法解析，请重试');
        return {
            output: parsed,
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 14: plot-thread-tracker（Phase 4-C：从章节正文推进剧情子线进度）----
registerSkill({
    name: 'plot-thread-tracker',
    displayName: '剧情进度追踪员',
    workspaceDir: './agents/plot-thread-tracker/',
    description: '从章节正文推进剧情子线进度（推进百分比）',
    temperature: 0.3,
    systemPrompt: `你是剧情进度追踪员。任务：从章节【正文】中判断每条【剧情子线】的推进程度，输出 JSON 供「圣经」持久化。

【输出要求】
严格 JSON：
{
  "threads": [
    {
      "id": "PT001",                  // 必须从输入的 ID 中选
      "current_ch": 5,                // 当前所在章节号
      "progress_pct": 60,             // 本章结束后这条线的总体进度（0-100）
      "last_event": "本章这条线的关键事件（一句话）"
    }
  ],
  "new_threads": [                   // 本章新引入的子线（不在输入列表里）
    {
      "id": "PT004",
      "name": "新子线名",
      "description": "一句话",
      "intro_ch": 5,
      "resolve_ch_estimate": 15,
      "status": "active"
    }
  ]
}

【关键要求】
- 必须从输入的【已有子线 ID】列表里选 id；若本章某条线无进展，progress_pct 保持或微调
- progress_pct 是「这条线整体故事的完成度」，不是「本章内推进百分比」
- 若本章完全没有剧情推进，返回 {"threads": [], "new_threads": []}
- 用中文输出${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const content = input.content || '';
        const chapterNo = input.chapterNo || '?';
        const existingThreads = input.existingThreads || [];
        const userPrompt = `【章节号】第 ${chapterNo} 章
【已有剧情子线】
${JSON.stringify(existingThreads, null, 2)}

【章节正文】
${content}

请输出本章子线推进状态的 JSON。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 4000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text);
        if (!parsed) throw new Error('状态提取结果无法解析，请重试');
        return {
            output: parsed,
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Sprint 7.3: memory-extractor skill ----
// 从章节正文提取关键记忆（细节 1-5 条，importance 3+）
registerSkill({
    name: 'memory-extractor',
    displayName: '记忆提取员',
    workspaceDir: './agents/memory-extractor/',
    description: '从章节正文提取关键细节（人物动机 / 物品 / 地点 / 未兑现承诺）',
    category: 'review',
    temperature: 0.3,
    inputSchema: {
        novelId: 'string',
        chapter_no: 'number',
        chapter_content: 'string',
        outline_summary: 'string?',
    },
    outputSchema: {
        memories: [{ content: 'string', category: 'string', importance: 'number', snippet: 'string?' }],
    },
    whenToUse: '章节写作后调用，提取本章关键细节。',
    run: async (ctx) => {
        const cfg = _getProviderConfig(ctx);
        const userPrompt = `【章节号】${ctx.input.chapter_no}
【大纲摘要】
${(ctx.input.outline_summary || '（无）').slice(0, 800)}

【章节正文】
${(ctx.input.chapter_content || '').slice(0, 8000)}

【输出】严格 JSON：
{
  "memories": [
    { "content": "主角母亲死于三年前大火", "category": "event", "importance": 8, "snippet": "原文片段" },
    { "content": "铜钥匙是母亲遗物", "category": "item", "importance": 9, "snippet": "..." }
  ]
}
约束：1-5 条；importance >= 3；不超过 3 句/条；不要重复大纲已有内容。`;
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generate(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 1500,
            signal: ctx.signal,
        }));
        const parsed = _tryParseJson(res.text) || { memories: [] };
        return {
            output: parsed,
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- Agent 15: foreshadowing-extractor（Phase 4-C：从章节正文识别新伏笔/回收伏笔）----
registerSkill({
    name: 'foreshadowing-extractor',
    displayName: '伏笔追踪员',
    workspaceDir: './agents/foreshadowing-extractor/',
    description: '从章节正文识别新伏笔 + 标记已回收伏笔',
    category: 'review',  // Sprint 7.2: 标记为 review 类
    temperature: 0.3,
    systemPrompt: `你是伏笔追踪员。任务：从章节【正文】中识别：
1. 本章**新埋设**的伏笔
2. 本章**回收/揭晓**的已有伏笔

【输出要求】
严格 JSON：
{
  "planted": [         // 本章新埋的伏笔
    {
      "id": "F###",   // 用 F001 起递增；若输入给了 planted_foreshadowing，从 max id + 1 开始
      "description": "伏笔内容（一句话）",
      "planted_ch": 5,
      "payoff_ch_estimate": 18,    // 预计在哪章回收
      "status": "planted"
    }
  ],
  "paid": [            // 本章已回收的伏笔（从已有 ID 列表里选 id）
    {
      "id": "F003",
      "paid_ch": 5,
      "payoff_summary": "如何被揭示/回收的（一句话）"
    }
  ]
}

【关键要求】
- planted 不少于 1 个（除非本章纯过渡无伏笔），且 description 要具体（不要写"主角命运"这种空话）
- paid 只在确实回收时输出；若没有回报空数组
- 用中文输出${JSON_QUOTE_RULE}`,
    run: async (input, ctx) => {
        const content = input.content || '';
        const chapterNo = input.chapterNo || '?';
        const existingForeshadowing = input.existingForeshadowing || [];
        const userPrompt = `【章节号】第 ${chapterNo} 章
【已有伏笔（注意避免重复 ID）】
${JSON.stringify(existingForeshadowing, null, 2)}

【章节正文】
${content}

请输出本章伏笔操作的 JSON。`;
        const cfg = ctx.provider;
        const onChunk = (chunk, acc) => { ctx._chunk && ctx._chunk(chunk, acc); };
        ctx._recordPrompt && ctx._recordPrompt({ system: ctx._skill.systemPrompt, user: userPrompt });
        const res = await novel.generateStream(_buildStreamOpts(ctx, {
            provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key,
            model: cfg.model, system: ctx._skill.systemPrompt, user: userPrompt,
            temperature: ctx._skill.temperature, max_tokens: cfg.max_tokens || 4000,
            signal: ctx.signal,
        }), onChunk);
        const parsed = _tryParseJson(res.text);
        if (!parsed) throw new Error('状态提取结果无法解析，请重试');
        return {
            output: parsed,
            raw: res.text, text: res.text,
            prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens,
            cost_usd: res.cost_usd, estimated: res.estimated,
        };
    },
});

// ---- chapter-writer 改为 thin wrapper：director 优先 + pipeline fallback ----
registerSkill({
    name: 'chapter-writer',
    displayName: '章节生成（兼容）',
    workspaceDir: './agents/chapter-writer/',
    description: 'Phase 2: 多 agent 协作生成章节（thin wrapper）',
    whenToUse: '需要把某一章从「大纲条目」写成「完整正文」时（含场景规划 + 写作 + 校对）。',
    inputSchema: '{ "novelId": "string", "chapterId": "string" }',
    outputSchema: '{ "ok": true, "content": "正文", "word_count": int }',
    systemPrompt: '(wrapper)',
    run: async (input, ctx) => {
        const novelRow = ctx.novel;
        const novelId = novelRow.id;
        const chapterId = input.chapterId || (input.chapter && input.chapter.id);
        if (!chapterId) return { ok: false, error: '缺少 chapterId' };
        const chRow = (input.chapter && input.chapter.chapter_no != null)
            ? input.chapter
            : (_store.query('SELECT * FROM _ainovel_chapters WHERE id = ?', chapterId)[0] || {});
        const out = await _runChapterPipeline(novelId, chapterId);
        return { ok: true, content: out.__finalContent, word_count: out.__finalWordCount, via: 'pipeline',
            prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, duration_ms: 0 };
    },
});

// director 模式下，从 skillResults / DB 里回收章节正文
function _extractChapterFromDirector(novelId, chapterId, directorResult) {
    const results = (directorResult && directorResult.skillResults) || [];
    for (let i = results.length - 1; i >= 0; i--) {
        const r = results[i];
        if (r.skill !== 'chapter-streamer' && r.skill !== 'style-editor') continue;
        const o = r.output && (r.output.output || r.output);
        const content = o && (o.content || o.text);
        if (content && String(content).length > 50) {
            return { content: String(content), wordCount: (o && o.wordCount) || _countWords(String(content)) };
        }
    }
    // DB 兜底：director 里的 skill 可能已经把正文落库
    try {
        const row = _store.query('SELECT content, word_count FROM _ainovel_chapters WHERE id = ?', chapterId)[0];
        if (row && row.content && String(row.content).length > 50) {
            return { content: row.content, wordCount: row.word_count || _countWords(row.content) };
        }
    } catch (e) { /* ignore */ }
    return null;
}

// ---- Chapter Pipeline 编排 ----
// ============ Phase 4-D: 架构执行钩子 ============
// 在 _runChapterPipeline 开始时跑一系列轻量校验
// 检查项：弧位置、人物引用、伏笔回收、子线推进
// 失败仅记录警告（不阻塞章节写作）；用户在工作台/日志 Tab 可见
function _preChapterWriteCheck(novelId, chapter) {
    if (!_store) return { ok: false, warnings: [] };
    const warnings = [];

    // 1. 弧位置校验：当前章节是否在正确的幕范围
    const arch = _store.query('SELECT * FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0];
    const outline = _store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0];
    if (arch) {
        const chapterList = outline ? _safeJson(outline.chapter_list, []) : [];
        const totalChapters = chapterList.length || 0;
        if (totalChapters > 0) {
            const pct = chapter.chapter_no / totalChapters;
            const expectedAct = pct <= 0.25 ? '第一幕·建置' : (pct <= 0.75 ? '第二幕·对抗' : '第三幕·结局');
            warnings.push({
                kind: 'arc-position',
                severity: 'info',
                chapter: chapter.chapter_no,
                expected: expectedAct,
                actual: `第 ${chapter.chapter_no} / ${totalChapters} 章`,
                pct: Math.round(pct * 100),
            });
        }
        // 2. 伏笔回收检查：是否到了计划回收章节
        const fores = _safeJson(arch.foreshadowing_seed, []);
        const dueFores = fores.filter(f =>
            f.status !== 'paid' &&
            f.payoff_chapter_estimate &&
            Math.abs(f.payoff_chapter_estimate - chapter.chapter_no) <= 2
        );
        for (const f of dueFores) {
            warnings.push({
                kind: 'foreshadowing-due',
                severity: 'warn',
                chapter: chapter.chapter_no,
                foreshadowingId: f.id,
                description: f.description,
                plannedPayoffChapter: f.payoff_chapter_estimate,
            });
        }
        // 3. 子线推进检查：是否有到计划回收章节的子线
        const threads = _safeJson(arch.plot_threads, []);
        const dueThreads = threads.filter(t =>
            t.status === 'active' &&
            t.resolve_ch &&
            Math.abs(t.resolve_ch - chapter.chapter_no) <= 2
        );
        for (const t of dueThreads) {
            warnings.push({
                kind: 'thread-due',
                severity: 'warn',
                chapter: chapter.chapter_no,
                threadId: t.id,
                threadName: t.name,
                plannedResolveChapter: t.resolve_ch,
            });
        }
    }

    // 4. 人物引用检查：outline 中的人物是否在最近章节的 content 中出现（粗略）
    // 这里只检查"是否本章 outline 提及的人物在 bible 里有记录"
    const stateRow = _store.query('SELECT character_states FROM _ainovel_novel_state WHERE novel_id = ?', novelId)[0];
    if (stateRow && stateRow.character_states) {
        const charStates = _safeJson(stateRow.character_states, {});
        const charList = outline ? _safeJson(outline.global_characters, []) : [];
        const mentionedInBible = charList.map(c => c.name).filter(n => charStates[n]);
        if (charList.length && mentionedInBible.length === 0) {
            warnings.push({
                kind: 'no-character-in-bible',
                severity: 'warn',
                chapter: chapter.chapter_no,
                outlineCharacters: charList.map(c => c.name),
                note: '圣经尚无人物状态记录，章节写作将以"无圣经"模式继续',
            });
        }
    }

    return { ok: true, warnings };
}

// Chapter jobs keep a stable pre-chapter snapshot through generation and retries.
const _chapterRuns = new Map();

function _chapterPlanningContext(novelId, chapterNo) {
    const active = listArcs(novelId).find(a => chapterNo >= a.startCh && chapterNo <= a.endCh);
    const architecture = _store.query('SELECT character_arcs, theme_tracks FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0];
    return '【全书与分卷规划（计划不是已发生事实）】\n' +
        (active ? `当前卷：${active.title}（第 ${active.startCh}-${active.endCh} 章）；目标：${active.goal || ''}\n` : '') +
        (architecture ? `人物成长计划：${architecture.character_arcs || ''}\n主题推进：${architecture.theme_tracks || ''}\n` : '') +
        '本章推进当前卷目标，转折必须由人物行动和已知事实引起；不得提前把未来计划当作人物已知的信息。';
}

function _invalidateChapterContinuity(novelId, chapterId) {
    const row = _store.query('SELECT chapter_no FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0];
    if (!row) return;
    _store.exec(`UPDATE _ainovel_chapters SET continuity_dirty = 1, draft_meta = NULL
        WHERE novel_id = ? AND chapter_no >= ? AND (status = 'done' OR content IS NOT NULL)`, novelId, row.chapter_no);
    dropContext(novelId);
}

function _chapterProgress(novelId, stage, message, detail = '') {
    const run = _chapterRuns.get(novelId);
    if (!run) return;
    _emit('chapter_progress', { novelId, chapterId: run.chapter.id, chapterNo: run.chapter.chapter_no,
        jobId: run.jobId, stage, message, detail });
}

function _prepareChapterRun(novelId, chapter, jobId) {
    const previous = _store.query('SELECT * FROM _ainovel_chapters WHERE novel_id = ? AND chapter_no < ? ORDER BY chapter_no DESC', novelId, chapter.chapter_no);
    const unfinished = previous.find(c => c.status !== 'done' || c.continuity_dirty);
    if (unfinished) throw new Error(`请先完成第 ${unfinished.chapter_no} 章的衔接复核，再继续本章`);
    const prev = previous[0] || null;
    if (chapter.chapter_no > 1 && (!prev || prev.chapter_no !== chapter.chapter_no - 1)) {
        throw new Error('缺少紧邻前章，请先补齐章节');
    }
    const stored = getNovelState(novelId).state;
    let base = prev ? _safeJson(prev.state_snapshot, null) : {
        character_states: {}, active_plot_threads: [], planted_foreshadowing: [], retired_characters: [], global_summary: '', last_chapter_no: 0,
    };
    if (!base && stored.last_chapter_no === prev.chapter_no) base = stored;
    if (!base) {
        // Legacy books are reviewed in order; never inject states from future chapters.
        _store.exec(`UPDATE _ainovel_chapters SET continuity_dirty = 1 WHERE novel_id = ? AND chapter_no < ? AND status = 'done'`, novelId, chapter.chapter_no);
        throw new Error('旧小说需要补建章节交接记录，点击继续后会从前章依次复核，保留已有正文');
    }
    const outlineVersion = JSON.stringify(_store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]);
    const fingerprint = chapterIntegrity.hash(JSON.stringify({ content: chapter.content, outline: chapter.outline,
        title: chapter.title, prev: prev && chapterIntegrity.hash(prev.content), base, revision: stored.expected_revision,
        outlineVersion }));
    const run = { chapter, jobId, previous: prev, base, fingerprint, revision: stored.expected_revision,
        originalContent: chapter.content, outlineVersion, controller: new AbortController() };
    _chapterRuns.set(novelId, run);
    return run;
}

function _checkpointChapter(novelId, content, meta) {
    const run = _chapterRuns.get(novelId);
    _store.exec(`UPDATE _ainovel_chapters SET draft_content = ?, draft_meta = ? WHERE id = ?`,
        content, JSON.stringify({ ...meta, fingerprint: run.fingerprint }), run.chapter.id);
}

async function _extractChapterHandoff(novelId, chapter, content) {
    const cfg = _getProviderConfig();
    const run = _chapterRuns.get(novelId);
    const res = await novel.generate({
        provider: cfg.provider, base_url: cfg.base_url, api_key: cfg.api_key, model: cfg.model,
        system: '你是小说交接编辑。阅读完整正文，记录已经发生的事实，禁止把大纲计划写成事实。只输出 JSON：' +
            '{"summary":"100-200字摘要，覆盖整章尤其章末转折", "time":"章末时间，未知写未明确", "location":"章末地点", ' +
            '"pov":"章末视角", "present_characters":["章末在场人物"], "open_actions":["未完动作、对话、承诺或悬念"], ' +
            '"narrative_voice":"章末情绪、称谓和语言节奏"}。所有字段必填，无事项用空数组。',
        user: `第 ${chapter.chapter_no} 章《${chapter.title || ''}》\n【完整正文】\n${content}`,
        temperature: 0.2, max_tokens: 1800, signal: run && run.controller.signal,
    });
    return chapterIntegrity.validateHandoff(_tryParseJson(res.text), content);
}

function _commitChapter(novelId, content, handoff, patch) {
    const run = _chapterRuns.get(novelId);
    run.controller.signal.throwIfAborted();
    let next;
    _store.transaction(() => {
        const fresh = _store.query('SELECT * FROM _ainovel_chapters WHERE id = ?', run.chapter.id)[0];
        const prev = run.previous && _store.query('SELECT * FROM _ainovel_chapters WHERE id = ?', run.previous.id)[0];
        if (!fresh || fresh.content !== run.originalContent || fresh.outline !== run.chapter.outline || fresh.title !== run.chapter.title ||
            JSON.stringify(_store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) !== run.outlineVersion ||
            (run.previous && (!prev || prev.continuity_dirty || prev.content !== run.previous.content))) {
            throw new Error('写作期间正文或前章发生变化，草稿已保留，请重新检查');
        }
        const current = getNovelState(novelId).state;
        if (current.expected_revision !== run.revision) throw new Error('故事状态已变化，草稿已保留，请重新检查');
        // Replace using the pre-chapter snapshot; do not merge future chapter facts back in.
        next = { ...run.base, ...patch, expected_revision: run.revision + 1 };
        const fields = ['global_summary', 'character_states', 'active_plot_threads', 'planted_foreshadowing', 'retired_characters'];
        const values = fields.map(k => k === 'global_summary' ? next[k] : JSON.stringify(next[k]));
        const result = _store.exec(`UPDATE _ainovel_novel_state SET ${fields.map(k => k + ' = ?').join(', ')},
            last_chapter_no = ?, expected_revision = ?, updated_at = ? WHERE novel_id = ? AND expected_revision = ?`,
            ...values, run.chapter.chapter_no, next.expected_revision, _now(), novelId, run.revision);
        if (result && result.changes === 0) throw new Error('故事状态提交冲突，请重试');
        _store.exec(`UPDATE _ainovel_chapters SET content = ?, summary = ?, actual_word_count = ?, status = 'done',
            handoff_json = ?, state_snapshot = ?, continuity_dirty = 0, draft_content = NULL, draft_meta = NULL, updated_at = ? WHERE id = ?`,
            content, handoff.summary, _countWords(content), JSON.stringify(handoff), JSON.stringify(next), _now(), run.chapter.id);
        _syncChapterBlocks(novelId, run.chapter.id, content);
        if (run.chapter.status === 'done') {
            _store.exec(`UPDATE _ainovel_chapters SET continuity_dirty = 1, draft_meta = NULL
                WHERE novel_id = ? AND chapter_no > ? AND status = 'done'`, novelId, run.chapter.chapter_no);
        }
        _store.exec(`UPDATE _ainovel_novels SET current_word_count =
            (SELECT COALESCE(SUM(actual_word_count), 0) FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'), updated_at = ? WHERE id = ?`,
            novelId, _now(), novelId);
        _store.exec(`UPDATE _ainovel_writing_conflicts SET user_action = 'retry', resolved_at = ?, updated_at = ?
            WHERE novel_id = ? AND chapter_id = ? AND user_action IS NULL`, _now(), _now(), novelId, run.chapter.id);
    });
    dropContext(novelId);
    return next;
}


async function _runChapterPipeline(novelId, chapterId) {
    const chapterRow = _store.query('SELECT * FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0];
    if (!chapterRow) throw new Error('章节不存在：' + chapterId);
    if (_chapterRuns.size || (_orchestrator && _orchestrator._currentPlan)) {
        throw new Error('已有生成任务进行中，请等待完成');
    }
    const jobId = _newJobId(novelId);
    _jobStart(novelId, jobId, 'chapter');
    _emit('pipeline_started', { novelId, chapterId, jobId, pipeline: 'chapter', totalPhases: 4 });
    let run;
    let scenes = [], currentContent = '', finalReviews = null, round = 1;
    try {
        run = _prepareChapterRun(novelId, chapterRow, jobId);
        const baseOpts = { novelId, chapterId, jobId, signal: run.controller.signal };
        const check = _preChapterWriteCheck(novelId, chapterRow);
        if (check.warnings && check.warnings.length) {
            _emit('chapter_pre_write_warnings', { novelId, chapterId, jobId, warnings: check.warnings });
        }
        _chapterProgress(novelId, 'prepare', '正在准备本章', run.previous
            ? `读取第 ${run.previous.chapter_no} 章结尾和人物状态，规划本章推进目标` : '结合全书设定和本章大纲规划开篇');
        const checkpoint = _safeJson(chapterRow.draft_meta, null);
        const resumable = checkpoint && checkpoint.fingerprint === run.fingerprint && chapterRow.draft_content;
        if (resumable && checkpoint.stage !== 'partial') {
            currentContent = chapterRow.draft_content;
            scenes = checkpoint.scenes || [];
            if (checkpoint.stage === 'reviewed' && !chapterIntegrity.blockingReviews(checkpoint.reviews).length) {
                finalReviews = checkpoint.reviews;
            }
            _chapterProgress(novelId, finalReviews ? 'save' : 'review', '正在继续上次任务', '已恢复草稿，不重复生成正文');
        } else if (chapterRow.content && chapterRow.continuity_dirty) {
            currentContent = chapterRow.content;
            _checkpointChapter(novelId, currentContent, { stage: 'draft', scenes });
            _chapterProgress(novelId, 'review', '正在复核修改后的章节', '保留已有正文，检查前章衔接和人物状态');
        } else if (_orchestrator) {
            // A fixed contract for chapter production; a dynamic director must not bypass review/commit.
            const plan = buildChapterPlan(novelId, chapterId, chapterRow, { jobId });
            const result = await _orchestrator.run(plan);
            run.controller.signal.throwIfAborted();
            if (!result.ok) throw new Error(result.error || '章节生成或检查失败，已保留可恢复的草稿');
            const graph = result.graph;
            const planResult = graph.getNode('phase-A-plan')?.result;
            const writer = graph.getNode('phase-B-write')?.result;
            scenes = planResult?.output?.scenes || [];
            currentContent = writer?.content || '';
            finalReviews = {
                'continuity-checker': graph.getNode('phase-C-review-continuity')?.result,
                'style-editor': graph.getNode('phase-C-review-style')?.result,
                'quality-reviewer': graph.getNode('phase-C-review-quality')?.result,
            };
        } else {
            const planned = await _runAgent(novelId, 'scene-planner', { novelId, chapterId, chapter: chapterRow },
                { ...baseOpts, phaseIndex: 0, phaseName: 'phase-A-plan', role: '场景规划' });
            scenes = planned.output.scenes;
            const writer = await _runAgent(novelId, 'chapter-streamer', { novelId, chapterId, chapter: chapterRow, scenes },
                { ...baseOpts, phaseIndex: 1, phaseName: 'phase-B-write', role: '章节写作' });
            currentContent = writer.content;
        }
        if (!currentContent.trim()) throw new Error('未生成有效正文，请重试');
        _checkpointChapter(novelId, currentContent, { stage: finalReviews && !chapterIntegrity.blockingReviews(finalReviews).length ? 'reviewed' : 'draft', scenes, reviews: finalReviews });
        _emit('chapter_draft_ready', { novelId, chapterId, jobId, content: currentContent });

        while (true) {
            run.controller.signal.throwIfAborted();
            _chapterProgress(novelId, 'review', round === 1 ? '正在检查章节衔接' : '正在复查修改结果',
                '对照前章结尾，检查人物知识、剧情因果、称谓和语言过渡');
            if (!finalReviews) {
                const input = { novelId, chapterId, chapterNo: chapterRow.chapter_no, chapterTitle: chapterRow.title,
                    chapterOutline: chapterRow.outline, targetWordCount: chapterRow.target_word_count, content: currentContent };
                const results = await Promise.allSettled(chapterIntegrity.REVIEWERS.map(name =>
                    _runAgent(novelId, name, input, { ...baseOpts, phaseIndex: 2, phaseName: 'phase-C-review', round })));
                finalReviews = Object.fromEntries(chapterIntegrity.REVIEWERS.map((name, i) => [name,
                    results[i].status === 'fulfilled' ? results[i].value : { __error: String(results[i].reason?.message || results[i].reason) }]));
            }
            const failed = chapterIntegrity.blockingReviews(finalReviews);
            if (!failed.length) break;
            const unavailable = failed.some(name => !finalReviews[name]?.output || finalReviews[name].__error || finalReviews[name].output.__error);
            if (unavailable || round >= 2) {
                const report = { issues: failed.flatMap(name => finalReviews[name]?.output?.issues || []),
                    failedReviewers: failed, sources: failed, attempts: round,
                    reason: unavailable ? '审查未成功完成，请重试检查' : '章节仍有需要处理的问题',
                    lastContent: currentContent };
                const saved = saveWritingConflict(novelId, chapterId, report, round);
                _emit('writing_conflict', { novelId, chapterId, jobId, conflict: saved.conflict, chapterNo: chapterRow.chapter_no });
                throw new Error('writing_conflict: ' + report.reason + '，完整草稿已保留');
            }
            const feedback = _composeRewriteFeedback(finalReviews);
            _chapterProgress(novelId, 'review', '正在修订发现的问题', feedback.slice(0, 350));
            const writer = await _runAgent(novelId, 'chapter-streamer', {
                novelId, chapterId, chapter: chapterRow, scenes, currentDraft: currentContent, lastReview: feedback,
            }, { ...baseOpts, phaseIndex: 1, phaseName: 'phase-B-rewrite', role: '局部修订', round: ++round });
            currentContent = writer.content;
            if (!currentContent.trim()) throw new Error('修订未返回有效正文，上一版草稿仍可恢复');
            _checkpointChapter(novelId, currentContent, { stage: 'draft', scenes });
            finalReviews = null;
        }

        _checkpointChapter(novelId, currentContent, { stage: 'reviewed', scenes, reviews: finalReviews });
        _chapterProgress(novelId, 'save', '检查通过，正在整理章节交接', '提取整章摘要、章末状态和未完事件');
        // Handoff and state extraction depend on the same reviewed text and can run together.
        const outline = _loadContext(novelId).outline;
        const characterList = _safeJson(outline?.global_characters, []).map(c => c.name).filter(Boolean);
        const jobs = [
            _extractChapterHandoff(novelId, chapterRow, currentContent),
            _runPipeline(novelId, 'chapter', [{ name: 'phase-D-bible', agents: [
                { name: 'character-state-updater', role: '人物状态', input: { novelId, chapterId, chapterNo: chapterRow.chapter_no, content: currentContent, characterList } },
                { name: 'plot-thread-tracker', role: '剧情进展', input: { novelId, chapterId, chapterNo: chapterRow.chapter_no, content: currentContent, existingThreads: run.base.active_plot_threads || [] } },
                { name: 'foreshadowing-extractor', role: '伏笔变化', input: { novelId, chapterId, chapterNo: chapterRow.chapter_no, content: currentContent, existingForeshadowing: run.base.planted_foreshadowing || [] } },
            ] }], { ...baseOpts, manageLifecycle: false, phaseIndexOffset: 3 }),
        ];
        const extracted = await Promise.allSettled(jobs);
        for (const result of extracted) if (result.status === 'rejected') throw result.reason;
        const handoff = extracted[0].value;
        const patch = chapterIntegrity.statePatch(run.base, chapterRow.chapter_no, handoff, extracted[1].value['phase-D-bible']);
        _chapterProgress(novelId, 'save', '正在保存章节', '正文、交接记录和人物／伏笔状态将一起保存');
        const state = _commitChapter(novelId, currentContent, handoff, patch);
        const wordCount = _countWords(currentContent);
        _emit('bible_committed', { novelId, chapterId, jobId, revision: state.expected_revision,
            characterCount: Object.keys(state.character_states).length, threadCount: state.active_plot_threads.length,
            foreshadowingCount: state.planted_foreshadowing.length });
        _chapterProgress(novelId, 'done', '本章已完成', handoff.summary);
        _emit('pipeline_finished', { novelId, chapterId, jobId, pipeline: 'chapter', result: { rounds: round, wordCount, bibleUpdated: true } });
        _emit('chapter_generated', { novelId, chapterId, jobId, wordCount, rounds: round, bibleUpdated: true });
        return {
            'phase-A-plan': { 'scene-planner': { output: { scenes } } },
            'phase-B-write': { 'chapter-streamer': { content: currentContent, wordCount } },
            'phase-C-review': finalReviews,
            __finalContent: currentContent, __finalWordCount: wordCount, __rounds: round,
        };
    } catch (e) {
        _chapterProgress(novelId, 'failed', '任务已暂停', e.message || String(e));
        _emit('pipeline_failed', { novelId, chapterId, jobId, pipeline: 'chapter', error: e.message || String(e) });
        throw e;
    } finally {
        _chapterRuns.delete(novelId);
        _jobEnd(novelId, jobId);
        dropContext(novelId);
    }
}


// 把 3 个 reviewer 的问题合并成一段"必须改进"反馈给 chapter-streamer 重写
function _composeRewriteFeedback(reviews) {
    const lines = [];
    if (reviews['continuity-checker'] && reviews['continuity-checker'].output) {
        const c = reviews['continuity-checker'].output;
        if (Array.isArray(c.issues) && c.issues.length) {
            lines.push('【连续性问题】');
            for (const i of c.issues) lines.push(`- [${i.severity || '?'}] ${i.type}: ${i.detail}`);
        }
    }
    if (reviews['style-editor'] && reviews['style-editor'].output) {
        const s = reviews['style-editor'].output;
        if (Array.isArray(s.issues) && s.issues.length) {
            lines.push('【文风问题】');
            for (const i of s.issues) lines.push(`- [${i.severity || '?'}] ${i.type}: ${i.detail}`);
        }
        if (s.suggestions) lines.push('修改建议：' + s.suggestions);
    }
    if (reviews['quality-reviewer'] && reviews['quality-reviewer'].output) {
        const q = reviews['quality-reviewer'].output;
        if (q.feedback) lines.push('【质量反馈】\n' + q.feedback);
    }
    return lines.join('\n');
}

// 是否有关键问题需要重写
function _reviewHasBlockingIssue(reviews) {
    return chapterIntegrity.blockingReviews(reviews).length > 0;
}

function safeJson(s) {
    if (Array.isArray(s)) return s;
    if (typeof s !== 'string') return null;
    try { return JSON.parse(s); } catch { return null; }
}

// ====== Public API for IPC handlers ======
async function callSkill(skillName, input, opts = {}) {
    const skill = _skills.get(skillName);
    if (!skill) return { ok: false, error: 'skill 不存在：' + skillName };

    const novelId = input.novelId || opts.novelId || (input.chapter && input.chapter.novel_id);
    if (!novelId) return { ok: false, error: '缺少 novelId' };

    // 防重复提交：同一 novel 已有 running job 直接拒绝（renderer 也会守，engine 再兜底）
    if (_isJobRunning(novelId)) {
        return { ok: false, error: '该小说已有生成任务进行中，请等待完成' };
    }

    const ctx = _loadContext(novelId);
    if (!ctx) return { ok: false, error: '小说不存在' };

    const provider = _getProviderConfig();
    if (!provider) return { ok: false, error: '未配置 LLM provider（请到「设置 → AI 小说」配置）' };

    const ac = new AbortController();
    let capturedRequest = null;
    const t0 = Date.now();
    // OpenClaw 模式：拼最终 system 后覆盖 skill.systemPrompt
    const composed = _composeSystemPrompt(skill, novelId);
    const effectiveSkill = Object.assign({}, skill, { systemPrompt: composed.system });
    const ctx2 = {
        novel: ctx.novel,
        outline: ctx.outline,
        chapters: ctx.chapters,
        provider,
        signal: ac.signal,
        store: _store,
        novelId,
        _skill: effectiveSkill,
        _recordPrompt: (req) => { capturedRequest = req; },
    };

    try {
        // run 通常写成箭头函数（不绑 this），.call(skill) 也覆盖不了 this；
        // 所以 agent run 内部通过 ctx._skill.systemPrompt / temperature 取 def 上的字段。
        const out = await skill.run.call(skill, input, ctx2);
        // 成功路径也写日志（之前漏了，导致老 skill 完全没日志）
        const dur = Date.now() - t0;
        _recordGeneration({
            novel_id: novelId,
            chapter_id: (input.chapter && input.chapter.id) || null,
            skill: skillName,
            display_name: skill.displayName || null,
            provider: provider.provider,
            model: provider.model,
            duration_ms: dur,
            raw_request: ((capturedRequest ? JSON.stringify(capturedRequest) : '') || '').slice(0, 5000),
            raw_response: (out && (out.raw || out.text) ? (out.raw || out.text) : '').slice(0, 5000),
            status: 'ok',
            injected_memory_bytes: composed.injectedMemoryBytes,
        });
        return out;
    } catch (e) {
        _recordGeneration({
            novel_id: novelId,
            chapter_id: (input.chapter && input.chapter.id) || null,
            skill: skillName,
            display_name: skill.displayName || null,
            provider: provider.provider,
            model: provider.model,
            duration_ms: Date.now() - t0,
            raw_request: ((capturedRequest ? JSON.stringify(capturedRequest) : '') || '').slice(0, 5000),
            status: 'failed',
            error_msg: e.message || String(e),
            injected_memory_bytes: composed.injectedMemoryBytes,
        });
        return { ok: false, error: e.message || String(e) };
    }
}

// ====== Provider Config Public ======
function getProviderConfig() {
    const c = _getProviderConfig();
    return { ok: true, config: c };
}

function setProviderConfig(cfg) {
    if (!cfg.provider) return { ok: false, error: 'provider 必填' };
    if (!cfg.model) return { ok: false, error: 'model 必填' };
    _setProviderConfig(cfg);
    _emit('provider_config_updated', {});
    return { ok: true };
}

async function testProviderConnection(cfg) {
    try {
        const r = await novel.testProvider({
            provider: cfg.provider,
            base_url: cfg.base_url,
            api_key: cfg.api_key,
            signal: null,
        });
        return r;
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function listGenerations(novelId) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const rows = _store.query(
        `SELECT id, skill, display_name, provider, model, prompt_tokens, completion_tokens, cost_usd,
                duration_ms, status, error_msg, created_at, chapter_id, phase, agent_name, round
           FROM _ainovel_generations
          WHERE novel_id = ?
          ORDER BY created_at DESC
          LIMIT 200`,
        novelId
    );
    return { ok: true, generations: rows };
}

function getGeneration(id) {
    if (!id) return { ok: false, error: 'id 必填' };
    const row = _store.query(
        `SELECT * FROM _ainovel_generations WHERE id = ?`,
        id
    )[0];
    if (!row) return { ok: false, error: '日志不存在' };
    return { ok: true, generation: row };
}

// ====== Auto-progression（Phase 2：自动逐章推进）======
// 不持久化（崩溃后自动模式失效，需要用户重新开）
const _autoState = new Map(); // novelId → { active, paused, currentChapterNo, totalChapters, completedChapters, totalWords, startedAt }

function _ensureAuto(novelId) {
    if (!_autoState.has(novelId)) {
        _autoState.set(novelId, {
            active: false, paused: false,
            autoConfirm: false,     // Sprint 8.1: 生成后自动 confirm
            autoConfirmChapters: 0, // Sprint 8.1: 累计已自动确认章数
            currentChapterNo: 0, totalChapters: 0, completedChapters: 0,
            totalWords: 0, startedAt: 0,
        });
    }
    return _autoState.get(novelId);
}

function getAutoStatus(novelId) {
    const s = _autoState.get(novelId) || { active: false };
    return { ok: true, ...s };
}

async function startAuto(novelId, opts = {}) {
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const novel = _store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0];
    if (!novel) return { ok: false, error: '小说不存在' };
    if (novel.status !== 'writing' && novel.status !== 'paused') {
        return { ok: false, error: '小说状态不允许自动写作（需要已生成大纲）' };
    }
    const s = _ensureAuto(novelId);
    if (s.active) return { ok: false, error: '自动模式已在运行' };
    // Sprint 8.1: autoConfirm 参数（默认 false）
    if (opts && typeof opts.autoConfirm === 'boolean') {
        s.autoConfirm = opts.autoConfirm;
    }

    const chapters = _store.query(
        `SELECT id, chapter_no FROM _ainovel_chapters
          WHERE novel_id = ? AND (status = 'pending' OR continuity_dirty = 1)
          ORDER BY chapter_no`,
        novelId
    );
    if (!chapters.length) return { ok: false, error: '没有待写章节' };

    s.active = true;
    s.paused = false;
    s.completedChapters = _store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
        novelId
    )[0].c;
    s.totalChapters = s.completedChapters + chapters.length;
    s.totalWords = (_store.query(
        `SELECT COALESCE(SUM(actual_word_count), 0) AS w FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
        novelId
    )[0]).w;
    s.startedAt = Date.now();

    _emit('auto_started', {
        novelId, totalChapters: s.totalChapters, completedChapters: s.completedChapters,
    });

    // 异步推进
    _runAutoLoop(novelId).catch((e) => {
        console.error('[auto] loop 异常：', e);
        s.active = false;
        _emit('auto_failed', { novelId, error: e.message || String(e) });
    });

    return { ok: true };
}

function pauseAuto(novelId) {
    const s = _autoState.get(novelId);
    if (!s || !s.active) return { ok: false, error: '自动模式未运行' };
    s.paused = true;
    _emit('auto_paused', { novelId, currentChapterNo: s.currentChapterNo });
    return { ok: true };
}

// Sprint 8.1: 运行时切换 autoConfirm
function setAutoConfirm(novelId, enabled) {
    const s = _ensureAuto(novelId);
    s.autoConfirm = !!enabled;
    _emit('auto_confirm_toggled', { novelId, autoConfirm: s.autoConfirm });
    return { ok: true, autoConfirm: s.autoConfirm };
}

// Sprint 8.1: 显式确认章节（标记已确认；记录时间戳到 events log）
function confirmChapter(novelId, chapterId) {
    if (!_store) return { ok: false, error: '未初始化' };
    if (!chapterId) return { ok: false, error: 'chapterId 必填' };
    const ch = _store.query('SELECT * FROM _ainovel_chapters WHERE id = ? AND novel_id = ?', chapterId, novelId)[0];
    if (!ch) return { ok: false, error: '章节不存在' };
    // 已是 done 不重复确认（幂等）
    if (ch.status === 'done') {
        _emit('chapter_confirmed', { novelId, chapterId, chapterNo: ch.chapter_no, alreadyConfirmed: true });
        return { ok: true, alreadyConfirmed: true };
    }
    // pending → done（用户手动确认）
    _store.exec(
        `UPDATE _ainovel_chapters SET status = 'done', user_edited = 1, updated_at = ? WHERE id = ?`,
        _now(), chapterId
    );
    _emit('chapter_confirmed', { novelId, chapterId, chapterNo: ch.chapter_no });
    return { ok: true };
}

function resumeAuto(novelId) {
    const s = _autoState.get(novelId);
    if (!s || !s.active) return { ok: false, error: '自动模式未运行' };
    if (!s.paused) return { ok: false, error: '自动模式未暂停' };
    s.paused = false;
    _emit('auto_resumed', { novelId });
    return { ok: true };
}

function cancelAuto(novelId) {
    const s = _autoState.get(novelId);
    if (!s || !s.active) return { ok: false, error: '自动模式未运行' };
    s.active = false;
    const run = _chapterRuns.get(novelId);
    if (run) { run.controller.abort(new Error('用户已停止写作')); if (_orchestrator) _orchestrator.cancel('user-cancelled'); }
    s.paused = false;
    _emit('auto_cancelled', { novelId, completedChapters: s.completedChapters });
    return { ok: true };
}

async function _runAutoLoop(novelId) {
    const s = _autoState.get(novelId);
    while (s && s.active) {
        // 如果暂停 → 等到 resume / cancel
        if (s.paused) {
            await _sleep(500);
            continue;
        }
        // 取下一个 pending chapter
        const next = _store.query(
            `SELECT id, chapter_no FROM _ainovel_chapters
              WHERE novel_id = ? AND (status = 'pending' OR continuity_dirty = 1)
              ORDER BY chapter_no LIMIT 1`,
            novelId
        )[0];
        if (!next) break;  // 全部完成

        s.currentChapterNo = next.chapter_no;
        _emit('auto_chapter_started', { novelId, chapterNo: next.chapter_no, chapterId: next.id });

        try {
            // 直接调 chapter pipeline（事件会自然流转）
            await _runChapterPipeline(novelId, next.id);
            // 检查 loop 是否被取消
            if (!s.active) break;
            s.completedChapters = _store.query("SELECT COUNT(*) AS c FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done' AND continuity_dirty = 0", novelId)[0].c;
            // 更新累计字数
            const total = (_store.query(
                `SELECT COALESCE(SUM(actual_word_count), 0) AS w FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
                novelId
            )[0]).w;
            s.totalWords = total;

            // ===== Sprint 8.1: 自动确认（无人值守连写）=====
            if (s.autoConfirm) {
                s.autoConfirmChapters = (s.autoConfirmChapters || 0) + 1;
                _emit('auto_chapter_confirmed', {
                    novelId,
                    chapterNo: next.chapter_no,
                    chapterId: next.id,
                    autoConfirm: true,
                    autoConfirmChapters: s.autoConfirmChapters,
                });
            }

            // ===== 编剧全程监督：每章完成后让编剧 LLM 读进度 + 黑板 + 收件箱，决定下一步 =====
            if (s.active && !s.paused) {
                try {
                    const decision = await _runOversight(novelId, {
                        afterChapterNo: next.chapter_no,
                        afterChapterId: next.id,
                    });
                    if (decision) {
                        _emit('auto_overseer_decided', { novelId, ...decision });
                        const handled = await _applyOversightDecision(novelId, decision);
                        if (handled === 'abort') break;
                        if (handled === 'pause') {
                            // 写到 store 状态 + 退出循环（_runAutoLoop 仍在外层 while 检查）
                            break;
                        }
                        // 'continue' / 'rewrite_last' / 'inject_note'：让 while 继续
                    }
                } catch (ovE) {
                    // oversight 失败不阻塞主流程 — 静默回退到默认 continue
                    console.warn('[auto] oversight 失败（已回退 continue）：', ovE.message);
                    _emit('auto_overseer_failed', { novelId, error: ovE.message || String(ovE) });
                }
            }
        } catch (e) {
            if (!s.active) break;
            console.error('[auto] chapter', next.chapter_no, '失败：', e.message);
            _emit('auto_chapter_failed', { novelId, chapterNo: next.chapter_no, error: e.message || String(e) });
            // 失败不终止 loop — 让用户决定是否 cancel
            s.paused = true;
            _emit('auto_paused', { novelId, currentChapterNo: next.chapter_no, reason: e.message || String(e) });
        }
    }

    if (s) {
        const wasActive = s.active;
        s.active = false;
        if (wasActive === false) return;  // 被 cancel 了
        _emit('auto_finished', { novelId, totalWords: s.totalWords, totalChapters: s.completedChapters });
        // 切回 paused（用户可手动继续）
        _store.exec(`UPDATE _ainovel_novels SET status = 'paused', updated_at = ? WHERE id = ?`, _now(), novelId);
        dropContext(novelId);
    }
}

function _sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ====== Sprint H+: 编剧全程监督（每章完成后让 LLM 决定下一步）======

const _OVERSEER_PREFIX = '<<<OVERSEERS>>>';
const _OVERSEER_SUFFIX = '<<<END>>>';
const _OVERSEER_VALID_ACTIONS = ['continue', 'pause', 'rewrite_last', 'inject_note', 'abort'];

// 监督者 system prompt（精简版，强调决策协议 + 白名单）
const _OVERSEER_SYSTEM_PROMPT = `你是 AI 小说项目的"全程监督"。每写完一章，你会拿到当前小说的进度、黑板、收件箱、最近几章的概要。

**你的任务**：基于这些信息，决定下一步动作。

**决策协议**（必须严格输出，且只用下列 action 之一）：
<<<OVERSEERS>>>{"action":"continue|pause|rewrite_last|inject_note|abort","reason":"...","note":"..."}<<<END>>>

**action 白名单**：
- \`continue\` — 一切正常，继续写下一章（默认）
- \`pause\` — 暂停并通知用户（如发现严重剧情/设定问题，需要人介入）
- \`rewrite_last\` — 上一章不满意，重写。\`note\` 字段写重写要求
- \`inject_note\` — 往黑板写一条额外约束/设定，然后继续。\`note\` 字段是要写入的内容
- \`abort\` — 终止整个自动写作（极端情况）

**何时用 pause / abort**：
- 连续 2 章以上风格/设定严重漂移
- 大纲关键人物死亡或结局提前触发
- 检测到循环错误（如一直重写同一章）

**何时用 rewrite_last**：
- 单章明显质量问题（如主角人设漂移），且注入 note 后能纠正
- 重写完成后下一章 oversight 会重新评估

**何时用 inject_note**：
- 需要补充世界观设定（"林晚左眼有旧伤疤，发光时会更明显"）
- 需要强化约束（"接下来 3 章禁止出现任何方言"）

**何时用 continue**（最常用）：
- 章节正常完成，不需要介入

**输入信息**（你将收到）：
1. 进度：已完成章节数 / 总目标章节数 / 当前字数 / 目标字数
2. 黑板摘要：所有共享 key + value
3. 收件箱：最近 5 条未读消息
4. 最近 3 章概要（章节号 + 标题 + 摘要前 200 字）

**输出约束**：
- 只输出决策标记，不要解释、不要寒暄
- JSON 必须合法，reason 短（< 80 字），note 中等（< 300 字）
- action 必须严格在白名单内
`;

async function _runOversight(novelId, ctx) {
    const prov = _getProviderConfig();
    if (!prov || !prov.base_url) {
        return null;  // 没配 LLM → 静默跳过
    }

    // 1. 收集进度
    const novel = _store.query('SELECT * FROM _ainovel_novels WHERE id = ?', novelId)[0];
    const chapterList = _store.query(
        `SELECT chapter_no, title, summary, status, actual_word_count
           FROM _ainovel_chapters WHERE novel_id = ?
           ORDER BY chapter_no DESC LIMIT 5`,
        novelId
    ).reverse();  // 老的在前
    const totalTarget = (novel && novel.target_word_count) || 1000000;
    const totalWords = (_store.query(
        `SELECT COALESCE(SUM(actual_word_count), 0) AS w FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
        novelId
    )[0]).w;
    const pendingCount = (_store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_chapters WHERE novel_id = ? AND status = 'pending'`,
        novelId
    )[0]).c;
    const completedCount = (_store.query(
        `SELECT COUNT(*) AS c FROM _ainovel_chapters WHERE novel_id = ? AND status = 'done'`,
        novelId
    )[0]).c;

    // 2. 收集黑板摘要（截断）
    const bbSummary = blackboardSummary(novelId);

    // 3. 收集收件箱（最近 5 条，跨 agent 聚合）
    const agents = listSkills().filter(s => s.name !== 'novel-director').map(s => s.name);
    let inboxLines = [];
    for (const a of agents) {
        try {
            const r = inboxRead(novelId, a, { markAsRead: false, limit: 5 });
            if (r && r.ok && r.messages && r.messages.length) {
                for (const m of r.messages.slice(0, 3)) {
                    inboxLines.push(`[${a}] from=${m.from || '?'} kind=${m.kind || 'note'} text=${String(m.text || '').slice(0, 200)}`);
                }
            }
        } catch (e) { /* skip */ }
    }
    const inboxSnippet = inboxLines.length ? inboxLines.join('\n').slice(0, 1500) : '（无未读消息）';

    // 4. 最近章节概要
    const recentSnippets = chapterList.map(c =>
        `第 ${c.chapter_no} 章《${c.title || '（无标题）'}》（${c.status || '?'}, ${c.actual_word_count || 0} 字）：${String(c.summary || '').slice(0, 200)}`
    ).join('\n');

    // 5. 构造 user prompt
    const userPrompt = [
        `【进度】完成 ${completedCount} / 总目标约 ${completedCount + pendingCount} 章 / 当前字数 ${totalWords} / 目标 ${totalTarget}`,
        `【当前节点】刚完成第 ${ctx.afterChapterNo} 章`,
        ``,
        `【黑板摘要】`,
        bbSummary || '（空）',
        ``,
        `【收件箱未读（最多 5 条）】`,
        inboxSnippet,
        ``,
        `【最近 5 章概要】`,
        recentSnippets || '（暂无）',
        ``,
        `请输出下一步决策：`,
    ].join('\n');

    // 6. 调 LLM（用 novel.generateStream —— 流式但本次只要 final text）
    let text = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);  // 60s 超时
    try {
        await novel.generateStream({
            provider: prov.provider,
            base_url: prov.base_url,
            api_key: prov.api_key,
            model: prov.model,
            temperature: 0.4,           // 决策类任务低温度
            max_tokens: 800,
            signal: controller.signal,
            system: _OVERSEER_SYSTEM_PROMPT,
            user: userPrompt,
        }, (chunk) => { text += (chunk.delta || ''); });
    } finally {
        clearTimeout(timeout);
    }

    // 7. 解析决策
    const decision = _parseOversightDecision(text);
    return decision;
}

function _parseOversightDecision(text) {
    if (!text) return null;
    const m = String(text).match(/<<<OVERSEERS>>>\s*([\s\S]*?)\s*<<<END>>>/);
    if (!m) return { action: 'continue', reason: 'no decision marker', note: '' };
    let payload;
    try { payload = JSON.parse(m[1]); }
    catch (e) {
        return { action: 'continue', reason: 'decision parse failed: ' + (e.message || ''), note: '' };
    }
    const action = _OVERSEER_VALID_ACTIONS.includes(payload.action) ? payload.action : 'continue';
    return {
        action,
        reason: String(payload.reason || '').slice(0, 200),
        note: String(payload.note || '').slice(0, 500),
        raw: m[1].slice(0, 1000),
    };
}

async function _applyOversightDecision(novelId, decision) {
    let s = _autoState.get(novelId);
    if (!s) s = _ensureAuto(novelId);  // 测试场景：可能 _autoState 还没初始化
    switch (decision.action) {
        case 'continue':
            return 'continue';
        case 'pause': {
            s.paused = true;
            _emit('auto_paused', { novelId, reason: 'overseer_pause: ' + (decision.reason || '') });
            return 'pause';
        }
        case 'rewrite_last': {
            // 重置最近一个 done 章节为 pending（让 loop 重新取到它）
            const last = _store.query(
                `SELECT id, chapter_no FROM _ainovel_chapters
                  WHERE novel_id = ? AND status = 'done'
                  ORDER BY chapter_no DESC LIMIT 1`,
                novelId
            )[0];
            if (last) {
                // 防死循环：同一章节号连续重写不超过 2 次
                if (s.lastRewriteChapterNo === last.chapter_no && s.lastRewriteCount >= 2) {
                    _emit('auto_overseer_decided', { novelId, action: 'continue',
                        reason: 'rewrite_last 防死循环（连续 3 次重写同一章）' });
                    return 'continue';
                }
                _store.exec(
                    `UPDATE _ainovel_chapters SET status = 'pending', updated_at = ?
                      WHERE id = ?`,
                    _now(), last.id
                );
                if (s.lastRewriteChapterNo === last.chapter_no) {
                    s.lastRewriteCount = (s.lastRewriteCount || 0) + 1;
                } else {
                    s.lastRewriteChapterNo = last.chapter_no;
                    s.lastRewriteCount = 1;
                }
                // 把 note 写到黑板给 chapter-streamer 看到
                if (decision.note) {
                    blackboardWrite(novelId, `overseer_rewrite_ch${last.chapter_no}`, decision.note, 'auto-overseer');
                }
                s.completedChapters = Math.max(0, s.completedChapters - 1);
            }
            return 'continue';
        }
        case 'inject_note': {
            if (decision.note) {
                blackboardWrite(novelId, `overseer_note_${Date.now()}`, decision.note, 'auto-overseer');
            }
            return 'continue';
        }
        case 'abort': {
            s.active = false;
            _emit('auto_cancelled', { novelId, reason: 'overseer_abort: ' + (decision.reason || '') });
            return 'abort';
        }
        default:
            return 'continue';
    }
}

// ====== Phase 3: 知识库 CRUD ======
// 抽取结果写入 _ainovel_knowledge 表（Sprint N 由 agent 调 extractKnowledge 写入）
// 渲染端通过 getKnowledge 读取；用户可改 resolved / 删除
function getKnowledge(novelId, kind) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    try {
        const where = kind ? 'WHERE novel_id = ? AND kind = ?' : 'WHERE novel_id = ?';
        const params = kind ? [novelId, kind] : [novelId];
        const rows = _store.query(
            `SELECT id, novel_id, kind, title, detail, meta, resolved, created_at, updated_at
             FROM _ainovel_knowledge
             ${where}
             ORDER BY kind, resolved ASC, created_at DESC`,
            params
        );
        // 解析 meta JSON
        const items = rows.map(r => ({
            ...r,
            meta: r.meta ? safeJson(r.meta) : null,
            resolved: !!r.resolved,
        }));
        return { ok: true, items };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 更新一条知识记录（目前只支持 resolved / title / detail）
function updateKnowledge(id, patch) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!id) return { ok: false, error: 'id 必填' };
    try {
        const sets = [];
        const params = [];
        if (typeof patch.resolved === 'boolean') {
            sets.push('resolved = ?');
            params.push(patch.resolved ? 1 : 0);
        }
        if (typeof patch.title === 'string') {
            sets.push('title = ?');
            params.push(patch.title);
        }
        if (typeof patch.detail === 'string') {
            sets.push('detail = ?');
            params.push(patch.detail);
        }
        if (!sets.length) return { ok: false, error: '没有可更新字段' };
        sets.push('updated_at = ?');
        params.push(_now());
        params.push(id);
        _store.exec(`UPDATE _ainovel_knowledge SET ${sets.join(', ')} WHERE id = ?`, params);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 删除一条知识记录
function deleteKnowledge(id) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!id) return { ok: false, error: 'id 必填' };
    try {
        _store.exec(`DELETE FROM _ainovel_knowledge WHERE id = ?`, [id]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 触发知识抽取（Sprint N 实现：调用 4 个 agent 并写入表）
// Sprint M 先 stub：返回 { ok: true, jobId }，但只 emit knowledge_extracting 事件
// 真正的 agent 调用在 Sprint N 完成
function extractKnowledge(novelId, kinds) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    kinds = Array.isArray(kinds) && kinds.length ? kinds : ['foreshadowing', 'verification', 'reference'];
    const jobId = _newJobId(novelId);
    _emit('knowledge_extracting', { novelId, jobId, kinds });
    // Sprint N 后台跑 agent；现在 stub：直接 emit 完成事件
    setImmediate(() => {
        _emit('knowledge_extracted', { novelId, jobId, kind: 'stub', count: 0, note: 'Sprint N 实装' });
        _emit('knowledge_extraction_failed', { novelId, jobId, kind: 'stub', error: 'agent 暂未注册（Sprint N 上线后启用）' });
    });
    return { ok: true, jobId, kinds };
}

// ====== Phase 4-A: 故事架构（_ainovel_architecture）======
function getArchitecture(novelId) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const row = (_store.query('SELECT * FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0]) || null;
    if (!row) return { ok: true, architecture: null };
    const arch = {
        three_act: row.three_act || '',
        plot_threads: _safeJson(row.plot_threads, []),
        character_arcs: _safeJson(row.character_arcs, []),
        theme_tracks: _safeJson(row.theme_tracks, []),
        foreshadowing_seed: _safeJson(row.foreshadowing_seed, []),
        raw_architecture: row.raw_architecture || '',
        user_edited: !!row.user_edited,
        updated_at: row.updated_at,
    };
    return { ok: true, architecture: arch };
}

function updateArchitecture(novelId, patch) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必填' };
    const existing = (_store.query('SELECT novel_id FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0]) || null;
    // 只更新 patch 中明确提供的字段（避免空 patch 把 DB 清空）
    const cols = {};
    if (typeof patch.three_act === 'string') cols.three_act = patch.three_act;
    if (patch.plot_threads != null) cols.plot_threads = JSON.stringify(patch.plot_threads);
    if (patch.character_arcs != null) cols.character_arcs = JSON.stringify(patch.character_arcs);
    if (patch.theme_tracks != null) cols.theme_tracks = JSON.stringify(patch.theme_tracks);
    if (patch.foreshadowing_seed != null) cols.foreshadowing_seed = JSON.stringify(patch.foreshadowing_seed);
    if (!Object.keys(cols).length) return { ok: false, error: 'patch 至少包含一个字段' };
    if (existing) {
        const sets = Object.keys(cols).map(c => `${c}=?`).join(', ');
        const vals = Object.values(cols);
        _store.exec(
            `UPDATE _ainovel_architecture SET ${sets}, user_edited=1, updated_at=? WHERE novel_id=?`,
            ...vals, _now(), novelId
        );
    } else {
        // 新建时：缺省字段为 null
        const fullCols = {
            three_act: cols.three_act || null,
            plot_threads: cols.plot_threads || null,
            character_arcs: cols.character_arcs || null,
            theme_tracks: cols.theme_tracks || null,
            foreshadowing_seed: cols.foreshadowing_seed || null,
        };
        _store.exec(
            `INSERT INTO _ainovel_architecture (novel_id, three_act, plot_threads, character_arcs, theme_tracks, foreshadowing_seed, user_edited, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
            novelId,
            fullCols.three_act, fullCols.plot_threads, fullCols.character_arcs, fullCols.theme_tracks, fullCols.foreshadowing_seed,
            _now()
        );
    }
    dropContext(novelId);
    return { ok: true };
}

function regenerateArchitecture(novelId) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const outline = (_store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', novelId)[0]) || null;
    if (!outline) return { ok: false, error: '该小说尚未生成大纲' };
    const parsed = {
        structure: outline.structure,
        world_setting: outline.world_setting,
        main_conflict: outline.main_conflict,
        themes: _safeJson(outline.themes, []),
        global_characters: _safeJson(outline.global_characters, []),
        chapter_list: _safeJson(outline.chapter_list, []),
    };
    // 后台异步跑，不阻塞返回值
    _regenerateArchitectureJob(novelId, parsed);
    return { ok: true, jobId: _newJobId(novelId) };
}

async function _regenerateArchitectureJob(novelId, parsedOutline) {
    const jobId = _newJobId(novelId);
    _jobStart(novelId, jobId, 'architecture');
    _emit('architecture_regenerating', { novelId, jobId });
    try {
        const archOut = await _runAgent(novelId, 'story-architect', { outline: parsedOutline }, {
            phaseIndex: 0,
            phaseName: 'regenerate',
            role: '架构重提',
            jobId,
        });
        const archParsed = archOut.output || {};
        const existing = (_store.query('SELECT novel_id FROM _ainovel_architecture WHERE novel_id = ?', novelId)[0]) || null;
        const archCols = ['three_act', 'plot_threads', 'character_arcs', 'theme_tracks', 'foreshadowing_seed', 'raw_architecture', 'updated_at'];
        const archValues = [
            archParsed.three_act || null,
            JSON.stringify(archParsed.plot_threads || []),
            JSON.stringify(archParsed.character_arcs || []),
            JSON.stringify(archParsed.theme_tracks || []),
            JSON.stringify(archParsed.foreshadowing_seed || []),
            archOut.raw || archOut.text || '',
            _now(),
        ];
        if (existing) {
            const sets = archCols.map(c => `${c}=?`).join(', ');
            _store.exec(`UPDATE _ainovel_architecture SET ${sets}, user_edited=0 WHERE novel_id=?`, ...archValues, novelId);
        } else {
            const cols = ['novel_id', ...archCols].join(', ');
            const placeholders = archCols.map(() => '?').join(', ');
            _store.exec(`INSERT INTO _ainovel_architecture (${cols}) VALUES (?, ${placeholders})`, novelId, ...archValues);
        }
        _emit('architecture_generated', {
            novelId, jobId,
            plotThreadCount: (archParsed.plot_threads || []).length,
            foreshadowingSeedCount: (archParsed.foreshadowing_seed || []).length,
        });
    } catch (e) {
        const msg = e.message || String(e);
        console.warn(`[novel-engine] regenerateArchitecture failed:`, msg);
        _emit('architecture_generation_failed', { novelId, jobId, error: msg });
    } finally {
        _jobEnd(novelId, jobId);
    }
}

function _safeJson(s, fallback) {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (e) { return fallback; }
}

// ====== Phase 4-B: 圣经状态（_ainovel_novel_state + atomic commit）======
//
// 核心思想：
// 章节写作完成后，1 次原子提交更新所有"跨章节状态"（人物状态/剧情线进度/伏笔回收）
// 使用 expected_revision 做乐观锁，避免并发覆盖
//
// 失败策略：snapshot = SELECT 当前 row；patch = 应用变更；commit = UPDATE WHERE revision = expected
//   - 如果 affectedRows = 0 → 版本冲突，回滚，返回 {ok:false, conflict:true}
//   - 调用方可重试（先重新 SELECT snapshot）

function getNovelState(novelId) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    let row = (_store.query('SELECT * FROM _ainovel_novel_state WHERE novel_id = ?', novelId)[0]) || null;
    if (!row) {
        // 自动初始化空状态
        _store.exec(
            `INSERT OR IGNORE INTO _ainovel_novel_state (novel_id, last_chapter_no, expected_revision) VALUES (?, 0, 0)`,
            novelId
        );
        row = (_store.query('SELECT * FROM _ainovel_novel_state WHERE novel_id = ?', novelId)[0]) || null;
    }
    if (!row) return { ok: true, state: null };
    return {
        ok: true,
        state: {
            novel_id: row.novel_id,
            global_summary: row.global_summary || '',
            character_states: _safeJson(row.character_states, {}),
            active_plot_threads: _safeJson(row.active_plot_threads, []),
            planted_foreshadowing: _safeJson(row.planted_foreshadowing, []),
            retired_characters: _safeJson(row.retired_characters, []),
            last_chapter_no: row.last_chapter_no || 0,
            expected_revision: row.expected_revision || 0,
            updated_at: row.updated_at,
        },
    };
}

// 应用 patch 到当前 state，返回新的 state 对象（不写库）
// 用于：atomic commit 前的预览 / 测试
function applyStatePatch(state, patch) {
    const next = JSON.parse(JSON.stringify(state || {}));
    if (patch.global_summary !== undefined) next.global_summary = patch.global_summary;
    if (patch.character_states) {
        next.character_states = { ...(next.character_states || {}), ...patch.character_states };
    }
    if (patch.active_plot_threads) {
        const existing = Array.isArray(next.active_plot_threads) ? next.active_plot_threads : [];
        const merged = [...existing];
        for (const t of patch.active_plot_threads) {
            const idx = merged.findIndex(x => x.id === t.id);
            if (idx >= 0) merged[idx] = { ...merged[idx], ...t };
            else merged.push(t);
        }
        next.active_plot_threads = merged;
    }
    if (patch.planted_foreshadowing) {
        const existing = Array.isArray(next.planted_foreshadowing) ? next.planted_foreshadowing : [];
        const merged = [...existing];
        for (const f of patch.planted_foreshadowing) {
            const idx = merged.findIndex(x => x.id === f.id);
            if (idx >= 0) merged[idx] = { ...merged[idx], ...f };
            else merged.push(f);
        }
        next.planted_foreshadowing = merged;
    }
    if (patch.retired_characters) {
        const existing = Array.isArray(next.retired_characters) ? next.retired_characters : [];
        const merged = [...existing];
        for (const c of patch.retired_characters) {
            if (!merged.includes(c)) merged.push(c);
        }
        next.retired_characters = merged;
    }
    if (patch.last_chapter_no !== undefined) next.last_chapter_no = patch.last_chapter_no;
    return next;
}

// 原子提交：UPDATE WHERE expected_revision = current.expected_revision
// 冲突 → {ok:false, conflict:true, currentExpectedRevision}，调用方需重新 snapshot
function atomicCommitState(novelId, patch) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    const cur = getNovelState(novelId);
    if (!cur.ok) return cur;
    const current = cur.state;
    const next = applyStatePatch(current, patch);
    const newRevision = (current.expected_revision || 0) + 1;
    const cols = {
        global_summary: next.global_summary || '',
        character_states: JSON.stringify(next.character_states || {}),
        active_plot_threads: JSON.stringify(next.active_plot_threads || []),
        planted_foreshadowing: JSON.stringify(next.planted_foreshadowing || []),
        retired_characters: JSON.stringify(next.retired_characters || []),
    };
    // expected_revision 自增；UPDATE 限定 old revision 匹配才成功
    const res = _store.exec(
        `UPDATE _ainovel_novel_state SET ${Object.keys(cols).map(c => `${c}=?`).join(', ')}, last_chapter_no=?, expected_revision=?, updated_at=? WHERE novel_id=? AND expected_revision=?`,
        ...Object.values(cols),
        next.last_chapter_no || 0,
        newRevision,
        _now(),
        novelId,
        current.expected_revision || 0
    );
    if (res && res.changes === 0) {
        return { ok: false, conflict: true, currentExpectedRevision: current.expected_revision };
    }
    dropContext(novelId);
    return { ok: true, state: { ...next, expected_revision: newRevision }, revision: newRevision };
}

// 重置（开发用，不在用户路径上）
function resetNovelState(novelId) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId) return { ok: false, error: 'novelId 必填' };
    _store.exec(`DELETE FROM _ainovel_novel_state WHERE novel_id = ?`, novelId);
    return { ok: true };
}

// ====== Public APIs for OpenClaw mode (Sprint C/D/E) ======

// 主动反馈接口（前端 👍/👎 按钮调）
function saveAgentFeedback({ novelId, skill, vote, comment, generationId }) {
    if (!_store) return { ok: false, error: 'engine 未 bootstrap' };
    if (!novelId || !skill || !vote) return { ok: false, error: 'novelId / skill / vote 必填' };
    if (vote !== 'up' && vote !== 'down') return { ok: false, error: 'vote 必须是 up 或 down' };
    // 简单 rate limit：同 novel+skill 5 分钟内最多 5 条
    try {
        const fiveMinAgo = _now() - 300;
        const recent = _store.query(
            'SELECT COUNT(*) as c FROM _ainovel_agent_feedback WHERE novel_id = ? AND skill = ? AND created_at >= ?',
            novelId, skill, fiveMinAgo
        )[0];
        if (recent && recent.c >= 5) {
            return { ok: false, error: '反馈过于频繁，5 分钟内最多 5 条' };
        }
    } catch (e) { /* 表不存在等情况不阻塞 */ }

    const id = _uuid();
    _store.exec(
        `INSERT INTO _ainovel_agent_feedback (id, novel_id, skill, generation_id, vote, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, novelId, skill, generationId || null, vote, comment || null, _now()
    );
    // 同步写一条到 per-novel memory 日志（让 memory log 也能看到反馈历史）
    _recordMemoryFeedback(skill, novelId, {
        skill,
        status: 'user-feedback',
        review: `${vote === 'up' ? '👍 用户点赞' : '👎 用户点踩'}${comment ? `：${comment}` : ''}`,
        action: generationId ? `关联 generation #${generationId.slice(0, 8)}` : '无关联生成',
    });
    // 可选：把 user_vote 写到对应 generation 行（如果提供了 generationId）
    if (generationId) {
        try {
            _store.exec(
                `UPDATE _ainovel_generations SET user_vote = ?, feedback_comment = ? WHERE id = ?`,
                vote, comment || null, generationId
            );
        } catch (e) { /* 不阻塞 */ }
    }
    _emit('feedback_received', { novelId, skill, vote, comment, generationId });
    return { ok: true, id };
}

// 查反馈列表（按时间倒序）
function listAgentFeedback({ novelId, skill, limit = 20 }) {
    if (!_store) return [];
    try {
        return _store.query(
            `SELECT id, novel_id, skill, generation_id, vote, comment, created_at
             FROM _ainovel_agent_feedback
             WHERE novel_id = ? AND skill = ?
             ORDER BY created_at DESC LIMIT ?`,
            novelId, skill, limit
        );
    } catch (e) {
        return [];
    }
}

// 公开的 memory log append（外部手工记录时调）
function appendMemoryLog(skill, novelId, entry) {
    return _appendMemoryLog(skill, novelId, entry);
}

// 列 memory 日志（按日期范围）
function listMemoryLogs({ skill, novelId, scope = 'all', date = null, limit = 30 }) {
    const result = { global: [], perNovel: [] };
    const dates = date ? [date] : _recentDates(limit);
    // 全局
    if ((scope === 'all' || scope === 'global') && _agentsRoot) {
        for (const d of dates) {
            const p = path.join(_agentsRoot, skill, 'memory', `${d}.md`);
            const content = _readMdIfExists(p);
            if (content) result.global.push({ date: d, content, path: p });
        }
    }
    // per-novel
    if ((scope === 'all' || scope === 'per-novel') && _storeRootForMemory && novelId) {
        for (const d of dates) {
            const p = path.join(_storeRootForMemory, `_ainovel_novel_${novelId}_agent_memory`, skill, 'memory', `${d}.md`);
            const content = _readMdIfExists(p);
            if (content) result.perNovel.push({ date: d, content, path: p });
        }
    }
    return result;
}

function _recentDates(n) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

// 读某个 agent 的 4 个 MD 文件内容（给 UI 编辑面板用）
function getAgentConfig(skillName) {
    if (!skillName) return { error: 'skillName 必填' };
    const dir = _agentsRoot ? path.join(_agentsRoot, skillName) : null;
    if (!dir) return { error: 'engine 未 bootstrap（_agentsRoot 为空）' };
    return {
        skill: skillName,
        dir,
        files: {
            'SOUL.md': _readMdIfExists(path.join(dir, 'SOUL.md')),
            'IDENTITY.md': _readMdIfExists(path.join(dir, 'IDENTITY.md')),
            'AGENTS.md': _readMdIfExists(path.join(dir, 'AGENTS.md')),
            'MEMORY.md': _readMdIfExists(path.join(dir, 'MEMORY.md')),
        },
    };
}

// 保存某个 MD 文件（白名单：4 个固定文件名）
function saveAgentConfig(skillName, filename, content) {
    if (!skillName || !filename) return { ok: false, error: 'skillName / filename 必填' };
    const allow = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'MEMORY.md'];
    if (!allow.includes(filename)) {
        return { ok: false, error: `只允许编辑：${allow.join(', ')}` };
    }
    if (!_agentsRoot) return { ok: false, error: 'engine 未 bootstrap' };
    const dir = path.join(_agentsRoot, skillName);
    const target = path.join(dir, filename);
    // 安全检查：必须落在 _agentsRoot 下（防 ../ 越界）
    const resolved = path.resolve(target);
    const agentsRootResolved = path.resolve(_agentsRoot);
    if (!resolved.startsWith(agentsRootResolved + path.sep)) {
        return { ok: false, error: '路径越界' };
    }
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        // SOUL/IDENTITY/AGENTS 是缓存的，要清缓存
        if (filename !== 'MEMORY.md') {
            _agentConfigCache.delete(skillName);
        }
        return { ok: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// 立即触发 memory 提炼（Sprint F 用，先留接口）
function flushMemory({ skill, novelId = null, force = false }) {
    return _flushMemoryToSummary(skill, novelId, force);
}

// ====== Sprint F: meta-agent 提炼 ======
// 把 memory/YYYY-MM-DD.md 的所有日志喂给一个专门的 LLM，让它压缩成精炼的 MEMORY.md
// 频率限制：全局 7 天 1 次 / per-novel 24h 1 次
// 用户手动 force=true 可绕过

const META_AGENT_SYSTEM = `你是 agent 记忆提炼专家。任务：把【该 agent 的运行日志】提炼为简洁的【长期经验沉淀】。

【输入】
- 下方是该 agent 最近的运行日志（每次运行一条 entry）
- 包含：输入摘要、输出摘要、tokens、耗时、状态、错误、被动反馈、用户反馈

【输出要求】
输出 Markdown 格式的"经验沉淀"，结构如下：

# 经验沉淀

## 强偏好（用户多次 👎/👍 反复提到的）
- ...

## 被动反馈（reviewer 退回的常见问题）
- ...

## 常见错误 / 易踩坑
- ...

## 自我进化的最佳实践
- ...

【铁律】
1. **只保留有共性的经验**（出现 ≥ 2 次的反馈 / 错误才记）
2. **删除单次偶发问题**（一次性失败不要记）
3. **删除冗余日志细节**（不要保留时间戳 / 字节数 / tokens 等元数据）
4. **总长度控制在 1500 字以内**（MEMORY.md 会被注入到 system prompt，太长会爆 token）
5. **用中文**
6. **不要 markdown 包裹代码块**（直接输出 Markdown）`;

async function _metaAgentFlush(skillName, dir, novelId, force) {
    // 1) 频率限制检查
    if (!force) {
        try {
            const now = _now();
            if (novelId) {
                const meta = _store.query(
                    'SELECT last_flush_at FROM _ainovel_novel_memory_metadata WHERE novel_id = ? AND skill = ?',
                    novelId, skillName
                )[0];
                if (meta && meta.last_flush_at && (now - meta.last_flush_at) < 24 * 3600) {
                    return { ok: false, skipped: 'rate-limit', reason: `per-novel 提炼 24h 内已执行过` };
                }
            } else {
                const meta = _store.query(
                    'SELECT last_global_flush_at FROM _ainovel_memory_metadata WHERE skill = ?',
                    skillName
                )[0];
                if (meta && meta.last_global_flush_at && (now - meta.last_global_flush_at) < 7 * 24 * 3600) {
                    return { ok: false, skipped: 'rate-limit', reason: `全局提炼 7 天内已执行过` };
                }
            }
        } catch (e) { /* 表不存在等情况不阻塞 */ }
    }

    // 2) 读取所有 memory/YYYY-MM-DD.md
    if (!fs.existsSync(dir)) return { ok: false, skipped: 'no-memory-dir' };
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    if (!files.length) return { ok: false, skipped: 'no-logs' };

    let allLogs = '';
    let totalBytes = 0;
    for (const f of files) {
        const p = path.join(dir, f);
        const stat = fs.statSync(p);
        totalBytes += stat.size;
        allLogs += `\n\n=== ${f} ===\n` + fs.readFileSync(p, 'utf8');
    }
    // 截断输入到 12K 字符（meta-agent 的输入窗口）
    const truncatedInput = allLogs.length > 12000 ? allLogs.slice(-12000) : allLogs;

    // 3) 调 LLM
    const provider = _getProviderConfig();
    if (!provider) return { ok: false, skipped: 'no-provider', reason: '未配置 LLM provider' };

    const userPrompt = `【该 agent 名】${skillName}
【提炼范围】${novelId ? `per-novel (${novelId})` : '全局'}

【运行日志（最近的，可能被截断）】
${truncatedInput}

请提炼输出经验沉淀（Markdown，1500 字内）。`;

    try {
        const res = await novel.generate({
            provider: provider.provider, base_url: provider.base_url, api_key: provider.api_key,
            model: provider.model,
            system: META_AGENT_SYSTEM,
            user: userPrompt,
            temperature: 0.3,
            max_tokens: 2000,
        });

        let newMemory = (res.text || '').trim();
        // 清理可能的 markdown 包裹
        newMemory = newMemory.replace(/^```markdown\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');

        if (!newMemory || newMemory.length < 50) {
            return { ok: false, skipped: 'empty-output', reason: 'meta-agent 输出为空' };
        }

        // 4) 合并写入 MEMORY.md（保留上次 + 追加新版）
        const memPath = path.join(dir, '..', 'MEMORY.md');
        const oldMemory = _readMdIfExists(memPath);
        const merged = oldMemory
            ? `${oldMemory}\n\n---\n\n# 提炼于 ${new Date().toISOString().slice(0, 10)}\n\n${newMemory}`
            : `# 经验沉淀（自动提炼）\n\n${newMemory}`;

        fs.writeFileSync(memPath, merged, 'utf8');

        // 5) 更新 metadata
        const now = _now();
        if (novelId) {
            _store.exec(
                `INSERT INTO _ainovel_novel_memory_metadata (novel_id, skill, last_flush_at, memory_bytes)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(novel_id, skill) DO UPDATE SET last_flush_at=excluded.last_flush_at, memory_bytes=excluded.memory_bytes`,
                novelId, skillName, now, totalBytes
            );
        } else {
            _store.exec(
                `INSERT INTO _ainovel_memory_metadata (skill, last_global_flush_at, global_memory_bytes, total_flush_count)
                 VALUES (?, ?, ?, 1)
                 ON CONFLICT(skill) DO UPDATE SET
                   last_global_flush_at=excluded.last_global_flush_at,
                   global_memory_bytes=excluded.global_memory_bytes,
                   total_flush_count=total_flush_count + 1`,
                skillName, now, totalBytes
            );
        }

        // 6) 提炼后归档旧日志（move 到 archive/，避免重复提炼）
        const archiveDir = path.join(dir, 'archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        for (const f of files) {
            fs.renameSync(path.join(dir, f), path.join(archiveDir, f));
        }

        return {
            ok: true,
            flushed: true,
            bytes: totalBytes,
            fileCount: files.length,
            newMemoryBytes: Buffer.byteLength(merged, 'utf8'),
            tokens: { prompt: res.prompt_tokens, completion: res.completion_tokens },
        };
    } catch (e) {
        console.error(`[novel-engine] meta-agent flush failed: ${skillName}`, e.message);
        return { ok: false, skipped: 'llm-failed', reason: e.message };
    }
}

function _flushMemoryToSummary(skillName, novelId, force) {
    const result = { skill: skillName, novelId, scope: novelId ? 'per-novel' : 'global' };
    const dir = novelId && _storeRootForMemory
        ? path.join(_storeRootForMemory, `_ainovel_novel_${novelId}_agent_memory`, skillName, 'memory')
        : (_agentsRoot ? path.join(_agentsRoot, skillName, 'memory') : null);
    if (!dir) return { ...result, error: 'path not found' };
    if (!fs.existsSync(dir)) return { ...result, error: 'memory dir not exist', bytes: 0, fileCount: 0 };
    let totalBytes = 0;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const f of files) {
        totalBytes += fs.statSync(path.join(dir, f)).size;
    }
    result.bytes = totalBytes;
    result.fileCount = files.length;
    result.threshold = novelId ? 30 * 1024 : 50 * 1024;  // 30KB per-novel / 50KB global
    if (!force && totalBytes < result.threshold) {
        return { ...result, flushed: false, reason: 'below-threshold' };
    }
    // 触发 meta-agent 提炼
    return _metaAgentFlush(skillName, dir, novelId, force).then(r => ({ ...result, ...r }));
}

// ====== Export ======
module.exports = {
    bootstrap,
    // novel CRUD
    listNovels,
    createNovel,
    getNovel,
    deleteNovel,
    updateOutline,
    updateChapter,
    // Sprint 6.1: Block 模型（段落级 CRUD）
    getChapterWithBlocks: (novelId, chapterId) => _getChapterWithBlocks(novelId, chapterId),
    getChapterBlocks: (novelId, chapterId) => _getChapterBlocks(novelId, chapterId),
    splitChapterToBlocks: (content) => _splitChapterToBlocks(content),
    syncChapterBlocks: (novelId, chapterId, content) => _syncChapterBlocks(novelId, chapterId, content),
    replaceBlock: (novelId, chapterId, blockId, text) => _replaceBlock(novelId, chapterId, blockId, text),
    deleteBlock: (novelId, chapterId, blockId) => _deleteBlock(novelId, chapterId, blockId),
    insertBlockAfter: (novelId, chapterId, afterBlockId, text, blockType) => _insertBlockAfter(novelId, chapterId, afterBlockId, text, blockType),
    reviseBlock: (novelId, chapterId, blockId, feedback) => _reviseBlockAsync(novelId, chapterId, blockId, feedback),
    // Sprint 7.1: 卷(arc)层级大纲
    listArcs,
    getArc,
    createArc,
    updateArc,
    deleteArc,
    validateArcs,
    _normalizeArcs,
    setNovelChapterCount,
    // Sprint 7.2: 伏笔系统
    listForeshadows,
    getForeshadow,
    createForeshadow,
    updateForeshadow,
    deleteForeshadow,
    pushForeshadowEvent,
    resolveForeshadow,
    bulkAdoptForeshadows,
    generateForeshadowRoadmap,
    // Sprint 7.3: 叙事记忆
    listMemory,
    getMemory,
    createMemory,
    updateMemory,
    deleteMemory,
    calcMemoryMaxTokens,
    renderMemoryForInjection,
    // Sprint 8.1: 自动确认模式
    startAuto,
    pauseAuto,
    resumeAuto,
    cancelAuto,
    getAutoStatus,
    setAutoConfirm,
    confirmChapter,
    // Sprint 8.2: 写作冲突（事实核查自动重写耗尽）
    saveWritingConflict,
    listWritingConflicts,
    getWritingConflict,
    getOpenConflictForChapter,
    resolveWritingConflict,
    clearWritingConflicts,
    // Sprint 8.3: 关系图谱
    listRelations,
    getRelation,
    createRelation,
    updateRelation,
    deleteRelation,
    bulkAdoptRelations,
    // Sprint 9.1: AI 助理 chat 会话
    listChatSessions,
    createChatSession,
    getChatSession,
    deleteChatSession,
    appendChatMessage,
    updateChatSession,
    trimChatHistory,
    sendChatMessage,
    // Sprint 9.2: 配置变更（AI 改已填字段的待确认清单）
    listPendingConfigChanges,
    createPendingConfigChange,
    resolveConfigChange,
    applyConfigChanges,
    dismissConfigChanges,
    // skills
    listSkills,
    setSkillEnabled: (skill, enabled) => _setSkillEnabled(skill, enabled),
    isSkillEnabled: (skill) => _isSkillEnabled(skill),
    getEnabledSkills: (category) => _getEnabledSkills(category),
    getSkillDef: (name) => _skills.get(name) || null,
    callSkill,
    registerSkill,
    // Sprint C-S1: 暴露新基础设施层给 main.js / 前端调试用
    getSharedContext: () => _sharedContext,
    getContextCompressor: () => _contextCompressor,
    getCostTracker: () => _costTracker,
    getCapabilityRegistry: () => _capabilityRegistry,
    // Sprint C-S2: 暴露 orchestrator 给 main.js / 前端调试用
    getOrchestrator: () => _orchestrator,
    getCapabilityRouter: () => _capabilityRouter,
    runOrchestratorPlan,
    cancelOrchestratorPlan,
    pauseOrchestratorPlan,
    resumeOrchestratorPlan,
    getOrchestratorFullStatus,
    getCostSnapshot,
    setCostThreshold,
    getOrchestratorStatus,
    getOrchestratorPlanSnapshot,
    listCapabilities,
    // Sprint C-S2: 暴露 plan-builder（前端 DAG view 用 / 测试）
    buildOutlinePlan,
    buildChapterPlan,
    // 暴露 _store getter（chat-tools 直接 query 需要；AgentLoop 内部使用）
    // 用 getter 让 _store 总是反映 bootstrap 后的最新值
    getStore: () => _store,
    // Sprint C-S1: 共享上下文 CRUD（前端 IPC 可用）
    sharedContextSet: (novelId, key, value, opts) => _sharedContext ? _sharedContext.set(novelId, key, value, opts || {}) : { ok: false, error: 'shared_context 未初始化' },
    sharedContextGet: (novelId, key) => _sharedContext ? _sharedContext.get(novelId, key) : null,
    sharedContextListKeys: (novelId) => _sharedContext ? _sharedContext.listKeys(novelId) : [],
    sharedContextStats: (novelId) => _sharedContext ? _sharedContext.stats(novelId) : null,
    costSnapshot: (novelId) => _costTracker ? _costTracker.snapshot(novelId) : null,
    costAcknowledgeWarn: (novelId) => _costTracker ? _costTracker.acknowledgeWarn(novelId) : false,
    // provider
    getProviderConfig,
    setProviderConfig,
    testProviderConnection,
    supportsThinking: (provider, model) => novel.supportsThinking(provider, model),
    // logs
    listGenerations,
    getGeneration,
    // context
    setActive,
    dropContext,
    getActive,
    // auto-progression (Phase 2)
    startAuto,
    pauseAuto,
    resumeAuto,
    cancelAuto,
    getAutoStatus,
    runOversight: _runOversight,
    _runOversight,
    _applyOversightDecision,
    _parseOversightDecision,
    _ensureAuto,
    _OVERSEER_PREFIX,
    _OVERSEER_SUFFIX,
    _OVERSEER_VALID_ACTIONS,
    _OVERSEER_SYSTEM_PROMPT,
    // knowledge base (Phase 3)
    getKnowledge,
    updateKnowledge,
    deleteKnowledge,
    extractKnowledge,
    // story architecture (Phase 4-A)
    getArchitecture,
    updateArchitecture,
    regenerateArchitecture,
    // novel bible / atomic commit (Phase 4-B)
    getNovelState,
    atomicCommitState,
    applyStatePatch,
    resetNovelState,
    // helpers (exposed for testing)
    _countWords,
    _preChapterWriteCheck,
    _safeParseAgentOutput,
    _tryParseJson,
    _tryCompleteTruncatedJson,
    // OpenClaw 模式（Phase 4）
    _composeSystemPrompt,
    _loadAgentConfig,
    _loadAgentMemory,
    _loadRecentFeedback,
    _appendMemoryLog,
    _recordMemoryFeedback,
    formatMemoryEntry_,
    get _agentConfigCache() { return _agentConfigCache; },
    get _agentsRoot() { return _agentsRoot; },
    set _agentsRoot(v) { _agentsRoot = v; },
    get _storeRootForMemory() { return _storeRootForMemory; },
    set _storeRootForMemory(v) { _storeRootForMemory = v; },
    // Public APIs (for IPC + tests)
    saveAgentFeedback,
    listAgentFeedback,
    appendMemoryLog,
    listMemoryLogs,
    getAgentConfig,
    saveAgentConfig,
    flushMemory,
    // meta-agent helpers (exposed for testing)
    META_AGENT_SYSTEM,
    _metaAgentFlush,

    // ====== Phase H：LLM-driven 多 agent 协作框架 ======
    // H1: Skill-as-Tool
    _renderSkillAsToolSpec,
    // H2: Blackboard（项目级共享黑板）
    blackboardWrite,
    blackboardRead,
    blackboardList,
    blackboardSummary,
    blackboardClear,
    _dropBlackboardCache,
    // H3: Inbox（per-novel 文件收件箱）
    inboxSend,
    inboxRead,
    inboxList,
    inboxMarkRead,
    _inboxDir,
    _inboxPath,
    // H4: Task List（任务图）
    taskCreate,
    taskList,
    taskGet,
    taskClaim,
    taskComplete,
    taskFail,
    taskReady,
    // H5: Director（编剧调度器）
    runDirectedAgent: _runDirectedAgent,
    _runDirectedAgent,
    _runDirectorLoop,
    _registerNovelDirector,
    _registerSupervisorCriticCost,
    _directorExecuteTool,
    _parseDirectorResponse,
    _directorSystemPrompt,
    _renderDirectorToolbox,
    DIRECTOR_TOOL_PREFIX,
    DIRECTOR_TOOL_SUFFIX,
    DIRECTOR_DONE_MARKER,
    DIRECTOR_PLAN_PREFIX,
    DIRECTOR_PLAN_SUFFIX,
    DIRECTOR_MAX_TURNS,
    // Sprint 3: 动态 plan 模式 + PLAN_READY 解析
    getDynamicPlanMode,
    setDynamicPlanMode,
    _tryGenerateDirectorPlan,
    _parseDirectorPlan,
    // H6: 调度模式开关
    getDirectorMode,
    setDirectorMode,
    getSetting,
    setSetting,
    listWorkflowEvents,
    listWorkflowReplay,
    getWorkflowEventDetail,
    getWorkflowStats,
    _emit,
    _persistWorkflowEvent,
    _directorOrPipeline,
    _extractOutlineFromDirector,
    _extractChapterFromDirector,
};
