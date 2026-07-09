// scripts/smoke-create-link-args.js — 验证 createLinkElevated 调用 fs.symlinkSync 的参数
// 关键回归测试：原本用于 catch mklink 参数顺序被写反的 bug（D-28）。
// D-29 重构后实现改用 fs.symlinkSync（Win32 CreateSymbolicLinkW 直调），
// 同样 mock 真实文件系统调用，抓 args，强制保证 fs.symlinkSync 的参数顺序不会写反。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

// 在 require loras-store 之前替换 fs.symlinkSync
const realSymlinkSync = fs.symlinkSync;
let lastSymlinkArgs = null;  // 抓最后一次 fs.symlinkSync 调用参数
fs.symlinkSync = function mockedSymlinkSync(target, link, type) {
    lastSymlinkArgs = { target, link, type };
    // 不真建 symlink，但要让 existsSync(linkAbs) 看起来成功了
    // 通过把 linkAbs 路径记录下来，让测试在 close 阶段手动 fake 一个存在性
};

// 同样 mock existsSync，只针对被记录的 link 路径返回 true
const realExistsSync = fs.existsSync;
fs.existsSync = function mockedExistsSync(p) {
    if (lastSymlinkArgs && p === lastSymlinkArgs.link) return true;
    return realExistsSync(p);
};

let pass = 0, fail = 0;
const expect = (label, cond, detail) => {
    if (cond) { console.log('  ✅', label); pass++; }
    else { console.log('  ❌', label, '|', detail || ''); fail++; }
};

app.on('ready', async () => {
    const { createLinkElevated } = require('../loras-store');

    console.log('===== 验证 createLinkElevated → fs.symlinkSync 参数顺序 =====\n');

    // 准备两个明显区分的路径
    const targetAbs = 'C:\\Users\\test\\AppData\\assets\\loras\\files\\42__real_file.safetensors';
    const linkAbs = 'C:\\Users\\test\\ComfyUI\\models\\loras\\real_file.safetensors';

    lastSymlinkArgs = null;
    const ok = await createLinkElevated(targetAbs, linkAbs);

    console.log('实际传给 fs.symlinkSync 的参数:');
    console.log('  target:', JSON.stringify(lastSymlinkArgs && lastSymlinkArgs.target));
    console.log('  link  :', JSON.stringify(lastSymlinkArgs && lastSymlinkArgs.link));
    console.log('  type  :', JSON.stringify(lastSymlinkArgs && lastSymlinkArgs.type));
    console.log('  ok    :', ok);
    console.log('');

    // 核心断言：fs.symlinkSync 必须是 (target, link, 'file') 顺序
    expect('fs.symlinkSync 被调用', lastSymlinkArgs !== null);
    expect("arg0 = target（真实文件，assets 端）",
        lastSymlinkArgs.target === targetAbs,
        `got ${JSON.stringify(lastSymlinkArgs.target)}`);
    expect("arg1 = link（新建符号链接，ComfyUI 端）",
        lastSymlinkArgs.link === linkAbs,
        `got ${JSON.stringify(lastSymlinkArgs.link)}`);
    expect("arg2 = 'file'（文件 symlink，不是目录）",
        lastSymlinkArgs.type === 'file',
        `got ${JSON.stringify(lastSymlinkArgs.type)}`);

    // 反向断言（防"再次写反"）
    expect('arg0 不是 link（不能再写反）',
        lastSymlinkArgs.target !== linkAbs,
        `arg0 === link 说明顺序又错了`);
    expect('arg1 不是 target（不能再写反）',
        lastSymlinkArgs.link !== targetAbs,
        `arg1 === target 说明顺序又错了`);

    // 成功路径：mock 让 existsSync(link) 返回 true → 应该返回 true
    expect('成功路径返回 true', ok === true, `got ${ok}`);

    // 失败路径：让 mock fs.symlinkSync 抛 EPERM（模拟无权限 / 文件已存在）
    fs.symlinkSync = function throwingSymlink() {
        const e = new Error('模拟权限不足');
        e.code = 'EPERM';
        throw e;
    };
    lastSymlinkArgs = null;
    const okFail = await createLinkElevated(targetAbs, linkAbs);
    expect('失败路径（EPERM）返回 false', okFail === false, `got ${okFail}`);

    try { fs.rmSync(os.tmpdir() + '/smoke-*', { recursive: true, force: true }); } catch (_) {}
    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    // 还原 mock，避免影响其他测试
    fs.symlinkSync = realSymlinkSync;
    fs.existsSync = realExistsSync;
    app.exit(fail > 0 ? 1 : 0);
});