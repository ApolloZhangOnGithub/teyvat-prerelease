// teyvat 覆盖: pi 的 changelog.js（2026-08-18）
// 问题: 未覆盖时 getChangelogPath() 返回 pi 的 CHANGELOG.md（pi 包根目录），
// 启动 What's New 会显示 pi 的更新日志（如 [0.80.7]）——teyvat 有自己的
// CHANGELOG.KEYLOGS 体系，pi 的更新日志对用户是噪音。
// 修复: getChangelogPath 返回一个不存在的路径 → parseChangelog 返回空 → What's New 不显示。
// 注意: 本文件镜像覆盖 pi 包的 dist/utils/changelog.js，所以必须完整实现全部导出
// （不能 re-export 被覆盖的原版）；其余函数与 pi 原版一致。
// SPEC: changelog.js.SPEC
import path from "node:path";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";

export function getChangelogPath() {
  // teyvat: 返回不存在的路径，让 What's New 不显示 pi 的更新日志。
  // 若未来要显示 teyvat 自己的 changelog，改这里指向 CHANGELOG.KEYLOGS 即可
  //（注意版本体系：teyvat 0.3.x 与 pi 0.80.x 不兼容，需配套调整 getNewEntries）。
  return path.join(os.homedir(), ".teyvat", "CHANGELOG-does-not-exist.md");
}

export function normalizeChangelogLinks(markdown, version) {
  return markdown; // teyvat 不显示 pi changelog，链接归一化无调用方；保持幂等
}

export function parseChangelog(changelogPath) {
  if (!existsSync(changelogPath)) {
    return [];
  }
  try {
    const content = readFileSync(changelogPath, "utf-8");
    const lines = content.split("\n");
    const entries = [];
    let currentLines = [];
    let currentVersion = null;
    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (currentVersion && currentLines.length > 0) {
          entries.push({ ...currentVersion, content: currentLines.join("\n").trim() });
        }
        const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
        if (versionMatch) {
          currentVersion = {
            major: Number.parseInt(versionMatch[1], 10),
            minor: Number.parseInt(versionMatch[2], 10),
            patch: Number.parseInt(versionMatch[3], 10),
          };
          currentLines = [line];
        } else {
          currentVersion = null;
          currentLines = [];
        }
      } else if (currentVersion) {
        currentLines.push(line);
      }
    }
    if (currentVersion && currentLines.length > 0) {
      entries.push({ ...currentVersion, content: currentLines.join("\n").trim() });
    }
    return entries;
  } catch {
    return [];
  }
}

export function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  return v1.patch - v2.patch;
}

export function getNewEntries(entries, lastVersion) {
  const parts = lastVersion.split(".").map(Number);
  const last = { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, content: "" };
  return entries.filter((entry) => compareVersions(entry, last) > 0);
}
