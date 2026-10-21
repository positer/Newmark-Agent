import fs from 'node:fs';
const stage=process.argv[2];if(!stage)throw Error('release clone required');
for(const name of ['darwin-space-input','darwin-accessibility','darwin-prototype','darwin-pet-border','darwin-channels'])fs.writeFileSync(stage+'/scripts/verify-'+name+'.mjs',fs.readFileSync('Newmark2DSH/scripts/verify-'+name+'.mjs','utf8').replaceAll('../packages/newmark-core/','../'));
for(const name of ['verify-darwin-render-pipeline.mjs','verify-darwin-web-render.mjs','verify-macos-distinct-spaces.mjs','probe-macos-spaces.mjs','lib/macos-space-probe.swift','lib/macos-ui-fixture.swift','lib/macos-pipeline-driver.swift']){fs.mkdirSync(stage+'/scripts/lib',{recursive:true});fs.copyFileSync('Newmark2DSH/scripts/'+name,stage+'/scripts/'+name);}
const file=stage+'/.github/workflows/macos-validation.yml';let workflow=fs.readFileSync(file,'utf8');
workflow=workflow.replace(/os: \[[^\n]+\]/,'os: [macos-14, macos-15, macos-26]');
if(!workflow.includes('node scripts/verify-darwin-channels.mjs'))workflow=workflow.replace('          node scripts/verify-darwin-pet-border.mjs','          node scripts/verify-darwin-pet-border.mjs\n          node scripts/verify-darwin-channels.mjs');
if(!workflow.includes('cancel-in-progress:'))workflow=workflow.replace('permissions:\n','concurrency:\n  group: macos-validation-${{ github.ref }}\n  cancel-in-progress: true\npermissions:\n');
if(!workflow.includes('Full owned render and operation pipeline'))workflow+=`      - name: Full owned render and operation pipeline
        env:
          NEWMARK_NATIVE_BINARY: \${{ runner.temp }}/newmark-cu
          NEWMARK_EVIDENCE_DIR: \${{ runner.temp }}/newmark-evidence
        run: node scripts/verify-darwin-render-pipeline.mjs
      - name: Preserve owned window render evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: macos-pipeline-\${{ matrix.os }}
          path: \${{ runner.temp }}/newmark-evidence
          retention-days: 3
          if-no-files-found: warn
`;
if(!workflow.includes('Real NewMate client browser rendering'))workflow=workflow.replace('      - name: Preserve owned window render evidence',`      - name: Real NewMate client browser rendering
        env:
          NEWMARK_WEB_DEPS: \${{ runner.temp }}/newmark-web-deps
          NEWMARK_EVIDENCE_DIR: \${{ runner.temp }}/newmark-evidence
        run: |
          npm install --prefix "$NEWMARK_WEB_DEPS" --no-package-lock --no-audit --no-fund react@18.3.1 react-dom@18.3.1 playwright@1.56.1
          "$NEWMARK_WEB_DEPS/node_modules/.bin/playwright" install chromium webkit
          node scripts/verify-darwin-web-render.mjs
      - name: Preserve owned window render evidence`);
fs.writeFileSync(file,workflow.replaceAll('\r\n','\n'));console.log('Mac pipeline tests and evidence workflow prepared.');
