// check-render.mjs 实际执行的回归断言（在临时目录里运行，import 相对路径指向同目录的 pi-tui 闭包）
import { Markdown } from "./pi-tui/components/markdown.js";

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failures++;
};
const strip = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\[[0-9;]*m", "g"), "");
const FENCE = String.fromCharCode(96).repeat(3);
const NL = String.fromCharCode(10);

const baseTheme = {
  heading: (s) => s, link: (s) => s, linkUrl: (s) => s, code: (s) => s,
  codeBlock: (s) => s, codeBlockBorder: (s) => s, quote: (s) => s,
  quoteBorder: (s) => s, hr: (s) => s, listBullet: (s) => s,
  bold: (s) => s, italic: (s) => s, strikethrough: (s) => s, underline: (s) => s,
};

// R1: genshin interactive-mode 真实行为 —— highlightCode 返回 null（开关默认关 / cli-highlight 缺失 / 高亮器抛错）
try {
  const src = [FENCE + "json", '{"ok": true}', FENCE].join(NL);
  const md = new Markdown(src, 0, 0, { ...baseTheme, highlightCode: () => null });
  const lines = md.render(60);
  const text = lines.map(strip).join(NL);
  // 2026-09-13（房东要求：代码块不再渲染围栏行）——围栏行里的语言标识不再出现在渲染输出，
  // 故断言里的 text.includes("json") 去掉；本项回归保护的本意（highlightCode 返回 null 不崩溃 + 代码内容保留）不变。
  check("R1 highlightCode 返回 null 不崩溃且代码内容保留", text.includes('{"ok": true}'));
} catch (e) {
  check("R1 highlightCode 返回 null 不崩溃且代码内容保留", false, e?.message);
}

// R2: 正常高亮数组路径
try {
  const src = [FENCE + "js", "const x = 1;", FENCE].join(NL);
  const md = new Markdown(src, 0, 0, { ...baseTheme, highlightCode: () => ["[hl]const x = 1;[/hl]"] });
  const lines = md.render(60);
  check("R2 highlightCode 数组路径正常", lines.some((l) => l.includes("[hl]const x = 1;[/hl]")));
} catch (e) {
  check("R2 highlightCode 数组路径正常", false, e?.message);
}

// R3: 无 highlightCode 的主题（纯文本分支）
try {
  const src = [FENCE + "py", "print(1)", FENCE].join(NL);
  const md = new Markdown(src, 0, 0, baseTheme);
  const lines = md.render(60);
  check("R3 无 highlightCode 纯文本分支正常", lines.some((l) => strip(l).includes("print(1)")));
} catch (e) {
  check("R3 无 highlightCode 纯文本分支正常", false, e?.message);
}

// H1/H2/H3: teyvat 标题定制 —— 不调用 theme.heading（去黄）、不打印字面 # 前缀、文本保留
try {
  let headingCalls = 0;
  const theme = { ...baseTheme, heading: (s) => { headingCalls++; return s; } };
  const md = new Markdown(["# 一级", "## 二级", "### 三级"].join(NL + NL), 0, 0, theme);
  const lines = md.render(60);
  check("H1 标题不调用 theme.heading（去黄）", headingCalls === 0, `calls=${headingCalls}`);
  check("H2 不打印字面 # 前缀", !lines.some((l) => strip(l).trim().startsWith("#")));
  check("H3 标题文本保留", lines.some((l) => l.includes("一级")) && lines.some((l) => l.includes("三级")));
} catch (e) {
  check("H1-H3 标题渲染", false, e?.message);
}

// R4: teyvat 代码块行号 gutter（fmtLineNo 定制，0.84.1 rebase 时曾丢失）
try {
  const src = [FENCE + "py", "a = 1", "b = 2", FENCE].join(NL);
  const md = new Markdown(src, 0, 0, { ...baseTheme, highlightCode: () => null });
  const lines = md.render(60);
  check("R4 代码块行号 gutter 存在", lines.some((l) => /^\s*\d+\s+│\s/.test(strip(l))));
} catch (e) {
  check("R4 代码块行号 gutter 存在", false, e?.message);
}

// U1: utils.js extractTailAnsiOsc 导出与行为（行尾不可见序列修复，曾丢失）
try {
  const { extractTailAnsiOsc } = await import("./pi-tui/utils.js");
  const ESC = String.fromCharCode(27);
  check("U1 extractTailAnsiOsc 提取行尾 SGR", extractTailAnsiOsc("text" + ESC + "[0m") === ESC + "[0m");
  check("U1b extractTailAnsiOsc 提取行尾 OSC-ST", extractTailAnsiOsc("text" + ESC + "]8;;" + ESC + "\\") === ESC + "]8;;" + ESC + "\\");
  check("U1c 无尾部序列返回空串", extractTailAnsiOsc("plain") === "");
} catch (e) {
  check("U1 extractTailAnsiOsc", false, e?.message);
}

// T1: text.js 挂起缩进接线（hangWrapText，曾丢失）
try {
  const { Text } = await import("./pi-tui/components/text.js");
  const t = new Text("• abcdefghijklmnopqrstuvwxyz", 0, 0);
  const lines = t.render(10);
  check("T1 Text 挂起缩进折行", lines.length >= 2 && lines[1].startsWith("  "));
} catch (e) {
  check("T1 Text 挂起缩进折行", false, e?.message);
}

// D1: 状态点颜色规范（2026-08-13 用户规范）：进行中/等待中 = 黄色（warning）
try {
  const { dot } = await import("./pi-tui/blocks_nongod.js");
  const t = { fg: (k, s) => `${k}:${s}` };
  // 2026-09-11：partial 默认黄⏺，blink=true 时灰/消失闪烁（仅 wait/hibernate）
  check("D1 partial 点 = warning 黄⏺", dot(t, { partial: true }) === "warning:⏺");
  check("D1 partial blink = 灰⏺", dot(t, { partial: true, blink: true }) === "dim:⏺");
  check("D1b error 点 = error 红", dot(t, { error: true }) === "error:⏺");
  check("D1c 成功点 = success 绿", dot(t, {}) === "success:⏺");
} catch (e) {
  check("D1 状态点颜色", false, e?.message);
}

// K1: 滚动键位断言（2026-08-13 用户规范：ctrl+shift+down 回到底部；ctrl+down 与 macOS 系统冲突不得绑定）
try {
  const { getKeybindings } = await import("./pi-tui/keybindings.js");
  const kb = getKeybindings();
  check("K1 ctrl+shift+down = bottom", kb.matches("\x1b[1;6B", "tui.altScreen.bottom"));
  check("K1b ctrl+shift+down 不再占用 nextPrompt", !kb.matches("\x1b[1;6B", "tui.altScreen.nextPrompt"));
  check("K1c ctrl+down 不得绑定 bottom", !kb.matches("\x1b[1;5B", "tui.altScreen.bottom"));
  check("K1d end 仍绑定 bottom", kb.matches("\x1b[F", "tui.altScreen.bottom"));
} catch (e) {
  check("K1 滚动键位", false, e?.message);
}

// R5: 超长代码行折行时续行对齐内容列（2026-08-14 用户报 CoT 代码块自动换行错位）
try {
  const long = 'const tsStr = "' + '${now.getFullYear()}' + '-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}";';
  const src = [FENCE + "js", 'const a = "x";', long, FENCE].join(NL);
  const md = new Markdown(src, 2, 0, { ...baseTheme, highlightCode: () => null });
  const lines = md.render(50);
  const first = lines.find((l) => strip(l).includes("const tsStr"));
  const cont = lines.find((l) => strip(l).includes("now.getFullYear"));
  const col1 = first ? first.indexOf("const tsStr") : -1;
  const col2 = cont ? cont.search(/\S/) : -1; // 续行行首非空字符列（续行块可能以代码引号开头）
  check("R5 代码折行续行对齐内容列", col1 >= 0 && col2 >= 0 && col1 === col2, `col1=${col1} col2=${col2}`);
} catch (e) {
  check("R5 代码折行续行对齐", false, e?.message);
}

// E1–E6: execute 结果渲染唯一入口（ISSUE 226，2026-09-13）——快命令 / Created / cmd-done 三种样式的纯文本快照 + 旧格式反解析
try {
  const B = await import("./pi-tui/blocks_nongod.js");
  const { visibleWidth, wrapTextWithAnsi } = await import("./pi-tui/utils.js");
  class FT { constructor(text) { this.text = text; } }
  class FC { constructor() { this.children = []; } addChild(c) { this.children.push(c); } }
  B.initBlockrender(FT, FC, visibleWidth, wrapTextWithAnsi);
  const t = { fg: (_k, s) => s, bold: (s) => s };
  // 2026-09-17（用户：at 时间戳开关失效）：blocks_nongod 改为 `=== true`（与 settings 默认关一致），
  // 显式开启才显示 at HH:MM:SS。测试这里显式开启（并另测默认关）。
  globalThis.__genshinResultAt = true;

  const flat = (node, out = []) => { if (node?.text !== undefined) out.push(node.text); for (const c of node?.children || []) flat(c, out); return out; };
  const fixedTs = new Date(2026, 8, 13, 9, 39, 52).getTime();
  delete globalThis.__genshinExecuteResult;
  // E1 快命令
  const e1 = flat(B.renderExecuteResult(t, { kind: "fast", exitCode: 0, elapsedMs: 120, endTs: fixedTs, output: "hello\nworld" }));
  // 2026-09-14（用户定稿）：结果行统一 Result 风格——Result "标题" done in 2s（renderToolCall.label noDot，与 Execute 调用行同构）
  check("E1 快命令摘要行 = Result done in 0.12s at HH:MM:SS", e1[0] === "  Result done in 0.12s at 09:39:52", e1[0]);
  check("E1b 快命令输出带行号缩进", e1.length === 3 && /^\s{5}\s*1\s+hello$/.test(e1[1]) && /2\s+world$/.test(e1[2]), JSON.stringify(e1));
  const e1x = flat(B.renderExecuteResult(t, { kind: "fast", exitCode: 2, elapsedMs: 3000, endTs: fixedTs, output: "" }));
  check("E1c 非 0 退出码显示 exit N、整秒无小数", e1x[0] === "  Result done in 3s, exit 2 at 09:39:52", e1x[0]);
  // E2 Created
  const e2 = flat(B.renderExecuteResult(t, { kind: "created", created: 1, total: 2, terminal: true, tname: "deploy9", recId: "260913-093952-a1b2c3d4", endTs: fixedTs }));
  check("E2 Created 行", e2[0] === "  ⎿  Created 1 terminal process named deploy9 (2 in total), id 260913-093952-a1b2c3d4 at 09:39:52", e2[0]);
  // E3 cmd-done：merged → ⎿；非 merged → ▸；exit≠0 / failed 判错（前缀符号由 fg 直接透传，这里只看文本）
  const e3 = flat(B.renderExecuteResult(t, { kind: "done", status: "done", title: "确认权重已下载", recId: "x", exitCode: 0, elapsedMs: 16000, endTs: fixedTs, output: "ok", remaining: 2, merged: true }));
  check("E3 cmd-done merged", e3[0] === "  Result \"确认权重已下载\" done in 16s (2 remaining) at 09:39:52", e3[0]);
  const e3b = flat(B.renderExecuteResult(t, { kind: "done", status: "failed", title: "t", exitCode: -1, elapsedMs: 5000, endTs: fixedTs, output: "boom", merged: false }));
  check("E3b cmd-done failed 统一 Result 样式", e3b[0] === "  Result \"t\" failed after 5s, exit -1 at 09:39:52", e3b[0]);
  // E4 三态：summary 只留 5 行；hide 快命令整块不显示、cmd-done 只藏输出
  globalThis.__genshinExecuteResult = "summary";
  const e4 = flat(B.renderExecuteResult(t, { kind: "fast", exitCode: 0, elapsedMs: 10, endTs: fixedTs, output: "1\n2\n3\n4\n5\n6\n7" }));
  check("E4 summary 只给前 5 行", e4.length === 6, `lines=${e4.length}`);
  globalThis.__genshinExecuteResult = "hide";
  check("E4b hide 快命令整块不显示", flat(B.renderExecuteResult(t, { kind: "fast", exitCode: 0, elapsedMs: 10, endTs: fixedTs, output: "x" })).length === 0);
  check("E4c hide cmd-done 只藏输出", flat(B.renderExecuteResult(t, { kind: "done", status: "done", exitCode: 0, elapsedMs: 1000, endTs: fixedTs, output: "x", merged: true })).length === 1);
  delete globalThis.__genshinExecuteResult;
  // E5 旧格式 cmd-done 反解析（历史消息回放兜底）
  const p = B.parseLegacyCmdDone("完成 (16s, exit 1):\n$ make x\nline1\nline2\n[id: 260913-093952-a1b2c3d4]\n[remaining: 2]");
  check("E5 legacy 完成 反解析", p.status === "done" && p.exitCode === 1 && p.elapsedSec === 16 && p.cmd === "make x" && p.output === "line1\nline2" && p.recId === "260913-093952-a1b2c3d4" && p.remaining === 2, JSON.stringify(p));
  const p2 = B.parseLegacyCmdDone("Command failed (5s):\n$ bad\nboom\n[id: abc-1]");
  check("E5b legacy failed 反解析", p2.status === "failed" && p2.output === "boom" && p2.recId === "abc-1", JSON.stringify(p2));
  const p3 = B.parseLegacyCmdDone("wait 完成 (35s)\nnext");
  check("E5c legacy wait 完成", p3.kind === "hw" && p3.elapsedSec === 35 && p3.nextSteps === "next");
  // E6 尾标签整组剥净（backbone 新口径 + bioclock 带 ctx 后缀）
  const s = B.stripResultTokenMark("out\n[id: x]\n[result 254 tokens, ctx.md 606.3k est, api 490k (49%)]\n[19:00:07.687 +0.9s | ctx 49%]");
  check("E6 stripResultTokenMark 三行整组剥净", s === "out", JSON.stringify(s));
  check("E6b fmtElapsedMs 分档", B.fmtElapsedMs(530) === "0.53s" && B.fmtElapsedMs(1500) === "1.5s" && B.fmtElapsedMs(65000) === "1m 5s" && B.fmtElapsedMs(7200000) === "2h 0m");
} catch (e) {
  check("E1-E6 execute 渲染唯一入口", false, e?.stack || e?.message);
}

// W1: 全角序号 ①②③ 的两格契约（2026-09-13 用户：含 ② 的表格行右边框缩进一格）——排版 2 格 + 终端只给 1 格时输出补空格
try {
  const { visibleWidth, padEnclosedForNarrowCells } = await import("./pi-tui/utils.js");
  check("W1 ② 排版按 2 格", visibleWidth("②") === 2);
  delete globalThis.__genshinEnclosedCells;
  check("W1b 终端未知/1 格：② 后补一个真实空格", padEnclosedForNarrowCells("│ ② x │") === "│ ②  x │");
  globalThis.__genshinEnclosedCells = 2;
  check("W1c 终端给 2 格：原样输出", padEnclosedForNarrowCells("│ ② x │") === "│ ② x │");
  delete globalThis.__genshinEnclosedCells;
  check("W1d 无序号的串不动", padEnclosedForNarrowCells("plain │ text") === "plain │ text");
} catch (e) {
  check("W1 全角序号两格契约", false, e?.message);
}

if (failures > 0) {
  console.error(`  render smoke check FAILED: ${failures} 项失败`);
  process.exit(1);
}
console.log("  render smoke check: all pass");
