-- 金币商城：神秘海域 3D 交互测试卡
update public.keyflow_reward_catalog
set
  category = 'game',
  image_url = 'https://shared.steamstatic.com/store_item_assets/steam/apps/1659420/header.jpg',
  description = '3D 悬浮测试卡：兑换码由运营通过站内信发货。',
  cost_coins = 3600,
  min_level = 4,
  fulfillment_type = 'virtual',
  stock_total = 5,
  stock_left = 5,
  status = 'on',
  sort_order = 101
where title = '《神秘海域》兑换码';

insert into public.keyflow_reward_catalog
  (title, category, image_url, description, cost_coins, min_level, fulfillment_type, stock_total, stock_left, status, sort_order)
select
  '《神秘海域》兑换码',
  'game',
  'https://shared.steamstatic.com/store_item_assets/steam/apps/1659420/header.jpg',
  '3D 悬浮测试卡：兑换码由运营通过站内信发货。',
  3600,
  4,
  'virtual',
  5,
  5,
  'on',
  101
where not exists (
  select 1 from public.keyflow_reward_catalog
  where title = '《神秘海域》兑换码'
);
