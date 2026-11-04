import { flushSync } from "react-dom";

type ViewTransitionResult = { ready: Promise<void>; updateCallbackDone: Promise<void>; finished: Promise<void> };
type VTDocument = Document & { startViewTransition?: (cb: () => void) => ViewTransitionResult };

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Each browser promise can reject independently; observing finished alone is insufficient. */
function observeTransition(t: ViewTransitionResult, cleanup?: () => void) {
  void t.ready.catch(() => {});
  void t.updateCallbackDone.catch(() => {});
  if (cleanup) void t.finished.then(cleanup, cleanup);
  else void t.finished.catch(() => {});
}

/** Run a DOM-changing update inside a View Transition when the browser supports it. */
export function transition(update: () => void) {
  const d = document as VTDocument;
  if (!d.startViewTransition || reduced()) {
    update();
    return;
  }
  observeTransition(d.startViewTransition(() => flushSync(update)));
}

/** Morph an element (e.g. a gallery tile's illustration) into the word card. */
export function morphFrom(el: HTMLElement | null | undefined, update: () => void) {
  const d = document as VTDocument;
  if (!el || !d.startViewTransition || reduced()) {
    update();
    return;
  }
  el.style.viewTransitionName = "word-art";
  const t = d.startViewTransition(() => {
    el.style.viewTransitionName = "";
    flushSync(update);
  });
  observeTransition(t, () => { el.style.viewTransitionName = ""; });
}
