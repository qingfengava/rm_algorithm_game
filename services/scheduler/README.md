# Scheduler

Scheduler 只负责任务编排，不执行选手代码：

```text
提交 -> Compile Worker -> 已编译 runner -> Scheduler -> Match Worker -> 结果/回放
```

Compile Worker 和 Match Worker 使用独立 rootless 容器。Scheduler/API 容器不挂载选手提交目录，不应具备运行选手二进制的权限。

运行中的 Scheduler 会监听 `arena:submissions:uploaded`，并每 5 秒做一次补偿扫描。它把已经有
`COMPILED` artifact 的提交分成两类：`FINISHED` 且 `is_current = true` 是已正式进入排行榜的算法，
`QUEUED` 是资格赛通过、等待正式匹配的算法。待匹配版本在全部对局结束前不会替换提交者的当前榜上版本。

排行榜为空时，第一个 `QUEUED` 算法直接提升为 `FINISHED`，生成零战绩排行榜条目。排行榜不为空时，
每个待匹配算法只与当前已上榜算法对战，并为每个对手创建红蓝交换的两场 BO1；两场使用相同的对称
uint64 地图种子。只有与所有已上榜算法的比赛都进入 `FINISHED` 或 `RUNTIME_FAILED` 终态后，待匹配
算法才会提升为 `FINISHED`，随后在事务中刷新排行榜。

比赛记录使用 `(red_submission_id, blue_submission_id, map_seed)` 唯一索引，Redis 短期投递标记只负责
避免重复投递，因此 Scheduler 重启不会重复创建比赛，也能在 Worker 崩溃后重新投递尚未领取的比赛。
