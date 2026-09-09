/** Binary PDF parsing shared by the browser host; never interpret viewer chrome as document text. */
export interface BrowserPdfObservation {
  text: string;
  imageDataUrl?: string;
  pages: number;
  visualPage?: number;
  source: 'pdf_binary';
}
export async function readBrowserPdf(bytes: Uint8Array, maxChars: number, forceVision: boolean, signal?: AbortSignal, pdfPage?: number): Promise<BrowserPdfObservation> {
  if (bytes.length > 250 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new Error('Invalid or oversized PDF');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason;
    const document = await task.promise;
    if (pdfPage && pdfPage > document.numPages) throw new Error('PDF page is out of range');
    let text = '';
    for (let number = pdfPage || 1; number <= (pdfPage || document.numPages) && text.length < maxChars; number++) {
      if (signal?.aborted) throw signal.reason;
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
      } catch (error) { if (signal?.aborted) throw error; }
      page.cleanup();
    }
    const result: BrowserPdfObservation = { text: text.trim().slice(0, maxChars), pages: document.numPages, source: 'pdf_binary' };
    if (forceVision || result.text.replace(/\s/g, '').length < 24) {
      const page = await document.getPage(pdfPage || 1);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1400 / original.width, 1800 / original.height) });
      const factory = document.canvasFactory as { create(width: number, height: number): { canvas: any; context: any }; destroy(canvas: any): void };
      const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: canvas.context, canvas: canvas.canvas, viewport }).promise;
        result.imageDataUrl = canvas.canvas.toDataURL('image/jpeg', 0.82);
        result.visualPage = pdfPage || 1;
      } finally { factory.destroy(canvas); page.cleanup(); }
    }
    return result;
  } finally { signal?.removeEventListener('abort', abort); await task.destroy(); }
}
