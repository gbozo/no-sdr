// ============================================================
// Receiver Location Map — pin the station on OpenStreetMap
// ============================================================
// This is deliberately separate from the display-only station location text
// field. Coordinates are stored in server.receiverLatitude/receiverLongitude
// and will be used by future map overlays for contacts and other stations.

import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ReceiverLocationMapProps {
  latitude: number;
  longitude: number;
  onChange: (latitude: number, longitude: number) => void;
}

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
}

const DEFAULT_CENTER: [number, number] = [20, 0];
const ACCENT = '#38e8ff';

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isValidPosition(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

function pinIcon(): L.DivIcon {
  return L.divIcon({
    className: 'receiver-location-pin',
    html: `
      <div style="width:26px;height:34px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8));">
        <svg viewBox="0 0 24 32" width="26" height="34" aria-hidden="true">
          <path d="M12 1.2c-5.2 0-9.4 4.2-9.4 9.4 0 7.1 9.4 19.2 9.4 19.2s9.4-12.1 9.4-19.2c0-5.2-4.2-9.4-9.4-9.4z"
                fill="${ACCENT}" stroke="#041017" stroke-width="1.4"/>
          <circle cx="12" cy="10.4" r="3.5" fill="#041017"/>
        </svg>
      </div>`,
    iconSize: [26, 34],
    iconAnchor: [13, 33],
  });
}

const ReceiverLocationMap: Component<ReceiverLocationMapProps> = (props) => {
  let container: HTMLDivElement | undefined;
  let map: L.Map | undefined;
  let marker: L.Marker | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let fitted = false;

  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<NominatimResult[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [error, setError] = createSignal('');

  const position = (): [number, number] | null => {
    const lat = Number(props.latitude);
    const lon = Number(props.longitude);
    return isValidPosition(lat, lon) ? [lat, lon] : null;
  };

  const placeMarker = (latitude: number, longitude: number, moveMap: boolean): void => {
    if (!map) return;
    const next: [number, number] = [latitude, longitude];
    if (!marker) {
      marker = L.marker(next, { draggable: true, icon: pinIcon() }).addTo(map);
      marker.on('dragend', () => {
        const point = marker?.getLatLng();
        if (!point) return;
        props.onChange(roundCoord(point.lat), roundCoord(point.lng));
      });
    } else {
      marker.setLatLng(next);
    }
    if (moveMap) {
      map.setView(next, Math.max(map.getZoom(), 8));
    }
  };

  const clearPin = (): void => {
    if (marker) {
      marker.remove();
      marker = undefined;
    }
    fitted = false;
    setQuery('');
    setResults([]);
    setError('');
    props.onChange(0, 0);
    map?.setView(DEFAULT_CENTER, 2);
  };

  const search = async (event?: Event): Promise<void> => {
    event?.preventDefault();
    const text = query().trim();
    if (!text || searching()) return;
    setSearching(true);
    setError('');
    setResults([]);
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
        encodeURIComponent(text);
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'Accept-Language': 'en' },
      });
      if (!response.ok) {
        throw new Error(`Nominatim returned ${response.status}`);
      }
      const data = (await response.json()) as NominatimResult[];
      setResults(Array.isArray(data) ? data : []);
      if (!Array.isArray(data) || data.length === 0) {
        setError('No matching addresses found. You can click the map to pin the receiver.');
      }
    } catch {
      setError(
        'Address search is unavailable right now. Click the map or drag the pin instead.',
      );
    } finally {
      setSearching(false);
    }
  };

  const selectResult = (result: NominatimResult): void => {
    const latitude = Number.parseFloat(result.lat);
    const longitude = Number.parseFloat(result.lon);
    if (!isValidPosition(latitude, longitude)) return;
    setQuery(result.display_name);
    setResults([]);
    setError('');
    props.onChange(roundCoord(latitude), roundCoord(longitude));
    placeMarker(latitude, longitude, true);
    fitted = true;
  };

  onMount(() => {
    if (!container) return;
    map = L.map(container, {
      center: DEFAULT_CENTER,
      zoom: 2,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map);

    map.on('click', (event: L.LeafletMouseEvent) => {
      const latitude = roundCoord(event.latlng.lat);
      const longitude = roundCoord(event.latlng.lng);
      props.onChange(latitude, longitude);
      placeMarker(latitude, longitude, false);
      fitted = true;
    });

    const current = position();
    if (current) {
      placeMarker(current[0], current[1], false);
      map.setView(current, 9);
      fitted = true;
    }

    resizeObserver = new ResizeObserver(() => map?.invalidateSize());
    resizeObserver.observe(container);
  });

  // Keep the pin in sync with saved/config values or a search selection. The
  // initial position is handled in onMount; this effect covers later updates.
  createEffect(() => {
    const latitude = Number(props.latitude);
    const longitude = Number(props.longitude);
    if (!map) return;
    if (!isValidPosition(latitude, longitude)) {
      if (marker) {
        marker.remove();
        marker = undefined;
      }
      return;
    }
    placeMarker(latitude, longitude, false);
    if (!fitted) {
      map.setView([latitude, longitude], 9);
      fitted = true;
    }
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    map?.remove();
    map = undefined;
    marker = undefined;
  });

  return (
    <div class="space-y-2">
      <form onSubmit={(event) => search(event)} class="flex flex-wrap items-center gap-2">
        <input
          type="text"
          class="admin-input min-w-48 flex-1"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search an address, city or landmark…"
          autocomplete="off"
        />
        <button
          type="submit"
          disabled={searching()}
          class="px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-cyan/40 text-cyan hover:bg-cyan hover:text-text-inverse transition-colors disabled:opacity-40"
        >
          {searching() ? 'Searching…' : 'Search'}
        </button>
        <button
          type="button"
          onClick={clearPin}
          class="px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded border border-border/50 text-text-dim hover:text-amber hover:border-amber/50 transition-colors"
        >
          Clear pin
        </button>
      </form>

      <Show when={results().length > 0}>
        <div class="max-h-40 overflow-y-auto border border-border/40 rounded-sm bg-sdr-base/60">
          <For each={results()}>
            {(result) => (
              <button
                type="button"
                onClick={() => selectResult(result)}
                class="block w-full px-2 py-1.5 text-left text-[10px] font-mono text-text-secondary hover:bg-cyan/10 hover:text-cyan border-b border-border/20 last:border-b-0"
              >
                {result.display_name}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="text-[9px] font-mono text-amber">{error()}</p>
      </Show>

      <div
        ref={container}
        class="h-72 w-full rounded-sm border border-border/40 bg-sdr-base/40 overflow-hidden"
      />

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[9px] font-mono text-text-dim">
        <span>
          {position()
            ? `PINNED ${props.latitude.toFixed(6)}, ${props.longitude.toFixed(6)}`
            : 'NO RECEIVER PIN SET'}
        </span>
        <span class="text-text-muted">
          Click the map or drag the pin to set the receiver position.
        </span>
      </div>
    </div>
  );
};

export default ReceiverLocationMap;
