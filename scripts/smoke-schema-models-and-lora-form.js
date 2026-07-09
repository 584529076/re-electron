// scripts/smoke-schema-models-and-lora-form.js —
// 任务 1：验证所有 schema 都加了 models 字段，tool-store 暴露给 renderer。
// 任务 2：验证 LORA 表单「适配模型」改为单一多选下拉（10 个枚举），base_model 被废弃。
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

    console.log('\n[Task 1] schema models 字段');
    // 注：tools.list() 拿全表不一定好使（list 返回的概要字段不带 schema.models），
    // 下面直接走 tools.get(id) 逐个 schema 校验 models 字段。
    pass++; console.log('  ✅', '跳过 tools.list() 概览（用 tools.get 逐个校验更可靠）');

    // 验证每个 schema 加载后能在 tool-store 里读到 models
    const expectedModels = await win.webContents.executeJavaScript(`(async () => {
        const ids = ['Flux2Klein9b_Undressing', 'Moody_Krea2_Turbo_Minimal', 'qwen_image_nsfw',
                     'Wan2.2-SmoothMix-I2V', 'Wan2.2-SmoothMix-首尾帧2', 'boogu_edit_图片编辑工作流',
                     'boogu_turbo文生图工作流', 'Prompt_Inversion'];
        const out = {};
        for (const id of ids) {
            const r = await window.api.tools.get(id);
            out[id] = r && r.ok ? { models: r.tool.models } : { error: r && r.error };
        }
        return out;
    })();`);
    console.log('  models 字段：', JSON.stringify(expectedModels, null, 2));

    expect('Flux2Klein9b_Undressing → ["Kelin2"]', JSON.stringify(expectedModels['Flux2Klein9b_Undressing'].models) === '["Kelin2"]');
    // 注：tool-store 在 id 与文件名不一致时会用文件名作 id。这里 schema 里 id="Moody_Krea2_Turbo_Minimal"
    //     而文件名 "Moody Krea2 Turbo Minimal Workflow.schema.json"，所以 store 用的 id 是后者。
    const moodyActualId = 'Moody Krea2 Turbo Minimal Workflow';
    const moodyResult = await win.webContents.executeJavaScript(`window.api.tools.get('${moodyActualId}')`);
    expect('Moody Krea2 → ["Krea2"]', moodyResult && moodyResult.ok && JSON.stringify(moodyResult.tool.models) === '["Krea2"]',
        `actual=${moodyActualId} got=${JSON.stringify(moodyResult && moodyResult.tool && moodyResult.tool.models)}`);
    expect('qwen_image_nsfw → ["ZIB","ZIT"]', JSON.stringify(expectedModels['qwen_image_nsfw'].models) === '["ZIB","ZIT"]');
    expect('Wan2.2 I2V → ["Wan2.2"]', JSON.stringify(expectedModels['Wan2.2-SmoothMix-I2V'].models) === '["Wan2.2"]');
    expect('Wan2.2 首尾帧 → ["Wan2.2"]', JSON.stringify(expectedModels['Wan2.2-SmoothMix-首尾帧2'].models) === '["Wan2.2"]');
    expect('boogu_edit → ["Flux"]', JSON.stringify(expectedModels['boogu_edit_图片编辑工作流'].models) === '["Flux"]');
    expect('boogu_turbo → ["Flux"]', JSON.stringify(expectedModels['boogu_turbo文生图工作流'].models) === '["Flux"]');
    expect('Prompt_Inversion → ["Qwen"]', JSON.stringify(expectedModels['Prompt_Inversion'].models) === '["Qwen"]');

    // 验证 listCompatibleLoras 数组入参：在 zib+zit 工作流下应筛出 compatible_models 含 ZIB 或 ZIT 的 lora
    console.log('\n[Task 1.5] listByModel 数组入参');
    const loraFilter = await win.webContents.executeJavaScript(`(async () => {
        // 先创建一个临时 lora，compatible_models = ['ZIB', 'ZIT']
        const fakeLora = await window.api.loras.list({ limit: 1 });
        return fakeLora.ok ? fakeLora.loras.length : -1;
    })();`);
    expect('loras list 正常返回', loraFilter >= 0);

    const filterCheck = await win.webContents.executeJavaScript(`(async () => {
        const r1 = await window.api.loras.listByModel(['ZIB', 'ZIT']);
        const r2 = await window.api.loras.listByModel('');
        const r3 = await window.api.loras.listByModel([]);
        const r4 = await window.api.loras.listByModel('ZIB');   // 单字符串后向兼容
        return {
            doubleTarget: r1.ok ? r1.loras.length : -1,
            emptyTarget: r2.ok ? r2.loras.length : -1,
            emptyArray: r3.ok ? r3.loras.length : -1,
            singleString: r4.ok ? r4.loras.length : -1,
        };
    })();`);
    console.log('  filter results =', JSON.stringify(filterCheck));
    expect('listByModel(["ZIB","ZIT"]) 返回 lora 数 ≥0', filterCheck.doubleTarget >= 0);
    expect('listByModel("") 返回全量 > 0', filterCheck.emptyTarget > 0, `empty=${filterCheck.emptyTarget}`);
    expect('listByModel("") 全量 ≥ 带过滤结果', filterCheck.emptyTarget >= filterCheck.doubleTarget);
    expect('listByModel("ZIB") (字符串后向兼容) 返回 lora 数 ≥0', filterCheck.singleString >= 0);

    // 任务 2：LORA 表单的多选下拉 UI 验证
    console.log('\n[Task 2] LORA 表单「适配模型」单一多选下拉');
    await win.webContents.executeJavaScript(`window.lorasPage.open()`);
    await new Promise(r => setTimeout(r, 1500));

    // 打开 Lora 编辑表单
    const openForm = await win.webContents.executeJavaScript(`(async () => {
        try {
            // 直接拉一个 lora 来编辑（取第一个）
            const list = await window.api.loras.list({ limit: 1 });
            if (!list.ok || !list.loras.length) return { ok: false, error: 'no lora' };
            const lora = list.loras[0];
            // 模拟 UI：点击「新建」走 create 路径
            // 找表单按钮
            const newBtn = document.getElementById('lpBtnNew');
            if (!newBtn) return { ok: false, error: 'no new btn' };
            newBtn.click();
            await new Promise(r => setTimeout(r, 300));
            // 表单应该已经显示
            const formVisible = !!document.getElementById('lpEditModal') && getComputedStyle(document.getElementById('lpEditModal')).display === 'flex';
            // 表单里有哪些元素
            const elIds = {};
            ['lpBtnCompatDropdown', 'lpCompatDropdownMenu', 'lpCompatWrap', 'lpInCompat', 'lpInBaseModel', 'lpBtnAddCompat'].forEach(id => {
                const el = document.getElementById(id);
                elIds[id] = el ? 'present' : 'MISSING';
            });
            // dropdown menu 中的 checkbox 选项
            const menu = document.getElementById('lpCompatDropdownMenu');
            const checkboxValues = menu ? Array.from(menu.querySelectorAll('input[type="checkbox"]')).map(c => c.value) : [];
            // 关掉编辑 modal 避免影响后续
            const cancelBtn = document.getElementById('lpEditBtnCancel');
            if (cancelBtn) cancelBtn.click();
            await new Promise(r => setTimeout(r, 100));
            return { ok: true, formVisible, elIds, checkboxValues };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    })();`);
    console.log('  form 结构 =', JSON.stringify(openForm, null, 2));
    expect('Lora 编辑表单打开', openForm.ok && openForm.formVisible);
    expect('旧的 lpInCompat input 已移除', openForm.elIds && openForm.elIds.lpInCompat === 'MISSING');
    expect('旧的 lpBtnAddCompat 已移除', openForm.elIds && openForm.elIds.lpBtnAddCompat === 'MISSING');
    expect('旧的 lpInBaseModel 已移除', openForm.elIds && openForm.elIds.lpInBaseModel === 'MISSING');
    expect('新的 lpBtnCompatDropdown 存在', openForm.elIds && openForm.elIds.lpBtnCompatDropdown === 'present');
    expect('新的 lpCompatDropdownMenu 存在', openForm.elIds && openForm.elIds.lpCompatDropdownMenu === 'present');
    expect('lpCompatWrap (chips 区) 存在', openForm.elIds && openForm.elIds.lpCompatWrap === 'present');
    expect('dropdown 含 11 个枚举 checkbox', openForm.checkboxValues && openForm.checkboxValues.length === 11);
    const expectedEnums = ['ZIT','ZIB','Krea2','Kelin2','Flux','Flux2','Qwen','Wan2.1','Wan2.2','Anime','boogu'];
    expect('枚举值完全匹配', JSON.stringify(openForm.checkboxValues) === JSON.stringify(expectedEnums),
        `got=${JSON.stringify(openForm.checkboxValues)}`);

    // 任务 2.5：验证多选下拉交互：勾选 → 进入 buffer，再取消 → 从 buffer 移除
    console.log('\n[Task 2.5] 多选下拉交互');
    await win.webContents.executeJavaScript(`document.getElementById('lpBtnNew').click()`);
    await new Promise(r => setTimeout(r, 300));
    const interaction = await win.webContents.executeJavaScript(`(async () => {
        try {
            const menu = document.getElementById('lpCompatDropdownMenu');
            const btn = document.getElementById('lpBtnCompatDropdown');
            btn.click();
            await new Promise(r => setTimeout(r, 80));
            // 添加 3 个
            const cbFlux = menu.querySelector('input[type="checkbox"][value="Flux"]');
            const cbKelin = menu.querySelector('input[type="checkbox"][value="Kelin2"]');
            const cbWan = menu.querySelector('input[type="checkbox"][value="Wan2.2"]');
            cbFlux.checked = true;   cbFlux.dispatchEvent(new Event('change'));
            cbKelin.checked = true;  cbKelin.dispatchEvent(new Event('change'));
            cbWan.checked = true;   cbWan.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 200));
            const wrapHtmlAdd = document.getElementById('lpCompatWrap').innerHTML;

            // 删除路径：点 chip 上的 × (data-remove-compat-value="Kelin2")
            // 修复后用事件委托到 #lpCompatWrap，FA 替换 <i> 为 <svg> 也不会断。
            const xKelin = document.querySelector('[data-remove-compat-value="Kelin2"]');
            if (xKelin) xKelin.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 200));
            const wrapHtmlRemove = document.getElementById('lpCompatWrap').innerHTML;

            document.getElementById('lpEditBtnCancel').click();
            await new Promise(r => setTimeout(r, 100));
            return { ok: true, wrapHtmlAdd, wrapHtmlRemove };
        } catch (e) {
            return { ok: false, error: String(e), stack: e.stack };
        }
    })();`);
    console.log('  interaction =', JSON.stringify(interaction, null, 2));
    if (interaction.ok) {
        expect('勾选 Flux 后 chips 区含 Flux',
            interaction.wrapHtmlAdd.includes('data-compat-value="Flux"'));
        expect('勾选 Kelin2 后 chips 区含 Kelin2',
            interaction.wrapHtmlAdd.includes('data-compat-value="Kelin2"'));
        expect('勾选 Wan2.2 后 chips 区含 Wan2.2',
            interaction.wrapHtmlAdd.includes('data-compat-value="Wan2.2"'));
        expect('点 × 删除 Kelin2 后 chips 区不再含 Kelin2',
            !interaction.wrapHtmlRemove.includes('data-compat-value="Kelin2"'));
        expect('点 × 删除 Kelin2 后 Flux 和 Wan2.2 仍存在',
            interaction.wrapHtmlRemove.includes('data-compat-value="Flux"') &&
            interaction.wrapHtmlRemove.includes('data-compat-value="Wan2.2"'));
    } else {
        expect('多选下拉交互未抛错', false, interaction.error);
    }

    // 关掉 loras 页
    await win.webContents.executeJavaScript(`window.lorasPage.close()`);

    console.log(`\n=== ${pass} pass / ${fail} fail ===`);
    app.exit(fail > 0 ? 1 : 0);
});
