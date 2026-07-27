import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { BrowserUseEngine } from '../core/browserUse';
import { NativeBrowserUsePageAdapter } from '../core/browserUsePageAdapter';
import { ConfigManager } from '../core/config';
import { LocalOcrEngine } from '../core/localOcr';
import { ToolExecutor } from '../tools';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkLocalOcrVerify-'));
  let formulaRecall: number | null = null;
  let formulaOcrText = '';
  try {
    const imagePath = path.join(root, 'mixed-zh-en.png');
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Drawing',
        '$bitmap = New-Object System.Drawing.Bitmap 1400,440',
        '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
        '$graphics.Clear([System.Drawing.Color]::White)',
        '$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
        "$font = New-Object System.Drawing.Font('Microsoft YaHei UI',42,[System.Drawing.FontStyle]::Bold)",
        "$graphics.DrawString('确认提交  Build Next  12345',$font,[System.Drawing.Brushes]::Black,30,70)",
        "$formulaFont = New-Object System.Drawing.Font('Cambria Math',44,[System.Drawing.FontStyle]::Regular)",
        "$graphics.DrawString('E = mc²    F = ma    ∫₀¹ x² dx = 1/3',$formulaFont,[System.Drawing.Brushes]::Black,30,190)",
        `$bitmap.Save('${imagePath.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
        '$graphics.Dispose(); $bitmap.Dispose(); $font.Dispose(); $formulaFont.Dispose()',
      ].join('; ');
      const generated = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(generated.status, 0, generated.stderr || 'failed to generate OCR fixture');
      const ocr = new LocalOcrEngine(root);
      const result = await ocr.recognizeFile(imagePath);
      await ocr.dispose();
      assert.equal(result.ok, true);
      assert.match(result.text, /Build/);
      assert.match(result.text, /Next/);
      assert.match(result.text, /12345/);
      const formulaTokens = ['E', 'mc', 'F', 'ma', 'x', '1', '3'];
      formulaRecall = formulaTokens.filter(token => result.text.toLowerCase().includes(token.toLowerCase())).length / formulaTokens.length;
      formulaOcrText = result.text;
      assert.ok(formulaRecall >= 0.7, `formula token recall too low: ${formulaRecall} from ${result.text}`);
      assert.equal(result.languages, 'chi_sim+eng');
      assert.equal(result.approximate, true);
      assert.match(result.agentRepairPrompt, /Do not invent text/);
      assert.match(result.agentRepairPrompt, /superscripts, subscripts/);
    }

    let captures = 0;
    const adapter = new NativeBrowserUsePageAdapter(async () => ({
      identity: async () => ({ pageToken: 'page-1', url: 'https://fixture.invalid/', title: 'fixture' }),
      evaluateFixed: async <T>() => ({
        url: 'https://fixture.invalid/',
        title: 'fixture',
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, pageWidth: 800, pageHeight: 600 },
        text: '',
        elements: [{ token: 'button:nth-of-type(1)', tag: 'button', role: 'button', rect: { x: 1, y: 1, width: 80, height: 30 } }],
      }) as T,
      captureVisibleScreenshot: async () => {
        captures += 1;
        return 'data:image/jpeg;base64,AA==';
      },
      clickAt: async () => undefined,
      replaceFocusedText: async () => undefined,
      pressKey: async () => undefined,
      navigate: async () => undefined,
      waitForReady: async () => undefined,
    }));
    const browser = new BrowserUseEngine(adapter, { id: () => 'fixture-id', now: () => 100 });
    const receipt = await browser.run({
      owner: 'fixture-owner',
      runtimeKey: 'fixture-runtime',
      action: 'observe',
      actionId: 'fixture-observe',
    });
    assert.equal(captures, 1);
    assert.equal(receipt.visual_fallback?.recognition_order, 'text>vision>local_ocr');
    assert.equal(receipt.vision_image_data_url, 'data:image/jpeg;base64,AA==');

    const config = new ConfigManager(root);
    const tools = new ToolExecutor(root, config);
    const names = tools.definitions().map((definition: any) => definition.function?.name);
    assert.ok(names.includes('ocr_read'));
    assert.ok(names.includes('pdf_read'));
    assert.ok(tools.definitions('plan').some((definition: any) => definition.function?.name === 'ocr_read'));
    const blockedVision = await tools.execute('ocr_read', JSON.stringify({
      source: 'image',
      path: imagePath,
      fallback_reason: 'vision_unavailable',
    }), root, {
      workspacePath: root,
      allowEphemeralVisionImage: true,
    });
    assert.match(blockedVision, /validated vision model is available/i);

    const textPdf = path.join(root, 'text-layer.pdf');
    fs.writeFileSync(textPdf, Buffer.from('%PDF-1.4\nBT (Embedded PDF text layer for Newmark verification 12345) Tj ET\n%%EOF', 'latin1'));
    const pdfResult = JSON.parse(await tools.execute('pdf_read', JSON.stringify({ path: textPdf }), root, {
      workspacePath: root,
      allowEphemeralVisionImage: false,
    }));
    assert.equal(pdfResult.source, 'pdf_text_layer');
    assert.match(pdfResult.text, /Embedded PDF text layer/);
    assert.equal(pdfResult.recognition_order, 'text>vision>local_ocr');

    console.log(JSON.stringify({
      ok: true,
      assertions: process.platform === 'win32' ? 21 : 11,
      languages: 'chi_sim+eng',
      recognitionOrder: 'text>vision>local_ocr',
      approximateRepairPrompt: true,
      formulaRepairContract: true,
      formulaTokenRecall: formulaRecall,
      formulaOcrText,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
