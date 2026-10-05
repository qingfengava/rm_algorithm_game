# Match Worker

Match Worker 在独立容器中运行规则引擎和两个已编译选手 runner。它不与 API 容器共享文件系统，也不允许算法容器访问数据库、Redis 或公网。

启动入口为：

```bash
runner/run_match_worker.sh red_runner blue_runner
```

该入口使用 `arena-match-worker:local`，并启用 rootless、`network none`、只读根文件系统、seccomp、`pids-limit`、cgroup CPU/内存和外部超时。单场比赛退出、超时或崩溃只影响当前 Match Worker 容器，调度器可以将任务重新入队。

Compose 中的 `match-worker` 服务从 Redis 消费 `arena:matches:queue`，从对象存储下载两个 `COMPILED`
artifact，调用 `arena_match_demo --json --seed ...`，再以事务保存地图、初始状态、完整事件和胜负。
比赛启动前会把状态从 `QUEUED` 原子改为 `RUNNING`；重复消息会被忽略。选手崩溃、超时、缺少二进制或协议错误
会记录为 `RUNTIME_FAILED` 和失败原因。所有待处理比赛结束后，Worker 在同一事务中按比赛记录重算排行榜。
