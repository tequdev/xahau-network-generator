import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { parseFeatureList, verifyAccessJwt } from './panel.ts';
import type { Jwk } from './panel.ts';

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function makeToken(
  privateKey: import('node:crypto').KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function setup() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = 'test-kid-1';
  const keys: Jwk[] = [{ ...jwk, kid } as Jwk];
  const issuer = 'https://myteam.cloudflareaccess.com';
  const aud = 'app-aud-tag';
  const now = 1_700_000_000_000;
  const validPayload = {
    iss: issuer,
    aud,
    exp: now / 1000 + 3600,
    nbf: now / 1000 - 60,
    email: 'someone@example.com',
  };
  const token = makeToken(privateKey, { alg: 'RS256', kid }, validPayload);
  return { privateKey, keys, issuer, aud, now, token, validPayload, kid };
}

test('verifyAccessJwt accepts a validly signed, in-window token', () => {
  const { keys, issuer, aud, now, token } = setup();
  const result = verifyAccessJwt(token, { issuer, aud, keys, now });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.email, 'someone@example.com');
});

test('verifyAccessJwt rejects wrong audience', () => {
  const { keys, issuer, now, token } = setup();
  const result = verifyAccessJwt(token, {
    issuer,
    aud: 'other-aud',
    keys,
    now,
  });
  assert.equal(result.ok, false);
});

test('verifyAccessJwt rejects wrong issuer', () => {
  const { keys, aud, now, token } = setup();
  const result = verifyAccessJwt(token, {
    issuer: 'https://not-my-team.cloudflareaccess.com',
    aud,
    keys,
    now,
  });
  assert.equal(result.ok, false);
});

test('verifyAccessJwt rejects an expired token', () => {
  const { privateKey, keys, issuer, aud, now, kid } = setup();
  const token = makeToken(
    privateKey,
    { alg: 'RS256', kid },
    { iss: issuer, aud, exp: now / 1000 - 10 },
  );
  const result = verifyAccessJwt(token, { issuer, aud, keys, now });
  assert.equal(result.ok, false);
});

test('verifyAccessJwt rejects a tampered payload', () => {
  const { keys, issuer, aud, now, token } = setup();
  const [h, p, s] = token.split('.');
  const tamperedPayload = base64Url(
    JSON.stringify({ iss: issuer, aud, exp: now / 1000 + 3600 }),
  );
  const tampered = `${h}.${tamperedPayload}.${s}`;
  const result = verifyAccessJwt(tampered, { issuer, aud, keys, now });
  assert.equal(result.ok, false);
});

test('verifyAccessJwt rejects an unknown kid', () => {
  const { issuer, aud, now, token } = setup();
  const result = verifyAccessJwt(token, { issuer, aud, keys: [], now });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unknown kid');
});

test('verifyAccessJwt rejects alg:none', () => {
  const { privateKey, keys, issuer, aud, now, kid } = setup();
  // Sign it for real (so the signature part is well-formed) but claim alg:none.
  const token = makeToken(
    privateKey,
    { alg: 'none', kid },
    { iss: issuer, aud, exp: now / 1000 + 3600 },
  );
  const result = verifyAccessJwt(token, { issuer, aud, keys, now });
  assert.equal(result.ok, false);
});

test('parseFeatureList sorts by name and keeps optional fields', () => {
  const stdout = JSON.stringify({
    result: {
      status: 'success',
      features: {
        AAAA: { name: 'fixZzz', enabled: true, supported: true },
        BBBB: {
          name: 'fixAaa',
          enabled: false,
          supported: true,
          vetoed: false,
          count: 2,
          threshold: 3,
        },
      },
    },
  });
  const list = parseFeatureList(stdout);
  assert.deepEqual(
    list.map((f) => f.name),
    ['fixAaa', 'fixZzz'],
  );
  const aaa = list.find((f) => f.name === 'fixAaa');
  assert.deepEqual(aaa, {
    hash: 'BBBB',
    name: 'fixAaa',
    enabled: false,
    supported: true,
    vetoed: false,
    count: 2,
    threshold: 3,
  });
});

test('parseFeatureList throws on garbage input', () => {
  assert.throws(() => parseFeatureList('not json'));
  assert.throws(() => parseFeatureList('{"result":{"status":"success"}}'));
});
