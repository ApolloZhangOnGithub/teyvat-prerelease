import { Box, Container, getCapabilities, Image, Spacer, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createAllToolDefinitions } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";
import { initBlockrender, dot as blockDot, renderToolCall, renderMessage, isToolError, GUTTER } from "./blocks_nongod.js";
import { mkdirSync } from "node:fs";
import { debug } from "#gene_riboswitch";
// ESM 下 require 未定义：显式建垫片。原先裸用 require() 会在执行到时抛错，
// 而 Makefile 的 ESM 检查因 glob 失效一直没抓到（2026-07-29 修）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
initBlockrender(Text, Container, visibleWidth, wrapTextWithAnsi);
// 从文件路径推断语言（用于代码高亮）
function langFromPath(p) {
  if (!p) return undefined;
  const ext = p.split('.').pop()?.toLowerCase();
  const map = { ts:'typescript', js:'javascript', py:'python', sh:'bash', bash:'bash', zsh:'bash',
    json:'json', yaml:'yaml', yml:'yaml', md:'markdown', html:'html', css:'css', sql:'sql',
    rs:'rust', go:'go', java:'java', c:'c', cpp:'cpp', h:'c', hpp:'cpp', rb:'ruby', swift:'swift' };
  return map[ext] || ext;
}

// 对代码行做高亮（返回高亮后的行数组，失败返回 null）
function hlLines(code, path) {
  const hl = globalThis.__genshinHighlightCode;
  if (!hl) return null;
  return hl(code, langFromPath(path));
}

// diff 背景色 & 装饰色 — 与 Claude Code dark theme 完全一致
const BG_ADDED = "\x1b[48;2;2;40;0m";
const BG_REMOVED = "\x1b[48;2;61;1;0m";
const FG_ADD_DECO = "\x1b[38;2;80;200;80m";
const FG_DEL_DECO = "\x1b[38;2;220;90;90m";
const FG_DEFAULT = "\x1b[38;2;248;248;242m";
function bgLine(text, bgAnsi) {
  return bgAnsi + text.replace(/\x1b\[(?:0?m|49m)/g, (m) => m + bgAnsi) + "\x1b[49m";
}
// bulletText 容器缩进："  ⎿  " = GUTTER(2) + ⎿(1) + space(1) + separator(1) = 5
const DIFF_CONTAINER_INDENT = 5;
function buildDiffLines(content, lineNum, marker, decorFg) {
    const termWidth = process.stdout.columns || 80;
    const lnLen = lineNum.length;
    const gutterWidth = 1 + lnLen + 1 + 1;
    const lineWidth = termWidth - DIFF_CONTAINER_INDENT - gutterWidth;
    const contentWidth = Math.max(10, lineWidth);
    let wrapped;
    try {
        wrapped = wrapTextWithAnsi(content, contentWidth);
        if (!wrapped || !wrapped.length) wrapped = [content];
    } catch { wrapped = [content]; }
    const result = [];
    for (let i = 0; i < wrapped.length; i++) {
        const ln = i === 0 ? lineNum : ' '.repeat(lnLen);
        result.push(`${decorFg} ${ln} ${marker}\x1b[39m` + wrapped[i]);
    }
    return result;
}

const _genshinBuiltinRenderers = {
    read: {
        renderShell: "self",
        renderCall: (args, t) => renderToolCall.label(t, "Read", args?.file_path || args?.path || ""),
        renderResult: (result, _opts, t, ctx) => {
            if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
            const raw = (result?.content || [])[0]?.text || "";
            const elapsed = _opts?.elapsedMs ? ` ${t.fg("muted", `[${elapsedStr(_opts.elapsedMs)}]`)}` : "";
            const filePath = _opts?.args?.file_path || _opts?.args?.path || "";
            // 解析 "Read  XX lines (lines YYY-ZZZ)" → 高亮数字
            const m = raw.match(/^Read\s+(\d+)\s+lines\s+\(lines\s+(\d+)-(\d+)\)/);
            if (m) {
                const actualLines = parseInt(m[3]) - parseInt(m[2]) + 1;
                const summary = `Read ${t.bold(String(actualLines))} lines (lines ${t.bold(m[2])}-${t.bold(m[3])})${elapsed}`;
                // Read 开关权限最高：__genshinReadExpanded !== true 时折叠，全局 Tool 输出展开也压不住（UX 冲突修复）
                if (globalThis.__genshinReadExpanded !== true) return renderMessage.summary(t, ctx, summary);
                const rawLines = raw.split("\n").slice(1);
                const codeLines = [];
                const hintLines = [];
                for (const l of rawLines) {
                    if (/^\[\d+\s+more\s+lines\s+in\s+file\.\s+Use\s+offset=\d+\s+to\s+continue\.\]$/.test(l)) {
                        hintLines.push(t.fg("dim", l));
                    } else {
                        codeLines.push(l);
                    }
                }
                const hlBody = hlLines(codeLines.join("\n"), filePath);
                const bodyLines = hlBody ? hlBody : codeLines;
                const body = [...bodyLines, ...hintLines].join("\n");
                return renderMessage.summary(t, ctx, summary + (body ? "\n" + body : ""));
            }
            // pi's Read: raw content without header — count lines for summary
            if (raw) {
                const rawLines = raw.split("\n");
                const codeLines = [];
                const hintLines = [];
                for (const l of rawLines) {
                    if (/^\[\d+\s+more\s+lines\s+in\s+file\.\s+Use\s+offset=\d+\s+to\s+continue\.\]$/.test(l)) {
                        hintLines.push(t.fg("dim", l));
                    } else {
                        codeLines.push(l);
                    }
                }
                const lineCount = codeLines.length;
                const fileName = filePath ? filePath.split('/').pop() : "";
                // xattr 编辑链
                let metaSuffix = "";
                if (filePath) {
                  try {
                    const { execSync } = require("child_process");
                    const raw = execSync(`xattr -p com.genshin.meta "${filePath}"`, { encoding: "utf8", timeout: 1000, stdio: ["ignore","pipe","ignore"] });
                    const meta = JSON.parse(raw.trim());
                    const last = meta?.edits?.[meta.edits.length-1]?.agent || meta?.created?.agent;
                    if (last) metaSuffix = ` ` + theme.fg("dim", `[last editor: ${last}]`);
                  } catch {
                    // xattr 属性缺失/损坏：last-editor 是可选装饰，失败静默（文件无 com.genshin.meta 属性是常态，不刷日志）
                  }
                }
                const summary = `Read ${t.bold(String(lineCount))} lines${fileName ? " from " + fileName : ""}${metaSuffix}${elapsed}`;
                // Read 开关权限最高（同第一处）
                if (globalThis.__genshinReadExpanded !== true) return renderMessage.summary(t, ctx, summary);
                const hlBody = hlLines(codeLines.join("\n"), filePath);
                const bodyLines = hlBody ? hlBody : codeLines;
                const body = [...bodyLines, ...hintLines].join("\n");
                return renderMessage.summary(t, ctx, summary + "\n" + body);
            }
            const rawHd = ((result?.content || [])[0]?.text || "").split("\n")[0] || "";
            const hd = rawHd.replace(/\s+/g, " ").replace(/(\d+)/g, m => t.bold(m));
            return renderMessage.summary(t, ctx, hd);
        },
    },
    write: {
        renderShell: "self",
        renderCall: (args, t, ctx) => {
            const fp = args?.file_path || args?.path || "";
            const err = ctx?.isError || ctx?.hasTextError;
            const label = fp || (err ? "" : (args?.content ? t.fg("dim", "(model is thinking about path)") : ""));
            return renderToolCall.label(t, "Write", label);
        },
        renderResult: (result, _opts, t, ctx) => {
            if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
            const filePath = _opts?.args?.file_path || _opts?.args?.path || "";
            const fileContent = _opts?.args?.content || "";
            const fileLines = fileContent.split("\n").filter(l => l.trim());
            const num = fileLines.length || 1;
            const hlResult = hlLines(fileContent, filePath);
            const writeMaxW = (process.stdout.columns || 80) - DIFF_CONTAINER_INDENT;
            const lnPad = 3;
            const gutterW = lnPad + 2;
            const contentW = Math.max(10, writeMaxW - gutterW);
            const numbered = fileLines.map((l, i) => {
                const hl = hlResult ? hlResult[i] || l : l;
                let wrapped;
                try {
                    wrapped = wrapTextWithAnsi(hl, contentW);
                    if (!wrapped || !wrapped.length) wrapped = [hl];
                } catch { wrapped = [hl]; }
                return wrapped.map((wl, wi) => {
                    const ln = wi === 0 ? String(i+1).padStart(lnPad) : ' '.repeat(lnPad);
                    return `${t.fg("dim", ln)}  ${wl}`;
                }).join("\n");
            }).join("\n");
            const elapsed = _opts?.elapsedMs ? ` ${t.fg("muted", `[${elapsedStr(_opts.elapsedMs)}]`)}` : "";
            const summary = `Wrote ${t.bold(String(num))} ${num !== 1 ? "lines" : "line"}${elapsed}`;
            return renderMessage.summary(t, ctx, summary + "\n" + numbered);
        },
    },
    edit: {
        renderShell: "self",
        renderCall: (args, t, ctx) => {
            const fp = args?.file_path || args?.path || "";
            const err = ctx?.isError || ctx?.hasTextError;
            const label = fp || (err ? "" : ((args?.old_string || args?.edits) ? t.fg("dim", "(model is thinking about path)") : ""));
            return renderToolCall.label(t, "Edit", label);
        },
        renderResult: (result, _opts, t, ctx) => {
            if (ctx?.isError) return renderMessage.summary(t, { isError: true }, (result?.content || [])[0]?.text);
            if (process.env.DETAIL_EDIT === "0") return renderMessage.silent();
            const diff = result?.details?.diff;
            if (!diff) return renderMessage.silent();
            // pi diff 格式: "+NNN content" / "-NNN content" / " NNN content"（绝对行号内嵌）
            // 也兼容 unified diff 的 @@ header
            const lines = diff.split("\n");
            let added = 0, removed = 0;
            let oldLn = 0, newLn = 0;
            const entries = [];
            const parseLine = (s) => {
                const m = s.match(/^(\s*\d+)\s(.*)/);
                return m ? { num: m[1], content: m[2] } : { num: null, content: s };
            };
            const filePath = _opts?.args?.file_path || _opts?.args?.path || "";
            for (const l of lines) {
                const hm = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
                if (hm) { oldLn = parseInt(hm[1]) - 1; newLn = parseInt(hm[3]) - 1; continue; }
                if (l.startsWith("---") || l.startsWith("+++")) continue;
                if (l.startsWith("+")) {
                    added++;
                    const p = parseLine(l.slice(1));
                    const ln = p.num || String(++newLn).padStart(4);
                    const hl = hlLines(p.content, filePath);
                    const content = hl ? hl[0] || p.content : p.content;
                    entries.push({d: true, lines: buildDiffLines(content, ln, "+", FG_ADD_DECO), bg: BG_ADDED});
                } else if (l.startsWith("-")) {
                    removed++;
                    const p = parseLine(l.slice(1));
                    const ln = p.num || String(++oldLn).padStart(4);
                    entries.push({d: true, lines: buildDiffLines(FG_DEFAULT + p.content, ln, "-", FG_DEL_DECO), bg: BG_REMOVED});
                } else if (l.startsWith(" ") || l === "") {
                    const p = parseLine(l.slice(1));
                    const raw = (p.content || "").trim();
                    if (!raw || raw === "...") continue;
                    const ln = p.num || String(++newLn).padStart(4);
                    if (!p.num) oldLn++;
                    const hl = hlLines(p.content, filePath);
                    const content = hl ? hl[0] || p.content : p.content;
                    entries.push({d: false, line: t.fg("dim", ` ${ln}  ${content}`)});
                }
            }
            const termW = process.stdout.columns || 80;
            const diffPadW = termW - DIFF_CONTAINER_INDENT;
            const body = [];
            for (const e of entries) {
                if (e.d) {
                    for (const l of e.lines) {
                        const vw = visibleWidth(l);
                        const pad = vw < diffPadW ? ' '.repeat(diffPadW - vw) : '';
                        body.push(bgLine(l + pad, e.bg));
                    }
                } else {
                    body.push(e.line);
                }
            }
            const elapsed = _opts?.elapsedMs ? ` ${t.fg("muted", `[${elapsedStr(_opts.elapsedMs)}]`)}` : "";
            const summary = `Added ${t.bold(String(added))} ${added !== 1 ? "lines," : "line,"} removed ${t.bold(String(removed))} ${removed !== 1 ? "lines" : "line"}${elapsed}`;
            return renderMessage.summary(t, ctx, summary + "\n" + body.join("\n"));
        },
    },
};

function elapsedStr(ms) {
  const s = ms / 1000;
  if (s < 1) return `${s.toPrecision(1)}s`;
  if (s < 10) return `${s.toPrecision(2)}s`;
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
export class ToolExecutionComponent extends Container {
    contentBox;
    contentText;
    selfRenderContainer;
    callRendererComponent;
    resultRendererComponent;
    rendererState = {};
    imageComponents = [];
    imageSpacers = [];
    toolName;
    toolCallId;
    args;
    expanded = false;
    showImages;
    imageWidthCells;
    isPartial = true;
    toolDefinition;
    builtInToolDefinition;
    ui;
    cwd;
    executionStarted = false;
    argsComplete = false;
    result;
    convertedImages = new Map();
    hideComponent = false;
    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {
        super();
        this.toolName = toolName;
        this.toolCallId = toolCallId;
        this.args = args;
        this.toolDefinition = toolDefinition;
        this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName];
        if (_genshinBuiltinRenderers[toolName]) {
            const override = _genshinBuiltinRenderers[toolName];
            this.builtInToolDefinition = { ...this.builtInToolDefinition, ...override };
            this.toolDefinition = { ...(toolDefinition || {}), ...override };
        }
        this.showImages = options.showImages ?? true;
        this.imageWidthCells = options.imageWidthCells ?? 60;
        this.ui = ui;
        // 每工具独立展开开关（默认展开）
        const expandKey = `__genshinExpand_${toolName}`;
        if (globalThis[expandKey] === false) this.expanded = false;
        // Read 内容展开开关（/u 面板可调，默认折叠=不展开文件内容）
        if (toolName === "read" && globalThis.__genshinReadExpanded !== true) this.expanded = false;
        this.cwd = cwd;
        // 从 UI 首次出现开始计时（含模型流式输出 tool call 参数的时间），而非 tool_execution_start
        this._execStartTime = Date.now();
        this._showedSpinner = false;
        this.addChild(new Spacer(1));
        // Always create all shell variants. contentBox is used for default renderer-based composition.
        // selfRenderContainer is used when the tool renders its own framing.
        // contentText is reserved for generic fallback rendering when no tool definition exists.
        // teyvat: paddingX/Y 都设 0 —— paddingX=1 会把 • 推到第 1 列(和说话顶格 col0 不对齐);
        // paddingY=1 会在工具块上下各加一个空行(配合 Spacer(1) 就是 2 个,光污染)。归 0 后:
        // • 顶格对齐说话,块间留白只靠那一个 Spacer(1)。
        this.contentBox = new Box(0, 0, (text) => theme.bg("toolPendingBg", text));
        this.contentText = new Text("", 1, 1, (text) => text); // 透明背景
        this.selfRenderContainer = new Container();
        if (this.hasRendererDefinition()) {
            this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
        }
        else {
            this.addChild(this.contentText);
        }
        this.updateDisplay();
    }
    getCallRenderer() {
        if (!this.builtInToolDefinition) {
            return this.toolDefinition?.renderCall;
        }
        if (!this.toolDefinition) {
            return this.builtInToolDefinition.renderCall;
        }
        return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
    }
    getResultRenderer() {
        if (!this.builtInToolDefinition) {
            return this.toolDefinition?.renderResult;
        }
        if (!this.toolDefinition) {
            return this.builtInToolDefinition.renderResult;
        }
        return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
    }
    hasRendererDefinition() {
        return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
    }
    getRenderShell() {
        if (!this.builtInToolDefinition) {
            return this.toolDefinition?.renderShell ?? "default";
        }
        if (!this.toolDefinition) {
            return this.builtInToolDefinition.renderShell ?? "default";
        }
        return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
    }
    getRenderContext(lastComponent) {
        return {
            args: this.args,
            toolCallId: this.toolCallId,
            invalidate: () => {
                this.invalidate();
                this.ui.requestRender();
            },
            lastComponent,
            state: this.rendererState,
            cwd: this.cwd,
            executionStarted: this.executionStarted,
            argsComplete: this.argsComplete,
            isPartial: this.isPartial,
            expanded: this.expanded,
            showImages: this.showImages,
            toolName: this.toolName,
            isError: this.result?.isError ?? false,
            hasTextError: (() => { try { const t = (this.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); return /could not find|not found|error|failed|invalid|禁止|请先|还有|任务在运行|拒绝/i.test(t); } catch { return false; } })(),
        };
    }
    getToolSubtitle(args) {
        if (!args || typeof args !== 'object') return '';
        // Try title, query, name, url, file_path in order.
        for (const k of ['title', 'query', 'name', 'url', 'file_path', 'path']) {
            const v = args[k];
            if (typeof v === 'string' && v.length > 0 && v.length < 80) return ' ' + v;
        }
        return '';
    }
    createCallFallback() {
        const dot = blockDot(theme, { partial: this.isDotPartial(), error: this.isDotError() });
        const displayName = this.toolName.charAt(0).toUpperCase() + this.toolName.slice(1);
        let text = dot + " " + theme.fg("toolTitle", theme.bold(displayName));
        // 显示文件名/路径
        const sub = this.getToolSubtitle(this.args);
        if (sub) text += " " + sub;
        this._resultInlined = false;
        // 短 result 并到同一行（wait/hibernate/nap/sleep 一行就完的，当 subtitle）。
        // bioclock 在结果尾部追加 \n[时:分:秒 +Xs]，把它单独剥出来；正文若是单行短文本，就连同
        // 时间戳一起并到标题行（之前直接判 includes('\n') 会因为时间戳那一行而判定多行，把整条挤到第二行或被吃掉）。
        if (this.result && !this.isPartial) {
            const out = this.getTextOutput();
            if (out) {
                const tsMatch = out.match(/\n(\[\d{2}:\d{2}:\d{2}[^\]]*\])\s*$/);
                const ts = tsMatch ? tsMatch[1] : "";
                const body = (tsMatch ? out.slice(0, tsMatch.index) : out).trimEnd();
                // hibernate/wait 不显示时间戳
                const noTs = this.toolName === 'next' || this.toolName === 'wait' || this.toolName === 'hibernate';
                if (body.length < 100 && !body.includes('\n')) {
                    const inlErr = isToolError(this.toolName, body, { isError: this.result?.isError, toolCallId: this.toolCallId });
                    text += "  " + theme.fg(inlErr ? "error" : "toolOutput", body) + (noTs ? "" : (ts ? " " + theme.fg("muted", ts) : ""));
                    this._resultInlined = true;
                }
            }
        }
        return new Text(text, 0, 0);
    }
    createResultFallback() {
        let output = this.getTextOutput();
        if (!output) return undefined;
        if (this.toolName === 'next') {
            output = output.replace(/\n\[\d{2}:\d{2}:\d{2}[^\]]*\]\s*$/g, '');
        }
        // 统一走 bulletText 管线，保证折行与工具调用行一致
        return renderMessage.output(theme, { isError: !!this.result?.isError }, [{ type: "text", text: output }]);
    }
    updateArgs(args) {
        // 2026-08-20 修复（最终版）：工具参数流式/异步到达时，updateArgs 可能先收到空参数——
        // 空渲染的组件被下方"已有 call 行只更新 dot"逻辑缓存，后续完整参数到达时不重建 →
        // 调用行永远显示空渲染（如 hibernate 只显示 `• Hibernate`）。
        // 修复："空→非空"转变时清一次缓存（强制用完整 args 重建），_argsSettled 保证只触发一次，
        // 后续非空→非空变化不清缓存（避免 updateArgs 高频时每次重建导致闪烁）。
        if ((!this.args || Object.keys(this.args).length === 0) && args && Object.keys(args).length > 0 && !this._argsSettled) {
            this._argsSettled = true;
            this.callRendererComponent = null;
        }
        this.args = args;
        this.updateDisplay();
        this.ui.requestRender();
    }
    markExecutionStarted() {
        if (!this.executionStarted) {
            this._execStartTime = Date.now();
        }
        this.executionStarted = true;
        this.updateDisplay();
        this.ui.requestRender();
    }
    setArgsComplete() {
        this.argsComplete = true;
        // 2026-08-20 修复：工具参数流式/异步到达时，updateArgs 可能先收到空参数，空渲染的组件被
        // 下方"已有 call 行只更新 dot"逻辑缓存 → 后续完整参数到达时不重建 → 调用行永远显示空渲染
        // （如 hibernate 只显示 `• Hibernate`）。参数完整标记到达时清缓存，强制用完整 args 重建一次
        // （setArgsComplete 只调一次 → 只重建一次，不闪烁；updateArgs 保持不重建）。
        this.callRendererComponent = null;
        this.updateDisplay();
        this.ui.requestRender();
    }
    /**
     * 黄点判定（2026-08-13 用户规范：进行中/等待中 = 黄色）：
     * 1) 无结果/流式中 → partial
     * 2) wait：工具已返回（terminate），但 heart 还在 resting（倒计时未结束）→ 仍进行中
     * 3) hibernate：heart 还在 hibernated（休眠未醒）→ 仍进行中
     * 4) execute：该任务的 recId 仍在后台运行集合中（异步/终端未完成）→ 仍进行中
     */
    /** 红点判定（统一管线 2026-08-15）。
     *  - result.isError 可靠时只信它（read/write/edit 等 pi 内置工具）。
     *  - Paimon 工具（wait/hibernate/execute/amem）的 tool_execution_end 常不带 isError
     *    （pi 对扩展工具不传），必须按各自已知的错误形态从结果文本检测。
     *  - 判定逻辑已收敛到 blocks_nongod 的 isToolError(toolName, text, ctx) 单一入口，
     *    新工具错误形态只需在那加一行，这里不再分派。
     *  - 2026-08-13 修复误报：此前对所有工具做宽泛文本猜测（含 error/failed/invalid 等词），
     *    Read 正常文件内容里出现这些词就把点染红——猜测只保留给 isError 不可靠的 Paimon 工具，
     *    且用行首锚定的精确模式。 */
    isDotError() {
        try {
            const t = (this.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
            return isToolError(this.toolName, t, { isError: this.result?.isError, toolCallId: this.toolCallId });
        } catch { /* 无文本内容 */ }
        if ((this.toolName === "wait" || this.toolName === "hibernate") && this.toolCallId && globalThis.__genshinWaitInterruptedId === this.toolCallId) {
            // 2026-09-07（WIKI 规范收敛）：wait_for_user:true 被打断 = 用户来了 = 正常恢复 → 绿点（非 error）；
            // 只有异常中断（esc/命令等）才红点。旧实现无条件红，与 WIKI 判据不一致。
            if (globalThis.__genshinWaitInterruptedForUser === true) return false;
            return true;
        }
        return false;
    }
    isDotPartial() {
        if (!this.result || this.isPartial) return true;
        const hs = globalThis.__genshinHeartState;
        if (this.toolName === "wait" && hs === "resting") return true;
        if (this.toolName === "hibernate" && hs === "hibernated") return true;
        if (this.toolName === "execute") {
            const recId = this.result?.details?.recId;
            if (recId) {
                const s = globalThis.__genshinBgRunningRecIds;
                if (s && s.has(recId)) return true;
            }
        }
        return false;
    }
    updateResult(result, isPartial = false) {
        this.result = result;
        this.isPartial = isPartial;
        this.updateDisplay();
        this.maybeConvertImagesForKitty();
    }
    maybeConvertImagesForKitty() {
        const caps = getCapabilities();
        if (caps.images !== "kitty")
            return;
        if (!this.result)
            return;
        const imageBlocks = this.result.content.filter((c) => c.type === "image");
        for (let i = 0; i < imageBlocks.length; i++) {
            const img = imageBlocks[i];
            if (!img.data || !img.mimeType)
                continue;
            if (img.mimeType === "image/png")
                continue;
            if (this.convertedImages.has(i))
                continue;
            const index = i;
            convertToPng(img.data, img.mimeType).then((converted) => {
                if (converted) {
                    this.convertedImages.set(index, converted);
                    this.updateDisplay();
                    this.ui.requestRender();
                }
            });
        }
    }
    setExpanded(expanded) {
        this.expanded = expanded;
        this.updateDisplay();
    }
    setShowImages(show) {
        this.showImages = show;
        this.updateDisplay();
    }
    setImageWidthCells(width) {
        this.imageWidthCells = Math.max(1, Math.floor(width));
        this.updateDisplay();
    }
    invalidate() {
        super.invalidate();
        this.updateDisplay();
    }
    render(width) {
        const viewMode = globalThis.__piViewMode || "full";
        if (viewMode === "clean") return [];
        if (viewMode === "fold" && !this.expanded) {
            const args = this.args || {};
            const dot = blockDot(theme, { partial: this.isDotPartial(), error: this.isDotError() });
            const capName = this.toolName.charAt(0).toUpperCase() + this.toolName.slice(1);
            let summary = dot + " " + capName;
            if (args.command) summary += ' ' + String(args.command).split("\n")[0].slice(0, 80);
            else if (args.file_path) summary += ' ' + args.file_path;
            else if (args.path) summary += ' ' + args.path;
            else if (args.query) summary += ' ' + args.query;
            else if (args.url) summary += ' ' + args.url;
            if (this.result && !this.isPartial) summary += this.result.isError ? " ✗" : " ✓";
            else if (this.executionStarted || this.isPartial) summary += " …";
            return [summary];
        }
        if (this.hideComponent) {
            return [];
        }
        if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
            const contentLines = this.selfRenderContainer.render(width);
            if (contentLines.length === 0 && this.imageComponents.length === 0) {
                return [];
            }
            const lines = [];
            if (contentLines.length > 0) {
                lines.push("");
                lines.push(...contentLines);
            }
            for (let i = 0; i < this.imageComponents.length; i++) {
                const spacer = this.imageSpacers[i];
                if (spacer) {
                    lines.push(...spacer.render(width));
                }
                const imageComponent = this.imageComponents[i];
                if (imageComponent) {
                    lines.push(...imageComponent.render(width));
                }
            }
            return lines;
        }
        return super.render(width);
    }
    updateDisplay() {
        const bgFn = (text) => text; // 透明背景
        let hasContent = false;
        this.hideComponent = false;
        if (this.hasRendererDefinition()) {
            const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
            if (renderContainer instanceof Box) {
                renderContainer.setBgFn(bgFn);
            }
            renderContainer.clear();
            const callRenderer = this.getCallRenderer();
            if (!callRenderer) {
                renderContainer.addChild(this.createCallFallback());
                hasContent = true;
            }
            else {
                // 已有 call 行则只更新 dot，不重建（防 updateArgs 二次渲染）
                if (this.callRendererComponent && !this.result) {
                    const dot = blockDot(theme, { partial: this.isDotPartial(), error: this.isDotError() });
                    (function replaceDot(node) {
                        if (node && typeof node.text === 'string' && (node.text.includes('•') || node.text.includes('◦'))) {
                            node.text = node.text.replace(/[•◦]/, dot);
                        }
                        if (node && typeof node.children !== 'undefined') {
                            for (const child of node.children) replaceDot(child);
                        }
                    })(this.callRendererComponent);
                    hasContent = true;
                } else {
                try {
                    const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
                    this.callRendererComponent = component;
                    // 展开视图：把 • 替换成带状态颜色的版本（递归处理 Text 和 Box 子节点）
                    const dot = blockDot(theme, { partial: this.isDotPartial(), error: this.isDotError() });
                    (function replaceDot(node) {
                        if (node && typeof node.text === 'string' && (node.text.includes('•') || node.text.includes('◦'))) {
                            node.text = node.text.replace(/[•◦]/, dot);
                        }
                        if (node && typeof node.children !== 'undefined') {
                            for (const child of node.children) replaceDot(child);
                        }
                    })(component);
                    renderContainer.addChild(component);
                    hasContent = true;
                }
                catch (err) {
                    // LESSON 024 根治（2026-08-20）：渲染失败必须可见——不再用 createCallFallback 伪装成
                    // 正常工具名（fallback 掩盖真实错误，theme.dim TypeError 被吞 3 轮排查才找到）。
                    // 直接显示错误形态：红点 + 工具名 + 错误消息，让渲染 bug 一眼暴露。
                    console.error(`[tool-execution] renderCall 失败 (${this.toolName}):`, err?.message || err);
                    try { globalThis.__genshinDlog?.(`renderCall fail (${this.toolName}): ${err?.message}`); } catch (e) { console.error("[god.frontend.tui/overrides/modes/interactive/components/tool-execution.js] " + (e?.message || e)); }
                    this.callRendererComponent = undefined;
                    renderContainer.addChild(renderToolCall.label(theme,
                        this.toolName.charAt(0).toUpperCase() + this.toolName.slice(1),
                        "✗ " + ((err?.message || "renderCall failed").split("\n")[0]),
                        { error: true }));
                    hasContent = true;
                }
                } // end else-try-catch
            }
            // 2026-08-14：被打断的折线由组件自己画——位置天然跟在 wait 调用行后面，
            // 秒数取组件自己的参数（此前发自定义消息会漂移成旧 wait 的秒数、插到错误位置）。
            if ((this.toolName === "wait" || this.toolName === "hibernate")
                && this.toolCallId && globalThis.__genshinWaitInterruptedId === this.toolCallId) {
                const secs = globalThis.__genshinWaitInterruptedSecs ?? this.args?.seconds ?? "?";
                const reason = globalThis.__genshinWaitInterruptedReason;
                const reasonLabel = { esc: "ESC", user: "user message", system: "task completed", sleep: "sleep cycle", reload: "reload", shutdown: "shutdown", command: "/pause" };
                const reasonStr = reason ? ` (${reasonLabel[reason] || reason})` : "";
                const forUser = globalThis.__genshinWaitInterruptedForUser === true;
                const color = (forUser || reason === "system" || reason === "user") ? "success" : "error";
                renderContainer.addChild(new Text(" ".repeat(GUTTER) + theme.fg(color, `⎿  Waited ${secs}s${reasonStr}`), 0, 0));
                hasContent = true;
            }
            if (this.result) {
                // 结果到达 → 把 call 行的 ◦（partial）换成正确的状态点
                if (this.callRendererComponent) {
                    const fixDot = blockDot(theme, { error: this.isDotError(), partial: this.isDotPartial() });
                    (function replaceDot(node) {
                        if (node && typeof node.text === 'string' && (node.text.includes('•') || node.text.includes('◦'))) {
                            node.text = node.text.replace(/[•◦]/, fixDot);
                            if (typeof node.invalidate === 'function') node.invalidate();
                        }
                        if (node && typeof node.children !== 'undefined') {
                            for (const child of node.children) replaceDot(child);
                        }
                    })(this.callRendererComponent);
                }
                // 跟踪是否展示过 spinner（意味着结果异步到达）
                if (this.result?.details?.loading) {
                    this._showedSpinner = true;
                }
                // 缓存已完成的 result 渲染组件——避免每次 updateDisplay 重建导致闪烁
                if (this._cachedResultComponent && !this.isPartial) {
                    renderContainer.addChild(this._cachedResultComponent);
                    hasContent = true;
                } else {
                const resultRenderer = this.getResultRenderer();
                if (!resultRenderer) {
                    if (!this._resultInlined) {
                        const component = this.createResultFallback();
                        if (component) {
                            renderContainer.addChild(component);
                            hasContent = true;
                            if (!this.isPartial) this._cachedResultComponent = component;
                        }
                    }
                }
                else {
                    try {
                        const ctx = this.getRenderContext(this.resultRendererComponent);
                        ctx.isAsync = this._showedSpinner;
                        const component = resultRenderer({ content: this.result.content, details: this.result.details }, { expanded: this.expanded, isPartial: this.isPartial, args: this.args, elapsedMs: this._execStartTime ? Date.now() - this._execStartTime : undefined }, theme, ctx);
                        this.resultRendererComponent = component;
                        renderContainer.addChild(component);
                        hasContent = true;
                        if (!this.isPartial) this._cachedResultComponent = component;
                    }
                    catch {
                        this.resultRendererComponent = undefined;
                        if (!this._resultInlined) {
                            const component = this.createResultFallback();
                            if (component) {
                                renderContainer.addChild(component);
                                hasContent = true;
                            }
                        } else { hasContent = true; }
                    }
                }
                } // end else (no cache)
            }
        }
        else {
            this.contentText.setCustomBgFn(bgFn);
        }
        for (const img of this.imageComponents) {
            this.removeChild(img);
        }
        this.imageComponents = [];
        for (const spacer of this.imageSpacers) {
            this.removeChild(spacer);
        }
        this.imageSpacers = [];
        if (this.result) {
            const imageBlocks = this.result.content.filter((c) => c.type === "image");
            const caps = getCapabilities();
            for (let i = 0; i < imageBlocks.length; i++) {
                const img = imageBlocks[i];
                if (caps.images && this.showImages && img.data && img.mimeType) {
                    const converted = this.convertedImages.get(i);
                    const imageData = converted?.data ?? img.data;
                    const imageMimeType = converted?.mimeType ?? img.mimeType;
                    if (caps.images === "kitty" && imageMimeType !== "image/png")
                        continue;
                    const spacer = new Spacer(1);
                    this.addChild(spacer);
                    this.imageSpacers.push(spacer);
                    const imageComponent = new Image(imageData, imageMimeType, { fallbackColor: (s) => theme.fg("toolOutput", s) }, { maxWidthCells: this.imageWidthCells });
                    this.imageComponents.push(imageComponent);
                    this.addChild(imageComponent);
                }
            }
        }
        if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
            this.hideComponent = true;
        }
    }
    getTextOutput() {
        return getRenderedTextOutput(this.result, this.showImages);
    }
    formatToolExecution() {
        let text = theme.fg("toolTitle", theme.bold(this.toolName.charAt(0).toUpperCase() + this.toolName.slice(1)));
        const content = JSON.stringify(this.args, null, 2);
        if (content) {
            text += `\n\n${content}`;
        }
        const output = this.getTextOutput();
        if (output) {
            text += `\n${output}`;
        }
        return text;
    }
}
//# sourceMappingURL=tool-execution.js.map