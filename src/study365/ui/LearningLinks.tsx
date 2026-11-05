import { useLearning } from "../repository";

export function LearningLinks() {
  const learning = useLearning();
  return <section className="panel" aria-label="四科练习与学习记录">
    <h2>四科练习入口</h2>
    <p>听、读、写、说从这里进入。计划开始后，上方“365天学习计划”会按当天课表显示具体任务。</p>
    <nav aria-label="学习计划入口">
      <div className="data-actions">
        <a className="btn btn-ghost" href="#/listening">听力与听读错题</a>
        <a className="btn btn-ghost" href="#/reading">阅读与听读错题</a>
        <a className="btn btn-ghost" href="#/speaking">口语与我的作答</a>
        <a className="btn btn-ghost" href="#/writing">写作与我的作品</a>
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
