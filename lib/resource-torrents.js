'use strict';
const fs=require('fs/promises'),path=require('path'),{randomUUID}=require('crypto');
function normalizeTorrentUrl(value){const text=String(value??'').trim();if(!text)return '';if(text.length>8000)throw new Error('种子地址过长');let url;try{url=new URL(text)}catch{throw new Error('请填写有效的种子地址')}if(!['https:','http:','magnet:'].includes(url.protocol)||url.username||url.password)throw new Error('种子地址仅支持 HTTP(S) 或 magnet 链接');if(url.protocol==='magnet:'&&!url.searchParams.get('xt'))throw new Error('磁力链接缺少 xt 参数');return url.href;}
class TorrentFiles {
    constructor(store){this.store=store;this.directory=path.join(path.dirname(store.path),'resource-torrents');store.exec('CREATE TABLE IF NOT EXISTS resource_torrents(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL)');}
    get(id){const row=this.store.query('SELECT * FROM resource_torrents WHERE id=?',String(id))[0];if(!row)throw new Error('种子附件不存在');return row;}
    resolve(items=[]){if(!Array.isArray(items)||items.length>20)throw new Error('每部作品最多保存 20 个种子附件');return [...new Set(items.map(item=>typeof item==='string'?item:item.id))].map(id=>{const row=this.get(id);return{id:row.id,name:row.name,size:row.size}});}
    async upload(filename){if(path.extname(filename).toLowerCase()!=='.torrent')throw new Error('请选择 .torrent 文件');const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>8*1024*1024)throw new Error('种子文件不能超过 8 MB');const bytes=await fs.readFile(filename);await fs.mkdir(this.directory,{recursive:true});const id=randomUUID(),destination=path.join(this.directory,`${id}.torrent`);await fs.writeFile(destination,bytes,{flag:'wx'});try{this.store.exec('INSERT INTO resource_torrents(id,name,path,size) VALUES(?,?,?,?)',id,path.basename(filename),destination,bytes.length);}catch(error){await fs.unlink(destination).catch(()=>{});throw error;}return{id,name:path.basename(filename),size:bytes.length};}
    async export(id,destination){const row=this.get(id);if(path.resolve(destination)===path.resolve(row.path))return;await fs.copyFile(row.path,destination);}
}
module.exports={TorrentFiles,normalizeTorrentUrl};
