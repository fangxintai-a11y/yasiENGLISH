import { useEffect, useMemo, useRef, useState } from 'react';
import { LlmError, needsManualFallback, scoreSpeaking, type SpeakingResult } from '../../../ielts/scoring';
import { useStore } from '../../../store/store';
import { ManualPrompt } from '../../../ui/ManualPrompt';
import type { Revision } from '../../protocol';
import { getLearningState, saveRecord, useLearning } from '../../repository';
import { buildSpeakingFeedback, speakingFeedbackDestinations, speakingFeedbackInput } from '../../speakingFeedback';
import { assertCurrentSpeaking, speakingFeedbackForWork } from '../../speakingReview';

export function ExternalSpeakingFeedback({ work, currentWork, onSaved }: { work: Revision; currentWork: () => Revision | null; onSaved?: () => void }) {
  const mode = useStore(state => state.settings.feedbackMode);
  const learning = useLearning();
  const [stage, setStage] = useState<'closed' | 'confirm' | 'manual'>('closed');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null), epoch = useRef(0), saving = useRef(false);
  const input = useMemo(() => { try { return speakingFeedbackInput(work); } catch { return null; } }, [work.id, work.planId, work.revisionId, work.contentHash, work.payload.part, work.payload.prompt, work.payload.transcript, work.payload.durationSeconds]);
  useEffect(() => {
    epoch.current++; controller.current?.abort(); controller.current = null; setStage('closed'); setMessage(''); setBusy(false);
    return () => { epoch.current++; controller.current?.abort(); };
  }, [work.revisionId, work.contentHash, mode, learning.userId]);
  if (!input) return mode === 'manual' || mode === 'auto' ? <section className="panel" aria-label="口语外部反馈"><p>请先填写并保存手动转写，再获取外部文字反馈。</p></section> : null;
  const enabled = mode === 'manual' || mode === 'auto';
  const destinations = speakingFeedbackDestinations();
  const feedbacks = speakingFeedbackForWork(learning.records, work).filter(record => record.payload.source === 'ai');
  if (!enabled && feedbacks.length === 0) return null;
  const cancel = () => { epoch.current++; controller.current?.abort(); controller.current = null; setStage('closed'); setBusy(false); setMessage('已取消本次反馈。'); };
  const persist = async (result: SpeakingResult, ticket: number, userId: string | null) => {
    const payload = await buildSpeakingFeedback(work, result, currentWork);
    if (epoch.current !== ticket || controller.current?.signal.aborted) throw new LlmError('cancelled');
    if (getLearningState().userId !== userId) throw new Error('账号已切换，本次反馈未保存到其他账号。');
    await saveRecord({ kind: 'feedback', payload });
    if (epoch.current === ticket) { setStage('closed'); setMessage('估分已绑定这一版转写保存。'); onSaved?.(); }
  };
  const automatic = async () => {
    if (busy) return;
    const ticket = ++epoch.current, userId = learning.userId, request = new AbortController();
    controller.current = request; setBusy(true); setMessage('');
    try {
      assertCurrentSpeaking(work, currentWork());
      const result = await scoreSpeaking(input, { mode: 'auto', signal: request.signal });
      if (epoch.current !== ticket || request.signal.aborted) return;
      if (needsManualFallback(result) || result.source !== 'ai') {
        setStage('manual'); setMessage('接口暂未返回可用反馈，转写与本地体检已保留。可以复制提示词继续。');
      } else await persist(result, ticket, userId);
    } catch (error) { if (epoch.current === ticket) setMessage(error instanceof Error ? error.message : '反馈暂不可用，已保存的作品不受影响。'); }
    finally { if (epoch.current === ticket) { setBusy(false); controller.current = null; } }
  };
  const manual = async (result: SpeakingResult) => {
    if (saving.current) return;
    const ticket = epoch.current, userId = learning.userId;
    saving.current = true; setBusy(true); setMessage('');
    try { await persist(result, ticket, userId); }
    catch (error) { if (epoch.current === ticket) setMessage(error instanceof Error ? error.message : '未能保存，转写与本地体检仍保留。'); }
    finally { saving.current = false; if (epoch.current === ticket) setBusy(false); }
  };
  return <section className="panel" aria-label="口语外部反馈">
    <h3>可选外部反馈</h3>
    <p className="muted">结果仅是这一版转写的词汇、语法估分，不进入口语单科成绩或目标差距。文字不能评估实际流利与发音，录音不会发送到外部。</p>
    {enabled && stage === 'closed' && <button type="button" className="btn btn-ghost" onClick={() => { setMessage(''); setStage('confirm'); }}>获取外部反馈</button>}
    {stage === 'confirm' && <>
      {mode === 'auto' ? <><p>会把Part、题目、手动转写与实际时长发到以下已配置的目的地，按顺序尝试：</p><ul>{destinations.map(destination => <li key={destination.id}>{destination.label} · {destination.url}</li>)}</ul>{!destinations.length && <p>尚未配置口语接口，可改用复制提示词。</p>}</> : <p>目的地：你选择并粘贴完整提示词的工具。</p>}
      <div className="data-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
        if (mode === 'auto' && destinations.length) void automatic();
        else { try { assertCurrentSpeaking(work, currentWork()); setStage('manual'); } catch (error) { setMessage(error instanceof Error ? error.message : '转写已变化。'); } }
      }}>{busy ? '正在获取…' : mode === 'auto' && destinations.length ? '确认并发送' : '打开复制提示词'}</button><button type="button" className="btn btn-ghost" onClick={cancel}>取消</button></div>
    </>}
    {stage === 'manual' && <>
      <p className="muted">请使用本版新提示词。结果必须保留指定的作答修订与转写校验值，旧版本JSON不能回填到新转写。</p>
      <ManualPrompt task="speaking" input={input} onAccept={value => { void manual(value as SpeakingResult); }} onCancel={cancel} />
    </>}
    {message && <p role="status">{message}</p>}
    {feedbacks.map(feedback => <article key={feedback.id}><h4>估分 · 依据与8分参考表达</h4><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(feedback.payload.text ?? '')}</p></article>)}
  </section>;
}
