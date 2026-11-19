(function () {
    'use strict';
    const root = document.getElementById('resourceStation'), api = window.api?.resourceStation;
    if (!root || !api) return;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const selections = new Map();
    let files = [], actors = [], busy = false, stopRequested = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'rs-dialog rm-dialog';
    dialog.innerHTML = `
        <div class="rs-dialog-head"><h2>匹配助手</h2><button type="button" data-action="close" aria-label="关闭">×</button></div>
        <div class="rm-toolbar">
            <button class="rs-primary" type="button" data-action="scan">导入演员文件夹</button>
            <button type="button" data-action="batch">搜索全部待匹配作品</button>
            <button type="button" data-action="stop" hidden>停止搜索</button>
            <button type="button" data-action="refresh">刷新</button>
            <button type="button" data-action="clear">清空记录</button>
        </div>
        <p id="rm-status" role="status"></p><div id="rm-files" class="rm-list"></div>
        <small class="rm-note">每个文件最多选择一个名称与番号对应关系，也可以不关联。只有点击下方确认，才会将文件作品名保存到所选番号的作品中，并绑定本地文件地址。</small>
        <div class="rm-footer"><span id="rm-selected">已选择 0 个文件</span><button type="button" data-action="close">取消</button><button type="button" class="rs-primary" data-action="confirm-all">确认所选关联</button></div>`;
    root.appendChild(dialog);
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '匹配助手'; button.dataset.action = 'match-assistant';
    root.querySelector('.rs-toolbar')?.appendChild(button);
    const status = message => { dialog.querySelector('#rm-status').textContent = message; };
    const call = async (method, ...args) => { const result = await api[method](...args); if (!result.ok) throw new Error(result.error); return result.data; };
    const statusText = file => ({ pending: '待搜索', actor_required: '请选择演员', candidates: '待选择', confirmed: '已关联', ignored: '未关联' }[file.status] || file.status);
    function lock(value) {
        busy = value;
        dialog.querySelectorAll('button,input,select').forEach(control => { control.disabled = value && !['stop', 'close'].includes(control.dataset.action); });
    }
    function render() {
        for (const [id, candidateId] of selections) {
            const file = files.find(item => item.id === id);
            if (!file || file.status === 'confirmed' || !file.candidates?.some(item => item.id === candidateId)) selections.delete(id);
        }
        dialog.querySelector('#rm-files').innerHTML = files.length ? files.map(file => {
            const confirmed = file.status === 'confirmed';
            const candidates = (file.candidates || []).filter(item => item.id && item.videoId && !item.error).slice(0, 5);
            const selected = selections.get(file.id) || '', actor = actors.find(item => item.id === file.actorId);
            return `<article class="rm-file" data-file="${escape(file.id)}">
                <header><div><strong title="${escape(file.path)}">${escape(file.title)}</strong><small>${escape(file.actorHint)} · ${escape(statusText(file))}</small></div>
                ${confirmed ? '' : `<button type="button" data-suggest="${escape(file.id)}">重新搜索</button>`}</header>
                <p class="rm-actor">文件夹演员 → ${confirmed ? escape(actor?.name || file.actorHint) : `<select aria-label="${escape(file.title)}的演员" data-actor="${escape(file.id)}"><option value="" disabled ${!actor ? 'selected' : ''}>请选择数据库演员</option>${actors.map(item => `<option value="${escape(item.id)}" ${item.id === file.actorId ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select>`}</p>
                ${confirmed ? `<p class="rm-muted">已保存名称：${escape(file.title)} → 番号：${escape(file.confirmedCandidate?.code || '')}</p>` : `
                <div class="rm-candidates"><label class="rm-candidate"><input type="radio" name="rm-${escape(file.id)}" data-choice="${escape(file.id)}" value="" ${!selected ? 'checked' : ''}><span>不关联此文件</span></label>
                ${candidates.map(candidate => `<label class="rm-candidate"><input type="radio" name="rm-${escape(file.id)}" data-choice="${escape(file.id)}" value="${escape(candidate.id)}" ${selected === candidate.id ? 'checked' : ''}>
                    <div class="rm-candidate-main"><strong>${escape(file.title)} → ${escape(candidate.code)}</strong><small>Magnetz 结果：${escape(candidate.resultTitle || candidate.title)}</small><small>库内作品：${escape(candidate.libraryTitle)} · 演员：${escape(candidate.actor)}</small></div>
                    <span class="rm-score">番号相似度 ${Number(candidate.score || 0)}%</span></label>`).join('')}
                ${!candidates.length ? '<p class="rm-muted">暂无可选对应关系，请检查演员后搜索。</p>' : ''}</div>`}
                ${(file.errors || []).map(error => `<p class="rm-error">${escape(error)}</p>`).join('')}</article>`;
        }).join('') : '<p class="rm-muted">导入以演员姓名命名的文件夹，系统会逐个搜索其中的视频作品。</p>';
        dialog.querySelector('#rm-selected').textContent = `已选择 ${selections.size} 个文件`;
        lock(busy);
    }
    async function load() { [files, actors] = await Promise.all([call('matchList'), call('actorList')]); render(); }
    async function search(selected) {
        if (!dialog.open) return;
        stopRequested = false;
        dialog.querySelector('[data-action="stop"]').hidden = false;
        let processed = 0, failed = 0;
        try {
            const pending = selected.filter(file => file.status !== 'confirmed');
            for (const file of pending) {
                if (stopRequested) break;
                selections.delete(file.id); status(`正在搜索 ${processed + 1}/${pending.length}：${file.title}`);
                try {
                    const updated = await call('matchSuggest', file.id);
                    files = files.map(item => item.id === file.id ? updated : item);
                    if (updated.errors?.length) failed++;
                } catch (error) { failed++; files = files.map(item => item.id === file.id ? { ...item, errors: [error.message] } : item); }
                processed++; render();
            }
            status(`${stopRequested ? '已停止' : '搜索完成'}：已处理 ${processed} 个，${failed} 个需要检查。请选择对应关系后点击确认。`);
        } finally { dialog.querySelector('[data-action="stop"]').hidden = true; }
    }
    async function run(task) {
        if (busy) return;
        lock(true);
        try { await task(); } catch (error) { status(error.message); } finally { lock(false); }
    }
    dialog.addEventListener('change', event => {
        const control = event.target;
        if (busy) return;
        if (control.dataset.choice) {
            if (control.value) selections.set(control.dataset.choice, control.value); else selections.delete(control.dataset.choice);
            dialog.querySelector('#rm-selected').textContent = `已选择 ${selections.size} 个文件`;
        }
        if (control.dataset.actor) void run(async () => {
            selections.delete(control.dataset.actor);
            await call('matchActor', control.dataset.actor, control.value);
            await load(); status('演员已更新，请重新搜索该作品。');
        });
    });
    dialog.addEventListener('click', event => {
        event.stopPropagation();
        const control = event.target.closest('button');
        if (!control) return;
        const action = control.dataset.action;
        if (action === 'close') { stopRequested = true; selections.clear(); dialog.close(); return; }
        if (action === 'stop') { stopRequested = true; status('当前搜索完成后停止。'); return; }
        if (busy) return;
        void run(async () => {
            if (action === 'scan') {
                status('正在扫描演员文件夹…'); const scanned = await call('matchScan');
                if (scanned.canceled) { status('已取消导入'); return; }
                await load(); await search(scanned.files);
                if (scanned.errors?.length) status(`部分目录无法读取：${scanned.errors.map(item => `${item.path}：${item.message}`).join('；')}`);
            } else if (action === 'batch') { await load(); await search(files); }
            else if (control.dataset.suggest) await search(files.filter(file => file.id === control.dataset.suggest));
            else if (action === 'refresh') { await load(); status('已刷新'); }
            else if (action === 'clear') {
                if (!window.confirm('清空匹配记录？已关联的作品名称和播放地址会保留。')) return;
                await call('matchClear'); selections.clear(); await load(); status('已清空记录');
            } else if (action === 'confirm-all') {
                const chosen = [...selections].map(([fileId, candidateId]) => ({ fileId, candidateId, videoId: files.find(file => file.id === fileId).candidates.find(item => item.id === candidateId).videoId }));
                if (!chosen.length) { status('未选择任何作品，没有建立关联。'); return; }
                status('正在保存所选作品名称和文件地址…'); const result = await call('matchConfirmBatch', chosen);
                selections.clear(); await load(); status(`已关联 ${result.confirmed} 个文件，未选择的文件未做关联。`);
                root.querySelector('.rs-toolbar [data-action="refresh"]')?.click();
            }
        });
    });
    dialog.addEventListener('cancel', () => { stopRequested = true; selections.clear(); });
    button.addEventListener('click', () => { dialog.showModal(); if (!busy) void run(async () => { await load(); status('每个文件可选择一个对应关系，默认不关联。'); }); });
})();
