import {
  degreesLong, eciToEcf, eciToEcfVelocity, eciToGeodetic, ecfToLookAngles, degreesToRadians,
  json2satrec, propagate, gstime, shadowFraction, sunPos, jday,
} from './satellite-core';
import type { CatalogObject, Observer, SatellitePosition } from './types';

export function propagateObject(object: CatalogObject, observer: Observer, at: Date): SatellitePosition | null {
  try {
    const satrec = json2satrec(object.orbital);
    const state = propagate(satrec, at, { communityDecayCheckEnabled: true });
    if (!state) return null;
    const gmst = gstime(at);
    const ecf = eciToEcf(state.position, gmst);
    const velocityEcf = eciToEcfVelocity(state.position, state.velocity, gmst);
    const geodetic = eciToGeodetic(state.position, gmst);
    const look = ecfToLookAngles({ longitude: degreesToRadians(observer.longitude), latitude: degreesToRadians(observer.latitude), height: observer.altitudeKm }, ecf);
    const speedKmS = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    const { rsun } = sunPos(jday(at));
    const illuminationFraction = shadowFraction(rsun, state.position);
    const altitudeKm = geodetic.height;
    if (![geodetic.latitude, geodetic.longitude, altitudeKm, speedKmS, look.azimuth, look.elevation, look.rangeSat].every(Number.isFinite)) return null;
    return {
      catalogId: object.catalogId, name: object.name, category: object.category, orbitType: object.orbitType,
      latitude: geodetic.latitude * 180 / Math.PI, longitude: degreesLong(geodetic.longitude),
      altitudeKm, speedKmS, azimuth: (look.azimuth * 180 / Math.PI + 360) % 360,
      elevation: look.elevation * 180 / Math.PI, rangeKm: look.rangeSat,
      periodMinutes: 1440 / object.orbital.MEAN_MOTION, epoch: object.orbital.EPOCH,
      sunlit: illuminationFraction < 0.5, illuminationFraction,
      positionEciKm: { ...state.position }, positionEcfKm: { ...ecf },
      velocityEciKmS: { ...state.velocity }, velocityEcfKmS: { ...velocityEcf },
      nextVisibilityAt: null, nextVisibilityEndAt: null,
      remainingPassMinutes: null, predicted: true,
    };
  } catch {
    return null;
  }
}

export function orbitPath(object: CatalogObject, at: Date, sampleCount = 100): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  try {
    const periodMs = 1440 / object.orbital.MEAN_MOTION * 60000;
    const satrec = json2satrec(object.orbital);
    for (let i = 0; i <= sampleCount; i += 1) {
      const time = new Date(at.getTime() - periodMs / 2 + periodMs * i / sampleCount);
      const state = propagate(satrec, time, { communityDecayCheckEnabled: true });
      if (!state) continue;
      const gd = eciToGeodetic(state.position, gstime(time));
      points.push([degreesLong(gd.longitude), gd.latitude * 180 / Math.PI, gd.height * 1000]);
    }
  } catch { return points; }
  return points;
}

export function footprint(object: CatalogObject, at: Date, segments = 72): Array<[number, number, number]> {
  const track = propagateObject(object, { latitude: 0, longitude: 0, altitudeKm: 0 }, at);
  if (!track || track.altitudeKm <= 0) return [];
  const angularRadius = Math.acos(6371 / (6371 + track.altitudeKm));
  const lat1 = track.latitude * Math.PI / 180;
  const lon1 = track.longitude * Math.PI / 180;
  const result: Array<[number, number, number]> = [];
  for (let i = 0; i <= segments; i += 1) {
    const bearing = i / segments * Math.PI * 2;
    const lat = Math.asin(Math.sin(lat1) * Math.cos(angularRadius) + Math.cos(lat1) * Math.sin(angularRadius) * Math.cos(bearing));
    const lon = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularRadius) * Math.cos(lat1), Math.cos(angularRadius) - Math.sin(lat1) * Math.sin(lat));
    result.push([((lon * 180 / Math.PI + 540) % 360) - 180, lat * 180 / Math.PI, 0]);
  }
  return result;
}

export function observerSolarElevation(observer: Observer, at: Date): number {
  const sun = sunPos(jday(at)).rsun;
  const gmst = gstime(at);
  const sunEcf = eciToEcf(sun, gmst);
  const look = ecfToLookAngles({ longitude: degreesToRadians(observer.longitude), latitude: degreesToRadians(observer.latitude), height: observer.altitudeKm }, sunEcf);
  return look.elevation * 180 / Math.PI;
}
