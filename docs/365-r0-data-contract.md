# R0 学习记录数据契约

日期：2026年11月3日。范围：明确P1当前可保存的记录、提供前后端共同读取的通信样例、列出后续阶段需要扩展的字段。本阶段不改变P1协议，不实现R1页面或成绩计算。

项目最终目标固定为学习365天后取得雅思总分至少8.0，四项各至少6.5。7和7.5仅为中间里程碑。此目标属于学习业务规则；P1通用记录接口当前允许0至9的目标数值，不能将“能保存8”写成已经实现8分达标判断。

## 1 当前写入与修订契约

接口为 `PUT /api/learning/v1/records/:recordId`，账号从登录会话取得。当前写入对象如下：

```text
schemaVersion: 1
revisionId: 本次不可变修订的UUID
mutationId: 同一请求重试沿用的UUID
baseRevision: 已读取的当前修订UUID；首次创建为null
kind: plan | mission | attempt | essay | speaking | feedback | assessment
payload: 对应类型允许的字段
deleted: 可选；删除时payload必须为空对象
```

记录ID是稳定业务标识，不用内容变化重新生成。修订ID和mutation ID在确定请求内容后不再改变；内容变化另建修订。`baseRevision`不一致时，P1先保存冲突副本再返回409，客户端不能把409当成全部内容未保存。

首期字段显式携带 `datasetId / planId`，以便前端与服务端使用相同样例。plan的 `planId`必须等于该计划记录ID；其他记录引用已存在的同账号计划。服务端从计划确定实际词库归属，不以客户端提供的账号字段授权。

服务端每次写入不超过128 KiB，JSON编码响应分页不超过1 MiB；单个字符串最多20000字符，递归结构、数组和对象字段数另有限制。未知根字段和未知payload字段会拒绝，不能任意放入新JSON属性。具体校验以[前端协议](../src/study365/protocol.ts)和[服务端校验](../server/learning.py)为准。

## 2 七类记录当前允许的字段

以下均加公共字段 `datasetId / planId`。加粗列出需要特别满足的条件，不表示其余字段已经具备完整业务语义或跨记录引用约束。

| 类型 | 当前允许字段 | 必须满足的主要条件 |
| --- | --- | --- |
| plan | startDate、timeZone、curriculumVersion、studyBudgetMinutes、targetBand、sectionMinimum、enabled、syllabusUnit、materialLevel、title、pauseIntervals | **startDate、studyBudgetMinutes必需**；预算只支持120/150/180；planId等于计划记录ID |
| mission | date、day、taskId、missionId、skill、status、plannedMinutes、actualMinutes、timeSource | **taskId或missionId必需，status必需**；状态为not_started/in_progress/completed/partial/minimum/skipped |
| attempt | date、day、taskId、contentId、contentVersion、skill、answers、correct、score、total、actualMinutes、elapsedSeconds、conditions、replayed、viewedTranscript、firstAttempt、isCheckpoint、note | **contentId、skill、answers必需**；correct不能大于total；首答、提示和重放条件分别保存 |
| essay | date、day、taskId、contentId、contentVersion、prompt、text、wordCount、parentRevisionId | **text必需**；parentRevisionId存在时引用同计划可用作品修订 |
| speaking | date、day、taskId、contentId、contentVersion、prompt、transcript、durationSeconds、recordingId、recordingDevice、parentRevisionId | **transcript必需，可为空字符串**；recordingId/device允许null；不接收音频Blob |
| feedback | workId、workRevisionId、inputHash、rubricVersion、source、sourceText、assessedAt、text、bands | **workRevisionId、inputHash、source、text必需**；服务端核对原稿归属和hash，workId存在时也须匹配 |
| assessment | date、day、kind、source、materialId、score、total、bands、scores、conditions、note、notes | 当前只有类型与字段校验，**尚未实现完整测评证据或最终达标判断** |

当前 `conditions`可用短文本，或仅含 `replays / transcriptViewed / replayed / viewedTranscript / firstAttempt / unseen / timed` 的对象。除replays为非负整数外，其余为布尔值。对象暂不支持examMode、hintUsed、题目级条件或评分者身份。

当前 `bands / scores`仅允许 `listening / reading / writing / speaking / taskResponse / coherence / lexical / grammar / fluency / pronunciation`，数值为0至9或null。Task 1所需的Task Achievement专用键尚未支持；不能把它冒名写为Task Response。空值表示未评估，不代表0分，也不自动用其他维度补齐。

## 3 共同通信样例

[r0-records.json](../src/study365/fixtures/r0-records.json)的顶层为 `fixtureVersion / purpose / records`。每条包括 `recordId / request / expectedContentHash`，覆盖上述七种类型，按计划、作品在反馈前的依赖顺序排列。前端与Python验证读取同一文件，避免各自手写一套样例后发生字段漂移。

这些是**合成通信样例，不是用户学习记录、真实考试成绩或已完成任务**。它们不会自动导入用户账号，题目及文字只用于验证字段、引用与UTF-8哈希。计划采用 `targetBand=8 / sectionMinimum=6.5 / studyBudgetMinutes=120`；assessment保留四项分数为空，不用基础短练习生成雅思分。

essay与speaking的当前 `contentHash`分别仅对原始text或transcript的UTF-8字节计算SHA256；其他类型对排序后的规范JSON计算hash。反馈同时引用精确 `workRevisionId + inputHash`；不能仅按正文hash查找作品。题目与图表属于输入语境，未来核验要通过作品修订及材料版本补齐，不将当前正文hash误称完整任务输入hash。

R0测试检查七种记录都能通过当前前端校验、固定hash与真实函数一致、反馈指向正确原稿；还验证未来字段在现协议中仍被拒绝。Python侧应使用同一JSON运行服务端校验和hash，并在临时数据库中依序保存，核对实际引用和幂等结果。它证明协议样例可用，不证明任务界面、完整课程或学习效果已完成。

## 4 后续阶段字段差异

下表是待实现的设计输入，不是当前已开放字段。实施时以所需的最小字段集合更新前后端和样例，先明确版本及兼容策略，再接业务页面。

| 阶段 | 业务需要 | 当前可复用 | 拟扩展与校验重点 |
| --- | --- | --- | --- |
| R1 今日任务与成绩本 | 固定8分目标、分项规划、中间里程碑、任务与尝试关联 | plan目标/预算；mission状态；assessment来源及分数 | 明确sectionTargets/里程碑配置、任务证据引用、逐科成绩来源与场次；总分8和单项6.5分别判断，来源不足不判最终完成 |
| R2 写作 | Task 1/2、题图、草稿、原稿与修改稿 | essay原文与parentRevisionId；独立修订与反馈绑定 | taskType、图表/材料引用、本机草稿结构；Task Achievement评分键；完整写作需T1/T2原稿与权重，不以单篇分替代 |
| R3 口语 | 三部分场次、录音状态、手动/自动转写及修正 | speaking题目、文字、时长、本机recordingId | part/sessionId、转写来源/人工校正与原音频关联；无原音频或仅文字时发音和真实流利度保持未评估 |
| R4 听读 | 逐题判分、信心、证据、错因、私有材料引用 | attempt答案、材料ID/版本、首答与重放条件 | questionResults、接受答案/评分规则版本、证据句/音频区间、信心/错因；私有整包仍本机，短证据同步范围明确 |
| R5 反馈与再练 | 评阅者、工具版本、反馈证据、订正与换题迁移 | feedback修订/hash/来源/正文；独立attempt | reviewer、反馈维度与原文片段、问题ID/状态、订正及复测引用；建议与原文不符时可标记，评分与修改示例分开 |
| R6 准备度与交付 | 多次独立完整测评、正式考试确认 | assessment日期/来源/条件；各类真实作品 | evidenceRefs、各科题包/尝试/作品与评阅引用、是否完整/未见/限时/无提示、formalExam来源；缺证据不得显示正式达成 |

R1若只做来源明确的手工登记，可先用已支持字段保存，并明确“手工登记、准备度未核验”。在evidenceRefs等正式契约完成前，不把notes里写的一段话当成已验证的结构化引用，也不由最后一条四科数字自动宣布项目完成。

## 5 协议演进与验收

P1尚未部署到生产，但阶段提交已在GitHub。对首次正式发布前的调整，也要保留已有本机/临时测试记录的迁移说明和前后端一致样例。不能只改TypeScript类型而遗漏服务端白名单，或用任意JSON塞进原字段绕过校验。

已经发布的旧客户端如果会拒绝新字段，后续不兼容变化应采用新能力/协议版本与对应API路径或明确兼容投影；不能让旧端读取不认识的修订后卡住整个增量游标。运行时继续检测服务能力，服务器不可用时保留草稿与outbox。

逐阶段验收包括：缺项保持未知；改稿不挪用旧反馈；迟到结果不覆盖新输入；撤销打卡不删除真实尝试；新字段两端校验一致；引用归属正确；旧词汇快照不受影响。每阶段验证后提交GitHub并停止，等待用户复核。
