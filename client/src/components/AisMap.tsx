// ============================================================
// node-sdr — AIS OpenStreetMap view
// ============================================================
// One Leaflet map, updated in place as the twice-a-second vessel table
// arrives. Nothing is rebuilt between snapshots.

import { Component, createEffect, onCleanup, onMount } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AisVessel } from '~/shared';

interface AisMapProps {
  vessels: AisVessel[];
  selectedMmsi: number | null;
  followSelected: boolean;
  onSelect: (mmsi: number) => void;
}

const ACCENT = '#38e8ff';
const SELECTED = '#ffd23f';
const CLASS_B = '#7dff9b';
const SHORE = '#8aa0b8';
const TRACK_COLOUR = 'rgba(56, 232, 255, 0.28)';
const LEADER_COLOUR = 'rgba(255, 210, 63, 0.85)';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function label(v: AisVessel): string {
  const name = v.name.trim();
  return name || String(v.mmsi);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'ClassB': return 'Class B';
    case 'BaseStation': return 'base station';
    case 'SarAircraft': return 'SAR aircraft';
    case 'AidToNavigation': return 'aid to navigation';
    case 'Sart': return 'SART / MOB';
    case 'Craft': return 'craft';
    default: return 'Class A';
  }
}

function course(v: AisVessel): number {
  return v.heading_deg ?? v.cog_deg ?? 0;
}

function shipIcon(v: AisVessel, selected: boolean): L.DivIcon {
  const colour = selected
    ? SELECTED
    : v.kind === 'ClassB'
      ? CLASS_B
      : v.kind === 'AidToNavigation' || v.kind === 'BaseStation'
        ? SHORE
        : ACCENT;
  const rotation = Number.isFinite(course(v)) ? course(v) : 0;
  const length = v.dim_bow_m + v.dim_stern_m;
  const size = Math.max(14, Math.min(28, 14 + length / 20));
  const html = `
    <div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;">
      <svg viewBox="0 0 24 24" width="${size}" height="${size}"
           style="transform:rotate(${rotation}deg);transform-origin:50% 50%;filter:drop-shadow(0 0 2px rgba(0,0,0,0.9));">
        <path d="M12 2 L19 20 L12 17 L5 20 Z" fill="${colour}"/>
      </svg>
    </div>`;
  return L.divIcon({
    className: 'ais-marker-container',
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(v: AisVessel): string {
  const rows = [
    ['NAME', label(v)],
    ['MMSI', String(v.mmsi)],
    ['TYPE', kindLabel(v.kind)],
    ['CALL', v.call_sign || '---'],
    ['SOG', v.sog_kt == null ? '---' : `${v.sog_kt.toFixed(1)} kt`],
    ['COG', v.cog_deg == null ? '---' : `${Math.round(v.cog_deg)}°`],
    ['HDG', v.heading_deg == null ? '---' : `${Math.round(v.heading_deg)}°`],
    ['DEST', v.destination || '---'],
    ['ETA', v.eta || '---'],
    ['LAST', `${Math.max(0, Math.round(Date.now() / 1000 - v.last_at))} s ago`],
  ];
  const body = rows
    .map(
      ([key, value]) =>
        `<tr><td style="color:#8aa0b8;padding-right:8px;">${escapeHtml(key ?? '')}</td>` +
        `<td style="color:#e8f4ff;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<div style="font:10px/1.5 monospace;min-width:150px;"><table>${body}</table></div>`;
}

/** Six minutes ahead at the current speed over ground. */
function leaderPoint(v: AisVessel): [number, number] | null {
  if (v.lat == null || v.lon == null || v.cog_deg == null) return null;
  const knots = v.sog_kt ?? 0;
  if (knots <= 0) return null;
  const distanceNm = (knots * 6) / 60;
  const bearing = (v.cog_deg * Math.PI) / 180;
  const lat = v.lat + (distanceNm / 60) * Math.cos(bearing);
  const cosLat = Math.max(0.05, Math.cos((v.lat * Math.PI) / 180));
  const lon = v.lon + (distanceNm / 60) * (Math.sin(bearing) / cosLat);
  return [lat, lon];
}

const AisMap: Component<AisMapProps> = (props) => {
  let container: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const markers = new Map<string, L.Marker>();
  const selectedState = new Map<string, boolean>();
  const tracks = new Map<string, L.Polyline>();
  const leaders = new Map<string, L.Polyline>();
  let fittedOnce = false;

  const fitVessels = () => {
    if (!map) return;
    const bounds = L.latLngBounds(
      props.vessels
        .filter((v) => v.lat != null && v.lon != null)
        .map((v) => [v.lat as number, v.lon as number] as [number, number]),
    );
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 12, animate: true });
  };

  onMount(() => {
    if (!container) return;
    map = L.map(container, {
      center: [37.9, 23.7],
      zoom: 9,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
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
    const list = props.vessels;
    const selected = props.selectedMmsi;
    const follow = props.followSelected;
    if (!map) return;

    const present = new Set<string>();
    let selectedLatLng: [number, number] | null = null;

    for (const vessel of list) {
      const key = String(vessel.mmsi);
      present.add(key);
      const hasPosition =
        typeof vessel.lat === 'number' &&
        typeof vessel.lon === 'number' &&
        Number.isFinite(vessel.lat) &&
        Number.isFinite(vessel.lon);

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

      const latlng: [number, number] = [vessel.lat as number, vessel.lon as number];
      const isSelected = vessel.mmsi === selected;
      if (isSelected) selectedLatLng = latlng;

      let marker = markers.get(key);
      if (!marker) {
        marker = L.marker(latlng, {
          icon: shipIcon(vessel, isSelected),
          title: label(vessel),
          keyboard: false,
        })
          .addTo(map)
          .bindPopup(popupHtml(vessel));
        marker.on('click', () => props.onSelect(vessel.mmsi));
        markers.set(key, marker);
        selectedState.set(key, isSelected);
      } else {
        marker.setLatLng(latlng);
        if (selectedState.get(key) !== isSelected) {
          marker.setIcon(shipIcon(vessel, isSelected));
          selectedState.set(key, isSelected);
        }
        marker.setPopupContent(popupHtml(vessel));
      }

      const svg = marker.getElement()?.querySelector('svg');
      if (svg) {
        const rotation = Number.isFinite(course(vessel)) ? course(vessel) : 0;
        (svg as SVGElement).style.transform = `rotate(${rotation}deg)`;
      }

      const history: [number, number][] = vessel.track
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

      const leader = isSelected ? leaderPoint(vessel) : null;
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

    if (!fittedOnce && list.some((v) => v.lat != null && v.lon != null)) {
      fitVessels();
      fittedOnce = true;
    }
    if (follow && selectedLatLng) {
      map.panTo(selectedLatLng, { animate: true, duration: 0.4 });
    }
  });

  let lastSelected: number | null = null;
  createEffect(() => {
    const selected = props.selectedMmsi;
    if (!map || selected === lastSelected) return;
    lastSelected = selected;
    if (selected == null) return;
    const vessel = props.vessels.find((v) => v.mmsi === selected);
    if (vessel?.lat == null || vessel.lon == null) return;
    map.setView([vessel.lat, vessel.lon], Math.max(map.getZoom(), 11), { animate: true });
  });

  return (
    <div class="relative w-full h-full min-h-[180px] bg-[#0b0f16]">
      <div ref={(el) => { container = el; }} class="absolute inset-0" />
      <button
        onClick={fitVessels}
        class="absolute top-2 right-2 z-[500] mil-btn text-[8px] font-mono uppercase tracking-wider px-2 py-1"
        title="Fit all vessels with a position"
      >
        Fit
      </button>
    </div>
  );
};

export default AisMap;
