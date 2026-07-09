// scripts/smoke-ui-loras.js — 启动主窗口 + 加载 loras 页面，捕捉 console 错误
// 用法: node_modules/.bin/electron scripts/smoke-ui-loras.js --no-sandbox
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

let win;
const consoleErrors = [];
const pageErrors = [];

app.on('ready', async () => {
    win = new BrowserWindow({
        width: 1280, height: 800, show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            nodeIntegration: false, contextIsolation: true, sandbox: false,
        },
    });

    win.webContents.on('console-message', (...args) => {
        // 兼容新旧 API：Electron 32 用 (event)，更老用 (event, level, message, line, sourceId)
        let level, message, src, line;
        if (args.length === 1 && typeof args[0] === 'object') {
            const e = args[0];
            level = e.level; message = e.message || ''; src = e.sourceId || ''; line = e.lineNumber || 0;
        } else {
            [, level, message, line, src] = args;
        }
        console.log('[renderer]', { level, message, src, line });
        // 只记录 WARN/ERROR（level >= 2）；过滤预期内的 IPC 未注册提示
        const expected = /No handler registered|Error invoking remote method|Security Warning|Insecure Content/i.test(message);
        if (level >= 2 && !expected) consoleErrors.push({ message, level, src, line });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        console.error('[renderer crashed]', details);
        pageErrors.push(details);
    });

    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
    console.log('[smoke-ui] index.html loaded');

    // 等 loras.js 执行完（DOMContentLoaded → script 加载）
    await new Promise(r => setTimeout(r, 1500));

    // 探测全局是否就绪
    const probe = await win.webContents.executeJavaScript(`(() => ({
        hasApi: typeof window.api === 'object' && !!window.api.loras,
        hasLorasPage: typeof window.lorasPage === 'object' && typeof window.lorasPage.open === 'function',
        btnLorasExists: !!document.getElementById('btnLoras'),
        lorasPageExists: !!document.getElementById('lorasPage'),
    }))();`);
    console.log('[smoke-ui] probe =', JSON.stringify(probe));

    if (probe.hasApi && probe.btnLorasExists && probe.hasLorasPage) {
        // 点击 btnLoras 触发 open
        await win.webContents.executeJavaScript(`document.getElementById('btnLoras').click()`);
        await new Promise(r => setTimeout(r, 800));
        const opened = await win.webContents.executeJavaScript(`(() => {
            const p = document.getElementById('lorasPage');
            return { visible: p && p.style.display !== 'none', hasGrid: !!document.getElementById('lpGrid') };
        })();`);
        console.log('[smoke-ui] after click =', JSON.stringify(opened));
    }

    console.log('[smoke-ui] console errors =', consoleErrors.length);
    if (consoleErrors.length) console.log('[smoke-ui] errors detail:', JSON.stringify(consoleErrors, null, 2));
    console.log('[smoke-ui] page crashes    =', pageErrors.length);
    if (consoleErrors.length || pageErrors.length) {
        app.exit(2);
    } else {
        console.log('[smoke-ui] OK');
        app.exit(0);
    }
});