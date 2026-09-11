#!/bin/bash
# test-with-lock.sh — with-lock.sh 的回归用例（沙箱跑，不碰真实构建）
# 用法: bash C.deploy/test-with-lock.sh        （测的就是同目录的 with-lock.sh）
# 来历: 2026-09-11 孤儿锁事故后写的（见 B.docs/Dev.Common/Experiences/011-*.EXPERIENCE）
# 覆盖: 串行化 / 持有者被 kill -9 立刻接管 / 等待者首轮接管 / 旧格式锁按阈值兜底 /
#       空锁目录不永久死等 / pid 复用 / 活 owner 超阈值不被抢
T=/tmp/teyvat-lock-test
NEW="$(cd "$(dirname "$0")" && pwd)/with-lock.sh"
rm -rf "$T"; mkdir -p "$T"
cat > "$T/fakebuild.sh" <<'EOF'
#!/bin/bash
echo "START $1 $(date +%s)" >> /tmp/teyvat-lock-test/build.log
sleep "$2"
echo "END   $1 $(date +%s)" >> /tmp/teyvat-lock-test/build.log
EOF
chmod +x "$T/fakebuild.sh"

overlaps() {
python3 - <<'PY'
ts=[]
for line in open('/tmp/teyvat-lock-test/build.log'):
    p=line.split()
    if len(p)>=3 and p[0] in ('START','END'):
        ts.append((int(p[2]), 1 if p[0]=='START' else -1, p[1]))
ts.sort(); cur=0; bad=0; det=[]
for t,d,tag in ts:
    cur+=d
    if cur>1: bad+=1; det.append(f"{t}:{tag}")
print(f"  OVERLAP_EVENTS {bad} {' '.join(det[:5])}")
PY
}
wait_start() { # $1=tag $2=秒上限  → 打印接管理耗时或未启动
  local tag="$1" lim="${2:-40}" t0 t1 i
  t0=$(date +%s)
  for i in $(seq $(( lim * 4 ))); do
    if grep -q "START $tag" "$T/build.log" 2>/dev/null; then
      t1=$(grep -m1 "START $tag" "$T/build.log" | awk '{print $3}')
      echo "  接管理耗时: $(( t1 - t0 ))s"; return 0
    fi
    sleep 0.25
  done
  echo "  ${lim}s 内未拿到锁"; return 1
}

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "被测脚本: $NEW"
echo
echo "===== T1 串行化：3 个并发（STALE=5）====="
: > "$T/build.log"
L="$T/t1.lock"
for i in 1 2 3; do MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=5 bash "$NEW" bash "$T/fakebuild.sh" "t1-$i" 2 >"$T/t1-$i.out" 2>&1 & done
wait
echo "  started=$(grep -c START "$T/build.log") ended=$(grep -c END "$T/build.log")"; overlaps

echo
echo "===== T2a 持有者被 kill -9（等待者已在等）→ 应立刻接管 ====="
L="$T/t2a.lock"; rm -rf "$L"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=1800 bash "$NEW" bash "$T/fakebuild.sh" t2a-holder 30 >"$T/t2a-holder.out" 2>&1 & H=$!
for i in $(seq 40); do [ -f "$L/pid" ] && break; sleep 0.1; done
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=1800 bash "$NEW" bash "$T/fakebuild.sh" t2a-waiter 1 >"$T/t2a-waiter.out" 2>&1 & W=$!
sleep 1.5
echo "  锁内容（kill 前）: $(ls -A "$L" | tr '\n' ' ')"
kill -9 "$H" 2>/dev/null; pkill -f "fakebuild.sh t2a-holder" 2>/dev/null
echo "  锁内容（kill 后）: $(ls -A "$L" 2>/dev/null | tr '\n' ' ')  ← pid 文件还在（SIGKILL 不触发 trap）"
wait_start t2a-waiter 30
wait "$W" 2>/dev/null; sed 's/^/    /' "$T/t2a-waiter.out"
echo "  (STALE=1800 秒；旧脚本在这里要等 1800s)"

echo
echo "===== T2b 等待者启动时 owner 已经死了 → 应立刻接管（首轮检查路径）====="
L="$T/t2b.lock"; rm -rf "$L"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=1800 bash "$NEW" bash "$T/fakebuild.sh" t2b-holder 30 >"$T/t2b-holder.out" 2>&1 & H=$!
for i in $(seq 40); do [ -f "$L/pid" ] && break; sleep 0.1; done
kill -9 "$H" 2>/dev/null; pkill -f "fakebuild.sh t2b-holder" 2>/dev/null; sleep 0.3
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=1800 bash "$NEW" bash "$T/fakebuild.sh" t2b-waiter 1 >"$T/t2b-waiter.out" 2>&1 & W=$!
wait_start t2b-waiter 20
wait "$W" 2>/dev/null; sed 's/^/    /' "$T/t2b-waiter.out"

echo
echo "===== T3 旧格式锁（只有 started，没 pid）+ 未过期 → 不许抢；过期后兜底接管 ====="
L="$T/t3.lock"; rm -rf "$L"; mkdir -p "$L"; date +%s > "$L/started"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=10 bash "$NEW" bash "$T/fakebuild.sh" t3-waiter 1 >"$T/t3.out" 2>&1 & W=$!
wait_start t3-waiter 25   # 期望 ~10-14s（兜底阈值），不是 0s
wait "$W" 2>/dev/null; sed 's/^/    /' "$T/t3.out"

echo
echo "===== T4 锁目录在、里面一个文件都没有 → 不许永久死等（mtime 兜底）====="
L="$T/t4.lock"; rm -rf "$L"; mkdir -p "$L"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=6 bash "$NEW" bash "$T/fakebuild.sh" t4-waiter 1 >"$T/t4.out" 2>&1 & W=$!
wait_start t4-waiter 25   # 期望 ~6-10s
wait "$W" 2>/dev/null; sed 's/^/    /' "$T/t4.out"

echo
echo "===== T5 pid 被复用（活进程但不是 with-lock.sh）→ 应立刻接管 ====="
L="$T/t5.lock"; rm -rf "$L"; mkdir -p "$L"; date +%s > "$L/started"
sleep 300 & FAKE=$!; echo "$FAKE" > "$L/pid"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=1800 bash "$NEW" bash "$T/fakebuild.sh" t5-waiter 1 >"$T/t5.out" 2>&1 & W=$!
wait_start t5-waiter 20
kill -9 $FAKE 2>/dev/null; wait "$W" 2>/dev/null; sed 's/^/    /' "$T/t5.out"

echo
echo "===== T6 owner 活着但构建很久（STALE=4、构建 20s）→ 不许抢占活进程 ====="
L="$T/t6.lock"; rm -rf "$L"; : > "$T/build.log"
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=4 bash "$NEW" bash "$T/fakebuild.sh" t6-holder 20 >"$T/t6-holder.out" 2>&1 & H=$!
for i in $(seq 40); do [ -f "$L/pid" ] && break; sleep 0.1; done
MAKE_LOCK_DIR="$L" MAKE_LOCK_STALE=4 bash "$NEW" bash "$T/fakebuild.sh" t6-waiter 1 >"$T/t6-waiter.out" 2>&1 & W=$!
sleep 12
if grep -q "START t6-waiter" "$T/build.log" 2>/dev/null; then
  echo "  FAIL: 12s 内抢了活进程的锁（并发构建风险）"
else
  echo "  OK: 12s 内没有抢占（活 owner 只是被告警），等它跑完"
fi
wait "$W" 2>/dev/null
overlaps
echo "  --- waiter 日志 ---"; sed 's/^/    /' "$T/t6-waiter.out"

echo
echo "===== 结束 ====="
