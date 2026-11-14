import assert from "node:assert/strict";
import test from "node:test";
import type { LngLat } from "../src/geo";
import { buildMapMatchResponse, resolveMapMatchRequest } from "../src/map-match-response";
import type { MatchResult } from "../src/matcher";
import type { RoadFetchResult, RoadLine } from "../src/road-source";

const selectedRoad: RoadLine = {
  id: "road:primary:1",
  continuityKey: "primary:Broadway",
  coordinates: [
    [0, 0],
    [0.01, 0],
  ],
  properties: {
    kind: "major_road",
    kind_detail: "primary",
    name: "Broadway",
    oneway: "yes",
  },
  kind: "major_road",
  kindDetail: "primary",
};

function candidate(index: number, point: LngLat, segmentT: number) {
  return {
    observationIndex: index,
    road: selectedRoad,
    point,
    distance: 2,
    bearing: 90,
    segmentIndex: 1,
    segmentT,
    travelBearing: 90,
    onewayDirection: 1 as const,
    emissionCost: 0.1,
  };
}

test("serializes matched fragments as renderable edges with explicit endpoint nodes", () => {
  const request = resolveMapMatchRequest({
    coordinates: [
      [0.002, 0.00001],
      [0.008, -0.00001],
    ],
    options: { edgePaddingMeters: 0 },
  });
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: request.coordinates[0] as LngLat,
        candidate: candidate(0, [0.002, 0], 0.2),
      },
      {
        observationIndex: 1,
        observation: request.coordinates[1] as LngLat,
        candidate: candidate(1, [0.008, 0], 0.8),
      },
    ],
    selectedRoads: [selectedRoad],
    meanErrorMeters: 2,
  };
  const fetched: RoadFetchResult = {
    roads: [selectedRoad],
    tileCount: 1,
    decodedTiles: 1,
    cacheHits: 0,
    elapsedMs: 4,
  };

  const response = buildMapMatchResponse(request, match, fetched, 6);

  assert.equal(response.schema, "stateless-router/map-match/v1");
  assert.equal(response.edges.length, 1);
  assert.equal(response.inferredEdges.length, 0);
  assert.equal(response.nodes.length, 2);
  assert.equal(response.edges[0]?.direction, "forward");
  assert.equal(response.edges[0]?.geometryOrder, "matched_travel");
  assert.equal(response.edges[0]?.topology, "unresolved");
  assert.deepEqual(response.edges[0]?.geometry.coordinates, [
    [0.002, 0],
    [0.008, 0],
  ]);
  assert.deepEqual(response.edges[0]?.sourceGeometry.coordinates, selectedRoad.coordinates);
  assert.equal(response.nodes.every((node) => node.intersectionInferred === false), true);
  assert.equal(response.probes[0]?.edgeId, response.edges[0]?.id);
  assert.equal(response.probes[1]?.edgeId, response.edges[0]?.id);
  assert.deepEqual(response.route.edgeSequence, [response.edges[0]?.id]);
  assert.deepEqual(response.route.inferredEdgeSequence, []);
  assert.equal(response.route.connectivityInferred, true);
  assert.equal(response.route.connectivityVerified, false);
  assert.equal(response.render.edges.features[0]?.properties?.start_node, response.edges[0]?.startNode);
  assert.equal(response.render.inferredEdges.features.length, 0);
});

test("serializes inferred connectors separately with endpoint nodes and provenance", () => {
  const northRoad: RoadLine = {
    ...selectedRoad,
    id: "north-road",
    continuityKey: "residential:North Road",
    coordinates: [[0, 0], [0, 0.001]],
    properties: { ...selectedRoad.properties, name: "North Road", oneway: null },
  };
  const eastRoad: RoadLine = {
    ...selectedRoad,
    id: "east-road",
    continuityKey: "residential:East Road",
    coordinates: [[-0.001, 0.0005], [0.001, 0.0005]],
    properties: { ...selectedRoad.properties, name: "East Road", oneway: null },
  };
  const first: LngLat = [0, 0.0004];
  const second: LngLat = [0.0006, 0.0005];
  const request = resolveMapMatchRequest({ coordinates: [first, second] });
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: first,
        candidate: {
          ...candidate(0, first, 0.4),
          road: northRoad,
          bearing: 0,
          travelBearing: 0,
        },
      },
      {
        observationIndex: 1,
        observation: second,
        candidate: {
          ...candidate(1, second, 0.8),
          road: eastRoad,
        },
      },
    ],
    selectedRoads: [northRoad, eastRoad],
    meanErrorMeters: 0,
  };
  const fetched: RoadFetchResult = {
    roads: [northRoad, eastRoad],
    tileCount: 1,
    decodedTiles: 1,
    cacheHits: 0,
    elapsedMs: 1,
  };

  const response = buildMapMatchResponse(request, match, fetched, 2);

  assert.equal(response.inferredEdges.length, 1);
  assert.equal(response.inferredEdges[0]?.provenance, "inferred_transition");
  assert.equal(response.inferredEdges[0]?.confidence, "geometry_only");
  assert.ok(response.inferredEdges[0]?.startNode);
  assert.ok(response.inferredEdges[0]?.endNode);
  assert.equal(
    response.nodes.some((node) => node.kind === "inferred_route_endpoint"),
    true,
  );
  assert.equal(
    response.render.inferredEdges.features[0]?.properties?.provenance,
    "inferred_transition",
  );
});

test("serializes Overture spans with connector nodes and stable segment identity", () => {
  const overtureRoad: RoadLine = {
    ...selectedRoad,
    id: "overture:segment-1:c0:c1",
    continuityKey: "overture:segment-1",
    properties: {
      ...selectedRoad.properties,
      overture_segment_id: "segment-1",
      start_connector_id: "c0",
      end_connector_id: "c1",
    },
    topology: {
      network: "overture_transportation",
      segmentId: "segment-1",
      startConnectorId: "c0",
      endConnectorId: "c1",
      startConnectorStable: true,
      endConnectorStable: true,
      forwardAllowed: true,
      backwardAllowed: false,
      prohibitedTransitions: null,
    },
  };
  const request = resolveMapMatchRequest({
    coordinates: [[0.002, 0], [0.008, 0]],
  });
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: request.coordinates[0] as LngLat,
        candidate: { ...candidate(0, [0.002, 0], 0.2), road: overtureRoad },
      },
      {
        observationIndex: 1,
        observation: request.coordinates[1] as LngLat,
        candidate: { ...candidate(1, [0.008, 0], 0.8), road: overtureRoad },
      },
    ],
    selectedRoads: [overtureRoad],
    meanErrorMeters: 0,
  };
  const fetched: RoadFetchResult = {
    roads: [overtureRoad],
    tileCount: 1,
    decodedTiles: 1,
    cacheHits: 0,
    elapsedMs: 1,
  };

  const response = buildMapMatchResponse(request, match, fetched, 2, {
    kind: "pmtiles",
    network: "overture_transportation",
    tileZoom: 14,
    archive: "https://example.com/transportation.pmtiles",
    release: "test",
  });

  assert.equal(response.edges[0]?.id, `edge:${overtureRoad.id}`);
  assert.equal(response.edges[0]?.topology, "overture_connectors");
  assert.equal(response.edges[0]?.startNode, "overture:connector:c0");
  assert.equal(response.edges[0]?.endNode, "overture:connector:c1");
  assert.equal(response.edges[0]?.properties.segmentId, "segment-1");
  assert.equal(response.nodes.every((node) => node.kind === "overture_connector"), true);
  assert.equal(response.route.connectivityVerified, true);
});

test("validates the page API request before fetching tiles", () => {
  assert.throws(
    () => resolveMapMatchRequest({ coordinates: [[-122.27, 37.8]] }),
    /at least two probe positions/,
  );
  assert.throws(
    () =>
      resolveMapMatchRequest({
        coordinates: [
          [-122.27, 37.8],
          [-122.26, 37.81],
        ],
        options: { radiusMeters: 0 },
      }),
    /radiusMeters/,
  );
  assert.throws(
    () =>
      resolveMapMatchRequest({
        coordinates: [
          [-122.27, 37.8],
          [-122.26, 37.81],
        ],
        options: { inferRoute: "sometimes" },
      }),
    /inferRoute/,
  );
});
