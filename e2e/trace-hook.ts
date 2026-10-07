import { encode, encodeForSigning } from 'xahau-binary-codec';
import { deriveKeypair, sign } from 'xahau-keypairs';

// Source: trace-hook.wat. Regenerate with:
//   wat2wasm e2e/trace-hook.wat -o /tmp/trace-hook.wasm && xxd -p -u /tmp/trace-hook.wasm | tr -d '\n'
export const TRACE_HOOK_WASM_HEX =
  '0061736D01000000011C0460027F7F017F60057F7F7F7F7F017E60037F7F7E017E60017F017E02230303656E76025F67000003656E76057472616365000103656E76066163636570740002030201030503010001071102066D656D6F7279020004686F6F6B00030A20011E004101410110001A4100410F41004100410010011A41004100420010020B0B15010041000B0F786E6720646562756773747265616D';

export const TRACE_HOOK_MESSAGE = 'xng debugstream';

// HookOn is an inverted mask: a cleared bit enables the hook for that
// transaction type. Only Payment (bit 0) and ttHOOK_SET (bit 22, always
// cleared by convention) are cleared here.
export const TRACE_HOOK_ON =
  'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFFFFE';

// Signs a transaction locally; returns the blob ready for `submit`.
export function signTx(
  tx: Record<string, unknown>,
  seed: string,
): { tx_blob: string } {
  const { publicKey, privateKey } = deriveKeypair(seed);
  const unsigned = { ...tx, SigningPubKey: publicKey };
  const TxnSignature = sign(encodeForSigning(unsigned as never), privateKey);
  return { tx_blob: encode({ ...unsigned, TxnSignature } as never) };
}
