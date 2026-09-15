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
  const [reimbursementOrders, setReimbursementOrders] = useState(null)
  const [answerers, setAnswerers] = useState(null)
  const [backendError, setBackendError] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [draft, setDraft] = useState({ title: '', description: '', image_url: '', card_tags: '', category: 'game', cost_coins: 1000, reimbursement_discount: 8, min_level: 0, stock_total: 5, fulfillment_type: 'virtual' })
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
  const adminToken = getAdminToken()

  const refresh = async () => {
    const [catRes, ordRes, reimbRes, projRes, cfgRes, lvlRes] = await Promise.all([
      supabase.from('keyflow_reward_catalog').select('*').order('sort_order', { ascending: true }),
      supabase.from('keyflow_redeem_orders').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.rpc('keyflow_admin_game_reimbursement_orders', { p_token: adminToken }),
      supabase.rpc('keyflow_admin_coin_scale_levels', { p_token: adminToken }),
      supabase.from('keyflow_economy_config').select('key,value,updated_at').eq('key', 'coin_scale_s').maybeSingle(),
      supabase.from('keyflow_level_config').select('level,daily_coins').order('level', { ascending: true }),
    ])

    // 商品、真实等级分布、系数和等级配置是关键数据；订单/答主列表权限失败不应阻塞系数设置。
    const criticalErrors = [catRes.error, projRes.error, cfgRes.error, lvlRes.error].filter(Boolean)
    setBackendError(criticalErrors.map(e => e.message).join('；'))
    setCatalog(catRes.error ? [] : (catRes.data || []))
    setCoinLevelCounts(projRes.error ? [] : (projRes.data || []))
    setAnswerers([])
    if (ordRes.error) console.warn('兑换订单暂不可用：', ordRes.error.message)
    if (reimbRes.error) console.warn('报销订单暂不可用：', reimbRes.error.message)
    setOrders(ordRes.error ? [] : (ordRes.data || []))
    setReimbursementOrders(reimbRes.error ? [] : (reimbRes.data || []))

    const nextScale = cfgRes.error ? null : cfgRes.data
    setCoinScaleConfig(nextScale)
    setCoinScaleDraft(String(Number(nextScale?.value ?? 1)))
    setLevelConfig(lvlRes.error ? [] : (lvlRes.data || []))
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

  const renderProductFormFields = (value, setValue, imageName, setImageName, imageButtonText) => <>
    <label className="field"><span>商品名</span><input value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} required placeholder="如：某独立游戏 Key / Steam 充值卡 ¥50" /></label>
    <div className="field coin-product-image"><span>头图</span><label className="outline-button compact">{imageButtonText}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleImageFile(e.target.files?.[0], (image_url) => setValue({ ...value, image_url }), setImageName)} hidden /></label><small>JPG、PNG 或 WebP，≤500KB</small>{imageName && <small>{imageName}</small>}{value.image_url && <img src={value.image_url} alt="头图预览" />}</div>
    <label className="field"><span>卡片简介</span><textarea value={value.description} onChange={(e) => setValue({ ...value, description: e.target.value })} placeholder="如：精选兑换商品" maxLength="80" rows="2" /><small>显示在前台商品卡片标题下方，最多 80 字。</small></label>
    <label className="field"><span>卡片关键词</span><input value={value.card_tags} onChange={(e) => setValue({ ...value, card_tags: e.target.value })} placeholder="如：游戏报销, 3D 测试" /><small>多个关键词用逗号分隔，最多显示两个。</small></label>
    <label className="field"><span>类型</span><select value={value.category} onChange={(e) => setValue({ ...value, category: e.target.value })}><option value="game">游戏/卡密（虚拟）</option><option value="physical">实体周边</option><option value="other">其它</option><option value="reimbursement">报销产品</option></select></label>
    {value.category === 'reimbursement' ? <label className="field"><span>折扣等级</span><input type="number" min="0" max="10" step="0.1" value={value.reimbursement_discount} onChange={(e) => setValue({ ...value, reimbursement_discount: e.target.value })} required /><small>填写 8 表示 8 折，金币按游戏价格 × 0.8 × 100 扣除。</small></label> : <><label className="field"><span>兑换金币</span><input type="number" min="1" value={value.cost_coins} onChange={(e) => setValue({ ...value, cost_coins: e.target.value })} /></label><label className="field"><span>入库库存</span><input type="number" min="0" value={value.stock_total} onChange={(e) => setValue({ ...value, stock_total: e.target.value })} /></label><label className="field"><span>履约方式</span><select value={value.fulfillment_type} onChange={(e) => setValue({ ...value, fulfillment_type: e.target.value })}><option value="virtual">虚拟（后台发 Key/卡密）</option><option value="physical">实体（需收货地址）</option></select></label></>}
    <label className="field"><span>所需等级（0=不限）</span><input type="number" min="0" max="100" value={value.min_level} onChange={(e) => setValue({ ...value, min_level: e.target.value })} /></label>
  </>

  const openEditProduct = (item) => {
    setEditingItem(item)
    setEditDraft({ title: item.title || '', description: item.description || '', image_url: item.image_url || '', card_tags: item.card_tags || '', category: item.category || 'game', cost_coins: item.cost_coins, reimbursement_discount: item.reimbursement_discount ?? 8, min_level: item.min_level, stock_total: item.stock_total, fulfillment_type: item.fulfillment_type || 'virtual' })
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
      },
    })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setDraft({ title: '', description: '', image_url: '', card_tags: '', category: 'game', cost_coins: 1000, reimbursement_discount: 8, min_level: 0, stock_total: 5, fulfillment_type: 'virtual' })
    setDraftImageName('')
    setMsg('商品已上架')
    refresh()
  }

  const toggleProduct = async (item) => {
    if (backendError) return
    const { error } = await supabase.rpc('keyflow_admin_set_reward_catalog_status', {
      p_token: adminToken,
      p_catalog_id: item.id,
      p_status: item.status === 'on' ? 'off' : 'on',
    })
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

  const completeReimbursement = async (order) => {
    setBusy(true)
    const { error } = await supabase.rpc('keyflow_admin_update_game_reimbursement', { p_token: adminToken, p_order_id: order.id, p_status: 'completed', p_admin_note: order.admin_note || '' })
    setBusy(false)
    if (error) { setMsg(error.message); return }
    setMsg('报销订单已完成')
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

  const fmtTime = (v) => v ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—'
  const orderStatusLabel = { pending: '待发货', fulfilled: '已发货', completed: '已完成', canceled: '已取消', refunded: '已退款' }
  const reimbursementStatusLabel = { pending: '待处理', processing: '处理中', reimbursed: '已报销', rejected: '已拒绝', canceled: '已取消', completed: '已完成' }

  return (
    <div className="coin-shop-admin" style={{ display: 'grid', gap: 16 }}>
      <div className="panel-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h3>积分商城后台</h3><p>商品上架 / 兑换订单发货 / 金币调整；1 金币 = ¥0.01，报销产品按后台设定折扣扣除金币。</p></div>
        <div className="analytics-tabs" role="tablist">
          {[['catalog', '商品'], ['orders', '兑换订单'], ['reimbursements', '报销订单'], ['adjust', '手动调币'], ['scale', '系数设置']].map(([k, label]) => (
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
              {renderProductFormFields(draft, setDraft, draftImageName, setDraftImageName, '选择图片')}
              <button className="primary form-submit" disabled={busy}>{busy ? '保存中…' : '上架'}</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head"><div><h3>商品列表</h3><p>库存为限量补货口径；兑换后自动扣减。</p></div></div>
            <div className="table-wrap"><table><thead><tr><th>商品</th><th>类型</th><th>金币价 / 折扣</th><th>等级门槛</th><th>库存</th><th>状态</th><th>操作</th></tr></thead><tbody>
              {(catalog || []).map((c) => <tr key={c.id}><td>{c.title}</td><td><span className="pill">{c.category === 'reimbursement' ? '报销产品' : c.fulfillment_type === 'physical' ? '实体' : '虚拟'}</span></td><td><b>{c.category === 'reimbursement' ? `${c.reimbursement_discount} 折` : c.cost_coins}</b></td><td>{c.min_level > 0 ? `Lv${c.min_level}+` : '不限'}</td><td>{c.category === 'reimbursement' ? '不限量' : `${c.stock_left} / ${c.stock_total}`}</td><td><span className={`pill ${c.status === 'on' ? 'success' : 'muted'}`}>{c.status === 'on' ? '上架中' : '已下架'}</span></td><td><div className="review-actions"><button className="outline-button compact" disabled={!!backendError} onClick={() => openEditProduct(c)}>编辑</button><button className="outline-button compact" disabled={!!backendError} onClick={() => toggleProduct(c)}>{c.status === 'on' ? '下架' : '上架'}</button></div></td></tr>)}
              {(!catalog || catalog.length === 0) && <tr><td colSpan="7" className="table-empty">{catalog === null ? '加载中…' : '暂无商品（数据库升级后可添加）'}</td></tr>}
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

      {tab === 'orders' && (
        <section className="panel">
          <div className="panel-head"><div><h3>兑换订单</h3><p>虚拟商品请把 Key/卡密填入发货信息（经站内信交付）；实体填写物流。</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>答主</th><th>商品</th><th>数量</th><th>消耗金币</th><th>状态</th><th>下单时间</th><th>操作</th></tr></thead><tbody>
            {(orders || []).map((o) => <tr key={o.id}><td>{nameById[o.answerer_id] || '—'}</td><td>{catalogTitleById[o.catalog_id] || '—'}</td><td>{o.qty}</td><td>{o.points_spent}</td><td><span className="pill">{orderStatusLabel[o.status] || o.status}</span></td><td>{fmtTime(o.created_at)}</td><td>{o.status === 'pending' ? <div className="review-actions"><button className="compact success" disabled={!!backendError || busy} onClick={() => fulfillOrder(o)}>发货</button><button className="compact danger" disabled={!!backendError || busy} onClick={() => cancelOrder(o)}>取消退款</button></div> : <span className="muted">{o.fulfilled_at ? fmtTime(o.fulfilled_at) : '—'}</span>}</td></tr>)}
            {(!orders || orders.length === 0) && <tr><td colSpan="7" className="table-empty">{orders === null ? '加载中…' : '暂无兑换订单'}</td></tr>}
          </tbody></table></div>
        </section>
      )}

      {tab === 'reimbursements' && (
        <section className="panel">
          <div className="panel-head"><div><h3>游戏稿件报销订单</h3><p>答主提交已发布稿件后，已按下单时商品折扣扣除金币；请在知乎系统完成对应人民币报销。</p></div><button className="outline-button compact" disabled={!reimbursementOrders?.some((order) => order.status !== 'completed')} onClick={downloadUncompletedReimbursements}>下载未完成订单 Excel</button></div>
          <div className="table-wrap"><table><thead><tr><th>答主</th><th>答主 ID</th><th>游戏</th><th>稿件 URL</th><th>游戏价格</th><th>应报销</th><th>扣除金币</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>
            {(reimbursementOrders || []).map((order) => <tr key={order.id}><td>{order.answerer_name || nameById[order.answerer_id] || order.answerer_id}</td><td></td><td>{order.game_name}</td><td><a href={order.article_url} target="_blank" rel="noreferrer">查看稿件</a></td><td>¥{Number(order.game_price).toFixed(2)}</td><td>¥{Number(order.reimbursement_amount).toFixed(2)}</td><td>{Number(order.coins_spent).toLocaleString()}</td><td><span className="pill">{reimbursementStatusLabel[order.status] || order.status}</span></td><td>{fmtTime(order.created_at)}</td><td>{order.status === 'completed' ? <span className="muted">—</span> : <button className="outline-button compact" disabled={busy || !!backendError} onClick={() => completeReimbursement(order)}>已完成</button>}</td></tr>)}
            {(!reimbursementOrders || reimbursementOrders.length === 0) && <tr><td colSpan="10" className="table-empty">{reimbursementOrders === null ? '加载中…' : '暂无报销订单'}</td></tr>}
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

    </div>
  )
}