// ============================================================
// Maidenhead grid locator helpers
// ============================================================
// Shared by the station header (receiver grid from its map position) and the
// decoder tables (grid carried in a WSJT-family decode). All coordinates are
// WGS84 degrees; a grid is 4 characters (field + square) or 6 characters
// (field + square + subsquare).

export interface GridCenter {
  lat: number;
  lon: number;
}

/** Six-character Maidenhead locator for a receiver position. `''` when the
 *  position is unset (the admin map uses 0,0 for "no pin") or invalid. */
export function gridFromLatLon(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return '';
  if (latitude === 0 && longitude === 0) return '';

  // Clamp the upper edges so 180/90 do not overflow into the next field.
  const lon = Math.min(longitude, 179.999999);
  const lat = Math.min(latitude, 89.999999);
  const lonAdj = lon + 180;
  const latAdj = lat + 90;

  const fieldLon = Math.floor(lonAdj / 20);
  const fieldLat = Math.floor(latAdj / 10);
  const squareLon = Math.floor((lonAdj % 20) / 2);
  const squareLat = Math.floor(latAdj % 10);
  const subLon = Math.floor(((lonAdj % 2) / 2) * 24);
  const subLat = Math.floor((latAdj % 1) * 24);

  return (
    String.fromCharCode(65 + fieldLon) +
    String.fromCharCode(65 + fieldLat) +
    squareLon +
    squareLat +
    String.fromCharCode(65 + subLon) +
    String.fromCharCode(65 + subLat)
  );
}

function letterIndex(ch: string, max: number): number | null {
  const value = ch.charCodeAt(0) - 65;
  return value >= 0 && value <= max ? value : null;
}

/** Centre of a 4- or 6-character Maidenhead locator, or null if malformed. */
export function gridCenter(grid: string): GridCenter | null {
  const value = grid.trim().toUpperCase();
  if (value.length !== 4 && value.length !== 6) return null;

  const fieldLon = letterIndex(value[0], 17);
  const fieldLat = letterIndex(value[1], 17);
  if (fieldLon === null || fieldLat === null) return null;
  if (!/[0-9]/.test(value[2]) || !/[0-9]/.test(value[3])) return null;

  const squareLon = Number(value[2]);
  const squareLat = Number(value[3]);
  let lon = -180 + fieldLon * 20 + squareLon * 2;
  let lat = -90 + fieldLat * 10 + squareLat;

  if (value.length === 6) {
    const subLon = letterIndex(value[4], 23);
    const subLat = letterIndex(value[5], 23);
    if (subLon === null || subLat === null) return null;
    lon += (subLon + 0.5) * (2 / 24);
    lat += (subLat + 0.5) * (1 / 24);
  } else {
    lon += 1;
    lat += 0.5;
  }

  return { lat, lon };
}

/** "lat, lon" label for a grid tooltip, or `''` for an invalid/empty grid. */
export function formatGridCenter(grid: string): string {
  const center = gridCenter(grid);
  return center ? `${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}` : '';
}

function asGrid(token: string | undefined): string {
  if (!token) return '';
  const value = token.trim().toUpperCase();
  if (value.length !== 4 && value.length !== 6) return '';
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(value)) return '';
  // RR73 is a legal square name, but in a WSJT decode it is an ack.
  if (value === 'RR73') return '';
  return value;
}

/** Grid carried by a WSJT-family decode. Mirrors the server-side
 *  `extract_grid` so live rows and historical rows that predate the server
 *  field still show it. WSPR is CALL GRID POWER; everything else puts the
 *  grid in the final exchange field. */
export function extractGridFromText(mode: string, text: string): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  if (mode.trim().toLowerCase() === 'wspr') return asGrid(tokens[1]);
  if (tokens[0].toUpperCase() === 'CQ') {
    if (tokens.length < 3) return '';
    if (!/[0-9]/.test(tokens[tokens.length - 2])) return '';
    return asGrid(tokens[tokens.length - 1]);
  }
  if (tokens.length < 3) return '';
  return asGrid(tokens[tokens.length - 1]);
}
