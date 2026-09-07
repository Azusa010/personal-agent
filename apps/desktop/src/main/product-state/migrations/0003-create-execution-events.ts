import { Migration } from './0001-create-tasks'

const EVENTS_DDL = `
  CREATE TABLE execution_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  )
`

const EVENTS_INDEX_DDL = `
  CREATE INDEX idx_execution_events_task_seq ON execution_events (task_id, seq)
`

const EVENT_TRIGGERS_DDL = `
  CREATE TRIGGER execution_events_no_update
  BEFORE UPDATE ON execution_events
  BEGIN
    SELECT RAISE(ABORT, 'execution_events is append-only');
  END;

  CREATE TRIGGER execution_events_no_delete
  BEFORE DELETE ON execution_events
  BEGIN
    SELECT RAISE(ABORT, 'execution_events is append-only');
  END;
`
export const M0003_CREATE_EXECUTION_EVENTS: Migration = {
  version: 3,
  name: 'create-execution-events',
  up: (db) => {
    db.exec(EVENTS_DDL)
    db.exec(EVENTS_INDEX_DDL)
    db.exec(EVENT_TRIGGERS_DDL)
  }
}
