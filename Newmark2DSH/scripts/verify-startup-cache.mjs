import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryLabStore } from '../packages/newmark-core/components/memorylab/lib/memory-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-startup-cache-'));
try {
  const store=new MemoryLabStore(root);
  store.ensureLayout();
  const normalize=store.normalizeIndex.bind(store);
  let calls=0;
  store.normalizeIndex=(...args)=>{calls++;return normalize(...args);};
  const original=fs.readFileSync(store.indexPath,'utf8');
  const first=store.loadIndex();
  const expected=structuredClone(first);
  first.index.components.push({slug:'must-not-leak'});
  first.warnings.push('must-not-leak');
  assert.deepEqual(store.loadIndex(),expected);
  assert.equal(calls,1);
  assert.equal(fs.readFileSync(store.indexPath,'utf8'),original);
  const next=JSON.parse(original);next.preferredLanguage='en';
  fs.writeFileSync(store.indexPath,JSON.stringify(next));store.loadIndex();
  const prior=fs.statSync(store.indexPath);
  next.preferredLanguage='zh';
  fs.writeFileSync(store.indexPath,JSON.stringify(next));
  fs.utimesSync(store.indexPath,prior.atime,prior.mtime);
  const changed=store.loadIndex();
  assert.equal(changed.index.preferredLanguage,'zh');
  assert.equal(calls,3);
  fs.writeFileSync(store.indexPath,'{invalid');
  assert.equal(store.loadIndex().ok,false);
  fs.unlinkSync(store.indexPath);
  assert.equal(store.loadIndex().status,'missing');
  console.log('Startup cache: 7/7 passed; no aliasing, no writes, exact-byte invalidation, malformed and removed index.');
} finally {
  assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()),'newmark-startup-cache-')));
  fs.rmSync(root,{recursive:true,force:true});
}
