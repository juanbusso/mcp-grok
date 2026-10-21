import {mkdirSync,readFileSync,writeFileSync,rmdirSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
const file = new URL('./quota-state.json', import.meta.url);
const lock = new URL('./quota-state.lock', import.meta.url);
export function reserveGrokCall(prompt) {
  mkdirSync(lock); // Cross-process lock; fail closed on contention.
  try {
    let entries=[];
    try { entries=JSON.parse(readFileSync(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
    const now=Date.now(); entries=entries.filter(e=>now-e.time<3600000);
    const hash=createHash('sha256').update(String(prompt).trim()).digest('hex');
    if(entries.length>=6) throw Error('Grok hard cap: 6 calls per rolling hour');
    if(entries.some(e=>e.hash===hash)) throw Error('Grok duplicate blocked for one hour');
    if(entries.some(e=>now-e.time<60000)) throw Error('Grok backoff: wait 60 seconds between calls');
    entries.push({time:now,hash});
    const tmp=new URL('./quota-state.tmp',import.meta.url);
    writeFileSync(tmp,JSON.stringify(entries),{mode:0o600}); renameSync(tmp,file);
  } finally { rmdirSync(lock); }
}
