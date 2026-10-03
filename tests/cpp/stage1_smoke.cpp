#include "arena/api.hpp"
#include "arena/engine.hpp"

#include <cassert>
#include <concepts>

static_assert(std::same_as<decltype(arena::Action::scout()), arena::Action>);
static_assert(arena::engine::kMapWidth == 4);
static_assert(arena::engine::kActionsPerTurn == 3);

int main() {
    const auto action = arena::Action::move(arena::Direction::East);
    assert(action.type == arena::ActionType::Move);
    assert(action.direction == arena::Direction::East);

    const auto fire = arena::Action::fire();
    assert(fire.type == arena::ActionType::Fire);

    return 0;
}
