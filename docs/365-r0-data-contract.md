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

以上是R0交付时的阶段边界：R0开发验证、独立提交推送阶段分支、停止复核；通过后才做S0，再复核后进入R1。当前S0后续修正仍待用户复核。阶段分支交付不等于合并main或生产部署，R0合成分数不确认任何真实学习目标已实现。

## 6 后续数据扩展设计（本轮不实现）

计划更新于2026-11-04，覆盖清单C1–C7与D1–D8。以下是后续工作包的设计项；按2026-11-04 R1任务书，C1–C7转入R4，考试形式/考务转入R6，泛读泛听调整转入R5。本轮R1仅使用当前已有字段，**下列规划字段尚未在P1 API v2、SQLite或IndexedDB开放**；§1–§4的严格契约与R0历史验证不变。现有协议拒绝未知字段，不能把下列对象直接写入当前payload或改塞notes。实施时需先确定协议/能力版本及兼容策略，同步升级前后端schema、数据库迁移、共享fixture与业务入口；旧修订正文、hash和outbox请求保持原样。

### 6.1 材料目录、导入与来源（C1–C6、D1/D2）

未来导入格式为UTF-8 JSON对象：`importVersion:1`、`materials:[]`；每项包含materialId、version、topicId、title、materialSource、sourceRef、rights和deliveryMode。deliveryMode为local-original或external-link；local-original另含paragraphs与questions，外链仅含合法外部URL/定位信息，不含真题原文或音频。题目最少包含稳定id/type/prompt/accepted，以及证据锚点或NOT GIVEN相关语境锚点；具体题型仍复用并扩展R0材料schema，不从合成答案反推不存在的原文证据。

| 规划字段 | 类型/用途 | 读取、统计与迁移边界 |
| --- | --- | --- |
| materialId / version / contentHash / topicId | 锁定某份材料、正文版本与主题；正文可得时记录hash | 历史作答引用不可指向同ID换题。外链未取得原件时hash为null，不伪造正文已存在。 |
| materialSource | official / cambridge / publisher / unofficial | 仅描述材料来源，与评分者source区分；新导入必选并核对来源，不能默认official。自编材料属unofficial。旧记录缺值保持未分类，不改旧payload；经用户核对后另建来源关联修订。 |
| sourceRef | 官方/出版资源URL、名称、试卷/页/题定位及核验日期 | 来源是官方站并不表示其自动评分是正式分；不因用户只填枚举就声称已核实来源。Cambridge条目需具体出版物/测试定位，不能仅写出版社名称。 |
| rights / accessStatus | 许可说明；ready-local / external-required / planned | 外链、待登录或待合法取得不等于材料就绪；只按真实可用状态计库存。私有原件仅本机保存，同步引用与允许的学习元数据，另一设备缺原件如实提示。 |
| paragraphs / questions / evidenceAnchors | 自编或用户合法本机材料；段落、题目和字符范围 | C3长文与短专项分开。C4证据位置统计、C5顺序与C6数字分布只校验适用材料；官方原题不为阈值配平而改写。 |

年度目录至少30主题、365独立材料是未来容量目标，实际交付仍逐日核对14天库存和备用池；合成排程不算内容库存。连续14次阅读不重复主题；重复训练可保留但不再计为新材料首答。JSON导入检查重复ID/版本、题目引用、必填来源/许可和外链URL，字段数量与正文上限在协议评审时落地，不能突破当前128KiB请求上限。

门槛与主“距8.0的差距”未来增加材料来源筛选：所有被计入科目的材料来源须为official或cambridge；publisher、unofficial及未分类旧记录保留原分并标“参考”，不进入主统计。通过来源筛选后，仍须满足完整科目、计时/未见题等条件及评分者来源要求；写说只认human/official。G3仍要不同日期/不同材料的连续两次；G4仍只认同次正式成绩，成绩单作为正式测评证据，不要求保存试卷题文，Cambridge练习不能触发完成。materialSource不会扩大现有source权限。

验收用四种来源与缺值的同分测评逐一断言资格，特别覆盖“official材料+自动估分”和“cambridge材料+真人练习分”均不能当正式成绩；来源修订后可重新计算派生视图，但不能改旧分数、hash或历史原稿。

### 6.2 阅读覆盖信息（C2/C7）

规划在独立阅读记录的结构化元数据中保存`coverage`：requestedWordIds、coveredWordIds、uncoveredWordIds、matcherVersion、materialId、materialVersion、contentHash和computedAt。三组ID去重且covered/uncovered不交叉，二者并集必须等于requested；保留全部有效请求词，不能删掉未覆盖项来提高比例。正文实际目标词及屈折匹配与题目同义改写分别保存解释，近义词本身不冒充原词命中。

R4目标词长文要求每组12词至少覆盖8词并有至少2处证据绑定改写；B1/B2、B2–C2各100组分开测，每组最多3次尝试，每个集合至少80组产出合格阅读才通过。分母固定100组并记录尝试/拒绝/失败、平均覆盖和零覆盖数，无有效产出算失败，不能靠拒绝全部材料空通过。篇幅、证据位置、判断题文序与数字题分布的完整阈值见[总方案§9.2](./365-training-redesign-2026-11-03.md#92-c1c7r1阅读页面计划与验收)。未达覆盖要求明确显示不足或另选材料，不能冒充达标。

与首答记录一并本机保存并通过独立学习通路同步，不能只留React状态，也不回塞词汇Progress。旧记录没有coverage时显示“未知”，不补成0或倒算并覆盖旧记录。材料或匹配器改版建立新的计算/记录引用，历史版本可回读。验收在刷新、关闭重开、离线恢复及同账号换设备后逐字段比较；账号切换不可见另一人的覆盖信息，冲突两份保留。

### 6.3 考试形式、官方熟悉与考务（D1/D3/D4）

规划计划元数据保存`examDeliveryMode`（computer / paper / computer-writing-on-paper）、报考地区、modeVerifiedAt和官方modeSourceUrl；这不等于当前conditions已有examMode字段。仅能选实际报考地区仍提供的形式，未知先不选，不能全球默认纸笔可报。官方入口目录另存技能、用途、访问条件、URL和verifiedAt；只链接[总方案§9.3](./365-training-redesign-2026-11-03.md#93-d1d8采纳内容工作包与验收)已核对的官方资源，练习目录不算已完成测评。

机考计划建立周0、考前4周两个熟悉任务引用，保存实际日期、科目、用时、完成/未完成状态及官方链接；可拆日，所有分钟计入既有120预算。写作使用与所选考试形式一致的输入方式；界面练习不能自动写出完整写说分。考期改动后重新排任务，保留历史任务和已完成证据。

考务清单只保存同证件自查状态、考点/官方入口、核验日期、出分查询状态、EOR申请状态/官方截止日、反诈骗提醒确认；不存身份证件号码、照片或扫描件。出分天数和EOR费用按实际考区重新核对，不固定全球值。EOR结果如导致正式成绩更新，新增assessment修订并保留旧成绩，不能原地抹去原分。源网页核对日期为2026-11-04，直接抓取受限的IDP页按官方搜索正文核对；开发前再验实际可访问入口。

验收覆盖形式未选、考区不提供该形式、两次熟悉任务、改期重排、每天预算120、清单状态和官方URL；不得因勾选清单或做过熟悉任务而通过G4。

### 6.4 泛读泛听与写说自查（D5–D8）

| 工作包/规划数据 | 保存与显示 | 验收边界 |
| --- | --- | --- |
| 阶段二/三泛读泛听 | 每周2条任务，一次文章、一次播客，各10–15分钟；保存来源URL、skill、实际分钟与取词引用 | 分别占既有听/读预算，不增加日总时长；示例周每日仍120。0个生词可保存，不把取词量当理解成绩。 |
| S2写作自查 | 引用workRevisionId/inputHash；拼写错误位置、去重计数、检查状态与用户确认；Task 1的overview/comparison/no-personal-opinion三项 | 未检查为null，检查后无错为0；误报可纠正，修订后旧检查仍属旧稿。Task 2不套“不写个人观点”，计数不映射雅思分。 |
| S4口语练习 | 录音引用与真实durationSeconds；Part 1练习20–30秒、Part 2练习120秒；一张过渡句练习卡ID及完成记录 | 计时不足如实提示，不补时、不直接扣成雅思分；Part 1是练习建议，Part 2官方允许1–2分钟，项目练习取2分钟。过渡卡不存背诵整段答案作完成条件。 |
| S2/S4成绩标签 | 沿用现有rules/ai/human/official评分来源、作品准确引用及条件，前两者在工作台显示“估分” | 本地和外部自动/粘贴分均不能进入写说门槛；human/official仍需满足实际测评条件。materialSource与标签/评分者分开，任何来源材料均不将估分变正式分。 |

上述未来新增字段必须有独立负例、兼容旧缺失数据的读取和成套写读测试；UI工作包名称与原R阶段的对应、官方来源及人工验收标准以总方案§9.3为准。S0本轮不实现这些数据项，完成修正后停止等待用户复核，不开始R1。
