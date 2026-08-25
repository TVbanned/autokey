-- 为阿里云媒体上传接口发放每位答主独立令牌。
alter table public.keyflow_answerers
  add column if not exists media_upload_token text not null default encode(extensions.gen_random_bytes(32), 'hex');

update public.keyflow_answerers
set media_upload_token = encode(extensions.gen_random_bytes(32), 'hex')
where media_upload_token is null or media_upload_token = '';

create or replace function public.keyflow_login_answerer(
  p_zhihu_name text,
  p_password text
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_answerer record;
begin
  select id, zhihu_name, account_address, avatar_url, serial_number, media_upload_token, created_at
  into v_answerer
  from keyflow_answerers
  where zhihu_name = p_zhihu_name
    and password_hash = crypt(p_password, password_hash);

  if v_answerer.id is null then
    raise exception '知乎用户名或密码错误';
  end if;

  return row_to_json(v_answerer);
end;
$$;

grant execute on function public.keyflow_login_answerer(text, text) to anon, authenticated;

create or replace function public.keyflow_validate_media_upload_token(p_token text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id
  from public.keyflow_answerers
  where media_upload_token = p_token
  limit 1;
$$;

grant execute on function public.keyflow_validate_media_upload_token(text) to anon, authenticated;