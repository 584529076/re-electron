// chat-tools.js - Sprint 9.1: AI 助理工具系统
// 注册 30+ 工具：读 / 写安全 / 写异步 / 写破坏性 / 元
// 关键护栏：破坏性工具需要 requiresConfirm=true；Agent Loop 调用前必须复述范围并等用户确认

'use strict';

// 工具类别常量
const TOOL_CATEGORIES = {
    READ: 'read',                 // 只读
    WRITE_SAFE: 'write-safe',     // 写但可逆/局部
    WRITE_ASYNC: 'write-async',   // 写但异步/批量（生成内容）
    WRITE_DESTRUCTIVE: 'destructive',  // 破坏性（需 confirm: true）
    META: 'meta',                 // 元操作（暂停/恢复等）
};

// ===== 工具定义 =====
function _buildChatTools(api) {
    // api 是 novelEngine 暴露的函数集合（避免循环依赖）

    const tools = [];

    // ============= 读（10） =============
    tools.push({
        name: 'readNovelInfo',
        category: TOOL_CATEGORIES.READ,
        description: '读小说基础信息：标题/风格/POV/字数/状态/章节数',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => {
            const r = api.getNovel(params.novelId);
            if (!r || !r.ok) return { ok: false, error: r && r.error ? r.error : '小说不存在' };
            return { ok: true, novel: r.novel, outline: r.outline, chapterCount: r.chapters ? r.chapters.length : 0 };
        },
    });

    tools.push({
        name: 'readOutline',
        category: TOOL_CATEGORIES.READ,
        description: '读小说大纲（结构/世界/冲突/主题/角色/章节列表）',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => {
            const row = api._store && api._store.query('SELECT * FROM _ainovel_outlines WHERE novel_id = ?', params.novelId)[0];
            return { ok: true, outline: row || null };
        },
    });

    tools.push({
        name: 'readChapter',
        category: TOOL_CATEGORIES.READ,
        description: '读指定章节：标题/大纲/正文/字数/状态',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
        },
        run: (params) => {
            if (!api._store) return { ok: false, error: '未初始化' };
            const ch = api._store.query(
                'SELECT * FROM _ainovel_chapters WHERE novel_id = ? AND chapter_no = ?',
                params.novelId, params.chapterNo
            )[0];
            if (!ch) return { ok: false, error: '章节不存在' };
            return { ok: true, chapter: ch };
        },
    });

    tools.push({
        name: 'readCharacters',
        category: TOOL_CATEGORIES.READ,
        description: '从 outline.global_characters 读角色列表',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => {
            const outline = api._store && api._store.query('SELECT global_characters FROM _ainovel_outlines WHERE novel_id = ?', params.novelId)[0];
            let list = [];
            if (outline && outline.global_characters) {
                try { list = JSON.parse(outline.global_characters); } catch (e) { list = []; }
            }
            return { ok: true, characters: list };
        },
    });

    tools.push({
        name: 'readWorldview',
        category: TOOL_CATEGORIES.READ,
        description: '读世界观设定（来自 outline.world_setting）',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => {
            const outline = api._store && api._store.query('SELECT world_setting FROM _ainovel_outlines WHERE novel_id = ?', params.novelId)[0];
            return { ok: true, worldSetting: outline ? outline.world_setting : null };
        },
    });

    tools.push({
        name: 'readForeshadows',
        category: TOOL_CATEGORIES.READ,
        description: '读伏笔列表（按 status 过滤：planted/progressing/resolved/abandoned）',
        parameters: {
            novelId: { type: 'string', required: true },
            status: { type: 'string', required: false },
        },
        run: (params) => ({ ok: true, list: api.listForeshadows(params.novelId, params.status || null) }),
    });

    tools.push({
        name: 'readMemory',
        category: TOOL_CATEGORIES.READ,
        description: '读叙事记忆条目（自动按重要性排序）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapter: { type: 'number', required: false },
        },
        run: (params) => ({ ok: true, list: params.chapter ? api.listMemory(params.novelId, { chapter: params.chapter }) : api.listMemory(params.novelId) }),
    });

    tools.push({
        name: 'readArcs',
        category: TOOL_CATEGORIES.READ,
        description: '读卷(arc)列表',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => ({ ok: true, list: api.listArcs(params.novelId) }),
    });

    tools.push({
        name: 'readSkills',
        category: TOOL_CATEGORIES.READ,
        description: '读当前可用 skill 列表（带启用状态）',
        parameters: {},
        run: () => ({ ok: true, list: api.listSkills() }),
    });

    tools.push({
        name: 'readAutoState',
        category: TOOL_CATEGORIES.READ,
        description: '读自动循环当前状态（active/paused/autoConfirm/progress）',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => ({ ok: true, state: api.getAutoStatus(params.novelId) }),
    });

    // ============= 写 - 安全（10+） =============
    tools.push({
        name: 'updateChapterContent',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '修改某章正文（局部修订，不影响其他章；与 deleteChapter 完全不同）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
            content: { type: 'string', required: true, description: '完整正文' },
        },
        run: (params) => {
            const ch = api._store && api._store.query('SELECT id FROM _ainovel_chapters WHERE novel_id = ? AND chapter_no = ?', params.novelId, params.chapterNo)[0];
            if (!ch) return { ok: false, error: '章节不存在' };
            return api.updateChapter(params.novelId, ch.id, { content: params.content });
        },
    });

    tools.push({
        name: 'updateOutlineField',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '更新大纲字段（structure/world_setting/main_conflict/themes/chapter_list）',
        parameters: {
            novelId: { type: 'string', required: true },
            patch: { type: 'object', required: true, description: '{field: value}' },
        },
        run: (params) => api.updateOutline(params.novelId, params.patch),
    });

    tools.push({
        name: 'createArc',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '创建新卷(title/goal/startCh/endCh)',
        parameters: {
            novelId: { type: 'string', required: true },
            title: { type: 'string', required: true },
            goal: { type: 'string', required: false },
            startCh: { type: 'number', required: true },
            endCh: { type: 'number', required: true },
            summary: { type: 'string', required: false },
        },
        run: (params) => api.createArc(params.novelId, {
            title: params.title, goal: params.goal, startCh: params.startCh, endCh: params.endCh, summary: params.summary,
        }),
    });

    tools.push({
        name: 'updateArc',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '修改卷的 title/goal/summary',
        parameters: {
            arcId: { type: 'string', required: true },
            patch: { type: 'object', required: true },
        },
        run: (params) => api.updateArc(params.arcId, params.patch),
    });

    tools.push({
        name: 'createForeshadow',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '创建伏笔(name/description/plantChapter/targetChapter)',
        parameters: {
            novelId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            description: { type: 'string', required: false },
            plantChapter: { type: 'number', required: true },
            targetChapter: { type: 'number', required: false },
        },
        run: (params) => api.createForeshadow(params.novelId, {
            name: params.name, description: params.description,
            plantChapter: params.plantChapter, targetChapter: params.targetChapter,
        }),
    });

    tools.push({
        name: 'updateForeshadow',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '修改伏笔（status/progress/events/resolution）',
        parameters: {
            id: { type: 'string', required: true },
            patch: { type: 'object', required: true },
        },
        run: (params) => api.updateForeshadow(params.id, params.patch),
    });

    tools.push({
        name: 'pushForeshadowEvent',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '给伏笔追加一条推进事件（chapter/note）',
        parameters: {
            id: { type: 'string', required: true },
            chapter: { type: 'number', required: true },
            note: { type: 'string', required: true },
        },
        run: (params) => api.pushForeshadowEvent(params.id, params.chapter, params.note),
    });

    tools.push({
        name: 'resolveForeshadowTool',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '标记伏笔为已回收（resolution 描述）',
        parameters: {
            id: { type: 'string', required: true },
            resolution: { type: 'string', required: true },
        },
        run: (params) => api.resolveForeshadow(null, params.id, params.resolution),
    });

    tools.push({
        name: 'createMemory',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '新增叙事记忆条目',
        parameters: {
            novelId: { type: 'string', required: true },
            content: { type: 'string', required: true },
            category: { type: 'string', required: false },
            chapter: { type: 'number', required: true },
            snippet: { type: 'string', required: false },
            importance: { type: 'number', required: false },
        },
        run: (params) => api.createMemory(params.novelId, params),
    });

    tools.push({
        name: 'createRelation',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '创建关系图谱中的一条边（character/organization/worldview 之间）',
        parameters: {
            novelId: { type: 'string', required: true },
            sourceType: { type: 'string', required: true },
            sourceId: { type: 'string', required: true },
            sourceName: { type: 'string', required: false },
            targetType: { type: 'string', required: true },
            targetId: { type: 'string', required: true },
            targetName: { type: 'string', required: false },
            label: { type: 'string', required: false },
            strength: { type: 'number', required: false },
        },
        run: (params) => api.createRelation(params.novelId, params),
    });

    tools.push({
        name: 'setWritingStyle',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '修改小说风格（style/custom_style）',
        parameters: {
            novelId: { type: 'string', required: true },
            style: { type: 'string', required: false },
            customStyle: { type: 'string', required: false },
        },
        run: (params) => {
            const fields = [];
            const vals = [];
            if (params.style !== undefined) { fields.push('style = ?'); vals.push(params.style); }
            if (params.customStyle !== undefined) { fields.push('custom_style = ?'); vals.push(params.customStyle); }
            if (!fields.length) return { ok: false, error: '至少传 style 或 customStyle' };
            fields.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000));
            vals.push(params.novelId);
            api._store.exec(`UPDATE _ainovel_novels SET ${fields.join(', ')} WHERE id = ?`, ...vals);
            return { ok: true };
        },
    });

    tools.push({
        name: 'setSynopsis',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '设置故事概要（写到 _ainovel_outlines.raw_outline）',
        parameters: {
            novelId: { type: 'string', required: true },
            synopsis: { type: 'string', required: true },
        },
        run: (params) => api.updateOutline(params.novelId, { raw_outline: params.synopsis }),
    });

    tools.push({
        name: 'setLanguage',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '设置项目语言（zh/en）',
        parameters: {
            novelId: { type: 'string', required: true },
            language: { type: 'string', required: true, description: '"zh" 或 "en"' },
        },
        run: (params) => {
            if (!['zh', 'en'].includes(params.language)) return { ok: false, error: 'language 必须是 zh 或 en' };
            api._store.exec(`UPDATE _ainovel_novels SET language = ?, updated_at = ? WHERE id = ?`,
                params.language, Math.floor(Date.now() / 1000), params.novelId);
            return { ok: true };
        },
    });

    // ============= 写 - 异步（5） =============
    tools.push({
        name: 'generateOutline',
        category: TOOL_CATEGORIES.WRITE_ASYNC,
        description: '异步重新生成大纲（AI 长任务，前端通过 SSE 接收进度）',
        parameters: { novelId: { type: 'string', required: true } },
        run: async (params) => {
            // 调用 callSkill 触发；返回 {ok, jobId}
            const novel = api.getNovel(params.novelId);
            if (!novel) return { ok: false, error: '小说不存在' };
            // 实际触发由前端 main.js 处理；此处仅返回标记
            return { ok: true, async: true, kind: 'outline', message: '大纲生成已触发，详见 SSE 事件' };
        },
    });

    tools.push({
        name: 'generateChapter',
        category: TOOL_CATEGORIES.WRITE_ASYNC,
        description: '异步生成指定章节（AI 长任务）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
        },
        run: async (params) => ({ ok: true, async: true, kind: 'chapter', chapterNo: params.chapterNo, message: '章节生成已触发，详见 SSE 事件' }),
    });

    tools.push({
        name: 'reviseChapter',
        category: TOOL_CATEGORIES.WRITE_ASYNC,
        description: '异步重写指定章节（带反馈/要求）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
            feedback: { type: 'string', required: true, description: '修改要求' },
        },
        run: async (params) => ({ ok: true, async: true, kind: 'chapter-revise', chapterNo: params.chapterNo, message: '章节修订已触发' }),
    });

    tools.push({
        name: 'runFactCheck',
        category: TOOL_CATEGORIES.WRITE_ASYNC,
        description: '对指定章节跑一次事实核查（不动章节，只返回报告）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
        },
        run: async (params) => ({ ok: true, async: true, kind: 'fact-check', chapterNo: params.chapterNo }),
    });

    tools.push({
        name: 'applyConfigChange',
        category: TOOL_CATEGORIES.WRITE_SAFE,
        description: '应用 AI 改已填字段的待确认变更（用户已审过）',
        parameters: {
            novelId: { type: 'string', required: true },
            changeIds: { type: 'array', required: true },
        },
        run: (params) => api.applyConfigChanges(params.novelId, params.changeIds),
    });

    // ============= 写 - 破坏性（5） =============
    tools.push({
        name: 'deleteChapter',
        category: TOOL_CATEGORIES.WRITE_DESTRUCTIVE,
        requiresConfirm: true,
        description: '【破坏性】删除单个章节正文（仅清 content/status，章节行保留以维持编号）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
        },
        run: (params) => {
            const ch = api._store && api._store.query('SELECT id FROM _ainovel_chapters WHERE novel_id = ? AND chapter_no = ?', params.novelId, params.chapterNo)[0];
            if (!ch) return { ok: false, error: '章节不存在' };
            api._store.exec(
                `UPDATE _ainovel_chapters SET content = NULL, summary = NULL, actual_word_count = 0, status = 'pending', updated_at = ? WHERE id = ?`,
                Math.floor(Date.now() / 1000), ch.id
            );
            return { ok: true, chapterId: ch.id, cleared: true };
        },
    });

    tools.push({
        name: 'deleteChaptersFrom',
        category: TOOL_CATEGORIES.WRITE_DESTRUCTIVE,
        requiresConfirm: true,
        description: '【破坏性】删除从 chapterNo 起往后的所有章节正文（保留行结构）',
        parameters: {
            novelId: { type: 'string', required: true },
            chapterNo: { type: 'number', required: true },
        },
        run: (params) => {
            const chapters = api._store && api._store.query(
                'SELECT chapter_no FROM _ainovel_chapters WHERE novel_id = ? AND chapter_no >= ? ORDER BY chapter_no',
                params.novelId, params.chapterNo
            );
            if (!chapters.length) return { ok: false, error: '无可删章节' };
            api._store.exec(
                `UPDATE _ainovel_chapters SET content = NULL, summary = NULL, actual_word_count = 0, status = 'pending', updated_at = ? WHERE novel_id = ? AND chapter_no >= ?`,
                Math.floor(Date.now() / 1000), params.novelId, params.chapterNo
            );
            return { ok: true, clearedCount: chapters.length, fromChapter: params.chapterNo };
        },
    });

    tools.push({
        name: 'deleteArc',
        category: TOOL_CATEGORIES.WRITE_DESTRUCTIVE,
        requiresConfirm: true,
        description: '【破坏性】删除卷（不删章节）',
        parameters: { arcId: { type: 'string', required: true } },
        run: (params) => api.deleteArc(params.arcId),
    });

    tools.push({
        name: 'resetProgress',
        category: TOOL_CATEGORIES.WRITE_DESTRUCTIVE,
        requiresConfirm: true,
        description: '【破坏性】将所有 done 章节重置为 pending（重新生成）',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => {
            const r = api._store.exec(
                `UPDATE _ainovel_chapters SET status = 'pending', content = NULL, summary = NULL, actual_word_count = 0, updated_at = ? WHERE novel_id = ? AND status = 'done'`,
                Math.floor(Date.now() / 1000), params.novelId
            );
            return { ok: true };
        },
    });

    tools.push({
        name: 'deleteForeshadow',
        category: TOOL_CATEGORIES.WRITE_DESTRUCTIVE,
        requiresConfirm: true,
        description: '【破坏性】删除单个伏笔',
        parameters: { id: { type: 'string', required: true } },
        run: (params) => api.deleteForeshadow(params.id),
    });

    // ============= 元（3） =============
    tools.push({
        name: 'pauseAutoLoop',
        category: TOOL_CATEGORIES.META,
        description: '暂停自动写作循环',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => api.pauseAuto(params.novelId),
    });

    tools.push({
        name: 'resumeAutoLoop',
        category: TOOL_CATEGORIES.META,
        description: '恢复自动写作循环',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => api.resumeAuto(params.novelId),
    });

    tools.push({
        name: 'cancelAutoLoop',
        category: TOOL_CATEGORIES.META,
        description: '取消自动写作循环',
        parameters: { novelId: { type: 'string', required: true } },
        run: (params) => api.cancelAuto(params.novelId),
    });

    return tools;
}

// 返回工具的 OpenAI 兼容 schema（用于 LLM tool calling）
function toolsToOpenAISchema(tools) {
    return tools.map(t => {
        const properties = {};
        const required = [];
        for (const [k, v] of Object.entries(t.parameters || {})) {
            let type = v.type || 'string';
            if (type === 'array') type = 'array';
            if (type === 'object') type = 'object';
            if (type === 'number' || type === 'integer') type = 'number';
            properties[k] = { type, description: v.description || '' };
            if (v.required) required.push(k);
        }
        return {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: {
                    type: 'object',
                    properties,
                    required,
                },
            },
        };
    });
}

// 工具系统提示（含 Edit!=Delete 护栏）
function buildToolsSystemPrompt(tools) {
    const byCategory = {};
    for (const t of tools) {
        if (!byCategory[t.category]) byCategory[t.category] = [];
        byCategory[t.category].push(t);
    }
    const lines = [];
    lines.push('## 安全规则（最高优先级，违反将造成用户数据永久丢失）');
    lines.push('1. **修改 ≠ 删除**。"修改某章正文" 必须用 updateChapterContent，绝不可以用 deleteChapter');
    lines.push('2. **破坏性工具**（标记【破坏性】的）必须先复述范围（如"将清除第 6 章正文"）并等用户确认，**确认后才能调用**');
    lines.push('3. 不要扩大删除范围（如用户说"删第6章"不要顺便删第7章）');
    lines.push('4. 涉及 outline / 已填字段的修改时，先用 readXxx 工具读现状，再决定是否调用 createPendingConfigChange');
    lines.push('');
    lines.push('## 工具选择指南');
    lines.push('- 修改某章正文 → updateChapterContent(novelId, chapterNo, content)');
    lines.push('- 修改大纲 → updateOutlineField(novelId, { field: value })');
    lines.push('- 重新生成大纲 → generateOutline(novelId)');
    lines.push('- 重新生成某章 → generateChapter(novelId, chapterNo)');
    lines.push('- 缩章/增章 → setChapterCount（通过 updateOutlineField 调 chapter_list）');
    lines.push('- 跑事实核查 → runFactCheck(novelId, chapterNo)');
    lines.push('- 应用待确认变更 → applyConfigChange(novelId, [changeIds])');
    lines.push('');
    lines.push('## 工具列表（按类别）');
    for (const cat of [TOOL_CATEGORIES.READ, TOOL_CATEGORIES.WRITE_SAFE, TOOL_CATEGORIES.WRITE_ASYNC, TOOL_CATEGORIES.WRITE_DESTRUCTIVE, TOOL_CATEGORIES.META]) {
        const list = byCategory[cat] || [];
        if (!list.length) continue;
        lines.push(`### ${cat}`);
        for (const t of list) {
            const mark = t.requiresConfirm ? '【破坏性】' : '';
            lines.push(`- **${t.name}** ${mark}: ${t.description}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = {
    TOOL_CATEGORIES,
    _buildChatTools,
    toolsToOpenAISchema,
    buildToolsSystemPrompt,
};