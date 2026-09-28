import { isAddress, type Address } from '@solana/kit';
import { readEnv } from '../core/config.ts';

/**
 * Default payout address for the public demo: the devnet-only dev treasury's public key, so EURC
 * paid in demo sessions flows back to the account that funds demo wallets. Override with
 * VITE_DEMO_OWNER. (A public key only; the treasury secret is never part of the app.)
 */
const fallback = 'gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD';
const fromEnv = readEnv('VITE_DEMO_OWNER');
export const DEMO_OWNER: Address = (fromEnv && isAddress(fromEnv) ? fromEnv : fallback) as Address;
export const DEMO_WALLBOX_NAME = 'Garage Sonnenweg 12';
