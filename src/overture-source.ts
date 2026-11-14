import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";
import {
  bufferedTileKeys,
  distanceMeters,
  projectOntoSegment,
  tilePointToLngLat,
  type LngLat,
} from "./geo";
import {
  mapWithConcurrency,
  type RoadFetchResult,
  type RoadLine,
  type RoadProperty,
  type RoadSource,
} from "./road-source";

interface ConnectorReference {
  connector_id: string;
  at: number;
}

interface RawSegmentPiece {
  segmentId: string;
  coordinates: LngLat[];
  connectorReferences: ConnectorReference[];
  properties: Record<string, RoadProperty>;
}

interface DecodedOvertureTile {
  connectors: Map<string, LngLat>;
  segments: RawSegmentPiece[];
}

interface LocatedPoint {
  point: LngLat;
  distanceAlong: number;
  distanceFromLine: number;
}

interface SplitLocation extends LocatedPoint {
  connectorId: string;
  stable: boolean;
  at: number | null;
}

const DRIVABLE_ROAD_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "living_street",
  "service",
  "unclassified",
  "track",
  "unknown",
]);

function parseJsonArray<T>(value: RoadProperty): T[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseConnectorReferences(value: RoadProperty): ConnectorReference[] {
  return parseJsonArray<Record<string, unknown>>(value)
    .map((item) => ({
      connector_id: typeof item.connector_id === "string" ? item.connector_id : "",
      at: typeof item.at === "number" ? item.at : Number.NaN,
    }))
    .filter((item) => item.connector_id.length > 0 && Number.isFinite(item.at));
}

function accessDirections(properties: Record<string, RoadProperty>): {
  forwardAllowed: boolean;
  backwardAllowed: boolean;
} {
  let forwardAllowed = true;
  let backwardAllowed = true;
  const restrictions = parseJsonArray<Record<string, unknown>>(
    properties.access_restrictions,
  );

  for (const restriction of restrictions) {
    if (restriction.access_type !== "denied") continue;
    const when = restriction.when;
    if (!when || typeof when !== "object" || Array.isArray(when)) {
      forwardAllowed = false;
      backwardAllowed = false;
      continue;
    }
    const entries = Object.entries(when as Record<string, unknown>);
    // Only enforce unconditional direction rules here. More specific vehicle,
    // time, and dimensional restrictions need a declared routing profile.
    if (entries.some(([key]) => key !== "heading")) continue;
    const heading = (when as Record<string, unknown>).heading;
    if (heading === "forward") forwardAllowed = false;
    if (heading === "backward") backwardAllowed = false;
  }

  return { forwardAllowed, backwardAllowed };
}

function kindForClass(roadClass: string): string {
  if (["motorway", "trunk"].includes(roadClass)) return "highway";
  if (["primary", "secondary", "tertiary"].includes(roadClass)) return "major_road";
  return "minor_road";
}

function sameEndpoint(a: LngLat, b: LngLat): boolean {
  return distanceMeters(a, b) <= 1.5;
}

function appendPiece(block: LngLat[], piece: LngLat[]): LngLat[] | null {
  const blockFirst = block[0];
  const blockLast = block.at(-1);
  const pieceFirst = piece[0];
  const pieceLast = piece.at(-1);
  if (!blockFirst || !blockLast || !pieceFirst || !pieceLast) return null;

  if (sameEndpoint(blockLast, pieceFirst)) return [...block, ...piece.slice(1)];
  if (sameEndpoint(blockLast, pieceLast)) return [...block, ...piece.slice(0, -1).reverse()];
  if (sameEndpoint(blockFirst, pieceLast)) return [...piece.slice(0, -1), ...block];
  if (sameEndpoint(blockFirst, pieceFirst)) return [...piece.slice(1).reverse(), ...block];
  return null;
}

function stitchPieces(pieces: LngLat[][]): LngLat[][] {
  const unique = new Map<string, LngLat[]>();
  for (const piece of pieces) {
    const key = piece
      .map(([longitude, latitude]) => `${longitude.toFixed(7)},${latitude.toFixed(7)}`)
      .join(";");
    if (!unique.has(key)) unique.set(key, piece);
  }

  const remaining = [...unique.values()];
  const blocks: LngLat[][] = [];
  while (remaining.length > 0) {
    let block = [...(remaining.shift() ?? [])];
    let joined = true;
    while (joined) {
      joined = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const piece = remaining[index];
        if (!piece) continue;
        const combined = appendPiece(block, piece);
        if (!combined) continue;
        block = combined;
        remaining.splice(index, 1);
        joined = true;
        break;
      }
    }
    if (block.length >= 2) blocks.push(block);
  }
  return blocks;
}

function cumulativeDistances(coordinates: LngLat[]): number[] {
  const cumulative = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    cumulative.push(
      (cumulative[index - 1] ?? 0) +
        (previous && current ? distanceMeters(previous, current) : 0),
    );
  }
  return cumulative;
}

function locateOnLine(coordinates: LngLat[], point: LngLat): LocatedPoint {
  const cumulative = cumulativeDistances(coordinates);
  let best: LocatedPoint = {
    point: coordinates[0] ?? point,
    distanceAlong: 0,
    distanceFromLine: Number.POSITIVE_INFINITY,
  };
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    if (!start || !end) continue;
    const projection = projectOntoSegment(point, start, end);
    if (projection.distance >= best.distanceFromLine) continue;
    best = {
      point: projection.point,
      distanceAlong:
        (cumulative[index - 1] ?? 0) + distanceMeters(start, end) * projection.t,
      distanceFromLine: projection.distance,
    };
  }
  return best;
}

function pointAtDistance(
  coordinates: LngLat[],
  cumulative: number[],
  distance: number,
): { point: LngLat; segmentIndex: number } {
  for (let index = 1; index < coordinates.length; index += 1) {
    const segmentEnd = cumulative[index] ?? 0;
    if (distance > segmentEnd && index < coordinates.length - 1) continue;
    const start = coordinates[index - 1] ?? coordinates[0] ?? [0, 0];
    const end = coordinates[index] ?? start;
    const segmentStart = cumulative[index - 1] ?? 0;
    const length = Math.max(0.000001, segmentEnd - segmentStart);
    const t = Math.max(0, Math.min(1, (distance - segmentStart) / length));
    return {
      point: [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ],
      segmentIndex: index,
    };
  }
  return {
    point: coordinates.at(-1) ?? [0, 0],
    segmentIndex: Math.max(0, coordinates.length - 1),
  };
}

function sliceLine(
  coordinates: LngLat[],
  startDistance: number,
  endDistance: number,
): LngLat[] {
  const cumulative = cumulativeDistances(coordinates);
  const start = pointAtDistance(coordinates, cumulative, startDistance);
  const end = pointAtDistance(coordinates, cumulative, endDistance);
  const output: LngLat[] = [start.point];
  for (let index = start.segmentIndex; index < end.segmentIndex; index += 1) {
    const coordinate = coordinates[index];
    if (coordinate) output.push(coordinate);
  }
  output.push(end.point);
  return output.filter((coordinate, index) => {
    const previous = output[index - 1];
    return !previous || distanceMeters(previous, coordinate) > 0.01;
  });
}

function boundaryConnectorId(segmentId: string, point: LngLat): string {
  return `clip:${segmentId}:${point[0].toFixed(7)},${point[1].toFixed(7)}`;
}

function orientBlock(
  block: LngLat[],
  references: ConnectorReference[],
  connectors: Map<string, LngLat>,
): LngLat[] {
  const located = references
    .map((reference) => {
      const coordinate = connectors.get(reference.connector_id);
      if (!coordinate) return null;
      const location = locateOnLine(block, coordinate);
      return location.distanceFromLine <= 3
        ? { at: reference.at, distance: location.distanceAlong }
        : null;
    })
    .filter((item): item is { at: number; distance: number } => item !== null)
    .sort((a, b) => a.at - b.at);
  const first = located[0];
  const last = located.at(-1);
  return first && last && last.at > first.at && last.distance < first.distance
    ? [...block].reverse()
    : block;
}

export function materializeOvertureRoads(
  segmentPieces: RawSegmentPiece[],
  connectors: Map<string, LngLat>,
): RoadLine[] {
  const piecesBySegment = new Map<string, RawSegmentPiece[]>();
  for (const piece of segmentPieces) {
    const group = piecesBySegment.get(piece.segmentId) ?? [];
    group.push(piece);
    piecesBySegment.set(piece.segmentId, group);
  }

  const roads = new Map<string, RoadLine>();
  for (const [segmentId, pieces] of piecesBySegment) {
    const representative = pieces[0];
    if (!representative) continue;
    const references = representative.connectorReferences;
    const { forwardAllowed, backwardAllowed } = accessDirections(representative.properties);
    if (!forwardAllowed && !backwardAllowed) continue;

    for (const stitched of stitchPieces(pieces.map((piece) => piece.coordinates))) {
      const block = orientBlock(stitched, references, connectors);
      const totalLength = cumulativeDistances(block).at(-1) ?? 0;
      const locations: SplitLocation[] = [];
      for (const reference of references) {
        const coordinate = connectors.get(reference.connector_id);
        if (!coordinate) continue;
        const located = locateOnLine(block, coordinate);
        if (located.distanceFromLine > 3) continue;
        locations.push({
          ...located,
          connectorId: reference.connector_id,
          stable: true,
          at: reference.at,
        });
      }

      const first = block[0];
      const last = block.at(-1);
      if (!first || !last) continue;
      if (!locations.some((location) => location.distanceAlong <= 1.5)) {
        locations.push({
          point: first,
          distanceAlong: 0,
          distanceFromLine: 0,
          connectorId: boundaryConnectorId(segmentId, first),
          stable: false,
          at: null,
        });
      }
      if (!locations.some((location) => totalLength - location.distanceAlong <= 1.5)) {
        locations.push({
          point: last,
          distanceAlong: totalLength,
          distanceFromLine: 0,
          connectorId: boundaryConnectorId(segmentId, last),
          stable: false,
          at: null,
        });
      }

      locations.sort((a, b) => a.distanceAlong - b.distanceAlong);
      const uniqueLocations = locations.filter((location, index, all) => {
        const previous = all[index - 1];
        return !previous || location.distanceAlong - previous.distanceAlong > 0.5;
      });

      for (let index = 1; index < uniqueLocations.length; index += 1) {
        const start = uniqueLocations[index - 1];
        const end = uniqueLocations[index];
        if (!start || !end || end.distanceAlong - start.distanceAlong < 0.2) continue;
        const coordinates = sliceLine(block, start.distanceAlong, end.distanceAlong);
        if (coordinates.length < 2) continue;
        const id = `overture:${segmentId}:${start.connectorId}:${end.connectorId}`;
        const roadClass = String(representative.properties.class ?? "unknown");
        const oneway = forwardAllowed && backwardAllowed
          ? null
          : forwardAllowed
            ? "yes"
            : "-1";
        const road: RoadLine = {
          id,
          continuityKey: `overture:${segmentId}`,
          coordinates,
          properties: {
            ...representative.properties,
            kind: kindForClass(roadClass),
            kind_detail: roadClass,
            name: representative.properties["@name"] ?? null,
            oneway,
            overture_segment_id: segmentId,
            start_connector_id: start.connectorId,
            end_connector_id: end.connectorId,
          },
          kind: kindForClass(roadClass),
          kindDetail: roadClass,
          topology: {
            network: "overture_transportation",
            segmentId,
            startConnectorId: start.connectorId,
            endConnectorId: end.connectorId,
            startConnectorStable: start.stable,
            endConnectorStable: end.stable,
            forwardAllowed,
            backwardAllowed,
            prohibitedTransitions:
              typeof representative.properties.prohibited_transitions === "string"
                ? representative.properties.prohibited_transitions
                : null,
          },
        };
        const existing = roads.get(id);
        if (!existing || existing.coordinates.length < road.coordinates.length) {
          roads.set(id, road);
        }
      }
    }
  }
  return [...roads.values()];
}

export class OvertureRoadSource implements RoadSource {
  private readonly tileCache = new Map<string, Promise<DecodedOvertureTile>>();

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
    const tiles = await mapWithConcurrency(keys, 6, async (key) => {
      const cached = this.tileCache.get(key);
      if (cached) {
        cacheHits += 1;
        const tile = await cached;
        finished += 1;
        onProgress?.(finished, keys.length);
        return tile;
      }
      const pending = this.decodeTile(key);
      this.tileCache.set(key, pending);
      try {
        const tile = await pending;
        decodedTiles += 1;
        return tile;
      } catch (error) {
        this.tileCache.delete(key);
        throw error;
      } finally {
        finished += 1;
        onProgress?.(finished, keys.length);
      }
    });

    const connectors = new Map<string, LngLat>();
    const segments: RawSegmentPiece[] = [];
    for (const tile of tiles) {
      tile.connectors.forEach((coordinate, id) => connectors.set(id, coordinate));
      segments.push(...tile.segments);
    }
    const roads = materializeOvertureRoads(segments, connectors);
    return {
      roads,
      tileCount: keys.length,
      decodedTiles,
      cacheHits,
      elapsedMs: performance.now() - started,
    };
  }

  clear(): void {
    this.tileCache.clear();
  }

  private async decodeTile(key: string): Promise<DecodedOvertureTile> {
    const [zoom, tileX, tileY] = key.split("/").map(Number);
    if (zoom === undefined || tileX === undefined || tileY === undefined) {
      return { connectors: new Map(), segments: [] };
    }
    const response = await this.archive.getZxy(zoom, tileX, tileY);
    if (!response) return { connectors: new Map(), segments: [] };
    const tile = new VectorTile(new Pbf(new Uint8Array(response.data)));
    const connectors = new Map<string, LngLat>();
    const connectorLayer = tile.layers.connector;
    if (connectorLayer) {
      for (let index = 0; index < connectorLayer.length; index += 1) {
        const feature = connectorLayer.feature(index);
        if (feature.type !== 1) continue;
        const id = String(feature.properties.id ?? "");
        const point = feature.loadGeometry()[0]?.[0];
        if (!id || !point) continue;
        connectors.set(
          id,
          tilePointToLngLat(tileX, tileY, zoom, point.x, point.y, feature.extent),
        );
      }
    }

    const segments: RawSegmentPiece[] = [];
    const segmentLayer = tile.layers.segment;
    if (!segmentLayer) return { connectors, segments };
    for (let index = 0; index < segmentLayer.length; index += 1) {
      const feature = segmentLayer.feature(index);
      if (feature.type !== 2 || feature.properties.subtype !== "road") continue;
      const roadClass = String(feature.properties.class ?? "unknown");
      if (!DRIVABLE_ROAD_CLASSES.has(roadClass)) continue;
      const segmentId = String(feature.properties.id ?? "");
      if (!segmentId) continue;
      const connectorReferences = parseConnectorReferences(feature.properties.connectors);
      for (const line of feature.loadGeometry()) {
        if (line.length < 2) continue;
        segments.push({
          segmentId,
          connectorReferences,
          properties: feature.properties,
          coordinates: line.map((point) =>
            tilePointToLngLat(
              tileX,
              tileY,
              zoom,
              point.x,
              point.y,
              feature.extent,
            ),
          ),
        });
      }
    }
    return { connectors, segments };
  }
}
