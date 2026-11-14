import { distanceMeters, projectOntoSegment, type LngLat } from "./geo";
import type { MatchResult } from "./matcher";
import type { RoadFragment } from "./road-fragments";
import type { RoadLine } from "./road-source";

export interface InferredRouteEdge {
  id: string;
  fromProbe: number;
  toProbe: number;
  distanceMeters: number;
  sourceRoadIds: string[];
  provenance: "inferred_transition";
  confidence: "geometry_only" | "overture_topology";
  startNodeId?: string;
  endNodeId?: string;
  geometry: GeoJSON.LineString;
}

export interface RouteTransition {
  fromProbe: number;
  toProbe: number;
  resolved: boolean;
  distanceMeters: number | null;
}

export interface InferredRouteResult {
  edges: InferredRouteEdge[];
  transitions: RouteTransition[];
  geometry: GeoJSON.MultiLineString | null;
  distanceMeters: number;
}

interface SplitPoint {
  t: number;
  point: LngLat;
}

interface WorkingSegment {
  road: RoadLine;
  segmentIndex: number;
  start: LngLat;
  end: LngLat;
  splits: SplitPoint[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface GraphArc {
  from: string;
  to: string;
  distanceMeters: number;
  roadId: string;
  coordinates: [LngLat, LngLat];
}

interface RouteGraph {
  adjacency: Map<string, GraphArc[]>;
  probeNodes: Map<number, string>;
}

interface HeapItem {
  node: string;
  distance: number;
}

class MinHeap {
  private readonly items: HeapItem[] = [];

  get length(): number {
    return this.items.length;
  }

  push(item: HeapItem): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.items[parent];
      if (!parentItem || parentItem.distance <= item.distance) break;
      this.items[index] = parentItem;
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): HeapItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last || this.items.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const leftItem = this.items[left];
      const rightItem = this.items[right];
      if (!leftItem) break;
      const child = rightItem && rightItem.distance < leftItem.distance ? right : left;
      const childItem = this.items[child];
      if (!childItem || childItem.distance >= last.distance) break;
      this.items[index] = childItem;
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function nodeKey(point: LngLat): string {
  return `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
}

function samePoint(a: LngLat, b: LngLat): boolean {
  return nodeKey(a) === nodeKey(b);
}

function oneWayDirection(road: RoadLine): -1 | 0 | 1 {
  const value = String(road.properties.oneway ?? "").toLowerCase();
  if (value === "-1" || value === "reverse") return -1;
  if (["yes", "1", "true"].includes(value)) return 1;
  return 0;
}

function explicitStructure(road: RoadLine): string | null {
  const value = road.properties.brunnel ?? road.properties.structure;
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function canConnectAtCrossing(a: RoadLine, b: RoadLine): boolean {
  const aLayer = a.properties.layer;
  const bLayer = b.properties.layer;
  if (
    aLayer !== null &&
    aLayer !== undefined &&
    bLayer !== null &&
    bLayer !== undefined &&
    String(aLayer) !== String(bLayer)
  ) {
    return false;
  }

  const aStructure = explicitStructure(a);
  const bStructure = explicitStructure(b);
  return aStructure === bStructure || (aStructure === null && bStructure === null);
}

function segmentIntersection(
  a: WorkingSegment,
  b: WorkingSegment,
): { point: LngLat; aT: number; bT: number } | null {
  if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) {
    return null;
  }

  const aDx = a.end[0] - a.start[0];
  const aDy = a.end[1] - a.start[1];
  const bDx = b.end[0] - b.start[0];
  const bDy = b.end[1] - b.start[1];
  const denominator = aDx * bDy - aDy * bDx;
  if (Math.abs(denominator) < 1e-14) return null;

  const offsetX = b.start[0] - a.start[0];
  const offsetY = b.start[1] - a.start[1];
  const aT = (offsetX * bDy - offsetY * bDx) / denominator;
  const bT = (offsetX * aDy - offsetY * aDx) / denominator;
  const epsilon = 1e-9;
  if (aT < -epsilon || aT > 1 + epsilon || bT < -epsilon || bT > 1 + epsilon) {
    return null;
  }

  const clampedAT = Math.max(0, Math.min(1, aT));
  const clampedBT = Math.max(0, Math.min(1, bT));
  return {
    point: [
      a.start[0] + aDx * clampedAT,
      a.start[1] + aDy * clampedAT,
    ],
    aT: clampedAT,
    bT: clampedBT,
  };
}

function addCollinearConnections(a: WorkingSegment, b: WorkingSegment): boolean {
  if (a.road.continuityKey !== b.road.continuityKey) return false;
  let connected = false;
  const connectEndpoint = (
    point: LngLat,
    sourceT: number,
    source: WorkingSegment,
    target: WorkingSegment,
  ): void => {
    const projection = projectOntoSegment(point, target.start, target.end);
    if (projection.distance > 1.5) return;
    source.splits.push({ t: sourceT, point });
    target.splits.push({ t: projection.t, point });
    connected = true;
  };

  connectEndpoint(a.start, 0, a, b);
  connectEndpoint(a.end, 1, a, b);
  connectEndpoint(b.start, 0, b, a);
  connectEndpoint(b.end, 1, b, a);
  return connected;
}

function buildSegments(roads: RoadLine[]): WorkingSegment[] {
  const segments: WorkingSegment[] = [];
  for (const road of roads) {
    for (let segmentIndex = 1; segmentIndex < road.coordinates.length; segmentIndex += 1) {
      const start = road.coordinates[segmentIndex - 1];
      const end = road.coordinates[segmentIndex];
      if (!start || !end || samePoint(start, end)) continue;
      segments.push({
        road,
        segmentIndex,
        start,
        end,
        splits: [
          { t: 0, point: start },
          { t: 1, point: end },
        ],
        minX: Math.min(start[0], end[0]),
        minY: Math.min(start[1], end[1]),
        maxX: Math.max(start[0], end[0]),
        maxY: Math.max(start[1], end[1]),
      });
    }
  }
  return segments;
}

function addArc(adjacency: Map<string, GraphArc[]>, arc: GraphArc): void {
  const outgoing = adjacency.get(arc.from) ?? [];
  outgoing.push(arc);
  adjacency.set(arc.from, outgoing);
  if (!adjacency.has(arc.to)) adjacency.set(arc.to, []);
}

function buildRouteGraph(match: MatchResult, roads: RoadLine[]): RouteGraph {
  const segments = buildSegments(roads);
  const segmentByRoad = new Map<string, WorkingSegment>();
  for (const segment of segments) {
    segmentByRoad.set(`${segment.road.id}:${segment.segmentIndex}`, segment);
  }

  const probeNodes = new Map<number, string>();
  for (const matched of match.matches) {
    if (!matched) continue;
    const candidate = matched.candidate;
    const segment = segmentByRoad.get(`${candidate.road.id}:${candidate.segmentIndex}`);
    if (!segment) continue;
    segment.splits.push({ t: candidate.segmentT, point: candidate.point });
    probeNodes.set(matched.observationIndex, nodeKey(candidate.point));
  }

  for (let aIndex = 0; aIndex < segments.length; aIndex += 1) {
    const a = segments[aIndex];
    if (!a) continue;
    for (let bIndex = aIndex + 1; bIndex < segments.length; bIndex += 1) {
      const b = segments[bIndex];
      if (!b || a.road.id === b.road.id || !canConnectAtCrossing(a.road, b.road)) continue;
      const intersection = segmentIntersection(a, b);
      if (!intersection) {
        addCollinearConnections(a, b);
        continue;
      }
      a.splits.push({ t: intersection.aT, point: intersection.point });
      b.splits.push({ t: intersection.bT, point: intersection.point });
    }
  }

  const adjacency = new Map<string, GraphArc[]>();
  for (const segment of segments) {
    segment.splits.sort((a, b) => a.t - b.t);
    const unique = segment.splits.filter((split, index, all) => {
      const previous = all[index - 1];
      return !previous || Math.abs(previous.t - split.t) > 1e-9;
    });
    const direction = oneWayDirection(segment.road);

    for (let index = 1; index < unique.length; index += 1) {
      const start = unique[index - 1]?.point;
      const end = unique[index]?.point;
      if (!start || !end) continue;
      const length = distanceMeters(start, end);
      if (length < 0.02) continue;
      const startKey = nodeKey(start);
      const endKey = nodeKey(end);
      const forward: GraphArc = {
        from: startKey,
        to: endKey,
        distanceMeters: length,
        roadId: segment.road.id,
        coordinates: [start, end],
      };
      if (direction >= 0) addArc(adjacency, forward);
      if (direction <= 0) {
        addArc(adjacency, {
          ...forward,
          from: endKey,
          to: startKey,
          coordinates: [end, start],
        });
      }
    }
  }

  return { adjacency, probeNodes };
}

function arcsFromCoordinates(roadId: string, coordinates: LngLat[]): GraphArc[] {
  const arcs: GraphArc[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1];
    const end = coordinates[index];
    if (!start || !end || samePoint(start, end)) continue;
    arcs.push({
      from: nodeKey(start),
      to: nodeKey(end),
      distanceMeters: distanceMeters(start, end),
      roadId,
      coordinates: [start, end],
    });
  }
  return arcs;
}

function sameRoadPath(
  previous: NonNullable<MatchResult["matches"][number]>,
  current: NonNullable<MatchResult["matches"][number]>,
): GraphArc[] | null {
  const road = previous.candidate.road;
  if (road.id !== current.candidate.road.id) return null;
  const previousPosition = previous.candidate.segmentIndex - 1 + previous.candidate.segmentT;
  const currentPosition = current.candidate.segmentIndex - 1 + current.candidate.segmentT;
  const increasing = currentPosition >= previousPosition;
  const direction = oneWayDirection(road);
  if ((direction === 1 && !increasing) || (direction === -1 && increasing)) return null;

  const coordinates: LngLat[] = [previous.candidate.point];
  if (increasing) {
    for (
      let vertexIndex = previous.candidate.segmentIndex;
      vertexIndex < current.candidate.segmentIndex;
      vertexIndex += 1
    ) {
      const vertex = road.coordinates[vertexIndex];
      if (vertex) coordinates.push(vertex);
    }
  } else {
    for (
      let vertexIndex = previous.candidate.segmentIndex - 1;
      vertexIndex >= current.candidate.segmentIndex;
      vertexIndex -= 1
    ) {
      const vertex = road.coordinates[vertexIndex];
      if (vertex) coordinates.push(vertex);
    }
  }
  coordinates.push(current.candidate.point);
  return arcsFromCoordinates(road.id, coordinates);
}

function shortestPath(
  graph: RouteGraph,
  start: string,
  end: string,
  maximumDistance: number,
): GraphArc[] | null {
  if (start === end) return [];
  if (!graph.adjacency.has(start) || !graph.adjacency.has(end)) return null;

  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, GraphArc>();
  const heap = new MinHeap();
  heap.push({ node: start, distance: 0 });

  while (heap.length > 0) {
    const current = heap.pop();
    if (!current) break;
    if (current.distance !== distances.get(current.node)) continue;
    if (current.distance > maximumDistance) break;
    if (current.node === end) break;

    for (const arc of graph.adjacency.get(current.node) ?? []) {
      const nextDistance = current.distance + arc.distanceMeters;
      if (nextDistance > maximumDistance) continue;
      if (nextDistance >= (distances.get(arc.to) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(arc.to, nextDistance);
      previous.set(arc.to, arc);
      heap.push({ node: arc.to, distance: nextDistance });
    }
  }

  if (!distances.has(end)) return null;
  const path: GraphArc[] = [];
  let cursor = end;
  while (cursor !== start) {
    const arc = previous.get(cursor);
    if (!arc) return null;
    path.push(arc);
    cursor = arc.from;
  }
  return path.reverse();
}

function pointCoveredByFragment(
  point: LngLat,
  fragment: RoadFragment,
): boolean {
  for (let index = 1; index < fragment.coordinates.length; index += 1) {
    const start = fragment.coordinates[index - 1];
    const end = fragment.coordinates[index];
    if (!start || !end) continue;
    if (projectOntoSegment(point, start, end).distance <= 1.5) return true;
  }
  return false;
}

function arcIsDirectlyMatched(
  arc: GraphArc,
  fragmentsByRoad: Map<string, RoadFragment[]>,
): boolean {
  const fragments = fragmentsByRoad.get(arc.roadId);
  if (!fragments) return false;
  const [start, end] = arc.coordinates;
  const midpoint: LngLat = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
  ];
  return fragments.some((fragment) => pointCoveredByFragment(midpoint, fragment));
}

function pathCoordinates(path: GraphArc[]): LngLat[] {
  if (path.length === 0) return [];
  const coordinates: LngLat[] = [path[0]?.coordinates[0] as LngLat];
  for (const arc of path) coordinates.push(arc.coordinates[1]);
  return coordinates;
}

export function inferRoute(
  match: MatchResult,
  roads: RoadLine[],
  fragments: RoadFragment[],
): InferredRouteResult {
  const graph = buildRouteGraph(match, roads);
  const fragmentsByRoad = new Map<string, RoadFragment[]>();
  for (const fragment of fragments) {
    const grouped = fragmentsByRoad.get(fragment.road.id) ?? [];
    grouped.push(fragment);
    fragmentsByRoad.set(fragment.road.id, grouped);
  }

  const successful = match.matches.filter(
    (matched): matched is NonNullable<typeof matched> => matched !== null,
  );
  const transitions: RouteTransition[] = [];
  const edges: InferredRouteEdge[] = [];
  const routeBlocks: LngLat[][] = [];
  let activeBlock: LngLat[] | null = null;
  let totalDistance = 0;

  for (let index = 1; index < successful.length; index += 1) {
    const previous = successful[index - 1];
    const current = successful[index];
    if (!previous || !current) continue;
    const fromProbe = previous.observationIndex;
    const toProbe = current.observationIndex;
    const startNode = graph.probeNodes.get(fromProbe);
    const endNode = graph.probeNodes.get(toProbe);
    const direct = distanceMeters(previous.candidate.point, current.candidate.point);
    const maximumDistance = Math.min(1_500, Math.max(180, direct * 3 + 50));
    const directRoadPath = sameRoadPath(previous, current);
    const path = directRoadPath ?? (startNode && endNode
      ? shortestPath(graph, startNode, endNode, maximumDistance)
      : null);

    if (!path) {
      transitions.push({ fromProbe, toProbe, resolved: false, distanceMeters: null });
      activeBlock = null;
      continue;
    }

    const distance = path.reduce((sum, arc) => sum + arc.distanceMeters, 0);
    totalDistance += distance;
    transitions.push({ fromProbe, toProbe, resolved: true, distanceMeters: distance });

    const coordinates = pathCoordinates(path);
    if (coordinates.length > 1) {
      if (activeBlock && samePoint(activeBlock.at(-1) as LngLat, coordinates[0] as LngLat)) {
        activeBlock.push(...coordinates.slice(1));
      } else {
        activeBlock = [...coordinates];
        routeBlocks.push(activeBlock);
      }
    }

    let connectorCoordinates: LngLat[] = [];
    let connectorDistance = 0;
    let connectorRoadIds: string[] = [];
    const flushConnector = (): void => {
      if (connectorCoordinates.length < 2) {
        connectorCoordinates = [];
        connectorDistance = 0;
        connectorRoadIds = [];
        return;
      }
      edges.push({
        id: `inferred:${String(edges.length + 1).padStart(3, "0")}`,
        fromProbe,
        toProbe,
        distanceMeters: connectorDistance,
        sourceRoadIds: [...new Set(connectorRoadIds)],
        provenance: "inferred_transition",
        confidence: "geometry_only",
        geometry: { type: "LineString", coordinates: connectorCoordinates },
      });
      connectorCoordinates = [];
      connectorDistance = 0;
      connectorRoadIds = [];
    };

    for (const arc of path) {
      if (arcIsDirectlyMatched(arc, fragmentsByRoad)) {
        flushConnector();
        continue;
      }
      if (connectorCoordinates.length === 0) {
        connectorCoordinates.push(arc.coordinates[0]);
      }
      connectorCoordinates.push(arc.coordinates[1]);
      connectorDistance += arc.distanceMeters;
      connectorRoadIds.push(arc.roadId);
    }
    flushConnector();
  }

  return {
    edges,
    transitions,
    geometry: routeBlocks.length > 0
      ? { type: "MultiLineString", coordinates: routeBlocks }
      : null,
    distanceMeters: totalDistance,
  };
}
