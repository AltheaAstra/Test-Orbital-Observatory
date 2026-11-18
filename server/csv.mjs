const GP_FIELDS = [
  'OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
];

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (quoted) throw new Error('Malformed CSV: unterminated quoted field');
  return rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
}

const num = (row, index, label) => {
  const raw = row[index]?.trim();
  if (!raw) throw new Error(`Invalid ${label}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
};

export function csvToCatalog(csv, { fetchedAt = new Date().toISOString(), group = 'ACTIVE' } = {}) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('CelesTrak returned an empty dataset');
  const header = rows[0].map((cell) => cell.trim().replace(/^\uFEFF/, ''));
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const missing = GP_FIELDS.filter((name) => index[name] === undefined);
  if (missing.length) throw new Error(`CelesTrak CSV missing required columns: ${missing.join(', ')}`);

  const objects = [];
  for (const row of rows.slice(1)) {
    try {
      const catalogId = row[index.NORAD_CAT_ID]?.trim();
      if (!/^\d{1,9}$/.test(catalogId ?? '')) continue;
      const name = row[index.OBJECT_NAME]?.trim();
      const epoch = row[index.EPOCH]?.trim();
      if (!name || !epoch || Number.isNaN(Date.parse(epoch))) continue;
      const omm = {
        OBJECT_NAME: name,
        OBJECT_ID: row[index.OBJECT_ID]?.trim() || '',
        CENTER_NAME: 'EARTH', REF_FRAME: 'TEME', TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4',
        EPOCH: epoch,
        MEAN_MOTION: num(row, index.MEAN_MOTION, 'mean motion'),
        ECCENTRICITY: num(row, index.ECCENTRICITY, 'eccentricity'),
        INCLINATION: num(row, index.INCLINATION, 'inclination'),
        RA_OF_ASC_NODE: num(row, index.RA_OF_ASC_NODE, 'right ascension'),
        ARG_OF_PERICENTER: num(row, index.ARG_OF_PERICENTER, 'argument of pericenter'),
        MEAN_ANOMALY: num(row, index.MEAN_ANOMALY, 'mean anomaly'),
        EPHEMERIS_TYPE: num(row, index.EPHEMERIS_TYPE, 'ephemeris type'),
        CLASSIFICATION_TYPE: row[index.CLASSIFICATION_TYPE]?.trim() || 'U',
        NORAD_CAT_ID: Number(catalogId),
        ELEMENT_SET_NO: num(row, index.ELEMENT_SET_NO, 'element set number'),
        REV_AT_EPOCH: num(row, index.REV_AT_EPOCH, 'revolution number'),
        BSTAR: num(row, index.BSTAR, 'BSTAR'),
        MEAN_MOTION_DOT: num(row, index.MEAN_MOTION_DOT, 'mean motion derivative'),
        MEAN_MOTION_DDOT: num(row, index.MEAN_MOTION_DDOT, 'second mean motion derivative'),
      };
      if (omm.EPHEMERIS_TYPE !== 0 || !['U', 'C'].includes(omm.CLASSIFICATION_TYPE)) continue;
      if (omm.ECCENTRICITY < 0 || omm.ECCENTRICITY >= 1 || omm.MEAN_MOTION <= 0 || omm.INCLINATION < 0 || omm.INCLINATION > 180) continue;
      const orbitType = classifyOrbit(omm.MEAN_MOTION);
      const category = classifyCategory(name);
      objects.push({
        catalogId, name, internationalDesignator: omm.OBJECT_ID ?? null,
        category, operator: null, country: null, orbitType,
        orbital: omm, source: 'CelesTrak GP', sourceUrl: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=CSV`,
        updatedAt: fetchedAt, quality: 'nominal',
      });
    } catch {
      // A malformed row does not invalidate other records in the public feed.
    }
  }
  if (!objects.length) throw new Error('CelesTrak response contained no valid GP records');
  return objects;
}

export function classifyOrbit(meanMotion) {
  if (meanMotion >= 11.25) return 'LEO';
  if (meanMotion >= 1.1 && meanMotion < 11.25) return 'MEO';
  if (meanMotion >= 0.9 && meanMotion <= 1.1) return 'GEO';
  return 'HEO';
}

export function classifyCategory(name) {
  if (/\bDEB\b|DEBRIS/i.test(name)) return 'Debris';
  if (/\bR\/B\b|ROCKET BODY/i.test(name)) return 'Rocket body';
  if (/\bPAYLOAD\b/i.test(name)) return 'Payload';
  return 'Unverified';
}
