import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkStoragePersistence,
  getStorageEstimate,
  requestStoragePersistence,
  type StorageManagerLike,
} from "./storagePersist";

test("requestStoragePersistence: returns true when persistence is granted", async () => {
  const mockStorage: StorageManagerLike = {
    persist: async () => true,
  };
  const result = await requestStoragePersistence(mockStorage);
  assert.equal(result, true);
});

test("requestStoragePersistence: returns false when persistence is denied", async () => {
  const mockStorage: StorageManagerLike = {
    persist: async () => false,
  };
  const result = await requestStoragePersistence(mockStorage);
  assert.equal(result, false);
});

test("requestStoragePersistence: returns null when storage API is unsupported", async () => {
  const emptyStorage: StorageManagerLike = {};
  assert.equal(await requestStoragePersistence(emptyStorage), null);
  assert.equal(await requestStoragePersistence(null), null);
});

test("requestStoragePersistence: safely returns null when persist() throws an error", async () => {
  const throwingStorage: StorageManagerLike = {
    persist: async () => {
      throw new Error("SecurityError: User denied permission");
    },
  };
  const result = await requestStoragePersistence(throwingStorage);
  assert.equal(result, null);
});

test("checkStoragePersistence: returns true when already persisted", async () => {
  const mockStorage: StorageManagerLike = {
    persisted: async () => true,
  };
  assert.equal(await checkStoragePersistence(mockStorage), true);
});

test("checkStoragePersistence: returns false when not persisted", async () => {
  const mockStorage: StorageManagerLike = {
    persisted: async () => false,
  };
  assert.equal(await checkStoragePersistence(mockStorage), false);
});

test("checkStoragePersistence: returns null when unsupported or on error", async () => {
  assert.equal(await checkStoragePersistence({}), null);
  assert.equal(await checkStoragePersistence(null), null);
  const throwingStorage: StorageManagerLike = {
    persisted: async () => {
      throw new Error("Persisted check failed");
    },
  };
  assert.equal(await checkStoragePersistence(throwingStorage), null);
});

test("getStorageEstimate: returns valid used and quota numbers", async () => {
  const mockStorage: StorageManagerLike = {
    estimate: async () => ({ usage: 104857600, quota: 1073741824 }),
  };
  const result = await getStorageEstimate(mockStorage);
  assert.deepEqual(result, { used: 104857600, quota: 1073741824 });
});

test("getStorageEstimate: returns null when missing fields or unsupported or throws", async () => {
  assert.equal(await getStorageEstimate({}), null);
  assert.equal(await getStorageEstimate(null), null);
  assert.equal(await getStorageEstimate({ estimate: async () => ({}) }), null);
  assert.equal(
    await getStorageEstimate({
      estimate: async () => {
        throw new Error("Quota query failed");
      },
    }),
    null,
  );
});
