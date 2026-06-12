// gsd-pi - Write-gate two-process seam tests.
/**
 * Deterministic interleaving tests for the host/child write-gate adapters
 * (write-gate.ts). The "child" (workflow MCP server) runs in a separate
 * process in production; these tests simulate its writes by stamping the
 * snapshot file directly, exactly as childWriteGateAdapter persists it.
 *
 * Covered interleavings:
 *   (a) child verifies on disk while the host holds stale memory — the host
 *       re-arm must NOT clobber the verification, on BOTH windows
 *       (tool_execution_start re-arm and the tool_call defer path);
 *   (b) epoch conflict: host observed epoch N, child persists N+1, the host's
 *       next persist re-merges instead of overwriting;
 *   (c) two basePaths defer approval gates in the same process — both stay
 *       deferred and both activate (regression for the old single global slot);
 *   (d) old snapshot files without epoch/writer fields keep loading.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  childWriteGateAdapter,
  clearDiscussionFlowState,
  getPendingGate,
  hostWriteGateAdapter,
  loadWriteGateSnapshot,
  markDepthVerified,
  refreshWriteGateStateFromDisk,
  setPendingGate,
  type WriteGateSnapshot,
} from "../bootstrap/write-gate.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-write-gate-seam-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function snapshotPath(basePath: string): string {
  return join(basePath, ".gsd", "runtime", "write-gate-state.json");
}

/** Simulate a write from the OTHER process by stamping the file directly. */
function foreignProcessWrites(basePath: string, snapshot: Partial<WriteGateSnapshot>): void {
  mkdirSync(join(basePath, ".gsd", "runtime"), { recursive: true });
  writeFileSync(snapshotPath(basePath), JSON.stringify({
    verifiedDepthMilestones: [],
    verifiedApprovalGates: [],
    activeQueuePhase: false,
    pendingGateId: null,
    ...snapshot,
  }, null, 2), "utf-8");
}

function readDiskRaw(basePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(snapshotPath(basePath), "utf-8"));
}

function makeHookHarness(): {
  handlers: Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>;
  pi: any;
} {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => Promise<any> | any>>();
  const pi = {
    on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;
  return { handlers, pi };
}

function cleanup(dir: string): void {
  clearDiscussionFlowState(dir);
  rmSync(dir, { recursive: true, force: true });
}

const GATE = "depth_verification_M007_confirm";

// ── (a) verified-on-disk wins over a host re-arm ────────────────────────────

test("seam: host setPending does not clobber a child verification on disk", (t) => {
  const dir = makeTempDir("no-clobber-adapter");
  t.after(() => cleanup(dir));

  // Host has stale memory: it armed the gate earlier (epoch 1 on disk).
  assert.equal(setPendingGate(GATE, dir), undefined);
  assert.equal(getPendingGate(dir), GATE);

  // Child verifies the gate in its own process (higher epoch on disk).
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    epoch: 5,
    writer: "child",
  });

  // Host attempts a re-arm — adapter policy: verified on disk wins.
  assert.equal(hostWriteGateAdapter.setPending(GATE, dir), false, "re-arm must be suppressed");
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(snapshot.verifiedDepthMilestones.includes("M007"), "verification must survive");
  assert.ok((snapshot.verifiedApprovalGates ?? []).includes(GATE));
  assert.equal(getPendingGate(dir), null, "no pending gate after suppressed re-arm");
});

test("seam: tool_call defer path does not block tools for a gate the child verified", async (t) => {
  const dir = makeTempDir("no-clobber-defer");
  t.after(() => cleanup(dir));

  // Child verified the gate before the host ever saw the tool block.
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    epoch: 3,
    writer: "child",
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  // tool_call defer window: ask_user_questions arrives post-hoc with the gate id.
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "ask_user_questions",
      input: { questions: [{ id: GATE }] },
    }, ctx);
  }

  // A subsequent tool in the same turn must NOT hit the deferred-gate block.
  let blocked: any;
  for (const handler of handlers.get("tool_call") ?? []) {
    const result = await handler({
      toolCallId: "t-next",
      toolName: "glob",
      input: { pattern: "*.md" },
    }, ctx);
    if (result?.block) blocked = result;
  }
  assert.equal(blocked, undefined, "verified gate must not be deferred/blocking");
  assert.equal(getPendingGate(dir), null);
  const snapshot = loadWriteGateSnapshot(dir);
  assert.ok(snapshot.verifiedDepthMilestones.includes("M007"), "verification must survive the defer window");
});

test("seam: tool_execution_start re-arm window keeps the child verification", async (t) => {
  const dir = makeTempDir("no-clobber-exec-start");
  t.after(() => cleanup(dir));

  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M007"],
    verifiedApprovalGates: [GATE],
    epoch: 4,
    writer: "child",
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const ctx = { cwd: dir, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_execution_start") ?? []) {
    await handler({
      toolCallId: "t-gate",
      toolName: "mcp__gsd-workflow__ask_user_questions",
      args: { questions: [{ id: GATE }] },
    }, ctx);
  }

  assert.equal(getPendingGate(dir), null, "post-hoc replay must not re-arm a verified gate");
  assert.ok(loadWriteGateSnapshot(dir).verifiedDepthMilestones.includes("M007"));
});

// ── (b) epoch conflict re-merges instead of overwriting ─────────────────────

test("seam: host persist re-merges when the child advanced the epoch", (t) => {
  const dir = makeTempDir("epoch-conflict");
  t.after(() => cleanup(dir));

  // Host observes epoch 1 (its own write).
  markDepthVerified("M001", dir);
  const observed = loadWriteGateSnapshot(dir);
  assert.equal(observed.epoch, 1);

  // Child persists epoch 2 with a different verification while the host is idle.
  foreignProcessWrites(dir, {
    verifiedDepthMilestones: ["M002"],
    epoch: 2,
    writer: "child",
  });

  // Host persists again — must union, not overwrite, and bump past disk.
  markDepthVerified("M003", dir);
  const merged = loadWriteGateSnapshot(dir);
  assert.deepEqual(merged.verifiedDepthMilestones, ["M001", "M002", "M003"]);
  assert.equal(merged.epoch, 3, "epoch must advance past the conflicting disk write");
  assert.equal(readDiskRaw(dir).writer, "host");
});

test("seam: childWriteGateAdapter is write-through and epoch-stamps", (t) => {
  const dir = makeTempDir("child-write-through");
  t.after(() => cleanup(dir));

  foreignProcessWrites(dir, { verifiedDepthMilestones: ["M001"], epoch: 7, writer: "host" });
  childWriteGateAdapter.markDepthVerified("M002", dir);

  const disk = readDiskRaw(dir);
  assert.deepEqual(disk.verifiedDepthMilestones, ["M001", "M002"], "fresh disk read, then mutate");
  assert.equal(disk.epoch, 8);
  assert.equal(disk.writer, "child");
});

// ── (c) per-basePath deferred gates ──────────────────────────────────────────

test("seam: two basePaths defer gates in one process and both activate", async (t) => {
  const dirA = makeTempDir("defer-a");
  const dirB = makeTempDir("defer-b");
  t.after(() => {
    cleanup(dirA);
    cleanup(dirB);
  });

  const { handlers, pi } = makeHookHarness();
  registerHooks(pi, []);
  const gateA = "depth_verification_M010_confirm";
  const gateB = "depth_verification_M020_confirm";
  const ctxA = { cwd: dirA, ui: { notify: () => undefined } } as any;
  const ctxB = { cwd: dirB, ui: { notify: () => undefined } } as any;

  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "a-1", toolName: "ask_user_questions", input: { questions: [{ id: gateA }] } }, ctxA);
  }
  for (const handler of handlers.get("tool_call") ?? []) {
    await handler({ toolCallId: "b-1", toolName: "ask_user_questions", input: { questions: [{ id: gateB }] } }, ctxB);
  }

  // With the old single global slot, project A's deferral was lost the moment
  // project B deferred. Both must still block follow-up tools.
  for (const [ctx, label] of [[ctxA, "A"], [ctxB, "B"]] as const) {
    let blocked: any;
    for (const handler of handlers.get("tool_call") ?? []) {
      const result = await handler({ toolCallId: `chk-${label}`, toolName: "glob", input: { pattern: "*" } }, ctx);
      if (result?.block) blocked = result;
    }
    assert.equal(blocked?.block, true, `project ${label} deferred gate must still block`);
    assert.match(blocked?.reason ?? "", /Approval question/);
  }

  // Activation happens via tool_execution_start in each project independently.
  for (const [ctx, gate, dir] of [[ctxA, gateA, dirA], [ctxB, gateB, dirB]] as const) {
    for (const handler of handlers.get("tool_execution_start") ?? []) {
      await handler({ toolCallId: "act", toolName: "ask_user_questions", args: { questions: [{ id: gate }] } }, ctx);
    }
    assert.equal(getPendingGate(dir), gate, `gate must arm durably for ${dir}`);
  }
});

// ── (d) backward compatibility: snapshots without epoch ─────────────────────

test("seam: old snapshot without epoch/writer loads as epoch 0 and upgrades on write", (t) => {
  const dir = makeTempDir("legacy-snapshot");
  t.after(() => cleanup(dir));

  writeFileSync(
    (mkdirSync(join(dir, ".gsd", "runtime"), { recursive: true }), snapshotPath(dir)),
    JSON.stringify({
      verifiedDepthMilestones: ["M001"],
      verifiedApprovalGates: ["depth_verification_M001_confirm"],
      activeQueuePhase: false,
      pendingGateId: null,
    }),
    "utf-8",
  );

  const loaded = loadWriteGateSnapshot(dir);
  assert.equal(loaded.epoch, 0, "missing epoch reads as 0");
  assert.deepEqual(loaded.verifiedDepthMilestones, ["M001"]);

  const refreshed = refreshWriteGateStateFromDisk(dir);
  assert.ok(refreshed.verifiedDepthMilestones.includes("M001"));

  markDepthVerified("M002", dir);
  const upgraded = readDiskRaw(dir);
  assert.equal(upgraded.epoch, 1, "first epoch-aware write stamps epoch 1");
  assert.deepEqual(upgraded.verifiedDepthMilestones, ["M001", "M002"]);
});
