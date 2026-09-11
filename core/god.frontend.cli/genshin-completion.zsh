# genshin 命令 zsh 补全。
# 安装位置: ~/.teyvat/agent/config/genshin-completion.zsh（由 C.deploy/install.sh 第 6 段部署）
# 在 ~/.zshrc 里:  source "$HOME/.teyvat/agent/config/genshin-completion.zsh" 2>/dev/null
# 需要 compinit 已初始化（zsh 默认: autoload -Uz compinit; compinit）
#
# 2026-09-11（prime-agent）：本文件是**恢复**的 —— 目录重构（Codebase/core/god.cli/ → god.frontend.cli/）时
# 补全脚本没被带过来，于是 install.sh 每次构建都 warn「completion 源文件缺失，跳过（未改动 shell rc）」，
# 而 ~/.zshrc 里那条 source 行指向一个不存在的文件（被 2>/dev/null 掩盖）。此处按当前 CLI 对齐重写。
_genshin_names() {  # $1=all|active|archived
  local plist="$HOME/.teyvat/MemoryData/plist.json"
  [[ -f "$plist" ]] || return 0
  node -e "
    try {
      const list = JSON.parse(require('fs').readFileSync('$plist', 'utf8'));
      const mode = '$1';
      list.filter(p => mode === 'all' || (mode === 'active' ? !p.archived : p.archived))
          .forEach(p => console.log(p.name));
    } catch (e) {}
  " 2>/dev/null
}

_genshin_comp() {
  local -a active archived subs flags
  active=($(_genshin_names active))
  archived=($(_genshin_names archived))
  subs=(list archived config org archive unarchive note rename clone doctor login logout unbind whoami mc hc kill tmux mobile sync update uninstall sessions web version)
  flags=(--archived --help)

  # 第一个位置参数：子命令 + agent 名（两者的补集才是好体验）
  if (( CURRENT == 2 )); then
    compadd -a subs
    compadd -a active
    return
  fi
  # 之后按前一个词决定补什么
  case "${words[CURRENT-1]}" in
    --unarchive|unarchive) compadd -a archived ;;
    archive|--archive|rename|clone|note|n|org|mc|hc|kill|tmux|mobile) compadd -a active ;;
    *) compadd -a active; compadd -a flags ;;
  esac
}
compdef _genshin_comp genshin
