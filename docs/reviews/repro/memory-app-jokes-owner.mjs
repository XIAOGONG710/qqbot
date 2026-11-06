import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join,resolve,dirname,basename } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';
const root=mkdtempSync(join(tmpdir(),'qqbot-app-jokes-owner-')),dataDir=join(root,'data');mkdirSync(dataDir);
let app,release,entered=0;const logs=[],held=new Promise(done=>release=done),oldFetch=globalThis.fetch;const now=Date.parse('2026-11-05T12:00:00+08:00');
try{
 for(const tier of ['boyfriend','boyfriend-open'])writeFileSync(join(root,`synthetic-${tier}.json`),JSON.stringify({spec:'chara_card_v2',data:{name:'合成角色'}}));
 const config=parseAppConfig({llm:{baseUrl:'http://synthetic.invalid',model:'synthetic'},characterCard:join(root,'synthetic-{tier}.json'),dataDir,contacts:[{qq:10001,tier:'boyfriend',name:'合成联系人'}],jokes:true,idioms:false,schedule:false,moody:false,speechCheck:false,herDays:false,realWeather:false,proactive:'off',media:false},root,{QQBOT_LLM_API_KEY:'synthetic-key'});
 const history=new ChatHistory(dataDir);for(let i=0;i<42;i++)history.append(10001,{role:i%2?'assistant':'user',content:`星云土豆 合成对话${i}`,time:new Date(now-(42-i)*1000).toISOString(),messageId:i+1});
 globalThis.fetch=async()=>{throw Error('unexpected synthetic network request');};
 app=startApp({config,log:line=>logs.push(line),sensitive:{on:()=>false,describe:()=>''},transport:{friendHistory:async()=>[],sendPrivateText:async()=>1},pipeline:{now:()=>now,generate:async messages=>{if(messages[0]?.content.includes('小梗')){entered++;return held;}return '合成回应';}}});
 await app.connected(20000);await new Promise(done=>setImmediate(done));assert.equal(entered,1);const file=join(dataDir,'jokes','10001.json');assert.equal(existsSync(file),false);
 await app.stop();const before=logs.length;assert.equal(existsSync(join(dataDir,'bot.lock')),false);release('[{"梗":"星云土豆","来历":"合成聊天玩笑"}]');for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));
 assert.equal(existsSync(file),false,'stopped joke extraction cannot save after the lease is released');assert.deepEqual(logs.slice(before),[]);
 console.log(JSON.stringify({correctnessProbe:true,entered,lockReleased:true,lateFileExists:false,lateLogs:logs.slice(before)}));
}finally{release?.('[]');await app?.stop();for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));globalThis.fetch=oldFetch;assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('qqbot-app-jokes-owner-'));rmSync(root,{recursive:true,force:true});}
