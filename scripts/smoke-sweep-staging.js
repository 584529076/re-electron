// scripts/smoke-sweep-staging.js — 验证 sweepStagingFiles GC 行为
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

app.on('ready', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-staging-'));
    const assetsDir = path.join(tmpRoot, 'a');
    const lorasFiles = path.join(assetsDir, 'loras', 'files');
    fs.mkdirSync(lorasFiles, { recursive: true });

    // 准备测试文件：
    //   old.tmp-*    mtime 2 小时前 → 应删
    //   fresh.tmp-*  mtime now      → 应留
    //   canonical    <id>__x.safetensors → 不应碰
    //   other.txt    无关文件         → 不应碰
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const oldTmp = path.join(lorasFiles, '.tmp-' + twoHoursAgo + '-aaaaaa');
    const freshTmp = path.join(lorasFiles, '.tmp-' + Date.now() + '-bbbbbb');
    const canonical = path.join(lorasFiles, '99__keepme.safetensors');
    const otherFile = path.join(lorasFiles, 'notes.txt');

    fs.writeFileSync(oldTmp, 'old');
    fs.writeFileSync(freshTmp, 'fresh');
    fs.writeFileSync(canonical, 'canonical-content');
    fs.writeFileSync(otherFile, 'unrelated');

    // 把 oldTmp 的 mtime 强制改成 2 小时前
    fs.utimesSync(oldTmp, twoHoursAgo / 1000, twoHoursAgo / 1000);

    // 跑 sweep（maxAgeMs 默认 1 小时）
    const { KVDb } = require('../db');
    const { LorasStore } = require('../loras-store');
    const store = new KVDb(path.join(tmpRoot, 't.db'));
    const loras = new LorasStore({
        store,
        getAssetsDir: () => assetsDir,
        getComfyConfig: () => ({ comfyDir: '' }),
    });
    loras.ensureTable();
    const sweep = loras.sweepStagingFiles();
    console.log('sweep result:', sweep);

    let pass = 0, fail = 0;
    const expect = (label, cond, detail) => {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    };

    expect('old .tmp- 被删', !fs.existsSync(oldTmp));
    expect('fresh .tmp- 保留', fs.existsSync(freshTmp));
    expect('canonical <id>__* 保留', fs.existsSync(canonical));
    expect('other file 保留', fs.existsSync(otherFile));
    expect('swept 计数 = 1', sweep.swept === 1, `got ${sweep.swept}`);
    expect('errors 为空', sweep.errors.length === 0, JSON.stringify(sweep.errors));

    // 验证自定义 maxAgeMs：freshTmp 5 分钟前，maxAge=2 分钟 → 应删（5min > 2min 老化阈值）
    fs.utimesSync(freshTmp, (Date.now() - 5 * 60 * 1000) / 1000, (Date.now() - 5 * 60 * 1000) / 1000);
    const sweep2 = loras.sweepStagingFiles(2 * 60 * 1000);
    expect('自定义 maxAgeMs 也生效', sweep2.swept === 1 && !fs.existsSync(freshTmp));

    // 不存在的目录应安全返回空结果（建到 loras 这一层即可，files 不建 → sweep 应空返回）
    const fakeStore = path.join(tmpRoot, 'b');
    fs.mkdirSync(path.join(fakeStore, 'loras'), { recursive: true });
    const loras2 = new LorasStore({
        store,
        getAssetsDir: () => fakeStore,
        getComfyConfig: () => ({ comfyDir: '' }),
    });
    const sweep3 = loras2.sweepStagingFiles();
    expect('目录不存在时不报错', sweep3.swept === 0 && sweep3.errors.length === 0);

    store.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});
