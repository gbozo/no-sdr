// ============================================================
// node-sdr — /map operations map
// ============================================================
// Full-screen OpenStreetMap view fed by its own /ws/map socket. The main
// audio/FFT WebSocket is never used here.

import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { inflateSync } from 'fflate';
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
  weather: { enabled: boolean; provider: string; layer: string; apiKey: string };
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

interface MapAirport {
  ident: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  municipality: string;
  isoCountry: string;
  iata: string;
  icao: string;
  scheduledService: boolean;
  homeLink: string;
}

interface MapNavaid {
  ident: string;
  name: string;
  kind: string;
  frequencyKhz: number | null;
  lat: number;
  lon: number;
  elevationFt: number | null;
  isoCountry: string;
  usage: string;
  associatedAirport: string;
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

type LayerId =
  | 'aircraft'
  | 'vessels'
  | 'decodes'
  | 'positions'
  | 'airports'
  | 'navaids'
  | 'grid'
  | 'seamarks'
  | 'weather';
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
  airports: false,
  navaids: false,
  grid: false,
  seamarks: false,
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

function titleCaseKind(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function airportPopup(airport: MapAirport): string {
  const links: Array<[string, string]> = [
    ['OurAirports', `https://ourairports.com/airports/${encodeURIComponent(airport.ident)}/`],
  ];
  if (airport.homeLink) links.push(['Website', airport.homeLink]);
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(airport.name || airport.ident)} <span class="map-popup-badge">${escapeHtml(airport.icao || airport.ident)}</span></div>
    <div class="map-popup-sub">${escapeHtml(titleCaseKind(airport.kind))}</div>
    ${popupRows([
      ['IDENT', airport.ident],
      ['ICAO', airport.icao || '—'],
      ['IATA', airport.iata || '—'],
      ['ELEV', airport.elevationFt == null ? '—' : `${airport.elevationFt} ft`],
      ['CITY', airport.municipality || '—'],
      ['COUNTRY', airport.isoCountry || '—'],
      ['SCHED', airport.scheduledService ? 'yes' : 'no'],
    ])}
    ${externalLinks(links)}
  </div>`;
}

function navaidPopup(navaid: MapNavaid): string {
  const frequency =
    navaid.frequencyKhz == null
      ? '—'
      : navaid.kind.toUpperCase().startsWith('NDB')
        ? `${navaid.frequencyKhz} kHz`
        : `${(navaid.frequencyKhz / 1000).toFixed(3)} MHz`;
  return `<div class="map-popup">
    <div class="map-popup-title">${escapeHtml(navaid.ident)} <span class="map-popup-badge">${escapeHtml(navaid.kind.toUpperCase())}</span></div>
    <div class="map-popup-sub">${escapeHtml(navaid.name || 'Navaid')}</div>
    ${popupRows([
      ['TYPE', titleCaseKind(navaid.kind)],
      ['FREQ', frequency],
      ['ELEV', navaid.elevationFt == null ? '—' : `${navaid.elevationFt} ft`],
      ['COUNTRY', navaid.isoCountry || '—'],
      ['USAGE', navaid.usage || '—'],
      ['AIRPORT', navaid.associatedAirport || '—'],
    ])}
  </div>`;
}

function airportColour(kind: string): string {
  if (kind === 'large_airport') return '#4aa3ff';
  if (kind === 'medium_airport') return '#7dff9b';
  if (kind === 'small_airport') return '#ffd24a';
  if (kind === 'heliport') return '#ff9f6b';
  return '#9fb0c7';
}

function navaidColour(kind: string): string {
  const upper = kind.toUpperCase();
  if (upper === 'VORTAC') return '#9d8cff';
  if (upper.startsWith('VOR')) return '#4fb8e8';
  if (upper === 'TACAN') return '#7dff9b';
  if (upper.startsWith('NDB')) return '#ff9f6b';
  return '#d6a85e';
}

function airportIcon(airport: MapAirport): L.DivIcon {
  const colour = airportColour(airport.kind);
  const size = airport.kind === 'large_airport' ? 24 : airport.kind === 'medium_airport' ? 20 : 17;
  const heliport = airport.kind === 'heliport';
  const body = heliport
    ? `<circle cx="16" cy="16" r="12" fill="${colour}" stroke="#05070b" stroke-width="2"/>
       <text x="16" y="21" text-anchor="middle" font-family="ui-monospace,monospace" font-size="13" font-weight="800" fill="#05070b">H</text>`
    : `<circle cx="16" cy="16" r="12" fill="${colour}" stroke="#05070b" stroke-width="2"/>
       <circle cx="16" cy="16" r="9.5" fill="none" stroke="${colour}" stroke-opacity=".55" stroke-width="1"/>
       <path d="M11 21 21 11M11 12 20 21" stroke="#05070b" stroke-width="3.4" stroke-linecap="round"/>
       <path d="M11 21 21 11M11 12 20 21" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>`;
  return L.divIcon({
    className: 'map-airport-marker',
    html: `<div class="map-airport-glyph"><svg viewBox="0 0 32 32" width="${size}" height="${size}">${body}</svg></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function navaidIcon(navaid: MapNavaid): L.DivIcon {
  const colour = navaidColour(navaid.kind);
  const kind = navaid.kind.toUpperCase();
  let body: string;
  if (kind === 'VORTAC') {
    body = `<path d="M16 3.5 27 9.8v12.4L16 28.5 5 22.2V9.8Z" fill="#07121d" stroke="#05070b" stroke-width="2"/>
      <path d="M16 5.3 25.3 10.6v10.8L16 26.7 6.7 21.4V10.6Z" fill="${colour}" fill-opacity=".22" stroke="${colour}" stroke-width="1.3"/>
      <rect x="12.5" y="12.5" width="7" height="7" rx="1" fill="${colour}" stroke="#05070b" stroke-width="1.5"/>`;
  } else if (kind.startsWith('VOR')) {
    body = `<path d="M16 3.5 27 9.8v12.4L16 28.5 5 22.2V9.8Z" fill="#07121d" stroke="#05070b" stroke-width="2"/>
      <path d="M16 5.3 25.3 10.6v10.8L16 26.7 6.7 21.4V10.6Z" fill="${colour}" fill-opacity=".22" stroke="${colour}" stroke-width="1.3"/>
      <circle cx="16" cy="16" r="3.4" fill="${colour}" stroke="#05070b" stroke-width="1.5"/>`;
  } else if (kind === 'TACAN') {
    body = `<path d="M16 4 28 16 16 28 4 16Z" fill="#07121d" stroke="#05070b" stroke-width="2"/>
      <path d="M16 6.3 25.7 16 16 25.7 6.3 16Z" fill="${colour}" fill-opacity=".22" stroke="${colour}" stroke-width="1.3"/>
      <path d="M11.5 11.5 20.5 20.5M20.5 11.5 11.5 20.5" stroke="${colour}" stroke-width="1.8" stroke-linecap="round"/>`;
  } else if (kind.startsWith('NDB')) {
    body = `<circle cx="16" cy="16" r="12" fill="#07121d" stroke="#05070b" stroke-width="2"/>
      <circle cx="16" cy="16" r="3.2" fill="${colour}" stroke="#05070b" stroke-width="1.4"/>
      <path d="M9.5 9.5a9.2 9.2 0 000 13M22.5 9.5a9.2 9.2 0 010 13" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round"/>`;
  } else {
    body = `<path d="M16 4 28 16 16 28 4 16Z" fill="#07121d" stroke="#05070b" stroke-width="2"/>
      <path d="M16 7 25 16 16 25 7 16Z" fill="${colour}" fill-opacity=".22" stroke="${colour}" stroke-width="1.3"/>
      <circle cx="16" cy="16" r="2.6" fill="${colour}"/>`;
  }
  const size = 18;
  return L.divIcon({
    className: 'map-navaid-marker',
    html: `<div class="map-navaid-glyph"><svg viewBox="0 0 32 32" width="${size}" height="${size}">${body}</svg></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
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

/** Deep blue at sea level, neon green at 12,000 ft, neon yellow at 30,000 ft. */
function altitudeTrailColor(altitudeFt: number): string {
  const stops = [
    { altitude: 0, rgb: [12, 64, 255] },
    { altitude: 12_000, rgb: [57, 255, 20] },
    { altitude: 30_000, rgb: [248, 255, 0] },
  ];
  const altitude = Math.max(0, altitudeFt);
  if (altitude >= stops[stops.length - 1].altitude) {
    const [r, g, b] = stops[stops.length - 1].rgb;
    return `rgb(${r},${g},${b})`;
  }
  const index = altitude >= stops[1].altitude ? 1 : 0;
  const from = stops[index];
  const to = stops[index + 1];
  const t = (altitude - from.altitude) / (to.altitude - from.altitude);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(from.rgb[0], to.rgb[0])},${mix(from.rgb[1], to.rgb[1])},${mix(from.rgb[2], to.rgb[2])})`;
}

function trailPointKey(point: [number, number]): string {
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

interface TrailPoint {
  lat: number;
  lon: number;
  altitudeFt: number | null;
  key: string;
}

interface TrailCache {
  points: Map<string, TrailPoint[]>;
  cursors: Map<string, string>;
}

const TRAIL_LINE_TOLERANCE = 0.02;
const TRAIL_ALTITUDE_TOLERANCE_FT = 500;
const TRAIL_POINT_LIMIT = 240;

function trailPointOffLine(b: TrailPoint, a: TrailPoint, c: TrailPoint): boolean {
  const scale = Math.cos((((b.lat + a.lat) / 2) * Math.PI) / 180);
  const bx = b.lon * scale;
  const ax = a.lon * scale;
  const cx = c.lon * scale;
  const base = Math.hypot(ax - bx, a.lat - b.lat);
  if (base < 1e-9) return false;
  // Only a point ahead of A counts as a simplification. A point behind A or
  // between B and A is a direction change and must be kept.
  const projection =
    ((ax - bx) * (cx - bx) + (a.lat - b.lat) * (c.lat - b.lat)) / (base * base);
  if (projection <= 1) return false;
  const perpendicular =
    Math.abs((ax - bx) * (c.lat - b.lat) - (a.lat - b.lat) * (cx - bx)) / base;
  return perpendicular <= base * TRAIL_LINE_TOLERANCE;
}

function parseServerTrajectory(value: unknown): TrailPoint[] | null {
  if (!Array.isArray(value)) return null;
  const points: TrailPoint[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const lat = asNumber(row[0]);
    const lon = asNumber(row[1]);
    if (lat === null || lon === null) continue;
    points.push({
      lat,
      lon,
      altitudeFt: asNumber(row[2]),
      key: trailPointKey([lat, lon]),
    });
  }
  return points.length > 0 ? points : null;
}

function simplifyTrail(
  cache: TrailCache,
  entityKey: string,
  track: [number, number][],
  altitudeFt: number | null,
): TrailPoint[] {
  let points = cache.points.get(entityKey);
  if (!points) {
    points = [];
    cache.points.set(entityKey, points);
  }
  let start = 0;
  const cursor = cache.cursors.get(entityKey);
  if (cursor) {
    const index = track.findIndex((point) => trailPointKey(point) === cursor);
    if (index >= 0) {
      start = index + 1;
    } else {
      // The server's capped history rolled past our cursor; rebuild.
      points.length = 0;
    }
  }

  for (let index = start; index < track.length; index++) {
    const point = track[index];
    const key = trailPointKey(point);
    if (points[points.length - 1]?.key === key) {
      cache.cursors.set(entityKey, key);
      continue;
    }
    const next: TrailPoint = {
      lat: point[0],
      lon: point[1],
      altitudeFt,
      key,
    };
    if (points.length >= 2) {
      const previous = points[points.length - 2];
      const latest = points[points.length - 1];
      const altitudeChange = Math.abs(
        (next.altitudeFt ?? 0) - (latest.altitudeFt ?? 0),
      );
      if (
        altitudeChange <= TRAIL_ALTITUDE_TOLERANCE_FT &&
        trailPointOffLine(previous, latest, next)
      ) {
        points[points.length - 1] = next;
        cache.cursors.set(entityKey, key);
        continue;
      }
    }
    points.push(next);
    cache.cursors.set(entityKey, key);
  }

  if (points.length > TRAIL_POINT_LIMIT) {
    points.splice(0, points.length - TRAIL_POINT_LIMIT);
  }
  return points;
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
  let seamarkLayer: L.TileLayer | undefined;
  let weatherLayer: L.TileLayer | undefined;
  let weatherLayerKey = '';
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
  const [layersCollapsed, setLayersCollapsed] = createSignal(false);
  const [styleId, setStyleId] = createSignal<StyleId>(readStyle());
  const [airportRows, setAirportRows] = createSignal<MapAirport[]>([]);
  const [navaidRows, setNavaidRows] = createSignal<MapNavaid[]>([]);

  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let ageTimer: number | null = null;
  let motionTimer: number | null = null;
  let aviationTimer: number | null = null;
  let airportRetryTimer: number | null = null;
  let navaidRetryTimer: number | null = null;
  let airportFetchToken = 0;
  let navaidFetchToken = 0;
  let initialViewDone = false;

  let aircraftGroup: L.LayerGroup | undefined;
  let vesselGroup: L.LayerGroup | undefined;
  let decodeGroup: L.LayerGroup | undefined;
  let positionGroup: L.LayerGroup | undefined;
  let airportGroup: L.LayerGroup | undefined;
  let navaidGroup: L.LayerGroup | undefined;
  let gridGroup: L.LayerGroup | undefined;
  let stationGroup: L.LayerGroup | undefined;
  let stationMarker: L.Marker | undefined;

  const aircraftMarkers = new Map<string, L.Marker>();
  const aircraftStale = new Map<string, boolean>();
  const aircraftRows = new Map<string, DecoderEntity>();
  const aircraftSamples = new Map<string, MetricSample[]>();
  const aircraftLeaders = new Map<string, L.Polyline>();
  const aircraftShadows = new Map<string, L.Marker>();
  const vesselMarkers = new Map<string, L.Marker>();
  const vesselStale = new Map<string, boolean>();
  const vesselRows = new Map<string, DecoderEntity>();
  const vesselSamples = new Map<string, MetricSample[]>();
  const vesselLeaders = new Map<string, L.Polyline>();
  const vesselShadows = new Map<string, L.Marker>();
  const gridMarkers = new Map<string, L.Marker>();
  const positionMarkers = new Map<number, L.Marker>();
  const aircraftTrails = new Map<string, L.LayerGroup>();
  const aircraftTrailCache: TrailCache = { points: new Map(), cursors: new Map() };
  const vesselTrails = new Map<string, L.LayerGroup>();
  const vesselTrailCache: TrailCache = { points: new Map(), cursors: new Map() };

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

  function renderAirports(rows: MapAirport[]) {
    airportGroup?.clearLayers();
    for (const airport of rows) {
      L.marker([airport.lat, airport.lon], {
        icon: airportIcon(airport),
        keyboard: false,
      })
        .bindPopup(airportPopup(airport), { className: 'sdr-map-popup', maxWidth: 340 })
        .bindTooltip(`${airport.ident} · ${airport.name}`, {
          direction: 'top',
          offset: [0, -7],
        })
        .addTo(airportGroup!);
    }
  }

  function renderNavaids(rows: MapNavaid[]) {
    navaidGroup?.clearLayers();
    for (const navaid of rows) {
      L.marker([navaid.lat, navaid.lon], {
        icon: navaidIcon(navaid),
        keyboard: false,
      })
        .bindPopup(navaidPopup(navaid), { className: 'sdr-map-popup', maxWidth: 330 })
        .bindTooltip(`${navaid.ident} · ${navaid.kind}`, {
          direction: 'top',
          offset: [0, -7],
        })
        .addTo(navaidGroup!);
    }
  }

  function scheduleAviationRetry(kind: 'airports' | 'navaids') {
    const existing = kind === 'airports' ? airportRetryTimer : navaidRetryTimer;
    if (existing !== null) return;
    const timer = window.setTimeout(() => {
      if (kind === 'airports') airportRetryTimer = null;
      else navaidRetryTimer = null;
      if (
        (kind === 'airports' && layerState().airports) ||
        (kind === 'navaids' && layerState().navaids)
      ) {
        void fetchAviation(kind);
      }
    }, 5_000);
    if (kind === 'airports') airportRetryTimer = timer;
    else navaidRetryTimer = timer;
  }

  async function fetchAviation(kind: 'airports' | 'navaids') {
    if (!map) return;
    if (kind === 'airports' && !layerState().airports) return;
    if (kind === 'navaids' && !layerState().navaids) return;
    const bounds = map.getBounds();
    const params = new URLSearchParams({
      kind,
      minLat: String(bounds.getSouth()),
      maxLat: String(bounds.getNorth()),
      minLon: String(bounds.getWest()),
      maxLon: String(bounds.getEast()),
      zoom: String(Math.round(map.getZoom())),
    });
    const token = kind === 'airports' ? ++airportFetchToken : ++navaidFetchToken;
    try {
      const response = await fetch(`/api/map/aviation?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as {
        ready: boolean;
        items: Array<MapAirport | MapNavaid>;
      };
      if (kind === 'airports' ? token !== airportFetchToken : token !== navaidFetchToken) return;
      if (!payload.ready) {
        scheduleAviationRetry(kind);
        return;
      }
      if (kind === 'airports') {
        const rows = payload.items as MapAirport[];
        setAirportRows(rows);
        renderAirports(rows);
      } else {
        const rows = payload.items as MapNavaid[];
        setNavaidRows(rows);
        renderNavaids(rows);
      }
    } catch (error) {
      console.warn(`aviation ${kind} fetch failed`, error);
    }
  }

  function scheduleAviationRefresh() {
    if (aviationTimer !== null) window.clearTimeout(aviationTimer);
    aviationTimer = window.setTimeout(() => {
      aviationTimer = null;
      if (layerState().airports) void fetchAviation('airports');
      if (layerState().navaids) void fetchAviation('navaids');
    }, 300);
  }

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

  function syncSeamarkLayer() {
    if (!map) return;
    if (layerState().seamarks && !seamarkLayer) {
      seamarkLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        attribution:
          'Seamarks &copy; <a href="https://www.openseamap.org/" target="_blank" rel="noopener">OpenSeaMap</a> contributors',
        maxZoom: 19,
        maxNativeZoom: 18,
        pane: 'seamarkPane',
      }).addTo(map);
    } else if (!layerState().seamarks && seamarkLayer) {
      map.removeLayer(seamarkLayer);
      seamarkLayer = undefined;
    }
  }

  function syncWeatherLayer() {
    if (!map) return;
    const weather = station()?.weather;
    const apiKey = weather?.apiKey?.trim() ?? '';
    const shouldShow = layerState().weather && !!weather?.enabled && apiKey !== '';
    if (shouldShow) {
      const layer = weather?.layer || 'clouds_new';
      const key = `${layer}:${apiKey}`;
      const url =
        `https://tile.openweathermap.org/map/${encodeURIComponent(layer)}/{z}/{x}/{y}.png` +
        `?appid=${encodeURIComponent(apiKey)}`;
      if (!weatherLayer) {
        weatherLayer = L.tileLayer(url, {
          opacity: 0.65,
          maxZoom: 19,
          pane: 'weatherPane',
          attribution: 'Clouds &copy; OpenWeatherMap',
        }).addTo(map);
        weatherLayerKey = key;
      } else if (weatherLayerKey !== key) {
        weatherLayer.setUrl(url);
        weatherLayerKey = key;
      }
    } else if (weatherLayer) {
      map.removeLayer(weatherLayer);
      weatherLayer = undefined;
      weatherLayerKey = '';
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
      trailCache: TrailCache | undefined,
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
        const altitudeAware = row.kind === 'aircraft';
        const serverTrajectory = parseServerTrajectory(row.payload.trajectory);
        const simplified =
          serverTrajectory ??
          (trailCache
            ? simplifyTrail(trailCache, row.key, track, altitudeAware ? entityAltitude(row) : null)
            : []);
        const trailTrack: [number, number][] = simplified.map((point) => [point.lat, point.lon]);
        const trailAltitudes: Array<number | null> = simplified.map((point) => point.altitudeFt);
        if (simplified.length > 0) {
          let trailGroup = trails.get(row.key);
          if (!trailGroup) {
            trailGroup = L.layerGroup().addTo(group);
            trails.set(row.key, trailGroup);
          }
          trailGroup.clearLayers();

          if (trailTrack.length >= 2) {
            // One thin dark casing, then a segmented path so it reads like a
            // Flightradar-style history rather than a single line.
            L.polyline(trailTrack, {
              color: '#151515',
              weight: 4.4,
              opacity: stale ? 0.12 : 0.4,
              interactive: false,
            }).addTo(trailGroup);

            if (altitudeAware) {
              for (let index = 1; index < trailTrack.length; index++) {
                const from = trailTrack[index - 1];
                const to = trailTrack[index];
                const altitude =
                  ((trailAltitudes[index - 1] ?? 0) + (trailAltitudes[index] ?? 0)) / 2;
                L.polyline([from, to], {
                  color: stale ? '#555555' : altitudeTrailColor(altitude),
                  weight: 3.2,
                  opacity: stale ? 0.2 : 0.72,
                  interactive: false,
                }).addTo(trailGroup);
              }
            } else {
              const bands = Math.min(12, Math.max(1, trailTrack.length - 1));
              for (let band = 0; band < bands; band++) {
                const start = Math.floor((band * (trailTrack.length - 1)) / bands);
                const end = Math.ceil(((band + 1) * (trailTrack.length - 1)) / bands);
                const slice = trailTrack.slice(start, end + 1);
                if (slice.length < 2) continue;
                const colour = stale ? '#555555' : trailColor((band + 0.5) / bands);
                L.polyline(slice, {
                  color: colour,
                  weight: 3.2,
                  opacity: stale ? 0.2 : 0.72,
                  interactive: false,
                }).addTo(trailGroup);
              }
            }
          }

          const latest = simplified[simplified.length - 1];
          const latestAltitude = latest.altitudeFt ?? (altitudeAware ? entityAltitude(row) : null);
          const latestPoint: [number, number] = [latest.lat, latest.lon];
          const latestColour = altitudeAware
            ? altitudeTrailColor(latestAltitude ?? 0)
            : '#b7ffc9';
          L.circleMarker(latestPoint, {
            radius: 2.4,
            color: '#05070b',
            weight: 1,
            fillColor: stale ? '#555555' : latestColour,
            fillOpacity: stale ? 0.3 : 0.95,
            interactive: false,
          }).addTo(trailGroup);

          if (
            Math.abs(latestPoint[0] - position[0]) > 1e-7 ||
            Math.abs(latestPoint[1] - position[1]) > 1e-7
          ) {
            // Keep the accepted trail fixed and show the dead-reckoned part as
            // a separate prediction instead of moving the whole history line.
            const predictedColour = stale
              ? '#555555'
              : altitudeAware
                ? altitudeTrailColor(entityAltitude(row))
                : '#39ff14';
            L.polyline([latestPoint, position], {
              color: predictedColour,
              weight: 2.2,
              opacity: stale ? 0.18 : 0.55,
              dashArray: '3 4',
              interactive: false,
            }).addTo(trailGroup);
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
          trailCache?.points.delete(key);
          trailCache?.cursors.delete(key);
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
      aircraftTrailCache,
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
      vesselTrailCache,
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
    toggle(airportGroup, state.airports);
    toggle(navaidGroup, state.navaids);
    toggle(gridGroup, state.grid);
    toggle(stationGroup, true);
    syncSeamarkLayer();
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
    // On a reconnect, tell the server where we got to so it sends one delta
    // instead of the whole checkpoint again. The signals survive the socket,
    // so the aircraft/vessel/decode maps are still populated.
    const since = lastAt() ?? 0;
    const resume = since > 0 ? `?since=${Math.round(since)}` : '';
    const ws = new WebSocket(`${proto}//${location.host}/ws/map${resume}`);
    socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setConnection('live');
    ws.onmessage = (event) => {
      try {
        // The server deflates large checkpoints/updates into binary frames:
        // [0x01][raw DEFLATE of UTF-8 JSON]. Small frames stay plain text.
        let text: string;
        if (typeof event.data === 'string') {
          text = event.data;
        } else {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          if (bytes[0] !== 0x01) return;
          text = new TextDecoder().decode(inflateSync(bytes.subarray(1)));
        }
        const data = JSON.parse(text) as MapCheckpoint | MapUpdate;
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
    // Nautical marks sit above the base map but below weather and grid labels.
    map.createPane('seamarkPane');
    const seamarkPane = map.getPane('seamarkPane');
    if (seamarkPane) seamarkPane.style.zIndex = '250';
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
    airportGroup = L.layerGroup();
    navaidGroup = L.layerGroup();
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
    map.on('moveend', scheduleAviationRefresh);
    map.on('zoomend', scheduleAviationRefresh);
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
    if (aviationTimer !== null) window.clearTimeout(aviationTimer);
    if (airportRetryTimer !== null) window.clearTimeout(airportRetryTimer);
    if (navaidRetryTimer !== null) window.clearTimeout(navaidRetryTimer);
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
    if (!mapReady()) return;
    layerState();
    scheduleAviationRefresh();
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
            <span
              class={`h-2 w-2 rounded-full ${
                connection() === 'live'
                  ? 'bg-green shadow-[0_0_10px_#38c180]'
                  : connection() === 'connecting'
                    ? 'bg-amber animate-pulse'
                    : 'bg-red'
              }`}
            />
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
      <aside
        class={`absolute top-20 right-3 z-[1000] rounded-md border border-border/40 bg-sdr-surface/92 backdrop-blur-md shadow-2xl ${
          layersCollapsed()
            ? ''
            : 'w-[min(19rem,calc(100vw-1.5rem))] max-h-[calc(100vh-6.5rem)] overflow-auto'
        }`}
      >
        <Show
          when={!layersCollapsed()}
          fallback={
            <button
              type="button"
              class="flex h-10 w-10 items-center justify-center rounded-md text-cyan transition-colors hover:bg-cyan/10"
              onClick={() => setLayersCollapsed(false)}
              title="Show layers"
              aria-label="Show layers"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m12 3 9 5-9 5-9-5 9-5Z" />
                <path d="m3 12 9 5 9-5" />
                <path d="m3 16 9 5 9-5" />
              </svg>
            </button>
          }
        >
          <div class="p-3 border-b border-border/30">
            <div class="flex items-center justify-between gap-2">
              <div class="text-[9px] font-mono uppercase tracking-[0.16em] text-cyan">Layers</div>
              <button
                type="button"
                class="flex h-5 w-5 items-center justify-center rounded-sm border border-border/50 text-text-dim transition-colors hover:border-cyan/50 hover:text-cyan"
                onClick={() => setLayersCollapsed(true)}
                title="Minimize layers"
                aria-label="Minimize layers"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14" />
                </svg>
              </button>
            </div>
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
            <div class="pt-2 pb-0.5 text-[8px] font-mono uppercase tracking-wider text-text-dim/60">
              Aviation
            </div>
            <MapLayerRow
              id="airports"
              label="Airports"
              hint="OurAirports public-domain airport data"
              count={airportRows().length}
              colour="#4aa3ff"
              checked={layerState().airports}
              onChange={(v) => setLayer('airports', v)}
            />
            <MapLayerRow
              id="navaids"
              label="Navaids"
              hint="VOR, VORTAC, TACAN, NDB and DME stations"
              count={navaidRows().length}
              colour="#9d8cff"
              checked={layerState().navaids}
              onChange={(v) => setLayer('navaids', v)}
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
              id="seamarks"
              label="OpenSeaMap"
              hint="Seamarks, buoys, lights, and nautical symbols"
              checked={layerState().seamarks}
              colour="#4fb8e8"
              onChange={(v) => setLayer('seamarks', v)}
            />
            <MapLayerRow
              id="weather"
              label="Cloud cover"
              hint={
                station()?.weather.enabled
                  ? 'OpenWeatherMap cloud tiles (fetched by your browser)'
                  : 'Add an OpenWeatherMap key in Admin → General'
              }
              checked={layerState().weather}
              colour="#6bb3ff"
              disabled={!station()?.weather.enabled}
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
        </Show>
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
            <span class="text-cyan/70">⚓ {layerState().seamarks ? 'on' : 'off'}</span>
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
