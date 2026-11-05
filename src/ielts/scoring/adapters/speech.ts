import type { TimedWord } from "../types";
export interface Transcript { text: string; words: TimedWord[] }
export interface Transcriber { transcribe(audio: Blob): Promise<Transcript | null> }
export interface VoiceActivityResult { segments: { start: number; end: number }[] }
export interface VoiceActivity { analyse(audio: Blob): Promise<VoiceActivityResult | null> }
export const emptyTranscriber: Transcriber = { async transcribe(_audio) { return null; } };
export const emptyVoiceActivity: VoiceActivity = { async analyse(_audio) { return null; } };
