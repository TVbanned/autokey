import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'

const ADMIN_SESSION_KEY = 'keyflow_admin_session'
const getAdminToken = () => {
  try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY))?.session_token || null } catch { return null }
}

export default function CoinShopAdmin() {
  const [tab, setTab] = useState('catalog')
  const [catalog, setCatalog] = useState(null)
  const [orders, setOrders] = useState(null)
  const [answerers, setAnswerers] = useState(null)
  const [backendError, setBackendError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [draft, setDraft] = useState({ title: '', category: 'game', cost_coins: 1000, min_level: 0, stock_total: 5, fulfillment_type: 'virtual' })
  const [adjust, setAdjust] = useState({ answerer_id: '', amount: 100, note: '' })
  const adminToken = getAdminToken()

  const refresh = async () => {
    const [catRes, ordRes, ansRes] = await Promise.all([
      supabase.from('keyflow_reward_catalog').select('*').order('sort_order', { ascending: true }),
      supabase.from('keyflow_redeem_orders').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('keyflow_answerers').select('id,zhihu_name').order('created_at', { ascending: false }).limit(300),
    ])
    if (catRes.error || ordRes.error || ansRes.error) {
      const errText = [catRes.error, ordRes.error, ansRes.error].filter(Boolean).map(e => e.message).join('；')
      setBackendError(errText)
      setCatalog([])
      setOrders([])
      setAnswerers([])
      return
    }
    setBackendError('')
    setCatalog(catRes.data || [])
    setOrders(ordRes.data || [])
    setAnswerers(ansRes.data || [])
  }

  useEffect(() => { refresh() }, [])

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

  const addProduct = async (e) => {
    e.preventDefault()
    if (backendError) { setMsg('数据库未升级，无法写入'); return }
    setBusy(true)
    const { error } = await supabase.from('keyflow_reward_catalog').insert({
      ...draft,
      cost_coins: Number(draft.cost_coins) || 0,
      min_level: Number(draft.min_level) || 0,
      stock_total: Number(draft.stock_total) || 0,
      stock_left: Number(draft.stock_total) || 0,
      status: 'on',
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setDraft({ title: '', category: 'game', cost_coins: 1000, min_level: 0, stock_total: 5, fulfillment_type: 'virtual' })
    setMsg('商品已上架')
    refresh()
  }

  const toggleProduct = async (item) => {
    if (backendError) return
    const { error } = await supabase.from('keyflow_reward_catalog').update({ status: item.status === 'on' ? 'off' : 'on' }).eq('id', item.id)
    if (error) { setMsg(error.message); return }
    refresh()
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

  const fulfillOrder = async (order) => {
    if (backendError) { setMsg('数据库未升级，无法发货'); return }
    const raw = window.prompt('填写发货信息（虚拟商品示例：{"platform":"Steam","key":"XXXXX"}；实体填写物流公司+单号）', '{}')
    if (raw == null) return
    let data = {}
    try { data = JSON.parse(raw || '{}') } catch { setMsg('JSON 格式不正确'); return }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_fulfill_redeem', { p_token: adminToken, p_order_id: order.id, p_fulfillment: data })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('已发货')
    refresh()
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

  const fmtTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—'
  const orderStatusLabel = { pending: '待发货', fulfilled: '已发货', completed: '已完成', canceled: '已取消', refunded: '已退款' }

  return (
    <div className="coin-shop-admin" style={{ display: 'grid', gap: 16 }}>
      <div className="panel-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h3>积分商城后台</h3><p>商品上架 / 兑换订单发货 / 金币调整；1 金币 = ¥0.01，游戏兑换按市价 8-9 折。</p></div>
        <div className="analytics-tabs" role="tablist">
          {[['catalog', '商品'], ['orders', '兑换订单'], ['adjust', '手动调币']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}<b>{k === 'catalog' ? (catalog || []).length : k === 'orders' ? (orders || []).length : ''}</b></button>
          ))}
        </div>
      </div>
      {backendError && <div className="error-box">数据库尚未升级（迁移草稿：autokey/supabase/migrations/20260908120000_gj_levels_coins_gates_shop_draft.sql）。当前仅展示骨架，不会写入数据。<button onClick={() => setBackendError('')} aria-label="关闭">×</button></div>}
      {msg && <div className="daily-form-msg" style={{ color: msg.includes('失败') || msg.includes('无法') ? '#e53e3e' : '#2f9e44' }}>{msg}</div>}

      {tab === 'catalog' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><div><h3>添加商品</h3><p>库存为限量补货口径；兑换后自动扣减。</p></div></div>
            <form className="form-grid" onSubmit={addProduct}>
              <label className="field"><span>商品名</span><input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required placeholder="如：某独立游戏 Key / Steam 充值卡 ¥50" /></label>
              <label className="field"><span>类型</span><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}><option value="game">游戏/卡密（虚拟）</option><option value="physical">实体周边</option><option value="other">其它</option></select></label>
              <label className="field"><span>兑换金币</span><input type="number" min="1" value={draft.cost_coins} onChange={(e) => setDraft({ ...draft, cost_coins: e.target.value })} /></label>
              <label className="field"><span>所需等级（0=不限）</span><input type="number" min="0" max="100" value={draft.min_level} onChange={(e) => setDraft({ ...draft, min_level: e.target.value })} /></label>
              <label className="field"><span>入库库存</span><input type="number" min="0" value={draft.stock_total} onChange={(e) => setDraft({ ...draft, stock_total: e.target.value })} /></label>
              <label className="field"><span>履约方式</span><select value={draft.fulfillment_type} onChange={(e) => setDraft({ ...draft, fulfillment_type: e.target.value })}><option value="virtual">虚拟（后台发 Key/卡密）</option><option value="physical">实体（需收货地址）</option></select></label>
              <button className="primary form-submit" disabled={busy}>{busy ? '保存中…' : '上架'}</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head"><div><h3>商品列表</h3><p>库存为限量补货口径；兑换后自动扣减。</p></div></div>
            <div className="table-wrap"><table><thead><tr><th>商品</th><th>类型</th><th>金币价</th><th>等级门槛</th><th>库存</th><th>状态</th><th>操作</th></tr></thead><tbody>
              {(catalog || []).map((c) => <tr key={c.id}><td>{c.title}</td><td><span className="pill">{c.fulfillment_type === 'physical' ? '实体' : '虚拟'}</span></td><td><b>{c.cost_coins}</b></td><td>{c.min_level > 0 ? `Lv${c.min_level}+` : '不限'}</td><td>{c.stock_left} / {c.stock_total}</td><td><span className={`pill ${c.status === 'on' ? 'success' : 'muted'}`}>{c.status === 'on' ? '上架中' : '已下架'}</span></td><td><button className="outline-button compact" disabled={!!backendError} onClick={() => toggleProduct(c)}>{c.status === 'on' ? '下架' : '上架'}</button></td></tr>)}
              {(!catalog || catalog.length === 0) && <tr><td colSpan="7" className="table-empty">{catalog === null ? '加载中…' : '暂无商品（数据库升级后可添加）'}</td></tr>}
            </tbody></table></div>
          </section>
        </div>
      )}

      {tab === 'orders' && (
        <section className="panel">
          <div className="panel-head"><div><h3>兑换订单</h3><p>虚拟商品请把 Key/卡密填入发货信息（经站内信交付）；实体填写物流。</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>答主</th><th>商品</th><th>数量</th><th>消耗金币</th><th>状态</th><th>下单时间</th><th>操作</th></tr></thead><tbody>
            {(orders || []).map((o) => <tr key={o.id}><td>{nameById[o.answerer_id] || '—'}</td><td>{catalogTitleById[o.catalog_id] || '—'}</td><td>{o.qty}</td><td>{o.points_spent}</td><td><span className="pill">{orderStatusLabel[o.status] || o.status}</span></td><td>{fmtTime(o.created_at)}</td><td>{o.status === 'pending' ? <div className="review-actions"><button className="compact success" disabled={!!backendError || busy} onClick={() => fulfillOrder(o)}>发货</button><button className="compact danger" disabled={!!backendError || busy} onClick={() => cancelOrder(o)}>取消退款</button></div> : <span className="muted">{o.fulfilled_at ? fmtTime(o.fulfilled_at) : '—'}</span>}</td></tr>)}
            {(!orders || orders.length === 0) && <tr><td colSpan="7" className="table-empty">{orders === null ? '加载中…' : '暂无兑换订单'}</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'adjust' && (
        <section className="panel">
          <div className="panel-head"><div><h3>手动调整金币</h3><p>活动补偿使用正数、违规扣分使用负数；每次调整都会留审计记录。</p></div></div>
          <form className="form-grid" onSubmit={doAdjust}>
            <label className="field"><span>答主</span><select value={adjust.answerer_id} onChange={(e) => setAdjust({ ...adjust, answerer_id: e.target.value })} required><option value="">选择答主…</option>{(answerers || []).map((a) => <option key={a.id} value={a.id}>{a.zhihu_name}</option>)}</select></label>
            <label className="field"><span>金额（正/负）</span><input type="number" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} /></label>
            <label className="field"><span>备注</span><input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} placeholder="原因（必填建议）" /></label>
            <button className="primary form-submit" disabled={busy || !!backendError}>{busy ? '提交中…' : '执行调整'}</button>
          </form>
        </section>
      )}
    </div>
  )
}