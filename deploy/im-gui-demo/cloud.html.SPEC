# cloud.html.SPEC

**用途**: IM 云版前端（部署到 paimon.beer/im/）——浏览器直连 sync.paimon.beer API，GitHub device flow 登录，跨设备联系人 + 聊天。
**为什么需要**: 用户需求（2026-09-13）——「把这个部署上 paimon.beer 公网，可以用 github login 认证登陆，进去了就是对应的帐号」。
**设计依据**: server 源码 `A.core/god.backend.services/`（auth.ts 已有 device-flow 端点；sync.ts 的 /sync/agent-presence；messaging 的 /messages/send 与 /messages/pending/:personId）；CORS 全开可直接浏览器调用。
**与本地版区别**: index.html 读本机 SocialData（需 server.mjs 本地后端）；cloud.html 纯静态，无本地数据，全部走 server API。
**认证**: `POST /auth/device-flow/start` → 显示 user_code → 用户去 github.com/login/device 授权 → `POST /auth/device-flow/poll` 拿 token（token 存 localStorage）。
**数据**: 联系人 = `GET /sync/agent-presence`；发消息 = `POST /messages/send {toPerson,type:agent-social,payload}`；收消息 = `GET /messages/pending/<mySid>` 轮询。
**用法**: 由 nginx 在 `paimon.beer/im/` 提供静态文件（无需后端进程）。
**依赖**: 服务器需配置 `GITHUB_CLIENT_ID`（device flow 必需，GitHub OAuth App 勾选 Enable Device Flow）。
