import { encodeNodePublic } from 'xahau-address-codec';
import { encode } from 'xahau-binary-codec';
import {
  deriveAddress,
  deriveKeypair,
  generateSeed,
  sign,
  verify,
} from 'xahau-keypairs';

export type Keypair = { privateKey: string; publicKey: string };

export type Manifest = { hex: string; base64: string };

export function signManifest(opts: {
  sequence: number;
  masterKeypair: Keypair;
  signingKeypair: Keypair;
}): Manifest {
  const { sequence, masterKeypair, signingKeypair } = opts;
  const unsigned = encode({
    Sequence: sequence,
    PublicKey: masterKeypair.publicKey,
    SigningPubKey: signingKeypair.publicKey,
  });
  const data = Buffer.concat([
    Buffer.from('MAN\0', 'ascii'),
    Buffer.from(unsigned, 'hex'),
  ]);
  const dataHex = data.toString('hex');
  const Signature = sign(dataHex, signingKeypair.privateKey);
  const MasterSignature = sign(dataHex, masterKeypair.privateKey);
  const full = encode({
    Sequence: sequence,
    PublicKey: masterKeypair.publicKey,
    SigningPubKey: signingKeypair.publicKey,
    Signature,
    MasterSignature,
  });
  return {
    hex: full.toUpperCase(),
    base64: Buffer.from(full, 'hex').toString('base64'),
  };
}

export type ValidatorKeys = {
  master: Keypair;
  signing: Keypair;
  manifest: Manifest;
  token: string;
  publicKeyHex: string;
  nodePublic: string;
};

export function createValidatorKeys(): ValidatorKeys {
  const master = deriveKeypair(generateSeed({ algorithm: 'ed25519' }));
  const signing = deriveKeypair(generateSeed({ algorithm: 'ecdsa-secp256k1' }));
  const manifest = signManifest({
    sequence: 1,
    masterKeypair: master,
    signingKeypair: signing,
  });
  const token = Buffer.from(
    JSON.stringify({
      validation_secret_key: signing.privateKey.slice(2),
      manifest: manifest.base64,
    }),
  ).toString('base64');
  return {
    master,
    signing,
    manifest,
    token,
    publicKeyHex: master.publicKey,
    nodePublic: encodeNodePublic(Buffer.from(master.publicKey, 'hex')),
  };
}

export function createFaucetKeys(): { seed: string; address: string } {
  const seed = generateSeed({ algorithm: 'ed25519' });
  const { publicKey } = deriveKeypair(seed);
  const address = deriveAddress(publicKey);
  return { seed, address };
}

export type PublisherKeys = {
  master: Keypair;
  ephemeral: Keypair;
  manifest: Manifest;
};

export function createPublisherKeys(): PublisherKeys {
  const master = deriveKeypair(generateSeed({ algorithm: 'ed25519' }));
  const ephemeral = deriveKeypair(generateSeed({ algorithm: 'ed25519' }));
  const manifest = signManifest({
    sequence: 1,
    masterKeypair: master,
    signingKeypair: ephemeral,
  });
  return { master, ephemeral, manifest };
}

const RIPPLE_EPOCH_OFFSET = 946684800;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

export type VlValidatorEntry = { publicKeyHex: string; manifestBase64: string };

export function signVl(
  publisher: PublisherKeys,
  validators: VlValidatorEntry[],
  opts: { expiration?: number } = {},
) {
  const nowRipple = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;
  // No `effective`: xahaud only activates a list once its validFrom <= the last
  // closed ledger's close time, and the genesis ledger closes in year 2000.
  const expiration = opts.expiration ?? nowRipple + YEAR_SECONDS;

  const blobJson = {
    sequence: 1,
    expiration,
    validators: validators.map((v) => ({
      validation_public_key: v.publicKeyHex,
      manifest: v.manifestBase64,
    })),
  };
  const blobText = JSON.stringify(blobJson);
  const blob = Buffer.from(blobText).toString('base64');
  const signature = sign(
    Buffer.from(blobText).toString('hex'),
    publisher.ephemeral.privateKey,
  ).toUpperCase();

  if (
    !verify(
      Buffer.from(blobText).toString('hex'),
      signature,
      publisher.ephemeral.publicKey,
    )
  ) {
    throw new Error('vl signature failed to verify');
  }

  return {
    version: 1,
    public_key: publisher.master.publicKey,
    manifest: publisher.manifest.base64,
    blob,
    signature,
  };
}
