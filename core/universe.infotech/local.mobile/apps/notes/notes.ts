import { shareApps, shareDestinations, shareTo } from "../../system.share/share.ts";
// apps/notes/notes.ts — Notes app (备忘录)
// v0.2 spec: "备忘录也是，就是有事可以记在本地"
// Simple persistent note-taking with tags and search

import * as fs from "fs";
import * as path from "path";

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  created: string;
  updated: string;
}

function notesPath(personDir: string): string {
  return path.join(personDir, "notes.json");
}

function loadNotes(personDir: string): Note[] {
  try {
    return JSON.parse(fs.readFileSync(notesPath(personDir), "utf8"));
  } catch {
    return [];
  }
}

function saveNotes(personDir: string, notes: Note[]) {
  fs.writeFileSync(notesPath(personDir), JSON.stringify(notes, null, 2));
}

function genId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function notesCmd(args: any, _ctx: any, personDir: string): Promise<any> {
  const notes = loadNotes(personDir);

  // --add: create note
  if (args.action === "add" || args.add) {
    const title = args.title || (typeof args.add === "string" ? args.add : args._?.[1]);
    if (!title) return { content: [{ type: "text", text: "Usage: notes --add <title> [--content <text>] [--tags tag1,tag2]" }] };

    const note: Note = {
      id: genId(),
      title,
      content: (args.content as string) || "",
      tags: args.tags ? (args.tags as string).split(",").map((t: string) => t.trim()) : [],
      pinned: false,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    notes.push(note);
    saveNotes(personDir, notes);
    return { content: [{ type: "text", text: `Created: **${title}**\n   ID: \`${note.id}\`` }] };
  }

  // --edit <id>: edit content
  if (args.action === "edit" || args.edit) {
    const id = args.edit as string;
    const note = notes.find(n => n.id === id);
    if (!note) return { content: [{ type: "text", text: `Note not found: ${id}` }] };

    if (args.content) note.content = args.content as string;
    if (args.title) note.title = args.title as string;
    if (args.tags) note.tags = (args.tags as string).split(",").map((t: string) => t.trim());
    note.updated = new Date().toISOString();
    saveNotes(personDir, notes);

    return { content: [{ type: "text", text: `Updated: **${note.title}**` }] };
  }

  // --show <id>: full note
  if (args.action === "view" || args.action === "show" || args.show) {
    const id = args.show as string;
    const note = notes.find(n => n.id === id);
    if (!note) return { content: [{ type: "text", text: `Note not found: ${id}` }] };

    const lines = [
      `**${note.title}**`,
      note.content ? `\n${note.content}` : "(empty)",
      `\n---`,
      `ID: \`${note.id}\``,
      `Tags: ${note.tags.join(", ") || "—"}`,
      `${note.pinned ? "PIN Pinned · " : ""}Created: ${note.created.slice(0, 16)} · Updated: ${note.updated.slice(0, 16)}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // --delete <id>
  if (args.action === "delete" || args.delete) {
    const id = args.delete as string;
    const idx = notes.findIndex(n => n.id === id);
    if (idx === -1) return { content: [{ type: "text", text: `Note not found: ${id}` }] };

    const title = notes[idx].title;
    notes.splice(idx, 1);
    saveNotes(personDir, notes);
    return { content: [{ type: "text", text: `Deleted: **${title}**` }] };
  }

  // --pin / --unpin <id>
  if (args.action === "pin" || args.pin) {
    const id = args.pin as string;
    const note = notes.find(n => n.id === id);
    if (!note) return { content: [{ type: "text", text: `Note not found: ${id}` }] };
    note.pinned = true;
    note.updated = new Date().toISOString();
    saveNotes(personDir, notes);
    return { content: [{ type: "text", text: `PIN Pinned: **${note.title}**` }] };
  }
  if (args.unpin) {
    const id = args.unpin as string;
    const note = notes.find(n => n.id === id);
    if (!note) return { content: [{ type: "text", text: `Note not found: ${id}` }] };
    note.pinned = false;
    note.updated = new Date().toISOString();
    saveNotes(personDir, notes);
    return { content: [{ type: "text", text: `PIN Unpinned: **${note.title}**` }] };
  }

  // --search <q>
  if (args.action === "search" || args.search) {
    const q = (args.search as string).toLowerCase();
    const results = notes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some(t => t.toLowerCase().includes(q))
    ).sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

    if (results.length === 0) return { content: [{ type: "text", text: `No notes matching "${args.search}".` }] };
    const lines = [`**Search: "${args.search}" (${results.length})**`];
    results.forEach(n => {
      const preview = n.content.slice(0, 80);
      lines.push(`  ${n.pinned ? "PIN" : "*"} **${n.title}** — ${preview}${n.content.length > 80 ? "..." : ""}`);
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // default: list recent, pinned first
  const pinned = notes.filter(n => n.pinned);
  const unpinned = notes.filter(n => !n.pinned).sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  const display = [...pinned, ...unpinned];

  const lines = [`**Notes (${notes.length})**`];
  if (display.length === 0) {
    lines.push("  No notes. Use `notes --add <title>` to create one.");
  } else {
    display.slice(0, 20).forEach(n => {
      const preview = n.content.slice(0, 80);
      const pin = n.pinned ? "PIN" : "  ";
      lines.push(`${pin} **${n.title}** — ${preview}${n.content.length > 80 ? "..." : ""}     \`${n.id}\``);
    });
    if (display.length > 20) lines.push(`  ... and ${display.length - 20} more`);
  }

  lines.push("\nCommands: `--add` · `--edit <id>` · `--show <id>` · `--delete <id>` · `--pin <id>` · `--search <q>`");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ── MobileApp wrapper ──────────────────────────────────────────
import type { MobileApp } from "../../system.kernel/kernel.ts";

export const app: MobileApp = {
  name: "notes",
  icon: "备忘录",
  messageDescription: "记录备忘、笔记管理",

  onOpen(state, personDir) {
    const notes = loadNotes(personDir);
    const pinned = notes.filter(n => n.pinned).length;
    const lines = [
      "═══ 备忘录 ═══",
      "",
      `  笔记: ${notes.length} 篇${pinned > 0 ? ` (${pinned} 篇置顶)` : ""}`,
      "",
      "  操作:",
      "    列表               — 查看所有笔记",
      "    新建 <标题>        — 创建笔记",
      "    查看 <id>          — 阅读笔记",
      "    编辑 <id> <内容>   — 编辑笔记内容",
      "    删除 <id>          — 删除笔记",
      "    置顶 <id>          — 置顶/取消置顶",
      "    搜索 <关键词>      — 搜索笔记",
      "",
      "  返回 — 回主屏幕",
    ];
    return { screen: lines.join("\n"), state: state ?? {} };
  },

  async onAction(input, state, personDir) {
    const trimmed = input.trim();
    let args: any = {};

    if (/^(列表|list)$/i.test(trimmed)) {
      args = {};
    } else if (/^(新建|添加|add)\s+(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:新建|添加|add)\s+(.+)$/i)!;
      args = { add: m[1] };
    } else if (/^(查看|show)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:查看|show)\s+(\S+)$/i)!;
      args = { show: m[1] };
    } else if (/^(编辑|edit)\s+(\S+)\s+(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:编辑|edit)\s+(\S+)\s+(.+)$/i)!;
      args = { edit: m[1], content: m[2] };
    } else if (/^(删除|delete)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:删除|delete)\s+(\S+)$/i)!;
      args = { delete: m[1] };
    } else if (/^(置顶|pin)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:置顶|pin)\s+(\S+)$/i)!;
      // toggle: if already pinned, unpin
      const notes = loadNotes(personDir);
      const note = notes.find(n => n.id === m[1]);
      if (note && note.pinned) {
        args = { unpin: m[1] };
      } else {
        args = { pin: m[1] };
      }
    } else if (/^(取消置顶|unpin)\s+(\S+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:取消置顶|unpin)\s+(\S+)$/i)!;
      args = { unpin: m[1] };
    } else if (/^(搜索|search)\s+(.+)$/i.test(trimmed)) {
      const m = trimmed.match(/^(?:搜索|search)\s+(.+)$/i)!;
      args = { search: m[1] };
    }

    const st = (state as any) || {};
    if (/^分享\s+/.test(trimmed) && !st._shareContent) { const m = trimmed.match(/^分享\s+(.+)/); if (m) { const id=m[1].trim(); const notes=loadNotes(personDir); const note=notes.find(n=>n.id===id); if (!note) return { screen:"未找到该笔记.", state }; const c=note.title+"\n"+note.content; return { screen: shareApps()+"\n\n分享内容:\n"+c.slice(0,200), state:{...st,_shareContent:c} }; } }
    if (/^\d+$/.test(trimmed) && st._shareContent && !st._shareApp) { const n=parseInt(trimmed); const d=shareDestinations(n); if (!d) return { screen:"无效.", state }; return { screen:d.screen+"\n\n分享内容:\n"+st._shareContent.slice(0,200), state:{...st,_shareApp:n} }; }
    if (/^\d+$/.test(trimmed) && st._shareContent && st._shareApp) { const dn=parseInt(trimmed); const r=shareTo(st._shareApp, dn, st._shareContent, personDir); return { screen:r, state:{...st,_shareContent:undefined,_shareApp:undefined} }; }

    const result = await notesCmd(args, {}, personDir);
    return { screen: result.content[0].text, state: state ?? {} };
  },
};
