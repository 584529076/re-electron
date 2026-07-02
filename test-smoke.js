// test-smoke.js — D:\re-electron 的端到端 smoke 测试
//
// 目的：不开 Electron 窗口，单独验证 main.js 里的 store 逻辑
//
// 覆盖：
//  - KVDb 加载
//  - 从 JSON 迁移到 SQLite（把测试用 JSON 写到临时目录，验证被读进 db 且原文件改名为 .bak）
//  - 写一条 / 读所有 / 删一条
//  - 接口返回值结构与 main.js 的 IPC handler 一致

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { KVDb } = require('./db');

// 复制 main.js 里的 initStore / migrate 逻辑（避免启 Electron）
function initStoreWithDir(promptsDir) {
    fs.mkdirSync(promptsDir, { recursive: true });
    const dbPath = path.join(promptsDir, 'prompts.db');
    const store = new KVDb(dbPath);

    // migrate
    if (Object.keys(store.all()).length === 0) {
        const files = fs.readdirSync(promptsDir).filter((f) => f.endsWith('.json'));
        for (const f of files) {
            const full = path.join(promptsDir, f);
            try {
                const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
                if (!data || !data.id) continue;
                store.set(data.id, {
                    id: data.id,
                    prompt: data.prompt || '',
                    tags: Array.isArray(data.tags) ? data.tags : [],
                    ts: data.ts || 0,
                    schemaVersion: data.schemaVersion || 1,
                });
                try { fs.renameSync(full, full + '.bak'); } catch {}
            } catch (e) {
                console.warn(`skip ${f}: ${e.message}`);
            }
        }
    }
    return store;
}

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 're-prompt-'));
}

test('smoke: 首次启动从 prompts/*.json 迁移到 SQLite', () => {
    const dir = mkTmp();
    // 写 3 条测试数据
    fs.writeFileSync(path.join(dir, 'rec-1.json'), JSON.stringify({ id: 'rec-1', prompt: 'hello', tags: ['a'], ts: 1000, schemaVersion: 1 }));
    fs.writeFileSync(path.join(dir, 'rec-2.json'), JSON.stringify({ id: 'rec-2', prompt: 'world', tags: [], ts: 2000, schemaVersion: 1 }));
    fs.writeFileSync(path.join(dir, 'rec-3.json'), JSON.stringify({ id: 'rec-3', prompt: 'foo', tags: ['b', 'c'], ts: 3000 }));

    const s = initStoreWithDir(dir);

    const all = s.all();
    assert.equal(Object.keys(all).length, 3);
    assert.equal(all['rec-1'].prompt, 'hello');
    assert.deepEqual(all['rec-2'].tags, []);
    assert.equal(all['rec-3'].schemaVersion, 1);  // 缺省补 1

    // 原 JSON 文件被改名为 .bak
    assert.equal(fs.existsSync(path.join(dir, 'rec-1.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'rec-1.json.bak')), true);

    // 二次启动：不会重复迁移（db 非空跳过）
    const s2 = initStoreWithDir(dir);
    assert.equal(Object.keys(s2.all()).length, 3);
});

test('smoke: 写一条 → readAll 能看到', () => {
    const dir = mkTmp();
    const s = initStoreWithDir(dir);
    s.set('new-id', { id: 'new-id', prompt: 'fresh', tags: ['x'], ts: 9999, schemaVersion: 1 });

    const all = s.all();
    assert.equal(all['new-id'].prompt, 'fresh');
});

test('smoke: 删除一条 → 读不到', () => {
    const dir = mkTmp();
    const s = initStoreWithDir(dir);
    s.set('to-delete', { id: 'to-delete', prompt: 'p', tags: [], ts: 1, schemaVersion: 1 });
    assert.equal(s.get('to-delete') !== null && s.get('to-delete') !== undefined, true);

    s.set('to-delete', null);  // KVDb: null = 删除
    assert.equal(s.get('to-delete'), null);
});

test('smoke: 损坏的 JSON 文件被跳过，不抛', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not valid json');
    const s = initStoreWithDir(dir);
    assert.equal(Object.keys(s.all()).length, 0);
    // 损坏文件保留（不覆盖证据）
    assert.equal(fs.existsSync(path.join(dir, 'broken.json')), true);
});

test('smoke: 接口返回值结构（与 IPC handler 对齐）', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'rec-1.json'), JSON.stringify({ id: 'rec-1', prompt: 'hi', tags: ['t'], ts: 1000, schemaVersion: 1 }));
    const s = initStoreWithDir(dir);

    // 模拟 readAll handler 的转换
    const records = Object.values(s.all()).map((v) => ({
        id: v.id, prompt: v.prompt || '', tags: v.tags || [], ts: v.ts || 0,
    }));
    assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]).sort(), ['id', 'prompt', 'tags', 'ts']);
});
