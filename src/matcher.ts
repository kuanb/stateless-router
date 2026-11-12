import {
  bearingDifference,
  bearingDegrees,
  distanceMeters,
  projectOntoSegment,
  type LngLat,
} from "./geo";
import type { RoadLine } from "./road-source";

export interface MatchOptions {
  radiusMeters: number;
  candidateCount: number;
  sequenceAware: boolean;
}

export interface Candidate {
  observationIndex: number;
  road: RoadLine;
  point: LngLat;
  distance: number;
  bearing: number;
  segmentIndex: number;
  segmentT: number;
  travelBearing: number;
  onewayDirection: -1 | 0 | 1;
  emissionCost: number;
}

export interface MatchedObservation {
  observationIndex: number;
  observation: LngLat;
  candidate: Candidate;
}

export interface MatchResult {
  matches: (MatchedObservation | null)[];
  selectedRoads: RoadLine[];
  meanErrorMeters: number;
}

function observationBearing(points: LngLat[], index: number): number {
  const current = points[index];
  if (!current) return 0;
  if (index === 0) return bearingDegrees(current, points[1] ?? current);
  if (index === points.length - 1) return bearingDegrees(points[index - 1] ?? current, current);
  return bearingDegrees(points[index - 1] ?? current, points[index + 1] ?? current);
}

function onewayDirection(road: RoadLine): -1 | 0 | 1 {
  const value = String(road.properties.oneway ?? "").toLowerCase();
  if (value === "-1" || value === "reverse") return -1;
  if (["yes", "1", "true"].includes(value)) return 1;
  return 0;
}

function travelBearingForCandidate(
  geometryBearing: number,
  observationHeading: number,
  direction: -1 | 0 | 1,
): number {
  if (direction === 1) return geometryBearing;
  if (direction === -1) return (geometryBearing + 180) % 360;

  const reverse = (geometryBearing + 180) % 360;
  return bearingDifference(geometryBearing, observationHeading) <=
    bearingDifference(reverse, observationHeading)
    ? geometryBearing
    : reverse;
}

function candidatesForObservation(
  observation: LngLat,
  observationIndex: number,
  heading: number,
  roads: RoadLine[],
  options: MatchOptions,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const road of roads) {
    let best: Candidate | null = null;
    for (let segmentIndex = 1; segmentIndex < road.coordinates.length; segmentIndex += 1) {
      const start = road.coordinates[segmentIndex - 1];
      const end = road.coordinates[segmentIndex];
      if (!start || !end) continue;
      const projection = projectOntoSegment(observation, start, end);
      if (projection.distance > options.radiusMeters) continue;

      const direction = onewayDirection(road);
      const travelBearing = travelBearingForCandidate(
        projection.bearing,
        heading,
        direction,
      );
      const headingDifference = bearingDifference(travelBearing, heading);
      const distanceCost = (projection.distance / Math.max(12, options.radiusMeters * 0.45)) ** 2;
      const headingCost = (headingDifference / 50) ** 2 * 1.15;
      const accessCost = road.properties.access === "private" ? 0.35 : 0;
      const candidate: Candidate = {
        observationIndex,
        road,
        point: projection.point,
        distance: projection.distance,
        bearing: projection.bearing,
        segmentIndex,
        segmentT: projection.t,
        travelBearing,
        onewayDirection: direction,
        emissionCost: distanceCost + headingCost + accessCost,
      };

      if (!best || candidate.emissionCost < best.emissionCost) best = candidate;
    }
    if (best) candidates.push(best);
  }

  return candidates
    .sort((a, b) => a.emissionCost - b.emissionCost)
    .slice(0, options.candidateCount);
}

function transitionCost(
  previous: Candidate,
  current: Candidate,
  previousObservation: LngLat,
  currentObservation: LngLat,
): number {
  const observedStep = distanceMeters(previousObservation, currentObservation);
  const matchedStep = distanceMeters(previous.point, current.point);
  const normalizedStretch =
    Math.abs(matchedStep - observedStep) / Math.max(25, observedStep);
  const roadSwitch = previous.road.continuityKey === current.road.continuityKey ? 0 : 0.55;
  const implausibleJump = matchedStep > observedStep * 2.6 + 90 ? 5 : 0;
  const snappedMotionBearing = bearingDegrees(previous.point, current.point);
  const departureMismatch = bearingDifference(
    previous.travelBearing,
    snappedMotionBearing,
  );
  const arrivalMismatch = bearingDifference(
    current.travelBearing,
    snappedMotionBearing,
  );
  const directionPenalty =
    matchedStep < 8
      ? 0
      : ((departureMismatch / 70) ** 2 + (arrivalMismatch / 70) ** 2) * 0.7;
  const wrongWayUTurn =
    matchedStep >= 8 &&
    ((previous.onewayDirection !== 0 && departureMismatch > 120) ||
      (current.onewayDirection !== 0 && arrivalMismatch > 120))
      ? 8
      : 0;

  return (
    normalizedStretch * 1.7 +
    roadSwitch +
    implausibleJump +
    directionPenalty +
    wrongWayUTurn
  );
}

function solveBlock(
  points: LngLat[],
  candidateSets: Candidate[][],
  start: number,
  end: number,
  sequenceAware: boolean,
): Candidate[] {
  if (!sequenceAware) {
    return candidateSets.slice(start, end).map((set) => set[0]).filter(Boolean) as Candidate[];
  }

  const costs: number[][] = [];
  const backPointers: number[][] = [];
  const firstSet = candidateSets[start] ?? [];
  costs.push(firstSet.map((candidate) => candidate.emissionCost));
  backPointers.push(firstSet.map(() => -1));

  for (let pointIndex = start + 1; pointIndex < end; pointIndex += 1) {
    const currentSet = candidateSets[pointIndex] ?? [];
    const previousSet = candidateSets[pointIndex - 1] ?? [];
    const previousCosts = costs[costs.length - 1] ?? [];
    const rowCosts: number[] = [];
    const rowPointers: number[] = [];

    currentSet.forEach((candidate) => {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestIndex = 0;
      previousSet.forEach((previous, previousIndex) => {
        const total =
          (previousCosts[previousIndex] ?? Number.POSITIVE_INFINITY) +
          transitionCost(
            previous,
            candidate,
            points[pointIndex - 1] ?? previous.point,
            points[pointIndex] ?? candidate.point,
          ) +
          candidate.emissionCost;
        if (total < bestCost) {
          bestCost = total;
          bestIndex = previousIndex;
        }
      });
      rowCosts.push(bestCost);
      rowPointers.push(bestIndex);
    });

    costs.push(rowCosts);
    backPointers.push(rowPointers);
  }

  const finalCosts = costs[costs.length - 1] ?? [];
  let cursor = finalCosts.reduce(
    (best, cost, index) => (cost < (finalCosts[best] ?? Number.POSITIVE_INFINITY) ? index : best),
    0,
  );
  const chosen: Candidate[] = [];

  for (let row = costs.length - 1; row >= 0; row -= 1) {
    const set = candidateSets[start + row] ?? [];
    const candidate = set[cursor];
    if (candidate) chosen.push(candidate);
    cursor = backPointers[row]?.[cursor] ?? 0;
  }

  return chosen.reverse();
}

export function matchTrace(
  points: LngLat[],
  roads: RoadLine[],
  options: MatchOptions,
): MatchResult {
  const candidateSets = points.map((point, index) =>
    candidatesForObservation(
      point,
      index,
      observationBearing(points, index),
      roads,
      options,
    ),
  );

  const chosenByIndex = new Map<number, Candidate>();
  let blockStart = 0;
  while (blockStart < candidateSets.length) {
    while (blockStart < candidateSets.length && (candidateSets[blockStart]?.length ?? 0) === 0) {
      blockStart += 1;
    }
    if (blockStart >= candidateSets.length) break;
    let blockEnd = blockStart + 1;
    while (blockEnd < candidateSets.length && (candidateSets[blockEnd]?.length ?? 0) > 0) {
      blockEnd += 1;
    }
    for (const candidate of solveBlock(
      points,
      candidateSets,
      blockStart,
      blockEnd,
      options.sequenceAware,
    )) {
      chosenByIndex.set(candidate.observationIndex, candidate);
    }
    blockStart = blockEnd + 1;
  }

  const matches = points.map((observation, observationIndex) => {
    const candidate = chosenByIndex.get(observationIndex);
    return candidate ? { observationIndex, observation, candidate } : null;
  });
  const successful = matches.filter((match): match is MatchedObservation => match !== null);
  const uniqueRoads = new Map<string, RoadLine>();
  successful.forEach((match) => uniqueRoads.set(match.candidate.road.id, match.candidate.road));

  return {
    matches,
    selectedRoads: [...uniqueRoads.values()],
    meanErrorMeters:
      successful.length === 0
        ? 0
        : successful.reduce((sum, match) => sum + match.candidate.distance, 0) /
          successful.length,
  };
}
