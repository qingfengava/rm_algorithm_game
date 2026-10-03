# 比赛回放数据规范

回放使用 UTF-8 JSON 文件保存。一个比赛对应一个回放文件，包含初始地图、初始状态、行动事件和结束事件。

回放服务可以实时发送事件，也可以在比赛结束后一次性读取完整文件。回放数据不提供给选手进程，只提供给网站观战和历史查询。

## 1. 顶层结构

```json
{
  "match_id": "match-000001",
  "map_seed": 123456789,
  "map": {},
  "initial_state": {},
  "events": []
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `match_id` | string | 比赛唯一标识 |
| `map_seed` | uint64 | 地图生成种子，比赛结束后可展示 |
| `map` | object | 完整地图和障碍物 |
| `initial_state` | object | 比赛开始状态 |
| `events` | array | 按 `seq` 递增排列的事件 |

## 2. 地图结构

```json
{
  "width": 4,
  "height": 4,
  "planes": 2,
  "obstacles": [
    {"x": 1, "y": 2, "z": 0},
    {"x": 2, "y": 1, "z": 1},
    {"x": 0, "y": 3, "z": 0},
    {"x": 3, "y": 0, "z": 1}
  ]
}
```

`obstacles` 必须恰好包含 4 个不同的完整坐标格，并按照 `z`、`y`、`x` 的升序输出。

## 3. 无人机状态

```json
{
  "x": 0,
  "y": 0,
  "z": 0,
  "facing": "EAST",
  "alive": true
}
```

朝向只允许：

```text
NORTH
EAST
SOUTH
WEST
```

## 4. 初始状态

```json
{
  "round": 1,
  "action_index": 1,
  "active_side": "RED",
  "red": {
    "x": 0,
    "y": 0,
    "z": 0,
    "facing": "EAST",
    "alive": true
  },
  "blue": {
    "x": 3,
    "y": 3,
    "z": 0,
    "facing": "WEST",
    "alive": true
  }
}
```

## 5. 事件类型

事件类型包括：

```text
MATCH_STARTED
ACTION_RESOLVED
PLAYER_FAILED
MATCH_ENDED
```

### 5.1 行动事件

```json
{
  "seq": 1,
  "type": "ACTION_RESOLVED",
  "round": 1,
  "action_index": 1,
  "side": "RED",
  "action": {
    "type": "MOVE",
    "direction": "EAST"
  },
  "effect": "MOVED",
  "projectile_path": [],
  "scan": null,
  "state_after": {
    "round": 1,
    "action_index": 2,
    "active_side": "RED",
    "red": {
      "x": 1,
      "y": 0,
      "z": 0,
      "facing": "EAST",
      "alive": true
    },
    "blue": {
      "x": 3,
      "y": 3,
      "z": 0,
      "facing": "WEST",
      "alive": true
    }
  },
  "state_hash": "sha256:..."
}
```

`action.type` 允许：

```text
MOVE
TURN
ELEVATE
FIRE
SCOUT
```

`effect` 允许：

```text
MOVED
MOVE_BLOCKED
TURNED
ELEVATE_SUCCEEDED
ELEVATE_BLOCKED
FIRE_MISS
FIRE_BLOCKED
ENEMY_DESTROYED
SCANNED
INVALID
```

`projectile_path` 仅在开火时使用，记录弹丸实际检查过的完整坐标：

```json
[
  {"x": 2, "y": 0, "z": 0},
  {"x": 3, "y": 0, "z": 0}
]
```

如果开火遇到障碍物，路径包含弹丸检查到的障碍物格，后续格不再加入。

`scan` 仅在侦查行动中出现：

```json
{
  "plane": 0,
  "cells": [
    {
      "dx": -1,
      "dy": -1,
      "x": -1,
      "y": -1,
      "in_bounds": false,
      "obstacle": false,
      "enemy_present": false
    }
  ]
}
```

### 5.2 算法失败事件

```json
{
  "seq": 20,
  "type": "PLAYER_FAILED",
  "round": 4,
  "action_index": 2,
  "side": "BLUE",
  "reason": "TIMEOUT"
}
```

`reason` 允许：

```text
TIMEOUT
CRASH
SANDBOX_VIOLATION
```

### 5.3 比赛结束事件

```json
{
  "seq": 21,
  "type": "MATCH_ENDED",
  "winner": "RED",
  "result": "DESTROYED",
  "round": 4,
  "action_index": 2
}
```

`winner` 允许：

```text
RED
BLUE
DRAW
```

`result` 允许：

```text
DESTROYED
ROUND_LIMIT
TIMEOUT
CRASH
SANDBOX_VIOLATION
```

## 6. 回放不变量

- `seq` 从 0 或 1 开始，并且严格递增。
- 事件顺序必须与裁判引擎结算顺序一致。
- `state_after` 必须是该事件结算后的状态。
- 比赛结束事件之后不能再有行动事件。
- `ENEMY_DESTROYED` 事件之后必须紧跟 `MATCH_ENDED`。
- `ROUND_LIMIT` 只能出现在第 20 回合蓝方第 3 次行动之后。
- 回放重新执行后，所有 `state_hash` 必须一致。

## 7. 实时传输

实时回放通过 WebSocket 发送单个事件对象。客户端断线后，可以携带最后收到的 `seq`，由服务端补发后续事件。

历史回放可以直接返回完整 JSON，也可以按 `seq` 分页读取。网站观战数据与选手 API 完全隔离，选手进程不能访问回放服务。
