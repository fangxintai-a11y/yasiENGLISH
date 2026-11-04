import { useLearning } from "../repository";

export function LearningLinks() {
  const learning = useLearning();
  return <nav className="data-actions" aria-label="学习计划入口">
    <a className="btn btn-ghost" href="#/listening">听力与听读错题</a>
    <a className="btn btn-ghost" href="#/reading">阅读与听读错题</a>
    <a className="btn btn-ghost" href="#/speaking">口语与我的作答</a>
    <a className="btn btn-ghost" href="#/writing">写作与我的作品</a>
    <a className="btn btn-ghost" href="#/progress">进度与成绩本</a>
    {learning.quarantined > 0 && <a className="btn btn-ghost" href="#/me?section=learning-sync" role="status">
      有 {learning.quarantined} 条学习记录未同步，查看同步问题
    </a>}
  </nav>;
}
