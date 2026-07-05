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
        // 事件订阅（每个返回 unsubscribe 函数）
        onProgress: _listen('comfyui:event:progress'),
        onComplete: _listen('comfyui:event:complete'),
        onError: _listen('comfyui:event:error'),
        onExit: _listen('comfyui:event:exit'),
    },
    // ========= 资产存储（读取 .meta.json 旁路元数据 + 删除资产）=========
    assets: {
        readMeta: (filename) => ipcRenderer.invoke('assets:readMeta', { filename }),
        delete: (filename) => ipcRenderer.invoke('assets:delete', { filename }),
    },
    // ========= AI 工具（声明式 schema 驱动的 workflow 表单）==========
    tools: {
        list: () => ipcRenderer.invoke('tools:list'),
        get: (id) => ipcRenderer.invoke('tools:get', id),
        run: (payload) => ipcRenderer.invoke('tools:run', payload),
    },
});
