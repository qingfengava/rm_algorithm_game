# C++23 选手操作 API

选手提交语言仅允许 C++，统一使用 C++23。提交程序只依赖官方提供的 `arena/api.hpp`。选手不实现 `main()`，也不能访问规则引擎、地图种子或其他选手进程。

## 1. 头文件定义

```cpp
#pragma once

#include <array>
#include <cstdint>
#include <optional>

namespace arena {

enum class Side : std::uint8_t {
    Red,
    Blue,
};

enum class Plane : std::uint8_t {
    Lower = 0,
    Upper = 1,
};

enum class Direction : std::uint8_t {
    North,
    East,
    South,
    West,
};

enum class ActionType : std::uint8_t {
    Move,
    Turn,
    Elevate,
    Fire,
    Scout,
};

struct Action {
    ActionType type;
    Direction direction;

    static constexpr Action move(Direction value) {
        return {ActionType::Move, value};
    }

    static constexpr Action turn(Direction value) {
        return {ActionType::Turn, value};
    }

    static constexpr Action elevate() {
        return {ActionType::Elevate, Direction::North};
    }

    static constexpr Action fire() {
        return {ActionType::Fire, Direction::North};
    }

    static constexpr Action scout() {
        return {ActionType::Scout, Direction::North};
    }

    friend bool operator==(const Action&, const Action&) = default;
};

struct DroneState {
    std::int8_t x;
    std::int8_t y;
    Plane plane;
    Direction facing;
    bool alive;

    friend bool operator==(const DroneState&, const DroneState&) = default;
};

struct MatchStart {
    Side side;
    DroneState self;
    std::uint8_t map_width;
    std::uint8_t map_height;
    std::uint8_t max_rounds;
    std::uint8_t actions_per_turn;
};

enum class ActionEffect : std::uint8_t {
    None,
    Moved,
    MoveBlocked,
    Turned,
    ElevateSucceeded,
    ElevateBlocked,
    FireMiss,
    FireBlocked,
    EnemyDestroyed,
    Scanned,
    Invalid,
};

struct ActionResult {
    ActionEffect effect;

    friend bool operator==(const ActionResult&, const ActionResult&) = default;
};

struct ScanCell {
    std::int8_t dx;
    std::int8_t dy;
    std::int8_t x;
    std::int8_t y;
    bool in_bounds;
    bool obstacle;
    bool enemy_present;

    friend bool operator==(const ScanCell&, const ScanCell&) = default;
};

struct ScanResult {
    Plane plane;
    std::array<ScanCell, 9> cells;

    friend bool operator==(const ScanResult&, const ScanResult&) = default;
};

struct Observation {
    std::uint8_t round;
    std::uint8_t action_index;
    Side side;
    DroneState self;
    std::optional<ActionResult> previous_action;
    std::optional<ScanResult> previous_scan;

    friend bool operator==(const Observation&, const Observation&) = default;
};

class Player {
public:
    virtual ~Player() = default;

    virtual void on_match_start(const MatchStart&) {}

    virtual Action act(const Observation& observation) = 0;
};

} // namespace arena

extern "C" arena::Player* create_player();
```

编译器使用 C++23：

```bash
g++ -std=c++23 -O2 -pipe
```

## 2. 操作语义

`Move` 和 `Turn` 使用 `direction` 字段。`Elevate`、`Fire`、`Scout` 忽略 `direction` 字段，推荐使用 API 提供的静态构造函数。

`Turn` 使用绝对方向，不表示顺时针或逆时针旋转。

如果操作类型无法解析，裁判返回 `ActionEffect::Invalid`，不改变状态但消耗行动。`MoveBlocked`、`ElevateBlocked`、`FireBlocked` 都属于合法操作的失败结果。

## 3. 回调顺序

比赛开始时调用一次：

```cpp
on_match_start(const MatchStart& start);
```

每次轮到该算法行动时调用一次：

```cpp
Action act(const Observation& observation);
```

红方在一个回合内连续收到 3 次 `act()` 调用，之后蓝方收到 3 次调用。比赛结束后不再回调。

`round` 范围为 `1..20`，`action_index` 范围为 `1..3`。

第一次调用 `act()` 时，`previous_action` 和 `previous_scan` 为空。只有上一次行动为 `Scout` 时，`previous_scan` 才有值。选手应自行保存历史侦查结果。

`ScanResult::cells` 的固定顺序是：先按 `dy=-1,0,1` 排列，再按每个 `dy` 内的 `dx=-1,0,1` 排列。数组下标可以使用 `index = (dy + 1) * 3 + (dx + 1)` 计算。

## 4. 可见信息

API 只提供：

- 自身位置、平面、朝向和存活状态。
- 当前回合和当前行动序号。
- 自己上一次行动的结果。
- 上一次侦查得到的 3x3 信息。

API 不提供：

- 完整地图。
- 地图种子。
- 敌方当前行动。
- 未侦查到的敌方位置。
- 另一平面的障碍物和敌机位置。

## 5. 示例选手

```cpp
#include <arena/api.hpp>

class ExamplePlayer final : public arena::Player {
public:
    arena::Action act(const arena::Observation& observation) override {
        if (observation.action_index == 1) {
            return arena::Action::scout();
        }
        return arena::Action::fire();
    }
};

extern "C" arena::Player* create_player() {
    return new ExamplePlayer();
}
```

选手不得在 `create_player()` 或 `act()` 中启动线程、创建进程、访问网络或读取比赛平台文件。
