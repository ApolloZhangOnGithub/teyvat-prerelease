// arxiv.ts — Arxiv 论文搜索 (MobileApp)
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const TOOL = join(import.meta.dirname || ".", "arxiv-search.py");

export const app: MobileApp = {
  name: "arxiv",
  icon: "Arxiv",
  messageDescription: "论文搜索: 搜索 xxx [-n 数量]",
  quickActions: [
    { action: "搜索", description: "搜索论文" },
  ],
  onOpen(state: any) {
    return { screen: [
      "Arxiv 论文搜索",
      "",
      "  搜索 关键词      搜论文 (默认5篇)",
      "  搜索 关键词 -n 10 搜10篇",
      "  返回             回主屏幕",
    ].join("\n"), state };
  },
  async onAction(input: string, state: any) {
    const cmd = input.trim();
    if (cmd === "返回") return { screen: "", state, exit: true };
    if (cmd.startsWith("搜索 ") || cmd.startsWith("search ")) {
      const rest = cmd.replace(/^(搜索 |search )/, "");
      const parts = rest.split(/\s+/);
      let query = "";
      let n = "5";
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "-n" && parts[i + 1]) { n = parts[i + 1]; i++; }
        else query += parts[i] + " ";
      }
      query = query.trim();
      if (!query) return { screen: "用法: 搜索 <关键词> [-n N]", state };
      try {
        // 2026-09-11（prime-agent）安全修复：原来是 execSync 拼 shell（`python3 "${TOOL}" "${query}" -n ${n}`）——
        // query 是 agent 输入，双引号挡不住 `$()`/反引号展开、query 里带 `"` 还能破引号逃逸；
        // 而且这条路径不经过 validateExecute。改为 argv 数组（不经 shell）。
        const r = execFileSync("python3", [TOOL, query, "-n", n], { encoding: "utf8", timeout: 15000 });
        return { screen: r || "(无结果)", state };
      } catch (e: any) {
        return { screen: `搜索失败: ${e.stderr || e.message}`, state };
      }
    }
    return { screen: "用法: 搜索 <关键词> [-n N] | 返回", state };
  },
};
