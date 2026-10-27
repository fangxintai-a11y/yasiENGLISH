import { normalize } from "../lib/text";

/**
 * Spelling diagnosis for listening dictation. IELTS marks a misspelt answer wrong, so the app
 * names the pattern behind each miss (double letters, -ance/-ence, silent letters…) and builds
 * drills around the learner's most frequent ones.
 */

export type SpellTag = "double" | "suffix" | "ieei" | "silent" | "vowel" | "swap" | "ending" | "consonant" | "dropped" | "extra" | "mishear" | "space";

export const SPELL_LABEL: Record<SpellTag, { name: string; tip: string }> = {
  double: { name: "双写字母", tip: "accommodation、committee、necessary：听不出双写，靠词形记。" },
  suffix: { name: "后缀混淆", tip: "-ance/-ence、-able/-ible、-er/-or/-ar 读音几乎一样，按词族成组记。" },
  ieei: { name: "ie / ei 顺序", tip: "receive、believe、science：c 后多为 ei，其余多为 ie。" },
  silent: { name: "不发音字母", tip: "government 的 n、Wednesday 的 d、knowledge 的 k，听不到但要写。" },
  vowel: { name: "弱读元音", tip: "separate、definite：非重读音节都像 /ə/，要看词根拼。" },
  swap: { name: "字母顺序颠倒", tip: "手快时最常见，写完扫一眼。" },
  ending: { name: "词尾 -s / -ed / -e", tip: "听力答案要看语法：复数、过去式和结尾的 e 都算拼写。" },
  consonant: { name: "近音辅音", tip: "c/s/k、f/ph、g/j 发音相近，结合词根记。" },
  dropped: { name: "漏写字母", tip: "多出现在长词中间的弱读音节。" },
  extra: { name: "多写字母", tip: "常见于把读音直接转写成字母。" },
  mishear: { name: "听成了别的词", tip: "先用慢速多听几遍，再看词义确认。" },
  space: { name: "空格 / 连字符", tip: "复合词是否分写，需要逐个记。" },
};

/* ---------- British / American variants: IELTS accepts either ---------- */

// Only safe rewrites: each rule is limited to word shapes where both spellings are standard.
const OUR = /(col|hon|fav|behavi|lab|neighb|flav|hum|rum|harb|vap|arm|endeav|od|glam|vig|savi|splend|cand|clam|rig|tum|val|parl|fervi)(our|or)(s|ed|ing|ite|ites|able|ful)?$/;
const ISE_ONLY = /(advert|adv|compr|comprom|desp|dev|disgu|exerc|improv|rev|superv|surpr|telev|enterpr|merchand|franch|otherw|^w|^r|^ar|prec|conc|expert|prem|prom|parad|treat|no|ra|pra|po|cru|bru|chast|exc|inc)is(e|ed|es|ing)$/;
const IZE_ONLY = /(^s|se|pr|caps|ma|ba)iz(e|ed|es|ing)$/;
const RE_TER = /(cen|me|thea|li|fi|cali|spec|som|lus|mea|sabre|sepul)(tre|ter|bre|ber|gre|ger)(s?)$/;
const LL_BASES = ["travel", "cancel", "label", "model", "level", "fuel", "signal", "total", "marvel", "quarrel", "counsel", "dial", "equal", "pedal", "tunnel", "channel", "jewel", "rival", "shovel", "panel", "duel", "refuel", "remodel", "funnel"];
const PAIRS = [
  "defence defense", "offence offense", "licence license", "pretence pretense",
  "catalogue catalog", "dialogue dialog", "analogue analog", "monologue monolog", "prologue prolog",
  "programme program", "programmes programs", "cheque check", "tyre tire", "kerb curb", "plough plow", "mould mold",
  "grey gray", "aluminium aluminum", "pyjamas pajamas", "aeroplane airplane", "storey story", "manoeuvre maneuver",
  "paediatric pediatric", "encyclopaedia encyclopedia", "anaemia anemia", "judgement judgment", "ageing aging",
  "acknowledgement acknowledgment", "cosy cozy", "sceptical skeptical", "jewellery jewelry", "enrol enroll",
  "fulfil fulfill", "skilful skillful", "instalment installment", "practise practice", "draught draft",
  "doughnut donut", "moustache mustache", "sulphur sulfur", "oestrogen estrogen", "foetus fetus", "orthopaedic orthopedic",
  "archaeology archeology", "mum mom", "learnt learned", "spelt spelled", "dreamt dreamed", "burnt burned",
].map((p) => p.split(" ") as [string, string]);
const PAIR_MAP = new Map<string, string>([...PAIRS, ...PAIRS.map(([a, b]) => [b, a] as [string, string])]);

export function variants(word: string) {
  const w = normalize(word);
  const out = new Set([w]);
  const pair = PAIR_MAP.get(w);
  if (pair) out.add(pair);
  if (OUR.test(w)) out.add(w.replace(OUR, (_, a: string, o: string, s = "") => `${a}${o === "our" ? "or" : "our"}${s}`));
  const ise = /is(e|ed|es|ing|ation|ations)$/.exec(w);
  if (ise && w.length >= 6 && !ISE_ONLY.test(w)) out.add(w.slice(0, ise.index) + "iz" + ise[1]);
  const ize = /iz(e|ed|es|ing|ation|ations)$/.exec(w);
  if (ize && w.length >= 6 && !IZE_ONLY.test(w)) out.add(w.slice(0, ize.index) + "is" + ize[1]);
  if (/ys(e|ed|es|ing)$/.test(w)) out.add(w.replace(/ys(e|ed|es|ing)$/, "yz$1"));
  if (/yz(e|ed|es|ing)$/.test(w)) out.add(w.replace(/yz(e|ed|es|ing)$/, "ys$1"));
  const t = RE_TER.exec(w);
  if (t) {
    const flip: Record<string, string> = { tre: "ter", ter: "tre", bre: "ber", ber: "bre", gre: "ger", ger: "gre" };
    out.add(w.slice(0, t.index) + t[1] + flip[t[2]] + t[3]);
  }
  for (const b of LL_BASES) {
    if (!w.startsWith(b)) continue;
    const rest = w.slice(b.length);
    if (["led", "ling", "ler", "lers", "lor", "lors"].includes(rest)) out.add(b + rest.slice(1));
    if (["ed", "ing", "er", "ers", "or", "ors"].includes(rest)) out.add(b + "l" + rest);
  }
  return out;
}

export const spelledRight = (typed: string, word: string) => variants(word).has(normalize(typed));

/* ---------- alignment ---------- */

type Op = { t: "sub" | "del" | "ins" | "swap"; i: number; a: string; b: string };

/** Damerau–Levenshtein with a backtrace; i indexes the target word. */
export function align(target: string, typed: string): Op[] {
  const a = target;
  const b = typed;
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] && d[i][j] === d[i - 2][j - 2] + 1 && a[i - 1] !== a[i - 2]) {
      ops.push({ t: "swap", i: i - 2, a: a.slice(i - 2, i), b: b.slice(j - 2, j) });
      i -= 2;
      j -= 2;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) ops.push({ t: "sub", i: i - 1, a: a[i - 1], b: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ t: "del", i: i - 1, a: a[i - 1], b: "" });
      i--;
    } else {
      ops.push({ t: "ins", i, a: "", b: b[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

const VOWELS = new Set("aeiouy");
const SUFFIXES = /(ance|ence|ancy|ency|ant|ent|able|ible|ary|ery|ory|er|or|ar|tion|sion|cian|ous|ious|eous|ise|ize|ful|ly|ment)$/;

function silentAt(w: string, i: number) {
  const c = w[i];
  const prev = w[i - 1] ?? "";
  const next = w[i + 1] ?? "";
  return (
    (c === "k" && next === "n") ||
    (c === "w" && next === "r") ||
    (c === "b" && (prev === "m" || next === "t")) ||
    (c === "n" && (prev === "m" || next === "m")) ||
    (c === "g" && (next === "n" || next === "h")) ||
    (c === "h" && "gwrc".includes(prev)) ||
    (c === "t" && next === "l" && prev === "s") ||
    (c === "d" && (next === "g" || w.startsWith("wed"))) ||
    (c === "p" && i === 0 && "sn".includes(next)) ||
    (c === "c" && prev === "s") ||
    (c === "r" && next === "o" && prev === "i") ||
    (c === "e" && i === w.length - 1)
  );
}

/** Name the patterns behind one misspelling. */
export function diagnose(typedRaw: string, wordRaw: string): SpellTag[] {
  const word = normalize(wordRaw);
  const typed = normalize(typedRaw);
  if (!typed || variants(word).has(typed)) return [];
  if (word.replace(/[\s-]/g, "") === typed.replace(/[\s-]/g, "")) return ["space"];
  const ops = align(word, typed);
  if (ops.length > Math.max(2, Math.round(word.length * 0.45))) return ["mishear"];
  const tags = new Set<SpellTag>();
  const suffixStart = (word.match(SUFFIXES)?.index ?? word.length) - 1;
  for (const op of ops) {
    if (op.t === "swap") {
      tags.add(/ie|ei/.test(op.a) ? "ieei" : "swap");
      continue;
    }
    const inSuffix = op.i >= suffixStart && suffixStart >= 0 && suffixStart < word.length - 1;
    const atEnd = op.i >= word.length - 2;
    if (op.t === "del") {
      if (word[op.i] === word[op.i - 1] || word[op.i] === word[op.i + 1]) tags.add("double");
      else if (atEnd && "sde".includes(op.a)) tags.add("ending");
      else if (silentAt(word, op.i)) tags.add("silent");
      else if (inSuffix) tags.add("suffix");
      else tags.add("dropped");
    } else if (op.t === "ins") {
      if (op.b === word[op.i - 1] || op.b === word[op.i]) tags.add("double");
      else if (op.i >= word.length - 1 && "sde".includes(op.b)) tags.add("ending");
      else if (inSuffix) tags.add("suffix");
      else tags.add("extra");
    } else {
      if (inSuffix) tags.add("suffix");
      else if (VOWELS.has(op.a) && VOWELS.has(op.b)) tags.add("vowel");
      else if (!VOWELS.has(op.a) && !VOWELS.has(op.b)) tags.add("consonant");
      else tags.add("vowel");
    }
  }
  return [...tags].slice(0, 3);
}

/** Does this word exercise a pattern? Used to build targeted dictation drills. */
export function hasPattern(tag: SpellTag, wordRaw: string) {
  const w = normalize(wordRaw);
  switch (tag) {
    case "double":
      return /([a-z])\1/.test(w);
    case "suffix":
      return /(ance|ence|ant|ent|able|ible|ary|ery|ory|or|ar)$/.test(w);
    case "ieei":
      return /ie|ei/.test(w);
    case "silent":
      return /kn|wr|mb|mn|gn|gh|stle|dg|^ps|sc[ie]|wed/.test(w);
    case "vowel":
      return w.length >= 7 && /[aeiou][^aeiou]+[aeiou][^aeiou]+[aeiou]/.test(w);
    case "ending":
      return /(e|s|ed)$/.test(w);
    case "consonant":
      return /ph|c[ei]|ck|x|qu|g[ei]/.test(w);
    case "space":
      return /[\s-]/.test(w);
    default:
      return w.length >= 6;
  }
}

/** Character-level diff for the feedback panel: which letters were right, wrong or missing. */
export function diffMarks(typedRaw: string, wordRaw: string) {
  const word = normalize(wordRaw);
  const typed = normalize(typedRaw);
  const ops = align(word, typed);
  const bad = new Set<number>();
  for (const op of ops) {
    if (op.t === "swap") {
      bad.add(op.i);
      bad.add(op.i + 1);
    } else if (op.t === "ins") bad.add(Math.min(word.length - 1, op.i));
    else bad.add(op.i);
  }
  return Array.from(word).map((ch, i) => ({ ch, bad: bad.has(i) }));
}
