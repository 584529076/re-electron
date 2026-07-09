// scripts/smoke-link-type.js — 探测 link_type（新模型：统一走 UAC 提权 → admin mklink）
// 默认实现 spawn PowerShell RunAs，在 smoke 环境没 admin 时会失败。
// 这里通过注入 createLink 模拟「提权成功」，验证 link_type 写入逻辑。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

app.on('ready', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-type-'));
    const { KVDb } = require('../db');
    const { LorasStore } = require('../loras-store');
    const store = new KVDb(path.join(tmpRoot, 't.db'));
    const loras = new LorasStore({
        store,
        getAssetsDir: () => path.join(tmpRoot, 'a'),
        getComfyConfig: () => ({ comfyDir: path.join(tmpRoot, 'c') }),
    });
    loras.ensureTable();
    fs.mkdirSync(path.join(tmpRoot, 'a', 'loras', 'files'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'c', 'models', 'loras'), { recursive: true });
    const src = path.join(tmpRoot, 'src.safetensors');
    fs.writeFileSync(src, Buffer.alloc(1024, 'x'));

    // 用 hardlink 模拟 admin mklink 的成功（不依赖 UAC，smoke 环境可用）。
    // 这验证 addLora 在 createLink 返回 true 时正确写入 link_type='symlink'。
    const mockCreateLink = async (targetAbs, linkAbs) => {
        try { fs.linkSync(targetAbs, linkAbs); return true; }
        catch (e) { return false; }
    };
    const r = await loras.addLora({
        meta: { lora_type: 'clothing', name: 'shirt.safetensors' },
        srcPath: src,
        createLink: mockCreateLink,
    });
    console.log('link_type =', JSON.stringify(r.link_type));
    console.log('linkError =', JSON.stringify(r._linkError));
    console.log('asset file exists =', fs.existsSync(path.join(tmpRoot, 'a', r.file_path)));
    console.log('link dst exists  =', fs.existsSync(r._linkDst));
    try {
        console.log('link is symlink   =', fs.lstatSync(r._linkDst).isSymbolicLink());
        console.log('link is file      =', fs.lstatSync(r._linkDst).isFile());
        console.log('asset inode == link inode =',
            fs.statSync(path.join(tmpRoot, 'a', r.file_path)).ino ===
            fs.statSync(r._linkDst).ino);
    } catch (e) {
        console.log('lstat failed:', e.message);
    }

    // 也验证 createLink 返回 false 时的整体失败语义 + 回滚
    console.log('--- 测 createLink 失败路径（含回滚验证）---');
    let threwAsExpected = false;
    let rollbackWorked = false;
    const dbRowsBefore = store.query('SELECT COUNT(*) AS c FROM loras')[0].c;
    const filesBefore = fs.readdirSync(path.join(tmpRoot, 'a', 'loras', 'files'));
    try {
        await loras.addLora({
            meta: { lora_type: 'clothing', name: 'fail.safetensors' },
            srcPath: src,
            createLink: async () => false,  // 模拟 UAC 拒绝
        });
    } catch (e) {
        threwAsExpected = /提权 mklink 失败/.test(e.message);
        console.log('addLora threw:', e.message);
        // 验证回滚：DB 行没多、资产文件没多
        const dbRowsAfter = store.query('SELECT COUNT(*) AS c FROM loras')[0].c;
        const filesAfter = fs.readdirSync(path.join(tmpRoot, 'a', 'loras', 'files'));
        rollbackWorked = dbRowsBefore === dbRowsAfter && filesBefore.length === filesAfter.length;
        console.log('回滚校验: db rows', dbRowsBefore, '->', dbRowsAfter, '| files', filesBefore.length, '->', filesAfter.length,
            '=', rollbackWorked ? 'OK' : 'FAIL');
    }
    console.log('createLink=false 时 addLora throw =', threwAsExpected);
    console.log('createLink=false 时回滚（无孤儿 DB 行 + 资产文件）=', rollbackWorked);

    // 验证 ComfyUI 目录已有同名文件时的回滚
    // （用一个新名字 fsclash.safetensors，避开 DB UNIQUE，提前在 ComfyUI 目录里占位）
    console.log('--- 测 ComfyUI 目录同名冲突路径（含回滚验证）---');
    let clashWorked = false;
    let clashRollbackOk = false;
    const clashName = 'fsclash.safetensors';
    const beforeClash = store.query('SELECT COUNT(*) AS c FROM loras')[0].c;
    const beforeClashFiles = fs.readdirSync(path.join(tmpRoot, 'a', 'loras', 'files'));
    // 在 ComfyUI loras 目录里放一个同名占位
    const clashPath = path.join(tmpRoot, 'c', 'models', 'loras', clashName);
    fs.writeFileSync(clashPath, 'preexisting');
    try {
        await loras.addLora({
            meta: { lora_type: 'clothing', name: clashName },
            srcPath: src,
            createLink: mockCreateLink,
        });
    } catch (e) {
        clashWorked = /已存在同名文件/.test(e.message);
        console.log('addLora threw:', e.message);
        const afterClash = store.query('SELECT COUNT(*) AS c FROM loras')[0].c;
        const afterClashFiles = fs.readdirSync(path.join(tmpRoot, 'a', 'loras', 'files'));
        // 验证：DB 没新增 row、资产目录没新增 final 文件、用户原占位文件仍在
        clashRollbackOk = beforeClash === afterClash
            && beforeClashFiles.length === afterClashFiles.length
            && fs.existsSync(clashPath);
        console.log('同名冲突回滚（DB 不增 + 资产不增 + 不动用户原文件）=', clashRollbackOk ? 'OK' : 'FAIL');
    }
    console.log('同名冲突 addLora throw =', clashWorked);

    const allPass = threwAsExpected && rollbackWorked && clashWorked && clashRollbackOk;
    store.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.log('rm warn:', e.message); }
    app.exit(allPass ? 0 : 1);
});