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
