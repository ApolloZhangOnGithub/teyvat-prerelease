import { APP_NAME } from "../config.js";
export const BUILTIN_SLASH_COMMANDS = [
    { name: "settings", description: "Open settings menu" },
    { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
    { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
    { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
    { name: "import", description: "Import and resume a session from a JSONL file" },
    { name: "share", description: "Share session as a secret GitHub gist" },
    // 2026-09-14（ISSUE 252）：移除内置 copy 占坑——teyvat 已禁用 pi 原生命令，此名空闲供 registerCommand("copy") 使用；
    // 撞名会让扩展命令被 autocomplete 跳过且不可达（诊断只在启动横幅 [Extension issues]，不进日志）。
    // 其余内置名如需启用同样走本清单移除 + make check-command-conflict.cjs 把关。
    { name: "name", description: "Set session display name" },
    { name: "session", description: "Show session info and stats" },
    { name: "changelog", description: "Show changelog entries" },
    { name: "hotkeys", description: "Show all keyboard shortcuts" },
    { name: "fork", description: "Create a new fork from a previous user message" },
    { name: "clone", description: "Duplicate the current session at the current position" },
    { name: "tree", description: "Navigate session tree (switch branches)" },
    { name: "trust", description: "Save project trust decision for future sessions" },
    { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
    { name: "logout", description: "Remove provider authentication" },
    { name: "new", description: "Start a new session" },
    { name: "resume", description: "Resume a different session" },
    { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
];
//# sourceMappingURL=slash-commands.js.map