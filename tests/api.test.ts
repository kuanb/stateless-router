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
  assert.equal(response.route.connectivityVerified, false);
  assert.equal(response.render.edges.features[0]?.properties?.start_node, response.edges[0]?.startNode);
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
});
