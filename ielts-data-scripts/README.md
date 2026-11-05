# ielts-data-scripts

| 文件 | 作用 |
|---|---|
| ../fetch-ielts-data.sh | 一键抓取脚本唯一保留在仓库根目录，从 `./ielts-data-scripts/` 读取 MANIFEST.json 与解析脚本 |
| MANIFEST.json | 盒子上的基准：各 repo 固定 commit、单文件 sha256/bytes |
| parse_lincoh.py | lincoh `data.js` + `content/*.html` → `structured/cam-lincoh/C{book}-T{n}-{L|R}.json`（剑桥 1/2/3/19/20），含 `<ol><li>` 答案回退；题图 URL 写入 json 的 `images` |
| parse_taro.py | taroflink 剑 16–20 PDF → `structured/cam-taro/*.json`（20 套听力×40 答案）|

## 用法

从仓库根目录执行以下命令（脚本仅供资料接手任务，应用不会自动运行）：
```bash
bash fetch-ielts-data.sh --core --dry-run            # 先看计划
bash fetch-ielts-data.sh --core ./local-content/ielts-data
bash fetch-ielts-data.sh --full ./local-content/ielts-data   # 可重复执行，已完成项自动跳过
bash fetch-ielts-data.sh --only official,structured DEST    # 名称: hwt yanbo lincoh sallowayma zyz maslow taro xiahua official zeeklog writing speaking structured
# 单独重跑解析（必须在 ielts-data 根目录下执行）
cd local-content/ielts-data && python3 structured/parse_lincoh.py && python3 structured/parse_taro.py
```
## 依赖
curl, git(≥2.27, 支持 sparse-checkout/--filter), unzip, python3(仅标准库)；parse_taro 需 `pdftotext`（macOS: `brew install poppler`）。可选核验：ffprobe（`brew install ffmpeg`）。macOS 无 sha256sum，脚本用 python hashlib；手工可用 `shasum -a 256`。
