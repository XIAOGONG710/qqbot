// Synthetic correctness probe: a confirmed CLI deletion survives an older refresh.
// Uses only a temporary meme file, fake model and the real CLI with explicit --dir.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refreshMemes, loadMemes, saveMemes, memesPath } from '../../../packages/bot/src/language/memes.ts';
const dir = mkdtempSync(join(tmpdir(), 'qqbot-meme-author-race-')), path = memesPath(dir), now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const term = '合成喵梗'; let release, entered = false;
const held = new Promise(done => { release = done; });
let task;
try {
 saveMemes(path, { version:1, entries:[{term, meaning:'这是合成的测试意思', example:'合成示例', confidence:'high',firstSeen:day,lastSeen:day,seen:1}] });
 task = refreshMemes({path,now:()=>now,log(){},fetchLists:async()=>({popular:[],hot:[term],weibo:[],baidu:[]}),ask:async()=>{entered=true;return held;},gather:async()=>[]});
 while(!entered)await new Promise(done=>setImmediate(done));
 const cli = spawnSync(process.execPath,[fileURLToPath(new URL('../../../packages/bot/src/ops/meme-cli.ts', import.meta.url)),'remove',term,'--dir',dir],{encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr); const afterRemove = loadMemes(path).entries.length; assert.equal(afterRemove,0);
 release(JSON.stringify([term])); await task;
 const afterRefresh=loadMemes(path).entries.map(entry=>entry.term);
 assert.equal(afterRefresh.includes(term),false,'旧后台刷新不能复活作者已删除条目');
 console.log(JSON.stringify({cliRemoved:afterRemove===0,afterRefresh,authorRemovalPreserved:true}));
} finally {
 release?.('[]'); await task;
 assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('qqbot-meme-author-race-'));rmSync(dir,{recursive:true,force:true});
}
