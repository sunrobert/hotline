import { test } from "node:test";
import assert from "node:assert/strict";
import { soundsFor } from "../src/dashboard/sounds.js";

const row = (over: Record<string, unknown>) => ({ code: "H-AAAA", kind: "send", source: "voice", status: "submitted", decision: "AUTO", ...over });

test("the first look at the ledger plays nothing, so opening the dashboard never replays history", () => {
  assert.deepEqual(soundsFor(null, [row({ status: "complete" }), row({ code: "H-BBBB", status: "blocked" })]), []);
});

test("a send that completes plays the confirmation chime", () => {
  assert.deepEqual(soundsFor([row({ status: "submitted" })], [row({ status: "complete" })]), ["confirm"]);
});

test("a send that appears already complete between two refreshes still plays the chime", () => {
  assert.deepEqual(soundsFor([], [row({ status: "complete" })]), ["confirm"]);
});

test("a send that was already complete does not chime again", () => {
  assert.deepEqual(soundsFor([row({ status: "complete" })], [row({ status: "complete" })]), []);
});

test("a new blocked send plays the blocked sound", () => {
  assert.deepEqual(soundsFor([], [row({ status: "blocked", decision: "BLOCK" })]), ["blocked"]);
});

test("a new approval waiting on a deposit plays the intro, because the agent is about to ring the owner", () => {
  assert.deepEqual(soundsFor([], [row({ source: "stream", status: "pending", decision: "CALL" })]), ["intro"]);
});

test("an approval the owner asked for by voice does not play the intro; they are already on the call", () => {
  assert.deepEqual(soundsFor([], [row({ source: "voice", status: "pending", decision: "CALL" })]), []);
});

test("quiet bookkeeping makes no sound: observed deposits, cancellations, failures", () => {
  const next = [
    row({ code: "H-1", kind: "deposit", status: "observed", decision: "observed" }),
    row({ code: "H-2", status: "cancelled" }),
    row({ code: "H-3", status: "failed" }),
  ];
  assert.deepEqual(soundsFor([], next), []);
});

test("several events at once play each sound only once, intro first", () => {
  const next = [
    row({ code: "H-1", status: "complete" }), row({ code: "H-2", status: "complete" }),
    row({ code: "H-3", status: "blocked" }), row({ code: "H-4", source: "stream", status: "pending" }),
  ];
  assert.deepEqual(soundsFor([], next), ["intro", "blocked", "confirm"]);
});
