# check-sync-ua.cjs.SPEC

用途: 门禁 —— 打到 sync 服务（**Cloudflare 后面**）的请求必须带 `User-Agent`。

来历（同类事故第二次）:
- 2026-09-07：Linux 机器连不上 sync server，排查 20 分钟，根因是 Cloudflare Bot Management **Error 1010**：
  拦截无/默认 UA 的请求；当时修了 TS 侧（`client.ts` 的 apiFetch、`communicate.ts` 全部 6 处 fetch）。
- **2026-09-11 prime-agent 又发现三处漏网**（都是 `.cjs` CLI 与登录流程，09-07 那次没覆盖到）：
  | 位置 | 后果 |
  |---|---|
  | `god.frontend.cli/devices.cjs`（所有调用经 `H()` helper） | `genshin d` 设备列表/改名/上传：`HTTP 403` |
  | `god.frontend.cli/upload-state.cjs`（POST `/auth/device-state`） | 本机 genshin 输出上传失败（且**静默**：catch 吞掉） |
  | `god.frontend.cli/cli.ts` device-flow 登录两处（`/auth/device-flow/start`、`/poll`） | `genshin login` 策略2 直接 403 |
  实测（同一个 token，同一个端点）：`GET /auth/devices` **不带 UA → 403 "error code: 1010"**，**带 UA → 200**。
  修后实测 `genshin d` 正常输出 5 台设备（3 台在线，`最后活跃` 为当前时刻）。

判定:
1. 扫 `A.core` 下 `.ts/.js/.cjs/.mjs/.sh` 里的 `fetch(` 与 `curl`（curl 需命中 sync 域名）
2. 调用的上下文（±10 行）须涉及 sync 端点（`sync.paimon.beer` / `syncEndpoint(` / `/auth/` / `/sync/` / `/messages/`）
   - 纯 `localhost`/`127.0.0.1`（本地隧道，不过 Cloudflare）→ 跳过
   - 走 `apiFetch()` / `fetchBackend.fetch()`（用户自配后端）→ 视为安全
3. 同一上下文里必须出现 `User-Agent` / `SYNC_UA` / `-A` / `--user-agent`，
   或该调用使用了**本文件里自带 UA 的 headers helper**（如 devices.cjs 的 `H()`）
4. 一个候选都扫不到 → **FAIL**（fail-closed：防止重构后门禁静默失效）

实测：243 个文件、22 处 sync 请求、22 处带 UA → PASS。
负向验证：夹具里写一个不带 UA 的 `fetch("https://sync.paimon.beer/auth/devices", ...)` → exit 1 并点名。

统一出口: `A.core/paths.ts` 导出 `SYNC_UA = "genshin-sync/1.0"`（唯一真相源），`apiFetch()` 对未显式设置
UA 的调用**自动补默认值**（2026-09-11 加，纵深防御）；`communicate.ts` 已改为 import 该常量。
