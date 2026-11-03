import { parseSyllables } from "../../syllables";
import { HackSchema } from "../schemas";
import type { HackBody, HackInput } from "../types";
export function buildHackRules(input: HackInput): HackBody {
  const pieces = input.syllables ? parseSyllables(input.syllables) : [];
  const valid = pieces.length > 0 && pieces.map((piece) => piece.text).join("").toLowerCase() === input.word.toLowerCase();
  const split = valid ? pieces.map((piece) => piece.text).join("·") : [...input.word].join("·");
  return HackSchema.parse({ homophone: "", scene: "", split: `${split}${input.mnemonic?.affix ? `；${input.mnemonic.affix}` : ""}`.slice(0, 400) });
}
