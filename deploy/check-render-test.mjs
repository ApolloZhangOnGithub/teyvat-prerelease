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
  check("R1 highlightCode 返回 null 不崩溃且代码内容保留", text.includes('{"ok": true}') && text.includes("json"));
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
  const blinkDot = dot(t, { partial: true, blink: true });
  check("D1 partial blink = 灰⏺或空格", blinkDot === "dim:⏺" || blinkDot === " ");
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

if (failures > 0) {
  console.error(`  render smoke check FAILED: ${failures} 项失败`);
  process.exit(1);
}
console.log("  render smoke check: all pass");
