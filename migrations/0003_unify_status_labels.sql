UPDATE runs SET status = 'complete' WHERE status = 'completed';
UPDATE runs SET status = 'errored' WHERE status = 'failed';
UPDATE runs SET status = 'terminated' WHERE status = 'cancelled';
