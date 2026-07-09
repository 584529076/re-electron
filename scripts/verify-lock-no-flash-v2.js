// scripts/verify-lock-no-flash-v2.js — 根治 loras 关闭后的锁屏闪屏
//
// 这次的根本改动是把 #lockOverlay 从 <main> 内部移到 <body> 外面，
// 并把常驻 animation 撤掉，只在首次初始化时由 JS 挂一次 .first-show。
// 这里验证：
//   1. overlay 是 body 直接子节点（不在 main 内）
//   2. overlay 上没有任何 CSS animation
//   3. loras 关闭的瞬间 → overlay opacity 立即为 1，没有 fade-in 期间
//   4. 0~500ms 内 opacity 序列全部 >= 0.99（绝不闪）
//   5. loras 页 (z-index:200) 在打开时仍能遮住 overlay (z-index:50)
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

    let pass = 0, fail = 0;
    const expect = (label, cond, detail) => {
        if (cond) { console.log('  ✅', label); pass++; }
        else { console.log('  ❌', label, '|', detail || ''); fail++; }
    };

    console.log('\n[Check 1] overlay 在 DOM 结构中的位置');
    const tree = await win.webContents.executeJavaScript(`(() => {
        const o = document.getElementById('lockOverlay');
        if (!o) return { ok: false };
        const parentTag = o.parentElement && o.parentElement.tagName;
        const siblingsBeforeMain = [];
        let n = o.previousElementSibling;
        while (n) { siblingsBeforeMain.push(n.tagName + (n.id ? '#' + n.id : '')); n = n.previousElementSibling; }
        let n2 = o.nextElementSibling;
        const siblingsAfter = [];
        while (n2 && siblingsAfter.length < 3) { siblingsAfter.push(n2.tagName + (n2.id ? '#' + n2.id : '')); n2 = n2.nextElementSibling; }
        return {
            ok: true,
            parentTag,
            isDirectChildOfBody: o.parentElement === document.body,
            siblingsBeforeMain: siblingsBeforeMain.slice(-3),
            siblingsAfter,
        };
    })();`);
    console.log('  tree =', JSON.stringify(tree));
    expect('overlay 存在', tree.ok);
    expect('overlay 是 body 直接子节点（不在 main 内）', tree.isDirectChildOfBody);

    console.log('\n[Check 2] overlay / card 上没有常驻 CSS animation');
    const anims = await win.webContents.executeJavaScript(`(() => {
        const o = document.getElementById('lockOverlay');
        const c = o && o.querySelector('.lock-card');
        const oCs = o ? getComputedStyle(o) : null;
        const cCs = c ? getComputedStyle(c) : null;
        return {
            overlayAnimationName: oCs && oCs.animationName,
            overlayAnimationDuration: oCs && oCs.animationDuration,
            cardAnimationName: cCs && cCs.animationName,
            cardAnimationDuration: cCs && cCs.animationDuration,
        };
    })();`);
    console.log('  animations =', JSON.stringify(anims));
    expect('overlay 无 CSS animation（默认）', anims.overlayAnimationName === 'none' || anims.overlayAnimationDuration === '0s');
    expect('card 无 CSS animation（默认）', anims.cardAnimationName === 'none' || anims.cardAnimationDuration === '0s');

    console.log('\n[Check 3] .first-show 已经清理掉（首次入场动画已结束）');
    const firstShow = await win.webContents.executeJavaScript(`(() => {
        const o = document.getElementById('lockOverlay');
        const c = o && o.querySelector('.lock-card');
        return {
            overlayHasFirstShow: o && o.classList.contains('first-show'),
            cardHasFirstShow: c && c.classList.contains('first-show'),
        };
    })();`);
    console.log('  first-show =', JSON.stringify(firstShow));
    expect('overlay 已移除 .first-show（450ms 计时器已生效）', !firstShow.overlayHasFirstShow);
    expect('card 已移除 .first-show', !firstShow.cardHasFirstShow);

    console.log('\n[Check 4] loras 关闭瞬间 → opacity 立即为 1，零延迟');
    await win.webContents.executeJavaScript(`window.lorasPage.open()`);
    await new Promise(r => setTimeout(r, 500));

    // 关闭瞬间立即读 overlay opacity 与 ::before 背景
    const immediate = await win.webContents.executeJavaScript(`(() => {
        window.lorasPage.close();
        const o = document.getElementById('lockOverlay');
        const before = window.getComputedStyle(o, '::before');
        const cardCs = window.getComputedStyle(o.querySelector('.lock-card'));
        return {
            overlayDisplay: window.getComputedStyle(o).display,
            overlayOpacity: window.getComputedStyle(o).opacity,
            beforeBg: before.backgroundColor,
            beforeBackdrop: before.backdropFilter || before.webkitBackdropFilter,
            cardTransform: cardCs.transform,
        };
    })();`);
    console.log('  immediately after close =', JSON.stringify(immediate));
    expect('overlay display 不是 none', immediate.overlayDisplay !== 'none');
    expect('overlay opacity 立即为 1', immediate.overlayOpacity === '1');
    expect('::before 背景已生效 (rgba)', /^rgba?\(/.test(immediate.beforeBg), immediate.beforeBg);
    expect('card transform 仍是原定位 (无 scale 重启)', !/scale\(0\.9/.test(immediate.cardTransform), immediate.cardTransform);

    console.log('\n[Check 5] 0~500ms 监控 opacity 序列（25 个采样点）');
    const samples = await win.webContents.executeJavaScript(`(async () => {
        const samples = [];
        const o = document.getElementById('lockOverlay');
        const before = window.getComputedStyle(o, '::before');
        for (let i = 0; i < 25; i++) {
            const t0 = performance.now();
            const op = window.getComputedStyle(o).opacity;
            const bg = window.getComputedStyle(o, '::before').backgroundColor;
            samples.push({ t: Math.round(t0), opacity: op, bg });
            await new Promise(r => setTimeout(r, 20));
        }
        return samples;
    })();`);
    const opacities = samples.map(s => s.opacity);
    const minOp = Math.min(...opacities.map(Number));
    const anyBelow = opacities.some(o => Number(o) < 0.99);
    console.log('  opacity 序列 =', opacities.join(','));
    expect('opacity 全程 == 1（绝不闪到 <0.99）', !anyBelow, `min=${minOp}`);

    console.log('\n[Check 6] loras 全屏页能覆盖遮罩（z-index:200 > 50）');
    await win.webContents.executeJavaScript(`window.lorasPage.open()`);
    await new Promise(r => setTimeout(r, 300));
    const lorasOpen = await win.webContents.executeJavaScript(`(() => {
        const o = document.getElementById('lockOverlay');
        const lp = document.getElementById('lorasPage');
        const oRect = o.getBoundingClientRect();
        const lpRect = lp.getBoundingClientRect();
        // 取 overlay 中间一点，看是否被 loras 挡住
        const cx = (oRect.left + oRect.right) / 2;
        const cy = (oRect.top + oRect.bottom) / 2;
        const elAtPoint = document.elementFromPoint(cx, cy);
        return {
            lorasDisplay: lp ? getComputedStyle(lp).display : 'no lorasPage',
            lorasZIndex: lp ? getComputedStyle(lp).zIndex : '?',
            overlayZIndex: getComputedStyle(o).zIndex,
            elementAtCenter: elAtPoint && elAtPoint.id,
            elementAtCenterIsLoras: elAtPoint === lp || (lp && lp.contains(elAtPoint)),
        };
    })();`);
    console.log('  loras open state =', JSON.stringify(lorasOpen));
    expect('loras 显示', lorasOpen.lorasDisplay === 'flex');
    expect('loras z-index = 200 (高于 overlay 的 50)', lorasOpen.lorasZIndex === '200');
    expect('overlay z-index = 50', lorasOpen.overlayZIndex === '50');
    expect('overlay 中点命中 loras（被遮挡）', lorasOpen.elementAtCenterIsLoras);

    // 关闭 loras 再看 opacity
    await win.webContents.executeJavaScript(`window.lorasPage.close()`);
    await new Promise(r => setTimeout(r, 50));
    const afterLorasClose = await win.webContents.executeJavaScript(`(() => {
        const o = document.getElementById('lockOverlay');
        return {
            opacity: getComputedStyle(o).opacity,
            elementAtCenter: document.elementFromPoint(640, 400) && document.elementFromPoint(640, 400).id,
        };
    })();`);
    expect('关闭 loras 后 overlay 重新成为中点元素', afterLorasClose.elementAtCenter === 'lockOverlay', afterLorasClose.elementAtCenter);
    expect('关闭 loras 后 overlay opacity 为 1', afterLorasClose.opacity === '1');

    // 截图证据：把 main 底部填充一点明显内容，再开 loras → 关闭 → 截图
    await win.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('main');
        const filler = document.createElement('div');
        filler.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:140px;background:linear-gradient(90deg,#ff0080,#ff8c00,#40e0d0);font-size:60px;color:#fff;text-align:center;line-height:140px;font-weight:bold;z-index:1;';
        filler.id = '__flash-bg';
        filler.textContent = '🔴 敏感内容 🔴';
        main.appendChild(filler);
    })();`);
    await new Promise(r => setTimeout(r, 100));

    await win.webContents.executeJavaScript(`(async () => {
        await window.lorasPage.open();
        await new Promise(r => setTimeout(r, 400));
        window.lorasPage.close();
    })();`);
    // 关闭后 30ms 内连续 3 张截图
    await new Promise(r => setTimeout(r, 30));
    let img = await win.webContents.capturePage();
    let out = path.join(__dirname, '..', 'tmp-lock-flash2-30ms.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('  [snap 30ms]', out);

    await new Promise(r => setTimeout(r, 80));
    img = await win.webContents.capturePage();
    out = path.join(__dirname, '..', 'tmp-lock-flash2-110ms.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('  [snap 110ms]', out);

    await new Promise(r => setTimeout(r, 200));
    img = await win.webContents.capturePage();
    out = path.join(__dirname, '..', 'tmp-lock-flash2-310ms.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('  [snap 310ms]', out);

    // 清理
    await win.webContents.executeJavaScript(`document.getElementById('__flash-bg')?.remove()`);

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});
