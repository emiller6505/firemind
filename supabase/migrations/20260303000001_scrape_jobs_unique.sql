-- Prevent duplicate scrape_jobs for the same source URL.
-- App-level dedup (getAlreadyScrapedUrls) is best-effort; this enforces at DB level.
create unique index if not exists idx_scrape_jobs_source_url
  on scrape_jobs (source, source_url)
  where source_url is not null;
