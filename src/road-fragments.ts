import { distanceMeters, type LngLat } from "./geo";
import type { Candidate, MatchResult } from "./matcher";
import type { RoadLine } from "./road-source";

export interface RoadFragment {
  road: RoadLine;
  coordinates: LngLat[];
}

interface LocatedPoint {
  point: LngLat;
  segmentIndex: number;
}

function cumulativeDistances(coordinates: LngLat[]): number[] {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    distances.push(
      (distances[index - 1] ?? 0) +
        (previous && current ? distanceMeters(previous, current) : 0),
    );
  }
  return distances;
}

function candidateDistance(
  candidate: Candidate,
  cumulative: number[],
  coordinates: LngLat[],
): number {
  const startIndex = Math.max(0, candidate.segmentIndex - 1);
  const startDistance = cumulative[startIndex] ?? 0;
  const start = coordinates[startIndex];
  const end = coordinates[candidate.segmentIndex];
  const segmentLength = start && end ? distanceMeters(start, end) : 0;
  return startDistance + segmentLength * candidate.segmentT;
}

function pointAtDistance(
  coordinates: LngLat[],
  cumulative: number[],
  target: number,
): LocatedPoint {
  for (let segmentIndex = 1; segmentIndex < coordinates.length; segmentIndex += 1) {
    const segmentEnd = cumulative[segmentIndex] ?? 0;
    if (target > segmentEnd && segmentIndex < coordinates.length - 1) continue;
    const start = coordinates[segmentIndex - 1] ?? coordinates[0] ?? [0, 0];
    const end = coordinates[segmentIndex] ?? start;
    const segmentStart = cumulative[segmentIndex - 1] ?? 0;
    const length = Math.max(0.000001, segmentEnd - segmentStart);
    const t = Math.max(0, Math.min(1, (target - segmentStart) / length));
    return {
      point: [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ],
      segmentIndex,
    };
  }

  const lastIndex = Math.max(0, coordinates.length - 1);
  return {
    point: coordinates[lastIndex] ?? [0, 0],
    segmentIndex: lastIndex,
  };
}

function sliceLine(
  coordinates: LngLat[],
  cumulative: number[],
  startDistance: number,
  endDistance: number,
): LngLat[] {
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
    return !previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1];
  });
}

export function selectedRoadFragments(
  match: MatchResult,
  trim: boolean,
  paddingMeters = 32,
): RoadFragment[] {
  if (!trim) {
    return match.selectedRoads.map((road) => ({ road, coordinates: road.coordinates }));
  }

  const candidatesByRoad = new Map<string, Candidate[]>();
  for (const matched of match.matches) {
    if (!matched) continue;
    const candidates = candidatesByRoad.get(matched.candidate.road.id) ?? [];
    candidates.push(matched.candidate);
    candidatesByRoad.set(matched.candidate.road.id, candidates);
  }

  const fragments: RoadFragment[] = [];
  for (const road of match.selectedRoads) {
    const candidates = candidatesByRoad.get(road.id) ?? [];
    if (candidates.length === 0 || road.coordinates.length < 2) continue;
    const cumulative = cumulativeDistances(road.coordinates);
    const totalLength = cumulative[cumulative.length - 1] ?? 0;
    const positions = candidates.map((candidate) =>
      candidateDistance(candidate, cumulative, road.coordinates),
    );
    // A one-probe road still needs two coordinates to be a valid LineString,
    // but keep that fallback sub-metre instead of drawing a visible overshoot.
    const effectivePadding =
      positions.length === 1 ? Math.max(paddingMeters, 0.5) : paddingMeters;
    const start = Math.max(0, Math.min(...positions) - effectivePadding);
    const end = Math.min(totalLength, Math.max(...positions) + effectivePadding);
    const coordinates = sliceLine(road.coordinates, cumulative, start, end);
    if (coordinates.length >= 2) fragments.push({ road, coordinates });
  }

  return fragments;
}
