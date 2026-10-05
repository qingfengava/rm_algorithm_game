# Match Worker

Match Worker 在独立容器中运行规则引擎和两个已编译选手 runner。它不与 API 容器共享文件系统，也不允许算法容器访问数据库、Redis 或公网。

启动入口为：

```bash
runner/run_match_worker.sh red_runner blue_runner
```

该入口使用 `arena-match-worker:local`，并启用 rootless、`network none`、只读根文件系统、seccomp、`pids-limit`、cgroup CPU/内存和外部超时。单场比赛退出、超时或崩溃只影响当前 Match Worker 容器，调度器可以将任务重新入队。
