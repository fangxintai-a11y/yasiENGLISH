# R4 本机听读材料

真实题目、原文和音频仅放`local-content/`和`public/local-bank/`，两者均已加入Git忽略。公开仓库只保留schema、导入和检查脚本、自写测试数据。材料原件不进入学习记录数据库；账号同步仅保存后续练习的作答与材料引用。

## R4-2 阅读导入

把合法取得的`hwttop5/ielts-reading-past-papers`保存在本机，然后运行：

```bash
node scripts/import-local-bank.mjs reading --from local-content/ielts-data/reading/hwt
node scripts/check-local-answers.mjs
```

入口支持普通`node`，内部使用仓库已有的tsx，不新增依赖。`--from`可指向仓库或`src/generated/reading-native/exams/`目录。可用`--out`、`--bank`、`--log`指定输出；默认分别是`public/local-bank/`、`local-content/bank.json`、`local-content/import-log.json`。

脚本读取真实`ReadingExamDocumentV1`节点树，保留正文段落、原段标、原题号、题序、选项池与填空位置，映射判断、标题配对、信息配对、人物/特征配对、填空和选择题。多选保留`groupId`、`selectionCount`及各答案槽，不把无序的两个答案变成有先后顺序的独立单选。P1/P2/P3与high/medium/low频率保留；频率不是难度。

逐篇校验，坏篇和未安全映射的图示、未知题型、缺答案或坏段落引用写入日志，其他篇继续。不会补假答案、猜题干、从右侧题目控件的anchor伪造原文证据。正文不会为了字数或覆盖词要求改写。相同ID和版本重复时去重；同版本内容不同保留已有原件，新增材料应更新版本。标题按英文字符归一后重复的源别名另行记录，不充作新文章。

## 来源与答案待核

导入材料保留`source.materialSource/sourceRef/rights/answerVerified`、`scope`和内容hash。HWT材料为unofficial，答案默认待核，不把JSON导入成功当作独立人工审校完成。

`check-local-answers.mjs`只检查填空原词、段落引用或已提供的真实原句能否定位。判断题标签与选择题字母本身不是原文证据；NOT GIVEN的相关语境不构成支持或反驳证明。机械检查不能确认答案语义正确，也不会改写accepted答案。报告写入`local-content/answer-check-report.json`；待核标记另写`bank.checked.json`，原`bank.json`和源JSON不覆盖。可用`--from`、`--out`、`--checked`指定路径。

本机首次实测：源commit`05b95b595142b4568551490844df840e9c1853fc`有217个结构化文件，全部源标题归一后215个。当前安全映射192篇，其中1个同标题别名跳过，最终输出191篇、2572题；其余25篇按具体原因跳过。2572题均未标作人工审校完成，机械检查有1218题未找到可靠定位。这些是当前导入结果，不是全年内容全部就绪。

## 浏览器题库与音频

“我的 → 本机听读题库”可导入`importVersion:1, materials:[]`的JSON。独立IndexedDB为`band-galaxy-local-bank`，与原学习记录和录音数据库分开，按当前账号或访客隔离。读取顺序为本机有效材料、同源`/local-bank/manifest.json`逐篇校验、原有内置离线兜底。坏篇不阻断其他材料；兜底不持久化遮住稍后生成的真实目录。

题库目录和JSON只导入材料元数据，不一次加载整库音频。选定一份听力后才在线读取、校验并缓存这一份；之后断网可从本机Blob播放。没有缓存时明确提示缺文件，不能把音频引用说成本机已可播。播放器得到的临时URL不参与材料hash。内置兜底保持原ID、标unofficial并沿用原审校状态；音频复用既有provenance里的SHA。

JSON本身不包含音频。带原音频的小ZIP包和官方/剑桥/XiaHua适配在R4-3接续；不会默认把整个核心音频库打进一个内存ZIP。清除浏览器数据会丢掉本机题库和缓存，应保留原始材料包。任何题库导入都不自动上传正文或音频。

## 当前验证边界

R4-2有schema、原生AST映射、机械答案检查和普通node逐篇容错测试；模块新增时的旧红灯仅为入口缺失，如实记录。证据offset曾在当前初版错误放行，独立反例实测先红后绿。真实隔离Chrome验证了兜底后发现新目录、首次零音频请求、单份缓存与断网实际播放、账号隔离、同版本冲突、IDB失败和Me文件导入；390px无横向溢出。这些不代替后续完整听读练习和跨设备端到端验收。
