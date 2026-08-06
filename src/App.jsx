import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import './App.css'

const initialActivity = {
  title: '', game_name: '', description: '', rules: '', main_question: '',
  review_requirement: '测评要求：图文并茂，生动有趣',
  target_authors: 20, application_deadline: '', delivery_deadline: '',
  steam_url: '', game_cover: '', game_screenshots: '[]',
}

function Icon({ name, size = 18 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.6-3 2.5-4.5 5.5-4.5s4.9 1.5 5.5 4.5M16 11a3 3 0 1 0-1.3-5.7M17 15.5c1.9.3 3 1.8 3.5 4.5"/></>,
    key: <><circle cx="8" cy="15" r="3"/><path d="m10.2 12.8 8-8M15 5l3 3M13 7l3 3"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    arrow: <path d="m9 18 6-6-6-6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    edit: <><path d="M16 3l5 5L8 21H3v-5z"/><path d="m14 5 4 4"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value)) : '未设置'
}

function parseSteamAppId(url) {
  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/)
  return match ? match[1] : null
}

function detectKeyPlatform(value) {
  const key = value.trim()
  if (/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/i.test(key)) return 'steam'
  if (/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/i.test(key)) return 'ubi'
  if (/^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$/i.test(key)) return 'switch'
  if (/^[A-Z0-9]{12}$/i.test(key)) return 'ps5'
  return 'unknown'
}

function parseKeys(value) {
  const seen = new Set()
  return value.split(/[\n,，;；\t]+/).map((key) => key.trim()).filter((key) => {
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).map((key_value) => ({ key_value, platform: detectKeyPlatform(key_value) }))
}

const platformLabel = { steam: 'Steam', ubi: 'Ubisoft Connect', switch: 'Nintendo Switch', ps5: 'PlayStation 5', unknown: '未识别' }

async function fetchSteamInfo(url) {
  const appid = parseSteamAppId(url)
  if (!appid) return null
  const capsule = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_236x236.jpg`
  try {
    const { data, error } = await supabase.functions.invoke('steam-appdetails', { body: { appId: appid } })
    if (error || !data?.success) return { cover: capsule, description: '', game_name: '', screenshots: '[]' }
    const g = data.game
    return {
      cover: g.cover || capsule,
      description: g.desc || '',
      game_name: g.title || '',
      screenshots: JSON.stringify(g.screenshots || []),
    }
  } catch { return { cover: capsule, description: '', game_name: '', screenshots: '[]' } }
}

function App() {
  const [active, setActive] = useState('活动概览')
  const [activities, setActivities] = useState([])
  const [applications, setApplications] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activityModal, setActivityModal] = useState(false)
  const [applicationModal, setApplicationModal] = useState(false)
  const [editActivityModal, setEditActivityModal] = useState(false)
  const [activityForm, setActivityForm] = useState(initialActivity)
  const [applicationForm, setApplicationForm] = useState({ zhihu_name: '', wechat_name: '', profile_url: '', expected_word_count: 800 })
  const [steamFetching, setSteamFetching] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyImporting, setKeyImporting] = useState(false)
  const [keys, setKeys] = useState([])

  const selectedActivity = activities.find((item) => item.id === selectedId) || activities[0]
  const parsedKeys = useMemo(() => parseKeys(keyInput), [keyInput])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const filteredApplications = useMemo(() => applications.filter((item) => item.activity_id === selectedActivity?.id), [applications, selectedActivity])
  const selectedCount = filteredApplications.filter((item) => item.status === 'selected').length
  const claimedCount = filteredApplications.filter((item) => item.keyflow_keys?.[0]?.claimed_at).length
  const deliveredCount = filteredApplications.filter((item) => item.keyflow_deliveries?.length).length

  const toast = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 2800) }

  const loadData = async () => {
    setLoading(true); setError('')
    const [activityResult, applicationResult, deliveryResult, keyResult] = await Promise.all([
      supabase.from('keyflow_activities').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_applications').select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').order('submitted_at', { ascending: false }),
      supabase.from('keyflow_deliveries').select('*'),
      supabase.from('keyflow_keys').select('id, activity_id, platform, application_id, created_at').order('created_at', { ascending: false }),
    ])
    const failure = activityResult.error || applicationResult.error || deliveryResult.error || keyResult.error
    if (failure) setError(failure.message)
    else {
      setActivities(activityResult.data || []); setApplications(applicationResult.data || []); setDeliveries(deliveryResult.data || []); setKeys(keyResult.data || [])
      setSelectedId((current) => current || activityResult.data?.[0]?.id || '')
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])

  const createActivity = async (event) => {
    event.preventDefault()
    const payload = {
      ...activityForm,
      target_authors: Number(activityForm.target_authors),
      application_deadline: activityForm.application_deadline || null,
      delivery_deadline: activityForm.delivery_deadline || null,
    }
    const { data, error: requestError } = await supabase.from('keyflow_activities').insert(payload).select().single()
    if (requestError) return setError(requestError.message)
    setActivities((items) => [data, ...items]); setSelectedId(data.id); setActive('活动概览'); setActivityModal(false); setActivityForm(initialActivity); toast('活动已创建，可开始收集答主报名')
  }

  const createApplication = async (event) => {
    event.preventDefault()
    if (!selectedActivity) return
    const { data, error: requestError } = await supabase.from('keyflow_applications').insert({ ...applicationForm, activity_id: selectedActivity.id, expected_word_count: Math.max(800, Number(applicationForm.expected_word_count) || 800) }).select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').single()
    if (requestError) return setError(requestError.message)
    setApplications((items) => [data, ...items]); setApplicationModal(false); toast('报名信息已保存')
  }

  const reviewApplication = async (id, status) => {
    const { error: requestError } = await supabase.from('keyflow_applications').update({ status, reviewed_at: new Date().toISOString() }).eq('id', id)
    if (requestError) return setError(requestError.message)
    setApplications((items) => items.map((item) => item.id === id ? { ...item, status } : item)); toast(status === 'selected' ? '答主已入选' : '已更新答主状态')
  }

  const openEditActivity = () => {
    setActivityForm({ ...selectedActivity })
    setEditActivityModal(true)
  }

  const handleSteamFetch = async () => {
    const url = activityForm.steam_url
    if (!url) return
    setSteamFetching(true)
    const info = await fetchSteamInfo(url)
    if (info) {
      setActivityForm((prev) => ({
        ...prev,
        game_cover: info.cover,
        description: info.description || prev.description,
        game_name: info.game_name || prev.game_name,
        game_screenshots: info.screenshots || '[]',
      }))
      toast('已从 Steam 抓取封面、截图和简介')
    } else {
      setError('无法解析 Steam 地址，请检查 URL 格式')
    }
    setSteamFetching(false)
  }

  const updateActivity = async (event) => {
    event.preventDefault()
    const payload = {
      title: activityForm.title,
      game_name: activityForm.game_name,
      description: activityForm.description,
      main_question: activityForm.main_question,
      review_requirement: activityForm.review_requirement,
      target_authors: Number(activityForm.target_authors),
      application_deadline: activityForm.application_deadline || null,
      delivery_deadline: activityForm.delivery_deadline || null,
      steam_url: activityForm.steam_url,
      game_cover: activityForm.game_cover,
      game_screenshots: activityForm.game_screenshots || '[]',
    }
    const { error: requestError } = await supabase.from('keyflow_activities').update(payload).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    loadData(); setEditActivityModal(false); toast('活动已更新')
  }

  const importKeys = async () => {
    if (!selectedActivity || !parsedKeys.length) return
    setKeyImporting(true); setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_import_keys', { p_activity_id: selectedActivity.id, p_keys: parsedKeys })
    setKeyImporting(false)
    if (requestError) return setError(requestError.message)
    const result = data?.[0]
    setKeyInput(''); await loadData()
    toast(`已入库 ${result?.inserted_count || 0} 个 Key${result?.duplicate_count ? `，跳过 ${result.duplicate_count} 个重复项` : ''}`)
  }

  const nav = [['活动概览', 'grid'], ['活动管理', 'calendar'], ['答主报名', 'users'], ['Key 管理', 'key'], ['交付验收', 'file']]
  const statusLabel = { pending: '待筛选', selected: '已入选', rejected: '未入选' }

  const urlParams = new URLSearchParams(window.location.search)
  const partnerToken = urlParams.get('partner')
  if (partnerToken) return <PartnerPage token={partnerToken} />
  const applyId = urlParams.get('apply')
  const authCode = urlParams.get('authorization_code') || urlParams.get('code')
  if (applyId || authCode) {
    const activityId = applyId || sessionStorage.getItem('zhihu_oauth_activity_id')
    if (activityId) return <ClaimPage activityId={activityId} authCode={authCode} />
  }

  const claimLink = selectedActivity ? `${window.location.origin}${window.location.pathname}?apply=${selectedActivity.id}` : ''
  const partnerLink = selectedActivity?.partner_token ? `${window.location.origin}${window.location.pathname}?partner=${selectedActivity.partner_token}` : ''

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark zhihu-mark">知</span>GameJourney</div>
      <div className="sidebar-divider" />
      <nav className="nav-section"><p className="nav-label">工作台</p>{nav.map(([label, icon]) => <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => setActive(label)}><Icon name={icon}/><span>{label}</span>{label === '答主报名' && filteredApplications.length > 0 && <b>{filteredApplications.length}</b>}</button>)}</nav>
      <div className="profile"><span className="avatar">张</span><div className="profile-info"><strong>张小满</strong><small>运营方</small></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="mobile-brand"><span className="brand-mark zhihu-mark">知</span> GameJourney</div><div className="crumb">工作台 <span>/</span> {active}</div><button className="reload" onClick={loadData}>刷新数据</button></header>
      <section className="content">
        <div className="page-title"><div><p className="eyebrow">真实数据工作台</p><h1>{active}</h1><p className="subtitle">活动、报名、Key 与交付数据均实时保存至 Supabase。</p></div><button className="primary" onClick={() => active === '答主报名' ? setApplicationModal(true) : setActivityModal(true)}><Icon name="plus"/> {active === '答主报名' ? '新增报名' : '创建活动'}</button></div>
        {error && <div className="error-box">数据操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {loading ? <div className="empty-state">正在加载活动数据…</div> : active === '活动概览' && !selectedActivity ? <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建第一个测评活动</h2><p>创建后即可收集答主报名、导入 Key 并进行交付验收。</p><button className="primary" onClick={() => setActivityModal(true)}><Icon name="plus"/> 创建活动</button></div> : active === '活动概览' ? <>
          <section className="activity-picker"><button className="current-activity" onClick={() => setActive('活动管理')}><span>当前活动</span><strong>{selectedActivity.title}</strong><Icon name="arrow" size={14}/></button><div className="activity-picker-right"><span className="activity-status">{selectedActivity.status === 'recruiting' ? '招募中' : selectedActivity.status}</span><button className="outline-button" onClick={() => { navigator.clipboard.writeText(partnerLink); toast('合作方页面链接已复制') }}>复制合作方链接</button><button className="outline-button" onClick={() => window.open(partnerLink, '_blank')}>预览合作方页</button><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button><button className="outline-button" onClick={() => setApplicationModal(true)}><Icon name="plus" size={16}/> 新增报名</button></div></section>
          <section className="hero-card real-hero"><div className="hero-top"><div><span className="live-dot"/> {selectedActivity.status === 'recruiting' ? '进行中 · 招募中' : selectedActivity.status} <span className="divider">|</span> 报名截止 {formatDate(selectedActivity.application_deadline)}</div><button className="edit-button" onClick={openEditActivity}><Icon name="edit" size={15}/> 编辑</button></div><div className="game-info"><div className="game-cover">{selectedActivity.game_cover ? <img src={selectedActivity.game_cover} alt={selectedActivity.game_name}/> : <span>{selectedActivity.game_name[0]}</span>}</div><div><p className="game-type">{selectedActivity.game_name}</p><h2>{selectedActivity.title}</h2><p>{selectedActivity.description || '尚未填写游戏简介。'}</p><p className="review-requirement">{selectedActivity.review_requirement || '测评要求：图文并茂，生动有趣'}</p></div></div><div className="rules-row"><strong>测评主问题</strong><span>{selectedActivity.main_question || '尚未设置'}</span></div></section>
          <section className="metrics">{[[filteredApplications.length,'报名答主','全部报名','users'],[selectedCount,'已入选',`目标 ${selectedActivity.target_authors} 人`,'check'],[claimedCount,'已领取 Key','按人安全绑定','key'],[deliveredCount,'已提交交付','等待审核','file']].map(([number,label,note,icon], index) => <div className="metric" key={label}><div className={`metric-icon tone-${index}`}><Icon name={icon}/></div><div><strong>{number}</strong><p>{label}</p><small>{note}</small></div></div>)}</section>
          <section className="panel applicants-panel"><div className="panel-head"><div><h3>答主报名</h3><p>真实保存的报名记录，可直接进行筛选。</p></div><button className="primary compact" onClick={() => setApplicationModal(true)}><Icon name="plus" size={15}/> 新增报名</button></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>微信名</th><th>预计字数</th><th>状态</th><th>操作</th></tr></thead><tbody>{filteredApplications.length ? filteredApplications.map((person) => <tr key={person.id}><td><div className="person"><span className="person-avatar">{person.zhihu_name[0]}</span><div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td>{person.wechat_name}</td><td>{person.expected_word_count.toLocaleString()} 字</td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td className="review-actions">{person.status === 'pending' && <><button className="select-action" onClick={() => reviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => reviewApplication(person.id, 'rejected')}>不选</button></>}{person.status !== 'pending' && <a href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a>}</td></tr>) : <tr><td colSpan="5" className="table-empty">还没有报名记录。可添加测试报名，或后续将表单公开给答主填写。</td></tr>}</tbody></table></div></section>
          <section className="next-step"><div className="deadline-icon"><Icon name="clock"/></div><div><p>下一步开发</p><h3>Key 导入与定向领取</h3><span>当前已完成真实活动与报名数据，下一步接入 Key 批量导入、原子领取和文章交付。</span></div></section>
        </> : active === '活动管理' ? <div className="activity-cards">{activities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); return <div key={item.id} className={`activity-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setActive('活动概览') }}><div className="activity-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="activity-card-body"><p className="activity-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="activity-card-meta"><span className="pill success">{item.status === 'recruiting' ? '招募中' : item.status}</span><span>{apps.length} 报名</span></div><small>报名截止 {formatDate(item.application_deadline)}</small></div></div> })}</div> : active === '答主报名' ? <ApplicationsPage activity={selectedActivity} applications={filteredApplications} statusLabel={statusLabel} onSelectActivity={() => setActive('活动管理')} onAddApplication={() => setApplicationModal(true)} onReviewApplication={reviewApplication} /> : active === 'Key 管理' ? <KeyManagement activity={selectedActivity} input={keyInput} parsedKeys={parsedKeys} platformCounts={platformCounts} importedKeys={keys.filter((item) => item.activity_id === selectedActivity?.id)} importing={keyImporting} onInput={setKeyInput} onImport={importKeys}/> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>{active}即将开放</h2><p>请先完成活动与答主报名管理。</p></div>}
      </section>
    </main>
    {activityModal && <Modal title="创建测评活动" onClose={() => setActivityModal(false)}><form onSubmit={createActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><Field label="Steam 商店地址" type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url} onChange={(value) => setActivityForm({ ...activityForm, steam_url: value })}/><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><Field label="报名截止时间" type="datetime-local" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评主问题" textarea value={activityForm.main_question} onChange={(value) => setActivityForm({ ...activityForm, main_question: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/><button className="primary form-submit">保存并创建</button></form></Modal>}
    {applicationModal && <Modal title="新增答主报名" onClose={() => setApplicationModal(false)}><form onSubmit={createApplication} className="form-grid"><Field label="知乎名称" required value={applicationForm.zhihu_name} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_name: value })}/><Field label="微信名" required value={applicationForm.wechat_name} onChange={(value) => setApplicationForm({ ...applicationForm, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={applicationForm.profile_url} onChange={(value) => setApplicationForm({ ...applicationForm, profile_url: value })}/><Field label="预计完成字数" type="number" required value={applicationForm.expected_word_count} onChange={(value) => setApplicationForm({ ...applicationForm, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setApplicationForm({ ...applicationForm, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span><button className="primary form-submit">保存报名</button></form></Modal>}
    {editActivityModal && <Modal title="编辑活动" onClose={() => setEditActivityModal(false)}><form onSubmit={updateActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><Field label="报名截止时间" type="datetime-local" value={activityForm.application_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><Field label="交付截止时间" type="datetime-local" value={activityForm.delivery_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评主问题" textarea value={activityForm.main_question || ''} onChange={(value) => setActivityForm({ ...activityForm, main_question: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，生动有趣'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/>{activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}<button className="primary form-submit">保存修改</button></form></Modal>}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

function PartnerPage({ token }) {
  const [snapshot, setSnapshot] = useState(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const parsedKeys = useMemo(() => parseKeys(input), [input])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const toast = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 2800) }

  const loadSnapshot = async () => {
    setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_partner_activity_snapshot', { p_partner_token: token })
    if (requestError) setError(requestError.message)
    else setSnapshot(data)
  }

  useEffect(() => { loadSnapshot() }, [token])

  const importKeys = async () => {
    if (!parsedKeys.length) return
    setImporting(true); setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_partner_import_keys', { p_partner_token: token, p_keys: parsedKeys })
    setImporting(false)
    if (requestError) return setError(requestError.message)
    const result = data?.[0]
    setInput(''); await loadSnapshot()
    toast(`已入库 ${result?.inserted_count || 0} 个 Key${result?.duplicate_count ? `，跳过 ${result.duplicate_count} 个重复项` : ''}`)
  }

  if (!snapshot && !error) return <div className="partner-page"><div className="partner-loading">正在加载活动协作页…</div></div>
  if (!snapshot) return <div className="partner-page"><div className="partner-loading">{error || '该合作方页面不存在或已失效。'}</div></div>

  const { activity, applications, deliveries, key_count: keyCount } = snapshot
  const selectedCount = applications.filter((item) => item.status === 'selected').length
  const approvedDeliveries = deliveries.filter((item) => item.status === 'approved').length
  const applicationStatus = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatus = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }

  return <div className="partner-page"><header className="partner-header"><div className="partner-brand"><span className="brand-mark">G</span><span>GameJourney</span><small>合作方协作页</small></div><button className="reload" onClick={loadSnapshot}>刷新数据</button></header><main className="partner-main"><section className="partner-hero"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>在此补充活动 Key，并实时查看报名与交稿进展。</span><div><span>报名截止 {formatDate(activity.application_deadline)}</span><span>交付截止 {formatDate(activity.delivery_deadline)}</span></div></section>{error && <div className="error-box">操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}<section className="partner-metrics"><div><strong>{keyCount}</strong><span>已入库 Key</span></div><div><strong>{applications.length}</strong><span>累计报名</span></div><div><strong>{selectedCount}</strong><span>已入选答主</span></div><div><strong>{deliveries.length}</strong><span>已交稿</span></div><div><strong>{approvedDeliveries}</strong><span>审核通过</span></div></section><section className="partner-grid"><section className="panel partner-key-panel"><div className="panel-head"><div><h3>补充 Key</h3><p>每行一个，也支持逗号、分号和制表符分隔；平台将自动识别。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>{parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div></div>}<div className="key-import-footer"><span>重复 Key 将自动跳过，Key 明文不会展示在数据列表中。</span><button className="primary" onClick={importKeys} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section><section className="panel partner-progress"><div className="panel-head"><div><h3>进度说明</h3><p>活动数据由运营方维护，以下信息会实时更新。</p></div></div><div className="progress-list"><div><Icon name="users"/><span>报名情况</span><strong>{applications.length} 人</strong></div><div><Icon name="check"/><span>入选答主</span><strong>{selectedCount} 人</strong></div><div><Icon name="file"/><span>交稿情况</span><strong>{deliveries.length} 篇</strong></div></div></section></section><section className="panel partner-table"><div className="panel-head"><div><h3>报名情况</h3><p>仅展示答主公开名称与报名状态。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>报名时间</th><th>状态</th></tr></thead><tbody>{applications.length ? applications.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td>{item.zhihu_name}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'selected' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{applicationStatus[item.status]}</span></td></tr>) : <tr><td colSpan="3" className="table-empty">暂无报名记录。</td></tr>}</tbody></table></div></section><section className="panel partner-table"><div className="panel-head"><div><h3>交稿情况</h3><p>合作方可查看已提交作品的审核进度。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>交稿时间</th><th>审核状态</th><th>作品</th></tr></thead><tbody>{deliveries.length ? deliveries.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td>{item.zhihu_name}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{deliveryStatus[item.status]}</span></td><td><a className="profile-link" href={item.article_url} target="_blank" rel="noreferrer">查看作品</a></td></tr>) : <tr><td colSpan="4" className="table-empty">暂无交稿记录。</td></tr>}</tbody></table></div></section></main>{notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}</div>
}

function KeyManagement({ activity, input, parsedKeys, platformCounts, importedKeys, importing, onInput, onImport }) {
  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可批量导入游戏 Key。</p></div>

  const availableCount = importedKeys.filter((item) => !item.application_id).length
  return <div className="key-management">
    <section className="application-context"><div><span>当前活动</span><strong>{activity.title}</strong><small>{activity.game_name} · Key 将仅入库至当前活动</small></div></section>
    <section className="key-stats">{[[importedKeys.length, '已入库'], [availableCount, '待领取'], [importedKeys.length - availableCount, '已领取']].map(([count, label]) => <div className="key-stat" key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel key-import-panel"><div className="panel-head"><div><h3>批量导入 Key</h3><p>每行一个 Key，也支持逗号、分号或制表符分隔。系统会自动去重并识别平台。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => onInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP\nABCD-EFGH-IJKL\nABCDEFGHIJKL'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>共 {parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div><div className="key-preview-list">{parsedKeys.slice(0, 8).map(({ key_value, platform }) => <div key={key_value}><code>{key_value}</code><span className={`platform-tag ${platform}`}>{platformLabel[platform]}</span></div>)}{parsedKeys.length > 8 && <p>另有 {parsedKeys.length - 8} 个 Key 将一并导入</p>}</div></div>}<div className="key-import-footer"><span>未识别的格式会标记为「未识别」，仍可入库供后续处理。</span><button className="primary" onClick={onImport} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section>
    <section className="panel key-inventory"><div className="panel-head"><div><h3>库存概览</h3><p>Key 明文不会在后台列表展示，保障安全。</p></div></div><div className="table-wrap"><table><thead><tr><th>平台</th><th>状态</th><th>入库时间</th></tr></thead><tbody>{importedKeys.length ? importedKeys.slice(0, 20).map((item) => <tr key={item.id}><td><span className={`platform-tag ${item.platform}`}>{platformLabel[item.platform] || '未识别'}</span></td><td><span className={`pill ${item.application_id ? 'success' : 'warning'}`}>{item.application_id ? '已领取' : '待领取'}</span></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td></tr>) : <tr><td colSpan="3" className="table-empty">当前活动尚未导入 Key。</td></tr>}</tbody></table></div></section>
  </div>
}

function ApplicationsPage({ activity, applications, statusLabel, onSelectActivity, onAddApplication, onReviewApplication }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [sortBy, setSortBy] = useState('submitted_at')
  const visibleApplications = useMemo(() => applications.filter((person) => (statusFilter === 'all' || person.status === statusFilter) && `${person.zhihu_name} ${person.wechat_name}`.toLowerCase().includes(keyword.trim().toLowerCase())).sort((a, b) => sortBy === 'expected_word_count' ? b.expected_word_count - a.expected_word_count : new Date(b.submitted_at) - new Date(a.submitted_at)), [applications, keyword, sortBy, statusFilter])

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可收集和筛选答主报名。</p></div>

  const statusCounts = { all: applications.length, pending: applications.filter((person) => person.status === 'pending').length, selected: applications.filter((person) => person.status === 'selected').length, rejected: applications.filter((person) => person.status === 'rejected').length }
  const filters = [['all', '全部'], ['pending', '待筛选'], ['selected', '已入选'], ['rejected', '未入选']]

  return <>
    <section className="application-context"><div><span>当前活动</span><strong>{activity.title}</strong><small>{activity.game_name} · 报名截止 {formatDate(activity.application_deadline)}</small></div><button className="outline-button" onClick={onSelectActivity}>切换活动 <Icon name="arrow" size={14}/></button></section>
    <section className="application-summary"><div><strong>{applications.length}</strong><span>累计报名</span></div><div><strong>{statusCounts.pending}</strong><span>待筛选</span></div><div><strong>{statusCounts.selected} / {activity.target_authors}</strong><span>已入选 / 目标人数</span></div><button className="primary" onClick={onAddApplication}><Icon name="plus" size={16}/> 新增报名</button></section>
    <section className="applications-workspace"><div className="application-toolbar"><div className="application-filters">{filters.map(([value, label]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>{label}<b>{statusCounts[value]}</b></button>)}</div><div className="application-controls"><input aria-label="搜索答主" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索知乎名或微信名"/><select aria-label="排序方式" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="submitted_at">按报名时间</option><option value="expected_word_count">按预计字数</option></select></div></div><div className="table-wrap"><table className="applications-table"><thead><tr><th>答主</th><th>知乎主页</th><th>预计字数</th><th>报名时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleApplications.length ? visibleApplications.map((person) => <tr key={person.id}><td><div className="person"><span className="person-avatar">{person.zhihu_name[0]}</span><div><strong>{person.zhihu_name}</strong><small>{person.wechat_name}</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td>{person.expected_word_count.toLocaleString()} 字</td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(person.submitted_at))}</td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => onReviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => onReviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" onClick={() => onReviewApplication(person.id, 'pending')}>重新筛选</button>}</td></tr>) : <tr><td colSpan="6" className="table-empty">没有符合条件的报名记录。</td></tr>}</tbody></table></div></section>
  </>
}

function Field({ label, textarea, onChange, onBlur, ...props }) { return <label className="field"><span>{label}</span>{textarea ? <textarea onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/> : <input onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/>}</label> }
function Modal({ title, children, onClose }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button onClick={onClose}><Icon name="close"/></button></header>{children}</section></div> }

function ClaimPage({ activityId, authCode }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authLoading, setAuthLoading] = useState(!!authCode)
  const [error, setError] = useState('')
  const [zhihuAuth, setZhihuAuth] = useState(null)
  const [form, setForm] = useState({ zhihu_name: '', wechat_name: '', profile_url: '', expected_word_count: 800 })
  const [application, setApplication] = useState(null)
  const [claimedKey, setClaimedKey] = useState(null)
  const [articleUrl, setArticleUrl] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')
  const storageKey = `claim_${activityId}`
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  useEffect(() => {
    const loadApplication = async (actId, zhihuId) => {
      const { data: app } = await supabase.from('keyflow_applications')
        .select('*, keyflow_deliveries(id, status, article_url)')
        .eq('activity_id', actId).eq('zhihu_id', zhihuId).maybeSingle()
      if (app) {
        setApplication(app)
        localStorage.setItem(storageKey, JSON.stringify({ application_id: app.id }))
        const storedKey = localStorage.getItem(`claim_key_${app.id}`)
        if (storedKey) { try { setClaimedKey(JSON.parse(storedKey)) } catch {} }
      }
    }

    const init = async () => {
      const { data: act, error: actErr } = await supabase.from('keyflow_activities').select('*').eq('id', activityId).single()
      if (actErr) { setError('该申领页不存在或已失效。'); setLoading(false); return }
      setActivity(act)

      if (authCode) {
        const { data: authData, error: authErr } = await supabase.functions.invoke('zhihu-oauth', {
          body: { code: authCode, redirect_uri: import.meta.env.VITE_ZHIHU_REDIRECT_URI },
        })
        if (authErr || !authData?.success) {
          setError(authData?.error || '知乎登录失败，请重试')
        } else {
          const auth = { token: authData.access_token, user: authData.user }
          setZhihuAuth(auth)
          sessionStorage.setItem('zhihu_auth', JSON.stringify(auth))
          if (authData.user) {
            setForm((prev) => ({
              ...prev,
              zhihu_name: authData.user.name || authData.user.fullname || prev.zhihu_name,
              profile_url: authData.user.url || authData.user.profile_url || prev.profile_url,
            }))
          }
          const url = new URL(window.location.href)
          url.searchParams.delete('authorization_code')
          url.searchParams.delete('code')
          window.history.replaceState({}, '', url)
          if (authData.user?.id) await loadApplication(activityId, String(authData.user.id))
        }
        setAuthLoading(false)
      } else {
        const stored = sessionStorage.getItem('zhihu_auth')
        if (stored) {
          try {
            const auth = JSON.parse(stored)
            setZhihuAuth(auth)
            if (auth.user?.id) await loadApplication(activityId, String(auth.user.id))
          } catch {}
        } else {
          const storedApp = localStorage.getItem(storageKey)
          if (storedApp) {
            try {
              const { application_id } = JSON.parse(storedApp)
              const { data: app } = await supabase.from('keyflow_applications')
                .select('*, keyflow_deliveries(id, status, article_url)')
                .eq('id', application_id).single()
              if (app) {
                setApplication(app)
                const storedKey = localStorage.getItem(`claim_key_${app.id}`)
                if (storedKey) { try { setClaimedKey(JSON.parse(storedKey)) } catch {} }
              }
            } catch {}
          }
        }
        setAuthLoading(false)
      }
      setLoading(false)
    }
    init()
  }, [activityId, authCode])

  const redirectToZhihu = () => {
    sessionStorage.setItem('zhihu_oauth_activity_id', activityId)
    const redirectUri = encodeURIComponent(import.meta.env.VITE_ZHIHU_REDIRECT_URI || `${window.location.origin}${window.location.pathname}`)
    window.location.href = `https://openapi.zhihu.com/authorize?redirect_uri=${redirectUri}&app_id=${import.meta.env.VITE_ZHIHU_APP_ID}&response_type=code`
  }

  const submitApplication = async (event) => {
    event.preventDefault(); setError('')
    const payload = { ...form, activity_id: activityId, expected_word_count: Math.max(800, Number(form.expected_word_count) || 800) }
    if (zhihuAuth?.user?.id) payload.zhihu_id = String(zhihuAuth.user.id)
    const { data, error: requestError } = await supabase.from('keyflow_applications')
      .insert(payload).select('*, keyflow_deliveries(id, status, article_url)').single()
    if (requestError) { setError(requestError.code === '23505' ? '你已提交过本活动报名。' : requestError.message); return }
    setApplication(data)
    localStorage.setItem(storageKey, JSON.stringify({ application_id: data.id }))
    toast('报名已提交，等待运营方筛选')
  }

  const claimKey = async () => {
    if (!application) return
    setClaiming(true); setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_claim_key', { p_application_id: application.id })
    if (requestError) { setError(requestError.message); setClaiming(false); return }
    if (data && data.length > 0) {
      const keyInfo = { key_value: data[0].key_value, claimed_at: data[0].claimed_at }
      setClaimedKey(keyInfo)
      localStorage.setItem(`claim_key_${application.id}`, JSON.stringify(keyInfo))
      toast('Key 领取成功')
    }
    setClaiming(false)
  }

  const submitDelivery = async (event) => {
    event.preventDefault()
    if (!application) return
    setSubmitting(true); setError('')
    const { data, error: requestError } = await supabase.from('keyflow_deliveries')
      .insert({ application_id: application.id, article_url: articleUrl }).select('id, status, article_url').single()
    if (requestError) {
      if (requestError.code === '23505') {
        const { data: existing } = await supabase.from('keyflow_deliveries')
          .select('id, status, article_url').eq('application_id', application.id).single()
        if (existing) setApplication({ ...application, keyflow_deliveries: [existing] })
      } else { setError(requestError.message) }
    } else {
      setApplication({ ...application, keyflow_deliveries: [data] })
      toast('作品链接已提交')
    }
    setSubmitting(false)
  }

  if (loading || authLoading) return <div className="public-page"><div className="public-card loading-public">正在加载申领页…</div></div>
  if (!activity) return <div className="public-page"><div className="public-card loading-public">{error || '该申领页不存在或已失效。'}</div></div>

  const screenshots = (() => { try { return JSON.parse(activity.game_screenshots || '[]') } catch { return [] } })()
  const hasApp = !!application
  const isSelected = application?.status === 'selected'
  const isRejected = application?.status === 'rejected'
  const hasKey = !!claimedKey
  const delivery = application?.keyflow_deliveries?.[0]
  const hasDelivery = !!delivery

  const stepStates = [
    hasApp ? 'done' : 'active',
    hasKey ? 'done' : (hasApp && isSelected ? 'active' : (hasApp && !isSelected && !isRejected ? 'waiting' : 'locked')),
    hasDelivery ? 'done' : (hasKey ? 'active' : 'locked'),
  ]
  const stepLabels = ['填写问卷', '领取 Key', '提交作品']

  return <div className="public-page"><main className="public-card">
    {screenshots.length > 0 && <div className="public-screenshots"><img className="ss-main" src={screenshots[0]} alt="游戏截图"/>{screenshots.length > 1 && <div className="ss-strip">{screenshots.slice(1).map((url, i) => <img key={i} src={url} alt={`截图 ${i+2}`}/>)}</div>}</div>}
    <div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主申领</span></div>
    <div className="public-hero"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>{activity.description || '填写以下信息参与本次游戏测评。'}</span></div>
    <div className="public-requirement">{activity.review_requirement || '测评要求：图文并茂，生动有趣'}</div>
    <section className="public-info"><strong>测评主问题</strong><p>{activity.main_question || '暂无，待后续更新'}</p><small>报名截止：{formatDate(activity.application_deadline)}</small></section>

    <div className="stepper">{stepLabels.map((label, i) => <div key={i} className={`step ${stepStates[i]}`}><div className="step-circle">{stepStates[i] === 'done' ? <Icon name="check" size={14}/> : stepStates[i] === 'waiting' ? <Icon name="clock" size={14}/> : i + 1}</div><span className="step-label">{label}</span></div>)}</div>

    <div className="step-body">
      {!hasApp && <form className="public-form" onSubmit={submitApplication}><h2>填写报名信息</h2>{!zhihuAuth && <button type="button" className="zhihu-login-btn" onClick={redirectToZhihu}><span className="brand-mark zhihu-mark">知</span> 知乎登录（可选）</button>}<Field label="知乎名称" required value={form.zhihu_name} placeholder="填写你在知乎展示的名称" onChange={(value) => setForm({ ...form, zhihu_name: value })}/><Field label="微信名" required value={form.wechat_name} placeholder="便于运营方联系" onChange={(value) => setForm({ ...form, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={form.profile_url} placeholder="https://www.zhihu.com/people/..." onChange={(value) => setForm({ ...form, profile_url: value })}/><Field label="预计完成字数" type="number" required value={form.expected_word_count} onChange={(value) => setForm({ ...form, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setForm({ ...form, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span>{error && <p className="public-error">{error}</p>}<button className="primary public-submit">提交报名</button></form>}

      {hasApp && !hasKey && (isRejected ? <div className="step-message"><div className="step-message-icon rejected"><Icon name="close" size={24}/></div><p>本次未入选</p><span>感谢你的参与，期待下次活动再见。</span></div> : !isSelected ? <div className="step-message"><div className="step-message-icon waiting"><Icon name="clock" size={24}/></div><p>报名已提交，等待筛选</p><span>运营方会根据测评要求筛选答主，入选后可在此页面领取 Key。</span></div> : <div className="step-claim"><h2>领取游戏 Key</h2><p>恭喜入选！点击下方按钮领取你的专属 Key。</p><button className="primary claim-btn" onClick={claimKey} disabled={claiming}>{claiming ? '领取中…' : '领取 Key'}</button>{error && <p className="public-error">{error}</p>}</div>)}

      {hasKey && !hasDelivery && <div className="step-delivery"><div className="key-display"><div className="key-label">你的游戏 Key</div><div className="key-value">{claimedKey.key_value}</div><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimedKey.key_value); toast('Key 已复制') }}>复制 Key</button></div><form className="delivery-form" onSubmit={submitDelivery}><h2>提交作品链接</h2><Field label="知乎文章地址" type="url" required value={articleUrl} placeholder="https://zhuanlan.zhihu.com/p/..." onChange={(value) => setArticleUrl(value)}/>{error && <p className="public-error">{error}</p>}<button className="primary public-submit" disabled={submitting}>{submitting ? '提交中…' : '提交作品'}</button></form></div>}

      {hasDelivery && <div className="step-message"><div className="step-message-icon done"><Icon name="check" size={24}/></div><p>作品已提交</p><span>{delivery.status === 'approved' ? '审核通过，感谢参与！' : delivery.status === 'revision_required' ? '需要修改，请查看运营方通知' : '等待运营方审核中…'}</span>{claimedKey && <div className="key-display compact"><div className="key-label">你的 Key</div><div className="key-value">{claimedKey.key_value}</div></div>}</div>}
    </div>

    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </main></div>
}

export default App
