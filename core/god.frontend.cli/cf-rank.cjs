// cf-rank.cjs — Codeforces 风格履历段位（单一真相源）
// 被 list.cjs（genshin 默认列表）和 cli.ts（bun cli 入口）共用。
// 颜色 = 简单指标：按 tokenmaxxed 总量映射 CF 官方色（2015 "Second Revolution of Colors" 改革后）。
// 阈值按资历自然分布设计（Newbie<100K → Legendary>10B），传奇 = 多年老将专属。
//
// ⚠️ 改 genshin 列表渲染时：默认列表走 list.cjs（node），不是 cli.ts！改 cli.ts 列表不生效。
// ⚠️ 改阈值/颜色：只改这里的 CF_RANKS（status.ts / footer.js 有各自内联副本，需同步，见 B.docs/Status WIKI）。

const CF_RANKS = [
  { min: 0,            name: "Newbie",                 hex: "#808080" },
  { min: 100_000,      name: "Pupil",                  hex: "#008000" },
  { min: 1_000_000,    name: "Specialist",             hex: "#03A89E" },
  { min: 5_000_000,    name: "Expert",                 hex: "#0000FF" },
  { min: 20_000_000,   name: "Candidate Master",       hex: "#AA00AA" },
  { min: 80_000_000,   name: "Master",                 hex: "#FF8C00" },
  { min: 300_000_000,  name: "International Master",   hex: "#FF8C00" },
  { min: 1_000_000_000, name: "Grandmaster",           hex: "#FF0000" },
  { min: 3_000_000_000, name: "International Grandmaster", hex: "#FF0000" },
  { min: 10_000_000_000, name: "Legendary Grandmaster", hex: "#FF0000" },
];

function getCfRank(tok) {
  let r = CF_RANKS[0];
  for (const c of CF_RANKS) if (tok >= c.min) r = c;
  return r;
}

function cfAnsi(hex) {
  return `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
}

function cfPaint(hex, text) {
  return `${cfAnsi(hex)}${text}\x1b[0m`;
}

module.exports = { CF_RANKS, getCfRank, cfAnsi, cfPaint };
