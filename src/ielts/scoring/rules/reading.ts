import { ReadingSchema } from "../schemas";
import type { ReadingBody, ReadingInput } from "../types";
import { readingCoverage } from "./readingCoverage";
import { createControlledReport, renderControlledReading, textSeed, type TopicId } from "./controlledReadings";
export function buildReadingRules(input: ReadingInput): ReadingBody {
  const selected = input.words.filter((word, index, all) => all.findIndex((item) => item.id === word.id) === index).slice(0, 12);
  if (selected.length < 5) throw new Error("请先选择至少5个不同的目标词。");
  const seed = textSeed(selected.map((word) => `${word.id}:${word.word.toLowerCase()}`).join("|"));
  const variant = seed % 3 as 0 | 1 | 2;
  const candidates = (["transport", "learning", "cooling"] as TopicId[]).map((topic) => {
    const report = createControlledReport(topic, variant, seed), passage = report.paragraphs.join("\n\n");
    return { report, coverage: readingCoverage({ words: selected }, passage).coveredWordIds.length };
  });
  const highest = Math.max(...candidates.map((candidate) => candidate.coverage));
  const best = candidates.filter((candidate) => candidate.coverage === highest);
  return ReadingSchema.parse(renderControlledReading(best[(seed >>> 12) % best.length].report, seed));
}
