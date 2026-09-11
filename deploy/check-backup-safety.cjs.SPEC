# check-backup-safety.cjs.SPEC

用途: 门禁 —— 云备份（restic）链路的加固断言。

## 背景（2026-09-11 prime-agent 审计 `god.frontend.cli/backup.ts`）

云备份是 2026-09-12 新上的功能（PROPOSAL 041）：`genshin b config|init|now|status`，restic → 阿里云 OSS（S3 兼容），
由 `brain.bioclock` 每日自动触发（detached 子进程）。审计发现三处该加固：

### ① 下载 restic 二进制**没有校验和**（原代码）

```ts
const sh = `curl -fsSL "${url}" | bunzip2 > "${RESTIC}" && chmod +x "${RESTIC}"`;
const r = spawnSync('bash', ['-c', sh], { stdio: 'inherit' });
```

拿到什么就执行什么 —— 而这个二进制随后会**拿着用户的 AccessKey 与仓库密码**去访问 OSS。
现改为：下载到 `.dl` → 用 `node:crypto` 算 SHA256 → 与**官方 SHA256SUMS（v0.19.1）**钉死的值比对 →
不符则删除文件 + 拒绝执行（fail-closed）；一致才解压 + `chmod 755`。

**实测核对**：官方 SHA256SUMS 里 `restic_0.19.1_darwin_arm64.bz2` = `7be0a144…`；
把该文件真下下来算哈希 → 一致；解压后 `bin/restic version` → `restic 0.19.1 compiled with go1.26.4 on darwin/arm64`
（本机 Homebrew 那份是 `go1.26.5`，反证下的是官方产物）。

### ② Windows 资产拼错（实测 404）

`resticArch()` 对 `win32` 返回 `windows_amd64`，代码统一拼 `.bz2` —— 而 release 里 Windows 是 `.zip`：

```
$ curl -I https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_windows_amd64.bz2
HTTP 404
```

即 Windows 上 `ensureRestic()` 永远失败（除非用户自己装了 restic）。现按 `kind: 'bz2' | 'zip'` 分派，
Windows 走 `unzip` 并把 `.exe` 改名成 `restic.exe`（spawn 需要后缀）。

### ③ 外部调用没有超时

- 下载：curl 无 `--max-time` → 卡住就一直挂着
- `runRestic()` 无 `timeout` → 网络卡住时 restic 永久挂起；而 `cmdNow` 是 bioclock **detached** 起的子进程，
  没人看得见 → 备份状态永远停在 `running`

现加：下载 `--max-time 300 --retry 2`；`runRestic` `timeout: 30min` + `killSignal: SIGTERM`。

## 本门禁做什么

- 静态 20 项：校验和表（≥5 条、64 位十六进制、含实测值）、`sha256File` 用 node:crypto、
  **顺序断言**（比对在解压前）、不符则删文件 + 拒绝执行、旧「curl | bunzip2」写法已消失（断言前先**去注释**，否则注释里提到旧写法会误报 —— 第一版踩过）、
  Windows `.zip`/`unzip`/`.exe`、下载与 restic 调用的超时、密码与凭证文件 600、密钥只走 env 不进 argv
- 动态 1 项：抽真实的 `sha256File` 算 `sha256("abc")` → 必须等于 `ba7816bf…`（证明它确实按字节算文件哈希）
- 负向：夹具删掉整个校验分支 → 3 条 FAIL → exit 1
