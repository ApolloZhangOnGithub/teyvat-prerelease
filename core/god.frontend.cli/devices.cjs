#!/usr/bin/env node
// devices.cjs — genshin d 设备管理（2026-09-05 抽离 launcher 内联，launcher d 分支调用）
// 用法: node devices.cjs                  → 列表
//       node devices.cjs rn <id> <名>     → 改名
//       node devices.cjs <name|编号|id>  → 查看该设备的 genshin 快照（server 已存各设备上传状态，不做远程执行）
const fs = require("fs");
const os = require("os");
const h = os.homedir();

function readBinding() {
  try { return JSON.parse(fs.readFileSync(h + "/.teyvat/UserAccount/binding.json", "utf8")); }
  catch { console.error("未绑定：先 genshin login"); process.exit(1); }
}
function endpoint() {
  let e = "https://sync.paimon.beer";
  try { const s = JSON.parse(fs.readFileSync(h + "/.teyvat/UserAccount/services.json", "utf8")); if (s.services && s.services["genshin-sync"] && s.services["genshin-sync"].endpoint) e = s.services["genshin-sync"].endpoint; } catch { /* services.json 缺失/损坏 → 用默认 sync.paimon.beer */ }
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s) => { if (!s) return ""; const dt = new Date(String(s).replace(" ", "T") + (String(s).includes("Z") ? "" : "Z")); if (isNaN(dt)) return String(s); return dt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).replace(/\//g, "-"); };

async function main() {
  const b = readBinding();
  const ep = endpoint();
  // 2026-09-11（prime-agent）：必须带 User-Agent —— sync.paimon.beer 在 Cloudflare 后面，
  // 无 UA 会被 Bot Management 拒：实测 `GET /auth/devices` 不带 UA → 403 "error code: 1010"，带 UA → 200。
  // 09-07 那次修的是 TS 侧（client.ts apiFetch / communicate.ts），漏了这些 .cjs CLI。
  const SYNC_UA = "genshin-sync/1.0";
  const H = (extra = {}) => ({ Authorization: "Bearer " + b.token, "X-Device-Id": b.deviceId, "User-Agent": SYNC_UA, ...extra });
  const cmd = process.argv[2] || "";
  const curId = b.deviceId;

  // 触发本机 genshin 结果上传（独立进程 spawn detached——父进程不等，查看不拖慢；2026-09-05）
  try { require("child_process").spawn(process.execPath, [__dirname + "/upload-state.cjs"], { detached: true, stdio: "ignore" }).unref(); } catch { /* 上传失败静默 */ }
  // 拉设备列表（快——秒回显示）
  const lr = await fetch(ep + "/auth/devices", { headers: H({ "X-Device-Name": os.hostname() }) });
  if (!lr.ok) { console.log("server 查询失败: HTTP " + lr.status); process.exit(1); }
  const ds = (await lr.json()).devices || [];
  const isActive = (s) => { if (!s) return false; const dt = new Date(String(s).replace(" ", "T") + (String(s).includes("Z") ? "" : "Z")); return !isNaN(dt) && (Date.now() - dt.getTime()) < 5 * 60 * 1000; };
  // 排序：当前置顶 + last_seen 降序
  const ds2 = [...ds].sort((a, bb) => {
    const ac = String(a.device_id) === curId, bc = String(bb.device_id) === curId;
    if (ac && !bc) return -1; if (bc && !ac) return 1;
    const ta = Date.parse(String(a.last_seen_at || "").replace(" ", "T") + "Z") || 0;
    const tb = Date.parse(String(bb.last_seen_at || "").replace(" ", "T") + "Z") || 0;
    return tb - ta;
  });
  let nOn = 0, nOff = 0;
  const devs = ds2.map((d) => {
    const online = String(d.device_id) === curId || isActive(d.last_seen_at);
    const n = online ? ++nOn : ++nOff;
    return { d, id: String(d.device_id), name: String(d.device_name && d.device_name !== d.device_id ? d.device_name : ""), num: n, on: online };
  });

  // 列表
  if (!cmd) {
    const { pad, vw } = require('./pad.cjs'); // 标准 pad（2026-09-05 用户：统一 pad.cjs，勿自写）
    const H1 = "名称", H2 = "设备 ID", H3 = "首绑", H4 = "最后活跃";
    const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[0m";
    console.log("当前绑定: " + b.githubLogin + (b.boundAt ? (" (绑定于 " + fmt(b.boundAt) + ")") : ""));
    console.log("账号绑定设备 (" + ds.length + "):");
    const wNm = Math.max(vw(H1), ...devs.map((x) => vw(x.name)));
    const wId = Math.max(vw(H2), ...devs.map((x) => vw(x.id)));
    console.log("    " + pad(H1, wNm) + "  " + pad(H2, wId) + "  " + pad(H3, 19) + "  " + H4);
    for (const x of devs) {
      const c = x.on ? G : Y;
      const mark = x.on ? "[在线]" : "[离线]";
      const cur = x.id === curId ? " ◀" : "";
      console.log(c + pad(String(x.num) + "·", 3) + " " + pad(x.name, wNm) + "  " + pad(x.id, wId) + "  " + pad(fmt(x.d.created_at) || fmt(x.d.last_seen_at) || "", 19) + "  " + fmt(x.d.last_seen_at) + "  " + mark + cur + R);
    }
    return;
  }

  // 改名
  if (cmd === "rn") {
    const id = process.argv[3], name = process.argv[4];
    if (!id || !name) { console.log("用法: genshin d rn <设备ID> <名称>"); process.exit(1); }
    const res = await fetch(ep + "/auth/devices/" + id, { method: "PUT", headers: H({ "Content-Type": "application/json" }), body: JSON.stringify({ name }) });
    const j = await res.json().catch(() => ({}));
    console.log(res.ok ? ("设备 " + id + " 已命名为: " + name) : ("改名失败: " + (j.error || res.status)));
    return;
  }

  // 查看某设备的 genshin（agent 清单）——server 已存各设备上传状态，直接拉 0.3s（不做远程执行）
  const target = cmd;
  let hit = devs.find((x) => x.id === target) || (target && devs.find((x) => x.name === target)) || null;
  if (!hit && /^\d+$/.test(target)) {
    const n = parseInt(target, 10);
    hit = devs.find((x) => x.num === n && x.on) || devs.find((x) => x.num === n && !x.on) || devs.find((x) => x.num === n);
  }
  if (!hit) { console.log("找不到设备: " + target + "（用名称/编号/ID，列表看 genshin d）"); process.exit(1); }
  // 显示该设备上传的 genshin 结果（跑 genshin 的实际输出——用户定稿语义）
  const raw = hit.d.agents;
  const txt = typeof raw === "string" && raw ? raw : (Array.isArray(raw) ? raw.map((a) => (a && a.name) || "?").join("\n") : "");
  const snap = hit.d.synced_at ? fmt(hit.d.synced_at) : "";
  if (!txt) { console.log("── " + (hit.name || hit.id) + " 的 genshin" + (snap ? " (快照 " + snap + ")" : "") + ": (该设备还没上传 genshin 结果——设备活跃同步后自动上传)"); return; }
  console.log("── " + (hit.name || hit.id) + " 的 genshin" + (snap ? " (快照 " + snap + ")" : "") + ": ──");
  console.log(txt);
}

main().catch((e) => console.error("devices: " + (e && e.message || e)));
