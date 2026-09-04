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

.PHONY: help setup dev-minutely dev-stable note prerelease-minutely release nightly wiki-deploy wiki-publish sync-deploy dev-restore _paths _ecosystem \
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
	@echo "  dev-minutely             开发部署（minutely canary，默认启动版本）"
	@echo "  dev-stable               钉住当前 dev 为 dev-stable 保底"
	@echo "  prerelease-minutely       推送精简包到 github-prerelease"
	@echo "  release                  正式发布 (make release v=0.x.x)"
	@echo "  dev-restore              回退到指定 minutely 版本并部署 (make dev-restore v=0.x.x-dev.20xxxxxx.xx)"
	@echo "  wiki-deploy              部署 wiki 到服务器"
	@echo "  wiki-publish             发布 .WIKI 文件到 wiki.paimon.beer"
	@echo "  sync-deploy              部署 sync 服务到服务器"
	@echo "  setup                    新电脑首次安装（不 commit、不 push）"
	@echo ""

# ── setup (新电脑首次安装) ──

setup: _paths
	@[ -d "$(CORE)/node_modules" ] || (cd "$(CORE)" && npm install)
	@PAIMON_CHANNEL="minutely" bash "$(DEPLOY)/install.sh"

# ── integrity (minutely/stable/release 前自动执行) ──

_integrity: _paths
	@if [ -z "$${msg:-}" ]; then echo "  ERROR: msg required. Usage: make dev-minutely msg='标题(≥10字)' detail='详细内容(≥50字)'"; exit 1; fi
	@if [ $${#msg} -lt 10 ]; then echo "  ERROR: msg 标题不得少于10个字（当前$${#msg}字）"; exit 1; fi
	@if [ -z "$${detail:-}" ]; then echo "  ERROR: detail required"; exit 1; fi
	@if [ $${#detail} -lt 50 ]; then echo "  ERROR: detail 详细内容不得少于50字（当前$${#detail}字）"; exit 1; fi
	@echo "[$$(date +%H:%M:%S)] transpile..." && cd "$(CORE)" && bun $(TRANSPILER)
	@echo "[$$(date +%H:%M:%S)] tsc check..." && cd "$(CORE)" && npx tsc --noEmit 2>&1 || echo "  tsc: warnings above (non-blocking)"
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
	@echo "[$$(date +%H:%M:%S)] empty-catch check..." && node "$(DEPLOY)/check-empty-catch.cjs" || { echo "  empty-catch check FAILED — 空 catch{} 静默吞错（LESSON 024 反模式，用户：任何地方空 catch 都无法运行通过）— 修复: node C.deploy/fix-empty-catch.cjs --apply"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] func-load check..." && node "$(DEPLOY)/check-func-load.mjs" "$(CORE)" || { echo "  func-load check FAILED — func 加载失败必须 fail-fast（ISSUE 112，用户多次强调），门禁缺失或 func 结构异常都禁止部署；修复后再 make"; exit 1; }
	@echo "[$$(date +%H:%M:%S)] extension load check..." && cd "$(CORE)" && (set -o pipefail; (command -v timeout >/dev/null 2>&1 && timeout 30 node --experimental-transform-types -e "import('./index.ts').then(() => { console.log('  extension: OK'); process.exit(0); }).catch(e => { console.error('  extension LOAD FAIL: ' + e.message); process.exit(1); })" 2>&1 || node --experimental-transform-types -e "import('./index.ts').then(() => { console.log('  extension: OK'); process.exit(0); }).catch(e => { console.error('  extension LOAD FAIL: ' + e.message); process.exit(1); })" 2>&1) | grep -v ExperimentalWarning) || { echo "  extension load check FAILED"; exit 1; }
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

_dev-minutely: _integrity
	@echo "[$$(date +%H:%M:%S)] integrity done"
	@REL_VER=$$(node -e "console.log(require('$(CORE)/package.json').version)"); \
	TODAY=$$(date +%Y%m%d); \
	COUNTER_FILE="$(CORE)/.build-counter"; \
	if [ -f "$$COUNTER_FILE" ]; then \
		read LAST_DATE LAST_COUNT < "$$COUNTER_FILE"; \
		if [ "$$LAST_DATE" = "$$TODAY" ]; then \
			COUNT=$$((LAST_COUNT + 1)); \
		else \
			COUNT=1; \
		fi; \
	else \
		COUNT=1; \
	fi; \
	PAIMON_VER="$$REL_VER.$$TODAY.$$COUNT"; \
	echo -e "  teyvat $$PAIMON_VER (minutely)"; \
	if [ -z "$${msg:-}" ]; then echo -e "  ${YLW}ERROR: msg required. Usage: make dev-minutely msg='标题(≥10字)' detail='详细内容(≥50字)'${R}"; exit 1; fi; \
	if [ $${#msg} -lt 10 ]; then echo -e "  ${RED}ERROR: msg 标题不得少于10个字（当前$${#msg}字）${R}"; exit 1; fi; \
	if [ -z "$${detail:-}" ]; then echo -e "  ${RED}ERROR: detail required. Usage: make dev-minutely msg='标题' detail='详细内容(≥50字)'${R}"; exit 1; fi; \
	if [ $${#detail} -lt 50 ]; then echo -e "  ${RED}ERROR: detail 详细内容不得少于50字（当前$${#detail}字）${R}"; exit 1; fi; \
	SRC_README="$(ROOT)/../B.docs/Cook.Human/README_dev.md"; \
	DST_README="$(DEV)/README.md"; \
	if [ -f "$$DST_README" ] && ! diff -q "$$SRC_README" "$$DST_README" >/dev/null 2>&1; then \
		echo -e "  ${YLW}ERROR: README.md differs from README_dev.md — was it manually edited? trash it first${R}"; exit 1; \
	fi; \
	cp "$$SRC_README" "$$DST_README"; \
	echo "[$$(date '+%Y-%m-%d %H:%M:%S')] $$PAIMON_VER  $$msg" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	echo "  $$detail" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	echo "" >> "$(ROOT)/../Makelogs_Minutely.KEYLOGS"; \
	cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER" -m "$$msg" -m "$$detail") && \
	echo "$$TODAY $$COUNT" > "$$COUNTER_FILE" && \
	(cd "$(DEV)" && git fetch origin main 2>/dev/null; cd "$(DEV)" && git diff --quiet origin/main..HEAD 2>/dev/null || { echo -e "  pushing $$PAIMON_VER..."; cd "$(DEV)" && git push origin main 2>/dev/null && echo -e "  pushed"; }); \
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
# 用法: make note msg='标题(≥10字)' detail='内容(≥30字)'
# 锁：与 dev-minutely 共用 .make-lock（同锁串行，防并发写日志文件）。
note:
	@$(LOCKED) _note

_note:
	@if [ -z "$${msg:-}" ]; then echo -e "  ${YLW}ERROR: msg required. Usage: make note msg='标题(≥10字)' detail='内容(≥30字)'${R}"; exit 1; fi; \
	if [ $${#msg} -lt 10 ]; then echo -e "  ${RED}ERROR: msg 标题不得少于10个字（当前$${#msg}字）${R}"; exit 1; fi; \
	if [ -z "$${detail:-}" ]; then echo -e "  ${RED}ERROR: detail required. Usage: make note msg='标题' detail='内容(≥30字)'${R}"; exit 1; fi; \
	if [ $${#detail} -lt 30 ]; then echo -e "  ${RED}ERROR: detail 内容不得少于30个字（当前$${#detail}字）${R}"; exit 1; fi; \
	NOTE_VER=$$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.teyvat/agent/version.json','utf8')).genshin||'unknown')}catch(e){console.log('unknown')}"); \
	NOTE_TS=$$(date '+%Y-%m-%d %H:%M:%S'); \
	NOTE_ID="note-$$(date '+%Y%m%d-%H%M%S')-$$(openssl rand -hex 2 2>/dev/null || printf '%04x' $$((RANDOM % 65536)))"; \
	echo "[$$NOTE_TS] $$NOTE_VER  [$$NOTE_ID]  $$msg" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo "  $$detail" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo "" >> "$(ROOT)/../Makelogs_Mannual.KEYLOGS"; \
	echo -e "  ${GRN}note $$NOTE_ID logged${R} → Makelogs_Mannual.KEYLOGS"

# ── release ──

prerelease-minutely:
	@$(LOCKED) _prerelease-minutely

_prerelease-minutely: _integrity
	@REL_VER=$$(node -e "console.log(require('$(CORE)/package.json').version)"); \
	TODAY=$$(date +%Y%m%d); \
	COUNTER_FILE="$(CORE)/.build-counter"; \
	if [ -f "$$COUNTER_FILE" ]; then \
		read LAST_DATE LAST_COUNT < "$$COUNTER_FILE"; \
		if [ "$$LAST_DATE" = "$$TODAY" ]; then \
			COUNT=$$LAST_COUNT; \
		else \
			echo "  ERROR: no build today, run dev-minutely first"; exit 1; \
		fi; \
	else \
		echo "  ERROR: no build counter, run dev-minutely first"; exit 1; \
	fi; \
	PAIMON_VER="$$REL_VER.$$TODAY.$$COUNT"; \
	echo -e "  teyvat $$PAIMON_VER (prerelease)"; \
	bash "$(DEPLOY)/build-release.sh" "$$PAIMON_VER" minutely

release:
	@$(LOCKED) _release

_release: _integrity
	@if [ -z "$(v)" ]; then echo "usage: make release v=0.x.x"; exit 1; fi
	@cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "release v$(v) $$(date '+%m-%d %H:%M')")
	@bash "$(DEPLOY)/build-release.sh" "$(v)" stable

# ── docs / wiki ──

SERVER := root@47.106.190.199

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
		read LAST_DATE LAST_COUNT < "$$COUNTER_FILE"; \
		if [ "$$LAST_DATE" = "$$TODAY" ]; then \
			COUNT=$$((LAST_COUNT + 1)); \
		else \
			COUNT=1; \
		fi; \
	else \
		COUNT=1; \
	fi; \
	echo "$$TODAY $$COUNT" > "$$COUNTER_FILE"; \
	PAIMON_VER="$$REL_VER.$$TODAY.$$COUNT"; \
	echo "teyvat $$PAIMON_VER"; \
	if [ -n "$$MSG_FILE" ] && [ -f "$$MSG_FILE" ]; then \
		cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER" -F "$$MSG_FILE"); \
	else \
		cd "$(DEV)" && git add -A && (git diff --cached --quiet || git commit -m "$$PAIMON_VER"); \
	fi; \
	cd "$(DEV)" && git push origin main
