import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

// 服务端 30 分钟缓存是尽力而为（Edge Function 可能换实例），前端再压一层，
// 避免答主在「今日投稿 / 薅羊毛」之间来回切页时反复打外部站点。
// v2：主机板块从「一个列表」改成「按区分组」，旧缓存结构不兼容，直接换 key 作废
const CACHE_KEY = 'keyflow_deals_cache_v2'
const CACHE_TTL_MS = 10 * 60 * 1000
const COUNTDOWN_TICK_MS = 30 * 1000

const readCache = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
    if (!raw?.payload || !raw?.at) return null
    return { payload: raw.payload, at: raw.at, fresh: Date.now() - raw.at < CACHE_TTL_MS }
  } catch {
    return null
  }
}

const writeCache = (payload) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), payload }))
  } catch {
    /* 隐私模式下写不了就跳过，不影响功能 */
  }
}

const pad = (value) => String(value).padStart(2, '0')

const formatClock = (iso) => {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const formatUpdatedAt = (iso) => {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 倒计时文案：Epic 每周四 23:00 换榜，按天/小时展示比精确到秒更好读 */
function countdownText(target, now) {
  const end = Date.parse(target)
  if (!Number.isFinite(end)) return ''
  const diff = end - now
  if (diff <= 0) return '已结束'
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (days > 0) return `剩 ${days} 天 ${hours} 小时`
  if (hours > 0) return `剩 ${hours} 小时 ${minutes} 分`
  return `剩 ${minutes} 分钟`
}

const isUrgent = (target, now) => {
  const end = Date.parse(target)
  return Number.isFinite(end) && end - now > 0 && end - now < 24 * 3_600_000
}

const platformTags = (platforms) =>
  String(platforms || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !/^pc$/i.test(name))

const OTHER_TYPE_LABEL = {
  game: '游戏',
  'early access': '抢先体验',
  dlc: 'DLC/兑换码',
  beta: '测试',
}

const otherTypeLabel = (type) => OTHER_TYPE_LABEL[String(type || '').toLowerCase()] || type

// 外币金额 → 主显示人民币、副显示原币种
const formatCny = (value) => `¥${Number(value || 0).toFixed(2)}`
// 原币种只作为参考：整数就不显示小数（JPY/COP/CLP 这些本来也没小数位），避免价格行换行
const formatMoney = (amount, currency) => {
  const value = Number(amount || 0)
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  return `${currency} ${text}`
}

// 区服选择记忆在本地，切页面回来还是上次看的区
const REGION_STORAGE_KEY = { xbox: 'keyflow_deals_region_xbox', nintendo: 'keyflow_deals_region_nintendo' }
const readRegion = (platform) => {
  try { return localStorage.getItem(REGION_STORAGE_KEY[platform]) || '' } catch { return '' }
}
const writeRegion = (platform, code) => {
  try { localStorage.setItem(REGION_STORAGE_KEY[platform], code) } catch { /* 忽略 */ }
}

// 抓取失败的源在页面上用中文名提示，别把内部标识甩给答主
const SOURCE_LABEL = {
  epic: 'Epic',
  steam: 'Steam',
  gamerpower: '其它平台',
  xbox: 'Xbox',
  nintendo: '任天堂',
}

const sourceLabel = (source) => {
  const [platform, region] = String(source || '').split(':')
  const base = SOURCE_LABEL[platform] || platform
  const regionLabel = { hk: '港区', us: '美区', tw: '台区', jp: '日区', br: '巴西区', gb: '英区', mx: '墨西哥区', ca: '加拿大区', ar: '阿根廷区', pe: '秘鲁区', co: '哥伦比亚区', cl: '智利区' }[region]
  return region ? `${base}${regionLabel || region}` : base
}

// 封面加载失败时不显示破图：先退到 Steam 官方 header，再退到纯色占位
const handleCoverError = (event, appId) => {
  const image = event.currentTarget
  const fallback = appId ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg` : ''
  if (fallback && !image.dataset.fallback) {
    image.dataset.fallback = '1'
    image.src = fallback
    return
  }
  image.style.visibility = 'hidden'
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

export default function DealsBoard({ onOpenCoins }) {
  const cached = useMemo(readCache, [])
  const [payload, setPayload] = useState(cached?.payload || null)
  const [loading, setLoading] = useState(!cached?.fresh)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [xboxRegion, setXboxRegion] = useState(() => readRegion('xbox'))
  const [nintendoRegion, setNintendoRegion] = useState(() => readRegion('nintendo'))

  const load = useCallback(async ({ force = false } = {}) => {
    if (force) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const { data, error: requestError } = await supabase.functions.invoke('deals', { body: { refresh: force } })
      if (requestError) throw new Error(requestError.message || '福利数据加载失败')
      if (!data?.success) throw new Error(data?.error || '福利数据加载失败')
      setPayload(data)
      writeCache(data)
    } catch (requestFailure) {
      const message = requestFailure?.message || '福利数据加载失败，请稍后重试。'
      // 有旧数据时只提示不空屏
      setError(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!cached?.fresh) load()
  }, [cached, load])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const epicCurrent = payload?.epic?.current || []
  const epicUpcoming = payload?.epic?.upcoming || []
  const steam = payload?.steam || []
  const other = payload?.other || []
  const fx = payload?.fx || null
  // 只认带 items 数组的区服结构，旧缓存/异常数据一律过滤掉，避免整页崩
  const regionBlocks = (value) => (Array.isArray(value) ? value.filter((block) => block && Array.isArray(block.items)) : [])
  const xboxRegions = regionBlocks(payload?.consoles?.xbox)
  const nintendoRegions = regionBlocks(payload?.consoles?.nintendo)
  // 选中的区没数据时自动退到第一个有数据的区，避免切到一个空区后看起来像坏了
  const pickRegion = (blocks, code) => blocks.find((block) => block.code === code && block.items.length)
    || blocks.find((block) => block.items.length)
    || blocks[0]
    || null
  const activeXbox = pickRegion(xboxRegions, xboxRegion)
  const activeNintendo = pickRegion(nintendoRegions, nintendoRegion)
  const xbox = activeXbox?.items || []
  const nintendo = activeNintendo?.items || []
  const sourceErrors = payload?.errors || []
  const hasAny = epicCurrent.length || epicUpcoming.length || steam.length || other.length
    || xboxRegions.some((block) => block.items.length) || nintendoRegions.some((block) => block.items.length)

  const selectRegion = (platform, code) => {
    if (platform === 'xbox') setXboxRegion(code)
    else setNintendoRegion(code)
    writeRegion(platform, code)
  }

  const rateHint = (() => {
    if (!fx) return ''
    const currencies = [...new Set([activeXbox?.currency, activeNintendo?.currency, 'USD'].filter(Boolean))]
    const parts = currencies
      .filter((currency) => currency !== 'CNY' && fx.rateToCny?.[currency])
      .map((currency) => `1 ${currency} ≈ ¥${Number(fx.rateToCny[currency]).toFixed(4)}`)
    return parts.join(' · ')
  })()

  if (loading && !payload) {
    return (
      <section className="deals-board" aria-label="薅羊毛福利">
        <div className="panel-head dashboard-section-head deals-head">
          <div>
            <h3>薅羊毛 · 限时福利</h3>
            <p>正在同步 Epic 喜加一、Steam 折扣与其它平台限时福利…</p>
          </div>
        </div>
        <div className="dashboard-empty">正在获取福利数据…</div>
      </section>
    )
  }

  return (
    <section className="deals-board" aria-label="薅羊毛福利">
      <div className="panel-head dashboard-section-head deals-head">
        <div>
          <h3>薅羊毛 · 限时福利</h3>
          <p>Epic 喜加一、Steam 超值折扣、主机特惠与其它平台限时领取。外币价格按实时汇率折算人民币，领取时效以官方页面为准。</p>
        </div>
        <div className="deals-head-meta">
          <span className="deals-updated">{payload?.updatedAt ? `更新于 ${formatUpdatedAt(payload.updatedAt)}` : '尚未获取'}</span>
          <button type="button" className="deals-refresh" onClick={() => load({ force: true })} disabled={refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && (
        <div className="deals-error">
          <span>{error}</span>
          <button type="button" onClick={() => load({ force: true })}>重试</button>
        </div>
      )}
      {sourceErrors.length > 0 && (
        <p className="deals-source-warning">
          部分数据源暂时不可用（{sourceErrors.map((item) => sourceLabel(item.source)).join('、')}），该板块可能为空，稍后刷新即可恢复。
        </p>
      )}

      {!hasAny && !error && <div className="dashboard-empty">暂时没有可展示的福利，稍后再来看看。</div>}

      {(epicCurrent.length > 0 || epicUpcoming.length > 0) && (
        <section className="deals-block">
          <div className="deals-block-head">
            <h4>Epic 喜加一</h4>
            <span>每周四 23:00 换榜，领到手永久入库</span>
          </div>
          <div className="deals-grid deals-grid-epic">
            {epicCurrent.map((item) => {
              const urgent = isUrgent(item.endAt, now)
              return (
                <a className={`deal-card deal-epic${urgent ? ' urgent' : ''}`} href={item.url} target="_blank" rel="noreferrer" key={item.id}>
                  <div className="deal-cover deal-cover-wide">
                    <img src={item.image} alt="" loading="lazy" onError={handleCoverError} />
                    <span className="deal-flag deal-flag-free">本周免费</span>
                  </div>
                  <div className="deal-body">
                    <h5 className="deal-title">{item.title}</h5>
                    <div className="deal-meta-row">
                      {item.worth && <span className="deal-worth">原价 {item.worth}</span>}
                      {item.endAt && (
                        <span className={`deal-countdown${urgent ? ' urgent' : ''}`}>
                          <ClockIcon /> {countdownText(item.endAt, now)}
                        </span>
                      )}
                    </div>
                    <span className="deal-cta">去领取</span>
                  </div>
                </a>
              )
            })}
          </div>
          {epicUpcoming.length > 0 && (
            <div className="deals-upcoming">
              <span className="deals-upcoming-label">即将喜加一</span>
              <ul className="deals-upcoming-list">
                {epicUpcoming.map((item) => (
                  <li key={item.id}>
                    <span className="deals-upcoming-title">{item.title}</span>
                    <span className="deals-upcoming-time">{formatClock(item.startAt)} 开始</span>
                    {item.worth && <span className="deals-upcoming-worth">原价 {item.worth}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {steam.length > 0 && (
        <section className="deals-block">
          <div className="deals-block-head">
            <h4>Steam 限时折扣</h4>
            <span>中国区价格，按折扣力度排序（限时免费优先）</span>
          </div>
          <div className="deals-grid deals-grid-steam">
            {steam.map((item) => (
              <a className="deal-card deal-steam" href={item.url} target="_blank" rel="noreferrer" key={item.appId}>
                <div className="deal-cover deal-cover-capsule">
                  <img src={item.image} alt="" loading="lazy" onError={(event) => handleCoverError(event, item.appId)} />
                  <span className={`deal-flag${item.free ? ' deal-flag-free' : ' deal-flag-discount'}`}>
                    {item.free ? '限时免费' : `-${item.discount}%`}
                  </span>
                </div>
                <div className="deal-body">
                  <h5 className="deal-title" title={item.title}>{item.title}</h5>
                  <div className="deal-price-row">
                    {item.priceOriginalText && <s>{item.priceOriginalText}</s>}
                    <strong>{item.priceFinalText || '免费'}</strong>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {(xboxRegions.length > 0 || nintendoRegions.length > 0) && (
        <section className="deals-block">
          <div className="deals-block-head">
            <h4>主机特惠</h4>
            <span>微软商店与 Nintendo eShop 折扣，外币已按实时汇率折算人民币</span>
          </div>
          <div className="deals-console-groups">
            {activeXbox && (
              <div className="deals-console-group">
                <div className="deals-console-head">
                  <span className="deals-console-brand brand-xbox">Xbox</span>
                  <span className="deals-console-note">微软商店本周特惠</span>
                </div>
                <div className="deals-region-switch" role="tablist" aria-label="Xbox 区服">
                  {xboxRegions.map((block) => (
                    <button
                      key={block.code}
                      type="button"
                      role="tab"
                      aria-selected={block.code === activeXbox.code}
                      className={`deals-region-btn${block.code === activeXbox.code ? ' active' : ''}${block.items.length ? '' : ' empty'}`}
                      disabled={!block.items.length}
                      onClick={() => selectRegion('xbox', block.code)}
                    >
                      {block.label}
                    </button>
                  ))}
                </div>
                <ul className="deals-console-list">
                  {xbox.map((item) => (
                    <li key={item.id}>
                      <a className="deals-console-item" href={item.url} target="_blank" rel="noreferrer">
                        <span className="deals-console-thumb">
                          <img src={item.image} alt="" loading="lazy" onError={handleCoverError} />
                        </span>
                        <span className="deals-console-body">
                          <span className="deals-console-title" title={item.publisher ? `${item.title} · ${item.publisher}` : item.title}>
                            {item.title}
                          </span>
                          <span className="deals-console-prices">
                            <span className="deals-console-off">-{item.off}%</span>
                            <s title={formatMoney(item.priceOriginal, item.currency)}>
                              {item.priceOriginalCny != null ? formatCny(item.priceOriginalCny) : formatMoney(item.priceOriginal, item.currency)}
                            </s>
                            <strong>{item.priceSaleCny != null ? formatCny(item.priceSaleCny) : formatMoney(item.priceSale, item.currency)}</strong>
                            <em className="deals-console-orig">{formatMoney(item.priceSale, item.currency)}</em>
                          </span>
                        </span>
                        {item.endAt && (
                          <span className={`deals-console-end${isUrgent(item.endAt, now) ? ' urgent' : ''}`}>
                            <ClockIcon /> {countdownText(item.endAt, now)}
                          </span>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {activeNintendo && (
              <div className="deals-console-group">
                <div className="deals-console-head">
                  <span className="deals-console-brand brand-nintendo">Nintendo</span>
                  <span className="deals-console-note">Nintendo eShop 在折</span>
                </div>
                <div className="deals-region-switch" role="tablist" aria-label="Nintendo 区服">
                  {nintendoRegions.map((block) => (
                    <button
                      key={block.code}
                      type="button"
                      role="tab"
                      aria-selected={block.code === activeNintendo.code}
                      className={`deals-region-btn${block.code === activeNintendo.code ? ' active' : ''}${block.items.length ? '' : ' empty'}`}
                      disabled={!block.items.length}
                      onClick={() => selectRegion('nintendo', block.code)}
                    >
                      {block.label}
                    </button>
                  ))}
                </div>
                <ul className="deals-console-list">
                  {nintendo.map((item) => (
                    <li key={item.id}>
                      <a className="deals-console-item" href={item.url} target="_blank" rel="noreferrer">
                        <span className="deals-console-thumb">
                          <img src={item.image} alt="" loading="lazy" onError={handleCoverError} />
                        </span>
                        <span className="deals-console-body">
                          <span className="deals-console-title" title={`${item.title} · ${item.regionLabel}`}>{item.title}</span>
                          <span className="deals-console-prices">
                            <span className="deals-console-off">-{item.off}%</span>
                            <s title={formatMoney(item.priceOriginal, item.currency)}>
                              {item.priceOriginalCny != null ? formatCny(item.priceOriginalCny) : formatMoney(item.priceOriginal, item.currency)}
                            </s>
                            <strong>{item.priceSaleCny != null ? formatCny(item.priceSaleCny) : formatMoney(item.priceSale, item.currency)}</strong>
                            <em className="deals-console-orig">{formatMoney(item.priceSale, item.currency)}</em>
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <p className="deals-note deals-console-foot">
            {fx
              ? <>汇率：{rateHint}（更新于 {formatUpdatedAt(fx.updatedAt)}，来源 {fx.source}，每日更新一次）。</>
              : <>暂时没拿到汇率，价格按原币种展示。</>}
            外币价格按汇率折算，实际支付金额以商店结算为准；Xbox 卡片标的是该次折扣的结束时间，任天堂 eShop 未提供结束时间。
            任天堂官方港区 / 日区站点有反爬限制，暂无公开数据源，可切换其它区参考。
          </p>
        </section>
      )}

      {other.length > 0 && (
        <section className="deals-block">
          <div className="deals-block-head">
            <h4>其他平台福利</h4>
            <span>DRM-Free、itch.io、IndieGala 等第三方平台的限时免费领</span>
          </div>
          <ul className="deals-other-list">
            {other.map((item) => (
              <li key={item.id}>
                <a className="deals-other-item" href={item.url} target="_blank" rel="noreferrer">
                  <span className="deals-other-thumb">
                    <img src={item.image} alt="" loading="lazy" onError={handleCoverError} />
                  </span>
                  <span className="deals-other-body">
                    <span className="deals-other-title">{item.title}</span>
                    <span className="deals-other-tags">
                      <span className="pill deal-type-tag">{otherTypeLabel(item.type)}</span>
                      {platformTags(item.platforms).slice(0, 4).map((name) => (
                        <span className="pill deal-platform-tag" key={name}>{name}</span>
                      ))}
                      {item.worth && <span className="deals-other-worth">价值 {item.worth}</span>}
                      {item.worthCny != null && <span className="deals-other-worth-cny">≈ {formatCny(item.worthCny)}</span>}
                    </span>
                  </span>
                  <span className="deals-other-side">
                    {item.endAt
                      ? <span className={`deal-countdown${isUrgent(item.endAt, now) ? ' urgent' : ''}`}><ClockIcon /> {countdownText(item.endAt, now)}</span>
                      : <span className="deals-other-notime">限时领取</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <div className="deals-other-foot">
            <p className="deals-note">
              以上条目来自第三方福利聚合站（GamerPower），部分领取页需要注册或完成任务，请自行判断安全性：
              不要在非官方页面输入 Steam / Epic 账号密码，也不要下载来路不明的客户端。
            </p>
            {onOpenCoins && (
              <button type="button" className="outline-button compact" onClick={onOpenCoins}>
                用金币直接换游戏更省事 →
              </button>
            )}
          </div>
        </section>
      )}
    </section>
  )
}
