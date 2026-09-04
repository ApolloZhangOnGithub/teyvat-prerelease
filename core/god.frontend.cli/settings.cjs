// settings.cjs — 设置 TUI（箭头键导航）
// 用法: node settings.cjs <settings-file> <lang>
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = process.argv[2];
const LANG_INIT = process.argv[3] || 'en';
let zh = LANG_INIT === 'zh';
const PAIMON_HOME = process.env.PAIMON_HOME || (process.env.HOME + '/.teyvat');

const MEM_DIR = PAIMON_HOME + '/MemoryData';
const PLIST = MEM_DIR + '/plist.json';
const CLI_DIR = path.join(process.env.HOME, '.local/lib/teyvat/extensions/teyvat/god.mods.cli');

const R = '\x1b[0m', DIM = '\x1b[90m', CYAN = '\x1b[36m', GREEN = '\x1b[32m';
const BOLD = '\x1b[1m', YLW = '\x1b[33m', RED = '\x1b[31m', INV = '\x1b[7m';

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { console.error("[god.frontend.cli/settings.cjs] " + (e?.message || e)); }
const save = () => {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
};

// ── setting definitions ──
const MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash', 'Qwen3.8-27B']; // 2026-08-18 加本地 qwen（settings 菜单默认模型可选）

function getItems() {
  const dev = !!settings.developerMode;
  const items = [
    { key: 'lang', label: zh ? '语言' : 'Language', value: settings.lang === 'zh' ? '简体中文' : 'English', type: 'toggle' },
    { key: 'defaultModel', label: zh ? '默认模型' : 'Default model', value: settings.defaultModel || 'deepseek-v4-pro', type: 'cycle', options: MODELS },
    { key: 'autoArchiveDays', label: zh ? '自动归档' : 'Auto-archive', value: (settings.autoArchiveDays || 0) > 0 ? (zh ? `闲置 ${settings.autoArchiveDays} 天后` : `after ${settings.autoArchiveDays}d idle`) : (zh ? '关闭' : 'off'), type: 'input' },
    { key: 'sep1', type: 'separator' },
    { key: 'displayHeader', label: zh ? '显示' : 'Display', value: '', type: 'label' },
    { key: 'toolPathHyperlinks', label: zh ? '  路径超链接' : '  Path hyperlinks', value: settings.toolPathHyperlinks === true ? (zh ? '开启' : 'on') : (zh ? '关闭' : 'off'), type: 'toggle' },
    { key: 'sep2', type: 'separator' },
    { key: 'developerMode', label: zh ? '开发者模式' : 'Developer mode', value: dev ? (zh ? '开启' : 'on') : (zh ? '关闭' : 'off'), type: 'toggle' },
  ];
  if (dev) {
    items.push(
      { key: 'blackboxEnabled', label: zh ? '  Blackbox 录制' : '  Blackbox recording', value: settings.blackboxEnabled !== false ? (zh ? '开启' : 'on') : (zh ? '关闭' : 'off'), type: 'toggle' },
      { key: 'blackboxRetentionDays', label: zh ? '  Blackbox 保留' : '  Blackbox retention', value: (settings.blackboxRetentionDays || 0) > 0 ? (zh ? `最近 ${settings.blackboxRetentionDays} 天` : `last ${settings.blackboxRetentionDays}d`) : (zh ? '永久' : 'forever'), type: 'input' },
      { key: 'diskAnalyse', label: zh ? '  磁盘分析' : '  Disk analysis', value: '→', type: 'action' },
      { key: 'diskCleanup', label: zh ? '  清理历史数据' : '  Clean up old data', value: '→', type: 'action' },
    );
  }
  return items;
}

// ── actions: call external tools ──
function showDiskAnalysis() {
  process.stdout.write('\x1b[2J\x1b[H');
  const script = path.join(CLI_DIR, 'analyse.cjs');
  const { execSync } = require('child_process');
  try {
    process.stdout.write(execSync('node ' + JSON.stringify(script) + ' --render ' + (zh ? 'zh' : 'en'), { encoding: 'utf8' }));
  } catch (e) {
    console.log(RED + '  error: ' + (e.stderr || e.message || e) + R);
  }
  console.log('');
  console.log(DIM + '  ' + (zh ? '按任意键返回' : 'press any key') + R);
}

function showDiskCleanup() {
  process.stdout.write('\x1b[2J\x1b[H');
  const days = settings.blackboxRetentionDays || 0;
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

  let agents = [];
  try { agents = JSON.parse(fs.readFileSync(PLIST, 'utf8')); } catch (e) { console.error("[god.frontend.cli/settings.cjs] " + (e?.message || e)); }

  let expiredFiles = [];
  let expiredSize = 0;

  for (const a of agents) {
    const bbDir = path.join(PAIMON_HOME, 'BlackboxData', a.id);
    try {
      for (const f of fs.readdirSync(bbDir)) {
        const fp = path.join(bbDir, f);
        const st = fs.statSync(fp);
        if (cutoff > 0 && st.mtimeMs < cutoff) {
          expiredFiles.push({ path: fp, name: a.name + '/' + f, size: st.size });
          expiredSize += st.size;
        }
      }
    } catch (e) { console.error("[god.frontend.cli/settings.cjs] " + (e?.message || e)); }
  }

  console.log('');
  console.log(`  ${BOLD}${zh ? '清理历史数据' : 'Clean Up Old Data'}${R}`);
  console.log('');

  if (days === 0) {
    console.log(DIM + '  ' + (zh ? 'Blackbox 保留天数未设置（永久保留）' : 'Blackbox retention not set (keep forever)') + R);
    console.log(DIM + '  ' + (zh ? '请先在设置中配置保留天数' : 'Set retention days in settings first') + R);
  } else if (expiredFiles.length === 0) {
    console.log(GREEN + '  ' + (zh ? '没有超期数据' : 'No expired data') + R);
  } else {
    const mb = (expiredSize / 1024 / 1024).toFixed(2);
    console.log('  ' + (zh ? '超过 ' + days + ' 天的 Blackbox 数据：' : 'Blackbox data older than ' + days + ' days:'));
    console.log('');
    console.log('  ' + RED + expiredFiles.length + (zh ? ' 个文件，共 ' : ' files, ') + mb + ' MB' + R);
    console.log('');
    for (const f of expiredFiles.slice(0, 10)) {
      console.log(DIM + '    ' + f.name + '  ' + (f.size / 1024 / 1024).toFixed(2) + ' MB' + R);
    }
    if (expiredFiles.length > 10) {
      console.log(DIM + '    ... ' + (zh ? '等 ' + (expiredFiles.length - 10) + ' 个' : 'and ' + (expiredFiles.length - 10) + ' more') + R);
    }
    console.log('');
    console.log('  ' + YLW + (zh ? '按 y 移到回收站，其他键取消' : 'Press y to trash, any other key to cancel') + R);

    return new Promise(resolve => {
      process.stdin.once('data', (key) => {
        if (key === 'y' || key === 'Y') {
          const { execSync } = require('child_process');
          let trashed = 0;
          for (const f of expiredFiles) {
            try { execSync('trash ' + JSON.stringify(f.path), { stdio: 'ignore' }); trashed++; } catch (e) { console.error("[god.frontend.cli/settings.cjs] " + (e?.message || e)); }
          }
          console.log('');
          console.log(GREEN + '  ' + (zh ? '已清理 ' + trashed + ' 个文件' : 'Trashed ' + trashed + ' files') + R);
        } else {
          console.log('');
          console.log(DIM + '  ' + (zh ? '已取消' : 'Cancelled') + R);
        }
        console.log('');
        console.log(DIM + '  ' + (zh ? '按任意键返回' : 'press any key') + R);
        resolve();
      });
    });
  }
  console.log('');
  console.log(DIM + '  ' + (zh ? '按任意键返回' : 'press any key') + R);
}

// ── toggle/cycle/input handlers ──
function handleToggle(item) {
  if (item.key === 'lang') {
    settings.lang = settings.lang === 'zh' ? 'en' : 'zh';
    zh = settings.lang === 'zh';
    save();
    items = getItems();
    return;
  } else if (item.key === 'voice') {
    settings.voice = settings.voice === false ? true : false;
  } else if (item.key === 'developerMode') {
    settings.developerMode = !settings.developerMode;
  } else if (item.key === 'blackboxEnabled') {
    settings.blackboxEnabled = settings.blackboxEnabled === false ? true : false;
  } else if (item.key === 'toolPathHyperlinks') {
    settings.toolPathHyperlinks = settings.toolPathHyperlinks === true ? false : true;
  }
  save();
}

function handleCycle(item) {
  const opts = item.options;
  const cur = settings[item.key] || opts[0];
  const idx = opts.indexOf(cur);
  settings[item.key] = opts[(idx + 1) % opts.length];
  save();
}

function handleCycleReverse(item) {
  const opts = item.options;
  const cur = settings[item.key] || opts[0];
  const idx = opts.indexOf(cur);
  settings[item.key] = opts[(idx - 1 + opts.length) % opts.length];
  save();
}

function startInput(item) {
  if (item.key === 'autoArchiveDays') {
    inputMode = { key: item.key, prompt: zh ? '闲置几天后归档 (0=关闭)' : 'days idle before archive (0=off)' };
  } else if (item.key === 'blackboxRetentionDays') {
    inputMode = { key: item.key, prompt: zh ? '保留最近几天 (0=永久)' : 'keep last N days (0=forever)' };
  }
  inputBuf = '';
}

function finishInput() {
  const n = parseInt(inputBuf);
  if (!isNaN(n) && n >= 0) {
    settings[inputMode.key] = n;
    save();
  }
  inputMode = null;
}

// ── TUI render ──
let cursor = 0;
let inputMode = null;
let inputBuf = '';
let inSubpage = false;

function render() {
  const items = getItems();
  if (cursor >= items.length) cursor = items.length - 1;

  process.stdout.write('\x1b[2J\x1b[H');
  console.log('');
  console.log(`  ${BOLD}genshin ${zh ? '设置' : 'settings'}${R}`);
  console.log(`  ${'─'.repeat(45)}`);
  console.log('');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'separator') { console.log(''); continue; }
    if (item.type === 'label') { console.log(`  ${BOLD}${item.label}${R}`); continue; }
    const selected = i === cursor;
    const arrow = selected ? `${GREEN}▸${R} ` : '  ';
    const labelW = 22;
    const padded = item.label + ' '.repeat(Math.max(0, labelW - [...item.label].reduce((w, c) => w + (c.codePointAt(0) > 0x2E7F ? 2 : 1), 0)));
    const val = selected ? `${CYAN}${item.value}${R}` : `${DIM}${item.value}${R}`;
    console.log(`  ${arrow}${padded} ${val}`);
  }

  console.log('');
  if (inputMode) {
    process.stdout.write(`  ${inputMode.prompt}: ${inputBuf}`);
  } else {
    console.log(`  ${DIM}↑↓ ${zh ? '选择' : 'navigate'}  ←→ ${zh ? '切换' : 'change'}  ⏎ ${zh ? '确认' : 'enter'}  q ${zh ? '退出' : 'quit'}${R}`);
  }
}

// ── main loop ──
if (!process.stdin.isTTY) {
  console.error('Teyvat --settings requires a terminal');
  process.exit(1);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

render();
process.stdin.on('data', (key) => {
  if (inSubpage) return;
  const items = getItems();

  if (inputMode) {
    if (key === '\r' || key === '\n') { finishInput(); render(); }
    else if (key === '\x1b' || key === '\x03') { inputMode = null; render(); }
    else if (key === '\x7f') { inputBuf = inputBuf.slice(0, -1); render(); }
    else if (/^\d$/.test(key)) { inputBuf += key; render(); }
    return;
  }

  if (key === '\x1b[A') {
    do { cursor = (cursor - 1 + items.length) % items.length; } while (items[cursor].type === 'separator' || items[cursor].type === 'label');
    render();
  } else if (key === '\x1b[B') {
    do { cursor = (cursor + 1) % items.length; } while (items[cursor].type === 'separator' || items[cursor].type === 'label');
    render();
  } else if (key === '\x1b[C' || key === '\x1b[D') {
    const item = items[cursor];
    if (item.type === 'toggle') { handleToggle(item); render(); }
    else if (item.type === 'cycle') {
      if (key === '\x1b[D') handleCycleReverse(item); else handleCycle(item);
      render();
    }
  } else if (key === '\r' || key === '\n' || key === ' ') {
    const item = items[cursor];
    if (item.type === 'input') { startInput(item); render(); }
    else if (item.type === 'action' && item.key === 'diskAnalyse') {
      inSubpage = true;
      showDiskAnalysis();
      process.stdin.once('data', () => { inSubpage = false; render(); });
      return;
    }
    else if (item.type === 'action' && item.key === 'diskCleanup') {
      inSubpage = true;
      const p = showDiskCleanup();
      if (p && p.then) {
        p.then(() => { process.stdin.once('data', () => { inSubpage = false; render(); }); });
      } else {
        process.stdin.once('data', () => { inSubpage = false; render(); });
      }
      return;
    }
  } else if (key === 'q' || key === '\x1b' || key === '\x03') {
    process.stdout.write('\x1b[2J\x1b[H');
    process.exit(0);
  }
});
