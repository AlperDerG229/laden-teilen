import type { Address } from '@solana/kit';
import type { ChainClient } from '../../core/chain.ts';
import type { ChargerChain } from '../../core/session.ts';

export type ChainKind = 'devnet' | 'mock';

/**
 * The chain port of the UI: the core ChainClient plus the few extras the screens need, so no
 * screen ever touches `client.rpc` directly. Implemented by the devnet adapter (Kit + public RPC)
 * and by the MOCK ledger (src/sim/mock-chain.ts).
 */
export interface AppChain extends ChainClient {
  readonly kind: ChainKind;
  /** Charger port for ChargerSession (kiosk). */
  charger(): ChargerChain;
  /** Lamports moved by System transfers from `from` to `to` in tx `sig` (e.g. the end-tx refund). */
  getTransferredLamports(sig: string, from: Address, to: Address): Promise<bigint | null>;
  /** devnet: one RPC airdrop request (often rate limited). mock: instant MOCK SOL + test tokens. */
  requestTestFunds(address: Address): Promise<string>;
  /** Explorer links, or null when the tx only exists in the MOCK ledger. */
  explorerTxUrl(sig: string): string | null;
  explorerAddressUrl(address: string): string | null;
}
