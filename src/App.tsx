import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobeView } from './components/GlobeView';
import { observerSolarElevation } from './orbit';
import type { CatalogObject, CatalogResponse, Observer, SatellitePosition, SkyTrackPoint } from './types';

type Page = 'observatory' | 'overhead' | 'catalog' | 'analysis' | 'sky' | 'stations' | 'observations' | 'sources';
const NAV: Array<{ id: Page; label: string; icon: string; group?: string }> = [
  { id: 'observatory', label: 'Global Observatory', icon: '◉', group: 'MISSION' },
  { id: 'overhead', label: 'Overhead Now', icon: '⌖' },
  { id: 'catalog', label: 'Satellite Catalog', icon: '▤', group: 'INTELLIGENCE' },
  { id: 'analysis', label: 'Orbit Analysis', icon: '⌁' },
  { id: 'sky', label: 'Sky Tracker', icon: '✳' },
  { id: 'stations', label: 'Ground Stations', icon: '⌂', group: 'OBSERVATIONS' },
  { id: 'observations', label: 'Observation Records', icon: '◷' },
  { id: 'sources', label: 'Data Sources', icon: '↗', group: 'SYSTEM' },
];
const SPEEDS = [1, 30, 300, 3600];

interface Observation {
  id: number; object_id: string | null; object_name: string | null; observed_at: string; latitude: number;
  longitude: number; observer_altitude_km: number; azimuth: number | null; elevation: number | null;
  sensor_type: string; uncertainty_m: number | null; source: string; notes: string;
}

interface TransmitterMetadata {
  uuid: string; description: string; type: string; downlinkLowHz: number | null; downlinkHighHz: number | null;
  uplinkLowHz: number | null; uplinkHighHz: number | null; mode: string | null; service: string | null;
  status: string | null; alive: boolean | null; unconfirmed: boolean; updatedAt: string | null; citation: string | null; url: string;
}

const formatNumber = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
const formatVector = (value: { x: number; y: number; z: number }) => `${formatNumber(value.x, 2)}  /  ${formatNumber(value.y, 2)}  /  ${formatNumber(value.z, 2)}`;
const localDateTimeInput = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const formatDate = (value: string | Date, options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', ...options }).format(new Date(value));
const localStorageKey = 'althea-observer-v1';

function loadObserver(): Observer {
  try {
    const parsed = JSON.parse(localStorage.getItem(localStorageKey) || 'null');
    if (parsed && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude) && Number.isFinite(parsed.altitudeKm)) return parsed;
  } catch { /* use an explicit, neutral default if no local location is configured */ }
  return { latitude: 0, longitude: 0, altitudeKm: 0 };
}

function App() {
  const [page, setPage] = useState<Page>('observatory');
  const [catalog, setCatalog] = useState<CatalogObject[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=CSV');
  const [stale, setStale] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [observer, setObserver] = useState<Observer>(loadObserver);
  const [observerDraft, setObserverDraft] = useState<Observer>(loadObserver);
  const [showLocation, setShowLocation] = useState(false);
  const [simTime, setSimTime] = useState(() => new Date());
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [horizon, setHorizon] = useState(10);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [orbitFilter, setOrbitFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [operatorFilter, setOperatorFilter] = useState('ALL');
  const [potentiallyVisibleOnly, setPotentiallyVisibleOnly] = useState(false);
  const [showPaths, setShowPaths] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Float64Array | null>(null);
  const [overhead, setOverhead] = useState<SatellitePosition[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<SatellitePosition | null>(null);
  const [skyTrack, setSkyTrack] = useState<SkyTrackPoint[]>([]);
  const [validCount, setValidCount] = useState(0);
  const [workerReady, setWorkerReady] = useState(false);
  const [workerError, setWorkerError] = useState('');
  const worker = useRef<Worker | null>(null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [observationMessage, setObservationMessage] = useState('');
  const [stations, setStations] = useState<Array<{ id: number | null; name: string; latitude: number; longitude: number; altitude: number | null; status: string | null; url: string }>>([]);
  const [stationsError, setStationsError] = useState('');
  const [stationsLoading, setStationsLoading] = useState(false);
  const [stationsStale, setStationsStale] = useState(false);
  const [stationsRequested, setStationsRequested] = useState(false);
  const [transmitters, setTransmitters] = useState<TransmitterMetadata[]>([]);
  const [transmitterFetchedAt, setTransmitterFetchedAt] = useState<string | null>(null);
  const [transmittersLoading, setTransmittersLoading] = useState(false);
  const [transmittersError, setTransmittersError] = useState('');
  const [transmittersStale, setTransmittersStale] = useState(false);

  const selected = useMemo(() => catalog.find((item) => item.catalogId === selectedId) ?? null, [catalog, selectedId]);
  const solarElevation = useMemo(() => observerSolarElevation(observer, simTime), [observer, Math.floor(simTime.getTime() / 60_000)]);
  const darkAtObserver = solarElevation < -6;
  const displayedOverhead = useMemo(() => overhead
    .filter((item) => !search || `${item.name} ${item.catalogId}`.toLowerCase().includes(search.toLowerCase()))
    .filter((item) => orbitFilter === 'ALL' || item.orbitType === orbitFilter)
    .filter((item) => categoryFilter === 'ALL' || item.category === categoryFilter)
    .filter((item) => !potentiallyVisibleOnly || (darkAtObserver && item.sunlit)),
  [overhead, search, orbitFilter, categoryFilter, potentiallyVisibleOnly, darkAtObserver]);
  const filteredCatalog = useMemo(() => catalog
    .filter((item) => !search || `${item.name} ${item.catalogId} ${item.internationalDesignator ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .filter((item) => orbitFilter === 'ALL' || item.orbitType === orbitFilter)
    .filter((item) => categoryFilter === 'ALL' || item.category === categoryFilter)
    .filter((item) => operatorFilter === 'ALL' || (operatorFilter === 'VERIFIED' ? Boolean(item.operator) : !item.operator)), [catalog, search, orbitFilter, categoryFilter, operatorFilter]);
  const searchMatches = useMemo(() => search.length < 2 ? [] : catalog.filter((item) => `${item.name} ${item.catalogId} ${item.internationalDesignator ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6), [catalog, search]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await fetch('/api/catalog?group=ACTIVE');
      const body = await response.json() as CatalogResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || `Catalog request failed (${response.status})`);
      setCatalog(body.objects);
      setFetchedAt(body.fetchedAt);
      setSourceUrl(body.sourceUrl);
      setStale(body.stale);
      if (body.warning) setCatalogError(body.warning);
      if (!selectedId && body.objects.length) setSelectedId(body.objects[0].catalogId);
    } catch (error) { setCatalogError(error instanceof Error ? error.message : 'Orbital catalog unavailable'); }
    finally { setCatalogLoading(false); }
  }, [selectedId]);

  useEffect(() => { void loadCatalog(); }, []); // Server cache enforces the two-hour CelesTrak retrieval interval.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setSimTime((previous) => new Date(previous.getTime() + 1000 * speed)), 1000);
    return () => window.clearInterval(timer);
  }, [playing, speed]);

  useEffect(() => {
    if (!catalog.length) { setWorkerReady(false); return; }
    const next = new Worker(new URL('./orbit.worker.ts', import.meta.url), { type: 'module' });
    worker.current = next;
    setWorkerReady(false);
    next.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'ready') setWorkerReady(true);
      if (event.data.type === 'positions') {
        setPositions(new Float64Array(event.data.positions));
        setOverhead(event.data.overhead);
        setSelectedPosition(event.data.selected);
        setValidCount(event.data.valid);
      }
      if (event.data.type === 'sky-track') setSkyTrack(event.data.track);
    };
    next.onerror = () => setWorkerError('Orbital worker stopped unexpectedly. Reload the catalog to restart it.');
    next.postMessage({ type: 'init', objects: catalog });
    return () => { next.terminate(); if (worker.current === next) worker.current = null; };
  }, [catalog]);

  useEffect(() => {
    if (!workerReady || !worker.current) return;
    worker.current.postMessage({ type: 'tick', observer, at: simTime.getTime(), horizon, selectedId });
  }, [workerReady, observer, simTime, horizon, selectedId]);

  useEffect(() => {
    if (page !== 'sky' || !workerReady || !worker.current || !selectedId) { setSkyTrack([]); return; }
    worker.current.postMessage({ type: 'sky-track', objectId: selectedId, observer, at: simTime.getTime(), horizon });
  }, [page, workerReady, selectedId, observer, horizon, Math.floor(simTime.getTime() / 60_000)]);

  useEffect(() => { localStorage.setItem(localStorageKey, JSON.stringify(observer)); }, [observer]);

  useEffect(() => {
    if (page !== 'observations') return;
    fetch('/api/observations').then((response) => response.json()).then((body) => setObservations(body.records || [])).catch(() => setObservationMessage('Observation store is unavailable.'));
  }, [page]);

  useEffect(() => {
    if (page !== 'stations' || stationsRequested) return;
    setStationsRequested(true);
    setStationsLoading(true);
    fetch('/api/stations').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Station feed unavailable');
      setStations(body.stations || []);
      setStationsStale(Boolean(body.stale));
    }).catch((error) => setStationsError(error instanceof Error ? error.message : 'Station feed unavailable')).finally(() => setStationsLoading(false));
  }, [page, stationsRequested]);

  useEffect(() => {
    if (!selectedId || (page !== 'observatory' && page !== 'analysis')) return;
    const controller = new AbortController();
    setTransmitters([]);
    setTransmitterFetchedAt(null);
    setTransmittersError('');
    setTransmittersStale(false);
    setTransmittersLoading(true);
    fetch(`/api/transmitters/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'SatNOGS DB unavailable');
        setTransmitters(body.transmitters || []);
        setTransmitterFetchedAt(body.fetchedAt || null);
        setTransmittersStale(Boolean(body.stale));
      })
      .catch((error) => { if (error.name !== 'AbortError') setTransmittersError(error instanceof Error ? error.message : 'Transmitter metadata unavailable'); })
      .finally(() => { if (!controller.signal.aborted) setTransmittersLoading(false); });
    return () => controller.abort();
  }, [page, selectedId]);

  const choose = (id: string) => {
    setSelectedId(id);
    setSearchOpen(false);
  };

  const useBrowserLocation = () => {
    if (!navigator.geolocation) { setCatalogError('This browser does not provide geolocation. Use the manual coordinates.'); return; }
    navigator.geolocation.getCurrentPosition((position) => {
      const next = { latitude: position.coords.latitude, longitude: position.coords.longitude, altitudeKm: Math.max(0, (position.coords.altitude || 0) / 1000) };
      setObserverDraft(next);
      setObserver(next);
      setShowLocation(false);
    }, (error) => setCatalogError(`Location was not available: ${error.message}`), { enableHighAccuracy: true, timeout: 12000 });
  };

  const saveObserver = (event: React.FormEvent) => {
    event.preventDefault();
    if (observerDraft.latitude < -90 || observerDraft.latitude > 90 || observerDraft.longitude < -180 || observerDraft.longitude > 180 || observerDraft.altitudeKm < -0.5 || observerDraft.altitudeKm > 20) return;
    setObserver(observerDraft);
    setShowLocation(false);
  };

  const saveObservation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const parseOptional = (name: string) => { const value = String(form.get(name) || '').trim(); return value ? Number(value) : null; };
    const record = {
      objectId: String(form.get('objectId') || '').trim() || null,
      objectName: String(form.get('objectName') || '').trim() || null,
      observedAt: new Date(String(form.get('observedAt'))).toISOString(),
      latitude: Number(form.get('latitude')), longitude: Number(form.get('longitude')),
      observerAltitudeKm: Number(form.get('observerAltitudeKm')),
      azimuth: parseOptional('azimuth'), elevation: parseOptional('elevation'),
      sensorType: String(form.get('sensorType')), uncertaintyM: parseOptional('uncertaintyM'),
      source: String(form.get('source')), notes: String(form.get('notes') || ''),
    };
    try {
      const response = await fetch('/api/observations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Observation could not be saved');
      setObservationMessage(`Observation record #${body.id} saved. Identity remains unverified unless supported by evidence.`);
      formElement.reset();
      const listResponse = await fetch('/api/observations');
      const list = await listResponse.json();
      setObservations(list.records || []);
    } catch (error) { setObservationMessage(error instanceof Error ? error.message : 'Observation could not be saved'); }
  };

  const title = NAV.find((entry) => entry.id === page)?.label ?? 'Global Observatory';
  const latestEpoch = catalog.length ? catalog.reduce((latest, item) => item.orbital.EPOCH > latest ? item.orbital.EPOCH : latest, '') : null;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span>✳</span></div><div><b>ALTHEA</b><small>ORBITAL OBSERVATORY</small></div></div>
      <div className="sidebar-rule" />
      <div className="side-nav">
        {NAV.map((item) => <div key={item.id}>
          {item.group && <div className="nav-group">{item.group}</div>}
          <button className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'overhead' && overhead.length > 0 && <i className="nav-count">{overhead.length}</i>}</button>
        </div>)}
      </div>
      <div className="sidebar-bottom">
        <div className="mini-status"><span className={`live-dot ${catalogError ? 'warn' : ''}`} />{catalog.length ? `${catalog.length.toLocaleString()} OBJECTS INDEXED` : 'AWAITING GP DATA'}</div>
        <div className="side-version">ALTHEA SYSTEMS <span>v1.0.0</span></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="top-title"><span className="breadcrumb">OPERATIONS</span><span className="breadcrumb-sep">/</span><b>{title.toUpperCase()}</b></div>
        <div className="top-actions">
          <div className={`data-status ${stale ? 'status-stale' : ''}`}><span className="status-led" />{stale ? 'CACHED · STALE' : catalog.length ? 'PREDICTION ENGINE ACTIVE' : 'CONNECTING TO GP FEED'}</div>
          <button className="location-button" onClick={() => { setObserverDraft(observer); setShowLocation(true); }}><span>⌖</span><span className="location-coords">{formatNumber(observer.latitude, 2)}°, {formatNumber(observer.longitude, 2)}°</span><span className="caret">⌄</span></button>
          <div className="utc-clock"><small>LOCAL TIME</small><b>{formatDate(simTime, { dateStyle: undefined, timeStyle: 'medium' })}</b></div>
        </div>
      </header>

      <main className="main-content">
        {(catalogError || workerError) && <div className="alert-strip"><span>!</span>{catalogError || workerError}<button onClick={() => void loadCatalog()}>RETRY FEED</button></div>}
        <div className="page-heading">
          <div><div className="eyebrow">SPACE SITUATIONAL AWARENESS <span>·</span> PUBLIC GP ORBITAL DATA</div><h1>{title}</h1></div>
          <div className="heading-right">
            {page === 'observatory' && <button className={`toggle-chip ${showPaths ? 'toggle-on' : ''}`} onClick={() => setShowPaths((value) => !value)}><span>⌁</span> ORBIT PATHS {showPaths ? 'ON' : 'OFF'}</button>}
            <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={(event) => { if (event.key === 'Enter' && searchMatches[0]) choose(searchMatches[0].catalogId); if (event.key === 'Escape') setSearchOpen(false); }} placeholder="Search name, catalog ID…" />{search && <button onClick={() => setSearch('')}>×</button>}</label>
            {searchOpen && searchMatches.length > 0 && <div className="search-results">{searchMatches.map((item) => <button key={item.catalogId} onClick={() => choose(item.catalogId)}><b>{item.name}</b><span>CAT {item.catalogId} · {item.orbitType}</span></button>)}</div>}
          </div>
        </div>

        {page === 'observatory' && <section className="observatory-layout">
          <div className="globe-panel panel">
            <div className="panel-topline"><div className="panel-label"><span className="panel-mark">◉</span> EARTH OBSERVATORY <span className="subtle">/ 3D ORBITAL VIEW</span></div><div className="panel-tools"><span className="data-source-pill">PREDICTED</span><span className="panel-live"><i /> {formatDate(simTime, { dateStyle: undefined, timeStyle: 'medium', timeZone: 'UTC' })} UTC</span></div></div>
            <div className="globe-wrap">{catalog.length > 0 ? <GlobeView objects={catalog} positions={positions} selected={selected} selectedPosition={selectedPosition} simTime={simTime} observer={observer} showPaths={showPaths} onSelect={choose} /> : <div className="globe-placeholder"><span className="placeholder-orbit">◉</span><b>{catalogLoading ? 'INGESTING PUBLIC ORBITAL ELEMENTS' : 'NO CATALOG DATA AVAILABLE'}</b><small>{catalogLoading ? 'Connecting to CelesTrak GP · CSV → validated OMM' : 'Check the API connection and retry the GP feed.'}</small></div>}</div>
            <div className="globe-legend"><span><i className="legend-cyan" /> PUBLIC CATALOG OBJECTS</span><span><i className="legend-orange" /> SELECTED OBJECT</span><span><i className="legend-yellow" /> OBSERVER</span><span className="legend-data">SOURCE: CELESTRAK GP · {stale ? 'STALE CACHE' : 'CACHE ≤ 2H'}</span></div>
          </div>

          <div className="right-rail">
            <section className="panel telemetry-panel">
              <div className="panel-topline"><div className="panel-label">OBJECT TELEMETRY</div><span className="data-source-pill">PREDICTED</span></div>
              {selected ? <>
                <div className="selected-name"><div className="sat-orbit-badge">{selected.orbitType}</div><div><b>{selected.name}</b><small>NORAD CAT ID&nbsp; {selected.catalogId}</small></div><button title="Deselect" onClick={() => setSelectedId(null)}>×</button></div>
                <div className="selected-tags"><span>{selected.category.toUpperCase()}</span><span>{selected.internationalDesignator || 'DESIGNATOR UNKNOWN'}</span><span>OWNERSHIP UNVERIFIED</span></div>
                <div className="telemetry-grid">
                  <Metric label="ALTITUDE" value={selectedPosition ? `${formatNumber(selectedPosition.altitudeKm, 0)} km` : '—'} />
                  <Metric label="VELOCITY" value={selectedPosition ? `${formatNumber(selectedPosition.speedKmS, 2)} km/s` : '—'} />
                  <Metric label="INCLINATION" value={`${formatNumber(selected.orbital.INCLINATION, 2)}°`} />
                  <Metric label="ECCENTRICITY" value={formatNumber(selected.orbital.ECCENTRICITY, 5)} />
                  <Metric label="PERIOD" value={`${formatNumber(1440 / selected.orbital.MEAN_MOTION, 1)} min`} />
                  <Metric label="EPOCH" value={formatDate(selected.orbital.EPOCH, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }) + 'Z'} />
                  <Metric label="AZ / EL" value={selectedPosition ? `${formatNumber(selectedPosition.azimuth, 1)}° / ${formatNumber(selectedPosition.elevation, 1)}°` : '—'} />
                  <Metric label="RANGE" value={selectedPosition ? `${formatNumber(selectedPosition.rangeKm, 0)} km` : '—'} />
                </div>
                <div className="detail-source"><span>SOURCE</span><a href={selected.sourceUrl} target="_blank" rel="noreferrer">{selected.source} ↗</a></div>
                <div className="transmitter-block"><div className="transmitter-heading"><b>SATNOGS DB TRANSMITTERS</b><span>{transmittersLoading ? 'LOADING' : transmittersStale ? 'STALE CACHE' : transmitters.length ? `${transmitters.length} RECORDS` : 'METADATA ONLY'}</span></div>{transmittersError && <small className="transmitter-note">{transmittersError}</small>}{transmitters.slice(0, 3).map((tx) => <div className="transmitter-row" key={tx.uuid}><div><b>{tx.description}</b><small>{tx.type} · {tx.mode || 'MODE —'} · {tx.status || 'STATUS —'}{tx.unconfirmed ? ' · UNCONFIRMED' : ''}</small></div><div>{tx.downlinkLowHz ? `${formatNumber(tx.downlinkLowHz / 1_000_000, 3)} MHz DL` : 'DL —'}</div><a href={tx.url} target="_blank" rel="noreferrer">↗</a></div>)}{!transmittersLoading && !transmittersError && transmitters.length === 0 && <small className="transmitter-note">No public transmitter records returned for this catalog ID.</small>}<small className="transmitter-note">Metadata is not evidence of an active transmission or a sensor reception. Retrieved {transmitterFetchedAt ? formatDate(transmitterFetchedAt, { timeZone: 'UTC' }) + ' UTC' : 'on demand'}.</small></div>
              </> : <div className="empty-detail"><span>⌖</span><p>Select a catalog object to inspect its current propagated state.</p></div>}
            </section>

            <section className="panel quick-panel">
              <div className="panel-topline"><div className="panel-label">LOCAL SKY</div><button className="text-button" onClick={() => setPage('sky')}>OPEN SKY TRACKER ↗</button></div>
              <div className="quick-stat-row"><div><b>{overhead.length}</b><small>OBJECTS ABOVE {horizon}°</small></div><div className="quick-stat-divider" /><div><b>{formatNumber(solarElevation, 1)}°</b><small>SOLAR ELEVATION</small></div></div>
              <div className={`visibility-callout ${darkAtObserver ? 'is-dark' : ''}`}><i />{darkAtObserver ? 'Observer darkness criteria met' : 'Daylight at observer location'}<span>{darkAtObserver ? 'NIGHT' : 'DAY'}</span></div>
              <div className="horizon-control"><label>MIN. ELEVATION <b>{horizon}°</b></label><input type="range" min="0" max="45" step="1" value={horizon} onChange={(event) => setHorizon(Number(event.target.value))} /></div>
            </section>

            <section className="panel data-panel">
              <div className="panel-topline"><div className="panel-label">ORBITAL DATA</div><button className="icon-button" onClick={() => void loadCatalog()} title="Check the server cache">↻</button></div>
              <div className="data-rows"><div><span>INDEXED OBJECTS</span><b>{catalog.length.toLocaleString()}</b></div><div><span>VALID PROPAGATIONS</span><b>{positions ? validCount.toLocaleString() : '—'}</b></div><div><span>NEWEST ELEMENT EPOCH</span><b>{latestEpoch ? formatDate(latestEpoch, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '—'}</b></div><div><span>RETRIEVED</span><b>{fetchedAt ? formatDate(fetchedAt, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : '—'}</b></div></div>
            </section>
          </div>
        </section>}

        {page === 'overhead' && <section className="panel full-panel">
          <div className="filters-row"><div className="panel-label">CURRENTLY ABOVE HORIZON <span className="subtle">/ GEOMETRIC VISIBILITY</span></div><div className="filters"><select value={orbitFilter} onChange={(event) => setOrbitFilter(event.target.value)}><option value="ALL">All orbit classes</option><option>LEO</option><option>MEO</option><option>GEO</option><option>HEO</option></select><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="ALL">All categories</option><option>Payload</option><option>Rocket body</option><option>Debris</option><option>Unverified</option></select><label className="check-filter"><input type="checkbox" checked={potentiallyVisibleOnly} onChange={(event) => setPotentiallyVisibleOnly(event.target.checked)} /> NIGHT + SATELLITE LIT</label></div></div>
          <p className="subtle-copy">All listed positions are SGP4 predictions from public orbital elements. Geometric visibility does not guarantee naked-eye visibility. The optional filter requires observer Sun elevation below −6° and a sunlit satellite.</p>
          <div className="table-wrap"><table><thead><tr><th>OBJECT</th><th>CATALOG ID</th><th>AZIMUTH</th><th>ELEVATION</th><th>ALTITUDE</th><th>VELOCITY</th><th>RANGE</th><th>NEXT VISIBILITY</th><th>PASS REMAINING</th><th>ELEMENT EPOCH</th><th>SOURCE</th></tr></thead><tbody>
            {displayedOverhead.slice(0, 500).map((item) => <tr key={item.catalogId} className={item.catalogId === selectedId ? 'row-selected' : ''} onClick={() => choose(item.catalogId)}><td><b>{item.name}</b><small>{item.orbitType} · {item.category}</small></td><td className="mono">{item.catalogId}</td><td>{formatNumber(item.azimuth, 1)}°</td><td className="elevation-value">{formatNumber(item.elevation, 1)}°</td><td>{formatNumber(item.altitudeKm, 0)} km</td><td>{formatNumber(item.speedKmS, 2)} km/s</td><td>{formatNumber(item.rangeKm, 0)} km</td><td>{item.nextVisibilityAt ? <><span>{formatDate(item.nextVisibilityAt, { timeZone: 'UTC' })} UTC</span>{item.nextVisibilityEndAt && <small>to {formatDate(item.nextVisibilityEndAt, { timeZone: 'UTC' })} UTC</small>}</> : 'Calculating'}</td><td>{item.remainingPassMinutes == null ? '—' : `${formatNumber(item.remainingPassMinutes, 1)} min`}</td><td>{formatDate(item.epoch, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })} UTC</td><td><a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer">CelesTrak GP ↗</a></td></tr>)}
            {!displayedOverhead.length && <tr><td colSpan={11} className="empty-table">{workerReady ? 'No objects meet the selected horizon and filters at this simulation time.' : 'Waiting for orbital propagation…'}</td></tr>}
          </tbody></table></div>
          <div className="table-foot"><span>SHOWING {displayedOverhead.length.toLocaleString()} OF {overhead.length.toLocaleString()} ABOVE {horizon}°</span><span>UTC INTERNAL TIME · PUBLIC ELEMENTS {stale ? 'STALE' : 'WITHIN 2H CACHE'}</span></div>
        </section>}

        {page === 'catalog' && <section className="panel full-panel">
          <div className="filters-row"><div><div className="panel-label">PUBLIC ORBITAL OBJECT INDEX</div><p className="subtle-copy">Ownership and country fields are unverified unless an attributable source is present. Object categories are inferred from the CelesTrak object name only.</p></div><div className="filters"><select value={orbitFilter} onChange={(event) => setOrbitFilter(event.target.value)}><option value="ALL">All orbit classes</option><option>LEO</option><option>MEO</option><option>GEO</option><option>HEO</option></select><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="ALL">All categories</option><option>Payload</option><option>Rocket body</option><option>Debris</option><option>Unverified</option></select><select value={operatorFilter} onChange={(event) => setOperatorFilter(event.target.value)}><option value="ALL">All operators</option><option value="VERIFIED">Verified operator</option><option value="UNVERIFIED">Operator unverified</option></select><button className="secondary-button" onClick={() => void loadCatalog()}>↻ CHECK GP CACHE</button></div></div>
          <div className="table-wrap"><table><thead><tr><th>OBJECT</th><th>NORAD ID</th><th>INTL. DESIGNATOR</th><th>CATEGORY</th><th>OPERATOR</th><th>COUNTRY</th><th>ORBIT</th><th>INCLINATION</th><th>ECCENTRICITY</th><th>MEAN MOTION</th><th>EPOCH / SOURCE</th></tr></thead><tbody>{filteredCatalog.slice(0, 1000).map((item) => <tr key={item.catalogId} className={selectedId === item.catalogId ? 'row-selected' : ''} onClick={() => choose(item.catalogId)}><td><b>{item.name}</b><small>{item.quality.toUpperCase()} ELEMENT QUALITY</small></td><td className="mono">{item.catalogId}</td><td className="mono">{item.internationalDesignator || '—'}</td><td><span className="category-tag">{item.category}</span></td><td>{item.operator || 'Unverified'}</td><td>{item.country || 'Unverified'}</td><td><span className="orbit-tag">{item.orbitType}</span></td><td>{formatNumber(item.orbital.INCLINATION, 2)}°</td><td>{formatNumber(item.orbital.ECCENTRICITY, 5)}</td><td>{formatNumber(item.orbital.MEAN_MOTION, 5)} rev/day</td><td>{formatDate(item.orbital.EPOCH, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })} UTC<br /><a href={item.sourceUrl} target="_blank" rel="noreferrer">CelesTrak GP ↗</a></td></tr>)}{!filteredCatalog.length && <tr><td colSpan={11} className="empty-table">{catalogLoading ? 'Loading public orbital data…' : 'No catalog records match this search.'}</td></tr>}</tbody></table></div>
          <div className="table-foot"><span>{filteredCatalog.length.toLocaleString()} RECORDS MATCHING FILTERS · DISPLAY CAPPED AT 1,000</span><span>6+ DIGIT CATALOG IDENTIFIERS PRESERVED AS STRINGS</span></div>
        </section>}

        {page === 'analysis' && <section className="analysis-grid">
          <div className="panel analysis-main"><div className="panel-topline"><div className="panel-label">SELECTED ORBIT PARAMETERS</div><span className="data-source-pill">OMM · SGP4</span></div>{selected ? <><div className="analysis-heading"><div><span className="orbit-tag large">{selected.orbitType}</span><h2>{selected.name}</h2><p>NORAD {selected.catalogId} · {selected.internationalDesignator || 'International designator unavailable'}</p></div><button className="secondary-button" onClick={() => setPage('observatory')}>CENTER ON GLOBE ↗</button></div><div className="parameter-grid"><Metric label="SEMIMAJOR AXIS (APPROX.)" value={`${formatNumber((Math.pow(398600.4418 / Math.pow(selected.orbital.MEAN_MOTION * 2 * Math.PI / 86400, 2), 1 / 3)), 0)} km`} /><Metric label="INCLINATION" value={`${formatNumber(selected.orbital.INCLINATION, 4)}°`} /><Metric label="ECCENTRICITY" value={formatNumber(selected.orbital.ECCENTRICITY, 7)} /><Metric label="RAAN" value={`${formatNumber(selected.orbital.RA_OF_ASC_NODE, 3)}°`} /><Metric label="ARGUMENT OF PERICENTER" value={`${formatNumber(selected.orbital.ARG_OF_PERICENTER, 3)}°`} /><Metric label="MEAN ANOMALY" value={`${formatNumber(selected.orbital.MEAN_ANOMALY, 3)}°`} /><Metric label="MEAN MOTION" value={`${formatNumber(selected.orbital.MEAN_MOTION, 7)} rev/day`} /><Metric label="ORBITAL PERIOD" value={`${formatNumber(1440 / selected.orbital.MEAN_MOTION, 3)} min`} /></div><div className="epoch-banner"><span>ELEMENT EPOCH</span><b>{formatDate(selected.orbital.EPOCH, { timeZone: 'UTC' })} UTC</b><span>RETRIEVED {fetchedAt ? formatDate(fetchedAt, { timeZone: 'UTC' }) + ' UTC' : '—'}</span></div>{selectedPosition && <div className="coordinate-grid"><div><span>ECI POSITION · TEME / KM</span><code>{formatVector(selectedPosition.positionEciKm)}</code></div><div><span>ECF POSITION / KM</span><code>{formatVector(selectedPosition.positionEcfKm)}</code></div><div><span>ECI VELOCITY / KM·S⁻¹</span><code>{formatVector(selectedPosition.velocityEciKmS)}</code></div><div><span>EARTH-FIXED VELOCITY / KM·S⁻¹</span><code>{formatVector(selectedPosition.velocityEcfKmS)}</code></div></div>}</> : <div className="empty-detail">Select an object from the catalog.</div>}</div>
          <div className="panel analysis-side"><div className="panel-label">CURRENT PROPAGATED STATE</div>{selectedPosition ? <div className="parameter-grid compact"><Metric label="LATITUDE" value={`${formatNumber(selectedPosition.latitude, 4)}°`} /><Metric label="LONGITUDE" value={`${formatNumber(selectedPosition.longitude, 4)}°`} /><Metric label="ALTITUDE" value={`${formatNumber(selectedPosition.altitudeKm, 1)} km`} /><Metric label="SPEED" value={`${formatNumber(selectedPosition.speedKmS, 3)} km/s`} /><Metric label="ELEVATION" value={`${formatNumber(selectedPosition.elevation, 2)}°`} /><Metric label="SLANT RANGE" value={`${formatNumber(selectedPosition.rangeKm, 1)} km`} /></div> : <p className="subtle-copy">Propagated state will appear after the worker is ready.</p>}<div className="quality-card"><span>DATA QUALITY</span><b>PUBLIC GP ELEMENTS</b><p>SGP4 output is a calculated prediction. Public GP elements are fitted orbital elements and are not raw observations or precision ephemerides.</p><span className="quality-led" />{stale ? 'Cached elements may be stale' : 'Two-hour upstream cache policy active'}</div></div>
        </section>}

        {page === 'sky' && <section className="sky-layout">
          <div className="panel sky-panel"><div className="panel-topline"><div className="panel-label">AZIMUTH / ELEVATION POLAR VIEW</div><span className="data-source-pill">PREDICTED POSITIONS</span></div><SkyPlot positions={displayedOverhead} track={skyTrack} horizon={horizon} selectedId={selectedId} onSelect={choose} /><div className="sky-legend"><span><i className="legend-cyan" /> CATALOG OBJECT</span><span><i className="legend-orange" /> SELECTED / PASS TRACK</span><span>INNER RING = {horizon}° MINIMUM ELEVATION</span></div></div>
          <div className="panel sky-side"><div className="panel-label">HORIZON CONFIGURATION</div><div className="horizon-number">{horizon}<span>°</span></div><input type="range" min="0" max="45" step="1" value={horizon} onChange={(event) => setHorizon(Number(event.target.value))} /><div className="sky-summary"><div><span>VISIBLE OBJECTS</span><b>{displayedOverhead.length}</b></div><div><span>OBSERVER SUN ELEV.</span><b>{formatNumber(solarElevation, 1)}°</b></div><div><span>SKY CONDITION</span><b>{darkAtObserver ? 'DARK' : 'DAYLIGHT'}</b></div></div><p className="subtle-copy">Azimuth is measured clockwise from north. The plot uses an azimuthal-equidistant sky projection. Listed objects satisfy the geometric horizon threshold; atmospheric conditions and brightness are not modeled.</p></div>
        </section>}

        {page === 'stations' && <section className="panel full-panel stations-panel"><div className="filters-row"><div><div className="panel-label">PUBLIC GROUND STATION NETWORK</div><p className="subtle-copy">Public SatNOGS station metadata. Station coordinates are not live reception reports.</p></div><span className="data-source-pill">{stationsStale ? 'STALE CACHE' : 'SATNOGS NETWORK API'}</span></div>{stationsLoading && <div className="empty-table">Loading public station directory…</div>}{stationsError && <div className="alert-strip">{stationsError}<button onClick={() => { setStations([]); setStationsError(''); setStationsRequested(false); }}>RETRY</button></div>}<div className="station-grid">{stations.slice(0, 100).map((station) => <a className="station-card" key={station.id} href={station.url} target="_blank" rel="noreferrer"><div className="station-pin">⌂</div><div><b>{station.name}</b><small>STATION {station.id ?? '—'} · {station.status || 'STATUS UNSPECIFIED'}</small><span>{formatNumber(station.latitude, 3)}° / {formatNumber(station.longitude, 3)}°</span></div><span className="station-arrow">↗</span></a>)}</div>{!stations.length && !stationsLoading && !stationsError && <div className="empty-table">No station records are available.</div>}</section>}

        {page === 'observations' && <section className="observations-layout">
          <form className="panel observation-form" onSubmit={saveObservation}><div className="panel-label">ADD OBSERVATION RECORD</div><p className="subtle-copy">Stores reported measurements as observations. Leave the catalog ID blank unless the observation evidence supports that association.</p>{observationMessage && <div className="inline-message">{observationMessage}</div>}<div className="form-grid"><label>OBJECT CATALOG ID<input name="objectId" placeholder="Optional · leave blank if unidentified" /></label><label>OBJECT NAME / WORKING LABEL<input name="objectName" placeholder="Unidentified object or observer label" /></label><label>LOCAL TIME (SAVED AS UTC)<input name="observedAt" type="datetime-local" required defaultValue={localDateTimeInput()} /></label><label>SENSOR TYPE<select name="sensorType" required><option>Optical telescope</option><option>DSLR / CMOS camera</option><option>SDR radio</option><option>SatNOGS station</option><option>Other</option></select></label><label>LATITUDE °<input name="latitude" type="number" min="-90" max="90" step="any" required defaultValue={observer.latitude} /></label><label>LONGITUDE °<input name="longitude" type="number" min="-180" max="180" step="any" required defaultValue={observer.longitude} /></label><label>ALTITUDE km<input name="observerAltitudeKm" type="number" min="-0.5" max="20" step="any" required defaultValue={observer.altitudeKm} /></label><label>AZIMUTH °<input name="azimuth" type="number" min="0" max="360" step="any" placeholder="Optional" /></label><label>ELEVATION °<input name="elevation" type="number" min="-90" max="90" step="any" placeholder="Optional" /></label><label>UNCERTAINTY m<input name="uncertaintyM" type="number" min="0" step="any" placeholder="Optional" /></label><label className="form-wide">OBSERVATION SOURCE<input name="source" required placeholder="Station, observer, or dataset reference" /></label><label className="form-wide">NOTES<textarea name="notes" rows={3} placeholder="Measurement method, context, and evidence reference" /></label></div><button className="primary-button" type="submit">SAVE OBSERVATION RECORD ↗</button></form>
          <section className="panel observations-list"><div className="panel-topline"><div className="panel-label">RECENT RECORDS <span className="subtle">/ SQLITE</span></div><span className="record-count">{observations.length} STORED</span></div><div className="observation-items">{observations.map((item) => <article className="observation-item" key={item.id}><div className="observation-marker">◷</div><div className="observation-details"><b>{item.object_name || 'Unidentified object'} <span>#{item.id}</span></b><small>{item.object_id ? `CAT ${item.object_id} · ` : 'UNIDENTIFIED · '}{item.sensor_type.toUpperCase()}</small><p>{formatDate(item.observed_at, { timeZone: 'UTC' })} UTC · {formatNumber(item.latitude, 3)}°, {formatNumber(item.longitude, 3)}°</p><div className="observation-meta">{item.azimuth == null ? 'AZ —' : `AZ ${formatNumber(item.azimuth, 1)}°`} · {item.elevation == null ? 'EL —' : `EL ${formatNumber(item.elevation, 1)}°`} · {item.uncertainty_m == null ? 'UNCERTAINTY —' : `±${formatNumber(item.uncertainty_m, 1)} m`}</div><div className="subtle-copy">SOURCE: {item.source}</div></div><span className="observed-tag">OBSERVED</span></article>)}{!observations.length && <div className="empty-table">No observation records yet. Predicted positions are kept separate from this archive.</div>}</div></section>
        </section>}

        {page === 'sources' && <section className="sources-grid">
          <SourceCard icon="◉" name="CELESTRAK GP" kind="Primary orbital element source" status={catalog.length ? 'CONNECTED' : 'WAITING'} url={sourceUrl} description="Public General Perturbations orbital elements, downloaded as CSV and validated into OMM. Backend cache is capped at one refresh every two hours; source timestamp and epoch are retained." />
          <SourceCard icon="⌁" name="SATELLITE.JS / SGP4" kind="Local propagation engine" status="ACTIVE" url="https://github.com/shashwatak/satellite-js" description="Predicted ECI/ECF position, geodetic position, velocity and observer look angles are calculated locally in a Web Worker. These are predictions from fitted GP elements, not live detections." />
          <SourceCard icon="⌂" name="SATNOGS NETWORK" kind="Supplementary ground station metadata" status={stations.length ? 'CONNECTED' : 'ON DEMAND'} url="https://network.satnogs.org/api/" description="Public station directory metadata is retrieved only when the Ground Stations module is opened and cached server-side. Station metadata does not mean a satellite was observed." />
          <SourceCard icon="⌁" name="SATNOGS DB TRANSMITTERS" kind="Supplementary transmitter metadata" status={transmitterFetchedAt ? 'CONNECTED' : 'ON DEMAND'} url="https://docs.satnogs.org/projects/satnogs-db/en/stable/api.html" description="Per-object public transmitter records are requested on demand by NORAD catalog number and cached server-side for two hours. Frequencies and statuses are community metadata and do not indicate a live signal or verified identity." />
          <SourceCard icon="◷" name="LOCAL OBSERVATION ARCHIVE" kind="User supplied observation metadata" status="SQLITE" url="#observations" description="Observation records are stored separately from orbital elements. Each record retains UTC time, observer coordinates, sensor type, optional pointing and uncertainty, and a source reference. Unknown identities remain unknown." />
          <div className="trust-banner"><span>ⓘ</span><div><b>PREDICTED POSITION ≠ SENSOR DETECTION</b><p>No direct live optical or radio detections are claimed by this application. The interface labels calculated state separately from user-entered observed metadata.</p></div></div>
        </section>}
      </main>

      <footer className="simulation-bar">
        <div className="simulation-label"><span className="simulation-icon">◷</span><div><small>SIMULATION TIME</small><b>{simTime.toISOString().replace('T', ' ').slice(0, 19)} UTC</b></div></div>
        <div className="playback-controls"><button onClick={() => setSimTime((time) => new Date(time.getTime() - 60_000))} title="Back one minute">−</button><button className="play-button" onClick={() => setPlaying((value) => !value)} title={playing ? 'Pause simulation' : 'Resume simulation'}>{playing ? 'Ⅱ' : '▶'}</button><button onClick={() => setSimTime((time) => new Date(time.getTime() + 60_000))} title="Forward one minute">+</button><span className="control-divider" /><span className="speed-label">RATE</span>{SPEEDS.map((rate) => <button key={rate} className={`speed-button ${speed === rate ? 'active-speed' : ''}`} onClick={() => setSpeed(rate)}>{rate === 1 ? '1×' : rate === 3600 ? '1h/s' : `${rate}×`}</button>)}</div>
        <div className="simulation-right"><span className="worker-status"><i className={workerReady ? '' : 'idle'} />{workerReady ? 'SGP4 WORKER READY' : 'WORKER INITIALIZING'}</span><span>{catalog.length.toLocaleString()} OBJECTS</span><button onClick={() => setSimTime(new Date())}>RESET TO NOW ↺</button></div>
      </footer>
    </div>

    {showLocation && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLocation(false); }}><section className="modal-card"><div className="panel-topline"><div><div className="panel-label">OBSERVER LOCATION</div><p className="subtle-copy">Internal calculations use UTC. Local time uses this browser’s timezone.</p></div><button className="icon-button" onClick={() => setShowLocation(false)}>×</button></div><form onSubmit={saveObserver}><div className="form-grid"><label>LATITUDE °<input type="number" min="-90" max="90" step="any" value={observerDraft.latitude} onChange={(event) => setObserverDraft({ ...observerDraft, latitude: Number(event.target.value) })} required /></label><label>LONGITUDE °<input type="number" min="-180" max="180" step="any" value={observerDraft.longitude} onChange={(event) => setObserverDraft({ ...observerDraft, longitude: Number(event.target.value) })} required /></label><label className="form-wide">ALTITUDE ABOVE ELLIPSOID km<input type="number" min="-0.5" max="20" step="any" value={observerDraft.altitudeKm} onChange={(event) => setObserverDraft({ ...observerDraft, altitudeKm: Number(event.target.value) })} required /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={useBrowserLocation}>USE BROWSER LOCATION ↗</button><button type="submit" className="primary-button">SAVE LOCATION</button></div></form></section></div>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><small>{label}</small><b>{value}</b></div>; }

function SkyPlot({ positions, track, horizon, selectedId, onSelect }: { positions: SatellitePosition[]; track: SkyTrackPoint[]; horizon: number; selectedId: string | null; onSelect: (id: string) => void }) {
  const center = 180, radius = 139;
  const pointAt = (azimuth: number, elevation: number) => { const r = radius * (90 - Math.max(0, Math.min(90, elevation))) / 90; const az = azimuth * Math.PI / 180; return [center + Math.sin(az) * r, center - Math.cos(az) * r]; };
  return <div className="sky-plot-wrap"><svg className="sky-plot" viewBox="0 0 360 360" role="img" aria-label="Polar sky view of satellites above the observer horizon">
    <defs><radialGradient id="skyGradient"><stop offset="0" stopColor="#101e2a" /><stop offset="1" stopColor="#081119" /></radialGradient></defs>
    <circle cx={center} cy={center} r={radius} fill="url(#skyGradient)" stroke="#293c4d" strokeWidth="1" />
    {[30, 60].map((elevation) => <g key={elevation}><circle cx={center} cy={center} r={radius * (90 - elevation) / 90} fill="none" stroke="#203443" strokeDasharray="3 6" /><text x={center + 5} y={center - radius * (90 - elevation) / 90 + 12} className="sky-ring-label">{elevation}°</text></g>)}
    {[0, 45, 90, 135].map((azimuth) => <g key={azimuth}><line x1={center} y1={center} x2={pointAt(azimuth, 0)[0]} y2={pointAt(azimuth, 0)[1]} stroke="#233747" strokeWidth="1" /><line x1={center} y1={center} x2={pointAt(azimuth + 180, 0)[0]} y2={pointAt(azimuth + 180, 0)[1]} stroke="#233747" strokeWidth="1" /></g>)}
    <circle cx={center} cy={center} r={radius * (90 - Math.max(0, Math.min(89, horizon))) / 90} fill="none" stroke="#b97c4b" strokeWidth="1.2" strokeDasharray="5 4" opacity=".72" />
    {[0, 90, 180, 270].map((azimuth) => { const [x, y] = pointAt(azimuth, 0); return <text key={azimuth} x={x} y={y} className="sky-cardinal" textAnchor="middle" dominantBaseline={azimuth === 0 ? 'auto' : azimuth === 180 ? 'hanging' : 'middle'}>{['N', 'E', 'S', 'W'][azimuth / 90]}</text>; })}
    {track.length > 1 && <polyline points={track.map((item) => pointAt(item.azimuth, item.elevation).join(',')).join(' ')} fill="none" stroke="#ffad63" strokeWidth="2" strokeDasharray="4 4" opacity=".8"><title>Predicted next pass track for the selected object</title></polyline>}
    {positions.map((item) => { const [x, y] = pointAt(item.azimuth, item.elevation); return <g className="sky-point" key={item.catalogId} onClick={() => onSelect(item.catalogId)}><circle cx={x} cy={y} r={selectedId === item.catalogId ? 5 : 3.1} fill={selectedId === item.catalogId ? '#ffad63' : '#4ad9ef'} stroke="#071119" strokeWidth="2"><title>{item.name} · AZ {formatNumber(item.azimuth, 1)}° EL {formatNumber(item.elevation, 1)}°</title></circle></g>; })}
    <text x={center} y={center + 4} textAnchor="middle" className="sky-center-label">ZENITH</text>
  </svg><div className="sky-plot-caption">AZIMUTHAL-EQUIDISTANT PROJECTION · {horizon}° HORIZON LIMIT</div></div>;
}

function SourceCard({ icon, name, kind, status, url, description }: { icon: string; name: string; kind: string; status: string; url: string; description: string }) { return <article className="panel source-card"><div className="source-head"><span className="source-icon">{icon}</span><span className="data-source-pill">{status}</span></div><h3>{name}</h3><small>{kind}</small><p>{description}</p><a href={url} target="_blank" rel="noreferrer">SOURCE REFERENCE ↗</a></article>; }

export default App;
