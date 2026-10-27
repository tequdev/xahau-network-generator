#!/usr/bin/env node
// npm entry point: the sources are TypeScript run through Node's built-in type
// stripping (the flag is accepted by every Node >= 22.6).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
spawn(
  process.execPath,
  [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    cli,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
).on('exit', (code) => process.exit(code ?? 1));
