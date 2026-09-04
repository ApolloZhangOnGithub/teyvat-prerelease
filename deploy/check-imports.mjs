// check-imports.mjs — verify ESM import/export compatibility between override files
// Only checks imports where BOTH the importer and the target are overridden by genshin.
// Upstream-to-upstream imports are not our problem.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { homedir } from "node:os";

const PI_DIST = join(homedir(), ".local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/dist"); // 2026-08-13 修正：曾指向旧 genshin 树（残留目录导致假通过）
if (!existsSync(PI_DIST)) { console.error("  ERROR  runtime dist not found"); process.exit(1); }

const OVERRIDES = new Set([
  "main.js",
  "modes/interactive/interactive-mode.js",
  "modes/interactive/components/footer.js",
  "modes/interactive/components/tool-execution.js",
  "modes/interactive/components/model-selector.js",
  "modes/interactive/components/assistant-message.js",
  "core/agent-session.js",
  "core/system-prompt.js",
  "core/package-manager.js",
  "core/exec.js",
  "core/extensions/loader.js",
  "core/tools/execute.js",
  "core/tools/edit.js",
  "core/tools/read.js",
  "core/tools/write.js",
  "core/tools/ls.js",
  "core/tools/grep.js",
  "core/tools/find.js",
]);

let errors = 0;

for (const entry of OVERRIDES) {
  const fullPath = join(PI_DIST, entry);
  if (!existsSync(fullPath)) continue;
  const code = readFileSync(fullPath, "utf8");
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    const names = m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const specifier = m[2];
    const targetAbs = resolve(dirname(fullPath), specifier);
    const targetRel = relative(PI_DIST, targetAbs);
    if (!OVERRIDES.has(targetRel)) continue;
    if (!existsSync(targetAbs)) continue;
    const targetCode = readFileSync(targetAbs, "utf8");
    for (const name of names) {
      const exportPatterns = [
        new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`),
        new RegExp(`export\\s+(abstract\\s+)?class\\s+${name}\\b`),
        new RegExp(`export\\s+(const|let|var)\\s+${name}\\b`),
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
        new RegExp(`export\\s+default\\s+.*\\b${name}\\b`),
      ];
      if (!exportPatterns.some(p => p.test(targetCode))) {
        console.error(`  ERROR  ${entry} imports '${name}' from ${specifier} — not exported`);
        errors++;
      }
    }
  }
}

if (errors > 0) {
  process.exit(1);
} else {
  console.log("  OK  import/export check");
}
