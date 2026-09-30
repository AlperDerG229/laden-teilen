// URL builders for the QR codes and the owner flow. Pure, unit-tested.
import { isAddress, type Address } from '@solana/kit';
import { formatMicro, parseEurToMicro, stepMicro } from '../core/amounts.ts';
import { CAP_CHOICES_EUR, DEFAULT_CAP_EUR, DEFAULT_PRICE_EUR, STEP_WH } from '../core/config.ts';
import { href } from './router.ts';

export interface WallboxParams {
  owner: Address;
  /** Canonical decimal string, e.g. "0.39" (always formatMicro(priceMicro)). */
  priceEur: string;
  priceMicroPerKWh: bigint;
  name: string;
  capEur: string;
}

export const DEFAULT_WALLBOX_NAME = 'Wallbox';
const MAX_NAME = 40;

/** Price must give a positive step (>= 1 micro-EURC per 0.1 kWh) and stay sane (< 10 EUR/kWh). */
export function parsePrice(raw: string | null | undefined): { eur: string; micro: bigint } | null {
  if (!raw) return null;
  try {
    const micro = parseEurToMicro(raw);
    if (stepMicro(micro, STEP_WH) <= 0n || micro >= 10_000_000n) return null;
    return { eur: formatMicro(micro), micro };
  } catch {
    return null;
  }
}

export const cleanName = (raw: string | null | undefined): string =>
  (raw ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, MAX_NAME);

export const parseCap = (raw: string | null | undefined): string =>
  (CAP_CHOICES_EUR as readonly string[]).includes(raw ?? '') ? (raw as string) : DEFAULT_CAP_EUR;

/** Reads `o`, `p`, `n`, `cap` from a route. Returns null when the owner is missing or invalid. */
export function readWallboxParams(params: URLSearchParams, fallbackOwner?: string): WallboxParams | null {
  const owner = params.get('o') ?? fallbackOwner ?? '';
  if (!isAddress(owner)) return null;
  const price = parsePrice(params.get('p')) ?? parsePrice(DEFAULT_PRICE_EUR)!;
  return {
    owner,
    priceEur: price.eur,
    priceMicroPerKWh: price.micro,
    name: cleanName(params.get('n')) || DEFAULT_WALLBOX_NAME,
    capEur: parseCap(params.get('cap')),
  };
}

export const wallboxQuery = (w: Pick<WallboxParams, 'owner' | 'priceEur' | 'name' | 'capEur'>) => ({
  o: w.owner,
  p: w.priceEur,
  n: w.name,
  cap: w.capEur,
});

/** Base URL of this deployment, e.g. https://lyvoralper.github.io/laden-teilen/ */
export function appBaseUrl(origin: string, baseUrl: string): string {
  return `${origin}${baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`}`;
}

/** The URL encoded in the kiosk QR code (the guest page for one session key). */
export function guestUrl(base: string, session: string, w: Pick<WallboxParams, 'owner' | 'priceEur' | 'name' | 'capEur'>, mock: boolean): string {
  return `${base}${mock ? '?mock=1' : ''}${href('/charge', { k: session, ...wallboxQuery(w) })}`;
}

/** Phantom's browse deeplink: opens `url` inside Phantom's in-app browser. */
export function phantomBrowseUrl(url: string, ref: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}

export interface GuestParams extends WallboxParams {
  session: Address;
}

/** Parses the guest page route (`#/charge?k=...&o=...`). */
export function readGuestParams(params: URLSearchParams): GuestParams | null {
  const session = params.get('k') ?? '';
  const w = readWallboxParams(params);
  if (!w || !isAddress(session) || session === w.owner) return null;
  return { ...w, session };
}

/** Parses a scanned QR URL (full URL) into guest params. */
export function parseGuestUrl(url: string): GuestParams | null {
  try {
    const u = new URL(url);
    const i = u.hash.indexOf('?');
    if (!u.hash.startsWith('#/charge')) return null;
    return readGuestParams(new URLSearchParams(i >= 0 ? u.hash.slice(i + 1) : ''));
  } catch {
    return null;
  }
}
