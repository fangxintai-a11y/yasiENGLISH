#!/usr/bin/env bash
# 雅思星图 本机数据一键抓取（macOS / Linux；依赖 curl git unzip python3；可选 pdftotext 用于 parse_taro）
# 用法: bash fetch-ielts-data.sh [--core|--full] [--dry-run] [--only NAME[,NAME..]] [DEST]
#   默认 --full，DEST 默认 ./local-content/ielts-data
set -u
MODE=full; DRY=0; ONLY=""; DEST=""
while [ $# -gt 0 ]; do case "$1" in
  --core) MODE=core;; --full) MODE=full;; --dry-run) DRY=1;;
  --only) ONLY=",$2,"; shift;; -h|--help) sed -n 2,5p "$0"; exit 0;;
  *) DEST="$1";; esac; shift; done
DEST="${DEST:-./local-content/ielts-data}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDIR="$SCRIPT_DIR/ielts-data-scripts"; [ -d "$SDIR" ] || SDIR="$SCRIPT_DIR"
MANIFEST="$SDIR/MANIFEST.json"
mkdir -p "$DEST"; DEST="$(cd "$DEST" && pwd)"; FAIL="$DEST/fetch-failed.log"
UA="Mozilla/5.0 (Macintosh) ielts-fetch"
for c in curl git unzip python3; do command -v $c >/dev/null || { echo "缺少依赖: $c"; exit 1; }; done
log(){ echo "[$(date +%H:%M:%S)] $*"; }
fail(){ echo "$(date '+%F %T')	$*" >> "$FAIL"; log "FAIL: $*"; }
want(){ [ -z "$ONLY" ] || case "$ONLY" in *",$1,"*) return 0;; *) return 1;; esac; }
sha_of(){ python3 -c 'import hashlib,sys;h=hashlib.sha256();f=open(sys.argv[1],"rb")
for b in iter(lambda:f.read(1<<20),b""):h.update(b)
print(h.hexdigest())' "$1"; }
manifest_sha(){ [ -f "$MANIFEST" ] && python3 -c 'import json,sys
for f in json.load(open(sys.argv[1]))["files"]:
  if f["path"]==sys.argv[2] and f.get("sha256"):print(f["sha256"])' "$MANIFEST" "$1"; }
manifest_commit(){ [ -f "$MANIFEST" ] && python3 -c 'import json,sys
for r in json.load(open(sys.argv[1]))["repos"]:
  if r["path"]==sys.argv[2]:print(r["commit"])' "$MANIFEST" "$1"; }

# get REL_PATH URL  —— 断点续传 + sha256 校验（MANIFEST 有记录时）
get(){ rel="$1"; url="$2"; out="$DEST/$rel"; exp="$(manifest_sha "$rel")"
  if [ $DRY = 1 ]; then echo "FILE $rel <- $url ${exp:+(sha256 ${exp:0:12}…)}"; return; fi
  mkdir -p "$(dirname "$out")"
  if [ -s "$out" ]; then
    if [ -z "$exp" ] || [ "$(sha_of "$out")" = "$exp" ]; then return 0; fi
    log "sha 不一致，重下 $rel"; rm -f "$out"; fi
  if ! curl -fL --retry 3 --retry-delay 3 --connect-timeout 30 --max-time 1800 -A "$UA" -C - -o "$out.part" "$url"; then
    fail "$rel	$url"; return 1; fi
  mv "$out.part" "$out"
  if [ -n "$exp" ] && [ "$(sha_of "$out")" != "$exp" ]; then fail "$rel	sha256 mismatch (源文件可能已更新，文件保留)"; fi
}

# repo REL_PATH URL [sparse patterns...] —— 浅克隆并固定到 MANIFEST commit
repo(){ rel="$1"; url="$2"; shift 2; dir="$DEST/$rel"; sha="$(manifest_commit "$rel")"
  if [ $DRY = 1 ]; then echo "REPO $rel <- $url @${sha:-HEAD} ${*:+sparse: $*}"; return; fi
  if [ -d "$dir/.git" ] && [ -n "$sha" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ] \
     && [ -z "$(git -C "$dir" status --porcelain 2>/dev/null | grep -v '^??' | head -1)" ]; then log "skip $rel (已在 $sha)"; return 0; fi
  mkdir -p "$dir"; ( cd "$dir" || exit 1
    [ -d .git ] || { git init -q && git remote add origin "$url"; }
    if [ $# -gt 0 ]; then git sparse-checkout init --no-cone >/dev/null 2>&1; printf '%s\n' "$@" > .git/info/sparse-checkout; fi
    ok=1
    if [ -n "$sha" ]; then git fetch -q --depth 1 --filter=blob:none origin "$sha" && git checkout -q -f FETCH_HEAD || ok=0; else ok=0; fi
    if [ $ok = 0 ]; then
      [ -n "$sha" ] && echo "$(date '+%F %T')	$rel	固定 commit $sha 失败，改用默认分支 HEAD" >> "$FAIL"
      git fetch -q --depth 1 --filter=blob:none origin HEAD && git checkout -q -f FETCH_HEAD || exit 1
    fi ) || fail "$rel	$url	git 失败"
}

log "模式=$MODE dry-run=$DRY 目标=$DEST"

# ---------- 阅读 ----------
want hwt && repo reading/hwt https://github.com/hwttop5/ielts-reading-past-papers.git '/src/generated/'
want yanbo && repo reading/yanbo-cam4-18 https://github.com/yanboishere/ielts-mock.git
want lincoh && repo reading/lincoh-cam1-20 https://github.com/lincohlesteban-art/ielts-academic-platform.git
want sallowayma && repo reading/sallowayma https://github.com/sallowayma-git/IELTS-practice.git
[ $MODE = full ] && want zyz && repo reading/zyz https://github.com/ivy11220911-droid/ZYZ-IELTS-Reading.git

# ---------- 听力 ----------
if want maslow; then
  if [ $MODE = core ]; then
    pats='/ielts_index/'; for b in 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20; do
      pats="$pats /ielts_listening/book_$b/test_*_part_*.mp3 /ielts_listening/book_$b/audioscripts.md"; done
    # shellcheck disable=SC2086
    repo listening/maslow-cam1-20 https://github.com/maslow/EnglishLearning.git $pats
  else repo listening/maslow-cam1-20 https://github.com/maslow/EnglishLearning.git; fi
fi
if want taro; then
  if [ $MODE = core ]; then repo listening/taroflink-cam16-20 https://github.com/TaroFlink/ielts-listening-practice.git '/IELTS 1*/Test */*.pdf' '/IELTS 20/Test */*.pdf' '/data/' '/analysis/'
  else repo listening/taroflink-cam16-20 https://github.com/TaroFlink/ielts-listening-practice.git; fi
fi
[ $MODE = full ] && want xiahua && repo listening/xiahua https://github.com/ivy11220911-droid/XiaHua-IELTS-Listening.git

# ---------- 官方样题 / 评分标准 ----------
if want official; then
  get official/cambridge-sample-papers.zip https://www.cambridgeenglish.org/Images/23435-ielts-sample-papers.zip \
    && [ $DRY = 0 ] && unzip -oq "$DEST/official/cambridge-sample-papers.zip" -d "$DEST/official/cambridge-sample"
  PAGE=https://ielts.org/take-a-test/preparation-resources/sample-test-questions/academic-test
  if [ $DRY = 1 ]; then echo "PAGE $PAGE -> 抓取页面中全部 .pdf 链接到 official/ieltsorg/（约 28 个）"
  else mkdir -p "$DEST/official/ieltsorg"
    curl -fsL -A "$UA" "$PAGE" | grep -oE 'https?://[^"]*\.pdf' | sort -u > "$DEST/official/ieltsorg/urls.txt" || fail "ielts.org 页面"
    [ -s "$DEST/official/ieltsorg/urls.txt" ] || fail "ielts.org 页面未解析出 PDF 链接（页面改版？）"
    while read -r u; do get "official/ieltsorg/${u##*/}" "$u"; done < "$DEST/official/ieltsorg/urls.txt"; fi
  get official/band-descriptors/ielts-writing-band-descriptors.pdf https://ielts.org/cdn/ielts-guides/ielts-writing-band-descriptors.pdf
  get official/band-descriptors/ielts-speaking-band-descriptors.pdf https://ielts.org/cdn/ielts-guides/ielts-speaking-band-descriptors.pdf
fi
[ $MODE = full ] && want zeeklog && repo official/zeeklog https://github.com/zeeklog/IELTS.git '/*.pdf' '/雅思作文资料/'

# ---------- 写作 ----------
if want writing; then
  for f in ndtran0101/writing9-ielts-essays:data/train.jsonl ndtran0101/writing9-ielts-essays:data/test.jsonl \
           chillies/IELTS-writing-task-2-evaluation:train.csv chillies/IELTS-writing-task-2-evaluation:test.csv \
           hai2131/IELTS-essays-task-1:data/train-00000-of-00001.parquet; do
    d="${f%%:*}"; p="${f#*:}"; get "writing/hf/$(echo "$d" | tr / _)/${p##*/}" "https://huggingface.co/datasets/$d/resolve/main/$p"; done
  if [ $DRY = 1 ]; then echo "PAGES practicepteonline.com/ielts-writing-test-{1..128}/ -> writing/practicepte/w{N}.html + Task1 题图"
  else for n in $(seq 1 128); do get "writing/practicepte/w$n.html" "https://practicepteonline.com/ielts-writing-test-$n/" >/dev/null 2>&1 || true; done
    mkdir -p "$DEST/writing/practicepte/img"; ( cd "$DEST/writing/practicepte" || exit
      for f in w*.html; do grep -oE 'src="/wp-content/uploads/[^"]+\.(png|jpe?g|webp|gif)"' "$f" | sed 's/src="//;s/"$//' | sort -u | sed "s#^#${f%.html} https://practicepteonline.com#"; done > img/list.txt
      awk '{print $2}' img/list.txt | sort -u | while read -r u; do [ -s "img/${u##*/}" ] || curl -fsSL -m 60 -A "$UA" -o "img/${u##*/}" "$u" || echo "$(date '+%F %T')	img	$u" >> "$FAIL"; done ); fi
fi

# ---------- 口语 ----------
if want speaking; then
  for r in WendyCoding31/ielts-speaking-studio SEU-Prime/ielts-speaking TuuuuTuu/ielts-speaking-study \
           xiaojianzhao731-web/ielts-speaking tutuhua/IELTS-Speaking-Lab murph232439/ielts-speaking-practice; do
    repo "speaking/$(echo "$r" | tr / _)" "https://github.com/$r.git"; done
fi

# ---------- structured（本地解析） ----------
if want structured; then
  if [ $DRY = 1 ]; then echo "PARSE parse_lincoh.py + parse_taro.py -> structured/cam-lincoh, structured/cam-taro (+ 题图)"
  else mkdir -p "$DEST/structured"; cp "$SDIR/parse_lincoh.py" "$SDIR/parse_taro.py" "$DEST/structured/" 2>/dev/null || fail "找不到 parse 脚本于 $SDIR"
    ( cd "$DEST" || exit 1
      [ -d reading/lincoh-cam1-20/content ] && python3 structured/parse_lincoh.py >/dev/null || echo "$(date '+%F %T')	parse_lincoh 失败" >> "$FAIL"
      [ -f structured/cam-lincoh/C3-T1-L.json ] && mv structured/cam-lincoh/C3-T1-L.json structured/cam-lincoh/C3-T1-L.MISMAPPED.json
      if command -v pdftotext >/dev/null; then python3 structured/parse_taro.py >/dev/null || echo "$(date '+%F %T')	parse_taro 失败" >> "$FAIL"
      else echo "$(date '+%F %T')	parse_taro 跳过：缺 pdftotext（brew install poppler）" >> "$FAIL"; fi
      mkdir -p structured/cam-lincoh/img
      python3 -c 'import json,glob
for f in glob.glob("structured/cam-lincoh/C*.json"):
  for u in json.load(open(f))["images"]:print(u if u.startswith("http") else "https://practicepteonline.com"+u)' | sort -u | while read -r u; do
        [ -s "structured/cam-lincoh/img/${u##*/}" ] || curl -fsSL -m 60 -A "$UA" -o "structured/cam-lincoh/img/${u##*/}" "$u" || true; done ); fi
fi
log "完成。失败条目见 ${FAIL}（不存在=无失败）"
