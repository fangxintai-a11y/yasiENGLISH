import type { Entry } from "../../../atlas/types";
import type { Evidence } from "../types";
export const words = (text: string): string[] => text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+(?:\.\d+)?%?/g) ?? [];
export const normal = (text: string) => words(text).map((word) => word.toLowerCase().replaceAll("’", "'"));
export const sentences = (text: string) => [...text.matchAll(/[^.!?\n]+[.!?]?/g)].filter((m) => m[0].trim()).map((m) => {
  const leading = m[0].length - m[0].trimStart().length, value = m[0].trim();
  return { text: value, start: m.index + leading, end: m.index + leading + value.length };
});
export const paragraphs = (text: string) => text.split(/\r?\n\s*\r?\n/).filter((part) => part.trim());
export const grams = (tokens: string[], size: number) => tokens.slice(0, Math.max(0, tokens.length - size + 1)).map((_, i) => tokens.slice(i, i + size).join(" "));
export function overlap(text: string, other: string, size = 4): number {
  const source = grams(normal(text), size), target = new Set(grams(normal(other), size));
  return source.length ? source.filter((gram) => target.has(gram)).length / source.length : 0;
}
export function forms(word: string): Set<string> {
  const base = word.toLowerCase();
  const set = new Set([base, `${base}s`, `${base}es`, `${base}ed`, `${base}ing`, `${base}ly`, `${base}er`, `${base}est`]);
  if (base.endsWith("e")) for (const suffix of ["ing", "ed", "er", "est"]) set.add(base.slice(0, -1) + suffix);
  if (/[^aeiou]y$/.test(base)) for (const suffix of ["ies", "ied", "ier", "iest"]) set.add(base.slice(0, -1) + suffix);
  if (/[aeiou][bcdfghjklmnpqrstvwxyz]$/.test(base)) for (const suffix of ["ed", "ing", "er", "est"]) set.add(base + base.at(-1) + suffix);
  return set;
}
export function containsTarget(text: string, word: string, entry: Entry | null): boolean {
  const targets = new Set([word, ...(entry?.fam ?? [])].flatMap((value) => [...forms(value)]));
  return normal(text).some((token) => targets.has(token)) || (word.includes(" ") && text.toLowerCase().includes(word.toLowerCase()));
}
export const metric = (ruleId: string, name: string, value: number, message: string): Evidence => ({ kind: "metric", ruleId, metric: name, value, message });
export const rule = (ruleId: string, message: string): Evidence => ({ kind: "rule", ruleId, message });
export const span = (ruleId: string, text: string, start: number, message: string): Evidence => ({ kind: "span", ruleId, text: text.slice(0, 600), start, end: start + Math.min(600, text.length), message });
export const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
export const deviation = (values: number[]) => Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2)));
export const subordinate = /\b(because|although|though|which|that|whereas|while|unless|since|if|when|who)\b/i;
export const stopWords = new Set("a an the and or but is are was were be been being to of in on for with as at by from it its this that these those i we you they he she our their have has had do does did can could should would will may might not more most very about what when where why how who".split(" "));
