// 「薅羊毛」聚合逻辑本地校验：直接跑 Edge Function 里的纯逻辑（Node 24 原生支持 import .ts）。
// 用法：node scripts/deals-check.mjs
import { buildDeals, parseUsStyleUtcDate } from '../supabase/functions/deals/aggregate.ts'

const now = Date.now()
const payload = await buildDeals()
const failures = []

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  OK   ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—')

console.log(`\n更新时间 ${payload.updatedAt} | Epic ${payload.counts.epic} | Steam ${payload.counts.steam} | 其它 ${payload.counts.other}`)
console.log(`主机特惠 ${payload.counts.console}（Xbox ${payload.consoles?.xbox?.length || 0} / 任天堂 ${payload.consoles?.nintendo?.length || 0}）`)
if (payload.errors.length) console.log('抓取告警：', payload.errors)

console.log('\n【Epic 喜加一 · 进行中】')
for (const item of payload.epic.current) {
  console.log(`  ${item.title} | 原价 ${item.worth || '—'} | 截止 ${fmt(item.endAt)} | ${item.url}`)
}
console.log('【Epic 喜加一 · 即将开始】')
for (const item of payload.epic.upcoming) {
  console.log(`  ${item.title} | 原价 ${item.worth || '—'} | 开始 ${fmt(item.startAt)}`)
}

console.log('\n【Steam 限时折扣】')
for (const item of payload.steam) {
  console.log(`  -${item.discount}% ${item.title} | ${item.priceOriginalText || '—'} → ${item.priceFinalText || '—'} | ${item.url}`)
}

console.log('\n【其它平台福利】')
for (const item of payload.other) {
  console.log(`  [${item.type}] ${item.title} | ${item.platforms} | ${item.worth || '—'} | 截止 ${fmt(item.endAt)}`)
}

const fx = payload.fx
const xboxRegions = payload.consoles?.xbox || []
const nintendoRegions = payload.consoles?.nintendo || []
const xboxDeals = xboxRegions.flatMap((block) => block.items)
const nintendoDeals = nintendoRegions.flatMap((block) => block.items)

console.log('\n【汇率】')
console.log(fx
  ? `  基准 ${fx.base} | 更新于 ${fmt(fx.updatedAt)} | 来源 ${fx.source} | 1 HKD=¥${fx.rateToCny.HKD} 1 JPY=¥${fx.rateToCny.JPY} 1 BRL=¥${fx.rateToCny.BRL} 1 TWD=¥${fx.rateToCny.TWD}`
  : '  ⚠️ 没有拿到汇率')

const money = (cny, original, currency) => (cny == null ? `${currency} ${original}` : `¥${cny}（${currency} ${original}）`)

console.log('\n【主机特惠 · Xbox】')
for (const block of xboxRegions) {
  console.log(`  ── ${block.label}（${block.currency}${block.rate ? `，1 ${block.currency}=¥${block.rate}` : ''}）${block.items.length} 条`)
  for (const item of block.items.slice(0, 3)) {
    console.log(`     -${item.off}% ${item.title} | ${money(item.priceSaleCny, item.priceSale, item.currency)} | 截止 ${fmt(item.endAt)}`)
  }
}
console.log('【主机特惠 · 任天堂 eShop】')
for (const block of nintendoRegions) {
  console.log(`  ── ${block.label}（${block.currency}${block.rate ? `，1 ${block.currency}=¥${block.rate}` : ''}）${block.items.length} 条`)
  for (const item of block.items.slice(0, 3)) {
    console.log(`     -${item.off}% ${item.title} | ${money(item.priceSaleCny, item.priceSale, item.currency)}`)
  }
}

// 封面 URL 真的能打开吗（过去踩过：CDN 前缀缺失导致整块破图）
const imageProbe = async (url) => {
  try {
    const response = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'GameJourney-Deals/1.0' } })
    return `${response.status} ${response.headers.get('content-type')}`
  } catch (error) {
    return `ERR ${error.message}`
  }
}

console.log('\n【断言】')
check('payload.success 为 true', payload.success === true)
check('Epic 进行中 ≥ 1 条', payload.epic.current.length >= 1, `实际 ${payload.epic.current.length}`)
check(
  'Epic 进行中的截止时间都在未来（说明 UTC 解析正确）',
  payload.epic.current.every((item) => Date.parse(item.endAt) > now),
  payload.epic.current.map((item) => `${item.title}=${item.endAt}`).join(', '),
)
check(
  'Epic 即将开始的开始时间都在未来',
  payload.epic.upcoming.every((item) => Date.parse(item.startAt) > now),
)
check('Epic 每条都有封面图', payload.epic.current.every((item) => item.image.startsWith('http')))
check('Epic 每条都有商店链接', payload.epic.current.every((item) => item.url.includes('store.epicgames.com')))
check(
  'Epic 没混进普通打折（折扣 20/35/60 那些不是喜加一）',
  [...payload.epic.current, ...payload.epic.upcoming].every((item) => !/定价|%/.test(item.title)),
)

check('Steam 折扣 ≥ 8 条', payload.steam.length >= 8, `实际 ${payload.steam.length}`)
check(
  'Steam 每条都是限免或 ≥5 折',
  payload.steam.every((item) => item.free || item.discount >= 50),
  payload.steam.filter((item) => !item.free && item.discount < 50).map((item) => `${item.title}=${item.discount}%`).join(', '),
)
check(
  'Steam 没混进「永久免费开玩」（0 元 0% 折扣）',
  payload.steam.every((item) => !item.free || item.discount >= 100),
)
check('Steam 每条都有封面图', payload.steam.every((item) => item.image.startsWith('http')))
check(
  'Steam 封面图与 appid 对应（防止跨行取图）',
  payload.steam.every((item) => item.image.includes(`/apps/${item.appId}/`)),
  payload.steam.filter((item) => !item.image.includes(`/apps/${item.appId}/`)).map((item) => item.title).join(', '),
)
check('Steam 有价格文本或免费标记', payload.steam.every((item) => item.priceFinalText))

check('其它平台福利 ≥ 5 条', payload.other.length >= 5, `实际 ${payload.other.length}`)
check(
  '其它平台福利没有 Steam / Epic 专属条目（避免和前两块重复）',
  payload.other.every((item) => !/^(PC,\s*)?(Steam|Epic Games Store)(,\s*(Steam|Epic Games Store))*$/.test(item.platforms)),
  payload.other.filter((item) => /^(PC,\s*)?(Steam|Epic Games Store)(,\s*(Steam|Epic Games Store))*$/.test(item.platforms)).map((item) => item.title).join(', '),
)
check(
  '其它平台福利没有已过期条目',
  payload.other.every((item) => !item.endAt || Date.parse(item.endAt) > now),
  payload.other.filter((item) => item.endAt && Date.parse(item.endAt) <= now).map((item) => `${item.title}=${item.endAt}`).join(', '),
)
check('其它平台福利每条都有图片', payload.other.every((item) => item.image.startsWith('http')))
check('其它平台福利每条都有领取链接', payload.other.every((item) => item.url.startsWith('http')))
check(
  '其它平台福利里 DLC/兑换码不超过 4 条（避免刷屏）',
  payload.other.filter((item) => item.type.toLowerCase() !== 'game').length <= 4,
)
check(
  '其它平台福利无重复标题',
  new Set(payload.other.map((item) => item.title)).size === payload.other.length,
)

check('拿到实时汇率（含 CNY/HKD/JPY/BRL）', Boolean(fx && fx.rateToCny.CNY && fx.rateToCny.HKD && fx.rateToCny.JPY && fx.rateToCny.BRL),
  fx ? JSON.stringify(fx.rateToCny) : 'fx 为 null')
check('Xbox 至少 5 个区拿到数据', xboxRegions.filter((block) => block.items.length > 0).length >= 5,
  xboxRegions.map((block) => `${block.label}:${block.items.length}`).join(' '))
check('任天堂至少 5 个区拿到数据', nintendoRegions.filter((block) => block.items.length > 0).length >= 5,
  nintendoRegions.map((block) => `${block.label}:${block.items.length}`).join(' '))
check('Xbox 折扣 ≥ 30 条（6 区合计）', xboxDeals.length >= 30, `实际 ${xboxDeals.length}`)
check('任天堂折扣 ≥ 30 条（各区合计）', nintendoDeals.length >= 30, `实际 ${nintendoDeals.length}`)
check(
  '主机条目字段完整（标题/链接/封面/原价/折后/折扣）',
  [...xboxDeals, ...nintendoDeals].every((item) => item.title && item.url.startsWith('http') && item.image.startsWith('http')
    && item.priceOriginal > 0 && item.priceSale > 0 && item.off > 0),
  [...xboxDeals, ...nintendoDeals].filter((item) => !(item.title && item.url.startsWith('http') && item.image.startsWith('http')
    && item.priceOriginal > 0 && item.priceSale > 0 && item.off > 0)).map((item) => item.title || item.id).join(', '),
)
check(
  '折后价低于原价',
  [...xboxDeals, ...nintendoDeals].every((item) => item.priceSale < item.priceOriginal),
  [...xboxDeals, ...nintendoDeals].filter((item) => item.priceSale >= item.priceOriginal).map((item) => item.title).join(', '),
)
check(
  'Xbox 折扣力度合理（1~95%）',
  xboxDeals.every((item) => item.off >= 1 && item.off <= 95),
  xboxDeals.filter((item) => item.off < 1 || item.off > 95).map((item) => `${item.title}=${item.off}%`).join(', '),
)
check(
  'Xbox 结束时间都在未来（说明 UTC 解析正确）',
  xboxDeals.every((item) => Date.parse(item.endAt) > Date.now() - 3_600_000),
  xboxDeals.filter((item) => !(Date.parse(item.endAt) > Date.now() - 3_600_000)).map((item) => `${item.title}=${item.endAt}`).join(', '),
)
check(
  '任天堂没有混进硬件/周边',
  nintendoDeals.every((item) => !/amiibo|Controller|Pro Controller|Console|System|Dock|Case|Switch™ 2 System/i.test(item.title)),
)
// 同一款游戏出现在多个区是正常的（这正是分区对比的意义），只要求「同一个区内部」不重复
check(
  '每个区内部标题不重复',
  [...xboxRegions, ...nintendoRegions].every((block) => new Set(block.items.map((item) => item.title)).size === block.items.length),
  [...xboxRegions, ...nintendoRegions].filter((block) => new Set(block.items.map((item) => item.title)).size !== block.items.length).map((block) => block.label).join(', '),
)
check(
  '各区的商品链接指向对应语区',
  xboxRegions.every((block) => block.items.every((item) => item.url.includes('/games/store/')))
  && nintendoRegions.every((block) => block.items.every((item) => item.url.includes('nintendo.com'))),
)

const allConsole = [...xboxDeals, ...nintendoDeals]
check(
  '所有主机条目都折算了人民币',
  allConsole.every((item) => typeof item.priceSaleCny === 'number' && item.priceSaleCny > 0),
  allConsole.filter((item) => typeof item.priceSaleCny !== 'number' || !(item.priceSaleCny > 0)).map((item) => `${item.regionLabel} ${item.title}`).slice(0, 5).join(', '),
)
check(
  '人民币折算与汇率一致（误差 ≤0.05 元）',
  allConsole.every((item) => {
    const rate = fx?.rateToCny?.[item.currency]
    if (!(rate > 0)) return true
    return Math.abs(item.priceSaleCny - item.priceSale * rate) <= 0.05
  }),
  allConsole.filter((item) => {
    const rate = fx?.rateToCny?.[item.currency]
    if (!(rate > 0)) return false
    return Math.abs(item.priceSaleCny - item.priceSale * rate) > 0.05
  }).map((item) => `${item.title} ${item.priceSale}${item.currency}→¥${item.priceSaleCny}`).slice(0, 4).join(', '),
)
check(
  '折后人民币低于原价人民币',
  allConsole.every((item) => item.priceSaleCny < item.priceOriginalCny),
)
check(
  '每个区的币种互不串味',
  xboxRegions.every((block) => block.items.every((item) => item.currency === block.currency))
  && nintendoRegions.every((block) => block.items.every((item) => item.currency === block.currency)),
  [...xboxRegions, ...nintendoRegions].map((block) => `${block.label}:${[...new Set(block.items.map((item) => item.currency))].join('/')}`).join(' '),
)
check(
  '其它平台福利的美元金额也折算了人民币',
  payload.other.filter((item) => item.worth.startsWith('$')).every((item) => typeof item.worthCny === 'number' && item.worthCny > 0),
  payload.other.filter((item) => item.worth.startsWith('$') && !(item.worthCny > 0)).map((item) => item.title).join(', '),
)

const coverChecks = []
if (xboxDeals[0]) coverChecks.push(['Xbox 封面', xboxDeals[0].image])
if (nintendoDeals[0]) coverChecks.push(['任天堂 封面', nintendoDeals[0].image])
for (const [label, url] of coverChecks) {
  const result = await imageProbe(url)
  check(`${label}可访问（CDN 前缀正确）`, result.startsWith('200 image/'), `${url.slice(0, 90)} → ${result}`)
}

console.log('\n【UTC 解析自检】')
console.log(`  10/15/2026 15:00:00 → ${parseUsStyleUtcDate('10/15/2026 15:00:00')}（应为北京时间 2026/10/15 23:00）`)

if (failures.length) {
  console.log(`\n❌ ${failures.length} 项未通过：\n- ${failures.join('\n- ')}\n`)
  process.exit(1)
}
console.log('\n✅ 全部通过\n')
