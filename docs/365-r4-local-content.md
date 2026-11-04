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

JSON本身不包含音频。小ZIP包同时带正文和原音频，校验完成后一次事务导入当前账号的本机题库；不会自动上传。清除浏览器数据会丢掉本机题库和缓存，应保留原始材料包。

## R4-3 本机源适配与小包

以下命令只解析已经存在的本机文件，不下载材料。各模式可以合并到同一个新输出库；旧库和旧版本保持原样。当前转换版本分别为`native-reader-v2`和`bank-r4-v1`，避免新词数解析结果误用旧版本的同ID/hash保护。

```bash
node scripts/import-local-bank.mjs reading --from local-content/ielts-data/reading/hwt --bank local-content/r4-ready-bank.json --log local-content/r4-reading-import-log.json
node scripts/import-local-bank.mjs cambridge --from local-content/ielts-data --bank local-content/r4-ready-bank.json --log local-content/r4-cambridge-import-log.json
node scripts/import-local-bank.mjs xiahua --from local-content/ielts-data/listening/xiahua --bank local-content/r4-ready-bank.json --log local-content/r4-xiahua-import-log.json
node scripts/import-local-bank.mjs official --from local-content/ielts-data/official --bank local-content/r4-ready-bank.json --log local-content/r4-official-import-log.json
node scripts/import-local-bank.mjs pack --from local-content/r4-ready-bank.json --ids c4t2s1 --out local-content/packs/c4t2s1.zip
npm run test:r4-import
```

`pack`必须选择`--ids`、`--book`或`--limit`；`--ids`支持逗号分隔的材料ID或原始sourceRef，`--book 4`选择剑4，`--limit 3`仅前三份。音频默认从`public/local-bank/`读取，也可用`--audio-root`指定。先检查文件尺寸再读取，单音频不超过50 MB、小包不超过256 MB，不默认缓冲整个音频库。输出音频优先硬链接原件，跨文件系统才复制，字节与SHA保持一致。浏览器在“我的 → 本机听读题库”选择JSON或ZIP即可导入。

ZIP包含`manifest.json`、`bank.json`及被引用的`audio/`文件；manifest格式为`band-galaxy-local-bank`版本1，每项含相对path、bytes、sha256及可选mimeType。导入检查路径、重复项、CRC、SHA、声明和实际解压总量；全部验证后才写IDB，坏包不清空已有题库。JSON导入不带音频时需在线选定单份准备缓存；ZIP导入的音频可直接离线播放。同账号不同设备仍需分别导入或缓存本机材料，原文和音频不经SQLite同步。

剑桥适配读取现有yanbo原始题组及lincoh/taro结构化材料，taro优先并报告答案差异；未有可靠题干的剑3只能精听，不补造题目。`listening`模式同样支持本机`listening/C21/T1/`这类新增套装目录：四个`C21T1S1.mp3`至`S4.mp3`，以及`answers.json`的四个`parts`（part、range、transcript、真实groups）和1–40答案。可另放`transcript.md`。单个真实整套音频须在JSON明确`scope:"full"`、`audio`、`transcript`；四个分节只记完整套的catalog，不冒充可播放的单个full音频。没有题干、缺答案、少音频或不可解码则跳过并记录原因。

XiaHua读取HTML中`script#test-data`的JSON，保留原题组、答案键、原文、P1–P4和频率；不会执行源JS。与已有剑桥按原文相似度识别别名，无法安全还原的地图/图片题组保留待核日志。所有导入答案仍待人工核对，结构校验和ffprobe不是语义审校。

完整检查池在最终schema、题数和音频验证后按固定seed选择，每科8套，写入`local-content/holdout-assignments.json`；重跑保留原分配。全套所有分节统一pool，避免同套练习与检查池互相泄漏。已有某份原文/答案PDF不能据此假称整套齐备。

阅读指令同时读取源leadNodes与contentNodes，明确的`AND/OR A NUMBER`才额外允许一个数字；普通题不放宽。源显式`(vigorous) exercise`解释为有/无可选词两种答案。若全部accepted均超出真实词数限制，则整篇跳过待核，不改答案或抬高限制。选项题使用原选项内容，不套自由填空字数限制。

## 抓取脚本与当前边界

当前按用户要求已停止材料抓取。仓库提供的脚本用于之后经授权的接手任务，不会随应用启动执行：`fetch-ielts-data.sh`及`ielts-data-scripts/`保留用户提供的来源清单和本地结构化解析器；`scripts/fetch-official-samples.sh`读取`official-samples.json`明确URL清单，支持`.part`断点、已存在SHA跳过和逐项失败日志。可先用`--dry-run`查看；没有在停止指令后运行任何实际网络下载。

官方PDF解析需要系统`pdftotext -layout`，可通过`PDFTOTEXT`指定绝对可执行路径，不新增npm PDF依赖。完整题干可忠实还原时才导入type-drill；只有原文/答案而没有题本的IELTS资源仅导入short对照或记缺口，缺图或未知布局不会伪造。实际题文、PDF、音频、解析输出和review.md均留在Git忽略目录。

当前新版实际导入（官方另见其日志）：217份HWT源安全输出189篇、2546题，其中1个标题别名和其余不支持/答案超限等共28份跳过；剑桥227份阅读（186分篇、41整套）、36节听力（9套四节齐备），XiaHua28节。两科检查池各8套；剑桥没有单文件full听力，catalog的`fullPlayable`为false。现有64份定向音频已做SHA、ffprobe和完整ffmpeg解码，均无失败；这不代表全年内容或11G数据全部就绪。

官方本机40份听读相关PDF安全输出16份：6份阅读、2份有准确音频关联的听力type-drill合计33题，另8份原文short不判分。24项缺口为6份不支持的Cambridge样例和18份只有答案没有题本的参考。最终当前目录共496份材料，所有自动映射答案仍为待人工核对。

R4-3专项包含CLI选择与50 MB预检、小ZIP原字节/哈希回导及损坏拒绝、本机file://抓取夹具和来源解析器测试。file://验证没有联网。词数、lead说明和新版本发现有具体行为红灯；新模块入口缺失的红灯只作为入口证据，不充作完整旧功能回归。

## 当前验证边界

R4-2有schema、原生AST映射、机械答案检查和普通node逐篇容错测试；模块新增时的旧红灯仅为入口缺失，如实记录。证据offset曾在当前初版错误放行，独立反例实测先红后绿。真实隔离Chrome验证了兜底后发现新目录、首次零音频请求、单份缓存与断网实际播放、账号隔离、同版本冲突、IDB失败和Me文件导入；390px无横向溢出。这些不代替后续完整听读练习和跨设备端到端验收。
