# Runner

Runner 负责加载选手的 C++23 `Player` 实现，并在受限进程中执行 `on_match_start()` 和 `act()`。

正式提交由 `runner/build_submission.sh` 构建：输入只允许包含 `bot.cpp` 的 `submission.zip`，输出一个官方 runner 可执行文件。选手不提供 `main()`，由 runner 提供进程入口。

构建完成后会自动运行固定资格赛。候选算法需要在同一张资格地图上交换红蓝方各击败一次内置基础 bot，才能进入正式比赛队列；资格赛结果不计入排行榜。

Worker 与 runner 的 stdin/stdout 协议见 [`docs/RUNNER_PROTOCOL.md`](../docs/RUNNER_PROTOCOL.md)。runner 只传递 SDK 定义的 `MatchStart` 和 `Observation`，不会传递地图种子、完整地图或对手程序信息。

runner 支持单次 `act()`、整场比赛、内存和 CPU 限制。网络、宿主机文件、子进程和线程禁止使用的强隔离由外层容器和 Linux seccomp 配置提供。

部署时可先构建镜像：

```bash
docker build -f infra/docker/runner.Dockerfile -t arena-runner:local .
```

再使用 `runner/run_sandboxed.sh` 启动提交程序。该启动器启用无网络、只读根文件系统、丢弃 Linux capabilities、禁止提权、单进程、256MB 内存和 1 个 CPU 配额。
