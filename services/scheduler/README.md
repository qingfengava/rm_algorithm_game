# Scheduler

Scheduler 只负责任务编排，不执行选手代码：

```text
提交 -> Compile Worker -> 已编译 runner -> Match Worker -> 结果/回放
```

Compile Worker 和 Match Worker 使用独立 rootless 容器。Scheduler/API 容器不挂载选手提交目录，不应具备运行选手二进制的权限。
