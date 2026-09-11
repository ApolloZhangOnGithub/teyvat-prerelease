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
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const H = os.homedir();
// 与 launcher/doctor/cli 同源：PAIMON_HOME 优先（沙箱/多实例必须正确）——禁止硬编码 ~/.teyvat
const PAIMON = process.env.PAIMON_HOME || path.join(H, '.teyvat');
const UA_SERVICES = path.join(PAIMON, 'UserAccount', 'services.json');
const LEGACY_SERVICES = path.join(PAIMON, 'config', 'services.json');
const SVC_FILE = fs.existsSync(UA_SERVICES) ? UA_SERVICES : LEGACY_SERVICES;
const BACKUP_DIR = path.join(PAIMON, 'config', 'backup');
const PASS_FILE = path.join(BACKUP_DIR, 'restic-pass');
const CRED_FILE = path.join(BACKUP_DIR, 'cred.json');
const STATE_DIR = path.join(PAIMON, 'LogData');
const LOG_FILE = path.join(STATE_DIR, 'backup.log');
const BIN_DIR = path.join(PAIMON, 'bin');
const RESTIC = path.join(BIN_DIR, 'restic');
const REPO_PREFIX = 'teyvat-restic';

const BOLD = '\x1b[1m', D = '\x1b[90m', G = '\x1b[32m', Y = '\x1b[33m', RED = '\x1b[31m', R = '\x1b[0m';
const LANG = process.env.PAIMON_LANG || (process.env.LANG?.includes('zh_CN') ? 'zh' : 'en');
const ZH = LANG === 'zh';
const T = (a: string, b: string) => (ZH ? a : b);

// ── 备份内容（走 PAIMON_HOME，任一不存在则跳过）──
const CRITICAL = ['SessionData', 'MemoryData', 'AgentFileData', 'config', 'UserAccount', 'auth.json', 'settings.json', 'version.json'];
const BULK = ['AgentWorkDir', 'BlackboxData'];

// ── 配置读写 ─────────────────────────────────────────────────────────
function readServices(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(SVC_FILE, 'utf8')); } catch { return {}; }
}
function writeServices(patch: Record<string, any>): void {
  const svc = readServices();
  Object.assign(svc, patch);
  const dir = path.dirname(SVC_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = SVC_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(svc, null, 2));
  fs.renameSync(tmp, SVC_FILE);
}
function getBackupConf(): any | null {
  const b = readServices().backup;
  if (!b || typeof b !== 'object' || !b.bucket || !b.endpoint) return null;
  return b;
}
function readCred(): any {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return {}; }
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
function ensureRestic(): string | null {
  const found = resticBin();
  if (found) return found;
  const arch = resticArch();
  if (!arch) return null;
  const ver = '0.19.1';
  const url = `https://github.com/restic/restic/releases/download/v${ver}/restic_${ver}_${arch}.bz2`;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  process.stdout.write(`  ${D}${T(`下载 restic（${arch}）...`, `downloading restic (${arch})...`)}${R}\n`);
  const sh = `curl -fsSL "${url}" | bunzip2 > "${RESTIC}" && chmod +x "${RESTIC}"`;
  const r = spawnSync('bash', ['-c', sh], { stdio: 'inherit' });
  if (r.status === 0 && fs.existsSync(RESTIC)) return RESTIC;
  return null;
}

// ── restic 运行环境 ──────────────────────────────────────────────────
function repoUrl(conf: any): string {
  // 阿里云 OSS S3 兼容端点：s3.oss-cn-<region>.aliyuncs.com
  const ep = String(conf.endpoint).replace(/^https?:\/\//, '').replace(/\/$/, '');
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
  console.log(`\n  ${G}✓${R} ${T('配置已写入', 'config written')} ${D}${SVC_FILE}${R}`);
  console.log(`  ${G}✓${R} ${T('凭证已写入（600）', 'credentials written (600)')} ${D}${CRED_FILE}${R}`);
  return true;
}

function cmdInit(): boolean {
  const conf = getBackupConf();
  if (!conf) { console.error(`  ${RED}${T('未配置——先跑 genshin b config', 'not configured — run genshin b config first')}${R}`); return false; }
  const bin = ensureRestic();
  if (!bin) { console.error(`  ${RED}${T('restic 不可用（下载失败？）', 'restic unavailable (download failed?)')}${R}`); return false; }
  // 首次：生成仓库密码（必须提示用户抄走——丢了仓库永久不可读）
  if (!fs.existsSync(PASS_FILE)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const pw = randomBytes(32).toString('base64');
    fs.writeFileSync(PASS_FILE, pw, { mode: 0o600 });
    try { fs.chmodSync(PASS_FILE, 0o600); } catch { /* ignore */ }
    console.log(`\n  ${Y}${BOLD}⚠ ${T('已生成 restic 仓库密码', 'restic repo password generated')}${R}`);
    console.log(`  ${BOLD}${T('请立刻抄走保存', 'COPY IT NOW')}${R}：${D}${PASS_FILE}${R}`);
    console.log(`  ${D}${T('密码丢了 = 仓库永久打不开（restic 是端到端加密设计，谁也救不了）。', 'Lose it = repo unrecoverable forever.')}${R}\n`);
  }
  const chk = runRestic(bin, conf, ['snapshots', '--last']);
  if (chk.ok) { console.log(`  ${D}${T('仓库已存在，跳过 init', 'repo exists, skip init')}${R}`); return true; }
  console.log(`  ${D}${T('初始化 restic 仓库...', 'initializing restic repo...')}${R}`);
  const r = runRestic(bin, conf, ['init'], { inherit: true });
  if (r.ok) { console.log(`  ${G}✓${R} ${T('仓库已初始化', 'repo initialized')}`); log('init ok'); return true; }
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
  console.log(`  ${D}${T('备份', 'backing up')} critical(${ex.length}) + bulk(${bx.length}) → ${host}${R}`);
  const t0 = Date.now();
  let ok = true;
  if (ex.length) { const r = runRestic(bin, conf, ['backup', '--tag', 'critical', '--host', host, ...ex], { inherit: true }); ok = ok && r.ok; }
  if (bx.length) { const r = runRestic(bin, conf, ['backup', '--tag', 'bulk', '--host', host, ...bx], { inherit: true }); ok = ok && r.ok; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (ok) { console.log(`  ${G}✓${R} ${T('备份完成', 'backup done')} ${D}${secs}s${R}`); log(`backup ok ${secs}s`); }
  else { console.error(`  ${RED}${T('备份失败（详见日志）', 'backup failed (see log)')}${R}`); log('backup failed'); }
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
