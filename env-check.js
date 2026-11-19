// env-check.js — 环境检查：扫描用户解压的 ComfyUI 根目录，识别组件并生成清单
//
// 用户从网盘下载解压后，选中一个根目录（如 D:\RxAi-ComfyUI），本模块负责：
//   1) 识别 python_embeded（python.exe + Lib/site-packages）
//   2) 识别 ComfyUI 核心（main.py + comfy/ 等）
//   3) 识别已安装的 custom_nodes 插件
//   4) 识别 models 目录里的模型文件
//   5) 计算可用配置（pythonPath / comfyDir），返回给用户确认后再应用
//
// 只读扫描，不复制、不安装、不执行任何被扫描目录里的代码。

'use strict';
const fs = require('fs');
const path = require('path');

const MODEL_EXTS = new Set(['.safetensors', '.ckpt', '.gguf', '.bin', '.pt', '.pth', '.onnx', '.fp16', '.engine', '.trt', '.sft', '.h5', '.msgpack', '.tflite', '.ggml']);

function fileSize(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}
function dirSize(dir, maxFiles = 20000) {
    let sum = 0, count = 0;
    const stack = [dir];
    while (stack.length && count < maxFiles) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (count >= maxFiles) break;
            const full = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile()) { sum += fileSize(full); count++; }
        }
    }
    return { bytes: sum, files: count, truncated: count >= maxFiles };
}
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// 在 root 下寻找 python.exe（支持 root 直放、root\python_embeded、root\python、任意一级子目录）
function findPython(root) {
    const candidates = [
        path.join(root, 'python.exe'),
        path.join(root, 'python_embeded', 'python.exe'),
        path.join(root, 'python', 'python.exe'),
        path.join(root, 'python_embeded', 'Scripts', 'python.exe'),
    ];
    for (const p of candidates) if (exists(p)) return p;
    // 扫一级子目录
    try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = path.join(root, e.name, 'python.exe');
            if (exists(p)) return p;
        }
    } catch {}
    return null;
}

// 找 ComfyUI 核心目录：含 main.py 且含 comfy/ 或 nodes.py
function findComfyDir(root) {
    const candidates = [
        root,
        path.join(root, 'ComfyUI'),
        path.join(root, 'comfyui'),
        path.join(root, 'ComfyUI', 'ComfyUI'),
    ];
    for (const p of candidates) {
        if (exists(path.join(p, 'main.py')) && (exists(path.join(p, 'comfy')) || exists(path.join(p, 'nodes.py')))) return p;
    }
    // 扫一级子目录
    try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const p = path.join(root, e.name);
            if (exists(path.join(p, 'main.py')) && (exists(path.join(p, 'comfy')) || exists(path.join(p, 'nodes.py')))) return p;
        }
    } catch {}
    return null;
}

function scanPlugins(comfyDir) {
    const dir = path.join(comfyDir, 'custom_nodes');
    const out = [];
    if (!isDir(dir)) return out;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith('.')) continue;
            const p = path.join(dir, e.name);
            const hasInit = exists(path.join(p, '__init__.py'));
            const hasReq = exists(path.join(p, 'requirements.txt')) || exists(path.join(p, 'requirements.txt'));
            const pyCount = (() => {
                let c = 0;
                try { for (const f of fs.readdirSync(p)) if (f.endsWith('.py')) c++; } catch {}
                return c;
            })();
            out.push({
                name: e.name,
                path: p,
                looksLikePlugin: hasInit || pyCount > 0 || hasReq,
                hasRequirements: hasReq,
                pyCount,
            });
        }
    } catch {}
    return out;
}

function scanModels(comfyDir) {
    const modelsRoot = path.join(comfyDir, 'models');
    const out = { dir: modelsRoot, exists: isDir(modelsRoot), symlinks: [], byType: [], totalBytes: 0, totalCount: 0, sample: [] };
    if (!out.exists) return out;
    try {
        for (const e of fs.readdirSync(modelsRoot, { withFileTypes: true })) {
            const full = path.join(modelsRoot, e.name);
            const isLink = !!(e.isSymbolicLink && e.isSymbolicLink()) || !!(fs.lstatSync(full).isSymbolicLink());
            if (isLink) {
                let target = '';
                try { target = fs.readlinkSync(full); } catch {}
                const valid = exists(full);
                out.symlinks.push({ name: e.name, target, valid });
                continue;
            }
            if (!e.isDirectory()) continue;
            // 普通子目录：统计模型文件
            let bytes = 0, count = 0;
            const stack = [full];
            while (stack.length) {
                const cur = stack.pop();
                let entries;
                try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
                for (const en of entries) {
                    const fp = path.join(cur, en.name);
                    if (en.isDirectory()) stack.push(fp);
                    else if (en.isFile() && MODEL_EXTS.has(path.extname(en.name).toLowerCase())) {
                        const sz = fileSize(fp);
                        bytes += sz; count++;
                        if (out.sample.length < 30) out.sample.push({ name: en.name, rel: path.relative(modelsRoot, fp).replace(/\\/g, '/'), size: sz });
                    }
                }
            }
            if (count) out.byType.push({ type: e.name, count, bytes });
            out.totalBytes += bytes; out.totalCount += count;
        }
    } catch {}
    return out;
}

/**
 * 扫描根目录
 * @param {string} root 用户选择的解压根目录
 * @returns {{ok, root, python:Object, comfy:Object, plugins:Array, models:Object, config:Object, problems:Array, warnings:Array}}
 */
function scan(root) {
    if (!root || typeof root !== 'string' || !path.isAbsolute(root)) {
        return { ok: false, error: '请选择一个有效的绝对路径' };
    }
    if (!isDir(root)) return { ok: false, error: '目录不存在或不是文件夹' };

    const pyPath = findPython(root);
    const comfyDir = findComfyDir(root);
    const python = {
        found: !!pyPath,
        path: pyPath,
        version: null,
        hasSitePackages: false,
    };
    if (pyPath) {
        const base = path.dirname(pyPath);
        python.hasSitePackages = isDir(path.join(base, 'Lib', 'site-packages'));
    }

    const comfy = { found: !!comfyDir, path: comfyDir, hasMain: false, hasCore: false };
    if (comfyDir) {
        comfy.hasMain = exists(path.join(comfyDir, 'main.py'));
        comfy.hasCore = exists(path.join(comfyDir, 'comfy')) || exists(path.join(comfyDir, 'nodes.py'));
    }

    const plugins = comfyDir ? scanPlugins(comfyDir) : [];
    const models = comfyDir ? scanModels(comfyDir) : { dir: '', exists: false, symlinks: [], byType: [], totalBytes: 0, totalCount: 0, sample: [] };

    const problems = [];
    const warnings = [];
    if (!python.found) problems.push('未找到 python.exe（Python 环境包没解压到位）');
    else if (!python.hasSitePackages) problems.push('Python 目录缺少 Lib/site-packages（环境不完整）');
    if (!comfy.found) problems.push('未找到 ComfyUI 核心（缺 main.py / comfy 目录）');
    if (python.found && comfy.found) {
        const realPlugins = plugins.filter(p => p.looksLikePlugin);
        warnings.push(`检测到 ${realPlugins.length} 个插件`);
        if (models.exists) {
            const badLinks = models.symlinks.filter(s => !s.valid);
            if (badLinks.length) warnings.push(`${badLinks.length} 个模型目录是失效的符号链接（指向本机不存在的路径）`);
        }
    }

    return {
        ok: true,
        root,
        python,
        comfy,
        plugins,
        models,
        config: {
            pythonPath: python.path || '',
            comfyDir: comfy.path || '',
            canApply: !!(python.found && comfy.found),
        },
        problems,
        warnings,
    };
}

module.exports = { scan, findPython, findComfyDir, MODEL_EXTS };
