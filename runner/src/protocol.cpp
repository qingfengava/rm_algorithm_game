#include "arena/runner_protocol.hpp"

#include <limits>
#include <sstream>

namespace arena::runner {
namespace {

template <typename Integer> bool read_integer(std::istringstream &input, Integer &value) {
    long long parsed = 0;
    if (!(input >> parsed)) {
        return false;
    }
    if (parsed < static_cast<long long>(std::numeric_limits<Integer>::min()) ||
        parsed > static_cast<long long>(std::numeric_limits<Integer>::max())) {
        return false;
    }
    value = static_cast<Integer>(parsed);
    return true;
}

bool read_bool(std::istringstream &input, bool &value) {
    int parsed = 0;
    if (!(input >> parsed) || (parsed != 0 && parsed != 1)) {
        return false;
    }
    value = parsed == 1;
    return true;
}

bool read_side(std::istringstream &input, Side &side) {
    std::uint8_t value = 0;
    if (!read_integer(input, value) || value > static_cast<std::uint8_t>(Side::Blue)) {
        return false;
    }
    side = static_cast<Side>(value);
    return true;
}

bool read_plane(std::istringstream &input, Plane &plane) {
    std::uint8_t value = 0;
    if (!read_integer(input, value) || value > static_cast<std::uint8_t>(Plane::Upper)) {
        return false;
    }
    plane = static_cast<Plane>(value);
    return true;
}

bool read_direction(std::istringstream &input, Direction &direction) {
    std::uint8_t value = 0;
    if (!read_integer(input, value) || value > static_cast<std::uint8_t>(Direction::West)) {
        return false;
    }
    direction = static_cast<Direction>(value);
    return true;
}

bool read_action_type(std::istringstream &input, ActionType &type) {
    std::uint8_t value = 0;
    if (!read_integer(input, value) || value > static_cast<std::uint8_t>(ActionType::Scout)) {
        return false;
    }
    type = static_cast<ActionType>(value);
    return true;
}

bool read_drone(std::istringstream &input, DroneState &drone) {
    if (!read_integer(input, drone.x) || !read_integer(input, drone.y) ||
        !read_plane(input, drone.plane) || !read_direction(input, drone.facing) ||
        !read_bool(input, drone.alive)) {
        return false;
    }
    return true;
}

void write_drone(std::ostringstream &output, const DroneState &drone) {
    output << static_cast<int>(drone.x) << ' ' << static_cast<int>(drone.y) << ' '
           << static_cast<int>(drone.plane) << ' ' << static_cast<int>(drone.facing) << ' '
           << (drone.alive ? 1 : 0);
}

bool at_end(std::istringstream &input) {
    std::string extra;
    return !(input >> extra);
}

} // namespace

std::string encode_start(const StartMessage &message) {
    std::ostringstream output;
    output << kProtocolName << " START " << static_cast<int>(message.match_start.side) << ' ';
    write_drone(output, message.match_start.self);
    output << ' ' << static_cast<int>(message.match_start.map_width) << ' '
           << static_cast<int>(message.match_start.map_height) << ' '
           << static_cast<int>(message.match_start.max_rounds) << ' '
           << static_cast<int>(message.match_start.actions_per_turn);
    return output.str();
}

bool decode_start(std::string_view line, StartMessage &message) {
    std::istringstream input{std::string(line)};
    std::string protocol;
    std::string command;
    if (!(input >> protocol >> command) || protocol != kProtocolName || command != "START") {
        return false;
    }
    if (!read_side(input, message.match_start.side) ||
        !read_drone(input, message.match_start.self) ||
        !read_integer(input, message.match_start.map_width) ||
        !read_integer(input, message.match_start.map_height) ||
        !read_integer(input, message.match_start.max_rounds) ||
        !read_integer(input, message.match_start.actions_per_turn)) {
        return false;
    }
    return at_end(input);
}

std::string encode_observation(const Observation &observation) {
    std::ostringstream output;
    output << kProtocolName << " ACT " << static_cast<int>(observation.round) << ' '
           << static_cast<int>(observation.action_index) << ' '
           << static_cast<int>(observation.side) << ' ';
    write_drone(output, observation.self);
    output << ' ' << (observation.previous_action.has_value() ? 1 : 0);
    if (observation.previous_action.has_value()) {
        output << ' ' << static_cast<int>(observation.previous_action->effect);
    }
    output << ' ' << (observation.previous_scan.has_value() ? 1 : 0);
    if (observation.previous_scan.has_value()) {
        const ScanResult &scan = *observation.previous_scan;
        output << ' ' << static_cast<int>(scan.plane);
        for (const ScanCell &cell : scan.cells) {
            output << ' ' << static_cast<int>(cell.dx) << ' ' << static_cast<int>(cell.dy) << ' '
                   << static_cast<int>(cell.x) << ' ' << static_cast<int>(cell.y) << ' '
                   << (cell.in_bounds ? 1 : 0) << ' ' << (cell.obstacle ? 1 : 0) << ' '
                   << (cell.enemy_present ? 1 : 0);
        }
    }
    return output.str();
}

bool decode_observation(std::string_view line, Observation &observation) {
    std::istringstream input{std::string(line)};
    std::string protocol;
    std::string command;
    if (!(input >> protocol >> command) || protocol != kProtocolName || command != "ACT") {
        return false;
    }
    if (!read_integer(input, observation.round) || !read_integer(input, observation.action_index) ||
        !read_side(input, observation.side) || !read_drone(input, observation.self)) {
        return false;
    }

    bool has_previous_action = false;
    if (!read_bool(input, has_previous_action)) {
        return false;
    }
    observation.previous_action.reset();
    if (has_previous_action) {
        std::uint8_t effect = 0;
        if (!read_integer(input, effect) || effect > static_cast<std::uint8_t>(ActionEffect::Invalid)) {
            return false;
        }
        observation.previous_action = ActionResult{static_cast<ActionEffect>(effect)};
    }

    bool has_scan = false;
    if (!read_bool(input, has_scan)) {
        return false;
    }
    observation.previous_scan.reset();
    if (has_scan) {
        ScanResult scan{};
        if (!read_plane(input, scan.plane)) {
            return false;
        }
        for (ScanCell &cell : scan.cells) {
            if (!read_integer(input, cell.dx) || !read_integer(input, cell.dy) ||
                !read_integer(input, cell.x) || !read_integer(input, cell.y) ||
                !read_bool(input, cell.in_bounds) || !read_bool(input, cell.obstacle) ||
                !read_bool(input, cell.enemy_present)) {
                return false;
            }
        }
        observation.previous_scan = scan;
    }
    return at_end(input);
}

std::string encode_action(const Action &action) {
    std::ostringstream output;
    output << kProtocolName << " ACTION " << static_cast<int>(action.type) << ' '
           << static_cast<int>(action.direction);
    return output.str();
}

bool decode_action(std::string_view line, Action &action) {
    std::istringstream input{std::string(line)};
    std::string protocol;
    std::string command;
    if (!(input >> protocol >> command) || protocol != kProtocolName || command != "ACTION") {
        return false;
    }
    if (!read_action_type(input, action.type) || !read_direction(input, action.direction)) {
        return false;
    }
    return at_end(input);
}

std::string encode_ready() {
    return std::string(kProtocolName) + " READY";
}

std::string encode_error(std::string_view code) {
    return std::string(kProtocolName) + " ERROR " + std::string(code);
}

std::string encode_bye() {
    return std::string(kProtocolName) + " BYE";
}

} // namespace arena::runner
