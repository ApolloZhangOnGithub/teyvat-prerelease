# check-theme-consistency.cjs — dark/light 配色一致性门禁

> 创建: 2026-08-18（用户要求：make 要检查 dark/light 数值一一对应，不能缺失）
> SPEC: C.deploy/check-theme-consistency.cjs.SPEC

## 目的
dark.json 与 light.json 的 vars 键集合必须一一对应，缺失会导致 light 模式渲染丢色/回退（用户实测：light 曾缺 bluePurple/gray/darkGray/accent 四键）。

## 检查项
- T001: vars 键一一对应（双向，豁免 `*Original` 历史原色记录字段）
- T002: vars 值非空
- T003: colors 引用的 vars 键存在（#hex 字面量除外）

## 接入
Makefile `_integrity` 目标调用：`node check-theme-consistency.cjs $(CORE)`，FAIL → exit 1 阻止部署。

## 变更记录
- 2026-08-18: 创建（用户：以后 make 必须查 dark/light 对应）
