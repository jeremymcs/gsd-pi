// Project/App: gsd-pi
// File Purpose: Domain Write Operations (Hierarchy Status Cascades) for the
// single-writer layer. Each operation owns its own transaction() and mutates
// the related rows of one logical hierarchy change in a single commit, so the
// atomicity rule lives in one place instead of being hand-rolled (or missed)
// in callers. Operations own DB-row atomicity only — markdown re-projection,
// validation, and messaging stay in callers / db-writer.ts.
import { getDbOrNull, transaction } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";

/**
 * Reset a slice to "active" and all of its tasks to "pending" in one commit,
 * clearing completion timestamps. Equivalent to the historical per-task
 * updateTaskStatus loop + updateSliceStatus in undo's reset-slice, but atomic:
 * an interruption can no longer leave some tasks reset and others not.
 */
export function resetSliceCascade(milestoneId: string, sliceId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    getDbOrNull()!.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL
       WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!.prepare(
      `UPDATE slices SET status = 'active', completed_at = NULL
       WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}
