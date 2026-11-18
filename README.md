# ALTHEA Orbital Observatory

An interactive satellite observatory built around public CelesTrak GP orbital elements and local SGP4 predictions. Predicted position output and observed measurement records are separate data types and separate UI surfaces.

## Run locally

Requirements: Node.js 22.13+ and npm.

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. The frontend proxies `/api` to the API on port 8787. The first catalog request fetches the `ACTIVE` CelesTrak GP group as CSV; the server caches and validates it in `data/althea.sqlite`. Further CelesTrak downloads are not attempted until two hours have elapsed. If a refresh fails, cached catalog records remain available and are marked stale.

For a production build:

```powershell
npm run build
npm start
```

The production API serves `dist/` and listens on port 8787. Set `PORT` and `DATABASE_PATH` in the environment to change those defaults. No credentials are required. Space-Track environment keys are placeholders only; Space-Track is not currently queried.

## Data and prediction boundary

- **CelesTrak GP** provides General Perturbations orbital elements. The server fetches CSV, validates required OMM fields, keeps catalog identifiers as strings (including six-digit values), and stores normalized OMM JSON. It records the element epoch, retrieval time, feed URL, and source label.
- **SGP4** propagation runs in a browser Web Worker. The worker calculates ECI/ECF-derived geodetic coordinates, velocity, observer azimuth/elevation/range, shadow fraction, and pass estimates. These are predictions from fitted GP elements, not direct sensor detections.
- **SatNOGS DB** transmitter metadata is requested server-side by catalog ID when an object is inspected and cached for two hours. **SatNOGS Network** station metadata is fetched server-side only when the station module is opened and cached for two hours. Neither metadata source indicates a live signal or satellite reception.
- **Observations** are user-entered metadata saved separately to SQLite. Unidentified records can remain unassociated with catalog objects. The application does not send commands to satellites or access private telemetry.
- Operator and country are left unverified unless an attributable metadata source is added. Object category is a cautious classification of the GP object name and can remain unverified.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | API liveness and current UTC time |
| `GET` | `/api/catalog?group=ACTIVE` | Cached, validated CelesTrak GP OMM catalog; supported groups include `ACTIVE`, `STATIONS`, `VISUAL`, `GPS-OPS`, `WEATHER`, and `STARLINK` |
| `GET` | `/api/stations` | Cached public SatNOGS Network station directory metadata |
| `GET` | `/api/transmitters/:catalogId` | Cached public SatNOGS DB transmitter metadata for one catalog ID |
| `GET` | `/api/observations` | Most recent 500 observation records |
| `POST` | `/api/observations` | Validate and save an observation record |

Observation `POST` accepts JSON with `observedAt` (ISO 8601), `latitude`, `longitude`, `observerAltitudeKm`, `sensorType`, and `source`. `objectId`, `objectName`, `azimuth`, `elevation`, `uncertaintyM`, and `notes` are optional. A successful response returns a local record ID; it does not assert that an object identity has been confirmed.

## Notes

- Internal time calculations use UTC. The header also shows the browser's local timezone.
- Browser geolocation is requested only after the user presses **Use browser location**. Manual coordinates remain available.
- Geometric horizon visibility is not a naked-eye visibility guarantee. The optional night/illumination filter checks observer solar elevation and satellite shadow state, but does not model brightness, weather, or light pollution.
- The globe uses CesiumJS with its bundled Natural Earth imagery and no Cesium ion token.
- Add or run unit tests with `npm test`.

## Sources

- [CelesTrak GP data formats](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- [CelesTrak usage policy](https://celestrak.org/usage-policy.php)
- [satellite.js documentation](https://github.com/shashwatak/satellite-js)
- [SatNOGS DB / Network API documentation](https://docs.satnogs.org/projects/satnogs-db/en/stable/api.html)
