#include "arena/engine.hpp"
#include "arena/runner_protocol.hpp"

#include <array>
#include <cerrno>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {

class RunnerProcess {
  public:
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

int run_demo(const char *red_path, const char *blue_path,
             std::optional<arena::engine::Winner> required_winner = std::nullopt) {
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
                                     : arena::engine::Match(123456789);
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
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 2 && argc != 4) {
        std::cerr << "usage: arena_match_demo /path/to/arena_runner\n"
                     "       arena_match_demo --qualify-red candidate baseline\n"
                     "       arena_match_demo --qualify-blue baseline candidate\n";
        return 64;
    }
    try {
        if (argc == 2) {
            return run_demo(argv[1], argv[1]);
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
