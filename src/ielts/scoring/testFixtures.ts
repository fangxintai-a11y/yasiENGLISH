import type { Entry } from "../../atlas/types";
export function exampleEntry(word = "benefit", index = 0): Entry {
  return { id: `word-${index}`, w: word, uk: "", us: "", senses: [{ pos: "n.", zh: "益处", en: "an advantage" }],
    ex: [{ en: `The ${word} of this approach is clear to researchers.`, zh: `研究人员清楚这种方法的${word}。` },
      { en: `A local school documented the ${word} in a separate project.`, zh: `当地学校在另一项目记录了${word}。` }],
    col: [`${word} of`], fam: [], syn: ["advantage"], ant: ["disadvantage"], tip: "", cefr: "C1", topic: `topic-${index % 4}`, m: 0 };
}
