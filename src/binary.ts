import { createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const cacheDir =
  process.env.XNG_CACHE_DIR ??
  join(os.homedir(), '.cache', 'xahau-network-generator');

// version like "2026.6.21-release+3350" -> [2026,6,21,3350] for ordering.
function versionSortKey(version: string): number[] {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)-release\+(\d+)$/);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function compareVersions(a: string, b: string): number {
  const ka = versionSortKey(a);
  const kb = versionSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    const diff = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function latestReleaseVersion(): Promise<string> {
  const res = await fetch('https://build.xahau.tech/');
  if (!res.ok) throw new Error(`failed to list releases: ${res.status}`);
  const html = await res.text();
  const versions: string[] = [];
  const re = /href="([^"]*-release%2B\d+)"/g;
  for (const m of html.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    versions.push(decodeURIComponent(raw).replace(/%2B/g, '+'));
  }
  if (versions.length === 0)
    throw new Error('no releases found on build.xahau.tech');
  versions.sort(compareVersions);
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error('no releases found on build.xahau.tech');
  return latest;
}

async function fileExistsNonEmpty(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body)
    throw new Error(`failed to download ${url}: ${res.status}`);
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      createWriteStream(tmpPath),
    );
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  await rename(tmpPath, destPath);
}

export async function fetchBinary(
  version: string,
): Promise<{ binaryPath: string; releaseinfo: string }> {
  const dir = join(cacheDir, version);
  await mkdir(dir, { recursive: true });
  const binaryPath = join(dir, 'xahaud');
  const releaseinfoPath = join(dir, 'releaseinfo');
  const encoded = encodeURIComponent(version);

  if (!(await fileExistsNonEmpty(binaryPath))) {
    await downloadTo(`https://build.xahau.tech/${encoded}`, binaryPath);
  }
  await chmod(binaryPath, 0o755);

  if (!(await fileExistsNonEmpty(releaseinfoPath))) {
    const res = await fetch(`https://build.xahau.tech/${encoded}.releaseinfo`);
    if (!res.ok)
      throw new Error(`failed to download releaseinfo: ${res.status}`);
    await writeFile(releaseinfoPath, await res.text());
  }
  const releaseinfo = await readFile(releaseinfoPath, 'utf8');

  return { binaryPath, releaseinfo };
}
