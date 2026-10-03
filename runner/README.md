# Runner

Runner 负责加载选手的 C++23 `Player` 实现，并在受限进程中执行 `on_match_start()` 和 `act()`。

阶段 1 仅建立目录。Runner 的 IPC、超时监控和沙箱接入在后续阶段实现。
