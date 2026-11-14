import { distanceMeters, type LngLat } from "./geo";
import type { InferredRouteResult } from "./local-router";
import type { Candidate, MatchResult } from "./matcher";
import type { RoadLine } from "./road-source";

interface Split {
  distance: number;
  node: string;
  connector: boolean;
  probeIndices: number[];
}

interface Arc {
  from: string;
  to: string;
  road: RoadLine;
  distanceMeters: number;
  coordinates: LngLat[];
}

interface Graph {
  adjacency: Map<string, Arc[]>;
  probeNodes: Map<number, string>;
}

interface HeapItem {
  node: string;
  distance: number;
}

class MinHeap {
  private readonly values: HeapItem[] = [];

  get length(): number {
    return this.values.length;
  }

  push(value: HeapItem): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.values[parent];
      if (!parentValue || parentValue.distance <= value.distance) break;
      this.values[index] = parentValue;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): HeapItem | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const leftValue = this.values[left];
      const rightValue = this.values[right];
      if (!leftValue) break;
      const child = rightValue && rightValue.distance < leftValue.distance ? right : left;
      const childValue = this.values[child];
      if (!childValue || childValue.distance >= last.distance) break;
      this.values[index] = childValue;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function connectorNode(id: string): string {
  return `overture:connector:${id}`;
}

function probeNode(road: RoadLine, point: LngLat): string {
  return `overture:probe:${road.id}:${point[0].toFixed(7)},${point[1].toFixed(7)}`;
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

function candidateDistance(
  segmentIndex: number,
  segmentT: number,
  coordinates: LngLat[],
  cumulative: number[],
): number {
  const startIndex = Math.max(0, segmentIndex - 1);
  const start = coordinates[startIndex];
  const end = coordinates[segmentIndex];
  return (cumulative[startIndex] ?? 0) +
    (start && end ? distanceMeters(start, end) * segmentT : 0);
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

function sliceLine(road: RoadLine, startDistance: number, endDistance: number): LngLat[] {
  const cumulative = cumulativeDistances(road.coordinates);
  const start = pointAtDistance(road.coordinates, cumulative, startDistance);
  const end = pointAtDistance(road.coordinates, cumulative, endDistance);
  const output: LngLat[] = [start.point];
  for (let index = start.segmentIndex; index < end.segmentIndex; index += 1) {
    const coordinate = road.coordinates[index];
    if (coordinate) output.push(coordinate);
  }
  output.push(end.point);
  return output.filter((coordinate, index) => {
    const previous = output[index - 1];
    return !previous || distanceMeters(previous, coordinate) > 0.01;
  });
}

function lineDistance(coordinates: LngLat[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous && current) total += distanceMeters(previous, current);
  }
  return total;
}

function addArc(adjacency: Map<string, Arc[]>, arc: Arc): void {
  const arcs = adjacency.get(arc.from) ?? [];
  arcs.push(arc);
  adjacency.set(arc.from, arcs);
  if (!adjacency.has(arc.to)) adjacency.set(arc.to, []);
}

function collapseSplits(splits: Split[], probeNodes: Map<number, string>): Split[] {
  const sorted = [...splits].sort((a, b) => a.distance - b.distance);
  const collapsed: Split[] = [];
  for (const split of sorted) {
    const previous = collapsed.at(-1);
    if (!previous || split.distance - previous.distance > 0.1) {
      collapsed.push({ ...split, probeIndices: [...split.probeIndices] });
      continue;
    }
    if (split.connector && !previous.connector) {
      previous.node = split.node;
      previous.connector = true;
    }
    previous.probeIndices.push(...split.probeIndices);
  }
  for (const split of collapsed) {
    for (const probeIndex of split.probeIndices) probeNodes.set(probeIndex, split.node);
  }
  return collapsed;
}

function buildGraph(match: MatchResult, roads: RoadLine[]): Graph {
  const matchesByRoad = new Map<string, NonNullable<MatchResult["matches"][number]>[]>();
  for (const matched of match.matches) {
    if (!matched?.candidate.road.topology) continue;
    const group = matchesByRoad.get(matched.candidate.road.id) ?? [];
    group.push(matched);
    matchesByRoad.set(matched.candidate.road.id, group);
  }

  const adjacency = new Map<string, Arc[]>();
  const probeNodes = new Map<number, string>();
  for (const road of roads) {
    const topology = road.topology;
    if (!topology || road.coordinates.length < 2) continue;
    const cumulative = cumulativeDistances(road.coordinates);
    const total = cumulative.at(-1) ?? 0;
    const splits: Split[] = [
      {
        distance: 0,
        node: connectorNode(topology.startConnectorId),
        connector: true,
        probeIndices: [],
      },
      {
        distance: total,
        node: connectorNode(topology.endConnectorId),
        connector: true,
        probeIndices: [],
      },
    ];
    for (const matched of matchesByRoad.get(road.id) ?? []) {
      splits.push({
        distance: candidateDistance(
          matched.candidate.segmentIndex,
          matched.candidate.segmentT,
          road.coordinates,
          cumulative,
        ),
        node: probeNode(road, matched.candidate.point),
        connector: false,
        probeIndices: [matched.observationIndex],
      });
    }

    const collapsed = collapseSplits(splits, probeNodes);
    for (let index = 1; index < collapsed.length; index += 1) {
      const start = collapsed[index - 1];
      const end = collapsed[index];
      if (!start || !end || end.distance - start.distance < 0.02) continue;
      const coordinates = sliceLine(road, start.distance, end.distance);
      const distance = lineDistance(coordinates);
      if (topology.forwardAllowed) {
        addArc(adjacency, {
          from: start.node,
          to: end.node,
          road,
          distanceMeters: distance,
          coordinates,
        });
      }
      if (topology.backwardAllowed) {
        addArc(adjacency, {
          from: end.node,
          to: start.node,
          road,
          distanceMeters: distance,
          coordinates: [...coordinates].reverse(),
        });
      }
    }
  }
  return { adjacency, probeNodes };
}

function shortestPath(
  graph: Graph,
  start: string,
  end: string,
  maximumDistance: number,
): Arc[] | null {
  if (start === end) return [];
  if (!graph.adjacency.has(start) || !graph.adjacency.has(end)) return null;
  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, Arc>();
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
  const path: Arc[] = [];
  let cursor = end;
  while (cursor !== start) {
    const arc = previous.get(cursor);
    if (!arc) return null;
    path.push(arc);
    cursor = arc.from;
  }
  return path.reverse();
}

function appendCoordinates(target: LngLat[], source: LngLat[]): void {
  if (source.length === 0) return;
  if (target.length === 0) {
    target.push(...source);
    return;
  }
  const last = target.at(-1);
  const first = source[0];
  target.push(...(last && first && distanceMeters(last, first) <= 0.1 ? source.slice(1) : source));
}

export function inferOvertureRoute(
  match: MatchResult,
  roads: RoadLine[],
): InferredRouteResult {
  const graph = buildGraph(match, roads);
  const directlyMatched = new Set(match.selectedRoads.map((road) => road.id));
  const successful = match.matches.filter(
    (matched): matched is NonNullable<typeof matched> => matched !== null,
  );
  const transitions: InferredRouteResult["transitions"] = [];
  const edges: InferredRouteResult["edges"] = [];
  const routeBlocks: LngLat[][] = [];
  let activeRoute: LngLat[] | null = null;
  let totalDistance = 0;

  for (let index = 1; index < successful.length; index += 1) {
    const previous = successful[index - 1];
    const current = successful[index];
    if (!previous || !current) continue;
    const fromProbe = previous.observationIndex;
    const toProbe = current.observationIndex;
    const start = graph.probeNodes.get(fromProbe);
    const end = graph.probeNodes.get(toProbe);
    const direct = distanceMeters(previous.candidate.point, current.candidate.point);
    const maximumDistance = Math.min(1_500, Math.max(180, direct * 3 + 50));
    const path = start && end ? shortestPath(graph, start, end, maximumDistance) : null;
    if (!path) {
      transitions.push({ fromProbe, toProbe, resolved: false, distanceMeters: null });
      activeRoute = null;
      continue;
    }

    const distance = path.reduce((sum, arc) => sum + arc.distanceMeters, 0);
    totalDistance += distance;
    transitions.push({ fromProbe, toProbe, resolved: true, distanceMeters: distance });
    const pathCoordinates: LngLat[] = [];
    for (const arc of path) appendCoordinates(pathCoordinates, arc.coordinates);
    if (pathCoordinates.length > 1) {
      if (
        activeRoute &&
        activeRoute.at(-1) &&
        pathCoordinates[0] &&
        distanceMeters(activeRoute.at(-1) as LngLat, pathCoordinates[0]) <= 0.1
      ) {
        activeRoute.push(...pathCoordinates.slice(1));
      } else {
        activeRoute = [...pathCoordinates];
        routeBlocks.push(activeRoute);
      }
    }

    let connectorCoordinates: LngLat[] = [];
    let connectorDistance = 0;
    let connectorRoadIds: string[] = [];
    let connectorStartNode: string | null = null;
    let connectorEndNode: string | null = null;
    const flush = (): void => {
      if (connectorCoordinates.length >= 2 && connectorStartNode && connectorEndNode) {
        edges.push({
          id: `overture-inferred:${String(edges.length + 1).padStart(3, "0")}`,
          fromProbe,
          toProbe,
          distanceMeters: connectorDistance,
          sourceRoadIds: [...new Set(connectorRoadIds)],
          provenance: "inferred_transition",
          confidence: "overture_topology",
          startNodeId: connectorStartNode,
          endNodeId: connectorEndNode,
          geometry: { type: "LineString", coordinates: connectorCoordinates },
        });
      }
      connectorCoordinates = [];
      connectorDistance = 0;
      connectorRoadIds = [];
      connectorStartNode = null;
      connectorEndNode = null;
    };

    for (const arc of path) {
      if (directlyMatched.has(arc.road.id)) {
        flush();
        continue;
      }
      if (!connectorStartNode) connectorStartNode = arc.from;
      connectorEndNode = arc.to;
      appendCoordinates(connectorCoordinates, arc.coordinates);
      connectorDistance += arc.distanceMeters;
      connectorRoadIds.push(arc.road.id);
    }
    flush();
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

interface DistanceArc {
  to: string;
  distance: number;
}

export function createOvertureTransitionDistance(
  roads: RoadLine[],
): (previous: Candidate, current: Candidate, maximumDistance: number) => number | null {
  const adjacency = new Map<string, DistanceArc[]>();
  const roadLengths = new Map<string, number>();
  const add = (from: string, to: string, distance: number): void => {
    const arcs = adjacency.get(from) ?? [];
    arcs.push({ to, distance });
    adjacency.set(from, arcs);
    if (!adjacency.has(to)) adjacency.set(to, []);
  };

  for (const road of roads) {
    const topology = road.topology;
    if (!topology) continue;
    const distance = lineDistance(road.coordinates);
    roadLengths.set(road.id, distance);
    if (topology.forwardAllowed) {
      add(topology.startConnectorId, topology.endConnectorId, distance);
    }
    if (topology.backwardAllowed) {
      add(topology.endConnectorId, topology.startConnectorId, distance);
    }
  }

  const position = (candidate: Candidate): number => {
    const cumulative = cumulativeDistances(candidate.road.coordinates);
    return candidateDistance(
      candidate.segmentIndex,
      candidate.segmentT,
      candidate.road.coordinates,
      cumulative,
    );
  };

  return (previous, current, maximumDistance) => {
    const previousTopology = previous.road.topology;
    const currentTopology = current.road.topology;
    if (!previousTopology || !currentTopology) return null;
    const previousLength = roadLengths.get(previous.road.id) ?? lineDistance(previous.road.coordinates);
    const currentLength = roadLengths.get(current.road.id) ?? lineDistance(current.road.coordinates);
    const previousPosition = position(previous);
    const currentPosition = position(current);
    let best = Number.POSITIVE_INFINITY;

    if (previous.road.id === current.road.id) {
      if (currentPosition >= previousPosition && previousTopology.forwardAllowed) {
        best = currentPosition - previousPosition;
      }
      if (currentPosition <= previousPosition && previousTopology.backwardAllowed) {
        best = Math.min(best, previousPosition - currentPosition);
      }
    }

    const departures: { node: string; distance: number }[] = [];
    if (previousTopology.forwardAllowed) {
      departures.push({
        node: previousTopology.endConnectorId,
        distance: Math.max(0, previousLength - previousPosition),
      });
    }
    if (previousTopology.backwardAllowed) {
      departures.push({
        node: previousTopology.startConnectorId,
        distance: Math.max(0, previousPosition),
      });
    }
    const arrivals = new Map<string, number>();
    if (currentTopology.forwardAllowed) {
      arrivals.set(currentTopology.startConnectorId, Math.max(0, currentPosition));
    }
    if (currentTopology.backwardAllowed) {
      const arrivalDistance = Math.max(0, currentLength - currentPosition);
      arrivals.set(
        currentTopology.endConnectorId,
        Math.min(arrivals.get(currentTopology.endConnectorId) ?? Number.POSITIVE_INFINITY, arrivalDistance),
      );
    }

    const distances = new Map<string, number>();
    const heap = new MinHeap();
    for (const departure of departures) {
      if (departure.distance >= (distances.get(departure.node) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }
      distances.set(departure.node, departure.distance);
      heap.push(departure);
    }
    while (heap.length > 0) {
      const item = heap.pop();
      if (!item) break;
      if (item.distance !== distances.get(item.node)) continue;
      if (item.distance >= best || item.distance > maximumDistance) break;
      const arrival = arrivals.get(item.node);
      if (arrival !== undefined) best = Math.min(best, item.distance + arrival);
      for (const arc of adjacency.get(item.node) ?? []) {
        const next = item.distance + arc.distance;
        if (next >= best || next > maximumDistance) continue;
        if (next >= (distances.get(arc.to) ?? Number.POSITIVE_INFINITY)) continue;
        distances.set(arc.to, next);
        heap.push({ node: arc.to, distance: next });
      }
    }

    return Number.isFinite(best) && best <= maximumDistance ? best : null;
  };
}
