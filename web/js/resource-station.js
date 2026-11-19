/* Local video library. Independent lifecycle; no background playback after navigation. */
(() => {
    'use strict';
    const api = window.api?.resourceStation;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const time = value => { const n = Math.max(0, Math.floor(Number(value) || 0)); return `${n >= 3600 ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };
    const playerIcons = {"play":"<path d=\"m9 5 11 7-11 7Z\" fill=\"currentColor\" stroke=\"none\"/>","pause":"<path d=\"M8 5v14M16 5v14\" stroke-width=\"3.5\"/>","close":"<path d=\"m6 6 12 12M18 6 6 18\"/>","film":"<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4\"/>","volume":"<path d=\"M11 4 6 8H3v8h3l5 4Z\"/><path d=\"M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14\"/>","muted":"<path d=\"M11 4 6 8H3v8h3l5 4Z\"/><path d=\"m16 9 5 6m0-6-5 6\"/>","back":"<path d=\"M4 9a9 9 0 1 1-1 6M4 3v6h6\"/><text x=\"8\" y=\"17\" fill=\"currentColor\" stroke=\"none\" font-size=\"9\" font-family=\"sans-serif\">10</text>","forward":"<path d=\"M20 9a9 9 0 1 0 1 6M20 3v6h-6\"/><text x=\"7\" y=\"17\" fill=\"currentColor\" stroke=\"none\" font-size=\"9\" font-family=\"sans-serif\">10</text>","fullscreen":"<path d=\"M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5\"/>","minimize":"<path d=\"M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5\"/>","keyboard":"<rect x=\"2\" y=\"5\" width=\"20\" height=\"14\" rx=\"3\"/><path d=\"M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10\"/>"};
    const playerIcon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + playerIcons[name] + '</svg>';
    const root = document.createElement('section');
    root.id = 'resourceStation'; root.className = 'rs-shell'; root.hidden = true;
    root.setAttribute('aria-label', '资源站');
    root.innerHTML = `
        <aside class="rs-sidebar"><div class="rs-brand">◈ <span>资源站<small>私人影音库</small></span></div>
            <nav aria-label="资源站菜单"><button data-page="home" class="active">⌂ <span>首页</span></button><button data-page="actors">♙ <span>演员</span></button><button data-page="categories">▦ <span>分类</span></button></nav>
            <div class="rs-sidebar-bottom"><span id="rs-count">0 部视频</span><small>把喜欢的故事，留在这里</small></div>
        </aside>
        <div class="rs-workspace"><div class="rs-toolbar"><button data-action="home" title="返回首页" aria-label="返回首页">‹</button><button data-action="refresh" title="刷新" aria-label="刷新">⟳</button><input id="rs-search" type="search" placeholder="搜索视频、演员… (Ctrl+K)" aria-label="搜索视频、演员"><div class="rs-spacer"></div><button data-action="import-folder">导入文件夹</button><button class="rs-primary" data-action="import">＋ 导入视频</button></div><main id="rs-content"></main></div>
        <div id="rs-notice" class="rs-notice" role="status" hidden></div>
        <dialog id="rs-editor" class="rs-dialog"><form id="rs-form"><div class="rs-dialog-head"><h2>编辑视频资料</h2><button type="button" data-action="close-editor" aria-label="关闭">×</button></div><div class="rs-form-grid">
            <label class="rs-wide">名称<input name="title" required maxlength="200"></label><label>演员（逗号分隔）<input name="actors"></label><label>分类 / 风格（逗号分隔）<input name="categories"></label><label>地区<input name="region" maxlength="200"></label><label>年份<input name="year" maxlength="20"></label><label>类型<select name="type"><option>电影</option><option>剧集</option><option>合集</option><option>其他</option></select></label><label class="rs-wide">简介<textarea name="description" rows="3" maxlength="4000"></textarea></label></div>
            <div class="rs-image-actions"><button type="button" data-action="cover">选择海报</button><button type="button" data-action="backdrop">选择首页背景</button><span id="rs-image-status"></span></div><div class="rs-source-head">视频版本 <small>添加同一视频的不同清晰度文件</small></div><div id="rs-sources"></div><div class="rs-image-actions"><input id="rs-quality-label" placeholder="例如 1080P / 4K" maxlength="40" aria-label="新版本清晰度名称"><button type="button" data-action="add-source">＋ 添加版本</button></div><small>海报、背景及视频版本更改即时保存。</small><div class="rs-dialog-foot"><button type="button" class="rs-danger" data-action="remove">删除作品</button><div class="rs-spacer"></div><button type="button" data-action="close-editor">取消</button><button type="submit" class="rs-primary">保存资料</button></div><small>删除作品将直接永久删除记录，原视频文件会保留。</small></form></dialog>
        <dialog id="rs-player" class="rs-player" aria-label="视频播放器" aria-describedby="rs-playing-title">
            <div class="rs-player-title">
                <span class="rs-cinema-mark">${playerIcon('film')}</span>
                <div class="rs-title-copy"><span class="rs-eyebrow">正在观看 <span>／ 私人影音库</span></span><strong id="rs-playing-title"></strong></div>
                <span id="rs-playback-state" class="rs-playback-state">准备播放</span>
                <button data-action="close-player" class="rs-icon-button" aria-label="关闭播放器" title="关闭播放器（Esc）">${playerIcon('close')}</button>
            </div>
            <div class="rs-video-wrap">
                <video id="rs-video" playsinline preload="metadata"></video>
                <button id="rs-center-play" data-action="toggle" aria-label="继续播放" hidden>${playerIcon('play')}<span>继续播放</span></button>
                <div id="rs-player-message" role="status" aria-live="polite" hidden><span class="rs-player-spinner"></span><span id="rs-player-message-text"></span><button data-action="retry" hidden>重新尝试</button></div>
            </div>
            <div class="rs-controls">
                <div class="rs-seek-wrap"><div class="rs-seek-track"><span id="rs-buffered"></span><span id="rs-played"></span></div><input id="rs-seek" type="range" min="0" max="100" step="0.1" value="0" aria-label="播放进度" disabled><output id="rs-seek-preview" hidden>00:00</output></div>
                <div class="rs-control-row">
                    <div class="rs-control-group"><button data-action="toggle" aria-label="播放" title="播放 / 暂停（空格）" id="rs-toggle">${playerIcon('play')}</button><button data-action="backward" aria-label="快退 10 秒" title="快退 10 秒（←）">${playerIcon('back')}</button><button data-action="forward" aria-label="快进 10 秒" title="快进 10 秒（→）">${playerIcon('forward')}</button><span id="rs-time">00:00 <span>/ 00:00</span></span></div>
                    <div class="rs-control-group rs-player-options"><div class="rs-volume-group"><button data-action="mute" id="rs-mute" aria-label="静音" title="静音（M）">${playerIcon('volume')}</button><input id="rs-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="音量"></div><label class="rs-player-select"><span>倍速</span><select id="rs-speed" aria-label="播放速度">${[0.5,0.75,1,1.25,1.5,1.75,2,3].map(n=>`<option value="${n}" ${n===1?'selected':''}>${n}×</option>`).join('')}</select></label><label class="rs-player-select"><span>画质</span><select id="rs-quality" aria-label="清晰度"></select></label><button data-action="player-help" aria-label="键盘快捷键" title="键盘快捷键" aria-expanded="false" aria-controls="rs-shortcuts">${playerIcon('keyboard')}</button><button data-action="fullscreen" id="rs-fullscreen" aria-label="进入全屏" title="全屏（F）">${playerIcon('fullscreen')}</button></div>
                </div>
                <div class="rs-player-footer"><span id="rs-player-context">观看进度自动保存</span><span>双击画面全屏 <span class="rs-footer-dot">·</span> 空格暂停 / 播放</span></div>
                <div id="rs-shortcuts" hidden><strong>键盘快捷键</strong><span><kbd>Space</kbd> 播放 / 暂停</span><span><kbd>←</kbd><kbd>→</kbd> 跳转 10 秒</span><span><kbd>M</kbd> 静音</span><span><kbd>F</kbd> 全屏</span><span><kbd>Esc</kbd> 退出全屏 / 关闭</span></div>
            </div>
        </dialog>`;
    document.body.appendChild(root);
    root.querySelector('.rs-toolbar').insertAdjacentHTML('beforeend', '<button data-action="add-record">添加视频资料</button>');
    root.querySelector('#rs-form .rs-dialog-foot').insertAdjacentHTML('beforebegin', '<section class="rs-torrent-editor"><label>种子地址<input name="torrentUrl" maxlength="8000" placeholder="HTTP(S) 种子地址或 magnet 链接"></label><div class="rs-image-actions"><button type="button" data-action="torrent-upload">上传种子文件</button><small>只保存 .torrent 附件，不下载视频。保存资料后生效。</small></div><div id="rs-torrent-drafts"></div></section>');
    root.querySelector('.rs-form-grid').insertAdjacentHTML('beforeend', '<label>番号<input name="code" maxlength="100"></label><label>发布日期<input name="releaseDate" type="date"></label><label>制片商 / 制作公司<input name="studio" maxlength="200"></label><label>时长（秒）<input name="duration" type="number" min="0" step="any"></label><label class="rs-wide">播放地址（链接或本地路径）<input name="playbackUrl" maxlength="4000" placeholder="暂未关联视频可以留空"></label>');
    // A <dialog> cannot itself enter the Fullscreen API; fullscreen its inner frame.
    const playerFrame = document.createElement('div');
    playerFrame.className = 'rs-player-frame';
    const playerDialog = root.querySelector('#rs-player');
    while (playerDialog.firstChild) playerFrame.appendChild(playerDialog.firstChild);
    playerDialog.appendChild(playerFrame);
    const $ = selector => root.querySelector(selector);
    const content = $('#rs-content'), video = $('#rs-video'), player = $('#rs-player'), editor = $('#rs-editor');
    let videos = [], page = 'home', query = '', actor = '', filters = {}, heroIndex = 0, limit = 72, editingId = null, playingId = null, saveAt = 0, switching = false, pendingPlayback = null, noticeTimer, busy = false, loadVersion = 0;
    let detailVideoId = null, detailReturnScroll = 0, draftTorrents = [], editorVersion = 0;
    const nasImportDialog = document.createElement('dialog');
    nasImportDialog.id = 'rs-nas-import'; nasImportDialog.className = 'rs-dialog rs-nas-import';
    nasImportDialog.setAttribute('aria-labelledby', 'rs-nas-import-title');
    nasImportDialog.innerHTML = `<form id="rs-nas-import-form">
        <div class="rs-dialog-head"><div><h2 id="rs-nas-import-title">从 NAS 批量导入</h2><p>按演员目录整理作品，只保存播放地址。</p></div><button type="button" id="rs-nas-import-close" aria-label="关闭导入弹框">×</button></div>
        <label class="rs-nas-path-label" for="rs-nas-import-path">演员目录的上级路径</label>
        <input id="rs-nas-import-path" required maxlength="4000" placeholder="/home/MyFile/001Move/03LongMove/" autocomplete="off">
        <div class="rs-nas-tree"><span>03LongMove /</span><span>　├ 演员甲 / <em>作品一.mp4、作品二.mkv</em></span><span>　└ 演员乙 / <em>作品三.mp4</em></span></div>
        <p class="rs-nas-import-help">使用「设置 → NAS 地址」中的服务器和账号。按演员目录名称及已有别名匹配；没有对应演员时自动创建。重复播放地址会跳过，演员目录内的子文件夹也会扫描。</p>
        <div id="rs-nas-import-status" role="status" aria-live="polite">输入目录后开始导入。</div>
        <div id="rs-nas-import-counts" class="rs-nas-import-counts" hidden></div>
        <pre id="rs-nas-import-errors" hidden></pre>
        <div class="rs-dialog-foot"><button type="button" id="rs-nas-import-cancel">关闭</button><div class="rs-spacer"></div><button type="submit" class="rs-primary" id="rs-nas-import-submit">开始导入</button></div>
    </form>`;
    root.appendChild(nasImportDialog);
    let nasImportId = null;
    function showNasImportCounts(data) {
        const node = $('#rs-nas-import-counts'); node.hidden = false;
        node.textContent = `新增演员 ${data.actorsCreated || 0} · 匹配演员 ${data.actorsMatched || 0} · 导入作品 ${data.added || 0} · 重复跳过 ${data.skipped || 0} · 补充关联 ${data.linked || 0} · 失败 ${data.failed || 0}`;
    }
    api?.onNasImportProgress?.(data => { if (data.requestId !== nasImportId) return; $('#rs-nas-import-status').textContent = data.current; showNasImportCounts(data); });
    function openNasImport() {
        if (!nasImportDialog.open) nasImportDialog.showModal();
        if (!nasImportId) $('#rs-nas-import-path').focus();
    }
    async function cancelNasImport() {
        if (!nasImportId) { nasImportDialog.close(); return; }
        $('#rs-nas-import-cancel').disabled = true;
        $('#rs-nas-import-status').textContent = '正在停止，已导入的记录会保留…';
        try { await call('nasImportCancel', nasImportId); }
        catch (error) { $('#rs-nas-import-status').textContent = error.message; $('#rs-nas-import-cancel').disabled = false; }
    }
    $('#rs-nas-import-close').addEventListener('click', cancelNasImport);
    $('#rs-nas-import-cancel').addEventListener('click', cancelNasImport);
    nasImportDialog.addEventListener('cancel', event => { event.preventDefault(); void cancelNasImport(); });
    nasImportDialog.addEventListener('close', () => { root.appendChild($('#rs-notice')); });
    $('#rs-nas-import-form').addEventListener('submit', async event => {
        event.preventDefault(); if (nasImportId) return;
        const directory = $('#rs-nas-import-path').value.trim(); if (!directory) return;
        nasImportId = crypto.randomUUID();
        $('#rs-nas-import-submit').disabled = true; $('#rs-nas-import-path').disabled = true;
        $('#rs-nas-import-close').disabled = true; $('#rs-nas-import-cancel').textContent = '停止导入';
        $('#rs-nas-import-status').textContent = '正在连接 NAS…'; $('#rs-nas-import-errors').hidden = true; showNasImportCounts({});
        try {
            const result = await call('nasImport', { path: directory, requestId: nasImportId });
            showNasImportCounts(result);
            $('#rs-nas-import-status').textContent = `${result.canceled ? '已停止，已导入的记录会保留。' : '目录处理完成。'}${result.ignoredRootFiles ? ` 根目录中 ${result.ignoredRootFiles} 个视频未导入，请先放入演员目录。` : ''}`;
            $('#rs-nas-import-errors').hidden = !result.errors.length;
            $('#rs-nas-import-errors').textContent = result.errors.map(e => `${e.path}：${e.message}`).join('\n') + (result.failed > result.errors.length ? '\n仅显示前 200 条失败记录。' : '');
            try { await refresh(); } catch (error) { $('#rs-nas-import-status').textContent += ` 列表刷新失败：${error.message}`; }
        } catch (error) { $('#rs-nas-import-status').textContent = `导入失败：${error.message}`; }
        finally {
            nasImportId = null; $('#rs-nas-import-submit').disabled = false; $('#rs-nas-import-path').disabled = false;
            $('#rs-nas-import-close').disabled = false; $('#rs-nas-import-cancel').disabled = false; $('#rs-nas-import-cancel').textContent = '关闭';
        }
    });

    function showWork(id) {
        if (!videos.some(item => item.id === id)) return;
        if (!detailVideoId) detailReturnScroll = content.scrollTop;
        detailVideoId = id; cancelBackdrop(); render(); content.scrollTop = 0;
    }
    function renderTorrentDrafts() {
        $('#rs-torrent-drafts').innerHTML = draftTorrents.map((file, index) => `<div class="rs-source"><span>${escape(file.name)} <small>${Math.ceil(file.size / 1024)} KB</small></span><button type="button" data-remove-torrent="${index}">移除附件</button></div>`).join('');
    }
    function renderWorkDetail(item) {
        const image = heroBackdrop(item);
        root.classList.remove('rs-actor-detail');
        content.innerHTML = `<div class="rs-work"><div class="rs-work-back"><button data-action="work-back">‹ 返回列表</button></div><section class="rs-hero rs-work-hero">${image ? `<img class="rs-hero-image" src="${escape(image)}" alt="">` : ''}<div class="rs-hero-shade"></div><div class="rs-hero-copy"><p class="rs-eyebrow">作品详情</p><h1>${escape(item.title)}</h1><p class="rs-hero-meta">${escape([item.code, item.releaseDate || item.year, item.region, ...item.categories].filter(Boolean).join(' · '))}</p><p class="rs-description">${escape(item.description || '暂无作品简介')}</p><div class="rs-hero-actions"><button class="rs-hero-play" data-play="${escape(item.id)}" ${item.sources.length ? '' : 'disabled'}>▶ ${item.position && !item.watched ? '继续播放' : '播放'}</button><button data-edit="${escape(item.id)}">编辑资料</button><button class="rs-danger" data-delete-video="${escape(item.id)}">删除作品</button></div>${!item.sources.length ? '<p class="rs-muted">未关联播放地址，可通过编辑资料添加。</p>' : ''}</div></section><section class="rs-work-info"><h2>作品信息</h2><dl>${[['演员',item.actors.join('、')],['地区',item.region],['番号',item.code],['发布日期',item.releaseDate || item.year],['制片商',item.studio],['时长',item.duration ? time(item.duration) : ''],['类型',item.type]].map(([name,value]) => `<div><dt>${name}</dt><dd>${escape(value || '未填写')}</dd></div>`).join('')}</dl><h2>种子附件与地址</h2>${item.torrents?.length ? item.torrents.map(file => `<div class="rs-source"><span>${escape(file.name)} <small>${Math.ceil(file.size / 1024)} KB · 本地附件</small></span><button data-torrent-download="${escape(file.id)}" data-video="${escape(item.id)}">下载种子文件</button></div>`).join('') : '<p class="rs-muted">尚未上传种子文件</p>'}${item.torrentUrl ? `<div class="rs-torrent-address"><input readonly aria-label="种子地址" value="${escape(item.torrentUrl)}"><button data-action="copy-torrent-url">复制地址</button></div>` : ''}</section></div>`;
        ensureBackdrop(item);
    }
    const actorUI = window.createResourceActors?.({ root, call, getVideos: () => videos, grid, refresh, notice, onDeleted: removeDeletedVideos, onAddVideo: actor => edit(null, { actors: [actor.name], region: actor.nationality || '' }) });
    let durationJob = null;
    const failedDurations = new Set();
    function removeDeletedVideos(ids) {
        const deleted = new Set(ids);
        ++loadVersion;
        cancelBackdrop(); durationJob?.cancel();
        videos = videos.filter(video => !deleted.has(video.id));
        if (deleted.has(detailVideoId)) detailVideoId = null;
        if (deleted.has(playingId)) stopPlayer(false);
        if (deleted.has(editingId) && editor.open) editor.close();
    }
    async function deleteVideo(id, button) {
        if (!id) return;
        button.disabled = true;
        try {
            const result = await call('remove', id);
            removeDeletedVideos(result?.deletedVideoIds || [id]);
            render(); await refresh(); notice('作品已永久删除');
        } finally { button.disabled = false; }
    }
    function queueDurations() {
        if (durationJob || root.hidden || playingId || !api?.videoDuration) return;
        const item = videos.find(v => !v.duration && v.sources[0]?.path && !failedDurations.has(v.sources[0].id));
        if (!item) return;
        const source = item.sources[0], media = document.createElement('video');
        let finished = false;
        const job = { cancel: () => finish() }; durationJob = job;
        const timer = setTimeout(() => { failedDurations.add(source.id); finish(); queueDurations(); }, 8000);
        function finish() { if (finished) return; finished = true; clearTimeout(timer); media.onloadedmetadata = media.onerror = null; media.removeAttribute('src'); media.load(); if (durationJob === job) durationJob = null; }
        media.muted = true; media.preload = 'metadata';
        media.onerror = () => { failedDurations.add(source.id); finish(); queueDurations(); };
        media.onloadedmetadata = async () => {
            const duration = media.duration;
            if (!Number.isFinite(duration) || duration <= 0) { failedDurations.add(source.id); finish(); queueDurations(); return; }
            try { const result = await call('videoDuration', item.id, source.id, duration); const current = videos.find(v => v.id === result.id); if (current?.sources[0]?.id === source.id) current.duration = result.duration; if (editingId === result.id && !Number($('#rs-form').elements.duration.value)) $('#rs-form').elements.duration.value = result.duration.toFixed(1); }
            catch { failedDurations.add(source.id); }
            finally { finish(); queueDurations(); }
        };
        media.src = source.url; media.load();
    }
    let backdropJob = null, heroTimer = null;
    const failedBackdrops = new Set();
    const automaticBackdrop = item => item.autoBackdropSourceId === item.sources[0]?.id ? item.autoBackdrop : '';
    const heroBackdrop = item => item.backdrop || automaticBackdrop(item) || item.cover;
    function cancelBackdrop() { if (backdropJob) { backdropJob.controller.abort(); backdropJob = null; } }
    function stopHeroTimer() { if (heroTimer) { clearInterval(heroTimer); heroTimer = null; } }
    function captureBackdrop(url, signal) {
        return new Promise((resolve, reject) => {
            const media = document.createElement('video');
            media.muted = true; media.preload = 'auto'; media.playsInline = true;
            let done = false, seeking = false, sample = 0, best = null, bestScore = -1;
            const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
            const timer = setTimeout(() => finish(new Error('视频截图超时')), 12000);
            function finish(error, image) {
                if (done) return; done = true; clearTimeout(timer);
                signal.removeEventListener('abort', abort);
                media.onloadedmetadata = media.onloadeddata = media.onseeked = media.onerror = null;
                media.pause(); media.removeAttribute('src'); media.load();
                error ? reject(error) : resolve(image);
            }
            const abort = () => finish(new DOMException('已取消截取', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) { abort(); return; }
            function seekSample() {
                if (done) return;
                const duration = media.duration;
                const positions = Number.isFinite(duration) && duration > 0 ? [Math.min(30, duration * 0.1), duration * 0.35, duration * 0.65] : [1, 3, 5];
                const target = positions[sample];
                seeking = true;
                if (Math.abs(media.currentTime - target) < 0.01 && media.readyState >= 2) { takeFrame(); return; }
                try { media.currentTime = target; } catch (error) { finish(error); }
            }
            function takeFrame() {
                if (done || !seeking || media.readyState < 2) return;
                seeking = false;
                try {
                    if (!media.videoWidth || !media.videoHeight) throw new Error('视频没有可用画面');
                    const scale = Math.min(1, 1280 / media.videoWidth, 720 / media.videoHeight);
                    canvas.width = Math.max(1, Math.round(media.videoWidth * scale)); canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
                    context.drawImage(media, 0, 0, canvas.width, canvas.height);
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    let lit = 0, count = 0;
                    for (let i = 0; i < pixels.length; i += 160) { if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 45) lit++; count++; }
                    const score = lit / count;
                    if (score > bestScore) { bestScore = score; best = canvas.toDataURL('image/jpeg', 0.82); }
                    if (score < 0.3 && ++sample < 3) seekSample(); else finish(null, best);
                } catch (error) { finish(error); }
            }
            media.onloadedmetadata = seekSample;
            media.onloadeddata = () => { if (!media.seeking) takeFrame(); };
            media.onseeked = takeFrame;
            media.onerror = () => finish(new Error('视频编码不支持截图或文件不可用'));
            if (/^https?:/i.test(url)) {
                media.crossOrigin = 'anonymous';
                const address = new URL(url);
                // NAS credentials are supplied by the main-process media authorization hook.
                address.username = ''; address.password = '';
                media.src = address.href;
            } else media.src = url;
            media.load();
        });
    }
    let coverJob = null, coverStatus = '';
    function updateCoverStatus() {
        const status = content.querySelector('.rs-cover-status');
        if (status) { status.textContent = coverStatus; status.hidden = !coverStatus; }
        const start = content.querySelector('[data-action="generate-covers"]'), stop = content.querySelector('[data-action="cancel-covers"]');
        if (start) start.disabled = !!coverJob;
        if (stop) stop.hidden = !coverJob;
    }
    async function generateCovers() {
        if (coverJob) return;
        if (!api?.saveCover) { notice('请重启软件后使用封面生成'); return; }
        const candidates = videos.filter(item => !item.cover && hasPlaybackSource(item)).map(item => item.id);
        if (!candidates.length) { coverStatus = '没有需要生成封面的作品'; updateCoverStatus(); return; }
        const job = { controller: new AbortController() }; coverJob = job;
        cancelBackdrop();
        let succeeded = 0, failed = 0, skipped = 0, completed = 0;
        try {
            for (const id of candidates) {
                if (job.controller.signal.aborted) break;
                const item = videos.find(value => value.id === id);
                if (!item || item.cover || !hasPlaybackSource(item)) { skipped++; completed++; continue; }
                coverStatus = `正在生成封面 ${completed + 1}/${candidates.length}：${item.title}`; updateCoverStatus();
                try {
                    let result, lastError;
                    for (const source of item.sources.filter(source => typeof source?.url === 'string' && source.url.trim())) {
                        try {
                            const dataUrl = await captureBackdrop(source.url, job.controller.signal);
                            if (job.controller.signal.aborted) break;
                            result = await call('saveCover', id, source.id, dataUrl, source.url);
                            break;
                        } catch (error) { if (job.controller.signal.aborted) break; lastError = error; }
                    }
                    if (!result) { if (job.controller.signal.aborted) break; throw lastError || new Error('没有可用画面'); }
                    const current = videos.find(value => value.id === id);
                    if (current) current.cover = result.url;
                    result.skipped ? skipped++ : succeeded++;
                    if (!root.hidden && page === 'categories' && !detailVideoId) renderCategories();
                } catch (error) { failed++; }
                completed++;
            }
        } finally {
            coverJob = null;
            coverStatus = `${job.controller.signal.aborted ? '已停止' : '生成完成'}：成功 ${succeeded}，失败 ${failed}，跳过 ${skipped}（已处理 ${completed}/${candidates.length}）`;
            updateCoverStatus();
            queueBackdrops();
        }
    }

    function queueBackdrops() {
        if (coverJob || backdropJob || root.hidden || playingId || detailVideoId || page !== 'home' || query) return;
        const next = videos.find(item => item.sources[0]?.path && !item.cover && !item.backdrop && !automaticBackdrop(item) && !failedBackdrops.has(`${item.id}:${item.sources[0].id}`));
        if (next) ensureBackdrop(next);
    }
    function ensureBackdrop(item) {
        if (coverJob || root.hidden || (detailVideoId ? item.id !== detailVideoId : page !== 'home' || query) || playingId || item.backdrop || automaticBackdrop(item) || !api?.saveBackdrop) { cancelBackdrop(); return; }
        const source = item.sources[0], key = `${item.id}:${source?.id}`;
        if (!source || failedBackdrops.has(key)) { cancelBackdrop(); return; }
        if (backdropJob?.key === key) return;
        cancelBackdrop();
        const job = { key, controller: new AbortController() }; backdropJob = job;
        captureBackdrop(source.url, job.controller.signal).then(async dataUrl => {
            if (job.controller.signal.aborted) return;
            const result = await call('saveBackdrop', item.id, source.id, dataUrl);
            const current = videos.find(v => v.id === result.id);
            if (current?.sources[0]?.id === result.sourceId) { current.autoBackdrop = result.url; current.autoBackdropSourceId = result.sourceId; }
            if (current && !current.cover && !current.backdrop) for (const poster of root.querySelectorAll('.rs-poster[data-work]')) if (poster.dataset.work === result.id) { const placeholder = poster.querySelector('.rs-placeholder'); if (placeholder) { const image = document.createElement('img'); image.src = result.url; image.alt = ''; placeholder.replaceWith(image); } }
            // A late result belongs to its own video, never the newly selected recommendation.
            if (!root.hidden && (detailVideoId ? detailVideoId === result.id : page === 'home' && !query && videos.slice(0, 5)[heroIndex]?.id === result.id) && current) {
                const hero = content.querySelector('.rs-hero');
                if (hero) { let image = hero.querySelector('.rs-hero-image'); if (!image) { image = document.createElement('img'); image.className = 'rs-hero-image'; image.alt = ''; hero.prepend(image); } image.src = heroBackdrop(current); }
            }
        }).catch(error => { if (error.name !== 'AbortError') { failedBackdrops.add(key); console.warn('[resourceStation] 自动背景暂不可用:', error.message); } }).finally(() => { if (backdropJob === job) { backdropJob = null; queueBackdrops(); } });
    }
    function notice(message) { clearTimeout(noticeTimer); const node = $('#rs-notice'); (root.querySelector('dialog[open]') || root).appendChild(node); node.textContent = message; node.hidden = false; noticeTimer = setTimeout(() => { node.hidden = true; }, 6000); }
    async function call(method, ...args) { if (!api) throw new Error('资源站未加载，请重启软件'); const result = await api[method](...args); if (!result?.ok) throw new Error(result?.error || '操作失败'); return result.data; }
    function replace(item) { if (item) videos = videos.map(v => v.id === item.id ? item : v); }
    async function refresh() { const version = ++loadVersion; const [items] = await Promise.all([call('list'), actorUI?.load()]); if (version !== loadVersion) return; videos = items; render(); queueDurations(); queueBackdrops(); }
    function empty(message = '还没有视频', detail = '点击右上角导入视频或文件夹，开始建立你的私人影音库。') { return `<div class="rs-empty"><div>▷</div><h2>${escape(message)}</h2><p>${escape(detail)}</p></div>`; }
    function picture(item, wide = false) { const src = wide ? item.backdrop || automaticBackdrop(item) || item.cover : item.cover || automaticBackdrop(item) || item.backdrop; return src ? `<img src="${escape(src)}" alt="" loading="lazy">` : `<div class="rs-placeholder"><span>▷</span><small>${escape(item.title)}</small></div>`; }
    function hasPlaybackSource(item) { return Array.isArray(item.sources) && item.sources.some(source => typeof source?.url === 'string' && source.url.trim().length > 0); }
    function card(item, wide = false) {
        const subtitle = [item.code, item.releaseDate || item.year, hasPlaybackSource(item) ? (wide && item.position ? '已播放 ' + time(item.position) : item.type) : '未关联播放地址'].filter(Boolean).join(' · ');
        return `<article class="rs-card ${wide ? 'rs-wide-card' : ''}"><button class="rs-poster" data-work="${escape(item.id)}" aria-label="查看作品 ${escape(item.title)}">${picture(item, wide)}<span class="rs-quality-badge">${escape(item.sources[0]?.label || '资料')}</span><span class="rs-play-overlay">查看详情</span>${!hasPlaybackSource(item) ? '<span class="rs-unavailable-badge">不可播放</span>' : ''}${item.duration && item.position ? `<span class="rs-progress"><i style="width:${Math.min(100,item.position/item.duration*100)}%"></i></span>` : ''}</button><div class="rs-card-caption"><button class="rs-card-name" data-work="${escape(item.id)}" title="${escape(item.title)}">${escape(item.title)}</button></div><small title="${escape(subtitle)}">${escape(subtitle)}</small></article>`;
    }
    function matches(item) { const needle = query.toLocaleLowerCase(); return (!needle || [item.title, item.code || '', item.studio || '', ...item.actors, ...item.categories].some(x => x.toLocaleLowerCase().includes(needle))) && (!actor || item.actors.includes(actor)); }
    function releaseYear(item) { const raw = item.releaseDate || item.year; const match = String(raw || '').match(/\d{4}/); return match ? match[0] : ''; }
    function filtered() { return videos.filter(matches).filter(item => Object.entries(filters).every(([key, value]) => !value || (key === 'watched' ? (value === '可播放' ? hasPlaybackSource(item) : value === '无资源' ? !hasPlaybackSource(item) : value === '已观看' ? item.watched : !item.watched) : key === 'categories' ? item.categories.includes(value) : key === 'year' ? releaseYear(item) === value : item[key] === value))); }
    function grid(items) { return items.length ? `<div class="rs-grid">${items.slice(0, limit).map(item => card(item)).join('')}</div>${items.length > limit ? '<button class="rs-more" data-action="more">加载更多</button>' : ''}` : empty('没有匹配的视频', '试试其他搜索词或筛选条件，也可以先导入视频。'); }
    function renderHome() {
        stopHeroTimer();
        if (query || !videos.length) cancelBackdrop();
        if (query) { content.innerHTML = `<div class="rs-library"><h2>搜索结果</h2>${grid(videos.filter(matches))}</div>`; return; }
        if (!videos.length) { content.innerHTML = `<div class="rs-hero rs-hero-empty"><div class="rs-hero-copy"><p class="rs-eyebrow">YOUR PERSONAL CINEMA</p><h1>每个故事，都值得珍藏。</h1><p>导入视频，整理演员与分类。<br>从上次停下的地方，继续精彩。</p><button class="rs-primary" data-action="import">＋ 导入第一部视频</button></div></div>${empty('你的影音库，从这里开始')}`; return; }
        const featured = videos.slice(0, 5); heroIndex %= featured.length; const item = featured[heroIndex];
        const image = heroBackdrop(item);
        ensureBackdrop(item);
        const recent = [...videos].filter(v => v.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 12);
        const recentMarkup = recent.length ? `<section class="rs-row-section rs-recent"><h2>最近播放 <span>›</span></h2><div class="rs-horizontal">${recent.map(item => card(item, true)).join('')}</div></section>` : '';
        content.innerHTML = `<div class="rs-home"><section class="rs-hero">${image ? `<img class="rs-hero-image" src="${escape(image)}" alt="">` : ''}<div class="rs-hero-shade"></div><div class="rs-hero-copy"><p class="rs-eyebrow">精选推荐</p><h1>${escape(item.title)}</h1><p class="rs-hero-meta">${escape([item.year, ...item.categories, item.region].filter(Boolean).join(' · ') || '我的视频收藏')}</p><p class="rs-description">${escape(item.description || '为这部视频补充简介、海报和演员资料，让你的影音库更完整。')}</p><div class="rs-hero-actions"><button class="rs-hero-play" data-play="${escape(item.id)}">▶ ${item.position && !item.watched ? '继续播放' : '播放'}</button><button data-work="${escape(item.id)}">查看详情</button></div></div><div class="rs-dots">${featured.map((_, index) => `<button data-hero="${index}" class="${index === heroIndex ? 'active' : ''}" aria-label="推荐 ${index + 1}" aria-pressed="${index === heroIndex}"></button>`).join('')}</div></section>${recentMarkup}</div>`;
        if (featured.length > 1) heroTimer = setInterval(() => { if (root.hidden || document.hidden || page !== 'home' || query || detailVideoId || playingId || editor.open || actorUI?.isEditing()) return; heroIndex = (heroIndex + 1) % featured.length; renderHome(); }, 7000);
    }
    function renderActors() {
        if (actorUI) { actorUI.render(content, query); return; }
        if (actor) { content.innerHTML = `<div class="rs-library"><button data-action="actors-back">‹ 全部演员</button><h2>${escape(actor)} <span>(${videos.filter(matches).length})</span></h2>${grid(videos.filter(matches))}</div>`; return; }
        const groups = new Map();
        for (const item of videos) for (const name of item.actors) { if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); }
        const entries = [...groups].filter(([name]) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
        content.innerHTML = `<div class="rs-library"><div class="rs-section-head"><h2>演员 <span>(${entries.length})</span></h2><span class="rs-muted">在视频资料中添加演员，自动归入这里</span></div>${entries.length ? `<div class="rs-grid rs-actors">${entries.slice(0, limit).map(([name, items]) => `<article class="rs-card"><button class="rs-poster" data-actor="${escape(name)}">${picture(items.find(i => i.cover) || items[0])}</button><button class="rs-card-name" data-actor="${escape(name)}">${escape(name)}</button><small>演员 · 共 ${items.length} 项</small></article>`).join('')}</div>${entries.length > limit ? '<button class="rs-more" data-action="more">加载更多</button>' : ''}` : empty('还没有演员资料', '编辑视频资料并填写演员姓名，即可按演员浏览作品。')}</div>`;
    }
    function renderCategories() {
        const dimensions = [['watched', '进度', ['未观看', '已观看', '可播放', '无资源']], ['categories', '风格', [...new Set(videos.flatMap(v => v.categories))].sort()], ['region', '地区', [...new Set(videos.map(v => v.region).filter(Boolean))].sort()], ['year', '年份', [...new Set(videos.map(releaseYear).filter(Boolean))].sort().reverse()], ['type', '类型', ['电影', '剧集', '合集', '其他']]];
        const items = filtered();
        content.innerHTML = `<div class="rs-library"><div class="rs-section-head"><h2>分类 <span>(${items.length})</span></h2><div class="rs-category-actions"><button data-action="clear-filters">清除筛选</button><button data-action="generate-covers" ${coverJob ? 'disabled' : ''}>封面生成</button><button data-action="cancel-covers" ${coverJob ? '' : 'hidden'}>停止生成</button></div></div><p class="rs-cover-status" role="status" ${coverStatus ? '' : 'hidden'}>${escape(coverStatus)}</p><div class="rs-filters">${dimensions.map(([key, label, values]) => `<div class="rs-filter-row"><span>${label}</span>${['', ...values].map(value => `<button data-filter="${key}" data-value="${escape(value)}" class="${(filters[key] || '') === value ? 'active' : ''}" aria-pressed="${(filters[key] || '') === value}">${escape(value || '全部')}</button>`).join('')}</div>`).join('')}</div>${grid(items)}</div>`;
    }
    function render() { const detail = detailVideoId && videos.find(item => item.id === detailVideoId); if (!detail) detailVideoId = null; root.classList.toggle('rs-video-detail', !!detail); root.classList.toggle('rs-home-page', page === 'home' && !detailVideoId); if (detail) { $('#rs-count').textContent = `${videos.length} 部视频`; renderWorkDetail(detail); return; } if (page !== 'actors') root.classList.remove('rs-actor-detail'); if (page !== 'home' || query || detailVideoId) stopHeroTimer(); if (page !== 'home' || query) cancelBackdrop(); $('#rs-count').textContent = `${videos.length} 部视频`; root.querySelectorAll('[data-page]').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); }); if (page === 'home') renderHome(); else if (page === 'actors') renderActors(); else renderCategories(); }
    function edit(id, defaults = {}) { ++editorVersion; const item = id ? videos.find(v => v.id === id) : { title:'', type:'电影', actors:[], categories:[], sources:[], ...defaults }; if (!item) return; editingId = id || null; const form = $('#rs-form'); form.reset(); draftTorrents = [...(item.torrents || [])]; form.elements.torrentUrl.value = item.torrentUrl || ''; renderTorrentDrafts(); for (const key of ['title', 'actors', 'categories', 'region', 'year', 'type', 'description','code','releaseDate','studio','duration']) form.elements[key].value = Array.isArray(item[key]) ? item[key].join('，') : item[key] ?? ''; form.elements.playbackUrl.value = item.sources[0]?.path || item.sources[0]?.url || ''; form.querySelector('h2').textContent=id?'编辑视频资料':'添加视频资料'; for(const action of ['cover','backdrop','add-source','remove']) form.querySelector(`[data-action="${action}"]`).disabled=!id; $('#rs-sources').innerHTML=''; $('#rs-image-status').textContent=id?'':'先保存资料，即可设置图片和视频版本'; renderSources(); editor.showModal(); }
    function renderSources() { const item = videos.find(v => v.id === editingId); if (!item) return; $('#rs-image-status').textContent = `${item.cover ? '已设海报' : '未设海报'} · ${item.backdrop ? '已设背景' : '未设背景'}`; $('#rs-sources').innerHTML = item.sources.map((s, i) => `<div class="rs-source"><span>${escape(s.label)} <small title="${escape(s.path)}">${escape(s.path)}</small></span>${i ? `<button type="button" data-remove-source="${escape(s.id)}">移除</button>` : '<small>主视频</small>'}</div>`).join(''); }
    async function saveProgress() {
        if (!playingId || switching || !Number.isFinite(video.duration) || video.duration <= 0) return;
        const id = playingId, position = video.currentTime, duration = video.duration;
        const local = videos.find(v => v.id === id); if (local) Object.assign(local, { position, duration, lastPlayedAt: Date.now(), watched: position / duration >= 0.95 });
        try { await call('progress', id, { position, duration }); } catch (error) { notice(`观看进度保存失败：${error.message}`); }
    }
    let controlsTimer = null, previewingSeek = false;
    function revealControls() {
        clearTimeout(controlsTimer); playerFrame.classList.remove('rs-controls-hidden');
        if (document.fullscreenElement === playerFrame && !video.paused) controlsTimer = setTimeout(() => {
            if (!video.paused && !playerFrame.querySelector('.rs-controls :focus-visible, .rs-player-title :focus-visible') && !$('.rs-controls').matches(':hover') && $('#rs-shortcuts').hidden && $('#rs-player-message').hidden) playerFrame.classList.add('rs-controls-hidden');
        }, 2800);
    }
    function syncPlaybackUI() {
        const paused = video.paused || video.ended;
        $('#rs-toggle').innerHTML = playerIcon(paused ? 'play' : 'pause');
        $('#rs-toggle').setAttribute('aria-label', video.ended ? '重新播放' : paused ? '播放' : '暂停');
        $('#rs-center-play').hidden = !paused || !playingId || !$('#rs-player-message').hidden;
        $('#rs-center-play span').textContent = video.ended ? '重新播放' : '继续播放';
        $('#rs-center-play').setAttribute('aria-label', video.ended ? '重新播放' : '继续播放');
        $('#rs-playback-state').textContent = video.ended ? '播放完毕' : paused ? '已暂停' : '正在播放';
        $('#rs-playback-state').classList.toggle('is-playing', !paused);
        revealControls();
    }
    function syncVolumeUI() {
        const muted = video.muted || video.volume === 0;
        $('#rs-mute').innerHTML = playerIcon(muted ? 'muted' : 'volume');
        $('#rs-mute').setAttribute('aria-label', muted ? '取消静音' : '静音');
        $('#rs-mute').setAttribute('aria-pressed', String(muted));
        $('#rs-volume').value = video.muted ? 0 : video.volume;
        $('#rs-volume').style.setProperty('--volume', `${(video.muted ? 0 : video.volume) * 100}%`);
    }
    function toggleMute() { const muted = video.muted || video.volume === 0; if (video.volume === 0) video.volume = 0.5; video.muted = !muted; syncVolumeUI(); }
    function syncTimeline() {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const current = previewingSeek ? Number($('#rs-seek').value) : video.currentTime || 0;
        $('#rs-seek').disabled = !duration;
        $('#rs-seek').max = duration || 100;
        if (!previewingSeek) $('#rs-seek').value = current;
        $('#rs-seek').setAttribute('aria-valuetext', `${time(current)}，共 ${time(duration)}`);
        $('#rs-time').innerHTML = `${time(current)} <span>/ ${time(duration)}</span>`;
        $('#rs-played').style.width = `${duration ? current / duration * 100 : 0}%`;
        let buffered = 0;
        for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= current) buffered = video.buffered.end(i);
        $('#rs-buffered').style.width = `${duration ? Math.min(100, buffered / duration * 100) : 0}%`;
    }
    function playerMessage(message = '', kind = 'loading') {
        $('#rs-player-message-text').textContent = message;
        $('#rs-player-message').hidden = !message;
        $('#rs-player-message').classList.toggle('is-error', kind === 'error');
        $('#rs-player-message [data-action="retry"]').hidden = kind !== 'error';
        $('#rs-center-play').hidden = !!message || !video.paused || !playingId;
        if (message) { $('#rs-playback-state').textContent = kind === 'error' ? '播放遇到问题' : '正在载入'; $('#rs-playback-state').classList.remove('is-playing'); revealControls(); }
    }
    async function tryPlay() { try { if (video.ended) video.currentTime = 0; await video.play(); } catch (error) { if (error.name !== 'AbortError') playerMessage('暂时无法播放，请重试或切换其他视频版本。', 'error'); } }
    function play(id) {
        durationJob?.cancel(); cancelBackdrop();
        const item = videos.find(v => v.id === id); if (!item) return;
        if (!item.sources.length) { showWork(id); notice('此作品尚未关联播放地址，可点击编辑资料添加。'); return; }
        if (playingId) stopPlayer();
        playingId = id; saveAt = 0; switching = true; previewingSeek = false;
        pendingPlayback = { position: item.watched ? 0 : item.position || 0, paused: false, rate: Number($('#rs-speed').value) };
        $('#rs-playing-title').textContent = item.title;
        $('#rs-quality').innerHTML = item.sources.map(s => `<option value="${escape(s.id)}">${escape(s.label)}</option>`).join('');
        $('#rs-quality').disabled = item.sources.length < 2;
        $('#rs-quality').title = item.sources.length < 2 ? '当前只有一个视频版本，可在编辑资料中添加' : '切换版本会保留观看进度';
        $('#rs-player-context').textContent = pendingPlayback.position > 0 ? `从 ${time(pendingPlayback.position)} 继续观看 · 进度自动保存` : '观看进度自动保存';
        $('#rs-shortcuts').hidden = true; $('[data-action="player-help"]').setAttribute('aria-expanded', 'false');
        $('#rs-seek').value = 0; $('#rs-seek').disabled = true; $('#rs-time').textContent = '00:00 / 00:00';
        $('#rs-played').style.width = '0%'; $('#rs-buffered').style.width = '0%';
        playerMessage('正在载入视频…'); video.src = item.sources[0].url; video.load(); player.showModal(); player.tabIndex = -1; player.focus(); syncVolumeUI(); revealControls();
    }
    function stopPlayer(save = true) {
        if (save) void saveProgress(); playingId = null; pendingPlayback = null; switching = false; previewingSeek = false;
        video.pause(); video.removeAttribute('src'); video.load(); clearTimeout(controlsTimer); clearTimeout(videoClickTimer); playerFrame.classList.remove('rs-controls-hidden');
        $('#rs-seek-preview').hidden = true;
        if (document.fullscreenElement === playerFrame) document.exitFullscreen().catch(() => {});
        if (player.open) player.close(); render();
    }
    async function fullscreen() { try { if (document.fullscreenElement === playerFrame) await document.exitFullscreen(); else await playerFrame.requestFullscreen(); } catch (error) { notice(`无法进入全屏：${error.message}`); } }
    video.addEventListener('loadedmetadata', () => {
        const pending = pendingPlayback; if (!pending || !playingId) return; pendingPlayback = null;
        video.currentTime = Math.min(pending.position, Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : pending.position);
        video.playbackRate = pending.rate; switching = false; playerMessage(); syncTimeline(); syncPlaybackUI(); if (!pending.paused) void tryPlay();
    });
    video.addEventListener('timeupdate', () => { syncTimeline(); if (Date.now() - saveAt > 5000) { saveAt = Date.now(); void saveProgress(); } });
    video.addEventListener('progress', syncTimeline);
    video.addEventListener('durationchange', syncTimeline);
    video.addEventListener('play', () => { playerMessage(); syncPlaybackUI(); });
    video.addEventListener('pause', () => { syncPlaybackUI(); void saveProgress(); });
    video.addEventListener('ended', () => { syncPlaybackUI(); void saveProgress(); });
    video.addEventListener('waiting', () => { if (playingId) playerMessage('正在缓冲，请稍候…'); });
    video.addEventListener('playing', () => { playerMessage(); syncPlaybackUI(); });
    video.addEventListener('error', () => { if (playingId) playerMessage('视频暂时无法播放。请检查连接，或切换其他版本；若文件已移动，请在编辑资料中重新关联。', 'error'); });
    video.addEventListener('volumechange', syncVolumeUI);
    video.addEventListener('ratechange', () => { $('#rs-speed').value = String(video.playbackRate); });
    let videoClickTimer;
    video.addEventListener('click', () => { clearTimeout(videoClickTimer); videoClickTimer = setTimeout(() => { if (playingId) video.paused ? void tryPlay() : video.pause(); }, 220); });
    video.addEventListener('dblclick', () => { clearTimeout(videoClickTimer); void fullscreen(); });
    playerFrame.addEventListener('pointermove', revealControls);
    playerFrame.addEventListener('focusin', revealControls);
    playerFrame.addEventListener('focusout', revealControls);
    document.addEventListener('fullscreenchange', () => { const active = document.fullscreenElement === playerFrame; $('#rs-fullscreen').innerHTML = playerIcon(active ? 'minimize' : 'fullscreen'); $('#rs-fullscreen').setAttribute('aria-label', active ? '退出全屏' : '进入全屏'); $('#rs-fullscreen').title = active ? '退出全屏（F / Esc）' : '全屏（F）'; revealControls(); });
    $('#rs-seek').addEventListener('pointerdown', () => { previewingSeek = true; });
    const finishSeek = () => { previewingSeek = false; syncTimeline(); };
    $('#rs-seek').addEventListener('change', finishSeek);
    $('#rs-seek').addEventListener('pointercancel', finishSeek);
    $('#rs-seek').addEventListener('blur', finishSeek);
    $('#rs-seek').addEventListener('input', event => { if (Number.isFinite(video.duration)) { video.currentTime = Number(event.target.value); syncTimeline(); } });
    $('#rs-seek').addEventListener('pointermove', event => { if (!Number.isFinite(video.duration)) return; const r = event.target.getBoundingClientRect(), ratio = Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)); $('#rs-seek-preview').textContent = time(ratio * video.duration); $('#rs-seek-preview').style.left = `${Math.max(3, Math.min(97, ratio * 100))}%`; $('#rs-seek-preview').hidden = false; });
    $('#rs-seek').addEventListener('pointerleave', () => { $('#rs-seek-preview').hidden = true; });
    $('#rs-speed').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
    $('#rs-volume').addEventListener('input', event => { video.volume = Number(event.target.value); video.muted = video.volume === 0; syncVolumeUI(); });
    $('#rs-quality').addEventListener('change', event => { const item = videos.find(v => v.id === playingId), source = item?.sources.find(s => s.id === event.target.value); if (!source) return; void saveProgress(); pendingPlayback = { position: pendingPlayback?.position ?? video.currentTime, paused: pendingPlayback?.paused ?? video.paused, rate: video.playbackRate }; switching = true; playerMessage('正在切换视频版本，保留观看进度…'); video.src = source.url; video.load(); });
    player.addEventListener('cancel', event => { event.preventDefault(); stopPlayer(); });

    editor.addEventListener('close', () => { ++editorVersion; draftTorrents = []; editingId = null; root.appendChild($('#rs-notice')); });
    player.addEventListener('close', () => { root.appendChild($('#rs-notice')); });
    $('#rs-search').addEventListener('input', event => { query = event.target.value.trim(); limit = 72; render(); });
    $('#rs-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { const data=Object.fromEntries(new FormData(event.target)); data.torrents = draftTorrents; if(editingId) replace(await call('update', editingId, data)); else videos.unshift(await call('addMetadata', data)); editor.close(); render(); notice('视频资料已保存，仅记录播放地址，不复制或下载视频'); } catch (error) { notice(error.message); } finally { button.disabled = false; } });
    root.addEventListener('click', async event => {
        const button = event.target.closest('button'); if (!button) return;
        try {
            if (button.dataset.page) { detailVideoId = null; page = button.dataset.page; actorUI?.reset(); actor = ''; query = ''; $('#rs-search').value = ''; limit = 72; content.scrollTop = 0; render(); return; }
            if (button.dataset.deleteVideo) { await deleteVideo(button.dataset.deleteVideo, button); return; }
            if (button.dataset.work) { showWork(button.dataset.work); return; }
            if (button.dataset.play) { play(button.dataset.play); return; }
            if (button.dataset.removeTorrent !== undefined) { draftTorrents.splice(Number(button.dataset.removeTorrent), 1); renderTorrentDrafts(); return; }
            if (button.dataset.torrentDownload) { button.disabled = true; try { const result = await call('torrentExport', button.dataset.video, button.dataset.torrentDownload); if (!result.canceled) notice('种子附件已保存到选择的位置'); } finally { button.disabled = false; } return; }
            if (button.dataset.edit) { edit(button.dataset.edit); return; }
            if (button.dataset.actor) { actor = button.dataset.actor; query = ''; $('#rs-search').value = ''; render(); return; }
            if (button.dataset.hero !== undefined) { heroIndex = Number(button.dataset.hero); renderHome(); return; }
            if (button.dataset.filter) { filters[button.dataset.filter] = button.dataset.value; limit = 72; render(); return; }
            if (button.dataset.removeSource) { replace(await call('removeSource', editingId, button.dataset.removeSource)); renderSources(); return; }
            switch (button.dataset.action) {
                case 'work-back': detailVideoId = null; render(); content.scrollTop = detailReturnScroll; break;
                case 'torrent-upload': { const version = editorVersion; button.disabled = true; try { const file = await call('torrentUpload'); if (file && version === editorVersion && editor.open) { if (draftTorrents.length >= 20) throw new Error('每部作品最多保存 20 个种子附件'); draftTorrents.push(file); renderTorrentDrafts(); } } finally { button.disabled = false; } break; }
                case 'copy-torrent-url': { const item = videos.find(v => v.id === detailVideoId); if (item?.torrentUrl) { await navigator.clipboard.writeText(item.torrentUrl); notice('种子地址已复制'); } break; }
                case 'add-record': edit(null); break;
                case 'home': detailVideoId = null; page = 'home'; actor = ''; query = ''; $('#rs-search').value = ''; render(); break;
                case 'refresh': failedBackdrops.clear(); failedDurations.clear(); await refresh(); break;
                case 'import-folder': openNasImport(); break;
                case 'import': {
                    if (busy) return; busy = true; root.querySelectorAll('[data-action^="import"]').forEach(b => b.disabled = true); notice('选择文件后开始导入，请稍候…');
                    try { const result = await call('import', 'files'); await refresh(); notice(result ? `已导入 ${result.added} 部，跳过 ${result.skipped} 项${result.errors.length ? `，${result.errors.length} 项失败：${result.errors[0].message}` : ''}` : '已取消导入'); }
                    finally { busy = false; root.querySelectorAll('[data-action^="import"]').forEach(b => b.disabled = false); } break;
                }
                case 'actors-back': actor = ''; render(); break;
                case 'generate-covers': await generateCovers(); break;
                case 'cancel-covers': coverJob?.controller.abort(); break;
                case 'clear-filters': filters = {}; query = ''; $('#rs-search').value = ''; render(); break;
                case 'more': limit += 72; render(); break;
                case 'close-editor': editor.close(); break;
                case 'cover': case 'backdrop': replace(await call('image', editingId, button.dataset.action)); renderSources(); render(); break;
                case 'add-source': if (!$('#rs-quality-label').value.trim()) throw new Error('先填写清晰度名称'); replace(await call('addSource', editingId, $('#rs-quality-label').value)); renderSources(); break;
                case 'remove': await deleteVideo(editingId, button); break;
                case 'close-player': stopPlayer(); break;
                case 'toggle': video.paused ? void tryPlay() : video.pause(); break;
                case 'backward': video.currentTime = Math.max(0, video.currentTime - 10); break;
                case 'forward': if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10); break;
                case 'mute': toggleMute(); break;
                case 'player-help': $('#rs-shortcuts').hidden = !$('#rs-shortcuts').hidden; button.setAttribute('aria-expanded', String(!$('#rs-shortcuts').hidden)); revealControls(); break;
                case 'retry': if (playingId) { pendingPlayback = { position: video.currentTime || 0, paused: false, rate: Number($('#rs-speed').value) }; switching = true; playerMessage('正在重新连接…'); video.load(); } break;
                case 'fullscreen': await fullscreen(); break;
            }
        } catch (error) { notice(error.message); }
    });
    document.addEventListener('keydown', event => {
        if (root.hidden || nasImportDialog.open) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !player.open && !editor.open && !actorUI?.isEditing()) { event.preventDefault(); $('#rs-search').focus(); return; }
        if (!player.open || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || (event.key === ' ' && event.target.tagName === 'BUTTON')) return;
        if ([' ', 'ArrowLeft', 'ArrowRight', 'f', 'F', 'm', 'M'].includes(event.key)) event.preventDefault();
        if (event.key === ' ') video.paused ? void tryPlay() : video.pause();
        if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
        if (event.key === 'ArrowRight' && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
        if (event.key.toLowerCase() === 'f') void fullscreen();
        if (event.key.toLowerCase() === 'm') toggleMute();
        revealControls();
    });
    window.addEventListener('beforeunload', () => { coverJob?.controller.abort(); cancelBackdrop(); durationJob?.cancel(); void saveProgress(); });
    window.resourceStation = {
        isOpen: () => !root.hidden,
        open() { root.hidden = false; window.dispatchEvent(new Event('resourceStation:opened')); render(); refresh().catch(error => notice(error.message)); },
        close() { coverJob?.controller.abort(); if (nasImportId) void cancelNasImport(); if (nasImportDialog.open) nasImportDialog.close(); root.hidden = true; cancelBackdrop(); stopHeroTimer(); durationJob?.cancel(); actorUI?.close(); if (playingId) stopPlayer(); if (editor.open) editor.close(); window.dispatchEvent(new Event('resourceStation:closed')); }
    };
})();