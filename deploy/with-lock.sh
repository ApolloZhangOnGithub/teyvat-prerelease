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
set -u

LOCK_DIR="${MAKE_LOCK_DIR:?MAKE_LOCK_DIR required}"
STALE_AFTER="${MAKE_LOCK_STALE:-1800}"   # 超过 30 分钟视为死锁（被 kill -9 的残留）
STAMP="$LOCK_DIR/started"

[ "$#" -gt 0 ] || { echo "  ERROR: with-lock.sh 需要一条命令"; exit 1; }

_now() { date +%s; }

_try_lock() { mkdir "$LOCK_DIR" 2>/dev/null; }

_lock_age() {
  local s
  s=$(cat "$STAMP" 2>/dev/null) || return 1
  case "$s" in ''|*[!0-9]*) return 1;; esac
  echo $(( $(_now) - s ))
}

if ! _try_lock; then
  AGE=$(_lock_age || echo "")
  if [ -n "$AGE" ] && [ "$AGE" -gt "$STALE_AFTER" ]; then
    echo "  $(date +%H:%M:%S) 发现死锁（已持有 ${AGE}s > ${STALE_AFTER}s），接管"
    rm -f "$STAMP" 2>/dev/null
    rmdir "$LOCK_DIR" 2>/dev/null
    _try_lock || { echo "  ERROR: 无法接管死锁 $LOCK_DIR"; exit 1; }
  else
    echo "  $(date +%H:%M:%S) 另一个 make 正在运行${AGE:+（已 ${AGE}s）}，等待中..."
    WAITED=0
    until _try_lock; do
      sleep 2
      WAITED=$(( WAITED + 2 ))
      AGE=$(_lock_age || echo "")
      if [ -n "$AGE" ] && [ "$AGE" -gt "$STALE_AFTER" ]; then
        echo "  $(date +%H:%M:%S) 等待中发现死锁（${AGE}s），接管"
        rm -f "$STAMP" 2>/dev/null
        rmdir "$LOCK_DIR" 2>/dev/null
      fi
    done
    echo "  $(date +%H:%M:%S) 已获得锁（等待 ${WAITED}s），开始构建"
  fi
fi

_now > "$STAMP"

_release() { rm -f "$STAMP" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null; }

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
