// Error classification shared by chain.ts (producer) and session.ts (consumer).

/**
 * - `program`: the tx was simulated or executed and failed deterministically. Do not retry.
 * - `expired`: the tx can no longer land (blockhash expired or never accepted). Safe to rebuild and retry.
 * - `network`: an RPC/transport failure before anything was sent. Safe to retry.
 * - `unknown`: the outcome could not be determined (the tx may have landed). Do not blindly retry.
 */
export type ChainErrorKind = 'program' | 'expired' | 'network' | 'unknown';

export class ChainError extends Error {
  readonly kind: ChainErrorKind;
  readonly signature: string | undefined;
  readonly logs: readonly string[] | undefined;

  constructor(kind: ChainErrorKind, message: string, opts: { signature?: string; logs?: readonly string[]; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ChainError';
    this.kind = kind;
    this.signature = opts.signature;
    this.logs = opts.logs;
  }
}

/** True when rebuilding the tx with a fresh blockhash cannot cause a double payment. */
export const isRetryableChainError = (e: unknown): boolean =>
  e instanceof ChainError && (e.kind === 'expired' || e.kind === 'network');

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
