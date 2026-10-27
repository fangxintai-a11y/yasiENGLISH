# 第三方原始数据

`scripts/ielts/build_ielts.py` 读取这里的文件，生成 `public/ielts/`。本项目仅作个人学习测试；如权利人认为不妥，请提 Issue，相应文件和由它生成的数据会被移除。

| 文件 | 内容 | 来源 | 许可 / 版权 | 用途 |
|---|---|---|---|---|
| `wanglu-listening.csv` | 雅思王听力语料库（王陆）各章节词表 | [daddywolf/IELTS-Listening-Vocabulary-and-Collocation](https://github.com/daddywolf/IELTS-Listening-Vocabulary-and-Collocation)（commit `a66bbf1`） | 版权归原作者 / 出版方；仓库作者注明「搬运」 | 标注听力高频词（解锁听写卡），以及短语听写练习 |
| `awl-sublists.txt` | Academic Word List 十个子表（570 个词族） | Coxhead, A. (2000). *A New Academic Word List*. TESOL Quarterly；文本取自 [FirmS26/WordBridge](https://github.com/FirmS26/WordBridge) | 学术研究成果，版权归原作者 | 标注写作产出词（解锁产出卡），以及选择 AI 造句的词 |
| `gptwords.jsonl` | 8,714 个词的词义分析、词根词缀、记忆辅助、小故事 | [Ceelog/DictionaryByGPT4](https://github.com/Ceelog/DictionaryByGPT4)（commit `8c9b050`） | CC BY-SA 4.0，见 `gptwords.LICENSE` | 生成 `public/ielts/mnemo/*.json`（记忆钩子），同样按 CC BY-SA 4.0 提供 |

同义替换网络来自词光词条自带的 `syn` 字段（CC BY 4.0），只保留同在图鉴中的词。
