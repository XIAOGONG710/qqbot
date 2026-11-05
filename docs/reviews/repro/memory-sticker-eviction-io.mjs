// Synthetic correctness probe: failed index publication preserves the old image.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { stickerShelf } from '../../../packages/bot/src/social/stickers.ts';
import { fileOps } from '../../../packages/bot/src/memory/json-file.ts';
const root=mkdtempSync(join(tmpdir(),'qqbot-sticker-eviction-')), path=join(root,'index.json');
const oldBytes=new Uint8Array([137,80,78,71,13,10,26,10,1]), newer=new Uint8Array([137,80,78,71,13,10,26,10,2]);
const id=createHash('sha256').update(oldBytes).digest('hex').slice(0,12), image=join(root,`${id}.png`);
const originalWrite=fileOps.writeFileSync, delays=fileOps.writeDelaysMs;
try {
 writeFileSync(image,oldBytes);
 writeFileSync(path,JSON.stringify({version:1,entries:[{id,file:`${id}.png`,description:'合成旧收藏',tags:[],source:{kind:'inbox',name:'synthetic.png'},createdAt:'2026-11-05T00:00:00Z',used:0}],seen:[]}));
 const before=readFileSync(path,'utf8');
 const shelf=stickerShelf({dir:root,libraryMax:1,log(){},download:async()=>({bytes:newer,type:'image/png'}),describe:async()=> '合成新收藏',decide:async description=>({keep:true,description,tags:[]})});
 fileOps.writeDelaysMs=[0];
 fileOps.writeFileSync=(target,...args)=>{if(String(target).startsWith(`${path}.tmp-`))throw Object.assign(Error('synthetic index failure'),{code:'EROFS'});return originalWrite(target,...args);};
 await shelf.consider([{type:'image',data:{url:'https://synthetic.invalid/new.png',sub_type:1}}],{from:10001,messageId:1});
 assert.equal(readFileSync(path,'utf8'),before);
 assert.equal(existsSync(image),true);
 assert.equal(JSON.parse(readFileSync(path,'utf8')).entries[0].id,id);
 console.log(JSON.stringify({indexUnchanged:readFileSync(path,'utf8')===before,committedOldImageStillExists:existsSync(image),oldEntryStillCommitted:JSON.parse(readFileSync(path,'utf8')).entries[0].id===id}));
}finally{
 fileOps.writeFileSync=originalWrite;fileOps.writeDelaysMs=delays;
 assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('qqbot-sticker-eviction-'));rmSync(root,{recursive:true,force:true});
}
