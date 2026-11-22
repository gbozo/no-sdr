// ============================================================
// node-sdr — /map operations map
// ============================================================
// Full-screen OpenStreetMap view fed by its own /ws/map socket. The main
// audio/FFT WebSocket is never used here.

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { gridCenter, extractGridFromText } from '~/shared';
import type { DecoderEntity, DecoderHistoryMessage } from '../engine/decoder-history.js';

interface MapStation {
  callsign: string;
  location: string;
  description: string;
  lat: number;
  lon: number;
  grid: string;
  version: string;
  clients: number;
  decoders: Array<{ mode: string; label: string; description?: string }>;
  weather: { enabled: boolean; provider: string };
}

interface MapCheckpoint {
  type: 'checkpoint';
  at: number;
  station: MapStation;
  aircraft: DecoderEntity[];
  vessels: DecoderEntity[];
  decodes: DecoderHistoryMessage[];
  positions?: DecoderHistoryMessage[];
}

interface MapUpdate {
  type: 'update';
  at: number;
  station?: MapStation;
  aircraft: DecoderEntity[];
  vessels: DecoderEntity[];
  decodes: DecoderHistoryMessage[];
  positions?: DecoderHistoryMessage[];
}

interface GridStation {
  key: string;
  callsign: string;
  mode: string;
  grid: string;
  lat: number;
  lon: number;
  text: string;
  frequencyHz: number;
  snrDb: number;
  lastSeenMs: number;
  count: number;
  noGrid?: boolean;
}

interface MetricSample {
  at: number;
  altitudeFt: number | null;
  speedKt: number | null;
}

type LayerId = 'aircraft' | 'vessels' | 'decodes' | 'positions' | 'grid' | 'weather';
type LayerState = Record<LayerId, boolean>;
type StyleId = 'dark' | 'osm' | 'light' | 'satellite' | 'terrain';

const MAP_STYLES: Record<
  StyleId,
  {
    label: string;
    url: string;
    attribution: string;
    maxZoom: number;
    subdomains?: string;
    className?: string;
  }
> = {
  dark: {
    label: 'Dark',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    subdomains: 'abc',
    className: 'map-tiles-dark',
  },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    subdomains: 'abc',
  },
  light: {
    label: 'Light',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors, Tiles style by HOT',
    maxZoom: 19,
    subdomains: 'abc',
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
  },
  terrain: {
    label: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
    subdomains: 'abc',
  },
};

const DEFAULT_LAYERS: LayerState = {
  aircraft: true,
  vessels: true,
  decodes: true,
  positions: true,
  grid: false,
  weather: false,
};

const ENTITY_STALE_MS = 60_000;
const ENTITY_ACTIVE_MS = 5 * 60_000;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function icaoHex(icao: number): string {
  return (icao & 0xff_ffff).toString(16).toUpperCase().padStart(6, '0');
}

function timeAgo(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function popupRows(rows: Array<[string, string]>): string {
  return rows
    .map(
      ([key, value]) =>
        `<div class="map-popup-row"><span class="map-popup-key">${escapeHtml(key)}</span>` +
        `<span class="map-popup-value">${escapeHtml(value)}</span></div>`,
    )
    .join('');
}

function histogramSvg(
  values: number[],
  label: string,
  unit: string,
  colour: string,
): string {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) {
    return `<div class="map-popup-hist"><div class="map-popup-hist-head"><span>${escapeHtml(label)}</span><span>collecting…</span></div></div>`;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = Math.max(1, max - min);
  const bins = new Array(10).fill(0) as number[];
  for (const value of finite) {
    const index = Math.min(9, Math.max(0, Math.floor(((value - min) / span) * 10)));
    bins[index] += 1;
  }
  const peak = Math.max(...bins, 1);
  const bars = bins
    .map((count, index) => {
      const height = Math.round((count / peak) * 26);
      const x = 2 + index * 17.6;
      const y = 30 - height;
      return `<rect x="${x.toFixed(1)}" y="${y}" width="14" height="${Math.max(1, height)}" fill="${colour}" opacity="${count > 0 ? 0.9 : 0.18}"/>`;
    })
    .join('');
  const range = span < 10 ? max.toFixed(1) : Math.round(max - min).toString();
  return `<div class="map-popup-hist">
    <div class="map-popup-hist-head"><span>${escapeHtml(label)}</span><span>${range} ${escapeHtml(unit)} · ${finite.length} samples</span></div>
    <svg viewBox="0 0 180 32" preserveAspectRatio="none">${bars}</svg>
  </div>`;
}

function externalLinks(links: Array<[string, string]>): string {
  return `<div class="map-popup-links">${links
    .map(
      ([label, href]) =>
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
    )
    .join('')}</div>`;
}

function aircraftPopup(entity: DecoderEntity, samples: MetricSample[] = []): string {
  const p = entity.payload;
  const icao = asNumber(p.icao) ?? 0;
  const hex = icaoHex(icao);
  const callsign = asString(p.callsign).trim() || hex;
  const alt = p.on_ground ? 'GND' : asNumber(p.altitude_ft) == null ? '—' : `${Math.round(asNumber(p.altitude_ft)!)} ft`;
  const speed = asNumber(p.ground_speed_kt) == null ? '—' : `${Math.round(asNumber(p.ground_speed_kt)!)} kt`;
  const track = asNumber(p.track_deg) == null ? '—' : `${Math.round(asNumber(p.track_deg)!)}°`;
  const vs = asNumber(p.vertical_rate_fpm) == null ? '—' : `${asNumber(p.vertical_rate_fpm)! > 0 ? '+' : ''}${Math.round(asNumber(p.vertical_rate_fpm)!)} fpm`;
  const squawk = asNumber(p.squawk) == null ? '—' : String(Math.round(asNumber(p.squawk)!)).padStart(4, '0');
  const emergency = asString(p.emergency);
  const altitudes = samples
    .map((sample) => sample.altitudeFt)
    .filter((value): value is number => value !== null);
  const speeds = samples
    .map((sample) => sample.speedKt)
    .filter((value): value is number => value !== null);
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(callsign)} <span class="map-popup-badge">ADS-B</span></div>
    ${emergency ? `<div class="map-popup-alert">${escapeHtml(emergency)}</div>` : ''}
    <div class="map-popup-sub">${escapeHtml(hex)} · ${escapeHtml(asString(p.category) || 'aircraft')}</div>
    ${popupRows([
      ['ALT', alt],
      ['GS', speed],
      ['TRK', track],
      ['V/S', vs],
      ['SQK', squawk],
      ['LAST', timeAgo(entity.lastSeenMs)],
    ])}
    ${altitudes.length > 1 ? histogramSvg(altitudes, 'Altitude', 'ft', '#38e8ff') : ''}
    ${histogramSvg(speeds, 'Speed', 'kt', '#7dff9b')}
    ${externalLinks([
      ['Flightradar24', `https://www.flightradar24.com/${encodeURIComponent(callsign)}`],
      ['ADS-B Exchange', `https://globe.adsbexchange.com/?icao=${hex.toLowerCase()}`],
    ])}
  </div>`;
}

function vesselPopup(entity: DecoderEntity, samples: MetricSample[] = []): string {
  const p = entity.payload;
  const mmsi = asNumber(p.mmsi) ?? 0;
  const name = asString(p.name).trim() || String(mmsi);
  const sog = asNumber(p.sog_kt) == null ? '—' : `${asNumber(p.sog_kt)!.toFixed(1)} kt`;
  const cog = asNumber(p.cog_deg) == null ? '—' : `${Math.round(asNumber(p.cog_deg)!)}°`;
  const hdg = asNumber(p.heading_deg) == null ? '—' : `${Math.round(asNumber(p.heading_deg)!)}°`;
  const speeds = samples
    .map((sample) => sample.speedKt)
    .filter((value): value is number => value !== null);
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(name)} <span class="map-popup-badge">AIS</span></div>
    <div class="map-popup-sub">${escapeHtml(asString(p.kind) || 'vessel')} · MMSI ${escapeHtml(mmsi)}</div>
    ${popupRows([
      ['CALL', asString(p.call_sign) || '—'],
      ['SOG', sog],
      ['COG', cog],
      ['HDG', hdg],
      ['DEST', asString(p.destination) || '—'],
      ['ETA', asString(p.eta) || '—'],
      ['LAST', timeAgo(entity.lastSeenMs)],
    ])}
    ${histogramSvg(speeds, 'Speed', 'kt', '#7dff9b')}
    ${externalLinks([
      ['MarineTraffic', `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`],
      ['VesselFinder', `https://www.vesselfinder.com/vessels?mmsi=${mmsi}`],
    ])}
  </div>`;
}

function stationPopup(station: MapStation): string {
  const modes = station.decoders.map((m) => m.label || m.mode.toUpperCase()).join(' · ');
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(station.callsign || 'NO-SDR')} <span class="map-popup-badge">STATION</span></div>
    <div class="map-popup-sub">${escapeHtml(station.location || 'Receiver location')}</div>
    ${popupRows([
      ['GRID', station.grid || '—'],
      ['VERSION', station.version],
      ['CLIENTS', String(station.clients)],
    ])}
    ${station.description ? `<p class="map-popup-text">${escapeHtml(station.description)}</p>` : ''}
    ${modes ? `<p class="map-popup-text"><strong>Decoders:</strong> ${escapeHtml(modes)}</p>` : ''}
  </div>`;
}

function gridPopup(station: GridStation): string {
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(station.callsign || station.grid)} <span class="map-popup-badge">${escapeHtml(station.mode.toUpperCase())}</span></div>
    <div class="map-popup-sub">${escapeHtml(station.text)}</div>
    ${popupRows([
      ['GRID', station.noGrid ? 'no grid' : station.grid],
      ['COORDS', `${station.lat.toFixed(3)}, ${station.lon.toFixed(3)}`],
      ['FREQ', station.frequencyHz > 0 ? `${(station.frequencyHz / 1e6).toFixed(6)} MHz` : '—'],
      ['SNR', Number.isFinite(station.snrDb) ? `${Math.round(station.snrDb)} dB` : '—'],
      ['HEARD', `${station.count} decode${station.count === 1 ? '' : 's'}`],
      ['LAST', timeAgo(station.lastSeenMs)],
    ])}
    ${station.noGrid ? '<p class="map-popup-text">No grid in decode; plotted near the receiver location.</p>' : ''}
  </div>`;
}

function callsignFromText(mode: string, text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  if (mode.toLowerCase() === 'wspr') return tokens[0] ?? '';
  const skip = new Set(['CQ', 'DX', 'TEST', 'DE', 'R', 'RR73', '73', 'TU', 'TNX']);
  return (
    tokens.find(
      (token) =>
        !skip.has(token.toUpperCase()) &&
        token.length >= 3 &&
        token.length <= 12 &&
        /[A-Z]/i.test(token) &&
        /[0-9]/.test(token),
    ) ?? ''
  );
}

function fieldOfLatLon(lat: number, lon: number): string {
  const i = Math.min(17, Math.max(0, Math.floor((lon + 180) / 20)));
  const j = Math.min(17, Math.max(0, Math.floor((lat + 90) / 10)));
  return String.fromCharCode(65 + i) + String.fromCharCode(65 + j);
}

function squareOfLatLon(lat: number, lon: number): string {
  const lonAdj = lon + 180;
  const latAdj = lat + 90;
  const squareLon = Math.floor((lonAdj % 20) / 2);
  const squareLat = Math.floor(latAdj % 10);
  return `${fieldOfLatLon(lat, lon)}${squareLon}${squareLat}`;
}

function subSquareOfLatLon(lat: number, lon: number): string {
  const lonAdj = lon + 180;
  const latAdj = lat + 90;
  const subLon = Math.floor(((lonAdj % 2) / 2) * 24);
  const subLat = Math.floor((latAdj % 1) * 24);
  return `${squareOfLatLon(lat, lon)}${String.fromCharCode(65 + subLon)}${String.fromCharCode(65 + subLat)}`;
}

function aircraftArt(): string {
  return `<g>
    <path d="M32 2 C35.2 2 36.6 5.6 36.6 9.6 V23.5 L62 33 V37.5 L36.6 31.5 V45 L43.5 50.5 V55 L32 51.5 L20.5 55 V50.5 L27.4 45 V31.5 L2 37.5 V33 L27.4 23.5 V9.6 C27.4 5.6 28.8 2 32 2 Z"/>
    <rect x="28" y="8.8" width="8" height="4.2" rx="1.3" opacity=".55"/>
    <path d="M30 18.5 H34 V27.5 H30 Z" opacity=".42"/>
    <rect x="22.7" y="28.5" width="5" height="9.4" rx="2.3" opacity=".88"/>
    <rect x="36.3" y="28.5" width="5" height="9.4" rx="2.3" opacity=".88"/>
    <path d="M20.5 52.5 H25.5 V55 H20.5 Z M38.5 52.5 H43.5 V55 H38.5 Z" opacity=".65"/>
  </g>`;
}

function vesselArt(shipType: number, kind: string): string {
  const hull =
    'M32 4 C38 8 43 17 44 28 L44 51 C40 57 24 57 20 51 L20 28 C21 17 26 8 32 4 Z';
  if (kind === 'AidToNavigation') {
    return `<g>
      <circle cx="32" cy="30" r="12"/>
      <path d="M32 6 L38 20 H26 Z" opacity=".85"/>
      <rect x="27" y="43" width="10" height="14" rx="4" opacity=".55"/>
    </g>`;
  }
  if (kind === 'BaseStation') {
    return `<g>
      <path d="M32 4 L54 44 H42 L32 26 L22 44 H10 Z" opacity=".9"/>
      <rect x="29" y="42" width="6" height="14" rx="2"/>
      <circle cx="32" cy="16" r="5" opacity=".55"/>
    </g>`;
  }
  if (shipType >= 70 && shipType <= 79) {
    return `<g>
      <path d="${hull}"/>
      <rect x="23.5" y="27" width="17" height="19" rx="1.5" opacity=".42"/>
      <rect x="24.5" y="29.5" width="7" height="4" rx=".6" opacity=".82"/>
      <rect x="32.5" y="29.5" width="7" height="4" rx=".6" opacity=".82"/>
      <rect x="24.5" y="34.5" width="7" height="4" rx=".6" opacity=".7"/>
      <rect x="32.5" y="34.5" width="7" height="4" rx=".6" opacity=".7"/>
      <rect x="24.5" y="39.5" width="7" height="4" rx=".6" opacity=".58"/>
      <rect x="32.5" y="39.5" width="7" height="4" rx=".6" opacity=".58"/>
      <rect x="28" y="14" width="8" height="8" rx="1.5" opacity=".55"/>
    </g>`;
  }
  if (shipType >= 80 && shipType <= 89) {
    return `<g>
      <path d="${hull}"/>
      <rect x="30" y="20" width="4" height="27" rx="2" opacity=".42"/>
      <circle cx="32" cy="29" r="3.4" opacity=".55"/>
      <circle cx="32" cy="39" r="3.4" opacity=".55"/>
      <rect x="24" y="18" width="16" height="4" rx="2" opacity=".5"/>
      <rect x="27.5" y="10" width="9" height="6" rx="2" opacity=".5"/>
    </g>`;
  }
  if (shipType >= 60 && shipType <= 69) {
    return `<g>
      <path d="${hull}"/>
      <rect x="23.5" y="23" width="17" height="7" rx="3" opacity=".48"/>
      <rect x="24.5" y="32" width="15" height="12" rx="5" opacity=".36"/>
      <rect x="27" y="12" width="10" height="7" rx="3" opacity=".55"/>
      <circle cx="27" cy="46" r="2" opacity=".55"/>
      <circle cx="37" cy="46" r="2" opacity=".55"/>
    </g>`;
  }
  if (shipType >= 30 && shipType <= 39) {
    return `<g>
      <path d="M32 8 C36 12 39 20 39 29 L39 49 C36 54 28 54 25 49 L25 29 C25 20 28 12 32 8 Z"/>
      <rect x="28" y="23" width="8" height="9" rx="2" opacity=".5"/>
      <rect x="30" y="12" width="4" height="8" rx="1.5" opacity=".4"/>
      <path d="M25 31 L19 38 L19 41 L25 36 Z M39 31 L45 38 L45 41 L39 36 Z" opacity=".35"/>
    </g>`;
  }
  if (shipType >= 50 && shipType <= 59) {
    return `<g>
      <path d="M32 7 C38 10 41 18 42 29 L42 48 C38 54 26 54 22 48 L22 29 C23 18 26 10 32 7 Z"/>
      <rect x="25" y="27" width="14" height="12" rx="5" opacity=".42"/>
      <rect x="29" y="13" width="6" height="9" rx="2" opacity=".55"/>
      <path d="M22 45 H42 V50 H22 Z" opacity=".3"/>
    </g>`;
  }
  return `<g>
    <path d="${hull}"/>
    <rect x="26" y="25" width="12" height="11" rx="3" opacity=".42"/>
    <rect x="28" y="13" width="8" height="7" rx="2" opacity=".55"/>
    <circle cx="32" cy="43" r="3" opacity=".35"/>
  </g>`;
}

function iconSvg(art: string, size: number, style: string, shadow = false): string {
  return `<svg${shadow ? ' class="map-icon-shadow"' : ''} viewBox="0 0 64 64" width="${size}" height="${size}" style="${style}">${art}</svg>`;
}

function aircraftIcon(stale = false, _altitudeFt = 0, headingDeg = 0): L.DivIcon {
  return L.divIcon({
    className: 'map-aircraft-marker',
    html: `<div class="map-aircraft-glyph${stale ? ' map-stale' : ''}">${iconSvg(aircraftArt(), 30, `transform:rotate(${headingDeg}deg)`)}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function aircraftShadowIcon(altitudeFt = 0, headingDeg = 0): L.DivIcon {
  const altitude = Math.max(0, Math.min(45_000, altitudeFt));
  const altitudeRatio = altitude / 45_000;
  const offset = 3 + altitudeRatio * 12;
  const scale = 1 - altitudeRatio * 0.4;
  const blur = 0.6 + altitudeRatio * 3.4;
  return L.divIcon({
    className: 'map-shadow-marker',
    html: `<div class="map-shadow-glyph">${iconSvg(
      aircraftArt(),
      30,
      `transform:translate(${offset.toFixed(1)}px,${offset.toFixed(1)}px) scale(${scale.toFixed(2)}) rotate(${headingDeg}deg);filter:blur(${blur.toFixed(2)}px)`,
      true,
    )}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function vesselIcon(stale = false, headingDeg = 0, shipType = 0, kind = ''): L.DivIcon {
  return L.divIcon({
    className: 'map-vessel-marker',
    html: `<div class="map-vessel-glyph${stale ? ' map-stale' : ''}">${iconSvg(vesselArt(shipType, kind), 28, `transform:rotate(${headingDeg}deg)`)}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function vesselShadowIcon(headingDeg = 0, shipType = 0, kind = ''): L.DivIcon {
  return L.divIcon({
    className: 'map-shadow-marker',
    html: `<div class="map-shadow-glyph">${iconSvg(
      vesselArt(shipType, kind),
      28,
      `transform:translate(4px,4px) scale(1) rotate(${headingDeg}deg);filter:blur(1.2px)`,
      true,
    )}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function entitySpeed(row: DecoderEntity): number | null {
  return row.kind === 'aircraft'
    ? asNumber(row.payload.ground_speed_kt)
    : asNumber(row.payload.sog_kt);
}

function entityHeading(row: DecoderEntity): number | null {
  return row.kind === 'aircraft'
    ? asNumber(row.payload.track_deg)
    : asNumber(row.payload.cog_deg) ?? asNumber(row.payload.heading_deg);
}

function entityAltitude(row: DecoderEntity): number {
  return row.kind === 'aircraft' ? asNumber(row.payload.altitude_ft) ?? 0 : 0;
}

/** Dead-reckon forward from the last known fix. Capped at one minute so a
 *  lost target settles on a plausible final position instead of drifting away. */
function predictedPosition(row: DecoderEntity, now: number): [number, number] | null {
  const lat = asNumber(row.payload.lat);
  const lon = asNumber(row.payload.lon);
  if (lat === null || lon === null) return null;
  const speed = entitySpeed(row);
  const heading = entityHeading(row);
  if (speed === null || heading === null || speed <= 0) return [lat, lon];
  const seconds = Math.max(0, Math.min(60_000, now - row.lastSeenMs)) / 1000;
  if (seconds <= 0) return [lat, lon];
  const distanceNm = (speed * seconds) / 3600;
  const bearing = (heading * Math.PI) / 180;
  const nextLat = lat + (distanceNm / 60) * Math.cos(bearing);
  const nextLon =
    lon +
    (distanceNm / 60) *
      (Math.sin(bearing) / Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [nextLat, nextLon];
}

function leaderPoint(row: DecoderEntity, from: [number, number]): [number, number] | null {
  const speed = entitySpeed(row);
  const heading = entityHeading(row);
  if (speed === null || heading === null || speed <= 0) return null;
  const seconds = row.kind === 'aircraft' ? 60 : 360;
  const distanceNm = (speed * seconds) / 3600;
  const bearing = (heading * Math.PI) / 180;
  const lat = from[0] + (distanceNm / 60) * Math.cos(bearing);
  const lon =
    from[1] +
    (distanceNm / 60) *
      (Math.sin(bearing) / Math.max(0.05, Math.cos((from[0] * Math.PI) / 180)));
  return [lat, lon];
}

/** Older trail points are blue, newest are neon green, like an FR24 path. */
function trailColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const stops = [
    [47, 108, 255],
    [34, 211, 238],
    [57, 255, 20],
  ];
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const from = stops[index];
  const to = stops[index + 1];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * fraction);
  return `rgb(${mix(from[0], to[0])},${mix(from[1], to[1])},${mix(from[2], to[2])})`;
}

function gridIcon(station: GridStation): L.DivIcon {
  return L.divIcon({
    className: 'map-grid-marker',
    html: `<div class="map-grid-glyph"><span class="map-grid-label">${escapeHtml(station.callsign || station.grid || 'NO GRID')}</span><span class="map-grid-mode">${escapeHtml(station.mode.toUpperCase())}</span></div>`,
    iconSize: [64, 30],
    iconAnchor: [32, 15],
  });
}

function positionIcon(callsign: string, mode: string): L.DivIcon {
  return L.divIcon({
    className: 'map-grid-marker',
    html: `<div class="map-grid-glyph map-position-glyph"><span class="map-grid-label">${escapeHtml(callsign || 'POSITION')}</span><span class="map-grid-mode">${escapeHtml(mode.toUpperCase())}</span></div>`,
    iconSize: [64, 30],
    iconAnchor: [32, 15],
  });
}

function positionPopup(message: DecoderHistoryMessage): string {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const aprs = (payload.aprs ?? {}) as Record<string, unknown>;
  const lat = asNumber(aprs.lat) ?? asNumber(payload.lat);
  const lon = asNumber(aprs.lon) ?? asNumber(payload.lon);
  const callsign =
    asString(aprs.from) ||
    asString(payload.callsign) ||
    callsignFromText(message.mode, message.text) ||
    message.mode.toUpperCase();
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(callsign)} <span class="map-popup-badge">${escapeHtml(message.mode.toUpperCase())}</span></div>
    <div class="map-popup-sub">${escapeHtml(message.text)}</div>
    ${popupRows([
      ['COORDS', lat !== null && lon !== null ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : '—'],
      ['FREQ', message.frequencyHz > 0 ? `${(message.frequencyHz / 1e6).toFixed(6)} MHz` : '—'],
      ['SNR', Number.isFinite(message.snrDb) ? `${Math.round(message.snrDb)} dB` : '—'],
      ['LAST', timeAgo(message.receivedMs)],
    ])}
  </div>`;
}

function stationIcon(station: MapStation): L.DivIcon {
  return L.divIcon({
    className: 'map-station-marker',
    html: `<div class="map-station-ring"></div>
      <div class="map-station-core">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 21v-7m0 0 5-5m-5 5-5-5m5-5a2 2 0 100-4 2 2 0 000 4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </div>
      <div class="map-station-label">${escapeHtml(station.callsign || 'NO-SDR')}<small>${escapeHtml(station.grid || 'receiver')}</small></div>`,
    iconSize: [120, 70],
    iconAnchor: [60, 34],
  });
}

const MapPage: Component = () => {
  const navigate = useNavigate();
  let container: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let baseLayer: L.TileLayer | undefined;
  let weatherOverlay: L.ImageOverlay | undefined;
  let cloudTimer: number | null = null;
  let cloudRequest = 0;
  let cloudFetchKey = '';
  const cloudCache = new Map<
    string,
    { at: number; dataUrl: string; bounds: L.LatLngBounds }
  >();
  let resizeObserver: ResizeObserver | undefined;

  const [mapReady, setMapReady] = createSignal(false);
  const [connection, setConnection] = createSignal<'connecting' | 'live' | 'offline'>('connecting');
  const [station, setStation] = createSignal<MapStation | null>(null);
  const [aircraft, setAircraft] = createSignal<DecoderEntity[]>([]);
  const [vessels, setVessels] = createSignal<DecoderEntity[]>([]);
  const [decodes, setDecodes] = createSignal<Map<number, DecoderHistoryMessage>>(new Map());
  const [positions, setPositions] = createSignal<Map<number, DecoderHistoryMessage>>(new Map());
  const [lastAt, setLastAt] = createSignal<number | null>(null);
  const [ageTick, setAgeTick] = createSignal(0);
  const [layerState, setLayerState] = createSignal<LayerState>(readLayers());
  const [styleId, setStyleId] = createSignal<StyleId>(readStyle());

  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let ageTimer: number | null = null;
  let motionTimer: number | null = null;
  let initialViewDone = false;

  let aircraftGroup: L.LayerGroup | undefined;
  let vesselGroup: L.LayerGroup | undefined;
  let decodeGroup: L.LayerGroup | undefined;
  let positionGroup: L.LayerGroup | undefined;
  let gridGroup: L.LayerGroup | undefined;
  let stationGroup: L.LayerGroup | undefined;
  let stationMarker: L.Marker | undefined;

  const aircraftMarkers = new Map<string, L.Marker>();
  const aircraftStale = new Map<string, boolean>();
  const aircraftRows = new Map<string, DecoderEntity>();
  const aircraftSamples = new Map<string, MetricSample[]>();
  const aircraftDots = new Map<string, L.LayerGroup>();
  const aircraftLeaders = new Map<string, L.Polyline>();
  const aircraftShadows = new Map<string, L.Marker>();
  const vesselMarkers = new Map<string, L.Marker>();
  const vesselStale = new Map<string, boolean>();
  const vesselRows = new Map<string, DecoderEntity>();
  const vesselSamples = new Map<string, MetricSample[]>();
  const vesselDots = new Map<string, L.LayerGroup>();
  const vesselLeaders = new Map<string, L.Polyline>();
  const vesselShadows = new Map<string, L.Marker>();
  const gridMarkers = new Map<string, L.Marker>();
  const positionMarkers = new Map<number, L.Marker>();
  const aircraftTrails = new Map<string, L.LayerGroup>();
  const vesselTrails = new Map<string, L.LayerGroup>();

  function readLayers(): LayerState {
    try {
      const raw = localStorage.getItem('sdr.map.layers');
      if (raw) return { ...DEFAULT_LAYERS, ...(JSON.parse(raw) as Partial<LayerState>) };
    } catch {}
    return { ...DEFAULT_LAYERS };
  }
  function readStyle(): StyleId {
    const raw = localStorage.getItem('sdr.map.style');
    return raw && raw in MAP_STYLES ? (raw as StyleId) : 'dark';
  }
  function saveLayers(value: LayerState) {
    localStorage.setItem('sdr.map.layers', JSON.stringify(value));
  }
  function saveStyle(value: StyleId) {
    localStorage.setItem('sdr.map.style', value);
  }

  const gridStations = createMemo<GridStation[]>(() => {
    const aggregated = new Map<string, GridStation>();
    const receiver = station();
    const receiverLat = asNumber(receiver?.lat);
    const receiverLon = asNumber(receiver?.lon);
    for (const message of decodes().values()) {
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      const storedGrid = asString(payload.grid);
      const grid = (storedGrid || extractGridFromText(message.mode, message.text)).toUpperCase();
      const center = grid ? gridCenter(grid) : null;
      const callsign =
        asString(payload.callsign).trim() || callsignFromText(message.mode, message.text);
      let key: string;
      let lat: number;
      let lon: number;
      let noGrid = false;
      if (center) {
        key = `${message.mode}|${grid}|${callsign || message.text}`;
        lat = center.lat;
        lon = center.lon;
      } else {
        if (
          receiverLat === null ||
          receiverLon === null ||
          (receiverLat === 0 && receiverLon === 0)
        ) {
          continue;
        }
        key = `${message.mode}|nogrid|${callsign || message.text}`;
        const hash = [...key].reduce((value, char) => (value * 31 + char.charCodeAt(0)) | 0, 0);
        lat = receiverLat + (((Math.abs(hash) % 9) - 4) * 0.012);
        lon = receiverLon + ((((Math.abs(hash) >> 4) % 9) - 4) * 0.016);
        noGrid = true;
      }
      const previous = aggregated.get(key);
      if (previous) {
        previous.count += 1;
        if (message.receivedMs > previous.lastSeenMs) {
          previous.lastSeenMs = message.receivedMs;
          previous.text = message.text;
          previous.snrDb = message.snrDb;
        }
        continue;
      }
      aggregated.set(key, {
        key,
        callsign,
        mode: message.mode,
        grid,
        lat,
        lon,
        text: message.text,
        frequencyHz: message.frequencyHz,
        snrDb: message.snrDb,
        lastSeenMs: message.receivedMs,
        count: 1,
        noGrid,
      });
    }
    return [...aggregated.values()];
  });

  const positionStations = createMemo(() => {
    const out: Array<{
      message: DecoderHistoryMessage;
      callsign: string;
      lat: number;
      lon: number;
    }> = [];
    for (const message of positions().values()) {
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      const aprs = (payload.aprs ?? {}) as Record<string, unknown>;
      const lat = asNumber(aprs.lat) ?? asNumber(payload.lat);
      const lon = asNumber(aprs.lon) ?? asNumber(payload.lon);
      if (lat === null || lon === null) continue;
      const callsign =
        asString(aprs.from) ||
        asString(payload.callsign) ||
        callsignFromText(message.mode, message.text) ||
        message.mode.toUpperCase();
      out.push({ message, callsign, lat, lon });
    }
    return out;
  });

  const activeAircraft = createMemo(() => {
    ageTick();
    const cutoff = Date.now() - ENTITY_ACTIVE_MS;
    return aircraft().filter((row) => row.lastSeenMs >= cutoff);
  });

  const activeVessels = createMemo(() => {
    ageTick();
    const cutoff = Date.now() - ENTITY_ACTIVE_MS;
    return vessels().filter((row) => row.lastSeenMs >= cutoff);
  });

  const setLayer = (id: LayerId, enabled: boolean) => {
    const next = { ...layerState(), [id]: enabled };
    setLayerState(next);
    saveLayers(next);
  };

  function applyBaseStyle() {
    if (!map) return;
    if (baseLayer) map.removeLayer(baseLayer);
    const style = MAP_STYLES[styleId()];
    const options: L.TileLayerOptions = {
      attribution: style.attribution,
      maxZoom: style.maxZoom,
      detectRetina: true,
    };
    if (style.subdomains) options.subdomains = style.subdomains;
    if (style.className) options.className = style.className;
    baseLayer = L.tileLayer(style.url, options).addTo(map);
  }

  function scheduleClouds() {
    if (!map || !layerState().weather) return;
    if (cloudTimer !== null) window.clearTimeout(cloudTimer);
    cloudTimer = window.setTimeout(() => {
      cloudTimer = null;
      void refreshCloudCover();
    }, 350);
  }

  function renderCloudCanvas(values: Array<number | null>, cols: number, rows: number): string {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const frame = ctx.createImageData(size, size);
    const data = frame.data;
    const valueAt = (col: number, row: number) =>
      values[row * cols + col] ?? 0;

    for (let y = 0; y < size; y++) {
      const gy = (y + 0.5) / size * (rows - 1);
      const y0 = Math.min(rows - 1, Math.floor(gy));
      const y1 = Math.min(rows - 1, y0 + 1);
      const ty = gy - y0;
      for (let x = 0; x < size; x++) {
        const gx = (x + 0.5) / size * (cols - 1);
        const x0 = Math.min(cols - 1, Math.floor(gx));
        const x1 = Math.min(cols - 1, x0 + 1);
        const tx = gx - x0;
        const top = valueAt(x0, y0) * (1 - tx) + valueAt(x1, y0) * tx;
        const bottom = valueAt(x0, y1) * (1 - tx) + valueAt(x1, y1) * tx;
        const coverage = Math.max(0, Math.min(100, top * (1 - ty) + bottom * ty));
        const t = coverage / 100;
        const smooth = t * t * (3 - 2 * t);
        const index = (y * size + x) * 4;
        data[index] = 235;
        data[index + 1] = 246;
        data[index + 2] = 255;
        data[index + 3] = Math.round(smooth * 150);
      }
    }
    ctx.putImageData(frame, 0, 0);
    return canvas.toDataURL('image/webp', 0.9);
  }

  async function refreshCloudCover() {
    if (!map || !layerState().weather) return;
    const bounds = map.getBounds();
    const lonPad = Math.max(0.05, (bounds.getEast() - bounds.getWest()) * 0.18);
    const latPad = Math.max(0.05, (bounds.getNorth() - bounds.getSouth()) * 0.18);
    const west = Math.max(-180, bounds.getWest() - lonPad);
    const east = Math.min(180, bounds.getEast() + lonPad);
    const south = Math.max(-85, bounds.getSouth() - latPad);
    const north = Math.min(85, bounds.getNorth() + latPad);
    const cols = 7;
    const rows = 7;
    const cacheKey =
      `${north.toFixed(3)},${south.toFixed(3)},${west.toFixed(3)},${east.toFixed(3)}` +
      `|${cols}x${rows}`;
    const cached = cloudCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
      showCloudOverlay(cached.dataUrl, cached.bounds);
      return;
    }
    if (cloudFetchKey === cacheKey) return;
    cloudFetchKey = cacheKey;
    const lats: string[] = [];
    const lons: string[] = [];
    for (let row = 0; row < rows; row++) {
      const lat = north - (north - south) * (row / (rows - 1));
      for (let col = 0; col < cols; col++) {
        lats.push(lat.toFixed(4));
        lons.push((west + (east - west) * (col / (cols - 1))).toFixed(4));
      }
    }
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}` +
      `&longitude=${lons.join(',')}&current=cloud_cover&timezone=UTC`;
    const request = ++cloudRequest;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const payload = await res.json();
      const items = Array.isArray(payload) ? payload : [payload];
      const values = items.map((item) => {
        const value = item?.current?.cloud_cover;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
      });
      if (request !== cloudRequest || !layerState().weather || !map) return;
      const dataUrl = renderCloudCanvas(values, cols, rows);
      if (!dataUrl) return;
      const overlayBounds = L.latLngBounds([
        [south, west],
        [north, east],
      ]);
      if (cloudCache.size > 32) cloudCache.clear();
      cloudCache.set(cacheKey, { at: Date.now(), dataUrl, bounds: overlayBounds });
      showCloudOverlay(dataUrl, overlayBounds);
    } catch {
      // Leave the last good cloud image in place.
    } finally {
      if (cloudFetchKey === cacheKey) cloudFetchKey = '';
    }
  }

  function showCloudOverlay(dataUrl: string, bounds: L.LatLngBounds) {
    if (!map) return;
    if (!weatherOverlay) {
      weatherOverlay = L.imageOverlay(dataUrl, bounds, {
        opacity: 0.78,
        pane: 'weatherPane',
        interactive: false,
        attribution: 'Weather data &copy; Open-Meteo',
      }).addTo(map);
    } else {
      weatherOverlay.setBounds(bounds);
      weatherOverlay.setUrl(dataUrl);
      if (!map.hasLayer(weatherOverlay)) weatherOverlay.addTo(map);
    }
  }

  function syncWeatherLayer() {
    if (!map) return;
    const shouldShow = layerState().weather && station()?.weather.enabled !== false;
    if (shouldShow) {
      if (weatherOverlay) {
        if (!map.hasLayer(weatherOverlay)) {
          weatherOverlay.addTo(map);
          scheduleClouds();
        }
      } else {
        scheduleClouds();
      }
    } else if (weatherOverlay && map.hasLayer(weatherOverlay)) {
      map.removeLayer(weatherOverlay);
    }
  }

  function refreshGrid() {
    if (!map || !gridGroup) return;
    gridGroup.clearLayers();
    if (!layerState().grid) return;
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    // Field (20°x10°) → square (2°x1°) → subsquare (5'x2.5'). Keeping the
    // 5' grid for zoom >= 11 avoids thousands of cells at z9-z10 (which used
    // to hit the old cell cap and leave the right half of the map bare).
    const stepLon = zoom >= 11 ? 2 / 24 : zoom >= 6 ? 2 : 20;
    const stepLat = zoom >= 11 ? 1 / 24 : zoom >= 6 ? 1 : 10;
    const west = Math.max(-180, Math.floor((bounds.getWest() + 180) / stepLon) * stepLon - 180);
    const east = Math.min(180, bounds.getEast());
    const south = Math.max(-90, Math.floor((bounds.getSouth() + 90) / stepLat) * stepLat - 90);
    const north = Math.min(90, bounds.getNorth());
    let added = 0;
    for (let lon = west; lon < east && added < 6000; lon += stepLon) {
      for (let lat = south; lat < north && added < 6000; lat += stepLat) {
        const centreLat = lat + stepLat / 2;
        const centreLon = Math.min(lon + stepLon / 2, 179.999);
        const label =
          zoom >= 11
            ? subSquareOfLatLon(centreLat, centreLon)
            : zoom >= 6
              ? squareOfLatLon(centreLat, centreLon)
              : fieldOfLatLon(centreLat, centreLon);
        L.rectangle(
          [
            [lat, lon],
            [lat + stepLat, lon + stepLon],
          ],
          {
            color: 'rgba(74, 163, 255, 0.34)',
            weight: 0.8,
            fill: false,
            interactive: false,
            pane: 'maidenheadPane',
          },
        ).addTo(gridGroup);
        if (added < 1200) {
          L.marker([centreLat, centreLon], {
            icon: L.divIcon({
              className: 'maidenhead-label-anchor',
              html: `<span class="maidenhead-label">${label}</span>`,
              iconSize: [1, 1],
              iconAnchor: [0.5, 0.5],
            }),
            pane: 'maidenheadPane',
            interactive: false,
          }).addTo(gridGroup);
        }
        added += 1;
      }
    }
  }

  function syncMarkers() {
    if (!map) return;
    const s = station();
    const now = Date.now();

    if (stationGroup && s) {
      const lat = asNumber(s.lat);
      const lon = asNumber(s.lon);
      const hasPosition = lat !== null && lon !== null && (lat !== 0 || lon !== 0);
      if (hasPosition) {
        const position: [number, number] = [lat, lon];
        if (!stationMarker) {
          stationMarker = L.marker(position, { icon: stationIcon(s), zIndexOffset: 2000 })
            .bindPopup(stationPopup(s), { className: 'sdr-map-popup', maxWidth: 330 })
            .addTo(stationGroup);
        } else {
          // Update in place; recreating the marker would close an open popup
          // every time a nearby aircraft/vessel update arrives.
          stationMarker.setLatLng(position);
          stationMarker.setIcon(stationIcon(s));
          stationMarker.setPopupContent(stationPopup(s));
        }
      } else if (stationMarker) {
        stationGroup.removeLayer(stationMarker);
        stationMarker = undefined;
      }
    }

    const syncEntities = (
      rows: DecoderEntity[],
      markers: Map<string, L.Marker>,
      staleState: Map<string, boolean>,
      rowState: Map<string, DecoderEntity>,
      samples: Map<string, MetricSample[]>,
      trails: Map<string, L.LayerGroup>,
      dots: Map<string, L.LayerGroup>,
      leaders: Map<string, L.Polyline>,
      shadows: Map<string, L.Marker>,
      group: L.LayerGroup | undefined,
      icon: (row: DecoderEntity, stale: boolean) => L.DivIcon,
      shadowIcon: (row: DecoderEntity) => L.DivIcon,
      popup: (row: DecoderEntity, samples: MetricSample[]) => string,
    ) => {
      if (!group) return;
      const present = new Set<string>();
      for (const row of rows) {
        const position = predictedPosition(row, now);
        if (!position) continue;
        present.add(row.key);
        rowState.set(row.key, row);
        let history = samples.get(row.key);
        const lastSample = history?.[history.length - 1]?.at ?? 0;
        if (row.lastSeenMs > lastSample) {
          if (!history) {
            history = [];
            samples.set(row.key, history);
          }
          history.push({
            at: row.lastSeenMs,
            altitudeFt:
              row.kind === 'aircraft' ? asNumber(row.payload.altitude_ft) : null,
            speedKt:
              row.kind === 'aircraft'
                ? asNumber(row.payload.ground_speed_kt)
                : asNumber(row.payload.sog_kt),
          });
          if (history.length > 60) history.shift();
        }
        const popupHtml = popup(row, history ?? []);
        const stale = now - row.lastSeenMs > ENTITY_STALE_MS;
        let marker = markers.get(row.key);
        if (!marker) {
          marker = L.marker(position, {
            icon: icon(row, stale),
            opacity: stale ? 0.48 : 1,
          })
            .bindPopup(popupHtml, { className: 'sdr-map-popup', maxWidth: 340 })
            .addTo(group);
          markers.set(row.key, marker);
          staleState.set(row.key, stale);
        } else {
          marker.setLatLng(position);
          marker.setIcon(icon(row, stale));
          marker.setOpacity(stale ? 0.48 : 1);
          staleState.set(row.key, stale);
          marker.setPopupContent(popupHtml);
        }

        let shadow = shadows.get(row.key);
        if (!shadow) {
          shadow = L.marker(position, {
            icon: shadowIcon(row),
            pane: 'shadowPane',
            interactive: false,
            keyboard: false,
            opacity: stale ? 0.22 : 0.8,
          }).addTo(group);
          shadows.set(row.key, shadow);
        } else {
          shadow.setLatLng(position);
          shadow.setIcon(shadowIcon(row));
          shadow.setOpacity(stale ? 0.22 : 0.8);
        }

        const track = Array.isArray(row.payload.track)
          ? (row.payload.track as [number, number][])
          : [];
        if (track.length > 1) {
          let trailGroup = trails.get(row.key);
          if (!trailGroup) {
            trailGroup = L.layerGroup().addTo(group);
            trails.set(row.key, trailGroup);
          }
          trailGroup.clearLayers();

          // One thin dark casing, then a blue→cyan→green segmented path so it
          // reads like a Flightradar-style history rather than a single line.
          L.polyline(track, {
            color: '#151515',
            weight: 4.4,
            opacity: stale ? 0.12 : 0.4,
            interactive: false,
          }).addTo(trailGroup);

          const bands = Math.min(12, Math.max(1, track.length - 1));
          for (let band = 0; band < bands; band++) {
            const start = Math.floor((band * (track.length - 1)) / bands);
            const end = Math.ceil(((band + 1) * (track.length - 1)) / bands);
            const slice = track.slice(start, end + 1);
            if (slice.length < 2) continue;
            const colour = stale
              ? '#555555'
              : trailColor((band + 0.5) / bands);
            L.polyline(slice, {
              color: colour,
              weight: 3.2,
              opacity: stale ? 0.2 : 0.72,
              interactive: false,
            }).addTo(trailGroup);
          }

          let dotGroup = dots.get(row.key);
          if (!dotGroup) {
            dotGroup = L.layerGroup().addTo(group);
            dots.set(row.key, dotGroup);
          }
          dotGroup.clearLayers();
          for (const point of track) {
            L.circleMarker(point, {
              radius: 2.2,
              stroke: false,
              fillColor: '#b7ffc9',
              fillOpacity: stale ? 0.28 : 0.92,
              interactive: false,
            }).addTo(dotGroup);
          }
        }

        const lead = leaderPoint(row, position);
        let leader = leaders.get(row.key);
        if (lead) {
          if (!leader) {
            leader = L.polyline([position, lead], {
              color: '#39ff14',
              weight: 1.6,
              opacity: stale ? 0.25 : 0.9,
              dashArray: '6 5',
              interactive: false,
            }).addTo(group);
            leaders.set(row.key, leader);
          } else {
            leader.setLatLngs([position, lead]);
            leader.setStyle({
              color: '#39ff14',
              opacity: stale ? 0.25 : 0.9,
            });
          }
        } else if (leader) {
          group.removeLayer(leader);
          leaders.delete(row.key);
        }
      }
      for (const [key, marker] of markers) {
        if (!present.has(key)) {
          group.removeLayer(marker);
          markers.delete(key);
          staleState.delete(key);
          rowState.delete(key);
          samples.delete(key);
        }
      }
      for (const [key, trail] of trails) {
        if (!present.has(key)) {
          group.removeLayer(trail);
          trails.delete(key);
        }
      }
      for (const [key, dotGroup] of dots) {
        if (!present.has(key)) {
          group.removeLayer(dotGroup);
          dots.delete(key);
        }
      }
      for (const [key, leader] of leaders) {
        if (!present.has(key)) {
          group.removeLayer(leader);
          leaders.delete(key);
        }
      }
      for (const [key, shadow] of shadows) {
        if (!present.has(key)) {
          group.removeLayer(shadow);
          shadows.delete(key);
        }
      }
    };

    syncEntities(
      activeAircraft(),
      aircraftMarkers,
      aircraftStale,
      aircraftRows,
      aircraftSamples,
      aircraftTrails,
      aircraftDots,
      aircraftLeaders,
      aircraftShadows,
      aircraftGroup,
      (row, stale) => aircraftIcon(stale, entityAltitude(row), entityHeading(row) ?? 0),
      (row) => aircraftShadowIcon(entityAltitude(row), entityHeading(row) ?? 0),
      aircraftPopup,
    );
    syncEntities(
      activeVessels(),
      vesselMarkers,
      vesselStale,
      vesselRows,
      vesselSamples,
      vesselTrails,
      vesselDots,
      vesselLeaders,
      vesselShadows,
      vesselGroup,
      (row, stale) =>
        vesselIcon(
          stale,
          entityHeading(row) ?? 0,
          asNumber(row.payload.ship_type) ?? 0,
          asString(row.payload.kind),
        ),
      (row) =>
        vesselShadowIcon(
          entityHeading(row) ?? 0,
          asNumber(row.payload.ship_type) ?? 0,
          asString(row.payload.kind),
        ),
      vesselPopup,
    );

    if (decodeGroup) {
      const present = new Set<string>();
      for (const station of gridStations()) {
        present.add(station.key);
        const position: [number, number] = [station.lat, station.lon];
        let marker = gridMarkers.get(station.key);
        if (!marker) {
          marker = L.marker(position, { icon: gridIcon(station) })
            .bindPopup(gridPopup(station), { className: 'sdr-map-popup', maxWidth: 350 })
            .addTo(decodeGroup);
          gridMarkers.set(station.key, marker);
        } else {
          marker.setLatLng(position);
          marker.setIcon(gridIcon(station));
          marker.setPopupContent(gridPopup(station));
        }
      }
      for (const [key, marker] of gridMarkers) {
        if (!present.has(key)) {
          decodeGroup.removeLayer(marker);
          gridMarkers.delete(key);
        }
      }
    }

    if (positionGroup) {
      const present = new Set<number>();
      for (const item of positionStations()) {
        const id = item.message.id;
        present.add(id);
        const latlng: [number, number] = [item.lat, item.lon];
        let marker = positionMarkers.get(id);
        if (!marker) {
          marker = L.marker(latlng, { icon: positionIcon(item.callsign, item.message.mode) })
            .bindPopup(positionPopup(item.message), { className: 'sdr-map-popup', maxWidth: 340 })
            .addTo(positionGroup);
          positionMarkers.set(id, marker);
        } else {
          marker.setLatLng(latlng);
          marker.setIcon(positionIcon(item.callsign, item.message.mode));
          marker.setPopupContent(positionPopup(item.message));
        }
      }
      for (const [id, marker] of positionMarkers) {
        if (!present.has(id)) {
          positionGroup.removeLayer(marker);
          positionMarkers.delete(id);
        }
      }
    }
  }

  function movePredictedEntities() {
    if (!map) return;
    const now = Date.now();
    const move = (
      rows: Map<string, DecoderEntity>,
      markers: Map<string, L.Marker>,
      leaders: Map<string, L.Polyline>,
      shadows: Map<string, L.Marker>,
    ) => {
      for (const [key, row] of rows) {
        const position = predictedPosition(row, now);
        if (!position) continue;
        markers.get(key)?.setLatLng(position);
        shadows.get(key)?.setLatLng(position);
        const leader = leaders.get(key);
        const lead = leaderPoint(row, position);
        if (leader && lead) leader.setLatLngs([position, lead]);
      }
    };
    move(aircraftRows, aircraftMarkers, aircraftLeaders, aircraftShadows);
    move(vesselRows, vesselMarkers, vesselLeaders, vesselShadows);
  }

  function applyLayerVisibility() {
    if (!map) return;
    const state = layerState();
    const toggle = (group: L.LayerGroup | undefined, visible: boolean) => {
      if (!group) return;
      if (visible) {
        if (!map!.hasLayer(group)) group.addTo(map!);
      } else if (map!.hasLayer(group)) {
        map!.removeLayer(group);
      }
    };
    toggle(aircraftGroup, state.aircraft);
    toggle(vesselGroup, state.vessels);
    toggle(decodeGroup, state.decodes);
    toggle(positionGroup, state.positions);
    toggle(gridGroup, state.grid);
    toggle(stationGroup, true);
    syncWeatherLayer();
    if (state.grid) refreshGrid();
  }

  function mergeEntities(
    current: DecoderEntity[],
    incoming: DecoderEntity[],
  ): DecoderEntity[] {
    const map = new Map(current.map((row) => [row.key, row]));
    for (const row of incoming) map.set(row.key, row);
    return [...map.values()];
  }

  function mergeDecodes(
    current: Map<number, DecoderHistoryMessage>,
    incoming: DecoderHistoryMessage[],
  ): Map<number, DecoderHistoryMessage> {
    const next = new Map(current);
    for (const row of incoming) next.set(row.id, row);
    while (next.size > 5000) {
      const first = next.keys().next();
      if (first.done) break;
      next.delete(first.value);
    }
    return next;
  }

  function applyCheckpoint(data: MapCheckpoint) {
    setStation(data.station);
    setAircraft(data.aircraft ?? []);
    setVessels(data.vessels ?? []);
    setDecodes(new Map((data.decodes ?? []).map((row) => [row.id, row])));
    setPositions(new Map((data.positions ?? []).map((row) => [row.id, row])));
    setLastAt(data.at);
    if (!initialViewDone && map) {
      const lat = asNumber(data.station?.lat);
      const lon = asNumber(data.station?.lon);
      if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
        map.setView([lat, lon], 9);
        initialViewDone = true;
      } else {
        const points: [number, number][] = [
          ...data.aircraft.map((row) => [asNumber(row.payload.lat), asNumber(row.payload.lon)] as [number | null, number | null]),
          ...data.vessels.map((row) => [asNumber(row.payload.lat), asNumber(row.payload.lon)] as [number | null, number | null]),
        ]
          .filter((p): p is [number, number] => p[0] !== null && p[1] !== null)
          .map((p) => [p[0]!, p[1]!]);
        if (points.length > 0) {
          map.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: 9 });
          initialViewDone = true;
        }
      }
    }
  }

  function applyUpdate(data: MapUpdate) {
    if (data.station) setStation(data.station);
    setAircraft((current) => mergeEntities(current, data.aircraft ?? []));
    setVessels((current) => mergeEntities(current, data.vessels ?? []));
    setDecodes((current) => mergeDecodes(current, data.decodes ?? []));
    setPositions((current) => mergeDecodes(current, data.positions ?? []));
    setLastAt(data.at);
  }

  function connect() {
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    setConnection('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/map`);
    socket = ws;
    ws.onopen = () => setConnection('live');
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as MapCheckpoint | MapUpdate;
        if (data.type === 'checkpoint') applyCheckpoint(data);
        else if (data.type === 'update') applyUpdate(data);
      } catch {
        // ignore malformed map frame
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      socket = null;
      setConnection('offline');
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 2500);
    };
  }

  onMount(() => {
    if (!container) return;
    map = L.map(container, {
      center: [30, 0],
      zoom: 3,
      zoomControl: false,
      worldCopyJump: true,
      attributionControl: true,
      preferCanvas: true,
    });
    map.createPane('weatherPane');
    const weatherPane = map.getPane('weatherPane');
    if (weatherPane) weatherPane.style.zIndex = '350';
    // Grid lines and labels sit above the weather tiles but below shadows and
    // markers, so labels can never cover an aircraft/vessel icon.
    map.createPane('maidenheadPane');
    const maidenheadPane = map.getPane('maidenheadPane');
    if (maidenheadPane) maidenheadPane.style.zIndex = '360';
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

    aircraftGroup = L.layerGroup();
    vesselGroup = L.layerGroup();
    decodeGroup = L.layerGroup();
    positionGroup = L.layerGroup();
    gridGroup = L.layerGroup();
    stationGroup = L.layerGroup().addTo(map);

    applyBaseStyle();
    aircraftGroup.addTo(map);
    vesselGroup.addTo(map);
    decodeGroup.addTo(map);
    positionGroup.addTo(map);
    setMapReady(true);

    map.on('moveend', refreshGrid);
    map.on('zoomend', refreshGrid);
    map.on('moveend', scheduleClouds);
    map.on('zoomend', scheduleClouds);
    resizeObserver = new ResizeObserver(() => map?.invalidateSize());
    resizeObserver.observe(container);
    ageTimer = window.setInterval(() => setAgeTick((tick) => tick + 1), 5000);
    motionTimer = window.setInterval(movePredictedEntities, 250);
    connect();
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (ageTimer !== null) window.clearInterval(ageTimer);
    if (motionTimer !== null) window.clearInterval(motionTimer);
    if (cloudTimer !== null) window.clearTimeout(cloudTimer);
    socket?.close();
    socket = null;
    map?.remove();
    map = undefined;
  });

  createEffect(() => {
    if (!mapReady()) return;
    styleId();
    applyBaseStyle();
  });

  createEffect(() => {
    if (!mapReady()) return;
    layerState();
    applyLayerVisibility();
  });

  createEffect(() => {
    // Touch all data signals so marker sync runs on every checkpoint/update.
    activeAircraft();
    activeVessels();
    gridStations();
    positionStations();
    station();
    if (mapReady()) syncMarkers();
  });

  createEffect(() => {
    // Keep the weather layer in sync with the admin key availability.
    station();
    layerState();
    if (mapReady()) syncWeatherLayer();
  });

  const centerStation = () => {
    const s = station();
    if (!map || !s) return;
    const lat = asNumber(s.lat);
    const lon = asNumber(s.lon);
    if (lat !== null && lon !== null) map.setView([lat, lon], Math.max(map.getZoom(), 9));
  };

  const fitAll = () => {
    if (!map) return;
    const points: [number, number][] = [];
    const s = station();
    if (s) {
      const lat = asNumber(s.lat);
      const lon = asNumber(s.lon);
      if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) points.push([lat, lon]);
    }
    for (const row of activeAircraft()) {
      const lat = asNumber(row.payload.lat);
      const lon = asNumber(row.payload.lon);
      if (lat !== null && lon !== null) points.push([lat, lon]);
    }
    for (const row of activeVessels()) {
      const lat = asNumber(row.payload.lat);
      const lon = asNumber(row.payload.lon);
      if (lat !== null && lon !== null) points.push([lat, lon]);
    }
    for (const row of gridStations()) points.push([row.lat, row.lon]);
    for (const row of positionStations()) points.push([row.lat, row.lon]);
    if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.18), { maxZoom: 10 });
  };

  const layerCounts = () => ({
    aircraft: activeAircraft().length,
    vessels: activeVessels().length,
    decodes: gridStations().length,
    positions: positionStations().length,
  });

  return (
    <div class="fixed inset-0 bg-sdr-base text-text-primary overflow-hidden">
      <div ref={container} class="absolute inset-0 z-0" />

      {/* Top brand bar */}
      <header class="absolute top-0 left-0 right-0 z-[1000] pointer-events-none">
        <div class="flex items-start justify-between gap-3 p-3">
          <div class="pointer-events-auto flex items-center gap-3 px-3 py-2 rounded-md border border-cyan/25 bg-sdr-surface/90 backdrop-blur-md shadow-2xl">
            <button
              class="mil-btn text-[10px] px-2 py-1"
              onClick={() => navigate('/')}
              title="Back to the SDR"
            >
              ← SDR
            </button>
            <div>
              <div class="text-[13px] font-mono font-bold uppercase tracking-[0.18em] text-cyan">
                {station()?.callsign || 'NO-SDR'} <span class="text-text-primary">MAP</span>
              </div>
              <div class="text-[9px] font-mono text-text-dim uppercase tracking-wider">
                {station()?.location || 'Receiver operations map'}
                {station()?.grid ? ` · ${station()!.grid}` : ''}
              </div>
            </div>
          </div>

          <div class="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border/40 bg-sdr-surface/90 backdrop-blur-md shadow-2xl">
            <span class={`h-2 w-2 rounded-full ${connection() === 'live' ? 'bg-green-400 shadow-[0_0_8px_#38c180]' : connection() === 'connecting' ? 'bg-amber animate-pulse' : 'bg-red-400'}`} />
            <span class="text-[9px] font-mono uppercase tracking-wider text-text-dim">
              {connection() === 'live' ? 'Live' : connection() === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
            <span class="text-[9px] font-mono text-text-dim/60">
              {lastAt() ? new Date(lastAt()!).toLocaleTimeString() : '—'}
            </span>
          </div>
        </div>
      </header>

      {/* Layers / style panel */}
      <aside class="absolute top-20 right-3 z-[1000] w-[min(19rem,calc(100vw-1.5rem))] max-h-[calc(100vh-6.5rem)] overflow-auto rounded-md border border-border/40 bg-sdr-surface/92 backdrop-blur-md shadow-2xl">
        <div class="p-3 border-b border-border/30">
          <div class="text-[9px] font-mono uppercase tracking-[0.16em] text-cyan">Layers</div>
          <div class="mt-2 space-y-1">
            <MapLayerRow
              id="aircraft"
              label="Aircraft"
              hint="ADS-B positions"
              count={layerCounts().aircraft}
              colour="#38e8ff"
              checked={layerState().aircraft}
              onChange={(v) => setLayer('aircraft', v)}
            />
            <MapLayerRow
              id="vessels"
              label="Vessels"
              hint="AIS positions"
              count={layerCounts().vessels}
              colour="#7dff9b"
              checked={layerState().vessels}
              onChange={(v) => setLayer('vessels', v)}
            />
            <MapLayerRow
              id="decodes"
              label="Grid decodes"
              hint="FT8 / FT4 / WSPR and other grid-bearing modes"
              count={layerCounts().decodes}
              colour="#ffd24a"
              checked={layerState().decodes}
              onChange={(v) => setLayer('decodes', v)}
            />
            <MapLayerRow
              id="positions"
              label="Position reports"
              hint="APRS / HFDL position fixes"
              count={layerCounts().positions}
              colour="#9d8cff"
              checked={layerState().positions}
              onChange={(v) => setLayer('positions', v)}
            />
            <MapLayerRow
              id="grid"
              label="Maidenhead grid"
              hint="Field / square / subsquare overlay"
              checked={layerState().grid}
              colour="#8f7bd6"
              onChange={(v) => setLayer('grid', v)}
            />
            <MapLayerRow
              id="weather"
              label="Cloud cover"
              hint="Open-Meteo cloud cover (no API key, rendered client-side)"
              checked={layerState().weather}
              colour="#6bb3ff"
              onChange={(v) => setLayer('weather', v)}
            />
          </div>
          <p class="mt-2 text-[8px] font-mono text-text-dim/70 leading-relaxed">
            VDL2/ACARS messages carry no position data and are not plotted.
          </p>
        </div>

        <div class="p-3 space-y-2">
          <div class="text-[9px] font-mono uppercase tracking-[0.16em] text-cyan">Map style</div>
          <select
            class="admin-input w-full text-[11px]"
            value={styleId()}
            onChange={(e) => {
              const next = e.currentTarget.value as StyleId;
              setStyleId(next);
              saveStyle(next);
            }}
          >
            <For each={Object.entries(MAP_STYLES)}>
              {([id, style]) => <option value={id}>{style.label}</option>}
            </For>
          </select>
          <div class="grid grid-cols-2 gap-1 pt-1">
            <button class="mil-btn text-[9px] px-2 py-1" onClick={centerStation} disabled={!station()}>
              Center station
            </button>
            <button class="mil-btn text-[9px] px-2 py-1" onClick={fitAll}>
              Fit all
            </button>
          </div>
        </div>
      </aside>

      {/* Legend / status */}
      <div class="absolute left-3 bottom-3 z-[1000] pointer-events-none">
        <div class="rounded-md border border-border/40 bg-sdr-surface/90 backdrop-blur-md shadow-2xl px-3 py-2">
          <div class="text-[9px] font-mono uppercase tracking-[0.16em] text-text-dim">
            {station()?.callsign || 'NO-SDR'} · {station()?.grid || 'no grid'}
          </div>
          <div class="mt-1 flex items-center gap-3 text-[9px] font-mono">
            <span class="text-cyan">✈ {layerCounts().aircraft}</span>
            <span class="text-green">⛵ {layerCounts().vessels}</span>
            <span class="text-amber">◈ {layerCounts().decodes}</span>
            <span class="text-purple">◎ {layerCounts().positions}</span>
            <span class="text-purple">▦ {layerState().grid ? 'on' : 'off'}</span>
          </div>
        </div>
      </div>

    </div>
  );
};

const MapLayerRow: Component<{
  id: string;
  label: string;
  hint: string;
  count?: number;
  colour: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}> = (props) => (
  <label
    class={`flex items-center gap-2 px-2 py-1.5 rounded-sm border border-border/30 bg-sdr-base/40 ${
      props.disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer hover:bg-sdr-base/70'
    }`}
    title={props.hint}
  >
    <input
      type="checkbox"
      class="accent-cyan"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
    />
    <span class="h-2 w-2 rounded-full shrink-0" style={{ background: props.colour }} />
    <span class="flex-1 min-w-0 text-[10px] font-mono text-text-primary truncate">{props.label}</span>
    <Show when={props.count !== undefined}>
      <span class="text-[9px] font-mono text-text-dim tabular-nums">{props.count}</span>
    </Show>
  </label>
);

export default MapPage;
