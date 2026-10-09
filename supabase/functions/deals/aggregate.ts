/**
 * GameJourney「薅羊毛」聚合逻辑。
 *
 * 设计约束：
 * 1. 这里只放纯逻辑 + fetch，不引用 Deno API，方便用 Node 直接复跑校验（scripts/deals-check.mjs）。
 * 2. 三个数据源都不是带 SLA 的正式开放 API（Epic 商店后端接口 / Steam 商店搜索接口 / GamerPower），
 *    字段随时可能变；单个源失败只影响对应板块，不允许整页挂掉。
 * 3. Epic 返回的时间是 UTC 但字符串里没有时区标记，必须按 UTC 解析，否则倒计时会差 8 小时。
 */

const USER_AGENT = 'GameJourney-Deals/1.0 (+https://gamejourney)'
// Xbox 促销页与任天堂商店接口会挡非浏览器 UA，这两个源单独用浏览器 UA
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
const EPIC_IMAGE_PRIORITY = ['OfferImageWide', 'Thumbnail', 'OfferImageTall', 'DieselStoreFrontWide', 'Featured']
// GamerPower：pc 覆盖 Steam/Epic/GOG/itch.io/IndieGala，drm-free/gog/switch 用来补其它平台福利
const OTHER_PLATFORMS = ['pc', 'drm-free', 'gog', 'switch']
const OTHER_ITEM_CAP = 20
const STEAM_ITEM_CAP = 18
const CONSOLE_ITEM_CAP = 12
// 任天堂商店自己的 Algolia 搜索（key 是官网前端公开使用的），索引名 = store_all_products_{语言}_{国家}
const NINTENDO_ALGOLIA_BASE = 'https://u3b6gr4ua3-dsn.algolia.net/1/indexes/'
const NINTENDO_ALGOLIA_KEY = 'a29c6927638bfd8cee23993e51e721c9'
const NINTENDO_APPLICATION_ID = 'U3B6GR4UA3'
// Algolia 返回的是相对路径，必须拼 CDN 前缀，否则封面 404
const NINTENDO_IMAGE_BASE = 'https://assets.nintendo.com/image/upload/c_fill,w_400/q_auto/f_auto/'

/**
 * Xbox 促销页按语言/区有独立版本，币种跟着区走（实测 hk=HKD、tw=TWD、jp=JPY、br=BRL、gb=GBP）。
 * 港区放在第一位：这是国内答主最容易实际用上的区。
 */
const XBOX_REGIONS = [
  { code: 'hk', label: '港区', path: 'zh-HK', currency: 'HKD' },
  { code: 'us', label: '美区', path: 'en-US', currency: 'USD' },
  { code: 'tw', label: '台区', path: 'zh-TW', currency: 'TWD' },
  { code: 'jp', label: '日区', path: 'ja-JP', currency: 'JPY' },
  { code: 'br', label: '巴西区', path: 'pt-BR', currency: 'BRL' },
  { code: 'gb', label: '英区', path: 'en-GB', currency: 'GBP' },
]

/**
 * 任天堂只有 nintendo.com 这套站点（美洲）有可用的搜索接口：官方欧美/日港站点是另外几套，
 * 港区 store.nintendo.com.hk 与日区 store-jp.nintendo.com 都返回反爬挑战页，Algolia 里也没有
 * zh_hk / ja_jp 索引 —— 所以港区、日区暂时拿不到，这里给的是能拿到的区。
 */
const NINTENDO_REGIONS = [
  { code: 'us', label: '美区', index: 'en_us', currency: 'USD' },
  { code: 'br', label: '巴西区', index: 'pt_br', currency: 'BRL' },
  { code: 'mx', label: '墨西哥区', index: 'es_mx', currency: 'MXN' },
  { code: 'ca', label: '加拿大区', index: 'en_ca', currency: 'CAD' },
  { code: 'ar', label: '阿根廷区', index: 'es_ar', currency: 'ARS' },
  { code: 'pe', label: '秘鲁区', index: 'es_pe', currency: 'PEN' },
  { code: 'co', label: '哥伦比亚区', index: 'es_co', currency: 'COP' },
  { code: 'cl', label: '智利区', index: 'es_cl', currency: 'CLP' },
]

// 实时汇率：主源 open.er-api（无 key、含 CNY/HKD/JPY/BRL 等），备用 jsDelivr 的 currency-api
const FX_PRIMARY_URL = 'https://open.er-api.com/v6/latest/USD'
const FX_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json'
const FX_CURRENCIES = ['CNY', 'HKD', 'TWD', 'JPY', 'BRL', 'GBP', 'CAD', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'USD']

export type EpicDeal = {
  id: string
  title: string
  image: string
  url: string
  worth: string
  startAt: string
  endAt: string
}

export type SteamDeal = {
  appId: string
  title: string
  image: string
  url: string
  discount: number
  priceFinal: number
  priceFinalText: string
  priceOriginalText: string
  free: boolean
}

export type OtherDeal = {
  id: string
  title: string
  image: string
  url: string
  platforms: string
  type: string
  worth: string
  /** worth 里的美元金额按实时汇率折算的人民币（拿不到汇率或不是美元时为 null） */
  worthCny: number | null
  summary: string
  endAt: string
  publishedAt: string
  source: string
}

export type ConsoleDeal = {
  platform: 'xbox' | 'nintendo'
  region: string
  regionLabel: string
  id: string
  title: string
  image: string
  url: string
  priceOriginal: number
  priceSale: number
  /** 按实时汇率折算：原价/折后价的人民币金额；没有汇率时为 null */
  priceOriginalCny: number | null
  priceSaleCny: number | null
  off: number
  currency: string
  endAt: string
  publisher: string
  storeLabel: string
}

export type RegionBlock = {
  code: string
  label: string
  currency: string
  /** 1 单位该币种 = 多少人民币（拿不到汇率时为 null） */
  rate: number | null
  items: ConsoleDeal[]
}

export type FxSnapshot = {
  base: 'CNY'
  /** 1 美元 = 多少目标币种 */
  usdRates: Record<string, number>
  rateToCny: Record<string, number>
  updatedAt: string
  source: string
}

export type DealsPayload = {
  success: boolean
  updatedAt: string
  epic: { current: EpicDeal[]; upcoming: EpicDeal[] }
  steam: SteamDeal[]
  other: OtherDeal[]
  consoles: { xbox: RegionBlock[]; nintendo: RegionBlock[] }
  fx: FxSnapshot | null
  counts: { epic: number; steam: number; other: number; console: number }
  errors: { source: string; message: string }[]
}

type FetchLike = typeof fetch

export const buildEpicFreeUrl = () =>
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN'

export const buildSteamSpecialsUrl = (count = 120) =>
  `https://store.steampowered.com/search/results/?query&start=0&count=${count}&specials=1&category1=998&infinite=1&cc=cn&l=schinese`

export const buildGamerPowerUrl = (platform: string) =>
  `https://www.gamerpower.com/api/giveaways?platform=${encodeURIComponent(platform)}`

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? '请求超时' : error.message
  }
  return String(error)
}

export function stripTags(value = ''): string {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function decodeEntities(value = ''): string {
  return String(value)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, '&')
}

type RequestOptions = {
  timeoutMs?: number
  accept?: string
  userAgent?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

async function requestRaw(url: string, fetchImpl: FetchLike, options: RequestOptions = {}): Promise<string> {
  const {
    timeoutMs = 12_000,
    accept = 'application/json,text/plain,*/*',
    userAgent = USER_AGENT,
    method = 'GET',
    headers = {},
    body,
  } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method,
      body,
      headers: { 'User-Agent': userAgent, Accept: accept, ...headers },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(url: string, fetchImpl: FetchLike, options: RequestOptions = {}): Promise<unknown> {
  const body = await requestRaw(url, fetchImpl, options)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('返回内容不是合法 JSON')
  }
}

// ---------------------------------------------------------------- Epic 喜加一

const EPIC_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/

/**
 * 「月/日/年 时:分:秒」式的 UTC 时间。
 * Epic 的促销时间当前返回已带 Z 的 ISO 串（"2026-10-15T15:00:00.000Z"），但历史/其它环境下会返回
 * 无时区标记的 "10/15/2026 15:00:00"；Xbox 促销页的 endDateUtc 也是 "10/15/2026 09:59:59"。
 * 这类串必须按 UTC 解析，所以先按明确格式匹配，再回退到通用解析，避免差 8 小时。
 */
export function parseUsStyleUtcDate(value: unknown): string {
  const text = String(value || '').trim()
  if (!text) return ''
  const match = EPIC_DATE_PATTERN.exec(text)
  if (match) {
    const date = new Date(Date.UTC(
      Number(match[3]),
      Number(match[1]) - 1,
      Number(match[2]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ))
    return Number.isFinite(date.getTime()) ? date.toISOString() : ''
  }
  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function epicImage(element: any): string {
  const images = Array.isArray(element?.keyImages) ? element.keyImages : []
  for (const type of EPIC_IMAGE_PRIORITY) {
    const hit = images.find((image: any) => image?.type === type && typeof image?.url === 'string' && image.url)
    if (hit) return hit.url
  }
  return ''
}

function epicSlug(element: any): string {
  const raw = element?.productSlug
    || element?.offerMappings?.[0]?.pageSlug
    || element?.catalogNs?.mappings?.[0]?.pageSlug
    || ''
  return String(raw).replace(/\/home$/i, '')
}

function epicWorth(element: any): string {
  const price = element?.price?.totalPrice
  const text = price?.fmtPrice?.originalPrice || price?.fmtPrice?.discountPrice || ''
  if (text) return String(text)
  const value = Number(price?.originalPrice)
  return Number.isFinite(value) && value > 0 ? `¥${(value / 100).toFixed(2)}` : ''
}

/** 取 offers 里 discountPercentage === 0 的促销：只有 0 才是「免费送」，20/35/60 那些是普通打折 */
function epicFreeOffer(group: unknown): any | null {
  const list = Array.isArray(group) ? group[0]?.promotionalOffers : null
  if (!Array.isArray(list)) return null
  return list.find((offer: any) => Number(offer?.discountSetting?.discountPercentage) === 0) || null
}

export function parseEpicFree(payload: any): { current: EpicDeal[]; upcoming: EpicDeal[] } {
  const elements = payload?.data?.Catalog?.searchStore?.elements
  const list = Array.isArray(elements) ? elements : []
  const current: EpicDeal[] = []
  const upcoming: EpicDeal[] = []
  const claimed = new Set<string>()

  for (const element of list) {
    const id = String(element?.id || '')
    const title = String(element?.title || '').trim()
    if (!id || !title || claimed.has(id)) continue
    const base = {
      id,
      title,
      image: epicImage(element),
      url: epicSlug(element) ? `https://store.epicgames.com/zh-CN/p/${epicSlug(element)}` : 'https://store.epicgames.com/zh-CN/free-games',
      worth: epicWorth(element),
    }
    const active = epicFreeOffer(element?.promotions?.promotionalOffers)
    if (active) {
      claimed.add(id)
      current.push({
        ...base,
        startAt: parseUsStyleUtcDate(active.startDate),
        endAt: parseUsStyleUtcDate(active.endDate),
      })
      continue
    }
    const next = epicFreeOffer(element?.promotions?.upcomingPromotionalOffers)
    if (next) {
      claimed.add(id)
      upcoming.push({
        ...base,
        startAt: parseUsStyleUtcDate(next.startDate),
        endAt: parseUsStyleUtcDate(next.endDate),
      })
    }
  }

  current.sort((a, b) => (a.endAt || '~').localeCompare(b.endAt || '~'))
  upcoming.sort((a, b) => (a.startAt || '~').localeCompare(b.startAt || '~'))
  return { current, upcoming }
}

// ---------------------------------------------------------------- Steam 限时折扣

/**
 * Steam 搜索接口返回的是 `results_html`，且每行的 `<img>` 在 `<span class="title">` **之前**，
 * 所以必须按 `<a href=".../app/">` 切块后再在块内取字段，不能用「标题后面的图片」这种跨块正则。
 */
export function parseSteamSpecials(html: unknown): SteamDeal[] {
  const text = String(html || '')
  const chunks = text.split('<a href="https://store.steampowered.com/app/').slice(1)
  const rows: SteamDeal[] = []
  const seen = new Set<string>()

  for (const chunk of chunks) {
    const appId = (chunk.match(/data-ds-appid="(\d+)"/) || [])[1]
    const title = decodeEntities(stripTags((chunk.match(/<span class="title">([\s\S]*?)<\/span>/) || [])[1] || ''))
    if (!appId || !title || seen.has(appId)) continue
    seen.add(appId)

    const image = (chunk.match(/<img src="([^"]+)"/) || [])[1] || ''
    const discount = Number((chunk.match(/data-discount="(\d+)"/) || [])[1] || 0)
    const priceFinal = Number((chunk.match(/data-price-final="(\d+)"/) || [])[1] || 0)
    const priceFinalText = stripTags((chunk.match(/class="discount_final_price[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '')
    const priceOriginalText = stripTags((chunk.match(/class="discount_original_price[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '')

    const isZeroPrice = Number.isFinite(priceFinal) && priceFinal === 0
    // Steam 上「永久免费开玩」也是 0 元 + 0% 折扣，那不是薅羊毛，只是免费游戏；
    // 只有「100% off 限时免费领」才是福利，必须靠折扣率区分。
    if (isZeroPrice && discount < 100) continue

    rows.push({
      appId,
      title,
      image,
      url: `https://store.steampowered.com/app/${appId}/`,
      discount: Number.isFinite(discount) ? discount : 0,
      priceFinal: Number.isFinite(priceFinal) ? priceFinal : 0,
      priceFinalText: priceFinalText || (priceFinal === 0 ? '免费' : ''),
      priceOriginalText,
      free: isZeroPrice,
    })
  }
  return rows
}

/**
 * 「超值折扣」取法：先保底放限时免费的，再按折扣从高到低补，直到够 minCount 条。
 * 折扣阈值从 70 逐级放宽，避免某天大盘折扣都很浅时板块开天窗。
 */
export function pickSteamDeals(rows: SteamDeal[], options: { cap?: number; minCount?: number } = {}): SteamDeal[] {
  const cap = options.cap ?? STEAM_ITEM_CAP
  const minCount = options.minCount ?? 8
  const free = rows.filter((row) => row.free)
  const discounted = rows.filter((row) => !row.free && row.discount > 0)
  const sortByDiscount = (list: SteamDeal[]) =>
    [...list].sort((a, b) => (b.discount - a.discount) || (a.priceFinal - b.priceFinal))

  for (const threshold of [70, 60, 50, 40, 30]) {
    const hit = discounted.filter((row) => row.discount >= threshold)
    if (free.length + hit.length >= minCount || threshold === 30) {
      return [...sortByDiscount(free), ...sortByDiscount(hit)].slice(0, cap)
    }
  }
  return sortByDiscount(free).slice(0, cap)
}

// ---------------------------------------------------------------- 其它平台福利（GamerPower）

/** GamerPower 的时间没有时区标记，按 UTC 解析；前端只展示日期，不依赖秒级精度 */
export function parseGamerPowerDate(value: unknown): string {
  const text = String(value || '').trim()
  if (!text || /^n\/a$/i.test(text)) return ''
  const normalized = text.replace(' ', 'T')
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

/** GamerPower 在「该平台暂无活动」时返回 {status:0,...} 对象而不是数组，必须兼容 */
export function parseGamerPower(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload
  return []
}

const OTHER_TYPE_RANK: Record<string, number> = { game: 0, 'early access': 1, dlc: 2, beta: 3 }
// Game 类是真·免费领游戏，DLC/兑换码量大且价值参差，必须限量，否则整块被兑换码刷屏
const OTHER_GAME_CAP = 12
const OTHER_MISC_CAP = 4

function otherTypeRank(type: string): number {
  const key = type.trim().toLowerCase()
  return key in OTHER_TYPE_RANK ? OTHER_TYPE_RANK[key] : 4
}

function otherTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

export function normalizeOtherDeals(rows: any[], now = Date.now()): OtherDeal[] {
  const seen = new Set<string>()
  const items: OtherDeal[] = []

  for (const row of rows) {
    const title = decodeEntities(stripTags(String(row?.title || ''))).trim()
    if (!title) continue
    const type = String(row?.type || '').trim()
    // type=Other 多为「装个插件」这类引流条目，不是玩家能薅的东西
    if (/^other$/i.test(type)) continue

    const platforms = String(row?.platforms || '').trim()
    const platformNames = platforms
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name && name.toLowerCase() !== 'pc')
    // 只发 Steam / 只发 Epic 的条目已被上面两个板块覆盖，避免同一件事出现三次
    const steamEpicOnly = platformNames.length > 0
      && platformNames.every((name) => /^(steam|epic games store)$/i.test(name))
    if (steamEpicOnly) continue

    const endAt = parseGamerPowerDate(row?.end_date)
    if (endAt && Date.parse(endAt) < now) continue

    const key = otherTitleKey(title)
    if (!key || seen.has(key)) continue
    seen.add(key)

    items.push({
      id: String(row?.id || key),
      title,
      image: String(row?.thumbnail || row?.image || ''),
      url: String(row?.open_giveaway_url || row?.giveaway_url || row?.url || ''),
      platforms,
      type,
      worth: /^n\/a$/i.test(String(row?.worth || '')) ? '' : String(row?.worth || ''),
      worthCny: null,
      summary: stripTags(String(row?.description || '')).slice(0, 120),
      endAt,
      publishedAt: parseGamerPowerDate(row?.published_date),
      source: 'GamerPower',
    })
  }

  items.sort((a, b) => (otherTypeRank(a.type) - otherTypeRank(b.type))
    || (Number(Boolean(b.worth)) - Number(Boolean(a.worth)))
    || ((a.endAt || '~').localeCompare(b.endAt || '~')))

  let gameCount = 0
  let miscCount = 0
  const capped: OtherDeal[] = []
  for (const item of items) {
    const isGame = otherTypeRank(item.type) === 0
    if (isGame) {
      if (gameCount >= OTHER_GAME_CAP) continue
      gameCount += 1
    } else {
      if (miscCount >= OTHER_MISC_CAP) continue
      miscCount += 1
    }
    capped.push(item)
  }
  return capped.slice(0, OTHER_ITEM_CAP)
}

// ---------------------------------------------------------------- 主机特惠（Xbox / 任天堂）

// -------- 实时汇率（美元为基准，换算成人民币） --------

export function normalizeUsdRates(source: Record<string, unknown> | undefined | null): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const code of FX_CURRENCIES) {
    const value = Number(source?.[code] ?? source?.[code.toLowerCase()])
    if (Number.isFinite(value) && value > 0) rates[code] = value
  }
  return rates
}

/**
 * 取实时汇率。主源 open.er-api.com（无 key，返回 USD→各币种），失败时退到 jsDelivr 的 currency-api。
 * 两个源都是「每日更新」，不是逐笔行情，所以页面上要标出更新时间和来源，别写成「实时报价」。
 */
export async function loadFxRates(fetchImpl: FetchLike): Promise<FxSnapshot | null> {
  try {
    const data: any = await requestJson(FX_PRIMARY_URL, fetchImpl, { timeoutMs: 8000 })
    const usdRates = normalizeUsdRates(data?.rates)
    if (usdRates.CNY) {
      const parsed = data?.time_last_update_utc ? new Date(String(data.time_last_update_utc)) : null
      return {
        base: 'CNY',
        usdRates,
        rateToCny: buildRateToCny(usdRates),
        updatedAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString(),
        source: 'open.er-api.com',
      }
    }
  } catch {
    // 落到备用源
  }

  const data: any = await requestJson(FX_FALLBACK_URL, fetchImpl, { timeoutMs: 8000 })
  const usdRates = normalizeUsdRates(data?.usd)
  if (!usdRates.CNY) throw new Error('备用汇率源也没有 CNY')
  return {
    base: 'CNY',
    usdRates,
    rateToCny: buildRateToCny(usdRates),
    updatedAt: data?.date ? `${data.date}T00:00:00Z` : new Date().toISOString(),
    source: 'jsdelivr currency-api',
  }
}

function buildRateToCny(usdRates: Record<string, number>): Record<string, number> {
  const rateToCny: Record<string, number> = {}
  const cny = usdRates.CNY
  for (const [code, perUsd] of Object.entries(usdRates)) {
    if (perUsd > 0) rateToCny[code] = Math.round((cny / perUsd) * 1e6) / 1e6
  }
  return rateToCny
}

/** 外币金额 → 人民币；没有汇率或不是正数时返回 null（前端只显示原币种） */
export function toCny(amount: unknown, currency: string, fx: FxSnapshot | null): number | null {
  const value = Number(amount)
  const rate = fx?.rateToCny?.[currency]
  if (!Number.isFinite(value) || value <= 0 || !(rate > 0)) return null
  return Math.round(value * rate * 100) / 100
}

/** GamerPower 的 worth 形如 "$29.99"，只处理美元，其它格式返回 null */
export function parseUsdWorth(worth: unknown): number | null {
  const match = String(worth || '').match(/^\s*(?:\$|USD\s*)\s*([0-9]+(?:\.[0-9]+)?)/i)
  return match ? Number(match[1]) : null
}

/**
 * 从页面里抠出 `window.__PRELOADED_STATE__ = { ... }` 的 JSON。
 * 必须自己做括号配对（而不是正则找结尾），并跳过字符串里的括号与转义符，否则会被商品名里的
 * `{` `}` `"` 打断；Xbox 促销页整页约 630 KB，这段 JSON 就占 480 KB。
 */
export function extractWindowState(html: unknown, variable = '__PRELOADED_STATE__'): any | null {
  const source = String(html || '')
  const anchor = source.indexOf(variable)
  if (anchor < 0) return null
  const start = source.indexOf('{', anchor)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function xboxImage(summary: any): string {
  const images = summary?.images || {}
  return String(images.boxArt?.url || images.poster?.url || images.superHeroArt?.url || '')
}

/** Xbox：一个商品可能有多个 SKU/可用性条目，取折扣最大的那一条作为代表 */
export function parseXboxSales(
  state: any,
  region: { code: string; label: string; currency: string },
  fx: FxSnapshot | null = null,
  cap = CONSOLE_ITEM_CAP,
): ConsoleDeal[] {
  const products = state?.content?.products
  const availability = products?.availabilitySummaries
  if (!availability || typeof availability !== 'object') return []
  const summaries = products?.productSummaries || {}
  const best = new Map<string, ConsoleDeal>()

  for (const productId of Object.keys(availability)) {
    const summary = summaries[productId] || {}
    const title = String(summary.title || '').trim()
    if (!title) continue
    const skus = availability[productId] || {}
    for (const skuId of Object.keys(skus)) {
      const availabilities = skus[skuId] || {}
      for (const availabilityId of Object.keys(availabilities)) {
        const price = availabilities[availabilityId]?.price
        const off = Math.round(Number(price?.discountPercentage) || 0)
        if (!(off > 0)) continue
        // 币种以页面给的为准（万一某区回落到美元），换算按实际币种查汇率
        const currency = String(price?.currency || region.currency)
        const priceOriginal = Number(price?.msrp) || 0
        const priceSale = Number(price?.listPrice) || 0
        const deal: ConsoleDeal = {
          platform: 'xbox',
          region: region.code,
          regionLabel: region.label,
          id: productId,
          title,
          image: xboxImage(summary),
          url: `https://www.xbox.com/en-US/games/store/-/${productId}`,
          priceOriginal,
          priceSale,
          priceOriginalCny: toCny(priceOriginal, currency, fx),
          priceSaleCny: toCny(priceSale, currency, fx),
          off,
          currency,
          endAt: parseUsStyleUtcDate(price?.endDateUtc),
          publisher: String(summary.publisherName || ''),
          storeLabel: 'Xbox',
        }
        const previous = best.get(productId)
        if (!previous || deal.off > previous.off) best.set(productId, deal)
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => (b.off - a.off) || (a.priceSale - b.priceSale))
    .slice(0, cap)
}

/**
 * 任天堂美区：Algolia 返回的命中有硬件/amiibo/周边，`productType` 里必须含 `Games`；
 * 折扣筛选只能用 `price.percentOff > 0`（`price.discounted:true` 实测 0 条）。
 * 接口按相关度返回，要多少折扣力度靠多抓几页再自己排序。
 */
export function parseNintendoSales(
  hits: any[],
  region: { code: string; label: string; currency: string },
  fx: FxSnapshot | null = null,
  cap = CONSOLE_ITEM_CAP,
): ConsoleDeal[] {
  const items: ConsoleDeal[] = []
  const seen = new Set<string>()

  for (const hit of Array.isArray(hits) ? hits : []) {
    // 注意：productType 是本地化词（美区 Games / 墨西哥区 Juegos / 巴西区 Jogos），
    // 不能用它做判断；topLevelCategoryCode 在各区都是稳定的英文枚举，硬件是 HARDWARE。
    const categoryCode = String(hit?.topLevelCategoryCode || '').toUpperCase()
    const types = Array.isArray(hit?.productType) ? hit.productType : []
    const isGame = categoryCode
      ? categoryCode === 'GAMES'
      : types.some((type: string) => /^(games|juegos|jogos)$/i.test(String(type)))
    if (!isGame) continue
    const off = Math.round(Number(hit?.price?.percentOff) || 0)
    if (!(off > 0)) continue
    const title = decodeEntities(stripTags(String(hit?.title || ''))).trim()
    if (!title || seen.has(title)) continue
    seen.add(title)

    const path = String(hit?.url || '')
    const image = String(hit?.productImage || '')
    const priceOriginal = Number(hit?.price?.regPrice) || 0
    const priceSale = Number(hit?.price?.salePrice) || 0
    items.push({
      platform: 'nintendo',
      region: region.code,
      regionLabel: region.label,
      id: String(hit?.sku || hit?.objectID || hit?.titleKey || path || title),
      title,
      image: image ? `${NINTENDO_IMAGE_BASE}${image}` : '',
      url: path.startsWith('http') ? path : `https://www.nintendo.com${path}`,
      priceOriginal,
      priceSale,
      priceOriginalCny: toCny(priceOriginal, region.currency, fx),
      priceSaleCny: toCny(priceSale, region.currency, fx),
      off,
      currency: region.currency,
      endAt: '',
      publisher: '',
      storeLabel: 'Nintendo eShop',
    })
  }

  return items
    .sort((a, b) => (b.off - a.off) || (a.priceSale - b.priceSale))
    .slice(0, cap)
}

async function loadXboxRegion(
  fetchImpl: FetchLike,
  region: { code: string; label: string; path: string; currency: string },
  fx: FxSnapshot | null,
): Promise<RegionBlock> {
  const url = `https://www.xbox.com/${region.path}/promotions/sales/sales-and-specials`
  const html = await requestRaw(url, fetchImpl, {
    timeoutMs: 20_000,
    accept: 'text/html,application/xhtml+xml',
    userAgent: BROWSER_UA,
  })
  const state = extractWindowState(html)
  if (!state) throw new Error('促销页结构变化，未找到 __PRELOADED_STATE__')
  const items = parseXboxSales(state, region, fx)
  if (!items.length) throw new Error('促销页里没有解析到折扣条目')
  return { code: region.code, label: region.label, currency: region.currency, rate: fx?.rateToCny?.[region.currency] ?? null, items }
}

async function loadNintendoRegion(
  fetchImpl: FetchLike,
  region: { code: string; label: string; index: string; currency: string },
  fx: FxSnapshot | null,
): Promise<RegionBlock> {
  // 抓两页再排序：单页 30 条按相关度返回，只抓一页会漏掉折扣更狠的游戏
  const pages = [0, 1]
  const settled = await Promise.allSettled(pages.map((page) => requestRaw(`${NINTENDO_ALGOLIA_BASE}store_all_products_${region.index}/query`, fetchImpl, {
    timeoutMs: 12_000,
    method: 'POST',
    userAgent: BROWSER_UA,
    headers: {
      'X-Algolia-API-Key': NINTENDO_ALGOLIA_KEY,
      'X-Algolia-Application-Id': NINTENDO_APPLICATION_ID,
      'Content-Type': 'application/json',
      Origin: 'https://www.nintendo.com',
    },
    body: JSON.stringify({ query: '', hitsPerPage: 30, page, filters: 'price.percentOff > 0' }),
  })))

  const hits: any[] = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    try {
      hits.push(...(JSON.parse(result.value)?.hits || []))
    } catch {
      // 单页解析失败不影响另一页
    }
  }
  const items = parseNintendoSales(hits, region, fx)
  if (!items.length) throw new Error('折扣接口未返回可用的游戏条目')
  return { code: region.code, label: region.label, currency: region.currency, rate: fx?.rateToCny?.[region.currency] ?? null, items }
}

/** 一个平台的多个区并行抓取，单区失败只让该区为空，不拖垮整个板块 */
async function loadConsoleRegions(
  fetchImpl: FetchLike,
  regions: Array<Record<string, string>>,
  fx: FxSnapshot | null,
  loader: (fetchImpl: FetchLike, region: any, fx: FxSnapshot | null) => Promise<RegionBlock>,
  platform: string,
  errors: { source: string; message: string }[],
): Promise<RegionBlock[]> {
  const settled = await Promise.allSettled(regions.map((region) => loader(fetchImpl, region, fx)))
  return settled.map((result, index) => {
    const region = regions[index]
    if (result.status === 'fulfilled') return result.value
    errors.push({ source: `${platform}:${region.code}`, message: errorMessage(result.reason) })
    return { code: region.code, label: region.label, currency: region.currency, rate: null, items: [] }
  })
}

// ---------------------------------------------------------------- 汇总

async function loadEpic(fetchImpl: FetchLike) {
  const payload = await requestJson(buildEpicFreeUrl(), fetchImpl)
  return parseEpicFree(payload)
}

async function loadSteam(fetchImpl: FetchLike) {
  const html = await requestRaw(buildSteamSpecialsUrl(), fetchImpl, { timeoutMs: 15_000, accept: 'application/json,text/html,*/*' })
  let resultsHtml = html
  try {
    resultsHtml = (JSON.parse(html) as any)?.results_html || ''
  } catch {
    throw new Error('返回内容不是合法 JSON')
  }
  return pickSteamDeals(parseSteamSpecials(resultsHtml))
}

async function loadOther(fetchImpl: FetchLike) {
  const settled = await Promise.allSettled(
    OTHER_PLATFORMS.map((platform) => requestJson(buildGamerPowerUrl(platform), fetchImpl)),
  )
  const rows = settled.flatMap((result) => result.status === 'fulfilled' ? parseGamerPower(result.value) : [])
  if (!rows.length && settled.every((result) => result.status === 'rejected')) {
    throw (settled[0] as PromiseRejectedResult).reason
  }
  return normalizeOtherDeals(rows)
}

export async function buildDeals(
  options: { fetch?: FetchLike; now?: number } = {},
): Promise<DealsPayload> {
  const fetchImpl = options.fetch || fetch
  const now = options.now ?? Date.now()
  const errors: { source: string; message: string }[] = []

  // 汇率先拿（所有外币价格都要用），失败也不阻断抓取，只是不做折算
  const fx = await loadFxRates(fetchImpl).catch((error) => {
    errors.push({ source: 'fx', message: errorMessage(error) })
    return null
  })

  const [epic, steam, other, xbox, nintendo] = await Promise.all([
    loadEpic(fetchImpl).catch((error) => {
      errors.push({ source: 'epic', message: errorMessage(error) })
      return { current: [] as EpicDeal[], upcoming: [] as EpicDeal[] }
    }),
    loadSteam(fetchImpl).catch((error) => {
      errors.push({ source: 'steam', message: errorMessage(error) })
      return [] as SteamDeal[]
    }),
    loadOther(fetchImpl).catch((error) => {
      errors.push({ source: 'gamerpower', message: errorMessage(error) })
      return [] as OtherDeal[]
    }),
    loadConsoleRegions(fetchImpl, XBOX_REGIONS, fx, loadXboxRegion, 'xbox', errors),
    loadConsoleRegions(fetchImpl, NINTENDO_REGIONS, fx, loadNintendoRegion, 'nintendo', errors),
  ])

  // GamerPower 的 worth 是美元字符串，一并折算成人民币
  const otherWithCny = other.map((item) => {
    const usd = parseUsdWorth(item.worth)
    return { ...item, worthCny: usd == null ? null : toCny(usd, 'USD', fx) }
  })

  const consoleCount = [...xbox, ...nintendo].reduce((total, block) => total + block.items.length, 0)

  return {
    success: true,
    updatedAt: new Date(now).toISOString(),
    epic,
    steam,
    other: otherWithCny,
    consoles: { xbox, nintendo },
    fx,
    counts: {
      epic: epic.current.length + epic.upcoming.length,
      steam: steam.length,
      other: otherWithCny.length,
      console: consoleCount,
    },
    errors,
  }
}
