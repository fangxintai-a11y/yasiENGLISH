import { useSyncExternalStore } from "react";

/** Look-alike headwords learners mix up (adapt/adopt), built by scripts/ielts/build_confusables.py. */

// Optional chaining keeps the module importable from node tests, where Vite env is absent.
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
let table: Record<string, string[]> = {};
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

export function loadConfusables() {
  if (!loading)
    loading = fetch(`${BASE}/ielts/confusables.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, string[]>>) : {}))
      .catch(() => {
        loading = null;
        return {};
      })
      .then((t) => setConfusables(t));
  return loading;
}

/** For tests and non-browser callers. */
export function setConfusables(t: Record<string, string[]>) {
  table = t;
  subs.forEach((f) => f());
}

/** Sync access for code outside React (quiz building); empty until loaded. */
export const confusablesOf = (id: string): string[] => table[id] ?? [];

export function useConfusables(id: string): string[] {
  return useConfusablesTable()[id] ?? [];
}

export function useConfusablesTable(): Record<string, string[]> {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      void loadConfusables();
      return () => subs.delete(f);
    },
    () => table,
    () => table,
  );
}
