import samples from "../../public/curriculum365/v1/samples.json";
import { MaterialSchema } from "./contentSchemas";
import {
  explicitTaskOneSubtype,
  explicitWritingSubtype,
} from "./promptClassification";
import { hashLocalPrompt } from "./promptBankSchema";
import type { RetestPrompt } from "./retestSelection";
let origins: Promise<RetestPrompt[]> | undefined;
/** Classification/reference metadata only. These old originals can never be new retest candidates. */
export function sourceOnlyPromptOrigins(): Promise<RetestPrompt[]> {
  return (origins ??= (async () => {
    const result: RetestPrompt[] = [];
    for (const value of samples.materials) {
      const material = MaterialSchema.parse(value);
      const common = {
        id: material.id,
        version: material.version,
        sourceRef: `builtin:${material.id}`,
        materialSource: "unofficial" as const,
        rights:
          "Project-authored original; source classification only, never a new retest question.",
        ready: false,
      };
      if (material.skill === "writing") {
        const stimulusHash = material.taskData
          ? await hashLocalPrompt(material.taskData)
          : undefined;
        const input = {
          ...common,
          skill: "writing" as const,
          taskType: material.taskType,
          questionType:
            material.taskType === "task1"
              ? material.taskData?.kind === "table"
                ? "table"
                : explicitTaskOneSubtype(material.prompt)
              : explicitWritingSubtype(material.prompt),
          prompt: material.prompt,
          ...(stimulusHash ? { stimulusHash } : {}),
        };
        result.push({ ...input, contentHash: await hashLocalPrompt(input) });
      } else if (material.skill === "speaking") {
        const part = material.part;
        if (part !== 1 && part !== 2 && part !== 3) continue;
        for (const prompt of material.prompts) {
          const input = {
            ...common,
            skill: "speaking" as const,
            part,
            prompt,
          } satisfies Omit<RetestPrompt, "contentHash">;
          result.push({ ...input, contentHash: await hashLocalPrompt(input) });
        }
      }
    }
    return result;
  })());
}
export async function withPromptOrigins(
  imported: readonly RetestPrompt[],
): Promise<RetestPrompt[]> {
  return [...imported, ...(await sourceOnlyPromptOrigins())];
}
