-- CQA: схема хранилища. Идемпотентна: можно применять повторно.

CREATE TABLE IF NOT EXISTS users (
  id          serial PRIMARY KEY,
  login       text UNIQUE NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('qa','op','lead','head','dir','comp','adm')),
  team        text,
  pw_hash     text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);

-- Чек-лист — это данные: каждая версия хранит полный список критериев
CREATE TABLE IF NOT EXISTS checklists (
  id           serial PRIMARY KEY,
  slug         text NOT NULL,
  name         text NOT NULL,
  channel      text NOT NULL,
  version      int  NOT NULL,
  status       text NOT NULL CHECK (status IN ('draft','published','archived')),
  criteria     jsonb NOT NULL,
  note         text,
  created_by   int REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_by int REFERENCES users(id),
  published_at timestamptz,
  UNIQUE (slug, version)
);

CREATE TABLE IF NOT EXISTS dialogs (
  id           text PRIMARY KEY,
  channel      text NOT NULL,
  language     text NOT NULL,
  transcript   jsonb NOT NULL,
  audio_url    text,
  operator     text NOT NULL,
  team         text NOT NULL,
  source       text NOT NULL,             -- dev | upload | text
  wf_status    text NOT NULL DEFAULT 'new' -- new evaluating error review published acknowledged appeal revised
               CHECK (wf_status IN ('new','evaluating','error','review','published','acknowledged','appeal','revised')),
  viol_status  text NOT NULL DEFAULT 'new' CHECK (viol_status IN ('new','work','closed')),
  viol_note    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
  id            serial PRIMARY KEY,
  dialog_id     text NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
  checklist_id  int  NOT NULL REFERENCES checklists(id),
  model         text NOT NULL,
  prompt_hash   text NOT NULL,
  trigger       text NOT NULL,            -- initial | rescore | recalc | override | appeal | import
  status        text NOT NULL CHECK (status IN ('running','done','partial')),
  is_current    boolean NOT NULL DEFAULT false,
  total         numeric(6,2),
  critical      boolean NOT NULL DEFAULT false,
  review        jsonb NOT NULL DEFAULT '[]', -- причины, по которым нужен человек
  calls         int NOT NULL DEFAULT 0,
  cost          numeric(10,5) NOT NULL DEFAULT 0,
  seconds       numeric(8,2),
  created_by    int REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  job_id        int
);
CREATE INDEX IF NOT EXISTS evaluations_dialog ON evaluations(dialog_id, is_current);

CREATE TABLE IF NOT EXISTS eval_items (
  eval_id      int  NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  crit_id      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending','ok','error')),
  source       text,                      -- model | reused | qa | appeal
  answer       text,                      -- итоговый ответ (с учётом решения человека)
  ai_answer    text,                      -- что сказала модель
  confidence   real,
  evidence     jsonb NOT NULL DEFAULT '[]', -- номера реплик с 1
  explanation  text,
  conditions   jsonb,
  sem_hash     text,                      -- отпечаток смысла критерия (без веса)
  error        text,
  flags        jsonb NOT NULL DEFAULT '[]', -- low_conf | no_evidence | invalid | bad_evidence
  override_by     int REFERENCES users(id),
  override_reason text,
  override_at     timestamptz,
  PRIMARY KEY (eval_id, crit_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          serial PRIMARY KEY,
  title       text NOT NULL,
  kind        text NOT NULL,              -- evaluate | rescore
  dialog_ids  jsonb NOT NULL,
  only_crit   jsonb,                      -- для переоценки: какие критерии
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS appeals (
  id           serial PRIMARY KEY,
  dialog_id    text NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
  eval_id      int NOT NULL REFERENCES evaluations(id),
  operator_id  int NOT NULL REFERENCES users(id),
  text         text NOT NULL,
  items        jsonb NOT NULL,            -- [{crit, from, want, accepted}]
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','partial','rejected','withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_by   int REFERENCES users(id),
  decided_at   timestamptz,
  comment      text,
  score_before numeric(6,2),
  score_after  numeric(6,2)
);

CREATE TABLE IF NOT EXISTS events (
  id         serial PRIMARY KEY,
  dialog_id  text NOT NULL REFERENCES dialogs(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    int REFERENCES users(id),
  text       text NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id        serial PRIMARY KEY,
  user_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text      text NOT NULL,
  link      text,
  at        timestamptz NOT NULL DEFAULT now(),
  read      boolean NOT NULL DEFAULT false
);

-- Журнал только дописывается
CREATE TABLE IF NOT EXISTS audit (
  id       serial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  int REFERENCES users(id),
  action   text NOT NULL,
  object   text,
  details  jsonb
);

CREATE TABLE IF NOT EXISTS gold (
  dialog_id text NOT NULL,
  crit_id   text NOT NULL,
  answer    text,
  unsure    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (dialog_id, crit_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Legacy accounts retain identity/history, but require administrator reactivation.
-- No unscoped director is silently granted access to a team.
UPDATE users SET role=CASE WHEN role='dir' THEN 'lead' ELSE 'qa' END,
                 active=false WHERE role IN ('head','dir','comp');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('qa','op','lead','adm'));

CREATE TABLE IF NOT EXISTS development_tasks (
 id serial PRIMARY KEY,
 dialog_id text NOT NULL REFERENCES dialogs(id),
 operator_id int NOT NULL REFERENCES users(id),
 created_by int NOT NULL REFERENCES users(id),
 request_key uuid NOT NULL,
 instruction text NOT NULL,
 status text NOT NULL DEFAULT 'assigned' CHECK(status IN ('assigned','submitted','completed')),
 response text,
 feedback text,
 created_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz,
 reviewed_at timestamptz,
 UNIQUE(created_by, request_key)
);

CREATE TABLE IF NOT EXISTS dynamics_sync (
 id serial PRIMARY KEY,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 status text NOT NULL DEFAULT 'running',
 imported int NOT NULL DEFAULT 0,
 skipped int NOT NULL DEFAULT 0,
 error text
);
CREATE TABLE IF NOT EXISTS external_dialogs (
 source text NOT NULL,
 external_id text NOT NULL,
 dialog_id text NOT NULL UNIQUE REFERENCES dialogs(id),
 PRIMARY KEY(source,external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_current_evaluation ON evaluations(dialog_id) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_appeal ON appeals(dialog_id) WHERE status='open';

ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false;
-- Only known visible versions are backfilled; unpublished historical drafts remain private.
UPDATE evaluations e SET published=true
WHERE NOT published AND (
 (is_current AND EXISTS (SELECT 1 FROM dialogs d WHERE d.id=e.dialog_id AND d.wf_status IN ('published','acknowledged','revised','appeal')))
 OR EXISTS (SELECT 1 FROM appeals ap WHERE ap.eval_id=e.id)
);

CREATE TABLE IF NOT EXISTS development_events (
 id serial PRIMARY KEY,
 task_id int NOT NULL REFERENCES development_tasks(id),
 user_id int NOT NULL REFERENCES users(id),
 action text NOT NULL,
 text text NOT NULL,
 at timestamptz NOT NULL DEFAULT now()
);
