// god.frontend.tui/ui_elements/blocks_nongod.js
// ── teyvat 统一块渲染引擎 (the one engine) ───────────────────────────────
// 所有「• 块」—— assistant 文字 / 思考 / 工具命令 / 工具结果 —— 统一走这里，保证：
//   1) bullet（•/◦）顶格在 col 0
//   2) 内容落在 col GUTTER(=2)，跨块对齐（说话、思考、命令同列）
//   3) 折行后续行也缩进到 col GUTTER（挂起缩进 / hanging indent）
//
// 谁用它（都是 import，绝不各自重写）：
//   - modes/interactive/components/assistant-message.js  → markdownBullet（文字/思考）
//   - modes/interactive/components/tools-execution.js      → dot（状态点）
//   - @earendil-works/pi-tui/dist/tui.js                  → wrapHanging（最终折行）
//   - 所有工具的 renderCall / renderResult                  → toolCall / toolResult
//
// 部署：install.sh 把本文件 cp 进 dist 两处（pi 组件目录 + pi-tui 根），
//      各处用相对 import `./blocks_nongod.js`。源码只此一份，绝不手改 live。

export const GUTTER = 2; // 内容列：bullet "• " 占 2 列，内容从第 2 列起

import { isWsl } from "./env.js";

// 2026-09-16（用户定稿：只要 wsl，别的不要）：只 WSL 用 ASCII 符号回退（⏺◆◇⎿→ 渲染 2 格但 visibleWidth 算 1 格，
// 行溢出终端硬折）。之前 win32/WT_SESSION 也算进去，收紧到只 isWsl()。Mac/Linux 不受影响。
const _needsAsciiSym = isWsl();
// 2026-09-13（ISSUE 226）：SYM 只定义一次——此前 globalThis.__genshinSYM 与 export const SYM 是两个内容相同的字面量，改一处漏一处。
// 消费方两种取法都行（import SYM / globalThis.__genshinSYM），拿到的是同一个对象。结果行折线一律 SYM.result，禁止手写 "⎿"（门禁 check-execute-render）。
export const SYM = _needsAsciiSym
  ? { dot: "*", diamond: "+", diamondOpen: "o", result: ">", star: "*", snow: "*", prompt: ">", arrow: ">" } // 2026-09-16（用户报 Read 折行顶头/windows agent 排查）：result 原为 "→"(U+2192)，是 East Asian Ambiguous 字符——Windows Terminal+CJK 字体渲染 2 格但 visibleWidth 算 1 格，行溢出→终端硬折续行顶头。换真 ASCII ">"
  : { dot: "⏺", diamond: "◆", diamondOpen: "◇", result: "⎿", star: "✤", snow: "❄", prompt: "❯", arrow: "▸" };
globalThis.__genshinSYM = SYM;

// 状态点（工具用）：进行=◦(accent) / 错=•(error) / 成功=•(success)。统一在这里，别各处各写。
// 2026-08-14 用户定稿：进行中/等待中（partial）本身是空心黄 ◦，为美观统一用实心黄 •。
// 空心语义保留在此注释：未完成=空心，完成/出错=实心。
export function dot(theme, opts) {
  const o = opts || {};
  if (o.partial) {
    if (o.blink) return theme.fg("dim", SYM.dot);
    return theme.fg("warning", SYM.dot);
  }
  if (o.error) return theme.fg("error", SYM.dot);
  return theme.fg("success", SYM.dot);
}

// 菱形标记（收到的消息用：Result 推送 / Social Message / 通知类）。与 dot 同语义：进行=◇ / 错=◆ / 成功=◆。
// 视觉区分：主动调用的工具行用圆点 dot，被动收到的消息用菱形 diamond。
export function diamond(theme, opts) {
  const o = opts || {};
  if (o.partial) return theme.fg("accent", SYM.diamondOpen);
  if (o.error) return theme.fg("error", SYM.diamond);
  return theme.fg("success", SYM.diamond);
}

// ── 统一错误判定（红点 + 红色内容共用一条管线）───────────────────────
// 历史问题（2026-08-15）：错误判定散落多处、方法不统一——
//   isDotError() 按工具分派（wait/hibernate/execute 各自写正则）
//   hasTextError 用宽泛正则（容易误伤 Read 正常内容，2026-08-13 已收敛）
//   各工具 renderResult 各自判断 ERR 前缀
// 现在收敛为单一入口 isToolError(toolName, text, ctx)：
//   1) ctx.isError / text 判定优先（pi 内置工具可靠）
//   2) 扩展工具（pi 对 Paimon 工具不传 isError）→ 按工具已知错误形态文本精确检测
//   3) 通用兑底：ERR: 开头
// 所有 renderMessage.output/summary 与 isDotError 都调它，新工具错误形态只需在这加一行。
export function isToolError(toolName, text, ctx) {
  if (ctx?.isError) return true;
  const t = String(text || "");
  // 被拒/禁用/被打断的已知文案形态（行首锚定，避免正常内容误伤）
  if (toolName === "wait" || toolName === "hibernate") {
    if (/^(?:ERR:|还有|禁止|请先|拒绝|错误)/m.test(t)) return true;
  }
  else if (toolName === "execute") {
    // 执行失败形态：Traceback / XxxError 行 / 退出码非 0 标记
    // 2026-09-13：XxxError 后必须跟冒号/空白/行尾——`ls` 列出一个叫 ValueError.log 的文件曾把整块判红；(exit N) 只认行尾（帮助文本里的 "(exit 1)" 不算）
    if (/^(?:Traceback|[A-Za-z]+Error(?::|\s|$)|ERR:)/m.test(t) || /\(exit [1-9]\d*\)\s*$/m.test(t)) return true;
  }
  else if (toolName === "amem") {
    // amem 错误形态：ERR: 开头（pi 对扩展工具不传 isError，靠文本检测染红）
    if (/^ERR:/m.test(t)) return true;
  }
  else if (/^ERR:/m.test(t)) {
    // 通用兑底：任何工具 ERR: 开头都视为错误
    return true;
  }
  // wait/hibernate 被打断标记（interrupt id 匹配）
  // 2026-09-07（WIKI 规范收敛）：wait_for_user:true 被打断 = 用户来了 = 正常恢复 → 非 error（绿点）；
  // 只有异常中断（esc/命令等）才红点。旧实现无条件红，与 WIKI 判据不一致。
  if ((toolName === "wait" || toolName === "hibernate") && ctx?.toolCallId && globalThis.__genshinWaitInterruptedId === ctx.toolCallId) {
    if (globalThis.__genshinWaitInterruptedForUser === true) return false;
    return true;
  }
  return false;
}


// 把一行开头的 GUTTER 个「前导可见空格」换成 "<dot> "（dot 落 col0，内容仍在 col GUTTER）。
// 行首可能带 ANSI（颜色/背景）；只动可见的前导空格，不碰样式。
export function swapLeadingPad(line, dotStr) {
  const s = String(line);
  const m = s.match(new RegExp("^((?:" + String.fromCharCode(27) + "\\[[0-9;]*m)*)( +)"));
  if (!m) return s; // 无前导空格 → 原样返回，不加字符（加了会超宽）
  const ansi = m[1];
  const spaces = m[2].length;
  if (spaces < GUTTER) {
    // 空格不够 GUTTER 个，替换现有空格放 dot（可能挤掉一个空格但不增宽）
    const rest = s.slice(ansi.length + spaces);
    return ansi + dotStr + rest;
  }
  const rest = s.slice(ansi.length + GUTTER);
  return ansi + dotStr + " " + rest;
}

// 渲染一个 markdown 块为「挂起 bullet」的行：
// md 必须是用 paddingX=GUTTER 构造好的 Markdown 实例（这样全部行——含折行——都在 col GUTTER），
// 再把首行前导空格换成 dot。→ 首行 "• 内容"、续行 "  内容"，天然挂起对齐。
export function markdownBullet(md, dotStr, width) {
  const lines = [...md.render(width)]; // copy: 不修改 Markdown 缓存（否则每帧重绘都会再叠加 dot）
  if (lines.length > 0) lines[0] = swapLeadingPad(lines[0], dotStr);
  return lines;
}

// 给【Text 组件】用的挂起折行：基于 wrapTextWithAnsi（Text 本来就用它）。
// 若行首有前缀（空白 + 可选 bullet/$ 及其后空格），首行按 width 折，续行按 width-前缀宽 折并补缩进 →
// 续行和「前缀后面的字」同列。无前缀则退回普通 wrapTextWithAnsi，行为不变（不影响别的 Text 用途）。
export function hangWrapText(text, width, h) {
  const { visibleWidth, wrapTextWithAnsi } = h;
  const stripped = String(text).replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
  const pm = stripped.match(/^(\s*(?:(?:[•◦●○$⎿⏺∴▸→◆◇*>]|\d+\s*│)\s+|\d+\s*[+\-]\s|\s*\d+\t)?)/);
  const indW = (pm && pm[1]) ? visibleWidth(pm[1]) : 0;
  if (indW <= 0 || indW >= width) return wrapTextWithAnsi(text, width);
  if (visibleWidth(text) <= width) return wrapTextWithAnsi(text, width);
  // 预处理：长 token 含 / 时插入断点（空格后复原），避免 breakLongWord 逐字硬切路径
  let src = text;
  if (visibleWidth(stripped) > width && /\S{30,}/.test(stripped) && stripped.includes("/")) {
    src = text.replace(/\//g, "/ ");
  }
  const contWidth = Math.max(1, width - indW);
  const wrapped = wrapTextWithAnsi(src, contWidth);
  // 复原断点空格
  if (src !== text) {
    for (let i = 0; i < wrapped.length; i++) wrapped[i] = wrapped[i].replace(/\/ /g, "/");
  }
  if (wrapped.length <= 1) return wrapped;
  const indent = " ".repeat(indW);
  const result = [wrapped[0]];
  for (let i = 1; i < wrapped.length; i++) {
    result.push(indent + wrapped[i]);
  }
  return result;
}

// 挂起缩进折行：超宽行折行时，续行缩进到「行首前缀」之后。
// 前缀 = 行首空白 + 可选的 •/◦ bullet 及其后空格 → 续行和「• 后面的字」同列。
// pi-tui 的宽度/切片 helper 跨包不同，由调用方注入 h = {visibleWidth, sliceWithWidth, sliceByColumn, isImageLine}。
export function wrapHanging(lines, width, h) {
  if (!Array.isArray(lines) || width <= 0) return lines;
  const { visibleWidth, sliceWithWidth, sliceByColumn, isImageLine } = h;
  let need = false;
  for (const l of lines) {
    if (typeof l === "string" && !isImageLine(l) && visibleWidth(l) > width) { need = true; break; }
  }
  if (!need) return lines;
  const out = [];
  for (const line of lines) {
    if (typeof line !== "string" || isImageLine(line) || visibleWidth(line) <= width) { out.push(line); continue; }
    const stripped = line.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
    const pm = stripped.match(/^(\s*(?:(?:[•◦●○$⎿⏺∴▸→◆◇*>]|\d+\s*│)\s+|\d+\s*[+\-]\s|\s*\d+\t)?)/);
    const indW = pm && pm[1] ? visibleWidth(pm[1]) : 0;
    const indent = (indW > 0 && indW < width) ? " ".repeat(indW) : "";
    let col = 0; const total = visibleWidth(line); let first = true;
    while (col < total) {
      const avail = first ? width : Math.max(1, width - indent.length);
      const seg = sliceWithWidth(line, col, avail, true);
      if (!seg || seg.width <= 0) { out.push((first ? "" : indent) + sliceByColumn(line, col, avail, true)); break; }
      out.push((first ? "" : indent) + seg.text);
      col += seg.width;
      first = false;
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 渲染模版
// ══════════════════════════════════════════════════════════════════════════════
//
// renderToolCall — 工具调用行渲染
// renderMessage  — 所有消息渲染（tool result + notification/alert/resume 等）
//
// 用法：
//   import { renderToolCall, renderMessage } from "#tui_blockrender";
//   renderCall(args, theme) { return renderToolCall.label(theme, "Hibernate", args?.summary); },
//   renderResult() { return renderMessage.silent(); },

// 组件注入：调用方通过 initBlockrender() 注入 Text/Container/helpers，避免循环依赖
let _Text = null, _Container = null, _visibleWidth = null, _wrapTextWithAnsi = null;
export function initBlockrender(Text, Container, visibleWidth, wrapTextWithAnsi) {
  _Text = Text; _Container = Container;
  if (visibleWidth) _visibleWidth = visibleWidth;
  if (wrapTextWithAnsi) _wrapTextWithAnsi = wrapTextWithAnsi;
}

// 自举：从 pi-tui 动态加载 helpers（install.sh 部署后可直接 import）
(async () => {
  if (_visibleWidth && _wrapTextWithAnsi) return;
  try {
    const m = await import("@earendil-works/pi-tui");
    if (!_visibleWidth) _visibleWidth = m.visibleWidth;
    if (!_wrapTextWithAnsi) _wrapTextWithAnsi = m.wrapTextWithAnsi;
  } catch { /* not available in all deployment contexts */ }
})();
function T(text) { return new _Text(text, 0, 0); }
function C() { return new _Container(); }

// 挂起 bullet 输出：返回带 render(width) 的对象，调用 hangWrapText 实现折行缩进
// cont: 续行前缀（替换缩进空格），如 "⎿ " 实现「工具调用续行标记」
export function bulletText(dotStr, text, cont) {
  if (!_visibleWidth || !_wrapTextWithAnsi) {
    // fallback: 用 Text 组件（Text 自身会处理折行，不手动 slice 防止切坏 ANSI）
    const safe = dotStr + " " + (text || "");
    return T(safe);
  }
  return {
    text: dotStr + " " + (text || ""),
    render(width) {
      const h = { visibleWidth: _visibleWidth, wrapTextWithAnsi: _wrapTextWithAnsi };
      // 先按 \n 拆行，每行独立折行
      const rawLines = this.text.split('\n');
      const firstPrefix = rawLines[0].replace(/\x1b\[[0-9;]*m/g, '').match(/^(\s*(?:(?:[•◦●○$⎿⏺∴▸→*>]|\d+\s*│)\s+|\d+\s*[+\-]\s|\s*\d+\t)?)/)?.[0] || '';
      const indentW = firstPrefix ? _visibleWidth(firstPrefix) : 0;
      // 提取第一行的 ANSI SGR 码注入后续行，避免 \n 后丢失颜色
      const ansiCodes = rawLines[0].match(/\x1b\[[0-9;]*m/g) || [];
      const ansiPrefix = ansiCodes.filter(c => c !== '\x1b[0m').join('');
      const wrapped = rawLines.length <= 1
        ? hangWrapText(this.text, width, h)
        : rawLines.flatMap((l, i) => {
            if (i === 0) return hangWrapText(l, width, h);
            if (indentW <= 0 || indentW >= width) return hangWrapText(l, width, h);
            // 每行独立 hangWrapText：识别该行自己的前缀（行号、diff 标记等）
            const lineWrapped = hangWrapText(l, width - indentW, h);
            // 2026-09-22（用户：result 里换行有时顶头/不跟序号后的文字对齐；要求统一函数与渲染管线）：
            // 此前对「行号竖线行」（`1 │ …`）特判 pad = 行号前缀长（4），普通行 pad = indentW（6）
            // → 同一个 Result 块里不同行的续行/首行左边界不一致（实测 6 vs 8），而且 hangWrapText
            // 已经按「该行自己的前缀」补过续行缩进了，再加 pad 就是双重缩进。
            // 现统一：**整块同一个左边界** = indentW（续行与“序号后的文字”同列），行号/diff 前缀由
            // hangWrapText 自己在行内对齐（首行与续行仍然同列）。
            const pad = indentW;
            return lineWrapped.map((line) => {
              return ' '.repeat(pad) + ansiPrefix + line;
            });
          });
      // 续行前缀替换：如果提供了 cont，且续行前缀可见宽度匹配，替换缩进空格
      if (cont && wrapped.length > 1) {
        const contW = _visibleWidth(cont);
        for (let i = 1; i < wrapped.length; i++) {
          if (contW <= indentW) {
            wrapped[i] = cont + ' '.repeat(indentW - contW) + wrapped[i].slice(indentW);
          }
        }
      }
      // 安全网：硬截断任何超宽行（防止 wrapTextWithAnsi 偶发不折行）
      const safe = [];
      for (const w of wrapped) {
        if (_visibleWidth(w) > width) {
          let cur = ''; let remain = w;
          while (_visibleWidth(remain) > width) {
            let cut = width;
            while (_visibleWidth(remain.slice(0, cut)) > width) cut--;
            safe.push(remain.slice(0, cut));
            remain = remain.slice(cut);
          }
          if (remain) safe.push(remain);
        } else { safe.push(w); }
      }
      return safe;
    },
    invalidate() {},
  };
}

// ── renderToolCall: 工具调用行 ────────────────────────────────────────────

// ── 行号渲染（markdown 代码块同款）：行号右对齐 + │ 竖线 + 语法高亮 ──
// gutterWidth = 总行数位数（自动对齐），fmtLineNo(n) = padStart + " │ "
// 不手动折行——由 Text/hangWrapText 识别 `\d+\s*│` 前缀自动对齐续行（blocks_nongod bulletText 正则）
// 复用 globalThis.__genshinHighlightCode（interactive-mode.js 挂载）。execute 输出、social 消息、cmd-done 复用。
export function lineNumbered(text, theme, lang, startLine) {
  let rawText = String(text ?? "");
  if (!rawText) return "";
  // 清掉 \r（进度条回车覆写）——\r 让终端光标回行首，把行号覆盖掉
  // 含 \r 的行只保留最后一段（\r 后的内容覆盖 \r 前的，模拟终端行为）
  rawText = rawText.split("\n").map(line => {
    if (line.includes("\r")) {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    }
    return line;
  }).join("\n");
  const lines = rawText.split("\n");
  const start = startLine || 1;
  const maxLineNo = start + lines.length - 1;
  const gutterWidth = String(maxLineNo).length;
  const fmtLineNo = (n) => theme.fg("dim", String(n).padStart(gutterWidth) + "  ");
  const hl = globalThis.__genshinHighlightCode;
  const hlResult = lang && hl ? hl(rawText, lang) : null;
  const indent = "  ";
  return lines.map((l, i) => {
    const hlLine = hlResult ? hlResult[i] || l : l;
    return `${indent}${fmtLineNo(start + i)}${hlLine}`;
  }).join("\n");
}

export const renderToolCall = {
  // ◦ Label  detail  — 续行裸缩进（⎿ 只用于结果行）
  // opts.error → 红色 • 点
  label(theme, name, detail, opts) {
    // 2026-09-13（用户）：opts.noDot → 不画状态点，但用空格占住点的宽度（否则文字左移 1 格对不齐）——Execute 调用行默认隐藏原点用，其他 tool 不受影响
    const d = opts?.noDot ? " " : dot(theme, opts || { partial: true });
    const text = detail ? theme.bold(name) + " " + String(detail) : theme.bold(name);
    return bulletText(d, text);
  },

  // ◦ Label command text  — 续行裸缩进
  command(theme, name, cmd) {
    const d = dot(theme, { partial: true });
    const text = String(cmd || "");
    return bulletText(d, theme.bold(name) + " " + text);
  },

  // ── 标准调用行管线（2026-08-17）──────────────────────────────────────
  // ◦ ToolName title         ← 第一行：toolname + 标题（意图，col 0），空格分隔无冒号（2026-08-17 用户定稿）
  //   body line 1            ← 指令详情区：缩进到 col GUTTER(=2)，与第一行 toolname 的
  //   body line 2               首个字母（如 Execute 的 E）上下对齐
  // 设计：title 捕捉「为什么跑」（意图），body 是「跑了什么」（指令/参数）。
  // 对齐规范（2026-08-17 用户定稿）：body 与 toolname 首字母对齐，不是与结果区对齐。
  // 实现：Container + 每行独立 Text（避开 bulletText 多行前缀叠加，见 2026-08-13.39 行号对齐修复）。
  detail(theme, name, title, body, opts) {
    const c = new C();
    // 2026-09-13（用户）：同 label——opts.noDot 不画点但空格占位（对齐保持）
    const d = opts?.noDot ? " " : dot(theme, opts || { partial: true });
    // opts.suffix：灰字后缀（如 hibernate 的唤醒时间 "Until 08:00"，2026-08-20 用户定稿）
    // 注意：theme 没有 dim 方法，灰字必须用 theme.fg("dim", ...)——2026-08-20 实测 theme.dim 是
    // undefined → TypeError → tool-execution catch → fallback（只显示工具名），排查 3 轮才发现。
    const head = d + " " + theme.bold(name) + (title ? " " + title : "") + (opts?.suffix ? " " + theme.fg("dim", opts.suffix) : "");
    c.addChild(new T(head));
    const bodyStr = String(body ?? "").trimEnd();
    if (bodyStr) {
      const indent = " ".repeat(GUTTER);
      for (const ln of bodyStr.split("\n")) c.addChild(new T(indent + ln));
    }
    return c;
  },
};

// ── renderMessage: 所有消息（tool result / notification / alert / ...）────

// 2026-08-18 用户定稿：渲染层统一剥离 feed 的 [result N tokens, ctx X.Xk] 标注
// （backbone.ts 拼进 content 给模型感知结果大小与当前 context 总量——渲染层不需要显示，
// 否则会漏在裸传 content 的工具结果里，如 intentions 曾出现）。
// 注意：只剥 backbone 的 feed 标注；工具自设计的 summary（如 execute 的 [HH:MM:SS, N tokens]）不含
// "result" 前缀，不受影响（read/execute 的 summary 行保留）。
export function stripResultTokenMark(text) {
  // 2026-09-09（用户：Result 还带 [id: xxx]——9/8 只剥 [result N tokens] 漏 id/时间戳——"垃圾过滤器"）：
  // 剥尾部工具元数据段组（不限行首——[background: ...] [id: xxx] [result N tokens, ctx X] [remaining: N]
  // [HH:MM:SS.mmm +Ns] 任意顺序连续/空格隔开——只剥元数据前缀段，不碰内容里的正常 [方括号]。
  // feed content 保留不剥（模型要）——渲染层显示剥离。
  let s = String(text ?? "");
  // 2026-09-13：[result …] 段逗号后接受任意标注（ctx.md X est / api X (N%) / 旧的 ctx|contexted X），backbone 改口径后这里不用再跟着改。
  // 时间戳段同样放宽为 [HH:MM:SS…]——bioclock 追加的是 "[19:00:07.687 +0.9s | ctx 49%]"，旧正则要求 s 后紧跟 ] → 末段失配 →
  // 整组尾标签一个都剥不掉，屏幕上同一条结果里 "contexted 606.3k"（文件估算）与 "ctx 49%"（API）并排（"数字乱跳"的直接视觉来源）。
  const re = /(?:(?:\[(?:id|background|remaining):[^\]]*\]|\[result\s+[\d.]+[kM]?\s*tokens?(?:,[^\]]*)?\]|\[\d{2}:\d{2}:\d{2}[^\]]*\])\s*)+$/;
  let prev;
  do { prev = s; s = s.replace(re, "").trimEnd(); } while (s !== prev);
  return s;
}

export const renderMessage = {
  // spinner 接管：不渲染任何 result 内容（hibernate/wait — 状态由 spinner 系统显示）
  spinner() { return C(); },

  // 静默：不渲染 result（mouth/aware 等无内容输出的工具，状态点已在 call 行）
  silent() { return C(); },

  // 输出：显示文本内容（execute/terminal/mobile 的 tool result）
  // 工具结果：⎿ 缩进到 GUTTER，续行对齐，挂在 call 行下
  // 错误时 ⎿ 和文本体都用 error 色，正常时 ⎿ 用 dim 色、文本体用 toolOutput
  // 错误判定统一走 isToolError 管线（ctx.isError + 工具文本形态 + ERR: 兑底）
  output(theme, ctx, content) {
    const text = stripResultTokenMark(content?.[0]?.text ?? "");
    if (!text) return C();
    const err = isToolError(ctx?.toolName, text, ctx);
    const indent = " ".repeat(GUTTER);
    const prefix = indent + (err ? theme.fg("error", SYM.result + "  ") : theme.fg("dim", SYM.result + "  "));
    return bulletText(prefix, err ? theme.fg("error", text) : theme.fg("toolOutput", text));
  },

  // 简短摘要（同上逻辑，不截断——调用方自己控制长度）
  // text 中已含 ANSI 样式（bold/fg）的部分保持原样，不再外层包 dim
  summary(theme, ctx, text) {
    if (!text) return C();
    const str = stripResultTokenMark(String(text));
    if (!str) return C();
    const err = isToolError(ctx?.toolName, String(text), ctx);
    const indent = " ".repeat(GUTTER);
    const prefix = indent + (err ? theme.fg("error", SYM.result + "  ") : theme.fg("dim", SYM.result + "  "));
    const hasAnsi = /\x1b\[/.test(str);
    return bulletText(prefix, hasAnsi ? str : (err ? theme.fg("error", str) : theme.fg("dim", str)));
  },

  // 通知/警告：◆ Label \n  content（收到的消息用菱形）
  // color（可选）：给 label 指定 theme 色键（如 "result" / "lifeRestart"），无则默认白粗体
  // subtitle（可选，2026-08-18 用户定稿）：dim 小标题，跟在 Label 后（空格分隔，工具调用行风格——无冒号无点）
  // symbol（可选，2026-08-18）：自定义标记符号（如 Life Restarted 用 ✤），默认 ◆
  notice(theme, label, content, color, subtitle, symbol) {
    // 2026-08-18 用户定稿：专属色时菱形与 label 文字同色
    const d = color ? theme.fg(color, symbol || "◆") : diamond(theme);
    const c = C();
    const labelStr = d + " " + (color ? theme.fg(color, theme.bold(label)) : theme.bold(label));
    const head = subtitle ? labelStr + " " + theme.fg("dim", String(subtitle)) : labelStr;
    c.addChild(new _Text(head, 0, 0));
    if (content) c.addChild(new _Text(theme.fg("dim", String(content)), GUTTER, 0));
    return c;
  },

  // 外部消息：◆ From \n  content（收到的消息用菱形，如 Social Message）
  external(theme, from, content) {
    const d = diamond(theme);
    const c = C();
    c.addChild(new _Text(d + " " + theme.bold(from), 0, 0));
    if (content) c.addChild(new _Text(theme.fg("toolOutput", String(content)), GUTTER, 0));
    return c;
  },

  // 通知/Alert：◇ Label \n  body（收到的消息用菱形）
  alert(theme, ctx, label, body) {
    const d = diamond(theme, { partial: true });
    const c = C();
    c.addChild(new _Text(d + " " + theme.bold(label), 0, 0));
    if (body) c.addChild(new _Text(body, GUTTER, 0));
    return c;
  },
};

// ── 时间 / 耗时格式化（唯一实现，2026-09-13 ISSUE 226）───────────────────────
// 此前耗时格式器有 6 份（statebar / renderers / tool-execution / status-indicator / bg / executes 内联）、HH:MM:SS 拼接 4 份。
// fmtElapsedMs：结果行用（快命令带小数）——<1s "0.12s"、<10s "1.2s"（整秒不带小数）、<60s "16s"、<1h "1m 5s"、其余 "2h 3m"
export function fmtElapsedMs(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 1) return `${s.toFixed(2)}s`;
  if (s < 10) return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) { const m = Math.floor(s / 60); const sec = Math.round(s % 60); return sec === 0 ? `${m}m` : `${m}m ${sec}s`; }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
// fmtElapsedCoarse：实时计时器用（statebar 的 lasting、/b 列表）——整秒不带小数，小数会每帧抖
export function fmtElapsedCoarse(ms) {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) { const m = Math.floor(s / 60); const sec = s % 60; return sec === 0 ? `${m}m` : `${m}m ${sec}s`; }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
// fmtClock：本地 HH:MM:SS。ts 必须是事件自带的时刻（details.endTs / createdInfo.ts / message.timestamp）——
// 渲染层禁止 Date.now()：心跳状态切换会让全部历史组件重跑渲染器，取"现在"会让历史行整体漂（LESSON 094）。
export function fmtClock(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "??:??:??";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 尾标签的其余两个入口（与 stripResultTokenMark 同为唯一实现）──────────────
// [background: N running …] 可能不在尾部（用户样例里夹在中间），单独任意位置剥
export function stripInlineBgTag(text) {
  return String(text ?? "").replace(/\n\[background: [^\]]*running[^\]]*\]/g, "");
}
// 取出 bioclock 追加的尾标签 "[HH:MM:SS.mmm +Xs | ctx N%]"（tool-execution 把短结果并到标题行时要单独显示它）
export function extractBioclockTag(text) {
  const m = String(text ?? "").match(/\n(\[\d{2}:\d{2}:\d{2}[^\]]*\])\s*$/);
  return m ? m[1] : "";
}

// ── execute 结果渲染（唯一入口，2026-09-13 ISSUE 226）────────────────────────
// 快命令 / Created / cmd-done 三种样式都由这里画；executes.ts 的 renderResult 与 renderers.ts 的 cmd-done 渲染器
// 只负责把 details 映射成 state。此前三处各手拼 Container、各自一套 "⎿  "、耗时、时钟、三态与错误判定。
// state = {
//   kind: "fast" | "created" | "done",
//   status: "done" | "failed" | "timeout" | "terminated"   （kind=done 用）
//   title, recId, exitCode, elapsedMs, endTs（事件时刻，ms）, output, remaining, merged, isError,
//   terminal, tname, created, total                          （kind=created 用）
// }
// 三态（/s「Execute 结果」__genshinExecuteResult）：hide=快命令整块不显示、cmd-done 只藏输出；summary=输出前 5 行；full=原样。
// 错误判定：有 exitCode 看 exitCode≠0；status 为 failed/timeout/terminated 亦为错；否则看 state.isError。
export function renderExecuteResult(theme, state) {
  const st = state || {};
  const mode = globalThis.__genshinExecuteResult ?? "full";
  const indent = " ".repeat(GUTTER);
  const c = C();
  // 2026-09-14（用户）：at 时间戳开关——/s「at 时间戳」（globalThis.__genshinResultAt，默认**关**）
  // 2026-09-17（用户：设置里隐藏了为什么还显示）：原 `?? true` 与 settings.ts 的 `?? false` 不一致——
  // 未设值时渲染默认开。改为 `=== true`（只有显式开启才显示），与设置面板默认一致。
  const clock = st.endTs != null && globalThis.__genshinResultAt === true ? theme.fg("dim", ` at ${fmtClock(st.endTs)}`) : "";
  if (st.kind === "created") {
    const kind = st.terminal ? "terminal process" : "bash process";
    const named = st.terminal && st.tname ? ` named ${st.tname}` : "";
    const totalPart = st.total > 0 ? ` (${st.total} in total)` : "";
    const idPart = st.recId ? `, id ${st.recId}` : "";
    c.addChild(T(indent + theme.fg("dim", SYM.result + "  ") + `Created ${st.created ?? 1} ${kind}${named}${totalPart}${idPart}` + clock));
    return c;
  }
  if (mode === "hide" && st.kind === "fast") return c;
  const hasExit = typeof st.exitCode === "number";
  const isErr = st.isError === true || (hasExit && st.exitCode !== 0) || st.status === "failed" || st.status === "timeout" || st.status === "terminated";
  const exitPart = hasExit && st.exitCode !== 0 ? `, exit ${theme.bold(String(st.exitCode))}` : "";
  const elapsed = theme.bold(fmtElapsedMs(st.elapsedMs || 0));
  let head;
  switch (st.status) {
    case "failed": head = theme.fg("error", `failed after ${elapsed}`); break;
    case "timeout": head = theme.fg("error", `timed out after ${elapsed}`); break;
    case "terminated": head = theme.fg("error", `terminated after ${elapsed}`); break;
    default: head = st.kind === "done" && !(st.elapsedMs > 0) ? "done instantly" : `done in ${elapsed}`;
  }
  const remPart = st.remaining > 0 ? ` (${st.remaining} remaining)` : "";
  // 2026-09-14（用户定稿）：结果行统一 Result 风格——Result "标题" done in 2s at 01:54:01
  // 与 Execute 调用行同构（renderToolCall.label），原 ⎿ 标题 Done in 2s / ▸ 独立行两种旧样式废弃。
  // merged（紧挨 Created 的折线）判定保留在 renderers.ts 传 state，但画法统一。
  const titleQ = st.kind === "done" && st.title ? '"' + st.title + '" ' : "";
  const body = titleQ + head + exitPart + remPart + clock;
  c.addChild(renderToolCall.label(theme, "Result", body, { noDot: true }));
  let out = String(st.output ?? "").trimEnd();
  if (mode === "hide") out = "";
  else if (mode === "summary" && out) { const ls = out.split("\n"); if (ls.length > 5) out = ls.slice(0, 5).join("\n"); }
  if (out) {
    const contIndent = " ".repeat(GUTTER + 3);
    const dimBody = st.kind === "fast"; // 笔记规范：快命令返回内容 dim；cmd-done 输出原样（与原实现一致）
    for (const line of lineNumbered(out, theme).split("\n")) c.addChild(T(contIndent + (dimBody ? theme.fg("dim", line) : line)));
  }
  return c;
}

// 旧格式 cmd-done 文本反解析（只给历史消息回放兜底——2026-09-13 起 executes.ts 发送时随 details 带结构化字段，
// 渲染器优先读 details，不再靠正则从格式化文本里把 elapsed/exit/cmd/output 抠回来）。
// 返回 { kind:"hw", tool, elapsedSec, nextSteps } 或 { kind:"done", status, cmd, elapsedSec, exitCode, output, recId, remaining }
export function parseLegacyCmdDone(raw) {
  const s = String(raw ?? "");
  const hw = s.match(/^(hibernate|wait)\s+完成\s*\((\d+)s\)(?:\n([\s\S]*))?$/);
  if (hw) return { kind: "hw", tool: hw[1], elapsedSec: parseInt(hw[2], 10), nextSteps: (hw[3] || "").trim() };
  const st = { kind: "done", status: "done", cmd: "", elapsedSec: 0, exitCode: undefined, output: "", recId: "", remaining: 0 };
  const ds = s.match(/^(.*?)\s*\((\d+)s,\s*exit\s+(\d+)\):\n\$\s+(.*?)\n([\s\S]*)$/);          // 完成/Done/Terminal 完成 (Ns, exit N):\n$ cmd\n…
  const fail = s.match(/^Command (failed|killed by user)\s*\((\d+)s\):\n\$\s+(.*?)\n([\s\S]*)$/); // Command failed (Ns):
  const mb = s.match(/^\s*mobile\s*完成\s*\((\d+)s\):\n([\s\S]*)$/);                                 // mobile 完成 (Ns):
  const to = s.match(/^(?:超时|Timeout)\s*\((\d+)min\):\n\$\s+(.*?)(?:\n([\s\S]*))?$/);              // 超时 (Nmin):\n$ cmd
  const term = s.match(/^Terminal (?:已终止|terminated)\s*(?:\((\d+)s\))?/);                          // Terminal 已终止 (Ns) - …
  if (ds) { st.elapsedSec = parseInt(ds[2], 10); st.exitCode = parseInt(ds[3], 10); st.cmd = ds[4].split("\n")[0].trim(); st.output = ds[5] || ""; }
  else if (fail) { st.status = "failed"; st.elapsedSec = parseInt(fail[2], 10); st.cmd = fail[3].split("\n")[0].trim(); st.output = fail[4] || ""; }
  else if (mb) { st.elapsedSec = parseInt(mb[1], 10); st.cmd = "mobile"; st.output = mb[2] || ""; }
  else if (to) { st.status = "timeout"; st.elapsedSec = parseInt(to[1], 10) * 60; st.cmd = to[2].split("\n")[0].trim(); st.output = to[3] || ""; }
  else if (term) { st.status = "terminated"; st.elapsedSec = term[1] ? parseInt(term[1], 10) : 0; st.output = s; }
  else { st.cmd = "execute"; st.output = s; }
  const idm = s.match(/\[id:\s*([A-Za-z0-9-]+)\]/);
  st.recId = idm ? idm[1] : "";
  const rem = s.match(/\[remaining:\s*(\d+)\]/);
  st.remaining = rem ? parseInt(rem[1], 10) : 0;
  // [id:] 可能不在尾部（ISSUE 168：后面还跟 [remaining:]）——任意位置剥；其余尾标签整组剥
  st.output = stripResultTokenMark(stripInlineBgTag(st.output).replace(/\n*\[id:\s*[A-Za-z0-9-]+\]/g, "")).trim();
  return st;
}

