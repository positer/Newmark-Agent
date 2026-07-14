import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { PdfPreviewServer } from '../core/pdfPreviewServer';
import { WorkspaceFileRouter } from '../core/workspaceFileRouter';

type Assert = (condition: boolean, name: string, detail?: string) => void;

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(urlValue: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: options.headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function verifyPdfPreviewServer(testRoot: string, assert: Assert): Promise<void> {
  const workspaceRoot = path.join(testRoot, 'pdf-preview-workspace');
  const alternateRoot = path.join(testRoot, 'pdf-preview-alternate');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(alternateRoot, { recursive: true });
  const pdfBytes = Buffer.from('%PDF-1.7\nPDF_PREVIEW_RANGE_FIXTURE\n%%EOF\n', 'ascii');
  const pdfPath = path.join(workspaceRoot, 'range fixture.pdf');
  fs.writeFileSync(pdfPath, pdfBytes);

  let routerNow = 1_000;
  let serverNow = 1_000;
  let activeWorkspaceRoot = workspaceRoot;
  const router = new WorkspaceFileRouter(() => activeWorkspaceRoot, {
    now: () => routerNow,
    pdfCapabilityTtlMs: 5_000,
  });
  const server = new PdfPreviewServer((token, ownerId) => router.resolvePdfCapability(token, ownerId), {
    now: () => serverNow,
  });

  await server.start();
  try {
    const opened = await router.open(pdfPath, 'renderer-a');
    assert(opened.kind === 'browser' && opened.mime === 'application/pdf' && !!opened.capability, 'pdf preview: router returns an opaque capability instead of a custom-scheme URL');
    if (opened.kind !== 'browser' || opened.mime !== 'application/pdf' || !opened.capability) return;

    const wrongOwnerResource = await router.resolvePdfCapability(opened.capability.token, 'renderer-b');
    assert(wrongOwnerResource === null, 'pdf preview: router capability resolution requires the issuing renderer owner');
    const url = server.urlFor(opened.capability, 'renderer-a');
    assert(/^http:\/\/127\.0\.0\.1:\d+\/pdf\//.test(url) && !url.startsWith('newmark-preview://'), 'pdf preview: capability is exposed through an ephemeral loopback HTTP URL');
    let conflictingOwnerRejected = false;
    try { server.urlFor(opened.capability, 'renderer-b'); } catch { conflictingOwnerRejected = true; }
    assert(conflictingOwnerRejected, 'pdf preview: an issued HTTP capability cannot be rebound to another renderer owner');

    const full = await request(url);
    assert(full.status === 200 && full.body.equals(pdfBytes), 'pdf preview: GET streams the complete canonical PDF');
    assert(full.headers['content-type'] === 'application/pdf'
      && !!full.headers['content-disposition']?.startsWith('inline;')
      && full.headers['accept-ranges'] === 'bytes'
      && full.headers['cache-control'] === 'no-store'
      && full.headers['x-content-type-options'] === 'nosniff', 'pdf preview: response includes inline, range, and no-sniff security headers');

    const head = await request(url, { method: 'HEAD' });
    assert(head.status === 200 && head.body.length === 0 && Number(head.headers['content-length']) === pdfBytes.length, 'pdf preview: HEAD reports the full length without a body');

    const bounded = await request(url, { headers: { Range: 'bytes=0-3' } });
    assert(bounded.status === 206 && bounded.body.toString('ascii') === '%PDF'
      && bounded.headers['content-range'] === `bytes 0-3/${pdfBytes.length}`
      && bounded.headers['content-length'] === '4', 'pdf preview: bounded single range returns exact 206 metadata and bytes');

    const openEnded = await request(url, { headers: { Range: 'bytes=5-' } });
    assert(openEnded.status === 206 && openEnded.body.equals(pdfBytes.subarray(5)), 'pdf preview: open-ended range is supported');

    const suffix = await request(url, { headers: { Range: 'bytes=-5' } });
    assert(suffix.status === 206 && suffix.body.equals(pdfBytes.subarray(-5)), 'pdf preview: suffix range is supported');

    const invalid = await request(url, { headers: { Range: `bytes=${pdfBytes.length + 10}-` } });
    const multiple = await request(url, { headers: { Range: 'bytes=0-1,3-4' } });
    assert(invalid.status === 416 && invalid.headers['content-range'] === `bytes */${pdfBytes.length}` && invalid.body.length === 0, 'pdf preview: unsatisfiable range returns 416');
    assert(multiple.status === 416 && multiple.headers['content-range'] === `bytes */${pdfBytes.length}`, 'pdf preview: multiple ranges are rejected instead of ambiguously downgraded');

    const wrongHost = await request(url, { headers: { Host: `localhost:${new URL(url).port}` } });
    const post = await request(url, { method: 'POST' });
    assert(wrongHost.status === 421, 'pdf preview: Host must exactly match the bound loopback endpoint');
    assert(post.status === 405 && post.headers.allow === 'GET, HEAD', 'pdf preview: only GET and HEAD are allowed');

    const unknownUrl = url.replace(opened.capability.token, '00000000000000000000000000000000');
    const traversalUrl = url.replace(/\/[^/]+\.pdf$/, '/..%2Foutside.pdf');
    const renamedUrl = url.replace(/\/[^/]+\.pdf$/, '/different.pdf');
    assert((await request(unknownUrl)).status === 404, 'pdf preview: unknown capability tokens are rejected');
    assert((await request(traversalUrl)).status === 404, 'pdf preview: encoded filename traversal is rejected');
    assert((await request(renamedUrl)).status === 404, 'pdf preview: URL filename must exactly match the registered capability filename');

    activeWorkspaceRoot = alternateRoot;
    assert((await request(url)).status === 200, 'pdf preview: issued capability remains bound to its original canonical workspace while another workspace is active');
    activeWorkspaceRoot = workspaceRoot;
    assert((await request(url)).status === 200, 'pdf preview: restoring the canonical workspace restores an unexpired capability');

    router.revokeOwner('renderer-b');
    assert((await request(url)).status === 200, 'pdf preview: another renderer cannot revoke the owner capability');
    server.revokeOwner('renderer-b');
    assert((await request(url)).status === 200, 'pdf preview: server registry ignores revocation for a different owner');

    const explicitlyRevoked = await router.open(pdfPath, 'renderer-explicit-revoke');
    if (explicitlyRevoked.kind === 'browser' && explicitlyRevoked.mime === 'application/pdf' && explicitlyRevoked.capability) {
      const revokedUrl = server.urlFor(explicitlyRevoked.capability, 'renderer-explicit-revoke');
      assert(!server.revokeCapability(explicitlyRevoked.capability.token, 'renderer-b')
        && !router.revokePreviewToken(explicitlyRevoked.capability.token, 'renderer-b'), 'pdf preview: another renderer cannot revoke an individual capability');
      assert(server.revokeCapability(explicitlyRevoked.capability.token, 'renderer-explicit-revoke')
        && router.revokePreviewToken(explicitlyRevoked.capability.token, 'renderer-explicit-revoke')
        && (await request(revokedUrl)).status === 404, 'pdf preview: closing a PDF immediately revokes its server and router capability');
    } else {
      assert(false, 'pdf preview: explicit revoke fixture returns a PDF capability');
    }
    server.revokeOwner('renderer-a');
    assert((await request(url)).status === 404, 'pdf preview: server owner teardown revokes its HTTP registration');
    router.revokeOwner('renderer-a');

    const serverExpiring = await router.open(pdfPath, 'renderer-server-expiring');
    const routerExpiring = await router.open(pdfPath, 'renderer-router-expiring');
    if (serverExpiring.kind === 'browser' && serverExpiring.mime === 'application/pdf' && serverExpiring.capability
      && routerExpiring.kind === 'browser' && routerExpiring.mime === 'application/pdf' && routerExpiring.capability) {
      const serverExpiringUrl = server.urlFor(serverExpiring.capability, 'renderer-server-expiring');
      const routerExpiringUrl = server.urlFor(routerExpiring.capability, 'renderer-router-expiring');
      serverNow += 5_001;
      assert((await request(serverExpiringUrl)).status === 404, 'pdf preview: server registry expires and removes stale capabilities independently');
      serverNow = 1_000;
      routerNow += 5_001;
      assert((await request(routerExpiringUrl)).status === 404, 'pdf preview: router TTL independently rejects an expired canonical capability');
    } else {
      assert(false, 'pdf preview: expiry fixture returns a PDF capability');
    }
  } finally {
    await server.close();
  }
}
