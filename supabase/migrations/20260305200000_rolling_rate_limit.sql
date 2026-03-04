-- Switch oracle_queries from calendar-day reset to rolling 24h window per user.
-- Each user gets their own reset time based on when their window started.

DROP TABLE oracle_queries;

CREATE TABLE oracle_queries (
  user_id      uuid        NOT NULL REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  count        integer     NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now()
);
