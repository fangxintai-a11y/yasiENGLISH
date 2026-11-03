# R0 学习记录数据契约

日期：2026年11月3日。R0基于原P1提交`01771525`及其修正提交`e2673e49a`继续开发，用户本轮已指示进入R0。原P1提交的结论曾是需要修正后才能合并，不能把它写成此前已经复核通过。本文与通信样例复用修正后的P1契约，不修改协议、后端业务或新增训练/评分页面。

项目目标为每天固定120分钟、365天后取得同次雅思学术类正式总分≥8、听≥8.5、读≥8.5、写≥7.5、说≥7.5，四科与总分全部满足才完成。当前真实四科基线待测；样例中的日期和分数都是合成数据，不会导入用户账号，也不是学习效果证据。

## 1 版本、归属与不变性

写接口为`PUT /api/learning/v2/records/:recordId`，能力为`learningRecords:2`。请求结构：

```text
schemaVersion: 2
revisionId: 本次不可变修订UUID
mutationId: 本次请求UUID；完全相同请求重试沿用
baseRevision: 读到的当前修订UUID；首次创建为null
kind: plan | mission | attempt | essay | speaking | feedback | assessment
payload: 该类型允许的结构化字段
deleted: 可选；删除时payload为空对象
```

账号由服务端会话确定，不能用payload指定用户。planId引用同账号计划，plan自身的planId须与记录ID相同；datasetId可省略或为null，只表示词库来源，切换词库不改变计划归属。修订与mutation一旦确定，不原地改body；改稿、修复或解决冲突须新建修订。409保留冲突副本，不能当作完全未保存。

新修订标注payloadVersion=2。已有payloadVersion=1按原始数据兼容读取，旧plan业务投影不会重写历史正文/hash；旧essay不猜taskType。旧请求先按原指纹查持久化回执，尚未接收且不符合新契约的请求进入可导出隔离区；R0不能通过改旧mutation的内容强行升级。

所有未知字段仍然拒绝。单次写入上限128KiB，分页编码响应上限1MiB；另有字符串、数组、嵌套与类型限制，以[前端协议](../src/study365/protocol.ts)和[服务端校验](../server/learning.py)为准。

## 2 七类记录的R0使用规则

| 类型 | 本轮样例使用 | P1严格要求及边界 |
| --- | --- | --- |
| plan | startDate/timeZone/curriculumVersion、固定目标、120预算、enabled=false | targetBand=8，sectionTargets完整等于{listening:8.5,reading:8.5,writing:7.5,speaking:7.5}；sectionMinimum已移除 |
| mission | 具体任务、skill、状态、计划/实际分钟及计时来源 | taskId或missionId与status必填；撤销任务不删除真实attempt |
| attempt | 材料ID/版本、原始答案、首答条件、正确数、questionResults | contentId/skill/answers必填；每题ID唯一；correct不能超过total；questionResults按题保存对错、sure/unsure与错因 |
| essay | 分别提供Task 1与Task 2原稿、prompt、字数及材料引用 | text与明确taskType必填；新短段落不能省略taskType后冒充正式作文 |
| speaking | Part 1合成转写、题目、材料引用与缺原录音状态 | transcript必填，可空；recordingId/device允许null；文本不能代替声音或完整口语分 |
| feedback | Task 1/2及口语的独立反馈，引用准确原稿修订/hash | workRevisionId/inputHash/source/text必填；workId存在时须匹配；服务端核对实际原稿类型 |
| assessment | baseline、G1–G4、official与每周真人/AI/自评校准 | kind/source为枚举；日期、四科目标、实分与来源按测评类型校验；不把派生达标布尔值入库 |

`conditions`可为短文本，或仅含replays、transcriptViewed、replayed、viewedTranscript、firstAttempt、unseen、timed的对象。examMode、hintUsed与任意评分者对象尚不是已实现字段，不能塞入未知属性或用notes假装结构化核验。

评分来源为self、rules、ai、human、official。Task 1的四项为taskAchievement、coherence、lexical、grammar；Task 2对应taskResponse、coherence、lexical、grammar；口语为fluency、lexical、grammar、pronunciation。数值为0至9半分档或null。Task 1拒绝Task Response，Task 2拒绝Task Achievement；来源不清不能改填teacher之类自由文本。

错因使用P1枚举编码，例如synonym-miss、locating-error、spelling、time-pressure、word-limit、vocab-unknown、misread-question、tfng-inference、grammar、lexical-misuse、coherence、task-response、task-achievement、fluency-pause、pronunciation、other。正确题的errorCause为null，other需说明。R0阅读样例包含真实对应答案的一次误答，不能把全部答案都改成标准答案来掩盖错因记录。

## 3 测评、门槛与每周校准

| 类型/门槛 | 条件 |
| --- | --- |
| baseline | 保存真实来源与条件，未评估科目为null；合成样例不由阅读正确数推算雅思分 |
| G1，第3月末 | 总分6.5；听7/读7/写6/说6 |
| G2，第7月末 | 总分7；听7.5/读7.5/写6.5/说6.5 |
| G3，第10月末 | 总分7.5；听8/读8/写7/说7，连续两次不同日期/材料 |
| G4，正式考试 | 总分8；听8.5/读8.5/写7.5/说7.5，全部为正式来源 |
| weekly-calibration | weekIndex为1–52，引用真实workRevisionId；按作品类型保存完整四维真人分，可单独保存同稿AI、自评与可选sidecar |
| official | 正式来源、日期与完整四科成绩；最终是否满足项目目标由纯函数计算 |

门槛保存gateId/date/targets/scores/scoreSources；G3另保存consecutiveIndex=1或2。targets必须逐值匹配P1门槛定义，写说非空分只能human或official；G4所有非空分来源必须official。缺科分与对应来源同时为null，不造分；未齐全的G4记录可暂存但不会通过。

同一周同一作品可以存在human、ai、self多条校准记录，不覆盖彼此。样例的每条校准都同时提供workId、workRevisionId与inputHash，绑定同一准确原稿；正文改动后不能挪用旧反馈。P1可计算同稿各维差值并对绝对偏差≥0.5提示，R0只验证数据及互操作，不新增偏差图或培训UI。

## 4 共享合成通信样例与真实写读

[r0-records.json](../src/study365/fixtures/r0-records.json)使用fixtureVersion=2，purpose固定为synthetic-wire-examples-not-user-learning-records。records按计划、作品在其引用者之前排列；每条包含recordId、完整request与expectedContentHash。覆盖七种类型并允许同类型多条记录，不能再断言“恰好七条”。

attempt、essay与speaking通过contentId/contentVersion锁定[R0样本目录](../public/curriculum365/v1/samples.json)，题目文字与答案结构同步更新。阅读首答与questionResults一一对应：正确题必须属于accepted，错误题必须不属于accepted；correct/score/total与实际结果一致。G门槛中的synthetic材料标识仅证明通信格式，不表示相应真题或完整测试包已进入仓库。

essay和speaking的hash分别对原始text/transcript UTF-8字节计算；其他类型按规范排序JSON计算。inputHash只校验对应正文，题目/图表语境由作品修订及材料版本追溯；不能称正文hash包含全部输入。改prompt或元数据也需要新作品修订，不能仅以hash相同认成同一份作品。

TypeScript测试验证严格校验、共享hash、Task 1/2、来源、错因、门槛与校准引用。Python读取同一JSON，通过真实LearningStore依序写临时SQLite、重放同一请求、重开数据库、逐条回读，并确认旧词汇快照无写入。额外通过实际数据库引用拒绝错hash、错workId、缺原稿以及Task 1自报Task 2的跨稿反馈；不能只用JSON格式验证替代写读互操作。

负例每次只改一个约束，分别断言具体字段对应错误；TypeScript独立命名test，Python具名subTest继续执行所有条件。改前失败日志与最终通过数量见R0交付记录；只记录实际执行，不补写未运行的失败证据。

## 5 尚未开放的业务与后续阶段

R0只落实规则、内容样例和数据边界，当前没有R1今日任务或训练/评分页面。用户级存储、坏记录隔离、录音ZIP及SQLite迁移沿用P1，不重做同步。录音仍在本机，文字/元数据可同步；缺录音不能假装可以云播放，音频上传另评审。

speaking.sessionId、feedback.reviewer、assessment.evidenceRefs等字段仍未开放。后续阶段按实际需要先设计结构、版本和迁移，再同时修改前后端与共享样例。完整写作需Task 1和Task 2证据，完整口语需Part 1/2/3及原音频；单篇/短段/转写不冒充完整成绩。

顺序为R0开发验证、独立提交推送阶段分支、停止复核；通过后才做S0，再复核后进入R1。阶段分支交付不等于合并main或生产部署，R0合成分数不确认任何真实学习目标已实现。
