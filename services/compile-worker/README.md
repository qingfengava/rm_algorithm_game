# Compile Worker

Compile Worker 独立消费 `arena:submissions:uploaded` 通知，并每隔一段时间扫描
`UPLOADED` 且源码已确认的提交，确保 Redis 通知丢失时仍能恢复。

它执行固定的 C++23 编译、运行器自检和基础 bot 双向资格赛。两场资格赛都通过后，
将 runner 上传为 `COMPILED` artifact，并把提交状态原子迁移为 `QUEUED`；任何错误都会
写入 `COMPILE_FAILED`、`failure_reason` 和编译日志。Compile Worker 不直接修改比赛或排行榜。

编译 Worker 使用 `TMPDIR=/run/arena-compile` 保存源码解压目录和自测 runner。该目录是
独立的、容量受限的可执行 tmpfs；普通 `/tmp` 仍保持 `noexec`，避免把整个临时目录开放为
可执行文件系统。Compose 中的根文件系统仍为只读。
