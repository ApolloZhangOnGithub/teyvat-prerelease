// apps/amap/amap.ts — 高德地图 MobileApp
import type { MobileApp } from "../../system.kernel/kernel.ts";
import { execFileSync } from "node:child_process";

const SCRIPT = `${__dirname}/amap.ts-support.py`;

function run(cmd: string): string {
  try {
    // 2026-09-11（prime-agent）安全修复：原来是 `execSync(`python3 ${SCRIPT} ${cmd}`)` —— **未加引号**地把
    // agent 通过 mobile 工具传进来的文本拼进 shell：`cmd` 里的 `;` / `$()` / 反引号都会被执行，
    // 而且这条路径**不经过** validateExecute（execute 工具才走守卫）→ 等于绕过了"禁止 rm / 禁止碰他人数据目录"。
    // 改为 execFileSync + argv 数组（完全不经 shell）。调用方（onAction）本来就是按空白分词拼 cmd 的，
    // 所以这里按空白切词与原先的 shell 分词语义等价。
    const args = cmd.trim().split(/\s+/).filter(Boolean);
    return execFileSync("python3", [SCRIPT, ...args], { timeout: 15000 }).toString().trim();
  } catch (e: any) {
    return `错误: ${e.message}`;
  }
}

export const app: MobileApp = {
  name: "amap",
  icon: "地图",
  messageDescription: "高德地图：near/route/weather",

  onOpen(state: any) {
    return {
      screen: [
        "═══ 高德地图 ═══",
        "",
        "near 关键词      — 周边搜索",
        "route 起 到 方式 — 路线规划",
        "  walking/driving/transit/bicycling",
        "weather 城市     — 天气预报",
        "",
        "例: near 咖啡",
        "    route 家 公司 driving",
      ].join("\n"),
      state,
    };
  },

  async onAction(input: string, state: any) {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0];
    let result = "";

    if (cmd === "near") result = run(`near ${parts.slice(1).join(" ")}`);
    else if (cmd === "route") result = run(`route ${parts[1]} ${parts[2]} ${parts[3] || "transit"}`);
    else if (cmd === "weather") result = run(`weather ${parts[1] || ""}`);
    else if (cmd === "where") result = run("where");
    else result = run(`near ${input}`);

    return { screen: result + "\n\n输入命令继续，或「返回」退出", state };
  },
};
