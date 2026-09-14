import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode } from 'xahau-binary-codec';
import { deriveAddress, deriveKeypair, verify } from 'xahau-keypairs';
import {
  createFaucetKeys,
  createPublisherKeys,
  createValidatorKeys,
  signVl,
} from './keys.ts';

test('validator manifest round-trips through xahau-binary-codec', () => {
  const v = createValidatorKeys();
  const decoded = decode(v.manifest.hex) as Record<string, unknown>;
  assert.equal(decoded.Sequence, 1);
  assert.equal(decoded.PublicKey, v.master.publicKey);
  assert.equal(decoded.SigningPubKey, v.signing.publicKey);
});

test('validator token decodes to json with a 64-char hex secret', () => {
  const v = createValidatorKeys();
  const decoded = JSON.parse(Buffer.from(v.token, 'base64').toString('utf8'));
  assert.match(decoded.validation_secret_key, /^[0-9A-Fa-f]{64}$/);
  assert.equal(decoded.manifest, v.manifest.base64);
});

test('faucet keys: seed/address prefixes and address derives from seed', () => {
  const f = createFaucetKeys();
  assert.match(f.seed, /^sEd/);
  assert.match(f.address, /^r/);
  assert.equal(deriveAddress(deriveKeypair(f.seed).publicKey), f.address);
});

test('vl.json signature verifies and blob decodes with validators', () => {
  const publisher = createPublisherKeys();
  const validator = createValidatorKeys();
  const vl = signVl(publisher, [
    {
      publicKeyHex: validator.publicKeyHex,
      manifestBase64: validator.manifest.base64,
    },
  ]);

  const blobText = Buffer.from(vl.blob, 'base64').toString('utf8');
  const ok = verify(
    Buffer.from(blobText).toString('hex'),
    vl.signature,
    publisher.ephemeral.publicKey,
  );
  assert.equal(ok, true);

  const blobJson = JSON.parse(blobText);
  assert.equal(blobJson.validators.length, 1);
  assert.equal(
    blobJson.validators[0].validation_public_key,
    validator.publicKeyHex,
  );
});
