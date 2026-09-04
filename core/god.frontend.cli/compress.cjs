// compress.cjs — 压缩/解压 session 和 blackbox 数据
// 用法:
//   node genshin-compress.cjs compress [agent-id]   压缩（>1天的文件）
//   node genshin-compress.cjs decompress <agent-id>  解压（启动前调用）
const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAIMON_HOME = process.env.PAIMON_HOME || (process.env.HOME + '/.teyvat');
const MEM_DIR = PAIMON_HOME + '/MemoryData';
const ACTION = process.argv[2] || 'compress';
const AGENT_ID = process.argv[3] || null;
const ONE_DAY = 86400000;

const HAS_ZSTD = (() => {
  try { execSync('which zstd', { stdio: 'ignore' }); return true; } catch { return false; }
})();

if (!HAS_ZSTD) process.exit(0);

const COMPRESS_DIRS = [
  { base: PAIMON + '/SessionData', sub: null },
  { base: PAIMON + '/BlackboxData', sub: null },
  { base: PAIMON + '/ChannelData', sub: null },
];
const DECOMPRESS_DIRS = [
  ...COMPRESS_DIRS,
  { base: MEM_DIR, sub: null },  // 兼容旧数据，解压保留
];

function scanDir(dir, cutoff, compress, agentId) {
  if (!fs.existsSync(dir)) return { count: 0, saved: 0 };
  let count = 0, saved = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    const fp = path.join(dir, f);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.isDirectory()) {
      const r = scanDir(fp, cutoff, compress, agentId);
      count += r.count; saved += r.saved;
    } else if (compress && st.isFile() && !f.endsWith('.zst') && st.mtimeMs < cutoff && st.size >= 1024) {
      const before = st.size;
      if (spawnSync('zstd', ['-q', '--rm', fp], { stdio: 'ignore' }).status === 0) {
        try { saved += before - fs.statSync(fp + '.zst').size; } catch (e) { console.error("[god.frontend.cli/compress.cjs] " + (e?.message || e)); }
        count++;
      }
    } else if (!compress && f.endsWith('.zst')) {
      if (spawnSync('zstd', ['-d', '-q', '--rm', fp], { stdio: 'ignore' }).status === 0) count++;
    }
  }
  return { count, saved };
}

function compress(agentId) {
  const cutoff = Date.now() - ONE_DAY;
  let count = 0, saved = 0;
  for (const t of COMPRESS_DIRS) {
    const r = scanDir(path.join(t.base, agentId), cutoff, true, agentId);
    count += r.count; saved += r.saved;
  }
  // silent - background task, no console noise
}

function decompress(agentId) {
  let count = 0;
  for (const t of DECOMPRESS_DIRS) {
    const r = scanDir(path.join(t.base, agentId), 0, false, agentId);
    count += r.count;
  }
  if (count > 0) console.log(`decompressed ${count} files`);
}

// main
if (ACTION === 'decompress') {
  if (!AGENT_ID) { console.error('need agent id'); process.exit(1); }
  decompress(AGENT_ID);
} else {
  if (AGENT_ID) {
    compress(AGENT_ID);
  } else {
    try {
      const plist = JSON.parse(fs.readFileSync(path.join(MEM_DIR, 'plist.json'), 'utf8'));
      for (const a of plist) compress(a.id);
    } catch (e) { console.error("[god.frontend.cli/compress.cjs] " + (e?.message || e)); }
  }
}
