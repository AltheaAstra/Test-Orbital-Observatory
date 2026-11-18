import express from 'express';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToCatalog } from './csv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const databasePath = resolve(root, process.env.DATABASE_PATH || './data/althea.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, object_id TEXT, object_name TEXT, observed_at TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, observer_altitude_km REAL NOT NULL,
    azimuth REAL, elevation REAL, sensor_type TEXT NOT NULL, uncertainty_m REAL,
    source TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
  );
`);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
const TTL = 2 * 60 * 60 * 1000;
const GROUPS = new Set(['ACTIVE', 'STATIONS', 'VISUAL', 'GPS-OPS', 'WEATHER', 'STARLINK']);
const getCache = db.prepare('SELECT value, fetched_at FROM cache WHERE key = ?');
const putCache = db.prepare('INSERT INTO cache(key, value, fetched_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at');
const inflightCatalogs = new Map();
const inflightTransmitters = new Map();
let inflightStations = null;

async function loadCatalog(group) {
  const key = `gp:${group}`;
  const cached = getCache.get(key);
  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  if (cached && age < TTL) return { objects: JSON.parse(cached.value), fetchedAt: cached.fetched_at, stale: false, cached: true };
  if (inflightCatalogs.has(key)) return inflightCatalogs.get(key);
  const request = (async () => {
    try {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=CSV`;
      const response = await fetch(url, { headers: { 'User-Agent': 'ALTHEA-Orbital-Observatory/1.0 (public GP data; 2h cache)' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`CelesTrak returned HTTP ${response.status}`);
      const fetchedAt = new Date().toISOString();
      const objects = csvToCatalog(await response.text(), { fetchedAt, group });
      putCache.run(key, JSON.stringify(objects), fetchedAt);
      return { objects, fetchedAt, stale: false, cached: false };
    } catch (error) {
      if (cached) return { objects: JSON.parse(cached.value).map((object) => ({ ...object, quality: 'stale' })), fetchedAt: cached.fetched_at, stale: true, cached: true, warning: error.message };
      throw error;
    } finally { inflightCatalogs.delete(key); }
  })();
  inflightCatalogs.set(key, request);
  return request;
}

async function loadStations() {
  const key = 'satnogs:stations';
  const cached = getCache.get(key);
  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  if (cached && age < TTL) return { stations: JSON.parse(cached.value), fetchedAt: cached.fetched_at, stale: false, cached: true, source: 'SatNOGS Network API' };
  if (inflightStations) return inflightStations;
  inflightStations = (async () => {
    try {
      const response = await fetch('https://network.satnogs.org/api/stations/?format=json&limit=100', { headers: { 'User-Agent': 'ALTHEA-Orbital-Observatory/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`SatNOGS returned HTTP ${response.status}`);
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body.results) ? body.results : [];
      const stations = rows.slice(0, 100).filter((item) => Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))).map((item) => ({
        id: item.id ?? null, name: String(item.name || `Station ${item.id ?? 'unknown'}`), latitude: Number(item.latitude), longitude: Number(item.longitude),
        altitude: Number.isFinite(Number(item.altitude)) ? Number(item.altitude) : null,
        status: typeof item.status === 'string' ? item.status : null,
        url: item.id ? `https://network.satnogs.org/stations/${item.id}/` : 'https://network.satnogs.org/stations/',
      }));
      if (!stations.length) throw new Error('No station records with valid coordinates were returned');
      const fetchedAt = new Date().toISOString();
      putCache.run(key, JSON.stringify(stations), fetchedAt);
      return { stations, fetchedAt, stale: false, cached: false, source: 'SatNOGS Network API' };
    } catch (error) {
      if (cached) return { stations: JSON.parse(cached.value), fetchedAt: cached.fetched_at, stale: true, cached: true, warning: error.message, source: 'SatNOGS Network API' };
      throw error;
    }
  })();
  try { return await inflightStations; }
  finally { inflightStations = null; }
}

async function loadTransmitters(catalogId) {
  const key = `satnogs:transmitters:${catalogId}`;
  const cached = getCache.get(key);
  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  if (cached && age < TTL) return { transmitters: JSON.parse(cached.value), fetchedAt: cached.fetched_at, stale: false, cached: true, source: 'SatNOGS DB' };
  if (inflightTransmitters.has(catalogId)) return inflightTransmitters.get(catalogId);
  const request = (async () => {
    try {
      const url = `https://db.satnogs.org/api/transmitters/?satellite__norad_cat_id=${encodeURIComponent(catalogId)}&format=json`;
      const response = await fetch(url, { headers: { 'User-Agent': 'ALTHEA-Orbital-Observatory/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`SatNOGS DB returned HTTP ${response.status}`);
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body.results) ? body.results : [];
      const numberOrNull = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
      const transmitters = rows.map((item) => ({
        uuid: String(item.uuid || ''), description: String(item.description || 'Transmitter metadata'),
        type: String(item.type || 'Unspecified'), downlinkLowHz: numberOrNull(item.downlink_low), downlinkHighHz: numberOrNull(item.downlink_high),
        uplinkLowHz: numberOrNull(item.uplink_low), uplinkHighHz: numberOrNull(item.uplink_high),
        mode: item.mode ? String(item.mode) : null, service: item.service ? String(item.service) : null,
        status: item.status ? String(item.status) : null, alive: typeof item.alive === 'boolean' ? item.alive : null,
        unconfirmed: item.unconfirmed === true, updatedAt: item.updated ? String(item.updated) : null,
        citation: item.citation ? String(item.citation) : null,
        url: item.uuid ? `https://db.satnogs.org/transmitters/${encodeURIComponent(item.uuid)}/` : 'https://db.satnogs.org/transmitters/',
      }));
      const fetchedAt = new Date().toISOString();
      putCache.run(key, JSON.stringify(transmitters), fetchedAt);
      return { transmitters, fetchedAt, stale: false, cached: false, source: 'SatNOGS DB' };
    } catch (error) {
      if (cached) return { transmitters: JSON.parse(cached.value), fetchedAt: cached.fetched_at, stale: true, cached: true, warning: error.message, source: 'SatNOGS DB' };
      throw error;
    } finally { inflightTransmitters.delete(catalogId); }
  })();
  inflightTransmitters.set(catalogId, request);
  return request;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'althea-api', utc: new Date().toISOString() }));
app.get('/api/catalog', async (req, res) => {
  const requested = String(req.query.group || 'ACTIVE').toUpperCase();
  if (!GROUPS.has(requested)) return res.status(400).json({ error: 'Unsupported CelesTrak group' });
  try {
    const catalog = await loadCatalog(requested);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...catalog, source: 'CelesTrak GP CSV', sourceUrl: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${requested}&FORMAT=CSV`, refreshIntervalSeconds: TTL / 1000 });
  } catch (error) {
    res.status(503).json({ error: `Orbital data unavailable: ${error.message}`, source: 'CelesTrak GP', stale: false });
  }
});

app.get('/api/stations', async (_req, res) => {
  try {
    return res.json(await loadStations());
  } catch (error) {
    return res.status(503).json({ error: `Ground station data unavailable: ${error.message}`, source: 'SatNOGS Network API' });
  }
});

app.get('/api/transmitters/:catalogId', async (req, res) => {
  const catalogId = String(req.params.catalogId);
  if (!/^\d{1,9}$/.test(catalogId)) return res.status(400).json({ error: 'Catalog ID must contain one to nine digits' });
  try {
    return res.json({ ...await loadTransmitters(catalogId), sourceUrl: `https://db.satnogs.org/api/transmitters/?satellite__norad_cat_id=${catalogId}&format=json` });
  } catch (error) {
    return res.status(503).json({ error: `Transmitter metadata unavailable: ${error.message}`, source: 'SatNOGS DB' });
  }
});

app.get('/api/observations', (_req, res) => {
  const records = db.prepare('SELECT * FROM observations ORDER BY observed_at DESC LIMIT 500').all();
  res.json({ records, sourceType: 'Recorded observations', limit: 500 });
});

app.post('/api/observations', (req, res) => {
  const input = req.body ?? {};
  const requiredStrings = ['observedAt', 'sensorType', 'source'];
  if (requiredStrings.some((key) => typeof input[key] !== 'string' || !input[key].trim())) return res.status(400).json({ error: 'observedAt, sensorType, and source are required' });
  const coordinates = [input.latitude, input.longitude, input.observerAltitudeKm];
  if (!coordinates.every(Number.isFinite) || input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180 || input.observerAltitudeKm < -0.5 || input.observerAltitudeKm > 20) return res.status(400).json({ error: 'Observer coordinates or altitude are invalid' });
  if (Number.isNaN(Date.parse(input.observedAt))) return res.status(400).json({ error: 'observedAt must be an ISO 8601 timestamp' });
  const optionalAngle = (value) => value === null || value === undefined || value === '' ? null : Number.isFinite(value) && value >= 0 && value <= 360 ? value : NaN;
  const azimuth = optionalAngle(input.azimuth);
  const elevation = input.elevation === null || input.elevation === undefined || input.elevation === '' ? null : Number(input.elevation);
  const uncertainty = input.uncertaintyM === null || input.uncertaintyM === undefined || input.uncertaintyM === '' ? null : Number(input.uncertaintyM);
  if (Number.isNaN(azimuth) || (elevation !== null && (!Number.isFinite(elevation) || elevation < -90 || elevation > 90)) || (uncertainty !== null && (!Number.isFinite(uncertainty) || uncertainty < 0))) return res.status(400).json({ error: 'Angle or uncertainty value is invalid' });
  const result = db.prepare(`INSERT INTO observations(object_id, object_name, observed_at, latitude, longitude, observer_altitude_km, azimuth, elevation, sensor_type, uncertainty_m, source, notes)
    VALUES(@objectId, @objectName, @observedAt, @latitude, @longitude, @observerAltitudeKm, @azimuth, @elevation, @sensorType, @uncertaintyM, @source, @notes)`).run({
    objectId: input.objectId?.trim() || null, objectName: input.objectName?.trim() || null,
    observedAt: new Date(input.observedAt).toISOString(), latitude: input.latitude, longitude: input.longitude,
    observerAltitudeKm: input.observerAltitudeKm, azimuth, elevation,
    sensorType: input.sensorType.trim().slice(0, 80), uncertaintyM: uncertainty,
    source: input.source.trim().slice(0, 240), notes: String(input.notes || '').slice(0, 2000),
  });
  res.status(201).json({ id: result.lastInsertRowid, status: 'recorded', classification: 'Observed metadata supplied by the user' });
});

const appRoot = resolve(root, 'dist');
app.use(express.static(appRoot));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(resolve(appRoot, 'index.html'), (error) => { if (error) next(error); });
});
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message || 'Unexpected server error' }));

const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', () => console.log(`ALTHEA API listening on http://localhost:${port}`));

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
