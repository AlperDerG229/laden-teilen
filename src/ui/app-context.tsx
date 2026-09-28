import { createContext, useContext } from 'react';
import type { AppChain } from './chain/types.ts';
import type { AppFlags } from './env.ts';
import type { KeyValueStorage } from './storage.ts';

export interface AppEnv {
  chain: AppChain;
  flags: AppFlags;
  /** Base URL of this deployment (origin + Vite base), used in QR codes. */
  baseUrl: string;
  storage: KeyValueStorage;
}

export const AppEnvContext = createContext<AppEnv | null>(null);

export function useAppEnv(): AppEnv {
  const env = useContext(AppEnvContext);
  if (!env) throw new Error('AppEnvContext missing');
  return env;
}

export const useChain = (): AppChain => useAppEnv().chain;
