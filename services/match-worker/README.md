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

Match Worker 的根文件系统是只读的。下载的 runner 写入 `TMPDIR=/run/arena-match`，该目录由 Compose
单独挂载为 `exec` tmpfs；`/tmp` 仍保持 `noexec`。runner 需要从这个目录启动，否则 Linux 会在裁判进程
启动前报告 `runner is missing or not executable`。

本地 Compose 的 MinIO 使用 `minio_data` 持久化卷，`./run.sh down/restart` 不会清除对象。runner 在对象存储里缺失时，
Worker 读取 PostgreSQL 中的私有备份并把对象写回存储，比赛不受影响。两处都找不到时（只会发生在备份功能上线前的旧提交），
比赛记录为 `COMPILED_ARTIFACT_MISSING`，该 runner 被标记为不可用：榜上算法保留名次和战绩，只是不再被安排新比赛。

失败分两类。`TIMEOUT`、`RUNNER_ERROR`、`INVALID_MATCH_STREAM`、`INVALID_MATCH_RESULT`、`COMPILED_ARTIFACT_MISSING`
属于算法或比赛本身，直接记录为 `RUNTIME_FAILED`。其余（存储或数据库错误、Worker 进程问题）是平台故障：比赛放回
队列，已写入的部分回放被丢弃，最多尝试 `MATCH_MAX_ATTEMPTS`（默认 5）次，之后记录为 `PLATFORM_RETRIES_EXHAUSTED`。
