# check-install-sources.cjs.SPEC

用途: 门禁 —— `install.sh` 里引用的源文件（`$IMPL/...` = A.core、`$DEPLOY/...` = C.deploy）**必须存在**，
除非就近注释写清了"为什么有意缺失"。

来历: 2026-09-11 prime-agent。`install.sh` 第 6 段（shell completion）引用的
`god.frontend.cli/genshin-completion.zsh` 在目录重构（`Codebase/core/god.cli/` → `god.frontend.cli/`）时**丢了**：
- 每次构建都 `warn "completion 源文件缺失，跳过（未改动 shell rc）"`（长期噪音，容易被当背景）
- `~/.zshrc` 里那条 `source ~/.teyvat/agent/config/genshin-completion.zsh` 指向不存在的文件（被 `2>/dev/null` 掩盖）= 死链

同一脚本里另有两处缺失是**有意的**（`universe.accessibility/claudecode` = 已移入 `teyvat-sides/F.experimental`；
`spirit.abio.identity/identity-cli.sh` = 仅存于 R.release/historical），且都写明了。
约定因此定为：**缺失可以，但必须写明原因**；没写的就是 bug（这正是 completion 那次的情形）。

用法: `node C.deploy/check-install-sources.cjs [C.deploy 路径] [A.core 路径]`（已接进 Makefile `_integrity`）

判定:
1. 扫 `install.sh` 里所有 `"$IMPL/<rel>"` / `"$DEPLOY/<rel>"` 引用（去重）
2. 文件存在 → OK
3. 不存在，但其上下 10 行内的注释含 `已移入|已不在 A.core|F.experimental|已移除|deprecated|历史遗留` → 记 `intentional` 通过
4. 不存在且没说原因 → **FAIL**（打印行号 + 该怎么写注释）

已验证门禁会失败：夹具里往 install.sh 塞一个 `$IMPL/god.frontend.cli/does-not-exist.ts` → exit 1 并点名该行。

配套修复: 恢复了 `god.frontend.cli/genshin-completion.zsh`（按当前 CLI 对齐重写：子命令 + agent 名补全，
plist 路径改为 `~/.teyvat/MemoryData/plist.json`，`compdef _genshin_comp genshin`）。
