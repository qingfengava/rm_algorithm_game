#include "arena/runner_protocol.hpp"

#include <cassert>

int main() {
    arena::runner::StartMessage start{
        {arena::Side::Blue,
         {3, 3, arena::Plane::Lower, arena::Direction::West, true},
         4,
         4,
         20,
         3},
    };
    arena::runner::StartMessage decoded_start;
    assert(arena::runner::decode_start(arena::runner::encode_start(start), decoded_start));
    assert(decoded_start.match_start == start.match_start);

    arena::Observation observation{
        2,
        3,
        arena::Side::Blue,
        {3, 2, arena::Plane::Upper, arena::Direction::West, true},
        arena::ActionResult{arena::ActionEffect::Scanned},
        std::nullopt,
    };
    arena::ScanResult scan{};
    scan.plane = arena::Plane::Upper;
    for (int index = 0; index < 9; ++index) {
        scan.cells[static_cast<std::size_t>(index)] = {
            static_cast<std::int8_t>(index % 3 - 1),
            static_cast<std::int8_t>(index / 3 - 1),
            static_cast<std::int8_t>(index % 3),
            static_cast<std::int8_t>(index / 3),
            true,
            index == 4,
            index == 8,
        };
    }
    observation.previous_scan = scan;
    arena::Observation decoded_observation;
    assert(arena::runner::decode_observation(arena::runner::encode_observation(observation),
                                             decoded_observation));
    assert(decoded_observation == observation);

    const arena::Action action = arena::Action::move(arena::Direction::South);
    arena::Action decoded_action;
    assert(arena::runner::decode_action(arena::runner::encode_action(action), decoded_action));
    assert(decoded_action == action);
    return 0;
}
