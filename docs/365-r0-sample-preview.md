# R0 雅思题型样本试做与实际库存

项目目标为365天后正式雅思学术类总分8.0；四科训练目标为听8.5、读8.5、写7.5、说7.5，每天固定120分钟。当前基线待测。这份材料只交付题型与内容契约、自编样本及库存记录。

本轮有7份自编草稿。城市Bellhaven、研究场景和Task 1数据均为教学虚构；没有真实研究结论或考官定级。所有内容的独立教师审校尚未完成，听力人工审听也待完成。`materialLevel: ielts-academic`是任务形式与目标材料池标签，`vocabulary.cefr: C1`与`awl: true`是词汇训练元数据；它们不证明学习者已达C1，也不认证每个词或样本的实际难度。

## 第0周先测真实起点

[库存清单](../public/curriculum365/v1/inventory.json)的D1–D3安排的是外部真题任务：D1听力与学术阅读，D2写作Task 1/2，D3口语Part 1/2/3及设置。基线引用[Cambridge IELTS 20 Academic正版材料入口](https://shop.cambridge.org/english/product/2700250101)，计划使用Test 1，但须先确认合法持有且没有做过；已见过则另选未见整套并记下具体版本和Test。仓库不提供书内题文或音频，也没有假定用户已经购买、作答或取得评分。写说基线需安排真人评阅。

British Council与IELTS.org的官方公开练习入口另列于库存中，用于核对题型和操作；不能把几个单题示例或本仓库自编练习充作完整真题基线。官方格式参考：[听力](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-listening)、[学术阅读](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading)、[写作](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing)、[口语](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-speaking)。本轮没有复制这些页面的练习正文。

材料等级允许`foundation / intermediate / advanced / ielts-academic`，由基线证据选择与调整，不随日期自动升级。等级较低时可以增加支架、拆小练习，但从第1个月就接触雅思真实题型、C1核心与AWL学术词汇。具体时间安排见[计划规则](365-r0-plan-rules.md)。

## 本轮交付与缺口

- 听力schema覆盖Section 1–4，阅读覆盖Passage 1–3及主要题型；本轮实际写成的是一个Section 4、一篇Passage 2，并未声称其余Sections和Passages已备齐。
- 写作包含Task 1表格与Task 2议论文；Task 1 schema当前支持表格，尚不包含流程、地图或其他图形输入。
- 口语提供Part 1/2/3提示与文字示例；没有伪造真人示范录音。
- 首14天为D1–D3外部材料待落实、D4七份草稿可部分试跑、其余10天材料待备。7份草稿不等于14天独立材料，也不等于教师审校完成。
- 700–900词阅读、听力至少450词是本项目R0样本完整性门槛，不是官方规定的单篇字数或难度认证；当前阅读702词、听力659词。

样本结构在[samples.json](../public/curriculum365/v1/samples.json)。R1任务工作台尚未开发；本轮可依据以下内容试做并另存首答、原稿与录音，校验通过也不会自动记录学习已完成。不要在一天内强行做完全部7份材料；按当天四科模板选择相应部分，完整写作任务保留实际20/40分钟要求。

## Section 4：城市雨水花园研究讲座

样本`listening-sample-01` · 版本2 · 建议18分钟 · 独立审校待完成。

- Section 4自编学术独白，共10题；每空按题目词数限制填写。
- 先看题，听一次并保留首答；完成后再打开文本和证据。
- 录音是单一合成音色，不包含真实考试的多口音或真人交互，也未经过人工审听。

[播放或下载合成音频](../public/curriculum365/v1/audio/listening-sample-01.mp3)。单一合成音色的学术讲座独白，与Section 4形式对应；没有模拟多人对话。音频与逐段时码、生成环境、模型来源和SHA256见[provenance.json](../public/curriculum365/v1/audio/provenance.json)。

| 题号 | 填空题 | 词数上限 |
| --- | --- | --- |
| 1 | The main process by which water enters the ground is called _____. | 1 |
| 2 | The slower soil layer contained _____. | 1 |
| 3 | Standing water should disappear within _____ after an ordinary storm. | 2 |
| 4 | The students measured the connected _____ to estimate incoming water volume. | 1 |
| 5 | The comparison sites were checked for differences in local _____. | 1 |
| 6 | Continuous measurements came from _____. | 1 |
| 7 | Drainage slowed when _____ collected near the inlet. | 1 |
| 8 | Insect observations were used to investigate _____. | 1 |
| 9 | The _____ were trained to make consistent observations. | 1 |
| 10 | The long-term budget included routine _____. | 1 |

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

Today we will examine how researchers evaluate rain gardens in urban neighbourhoods. These are shallow planted areas that receive runoff from nearby hard surfaces. Their main purpose is not simply to store water in a visible pond. Instead, they encourage infiltration, which means movement of water into the ground. This distinction matters because a garden that looks dry may already have processed a substantial amount of rainfall. Before construction, our fictional research team compared several sites. A sandy soil allowed water to pass through rapidly, whereas a layer of clay slowed it down. The team selected a site with that slower layer so they could investigate a practical difficulty rather than demonstrate an ideal case. They also recorded the depth of the soil, since performance depends on more than the material found at the surface. The design requirement was that standing water should disappear within forty-eight hours after an ordinary storm. This limit was chosen to protect the plants and keep the space usable. It was not a promise that the garden could absorb any storm, however intense. During exceptional rainfall, an overflow channel would carry excess water safely towards the existing drainage system instead of allowing it to enter neighbouring buildings. To estimate the amount of water entering the garden, the students first measured the area of the roof connected to its inlet pipe. They deliberately excluded a nearby car park because its runoff went to a separate drain. A rain gauge provided the depth of each storm. Combining that measurement with the connected area gave an approximate incoming volume, although small losses still had to be acknowledged. A second garden was needed for comparison. The students matched its size and planting pattern as closely as possible to the first. They also checked local traffic, since pollution washed from busy roads could influence water quality independently of the planting. Without this precaution, a difference in the samples might have been attributed to the gardens when it actually reflected the surrounding neighbourhoods. Continuous measurements were collected by sensors positioned at the inlet and near the bottom of the planted basin. The instruments were checked against manual readings every week, because a smooth electronic record is not necessarily an accurate one. When a battery failed, the gap was marked as missing data. The researchers did not quietly substitute an average and present it as something they had directly observed. One unexpected difficulty emerged after several months. A deposit of sediment had formed close to the inlet, reducing the rate at which water could enter the planting bed. Removing it improved drainage, but the team recorded the labour involved. A system that works only when someone cleans it every few days may be less attractive to a local authority than its initial construction cost suggests. The study also considered biodiversity. Volunteers counted the different kinds of insects visiting the plants, using the same observation period at both sites. These counts were kept separate from the drainage results. More insect visitors did not prove that less water reached the sewer, just as rapid drainage did not prove that the site supported a wide range of wildlife. Each outcome required its own evidence. Residents could contribute observations, but photographs alone were not sufficient for measuring water depth. The volunteers received a short training session and used a marked measuring stick at a fixed location. Their reports were then compared with the instrument records. This arrangement made participation useful without pretending that every contribution had the same precision, and it helped the students identify unusual events worth investigating. Finally, the team considered whether the design could be used elsewhere. They calculated costs over several years, including replacement plants, cleaning and routine maintenance. The recommendation was conditional: similar gardens might be appropriate where soil, rainfall and available staff were comparable. The project therefore offered a method for making a decision, rather than a claim that one small installation had solved flooding across an entire city.

| 题号 | 接受答案 | 证据 |
| --- | --- | --- |
| 1 | infiltration | Today we will examine how researchers evaluate rain gardens in urban neighbourhoods. These are shallow planted areas that receive runoff from nearby hard surfaces. Their main purpose is not simply to store water in a visible pond. Instead, they encourage infiltration, which means movement of water into the ground. This distinction matters because a garden that looks dry may already have processed a substantial amount of rainfall.  |
| 2 | clay | Before construction, our fictional research team compared several sites. A sandy soil allowed water to pass through rapidly, whereas a layer of clay slowed it down. The team selected a site with that slower layer so they could investigate a practical difficulty rather than demonstrate an ideal case. They also recorded the depth of the soil, since performance depends on more than the material found at the surface.  |
| 3 | forty-eight hours / 48 hours | The design requirement was that standing water should disappear within forty-eight hours after an ordinary storm. This limit was chosen to protect the plants and keep the space usable. It was not a promise that the garden could absorb any storm, however intense. During exceptional rainfall, an overflow channel would carry excess water safely towards the existing drainage system instead of allowing it to enter neighbouring buildings.  |
| 4 | roof | To estimate the amount of water entering the garden, the students first measured the area of the roof connected to its inlet pipe. They deliberately excluded a nearby car park because its runoff went to a separate drain. A rain gauge provided the depth of each storm. Combining that measurement with the connected area gave an approximate incoming volume, although small losses still had to be acknowledged.  |
| 5 | traffic | A second garden was needed for comparison. The students matched its size and planting pattern as closely as possible to the first. They also checked local traffic, since pollution washed from busy roads could influence water quality independently of the planting. Without this precaution, a difference in the samples might have been attributed to the gardens when it actually reflected the surrounding neighbourhoods.  |
| 6 | sensors | Continuous measurements were collected by sensors positioned at the inlet and near the bottom of the planted basin. The instruments were checked against manual readings every week, because a smooth electronic record is not necessarily an accurate one. When a battery failed, the gap was marked as missing data. The researchers did not quietly substitute an average and present it as something they had directly observed.  |
| 7 | sediment | One unexpected difficulty emerged after several months. A deposit of sediment had formed close to the inlet, reducing the rate at which water could enter the planting bed. Removing it improved drainage, but the team recorded the labour involved. A system that works only when someone cleans it every few days may be less attractive to a local authority than its initial construction cost suggests.  |
| 8 | biodiversity | The study also considered biodiversity. Volunteers counted the different kinds of insects visiting the plants, using the same observation period at both sites. These counts were kept separate from the drainage results. More insect visitors did not prove that less water reached the sewer, just as rapid drainage did not prove that the site supported a wide range of wildlife. Each outcome required its own evidence.  |
| 9 | volunteers | Residents could contribute observations, but photographs alone were not sufficient for measuring water depth. The volunteers received a short training session and used a marked measuring stick at a fixed location. Their reports were then compared with the instrument records. This arrangement made participation useful without pretending that every contribution had the same precision, and it helped the students identify unusual events worth investigating.  |
| 10 | maintenance | Finally, the team considered whether the design could be used elsewhere. They calculated costs over several years, including replacement plants, cleaning and routine maintenance. The recommendation was conditional: similar gardens might be appropriate where soil, rainfall and available staff were comparable. The project therefore offered a method for making a decision, rather than a claim that one small installation had solved flooding across an entire city.  |

</details>

## 学术阅读 Passage 2：如何衡量城市树荫的价值

样本`reading-sample-01` · 版本2 · 建议20分钟 · 独立审校待完成。

- 独立阅读并完成13题，建议限时20分钟；段落标签为A至G。
- 判断题按TRUE/FALSE/NOT GIVEN作答；标题匹配从共用选项选罗马数字；填空按题目词数限制。
- NOT GIVEN表示原文没有提供所问信息，不能凭常识补全。本文城市与研究为自编虚构教学场景。

**A** City authorities increasingly plant trees to reduce uncomfortable summer heat. Yet a photograph of a leafy street cannot reveal how much protection its residents receive. Surface temperature, air temperature and the heat experienced by a person are related but different measurements. A pavement can become much cooler in shade while the surrounding air changes relatively little. Evaluating a planting programme therefore requires a clear question: is the aim to protect pedestrians during a short journey, reduce heat inside buildings, or change conditions across a neighbourhood? The answer determines which observations will be useful, and which attractive numbers may be misleading.

**B** Consider a fictional study in the city of Bellhaven. Researchers placed instruments on two streets with similar building heights and road widths. One had mature trees; the other had few. Measurements were taken at the same height and at matching times, rather than whenever a member of the team happened to visit. This design reduced some obvious sources of variation, but it did not turn the streets into identical environments. Traffic, the materials used on walls and the direction of the afternoon sun could still influence the readings. The team therefore described the comparison as evidence of an association, not a controlled experiment proving a single cause.

**C** The strongest immediate benefit came from blocking direct sunlight. Tree canopies intercepted radiation before it reached people and paving. A second process involved water: leaves released moisture, and evaporation used energy that would otherwise have contributed to heating. However, the importance of this process depended on access to water. A thirsty tree could close the tiny openings in its leaves, reducing moisture loss and limiting this cooling effect. Species selection consequently involved a compromise between survival during dry periods and the amount of water available for cooling. Simply counting trees said little about how these mechanisms operated.

**D** Where trees were located also mattered. A broad canopy above a quiet parking area might lower a satellite image's average surface temperature while offering little help to people waiting for a bus. The Bellhaven researchers mapped walking routes, crossings and places where passengers stood without cover. They then considered the time of day when each place was used. This approach shifted attention from the total area of green cover to the relationship between shade and human activity. It also exposed a practical constraint: underground pipes sometimes prevented planting at exactly the locations where new shade would be most valuable.

**E** Benefits were not distributed evenly. Residents in rented flats often had less control over nearby planting than owners of large gardens. Older people and outdoor workers could face greater exposure even when the average temperature of their district appeared moderate. The research team therefore invited community groups to identify overlooked locations. Their accounts did not replace temperature measurements; they helped explain which measurements should be collected. A shaded route to a clinic, for example, could be important despite serving fewer people than a central shopping street. Deciding between such projects required an explicit judgement about public priorities.

**F** Long-term planning introduced further uncertainty. Young trees provided limited shade, and some failed before reaching maturity. Maintenance, including watering and protecting roots during road repairs, affected the eventual outcome. In the fictional study, the council compared immediate expenditure with the expected cost of care over twenty years. It did not assume that every planted tree would survive for that entire period. The researchers also warned against using one unusually cool summer as proof of permanent success. Monitoring needed to cover different weather conditions, while the original measurement method had to remain consistent enough for comparisons to retain meaning.

**G** The study's conclusion was deliberately cautious. Trees could be a valuable component of heat adaptation, but they could not replace every other measure. Shelters might provide shade before a canopy developed, and improvements to buildings could reduce exposure indoors. A useful assessment would combine evidence about physical conditions, the needs of vulnerable residents and the resources available for continued care. Rather than asking whether trees were universally effective, decision makers were encouraged to ask where particular designs would work, who would benefit and what would be required to sustain those benefits. That narrower question produced a more practical and transparent basis for local action.

| 题号 | 题型 | 问题 |
| --- | --- | --- |
| 1 | true-false-not-given | A cooler pavement necessarily means that the surrounding air becomes much cooler. |
| 2 | true-false-not-given | The Bellhaven team took measurements at matching times. |
| 3 | true-false-not-given | The Bellhaven study employed exactly twelve researchers. |
| 4 | true-false-not-given | Community accounts were intended to replace instrument measurements. |
| 5 | matching-headings | Choose the best heading for paragraph A. |
| 6 | matching-headings | Choose the best heading for paragraph C. |
| 7 | matching-headings | Choose the best heading for paragraph F. |
| 8 | sentence-completion | The comparison showed an _____ rather than proving a single cause. |
| 9 | sentence-completion | The release of moisture cools the surroundings through _____. |
| 10 | sentence-completion | _____ sometimes made it impossible to plant in the most useful places. |
| 11 | sentence-completion | People living in _____ may have less influence over nearby planting. |
| 12 | sentence-completion | The council estimated the cost of care over _____. |
| 13 | sentence-completion | Before tree canopies develop, _____ could provide shade. |

标题候选：
- i. Choosing measurements that answer the right question
- ii. The mechanisms of cooling and their limits
- iii. Equal benefits for every resident
- iv. Care and uncertainty over a longer period
- v. The end of all other heat-protection measures

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

| 题号 | 接受答案 | 证据 |
| --- | --- | --- |
| 1 | FALSE | A pavement can become much cooler in shade while the surrounding air changes relatively little.  |
| 2 | TRUE | Measurements were taken at the same height and at matching times, rather than whenever a member of the team happened to visit.  |
| 3 | NOT GIVEN | Researchers placed instruments on two streets with similar building heights and road widths. 说明：此段说明仪器与两条街道，但全文未给研究团队人数；two streets不能推出研究人员数量。 |
| 4 | FALSE | Their accounts did not replace temperature measurements; they helped explain which measurements should be collected.  |
| 5 | i | City authorities increasingly plant trees to reduce uncomfortable summer heat. Yet a photograph of a leafy street cannot reveal how much protection its residents receive. Surface temperature, air temperature and the heat experienced by a person are related but different measurements. A pavement can become much cooler in shade while the surrounding air changes relatively little. Evaluating a planting programme therefore requires a clear question: is the aim to protect pedestrians during a short journey, reduce heat inside buildings, or change conditions across a neighbourhood? The answer determines which observations will be useful, and which attractive numbers may be misleading.  |
| 6 | ii | The strongest immediate benefit came from blocking direct sunlight. Tree canopies intercepted radiation before it reached people and paving. A second process involved water: leaves released moisture, and evaporation used energy that would otherwise have contributed to heating. However, the importance of this process depended on access to water. A thirsty tree could close the tiny openings in its leaves, reducing moisture loss and limiting this cooling effect. Species selection consequently involved a compromise between survival during dry periods and the amount of water available for cooling. Simply counting trees said little about how these mechanisms operated.  |
| 7 | iv | Long-term planning introduced further uncertainty. Young trees provided limited shade, and some failed before reaching maturity. Maintenance, including watering and protecting roots during road repairs, affected the eventual outcome. In the fictional study, the council compared immediate expenditure with the expected cost of care over twenty years. It did not assume that every planted tree would survive for that entire period. The researchers also warned against using one unusually cool summer as proof of permanent success. Monitoring needed to cover different weather conditions, while the original measurement method had to remain consistent enough for comparisons to retain meaning.  |
| 8 | association | The team therefore described the comparison as evidence of an association, not a controlled experiment proving a single cause.  |
| 9 | evaporation | A second process involved water: leaves released moisture, and evaporation used energy that would otherwise have contributed to heating.  |
| 10 | underground pipes | It also exposed a practical constraint: underground pipes sometimes prevented planting at exactly the locations where new shade would be most valuable.  |
| 11 | rented flats | Residents in rented flats often had less control over nearby planting than owners of large gardens.  |
| 12 | twenty years / 20 years | In the fictional study, the council compared immediate expenditure with the expected cost of care over twenty years.  |
| 13 | shelters | Shelters might provide shade before a canopy developed, and improvements to buildings could reduce exposure indoors.  |

</details>

## Academic Task 2：城市交通投资

样本`writing-sample-01` · 版本2 · 建议40分钟 · 独立审校待完成。

- 先独立完成并保存首答，再查看答案、证据或示例。
- 记录限时、重播和查词等条件；自编练习结果不换算雅思分数。

Some people believe that cities should spend more money on public transport than on new roads. To what extent do you agree or disagree? Give reasons for your answer and include relevant examples from your own knowledge or experience. Write at least 250 words.

至少250词，限时40分钟。JSON的maxWords只是练习建议上限，不能将超出字数的真实原稿删除或自动判错。

自查：
- 立场是否明确，主体段是否解释理由和具体例子？
- 是否回应public transport与new roads的资金比较？
- 是否在讨论限制条件后仍保持结论一致？
- 按任务回应、连贯衔接、词汇、语法四维自查；保存首稿与修改稿。

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

I largely agree that cities should give public transport a higher funding priority than new roads. Reliable buses and trains can move many people through a limited space, while additional road capacity may provide only temporary relief. Nevertheless, some road investment remains necessary for safety and access.

The strongest reason to favour public transport is that urban space cannot expand as quickly as demand for travel. A frequent bus service can carry passengers who would otherwise use separate cars. If it connects residential areas with workplaces and operates beyond office hours, it becomes a practical choice for a wider group of residents. For example, a worker finishing late may leave the car at home when the last bus is predictable. Investment should therefore improve frequency and reliability, rather than merely produce an impressive new station.

There is also an issue of access. People who cannot drive still need to reach schools, hospitals and jobs. Spending most of a transport budget on roads may improve journeys for motorists while doing little for these residents. Affordable fares and accessible vehicles can make public expenditure useful to more of the population. This does not mean that every route must attract identical passenger numbers; some provide an essential connection for smaller communities.

However, prioritising public transport should not imply neglecting roads altogether. Dangerous junctions need repair, and emergency services require dependable access. In rapidly growing districts, a carefully planned road connection may also be necessary. Such projects should be assessed against clear needs instead of an assumption that more traffic always requires more lanes.

Overall, cities should direct the larger share of new transport funding towards dependable public services, while maintaining roads and addressing specific safety problems. This balance recognises both the limitations of urban space and the different needs of residents.

以上是自编练后示例，没有真人考官分数。用于比较组织与表达方式，不应逐字背诵。

</details>

## Speaking Part 1：学习与日常安排

样本`speaking-sample-01` · 版本2 · 建议6分钟 · 独立审校待完成。

- 先独立完成并保存首答，再查看答案、证据或示例。
- 记录限时、重播和查词等条件；自编练习结果不换算雅思分数。

1. Do you work or study?
2. What do you enjoy about your daily routine?
3. When do you prefer to learn something new?
4. Has your routine changed recently?

准备0秒；本Part建议回答时间240秒。Part 2的120秒是上限，不要求以重复或背稿凑时长。

- 先录首答，再看示例；回听原录音并保留修订前后两份。
- 检查流利与连贯、词汇、语法、发音；ASR转写与时长不能替代真人评分。

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

I work in an operations team, so the timing of my day can change. What I enjoy most is a short walk before work because it gives me time to think. I prefer learning something new in the evening, after I have dealt with urgent tasks. For instance, I recently started reading an English article after dinner. My routine has changed a little: I used to look at my phone first, but now I try to begin with ten minutes of reading. These are separate example answers; in practice, answer each question naturally rather than reciting this paragraph.

以上是自编练后示例，没有真人考官分数。用于比较组织与表达方式，不应逐字背诵。

</details>

## Academic Task 1：出行方式数据表

样本`writing-task1-sample-01` · 版本1 · 建议20分钟 · 独立审校待完成。

- 先独立完成并保存首答，再查看答案、证据或示例。
- 记录限时、重播和查词等条件；自编练习结果不换算雅思分数。

The table shows the percentage of commuters using three main forms of transport in the fictional city of Bellhaven in 2005, 2015 and 2025. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.

| Year | Car (%) | Bus (%) | Bicycle (%) |
| --- | --- | --- | --- |
| 2005 | 50 | 40 | 10 |
| 2015 | 40 | 45 | 15 |
| 2025 | 25 | 55 | 20 |

至少150词，限时20分钟。JSON的maxWords只是练习建议上限，不能将超出字数的真实原稿删除或自动判错。

自查：
- 是否给出清楚总览，而不是逐格罗列？
- 数字和年份是否准确，percentage points是否与percentage区分？
- 是否比较三种方式，避免编造表外原因？
- 按任务完成、连贯衔接、词汇、语法四维自查。

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

The table compares the proportions of commuters travelling by car, bus and bicycle in Bellhaven in three selected years between 2005 and 2025.

Overall, bus travel became increasingly common and replaced cars as the largest category. Cycling also gained a greater share, although it remained the least frequently used of the three forms of transport throughout the period.

In 2005, half of commuters used a car, while buses accounted for 40 percent. The remaining 10 percent travelled by bicycle. Ten years later, the car figure had fallen to 40 percent. By contrast, the proportion taking a bus rose to 45 percent, putting it five percentage points above the car category. The bicycle share also increased, reaching 15 percent in 2015.

The changes continued in the final year shown. Bus use reached 55 percent in 2025, compared with 25 percent for cars and 20 percent for bicycles. Over the whole period, the car share declined by 25 percentage points, whereas the bus and bicycle figures increased by 15 and 10 points respectively. The table provides no information about the reasons behind these changes.

以上是自编练后示例，没有真人考官分数。用于比较组织与表达方式，不应逐字背诵。

</details>

## Speaking Part 2：学会的一项实用技能

样本`speaking-part2-sample-01` · 版本1 · 建议5分钟 · 独立审校待完成。

- 先独立完成并保存首答，再查看答案、证据或示例。
- 记录限时、重播和查词等条件；自编练习结果不换算雅思分数。

1. Describe a useful skill you learned. You should say: what it was; when and how you learned it; who helped you; and explain why it has been useful.

准备60秒；本Part建议回答时间120秒。Part 2的120秒是上限，不要求以重复或背稿凑时长。

- 先录首答，再看示例；回听原录音并保留修订前后两份。
- 检查流利与连贯、词汇、语法、发音；ASR转写与时长不能替代真人评分。

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

A useful skill I learned was organising information in a spreadsheet. I started learning it about two years ago, when my team needed to compare several weeks of work records. At first I copied numbers manually and made quite a few mistakes, so I realised that I needed a more consistent method.

A colleague showed me how to put each type of information in its own column and use simple formulas. What helped most was practising with a small set of real records rather than watching a long tutorial from beginning to end. When something went wrong, I could see exactly which result looked unreasonable and ask a specific question.

The skill has been useful because I can now check a pattern before discussing it with other people. For example, if a task seems to take longer on certain days, I can compare the records instead of relying entirely on memory. I still check the original information, because a spreadsheet cannot make inaccurate data reliable.

I would not describe myself as an expert. There are many advanced features I have never used. However, being able to organise a simple table has saved time and made my explanations clearer. It also taught me that learning a small, practical skill well can be more valuable than collecting a large number of techniques I never apply.

以上是自编练后示例，没有真人考官分数。用于比较组织与表达方式，不应逐字背诵。

</details>

## Speaking Part 3：成年人如何学习

样本`speaking-part3-sample-01` · 版本1 · 建议6分钟 · 独立审校待完成。

- 先独立完成并保存首答，再查看答案、证据或示例。
- 记录限时、重播和查词等条件；自编练习结果不换算雅思分数。

1. Why do some adults find it difficult to learn new skills?
2. Should employers pay for staff training?
3. How can technology help people learn, and what are its limitations?
4. Is practical experience more valuable than formal education?

准备0秒；本Part建议回答时间300秒。Part 2的120秒是上限，不要求以重复或背稿凑时长。

- 先录首答，再看示例；回听原录音并保留修订前后两份。
- 检查流利与连贯、词汇、语法、发音；ASR转写与时长不能替代真人评分。

<details>
<summary>完成首答后再展开答案、证据或文字示例</summary>

One difficulty for adults is that learning competes with work and family responsibilities. A short course may be easier to maintain than a demanding programme, but it still needs a clear purpose. People are more likely to continue when they can use the new skill soon afterwards.

I think employers should fund training when it is directly connected with a person's role. Both sides can benefit: the employee develops useful knowledge, and the organisation gains a more capable team. However, the training should include time to practise. Paying for a course without allowing anyone to apply it is unlikely to achieve much.

Technology can make explanations available at a convenient time and provide opportunities for repeated practice. It is particularly helpful when learners need to review a difficult step. Its limitation is that an automatic system may not understand why an answer was produced. Feedback from a knowledgeable person can reveal a mistaken assumption that a simple score misses.

Practical experience and formal education serve different purposes. Experience shows how ideas behave under real constraints, while education can provide concepts for understanding unfamiliar situations. Someone who has only experience may repeat a method without knowing its limits; someone with only theory may underestimate practical difficulties. I would therefore prefer a system that connects both, with learners explaining their decisions and then testing them in realistic tasks. These are separate discussion examples, not a script to memorise.

以上是自编练后示例，没有真人考官分数。用于比较组织与表达方式，不应逐字背诵。

</details>

## 复现与校验边界

音频构建使用已有本地Kokoro ONNX环境和已校验的模型资产，不属于App运行依赖。生成器读取原始10段文本，先在仓库外临时目录生成单声道24000Hz PCM16源音频，再编码为48 kbps CBR MP3，同时写入样本时长、逐题对应段落时码与来源清单；不改写原文或题目答案。复现命令：

```sh
python scripts/curriculum/generate-r0-audio.py --model /path/to/kokoro-v1.0.int8.onnx --voices /path/to/voices-v1.0.bin
```

模型与音色来源、依赖版本、生成日期、原文和音频摘要、帧时码都在来源清单中。自动校验可验证结构、词数、题号、证据引用、MP3帧、信号数据与摘要、库存缺口；它不能替代人工审听、教研审核或真实考生的难度校准。

编码命令：`ffmpeg -i source.wav -ac 1 -ar 24000 -c:a libmp3lame -b:a 48k -write_xing 1 output.mp3`。public只保存压缩结果；源时长270.857875秒与全部证据时码保持不变，MP3帧时长约270.912秒、1,625,709字节。
