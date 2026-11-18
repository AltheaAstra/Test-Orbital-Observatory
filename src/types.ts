export type OrbitClass = 'LEO' | 'MEO' | 'GEO' | 'HEO';
export type ObjectCategory = 'Payload' | 'Rocket body' | 'Debris' | 'Unverified';

export interface Omm {
  [key: string]: unknown;
  OBJECT_NAME: string;
  OBJECT_ID: string;
  CENTER_NAME?: 'EARTH';
  REF_FRAME?: 'TEME';
  TIME_SYSTEM?: 'UTC';
  MEAN_ELEMENT_THEORY?: 'SGP4';
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  EPHEMERIS_TYPE: 0;
  CLASSIFICATION_TYPE: 'U' | 'C';
  NORAD_CAT_ID: number;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
}

export interface CatalogObject {
  catalogId: string;
  name: string;
  internationalDesignator: string | null;
  category: ObjectCategory;
  operator: string | null;
  country: string | null;
  orbitType: OrbitClass;
  orbital: Omm;
  source: string;
  sourceUrl: string;
  updatedAt: string;
  quality: 'nominal' | 'stale';
}

export interface Observer {
  latitude: number;
  longitude: number;
  altitudeKm: number;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface SatellitePosition {
  catalogId: string;
  name: string;
  category: ObjectCategory;
  orbitType: OrbitClass;
  latitude: number;
  longitude: number;
  altitudeKm: number;
  speedKmS: number;
  azimuth: number;
  elevation: number;
  rangeKm: number;
  periodMinutes: number;
  epoch: string;
  sunlit: boolean;
  illuminationFraction: number;
  positionEciKm: Vector3;
  positionEcfKm: Vector3;
  velocityEciKmS: Vector3;
  velocityEcfKmS: Vector3;
  nextVisibilityAt: string | null;
  nextVisibilityEndAt: string | null;
  remainingPassMinutes: number | null;
  predicted: true;
}

export interface SkyTrackPoint {
  azimuth: number;
  elevation: number;
  time: string;
}

export interface CatalogResponse {
  objects: CatalogObject[];
  fetchedAt: string;
  stale: boolean;
  cached: boolean;
  warning?: string;
  source: string;
  sourceUrl: string;
  refreshIntervalSeconds: number;
}

