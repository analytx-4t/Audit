import test from "node:test";
import assert from "node:assert/strict";
import { getLocalDate } from "./scheduler.js";

test("uses the configured default timezone for report calendar dates", () => {
  assert.equal(getLocalDate(new Date("2026-11-10T18:30:00.000Z")), "2026-11-11");
});
