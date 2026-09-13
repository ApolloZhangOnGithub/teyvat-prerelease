// god.frontend.tui/ui_elements/rich-clipboard.js
// 2026-09-14（用户）：/copy 富文本剪贴板——拷贝回复时同时写 HTML flavor（markdown 渲染版）
// 和纯文本 flavor。粘贴到 Notion/Obsidian/Apple Notes/JupyterLab 等富文本 app 时保留渲染
// 格式（代码块/列表/加粗/标题），粘贴到纯文本编辑器时仍是 markdown 源码——双 flavor 各取所需。
//
// ⚠️ 本文件是唯一源，同一内容存两处（部署映射不同，都要能被解析到）：
//   1. god.frontend.tui/ui_elements/rich-clipboard.js        ← A.core 内解析（check-resolve 门禁）
//   2. god.frontend.tui/overrides/pi-dist/ui_elements/rich-clipboard.js ← 部署到 pi-coding-agent/ui_elements/
//      （interactive-mode.js 部署后在 pi dist 包根，import "../../../ui_elements/rich-clipboard.js" 指到这里）
// 改动时两处同步（diff 应为零）。
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { marked } from "marked";

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** markdown → HTML。代码块输出 <pre><code class="language-xxx">，粘贴端（Obsidian/Notion/Jupyter 等）负责高亮渲染。 */
export function mdToHtml(md) {
  try {
    const body = marked.parse(md);
    // 整条回复包成一个连续 block——粘贴到富文本 app 时作为一组完整内容
    return `<div class="teyvat-copy">\n${body}\n</div>`;
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

/**
 * 富文本剪贴板写入：
 * - macOS：osascript 一次写双 flavor（string + «class HTML»）——内容经临时文件中转（避免命令行转义地狱）
 *   ⚠️ 实测（00:38）：string 必须放在 record 前位——HTML 在前时纯文本 flavor 会被 HTML 内容占用（pbpaste 读到 HTML 源码）
 * - Linux：wl-copy / xclip 的 text/html（尽力）
 * - 任何失败返回 false，调用方应回退纯文本拷贝（copyToClipboard）
 */
export async function copyRich(markdown) {
  const html = mdToHtml(markdown);
  if (platform() === "darwin") {
    try {
      const dir = join(homedir(), ".teyvat", "RuntimeCache");
      const htmlFile = join(dir, "clipboard-rich.html");
      const txtFile = join(dir, "clipboard-rich.txt");
      writeFileSync(htmlFile, html, "utf8");
      writeFileSync(txtFile, markdown, "utf8");
      const script =
        `set htmlText to (read POSIX file "${htmlFile}" as «class utf8»)\n` +
        `set plainText to (read POSIX file "${txtFile}" as «class utf8»)\n` +
        `set the clipboard to {string: plainText, «class HTML»: htmlText}`;
      execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  // Linux（Wayland / X11）
  try {
    if (process.env.WAYLAND_DISPLAY) {
      execFileSync("wl-copy", ["-t", "text/html"], {
        input: html, stdio: ["pipe", "ignore", "ignore"], timeout: 5000,
      });
      return true;
    }
    execFileSync("xclip", ["-selection", "clipboard", "-t", "text/html", "-i"], {
      input: html, stdio: ["pipe", "ignore", "ignore"], timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
