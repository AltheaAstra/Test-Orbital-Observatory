/// <reference lib="webworker" />
import { eciToEcf, eciToEcfVelocity, eciToGeodetic, ecfToLookAngles, degreesToRadians, degreesLong, gstime, json2satrec, propagate, shadowFraction, sunPos, jday } from './satellite-core';
import type { CatalogObject, Observer, SatellitePosition, SkyTrackPoint } from './types';

type Message = { type: 'init'; objects: CatalogObject[] }
  | { type: 'tick'; observer: Observer; at: number; horizon: number; selectedId?: string }
  | { type: 'sky-track'; observer: Observer; at: number; horizon: number; objectId: string };
let catalog: CatalogObject[] = [];
let satrecs: Array<ReturnType<typeof json2satrec> | null> = [];
let lastForecast = 0;
let lastForecastKey = '';
let lastTickAt: number | null = null;
let passWindows = new Map<string, { ends: number; rises: number | null; nextEnds: number | null }>();

function propagateOne(object: CatalogObject, satrec: ReturnType<typeof json2satrec> | null, observer: Observer, at: Date): SatellitePosition | null {
  if (!satrec) return null;
  try {
    const state = propagate(satrec, at, { communityDecayCheckEnabled: true });
    if (!state) return null;
    const gmst = gstime(at);
    const ecf = eciToEcf(state.position, gmst);
    const velocityEcf = eciToEcfVelocity(state.position, state.velocity, gmst);
    const gd = eciToGeodetic(state.position, gmst);
    const look = ecfToLookAngles({ longitude: degreesToRadians(observer.longitude), latitude: degreesToRadians(observer.latitude), height: observer.altitudeKm }, ecf);
    const speedKmS = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    const sun = sunPos(jday(at)).rsun;
    const illuminationFraction = shadowFraction(sun, state.position);
    if (![gd.latitude, gd.longitude, gd.height, speedKmS, look.azimuth, look.elevation, look.rangeSat].every(Number.isFinite)) return null;
    return {
      catalogId: object.catalogId, name: object.name, category: object.category, orbitType: object.orbitType,
      latitude: gd.latitude * 180 / Math.PI, longitude: degreesLong(gd.longitude), altitudeKm: gd.height,
      speedKmS, azimuth: (look.azimuth * 180 / Math.PI + 360) % 360, elevation: look.elevation * 180 / Math.PI,
      rangeKm: look.rangeSat, periodMinutes: 1440 / object.orbital.MEAN_MOTION, epoch: object.orbital.EPOCH,
      sunlit: illuminationFraction < 0.5, illuminationFraction,
      positionEciKm: { ...state.position }, positionEcfKm: { ...ecf },
      velocityEciKmS: { ...state.velocity }, velocityEcfKmS: { ...velocityEcf },
      nextVisibilityAt: null, nextVisibilityEndAt: null,
      remainingPassMinutes: null, predicted: true,
    };
  } catch { return null; }
}

function forecastPasses(observer: Observer, at: Date, horizon: number, nowResults: SatellitePosition[]) {
  passWindows = new Map();
  const visible = new Set(nowResults.filter((item) => item.elevation >= horizon).map((item) => item.catalogId));
  for (let i = 0; i < catalog.length; i += 1) {
    if (!visible.has(catalog[i].catalogId)) continue;
    const current = nowResults.find((item) => item.catalogId === catalog[i].catalogId);
    if (!current) continue;
    const periodMs = 1440 / catalog[i].orbital.MEAN_MOTION * 60_000;
    let forecastSatrec: ReturnType<typeof json2satrec>;
    try { forecastSatrec = json2satrec(catalog[i].orbital); } catch { continue; }
    const scanMs = Math.min(3 * 60 * 60 * 1000, Math.max(8 * 60_000, periodMs * 0.6));
    let remaining = scanMs;
    for (let dt = 30_000; dt <= scanMs; dt += 30_000) {
      const point = propagateOne(catalog[i], forecastSatrec, observer, new Date(at.getTime() + dt));
      if (!point || point.elevation < horizon) { remaining = dt; break; }
    }
    const ends = at.getTime() + remaining;
    let rises: number | null = null;
    let nextEnds: number | null = null;
    const nextPassSearch = Math.min(2 * 24 * 60 * 60_000, Math.max(4 * 60 * 60_000, periodMs * 2));
    let insideNextPass = false;
    for (let dt = remaining + 60_000; dt <= remaining + nextPassSearch; dt += 60_000) {
      const point = propagateOne(catalog[i], forecastSatrec, observer, new Date(at.getTime() + dt));
      const visibleNext = Boolean(point && point.elevation >= horizon);
      if (visibleNext && !insideNextPass) {
        rises = at.getTime() + dt;
        insideNextPass = true;
      } else if (!visibleNext && insideNextPass) {
        nextEnds = at.getTime() + dt;
        break;
      }
    }
    passWindows.set(catalog[i].catalogId, { ends, rises, nextEnds });
  }
  lastForecast = at.getTime();
}

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === 'init') {
    catalog = message.objects;
    satrecs = catalog.map((object) => { try { return json2satrec(object.orbital); } catch { return null; } });
    lastTickAt = null;
    lastForecast = 0;
    lastForecastKey = '';
    self.postMessage({ type: 'ready', count: catalog.length });
    return;
  }
  if (message.type === 'sky-track') {
    const index = catalog.findIndex((object) => object.catalogId === message.objectId);
    const track: SkyTrackPoint[] = [];
    if (index >= 0) {
      let trackSatrec: ReturnType<typeof json2satrec>;
      try { trackSatrec = json2satrec(catalog[index].orbital); } catch { self.postMessage({ type: 'sky-track', objectId: message.objectId, track }); return; }
      const base = new Date(message.at);
      const current = propagateOne(catalog[index], trackSatrec, message.observer, base);
      let risen = Boolean(current && current.elevation >= message.horizon);
      if (risen && current) track.push({ azimuth: current.azimuth, elevation: current.elevation, time: base.toISOString() });
      let seenAbove = risen;
      for (let dt = 30_000; dt <= 24 * 60 * 60_000; dt += 30_000) {
        const time = new Date(base.getTime() + dt);
        const point = propagateOne(catalog[index], trackSatrec, message.observer, time);
        const visible = Boolean(point && point.elevation >= message.horizon);
        if (visible && point) {
          risen = true;
          track.push({ azimuth: point.azimuth, elevation: point.elevation, time: time.toISOString() });
        } else if (risen && seenAbove) break;
        else if (visible) seenAbove = true;
        if (risen) seenAbove = true;
      }
    }
    self.postMessage({ type: 'sky-track', objectId: message.objectId, track });
    return;
  }
  if (message.type !== 'tick') return;
  const at = new Date(message.at);
  if (lastTickAt !== null && (message.at <= lastTickAt || message.at - lastTickAt > 24 * 60 * 60_000)) {
    satrecs = catalog.map((object) => { try { return json2satrec(object.orbital); } catch { return null; } });
    lastForecast = 0;
    lastForecastKey = '';
  }
  lastTickAt = message.at;
  const positions = new Float64Array(catalog.length * 3);
  positions.fill(Number.NaN);
  const overhead: SatellitePosition[] = [];
  let selected: SatellitePosition | null = null;
  let valid = 0;
  for (let i = 0; i < catalog.length; i += 1) {
    const point = propagateOne(catalog[i], satrecs[i], message.observer, at);
    if (!point) continue;
    positions[i * 3] = point.longitude;
    positions[i * 3 + 1] = point.latitude;
    positions[i * 3 + 2] = Math.max(0, point.altitudeKm) * 1000;
    valid += 1;
    if (point.elevation >= message.horizon) overhead.push(point);
    if (catalog[i].catalogId === message.selectedId) selected = point;
  }
  const forecastKey = `${message.observer.latitude}:${message.observer.longitude}:${message.observer.altitudeKm}:${message.horizon}`;
  const shouldForecast = forecastKey !== lastForecastKey || Math.abs(at.getTime() - lastForecast) > 300_000;
  if (shouldForecast) {
    forecastPasses(message.observer, at, message.horizon, overhead);
    lastForecastKey = forecastKey;
  }
  for (const point of overhead) {
    const pass = passWindows.get(point.catalogId);
    if (pass) {
      point.remainingPassMinutes = Math.max(0, (pass.ends - at.getTime()) / 60_000);
      point.nextVisibilityAt = pass.rises === null ? null : new Date(pass.rises).toISOString();
      point.nextVisibilityEndAt = pass.nextEnds === null ? null : new Date(pass.nextEnds).toISOString();
    }
  }
  if (selected) {
    const pass = passWindows.get(selected.catalogId);
    if (pass) {
      selected.remainingPassMinutes = Math.max(0, (pass.ends - at.getTime()) / 60_000);
      selected.nextVisibilityAt = pass.rises === null ? null : new Date(pass.rises).toISOString();
      selected.nextVisibilityEndAt = pass.nextEnds === null ? null : new Date(pass.nextEnds).toISOString();
    }
  }
  self.postMessage({ type: 'positions', positions: positions.buffer, overhead, selected, valid, at: at.toISOString() }, [positions.buffer]);
};

export {};
