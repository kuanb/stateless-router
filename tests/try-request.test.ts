import assert from "node:assert/strict";
import test from "node:test";
import { parseTryRequest, requestUrl, tryRequestFromSearch } from "../src/try-request";

test("accepts a bare coordinate array for the try-it page", () => {
  const request = parseTryRequest("[[-122.27,37.8],[-122.26,37.81]]");
  assert.deepEqual(request.coordinates, [
    [-122.27, 37.8],
    [-122.26, 37.81],
  ]);
});

test("reads and writes the shareable coordinates query parameter", () => {
  const url = requestUrl(
    new URL("https://example.com/run-map-match/?old=true#fragment"),
    { coordinates: [[-122.27, 37.8], [-122.26, 37.81]] },
  );
  const parsedUrl = new URL(url);
  const request = tryRequestFromSearch(parsedUrl.search);

  assert.equal(parsedUrl.hash, "");
  assert.equal(parsedUrl.searchParams.has("old"), false);
  assert.deepEqual(request?.coordinates, [
    [-122.27, 37.8],
    [-122.26, 37.81],
  ]);
});

test("rejects JSON that does not contain coordinates", () => {
  assert.throws(() => parseTryRequest('{"hello":"world"}'), /coordinates field/);
});
