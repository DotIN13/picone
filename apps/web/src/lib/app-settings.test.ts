import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_ZOOM, MOBILE_BASE_ZOOM, SCALES, scaleAtMost } from "./app-settings.ts";

/** What a stored scale becomes when a baseline is folded into it. */
const rebase = (scale: number, divisor: number) => scaleAtMost(scale / divisor);

test("the phone rebase leaves 90% looking exactly as it did, called 100%", () => {
  // The point of the change: what needed choosing 90% is what 100% gives.
  assert.equal(rebase(0.9, MOBILE_BASE_ZOOM), 1);
  assert.equal(0.9 * BASE_ZOOM, 1 * BASE_ZOOM * MOBILE_BASE_ZOOM);
});

test("a rebase never makes the interface larger than it was", () => {
  // Nearest would send 100% to 115% here — the ladder's steps are uneven, and
  // an interface asked to get smaller would have grown instead.
  for (const { value } of SCALES) {
    const before = value * BASE_ZOOM;
    const after = rebase(value, MOBILE_BASE_ZOOM) * BASE_ZOOM * MOBILE_BASE_ZOOM;
    assert.ok(after <= before + 1e-9, `${value}: ${after} > ${before}`);
  }
});

test("a phone left at the default simply gets the new, smaller default", () => {
  assert.equal(rebase(1, MOBILE_BASE_ZOOM), 1);
});

test("the result is always a scale the picker can highlight", () => {
  const offered = SCALES.map((s) => s.value);
  for (const { value } of SCALES) {
    assert.ok(offered.includes(rebase(value, MOBILE_BASE_ZOOM)));
    assert.ok(offered.includes(rebase(value, BASE_ZOOM * MOBILE_BASE_ZOOM)));
  }
});

test("below the smallest offered scale it stops at the smallest", () => {
  assert.equal(scaleAtMost(0.1), SCALES[0]!.value);
});

test("an exact preset is left alone", () => {
  for (const { value } of SCALES) assert.equal(scaleAtMost(value), value);
});
