import { useEffect, useState } from "react";
import type { Revision } from "../../protocol";
import { deviceId, getRecording, useLearning } from "../../repository";
import { recordingDeviceLabel } from "../../speakingRecording";
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
    (work?.payload.recordingStatus === "none"
      ? null
      : typeof work?.payload.recordingId === "string"
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
  const origin =
    typeof work?.payload.recordingDevice === "string"
      ? work.payload.recordingDevice
      : "设备名称未记录";
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
                : "录音保存在这台设备上。"}
          </p>
        </>
      ) : state === "error" ? (
        <p role="status">录音暂时未能读取，文字记录仍保留，请重试。</p>
      ) : !id ? (
        <p className="muted">
          这份作答没有本机录音，可以只保留转写或使用外部录音。
        </p>
      ) : state === "loading" ? (
        <p role="status">正在读取本机录音…</p>
      ) : origin === recordingDeviceLabel(deviceId()) ? (
        <p role="status">这台设备未找到录音，请从此前导出的ZIP备份恢复。</p>
      ) : (
        <p role="status">
          录音在另一台设备上（{origin}），导出ZIP后在这里导入即可回听。
        </p>
      )}
    </div>
  );
}
