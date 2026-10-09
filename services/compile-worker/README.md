# Compile Worker

Compile Worker 独立消费 `arena:submissions:uploaded` 通知，并每隔一段时间扫描
`UPLOADED` 且源码已确认的提交，确保 Redis 通知丢失时仍能恢复。

它执行固定的 C++23 编译、运行器自检和基础 bot 双向资格赛。两场资格赛都通过后，
将 runner 上传为 `COMPILED` artifact，并把提交状态原子迁移为 `QUEUED`；任何错误都会
写入 `COMPILE_FAILED`、`failure_reason` 和编译日志。Compile Worker 不直接修改比赛或排行榜。

确认后的源码和编译后的 runner 会同步保存到 PostgreSQL 的私有 artifact 备份列；对象存储返回 `NoSuchKey` 时
Worker 读取该备份继续处理，并把对象写回存储。源码在对象存储和数据库备份里都不存在时，该候选版本以
`ARTIFACT_LOST` 失败并停止轮询，提示重新提交。Compile Worker 只处理候选版本，不会修改榜上版本或排行榜。

编译和资格赛通过后提交进入 `QUEUED`。如果没有其他选手的榜上算法可以对战，Worker 立即调用
`promoteSubmissionIfNoOpponents` 让它晋级；否则交给 Scheduler 安排比赛。

编译 Worker 使用 `TMPDIR=/run/arena-compile` 保存源码解压目录和自测 runner。该目录是
独立的、容量受限的可执行 tmpfs；普通 `/tmp` 仍保持 `noexec`，避免把整个临时目录开放为
可执行文件系统。Compose 中的根文件系统仍为只读。
