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

export type BuildVersion = { version: string; branch: string; build: number };

// Entries on the build.xahau.tech index look like
// "2026.9.9-dev%2B3667", "2026.9.8-jshooks%2B3640", "2026.6.21-release%2B3350".
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)-([A-Za-z0-9._-]+)\+(\d+)$/;

// Pure HTML -> BuildVersion[] step, factored out of listVersions() so it's
// testable without a network call. Anything that isn't a decodable href
// matching VERSION_RE (directories, `.releaseinfo` files, malformed entries)
// is silently skipped.
export function parseVersionIndex(html: string): BuildVersion[] {
  const entries: (BuildVersion & { y: number; mo: number; d: number })[] = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (!href) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      continue;
    }
    const vm = decoded.match(VERSION_RE);
    if (!vm) continue;
    const [, y, mo, d, branch, build] = vm;
    entries.push({
      version: decoded,
      branch: branch as string,
      build: Number(build),
      y: Number(y),
      mo: Number(mo),
      d: Number(d),
    });
  }
  entries.sort(
    (a, b) => b.y - a.y || b.mo - a.mo || b.d - a.d || b.build - a.build,
  );
  return entries.map(({ y, mo, d, ...rest }) => rest);
}

export async function listVersions(): Promise<BuildVersion[]> {
  const res = await fetch('https://build.xahau.tech/');
  if (!res.ok) throw new Error(`failed to list versions: ${res.status}`);
  return parseVersionIndex(await res.text());
}

export async function latestReleaseVersion(): Promise<string> {
  const versions = await listVersions();
  const latest = versions.find((v) => v.branch === 'release');
  if (!latest) throw new Error('no releases found on build.xahau.tech');
  return latest.version;
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
