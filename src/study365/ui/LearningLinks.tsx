import { useLearning } from "../repository";

export function LearningLinks() {
  const learning = useLearning();
  return <section className="panel" aria-label="四科练习与学习记录">
    <h2>四科随时练</h2>
    <p>四科随时可学，不受今日课表限制。进入后平台自动选材；自主练习保存成果，不计入课程完成度。今天的课程请从上方任务卡进入。</p>
    <nav aria-label="学习计划入口">
      <div className="data-actions">
        <a className="btn btn-ghost" href="#/listening?mode=practice">听力与听读错题</a>
        <a className="btn btn-ghost" href="#/reading?mode=practice">阅读与听读错题</a>
        <a className="btn btn-ghost" href="#/speaking?mode=practice">口语与我的作答</a>
        <a className="btn btn-ghost" href="#/writing?mode=practice">写作与我的作品</a>
      </div>
      <h3>学习记录</h3>
      <div className="data-actions">
        <a className="btn btn-ghost" href="#/progress">进度与成绩本</a>
        {learning.quarantined > 0 && <a className="btn btn-ghost" href="#/me?section=learning-sync" role="status">
          有 {learning.quarantined} 条学习记录未同步，查看同步问题
        </a>}
      </div>
    </nav>
  </section>;
}
