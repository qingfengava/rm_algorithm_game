# Compile Worker

Compile Worker 独立消费 `arena:submissions:uploaded` 通知，并每隔一段时间扫描
`UPLOADED` 且源码已确认的提交，确保 Redis 通知丢失时仍能恢复。

它执行固定的 C++23 编译、运行器自检和基础 bot 双向资格赛。两场资格赛都通过后，
将 runner 上传为 `COMPILED` artifact，并把提交状态原子迁移为 `QUEUED`；任何错误都会
写入 `COMPILE_FAILED`、`failure_reason` 和编译日志。Compile Worker 不直接修改比赛或排行榜。
