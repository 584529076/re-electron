// scripts/smoke-lock-overlay.js — 验证锁屏遮罩：默认显示、点击解锁隐藏、不覆盖 header
// 用法: node_modules/.bin/electron scripts/smoke-lock-overlay.js --no-sandbox
'use strict';
const path = require('path');
const { app, BrowserWindow } = require('electron');

let win;
const consoleErrors = [];

app.on('ready', async () => {
    win = new BrowserWindow({
        width: 1280, height: 800, show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            nodeIntegration: false, contextIsolation: true, sandbox: false,
        },
    });
    win.webContents.on('console-message', (event) => {
        const level = event.level;
        const message = event.message || '';
        const expected = /No handler registered|Error invoking remote method|Security Warning|Insecure Content/i.test(message);
        if (level >= 2 && !expected) consoleErrors.push({ level, message });
    });

    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
    console.log('[smoke-lock] index.html loaded');

    await new Promise(r => setTimeout(r, 1500));

    // ===== 初始状态探测 =====
    const initial = await win.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('lockOverlay');
        const btn = document.getElementById('btnUnlock');
        const main = document.querySelector('main');
        const header = document.querySelector('header');
        if (!overlay || !btn) return { ok: false, reason: 'missing DOM' };
        const overlayRect = overlay.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        return {
            ok: true,
            overlayDisplay: getComputedStyle(overlay).display,
            overlayHasHiddenClass: overlay.classList.contains('lock-hidden'),
            overlayZIndex: getComputedStyle(overlay).zIndex,
            overlayTop: overlayRect.top, overlayBottom: overlayRect.bottom,
            overlayLeft: overlayRect.left, overlayRight: overlayRect.right,
            mainTop: mainRect.top, mainBottom: mainRect.bottom,
            headerBottom: headerRect.bottom,
            mainHasPositionRelative: getComputedStyle(main).position === 'relative',
            btnText: btn.textContent.trim(),
        };
    })();`);
    console.log('[smoke-lock] initial =', JSON.stringify(initial, null, 2));

    let pass = 0, fail = 0;
    function expect(label, cond, detail) {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    }

    console.log('\n[Check 1] 默认状态');
    expect('overlay 存在', initial.ok);
    expect('overlay display != none', initial.overlayDisplay !== 'none');
    expect('overlay 无 lock-hidden class', !initial.overlayHasHiddenClass);
    expect('main 是 position:relative', initial.mainHasPositionRelative);
    expect('解锁按钮文本含「解锁」', initial.btnText.includes('解锁'));

    console.log('\n[Check 2] 覆盖范围（只遮 main，不遮 header）');
    expect('overlay 顶部 == main 顶部', Math.abs(initial.overlayTop - initial.mainTop) < 2);
    expect('overlay 底部 == main 底部', Math.abs(initial.overlayBottom - initial.mainBottom) < 2);
    expect('overlay 顶部 ≥ header 底部（不覆盖 header）', initial.overlayTop >= initial.headerBottom - 1);

    console.log('\n[Check 3] 点击解锁 → 隐藏');
    await win.webContents.executeJavaScript(`document.getElementById('btnUnlock').click()`);
    await new Promise(r => setTimeout(r, 200));
    const afterClick = await win.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('lockOverlay');
        return {
            display: getComputedStyle(overlay).display,
            hasHiddenClass: overlay.classList.contains('lock-hidden'),
        };
    })();`);
    expect('overlay.display = none', afterClick.display === 'none');
    expect('overlay 有 lock-hidden class', afterClick.hasHiddenClass);

    console.log('\n[Check 4] 模拟其他页面隐藏 main（验证遮罩随 main 隐藏）');
    await win.webContents.executeJavaScript(`(() => {
        // 模拟打开其他页面时的状态：main.style.display = 'none'
        const main = document.querySelector('main');
        main._origDisplay = main.style.display;
        main.style.display = 'none';
    })();`);
    const otherPage = await win.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('lockOverlay');
        const main = document.querySelector('main');
        // 重要：overlay 是 main 的子节点，main display:none 时 overlay 也不可见
        const overlayVisible = overlay.offsetParent !== null;  // offsetParent === null 表示祖先链中有 display:none
        return {
            mainDisplay: main.style.display,
            overlayVisibleByOffsetParent: overlayVisible,
        };
    })();`);
    expect('main.display = none', otherPage.mainDisplay === 'none');
    expect('overlay 不可见（offsetParent = null）', !otherPage.overlayVisibleByOffsetParent);
    // 恢复
    await win.webContents.executeJavaScript(`document.querySelector('main').style.display = ''`);

    console.log('\n[Check 5] 键盘 Enter 解锁');
    // 重新显示遮罩
    await win.webContents.executeJavaScript(`document.getElementById('lockOverlay').classList.remove('lock-hidden')`);
    await win.webContents.executeJavaScript(`document.getElementById('btnUnlock').focus(); document.getElementById('btnUnlock').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    await new Promise(r => setTimeout(r, 100));
    const afterEnter = await win.webContents.executeJavaScript(`document.getElementById('lockOverlay').classList.contains('lock-hidden')`);
    expect('Enter 触发后 overlay 有 lock-hidden class', afterEnter);

    console.log('\n[Check 6] 控制台无错误');
    expect('console errors = 0', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});