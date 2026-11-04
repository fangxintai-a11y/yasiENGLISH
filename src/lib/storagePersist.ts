/**
 * Utilities for StorageManager APIs: storage persistence and quota estimation.
 * Tested across granted, denied, and unsupported environments.
 */

export interface StorageEstimateResult {
  used: number;
  quota: number;
}

export interface StorageManagerLike {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
}

function resolveStorage(storage?: StorageManagerLike | null): StorageManagerLike | undefined {
  if (storage !== undefined) return storage ?? undefined;
  if (typeof navigator !== "undefined" && navigator.storage) return navigator.storage;
  return undefined;
}

/**
 * Checks whether the current origin has already been granted persistent storage.
 * Returns true if persisted, false if not, or null if the API is unsupported.
 */
export async function checkStoragePersistence(storage?: StorageManagerLike | null): Promise<boolean | null> {
  const s = resolveStorage(storage);
  if (!s || typeof s.persisted !== "function") return null;
  try {
    return Boolean(await s.persisted());
  } catch {
    return null;
  }
}

/**
 * Requests persistent storage for the current origin.
 * Returns true if granted, false if denied, or null if the API is unsupported.
 */
export async function requestStoragePersistence(storage?: StorageManagerLike | null): Promise<boolean | null> {
  const s = resolveStorage(storage);
  if (!s || typeof s.persist !== "function") return null;
  try {
    return Boolean(await s.persist());
  } catch {
    return null;
  }
}

/**
 * Fetches current storage usage and quota.
 * Returns { used, quota } in bytes, or null if unsupported or invalid.
 */
export async function getStorageEstimate(storage?: StorageManagerLike | null): Promise<StorageEstimateResult | null> {
  const s = resolveStorage(storage);
  if (!s || typeof s.estimate !== "function") return null;
  try {
    const e = await s.estimate();
    if (e && typeof e.usage === "number" && typeof e.quota === "number") {
      return { used: e.usage, quota: e.quota };
    }
    return null;
  } catch {
    return null;
  }
}
