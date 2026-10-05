#pragma once

namespace arena::runner {

// Install the post-start sandbox used by an algorithm runner.
// Returns false when the current platform cannot install the policy.
[[nodiscard]] bool install_algorithm_seccomp();

} // namespace arena::runner
