import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAuthStore, extractBearerToken } from "./auth-store.js";

test("auth rejects missing, invalid, and revoked device tokens", () => {
  const auth = new InMemoryAuthStore({ token: "user-token", userId: "u1" });
  assert.equal(auth.authenticateUser(undefined), null);
  assert.equal(auth.authenticateUser("bad"), null);
  assert.equal(auth.authenticateUser("user-token"), "u1");

  const { code } = auth.createPairingCode("u1");
  const issued = auth.exchangePairingCode(code, "MacBook");
  assert.equal(auth.authenticateDevice("bad"), null);
  assert.equal(auth.authenticateDevice(issued.deviceToken)?.runtimeId, issued.runtimeId);
  assert.equal(auth.revokeDeviceToken(issued.deviceToken), true);
  assert.equal(auth.authenticateDevice(issued.deviceToken), null);
});

test("pairing code is one-time use", () => {
  const auth = new InMemoryAuthStore({ token: "user-token", userId: "u1" });
  const { code } = auth.createPairingCode("u1");
  auth.exchangePairingCode(code);
  assert.throws(() => auth.exchangePairingCode(code), /invalid or expired/);
});

test("extractBearerToken parses bearer auth header", () => {
  assert.equal(extractBearerToken("Bearer abc"), "abc");
  assert.equal(extractBearerToken("bearer abc"), "abc");
  assert.equal(extractBearerToken("Basic abc"), undefined);
});
