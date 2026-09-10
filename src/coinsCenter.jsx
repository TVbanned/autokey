import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

const SESSION_KEY = 'keyflow_answerer_session'
const readSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null } catch { return null }
}

const statusLabel = { pending: '待发货', fulfilled: '已发货', completed: '已完成', canceled: '已取消', refunded: '已退款' }
const typeLabel = { game: '游戏/卡密', physical: '实体', other: '其它' }
const fmtMoney = (n) => Number(n || 0).toLocaleString()

export default function CoinsCenter({ embedded = false, onBalanceChange }) {
  const session = readSession()
  const answererId = session?.id
  const [state, setState] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [orders, setOrders] = useState(null)
  const [backendError, setBackendError] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState('shop')

  const load = async () => {
    if (!answererId) return
    const [ecoRes, catRes, ordRes] = await Promise.all([
      supabase.rpc('keyflow_answerer_economy_state', { p_answerer_id: answererId }),
      supabase.from('keyflow_reward_catalog').select('*').eq('status', 'on').order('sort_order', { ascending: true }),
      supabase.from('keyflow_redeem_orders').select('*').eq('answerer_id', answererId).order('created_at', { ascending: false }),
    ])
    if (ecoRes.error || catRes.error || ordRes.error) {
      setBackendError([ecoRes.error, catRes.error, ordRes.error].filter(Boolean).map(e => e.message).join('；'))
      setCatalog([])
      setOrders([])
      return
    }
    setBackendError('')
    setState(ecoRes.data)
    onBalanceChange?.(ecoRes.data?.coins_balance ?? null)
    setCatalog(catRes.data || [])
    setOrders(ordRes.data || [])
  }

  useEffect(() => { load() }, [answererId])

  const coinsBalance = useMemo(() => {
    if (state && typeof state.coins_balance !== 'undefined') return state.coins_balance
    return null
  }, [state])

  const redeem = async (item) => {
    if (backendError) { setMsg('兑换功能需数据库升级后启用'); return }
    if (!window.confirm(`确认用 ${item.cost_coins} 金币兑换「${item.title}」吗？虚拟商品发货后不支持退金币。`)) return
    let address = null
    if (item.fulfillment_type === 'physical') {
      const raw = window.prompt('请填写收货信息（姓名 / 电话 / 地址）')
      if (raw == null) return
      address = { text: raw.trim() }
    }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_redeem_product', {
      p_answerer_id: answererId,
      p_catalog_id: item.id,
      p_qty: 1,
      p_address: address,
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('兑换成功，等待运营发货')
    load()
  }

  const fmtTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—'

  if (!session) {
    return (
      <div className="coins-page">
        <main className="coins-page-main coins-empty">
          <div className="panel step-message"><p>请先登录答主账号</p><a className="primary" href="?login&redirect=coins">去登录</a></div>
        </main>
      </div>
    )
  }

  return (
    <div className={embedded ? 'coins-page coins-page-embedded' : 'coins-page'}>
      {!embedded && <header className="coins-page-top">
        <a className="coins-brand" href="?dashboard"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>金币商城</small></a>
        <a className="outline-button compact" href="?dashboard">← 返回看板</a>
      </header>}

      <main className={embedded ? 'coins-page-main coins-page-main-embedded' : 'coins-page-main'}>
        {backendError && (
          <div className="notice-box notice-warning">
            数据库尚未升级（需先执行本地迁移草稿再上线）。当前页面为只读骨架，升级后金币与兑换将自动生效。
          </div>
        )}
        {msg && <div className="notice-box" style={{ color: msg.includes('失败') || msg.includes('需') || msg.includes('不足') ? 'var(--c-danger)' : 'var(--c-success)' }}>{msg}</div>}

        {!embedded && <section className="panel coins-overview">
          <div className="coins-overview-item coins-overview-level">
            <span className="coins-ov-label">当前等级</span>
            <span className="coins-lv-badge">{state ? `Lv${state.current_level}` : 'Lv…'}</span>
            <div className="coins-ov-meta">
              <span>历史最高 {state ? `Lv${state.best_level}` : '—'}</span>
              <span>累计经验 {state ? fmtMoney(state.exp) : '—'}</span>
            </div>
          </div>
          <div className="coins-overview-divider" />
          <div className="coins-overview-item coins-overview-coins">
            <span className="coins-ov-label">金币余额</span>
            <span className="coins-balance-value">{coinsBalance == null ? '—' : fmtMoney(coinsBalance)}</span>
            <div className="coins-ov-meta"><span>1 金币 ≈ ¥0.01</span></div>
          </div>
        </section>}

        <div className="coins-section-tabs" role="tablist" aria-label="金币模块分区">
          <button type="button" className={section === 'shop' ? 'active' : ''} onClick={() => setSection('shop')}>金币商城</button>
          <button type="button" className={section === 'orders' ? 'active' : ''} onClick={() => setSection('orders')}>我的兑换记录</button>
        </div>

        {section === 'shop' && <section className="panel coins-shop-section">
          <div className="coins-section-head">
            <div><h3>金币商城</h3><p>限量商品会陆续补货；虚拟商品由运营发货，Key 走站内信。</p></div>
          </div>
          <div className="coins-shop-grid">
            {(catalog || []).map((c) => (
              <div className="coins-product" key={c.id}>
                <div className="coins-product-top">
                  <strong>{c.title}</strong>
                  <span className="pill coins-product-type">{c.fulfillment_type === 'physical' ? '实体' : '虚拟'}</span>
                </div>
                <p className="coins-product-desc">{c.description || '—'}</p>
                <div className="coins-product-meta">
                  <span className="coins-price">{fmtMoney(c.cost_coins)} <small>金币</small></span>
                  <span className="coins-stock">剩余 {c.stock_left}{c.min_level > 0 ? ` · 需 Lv${c.min_level}+` : ''}</span>
                </div>
                <button className="primary compact coins-buy-btn" disabled={busy || !!backendError || c.stock_left < 1} onClick={() => redeem(c)}>
                  {c.stock_left < 1 ? '已兑完' : '立即兑换'}
                </button>
              </div>
            ))}
            {(!catalog || catalog.length === 0) && <div className="coins-empty">{catalog === null ? '加载中…' : '暂无上架商品（升级后开放）'}</div>}
          </div>
        </section>}

        {section === 'orders' && <section className="panel coins-orders-section">
          <div className="coins-section-head"><div><h3>我的兑换记录</h3></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>商品</th><th>消耗金币</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>
                {(orders || []).map((o) => <tr key={o.id}><td>{o.catalog_id}</td><td>{o.points_spent}</td><td><span className={`pill ${o.status === 'fulfilled' ? 'success' : o.status === 'canceled' || o.status === 'refunded' ? 'muted' : 'warning'}`}>{statusLabel[o.status] || o.status}</span></td><td>{fmtTime(o.created_at)}</td></tr>)}
                {(!orders || orders.length === 0) && <tr><td colSpan="4" className="table-empty">{orders === null ? '加载中…' : '暂无兑换记录'}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>}
      </main>
    </div>
  )
}