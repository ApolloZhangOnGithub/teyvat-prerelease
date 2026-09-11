# check-mobile-apps.cjs.SPEC

用途: 门禁 —— 手机 app 的两条不变量。

## ① appstore 的 app 名必须"先校验再拼路径"

来历（2026-09-11 prime-agent 实测）：`appstore.ts` 的 `validateAppSource()` 只做**字符串包含检查** + 用正则从
**下载来的代码**里抠 `name:`，**完全不校验字符**；随后：
- 导入：`writeFileSync(path.join(PROGRAM_FILES_MOBILE, appName, `${appName}.ts`), code)` —— `name: "../../evil"` 会写到 apps 目录之外（还会 mkdir）
- 卸载：`renameSync(appDir, path.join(..., `@removed.${name}`))` —— `卸载 ../../AccountData` 能把**任意已存在目录**改名藏起来

实测（真实 app 的公开入口 `onAction`）：
```
[导入 /tmp/evil-app.ts（name: ../../evil）] → 验证失败: app name 非法（只允许字母数字 _ -，最长 40）: ../../evil   ✅ 修后
[卸载 ../../AccountData]                     → app name 非法: ../../AccountData                                     ✅ 修后
```
修法：`APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/` + `appDirFor(name)`（解析后必须仍落在 apps 目录内），
导入/卸载/`validateAppSource` 统一走它。判据单测：`../../evil`/`..`/`a/b`/空/41 字符/`.hidden`/`-dash-first` → 全拒；`amap`/`app_store-1` → 放行。

本门禁的静态断言（被回退即 FAIL）：
- `APP_NAME_RE` 存在；`appDirFor()` 存在（含目录包含断言）
- `validateAppSource` 里校验 name
- 导入、卸载两条路径都走 `appDirFor`
- 写/改名的裸拼法计数 = 0（**只读用法不计**：`statSync`/`existsSync`/`readdirSync`/`readFileSync` 上下文、
  或同函数内已出现 `appDirFor(name)` 的调用 —— 第一版规则太糙，把卸载 rename 目标误判成漏网）

## ② apps.json 与 app 字段一致

`apps.json` 列出的每个 app 文件必须存在，且导出 `MobileApp` 的 5 个必需字段
（`name` / `icon` / `messageDescription` / `onOpen` / `onAction`）—— 缺 `onAction` 之类会让 kernel 派发时炸。
`apps.json` 为空 → FAIL（fail-closed）。

用法: `node C.deploy/check-mobile-apps.cjs [A.core 路径]`（已接进 Makefile `_integrity`）

实测：5 项静态检查全 OK、写/改名裸拼 0、18 个 app 字段齐全。
负向验证：夹具里把 `validateAppSource` 的名字校验改成 `if (false)` → exit 1。
