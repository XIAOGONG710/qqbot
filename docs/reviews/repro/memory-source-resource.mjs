// Synthetic measurement probe, not a correctness regression or production SLA. No external services.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { WrittenRetainStore, writtenRequestHash } from '../../../packages/bot/src/memory/written-retain.ts';
import { fileOps } from '../../../packages/bot/src/memory/json-file.ts';
const originalHash=crypto.createHash, originalRead=fileOps.readFileSync;
const metrics=[];
for(const n of [30,365,3650]){
 const root=mkdtempSync(join(tmpdir(),'qqbot-source-resource-'));
 try{
  const operations={},current={},bank='synthetic-common';
  for(let i=0;i<n;i++){
   const operationId=crypto.randomUUID(),date=new Date(Date.UTC(2016,0,1+i)).toISOString().slice(0,10),documentId='diary:'+date;
   const item={content:'SYNTHETIC_BODY_'+('x'.repeat(2000)),timestamp:date+'T22:00:00+08:00',context:'Synthetic',document_id:documentId,tags:['diary'],metadata:{source:'diary'},entities:[{text:'Synthetic',type:'PERSON'}]};
   operations[operationId]={bankId:bank,documentId,operationId,requestHash:writtenRequestHash(item),item,phase:'completed'};
   current[crypto.createHash('sha256').update(JSON.stringify([bank,documentId])).digest('hex')]=operationId;
  }
  const path=join(root,'written-retain.json'),body=JSON.stringify({version:1,operations,current,blockedBanks:{}});writeFileSync(path,body);writeFileSync(join(root,'written-retain.initialized'),'');
  const store=new WrittenRetainStore(root);assert.deepEqual(store.blockedDocuments(bank),[]);
  let hashCalls=0,readCalls=0,readBytes=0;
  crypto.createHash=(...args)=>{hashCalls++;return originalHash(...args)};syncBuiltinESMExports();
  fileOps.readFileSync=(...args)=>{const result=originalRead(...args);if(String(args[0])===path){readCalls++;readBytes+=Buffer.byteLength(result)}return result};
  const timerStart=performance.now();let delayed;const timer=new Promise(done=>setTimeout(()=>{delayed=performance.now()-timerStart;done()},0));
  const start=performance.now();for(let i=0;i<3;i++)assert.deepEqual(store.blockedDocuments(bank),[]);const elapsed=performance.now()-start;await timer;
  metrics.push({operations:n,fileBytes:Buffer.byteLength(body),reads:3,readCalls,readBytes,hashCalls,syncMs:+elapsed.toFixed(2),timerDelayMs:+delayed.toFixed(2)});
 }finally{crypto.createHash=originalHash;syncBuiltinESMExports();fileOps.readFileSync=originalRead;assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('qqbot-source-resource-'));rmSync(root,{recursive:true,force:true})}
}
process.stdout.write(JSON.stringify({outbox:metrics})+'\n');