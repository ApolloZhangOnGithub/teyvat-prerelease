# prerelease.sh — prerelease 版本线发布（ISSUE 138 重构）

## 职责

把当前 dev 代码发布为 alpha（prerelease 通道），生成 alpha 独立版本号并 pin 对应 dev 版本。

## 版本线模型

- dev: `0.3.2-dev.YYYYMMDD.N` — `make dev-minutely` 递增 N（.build-counter）
- prerelease: `0.3.2-alpha.YYYYMMDD.M` — `make prerelease-minutely` 递增 M（.alpha-counter，跨天重置 1）

## 行为

1. pin dev：`dev=` 参数指定，或默认绑 .build-counter 当天最新 dev
2. M 独立递增，生成 ALPHA_VER
3. 代码变化校验：本 alpha 与上一 alpha（.alpha-last-commit 记录 HEAD）同代码 → 拒绝递增（防空转）
4. 双号落盘：调 build-release.sh 时经环境变量 PINNED_DEV/ALPHA_VER + 参数传入，package.json/version.json/commit 均记录双号

## 调用

由 Makefile `_prerelease-minutely` 调用（非 make 直接跑会 dry-run 仅生成版本号）。

## 关联

ISSUE 138（版本机制重构）、Versioning(Dev).WIKI
