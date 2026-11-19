(() => {
    'use strict';
    window.createResourceActors = ({ root, call, getVideos, grid, refresh, notice, onDeleted = () => {}, onAddVideo = () => {} }) => {
        const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const dialog = document.createElement('dialog'); dialog.className = 'rs-dialog rs-actor-dialog'; dialog.id = 'rs-actor-editor';
        dialog.innerHTML = `<form id="rs-actor-form"><div class="rs-dialog-head"><h2>添加演员</h2><button type="button" data-aa="close" aria-label="关闭">×</button></div><div class="rs-actor-import"><label>从网页快速创建<input name="importUrl" placeholder="https://www.dramaface.com/info/…" aria-label="演员页面地址"></label><button type="button" data-aa="import">抓取并创建</button><small>支持 DramaFace 的 /info/ 和 /model/ 公开资料页。资料、写真和作品信息自动入库。</small><p id="rs-actor-import-status" role="status"></p></div><div class="rs-form-grid">${[['name','姓名 *'],['aliases','别名（逗号分隔）'],['birthday','生日'],['nationality','国籍'],['birthplace','出生地'],['height','身高'],['gender','性别']].map(([name,label])=>`<label>${label}<input name="${name}" ${name==='name'?'required':''} maxlength="200"></label>`).join('')}<label class="rs-wide">简介<textarea name="description" rows="4" maxlength="12000"></textarea></label></div><div class="rs-actor-pictures"><div id="rs-actor-cover"></div><div><button type="button" data-aa="cover">上传演员封面</button><button type="button" data-aa="photos">添加写真图片</button><small>图片保存在软件本地，支持多选。</small></div></div><div id="rs-actor-photos" class="rs-photo-grid"></div><div class="rs-dialog-foot"><div class="rs-spacer"></div><button type="button" data-aa="close">取消</button><button class="rs-primary" type="submit">保存演员</button></div></form>`;
        root.appendChild(dialog);
        dialog.querySelector('.rs-dialog-foot').insertAdjacentHTML('afterbegin', '<button type="button" class="rs-danger" data-aa="delete" hidden>删除演员</button>');
        const form = dialog.querySelector('form'), status = dialog.querySelector('#rs-actor-import-status');
        let records = [], selected = '', draft = {}, importing = false, importingUrl = '', container = null, query = '', loadVersion = 0;
        const normalize = value => String(value || '').toLocaleLowerCase();
        function entries() {
            const result = records.map(a=>({...a}));
            const known = new Set(result.flatMap(a=>[a.name,...(a.aliases||[])].map(normalize)));
            for (const video of getVideos()) for (const name of video.actors) if (!known.has(normalize(name))) { result.push({name,aliases:[],photos:[],cover:video.cover||''}); known.add(normalize(name)); }
            return result;
        }
        const works = actor => { const names = [actor.name,...(actor.aliases||[])].map(normalize); return getVideos().filter(v=>v.actors.some(n=>names.includes(normalize(n)))); };
        function images() {
            dialog.querySelector('#rs-actor-cover').innerHTML = draft.cover ? `<img src="${esc(draft.cover)}" alt="演员封面">` : '<span>暂无封面</span>';
            dialog.querySelector('#rs-actor-photos').innerHTML = (draft.photos||[]).map((url,i)=>`<div><img src="${esc(url)}" alt="写真 ${i+1}" loading="lazy"><button type="button" data-aa="remove-photo" data-index="${i}" aria-label="移除写真 ${i+1}">×</button></div>`).join('');
        }
        function open(actor = {}) {
            if (importing) { dialog.showModal(); return; }
            draft = {...actor, cover:actor.id ? actor.cover||'' : '', photos:[...(actor.photos||[])]};
            form.reset(); for(const name of ['name','aliases','birthday','nationality','birthplace','height','gender','description']) form.elements[name].value=Array.isArray(actor[name])?actor[name].join('，'):actor[name]||'';
            form.elements.importUrl.value=actor.sourceUrl||''; status.textContent='';
            dialog.querySelector('h2').textContent=actor.id?'编辑演员':'添加演员'; const removeButton=dialog.querySelector('[data-aa=delete]'); removeButton.hidden=!actor.name; removeButton.dataset.key=actor.id||actor.name||''; images();dialog.showModal();
        }
        function render(target = container, search = query) {
            container=target;query=search;if(!target)return;
            const all=entries(), current=all.find(a=>(a.id||a.name)===selected);
            root.classList.toggle('rs-actor-detail', Boolean(current));
            if (current) {
                const films=works(current);
                target.innerHTML=`<div class="rs-library"><div class="rs-section-head"><button data-aa="back">‹ 全部演员</button><div class="rs-actor-detail-actions"><button class="rs-primary" data-aa="edit" data-key="${esc(current.id||current.name)}">编辑演员资料</button><button class="rs-danger" data-aa="delete" data-key="${esc(current.id||current.name)}">删除演员</button><button class="rs-primary" data-aa="add-video" data-key="${esc(current.id||current.name)}">添加视频</button></div></div><div class="rs-actor-profile"><div class="rs-actor-portrait">${current.cover?`<img src="${esc(current.cover)}" alt="${esc(current.name)}">`:'♙'}</div><div><h1>${esc(current.name)}</h1><p class="rs-muted">${esc((current.aliases||[]).join(' · '))}</p><dl>${[['birthday','生日'],['nationality','国籍'],['birthplace','出生地'],['height','身高'],['gender','性别']].filter(([key])=>current[key]).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(current[key])}</dd></div>`).join('')}${Object.entries(current.details||{}).filter(([key])=>!['生日','国籍','出生地','身高','性别'].includes(key)).map(([key,value])=>`<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p class="rs-actor-bio">${esc(current.description||'尚未填写演员简介')}</p>${current.sourceUrl?`<p class="rs-muted">资料来源：${esc(current.sourceUrl)}</p>`:''}</div></div>${current.photos?.length?`<h2>写真 (${current.photos.length})</h2><div class="rs-photo-grid rs-actor-gallery">${current.photos.map(url=>`<button data-aa="view-photo" data-url="${esc(url)}"><img src="${esc(url)}" alt="${esc(current.name)}写真" loading="lazy"></button>`).join('')}</div>`:''}<h2>作品资料 (${films.length}) <span>含尚未关联播放地址的作品</span></h2>${grid(films)}</div>`;
                return;
            }
            const filtered=all.filter(a=>[a.name,...(a.aliases||[])].some(n=>normalize(n).includes(normalize(search)))).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
            target.innerHTML=`<div class="rs-library"><div class="rs-section-head"><h2>演员 <span>(${filtered.length})</span></h2><button class="rs-primary" data-aa="add">＋ 添加演员</button></div>${filtered.length?`<div class="rs-grid rs-actors">${filtered.map(a=>`<article class="rs-card"><button class="rs-poster" data-aa="detail" data-key="${esc(a.id||a.name)}">${a.cover?`<img src="${esc(a.cover)}" alt="${esc(a.name)}" loading="lazy">`:'<div class="rs-placeholder"><span>♙</span></div>'}</button><button class="rs-card-name" data-aa="detail" data-key="${esc(a.id||a.name)}">${esc(a.name)}</button><small>共 ${works(a).length} 部作品 · ${a.photos?.length||0} 张写真</small></article>`).join('')}</div>`:'<div class="rs-empty"><h2>建立你的演员资料库</h2><p>点击右上角添加演员，手动填写或粘贴资料页链接。</p></div>'}</div>`;
        }
        const unsubscribe=window.api?.resourceStation?.onActorImportProgress?.(message=>{status.textContent=message});
        window.addEventListener('beforeunload',()=>unsubscribe?.(),{once:true});
        dialog.addEventListener('close',()=>{const toast=root.querySelector('#rs-notice');if(toast)root.appendChild(toast)});
        form.addEventListener('submit',async event=>{
            event.preventDefault();if(importing)return;const button=event.submitter;button.disabled=true;
            try {const input=Object.fromEntries(new FormData(form));delete input.importUrl;const saved=await call('actorSave',{...draft,...input});selected=saved.id;dialog.close();await refresh();notice('演员资料已保存');}catch(error){status.textContent=error.message}finally{button.disabled=false}
        });
        root.addEventListener('click',async event=>{
            const button=event.target.closest('[data-aa]');if(!button)return;
            try {switch(button.dataset.aa){
                case 'add':open();break;
                case 'delete': {
                    if (importing) throw new Error('演员资料正在导入，请完成后再删除');
                    const actor = entries().find(a => (a.id || a.name) === button.dataset.key);
                    if (!actor) throw new Error('演员已不存在，请刷新列表');
                    button.disabled = true;
                    try {
                        const result = await call('actorRemove', actor.id ? { id: actor.id } : { name: actor.name });
                        if (result.canceled) break;
                        selected = ''; ++loadVersion;
                        records = records.filter(a => a.id !== result.actorId);
                        if (dialog.open) dialog.close();
                        onDeleted(result.deletedVideoIds);
                        await refresh();
                        notice(`已永久删除演员“${result.name}”及 ${result.deletedVideoIds.length} 条关联作品`);
                    } finally { button.disabled = false; }
                    break;
                }
                case 'detail':selected=button.dataset.key;render();break;
                case 'add-video': { const actor=entries().find(a=>(a.id||a.name)===button.dataset.key); if(actor)onAddVideo(actor); break; }
                case 'edit':open(entries().find(a=>(a.id||a.name)===button.dataset.key));break;
                case 'back':selected='';render();break;
                case 'close':dialog.close();break;
                case 'cover':case 'photos':{const urls=await call('actorImages');if(button.dataset.aa==='cover'){if(urls[0])draft.cover=urls[0]}else draft.photos=[...new Set([...(draft.photos||[]),...urls])].slice(0,100);images();break;}
                case 'remove-photo':draft.photos.splice(Number(button.dataset.index),1);images();break;
                case 'view-photo':{const preview=document.createElement('dialog');preview.className='rs-dialog rs-photo-preview';preview.innerHTML=`<button aria-label="关闭">×</button><img src="${esc(button.dataset.url)}" alt="演员写真">`;root.appendChild(preview);preview.querySelector('button').onclick=()=>preview.close();preview.onclose=()=>preview.remove();preview.showModal();break;}
                case 'import':{
                    if(importing)return;importingUrl=form.elements.importUrl.value.trim();if(!importingUrl)throw new Error('请填写演员页面地址');
                    importing=true;form.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);status.textContent='正在读取演员页面…';
                    try {const result=await call('actorImport',importingUrl);selected=result.actor.id;dialog.close();await refresh();notice(`已导入 ${result.actor.name}，作品 ${result.totalWorks} 部（新增 ${result.added} 部）${result.warnings.length?`；${result.warnings.length} 张图片未能缓存，可重新导入重试`:''}`)}finally{importing=false;form.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false)}break;
                }
            }}catch(error){status.textContent=error.message;if(!dialog.open)notice(error.message)}
        });
        return { async load(){const version=++loadVersion;const next=await call('actorList');if(version===loadVersion)records=next},render,reset(){selected=''},close(){for(const modal of root.querySelectorAll('.rs-actor-dialog[open],.rs-photo-preview[open]'))modal.close()},isEditing:()=>dialog.open };
    };
})();
