import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeKey } from "./terminal-keys.ts";

test("printable keys are themselves", () => {
  assert.equal(encodeKey({ key: "a" }), "a");
  assert.equal(encodeKey({ key: "A", shiftKey: true }), "A");
  assert.equal(encodeKey({ key: "/" }), "/");
  // `key` is the composed character, so non-Latin layouts need no special case.
  assert.equal(encodeKey({ key: "é" }), "é");
});

test("the keys a text UI navigates with have their sequences", () => {
  assert.equal(encodeKey({ key: "ArrowUp" }), "\x1b[A");
  assert.equal(encodeKey({ key: "ArrowDown" }), "\x1b[B");
  assert.equal(encodeKey({ key: "Enter" }), "\r");
  assert.equal(encodeKey({ key: "Escape" }), "\x1b");
  assert.equal(encodeKey({ key: "Backspace" }), "\x7f");
  assert.equal(encodeKey({ key: "Tab" }), "\t");
  assert.equal(encodeKey({ key: "Tab", shiftKey: true }), "\x1b[Z");
});

test("ctrl produces control codes", () => {
  assert.equal(encodeKey({ key: "c", ctrlKey: true }), "\x03");
  assert.equal(encodeKey({ key: "a", ctrlKey: true }), "\x01");
  assert.equal(encodeKey({ key: "D", ctrlKey: true }), "\x04");
});

test("alt prefixes with escape, as a terminal does", () => {
  assert.equal(encodeKey({ key: "b", altKey: true }), "\x1bb");
  assert.equal(encodeKey({ key: "ArrowLeft", altKey: true }), "\x1b\x1b[D");
});

test("what is not text produces nothing rather than a guess", () => {
  // A stray byte is indistinguishable from a keystroke to the component.
  assert.equal(encodeKey({ key: "F5" }), null);
  assert.equal(encodeKey({ key: "Shift" }), null);
  assert.equal(encodeKey({ key: "CapsLock" }), null);
  assert.equal(encodeKey({ key: "1", ctrlKey: true }), null);
  // Browser shortcuts belong to the browser.
  assert.equal(encodeKey({ key: "r", metaKey: true }), null);
});
