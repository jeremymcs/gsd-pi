// Project/App: gsd-pi
// File Purpose: Shared SQL literal fragments for the single-writer layer.
// Kept out of the barrel surface (imported as values, not re-exported) so it
// stays an implementation detail of the writers.

/** Status values that mean a unit is closed; used in ON CONFLICT guards to
 *  prevent an upsert from reopening a completed slice/task. */
export const TERMINAL_STATUS_SQL = "'complete', 'done', 'skipped', 'closed'";
