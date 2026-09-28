// One kiosk controller per page (and, via Web Locks, per browser and mode), shared by
// /#/wallbox and /#/demo so navigating between them never starts a second charger loop.
import { ChargerSim } from '../../sim/charger-sim.ts';
import type { AppEnv } from '../app-context.tsx';
import { KioskController } from './kiosk-controller.ts';

let instance: KioskController | null = null;

export function getKiosk(env: AppEnv): KioskController {
  if (!instance) {
    instance = new KioskController({
      chain: env.chain,
      sim: new ChargerSim({ speed: env.flags.speed }),
      storage: env.storage,
      mode: env.chain.kind,
      locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : undefined,
    });
  }
  return instance;
}
