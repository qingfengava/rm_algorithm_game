# WUST 算法对抗赛选手手册

## 1. 比赛规则

双方各控制一架无人机，在包含上、下两个平面的 4 x 4 地图中比赛。无人机只有 1 点生命值，被敌方弹丸命中后立即淘汰。

比赛最多进行 20 个完整回合，每个完整回合固定执行：

~~~text
红方行动 1
红方行动 2
红方行动 3
蓝方行动 1
蓝方行动 2
蓝方行动 3
~~~

某次行动击毁敌机后比赛立即结束。第 20 回合蓝方第 3 次行动结束后双方仍存活时，比赛为平局。

正式排行榜中，同一对算法进行两场 BO1：

~~~text
第一场：算法 A 为红方，算法 B 为蓝方
第二场：算法 B 为红方，算法 A 为蓝方
~~~

## 2. 地图和初始位置

地图坐标为 (x, y, z)：

- x 范围为 0..3，从西向东增加。
- y 范围为 0..3，从北向南增加。
- z=0 表示下平面，z=1 表示上平面。

初始状态：

| 阵营 | 位置 | 平面 | 朝向 |
|---|---|---|---|
| 红方 | (0, 0) | 下平面 | 东 |
| 蓝方 | (3, 3) | 下平面 | 西 |

地图上有 4 个障碍物。障碍物位于具体平面和格子中，可能出现在上平面。

障碍物规则：

- 无人机不能进入障碍物格。
- 弹丸遇到障碍物后停止，不能穿透。
- 升降的目标格有障碍物时，升降失败。
- 侦查可以看到范围内的障碍物，不会被障碍物挡住。

双方不能在同一平面的同一格同时存在，但可以在相同的 (x,y) 上处于不同平面。

## 3. 五种操作

每次调用 act() 返回一个操作，并消耗当前方的一个行动点。

### 移动

向指定的绝对方向移动一格，移动不会改变朝向。

~~~cpp
arena::Action::move(arena::Direction::North);
arena::Action::move(arena::Direction::East);
arena::Action::move(arena::Direction::South);
arena::Action::move(arena::Direction::West);
~~~

移动到边界外、障碍物格或敌机所在格时移动失败，但仍消耗行动点。

### 转向

将无人机朝向设置为指定的绝对方向：

~~~cpp
arena::Action::turn(arena::Direction::North);
~~~

转向不是顺时针或逆时针旋转。即使目标方向与当前方向相同，也会消耗行动点。

### 升降

在上、下平面之间切换，位置 (x,y) 不变：

~~~cpp
arena::Action::elevate();
~~~

目标平面有障碍物或敌机时，升降失败，但仍消耗行动点。

### 开火

沿当前朝向发射弹丸，弹丸最多飞行 3 格，只在当前平面飞行：

~~~cpp
arena::Action::fire();
~~~

弹丸遇到障碍物会停止，遇到敌机则立即击毁敌机。开火不会自动转向。

### 侦查

查看以自己为中心、当前平面的 3 x 3 区域：

~~~cpp
arena::Action::scout();
~~~

侦查结果会在下一次调用 act() 时通过 previous_scan 返回。侦查不会查看另一平面。

## 4. 选手 API

选手程序只需要包含：

~~~cpp
#include <arena/api.hpp>
~~~

主要接口如下：

~~~cpp
namespace arena {

enum class Side : std::uint8_t { Red, Blue };
enum class Plane : std::uint8_t { Lower = 0, Upper = 1 };
enum class Direction : std::uint8_t { North, East, South, West };

enum class ActionType : std::uint8_t {
    Move, Turn, Elevate, Fire, Scout
};

struct Action {
    ActionType type;
    Direction direction;

    static constexpr Action move(Direction direction);
    static constexpr Action turn(Direction direction);
    static constexpr Action elevate();
    static constexpr Action fire();
    static constexpr Action scout();
};

struct DroneState {
    std::int8_t x;
    std::int8_t y;
    Plane plane;
    Direction facing;
    bool alive;
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
    None, Moved, MoveBlocked, Turned,
    ElevateSucceeded, ElevateBlocked,
    FireMiss, FireBlocked, EnemyDestroyed,
    Scanned, Invalid
};

struct ActionResult {
    ActionEffect effect;
};

struct ScanCell {
    std::int8_t dx;
    std::int8_t dy;
    std::int8_t x;
    std::int8_t y;
    bool in_bounds;
    bool obstacle;
    bool enemy_present;
};

struct ScanResult {
    Plane plane;
    std::array<ScanCell, 9> cells;
};

struct Observation {
    std::uint8_t round;
    std::uint8_t action_index;
    Side side;
    DroneState self;
    std::optional<ActionResult> previous_action;
    std::optional<ScanResult> previous_scan;
};

class Player {
public:
    virtual ~Player() = default;
    virtual void on_match_start(const MatchStart&) {}
    virtual Action act(const Observation& observation) = 0;
};

} // namespace arena

extern "C" arena::Player* create_player();
~~~

## 5. 回调和可见信息

比赛开始时调用一次 on_match_start(const arena::MatchStart&)，之后每次轮到该算法行动时调用一次 act(const arena::Observation&)。

Observation 中：

- round：当前完整回合，范围 1..20。
- action_index：当前方本回合第几次行动，范围 1..3。
- side：自己的阵营。
- self：自己的位置、平面、朝向和存活状态。
- previous_action：自己上一次行动的结果；第一次调用时为空。
- previous_scan：上一次行动为侦查时的结果，否则为空。

选手只能看到自己的状态和已经侦查到的信息，不会直接获得完整地图、地图种子或未侦查到的敌机位置。

ScanResult::cells 的顺序如下：

~~~text
0 1 2    dy = -1
3 4 5    dy =  0
6 7 8    dy =  1
         dx = -1, 0, 1
~~~

其中 cells[4] 通常是自己的格子。越界格的 in_bounds 为 false。

## 6. 实现样例

下面的程序展示了如何保存阵营、读取侦查结果并使用五种操作。

~~~cpp
#include <arena/api.hpp>

class ExamplePlayer final : public arena::Player {
public:
    void on_match_start(const arena::MatchStart& start) override {
        side_ = start.side;
    }

    arena::Action act(const arena::Observation& observation) override {
        if (observation.previous_scan.has_value()) {
            for (const auto& cell : observation.previous_scan->cells) {
                if (!cell.in_bounds || !cell.enemy_present) continue;

                arena::Direction target;
                bool aligned = false;
                if (cell.dx > 0 && cell.dy == 0) {
                    target = arena::Direction::East;
                    aligned = true;
                } else if (cell.dx < 0 && cell.dy == 0) {
                    target = arena::Direction::West;
                    aligned = true;
                } else if (cell.dy > 0 && cell.dx == 0) {
                    target = arena::Direction::South;
                    aligned = true;
                } else if (cell.dy < 0 && cell.dx == 0) {
                    target = arena::Direction::North;
                    aligned = true;
                }

                if (aligned) {
                    if (observation.self.facing != target) {
                        return arena::Action::turn(target);
                    }
                    return arena::Action::fire();
                }
            }
        }

        if (observation.action_index == 1) {
            return arena::Action::scout();
        }

        if (observation.action_index == 2 && observation.round % 2 == 0) {
            return arena::Action::elevate();
        }

        if (observation.action_index == 2) {
            return arena::Action::turn(
                side_ == arena::Side::Red
                    ? arena::Direction::East
                    : arena::Direction::West);
        }

        if (observation.round % 2 == 1) {
            return arena::Action::move(
                side_ == arena::Side::Red
                    ? arena::Direction::South
                    : arena::Direction::North);
        }
        return arena::Action::fire();
    }

private:
    arena::Side side_ = arena::Side::Red;
};

extern "C" arena::Player* create_player() {
    return new ExamplePlayer();
}
~~~

## 7. 提交与编译阶段的失败判定

提交压缩包后，平台会先检查文件格式，再使用 C++23 编译并进行基础运行检查。以下情况会导致本次提交失败，提交不会进入比赛：

| 阶段 | 失败情况 | 处理结果 |
|---|---|---|
| 上传检查 | 不是有效的 ZIP 文件 | 提交失败 |
| 上传检查 | 压缩包中缺少 `bot.cpp` | 提交失败 |
| 上传检查 | `bot.cpp` 无法读取或文件结构不符合要求 | 提交失败 |
| 编译检查 | 代码无法使用 C++23 编译 | 编译失败 |
| 编译检查 | 缺少 `#include <arena/api.hpp>` 或 API 使用错误 | 编译失败 |
| 编译检查 | 没有正确实现 `create_player()` | 编译失败 |
| 编译检查 | `create_player()` 返回空指针或程序启动失败 | 编译失败 |
| 编译检查 | 编译过程超时或生成文件超过平台限制 | 编译失败 |
| 资格检查 | 基础运行检查未通过 | 提交失败 |

编译失败不会进入正式比赛，也不会计入排行榜。平台会保留失败原因，选手应根据错误信息修改 `bot.cpp` 后重新提交。

能够编译通过只代表程序格式和接口正确，提交仍需要完成平台规定的资格检查，才能进入正式匹配。

资格检查包含红、蓝双方各一场基础对抗。两场都获胜才算通过；任一场失败、平局、程序超时、程序崩溃或操作协议错误，均判定本次提交失败，不能进入正式比赛。

### 7.1 资源限制

平台对提交包、编译过程和比赛运行过程设置以下限制：

| 项目 | 限制 |
|---|---:|
| ZIP 大小 | 5 MB |
| 编译后运行文件 | 32 MiB |
| 编译时间 | 30 秒 |
| 单次 `act()` | 50 ms |
| 单场比赛总运行时间 | 10 秒 |
| 内存 | 256 MB |
| CPU | 1 个逻辑核心 |
| 选手进程数 | 1 个 |

编译阶段超过限制会导致编译失败，不会进入比赛。正式比赛运行阶段超过限制，会按照当前比赛判负。

### 7.2 运行失败处理

| 情况 | 处理结果 |
|---|---|
| ZIP 格式错误 | 拒绝提交 |
| 缺少 `bot.cpp` | 拒绝提交 |
| 编译错误 | 标记为编译失败，不进入比赛 |
| 使用不允许的依赖 | 拒绝提交 |
| `act()` 超时 | 当前比赛判负 |
| 选手进程崩溃或被终止 | 当前比赛判负 |
| 违反运行环境限制 | 当前比赛判负 |
| 资格赛运行失败 | 本次提交失败，不进入正式匹配 |
| 裁判或比赛基础设施故障 | 比赛作废并重新调度，不计双方战绩 |

非法但可以解析的操作会返回 `Invalid`，不改变比赛状态但消耗一个行动点，不会直接判负。移动受阻、升降受阻和开火被障碍物阻挡也属于正常的行动结果。

## 8. 编写算法时的注意事项

- Turn 使用绝对方向，不是相对旋转。
- Scout 只返回当前平面的 3 x 3 信息。
- previous_scan 只表示上一次侦查结果，程序应自行保存已知信息。
- 移动、升降和开火都可能失败，程序应读取 previous_action 后调整策略。
- 每次 act() 都必须返回一个 arena::Action。
- 程序入口必须是 create_player()，不需要实现 main()。
