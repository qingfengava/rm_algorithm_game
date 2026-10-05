# Scheduler

Scheduler 只负责任务编排，不执行选手代码：

```text
提交 -> Compile Worker -> 已编译 runner -> Scheduler -> Match Worker -> 结果/回放
```

Compile Worker 和 Match Worker 使用独立 rootless 容器。Scheduler/API 容器不挂载选手提交目录，不应具备运行选手二进制的权限。

运行中的 Scheduler 会监听 `arena:submissions:uploaded`，并每 5 秒做一次补偿扫描。它只处理已经有
`COMPILED` artifact、状态为 `QUEUED`/`RUNNING`/`FINISHED` 且 `is_current = true` 的提交。每一对当前算法
使用由两个提交 ID 计算的对称 uint64 地图种子，创建红蓝交换的两场比赛，并写入 Redis list
`arena:matches:queue`。数据库唯一索引和 Redis 短期投递标记保证 Scheduler 重启不会重复创建或无限投递同一场比赛。
