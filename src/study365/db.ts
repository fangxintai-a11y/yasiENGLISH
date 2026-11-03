import { emptyScope, type LearningScope } from "./protocol";

const DATABASE = "band-learning-v1";
let opening: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("scopes");
      request.result.createObjectStore("recordings");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => { opening = null; reject(new Error("无法打开学习记录存储。请允许网站保存数据。")); };
    request.onblocked = () => { opening = null; reject(new Error("请关闭其他旧页面后重新打开学习记录。")); };
  });
  return opening;
}
const transactionError = () => new Error("学习记录未能保存。请释放设备存储空间后重试，勿关闭未保存的内容。");

export async function readScope(scope: string): Promise<LearningScope> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("scopes").objectStore("scopes").get(scope);
    request.onsuccess = () => resolve(request.result ?? emptyScope());
    request.onerror = () => reject(transactionError());
  });
}

/** A single IDB transaction commits heads, revision history, outbox and cursor together. */
export async function updateScope(scope: string, change: (state: LearningScope) => LearningScope): Promise<LearningScope> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("scopes", "readwrite");
    const store = tx.objectStore("scopes");
    let next: LearningScope;
    let failure: unknown;
    const request = store.get(scope);
    request.onsuccess = () => {
      try { next = change(request.result ?? emptyScope()); store.put(next, scope); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next!);
    tx.onabort = tx.onerror = () => reject(failure ?? transactionError());
  });
}

export async function putRecording(scope: string, id: string, blob: Blob): Promise<void> {
  if (blob.size > 50 * 1024 * 1024) throw new Error("单段录音超过50 MB，请缩短后重试。");
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").put(blob, [scope, id]);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(transactionError());
  });
}
export async function readRecording(scope: string, id: string): Promise<Blob | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("recordings").objectStore("recordings").get([scope, id]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(transactionError());
  });
}
