# SPEC: check-esm-require.cjs
# 作者: genshin-v0.3.2-dev-01 @ 2026-09-14
# 用途: ESM 文件裸 require 检查（从 Makefile 内联段抽出成独立脚本——原内联版的多行续行+行尾注释
#       在 make/bash 两层转义下极度脆弱，2026-09-13 深夜连续三次 Error 127/零匹配的根源）。
# 规则: 扫 god.frontend.tui/{overrides,ui_elements,commands} 的 .js/.ts：
#       含 require( 且无 createRequire → 非注释 require 行 >0 判 FAIL(exit 1)。
# 例外: overrides/pi-dist/** 是 pi 原文件镜像（require 是 pi 自身形态），跳过不检查。
# 参数: $1 = A.core 路径
# 关联: LESSON 065（ESM 禁 require）、ISSUE 238（node_modules prune 事件中此检查的脆弱性暴露）
