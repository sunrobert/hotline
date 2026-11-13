import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeE164 } from "../src/phone.ts";

test("normalizeE164 strips punctuation and keeps the leading plus", () => {
  assert.equal(normalizeE164("+1 (512) 555-0147"), "+15125550147");
  assert.equal(normalizeE164("+86 138 0013 8000"), "+8613800138000");
});

test("normalizeE164 assumes +1 for bare ten-digit and 1-prefixed eleven-digit US numbers", () => {
  assert.equal(normalizeE164("5125550147"), "+15125550147");
  assert.equal(normalizeE164("1-512-555-0147"), "+15125550147");
});

test("normalizeE164 returns null for anything that is not a phone number", () => {
  for (const junk of ["", "anonymous", "restricted", undefined, null, "+12", 42]) {
    assert.equal(normalizeE164(junk), null);
  }
});
