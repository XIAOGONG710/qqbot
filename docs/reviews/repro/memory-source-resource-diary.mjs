// Synthetic measurement probe, not a correctness regression or production SLA. No external services.
import assert from 'node:assert/strict';import crypto from 'node:crypto';import{syncBuiltinESMExports}from'node:module';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{join,dirname,resolve,basename}from'node:path';import{tmpdir}from'node:os';
import{diaryWriter,diaryMaterial,diaryMessages}from'../../../packages/bot/src/life/diary.ts';import{fileOps}from'../../../packages/bot/src/memory/json-file.ts';
const hash=(value)=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const schedule={sleep:'02:00',wake:{early:'07:00',lazy:'09:00',earlySlot:'1'},periods:{1:{start:'08:00',end:'09:30'}},semester:{start:'2016-01-01',weeks:600},holidays:[],makeups:[],kinds:{hard:{},machine:{},water:{},pe:{}},courses:[],free:{morning:['Synthetic rest'],afternoon:['Synthetic rest'],evening:['Synthetic rest'],afternoonFrom:'12:00',eveningFrom:'18:00'},where:'Synthetic'};
const sources={charName:'Synthetic Character',schedule,moods:[],books:[]},contact={qq:10001,tier:'classmate',name:'Synthetic Contact'};
const originalHash=crypto.createHash,originalRead=fileOps.readFileSync,metrics=[];
for(const[n,m]of[[30,0],[365,0],[365,50000]]){
 const root=mkdtempSync(join(tmpdir(),'qqbot-source-resource-'));let writer;
 try{
  const written={},texts={},confirmed={},body='SYNTHETIC_DIARY_BODY';
  for(let i=0;i<n;i++){
   const day=new Date(2016,0,1+i),date=[day.getFullYear(),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0')].join('-');
   const material=diaryMaterial(sources,day,[{name:contact.name,messages:[]}],[]),messages=diaryMessages(sources.charName,day,material);
   const manifest={version:1,kind:'diary',contextHash:hash({sources,date,plans:[]}),materialHash:hash(material),promptHash:hash(messages),contributors:[{qq:contact.qq,tier:contact.tier,sinceKnown:true,messages:[]}]};
   confirmed['diary:'+date]={operationId:crypto.randomUUID(),bodyHash:hash(body),sourceHash:hash(manifest),manifest,sourceVerified:true};written[date]=body.length;texts[date]=body;
  }
  const path=join(root,'diary.json'),state=JSON.stringify({version:1,written,texts,weeks:{},phases:{},prepared:{},confirmed});writeFileSync(path,state);
  const rows=Array.from({length:m},(_,i)=>({role:'user',content:'SYNTHETIC_UNUSED_OLD_ROW',time:new Date(Date.UTC(2000,0,1,12,0,i%60)).toISOString(),messageId:i+1}));
  let loads=0,sinces=0,plans=0;writer=diaryWriter({sources,contacts:[contact],history:{load:()=>{loads++;return rows}},sourceSince:()=>{sinces++;return undefined},plans:()=>{plans++;return[]},memory:{derivedAvailable:()=>true,noteWrittenSourceChanged:()=>assert.fail('unexpected dirty')},dir:root,generate:async()=>assert.fail('unexpected model'),log(){}});
  assert.equal(writer.verifySources(new Date(2026,10,5,12)),true);loads=0;sinces=0;plans=0;
  let hashCalls=0,readCalls=0,readBytes=0;crypto.createHash=(...args)=>{hashCalls++;return originalHash(...args)};syncBuiltinESMExports();
  fileOps.readFileSync=(...args)=>{const value=originalRead(...args);if(String(args[0])===path){readCalls++;readBytes+=Buffer.byteLength(value)}return value};
  const timerStart=performance.now();let delayed;const timer=new Promise(done=>setTimeout(()=>{delayed=performance.now()-timerStart;done()},0));
  const started=performance.now();for(let i=0;i<3;i++)assert.equal(writer.verifySources(new Date(2026,10,5,12)),true);const elapsed=performance.now()-started;await timer;
  metrics.push({receipts:n,unrelatedHistoricalRows:m,reads:3,loads,sinces,materialPlans:plans,hashCalls,fileBytes:Buffer.byteLength(state),readCalls,readBytes,syncMs:+elapsed.toFixed(2),timerDelayMs:+delayed.toFixed(2)});
 }finally{await writer?.stop();crypto.createHash=originalHash;syncBuiltinESMExports();fileOps.readFileSync=originalRead;assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('qqbot-source-resource-'));rmSync(root,{recursive:true,force:true})}
}
process.stdout.write(JSON.stringify({diary:metrics})+'\n');