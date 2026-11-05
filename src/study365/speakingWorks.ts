import { assertNoCredentials } from "../ielts/scoring";
import {
  validatePayload,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { speakingPayload, type SpeakingDraft } from "./speakingModel";
import { normalizeSpeakingBlob } from "./speakingRecording";
export interface PendingSpeakingRecording {
  id: string;
  blob: Blob;
  durationSeconds: number;
  device: string;
}
interface SpeakingPort {
  save(input: {
    id: string;
    kind: "speaking";
    payload: LearningPayload;
    baseRevision: string | null;
  }): Promise<Revision>;
  saveRecording?(id: string, blob: Blob): Promise<void>;
}
export class SpeakingSaveError extends Error {
  constructor(
    message: string,
    public readonly recordingSaved: boolean,
  ) {
    super(message);
    this.name = "SpeakingSaveError";
  }
}
export async function saveSpeakingAttempt(
  draft: SpeakingDraft,
  options: {
    expectedUserId: string | null;
    port?: SpeakingPort;
    recording?: PendingSpeakingRecording;
  },
): Promise<{ draft: SpeakingDraft; work: Revision }> {
  const recording = options.recording
    ? {
        ...options.recording,
        blob: normalizeSpeakingBlob(options.recording.blob),
      }
    : undefined;
  const value: SpeakingDraft = recording
    ? {
        ...draft,
        recordingId: recording.id,
        recordingStatus: "local",
        recordingDevice: recording.device,
        durationSeconds: recording.durationSeconds,
      }
    : draft;
  const payload = speakingPayload(value);
  assertNoCredentials(payload);
  validatePayload("speaking", payload);
  if (value.contentId?.startsWith("external-") && !value.sourceRef?.trim())
    throw new Error("外部题请填写出处。");
  const port =
    options.port ??
    (await (async (): Promise<SpeakingPort> => {
      const repository = await import("./repository");
      const check = () => {
        const state = repository.getLearningState();
        if (!state.ready || state.userId !== options.expectedUserId)
          throw new Error("账号已经切换，请在原账号继续口语练习。");
      };
      return {
        save: (input) => {
          check();
          return repository.saveRecord(input);
        },
        saveRecording: (id, blob) => {
          check();
          return repository.saveRecording(id, blob);
        },
      };
    })());
  if (recording) {
    try {
      if (!port.saveRecording) throw new Error("本机录音存储不可用。");
      await port.saveRecording(recording.id, recording.blob);
    } catch (error) {
      throw new SpeakingSaveError(
        `录音未保存：${error instanceof Error ? error.message : "存储失败，请保留转写。"}`,
        false,
      );
    }
  }
  let work: Revision;
  try {
    work = await port.save({
      id: value.recordId,
      kind: "speaking",
      payload,
      baseRevision: value.baseRevision,
    });
  } catch (error) {
    if (recording)
      throw new SpeakingSaveError(
        `录音已保存在本机，作答记录未保存。请重试，原录音ID将保持不变。${error instanceof Error ? error.message : ""}`,
        true,
      );
    throw error;
  }
  return { draft: { ...value, baseRevision: work.revisionId }, work };
}
