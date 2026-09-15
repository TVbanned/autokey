alter table public.keyflow_activity_questions
  alter column weight set default 50;

update public.keyflow_activity_questions
set weight = 50
where weight = 0;
