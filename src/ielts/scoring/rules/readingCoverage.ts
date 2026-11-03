import type { ReadingCoverage, ReadingInput } from "../types";
import { forms, normal } from "./text";
/** Count only headwords or their regular inflections actually present in this
 * article. A family member or an incidental substring is not coverage. */
export function readingCoverage(input: ReadingInput, passage: string): ReadingCoverage {
  const tokens = normal(passage), selected = input.words.filter((word, index, all) => all.findIndex((item) => item.id === word.id) === index);
  const coveredWordIds: string[] = [], uncoveredWordIds: string[] = [];
  for (const word of selected) {
    const target = normal(word.word), finalForms = forms(target.at(-1) ?? "");
    const present = target.length > 0 && tokens.some((_, start) => target.every((token, offset) => offset === target.length - 1 ? finalForms.has(tokens[start + offset]) : tokens[start + offset] === token));
    (present ? coveredWordIds : uncoveredWordIds).push(word.id);
  }
  return { requestedWordIds: selected.map((word) => word.id), coveredWordIds, uncoveredWordIds };
}
