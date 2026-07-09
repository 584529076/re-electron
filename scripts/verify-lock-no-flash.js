// scripts/verify-lock-no-flash.js — 验证从其他页面切回主界面时遮罩不闪
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

require('../main.js');

app.whenReady().then(async () => {
    await new Promise(r => setTimeout(r, 1500));

    const win = new BrowserWindow({
        width: 1280, height: 800, show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            nodeIntegration: false, contextIsolation: true, sandbox: false,
        },
    });
    await win.loadFile(path.join(__dirname, '..', 'web', 'index.html'));
    await new Promise(r => setTimeout(r, 2500));

    console.log('[test] app loaded, lock should be visible (no unlock yet)');

    // 1) 切到 loras 页面
    const r1 = await win.webContents.executeJavaScript(`(async () => {
        if (!window.lorasPage) return { ok: false, error: 'no lorasPage' };
        await window.lorasPage.open();
        return { ok: true };
    })();`);
    console.log('[step1] open loras =', JSON.stringify(r1));
    if (!r1.ok) { app.exit(1); return; }

    // 2) 模拟用户操作了一会，然后关闭 loras
    await new Promise(r => setTimeout(r, 500));

    // 3) 关闭 loras —— 关键测试点
    const r3 = await win.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('lockOverlay');
        const main = document.querySelector('main');
        // 记录 main.style.display 当前值
        const beforeMainDisplay = main.style.display;
        // 关闭 loras（close 会把 main.style.display 设为 ''）
        window.lorasPage.close();
        // 立即读取 overlay 的 computed opacity（不 await，让浏览器渲染一帧）
        const overlayCs = getComputedStyle(overlay);
        return {
            mainDisplayAfterClose: main.style.display,
            overlayDisplay: overlayCs.display,
            overlayOpacityImmediately: overlayCs.opacity,
        };
    })();`);
    console.log('[step3] immediately after close =', JSON.stringify(r3));

    // 等一帧再读
    await new Promise(r => setTimeout(r, 50));
    const r4 = await win.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('lockOverlay');
        return {
            opacity: getComputedStyle(overlay).opacity,
            animationName: getComputedStyle(overlay).animationName,
        };
    })();`);
    console.log('[step4] after 50ms =', JSON.stringify(r4));

    // 持续监控 opacity 变化 500ms
    const samples = await win.webContents.executeJavaScript(`(async () => {
        const samples = [];
        const overlay = document.getElementById('lockOverlay');
        for (let i = 0; i < 25; i++) {
            samples.push({
                t: i * 25,
                opacity: getComputedStyle(overlay).opacity,
            });
            await new Promise(r => setTimeout(r, 25));
        }
        return samples;
    })();`);
    const minOpacity = Math.min(...samples.map(s => parseFloat(s.opacity)));
    const anyBelowFull = samples.some(s => parseFloat(s.opacity) < 0.95);
    console.log('[monitor] opacity 序列 =', samples.map(s => s.opacity).join(','));
    console.log('[monitor] 最低 opacity =', minOpacity);

    let pass = 0, fail = 0;
    const expect = (label, cond, detail) => {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    };

    expect('main.style.display 恢复为空（visible）', r3.mainDisplayAfterClose === '');
    expect('lock overlay display 不是 none', r3.overlayDisplay !== 'none');
    expect('opacity 全程 >= 0.95（不闪）', !anyBelowFull, `min=${minOpacity}`);
    expect('overlay opacity 始终 1', r4.opacity === '1', r4.opacity);

    // 截图：先调高 main 内容明显，再开 loras 再关闭，截 close 后第一帧
    await win.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('main');
        const gallery = document.getElementById('gallery');
        // 塞点明显的内容到底部，模拟「漏出」能看出来
        const filler = document.createElement('div');
        filler.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:120px;background:linear-gradient(90deg,#ff0080,#ff8c00,#40e0d0);font-size:60px;color:#fff;text-align:center;line-height:120px;font-weight:bold;';
        filler.id = '__flash-bg';
        filler.textContent = '🔴 敏感内容 🔴';
        main.appendChild(filler);
    })();`);
    await new Promise(r => setTimeout(r, 100));

    // 重置：再次开 loras → 关闭 → 截图
    await win.webContents.executeJavaScript(`(async () => {
        await window.lorasPage.open();
        await new Promise(r => setTimeout(r, 400));
        window.lorasPage.close();
    })();`);
    // 立即截图
    await new Promise(r => setTimeout(r, 30));  // 30ms 后截图
    let img = await win.webContents.capturePage();
    let out = path.join(__dirname, '..', 'tmp-lock-flash-30ms.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('[snap 30ms]', out);

    await new Promise(r => setTimeout(r, 200));
    img = await win.webContents.capturePage();
    out = path.join(__dirname, '..', 'tmp-lock-flash-250ms.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('[snap 250ms]', out);

    // 清理
    await win.webContents.executeJavaScript(`document.getElementById('__flash-bg')?.remove()`);

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});