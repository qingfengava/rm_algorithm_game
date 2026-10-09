# 阶段 6：调度、比赛 Worker 和排行榜

提交完成后由 Compile Worker 负责编译和资格赛，流程如下：

```text
UPLOADED
  -> Compile Worker
  -> COMPILING
  -> COMPILE_FAILED
  -> QUEUED（资格赛通过，等待正式匹配）
  -> Scheduler 创建与已上榜算法的双向 BO1
  -> Match Worker
  -> FINISHED（全部正式比赛终态后进入排行榜）
```

Scheduler 将 `FINISHED` 且 `is_current = true` 的提交视为已上榜算法，将 `QUEUED` 提交视为待匹配算法；待匹配版本
不会提前替换提交者的当前榜上版本。排行榜为空时，第一个待匹配算法
直接变为 `FINISHED` 并以零战绩入榜；否则待匹配算法只与每个已上榜算法创建两条比赛记录：

```text
A 红方, B 蓝方
B 红方, A 蓝方
```

地图种子由排序后的两个提交 UUID 的 SHA-256 前 8 字节计算，因此红蓝交换时种子相同。数据库唯一索引
`(red_submission_id, blue_submission_id, map_seed)` 和 Scheduler 事务 advisory lock 保证 Scheduler 重启或
重复补偿扫描不会创建重复比赛。Redis list 只承载待执行的比赛 ID，数据库是任务状态的唯一来源。

Match Worker 领取任务时使用 `QUEUED -> RUNNING` 原子更新。它下载两个编译 runner，调用结构化 JSON 裁判，
并在一个 PostgreSQL 事务中写入地图、初始状态、事件、胜者和 `FINISHED`。超时、崩溃、缺少 artifact 或非法
裁判输出会写入 `RUNTIME_FAILED` 和 `failure_reason`。

`RUNTIME_FAILED` 是比赛记录的终态；提交本身仍保持 `QUEUED`，直到它与其他选手所有已上榜算法的两场比赛均进入终态，
然后才以 `FINISHED` 提交进入排行榜，并在同一个事务中替换同一选手原来的榜上版本。

**版本替换。** 每个选手最多有一个榜上版本（`is_current`）和一个候选版本，由数据库唯一索引保证。重新提交只会取消尚未
上榜的旧候选版本；榜上版本一直保留到新候选版本晋级。晋级事务依次完成：旧榜上版本退役（软删除，比赛和回放保留，尚未开始的
比赛标记为 `SUBMISSION_REPLACED`）、候选版本成为 `FINISHED/is_current`、按当前算法之间的比赛重新计算排行榜。
候选版本不与同一选手的旧版本比赛；如果没有其他选手的可用榜上算法（空榜，或榜上只有它自己的旧版本），它在通过资格赛后立即晋级。

**数据持久化。** 确认后的源码和编译 runner 同时保存在对象存储和 PostgreSQL 的私有 artifact 备份列中。对象存储读取失败时，
Compile Worker 和 Match Worker 使用该备份并把对象写回存储；API 启动时也会把缺失的对象补回。因此重建对象存储不影响比赛。
源码和 runner 在两处都找不到时（只可能发生在备份功能上线前的旧提交），该 artifact 被标记为不可用：榜上算法保留名次和战绩，
只是不再被安排新比赛，所有者需要重新提交；尚未上榜的候选版本直接失败并提示重新提交。这一过程从不修改排行榜。

**平台故障与算法失败。** `TIMEOUT`、`RUNNER_ERROR`、`INVALID_MATCH_STREAM`、`INVALID_MATCH_RESULT`、
`COMPILED_ARTIFACT_MISSING` 是算法或比赛本身的失败，直接记录为 `RUNTIME_FAILED`。存储、数据库、Worker 进程等平台故障不代表
算法表现：比赛放回队列并丢弃已写入的部分回放，最多尝试 `MATCH_MAX_ATTEMPTS`（默认 5）次，之后记录为
`PLATFORM_RETRIES_EXHAUSTED`。`RUNTIME_FAILED` 比赛不计入胜率和得分率。

排行榜只统计当前算法之间的 `FINISHED` 比赛：

```text
胜率 = 胜场 / 总场数
得分率 = (胜场 + 0.5 * 平局) / 总场数
```

当当前算法预期的全部双向比赛都已结束时，Worker 在同一事务中重算
`leaderboard_entries` 并写入 `leaderboard_snapshots`。`RUNTIME_FAILED` 会保留失败原因且不计入胜负，
但作为终态计入完成检查。比赛完成前保留上一份完整排行榜，不展示半完成结果。

本地检查：

```bash
docker compose config --quiet
docker compose build compile-worker scheduler match-worker
docker compose up -d postgres redis minio api compile-worker scheduler match-worker
```

然后通过 API 上传两个源码包并调用 `/submissions/{id}/complete`。可观察：

```bash
docker compose logs -f compile-worker scheduler match-worker
docker compose exec redis redis-cli llen arena:matches:queue
```

比赛结束后，`GET /matches`、`GET /matches/{id}/replay` 和 `GET /leaderboard` 应分别返回比赛状态、完整事件
回放和事务发布的排行榜。
