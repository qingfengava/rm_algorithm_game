#include "arena/engine.hpp"

#include <algorithm>
#include <array>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace arena::engine {
namespace {

constexpr std::uint64_t kFnvOffset = 14695981039346656037ULL;
constexpr std::uint64_t kFnvPrime = 1099511628211ULL;

struct Fnv1a {
    std::uint64_t value = kFnvOffset;

    void add_byte(std::uint8_t byte) {
        value ^= byte;
        value *= kFnvPrime;
    }

    void add_bool(bool value_to_add) {
        add_byte(value_to_add ? 1U : 0U);
    }

    void add_i8(std::int8_t value_to_add) {
        add_byte(static_cast<std::uint8_t>(value_to_add));
    }

    void add_u8(std::uint8_t value_to_add) {
        add_byte(value_to_add);
    }

    void add_u64(std::uint64_t value_to_add) {
        for (int shift = 0; shift < 64; shift += 8) {
            add_byte(static_cast<std::uint8_t>(value_to_add >> shift));
        }
    }
};

template <typename Enum> void add_enum(Fnv1a &hash, Enum value) {
    hash.add_u8(static_cast<std::uint8_t>(value));
}

bool same_position(const DroneState &drone, Cell cell) {
    return drone.alive && drone.x == cell.x && drone.y == cell.y && drone.plane == cell.plane;
}

bool cell_less(const Cell &left, const Cell &right) {
    if (left.plane != right.plane) {
        return left.plane < right.plane;
    }
    if (left.y != right.y) {
        return left.y < right.y;
    }
    return left.x < right.x;
}

std::optional<std::pair<int, int>> direction_delta(Direction direction) {
    switch (direction) {
    case Direction::North:
        return std::pair{0, -1};
    case Direction::East:
        return std::pair{1, 0};
    case Direction::South:
        return std::pair{0, 1};
    case Direction::West:
        return std::pair{-1, 0};
    }
    return std::nullopt;
}

bool legal_state(const Map &map, const GameState &state) {
    if (state.round < 1 || state.round > kMaxRounds || state.action_index < 1 ||
        state.action_index > kActionsPerTurn) {
        return false;
    }

    const auto valid_drone = [&map](const DroneState &drone) {
        if (!map.in_bounds(drone.x, drone.y)) {
            return false;
        }
        if (map.has_obstacle({drone.x, drone.y, drone.plane})) {
            return false;
        }
        return valid_direction(drone.facing);
    };

    if (!valid_drone(state.red) || !valid_drone(state.blue)) {
        return false;
    }

    if (state.red.alive && state.blue.alive && state.red.x == state.blue.x &&
        state.red.y == state.blue.y && state.red.plane == state.blue.plane) {
        return false;
    }

    if (state.finished && state.winner == Winner::None) {
        return false;
    }
    return true;
}

void add_drone_to_hash(Fnv1a &hash, const DroneState &drone) {
    hash.add_i8(drone.x);
    hash.add_i8(drone.y);
    add_enum(hash, drone.plane);
    add_enum(hash, drone.facing);
    hash.add_bool(drone.alive);
}

std::string hash_to_string(std::uint64_t hash) {
    std::ostringstream output;
    output << "fnv1a64:" << std::hex << std::setw(16) << std::setfill('0') << hash;
    return output.str();
}

bool same_event_without_sequence(const ReplayEvent &left, const ReplayEvent &right) {
    return left.type == right.type && left.round == right.round &&
           left.action_index == right.action_index && left.side == right.side &&
           left.action == right.action && left.effect == right.effect &&
           left.projectile_path == right.projectile_path && left.scan == right.scan &&
           left.state_after == right.state_after && left.state_hash == right.state_hash &&
           left.winner == right.winner && left.end_reason == right.end_reason;
}

} // namespace

Map::Map(std::array<Cell, kObstacleCount> obstacles) : obstacles_(std::move(obstacles)) {}

Map Map::generate(std::uint64_t seed) {
    std::vector<Cell> candidates;
    candidates.reserve(30);

    for (std::uint8_t plane = 0; plane < kPlaneCount; ++plane) {
        for (std::int8_t y = 0; y < kMapHeight; ++y) {
            for (std::int8_t x = 0; x < kMapWidth; ++x) {
                const bool red_spawn = x == 0 && y == 0 && plane == 0;
                const bool blue_spawn = x == 3 && y == 3 && plane == 0;
                if (!red_spawn && !blue_spawn) {
                    candidates.push_back({x, y, static_cast<Plane>(plane)});
                }
            }
        }
    }

    std::mt19937_64 random(seed);
    for (std::size_t index = 0; index < kObstacleCount; ++index) {
        const std::size_t offset = random() % (candidates.size() - index);
        std::swap(candidates[index], candidates[index + offset]);
    }

    std::array<Cell, kObstacleCount> obstacles{};
    std::copy_n(candidates.begin(), kObstacleCount, obstacles.begin());
    std::sort(obstacles.begin(), obstacles.end(), cell_less);
    return Map(obstacles);
}

std::optional<Map> Map::from_obstacles(const std::array<Cell, kObstacleCount> &obstacles) {
    std::array<Cell, kObstacleCount> sorted = obstacles;
    for (std::size_t index = 0; index < sorted.size(); ++index) {
        const Cell cell = sorted[index];
        if (cell.plane != Plane::Lower && cell.plane != Plane::Upper) {
            return std::nullopt;
        }
        if (cell.x < 0 || cell.x >= kMapWidth || cell.y < 0 || cell.y >= kMapHeight) {
            return std::nullopt;
        }
        if ((cell.x == 0 && cell.y == 0 && cell.plane == Plane::Lower) ||
            (cell.x == 3 && cell.y == 3 && cell.plane == Plane::Lower)) {
            return std::nullopt;
        }
        for (std::size_t previous = 0; previous < index; ++previous) {
            if (sorted[previous] == cell) {
                return std::nullopt;
            }
        }
    }

    std::sort(sorted.begin(), sorted.end(), cell_less);
    return Map(sorted);
}

bool Map::in_bounds(std::int8_t x, std::int8_t y) const {
    return x >= 0 && x < kMapWidth && y >= 0 && y < kMapHeight;
}

bool Map::has_obstacle(Cell cell) const {
    return std::find(obstacles_.begin(), obstacles_.end(), cell) != obstacles_.end();
}

const std::array<Cell, kObstacleCount> &Map::obstacles() const {
    return obstacles_;
}

Match::Match(std::uint64_t map_seed)
    : Match(map_seed, Map::generate(map_seed), GameState{}, true) {}

Match::Match(Map map) : Match(0, std::move(map), GameState{}, true) {}

Match::Match(std::uint64_t map_seed, Map map, GameState state, bool record_start_event)
    : map_seed_(map_seed), map_(std::move(map)), state_(std::move(state)) {
    if (!legal_state(map_, state_)) {
        throw std::invalid_argument("invalid initial game state");
    }
    if (record_start_event) {
        append_start_event();
    }
}

Match Match::from_state_for_testing(Map map, GameState state) {
    return Match(0, std::move(map), std::move(state), true);
}

const Map &Match::map() const {
    return map_;
}

const GameState &Match::state() const {
    return state_;
}

const std::vector<ReplayEvent> &Match::events() const {
    return events_;
}

std::uint64_t Match::map_seed() const {
    return map_seed_;
}

std::string Match::state_hash() const {
    return calculate_state_hash();
}

ReplayLog Match::replay_log() const {
    return ReplayLog{map_seed_, map_, events_};
}

DroneState &Match::active_drone() {
    return state_.active_side == Side::Red ? state_.red : state_.blue;
}

const DroneState &Match::active_drone() const {
    return state_.active_side == Side::Red ? state_.red : state_.blue;
}

DroneState &Match::opponent_drone() {
    return state_.active_side == Side::Red ? state_.blue : state_.red;
}

const DroneState &Match::opponent_drone() const {
    return state_.active_side == Side::Red ? state_.blue : state_.red;
}

ActionOutcome Match::make_outcome(ActionEffect effect, bool consumed) const {
    ActionOutcome outcome;
    outcome.effect = effect;
    outcome.consumed = consumed;
    outcome.match_finished = state_.finished;
    outcome.state_after = state_;
    outcome.state_hash = calculate_state_hash();
    outcome.event_sequence = events_.empty() ? 0 : events_.back().sequence;
    return outcome;
}

void Match::append_start_event() {
    ReplayEvent event;
    event.sequence = 0;
    event.type = EventType::MatchStarted;
    event.round = state_.round;
    event.action_index = state_.action_index;
    event.side = state_.active_side;
    event.state_after = state_;
    event.state_hash = calculate_state_hash();
    events_.push_back(std::move(event));
}

void Match::append_end_event() {
    ReplayEvent event;
    event.sequence = events_.size();
    event.type = EventType::MatchEnded;
    event.round = state_.round;
    event.action_index = state_.action_index;
    event.side = state_.active_side;
    event.state_after = state_;
    event.state_hash = calculate_state_hash();
    event.winner = state_.winner;
    event.end_reason = state_.end_reason;
    events_.push_back(std::move(event));
}

void Match::advance_turn() {
    if (state_.active_side == Side::Red) {
        if (state_.action_index < kActionsPerTurn) {
            ++state_.action_index;
            return;
        }
        state_.active_side = Side::Blue;
        state_.action_index = 1;
        return;
    }

    if (state_.action_index < kActionsPerTurn) {
        ++state_.action_index;
        return;
    }

    if (state_.round == kMaxRounds) {
        state_.finished = true;
        state_.winner = Winner::Draw;
        state_.end_reason = EndReason::RoundLimit;
        return;
    }

    ++state_.round;
    state_.active_side = Side::Red;
    state_.action_index = 1;
}

ActionOutcome Match::apply(Action action) {
    if (state_.finished) {
        return make_outcome(ActionEffect::Invalid, false);
    }

    const Side acting_side = state_.active_side;
    const std::uint8_t acting_round = state_.round;
    const std::uint8_t acting_action_index = state_.action_index;
    ActionEffect effect = ActionEffect::Invalid;
    std::vector<Cell> projectile_path;
    std::optional<ScanResult> scan;

    switch (action.type) {
    case ActionType::Move: {
        const auto delta = direction_delta(action.direction);
        if (!delta.has_value()) {
            break;
        }
        const auto &actor = active_drone();
        const Cell target{
            static_cast<std::int8_t>(actor.x + delta->first),
            static_cast<std::int8_t>(actor.y + delta->second),
            actor.plane,
        };
        const auto &enemy = opponent_drone();
        if (!map_.in_bounds(target.x, target.y) || map_.has_obstacle(target) ||
            same_position(enemy, target)) {
            effect = ActionEffect::MoveBlocked;
            break;
        }
        active_drone().x = target.x;
        active_drone().y = target.y;
        effect = ActionEffect::Moved;
        break;
    }
    case ActionType::Turn:
        if (valid_direction(action.direction)) {
            active_drone().facing = action.direction;
            effect = ActionEffect::Turned;
        }
        break;
    case ActionType::Elevate: {
        const auto &actor = active_drone();
        const Plane target_plane = actor.plane == Plane::Lower ? Plane::Upper : Plane::Lower;
        const Cell target{actor.x, actor.y, target_plane};
        if (map_.has_obstacle(target) || same_position(opponent_drone(), target)) {
            effect = ActionEffect::ElevateBlocked;
            break;
        }
        active_drone().plane = target_plane;
        effect = ActionEffect::ElevateSucceeded;
        break;
    }
    case ActionType::Fire: {
        effect = ActionEffect::FireMiss;
        const auto delta = direction_delta(active_drone().facing);
        if (!delta.has_value()) {
            break;
        }
        for (int distance = 1; distance <= kProjectileRange; ++distance) {
            const Cell target{
                static_cast<std::int8_t>(active_drone().x + delta->first * distance),
                static_cast<std::int8_t>(active_drone().y + delta->second * distance),
                active_drone().plane,
            };
            if (!map_.in_bounds(target.x, target.y)) {
                break;
            }
            projectile_path.push_back(target);
            if (map_.has_obstacle(target)) {
                effect = ActionEffect::FireBlocked;
                break;
            }
            if (same_position(opponent_drone(), target)) {
                opponent_drone().alive = false;
                state_.finished = true;
                state_.winner = acting_side == Side::Red ? Winner::Red : Winner::Blue;
                state_.end_reason = EndReason::Destroyed;
                effect = ActionEffect::EnemyDestroyed;
                break;
            }
            effect = ActionEffect::FireMiss;
        }
        break;
    }
    case ActionType::Scout: {
        ScanResult result;
        result.plane = active_drone().plane;
        std::size_t index = 0;
        const auto &enemy = opponent_drone();
        for (int dy = -1; dy <= 1; ++dy) {
            for (int dx = -1; dx <= 1; ++dx) {
                const auto &actor = active_drone();
                const std::int8_t x = static_cast<std::int8_t>(actor.x + dx);
                const std::int8_t y = static_cast<std::int8_t>(actor.y + dy);
                const bool in_bounds = map_.in_bounds(x, y);
                const Cell cell{x, y, actor.plane};
                result.cells[index++] = {
                    static_cast<std::int8_t>(dx),
                    static_cast<std::int8_t>(dy),
                    in_bounds ? x : static_cast<std::int8_t>(-1),
                    in_bounds ? y : static_cast<std::int8_t>(-1),
                    in_bounds,
                    in_bounds && map_.has_obstacle(cell),
                    in_bounds && same_position(enemy, cell),
                };
            }
        }
        scan = result;
        effect = ActionEffect::Scanned;
        break;
    }
    }

    if (!state_.finished) {
        advance_turn();
    }

    ReplayEvent action_event =
        make_action_event(action, effect, projectile_path, scan, events_.size(), acting_round,
                          acting_action_index, acting_side);
    events_.push_back(action_event);

    if (state_.finished) {
        append_end_event();
    }

    ActionOutcome outcome;
    outcome.effect = effect;
    outcome.consumed = true;
    outcome.match_finished = state_.finished;
    outcome.projectile_path = std::move(projectile_path);
    outcome.scan = std::move(scan);
    outcome.state_after = state_;
    outcome.state_hash = calculate_state_hash();
    outcome.event_sequence = action_event.sequence;

    return outcome;
}

ReplayEvent Match::make_action_event(const Action &action, ActionEffect effect,
                                     const std::vector<Cell> &projectile_path,
                                     const std::optional<ScanResult> &scan, std::uint64_t sequence,
                                     std::uint8_t round, std::uint8_t action_index,
                                     Side side) const {
    ReplayEvent event;
    event.sequence = sequence;
    event.type = EventType::ActionResolved;
    event.round = round;
    event.action_index = action_index;
    event.side = side;
    event.action = action;
    event.effect = effect;
    event.projectile_path = projectile_path;
    event.scan = scan;
    event.state_after = state_;
    event.state_hash = calculate_state_hash();
    return event;
}

std::string Match::calculate_state_hash() const {
    Fnv1a hash;
    for (const Cell obstacle : map_.obstacles()) {
        hash.add_i8(obstacle.x);
        hash.add_i8(obstacle.y);
        add_enum(hash, obstacle.plane);
    }
    hash.add_u8(state_.round);
    hash.add_u8(state_.action_index);
    add_enum(hash, state_.active_side);
    add_drone_to_hash(hash, state_.red);
    add_drone_to_hash(hash, state_.blue);
    hash.add_bool(state_.finished);
    add_enum(hash, state_.winner);
    add_enum(hash, state_.end_reason);
    return hash_to_string(hash.value);
}

ReplayResult Match::replay(const ReplayLog &log) {
    ReplayResult result;
    Match reconstructed(log.map_seed, log.map, GameState{}, true);

    if (log.events.empty()) {
        result.error = "replay has no events";
        return result;
    }
    if (log.events.front().sequence != reconstructed.events_.front().sequence ||
        !same_event_without_sequence(log.events.front(), reconstructed.events_.front())) {
        result.error = "match-start event mismatch";
        return result;
    }

    result.reconstructed_states.push_back(reconstructed.state_);
    for (std::size_t index = 1; index < log.events.size(); ++index) {
        const ReplayEvent &expected = log.events[index];
        if (expected.type == EventType::ActionResolved) {
            const std::size_t generated_index = reconstructed.events_.size();
            const ActionOutcome outcome = reconstructed.apply(expected.action);
            if (generated_index >= reconstructed.events_.size() ||
                reconstructed.events_[generated_index].sequence != expected.sequence ||
                !same_event_without_sequence(expected, reconstructed.events_[generated_index]) ||
                outcome.state_hash != expected.state_hash) {
                result.failed_event = index;
                result.error = "action event mismatch";
                result.final_state = reconstructed.state_;
                return result;
            }
            result.reconstructed_states.push_back(reconstructed.state_);
            continue;
        }

        if (expected.type == EventType::MatchEnded) {
            if (reconstructed.events_.empty() ||
                reconstructed.events_.back().sequence != expected.sequence ||
                !same_event_without_sequence(expected, reconstructed.events_.back())) {
                result.failed_event = index;
                result.error = "match-end event mismatch";
                result.final_state = reconstructed.state_;
                return result;
            }
            continue;
        }

        result.failed_event = index;
        result.error = "unexpected event type";
        result.final_state = reconstructed.state_;
        return result;
    }

    if (reconstructed.events_.size() != log.events.size()) {
        result.failed_event = log.events.size();
        result.error = "event count mismatch";
        result.final_state = reconstructed.state_;
        return result;
    }

    result.ok = true;
    result.final_state = reconstructed.state_;
    return result;
}

bool valid_direction(Direction direction) {
    switch (direction) {
    case Direction::North:
    case Direction::East:
    case Direction::South:
    case Direction::West:
        return true;
    }
    return false;
}

std::string to_string(ActionEffect effect) {
    switch (effect) {
    case ActionEffect::None:
        return "NONE";
    case ActionEffect::Moved:
        return "MOVED";
    case ActionEffect::MoveBlocked:
        return "MOVE_BLOCKED";
    case ActionEffect::Turned:
        return "TURNED";
    case ActionEffect::ElevateSucceeded:
        return "ELEVATE_SUCCEEDED";
    case ActionEffect::ElevateBlocked:
        return "ELEVATE_BLOCKED";
    case ActionEffect::FireMiss:
        return "FIRE_MISS";
    case ActionEffect::FireBlocked:
        return "FIRE_BLOCKED";
    case ActionEffect::EnemyDestroyed:
        return "ENEMY_DESTROYED";
    case ActionEffect::Scanned:
        return "SCANNED";
    case ActionEffect::Invalid:
        return "INVALID";
    }
    return "INVALID";
}

std::string to_string(Winner winner) {
    switch (winner) {
    case Winner::None:
        return "NONE";
    case Winner::Red:
        return "RED";
    case Winner::Blue:
        return "BLUE";
    case Winner::Draw:
        return "DRAW";
    }
    return "NONE";
}

std::string to_string(EndReason reason) {
    switch (reason) {
    case EndReason::None:
        return "NONE";
    case EndReason::Destroyed:
        return "DESTROYED";
    case EndReason::RoundLimit:
        return "ROUND_LIMIT";
    }
    return "NONE";
}

} // namespace arena::engine
