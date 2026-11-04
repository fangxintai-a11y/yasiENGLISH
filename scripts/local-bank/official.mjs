import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeAudio as defaultProbeAudio } from "./cambridge.mjs";

const run = promisify(execFile);
const zeroHash = "0".repeat(64);
const hash = value => createHash("sha256").update(value).digest("hex");
const id = value => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 145);
const empty = () => ({ materials: [], issues: [], audioCopies: [] });
const clean = value => String(value).replace(/\f/g, "\n").replace(/^\s*(?:Academic Reading|Listening) sample task[^\n]*$/gmi, "").trim();
const issue = (sourceRef, reason) => ({ sourceRef, reason });

// Only expand alternatives actually printed by the source key. No generated synonyms.
function alternatives(value) {
  let values = String(value).trim().split(/\s+\/\s+|\s+OR\s+/i);
  values = values.flatMap(part => {
    const slash = /([^\s/]+)\/([^\s/]+)/.exec(part);
    return slash ? [part.replace(slash[0], slash[1]), part.replace(slash[0], slash[2])] : [part];
  });
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    values = values.flatMap(part => {
      const optional = /\(([^()]*)\)/.exec(part);
      if (!optional) return [part];
      changed = true;
      // A printed optional hyphen permits a space or a hyphen, not concatenation.
      return [part.replace(optional[0], optional[1] === "-" ? " " : ""), part.replace(optional[0], optional[1])];
    });
    if (!changed) break;
  }
  return [...new Set(values.map(value => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function parseOfficialAnswerKey(text) {
  const answers = {}, lines = String(text).replace(/\f/g, "\n").split(/\n/);
  let current, unsupportedPairs = false;
  for (const line of lines) {
    if (/\b\d+\s*(?:&|and|[–-])\s*\d+\s+in either order/i.test(line)) { unsupportedPairs = true; current = undefined; continue; }
    if (/^\s*(?:Words? in brackets|Alternative answers|Note:|Each question)/i.test(line)) break;
    const row = /^\s*(\d{1,2})\s*[.)]?\s+(.+?)\s*$/.exec(line);
    if (row) { current = Number(row[1]); answers[current] = row[2]; }
    else if (current && line.trim() && !/^\s*Answers?:?/i.test(line)) answers[current] += ` ${line.trim()}`;
  }
  return { answers: Object.fromEntries(Object.entries(answers).map(([number, value]) => [number, alternatives(value)])), unsupportedPairs };
}

function common({ sourceRef, sourceFile, version = "official-layout-v1" }, skill, title, scope) {
  return { id: id(sourceRef), version, title: title.slice(0, 500), deliveryMode: "local-import", skill, scope, contentHash: zeroHash,
    source: { materialSource: "official", sourceRef, rights: "User-provided local official sample; original rights retained.", answerVerified: false },
    notes: [`来源本机 PDF：${path.basename(sourceFile ?? sourceRef)}。自动映射，题干、答案和定位均待人工核对；不代表已人工审校。`] };
}

function paragraphsFor(text, sourceRef) {
  const value = text.trim();
  const sectionMarkers = [...value.matchAll(/^\s*Section\s+([A-Z])\s*$/gm)];
  const labelled = sectionMarkers.length ? sectionMarkers : [...value.matchAll(/^([A-Z])\s{2,}(?=\S)/gm)];
  if (labelled.length) return labelled.map((match, index) => ({ id: id(`${sourceRef}-p-${match[1]}`), label: match[1], text: value.slice(match.index + match[0].length, labelled[index + 1]?.index ?? value.length).trim() })).filter(p => p.text);
  return value.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean).map((text, index) => ({ id: id(`${sourceRef}-p-${index + 1}`), text }));
}

function printedOptions(lines) {
  const options = []; let continuing = false;
  for (const line of lines.split(/\n/)) {
    if (/^\s*(?:\d+\s*[.)]?\s+|Example\b)/i.test(line)) { continuing = false; continue; }
    const match = /^\s*([A-Z]|[ivx]+)\s{1,}(.+?)\s*$/.exec(line);
    if (match) { options.push({ id: match[1], text: match[2] }); continuing = true; }
    else if (continuing && line.trim()) options.at(-1).text += ` ${line.trim()}`;
  }
  return options;
}
function mapOfficialQuestions(questionText, answers, { skill, sourceRef, paragraphs, title }) {
  const ranges = [...questionText.matchAll(/^\s*Questions?\s+(\d{1,2})(?:\s*(?:[–—-]|and)\s*(\d{1,2}))?\s*$/gmi)];
  const questions = [], issues = [], instructions = [];
  for (const [index, range] of ranges.entries()) {
    const first = Number(range[1]), last = Number(range[2] ?? range[1]);
    const body = questionText.slice(range.index + range[0].length, ranges[index + 1]?.index ?? questionText.length).trim();
    if (first > last || last > 40) { issues.push(issue(sourceRef, "无效题号范围。")); continue; }
    const task = `${title}\n${body}`;
    let type;
    if (/\bTRUE\b[\s\S]*\bFALSE\b[\s\S]*NOT GIVEN/i.test(body)) type = "true-false-not-given";
    else if (/\bYES\b[\s\S]*\bNO\b[\s\S]*NOT GIVEN/i.test(body)) type = "yes-no-not-given";
    else if (/multiple choice/i.test(title)) type = "multiple-choice";
    else if (/matching headings/i.test(title)) type = "matching-headings";
    else if (/which paragraph/i.test(body)) type = "matching-information";
    else if (/matching features/i.test(title)) type = "matching-features";
    else if (/sentence completion/i.test(title)) type = "sentence-completion";
    else if (/table completion/i.test(title)) type = "table-completion";
    else { issues.push(issue(sourceRef, "尚不支持此 PDF 题型，未猜测映射。")); continue; }
    if (/choose\s+(?:TWO|THREE|FOUR)\s+(?:letters|answers)/i.test(body)) { issues.push(issue(sourceRef, "多选共享答案槽待核，未按独立单选题导入。")); continue; }
    const numbered = [...body.matchAll(/^\s*(\d{1,2})\s*[.)]?\s+(?=\S)/gm)].filter(match => Number(match[1]) >= first && Number(match[1]) <= last);
    const labelType = type === "true-false-not-given" || type === "yes-no-not-given";
    const allOptions = /matching/.test(type) ? printedOptions(body) : undefined;
    const maxWord = /(?:NO MORE THAN\s+)?(ONE|TWO|THREE|FOUR|\d+)\s+WORDS?/i.exec(body);
    const maxWords = labelType ? 3 : /choice|matching/.test(type) ? 1 : maxWord ? Number(maxWord[1]) || ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4 })[maxWord[1].toUpperCase()] : 100;
    instructions.push(task.slice(0, 4000));
    for (let number = first; number <= last; number++) {
      const rowIndex = numbered.findIndex(match => Number(match[1]) === number), row = numbered[rowIndex];
      let stem, options;
      if (/completion/.test(type)) {
        const marker = new RegExp(`\\b${number}\\s*(?=[.…_]{2,})`), line = body.split(/\n/).find(line => marker.test(line) || new RegExp(`^\\s*${number}\\s*[.)]?\\s+`).test(line));
        stem = line?.trim();
      } else if (row) {
        stem = body.slice(row.index + row[0].length, numbered[rowIndex + 1]?.index ?? body.length).trim();
        if (type === "multiple-choice") options = printedOptions(stem);
        else if (/matching/.test(type)) options = allOptions;
      }
      const accepted = answers[number];
      if (!stem || !accepted?.length) { issues.push(issue(sourceRef, `第${number}题缺少可确认的题干或答案。`)); continue; }
      if (options && (options.length < 2 || new Set(options.map(o => o.id)).size !== options.length || accepted.some(value => !options.some(o => o.id === value)))) { issues.push(issue(sourceRef, `第${number}题原选项未完整映射。`)); continue; }
      const label = type === "matching-headings" ? /(?:Section|Paragraph)\s+([A-Z])/i.exec(stem)?.[1]?.toUpperCase() : undefined;
      const paragraph = label ? paragraphs.find(p => p.label === label) : undefined;
      if (type === "matching-headings" && !paragraph) { issues.push(issue(sourceRef, `第${number}题段落不存在。`)); continue; }
      questions.push({ id: id(`${sourceRef}-q${number}`), number, type, prompt: `${task}\n\n${number}. ${stem}`.slice(0, 20000),
        answer: { accepted, maxWords, ...(/\bAND\s*(?:\/\s*OR)?\s+(?:(?:A|ONE)\s+)?NUMBER\b/i.test(body) ? { allowNumber: true } : {}) },
        ...(options ? { options } : {}), ...(paragraph ? { paragraphId: paragraph.id } : {}),
        evidence: paragraph ? { paragraphId: paragraph.id, quote: paragraph.text.slice(0, 8000), offset: 0, rationale: "原题指定段落，答案与理由仍待人工核对。" } : { rationale: "来源提供答案但没有可确认的逐题定位；未自动编造证据或音频时间。" }, answerVerified: false });
    }
  }
  return { questions, issues, instructions };
}

/** Local text conversion only; ambiguous or incomplete papers are skipped as a unit. */
export function parseOfficialText(text, options) {
  const output = empty(), { skill, sourceRef, audio } = options;
  const reject = reason => { output.issues.push(issue(sourceRef, reason)); return output; };
  const title = String(text).split(/\n/).find(line => /sample task/i.test(line))?.trim() ?? path.basename(options.sourceFile ?? sourceRef);
  if (/diagram|map.*labell|plan.*labell/i.test(title)) return reject("题目依赖原题图，文字导入无法忠实呈现，整份跳过待人工核对。");
  const answerMarkers = [...String(text).matchAll(/^\s*Answers\s*:\s*$/gmi)];
  if (!answerMarkers.length) return reject("没有原始答案区，未生成可判分题目。");
  const marker = answerMarkers.at(-1), answerKey = parseOfficialAnswerKey(clean(String(text).slice(marker.index + marker[0].length)));
  if (answerKey.unsupportedPairs) return reject("自由填写题的 in either order 共享答案槽尚不能可靠映射，整份跳过，未拆成可重复计分题。");
  const body = clean(String(text).slice(0, marker.index));
  let questionText, original, paragraphs = [];
  if (skill === "listening") {
    if (!audio || !(audio.durationSeconds > 0)) return reject("缺少与 PDF 明确 Recording 编号对应的本机音频，未猜测音频关系。");
    const tapescript = /^\s*Tapescript[^\n]*$/mi.exec(body);
    if (!tapescript) return reject("没有可识别的本节原文，整份跳过。");
    questionText = body.slice(0, tapescript.index).trim(); original = body.slice(tapescript.index + tapescript[0].length).trim();
  } else {
    const questions = /\bQuestions?\s+\d+/i.exec(body);
    if (!questions) return reject("没有 Questions 题号区，未猜测题目。");
    const after = body.slice(questions.index), section = /^\s*Section\s+A\s*$/m.exec(after);
    if (section) { questionText = after.slice(0, section.index).trim(); original = after.slice(section.index).trim(); }
    else { original = body.slice(0, questions.index).trim(); questionText = after; }
    paragraphs = paragraphsFor(original, sourceRef); original = paragraphs.map(p => p.text).join(" ");
    if (!original) return reject("缺少阅读原文，不能把答案参考伪装成可判分文章。");
  }
  const ranges = [...questionText.matchAll(/^\s*Questions?\s+(\d{1,2})(?:\s*(?:[–—-]|and)\s*(\d{1,2}))?\s*$/gmi)];
  const expected = ranges.flatMap(match => Array.from({ length: Number(match[2] ?? match[1]) - Number(match[1]) + 1 }, (_, i) => Number(match[1]) + i));
  if (!expected.length || expected.some(n => !answerKey.answers[n]?.length)) return reject("题号对应的原始答案不完整，整份跳过。");
  if (skill === "reading" && /which paragraph/i.test(questionText) && !/^\s*[A-Z]\s{2,}\S/m.test(questionText)) {
    questionText += `\n${paragraphs.filter(p => p.label).map(p => `${p.label}  Paragraph ${p.label}`).join("\n")}`;
  }
  const mapped = mapOfficialQuestions(questionText, answerKey.answers, { skill, sourceRef, paragraphs, title });
  if (mapped.issues.length || mapped.questions.length !== expected.length || mapped.questions.some(q => !expected.includes(q.number))) {
    output.issues.push(...mapped.issues);
    return reject("题干、选项或答案未能完整一一对应，整份跳过待人工核对。");
  }
  const material = { ...common(options, skill, title, "type-drill"), questions: mapped.questions, instructions: mapped.instructions };
  if (skill === "reading") Object.assign(material, { passage: original, paragraphs });
  else {
    const section = /\bSECTION\s+([1-4])\b/i.exec(body)?.[1];
    Object.assign(material, { transcript: original, audio: { path: audio.path, durationSeconds: audio.durationSeconds, ...(audio.sha256 ? { sha256: audio.sha256 } : {}) }, ...(section ? { section: Number(section) } : {}) });
    output.audioCopies.push(audio);
  }
  output.materials.push(material);
  return output;
}

export function transcriptOnlyMaterial(text, options) {
  return { ...common(options, "listening", "官方听力原文参考（缺少题目）", "short"), transcript: String(text).trim(), questions: [],
    notes: [...common(options, "listening", "", "short").notes, "缺少题目本体及可确认配套音频，仅供原文参考；不能作可判分练习或达标依据。"] };
}

async function walk(folder) {
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) output.push(...await walk(file));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}
async function convertPdf(file) {
  const bundled = path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext");
  const binaries = process.env.PDFTOTEXT ? [process.env.PDFTOTEXT] : ["pdftotext", bundled];
  for (const binary of binaries) {
    try { return (await run(binary, ["-layout", file, "-"], { maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("缺少 pdftotext；请先安装 Poppler 或配置 PDFTOTEXT。");
}

/** Walk already-present local sources. This adapter never performs a network request. */
export async function importOfficial({ from, probeAudio = defaultProbeAudio, extractPdf = convertPdf } = {}) {
  const output = empty(), files = await walk(path.resolve(from)), audioByRecording = {};
  for (const file of files.filter(file => /Tasks Auido[\\/].*\.mp3$/i.test(file))) {
    const number = /Type_([1-3])_Recording|Tt_([4])\.mp3/i.exec(path.basename(file));
    if (!number) continue;
    try {
      const bytes = await fs.readFile(file), metadata = await probeAudio(file), durationSeconds = typeof metadata === "number" ? metadata : metadata.durationSeconds;
      if (!(durationSeconds > 0)) throw new Error("音频时长无效");
      const sha256 = hash(bytes);
      audioByRecording[Number(number[1] ?? number[2])] = { from: file, path: `audio/official-${sha256.slice(0, 24)}.mp3`, sha256, bytes: bytes.length, durationSeconds };
    } catch (error) { output.issues.push(issue(path.basename(file), `音频校验失败：${error.message}`)); }
  }
  for (const file of files.filter(file => /\.pdf$/i.test(file))) {
    const relative = path.relative(path.resolve(from), file).replaceAll(path.sep, "/"), name = path.basename(file);
    const isCambridge = /(?:^|\/)(?:Academic Reading|Listening)\//.test(relative);
    const isTranscript = /ieltsorg\//.test(relative) && /listening.*transcript\.pdf$/i.test(name);
    const isKey = /ieltsorg\//.test(relative) && /answer-key\.pdf$/i.test(name);
    if (!isCambridge && !isTranscript && !isKey) continue;
    const sourceRef = `${isCambridge ? "cambridge-sample" : "ielts.org"}:${relative}`.slice(0, 300);
    if (isKey) { output.issues.push(issue(sourceRef, "只有答案参考，没有配套题目本体；保留原 PDF，未伪造可判分材料。")); continue; }
    try {
      const text = await extractPdf(file), version = `official-layout-v1-${hash(await fs.readFile(file)).slice(0, 16)}`;
      if (isTranscript) { output.materials.push(transcriptOnlyMaterial(text, { sourceRef, sourceFile: file, version })); continue; }
      const skill = /(?:^|\/)Listening\//.test(relative) ? "listening" : "reading";
      const recording = /IELTS Listening Recording\s+([1-4])/i.exec(text)?.[1];
      const mapped = parseOfficialText(text, { skill, sourceRef, sourceFile: file, version, ...(recording && audioByRecording[recording] ? { audio: audioByRecording[recording] } : {}) });
      output.materials.push(...mapped.materials); output.issues.push(...mapped.issues); output.audioCopies.push(...mapped.audioCopies);
    } catch (error) { output.issues.push(issue(sourceRef, `本机 PDF 转换失败：${error.message}`)); }
  }
  output.audioCopies = [...new Map(output.audioCopies.map(audio => [audio.path, audio])).values()];
  output.review = ["# 官方本机材料映射待核清单", "自动解析结果，尚未经人工逐题审校。原 PDF 始终保留；以下不表示真实考试评分认证。", ...output.materials.flatMap(material => [
    `\n## ${material.source.sourceRef}`, ...(material.questions.length ? material.questions.map(question => `\n### ${question.number}\n${question.prompt}\n\n原始接受答案：${question.answer.accepted.join(" / ")}\n待人工核对。`) : ["缺少题目，仅原文参考，不可判分。"]),
  ]), "\n## 跳过及缺口", ...output.issues.map(value => `- ${value.sourceRef}：${value.reason}`)].join("\n");
  return output;
}
