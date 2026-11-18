import { useEffect, useMemo, useRef } from 'react';
import * as Cesium from 'cesium';
import type { CatalogObject, Observer, SatellitePosition } from '../types';
import { footprint, orbitPath } from '../orbit';

interface Props {
  objects: CatalogObject[];
  positions: Float64Array | null;
  selected: CatalogObject | null;
  selectedPosition: SatellitePosition | null;
  simTime: Date;
  observer: Observer;
  showPaths: boolean;
  onSelect: (id: string) => void;
}

export function GlobeView({ objects, positions, selected, selectedPosition, simTime, observer, showPaths, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer | null>(null);
  const collection = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const callback = useRef(onSelect);
  const lastData = useRef<{ objects: CatalogObject[]; positions: Float64Array | null }>({ objects: [], positions: null });

  useEffect(() => { callback.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!host.current) return;
    let alive = true;
    const instance = new Cesium.Viewer(host.current, {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false, timeline: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, baseLayerPicker: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
    });
    viewer.current = instance;
    instance.scene.backgroundColor = Cesium.Color.fromCssColorString('#070d14');
    instance.scene.globe.baseColor = Cesium.Color.fromCssColorString('#101e2a');
    instance.scene.globe.enableLighting = true;
    instance.scene.globe.showGroundAtmosphere = true;
    if (instance.scene.skyAtmosphere) instance.scene.skyAtmosphere.show = true;
    instance.scene.screenSpaceCameraController.minimumZoomDistance = 6_800_000;
    instance.scene.screenSpaceCameraController.maximumZoomDistance = 50_000_000;
    const points = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.OPAQUE });
    instance.scene.primitives.add(points);
    collection.current = points;
    const click = new Cesium.ScreenSpaceEventHandler(instance.scene.canvas);
    click.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = instance.scene.pick(event.position);
      if (picked?.id && typeof picked.id === 'string') callback.current(picked.id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'))
      .then((provider) => {
        if (alive) instance.imageryLayers.addImageryProvider(provider);
      })
      .catch(() => { /* Keep the ion-free shaded globe available offline. */ });
    instance.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(25, 20, 22_000_000) });
    return () => {
      alive = false;
      click.destroy();
      instance.destroy();
      viewer.current = null;
      collection.current = null;
    };
  }, []);

  useEffect(() => {
    const points = collection.current;
    const instance = viewer.current;
    if (!points || !instance || !positions) return;
    if (lastData.current.objects !== objects || points.length !== objects.length) {
      points.removeAll();
      for (const object of objects) points.add({
        id: object.catalogId,
        position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
        pixelSize: 2.6,
        color: Cesium.Color.fromCssColorString('#39d9f2').withAlpha(0.88),
        outlineColor: Cesium.Color.fromCssColorString('#071219'), outlineWidth: 0.45,
        scaleByDistance: new Cesium.NearFarScalar(5_000_000, 1.3, 30_000_000, 0.48),
        translucencyByDistance: new Cesium.NearFarScalar(10_000_000, 1, 50_000_000, 0.52),
      });
    }
    const count = Math.min(objects.length, Math.floor(positions.length / 3));
    for (let i = 0; i < count; i += 1) {
      const lon = positions[i * 3], lat = positions[i * 3 + 1], alt = positions[i * 3 + 2];
      const point = points.get(i);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(alt)) {
        point.show = false;
        continue;
      }
      point.show = true;
      point.position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
      const chosen = objects[i].catalogId === selected?.catalogId;
      point.pixelSize = chosen ? 7 : 2.6;
      point.color = chosen ? Cesium.Color.fromCssColorString('#ffad63') : Cesium.Color.fromCssColorString('#39d9f2').withAlpha(0.88);
    }
    lastData.current = { objects, positions };
    instance.scene.requestRender();
  }, [objects, positions, selected?.catalogId]);

  const path = useMemo(() => selected && showPaths ? orbitPath(selected, simTime, 120) : [], [selected, showPaths, Math.floor(simTime.getTime() / 60_000)]);
  const rim = useMemo(() => selected ? footprint(selected, simTime) : [], [selected, Math.floor(simTime.getTime() / 60_000)]);
  useEffect(() => {
    const instance = viewer.current;
    if (!instance) return;
    for (const id of ['althea-orbit-path', 'althea-ground-track', 'althea-footprint']) {
      const old = instance.entities.getById(id);
      if (old) instance.entities.remove(old);
    }
    const chosen = instance.entities.getById('althea-selected');
    if (chosen) instance.entities.remove(chosen);
    if (selected) instance.entities.add({ id: 'althea-selected', position: Cesium.Cartesian3.fromDegrees(selectedPosition?.longitude ?? 0, selectedPosition?.latitude ?? 0, Math.max(0, selectedPosition?.altitudeKm ?? 0) * 1000), point: { pixelSize: 7, color: Cesium.Color.fromCssColorString('#ffad63'), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 }, label: { text: `${selected.name}  /  ${selected.catalogId}`, font: '11px Inter, sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(12, -12), style: Cesium.LabelStyle.FILL_AND_OUTLINE } });
    if (selected && showPaths && path.length > 2) {
      const points = path.map(([lon, lat, alt]) => Cesium.Cartesian3.fromDegrees(lon, lat, alt));
      const ground = path.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0));
      instance.entities.add({ id: 'althea-orbit-path', polyline: { positions: points, width: 1.5, material: Cesium.Color.fromCssColorString('#52dff5').withAlpha(0.54), arcType: Cesium.ArcType.NONE } });
      instance.entities.add({ id: 'althea-ground-track', polyline: { positions: ground, width: 1.7, material: Cesium.Color.fromCssColorString('#ffad63').withAlpha(0.7), arcType: Cesium.ArcType.GEODESIC, clampToGround: true } });
      if (rim.length > 2) instance.entities.add({ id: 'althea-footprint', polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(rim.flatMap(([lon, lat]) => [lon, lat])), material: Cesium.Color.fromCssColorString('#47d5eb').withAlpha(0.11), outline: true, outlineColor: Cesium.Color.fromCssColorString('#47d5eb').withAlpha(0.48), height: 0 } });
    }
    instance.scene.requestRender();
  }, [selected?.catalogId, showPaths, path, rim]);

  useEffect(() => {
    const instance = viewer.current;
    if (!instance) return;
    let entity = instance.entities.getById('althea-observer');
    if (!entity) entity = instance.entities.add({ id: 'althea-observer', point: { pixelSize: 9, color: Cesium.Color.fromCssColorString('#ffe17a'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 }, label: { text: 'OBSERVER', font: '10px Inter, sans-serif', pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.fromCssColorString('#ffe17a'), outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE } });
    entity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(observer.longitude, observer.latitude, Math.max(0, observer.altitudeKm) * 1000));
    instance.scene.requestRender();
  }, [observer.latitude, observer.longitude, observer.altitudeKm]);

  useEffect(() => {
    const instance = viewer.current;
    const entity = instance?.entities.getById('althea-selected');
    if (!instance || !entity || !selectedPosition) return;
    entity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(selectedPosition.longitude, selectedPosition.latitude, Math.max(0, selectedPosition.altitudeKm) * 1000));
    instance.scene.requestRender();
  }, [selectedPosition?.longitude, selectedPosition?.latitude, selectedPosition?.altitudeKm]);

  return <div className="globe-stage" ref={host} aria-label="Interactive three-dimensional Earth showing predicted satellite positions">
    <div className="globe-watermark">ORBITAL DISPLAY <span>· WGS 72 / TEME → ECF</span></div>
    <div className="globe-controls-hint"><span>DRAG TO ROTATE</span><i /> <span>SCROLL TO ZOOM</span></div>
  </div>;
}
