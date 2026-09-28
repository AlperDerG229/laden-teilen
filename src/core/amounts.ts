// Pure amount math. All money is bigint in micro-units (10^-6 EURC); no floating point.

/** Micro-units per token unit: EURC and USDC both have 6 decimals. */
export const MICRO_DECIMALS = 6;
export const MICRO_PER_UNIT = 1_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Parses a decimal string ("0.39", "0,39", "5", ".5") into integer base units.
 * Throws on anything else, including more fractional digits than `decimals`.
 */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new Error(`Invalid amount: "${input}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals}): "${input}"`);
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole || '0') * scale + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Formats integer base units as a decimal string without trailing zeros (unless `minDecimals`). */
export function formatUnits(value: bigint, decimals: number, minDecimals = 0): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** '0.39' -> 390000n */
export const parseEurToMicro = (eur: string): bigint => parseUnits(eur, MICRO_DECIMALS);

/** 39000n -> '0.039'; formatMicro(5000000n, 2) -> '5.00' */
export const formatMicro = (micro: bigint, minDecimals = 0): string => formatUnits(micro, MICRO_DECIMALS, minDecimals);

/**
 * Price of one step: priceMicroPerKWh * stepWh / 1000, rounded down (in the guest's favour).
 * stepMicro(390000n, 100) === 39000n
 */
export function stepMicro(priceMicroPerKWh: bigint, stepWh: number): bigint {
  if (priceMicroPerKWh < 0n) throw new Error('Price must not be negative');
  if (!Number.isSafeInteger(stepWh) || stepWh <= 0) throw new Error(`Invalid step size: ${stepWh} Wh`);
  return (priceMicroPerKWh * BigInt(stepWh)) / 1000n;
}

/** 1_500_000n lamports -> '0.0015' */
export const formatSol = (lamports: bigint, minDecimals = 0): string => formatUnits(lamports, 9, minDecimals);

/** 1250 Wh -> '1.25' kWh (fixed decimals, for display). */
export const formatKwh = (wh: number, decimals = 2): string => (wh / 1000).toFixed(decimals);
