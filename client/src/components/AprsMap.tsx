// ============================================================
// node-sdr — APRS OpenStreetMap view
// ============================================================
// One marker per station, moved in place as packets arrive. Tracks are built
// from the packet history already held by the store, newest first.

import { Component, createEffect, onCleanup, onMount } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AprsPacket } from '~/shared';

interface AprsMapProps {
  packets: AprsPacket[];
  selectedFrom: string | null;
  followSelected: boolean;
  onSelect: (from: string) => void;
}

const ACCENT = '#38e8ff';
const SELECTED = '#ffd23f';
const TRACK_COLOUR = 'rgba(56, 232, 255, 0.30)';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasPosition(packet: AprsPacket): boolean {
  return (
    typeof packet.lat === 'number' &&
    typeof packet.lon === 'number' &&
    Number.isFinite(packet.lat) &&
    Number.isFinite(packet.lon)
  );
}

function markerIcon(packet: AprsPacket, selected: boolean): L.DivIcon {
  const colour = selected ? SELECTED : ACCENT;
  const label = escapeHtml(packet.from.slice(0, 10));
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 0 2px rgba(0,0,0,.9));">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="5" fill="${colour}" stroke="#061018" stroke-width="1"/>
      </svg>
      <span style="font:8px monospace;color:${colour};background:rgba(5,7,11,.75);padding:0 2px;white-space:nowrap;">${label}</span>
    </div>`;
  return L.divIcon({
    className: 'aprs-marker-container',
    html,
    iconSize: [48, 24],
    iconAnchor: [24, 7],
  });
}

function popupHtml(packet: AprsPacket): string {
  const rows: [string, string][] = [
    ['FROM', packet.from],
    ['TO', packet.to],
    ['KIND', packet.kind],
    ['POS', `${packet.lat?.toFixed(5)}, ${packet.lon?.toFixed(5)}`],
    ['COMMENT', packet.comment || packet.raw],
    ['VIA', packet.via.length ? packet.via.join(', ') : 'direct'],
  ];
  const body = rows
    .map(
      ([key, value]) =>
        `<tr><td style="color:#8aa0b8;padding-right:8px;">${key}</td>` +
        `<td style="color:#e8f4ff;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<div style="font:10px/1.5 monospace;min-width:170px;"><table>${body}</table></div>`;
}

const AprsMap: Component<AprsMapProps> = (props) => {
  let container: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let resizeObserver: ResizeObserver | undefined;
  const markers = new Map<string, L.Marker>();
  const selectedState = new Map<string, boolean>();
  const tracks = new Map<string, L.Polyline>();
  let fittedOnce = false;

  const positions = () => {
    const latest = new Map<string, AprsPacket>();
    for (const packet of props.packets) {
      if (!hasPosition(packet)) continue;
      if (!latest.has(packet.from)) latest.set(packet.from, packet);
    }
    return latest;
  };

  onMount(() => {
    if (!container) return;
    map = L.map(container, {
      center: [37.9, 23.7],
      zoom: 6,
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
    if (map) {
      map.remove();
      map = undefined;
    }
    markers.clear();
    selectedState.clear();
    tracks.clear();
  });

  createEffect(() => {
    const latest = positions();
    const selected = props.selectedFrom;
    const follow = props.followSelected;
    if (!map) return;

    const present = new Set<string>();
    let selectedLatLng: [number, number] | null = null;

    for (const [from, packet] of latest) {
      present.add(from);
      const latlng: [number, number] = [packet.lat as number, packet.lon as number];
      const isSelected = from === selected;
      if (isSelected) selectedLatLng = latlng;

      let marker = markers.get(from);
      if (!marker) {
        marker = L.marker(latlng, {
          icon: markerIcon(packet, isSelected),
          title: from,
          keyboard: false,
        })
          .addTo(map)
          .bindPopup(popupHtml(packet));
        marker.on('click', () => props.onSelect(from));
        markers.set(from, marker);
        selectedState.set(from, isSelected);
      } else {
        marker.setLatLng(latlng);
        if (selectedState.get(from) !== isSelected) {
          marker.setIcon(markerIcon(packet, isSelected));
          selectedState.set(from, isSelected);
        }
        marker.setPopupContent(popupHtml(packet));
      }

      const history = props.packets
        .filter((p) => p.from === from && hasPosition(p))
        .slice(0, 60)
        .reverse()
        .map((p) => [p.lat as number, p.lon as number] as [number, number]);
      history.push(latlng);

      let track = tracks.get(from);
      if (!track) {
        track = L.polyline(history, {
          color: TRACK_COLOUR,
          weight: isSelected ? 2 : 1,
          interactive: false,
        }).addTo(map);
        tracks.set(from, track);
      } else {
        track.setLatLngs(history);
        track.setStyle({ weight: isSelected ? 2 : 1 });
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

    if (selectedLatLng && follow) {
      map.panTo(selectedLatLng, { animate: true });
    } else if (!fittedOnce && latest.size > 0) {
      fittedOnce = true;
      const bounds = L.latLngBounds([...latest.values()].map((p) => [p.lat as number, p.lon as number]));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.25), { maxZoom: 10, animate: true });
    }
  });

  return <div ref={(el) => { container = el; }} class="absolute inset-0" />;
};

export default AprsMap;
