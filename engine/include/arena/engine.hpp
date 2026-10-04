#pragma once

#include "arena/api.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace arena::engine {

inline constexpr std::int8_t kMapWidth = 4;
inline constexpr std::int8_t kMapHeight = 4;
inline constexpr std::int8_t kPlaneCount = 2;
inline constexpr std::int8_t kObstacleCount = 4;
inline constexpr std::int8_t kMaxRounds = 20;
inline constexpr std::int8_t kActionsPerTurn = 3;
inline constexpr std::int8_t kProjectileRange = 3;

struct Cell {
    std::int8_t x;
    std::int8_t y;
    Plane plane;

    friend bool operator==(const Cell &, const Cell &) = default;
};

class Map {
  public:
    static Map generate(std::uint64_t seed);
    static std::optional<Map> from_obstacles(const std::array<Cell, kObstacleCount> &obstacles);

    [[nodiscard]] bool in_bounds(std::int8_t x, std::int8_t y) const;
    [[nodiscard]] bool has_obstacle(Cell cell) const;
    [[nodiscard]] const std::array<Cell, kObstacleCount> &obstacles() const;

    friend bool operator==(const Map &, const Map &) = default;

  private:
    explicit Map(std::array<Cell, kObstacleCount> obstacles);

    std::array<Cell, kObstacleCount> obstacles_;
};

struct DroneState {
    std::int8_t x;
    std::int8_t y;
    Plane plane;
    Direction facing;
    bool alive;

    friend bool operator==(const DroneState &, const DroneState &) = default;
};

enum class Winner : std::uint8_t {
    None,
    Red,
    Blue,
    Draw,
};

enum class EndReason : std::uint8_t {
    None,
    Destroyed,
    RoundLimit,
};

struct GameState {
    std::uint8_t round = 1;
    std::uint8_t action_index = 1;
    Side active_side = Side::Red;
    DroneState red{0, 0, Plane::Lower, Direction::East, true};
    DroneState blue{3, 3, Plane::Lower, Direction::West, true};
    bool finished = false;
    Winner winner = Winner::None;
    EndReason end_reason = EndReason::None;

    friend bool operator==(const GameState &, const GameState &) = default;
};

enum class EventType : std::uint8_t {
    MatchStarted,
    ActionResolved,
    MatchEnded,
};

struct ReplayEvent {
    std::uint64_t sequence = 0;
    EventType type = EventType::MatchStarted;
    std::uint8_t round = 1;
    std::uint8_t action_index = 1;
    Side side = Side::Red;
    Action action = Action::scout();
    ActionEffect effect = ActionEffect::None;
    std::vector<Cell> projectile_path;
    std::optional<ScanResult> scan;
    GameState state_after{};
    std::string state_hash;
    Winner winner = Winner::None;
    EndReason end_reason = EndReason::None;

    friend bool operator==(const ReplayEvent &, const ReplayEvent &) = default;
};

struct ReplayLog {
    std::uint64_t map_seed = 0;
    Map map = Map::generate(0);
    std::vector<ReplayEvent> events;

    friend bool operator==(const ReplayLog &, const ReplayLog &) = default;
};

struct ActionOutcome {
    ActionEffect effect = ActionEffect::None;
    bool consumed = false;
    bool match_finished = false;
    std::vector<Cell> projectile_path;
    std::optional<ScanResult> scan;
    GameState state_after{};
    std::string state_hash;
    std::uint64_t event_sequence = 0;
};

struct ReplayResult {
    bool ok = false;
    std::size_t failed_event = 0;
    std::string error;
    GameState final_state{};
    std::vector<GameState> reconstructed_states;
};

class Match {
  public:
    explicit Match(std::uint64_t map_seed);
    explicit Match(Map map);

    static Match from_state_for_testing(Map map, GameState state);

    [[nodiscard]] const Map &map() const;
    [[nodiscard]] const GameState &state() const;
    [[nodiscard]] const std::vector<ReplayEvent> &events() const;
    [[nodiscard]] std::uint64_t map_seed() const;
    [[nodiscard]] std::string state_hash() const;
    [[nodiscard]] ReplayLog replay_log() const;

    ActionOutcome apply(Action action);

    static ReplayResult replay(const ReplayLog &log);

  private:
    Match(std::uint64_t map_seed, Map map, GameState state, bool record_start_event);

    void append_start_event();
    void append_end_event();
    void advance_turn();
    [[nodiscard]] DroneState &active_drone();
    [[nodiscard]] const DroneState &active_drone() const;
    [[nodiscard]] DroneState &opponent_drone();
    [[nodiscard]] const DroneState &opponent_drone() const;
    [[nodiscard]] ActionOutcome make_outcome(ActionEffect effect, bool consumed) const;
    [[nodiscard]] std::string calculate_state_hash() const;
    [[nodiscard]] ReplayEvent make_action_event(const Action &action, ActionEffect effect,
                                                const std::vector<Cell> &projectile_path,
                                                const std::optional<ScanResult> &scan,
                                                std::uint64_t sequence, std::uint8_t round,
                                                std::uint8_t action_index, Side side) const;

    std::uint64_t map_seed_ = 0;
    Map map_ = Map::generate(0);
    GameState state_{};
    std::vector<ReplayEvent> events_;
};

[[nodiscard]] bool valid_direction(Direction direction);
[[nodiscard]] std::string to_string(ActionEffect effect);
[[nodiscard]] std::string to_string(Winner winner);
[[nodiscard]] std::string to_string(EndReason reason);

} // namespace arena::engine
