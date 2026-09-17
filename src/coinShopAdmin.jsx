import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'

const ADMIN_SESSION_KEY = 'keyflow_admin_session'
const getAdminToken = () => {
  try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY))?.session_token || null } catch { return null }
}

// 虚拟卡密商品（非报销 + 虚拟履约）必须绑定产品 Key 池才能上架
const isVirtualKeyProduct = (item) => Boolean(item)
  && item.category !== 'reimbursement'
  && (item.fulfillment_type || 'virtual') === 'virtual'

const parseSteamAppId = (url) => (String(url || '').match(/store\.steampowered\.com\/app\/(\d+)/) || [])[1] || ''

// 答主选择器：可搜索（知乎名 / 微信 / 备注），原生 select 无法搜索且之前列表是空的
function AnswererPicker({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef(null)
  const selected = (options || []).find((item) => item.id === value) || null
  const kw = keyword.trim().toLowerCase()
  const list = useMemo(() => {
    const all = options || []
    const matched = kw
      ? all.filter((item) => `${item.zhihu_name || ''} ${item.wechat_id || ''} ${item.remark || ''}`.toLowerCase().includes(kw))
      : all
    return matched.slice(0, 200)
  }, [options, kw])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event) => { if (!wrapRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener("mousedown", onDocMouseDown)
    return () => document.removeEventListener("mousedown", onDocMouseDown)
  }, [open])

  const pick = (item) => {
    onChange(item.id)
    setKeyword("")
    setOpen(false)
  }

  const onKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (!open) { setOpen(true); setActiveIndex(0); return }
      if (!list.length) return
      setActiveIndex(event.key === "ArrowDown" ? (activeIndex + 1) % list.length : (activeIndex - 1 + list.length) % list.length)
    } else if (event.key === "Enter" && open && list.length) {
      event.preventDefault()
      pick(list[Math.min(activeIndex, list.length - 1)])
    } else if (event.key === "Escape") {
      setOpen(false)
    }
  }

  return <div className="product-picker" ref={wrapRef}>
    <div className="product-picker-input">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input
        value={keyword}
        placeholder={selected ? selected.zhihu_name : "搜索答主（知乎名 / 微信 / 备注）"}
        onChange={(event) => { setKeyword(event.target.value); setOpen(true); setActiveIndex(0) }}
        onFocus={() => { setOpen(true); setActiveIndex(0) }}
        onClick={() => { setOpen(true); setActiveIndex(0) }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
      />
      {value ? <button type="button" className="product-picker-clear" aria-label="清空答主" onClick={() => { onChange(""); setKeyword(""); setOpen(true) }}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button> : null}
    </div>
    {(options || []).length === 0 && !open ? <small style={{ color: "var(--c-ink-4)" }}>答主列表加载中或不可用，可点输入框重试</small> : null}
    {selected ? <small style={{ color: "var(--c-ink-3)" }}>已选：<b>{selected.zhihu_name}</b>{selected.remark ? `（${selected.remark}）` : ""}</small> : null}
    {open && <div className="product-picker-list" role="listbox">
      {list.length ? list.map((item, index) => <button
        type="button"
        key={item.id}
        role="option"
        aria-selected={index === activeIndex}
        className={`product-picker-option${index === activeIndex ? " active" : ""}${item.id === value ? " selected" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => pick(item)}
      >
        <span className="product-picker-name">{item.zhihu_name}</span>
        <span className="product-picker-meta">{[item.remark, item.wechat_id].filter(Boolean).join(" · ") || "—"}</span>
      </button>) : <div className="product-picker-empty">{(options || []).length ? "没有匹配的答主" : "答主列表为空：请刷新页面或重新登录管理员"}</div>}
    </div>}
  </div>
}

// 产品名选择器：自定义下拉（原生 datalist 选过一次后只筛当前值，切不了别的产品）
function ProductNamePicker({ value, onChange, options, invalid }) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  // 只有用户真的在输入时才按关键字过滤；一聚焦先展示全部产品，方便随时切换（原生 datalist 的坑）
  const [typed, setTyped] = useState(false)
  const wrapRef = useRef(null)
  const keyword = String(value || '').trim().toLowerCase()
  const list = useMemo(() => {
    const matched = typed && keyword
      ? options.filter((pool) => String(pool.product_name || '').toLowerCase().includes(keyword))
      : options
    return [...matched].sort((a, b) => (Number(b.pool_available) || 0) - (Number(a.pool_available) || 0))
  }, [options, keyword, typed])

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (event) => { if (!wrapRef.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocMouseDown)
    // 打开时把当前选中的产品滚进可视区
    wrapRef.current?.querySelector('.product-picker-option.selected')?.scrollIntoView({ block: 'nearest' })
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open, list.length])

  const pick = (pool) => {
    onChange(pool.product_name, pool)
    setOpen(false)
    setTyped(false)
  }

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); setActiveIndex(0); return }
      if (!list.length) return
      const next = event.key === 'ArrowDown' ? (activeIndex + 1) % list.length : (activeIndex - 1 + list.length) % list.length
      setActiveIndex(next)
    } else if (event.key === 'Enter' && open && list.length) {
      event.preventDefault()
      pick(list[Math.min(activeIndex, list.length - 1)])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return <div className="product-picker" ref={wrapRef}>
    <div className={`product-picker-input${invalid ? ' invalid' : ''}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input
        value={value || ''}
        placeholder="搜索/选择产品名（可切换）"
        onChange={(event) => { onChange(event.target.value); setTyped(true); setOpen(true); setActiveIndex(0) }}
        onFocus={() => { setTyped(false); setOpen(true); setActiveIndex(0) }}
        onClick={() => { setTyped(false); setOpen(true); setActiveIndex(0) }}
        onKeyDown={onKeyDown}
        aria-expanded={open}
        aria-invalid={invalid}
        role="combobox"
      />
      {value ? <button type="button" className="product-picker-clear" aria-label="清空产品名" onClick={() => { onChange(''); setTyped(false); setOpen(true) }}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button> : null}
    </div>
    {open && <>
      <div className="product-picker-list" role="listbox">
        {list.length ? list.map((pool, index) => <button
          type="button"
          key={pool.activity_id}
          role="option"
          aria-selected={index === activeIndex}
          className={`product-picker-option${index === activeIndex ? ' active' : ''}${String(pool.product_name) === String(value || '').trim() ? ' selected' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => pick(pool)}
        >
          <span className="product-picker-name">{pool.product_name}</span>
          <span className="product-picker-meta">{pool.activity_type === 'merch' ? '产品' : '游戏'} · 池子剩 {pool.pool_available ?? 0}</span>
        </button>) : <div className="product-picker-empty">{options.length ? '没有匹配的产品，可在「剩余KEY管理」先录入该产品的 Key' : '还没有任何产品 Key 池，请先在「剩余KEY管理」录入'}</div>}
      </div>
    </>}
  </div>
}

export default function CoinShopAdmin() {
  const [tab, setTab] = useState('catalog')
  const [catalog, setCatalog] = useState(null)
  const [orders, setOrders] = useState(null)
  const [reimbursementOrders, setReimbursementOrders] = useState(null)
  const [answerers, setAnswerers] = useState(null)
  const [backendError, setBackendError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [draft, setDraft] = useState({ title: '', description: '', image_url: '', card_tags: '', category: 'game', cost_coins: 1000, reimbursement_discount: 8, min_level: 0, stock_total: 5, fulfillment_type: 'virtual', product_name: '' })
  const [draftImageName, setDraftImageName] = useState('')
  const [editingItem, setEditingItem] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [editImageName, setEditImageName] = useState('')
  const [adjust, setAdjust] = useState({ answerer_id: '', amount: 100, note: '' })
  const [coinScaleConfig, setCoinScaleConfig] = useState(null)
  const [coinScaleDraft, setCoinScaleDraft] = useState('1')
  const [levelConfig, setLevelConfig] = useState([])
  const [coinLevelCounts, setCoinLevelCounts] = useState([])
  const [configBusy, setConfigBusy] = useState(false)
  // 商品 ↔ 产品 Key 池（keyflow_admin_product_pools / keyflow_shop_catalog_pools）
  const [productPools, setProductPools] = useState([])
  const [catalogPools, setCatalogPools] = useState({})
  const [poolsError, setPoolsError] = useState('')
  const [dragIndex, setDragIndex] = useState(null)
  const [orderSaving, setOrderSaving] = useState(false)
  // 「必须绑定产品才能上架」的弹窗提示
  const [bindingPrompt, setBindingPrompt] = useState(null)
  // 发货弹窗 + 自动带价提示
  const [fulfillTarget, setFulfillTarget] = useState(null)
  const [fulfillForm, setFulfillForm] = useState({ text: '', carrier: '', tracking: '' })
  const [priceHint, setPriceHint] = useState('')
  // 答主 → 知乎 member_id（腾讯文档工作表1 的 K 列），报销订单列表与补发 csv 共用
  const [memberIds, setMemberIds] = useState({ byId: {}, byName: {}, loadedAt: 0 })
  // 金币概览（汇总 / 消耗明细 / 每人余额），管理员 RPC 返回
  const [coinOverview, setCoinOverview] = useState(null)
  const adminToken = getAdminToken()

  const refresh = async () => {
    const [catRes, ordRes, reimbRes, projRes, cfgRes, lvlRes, poolRes, bindRes, ansRes, ovRes] = await Promise.all([
      supabase.from('keyflow_reward_catalog').select('*').order('sort_order', { ascending: true }),
      supabase.rpc('keyflow_admin_redeem_orders', { p_token: adminToken }),
      supabase.rpc('keyflow_admin_game_reimbursement_orders', { p_token: adminToken }),
      supabase.rpc('keyflow_admin_coin_scale_levels', { p_token: adminToken }),
      supabase.from('keyflow_economy_config').select('key,value,updated_at').eq('key', 'coin_scale_s').maybeSingle(),
      supabase.from('keyflow_level_config').select('level,daily_coins').order('level', { ascending: true }),
      supabase.rpc('keyflow_admin_product_pools', { p_token: adminToken }),
      supabase.rpc('keyflow_shop_catalog_pools'),
      supabase.rpc('keyflow_admin_answerer_summaries', { p_token: adminToken }),
      supabase.rpc('keyflow_admin_coins_overview', { p_token: adminToken }),
    ])

    // 商品、真实等级分布、系数和等级配置是关键数据；订单/答主列表权限失败不应阻塞系数设置。
    const criticalErrors = [catRes.error, projRes.error, cfgRes.error, lvlRes.error].filter(Boolean)
    setBackendError(criticalErrors.map(e => e.message).join('；'))
    setCatalog(catRes.error ? [] : (catRes.data || []))
    setCoinLevelCounts(projRes.error ? [] : (projRes.data || []))
    // 手动调币要能搜答主，这里必须真的把答主列表读出来（原来固定置空，导致下拉是空的）
    if (ansRes.error) console.warn('答主列表暂不可用：', ansRes.error.message)
    setAnswerers(ansRes.error ? [] : (ansRes.data || []))
    if (ordRes.error) console.warn('兑换订单暂不可用：', ordRes.error.message)
    if (reimbRes.error) console.warn('报销订单暂不可用：', reimbRes.error.message)
    if (ovRes.error) console.warn('金币概览暂不可用：', ovRes.error.message)
    setCoinOverview(ovRes.error ? null : (ovRes.data || null))
    setOrders(ordRes.error ? [] : (ordRes.data || []))
    setReimbursementOrders(reimbRes.error ? [] : (reimbRes.data || []))

    const nextScale = cfgRes.error ? null : cfgRes.data
    setCoinScaleConfig(nextScale)
    setCoinScaleDraft(String(Number(nextScale?.value ?? 1)))
    setLevelConfig(lvlRes.error ? [] : (lvlRes.data || []))
    if (poolRes.error) console.warn('产品 Key 池暂不可用：', poolRes.error.message)
    if (bindRes.error) console.warn('商品绑定信息暂不可用：', bindRes.error.message)
    setPoolsError(poolRes.error ? poolRes.error.message : '')
    setProductPools(poolRes.error ? [] : (poolRes.data || []))
    setCatalogPools(Object.fromEntries((bindRes.error ? [] : (bindRes.data || [])).map((row) => [row.catalog_id, row])))
  }

  useEffect(() => { refresh() }, [])

  // 读取「答主 → 知乎 member_id」映射（来自腾讯文档工作表1 的 K 列，经边缘函数代理）
  const loadMemberIds = useCallback(async (force = false) => {
    if (!force && memberIds.loadedAt && Date.now() - memberIds.loadedAt < 60000) return memberIds
    const { data, error } = await supabase.functions.invoke('answerer-member-ids', { body: { adminToken } })
    if (error || data?.error || !data?.success) {
      console.warn('member_id 映射暂不可用：', data?.error || error?.message || '未知错误')
      setMemberIds((prev) => ({ ...prev, loadedAt: Date.now() }))
      return null
    }
    const next = { byId: data.byId || {}, byName: data.byName || {}, loadedAt: Date.now() }
    setMemberIds(next)
    return next
  }, [adminToken, memberIds])

  // 进入报销订单页时拉一次（60 秒内复用缓存）
  useEffect(() => { if (tab === 'reimbursements') loadMemberIds() }, [tab, loadMemberIds])

  const memberIdOf = (order) => memberIds.byId?.[order.answerer_id] || memberIds.byName?.[order.answerer_name] || ''

  const nameById = useMemo(() => {
    const map = {}
    ;(answerers || []).forEach(a => { map[a.id] = a.zhihu_name })
    return map
  }, [answerers])

  const catalogTitleById = useMemo(() => {
    const map = {}
    ;(catalog || []).forEach(c => { map[c.id] = c.title })
    return map
  }, [catalog])

  const catalogById = useMemo(() => Object.fromEntries((catalog || []).map((item) => [item.id, item])), [catalog])

  const savedCoinScale = Number(coinScaleConfig?.value ?? 1) || 0
  const previewCoinScaleRaw = Number(coinScaleDraft)
  const previewCoinScale = Number.isFinite(previewCoinScaleRaw)
    ? Math.max(0, Math.min(10, previewCoinScaleRaw))
    : savedCoinScale

  const levelDailyBase = useMemo(() => {
    const map = {}
    ;(levelConfig || []).forEach((item) => { map[item.level] = Number(item.daily_coins) || 0 })
    return map
  }, [levelConfig])

  const fallbackDailyCoins = (level) => {
    const monthly = level <= 10 ? 2500 * level
      : level <= 20 ? 25000 + 2000 * (level - 10)
      : level <= 30 ? 45000 + 1250 * (level - 20)
      : level <= 40 ? 57500 + 750 * (level - 30)
      : level <= 50 ? 65000 + 500 * (level - 40)
      : 70000
    return Math.round(monthly / 30)
  }

  const coinProjection = useMemo(() => {
    // 没有真实数据时不伪造 1-10 空表；有数据时固定展示 Lv1-10，便于比较完整曲线。
    if (!coinLevelCounts?.length) return []
    const countByLevel = new Map(coinLevelCounts.map((item) => [Number(item.level), {
      people: Number(item.people) || 0,
      todayActiveCount: Number(item.today_active_count) || 0,
      monthActiveCount: Number(item.month_active_count) || 0,
    }]))
    return Array.from({ length: 10 }, (_, index) => {
      const level = index + 1
      const count = countByLevel.get(level)?.people || 0
      const todayActiveCount = countByLevel.get(level)?.todayActiveCount || 0
      const monthActiveCount = countByLevel.get(level)?.monthActiveCount || 0
      const baseDaily = levelDailyBase[level] ?? fallbackDailyCoins(level)
      const currentDailyPerPerson = Math.round(baseDaily * savedCoinScale)
      const previewDailyPerPerson = Math.round(baseDaily * previewCoinScale)
      const currentDaily = currentDailyPerPerson * count
      const previewDaily = previewDailyPerPerson * count
      const currentMonthly = currentDaily * 30
      const previewMonthly = previewDaily * 30
      return {
        level,
        count,
        todayActiveCount,
        monthActiveCount,
        baseDaily,
        currentDailyPerPerson,
        previewDailyPerPerson,
        currentDaily,
        previewDaily,
        currentMonthly,
        previewMonthly,
        monthlyDelta: previewMonthly - currentMonthly,
      }
    })
  }, [coinLevelCounts, levelDailyBase, savedCoinScale, previewCoinScale])

  const projectionTotals = coinProjection.reduce((acc, row) => ({
    currentDaily: acc.currentDaily + row.currentDaily,
    currentMonthly: acc.currentMonthly + row.currentMonthly,
    previewDaily: acc.previewDaily + row.previewDaily,
    previewMonthly: acc.previewMonthly + row.previewMonthly,
    todayActiveCount: acc.todayActiveCount + row.todayActiveCount,
    monthActiveCount: acc.monthActiveCount + row.monthActiveCount,
  }), { currentDaily: 0, currentMonthly: 0, previewDaily: 0, previewMonthly: 0, todayActiveCount: 0, monthActiveCount: 0 })

  const maxProjectionMonthly = Math.max(1, ...coinProjection.map(row => row.previewMonthly))

  const updateCoinScale = async (event) => {
    event.preventDefault()
    const value = Number(coinScaleDraft)
    if (!Number.isFinite(value) || value < 0 || value > 10) { setMsg('S 系数必须是 0 到 10 之间的数字'); return }
    setConfigBusy(true)
    const { data, error } = await supabase.rpc('keyflow_admin_update_coin_scale', {
      p_token: adminToken,
      p_scale: value,
    })
    setConfigBusy(false)
    if (error) { setMsg(error.message); return }
    setCoinScaleConfig(data)
    setCoinScaleDraft(String(Number(data?.value ?? value)))
    setMsg(`S 系数已更新为 ${Number(data?.value ?? value)}`)
    refresh()
  }

  const handleImageFile = (file, setValue, setName) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setMsg('头图仅支持 JPG、PNG 或 WebP 格式'); return }
    if (file.size > 500 * 1024) { setMsg('头图大小不能超过 500KB'); return }
    const reader = new FileReader()
    reader.onload = () => { setValue(reader.result); setName(file.name) }
    reader.onerror = () => setMsg('头图读取失败，请重试')
    reader.readAsDataURL(file)
  }

  // 选了游戏/卡密的产品后，默认带出该游戏入库时的封面、游戏名、「游戏」关键词和当天 Steam 中国区 9 折价格
  const applyProductDefaults = async (pool, setValue, current) => {
    if (!pool) return
    const appId = parseSteamAppId(pool.steam_url)
    const gameName = String(pool.product_name || '').replace(/^《|》$/g, '')
    const next = {
      ...current,
      product_name: pool.product_name,
      // 游戏类商品名默认「游戏名 兑换码」（书名号已在 gameName 里去掉，避免出现《《x》》）
      title: gameName ? `${gameName} 兑换码` : (pool.product_name || current.title),
      description: gameName ? `游戏《${gameName}》Steam 兑换码` : current.description,
      card_tags: '游戏',
      image_url: pool.game_cover || current.image_url,
      cost_coins: 1000,
    }
    setValue(next)
    setPriceHint(appId ? '正在获取该游戏当天的 Steam 中国区价格…' : '该产品没有 Steam 地址，兑换金币按默认 1000')
    if (!appId) return
    const { data, error } = await supabase.functions.invoke('steam-appdetails', { body: { appId } })
    const price = Number(data?.game?.price_cny)
    if (error || !data?.success || !Number.isFinite(price) || price <= 0) {
      setPriceHint('没取到 Steam 中国区价格，兑换金币按默认 1000（可手动改）')
      return
    }
    const coins = Math.round(price * 0.9 * 100)
    setValue((prev) => ({ ...prev, cost_coins: coins }))
    setPriceHint(`按当天 Steam 中国区价 ¥${price} 打 9 折：${coins} 金币（1 金币 = ¥0.01，可手动改）`)
  }

  const renderProductFormFields = (value, setValue, imageName, setImageName, imageButtonText, autoFill = false) => <>
    <label className="field"><span>商品名</span><input value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} required placeholder="如：某独立游戏 Key / Steam 充值卡 ¥50" /></label>
    {isVirtualKeyProduct({ category: value.category, fulfillment_type: value.fulfillment_type }) && (() => {
      const name = String(value.product_name || '').trim()
      const matched = name ? productPools.find((pool) => String(pool.product_name || '').trim() === name) : null
      const missing = Boolean(name) && !matched
      return <div className="field coin-product-binding">
        <span>产品名（Key 池）</span>
        <ProductNamePicker
          value={value.product_name || ''}
          onChange={(next, pool) => {
            const nextValue = { ...value, product_name: next }
            setValue(nextValue)
            if (pool && autoFill && nextValue.category === 'game') applyProductDefaults(pool, setValue, nextValue)
          }}
          options={productPools}
          invalid={missing}
        />
        {missing
          ? <small className="coin-product-binding-error">{poolsError
            ? `产品列表读取失败（${poolsError}）：请刷新页面或重新登录管理员后再试。`
            : '未找到该产品：请先在「剩余KEY管理」用「Key 码 + 产品名」录入 Key，再回来绑定。'}</small>
          : matched
            ? <small>池子剩余 <b>{matched.pool_available ?? 0}</b> 个（已领取 {matched.pool_claimed ?? 0} 个）；兑换时从这里自动发 Key。</small>
            : <small>{isVirtualKeyProduct({ category: value.category, fulfillment_type: value.fulfillment_type })
              ? '虚拟卡密商品必须绑定产品才能上架；先下架可暂不绑定。'
              : '实体商品可留空，由运营按收货信息发货。'}</small>}
      </div>
    })()}
    <div className="field coin-product-image"><span>头图</span><label className="outline-button compact">{imageButtonText}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleImageFile(e.target.files?.[0], (image_url) => setValue({ ...value, image_url }), setImageName)} hidden /></label><small>JPG、PNG 或 WebP，≤500KB</small>{imageName && <small>{imageName}</small>}{value.image_url && <img src={value.image_url} alt="头图预览" />}</div>
    <label className="field"><span>卡片简介</span><textarea value={value.description} onChange={(e) => setValue({ ...value, description: e.target.value })} placeholder="如：精选兑换商品" maxLength="80" rows="2" /><small>显示在前台商品卡片标题下方，最多 80 字。</small></label>
    <label className="field"><span>卡片关键词</span><input value={value.card_tags} onChange={(e) => setValue({ ...value, card_tags: e.target.value })} placeholder="如：游戏报销, 3D 测试" /><small>多个关键词用逗号分隔，最多显示两个。</small></label>
    <label className="field"><span>类型</span><select value={value.category} onChange={(e) => {
      const category = e.target.value
      // 实体周边 = 实体履约（不再需要产品 Key 池）；其余类型回到虚拟履约
      setValue({ ...value, category, fulfillment_type: category === 'physical' ? 'physical' : 'virtual', ...(category === 'physical' ? { product_name: '' } : {}) })
      setPriceHint('')
    }}><option value="game">游戏/卡密（虚拟）</option><option value="physical">实体周边</option><option value="other">其它</option><option value="reimbursement">报销产品</option></select></label>
    {value.category === 'reimbursement' ? <label className="field"><span>折扣等级</span><input type="number" min="0" max="10" step="0.1" value={value.reimbursement_discount} onChange={(e) => setValue({ ...value, reimbursement_discount: e.target.value })} required /><small>填写 8 表示 8 折，金币按游戏价格 × 0.8 × 100 扣除。</small></label> : <><label className="field"><span>兑换金币</span><input type="number" min="1" value={value.cost_coins} onChange={(e) => setValue({ ...value, cost_coins: e.target.value })} />{autoFill && priceHint ? <small style={{ color: 'var(--c-ink-3)' }}>{priceHint}</small> : null}</label><label className="field"><span>入库库存</span><input type="number" min="0" value={value.stock_total} onChange={(e) => setValue({ ...value, stock_total: e.target.value })} /></label>{value.category !== 'physical' && <label className="field"><span>履约方式</span><select value={value.fulfillment_type} onChange={(e) => setValue({ ...value, fulfillment_type: e.target.value })}><option value="virtual">虚拟（后台发 Key/卡密）</option><option value="physical">实体（需收货地址）</option></select></label>}</>}
    <label className="field"><span>所需等级（0=不限）</span><input type="number" min="0" max="100" value={value.min_level} onChange={(e) => setValue({ ...value, min_level: e.target.value })} /></label>
  </>

  const openEditProduct = (item) => {
    setEditingItem(item)
    setEditDraft({ title: item.title || '', description: item.description || '', image_url: item.image_url || '', card_tags: item.card_tags || '', category: item.category || 'game', cost_coins: item.cost_coins, reimbursement_discount: item.reimbursement_discount ?? 8, min_level: item.min_level, stock_total: item.stock_total, fulfillment_type: item.fulfillment_type || 'virtual', product_name: catalogPools[item.id]?.product_name || '' })
    setEditImageName('')
  }

  const closeEditProduct = () => {
    setEditingItem(null)
    setEditDraft(null)
    setEditImageName('')
  }

  const updateProduct = async (e) => {
    e.preventDefault()
    if (backendError || !editingItem || !editDraft) { setMsg('数据库未升级，无法写入'); return }
    const isReimbursement = editDraft.category === 'reimbursement'
    const discount = Number(editDraft.reimbursement_discount)
    if (isReimbursement && (!Number.isFinite(discount) || discount < 0 || discount > 10)) { setMsg('折扣等级必须是 0 到 10 之间的数字'); return }
    const productName = String(editDraft.product_name || '').trim()
    if (!isReimbursement && productName && !productPools.some((pool) => String(pool.product_name || '').trim() === productName)) {
      setMsg(`未找到产品「${productName}」：请先在「剩余KEY管理」录入该产品的 Key`)
      return
    }
    // 已上架的虚拟卡密商品：清空产品名（= 解绑）或本来就没绑，都不允许保存，先弹窗说明
    const nextFulfillment = isReimbursement ? 'virtual' : (editDraft.fulfillment_type || 'virtual')
    if (isVirtualKeyProduct({ category: editDraft.category, fulfillment_type: nextFulfillment })
      && editingItem.status === 'on'
      && !productName) {
      setBindingPrompt({ title: editDraft.title || editingItem.title, scene: 'save' })
      return
    }
    const stockTotal = isReimbursement ? 0 : Number(editDraft.stock_total) || 0
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_update_reward_catalog', {
      p_token: adminToken,
      p_catalog_id: editingItem.id,
      p_product: {
        ...editDraft,
        cost_coins: isReimbursement ? 1 : Number(editDraft.cost_coins) || 0,
        reimbursement_discount: Number.isFinite(discount) ? discount : 8,
        min_level: Number(editDraft.min_level) || 0,
        stock_total: stockTotal,
        fulfillment_type: isReimbursement ? 'virtual' : editDraft.fulfillment_type,
        product_name: isReimbursement ? '' : productName,
      },
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    closeEditProduct()
    setMsg('商品已更新')
    refresh()
  }

  const addProduct = async (e) => {
    e.preventDefault()
    if (backendError) { setMsg('数据库未升级，无法写入'); return }
    const isReimbursement = draft.category === 'reimbursement'
    const discount = Number(draft.reimbursement_discount)
    if (isReimbursement && (!Number.isFinite(discount) || discount < 0 || discount > 10)) { setMsg('折扣等级必须是 0 到 10 之间的数字'); return }
    const productName = String(draft.product_name || '').trim()
    if (!isReimbursement && productName && !productPools.some((pool) => String(pool.product_name || '').trim() === productName)) {
      setMsg(`未找到产品「${productName}」：请先在「剩余KEY管理」录入该产品的 Key`)
      return
    }
    // 新建即上架：虚拟卡密商品必须带产品名
    if (isVirtualKeyProduct({ category: draft.category, fulfillment_type: isReimbursement ? 'virtual' : (draft.fulfillment_type || 'virtual') })
      && !productName) {
      setBindingPrompt({ title: draft.title || '新商品', scene: 'create' })
      return
    }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_create_reward_catalog', {
      p_token: adminToken,
      p_product: {
        ...draft,
        cost_coins: isReimbursement ? 1 : Number(draft.cost_coins) || 0,
        reimbursement_discount: Number.isFinite(discount) ? discount : 8,
        min_level: Number(draft.min_level) || 0,
        stock_total: isReimbursement ? 0 : Number(draft.stock_total) || 0,
        fulfillment_type: isReimbursement ? 'virtual' : draft.fulfillment_type,
        product_name: isReimbursement ? '' : productName,
      },
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setDraft({ title: '', description: '', image_url: '', card_tags: '', category: 'game', cost_coins: 1000, reimbursement_discount: 8, min_level: 0, stock_total: 5, fulfillment_type: 'virtual', product_name: '' })
    setDraftImageName('')
    setMsg('商品已上架')
    refresh()
  }

  const toggleProduct = async (item) => {
    if (backendError) return
    // 上架前检查绑定：虚拟卡密商品没绑产品不允许上架
    if (item.status !== 'on' && isVirtualKeyProduct(item) && !catalogPools[item.id]) {
      setBindingPrompt({ title: item.title, scene: 'on' })
      return
    }
    const { error } = await supabase.rpc('keyflow_admin_set_reward_catalog_status', {
      p_token: adminToken,
      p_catalog_id: item.id,
      p_status: item.status === 'on' ? 'off' : 'on',
    })
    if (error) { setMsg(error.message); return }
    refresh()
  }

  const duplicateProduct = async (item) => {
    if (backendError) { setMsg('数据库未升级，无法写入'); return }
    const sourceProductName = catalogPools[item.id]?.product_name || ''
    if (isVirtualKeyProduct(item) && !sourceProductName) {
      setBindingPrompt({ title: item.title, scene: 'duplicate' })
      return
    }
    setBusy(true)
    const product = {
      title: `${item.title}（副本）`,
      description: item.description || '',
      image_url: item.image_url || '',
      card_tags: item.card_tags || '',
      category: item.category || 'game',
      cost_coins: Number(item.cost_coins) || 1,
      reimbursement_discount: Number(item.reimbursement_discount) || 8,
      min_level: Number(item.min_level) || 0,
      stock_total: Number(item.stock_total) || 0,
      fulfillment_type: item.fulfillment_type || 'virtual',
      // 虚拟卡密商品必须绑定才能上架，副本沿用原商品的产品池（可用时）
      product_name: sourceProductName,
    }
    const { data, error } = await supabase.rpc('keyflow_admin_create_reward_catalog', { p_token: adminToken, p_product: product })
    if (error) { setBusy(false); setMsg(error.message); return }
    const newId = data?.id
    // 描述与卡面标签不在创建 RPC 的字段里，补一次更新带上
    if (newId) await supabase.rpc('keyflow_admin_update_reward_catalog', { p_token: adminToken, p_catalog_id: newId, p_product: product })
    // 原商品若已下架，副本也保持下架（创建 RPC 固定上架）
    if (newId && item.status !== 'on') await supabase.rpc('keyflow_admin_set_reward_catalog_status', { p_token: adminToken, p_catalog_id: newId, p_status: item.status })
    setBusy(false)
    setMsg(`已复制「${item.title}」为「${product.title}」`)
    refresh()
  }

  const deleteProduct = async (item) => {
    if (backendError) { setMsg('数据库未升级，无法写入'); return }
    if (!window.confirm(`确定删除商品「${item.title}」吗？已被兑换或已有报销订单的商品无法删除，只能下架。`)) return
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_delete_reward_catalog', { p_token: adminToken, p_catalog_id: item.id })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg(`已删除「${item.title}」`)
    refresh()
  }

  // ① 商品排序：拖拽行或点箭头，顺序即金币商城的展示顺序
  const saveCatalogOrder = async (nextCatalog) => {
    if (backendError) { setMsg('数据库未升级，无法保存顺序'); return }
    setCatalog(nextCatalog)
    setOrderSaving(true)
    const { error } = await supabase.rpc('keyflow_admin_reorder_reward_catalog', {
      p_token: adminToken,
      p_ids: nextCatalog.map((item) => item.id),
    })
    setOrderSaving(false)
    if (error) { setMsg(error.message); refresh(); return }
    setMsg('商品顺序已保存')
    refresh()
  }

  const moveProduct = (from, to) => {
    const list = [...(catalog || [])]
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    saveCatalogOrder(list)
  }

  const doAdjust = async (e) => {
    e.preventDefault()
    if (backendError) { setMsg('数据库未升级，无法调币'); return }
    if (!adjust.answerer_id) { setMsg('请选择答主'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('keyflow_admin_adjust_coins', {
      p_token: adminToken,
      p_answerer_id: adjust.answerer_id,
      p_amount: Number(adjust.amount) || 0,
      p_note: adjust.note || '',
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg(`调整成功，当前余额 ${data}`)
  }

  const openFulfill = (order) => {
    if (backendError) { setMsg('数据库未升级，无法发货'); return }
    // 实物订单：点一下就发货，不再弹窗填快递信息
    if (catalogById[order.catalog_id]?.fulfillment_type === 'physical') { fulfillPhysicalDirect(order); return }
    const fd = order.fulfillment_data || {}
    setFulfillTarget(order)
    setFulfillForm({ text: typeof fd.text === 'string' ? fd.text : '', carrier: fd.carrier || '', tracking: fd.tracking_no || '' })
    setMsg('')
  }

  const fulfillPhysicalDirect = async (order) => {
    const fd = order.fulfillment_data || {}
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_fulfill_redeem', {
      p_token: adminToken,
      p_order_id: order.id,
      p_fulfillment: { name: fd.name || '', phone: fd.phone || '', address: fd.address || '', text: fd.text || '' },
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('已发货')
    refresh()
  }

  const submitFulfill = async () => {
    if (!fulfillTarget) return
    const isPhysical = catalogById[fulfillTarget.catalog_id]?.fulfillment_type === 'physical'
    const recipient = fulfillTarget.fulfillment_data || {}
    let data = {}
    if (isPhysical) {
      data = {
        name: recipient.name || '', phone: recipient.phone || '', address: recipient.address || '',
        carrier: fulfillForm.carrier.trim(), tracking_no: fulfillForm.tracking.trim(),
        text: [fulfillForm.carrier.trim(), fulfillForm.tracking.trim()].filter(Boolean).join(' '),
      }
    } else {
      const text = fulfillForm.text.trim()
      if (text.startsWith('{') || text.startsWith('[')) {
        try { data = JSON.parse(text) } catch { setMsg('看起来是 JSON，但格式不正确，请检查'); return }
      } else {
        data = { text }
      }
    }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_fulfill_redeem', { p_token: adminToken, p_order_id: fulfillTarget.id, p_fulfillment: data })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setFulfillTarget(null)
    setMsg('已发货')
    refresh()
  }

  // 一键下载「未发货的实物订单」，四列：收件人 / 手机 / 地址 / 物品信息
  const downloadPendingPhysicalOrders = () => {
    const pending = (orders || []).filter((order) => order.status === 'pending'
      && catalogById[order.catalog_id]?.fulfillment_type === 'physical')
    if (!pending.length) { setMsg('暂无未发货的实物订单'); return }
    const headers = ['收件人', '手机', '地址', '物品信息']
    const rows = pending.map((order) => {
      const fd = order.fulfillment_data || {}
      const title = order.catalog_title || catalogTitleById[order.catalog_id] || '实物商品'
      return [fd.name || '', fd.phone || '', fd.address || (fd.text || ''), Number(order.qty) > 1 ? `${title} ×${order.qty}` : title]
    })
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `未发货实物订单_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    setMsg(`已导出 ${rows.length} 条未发货实物订单`)
  }

  const cancelOrder = async (order) => {
    if (backendError) { setMsg('数据库未升级，无法取消'); return }
    if (!window.confirm('确认取消该订单并退回金币？')) return
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_cancel_redeem', { p_token: adminToken, p_order_id: order.id })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('已取消并退款')
    refresh()
  }

  const completeReimbursement = async (order) => {
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_update_game_reimbursement', { p_token: adminToken, p_order_id: order.id, p_status: 'completed', p_admin_note: order.admin_note || '' })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('报销订单已完成')
    refresh()
  }

  // 撤回：把「已完成」改回「待处理」（改错点、或需要重新补发时用）
  const reopenReimbursement = async (order) => {
    if (backendError) { setMsg('数据库未升级，无法撤回'); return }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_update_game_reimbursement', { p_token: adminToken, p_order_id: order.id, p_status: 'pending', p_admin_note: order.admin_note || '' })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('已撤回，状态改回「待处理」')
    refresh()
  }

  const downloadUncompletedReimbursements = () => {
    const pendingOrders = (reimbursementOrders || []).filter((order) => order.status !== 'completed')
    if (!pendingOrders.length) { setMsg('暂无未完成的报销订单'); return }
    const headers = ['答主', '游戏', '稿件 URL', '游戏价格', '应报销', '扣除金币', '状态', '提交时间']
    const rows = pendingOrders.map((order) => [
      order.answerer_name || nameById[order.answerer_id] || order.answerer_id,
      order.game_name,
      order.article_url,
      Number(order.game_price).toFixed(2),
      Number(order.reimbursement_amount).toFixed(2),
      Number(order.coins_spent),
      reimbursementStatusLabel[order.status] || order.status,
      fmtTime(order.created_at),
    ])
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `未完成报销订单_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // 导出「补发 csv」：用户member_id（来自腾讯文档工作表1 的 K 列）/ 盐粒 / 补发数量（应报销金额 × 100）
  const downloadReissueCsv = async () => {
    if (backendError) { setMsg('数据库未升级，无法导出'); return }
    const pendingOrders = (reimbursementOrders || []).filter((order) => order.status !== 'completed')
    if (!pendingOrders.length) { setMsg('暂无未完成的报销订单'); return }
    setBusy(true)
    const map = await loadMemberIds(true)
    setBusy(false)
    if (!map) { setMsg('读取知乎 member_id 失败：腾讯文档暂不可用，请稍后重试'); return }
    const headers = ['用户member_id', '盐粒', '补发数量']
    const missing = []
    const rows = pendingOrders.map((order) => {
      const memberId = map.byId?.[order.answerer_id] || map.byName?.[order.answerer_name] || ''
      if (!memberId) missing.push(order.answerer_name || order.answerer_id)
      const amount = Math.round(Number(order.reimbursement_amount || 0) * 100)
      return [memberId || '未找到', '盐粒', amount]
    })
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `补发_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    const sample = rows[0] ? `示例：${rows[0][0]} / ${rows[0][1]} / ${rows[0][2]}` : ''
    setMsg(`已导出 ${rows.length} 条补发记录（${sample}）${missing.length ? `；${missing.length} 条没找到 member_id：${missing.slice(0, 3).join('、')}` : ''}`)
  }

  const fmtTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—'
  const orderStatusLabel = { pending: '待发货', fulfilled: '已发货', completed: '已完成', canceled: '已取消', refunded: '已退款' }
  const reimbursementStatusLabel = { pending: '待处理', processing: '处理中', reimbursed: '已报销', rejected: '已拒绝', canceled: '已取消', completed: '已完成' }

  return (
    <div className="coin-shop-admin" style={{ display: 'grid', gap: 16 }}>
      <div className="panel-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h3>积分商城后台</h3><p>商品上架 / 兑换订单发货 / 金币调整；1 金币 = ¥0.01，报销产品按后台设定折扣扣除金币。</p></div>
        <div className="analytics-tabs" role="tablist">
          {[['catalog', '商品'], ['orders', '兑换订单'], ['reimbursements', '报销订单'], ['adjust', '手动调币'], ['scale', '系数设置'], ['coins', '金币概览']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}<b>{k === 'catalog' ? (catalog || []).length : k === 'orders' ? (orders || []).length : k === 'reimbursements' ? (reimbursementOrders || []).length : ''}</b></button>
          ))}
        </div>
      </div>
      {backendError && <div className="error-box">数据库尚未升级（迁移草稿：autokey/supabase/migrations/20260908120000_gj_levels_coins_gates_shop_draft.sql）。当前仅展示骨架，不会写入数据。<button onClick={() => setBackendError('')} aria-label="关闭">×</button></div>}
      {msg && <div className="daily-form-msg" style={{ color: msg.includes('失败') || msg.includes('无法') ? '#e53e3e' : '#2f9e44' }}>{msg}</div>}

      {tab === 'catalog' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="panel-head coin-product-form-head"><div><h3>添加商品</h3><p>库存为限量补货口径；兑换后自动扣减。</p></div></div>
            <form className="form-grid coin-product-form" onSubmit={addProduct}>
              {renderProductFormFields(draft, setDraft, draftImageName, setDraftImageName, '选择图片', true)}
              <button className="primary form-submit" disabled={busy}>{busy ? '保存中…' : '上架'}</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head"><div><h3>商品列表</h3><p>拖动行或点箭头调整顺序，顺序即金币商城展示顺序；绑定产品 Key 池后库存跟着池子走。</p></div>{orderSaving && <small>顺序保存中…</small>}</div>
            <div className="table-wrap"><table><thead><tr><th className="catalog-drag-col">排序</th><th>商品</th><th>类型</th><th>金币价 / 折扣</th><th>等级门槛</th><th>库存</th><th>剩余</th><th>状态</th><th>操作</th></tr></thead><tbody>
              {(catalog || []).map((c, index) => {
                const bound = catalogPools[c.id]
                return <tr
                  key={c.id}
                  className={dragIndex === index ? 'catalog-row dragging' : 'catalog-row'}
                  draggable={!backendError && !orderSaving}
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => { event.preventDefault(); if (dragIndex !== null && dragIndex !== index) { moveProduct(dragIndex, index); setDragIndex(index) } }}
                  onDragEnd={() => setDragIndex(null)}
                  onDrop={(event) => { event.preventDefault(); setDragIndex(null) }}
                >
                  <td className="catalog-drag-cell">
                    <span className="catalog-drag-handle" title="拖动排序">⠿</span>
                    <span className="catalog-order-buttons">
                      <button type="button" className="catalog-order-btn" disabled={index === 0 || orderSaving} onClick={() => moveProduct(index, index - 1)} title="上移">↑</button>
                      <button type="button" className="catalog-order-btn" disabled={index === (catalog || []).length - 1 || orderSaving} onClick={() => moveProduct(index, index + 1)} title="下移">↓</button>
                    </span>
                  </td>
                  <td>{c.title}</td>
                  <td><span className="pill">{c.category === 'reimbursement' ? '报销产品' : c.fulfillment_type === 'physical' ? '实体' : '虚拟'}</span></td>
                  <td><b>{c.category === 'reimbursement' ? `${c.reimbursement_discount} 折` : c.cost_coins}</b></td>
                  <td>{c.min_level > 0 ? `Lv${c.min_level}+` : '不限'}</td>
                  <td>{c.category === 'reimbursement' ? '不限量' : `${c.stock_left} / ${c.stock_total}`}</td>
                  <td>{c.category === 'reimbursement'
                    ? <span className="muted">/</span>
                    : (() => {
                      // 绑定 Key 池的虚拟商品看池子余量；实物/未绑定虚拟商品看库存剩余（入库库存 - 已兑换）
                      const remain = bound ? Number(bound.pool_left || 0) : Number(c.stock_left || 0)
                      return <span className={`catalog-pool-tag${remain <= 0 ? ' empty' : ''}`} title={bound ? `产品：${bound.product_name}` : '按库存扣减'}>{remain}</span>
                    })()}</td>
                  <td><span className={`pill ${c.status === 'on' ? 'success' : 'muted'}`}>{c.status === 'on' ? '上架中' : '已下架'}</span></td>
                  <td><div className="review-actions"><button className="outline-button compact" disabled={!!backendError} onClick={() => openEditProduct(c)}>编辑</button><button className="outline-button compact" disabled={!!backendError || busy} onClick={() => duplicateProduct(c)}>复制</button><button className="outline-button compact danger" disabled={!!backendError || busy} onClick={() => deleteProduct(c)}>删除</button><button className="outline-button compact" disabled={!!backendError} onClick={() => toggleProduct(c)}>{c.status === 'on' ? '下架' : '上架'}</button></div></td>
                </tr>
              })}
              {(!catalog || catalog.length === 0) && <tr><td colSpan="9" className="table-empty">{catalog === null ? '加载中…' : '暂无商品（数据库升级后可添加）'}</td></tr>}
            </tbody></table></div>
          </section>
        </div>
      )}

      {editingItem && editDraft && (
        <div className="coin-product-modal-backdrop" role="presentation" onMouseDown={closeEditProduct}>
          <section className="coin-product-modal" role="dialog" aria-modal="true" aria-labelledby="coin-product-edit-title" onMouseDown={(e) => e.stopPropagation()}>
            <div className="panel-head"><h3 id="coin-product-edit-title">编辑商品</h3><button className="outline-button compact" type="button" onClick={closeEditProduct} aria-label="关闭编辑弹窗">关闭</button></div>
            <form className="form-grid coin-product-form" onSubmit={updateProduct}>
              {renderProductFormFields(editDraft, setEditDraft, editImageName, setEditImageName, '替换图片')}
              <button className="primary form-submit" disabled={busy}>{busy ? '保存中…' : '保存修改'}</button>
            </form>
          </section>
        </div>
      )}

      {fulfillTarget && (() => {
        const isPhysical = catalogById[fulfillTarget.catalog_id]?.fulfillment_type === 'physical'
        const fd = fulfillTarget.fulfillment_data || {}
        return <div className="coin-product-modal-backdrop" role="presentation" onMouseDown={() => setFulfillTarget(null)}>
          <section className="coin-product-modal fulfill-modal" role="dialog" aria-modal="true" aria-labelledby="fulfill-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-head"><h3 id="fulfill-title">发货 · {fulfillTarget.catalog_title || catalogTitleById[fulfillTarget.catalog_id] || '商品'}</h3><button className="outline-button compact" type="button" onClick={() => setFulfillTarget(null)} aria-label="关闭">关闭</button></div>
            <div className="fulfill-body">
              <p className="fulfill-meta">答主：<b>{fulfillTarget.answerer_name || nameById[fulfillTarget.answerer_id] || '—'}</b>　数量：{fulfillTarget.qty}　消耗金币：{fulfillTarget.points_spent}　下单：{fmtTime(fulfillTarget.created_at)}</p>
              {isPhysical ? <>
                <div className="fulfill-recipient">
                  <div><span>收件人</span><b>{fd.name || '—'}</b></div>
                  <div><span>手机</span><b>{fd.phone || '—'}</b></div>
                  <div><span>地址</span><b>{fd.address || '—'}</b></div>
                </div>
                <label className="field"><span>物流公司</span><input value={fulfillForm.carrier} onChange={(e) => setFulfillForm({ ...fulfillForm, carrier: e.target.value })} placeholder="如：顺丰速运" /></label>
                <label className="field"><span>快递单号</span><input value={fulfillForm.tracking} onChange={(e) => setFulfillForm({ ...fulfillForm, tracking: e.target.value })} placeholder="填写后答主可在兑换记录里看到" /></label>
              </> : <>
                <label className="field"><span>Key / 卡密 / 发货备注</span><textarea rows="4" value={fulfillForm.text} onChange={(e) => setFulfillForm({ ...fulfillForm, text: e.target.value })} placeholder={'直接粘贴卡密文本即可，例如：\nABCDE-FGHIJ-KLMNO-PQRST\n也可以粘贴 JSON：{"platform":"Steam","key":"XXXXX"}'} /></label>
                <small className="fulfill-hint">纯文本会记在订单的「卡密 / Key」列；JSON 会原样保存。</small>
              </>}
              {msg && <div className="daily-form-msg" style={{ color: '#e53e3e' }}>{msg}</div>}
              <div className="confirm-actions">
                <button className="outline-button" type="button" onClick={() => setFulfillTarget(null)} disabled={busy}>取消</button>
                <button className="primary" type="button" onClick={submitFulfill} disabled={busy}>{busy ? '提交中…' : '确认发货'}</button>
              </div>
            </div>
          </section>
        </div>
      })()}

      {bindingPrompt && (
        <div className="coin-product-modal-backdrop" role="presentation" onMouseDown={() => setBindingPrompt(null)}>
          <section className="coin-product-modal binding-required-modal" role="dialog" aria-modal="true" aria-labelledby="binding-required-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-head"><h3 id="binding-required-title">需要先绑定产品才能上架</h3><button className="outline-button compact" type="button" onClick={() => setBindingPrompt(null)} aria-label="关闭提示">关闭</button></div>
            <div className="binding-required-body">
              <p>「<b>{bindingPrompt.title || '该商品'}</b>」是<b>虚拟卡密商品</b>，{bindingPrompt.scene === 'on' ? '上架前' : bindingPrompt.scene === 'create' ? '新建上架前' : '保存前'}必须先绑定「产品名（Key 池）」，否则兑换时没有 Key 可以发放。</p>
              <ol>
                <li>在左侧「剩余KEY管理」用「Key 码 + 产品名」把该产品的 Key 录入（产品名就是这里要绑的名字）；</li>
                <li>回到「积分商城 → 商品列表」编辑该商品，在「产品名（Key 池）」里搜到它；</li>
                <li>保存后即可上架，库存会跟着池子走。</li>
              </ol>
              <p className="binding-required-note">如果这个商品改成人工发货，请把「履约方式」改成「实体」，或先下架再清空产品名保存。</p>
              <button className="primary" type="button" onClick={() => setBindingPrompt(null)}>知道了</button>
            </div>
          </section>
        </div>
      )}

      {tab === 'orders' && (
        <section className="panel">
          <div className="panel-head"><div><h3>兑换订单</h3><p>绑定产品 Key 池的商品已自动发 Key；其余虚拟商品点「发货」填写 Key/卡密（经站内信交付），实体填写物流。</p></div><button className="outline-button compact" onClick={downloadPendingPhysicalOrders} disabled={(orders || []).filter((o) => o.status === 'pending' && catalogById[o.catalog_id]?.fulfillment_type === 'physical').length === 0}>下载未发货实物订单 Excel</button></div>
          <div className="table-wrap"><table><thead><tr><th>答主</th><th>商品</th><th>数量</th><th>消耗金币</th><th>状态</th><th>卡密 / Key</th><th>下单时间</th><th>操作</th></tr></thead><tbody>
            {(orders || []).map((o) => {
              const issuedKeys = Array.isArray(o.fulfillment_data?.keys) ? o.fulfillment_data.keys : []
              const manualText = !issuedKeys.length && typeof o.fulfillment_data?.text === 'string' ? o.fulfillment_data.text : ''
              return <tr key={o.id}><td>{o.answerer_name || nameById[o.answerer_id] || '—'}</td><td>{o.catalog_title || catalogTitleById[o.catalog_id] || '—'}</td><td>{o.qty}</td><td>{o.points_spent}</td><td><span className="pill">{orderStatusLabel[o.status] || o.status}</span></td><td>{issuedKeys.length ? <span className="admin-key-cell">{issuedKeys.map((k) => <code key={k.key_value}>{k.key_value}</code>)}</span> : manualText ? <span className="admin-ship-note">{manualText}</span> : o.status === 'pending' ? <span className="muted">待发货</span> : <span className="muted">—</span>}</td><td>{fmtTime(o.created_at)}</td><td>{o.status === 'pending' ? <div className="review-actions"><button className="compact success" disabled={!!backendError || busy} onClick={() => openFulfill(o)}>发货</button><button className="compact danger" disabled={!!backendError || busy} onClick={() => cancelOrder(o)}>取消退款</button></div> : <span className="muted">{o.fulfilled_at ? fmtTime(o.fulfilled_at) : '—'}</span>}</td></tr>
            })}
            {(!orders || orders.length === 0) && <tr><td colSpan="8" className="table-empty">{orders === null ? '加载中…' : '暂无兑换订单'}</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'reimbursements' && (
        <section className="panel">
          <div className="panel-head"><div><h3>游戏稿件报销订单</h3><p>答主提交已发布稿件后，已按下单时商品折扣扣除金币；请在知乎系统完成对应人民币报销。</p></div><div className="reimbursement-export-actions"><button className="outline-button compact" disabled={!reimbursementOrders?.some((order) => order.status !== 'completed')} onClick={downloadUncompletedReimbursements}>下载未完成订单 Excel</button><button className="outline-button compact" disabled={busy || !!backendError || !reimbursementOrders?.some((order) => order.status !== 'completed')} onClick={downloadReissueCsv} title="导出知乎补发模板：用户member_id（腾讯文档工作表1 的 K 列）、盐粒、补发数量（应报销金额 × 100）">{busy ? '导出中…' : '导出补发 csv'}</button></div></div>
          <div className="table-wrap"><table><thead><tr><th>答主</th><th title="来自腾讯文档工作表1 的 K 列（知乎 member_id）">答主 member_id</th><th>游戏</th><th>稿件 URL</th><th>游戏价格</th><th>应报销</th><th>扣除金币</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>
            {(reimbursementOrders || []).map((order) => {
              const memberId = memberIdOf(order)
              return <tr key={order.id}><td>{order.answerer_name || nameById[order.answerer_id] || order.answerer_id}</td><td>{memberId || <span className="muted" title={`答主 ID：${order.answerer_id}`}>—</span>}</td><td>{order.game_name}</td><td><a href={order.article_url} target="_blank" rel="noreferrer">查看稿件</a></td><td>¥{Number(order.game_price).toFixed(2)}</td><td>¥{Number(order.reimbursement_amount).toFixed(2)}</td><td>{Number(order.coins_spent).toLocaleString()}</td><td><span className="pill">{reimbursementStatusLabel[order.status] || order.status}</span></td><td>{fmtTime(order.created_at)}</td><td>{order.status === 'completed'
                ? <button className="outline-button compact" disabled={busy || !!backendError} onClick={() => reopenReimbursement(order)} title="把状态改回「待处理」，该订单会重新出现在补发导出里">撤回</button>
                : <button className="outline-button compact" disabled={busy || !!backendError} onClick={() => completeReimbursement(order)}>已完成</button>}</td></tr>
            })}
            {(!reimbursementOrders || reimbursementOrders.length === 0) && <tr><td colSpan="10" className="table-empty">{reimbursementOrders === null ? '加载中…' : '暂无报销订单'}</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'adjust' && (
        <section className="panel">
          <div className="panel-head"><div><h3>手动调整金币</h3><p>活动补偿使用正数、违规扣分使用负数；每次调整都会留审计记录。</p></div></div>
          <form className="form-grid" onSubmit={doAdjust}>
            <div className="field"><span>答主</span><AnswererPicker value={adjust.answerer_id} onChange={(id) => setAdjust({ ...adjust, answerer_id: id })} options={answerers || []} /></div>
            <label className="field"><span>金额（正/负）</span><input type="number" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} /></label>
            <label className="field"><span>备注</span><input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} placeholder="原因（必填建议）" /></label>
            <button className="primary form-submit" disabled={busy || !!backendError}>{busy ? '提交中…' : '执行调整'}</button>
          </form>
        </section>
      )}

      {tab === 'scale' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><div><h3>金币 S 系数</h3><p>S 系数会乘到每日活跃金币公式：每日金币 = 基础日产出 × S。当前数据库保存值为 <b>{savedCoinScale}</b>。表格中「基础日产出/人」是 S=1 基准值；「S后日产出/人」才是实际发放口径。</p></div></div>
            <form className="coin-scale-form" onSubmit={updateCoinScale}>
              <label className="field"><span>当前 S 系数</span><input type="number" min="0" max="10" step="0.01" value={coinScaleDraft} onChange={(event) => setCoinScaleDraft(event.target.value)} required /></label>
              <div className="field"><span>生效说明</span><small style={{ color: 'var(--c-ink-3)', lineHeight: 1.5 }}>保存后立即影响后续每日活跃金币发放；图表会先按下方输入值实时预览。</small></div>
              <button className="primary form-submit" disabled={configBusy || !!backendError}>{configBusy ? '保存中…' : '保存系数'}</button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h3>产出预估图表</h3><p>按当前全部答主的积分等级统计。有效活跃动作包含日常投稿、测评交付、领取 Key、自助报名和兑换下单；次数按每笔有效动作累计。</p></div><small style={{ color: 'var(--c-ink-4)' }}>配置更新：{coinScaleConfig?.updated_at ? fmtTime(coinScaleConfig.updated_at) : '—'}</small></div>
            <div className="coin-scale-summary">
              <div><small>已保存系数</small><b>{savedCoinScale}</b></div>
              <div><small>预览系数</small><b>{previewCoinScale}</b></div>
              <div><small>新系数每日总产出</small><b>{projectionTotals.previewDaily.toLocaleString()}</b></div>
              <div><small>新系数每月总产出</small><b>{projectionTotals.previewMonthly.toLocaleString()}</b></div>
              <div><small>今日活跃总次数</small><b>{projectionTotals.todayActiveCount.toLocaleString()}</b><small>本月 {projectionTotals.monthActiveCount.toLocaleString()} 次</small></div>
            </div>

            <div className="coin-scale-chart">
              {coinProjection.length ? coinProjection.map((row) => {
                const width = Math.max(2, Math.round((row.previewMonthly / maxProjectionMonthly) * 100))
                const deltaClass = row.monthlyDelta > 0 ? 'up' : row.monthlyDelta < 0 ? 'down' : ''
                return (
                  <div className="coin-scale-row" key={row.level}>
                    <div className="coin-scale-row-head">
                      <strong>Lv{row.level}</strong>
                      <span>{row.count} 人</span>
                    </div>
                    <div className="coin-scale-track"><div className="coin-scale-fill" style={{ width: `${width}%` }} /></div>
                    <div className="coin-scale-values">
                      <span>今日 {row.todayActiveCount.toLocaleString()} 次</span>
                      <span>本月 {row.monthActiveCount.toLocaleString()} 次</span>
                      <span>日产出 {row.previewDaily.toLocaleString()}</span>
                      <span>月产出 {row.previewMonthly.toLocaleString()}</span>
                    </div>
                  </div>
                )
              }) : <div className="table-empty">暂无答主数据，无法计算产出预估。</div>}
            </div>

            <div className="table-wrap">
              <table>
                <thead><tr><th>等级</th><th>人数</th><th>基础日产出 / 人</th><th>S后日产出 / 人</th><th>当前系数日总和</th><th>新系数日总和</th><th>新系数月总和（30天理论值）</th><th>今日活跃次数</th><th>本月有效活跃次数</th></tr></thead>
                <tbody>
                  {coinProjection.map((row) => (
                    <tr key={row.level}>
                      <td>Lv{row.level}</td>
                      <td>{row.count}</td>
                      <td>{row.baseDaily.toLocaleString()}</td>
                      <td>{row.previewDailyPerPerson.toLocaleString()}</td>
                      <td>{row.currentDaily.toLocaleString()}</td>
                      <td><b>{row.previewDaily.toLocaleString()}</b></td>
                      <td>{row.previewMonthly.toLocaleString()}</td>
                      <td>{row.todayActiveCount.toLocaleString()}</td>
                      <td>{row.monthActiveCount.toLocaleString()}</td>
                    </tr>
                  ))}
                  {!coinProjection.length && <tr><td colSpan="9" className="table-empty">暂无数据</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === 'coins' && (() => {
        const s = coinOverview?.summary || null
        const spends = coinOverview?.spends || []
        const users = coinOverview?.users || []
        const fmt = (n) => Number(n || 0).toLocaleString()
        const fmtTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : '—'
        const kindLabel = { redeem: '商品兑换', reimbursement: '游戏报销', gate: '门槛补足' }
        const statusLabel = { fulfilled: '已发货', pending: '待处理', completed: '已完成', canceled: '已取消', refunded: '已退回', processing: '处理中', reimbursed: '已报销', rejected: '已拒绝' }
        return (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><div><h3>金币概览</h3><p>全站金币的发出、消耗与每人持有量；1 金币 = ¥0.01。「发出」= 活跃日金币 + 运营调整，其余为零星补发。</p></div><button className="outline-button compact" onClick={refresh} disabled={busy}>{busy ? '刷新中…' : '刷新数据'}</button></div>
            {!s ? <div className="table-empty">正在加载金币数据…</div> : (
              <div className="coins-overview-cards">
                <div className="coins-overview-card"><span>累计发出</span><b>{fmt(s.granted)}</b><small>活跃日 {fmt(s.granted_daily_active)} · 运营调整 {fmt(s.granted_admin)}</small></div>
                <div className="coins-overview-card"><span>累计消耗</span><b>{fmt(Math.abs(s.spent))}</b><small>商品兑换 / 报销 / 门槛补足</small></div>
                <div className="coins-overview-card highlight"><span>未消耗余额（发行在外）</span><b>{fmt(s.outstanding)}</b><small>≈ ¥{fmt((Number(s.outstanding) * 0.01).toFixed(0))}（按 1 金币 = ¥0.01）</small></div>
                <div className="coins-overview-card"><span>用户数</span><b>{fmt(s.users)}</b><small>有余额 {fmt(s.users_with_balance)} 人 · 负余额 {fmt(s.negative_users)} 人</small></div>
              </div>
            )}
            {coinOverview?.excluded?.names?.length ? <div className="coins-overview-note">已排除内部账号：{coinOverview.excluded.names.join('、')}（这两个账号的进账、出账与余额都不计入本看板）。</div> : null}
          </section>

          <section className="panel">
            <div className="panel-head"><div><h3>消耗明细（{spends.length}）</h3><p>谁、在什么时候、把金币花在了什么上面。</p></div></div>
            <div className="table-wrap"><table><thead><tr><th>类型</th><th>答主</th><th>内容</th><th>金币</th><th>状态</th><th>时间</th></tr></thead><tbody>
              {spends.length ? spends.map((row, idx) => (
                <tr key={`spend-${idx}`}>
                  <td><span className="pill">{kindLabel[row.kind] || row.kind}</span></td>
                  <td>{row.who || '—'}</td>
                  <td>{row.what || '—'}</td>
                  <td><b>{fmt(Math.abs(row.coins))}</b></td>
                  <td><span className="pill muted">{statusLabel[row.status] || row.status || '—'}</span></td>
                  <td>{fmtTime(row.time)}</td>
                </tr>
              )) : <tr><td colSpan="6" className="table-empty">还没有任何金币消耗。</td></tr>}
            </tbody></table></div>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h3>每人余额（{users.length}）</h3><p>按剩余金币从多到少；「累计获得」含活跃日金币与运营调整。</p></div></div>
            <div className="table-wrap"><table><thead><tr><th>答主</th><th>等级</th><th>累计获得</th><th>累计消耗</th><th>剩余金币</th><th>最近活跃</th></tr></thead><tbody>
              {users.length ? users.map((row) => (
                <tr key={row.id}>
                  <td>{row.name || '—'}</td>
                  <td><span className="level-badge">Lv{row.level}</span></td>
                  <td>{fmt(row.granted)}</td>
                  <td>{row.spent ? fmt(Math.abs(row.spent)) : '—'}</td>
                  <td><b style={Number(row.balance) < 0 ? { color: '#e53e3e' } : undefined}>{fmt(row.balance)}</b></td>
                  <td>{row.last_active_date || '—'}</td>
                </tr>
              )) : <tr><td colSpan="6" className="table-empty">暂无数据。</td></tr>}
            </tbody></table></div>
          </section>
        </div>
        )
      })()}

    </div>
  )
}
