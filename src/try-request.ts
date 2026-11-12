import type { MapMatchRequest } from "./api-types";

export function parseTryRequest(value: string): MapMatchRequest {
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) {
    return { coordinates: parsed as MapMatchRequest["coordinates"] };
  }
  if (parsed && typeof parsed === "object" && "coordinates" in parsed) {
    return parsed as MapMatchRequest;
  }
  throw new Error("Use a coordinate array or a request object with a coordinates field.");
}

export function tryRequestFromSearch(search: string): MapMatchRequest | null {
  const params = new URLSearchParams(search);
  const request = params.get("request");
  if (request) return parseTryRequest(request);
  const coordinates = params.get("coordinates");
  if (coordinates) return parseTryRequest(coordinates);
  return null;
}

export function requestUrl(base: URL, request: MapMatchRequest): string {
  const url = new URL(base.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("coordinates", JSON.stringify(request.coordinates));
  return url.href;
}
