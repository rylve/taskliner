import { compareStamps, cloneStamp } from "./stamps.mjs";

export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function createTombstone({ nodeId, deletedAt, stamp, recordedAt = Date.now() } = {}) {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("nodeId is required");
  if (deletedAt == null) throw new Error("deletedAt is required");
  if (!stamp) throw new Error("stamp is required");
  return {
    nodeId,
    deletedAt,
    stamp: cloneStamp(stamp),
    recordedAt,
  };
}

export function canRestoreTombstone(tombstone, restoreStamp) {
  if (!tombstone?.stamp || !restoreStamp) return false;
  return compareStamps(restoreStamp, tombstone.stamp) > 0;
}

/**
 * Retain tombstones for the minimum window. Even after that window, callers
 * must confirm every known device has observed the tombstone before pruning.
 */
export function retainTombstones(tombstones, {
  now = Date.now(),
  retentionMs = TOMBSTONE_RETENTION_MS,
  acknowledged = () => false,
} = {}) {
  return (Array.isArray(tombstones) ? tombstones : []).filter((tombstone) => {
    if (!tombstone || !Number.isFinite(tombstone.recordedAt)) return true;
    if (now - tombstone.recordedAt < retentionMs) return true;
    return !acknowledged(tombstone);
  });
}

