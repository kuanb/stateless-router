import assert from "node:assert/strict";
import test from "node:test";
import type { LngLat } from "../src/geo";
import { inferRoute } from "../src/local-router";
import type { Candidate, MatchResult } from "../src/matcher";
import { selectedRoadFragments } from "../src/road-fragments";
import type { RoadLine } from "../src/road-source";

function road(id: string, coordinates: LngLat[]): RoadLine {
  return {
    id,
    continuityKey: `minor:${id}`,
    coordinates,
    properties: {
      kind: "minor_road",
      kind_detail: "residential",
      name: id,
      oneway: null,
    },
    kind: "minor_road",
    kindDetail: "residential",
  };
}

function candidate(
  observationIndex: number,
  selectedRoad: RoadLine,
  point: LngLat,
  segmentT: number,
  travelBearing: number,
): Candidate {
  return {
    observationIndex,
    road: selectedRoad,
    point,
    distance: 0,
    bearing: travelBearing,
    segmentIndex: 1,
    segmentT,
    travelBearing,
    onewayDirection: 0,
    emissionCost: 0,
  };
}

test("infers an L-turn connector between sparse matched probes", () => {
  const northRoad = road("north-road", [
    [0, 0],
    [0, 0.001],
  ]);
  const eastRoad = road("east-road", [
    [-0.001, 0.0005],
    [0.001, 0.0005],
  ]);
  const firstPoint: LngLat = [0, 0.0004];
  const secondPoint: LngLat = [0.0006, 0.0005];
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: firstPoint,
        candidate: candidate(0, northRoad, firstPoint, 0.4, 0),
      },
      {
        observationIndex: 1,
        observation: secondPoint,
        candidate: candidate(1, eastRoad, secondPoint, 0.8, 90),
      },
    ],
    selectedRoads: [northRoad, eastRoad],
    meanErrorMeters: 0,
  };
  const fragments = selectedRoadFragments(match, true, 0);

  const route = inferRoute(match, [northRoad, eastRoad], fragments);

  assert.equal(route.transitions[0]?.resolved, true);
  assert.equal(route.edges.length, 1);
  assert.deepEqual(route.edges[0]?.geometry.coordinates, [
    firstPoint,
    [0, 0.0005],
    secondPoint,
  ]);
  assert.deepEqual(route.edges[0]?.sourceRoadIds, ["north-road", "east-road"]);
  assert.equal(route.edges[0]?.provenance, "inferred_transition");
  assert.ok(route.distanceMeters > 70 && route.distanceMeters < 90);
});

test("reports an unresolved transition instead of drawing a straight-line guess", () => {
  const firstRoad = road("first", [
    [0, 0],
    [0.001, 0],
  ]);
  const secondRoad = road("second", [
    [0, 0.001],
    [0.001, 0.001],
  ]);
  const firstPoint: LngLat = [0.0002, 0];
  const secondPoint: LngLat = [0.0008, 0.001];
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: firstPoint,
        candidate: candidate(0, firstRoad, firstPoint, 0.2, 90),
      },
      {
        observationIndex: 1,
        observation: secondPoint,
        candidate: candidate(1, secondRoad, secondPoint, 0.8, 90),
      },
    ],
    selectedRoads: [firstRoad, secondRoad],
    meanErrorMeters: 0,
  };

  const route = inferRoute(
    match,
    [firstRoad, secondRoad],
    selectedRoadFragments(match, true, 0),
  );

  assert.equal(route.transitions[0]?.resolved, false);
  assert.equal(route.edges.length, 0);
  assert.equal(route.geometry, null);
});

test("joins overlapping Protomaps pieces of the same named street", () => {
  const firstRoad = road("street-piece-a", [
    [0, 0],
    [0.001, 0],
  ]);
  const secondRoad = road("street-piece-b", [
    [0.0008, 0],
    [0.002, 0],
  ]);
  firstRoad.continuityKey = "residential:Shared Street";
  secondRoad.continuityKey = "residential:Shared Street";
  const firstPoint: LngLat = [0.0007, 0];
  const secondPoint: LngLat = [0.0013, 0];
  const match: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: firstPoint,
        candidate: candidate(0, firstRoad, firstPoint, 0.7, 90),
      },
      {
        observationIndex: 1,
        observation: secondPoint,
        candidate: candidate(1, secondRoad, secondPoint, 5 / 12, 90),
      },
    ],
    selectedRoads: [firstRoad, secondRoad],
    meanErrorMeters: 0,
  };

  const route = inferRoute(
    match,
    [firstRoad, secondRoad],
    selectedRoadFragments(match, true, 0),
  );

  assert.equal(route.transitions[0]?.resolved, true);
  assert.ok(route.distanceMeters > 60 && route.distanceMeters < 70);
  assert.equal(route.edges.length, 1);
});
