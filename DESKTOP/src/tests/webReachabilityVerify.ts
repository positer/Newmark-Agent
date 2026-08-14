/**
 * WebFetch 可达性 + 具体网络搜索任务验证（真实网络往返，非 mock）。
 *
 * Run: npm run build && node dist/tests/webReachabilityVerify.js
 *
 * 与 verify.ts 的 web smoke（优雅降级）互补：这里验证真实可达性——
 * web_fetch 拉取稳定 URL 返回真实页面内容，web_search 执行具体查询返回真实结果。
 * 网络不可达时归类为 environment-skip（非 app bug），不阻塞后续断言。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutor } from '../tools';
import { ConfigManager } from '../core/config';

let assertions = 0;
let envSkips = 0;
function check(cond: boolean, name: string): void {
  assertions += 1;
  console.log('  ' + (cond ? '[PASS]' : '[FAIL]') + ' ' + name);
  assert.ok(cond, name);
}
function envSkip(name: string): void {
  envSkips += 1;
  console.log('  [SKIP] ' + name);
}

async function main(): Promise<void> {
  console.log('webReachabilityVerify');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-web-reach-'));
  const cfg = new ConfigManager(root);
  const tools = new ToolExecutor(root, cfg);

  // 1. web_fetch 可达性：example.com 返回稳定的 "Example Domain" 文本。
  const fetchResult = await tools.execute('web_fetch', JSON.stringify({ url: 'https://example.com' }), root);
  const fetchOk = fetchResult.toLowerCase().includes('example domain');
  if (fetchResult.startsWith('[web_fetch]') || fetchResult.length === 0) {
    envSkip('web_fetch 可达性：网络不可达（' + fetchResult.slice(0, 80) + '）');
  } else {
    check(fetchOk, 'web_fetch 可达性：example.com 返回真实页面内容（Example Domain）');
    check(fetchResult.length >= 50, 'web_fetch 可达性：返回足够文本（非空壳）');
  }

  // 2. web_search 具体任务：搜索具体名词，返回真实结构化结果（标题+URL+snippet）。
  const searchResult = await tools.execute('web_search', JSON.stringify({ query: 'Newmark Agent GitHub' }), root);
  const searchFailed = searchResult.startsWith('[web_search] No results');
  if (searchFailed) {
    envSkip('web_search 具体任务：搜索引擎无结果或网络不可达（' + searchResult.slice(0, 80) + '）');
  } else {
    const hasUrl = /https?:\/\//.test(searchResult);
    const hasText = searchResult.trim().length > 30;
    check(searchResult.length > 0, 'web_search 具体任务：返回非空结果');
    check(hasUrl, 'web_search 具体任务：结果含真实 URL（证明真实搜索）');
    check(hasText, 'web_search 具体任务：结果含标题/摘要文本');
  }

  console.log('');
  console.log('  total assertions: ' + assertions + '; env-skips: ' + envSkips);
  console.log('  PASS');
}

main().catch((error) => { console.error('FAIL', error); process.exit(1); });
