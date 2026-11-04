import { assertNoCredentials } from "../ielts/scoring";
import {
  validatePayload,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { speakingPayload, type SpeakingDraft } from "./speakingModel";
interface SpeakingPort {
  save(input: {
    id: string;
    kind: "speaking";
    payload: LearningPayload;
    baseRevision: string | null;
  }): Promise<Revision>;
}
export async function saveSpeakingAttempt(
  draft: SpeakingDraft,
  options: { expectedUserId: string | null; port?: SpeakingPort },
): Promise<{ draft: SpeakingDraft; work: Revision }> {
  const payload = speakingPayload(draft);
  assertNoCredentials(payload);
  validatePayload("speaking", payload);
  if (draft.contentId?.startsWith("external-") && !draft.sourceRef?.trim())
    throw new Error("外部题请填写出处。");
  const port =
    options.port ??
    (await (async (): Promise<SpeakingPort> => {
      const repository = await import("./repository");
      return {
        save: (input) => {
          const state = repository.getLearningState();
          if (!state.ready || state.userId !== options.expectedUserId)
            throw new Error("账号已经切换，请在原账号继续口语练习。");
          return repository.saveRecord(input);
        },
      };
    })());
  const work = await port.save({
    id: draft.recordId,
    kind: "speaking",
    payload,
    baseRevision: draft.baseRevision,
  });
  return { draft: { ...draft, baseRevision: work.revisionId }, work };
}
