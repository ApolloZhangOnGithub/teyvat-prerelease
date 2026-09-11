#!/bin/bash
# with-lock.sh — 串行化构建，防止并发 make 互相破坏。
# 用法: MAKE_LOCK_DIR=<dir> bash with-lock.sh <命令...>
#
# ── 为什么需要这个脚本（2026-07-29）──────────────────────────────────────────
# Makefile 里「就地加锁」是错的，因为 make 的每个 recipe 行都在独立 shell 里执行：
#
#     dev-minutely: _integrity          ← ① 依赖在锁之前就跑完了
#         @LOCK=...; mkdir "$LOCK"; trap 'rmdir "$LOCK"' EXIT; echo ok
#         @REL_VER=...  ← ② 新 shell。上一行的 trap 早已触发，锁在这里已经没了
#
# 实测：行①结束时锁存在，行②开始时锁已消失 —— 旧的 .make-lock 从未保护过任何东西。
# 症状是并发 make 时，install.sh 的 `rsync --delete` 先把 dist 恢复成原版（删掉
# debug.js 等补丁文件），要到脚本末尾才重建；另一个 make 的 extension load check
# 撞进这个窗口，就会报 "Cannot find module .../dist/debug.js" 这类假故障。
#
# 解法：把整条命令（含 _integrity）跑在同一个进程里，trap 覆盖全程。
#
# ── 2026-09-11 加 owner 存活检测（prime-agent 现场取证后改）──────────────────
# 实证：18:26:56 第 .25 次 dev-minutely 正常结束；18:27:25 下一次刚拿到锁就被
# kill -9（SIGKILL 不触发 trap，锁不会释放），锁目录里只剩一个 started 文件。
# 三个等待者（18:31:33 / 18:39:21 / 18:45:54 启动）只能按 STALE_AFTER=1800 干等，
# 等到 18:57:25 才有人接管 —— 整条流水线白停 30 分钟；而且这 30 分钟里
# 「锁被死进程占着」和「构建正常进行中」在现象上完全一样，看不出来。
#
# 修法：锁里记 owner 的 pid，接管条件从「时间到」改成「owner 不在了 → 立刻接管」。
# 时间只留作兜底：旧格式锁（只有 started、没有 pid）和「锁目录在但没有任何 owner
# 文件」两种情况仍按 STALE_AFTER 判，否则会把刚 mkdir 完、还没来得及写文件的活人
# 踢掉。兜底用锁目录 mtime 推算，避免「目录在、文件没了」时永远等下去。
# pid 会被系统复用，所以 ps 复核该 pid 现在跑的确实是 with-lock.sh 才算活着。
#
# 教训（2026-09-11 19:00 沙箱实测）：必须区分「活 owner」和「不知道 owner 死活」。
# 第一版把两者一起丢进 STALE 兜底，结果活着的 owner 一旦超过阈值就被抢 —— 沙箱里
# 真的出现两个构建同时跑（overlap=1）。现在：alive 一律不抢，只有 unknown 才按时间兜底。
set -u

LOCK_DIR="${MAKE_LOCK_DIR:?MAKE_LOCK_DIR required}"
STALE_AFTER="${MAKE_LOCK_STALE:-1800}"   # 兜底阈值（秒），只在拿不到 owner 存活信息时使用
STAMP="$LOCK_DIR/started"
PIDFILE="$LOCK_DIR/pid"

[ "$#" -gt 0 ] || { echo "  ERROR: with-lock.sh 需要一条命令"; exit 1; }

_now() { date +%s; }

# 写 owner 信息：先写临时文件再 mv，避免别人读到半个 pid
_write_owner() {
  printf '%s\n' "$$" > "$LOCK_DIR/.pid.$$" 2>/dev/null || return 0
  mv "$LOCK_DIR/.pid.$$" "$PIDFILE" 2>/dev/null
  _now > "$STAMP" 2>/dev/null
  return 0
}

# 拿锁：mkdir 是唯一的原子判据；拿到后复核 pid 文件确实还是自己的
# （防「mkdir 成功」与「写 owner」之间被兜底逻辑清掉后仍以为自己持锁）
_try_lock() {
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  _write_owner
  [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ] || return 1
  return 0
}

_owner_pid() {
  local p
  p=$(cat "$PIDFILE" 2>/dev/null) || p=""
  case "$p" in ''|*[!0-9]*) return 1;; esac
  printf '%s' "$p"
}

# owner 状态：alive / dead / unknown
#   alive   = 记录在案的 pid 存在，且该 pid 现在跑的确实是 with-lock.sh
#   dead    = 有 pid 记录，但那个进程已经没了（pid 被复用去跑别的程序也算没了）
#   unknown = 没有 pid 记录（旧格式锁，或刚 mkdir 完还没写文件）
_owner_state() {
  local p cmd
  p=$(_owner_pid) || { echo unknown; return 0; }
  kill -0 "$p" 2>/dev/null || { echo dead; return 0; }
  cmd=$(ps -p "$p" -o command= 2>/dev/null) || { echo dead; return 0; }
  case "$cmd" in *with-lock.sh*) echo alive ;; *) echo dead ;; esac
}

_owner_alive() { [ "$(_owner_state)" = alive ]; }

_lock_age() {
  local s
  s=$(cat "$STAMP" 2>/dev/null) || return 1
  case "$s" in ''|*[!0-9]*) return 1;; esac
  echo $(( $(_now) - s ))
}

# stamp 缺失时的兜底：用锁目录 mtime 推算（目录在、文件没了也能等到超时）
_dir_age() {
  local m
  m=$(stat -f %m "$LOCK_DIR" 2>/dev/null) || return 1
  case "$m" in ''|*[!0-9]*) return 1;; esac
  echo $(( $(_now) - m ))
}

_age() { _lock_age || _dir_age; }

# 等待日志用的一句话说明：现在是谁在持有，还是已经没人了
_wait_msg() {
  local st p age
  st=$(_owner_state); p=$(_owner_pid || echo 未知); age=$(_age || echo "")
  case "$st" in
    alive) printf '另一个 make 正在运行（pid %s，已 %ss）' "$p" "${age:-?}" ;;
    dead)  printf '锁的 owner 已经不在了（pid %s，锁龄 %ss）' "$p" "${age:-?}" ;;
    *)     printf '无法确认 owner（无 pid 文件，锁龄 %ss）' "${age:-?}" ;;
  esac
}

# 该不该接管：有理由就打印理由并返回 0
#   owner 死了            → 立刻接管（2026-09-11 那次 30 分钟空等的修法）
#   owner 状态未知 + 超时 → 兜底接管（旧格式锁；不这样会永远等下去）
#   owner 活着 + 超时     → 不接管，只告警（抢占活进程正是本锁要防的事）
# 注意：字符串里 $var 后面紧跟中文/全角字符时必须写成 ${var}。
# bash 会把多字节字符当成变量名的一部分，配 set -u 直接 "unbound variable" 崩掉（2026-09-11 实测）。
_takeover_reason() {
  local st age p
  st=$(_owner_state); age=$(_age || echo ""); p=$(_owner_pid || echo 未知)
  case "$st" in
    dead) echo "owner 进程已消失（pid ${p}，锁龄 ${age:-?}s）"; return 0 ;;
    unknown)
      # 只有「根本不知道 owner 是死是活」时才允许按时间兜底
      if [ -n "$age" ] && [ "$age" -gt "$STALE_AFTER" ]; then
        echo "无 owner 存活信息（旧格式锁/缺 pid 文件）且锁龄 ${age}s > ${STALE_AFTER}s"; return 0
      fi
      return 1 ;;
    *)    return 1 ;;   # alive：活着的 owner 永远不抢（哪怕它跑了很久）
  esac
}

# 清掉死掉的锁。rmdir 非空会失败：那说明已经有人重新建了锁并写了 owner，
# 此时什么都不做，交回等待循环，不会出现两个 owner。
_take_over() {
  rm -f "$STAMP" "$PIDFILE" 2>/dev/null
  rmdir "$LOCK_DIR" 2>/dev/null
}

if ! _try_lock; then
  echo "  $(date +%H:%M:%S) $(_wait_msg)，等待中..."
  REASON=$(_takeover_reason)
  if [ -n "$REASON" ]; then
    echo "  $(date +%H:%M:%S) 立刻接管：$REASON"
    _take_over
  fi
  WAITED=0
  WARNED=0
  until _try_lock; do
    sleep 2
    WAITED=$(( WAITED + 2 ))
    REASON=$(_takeover_reason)
    AGE=$(_age || echo "")
    if [ -n "$REASON" ]; then
      echo "  $(date +%H:%M:%S) 等待 ${WAITED}s 后接管：$REASON"
      _take_over
    elif _owner_alive && [ -n "$AGE" ] && [ "$AGE" -gt "$STALE_AFTER" ] && [ "$WARNED" = 0 ]; then
      echo "  $(date +%H:%M:%S) owner 仍在运行但这次构建已 ${AGE}s（> ${STALE_AFTER}s）——不抢占，继续等（抢活进程正是本锁要防的事）"
      WARNED=1
    fi
  done
  echo "  $(date +%H:%M:%S) 已获得锁（等待 ${WAITED}s），开始构建"
fi

_now > "$STAMP"

_release() { rm -f "$STAMP" "$PIDFILE" "$LOCK_DIR/.pid.$$" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null; }

# 子命令必须放后台再 wait：bash 在等【前台】子进程时会推迟 trap，
# Ctrl-C / kill 要等子进程自己结束才被处理 —— 锁会一直被占着，子进程也杀不掉。
# 放后台后 wait 可被信号立即打断，才能既收子进程又释放锁。
"$@" &
CHILD=$!

_on_signal() {
  echo "  $(date +%H:%M:%S) 收到中断，正在停止构建..."
  kill -TERM "$CHILD" 2>/dev/null
  wait "$CHILD" 2>/dev/null
  _release
  exit 130
}
trap _on_signal INT TERM
trap _release EXIT

wait "$CHILD"
exit $?
