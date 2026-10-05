#include "arena/engine.hpp"
#include "arena/runner_protocol.hpp"

#include <array>
#include <cerrno>
#include <cstddef>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {

class RunnerProcess {
  public:
    static constexpr std::size_t kMaxResponseBytes = 64U * 1024U;

    explicit RunnerProcess(const char *path) {
        int input_pipe[2]{};
        int output_pipe[2]{};
        if (pipe(input_pipe) != 0 || pipe(output_pipe) != 0) {
            throw std::runtime_error("pipe failed");
        }
        pid_ = fork();
        if (pid_ < 0) {
            throw std::runtime_error("fork failed");
        }
        if (pid_ == 0) {
            dup2(input_pipe[0], STDIN_FILENO);
            dup2(output_pipe[1], STDOUT_FILENO);
            close(input_pipe[0]);
            close(input_pipe[1]);
            close(output_pipe[0]);
            close(output_pipe[1]);
            execl(path, path, "--act-time-ms", "50", "--match-time-ms", "10000",
                  "--memory-mb", "256", "--cpu-seconds", "10", static_cast<char *>(nullptr));
            _exit(127);
        }
        close(input_pipe[0]);
        close(output_pipe[1]);
        input_fd_ = input_pipe[1];
        output_fd_ = output_pipe[0];
    }

    RunnerProcess(const RunnerProcess &) = delete;
    RunnerProcess &operator=(const RunnerProcess &) = delete;

    ~RunnerProcess() {
        if (pid_ <= 0) {
            return;
        }
        close(input_fd_);
        close(output_fd_);
        int status = 0;
        const pid_t exited = waitpid(pid_, &status, WNOHANG);
        // If the referee stops reading because the other runner failed, do
        // not leave an algorithm process behind while waiting for it.
        if (exited == 0) {
            kill(pid_, SIGKILL);
        }
        if (exited == pid_) {
            return;
        }
        waitpid(pid_, &status, 0);
    }

    void send(const std::string &line) {
        std::string payload = line + '\n';
        std::size_t offset = 0;
        while (offset < payload.size()) {
            const ssize_t written = write(input_fd_, payload.data() + offset, payload.size() - offset);
            if (written <= 0) {
                throw std::runtime_error("runner write failed");
            }
            offset += static_cast<std::size_t>(written);
        }
    }

    std::string receive() {
        std::string line;
        char character = '\0';
        while (true) {
            const ssize_t count = read(output_fd_, &character, 1);
            if (count == 0) {
                throw std::runtime_error("runner exited before response");
            }
            if (count < 0) {
                if (errno == EINTR) {
                    continue;
                }
                throw std::runtime_error("runner read failed");
            }
            if (character == '\n') {
                return line;
            }
            line.push_back(character);
            if (line.size() > kMaxResponseBytes) {
                throw std::runtime_error("runner response exceeds 64 KiB");
            }
        }
    }

  private:
    pid_t pid_ = -1;
    int input_fd_ = -1;
    int output_fd_ = -1;
};

arena::DroneState to_sdk_drone(const arena::engine::DroneState &drone) {
    return {drone.x, drone.y, drone.plane, drone.facing, drone.alive};
}

struct PreviousAction {
    std::optional<arena::ActionResult> result;
    std::optional<arena::ScanResult> scan;
};

arena::Observation make_observation(const arena::engine::GameState &state,
                                    PreviousAction &previous) {
    const bool red = state.active_side == arena::Side::Red;
    return {
        state.round,
        state.action_index,
        state.active_side,
        to_sdk_drone(red ? state.red : state.blue),
        previous.result,
        previous.scan,
    };
}

void expect_line(const std::string &actual, const std::string &expected) {
    if (actual != expected) {
        throw std::runtime_error("unexpected runner response: " + actual);
    }
}

void validate_runner_path(const char *path) {
    struct stat metadata{};
    if (path == nullptr || stat(path, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
        access(path, X_OK) != 0) {
        throw std::runtime_error(std::string("runner is missing or not executable: ") +
                                 (path == nullptr ? "<null>" : path));
    }
}

arena::engine::Map qualification_map() {
    const std::array<arena::engine::Cell, 4> obstacles{{
        {0, 0, arena::Plane::Upper},
        {3, 3, arena::Plane::Upper},
        {1, 1, arena::Plane::Upper},
        {2, 2, arena::Plane::Upper},
    }};
    const auto map = arena::engine::Map::from_obstacles(obstacles);
    if (!map.has_value()) {
        throw std::runtime_error("qualification map is invalid");
    }
    return *map;
}

std::string json_escape(std::string_view value) {
    std::ostringstream output;
    output << '"';
    for (const unsigned char character : value) {
        switch (character) {
        case '"': output << "\\\""; break;
        case '\\': output << "\\\\"; break;
        case '\n': output << "\\n"; break;
        case '\r': output << "\\r"; break;
        case '\t': output << "\\t"; break;
        default:
            if (character < 0x20U) {
                output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                       << static_cast<unsigned int>(character) << std::dec;
            } else {
                output << static_cast<char>(character);
            }
        }
    }
    output << '"';
    return output.str();
}

const char *side_name(arena::Side side) {
    return side == arena::Side::Red ? "RED" : "BLUE";
}

const char *direction_name(arena::Direction direction) {
    switch (direction) {
    case arena::Direction::North: return "NORTH";
    case arena::Direction::East: return "EAST";
    case arena::Direction::South: return "SOUTH";
    case arena::Direction::West: return "WEST";
    }
    return "NORTH";
}

const char *action_type_name(arena::ActionType type) {
    switch (type) {
    case arena::ActionType::Move: return "MOVE";
    case arena::ActionType::Turn: return "TURN";
    case arena::ActionType::Elevate: return "ELEVATE";
    case arena::ActionType::Fire: return "FIRE";
    case arena::ActionType::Scout: return "SCOUT";
    }
    return "SCOUT";
}

std::string cell_json(const arena::engine::Cell &cell) {
    std::ostringstream output;
    output << "{\"x\":" << static_cast<int>(cell.x) << ",\"y\":"
           << static_cast<int>(cell.y) << ",\"z\":" << static_cast<int>(cell.plane)
           << '}';
    return output.str();
}

std::string drone_json(const arena::engine::DroneState &drone) {
    std::ostringstream output;
    output << "{\"x\":" << static_cast<int>(drone.x) << ",\"y\":"
           << static_cast<int>(drone.y) << ",\"z\":" << static_cast<int>(drone.plane)
           << ",\"facing\":" << json_escape(direction_name(drone.facing))
           << ",\"alive\":" << (drone.alive ? "true" : "false") << '}';
    return output.str();
}

std::string state_json(const arena::engine::GameState &state) {
    std::ostringstream output;
    output << "{\"round\":" << static_cast<int>(state.round)
           << ",\"action_index\":" << static_cast<int>(state.action_index)
           << ",\"active_side\":" << json_escape(side_name(state.active_side))
           << ",\"red\":" << drone_json(state.red)
           << ",\"blue\":" << drone_json(state.blue)
           << ",\"finished\":" << (state.finished ? "true" : "false")
           << ",\"winner\":" << json_escape(arena::engine::to_string(state.winner))
           << ",\"end_reason\":" << json_escape(arena::engine::to_string(state.end_reason))
           << '}';
    return output.str();
}

std::string action_json(const arena::Action &action) {
    std::ostringstream output;
    output << "{\"type\":" << json_escape(action_type_name(action.type))
           << ",\"direction\":" << json_escape(direction_name(action.direction)) << '}';
    return output.str();
}

std::string scan_json(const std::optional<arena::ScanResult> &scan) {
    if (!scan.has_value()) return "null";
    std::ostringstream output;
    output << "{\"plane\":" << static_cast<int>(scan->plane) << ",\"cells\":[";
    for (std::size_t index = 0; index < scan->cells.size(); ++index) {
        if (index != 0) output << ',';
        const auto &cell = scan->cells[index];
        output << "{\"dx\":" << static_cast<int>(cell.dx)
               << ",\"dy\":" << static_cast<int>(cell.dy)
               << ",\"x\":" << static_cast<int>(cell.x)
               << ",\"y\":" << static_cast<int>(cell.y)
               << ",\"in_bounds\":" << (cell.in_bounds ? "true" : "false")
               << ",\"obstacle\":" << (cell.obstacle ? "true" : "false")
               << ",\"enemy_present\":" << (cell.enemy_present ? "true" : "false") << '}';
    }
    output << "]}";
    return output.str();
}

std::string replay_event_json(const arena::engine::ReplayEvent &event) {
    std::ostringstream output;
    output << "{\"seq\":" << event.sequence
           << ",\"type\":" << json_escape(event.type == arena::engine::EventType::MatchStarted
                                                    ? "MATCH_STARTED"
                                                    : event.type == arena::engine::EventType::ActionResolved
                                                          ? "ACTION_RESOLVED"
                                                          : "MATCH_ENDED")
           << ",\"round\":" << static_cast<int>(event.round)
           << ",\"action_index\":" << static_cast<int>(event.action_index)
           << ",\"side\":" << json_escape(side_name(event.side))
           << ",\"action\":" << action_json(event.action)
           << ",\"effect\":" << json_escape(arena::engine::to_string(event.effect))
           << ",\"projectile_path\":[";
    for (std::size_t index = 0; index < event.projectile_path.size(); ++index) {
        if (index != 0) output << ',';
        output << cell_json(event.projectile_path[index]);
    }
    output << "]"
           << ",\"scan\":" << scan_json(event.scan)
           << ",\"state_after\":" << state_json(event.state_after)
           << ",\"state_hash\":" << json_escape(event.state_hash)
           << ",\"winner\":" << json_escape(arena::engine::to_string(event.winner))
           << ",\"end_reason\":" << json_escape(arena::engine::to_string(event.end_reason))
           << '}';
    return output.str();
}

std::string replay_json(const arena::engine::ReplayLog &log,
                        const arena::engine::GameState &final_state) {
    std::ostringstream output;
    output << "{\"ok\":true,\"map_seed\":" << json_escape(std::to_string(log.map_seed))
           << ",\"map\":{\"width\":4,\"height\":4,\"planes\":2,\"obstacles\":[";
    for (std::size_t index = 0; index < log.map.obstacles().size(); ++index) {
        if (index != 0) output << ',';
        output << cell_json(log.map.obstacles()[index]);
    }
    output << "]},\"initial_state\":" << state_json(log.events.front().state_after)
           << ",\"events\":[";
    for (std::size_t index = 0; index < log.events.size(); ++index) {
        if (index != 0) output << ',';
        output << replay_event_json(log.events[index]);
    }
    output << "],\"winner\":" << json_escape(arena::engine::to_string(final_state.winner))
           << ",\"result\":" << json_escape(arena::engine::to_string(final_state.end_reason))
           << '}';
    return output.str();
}

int run_demo(const char *red_path, const char *blue_path,
             std::optional<arena::engine::Winner> required_winner = std::nullopt,
             std::uint64_t map_seed = 123456789, bool emit_json = false) {
    validate_runner_path(red_path);
    validate_runner_path(blue_path);
    RunnerProcess red(red_path);
    RunnerProcess blue(blue_path);
    const auto send_start = [](RunnerProcess &process, arena::Side side,
                               const arena::engine::DroneState &drone) {
        arena::runner::StartMessage start{
            {side, to_sdk_drone(drone), 4, 4, 20, 3},
        };
        process.send(arena::runner::encode_start(start));
        expect_line(process.receive(), arena::runner::encode_ready());
    };

    arena::engine::Match match = required_winner.has_value()
                                     ? arena::engine::Match(qualification_map())
                                     : arena::engine::Match(map_seed);
    send_start(red, arena::Side::Red, match.state().red);
    send_start(blue, arena::Side::Blue, match.state().blue);

    std::array<PreviousAction, 2> previous;
    while (!match.state().finished) {
        const auto side_index = match.state().active_side == arena::Side::Red ? 0U : 1U;
        RunnerProcess &process = side_index == 0U ? red : blue;
        arena::Observation observation = make_observation(match.state(), previous[side_index]);
        process.send(arena::runner::encode_observation(observation));

        arena::Action action{};
        const std::string response = process.receive();
        if (!arena::runner::decode_action(response, action)) {
            throw std::runtime_error("runner returned an error: " + response);
        }
        const arena::engine::ActionOutcome outcome = match.apply(action);
        previous[side_index].result = arena::ActionResult{outcome.effect};
        previous[side_index].scan = outcome.scan;
    }

    red.send(std::string(arena::runner::kProtocolName) + " SHUTDOWN");
    blue.send(std::string(arena::runner::kProtocolName) + " SHUTDOWN");
    expect_line(red.receive(), arena::runner::encode_bye());
    expect_line(blue.receive(), arena::runner::encode_bye());
    if (!match.state().finished) {
        return 1;
    }
    if (required_winner.has_value() && match.state().winner != *required_winner) {
        return 2;
    }
    if (emit_json) {
        std::cout << replay_json(match.replay_log(), match.state()) << '\n';
    }
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    if (argc >= 2 && std::string(argv[1]) == "--json") {
        std::uint64_t seed = 123456789;
        int index = 2;
        if (index + 1 < argc && std::string(argv[index]) == "--seed") {
            try {
                seed = std::stoull(argv[index + 1]);
            } catch (...) {
                std::cerr << "invalid seed\n";
                return 64;
            }
            index += 2;
        }
        if (argc - index != 2) {
            std::cerr << "usage: arena_match_demo --json [--seed N] red-runner blue-runner\n";
            return 64;
        }
        try {
            return run_demo(argv[index], argv[index + 1], std::nullopt, seed, true);
        } catch (const std::exception &error) {
            std::cout << "{\"ok\":false,\"failure_reason\":\"RUNNER_ERROR\",\"error\":"
                      << json_escape(error.what()) << "}\n";
            return 1;
        }
    }
    if (argc != 2 && argc != 3 && argc != 4) {
        std::cerr << "usage: arena_match_demo /path/to/arena_runner\n"
                     "       arena_match_demo red-runner blue-runner\n"
                     "       arena_match_demo --qualify-red candidate baseline\n"
                     "       arena_match_demo --qualify-blue baseline candidate\n";
        return 64;
    }
    try {
        if (argc == 2) {
            return run_demo(argv[1], argv[1]);
        }
        if (argc == 3) {
            return run_demo(argv[1], argv[2]);
        }
        if (std::string(argv[1]) == "--qualify-red") {
            return run_demo(argv[2], argv[3], arena::engine::Winner::Red);
        }
        if (std::string(argv[1]) == "--qualify-blue") {
            return run_demo(argv[2], argv[3], arena::engine::Winner::Blue);
        }
        return 64;
    } catch (const std::exception &error) {
        std::cerr << "match demo failed: " << error.what() << '\n';
        return 1;
    }
}
