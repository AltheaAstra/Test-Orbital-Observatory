import { describe, expect, it } from 'vitest';
import { classifyCategory, classifyOrbit, csvToCatalog, parseCsv } from './csv.mjs';

const header = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT';
const row = (id = '100001') => `"TEST SAT, ALPHA",2026-001A,2026-11-18T00:00:00.000000,15.5,0.001,51.6,20,30,40,0,U,${id},999,100,0.00001,0.00001,0`;

describe('CelesTrak CSV ingestion', () => {
  it('parses quoted commas and escaped quotes', () => {
    expect(parseCsv('A,B\r\n"one, two","say ""hi"""')[1]).toEqual(['one, two', 'say "hi"']);
  });

  it('validates and converts six-digit catalog identifiers to OMM records', () => {
    const result = csvToCatalog(`${header}\n${row()}`, { fetchedAt: '2026-11-18T00:01:00Z' });
    expect(result).toHaveLength(1);
    expect(result[0].catalogId).toBe('100001');
    expect(result[0].orbital.NORAD_CAT_ID).toBe(100001);
    expect(result[0].operator).toBeNull();
    expect(result[0].internationalDesignator).toBe('2026-001A');
  });

  it('skips malformed rows and rejects incompatible feeds', () => {
    expect(csvToCatalog(`${header}\n${row()}\nnot,a,valid,row`)).toHaveLength(1);
    expect(() => csvToCatalog('OBJECT_NAME,NORAD_CAT_ID\nISS,25544')).toThrow(/missing required columns/i);
  });

  it('classifies orbit bands and cautious object categories', () => {
    expect(classifyOrbit(15)).toBe('LEO');
    expect(classifyOrbit(2)).toBe('MEO');
    expect(classifyOrbit(1)).toBe('GEO');
    expect(classifyOrbit(0.5)).toBe('HEO');
    expect(classifyCategory('COSMOS DEB')).toBe('Debris');
    expect(classifyCategory('MYSTERY 1')).toBe('Unverified');
  });
});
