import { execFile, spawn } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describePlan, planState } from './apply.ts';
import { listVersions } from './binary.ts';
import { composeOutputAsync } from './docker.ts';
import {
  DEFAULT_DOMAIN,
  loadState,
  parseState,
  saveState,
  specFor,
} from './state.ts';
import type { State } from './state.ts';
import { NAME_RE, endpoints } from './types.ts';
import type { NetworkSpec } from './types.ts';
import { rpc } from './wait.ts';

const execFileAsync = promisify(execFile);

export type PanelOptions = {
  port: number;
  host: string;
  file: string;
  accessTeam?: string;
  accessAud?: string;
  insecureNoAuth: boolean;
};

const VERSION_RE = /^[0-9A-Za-z.+_-]{1,80}$/;
const AMENDMENT_RE = /^([A-Za-z0-9_]{1,80}|[0-9A-Fa-f]{64})$/;

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification. verifyAccessJwt is pure (takes the JWKS
// keys) so it's unit-testable; only getAccessKeys talks to the network.
// ---------------------------------------------------------------------------

export type Jwk = { kid: string; kty: string; n: string; e: string } & Record<
  string,
  unknown
>;

export type VerifyResult =
  | { ok: true; email?: string }
  | { ok: false; reason: string };

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

export function verifyAccessJwt(
  token: string,
  opts: { issuer: string; aud: string; keys: Jwk[]; now: number },
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed token' };
  }

  // The algorithm is ours to pick, never the token's: anything but RS256
  // (alg:none, an HMAC keyed with the public key, ...) is rejected outright.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported alg' };

  const jwk = opts.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown kid' };

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: node's JsonWebKey type doesn't include Cloudflare's extra fields (kid, use, ...)
    publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'invalid key' };
  }
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  if (!verify('RSA-SHA256', signingInput, publicKey, base64UrlDecode(sigB64))) {
    return { ok: false, reason: 'invalid signature' };
  }

  if (payload.iss !== opts.issuer)
    return { ok: false, reason: 'invalid issuer' };
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(opts.aud))
    return { ok: false, reason: 'invalid audience' };

  const nowSec = opts.now / 1000;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) {
    return { ok: false, reason: 'not yet valid' };
  }

  return {
    ok: true,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

let jwks: { keys: Jwk[]; fetchedAt: number } | undefined;

// Cached; refetched on an unknown kid (a key rotation) at most once a minute
// so a flood of bogus kids can't hammer Cloudflare's JWKS endpoint.
async function getAccessKeys(team: string, refresh: boolean): Promise<Jwk[]> {
  if (jwks && (!refresh || Date.now() - jwks.fetchedAt < 60_000)) {
    return jwks.keys;
  }
  const res = await fetch(
    `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`failed to fetch Access JWKS: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwks = { keys: body.keys, fetchedAt: Date.now() };
  return jwks.keys;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

type AuthResult =
  | { ok: true; who: string }
  | { ok: false; status: number; error: string };

async function checkAuth(
  req: http.IncomingMessage,
  opts: PanelOptions,
): Promise<AuthResult> {
  if (!opts.accessTeam || !opts.accessAud) {
    // --insecure-no-auth (the CLI refuses to start otherwise): local dev only.
    const addr = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(addr)) {
      return { ok: false, status: 403, error: 'forbidden: loopback only' };
    }
    return { ok: true, who: `loopback ${addr}` };
  }
  // Header only: Cloudflare adds it to every request it proxies to the
  // origin. Its CF_Authorization cookie is HttpOnly and deliberately not
  // read here, so a request that didn't come through Access has nothing to
  // present.
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || !token) {
    return { ok: false, status: 401, error: 'missing Access token' };
  }
  const issuer = `https://${opts.accessTeam}.cloudflareaccess.com`;
  const verifyOpts = { issuer, aud: opts.accessAud, now: Date.now() };
  try {
    let keys = await getAccessKeys(opts.accessTeam, false);
    let result = verifyAccessJwt(token, { ...verifyOpts, keys });
    if (!result.ok && result.reason === 'unknown kid') {
      keys = await getAccessKeys(opts.accessTeam, true);
      result = verifyAccessJwt(token, { ...verifyOpts, keys });
    }
    if (!result.ok) return { ok: false, status: 401, error: result.reason };
    return { ok: true, who: result.email ?? '(no email claim)' };
  } catch (err) {
    return { ok: false, status: 401, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// `xahaud feature` (no argument) lists every amendment the node knows.
// ---------------------------------------------------------------------------

export type FeatureEntry = {
  hash: string;
  name: string;
  enabled: boolean;
  supported: boolean;
  vetoed?: boolean;
  count?: number;
  threshold?: number;
};

export function parseFeatureList(stdout: string): FeatureEntry[] {
  let parsed: {
    result?: {
      features?: Record<string, Record<string, unknown>>;
      error_message?: string;
    };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`could not parse feature list output as JSON: ${stdout}`);
  }
  const result = parsed.result;
  if (result?.error_message) throw new Error(result.error_message);
  const features = result?.features;
  if (!features) throw new Error(`unexpected feature list output: ${stdout}`);

  const entries: FeatureEntry[] = Object.entries(features).map(([hash, v]) => ({
    hash,
    name: typeof v.name === 'string' ? v.name : hash,
    enabled: !!v.enabled,
    supported: !!v.supported,
    vetoed: typeof v.vetoed === 'boolean' ? v.vetoed : undefined,
    count: typeof v.count === 'number' ? v.count : undefined,
    threshold: typeof v.threshold === 'number' ? v.threshold : undefined,
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ---------------------------------------------------------------------------
// Job runner: a serial in-memory queue that runs the CLI itself as a child
// process, so there is exactly one implementation of create/.../vote, and
// its synchronous docker calls never block this server.
// ponytail: one global queue; per-network queues if parallel deploys ever matter.
// ---------------------------------------------------------------------------

type Job = {
  id: string;
  name: string;
  steps: string[][];
  timeoutMs: number; // per step; see STEP_TIMEOUT_MS
  status: 'queued' | 'running' | 'ok' | 'failed';
  log: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
};

const MAX_LOG = 256 * 1024;
const MAX_JOBS = 50;
// Wall-clock cap per step, past which the child is killed: the CLI's own
// --timeout (600 s) bounds the waiting parts, this bounds everything else
// (a hung docker pull, a stuck exec) so one job can't block the queue forever.
// `xng upgrade`'s --timeout is per node, so its cap scales with the node
// count (see the upgrade route).
const LONG_STEP_TIMEOUT_MS = 900_000;
const SHORT_STEP_TIMEOUT_MS = 120_000;

const jobs: Job[] = [];
const pending: Job[] = [];
let draining = false;

const TSX_BIN = fileURLToPath(
  new URL('../node_modules/.bin/tsx', import.meta.url),
);
const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

function runStep(job: Job, argv: string[]): Promise<boolean> {
  const timeout = job.timeoutMs;
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...argv], {
      cwd: process.cwd(),
      env: process.env,
      timeout,
      killSignal: 'SIGKILL',
    });
    const append = (chunk: Buffer) => {
      job.log = (job.log + chunk.toString('utf8')).slice(-MAX_LOG);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      job.log += `\nspawn error: ${err.message}\n`;
      resolve(false);
    });
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(true);
      job.log +=
        signal === 'SIGKILL'
          ? `\n[killed: timed out after ${timeout / 1000} s]\n`
          : `\n[exited with code ${code ?? signal}]\n`;
      resolve(false);
    });
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let job = pending.shift(); job; job = pending.shift()) {
      job.status = 'running';
      job.startedAt = Date.now();
      let ok = true;
      for (const step of job.steps) {
        job.log += `$ xng ${step.join(' ')}\n`;
        try {
          ok = await runStep(job, step);
        } catch (err) {
          job.log += `\n[runner error: ${(err as Error).message}]\n`;
          ok = false;
        }
        if (!ok) break;
      }
      job.status = ok ? 'ok' : 'failed';
      job.endedAt = Date.now();
      while (jobs.length > MAX_JOBS) {
        const i = jobs.findIndex((j) => j.endedAt);
        if (i < 0) break;
        jobs.splice(i, 1);
      }
    }
  } finally {
    // Never leave the flag stuck, or every later job would sit at `queued`.
    draining = false;
  }
}

// A whole-file apply (job name '*') touches every network, so it conflicts
// with any single-network job and vice versa. Exported for its own tiny test.
export function jobNamesConflict(a: string, b: string): boolean {
  return a === b || a === '*' || b === '*';
}

// Every yml-editing handler must call this BEFORE touching the file: a
// request refused for a running job must not have already rewritten
// xng.yml underneath that job (or the operator's raw-editor save).
function busy(res: http.ServerResponse, name: string): boolean {
  if (!jobs.some((j) => !j.endedAt && jobNamesConflict(j.name, name))) {
    return false;
  }
  sendJson(res, 409, {
    error: `a job for "${name}" is already queued or running`,
  });
  return true;
}

function enqueue(
  res: http.ServerResponse,
  name: string,
  steps: string[][],
  timeoutMs: number,
): void {
  if (busy(res, name)) return;
  const job: Job = {
    id: randomUUID(),
    name,
    steps,
    timeoutMs,
    status: 'queued',
    log: '',
    createdAt: Date.now(),
  };
  jobs.push(job);
  pending.push(job);
  void drainQueue();
  sendJson(res, 202, { id: job.id });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

async function loadSpec(name: string): Promise<NetworkSpec | null> {
  try {
    return JSON.parse(
      await readFile(join('workspace', name, 'network.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

type Container = { service: string; state: string; status: string };

// One `docker ps` for every network rather than a `compose ps` per network:
// the status path is polled every few seconds and must never wait on
// compose. Rows are grouped by the compose project label (= network name).
async function listContainers(): Promise<Map<string, Container[]>> {
  const byProject = new Map<string, Container[]>();
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      [
        'ps',
        '-a',
        '--format',
        'json',
        '--filter',
        'label=com.docker.compose.project',
      ],
      { timeout: 5000 },
    ));
  } catch {
    return byProject;
  }
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let row: { Labels: string; State: string; Status: string };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const labels = new Map(
      row.Labels.split(',').map((kv) => kv.split('=', 2) as [string, string]),
    );
    const project = labels.get('com.docker.compose.project');
    const service = labels.get('com.docker.compose.service');
    if (!project || !service) continue;
    const list = byProject.get(project) ?? [];
    list.push({ service, state: row.State, status: row.Status });
    byProject.set(project, list);
  }
  return byProject;
}

async function nodeInfo(spec: NetworkSpec) {
  try {
    const { info } = await rpc(
      endpoints(spec).rpc,
      'server_info',
      { api_version: 1 },
      3000,
    );
    return {
      build_version: info.build_version,
      server_state: info.server_state,
      seq: info.validated_ledger?.seq,
      uptime: info.uptime,
      peers: info.peers,
      complete_ledgers: info.complete_ledgers,
    };
  } catch {
    return null;
  }
}

let versionsCache: { at: number; branches: Record<string, string[]> } | null =
  null;

async function versionsByBranch(): Promise<Record<string, string[]>> {
  if (versionsCache && Date.now() - versionsCache.at < 5 * 60_000) {
    return versionsCache.branches;
  }
  const branches: Record<string, string[]> = {};
  for (const v of await listVersions()) {
    branches[v.branch] ??= [];
    branches[v.branch]?.push(v.version);
  }
  versionsCache = { at: Date.now(), branches };
  return branches;
}

// reset/vote stay imperative: reset is a deliberate data wipe apply must
// never do, and vote doesn't touch the declared network shape at all.
const IMPERATIVE_ACTIONS: Record<
  string,
  (name: string, body: Record<string, unknown>) => string[]
> = {
  reset: (name) => ['reset', '--name', name, '--wait', '--timeout', '600'],
  vote: (name, body) => {
    const amendment = body.amendment;
    if (typeof amendment !== 'string' || !AMENDMENT_RE.test(amendment)) {
      throw new Error('invalid amendment');
    }
    return [
      'vote',
      '--name',
      name,
      '--amendment',
      amendment,
      ...(body.reject ? ['--reject'] : []),
    ];
  },
};

// start/stop/remove/upgrade are all "edit xng.yml, then `xng apply --only
// name`" - the actual create/start/upgrade/down/remove work is entirely
// apply's job (see apply.ts's planState). 404 when the name isn't declared,
// except remove, which also has to reach a network apply already considers
// undeclared (removed from xng.yml but not yet applied).
async function handleDeclaredAction(
  res: http.ServerResponse,
  opts: PanelOptions,
  name: string,
  verb: 'start' | 'stop' | 'remove' | 'upgrade',
  body: Record<string, unknown>,
): Promise<void> {
  if (busy(res, name)) return;
  const state = await loadState(opts.file);
  state.networks ??= {};
  const decl = state.networks[name];
  const workspaceSpec = await loadSpec(name);

  if (verb === 'remove') {
    if (!decl && !workspaceSpec) {
      return sendJson(res, 404, { error: `no network named "${name}"` });
    }
    delete state.networks[name];
    await saveState(opts.file, state);
    return enqueue(
      res,
      name,
      [['apply', '--yes', '--file', opts.file, '--only', name]],
      LONG_STEP_TIMEOUT_MS,
    );
  }

  if (!decl) return sendJson(res, 404, { error: `no network named "${name}"` });

  let timeoutMs = LONG_STEP_TIMEOUT_MS;
  if (verb === 'start') {
    // true is the default, so "started" is simply "no enabled key at all".
    const { enabled: _enabled, ...rest } = decl;
    state.networks[name] = rest;
  } else if (verb === 'stop') {
    decl.enabled = false;
  } else {
    const version = body.version;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      return sendJson(res, 400, { error: 'invalid version' });
    }
    decl.version = version;
    // --timeout is per-node inside apply; scale the outer kill timer by the
    // validator count so a rolling upgrade of a large testnet isn't cut off.
    const validators = workspaceSpec?.validators ?? decl.validators ?? 3;
    timeoutMs = (validators + 1) * 600_000 + LONG_STEP_TIMEOUT_MS;
  }
  await saveState(opts.file, state);
  return enqueue(
    res,
    name,
    [['apply', '--yes', '--file', opts.file, '--only', name]],
    timeoutMs,
  );
}

let panelHtml = '';

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: PanelOptions,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://internal').pathname;

  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(panelHtml);
  }
  if (method === 'GET' && path === '/api/config') {
    const state = await loadState(opts.file);
    return sendJson(res, 200, {
      domain: state.domain ?? DEFAULT_DOMAIN,
      tls: state.tls ?? false,
      file: opts.file,
    });
  }
  if (method === 'GET' && path === '/api/state') {
    let yml = '';
    try {
      yml = await readFile(opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return sendJson(res, 200, { yml });
  }
  if (method === 'GET' && path === '/api/versions') {
    try {
      return sendJson(res, 200, { branches: await versionsByBranch() });
    } catch (err) {
      return sendJson(res, 502, { error: (err as Error).message });
    }
  }
  if (method === 'GET' && path === '/api/networks') {
    const state = await loadState(opts.file);
    const declared = state.networks ?? {};
    const declaredNames = new Set(Object.keys(declared));
    const workspaceNames = await readdir('workspace').catch(
      () => [] as string[],
    );
    const names = [...new Set([...declaredNames, ...workspaceNames])].sort();
    const [containers, ...networks] = await Promise.all([
      listContainers(),
      ...names.map(async (name) => {
        const spec = await loadSpec(name);
        if (spec) {
          return {
            spec,
            endpoints: endpoints(spec),
            info: await nodeInfo(spec),
            declared: declaredNames.has(name),
            missing: false,
          };
        }
        // Declared but never (yet) created, e.g. a create that failed
        // partway through - still worth showing so it's not invisible.
        const decl = declared[name];
        if (!decl) return null;
        const declSpec = specFor(name, decl, state);
        return {
          spec: declSpec,
          endpoints: endpoints(declSpec),
          info: null,
          declared: true,
          missing: true,
        };
      }),
    ]);
    return sendJson(
      res,
      200,
      networks
        .filter((n) => n !== null)
        .map((n) => ({
          ...n,
          containers: n.missing ? [] : (containers.get(n.spec.name) ?? []),
        })),
    );
  }
  if (method === 'GET' && path === '/api/jobs') {
    return sendJson(
      res,
      200,
      jobs
        .slice()
        .reverse()
        .map(({ log: _log, ...rest }) => rest),
    );
  }
  const jobMatch = method === 'GET' && path.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch) {
    const job = jobs.find((j) => j.id === jobMatch[1]);
    return job
      ? sendJson(res, 200, job)
      : sendJson(res, 404, { error: 'no such job' });
  }

  const amendMatch =
    method === 'GET' && path.match(/^\/api\/networks\/([^/]+)\/amendments$/);
  if (amendMatch) {
    const name = amendMatch[1] ?? '';
    if (!NAME_RE.test(name))
      return sendJson(res, 400, { error: 'invalid name' });
    const spec = await loadSpec(name);
    if (!spec)
      return sendJson(res, 404, { error: `no network named "${name}"` });
    if (spec.type !== 'testnet') {
      return sendJson(res, 400, { error: 'amendments only apply to testnet' });
    }
    try {
      const stdout = await composeOutputAsync(
        name,
        ['exec', '-T', 'node', 'xahaud', '--conf', 'xahaud.cfg', 'feature'],
        10_000,
      );
      return sendJson(res, 200, parseFeatureList(stdout));
    } catch (err) {
      return sendJson(res, 502, { error: (err as Error).message });
    }
  }

  if (method === 'POST') {
    // A cross-site <form> can't send application/json without a CORS
    // preflight, which this server never answers: that is the CSRF guard.
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, {
        error: 'content-type must be application/json',
      });
    }
    const body = await readJsonBody(req);

    if (path === '/api/state') {
      const yml = body.yml;
      if (typeof yml !== 'string') {
        return sendJson(res, 400, { error: 'yml must be a string' });
      }
      try {
        parseState(yml);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      if (busy(res, '*')) return;
      // Written verbatim - the operator's own formatting/comments, not a
      // round-trip through the YAML serializer.
      await writeFile(opts.file, yml);
      return enqueue(
        res,
        '*',
        [['apply', '--yes', '--file', opts.file]],
        LONG_STEP_TIMEOUT_MS,
      );
    }

    if (path === '/api/plan') {
      const yml = body.yml;
      if (typeof yml !== 'string') {
        return sendJson(res, 400, { error: 'yml must be a string' });
      }
      let state: State;
      try {
        state = parseState(yml);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      const plans = await planState(state);
      return sendJson(res, 200, {
        plan: describePlan(plans),
        steps: plans.map((p) => ({
          name: p.name,
          actions: p.actions,
          reason: p.reason,
        })),
      });
    }

    if (path === '/api/networks') {
      const {
        name,
        version,
        validators: validatorsIn = 3,
        root = false,
      } = body;
      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        return sendJson(res, 400, { error: 'invalid name' });
      }
      if (typeof version !== 'string' || !VERSION_RE.test(version)) {
        return sendJson(res, 400, { error: 'invalid version' });
      }
      if (
        typeof validatorsIn !== 'number' ||
        !Number.isInteger(validatorsIn) ||
        (validatorsIn !== 1 && (validatorsIn < 3 || validatorsIn > 20))
      ) {
        return sendJson(res, 400, { error: 'validators must be 1 or 3..20' });
      }
      const validators = validatorsIn;
      if (busy(res, name)) return;
      const state = await loadState(opts.file);
      state.networks ??= {};
      if (state.networks[name]) {
        return sendJson(res, 409, {
          error: `"${name}" is already declared in ${opts.file}`,
        });
      }
      state.networks[name] = {
        version,
        ...(validators !== 3 ? { validators } : {}),
        ...(root ? { root: true } : {}),
      };
      await saveState(opts.file, state);
      return enqueue(
        res,
        name,
        [['apply', '--yes', '--file', opts.file, '--only', name]],
        LONG_STEP_TIMEOUT_MS,
      );
    }

    const actionMatch = path.match(/^\/api\/networks\/([^/]+)\/([a-z]+)$/);
    const verb = actionMatch?.[2] ?? '';
    if (actionMatch) {
      const name = actionMatch[1] ?? '';
      if (!NAME_RE.test(name))
        return sendJson(res, 400, { error: 'invalid name' });
      // hasOwn: `constructor` etc. would otherwise resolve through the prototype.
      if (Object.hasOwn(IMPERATIVE_ACTIONS, verb)) {
        const timeoutMs =
          verb === 'reset' ? LONG_STEP_TIMEOUT_MS : SHORT_STEP_TIMEOUT_MS;
        try {
          return enqueue(
            res,
            name,
            [IMPERATIVE_ACTIONS[verb]?.(name, body) ?? []],
            timeoutMs,
          );
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      if (
        verb === 'start' ||
        verb === 'stop' ||
        verb === 'remove' ||
        verb === 'upgrade'
      ) {
        return handleDeclaredAction(res, opts, name, verb, body);
      }
    }
  }
  sendJson(res, 404, { error: 'not found' });
}

export async function startPanel(opts: PanelOptions): Promise<void> {
  // The CLI (run as child processes below) and the workspace scan both use
  // paths relative to the repo root, whatever directory the panel was
  // started from (systemd, cron, ...).
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  panelHtml = await readFile(
    fileURLToPath(new URL('./panel.html', import.meta.url)),
    'utf8',
  );

  if (!opts.accessTeam || !opts.accessAud) {
    console.warn(
      'warning: --insecure-no-auth: the panel accepts any loopback client; never tunnel or forward this port',
    );
  }

  const server = http.createServer((req, res) => {
    checkAuth(req, opts)
      .then((auth) => {
        if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });
        if (req.method !== 'GET') {
          console.log(`[panel] ${auth.who}: ${req.method} ${req.url}`);
        }
        return route(req, res, opts);
      })
      .catch((err) => {
        console.error(err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: (err as Error).message });
        }
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port, opts.host, resolve),
  );
  console.log(`xng panel listening on http://${opts.host}:${opts.port}`);
}
