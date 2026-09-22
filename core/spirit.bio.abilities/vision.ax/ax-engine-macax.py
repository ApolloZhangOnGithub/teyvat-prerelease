"""vision.ax macAX 引擎 —— 读 macOS 辅助功能（AX）树（由 ax.ts 调用）

与 ocr-engine-macvision.py 同构（同目录模式：py 引擎本体带 engine 词、ts 封装不带——NORM 001）。
差异：OCR 读**像素**（任何图片），本引擎读**活 app 的 UI 元素树**（精确文本 + 结构 + 可交互信息）。

用法：
  python3 ax-engine-macax.py --list                              # 列出运行中的 app（name/pid/bundle）
  python3 ax-engine-macax.py --app Safari --mode text            # 该 app 的全部文本（按树序，去重）
  python3 ax-engine-macax.py --app Safari --mode tree --max 200  # 结构树（角色/标题/值，带缩进深度）
  python3 ax-engine-macax.py --pid 1055 --roles AXStaticText,AXButton
不传 --app/--pid → 取最前台 app。

为什么需要它（2026-09-22 实测，PROPOSAL 041）：同一页面 AX 与 OCR 都能拿到 24/24 编号，但
  AX 零识别错、有结构（角色/层级）、能读**屏幕外**内容（如 iTerm 整个回滚缓冲 25.8 万字节）、
  且元素可交互（能点、能读输入框值）；OCR 只能读可见像素、且中文引号/大小写/空格会错。
两者**互补**（活界面用 ax、图片文件用 ocr），不是替代关系。

权限：读别的 app 的 AX 树需要「辅助功能」授权（系统设置 → 隐私与安全性 → 辅助功能）。
未授权时 AXIsProcessTrusted() 为 False → 本引擎返回结构化错误（不静默空返回）。
"""
import argparse
import json
import sys
import time


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


try:
    import ApplicationServices as AS
    from AppKit import NSWorkspace
except ImportError:
    _fail("缺少 PyObjC：python3 -m pip install --user pyobjc-framework-Quartz pyobjc-framework-ApplicationServices"
          "（Homebrew Python 受 PEP 668 保护时再加 --break-system-packages）")

# 属性名用字面量而非 kAX* 常量：pyobjc 各版本对这些常量的导出位置不一致（实测 Quartz 里没有），
# 而 AX 属性名本身是稳定协议串（"AXRole" 等），字面量最稳。
A_ROLE = "AXRole"
A_SUBROLE = "AXSubrole"
A_TITLE = "AXTitle"
A_VALUE = "AXValue"
A_DESC = "AXDescription"
A_PLACEHOLDER = "AXPlaceholderValue"
A_CHILDREN = "AXChildren"
A_WINDOWS = "AXWindows"

# 默认只收「带文本信息」的角色，避免把几千个纯容器元素灌给模型（PROPOSAL 041：roles 白名单必需）。
DEFAULT_TEXT_ROLES = [
    "AXStaticText", "AXTextField", "AXTextArea", "AXButton", "AXLink", "AXHeading",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXCell", "AXRow",
    "AXTabGroup", "AXImage", "AXWindow", "AXSheet", "AXWebArea", "AXGroup", "AXList",
    "AXOutline", "AXComboBox", "AXSlider", "AXProgressIndicator", "AXDisclosureTriangle",
    "AXTable", "AXScrollArea", "AXToolbar", "AXMenuBar", "AXMenuButton",
]


def ax_attr(el, name):
    """读一个 AX 属性；失败返回 None（属性不存在/权限不足都走这里）。"""
    try:
        err, val = AS.AXUIElementCopyAttributeValue(el, name, None)
        if err != 0:
            return None
        return val
    except Exception:  # noqa: BLE001
        return None


def norm_multiline(s: str) -> str:
    """终端类 app 的 AXValue 常按固定列宽用空格补齐（iTerm 实测每行拖一堆尾空格）——
    逐行去尾空格、整体 strip（单行走 strip 即可）。NUL 占位已在 ax_str 里剥掉。"""
    if "\n" not in s:
        return s.strip()
    return "\n".join(ln.rstrip() for ln in s.splitlines()).strip()


def ax_str(el, name):
    v = ax_attr(el, name)
    if isinstance(v, (str, int, float)):
        # iTerm 等把窗口缓存文本用 NUL 填充占位（实测 value 里大量 \\x00）——一律剥掉
        return str(v).replace("\x00", "").strip()
    return ""


def pick_app(app_name: str, pid: int):
    """按 pid / 名字子串 / 最前台 选目标 app。返回 (name, pid, bundle, frontmost) 或 None。"""
    ws = NSWorkspace.sharedWorkspace()
    front = ws.frontmostApplication()
    if pid:
        for a in ws.runningApplications():
            if a.processIdentifier() == pid:
                return (a.localizedName() or "", pid, a.bundleIdentifier() or "", False)
        return None
    if not app_name:
        return (front.localizedName() or "", front.processIdentifier(),
                front.bundleIdentifier() or "", True)
    needle = app_name.lower()
    cands = [a for a in ws.runningApplications()
             if a.activationPolicy() == 0 and needle in (a.localizedName() or "").lower()]
    if not cands:
        return None
    # 多候选取「名字最短」的（"Safari" 优于 "Safari浏览器帮助程序"）
    cands.sort(key=lambda a: len(a.localizedName() or ""))
    a = cands[0]
    return (a.localizedName() or "", a.processIdentifier(), a.bundleIdentifier() or "", False)


def list_apps():
    out = []
    for a in NSWorkspace.sharedWorkspace().runningApplications():
        if a.activationPolicy() != 0:
            continue  # 只列有 UI 的 app（跳过后台 helper/守护进程）
        out.append({"name": a.localizedName() or "", "pid": a.processIdentifier(),
                    "bundle": a.bundleIdentifier() or ""})
    out.sort(key=lambda x: x["name"].lower())
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="")
    ap.add_argument("--pid", type=int, default=0)
    ap.add_argument("--depth", type=int, default=8)
    ap.add_argument("--max", type=int, default=200)
    ap.add_argument("--roles", default="")
    ap.add_argument("--mode", choices=("tree", "text"), default="tree")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all-roles", action="store_true", help="不过滤角色（调试用，输出很大）")
    ap.add_argument("--menubar", action="store_true", help="包含菜单栏子树（默认跳过——菜单项动辄上百条，噪音大）")
    a = ap.parse_args()

    if a.list:
        print(json.dumps({"ok": True, "apps": list_apps()}, ensure_ascii=False))
        return

    if not AS.AXIsProcessTrusted():
        _fail("无「辅助功能」授权：系统设置 → 隐私与安全性 → 辅助功能 → 勾选运行本 agent 的终端程序，然后重启该终端。")

    target = pick_app(a.app, a.pid)
    if target is None:
        names = [x["name"] for x in list_apps()]
        _fail(f"找不到 app「{a.app or a.pid}」。运行中的 app：{'、'.join(names[:20])}")

    name, pid, bundle, frontmost = target
    roles = [r.strip() for r in a.roles.split(",") if r.strip()]
    if not roles and not a.all_roles:
        roles = DEFAULT_TEXT_ROLES
    role_set = set(roles)

    t0 = time.time()
    counters = {"elements": 0, "withText": 0, "dumped": 0, "menuSkipped": 0}
    nodes = []   # tree 模式
    texts = []   # text 模式（保序去重）
    seen_text = set()

    def walk(el, depth: int) -> None:
        if depth > a.depth or counters["dumped"] >= a.max:
            return
        counters["elements"] += 1
        role = ax_str(el, A_ROLE)
        # 菜单栏子树：默认跳过（上百条菜单项，且与“读屏内容”目标无关）——--menubar 才进
        if role == "AXMenuBar" and not a.menubar:
            counters["menuSkipped"] += 1
            return
        subrole = ax_str(el, A_SUBROLE)
        title = ax_str(el, A_TITLE)
        value = norm_multiline(ax_str(el, A_VALUE))
        desc = ax_str(el, A_DESC)
        ph = ax_str(el, A_PLACEHOLDER)
        if not role_set or role in role_set:
            parts = [p for p in (title, value, desc, ph) if p]
            if parts:
                counters["withText"] += 1
            if parts or role in ("AXWindow", "AXWebArea", "AXSheet"):
                counters["dumped"] += 1
                if a.mode == "tree":
                    nodes.append({"depth": depth, "role": role, "subrole": subrole,
                                  "title": title, "value": value, "desc": desc,
                                  "placeholder": ph})
                else:
                    for p in parts:
                        for line in p.splitlines():
                            line = line.strip()
                            if line and line not in seen_text:
                                seen_text.add(line)
                                texts.append(line)
        kids = ax_attr(el, A_CHILDREN)
        if kids:
            for k in kids:
                walk(k, depth + 1)

    ax_app = AS.AXUIElementCreateApplication(pid)
    wins = ax_attr(ax_app, A_WINDOWS)
    win_count = len(wins) if wins else 0
    if wins:
        walked_from = "windows"
        for w in wins:
            walk(w, 0)
    else:
        # 窗口树取不到时的兵底：从 app 元素走（含菜单栏/状态栏）
        walked_from = "app"
        walk(ax_app, 0)

    payload = {
        "ok": True,
        "app": {"name": name, "pid": pid, "bundle": bundle, "frontmost": frontmost},
        "trusted": True,
        "elapsedMs": int((time.time() - t0) * 1000),
        "walkedFrom": walked_from,
        "windowsFound": win_count,
        "counts": {"elements": counters["elements"], "withText": counters["withText"],
                   "dumped": counters["dumped"], "max": a.max,
                   "menuSkipped": counters["menuSkipped"],
                   "truncated": counters["dumped"] >= a.max},
        "rolesFiltered": bool(role_set),
    }
    if a.mode == "tree":
        payload["nodes"] = nodes
    else:
        payload["texts"] = texts
    if win_count == 0:
        # 不是错误——app 确实可能没开窗口（实测：用户关掉窗口的 Safari/系统设置就是 0）。给可操作提示。
        payload["hint"] = ("该 app 当前没有可读窗口（windowsFound=0）——窗口可能已关闭/最小化，或在别的 Space。"
                           "先用 --list 看有哪些 app，或把目标窗口切到前台/当前 Space 再试。")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
