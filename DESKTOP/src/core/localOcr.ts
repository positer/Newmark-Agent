import * as fs from 'fs';
import * as path from 'path';

type TesseractWorker = {
  recognize(image: string | Buffer, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{
    data?: { text?: string; confidence?: number };
  }>;
  setParameters(parameters: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
};

export interface LocalOcrResult {
  ok: boolean;
  engine: 'tesseract.js-simd';
  languages: 'chi_sim+eng';
  text: string;
  confidence: number;
  approximate: true;
  profile: 'sparse-ui' | 'academic-document';
  agentRepairPrompt: string;
  error?: string;
}

const AGENT_REPAIR_PROMPT = [
  'The local OCR output is approximate Chinese/English fallback evidence.',
  'Repair likely OCR substitutions, spacing, and line breaks using the visible UI/PDF context and the user task.',
  'For formulas, conservatively restore operators, variables, superscripts, subscripts, and equation grouping from surrounding mathematical context.',
  'Do not invent text that is not supported by OCR or surrounding context; preserve uncertainty when ambiguous.',
].join(' ');

function abortError(signal?: AbortSignal): Error {
  const error = signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'Local OCR aborted'));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function dataUrlBuffer(value: string): Buffer {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(String(value || ''));
  if (!match) throw new Error('Local OCR only accepts a bounded PNG/JPEG data URL.');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('Local OCR image must be between 1 byte and 12 MB.');
  return buffer;
}

export class LocalOcrEngine {
  private workerPromise: Promise<TesseractWorker> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly rootPath: string) {}

  async recognizeDataUrl(
    dataUrl: string,
    signal?: AbortSignal,
    profile: LocalOcrResult['profile'] = 'sparse-ui',
  ): Promise<LocalOcrResult> {
    return await this.recognize(dataUrlBuffer(dataUrl), signal, profile);
  }

  async recognizeFile(filePath: string, signal?: AbortSignal): Promise<LocalOcrResult> {
    const absolute = path.resolve(filePath);
    const extension = path.extname(absolute).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.bmp'].includes(extension)) {
      throw new Error('Local OCR only accepts PNG, JPEG, or BMP images.');
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 12 * 1024 * 1024) {
      throw new Error('Local OCR image must be a regular file no larger than 12 MB.');
    }
    return await this.recognize(absolute, signal, 'sparse-ui');
  }

  async dispose(): Promise<void> {
    const current = this.workerPromise;
    this.workerPromise = null;
    if (!current) return;
    try { await (await current).terminate(); } catch {}
  }

  private async recognize(
    image: string | Buffer,
    signal?: AbortSignal,
    profile: LocalOcrResult['profile'] = 'sparse-ui',
  ): Promise<LocalOcrResult> {
    throwIfAborted(signal);
    const task = this.tail.then(async () => {
      throwIfAborted(signal);
      const worker = await this.worker();
      throwIfAborted(signal);
      await worker.setParameters({
        tessedit_pageseg_mode: profile === 'academic-document' ? '3' : '11',
        preserve_interword_spaces: '1',
      });
      const result = await worker.recognize(image, { rotateAuto: true }, { text: true });
      throwIfAborted(signal);
      const text = String(result?.data?.text || '').replace(/\r\n/g, '\n').trim().slice(0, 50_000);
      return {
        ok: text.length > 0,
        engine: 'tesseract.js-simd' as const,
        languages: 'chi_sim+eng' as const,
        text,
        confidence: Math.max(0, Math.min(100, Number(result?.data?.confidence || 0))),
        approximate: true as const,
        profile,
        agentRepairPrompt: AGENT_REPAIR_PROMPT,
        ...(text ? {} : { error: 'Local OCR returned no readable Chinese/English text.' }),
      };
    });
    this.tail = task.then(() => undefined, async () => {
      await this.dispose();
    });
    return await task;
  }

  private async worker(): Promise<TesseractWorker> {
    if (!this.workerPromise) this.workerPromise = this.createWorker();
    return await this.workerPromise;
  }

  private async createWorker(): Promise<TesseractWorker> {
    const tessdataPath = this.prepareLanguageCache();
    // Loaded only after textual and validated-vision recognition have failed.
    const tesseract = require('tesseract.js') as {
      createWorker(languages: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
      OEM: { LSTM_ONLY: number };
    };
    const worker = await tesseract.createWorker('chi_sim+eng', tesseract.OEM.LSTM_ONLY, {
      langPath: tessdataPath,
      cachePath: path.join(this.rootPath, 'cache', 'ocr-runtime'),
      cacheMethod: 'none',
      gzip: true,
      logger: () => undefined,
    });
    return worker;
  }

  private prepareLanguageCache(): string {
    const target = path.join(this.rootPath, 'cache', 'ocr-tessdata');
    fs.mkdirSync(target, { recursive: true });
    for (const language of ['eng', 'chi_sim'] as const) {
      const destination = path.join(target, `${language}.traineddata.gz`);
      if (fs.existsSync(destination) && fs.statSync(destination).size > 0) continue;
      const packageRoot = path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`));
      const source = path.join(packageRoot, '4.0.0_best_int', `${language}.traineddata.gz`);
      fs.copyFileSync(source, destination);
    }
    return target;
  }
}
