#!/bin/bash
# check-deploy.sh — 部署完整性检查
set -e

# 2026-09-11（prime-agent）：目录拆成 A.core/C.deploy 之后，默认值还在按旧布局算 C.deploy/../..（= TEYVAT/，
# 不是仓库根）→ 不带参数手跑会假报 "rna.json not found"（Makefile 里是带 $(DEV) 参数调用的，所以构建不受影响）。
# 现在：默认取 C.deploy 的同级 A.core；仓库根固定按脚本自身位置算（B.docs 在那里）。
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
DEV_ROOT="${1:-${PI_DEV_ROOT:-$REPO_ROOT/A.core}}"
# 兼容传入 DEV 根目录或 Codebase 目录
if [ -f "$DEV_ROOT/package.json" ]; then
  IMPL="$DEV_ROOT"
elif [ -d "$DEV_ROOT/core" ]; then
  IMPL="$DEV_ROOT/core"
else
  IMPL="$DEV_ROOT"
fi
PAIMON_EXT="$HOME/.local/lib/teyvat/extensions"
RUNTIME_DIST="$HOME/.local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist"

R='\033[0m'
RED='\033[31m'
YLW='\033[33m'
GRN='\033[32m'

ERRORS=0

ok()   { echo -e "  ${GRN}OK${R}  $1"; }
warn() { echo -e "  ${YLW}WARN${R}  $1"; }
err()  { echo -e "  ${RED}ERROR${R}  $1"; ERRORS=1; }
info() { echo -e "  ${YLW}INFO${R}  $1"; }

# 1-3: 已安装产物检查（首次部署时基目录不存在，跳过）
INSTALL_BASE="$HOME/.local/lib/teyvat"
if [ ! -d "$INSTALL_BASE" ]; then
  info "首次部署：$INSTALL_BASE 不存在，跳过产物检查（install.sh 会创建）"
else
  # 1. runtime 存在
  if [ -f "$RUNTIME_DIST/cli.js" ]; then
    ok "runtime"
  else
    err "runtime not found at $RUNTIME_DIST"
  fi

  # 2. 扩展目录存在
  if [ -e "$PAIMON_EXT/teyvat" ]; then
      ok "extension teyvat"
    elif [ -e "$PAIMON_EXT/genshin-world" ]; then
      ok "extension genshin-world (legacy)"
    else
      warn "extension not found (first deploy?)"
    fi

  # 3. launcher 存在
  if [ -x "$HOME/.local/bin/genshin" ]; then
    ok "launcher"
  else
    err "launcher ~/.local/bin/genshin not found"
  fi
fi

# 4. RNA 已转录
if [ -f "$IMPL/spirit.bio.gene/rna.json" ]; then
  ok "rna.json"
else
  err "rna.json not found — run make dev-minutely (polymerase)"
fi


# 6. 消息渲染器检查：所有 isDisplayedInTUI 消息类型必须有 registerMessageRenderer
MSG_TYPES_FILE="$IMPL/spirit.bio.organs/kernel.ribosome/backbone"
if [ -f "$MSG_TYPES_FILE" ]; then
  MISSING_RENDERERS=""
  while IFS= read -r line; do
    if echo "$line" | grep -q '"[a-z][^"]*":'; then
      TYPE=$(echo "$line" | grep -o '"[^"]*"' | head -1 | tr -d '"')
    fi
    if echo "$line" | grep -q 'isDisplayedInTUI: true' && [ -n "$TYPE" ]; then
      HAS_RENDERER=$(grep -r "registerMessageRenderer.*$TYPE" "$IMPL/" --include="*.ts" -l 2>/dev/null || echo "")
      if [ -z "$HAS_RENDERER" ]; then
        MISSING_RENDERERS="$MISSING_RENDERERS  $TYPE\n"
      fi
    fi
  done < "$MSG_TYPES_FILE"
  if [ -n "$MISSING_RENDERERS" ]; then
    info "message types with isDisplayedInTUI=true but no registerMessageRenderer:"
    echo -e "$MISSING_RENDERERS" | while read -r t; do [ -n "$t" ] && echo -e "       $YLW$t$R"; done
    info "(run: grep -r registerMessageRenderer to add renderers)"
  else
    ok "all displayed message types have renderers"
  fi
fi

# 7. 文档编号检查：序号连续、不重、不漏、INDEX 匹配
# 2026-09-11（prime-agent）：这一段本来是"静默死掉"的——DOC_ROOT 还指 $DEV_ROOT/Docs/Dev（旧布局），
# 目录不存在 → for 循环里的 [ ! -d ] && continue 全部跳过 → 检查看起来全绿，其实一个文件都没查
# （和 Makefile 顶部"目录改名后 glob 零匹配被悄悄跳过"是同一类坑）。现在：
#   - DOC_ROOT 先试旧路径，再试现在的 B.docs/Dev.Common；两处都找不到 → ERROR（不许再静默跳过）
#   - 序号空洞（问题/教训关闭后删文件留下的）算 WARN，不拦构建；PI_DOC_STRICT=1 时才算 ERROR
#   - 撞号检测忽略配套文件（.SPEC / .REMOVED / .NAMETRACE.REMOVED），否则 039-xxx.LESSON 和
#     039-xxx.LESSON.SPEC 会被误判成重号
DOC_ROOT=""
for cand in "$DEV_ROOT/Docs/Dev" "$REPO_ROOT/B.docs/Dev.Common"; do
  [ -d "$cand" ] && { DOC_ROOT="$cand"; break; }
done
DOC_STRICT="${PI_DOC_STRICT:-0}"
docwarn() { if [ "$DOC_STRICT" = "1" ]; then err "$1"; else warn "$1"; fi; }
if [ -z "$DOC_ROOT" ]; then
  err "文档目录不存在（试过 $DEV_ROOT/Docs/Dev 与 $REPO_ROOT/B.docs/Dev.Common）—— 目录改名后请同步 check-deploy.sh 的 DOC_ROOT"
else
  for doc_dir in "$DOC_ROOT/Issues/Top-Level" "$DOC_ROOT/Norms" "$DOC_ROOT/Lessons"; do
    [ ! -d "$doc_dir" ] && continue
    dir_tag=$(echo "$doc_dir" | sed -E 's#.*/(Docs/Dev|Dev\.Common)/##')
    # 提取文件序号（配套文件不算：.SPEC 是规格、.REMOVED 是已撤下留档）
    nums=$(ls "$doc_dir" 2>/dev/null | grep -vE '\.(SPEC|REMOVED)|NAMETRACE\.REMOVED' | sed -n 's/^\([0-9][0-9]*\)-.*/\1/p' | sort -n)
    if [ -z "$nums" ]; then continue; fi
    # gaps & duplicates
    prev=-1; gaps=""; dups=""
    for n in $nums; do
      nn=$((10#$n))
      if [ $nn -le $prev ]; then dups="$dups $n"; fi
      if [ $prev -ge 0 ] && [ $nn -le $prev ]; then :; elif [ $prev -ge 0 ] && [ $((nn - prev)) -gt 1 ]; then
        for g in $(seq $((prev+1)) $((nn-1))); do gaps="$gaps $g"; done
      fi
      prev=$nn
    done
    # INDEX 检查：提取 INDEX 中条目编号行（- [NNN] 或 [N] 格式），只匹配行首
    idx_file=$(ls "$doc_dir"/*.INDEX 2>/dev/null | head -1)
    if [ -n "$idx_file" ]; then
      idx_nums=$(grep -oE '^\s*-?\s*\[[0-9]+' "$idx_file" | grep -oE '[0-9]+' | sort -n | uniq)
      # 只检查 INDEX 里的每个条目号在文件中是否存在（允许 INDEX 有额外编号如 000）
      missing_from_files=""
      for inum in $idx_nums; do
        inum=$((10#$inum))
        found=0
        for fnum in $nums; do fnum=$((10#$fnum)); [ "$inum" -eq "$fnum" ] && found=1; done
        [ "$found" -eq 0 ] && missing_from_files="$missing_from_files $inum"
      done
      # 反向检查：文件中的每个编号是否在 INDEX 中
      missing_from_idx=""
      for fnum in $nums; do
        fnum=$((10#$fnum))
        found=0
        for inum in $idx_nums; do inum=$((10#$inum)); [ "$inum" -eq "$fnum" ] && found=1; done
        [ "$found" -eq 0 ] && missing_from_idx="$missing_from_idx $fnum"
      done
      if [ -n "$missing_from_files" ]; then err "$dir_tag INDEX 引用不存在的文件:$missing_from_files"; fi
      if [ -n "$missing_from_idx" ]; then docwarn "$dir_tag 文件未收录进 INDEX:$missing_from_idx"; fi
    fi
    if [ -n "$gaps" ]; then docwarn "$dir_tag 序号空洞（关闭/删除后留下的编号，确认是有意为之即可）:$gaps"; fi
    if [ -n "$dups" ]; then docwarn "$dir_tag 序号重复（同号两个文件会让'参见 NNN'指向不明）:$dups"; fi
  done
fi

# 8. 命名规范检查：app 目录的主入口 .ts 文件名必须和目录名一致
MOBILE_DIR="$IMPL/universe.infotech/local.mobile"
NAMING_BAD=""
for tier in apps; do
  tier_dir="$MOBILE_DIR/$tier"
  [ ! -d "$tier_dir" ] && continue
  for app_dir in "$tier_dir"/*/; do
    [ ! -d "$app_dir" ] && continue
    dir_name=$(basename "$app_dir")
    [ "${dir_name:0:1}" = "." ] && continue
    [ "${dir_name:0:8}" = "@FUTURE." ] && continue
    expected="$dir_name.ts"
    if [ ! -f "$app_dir/$expected" ]; then
      actual=$(ls "$app_dir"/*.ts 2>/dev/null | head -1)
      if [ -n "$actual" ]; then
        NAMING_BAD="$NAMING_BAD  $tier/$dir_name/$(basename "$actual") (应为 $expected)\n"
      fi
    fi
  done
done
if [ -n "$NAMING_BAD" ]; then
  err "app 主文件命名不规范:"
  echo -e "$NAMING_BAD" | while read -r line; do [ -n "$line" ] && echo -e "       $RED$line$R"; done
else
  ok "app naming conventions"
fi

# 9. @FUTURE 路径不能出现在 package.json 或 tsconfig.json 的 imports/paths 中
FUTURE_IN_CONFIG=""
# package.json: 只检查 "#xxx" import 行
hits=$(grep -n '"#.*@FUTURE\.' "$IMPL/package.json" 2>/dev/null || true)
if [ -n "$hits" ]; then FUTURE_IN_CONFIG="$FUTURE_IN_CONFIG\n  package.json: $hits"; fi
# tsconfig.json: 只检查 "#xxx" paths 行
hits=$(grep -n '"#.*@FUTURE\.' "$IMPL/tsconfig.json" 2>/dev/null || true)
if [ -n "$hits" ]; then FUTURE_IN_CONFIG="$FUTURE_IN_CONFIG\n  tsconfig.json: $hits"; fi
if [ -n "$FUTURE_IN_CONFIG" ]; then
  err "@FUTURE 路径不能出现在 imports/paths 配置中:"
  echo -e "$FUTURE_IN_CONFIG" | while read -r line; do [ -n "$line" ] && echo -e "       $RED$line$R"; done
else
  ok "no @FUTURE in config"
fi

# 9b. 别名表同步：tsconfig paths 必须与 package.json imports 一致,且指向的文件存在
# (历史教训: metaconsciousness.ts / main.ts / mouth.ts 三次漂移都是双表手工同步导致)
ALIAS_BAD=$(node -e "
const fs=require('fs'),path=require('path');
const p=JSON.parse(fs.readFileSync('$IMPL/package.json','utf8')).imports||{};
const t=(JSON.parse(fs.readFileSync('$IMPL/tsconfig.json','utf8').replace(/^\s*\/\/.*$/gm,'')).compilerOptions||{}).paths||{};
const bad=[];
for(const [k,v] of Object.entries(p)){
  const tv=t[k]&&t[k][0];
  if(!tv)bad.push(k+': tsconfig 缺失');
  else if(tv!==v)bad.push(k+': pkg='+v+' ts='+tv);
  if(!fs.existsSync(path.join('$IMPL',v)))bad.push(k+': 文件不存在 '+v);
}
console.log(bad.join('\n'));
" 2>/dev/null)
if [ -n "$ALIAS_BAD" ]; then
  err "别名表漂移 (package.json imports vs tsconfig paths):"
  echo "$ALIAS_BAD" | while read -r line; do [ -n "$line" ] && echo -e "       $RED$line$R"; done
else
  ok "alias table in sync"
fi

# 9c. 回归测试 — 已废弃（2026-08-11 ears 重构后测试文件已删除，不再需要）

# 10. 密钥泄漏检查：源码中不能出现疑似 API key/token 的硬编码值
# 排除: services.json(运行时配置), node_modules, .git, rna.json(生成文件)
SECRET_LEAKS=""
# 检查 JSON 文件中的疑似凭证字段（apiKey/token/access_key 等有 ≥16 位非空值）
leaks=$(grep -rn '"doubao_app_key"\|"doubao_access_key"\|"doubao_token"\|"doubao_appid"\|"apiKey"\|"access_key"' "$IMPL/" \
  --include="*.json" --include="*.ts" --include="*.js" --include="*.cjs" --include="*.py" \
  2>/dev/null \
  | grep -v node_modules | grep -v "services.json" | grep -v "rna.json" \
  | grep -vE '"(apiKey|access_key|doubao_app_key|doubao_access_key|doubao_token|doubao_appid)":\s*""' \
  | grep -E ':\s*"[A-Za-z0-9_-]{12,}"' \
  || true)
if [ -n "$leaks" ]; then
  SECRET_LEAKS="$leaks"
fi
if [ -n "$SECRET_LEAKS" ]; then
  err "源码中检测到疑似硬编码密钥（凭证应只在 ~/.teyvat/config/services.json）:"
  echo "$SECRET_LEAKS" | while IFS= read -r line; do [ -n "$line" ] && echo -e "       $RED$line$R"; done
else
  ok "no hardcoded secrets"
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo -e "  ${GRN}all checks passed${R}"
else
  echo -e "  ${YLW}some checks failed${R}"
  exit 1
fi
