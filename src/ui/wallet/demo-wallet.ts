// "Demo wallet (devnet)": an in-page keypair kept in localStorage, clearly labelled in the UI.
// Devnet/MOCK only. The demo video injects a pre-funded key by writing the same storage key
// (a JSON array of 32 private-key bytes or 64 solana-keygen bytes) before the page loads, e.g.
//   page.addInitScript(s => localStorage.setItem('lt:devnet:demo-wallet', s), secretJson)
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';
import type { ChainKind } from '../chain/types.ts';
import { nsKey, type KeyValueStorage } from '../storage.ts';

export const demoWalletKey = (mode: ChainKind): string => nsKey(mode, 'demo-wallet');

function parseSecret(raw: string | null): Uint8Array | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || (arr.length !== 32 && arr.length !== 64)) return null;
    if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    return Uint8Array.from(arr as number[]);
  } catch {
    return null;
  }
}

/** Loads the demo wallet, creating (and persisting) a fresh one when none exists. */
export async function loadDemoWallet(storage: KeyValueStorage, mode: ChainKind): Promise<KeyPairSigner> {
  const key = demoWalletKey(mode);
  const secret = parseSecret(storage.getItem(key));
  if (secret) {
    try {
      return secret.length === 64 ? await createKeyPairSignerFromBytes(secret) : await createKeyPairSignerFromPrivateKeyBytes(secret);
    } catch {
      // corrupt key: fall through and create a new one
    }
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  storage.setItem(key, JSON.stringify([...fresh]));
  return createKeyPairSignerFromPrivateKeyBytes(fresh);
}

export const hasDemoWallet = (storage: KeyValueStorage, mode: ChainKind): boolean => parseSecret(storage.getItem(demoWalletKey(mode))) !== null;
