import type { Revision } from './protocol';
export interface SpeakingRecordingLocation {
  state: 'local' | 'remote' | 'missing' | 'none';
  message: string;
}
/** Metadata identifies a reference; only actual bytes make it playable here. */
export function speakingRecordingLocation(work: Pick<Revision,'payload'>, hasLocalBlob: boolean, currentDevice: string): SpeakingRecordingLocation {
  const { recordingId, recordingStatus, recordingDevice } = work.payload;
  if (typeof recordingId !== 'string' || !recordingId) return recordingStatus === 'local'
    ? { state:'missing',message:'这条作答未找到有效的录音引用，请保留已有备份。' }
    : { state:'none',message:'这次作答没有本机录音，可以保留手动转写或使用外部录音。' };
  if (hasLocalBlob) return { state:'local',message:'录音保存在这台设备上。' };
  if (typeof recordingDevice === 'string' && recordingDevice && recordingDevice !== currentDevice)
    return { state:'remote',message:`录音在另一台设备上（${recordingDevice}）。请在那台设备导出 ZIP 后在这里导入即可回听。` };
  return { state:'missing',message:'这台设备未找到录音，可能已清除本机数据。请从保留录音的设备导出 ZIP 后在这里导入。' };
}
