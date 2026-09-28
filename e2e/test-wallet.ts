// A wallet-standard wallet test double for Playwright: `page.addInitScript(installTestWallet)`.
// It registers like a browser extension ("wallet-standard:register-wallet"), supports
// standard:connect / standard:events and solana:signTransaction (sign only, never sends), and signs
// with a WebCrypto Ed25519 key. It records every request in window.__testWallet.requests.

export interface TestWalletState {
  requests: { method: 'connect' | 'signTransaction'; chain?: string; bytes?: number }[];
  address?: string;
}

/** Self-contained: serialized into the page by addInitScript. */
export function installTestWallet(): void {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base58 = (bytes: Uint8Array): string => {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    const digits: number[] = [];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
  };
  const readShortVec = (buf: Uint8Array, offset: number): [number, number] => {
    let value = 0;
    let shift = 0;
    let i = offset;
    for (;;) {
      const b = buf[i++];
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return [value, i];
      shift += 7;
    }
  };

  const state: TestWalletState = { requests: [] };
  (window as unknown as { __testWallet: TestWalletState }).__testWallet = state;
  let keys: CryptoKeyPair | null = null;
  let publicKey = new Uint8Array(32);
  let address = '';
  const ready = (async () => {
    keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    address = base58(publicKey);
    state.address = address;
  })();

  const chains = ['solana:devnet', 'solana:mainnet', 'solana:testnet'] as const;
  const listeners: Record<string, ((payload: unknown) => void)[]> = {};
  const emit = (event: string, payload: unknown) => (listeners[event] ?? []).forEach((l) => l(payload));
  let accounts: readonly object[] = [];
  const makeAccount = () =>
    Object.freeze({ address, publicKey: publicKey.slice(), chains, features: ['solana:signTransaction'] as const, label: 'Test account' });

  /** Fills this wallet's signature slot of a wire transaction (legacy or v0). */
  async function sign(tx: Uint8Array): Promise<Uint8Array> {
    const [numSigs, sigStart] = readShortVec(tx, 0);
    const message = tx.slice(sigStart + numSigs * 64);
    let p = (message[0] & 0x80) !== 0 ? 1 : 0; // v0 prefix
    const numRequired = message[p];
    p += 3;
    const [numKeys, keysStart] = readShortVec(message, p);
    let index = -1;
    for (let k = 0; k < Math.min(numKeys, numRequired); k++) {
      const key = message.subarray(keysStart + 32 * k, keysStart + 32 * (k + 1));
      if (key.every((b, i) => b === publicKey[i])) {
        index = k;
        break;
      }
    }
    if (index < 0 || !keys) throw new Error('Test wallet: this account is not a required signer');
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message));
    const out = tx.slice();
    out.set(signature, sigStart + 64 * index);
    return out;
  }

  const icon =
    'data:image/svg+xml;base64,' +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#373f43"/><rect x="8" y="9" width="16" height="14" rx="2" fill="#c1121c"/></svg>');

  const wallet = {
    version: '1.0.0' as const,
    name: 'Test Wallet',
    icon,
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: { silent?: boolean }) => {
          await ready;
          if (input?.silent && accounts.length === 0) return { accounts };
          accounts = [makeAccount()];
          state.requests.push({ method: 'connect' });
          emit('change', { accounts });
          return { accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          accounts = [];
          emit('change', { accounts });
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (event: string, listener: (payload: unknown) => void) => {
          (listeners[event] ??= []).push(listener);
          return () => {
            listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
          };
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0] as const,
        signTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
          const outputs: { signedTransaction: Uint8Array }[] = [];
          for (const input of inputs) {
            state.requests.push({ method: 'signTransaction', chain: input.chain, bytes: input.transaction.length });
            outputs.push({ signedTransaction: await sign(input.transaction) });
          }
          return outputs;
        },
      },
    },
  };

  const register = ({ register: add }: { register: (w: unknown) => void }) => add(wallet);
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent).detail));
}
