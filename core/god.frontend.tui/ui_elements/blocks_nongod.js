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

// 状态点（工具用）：进行=◦(accent) / 错=•(error) / 成功=•(success)。统一在这里，别各处各写。
// 2026-08-14 用户定稿：进行中/等待中（partial）本身是空心黄 ◦，为美观统一用实心黄 •。
// 空心语义保留在此注释：未完成=空心，完成/出错=实心。
export function dot(theme, opts) {
  const o = opts || {};
  // 2026-08-13 用户规范：进行中/等待中 = 黄色（warning），错误 = 红，成功 = 绿
  if (o.partial) return theme.fg("warning", "•"); // 原 ◦（空心黄，语义=未完成），2026-08-14 为美观改实心
  if (o.error) return theme.fg("error", "•"); // •
  return theme.fg("success", "•"); // •
}

// 菱形标记（收到的消息用：Result 推送 / Social Message / 通知类）。与 dot 同语义：进行=◇ / 错=◆ / 成功=◆。
// 视觉区分：主动调用的工具行用圆点 dot，被动收到的消息用菱形 diamond。
export function diamond(theme, opts) {
  const o = opts || {};
  if (o.partial) return theme.fg("accent", "◇"); // ◇
  if (o.error) return theme.fg("error", "◆"); // ◆
  return theme.fg("success", "◆"); // ◆
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
    if (/^(?:Traceback|[A-Za-z]+Error|ERR:)/m.test(t) || /\(exit [1-9]\d*\)/.test(t)) return true;
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
  if ((toolName === "wait" || toolName === "hibernate") && ctx?.toolCallId && globalThis.__genshinWaitInterruptedId === ctx.toolCallId) return true;
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
  const pm = stripped.match(/^(\s*(?:(?:[•◦●○$⎿]|\d+\s*│)\s+|\d+\s*[+\- ]|\s*\d+\t)?)/);
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
    const pm = stripped.match(/^(\s*(?:(?:[•◦●○$⎿]|\d+\s*│)\s+|\d+\s*[+\- ]|\s*\d+\t)?)/);
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
function bulletText(dotStr, text, cont) {
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
      const firstPrefix = rawLines[0].replace(/\x1b\[[0-9;]*m/g, '').match(/^(\s*(?:(?:[•◦●○$⎿]|\d+\s*│)\s+|\d+\s*[+\- ]|\s*\d+\t)?)/)?.[0] || '';
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
            // 该行已有竖线行号前缀（`1 │` 格式）→ 不再加 indentW（避免 execute/social 双重缩进）
            // 其余（diff 行号 `\d+[+- ]`、bullet 前缀等）保持原行为不变
            const ownStripped = l.replace(/\x1b\[[0-9;]*m/g, '');
            const isLineNoBar = /^\s*\d+\s*│/.test(ownStripped);
            const pad = isLineNoBar ? 0 : indentW;
            return lineWrapped.map((line, j) => {
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
export function lineNumbered(text, theme, lang) {
  const rawText = String(text ?? "");
  if (!rawText) return "";
  const lines = rawText.split("\n");
  const gutterWidth = String(lines.length).length;
  const fmtLineNo = (n) => theme.fg("dim", String(n).padStart(gutterWidth) /* + " │ " 竖线（用户：无竖线更漂亮，暂注释）*/ + "  ");
  const hl = globalThis.__genshinHighlightCode;
  const hlResult = lang && hl ? hl(rawText, lang) : null;
  const indent = "  ";
  return lines.map((l, i) => {
    const hlLine = hlResult ? hlResult[i] || l : l;
    return `${indent}${fmtLineNo(i + 1)}${hlLine}`;
  }).join("\n");
}

export const renderToolCall = {
  // ◦ Label  detail  — 续行裸缩进（⎿ 只用于结果行）
  // opts.error → 红色 • 点
  label(theme, name, detail, opts) {
    const d = dot(theme, opts || { partial: true });
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
    const d = dot(theme, opts || { partial: true });
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
function stripResultTokenMark(text) {
  return String(text ?? "").replace(/\n*\[result\s+[\d.]+[kM]?\s*tokens?(?:,\s*(?:ctx|contexted)\s+[\d.]+[kM]?)?\]\s*$/, "");
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
    const prefix = indent + (err ? theme.fg("error", "⎿ ") : theme.fg("dim", "⎿ "));
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
    const prefix = indent + (err ? theme.fg("error", "⎿ ") : theme.fg("dim", "⎿ "));
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

