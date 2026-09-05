-- WORKBENCH DELTA (see VENDORED.md, CL-4455): per-minute CAS for the hub's
-- native ScheduleTrigger poller. Text stores String(minuteKey(at)). Null =
-- never claimed. Not part of wire_hash.
ALTER TABLE "workflow_definition" ADD COLUMN "schedule_claimed_minute" text;
