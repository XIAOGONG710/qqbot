// Synthetic correct-behavior probe, backed by separate formal regression tests.
// `held`: A must produce storedJokes=0 / promptHasOrigin=false after the in-flight source guard fix.
// `completed-restart`: B preserves the original file, but the invalid origin must not enter a prompt.
// A phrase surviving elsewhere does not establish the provenance of the separately generated origin.
// No real card, runtime, network, QQ, model service, or database is accessed. Exit 0 requires both assertions.
import assert from 'node:assert/strict';import { mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join,resolve,dirname,basename } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';import { jokeLine } from '../../../packages/bot/src/language/jokes.ts';
const now=Date.parse('2026-11-05T12:00:00+08:00'),phrase='星云土豆',origin='合成被撤回的来历';const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('unexpected synthetic network request');};
const tick=()=>new Promise(done=>setImmediate(done));async function until(check){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'synthetic prompt timeout');await new Promise(done=>setTimeout(done,5));}}
async function run(mode){
 const root=mkdtempSync(join(tmpdir(),'qqbot-app-jokes-revision-')),dataDir=join(root,'data');mkdirSync(dataDir);let app,release,extracts=0,prompts=[],sends=0;const held=new Promise(done=>release=done),logs=[];
 try{
  for(const tier of ['boyfriend','boyfriend-open'])writeFileSync(join(root,`synthetic-${tier}.json`),JSON.stringify({spec:'chara_card_v2',data:{name:'合成角色'}}));
  const config=parseAppConfig({llm:{baseUrl:'http://synthetic.invalid',model:'synthetic'},characterCard:join(root,'synthetic-{tier}.json'),dataDir,contacts:[{qq:10001,tier:'boyfriend',name:'合成联系人'}],jokes:true,recalls:true,idioms:false,schedule:false,moody:false,speechCheck:false,herDays:false,realWeather:false,proactive:'off',media:false},root,{QQBOT_LLM_API_KEY:'synthetic-key'});
  const h=new ChatHistory(dataDir);for(let i=0;i<42;i++)h.append(10001,{role:'user',content:i===0?`${phrase} ${origin}`:i< (mode==='held'?2:3)?phrase:`合成其他对话${i}`,time:new Date(now-3*86400000+i*1000).toISOString(),messageId:i+1});
  const make=()=>startApp({config,log:line=>logs.push(line),sensitive:{on:()=>false,describe:()=>''},transport:{friendHistory:async()=>[],sendPrivateText:async()=>{sends++;return 900+sends;}},pipeline:{now:()=>now,settle:{quietMs:0,maxMs:0},generate:async messages=>{if(messages[0]?.content.includes('小梗')){extracts++;return mode==='held'?held:JSON.stringify([{梗:phrase,来历:origin}]);}prompts.push(messages);return '合成回应';}}});
  app=make();await app.connected(20000);await until(()=>extracts===1);
  const file=join(dataDir,'jokes','10001.json');if(mode!=='held')await until(()=>existsSync(file));const confirmedBytes=mode!=='held'?readFileSync(file,'utf8'):undefined;
  const ids=mode==='held'?[1,2]:[1];for(const message_id of ids)app.receiveRecall({post_type:'notice',notice_type:'friend_recall',self_id:20000,user_id:10001,message_id});
  const fresh=new ChatHistory(dataDir).load(10001);assert.equal(fresh.length,42);assert.ok(!fresh.some(m=>m.content.includes(origin)));if(mode==='held')assert.ok(!fresh.some(m=>m.content.includes(phrase)));
  release(JSON.stringify([{梗:phrase,来历:origin}]));for(let i=0;i<8;i++)await tick();
  if(mode!=='held'){await app.stop();app=make();await app.connected(20000);assert.equal(extracts,1,'restart cooldown did not re-extract');}
  const stored=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{jokes:[]};let content;for(let n=0;n<200;n++){const text=`合成现在问候${n}`;if(jokeLine([{phrase,origin}],[...fresh,{role:'user',content:text,time:new Date(now).toISOString()}],now)){content=text;break;}}assert.ok(content);
  app.receive({post_type:'message',message_type:'private',sub_type:'friend',self_id:20000,user_id:10001,message_id:800,real_seq:'8000001',time:now/1000,raw_message:'',sender:{user_id:10001},message:[{type:'text',data:{text:content}}]});
  await until(()=>prompts.length>0);const promptHasOrigin=prompts.some(p=>p.some(m=>m.content.includes(origin)));assert.equal(promptHasOrigin,false,'withdrawn origin must not reach the model');
  if(mode==='held')assert.equal(stored.jokes.length,0,'stale in-flight body must not commit');else{assert.equal(stored.jokes.length,1);assert.equal(readFileSync(file,'utf8'),confirmedBytes,'read guard must preserve original recovery material');}
  console.log(JSON.stringify({mode,sourceLength:fresh.length,recalled:ids.length,storedJokes:stored.jokes.length,freshHasOrigin:fresh.some(m=>m.content.includes(origin)),promptHasOrigin,promptHasJoke:prompts.some(p=>p.some(m=>m.content.includes('你们之间有个小梗'))),extracts}));
 }finally{release('[]');await app?.stop();for(let i=0;i<8;i++)await tick();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('qqbot-app-jokes-revision-'));rmSync(root,{recursive:true,force:true});}
}
try{await run('held');await run('completed-restart');}finally{globalThis.fetch=oldFetch;}
