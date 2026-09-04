// ── help 工具：按需查询工具用法 ─────────────────────────────────────────────
// 设计（2026-08-15，memory-control-developer-01）：
//   系统提示只给每个工具一行摘要（manifest desc），完整用法按需查：
//     help              → 按 group 列出全部工具 + 一句话摘要
//     help <name>       → 显示该工具的完整说明（messageDescription + 参数）
//   好处：长说明不提前加载进 system prompt，agent 自己决定要不要细看。
//   数据源：manifest（desc/group/default）+ 注册时收集的 TOOL_HELP（detail）。
import { Type } from "@sinclair/typebox";
import { registerPaimonTool, getAllToolHelp, getToolHelp } from "#kernel_backbone";
import { getToolManifest } from "#kernel_ribosome";
import { i18n } from "#tui_localizations";
import { renderToolCall, renderMessage } from "#tui_blockrender";
const T = (zh: string, en: string) => i18n(zh, en);

export default function registerHelp(pi: any): void {
  registerPaimonTool({
    name: "help",
    label: "Help",
    messageDescription:
      "Query tool usage on demand. 'help' lists all tools with one-line summaries grouped by category; " +
      "'help <name>' shows the full usage for that tool (description + parameters). " +
      "The system prompt only carries one-line summaries — use this tool when you need details " +
      "about how a specific tool works (e.g. help mobile, help amem, help social).",
    promptSnippet: "help [tool name] — list all tools or show usage for one (e.g. help amem)",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ messageDescription: "Tool name to show full usage for (e.g. 'amem', 'mobile', 'social'). Omit to list all tools." })),
    }),
    renderCall: (args: any, theme: any) => {
      // ISSUE 122：原 theme?.["toolCall"]?.() 是错误 API（不存在，可选链静默返回 undefined → 调用行不可见）
      return renderToolCall.label(theme, "Help", args?.name || "");
    },
    renderResult: (result: any, _opts: any, theme: any, ctx: any) => {
      if (ctx?.isError || result?.isError) return renderMessage.summary(theme, { isError: true }, (result?.content || [])[0]?.text);
      const text = (result?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      return renderMessage.output(theme, ctx, [{ type: "text", text }]);
    },
    async execute(_toolCallId: string, { name }: any, _signal: any, _onUpdate: any, _ctx: any) {
      const manifest = getToolManifest();
      const tools = manifest?.tools || {};
      const helpAll = getAllToolHelp();
      const activeNames = new Set((pi?.getActiveTools?.() ?? []) as string[]);

      // ── 详情模式：help <name> ──
      if (name) {
        const nm = String(name).trim().toLowerCase();
        const mdef = tools[nm];
        const hdef = getToolHelp(nm) || helpAll[nm];
        if (!mdef && !hdef) {
          // 模糊匹配：列出相似名，帮 agent 找到正确拼写
          const similar = Object.keys(tools)
            .concat(Object.keys(helpAll))
            .filter((k) => k.includes(nm) || nm.includes(k))
            .slice(0, 8);
          const hint = similar.length ? `\n${T("相近工具", "Similar tools")}: ${similar.join(", ")}` : "";
          return { content: [{ type: "text", text: `ERR: help: unknown tool "${name}".${hint}\n${T("用 help 列出全部工具。", "Use help to list all tools.")}` }], isError: true, details: {} };
        }
        const status = activeNames.has(nm) ? T("激活", "active") : (mdef?.default === true ? T("默认启用", "enabled by default") : T("默认禁用（可用 /tools 会话级启用）", "disabled by default (enable per-session with /tools)"));
        const lines: string[] = [];
        lines.push(`## ${nm}${mdef?.group ? `  [${mdef.group}]` : ""}  — ${status}`);
        if (mdef?.desc) lines.push(`${T("摘要", "Summary")}: ${mdef.desc}`);
        const detail = hdef?.detail || "";
        if (detail) lines.push(`\n${detail}`);
        else lines.push(`\n${T("（暂无详细说明，摘要如上）", "(no detailed description; summary above)")}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { tool: nm } };
      }

      // ── 列表模式：help（无参）──
      const groups: Record<string, string[]> = {};
      const allNames = new Set([...Object.keys(tools), ...Object.keys(helpAll)]);
      for (const n of allNames) {
        const mdef = tools[n];
        if (mdef?.abandoned) continue; // 废弃工具不列
        const g = mdef?.group || "其他";
        (groups[g] = groups[g] || []).push(n);
      }
      const order = ["核心", "运行", "表达", "接受", "感官", "设备", "社交", "其他"];
      const lines: string[] = [`可用工具（${allNames.size} 个，help <name> 查看详情）:`];
      for (const g of order) {
        if (!groups[g]) continue;
        lines.push(`\n[${g}]`);
        for (const n of groups[g].sort()) {
          const mdef = tools[n];
          const desc = mdef?.desc || helpAll[n]?.desc || "";
          const mark = activeNames.has(n) ? "●" : (mdef?.default === true ? "○" : "·");
          lines.push(`  ${mark} ${n}${desc ? " — " + desc : ""}`);
        }
        delete groups[g];
      }
      // 剩余未归类组
      for (const g of Object.keys(groups).sort()) {
        lines.push(`\n[${g}]`);
        for (const n of groups[g].sort()) {
          const mdef = tools[n];
          const desc = mdef?.desc || helpAll[n]?.desc || "";
          lines.push(`  · ${n}${desc ? " — " + desc : ""}`);
        }
      }
      lines.push(`\n图例: ● 激活 / ○ 默认启用 / · 默认禁用`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { tools: allNames.size } };
    },
  });
}
