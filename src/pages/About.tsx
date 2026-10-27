import { Database, Github, Heart } from "lucide-react";
import { useAtlas } from "../atlas/context";
import { REPO_URL, UPSTREAM_URL } from "../config";

const BASE = import.meta.env.BASE_URL;

export function About() {
  const atlas = useAtlas();
  return (
    <div className="page about">
      <header className="about-hero">
        <img src={`${BASE}brand/og.webp`} alt="" />
        <div>
          <p className="eyebrow">关于雅思星图</p>
          <h1 className="display">按雅思的考法，记住每一个词。</h1>
          <p className="lede">
            雅思星图在开源项目「词光 Word Atlas」的 {atlas.count.toLocaleString()} 个插画词条之上，加了一层雅思专用的学习引擎：一个词三条记忆曲线、从考试日倒推的计划、客观评分和考试当天的记忆预测。
          </p>
          <p className="lede">免费、开源、无需注册，进度只存在你的浏览器里。</p>
          <div className="about-actions">
            <a className="btn btn-primary" href={REPO_URL} target="_blank" rel="noreferrer">
              <Github size={18} /> 本项目源码
            </a>
            <a className="btn btn-ghost" href={UPSTREAM_URL} target="_blank" rel="noreferrer">
              <Database size={18} /> 词光 Word Atlas
            </a>
          </div>
        </div>
      </header>

      <div className="about-grid">
        <section className="panel">
          <h3 className="eyebrow">为什么记得快、记得牢</h3>
          <ul className="feature-list">
            <li>
              <b>一个词，三种记忆。</b>阅读要 3 秒内认出，听力要一字不差地拼对，写作要主动用出来。三张卡各走各的 FSRS 记忆曲线。
            </li>
            <li>
              <b>从考试那天倒推。</b>每天学多少由剩余目标词、剩余天数和你的真实答题速度算出；考前 7 天只复习，考前两周复习加密，让记忆在考试当天达到峰值。
            </li>
            <li>
              <b>不让你骗自己。</b>没有「认识 / 模糊 / 忘记」按钮：对错、反应时间、是否用了提示，自动决定这张卡的成绩。
            </li>
            <li>
              <b>永不爆仓。</b>复习按「考试价值 × 遗忘风险」排序，每天只做塞得进时间的部分；积压时暂停新词，先救最要紧的。
            </li>
            <li>
              <b>看得见的遗忘。</b>星图上每颗星的亮度就是此刻的回忆概率；快忘的词会暗成余烬。
            </li>
            <li>
              <b>已经会的不再从头学。</b>3 分钟摸底后，熟悉的级别只做分散抽查。
            </li>
          </ul>
        </section>

        <section className="panel">
          <h3 className="eyebrow">快捷键</h3>
          <dl className="keys">
            <div>
              <dt>
                <kbd>⌘</kbd>
                <kbd>K</kbd> 或 <kbd>/</kbd>
              </dt>
              <dd>搜索任何词</dd>
            </div>
            <div>
              <dt>
                <kbd>1</kbd>–<kbd>4</kbd>
              </dt>
              <dd>选择答案</dd>
            </div>
            <div>
              <dt>
                <kbd>Enter</kbd>
              </dt>
              <dd>确认 / 继续</dd>
            </div>
            <div>
              <dt>
                <kbd>←</kbd> <kbd>→</kbd>
              </dt>
              <dd>词卡里切换上一个、下一个</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>关闭弹窗</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <h3 className="eyebrow">内容从哪里来 · 致谢</h3>
          <ul className="credits">
            <li>
              <b>词光 Word Atlas</b>：词条、插画、英美发音、例句与星图。代码 MIT，内容 CC BY 4.0（Word Atlas contributors）。由 AI 生成、未逐条人工审校。
            </li>
            <li>
              <b>DictionaryByGPT4</b>：词根词缀、记忆辅助和小故事（CC BY-SA 4.0）。由 GPT-4 生成，仅供参考。
            </li>
            <li>
              <b>雅思王听力语料库（王陆）</b>：用于标注听力高频词和短语听写。版权归原作者，本项目仅个人测试使用，如涉侵权会移除。
            </li>
            <li>
              <b>Academic Word List</b>（Coxhead, 2000）：用于标注写作产出词。
            </li>
            <li>
              <b>FSRS / ts-fsrs</b>：开源间隔重复算法（MIT）。<b>Claude API</b>：AI 阅读与批改，使用你自己的 Key。
            </li>
          </ul>
          <p className="muted">这不是官方雅思词表，也不承诺提分；考试当天的记忆预测是模型估算，会随你的复习数据越来越准。</p>
        </section>
      </div>
      <p className="colophon">
        <Heart size={14} /> 做给每一个在背单词的人。
      </p>
    </div>
  );
}
