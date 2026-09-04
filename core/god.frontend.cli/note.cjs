// note.cjs — agent 备注管理
// 数据: ~/.teyvat/MemoryData/<id>/notes.jsonl (每行一条 JSONL)
// 用法: node note.cjs              → 列出所有非 archive agent 的 notes
//       node note.cjs <id>          → 查看备注
//       node note.cjs <id> <msg...>  → 追加备注

const fs = require('fs');
const path = require('path');
const os = require('os');

const PAIMON = path.join(os.homedir(), '.teyvat');
const id = process.argv[2];
const msg = process.argv.slice(3).join(' ').trim();

function readNotes(noteFile) {
  if (!fs.existsSync(noteFile)) return [];
  const notes = [];
  const lines = fs.readFileSync(noteFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const n = JSON.parse(line);
      notes.push({ ts: n.ts, text: n.text });
    } catch {
      notes.push({ ts: null, text: line });
    }
  }
  return notes;
}

function printNotes(notes, indent = '') {
  notes.forEach((n, i) => {
    const ts = n.ts ? new Date(n.ts).toLocaleString('sv').slice(0, 19) : '';
    console.log(`${indent}${i + 1}. [${ts}] ${n.text}`);
  });
}

// 列出所有非 archive agent 的 notes
if (!id) {
  const plistFile = path.join(PAIMON, 'MemoryData', 'plist.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(plistFile, 'utf8')); } catch (e) { console.error("[god.frontend.cli/note.cjs] " + (e?.message || e)); }
  const active = list.filter((p) => !p.archived);
  if (!active.length) {
    console.log('(no non-archived agents)');
    process.exit(0);
  }
  // 按名字排序，输出稳定
  active.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const withNotes = active.filter((p) => readNotes(path.join(PAIMON, 'MemoryData', p.id, 'notes.jsonl')).length > 0);
  console.log(`  Notes · ${active.length} non-archived agent${active.length === 1 ? '' : 's'} (${withNotes.length} with notes)`);
  console.log('');
  for (const p of active) {
    const notes = readNotes(path.join(PAIMON, 'MemoryData', p.id, 'notes.jsonl'));
    console.log(`  ${p.name || p.id} (${p.id})`);
    if (!notes.length) {
      console.log('    (no notes)');
    } else {
      printNotes(notes, '    ');
    }
    console.log('');
  }
  process.exit(0);
}

const noteFile = path.join(PAIMON, 'MemoryData', id, 'notes.jsonl');

// 查看
if (!msg) {
  if (!fs.existsSync(noteFile)) {
    console.log(`(no notes for ${id})`);
    process.exit(0);
  }
  printNotes(readNotes(noteFile));
  process.exit(0);
}

// 追加
fs.mkdirSync(path.dirname(noteFile), { recursive: true });
const entry = JSON.stringify({ text: msg, ts: Date.now() }) + '\n';
fs.appendFileSync(noteFile, entry);
console.log(`note added: ${msg.slice(0, 60)}`);
// 追加后列全部
if (fs.existsSync(noteFile)) {
  printNotes(readNotes(noteFile));
}
