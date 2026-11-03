# 雅思星图 · Band Galaxy

**按雅思的考法记单词，再把单词放进句子里说出来。** 一个词三条记忆曲线，从考试那天倒推每天的计划，答题自动评分，还能预测考试当天你记得多少个词；新词先在雅思例句里见面，学完接着跟读这些句子。

本项目在开源项目 [词光 Word Atlas](https://github.com/designfuchen/word-atlas)（7,298 个雅思词条，配插画和英美发音）的基础上，加了一层雅思专用的学习引擎，并整合了以下几份公开资料：

- [DictionaryByGPT4](https://github.com/Ceelog/DictionaryByGPT4)：词根和记忆辅助
- 雅思王听力语料库：听力高频词
- Academic Word List：写作学术词
- FSRS：间隔重复算法
- 统一评分接口：本地评分默认，可选 OpenAI 兼容接口或复制提示词，每周真人校准
- [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx)：开源语音合成，全部例句和短语用同一个声音（af_heart）重新朗读
- [CMU 发音词典](https://github.com/cmusphinx/cmudict)：按发音拆音节、标重音

> 个人学习测试用途。第三方内容的来源和许可见 [`data/sources/README.md`](data/sources/README.md)；如涉及侵权，相应内容会移除。

## 365天8分训练开发

项目目标：**每天固定120分钟，学习365天后取得雅思学术类总分至少8.0，同时听力至少8.5、阅读至少8.5、写作至少7.5、口语至少7.5，全部满足才完成。** 当前四科基线待测，第0周先做真题基线，第1个月起练雅思题型、C1核心词和AWL。阶段预算、每周模考与真人校准、G1–G4门槛见[开发方案](docs/365-training-redesign-2026-11-03.md)。

当前开发范围为[S0评分与反馈](docs/365-s0-delivery.md)，基于R0修正4220ae057，继承P1账号、SQLite与独立学习数据通路。本轮统一本地评分、复制提示词、自动接口与真人校准映射，保留旧作品和学习记录；完成后停下复核，通过后才进入R1。今日全科任务、完整写作和口语工作台尚未交付，样本校验不代表全年课程或提分效果已验证。

## 和普通背单词 app 的不同

| | 做法 | 为什么记得更快、更牢 |
|---|---|---|
| **一个词，三种记忆** | 阅读识别（3 秒内认出）、听力拼写（听写，拼错不得分）、写作产出（看中文和语境写出单词），三张卡各走一条 FSRS 曲线。识别稳定后，再解锁听写卡（王陆语料库中的 1,672 个词）和产出卡（AWL 中的 833 个词）。 | 认识、会拼、会用是三种不同的记忆。只练考试会考的那一面，不浪费时间。 |
| **考试日倒推引擎** | 根据考试日期、目标分数和每天的分钟数，算出每天学多少新词。考前 7 天只复习；考前 14 天把目标记忆率升到 95%。首页显示「考试当天预计记得 X / Y 个目标词」，以及「如果今天起不复习，只剩 Z 个」。 | 每张卡在任意时刻的回忆概率都由 FSRS 算出来，所以预测是计算结果，不是估计。 |
| **客观评分** | 没有「认识 / 模糊 / 忘记」按钮。答错记为重来；答对但超时、用了提示或重播记为困难；其余记为良好。每题都显示「1.8 秒 · 记为良好」。 | 自评总是偏高。在考场上，要想 5 秒才认出来的词，等于不认识。 |
| **永不爆仓** | 复习按「对考试的价值 × 遗忘风险」排序，每天只安排做得完的量。复习积压时暂停新词，其余复习自动平摊到之后几天。 | 背单词 app 最常见的弃坑原因是复习堆积太多，这里直接避免了。 |
| **会变暗的星图** | 每颗星的亮度等于此刻能想起这个词的概率，快忘的词会暗成余烬。首页会显示「今晚 N 颗星会变暗 → 先救它们」。 | 遗忘曲线变成看得见的东西，复习就有了动力。 |
| **同义替换星座** | 稳定的词会以替换题出现（「原文被改写了，哪个词能替换它？」），词条页会画出这个词的同义词星座。 | 雅思阅读和听力的核心考点就是同义替换。 |
| **拼写诊断** | 听写拼错时，会指出错误类型：双写字母、-ance/-ence、不发音字母、ie/ei 等；并按你最常错的类型出专项听写。英式和美式拼写都算对。 | 针对性地纠正你自己的错误模式。 |
| **3 分钟摸底** | 从 B1 开始自适应出题，每级 6 题，6 秒内答对才算认识。已经掌握的级别不再从头教，只在未来几周内分散抽查。 | 不在已经会的词上浪费时间。 |
| **睡前学，晨间回测** | 晚上推荐学新词；第二天早上首页会出现「晨间回测：昨晚的 N 个新词」。 | 睡眠有助于巩固刚学的内容。 |
| **错词阅读** | 把错词的词库例句按主题组成短文，配 True / False / Not Given，保留原句证据和翻译，也可选择复制提示词或自动接口。 | 练习同义替换与原文定位。 |
| **造句批改** | 本地规则给出0–3分、命中依据和词库例句；外部结果可显示8分参考句，同日首次批改计入产出卡复习。 | 主动用出目标词，检查搭配和句子结构。 |
| **句子优先 + 跟读**（默认开启） | 新词先在雅思语境例句里见面，听完整句再单独听单词，先从上下文猜意思。每轮学完，接着跟读这些词的句子：听 → 跟（影子跟读）→ 说（只看中文和首字母，录下自己）→ 比（原声和自己的录音连着听）；浏览器支持时逐词识别打分。练过的句子按 1、3、7、16 天回来；第一次和最近一次的录音存在本机，下次能听到「第一次的你」。单词那条线不变：新词数量、FSRS 复习、单独考单词的测验都照常。 | 词在句子里记得更牢，口语素材也一起攒下。开口练的句子都来自你刚学的词。 |
| **点单词拆音节** | 点大标题里的单词，按发音拆成音节（com·fort·a·ble、sus·tain·a·ble），重音节画线，慢速朗读时逐个音节点亮。 | 长词按音节记，读和拼都不容易错。 |
| **邪修记法** | 老忘的词给出音节拆分，你自己写谐音和画面；拼写提示一次给一个音节，拼错时标出错在哪一节；答错的词当场连对三次才放过；624 对易混词（adapt / adopt、affect / effect）故意放进选项里对撞，另有专项；一分钟闪测，3 秒一个词。 | 用少的时间把最难的那部分记住。 |
| **文章取词** | 粘贴任意英文（真题或外刊），列出你没学过的词和快忘的词，一键排进新词队列。 | 学的就是你正在读的内容。 |

## 手机上使用

个人账号同步需要部署同源服务器后端。目标部署配置为 **https://ibaz.cn:8443/**；本轮仅开发S0，未核验当前线上版本，也未发布。

GitHub Pages 纯静态入口：**https://fangxintai-a11y.github.io/yasiENGLISH/**（仅本机进度，不提供账号服务）。

- iPhone：用 Safari 打开 → 分享 → 「添加到主屏幕」
- 安卓：用 Chrome 打开 → 菜单 → 「添加到主屏幕 / 安装应用」

添加后像 App 一样全屏打开。想完全离线使用，在「我的 → 离线包」里连 Wi-Fi 下载（默认约 710 MB，可按插画、英音、美音、例句与短语朗读分别勾选）；下载完成后，没网也能学习。自动接口和进度同步需要联网。在部署了同步后端的服务器网站上，可在「我的 → 学习进度同步」设置个人账号，手机和电脑登录同一账号后自动同步；GitHub Pages 仍为仅本机模式。也可以手动导出、导入备份。

`main` 分支每次更新都会由 `.github/workflows/pages.yml` 自动构建并发布。首次使用前需要在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**。

## 本地运行

需要 Node.js 20 以上。仓库包含完整的插画和音频（约 870 MB）。

```bash
git clone https://github.com/fangxintai-a11y/yasiENGLISH.git
cd yasiENGLISH
npm ci
npm run dev        # http://localhost:5188
```

开发账号与同步功能时，另开一个终端执行 `npm run dev:server`（Python 3.12+）。开发服务器会将 `/api/` 转发给本机 `5189` 端口，SQLite 数据保存在忽略 Git 跟踪的 `.sync-data/` 中。生产安装和数据目录见 [账号与同步说明](docs/account-sync.md)。

```bash
npm test             # 单元测试：引擎、摸底、拼写诊断、文章取词、FSRS
npm run build        # 生产构建到 dist/（PWA，可添加到手机桌面）
npm run build:ielts  # 用 data/sources 重新生成 public/ielts（雅思标签、助记）
npm run build:syl    # 重新生成音节拆分 public/ielts/syl.json
npm run build:confusables  # 重新生成易混词 public/ielts/confusables.json
```

**声音**：单词发音是词光原有的 ElevenLabs 录音（英音 Alice、美音 Sarah），统一调到约 -19 LUFS（`scripts/ielts/normalize_word_audio.py`）。例句和听力短语全部由 Kokoro（af_heart，美式女声）重新生成，同样约 -19 LUFS：`scripts/ielts/gen_sentence_audio_kokoro.py` 可断点续跑，4 核 CPU 上全部 16,914 条约 9 小时；生成后运行 `scripts/ielts/set_sentence_media.py` 更新词条的录音标记。

**评分与反馈**：默认本地评分；可在「我的 → 评分与反馈」接入任意 OpenAI 兼容接口，或复制提示词到任意助手再粘回结果。接口设置和密钥只存本机，不进备份、不进同步。

## 代码结构

在词光原有结构的基础上，新增或改动的部分：

```
src/ielts/
  exam.ts          考试日倒推引擎：目标词、阶段、负荷模型、考试当天预测、每日优先级
  placement.ts     自适应摸底和已会词的抽查排期
  spelling.ts      拼写诊断（Damerau 对齐 + 错误分类）、英式 / 美式变体
  textimport.ts    文章取词与词形还原
  tags.ts          加载雅思标签和助记数据
  shadow.ts        跟读：选句、间隔、逐词进度、识别比对
  syllables.ts     音节拆分的加载、慢读进度、按音节提示
  confusables.ts   易混词表
  scoring/*        本地评分、统一反馈、提示词与真人校准映射
  llm/*            可选兼容接口、结构校验、顺序回退和本机配置
src/lib/recorder.ts / speech.ts / voices.ts  录音、浏览器语音识别、本机声音日记（IndexedDB）
src/pages/Shadow.tsx   跟读：一句四步、连击、声音日记
src/ui/Headword.tsx    点单词拆音节、慢速朗读
src/store/session.ts   三轨卡片、新题型（同义替换、听写、产出）、客观评分
src/pages/Ielts.tsx    雅思专项：考试计划、拼写诊断、同义替换、易混词、一分钟闪测、文章取词、错词阅读、造句批改
src/pages/Today.tsx    考试倒计时与预测、救星、三种记忆、晨间回测
src/pages/Onboarding.tsx  考试设定和 3 分钟摸底
src/galaxy/            星图亮度 = 回忆概率
scripts/ielts/build_ielts.py  生成 public/ielts/*（另有 build_syllables.py、build_confusables.py 和录音脚本）
data/sources/          第三方原始数据
```

词汇进度先自动保存在浏览器localStorage；登录个人账号后，词汇进度和设置通过原快照通路同步到SQLite。365计划、作文、任务和测评使用独立IndexedDB与学习记录API v2，按用户保存；切换词库不会隐藏整份计划，datasetId仅记录词库来源。坏记录进入可重试、可导出原文的隔离区，不阻塞无关记录。

录音保存在本机IndexedDB，可在“我的 → 学习录音备份”导出含音频和manifest的ZIP，并在另一设备手工导入；不会随文字自动上传。旧声音日记属于另一套存储，本次ZIP只覆盖独立学习记录的录音。离线媒体存Cache Storage，录音、离线包与API Key不进入词汇快照。账号支持修改密码、查看登录设备和撤销其他设备的登录。

## 许可

- 代码：MIT（沿用词光，见 [LICENSE](LICENSE)）
- 词光的词库、插画和录音：CC BY 4.0（Word Atlas contributors），见 [CONTENT_LICENSE.md](CONTENT_LICENSE.md)
- `public/ielts/mnemo`：来自 DictionaryByGPT4，CC BY-SA 4.0
- 例句和短语录音：用 Kokoro-82M（Apache-2.0）生成
- `data/sources/cmudict-atlas.txt`：CMU 发音词典节选，BSD 2-Clause
- 雅思王听力语料库、Academic Word List：版权归原作者，这里只用于个人学习测试，详见 [`data/sources/README.md`](data/sources/README.md)

词光原项目的说明见 [docs/word-atlas.md](docs/word-atlas.md)。
