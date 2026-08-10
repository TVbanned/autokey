-- 同一答主对同一活动只保留最早的无关联报名，清理重复点击产生的空记录。
with ranked as (
  select app.id,
         row_number() over (
           partition by app.activity_id, app.answerer_id
           order by app.submitted_at, app.id
         ) as row_num
  from public.keyflow_applications app
  where app.answerer_id is not null
), removable as (
  select ranked.id
  from ranked
  where ranked.row_num > 1
    and not exists (select 1 from public.keyflow_keys key where key.application_id = ranked.id)
    and not exists (select 1 from public.keyflow_deliveries delivery where delivery.application_id = ranked.id)
)
delete from public.keyflow_applications app
using removable
where app.id = removable.id;

alter table public.keyflow_applications
add constraint keyflow_applications_activity_answerer_key unique (activity_id, answerer_id);
