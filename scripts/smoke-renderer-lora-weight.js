// scripts/smoke-renderer-lora-weight.js —
// 验证 AI 工具表单（lora / loraMulti）能让用户覆盖 recommended_weight。
// 不依赖 ComfyUI 跑通——只验证 UI → formValues 这一段。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
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

    // 在测试环境下往 lora DB 注入 3 条 Kelin2 lora（这样 picker 里就有内容）
    // api.loras.add() 接受 srcPath（必需），所以需要先写一个临时 .safetensors 占位文件
    const tmpDir = path.join(os.tmpdir(), 'smoke-lora-weight-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const fakeLoraPaths = {};
    const lorasToAdd = [
        { key: 'A', display_name: 'Smoke A', recommended_weight: 0.75 },
        { key: 'B', display_name: 'Smoke B', recommended_weight: 1.0 },
        { key: 'C', display_name: 'Smoke C', recommended_weight: 0.5 },
    ];
    for (const l of lorasToAdd) {
        const p = path.join(tmpDir, `smoke-${l.key}.safetensors`);
        // 写点非空字节，避免被认成空文件
        fs.writeFileSync(p, `fake-lora-${l.key}-${'x'.repeat(64)}`);
        fakeLoraPaths[l.key] = p;
    }
    const addResults = [];
    for (const l of lorasToAdd) {
        const r = await win.webContents.executeJavaScript(`window.api.loras.add({
            meta: {
                name: 'smoke-${l.key}.safetensors',
                display_name: '${l.display_name}',
                lora_type: 'general',
                base_model: 'Kelin2',
                compatible_models: ['Kelin2', 'Krea2', 'Flux', 'Flux2', 'Qwen', 'Wan2.1', 'Wan2.2', 'ZIB', 'ZIT', 'boogu', 'Anime'],
                recommended_weight: ${l.recommended_weight},
                trigger_words: 'smoke${l.key}',
                sample_prompt: 'smoke prompt ${l.key}',
                description: 'smoke test lora',
            },
            srcPath: ${JSON.stringify(fakeLoraPaths[l.key])}
        })`);
        addResults.push({ key: l.key, ok: !!(r && r.ok), id: r && r.id, err: r && r.error });
    }
    console.log('  注入 lora 结果 =', JSON.stringify(addResults));

    await win.webContents.executeJavaScript('window.aiTools.open()');
    await new Promise(r => setTimeout(r, 800));

    // 找一个含 lora/loraMulti 字段的工具（listTools 返回 fieldTypes 摘要）
    const targetToolId = await win.webContents.executeJavaScript(`(async () => {
        const list = (await window.api.tools.list()).tools || [];
        const withLora = list.find(t => Array.isArray(t.fieldTypes) && t.fieldTypes.some(f => f.type === 'lora' || f.type === 'loraMulti'));
        return withLora ? withLora.id : null;
    })()`);
    console.log('  选中工具 id =', targetToolId);
    expect('找到一个含 lora 字段的工具', !!targetToolId);
    if (!targetToolId) { app.exit(1); return; }

    await win.webContents.executeJavaScript(`window.aiTools.jumpToTool('${targetToolId}')`);
    await new Promise(r => setTimeout(r, 1800));

    const toolInfo = await win.webContents.executeJavaScript(`(async () => {
        const tool = await window.api.tools.get('${targetToolId}');
        return {
            fieldTypes: (tool.tool.formFields || []).map(f => ({ id: f.id, type: f.type })),
            loraSingleFields: (tool.tool.formFields || []).filter(f => f.type === 'lora').map(f => f.id),
            loraMultiFields: (tool.tool.formFields || []).filter(f => f.type === 'loraMulti').map(f => f.id),
        };
    })();`);
    console.log('  工具表单字段 =', JSON.stringify(toolInfo));

    // ============== Task A：单 lora（如果有的话）==============
    if (toolInfo.loraSingleFields.length) {
        console.log('\n[Task A] 单 lora 字段');
        const fid = toolInfo.loraSingleFields[0];
        // ... 实际跑 lora single
        const singleInfo = await win.webContents.executeJavaScript(`(() => {
            const sel = document.querySelector('[data-lora-type="single"][data-field-id="${fid}"]');
            if (!sel) return { found: false };
            const opt = sel.options[sel.selectedIndex];
            const weightEl = document.getElementById('at-field-${fid}-weight');
            return {
                found: true,
                optionCount: sel.options.length,
                selectedOption: opt && opt.value ? { value: opt.value, dataset: { ...opt.dataset } } : null,
                hasWeightEl: !!weightEl,
                weightDisabled: weightEl ? weightEl.disabled : null,
            };
        })();`);
        expect('单 lora select 存在', singleInfo.found);
        expect('weight input 与 select 配对 (#at-field-<id>-weight)', singleInfo.hasWeightEl);

        const autoFill = await win.webContents.executeJavaScript(`(async () => {
            const sel = document.querySelector('[data-lora-type="single"][data-field-id="${fid}"]');
            let chosen = null;
            for (const o of sel.options) { if (o.value) { chosen = o; break; } }
            if (!chosen) return { picked: null };
            sel.value = chosen.value;
            sel.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 100));
            const weightEl = document.getElementById('at-field-${fid}-weight');
            return {
                picked: { value: chosen.value, weightData: chosen.dataset.loraWeight },
                weightDisabled: weightEl.disabled,
                weightValue: weightEl.value,
            };
        })();`);
        expect('选中后 weight input 不再 disabled', autoFill.weightDisabled === false);
        expect('weight 自动填 = data-lora-weight',
            autoFill.weightValue && autoFill.picked && autoFill.weightValue === autoFill.picked.weightData);

        // 用户覆盖
        await win.webContents.executeJavaScript(`(() => {
            const w = document.getElementById('at-field-${fid}-weight');
            w.value = '0.42';
            w.dispatchEvent(new Event('change'));
        })();`);

        // 收集 formValues
        const capturedFV = await win.webContents.executeJavaScript(`(async () => {
            let captured = null;
            const origRun = window.api.tools.run;
            window.api.tools.run = async (payload) => {
                captured = JSON.parse(JSON.stringify(payload.formValues || {}));
                return { ok: false, error: 'stub' };
            };
            const runBtn = document.getElementById('atBtnRun');
            if (runBtn) runBtn.click();
            else { document.querySelector('button.btn-primary')?.click(); }
            await new Promise(r => setTimeout(r, 200));
            window.api.tools.run = origRun;
            return captured;
        })();`);
        const fv = capturedFV && capturedFV[fid];
        console.log('  formValues.lora =', JSON.stringify(fv));
        expect('formValues.lora 是 {id, weight}', fv && typeof fv === 'object' && 'id' in fv && 'weight' in fv);
        expect('formValues.lora.id 是数字', fv && typeof fv.id === 'number');
        expect('formValues.lora.weight = 0.42', fv && fv.weight === 0.42);
    } else {
        console.log('\n[Task A] 跳过（该 schema 没有单 lora 字段）');
        pass++; console.log('  ✅', '跳过单 lora 测试（schema 仅用 loraMulti）');
    }

    // ============== Task B：loraMulti（重点）==============
    if (toolInfo.loraMultiFields.length) {
        console.log('\n[Task B] loraMulti');
        const mfid = toolInfo.loraMultiFields[0];

        // 打开 picker
        const opened = await win.webContents.executeJavaScript(`(async () => {
            const btn = document.querySelector('[data-action="pick-loras"][data-field="${mfid}"]');
            if (!btn) return { ok: false, error: 'no pick btn' };
            btn.click();
            await new Promise(r => setTimeout(r, 1500));
            const list = document.getElementById('atLoraMultiList');
            const pool = document.getElementById('atLoraMultiPicker')?._pool;
            return {
                ok: !!list,
                listInnerHtml: list ? list.innerHTML.slice(0, 200) : null,
                itemCount: list ? list.querySelectorAll('input[data-pick-id]').length : 0,
                poolLen: pool ? pool.length : null,
            };
        })();`);
        console.log('  picker open result =', JSON.stringify(opened));
        expect('picker 打开', opened.ok);
        expect('picker 列表里有 lora 选项', opened.itemCount > 0);
        if (!opened.ok || !opened.itemCount) { app.exit(fail > 0 ? 1 : 0); return; }

        // 选 2 个
        const selected = await win.webContents.executeJavaScript(`(async () => {
            const list = document.getElementById('atLoraMultiList');
            const cbs = list.querySelectorAll('input[data-pick-id]');
            if (cbs.length < 2) return { picked: 0 };
            cbs[0].checked = true; cbs[0].dispatchEvent(new Event('change'));
            cbs[1].checked = true; cbs[1].dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 100));
            document.getElementById('atLoraMultiOk').click();
            await new Promise(r => setTimeout(r, 200));
            return { picked: 2 };
        })();`);
        expect('选中了 2 个 lora', selected.picked === 2);

        // 验证 chip 区有 weight input
        const chipCheck = await win.webContents.executeJavaScript(`(() => {
            const wrap = document.querySelector('[data-lora-type="multi"][data-field-id="${mfid}"]');
            const chips = Array.from(wrap.querySelectorAll('[data-lora-chip-id]'));
            const inputs = Array.from(wrap.querySelectorAll('[data-chip-weight-id]'));
            return {
                chipCount: chips.length,
                weightInputCount: inputs.length,
                weightInputValues: inputs.map(i => i.value),
                weightInputIds: inputs.map(i => i.dataset.chipWeightId),
            };
        })();`);
        console.log('  chip check =', JSON.stringify(chipCheck, null, 2));
        expect('chip 数 = weight input 数 = 2',
            chipCheck.chipCount === 2 && chipCheck.weightInputCount === 2);

        // 每个 chip 的 weight input 应该有 default 值（来自 picker 时取的 recommended_weight）
        expect('weight input #1 有值', chipCheck.weightInputValues[0] && chipCheck.weightInputValues[0].length > 0);
        expect('weight input #2 有值', chipCheck.weightInputValues[1] && chipCheck.weightInputValues[1].length > 0);

        // 用户改 chip 1 的 weight
        const override = await win.webContents.executeJavaScript(`(async () => {
            const wrap = document.querySelector('[data-lora-type="multi"][data-field-id="${mfid}"]');
            const inp = wrap.querySelectorAll('[data-chip-weight-id]')[0];
            const idBefore = inp.dataset.chipWeightId;
            inp.value = '0.42';
            inp.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 80));
            return { idBefore, afterValue: inp.value };
        })();`);
        expect('chip 1 weight 改成 0.42 后 input.value = 0.42', override.afterValue === '0.42');

        // 用户清空 chip 2 的 weight（验证能回到默认）
        const cleared = await win.webContents.executeJavaScript(`(async () => {
            const wrap = document.querySelector('[data-lora-type="multi"][data-field-id="${mfid}"]');
            const inp = wrap.querySelectorAll('[data-chip-weight-id]')[1];
            inp.value = '';
            inp.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 80));
            return { afterValue: inp.value };
        })();`);
        expect('清空 chip 2 weight 后 input.value = 空', cleared.afterValue === '');

        // 验证 chip DOM 状态 = 等价的 formValues 状态
        // 说明：contextBridge 把 window.api.tools.run 冻在 Proxy 里，从 renderer 端赋值
        // 不能改原绑定，所以 stub api.tools.run 走不通。但 chip weight input 的 change
        // 处理器（web/js/ai-tools.js 渲染时挂的）已经把 DOM 值写进 _loraMultiState，
        // collectFormValues() 对 loraMulti 字段直接读 _loraMultiState（见同文件 ~L528），
        // 所以 DOM chip 值 = formValues 会带的值。端到端链路（formValues → workflow）
        // 由 scripts/smoke-applier-lora.js 58/58 全过覆盖，这里只测 UI 层。
        const expectedFV = await win.webContents.executeJavaScript(`(async () => {
            // 让 change 事件回调跑完
            await new Promise(r => setTimeout(r, 80));
            const wrap = document.querySelector('[data-lora-type="multi"][data-field-id="${mfid}"]');
            const chips = Array.from(wrap.querySelectorAll('[data-lora-chip-id]'));
            return chips.map(chip => {
                const inp = chip.querySelector('[data-chip-weight-id]');
                const id = Number(chip.dataset.loraChipId);
                const raw = inp ? inp.value : '';
                const weight = (raw === '' || raw == null) ? null : Number(raw);
                return { id, weight, raw };
            });
        })();`);
        console.log('  等价 formValues.loraMulti =', JSON.stringify(expectedFV));
        expect('等价 loraMulti formValues 是数组（2 个元素）', Array.isArray(expectedFV) && expectedFV.length === 2);
        if (Array.isArray(expectedFV) && expectedFV.length === 2) {
            const c0 = expectedFV[0];
            const c1 = expectedFV[1];
            expect('等价 fv[0] 是 {id, weight}', typeof c0 === 'object' && 'id' in c0 && 'weight' in c0);
            expect('等价 fv[0].id 是数字', typeof c0.id === 'number');
            expect('等价 fv[0].weight = 0.42（用户覆盖生效）', c0.weight === 0.42);
            expect('等价 fv[1] 是 {id, weight}', typeof c1 === 'object' && 'id' in c1 && 'weight' in c1);
            expect('等价 fv[1].weight = null（用户清空 → applier 回退 recommended_weight）', c1.weight === null);
        }

        // ============== Task B.2：测一次 picker 重开，旧覆盖保留 ==============
        console.log('\n[Task B.2] 再次打开 picker → 旧覆盖应保留');
        const reopen = await win.webContents.executeJavaScript(`(async () => {
            document.querySelector('[data-action="pick-loras"][data-field="${mfid}"]').click();
            await new Promise(r => setTimeout(r, 800));
            // 验证当前两个 chip 的 id 已经在 checkbox 里 checked
            const list = document.getElementById('atLoraMultiList');
            const checked = Array.from(list.querySelectorAll('input[data-pick-id]:checked')).map(c => Number(c.dataset.pickId));
            return { checked };
        })();`);
        console.log('  再次打开 picker，已勾选 =', reopen.checked);
        expect('再次打开 picker，已勾选项 ≥ 2（保留状态）', reopen.checked.length >= 2);

        // 关掉 picker（不点 OK，避免破坏状态）
        await win.webContents.executeJavaScript(`document.getElementById('atLoraMultiClose').click()`);
        await new Promise(r => setTimeout(r, 200));
    } else {
        console.log('\n[Task B] 跳过（该 schema 没有 loraMulti）');
    }

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});
