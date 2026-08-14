-- 将现有 Supabase Auth 管理员账号授予后台管理员角色。
insert into public.keyflow_user_roles (user_id, role)
select id, 'admin'
from auth.users
where lower(email) = 'natease2017@gmail.com'
on conflict (user_id) do update set role = excluded.role;

-- 防止邮箱尚未创建时静默成功。
do $$
begin
  if not exists (
    select 1
    from public.keyflow_user_roles r
    join auth.users u on u.id = r.user_id
    where lower(u.email) = 'natease2017@gmail.com'
      and r.role = 'admin'
  ) then
    raise exception '未找到已创建的 Auth 管理员账号 natease2017@gmail.com';
  end if;
end;
$$;
