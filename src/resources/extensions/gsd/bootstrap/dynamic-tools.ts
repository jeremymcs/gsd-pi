// Project/App: gsd-pi
// File Purpose: Registers workspace-aware dynamic filesystem and shell tools.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import { openWorkflowDatabase } from "../db-workspace.js";
import { getAutoWorktreePath } from "../auto-worktree.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { worktreesDirs } from "../worktree-placement.js";

export function safeWorkspaceCwd(): string {
  try {
    return process.cwd();
  } catch {
    const projectRoot = process.env.GSD_PROJECT_ROOT;
    if (projectRoot && existsSync(projectRoot)) return projectRoot;
    return homedir();
  }
}

export function resolveCtxCwd(ctx?: unknown): string {
  if (ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string") {
    const cwd = (ctx as { cwd: string }).cwd;
    if (existsSync(cwd)) return cwd;
  }
  return safeWorkspaceCwd();
}

/**
 * Base path for workflow MCP tools. Mirrors packages/mcp-server parseWorkflowArgs:
 * route writes to `<project>/.gsd/worktrees/<milestoneId>/` when that worktree exists.
 */
export function resolveWorkflowToolBasePath(
  ctx?: unknown,
  scope?: { milestone_id?: string },
): string {
  const cwd = resolveCtxCwd(ctx);
  const projectRoot = resolveWorktreeProjectRoot(cwd);
  const milestoneId = scope?.milestone_id?.trim();
  if (milestoneId) {
    const worktree = getAutoWorktreePath(projectRoot, milestoneId);
    if (worktree) return worktree;
  } else {
    const live: string[] = [];
    for (const worktreesDir of worktreesDirs(projectRoot)) {
      if (!existsSync(worktreesDir)) continue;
      try {
        live.push(
          ...readdirSync(worktreesDir)
            .map((name) => join(worktreesDir, name))
            .filter((p) => existsSync(join(p, ".git"))),
        );
      } catch (err) {
        logWarning(
          "bootstrap",
          `resolveWorkflowToolBasePath: failed to scan worktrees: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (live.length === 1) return live[0]!;
  }
  return cwd;
}

export { resolveProjectRootDbPath } from "../db-workspace.js";

export async function ensureDbOpen(basePath: string = safeWorkspaceCwd()): Promise<boolean> {
  const result = openWorkflowDatabase(basePath);
  if (result.ok) return true;

  if (result.reason === "missing-gsd-dir") {
    logWarning("bootstrap", "ensureDbOpen failed — no .gsd directory found");
  } else {
    logWarning("bootstrap", `ensureDbOpen failed: ${result.error?.message ?? "open failed"}`);
  }
  return false;
}

export function registerDynamicTools(pi: ExtensionAPI): void {
  const fallbackRoot = safeWorkspaceCwd();
  const baseBash = createBashTool(fallbackRoot, {
    spawnHook: (ctx) => ctx,
  });
  // The auto-mode stalled-tool watchdog only exists in GSD/auto-mode, so the
  // watchdog verbiage is injected here (the GSD-registered tool) rather than in
  // core bash.ts, which is reused by non-GSD embeddings that have no watchdog.
  const WATCHDOG_DETAIL =
    "Genuine hangs are caught by the auto-mode stalled-tool watchdog (stalled: 5m / idle: 10m / soft: 20m / hard: 30m).";
  const gsdBashDescription = `${(baseBash as any).description} ${WATCHDOG_DETAIL}`;
  const gsdBashParameters = (() => {
    const params: any = (baseBash as any).parameters;
    if (!params?.properties?.timeout) return params;
    return {
      ...params,
      properties: {
        ...params.properties,
        timeout: {
          ...params.properties.timeout,
          description: `${params.properties.timeout.description} ${WATCHDOG_DETAIL}`,
        },
      },
    };
  })();
  const dynamicBash = {
    ...baseBash,
    description: gsdBashDescription,
    parameters: gsdBashParameters,
    execute: async (
      toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const basePath = resolveCtxCwd(ctx);
      const fresh = createBashTool(basePath, {
        spawnHook: (spawnCtx) => ({ ...spawnCtx, cwd: basePath }),
      });
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  pi.registerTool(dynamicBash as any);

  const baseWrite = createWriteTool(fallbackRoot);
  pi.registerTool({
    ...baseWrite,
    execute: async (
      toolCallId: string,
      params: { path: string; content: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createWriteTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);

  const baseRead = createReadTool(fallbackRoot);
  pi.registerTool({
    ...baseRead,
    execute: async (
      toolCallId: string,
      params: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createReadTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);

  const baseEdit = createEditTool(fallbackRoot);
  pi.registerTool({
    ...baseEdit,
    execute: async (
      toolCallId: string,
      params: { path: string; oldText: string; newText: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => {
      const fresh = createEditTool(resolveCtxCwd(ctx));
      return (fresh as any).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  } as any);
}
