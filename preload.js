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
    engineeringFlow: {
        load: () => ipcRenderer.invoke('engineeringFlow:load'),
        save: graph => ipcRenderer.invoke('engineeringFlow:save', graph),
        run: graph => ipcRenderer.invoke('engineeringFlow:run', graph),
        status: () => ipcRenderer.invoke('engineeringFlow:status'),
        cancel: () => ipcRenderer.invoke('engineeringFlow:cancel'),
        pick: kind => ipcRenderer.invoke('engineeringFlow:pick', kind),
    },
    resourceStation: {
        nasImport: input => ipcRenderer.invoke('resourceStation:nasImport', input),
        nasImportCancel: requestId => ipcRenderer.invoke('resourceStation:nasImportCancel', requestId),
        onNasImportProgress: _listen('resourceStation:nasImportProgress'),
        torrentUpload: () => ipcRenderer.invoke('resourceStation:torrentUpload'),
        torrentExport: (videoId, attachmentId) => ipcRenderer.invoke('resourceStation:torrentExport', videoId, attachmentId),
        addMetadata: input => ipcRenderer.invoke('resourceStation:addMetadata', input),
        videoDuration: (id, sourceId, duration) => ipcRenderer.invoke('resourceStation:videoDuration', id, sourceId, duration),
        actorList: () => ipcRenderer.invoke('resourceStation:actorList'),
        actorSave: input => ipcRenderer.invoke('resourceStation:actorSave', input),
        actorRemove: target => ipcRenderer.invoke('resourceStation:actorRemove', target),
        actorImages: () => ipcRenderer.invoke('resourceStation:actorImages'),
        actorImport: url => ipcRenderer.invoke('resourceStation:actorImport', url),
        onActorImportProgress: _listen('resourceStation:actorImportProgress'),
        saveCover: (id, sourceId, dataUrl, sourceUrl) => ipcRenderer.invoke('resourceStation:saveCover', id, sourceId, dataUrl, sourceUrl),
        saveBackdrop: (id, sourceId, dataUrl) => ipcRenderer.invoke('resourceStation:saveBackdrop', id, sourceId, dataUrl),
        list: () => ipcRenderer.invoke('resourceStation:list'),
        import: mode => ipcRenderer.invoke('resourceStation:import', mode),
        update: (id, data) => ipcRenderer.invoke('resourceStation:update', id, data),
        progress: (id, data) => ipcRenderer.invoke('resourceStation:progress', id, data),
        remove: id => ipcRenderer.invoke('resourceStation:remove', id),
        addSource: (id, label) => ipcRenderer.invoke('resourceStation:addSource', id, label),
        removeSource: (id, sourceId) => ipcRenderer.invoke('resourceStation:removeSource', id, sourceId),
        image: (id, field) => ipcRenderer.invoke('resourceStation:image', id, field),
        nasConfigGet: () => ipcRenderer.invoke('resourceStation:nasConfigGet'),
        nasConfigSet: input => ipcRenderer.invoke('resourceStation:nasConfigSet', input),
        matchConfirmBatch: selections => ipcRenderer.invoke('resourceStation:matchConfirmBatch', selections),
        matchActor: (fileId, actorId) => ipcRenderer.invoke('resourceStation:matchActor', fileId, actorId),
        matchScan: () => ipcRenderer.invoke('resourceStation:matchScan'),
        matchList: () => ipcRenderer.invoke('resourceStation:matchList'),
        matchSuggest: fileId => ipcRenderer.invoke('resourceStation:matchSuggest', fileId),
        matchConfirm: (fileId, videoId, candidate) => ipcRenderer.invoke('resourceStation:matchConfirm', fileId, videoId, candidate),
        matchIgnore: fileId => ipcRenderer.invoke('resourceStation:matchIgnore', fileId),
        matchReset: fileId => ipcRenderer.invoke('resourceStation:matchReset', fileId),
        matchClear: () => ipcRenderer.invoke('resourceStation:matchClear'),
    },
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
    // ========= 环境检查（扫描解压后的 ComfyUI 根目录并应用配置） =========
    envCheck: {
        pickRoot: () => ipcRenderer.invoke('envCheck:pickRoot'),
        scan: (root) => ipcRenderer.invoke('envCheck:scan', root),
        apply: (payload) => ipcRenderer.invoke('envCheck:apply', payload || {}),
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
    // ========= 自定义配方（提示词配方库，存 prompts.db 的 kv）=========
    recipes: {
        list:   ()      => ipcRenderer.invoke('recipe:list'),
        save:   (recipe) => ipcRenderer.invoke('recipe:save', recipe),
        delete: (id)     => ipcRenderer.invoke('recipe:delete', id),
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
        getWorkflow: (id) => ipcRenderer.invoke('tools:getWorkflow', id),
        run: (payload) => ipcRenderer.invoke('tools:run', payload),
        // 2026-11 图形化导入向导 + 免重启刷新
        reload: () => ipcRenderer.invoke('tools:reload'),
        import: (payload) => ipcRenderer.invoke('tools:import', payload),
        generateSchema: (payload) => ipcRenderer.invoke('tools:generateSchema', payload),
        pickWorkflowFile: () => ipcRenderer.invoke('tools:pickWorkflowFile'),
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
        resultItems: (queueId) => ipcRenderer.invoke('taskQueue:result:items', queueId),
        resultSaveAs: (payload) => ipcRenderer.invoke('taskQueue:result:saveAs', payload || {}),
        findByForm: (payload) => ipcRenderer.invoke('taskQueue:findByForm', payload || {}),
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
        // Sprint 6.1: Block 模型
        getChapterBlocks:    (novelId, chapterId) => ipcRenderer.invoke('ainovel:chapter:getBlocks', { novelId, chapterId }),
        getChapterWithBlocks: (novelId, chapterId) => ipcRenderer.invoke('ainovel:chapter:getWithBlocks', { novelId, chapterId }),
        replaceBlock:        (novelId, chapterId, blockId, text) => ipcRenderer.invoke('ainovel:chapter:replaceBlock', { novelId, chapterId, blockId, text }),
        deleteBlock:         (novelId, chapterId, blockId) => ipcRenderer.invoke('ainovel:chapter:deleteBlock', { novelId, chapterId, blockId }),
        insertBlock:         (novelId, chapterId, afterBlockId, text, blockType) => ipcRenderer.invoke('ainovel:chapter:insertBlock', { novelId, chapterId, afterBlockId, text, blockType }),
        reviseBlock:         (novelId, chapterId, blockId, feedback) => ipcRenderer.invoke('ainovel:chapter:reviseBlock', { novelId, chapterId, blockId, feedback }),
        exportTxt:           (novelId) => ipcRenderer.invoke('ainovel:exportTxt', { novelId }),
        getProviderConfig:   () => ipcRenderer.invoke('ainovel:getProviderConfig'),
        setProviderConfig:   (cfg) => ipcRenderer.invoke('ainovel:setProviderConfig', cfg || {}),
        testProvider:        (cfg) => ipcRenderer.invoke('ainovel:testProvider', cfg || {}),
        supportsThinking:    (payload) => ipcRenderer.invoke('ainovel:supportsThinking', payload || {}),
        listGenerations:     (novelId) => ipcRenderer.invoke('ainovel:listGenerations', { novelId }),
        getGeneration:       (id) => ipcRenderer.invoke('ainovel:getGeneration', { id }),
        // Phase 2: 自动推进模式
        autoStart:           (novelId, opts) => ipcRenderer.invoke('ainovel:autoStart', { novelId, autoConfirm: !!(opts && opts.autoConfirm) }),
        autoPause:           (novelId) => ipcRenderer.invoke('ainovel:autoPause', { novelId }),
        autoResume:          (novelId) => ipcRenderer.invoke('ainovel:autoResume', { novelId }),
        autoCancel:          (novelId) => ipcRenderer.invoke('ainovel:autoCancel', { novelId }),
        autoSetConfirm:      (novelId, enabled) => ipcRenderer.invoke('ainovel:autoSetConfirm', { novelId, enabled }),
        confirmChapter:      (novelId, chapterId) => ipcRenderer.invoke('ainovel:chapter:confirm', { novelId, chapterId }),
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
        // Sprint 6.2: Skill 开关
        toggleSkill:            (skill, enabled) => ipcRenderer.invoke('ainovel:skills:toggle', { skill, enabled }),
        enabledSkillsList:      (category) => ipcRenderer.invoke('ainovel:skills:enabledList', { category }),
        // Sprint 7.1: 卷(arc)层级大纲
        listArcs:          (novelId) => ipcRenderer.invoke('ainovel:arcs:list', { novelId }),
        getArc:            (novelId, arcId) => ipcRenderer.invoke('ainovel:arcs:get', { novelId, arcId }),
        createArc:         (novelId, payload) => ipcRenderer.invoke('ainovel:arcs:create', { novelId, ...payload }),
        updateArc:         (novelId, arcId, patch) => ipcRenderer.invoke('ainovel:arcs:update', { novelId, arcId, patch }),
        deleteArc:         (novelId, arcId) => ipcRenderer.invoke('ainovel:arcs:delete', { novelId, arcId }),
        validateArcs:      (novelId, chapterCount) => ipcRenderer.invoke('ainovel:arcs:validate', { novelId, chapterCount }),
        generateArcSkeleton: (novelId, payload) => ipcRenderer.invoke('ainovel:arcs:skeleton', { novelId, ...payload }),
        generateArcOutline:  (novelId, payload) => ipcRenderer.invoke('ainovel:arcs:outline', { novelId, ...payload }),
        appendArc:         (novelId, payload) => ipcRenderer.invoke('ainovel:arcs:append', { novelId, ...payload }),
        // Sprint 7.2: 伏笔系统
        listForeshadows:    (novelId, status) => ipcRenderer.invoke('ainovel:foreshadows:list', { novelId, status }),
        createForeshadow:   (novelId, payload) => ipcRenderer.invoke('ainovel:foreshadows:create', { novelId, ...payload }),
        updateForeshadow:   (novelId, id, patch) => ipcRenderer.invoke('ainovel:foreshadows:update', { novelId, id, patch }),
        deleteForeshadow:   (novelId, id) => ipcRenderer.invoke('ainovel:foreshadows:delete', { novelId, id }),
        pushForeshadowEvent: (novelId, id, event) => ipcRenderer.invoke('ainovel:foreshadows:pushEvent', { novelId, id, event }),
        resolveForeshadow:  (novelId, id, resolution) => ipcRenderer.invoke('ainovel:foreshadows:resolve', { novelId, id, resolution }),
        confirmForeshadows: (novelId, items) => ipcRenderer.invoke('ainovel:foreshadows:confirm', { novelId, items }),
        generateForeshadowRoadmap: (novelId) => ipcRenderer.invoke('ainovel:foreshadows:roadmap', { novelId }),
        suggestForeshadows: (novelId, chapterNo) => ipcRenderer.invoke('ainovel:foreshadows:suggest', { novelId, chapterNo }),
        // Sprint 7.3: 叙事记忆
        listMemory:       (novelId, opts) => ipcRenderer.invoke('ainovel:memory:list', { novelId, ...(opts || {}) }),
        createMemory:     (novelId, payload) => ipcRenderer.invoke('ainovel:memory:create', { novelId, ...payload }),
        updateMemory:     (novelId, id, patch) => ipcRenderer.invoke('ainovel:memory:update', { novelId, id, patch }),
        deleteMemory:     (novelId, id) => ipcRenderer.invoke('ainovel:memory:delete', { novelId, id }),
        memoryByChapter:  (novelId, chapter) => ipcRenderer.invoke('ainovel:memory:byChapter', { novelId, chapter }),
        extractMemory:    (novelId, chapterNo) => ipcRenderer.invoke('ainovel:memory:extract', { novelId, chapterNo }),
        // Sprint 8.2: 写作冲突（事实核查自动重写耗尽）
        listConflicts:    (novelId, opts) => ipcRenderer.invoke('ainovel:conflict:list', { novelId, ...(opts || {}) }),
        getConflict:      (conflictId) => ipcRenderer.invoke('ainovel:conflict:get', { conflictId }),
        conflictForChapter: (novelId, chapterId) => ipcRenderer.invoke('ainovel:conflict:forChapter', { novelId, chapterId }),
        resolveConflict:  (conflictId, action) => ipcRenderer.invoke('ainovel:conflict:resolve', { conflictId, action }),
        clearConflicts:   (novelId, chapterId) => ipcRenderer.invoke('ainovel:conflict:clear', { novelId, chapterId }),
        // Sprint 8.3: 关系图谱
        listRelations:    (novelId, opts) => ipcRenderer.invoke('ainovel:relations:list', { novelId, ...(opts || {}) }),
        getRelation:      (id) => ipcRenderer.invoke('ainovel:relations:get', { id }),
        createRelation:   (novelId, payload) => ipcRenderer.invoke('ainovel:relations:create', { novelId, ...payload }),
        updateRelation:   (id, patch) => ipcRenderer.invoke('ainovel:relations:update', { id, patch }),
        deleteRelation:   (id) => ipcRenderer.invoke('ainovel:relations:delete', { id }),
        bulkAdoptRelations: (novelId, items) => ipcRenderer.invoke('ainovel:relations:bulkAdopt', { novelId, items }),
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
        // Sprint C-S1: 共享上下文层（前端调试面板用 + orchestrator 内部用）
        sharedContextSet:     (novelId, key, value, opts) => ipcRenderer.invoke('ainovel:sharedContextSet', Object.assign({ novelId, key, value }, opts || {})),
        sharedContextGet:     (novelId, key) => ipcRenderer.invoke('ainovel:sharedContextGet', { novelId, key }),
        sharedContextListKeys:(novelId) => ipcRenderer.invoke('ainovel:sharedContextListKeys', { novelId }),
        sharedContextStats:   (novelId) => ipcRenderer.invoke('ainovel:sharedContextStats', { novelId }),
        // Sprint C-S1: 成本追踪
        costSnapshot:         (novelId) => ipcRenderer.invoke('ainovel:costSnapshot', { novelId }),
        costAcknowledgeWarn:  (novelId) => ipcRenderer.invoke('ainovel:costAcknowledgeWarn', { novelId }),
        getCapabilityRegistry: () => ipcRenderer.invoke('ainovel:getCapabilityRegistry'),
        // Sprint C-S2: orchestrator 控制（前端 DAG view + 调试面板）
        orchestratorRun:           (plan) => ipcRenderer.invoke('ainovel:orchestrator:run', { plan }),
        orchestratorCancel:        (reason) => ipcRenderer.invoke('ainovel:orchestrator:cancel', { reason: reason || 'user-cancelled' }),
        orchestratorPause:        (reason) => ipcRenderer.invoke('ainovel:orchestrator:pause', { reason: reason || 'user-paused' }),
        orchestratorResume:       (action, extra) => ipcRenderer.invoke('ainovel:orchestrator:resume', { action: action || 'resume', extra }),
        orchestratorFullStatus:   () => ipcRenderer.invoke('ainovel:orchestrator:fullStatus'),
        costSnapshot:             (novelId) => ipcRenderer.invoke('ainovel:cost:snapshot', { novelId }),
        setCostThreshold:         (novelId, usd) => ipcRenderer.invoke('ainovel:cost:setThreshold', { novelId, usd }),
        orchestratorStatus:        () => ipcRenderer.invoke('ainovel:orchestrator:status'),
        orchestratorSnapshot:     () => ipcRenderer.invoke('ainovel:orchestrator:snapshot'),
        orchestratorListCapabilities: () => ipcRenderer.invoke('ainovel:orchestrator:listCapabilities'),
        orchestratorPlanOutline:   (novelId) => ipcRenderer.invoke('ainovel:orchestrator:planOutline', { novelId }),
        orchestratorPlanChapter:   (novelId, chapterId) => ipcRenderer.invoke('ainovel:orchestrator:planChapter', { novelId, chapterId }),
        // Sprint 9.1: AI 助理 chat
        chatListSessions:    (novelId) => ipcRenderer.invoke('ainovel:chat:listSessions', { novelId }),
        chatCreateSession:   (novelId, title) => ipcRenderer.invoke('ainovel:chat:createSession', { novelId, title }),
        chatGetSession:      (sessionId) => ipcRenderer.invoke('ainovel:chat:getSession', { sessionId }),
        chatDeleteSession:   (sessionId) => ipcRenderer.invoke('ainovel:chat:deleteSession', { sessionId }),
        chatAppendMessage:   (sessionId, message) => ipcRenderer.invoke('ainovel:chat:appendMessage', { sessionId, message }),
        chatUpdateSession:   (sessionId, patch) => ipcRenderer.invoke('ainovel:chat:updateSession', { sessionId, patch }),
        chatTrimHistory:     (sessionId, maxMessages) => ipcRenderer.invoke('ainovel:chat:trimHistory', { sessionId, maxMessages }),
        chatSendMessage:     (sessionId, message, opts) => ipcRenderer.invoke('ainovel:chat:sendMessage', { sessionId, message, opts: opts || {} }),
        // Sprint 9.2: 配置变更（pending config changes）
        configListPendingChanges: (novelId) => ipcRenderer.invoke('ainovel:config:listPendingChanges', { novelId }),
        configCreatePendingChange: (novelId, change) => ipcRenderer.invoke('ainovel:config:createPendingChange', { novelId, change }),
        configResolveChange: (id, status) => ipcRenderer.invoke('ainovel:config:resolveChange', { id, status }),
        configApplyChanges: (novelId, changeIds) => ipcRenderer.invoke('ainovel:config:applyChanges', { novelId, changeIds }),
        configDismissChanges: (novelId, changeIds) => ipcRenderer.invoke('ainovel:config:dismissChanges', { novelId, changeIds }),
        // 主进程推小说事件（outline_generated / chapter_generated / novel_added / pipeline_* / auto_* / knowledge_* / orchestrator_* 等）
        onUpdate:            _listen('ainovel:event:update'),
    },
});
