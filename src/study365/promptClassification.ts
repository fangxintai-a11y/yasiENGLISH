/** Only explicit original task instructions classify a prompt; no model or paraphrase. */
export function explicitWritingSubtype(prompt: string): string {
  const rules: [string, RegExp][] = [
    ["opinion", /\b(?:agree or disagree|do you (?:agree|disagree))\b/i],
    [
      "discussion",
      /\bdiscuss\s+(?:both(?:\s+these)?|these\s+two)\s+(?:views|sides|opinions)\b/i,
    ],
    [
      "advantages-disadvantages",
      /\b(?:what are|discuss)\b[\s\S]{0,80}\badvantages?\b[\s\S]{0,80}\bdisadvantages?\b|\badvantages?\b[\s\S]{0,60}\boutweigh(?:s)?\b[\s\S]{0,60}\bdisadvantages?\b/i,
    ],
    [
      "problem-solution",
      /\bwhat\b[\s\S]{0,80}\bproblems?\b[\s\S]{0,160}\b(?:what|suggest|propose)\b[\s\S]{0,100}\bsolutions?\b|\bdiscuss\b[\s\S]{0,80}\bproblems?\b[\s\S]{0,80}\bsolutions?\b/i,
    ],
  ];
  const matched = rules.filter(([, pattern]) => pattern.test(prompt));
  return matched.length === 1 ? matched[0][0] : "unknown";
}
export function explicitTaskOneSubtype(prompt: string): string {
  const rules: [RegExp, string][] = [
    [/\bbar charts?\b/i, "bar-chart"],
    [/\bline (?:graphs?|charts?)\b/i, "line-graph"],
    [/\bpie charts?\b/i, "pie-chart"],
    [/\btable(?:s)? (?:below|shows?)\b/i, "table"],
    [/\bmaps?\b/i, "map"],
    [/\bprocess\b/i, "process"],
  ];
  const matched = rules.filter(([pattern]) => pattern.test(prompt));
  return matched.length === 1 ? matched[0][1] : "unknown";
}
