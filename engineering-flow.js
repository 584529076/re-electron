'use strict';
const fs=require('fs'),fsp=fs.promises,path=require('path'),{randomUUID}=require('crypto'),{fileURLToPath}=require('url');
const {FlowEngine}=require('./lib/flow-engine');
function registerEngineeringFlow({ipcMain,getWindow,app,dialog,catalog,enqueue,row,cancel,getConfig,resolveResult}) {
    const extensions={image:['png','jpg','jpeg','webp','gif','bmp'],video:['mp4','webm','mov','mkv','avi','m4v']};
    async function stage(data) {
        const dir=getConfig()?.comfyDir;
        if(!dir)throw Error('请先在设置中配置 ComfyUI 目录');
        const input=path.join(dir,'input'); await fsp.mkdir(input,{recursive:true});
        const raw=String(data.value || ''); let ext,bytes,src;
        if(raw.startsWith('data:')) {
            const match=raw.match(/^data:(image|video)\/([\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
            if(!match || match[1]!==data.kind)throw Error('媒体数据类型不匹配');
            ext=({jpeg:'jpg','x-matroska':'mkv',quicktime:'mov'})[match[2]] || match[2];bytes=Buffer.from(match[3],'base64');
        } else {
            src=raw.startsWith('file:')?fileURLToPath(raw):path.isAbsolute(raw)?raw:path.join(input,raw);
            ext=path.extname(src).slice(1).toLowerCase();
            if(!(await fsp.stat(src)).isFile())throw Error('媒体输入不是文件');
        }
        if(!extensions[data.kind]?.includes(ext))throw Error('输入文件与节点媒体类型不匹配');
        const name=`flow-${randomUUID()}.${ext}`,destination=path.join(input,name);
        if(bytes)await fsp.writeFile(destination,bytes,{flag:'wx'});else await fsp.copyFile(src,destination,fs.constants.COPYFILE_EXCL);
        return name;
    }
    const engine=new FlowEngine({catalog,enqueue,row,cancel,stage,result:async item=>{
        const mime=item.result_mime || '';
        // 收集节点的全部产物（含多产物）—— 用于节点卡片内回显
        const artifacts=[];
        let items=[];
        try{items=JSON.parse(item.result_items||'[]')}catch{}
        const srcOf=raw=>{
            if(!raw)return null;
            if(typeof raw==='string'&&raw.startsWith('data:'))return raw;
            try{return 'file:///'+resolveResult(raw).replace(/\\/g,'/')}catch{return null}
        };
        for(const it of items){
            if(it.kind==='text'||it.text!=null){artifacts.push({kind:'text',text:it.text||'',mime:it.mime||'text/plain',filename:it.filename||''});continue}
            const raw=it.relPath||it.path;
            artifacts.push({kind:it.kind||'image',src:it.inlineDataUrl||srcOf(raw),mime:it.mime||'image/png',filename:it.filename||'',size:it.size||0});
        }
        // 文本类工作流
        if(mime.startsWith('text/') || item.result_text != null){
            const t=item.result_text||'';
            if(!artifacts.length)artifacts.push({kind:'text',text:t,mime:mime||'text/plain'});
            return {kind:'text',value:t,artifacts,queueId:item.queue_id};
        }
        // 兜底：只有 result_path 的老任务
        if(!artifacts.length){
            const value=item.result_path;
            const kind=mime.startsWith('video/')?'video':mime.startsWith('image/')?'image':/^data:video\//.test(value)?'video':/^data:image\//.test(value)?'image':null;
            if(!kind)throw Error('无法识别工作流输出类型');
            artifacts.push({kind,src:srcOf(value),mime:mime||'image/png'});
        }
        return {kind:artifacts[0].kind,value:artifacts[0].src||'',artifacts,queueId:item.queue_id};
    }});
    const handler=(name,fn)=>ipcMain.handle(`engineeringFlow:${name}`,async(event,...args)=>{
        if(event.sender!==getWindow()?.webContents || event.senderFrame!==event.sender.mainFrame)return {ok:false,error:'无权访问工程编排'};
        try{return {ok:true,data:await fn(...args)}}catch(error){return {ok:false,error:error.message}}
    });
    const projectPath=()=>path.join(app.getPath('userData'),'engineering-flow.json');
    handler('load',async()=>{try{return JSON.parse(await fsp.readFile(projectPath(),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}});
    handler('save',async graph=>{
        const text=JSON.stringify(graph);if(text.length>2000000 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length>100 || graph.edges.length>500)throw Error('工程格式无效或过大');
        const destination=projectPath(),temp=destination+'.'+randomUUID()+'.tmp';await fsp.writeFile(temp,text,{flag:'wx'});try{await fsp.rename(temp,destination)}finally{await fsp.unlink(temp).catch(()=>{})}return true;
    });
    handler('run',graph=>engine.start(graph));handler('status',()=>engine.state);handler('cancel',()=>engine.cancel());
    handler('pick',async kind=>{if(!extensions[kind])throw Error('媒体类型无效');const result=await dialog.showOpenDialog(getWindow(),{title:kind==='image'?'选择输入图片':'选择输入视频',properties:['openFile'],filters:[{name:kind==='image'?'图片':'视频',extensions:extensions[kind]}]});return result.canceled?null:result.filePaths[0]});
    return engine;
}
module.exports={registerEngineeringFlow};
