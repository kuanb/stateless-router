import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";
import { bufferedTileKeys, tilePointToLngLat, type LngLat } from "./geo";

type RoadProperty = string | number | boolean | null | undefined;

export interface RoadLine {
  id: string;
  continuityKey: string;
  coordinates: LngLat[];
  properties: Record<string, RoadProperty>;
  kind: string;
  kindDetail: string;
}

export interface RoadFetchResult {
  roads: RoadLine[];
  tileCount: number;
  decodedTiles: number;
  cacheHits: number;
  elapsedMs: number;
}

const DRIVABLE_KINDS = new Set(["highway", "major_road", "minor_road"]);

export function roadLineId(
  tileKey: string,
  sourceId: string,
  featureIndex: number,
  lineIndex: number,
): string {
  return `${tileKey}:${sourceId}:${featureIndex}:${lineIndex}`;
}

function isDrivable(properties: Record<string, RoadProperty>): boolean {
  const kind = String(properties.kind ?? "");
  const detail = String(properties.kind_detail ?? "");
  if (!DRIVABLE_KINDS.has(kind)) return false;
  if (["pedestrian", "steps", "corridor", "sidewalk", "crossing"].includes(detail)) {
    return false;
  }
  return properties.access !== "no";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
  );
  return results;
}

export class ProtomapsRoadSource {
  private readonly tileCache = new Map<string, Promise<RoadLine[]>>();

  constructor(
    private readonly archive: PMTiles,
    private readonly zoom: number,
  ) {}

  async roadsAround(
    points: LngLat[],
    radiusMeters: number,
    onProgress?: (finished: number, total: number) => void,
  ): Promise<RoadFetchResult> {
    const started = performance.now();
    const keys = bufferedTileKeys(points, radiusMeters, this.zoom);
    let cacheHits = 0;
    let decodedTiles = 0;
    let finished = 0;

    const groups = await mapWithConcurrency(keys, 8, async (key) => {
      const cached = this.tileCache.get(key);
      if (cached) {
        cacheHits += 1;
        const roads = await cached;
        finished += 1;
        onProgress?.(finished, keys.length);
        return roads;
      }

      const pending = this.decodeTile(key);
      this.tileCache.set(key, pending);
      try {
        const roads = await pending;
        decodedTiles += 1;
        return roads;
      } catch (error) {
        this.tileCache.delete(key);
        throw error;
      } finally {
        finished += 1;
        onProgress?.(finished, keys.length);
      }
    });

    return {
      roads: groups.flat(),
      tileCount: keys.length,
      decodedTiles,
      cacheHits,
      elapsedMs: performance.now() - started,
    };
  }

  clear(): void {
    this.tileCache.clear();
  }

  private async decodeTile(key: string): Promise<RoadLine[]> {
    const parts = key.split("/").map(Number);
    const [zoom, tileX, tileY] = parts;
    if (zoom === undefined || tileX === undefined || tileY === undefined) return [];

    const response = await this.archive.getZxy(zoom, tileX, tileY);
    if (!response) return [];

    const tile = new VectorTile(new Pbf(new Uint8Array(response.data)));
    const layer = tile.layers.roads;
    if (!layer) return [];

    const roads: RoadLine[] = [];
    for (let featureIndex = 0; featureIndex < layer.length; featureIndex += 1) {
      const feature = layer.feature(featureIndex);
      if (feature.type !== 2 || !isDrivable(feature.properties)) continue;

      const kind = String(feature.properties.kind ?? "road");
      const kindDetail = String(feature.properties.kind_detail ?? kind);
      const sourceId = feature.id === undefined ? `${key}:${featureIndex}` : String(feature.id);
      const routeIdentity = String(
        feature.properties.name ?? feature.properties.ref ?? sourceId,
      );
      const geometries = feature.loadGeometry();

      geometries.forEach((line, lineIndex) => {
        if (line.length < 2) return;
        const coordinates = line.map((point) =>
          tilePointToLngLat(
            tileX,
            tileY,
            zoom,
            point.x,
            point.y,
            feature.extent,
          ),
        );
        roads.push({
          // A source feature ID is not unique within a vector-tile layer. Keep
          // the feature index so separate pieces cannot collapse during trim.
          id: roadLineId(key, sourceId, featureIndex, lineIndex),
          continuityKey: `${kindDetail}:${routeIdentity}`,
          coordinates,
          properties: feature.properties,
          kind,
          kindDetail,
        });
      });
    }

    return roads;
  }
}
