// orchestrator/plan-builders.js
// Sprint 2: 把 novel-engine 的硬编码 pipeline 翻译成 orchestrator 的 plan (静态)。
//
// 关键设计：
//   - 每个 task 的 input 是一个函数 (inputCtx) => object
//     inputCtx = { task, graph, novelId, jobId }
//     函数内部读 graph 的已完成 task 输出 → 拼装自己的 input
//   - 这样下游 task 不需要 hard-code "phase-X-Y.output" 这种字符串路径
//   - 简化：用 helper `upstream(taskId, agentName, field)` 拉取上游输出
//
// 输出形如：
//   { name: 'outline', novelId: 'n1', tasks: [ ... ] }
//
// 兼容性：buildOutlinePlan() 返回的 plan 跑完后，仍然调用旧的
// _persistOutlineAfter() / _createChapterRows() 完成后续持久化
// （review 循环在 Sprint 2 仍是 imperative 跑，最多 3 轮 review）

'use strict';

/**
 * 从 graph 拉一个已完成 task 的输出。
 * @param {TaskGraph} graph
 * @param {string} taskId        上游 task 的 id（plan tasks 里的 id 字段）
 * @param {string} [field]       可选；要拿的字段（如 'output' / 'content' / 'scenes'）。
 *                               不传 → 整条 result（_runAgent 的返回值）
 */
function upstream(graph, taskId, field) {
    const node = graph.getNode(taskId);
    if (!node) throw new Error(`plan-builders: task ${taskId} 不在 graph 中`);
    const r = node.result || {};
    if (field) return r[field];
    return r;
}

/**
 * 通用 task 节点构造器。
 */
function makeTask({ id, capability, depends_on = [], input, maxRetries = 1, fallback = null, label = null, meta = {} }) {
    return {
        id,
        capability,
        depends_on,
        // 关键：input 是函数（_resolveTaskInput 会调它）
        input: typeof input === 'function' ? input : () => input || {},
        maxRetries,
        fallback,
        label: label || id,
        meta,
    };
}

// ==================== Outline Plan ====================

/**
 * 构造大纲 pipeline 的静态 plan。
 *
 * 对应原 _runOutlinePipeline 的 6 个核心 phase：
 *   A1: style.analyze   (style-analyst)         无依赖
 *   A2: world.design    (world-architect)       依赖 A1
 *   A3: character.design (character-architect)  依赖 A1, A2
 *   B1: theme.analyze   (theme-architect)       依赖 A1, A2, A3
 *   B2: plot.structure  (plot-architect)       依赖 A1, A2, A3, B1
 *   C:  outline.synthesis (outline-synthesizer)  依赖 A1..B2
 *
 * Phase D 的 review 循环，以及 Phase E 的故事架构提取都仍在
 * _runOutlinePipeline 里 imperative 跑：DAG 不天然支持循环；E 是非阻塞增强，
 * 不能让它的失败阻断一个已可用的大纲。
 *
 * @param {string} novelId
 * @returns {{name, novelId, tasks: Array}}
 */
function buildOutlinePlan(novelId) {
    // 关键：每个 task 的 meta 必须带 novelId / jobId / phaseIndex / role / phaseName，
    // 否则 orchestrator.executor 拿不到 novelId 会抛「task meta 缺 novelId」。
    const baseMeta = { novelId };
    const tasks = [
        // A1: 风格分析（无依赖）
        makeTask({
            id: 'phase-A1-style',
            capability: 'style.analyze',
            depends_on: [],
            input: () => ({ novelId }),
            label: '风格分析',
            meta: Object.assign({}, baseMeta, { phaseIndex: 0, role: '风格分析', phaseName: 'phase-A1-style' }),
        }),

        // A2: 世界设定（依赖风格）
        makeTask({
            id: 'phase-A2-world',
            capability: 'world.design',
            depends_on: ['phase-A1-style'],
            input: ({ graph }) => ({
                novelId,
                styleGuide: upstream(graph, 'phase-A1-style', 'output'),
            }),
            label: '世界设定',
            meta: Object.assign({}, baseMeta, { phaseIndex: 1, role: '世界设定', phaseName: 'phase-A2-world' }),
        }),

        // A3: 人物设计（依赖风格 + 世界）
        makeTask({
            id: 'phase-A3-character',
            capability: 'character.design',
            depends_on: ['phase-A1-style', 'phase-A2-world'],
            input: ({ graph }) => ({
                novelId,
                styleGuide: upstream(graph, 'phase-A1-style', 'output'),
                worlds: upstream(graph, 'phase-A2-world', 'output'),
            }),
            label: '人物设计',
            meta: Object.assign({}, baseMeta, { phaseIndex: 2, role: '人物设计', phaseName: 'phase-A3-character' }),
        }),

        // B1: 主题分析（依赖风格 + 世界 + 人物）
        makeTask({
            id: 'phase-B1-theme',
            capability: 'theme.analyze',
            depends_on: ['phase-A1-style', 'phase-A2-world', 'phase-A3-character'],
            input: ({ graph }) => ({
                novelId,
                styleGuide: upstream(graph, 'phase-A1-style', 'output'),
                worlds: upstream(graph, 'phase-A2-world', 'output'),
                characters: upstream(graph, 'phase-A3-character', 'output'),
            }),
            label: '主题分析',
            meta: Object.assign({}, baseMeta, { phaseIndex: 3, role: '主题分析', phaseName: 'phase-B1-theme' }),
        }),

        // B2: 剧情结构（依赖风格 + 世界 + 人物 + 主题）
        makeTask({
            id: 'phase-B2-plot',
            capability: 'plot.structure',
            depends_on: ['phase-A1-style', 'phase-A2-world', 'phase-A3-character', 'phase-B1-theme'],
            input: ({ graph }) => ({
                novelId,
                styleGuide: upstream(graph, 'phase-A1-style', 'output'),
                worlds: upstream(graph, 'phase-A2-world', 'output'),
                characters: upstream(graph, 'phase-A3-character', 'output'),
                themes: upstream(graph, 'phase-B1-theme', 'output'),
            }),
            label: '剧情结构',
            meta: Object.assign({}, baseMeta, { phaseIndex: 4, role: '剧情结构', phaseName: 'phase-B2-plot' }),
        }),

        // C: 大纲综合
        makeTask({
            id: 'phase-C-synthesize',
            capability: 'outline.synthesis',
            depends_on: ['phase-A1-style', 'phase-A2-world', 'phase-A3-character', 'phase-B1-theme', 'phase-B2-plot'],
            input: ({ graph }) => ({
                novelId,
                styleGuide: upstream(graph, 'phase-A1-style', 'output'),
                worlds: upstream(graph, 'phase-A2-world', 'output'),
                characters: upstream(graph, 'phase-A3-character', 'output'),
                themes: upstream(graph, 'phase-B1-theme', 'output'),
                plots: upstream(graph, 'phase-B2-plot', 'output'),
            }),
            label: '大纲综合',
            meta: Object.assign({}, baseMeta, { phaseIndex: 5, role: '大纲综合', phaseName: 'phase-C-synthesize' }),
        }),

    ];

    return {
        name: 'outline',
        novelId,
        tasks,
    };
}

// ==================== Chapter Plan ====================

/**
 * 构造章节 pipeline 的静态 plan。
 *
 * 对应原 _runChapterPipeline 的 phase：
 *   A: chapter.plan_scenes  (scene-planner)              无依赖
 *   B: chapter.stream        (chapter-streamer)           依赖 A
 *   C: review.continuity + review.style + review.quality 并行（依赖 B）
 *
 * Phase D（3 个 bible updater）不进 plan——D 必须等 review 循环结束用 *最终* content，
 * 跑在 _runChapterPipeline 的 review 循环之后。
 *
 * Review 循环 + 重写在 _runChapterPipeline 里 imperative 跑（最多 2 轮），
 * 进 DAG 比较复杂（Sprint 2 不进）。
 *
 * @param {string} novelId
 * @param {string} chapterId
 * @param {object} chapterRow  _ainovel_chapters 行
 * @param {object} [opts]
 * @param {Function} [opts.onChunk]   流式回调（chapter-streamer 用，会放到 task.meta.onChunk）
 * @param {string} [opts.jobId]       任务 ID（会放到每个 task.meta.jobId）
 * @param {object} [opts.extra]       透传到每个 task.meta 的额外字段（如 phaseIndex / role）
 * @returns {{name, novelId, tasks: Array}}
 */
function buildChapterPlan(novelId, chapterId, chapterRow, opts = {}) {
    const onChunk = opts.onChunk || null;
    const jobId = opts.jobId || null;
    const extraMeta = opts.extra || {};
    const baseMeta = Object.assign({}, extraMeta, { jobId, novelId, chapterId });
    if (onChunk) baseMeta.onChunk = onChunk;

    const tasks = [
        // A: 场景分镜
        makeTask({
            id: 'phase-A-plan',
            capability: 'chapter.plan_scenes',
            depends_on: [],
            input: () => ({ novelId, chapterId, chapter: chapterRow }),
            label: '场景分镜',
            meta: Object.assign({}, baseMeta, { phaseIndex: 0, role: '场景分镜' }),
        }),

        // B: 流式写正文
        makeTask({
            id: 'phase-B-write',
            capability: 'chapter.stream',
            depends_on: ['phase-A-plan'],
            input: ({ graph }) => ({
                novelId, chapterId,
                chapter: chapterRow,
                scenes: upstream(graph, 'phase-A-plan', 'output').scenes,
            }),
            label: '章节写作',
            meta: Object.assign({}, baseMeta, { phaseIndex: 1, role: '章节写作' }),
        }),

        // C: 3 个 reviewer 并行
        makeTask({
            id: 'phase-C-review-continuity',
            capability: 'review.continuity',
            depends_on: ['phase-B-write'],
            input: ({ graph }) => ({
                novelId, chapterId,
                chapterNo: chapterRow.chapter_no,
                chapterTitle: chapterRow.title,
                chapterOutline: chapterRow.outline,
                targetWordCount: chapterRow.target_word_count,
                content: upstream(graph, 'phase-B-write', 'content'),
            }),
            label: '连续性审查',
            meta: Object.assign({}, baseMeta, { phaseIndex: 2, role: '连续性审查' }),
        }),
        makeTask({
            id: 'phase-C-review-style',
            capability: 'review.style',
            depends_on: ['phase-B-write'],
            input: ({ graph }) => ({
                novelId, chapterId,
                content: upstream(graph, 'phase-B-write', 'content'),
            }),
            label: '文风审查',
            meta: Object.assign({}, baseMeta, { phaseIndex: 2, role: '文风审查' }),
        }),
        makeTask({
            id: 'phase-C-review-quality',
            capability: 'review.quality',
            depends_on: ['phase-B-write'],
            input: ({ graph }) => ({
                novelId, chapterId,
                chapterNo: chapterRow.chapter_no,
                chapterTitle: chapterRow.title,
                chapterOutline: chapterRow.outline,
                targetWordCount: chapterRow.target_word_count,
                content: upstream(graph, 'phase-B-write', 'content'),
            }),
            label: '质量评审',
            meta: Object.assign({}, baseMeta, { phaseIndex: 2, role: '质量评审' }),
        }),
    ];

    return {
        name: 'chapter',
        novelId,
        tasks,
    };
}

module.exports = {
    buildOutlinePlan,
    buildChapterPlan,
    upstream,
    makeTask,
};
