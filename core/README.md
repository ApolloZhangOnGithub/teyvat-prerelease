# Teyvat 开发指南

注意，尽管当前文件部分内容为 ai 生成，但请 agent 在未明确经过人类允许、要求或授权情况下，不要直接修改本文档的内容。如果存在路径错误等明显内容，请告知人类，经过人类开发者同意后可以修改。对于其他内容则切勿随意修改，感谢。
（2026-08-13 按用户指令做过一次系统性维护，路径与流程已对齐当前结构。）

## 1. 入门

1. 仓库结构（见 `Continents.DEFINATION`）：A-C 在 `teyvat-main/`，D-R 在兄弟目录 `teyvat-sides/`
   - `A.core/`：开发源代码（唯一开发入口）。顶层模块：
     - `god.frontend.cli/`：genshin CLI 入口（命令、launcher）
     - `god.frontend.tui/`：TUI 改造（`overrides/` = 对 pi dist 的整文件覆盖 golden；`ui_elements/` = teyvat 自有组件）
     - `spirit.bio.organs/`：生物器官（kernel.heart 状态机、brain.* 决策记忆、hands.* 操作、head.* 感知表达）
     - `spirit.bio.abilities/`：外部能力层（voice.asr/tts、vision.vlm/ocr、internet.fetch/search；接口+供应商工厂模式）
     - `spirit.bio.gene/`：DNA（promotor/CHRs）→ polymerase → rna.json
     - `spirit.abio.roles/` `spirit.abio.status/` `spirit.abio.techniques/`：角色、状态、外部访问技术方案
     - `universe.infotech/`：local.mobile 等延伸科技
   - `B.docs/`：项目文档（Dev.Common：Lessons/Issues/Norms/Wiki/ADRs/...）
   - `C.deploy/`：部署工具（Makefile、install.sh、pi-image-source 原版镜像、check-*.sh）
2. 最核心模块为 `spirit.bio.organs/`（heart 为运行 kernel、brain 为决策/反思/记忆、hands 为操作、head.ears/eyes/mouth 为感知表达）
3. 跨模块 import 务必使用 `#alias`（见 `A.core/package.json` 的 `imports`），尽量避免硬编码路径
4. 全局路径常量在 `#paths`；消息注册/发送用 `#kernel_backbone` 的 `MESSAGE_TYPES` + `sendCustomMessage`（读 LESSON 054：显示与触发 turn 是两份职责）
5. 改了源码 → 部署：`cd C.deploy && make dev-minutely msg='标题≥10字' detail='详细≥50字'`（自动跑 transpiler/tsc/语法/render smoke 等完整性检查 → git commit+push → install.sh 覆盖部署）

| 用途 | 路径 |
|------|------|
| 记忆文件 | `~/.teyvat/MemoryData/<ID>/` |
| 原始 Session 记录 | `~/.teyvat/SessionData/<ID>/` |
| 运行时安装 | `~/.local/lib/teyvat/runtime/`（pi 包 + overrides） |
| 扩展部署 | `~/.local/lib/teyvat/extensions/teyvat/`（A.core 的 rsync 副本） |

## 2. 开发

开发目录为 `A.core/`。

| 模块 | 目录 | 说明 |
|----|------|------|
| god | `god.frontend.cli/` `god.frontend.tui/` | CLI 入口与 TUI 改造 |
| individual | `spirit.bio.gene/` `spirit.bio.organs/` `spirit.bio.abilities/` | DNA + 生物实体 + 外部能力 |
| abio | `spirit.abio.roles/` `spirit.abio.status/` `spirit.abio.techniques/` | 角色/状态/外部访问方案 |
| technology | `universe.infotech/local.mobile/` 等 | 手机系统与延伸科技 |

### 2.1 功能与模块注册（DNA/RNA 体系）

```
spirit.bio.gene/promotor.dna    ← 引导区声明（vir/func/session/mode/tag/in/duty/coded:）
spirit.bio.gene/CHRs/*.CHR      ← 内容件（每条染色体 = 一个基因序列单元）
       ↓ polymerase.ts（RNA 装配器，make integrity 时自动跑）
spirit.bio.gene/rna.json        ← 编译产物，运行时加载
```

### 2.2 ReAct 系统

所有跨器官消息统一走 `#kernel_backbone`：
- **注册**：`MESSAGE_TYPES` 表声明 `feed/feedAs/triggerNewTurn/render`
- **发送**：`sendCustomMessage(pi, messageType, content, details?, overrides?)`
- **自定义渲染**：`pi.registerMessageRenderer("type", renderer)` 注册 TUI 渲染器
- **格式要求**：renderer 返回组件，head 顶格 col0、body 缩进 GUTTER(2)，禁止裸文本 fallback
- **⚠️ LESSON 054**：`triggerNewTurn:false` 的消息是"只显示不开 turn"，绝不能被当作状态机唤醒信号（否则杀 wait、卡 working）

### 2.3 工具渲染与状态点规范

- **面向 Agent 的 ReAct**：成功→`isError:false`+有用结果；失败→`isError:true`+错误原因。永禁三元空 `{content:[],isError:false,details:{}}`
- **面向人类的点（dot）语义**（2026-08-13 用户指令更新）：
  - `•` 绿 = 成功完成
  - `◦` 黄 = **进行中/等待中**（wait 倒计时、hibernate 休眠、异步 execute 运行中、缺凭据警告）
  - `•` 红 = 错误/被打断
- 行号/结果渲染走统一 diff 管线（`generateDiffString` + `renderDiff`），不要各工具自造

功能列表（当前）
| 模块 | 目录 | 功能 |
|------|------|------|
| kernel.heart | `spirit.bio.organs/kernel.heart/heart*.ts` | 心跳状态机（working/resting/hibernated/paused/error-backoff）+ wait/hibernate 工具 |
| kernel.backbone | `spirit.bio.organs/kernel.backbone/backbone.ts` | 消息总线（MESSAGE_TYPES / sendCustomMessage） |
| kernel.ribosome | `spirit.bio.organs/kernel.ribosome/` | RNA 读取、prompt/mode/role 查询 |
| brain.intentions | `.../brain.intentions/` | 意图栈（默认强制覆盖，NORM 008） |
| brain.memory | `.../brain.memory/` | 记忆注入（冻结快照 + 增量） |
| brain.metaconsciousness | `.../brain.metaconsciousness/` | 元意识 |
| brain.hippocampus | `.../brain.hippocampus/` | 海马体（sleep 编码，当前部分停用） |
| brain.bioclock | `.../brain.bioclock/` | 生物钟 |
| hands.executes | `.../hands.executes/` | 主手（bash，快命令/后台/tty） |
| hands.fileacts | `.../hands.fileacts/` | 文件操作（xattr 信任链） |
| hands.webacts | `.../hands.webacts/` | 网络（search/fetch） |
| head.ears / head.mouth / head.eyes | `.../head.*/` | 听 / 说 / 看 |

## 3. 公约、调试与部署

### 3.1 命名规范

- 代码目录全小写点分：`brain.hippocampus`、`head.ears`、`spirit.bio.abilities/vision.ocr`
- 文档后缀全大写不加 `.md`：`.SPEC` `.CHANGELOG` `.LESSON` `.ISSUE` `.NORM` `.PROPOSAL` `.WIKI` `.TECHNIQUE`
- 详见 `B.docs/Dev.Common/Norms/`（000-root、001-naming-convention 等）

### 3.2 读写权限约定

- `#human.*` = 人类写的，**agent 只能读不能改**
- `#agent.*` = agent 写的，人类不改
- 无标记 = 都能写

### 3.3 调试与部署

#### 3.3.1 部署方法

```bash
cd C.deploy && make dev-minutely msg='标题(≥10字)' detail='详细(≥50字)'
```

- 改完代码必须走 `make dev-minutely`，不手动 cp 到 runtime（install.sh 有 manifest 漂移检测）
- 删除文件用 `trash <path>`
- integrity 检查（自动）：transpiler → tsc → 语法 → ESM → **render smoke 门禁**（check-render.mjs，11 项渲染回归断言）→ tool → 扩展加载 → 部署 → 帮助 → debug

| 命令 | 作用 |
|------|------|
| `make dev-minutely msg='...' detail='...'` | 开发部署到 canary（默认启动版本），git commit+push |
| `make dev-stable v=... msg='...'` | 钉住指定版本为 dev-stable 保底 |
| `make dev-restore v=...` | 从 artifact 回退部署 |
| `make release v=0.x.x` | 正式发布 |
| `make setup` | 新电脑首次安装 |

#### 3.3.2 部署通道

- `A.core/package.json` 的 `version` 是 release 号
- `make dev-minutely` 生成 `0.x.x-dev.YYYYMMDD.N`，`N` 同日递增、跨天重置；计数器在 `A.core/.build-counter`（随 commit 提交）
- 运行时版本在 `~/.teyvat/agent/version.json`：`{"genshin":"...","pi":"<PIN>","channel":"..."}`（PIN 见 C.deploy/install.sh，当前 0.80.7）
- 构建记录追加到 `Makelogs.KEYLOGS`

#### 3.3.3 自动部署

GitHub Actions `A.core/.github/workflows/nightly.yml`：每天北京时间 0 点自动 `make nightly`。

#### 3.3.4 其他目录

- `teyvat-sides/`：D-R 区（如 `F.experimental/GUI2TUIization` 实验、`R.release` 发布物）
- `B.docs/Cook.Human/README_release.md`：发布版 README 源

## 4. 教学文档

- **培训课程**：`B.docs/Dev.Common/Courses&Exams/`
- **开发教训**：`B.docs/Dev.Common/Lessons/`（`.LESSON` + `Lessons.INDEX`）
- **问题追踪**：`B.docs/Dev.Common/Issues/`（`.ISSUE` + 手维护 `Issues.INDEX`）
- 建议先读 `B.docs/Dev.Common/Norms/Top-Level/000-root.NORM`、`Continents.DEFINATION`

运行时数据路径在 `~/.teyvat/` 下。
