const { spawnSync } = require('child_process');
const { argv } = require('process');

const CANONICAL_TAG = /^dev-\d+\.\d+\.\d+$/;
const CANONICAL_TITLE_FOR = tag => `Newmark Agent ${tag}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function localTags() {
  return run('git', ['tag', '--list']).split(/\r?\n/).map(tag => tag.trim()).filter(Boolean);
}

function remoteTags() {
  const output = run('git', ['ls-remote', '--tags', 'origin']);
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^[0-9a-f]+\trefs\/tags\/(.+?)\^{}$/);
    if (match) continue;
    const plain = line.match(/^[0-9a-f]+\trefs\/tags\/(.+)$/);
    if (plain) names.push(plain[1].trim());
  }
  return names;
}

function releaseTitles() {
  if (!process.env.NEWMARK_TAG_AUDIT_NO_GH) {
    try {
      const output = run('gh', ['release', 'list', '--limit', '500', '--json', 'tagName,name'], { timeout: 120_000 });
      const releases = JSON.parse(output || '[]');
      return new Map(releases.map(release => [release.tagName, release.name || '']));
    } catch {
      return new Map();
    }
  }
  return new Map();
}

function fixLocalNonCanonical(names, remote) {
  const localOnlyNonCanonical = names.filter(tag => !remote.includes(tag) && !CANONICAL_TAG.test(tag));
  for (const tag of localOnlyNonCanonical) {
    const result = spawnSync('git', ['tag', '-d', tag], {
      cwd: __dirname,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`failed to delete local tag ${tag}: ${result.stderr || result.stdout}`);
    console.log(`[release-tag-audit] removed local non-canonical tag ${tag}`);
  }
  return localOnlyNonCanonical;
}

function fixReleaseTitles(titles) {
  for (const [tag, title] of titles) {
    const canonical = CANONICAL_TITLE_FOR(tag);
    if (title === canonical) continue;
    run('gh', ['release', 'edit', tag, '--title', canonical], { timeout: 120_000 });
    console.log(`[release-tag-audit] normalized release title for ${tag}: ${canonical}`);
  }
}

function main() {
  const local = localTags();
  const remote = remoteTags();
  const titles = releaseTitles();
  const localNonCanonical = local.filter(tag => !CANONICAL_TAG.test(tag));
  const remoteNonCanonical = remote.filter(tag => !CANONICAL_TAG.test(tag));

  console.log(`[release-tag-audit] local tags=${local.length} remote tags=${remote.length}`);
  for (const tag of localNonCanonical) {
    console.log(`[release-tag-audit] non-canonical local tag: ${tag}`);
  }
  for (const tag of remoteNonCanonical) {
    console.log(`[release-tag-audit] non-canonical remote tag: ${tag}`);
  }
  for (const [tag, title] of titles) {
    if (!CANONICAL_TAG.test(tag) || title !== CANONICAL_TITLE_FOR(tag)) {
      console.log(`[release-tag-audit] non-canonical release metadata: tag=${tag} title=${title || ''}`);
    }
  }

  if (argv.includes('--fix-local')) {
    fixLocalNonCanonical(local, remote);
  }
  if (argv.includes('--fix-release-titles')) {
    fixReleaseTitles(titles);
  }

  if (!argv.includes('--fix-local') && localNonCanonical.length > 0) {
    console.log('[release-tag-audit] local non-canonical tags remain; run with --fix-local to remove local-only refs.');
  }
  if (!argv.includes('--fix-release-titles') && [...titles].some(([tag, title]) => title !== CANONICAL_TITLE_FOR(tag))) {
    console.log('[release-tag-audit] non-canonical release titles remain; run with --fix-release-titles to normalize.');
  }
  if (remoteNonCanonical.length > 0) {
    throw new Error('Non-canonical remote tags found; refusing to continue without explicit review.');
  }
}

main();
