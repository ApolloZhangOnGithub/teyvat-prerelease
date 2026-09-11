// backup.ts — genshin b / backup：teyvat 云备份（restic 快照 → 对象存储）
//
// 用户 2026-09-12 指派；设计见 PROPOSAL 041（B.docs/Dev.Common/Proposals/）。
// 动机：teyvat 的 SessionData/MemoryData 属"程序自己管理、用户无法保护"的数据——
//       需要一层独立于 teyvat 进程、且"删不动"的备份（Claude Code 静默删 674 会话的教训）。
//
// 配置：$PAIMON_HOME/UserAccount/services.json 的 backup 段（legacy: config/services.json 回退）
// 凭证：$PAIMON_HOME/config/backup/（restic-pass 仓库密码 + cred.json AK，均 600）
//       —— AK 不进 services.json（避免明文密钥与普通配置混放）
// 仓库：restic 直连阿里云 OSS 的 S3 兼容端点（省依赖；兼容有问题再退 rclone）
// 触发：手动 `genshin b ...`；自动挂 brain.bioclock（每日）
// 失败：best-effort 静默（本地日志 + 上报），绝不阻断主流程
//
// 子命令：
//   genshin b                → 状态（未配置则进入配置引导）
//   genshin b config         → 配置（交互问答 / 或 --endpoint= --bucket= --access-key-id= --access-key-secret=）
//   genshin b init           → 首次初始化（生成仓库密码 + restic init）
//   genshin b now            → 立即备份一次
//   genshin b status         → 查看状态（快照数/大小/上次备份）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const H = os.homedir();
// 与 launcher/doctor/cli 同源：PAIMON_HOME 优先（沙箱/多实例必须正确）——禁止硬编码 ~/.teyvat
const PAIMON = process.env.PAIMON_HOME || path.join(H, '.teyvat');
const UA_SERVICES = path.join(PAIMON, 'UserAccount', 'services.json');
const LEGACY_SERVICES = path.join(PAIMON, 'config', 'services.json');
const BACKUP_DIR = path.join(PAIMON, 'config', 'backup');
const PASS_FILE = path.join(BACKUP_DIR, 'restic-pass');
const CRED_FILE = path.join(BACKUP_DIR, 'cred.json');
const STATE_DIR = path.join(PAIMON, 'LogData');
const LOG_FILE = path.join(STATE_DIR, 'backup.log');
// 状态文件（2026-09-12 用户定稿：genshin 裸命令看板的状态行数据源，launcher 非阻塞读）
// state: "configured-no-snapshot" | "ok" | "failed"（"未配置"由 launcher 实时判 services.json——不依赖本文件）
const STATUS_FILE = path.join(PAIMON, 'RuntimeCache', 'backup-status.json');
const BIN_DIR = path.join(PAIMON, 'bin');
const RESTIC = path.join(BIN_DIR, process.platform === 'win32' ? 'restic.exe' : 'restic');
const REPO_PREFIX = 'teyvat-restic';

const BOLD = '\x1b[1m', D = '\x1b[90m', G = '\x1b[32m', Y = '\x1b[33m', RED = '\x1b[31m', R = '\x1b[0m';
const LANG = process.env.PAIMON_LANG || (process.env.LANG?.includes('zh_CN') ? 'zh' : 'en');
const ZH = LANG === 'zh';
const T = (a: string, b: string) => (ZH ? a : b);

// ── 备份内容（走 PAIMON_HOME，任一不存在则跳过）──
const CRITICAL = ['SessionData', 'MemoryData', 'AgentFileData', 'config', 'UserAccount', 'auth.json', 'settings.json', 'version.json'];
const BULK = ['AgentWorkDir', 'BlackboxData'];

// ── 配置读写 ─────────────────────────────────────────────────────────
// 读：UserAccount 优先、legacy 回退（动态判断——文件可能后续才建）
// 写：**总是写 UserAccount**（新位置）——否则新环境会把配置永久落在 legacy
function svcPath(): string { return fs.existsSync(UA_SERVICES) ? UA_SERVICES : LEGACY_SERVICES; }
function readServices(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(svcPath(), 'utf8')); } catch { return {}; /* 无配置/坏 JSON → 空对象 */ }
}
function writeServices(patch: Record<string, any>): void {
  const svc = readServices();   // 含 legacy 内容（若读的是 legacy）——写入时自然迁移到新位置
  Object.assign(svc, patch);
  fs.mkdirSync(path.dirname(UA_SERVICES), { recursive: true });
  const tmp = UA_SERVICES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(svc, null, 2));
  fs.renameSync(tmp, UA_SERVICES);
}
function getBackupConf(): any | null {
  const b = readServices().backup;
  if (!b || typeof b !== 'object' || !b.bucket || !b.endpoint) return null;
  return b;
}
function readCred(): any {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return {}; /* 无凭证文件 → 空对象 */ }
}
function writeCred(c: any): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch { /* 非 POSIX 忽略 */ }
}

// ── restic 二进制（存在则用，否则 curl 对应架构）─────────────────────
function resticBin(): string | null {
  if (fs.existsSync(RESTIC)) return RESTIC;
  for (const p of ['/opt/homebrew/bin/restic', '/usr/local/bin/restic', '/usr/bin/restic']) {
    if (fs.existsSync(p)) return p;
  }
  const w = spawnSync('which', ['restic'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  return null;
}
function resticArch(): string | null {
  const p = process.platform, a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'darwin_arm64' : 'darwin_amd64';
  if (p === 'linux') return a === 'arm64' ? 'linux_arm64' : 'linux_amd64';
  if (p === 'win32') return 'windows_amd64';
  return null;
}
// 2026-09-11（prime-agent）三处加固：
//   ① 原来 `curl … | bunzip2 > restic && chmod +x` —— **拿到什么就执行什么**（用的是用户的 AK 与仓库密码的身份）。
//      现在按官方 SHA256SUMS（v0.19.1）钉死校验和，用 node:crypto 自己算，不一致就删文件 + 报错（fail-closed）。
//      校验和来源：https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS
//      （darwin_arm64 那份**实测下载后算过哈希对得上**：7be0a144…）
//   ② Windows 资产是 .zip，原来拼 .bz2 → **实测 HTTP 404**：Windows 上永远下不动（还有 restic 无 .exe 后缀也起不来）。
//   ③ 下载与 restic 调用都加超时：cmdNow 是 bioclock detached 起的子进程，卡住没人看得见（状态会永远停在 running）。
const RESTIC_VER = '0.19.1';
const RESTIC_SHA256: Record<string, { file: string; sha: string; kind: 'bz2' | 'zip' }> = {
  darwin_amd64: { file: `restic_${RESTIC_VER}_darwin_amd64.bz2`, sha: 'c38d579622cf602f665234c5a8c315030b6cf70656028fe6dc29a786b60e5f35', kind: 'bz2' },
  darwin_arm64: { file: `restic_${RESTIC_VER}_darwin_arm64.bz2`, sha: '7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143', kind: 'bz2' },
  linux_amd64: { file: `restic_${RESTIC_VER}_linux_amd64.bz2`, sha: 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c', kind: 'bz2' },
  linux_arm64: { file: `restic_${RESTIC_VER}_linux_arm64.bz2`, sha: 'a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465', kind: 'bz2' },
  windows_amd64: { file: `restic_${RESTIC_VER}_windows_amd64.zip`, sha: 'da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d', kind: 'zip' },
};
function sha256File(p: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
/** 从 release 下载 restic 并**校验官方 SHA256**；任何一步不通过都返回 null（不执行未校验的二进制） */
function ensureRestic(): string | null {
  const found = resticBin();
  if (found) return found;
  const arch = resticArch();
  if (!arch) return null;
  const meta = RESTIC_SHA256[arch];
  if (!meta) {
    console.error(`  ${RED}${T(`没有 ${arch} 的校验和记录——请自行安装 restic 后重试`, `no pinned checksum for ${arch} — install restic manually`)}${R}`);
    return null;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const url = `https://github.com/restic/restic/releases/download/v${RESTIC_VER}/${meta.file}`;
  const tmpDl = RESTIC + '.dl';
  process.stdout.write(`  ${D}${T(`下载 restic（${arch}）...`, `downloading restic (${arch})...`)}${R}\n`);
  const dl = spawnSync('curl', ['-fsSL', '--max-time', '300', '--retry', '2', '-o', tmpDl, url], { stdio: 'inherit' });
  if (dl.status !== 0 || !fs.existsSync(tmpDl)) {
    try { fs.rmSync(tmpDl, { force: true }); } catch { /* ignore */ }
    console.error(`  ${RED}${T('restic 下载失败（网络？）', 'restic download failed')}${R}`);
    return null;
  }
  const got = (() => { try { return sha256File(tmpDl); } catch { return ''; } })();
  if (got !== meta.sha) {
    try { fs.rmSync(tmpDl, { force: true }); } catch { /* ignore */ }
    console.error(`  ${RED}${T('restic 校验和不符——已删除下载文件（拒绝执行未校验的二进制）', 'restic checksum mismatch — download deleted')}${R}`);
    console.error(`  ${D}expected ${meta.sha}\n          got ${got || '(read failed)'}${R}`);
    log(`restic checksum mismatch: expected=${meta.sha} got=${got}`);
    return null;
  }
  const out = path.join(BIN_DIR, process.platform === 'win32' ? 'restic.exe' : 'restic');
  const ex = meta.kind === 'zip'
    ? spawnSync('unzip', ['-o', tmpDl, '-d', BIN_DIR], { stdio: 'ignore' })
    : spawnSync('bash', ['-c', `bunzip2 -c "${tmpDl}" > "${out}"`], { stdio: 'inherit' });
  try { fs.rmSync(tmpDl, { force: true }); } catch { /* ignore */ }
  if (meta.kind === 'zip' && ex.status === 0) {
    // zip 里是 restic_<ver>_windows_amd64.exe —— 改名成 restic.exe 供 spawn
    const inner = path.join(BIN_DIR, meta.file.replace(/\.zip$/, '.exe'));
    try { if (fs.existsSync(inner)) fs.renameSync(inner, out); } catch { /* ignore */ }
  }
  if (ex.status !== 0 || !fs.existsSync(out)) {
    console.error(`  ${RED}${T('restic 解压失败', 'restic extract failed')}${R}`);
    return null;
  }
  try { fs.chmodSync(out, 0o755); } catch { /* ignore */ }
  return out;
}

// ── restic 运行环境 ──────────────────────────────────────────────────
function repoUrl(conf: any): string {
  // 阿里云 OSS S3 兼容入口：必须用 s3. 前缀端点（s3.oss-cn-<region>.aliyuncs.com），
  // 让 restic 的 virtual hosted style 落在 *.s3.oss-cn-<region>.aliyuncs.com（SSL 证书覆盖），
  // 否则 bucket.oss-cn-<region> 变两级子域名，teyvat-restic.bucket.oss-cn-<region> 变三级 → 证书不匹配。
  let ep = String(conf.endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!ep.startsWith("s3.")) ep = "s3." + ep;
  return `s3:https://${ep}/${conf.bucket}/${REPO_PREFIX}`;
}
function resticEnv(conf: any): NodeJS.ProcessEnv {
  const cred = readCred();
  return {
    ...process.env,
    RESTIC_REPOSITORY: repoUrl(conf),
    RESTIC_PASSWORD_FILE: PASS_FILE,
    AWS_ACCESS_KEY_ID: cred.accessKeyId || '',
    AWS_SECRET_ACCESS_KEY: cred.accessKeySecret || '',
  };
}
function runRestic(bin: string, conf: any, args: string[], opts: { inherit?: boolean } = {}): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, {
    env: resticEnv(conf),
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    maxBuffer: 16 * 1024 * 1024,
    // 2026-09-11（prime-agent）：原来没有超时 —— 网络卡住时 restic 会一直挂着，
    // 而 cmdNow 是 bioclock detached 起的子进程（没人看得见），状态永远停在 running。30 分钟封顶。
    timeout: 30 * 60_000,
    killSignal: 'SIGTERM',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out };
}

// ── 日志（best-effort——绝不抛）───────────────────────────────────────
function log(line: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 静默 */ }
}

// ── 状态文件（原子写——launcher 读它渲染看板状态行）────────────────
function writeStatus(state: string, extra: Record<string, any> = {}): void {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    const data = { state, host: os.hostname().replace(/\.local$/, ''), ts: new Date().toISOString(), ...extra };
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* 静默 */ }
}
function countSnapshots(bin: string, conf: any): number {
  try {
    const r = runRestic(bin, conf, ['snapshots', '--json']);
    if (!r.ok) return 0;
    const arr = JSON.parse(r.out.replace(/^[^\[]*/, '') || '[]');
    return Array.isArray(arr) ? arr.length : 0;
  } catch { return 0; /* snapshots 解析失败 → 按 0 计 */ }
}

// ── 远端上报（best-effort——照抄 update 遥测：失败静默、绝不阻断）──────
// 用 spawnSync curl（同步、可靠——避免 fire-and-forget fetch 随进程退出丢失）
function reportRemote(ok: boolean, detail: string): void {
  try {
    const bind = JSON.parse(fs.readFileSync(path.join(PAIMON, 'UserAccount', 'binding.json'), 'utf8'));
    if (!bind?.token) return;                                    // 未绑定账号 → 不上报（仅本地日志）
    const payload = JSON.stringify({
      ok,
      detail: String(detail || '').slice(0, 300),
      host: os.hostname().replace(/\.local$/, ''),
      ts: new Date().toISOString(),
    });
    spawnSync('curl', ['-s', '-m', '8', '-X', 'POST', 'https://sync.paimon.beer/sync/backup-telemetry',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${bind.token}`,
      '-H', `X-Device-Id: ${bind.deviceId || ''}`,
      '-H', 'User-Agent: genshin-sync/1.0',
      '-d', payload], { stdio: 'ignore' });
  } catch { /* 静默 */ }
}

// ── 交互问答 ─────────────────────────────────────────────────────────
function ask(q: string, def = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(def ? `  ${q} ${D}[${def}]${R}: ` : `  ${q}: `, (a) => { rl.close(); res((a || '').trim() || def); });
  });
}
function argVal(rest: string[], key: string): string | undefined {
  const p = `--${key}=`;
  for (const a of rest) if (a.startsWith(p)) return a.slice(p.length);
  return undefined;
}

// ── 子命令实现 ───────────────────────────────────────────────────────
async function cmdConfigInteractive(rest: string[]): Promise<boolean> {
  console.log(`\n  ${BOLD}${T('teyvat 云备份 · 配置', 'teyvat cloud backup · configure')}${R}`);
  console.log(`  ${D}${T('存储：阿里云 OSS（S3 兼容）· 工具：restic（快照 · 只追加）', 'storage: Aliyun OSS (S3-compat) · tool: restic (snapshots, append-only)')}${R}\n`);
  const endpoint = argVal(rest, 'endpoint') || (await ask(T('OSS endpoint（如 oss-cn-hangzhou.aliyuncs.com）', 'OSS endpoint (e.g. oss-cn-hangzhou.aliyuncs.com)')));
  const bucket = argVal(rest, 'bucket') || (await ask(T('bucket 名', 'bucket name')));
  const akid = argVal(rest, 'access-key-id') || (await ask(T('RAM 子账号 AccessKeyId', 'RAM AccessKeyId')));
  const aksec = argVal(rest, 'access-key-secret') || (await ask(T('RAM 子账号 AccessKeySecret', 'RAM AccessKeySecret')));
  if (!endpoint || !bucket || !akid || !aksec) {
    console.error(`  ${RED}${T('四项都必填', 'all four required')}${R}`);
    return false;
  }
  // services.json 只存 bucket/endpoint（不含密钥）；AK 另存 600 文件
  writeServices({ backup: { provider: 'oss', endpoint, bucket, paths: [...CRITICAL], schedule: 'daily' } });
  writeCred({ accessKeyId: akid, accessKeySecret: aksec });
  console.log(`\n  ${G}✓${R} ${T('配置已写入', 'config written')} ${D}${UA_SERVICES}${R}`);
  console.log(`  ${G}✓${R} ${T('凭证已写入（600）', 'credentials written (600)')} ${D}${CRED_FILE}${R}`);
  return true;
}

function cmdInit(): boolean {
  const conf = getBackupConf();
  if (!conf) { console.error(`  ${RED}${T('未配置——先跑 genshin b config', 'not configured — run genshin b config first')}${R}`); return false; }
  const bin = ensureRestic();
  if (!bin) { console.error(`  ${RED}${T('restic 不可用（下载失败？）', 'restic unavailable (download failed?)')}${R}`); return false; }
  // 仓库密码：本地不存在时先从 sync server 拉取（GitHub auth 绑定的身份），拉不到才新生成
  if (!fs.existsSync(PASS_FILE)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    let pw = '';
    // 尝试从 sync server 恢复（GitHub auth 身份——任何机器只要绑定了同一 GitHub 就能拿回密码）
    try {
      const bind = JSON.parse(fs.readFileSync(path.join(PAIMON, 'UserAccount', 'binding.json'), 'utf8'));
      if (bind?.token) {
        const r = spawnSync('curl', ['-s', '-m', '10', '-H', `Authorization: Bearer ${bind.token}`,
          '-H', `X-Device-Id: ${bind.deviceId || ''}`,
          'https://sync.paimon.beer/sync/backup-password'], { encoding: 'utf8' });
        if (r.status === 0 && r.stdout) {
          try {
            const resp = JSON.parse(r.stdout);
            if (resp.password) { pw = resp.password; console.log(`  ${G}✓${R} ${T('已从云端恢复仓库密码（GitHub 身份验证）', 'repo password recovered from cloud (GitHub auth)')}`); }
          } catch { /* 响应不是 JSON，忽略 */ }
        }
      }
    } catch { /* binding 不存在或网络失败，走新生成 */ }
    if (!pw) {
      pw = randomBytes(32).toString('base64');
      console.log(`  ${D}${T('生成新仓库密码', 'generating new repo password')}${R}`);
    }
    fs.writeFileSync(PASS_FILE, pw, { mode: 0o600 });
    try { fs.chmodSync(PASS_FILE, 0o600); } catch { /* ignore */ }
    // 上传到 sync server（绑定 GitHub 身份，换机器可恢复）
    try {
      const bind = JSON.parse(fs.readFileSync(path.join(PAIMON, 'UserAccount', 'binding.json'), 'utf8'));
      if (bind?.token) {
        spawnSync('curl', ['-s', '-m', '10', '-X', 'POST', 'https://sync.paimon.beer/sync/backup-password',
          '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${bind.token}`,
          '-H', `X-Device-Id: ${bind.deviceId || ''}`, '-H', 'User-Agent: genshin-sync/1.0',
          '-d', JSON.stringify({ password: pw })], { stdio: 'ignore' });
        console.log(`  ${G}✓${R} ${T('密码已同步到云端（通过 GitHub 身份绑定，换机器可恢复）', 'password synced to cloud (recoverable via GitHub auth on any machine)')}`);
      }
    } catch { /* 上传失败不阻断 */ }
    console.log(`  ${D}${T('本地备份', 'local copy')}：${PASS_FILE}${R}`);
  }
  const chk = runRestic(bin, conf, ['snapshots', '--last']);
  if (chk.ok) { console.log(`  ${D}${T('仓库已存在，跳过 init', 'repo exists, skip init')}${R}`); return true; }
  console.log(`  ${D}${T('初始化 restic 仓库...', 'initializing restic repo...')}${R}`);
  const r = runRestic(bin, conf, ['init'], { inherit: true });
  if (r.ok) {
    console.log(`  ${G}✓${R} ${T('仓库已初始化', 'repo initialized')}`);
    log('init ok');
    writeStatus('configured-no-snapshot');
    return true;
  }
  console.error(`  ${RED}${T('初始化失败', 'init failed')}${R}`);
  log(`init failed: ${(r.out || '').slice(0, 300)}`);
  return false;
}

function cmdNow(): boolean {
  const conf = getBackupConf();
  if (!conf) { console.error(`  ${RED}${T('未配置', 'not configured')}${R}`); return false; }
  const bin = ensureRestic();
  if (!bin) { console.error(`  ${RED}restic ${T('不可用', 'unavailable')}${R}`); return false; }
  const ex: string[] = [];
  for (const p of CRITICAL) { const fp = path.join(PAIMON, p); if (fs.existsSync(fp)) ex.push(fp); }
  const bx: string[] = [];
  for (const p of BULK) { const fp = path.join(PAIMON, p); if (fs.existsSync(fp)) bx.push(fp); }
  const host = os.hostname().replace(/\.local$/, '');
  console.log(`  ${T('备份中…', 'backing up…')} critical(${ex.length}) + bulk(${bx.length}) → ${host}`);
  writeStatus('running', { host, started: new Date().toISOString() });
  const t0 = Date.now();
  let ok = true; let failDetail = '';
  // 交互终端用 inherit（显示 restic 进度条），非交互用 pipe（bioclock 自动备份静默）
  const isTTY = process.stdout.isTTY;
  if (ex.length) { const r = runRestic(bin, conf, ['backup', '--tag', 'critical', '--host', host, ...ex], { inherit: !!isTTY }); ok = ok && r.ok; if (!r.ok) failDetail += r.out; }
  if (bx.length) { const r = runRestic(bin, conf, ['backup', '--tag', 'bulk', '--host', host, ...bx], { inherit: !!isTTY }); ok = ok && r.ok; if (!r.ok) failDetail += r.out; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (ok) {
    console.log(`  ${G}✓${R} ${T('备份完成', 'backup done')} ${D}${secs}s${R}`);
    log(`backup ok ${secs}s`);
    writeStatus('ok', { snapshots: countSnapshots(bin, conf), last: new Date().toISOString() });
    reportRemote(true, `ok ${secs}s`);
  } else {
    const tail = failDetail.trim().split('\n').slice(-4).join('\n');
    console.error(`  ${RED}${T('备份失败', 'backup failed')}${R}`);
    if (tail) console.error(`  ${D}${tail}${R}`);
    log(`backup failed: ${failDetail.slice(0, 400)}`);
    writeStatus('failed', { error: (failDetail.trim().split('\n').pop() || 'restic exit!=0').slice(0, 120) });
    reportRemote(false, failDetail || 'restic exit!=0');
  }
  return ok;
}

function cmdStatus(): void {
  const conf = getBackupConf();
  if (!conf) {
    console.log(`\n  ${BOLD}${T('teyvat 云备份', 'teyvat cloud backup')}${R}  ${Y}${T('未配置', 'not configured')}${R}`);
    console.log(`  ${D}${T('跑 `genshin b config` 填写密钥即可启用（配置后自动每日备份）', 'run `genshin b config` to enable (auto daily backup after configured)')}${R}\n`);
    return;
  }
  console.log(`\n  ${BOLD}${T('teyvat 云备份', 'teyvat cloud backup')}${R}  ${G}${T('已配置', 'configured')}${R}`);
  console.log(`  ${D}${T('endpoint', 'endpoint')}${R} ${conf.endpoint}   ${D}bucket${R} ${conf.bucket}`);
  const bin = resticBin();
  if (!bin) { console.log(`  ${Y}${T('restic 未就绪（首次备份时自动下载）', 'restic not ready (auto-download on first backup)')}${R}\n`); return; }
  const snap = runRestic(bin, conf, ['snapshots', '--last', '--json']);
  if (!snap.ok) { console.log(`  ${Y}${T('仓库不可读（未 init 或凭证有误）', 'repo unreadable (not init or bad creds)')}${R}\n`); return; }
  try {
    const arr = JSON.parse(snap.out.replace(/^[^\[]*/, '') || '[]');
    const mine = arr.filter((s: any) => s.hostname === os.hostname().replace(/\.local$/, '')).sort((a: any, b: any) => String(b.time).localeCompare(String(a.time)));
    console.log(`  ${D}${T('快照', 'snapshots')}${R} ${arr.length}   ${D}${T('本机最近', 'last (this host)')}${R} ${mine[0] ? mine[0].time : '-'}`);
  } catch { /* JSON 解析失败静默 */ }
  console.log(`  ${D}${T('日志', 'log')}${R} ${LOG_FILE}\n`);
}

// ── 入口 ─────────────────────────────────────────────────────────────
export async function cmdBackup(rest: string[] = []): Promise<void> {
  const sub = rest[0] || '';
  switch (sub) {
    case 'config': {
      const ok = await cmdConfigInteractive(rest.slice(1));
      if (ok) console.log(`  ${D}${T('下一步：genshin b init', 'next: genshin b init')}${R}`);
      break;
    }
    case 'init': cmdInit(); break;
    case 'now': case 'backup': cmdNow(); break;
    case 'status': cmdStatus(); break;
    case '': {
      const conf = getBackupConf();
      if (!conf && process.stdin.isTTY) {
        // 未配置 + 交互终端 → 配置引导
        const ok = await cmdConfigInteractive(rest.slice(1));
        if (ok) cmdInit();
      } else { cmdStatus(); }
      break;
    }
    default:
      console.log(`  ${T('用法', 'usage')}: genshin b [config|init|now|status]`);
  }
}

// 允许直接 `bun backup.ts` 调用（调试用）
if (import.meta.main) {
  cmdBackup(process.argv.slice(2));
}
