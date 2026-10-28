import { ArrowRight, Check, Lightbulb, RotateCcw, Share2, Timer, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefetch, useAtlas, useEntry } from "../atlas/context";
import type { Entry, WordRef } from "../atlas/types";
import { parseKey } from "../ielts/exam";
import { diagnose, diffMarks, SPELL_LABEL, spelledRight } from "../ielts/spelling";
import { nextSyllableEnd, parseSyllables, pieceStarts, useSyllables } from "../ielts/syllables";
import { play, stopAudio } from "../lib/audio";
import { burst } from "../lib/burst";
import { cue } from "../lib/sound";
import { go } from "../lib/router";
import { gap, normalize } from "../lib/text";
import { answer, advance, atlasSynonyms, buildSession, gradeFor, isPractice, markKnown, RELEARN_RUN, sessionStats, SPEED_LIMIT, stepKey, trackOf } from "../store/session";
import { Rating, type Grade } from "../store/srs";
import { store, useStore, type ActiveSession, type QuizKind, type Step, type Track } from "../store/store";
import { EntryView, Highlight } from "../ui/EntryView";
import { Illustration } from "../ui/Illustration";
import { HackBlock, MnemonicBlock, WhyTags } from "../ui/Memory";
import { Galaxy } from "../galaxy/Galaxy";
import { AmbiencePicker } from "../ui/Ambience";
import { Ring } from "../ui/Ring";
import { Speak } from "../ui/Speak";
import { shareSession } from "../ui/shareSession";
import { toast } from "../ui/Toast";

export function Learn() {
  const atlas = useAtlas();
  const session = useStore((s) => s.progress.session);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const { progress, settings } = store.get();
    if (!progress.session) {
      const s = buildSession(atlas, progress, settings);
      if (!s.steps.length) {
        go({ page: "today" }, null, true);
        return;
      }
      store.progress((p) => ({ ...p, session: s }));
    }
  }, [atlas]);

  const ids = useMemo(() => [...new Set(session?.steps.map((s) => s.id) ?? [])], [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    // Load the first chunk before rendering, the rest in the background.
    prefetch(atlas, ids.slice(0, 6)).then(() => live && setReady(true));
    void prefetch(atlas, ids);
    return () => {
      live = false;
    };
  }, [atlas, ids]);

  useEffect(() => () => stopAudio(), []);

  if (!session || !ready) return <div className="learn learn-loading"><span className="spinner" /></div>;
  if (session.finished || session.index >= session.steps.length) return <Summary session={session} />;
  return <Runner session={session} />;
}

function Runner({ session }: { session: ActiveSession }) {
  const step = session.steps[session.index];
  const total = session.steps.length;
  const exit = () => {
    stopAudio();
    if (isPractice(session)) store.progress((p) => ({ ...p, session: null }));
    go({ page: isPractice(session) ? "ielts" : "today" });
  };
  return (
    <div className="learn">
      <header className="learn-top">
        <button className="icon-btn" onClick={exit} aria-label="暂停并返回">
          <X size={22} />
        </button>
        <div className="learn-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={session.index}>
          <span style={{ width: `${(session.index / total) * 100}%` }} />
        </div>
        <span className="learn-count">
          {session.index + 1}
          <small>/{total}</small>
        </span>
        <AmbiencePicker />
      </header>
      <main className="learn-stage" key={`${session.id}-${session.index}`}>
        {step.kind === "intro" ? <Intro step={step} /> : <Quiz step={(step.kind === "listen" ? { ...step, kind: "meaning" } : step) as Step & { kind: QuizKind }} session={session} />}
      </main>
    </div>
  );
}

function useStepTimer() {
  const t = useRef(performance.now());
  return () => (performance.now() - t.current) / 1000;
}

function Intro({ step }: { step: Step }) {
  const atlas = useAtlas();
  const { entry } = useEntry(step.id);
  const settings = useStore((s) => s.settings);
  const elapsed = useStepTimer();
  const ref = atlas.byId.get(step.id);
  // Guess first: trying to recall a meaning before seeing it makes it stick better than just reading it.
  const [revealed, setRevealed] = useState(!settings.guessFirst);
  useEffect(() => {
    if (entry && settings.autoplay) void play(atlas.audio(entry, settings.accent), entry.w, settings.accent);
  }, [entry, atlas, settings.autoplay, settings.accent]);
  const next = useCallback(() => {
    stopAudio();
    if (store.get().settings.sfx) void cue("flip");
    advance(elapsed());
  }, [elapsed]);
  const reveal = useCallback(() => {
    setRevealed(true);
    if (store.get().settings.sfx) void cue("flip");
    // On phones the meanings sit below the illustration: bring them into view.
    window.setTimeout(() => document.querySelector(".intro .senses")?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
  }, []);
  const known = useCallback(() => {
    stopAudio();
    markKnown(step.id);
    toast("不教了：它会在两三周后抽查一次，答错再回到计划里", "ok");
  }, [step.id]);
  useKeys(revealed ? { Enter: next, " ": next } : { Enter: reveal, " ": reveal });
  if (!entry || !ref) return <span className="spinner" />;
  return (
    <div className={`intro ${revealed ? "" : "is-guessing"}`}>
      <p className="stage-label">
        <span className="dot dot-new" /> 初次见面{revealed ? "" : " · 先猜它的意思"}
      </p>
      <WhyTags id={entry.id} />
      <div className="guess-zone" onClick={revealed ? undefined : reveal}>
        <EntryView entry={entry} mode="intro" />
        <MnemonicBlock refw={ref} />
      </div>
      <footer className="learn-actions">
        <button className="btn btn-ghost" onClick={known}>
          我早就会了
        </button>
        {revealed ? (
          <button className="btn btn-primary btn-xl" onClick={next} autoFocus>
            看完了，下一个 <ArrowRight size={20} />
          </button>
        ) : (
          <button className="btn btn-primary btn-xl" onClick={reveal} autoFocus>
            想好了，看答案 <ArrowRight size={20} />
          </button>
        )}
        <span className="hint-keys">
          <kbd>Enter</kbd> {revealed ? "继续" : "揭晓"}
        </span>
      </footer>
    </div>
  );
}

const KIND_LABEL: Record<QuizKind, string> = {
  meaning: "它是什么意思？",
  picture: "看图，补全这句话",
  listen: "听，是哪个词？",
  spell: "拼出这个词",
  paraphrase: "原文被改写了：哪个词能替换它？",
  dictation: "听写 · 雅思听力拼错不得分",
  produce: "写出这个词",
};

export const TRACK_LABEL: Record<Track, string> = { r: "阅读 · 识别", l: "听力 · 拼写", p: "写作 · 产出" };
export const GRADE_LABEL: Record<Grade, string> = { [Rating.Again]: "重来", [Rating.Hard]: "困难", [Rating.Good]: "良好", [Rating.Easy]: "轻松" } as Record<Grade, string>;

function Quiz({ step, session }: { step: Step & { kind: QuizKind }; session: ActiveSession }) {
  const atlas = useAtlas();
  const ref = atlas.byId.get(step.id)!;
  const { entry } = useEntry(step.id);
  const settings = useStore((s) => s.settings);
  const pending = session.pending;
  const elapsed = useStepTimer();
  const [hints, setHints] = useState(step.kind === "produce" ? 1 : 0);
  const syl = useSyllables(step.id);
  const pieces = useMemo(() => (syl ? parseSyllables(syl) : null), [syl]);
  const options = useMemo(() => (step.options ?? []).map((id) => atlas.byId.get(id)!).filter(Boolean), [atlas, step.options]);
  const track = trackOf(step);
  const correctId = step.kind === "paraphrase" ? step.answer : ref.id;
  const typed = step.kind === "spell" || step.kind === "produce" || step.kind === "dictation";

  const submit = useCallback(
    (value: string, correct: boolean) => {
      if (pending) return;
      const ms = elapsed() * 1000;
      if (correct) {
        const el = document.querySelector<HTMLElement>(typed ? ".slots, .dictation-field" : `[data-option="${value}"]`);
        const r = el?.getBoundingClientRect();
        if (r) burst(r.left + r.width / 2, r.top + r.height / 2);
      }
      if (settings.sfx) void cue(correct ? "correct" : "wrong");
      const hinted = step.kind === "produce" ? hints > 1 : hints > 0;
      answer(atlas, step, correct, gradeFor(step.kind, correct, ms, hinted), value, ms);
      if (entry) void play(atlas.audio(entry, settings.accent), entry.w, settings.accent);
    },
    [pending, elapsed, settings, atlas, step, hints, entry, typed],
  );

  const next = useCallback(() => {
    stopAudio();
    advance(elapsed());
  }, [elapsed]);

  const listenNow = step.kind === "dictation";
  useEffect(() => {
    if (listenNow && entry && !pending) void play(atlas.audio(entry, settings.accent), entry.w, settings.accent);
  }, [listenNow, entry, atlas, settings.accent, pending]);

  const keys: Record<string, () => void> = {};
  if (pending) {
    keys.Enter = next;
    keys[" "] = next;
  } else if (!typed) {
    options.forEach((o, i) => (keys[String(i + 1)] = () => submit(o.id, o.id === correctId)));
  }
  useKeys(keys);

  if (!entry) return <span className="spinner" />;
  const sentence = entry.ex[0] ? gap(entry.ex[0].en, entry.w) : null;
  const replay = (rate = 1) => {
    if (!pending && step.kind === "dictation") setHints((h) => h + 1);
    void play(atlas.audio(entry, settings.accent), entry.w, settings.accent, rate);
  };

  return (
    <div className={`quiz quiz-${step.kind} ${pending ? (pending.correct ? "is-right" : "is-wrong") : ""}`}>
      <p className="stage-label">
        <span className={`dot ${step.retry ? "dot-retry" : track === "r" ? "dot-review" : `dot-${track}`}`} />
        <span className={`track-chip track-${track}`}>{TRACK_LABEL[track]}</span>
        {step.retry ? `当场三连击 · 已连对 ${Math.min(RELEARN_RUN, session.relearn?.[stepKey(step)] ?? 0)}/${RELEARN_RUN} · ` : ""}
        {KIND_LABEL[step.kind]}
      </p>

      <section className="prompt">
        {step.kind === "meaning" && (
          <div className="prompt-word">
            <h2 className="headword" lang="en">
              {entry.w}
            </h2>
            <Speak url={atlas.audio(entry, settings.accent)} text={entry.w} accent={settings.accent} label={<span className="ipa">{settings.accent === "us" ? entry.us || entry.uk : entry.uk || entry.us}</span>} />
          </div>
        )}
        {step.kind === "picture" && (
          <div className="prompt-picture">
            <Illustration src={atlas.img(entry)} word={entry.w} topic={ref.topic} eager />
            <p className="cloze" lang="en">
              {sentence ? (
                <>
                  {sentence.before}
                  <span className="blank">{pending ? sentence.hidden : "　　　"}</span>
                  {sentence.after}
                </>
              ) : (
                entry.senses[0].zh
              )}
            </p>
            {sentence && pending && <p className="cloze-zh">{entry.ex[0].zh}</p>}
          </div>
        )}
        {step.kind === "paraphrase" && <ParaphrasePrompt entry={entry} pending={!!pending} />}
        {step.kind === "dictation" && (
          <div className="prompt-listen">
            <button className="listen-orb" onClick={() => replay()} aria-label="再听一遍">
              <Volume2 size={40} strokeWidth={1.6} />
              <span />
            </button>
            <button className="link" onClick={() => replay(0.7)}>
              慢速再听
            </button>
            {step.kind === "dictation" && !pending && <p className="muted small">考场只放一遍：重播会记为「困难」</p>}
          </div>
        )}
        {step.kind === "spell" && <SpellPrompt entry={entry} refw={ref} withAudio />}
        {step.kind === "produce" && <SpellPrompt entry={entry} refw={ref} withAudio={false} />}
      </section>

      {step.kind === "dictation" ? (
        <DictationInput pending={pending} onSubmit={(v) => submit(v, spelledRight(v, entry.w))} />
      ) : step.kind === "spell" || step.kind === "produce" ? (
        <SpellInput
          entry={entry}
          pending={pending}
          hints={hints}
          bySyllable={!!pieces}
          // 邪修: a hint gives a whole syllable, so the word is learned in the chunks it is spoken in.
          onHint={() => setHints((h) => Math.min(entry.w.length - 1, pieces ? nextSyllableEnd(pieces, h) : h + 1))}
          onSubmit={(v) => submit(v, spelledRight(v, entry.w) || (!!sentence && normalize(v) === normalize(sentence.hidden)))}
        />
      ) : (
        <ul className={`options ${step.kind === "meaning" ? "options-zh" : "options-en"}`}>
          {options.map((o, i) => {
            const isAnswer = o.id === correctId;
            const chosen = pending?.value === o.id;
            const cls = pending ? (isAnswer ? "is-answer" : chosen ? "is-chosen" : "is-dim") : "";
            return (
              <li key={o.id}>
                <button className={`option ${cls}`} data-option={o.id} onClick={() => submit(o.id, isAnswer)} disabled={!!pending}>
                  <kbd>{i + 1}</kbd>
                  <span lang={step.kind === "meaning" ? "zh" : "en"}>{step.kind === "meaning" ? o.zh : o.word}</span>
                  {pending && isAnswer && <Check size={20} className="option-mark" />}
                  {pending && chosen && !isAnswer && <X size={20} className="option-mark" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {pending && <Feedback entry={entry} refw={ref} step={step} session={session} correct={pending.correct} value={pending.value} onNext={next} />}
    </div>
  );
}

function ParaphrasePrompt({ entry, pending }: { entry: Entry; pending: boolean }) {
  const ex = entry.ex[1] ?? entry.ex[0];
  return (
    <div className="prompt-paraphrase">
      <p className="para-src" lang="en">
        {ex ? <Highlight text={ex.en} word={entry.w} /> : <mark>{entry.w}</mark>}
      </p>
      {ex && pending && <p className="cloze-zh">{ex.zh}</p>}
      <p className="muted small">
        题目里常不会原样出现 <b lang="en">{entry.w}</b>，而是换成意思相同的词。
      </p>
    </div>
  );
}

function SpellPrompt({ entry, refw, withAudio }: { entry: Entry; refw: WordRef; withAudio: boolean }) {
  const atlas = useAtlas();
  const accent = useStore((s) => s.settings.accent);
  const sentence = entry.ex[0] ? gap(entry.ex[0].en, entry.w) : null;
  return (
    <div className="prompt-spell">
      <Illustration src={atlas.img(entry)} word={entry.w} topic={refw.topic} eager className="spell-art" />
      <div>
        <p className="spell-zh">
          <span className="pos">{entry.senses[0].pos}</span> {entry.senses[0].zh}
        </p>
        {sentence && (
          <>
            <p className="cloze cloze-sm" lang="en">
              {sentence.before}
              <span className="blank">　　　</span>
              {sentence.after}
            </p>
            {!withAudio && <p className="cloze-zh">{entry.ex[0].zh}</p>}
          </>
        )}
        {withAudio && <Speak url={atlas.audio(entry, accent)} text={entry.w} accent={accent} size="sm" label="听发音" />}
      </div>
    </div>
  );
}

function DictationInput({ pending, onSubmit }: { pending?: { correct: boolean; value: string }; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="dictation"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && value.trim()) onSubmit(value);
      }}
    >
      <input
        className={`dictation-field ${pending ? (pending.correct ? "is-ok" : "is-bad") : ""}`}
        value={pending ? pending.value : value}
        onChange={(e) => !pending && setValue(e.target.value.slice(0, 40))}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder="听到什么，写什么"
        aria-label="听写"
        readOnly={!!pending}
        lang="en"
      />
      {!pending && (
        <div className="spell-actions">
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            确认 <kbd>Enter</kbd>
          </button>
        </div>
      )}
    </form>
  );
}

function SpellInput({
  entry,
  pending,
  hints,
  bySyllable,
  onHint,
  onSubmit,
}: {
  entry: Entry;
  pending?: { correct: boolean; value: string };
  hints: number;
  bySyllable: boolean;
  onHint: () => void;
  onSubmit: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const target = entry.w;
  const prefix = target.slice(0, hints);
  useEffect(() => {
    if (hints && !normalize(value).startsWith(normalize(prefix))) setValue(prefix);
    input.current?.focus();
  }, [hints]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = pending ? pending.value : value;
  return (
    <form
      className="spell"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && value.trim()) onSubmit(value);
      }}
    >
      <div className="slots" aria-hidden="true" onClick={() => input.current?.focus()}>
        {Array.from(target).map((ch, i) => {
          const typed = shown[i];
          const ok = typed !== undefined && typed.toLowerCase() === ch.toLowerCase();
          return (
            <span key={i} className={`slot ${ch === " " ? "slot-space" : ""} ${typed !== undefined ? (pending ? (ok ? "is-ok" : "is-bad") : "is-filled") : ""} ${!pending && i === shown.length ? "is-caret" : ""}`}>
              {pending && !pending.correct ? ch : typed ?? ""}
            </span>
          );
        })}
      </div>
      <input
        ref={input}
        className="spell-input"
        value={shown}
        onChange={(e) => !pending && setValue(e.target.value.slice(0, target.length + 6))}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label={`拼写，${target.length} 个字符`}
        readOnly={!!pending}
      />
      {!pending && (
        <div className="spell-actions">
          <button type="button" className="btn btn-ghost" onClick={onHint} disabled={hints >= target.length - 1}>
            <Lightbulb size={17} /> {bySyllable ? "提示一个音节" : "提示字母"}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            确认 <kbd>Enter</kbd>
          </button>
        </div>
      )}
    </form>
  );
}

/** Why the card got its grade: the learner sees the rule, not a black box. */
function GradeNote({ step, session }: { step: Step & { kind: QuizKind }; session: ActiveSession }) {
  const key = stepKey(step);
  const grade = session.graded[key];
  const ms = session.ms?.[key];
  if (step.retry || grade === undefined || ms === undefined) return null;
  const limit = SPEED_LIMIT[step.kind];
  const slow = grade === Rating.Hard && ms > limit;
  return (
    <p className={`grade-note g-${grade}`}>
      <Timer size={14} /> {(ms / 1000).toFixed(1)} 秒 · 记为「{GRADE_LABEL[grade]}」
      {slow && <span>{step.kind === "meaning" ? ` · 超过 ${limit / 1000} 秒，考场上等于没认出` : ` · 慢于 ${limit / 1000} 秒`}</span>}
      {grade === Rating.Hard && !slow && <span> · 用了提示或重播</span>}
      {isPractice(session) && <span> · 专项练习不改变记忆进度</span>}
    </p>
  );
}

function Feedback({ entry, refw, step, session, correct, value, onNext }: { entry: Entry; refw: WordRef; step: Step & { kind: QuizKind }; session: ActiveSession; correct: boolean; value: string; onNext: () => void }) {
  const atlas = useAtlas();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => btn.current?.focus({ preventScroll: true }), []);
  const typedMiss = !correct && (step.kind === "dictation" || step.kind === "produce") && value.trim();
  const tags = typedMiss ? diagnose(value, entry.w) : [];
  const syns = step.kind === "paraphrase" ? atlasSynonyms(atlas, entry.id).map((id) => atlas.byId.get(id)!.word) : [];
  return (
    <div className={`feedback ${correct ? "is-right" : "is-wrong"}`} role="status">
      <div className="feedback-inner">
        <Illustration src={atlas.img(entry, "thumb")} word={entry.w} topic={refw.topic} className="feedback-art" />
        <div className="feedback-text">
          <p className="feedback-verdict">{correct ? "答对了" : "没关系，记住它"}</p>
          <p className="feedback-word">
            <b lang="en">{entry.w}</b>
            <span className="ipa">{entry.uk || entry.us}</span>
          </p>
          <p className="feedback-zh">
            {entry.senses
              .slice(0, 2)
              .map((s) => `${s.pos} ${s.zh}`)
              .join("　")}
          </p>
          {typedMiss && (
            <div className="spell-diag">
              <p className="spell-diff" lang="en">
                你写的 <s>{value}</s> → 正确{" "}
                {diffMarks(value, entry.w).map((m, i) => (
                  <b key={i} className={m.bad ? "is-bad" : ""}>
                    {m.ch}
                  </b>
                ))}
              </p>
              <SyllableMiss id={entry.id} word={entry.w} value={value} />
              {tags.map((t) => (
                <p key={t} className="spell-tag">
                  <span className="chip chip-why why-spell">{SPELL_LABEL[t].name}</span> {SPELL_LABEL[t].tip}
                </p>
              ))}
            </div>
          )}
          {syns.length > 0 && (
            <p className="feedback-syn" lang="en">
              {entry.w} ≈ {syns.join(" · ")}
            </p>
          )}
          <GradeNote step={step} session={session} />
          {!correct && <HackBlock refw={refw} quiet />}
          {entry.ex[0] && (
            <p className="feedback-ex" lang="en">
              <Highlight text={entry.ex[0].en} word={entry.w} />
            </p>
          )}
        </div>
        <button ref={btn} className={`btn btn-xl ${correct ? "btn-sage" : "btn-terra"}`} onClick={onNext}>
          继续 <ArrowRight size={20} />
        </button>
      </div>
    </div>
  );
}

/** 邪修: spell it in spoken chunks; the chunk that went wrong is the one to drill. */
function SyllableMiss({ id, word, value }: { id: string; word: string; value: string }) {
  const syl = useSyllables(id);
  if (!syl) return null;
  const pieces = parseSyllables(syl);
  const starts = pieceStarts(pieces);
  const marks = diffMarks(value, word);
  const bad = pieces.map((p, i) => !p.gap && marks.slice(starts[i], starts[i] + p.text.length).some((m) => m.bad));
  const n = bad.filter(Boolean).length;
  if (!n) return null;
  return (
    <p className="spell-syl" lang="en">
      <span>按音节拼</span>
      {pieces.map((p, i) => (
        <b key={i} className={p.gap ? "is-gap" : bad[i] ? "is-bad" : ""}>
          {p.text}
        </b>
      ))}
      <small>{n === 1 ? "只错在这一节，单独念三遍再拼" : `错在 ${n} 节，一节一节念着拼`}</small>
    </p>
  );
}

function Summary({ session }: { session: ActiveSession }) {
  const atlas = useAtlas();
  useEffect(() => {
    if (store.get().settings.sfx) void cue("complete");
  }, []);
  const stats = sessionStats(session);
  const words = [...new Set(session.steps.map((s) => s.id))].map((id) => atlas.byId.get(id)!).filter(Boolean);
  const wrongIds = new Set(
    Object.entries(session.graded)
      .filter(([, g]) => g === Rating.Again)
      .map(([k]) => parseKey(k).id),
  );
  const wrong = words.filter((w) => wrongIds.has(w.id));
  const skillCount = (t: Track) => Object.keys(session.graded).filter((k) => parseKey(k).track === t).length;
  const minutes = Math.max(1, Math.round(((session.finished ?? Date.now()) - session.started) / 60000));
  const practice = isPractice(session);
  const done = () => {
    store.progress((p) => ({ ...p, session: null }));
    go({ page: practice ? "ielts" : "today" });
  };
  const again = () => {
    const { progress, settings } = store.get();
    store.progress((p) => ({ ...p, session: buildSession(atlas, progress, settings, { ids: wrong.map((w) => w.id) }) }));
  };
  return (
    <div className="learn summary">
      <div className="summary-card">
        <div className="summary-sky">
          <Galaxy mode="mini" highlight={words.map((w) => w.id)} ignite />
          <p>{practice ? `专项练习了 ${words.length} 个词` : `今天点亮了 ${words.length} 颗星`}</p>
        </div>
        <p className="eyebrow">{session.label ?? "这一程结束了"}</p>
        <h1 className="display">{stats.accuracy >= 90 ? "漂亮的一程。" : stats.accuracy >= 60 ? "稳稳向前。" : "错过的，会再相遇。"}</h1>
        <div className="summary-stats">
          <Ring value={stats.accuracy / 100} size={128} tone={stats.accuracy >= 60 ? "sage" : "terra"}>
            <b>{stats.accuracy}%</b>
            <small>首次正确</small>
          </Ring>
          <dl>
            <div>
              <dt>新词</dt>
              <dd>{session.newIds.length}</dd>
            </div>
            <div>
              <dt>识别</dt>
              <dd>{skillCount("r")}</dd>
            </div>
            <div>
              <dt>听写</dt>
              <dd>{skillCount("l")}</dd>
            </div>
            <div>
              <dt>产出</dt>
              <dd>{skillCount("p")}</dd>
            </div>
            <div>
              <dt>用时</dt>
              <dd>
                {minutes}
                <small>分钟</small>
              </dd>
            </div>
          </dl>
        </div>
        <ul className="summary-words">
          {words.map((w) => (
            <li key={w.id} className={wrongIds.has(w.id) ? "is-wrong" : ""}>
              <Illustration src={atlas.img(w, "thumb")} word={w.word} topic={w.topic} />
              <span lang="en">{w.word}</span>
              <small>{w.zh}</small>
            </li>
          ))}
        </ul>
        <p className="summary-note">
          {practice ? "专项练习只更新拼写诊断，不改变复习排程。" : "每张卡的成绩都由对错和反应时间自动判定。FSRS 已排好下次相遇：答错的会更早回来，考前两周会自动加密复习。"}
        </p>
        <div className="summary-actions">
          {wrong.length > 0 && !practice && (
            <button className="btn btn-ghost" onClick={again}>
              <RotateCcw size={18} /> 再练 {wrong.length} 个错词
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => shareSession(atlas, session)}>
            <Share2 size={18} /> 分享成绩卡
          </button>
          <button className="btn btn-primary btn-xl" onClick={done} ref={(b) => b?.focus({ preventScroll: true })}>
            完成 <ArrowRight size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Page-level shortcuts that ignore typing in inputs (except Enter, which forms handle). */
export function useKeys(map: Record<string, () => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if (typing && !(e.key === "Enter" && (t as HTMLInputElement).readOnly)) return;
      if (t.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
}
