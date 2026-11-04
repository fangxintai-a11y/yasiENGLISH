import { useEffect, useState } from "react";
import type { Revision } from "../../protocol";
import { deviceId, getRecording, useLearning } from "../../repository";
import { recordingDeviceLabel } from "../../speakingRecording";
import { speakingRecordingLocation } from "../../speakingMedia";
export interface PendingAudioPreview {
  id: string;
  blob: Blob;
  stored: boolean;
}
export function RecordingPlayer({
  work,
  pending,
}: {
  work?: Revision;
  pending?: PendingAudioPreview | null;
}) {
  const learning = useLearning(),
    [url, setUrl] = useState<string | null>(null),
    [state, setState] = useState<"loading" | "local" | "missing" | "error">(
      "loading",
    );
  const id =
    pending?.id ??
    (typeof work?.payload.recordingId === "string"
      ? work.payload.recordingId
      : null);
  useEffect(() => {
    let active = true,
      objectUrl: string | null = null;
    setUrl(null);
    setState("loading");
    if (!id) {
      setState("missing");
      return;
    }
    const request = pending?.blob
      ? Promise.resolve(pending.blob)
      : getRecording(id);
    void request
      .then((blob) => {
        if (!active) return;
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
          setState("local");
        } else setState("missing");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, pending?.blob, learning.userId, learning.recordingsVersion]);
  const location = speakingRecordingLocation(
    work ?? { payload: {} },
    !!url,
    recordingDeviceLabel(deviceId()),
  );
  return (
    <div aria-label="作答录音">
      {url ? (
        <>
          <audio
            data-testid="speaking-audio"
            data-recording-id={id ?? undefined}
            src={url}
            controls
            preload="metadata"
            style={{ width: "100%" }}
          />
          <p className="muted">
            {pending && !pending.stored
              ? "临时回听：录音未保存，请重试保存。"
              : pending
                ? "录音已在本机，作答记录尚待保存。"
                : location.message}
          </p>
        </>
      ) : state === "error" ? (
        <p role="status">录音暂时未能读取，文字记录仍保留，请重试。</p>
      ) : state === "loading" ? (
        <p role="status">正在读取本机录音…</p>
      ) : (
        <p role="status">{location.message}</p>
      )}
    </div>
  );
}
