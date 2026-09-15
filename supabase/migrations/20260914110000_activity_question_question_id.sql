alter table public.keyflow_activity_questions
  add column if not exists question_id text;

create index if not exists keyflow_activity_questions_question_id_idx
  on public.keyflow_activity_questions (activity_id, question_id);
