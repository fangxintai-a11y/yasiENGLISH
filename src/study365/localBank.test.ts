import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinLocalBank,
  loadLocalBank,
  localBankIssues,
  resolveLocalAudio,
} from "./localBank";
import type { PrivateAudioTransport } from "./privateBankManifest";

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

/** Only the deferred open request is faked; production fallback and hashing run. */
function deferredBankOpens() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
    requests: IDBOpenDBRequest[] = [];
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request = {} as IDBOpenDBRequest;
        requests.push(request);
        return request;
      },
    },
  });
  return {
    requests,
    fail(index: number, reason: "error" | "blocked" = "error") {
      const request = requests[index];
      assert.ok(request, `missing deferred bank open ${index}`);
      if (reason === "blocked")
        request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
      else request.onerror?.(new Event("error"));
    },
    restore() {
      restoreProperty(globalThis, "indexedDB", descriptor);
    },
  };
}

test("concurrent same-scope bank loads share one pending read and clear after fallback succeeds", async () => {
  const opens = deferredBankOpens(),
    scope = "unit-bank-shared-success";
  try {
    const first = loadLocalBank(scope),
      concurrent = loadLocalBank(scope);
    assert.strictEqual(concurrent, first);
    assert.equal(opens.requests.length, 1);
    opens.fail(0);
    const [left, right] = await Promise.all([first, concurrent]);
    assert.strictEqual(left, right);
    assert.ok(left.length > 0);
    assert.ok(
      left.every((item) => item.source.sourceRef.startsWith("builtin:")),
    );
    assert.deepEqual(localBankIssues(scope), [
      "本机题库无法打开，原有学习数据没有被清除。",
    ]);

    const next = loadLocalBank(scope);
    assert.notStrictEqual(next, first);
    assert.equal(opens.requests.length, 2);
    opens.fail(1);
    assert.deepEqual(await next, left);
  } finally {
    opens.restore();
  }
});

test("guest and distinct accounts never share pending bank loads or fallback issues", async () => {
  const opens = deferredBankOpens(),
    aliceId = "unit-bank-alice",
    bobId = "unit-bank-bob";
  try {
    const guest = loadLocalBank(null),
      alice = loadLocalBank(aliceId),
      bob = loadLocalBank(bobId);
    assert.notStrictEqual(guest, alice);
    assert.notStrictEqual(guest, bob);
    assert.notStrictEqual(alice, bob);
    assert.strictEqual(loadLocalBank(null), guest);
    assert.strictEqual(loadLocalBank(aliceId), alice);
    assert.strictEqual(loadLocalBank(bobId), bob);
    assert.equal(opens.requests.length, 3);
    opens.fail(0);
    opens.fail(1);
    opens.fail(2, "blocked");
    const results = await Promise.all([guest, alice, bob]);
    assert.ok(results.every((items) => items.length > 0));
    assert.deepEqual(localBankIssues(null), [
      "本机题库无法打开，原有学习数据没有被清除。",
    ]);
    assert.deepEqual(localBankIssues(aliceId), localBankIssues(null));
    assert.deepEqual(localBankIssues(bobId), [
      "请关闭其他旧版页面后重试打开题库。",
    ]);
  } finally {
    opens.restore();
  }
});

test("a rejected fallback clears the shared bank promise and a later load can retry", async () => {
  const opens = deferredBankOpens(),
    scope = "unit-bank-shared-rejection",
    subtle = crypto.subtle,
    descriptor = Object.getOwnPropertyDescriptor(subtle, "digest"),
    failure = new Error("Synthetic fallback digest failure");
  let digestCalls = 0;
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: async () => {
      digestCalls++;
      throw failure;
    },
  });
  try {
    const first = loadLocalBank(scope),
      concurrent = loadLocalBank(scope);
    assert.strictEqual(concurrent, first);
    assert.equal(opens.requests.length, 1);
    const rejected = assert.rejects(first, (error) => error === failure);
    opens.fail(0);
    await rejected;
    assert.equal(digestCalls, 1);
    assert.deepEqual(localBankIssues(scope), [
      "本机题库无法打开，原有学习数据没有被清除。",
    ]);

    restoreProperty(subtle, "digest", descriptor);
    const retry = loadLocalBank(scope);
    assert.notStrictEqual(retry, first);
    assert.equal(opens.requests.length, 2);
    opens.fail(1, "blocked");
    assert.ok((await retry).length > 0);
    assert.deepEqual(localBankIssues(scope), [
      "请关闭其他旧版页面后重试打开题库。",
    ]);
  } finally {
    restoreProperty(subtle, "digest", descriptor);
    opens.restore();
  }
});

type AudioRow = {
  scope: string;
  path: string;
  sha256: string;
  blob?: Blob;
  transport?: PrivateAudioTransport;
};
function memoryAudioBank(rows: AudioRow[] = []) {
  const restorers: (() => void)[] = [],
    activeURLs = new Map<string, Blob>();
  const state = {
    rows,
    fetches: 0,
    writes: 0,
    reads: [] as string[],
    requested: [] as string[],
    activeURLs,
    revoked: [] as string[],
    respond: async () => new Response(new Blob(["Synthetic audio"])),
    restore: () => restorers.reverse().forEach((restore) => restore()),
  };
  const install = (target: object, key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    restorers.push(() => restoreProperty(target, key, descriptor));
  };
  const db = {
    close() {},
    transaction() {
      const tx = {
        objectStore(name: string) {
          return {
            index: () => ({
              getAll(scope: string) {
                if (name === "audio") state.reads.push(scope);
                const request = {
                  result:
                    name === "audio"
                      ? structuredClone(
                          rows.filter((row) => row.scope === scope),
                        )
                      : [],
                } as unknown as IDBRequest;
                queueMicrotask(() => request.onsuccess?.(new Event("success")));
                return request;
              },
            }),
            add(row: AudioRow) {
              assert.equal(
                rows.some(
                  (old) => old.scope === row.scope && old.path === row.path,
                ),
                false,
                "duplicate audio add",
              );
              rows.push(structuredClone(row));
              state.writes++;
            },
            put(row: AudioRow) {
              rows[
                rows.findIndex(
                  (old) => old.scope === row.scope && old.path === row.path,
                )
              ] = structuredClone(row);
              state.writes++;
            },
          };
        },
        abort() {
          queueMicrotask(() => tx.onabort?.(new Event("abort")));
        },
      } as unknown as IDBTransaction;
      queueMicrotask(() => tx.oncomplete?.(new Event("complete")));
      return tx;
    },
  };
  install(globalThis, "indexedDB", {
    open() {
      const request = { result: db } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request;
    },
  });
  install(globalThis, "IDBKeyRange", { only: (scope: string) => scope });
  install(globalThis, "navigator", { onLine: true });
  install(globalThis, "fetch", async (url: string) => {
    state.fetches++;
    state.requested.push(url);
    return state.respond();
  });
  let nextURL = 0;
  install(URL, "createObjectURL", (blob: Blob) => {
    const url = `blob:synthetic-${++nextURL}`;
    activeURLs.set(url, blob);
    return url;
  });
  install(URL, "revokeObjectURL", (url: string) => {
    activeURLs.delete(url);
    state.revoked.push(url);
  });
  return state;
}
async function audioFixture(blob: Blob) {
  const sample = (await builtinLocalBank()).find(
    (item) => item.skill === "listening",
  )!;
  const sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    ...sample,
    audio: { path: "audio/synthetic-shared.wav", durationSeconds: 10, sha256 },
  };
}

test("concurrent audio preparation fetches and saves once while each caller owns its URL", async () => {
  const blob = new Blob(["Self-authored source audio"]),
    material = await audioFixture(blob),
    bank = memoryAudioBank();
  bank.respond = async () => new Response(blob);
  try {
    const path = material.audio.path,
      first = resolveLocalAudio("audio-shared", material);
    const second = resolveLocalAudio("audio-shared", {
      ...material,
      audio: { ...material.audio, durationSeconds: 99 },
    });
    material.audio.path = "audio/mutated-after-call.wav";
    const [left, right] = await Promise.all([first, second]);
    assert.equal(bank.fetches, 1);
    assert.equal(bank.writes, 1);
    assert.deepEqual(bank.requested, [`/local-bank/${path}`]);
    assert.notEqual(left.url, right.url);
    left.release();
    assert.deepEqual(bank.revoked, [left.url]);
    assert.ok(bank.activeURLs.has(right.url));
    const reads = bank.reads.length;
    material.audio.path = path;
    const later = await resolveLocalAudio("audio-shared", material);
    assert.ok(bank.reads.length > reads);
    assert.equal(bank.fetches, 1);
    assert.notEqual(later.url, right.url);
    right.release();
    later.release();
    assert.equal(bank.activeURLs.size, 0);
  } finally {
    bank.restore();
  }
});

test("audio preparation is isolated by account and expected SHA", async () => {
  const blob = new Blob(["Self-authored scoped audio"]),
    material = await audioFixture(blob),
    bank = memoryAudioBank();
  bank.respond = async () => new Response(blob);
  try {
    const mismatch = {
      ...material,
      audio: { ...material.audio, sha256: "f".repeat(64) },
    };
    const results = await Promise.allSettled([
      resolveLocalAudio("audio-alice", material),
      resolveLocalAudio("audio-bob", material),
      resolveLocalAudio("audio-alice", mismatch),
    ]);
    assert.equal(bank.fetches, 3);
    assert.equal(bank.writes, 2);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled", "rejected"],
    );
    assert.match(
      String((results[2] as PromiseRejectedResult).reason),
      /音频校验失败/,
    );
    assert.deepEqual(bank.rows.map((row) => row.scope).sort(), [
      "user:audio-alice",
      "user:audio-bob",
    ]);
    for (const result of results)
      if (result.status === "fulfilled") result.value.release();
  } finally {
    bank.restore();
  }
});

test("failed shared audio preparation retries and preserves compressed size and SHA checks", async () => {
  const source = new Blob(["Self-authored original source"]),
    compressed = new Blob(["Synthetic compressed bytes"]);
  const material = await audioFixture(source),
    compressedSHA = (await audioFixture(compressed)).audio.sha256;
  const transport: PrivateAudioTransport = {
    originalPath: material.audio.path,
    sourceSha256: material.audio.sha256,
    path: `/private/audio/${"f".repeat(64)}.m4a`,
    sha256: "f".repeat(64),
    bytes: compressed.size + 1,
    sourceBytes: source.size,
    durationSeconds: 10,
    sourceDurationSeconds: 10,
    bitRate: 48000,
    targetBitRate: 48000,
    codec: "aac",
    profile: "LC",
    channels: 1,
  };
  const bank = memoryAudioBank([
    {
      scope: "user:audio-transport",
      path: "private-meta:synthetic",
      sha256: transport.sha256,
      transport,
    },
  ]);
  bank.respond = async () => new Response(compressed);
  try {
    const pair = await Promise.allSettled([
      resolveLocalAudio("audio-transport", material),
      resolveLocalAudio("audio-transport", material),
    ]);
    assert.ok(
      pair.every(
        (result) =>
          result.status === "rejected" &&
          /大小与目录不一致/.test(String(result.reason)),
      ),
    );
    assert.equal(bank.fetches, 1);
    assert.equal(bank.writes, 0);
    assert.equal(bank.activeURLs.size, 0);
    transport.bytes = compressed.size;
    await assert.rejects(
      resolveLocalAudio("audio-transport", material),
      /音频校验失败/,
    );
    assert.equal(bank.fetches, 2);
    assert.equal(bank.writes, 0);
    transport.sha256 = compressedSHA;
    transport.path = `/private/audio/${compressedSHA}.m4a`;
    const resource = await resolveLocalAudio("audio-transport", material);
    assert.equal(bank.fetches, 3);
    assert.equal(bank.writes, 1);
    assert.equal(bank.requested.at(-1), transport.path);
    assert.equal(
      await bank.activeURLs.get(resource.url)!.text(),
      await compressed.text(),
    );
    resource.release();
  } finally {
    bank.restore();
  }
});
