# check-func-load.cjs — SPEC

## 这个文件是干嘛的
make _integrity 阶段的 func 加载冒烟闸门（ISSUE 112）：对 rna.json 每个非 future
且带 path 的 func，加载其入口文件并调用 default(校验 fakePi)，任何抛错 → exit 1。

## 为什么要它（用户原话背景）
用户多次强调（2026-08-18 第三次）："这种都要报错，不能 warn，而且要 make 时就阻止"。

2026-08-18 实测教训：core.ts func 加载循环曾 catch 吞掉 entry(pi) 抛错只发 system-error
WARN → social 静默未注入 → K020 启动硬检查（运行时）才 throw → 且 K020 throw 在
process.title 设置之前 → personId() 失效 → root 授权连锁失灵。func 加载失败必须在
构建期（make）阻止，不能等运行时。

## 检查规则
1. 读 A.core/spirit.bio.gene/rna.json 的 funcs（future:false 且带 path 的）
2. 入口文件推断：path 目录 + func 名末段 .ts（kernel.heart→heart.ts，
   social.communicate→communicate.ts）；目录无同名文件时递归找（优先 kernel/index）
3. import 入口文件 → 调用 default(校验 fakePi)
4. fakePi 校验（镜像真实 pi 关键检查）：registerTool 校验
   name/label/messageDescription/parameters/renderCall/renderResult + 重复名；
   registerMessageRenderer 校验类型名非空、handler 是函数、不重复
5. 任一 func 抛错 → 打印错误 + exit 1

## 接入点
Makefile _integrity 的 resolve check 之后追加：
node "$(DEPLOY)/check-func-load.cjs" "$(CORE)"

## 命名规范
- 文件：check-<用途>.cjs（与 check-resolve/check-manifest-tools 一致）
- 本 SPEC 与本文件同名同目录（NORM-001 扩展文件规范）
