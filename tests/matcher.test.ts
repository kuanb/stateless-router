import assert from "node:assert/strict";
import test from "node:test";
import { distanceMeters, type LngLat } from "../src/geo";
import { matchTrace, type MatchResult } from "../src/matcher";
import { selectedRoadFragments } from "../src/road-fragments";
import type { RoadLine } from "../src/road-source";

function road(
  id: string,
  coordinates: LngLat[],
  oneway: string,
): RoadLine {
  return {
    id,
    continuityKey: "primary:Test Boulevard",
    coordinates,
    properties: {
      kind: "major_road",
      kind_detail: "primary",
      name: "Test Boulevard",
      oneway,
    },
    kind: "major_road",
    kindDetail: "primary",
  };
}

test("keeps the first probe on the carriageway matching trace direction", () => {
  const eastbound = road(
    "eastbound",
    [
      [0, 0],
      [0.01, 0],
    ],
    "yes",
  );
  const westbound = road(
    "westbound",
    [
      [0.01, 0.00027],
      [0, 0.00027],
    ],
    "yes",
  );
  const probes: LngLat[] = [
    [0.001, 0.00026],
    [0.003, 0.00002],
    [0.005, 0.00001],
    [0.007, 0.00002],
  ];

  const result = matchTrace(probes, [westbound, eastbound], {
    radiusMeters: 70,
    candidateCount: 4,
    sequenceAware: true,
  });

  assert.deepEqual(
    result.matches.map((match) => match?.candidate.road.id),
    ["eastbound", "eastbound", "eastbound", "eastbound"],
  );
});

test("respects reverse one-way geometry", () => {
  const legalWestbound = road(
    "reverse-oneway",
    [
      [0, 0],
      [0.01, 0],
    ],
    "-1",
  );
  const probes: LngLat[] = [
    [0.008, 0.00001],
    [0.006, -0.00001],
    [0.004, 0.00001],
  ];

  const result = matchTrace(probes, [legalWestbound], {
    radiusMeters: 50,
    candidateCount: 2,
    sequenceAware: true,
  });

  assert.equal(result.matches.every((match) => match?.candidate.road.id === "reverse-oneway"), true);
  assert.equal(result.matches[0]?.candidate.travelBearing, 270);
});

test("trims selected road overlays around the matched positions", () => {
  const selected = road(
    "long-road",
    [
      [0, 0],
      [0.005, 0],
      [0.01, 0],
    ],
    "",
  );
  const result: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: [0.005, 0],
        candidate: {
          observationIndex: 0,
          road: selected,
          point: [0.005, 0],
          distance: 0,
          bearing: 90,
          segmentIndex: 1,
          segmentT: 1,
          travelBearing: 90,
          onewayDirection: 0,
          emissionCost: 0,
        },
      },
    ],
    selectedRoads: [selected],
    meanErrorMeters: 0,
  };

  const [trimmed] = selectedRoadFragments(result, true, 32);
  const [untrimmed] = selectedRoadFragments(result, false, 32);

  assert.ok(trimmed);
  assert.ok(untrimmed);
  assert.equal(untrimmed.coordinates[0]?.[0], 0);
  assert.equal(untrimmed.coordinates.at(-1)?.[0], 0.01);
  assert.ok((trimmed.coordinates[0]?.[0] ?? 0) > 0.004);
  assert.ok((trimmed.coordinates.at(-1)?.[0] ?? 1) < 0.006);
});

test("keeps a zero-padding single-probe fragment visually degenerate", () => {
  const selected = road(
    "single-probe-road",
    [
      [0, 0],
      [0.01, 0],
    ],
    "",
  );
  const result: MatchResult = {
    matches: [
      {
        observationIndex: 0,
        observation: [0.005, 0],
        candidate: {
          observationIndex: 0,
          road: selected,
          point: [0.005, 0],
          distance: 0,
          bearing: 90,
          segmentIndex: 1,
          segmentT: 0.5,
          travelBearing: 90,
          onewayDirection: 0,
          emissionCost: 0,
        },
      },
    ],
    selectedRoads: [selected],
    meanErrorMeters: 0,
  };

  const [fragment] = selectedRoadFragments(result, true, 0);
  assert.ok(fragment);
  assert.ok(distanceMeters(fragment.coordinates[0]!, fragment.coordinates.at(-1)!) < 1.1);
});
