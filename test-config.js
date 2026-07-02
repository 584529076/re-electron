// test-config.js — D-26 config schema + 操作验证
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_KEY = '***';
const DEFAULT_TABS = [
    // D-26: path 统一字段
    { id: 'ai-image', name: 'AI出图', source: { type: 'nas', path: 'http://192.168.0.109:5005/home/小芋/AI出图/', imgExts: ['jpg'], videoExts: ['mp4'], maxDepth: 10 } },
    { id: 'ltx', name: 'LTX测试', source: { type: 'local', path: 'D:\\Download\\▶LTX2.3\\测试素材', imgExts: ['jpg'], videoExts: ['mp4'], maxDepth: 10 } },
    { id: 'web-list', name: '网络列表', source: { type: 'network', urls: 'https://a.com/1.jpg\nhttps://a.com/2.mp4' } },
];

function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return 'config 必须是对象';
    if (!Array.isArray(cfg.tabs)) return 'tabs 必须是数组';
    const ids = new Set();
    for (const t of cfg.tabs) {
        if (!t || !t.id || !t.name || !t.source) return 'tab 缺字段（id/name/source）';
        if (ids.has(t.id)) return `tab id 重复: ${t.id}`;
        ids.add(t.id);
        const s = t.source;
        if (!['nas', 'local', 'network'].includes(s.type)) return `tab ${t.id}: 未知 source.type: ${s.type}`;
        if (s.type === 'network') {
            if (!s.urls || !String(s.urls).trim()) return `tab ${t.id}: network 类型需 urls`;
        } else {
            if (!s.path || !String(s.path).trim()) return `tab ${t.id}: ${s.type} 类型需 path`;
            if (s.type === 'nas' && !/^https?:\/\//i.test(s.path)) return `tab ${t.id}: NAS path 需以 http(s):// 开头`;
        }
    }
    return null;
}

// D-26: 自动从 path 拆 baseUrl + rootDir
function splitNasPath(path) {
    const m = String(path).match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    if (!m) return null;
    return { nasBaseUrl: m[1], rootDir: m[2] || '/' };
}

test('D-26 schema: 3 种 type + path', () => {
    assert.equal(DEFAULT_TABS[0].source.type, 'nas');
    assert.ok(DEFAULT_TABS[0].source.path.startsWith('http'));
    assert.equal(DEFAULT_TABS[1].source.type, 'local');
    assert.ok(DEFAULT_TABS[1].source.path.includes('\\'));
    assert.equal(DEFAULT_TABS[2].source.type, 'network');
});

test('splitNasPath: 标准路径', () => {
    const r = splitNasPath('http://192.168.0.109:5005/home/小芋/AI出图/');
    assert.equal(r.nasBaseUrl, 'http://192.168.0.109:5005');
    assert.equal(r.rootDir, '/home/小芋/AI出图/');
});

test('splitNasPath: 根目录', () => {
    const r = splitNasPath('http://host:8080/');
    assert.equal(r.nasBaseUrl, 'http://host:8080');
    assert.equal(r.rootDir, '/');
});

test('splitNasPath: 末尾斜杠可省略', () => {
    const r = splitNasPath('http://host:8080/photos');
    assert.equal(r.rootDir, '/photos');
});

test('splitNasPath: 错误格式', () => {
    assert.equal(splitNasPath('not-a-url'), null);
    assert.equal(splitNasPath('D:\\local\\path'), null);
});

test('config 校验: id 重复', () => {
    const bad = { version: 1, tabs: [
        { id: 'a', name: 'A', source: { type: 'nas', path: 'http://h/' } },
        { id: 'a', name: 'A2', source: { type: 'nas', path: 'http://h/' } },
    ], activeTabId: 'a' };
    assert.match(validateConfig(bad), /tab id 重复/);
});

test('config 校验: 缺字段', () => {
    const bad = { version: 1, tabs: [{ id: 'a' }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /缺字段/);
});

test('config 校验: 未知 type', () => {
    const bad = { version: 1, tabs: [{ id: 'a', name: 'A', source: { type: 'ftp', path: 'x' } }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /未知 source\.type/);
});

test('config 校验: nas 缺 path', () => {
    const bad = { version: 1, tabs: [{ id: 'a', name: 'A', source: { type: 'nas' } }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /nas 类型需 path/);
});

test('config 校验: local 缺 path', () => {
    const bad = { version: 1, tabs: [{ id: 'a', name: 'A', source: { type: 'local' } }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /local 类型需 path/);
});

test('config 校验: network 缺 urls', () => {
    const bad = { version: 1, tabs: [{ id: 'a', name: 'A', source: { type: 'network' } }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /network 类型需 urls/);
});

test('config 校验: nas path 不是 http', () => {
    const bad = { version: 1, tabs: [{ id: 'a', name: 'A', source: { type: 'nas', path: 'D:\\photos' } }], activeTabId: 'a' };
    assert.match(validateConfig(bad), /NAS path 需以 http\(s\)/);
});

test('config 校验: 完整合法 config', () => {
    const ok = { version: 1, tabs: DEFAULT_TABS, activeTabId: 'ai-image' };
    assert.equal(validateConfig(ok), null);
});

test('config 增删改: 加新 tab', () => {
    const cfg = { version: 1, tabs: [...DEFAULT_TABS], activeTabId: 'ai-image' };
    cfg.tabs.push({ id: 'new', name: '新', source: { type: 'local', path: 'C:\\', imgExts: [], videoExts: [], maxDepth: 5 } });
    assert.equal(cfg.tabs.length, 4);
    assert.equal(validateConfig(cfg), null);
});

test('config 增删改: 删 tab', () => {
    const cfg = { version: 1, tabs: [...DEFAULT_TABS], activeTabId: 'ai-image' };
    cfg.tabs = cfg.tabs.filter((t) => t.id !== 'web-list');
    assert.equal(cfg.tabs.length, 2);
    assert.equal(validateConfig(cfg), null);
});

test('config 增删改: 改 source.type', () => {
    const cfg = { version: 1, tabs: [...DEFAULT_TABS], activeTabId: 'ai-image' };
    const idx = cfg.tabs.findIndex((t) => t.id === 'ai-image');
    cfg.tabs[idx].source = { type: 'local', path: 'D:\\ai-image', imgExts: ['jpg'], videoExts: ['mp4'], maxDepth: 10 };
    assert.equal(validateConfig(cfg), null);
    assert.equal(cfg.tabs[idx].source.type, 'local');
});

// 迁移函数（复制 main.js）
function migrateLegacySourceSchema(cfg) {
    if (!cfg || !Array.isArray(cfg.tabs)) return cfg;
    let changed = false;
    for (const t of cfg.tabs) {
        const s = t.source;
        if (!s) continue;
        if (s.type === 'nas' && (s.baseUrl || s.rootDir)) {
            if (!s.path) {
                s.path = String(s.baseUrl || '').replace(/\/+$/, '') + (s.rootDir || '/');
                changed = true;
            }
            delete s.baseUrl;
            delete s.rootDir;
        }
    }
    return changed ? cfg : cfg;
}

test('迁移: 老 D-25 schema 自动转 path', () => {
    const old = {
        version: 1,
        tabs: [
            { id: 'a', name: 'A', source: { type: 'nas', baseUrl: 'http://host:5005', rootDir: '/photos/', imgExts: [], videoExts: [], maxDepth: 10 } },
        ],
        activeTabId: 'a',
    };
    const migrated = migrateLegacySourceSchema(JSON.parse(JSON.stringify(old)));
    assert.equal(migrated.tabs[0].source.path, 'http://host:5005/photos/');
    assert.equal(migrated.tabs[0].source.baseUrl, undefined);
    assert.equal(migrated.tabs[0].source.rootDir, undefined);
});

test('splitExts: 字符串解析', () => {
    function splitExts(s) {
        return String(s || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    }
    assert.deepEqual(splitExts('jpg, jpeg, png'), ['jpg', 'jpeg', 'png']);
    assert.deepEqual(splitExts('jpg jpeg png'), ['jpg', 'jpeg', 'png']);
    assert.deepEqual(splitExts('.jpg,.png'), ['jpg', 'png']);
    assert.deepEqual(splitExts(''), []);
});
