# check-code-refs.cjs.SPEC

用途: 门禁 —— 代码里引用的**相对文件路径**必须真实存在（编译期查不出来：路径是运行时拼的）。

来历（2026-09-11 prime-agent，一天内抓到 3 个同类实例，全是"重构/搬家后路径没跟上"）:

| # | 位置 | 问题 | 后果 |
|---|---|---|---|
| ① | `local.mobile/apps/arxiv/arxiv.ts` | 依赖同目录 `arxiv-search.py`，文件不存在 | arxiv 搜索一直返回"搜索失败" |
| ② | `local.mobile/apps/safari/safari.ts` | `../../../universe.infotech/cloud.servers/browser_service.cjs` —— 往上三层已经是 `universe.infotech`，多算一层 → 解析到 `universe.infotech/universe.infotech/…` | 浏览器服务起不来（safari 的浏览功能坏） |
| ③ | `local.mobile/apps/ipod/ipod.ts` | `../../../spirit.bio.organs/…` —— 到 `A.core` 需要**四层**，少算一层 | 录音模块路径一直错 |

②③ 已按下表修正（修正后解析到真实文件，已用脚本核对）：
- safari → `../../../cloud.servers/browser_service.cjs` ✓
- ipod → `../../../../spirit.bio.organs/head.ears/ears-recorder.ts` ✓

判定:
1. 提取三类引用（**平衡括号扫描**，正则的 `[^)]*` 会被 `dirname(fileURLToPath(import.meta.url))` 这种嵌套括号骗过 —— 第一版就漏掉了 ②③）:
   - `join|resolve(... dirname(...)..., "相对字面量")`
   - `new URL("相对字面量", import.meta.url)`
   - `import("相对字面量")` / `require("相对字面量")`
2. 只看相对路径（`./` / `../` 开头）；解析后必须存在
3. 例外：**部署进 pi dist 的覆盖层**（`god.frontend.tui/ui_elements/*`、`overrides/*`）—— 它们运行时被拷进 pi 的目录树，
   相对路径在那棵树里有效 → 用"同名后缀在线上 runtime 里存在"放行；该行有 `// ref-ok:` 注释也放行
4. 一个引用都没扫到 → **FAIL**（fail-closed：规则失效不许静默通过）

实测：238 文件、14 个相对引用、0 缺失。负向验证：夹具里写 `resolve(dirname(__file__), "../../../nope/missing.ts")` → exit 1 并打印解析后的路径。
