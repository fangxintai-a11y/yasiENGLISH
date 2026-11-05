import { useEffect, useMemo, useRef, useState } from 'react';
import { LlmError, needsManualFallback, scoreWriting, type WritingResult } from '../../../ielts/scoring';
import { useStore } from '../../../store/store';
import { ManualPrompt } from '../../../ui/ManualPrompt';
import type { Revision } from '../../protocol';
import { getLearningState, saveRecord, useLearning } from '../../repository';
import { assertCurrentWriting, buildWritingFeedback, writingFeedbackDestinations, writingFeedbackInput } from '../../writingFeedback';
import { feedbackForWork } from '../../writingReview';

export function ExternalWritingFeedback({ work, currentWork, onSaved }: { work: Revision; currentWork: () => Revision | null; onSaved?: () => void }) {
  const mode = useStore(state => state.settings.feedbackMode);
  const learning = useLearning();
  const [stage, setStage] = useState<'closed' | 'confirm' | 'manual'>('closed');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null), epoch = useRef(0), saving = useRef(false);
  const input = useMemo(() => { try { return writingFeedbackInput(work); } catch { return null; } }, [work.id, work.planId, work.revisionId, work.contentHash, work.payload.taskType, work.payload.prompt, work.payload.text, work.payload.scope]);
  useEffect(() => {
    epoch.current++; controller.current?.abort(); controller.current = null; setStage('closed'); setMessage(''); setBusy(false);
    return () => { epoch.current++; controller.current?.abort(); };
  }, [work.revisionId, work.contentHash, mode, learning.userId]);
  if (!input) return null;
  const enabled = mode === 'manual' || mode === 'auto';
  const destinations = writingFeedbackDestinations();
  const feedbacks = feedbackForWork(learning.records, work).filter(record => record.payload.source === 'ai');
  if (!enabled && feedbacks.length === 0) return null;
  const cancel = () => { epoch.current++; controller.current?.abort(); controller.current = null; setStage('closed'); setBusy(false); setMessage('已取消本次反馈。'); };
  const persist = async (result: WritingResult, ticket: number, userId: string | null) => {
    const payload = await buildWritingFeedback(work, result, currentWork);
    if (epoch.current !== ticket || controller.current?.signal.aborted) throw new LlmError('cancelled');
    if (getLearningState().userId !== userId) throw new Error('账号已切换，本次反馈未保存到其他账号。');
    await saveRecord({ kind: 'feedback', payload });
    if (epoch.current === ticket) { setStage('closed'); setMessage('估分已绑定这一版原稿保存。'); onSaved?.(); }
  };
  const automatic = async () => {
    if (busy) return;
    const ticket = ++epoch.current, userId = learning.userId, request = new AbortController();
    controller.current = request; setBusy(true); setMessage('');
    try {
      assertCurrentWriting(work, currentWork());
      const result = await scoreWriting(input, { mode: 'auto', signal: request.signal });
      if (epoch.current !== ticket || request.signal.aborted) return;
      if (needsManualFallback(result) || result.source !== 'ai') {
        setStage('manual'); setMessage('接口暂未返回可用反馈，原稿与本地体检已保留。可以复制提示词继续。');
      } else await persist(result, ticket, userId);
    } catch (error) { if (epoch.current === ticket) setMessage(error instanceof Error ? error.message : '反馈暂不可用，已保存的作品不受影响。'); }
    finally { if (epoch.current === ticket) { setBusy(false); controller.current = null; } }
  };
  const manual = async (result: WritingResult) => {
    if (saving.current) return;
    const ticket = epoch.current, userId = learning.userId;
    saving.current = true; setBusy(true); setMessage('');
    try { await persist(result, ticket, userId); }
    catch (error) { if (epoch.current === ticket) setMessage(error instanceof Error ? error.message : '未能保存，原稿与本地体检仍保留。'); }
    finally { saving.current = false; if (epoch.current === ticket) setBusy(false); }
  };
  return <section className="panel" aria-label="写作外部反馈">
    <h3>可选外部反馈</h3>
    <p className="muted">结果仅是这一版作品的估分，单篇估分不进入写作单科成绩或目标差距。</p>
    {enabled && stage === 'closed' && <button type="button" className="btn btn-ghost" onClick={() => { setMessage(''); setStage('confirm'); }}>获取外部反馈</button>}
    {stage === 'confirm' && <>
      {mode === 'auto' ? <><p>会把这篇作文发到以下已配置的目的地，按顺序尝试：</p><ul>{destinations.map(destination => <li key={destination.id}>{destination.label} · {destination.url}</li>)}</ul>{!destinations.length && <p>尚未配置写作接口，可改用复制提示词。</p>}</> : <p>目的地：你选择并粘贴完整提示词的工具。</p>}
      <div className="data-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
        if (mode === 'auto' && destinations.length) void automatic();
        else { try { assertCurrentWriting(work, currentWork()); setStage('manual'); } catch (error) { setMessage(error instanceof Error ? error.message : '原稿已变化。'); } }
      }}>{busy ? '正在获取…' : mode === 'auto' && destinations.length ? '确认并发送' : '打开复制提示词'}</button><button type="button" className="btn btn-ghost" onClick={cancel}>取消</button></div>
    </>}
    {stage === 'manual' && <>
      <p className="muted">请使用本版新提示词。结果必须保留指定的作品修订与原文校验值，旧版本JSON不能回填到新稿。</p>
      <ManualPrompt task="essay" input={input} onAccept={value => { void manual(value as WritingResult); }} onCancel={cancel} />
    </>}
    {message && <p role="status">{message}</p>}
    {feedbacks.map(feedback => <article key={feedback.id}><h4>估分 · 依据与8分参考表达</h4><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(feedback.payload.text ?? '')}</p></article>)}
  </section>;
}
