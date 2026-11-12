import assert from "node:assert/strict";
import test from "node:test";
import { roadLineId } from "../src/road-source";

test("keeps repeated source feature IDs unique within a vector tile", () => {
  const first = roadLineId("15/5254/12662", "35184567693610", 17, 0);
  const second = roadLineId("15/5254/12662", "35184567693610", 18, 0);

  assert.notEqual(first, second);
  assert.equal(
    first,
    roadLineId("15/5254/12662", "35184567693610", 17, 0),
  );
});
