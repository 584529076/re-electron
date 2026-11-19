/* Visual orchestration of existing ComfyUI tools. */
(() => {
    'use strict';
    const M=window.FlowModel,api=window.api?.engineeringFlow;
    if(!M || !api)return;
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const shell=document.createElement('section');shell.id='engineeringFlow';shell.hidden=true;shell.setAttribute('aria-label','工程编排');
    shell.innerHTML=`<div class="ef-layout"><aside class="ef-library"><h3>节点库</h3><input id="ef-search" aria-label="搜索工作流" placeholder="搜索已有工作流…"><p>拖入画布，或点击添加</p><div id="ef-library-items"></div></aside><main class="ef-center"><div class="ef-canvas-toolbar"><span>拖拽端口连线 · 按住空格拖拽平移画布</span><button data-act="zoom-out" aria-label="缩小">−</button><span id="ef-zoom">100%</span><button data-act="zoom-in" aria-label="放大">＋</button></div><div class="ef-viewport"><div class="ef-board"><svg class="ef-wires" width="3200" height="2400" aria-label="节点连线"></svg><div class="ef-nodes"></div><div class="ef-empty"><strong>从一个开始节点出发</strong><p>添加工作流，连接兼容的输入和输出，再连接结束节点。</p></div></div></div><footer id="ef-status" role="status">就绪</footer></main><aside class="ef-inspector"><h3>节点设置</h3><div id="ef-inspector-body">选择节点，编辑参数和查看输入连接。</div><div id="ef-results"></div></aside></div>`;
    document.getElementById('workbench').appendChild(shell);
    const flowActions=document.querySelector('#workbench .dwp-actions-flow');
    // 2026-11 视图切换（tools 工具集 / flow 工程编排 / manage 工作流管理）
    // 管理工具集按钮进入的 manage 是子页：两个 Tab 都不高亮，两组右按钮都隐藏。
    function switchView(view){
        const isFlow=view==='flow',isManage=view==='manage';
        const tabTools=document.getElementById('dwpTabTools'),tabFlow=document.getElementById('dwpTabFlow');
        if(tabTools){tabTools.classList.toggle('active',view==='tools');tabTools.setAttribute('aria-selected',String(view==='tools'))}
        if(tabFlow){tabFlow.classList.toggle('active',isFlow);tabFlow.setAttribute('aria-selected',String(isFlow))}
        const canvas=document.querySelector('#workbench .dwp-canvas');if(canvas)canvas.hidden=isFlow||isManage;
        shell.hidden=!isFlow;
        const actsTools=document.querySelector('#workbench .dwp-actions-tools');if(actsTools)actsTools.hidden=isFlow||isManage;
        if(flowActions)flowActions.hidden=!isFlow;
        const managePage=document.getElementById('wfManagePage');if(managePage)managePage.hidden=!isManage;
        if(isFlow)enterFlow();else stopPan(true);
        try{window.dispatchEvent(new CustomEvent('dwp:viewchange',{detail:{view}}))}catch(e){}
    }
    window.dwpSwitchView=switchView;
    const $=s=>shell.querySelector(s)||document.querySelector(s);
    const board=$('.ef-board'),nodesEl=$('.ef-nodes'),svg=$('.ef-wires');
    let graph={version:1,name:'我的工程',nodes:[],edges:[]},catalog={},loras=[],selected=null,pending=null,drag=null,zoom=1,busy=false,loaded=false,poll=null,runState={nodes:{},results:[]},dirty=false;
    const uid=()=>crypto.randomUUID(),message=t=>{$('#ef-status').textContent=t},title=n=>n.name || (n.kind==='workflow'?catalog[n.toolId]?.name:n.kind==='start'?'开始 · '+M.labels[n.dataType]:n.kind==='end'?'结束':'串联 · '+M.labels[n.dataType]) || '工作流';
    const safePorts=n=>{try{return M.ports(n,catalog)}catch{return {inputs:[],outputs:[]}}};
    async function call(method,...args){const r=await api[method](...args);if(!r?.ok)throw Error(r?.error || '操作失败');return r.data}
    function changed(){dirty=true;message('有未保存的修改');try{localStorage.setItem('engineeringFlow.draft',JSON.stringify(graph))}catch{message('草稿存储失败，请点击保存')}}
    async function save(){graph.name=$('#ef-name').value.trim() || '我的工程';await call('save',graph);dirty=false;try{localStorage.removeItem('engineeringFlow.draft')}catch{}message('工程已保存')}
    function renderLibrary(){
        const query=$('#ef-search').value.toLowerCase(),builtins=[['start:text','开始 · 文本'],['start:image','开始 · 图片'],['start:video','开始 · 视频'],['relay:text','串联 · 文本'],['relay:image','串联 · 图片'],['relay:video','串联 · 视频'],['end','结束']];
        $('#ef-library-items').innerHTML='<h4>基础节点</h4>'+builtins.map(([id,name])=>`<button draggable="true" data-add="${id}"><span class="ef-node-icon">${id.startsWith('start')?'▷':id==='end'?'◎':'⇢'}</span>${name}</button>`).join('')+'<h4>已有工作流</h4>'+Object.values(catalog).filter(t=>String(t.name||t.id).toLowerCase().includes(query)).map(t=>{let ports,error;try{ports=M.ports({kind:'workflow',toolId:t.id},catalog)}catch(e){error=e.message}return `<button draggable="${!error}" data-add="tool:${esc(t.id)}" ${error?'disabled':''} title="${esc(error||t.description||'')}"><span class="ef-node-icon">▧</span><span>${esc(t.name || t.id)}<small>${error?'暂不可编排':([...new Set(ports.inputs.map(p=>M.labels[p.type]))].join(' / ')||'参数')+' → '+M.labels[ports.outputs[0].type]}</small></span></button>`}).join('');
    }
    function point(node,port,out){const ps=safePorts(node),index=out?0:ps.inputs.findIndex(p=>p.id===port);return {x:node.x+(out?234:0),y:node.y+70+Math.max(0,index)*28}}
    function curve(a,b){const d=Math.max(70,Math.abs(b.x-a.x)*.45);return `M${a.x},${a.y} C${a.x+d},${a.y} ${b.x-d},${b.y} ${b.x},${b.y}`}
    function drawWires(){svg.innerHTML=graph.edges.map(e=>{const a=graph.nodes.find(n=>n.id===e.from),b=graph.nodes.find(n=>n.id===e.to);if(!a||!b)return '';return `<path d="${curve(point(a,e.output,true),point(b,e.input,false))}" data-edge="${esc(e.id)}" class="ef-wire ${selected===e.id?'selected':''}" style="--wire:${color(safePorts(a).outputs[0]?.type)}"><title>点击选择连线，可在右侧删除</title></path>`}).join('')}
    function color(type){return {text:'#8b5cf6',image:'#0891b2',video:'#e88832',any:'#64748b'}[type]||'#64748b'}
    // 每个节点当前展示的产物索引（多产物左右切换）
    const nodeOutIdx=new Map();
    // 节点卡片内的结果展示区：有产物才输出 HTML
    function nodeOutputHtml(n){
        const rec=runState.nodeOutputs && runState.nodeOutputs[n.id];
        if(!rec || !Array.isArray(rec.artifacts) || !rec.artifacts.length) return '';
        const arts=rec.artifacts;
        const idx=Math.max(0,Math.min(nodeOutIdx.get(n.id)||0,arts.length-1));
        const a=arts[idx]||{};
        const nav=arts.length>1?`<div class="ef-node-out-nav"><button type="button" data-out-nav="prev" data-node="${esc(n.id)}" title="上一个产物">‹</button><span>${idx+1} / ${arts.length}</span><button type="button" data-out-nav="next" data-node="${esc(n.id)}" title="下一个产物">›</button></div>`:'';
        let body='';
        if(a.kind==='text') body=`<pre class="ef-node-out-text">${esc(a.text||'')}</pre>`;
        else if(a.kind==='video') body=`<video class="ef-node-out-media" src="${esc(a.src||'')}" controls preload="metadata"></video>`;
        else body=`<img class="ef-node-out-media" src="${esc(a.src||'')}" alt="节点运行结果">`;
        return `<div class="ef-node-output">${nav}${body}</div>`;
    }
    function renderCanvas(){
        nodesEl.innerHTML=graph.nodes.map(n=>{const p=safePorts(n),state=runState.nodes?.[n.id],stateText={running:'运行中',done:'完成',failed:'失败',cancelled:'已停止'}[state]||'';return `<article class="ef-node ${selected===n.id?'selected':''} ${state||''}" data-node="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;min-height:${Math.max(116,92+p.inputs.length*28)}px;--node-color:${color(p.outputs[0]?.type)}"><div class="ef-node-head" tabindex="0" role="button" aria-label="选择节点 ${esc(title(n))}"><span>${esc(title(n))}</span><small>${stateText || (n.kind==='workflow'?'工作流':'基础节点')}</small></div><div class="ef-inputs">${p.inputs.map(port=>`<button class="ef-port input" data-node-port="${esc(n.id)}" data-input="${esc(port.id)}" style="--port:${color(port.type)}" title="${esc(port.label)} · ${M.labels[port.type]}"><i></i><span>${esc(port.label)}</span></button>`).join('')}</div>${p.outputs.map(port=>`<button class="ef-port output ${pending?.from===n.id?'pending':''}" data-node-port="${esc(n.id)}" data-output="${port.id}" style="--port:${color(port.type)}" title="连接${M.labels[port.type]}输出"><span>${M.labels[port.type]}</span><i></i></button>`).join('')}${nodeOutputHtml(n)}</article>`}).join('');
        $('.ef-empty').hidden=graph.nodes.length>0;drawWires();
    }
    function fieldWidget(n,f){const value=n.values?.[f.id]??M.defaultValue(f)??'',connected=graph.edges.some(e=>e.to===n.id&&e.input===f.id),attrs=`data-field="${esc(f.id)}" ${connected||busy?'disabled':''}`;let control;
        if(f.type==='textarea')control=`<textarea ${attrs} rows="3">${esc(value)}</textarea>`;
        else if(f.type==='select')control=`<select ${attrs}>${(f.options||[]).map(o=>`<option ${String(o)===String(value)?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
        else if(f.type==='lora'||f.type==='loraMulti'){const selectedIds=Array.isArray(value)?value.map(x=>String(typeof x==='object'?x.id:x)):[String(value)];control=`<select ${attrs} ${f.type==='loraMulti'?'multiple size="5"':''}><option value="">不使用</option>${loras.map(l=>`<option value="${esc(l.id)}" ${selectedIds.includes(String(l.id))?'selected':''}>${esc(l.name)}</option>`).join('')}</select>`}
        else if(f.type==='boolean'||f.type==='checkbox')control=`<input ${attrs} type="checkbox" ${value?'checked':''}>`;
        else control=`<input ${attrs} type="${f.type==='number'?'number':'text'}" value="${esc(value)}" ${f.step!=null?`step="${esc(f.step)}"`:''}>`;
        if(['image','video'].includes(M.fieldType(f)))control+=`<button data-pick-field="${esc(f.id)}" data-kind="${M.fieldType(f)}" ${connected||busy?'disabled':''}>选择${M.labels[M.fieldType(f)]}</button>`;
        return `<label class="ef-field">${esc(f.label||f.id)}${f.required?' *':''}${connected?'<small>由上游结果自动填入</small>':''}${control}${f.note?`<small>${esc(f.note)}</small>`:''}</label>`;
    }
    function inspect(){const host=$('#ef-inspector-body'),edge=graph.edges.find(e=>e.id===selected),n=graph.nodes.find(n=>n.id===selected);
        if(edge){host.innerHTML=`<h4>连线</h4><p>${esc(title(graph.nodes.find(n=>n.id===edge.from)))} → ${esc(title(graph.nodes.find(n=>n.id===edge.to)))}</p><button data-act="delete" ${busy?'disabled':''}>删除连线</button>`;return}
        if(!n){host.textContent='选择节点，编辑参数和查看输入连接。';return}
        let html=`<h4>${esc(title(n))}</h4><label class="ef-field">节点名称<input data-node-name value="${esc(n.name||'')}" placeholder="${esc(title(n))}" ${busy?'disabled':''}></label>`;
        if(n.kind==='start')html+=`<label class="ef-field">输入${M.labels[n.dataType]}${n.dataType==='text'?`<textarea data-start-value rows="6" ${busy?'disabled':''}>${esc(n.value||'')}</textarea>`:`<input data-start-value value="${esc(n.value||'')}" placeholder="选择本地文件或填写绝对路径" ${busy?'disabled':''}><button data-pick-start ${busy?'disabled':''}>选择${M.labels[n.dataType]}</button>`}</label>`;
        if(n.kind==='workflow')html+=(catalog[n.toolId]?.formFields||[]).map(f=>fieldWidget(n,f)).join('');
        if(n.kind==='relay')html+=`<p>原样传递${M.labels[n.dataType]}。仅允许同类型连接，可将输出连接到多个兼容输入。</p>`;
        if(n.kind==='end')html+='<p>收集上游结果。运行结束后，图片和视频也可在现有任务历史中查看。</p>';
        html+='<h4>输入连线</h4>'+graph.edges.filter(e=>e.to===n.id).map(e=>`<div class="ef-connection">${esc(title(graph.nodes.find(x=>x.id===e.from)))} → ${esc(e.input)}<button data-delete-edge="${esc(e.id)}" ${busy?'disabled':''}>移除</button></div>`).join('')+`<button data-act="delete" class="ef-danger" ${busy?'disabled':''}>删除节点</button>`;host.innerHTML=html;
    }
    function add(spec,x,y){if(busy)return;if(graph.nodes.length>=100)throw Error('最多添加 100 个节点');const [kind,type]=spec.split(':');if(kind==='start'&&graph.nodes.some(n=>n.kind==='start'))throw Error('一个工程只需要一个开始节点');const n={id:uid(),kind:kind==='tool'?'workflow':kind,x:Math.max(15,x),y:Math.max(15,y),values:{}};if(kind==='tool')n.toolId=spec.slice(5);else if(kind!=='end')n.dataType=type;M.ports(n,catalog);graph.nodes.push(n);selected=n.id;changed();renderCanvas();inspect()}
    function connect(to,input){if(!pending||busy)return;try{const edge={id:uid(),...pending,to,input};M.checkEdge(graph,edge,catalog);graph.edges.push(edge);stopWiring();changed();renderCanvas();inspect();message('连接成功')}catch(e){message(e.message)}}
    function coords(e){const r=board.getBoundingClientRect();return {x:(e.clientX-r.left)/zoom,y:(e.clientY-r.top)/zoom}}
    shell.addEventListener('dragstart',e=>{const b=e.target.closest('[data-add]');if(b&&!busy){e.dataTransfer.setData('application/x-engineering-node',b.dataset.add);e.dataTransfer.effectAllowed='copy'}});
    board.addEventListener('dragover',e=>{if(!busy)e.preventDefault()});board.addEventListener('drop',e=>{e.preventDefault();const spec=e.dataTransfer.getData('application/x-engineering-node');if(spec)try{const p=coords(e);add(spec,p.x,p.y)}catch(error){message(error.message)}});
    let wireDrag = null;
    const viewport = $('.ef-viewport');
    let spaceHeld = false, pan = null, suppressPanClickUntil = 0;
    function stopPan(clearSpace = false) {
        const pointerId = pan?.pointerId;
        pan = null;
        if (clearSpace) spaceHeld = false;
        viewport.classList.toggle('ef-pan-ready',spaceHeld);
        viewport.classList.remove('ef-panning');
        if (pointerId != null && viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
    }
    const editorTarget = target => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]');
    document.addEventListener('keydown',e=>{
        if (shell.hidden || document.getElementById('workbench').hidden || editorTarget(e.target)) return;
        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();e.stopPropagation();
            if (!spaceHeld) { spaceHeld=true; viewport.classList.add('ef-pan-ready'); }
        }
        if (e.key === 'Escape' && pan) { stopPan(true);e.preventDefault();e.stopPropagation(); }
    },true);
    document.addEventListener('keyup',e=>{
        if ((e.code === 'Space' || e.key === ' ') && spaceHeld) { e.preventDefault();e.stopPropagation();stopPan(true); }
    },true);
    viewport.addEventListener('pointerdown',e=>{
        if (!spaceHeld || e.button !== 0) return;
        e.preventDefault();e.stopPropagation();stopWiring();drag=null;
        pan={pointerId:e.pointerId,x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
        viewport.setPointerCapture(e.pointerId);viewport.classList.add('ef-panning');
    },true);
    viewport.addEventListener('pointermove',e=>{
        if (!pan || e.pointerId !== pan.pointerId) return;
        e.preventDefault();e.stopPropagation();
        viewport.scrollLeft=pan.left+pan.x-e.clientX;
        viewport.scrollTop=pan.top+pan.y-e.clientY;
    },true);
    viewport.addEventListener('pointerup',e=>{
        if (!pan || e.pointerId !== pan.pointerId) return;
        e.preventDefault();e.stopPropagation();suppressPanClickUntil=performance.now()+250;stopPan();
    },true);
    viewport.addEventListener('click',e=>{if(spaceHeld || performance.now()<suppressPanClickUntil){e.preventDefault();e.stopPropagation()}},true);
    viewport.addEventListener('pointercancel',()=>stopPan(true));
    viewport.addEventListener('lostpointercapture',e=>{if(pan?.pointerId===e.pointerId)stopPan(true)});
    viewport.addEventListener('scroll',()=>{viewport.style.backgroundPosition=`${-viewport.scrollLeft}px ${-viewport.scrollTop}px`},{passive:true});
    window.addEventListener('blur',()=>stopPan(true));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPan(true)});
    window.addEventListener('workbench:closed',()=>stopPan(true));

    function edgeFor(port) {
        if (!wireDrag || !port) return null;
        if (wireDrag.output && port.hasAttribute('data-input')) return { from:wireDrag.node, output:wireDrag.port, to:port.dataset.nodePort, input:port.dataset.input };
        if (!wireDrag.output && port.hasAttribute('data-output')) return { from:port.dataset.nodePort, output:port.dataset.output, to:wireDrag.node, input:wireDrag.port };
        return null;
    }
    function stopWiring(keepPending = false) {
        const pointerId = wireDrag?.pointerId;
        wireDrag = null;
        if (!keepPending) pending = null;
        if (pointerId != null && board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
        nodesEl.querySelectorAll('.ef-port').forEach(p=>p.classList.remove('pending','ef-compatible','ef-incompatible','ef-hover'));
        if (pending) nodesEl.querySelector(`[data-node-port="${CSS.escape(pending.from)}"][data-output]`)?.classList.add('pending');
        drawWires();
    }
    function drawPreview() {
        svg.querySelector('.ef-wire-preview')?.remove();
        if (!wireDrag) return;
        const node = graph.nodes.find(n=>n.id===wireDrag.node);
        if (!node) return;
        const fixed = point(node,wireDrag.port,wireDrag.output), other = wireDrag.cursor;
        const line = document.createElementNS('http://www.w3.org/2000/svg','path');
        line.setAttribute('class','ef-wire-preview');
        line.setAttribute('d',wireDrag.output?curve(fixed,other):curve(other,fixed));
        line.style.stroke = wireDrag.invalid ? '#e26464' : color(wireDrag.type);
        svg.appendChild(line);
    }
    board.addEventListener('pointerdown',e=>{
        if (busy || e.button !== 0) return;
        const port=e.target.closest('.ef-port');
        if (port) {
            e.preventDefault();
            if (pending && !wireDrag && port.hasAttribute('data-input')) { connect(port.dataset.nodePort,port.dataset.input); return; }
            stopWiring();
            const output=port.hasAttribute('data-output'), node=graph.nodes.find(n=>n.id===port.dataset.nodePort), id=output?port.dataset.output:port.dataset.input, start=coords(e);
            const type=(output?safePorts(node).outputs:safePorts(node).inputs).find(p=>p.id===id)?.type;
            wireDrag={node:node.id,port:id,output,type,start,cursor:start,pointerId:e.pointerId,moved:false};
            if (output) pending={from:node.id,output:id};
            try { board.setPointerCapture(e.pointerId); } catch (_) { /* Synthetic tests have no active pointer. */ }
            port.classList.add('pending');
            nodesEl.querySelectorAll(output?'[data-input]':'[data-output]').forEach(target=>{
                try { M.checkEdge(graph,edgeFor(target),catalog);target.classList.add('ef-compatible'); }
                catch (_) { target.classList.add('ef-incompatible'); }
            });
            message('拖到高亮的兼容端口后松开连接；Esc 取消');drawPreview();return;
        }
        const head=e.target.closest('.ef-node-head');
        if(head){stopWiring();const n=graph.nodes.find(n=>n.id===head.parentElement.dataset.node);selected=n.id;const p=coords(e);drag={n,dx:p.x-n.x,dy:p.y-n.y};board.setPointerCapture(e.pointerId);renderCanvas();inspect()}
    });
    board.addEventListener('pointermove',e=>{
        if(wireDrag){
            const p=coords(e);wireDrag.cursor=p;
            wireDrag.moved ||= Math.hypot(p.x-wireDrag.start.x,p.y-wireDrag.start.y)>4;
            nodesEl.querySelectorAll('.ef-hover').forEach(n=>n.classList.remove('ef-hover'));
            const port=document.elementFromPoint(e.clientX,e.clientY)?.closest('.ef-port'),edge=edgeFor(port);
            wireDrag.invalid=false;
            if(edge){port.classList.add('ef-hover');try{M.checkEdge(graph,edge,catalog);const node=graph.nodes.find(n=>n.id===(wireDrag.output?edge.to:edge.from));wireDrag.cursor=point(node,wireDrag.output?edge.input:edge.output,!wireDrag.output);message('松开鼠标完成连接')}catch(error){wireDrag.invalid=true;message(error.message)}}
            drawPreview();return;
        }
        if(drag){const p=coords(e);drag.n.x=Math.max(0,Math.min(2920,p.x-drag.dx));drag.n.y=Math.max(0,Math.min(2100,p.y-drag.dy));const node=[...nodesEl.children].find(el=>el.dataset.node===drag.n.id);node.style.left=drag.n.x+'px';node.style.top=drag.n.y+'px';drawWires()}
    });
    board.addEventListener('pointerup',e=>{
        if(wireDrag){
            const port=document.elementFromPoint(e.clientX,e.clientY)?.closest('.ef-port'),edge=edgeFor(port),moved=wireDrag.moved,output=wireDrag.output;
            stopWiring(!moved&&output&&!edge);
            if(edge){try{M.checkEdge(graph,edge,catalog);graph.edges.push({id:uid(),...edge});changed();renderCanvas();inspect();message('连接成功')}catch(error){message(error.message)}}
            else message(pending?'点击输入端口完成连接，或再次拖拽输出端口':'已取消连接');
            return;
        }
        if(drag){drag=null;if(board.hasPointerCapture(e.pointerId))board.releasePointerCapture(e.pointerId);changed()}
        const port=e.target.closest('[data-input]');if(port)connect(port.dataset.nodePort,port.dataset.input);
    });
    board.addEventListener('pointercancel',()=>{drag=null;stopWiring()});
    board.addEventListener('lostpointercapture',()=>{if(wireDrag)stopWiring();drag=null});
    window.addEventListener('blur',()=>{drag=null;stopWiring()});

    const workbenchEl=document.getElementById('workbench');
    // 按钮已从 shell toolbar 上移到顶栏 .dwp-actions-flow，事件改绑到 workbench 根（覆盖两处）
    workbenchEl.addEventListener('change',e=>{if(busy)return;const n=graph.nodes.find(n=>n.id===selected);if(e.target.id==='ef-name'){graph.name=e.target.value;changed();return}if(!n)return;if(e.target.matches('[data-field]')){const f=catalog[n.toolId].formFields.find(f=>f.id===e.target.dataset.field);n.values ||= {};n.values[f.id]=f.type==='number'?(e.target.value===''?'':Number(e.target.value)):f.type==='loraMulti'?[...e.target.selectedOptions].filter(o=>o.value).map(o=>Number(o.value)):f.type==='lora'?Number(e.target.value)||null:['boolean','checkbox'].includes(f.type)?e.target.checked:e.target.value}else if(e.target.matches('[data-start-value]'))n.value=e.target.value;else if(e.target.matches('[data-node-name]')){n.name=e.target.value;renderCanvas()}else return;changed()});
    $('#ef-search').addEventListener('input',renderLibrary);
    shell.addEventListener('keydown',e=>{if(e.key==='Escape'){stopWiring();renderCanvas();message('已取消连接')}if((e.key==='Enter'||e.key===' ')&&e.target.matches('.ef-node-head')){selected=e.target.parentElement.dataset.node;inspect();e.preventDefault()}});
    function controls(){shell.classList.toggle('ef-busy',busy);for(const a of ['run','new','import','validate']){const el=flowActions&&flowActions.querySelector(`[data-act="${a}"]`);if(el)el.disabled=busy}const stopBtn=flowActions&&flowActions.querySelector('[data-act="stop"]');if(stopBtn)stopBtn.hidden=!busy}
    async function status(){clearTimeout(poll);try{runState=await call('status');busy=runState.status==='running';controls();renderCanvas();if(busy){const id=Object.keys(runState.nodes).find(id=>runState.nodes[id]==='running');message('正在运行：'+(graph.nodes.find(n=>n.id===id)?title(graph.nodes.find(n=>n.id===id)):'等待队列'))}else if(runState.status!=='idle'){message(({done:'工程运行完成',cancelled:'工程已停止',failed:'运行失败：'+runState.error})[runState.status]);inspect();renderResults()}}catch(e){message('读取运行状态失败：'+e.message)}if(busy)poll=setTimeout(status,1000)}
    function renderResults(){$('#ef-results').innerHTML=(runState.results||[]).length?'<h3>工程结果</h3>'+runState.results.map((r,i)=>`<div class="ef-result"><strong>${M.labels[r.kind]}</strong>${r.kind==='text'?`<pre>${esc(r.text)}</pre>`:`<p>${esc(r.path||'媒体已生成，可在任务历史查看')}</p>${r.queueId?`<button data-preview="${i}">预览结果</button>`:''}`}</div>`).join(''):''}
    workbenchEl.addEventListener('click',async e=>{const b=e.target.closest('button,[data-edge]');if(!b)return;try{
        // 顶栏 data-act 按钮只在这些动作里；其他工作台按钮无 data-act，直接忽略
        if(!b.dataset.act && !b.dataset.input && !b.hasAttribute('data-output') && !b.dataset.add && !b.dataset.edge && !b.dataset.deleteEdge && !b.dataset.pickField && !b.hasAttribute('data-pick-start') && !b.dataset.outNav && b.dataset.preview==null)return;
        if(shell.hidden && b.dataset.preview==null)return; // 工具集模式下不响应编排动作
        // 节点卡片内多产物左右切换
        if(b.dataset.outNav){const nid=b.dataset.node,rec=runState.nodeOutputs&&runState.nodeOutputs[nid];if(rec&&rec.artifacts.length){const cur=nodeOutIdx.get(nid)||0,dir=b.dataset.outNav==='next'?1:-1;nodeOutIdx.set(nid,(cur+dir+rec.artifacts.length)%rec.artifacts.length);renderCanvas()}return}
        if(b.dataset.input){connect(b.dataset.nodePort,b.dataset.input);return}if(b.hasAttribute('data-output'))return;
        if(b.dataset.add){const vp=$('.ef-viewport');add(b.dataset.add,60+vp.scrollLeft/zoom+(graph.nodes.length%3)*265,70+vp.scrollTop/zoom+Math.floor(graph.nodes.length%6/3)*250);return}
        if(b.dataset.edge){selected=b.dataset.edge;drawWires();inspect();return}
        if(b.dataset.deleteEdge&&!busy){graph.edges=graph.edges.filter(x=>x.id!==b.dataset.deleteEdge);changed();renderCanvas();inspect();return}
        const n=graph.nodes.find(n=>n.id===selected);
        if((b.hasAttribute('data-pick-start')||b.dataset.pickField)&&!busy){const kind=b.dataset.kind||n.dataType,value=await call('pick',kind);if(value){if(b.dataset.pickField)n.values[b.dataset.pickField]=value;else n.value=value;changed();inspect()}return}
        if(b.dataset.preview!=null){b.disabled=true;const r=await window.api.taskQueue.resultReadAsDataUrl(runState.results[Number(b.dataset.preview)].queueId);if(!r.ok)throw Error(r.error);const host=b.parentElement,el=document.createElement(runState.results[Number(b.dataset.preview)].kind==='video'?'video':'img');el.src=r.dataUrl;if(el.tagName==='VIDEO')el.controls=true;host.appendChild(el);b.remove();return}
        switch(b.dataset.act){
            case 'save':await save();break;
            case 'new':if(busy)break;if(dirty)await save();graph={version:1,name:'新工程',nodes:[],edges:[]};selected=null;runState={nodes:{},results:[]};$('#ef-name').value=graph.name;changed();renderCanvas();inspect();renderResults();break;
            case 'delete':if(busy)break;graph.nodes=graph.nodes.filter(n=>n.id!==selected);graph.edges=graph.edges.filter(e=>e.id!==selected&&e.from!==selected&&e.to!==selected);selected=null;changed();renderCanvas();inspect();break;
            case 'validate':M.validate(graph,catalog);message('检查通过，可以运行');break;
            case 'run':if(busy)break;M.validate(graph,catalog);busy=true;controls();inspect();await save();await call('run',graph);await status();break;
            case 'stop':await call('cancel');message('正在停止当前任务…');await status();break;
            case 'zoom-in':case 'zoom-out':zoom=Math.max(.5,Math.min(1.5,zoom+(b.dataset.act==='zoom-in'?.1:-.1)));board.style.zoom=zoom;$('#ef-zoom').textContent=Math.round(zoom*100)+'%';break;
            case 'export':{const blob=new Blob([JSON.stringify(graph,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=(graph.name||'工程')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break}
            case 'import':{if(busy)break;const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return;if(file.size>2000000)throw Error('工程文件过大');const g=JSON.parse(await file.text());if(g.version!==1||!Array.isArray(g.nodes)||!Array.isArray(g.edges)||g.nodes.length>100||g.edges.length>500)throw Error('不是有效的工程文件');for(const n of g.nodes){n.x=Math.max(0,Math.min(2920,Number(n.x)||0));n.y=Math.max(0,Math.min(2100,Number(n.y)||0));n.values ||= {}}if(dirty)await save();graph=g;selected=null;$('#ef-name').value=g.name||'导入工程';changed();renderCanvas();inspect()}catch(error){message(error.message)}};input.click();break}
        }
    }catch(error){if(b.dataset.act==='run'){busy=false;controls();inspect()}message(error.message)}});
    // 进入工程编排视图时懒加载一次
    async function enterFlow(){message('正在加载工作流…');try{if(!loaded){
        const list=await window.api.tools.list();if(!list.ok)throw Error(list.error);
        const details=await Promise.all(list.tools.map(t=>window.api.tools.get(t.id)));
        catalog=Object.fromEntries(details.filter(r=>r.ok).map(r=>[r.tool.id,r.tool]));
        const lr=await window.api.loras?.list({limit:10000});loras=lr?.loras||[];
        let saved=await call('load');
        try{const draft=localStorage.getItem('engineeringFlow.draft');if(draft){saved=JSON.parse(draft);dirty=true}}catch{}
        if(saved){graph=saved;const nameEl=document.getElementById('ef-name');if(nameEl)nameEl.value=graph.name||'我的工程'}
        loaded=true}
        renderLibrary();renderCanvas();inspect();await status();
        if(runState.status==='idle')message(dirty?'已恢复未保存草稿':'拖入节点开始编排')
    }catch(e){message(e.message)}}

    // Tab 点击 → 视图切换
    const tabTools=document.getElementById('dwpTabTools'),tabFlow=document.getElementById('dwpTabFlow');
    if(tabTools)tabTools.addEventListener('click',()=>switchView('tools'));
    if(tabFlow)tabFlow.addEventListener('click',()=>switchView('flow'));
    // 默认工具集视图
    switchView('tools');
    window.addEventListener('workbench:closed',()=>{stopWiring();stopPan(true);switchView('tools')});
})();
