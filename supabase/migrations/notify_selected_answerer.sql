-- 答主入选活动后自动发送私信通知
create or replace function public.keyflow_notify_selected_answerer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_activity_title text;
  v_game_name text;
begin
  if new.status = 'selected'
    and old.status is distinct from 'selected'
    and new.answerer_id is not null then
    select title, game_name into v_activity_title, v_game_name
    from public.keyflow_activities
    where id = new.activity_id;

    insert into public.keyflow_inbox (type, title, body, to_id, status, data)
    values (
      'private_message',
      '活动报名已通过',
      '恭喜你已入选「' || coalesce(v_game_name, v_activity_title, '活动') || '」活动，请前往答主看板查看并申领 Key。',
      new.answerer_id,
      'unread',
      jsonb_build_object('application_id', new.id, 'activity_id', new.activity_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_selected_answerer on public.keyflow_applications;
create trigger trg_notify_selected_answerer
  after update of status on public.keyflow_applications
  for each row
  execute function public.keyflow_notify_selected_answerer();