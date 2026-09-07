#!/usr/bin/env python3
"""claude-code-bridge — Teyvat ↔ Claude Code 跨框架通信桥接 daemon

从 cnb 项目借鉴 tmux load-buffer + paste-buffer 注入模式。
启动: python3 claude-code-bridge.py --tmux-session <session> [--sid cc000001]

功能:
  1. 维持 SocialData/heartbeat/<sid> 心跳（60s 周期，isAgentActive bridge fallback）
  2. watch SocialData/inbox/<sid>.jsonl 新消息
  3. 新消息到达时，通过 tmux 注入到 Claude Code session
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SOCIAL_DIR = Path.home() / ".teyvat" / "SocialData"
HEARTBEAT_DIR = SOCIAL_DIR / "heartbeat"
INBOX_DIR = SOCIAL_DIR / "inbox"
TRIGGERS_DIR = SOCIAL_DIR / "triggers"
TMUX_TIMEOUT = 8
HEARTBEAT_INTERVAL = 60
POLL_INTERVAL = 2


def tmux_send(sess: str, text: str) -> bool:
    """cnb 模式: load-buffer + paste-buffer（比 send-keys 安全，不怕特殊字符）"""
    try:
        buf_name = f"ccbridge-{os.getpid()}"
        subprocess.run(
            ["tmux", "load-buffer", "-b", buf_name, "-"],
            input=text, text=True, timeout=TMUX_TIMEOUT, check=True,
        )
        subprocess.run(
            ["tmux", "paste-buffer", "-d", "-p", "-r", "-b", buf_name, "-t", sess],
            timeout=TMUX_TIMEOUT, check=True,
        )
        subprocess.run(
            ["tmux", "send-keys", "-t", sess, "Enter"],
            timeout=TMUX_TIMEOUT, check=True,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False


def has_session(sess: str) -> bool:
    try:
        r = subprocess.run(
            ["tmux", "has-session", "-t", sess],
            capture_output=True, timeout=TMUX_TIMEOUT,
        )
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def capture_pane(sess: str, lines: int = 10) -> str:
    try:
        r = subprocess.run(
            ["tmux", "capture-pane", "-t", sess, "-p", "-S", str(-lines)],
            capture_output=True, text=True, timeout=TMUX_TIMEOUT,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, OSError):
        return ""


def is_idle(sess: str) -> bool:
    """Claude Code 空闲判定（借鉴 cnb _is_idle）"""
    text = capture_pane(sess)
    if not text:
        return False
    busy = ("Thinking", "Running", "Editing", "Reading", "ctrl+b", "streaming")
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        if any(b.lower() in stripped.lower() for b in busy):
            return False
        if "❯" in stripped or ">" in stripped:
            return True
        break
    return "❯" in text


def touch_heartbeat(sid: str):
    HEARTBEAT_DIR.mkdir(parents=True, exist_ok=True)
    hb_file = HEARTBEAT_DIR / sid
    hb_file.write_text(json.dumps({"ts": int(time.time() * 1000), "pid": os.getpid()}))


def read_new_messages(sid: str, last_count: int) -> tuple[list[dict], int]:
    """按行数游标取新消息，不改文件（避免 read-modify-write 竞态丢消息）"""
    inbox_file = INBOX_DIR / f"{sid}.jsonl"
    if not inbox_file.exists():
        return [], 0
    lines = inbox_file.read_text().strip().split("\n")
    lines = [l for l in lines if l.strip()]
    total = len(lines)
    if total <= last_count:
        return [], total
    new_msgs = []
    for line in lines[last_count:]:
        try:
            new_msgs.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return new_msgs, total


def format_message(msg: dict) -> str:
    from_name = msg.get("from_name", msg.get("from", "unknown"))
    text = msg.get("text", "")
    mode = msg.get("mode_used", msg.get("mode", ""))
    ts = msg.get("ts", 0)
    if ts:
        from datetime import datetime
        t = datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
    else:
        t = time.strftime("%H:%M:%S")
    return f"[{t} 来自 Teyvat agent {from_name} ({mode})]: {text}"



# mark_injected 已移除（dev-01 review：read-modify-write 全文件重写 = 竞态丢消息。
# 行数游标 last_count 已保证不重复处理，不需要改文件。）


def main():
    parser = argparse.ArgumentParser(description="Teyvat ↔ Claude Code bridge daemon")
    parser.add_argument("--tmux-session", required=True, help="Claude Code 的 tmux session 名称")
    parser.add_argument("--sid", default="cc000001", help="bridge 的 Teyvat sid (默认 cc000001)")
    parser.add_argument("--wait-idle", action="store_true", help="忙时等待空闲再注入（默认立即注入）")
    args = parser.parse_args()

    sid = args.sid
    tmux_sess = args.tmux_session

    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    inbox_file = INBOX_DIR / f"{sid}.jsonl"
    inbox_file.touch()

    print(f"[bridge] 启动: sid={sid}, tmux={tmux_sess}")
    print(f"[bridge] 心跳: {HEARTBEAT_DIR / sid}")
    print(f"[bridge] 收件: {inbox_file}")

    if not has_session(tmux_sess):
        print(f"[bridge] ERROR: tmux session '{tmux_sess}' 不存在")
        sys.exit(1)

    touch_heartbeat(sid)
    print(f"[bridge] 心跳已写入")

    last_count = len(inbox_file.read_text().strip().split("\n")) if inbox_file.read_text().strip() else 0
    last_heartbeat = time.time()

    print(f"[bridge] 跳过已有 {last_count} 条消息，开始监听...")
    print(f"[bridge] Ctrl+C 退出")

    try:
        while True:
            if time.time() - last_heartbeat >= HEARTBEAT_INTERVAL:
                touch_heartbeat(sid)
                last_heartbeat = time.time()

            if not has_session(tmux_sess):
                print(f"[bridge] tmux session '{tmux_sess}' 已断开，退出")
                break

            new_msgs, new_count = read_new_messages(sid, last_count)
            if new_msgs:
                for msg in new_msgs:
                    from_name = msg.get("from_name", "?")
                    mode = msg.get("mode_used", "?")
                    print(f"[bridge] 收到消息: {from_name} [{mode}]")

                    if args.wait_idle:
                        retries = 0
                        while not is_idle(tmux_sess) and retries < 30:
                            time.sleep(2)
                            retries += 1
                        if retries >= 30:
                            print(f"[bridge] 等待空闲超时，强制注入")

                    formatted = format_message(msg)
                    if tmux_send(tmux_sess, formatted):
                        print(f"[bridge] 已注入到 {tmux_sess}")
                    else:
                        print(f"[bridge] 注入失败")

                last_count = new_count

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        print(f"\n[bridge] 收到 Ctrl+C，退出")
    finally:
        hb_file = HEARTBEAT_DIR / sid
        if hb_file.exists():
            hb_file.unlink()
            print(f"[bridge] 心跳已清理")


if __name__ == "__main__":
    main()
