import { BookOpen, Headphones, Mic, PenLine } from "lucide-react";
import { useLearning } from "../repository";

// Accessible names keep the original entry wording so links and tests stay stable.
const SKILLS = [
  { skill: "listening", label: "听力", hint: "含听读错题", name: "听力与听读错题", Icon: Headphones },
  { skill: "reading", label: "阅读", hint: "含听读错题", name: "阅读与听读错题", Icon: BookOpen },
  { skill: "writing", label: "写作", hint: "含我的作品", name: "写作与我的作品", Icon: PenLine },
  { skill: "speaking", label: "口语", hint: "含我的作答", name: "口语与我的作答", Icon: Mic },
] as const;

/** Anytime practice and records. Rendered inside the 365 module, not as a second home panel. */
export function LearningLinks() {
  const learning = useLearning();
  return <div className="plan365-practice">
    <div className="plan365-row">
      <h3 className="eyebrow">四科随时练</h3>
      <a className="link" href="#/progress">进度与成绩本</a>
    </div>
    <nav aria-label="四科随时练" className="plan365-skills">
      {SKILLS.map(({ skill, label, hint, name, Icon }) =>
        <a key={skill} className={`plan365-skill is-${skill}`} href={`#/${skill}?mode=practice`} aria-label={name}>
          <span className="plan365-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
          <b>{label}</b>
          <small>{hint}</small>
        </a>)}
    </nav>
    <p className="muted">不受课表限制，进入后自动选材；自主练习保存作品，不计入当天课程完成度。</p>
    {learning.quarantined > 0 && <a className="link" href="#/me?section=learning-sync" role="status">
      有 {learning.quarantined} 条学习记录未同步，查看同步问题
    </a>}
  </div>;
}
