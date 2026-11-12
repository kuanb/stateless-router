export type LngLat = [number, number];

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function distanceMeters(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const deltaLat = (b[1] - a[1]) * DEG_TO_RAD;
  const deltaLon = (b[0] - a[0]) * DEG_TO_RAD;

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const deltaLon = (b[0] - a[0]) * DEG_TO_RAD;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

export function bearingDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function undirectedBearingDifference(a: number, b: number): number {
  const directed = bearingDifference(a, b);
  return Math.min(directed, Math.abs(180 - directed));
}

export interface Projection {
  point: LngLat;
  distance: number;
  t: number;
  bearing: number;
}

export function projectOntoSegment(
  point: LngLat,
  start: LngLat,
  end: LngLat,
): Projection {
  const lat = point[1] * DEG_TO_RAD;
  const metersPerLonDegree = 111_320 * Math.cos(lat);
  const metersPerLatDegree = 110_574;

  const ax = (start[0] - point[0]) * metersPerLonDegree;
  const ay = (start[1] - point[1]) * metersPerLatDegree;
  const bx = (end[0] - point[0]) * metersPerLonDegree;
  const by = (end[1] - point[1]) * metersPerLatDegree;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const unclamped = lengthSquared === 0 ? 0 : -(ax * dx + ay * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, unclamped));
  const x = ax + dx * t;
  const y = ay + dy * t;

  return {
    point: [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t],
    distance: Math.hypot(x, y),
    t,
    bearing: bearingDegrees(start, end),
  };
}

export function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

export function latToTileY(lat: number, zoom: number): number {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, lat)) * DEG_TO_RAD;
  return Math.floor(
    ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom,
  );
}

export function tilePointToLngLat(
  tileX: number,
  tileY: number,
  zoom: number,
  pointX: number,
  pointY: number,
  extent: number,
): LngLat {
  const scale = 2 ** zoom;
  const worldX = (tileX + pointX / extent) / scale;
  const worldY = (tileY + pointY / extent) / scale;
  const lon = worldX * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * RAD_TO_DEG;
  return [lon, lat];
}

export function bufferedTileKeys(
  points: LngLat[],
  radiusMeters: number,
  zoom: number,
): string[] {
  const keys = new Set<string>();
  const worldSize = 2 ** zoom;

  for (const [lon, lat] of points) {
    const latDelta = radiusMeters / 110_574;
    const lonScale = Math.max(0.05, Math.cos(lat * DEG_TO_RAD));
    const lonDelta = radiusMeters / (111_320 * lonScale);
    const minX = Math.max(0, lonToTileX(lon - lonDelta, zoom));
    const maxX = Math.min(worldSize - 1, lonToTileX(lon + lonDelta, zoom));
    const minY = Math.max(0, latToTileY(lat + latDelta, zoom));
    const maxY = Math.min(worldSize - 1, latToTileY(lat - latDelta, zoom));

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        keys.add(`${zoom}/${x}/${y}`);
      }
    }
  }

  return [...keys];
}
