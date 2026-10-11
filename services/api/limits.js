'use strict';

// Keep resource limits in one place so the API, workers and database queries
// apply the same retention and artifact policy.
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_COMPILED_BYTES = 32 * 1024 * 1024;
// Historical versions exclude the one currently published on the leaderboard.
// The database therefore retains up to 10 history rows plus the current row.
const MAX_SUBMISSION_HISTORY = 10;

module.exports = {
  MAX_SOURCE_BYTES,
  MAX_COMPILED_BYTES,
  MAX_SUBMISSION_HISTORY,
};
