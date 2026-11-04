import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile), zeroHash = "0".repeat(64);
const digest = value => createHash("sha256").update(value).digest("hex");
const idOf = value => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150);
const issue = (sourceRef, reason) => ({ sourceRef, reason });
const result = () => ({ materials: [], issues: [], audioCopies: [] });
const merge = (target, next) => { target.materials.push(...next.materials); target.issues.push(...next.issues); target.audioCopies.push(...next.audioCopies); return target; };
const numberWords = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function plain(value) {
  return String(value ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n)))
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, entity => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" }[entity]))
    .replace(/[ \t]+/g, " ").trim();
}
function accepted(raw) {
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? raw.a ?? raw.accepted ?? raw.answer ?? [] : [raw];
  return [...new Set((Array.isArray(values) ? values : [values]).flatMap(value => {
    if (typeof value !== "string" && typeof value !== "number") return [];
    return String(value).split(/\s*\/\s*|\s+OR\s+/i).flatMap(part => {
      const text = part.trim(); if (!text) return [];
      const optional = /\(([^()]*)\)/.exec(text);
      return optional ? [text.replace(optional[0], "").replace(/\s+/g, " ").trim(), text.replace(optional[0], optional[1]).replace(/\s+/g, " ").trim()] : [text];
    });
  }).filter(Boolean))];
}
function wordLimit(instructions, type) {
  if (["true-false-not-given", "yes-no-not-given"].includes(type)) return 3;
  if (/choice|matching|labeling/.test(type)) return 1;
  const match = /(?:NO MORE THAN\s+)?(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|\d+)\s+WORDS?/i.exec(instructions.replace(/\*/g, ""));
  // No source word limit is invented; 100 is the schema's unconstraining cap.
  return match ? Math.min(100, Number(match[1]) || numberWords[match[1].toLowerCase()]) : 100;
}
function optionsOf(values) {
  const options = Array.isArray(values) ? values.map(value => typeof value === "string" ? { id: value.trim(), text: value.trim() }
    : Array.isArray(value) ? { id: String(value[0]).trim(), text: plain(value[1]) || String(value[0]) }
      : { id: String(value.key ?? value.id ?? "").trim(), text: plain(value.text) || String(value.key ?? value.id ?? "") }).filter(value => value.id) : undefined;
  return options?.length ? options : undefined;
}
function completionType(instructions, skill) {
  const text = instructions.toLowerCase();
  if (/short.answer|answer the questions/.test(text)) return "short-answer";
  if (/flow/.test(text)) return "flow-chart-completion";
  if (/diagram/.test(text)) return skill === "reading" ? "diagram-label-completion" : "map-labeling";
  if (/table/.test(text)) return "table-completion";
  if (/summary/.test(text)) return "summary-completion";
  if (/sentences?/.test(text)) return "sentence-completion";
  if (/form/.test(text) && skill === "listening") return "form-completion";
  return "note-completion";
}
function tokens(value) { return plain(value).toLowerCase().match(/[a-z]+/g)?.filter(word => word.length > 3 && !["that", "this", "with", "from", "which", "what", "have", "does", "there", "their", "they", "about", "paragraph", "section"].includes(word)) ?? []; }
function containsAnswer(text, answer) {
  const normalize = value => String(value).toLowerCase().replace(/(?<=\d),(?=\d{3}\b)/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const wanted = normalize(answer);
  return wanted.length > 1 && ` ${normalize(text)} `.includes(` ${wanted} `);
}
function evidenceFor(original, prompt, answers, paragraphs, targetParagraph) {
  const target = paragraphs?.find(p => p.id === targetParagraph);
  const chunks = (target ? [target.text] : paragraphs?.map(p => p.text) ?? original.split(/\n|(?<=[.!?])\s+/)).filter(Boolean);
  const wanted = new Set(tokens(prompt));
  const scored = chunks.map((text, index) => ({ text, index, score: answers.some(answer => containsAnswer(text, answer)) ? 100 : tokens(text).filter(token => wanted.has(token)).length })).sort((a, b) => b.score - a.score || a.index - b.index);
  const found = scored[0]?.score > 0 ? scored[0].text : undefined;
  if (!found) return { rationale: "来源未提供可确认的逐题证据，待人工核对。" };
  const quote = found.slice(0, 8000), paragraph = paragraphs?.find(p => p.text.includes(quote));
  const anchored = paragraph?.text ?? original;
  return { quote, ...(paragraph ? { paragraphId: paragraph.id } : {}), ...(anchored.includes(quote) ? { offset: anchored.indexOf(quote) } : {}), rationale: "原词定位的相关语境，未代替对原材料答案的人工核对。" };
}
function blocksText(content = []) {
  return content.flatMap(block => block.t === "table" ? (block.rows ?? []).map(row => row.join(" | ")) : block.t === "flow" ? block.steps ?? [] : block.text ? [block.text] : []).join("\n");
}
function mapGroups(groups, answers, { skill, sourceRef, original = "", paragraphs = [] }) {
  const questions = [], issues = [], instructions = [];
  for (const [index, group] of (groups ?? []).entries()) {
    const at = `${sourceRef}:${group.id ?? index + 1}`, rubric = (group.instructions ?? [group.instruction ?? ""]).join("\n");
    instructions.push(...(group.instructions ?? [group.instruction]).filter(Boolean));
    if (group.image || (group.content ?? []).some(block => block.t === "img") || ["map", "diagram"].includes(group.layout)) { issues.push(issue(at, "题组依赖题图，当前文字导入不能忠实呈现，整组待人工核对。")); continue; }
    let type;
    if (group.type === "tfng") type = "true-false-not-given";
    else if (group.type === "ynng") type = "yes-no-not-given";
    else if (["choice", "single", "multi", "multiple"].includes(group.type)) type = "multiple-choice";
    else if (["completion", "fill"].includes(group.type)) type = completionType(rubric, skill);
    else if (group.type === "matching") type = skill === "listening" ? "matching" : /headings/i.test(`${rubric} ${group.optionsTitle ?? ""}`) ? "matching-headings" : /ending/i.test(rubric) ? "matching-sentence-endings" : /paragraph|section.*contains|information/i.test(rubric) ? "matching-information" : "matching-features";
    else { issues.push(issue(at, `不支持的题型 ${group.type ?? "unknown"}，整组跳过。`)); continue; }
    const context = [group.title, blocksText(group.content), ...(group.bodyLines ?? []).map(line => typeof line === "string" ? line : line.text)].filter(Boolean).join("\n");
    let rows = group.questions ?? [];
    if (["completion", "fill"].includes(group.type) && !rows.length) rows = [...context.matchAll(/\{\{(\d+)\}\}/g)].map(match => ({ n: Number(match[1]), text: context }));
    const multi = ["multi", "multiple"].includes(group.type);
    if (multi) {
      const range = group.n ?? (group.range ? Array.from({ length: group.range[1] - group.range[0] + 1 }, (_, i) => group.range[0] + i) : String(group.id).match(/\d+/g)?.map(Number) ?? []);
      rows = range.map(n => ({ n, text: group.text ?? group.questionText ?? group.title }));
    }
    const staged = [];
    for (const row of rows) {
      const n = Number(Array.isArray(row) ? row[0] : row.n ?? row.id), text = plain(Array.isArray(row) ? row[1] : row.text ?? row.prompt);
      const labels = type === "true-false-not-given" ? ["TRUE", "FALSE", "NOT GIVEN"] : type === "yes-no-not-given" ? ["YES", "NO", "NOT GIVEN"] : null;
      const values = [...new Set(accepted(answers[String(n)] ?? answers[`q${n}`]).map(value => labels ? value.toUpperCase().replace(/\s+/g, " ") : value))];
      if (!Number.isInteger(n) || n < 1 || !text || !values.length) { issues.push(issue(at, `第${Number.isInteger(n) ? n : "未知"}题缺题干或答案，整组待核并跳过。`)); staged.length = 0; break; }
      if (labels && values.some(value => !labels.includes(value))) { issues.push(issue(at, `第${n}题来源答案标签与题型不符，整组待核。`)); staged.length = 0; break; }
      const candidates = optionsOf(row.options) ?? optionsOf(group.options);
      const requiresOptions = /choice|matching|labeling/.test(type);
      let opts = labels ? undefined : candidates;
      if (!requiresOptions && !labels && opts && values.some(value => !opts.some(option => option.id === value))) {
        if (values.every(value => /^[A-Z]$|^[ivx]+$/.test(value))) { issues.push(issue(at, `第${n}题的字母选项未完整解析，整组待核。`)); staged.length = 0; break; }
        opts = undefined;
      }
      if ((requiresOptions && !opts?.length) || opts && (new Set(opts.map(option => option.id)).size !== opts.length || values.some(value => !opts.some(option => option.id === value)))) { issues.push(issue(at, `第${n}题选项缺失、重复或答案不在源选项中，整组跳过。`)); staged.length = 0; break; }
      const paragraphLabel = type === "matching-headings" ? /(?:paragraph|section)\s+([A-Z])\b/i.exec(text)?.[1]?.toUpperCase() : type === "matching-information" ? values[0] : undefined;
      const paragraph = paragraphLabel ? paragraphs.find(p => p.label === paragraphLabel) : undefined;
      if (type === "matching-headings" && !paragraph) { issues.push(issue(at, `第${n}题引用段落不存在，整组跳过。`)); staged.length = 0; break; }
      staged.push({ id: idOf(`${sourceRef}-q${n}`), number: n, type, prompt: [rubric, context && !context.includes(text) ? context : "", text].filter(Boolean).join("\n"),
        answer: { accepted: values, maxWords: wordLimit(rubric, type), ...(/\bAND\s*(?:\/\s*OR)?\s+(?:(?:A|ONE)\s+)?NUMBER\b/i.test(rubric.replace(/\*/g, "")) ? { allowNumber: true } : {}) }, ...(opts ? { options: opts } : {}), ...(paragraph && type === "matching-headings" ? { paragraphId: paragraph.id } : {}),
        ...(multi ? { groupId: idOf(`${sourceRef}-${group.id ?? `multi-${n}`}`), selectionCount: Number(group.select ?? group.limit ?? rows.length) } : {}),
        evidence: evidenceFor(original, text, values, paragraphs, paragraph?.id), answerVerified: false });
    }
    questions.push(...staged);
  }
  return { questions, issues, instructions: [...new Set(instructions)].slice(0, 30) };
}
function commonMaterial(sourceRef, skill, title, examId, notes = []) {
  return { id: idOf(sourceRef), version: "r4-import-1", title: title.slice(0, 500), deliveryMode: "local-import", skill, scope: "section", contentHash: zeroHash,
    source: { materialSource: "cambridge", sourceRef, rights: "User-provided local Cambridge material; original publisher retains rights.", answerVerified: false }, examId, notes: notes.map(String).filter(Boolean).slice(0, 100) };
}
export function mapYanboExam(exam, { audioBySection = {}, transcripts = {} } = {}) {
  const output = result(), book = Number(exam.source?.book ?? exam.book), test = Number(exam.source?.test ?? exam.test), examId = `C${book}T${test}`;
  if (!Number.isInteger(book) || !Number.isInteger(test)) { output.issues.push(issue(exam.id ?? "cambridge", "书号或试卷号无效。")); return output; }
  for (const passage of exam.reading?.passages ?? []) {
    const sourceRef = `${examId}R${passage.passage}`;
    if (passage.paragraphs?.some(p => p.kind === "img")) { output.issues.push(issue(sourceRef, "正文依赖题图，整篇待人工核对。")); continue; }
    const paragraphs = (passage.paragraphs ?? []).filter(p => typeof p.text === "string" && p.text.trim()).map((p, i) => ({ id: idOf(`${sourceRef}-p-${p.label ?? i + 1}`), text: p.text.trim(), ...(p.label ? { label: String(p.label) } : {}) }));
    const original = paragraphs.map(p => p.text).join(" "), mapped = mapGroups(passage.groups, exam.reading.answers ?? {}, { skill: "reading", sourceRef, original, paragraphs });
    output.issues.push(...mapped.issues);
    if (!original || !mapped.questions.length) { output.issues.push(issue(sourceRef, "没有可独立作答的正文和题组。")); continue; }
    output.materials.push({ ...commonMaterial(sourceRef, "reading", passage.title ?? `${examId} Reading ${passage.passage}`, examId, exam.issues), passageNumber: passage.passage, passage: original, paragraphs, questions: mapped.questions, instructions: mapped.instructions, estimatedMinutes: 20 });
  }
  for (const part of exam.listening?.parts ?? []) {
    const sourceRef = `${examId}S${part.part}`, audio = audioBySection[part.part], transcript = String(part.transcript ?? transcripts[part.part] ?? "").trim();
    if (!audio || !(audio.durationSeconds > 0)) { output.issues.push(issue(sourceRef, "缺少可校验的分节音频，未导入。")); continue; }
    if (!transcript) { output.issues.push(issue(sourceRef, "缺少这一节原文，未冒充完整听力材料。")); continue; }
    const mapped = mapGroups(part.groups, exam.listening.answers ?? {}, { skill: "listening", sourceRef, original: transcript }); output.issues.push(...mapped.issues);
    if (!mapped.questions.length) continue;
    output.materials.push({ ...commonMaterial(sourceRef, "listening", `${examId} Listening Section ${part.part}`, examId, exam.issues), section: part.part, transcript, questions: mapped.questions, instructions: mapped.instructions,
      audio: { path: audio.path, durationSeconds: audio.durationSeconds, ...(audio.sha256 ? { sha256: audio.sha256 } : {}) }, estimatedMinutes: Math.max(1, Math.min(180, Math.ceil((audio.durationSeconds + 60) / 60))) });
    output.audioCopies.push(audio);
  }
  return output;
}

/** Conservative plain-text parsing: unrecognised groups remain explicit gaps. */
export function parseStructuredQuestions(text, answers, { skill, sourceRef, original = "", paragraphs = [] }) {
  const clean = plain(text).replace(/\*\*/g, ""), groups = [], issues = [];
  const matches = [...clean.matchAll(/\bQuestions?\s+(\d{1,2})(?:\s*(?:[–—-]|and)\s*(\d{1,2}))?/gi)];
  for (const [index, match] of matches.entries()) {
    const first = Number(match[1]), last = Number(match[2] ?? match[1]), body = clean.slice(match.index + match[0].length, matches[index + 1]?.index ?? clean.length).trim();
    if (first > last || last > 40) { issues.push(issue(sourceRef, "无效的题号范围，整组跳过。")); continue; }
    let type;
    if (/TRUE\s*[/, ]+\s*FALSE|TRUE\b[\s\S]*FALSE\b[\s\S]*NOT GIVEN/i.test(body)) type = "tfng";
    else if (/YES\s*[/, ]+\s*NO|YES\b[\s\S]*NO\b[\s\S]*NOT GIVEN/i.test(body)) type = "ynng";
    else if (/label.*(?:map|plan|diagram)/i.test(body)) { issues.push(issue(sourceRef, `Questions ${first}–${last}需要原题图，整组待核。`)); continue; }
    else if (/choose\s+(?:TWO|THREE|\d+)\s+letters?/i.test(body)) type = "multi";
    else if (/choose\s+(?:the\s+)?correct\s+letter/i.test(body)) type = "choice";
    else if (/headings?|which\s+(?:paragraph|section)|matching|match.*following|choose\s+\w+\s+answers?\s+from/i.test(body)) type = "matching";
    else if (/complete|answer the questions|words?\s+(?:only|and|or)|no more than/i.test(body)) type = "completion";
    else { issues.push(issue(sourceRef, `Questions ${first}–${last}题型无法确认，整组跳过。`)); continue; }
    const lines = body.split(/\n/).map(line => line.trim()).filter(Boolean), numbered = [];
    for (const [lineIndex, line] of lines.entries()) {
      const n = /^(\d{1,2})\s*[.)]\s*(.*)/.exec(line);
      if (n && Number(n[1]) >= first && Number(n[1]) <= last) {
        const following = lines.slice(lineIndex + 1, lines.findIndex((other, i) => i > lineIndex && /^\d{1,2}\s*[.)]/.test(other)) >= 0 ? lines.findIndex((other, i) => i > lineIndex && /^\d{1,2}\s*[.)]/.test(other)) : lines.length);
        numbered.push({ n: Number(n[1]), text: n[2], options: following.flatMap(value => { const option = /^([A-Z]|[ivx]+)\s*[.)]?\s+(.+)/.exec(value); return option ? [{ key: option[1], text: option[2] }] : []; }) });
      }
    }
    const options = lines.flatMap(line => { const option = /^([A-Z]|[ivx]+)\s*[.)]?\s+(.+)/.exec(line); return option ? [{ key: option[1], text: option[2] }] : []; });
    const group = { id: `text-${first}-${last}`, type, range: [first, last], instructions: [body.slice(0, 4000)], questions: numbered, ...(options.length ? { options } : {}) };
    if (type === "completion") {
      group.questions = [];
      for (let n = first; n <= last; n++) {
        const marker = new RegExp(`(?:\\(\\s*${n}\\s*\\)|\\{\\{${n}\\}\\}|(?:^|\\n)\\s*${n}\\s*[.)]|\\b${n}\\s*(?=_{2,}|[.…]{2,}))`);
        const line = lines.find(value => marker.test(value));
        if (line) group.questions.push({ n, text: line });
      }
    }
    if (type === "multi") { group.n = Array.from({ length: last - first + 1 }, (_, i) => first + i); group.select = group.n.length; group.text = lines.filter(line => !/^[A-Z]\s*[.)]?\s+/.test(line)).join("\n"); }
    if (type === "matching" && /headings?/i.test(body)) group.optionsTitle = "List of Headings";
    if ((type !== "multi" && group.questions.length !== last - first + 1) || (type === "choice" && group.questions.some(q => !q.options.length))) { issues.push(issue(sourceRef, `Questions ${first}–${last}题干或选项未完整拆出，整组待核。`)); continue; }
    groups.push(group);
  }
  const mapped = mapGroups(groups, answers, { skill, sourceRef, original, paragraphs }); mapped.issues.unshift(...issues);
  if (!matches.length) mapped.issues.push(issue(sourceRef, "没有可识别的Questions题组，未猜测题目。"));
  return mapped;
}

function srtTime(value) {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : null;
}
export function parseXiaHuaHtml(html, { sourceRef, section, audio, frequency } = {}) {
  const output = result();
  try {
    const script = /<script\b[^>]*\bid=["']test-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    // Current source derives CONFIG_DATA from this JSON. Never execute its scripts.
    if (!script) throw new Error("没有安全的test-data JSON，旧式脚本配置待人工核对。");
    const data = JSON.parse(script[1]), answers = {};
    for (const category of Object.values(data.answerKey ?? {})) {
      if (!category || typeof category !== "object") continue;
      for (const [key, value] of Object.entries(category)) {
        const numbers = key.match(/\d+/g)?.map(Number) ?? [];
        if (numbers.length > 1 && Array.isArray(value) && value.length === numbers.length) numbers.forEach((n, i) => { answers[n] = value[i]; });
        else if (numbers.length === 1 && accepted(value).length) answers[numbers[0]] = value;
      }
    }
    const lines = (data.transcriptLines ?? []).map(line => {
      const [start, end] = String(line.time ?? "").split("-->").map(srtTime);
      return { text: plain(line.html ?? line.text), start, end };
    }).filter(line => line.text);
    const transcript = lines.map(line => line.text).join(" ");
    if (!transcript) throw new Error("缺少原文，未导入。");
    if (!audio || !(audio.durationSeconds > 0)) throw new Error("缺少可校验的本机音频，未导入。");
    const mapped = mapGroups(data.groups, answers, { skill: "listening", sourceRef, original: transcript }); output.issues.push(...mapped.issues);
    if (!mapped.questions.length) throw new Error("没有可独立作答的题组。");
    for (const question of mapped.questions) {
      const found = lines.find(line => question.answer.accepted.some(value => containsAnswer(line.text, value)));
      if (found) {
        question.evidence = { quote: found.text, offset: transcript.indexOf(found.text), rationale: "来源原文的原词定位，答案仍待核对。" };
        if (found.start !== null && found.end !== null && found.start < found.end && found.end <= audio.durationSeconds) Object.assign(question.evidence, { startSeconds: found.start, endSeconds: found.end });
      }
    }
    output.materials.push({ id: idOf(sourceRef), version: "r4-import-1", title: String(data.title ?? sourceRef).slice(0, 500), deliveryMode: "local-import", skill: "listening", scope: "section", contentHash: zeroHash,
      source: { materialSource: "unofficial", sourceRef, rights: "User-provided local XiaHua source; original rights retained.", answerVerified: false },
      section, ...(frequency ? { frequency } : {}), transcript, questions: mapped.questions, instructions: mapped.instructions,
      audio: { path: audio.path, durationSeconds: audio.durationSeconds, ...(audio.sha256 ? { sha256: audio.sha256 } : {}) }, estimatedMinutes: Math.max(1, Math.min(180, Math.ceil((audio.durationSeconds + 60) / 60))) });
    output.audioCopies.push(audio);
  } catch (error) { output.issues.push(issue(sourceRef ?? "xiahua", error.message)); }
  return output;
}
export function transcriptSimilarity(left, right) {
  const words = value => plain(value).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const shingles = list => new Set(list.length < 4 ? list : list.slice(0, -3).map((_, index) => list.slice(index, index + 4).join(" ")));
  const a = shingles(words(left)), b = shingles(words(right));
  if (!a.size || !b.size) return 0;
  let intersection = 0; for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
async function walk(folder) {
  const out = [];
  let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return out; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...await walk(file)); else if (entry.isFile()) out.push(file);
  }
  return out;
}
async function exists(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function boundedFile(root, candidate) {
  const base = await fs.realpath(root), file = await fs.realpath(path.resolve(root, candidate));
  if (file !== base && !file.startsWith(base + path.sep)) throw new Error("音频路径越出导入目录，已拒绝读取。");
  return file;
}
export async function probeAudio(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file], { timeout: 30_000, maxBuffer: 1_000_000 });
  const info = JSON.parse(stdout), durationSeconds = Number(info.format?.duration);
  if (!(durationSeconds > 0) || durationSeconds > 7200 || !info.streams?.some(stream => stream.codec_type === "audio")) throw new Error("音频无法解码或时长超出允许范围。");
  return { durationSeconds };
}
async function audioPlan(root, candidate, sourceRef, probe = probeAudio) {
  const file = await boundedFile(root, candidate), stat = await fs.stat(file);
  if (!stat.size || stat.size > 50 * 1024 * 1024) throw new Error("音频为空或超过50 MB。");
  const metadata = await probe(file), durationSeconds = typeof metadata === "number" ? metadata : metadata.durationSeconds;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 7200) throw new Error("音频时长校验失败。");
  const sha256 = digest(await fs.readFile(file)), extension = path.extname(file).toLowerCase();
  return { from: file, path: `audio/${idOf(sourceRef)}${[".mp3", ".m4a", ".ogg", ".wav", ".webm"].includes(extension) ? extension : ".mp3"}`, sha256, bytes: stat.size, durationSeconds };
}
function transcriptPart(markdown, test, section) {
  const tests = [...markdown.matchAll(/^\s*(?:#{1,6}\s*)?\*{0,2}TEST\s+(\d+)\b[^\n]*$/gim)];
  const index = tests.findIndex(match => Number(match[1]) === test);
  if (index < 0) return "";
  const body = markdown.slice(tests[index].index + tests[index][0].length, tests[index + 1]?.index ?? markdown.length);
  const parts = [...body.matchAll(/^\s*(?:#{1,6}\s*)?\*{0,2}(?:SECTION|PART)\s+([1-4])\b[^\n]*$/gim)], at = parts.findIndex(match => Number(match[1]) === section);
  return at < 0 ? "" : body.slice(parts[at].index + parts[at][0].length, parts[at + 1]?.index ?? body.length).trim();
}
async function audioForExam(root, book, test, supplied = [], probe = probeAudio) {
  const found = {}, issues = [];
  for (let section = 1; section <= 4; section++) {
    const primary = `listening/maslow-cam1-20/ielts_listening/book_${String(book).padStart(2, "0")}/test_${test}_part_${section}.mp3`;
    const named = supplied.find(file => Number(/(?:part|section|[\/_-]s)[ _-]*([1-4])\b/i.exec(file)?.[1]) === section);
    const alternatives = [primary, named, supplied.length === 4 ? supplied[section - 1] : null].filter(Boolean);
    const candidate = alternatives.find(file => !path.isAbsolute(file) || file.startsWith(path.resolve(root) + path.sep));
    let picked;
    for (const file of alternatives) if (await exists(path.resolve(root, file))) { picked = file; break; }
    if (!picked) { issues.push(issue(`C${book}T${test}S${section}`, `缺少分节mp3（${candidate ?? primary}）。`)); continue; }
    try { found[section] = await audioPlan(root, picked, `C${book}T${test}S${section}`, probe); }
    catch (error) { issues.push(issue(`C${book}T${test}S${section}`, `音频未通过校验：${error.message}`)); }
  }
  return { found, issues };
}
function completeExams(materials, skill) {
  const groups = new Map();
  for (const material of materials) if (material.skill === skill && material.source.materialSource === "cambridge" && material.examId && material.scope !== "short") groups.set(material.examId, [...groups.get(material.examId) ?? [], material]);
  return [...groups].filter(([, rows]) => {
    if (rows.some(row => row.scope === "full" && row.questions.length === 40 && new Set(row.questions.map(q => q.number)).size === 40 && Array.from({ length: 40 }, (_, i) => i + 1).every(n => row.questions.some(q => q.number === n)) && row.questions.every(q => q.answer.accepted.length) && (skill !== "listening" || row.audio && row.transcript.trim()))) return true;
    rows = rows.filter(row => row.scope === "section");
    const parts = new Set(rows.map(row => skill === "reading" ? row.passageNumber : row.section)), numbers = rows.flatMap(row => row.questions.map(q => q.number));
    return parts.size === (skill === "reading" ? 3 : 4) && numbers.length === 40 && new Set(numbers).size === 40 && Array.from({ length: 40 }, (_, i) => i + 1).every(n => numbers.includes(n)) && (skill !== "listening" || rows.every(row => row.audio && row.transcript.trim()));
  }).map(([id]) => id);
}
export function assignHoldout(materials, { seed = "band-r4-v1", existing } = {}) {
  const manifest = { version: 1, seed: typeof existing?.seed === "string" ? existing.seed : seed, reading: [], listening: [] }, issues = [];
  for (const skill of ["reading", "listening"]) {
    const eligible = completeExams(materials, skill), previous = Array.isArray(existing?.[skill]) ? [...new Set(existing[skill].filter(id => typeof id === "string"))].slice(0, 8) : [];
    const ranked = eligible.filter(id => !previous.includes(id)).sort((a, b) => digest(`${manifest.seed}:${skill}:${a}`).localeCompare(digest(`${manifest.seed}:${skill}:${b}`)));
    manifest[skill] = [...previous, ...ranked.slice(0, 8 - previous.length)];
    const available = manifest[skill].filter(id => eligible.includes(id)).length;
    if (available < 8) issues.push(issue(`holdout:${skill}`, `完整独立检查池还缺${8 - available}套；不以缺题、缺音频或未解析材料补足。`));
  }
  return { materials: materials.map(material => ({ ...material, pool: manifest[material.skill].includes(material.examId) ? "holdout" : "practice" })), holdoutManifest: manifest, issues };
}

function fullReading(materials) {
  const eligible = completeExams(materials, "reading"), full = [];
  for (const examId of eligible) {
    if (materials.some(material => material.examId === examId && material.skill === "reading" && material.scope === "full")) continue;
    const parts = materials.filter(material => material.examId === examId && material.skill === "reading" && material.scope === "section").sort((a, b) => a.passageNumber - b.passageNumber);
    let offset = 0; const questions = [], paragraphs = [];
    for (const part of parts) {
      paragraphs.push(...part.paragraphs);
      questions.push(...part.questions.map(question => ({ ...question, evidence: { ...question.evidence, ...(typeof question.evidence.offset === "number" && !(question.evidence.paragraphId ?? question.paragraphId) ? { offset: question.evidence.offset + offset } : {}) } })));
      offset += part.passage.length + 1;
    }
    const first = parts[0];
    full.push({ ...commonMaterial(examId, "reading", `${examId} Academic Reading — complete paper`, examId, first.notes), id: idOf(`${examId}-reading-full`), scope: "full", passage: parts.map(part => part.passage).join(" "), paragraphs, questions,
      instructions: [...new Set(parts.flatMap(part => part.instructions ?? []))].slice(0, 30), estimatedMinutes: 60 });
  }
  return full;
}
async function readJSON(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function bookTranscript(root, book) {
  try { return await fs.readFile(path.join(root, `listening/maslow-cam1-20/ielts_listening/book_${String(book).padStart(2, "0")}/audioscripts.md`), "utf8"); } catch { return ""; }
}
function structuredReading(document) {
  const output = result(), examId = `C${document.book}T${document.test}`, text = String(document.text ?? "");
  const marks = [...text.matchAll(/^\s*READING PASSAGE\s+([1-3])\b[^\n]*$/gim)];
  const boundaries = marks.map(match => ({ start: match.index, number: Number(match[1]) }));
  if (!boundaries.length || boundaries[0].number !== 1) boundaries.unshift({ start: 0, number: 1 });
  for (const [index, boundary] of boundaries.entries()) {
    const body = text.slice(boundary.start, boundaries[index + 1]?.start ?? text.length), firstQuestion = /\bQuestions?\s+\d{1,2}/i.exec(body);
    const sourceRef = `${examId}R${boundary.number}`;
    if (!firstQuestion) { output.issues.push(issue(sourceRef, "未找到正文后的题组，未导入。")); continue; }
    const original = body.slice(0, firstQuestion.index).replace(/^\s*entry-content[^\n]*\n?/i, "").replace(/^\s*READING PASSAGE\s+[1-3]\s*$/im, "").trim();
    const paragraphs = original.split(/\n+/).map(value => value.trim()).filter(Boolean).map((text, i) => {
      const label = /^([A-Z])\s+[A-Z'“"]/.exec(text)?.[1];
      return { id: idOf(`${sourceRef}-p-${label ?? i + 1}`), text, ...(label ? { label } : {}) };
    });
    const passage = paragraphs.map(p => p.text).join(" ");
    const mapped = parseStructuredQuestions(body.slice(firstQuestion.index), document.answers ?? {}, { skill: "reading", sourceRef, original: passage, paragraphs }); output.issues.push(...mapped.issues);
    // Without identifiable passage boundaries, never attach all forty questions to passage one.
    const numbers = mapped.questions.map(q => q.number);
    if (!passage || !mapped.questions.length || (boundaries.length === 1 && numbers.some(n => n > 16))) { output.issues.push(issue(sourceRef, "分篇正文边界无法确认，待人工核对，未冒充整套阅读。")); continue; }
    output.materials.push({ ...commonMaterial(sourceRef, "reading", `${examId} Reading Passage ${boundary.number}`, examId, ["自由文本解析，缺失题组单独记录；未生成或补写题目。"]), passageNumber: boundary.number, passage, paragraphs, questions: mapped.questions, instructions: mapped.instructions, estimatedMinutes: 20 });
  }
  return output;
}
async function structuredListening(document, root, probe) {
  const output = result(), book = Number(document.book), test = Number(document.test), examId = `C${book}T${test}`;
  if (book === 3 || /MISMAPPED/i.test(document.id ?? "")) { output.issues.push(issue(examId, "剑3听力题目映射已知不可靠，未作为可判分或门槛材料导入。")); return output; }
  const text = String(document.questionsText ?? document.text ?? ""), parsedAudio = await audioForExam(root, book, test, document.audio ?? [], probe); output.issues.push(...parsedAudio.issues);
  const audioscript = await bookTranscript(root, book);
  const sections = [...text.matchAll(/^\s*(?:PART|SECTION)\s+([1-4])\b[^\n]*/gim)];
  for (let section = 1; section <= 4; section++) {
    const sourceRef = `${examId}S${section}`, audio = parsedAudio.found[section], at = sections.findIndex(match => Number(match[1]) === section);
    if (!audio) continue;
    if (at < 0) { output.issues.push(issue(sourceRef, "原文本没有明确分节标题，未猜测音频与题目边界。")); continue; }
    // Some cached HTML places Questions on the same line as the Part header.
    const body = text.slice(sections[at].index, sections[at + 1]?.index ?? text.length);
    const transcript = transcriptPart(audioscript, test, section);
    if (!transcript) { output.issues.push(issue(sourceRef, "缺少这一节原文，未作为完整材料导入。")); continue; }
    const answers = Object.fromEntries(Object.entries(document.answers ?? {}).filter(([n]) => Number(n) >= (section - 1) * 10 + 1 && Number(n) <= section * 10));
    const mapped = parseStructuredQuestions(body, answers, { skill: "listening", sourceRef, original: transcript }); output.issues.push(...mapped.issues);
    if (!mapped.questions.length) continue;
    output.materials.push({ ...commonMaterial(sourceRef, "listening", `${examId} Listening Section ${section}`, examId, ["自由文本拆题；答案待核题组未补造。"]), section, transcript, questions: mapped.questions, instructions: mapped.instructions,
      audio: { path: audio.path, durationSeconds: audio.durationSeconds, sha256: audio.sha256 }, estimatedMinutes: Math.max(1, Math.ceil((audio.durationSeconds + 60) / 60)) }); output.audioCopies.push(audio);
  }
  return output;
}
async function genericListening(root, folder, probe) {
  const output = result(), match = /(?:^|[\\/])C(\d+)[\\/]T(\d+)(?:$|[\\/])/i.exec(folder), book = Number(match?.[1]), test = Number(match?.[2]), examId = `C${book}T${test}`;
  if (!match) return output;
  try {
    const data = await readJSON(path.join(folder, "answers.json"));
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.parts) || data.parts.length !== 4 || !data.answers || typeof data.answers !== "object") throw new Error("answers.json必须含四个parts的完整题干/groups及1–40 answers；不能只凭答案生成题干。");
    const audioBySection = {};
    let combined = ""; try { combined = await fs.readFile(path.join(folder, "transcript.md"), "utf8"); } catch { /* Each supplied part may carry its own original transcript. */ }
    if (data.scope === "full") {
      if (typeof data.audio !== "string" || !data.audio.trim()) throw new Error("整套听力必须明确指定一份真实全套音频；不能冒用第一节音频。");
      const transcript = String(data.transcript ?? combined).trim(); if (!transcript) throw new Error("整套缺少原文。");
      const audio = await audioPlan(root, path.relative(root, path.resolve(folder, data.audio)), `${examId}-listening-full`, probe);
      const mapped = mapGroups(data.parts.flatMap(part => part.groups ?? []), data.answers, { skill: "listening", sourceRef: examId, original: transcript });
      if (mapped.questions.length !== 40 || new Set(mapped.questions.map(q => q.number)).size !== 40 || !Array.from({ length: 40 }, (_, i) => i + 1).every(n => mapped.questions.some(q => q.number === n))) throw new Error("整套听力没有完整1–40题和答案，不导入为full。");
      output.materials.push({ ...commonMaterial(examId, "listening", `${examId} Listening — original full recording`, examId, ["用户提供单个真实全套音频；未拼接或假借分节音频。"]), id: idOf(`${examId}-listening-full`), scope: "full", transcript, questions: mapped.questions, instructions: mapped.instructions, audio: { path: audio.path, durationSeconds: audio.durationSeconds, sha256: audio.sha256 }, estimatedMinutes: Math.min(180, Math.ceil((audio.durationSeconds + 60) / 60)) });
      output.audioCopies.push(audio); output.issues.push(...mapped.issues); return output;
    }
    for (let section = 1; section <= 4; section++) {
      const file = path.join(folder, `${examId}S${section}.mp3`);
      if (!await exists(file)) throw new Error(`整套缺少${examId}S${section}.mp3，整套跳过。`);
      audioBySection[section] = await audioPlan(root, path.relative(root, file), `${examId}S${section}`, probe);
      const part = data.parts.find(part => Number(part.part) === section);
      if (!part || Number(part.range?.[1]) - Number(part.range?.[0]) + 1 !== 10) throw new Error(`第${section}节不是完整10题，整套跳过。`);
      if (!part.transcript) part.transcript = transcriptPart(combined, test, section);
    }
    // Validate the real mapping using the checked audio; no partial generic pack is published.
    const complete = mapYanboExam({ source: { book, test }, listening: data }, { audioBySection });
    if (complete.materials.length !== 4 || complete.materials.reduce((sum, material) => sum + material.questions.length, 0) !== 40) throw new Error(`通用整套存在缺题、缺答案或缺原文：${complete.issues.map(x => x.reason).join("；")}`);
    merge(output, complete);
  } catch (error) { output.issues.push(issue(examId, error.message)); }
  return output;
}
async function cambridgeThreeShorts(root, probe) {
  const output = result(), original = await bookTranscript(root, 3);
  if (!original) return output;
  for (let test = 1; test <= 4; test++) for (let section = 1; section <= 4; section++) {
    const sourceRef = `C3T${test}S${section}`, candidate = `listening/maslow-cam1-20/ielts_listening/book_03/test_${test}_part_${section}.mp3`;
    if (!await exists(path.join(root, candidate))) continue;
    const transcript = transcriptPart(original, test, section); if (!transcript) { output.issues.push(issue(sourceRef, "缺少剑3该节原文，未导入精听。")); continue; }
    try {
      const audio = await audioPlan(root, candidate, sourceRef, probe);
      output.materials.push({ ...commonMaterial(sourceRef, "listening", `${sourceRef} transcript-only listening`, `C3T${test}`, ["剑3当前缺可靠题目和答案，仅用于精听/听写，不进整套统计、门槛或检查池。"]), scope: "short", section, transcript, questions: [], audio: { path: audio.path, durationSeconds: audio.durationSeconds, sha256: audio.sha256 } }); output.audioCopies.push(audio);
    } catch (error) { output.issues.push(issue(sourceRef, error.message)); }
  }
  return output;
}
export async function importCambridge({ from, seed = "band-r4-v1", assignmentPath, probeAudio: probe = probeAudio } = {}) {
  const root = path.resolve(from), output = result(), exams = new Map();
  for (const file of await walk(path.join(root, "reading/yanbo-cam4-18/data/bank/exams"))) if (/\.json$/i.test(file)) {
    try {
      const exam = await readJSON(file), book = Number(exam.source?.book), test = Number(exam.source?.test);
      if (exam.schema !== "ielts-mock.exam/1") throw new Error("未知yanbo schema。");
      const audio = exam.listening ? await audioForExam(root, book, test, [], probe) : { found: {}, issues: [] }; output.issues.push(...audio.issues);
      merge(output, mapYanboExam(exam, { audioBySection: audio.found }));
      if (exam.reading) exams.set(`${book}:${test}:reading`, true); if (exam.listening) exams.set(`${book}:${test}:listening`, true);
    } catch (error) { output.issues.push(issue(path.basename(file), error.message)); }
  }
  const structured = new Map();
  for (const name of ["cam-lincoh", "cam-taro"]) for (const file of await walk(path.join(root, "structured", name))) if (/\.json$/i.test(file)) {
    try {
      const doc = await readJSON(file), key = `${doc.book}:${doc.test}:${doc.skill}`;
      if (/MISMAPPED/i.test(file) || Number(doc.book) === 3 && doc.skill === "listening") { output.issues.push(issue(doc.id ?? path.basename(file), "已知MISMAPPED听力映射，未导入判分。")); continue; }
      if (exams.has(key)) continue;
      if (name === "cam-taro" || !structured.has(key)) {
        const previous = structured.get(key);
        if (previous && [19, 20].includes(Number(doc.book))) {
          const mismatches = Object.keys(doc.answers ?? {}).filter(n => accepted(doc.answers[n]).join("|") !== accepted(previous.answers?.[n]).join("|"));
          if (mismatches.length) output.issues.push(issue(doc.id, `taro优先；与lincoh答案交叉核对存在差异：${mismatches.join(",")}，保留来源原答案待核。`));
        }
        structured.set(key, doc);
      }
    } catch (error) { output.issues.push(issue(path.basename(file), error.message)); }
  }
  for (const doc of structured.values()) merge(output, doc.skill === "reading" ? structuredReading(doc) : await structuredListening(doc, root, probe));
  merge(output, await cambridgeThreeShorts(root, probe));
  let genericRoot = path.join(root, "listening"); try { if (!(await fs.stat(genericRoot)).isDirectory()) genericRoot = root; } catch { genericRoot = root; }
  for (const file of await walk(genericRoot)) if (path.basename(file) === "answers.json" && /[\\/]C\d+[\\/]T\d+[\\/]/i.test(file)) merge(output, await genericListening(root, path.dirname(file), probe));
  output.materials.push(...fullReading(output.materials));
  const unique = new Map(); for (const material of output.materials) if (!unique.has(`${material.id}@${material.version}`)) unique.set(`${material.id}@${material.version}`, material);
  let existing; if (assignmentPath) try { existing = await readJSON(assignmentPath); } catch (error) { if (error.code !== "ENOENT") output.issues.push(issue("holdout", "旧检查池清单不可读，按指定seed保留可复现选择。")); }
  const selected = assignHoldout([...unique.values()], { seed, existing }); output.materials = selected.materials; output.issues.push(...selected.issues); output.holdoutManifest = selected.holdoutManifest;
  if (assignmentPath) { await fs.mkdir(path.dirname(path.resolve(assignmentPath)), { recursive: true }); const temporary = `${assignmentPath}.tmp-${process.pid}`; await fs.writeFile(temporary, JSON.stringify(selected.holdoutManifest, null, 2) + "\n"); await fs.rename(temporary, assignmentPath); }
  output.examCatalog = ["reading", "listening"].flatMap(skill => completeExams(output.materials, skill).map(examId => ({ examId, skill, complete: true, fullPlayable: output.materials.some(m => m.examId === examId && m.skill === skill && m.scope === "full"), materialIds: output.materials.filter(m => m.examId === examId && m.skill === skill).map(m => m.id) })));
  return output;
}
export async function importXiaHua({ from, cambridgeMaterials = [], probeAudio: probe = probeAudio, similarityThreshold = 0.8 } = {}) {
  const root = path.resolve(from), output = result(); output.duplicates = [];
  for (const file of await walk(root)) if (/\.html?$/i.test(file)) {
    const relative = path.relative(root, file), section = Number(/(?:^|[\\/])P([1-4])(?:[\\/])/i.exec(relative)?.[1]), sourceRef = `xiahua:p${section || "unknown"}-${digest(relative).slice(0, 16)}`;
    try {
      if (!section) throw new Error("源目录没有明确P1–P4，未猜测部分。");
      const audioFile = path.join(path.dirname(file), "audio.mp3"); if (!await exists(audioFile)) throw new Error("同目录缺少audio.mp3，未导入。");
      const audio = await audioPlan(root, path.relative(root, audioFile), sourceRef, probe);
      const frequency = /[\\/]高频[\\/]/.test(relative) ? "high" : /[\\/]次高频[\\/]/.test(relative) ? "medium" : "low";
      const mapped = parseXiaHuaHtml(await fs.readFile(file, "utf8"), { sourceRef, section, audio, frequency });
      output.issues.push(...mapped.issues);
      for (const material of mapped.materials) {
        const duplicate = cambridgeMaterials.filter(m => m.skill === "listening" && typeof m.transcript === "string").map(m => ({ duplicateOf: m.source.sourceRef, similarity: transcriptSimilarity(material.transcript, m.transcript) })).sort((a, b) => b.similarity - a.similarity)[0];
        if (duplicate && duplicate.similarity >= similarityThreshold && tokens(material.transcript).length >= 20) { output.duplicates.push({ sourceRef, ...duplicate }); output.issues.push(issue(sourceRef, `与${duplicate.duplicateOf}原文相似，duplicateOf已记录，跳过重复材料。`)); continue; }
        output.materials.push(material); output.audioCopies.push(audio);
      }
    } catch (error) { output.issues.push(issue(sourceRef, error.message)); }
  }
  return output;
}
