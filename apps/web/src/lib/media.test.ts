import assert from "node:assert/strict";
import { test } from "node:test";
import { isEditing, keyboardInset } from "./media.ts";

/** iOS Safari, portrait: the bottom toolbar takes this much and no more. */
const IOS_TOOLBAR = 113;
const IOS_KEYBOARD = 336;

test("a browser toolbar is not a keyboard", () => {
  // The bug this exists for: the strip Safari's bottom bar occupies looks
  // exactly like an occluded viewport, and treating it as one left a gap that
  // size under the composer for as long as the page was open.
  assert.equal(
    keyboardInset({ innerHeight: 852, viewportHeight: 852 - IOS_TOOLBAR, offsetTop: 0, editing: false }),
    0,
  );
});

test("nor is it one while a field happens to be focused", () => {
  // An iPad with a hardware keyboard: focused, typing, no software keyboard.
  assert.equal(keyboardInset({ innerHeight: 852, viewportHeight: 852 - IOS_TOOLBAR, offsetTop: 0, editing: true }), 0);
});

test("a keyboard under a focused field is the inset", () => {
  assert.equal(
    keyboardInset({ innerHeight: 852, viewportHeight: 852 - IOS_KEYBOARD, offsetTop: 0, editing: true }),
    IOS_KEYBOARD,
  );
});

test("scrolling the visual viewport does not inflate it", () => {
  // Pinched or scrolled, offsetTop accounts for the part above the fold.
  assert.equal(
    keyboardInset({ innerHeight: 852, viewportHeight: 852 - IOS_KEYBOARD, offsetTop: 40, editing: true }),
    IOS_KEYBOARD - 40,
  );
});

test("a keyboard with nothing focused is nothing to sit above", () => {
  assert.equal(keyboardInset({ innerHeight: 852, viewportHeight: 516, offsetTop: 0, editing: false }), 0);
});

test("a viewport taller than the window never reads as negative", () => {
  assert.equal(keyboardInset({ innerHeight: 800, viewportHeight: 900, offsetTop: 0, editing: true }), 0);
});

test("the fields a keyboard opens for", () => {
  assert.equal(isEditing({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditing({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isEditing({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isEditing({ tagName: "DIV", isContentEditable: true }), true);
});

test("and the ones it does not", () => {
  assert.equal(isEditing(null), false);
  assert.equal(isEditing({ tagName: "BODY" }), false);
  assert.equal(isEditing({ tagName: "BUTTON" }), false);
  assert.equal(isEditing({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isEditing({ tagName: "INPUT", type: "range" }), false);
});
