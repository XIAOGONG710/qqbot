// Diagnostic of currently unresolved behavior; exit 0 is NOT a correctness regression. Synthetic data only.
import assert from 'node:assert/strict';
process.env.TZ='Pacific/Apia';
const {lastTouched,clarity}=await import('../../../packages/bot/src/memory/fading.ts');
const {localDate}=await import('../../../packages/bot/src/local-date.ts');
const f={id:'synthetic',text:'SYNTHETIC_CIVIL_MEMORY',document_id:'diary:2011-12-30'};
const t=lastTouched(f), actual=clarity(f,{now:localDate(2012,0,7,12),heard:'',ignore:[]});
assert.equal(t.getDate(),31); assert.equal(actual,'clear');
console.log(JSON.stringify({document:f.document_id,observedLocalDate:[t.getFullYear(),t.getMonth()+1,t.getDate()],daysByDocument:8,expected:'vague',actual}));
const phase={...f,document_id:'phase:synthetic:2011-12-30'};
assert.equal(clarity(phase,{now:localDate(2012,0,14,12),heard:'',ignore:[]}),'clear');
console.log(JSON.stringify({document:phase.document_id,daysByDocument:15,expected:'vague',actual:'clear'}));
