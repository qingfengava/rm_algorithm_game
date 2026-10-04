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

    friend bool operator==(const Action &, const Action &) = default;
};

struct DroneState {
    std::int8_t x;
    std::int8_t y;
    Plane plane;
    Direction facing;
    bool alive;

    friend bool operator==(const DroneState &, const DroneState &) = default;
};

struct MatchStart {
    Side side;
    DroneState self;
    std::uint8_t map_width;
    std::uint8_t map_height;
    std::uint8_t max_rounds;
    std::uint8_t actions_per_turn;

    friend bool operator==(const MatchStart &, const MatchStart &) = default;
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

    friend bool operator==(const ActionResult &, const ActionResult &) = default;
};

struct ScanCell {
    std::int8_t dx;
    std::int8_t dy;
    std::int8_t x;
    std::int8_t y;
    bool in_bounds;
    bool obstacle;
    bool enemy_present;

    friend bool operator==(const ScanCell &, const ScanCell &) = default;
};

struct ScanResult {
    Plane plane;
    std::array<ScanCell, 9> cells;

    friend bool operator==(const ScanResult &, const ScanResult &) = default;
};

struct Observation {
    std::uint8_t round;
    std::uint8_t action_index;
    Side side;
    DroneState self;
    std::optional<ActionResult> previous_action;
    std::optional<ScanResult> previous_scan;

    friend bool operator==(const Observation &, const Observation &) = default;
};

class Player {
  public:
    virtual ~Player() = default;

    virtual void on_match_start(const MatchStart &) {}

    virtual Action act(const Observation &observation) = 0;
};

} // namespace arena

extern "C" arena::Player *create_player();
