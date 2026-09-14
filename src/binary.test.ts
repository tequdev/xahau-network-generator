import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVersionIndex } from './binary.ts';

// A trimmed fixture shaped like the real build.xahau.tech directory listing:
// a release, a dev and a jshooks entry, a `.releaseinfo` file, a parent-dir
// link, and one malformed entry (empty branch) that must be silently skipped.
const FIXTURE = `
<html><body>
<a href="../">../</a>
<a href="2026.9.9-dev%2B3667">2026.9.9-dev+3667</a>
<a href="2026.9.9-dev%2B3667.releaseinfo">2026.9.9-dev+3667.releaseinfo</a>
<a href="2026.9.8-jshooks%2B3640">2026.9.8-jshooks+3640</a>
<a href="2026.6.21-release%2B3350">2026.6.21-release+3350</a>
<a href="2025.2.1-%2B1268">2025.2.1-+1268</a>
</body></html>
`;

test('parseVersionIndex skips directories, .releaseinfo and malformed entries', () => {
  const versions = parseVersionIndex(FIXTURE);
  assert.deepEqual(
    versions.map((v) => v.version),
    ['2026.9.9-dev+3667', '2026.9.8-jshooks+3640', '2026.6.21-release+3350'],
  );
});

test('parseVersionIndex sorts newest first by date then build', () => {
  const versions = parseVersionIndex(FIXTURE);
  assert.equal(versions[0]?.version, '2026.9.9-dev+3667');
  assert.equal(versions[0]?.branch, 'dev');
  assert.equal(versions[0]?.build, 3667);
  assert.equal(versions[2]?.version, '2026.6.21-release+3350');
});

test('parseVersionIndex lets the release branch be picked as the latest release', () => {
  const versions = parseVersionIndex(FIXTURE);
  const latestRelease = versions.find((v) => v.branch === 'release');
  assert.equal(latestRelease?.version, '2026.6.21-release+3350');
});
