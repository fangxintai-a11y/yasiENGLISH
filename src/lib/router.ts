import { useSyncExternalStore } from "react";
import { transition } from "./motion";

export type Route =
  | { page: "today" }
  | { page: "atlas"; topic?: string; level?: string; q?: string; view?: string }
  | { page: "learn" }
  | { page: "practice" }
  /** 跟读; run is the immersive round itself. */
  | { page: "shadow"; run?: boolean }
  | { page: "ielts"; tab?: string }
  | { page: "writing"; mode?: "practice"; task?: string; date?: string; day?: number; minutes?: number; work?: string; correctionId?: string; retestOf?: string; material?: string }
  | { page: "speaking"; mode?: "practice"; task?: string; date?: string; day?: number; minutes?: number; work?: string; correctionId?: string; retestOf?: string; material?: string }
  | { page: "reading"; mode?: "practice"; task?: string; date?: string; day?: number; minutes?: number; work?: string; material?: string; correctionId?: string; retestOf?: string }
  | { page: "listening"; mode?: "practice"; task?: string; date?: string; day?: number; minutes?: number; work?: string; material?: string; correctionId?: string; retestOf?: string }
  | { page: "review"; correctionId?: string; tab?: "corrections" | "weekly" | "answers" | "coverage" }
  | { page: "progress" }
  | { page: "me"; section?: "learning-sync" }
  | { page: "about" };

export interface Location {
  route: Route;
  /** Word sheet open on top of the route. */
  word: string | null;
}

function parse(hash: string): Location {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const word = params.get("w");
  const seg = path.split("/").filter(Boolean);
  let route: Route = { page: "today" };
  if (seg[0] === "atlas")
    route = { page: "atlas", topic: params.get("topic") || undefined, level: params.get("level") || undefined, q: params.get("q") || undefined, view: params.get("view") || undefined };
  else if (seg[0] === "learn") route = { page: "learn" };
  else if (seg[0] === "practice") route = { page: "practice" };
  else if (seg[0] === "shadow") route = { page: "shadow", run: params.get("go") === "1" };
  else if (seg[0] === "ielts") route = { page: "ielts", tab: params.get("tab") || undefined };
  else if (seg[0] === "writing") route = { page: "writing", mode: params.get("mode") === "practice" ? "practice" : undefined, task: params.get("task") || undefined, date: params.get("date") || undefined,
    day: params.has("day") ? Number(params.get("day")) : undefined, minutes: params.has("minutes") ? Number(params.get("minutes")) : undefined, work: params.get("work") || undefined, correctionId: params.get("correctionId") || undefined, retestOf: params.get("retestOf") || undefined, material: params.get("material") || undefined };
  else if (seg[0] === "speaking") route = { page: "speaking", mode: params.get("mode") === "practice" ? "practice" : undefined, task: params.get("task") || undefined, date: params.get("date") || undefined,
    day: params.has("day") ? Number(params.get("day")) : undefined, minutes: params.has("minutes") ? Number(params.get("minutes")) : undefined, work: params.get("work") || undefined, correctionId: params.get("correctionId") || undefined, retestOf: params.get("retestOf") || undefined, material: params.get("material") || undefined };
  else if (seg[0] === "reading") route = { page: "reading", mode: params.get("mode") === "practice" ? "practice" : undefined, task: params.get("task") || undefined, date: params.get("date") || undefined,
    day: params.has("day") ? Number(params.get("day")) : undefined, minutes: params.has("minutes") ? Number(params.get("minutes")) : undefined, work: params.get("work") || undefined, correctionId: params.get("correctionId") || undefined, retestOf: params.get("retestOf") || undefined, material: params.get("material") || undefined };
  else if (seg[0] === "listening") route = { page: "listening", mode: params.get("mode") === "practice" ? "practice" : undefined, task: params.get("task") || undefined, date: params.get("date") || undefined,
    day: params.has("day") ? Number(params.get("day")) : undefined, minutes: params.has("minutes") ? Number(params.get("minutes")) : undefined, work: params.get("work") || undefined, correctionId: params.get("correctionId") || undefined, retestOf: params.get("retestOf") || undefined, material: params.get("material") || undefined };
  else if (seg[0] === "review") route = { page: "review", correctionId: params.get("correctionId") || undefined, tab: ["corrections", "weekly", "answers", "coverage"].includes(params.get("tab") ?? "") ? params.get("tab") as "corrections" | "weekly" | "answers" | "coverage" : undefined };
  else if (seg[0] === "progress") route = { page: "progress" };
  else if (seg[0] === "me") route = { page: "me", ...(params.get("section") === "learning-sync" ? { section: "learning-sync" as const } : {}) };
  else if (seg[0] === "about") route = { page: "about" };
  else if (seg[0] === "w" && seg[1]) return { route: { page: "atlas" }, word: decodeURIComponent(seg[1]) };
  return { route, word };
}

export function href(route: Route, word?: string | null) {
  const params = new URLSearchParams();
  if (route.page === "atlas") {
    if (route.topic) params.set("topic", route.topic);
    if (route.level) params.set("level", route.level);
    if (route.q) params.set("q", route.q);
    if (route.view) params.set("view", route.view);
  }
  if (route.page === "writing" || route.page === "speaking" || route.page === "reading" || route.page === "listening") {
    for (const key of ["mode", "task", "date", "day", "minutes", "work", "correctionId", "retestOf", "material"] as const) if (route[key] !== undefined) params.set(key, String(route[key]));
  }
  if ((route.page === "reading" || route.page === "listening") && route.material) params.set("material", route.material);
  if (route.page === "review" && route.tab) params.set("tab", route.tab);
  if (route.page === "review" && route.correctionId) params.set("correctionId", route.correctionId);
  if (route.page === "ielts" && route.tab) params.set("tab", route.tab);
  if (route.page === "me" && route.section) params.set("section", route.section);
  if (route.page === "shadow" && route.run) params.set("go", "1");
  if (word) params.set("w", word);
  const q = params.toString();
  return `#/${route.page === "today" ? "" : route.page}${q ? `?${q}` : ""}`;
}

let loc = parse(location.hash);
const subs = new Set<() => void>();
window.addEventListener("hashchange", () => {
  const next = parse(location.hash);
  const pageChange = next.route.page !== loc.route.page;
  const update = () => {
    loc = next;
    subs.forEach((f) => f());
  };
  // Crossfade between pages; the word sheet animates on its own.
  if (pageChange && !next.word) transition(update);
  else update();
});

export const useLocation = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => loc,
  );

export function go(route: Route, word?: string | null, replace = false) {
  const h = href(route, word);
  if (replace) history.replaceState(null, "", h);
  else history.pushState(null, "", h);
  const next = parse(h);
  const pageChange = next.route.page !== loc.route.page;
  const update = () => {
    loc = next;
    subs.forEach((f) => f());
  };
  if (pageChange && !replace) transition(update);
  else update();
}

export const openWord = (id: string) => go(loc.route, id);
export const closeWord = () => go(loc.route, null);
export const currentLocation = () => loc;
