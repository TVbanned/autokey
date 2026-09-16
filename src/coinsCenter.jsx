import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'

const SESSION_KEY = 'keyflow_answerer_session'
const readSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null } catch { return null }
}

const statusLabel = { pending: '待发货', fulfilled: '已发货', completed: '已完成', canceled: '已取消', refunded: '已退款' }
const reimbursementStatusLabel = { pending: '待处理', processing: '处理中', reimbursed: '已报销', rejected: '已拒绝', canceled: '已取消', completed: '已完成' }
const typeLabel = { game: '游戏/卡密', physical: '实体', other: '其它' }
const categoryLabel = { game: '游戏', physical: '实体好礼', other: '周边权益', reimbursement: '游戏报销' }
const fmtMoney = (n) => Number(n || 0).toLocaleString()
// 复制卡密：成功后把「已复制」状态交给调用方的 setter 显示
const copyKeyText = async (value, setCopied) => {
  try { await navigator.clipboard.writeText(value); setCopied(value) }
  catch { setCopied('') }
}

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
  const [redeemProduct, setRedeemProduct] = useState(null)
  const [redeemContact, setRedeemContact] = useState({ name: '', phone: '', address: '' })
  const [redeemSuccess, setRedeemSuccess] = useState(false)
  const [redeemResult, setRedeemResult] = useState(null)
  const [catalogPools, setCatalogPools] = useState({})
  const [copiedKey, setCopiedKey] = useState('')
  const [reimbursementProduct, setReimbursementProduct] = useState(null)
  const [reimbursementSuccess, setReimbursementSuccess] = useState(false)
  const [reimbursement, setReimbursement] = useState({ article_url: '', game_name: '', game_price: '' })

  const load = async () => {
    if (!answererId) return
    const [ecoRes, catRes, ordRes, reimbRes, poolRes] = await Promise.all([
      supabase.rpc('keyflow_answerer_economy_state', { p_answerer_id: answererId }),
      supabase.from('keyflow_reward_catalog').select('*').eq('status', 'on').order('sort_order', { ascending: true }),
      supabase.rpc('keyflow_answerer_redeem_orders', { p_answerer_id: answererId }),
      supabase.rpc('keyflow_answerer_game_reimbursement_orders', { p_answerer_id: answererId }),
      supabase.rpc('keyflow_shop_catalog_pools'),
    ])
    // 商品展示不应被兑换记录权限问题阻塞；记录暂不可用时保留空列表。
    const criticalErrors = [ecoRes.error, catRes.error].filter(Boolean)
    setBackendError(criticalErrors.map(e => e.message).join('；'))
    setState(ecoRes.error ? null : ecoRes.data)
    if (!ecoRes.error) onBalanceChange?.(ecoRes.data?.coins_balance ?? null)
    setCatalog(catRes.error ? [] : (catRes.data || []))
    // 绑定了产品 Key 池的商品：缺货口径以池子为准
    setCatalogPools(Object.fromEntries((poolRes.error ? [] : (poolRes.data || [])).map((row) => [row.catalog_id, row])))
    if (ordRes.error) console.warn('兑换记录暂不可用：', ordRes.error.message)
    if (reimbRes.error) console.warn('报销记录暂不可用：', reimbRes.error.message)
    const redeemedOrders = ordRes.error ? [] : (ordRes.data || []).map((order) => ({ ...order, order_type: 'redeem' }))
    const reimbursementOrders = reimbRes.error ? [] : (reimbRes.data || []).map((order) => ({ ...order, order_type: 'reimbursement', points_spent: order.coins_spent }))
    setOrders([...redeemedOrders, ...reimbursementOrders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
  }

  useEffect(() => { load() }, [answererId])

  const coinsBalance = useMemo(() => {
    if (state && typeof state.coins_balance !== 'undefined') return state.coins_balance
    return null
  }, [state])

  const openRedeem = (item) => {
    if (backendError) { setMsg('兑换功能需数据库升级后启用'); return }
    setMsg('')
    setRedeemSuccess(false)
    setRedeemResult(null)
    clearRedeemContact()
    setRedeemProduct(item)
  }

  const clearRedeemContact = () => setRedeemContact({ name: '', phone: '', address: '' })

  const submitRedeem = async () => {
    if (!redeemProduct) return
    const contact = { name: redeemContact.name.trim(), phone: redeemContact.phone.trim(), address: redeemContact.address.trim() }
    if (redeemProduct.fulfillment_type === 'physical' && (!contact.name || !contact.phone || !contact.address)) { setMsg('请完整填写姓名、电话和收货地址'); return }
    setBusy(true)
    const { data, error } = await supabase.rpc('keyflow_redeem_product', {
      p_answerer_id: answererId,
      p_catalog_id: redeemProduct.id,
      p_qty: 1,
      p_address: redeemProduct.fulfillment_type === 'physical' ? { ...contact, text: `${contact.name} ${contact.phone} ${contact.address}` } : null,
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setRedeemResult(data || null)
    setRedeemSuccess(true)
    load()
  }

  const submitReimbursement = async (event) => {
    event.preventDefault()
    const price = Number(reimbursement.game_price)
    if (!reimbursement.article_url.trim() || !reimbursement.game_name.trim()) { setMsg('请填写稿件链接和游戏名称'); return }
    if (!Number.isFinite(price) || price <= 0) { setMsg('请填写正确的游戏价格'); return }
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_submit_game_reimbursement', {
      p_answerer_id: answererId,
      p_catalog_id: reimbursementProduct.id,
      p_article_url: reimbursement.article_url.trim(),
      p_game_name: reimbursement.game_name.trim(),
      p_game_price: price,
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setReimbursementSuccess(true)
    setReimbursement({ article_url: '', game_name: '', game_price: '' })
    load()
  }

  const reimbursementDiscount = Number(reimbursementProduct?.reimbursement_discount || 0)
  const reimbursementCoins = Math.round((Number(reimbursement.game_price) || 0) * reimbursementDiscount / 10 * 100)
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

        <section className="panel coins-overview">
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
        </section>

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
              <ProductTiltFlashCard
                key={c.id}
                product={c}
                pool={catalogPools[c.id] || null}
                busy={busy || !!backendError}
                onRedeem={c.category === 'reimbursement' ? (product) => { setMsg(''); setReimbursementSuccess(false); setReimbursementProduct(product) } : openRedeem}
              />
            ))}
            {(!catalog || catalog.length === 0) && <div className="coins-empty">{catalog === null ? '加载中…' : '暂无上架商品（升级后开放）'}</div>}
          </div>
        </section>}

        {reimbursementProduct && <div className="coin-product-modal-backdrop" role="presentation" onMouseDown={() => { setReimbursementProduct(null); setReimbursementSuccess(false) }}>
          <section className="coin-product-modal reimbursement-modal" role="dialog" aria-modal="true" aria-labelledby="reimbursement-title" onMouseDown={(event) => event.stopPropagation()}>
            {reimbursementSuccess ? <ReimbursementSuccess onClose={() => { setReimbursementProduct(null); setReimbursementSuccess(false) }} /> : <>
              <div className="panel-head"><div><h3 id="reimbursement-title">{reimbursementProduct.title}</h3><p>{reimbursementProduct.description || `先提交已发布的指定游戏稿件，再按 ${reimbursementDiscount} 折扣除金币。报销由运营在知乎系统处理。`}</p></div><button className="outline-button compact" type="button" onClick={() => setReimbursementProduct(null)}>关闭</button></div>
              <form className="form-grid coin-product-form reimbursement-form" onSubmit={submitReimbursement}>
                <label className="field"><span>你要报销的游戏名称</span><input value={reimbursement.game_name} onChange={(event) => setReimbursement({ ...reimbursement, game_name: event.target.value })} required /></label>
                <label className="field"><span>你在知乎上的对应的游戏测评URL</span><input type="url" value={reimbursement.article_url} onChange={(event) => setReimbursement({ ...reimbursement, article_url: event.target.value })} placeholder="https://www.zhihu.com/..." required /></label>
                <label className="field"><span>当前游戏价格（元），以 Steam 今日价格为准</span><input type="number" min="0.01" step="0.01" value={reimbursement.game_price} onChange={(event) => setReimbursement({ ...reimbursement, game_price: event.target.value })} required /></label>
                <div className="field reimbursement-summary"><span>兑换明细</span><div><b>{fmtMoney(reimbursementCoins)} 金币</b><span>剩余金币：<b>{fmtMoney(Math.max(0, Number(coinsBalance || 0) - reimbursementCoins))} 金币</b></span></div><small>按价格 × {reimbursementDiscount / 10} × 100 计算</small></div>
                {msg && <div className="notice-box reimbursement-error">{msg}</div>}
                <button className="primary form-submit reimbursement-submit" disabled={busy}>{busy ? '提交中…' : `确认 ${reimbursementDiscount} 折立即兑换`}</button>
              </form>
            </>}
          </section>
        </div>}

        {redeemProduct && <div className="coin-product-modal-backdrop" role="presentation" onMouseDown={() => { setRedeemProduct(null); setRedeemSuccess(false); clearRedeemContact() }}>
          <section className={`coin-product-modal redeem-modal${redeemProduct.fulfillment_type === 'physical' ? ' redeem-modal-wine' : ''}`} role="dialog" aria-modal="true" aria-labelledby="redeem-title" onMouseDown={(event) => event.stopPropagation()}>
            {redeemSuccess ? <RedeemSuccess product={redeemProduct} keys={Array.isArray(redeemResult?.keys) ? redeemResult.keys : []} onClose={() => { setRedeemProduct(null); setRedeemSuccess(false); setRedeemResult(null); clearRedeemContact() }} /> : <>
              <div className="panel-head"><div><h3 id="redeem-title">确认兑换</h3><p>确认后将扣除 {fmtMoney(redeemProduct.cost_coins)} 金币。{redeemProduct.fulfillment_type === 'physical' ? '请填写收货信息，运营将据此发货。' : '虚拟商品发货后不支持退金币。'}</p></div><button className="outline-button compact" type="button" onClick={() => setRedeemProduct(null)}>关闭</button></div>
              <div className="coin-product-form redeem-form">
                <div className="redeem-product-summary"><b>{redeemProduct.title}</b><span>本次消耗 <strong>{fmtMoney(redeemProduct.cost_coins)}</strong> 金币</span></div>
                {redeemProduct.fulfillment_type === 'physical' && <div className="redeem-contact-fields"><label className="field"><span>姓名</span><input value={redeemContact.name} onChange={(event) => setRedeemContact({ ...redeemContact, name: event.target.value })} placeholder="收件人名" required /></label><label className="field"><span>电话</span><input inputMode="tel" value={redeemContact.phone} onChange={(event) => setRedeemContact({ ...redeemContact, phone: event.target.value })} placeholder="您的手机号" required /></label><label className="field"><span>地址</span><input value={redeemContact.address} onChange={(event) => setRedeemContact({ ...redeemContact, address: event.target.value })} placeholder="地区/城市/街道/具体地址" required /></label></div>}
                {msg && <div className="notice-box reimbursement-error">{msg}</div>}
                <div className="redeem-form-actions"><button className="outline-button" type="button" onClick={() => setRedeemProduct(null)} disabled={busy}>取消</button><button className="primary" type="button" onClick={submitRedeem} disabled={busy}>{busy ? '兑换中…' : '确认兑换'}</button></div>
              </div>
            </>}
          </section>
        </div>}

        {section === 'orders' && <section className="panel coins-orders-section">
          <div className="coins-section-head"><div><h3>我的兑换记录</h3></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>商品</th><th>消耗金币</th><th>卡密 / Key</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>
                {(orders || []).map((o) => {
                  const issuedKeys = Array.isArray(o.fulfillment_data?.keys) ? o.fulfillment_data.keys : []
                  return <tr key={`${o.order_type}-${o.id}`}>
                    <td>{o.order_type === 'reimbursement' ? `游戏报销：${o.game_name}` : (o.catalog_title || '—')}</td>
                    <td>{o.points_spent}</td>
                    <td>{issuedKeys.length ? <span className="redeem-key-list inline">{issuedKeys.map((k) => <span className="redeem-key-item" key={k.key_value}><code>{k.key_value}</code><button className="outline-button compact" type="button" onClick={() => copyKeyText(k.key_value, setCopiedKey)}>{copiedKey === k.key_value ? '已复制' : '复制'}</button></span>)}</span> : <span className="muted">—</span>}</td>
                    <td><span className={`pill ${o.status === 'fulfilled' || o.status === 'reimbursed' || o.status === 'completed' ? 'success' : o.status === 'canceled' || o.status === 'refunded' || o.status === 'rejected' ? 'muted' : 'warning'}`}>{o.order_type === 'reimbursement' ? reimbursementStatusLabel[o.status] || o.status : statusLabel[o.status] || o.status}</span></td>
                    <td>{fmtTime(o.created_at)}</td>
                  </tr>
                })}
                {(!orders || orders.length === 0) && <tr><td colSpan="5" className="table-empty">{orders === null ? '加载中…' : '暂无兑换记录'}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>}
      </main>
    </div>
  )
}

function ReimbursementSuccess({ onClose }) {
  return <div className="reimbursement-success"><div className="reimbursement-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--i': index }} />)}</div><div className="reimbursement-success-mark">✓</div><h3>提交成功</h3><p>已扣除对应金币，运营将通过知乎系统处理报销。</p><button className="primary" type="button" onClick={onClose}>完成</button></div>
}

function RedeemSuccess({ product, keys = [], onClose }) {
  const [copiedKey, setCopiedKey] = useState('')
  return <div className="reimbursement-success redeem-success">
    <div className="reimbursement-confetti" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ '--i': index }} />)}</div>
    <div className="reimbursement-success-mark">✓</div>
    <h3>兑换成功</h3>
    {keys.length
      ? <>
        <p>已扣除金币并实时发放卡密，请及时保存（「我的兑换记录」里可以长期查看）。</p>
        <div className="redeem-key-list">{keys.map((item) => <div className="redeem-key-item" key={item.key_value}><code>{item.key_value}</code><button className="outline-button compact" type="button" onClick={() => copyKeyText(item.key_value, setCopiedKey)}>{copiedKey === item.key_value ? '已复制' : '复制'}</button></div>)}</div>
      </>
      : <p>已扣除金币，{product.fulfillment_type === 'physical' ? '运营将按收货信息安排发货。' : '运营将通过站内信发货。'}</p>}
    <button className="primary" type="button" onClick={onClose}>完成</button>
  </div>
}

function ProductTiltFlashCard({ product, pool = null, busy = false, onRedeem }) {
  const [imageFailed, setImageFailed] = useState(false)
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0, reflectShift: 0, reflectAngle: 112, reflectStrength: 0, active: false })
  const frameRef = useRef(null)
  const item = product || {}
  const isReimbursement = item.category === 'reimbursement'
  // 绑定了产品 Key 池的商品以池子余量为准：池子空了 = 缺货
  const poolLeft = pool ? Number(pool.pool_left || 0) : null
  const stockLeft = poolLeft === null ? Number(item.stock_left || 0) : poolLeft
  const soldOut = !isReimbursement && stockLeft < 1
  const tone = isReimbursement ? 'gold' : item.category === 'physical' ? 'wine' : item.category === 'other' ? 'violet' : 'blue'
  const cardTags = String(item.card_tags || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 2)

  const moveTilt = (event) => {
    const card = frameRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const progressX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const progressY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    const rotateY = (progressX - 0.5) * 13
    const rotateX = (0.5 - progressY) * 10
    const reflectShift = Math.max(-34, Math.min(34, rotateY * 3.1 + rotateX * 0.55))
    const reflectAngle = 108 + rotateY * 1.5 - rotateX * 1.0
    const reflectStrength = Math.min(1, (Math.abs(rotateY) / 6.5) * 0.72 + (Math.abs(rotateX) / 5) * 0.48)
    setTilt({
      rotateY,
      rotateX,
      reflectShift,
      reflectAngle,
      reflectStrength,
      active: true,
    })
  }

  const resetTilt = () => setTilt({ rotateX: 0, rotateY: 0, reflectShift: 0, reflectAngle: 112, reflectStrength: 0, active: false })

  return (
    <article
      ref={frameRef}
      className={`coins-flash-card coins-tilt-card tone-${tone}${soldOut ? ' sold-out' : ''}${tilt.active ? ' is-tilting' : ''}`}
      style={{
        transform: `perspective(760px) rotateX(${tilt.rotateX.toFixed(2)}deg) rotateY(${tilt.rotateY.toFixed(2)}deg) scale(${tilt.active ? 1.018 : 1})`,
        transitionDuration: tilt.active ? '80ms' : '320ms',
        '--reflect-shift': `${tilt.reflectShift.toFixed(1)}%`,
        '--reflect-angle': `${tilt.reflectAngle.toFixed(1)}deg`,
        '--reflect-strength': tilt.reflectStrength.toFixed(2),
      }}
      onMouseMove={moveTilt}
      onMouseLeave={resetTilt}
      aria-label={item.title}
    >
      <span className="coins-flash-aurora" aria-hidden="true" />
      <span className="coins-flash-sweep" aria-hidden="true" />
      <span className="coins-tilt-reflect" aria-hidden="true" />
      <div className="coins-flash-media">
        {item.image_url && !imageFailed ? (
          <img src={item.image_url} alt={item.title} loading="lazy" onError={() => setImageFailed(true)} />
        ) : (
          <span className="coins-flash-fallback">{(item.title || '礼')[0]}</span>
        )}
        <span className="coins-flash-shade" aria-hidden="true" />
        <div className="coins-flash-badges">
          {cardTags.length ? cardTags.map((tag, index) => <span className={`coins-flash-badge${index === 0 ? ' primary' : ''}`} key={tag}>{tag}</span>) : <span className="coins-flash-badge primary">{categoryLabel[item.category] || '商品'}</span>}
        </div>
        {Number(item.min_level || 0) > 0 && <span className="coins-flash-level">Lv{item.min_level}+</span>}
      </div>
      <div className="coins-flash-body">
        <h4 className="coins-flash-title">{item.title}</h4>
        <p className="coins-flash-desc">{item.description || '精选兑换商品'}</p>
        <div className="coins-flash-footer">
          <div className="coins-flash-price">
            <b>{isReimbursement ? `${item.reimbursement_discount} 折` : fmtMoney(item.cost_coins)}</b>
            <small>{isReimbursement ? '扣除金币' : '金币'}</small>
          </div>
          <span className={`coins-flash-stock${soldOut ? ' empty' : ''}`}>
            {isReimbursement ? '不限量' : soldOut ? (pool ? '缺货' : '已兑完') : `限量 ${stockLeft} 份`}
          </span>
        </div>
        <button
          className="coins-flash-buy-btn"
          disabled={busy || soldOut}
          onClick={() => onRedeem?.(item)}
        >
          {soldOut ? (pool ? '暂时缺货' : '已兑完') : isReimbursement ? `${item.reimbursement_discount}折立即兑换` : '立即兑换'}
        </button>
      </div>
    </article>
  )
}
