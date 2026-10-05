#include "arena/runner_protocol.hpp"
#include "arena/seccomp.hpp"

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include <sys/resource.h>
#include <sys/time.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#include <unistd.h>

extern "C" arena::Player *create_player();

namespace {

using arena::Action;
using arena::ActionType;
using arena::Direction;
using arena::MatchStart;
using arena::Observation;
using arena::runner::StartMessage;

struct Options {
    std::uint64_t act_time_ms = 50;
    std::uint64_t match_time_ms = 10'000;
    std::uint64_t memory_mb = 256;
    std::uint64_t cpu_seconds = 10;
    bool self_test = false;
};

int g_protocol_input_fd = -1;
int g_protocol_output_fd = -1;

[[noreturn]] void timeout_handler(int) {
    _exit(124);
}

bool parse_positive(const char *value, std::uint64_t &result) {
    if (value == nullptr || *value == '\0') {
        return false;
    }
    char *end = nullptr;
    const unsigned long long parsed = std::strtoull(value, &end, 10);
    if (end == value || *end != '\0' || parsed == 0) {
        return false;
    }
    result = parsed;
    return true;
}

bool parse_options(int argc, char **argv, Options &options) {
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument(argv[index]);
        if (argument == "--self-test") {
            options.self_test = true;
            continue;
        }
        if (index + 1 >= argc) {
            return false;
        }
        std::uint64_t value = 0;
        if (argument == "--act-time-ms") {
            if (!parse_positive(argv[++index], value)) {
                return false;
            }
            options.act_time_ms = value;
        } else if (argument == "--match-time-ms") {
            if (!parse_positive(argv[++index], value)) {
                return false;
            }
            options.match_time_ms = value;
        } else if (argument == "--memory-mb") {
            if (!parse_positive(argv[++index], value)) {
                return false;
            }
            options.memory_mb = value;
        } else if (argument == "--cpu-seconds") {
            if (!parse_positive(argv[++index], value)) {
                return false;
            }
            options.cpu_seconds = value;
        } else {
            return false;
        }
    }
    return true;
}

bool set_limit(int resource, rlim_t limit) {
    const struct rlimit value{limit, limit};
    return setrlimit(resource, &value) == 0;
}

bool apply_limits(const Options &options) {
    if (!set_limit(RLIMIT_AS, static_cast<rlim_t>(options.memory_mb) * 1024U * 1024U) ||
        !set_limit(RLIMIT_CPU, static_cast<rlim_t>(options.cpu_seconds)) ||
        !set_limit(RLIMIT_CORE, 0) || !set_limit(RLIMIT_NOFILE, 32)) {
        return false;
    }
#if defined(__linux__)
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        return false;
    }
#endif
    return true;
}

void install_timeout_handler() {
    struct sigaction action{};
    action.sa_handler = timeout_handler;
    sigemptyset(&action.sa_mask);
    action.sa_flags = 0;
    sigaction(SIGALRM, &action, nullptr);
}

void arm_timer(std::uint64_t milliseconds) {
    const std::uint64_t seconds = milliseconds / 1000U;
    const std::uint64_t micros = (milliseconds % 1000U) * 1000U;
    struct itimerval timer{};
    timer.it_value.tv_sec = static_cast<time_t>(seconds);
    timer.it_value.tv_usec = static_cast<suseconds_t>(micros);
    setitimer(ITIMER_REAL, &timer, nullptr);
}

class ActTimer {
  public:
    explicit ActTimer(std::uint64_t milliseconds) {
        arm_timer(milliseconds);
    }

    ~ActTimer() {
        arm_timer(0);
    }

    ActTimer(const ActTimer &) = delete;
    ActTimer &operator=(const ActTimer &) = delete;
};

bool valid_action(const Action &action) {
    const auto type = static_cast<unsigned int>(action.type);
    const auto direction = static_cast<unsigned int>(action.direction);
    return type <= static_cast<unsigned int>(ActionType::Scout) &&
           direction <= static_cast<unsigned int>(Direction::West);
}

bool emit_line(std::string_view line) {
    if (g_protocol_output_fd < 0) {
        return false;
    }
    std::string payload(line);
    payload.push_back('\n');
    std::size_t offset = 0;
    while (offset < payload.size()) {
        const ssize_t written = write(g_protocol_output_fd, payload.data() + offset,
                                      payload.size() - offset);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        if (written <= 0) {
            return false;
        }
        offset += static_cast<std::size_t>(written);
    }
    return true;
}

bool isolate_stdio() {
    g_protocol_input_fd = dup(STDIN_FILENO);
    g_protocol_output_fd = dup(STDOUT_FILENO);
    if (g_protocol_input_fd < 0 || g_protocol_output_fd < 0) {
        return false;
    }
    const int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0) {
        return false;
    }
    const bool redirected = dup2(null_fd, STDIN_FILENO) >= 0 &&
                            dup2(null_fd, STDOUT_FILENO) >= 0 &&
                            dup2(null_fd, STDERR_FILENO) >= 0;
    close(null_fd);
    return redirected;
}

bool read_protocol_line(std::string &line) {
    line.clear();
    char character = '\0';
    while (true) {
        const ssize_t count = read(g_protocol_input_fd, &character, 1);
        if (count == 0) {
            return false;
        }
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (character == '\n') {
            return true;
        }
        line.push_back(character);
    }
}

int self_test(const Options &options) {
    if (!apply_limits(options)) {
        return 70;
    }
    install_timeout_handler();
    arm_timer(options.match_time_ms);
    if (!arena::runner::install_algorithm_seccomp()) {
        emit_line(arena::runner::encode_error("SANDBOX_INSTALL_FAILED"));
        return 70;
    }
    std::unique_ptr<arena::Player> player(create_player());
    if (!player) {
        return 71;
    }
    const MatchStart start{
        arena::Side::Red,
        {0, 0, arena::Plane::Lower, arena::Direction::East, true},
        4,
        4,
        20,
        3,
    };
    try {
        player->on_match_start(start);
    } catch (...) {
        return 72;
    }
    const Observation observation{
        1,
        1,
        arena::Side::Red,
        start.self,
        std::nullopt,
        std::nullopt,
    };
    ActTimer timer(std::min(options.act_time_ms, options.match_time_ms));
    Action action{};
    try {
        action = player->act(observation);
    } catch (...) {
        return 72;
    }
    return valid_action(action) ? 0 : 72;
}

int run_protocol(const Options &options) {
    if (!apply_limits(options)) {
        return 70;
    }
    if (!isolate_stdio()) {
        return 70;
    }
    install_timeout_handler();
    arm_timer(options.match_time_ms);
    if (!arena::runner::install_algorithm_seccomp()) {
        emit_line(arena::runner::encode_error("SANDBOX_INSTALL_FAILED"));
        return 70;
    }
    const auto match_deadline = std::chrono::steady_clock::now() +
                                std::chrono::milliseconds(options.match_time_ms);

    const auto remaining_match_ms = [&]() -> std::uint64_t {
        const auto now = std::chrono::steady_clock::now();
        if (now >= match_deadline) {
            _exit(124);
        }
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            match_deadline - now);
        return std::max<std::uint64_t>(1, static_cast<std::uint64_t>(remaining.count()));
    };

    std::unique_ptr<arena::Player> player(create_player());
    if (!player) {
        emit_line(arena::runner::encode_error("CREATE_PLAYER_FAILED"));
        return 71;
    }

    bool started = false;
    std::string line;
    while (read_protocol_line(line)) {
        if (!started) {
            StartMessage message;
            if (!arena::runner::decode_start(line, message)) {
                emit_line(arena::runner::encode_error("START_PROTOCOL"));
                return 2;
            }
            try {
                player->on_match_start(message.match_start);
            } catch (...) {
                emit_line(arena::runner::encode_error("BOT_EXCEPTION"));
                return 72;
            }
            started = true;
            if (!emit_line(arena::runner::encode_ready())) {
                return 3;
            }
            continue;
        }

        if (line == std::string(arena::runner::kProtocolName) + " SHUTDOWN") {
            emit_line(arena::runner::encode_bye());
            return 0;
        }

        Observation observation;
        if (!arena::runner::decode_observation(line, observation)) {
            emit_line(arena::runner::encode_error("ACT_PROTOCOL"));
            return 2;
        }

        Action action{};
        try {
            ActTimer timer(std::min(options.act_time_ms, remaining_match_ms()));
            action = player->act(observation);
        } catch (...) {
            emit_line(arena::runner::encode_error("BOT_EXCEPTION"));
            return 72;
        }
        arm_timer(remaining_match_ms());

        if (!valid_action(action)) {
            emit_line(arena::runner::encode_error("INVALID_ACTION"));
            return 73;
        }
        if (!emit_line(arena::runner::encode_action(action))) {
            return 3;
        }
    }

    return started ? 0 : 2;
}

} // namespace

int main(int argc, char **argv) {
    Options options;
    if (!parse_options(argc, argv, options)) {
        std::cerr << "usage: arena_runner [--self-test] [--act-time-ms N] [--match-time-ms N] "
                     "[--memory-mb N] [--cpu-seconds N]\n";
        return 64;
    }
    return options.self_test ? self_test(options) : run_protocol(options);
}
