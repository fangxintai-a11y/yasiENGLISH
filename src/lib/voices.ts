/* 声音日记: the learner's first and latest take of each sentence, kept on this device (IndexedDB),
   so they can hear how far they have come. Never part of backups; quietly unavailable in private mode. */

export interface VoiceTake {
  key: string;
  kind: "first" | "last";
  at: number;
  blob: Blob;
}

const DB = "band-voices";
const STORE = "takes";
/** About 20 KB a take: a few thousand sentences stay well under 50 MB. */
const MAX = 1600;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(STORE, { keyPath: ["key", "kind"] });
        s.createIndex("at", "at");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      opening = null;
      throw e;
    }) as Promise<IDBDatabase>;
  return opening;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Keeps the first take of a sentence forever (until the cap) and replaces the latest one. */
export async function saveTake(key: string, blob: Blob, at = Date.now()) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    const s = tx.objectStore(STORE);
    const first = await done(s.get([key, "first"]));
    if (!first) s.put({ key, kind: "first", at, blob } satisfies VoiceTake);
    else s.put({ key, kind: "last", at, blob } satisfies VoiceTake);
    const n = await done(s.count());
    if (n > MAX) {
      // Drop the oldest takes past the cap.
      let extra = n - MAX;
      const cur = s.index("at").openCursor();
      await new Promise<void>((resolve) => {
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || extra <= 0) return resolve();
          c.delete();
          extra--;
          c.continue();
        };
        cur.onerror = () => resolve();
      });
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function getTakes(key: string): Promise<{ first?: VoiceTake; last?: VoiceTake }> {
  try {
    const db = await open();
    const s = db.transaction(STORE).objectStore(STORE);
    const [first, last] = await Promise.all([done(s.get([key, "first"])), done(s.get([key, "last"]))]);
    return { first: first as VoiceTake | undefined, last: last as VoiceTake | undefined };
  } catch {
    return {};
  }
}

export async function countTakes(): Promise<number> {
  try {
    const db = await open();
    return await done(db.transaction(STORE).objectStore(STORE).count());
  } catch {
    return 0;
  }
}
