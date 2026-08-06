'use strict';
// Builds a HarmonyOS-deployable headless bundle from the platform-independent
// dist output. The Newmark core (Agent/Flow/Server/CLI) is pure TypeScript with
// process.platform branches; this script packs dist/ + runtime bundles into a
// self-contained directory that a HarmonyOS Node runtime (or ArkWeb HTTP client)
// can consume. Native-only dependencies (node-pty, tesseract.js, jsdom) are
// externalized and documented rather than bundled.
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const outDir = path.resolve(root, '..', 'dist-harmonyos');

function log(m) { console.log(`[dist-harmonyos] ${m}`); }
function fail(m) { throw new Error(m); }

function tryRm(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

(async () => {
  if (!fs.existsSync(path.join(distDir, 'server.js'))) fail('dist/server.js missing; run npm run build first');
  if (!fs.existsSync(path.join(distDir, 'launcher.js'))) fail('dist/launcher.js missing; run npm run build first');

  tryRm(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Copy the full dist tree (core, tools, ui, tests) so relative runtime
  //    asset resolution (typebox-compile.bundle.cjs, wsl host, ui index) works.
  fs.cpSync(distDir, path.join(outDir, 'dist'), { recursive: true });
  log('copied dist/ -> dist-harmonyos/dist');

  // 1b. Copy the pure-JS runtime dependencies the dist modules require at load
  //     (pngjs, jpeg-js, glob, typebox, cross-fetch, jsdom, @mozilla/readability,
  //     https-proxy-agent, just-bash). Native/asset-heavy modules (node-pty,
  //     tesseract.js + data, lucide-static, resedit) are excluded from the
  //     headless deploy and documented in the manifest.
  const nodeModules = path.join(root, 'node_modules');
  const outNodeModules = path.join(outDir, 'node_modules');
  fs.mkdirSync(outNodeModules, { recursive: true });
  const pureJsDeps = ['pngjs', 'jpeg-js', 'glob', 'typebox', 'cross-fetch', 'jsdom', '@mozilla/readability', 'https-proxy-agent', 'just-bash'];
  for (const dep of pureJsDeps) {
    const src = path.join(nodeModules, dep);
    if (!fs.existsSync(src)) { log(`warning: node_modules/${dep} missing; skipping`); continue; }
    const dest = path.join(outNodeModules, dep);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  log('copied pure-JS runtime deps -> dist-harmonyos/node_modules');

  // 2. Bundle the headless server as a single CJS entry for easy discovery.
  //    Native modules stay external; the pure-JS core is inlined.
  await esbuild.build({
    entryPoints: [path.join(distDir, 'server.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(outDir, 'newmark-server.bundle.cjs'),
    external: ['node-pty', 'tesseract.js', 'jsdom', 'sharp', 'canvas', '@tesseract.js-data/chi_sim', '@tesseract.js-data/eng'],
    logLevel: 'info',
  });
  log('bundled newmark-server.bundle.cjs');

  // 3. Emit a platform manifest so a HarmonyOS integration can check what it
  //    can run headlessly.
  const manifest = {
    name: 'newmark-headless',
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    entrypoints: {
      server: 'dist/server.js',
      cli: 'dist/launcher.js',
      bundledServer: 'newmark-server.bundle.cjs',
    },
    nativeOnlyExternalDeps: ['node-pty', 'tesseract.js', 'jsdom', 'sharp', 'canvas'],
    bundledPureJsDeps: pureJsDeps,
    notes: 'HarmonyOS: run dist/launcher.js --server in a Node-compatible runtime; ArkWeb/ArkTS clients talk HTTP on port 47890. Native desktop features (pty/tray) are unavailable headless.',
  };
  fs.writeFileSync(path.join(outDir, 'harmonyos-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  log('wrote harmonyos-manifest.json');

  // 4. Smoke: the headless server must actually start and answer HTTP.
  const smokeRoot = path.join(outDir, '.smoke-root');
  tryRm(smokeRoot);
  const serverProc = spawn(process.execPath, [path.join(outDir, 'dist', 'launcher.js'), '--server', '--root', smokeRoot], {
    cwd: outDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const http = require('http');
  const probe = (attempts) => new Promise((resolve) => {
    const tryOnce = (n) => {
      const req = http.get('http://127.0.0.1:47890/api/state', (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, body: body.slice(0, 120) }));
      });
      req.on('error', () => {
        if (n <= 0) resolve({ ok: false, error: 'no-http' });
        else setTimeout(() => tryOnce(n - 1), 800);
      });
      req.setTimeout(4000, () => { req.destroy(); if (n <= 0) resolve({ ok: false, error: 'timeout' }); else setTimeout(() => tryOnce(n - 1), 800); });
    };
    tryOnce(attempts);
  });
  const probeResult = await probe(8);
  serverProc.kill();
  await new Promise(r => setTimeout(r, 600));
  if (!probeResult.ok) {
    fail(`headless server smoke failed: ${JSON.stringify(probeResult)}`);
  }
  log(`headless server HTTP smoke ok: ${JSON.stringify(probeResult)}`);

  log('dist-harmonyos ready: ' + outDir);
})().catch(err => { console.error(`[dist-harmonyos] ${err.stack || err.message}`); process.exit(1); });
