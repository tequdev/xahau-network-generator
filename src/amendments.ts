import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDir } from './binary.ts';

export function commitFromReleaseinfo(text: string): string {
  const m = text.match(/^commit ([0-9a-f]{40})/m);
  if (!m || !m[1]) throw new Error('no commit hash found in releaseinfo');
  return m[1];
}

const FEATURE_SOURCE_URLS = (commit: string): string[] => [
  `https://raw.githubusercontent.com/Xahau/xahaud/${commit}/include/xrpl/protocol/detail/features.macro`,
  `https://raw.githubusercontent.com/Xahau/xahaud/${commit}/src/ripple/protocol/impl/Feature.cpp`,
];

export async function fetchFeatureSource(
  commit: string,
  version: string,
): Promise<string> {
  const dir = join(cacheDir, version);
  const cachePath = join(dir, 'features.txt');
  try {
    const cached = await readFile(cachePath, 'utf8');
    if (cached.length > 0) return cached;
  } catch {
    // not cached yet
  }

  for (const url of FEATURE_SOURCE_URLS(commit)) {
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      await mkdir(dir, { recursive: true });
      await writeFile(cachePath, text);
      return text;
    }
  }
  throw new Error(`could not fetch feature source for commit ${commit}`);
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

function matchNamesSupported(
  source: string,
  macro: string,
): { name: string; supported: boolean }[] {
  const re = new RegExp(
    `^\\s*${macro}\\s*\\(\\s*(${IDENT})\\s*,\\s*Supported::(yes|no)\\s*,`,
    'gm',
  );
  const results: { name: string; supported: boolean }[] = [];
  for (const m of source.matchAll(re)) {
    const name = m[1];
    const supported = m[2];
    if (!name || !supported) continue;
    results.push({ name, supported: supported === 'yes' });
  }
  return results;
}

function matchRetired(source: string): string[] {
  const re = new RegExp(`^\\s*XRPL_RETIRE\\s*\\(\\s*(${IDENT})\\s*\\)`, 'gm');
  const names: string[] = [];
  for (const m of source.matchAll(re)) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

export function parseAmendments(source: string): string[] {
  const names: string[] = [];

  for (const { name, supported } of matchNamesSupported(
    source,
    'XRPL_FEATURE',
  )) {
    if (supported) names.push(name);
  }
  for (const { name, supported } of matchNamesSupported(source, 'XRPL_FIX')) {
    if (supported) names.push(`fix${name}`);
  }
  names.push(...matchRetired(source));
  for (const { name, supported } of matchNamesSupported(
    source,
    'REGISTER_FEATURE',
  )) {
    if (supported) names.push(name);
  }
  for (const { name, supported } of matchNamesSupported(
    source,
    'REGISTER_FIX',
  )) {
    if (supported) names.push(name);
  }

  return names;
}

export function amendmentHash(name: string): string {
  return createHash('sha512')
    .update(name)
    .digest('hex')
    .slice(0, 64)
    .toUpperCase();
}
