import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cue, primeCues } from "../lib/sound";
import { typingDelta } from "../lib/typing";
import { useTypingVisibility } from "../lib/useTypingVisibility";

export interface TypingChange {
  added: number;
  correct: number;
}

/** Native, stable input. The current answer and its length never enter the rendered prompt. */
export function TypingField({
  itemId,
  target,
  accepts,
  onSubmit,
  onChange,
  onReplay,
  onContinue,
  autoComplete = false,
  pending,
  sounds = false,
  label = "输入英文单词",
  placeholder = "凭记忆输入英文",
}: {
  itemId: string;
  target: string;
  accepts: (value: string) => boolean;
  onSubmit: (value: string) => void;
  onChange?: (value: string, delta: TypingChange) => void;
  onReplay?: () => void;
  onContinue?: () => void;
  autoComplete?: boolean;
  pending?: { correct: boolean; value: string };
  sounds?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const current = useRef({
    id: itemId,
    value: "",
    committed: "",
    submitted: false,
    composing: false,
  });
  const id = useId();
  useTypingVisibility(input, !pending);

  useLayoutEffect(() => {
    current.current = {
      id: itemId,
      value: "",
      committed: "",
      submitted: false,
      composing: false,
    };
    setValue("");
    setNotice("");
    input.current?.focus({ preventScroll: true });
  }, [itemId]);
  useEffect(() => {
    if (sounds) primeCues();
  }, [sounds]);
  useEffect(() => {
    if (pending && window.matchMedia("(pointer: coarse)").matches)
      input.current?.blur();
  }, [pending]);

  const submit = (text: string) => {
    const state = current.current;
    if (
      state.id !== itemId ||
      state.submitted ||
      state.composing ||
      pending ||
      !text.trim()
    )
      return;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
      setNotice("请切换到英文输入法，再继续输入。");
      return;
    }
    state.submitted = true;
    onSubmit(text);
  };
  const update = (next: string, composing: boolean) => {
    const state = current.current;
    if (pending || state.submitted || state.id !== itemId) return;
    const previous = state.committed;
    state.value = next;
    setValue(next);
    if (composing || state.composing) return;
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)) {
      setNotice("请切换到英文输入法，再继续输入。");
      return;
    }
    setNotice("");
    state.committed = next;
    const delta = typingDelta(previous, next, target);
    if (sounds && delta.total) void cue("key");
    onChange?.(next, { added: delta.total, correct: delta.correct });
    if (autoComplete && accepts(next)) submit(next);
  };

  return (
    <form
      className={`recall-typing ${pending ? (pending.correct ? "is-correct" : "is-incorrect") : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(current.current.value);
      }}
    >
      <div className="recall-input-wrap">
        <input
          ref={input}
          className="recall-input"
          value={pending ? pending.value : value}
          onChange={(event) =>
            update(
              event.target.value,
              (event.nativeEvent as InputEvent).isComposing,
            )
          }
          onCompositionStart={() => {
            current.current.composing = true;
          }}
          onCompositionEnd={(event) => {
            current.current.composing = false;
            update(event.currentTarget.value, false);
          }}
          onPaste={(event) => {
            event.preventDefault();
            setNotice("请亲手输入，练习中不粘贴答案。");
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || current.current.composing) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "j" &&
              onReplay
            ) {
              event.preventDefault();
              onReplay();
              return;
            }
            if (event.key === "Enter" && (event.repeat || pending)) {
              event.preventDefault();
              if (!event.repeat && pending) onContinue?.();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              input.current?.blur();
            }
            if (event.key === " " && !current.current.value && !pending)
              event.preventDefault();
          }}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-label={label}
          aria-describedby={id}
          placeholder={placeholder}
          readOnly={!!pending}
          lang="en"
        />
      </div>
      <p id={id} className="recall-input-help" role="status">
        {notice ||
          (pending
            ? "按 Enter 或点击下一步继续。"
            : `${autoComplete ? "拼对自动核对 · " : ""}Enter 确认${onReplay ? " · Ctrl/⌘ J 重听" : ""}`)}
      </p>
      {!pending && (
        <button
          className="btn btn-ghost recall-confirm"
          type="submit"
          disabled={!value.trim()}
        >
          确认 <kbd>Enter</kbd>
        </button>
      )}
    </form>
  );
}
