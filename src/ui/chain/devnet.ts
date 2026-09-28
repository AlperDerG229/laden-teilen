// The real chain: core ChainClient (Kit, throttled public devnet RPC) plus the UI extras.
import { lamports, type Address, type Signature } from '@solana/kit';
import { createChargerChain, getChain, type ChainClient } from '../../core/chain.ts';
import { SYSTEM_PROGRAM, explorerAddress, explorerTx } from '../../core/config.ts';
import type { AppChain } from './types.ts';

/** One opportunistic RPC airdrop. The public devnet faucet is often rate limited. */
export const AIRDROP_LAMPORTS = 100_000_000n; // 0.1 SOL

export function createDevnetChain(client: ChainClient = getChain()): AppChain {
  return {
    ...client,
    kind: 'devnet',
    charger: () => createChargerChain(client),
    async getTransferredLamports(sig: string, from: Address, to: Address): Promise<bigint | null> {
      const tx = await client.rpc
        .getTransaction(sig as Signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .send();
      if (!tx) return null;
      let sum = 0n;
      for (const ix of tx.transaction.message.instructions) {
        if (!('parsed' in ix) || ix.programId !== SYSTEM_PROGRAM) continue;
        const parsed = ix.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number | bigint } };
        if (parsed.type === 'transfer' && parsed.info?.source === from && parsed.info.destination === to) {
          sum += BigInt(parsed.info.lamports ?? 0);
        }
      }
      return sum;
    },
    requestTestFunds: (address: Address) =>
      client.rpc.requestAirdrop(address, lamports(AIRDROP_LAMPORTS), { commitment: 'confirmed' }).send(),
    explorerTxUrl: (sig: string) => explorerTx(sig),
    explorerAddressUrl: (address: string) => explorerAddress(address),
  };
}
