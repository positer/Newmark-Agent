import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { Agent } from '../core/agent';
import { persistSubmittedConversationImages } from '../core/conversationAttachments';
import { decodeInspectionImage } from '../core/imageInspect';
import type { StreamToken } from '../core/types';

function pngDataUrl(width: number, height: number, rgba: [number, number, number, number]): string {
  const fixture = new PNG({ width, height, colorType: 6 });
  for (let offset = 0; offset < fixture.data.length; offset += 4) {
    fixture.data[offset] = rgba[0];
    fixture.data[offset + 1] = rgba[1];
    fixture.data[offset + 2] = rgba[2];
    fixture.data[offset + 3] = rgba[3];
  }
  return `data:image/png;base64,${PNG.sync.write(fixture).toString('base64')}`;
}

function oversizedIhdrPngDataUrl(): string {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 4, 'ascii');
  bytes.writeUInt32BE(100_000, 16);
  bytes.writeUInt32BE(401, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-user-image-persistence-'));
  try {
    const agent = new Agent(root);
    const workspace = agent.createInternalWorkspace('durable-user-images');
    agent.setConversation('focus-images');
    agent.config.upsertProvider('VisionFixture', 'https://vision.invalid/v1', 'test-only', 'openai');
    agent.config.addModelToProvider('VisionFixture', 'vision-fixture', 'Vision Fixture', 'Test-only vision model');
    agent.config.updateModel('VisionFixture', 'vision-fixture', { vision: true, max_tokens: 4096 });
    agent.setModel('vision-fixture');
    agent.config.save();
    (agent as any).forcedProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }),
      async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
        yield { type: 'text', text: 'IMAGE_ACCEPTED' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };

    const oversizedHeader = oversizedIhdrPngDataUrl();
    assert.ok(Buffer.from(oversizedHeader.split(',')[1], 'base64').length < 64, 'oversized-dimension PNG fixture remains a tiny encoded input');
    assert.throws(
      () => decodeInspectionImage(oversizedHeader),
      /exceeds the 40 megapixel inspection limit/i,
      'PNG IHDR dimensions are rejected before pngjs can decode or allocate the bitmap',
    );
    assert.throws(
      () => persistSubmittedConversationImages(root, [{ dataUrl: oversizedHeader, name: 'oversized.png', type: 'image/png' }]),
      /exceeds the 40 megapixel inspection limit/i,
      'durable user-image persistence applies the same pre-decode PNG dimension gate',
    );

    const dataUrl = pngDataUrl(3, 2, [255, 255, 255, 255]);
    await agent.process({ text: 'Remember this diagram', images: [{ dataUrl, name: '../diagram.png', type: 'image/png' }] });

    const submitted = agent.chatMessages.find(message => message.role === 'user') as any;
    assert.ok(submitted, 'submitted user message is persisted');
    assert.equal(submitted.attachments?.length, 1, 'submitted image is represented as a durable chat attachment');
    assert.equal(submitted.attachments[0].origin, 'user', 'durable chat attachments can only originate from the user');
    assert.equal(submitted.attachments[0].width, 3);
    assert.equal(submitted.attachments[0].height, 2);
    assert.match(submitted.attachments[0].id, /^user-image-[a-f0-9]{64}$/);
    assert.ok(!String(submitted.attachments[0].name).includes('..'), 'attachment display names are sanitized');
    assert.ok(fs.existsSync(path.join(root, submitted.attachments[0].assetPath)), 'content-addressed user image asset exists below the Newmark root');

    const statePath = path.join(workspace.path, 'conversations', 'state.json');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const serialized = JSON.stringify(stored);
    assert.ok(serialized.includes(submitted.attachments[0].id), 'conversation state persists the stable attachment id');
    assert.ok(!serialized.includes('newmark-computer-use'), 'conversation state never contains Computer Use screenshot paths');

    const reloaded = new Agent(root);
    reloaded.selectWorkspace(workspace.id || workspace.name);
    reloaded.setConversation('focus-images');
    reloaded.setModel('vision-fixture');
    const reloadedUser = reloaded.chatMessages.find(message => message.role === 'user') as any;
    assert.equal(reloadedUser?.attachments?.[0]?.id, submitted.attachments[0].id, 'restart restores the same user attachment');
    assert.ok(String(reloadedUser?.attachments?.[0]?.dataUrl || '').startsWith('data:image/png;base64,'), 'restart hydrates the image for UI display and Agent inspection');

    const legacyIdentifiedImage = pngDataUrl(2, 1, [255, 0, 0, 255]);
    const legacyAnonymousImage = pngDataUrl(1, 3, [0, 0, 255, 255]);
    const focusState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const focusStateKey = Object.keys(focusState.conversations || {}).find(key => key.endsWith('-focus-images'));
    assert.ok(focusStateKey, 'fixture can derive the current workspace conversation prefix');
    const workspacePrefix = focusStateKey!.slice(0, -'focus-images'.length);
    for (const legacyVersion of [1, 2]) {
      const legacyConversationId = `legacy-never-opened-v${legacyVersion}`;
      const legacyStateKey = `${workspacePrefix}${legacyConversationId}`;
      const legacyState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      legacyState.version = legacyVersion;
      legacyState.conversations[legacyStateKey] = {
        title: `Legacy image conversation v${legacyVersion}`,
        chatMessages: [
          { role: 'user', content: 'identified legacy image', clientMessageId: 'legacy-image-id', timestamp: '00:00:01' },
          { role: 'assistant', content: 'first response', timestamp: '00:00:02' },
          { role: 'user', content: 'anonymous legacy image', timestamp: '00:00:03' },
        ],
        history: [
          {
            role: 'user',
            client_message_id: 'legacy-image-id',
            content: [
              { type: 'text', text: 'identified legacy image' },
              { type: 'image_url', image_url: { url: legacyIdentifiedImage } },
            ],
          },
          { role: 'assistant', content: 'first response' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'anonymous legacy image' },
              { type: 'image_url', image_url: { url: legacyAnonymousImage } },
            ],
          },
        ],
        updatedAt: `2026-01-0${legacyVersion}T00:00:00.000Z`,
      };
      fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2), 'utf-8');

      const legacySnapshot = reloaded.getConversationSnapshot(legacyConversationId);
      const legacyUsers = legacySnapshot.chatMessages.filter(message => message.role === 'user') as any[];
      assert.equal(legacyUsers[0]?.attachments?.[0]?.width, 2, `v${legacyVersion} identified chat message consumes its matching history image`);
      assert.equal(legacyUsers[0]?.attachments?.[0]?.height, 1);
      assert.equal(legacyUsers[1]?.attachments?.[0]?.width, 1, `v${legacyVersion} no-ID chat message consumes the remaining history image`);
      assert.equal(legacyUsers[1]?.attachments?.[0]?.height, 3);
      assert.notEqual(legacyUsers[0]?.attachments?.[0]?.id, legacyUsers[1]?.attachments?.[0]?.id, 'mixed ID/no-ID migration never reuses one history image twice');

      const legacyArchiveName = reloaded.archiveConversation(legacyConversationId);
      assert.ok(legacyArchiveName, `never-activated v${legacyVersion} conversation can be archived directly`);
      const legacyArchivePath = path.join(workspace.path, 'archive', legacyArchiveName!);
      const legacyArchiveText = fs.readFileSync(legacyArchivePath, 'utf-8');
      const legacyArchiveAssets = Array.from(legacyArchiveText.matchAll(/\]\((assets\/user-images\/[a-f0-9]{64}\.png)\)/g), match => match[1]);
      assert.equal(legacyArchiveAssets.length, 2, `direct v${legacyVersion} archive migrates both legacy history images`);
      assert.equal(new Set(legacyArchiveAssets).size, 2, `direct v${legacyVersion} archive keeps the two distinct images`);
      assert.ok(legacyArchiveAssets.every(relativePath => fs.existsSync(path.join(path.dirname(legacyArchivePath), relativePath))), 'all directly archived legacy image assets remain portable');
      assert.equal(reloaded.getConversationSnapshot().conversationId, 'focus-images', 'archiving an inactive legacy conversation does not switch Focus');
    }

    const byIdInfo = JSON.parse(await reloaded.handleImageInspect(JSON.stringify({
      action: 'source_info',
      attachment_id: submitted.attachments[0].id,
    })));
    assert.equal(byIdInfo.attachment_id, submitted.attachments[0].id, 'image_inspect can revisit a durable attachment by stable id');
    assert.equal(byIdInfo.width, 3);
    assert.equal(byIdInfo.height, 2);

    const archiveName = reloaded.archiveConversation('focus-images');
    assert.ok(archiveName, 'conversation with user images can be archived');
    const archivePath = path.join(workspace.path, 'archive', archiveName!);
    const archiveText = fs.readFileSync(archivePath, 'utf-8');
    const archiveAssetMatch = /\]\((assets\/user-images\/[a-f0-9]{64}\.png)\)/.exec(archiveText);
    assert.ok(archiveAssetMatch, 'archive contains a portable relative link to the submitted image');
    assert.ok(fs.existsSync(path.join(path.dirname(archivePath), archiveAssetMatch![1])), 'archive image asset remains after the active conversation is removed');

    const beforeInvalid = reloaded.chatMessages.length;
    const invalid = await reloaded.process({
      text: 'Do not accept active content',
      images: [{ dataUrl: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+', name: 'active.svg', type: 'image/svg+xml' }],
    });
    assert.match(invalid.map(token => token.text || '').join(''), /attachment rejected/i, 'unsupported active image formats are rejected explicitly');
    assert.equal(reloaded.chatMessages.length, beforeInvalid, 'rejected images do not enter the chat transcript');

    console.log('User image persistence verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
