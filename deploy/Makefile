# teyvat Makefile
export PAIMON_VIA_MAKE := 1

SHELL  := /bin/bash
ROOT   := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))" && pwd)
DEV    := $(ROOT)/../A.core
CORE   := $(DEV)
DEPLOY := $(ROOT)
ECOSYSTEM  := $(ROOT)/../../teyvat-sides/R.release/website

# ── 路径变量（目录改名只改这里）──
CLI        := god.frontend.cli
TUI        := god.frontend.tui
TRANSPILER := spirit.bio.gene/polymerase.ts

.PHONY: help setup bump dev-minutely dev-stable note prerelease-minutely release nightly wiki-deploy wiki-publish sync-deploy dev-restore _paths _ecosystem \
        _dev-minutely _dev-stable _note _prerelease-minutely _release

# ── 构建串行化 ─────────────────────────────────────────────────────────────
# 加锁必须包住「_integrity + 构建」全程。不能在 recipe 里就地 mkdir+trap：
# make 每个 recipe 行是独立 shell，trap ... EXIT 会在该行结束时就释放锁，
# 而真正的构建在下一行才开始 —— 旧的 .make-lock 因此从未生效（实测已确认）。
# 故用 with-lock.sh 把整条子 make 跑在同一进程里，trap 覆盖全程。
LOCKED = MAKE_LOCK_DIR="$(ROOT)/.make-lock" bash "$(DEPLOY)/with-lock.sh" $(MAKE) --no-print-directory

# ── 路径存在性校验（缺失即失败，不静默跳过）──
# 目录改名后 Makefile 变量不同步是反复踩的坑：glob 零匹配会被 [ -f ] 悄悄跳过，
# 检查看起来全绿，实际一个文件都没查。所有检查前先把路径钉死。
_paths:
	@FAIL=0; \
	for p in "$(CORE)" "$(DEPLOY)" "$(CORE)/$(CLI)" "$(CORE)/$(TUI)" \
	         "$(CORE)/$(TUI)/overrides" "$(CORE)/$(TUI)/ui_elements" \
	         "$(CORE)/$(TRANSPILER)" "$(CORE)/$(CLI)/cli.ts"; do \
		[ -e "$$p" ] || { echo "  ERROR: 路径不存在: $$p"; FAIL=1; }; \
	done; \
	for s in install.sh check-tools.sh check-deploy.sh check-help.sh check-debug.sh with-lock.sh; do \
		[ -f "$(DEPLOY)/$$s" ] || { echo "  ERROR: 部署脚本缺失: $(DEPLOY)/$$s"; FAIL=1; }; \
	done; \
	[ "$$FAIL" = "0" ] || { echo "  路径校验失败 —— 目录改名后请同步 Makefile 顶部路径变量"; exit 1; }

# wiki/sync 专用：ecosystem 是独立仓库，dev 构建不需要，故单独校验
_ecosystem:
	@[ -d "$(ECOSYSTEM)/wiki.paimon.beer" ] || { \
		echo "  ERROR: ecosystem 不存在: $(ECOSYSTEM)/wiki.paimon.beer"; \
		echo "  wiki-deploy / wiki-publish / sync-deploy 依赖它，请先检出 ecosystem 仓库"; exit 1; }

help:
	@echo ""
	@echo "  teyvat"
	@echo "  ───────────────────────────────────────────────────────"
	@echo "  bump                     升版本号 (make bump v=0.x.x)，自动改 package.json 的 version 字段"
	@echo "  dev-minutely             开发部署（minutely canary → X.Y.Z-dev.YYYYMMDD.N，递增 N）—— committer/msg/detail 三参数必填"
	@echo "  dev-stable               钉住当前 dev 为 dev-stable 保底"
	@echo "  prerelease-minutely       发布 alpha（X.Y.Z-alpha.YYYYMMDD.M，独立递增 M + pin dev）。用 dev= 绑指定 dev，默认绑最新"
	@echo "  release                  正式发布 (make release v=0.x.x)"
	@echo "  dev-restore              回退到指定 minutely 版本并部署 (make dev-restore v=0.x.x-dev.20xxxxxx.xx)"
	@echo "  wiki-deploy              部署 wiki 到服务器"
	@echo "  wiki-publish             发布 .WIKI 文件到 wiki.paimon.beer"
	@echo "  sync-deploy              部署 sync 服务到服务器"
	@echo "  setup                    新电脑首次安装（不 commit、不 push）"
	@echo ""

# ── bump (版本号升级) ──
# package.json 的 version 字段是唯一版本真相源，dev-minutely/prerelease/release 全读它。
# 升版本必须走 make bump，不要手动编辑 package.json。
# bump 只改 version 字段（→ v-dev），不 commit、不部署——后续 make dev-minutely 一并提交。

bump:
	@if [ -z "$(v)" ]; then echo "  用法: make bump v=0.x.x (例: make bump v=0.3.3)"; exit 1; fi
	@CUR=$$(node -e "console.log(require('$(CORE)/package.json').version)"); \
	NEW="$(v)-dev"; \
	if [ "$$CUR" = "$$NEW" ]; then echo "  version 已是 $$NEW，无需变更"; exit 0; fi; \
	node -e " \
	  const fs = require('fs'); \
	  const f = '$(CORE)/package.json'; \
	  const pkg = JSON.parse(fs.readFileSync(f, 'utf8')); \
	  const old = pkg.version; \
	  pkg.version = '$$NEW'; \
	  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n'); \
	  console.log('  version: ' + old + ' → ' + '$$NEW'); \
	"; \
	echo "  下一步: make dev-minutely msg='...' detail='...'"

# ── setup (新电脑首次安装) ──

setup: _paths
	@[ -d "$(CORE)/node_modules" ] || (cd "$(CORE)" && npm install)
	@PAIMON_CHANNEL="minutely" bash "$(DEPLOY)/install.sh"

# ── integrity (minutely/stable/release 前自动执行) ──

_integrity: _paths
	@if [ -z "$${committer:-}" ]; then echo "  ERROR: committer required. Usage: make dev-minutely committer='提交者名' msg='标题(≥10字)' detail='详细内容(≥50字)'"; exit 1; fi
	@if [ -z "$${msg:-}" ]; then echo "  ERROR: msg required. Usage: make dev-minutely committer='提交者名' msg='标题(≥10字)' detail='详细内容(≥50字)'"; exit 1; fi
	@if [ $${#msg} -lt 10 ]; then echo "  ERROR: msg 标题不得少于10个字（当前$${#msg}字）"; exit 1; fi
	@if [ -z "$${detail:-}" ]; then echo "  ERROR: detail required"; exit 1; fi
	@if [ $${#detail} -lt 50 ]; then echo "  ERROR: detail 详细内容不得少于50字（当前$${#detail}字）"; exit 1; fi
	@echo "[$$(date +%H:%M:%S)] transpile..." && cd "$(CORE)" && bun $(TRANSPILER)
	@echo "[$$(date +%H:%M:%S)] tsc check..." && cd "$(CORE)" && npx tsc --noEmit 2>&1 || { echo "  tsc: type errors above"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] syntax check..." && cd "$(CORE)" && \
		N=0; FAIL=0; \
		while IFS= read -r f; do \
			N=$$((N+1)); \
			node --check "$$f" >/dev/null 2>&1 || { echo "  FAIL: $$f"; node --check "$$f" 2>&1 | head -3; FAIL=1; }; \
		done < <(find "$(CLI)" -maxdepth 1 -name '*.cjs'; find "$(TUI)/overrides" "$(TUI)/ui_elements" -name '*.js'); \
		[ "$$N" -gt 0 ] || { echo "  ERROR: syntax check 零匹配 —— 目录结构已变，检查未生效"; exit 1; }; \
		echo "  checked $$N files"; \
		[ "$$FAIL" = "0" ] || { echo "  syntax errors found, abort"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] ESM require check..." && cd "$(CORE)" && \
		N=0; FAIL=0; \
		while IFS= read -r f; do \
			N=$$((N+1)); \
			if grep -q 'require(' "$$f" 2>/dev/null && ! grep -q 'createRequire' "$$f" 2>/dev/null; then \
				REAL=$$(grep -E 'require\(' "$$f" | grep -vcE '^[[:space:]]*//'); \
				if [ "$$REAL" -gt 0 ]; then echo "  BARE require in ESM: $$f"; FAIL=1; fi; \
			fi; \
		done < <(find "$(TUI)/overrides" "$(TUI)/ui_elements" "$(TUI)/commands" \( -name '*.js' -o -name '*.ts' \)); \
		[ "$$N" -gt 0 ] || { echo "  ERROR: ESM check 零匹配 —— 目录结构已变，检查未生效"; exit 1; }; \
		echo "  checked $$N files"; \
		[ "$$FAIL" = "0" ] || { echo "  ESM require errors — add createRequire or remove require()"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] resolve check..." && node "$(DEPLOY)/check-resolve.cjs" "$(CORE)" || { echo "  resolve check FAILED — 存在解析不到真实文件的 import/require（镜像 jiti 运行时语义，LESSON 056），修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] launcher check..." && node "$(DEPLOY)/check-launcher.cjs" "$(CORE)/god.frontend.cli/launcher.sh" || { echo "  launcher check FAILED — 后台构造未做终端隔离（LESSON 037 / ISSUE 088），修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] require-entry check..." && node "$(DEPLOY)/check-require-entry.cjs" "$(CORE)" || { echo "  require-entry check FAILED — 禁止裸引用 @earendil-works/pi-coding-agent（LESSON 056），修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] render smoke check..." && node "$(DEPLOY)/check-render.mjs" "$(CORE)" || { echo "  render smoke check FAILED — pi-tui 渲染器回归（null 保护/标题定制丢失等），修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] tool check..." && bash "$(DEPLOY)/check-tools.sh" "$(CORE)" || { echo "  tool check FAILED — 修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] manifest-tools check..." && node "$(DEPLOY)/check-manifest-tools.cjs" "$(CORE)" || { echo "  manifest-tools check FAILED — 已注册工具未进 tools.manifest.json 会被 session_start 过滤静默剔除（LESSON amem），补清单或移除注册后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] theme-consistency check..." && node "$(DEPLOY)/check-theme-consistency.cjs" "$(CORE)" || { echo "  theme-consistency check FAILED — dark/light 配色键必须一一对应（用户：light 缺键会丢色/回退），补齐后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] mobile-apps check..." && node "$(DEPLOY)/check-mobile-apps.cjs" "$(CORE)" || { echo "  mobile-apps check FAILED — appstore 名字校验缺失（路径穿越）或 app 字段不全，见 check-mobile-apps.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] upload-policy check..." && node "$(DEPLOY)/check-upload-policy.cjs" "$(CORE)" || { echo "  upload-policy check FAILED — web upload 的路径策略缺失/被削弱（任意本地文件可被上传外泄），见 check-upload-policy.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] code-refs check..." && node "$(DEPLOY)/check-code-refs.cjs" "$(CORE)" || { echo "  code-refs check FAILED — 代码里的相对引用指向不存在的文件（运行时 no such file），见 check-code-refs.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] shell-injection check..." && node "$(DEPLOY)/check-shell-injection.cjs" "$(CORE)" || { echo "  shell-injection check FAILED — 外部输入被拼进 shell 字符串（注入面，且绕过 validateExecute），见 check-shell-injection.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] fileacts-guard check..." && node "$(DEPLOY)/check-fileacts-guard.cjs" "$(CORE)" || { echo "  fileacts-guard check FAILED — 权限守卫出绕过或误拦（他人数据目录边界），见 check-fileacts-guard.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] sync-ua check..." && node "$(DEPLOY)/check-sync-ua.cjs" "$(CORE)" || { echo "  sync-ua check FAILED — 打到 sync 服务的请求没带 User-Agent（Cloudflare 会 403 error 1010），见 check-sync-ua.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] doc-refs check..." && node "$(DEPLOY)/check-doc-refs.cjs" "$(CORE)" || { echo "  doc-refs check FAILED — WIKI/NORM 引用的仓库文件不存在（旧路径/错扩展名会让读者找不到东西），见 check-doc-refs.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] install-sources check..." && node "$(DEPLOY)/check-install-sources.cjs" "$(DEPLOY)" "$(CORE)" || { echo "  install-sources check FAILED — install.sh 引用的源文件缺失且未说明原因（历史上的 shell completion 就是这样丢的），见 check-install-sources.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] doctor-docs check..." && node "$(DEPLOY)/check-doctor-docs.cjs" "$(CORE)" || { echo "  doctor-docs check FAILED — Doctor WIKI 的检查项表与 doctor.ts 漂移（文档说有的检查其实不存在，或反之），见 check-doctor-docs.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] rename-identity check..." && node "$(DEPLOY)/check-rename-identity.cjs" "$(CORE)" || { echo "  rename-identity check FAILED — 改名没同步 identity.json（doctor 会永久报不一致），见 ISSUE 195 / check-rename-identity.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] atomic-writes check..." && node "$(DEPLOY)/check-atomic-writes.cjs" "$(CORE)" || { echo "  atomic-writes check FAILED — 被并发读的状态文件必须原子写（tmp+rename / writeFileAtomic），见 ISSUE 182 附录 / check-atomic-writes.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] pidfile check..." && node "$(DEPLOY)/check-pidfile.cjs" "$(CORE)" || { echo "  pidfile check FAILED — main.pid 损坏会被读数/守卫误判（离线误报、双实例），见 ISSUE 182 / check-pidfile.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] numbering check..." && node "$(DEPLOY)/check-numbering.cjs" "$(CORE)" || { echo "  numbering check FAILED — 列表显示序号与 genshin N 解析不一致（会选错 agent）见 ISSUE 192 / check-numbering.cjs.SPEC"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] theme-usage check..." && node "$(DEPLOY)/check-theme-usage.cjs" "$(CORE)" || { echo "  theme-usage check FAILED — 代码里用了 colors 里没有的颜色名，运行时 Theme.fg()/bg() 会抛 Unknown theme color（历史：white 15034 次、default 5 次），改名字或在该行加 theme-allow 注释后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] empty-catch check..." && node "$(DEPLOY)/check-empty-catch.cjs" || { echo "  empty-catch check FAILED — 空 catch{} 静默吞错（LESSON 024 反模式，用户：任何地方空 catch 都无法运行通过）— 修复: node C.deploy/fix-empty-catch.cjs --apply"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] func-load check..." && node "$(DEPLOY)/check-func-load.mjs" "$(CORE)" || { echo "  func-load check FAILED — func 加载失败必须 fail-fast（ISSUE 112，用户多次强调），门禁缺失或 func 结构异常都禁止部署；修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] extension load check..." && cd "$(CORE)" && (set -o pipefail; (command -v timeout >/dev/null 2>&1 && timeout 30 node -e "import('./index.ts').then(() => { console.log('  extension: OK'); process.exit(0); }).catch(e => { console.error('  extension LOAD FAIL: ' + e.message); process.exit(1); })" 2>&1 || node -e "import('./index.ts').then(() => { console.log('  extension: OK'); process.exit(0); }).catch(e => { console.error('  extension LOAD FAIL: ' + e.message); process.exit(1); })" 2>&1) | grep -v ExperimentalWarning) || { echo "  extension load check FAILED"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] dep check..." && ( for pkg in "$(CORE)/node_modules/@earendil-works/pi-tui" "$$HOME/.local/lib/teyvat/runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"; do \
		[ -d "$$pkg" ] || continue; \
		[ -d "$$pkg/node_modules/marked" ] || ( echo "  fixing pi-tui deps..." && cd "$$pkg" && npm install --silent 2>&1 ); \
	done )
	@echo "[$$(date +%H:%M:%S)] boundary check..." && bash "$(DEPLOY)/check-boundaries.sh" "$(CORE)"
	@echo "[$$(date +%H:%M:%S)] deploy check..." && bash "$(DEPLOY)/check-deploy.sh" "$(DEV)"
	@echo "[$$(date +%H:%M:%S)] help check..." && bash "$(DEPLOY)/check-help.sh" "$(CORE)/god.frontend.cli/cli.ts"
	@echo "[$$(date +%H:%M:%S)] debug check..." && bash "$(DEPLOY)/check-debug.sh" "$(CORE)"

# ── dev ──

dev-minutely:
	@$(LOCKED) _dev-minutely
	# 2026-09-08（用户定稿：dev 默认自动发 prerelease——要手动选"不发"才不发）：完成 dev 构建后自动推 prerelease（SKIP_PRERELEASE=1 显式跳过）
	@if [ -n "$(SKIP_PRERELEASE)" ]; then echo "[$$(date +%H:%M:%S)] SKIP_PRERELEASE=1——跳过 prerelease（要发时手动 make prerelease-minutely）"; else echo "[$$(date +%H:%M:%S)] 自动推 prerelease（不发用 SKIP_PRERELEASE=1）"; $(MAKE) prerelease-minutely; fi

_dev-minutely: _integrity
	@echo "[$$(date +%H:%M:%S)] integrity done"
	@REL_VER=$$(node -e "console.log(require('$(CORE)/package.json').version)"); \
	TODAY=$$(date +%Y%m%d); \
	COUNTER_FILE="$(CORE)/.build-counter"; \
	if [ -f "$$COUNTER_FILE" ]; then \
		read LAST_DATE LAST_COUNT LAST_REL_VER < "$$COUNTER_FILE"; \
		if [ "$$LAST_DATE" = "$$TODAY" ] && [ "$$LAST_REL_VER" = "$$REL_VER" ]; then \
			COUNT=$$((LAST_COUNT + 1)); \
		else \
			COUNT=1; \
		fi; \
	else \
		COUNT=1; \
	fi; \
	PAIMON_VER="$$REL_VER.$$TODAY.$$COUNT"; \
	echo -e "  teyvat $$PAIMON_VER (minutely)"; \
	if [ -z "$${committer:-}" ]; then echo -e "  ${RED}ERROR: committer required. Usage: make dev-minutely committer='提交者名' msg='标题(≥10字)' detail='详细内容(≥50字)'${R}"; exit 1; fi; \
	if [ -z "$${msg:-}" ]; then echo -e "  ${YLW}ERROR: msg required. Usage: make dev-minutely committer='提交者名' msg='标题(≥10字)' detail='详细内容(≥50字)'${R}"; exit 1; fi; \
	if [ $${#msg} -lt 10 ]; then echo -e "  ${RED}ERROR: msg 标题不得少于10个字（当前$${#msg}字）${R}"; exit 1; fi; \
	if [ -z "$${detail:-}" ]; then echo -e "  ${RED}ERROR: detail required. Usage: make dev-minutely committer='提交者名' msg='标题' detail='详细内容(≥50字)'${R}"; exit 1; fi; \
	if [ $${#detail} -lt 50 ]; then echo -e "  ${RED}ERROR: detail 详细内容不得少于50字（当前$${#detail}字）${R}"; exit 1; fi; \
	SRC_README="$(ROOT)/../B.docs/Cook.Human/README_dev.md"; \
	DST_README="$(DEV)/README.md"; \
	if [ -f "$$DST_README" ] && ! diff -q "$$SRC_README" "$$DST_README" >/dev/null 2>&1; then \
		echo -e "  ${YLW}ERROR: README.md differs from README_dev.md — was it manually edited? trash it first${R}"; exit 1; \
	fi; \
	cp "$$SRC_README" "$$DST_README"; \
	echo "[$$(date '+%Y-%m-%d %H:%M:%S')] $$PAIMON_VER  [$$committer]  $$msg" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	echo "  $$detail" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	echo "" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER" -m "[$$committer] $$msg" -m "$$detail") && \
	echo "$$TODAY $$COUNT $$REL_VER" > "$$COUNTER_FILE" && \
	(cd "$(DEV)" && git fetch origin main 2>/dev/null; cd "$(DEV)" && git diff --quiet origin/main..HEAD 2>/dev/null || { echo -e "  pushing $$PAIMON_VER..."; cd "$(DEV)" && if git push origin main 2>&1 | sed 's/^/  /'; then echo -e "  ${GRN}pushed${R}"; else echo -e "  ${RED}push FAILED —— 本地有 $$PAIMON_VER 但远端没有！先查网络/权限，再手动 git push origin main（不然后续版本会和远端分叉）${R}"; fi; }); \
	echo "[$$(date +%H:%M:%S)] git done"; \
	trash "$$DST_README" 2>/dev/null || true; \
	PAIMON_VER="$$PAIMON_VER" PAIMON_CHANNEL="minutely" bash "$(DEPLOY)/install.sh" || { echo "  install.sh FAILED —— 部署未完成，别信下面的 install done"; exit 1; }; \
	node "$(DEPLOY)/check-imports.mjs" || { echo "  import check FAILED — override exports broken"; exit 1; }; \
	~/.teyvat/auto-backup.sh >/dev/null 2>/dev/null || echo "  auto-backup skipped"; \
	if [ "$${ARTIFACT:-}" = "1" ]; then \
	  ARTIFACT_DIR="$(ROOT)/../../teyvat-sides/R.release/build-artifacts"; \
	  mkdir -p "$$ARTIFACT_DIR"; \
	  ( tar czfh "$$ARTIFACT_DIR/$$PAIMON_VER.tar.gz" -C "$$HOME/.local/lib/teyvat" runtime extensions 2>/dev/null && \
	  echo "  artifact: $$ARTIFACT_DIR/$$PAIMON_VER.tar.gz" || echo "  artifact: failed" ) & \
	else \
	  echo "  artifact: skipped (默认跳过。重要版本用 ARTIFACT=1 make dev-minutely ... 打包)"; \
	fi
	echo "[$$(date +%H:%M:%S)] install done"

dev-restore:
	@if [ -z "$(v)" ]; then echo -e "  ${YLW}ERROR: v required. Usage: make dev-restore v=0.x.x-dev.20xxxxxx.xx${R}"; exit 1; fi; \
	ARTIFACT_DIR="$(ROOT)/../../teyvat-sides/R.release/build-artifacts"; \
	ARTIFACT="$$ARTIFACT_DIR/$(v).tar.gz"; \
	if [ ! -f "$$ARTIFACT" ]; then echo -e "  ${RED}ERROR: artifact $$ARTIFACT not found. Only versions built with new make have artifacts.${R}"; exit 1; fi; \
	echo "  restoring $(v) from artifact..."; \
	tar xzf "$$ARTIFACT" -C "$$HOME/.local/lib/teyvat" && \
	echo -e "  ${GRN}deployed $(v)${R} (from immutable artifact)"; \
	COMMIT=$$(cd "$(DEV)" && git log --oneline --all | grep -E "^[a-f0-9]+ $(v)$$" | head -1 | cut -d' ' -f1); \
	if [ -n "$$COMMIT" ]; then cd "$(DEV)" && git checkout "$$COMMIT" -- "$(CORE)/" 2>/dev/null && echo "  source restored to $(v)"; fi

dev-stable:
	@$(LOCKED) _dev-stable

_dev-stable: _integrity
	@if [ -z "$(v)" ]; then echo -e "  ${YLW}ERROR: v required. Usage: make dev-stable v=0.x.x-dev.YYYYMMDD.NNN msg='what changed'${R}"; exit 1; fi; \
	if [ -z "$${msg:-}" ]; then echo -e "  ${YLW}ERROR: msg required. Usage: make dev-stable v=0.x.x-dev.YYYYMMDD.NNN msg='what changed'${R}"; exit 1; fi; \
	PAIMON_VER="$(v)"; \
	cd "$(DEV)" && git tag "dev-stable-$$PAIMON_VER" && git tag -f dev-stable && git push origin "dev-stable-$$PAIMON_VER" dev-stable -f && echo -e "  tagged dev-stable → $$PAIMON_VER"; \
	PAIMON_VER="$$PAIMON_VER" PAIMON_CHANNEL="dev-stable" bash "$(DEPLOY)/install.sh"

# ── note（手动日志，2026-09-04 用户定稿）──
# agent/人提交的手动记录（测试结果、观察、决策等），追加到 Makelogs_Mannual.KEYLOGS。
# 与 dev-minutely 日志（Makelogs_Minutely.KEYLOGS）格式一致：[时间戳] 版本号 + detail 段，
# 每条自动生成 note id（note-YYYYMMDD-HHMMSS-<4hex>）便于引用。纯写日志：不 bump 版本、不 git、不部署。
# 用法: make note committer='提交者名' msg='标题(≥10字)' detail='内容(≥30字)'
# 锁：与 dev-minutely 共用 .make-lock（同锁串行，防并发写日志文件）。
note:
	@$(LOCKED) _note

_note:
	@if [ -z "$${committer:-}" ]; then echo -e "  ${RED}ERROR: committer required. Usage: make note committer='提交者名' msg='标题(≥10字)' detail='内容(≥30字)'${R}"; exit 1; fi; \
	if [ -z "$${msg:-}" ]; then echo -e "  ${YLW}ERROR: msg required. Usage: make note committer='提交者名' msg='标题(≥10字)' detail='内容(≥30字)'${R}"; exit 1; fi; \
	if [ $${#msg} -lt 10 ]; then echo -e "  ${RED}ERROR: msg 标题不得少于10个字（当前$${#msg}字）${R}"; exit 1; fi; \
	if [ -z "$${detail:-}" ]; then echo -e "  ${RED}ERROR: detail required. Usage: make note committer='提交者名' msg='标题' detail='内容(≥30字)'${R}"; exit 1; fi; \
	if [ $${#detail} -lt 30 ]; then echo -e "  ${RED}ERROR: detail 内容不得少于30个字（当前$${#detail}字）${R}"; exit 1; fi; \
	NOTE_VER=$$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.teyvat/agent/version.json','utf8')).genshin||'unknown')}catch(e){console.log('unknown')}"); \
	NOTE_TS=$$(date '+%Y-%m-%d %H:%M:%S'); \
	NOTE_ID="note-$$(date '+%Y%m%d-%H%M%S')-$$(openssl rand -hex 2 2>/dev/null || printf '%04x' $$((RANDOM % 65536)))"; \
	echo "[$$NOTE_TS] $$NOTE_VER  [$$NOTE_ID]  [$$committer]  $$msg" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo "  $$detail" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo "" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo -e "  ${GRN}note $$NOTE_ID logged${R} → Makelogs_Mannual.KEYLOGS"

# ── release ──

prerelease-minutely:
	@$(LOCKED) _prerelease-minutely

_prerelease-minutely: _integrity
	@bash "$(DEPLOY)/prerelease.sh" "$(CORE)" "$$(node -e "console.log(require('$(CORE)/package.json').version)")" "$(dev)" "$(DEPLOY)/build-release.sh"

release:
	@$(LOCKED) _release

_release: _integrity
	@if [ -z "$(v)" ]; then echo "usage: make release v=0.x.x"; exit 1; fi
	@cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "release v$(v) $$(date '+%m-%d %H:%M')")
	@bash "$(DEPLOY)/build-release.sh" "$(v)" stable

# ── docs / wiki ──

# 2026-09-07（安全：公开仓库不写真实服务器——deploy 目标用环境变量 SYNC_SERVER 或占位；本机内部部署见 teyvat-sides deploy.sh）
SERVER := $(if $(SYNC_SERVER),$(SYNC_SERVER),root@<your-sync-server>)

wiki-deploy: _ecosystem
	@bash "$(ECOSYSTEM)/wiki.paimon.beer/deploy.sh"

wiki-publish: _ecosystem
	@bash "$(ECOSYSTEM)/wiki.paimon.beer/publish.sh"

sync-deploy: _ecosystem
	@bash "$(ECOSYSTEM)/wiki.paimon.beer/sync-deploy.sh"

# ── CI nightly ──

nightly:
	@REL_VER=$$(node -e "console.log(require('$(CORE)/package.json').version)"); \
	TODAY=$$(date +%Y%m%d); \
	COUNTER_FILE="$(CORE)/.build-counter"; \
	if [ -f "$$COUNTER_FILE" ]; then \
		read LAST_DATE LAST_COUNT LAST_REL_VER < "$$COUNTER_FILE"; \
		# 2026-09-07 修复（同 dev-minutely）：跨天 OR 版本号 bump → 重置 COUNT=1（同天递增仅限同版本号）
		if [ "$$LAST_DATE" = "$$TODAY" ] && [ "$$LAST_REL_VER" = "$$REL_VER" ]; then \
			COUNT=$$((LAST_COUNT + 1)); \
		else \
			COUNT=1; \
		fi; \
	else \
		COUNT=1; \
	fi; \
	echo "$$TODAY $$COUNT $$REL_VER" > "$$COUNTER_FILE"; \
	PAIMON_VER="$$REL_VER.$$TODAY.$$COUNT"; \
	echo "teyvat $$PAIMON_VER"; \
	if [ -n "$$MSG_FILE" ] && [ -f "$$MSG_FILE" ]; then \
		cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER" -F "$$MSG_FILE"); \
	else \
		cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER"); \
	fi; \
	cd "$(DEV)" && git push origin main
