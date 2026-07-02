// comfyui-workflows.js — workflow JSON 加载 + placeholder 注入
//
// 启动时（initAll）从 resources/comfyui-workflows/ 读 2 个 JSON + 2 个 meta.json
// 缓存到内存 Map。JSON 解析失败标 broken 不崩。
// 生成时（injectAndClone）clone 一份，把 <POSITIVE_PROMPT> 替换为用户 prompt。

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const POSITIVE_PLACEHOLDER = '<POSITIVE_PROMPT>';

function getWorkflowsDir() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'resources', 'comfyui-workflows');
    return path.join(__dirname, 'resources', 'comfyui-workflows');
}

// mode ('sfw' | 'nsfw') → { name, mode, placeholders, defaultResolution, notes }
//                    + raw workflow JSON
const _workflows = new Map();
const _metas = new Map();

function loadAll() {
    _workflows.clear();
    _metas.clear();
    const dir = getWorkflowsDir();
    for (const mode of ['sfw', 'nsfw']) {
        const wfPath = path.join(dir, `workflow_${mode}.json`);
        const metaPath = path.join(dir, `workflow_${mode}.meta.json`);
        try {
            const txt = fs.readFileSync(wfPath, 'utf-8');
            const json = JSON.parse(txt);
            _workflows.set(mode, { json, broken: false, error: null, path: wfPath });
        } catch (e) {
            console.warn(`[comfyui-workflows] 加载 ${wfPath} 失败: ${e.message}`);
            _workflows.set(mode, { json: null, broken: true, error: e.message, path: wfPath });
        }
        try {
            const txt = fs.readFileSync(metaPath, 'utf-8');
            const meta = JSON.parse(txt);
            _metas.set(mode, meta);
        } catch (e) {
            _metas.set(mode, { name: mode.toUpperCase(), mode, placeholders: [POSITIVE_PLACEHOLDER], notes: 'meta 加载失败' });
        }
    }
}

function listWorkflows() {
    const out = [];
    for (const mode of ['sfw', 'nsfw']) {
        const w = _workflows.get(mode) || {};
        const m = _metas.get(mode) || {};
        out.push({
            mode,
            name: m.name || mode,
            broken: !!w.broken,
            error: w.error || null,
            placeholders: m.placeholders || [POSITIVE_PLACEHOLDER],
            defaultResolution: m.defaultResolution || '',
            notes: m.notes || '',
            hasPositive: !w.broken && JSON.stringify(w.json || {}).includes(POSITIVE_PLACEHOLDER),
        });
    }
    return out;
}

/**
 * 拿到 mode 对应 workflow 的深拷贝，注入 prompt 字符串。
 * 占位符缺失：替换为空串 + 返回 warning。
 */
function injectAndClone(mode, positivePrompt, negativePrompt) {
    const w = _workflows.get(mode);
    if (!w) return { ok: false, error: `workflow_${mode}.json 未加载` };
    if (w.broken || !w.json) return { ok: false, error: `workflow_${mode}.json 损坏: ${w.error}` };
    const txt = JSON.stringify(w.json);
    if (!txt.includes(POSITIVE_PLACEHOLDER)) {
        return { ok: false, error: `workflow_${mode} 缺少 ${POSITIVE_PLACEHOLDER} 占位符`, warning: 'missing_placeholder' };
    }
    const replaced = txt.split(POSITIVE_PLACEHOLDER).join(positivePrompt || '');
    // v1: negativePrompt 暂不注入（plan 明确）
    const out = JSON.parse(replaced);
    return { ok: true, workflow: out, missingPlaceholder: false };
}

module.exports = {
    loadAll,
    listWorkflows,
    injectAndClone,
    getWorkflowsDir,
    POSITIVE_PLACEHOLDER,
};
