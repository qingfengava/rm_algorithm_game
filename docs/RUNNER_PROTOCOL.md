# Runner 内部协议

规则引擎或 Match Worker 通过 runner 子进程的标准输入输出与选手程序通信。选手只依赖 `arena/api.hpp`，不接触本协议。

协议为 UTF-8、单行、空格分隔的文本。每条请求和响应以换行结束，runner 对动作响应立即 flush。

## 启动

Worker 发送：

```text
ARENA_RUNNER START side x y plane facing alive width height max_rounds actions_per_turn
```

字段枚举使用 SDK 中的底层整数值：`Side` 为 `Red=0, Blue=1`，`Plane` 为 `Lower=0, Upper=1`，方向顺序为 `North=0, East=1, South=2, West=3`。

runner 成功调用 `on_match_start()` 后返回：

```text
ARENA_RUNNER READY
```

## 行动请求

Worker 每次轮到选手行动时发送：

```text
ARENA_RUNNER ACT round action_index side x y plane facing alive previous_action_present [previous_effect] scan_present [scan_plane 9个ScanCell]
```

`previous_action_present` 和 `scan_present` 为 `0` 或 `1`。如果存在上一动作，`previous_effect` 使用 `ActionEffect` 的整数值。如果存在侦查结果，后面先给出平面，再按 `dy=-1..1`、每行 `dx=-1..1` 发送 9 个单元；每个单元字段为：

```text
dx dy x y in_bounds obstacle enemy_present
```

runner 调用选手的 `act()` 后返回：

```text
ARENA_RUNNER ACTION action_type direction
```

`action_type` 顺序为 `Move=0, Turn=1, Elevate=2, Fire=3, Scout=4`。

## 结束和错误

Worker 发送：

```text
ARENA_RUNNER SHUTDOWN
```

runner 返回：

```text
ARENA_RUNNER BYE
```

错误响应格式为：

```text
ARENA_RUNNER ERROR CODE
```

当前错误码包括：`START_PROTOCOL`、`ACT_PROTOCOL`、`CREATE_PLAYER_FAILED`、`BOT_EXCEPTION`、`INVALID_ACTION`。

超时由 runner 进程以退出码 `124` 终止；崩溃、资源限制和沙箱违规由 Worker 根据退出状态归类为选手失败。

## 进程限制

官方 runner 支持以下参数：

```text
--act-time-ms N       单次 act() 墙钟时间，默认 50ms
--match-time-ms N     单场进程墙钟时间，默认 10000ms
--memory-mb N         地址空间上限，默认 256MB
--cpu-seconds N       CPU 时间上限，默认 10 秒
```

runner 设置 CPU、地址空间、核心转储和文件描述符限制，并在 Linux 上设置 `PR_SET_NO_NEW_PRIVS`。网络、宿主机文件、子进程和线程隔离必须由外层容器或 seccomp 沙箱提供；runner 不把这些能力暴露给选手 API。
