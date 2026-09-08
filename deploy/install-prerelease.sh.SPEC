# SPEC — install-prerelease.sh（C.deploy 区）

新电脑一键部署 genshin prerelease（发布线 alpha）——房东 9/9 05:22 要求最短 curl 安装。
用法：`curl -fsSL paimon.beer/install-prerelease | bash`
职责：clone paimon-code-prerelease → 跑 deploy/install.sh（PAIMON_CHANNEL=prerelease——runtime+扩展+launcher 自足）。
与 install-dev.sh（dev 源码线）并列——本脚本走发布线（git 分发 2026-09-05 定稿）。
