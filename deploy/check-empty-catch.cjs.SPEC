# check-empty-catch.cjs.SPEC

**用途**: 构建门禁——任何文件出现空 `catch {}`（静默吞错反模式）→ make 失败（无法构建部署）。
**为什么需要**: 2026-08-20 用户定稿：「设计一种方法，项目中任何地方调用空的 catch 都会无法运行通过，任何文件」。
空 catch 静默吞错是系统性问题（曾扫出 526 处，LESSON 024 反模式），
只修单点没用，必须构建期强制——空 catch 存在 = 构建不过 = 代码无法进运行时。
**配套**: fix-empty-catch.cjs（存量批量修复加日志）；本脚本接入 Makefile _integrity。
**用户原话**: 「任何地方调用空的catch，都会无法运行通过，任何文件」「操你妈逼的运行时，还在运行时」——明确要构建期强制，不是运行时检查。
**用法**: `node check-empty-catch.cjs`（exit 0=通过，exit 1=发现空 catch，make 失败）
