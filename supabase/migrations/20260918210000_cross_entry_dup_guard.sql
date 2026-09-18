-- 跨入口重复入库兜底触发器（2026-09-18）
--
-- 背景：库层只有「同表」唯一索引
--   keyflow_daily_submissions(answerer_id, article_url)
--   keyflow_comprehensive_submissions(answerer_id, activity_id, article_url)
--   keyflow_deliveries(application_id, article_url)
-- 同一条知乎内容「既进日常、又进综合活动投稿/测评交付」这种跨表重复，库层拦不住；
-- 前端三个入口（今日投稿 / 综合活动投稿框 / 申领页交付）互查只覆盖界面，
-- 后台手工录入、脚本回写、腾讯文档同步仍可能造出重复行 —— 而重复行就是多一份 40 经验。
-- 9/18 实测清出两组历史重复：17 组按链接精确匹配 + 5 组同稿不同链接写法，共 22 行、回收 880 经验。
--
-- 判断口径：先折算成「内容 key」再比，同一篇回答/专栏文章 = 同一个 key
--   answer:<回答ID>   ← /answer/123、/answers/123
--   article:<文章ID>  ← zhihu.com/p/123
--   url:<规范化链接>  ← 其余情况：去 #/? 后缀、去尾斜杠、补 www
-- （只比链接文本会漏：` https://…` 前导空格、`…#write`、`…#comment-123`、短链 `zhihu.com/answer/<id>`）
--
-- 规则：
--   · 同答主 + 同内容 key 已存在于三张表任意一张 → 直接拒绝；
--   · 报错码用 23505（unique_violation），前端已有分支会渲染成
--     「该链接此前已投过稿，未重复入库」，不会把数据库红字丢给答主；
--   · answerer_id 为空的行（运营「日常问题运营」粘贴回答用）直接放行；
--   · 对同一个「答主 + 内容 key」取事务级咨询锁，避免连点/并发插入两条同时通过检查。
--
-- 应急放行：会话里 `set local keyflow.allow_duplicate_submission = 'on';` 后插入即可跳过本触发器
--   （注意：同表同链接的重复仍会被上面的唯一索引拦）。
--
-- 自检：codex-trae-sync/db-20260918-cross-entry-dup-guard-test.sql（7 项，全在事务里，跑完 rollback）
-- 回滚：drop function public.keyflow_guard_cross_entry_duplicate();
--       drop function public.keyflow_zhihu_content_key(text);
--       drop trigger trg_guard_cross_entry_duplicate_daily / _comp / _deliv;

create or replace function public.keyflow_zhihu_content_key(p_url text)
returns text
language sql
immutable
as $$
  with t as (
    select regexp_replace(
             regexp_replace(btrim(coalesce(p_url, '')), '[?#].*$', ''),
             '/+$', ''
           ) as u
  )
  select case
    when u = '' then null
    when u ~ '/answers?/[0-9]+' then 'answer:' || substring(u from '/answers?/([0-9]+)')
    when u ~ 'zhihu\.com/p/[0-9]+' then 'article:' || substring(u from 'zhihu\.com/p/([0-9]+)')
    else 'url:' || regexp_replace(u, '^https?://zhihu\.com/', 'https://www.zhihu.com/')
  end
  from t;
$$;

create or replace function public.keyflow_guard_cross_entry_duplicate()
returns trigger
language plpgsql
security definer
set search_path to public
as $$
declare
  v_answerer uuid;
  v_url text;
  v_key text;
  v_src text;
begin
  if coalesce(current_setting('keyflow.allow_duplicate_submission', true), '') = 'on' then
    return new;
  end if;

  if tg_table_name = 'keyflow_deliveries' then
    v_url := new.article_url;
    select ap.answerer_id into v_answerer
      from public.keyflow_applications ap
     where ap.id = new.application_id;
  else
    v_answerer := new.answerer_id;
    v_url := new.article_url;
  end if;

  v_key := public.keyflow_zhihu_content_key(v_url);
  if v_answerer is null or v_key is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_answerer::text || '|' || v_key, 0));

  select '日常投稿' into v_src
    from public.keyflow_daily_submissions s
   where s.answerer_id = v_answerer
     and public.keyflow_zhihu_content_key(s.article_url) = v_key
     and (tg_table_name <> 'keyflow_daily_submissions' or s.id is distinct from new.id)
   limit 1;

  if v_src is null then
    select '综合活动投稿' into v_src
      from public.keyflow_comprehensive_submissions s
     where s.answerer_id = v_answerer
       and public.keyflow_zhihu_content_key(s.article_url) = v_key
       and (tg_table_name <> 'keyflow_comprehensive_submissions' or s.id is distinct from new.id)
     limit 1;
  end if;

  if v_src is null then
    select '活动交付' into v_src
      from public.keyflow_deliveries d
      join public.keyflow_applications ap on ap.id = d.application_id
     where ap.answerer_id = v_answerer
       and public.keyflow_zhihu_content_key(d.article_url) = v_key
       and (tg_table_name <> 'keyflow_deliveries' or d.id is distinct from new.id)
     limit 1;
  end if;

  if v_src is not null then
    raise exception '这条链接已在「%」提交过，未重复入库', v_src using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_cross_entry_duplicate_daily on public.keyflow_daily_submissions;
create trigger trg_guard_cross_entry_duplicate_daily
  before insert or update of article_url on public.keyflow_daily_submissions
  for each row execute function public.keyflow_guard_cross_entry_duplicate();

drop trigger if exists trg_guard_cross_entry_duplicate_comp on public.keyflow_comprehensive_submissions;
create trigger trg_guard_cross_entry_duplicate_comp
  before insert or update of article_url on public.keyflow_comprehensive_submissions
  for each row execute function public.keyflow_guard_cross_entry_duplicate();

drop trigger if exists trg_guard_cross_entry_duplicate_deliv on public.keyflow_deliveries;
create trigger trg_guard_cross_entry_duplicate_deliv
  before insert or update of article_url on public.keyflow_deliveries
  for each row execute function public.keyflow_guard_cross_entry_duplicate();
