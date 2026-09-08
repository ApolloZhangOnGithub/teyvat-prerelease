# genshin (teyvat) prerelease 安装方法

> 2026-09-09 维护。发布线（prerelease/alpha）——适合新电脑/日常使用。
> 开发线（dev 源码）另见 install-dev。

## 0. 前置依赖

| 依赖 | 用途 | 安装（macOS） | 安装（Linux） |
|---|---|---|---|
| git | 拉发布仓库 | `brew install git` | `apt install git` |
| node ≥18 | 运行时 | `brew install node` | `apt install nodejs npm` |
| bun | agent 运行时 | `curl -fsSL https://bun.sh/install \| bash` | 同左 |
| tmux | 元意识/睡眠 | `brew install tmux` | `apt install tmux` |
| ffmpeg | 语音输入/播放 | `brew install ffmpeg` | `apt install ffmpeg` |
| python3 | OCR/文档解析 | `brew install python3` | `apt install python3 python3-pip` |

## 1. 拉发布仓库

```bash
git clone https://github.com/ApolloZhangOnGithub/paimon-code-prerelease.git ~/.local/lib/teyvat/update-prerelease
```

## 2. 部署（install.sh 自动完成：runtime + 扩展 + launcher）

```bash
cd ~/.local/lib/teyvat/update-prerelease
export PAIMON_VIA_MAKE=1 MAKELEVEL=1 PAIMON_CHANNEL=prerelease
bash deploy/install.sh
```

install.sh 会自动装功能依赖（Linux：wl-copy/xclip 剪贴板、rapidocr OCR 引擎；各平台：trafilatura 正文提取、office 文档读取 python-docx/pptx/openpyxl/PyMuPDF/xlrd）——装失败会提示手动命令。

## 3. 验证 + 建 agent

```bash
genshin --version     # 应显示 0.3.3-alpha.xxx
genshin alice_20260909   # 建第一个 agent（名字必须含数字——启动进入）
```

## 4. 日常更新

```bash
genshin update        # 自动拉 prerelease 仓库最新 → 部署
```

## 安装后结构

```
~/.local/bin/genshin                     launcher（入口命令）
~/.local/lib/teyvat/runtime              pi 运行时（node_modules）
~/.local/lib/teyvat/extensions/teyvat    扩展（agent 器官代码）
~/.local/lib/teyvat/update-prerelease    发布仓库（更新源）
~/.teyvat/agent/version.json             版本（channel: prerelease）
~/.teyvat/MemoryData/<agentId>/          agent 记忆/配置
```

## 常见问题

- **install.sh 报 "runtime not installed"**：HOME 环境问题——先 `export HOME=$(getent passwd $(id -u) | cut -d: -f6)` 再跑（容器/su shell 常见）
- **拉仓库慢/失败**：配代理（`export https_proxy=...`）或重试
- **跑 genshin 卡/闪退**：先 `genshin update` 到最新（每日多次发布）——旧版本问题可能已修
- **要装 dev 源码线**（开发用）：`curl -fsSL paimon.beer/install-dev | bash`
