// Wallet-standard wallets (Phantom, Solflare, Backpack, ...) via @solana/kit-plugin-wallet.
// Only wallets that can sign without sending (`solana:signTransaction`) are listed: the app sends
// through its own devnet RPC, so a wallet left on mainnet can never broadcast to the wrong cluster.
import { createClient } from '@solana/kit';
import { walletWithoutSigner, type ClientWithWallet } from '@solana/kit-plugin-wallet';

let client: ClientWithWallet | null = null;

export function getWalletClient(): ClientWithWallet {
  client ??= createClient().use(
    walletWithoutSigner({
      chain: 'solana:devnet',
      storageKey: 'lt:wallet-standard',
      filter: (w) => w.features.includes('solana:signTransaction'),
    }),
  );
  return client;
}

/** True when the page runs inside a mobile wallet's in-app browser or a wallet extension exists. */
export const hasInjectedSolana = (): boolean =>
  typeof window !== 'undefined' && ('phantom' in window || 'solana' in window || 'solflare' in window || 'backpack' in window);

export const isMobileBrowser = (): boolean =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
