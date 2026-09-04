#!/usr/bin/env node
// fix-tmp-logs.cjs — 批量迁移 catch 兜底错误日志（/tmp/genshin-catch-errors.log → ~/.teyvat/LogData/...）
// 用户定稿：永远不用 tmp。全局扫描发现 7 处兜底日志写 /tmp，统一迁到 LogData。
const fs = require("fs");
const path = require("path");

const files = [
  "A.core/god.frontend.tui/overrides/modes/interactive/interactive-mode.js",
  "A.core/god.frontend.tui/overrides/pi-dist/core/package-manager.js",
  "A.core/god.frontend.tui/overrides/pi-dist/core/extensions/loader.js",
  "A.core/god.frontend.tui/ui_elements/footer.js",
  "A.core/universe.infotech/cloud.servers/playleft.cjs",
  "A.core/universe.infotech/cloud.servers/browser_service.cjs",
];
const base = "/Users/zhangkezhen/Agent Intelligence/MODERN/TEYVAT/teyvat-main";
const OLD = '"/tmp/genshin-catch-errors.log"';
const NEW = '(process.env.HOME||"")+"/.teyvat/LogData/genshin-catch-errors.log"';

let total = 0;
for (const rel of files) {
  const abs = path.join(base, rel);
  const src = fs.readFileSync(abs, "utf8");
  const n = src.split(OLD).length - 1;
  if (n === 0) { console.log(`无匹配: ${rel}`); continue; }
  fs.writeFileSync(abs + ".bak-fix-tmp", src);
  fs.writeFileSync(abs, src.split(OLD).join(NEW));
  total += n;
  console.log(`替换 ${n} 处: ${rel}`);
}
console.log(`共 ${total} 处 /tmp 兜底日志已迁移到 LogData`);
