import { describe, expect, it } from 'vitest';
import { propagateObject } from './orbit';
import type { CatalogObject } from './types';

const iss: CatalogObject = {
  catalogId: '28492', name: 'HELIOS 2A', internationalDesignator: '2004-049A',
  category: 'Payload', operator: null, country: null, orbitType: 'LEO', source: 'fixture',
  sourceUrl: 'https://celestrak.org/', updatedAt: '2025-03-26T05:20:00Z', quality: 'nominal',
  orbital: {
    OBJECT_NAME: 'HELIOS 2A', OBJECT_ID: '2004-049A', CENTER_NAME: 'EARTH', REF_FRAME: 'TEME', TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4',
    EPOCH: '2025-03-26T05:19:34.116960', MEAN_MOTION: 15.00555103, ECCENTRICITY: 0.000583,
    INCLINATION: 98.3164, RA_OF_ASC_NODE: 103.8411, ARG_OF_PERICENTER: 20.5667, MEAN_ANOMALY: 339.5789,
    EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 28492, ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 8655, BSTAR: 0.00048021, MEAN_MOTION_DOT: 0.00005995, MEAN_MOTION_DDOT: 0,
  },
};

describe('SGP4 orbital prediction', () => {
  it('returns finite geodetic state and topocentric look angles', () => {
    const result = propagateObject(iss, { latitude: 37, longitude: -122, altitudeKm: 0.37 }, new Date('2025-03-26T05:30:00Z'));
    expect(result).not.toBeNull();
    expect(result?.predicted).toBe(true);
    expect(result?.latitude).toBeGreaterThanOrEqual(-90);
    expect(result?.latitude).toBeLessThanOrEqual(90);
    expect(result?.longitude).toBeGreaterThanOrEqual(-180);
    expect(result?.longitude).toBeLessThanOrEqual(180);
    expect(result?.altitudeKm).toBeGreaterThan(100);
    expect(result?.speedKmS).toBeGreaterThan(6);
    expect(result?.speedKmS).toBeLessThan(9);
    expect(result?.azimuth).toBeGreaterThanOrEqual(0);
    expect(result?.azimuth).toBeLessThan(360);
    expect(result?.rangeKm).toBeGreaterThan(0);
  });

  it('safely rejects invalid orbital elements', () => {
    const invalid = { ...iss, orbital: { ...iss.orbital, MEAN_MOTION: 0 } };
    expect(propagateObject(invalid, { latitude: 0, longitude: 0, altitudeKm: 0 }, new Date())).toBeNull();
  });
});
