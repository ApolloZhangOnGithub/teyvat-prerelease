# check-manifest-tools.cjs — SPEC

## 这个文件是干嘛的
make _integrity 阶段新增的机械闸门：扫描所有 registerPaimonTool 注册的工具名，
与 spirit.bio.gene/tools.manifest.json 的 tools 清单对比。

## 为什么要它（用户原话背景）
用户在测试 amem 工具时发现：memory.ts 里 amem 已注册（registerPaimonTool），
RNA 也有完整说明，但实际运行时工具列表里没有 amem —— 因为 tools.manifest.json
没声明 amem，kernel session_start 时按 manifest default:true 过滤 activeTools，
把"注册了但不在清单"的工具静默剔除。且现有 K020 硬检查只查"manifest 有但未注册"
的单向断线，不查"已注册但 manifest 没有"的反向断线。

用户指令（2026-08-15）："对于不在清单的工具，makefile时自动报错，去检查make并设计！"

## 检查规则
1. 遍历 A.core 下所有含 registerPaimonTool({ 的 .ts 文件，提取 name: "xxx" 字面量
2. 与 tools.manifest.json tools 键集合比对（大小写敏感，但报错时提示差异）
3. 注册了但不在 manifest.tools → ERROR，列出工具名 + 文件:行号，exit 1
4. 豁免：
   - roles 中声明的角色工具（read_conscious / aware 等，只给角色 session 用）
   - 动态 name（如 rc.name 变量拼接），静态扫描解析不了，跳过
5. 反向（manifest 有但代码没注册 write/edit 等 pi 原生工具）不查 ——
   原生工具由 pi 提供，不属于本闸门范围

## 接入点
Makefile _integrity 的 tool check 之后追加：
node "$(DEPLOY)/check-manifest-tools.cjs" "$(CORE)"
