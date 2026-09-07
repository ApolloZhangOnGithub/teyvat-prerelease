#!/bin/bash
# 用 runtime 里的 pi 副本，不动用户全局安装的 pi。

# ── 路径常量（唯一真相源）──
export PAIMON_HOME="$HOME/.teyvat"
export PAIMON_RUNTIME="$HOME/.local/lib/teyvat/runtime"
export PAIMON_EXT="$HOME/.local/lib/teyvat/extensions/teyvat"
export PAIMON_CLI="$PAIMON_EXT/god.frontend.cli"
export PAIMON_CONFIG="$PAIMON_HOME/config"

# ── 运行时自包含（2026-09-05：不依赖用户 shell PATH / 网络配置）──
# bun/node 的自装路径前置到 PATH——launcher 是唯一入口，应保证 bun/node 可找到，
# 用户终端 PATH 里没有 ~/.bun/bin 时 genshin 命令（whoami/update/agent 启动）不再报 "bun: not found"。
[ -d "$HOME/.bun/bin" ] && PATH="$HOME/.bun/bin:$PATH"
[ -d "$HOME/.local/share/node24/bin" ] && PATH="$HOME/.local/share/node24/bin:$PATH"

# git 访问 GitHub 的代理自包含：本机 Clash 等代理端口在监听时自动 export（Linux 无代理直连 GitHub 被墙）
_proxy_port=""
for _p in 7897 7890; do (exec 3<>/dev/tcp/127.0.0.1/$_p) 2>/dev/null && { exec 3>&- 3<&-; _proxy_port=$_p; break; }; done
if [ -z "${https_proxy:-}" ] && [ -n "$_proxy_port" ]; then
  export https_proxy="http://127.0.0.1:$_proxy_port" http_proxy="http://127.0.0.1:$_proxy_port"
fi

RUNTIME_CLI="$PAIMON_RUNTIME/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
# ── 启动器快照（防"运行中被就地编辑"竞态）──────────────────────────────
# agent/edit 工具就地改写 ~/.local/bin/genshin（同 inode）时，正在运行的 bash 在退出
# 时会重新解析文件尾部，读到半截内容 → "unexpected EOF" 类语法错误（2026-08-15 实测）。
# 首次执行把自身快照到稳定路径并 exec：运行期与源文件彻底解耦，退出不再重读源文件。
# 注意：_snap 必须在 if 块外定义——exec 后的进程 PAIMON_LAUNCHER_SNAPSHOT=1 会跳过
# 整个 if 块，若 _snap 只在块内定义，后续 attach/headless/full-restart 分支的
# bash "$_snap" 会变成 bash "" → 秒退（2026-08-20 实测：support-01 headless 守护没起来的根因）。
_snap="$PAIMON_HOME/RuntimeCache/genshin-launcher.snapshot.sh"
if [ -z "$PAIMON_LAUNCHER_SNAPSHOT" ] && [ -f "$0" ]; then
  mkdir -p "$(dirname "$_snap")" 2>/dev/null
  # 快照复用优化（2026-09-05）：源文件未变时跳过重建——每次 genshin 启动省 cat+bash-n 开销（~1-2s）
  if [ -f "$_snap" ] && [ "$_snap" -nt "$0" ] && bash -n "$_snap" 2>/dev/null; then
    PAIMON_LAUNCHER_SNAPSHOT=1 exec bash "$_snap" "$@"
  fi
  _snaptmp="${_snap}.tmp.$$"
  # 必须原子替换（temp+mv）：cat 直写 $_snap 会在同一 inode 上截断重写——其他正在跑的
  # 会话的 bash 还在按 fd 读这个文件，读到新写入的半截内容（源文件被 edit 工具就地改写时
  # 的快照）→ 退出时尾部语法错误，且 EXIT trap 的 kitty pop/stty sane 不执行 →
  # kitty 序列泄漏（2026-08-15 实测：launcher 死于 849 行 + ^[[99;5:3u 泄漏同根）。
  # mv 换新 inode：运行中的会话继续读旧 inode 的完整文件，互不干扰。
  if cat "$0" > "$_snaptmp" 2>/dev/null && bash -n "$_snaptmp" 2>/dev/null; then
    chmod +x "$_snaptmp" 2>/dev/null
    if mv -f "$_snaptmp" "$_snap" 2>/dev/null; then
      PAIMON_LAUNCHER_SNAPSHOT=1 exec bash "$_snap" "$@"
    fi
  fi
  rm -f "$_snaptmp" 2>/dev/null
fi
export PAIMON_CODING_AGENT_DIR="$PAIMON_HOME/agent"
# 让 pi-dist 的 getAgentDir() 也指向 ~/.teyvat/agent，而不是默认的 ~/.pi/agent，
# 避免原生 pi /model 切换影响 genshin 的模型配置。
export PI_CODING_AGENT_DIR="$PAIMON_CODING_AGENT_DIR"
# 2026-08-18 修复 0.3.0 更名遗留：APP_NAME=genshin → pi 读 GENSHIN_CODING_AGENT_DIR（非 PI_/PAIMON_）。
# 此前变量名失配导致 getAgentDir() 回落默认 ~/.pi/agent，/m 读 ~/.pi/agent/models.json（漏 qwen 等新模型）。
export GENSHIN_CODING_AGENT_DIR="$PAIMON_CODING_AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$PAIMON_HOME/sessions"
export NODE_PATH="$PAIMON_RUNTIME/node_modules"
MEMORY_DIR="$PAIMON_HOME/MemoryData"
PLIST="$MEMORY_DIR/plist.json"
mkdir -p "$MEMORY_DIR"

if [ ! -f "$RUNTIME_CLI" ]; then
  echo "Error: teyvat runtime not installed. Run bash install.sh first."
  exit 1
fi

# ── i18n: 简体中文 or English ──
PAIMON_SETTINGS="$PAIMON_CONFIG/settings.json"
PAIMON_LANG=""
[ -f "$PAIMON_SETTINGS" ] && PAIMON_LANG=$(node --input-type=commonjs -e "try{console.log(JSON.parse(require('fs').readFileSync('$PAIMON_SETTINGS','utf8')).lang||'')}catch{console.log('')}" 2>/dev/null)
if [ -z "$PAIMON_LANG" ]; then
  case "${LANG:-}${LC_ALL:-}" in *zh_CN*) PAIMON_LANG="zh";; *) PAIMON_LANG="en";; esac
fi
export PAIMON_LANG

# 统一确认函数：只有 Y 通过
_confirm() {
  local prompt_zh="$1"
  local prompt_en="$2"
  if [ "$PAIMON_LANG" = "zh" ]; then
    read -p "$prompt_zh (Y 确认，其他取消) " CONFIRM
  else
    read -p "$prompt_en (Y to confirm) " CONFIRM
  fi
  case "$CONFIRM" in y|Y) return 0;; *) return 1;; esac
}

# 统一双语消息函数（PAIMON_LANG=zh 时输出中文，否则英文）
_l() {
  local zh="$1"; local en="$2"
  if [ "$PAIMON_LANG" = "zh" ]; then echo "$zh"; else echo "$en"; fi
}

# ── 单一真相源：把 DEEPSEEK_API_KEY 强制对齐到 models.json 里配的字面量 key ──
# 2026-08-14 提速：仅在实际启动 agent 的路径调用（列表/帮助等日常路径不再为它起 node 子进程）
__sync_dsk() {
  __DSK=$(node --input-type=commonjs -e "try{const j=JSON.parse(require('fs').readFileSync('$PAIMON_CONFIG/models.json','utf8'));const k=j.providers&&j.providers.deepseek&&j.providers.deepseek.apiKey;if(typeof k==='string'&&!k.startsWith('\$')&&k.trim())process.stdout.write(k.trim());}catch(e){}" 2>/dev/null)
  [ -n "$__DSK" ] && export DEEPSEEK_API_KEY="$__DSK"
}
[ -f "$PLIST" ] || echo '[]' > "$PLIST"

PAIMON_LIST_JS="$PAIMON_CLI/list.cjs"

# Parse flags
MODE=""
ORIG=("$@")
# genshin n [agent [msg]] — note command (before flag loop to avoid env interference)
# 无 agent → 列出所有非 archive agent 的 notes
if [ "$1" = "n" ]; then
  shift
  if [ -z "$1" ]; then
    exec node "$HOME/.local/lib/teyvat/extensions/teyvat/god.frontend.cli/note.cjs"
  fi
  NID=$(echo "$1" | node --input-type=commonjs -e "const fs=require('fs');const list=JSON.parse(fs.readFileSync('$HOME/.teyvat/MemoryData/plist.json','utf8'));const n=process.argv[1];const p=list.find(x=>x.name===n||x.id===n);if(p)console.log(p.id)" "$1" 2>/dev/null)
  [ -z "$NID" ] && { echo "agent not found: $1"; exit 1; }
  shift; exec node "$HOME/.local/lib/teyvat/extensions/teyvat/god.frontend.cli/note.cjs" "$NID" "$@"
fi
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --archive|-a) MODE="archive"; shift;;
    --archived|-A) MODE="archived"; shift;;
    --unarchive|-ua) MODE="unarchive"; shift;;
    --org|-o) MODE="org"; shift;;
    --note|-n) MODE="note"; shift;;
    n) MODE="note"; shift;;
    --kill|-k) MODE="kill"; shift;;
    --tmux|-t) MODE="tmux"; shift;;
    --mobile|-m) MODE="mobile"; shift;;

    --metaconsciousness|-mc) MODE="mc"; shift;;
    --hippocampus|-hc) MODE="hc"; shift;;
    --web|-w) MODE="web"; shift;;
    --detail|-D) export PAIMON_DETAIL=1; shift;;
    --settings|-s) MODE="settings"; shift;;
    --help|-h)
      node "$PAIMON_LIST_JS" "$PLIST" "$MEMORY_DIR" "$PAIMON_LANG" help
      exit 0;;
    --version|-v)
      if [ -z "$2" ] || [ "${2:0:1}" = "-" ]; then
        # genshin -v: show available versions
        echo ""
        if [ -f "$PAIMON_HOME/agent/version.json" ]; then
          node --input-type=commonjs -e "
            const fs=require('fs'),h=require('os').homedir(),lang=process.env.PAIMON_LANG||'en',zh=lang==='zh';
            const cur=JSON.parse(fs.readFileSync(h+'/.teyvat/agent/version.json','utf8'));
            const C=zh?'当前':'current', H=zh?'通道':'channels', N=zh?'(无)':' (none)';
            console.log('  '+C+': ' + cur.genshin + ' (' + (cur.channel||'minutely') + ', pi v'+cur.pi+')');
            console.log('');
            console.log('  '+H+':');
            const pad = (s,n) => s + ' '.repeat(Math.max(0, n - s.length));
            const rows=[];
            const isCur = (ch) => (cur.channel||'minutely') === ch ? ' ◀' : '';
            // minutely
            rows.push(['minutely', cur.genshin, isCur('minutely')]);
            // dev-stable: 从 git tag 读取
            let devAdded = false;
            try {
              let repoRoot = '';
              try {
                const nmLink = require('path').join('$PAIMON_EXT', 'node_modules');
                const realNm = require('fs').realpathSync(nmLink);
                const coreDir = require('path').dirname(realNm);
                repoRoot = require('child_process').execSync('git rev-parse --show-toplevel', {cwd: coreDir, encoding:'utf8', timeout:2000}).trim();
              } catch {}
              if (repoRoot) {
                const gitTags = require('child_process').execSync('git tag -l dev-stable-* | sort -rV | head -6', {cwd: repoRoot, encoding:'utf8', timeout:2000}).trim().split('\n').filter(Boolean);
                for (const t of gitTags.slice(0,5)) {
                  const v = t.replace('dev-stable-','');
                  rows.push(['dev-stable', v, isCur('dev-stable')]);
                  devAdded = true;
                }
              }
            } catch {}
            if (!devAdded) {
              try {
                const svf=h+'/.teyvat/agent/version-stable.json';
                if(fs.existsSync(svf)){const sv=JSON.parse(fs.readFileSync(svf,'utf8'));rows.push(['dev-stable', sv.genshin, isCur('dev-stable')])}
                else {rows.push(['dev-stable', N, ''])}
              } catch {rows.push(['dev-stable', N, ''])}
            }
            // prerelease: 本地 update-prerelease 目录（若 update 过）——2026-09-05 加
            try {
              const pp = h + '/.local/lib/teyvat/update-prerelease/package.json';
              if (fs.existsSync(pp)) { rows.push(['prerelease', JSON.parse(fs.readFileSync(pp,'utf8')).version, isCur('prerelease')]); }
              else { rows.push(['prerelease', N, '']) }
            } catch { rows.push(['prerelease', N, '']) }
            // release: npm + GitHub  ⚠️ npm 分发已废弃（2026-09-05 用户定稿，见 Versioning WIKI）——优先 git 源
            let relVer = '';
            try{relVer=require('child_process').execSync('npm view teyvat version 2>/dev/null',{encoding:'utf8',timeout:3000}).trim()}catch{}
            if(!relVer) try{relVer=require('child_process').execSync('npm view pi-coding-master version 2>/dev/null',{encoding:'utf8',timeout:3000}).trim()}catch{}
            if(!relVer) try{const rv=require('child_process').execSync('git ls-remote --tags https://github.com/ApolloZhangOnGithub/teyvat-release.git 2>/dev/null',{encoding:'utf8',timeout:5000});const tags=rv.split('\\n').map(l=>l.replace(/.*refs\\/tags\\//,'')).filter(t=>t.startsWith('v')).sort().reverse();relVer=tags[0]||''}catch{}
            rows.push(['release', relVer||N, ''])
            const nw=Math.max(...rows.map(r=>r[0].length),10), vw=Math.max(...rows.map(r=>r[1].length),8);
            for(const r of rows) console.log('    '+pad(r[0],nw)+'  '+pad(r[1],vw)+'  '+r[2]);
          " 2>/dev/null
        else
          echo "  genshin version unknown"
        fi
        echo ""
        exit 0
      fi
      # genshin -v dev-stable: use dev-stable channel
      VCHANNEL="$2"; shift; shift;;
    --*) __sync_dsk; exec node "$RUNTIME_CLI" "${ORIG[@]}";;
    *) POS+=("$1"); shift;;
  esac
done
set -- "${POS[@]+"${POS[@]}"}"

NAME="$1"
[ "$MODE" != "note" ] && shift 2>/dev/null

# ── 子命令路由 ──
PAIMON_CLI_TS="$PAIMON_CLI/cli.ts"
case "$NAME" in
  help|h)
    node "$PAIMON_LIST_JS" "$PLIST" "$MEMORY_DIR" "$PAIMON_LANG" help
    exit 0;;
  version|v)
    exec "$0" --version "$@";;
  doctor)
    cd "$PAIMON_EXT/.." && bun "$PAIMON_CLI_TS" doctor
    exit $?;;
  rename)
    cd "$PAIMON_EXT/.." && bun "$PAIMON_CLI_TS" rename "$@"
    exit $?;;
  clone|c)
    cd "$PAIMON_EXT/.." && bun "$PAIMON_CLI_TS" clone "$@"
    exit $?;;
  login|logout|unbind|whoami)
    cd "$PAIMON_EXT/.." && bun "$PAIMON_CLI_TS" "$NAME" "$@"
    exit $?;;
  d|devices)
    # [2026-09-05] 设备管理（devices.cjs）：无参=列表；rn <id> <名>=改名；<name|编号|id>=查看该设备 genshin 快照（不做远程执行）
    node "$PAIMON_CLI/devices.cjs" "$@"
    exit $?;;
  sync)
    # [云同步已废弃 2026-09-05，PROPOSAL 036 替代] agent 单机存活，不做跨机状态同步；代码保留不删。
    echo "$(_l "  云同步已废弃（agent 单机存活，机间走 social 通讯）。" "  Cloud sync deprecated (agents live per-machine; cross-device via social).")"
    exit $?;;
  update)
    echo ""
    echo -e "  \033[1mgenshin update\033[0m"
    echo "  ─────────────────────────────────"
    SOURCE_DIR="$HOME/.local/lib/teyvat/source"
    VER_JSON="$HOME/.teyvat/agent/version.json"
    CHANNEL="minutely"
    [ -f "$VER_JSON" ] && CHANNEL=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VER_JSON','utf8')).channel)}catch{console.log('minutely')}" 2>/dev/null)
    if [ "$CHANNEL" = "release" ]; then
      # ⚠️ npm 分发已废弃（2026-09-05 用户定稿）——release 改走 git tag（teyvat-release 仓库）
      echo "  channel: release (git tag)"
      UP_DIR="$HOME/.local/lib/teyvat/update-release"
      mkdir -p "$UP_DIR"
      if [ ! -d "$UP_DIR/.git" ]; then
        git clone https://github.com/ApolloZhangOnGithub/teyvat-release.git "$UP_DIR" 2>&1 | tail -2
      else
        ( cd "$UP_DIR" && git pull --ff-only 2>&1 | tail -2 )
      fi
      echo -e "  \033[32mOK\033[0m release 源已更新（$UP_DIR）——运行其中的 deploy/install.sh 完成部署"
    elif [ "$CHANNEL" = "prerelease" ] || [ "$CHANNEL" = "beta" ]; then
      # prerelease/beta 通道（2026-09-05 起纯 git，不走 npm）：拉 paimon-code-prerelease → 手动 install.sh
      # （install.sh 已支持 core/ 包结构：PKG_ROOT 检测到 core/ 即按 prerelease 布局部署）
      echo "  channel: $CHANNEL (paimon-code-prerelease, git)"
      UP_DIR="$HOME/.local/lib/teyvat/update-prerelease"
      mkdir -p "$UP_DIR"
      if [ ! -d "$UP_DIR/.git" ]; then
        if ! git clone https://github.com/ApolloZhangOnGithub/paimon-code-prerelease.git "$UP_DIR"; then
          echo -e "  \033[31mERROR\033[0m prerelease clone 失败（网络/代理问题？）"
          exit 1
        fi
      else
        if ! ( cd "$UP_DIR" && git pull --ff-only ); then
          echo -e "  \033[31mERROR\033[0m prerelease pull 失败（网络/代理问题？）"
          exit 1
        fi
      fi
      # 触发部署（postinstall 语义等价物）：显式跑包内 install.sh。install.sh 防裸跑要求 make 环境
      # （PAIMON_VIA_MAKE=1 + MAKELEVEL）——prerelease 消费方无 make，这里显式伪装
      # PAIMON_VER 从包内 package.json 读（version.json 只有 PAIMON_VER 非空才更新）
      PKG_VER=$(node -e "console.log(require('$UP_DIR/package.json').version)" 2>/dev/null)
      # 部署判断用 git HEAD 而非版本号（同版本号重发合法——prerelease 是 dev 滚动；HEAD 变化=有新提交才部署）
      NEW_HEAD=$(git -C "$UP_DIR" rev-parse HEAD 2>/dev/null)
      OLD_HEAD=""
      [ -f "$UP_DIR/.last-deployed-head" ] && OLD_HEAD=$(cat "$UP_DIR/.last-deployed-head" 2>/dev/null)
      if [ -n "$NEW_HEAD" ] && [ "$NEW_HEAD" = "$OLD_HEAD" ]; then
        echo -e "  \033[32mOK\033[0m 无新提交 ($PKG_VER)，跳过部署"
        exit 0
      fi
      if ( cd "$UP_DIR" && PAIMON_VIA_MAKE=1 MAKELEVEL=1 PAIMON_CHANNEL=prerelease PAIMON_VER="$PKG_VER" bash deploy/install.sh 2>&1 | tail -5 ); then
        echo "$NEW_HEAD" > "$UP_DIR/.last-deployed-head"
        echo -e "  \033[32mOK\033[0m prerelease $PKG_VER 已更新并部署"
      else
        echo -e "  \033[31mERROR\033[0m prerelease 更新失败"
        exit 1
      fi
    elif [ -d "$SOURCE_DIR/.git" ]; then
      echo "  channel: $CHANNEL (source: $SOURCE_DIR)"
      cd "$SOURCE_DIR" && git pull --ff-only && bash Codebase/deploy/install.sh
    else
      echo "  ERROR: cannot locate source. reinstall with bootstrap.sh"
      exit 1
    fi
    exit $?;;
  uninstall)
    echo ""
    echo -e "  \033[1mgenshin uninstall\033[0m"
    echo "  ─────────────────────────────────"
    echo "  will remove:"
    echo "    ~/.local/bin/genshin            (launcher)"
    echo "    ~/.local/bin/mobile            (mobile cli)"
    echo "    ~/.local/bin/identity          (identity cli)"
    echo "    ~/.local/lib/teyvat/extensions (extensions)"
    echo "    ~/.local/lib/teyvat/runtime    (runtime)"
    echo ""
    echo -e "  \033[33mnot removed:\033[0m"
    echo "    ~/.teyvat/                     (agent data, config)"
    echo "    ~/.local/lib/teyvat/source     (source code)"
    echo ""
    read -p "  continue? [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "  cancelled"
      exit 0
    fi
    rm -f "$HOME/.local/bin/genshin" "$HOME/.local/bin/mobile" "$HOME/.local/bin/mobile-runner.mjs" "$HOME/.local/bin/identity"
    rm -rf "$HOME/.local/lib/teyvat/extensions" "$HOME/.local/lib/teyvat/extensions-stable" "$HOME/.local/lib/teyvat/runtime"
    echo -e "  \033[32mOK\033[0m uninstalled. agent data preserved in ~/.teyvat/"
    echo "  to reinstall: bash <(curl -fsSL https://raw.githubusercontent.com/ApolloZhangOnGithub/teyvat-dev/main/Codebase/deploy/bootstrap.sh)"
    exit 0;;
  archive|a)    MODE="archive"; NAME="$1"; shift 2>/dev/null;;
  unarchive|ua) MODE="unarchive"; NAME="$1"; shift 2>/dev/null;;
  archived|A)   MODE="archived"; NAME="";;
  kill|k)       MODE="kill"; NAME="$1"; shift 2>/dev/null;;
  tmux|t)       MODE="tmux"; NAME="$1"; shift 2>/dev/null;;
  meta|mc)      MODE="mc"; NAME="$1"; shift 2>/dev/null;;
  hippo|hc)     MODE="hc"; NAME="$1"; shift 2>/dev/null;;
  god|g)        MODE="god"; NAME="$1"; shift 2>/dev/null;;
  mobile|m)     MODE="mobile"; NAME="$1"; shift 2>/dev/null;;

  settings|s)   MODE="settings"; NAME="";;
  note|n)       exec node "$PAIMON_CLI/note.cjs" "$@";;
  org|o)        MODE="org"; NAME="$1"; shift 2>/dev/null;;
  web|w)        MODE="web"; NAME="";;
esac

# genshin god <sub> — 人类专属工具入口，跳过名字验证
# genshin god m/mobile → 手机 TUI
# genshin god h/health → 开发者 Health Dashboard
if [ "$MODE" = "god" ]; then
  case "$NAME" in
    m|mobile)  exec bun "$PAIMON_EXT/god.frontend.cli/mobile.ts";;
    h|health)  shift; exec bun "$PAIMON_EXT/god.frontend.cli/health.ts" "$@";;
    *)         echo "Usage: genshin god <m|mobile|h|health>"; exit 1;;
  esac
fi
# 向后兼容: genshin m g 仍可使用
if [ "$MODE" = "mobile" ] && { [ "$NAME" = "god" ] || [ "$NAME" = "g" ]; }; then
  exec bun "$PAIMON_EXT/god.frontend.cli/mobile.ts"
fi

# 阻止非法名字（纯数字走序号路径，不在这里拦；分组编号 1o/1f/1b/1a 及兼容 f1/o1 走分组路由，也不拦；org 模式有自己的验证）
if [ -n "$NAME" ] && [ "$MODE" != "org" ] && [ "$MODE" != "note" ] && [ "$MODE" != "note" ] && [[ ! "$NAME" =~ ^[0-9]+$ ]] && [[ ! "$NAME" =~ ^([0-9]+[ofba]|[ofba][0-9]+)$ ]]; then
  if [ "${NAME:0:1}" = "-" ]; then
    echo "$(_l "Error: 未知选项 '$NAME'。用 genshin -h 查看用法。" "Error: unknown option '$NAME'. Use genshin -h for usage.")"
    exit 1
  fi
  if [ "${NAME:0:1}" = "/" ]; then
    echo "$(_l "Error: '$NAME' 是路径，不是名字。" "Error: '$NAME' is a path, not a name.")"
    exit 1
  fi
  # 只允许 [a-zA-Z0-9_-.]，必须字母开头，必须含数字
  if [[ ! "$NAME" =~ ^[a-zA-Z][a-zA-Z0-9_.\-]*$ ]]; then
    echo "$(_l "Error: 名字只能用英文字母、数字、下划线、点、横杠，且必须字母开头。" "Error: names may only use letters, digits, underscore, dot, dash, and must start with a letter.")"
    echo "$(_l "  示例: genshin alice_$(date +%Y%m%d)" "  e.g. genshin alice_$(date +%Y%m%d)")"
    exit 1
  fi
  if [[ ! "$NAME" =~ [0-9] ]]; then
    echo "$(_l "Error: 名字必须含数字（防止和命令混淆）。建议加日期后缀。" "Error: the name must contain a digit (to avoid clashing with commands). Add a date suffix.")"
    echo "$(_l "  示例: genshin ${NAME}_$(date +%Y%m%d)" "  e.g. genshin ${NAME}_$(date +%Y%m%d)")"
    exit 1
  fi
fi
# ── web UI ──
if [ "$MODE" = "web" ]; then
  PAIMON_SERVER_DIR="${PAIMON_SERVER_DIR:-$PAIMON_EXT/universe.infotech/cloud.servers/genshin-server}"
  if [ ! -f "$PAIMON_SERVER_DIR/server.js" ]; then
    echo "Error: genshin web server not found at $PAIMON_SERVER_DIR"
    exit 1
  fi
  PAIMON_PORT="${PAIMON_PORT:-3000}"
  # Kill any existing genshin-server (only node server.js, not other processes on the port)
  OLD_PIDS=$(pgrep -f "node.*genshin-server/server.js" 2>/dev/null)
  [ -n "$OLD_PIDS" ] && echo "$OLD_PIDS" | xargs kill 2>/dev/null && sleep 0.5
  cd "$PAIMON_SERVER_DIR" && PAIMON_PORT="$PAIMON_PORT" node server.js > /tmp/genshin-web.log 2>&1 &
  SERVER_PID=$!
  disown $SERVER_PID
  ACTUAL_PORT=""
  for i in $(seq 1 30); do
    ACTUAL_PORT=$(grep -o 'http://127.0.0.1:[0-9]*' /tmp/genshin-web.log 2>/dev/null | head -1 | grep -o '[0-9]*$')
    [ -n "$ACTUAL_PORT" ] && break
    sleep 0.5
  done
  [ -z "$ACTUAL_PORT" ] && ACTUAL_PORT=$PAIMON_PORT
  echo "genshin web: http://127.0.0.1:$ACTUAL_PORT (pid $SERVER_PID)"
  open "http://127.0.0.1:$ACTUAL_PORT"
  exit 0
fi

# ── archive 管理 ──
# ── settings ──
PAIMON_SETTINGS_JS="$PAIMON_CLI/settings.cjs"
if [ "$MODE" = "settings" ]; then
  node "$PAIMON_SETTINGS_JS" "$PAIMON_SETTINGS" "$PAIMON_LANG"
  exit 0
fi

PAIMON_LIST_SCRIPT="$(dirname "$RUNTIME_CLI")/../../../.."

if [ "$MODE" = "archived" ]; then
  if [ -n "$NAME" ]; then echo "$(_l "用法: genshin -A  (不接受额外参数)" "Usage: genshin -A  (no extra arguments)")"; exit 1; fi
  node "$PAIMON_LIST_JS" "$PLIST" "$MEMORY_DIR" "$PAIMON_LANG" archived
  exit 0
fi
if [ "$MODE" = "archive" ] || [ "$MODE" = "unarchive" ]; then
  if [ -z "$NAME" ]; then echo "$(_l "用法: genshin --$MODE <名字|序号|1-5|*> " "Usage: genshin --$MODE <name|index|1-5|*> ")"; exit 1; fi
  PAIMON_ARCHIVE_JS="$PAIMON_CLI/archive.cjs"
  node "$PAIMON_ARCHIVE_JS" "$PLIST" "$MODE" "$NAME" "$@" || exit 1
  exit 0
fi

# -- org: 组织管理 ──
if [ "$MODE" = "org" ]; then
  PAIMON_ORG_JS="$PAIMON_CLI/organization.cjs"
  if [ -z "$NAME" ]; then
    # genshin -o 无参数 → 列出所有组织
    node "$PAIMON_ORG_JS" "$PLIST" || exit 1
  else
    # genshin -o <name|id> [leave] [agent] → 创建/查看/加入/退出
    node "$PAIMON_ORG_JS" "$PLIST" "$NAME" "$@" || exit 1
  fi
  exit 0
fi

# -- mobile --
if [ "$MODE" = "mobile" ]; then
  if [ -z "$NAME" ]; then echo "$(_l "用法: genshin m <名字|序号>  (genshin m g = 你自己的手机)" "Usage: genshin m <name|index>  (genshin m g = your own phone)")"; exit 1; fi
  # 数字→active 序号，名字→ID
  ID=$(node --input-type=commonjs -e "
    const fs=require('fs'),{execSync}=require('child_process');
    const list=JSON.parse(fs.readFileSync('$PLIST','utf8')).filter(p=>!p.archived);
    const now=Date.now();
    let ps='';try{ps=execSync('ps aux',{encoding:'utf8'})}catch{}
    for(const p of list){p._active=ps.split('\\n').some(l=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id));p._ago=Math.round((now-new Date(p.lastEnded||p.lastSeen).getTime())/60000)}
    list.sort((a,b)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago);
    const active=list.filter(p=>p._active);
    const arg='$NAME';
    let p;
    if(/^[0-9]+\$/.test(arg)){p=active[parseInt(arg)-1];}
    else{p=list.find(x=>x.name===arg||x.id===arg);}
    if(p)console.log(p.id+'::'+p.name);
  ")
  if [ -z "$ID" ]; then echo "$(_l "没找到 $NAME" "Not found: $NAME")"; exit 1; fi
  AGENT_NAME=$(echo "$ID" | cut -d: -f3-)
  ID=$(echo "$ID" | cut -d: -f1)
  node "$PAIMON_CLI/mobile.cjs" "$ID" "$AGENT_NAME"
  exit 0
fi

# -- sessions --
if [ "$MODE" = "sessions" ]; then
  if [ -z "$NAME" ]; then echo "$(_l "用法: genshin -S <名字|ID>" "Usage: genshin -S <name|ID>")"; exit 1; fi
  ID=$(node --input-type=commonjs -e "
    const list=JSON.parse(require('fs').readFileSync('$PLIST','utf8')).filter(x=>!x.archived);
    const arg='$NAME';
    if(/^[0-9]+\$/.test(arg)) {
      const n=Date.now();
      let ps=''; try{ps=require('child_process').execSync('ps aux',{encoding:'utf8',timeout:2000})}catch{}
      list.forEach(x=>{x._active=ps.split('\\n').some(l=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(x.id));x._ago=Math.round((n-new Date(x.lastEnded||x.lastSeen).getTime())/60000)});
      list.sort((a,b)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago);
      // separate active/offline numbering
      let ai=0, oi=0;
      const matches=[];
      for(const x of list){
        x._aid=x._active?(++ai):0; x._oid=!x._active?(++oi):0;
        if(x._aid===parseInt(arg)||x._oid===parseInt(arg)) matches.push(x);
      }
      if(matches.length===0) process.exit(1);
      console.log(matches.map(x=>x.id+'::'+x.name+'::'+(x._active?'active':'offline')).join('||'));
    } else { const p=list.find(x=>x.name===arg||x.id===arg); if(p)console.log(p.id+'::'+p.name); }
  ")
  if [ -z "$ID" ]; then echo "$(_l "没找到 $NAME" "Not found: $NAME")"; exit 1; fi
  IFS='||' read -ra MATCHES <<< "$ID"
  if [ ${#MATCHES[@]} -gt 1 ]; then
    echo "$(_l "序号 $NAME 有歧义:" "Index $NAME is ambiguous:")"
    for i in "${!MATCHES[@]}"; do
      m="${MATCHES[$i]}"
      MID="${m%%::*}"; m="${m#*::}"
      MNAME="${m%%::*}"; MSTATE="${m##*::}"
      echo "  [$((i+1))] $MNAME ($MSTATE)"
    done
    read -p "$(_l "选一个 [1-${#MATCHES[@]}]: " "Pick one [1-${#MATCHES[@]}]: ")" C
    if [ -n "$C" ] && [ "$C" -ge 1 ] 2>/dev/null && [ "$C" -le ${#MATCHES[@]} ]; then
      m="${MATCHES[$((C-1))]}"; ID="${m%%::*}"; ACTUAL_NAME="${m#*::}"; ACTUAL_NAME="${ACTUAL_NAME%%::*}"
    else echo "$(_l "取消" "Cancelled")"; exit 1; fi
  else
    m="${MATCHES[0]}"; ID="${m%%::*}"; ACTUAL_NAME="${m#*::}"; ACTUAL_NAME="${ACTUAL_NAME%%::*}"
  fi
  SESS_DIR="$PAIMON_HOME/SessionData/$ID"
  if [ ! -d "$SESS_DIR" ]; then echo "$(_l "$ACTUAL_NAME (#$ID) 没有 session 数据。" "$ACTUAL_NAME (#$ID) has no session data.")"; exit 1; fi
  echo "$(_l "$ACTUAL_NAME (#$ID) 的 session 历史：" "Session history of $ACTUAL_NAME (#$ID):")"
  echo ""
  for f in "$SESS_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    bn=$(basename "$f" .jsonl)
    ts=$(echo "$bn" | cut -d_ -f1 | sed 's/T/ /')
    size=$(wc -c < "$f" | tr -d ' ')
    echo "  $ts  ($(node -e "console.log((Math.round($size/1024))+'K')"))"
  done | sort -r
  echo ""
  echo "$(_l "总: $(ls "$SESS_DIR"/*.jsonl 2>/dev/null | wc -l | tr -d ' ') 个 session" "Total: $(ls "$SESS_DIR"/*.jsonl 2>/dev/null | wc -l | tr -d ' ') sessions")"
  exit 0
fi

# -- kill --
if [ "$MODE" = "kill" ]; then
  if [ -z "$NAME" ]; then echo "$(_l "用法: genshin -k <名字|ID|序号>" "Usage: genshin -k <name|ID|index>")"; exit 1; fi
  # 数字 => 第 N 个运行中的 agent
  if [[ "$NAME" =~ ^[0-9]+$ ]]; then
    TARGET=$(node --input-type=commonjs -e "
      const fs=require('fs'),{execSync}=require('child_process');
      const list=JSON.parse(fs.readFileSync('$PLIST','utf8')).filter(p=>!p.archived);
      const now=Date.now();
      let ps='';try{ps=execSync('ps aux',{encoding:'utf8'})}catch{}
      for(const p of list){p._active=ps.split('\\n').some(l=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id));p._ago=Math.round((now-new Date(p.lastEnded||p.lastSeen).getTime())/60000)}
      list.sort((a,b)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago);
      const active=list.filter(p=>p._active);
      const i=parseInt('$NAME')-1;
      if(active[i])console.log(active[i].name);
    ")
    if [ -z "$TARGET" ]; then echo "$(_l "没有第 $NAME 个运行中的 agent" "No running agent #$NAME")"; exit 1; fi
    NAME="$TARGET"
  fi
  PID=$(ps aux | grep "genshin:.*${NAME}" | grep -v grep | awk '{print $2}' | head -1)
  if [ -z "$PID" ]; then echo "$(_l "没找到运行中的 $NAME" "No running agent found: $NAME")"; exit 1; fi
  if _confirm "杀掉 $NAME?" "Kill $NAME?"; then
    # 杀掉 pi 进程及其父 bash launcher，清 wake-restart 防重启
    PARENT_PID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
    # 2026-09-07（ISSUE 139）：kill 分支补 T/Z 残留处理（对齐 ISSUE 133 启动锁判定）——
    # Ctrl+C/Ctrl+Z 遗留的 stopped(T)/僵尸(Z) 进程对 SIGTERM 无效：裸 kill 报"已杀掉"但进程没死
    # （用户实测 Linux：genshin k 反复杀 smart-linux-lifer-helper-008 每次都报已杀掉、进程一直在）。
    # T/Z → TERM 先行 + KILL 兜底；正常进程仍 TERM。
    PSTAT=$(ps -o stat= -p "$PID" 2>/dev/null | tr -d ' ')
    case "$PSTAT" in
      *Z*)
        kill -9 "$PID" 2>/dev/null;;
      *T*)
        kill -TERM "$PID" 2>/dev/null; sleep 0.4; kill -KILL "$PID" 2>/dev/null;;
      *)
        kill "$PID" 2>/dev/null;;
    esac
    # 父 launcher 同步清理（若也是残留则同法兜底）
    if [ -n "$PARENT_PID" ]; then
      PPSTAT=$(ps -o stat= -p "$PARENT_PID" 2>/dev/null | tr -d ' ')
      case "$PPSTAT" in
        *Z*) kill -9 "$PARENT_PID" 2>/dev/null;;
        *T*) kill -TERM "$PARENT_PID" 2>/dev/null; sleep 0.4; kill -KILL "$PARENT_PID" 2>/dev/null;;
        *)   kill "$PARENT_PID" 2>/dev/null;;
      esac
    fi
    # 找对应的 agent id 清文件
    AGENT_ID=$(echo "$NAME" | node --input-type=commonjs -e "const fs=require('fs'); const list=JSON.parse(fs.readFileSync('$PLIST','utf8')); const n=process.argv[1]; const p=list.find(x=>x.name===n||x.id===n); if(p)console.log(p.id)" "$NAME" 2>/dev/null)
    if [ -n "$AGENT_ID" ]; then
      rm -f "$PAIMON_HOME/RuntimeCache/$AGENT_ID/wake-restart" 2>/dev/null
      rm -f "$PAIMON_HOME/RuntimeCache/$AGENT_ID/restart-session.json" 2>/dev/null  # 2026-09-04 kill 时清 session 恢复标记（重 genshin 全新开始）
      rm -f "$PAIMON_HOME/MemoryData/$AGENT_ID/main.pid" 2>/dev/null
      rm -f "$PAIMON_HOME/RuntimeCache/$AGENT_ID/detached" 2>/dev/null  # 2026-08-20 kill 时清除 detach 标记（下次启动回 TUI）
    fi
    echo "$(_l "已杀掉 $NAME" "Killed $NAME")"
  else
    echo "$(_l "取消" "Cancelled")"
  fi
  exit 0
fi

# -- tmux --
if [ "$MODE" = "tmux" ]; then
  if [ -z "$NAME" ]; then echo "$(_l "用法: genshin -t <名字|ID|序号>" "Usage: genshin -t <name|ID|index>")"; exit 1; fi
  # 数字 => 第 N 个运行中的 agent
  if [[ "$NAME" =~ ^[0-9]+$ ]]; then
    TARGET=$(node --input-type=commonjs -e "
      const fs=require('fs'),{execSync}=require('child_process');
      const list=JSON.parse(fs.readFileSync('$PLIST','utf8')).filter(p=>!p.archived);
      const now=Date.now();
      let ps='';try{ps=execSync('ps aux',{encoding:'utf8'})}catch{}
      for(const p of list){p._active=ps.split('\\n').some(l=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id));p._ago=Math.round((now-new Date(p.lastEnded||p.lastSeen).getTime())/60000)}
      list.sort((a,b)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago);
      const active=list.filter(p=>p._active);
      const i=parseInt('$NAME')-1;
      if(active[i])console.log(active[i].name);
    ")
    if [ -z "$TARGET" ]; then echo "$(_l "没有第 $NAME 个运行中的 agent" "No running agent #$NAME")"; exit 1; fi
    NAME="$TARGET"
  fi
  PS_LINE=$(ps aux | grep "genshin:.*${NAME}" | grep -v grep | head -1)
  if [ -z "$PS_LINE" ]; then
    # 没在跑 → tmux 新会话启动
    AGENT_ID=$(echo "$NAME" | node --input-type=commonjs -e "const fs=require('fs'); const list=JSON.parse(fs.readFileSync('$PLIST','utf8')); const n=process.argv[1]; const p=list.find(x=>x.name===n||x.id===n); if(p)console.log(p.id)" "$NAME" 2>/dev/null)
    if [ -z "$AGENT_ID" ]; then echo "$(_l "agent \"$NAME\" 不存在，先创建: genshin $NAME" "Agent \"$NAME\" does not exist; create it: genshin $NAME")"; exit 1; fi
    SESSION_NAME="genshin-${AGENT_ID}"
    if command -v tmux &>/dev/null; then
      tmux new-session -d -s "$SESSION_NAME" "$0 -r $NAME" 2>/dev/null && echo "$(_l "已启动 tmux 会话: $SESSION_NAME (agent: $NAME)" "Started tmux session: $SESSION_NAME (agent: $NAME)")" && echo "$(_l "连接: tmux attach -t $SESSION_NAME" "Attach: tmux attach -t $SESSION_NAME")" || echo "$(_l "tmux 启动失败" "Failed to start tmux")";
    else
      echo "$(_l "tmux 未安装。直接启动: genshin -r $NAME" "tmux not installed. Start directly: genshin -r $NAME")"
    fi
    exit 0
  fi
  TTY=$(echo "$PS_LINE" | awk '{print $7}')
  PID=$(echo "$PS_LINE" | awk '{print $2}')
  if [ "$TTY" = "??" ]; then
    echo "$(_l "$NAME 在后台运行（无终端），无法观看。PID: $PID" "$NAME is running in background (no tty), cannot watch. PID: $PID")"
  elif [ "$TTY" = "$(ps -o tty= -p $$ | tr -d ' ')" ]; then
    echo "$(_l "$NAME 就在当前终端运行中。" "$NAME is running in this terminal.")"
  else
    echo "$(_l "$NAME 在终端 $TTY 运行。PID: $PID" "$NAME is running in terminal $TTY. PID: $PID")"
  fi

  exit 0
fi

if [ -z "$NAME" ] && [ -z "$MODE" ]; then
  # 空态文案 + 排序落盘都已收进 list.cjs，这里只跑一次 node（2026-08-14 提速）
  node "$PAIMON_LIST_JS" "$PLIST" "$MEMORY_DIR" "$PAIMON_LANG" list
  exit 0
fi

if [ -z "$NAME" ]; then
  # 无 agent 的 note 模式 → 列出所有非 archive agent 的 notes
  if [ "$MODE" = "note" ]; then
    exec node "$PAIMON_CLI/note.cjs"
  fi
  echo "Usage: genshin [-mc] <name>"
  exit 1
fi

# mc/tmux: 数字→运行中 agent（在 ENTRY 解析前）
if [ "$MODE" = "mc" ] || [ "$MODE" = "tmux" ] || [ "$MODE" = "hc" ]; then
  if [[ "$NAME" =~ ^[0-9]+$ ]]; then
    TARGET=$(node --input-type=commonjs -e "
      const fs=require('fs'),{execSync}=require('child_process');
      const list=JSON.parse(fs.readFileSync('$PLIST','utf8')).filter(p=>!p.archived);
      const now=Date.now();
      let ps='';try{ps=execSync('ps aux',{encoding:'utf8'})}catch{}
      for(const p of list){p._active=ps.split('\\n').some(l=>l.includes('genshin:')&&l.includes('(main,')&&l.includes(p.id));p._ago=Math.round((now-new Date(p.lastEnded||p.lastSeen).getTime())/60000)}
      list.sort((a,b)=>(b._active?1:0)-(a._active?1:0)||a._ago-b._ago);
      const active=list.filter(p=>p._active);
      const i=parseInt('$NAME')-1;
      if(active[i])console.log(active[i].name);
    ")
    if [ -z "$TARGET" ]; then echo "$(_l "没有第 $NAME 个运行中的 agent" "No running agent #$NAME")"; exit 1; fi
    NAME="$TARGET"
  fi
fi

# Resolve by index or name
mkdir -p "$PAIMON_HOME/RuntimeCache"
ORDER_FILE="$PAIMON_HOME/RuntimeCache/genshin-order.json"
LAST_ORDER_FILE="$PAIMON_HOME/RuntimeCache/genshin-order-last.json"
ENTRY=$(node --input-type=commonjs -e "
  const fs = require('fs'), { execSync } = require('child_process');
  const list = JSON.parse(fs.readFileSync('$PLIST','utf8')).filter(p=>!p.archived);
  const now = Date.now();
  // 活跃检测统一用 main.pid（与 list.cjs 一致，不再用 ps aux）
  const PAIMON_HOME = '$PAIMON_HOME';
  for (const p of list) {
    let active = false;
    try {
      const pf = PAIMON_HOME + '/MemoryData/' + p.id + '/main.pid';
      const st = fs.statSync(pf);
      if (now - st.mtimeMs <= 90000) {
        const pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
        if (pid) { process.kill(pid, 0); active = true; }
      }
    } catch {}
    p._active = active;
    // 2026-08-20 分组：detached 存在 = 后台 headless（_b）——与 list.cjs / archive.cjs 同源（1b/1f 分组路由基础）
    // 2026-09-05 修复：必须 active && detached——与 list.cjs 的 _fb 一致（offline 不算 B）。
    //   否则 offline 但残留 detached 标记的 agent（headless 测试遗留）被标 _b=1 → 排序 F前B后 沉底 →
    //   组内序号与列表显示错位（genshin 3 的 3o 指向错误 agent）
    p._b = active && fs.existsSync(PAIMON_HOME + '/RuntimeCache/' + p.id + '/detached');
    p._ago = Math.round((now - new Date(p.lastEnded || p.lastSeen).getTime()) / 60000);
  }
  // 排序与 list.cjs 完全一致（活跃优先 + F 前 B 后 + 最近活跃优先）——保证数字路由的组内序号 = 列表显示序号
  list.sort((a,b) => (b._active?1:0) - (a._active?1:0) || ((a._b?1:0) - (b._b?1:0)) || a._ago - b._ago);
  const arg = '$NAME';
  let e;
  let grpMatch = arg.match(/^(\d+)([ofba])$/);   // 规范：数字在前（1f/1o/1b/1a，2026-08-20 定稿）
  let grpSwapped = false;
  if (!grpMatch) { grpMatch = arg.match(/^([ofba])(\d+)$/); grpSwapped = !!grpMatch; }  // 2026-09-04 兼容字母在前（f1/o1）——旧版歧义提示曾按此格式输出，用户照输会掉进创建流程
  if (grpMatch) {
    // 2026-08-20 分组路由：1o=offline 第 N、1f=front 第 N、1b=background 第 N、1a=active（F+B 合并）第 N——与列表分组编号一致
    const n = parseInt((grpSwapped ? grpMatch[2] : grpMatch[1])) - 1;
    const g = grpSwapped ? grpMatch[1] : grpMatch[2];
    const grps = {
      o: list.filter(p => !p._active),
      f: list.filter(p => p._active && !p._b),
      b: list.filter(p => p._active && p._b),
      a: list.filter(p => p._active),
    };
    e = grps[g][n];
  } else if (/^\d+$/.test(arg)) {
    // 2026-08-20 纯数字（用户定稿）：候选 = F（前台）第 N + B（后台）第 N + O（离线）第 N——
    // 只有一个进那个，多个则弹选择（歧义自动处理，如 f1=xxx/o1=yyy）；显式组用 1f/1b/1o/1a
    const n = parseInt(arg) - 1;
    const fArr = list.filter(p => p._active && !p._b);
    const bArr = list.filter(p => p._active && p._b);
    const oArr = list.filter(p => !p._active);
    const hits = [];
    if (fArr[n]) hits.push(['f', fArr[n]]);
    if (bArr[n]) hits.push(['b', bArr[n]]);
    if (oArr[n]) hits.push(['o', oArr[n]]);
    if (hits.length === 1) e = hits[0][1];
    else if (hits.length > 1) console.log('__AMBIG__' + hits.map(([g, p]) => (n + 1) + g + '=' + p.name).join('|'));  // 2026-09-04 修复：候选标签数字在前（1f/1o，与解析格式一致——旧版输出 f1/o1，用户照提示输入却解析失败掉进创建流程）
  } else {
    e = list.find(p => p.name === arg);
  }
  const order = list.map(p => p.id);
  fs.writeFileSync('$ORDER_FILE', JSON.stringify(order));
  if (e) console.log(JSON.stringify(e));
")

# 2026-08-20 歧义处理（用户定稿：不做交互菜单——弹菜单是垃圾）：输出候选 + 提示用分组编号重新输入（如 genshin 1f / 1o），退出
if [[ "$ENTRY" == __AMBIG__* ]]; then
  echo "$(_l "序号有歧义（多组同号），请用分组编号指定：" "Index ambiguous (multiple groups), use group-index:")"
  IFS='|' read -r -a cands <<< "${ENTRY#__AMBIG__}"
  for c in "${cands[@]}"; do
    g="${c%%=*}"; nm="${c#*=}"
    echo "  genshin $g   → $nm"
  done
  exit 1
fi

# check order change (number mode) — 暂时关闭，数字直接用上次保存的顺序
if false; then
  CURR_IDS=$(node --input-type=commonjs -e "console.log(JSON.parse(require('fs').readFileSync('$ORDER_FILE','utf8')).join(':'))")
  LAST_IDS=$(node --input-type=commonjs -e "console.log(JSON.parse(require('fs').readFileSync('$LAST_ORDER_FILE','utf8')).join(':'))")
  if [ "$CURR_IDS" != "$LAST_IDS" ]; then
    echo "顺序有变化，重新看了再选。当前列表："
    echo ""
    node "$PAIMON_LIST_JS" "$PLIST" "$MEMORY_DIR" "$PAIMON_LANG" active
    exit 1
  fi
fi
# save current as last
if [ -f "$ORDER_FILE" ]; then cp "$ORDER_FILE" "$LAST_ORDER_FILE"; fi

if [ -z "$ENTRY" ]; then
  # 检查重名（含已归档）
  EXISTING_NAME=$(node --input-type=commonjs -e "
    const list=JSON.parse(require('fs').readFileSync('$PLIST','utf8'));
    const p=list.find(x=>x.name==='$NAME');
    if(p)console.log(p.name+' (#'+p.id+')'+(p.archived?(process.env.PAIMON_LANG==='zh'?' 已归档':' (archived)'):''));
  ")
  if [ -n "$EXISTING_NAME" ]; then
    echo "$(_l "$EXISTING_NAME 已存在。" "$EXISTING_NAME already exists.")"
    if echo "$EXISTING_NAME" | grep -qE "已归档|archived"; then
      echo "$(_l "用 genshin -ua|--unarchive 恢复。" "Restore with genshin -ua|--unarchive.")"
    fi
    exit 1
  fi
  if [[ "$NAME" =~ ^[0-9]+$ ]]; then
    echo "$(_l "序号 $NAME 尚不存在。运行 genshin 查看agents列表。" "Index $NAME does not exist. Run genshin to see the agent list.")"
    exit 1
  fi
  if [ -n "$MODE" ]; then
    echo "\"$NAME\" not found."
    exit 1
  fi
  # 命名规则已在上面统一校验（字母开头 + 含数字 + ASCII only）
  # 2026-08-14 提速：用 bash 目录检查替代 COUNT 的 node 子进程（MemoryData 下有非 plist 条目 = 已有 agent）
  if [ -n "$(ls -A "$MEMORY_DIR" 2>/dev/null | grep -v '^plist.json$' | head -1)" ]; then
    if [ "$PAIMON_LANG" = "zh" ]; then
    read -p "创建 \"$NAME\"? [Y/n] " CONFIRM
  else
    read -p "Create \"$NAME\"? [Y/n] " CONFIRM
  fi
    case "$CONFIRM" in y|Y) ;; *) exit 0;; esac
  fi
  ID=$(node --input-type=commonjs -e "console.log(require('crypto').randomBytes(4).toString('hex'))")
  mkdir -p "$PAIMON_HOME/SessionData/$ID" "$MEMORY_DIR/$ID" "$PAIMON_HOME/AgentWorkDir/Individual/$ID"
  node --input-type=commonjs -e "
    const fs = require('fs');
    const list = JSON.parse(fs.readFileSync('$PLIST','utf8'));
    list.push({id:'$ID',name:'$NAME',kind:'coding-agent',deployment:'local',created:new Date().toISOString(),lastSeen:new Date().toISOString(),note:'',model:''});
    fs.writeFileSync('$PLIST',JSON.stringify(list,null,2));
    const idDir=require('os').homedir()+'/.teyvat/IdentityData/$ID';
    require('fs').mkdirSync(idDir,{recursive:true});
    require('fs').writeFileSync(idDir+'/identity.json',JSON.stringify({id:'$ID',name:'$NAME',kind:'coding-agent',created:new Date().toISOString(),lastSeen:new Date().toISOString(),archived:false,note:'',model:''},null,2));
  "
else
  ID=$(echo "$ENTRY" | node --input-type=commonjs -e "process.stdin.on('data',d=>{console.log(JSON.parse(d).id)})")
  NAME=$(echo "$ENTRY" | node --input-type=commonjs -e "process.stdin.on('data',d=>{console.log(JSON.parse(d).name)})")
fi

DATA_DIR="$MEMORY_DIR/$ID"
RUNTIME_DIR="$PAIMON_HOME/RuntimeCache/$ID"
mkdir -p "$DATA_DIR" "$RUNTIME_DIR" "$PAIMON_HOME/AgentWorkDir/Individual/$ID"  # AgentWorkDir 启动自动创建（2026-08-20）

# 确认（按模式区分提示）——2026-08-20 用户定稿：恢复无条件 Y/n 确认（删除 attached-back 跳过逻辑：
# 残留会误跳过确认导致"直接进入无提示"，用户实测痛批。attach 场景的确认由用户手动 Y 即可。）
if [ -t 0 ]; then
  case "$MODE" in
    mc) _confirm "查看 $NAME 的元意识？" "Watch MC $NAME?" || { echo "取消"; exit 0; } ;;
    hc) _confirm "查看 $NAME 的海马体？" "Watch HC $NAME?" || { echo "取消"; exit 0; } ;;
    tmux) _confirm "观看 $NAME?" "Watch $NAME?" || { echo "取消"; exit 0; } ;;
    *) _confirm "进入 $NAME?" "Enter $NAME?" || { echo "取消"; exit 0; } ;;
  esac
fi

# 确认后更新 lastSeen
if [ -n "$ENTRY" ]; then
  node --input-type=commonjs -e "
    const fs = require('fs');
    const list = JSON.parse(fs.readFileSync('$PLIST','utf8'));
    const p = list.find(x=>x.id==='$ID');
    if(p && !p.archived){p.lastSeen=new Date().toISOString();
      try{const idPath=require('os').homedir()+'/.teyvat/IdentityData/$ID/identity.json';const idData=JSON.parse(require('fs').readFileSync(idPath,'utf8'));idData.lastSeen=p.lastSeen;require('fs').writeFileSync(idPath,JSON.stringify(idData,null,2));}catch{}
      fs.writeFileSync('$PLIST',JSON.stringify(list,null,2));}
  "
fi

# ── 扩展：显式指定，不自动发现 ──
PAIMON_EXT_BASE="$HOME/.local/lib/teyvat/extensions"
EXT_DIR="$PAIMON_EXT"
if [ "$VCHANNEL" = "dev-stable" ] && [ -d "$PAIMON_EXT_BASE-stable/teyvat" ]; then
  EXT_DIR="$PAIMON_EXT_BASE-stable/teyvat"
fi
EXT_FLAGS="-ne -e $EXT_DIR/index.ts"

case "$MODE" in
  mc)
    TMUX_NAME="mc-$ID"
    if ! tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
      echo "$(_l "$NAME 的元意识进程没有在运行。先用 genshin $NAME 启动主 session。" "$NAME's metaconsciousness process is not running. Start the main session with genshin $NAME first.")"
      exit 0
    fi
    echo "$(_l "按 Ctrl+B 再按 D 退出" "Press Ctrl+B then D to detach")"
    exec tmux attach -t "$TMUX_NAME"
    ;;
  note)
    if [ -z "$NAME" ]; then exec node "$PAIMON_CLI/note.cjs"; fi
    NID=$(echo "$NAME" | node --input-type=commonjs -e "const fs=require('fs'); const list=JSON.parse(fs.readFileSync('$PLIST','utf8')); const n=process.argv[1]; const p=list.find(x=>x.name===n||x.id===n); if(p)console.log(p.id)" "$NAME" 2>/dev/null)
    if [ -z "$NID" ]; then echo "$(_l "未找到agent: $NAME" "Agent not found: $NAME")"; exit 1; fi
    shift
    exec node "$PAIMON_CLI/note.cjs" "$NID" "$@"
    ;;
  hc)
    TMUX_NAME="hc-$ID"
    if ! tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
      echo "$(_l " $NAME 的海马体进程尚未运行。先用 genshin $NAME 启动主 session。" " $NAME's hippocampus process is not running yet. Start the main session with genshin $NAME first.")"
      exit 0
    fi
    echo "$(_l "按 Ctrl+B 再按 D 退出" "Press Ctrl+B then D to detach")"
    exec tmux attach -t "$TMUX_NAME"
    ;;
  *)
    LOCKDIR="$RUNTIME_DIR/main.lock"
    PIDFILE="$RUNTIME_DIR/main.pid"
    # 原子锁：mkdir 在 Unix 上天然原子，避免 check-then-write 竞态
    if ! mkdir "$LOCKDIR" 2>/dev/null; then
      # 锁已存在，检查持有者是否还活着
      OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
      PROC_ALIVE=0
      if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        # 2026-09-07（ISSUE 133）：kill -0 只查进程存在性——Ctrl+C/Ctrl+Z 遗留的 stopped(T)/僵死(Z)
        # 进程也返回成功 → 误报"已在前台运行中"（用户实测：Linux 上 agent 被挂起后 genshin 1o 进不去）。
        # 查真实状态：T/Z 视为异常残留 → 终止后清锁重新启动（agent 状态在磁盘，新实例正常恢复）。
        PSTAT=$(ps -o stat= -p "$OLD_PID" 2>/dev/null | tr -d ' ')
        case "$PSTAT" in
          *Z*)
            echo "  $(date '+%H:%M:%S') 检测到僵死进程 (PID $OLD_PID, zombie)，清理后重新启动…"
            kill -9 "$OLD_PID" 2>/dev/null; PSTAT="" ;;
          *T*)
            echo "  $(date '+%H:%M:%S') 检测到挂起残留进程 (PID $OLD_PID, stopped——可能 Ctrl+C/Ctrl+Z 遗留)。"
            echo "  终止残留进程后重新启动（agent 运行状态在磁盘，不受影响）…"
            kill -TERM "$OLD_PID" 2>/dev/null; sleep 0.4; kill -KILL "$OLD_PID" 2>/dev/null; PSTAT="" ;;
        esac
        [ -n "$PSTAT" ] && PROC_ALIVE=1
      fi
      if [ "$PROC_ALIVE" = "1" ]; then
        # ── attach 分支（2026-08-20，PROPOSAL 034 阶段 4）：agent 在后台 headless 运行（/h 后）──
        # 用户重新 genshin xxx → 恢复到前台 TUI（清 detached 标记 + 杀 headless 进程 + 重新启动）：
        # 同一 SESSION_DIR，session/记忆/意图栈延续，TUI 渲染完整历史——"重新进入前台看到"。
        if [ -f "$RUNTIME_DIR/detached" ]; then
          echo "$(_l "\n正在把 $NAME 恢复到前台 TUI（headless → 前台，将中断后台当前回合）…" "\nRestoring $NAME to foreground TUI (headless → TUI, current background turn will be interrupted)…")"
          rm -f "$RUNTIME_DIR/detached" 2>/dev/null
          # headless 守护是 setsid 新会话（进程组首进程）——杀整个进程组（launcher+node），
          # 否则只杀 launcher 会留孤儿 node 继续跑（2026-08-20）
          kill -TERM -- "-$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null
          sleep 1
          rm -rf "$LOCKDIR" 2>/dev/null
          rm -f "$PIDFILE" 2>/dev/null
          # 2026-08-20 用户需求：attach 回前台时给 agent 注入"用户已以前台模式进入"通知——
          # 写 attached-back 标记，TUI 进程启动（heart 第一回合）时检测并注入 display-shown 消息 + 清标记
          echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",\"from\":\"attach\"}" > "$RUNTIME_DIR/attached-back" 2>/dev/null
          # 重新执行 launcher（锁已清）→ 正常 TUI 启动（session 延续）
          # 2026-08-20：必须用 ${ORIG[@]}（原始参数）——launcher.sh:189 的 shift 已把 agent 名从 $@ 移除，
          # 用 "$@" 会让 exec 的快照无 agent 名 → 启动失败（headless 守护没起来的根因）。
          exec bash "$_snap" "${ORIG[@]}"
        fi
        SESSION_ID=$(ps aux 2>/dev/null | grep "genshin:.*$ID" | head -1 | sed 's/.*(main,[^,]*,//' | sed 's/).*//')
        echo "$(_l "$NAME 已在前台运行中（PID $OLD_PID，session ${SESSION_ID:-?}）。如需重启: genshin kill $NAME 后重新启动。" "$NAME is already running in foreground (PID $OLD_PID, session ${SESSION_ID:-?}). To restart: genshin kill $NAME then start again.")"
        exit 1
      fi
      # 僵尸锁/异常残留已清：旧进程已死或已终止，拿走锁
      rm -rf "$LOCKDIR" 2>/dev/null
      mkdir "$LOCKDIR" 2>/dev/null || { echo "$(_l "ERROR: 无法获取锁" "ERROR: cannot acquire lock")"; exit 1; }
    fi
    echo $$ > "$PIDFILE"
    BLACKBOX="$EXT_DIR/god.frontend.cli/_debug_blackbox.sh"
    PAIMON_COMPRESS="$EXT_DIR/god.frontend.cli/compress.cjs"
    cleanup() {
      rm -rf "$LOCKDIR" 2>/dev/null
      rm -f "$PIDFILE"
      _pim_count=$(ps aux 2>/dev/null | grep '[p]im:' | wc -l | tr -d ' ')
      if [ "${_pim_count:-0}" -le 1 ] 2>/dev/null; then lsof -t -i :19223 | xargs kill 2>/dev/null; fi
      printf '\x1b[<u' 2>/dev/null
      # 排空 tty 输入队列里残留的 kitty 编码按键（用户在 TUI 还活着时按的键，
      # 协议已开 → 终端编码成 ^[[99;5:3u 之类排在队列里，agent 退出后会被父 shell
      # 读出来显示成垃圾。min 0 time 0 = 只取当前已排队的字节、绝不等待，不会吃用户
      # 之后的新输入）。ISSUE 102 附带。
      stty -icanon -echo min 0 time 0 2>/dev/null
      dd bs=64 count=1 2>/dev/null
      stty sane 2>/dev/null
    }
    trap cleanup EXIT
    if [ "$PAIMON_NO_INT_TRAP" != "1" ]; then
      trap 'cleanup; stty sane 2>/dev/null; exit 130' INT
    fi
    WAKEFILE="$RUNTIME_DIR/wake-restart"
    LAST_NONCE=$(cat "$WAKEFILE" 2>/dev/null)
    WOKE=""
    # 启动前解压
    node "$PAIMON_COMPRESS" decompress "$ID" 2>/dev/null
    SESSION_DIR="$PAIMON_HOME/SessionData/$ID"
    mkdir -p "$SESSION_DIR"
    # 迁移: 旧 sessions 目录如果有文件,移过来
    if [ -d "$MEMORY_DIR/$ID/sessions" ] && ls "$MEMORY_DIR/$ID/sessions"/*.jsonl >/dev/null 2>&1; then
      mv "$MEMORY_DIR/$ID/sessions"/*.jsonl "$SESSION_DIR/" 2>/dev/null
    fi
    # setsid: 在新 session 运行 bun，彻底断开控制终端（/dev/tty 不可达）
    # nohup+</dev/null 只断 fd 0/1/2，bun 仍可 open("/dev/tty") 干扰 kitty protocol
    _bun_detached() { perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- bun "$@"; }
    # [云同步已废弃 2026-09-05，PROPOSAL 036 替代] agent 单机存活，不做跨机状态同步。
    # 本段（agent 启动抢锁）与 lock 注释块代码保留不删，恢复参考 036（publish/install + 跨设备 social）。
    PAIMON_SYNC="$PAIMON_CLI/autosync.ts"
    if [ -f "$PAIMON_SYNC" ]; then
      # -- 云同步 lock 段已禁用（2026-08-18，无法正常工作，保留代码待研究）--
      # # 1. 获取 agent 锁（5s 超时，防止多设备同时运行同一 agent）
      # LOCK_TMP="$RUNTIME_DIR/.lock-out"
      # bun "$PAIMON_SYNC" lock "$ID" --quiet >"$LOCK_TMP" 2>&1 &
      # LOCK_PID=$!
      # ( sleep 5; kill $LOCK_PID 2>/dev/null ) </dev/null >/dev/null 2>&1 &
      # wait $LOCK_PID 2>/dev/null
      # LOCK_EXIT=$?
      # LOCK_OUT=$(cat "$LOCK_TMP" 2>/dev/null)
      # rm -f "$LOCK_TMP"
      # if [ "$LOCK_EXIT" = "2" ]; then
      #   HOLDER=$(echo "$LOCK_OUT" | grep -o 'LOCKED_BY:.*' | cut -d: -f2-)
      #   echo "$(_l "  agent 已被设备 [$HOLDER] 占用。强制启动？[y/N]" "  agent is locked by device [$HOLDER]. Force start? [y/N]")"
      #   read -r FORCE
      #   if [ "$FORCE" != "y" ] && [ "$FORCE" != "Y" ]; then exit 1; fi
      #   # 强抢：再试一次（5s超时）
      #   bun "$PAIMON_SYNC" lock "$ID" --quiet >/dev/null 2>&1 & FPID=$!; ( sleep 5; kill $FPID 2>/dev/null ) </dev/null >/dev/null 2>&1 & wait $FPID 2>/dev/null || true
      # elif [ "$LOCK_EXIT" != "0" ] && [ "$LOCK_EXIT" != "" ]; then
      #   echo "$(_l "  获取锁失败，继续启动（离线模式）" "  failed to acquire lock, continuing (offline mode)")"
      # fi
      # 2. 版本检查（后台，最多2秒）
      VER_CHECK_FILE="$RUNTIME_DIR/.ver-check"
      rm -f "$VER_CHECK_FILE"
      (
        VF="$PAIMON_HOME/agent/version.json"
        [ -f "$VF" ] || exit 0
        CH=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$VF','utf8')).channel||'minutely')}catch{console.log('minutely')}" 2>/dev/null)
        [ "$CH" = "release" ] && exit 0
        SD="$HOME/.local/lib/teyvat/source"
        [ -d "$SD/.git" ] || SD="$PAIMON_EXT"
        RH=$(git -C "$SD" ls-remote origin main 2>/dev/null | cut -f1 | head -c8)
        LH=$(git -C "$SD" rev-parse HEAD 2>/dev/null | head -c8)
        if [ -n "$RH" ] && [ -n "$LH" ] && [ "$RH" != "$LH" ]; then
          echo "$RH:$LH" > "$VER_CHECK_FILE"
        fi
      ) </dev/null >/dev/null 2>&1 &
      VER_PID=$!
      ( sleep 2; kill $VER_PID 2>/dev/null ) </dev/null >/dev/null 2>&1 &
      wait $VER_PID 2>/dev/null
      if [ -f "$VER_CHECK_FILE" ]; then
        IFS=: read -r RH LH < "$VER_CHECK_FILE"
        echo "$(_l "  有新版本 (remote: $RH, local: $LH) — genshin update 更新" "  new version available (remote: $RH, local: $LH) — run genshin update")"
      fi
      rm -f "$VER_CHECK_FILE"
      fi
      # -- 云同步 push/pull/心跳段已废弃（2026-09-05，PROPOSAL 036：agent 单机存活 + 机间 social；代码保留不删）--
      # # 3. 先推后拉（后台，不阻塞启动）
      # SYNC_STARTUP_LOG="$RUNTIME_DIR/sync-startup.log"
      # ( _bun_detached "$PAIMON_SYNC" push 2>&1; _bun_detached "$PAIMON_SYNC" pull 2>&1 ) </dev/null > "$SYNC_STARTUP_LOG" 2>&1 &
      # echo "$(_l "  同步中（后台），tail -f $SYNC_STARTUP_LOG 查看" "  syncing (background), tail -f $SYNC_STARTUP_LOG")"
      # # 4. 每5分钟：心跳保活 + 推 + 拉（后台静默）
      # ( while true; do sleep 300; _bun_detached "$PAIMON_SYNC" heartbeat "$ID" --quiet </dev/null >/dev/null 2>&1; _bun_detached "$PAIMON_SYNC" push --quiet </dev/null >/dev/null 2>&1; _bun_detached "$PAIMON_SYNC" pull --quiet </dev/null >/dev/null 2>&1; done ) </dev/null >/dev/null 2>&1 &
      # SYNC_LOOP_PID=$!
    # 清屏到最上方，再启动 pi
    printf '\033[2J\033[H'
    # 迭代计数（2026-08-20）：第一次迭代 = 用户新启动（遇 detached → attach 转 TUI）；
    # 后续迭代 = agent /h 退出后 while 循环重启（遇 detached → headless 后台化）。
    LOOP_ITER=0
    while true; do
      LOOP_ITER=$((LOOP_ITER+1))
      # 2026-09-04：teyvat 专属 env keys（/c 维护的 API keys，如 OPENROUTER_API_KEY）——
      # launcher 常驻旧 shell 时用户新设的 key 进不来（env 启动时固定），每次迭代 source 保证 agent 进程拿到最新 key
      [ -f "$PAIMON_HOME/config/env-keys.sh" ] && . "$PAIMON_HOME/config/env-keys.sh"
      export PAIMON_AGENT_NAME="$NAME"
  export PAIMON_AGENT_ID="$ID"
      # 版本号导出（agent 启动时读取，检测版本变更）
      PAIMON_VER_FILE="$PAIMON_HOME/agent/version.json"
      if [ -f "$PAIMON_VER_FILE" ]; then
        PAIMON_VER=$(python3 -c "import json; v=json.load(open('$PAIMON_VER_FILE')); print(v.get('genshin','?'))" 2>/dev/null || echo "?")
      else
        PAIMON_VER="?"
      fi
      export PAIMON_CURRENT_VERSION="$PAIMON_VER"
      echo "$PAIMON_VER" > "$RUNTIME_DIR/.last-agent-version" 2>/dev/null
      # 检查 settings.json 的 blackboxEnabled 开关
      USE_BLACKBOX=0
      SETTINGS_FILE="$PAIMON_CONFIG/settings.json"
      if [ -f "$SETTINGS_FILE" ]; then
        BB_ENABLED=$(python3 -c "import json; s=json.load(open('$SETTINGS_FILE')); print('true' if s.get('blackboxEnabled') else 'false')" 2>/dev/null || echo "true")
        [ "$BB_ENABLED" = "true" ] && USE_BLACKBOX=1
      else
        USE_BLACKBOX=1
      fi
      __sync_dsk
      # ── self-reboot 渲染保留（2026-09-04，方案调整）：session 保持新建（用户定稿“就是要新的session”），
      # restart-session.json 由 interactive-mode.js 启动时读取，从旧 session 重放历史到新 session 的 TUI。
      # launcher 不再传 --session（旧方案已回滚）──
      # ── detach 模式（2026-08-20，PROPOSAL 034 阶段 4）：/detach 后 headless 重启 ──
      # TUI 进程写 RuntimeCache/<id>/detached 标记 + wake-restart nonce → 本 while 循环
      # 检测到 nonce 变化重启 → 读到 detached → 用 headless 模式（--mode rpc）继续：
      #   - fifo 输入管道（stdin 不能 /dev/null——rpc-mode 的 stdin EOF 即 shutdown 退出）
      #   - stdout/stderr → LogData/<id>/console.log
      #   - 同一 SESSION_DIR：session/记忆/意图栈延续，agent 不中断（续命/social/fifo 收消息）
      DETACHED=0
      [ -f "$RUNTIME_DIR/detached" ] && DETACHED=1
      SKIP_TUI=0
      if [ "$DETACHED" = "1" ]; then
        if [ "$PAIMON_HEADLESS_DAEMON" = "1" ]; then
          # 后台守护实例：headless node（rpc + fifo + 日志），while 循环继续监控（self-reboot full 等）
        FIFO="$PAIMON_HOME/AgentFileData/$ID/headless-in"
        mkdir -p "$PAIMON_HOME/AgentFileData/$ID" 2>/dev/null
        [ -p "$FIFO" ] || mkfifo "$FIFO" 2>/dev/null
        CONSOLE_LOG="$PAIMON_HOME/LogData/$ID/console.log"
        mkdir -p "$PAIMON_HOME/LogData/$ID" 2>/dev/null
        # 以 O_RDWR（<>）打开 fd 3：写端+读端同时打开立即成功（fifo 单开写端会阻塞等读端、
        # 单开读端会阻塞等写端——死锁！2026-08-20 实测踩坑）。fd 3 保持写端存活，
        # 外部 echo JSON > fifo 不阻塞；node 的 stdin（fifo 读端）也不会 EOF。
        exec 3<>"$FIFO"
        PI_ALIVE_RESTART_LOOP=1 PI_ALIVE_WOKE="$WOKE" node "$RUNTIME_CLI" $EXT_FLAGS --mode rpc --session-dir "$SESSION_DIR" "$@" < "$FIFO" >> "$CONSOLE_LOG" 2>&1
        exec 3>&-
        SKIP_TUI=1  # headless 守护：headless node 结束后不启动 TUI，直接走 NONCE 检查（while 循环）
        elif [ "$LOOP_ITER" = "1" ]; then
          # 用户新启动（第一次迭代）遇 detached：attach 语义——清标记 + 杀可能残留的 headless 进程 + 直接启动 TUI
          # （2026-08-20 用户实测：genshin xxx 想进前台却被转后台——用户意图是进前台，不是再转后台）
          # （2026-08-20 09:18 修复：原实现清完标记不启动 TUI、依赖 while 下一轮 → 下一轮启动失败 → attach 回 shell。
          #   现在清标记+杀残留后不 exit，SKIP_TUI=0 落到下方 TUI 启动段。）
          echo "$(_l "检测到后台模式标记，已清除，启动前台 TUI…" "Background mark found, cleared. Starting foreground TUI…")"
          rm -f "$RUNTIME_DIR/detached" 2>/dev/null
          OLDNODE=$(ps aux 2>/dev/null | grep "genshin:.*$ID" | grep -v grep | awk '{print $2}' | head -1)
          if [ -n "$OLDNODE" ]; then kill -TERM -- "-$OLDNODE" 2>/dev/null || kill -TERM "$OLDNODE" 2>/dev/null; sleep 1; kill -0 "$OLDNODE" 2>/dev/null && kill -9 "$OLDNODE" 2>/dev/null; fi
          # 不 exit——SKIP_TUI=0 落到下方 TUI 启动段
        else
          # while 循环重启（agent /h 退出后，后续迭代）：headless 后台化——perl POSIX setsid 启动守护实例
          # （macOS 无 setsid 命令，必须用 perl POSIX::setsid——2026-08-20 实测：setsid bash 直接失败导致守护没起来），
          # 本 launcher 退出 → 终端释放回 shell（2026-08-20 用户：/h 后应回到命令行，不能占着终端）。
          echo "$(_l "已转入后台运行（headless）。agent 继续工作，终端已释放。" "Moved to background (headless). Agent keeps working, terminal released.")"
          rm -rf "$LOCKDIR" 2>/dev/null
          rm -f "$PIDFILE" 2>/dev/null
          PAIMON_HEADLESS_DAEMON=1 perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- bash "$_snap" "${ORIG[@]}" >/dev/null 2>&1 &
          exit 0
        fi
      fi
      # ── TUI 启动段（2026-08-20 09:18 修复：从 elif 链提出为独立段，受 SKIP_TUI 控制——
      #    attach（LOOP_ITER=1 清标记后）SKIP_TUI=0 直接启动 TUI，不再依赖 while 下一轮；
      #    headless 守护 SKIP_TUI=1 跳过，走 NONCE 检查）──
      if [ "${SKIP_TUI:-0}" = "0" ]; then
        if [ -x "$BLACKBOX" ] && [ "$USE_BLACKBOX" = "1" ]; then
          PI_ALIVE_RESTART_LOOP=1 PI_ALIVE_WOKE="$WOKE" "$BLACKBOX" "$ID" "${NAME:-unknown}" "main" -- node "$RUNTIME_CLI" $EXT_FLAGS --session-dir "$SESSION_DIR" "$@"
        else
          # 黑匣子开关不连坐器官:PAIMON_NO_MC=1 是 0713 事故(sc spawn 递归风暴)的临时止血,
          # 根因已在 dev.20260715.1 修复。手动调试禁用器官请自行 export PAIMON_NO_MC=1。
          PI_ALIVE_RESTART_LOOP=1 PI_ALIVE_WOKE="$WOKE" node "$RUNTIME_CLI" $EXT_FLAGS --session-dir "$SESSION_DIR" "$@"
        fi
      fi
      NONCE=$(cat "$WAKEFILE" 2>/dev/null)
      if [ -n "$NONCE" ] && [ "$NONCE" != "$LAST_NONCE" ]; then
        LAST_NONCE="$NONCE"; WOKE=1
        # ── 完整重启（2026-08-20，用户指示）：self-reboot full —— launcher 也刷新 ──
        # agent 写 RuntimeCache/<id>/full-restart 标记 → 这里重新快照源码 + 清锁 + exec 自身（新 inode），
        # 这样 launcher.sh 的新改动（如 /h 的 headless 分支）在完整重启后生效；
        # 普通 self-reboot（无标记）仍走旧逻辑（不换 launcher，快）。
        if [ -f "$RUNTIME_DIR/full-restart" ]; then
          rm -f "$RUNTIME_DIR/full-restart"
          SRC="$PAIMON_CLI/launcher.sh"
          if [ -f "$SRC" ] && [ "$SRC" != "$_snap" ]; then
            _tmp="${_snap}.tmp.$$"
            cat "$SRC" > "$_tmp" 2>/dev/null && bash -n "$_tmp" 2>/dev/null && mv "$_tmp" "$_snap"
          fi
          # agent 已退出，锁/pid 还在 → 清掉，否则 exec 后新 launcher 报"已有 Session"
          rm -rf "$LOCKDIR" 2>/dev/null
          rm -f "$PIDFILE" 2>/dev/null
          exec bash "$_snap" "${ORIG[@]}"
        fi
        continue
      fi
      break
    done
    # 退出后同步段已废弃（2026-09-05，PROPOSAL 036：agent 单机存活；代码保留不删）——以下注释
    # kill $SYNC_LOOP_PID 2>/dev/null; wait $SYNC_LOOP_PID 2>/dev/null
    # if [ -f "$PAIMON_SYNC" ]; then
    #   ( _bun_detached "$PAIMON_SYNC" unlock "$ID" --quiet 2>&1; _bun_detached "$PAIMON_SYNC" push --quiet 2>&1; _bun_detached "$PAIMON_SYNC" pull --quiet 2>&1 ) </dev/null >/dev/null 2>&1 &
    #   SPID=$!; ( sleep 5; kill $SPID 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    # fi
    ;;
esac
