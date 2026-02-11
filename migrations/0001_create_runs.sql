-- Tracks active and historical screenshot runs, one per PR at a time.
CREATE TABLE
  runs (
    id TEXT PRIMARY KEY, -- sandbox ID
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | cancelled | failed
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime ('now'))
  );

-- Fast lookup for the active run on a given PR
CREATE INDEX idx_runs_pr_status ON runs (owner, repo, pr_number, status);