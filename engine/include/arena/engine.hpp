#pragma once

#include <cstdint>

namespace arena::engine {

inline constexpr std::int8_t kMapWidth = 4;
inline constexpr std::int8_t kMapHeight = 4;
inline constexpr std::int8_t kPlaneCount = 2;
inline constexpr std::int8_t kObstacleCount = 4;
inline constexpr std::int8_t kMaxRounds = 20;
inline constexpr std::int8_t kActionsPerTurn = 3;
inline constexpr std::int8_t kProjectileRange = 3;

} // namespace arena::engine
