-- 金币商城：预置《骑马与砍杀》兑换码虚拟商品
update public.keyflow_reward_catalog
set
  category = 'game',
  image_url = 'https://shared.steamstatic.com/store_item_assets/steam/apps/48700/header.jpg',
  description = '演示虚拟商品：兑换码由运营通过站内信发货，可用于兑换《骑马与砍杀》游戏。',
  cost_coins = 2000,
  min_level = 3,
  fulfillment_type = 'virtual',
  stock_total = 3,
  stock_left = 3,
  status = 'on',
  sort_order = 100
where title = '《骑马与砍杀》兑换码';

insert into public.keyflow_reward_catalog
  (title, category, image_url, description, cost_coins, min_level, fulfillment_type, stock_total, stock_left, status, sort_order)
select
  '《骑马与砍杀》兑换码',
  'game',
  'https://shared.steamstatic.com/store_item_assets/steam/apps/48700/header.jpg',
  '演示虚拟商品：兑换码由运营通过站内信发货，可用于兑换《骑马与砍杀》游戏。',
  2000,
  3,
  'virtual',
  3,
  3,
  'on',
  100
where not exists (
  select 1 from public.keyflow_reward_catalog
  where title = '《骑马与砍杀》兑换码'
);
