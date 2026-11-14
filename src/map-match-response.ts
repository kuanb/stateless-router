import { PMTILES_URL, TILE_ZOOM } from "./config";
import { bearingDegrees, bearingDifference, type LngLat } from "./geo";
import { inferRoute } from "./local-router";
import type { MatchResult } from "./matcher";
import { inferOvertureRoute } from "./overture-router";
import { selectedRoadFragments } from "./road-fragments";
import type { RoadFetchResult, RoadLine } from "./road-source";
import type {
  ApiEdge,
  ApiNode,
  ApiProbeMatch,
  MapMatchRequest,
  MapMatchResponse,
  ResolvedMapMatchRequest,
} from "./api-types";

const DEFAULTS = {
  radiusMeters: 70,
  candidateCount: 6,
  sequenceAware: true,
  edgePaddingMeters: 0,
  inferRoute: true,
} as const;

function finiteNumber(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function coordinate(value: unknown, index: number): LngLat {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`coordinates[${index}] must be a [longitude, latitude] pair.`);
  }
  const [longitude, latitude] = value;
  if (
    typeof longitude !== "number" ||
    typeof latitude !== "number" ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -85.05112878 ||
    latitude > 85.05112878
  ) {
    throw new Error(`coordinates[${index}] is outside the supported longitude/latitude range.`);
  }
  return [longitude, latitude];
}

export function resolveMapMatchRequest(input: unknown): ResolvedMapMatchRequest {
  if (!input || typeof input !== "object") throw new Error("Request must be a JSON object.");
  const request = input as Partial<MapMatchRequest>;
  if (!Array.isArray(request.coordinates) || request.coordinates.length < 2) {
    throw new Error("coordinates must contain at least two probe positions.");
  }
  if (request.coordinates.length > 1_000) {
    throw new Error("coordinates is limited to 1,000 probe positions per request.");
  }
  if (
    request.options !== undefined &&
    (!request.options || typeof request.options !== "object" || Array.isArray(request.options))
  ) {
    throw new Error("options must be a JSON object when provided.");
  }

  const options = request.options ?? {};
  const candidateCount = finiteNumber(
    options.candidateCount,
    DEFAULTS.candidateCount,
    "options.candidateCount",
    1,
    24,
  );
  if (!Number.isInteger(candidateCount)) {
    throw new Error("options.candidateCount must be an integer.");
  }
  if (options.sequenceAware !== undefined && typeof options.sequenceAware !== "boolean") {
    throw new Error("options.sequenceAware must be a boolean.");
  }
  if (options.inferRoute !== undefined && typeof options.inferRoute !== "boolean") {
    throw new Error("options.inferRoute must be a boolean.");
  }

  return {
    coordinates: request.coordinates.map(coordinate),
    options: {
      radiusMeters: finiteNumber(
        options.radiusMeters,
        DEFAULTS.radiusMeters,
        "options.radiusMeters",
        5,
        500,
      ),
      candidateCount,
      sequenceAware: options.sequenceAware ?? DEFAULTS.sequenceAware,
      inferRoute: options.inferRoute ?? DEFAULTS.inferRoute,
      edgePaddingMeters: finiteNumber(
        options.edgePaddingMeters,
        DEFAULTS.edgePaddingMeters,
        "options.edgePaddingMeters",
        0,
        250,
      ),
    },
  };
}

function nodeId(coordinate: LngLat): string {
  return `node:${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`;
}

function oneWayDirection(road: RoadLine): -1 | 0 | 1 {
  const value = String(road.properties.oneway ?? "").toLowerCase();
  if (value === "-1" || value === "reverse") return -1;
  if (["yes", "1", "true"].includes(value)) return 1;
  return 0;
}

function stringProperty(road: RoadLine, key: string): string | null {
  const value = road.properties[key];
  return value === null || value === undefined || value === "" ? null : String(value);
}

function edgeFeature(edge: ApiEdge): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    id: edge.id,
    properties: {
      edge_id: edge.id,
      start_node: edge.startNode,
      end_node: edge.endNode,
      direction: edge.direction,
      geometry_order: edge.geometryOrder,
      topology: edge.topology,
      ...edge.properties,
    },
    geometry: edge.geometry,
  };
}

function matchFeatures(
  probes: ApiProbeMatch[],
): GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point>[] = [];
  let block: LngLat[] = [];
  const flush = (): void => {
    if (block.length > 1) {
      features.push({
        type: "Feature",
        properties: { kind: "matched_path" },
        geometry: { type: "LineString", coordinates: block },
      });
    }
    block = [];
  };

  for (const probe of probes) {
    if (!probe.matched || !probe.snapped) {
      flush();
      continue;
    }
    block.push(probe.snapped);
    features.push({
      type: "Feature",
      properties: {
        kind: "matched_probe",
        probe_index: probe.index,
        edge_id: probe.edgeId,
        distance_meters: probe.distanceMeters,
      },
      geometry: { type: "Point", coordinates: probe.snapped },
    });
  }
  flush();
  return { type: "FeatureCollection", features };
}

export function buildMapMatchResponse(
  request: ResolvedMapMatchRequest,
  match: MatchResult,
  fetch: RoadFetchResult,
  elapsedMs: number,
  source: MapMatchResponse["source"] = {
    kind: "pmtiles",
    network: "protomaps_geometry",
    tileZoom: TILE_ZOOM,
    archive: PMTILES_URL,
  },
): MapMatchResponse {
  const overture = source.network === "overture_transportation";
  const fragments = selectedRoadFragments(
    match,
    !overture,
    request.options.edgePaddingMeters,
  );
  const inferredRoute = request.options.inferRoute
    ? overture
      ? inferOvertureRoute(match, fetch.roads)
      : inferRoute(match, fetch.roads, fragments)
    : { edges: [], transitions: [], geometry: null, distanceMeters: 0 };
  const nodesById = new Map<string, ApiNode>();
  const edgeIdByRoad = new Map<string, string>();

  const edges = fragments.map((fragment, index): ApiEdge => {
    const direction = oneWayDirection(fragment.road);
    const topology = fragment.road.topology;
    const firstRoadMatch = match.matches.find(
      (matched) => matched?.candidate.road.id === fragment.road.id,
    );
    const first = fragment.coordinates[0] as LngLat;
    const last = fragment.coordinates[fragment.coordinates.length - 1] as LngLat;
    const reverse = direction === -1 || (
      direction === 0 &&
      firstRoadMatch != null &&
      bearingDifference(
        bearingDegrees(first, last),
        firstRoadMatch.candidate.travelBearing,
      ) > 90
    );
    const geometryCoordinates = reverse
      ? [...fragment.coordinates].reverse()
      : fragment.coordinates;
    const sourceCoordinates = reverse
      ? [...fragment.road.coordinates].reverse()
      : fragment.road.coordinates;
    const start = geometryCoordinates[0] as LngLat;
    const end = geometryCoordinates[geometryCoordinates.length - 1] as LngLat;
    const sourceStartConnector = reverse
      ? topology?.endConnectorId
      : topology?.startConnectorId;
    const sourceEndConnector = reverse
      ? topology?.startConnectorId
      : topology?.endConnectorId;
    const sourceStartStable = reverse
      ? topology?.endConnectorStable
      : topology?.startConnectorStable;
    const sourceEndStable = reverse
      ? topology?.startConnectorStable
      : topology?.endConnectorStable;
    const startNode = sourceStartConnector
      ? `overture:connector:${sourceStartConnector}`
      : nodeId(start);
    const endNode = sourceEndConnector
      ? `overture:connector:${sourceEndConnector}`
      : nodeId(end);
    const id = topology
      ? `edge:${fragment.road.id}`
      : `edge:${String(index + 1).padStart(3, "0")}`;

    nodesById.set(startNode, {
      id: startNode,
      coordinate: start,
      kind: sourceStartStable ? "overture_connector" : "fragment_endpoint",
      intersectionInferred: false,
      ...(sourceStartConnector ? { sourceId: sourceStartConnector } : {}),
    });
    nodesById.set(endNode, {
      id: endNode,
      coordinate: end,
      kind: sourceEndStable ? "overture_connector" : "fragment_endpoint",
      intersectionInferred: false,
      ...(sourceEndConnector ? { sourceId: sourceEndConnector } : {}),
    });
    edgeIdByRoad.set(fragment.road.id, id);

    return {
      id,
      sourceRoadId: fragment.road.id,
      startNode,
      endNode,
      direction: direction === 0 ? "bidirectional" : "forward",
      geometryOrder: "matched_travel",
      topology: topology ? "overture_connectors" : "unresolved",
      geometry: { type: "LineString", coordinates: geometryCoordinates },
      sourceGeometry: { type: "LineString", coordinates: sourceCoordinates },
      properties: {
        kind: fragment.road.kind,
        kindDetail: fragment.road.kindDetail,
        name: stringProperty(fragment.road, "name"),
        ref: stringProperty(fragment.road, "ref"),
        oneway: stringProperty(fragment.road, "oneway"),
        access: stringProperty(fragment.road, "access"),
        ...(topology
          ? {
              segmentId: topology.segmentId,
              startConnectorId: sourceStartConnector ?? null,
              endConnectorId: sourceEndConnector ?? null,
            }
          : {}),
      },
    };
  });

  const inferredEdges = inferredRoute.edges.map((edge) => {
    const start = edge.geometry.coordinates[0] as LngLat;
    const end = edge.geometry.coordinates[edge.geometry.coordinates.length - 1] as LngLat;
    const startNode = edge.startNodeId ?? nodeId(start);
    const endNode = edge.endNodeId ?? nodeId(end);
    const startIsOverture = startNode.startsWith("overture:connector:");
    const endIsOverture = endNode.startsWith("overture:connector:");
    if (!nodesById.has(startNode)) {
      nodesById.set(startNode, {
        id: startNode,
        coordinate: start,
        kind: startIsOverture && !startNode.includes(":clip:")
          ? "overture_connector"
          : "inferred_route_endpoint",
        intersectionInferred: false,
        ...(startIsOverture
          ? { sourceId: startNode.slice("overture:connector:".length) }
          : {}),
      });
    }
    if (!nodesById.has(endNode)) {
      nodesById.set(endNode, {
        id: endNode,
        coordinate: end,
        kind: endIsOverture && !endNode.includes(":clip:")
          ? "overture_connector"
          : "inferred_route_endpoint",
        intersectionInferred: false,
        ...(endIsOverture
          ? { sourceId: endNode.slice("overture:connector:".length) }
          : {}),
      });
    }
    return { ...edge, startNode, endNode };
  });

  const probes: ApiProbeMatch[] = match.matches.map((matched, index) => ({
    index,
    input: request.coordinates[index] as LngLat,
    matched: matched !== null,
    snapped: matched?.candidate.point ?? null,
    distanceMeters: matched?.candidate.distance ?? null,
    edgeId: matched ? (edgeIdByRoad.get(matched.candidate.road.id) ?? null) : null,
    travelBearing: matched?.candidate.travelBearing ?? null,
  }));
  const matched = probes.filter((probe) => probe.matched).length;
  const edgeSequence = probes.reduce<string[]>((sequence, probe) => {
    if (probe.edgeId && sequence[sequence.length - 1] !== probe.edgeId) {
      sequence.push(probe.edgeId);
    }
    return sequence;
  }, []);

  return {
    schema: "stateless-router/map-match/v1",
    request,
    source,
    probes,
    nodes: [...nodesById.values()],
    edges,
    inferredEdges,
    route: {
      edgeSequence,
      inferredEdgeSequence: inferredEdges.map((edge) => edge.id),
      connectivityVerified:
        overture &&
        inferredRoute.transitions.length > 0 &&
        inferredRoute.transitions.every((transition) => transition.resolved),
      connectivityInferred:
        inferredRoute.transitions.length > 0 &&
        inferredRoute.transitions.every((transition) => transition.resolved),
      distanceMeters: inferredRoute.distanceMeters,
      geometry: inferredRoute.geometry,
      transitions: inferredRoute.transitions,
    },
    render: {
      edges: { type: "FeatureCollection", features: edges.map(edgeFeature) },
      inferredEdges: {
        type: "FeatureCollection",
        features: inferredEdges.map((edge) => ({
          type: "Feature",
          id: edge.id,
          properties: {
            edge_id: edge.id,
            start_node: edge.startNode,
            end_node: edge.endNode,
            provenance: edge.provenance,
            confidence: edge.confidence,
            from_probe: edge.fromProbe,
            to_probe: edge.toProbe,
            distance_meters: edge.distanceMeters,
            source_road_ids: edge.sourceRoadIds,
          },
          geometry: edge.geometry,
        })),
      },
      matches: matchFeatures(probes),
    },
    stats: {
      matched,
      total: request.coordinates.length,
      meanErrorMeters: match.meanErrorMeters,
      tilesRequested: fetch.tileCount,
      roadsDecoded: fetch.roads.length,
      tileCacheHits: fetch.cacheHits,
      elapsedMs,
    },
    warnings: [
      ...(overture
        ? [
            "Direct edges and nodes use Overture segment and connector topology; clipped tile-boundary endpoints remain synthetic.",
            "Unconditional directional access restrictions are enforced, but conditional access and prohibited-transition sequences are not yet evaluated.",
          ]
        : [
            "Edge endpoints are synthetic fragment endpoints, not inferred road-network intersections.",
            "This geometry-only match does not guarantee connected or legally routable travel.",
          ]),
      ...(request.options.inferRoute && !overture
        ? [
            "Inferred route edges come from a temporary geometry graph; they do not include turn restrictions or verified intersection topology.",
          ]
        : []),
      ...(inferredRoute.transitions.some((transition) => !transition.resolved)
        ? [
            overture
              ? "Some transitions could not be connected through the fetched Overture connector graph."
              : "Some transitions could not be connected using the fetched road geometry.",
          ]
        : []),
    ],
  };
}
