// ============================================================
// node-sdr — ADS-B OpenStreetMap view
// ============================================================
// A single Leaflet map created on mount; aircraft markers and track polylines
// are updated in place on every snapshot. The map is never rebuilt, because
// rebuilding it twice a second would throw away the viewport the operator is
// watching.

import { Component, createEffect, onCleanup, onMount } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AdsbAircraft } from '~/shared';

interface AdsbMapProps {
  aircraft: AdsbAircraft[];
  selectedIcao: string | null;
  followSelected: boolean;
  onSelect: (icao: string) => void;
}

const ACCENT = '#38e8ff';
const SELECTED = '#ffd23f';
const GROUND = '#8aa0b8';
const TRACK_COLOUR = 'rgba(56, 232, 255, 0.30)';
const LEADER_COLOUR = 'rgba(255, 210, 63, 0.85)';

export function icaoHex(icao: number): string {
  return (icao & 0xff_ffff).toString(16).toUpperCase().padStart(6, '0');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function label(ac: AdsbAircraft): string {
  const callsign = ac.callsign.trim();
  return callsign || icaoHex(ac.icao);
}

function altitudeText(ac: AdsbAircraft): string {
  if (ac.on_ground) return 'GND';
  const ft = ac.altitude_ft;
  if (ft == null) return '---';
  return ft >= 18_000
    ? `F${String(Math.round(ft / 100)).padStart(3, '0')}`
    : String(Math.round(ft / 100)).padStart(3, '0');
}

/** A small plane glyph pointing north; the container is rotated to the track. */
function planeIcon(ac: AdsbAircraft, selected: boolean): L.DivIcon {
  const colour = selected ? SELECTED : ac.on_ground ? GROUND : ACCENT;
  const rotation = Number.isFinite(ac.track_deg) ? (ac.track_deg as number) : 0;
  const html = `
    <div class="adsb-marker" style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;">
      <svg viewBox="0 0 24 24" width="20" height="20"
           style="transform:rotate(${rotation}deg);transform-origin:50% 50%;filter:drop-shadow(0 0 2px rgba(0,0,0,0.9));">
        <path d="M12 1.8 L14.2 9.4 L22 14.2 L22 16.4 L14 13.8 L14 19.6 L16.8 21.8 L16.8 22.6 L12 20.7 L7.2 22.6 L7.2 21.8 L10 19.6 L10 13.8 L2 16.4 L2 14.2 L9.8 9.4 Z"
              fill="${colour}"/>
      </svg>
    </div>`;
  return L.divIcon({
    className: 'adsb-marker-container',
    html,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function popupHtml(ac: AdsbAircraft): string {
  const rows = [
    ['CALLSIGN', label(ac)],
    ['ICAO', icaoHex(ac.icao)],
    ['ALT', altitudeText(ac)],
    ['GS', ac.ground_speed_kt == null ? '---' : `${Math.round(ac.ground_speed_kt)} kt`],
    ['TRK', ac.track_deg == null ? '---' : `${Math.round(ac.track_deg)}°`],
    ['V/S', ac.vertical_rate_fpm == null ? '---' : `${ac.vertical_rate_fpm > 0 ? '+' : ''}${ac.vertical_rate_fpm} fpm`],
    ['SQK', ac.squawk == null ? '----' : String(ac.squawk).padStart(4, '0')],
    ['TYPE', ac.category ?? '---'],
    ['LAST', `${Math.max(0, Math.round(Date.now() / 1000 - ac.last_at))} s ago`],
  ];
  const emergency = ac.emergency
    ? `<div style="color:#ff6b6b;font-weight:700;margin-bottom:3px;">${escapeHtml(ac.emergency)}</div>`
    : '';
  const body = rows
    .map(
      ([key, value]) =>
        `<tr><td style="color:#8aa0b8;padding-right:8px;">${escapeHtml(key ?? '')}</td>` +
        `<td style="color:#e8f4ff;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<div style="font:10px/1.5 monospace;min-width:150px;">${emergency}<table>${body}</table></div>`;
}

/** One point ahead of the aircraft, one minute of flight at its ground speed. */
function leaderPoint(ac: AdsbAircraft): [number, number] | null {
  if (ac.lat == null || ac.lon == null || ac.track_deg == null) return null;
  const speedKt = ac.ground_speed_kt ?? 0;
  if (speedKt <= 0) return null;
  const distanceNm = speedKt / 60;
  const bearing = (ac.track_deg * Math.PI) / 180;
  const lat = ac.lat + (distanceNm / 60) * Math.cos(bearing);
  const cosLat = Math.max(0.05, Math.cos((ac.lat * Math.PI) / 180));
  const lon = ac.lon + (distanceNm / 60) * (Math.sin(bearing) / cosLat);
  return [lat, lon];
}

const AdsbMap: Component<AdsbMapProps> = (props) => {
  let container: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const markers = new Map<string, L.Marker>();
  const selectedState = new Map<string, boolean>();
  const tracks = new Map<string, L.Polyline>();
  const leaders = new Map<string, L.Polyline>();
  let fittedOnce = false;

  const fitAircraft = () => {
    if (!map) return;
    const bounds = L.latLngBounds(
      props.aircraft
        .filter((ac) => ac.lat != null && ac.lon != null)
        .map((ac) => [ac.lat as number, ac.lon as number] as [number, number]),
    );
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 9, animate: true });
  };

  onMount(() => {
    if (!container) return;
    map = L.map(container, {
      center: [30, 0],
      zoom: 3,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // Keep the map sized when the decoder pane is resized or shown.
    resizeObserver = new ResizeObserver(() => map?.invalidateSize());
    resizeObserver.observe(container);
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    if (map) {
      map.remove();
      map = undefined;
    }
    markers.clear();
    selectedState.clear();
    tracks.clear();
    leaders.clear();
  });

  createEffect(() => {
    // Read the props so Solid re-runs this effect on every snapshot/selection.
    const list = props.aircraft;
    const selected = props.selectedIcao;
    const follow = props.followSelected;
    if (!map) return;

    const present = new Set<string>();
    let selectedLatLng: [number, number] | null = null;

    for (const ac of list) {
      const key = icaoHex(ac.icao);
      present.add(key);
      const hasPosition =
        typeof ac.lat === 'number' &&
        typeof ac.lon === 'number' &&
        Number.isFinite(ac.lat) &&
        Number.isFinite(ac.lon);

      if (!hasPosition) {
        markers.get(key)?.remove();
        markers.delete(key);
        selectedState.delete(key);
        tracks.get(key)?.remove();
        tracks.delete(key);
        leaders.get(key)?.remove();
        leaders.delete(key);
        continue;
      }

      const latlng: [number, number] = [ac.lat as number, ac.lon as number];
      if (key === selected) selectedLatLng = latlng;

      const isSelected = key === selected;
      let marker = markers.get(key);
      if (!marker) {
        marker = L.marker(latlng, {
          icon: planeIcon(ac, isSelected),
          title: label(ac),
          keyboard: false,
        })
          .addTo(map)
          .bindPopup(popupHtml(ac));
        marker.on('click', () => props.onSelect(key));
        markers.set(key, marker);
        selectedState.set(key, isSelected);
      } else {
        marker.setLatLng(latlng);
        if (selectedState.get(key) !== isSelected) {
          marker.setIcon(planeIcon(ac, isSelected));
          selectedState.set(key, isSelected);
        }
        marker.setPopupContent(popupHtml(ac));
      }

      // Rotate the existing glyph rather than rebuilding the icon every tick.
      const svg = marker.getElement()?.querySelector('svg');
      if (svg) {
        const rotation = Number.isFinite(ac.track_deg) ? (ac.track_deg as number) : 0;
        (svg as SVGElement).style.transform = `rotate(${rotation}deg)`;
      }

      const history: [number, number][] = ac.track
        .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map((point) => [point[0], point[1]] as [number, number]);
      history.push(latlng);

      let track = tracks.get(key);
      if (!track) {
        track = L.polyline(history, {
          color: TRACK_COLOUR,
          weight: isSelected ? 2 : 1,
          interactive: false,
        }).addTo(map);
        tracks.set(key, track);
      } else {
        track.setLatLngs(history);
        track.setStyle({ weight: isSelected ? 2 : 1 });
      }

      const leader = isSelected ? leaderPoint(ac) : null;
      if (leader) {
        let line = leaders.get(key);
        if (!line) {
          line = L.polyline([latlng, leader], {
            color: LEADER_COLOUR,
            weight: 1.5,
            dashArray: '4 3',
            interactive: false,
          }).addTo(map);
          leaders.set(key, line);
        } else {
          line.setLatLngs([latlng, leader]);
        }
      } else {
        leaders.get(key)?.remove();
        leaders.delete(key);
      }
    }

    for (const [key, marker] of markers) {
      if (present.has(key)) continue;
      marker.remove();
      markers.delete(key);
      selectedState.delete(key);
    }
    for (const [key, line] of tracks) {
      if (present.has(key)) continue;
      line.remove();
      tracks.delete(key);
    }
    for (const [key, line] of leaders) {
      if (present.has(key)) continue;
      line.remove();
      leaders.delete(key);
    }

    if (!fittedOnce && list.some((ac) => ac.lat != null && ac.lon != null)) {
      fitAircraft();
      fittedOnce = true;
    }

    if (follow && selectedLatLng) {
      map.panTo(selectedLatLng, { animate: true, duration: 0.4 });
    }
  });

  // Selecting a row jumps to that aircraft, even when follow is off.
  let lastSelected: string | null = null;
  createEffect(() => {
    const selected = props.selectedIcao;
    if (!map || selected === lastSelected) return;
    lastSelected = selected;
    if (!selected) return;
    // Read the table so this effect sees the position belonging to the new key.
    const ac = props.aircraft.find((entry) => icaoHex(entry.icao) === selected);
    if (ac?.lat == null || ac.lon == null) return;
    map.setView([ac.lat, ac.lon], Math.max(map.getZoom(), 7), { animate: true });
  });

  return (
    <div class="relative w-full h-full min-h-[180px] bg-[#0b0f16]">
      <div ref={(el) => { container = el; }} class="absolute inset-0" />
      <button
        onClick={fitAircraft}
        class="absolute top-2 right-2 z-[500] mil-btn text-[8px] font-mono uppercase tracking-wider px-2 py-1"
        title="Fit all aircraft with a position"
      >
        Fit
      </button>
    </div>
  );
};

export default AdsbMap;
