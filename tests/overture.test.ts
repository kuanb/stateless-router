import assert from "node:assert/strict";
import test from "node:test";
import type { LngLat } from "../src/geo";
import type { MatchResult } from "../src/matcher";
import { inferOvertureRoute } from "../src/overture-router";
import { materializeOvertureRoads } from "../src/overture-source";
import type { RoadLine } from "../src/road-source";

test("splits an Overture segment into stable connector-to-connector roads", () => {
  const roads = materializeOvertureRoads(
    [
      {
        segmentId: "segment-1",
        coordinates: [[0, 0], [0.001, 0], [0.002, 0]],
        connectorReferences: [
          { connector_id: "c0", at: 0 },
          { connector_id: "c1", at: 0.5 },
          { connector_id: "c2", at: 1 },
        ],
        properties: {
          id: "segment-1",
          subtype: "road",
          class: "residential",
          access_restrictions: JSON.stringify([
            { access_type: "denied", when: { heading: "backward" } },
          ]),
        },
      },
    ],
    new Map<string, LngLat>([
      ["c0", [0, 0]],
      ["c1", [0.001, 0]],
      ["c2", [0.002, 0]],
    ]),
  );

  assert.equal(roads.length, 2);
  assert.equal(roads[0]?.id, "overture:segment-1:c0:c1");
  assert.equal(roads[1]?.id, "overture:segment-1:c1:c2");
  assert.equal(roads[0]?.topology?.segmentId, "segment-1");
  assert.equal(roads[0]?.topology?.forwardAllowed, true);
  assert.equal(roads[0]?.topology?.backwardAllowed, false);
  assert.equal(roads[0]?.properties.oneway, "yes");
});

function overtureRoad(
  id: string,
  start: LngLat,
  end: LngLat,
  startConnectorId: string,
  endConnectorId: string,
  forwardAllowed = true,
  backwardAllowed = true,
): RoadLine {
  return {
    id,
    continuityKey: id,
    coordinates: [start, end],
    properties: {
      kind: "minor_road",
      kind_detail: "residential",
      name: id,
      oneway: forwardAllowed && backwardAllowed ? null : forwardAllowed ? "yes" : "-1",
    },
    kind: "minor_road",
    kindDetail: "residential",
    topology: {
      network: "overture_transportation",
      segmentId: id,
      startConnectorId,
      endConnectorId,
      startConnectorStable: true,
      endConnectorStable: true,
      forwardAllowed,
      backwardAllowed,
      prohibitedTransitions: null,
    },
  };
}

function matched(
  observationIndex: number,
  road: RoadLine,
  point: LngLat,
  segmentT: number,
) {
  return {
    observationIndex,
    observation: point,
    candidate: {
      observationIndex,
      road,
      point,
      distance: 0,
      bearing: 90,
      segmentIndex: 1,
      segmentT,
      travelBearing: 90,
      onewayDirection: 0 as const,
      emissionCost: 0,
    },
  };
}

test("routes missing spans through shared Overture connector IDs", () => {
  const first = overtureRoad("first", [0, 0], [0.001, 0], "c0", "c1");
  const middle = overtureRoad("middle", [0.001, 0], [0.002, 0], "c1", "c2");
  const last = overtureRoad("last", [0.002, 0], [0.003, 0], "c2", "c3");
  const firstPoint: LngLat = [0.0005, 0];
  const lastPoint: LngLat = [0.0025, 0];
  const match: MatchResult = {
    matches: [
      matched(0, first, firstPoint, 0.5),
      matched(1, last, lastPoint, 0.5),
    ],
    selectedRoads: [first, last],
    meanErrorMeters: 0,
  };

  const route = inferOvertureRoute(match, [first, middle, last]);

  assert.equal(route.transitions[0]?.resolved, true);
  assert.equal(route.edges.length, 1);
  assert.deepEqual(route.edges[0]?.sourceRoadIds, ["middle"]);
  assert.equal(route.edges[0]?.startNodeId, "overture:connector:c1");
  assert.equal(route.edges[0]?.endNodeId, "overture:connector:c2");
  assert.equal(route.edges[0]?.confidence, "overture_topology");
});

test("does not route against an Overture directional access restriction", () => {
  const first = overtureRoad("first", [0, 0], [0.001, 0], "c0", "c1");
  const blocked = overtureRoad(
    "blocked",
    [0.001, 0],
    [0.002, 0],
    "c1",
    "c2",
    false,
    true,
  );
  const last = overtureRoad("last", [0.002, 0], [0.003, 0], "c2", "c3");
  const match: MatchResult = {
    matches: [
      matched(0, first, [0.0005, 0], 0.5),
      matched(1, last, [0.0025, 0], 0.5),
    ],
    selectedRoads: [first, last],
    meanErrorMeters: 0,
  };

  const route = inferOvertureRoute(match, [first, blocked, last]);

  assert.equal(route.transitions[0]?.resolved, false);
  assert.equal(route.edges.length, 0);
});
