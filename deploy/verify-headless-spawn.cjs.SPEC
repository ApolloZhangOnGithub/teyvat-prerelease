# verify-headless-spawn.cjs.SPEC

**用途**: 验证"转后台 spawn headless 子进程"方案机制的可行性（简化方向：转后台不依赖 launcher 重启链 + 多进程状态传递，改为当前进程直接 spawn headless 子进程）。用户点破"本身的状态判断不对"——现有 nonce/detached/LOOP_ITER/DAEMON 多进程状态传递断链即失败（headless 从未起来）。
**验证点**:
1. spawn detached 子进程（父进程退出后子进程存活）
2. fifo 作为子进程 stdin（读端）+ fd 3（O_RDWR 写端防 EOF，launcher exec 3<> 等价物）
3. 外部 echo > fifo 子进程能读到
4. 子进程 stdout/stderr → 文件
**规则**: 不写 /tmp（用户定稿：永远不要写 tmp 目录）——测试数据用 /tmp 只读路径观察，脚本本体在 C.deploy。
**用法**: node C.deploy/verify-headless-spawn.cjs，观察 out.log 有 [child] alive 持续 + 父退出后子进程存活。
