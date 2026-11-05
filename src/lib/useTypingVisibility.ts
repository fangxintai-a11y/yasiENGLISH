import { useEffect, type RefObject } from "react";

/** Mobile keyboards can resize only the visual viewport; keep the visible answer above them. */
export function useTypingVisibility(inputRef: RefObject<HTMLInputElement | null>, enabled: boolean) {
  useEffect(() => {
    const input = inputRef.current;
    const learn = input?.closest<HTMLElement>(".learn");
    if (!input || !learn || !enabled) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const mobile = window.matchMedia("(max-width: 639px)").matches;
        if (!mobile || document.activeElement !== input || (viewport && viewport.scale !== 1)) {
          learn.style.removeProperty("--typing-keyboard-inset");
          return;
        }
        const top = viewport?.offsetTop ?? 0;
        const height = viewport?.height ?? window.innerHeight;
        const inset = Math.max(0, window.innerHeight - height - top);
        learn.style.setProperty("--typing-keyboard-inset", `${inset}px`);
        // Spelling uses a transparent native input over visible letter slots.
        const answer = input.closest(".spell")?.querySelector(".slots") ?? input;
        const rect = answer.getBoundingClientRect();
        const bottom = top + height - 72;
        if (rect.bottom > bottom || rect.top < top + 56) {
          const targetTop = Math.max(top + 56, bottom - rect.height);
          window.scrollBy({ top: rect.top - targetTop, behavior: "instant" });
        }
      });
    };
    input.addEventListener("focus", update);
    input.addEventListener("blur", update);
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      window.cancelAnimationFrame(frame);
      input.removeEventListener("focus", update);
      input.removeEventListener("blur", update);
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      learn.style.removeProperty("--typing-keyboard-inset");
    };
  }, [inputRef, enabled]);
}
