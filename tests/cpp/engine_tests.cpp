#include "arena/engine.hpp"

#include <array>
#include <cstdint>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {

using arena::Action;
using arena::ActionEffect;
using arena::ActionType;
using arena::Direction;
using arena::Plane;
using arena::Side;
using arena::engine::Cell;
using arena::engine::EndReason;
using arena::engine::GameState;
using arena::engine::Map;
using arena::engine::Match;
using arena::engine::Winner;

void expect(bool condition, const std::string &message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

Map make_map(std::array<Cell, 4> obstacles) {
    const auto map = Map::from_obstacles(obstacles);
    expect(map.has_value(), "test map is invalid");
    return *map;
}

Map empty_lower_map() {
    return make_map({
        Cell{0, 1, Plane::Upper},
        Cell{1, 1, Plane::Upper},
        Cell{2, 2, Plane::Upper},
        Cell{3, 2, Plane::Upper},
    });
}

GameState state_with_blue_at(std::int8_t x, std::int8_t y) {
    GameState state;
    state.red = {0, 0, Plane::Lower, Direction::East, true};
    state.blue = {x, y, Plane::Lower, Direction::West, true};
    return state;
}

void test_map_generation() {
    const auto first = Map::generate(12345);
    const auto second = Map::generate(12345);
    expect(first == second, "same map seed must generate the same map");

    for (const Cell obstacle : first.obstacles()) {
        expect(!(obstacle.x == 0 && obstacle.y == 0 && obstacle.plane == Plane::Lower),
               "red lower spawn cannot contain an obstacle");
        expect(!(obstacle.x == 3 && obstacle.y == 3 && obstacle.plane == Plane::Lower),
               "blue lower spawn cannot contain an obstacle");
    }
}

void test_map_boundary() {
    Match match(empty_lower_map());
    const auto outcome = match.apply(Action::move(Direction::North));
    expect(outcome.effect == ActionEffect::MoveBlocked, "north boundary must block movement");
    expect(match.state().red.x == 0 && match.state().red.y == 0,
           "blocked movement must preserve position");
}

void test_obstacle_blocks_movement() {
    Match match(make_map({
        Cell{1, 0, Plane::Lower},
        Cell{0, 1, Plane::Upper},
        Cell{1, 1, Plane::Upper},
        Cell{2, 2, Plane::Upper},
    }));
    const auto outcome = match.apply(Action::move(Direction::East));
    expect(outcome.effect == ActionEffect::MoveBlocked, "obstacle must block movement");
    expect(match.state().red.x == 0 && match.state().red.y == 0,
           "obstacle collision must preserve position");
}

void test_obstacle_blocks_projectile() {
    Match match(make_map({
        Cell{2, 0, Plane::Lower},
        Cell{0, 1, Plane::Upper},
        Cell{1, 1, Plane::Upper},
        Cell{2, 2, Plane::Upper},
    }));
    auto state = state_with_blue_at(3, 0);
    match = Match::from_state_for_testing(match.map(), state);

    const auto outcome = match.apply(Action::fire());
    expect(outcome.effect == ActionEffect::FireBlocked, "obstacle must stop projectile");
    expect(outcome.projectile_path.size() == 2, "blocked projectile path must include obstacle");
    expect(match.state().blue.alive, "blocked projectile must not destroy enemy");
}

void test_projectile_hits_at_each_range() {
    for (std::int8_t distance = 1; distance <= 3; ++distance) {
        Match match =
            Match::from_state_for_testing(empty_lower_map(), state_with_blue_at(distance, 0));
        const auto outcome = match.apply(Action::fire());
        expect(outcome.effect == ActionEffect::EnemyDestroyed,
               "projectile must hit an enemy at every range");
        expect(outcome.projectile_path.size() == static_cast<std::size_t>(distance),
               "projectile path must stop at the enemy");
        expect(!match.state().blue.alive, "enemy must have one life and be destroyed");
        expect(match.state().winner == Winner::Red, "red must win after its hit");
    }
}

void test_projectile_does_not_cross_planes() {
    GameState state = state_with_blue_at(1, 0);
    state.blue.plane = Plane::Upper;
    Match match = Match::from_state_for_testing(empty_lower_map(), state);

    const auto outcome = match.apply(Action::fire());
    expect(outcome.effect == ActionEffect::FireMiss,
           "projectile must stay on the firing drone's plane");
    expect(match.state().blue.alive, "cross-plane projectile must not hit enemy");
}

void test_elevation_blocked_by_obstacle() {
    Match match(make_map({
        Cell{0, 0, Plane::Upper},
        Cell{0, 1, Plane::Upper},
        Cell{1, 1, Plane::Upper},
        Cell{2, 2, Plane::Upper},
    }));
    const auto outcome = match.apply(Action::elevate());
    expect(outcome.effect == ActionEffect::ElevateBlocked,
           "obstacle on target plane must block elevation");
    expect(match.state().red.plane == Plane::Lower, "blocked elevation must preserve plane");
}

void test_elevation_succeeds() {
    Match match(empty_lower_map());
    const auto outcome = match.apply(Action::elevate());
    expect(outcome.effect == ActionEffect::ElevateSucceeded, "clear target plane must elevate");
    expect(match.state().red.plane == Plane::Upper, "successful elevation must change plane");
}

void test_scout_at_edge() {
    Match match(make_map({
        Cell{1, 1, Plane::Lower},
        Cell{0, 1, Plane::Upper},
        Cell{1, 1, Plane::Upper},
        Cell{2, 2, Plane::Upper},
    }));
    match = Match::from_state_for_testing(match.map(), state_with_blue_at(1, 0));

    const auto outcome = match.apply(Action::scout());
    expect(outcome.effect == ActionEffect::Scanned, "scout must succeed at map edge");
    expect(outcome.scan.has_value(), "scout must return scan data");
    const auto &scan = *outcome.scan;
    expect(!scan.cells[0].in_bounds && !scan.cells[1].in_bounds && !scan.cells[2].in_bounds,
           "top row of edge scan must be out of bounds");
    expect(scan.cells[5].enemy_present, "scan must report enemy in same plane");
    expect(scan.cells[8].obstacle, "scan must report obstacle in same plane");
    expect(scan.cells[8].dx == 1 && scan.cells[8].dy == 1,
           "scan cells must use documented ordering");
}

void test_turn_and_red_three_actions() {
    Match match(empty_lower_map());
    expect(match.apply(Action::turn(Direction::East)).effect == ActionEffect::Turned,
           "turn must be a valid action");
    expect(match.apply(Action::turn(Direction::South)).effect == ActionEffect::Turned,
           "second red action must execute");
    const auto third = match.apply(Action::turn(Direction::West));
    expect(third.effect == ActionEffect::Turned, "third red action must execute");
    expect(match.state().active_side == Side::Blue && match.state().round == 1 &&
               match.state().action_index == 1,
           "blue must start after three red actions");
    expect(match.events()[1].round == 1 && match.events()[1].action_index == 1 &&
               match.events()[1].side == Side::Red,
           "action event must record the acting turn");
}

void test_blue_three_actions_advances_round() {
    Match match(empty_lower_map());
    for (int index = 0; index < 3; ++index) {
        match.apply(Action::turn(Direction::North));
    }
    for (int index = 0; index < 3; ++index) {
        match.apply(Action::turn(Direction::South));
    }
    expect(match.state().round == 2 && match.state().active_side == Side::Red &&
               match.state().action_index == 1,
           "round must advance after three blue actions");
    expect(match.events().size() == 7, "six actions must create six action events plus start");
}

void test_round_twenty_draw() {
    GameState state = state_with_blue_at(3, 3);
    state.round = 20;
    state.active_side = Side::Blue;
    state.action_index = 3;
    Match match = Match::from_state_for_testing(empty_lower_map(), state);

    const auto outcome = match.apply(Action::turn(Direction::North));
    expect(outcome.match_finished, "round twenty must finish after blue action three");
    expect(match.state().winner == Winner::Draw &&
               match.state().end_reason == EndReason::RoundLimit,
           "survival through round twenty must be a draw");
    expect(match.events().back().type == arena::engine::EventType::MatchEnded,
           "round limit must record match end event");
}

void test_one_life_kill() {
    Match match = Match::from_state_for_testing(empty_lower_map(), state_with_blue_at(1, 0));
    const auto outcome = match.apply(Action::fire());
    expect(outcome.effect == ActionEffect::EnemyDestroyed, "one hit must destroy the enemy");
    expect(match.state().finished && !match.state().blue.alive,
           "destroyed drone must be dead and match must finish");
    expect(match.events().size() == 3, "kill must record start, action, and end events");
}

void test_invalid_action_consumes_turn() {
    Match match(empty_lower_map());
    const Action invalid{static_cast<ActionType>(255), Direction::North};
    const auto outcome = match.apply(invalid);
    expect(outcome.effect == ActionEffect::Invalid && outcome.consumed,
           "invalid action must be recorded and consume an action");
    expect(match.state().active_side == Side::Red && match.state().action_index == 2,
           "invalid action must advance the action index");
}

void test_same_seed_and_replay() {
    Match first(987654321);
    Match second(987654321);
    const std::array<Action, 6> actions = {
        Action::scout(), Action::turn(Direction::South), Action::move(Direction::South),
        Action::scout(), Action::turn(Direction::North), Action::fire(),
    };

    for (const Action action : actions) {
        first.apply(action);
        second.apply(action);
    }

    expect(first.map() == second.map(), "same seed must produce equal maps");
    expect(first.state() == second.state(), "same actions must produce equal state");
    expect(first.state_hash() == second.state_hash(), "same actions must produce equal hash");
    expect(first.events() == second.events(), "same actions must produce equal events");

    const auto replay = Match::replay(first.replay_log());
    expect(replay.ok, "recorded events must replay successfully");
    expect(replay.final_state == first.state(), "replay must reconstruct final state");
    expect(replay.reconstructed_states.size() == actions.size() + 1,
           "replay must reconstruct every action state");

    auto tampered = first.replay_log();
    tampered.events[1].state_hash = "fnv1a64:tampered";
    expect(!Match::replay(tampered).ok, "tampered state hash must fail replay verification");
}

} // namespace

int main() {
    try {
        test_map_generation();
        test_map_boundary();
        test_obstacle_blocks_movement();
        test_obstacle_blocks_projectile();
        test_projectile_hits_at_each_range();
        test_projectile_does_not_cross_planes();
        test_elevation_blocked_by_obstacle();
        test_elevation_succeeds();
        test_scout_at_edge();
        test_turn_and_red_three_actions();
        test_blue_three_actions_advances_round();
        test_round_twenty_draw();
        test_one_life_kill();
        test_invalid_action_consumes_turn();
        test_same_seed_and_replay();
    } catch (const std::exception &error) {
        std::cerr << "engine test failure: " << error.what() << '\n';
        return 1;
    }

    std::cout << "engine tests passed\n";
    return 0;
}
