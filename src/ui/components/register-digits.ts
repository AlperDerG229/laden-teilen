// Register layout helpers (pure).
import { formatMicro } from '../../core/amounts.ts';

/** Pads a decimal string to the register layout: ("0.6", 4, 1) -> "0000.6". */
export function registerDigits(decimal: string, intDigits: number, decimals: number): string {
  const [i = '0', f = ''] = decimal.split('.');
  const int = i.replace(/^-/, '').slice(-intDigits).padStart(intDigits, '0');
  if (decimals === 0) return int;
  return `${int}.${f.padEnd(decimals, '0').slice(0, decimals)}`;
}

/** kWh register from Wh: whole kWh drums + one red 0.1 kWh drum that turns continuously. */
export function kwhRegister(wh: number, intDigits = 4): { digits: string; lastTurn: number; text: string; value: string } {
  const tenths = Math.floor(Math.max(0, wh) / 100 + 1e-9);
  const turn = Math.max(0, wh) / 100 - tenths;
  const decimal = (tenths / 10).toFixed(1);
  return {
    digits: registerDigits(decimal, intDigits, 1),
    lastTurn: turn > 0.001 ? turn : 0,
    text: `${(Math.max(0, wh) / 1000).toFixed(2)} kWh`,
    value: decimal,
  };
}

/** EURC register from micro-EURC with three decimals: 234000n -> "00.234". */
export function eurRegister(micro: bigint, intDigits = 2): { digits: string; text: string; value: string } {
  const text = formatMicro(micro, 2);
  const [i, f = ''] = text.split('.');
  return { digits: registerDigits(`${i}.${f.padEnd(3, '0')}`, intDigits, 3), text: `${text} EURC`, value: text };
}
