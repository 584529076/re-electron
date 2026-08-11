// preload.js — 把 Node 文件 API 通过 contextBridge 安全暴露给 web/js/script.js
// 这样 script.js 仍然用 window.api.xxx(...) 这种纯 JS 写法，不直接 require
const { contextBridge, ipcRenderer } = require('electron');

// 内部辅助：把 ipcRenderer.on 包装成 unsubscribe 函数，外部可在 close 时清理
function _listen(channel) {
    return (cb) => {
        const wrapped = (_e, payload) => cb(payload);
        ipcRenderer.on(channel, wrapped);
        return () => ipcRenderer.removeListener(channel, wrapped);
    };
}

contextBridge.exposeInMainWorld('api', {
    prompts: {
        readAll: () => ipcRenderer.invoke('prompts:readAll'),
        writeOne: (id, prompt, tags) => ipcRenderer.invoke('prompts:writeOne', { id, prompt, tags }),
        writeOneWithMedia: (id, prompt, tags, mediaPath, mediaMime, mediaSize) => ipcRenderer.invoke('prompts:writeOne', { id, prompt, tags, mediaPath, mediaMime, mediaSize }),
        deleteOne: (id) => ipcRenderer.invoke('prompts:deleteOne', id),
        info: () => ipcRenderer.invoke('prompts:info'),
    },
    // ========= D-25 配置管理 =========
    config: {
        get: () => ipcRenderer.invoke('config:get'),
        set: (config) => ipcRenderer.invoke('config:set', config),
        loadResource: (source) => ipcRenderer.invoke('config:resource:load', { source }),
        pickDir: () => ipcRenderer.invoke('config:pickDir'),
        // 资产存储路径（默认 userData/assets）
        assetsGet: () => ipcRenderer.invoke('config:assets:get'),
        assetsSet: (cfg) => ipcRenderer.invoke('config:assets:set', cfg),
        assetsPick: () => ipcRenderer.invoke('config:assets:pick'),
        assetsOpen: () => ipcRenderer.invoke('config:assets:open'),
    },
    // ========= D-27 提示词生成（Ollama 本地 LLM） =========
    llm: {
        listModels: () => ipcRenderer.invoke('llm:listModels'),
        configGet: () => ipcRenderer.invoke('llm:config:get'),
        configSet: (config) => ipcRenderer.invoke('llm:config:set', config),
        generate: (payload) => ipcRenderer.invoke('llm:generate', payload),
        cancel: (jobId) => ipcRenderer.invoke('llm:cancel', jobId),
    },
    promptModules: {
        get: () => ipcRenderer.invoke('prompt:modules:get'),
        upsert: (m) => ipcRenderer.invoke('prompt:module:upsert', m),
        delete: (id) => ipcRenderer.invoke('prompt:module:delete', id),
    },
    promptTags: {
        get: (moduleId) => ipcRenderer.invoke('prompt:tags:get', moduleId || null),
        upsert: (t) => ipcRenderer.invoke('prompt:tag:upsert', t),
        delete: (id) => ipcRenderer.invoke('prompt:tag:delete', id),
    },
    promptHistory: {
        list: () => ipcRenderer.invoke('prompt:history:list'),
        clear: () => ipcRenderer.invoke('prompt:history:clear'),
    },
    // ========= D-35 拼装规则 =========
    assembleRule: {
        get: () => ipcRenderer.invoke('prompt:assembleRule:get'),
        set: (rule) => ipcRenderer.invoke('prompt:assembleRule:set', rule),
    },
    // ========= D-31 提示词分类管理（prompt_menu） =========
    promptMenu: {
        list: () => ipcRenderer.invoke('prompt:menu:list'),
        add: (item) => ipcRenderer.invoke('prompt:menu:add', item),
        update: (item) => ipcRenderer.invoke('prompt:menu:update', item),
        delete: (id) => ipcRenderer.invoke('prompt:menu:delete', id),
        get: (id) => ipcRenderer.invoke('prompt:menu:get', id),
    },
    // ========= D-31 提示词条目管理（prompt_items） =========
    promptItems: {
        list: (categoryId) => ipcRenderer.invoke('prompt:item:list', { category_id: categoryId }),
        listByCategories: (ids) => ipcRenderer.invoke('prompt:item:listByCategories', { category_ids: ids }),
        add: (item) => ipcRenderer.invoke('prompt:item:add', item),
        update: (item) => ipcRenderer.invoke('prompt:item:update', item),
        delete: (id) => ipcRenderer.invoke('prompt:item:delete', id),
        get: (id) => ipcRenderer.invoke('prompt:item:get', id),
        getByIds: (ids) => ipcRenderer.invoke('prompt:item:getByIds', { ids }),
        listAll: () => ipcRenderer.invoke('prompt:item:listAll'),
        import: (rows) => ipcRenderer.invoke('prompt:item:import', { rows }),
    },
    // ========= 提示词库（prompt_library：单表 + tags CSV 列） =========
    promptLibrary: {
        tagList:   ()   => ipcRenderer.invoke('prompt:library:tag:list'),
        tagDelete: (name) => ipcRenderer.invoke('prompt:library:tag:delete', name),
        itemList:  (tagName) => ipcRenderer.invoke('prompt:library:item:list', { tag_name: tagName || '' }),
        itemAdd:    (p)  => ipcRenderer.invoke('prompt:library:item:add', p),
        itemUpdate: (p)  => ipcRenderer.invoke('prompt:library:item:update', p),
        itemDelete: (id) => ipcRenderer.invoke('prompt:library:item:delete', id),
    },
    // ========= 提示词预览图（<promptsDir>/previews/<id>-<ts>.<ext>）=========
    promptPreview: {
        upload: (payload) => ipcRenderer.invoke('prompt:preview:upload', payload),
        read:   (payload) => ipcRenderer.invoke('prompt:preview:read', payload),
        delete: (payload) => ipcRenderer.invoke('prompt:preview:delete', payload),
    },
    // ========= D-29 NSFW 模式 =========
    nsfw: {
        fetchReadme: () => ipcRenderer.invoke('nsfw:fetchReadme'),
        getSource: () => ipcRenderer.invoke('nsfw:source:get'),
        // D-30: 本地模板拼装
        importTemplates: (dir) => ipcRenderer.invoke('nsfw:importTemplates', { dir }),
        listTemplates: (module) => ipcRenderer.invoke('nsfw:listTemplates', { module }),
        assemble: (payload) => ipcRenderer.invoke('nsfw:assemble', payload),
        assembleAndRefine: (payload) => ipcRenderer.invoke('nsfw:assembleAndRefine', payload),
    },
    // ========= D-37 + D-38: 关联规则 + 校验 =========
    promptAssociationListByItem: (itemId) => ipcRenderer.invoke('prompt:association:listByItem', { itemId }),
    promptAssociationListAll: () => ipcRenderer.invoke('prompt:association:listAll'),
    promptAssociationUpsert: (payload) => ipcRenderer.invoke('prompt:association:upsert', payload),
    promptAssociationDelete: (id) => ipcRenderer.invoke('prompt:association:delete', id),
    promptAssociationImport: (rows) => ipcRenderer.invoke('prompt:association:import', { rows }),
    nsfwValidate: (itemIds) => ipcRenderer.invoke('nsfw:validate', { itemIds }),
    sceneTemplateList: () => ipcRenderer.invoke('scene:template:list'),
    sceneTemplateAdd: (payload) => ipcRenderer.invoke('scene:template:add', payload),
    sceneTemplateUpdate: (payload) => ipcRenderer.invoke('scene:template:update', payload),
    sceneTemplateToggleEnabled: (payload) => ipcRenderer.invoke('scene:template:toggleEnabled', payload),
    sceneTemplateDelete: (payload) => ipcRenderer.invoke('scene:template:delete', payload),
    // ========= D-NSFW-A: NSFW 模板导入（向导）==========
    promptItemFindDuplicates: (names) => ipcRenderer.invoke('prompt:item:findDuplicates', { names }),
    promptItemMerge: (targetId, srcIds) => ipcRenderer.invoke('prompt:item:merge', { target_id: targetId, src_ids: srcIds }),
    promptAssociationPreviewImport: (assocs) => ipcRenderer.invoke('prompt:association:previewImport', { associations: assocs }),
    promptExampleList: (categoryId) => ipcRenderer.invoke('prompt:example:list', { category_id: categoryId || null }),
    promptExampleImport: (examples) => ipcRenderer.invoke('prompt:example:import', { examples }),
    promptImportHistoryList: () => ipcRenderer.invoke('prompt:importHistory:list'),
    promptImportHistoryAdd: (record) => ipcRenderer.invoke('prompt:importHistory:add', record || {}),
    promptNsfwImportExecute: (payload) => ipcRenderer.invoke('prompt:nsfwImport:execute', payload || {}),
    promptNsfwImportRunParse: (payload) => ipcRenderer.invoke('prompt:nsfwImport:runParse', payload || {}),
    // ========= ComfyUI（AI 生图）=========
    comfyui: {
        configGet: () => ipcRenderer.invoke('comfyui:config:get'),
        configSet: (cfg) => ipcRenderer.invoke('comfyui:config:set', cfg),
        start: (cfg) => ipcRenderer.invoke('comfyui:start', cfg || {}),
        stop: () => ipcRenderer.invoke('comfyui:stop'),
        status: () => ipcRenderer.invoke('comfyui:status'),
        health: () => ipcRenderer.invoke('comfyui:health'),
        pickPython: () => ipcRenderer.invoke('comfyui:pickPython'),
        pickComfyDir: () => ipcRenderer.invoke('comfyui:pickComfyDir'),
        pickOutputDir: () => ipcRenderer.invoke('comfyui:pickOutputDir'),
        pickImage: () => ipcRenderer.invoke('comfyui:pickImage'),
        stageImage: (payload) => ipcRenderer.invoke('comfyui:stageImage', payload || {}),
        stageImageData: (payload) => ipcRenderer.invoke('comfyui:stageImageData', payload || {}),
        fetchImageToBase64: (payload) => ipcRenderer.invoke('comfyui:fetchImageToBase64', payload || {}),
        listWorkflows: () => ipcRenderer.invoke('comfyui:listWorkflows'),
        openOutputDir: () => ipcRenderer.invoke('comfyui:openOutputDir'),
        generate: (payload) => ipcRenderer.invoke('comfyui:generate', payload),
        cancel: (jobId) => ipcRenderer.invoke('comfyui:cancel', jobId),
        saveMedia: (payload) => ipcRenderer.invoke('comfyui:saveMedia', payload),
        saveAsset: (payload) => ipcRenderer.invoke('comfyui:saveAsset', payload),
        saveAs: (payload) => ipcRenderer.invoke('comfyui:saveAs', payload),
        readMedia: (payload) => ipcRenderer.invoke('comfyui:readMedia', payload),
        // D-MID-COMPARE：把本地图片读成 dataUrl（compare 模式渲染输入图）
        imageReadAsDataUrl: (payload) => ipcRenderer.invoke('comfyui:image:readAsDataUrl', payload || {}),
        // 终端日志环形缓冲（renderer 右侧浮层用）
        logGet: () => ipcRenderer.invoke('comfyui:log:get'),
        logClear: () => ipcRenderer.invoke('comfyui:log:clear'),
        // 事件订阅（每个返回 unsubscribe 函数）
        onProgress: _listen('comfyui:event:progress'),
        onComplete: _listen('comfyui:event:complete'),
        onError: _listen('comfyui:event:error'),
        onExit: _listen('comfyui:event:exit'),
        onStarting: _listen('comfyui:event:starting'),
        onReady: _listen('comfyui:event:ready'),
        onLog: _listen('comfyui:event:log'),
    },
    // ========= 资产存储（读取 .meta.json 旁路元数据 + 删除资产 + 资产生成历史）=========
    assets: {
        readMeta: (filename) => ipcRenderer.invoke('assets:readMeta', { filename }),
        delete: (filename) => ipcRenderer.invoke('assets:delete', { filename }),
        listHistory: (opts) => ipcRenderer.invoke('assets:listHistory', opts || {}),
    },
    // ========= D-SYSINFO：设置页「系统信息」tab 取数 =========
    systeminfo: {
        get: () => ipcRenderer.invoke('systeminfo:get'),
    },
    // ========= AI 工具（声明式 schema 驱动的 workflow 表单）==========
    tools: {
        list: () => ipcRenderer.invoke('tools:list'),
        get: (id) => ipcRenderer.invoke('tools:get', id),
        run: (payload) => ipcRenderer.invoke('tools:run', payload),
    },
    // ========= D-QUEUE：任务队列（透明接管 tools:run）==========
    taskQueue: {
        // 注：enqueue 是同步返回 queueId；list/cancel/remove/reorder 都走 IPC
        enqueue: (payload) => ipcRenderer.invoke('taskQueue:enqueue', payload || {}),
        list:    (opts) => ipcRenderer.invoke('taskQueue:list', opts || {}),
        cancel:  (queueId) => ipcRenderer.invoke('taskQueue:cancel', queueId),
        remove:  (queueId) => ipcRenderer.invoke('taskQueue:remove', queueId),
        reorder: (from, to) => ipcRenderer.invoke('taskQueue:reorder', { from, to }),
        resultReadAsDataUrl: (queueId) => ipcRenderer.invoke('taskQueue:result:readAsDataUrl', queueId),
        // 主进程推任务状态变化（added/status/progress/result/removed/reordered）
        onUpdate: _listen('taskQueue:event:update'),
    },
    // ========= Lora 库（Phase 1：数据层）==========
    loras: {
        list:         (filter) => ipcRenderer.invoke('loras:list', filter || {}),
        get:          (id) => ipcRenderer.invoke('loras:get', id),
        add:          (payload) => ipcRenderer.invoke('loras:add', payload || {}),
        update:       (payload) => ipcRenderer.invoke('loras:update', payload || {}),
        delete:       (id) => ipcRenderer.invoke('loras:delete', id),
        pickFile:     () => ipcRenderer.invoke('loras:pickFile'),
        pickCover:    () => ipcRenderer.invoke('loras:pickCover'),
        setCover:     (payload) => ipcRenderer.invoke('loras:setCover', payload || {}),
        clearCover:   (id) => ipcRenderer.invoke('loras:clearCover', id),
        readCover:    (id) => ipcRenderer.invoke('loras:readCover', id),
        // 入参改为 model 数组（schema.models）+ 后向兼容单字符串。
        // 内部 main.js handler 直接透传给 loras-store.listCompatibleLoras，
        // 后者会把字符串包成 [str]、数组直接用、空值返回全部。
        listByModel:  (modelOrArray) => ipcRenderer.invoke('loras:listByModel', modelOrArray || []),
        resolveByNames: (basenames) => ipcRenderer.invoke('loras:resolveByNames', basenames || []),
        types:        () => ipcRenderer.invoke('loras:types'),
    },
    // ========= AI 小说（独立模块；不动现有任何功能）==========
    ainovel: {
        list:                () => ipcRenderer.invoke('ainovel:list'),
        create:              (payload) => ipcRenderer.invoke('ainovel:create', payload || {}),
        get:                 (novelId) => ipcRenderer.invoke('ainovel:get', { novelId }),
        delete:              (novelId) => ipcRenderer.invoke('ainovel:delete', { novelId }),
        updateOutline:       (novelId, outlinePatch) => ipcRenderer.invoke('ainovel:updateOutline', { novelId, outlinePatch }),
        generateOutline:     (novelId) => ipcRenderer.invoke('ainovel:generateOutline', { novelId }),
        writeChapter:        (novelId, chapterId) => ipcRenderer.invoke('ainovel:writeChapter', { novelId, chapterId }),
        updateChapter:       (novelId, chapterId, patch) => ipcRenderer.invoke('ainovel:updateChapter', { novelId, chapterId, ...patch }),
        exportTxt:           (novelId) => ipcRenderer.invoke('ainovel:exportTxt', { novelId }),
        getProviderConfig:   () => ipcRenderer.invoke('ainovel:getProviderConfig'),
        setProviderConfig:   (cfg) => ipcRenderer.invoke('ainovel:setProviderConfig', cfg || {}),
        testProvider:        (cfg) => ipcRenderer.invoke('ainovel:testProvider', cfg || {}),
        listGenerations:     (novelId) => ipcRenderer.invoke('ainovel:listGenerations', { novelId }),
        getGeneration:       (id) => ipcRenderer.invoke('ainovel:getGeneration', { id }),
        // Phase 2: 自动推进模式
        autoStart:           (novelId) => ipcRenderer.invoke('ainovel:autoStart', { novelId }),
        autoPause:           (novelId) => ipcRenderer.invoke('ainovel:autoPause', { novelId }),
        autoResume:          (novelId) => ipcRenderer.invoke('ainovel:autoResume', { novelId }),
        autoCancel:          (novelId) => ipcRenderer.invoke('ainovel:autoCancel', { novelId }),
        getAutoStatus:       (novelId) => ipcRenderer.invoke('ainovel:getAutoStatus', { novelId }),
        // Phase 3: 知识库 CRUD
        getKnowledge:        (novelId, kind) => ipcRenderer.invoke('ainovel:getKnowledge', { novelId, kind: kind || null }),
        extractKnowledge:    (novelId, kinds) => ipcRenderer.invoke('ainovel:extractKnowledge', { novelId, kinds: kinds || [] }),
        updateKnowledge:     (id, patch) => ipcRenderer.invoke('ainovel:updateKnowledge', { id, patch: patch || {} }),
        deleteKnowledge:     (id) => ipcRenderer.invoke('ainovel:deleteKnowledge', { id }),
        // Phase 4-A: 故事架构
        getArchitecture:        (novelId) => ipcRenderer.invoke('ainovel:getArchitecture', { novelId }),
        updateArchitecture:     (novelId, patch) => ipcRenderer.invoke('ainovel:updateArchitecture', { novelId, patch: patch || {} }),
        regenerateArchitecture: (novelId) => ipcRenderer.invoke('ainovel:regenerateArchitecture', { novelId }),
        // Phase 4-Sprint D/E/F: OpenClaw 模式（用户反馈 + Agent 配置 + 记忆管理）
        saveAgentFeedback:      (payload) => ipcRenderer.invoke('ainovel:saveAgentFeedback', payload || {}),
        listAgentFeedback:      (payload) => ipcRenderer.invoke('ainovel:listAgentFeedback', payload || {}),
        getAgentConfig:         (skill) => ipcRenderer.invoke('ainovel:getAgentConfig', { skill }),
        saveAgentConfig:        (skill, filename, content) => ipcRenderer.invoke('ainovel:saveAgentConfig', { skill, filename, content }),
        listMemoryLogs:         (payload) => ipcRenderer.invoke('ainovel:listMemoryLogs', payload || {}),
        flushMemory:            (payload) => ipcRenderer.invoke('ainovel:flushMemory', payload || {}),
        listSkills:             () => ipcRenderer.invoke('ainovel:listSkills'),
        // Sprint H: LLM-driven 多 agent 协作（黑板 / 收件箱 / 任务图 / 编剧调度）
        blackboardList:   (novelId) => ipcRenderer.invoke('ainovel:blackboardList', { novelId }),
        blackboardRead:   (novelId, key) => ipcRenderer.invoke('ainovel:blackboardRead', { novelId, key }),
        blackboardWrite:  (novelId, key, value, owner) => ipcRenderer.invoke('ainovel:blackboardWrite', { novelId, key, value, owner }),
        blackboardClear:  (novelId, key) => ipcRenderer.invoke('ainovel:blackboardClear', { novelId, key: key || null }),
        inboxList:        (novelId, agentName) => ipcRenderer.invoke('ainovel:inboxList', { novelId, agentName }),
        inboxSend:        (novelId, opts) => ipcRenderer.invoke('ainovel:inboxSend', Object.assign({ novelId }, opts || {})),
        inboxMarkRead:    (novelId, agentName, ids) => ipcRenderer.invoke('ainovel:inboxMarkRead', { novelId, agentName, ids: ids || null }),
        taskList:         (novelId, opts) => ipcRenderer.invoke('ainovel:taskList', Object.assign({ novelId }, opts || {})),
        taskCreate:       (novelId, opts) => ipcRenderer.invoke('ainovel:taskCreate', Object.assign({ novelId }, opts || {})),
        taskGet:          (taskId) => ipcRenderer.invoke('ainovel:taskGet', { taskId }),
        taskComplete:     (taskId, result) => ipcRenderer.invoke('ainovel:taskComplete', { taskId, result }),
        taskFail:         (taskId, error) => ipcRenderer.invoke('ainovel:taskFail', { taskId, error }),
        taskReady:        (novelId, agentName) => ipcRenderer.invoke('ainovel:taskReady', { novelId, agentName: agentName || null }),
        runDirector:      (novelId, goal, input) => ipcRenderer.invoke('ainovel:runDirector', { novelId, goal, input: input || {} }),
        getDirectorMode:  () => ipcRenderer.invoke('ainovel:getDirectorMode'),
        setDirectorMode:  (mode) => ipcRenderer.invoke('ainovel:setDirectorMode', { mode }),
        getSetting:       (key) => ipcRenderer.invoke('ainovel:getSetting', { key }),
        setSetting:       (key, value) => ipcRenderer.invoke('ainovel:setSetting', { key, value }),
        // Sprint W: 工作面板事件流
        listWorkflowEvents:     (novelId, opts) => ipcRenderer.invoke('ainovel:listWorkflowEvents', { novelId, opts: opts || {} }),
        listWorkflowReplay:     (novelId, opts) => ipcRenderer.invoke('ainovel:listWorkflowReplay', { novelId, opts: opts || {} }),
        getWorkflowEventDetail: (id) => ipcRenderer.invoke('ainovel:getWorkflowEventDetail', { id }),
        getWorkflowStats:       (novelId) => ipcRenderer.invoke('ainovel:getWorkflowStats', { novelId }),
        // Phase 4-B: 圣经状态 + atomic commit
        getNovelState:        (novelId) => ipcRenderer.invoke('ainovel:getNovelState', { novelId }),
        atomicCommitState:    (novelId, patch) => ipcRenderer.invoke('ainovel:atomicCommitState', { novelId, patch: patch || {} }),
        resetNovelState:      (novelId) => ipcRenderer.invoke('ainovel:resetNovelState', { novelId }),
        // 主进程推小说事件（outline_generated / chapter_generated / novel_added / pipeline_* / auto_* / knowledge_* 等）
        onUpdate:            _listen('ainovel:event:update'),
    },
});
