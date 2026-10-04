#pragma once

#include "arena/api.hpp"

#include <string>
#include <string_view>

namespace arena::runner {

inline constexpr std::string_view kProtocolName = "ARENA_RUNNER";

struct StartMessage {
    MatchStart match_start{};
};

[[nodiscard]] std::string encode_start(const StartMessage &message);
[[nodiscard]] bool decode_start(std::string_view line, StartMessage &message);

[[nodiscard]] std::string encode_observation(const Observation &observation);
[[nodiscard]] bool decode_observation(std::string_view line, Observation &observation);

[[nodiscard]] std::string encode_action(const Action &action);
[[nodiscard]] bool decode_action(std::string_view line, Action &action);

[[nodiscard]] std::string encode_ready();
[[nodiscard]] std::string encode_error(std::string_view code);
[[nodiscard]] std::string encode_bye();

} // namespace arena::runner
