import { GeoJSONSource, LngLatBounds, Map as MapLibreMap, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { cumulativeDistances, distanceM, splitPath } from '../../shared/geo';
import type { LatLng, Waypoint } from '../../shared/schema';
import { waypointLetter } from '../labels';

// O MapLibre procura o worker ao lado do próprio módulo, o que não existe depois do bundle.
setWorkerUrl(workerUrl);

const LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const VIEW_KEY = 'gps-sim:view';
const ViewSchema = z.object({ lng: z.number(), lat: z.number(), zoom: z.number() });

export interface LivePosition {
  position: LatLng;
  bearing: number;
  /** false = pausado/sem sinal (marcador esmaecido). */
  active: boolean;
}

interface MapViewProps {
  waypoints: Waypoint[];
  path: LatLng[] | null;
  live: LivePosition | null;
  /** Distância já percorrida na rota em andamento (null = sem simulação nessa rota). */
  progressM: number | null;
  /** Instrução curta sobre o mapa; some quando não ajuda mais. */
  hint: ReactNode;
  follow: boolean;
  /** Intervalo entre posições: o marcador desliza nesse tempo até a próxima. */
  tickMs: number;
  /** Muda quando o mapa deve enquadrar a rota (cenário aberto/importado). */
  fitSignal: number;
  onAdd(position: LatLng): void;
  onMove(id: string, position: LatLng): void;
  onTeleport(position: LatLng): void;
}

function readView(): z.infer<typeof ViewSchema> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    const parsed = ViewSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch {
    // Armazenamento indisponível: começa na visão padrão.
  }
  return { lng: -51.9, lat: -14.2, zoom: 3.6 };
}

function liveElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'marker-live';
  el.setAttribute('aria-label', 'Posição simulada do aparelho');
  // Seta = rumo do movimento (gira com o marcador).
  el.innerHTML =
    '<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">' +
    '<circle cx="17" cy="17" r="9" fill="var(--route)" stroke="var(--route-casing)" stroke-width="3"/>' +
    '<path d="M17 1 L22 9 L12 9 Z" fill="var(--route)"/>' +
    '</svg>';
  return el;
}

/** Acima disso é teletransporte/seek: o marcador vai direto, sem deslizar. */
const JUMP_THRESHOLD_M = 1000;

type RouteData = Parameters<GeoJSONSource['setData']>[0];

export function MapView({
  waypoints,
  path,
  live,
  progressM,
  hint,
  follow,
  tickMs,
  fitSignal,
  onAdd,
  onMove,
  onTeleport,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const markers = useRef(new Map<string, Marker>());
  const liveMarker = useRef<Marker | null>(null);
  const shown = useRef<LatLng | null>(null);
  const frame = useRef(0);
  const handlers = useRef({ onAdd, onMove, onTeleport });
  // O enquadramento reage só ao `fitSignal`; o conteúdo atual fica num ref.
  const fitTarget = useRef<readonly LatLng[]>([]);

  useEffect(() => {
    handlers.current = { onAdd, onMove, onTeleport };
    // A rota pode estar defasada logo após adicionar um ponto; os pontos nunca estão.
    fitTarget.current = [...waypoints, ...(path ?? [])];
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const view = readView();
    const map = new MapLibreMap({
      container,
      style: dark ? DARK_STYLE : LIGHT_STYLE,
      center: [view.lng, view.lat],
      zoom: view.zoom,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('route-done', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-done',
        type: 'line',
        source: 'route-done',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': cssVar('--route-done'), 'line-width': 4 },
      });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': cssVar('--route-casing'), 'line-width': 8 },
      });
      map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': cssVar('--route'), 'line-width': 4 },
      });
      setReady(true);
    });
    map.on('click', (e) => handlers.current.onAdd({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    map.on('contextmenu', (e) => {
      e.preventDefault();
      handlers.current.onTeleport({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    map.on('moveend', () => {
      const c = map.getCenter();
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() }));
      } catch {
        // Sem armazenamento: só não lembra a última visão.
      }
    });

    const markerMap = markers.current;
    return () => {
      markerMap.clear();
      liveMarker.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Marcadores dos pontos (arrastáveis).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    waypoints.forEach((wp, index) => {
      seen.add(wp.id);
      let marker = markers.current.get(wp.id);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'marker-wp';
        marker = new Marker({ element: el, draggable: true }).setLngLat([wp.lng, wp.lat]).addTo(map);
        const id = wp.id;
        const created = marker;
        created.on('dragend', () => {
          const p = created.getLngLat();
          handlers.current.onMove(id, { lat: p.lat, lng: p.lng });
        });
        // Clique no marcador não deve criar outro ponto embaixo dele.
        el.addEventListener('click', (event) => event.stopPropagation());
        markers.current.set(wp.id, marker);
      } else {
        marker.setLngLat([wp.lng, wp.lat]);
      }
      const el = marker.getElement();
      el.textContent = waypointLetter(index);
      el.title = wp.label || `Ponto ${waypointLetter(index)}`;
    });
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [waypoints, ready]);

  // Linha da rota: trecho percorrido apagado, restante em destaque.
  const cumulative = useMemo(() => (path ? cumulativeDistances(path) : null), [path]);
  useEffect(() => {
    const map = mapRef.current;
    const rest = map?.getSource('route');
    const done = map?.getSource('route-done');
    if (!ready || !(rest instanceof GeoJSONSource) || !(done instanceof GeoJSONSource)) return;
    const line = (points: LatLng[]): RouteData => ({
      type: 'FeatureCollection',
      features:
        points.length >= 2
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) } }]
          : [],
    });
    if (!path || !cumulative) {
      rest.setData(line([]));
      done.setData(line([]));
      return;
    }
    if (progressM === null) {
      rest.setData(line(path));
      done.setData(line([]));
      return;
    }
    const parts = splitPath(path, cumulative, progressM);
    rest.setData(line(parts.rest));
    done.setData(line(parts.done));
  }, [path, cumulative, progressM, ready]);

  // Enquadra a rota quando um cenário é aberto.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitSignal === 0) return;
    const points = fitTarget.current;
    if (points.length === 0) return;
    const bounds = new LngLatBounds();
    for (const p of points) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 400 });
  }, [fitSignal, ready]);

  // Posição ao vivo do aparelho.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    cancelAnimationFrame(frame.current);
    if (!live) {
      liveMarker.current?.remove();
      liveMarker.current = null;
      shown.current = null;
      return;
    }
    const target = live.position;
    if (!liveMarker.current) {
      liveMarker.current = new Marker({ element: liveElement(), rotationAlignment: 'map' })
        .setLngLat([target.lng, target.lat])
        .addTo(map);
    }
    const marker = liveMarker.current;
    marker.setRotation(live.bearing);
    marker.getElement().classList.toggle('off', !live.active);

    const place = (p: LatLng) => {
      shown.current = p;
      marker.setLngLat([p.lng, p.lat]);
      if (follow) map.jumpTo({ center: [p.lng, p.lat] });
    };

    // Desliza da posição mostrada até a nova durante um intervalo de envio,
    // para o movimento parecer contínuo como numa navegação.
    const from = shown.current;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!from || reduceMotion || distanceM(from, target) > JUMP_THRESHOLD_M) {
      place(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / tickMs);
      place({ lat: from.lat + (target.lat - from.lat) * t, lng: from.lng + (target.lng - from.lng) * t });
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [live, follow, tickMs]);

  return (
    <>
      <div ref={containerRef} className="map" />
      {hint && (
        <p className="map-hint" role="note">
          {hint}
        </p>
      )}
    </>
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#1f6feb';
}
