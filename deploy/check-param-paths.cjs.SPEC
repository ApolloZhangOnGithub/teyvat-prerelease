# check-param-paths.cjs.SPEC

用途: 门禁 —— 锁住"**agent 参数直接拼路径**"这类越界（路径穿越）的收口。

## 来历

2026-09-11 两处同类：
1. **appstore**（已修 + `check-mobile-apps.cjs` 覆盖）：app 名（来自**下载的代码**与 agent 输入）直接 join 成目录 →
   `name: "../../evil"` 写到 apps 之外；`卸载 ../../AccountData` 把任意目录改名藏起来。
2. **brain.memory / amem**（本门禁）：`revert` 用 `join(manageDir, id + ".json")` 读、末尾**还 writeFile 回写同一路径**：

```ts
let d: any = null; try { d = JSON.parse(readFile(path.join(manageDir, `${params.id}.json`))); } catch ...
...
writeFile(path.join(manageDir, `${params.id}.json`), JSON.stringify(d, null, 2));
```

`id: "../../../config/authorize"` → 解析成 `~/.teyvat/config/authorize.json`（自证：8 个被拒输入里 **4 个**在老表达式下会落到 manageDir 之外，
含 `~/.teyvat/config/authorize.json`、`~/.teyvat/config/plist.json`、`ActiveManageMemoryIndex.json`）。
影响：读/写 manageDir 之外的**任意 .json**（写 = 给该文件加 `reverted/reverted_at` 两个键 → 状态污染，不是任意内容注入）。
注：`amem fetch` 那条路径**有** `entries.find(x => x.id === params.id)` 命中校验，`revert` 没有 —— 同一文件内两处口径不一致。

## 收口（`_amemManageFile`）

```ts
const _amemManageFile = (id: string): string | null => {
  const clean = String(id).trim().replace(/\.json$/, "");   // 容忍 agent 从索引抄来的 "am-….json"
  if (!/^am-\d+$/.test(clean)) return null;                  // 内部生成格式：am-<epochMs>
  const base = path.resolve(manageDir) + path.sep;
  const f = path.resolve(manageDir, `${clean}.json`);
  return f.startsWith(base) ? f : null;
};
```

`revert` 的读 + 回写都用它（拿不到就报 `invalid id`）；`fetch` 也改成经它读（防御性）。

## 本门禁做什么

- 静态 7 项：收口函数与形状正则在位、`startsWith(base)` 包含断言在位、**裸拼用法已归零**、revert 读/写与 fetch 读都走收口
- 动态 11 例（抽真实函数跑）：允许 `am-1757000000000` / `am-….json` / `am-1`；拒绝 `../../../config/authorize`、
  `../../x`、`am-123/../../evil`、`../ActiveManage/am-123`、`am-abc`、空串、`/tmp/evil`、`....//am-1`
- **自证行**：打印"被拒输入中有多少在老表达式下会真的越界"（避免门禁只测无意义输入）
- 负向：夹具把形状校验改成 `true` → 静态 + 动态双 FAIL → exit 1

## 备注（为什么不做全仓污点分析）

全仓"参数 → 路径"的精确判定需要污点分析（appstore 的名字还经过正则抠取，两跳）。
本门禁就把**已确认的两处**收口锁死；用启发式扫描（`join(X, params.Y)` / `join(X, `…${params.Y}…`)`）列出**新候选点**供人工看：
当前全仓只剩 0 处未收口的参数直拼。
