import { describe, expect, it } from 'vitest';
import { GOE_CAR, GoePort } from './goe.ts';
import type { FetchFn } from './types.ts';

// Payload shapes from the go-e HTTP API v2 docs (not verified against hardware).
function fakeGoe(init: { wh?: number; car?: number | null; frc?: number; reject?: string } = {}) {
  const state = { wh: init.wh ?? 1234.5, car: init.car === undefined ? GOE_CAR.waitCar : init.car, frc: init.frc ?? 0, alw: false, err: 0 };
  const urls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    urls.push(input);
    const url = new URL(input);
    if (url.pathname === '/api/status') {
      const nrg = [230, 231, 229, 0, 16, 16, 16, 3680, 3690, 3670, 0, state.car === GOE_CAR.charging ? 11040 : 0, 100, 100, 100, 0];
      return Response.json({ ...state, alw: state.frc === 2, nrg });
    }
    if (url.pathname === '/api/set') {
      if (init.reject) return Response.json({ frc: init.reject });
      state.frc = Number(url.searchParams.get('frc'));
      if (state.frc === 2 && state.car === GOE_CAR.waitCar) state.car = GOE_CAR.charging;
      if (state.frc === 1 && state.car === GOE_CAR.charging) state.car = GOE_CAR.complete;
      return Response.json({ frc: true });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, urls, state };
}

describe('GoePort (docs-based, untested on hardware)', () => {
  it('reads wh, car, frc and total power with a filtered status request', async () => {
    const goe = fakeGoe();
    const port = new GoePort({ url: 'http://192.168.0.75/', fetch: goe.fetchFn });
    const r = await port.read();
    expect(goe.urls[0]).toBe('http://192.168.0.75/api/status?filter=wh,car,frc,alw,nrg,err');
    expect(r).toMatchObject({ sessionWh: 0, connected: true, charging: false, enabled: false, powerW: 0 });
    expect(port.label).toBe('go-e charger http://192.168.0.75');
  });

  it('start() takes the wh baseline and forces charging on (frc=2); stop() forces off (frc=1)', async () => {
    const goe = fakeGoe({ wh: 1000 });
    const port = new GoePort({ url: 'http://192.168.0.75', fetch: goe.fetchFn });
    await port.start();
    expect(goe.urls.at(-1)).toBe('http://192.168.0.75/api/set?frc=2');
    goe.state.wh = 1100.25;
    const r = await port.read();
    expect(r).toMatchObject({ sessionWh: 100.25, charging: true, enabled: true, powerW: 11040, connected: true });
    await port.stop();
    expect(goe.urls.at(-1)).toBe('http://192.168.0.75/api/set?frc=1');
    expect(await port.read()).toMatchObject({ enabled: false, charging: false, connected: true });
  });

  it('maps car states: idle = unplugged, complete = plugged but not charging, null = unknown', async () => {
    for (const [car, connected] of [
      [GOE_CAR.idle, false],
      [GOE_CAR.charging, true],
      [GOE_CAR.waitCar, true],
      [GOE_CAR.complete, true],
      [GOE_CAR.error, false],
      [null, false],
    ] as const) {
      const port = new GoePort({ url: 'http://goe', fetch: fakeGoe({ car }).fetchFn });
      expect(await port.isConnected()).toBe(connected);
    }
  });

  it('treats a wh reset (new plug-in) as unplugged', async () => {
    const goe = fakeGoe({ wh: 500 });
    const port = new GoePort({ url: 'http://goe', fetch: goe.fetchFn });
    await port.start();
    goe.state.wh = 700;
    expect(await port.readSessionWh()).toBe(200);
    goe.state.wh = 0;
    expect(await port.read()).toMatchObject({ sessionWh: 200, connected: false });
  });

  it('rejects a refused set and malformed status payloads', async () => {
    const port = new GoePort({ url: 'http://goe', fetch: fakeGoe({ reject: 'value not allowed' }).fetchFn });
    await expect(port.start()).rejects.toThrow('go-e /api/set?frc=2 was rejected: {"frc":"value not allowed"}');
    const broken = new GoePort({ url: 'http://goe', fetch: async () => Response.json({ car: 1 }) });
    await expect(broken.read()).rejects.toThrow('unexpected payload');
  });

  it('supports the legacy JSON-array filter of firmware <= 051.3', async () => {
    const goe = fakeGoe();
    const port = new GoePort({ url: 'http://goe', fetch: goe.fetchFn, legacyFilter: true });
    await port.read();
    expect(new URL(goe.urls[0]).searchParams.get('filter')).toBe('["wh","car","frc","alw","nrg","err"]');
  });
});
