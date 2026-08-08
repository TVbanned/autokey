import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { supabase } from './supabase'
import defaultRegisterBanner from './assets/hero.png'
import './App.css'

const ADMIN_SESSION_KEY = 'keyflow_admin_session'
const BANNER_CACHE_KEY = 'keyflow_banner'

const getCachedBanner = () => {
  try { const v = sessionStorage.getItem(BANNER_CACHE_KEY); return v && v.length > 100 ? v : null } catch { return null }
}
const setCachedBanner = (v) => {
  try { if (v && v.length > 100) sessionStorage.setItem(BANNER_CACHE_KEY, v) } catch {}
}

const initialActivity = {
  title: '', game_name: '', description: '', rules: '', main_question: '',
  sub_questions: '[]',
  review_requirement: '测评要求：图文并茂，主观视角，生动有趣！',
  target_authors: 20, application_deadline: '', delivery_deadline: '',
  steam_url: '', game_cover: '', game_screenshots: '[]',
}

const getDefaultDeadlines = () => {
  const now = new Date()
  const today2359 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59)
  const twoWeeksLater = new Date(today2359)
  twoWeeksLater.setDate(twoWeeksLater.getDate() + 14)
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    application_deadline: fmt(today2359),
    delivery_deadline: fmt(twoWeeksLater),
  }
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
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    eyeOff: <><path d="m3 3 18 18"/><path d="M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a18.7 18.7 0 0 1-3 3.8M6.1 6.1A18.8 18.8 0 0 0 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
    ticket: <><path d="M4 4h16v4a2 2 0 1 0 0 4v4H4v-4a2 2 0 1 0 0-4V4z"/><path d="M9 4v16"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 16-5-5L5 20"/></>,
    inbox: <><path d="M22 12h-6l-1 3H9l-1-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></>,
    user: <><circle cx="12" cy="9" r="3"/><path d="M18 20a6 6 0 0 0-12 0"/></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value)) : '未设置'
}

function cleanZhihuAnswerUrl(url) {
  if (!url) return url
  const q = url.indexOf('?')
  return q > -1 ? url.slice(0, q) : url
}

function fileTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

function getStatusTimeText(act, apps) {
  const status = act.status || 'recruiting'
  if (status === 'recruiting') return `报名截止 ${formatDate(act.application_deadline)}`
  if (status === 'key_distribution') {
    const selected = apps.filter(a => a.status === 'selected')
    if (selected.length === 0) return '尚未入选答主'
    const unclaimed = selected.filter(a => !a.keyflow_keys?.claimed_at).length
    if (unclaimed === 0) return '请立即推进评测！'
    return `${unclaimed}人尚未领取key`
  }
  if (status === 'delivery') {
    const deadline = act.delivery_deadline ? new Date(act.delivery_deadline) : null
    const daysLeft = deadline ? Math.max(0, Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24))) : '?'
    return `回稿日期${formatDate(act.delivery_deadline)}，还剩${daysLeft}天`
  }
  if (status === 'completed') return '活动已顺利完结，撒花！'
  return ''
}

function parseSteamAppId(url) {
  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/)
  return match ? match[1] : null
}

function detectKeyPlatform(value) {
  const key = value.trim()
  // Steam: XXXXX-XXXXX-XXXXX（3 组 × 5 位）
  if (/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(key)) return 'steam'
  // Ubisoft Connect: XXXX-XXXX-XXXX-XXXX（4 组 × 4 位）
  if (/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/i.test(key)) return 'ubi'
  // PlayStation: XXXX-XXXX-XXXX（3 组 × 4 位）或 10 位连续
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(key) || /^[A-Z0-9]{10}$/i.test(key)) return 'ps5'
  // Nintendo Switch: 16 位连续
  if (/^[A-Z0-9]{16}$/i.test(key)) return 'switch'
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
  const [active, setActive] = useState(() => localStorage.getItem('lastActive') || '活动概览')
  const [activities, setActivities] = useState([])
  const [applications, setApplications] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('lastSelectedId') || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activityModal, setActivityModal] = useState(false)
  const [applicationModal, setApplicationModal] = useState(false)
  const [editActivityModal, setEditActivityModal] = useState(false)
  const [activityForm, setActivityForm] = useState(initialActivity)
  const [applicationForm, setApplicationForm] = useState({ zhihu_id: '', zhihu_name: '', wechat_name: '', profile_url: '', expected_word_count: 800 })
  const [steamFetching, setSteamFetching] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyImporting, setKeyImporting] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [keys, setKeys] = useState([])
  const [invitationCodes, setInvitationCodes] = useState([])
  const [answerers, setAnswerers] = useState([])
  const [dailySubmissions, setDailySubmissions] = useState([])
  const [inboxMessages, setInboxMessages] = useState([])
  const [passwordResetRequests, setPasswordResetRequests] = useState([])
  const [deliveryNotes, setDeliveryNotes] = useState({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerSearch, setDrawerSearch] = useState('')
  const [boardSearch, setBoardSearch] = useState('')
  const [editingMainQuestion, setEditingMainQuestion] = useState(false)
  const [mainQuestionDraft, setMainQuestionDraft] = useState('')
  const [editingSubIndex, setEditingSubIndex] = useState(null)
  const [subDraft, setSubDraft] = useState('')
  const [pageAsset, setPageAsset] = useState(null)
  const [pageAssetLoading, setPageAssetLoading] = useState(false)
  const [pageAssetSaving, setPageAssetSaving] = useState(false)
  const pendingImageRef = useRef(null)
  const [confirmState, setConfirmState] = useState(null)

  const selectedActivity = activities.find((item) => item.id === selectedId) || activities[0]
  const subQuestions = useMemo(() => {
    try { return JSON.parse(selectedActivity?.sub_questions || '[]') }
    catch { return [] }
  }, [selectedActivity?.sub_questions])
  const parsedKeys = useMemo(() => parseKeys(keyInput), [keyInput])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const filteredApplications = useMemo(() => applications.filter((item) => item.activity_id === selectedActivity?.id), [applications, selectedActivity])
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const partnerAnswerers = useMemo(() => {
    const partnerAnswererIds = new Set((invitationCodes || []).filter(c => c.code_type === 'partner' && c.answerer_id).map(c => c.answerer_id))
    return answerers.filter(a => partnerAnswererIds.has(a.id))
  }, [answerers, invitationCodes])
  const pendingCount = filteredApplications.filter((item) => item.status === 'pending').length
  const selectedCount = filteredApplications.filter((item) => item.status === 'selected').length
  const claimedCount = filteredApplications.filter((item) => item.keyflow_keys?.claimed_at).length
  const deliveredCount = filteredApplications.filter((item) => item.keyflow_deliveries?.id).length

  // 发key中且全部入选答主已领Key的活动数（用于强提醒）
  const keyReadyCount = useMemo(() => {
    return activities.filter(act => {
      if (act.status !== 'key_distribution') return false
      const apps = applications.filter(a => a.activity_id === act.id && a.status === 'selected')
      return apps.length > 0 && apps.every(a => a.keyflow_keys?.claimed_at)
    }).length
  }, [activities, applications])

  const newDailyCount = (dailySubmissions || []).filter(s => !s.reviewed).length

  // 当前选中的活动是否已全部领Key待推进
  const currentActivityKeyReady = selectedActivity?.status === 'key_distribution' &&
    selectedCount > 0 && selectedCount === claimedCount
  const deliveryAppIds = useMemo(() => new Set(deliveries.map(d => d.application_id)), [deliveries])
  const authorStats = useMemo(() => {
    const stats = {}
    applications.forEach((app) => {
      const key = app.zhihu_id || app.profile_url
      if (!key || app.activity_id === selectedActivity?.id || app.status !== 'selected') return
      if (!stats[key]) stats[key] = { participated: 0, completed: 0 }
      stats[key].participated++
      if (deliveryAppIds.has(app.id)) stats[key].completed++
    })
    return stats
  }, [applications, selectedActivity, deliveryAppIds])

  const filteredDrawerActivities = useMemo(() => {
    const keyword = drawerSearch.trim().toLowerCase()
    return keyword ? activities.filter((item) => `${item.game_name} ${item.title}`.toLowerCase().includes(keyword)) : activities
  }, [activities, drawerSearch])
  const filteredBoardActivities = useMemo(() => {
    const keyword = boardSearch.trim().toLowerCase()
    return keyword ? activities.filter((item) => `${item.game_name} ${item.title}`.toLowerCase().includes(keyword)) : activities
  }, [activities, boardSearch])
  const openDrawer = () => { setDrawerSearch(''); setDrawerOpen(true) }

  const toast = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 2800) }

  const loadPageAsset = async () => {
    setPageAssetLoading(true); setError('')
    const { data, error: requestError } = await supabase.from('keyflow_page_assets').select('image_data, updated_at').eq('key', 'register_banner').maybeSingle()
    setPageAssetLoading(false)
    if (requestError) return setError(requestError.message)
    if (!pendingImageRef.current) setPageAsset(data)
  }

  const savePageAsset = async (imageData) => {
    setPageAssetSaving(true); setError('')
    const payload = pendingImageRef.current || imageData
    const { data, error: requestError } = await supabase.from('keyflow_page_assets').upsert({ key: 'register_banner', image_data: payload, updated_at: new Date().toISOString() }).select('image_data, updated_at').single()
    setPageAssetSaving(false)
    if (requestError) return setError(requestError.message)
    setPageAsset(data); pendingImageRef.current = null
    if (data?.image_data) setCachedBanner(data.image_data)
    else { try { sessionStorage.removeItem(BANNER_CACHE_KEY) } catch {} }
    toast(payload ? '注册页头图已保存' : '已恢复默认头图')
  }

  const handlePageAssetFile = (file) => {
    if (!file?.type.startsWith('image/')) return setError('请选择图片文件')
    if (file.size > 500 * 1024) return setError('图片大小不能超过 500KB')
    const reader = new FileReader()
    reader.onload = () => { pendingImageRef.current = reader.result; setPageAsset((asset) => ({ ...asset, image_data: reader.result })) }
    reader.onerror = () => setError('图片读取失败，请重试')
    reader.readAsDataURL(file)
  }

  const saveMainQuestion = async () => {
    const { error: requestError } = await supabase.from('keyflow_activities').update({ main_question: mainQuestionDraft }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, main_question: mainQuestionDraft } : item))
    setEditingMainQuestion(false); toast('主问题已更新')
  }

  const updateSubQuestions = async (newSubs) => {
    const json = JSON.stringify(newSubs)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ sub_questions: json }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, sub_questions: json } : item))
  }

  const addSubQuestion = async () => {
    await updateSubQuestions([...subQuestions, ''])
    toast('已新增相关问题')
  }

  const saveSubQuestion = async (index) => {
    const newSubs = [...subQuestions]
    newSubs[index] = subDraft
    await updateSubQuestions(newSubs)
    setEditingSubIndex(null); toast('相关问题已更新')
  }

  const deleteSubQuestion = async (index) => {
    await updateSubQuestions(subQuestions.filter((_, i) => i !== index))
    toast('相关问题已删除')
  }

  const prependCodes = (newCodes) => { setInvitationCodes(prev => [...newCodes, ...prev]) }

  const loadData = async () => {
    setLoading(true); setError('')
    const [activityResult, applicationResult, deliveryResult, keyResult, invitationResult, answererResult, dailyResult, inboxResult, resetResult] = await Promise.all([
      supabase.from('keyflow_activities').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_applications').select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status, article_url)').order('submitted_at', { ascending: false }),
      supabase.from('keyflow_deliveries').select('*'),
      supabase.from('keyflow_keys').select('id, activity_id, platform, application_id, created_at, claimed_at').order('created_at', { ascending: false }),
      supabase.from('keyflow_invitation_codes').select('*').order('created_at', { ascending: false }).order('id'),
      supabase.from('keyflow_answerers').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_daily_submissions').select('*, keyflow_answerers!inner(zhihu_name, account_address)').order('submitted_at', { ascending: false }),
      supabase.from('keyflow_inbox').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_password_reset_requests').select('*').order('requested_at', { ascending: false }),
    ])
    const failure = activityResult.error || applicationResult.error || deliveryResult.error || keyResult.error || invitationResult.error || answererResult.error || dailyResult.error || inboxResult.error || resetResult.error
    if (failure) setError(failure.message)
    else {
      const rawActivities = activityResult.data || []
      const apps = applicationResult.data || []
      const { updated: afterDeadline } = autoAdvanceByDeadline(rawActivities)
      const { updated } = autoAdvanceByCondition(afterDeadline, apps)
      setActivities(updated); setApplications(apps); setDeliveries(deliveryResult.data || []); setKeys(keyResult.data || []); setInvitationCodes(invitationResult.data || []); setAnswerers(answererResult.data || []); setDailySubmissions(dailyResult.data || []); setInboxMessages(inboxResult.data || []); setPasswordResetRequests(resetResult.data || [])
      setSelectedId((current) => current || updated?.[0]?.id || '')
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])
  // 预加载注册页头图到 sessionStorage，避免打开注册/登录页时闪现
  useEffect(() => {
    const cached = getCachedBanner()
    if (cached) return;
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle()
      .then(({ data }) => { if (data?.image_data?.length > 100) setCachedBanner(data.image_data) })
  }, [])
  useEffect(() => { if (active === '页面编辑') loadPageAsset() }, [active])
  useEffect(() => { if (active === '答主日常投稿' && newDailyCount > 0) { supabase.from('keyflow_daily_submissions').update({ reviewed: true }).eq('reviewed', false).then(() => { setDailySubmissions(prev => prev.map(s => ({ ...s, reviewed: true }))) }) } }, [active])
  useEffect(() => { localStorage.setItem('lastSelectedId', selectedId) }, [selectedId])
  useEffect(() => { localStorage.setItem('lastActive', active) }, [active])

  const createActivity = async (event) => {
    event.preventDefault()
    const traceId = crypto.randomUUID()
    // #region debug-point A:submit
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'activity-create-duplicate', runId: 'pre-fix', hypothesisId: 'A', traceId, location: 'App.jsx:createActivity', msg: '[DEBUG] 创建活动提交开始', data: { submittedAt: Date.now() } }) }).catch(() => {})
    // #endregion
    const payload = {
      ...activityForm,
      target_authors: Number(activityForm.target_authors),
      application_deadline: activityForm.application_deadline || null,
      delivery_deadline: activityForm.delivery_deadline || null,
      is_online: false,
    }
    // #region debug-point C:request
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'activity-create-duplicate', runId: 'pre-fix', hypothesisId: 'C', traceId, location: 'App.jsx:createActivity', msg: '[DEBUG] 创建活动请求发送', data: { payloadHasId: Object.hasOwn(payload, 'id'), fieldNames: Object.keys(payload).sort() } }) }).catch(() => {})
    // #endregion
    const { data, error: requestError } = await supabase.from('keyflow_activities').insert(payload).select().single()
    // #region debug-point B:response
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'activity-create-duplicate', runId: 'pre-fix', hypothesisId: requestError ? 'D' : 'A', traceId, location: 'App.jsx:createActivity', msg: '[DEBUG] 创建活动请求完成', data: { id: data?.id, errorCode: requestError?.code, errorMessage: requestError?.message } }) }).catch(() => {})
    // #endregion
    if (requestError) return setError(requestError.message)
    setActivities((items) => [data, ...items]); setSelectedId(data.id); setActive('活动概览'); setActivityModal(false); setActivityForm({...initialActivity, ...getDefaultDeadlines()}); toast('活动已创建，可开始收集答主报名')
  }

  const createApplication = async (event) => {
    event.preventDefault()
    if (!selectedActivity) return
    const payload = { ...applicationForm, activity_id: selectedActivity.id, expected_word_count: Math.max(800, Number(applicationForm.expected_word_count) || 800) }
    if (!payload.zhihu_id) payload.zhihu_id = null
    const { data, error: requestError } = await supabase.from('keyflow_applications').insert(payload).select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').single()
    if (requestError) return setError(requestError.message)
    setApplications((items) => [data, ...items]); setApplicationModal(false); toast('报名信息已保存')
  }

  const reviewApplication = async (id, status) => {
    const { error: requestError } = await supabase.from('keyflow_applications').update({ status, reviewed_at: new Date().toISOString() }).eq('id', id)
    if (requestError) return setError(requestError.message)
    setApplications((items) => items.map((item) => item.id === id ? { ...item, status } : item)); toast(status === 'selected' ? '答主已入选' : '已更新答主状态')
  }

  const deleteApplication = (id) => {
    if (!window.confirm('确定要删除该答主的报名信息吗？此操作不可撤销。')) return
    setTimeout(async () => {
      const { error: requestError } = await supabase.from('keyflow_applications').delete().eq('id', id)
      if (requestError) return setError(requestError.message)
      setApplications((items) => items.filter((item) => item.id !== id))
      setKeys((items) => items.filter((item) => item.application_id !== id))
      setDeliveries((items) => items.filter((item) => item.application_id !== id))
      toast('报名信息已删除')
    }, 0)
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
      sub_questions: activityForm.sub_questions,
      review_requirement: activityForm.review_requirement,
      target_authors: Number(activityForm.target_authors),
      application_deadline: activityForm.application_deadline || null,
      delivery_deadline: activityForm.delivery_deadline || null,
      steam_url: activityForm.steam_url,
      game_cover: activityForm.game_cover,
      game_screenshots: activityForm.game_screenshots || '[]',
      partner_answerer_id: activityForm.partner_answerer_id || null,
    }
    const { error: requestError } = await supabase.from('keyflow_activities').update(payload).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    loadData(); setEditActivityModal(false); toast('活动已更新')
  }

  const deleteActivity = (id, event) => {
    event.stopPropagation()
    setConfirmState({
      message: '确定要删除该活动吗？关联的报名、Key 和交付数据也将被删除，此操作不可撤销。',
      onConfirm: async () => {
        setConfirmState(null)
        const { error: requestError } = await supabase.from('keyflow_activities').delete().eq('id', id)
        if (requestError) return setError(requestError.message)
        if (selectedId === id) setSelectedId('')
        setActivities((items) => items.filter((item) => item.id !== id))
        const removedAppIds = applications.filter(a => a.activity_id === id).map(a => a.id)
        setApplications((items) => items.filter((item) => item.activity_id !== id))
        if (removedAppIds.length) {
          const ids = new Set(removedAppIds)
          setKeys((items) => items.filter((item) => item.application_id === null || !ids.has(item.application_id)))
          setDeliveries((items) => items.filter((item) => !ids.has(item.application_id)))
        }
        toast('活动已删除')
      },
    })
  }

  const toggleOnline = async (id, isOnline, event) => {
    event.stopPropagation()
    const newValue = !isOnline
    setActivities((items) => items.map((item) => item.id === id ? { ...item, is_online: newValue } : item))
    const { error: requestError } = await supabase.from('keyflow_activities').update({ is_online: newValue }).eq('id', id)
    if (requestError) {
      setActivities((items) => items.map((item) => item.id === id ? { ...item, is_online: isOnline } : item))
      return setError(requestError.message)
    }
    toast(newValue ? '项目已上线' : '项目未上线')
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

  const reviewDelivery = async (delivery, status) => {
    const note = deliveryNotes[delivery.id] ?? delivery.reviewer_note ?? ''
    const { error: requestError } = await supabase.from('keyflow_deliveries').update({ status, reviewer_note: note, reviewed_at: new Date().toISOString() }).eq('id', delivery.id)
    if (requestError) return setError(requestError.message)
    setDeliveries((items) => items.map((item) => item.id === delivery.id ? { ...item, status, reviewer_note: note, reviewed_at: new Date().toISOString() } : item))
    setApplications((items) => items.map((item) => item.keyflow_deliveries?.id === delivery.id ? { ...item, keyflow_deliveries: { ...item.keyflow_deliveries, status, reviewer_note: note } } : item))
    toast(status === 'approved' ? '作品已通过验收' : status === 'revision_required' ? '已退回修改' : '作品已标记为未通过')
  }

  const STAGES = ['recruiting', 'key_distribution', 'delivery', 'completed']
  const STAGE_LABEL = { recruiting: '招募中', key_distribution: '发key中', delivery: '交付/创作中', completed: '项目完结' }

  const STAGE_TRIGGER = {
    recruiting: () => '招募时间截止后自动推进',
    key_distribution: () => '入选答主全部领Key后需手动推进',
    delivery: () => '全部交稿后自动推进',
  }

  const autoAdvanceByDeadline = (activitiesList) => {
    const now = new Date()
    let changed = false
    const updated = activitiesList.map((act) => {
      const status = act.status || 'recruiting'
      // 招募中 → 发key中：报名截止时间到期
      if (status === 'recruiting' && act.application_deadline && new Date(act.application_deadline) <= now) {
        changed = true
        supabase.from('keyflow_activities').update({ status: 'key_distribution' }).eq('id', act.id).then(() => {})
        return { ...act, status: 'key_distribution' }
      }
      return act
    })
    return { updated, changed }
  }

  const autoAdvanceByCondition = (activitiesList, apps) => {
    let changed = false
    const updated = activitiesList.map((act) => {
      const status = act.status || 'recruiting'
      if (status !== 'delivery') return act

      const selectedApps = apps.filter(a => a.activity_id === act.id && a.status === 'selected')
      if (selectedApps.length === 0) return act

      // 交付/创作中 → 项目完结：所有入选答主都已交稿
      if (selectedApps.every(a => a.keyflow_deliveries?.id)) {
        changed = true
        supabase.from('keyflow_activities').update({ status: 'completed' }).eq('id', act.id).then(() => {})
        return { ...act, status: 'completed' }
      }

      return act
    })
    return { updated, changed }
  }

  const advanceStage = async () => {
    const current = selectedActivity?.status || 'recruiting'
    const idx = STAGES.indexOf(current)
    if (idx < 0 || idx >= STAGES.length - 1) return
    setAdvancing(true)
    const next = STAGES[idx + 1]
    const { error: requestError } = await supabase.from('keyflow_activities').update({ status: next }).eq('id', selectedActivity.id)
    setAdvancing(false)
    if (requestError) return setError(requestError.message)
    setActivities((items) => items.map((item) => item.id === selectedActivity.id ? { ...item, status: next } : item))
    toast(`阶段已推进：${STAGE_LABEL[next]}`)
  }

  const resetStage = async () => {
    const { error: requestError } = await supabase.from('keyflow_activities').update({ status: 'recruiting' }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities((items) => items.map((item) => item.id === selectedActivity.id ? { ...item, status: 'recruiting' } : item))
    toast('阶段已重置为招募中')
  }

  const STAGE_COLOR = { recruiting: 'stage-blue', key_distribution: 'stage-orange', delivery: 'stage-purple', completed: 'stage-green' }

  const nav = [['活动看板', 'calendar'], ['活动概览', 'grid'], ['答主报名', 'users'], ['Key 管理', 'key'], ['交付验收', 'file'], ['答主管理', 'ticket'], ['合作方管理', 'users'], ['答主日常投稿', 'eye'], ['页面编辑', 'image']]
  const statusLabel = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatusLabel = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const activityDeliveries = deliveries.filter((item) => filteredApplications.some((application) => application.id === item.application_id))
  const pendingDeliveries = activityDeliveries.filter((item) => item.status === 'pending').length
  const approvedDeliveries = activityDeliveries.filter((item) => item.status === 'approved').length
  const revisionDeliveries = activityDeliveries.filter((item) => item.status === 'revision_required').length

  const urlParams = new URLSearchParams(window.location.search)
  const registerMode = urlParams.get('register') !== null
  if (registerMode) return <RegisterPage aid={urlParams.get('aid')} redirect={urlParams.get('redirect')} />
  const loginMode = urlParams.get('login') !== null
  if (loginMode) return <LoginPage aid={urlParams.get('aid')} redirect={urlParams.get('redirect')} token={urlParams.get('token')} />
  const dashboardMode = urlParams.get('dashboard') !== null
  if (dashboardMode) return <AnswererDashboard />
  const partnerToken = urlParams.get('partner')
  if (partnerToken !== null) return <PartnerPage token={partnerToken || undefined} />
  const applyId = urlParams.get('apply')
  const authCode = urlParams.get('authorization_code') || urlParams.get('code')
  if (applyId || authCode) {
    const activityId = applyId || sessionStorage.getItem('zhihu_oauth_activity_id')
    if (activityId) return <ClaimPage activityId={activityId} authCode={authCode} />
  }

  // 管理员登录门控：无 session 或显式访问 ?admin 时显示登录页
  const adminSession = (() => { try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY)) } catch { return null } })()
  const adminLoginMode = urlParams.get('admin') !== null
  if (adminLoginMode || !adminSession) return <AdminLoginPage />

  const claimLink = selectedActivity ? `${window.location.origin}${window.location.pathname}?apply=${selectedActivity.id}` : ''
  const partnerLink = selectedActivity?.partner_token ? `${window.location.origin}${window.location.pathname}?partner=${selectedActivity.partner_token}` : ''

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark zhihu-mark">知</span>GameJourney</div>
      <div className="sidebar-divider" />
      <nav className="nav-section"><p className="nav-label">工作台</p>{nav.map(([label, icon]) => <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => setActive(label)}><Icon name={icon}/><span>{label}</span>{label === '活动看板' && keyReadyCount > 0 && <b className="nav-alert">{keyReadyCount}</b>}{label === '答主报名' && pendingCount > 0 && <b>{pendingCount}</b>}{label === '答主日常投稿' && newDailyCount > 0 && <b className="nav-alert-orange">{newDailyCount}</b>}</button>)}</nav>
      <div className="sidebar-inbox-area">
        <button className={`sidebar-inbox-btn ${active === '收件箱' ? 'active' : ''}`} onClick={() => setActive('收件箱')} title="收件箱">
          <Icon name="inbox" size={20}/>
          <span>收件箱</span>
          {inboxMessages.filter(m => m.type !== 'private_message' && m.status === 'unread').length > 0 && <b className="nav-alert">{inboxMessages.filter(m => m.type !== 'private_message' && m.status === 'unread').length}</b>}
        </button>
      </div>
      <div className="profile">
        <span className="avatar">{adminSession?.display_name?.[0] || '管'}</span>
        <div className="profile-info">
          <strong>{adminSession?.display_name || '管理员'}</strong>
          <small>运营方</small>
        </div>
        <button className="admin-logout-btn" title="退出登录" onClick={() => { localStorage.removeItem(ADMIN_SESSION_KEY); window.location.href = window.location.pathname + '?admin' }}>退出</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div className="mobile-brand"><span className="brand-mark zhihu-mark">知</span> GameJourney</div><div className="crumb">工作台 <span>/</span> {active}</div><button className="reload" onClick={loadData}>刷新数据</button></header>
      <section className="content">
        <div className="page-title"><div><p className="eyebrow">真实数据工作台</p><h1>{active}{active !== '活动看板' && active !== '答主管理' && active !== '合作方管理' && active !== '页面编辑' && active !== '答主日常投稿' && active !== '收件箱' && selectedActivity?.game_name && <><span className="title-divider">|</span>{selectedActivity.game_name}</>}</h1><p className="subtitle">{active === '页面编辑' ? '管理注册页面的展示资源，保存后会实时同步。' : '活动、报名、Key 与交付数据均实时保存至 Supabase。'}</p></div>{active === '答主报名' ? <div style={{ display: 'flex', gap: 'var(--sp-2)' }}><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button></div> : active === '页面编辑' ? null : active === '活动看板' ? <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}><div className="partner-search-wrap" style={{ background: '#fff', minWidth: 260, gap: 'var(--sp-1)', padding: 'var(--sp-1) var(--sp-2)' }}><Icon name="search" size={14} /><input className="partner-search-input" placeholder="搜索活动名称或游戏名…" value={boardSearch} onChange={e => setBoardSearch(e.target.value)} />{boardSearch && <button className="partner-search-clear" onClick={() => setBoardSearch('')}><Icon name="close" size={14} /></button>}</div><button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : <button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button>}</div>
        {error && <div className="error-box">数据操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {loading && active !== '页面编辑' ? <div className="empty-state">正在加载活动数据…</div> : active === '活动概览' && !selectedActivity ? <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建第一个测评活动</h2><p>创建后即可收集答主报名、导入 Key 并进行交付验收。</p><button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : active === '活动概览' ? <>
          <section className="activity-picker"><button className="current-activity" onClick={openDrawer}><span>当前活动</span><strong>{selectedActivity.title}</strong><Icon name="arrow" size={14}/></button><div className="activity-picker-right"><span className={`activity-status ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span><button className="outline-button" onClick={() => { navigator.clipboard.writeText(partnerLink); toast('合作方页面链接已复制') }}>复制合作方链接</button><button className="outline-button preview-partner-btn" onClick={() => window.open(partnerLink, '_blank')}>预览合作方页</button><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button><button className="outline-button" onClick={() => setApplicationModal(true)}><Icon name="plus" size={16}/> 新增报名</button></div></section>
          <section className="hero-card real-hero"><div className="hero-top"><div><span className="live-dot"/> <span className={`stage-badge ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span> <span className="divider">|</span> <span className={currentActivityKeyReady ? 'text-alert-flash' : ''}>{getStatusTimeText(selectedActivity, filteredApplications)}</span></div><button className="edit-button" onClick={openEditActivity}><Icon name="edit" size={15}/> 编辑</button></div><div className="game-info"><div className="game-cover">{selectedActivity.game_cover ? <img src={selectedActivity.game_cover} alt={selectedActivity.game_name}/> : <span>{selectedActivity.game_name[0]}</span>}</div><div><p className="game-type">{selectedActivity.game_name}</p><h2>{selectedActivity.title}</h2><p>{selectedActivity.description || '尚未填写游戏简介。'}</p><p className="review-requirement">{selectedActivity.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'}</p></div></div><div className="rules-row main-question-row"><strong>测评主问题</strong>{editingMainQuestion ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={mainQuestionDraft} onChange={(e) => setMainQuestionDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={saveMainQuestion}>保存</button><button className="inline-cancel" onClick={() => { setEditingMainQuestion(false) }}>取消</button></div></div> : <div className="inline-display"><span>{selectedActivity.main_question || '尚未设置'}</span><button className="inline-edit-btn" title="编辑主问题" onClick={() => { setMainQuestionDraft(selectedActivity.main_question || ''); setEditingMainQuestion(true) }}><Icon name="edit" size={14}/></button></div>}</div>{subQuestions.map((q, i) => <div className="rules-row sub-question-row" key={i}><strong>相关问题 {i + 1}</strong>{editingSubIndex === i ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={subDraft} onChange={(e) => setSubDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={() => saveSubQuestion(i)}>保存</button><button className="inline-cancel" onClick={() => setEditingSubIndex(null)}>取消</button></div></div> : <div className="inline-display"><span>{q || '空问题'}</span><button className="inline-edit-btn" title="编辑相关问题" onClick={() => { setSubDraft(q); setEditingSubIndex(i) }}><Icon name="edit" size={14}/></button><button className="inline-delete-btn" title="删除相关问题" onClick={() => deleteSubQuestion(i)}><Icon name="close" size={14}/></button></div>}</div>)}<button className="add-sub-btn" onClick={addSubQuestion}><Icon name="plus" size={14}/> 新增相关问题</button></section>
          <section className="metrics">{[[filteredApplications.length,'报名答主','全部报名','答主报名'],[selectedCount,'已入选',`目标 ${selectedActivity.target_authors} 人`,'答主报名'],[claimedCount,'已领取 Key',`${selectedCount - claimedCount}/${selectedCount} 人 未领取key`,'Key 管理'],[deliveredCount,'已提交交付',`${selectedCount - deliveredCount}/${selectedCount} 人未交付`,'交付验收']].map(([number,label,note,target]) => <div className="metric clickable" key={label} onClick={() => setActive(target)}><strong>{number}</strong><span>{label}</span><small>{note}</small></div>)}</section>
          <section className="stage-progression"><div className="stage-header"><div><h3>阶段推进</h3><span>截止时间到期或全部交稿后自动推进，全部领Key后可手动点击「推进」</span></div><button className="outline-button stage-reset-btn" onClick={resetStage}>重置阶段</button></div><div className="stage-timeline">{STAGES.map((stage, i) => { const currentIdx = STAGES.indexOf(selectedActivity?.status || 'recruiting'); const isCurrent = i === currentIdx; const isPast = i < currentIdx; const isNext = i === currentIdx + 1; const trigger = STAGE_TRIGGER[stage] ? STAGE_TRIGGER[stage](selectedActivity) : ''; return <div key={stage} className={`stage-node ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''} ${isNext ? 'next' : ''}`}><button className="stage-dot-btn" disabled={i !== currentIdx + 1} onClick={i === currentIdx + 1 ? advanceStage : undefined}><span className="stage-dot"/></button><span className="stage-label">{STAGE_LABEL[stage]}</span>{isNext ? <button className={`stage-action ${currentActivityKeyReady ? 'pulse' : ''}`} onClick={advanceStage} disabled={advancing}>{advancing ? '...' : '推进'}</button> : i > currentIdx ? <span className="stage-action muted">推进</span> : isCurrent && i > 0 && i < STAGES.length - 1 ? <><span className="stage-action manual-advance disabled">...</span><span className="stage-action current-hint">{trigger}</span></> : isCurrent && i === 0 ? <span className="stage-action current-hint">{trigger}</span> : isPast ? <span className="stage-action"><Icon name="check" size={12}/></span> : null}</div> })}</div></section>
          <section className="panel applicants-panel"><div className="panel-head"><div><h3>答主报名</h3><p>查看答主报名、Key 领取和内容提交状态。</p></div><button className="primary compact" onClick={() => setApplicationModal(true)}><Icon name="plus" size={15}/> 新增报名</button></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>查看主页</th><th>入选状态</th><th>是否领取 Key</th><th>是否提交内容</th><th>操作</th></tr></thead><tbody>{filteredApplications.length ? filteredApplications.map((person) => <tr key={person.id}><td><div className="person">{answererByName[person.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[person.zhihu_name].avatar_url} alt="" /> : <span className="person-avatar">{person.zhihu_name[0]}</span>}<div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td><span className={`pill ${person.keyflow_keys?.claimed_at ? 'success' : 'muted'}`}>{person.keyflow_keys?.claimed_at ? '已领取' : '未领取'}</span></td><td><button className={`pill pill-link ${person.keyflow_deliveries?.id ? 'success' : 'muted'}`} onClick={() => setActive('交付验收')}>{person.keyflow_deliveries?.id ? '已提交' : '未提交'}</button></td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => reviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => reviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" disabled={!!person.keyflow_keys?.claimed_at} onClick={() => reviewApplication(person.id, 'pending')}>重新筛选</button>}</div></td></tr>) : <tr><td colSpan="6" className="table-empty">还没有报名记录。可添加测试报名，或后续将表单公开给答主填写。</td></tr>}</tbody></table></div></section>
        </> : active === '活动看板' ? <div className="activity-cards">{filteredBoardActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); const creatingCount = apps.filter(a => a.status === 'selected' && a.keyflow_keys?.claimed_at).length; const deliveredCount = apps.filter(a => a.keyflow_deliveries?.id).length; const isKeyReady = item.status === 'key_distribution' && apps.filter(a => a.status === 'selected').length > 0 && apps.filter(a => a.status === 'selected').every(a => a.keyflow_keys?.claimed_at); return <div key={item.id} className={`activity-card ${item.id === selectedId ? 'selected' : ''} ${isKeyReady ? 'alert' : ''}`} onClick={() => { setSelectedId(item.id); setActive('活动概览') }}><button className="activity-card-delete" title="删除活动" onClick={(e) => deleteActivity(item.id, e)}><Icon name="close" size={14}/></button><div className="activity-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="activity-card-body"><p className="activity-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="activity-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{item.status === 'delivery' ? `${creatingCount} 人创作中` : item.status === 'completed' ? `${deliveredCount} 篇作品` : `${apps.length} 报名`}</span></div><small>{getStatusTimeText(item, apps)}</small><div className="activity-card-online" onClick={(e) => toggleOnline(item.id, item.is_online !== false, e)} title={item.is_online !== false ? '已上线，点击下线' : '未上线，点击上线'}><span className={`online-toggle ${item.is_online !== false ? 'active' : ''}`}><span className="online-toggle-knob"/></span><span className="online-label">{item.is_online !== false ? '已上线' : '未上线'}</span></div></div></div> })}</div> : active === '答主报名' ? <ApplicationsPage activity={selectedActivity} applications={filteredApplications} answerers={answerers} authorStats={authorStats} statusLabel={statusLabel} onSelectActivity={openDrawer} onAddApplication={() => setApplicationModal(true)} onReviewApplication={reviewApplication} onDeleteApplication={deleteApplication} toast={toast} /> : active === 'Key 管理' ? <KeyManagement activity={selectedActivity} input={keyInput} parsedKeys={parsedKeys} platformCounts={platformCounts} importedKeys={keys.filter((item) => item.activity_id === selectedActivity?.id)} importing={keyImporting} onInput={setKeyInput} onImport={importKeys} onSelectActivity={openDrawer} applications={filteredApplications} toast={toast}/> : active === '交付验收' ? <DeliveriesPage activity={selectedActivity} deliveries={activityDeliveries} applications={filteredApplications} answerers={answerers} statusLabel={deliveryStatusLabel} notes={deliveryNotes} onNoteChange={(id, value) => setDeliveryNotes((items) => ({ ...items, [id]: value }))} onReview={reviewDelivery} onSelectActivity={openDrawer} pendingCount={pendingDeliveries} approvedCount={approvedDeliveries} revisionCount={revisionDeliveries} toast={toast} /> : active === '答主管理' ? <AnswererManagement codes={invitationCodes} answerers={answerers} activities={activities} applications={applications} onAddCodes={prependCodes} onRefresh={loadData} /> : active === '合作方管理' ? <PartnerManagement codes={invitationCodes} answerers={answerers} activities={activities} onAddCodes={prependCodes} onRefresh={loadData} /> : active === '答主日常投稿' ? <DailySubmissionsPage submissions={dailySubmissions} answerers={answerers} toast={toast} setDailySubmissions={setDailySubmissions} /> : active === '页面编辑' ? <PageEditor asset={pageAsset} loading={pageAssetLoading} saving={pageAssetSaving} onSelectFile={handlePageAssetFile} onSave={savePageAsset} /> : active === '收件箱' ? <InboxPage messages={inboxMessages} requests={passwordResetRequests} answerers={answerers} onRefresh={loadData} toast={toast} setConfirmState={setConfirmState} /> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>{active}即将开放</h2><p>请先完成活动与答主报名管理。</p></div>}
      </section>
    </main>
    {drawerOpen && <div className="drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><h2>切换活动</h2><button onClick={() => setDrawerOpen(false)}><Icon name="close"/></button></header><div className="drawer-search"><Icon name="grid" size={16}/><input placeholder="搜索活动名称或游戏名…" value={drawerSearch} onChange={(event) => setDrawerSearch(event.target.value)} autoFocus/></div><div className="drawer-list">{filteredDrawerActivities.length ? filteredDrawerActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); return <div key={item.id} className={`drawer-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDrawerOpen(false) }}><div className="drawer-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="drawer-card-body"><p className="drawer-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="drawer-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{apps.length} 报名</span></div></div></div> }) : <div className="drawer-empty">没有匹配的活动</div>}</div></aside></div>}
    {activityModal && <Modal title="创建测评活动" onClose={() => setActivityModal(false)}><form onSubmit={createActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/>{activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}<button className="primary form-submit">保存并创建</button></form></Modal>}
    {applicationModal && <Modal title="新增答主报名" onClose={() => setApplicationModal(false)}><form onSubmit={createApplication} className="form-grid"><Field label="知乎 ID（可选，用于防重复）" value={applicationForm.zhihu_id} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_id: value })} placeholder="知乎 OAuth 返回的用户 ID"/><Field label="知乎名称" required value={applicationForm.zhihu_name} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_name: value })}/><Field label="微信名" required value={applicationForm.wechat_name} onChange={(value) => setApplicationForm({ ...applicationForm, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={applicationForm.profile_url} onChange={(value) => setApplicationForm({ ...applicationForm, profile_url: value })}/><Field label="预计完成字数" type="number" required value={applicationForm.expected_word_count} onChange={(value) => setApplicationForm({ ...applicationForm, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setApplicationForm({ ...applicationForm, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span><button className="primary form-submit">保存报名</button></form></Modal>}
    {editActivityModal && <Modal title="编辑活动" onClose={() => setEditActivityModal(false)}><form onSubmit={updateActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field"><span>关联合作方</span><select value={activityForm.partner_answerer_id || ''} onChange={(e) => setActivityForm({ ...activityForm, partner_answerer_id: e.target.value || null })}><option value="">— 不关联合作方 —</option>{partnerAnswerers.map((a) => <option key={a.id} value={a.id}>{a.zhihu_name}{a.wechat_id ? ` (${a.wechat_id})` : ''}</option>)}</select><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>关联后，该合作方登录可查看此活动协作页。需先在「合作方管理」中生成并注册合作方账号。</small></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/>{activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}<button className="primary form-submit">保存修改</button></form></Modal>}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
    {confirmState && <ConfirmDialog message={confirmState.message} onConfirm={confirmState.onConfirm} onCancel={() => setConfirmState(null)} />}
  </div>
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return <div className="modal-backdrop" onMouseDown={onCancel}><section className="modal confirm-dialog" onMouseDown={(e) => e.stopPropagation()}><header><h2>确认操作</h2></header><div className="confirm-body"><p>{message}</p><div className="confirm-actions"><button className="outline-button" onClick={onCancel}>取消</button><button className="primary danger" onClick={onConfirm}>确认删除</button></div></div></section></div>
}

function PageEditor({ asset, loading, saving, onSelectFile, onSave }) {
  const image = asset?.image_data || defaultRegisterBanner
  return <section className="page-editor">
    <div className="panel page-editor-card"><div className="panel-head"><div><h3>用户注册界面头图</h3><p>支持本地图片，使用 data URL 保存到 Supabase，不依赖 Storage。</p></div><span className="pill success">register_banner</span></div>
      <div className="page-editor-body">{loading ? <div className="page-asset-loading">正在加载头图…</div> : <img className="page-asset-preview" src={image} alt="注册页头图预览" />}
        <div className="page-editor-actions"><label className="outline-button page-file-button"><Icon name="image" size={16}/> 选择图片<input type="file" accept="image/*" onChange={(event) => onSelectFile(event.target.files[0])} /></label><button className="primary" disabled={saving || loading} onClick={() => onSave(asset?.image_data || '')}>{saving ? '保存中…' : '保存头图'}</button><button className="outline-button" disabled={saving || loading} onClick={() => onSave('')}>恢复默认</button></div>
        <p className="page-editor-hint">未保存的选择仅在当前页面预览；恢复默认会移除数据库中的自定义图片。</p>
      </div>
    </div>
  </section>
}

function PartnerPage({ token }) {
  const answerer = getAnswererSession()
  const [snapshot, setSnapshot] = useState(null)
  const [partnerActivities, setPartnerActivities] = useState(null)
  const [isPartner, setIsPartner] = useState(null) // null=loading, true/false
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [heroColor, setHeroColor] = useState('18, 58, 52')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [pwdResetModalOpen, setPwdResetModalOpen] = useState(false)
  const [pwdResetStep, setPwdResetStep] = useState('idle')
  const [pwdResetMsg, setPwdResetMsg] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdResetLoading, setPwdResetLoading] = useState(false)
  const [gameSwitcherOpen, setGameSwitcherOpen] = useState(false)
  const [gameSwitcherSearch, setGameSwitcherSearch] = useState('')
  const [avatarModalOpen, setAvatarModalOpen] = useState(false)
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(answerer?.avatar_url || '')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [inboxModalOpen, setInboxModalOpen] = useState(false)
  const [answererInbox, setAnswererInbox] = useState([])
  const [unreadInboxCount, setUnreadInboxCount] = useState(0)
  const parsedKeys = useMemo(() => parseKeys(input), [input])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const toast = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 2800) }

  // ---- 身份校验：检查是否为合作方 ----
  const checkPartner = async () => {
    if (!answerer?.id) return
    if (answerer.zhihu_name === '灰域信风') { setIsPartner(true); return }
    const { data, error: rpcErr } = await supabase.rpc('keyflow_is_partner', { p_answerer_id: answerer.id })
    if (rpcErr) { setIsPartner(false); return }
    setIsPartner(!!data)
  }

  const loadSnapshot = async () => {
    if (!token || !answerer?.id) return
    setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_partner_activity_snapshot', { p_partner_token: token, p_answerer_id: answerer.id })
    if (requestError) setError(requestError.message)
    else setSnapshot(data)
  }

  const loadPartnerActivities = async () => {
    if (!answerer?.id) return
    setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_get_partner_activities', { p_answerer_id: answerer.id })
    if (requestError) setError(requestError.message)
    else setPartnerActivities(data)
  }

  useEffect(() => { if (answerer?.id) { checkPartner(); fetchUnreadCount() } }, [answerer?.id])

  // Realtime inbox — red dot updates without refresh
  useEffect(() => {
    if (!answerer?.id) return
    const channel = supabase
      .channel('partner-inbox-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'keyflow_inbox', filter: `to_id=eq.${answerer.id}` }, (payload) => {
        if (payload.new.type === 'private_message' && payload.new.status === 'unread') {
          setUnreadInboxCount(prev => prev + 1)
        }
      })
      .subscribe()
    return () => { channel.unsubscribe() }
  }, [answerer?.id])
  useEffect(() => { if (isPartner && answerer?.id) { loadPartnerActivities(); if (token) loadSnapshot() } }, [isPartner, token, answerer?.id])

  useEffect(() => {
    const cover = snapshot?.activity?.game_cover
    setHeroColor('18, 58, 52')
    if (!cover) return
    const image = new Image()
    let cancelled = false
    const fallback = () => { if (!cancelled) setHeroColor('18, 58, 52') }
    const sample = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 48
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return fallback()
        context.drawImage(image, 0, 0, 48, 48)
        const pixels = context.getImageData(0, 0, 48, 48).data
        let red = 0, green = 0, blue = 0, count = 0
        for (let y = 10; y < 38; y++) for (let x = 10; x < 38; x++) {
          const index = (y * 48 + x) * 4
          if (pixels[index + 3] < 128) continue
          red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2]; count++
        }
        if (!count) return fallback()
        const average = [red / count, green / count, blue / count]
        const luminance = (average[0] * 0.2126 + average[1] * 0.7152 + average[2] * 0.0722) / 255
        const scale = Math.min(1, 0.16 / Math.max(luminance, 0.01))
        if (!cancelled) setHeroColor(average.map((value) => Math.round(value * scale)).join(', '))
      } catch { fallback() }
    }
    image.crossOrigin = 'anonymous'
    image.addEventListener('load', sample)
    image.addEventListener('error', fallback)
    image.src = cover
    return () => { cancelled = true; image.removeEventListener('load', sample); image.removeEventListener('error', fallback) }
  }, [snapshot?.activity?.game_cover])

  // ---- 登录门控：未登录时显示引导 ----
  if (!answerer) {
    const loginHref = `?login&redirect=partner${token ? '&token=' + token : ''}`
    return <div className="public-page"><main className="public-card dashboard-login-card"><div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 合作方协作页</span></div><div className="step-message"><div className="step-message-icon waiting"><Icon name="users" size={24}/></div><p>登录后查看合作方协作页</p><span>使用你注册的合作方账号登录，即可查看活动报名与交稿进展。</span><div className="dashboard-auth-actions"><a href={loginHref} className="primary">去登录</a><a href="?register&redirect=partner" className="outline-button">去注册</a></div></div></main></div>
  }

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

  const toggleRecommend = async (applicationId) => {
    const { error: requestError } = await supabase.rpc('keyflow_partner_toggle_recommend', { p_partner_token: token, p_application_id: applicationId })
    if (requestError) return setError(requestError.message)
    await loadSnapshot()
  }

  // ---- 头像上传 ----
  const handleAvatarFile = (file) => {
    setError('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    if (file.size > 500 * 1024) { setError('图片大小不能超过 500KB，请压缩后重新选择'); return }
    const reader = new FileReader()
    reader.onload = (e) => { setAvatarPreview(e.target.result); setAvatarFile(file) }
    reader.readAsDataURL(file)
  }

  const uploadAvatar = async () => {
    if (!avatarFile) { setAvatarUploading(false); return }
    setAvatarUploading(true)
    const reader = new FileReader()
    reader.onload = async (e) => {
      const avatarUrl = e.target.result
      const { error: updateErr } = await supabase.from('keyflow_answerers').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', answerer.id)
      if (updateErr) { setAvatarUploading(false); return }
      const session = { ...answerer, avatar_url: avatarUrl }
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
      setAvatarUploading(false)
      setAvatarModalOpen(false)
      setAvatarPreview(avatarUrl)
      toast('头像已更新')
    }
    reader.readAsDataURL(avatarFile)
  }

  // ---- 私信 ----
  const loadInbox = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.from('keyflow_inbox')
      .select('*').eq('to_id', answerer.id).eq('type', 'private_message')
      .order('created_at', { ascending: false })
    setAnswererInbox(data || [])
  }

  const fetchUnreadCount = async () => {
    if (!answerer?.id) return
    const { count } = await supabase.from('keyflow_inbox')
      .select('*', { count: 'exact', head: true })
      .eq('to_id', answerer.id).eq('status', 'unread').eq('type', 'private_message')
    setUnreadInboxCount(count || 0)
  }

  const handleDeleteInbox = async (msg) => {
    const { error } = await supabase.from('keyflow_inbox').delete().eq('id', msg.id)
    if (error) { toast(error.message); return }
    setAnswererInbox(prev => prev.filter(m => m.id !== msg.id))
    if (msg.status === 'unread') setUnreadInboxCount(prev => Math.max(0, prev - 1))
  }

  // ---- 密码重置 ----
  const loadResetStatus = async () => {
    const { data } = await supabase.from('keyflow_password_reset_requests')
      .select('*').eq('answerer_id', answerer.id)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'pending') setPwdResetStep('pending')
      else if (data.status === 'approved') setPwdResetStep('approved')
      else if (data.status === 'rejected') { setPwdResetStep('rejected'); setPwdResetMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
    }
  }

  const requestPasswordReset = async () => {
    setPwdResetLoading(true); setPwdResetMsg('')
    const { data, error: rpcErr } = await supabase.rpc('keyflow_request_password_reset', { p_answerer_id: answerer.id })
    setPwdResetLoading(false)
    if (rpcErr) {
      if (rpcErr.message.includes('已有一个待处理')) { setPwdResetStep('pending'); setPwdResetMsg(rpcErr.message); return }
      setPwdResetMsg(rpcErr.message); return
    }
    setPwdResetStep('pending')
  }

  const checkResetStatus = async () => {
    const { data } = await supabase.from('keyflow_password_reset_requests').select('*').eq('answerer_id', answerer.id).order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'approved') setPwdResetStep('approved')
      else if (data.status === 'rejected') { setPwdResetStep('rejected'); setPwdResetMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
      else if (data.status === 'completed') setPwdResetStep('done')
    }
  }

  const resetPassword = async () => {
    if (!newPassword) { setPwdResetMsg('请输入新密码'); return }
    if (newPassword !== confirmPassword) { setPwdResetMsg('两次输入密码不一致'); return }
    if (newPassword.length < 4) { setPwdResetMsg('密码至少4位'); return }
    setPwdResetLoading(true); setPwdResetMsg('')
    const { error: rpcErr } = await supabase.rpc('keyflow_reset_password', { p_answerer_id: answerer.id, p_new_password: newPassword })
    setPwdResetLoading(false)
    if (rpcErr) { setPwdResetMsg(rpcErr.message); return }
    setPwdResetStep('done'); setPwdResetMsg('密码重置成功，请使用新密码重新登录。')
    setTimeout(() => { localStorage.removeItem(SESSION_KEY); window.location.href = `?login&redirect=partner${token ? '&token=' + token : ''}` }, 2000)
  }

  useEffect(() => {
    if (pwdResetStep === 'pending' || pwdResetStep === 'approved') {
      const interval = setInterval(checkResetStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [pwdResetStep])

  const filteredGames = useMemo(() => {
    const others = partnerActivities?.filter(a => a.partner_token !== token) || []
    if (!gameSwitcherSearch) return others
    const q = gameSwitcherSearch.toLowerCase()
    return others.filter(a => (a.game_name || '').toLowerCase().includes(q) || (a.title || '').toLowerCase().includes(q))
  }, [partnerActivities, token, gameSwitcherSearch])

  // ---- 加载中 / 非合作方 ----
  if (isPartner === null) return <div className="partner-page"><div className="partner-loading">正在加载合作方协作页…</div></div>
  if (!isPartner) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 合作方协作页</span></div><div className="step-message"><p>你的账号不是合作方身份</p><span>请使用合作方邀请码注册的账号登录，或联系运营人员获取合作方账号。</span><div className="dashboard-auth-actions"><button className="outline-button" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}>切换账号</button></div></div></main></div>

  // ---- 无 token：显示合作方活动列表 ----
  if (!token) {
    const stageLabel = { recruiting: '招募中', key_distribution: '发 Key 中', delivery: '交付/创作中', completed: '项目完结' }
    const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - new Date()) / 86400000))
    return <div className="partner-page"><header className="partner-header"><div className="partner-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>合作方协作页</small></div><div className="partner-header-right"><button className="reload outline" onClick={() => { window.location.href = '?dashboard' }}>切换到答主看板</button>{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<div className="dashboard-user-area" onClick={() => setDropdownOpen(!dropdownOpen)}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main"><section className="partner-hero" style={{ '--partner-hero-rgb': heroColor }}><div className="partner-hero-content"><h1>我的合作活动</h1><span>点击进入活动协作页查看详情。</span></div></section><section className="dashboard-activity-cards">{partnerActivities === null ? <div className="partner-loading">正在加载活动列表…</div> : !partnerActivities.length ? <div className="panel" style={{gridColumn:'1/-1'}}><div className="step-message"><p>暂无关联的合作活动</p><span>请联系运营人员将你关联到对应活动。</span></div></div> : partnerActivities.map((activity) => <a className="dashboard-activity-card" href={`?partner=${activity.partner_token}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name}/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>{activity.delivery_deadline && <span className="dashboard-deadline">截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>)}</section></main>
      {pwdResetModalOpen && <Modal title="重置密码" onClose={() => { setPwdResetModalOpen(false); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>
        <div className="pwd-reset-body">
          {pwdResetStep === 'idle' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon"><Icon name="key" size={24}/></div><p className="pwd-reset-step-title">申请密码重置</p><p className="pwd-reset-step-desc">将向管理员提交密码重置申请。管理员审核通过后，你可以在此页面设置新密码。</p><button className="primary" onClick={requestPasswordReset} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '提交申请'}</button></div>}
          {pwdResetStep === 'pending' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon waiting"><Icon name="clock" size={24}/></div><p className="pwd-reset-step-title">等待审核</p><p className="pwd-reset-step-desc">申请已提交，等待管理员审核。<br/>页面会自动刷新状态。</p></div>}
          {pwdResetStep === 'approved' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">设置新密码</p><p className="pwd-reset-step-desc">管理员已通过你的申请，请在下方设置新密码。</p><Field label="新密码" type="password" required value={newPassword} placeholder="输入新密码（至少4位）" onChange={setNewPassword} /><Field label="确认新密码" type="password" required value={confirmPassword} placeholder="再次输入新密码" onChange={setConfirmPassword} /><button className="primary" onClick={resetPassword} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '确认重置'}</button></div>}
          {pwdResetStep === 'rejected' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon rejected"><Icon name="close" size={24}/></div><p className="pwd-reset-step-title">申请被拒绝</p><p className="pwd-reset-step-desc">{pwdResetMsg || '管理员拒绝了你的密码重置申请。'}</p><button className="outline-button" onClick={() => { setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>重新申请</button></div>}
          {pwdResetStep === 'done' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">密码重置成功</p><p className="pwd-reset-step-desc">请使用新密码重新登录，即将跳转到登录页...</p></div>}
        </div>
      </Modal>}
      {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setError(''); setAvatarFile(null) }}>
        <div className="avatar-upload-body">
          <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{answerer?.zhihu_name?.[0]}</span>}</div>
          <p className="avatar-upload-hint">支持 JPG、PNG 格式，大小不超过 500KB</p>
          <div className="avatar-upload-actions">
            <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
            {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
          </div>
          {error && <p className="avatar-upload-error">{error}</p>}
        </div>
      </Modal>}
      {inboxModalOpen && <Modal className="answerer-inbox-modal" title="收件箱" onClose={() => setInboxModalOpen(false)}>
        <div className="answerer-inbox-body">
          {answererInbox.length ? answererInbox.map(msg => (
            <div key={msg.id} className={`answerer-inbox-item ${msg.status === 'unread' ? 'unread' : ''}`}>
              <div className="answerer-inbox-item-header" onClick={async () => {
                if (msg.status === 'unread') {
                  await supabase.from('keyflow_inbox').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', msg.id)
                  setAnswererInbox(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'read', read_at: new Date().toISOString() } : m))
                  setUnreadInboxCount(prev => Math.max(0, prev - 1))
                }
              }}>
                <div className="answerer-inbox-item-left">
                  <span className="answerer-inbox-dot"/>
                  <div>
                    <strong>{msg.title}</strong>
                    <small><span className="answerer-inbox-sender">知乎游戏</span> · {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(msg.created_at))}</small>
                  </div>
                </div>
                <button className="inbox-delete-btn" title="删除消息" onClick={(e) => { e.stopPropagation(); handleDeleteInbox(msg) }}>
                  <Icon name="close" size={14}/>
                </button>
              </div>
              <div className="answerer-inbox-item-body">
                <div className="answerer-inbox-item-body-inner">
                  <p>{msg.body}</p>
                </div>
              </div>
            </div>
          )) : <div className="answerer-inbox-empty"><div className="answerer-inbox-empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3H10l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><p>暂无消息</p></div>}
        </div>
      </Modal>}
      {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}</div>
  }

  // ---- 有 token：加载中 / 错误处理 ----
  if (!snapshot && !error) return <div className="partner-page"><div className="partner-loading">正在加载活动协作页…</div></div>
  if (!snapshot) return <div className="partner-page"><div className="partner-loading">{error || '该合作方页面不存在或已失效。'}</div></div>

  const { activity, applications, deliveries, key_count: keyCount } = snapshot
  const selectedCount = applications.filter((item) => item.status === 'selected').length
  const applicationStatus = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatus = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }

  return <div className="partner-page"><header className="partner-header"><div className="partner-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>合作方协作页</small></div><div className="partner-header-right"><button className="reload outline" onClick={() => { window.location.href = '?dashboard' }}>切换到答主看板</button>{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<button className="reload" onClick={loadSnapshot}>刷新数据</button>{partnerActivities && partnerActivities.filter(a => a.partner_token !== token).length > 0 && <button className="reload" onClick={() => { setGameSwitcherOpen(true); setGameSwitcherSearch(''); setDropdownOpen(false) }}>切换游戏</button>}<div className="dashboard-user-area" onClick={() => { setDropdownOpen(!dropdownOpen); setGameSwitcherOpen(false) }}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main"><section className="partner-hero" style={{ '--partner-hero-rgb': heroColor }}><div className="partner-hero-content"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>在此补充活动 Key，并实时查看报名与交稿进展。</span><div><span>报名截止 {formatDate(activity.application_deadline)}</span><span>交付截止 {formatDate(activity.delivery_deadline)}</span></div></div>{activity.game_cover && <div className="partner-hero-art" aria-hidden="true"><img src={activity.game_cover} alt="" /></div>}</section>{error && <div className="error-box">操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}<section className="partner-metrics"><div><strong>{keyCount}</strong><span>已入库 Key</span></div><div><strong>{applications.length}</strong><span>累计报名</span></div><div><strong>{selectedCount}</strong><span>已入选答主</span></div><div><strong>{deliveries.length}</strong><span>已交稿</span></div></section><section className="partner-grid"><section className="panel partner-key-panel"><div className="panel-head"><div><h3>添加 Key</h3><p>每行一个，也支持逗号、分号和制表符分隔；平台将自动识别。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>{parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div></div>}<div className="key-import-footer"><span>重复 Key 将自动跳过，Key 明文不会展示在数据列表中。</span><button className="primary" onClick={importKeys} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section><section className="panel partner-progress"><div className="panel-head"><div><h3>进度说明</h3><p>活动数据由运营方维护，以下信息会实时更新。</p></div></div><div className="progress-list"><div><Icon name="users"/><span>报名情况</span><strong>{applications.length} 人</strong></div><div><Icon name="check"/><span>入选答主</span><strong>{selectedCount} 人</strong></div><div><Icon name="file"/><span>交稿情况</span><strong>{deliveries.length} 篇</strong></div></div><a className="partner-apply-link" href={window.location.origin + window.location.pathname + '?apply=' + activity.id}>点击进入答主报名页面</a></section></section><section className="panel partner-table"><div className="panel-head"><div><h3>报名情况</h3><p>展示答主信息，合作方可标记推荐人选。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>知乎主页</th><th>字数预估</th><th>推荐入选</th><th>报名时间</th><th>状态</th></tr></thead><tbody>{applications.length ? applications.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td><span className="person-name">{item.zhihu_name}</span></td><td><a className="profile-link" href={item.profile_url} target="_blank" rel="noreferrer">查看主页 <Icon name="arrow" size={13}/></a></td><td>{item.expected_word_count ? `${item.expected_word_count.toLocaleString()} 字` : '—'}</td><td><button className={`recommend-toggle ${item.partner_recommended ? 'active' : ''}`} onClick={() => toggleRecommend(item.id)} title={item.partner_recommended ? '取消推荐' : '推荐入选'}>{item.partner_recommended ? '已推荐' : '推荐'}</button></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'selected' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{applicationStatus[item.status]}</span></td></tr>) : <tr><td colSpan="6" className="table-empty">暂无报名记录。</td></tr>}</tbody></table></div></section><section className="panel partner-table"><div className="panel-head"><div><h3>交稿情况</h3><p>合作方可查看已提交作品的审核进度。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>交稿时间</th><th>审核状态</th><th>作品</th></tr></thead><tbody>{deliveries.length ? deliveries.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td>{item.zhihu_name}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{deliveryStatus[item.status]}</span></td><td><a className="profile-link" href={cleanZhihuAnswerUrl(item.article_url)} target="_blank" rel="noreferrer">查看作品</a></td></tr>) : <tr><td colSpan="4" className="table-empty">暂无交稿记录。</td></tr>}</tbody></table></div></section></main>
    {gameSwitcherOpen && <div className="drawer-backdrop" onMouseDown={() => setGameSwitcherOpen(false)}><aside className="drawer" onMouseDown={(e) => e.stopPropagation()}><header className="drawer-header"><h2>切换游戏</h2><button onClick={() => setGameSwitcherOpen(false)}><Icon name="close"/></button></header><div className="drawer-search"><Icon name="grid" size={16}/><input placeholder="搜索游戏名称或活动名…" value={gameSwitcherSearch} onChange={(e) => setGameSwitcherSearch(e.target.value)} autoFocus/></div><div className="drawer-list">{filteredGames.length ? filteredGames.map((a) => <div key={a.partner_token} className="drawer-card" onClick={() => { setGameSwitcherOpen(false); window.location.href = '?partner=' + a.partner_token }}><div className="drawer-card-cover">{a.game_cover ? <img src={a.game_cover} alt={a.game_name}/> : <span>{a.game_name?.[0] || '游'}</span>}</div><div className="drawer-card-body"><p className="drawer-card-game">{a.game_name}</p><h3>{a.title}</h3></div></div>) : <div className="drawer-empty">没有匹配的活动</div>}</div></aside></div>}
    {pwdResetModalOpen && <Modal title="重置密码" onClose={() => { setPwdResetModalOpen(false); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>
      <div className="pwd-reset-body">
        {pwdResetStep === 'idle' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon"><Icon name="key" size={24}/></div><p className="pwd-reset-step-title">申请密码重置</p><p className="pwd-reset-step-desc">将向管理员提交密码重置申请。管理员审核通过后，你可以在此页面设置新密码。</p><button className="primary" onClick={requestPasswordReset} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '提交申请'}</button></div>}
        {pwdResetStep === 'pending' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon waiting"><Icon name="clock" size={24}/></div><p className="pwd-reset-step-title">等待审核</p><p className="pwd-reset-step-desc">申请已提交，等待管理员审核。<br/>页面会自动刷新状态。</p></div>}
        {pwdResetStep === 'approved' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">设置新密码</p><p className="pwd-reset-step-desc">管理员已通过你的申请，请在下方设置新密码。</p><Field label="新密码" type="password" required value={newPassword} placeholder="输入新密码（至少4位）" onChange={setNewPassword} /><Field label="确认新密码" type="password" required value={confirmPassword} placeholder="再次输入新密码" onChange={setConfirmPassword} /><button className="primary" onClick={resetPassword} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '确认重置'}</button></div>}
        {pwdResetStep === 'rejected' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon rejected"><Icon name="close" size={24}/></div><p className="pwd-reset-step-title">申请被拒绝</p><p className="pwd-reset-step-desc">{pwdResetMsg || '管理员拒绝了你的密码重置申请。'}</p><button className="outline-button" onClick={() => { setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>重新申请</button></div>}
        {pwdResetStep === 'done' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">密码重置成功</p><p className="pwd-reset-step-desc">请使用新密码重新登录，即将跳转到登录页...</p></div>}
      </div>
    </Modal>}
    {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setError(''); setAvatarFile(null) }}>
      <div className="avatar-upload-body">
        <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{answerer?.zhihu_name?.[0]}</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG 格式，大小不超过 500KB</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
          {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {error && <p className="avatar-upload-error">{error}</p>}
      </div>
    </Modal>}
    {inboxModalOpen && <Modal className="answerer-inbox-modal" title="收件箱" onClose={() => setInboxModalOpen(false)}>
      <div className="answerer-inbox-body">
        {answererInbox.length ? answererInbox.map(msg => (
          <div key={msg.id} className={`answerer-inbox-item ${msg.status === 'unread' ? 'unread' : ''}`}>
            <div className="answerer-inbox-item-header" onClick={async () => {
              if (msg.status === 'unread') {
                await supabase.from('keyflow_inbox').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', msg.id)
                setAnswererInbox(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'read', read_at: new Date().toISOString() } : m))
                setUnreadInboxCount(prev => Math.max(0, prev - 1))
              }
            }}>
              <div className="answerer-inbox-item-left">
                <span className="answerer-inbox-dot"/>
                <div>
                  <strong>{msg.title}</strong>
                  <small><span className="answerer-inbox-sender">知乎游戏</span> · {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(msg.created_at))}</small>
                </div>
              </div>
              <button className="inbox-delete-btn" title="删除消息" onClick={(e) => { e.stopPropagation(); handleDeleteInbox(msg) }}>
                <Icon name="close" size={14}/>
              </button>
            </div>
            <div className="answerer-inbox-item-body">
              <div className="answerer-inbox-item-body-inner">
                <p>{msg.body}</p>
              </div>
            </div>
          </div>
        )) : <div className="answerer-inbox-empty"><div className="answerer-inbox-empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3H10l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><p>暂无消息</p></div>}
      </div>
    </Modal>}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}</div>
}

function KeyManagement({ activity, input, parsedKeys, platformCounts, importedKeys, importing, onInput, onImport, onSelectActivity, applications, toast }) {
  const [revealedKeys, setRevealedKeys] = useState({})
  const [revealingKeyId, setRevealingKeyId] = useState('')
  const [exporting, setExporting] = useState(false)

  const handleExportExcel = async () => {
    setExporting(true)
    const { data, error } = await supabase.rpc('keyflow_export_keys', { p_activity_id: activity.id })
    setExporting(false)
    if (error) return
    const BOM = '\uFEFF'
    const header = 'Key,平台,状态,领取人,入库时间,领取时间\n'
    const rows = data.map(row => {
      const key = `"${(row.key_value || '').replace(/"/g, '""')}"`
      const platform = platformLabel[row.platform] || '未识别'
      const status = row.application_id ? '已领取' : '待领取'
      const applicant = row.applicant_name || '/'
      const created = new Date(row.created_at).toLocaleString('zh-CN')
      const claimed = row.claimed_at ? new Date(row.claimed_at).toLocaleString('zh-CN') : '/'
      return `${key},"${platform}","${status}","${applicant}","${created}","${claimed}"`
    }).join('\n')
    const csv = BOM + header + rows
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activity.game_name}_Key库存_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('Key 已下载')
  }
  const applicantByAppId = useMemo(() => Object.fromEntries((applications || []).map((app) => [app.id, app.zhihu_name])), [applications])

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可批量导入游戏 Key。</p></div>

  const availableCount = importedKeys.filter((item) => !item.application_id).length
  const applicantCount = (applications || []).length
  const passedCount = (applications || []).filter((a) => a.status === 'selected').length
  const unclaimedPassed = (applications || []).filter((a) => a.status === 'selected' && !a.keyflow_keys?.claimed_at).length
  const claimedCount = importedKeys.length - availableCount
  const allClaimed = claimedCount === passedCount && passedCount > 0
  const toggleKeyVisibility = async (id) => {
    if (revealedKeys[id]) return setRevealedKeys((items) => ({ ...items, [id]: '' }))
    setRevealingKeyId(id)
    const { data, error } = await supabase.rpc('keyflow_reveal_key', { p_key_id: id })
    setRevealingKeyId('')
    if (!error) setRevealedKeys((items) => ({ ...items, [id]: data }))
  }

  return <div className="key-management">
    <section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section>
    <section className="key-stats">{[{ count: importedKeys.length, label: '已入库' }, { count: availableCount, label: '待领取' }, { count: claimedCount, label: '已领取', highlight: allClaimed }, { count: applicantCount, label: '报名人数' }, { count: passedCount, label: '通过人数', highlight: allClaimed }, { count: `${unclaimedPassed} / ${availableCount}`, label: '待分发(通过/库存)' }].map(({ count, label, highlight }) => <div className={`key-stat${highlight ? ' matched' : ''}`} key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel key-import-panel"><div className="panel-head"><div><h3>批量导入 Key</h3><p>每行一个 Key，也支持逗号、分号或制表符分隔。系统会自动去重并识别平台。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => onInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP\nABCD-EFGH-IJKL\nABCDEFGHIJKL'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>共 {parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div><div className="key-preview-list">{parsedKeys.slice(0, 8).map(({ key_value, platform }) => <div key={key_value}><code>{key_value}</code><span className={`platform-tag ${platform}`}>{platformLabel[platform]}</span></div>)}{parsedKeys.length > 8 && <p>另有 {parsedKeys.length - 8} 个 Key 将一并导入</p>}</div></div>}<div className="key-import-footer"><span>未识别的格式会标记为「未识别」，仍可入库供后续处理。</span><button className="primary" onClick={onImport} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section>
          <section className="panel key-inventory"><div className="panel-head"><div><h3>库存概览</h3><p>点击眼睛图标按需查看 Key 明文。</p></div><button className="outline-button" onClick={handleExportExcel} disabled={exporting}>{exporting ? '导出中…' : '下载Excel'}</button></div><div className="table-wrap"><table><thead><tr><th>#</th><th>Key</th><th>显示key</th><th>平台</th><th>状态</th><th>领取人</th><th>入库时间</th><th>领取时间</th></tr></thead><tbody>{importedKeys.length ? importedKeys.map((item, i) => <tr key={item.id}><td>{i + 1}</td><td><code className="inventory-key">{revealedKeys[item.id] || '••••••••••••••••'}</code></td><td><button className="key-visibility-button" onClick={() => toggleKeyVisibility(item.id)} disabled={revealingKeyId === item.id} aria-label={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'} title={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'}><Icon name={revealedKeys[item.id] ? 'eyeOff' : 'eye'} size={17}/></button></td><td><span className={`platform-tag ${item.platform}`}>{platformLabel[item.platform] || '未识别'}</span></td><td><span className={`pill ${item.application_id ? 'success' : 'warning'}`}>{item.application_id ? '已领取' : '待领取'}</span></td><td>{item.application_id ? applicantByAppId[item.application_id] || '/' : '/'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td><td>{item.claimed_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.claimed_at)) : '/'}</td></tr>) : <tr><td colSpan="8" className="table-empty">当前活动尚未导入 Key。</td></tr>}</tbody></table></div></section>
  </div>
}

function ApplicationsPage({ activity, applications, answerers, authorStats, statusLabel, onSelectActivity, onAddApplication, onReviewApplication, onDeleteApplication, toast }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const [sortBy, setSortBy] = useState('submitted_at')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const visibleApplications = useMemo(() => applications.filter((person) => (statusFilter === 'all' || person.status === statusFilter) && `${person.zhihu_name} ${person.wechat_name}`.toLowerCase().includes(keyword.trim().toLowerCase())).sort((a, b) => sortBy === 'expected_word_count' ? b.expected_word_count - a.expected_word_count : new Date(b.submitted_at) - new Date(a.submitted_at)), [applications, keyword, sortBy, statusFilter])

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可收集和筛选答主报名。</p></div>

  const statusCounts = { all: applications.length, pending: applications.filter((person) => person.status === 'pending').length, selected: applications.filter((person) => person.status === 'selected').length, rejected: applications.filter((person) => person.status === 'rejected').length }
  const filters = [['all', '全部'], ['pending', '待筛选'], ['selected', '已入选'], ['rejected', '未入选']]
  const toggleSelect = (id) => setSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleSelectAll = () => setSelectedIds((prev) => prev.size === visibleApplications.length && visibleApplications.every((p) => prev.has(p.id)) ? new Set() : new Set(visibleApplications.map((p) => p.id)))
  const batchReview = async (status) => { for (const id of selectedIds) await onReviewApplication(id, status); setSelectedIds(new Set()) }
  const downloadExcel = () => {
    const headers = ['答主', '知乎主页', '微信名', '预计字数', '报名时间', '历史参加活动', '历史完成活动', '延迟提交', '状态']
    const rows = visibleApplications.map((p) => {
      const byId = p.zhihu_id ? (authorStats[p.zhihu_id] || { participated: 0, completed: 0 }) : { participated: 0, completed: 0 }
      const byProfile = authorStats[p.profile_url] || { participated: 0, completed: 0 }
      const history = { participated: byId.participated + byProfile.participated, completed: byId.completed + byProfile.completed }
      return [p.zhihu_name, p.profile_url, p.wechat_name, `${p.expected_word_count}`, new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(p.submitted_at)), `${history.participated}`, `${history.completed}`, `${p.delayed_count}`, statusLabel[p.status]]
    })
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activity.title}_报名表.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('报名表已下载')
  }

  return <section className="applications-workspace">
    <section className="activity-picker">
      <button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button>
    </section>
    <section className="application-summary">{[[applications.length, '累计报名'], [statusCounts.pending, '待筛选'], [`${statusCounts.selected} / ${activity.target_authors}`, '已入选 / 目标人数']].map(([count, label]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel applications-panel">
      <div className="application-toolbar"><div className="application-filters">{filters.map(([value, label]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>{label}<b>{statusCounts[value]}</b></button>)}</div><div className="application-controls"><input aria-label="搜索答主" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索知乎名或微信名"/><select aria-label="排序方式" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="submitted_at">按报名时间</option><option value="expected_word_count">按预计字数</option></select><button className="outline-button" onClick={downloadExcel} title="下载当前表格为 Excel">Excel下载</button></div></div>
      {selectedIds.size > 0 && <div className="batch-actions"><span>已选 <strong>{selectedIds.size}</strong> 项</span><button className="select-action" onClick={() => batchReview('selected')}>批量入选</button><button className="reject-action" onClick={() => batchReview('rejected')}>批量不选</button><button className="reset-action" onClick={() => setSelectedIds(new Set())}>取消选择</button></div>}
      <div className="table-wrap"><table className="applications-table"><thead><tr><th><input type="checkbox" checked={visibleApplications.length > 0 && visibleApplications.every((p) => selectedIds.has(p.id))} onChange={toggleSelectAll}/></th><th>答主</th><th>知乎主页</th><th>微信名</th><th>预计字数</th><th>报名时间</th><th>历史参加活动</th><th>历史完成活动</th><th>延迟提交</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleApplications.length ? visibleApplications.map((person) => { const byId = person.zhihu_id ? (authorStats[person.zhihu_id] || { participated: 0, completed: 0 }) : { participated: 0, completed: 0 }; const byProfile = authorStats[person.profile_url] || { participated: 0, completed: 0 }; const history = { participated: byId.participated + byProfile.participated, completed: byId.completed + byProfile.completed }; return <tr key={person.id}><td><input type="checkbox" checked={selectedIds.has(person.id)} onChange={() => toggleSelect(person.id)}/></td><td><div className="person">{answererByName[person.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[person.zhihu_name].avatar_url} alt="" /> : <span className="person-avatar">{person.zhihu_name[0]}</span>}<div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td>{person.wechat_name}</td><td><span className="word-count">{person.expected_word_count.toLocaleString()} 字</span></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(person.submitted_at))}</td><td><span className="history-count">{history.participated} <small>次</small></span></td><td><span className={`history-count ${history.participated !== history.completed ? 'highlight-red' : ''}`}>{history.completed} <small>次</small></span></td><td><span className={`history-count ${person.delayed_count > 0 ? 'highlight-red' : ''}`}>{person.delayed_count} <small>次</small></span></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => onReviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => onReviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" onClick={() => onReviewApplication(person.id, 'pending')}>重新筛选</button>}<button className="delete-action" onClick={() => onDeleteApplication(person.id)}>删除</button></div></td></tr> }) : <tr><td colSpan="11" className="table-empty">没有符合条件的报名记录。</td></tr>}</tbody></table></div>
    </section>
  </section>
}

function DeliveriesPage({ activity, deliveries, applications, answerers, statusLabel, notes, onNoteChange, onReview, onSelectActivity, pendingCount, approvedCount, revisionCount, toast }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const applicationById = useMemo(() => Object.fromEntries(applications.map((item) => [item.id, item])), [applications])
  const [keyword, setKeyword] = useState('')
  const deliveryWithAuthor = useMemo(() => deliveries.map((item) => ({ ...applicationById[item.application_id], ...item })), [deliveries, applicationById])
  const visibleDeliveries = useMemo(() => deliveryWithAuthor.filter((item) => (statusFilter === 'all' || item.status === statusFilter) && `${item.zhihu_name} ${item.article_url}`.toLowerCase().includes(keyword.trim().toLowerCase())), [deliveryWithAuthor, keyword, statusFilter])
  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动并收到答主交稿后，即可进行交付验收。</p></div>
  const filters = [['all', '全部', deliveries.length], ['pending', '待审核', pendingCount], ['approved', '已通过', approvedCount], ['revision_required', '需修改', revisionCount], ['rejected', '未通过', deliveries.filter((item) => item.status === 'rejected').length]]
  const downloadExcel = () => {
    const headers = ['答主', '微信名', '作品链接', '提交时间', '字数', '审核备注', '状态']
    const rows = visibleDeliveries.map((item) => [item.zhihu_name || '', item.wechat_name || '', cleanZhihuAnswerUrl(item.article_url) || '', new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at)), item.verified_word_count || item.claimed_word_count || '待核对', notes[item.id] ?? item.reviewer_note ?? '', statusLabel[item.status]])
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activity.title}_交付验收表.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('交付验收表已下载')
  }
  return <div className="delivery-workspace"><section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section><section className="delivery-stats"><div><strong>{deliveries.length}</strong><span>已提交</span></div><div><strong>{pendingCount}</strong><span>待审核</span></div><div><strong>{approvedCount}</strong><span>已通过</span></div><div><strong>{revisionCount}</strong><span>需修改</span></div></section><section className="panel"><div className="panel-head"><div><h3>交付验收</h3><p>核对作品链接与实际字数，保存审核结论后会同步展示给答主。</p></div></div><div className="delivery-toolbar"><div className="acceptance-filters">{filters.map(([value, label, count]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}><span>{label}</span><b>{count}</b></button>)}</div><input aria-label="搜索交付" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索答主或作品链接"/><button className="outline-button" onClick={downloadExcel} title="下载当前表格为 Excel">Excel下载</button></div><div className="table-wrap"><table className="deliveries-table"><thead><tr><th>答主</th><th>作品</th><th>提交时间</th><th>字数</th><th>审核备注</th><th>状态</th><th>验收操作</th></tr></thead><tbody>{visibleDeliveries.length ? visibleDeliveries.map((item) => <tr key={item.id}><td><div className="person">{answererByName[item.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[item.zhihu_name].avatar_url} alt="" /> : <span className="person-avatar">{item.zhihu_name?.[0] || '答'}</span>}<div><strong>{item.zhihu_name || '答主'}</strong><small>{item.wechat_name || '已交稿'}</small></div></div></td><td><a className="profile-link" href={cleanZhihuAnswerUrl(item.article_url)} target="_blank" rel="noreferrer">查看作品 <Icon name="arrow" size={13}/></a></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at))}</td><td>{item.verified_word_count || item.claimed_word_count ? `${(item.verified_word_count || item.claimed_word_count).toLocaleString()} 字` : '待核对'}</td><td><input className="delivery-note" value={notes[item.id] ?? item.reviewer_note ?? ''} onChange={(event) => onNoteChange(item.id, event.target.value)} placeholder="填写审核意见"/></td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' || item.status === 'revision_required' ? 'warning' : 'muted'}`}>{statusLabel[item.status]}</span></td><td><div className="review-actions"><button className="select-action" onClick={() => onReview(item, 'approved')}>通过</button><button className="reset-action" onClick={() => onReview(item, 'revision_required')}>需修改</button><button className="reject-action" onClick={() => onReview(item, 'rejected')}>不通过</button></div></td></tr>) : <tr><td colSpan="7" className="table-empty">没有符合条件的交付记录。</td></tr>}</tbody></table></div></section></div>
}

function DateTimeField({ label, value, onChange }) {
  const pad = (n) => String(n).padStart(2, '0')
  const toLocal = (v) => { if (!v) return ''; const m = String(v).match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); return m ? m[0] : '' }
  return <label className="field datetime-field"><span>{label}</span><div className="datetime-row"><input type="datetime-local" value={toLocal(value)} onChange={(e) => onChange(e.target.value)} /><button type="button" className="datetime-btn" onClick={() => onChange('')}>清除</button><button type="button" className="datetime-btn" onClick={() => { if (!value) return; const d = new Date(value); if (isNaN(d.getTime())) return; onChange(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`); }}>最晚</button></div></label>
}

function Field({ label, textarea, wide, onChange, onBlur, ...props }) { return <label className={`field ${wide ? 'field-wide' : ''}`}><span>{label}</span>{textarea ? <textarea onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/> : <input onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/>}</label> }
function Modal({ title, children, onClose, className = '', wide }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className={`modal ${className} ${wide ? 'modal-wide' : ''}`} onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button onClick={onClose}><Icon name="close"/></button></header>{children}</section></div> }

const SESSION_KEY = 'keyflow_answerer_session'
function getAnswererSession() {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null } catch { return null }
}

function AnswererDashboard() {
  const answerer = getAnswererSession()
  const [dashboard, setDashboard] = useState(null)
  const [, forceRender] = useReducer(x => x + 1, 0)
  const [error, setError] = useState('')
  const [dailyUrl, setDailyUrl] = useState('')
  const [dailyTitle, setDailyTitle] = useState('')
  const [dailySubmitting, setDailySubmitting] = useState(false)
  const [dailyMsg, setDailyMsg] = useState('')
  const [sharedCode, setSharedCode] = useState(null)
  const [generatingShared, setGeneratingShared] = useState(false)
  const [sharedMsg, setSharedMsg] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [avatarModalOpen, setAvatarModalOpen] = useState(false)
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(answerer?.avatar_url || '')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [pwdResetModalOpen, setPwdResetModalOpen] = useState(false)
  const [pwdResetStep, setPwdResetStep] = useState('idle') // idle|pending|approved|rejected|setting|done
  const [pwdResetMsg, setPwdResetMsg] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdResetLoading, setPwdResetLoading] = useState(false)
  const [inboxModalOpen, setInboxModalOpen] = useState(false)
  const [answererInbox, setAnswererInbox] = useState([])
  const [unreadInboxCount, setUnreadInboxCount] = useState(0)
  const [isPartner, setIsPartner] = useState(false)

  const loadDashboard = async () => {
    if (!answerer?.id) return
    setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_answerer_dashboard', { p_answerer_id: answerer.id })
    if (requestError) setError(requestError.message)
    else setDashboard(data)
  }

  const loadSharedCode = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_get_answerer_shared_code', { p_answerer_id: answerer.id })
    if (data) setSharedCode(data)
  }

  const generateSharedCode = async () => {
    setGeneratingShared(true)
    setSharedMsg('')
    const { error } = await supabase.rpc('keyflow_generate_answerer_shared_code', { p_answerer_id: answerer.id })
    setGeneratingShared(false)
    if (error) { setSharedMsg(error.message); return }
    await loadSharedCode()
    setSharedMsg('邀请码已生成')
  }

  const handleAvatarFile = (file) => {
    setDailyMsg('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setDailyMsg('请选择图片文件'); return }
    if (file.size > 500 * 1024) { setDailyMsg('图片大小不能超过 500KB，请压缩后重新选择'); return }
    const reader = new FileReader()
    reader.onload = (e) => { setAvatarPreview(e.target.result); setAvatarFile(file) }
    reader.readAsDataURL(file)
  }

  const uploadAvatar = async () => {
    if (!avatarFile) { setAvatarUploading(false); return }
    setAvatarUploading(true)
    const reader = new FileReader()
    reader.onload = async (e) => {
      const avatarUrl = e.target.result
      const { error: updateErr } = await supabase.from('keyflow_answerers').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', answerer.id)
      if (updateErr) { setAvatarUploading(false); return }
      const session = { ...answerer, avatar_url: avatarUrl }
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
      setAvatarUploading(false)
      setAvatarModalOpen(false)
      setAvatarPreview(avatarUrl)
      setDailyMsg('头像已更新')
    }
    reader.readAsDataURL(avatarFile)
  }

  const loadResetStatus = async () => {
    const { data } = await supabase.from('keyflow_password_reset_requests')
      .select('*').eq('answerer_id', answerer.id)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'pending') setPwdResetStep('pending')
      else if (data.status === 'approved') setPwdResetStep('approved')
      else if (data.status === 'rejected') { setPwdResetStep('rejected'); setPwdResetMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
      // completed 不处理：用户已重置过密码，再次打开应显示 idle 重新发起流程
    }
  }

  const requestPasswordReset = async () => {
    setPwdResetLoading(true)
    setPwdResetMsg('')
    const { data, error: rpcErr } = await supabase.rpc('keyflow_request_password_reset', { p_answerer_id: answerer.id })
    setPwdResetLoading(false)
    if (rpcErr) {
      if (rpcErr.message.includes('已有一个待处理')) { setPwdResetStep('pending'); setPwdResetMsg(rpcErr.message); return }
      setPwdResetMsg(rpcErr.message); return
    }
    setPwdResetStep('pending')
  }

  const checkResetStatus = async () => {
    const { data } = await supabase.from('keyflow_password_reset_requests').select('*').eq('answerer_id', answerer.id).order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'approved') setPwdResetStep('approved')
      else if (data.status === 'rejected') { setPwdResetStep('rejected'); setPwdResetMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
      else if (data.status === 'completed') setPwdResetStep('done')
    }
  }

  const resetPassword = async () => {
    if (!newPassword) { setPwdResetMsg('请输入新密码'); return }
    if (newPassword !== confirmPassword) { setPwdResetMsg('两次输入密码不一致'); return }
    if (newPassword.length < 4) { setPwdResetMsg('密码至少4位'); return }
    setPwdResetLoading(true)
    setPwdResetMsg('')
    const { error: rpcErr } = await supabase.rpc('keyflow_reset_password', { p_answerer_id: answerer.id, p_new_password: newPassword })
    setPwdResetLoading(false)
    if (rpcErr) { setPwdResetMsg(rpcErr.message); return }
    setPwdResetStep('done')
    setPwdResetMsg('密码重置成功，请使用新密码重新登录。')
    setTimeout(() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }, 2000)
  }

  useEffect(() => {
    if (pwdResetStep === 'pending' || pwdResetStep === 'approved') {
      const interval = setInterval(checkResetStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [pwdResetStep])

  const loadInbox = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.from('keyflow_inbox')
      .select('*').eq('to_id', answerer.id).eq('type', 'private_message')
      .order('created_at', { ascending: false })
    setAnswererInbox(data || [])
  }

  const fetchUnreadCount = async () => {
    if (!answerer?.id) return
    const { count } = await supabase.from('keyflow_inbox')
      .select('*', { count: 'exact', head: true })
      .eq('to_id', answerer.id).eq('status', 'unread').eq('type', 'private_message')
    setUnreadInboxCount(count || 0)
  }

  const handleDeleteInbox = async (msg) => {
    setAnswererInbox(prev => prev.filter(m => m.id !== msg.id))
    if (msg.status === 'unread') setUnreadInboxCount(prev => Math.max(0, prev - 1))
    const { error } = await supabase.from('keyflow_inbox').delete().eq('id', msg.id)
    if (error) {
      setAnswererInbox(prev => [...prev, msg].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
      if (msg.status === 'unread') setUnreadInboxCount(prev => prev + 1)
    }
  }

  useEffect(() => { loadDashboard(); loadSharedCode(); fetchUnreadCount(); (async () => { if (answerer?.id) { const { data } = await supabase.rpc('keyflow_is_partner', { p_answerer_id: answerer.id }); setIsPartner(!!data) } })() }, [])

  if (!answerer) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主看板</span></div><div className="step-message"><div className="step-message-icon waiting"><Icon name="users" size={24}/></div><p>登录后查看你的测评活动</p><span>注册答主账号后即可查看报名与交稿记录。</span><div className="dashboard-auth-actions"><a href="?login" className="primary">去登录</a><a href="?register" className="outline-button">去注册</a></div></div></main></div>
  if (!dashboard && !error) return <div className="partner-page"><div className="partner-loading">正在加载答主看板…</div></div>
  if (!dashboard) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主看板</span></div><div className="step-message"><p>{error || '看板加载失败'}</p><button className="outline-button" onClick={loadDashboard}>重新加载</button></div></main></div>

  const stageLabel = { recruiting: '招募中', key_distribution: '发 Key 中', delivery: '交付/创作中', completed: '项目完结' }
  const getPersonalStage = (activity) => { if (activity.application_status === 'selected') return activity.key_claimed ? 'delivery' : 'key_distribution'; return activity.status }
  const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - new Date()) / 86400000))
  const formatSubmittedAt = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

  const submitDaily = async (e) => {
    e.preventDefault()
    if (!dailyUrl.trim()) { setDailyMsg('请填写知乎回答链接'); return }
    if (!dailyTitle.trim()) { setDailyMsg('请填写作品标题'); return }
    setDailySubmitting(true)
    setDailyMsg('')
    // 检查今日是否已投稿
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const { count: todayCount, error: countErr } = await supabase.from('keyflow_daily_submissions').select('*', { count: 'exact', head: true }).eq('answerer_id', answerer.id).gte('created_at', todayStart.toISOString())
    if (countErr) { setDailyMsg(countErr.message); setDailySubmitting(false); return }
    if (todayCount >= 1 && answerer.serial_number !== 1) { setDailyMsg('今日已投稿，每天限投一条'); setDailySubmitting(false); return }
    const { error: insertErr } = await supabase.from('keyflow_daily_submissions').insert({
      answerer_id: answerer.id,
      article_url: cleanZhihuAnswerUrl(dailyUrl.trim()),
      article_title: dailyTitle.trim(),
    })
    if (insertErr) { setDailyMsg(insertErr.message); setDailySubmitting(false); return }
    const newSubmission = {
      type: 'daily',
      activity_id: null,
      activity_title: null,
      game_name: null,
      article_title: dailyTitle.trim(),
      article_url: cleanZhihuAnswerUrl(dailyUrl.trim()),
      submitted_at: new Date().toISOString(),
    }
    setDashboard(prev => ({
      ...prev,
      daily_submission_count: (prev.daily_submission_count || 0) + 1,
      submissions: [newSubmission, ...(prev.submissions || [])],
    }))
    setDailyUrl('')
    setDailyTitle('')
    setDailySubmitting(false)
    setDailyMsg('投稿成功！')
    forceRender()
    setTimeout(() => loadDashboard(), 600)
  }

  const moreActivities = dashboard.more_activities || []
  const historicalActivities = dashboard.historical_activities || []
  const HISTORICAL_VISIBLE = 3
  const points = (dashboard.participated_count || 0) * 50 + (dashboard.submission_count || 0) * 300 + (dashboard.daily_submission_count || 0) * 80
  const getTierInfo = (pts) => {
    const tiers = [
      { tier: 1, title: '初识玩家', min: 0 },
      { tier: 2, title: '游戏学徒', min: 200 },
      { tier: 3, title: '测评新秀', min: 500 },
      { tier: 4, title: '锐评达人', min: 1000 },
      { tier: 5, title: '资深鉴赏家', min: 2000 },
      { tier: 6, title: '金牌测评师', min: 3500 },
      { tier: 7, title: '游戏领航员', min: 5500 },
      { tier: 8, title: '大师测评官', min: 8000 },
      { tier: 9, title: '传奇鉴赏家', min: 11000 },
      { tier: 10, title: '创世测评王', min: 15000 },
    ]
    let info = tiers[0]
    for (const t of tiers) { if (pts >= t.min) info = t }
    const next = tiers.find(t => t.min > pts)
    return { ...info, nextMin: next?.min ?? null, nextTitle: next?.title ?? null }
  }
  const tierInfo = getTierInfo(points)
  const prevMin = tierInfo.min, nextMin = tierInfo.nextMin || prevMin + 500
  const progressPct = prevMin === 0 && points === 0 ? 0 : Math.min(100, Math.round(((points - prevMin) / (nextMin - prevMin)) * 100))
  return <div className="partner-page"><header className="partner-header"><div className="partner-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>答主看板</small></div><div className="partner-header-right">{(isPartner || answerer?.zhihu_name === '灰域信风') && <button className="reload outline" onClick={() => { window.location.href = '?partner' }}>切换到合作方看板</button>}{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<button className="reload" onClick={loadDashboard}>刷新数据</button><div className="dashboard-user-area" onClick={() => setDropdownOpen(!dropdownOpen)}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name || dashboard?.answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main answerer-dashboard"><section className="partner-hero dashboard-hero"><div className="partner-hero-content"><p>你好，{dashboard.answerer.zhihu_name}</p><h1>我的测评活动</h1><span>查看正在参与的活动和已提交的作品。</span><div className="answerer-stats-row"><div className="hero-shared-code"><div className="hero-shared-code-inner">{sharedCode ? <div className="hero-shared-code-card"><span className="hero-shared-code-value" title="点击复制" onClick={() => { navigator.clipboard.writeText(sharedCode.code); setSharedMsg('邀请码已复制') }}>{sharedCode.code}</span><small>生成于 {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sharedCode.created_at))}</small></div> : <button className="hero-shared-code-btn" onClick={generateSharedCode} disabled={generatingShared}>{generatingShared ? '生成中…' : '分享邀请码'}<small>每日可生成一个</small></button>}{sharedMsg && <span className="hero-shared-code-msg" style={sharedMsg.includes('已生成') || sharedMsg.includes('已复制') ? undefined : { color: '#fca5a5' }}>{sharedMsg}</span>}</div></div><div className="answerer-stats"><div className="answerer-stats-left"><div className="answerer-tier-row"><span className="answerer-tier-icon">Lv{tierInfo.tier}</span><div><span className="answerer-tier-title">{tierInfo.title}</span><span className="answerer-tier-points">{points} 积分</span></div></div><div className="answerer-tier-progress"><div className="answerer-progress-bar"><div className="answerer-progress-fill" style={{width: progressPct + '%'}}></div></div>{tierInfo.nextTitle && <span className="answerer-next-tier">距「{tierInfo.nextTitle}」还需 {tierInfo.nextMin - points} 积分</span>}</div></div></div><div className="answerer-hero-metrics"><div className="answerer-metric"><span className="answerer-metric-value">{dashboard.participated_count || 0}</span><span className="answerer-metric-label">已参与活动</span><span className="answerer-metric-note">50 积分/个</span></div><div className="answerer-metric"><span className="answerer-metric-value">{dashboard.submission_count || 0}</span><span className="answerer-metric-label">已完成活动</span><span className="answerer-metric-note">300 积分/个</span></div><div className="answerer-metric"><span className="answerer-metric-value">{dashboard.daily_submission_count || 0}</span><span className="answerer-metric-label">已投稿日常回答</span><span className="answerer-metric-note">80 积分/个</span></div></div></div></div></section><section className="dashboard-daily-form"><div className="panel-head dashboard-section-head"><div><h3>日常投稿</h3><p>任何知乎游戏领域回答都可以投稿，可提升积分；每日可投稿1条；灌水投稿会导致账户扣分甚至封禁。</p></div></div><form onSubmit={submitDaily}><div className="daily-form-fields"><input type="url" placeholder="知乎回答链接（必填）" value={dailyUrl} onChange={(e) => setDailyUrl(e.target.value)} required/><input type="text" placeholder="作品标题（必填）" value={dailyTitle} onChange={(e) => setDailyTitle(e.target.value)} required/><button type="submit" className="primary" disabled={dailySubmitting}>{dailySubmitting ? '投稿中…' : '提交投稿'}</button></div>{dailyMsg && <p className="daily-form-msg">{dailyMsg}</p>}</form></section><section><div className="panel-head dashboard-section-head"><div><h3>正在参与</h3><p>点击活动卡片回到申领页。</p></div></div><div className="dashboard-activity-cards">{dashboard.activities.length ? dashboard.activities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name}/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${getPersonalStage(activity) === 'key_distribution' ? 'orange' : getPersonalStage(activity) === 'delivery' ? 'purple' : getPersonalStage(activity) === 'completed' ? 'green' : 'blue'}`}>{stageLabel[getPersonalStage(activity)] || getPersonalStage(activity)}</span>{getPersonalStage(activity) === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">暂无正在参与的活动。</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>更多体验活动</h3><p>后台已上线的活动，点击卡片前往报名。</p></div></div><div className="dashboard-activity-cards">{moreActivities.length ? moreActivities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name}/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>{activity.status === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">暂无更多可体验的活动。</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>历史活动</h3><p>往期已结束的活动回顾。</p></div></div><div className="dashboard-activity-cards">{historicalActivities.length ? (<>{historicalActivities.slice(0, HISTORICAL_VISIBLE).map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name}/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span></div></div></a>)}{historicalActivities.length > HISTORICAL_VISIBLE && <div className="dashboard-activity-card dashboard-activity-more"><div className="dashboard-activity-cover dashboard-activity-more-cover"><span>+{historicalActivities.length - HISTORICAL_VISIBLE}</span></div><div className="dashboard-activity-body"><h3>查看更多</h3><p>还有 {historicalActivities.length - HISTORICAL_VISIBLE} 个历史活动</p></div></div>}</>) : <div className="dashboard-empty">暂无历史活动。</div>}</div></section><section className="panel partner-table"><div className="panel-head"><div><h3>曾提交作品</h3><p>已提交的知乎作品记录。</p></div><button className="outline-button compact" onClick={() => { const headers = ['稿件类型', '作品标题', '作品链接', '参与时间']; const rows = dashboard.submissions.map(s => [s.type === 'daily' ? '日常稿件' : '活动稿件', s.type === 'daily' ? (s.article_title || '-') : (s.activity_title || '-'), cleanZhihuAnswerUrl(s.article_url) || '', formatSubmittedAt(s.submitted_at)]); const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${dashboard.answerer.zhihu_name}作品集_${fileTimestamp()}.csv`; a.click(); URL.revokeObjectURL(url) }}>下载 Excel</button></div><div className="table-wrap"><table><thead><tr><th>稿件类型</th><th>作品标题</th><th>作品链接</th><th>参与时间</th></tr></thead><tbody>{dashboard.submissions.length ? dashboard.submissions.map((submission, idx) => <tr key={`submission-${idx}`}><td>{submission.type === 'daily' ? '日常稿件' : '活动稿件'}</td><td>{submission.type === 'daily' ? (submission.article_title || '-') : (submission.activity_title || '-')}</td><td>{submission.article_url ? (() => { const u = cleanZhihuAnswerUrl(submission.article_url); return <a href={u} target="_blank" rel="noreferrer" title={u} className="profile-link" style={{wordBreak:'break-all'}}>{u.length > 50 ? u.slice(0, 50) + '...' : u} <Icon name="arrow" size={13}/></a> })() : '-'}</td><td>{formatSubmittedAt(submission.submitted_at)}</td></tr>) : <tr><td colSpan="4" className="table-empty">尚未提交作品。</td></tr>}</tbody></table></div></section></main>
    {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setDailyMsg(''); setAvatarFile(null) }}>
      <div className="avatar-upload-body">
        <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{answerer?.zhihu_name?.[0]}</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG 格式，大小不超过 500KB</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
          {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {dailyMsg && <p className="avatar-upload-error">{dailyMsg}</p>}
      </div>
    </Modal>}
    {pwdResetModalOpen && <Modal title="重置密码" onClose={() => { setPwdResetModalOpen(false); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>
      <div className="pwd-reset-body">
        {pwdResetStep === 'idle' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon"><Icon name="key" size={24}/></div>
          <p className="pwd-reset-step-title">申请密码重置</p>
          <p className="pwd-reset-step-desc">将向管理员提交密码重置申请。管理员审核通过后，你可以在此页面设置新密码。</p>
          <button className="primary" onClick={requestPasswordReset} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '提交申请'}</button>
        </div>}
        {pwdResetStep === 'pending' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon waiting"><Icon name="clock" size={24}/></div>
          <p className="pwd-reset-step-title">等待审核</p>
          <p className="pwd-reset-step-desc">申请已提交，等待管理员审核。<br/>页面会自动刷新状态。</p>
        </div>}
        {pwdResetStep === 'approved' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div>
          <p className="pwd-reset-step-title">设置新密码</p>
          <p className="pwd-reset-step-desc">管理员已通过你的申请，请在下方设置新密码。</p>
          <Field label="新密码" type="password" required value={newPassword} placeholder="输入新密码（至少4位）" onChange={setNewPassword} />
          <Field label="确认新密码" type="password" required value={confirmPassword} placeholder="再次输入新密码" onChange={setConfirmPassword} />
          <button className="primary" onClick={resetPassword} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '确认重置'}</button>
        </div>}
        {pwdResetStep === 'rejected' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon rejected"><Icon name="close" size={24}/></div>
          <p className="pwd-reset-step-title">申请被拒绝</p>
          <p className="pwd-reset-step-desc">{pwdResetMsg || '管理员拒绝了你的密码重置申请。'}</p>
          <button className="outline-button" onClick={() => { setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>重新申请</button>
        </div>}
        {pwdResetStep === 'done' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div>
          <p className="pwd-reset-step-title">密码重置成功</p>
          <p className="pwd-reset-step-desc">请使用新密码重新登录，即将跳转到登录页...</p>
        </div>}
        {pwdResetStep === 'setting' && <div className="pwd-reset-step">
          <div className="pwd-reset-step-icon"><Icon name="key" size={24}/></div>
          <p className="pwd-reset-step-title">设置新密码</p>
          <Field label="新密码" type="password" required value={newPassword} placeholder="输入新密码（至少4位）" onChange={setNewPassword} />
          <Field label="确认新密码" type="password" required value={confirmPassword} placeholder="再次输入新密码" onChange={setConfirmPassword} />
          <button className="primary full-width" onClick={resetPassword} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '确认重置'}</button>
        </div>}
        {pwdResetMsg && pwdResetStep !== 'rejected' && pwdResetStep !== 'done' && <p className="pwd-reset-msg">{pwdResetMsg}</p>}
      </div>
    </Modal>}
    {inboxModalOpen && <Modal className="answerer-inbox-modal" title="收件箱" onClose={() => setInboxModalOpen(false)}>
      <div className="answerer-inbox-body">
        {answererInbox.length ? answererInbox.map(msg => (
          <div key={msg.id} className={`answerer-inbox-item ${msg.status === 'unread' ? 'unread' : ''}`}>
            <div className="answerer-inbox-item-header" onClick={async () => {
              if (msg.status === 'unread') {
                await supabase.from('keyflow_inbox').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', msg.id)
                setAnswererInbox(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'read', read_at: new Date().toISOString() } : m))
                setUnreadInboxCount(prev => Math.max(0, prev - 1))
              }
            }}>
              <div className="answerer-inbox-item-left">
                <span className="answerer-inbox-dot"/>
                <div>
                  <strong>{msg.title}</strong>
                  <small><span className="answerer-inbox-sender">知乎游戏</span> · {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(msg.created_at))}</small>
                </div>
              </div>
              <button className="inbox-delete-btn" title="删除消息" onClick={(e) => { e.stopPropagation(); handleDeleteInbox(msg) }}>
                <Icon name="close" size={14}/>
              </button>
            </div>
            <div className="answerer-inbox-item-body">
              <div className="answerer-inbox-item-body-inner">
                <p>{msg.body}</p>
              </div>
            </div>
          </div>
        )) : <div className="answerer-inbox-empty"><div className="answerer-inbox-empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3H10l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><p>暂无消息</p></div>}
      </div>
    </Modal>}
  </div>
}

function ClaimPage({ activityId, authCode }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ invitation_code: '', expected_word_count: 800 })
  const [application, setApplication] = useState(null)
  const [claimedKey, setClaimedKey] = useState(null)
  const [articleUrl, setArticleUrl] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [notice, setNotice] = useState('')
  const [activeShot, setActiveShot] = useState(0)
  const [answerer, setAnswerer] = useState(() => getAnswererSession())
  const [moreActivities, setMoreActivities] = useState([])
  const storageKey = `claim_${activityId}`
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  useEffect(() => {
    const init = async () => {
      const { data: act, error: actErr } = await supabase.from('keyflow_activities').select('*').eq('id', activityId).single()
      if (actErr) { setError('该申领页不存在或已失效。'); setLoading(false); return }
      setActivity(act)

      if (act.status === 'completed') {
        const { data: recruiting } = await supabase.from('keyflow_activities')
          .select('id, title, game_name, game_cover')
          .eq('status', 'recruiting')
          .eq('is_online', true)
          .order('created_at', { ascending: false })
          .limit(4)
        if (recruiting) setMoreActivities(recruiting)
      }

      const currentAnswerer = getAnswererSession()
      const applicationQuery = currentAnswerer?.id
        ? supabase.from('keyflow_applications').select('*, keyflow_deliveries(id, status, article_url), keyflow_keys(claimed_at)').eq('activity_id', activityId).eq('answerer_id', currentAnswerer.id).maybeSingle()
        : null
      const restoreClaimedKey = async (app) => {
        const existingKey = Array.isArray(app.keyflow_keys) ? app.keyflow_keys[0] : app.keyflow_keys
        if (!existingKey) return
        const { data } = await supabase.rpc('keyflow_claim_key', { p_application_id: app.id })
        if (data?.length) {
          const keyInfo = { key_value: data[0].key_value, claimed_at: data[0].claimed_at }
          setClaimedKey(keyInfo)
          localStorage.setItem(`claim_key_${app.id}`, JSON.stringify(keyInfo))
        }
      }
      const { data: answererApplication } = applicationQuery ? await applicationQuery : { data: null }
      if (answererApplication) {
        setApplication(answererApplication)
        await restoreClaimedKey(answererApplication)
      } else {
        const storedApp = localStorage.getItem(storageKey)
        if (storedApp) {
          try {
            const { application_id } = JSON.parse(storedApp)
            const { data: app } = await supabase.from('keyflow_applications')
              .select('*, keyflow_deliveries(id, status, article_url), keyflow_keys(claimed_at)')
              .eq('id', application_id).single()
            if (app) {
              setApplication(app)
              await restoreClaimedKey(app)
            }
          } catch {}
        }
      }
      setLoading(false)
    }
    init()
  }, [activityId, authCode])

  const submitApplication = async (event) => {
    event.preventDefault(); setError('')
    if (activity.status === 'key_distribution') {
      setError('活动已进入发key阶段，如需报名请单独联系管理员')
      return
    }
    const curAnswerer = answerer || getAnswererSession()
    if (curAnswerer) {
      // 已登录答主：直接创建报名（无需邀请码）
      setRegistering(true)
      const payload = {
        activity_id: activityId,
        answerer_id: curAnswerer.id,
        zhihu_name: curAnswerer.zhihu_name,
        wechat_name: '',
        profile_url: curAnswerer.account_address || '',
        expected_word_count: Math.max(800, Number(form.expected_word_count) || 800),
      }
      const { data, error: requestError } = await supabase.from('keyflow_applications')
        .insert(payload).select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').single()
      setRegistering(false)
      if (requestError) { setError(requestError.message); return }
      setApplication(data)
      localStorage.setItem(storageKey, JSON.stringify({ application_id: data.id }))
      toast('报名已提交，等待运营方筛选')
    } else {
      // 未登录：使用邀请码注册（兼容旧链接）
      if (!form.invitation_code.trim()) { setError('请输入邀请码'); return }
      setRegistering(true)
      const { data, error: requestError } = await supabase.rpc('keyflow_register_with_code', {
        p_activity_id: activityId,
        p_code: form.invitation_code.trim(),
        p_zhihu_name: form.zhihu_name,
        p_wechat_name: form.wechat_name,
        p_profile_url: form.profile_url,
        p_expected_word_count: Math.max(800, Number(form.expected_word_count) || 800),
      })
      setRegistering(false)
      if (requestError) { setError(requestError.message); return }
      if (data) {
        setApplication(data)
        localStorage.setItem(storageKey, JSON.stringify({ application_id: data.id }))
        toast('注册成功，等待运营方筛选')
      }
    }
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
      .insert({ application_id: application.id, article_url: cleanZhihuAnswerUrl(articleUrl) }).select('id, status, article_url').single()
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

  if (loading) return <div className="public-page"><div className="public-card loading-public">正在加载申领页…</div></div>
  if (!activity) return <div className="public-page"><div className="public-card loading-public">{error || '该申领页不存在或已失效。'}</div></div>

  const screenshots = (() => { try { return JSON.parse(activity.game_screenshots || '[]') } catch { return [] } })()
  const subQuestions = (() => { try { return JSON.parse(activity.sub_questions || '[]') } catch { return [] } })()
  const renderTextWithLinks = (text) => {
    const parts = text.split(/(https?:\/\/[^\s]+)/g)
    const urls = parts.filter(p => /^https?:\/\//.test(p))
    const textOnly = parts.filter(p => !/^https?:\/\//.test(p)).join('').trim()
    if (urls.length > 0) {
      return <a href={urls[0]} target="_blank" rel="noreferrer">{textOnly}</a>
    }
    return text
  }
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
  const stepLabels = ['报名参与', '领取 Key', '提交作品']

  return <div className="public-page"><main className="public-card">
    {screenshots.length > 0 && <div className="public-screenshots"><img className="ss-main" src={screenshots[activeShot] || screenshots[0]} alt="游戏截图"/>{screenshots.length > 1 && <div className="ss-strip">{screenshots.map((url, i) => i !== activeShot ? <img key={i} src={url} alt={`截图 ${i+1}`} onClick={() => setActiveShot(i)}/> : null)}</div>}</div>}
    <div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主游戏KEY申领</span>{answerer && <a className="answerer-dashboard-link" href="?dashboard"><span className="answerer-dashboard-avatar" aria-hidden="true">{answerer.avatar_url ? <img src={answerer.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (answerer.zhihu_name?.trim().charAt(0) || '我')}</span>我的看板</a>}</div>
    <div className="public-hero"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>{activity.description || '填写以下信息参与本次游戏测评。'}</span></div>
    <div className="public-requirement">{activity.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'}</div>
    <section className="public-info"><strong>测评主问题</strong><p>{activity.main_question ? renderTextWithLinks(activity.main_question) : '暂无，待后续更新'}</p>{subQuestions.filter(q => q.trim()).length > 0 && <div className="public-sub-questions"><strong>相关问题</strong>{subQuestions.filter(q => q.trim()).map((q, i) => <p key={i} className="public-sub-q">{renderTextWithLinks(q)}</p>)}</div>}<div className="info-deadlines"><small>报名截止：<strong>{formatDate(activity.application_deadline)}</strong></small><div className="reply-deadline"><span>回稿时间：</span><strong>{activity.delivery_deadline ? `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(activity.delivery_deadline))} 前` : '待设置'}</strong></div></div></section>

    <div className="stepper">{stepLabels.map((label, i) => <div key={i} className={`step ${stepStates[i]}`}><div className="step-circle">{stepStates[i] === 'done' ? <Icon name="check" size={14}/> : stepStates[i] === 'waiting' ? <Icon name="clock" size={14}/> : i + 1}</div><span className="step-label">{label}</span></div>)}</div>

    <div className="step-body">
      {activity.status === 'completed' ? (
        <div className="step-message">
          <div className="step-message-icon done"><Icon name="check" size={24}/></div>
          <p>活动已结束</p>
          <span>可以参加更多游戏体验</span>
          {moreActivities.length > 0 && (
            <div className="more-activities">
              {moreActivities.map(a => (
                <a key={a.id} href={`?claim=${a.id}`} className="more-activity-card">
                  {a.game_cover ? <img src={a.game_cover} alt={a.game_name} /> : <div className="more-activity-cover-placeholder" />}
                  <div className="more-activity-info">
                    <span className="more-activity-game">{a.game_name}</span>
                    <span className="more-activity-title">{a.title}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      ) : !hasApp && activity.status === 'key_distribution' ? (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
          <p>活动已进入发key阶段，如需报名请单独联系管理员</p>
        </div>
      ) : (
        <>
          {!hasApp && !answerer && (
            <div className="step-message">
              <div className="step-message-icon waiting"><Icon name="users" size={24}/></div>
              <p>请先注册或登录</p>
              <span>注册答主账号后方可报名参与活动。</span>
              <div style={{ display: 'flex', gap: 'var(--sp-3)', justifyContent: 'center', marginTop: 'var(--sp-4)' }}>
                <a href={`?register&aid=${activityId}`} className="primary" style={{ textDecoration: 'none' }}>注册测评答主</a>
                <a href={`?login&aid=${activityId}`} className="outline-button" style={{ textDecoration: 'none', height: '34px', fontSize: 'var(--fs-label)' }}>已有账号？登录</a>
              </div>
            </div>
          )}
          {!hasApp && answerer && (
            <form className="public-form" onSubmit={submitApplication}>
              <h2>报名参与</h2>
              <p className="invite-hint">确认信息后提交报名，运营方筛选通过后即可领取 Key。</p>
              <label className="field"><span>知乎用户名</span><input value={answerer.zhihu_name} disabled /></label>
              <Field label="预计完成字数" type="number" required value={form.expected_word_count} onChange={(value) => setForm({ ...form, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setForm({ ...form, expected_word_count: 800 }) }}/>
              <span className="word-min-hint">最低 800 字</span>
              {error && <p className="public-error">{error}</p>}
              <button className="primary public-submit" disabled={registering}>{registering ? '提交中…' : '提交报名'}</button>
            </form>
          )}

          {hasApp && !hasKey && (isRejected ? <div className="step-message"><div className="step-message-icon rejected"><Icon name="close" size={24}/></div><p>本次未入选</p><span>感谢你的参与，期待下次活动再见。</span></div> : !isSelected ? <div className="step-message"><div className="step-message-icon waiting"><Icon name="clock" size={24}/></div><p>报名已提交，等待筛选</p><span>运营方会根据测评要求筛选答主，入选后可在此页面领取 Key。</span></div> : <div className="step-claim"><h2>领取游戏 Key</h2><p>恭喜入选！点击下方按钮领取你的专属 Key。</p><button className="primary claim-btn" onClick={claimKey} disabled={claiming}>{claiming ? '领取中…' : '领取 Key'}</button>{error && <p className="public-error">{error}</p>}</div>)}

          {hasKey && !hasDelivery && (() => { const daysLeft = activity.delivery_deadline ? Math.ceil((new Date(activity.delivery_deadline) - new Date()) / (1000 * 60 * 60 * 24)) : null; return <div className="step-delivery"><div className="key-display"><div className="key-label">你的游戏 Key</div><div className="key-value">{claimedKey.key_value}</div><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimedKey.key_value); toast('Key 已复制') }}>复制 Key</button></div><form className="delivery-form" onSubmit={submitDelivery}><h2>提交作品链接{daysLeft !== null && daysLeft > 0 && <span className="deadline-badge">{daysLeft <= 3 ? <span className="deadline-pulse"/> : null}还剩 <strong>{daysLeft}</strong> 天</span>}{daysLeft !== null && daysLeft <= 0 && <span className="deadline-badge expired">已截止</span>}</h2><Field label="知乎回答地址" type="url" required value={articleUrl} placeholder="https://www.zhihu.com/question/.../answer/..." onChange={(value) => setArticleUrl(value)}/>{error && <p className="public-error">{error}</p>}<div className="delivery-submit-row"><button className="primary public-submit" disabled={submitting}>{submitting ? '提交中…' : '提交作品'}</button><a className="outline-button dashboard-enter-btn" href="?dashboard">进入我的看板</a></div></form></div> })()}

          {hasDelivery && <div className="step-message"><div className="step-message-icon done"><Icon name="check" size={24}/></div><p>作品已提交</p><span>{delivery.status === 'approved' ? '审核通过，感谢参与！' : delivery.status === 'revision_required' ? '需要修改，请查看运营方通知' : '等待运营方审核中…'}</span>{claimedKey && <div className="key-display compact"><div className="key-label">你的 Key</div><div className="key-value">{claimedKey.key_value}</div></div>}</div>}
        </>
      )}
    </div>

    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </main></div>
}

function RegisterPage({ aid, redirect }) {
  const [banner, setBanner] = useState(() => getCachedBanner() || defaultRegisterBanner)
  const [form, setForm] = useState({ invitation_code: '', zhihu_name: '', account_address: '', wechat_id: '', password: '', confirm_password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nameSuggestion, setNameSuggestion] = useState(null)
  const [nameHint, setNameHint] = useState(null) // null | { type:'checking' } | { type:'taken', suggestion }
  const [addressHint, setAddressHint] = useState(null) // null | { type:'checking' } | { type:'taken', zhihu_name }
  const nameTimer = useRef(null)
  const addressTimer = useRef(null)
  const [notice, setNotice] = useState('')
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  useEffect(() => {
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle().then(({ data, error: requestError }) => {
      if (requestError) { console.error('[RegisterPage] 读取头图失败:', requestError.message, requestError); return }
      if (data?.image_data && data.image_data.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) }
      else if (!getCachedBanner()) { setBanner(defaultRegisterBanner) }
    }).catch((err) => { console.error('[RegisterPage] 查询异常:', err) })
  }, [])

  // 输入知乎用户名时实时检测是否重名（500ms 防抖）
  useEffect(() => {
    const name = form.zhihu_name.trim()
    if (!name || name.length < 2) { setNameHint(null); return }
    clearTimeout(nameTimer.current)
    setNameHint({ type: 'checking' })
    nameTimer.current = setTimeout(async () => {
      const { data, error: checkErr } = await supabase.rpc('keyflow_check_zhihu_name', { p_name: name })
      if (checkErr) { setNameHint(null); return }
      if (data?.exists) {
        setNameHint({ type: 'taken', suggestion: data.suggestion })
      } else {
        setNameHint(null)
      }
    }, 500)
    return () => clearTimeout(nameTimer.current)
  }, [form.zhihu_name])

  // 输入知乎主页地址时实时检测是否已被占用（500ms 防抖）
  useEffect(() => {
    const addr = form.account_address.trim()
    if (!addr || addr.length < 10) { setAddressHint(null); return }
    clearTimeout(addressTimer.current)
    setAddressHint({ type: 'checking' })
    addressTimer.current = setTimeout(async () => {
      const { data, error: checkErr } = await supabase.rpc('keyflow_check_account_address', { p_address: addr })
      if (checkErr) { setAddressHint(null); return }
      if (data?.exists) {
        setAddressHint({ type: 'taken', zhihu_name: data.zhihu_name })
      } else {
        setAddressHint(null)
      }
    }, 500)
    return () => clearTimeout(addressTimer.current)
  }, [form.account_address])

  const handleRegister = async (event) => {
    event.preventDefault(); setError(''); setNameSuggestion(null)
    if (!form.invitation_code.trim()) { setError('请输入邀请码'); return }
    if (!form.zhihu_name.trim()) { setError('请输入知乎用户名'); return }
    if (!form.account_address.trim()) { setError('请输入知乎主页地址'); return }
    if (!form.wechat_id.trim()) { setError('请输入微信号'); return }
    if (form.password.length < 6) { setError('密码至少 6 位'); return }
    if (form.password !== form.confirm_password) { setError('两次输入的密码不一致'); return }
    setLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('keyflow_register_answerer', {
      p_code: form.invitation_code.trim(),
      p_zhihu_name: form.zhihu_name.trim(),
      p_account_address: form.account_address.trim(),
      p_wechat_id: form.wechat_id.trim(),
      p_password: form.password,
    })
    setLoading(false)
    if (rpcErr) {
      const dupMatch = rpcErr.message.match(/duplicate_zhihu_name:\s*(.+)$/)
      if (dupMatch) {
        const suggestionMatch = rpcErr.message.match(new RegExp('"([^"]+)"$'))
        setError(dupMatch[1])
        setNameSuggestion(suggestionMatch ? suggestionMatch[1] : null)
        return
      }
      if (rpcErr.message.startsWith('duplicate_account_address:')) {
        setError(rpcErr.message.replace('duplicate_account_address: ', ''))
        return
      }
      setError(rpcErr.message); return
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    toast('注册成功')
    let dst
    if (redirect === 'partner') dst = '?partner'
    else if (aid) dst = `?apply=${aid}`
    else {
      const { data: isPartner } = await supabase.rpc('keyflow_is_partner', { p_answerer_id: data.id })
      dst = isPartner ? '?partner' : '?dashboard'
    }
    window.setTimeout(() => { window.location.href = dst }, 800)
  }

  return <div className="register-page-wrapper">
    <div className="register-card">
      <div className="register-banner">
        <div className="register-banner-bg" style={{ backgroundImage: `url(${banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <div className="register-banner-content">
          <span className="brand-mark zhihu-mark">知</span>
          <h1>加入知乎游戏体验计划</h1>
          <p>成为 GameJourney 认证答主！<br/>体验最新游戏，用你的文字影响更多玩家。</p>
        </div>
      </div>
      <form className="register-form" onSubmit={handleRegister}>
        <h2>创建账号</h2>
        <p className="register-form-sub">邀请码由知乎运营或已注册答主提供，每个邀请码仅可使用一次。</p>
        <div className="register-fields">
          <label className="register-field">
            <span>邀请码（联系知乎运营或已注册答主获得）<em>*</em></span>
            <input required value={form.invitation_code} placeholder="KF-XXXXXXXX" onChange={(e) => setForm({ ...form, invitation_code: e.target.value })} />
          </label>
          <label className="register-field">
            <span>知乎用户名<em>*</em></span>
            <input required value={form.zhihu_name} placeholder="请和你的知乎昵称保持一致，登录页面的唯一账号" onChange={(e) => setForm({ ...form, zhihu_name: e.target.value })} />
            {nameHint?.type === 'checking' && <span className="register-field-hint checking">检测中…</span>}
            {nameHint?.type === 'taken' && <span className="register-field-hint taken">该用户名已被使用，建议 <button type="button" className="register-suggestion-btn" onClick={() => { setForm({ ...form, zhihu_name: nameHint.suggestion }); setNameHint(null); }}>使用「{nameHint.suggestion}」</button></span>}
          </label>
          <label className="register-field">
            <span>知乎主页地址<em>*</em></span>
            <input type="url" required value={form.account_address} placeholder="https://www.zhihu.com/people/xxxxxx" onChange={(e) => setForm({ ...form, account_address: e.target.value })} />
            {addressHint?.type === 'checking' && <span className="register-field-hint checking">检测中…</span>}
            {addressHint?.type === 'taken' && <span className="register-field-hint warn">该主页地址已被用户「{addressHint.zhihu_name}」使用，你确定这是你的知乎账户吗？</span>}
          </label>
          <label className="register-field">
            <span>微信号<em>*</em></span>
            <input required value={form.wechat_id} placeholder="即你的微信唯一ID，不是微信名；如ID无效则账户会被封禁" onChange={(e) => setForm({ ...form, wechat_id: e.target.value })} />
          </label>
          <label className="register-field">
            <span>密码<em>*</em></span>
            <input type="password" required value={form.password} placeholder="至少 6 位字符" onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          <label className="register-field">
            <span>再次输入密码<em>*</em></span>
            <input type="password" required value={form.confirm_password} placeholder="请再次输入密码" onChange={(e) => setForm({ ...form, confirm_password: e.target.value })} />
          </label>
        </div>
        {error && <p className="register-error">{error}{nameSuggestion && <> — <button className="register-suggestion-btn" onClick={() => { setForm({ ...form, zhihu_name: nameSuggestion }); setError(''); setNameSuggestion(null); }}>点击使用「{nameSuggestion}」</button></>}</p>}
        <button className="register-submit-btn" disabled={loading}>{loading ? '注册中…' : '注册'}</button>
        <p className="register-login-link">已有账号？<a href={window.location.pathname + '?login' + (aid ? '&aid=' + aid : '') + (redirect ? '&redirect=' + redirect : '')}>去登录</a></p>
      </form>
    </div>
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

function LoginPage({ aid, redirect, token }) {
  const [banner, setBanner] = useState(() => getCachedBanner() || defaultRegisterBanner)
  const [form, setForm] = useState({ zhihu_name: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [forgotMode, setForgotMode] = useState(false)
  const [forgotName, setForgotName] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotMsg, setForgotMsg] = useState('')
  const [forgotStep, setForgotStep] = useState('idle') // idle|pending|approved|rejected|done
  const [forgotAnswererId, setForgotAnswererId] = useState(null)
  const [forgotNewPassword, setForgotNewPassword] = useState('')
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('')

  const handleLogin = async (event) => {
    event.preventDefault(); setError('')
    if (!form.zhihu_name.trim()) { setError('请输入知乎用户名'); return }
    if (!form.password) { setError('请输入密码'); return }
    setLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('keyflow_login_answerer', {
      p_zhihu_name: form.zhihu_name.trim(),
      p_password: form.password,
    })
    setLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    if (redirect === 'partner') window.location.href = token ? `?partner=${token}` : '?partner'
    else if (aid) window.location.href = `?apply=${aid}`
    else {
      const { data: isPartner } = await supabase.rpc('keyflow_is_partner', { p_answerer_id: data.id })
      window.location.href = isPartner ? '?partner' : '?dashboard'
    }
  }

  const handleForgotPassword = async (e) => {
    e.preventDefault(); setForgotMsg('')
    if (!forgotName.trim()) { setForgotMsg('请输入知乎用户名'); return }
    setForgotLoading(true)
    const { data: answerer } = await supabase.from('keyflow_answerers').select('id').eq('zhihu_name', forgotName.trim()).maybeSingle()
    if (!answerer) { setForgotLoading(false); setForgotMsg('未找到该用户名，请确认输入'); return }
    setForgotAnswererId(answerer.id)
    const { error: rpcErr } = await supabase.rpc('keyflow_request_password_reset', { p_answerer_id: answerer.id })
    setForgotLoading(false)
    if (rpcErr) {
      if (rpcErr.message.includes('已有一个待处理')) { setForgotStep('pending'); return }
      setForgotMsg(rpcErr.message); return
    }
    setForgotStep('pending')
  }

  const forgotCheckStatus = async () => {
    if (!forgotAnswererId) return
    const { data } = await supabase.from('keyflow_password_reset_requests')
      .select('*').eq('answerer_id', forgotAnswererId)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'approved') setForgotStep('approved')
      else if (data.status === 'rejected') { setForgotStep('rejected'); setForgotMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
    }
  }

  useEffect(() => {
    if (forgotStep === 'pending' || forgotStep === 'approved') {
      forgotCheckStatus()
      const interval = setInterval(forgotCheckStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [forgotStep, forgotAnswererId])

  useEffect(() => {
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle().then(({ data }) => {
      if (data?.image_data && data.image_data.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) }
      else if (!getCachedBanner()) setBanner(defaultRegisterBanner)
    })
  }, [])

  const forgotResetPassword = async () => {
    if (!forgotNewPassword) { setForgotMsg('请输入新密码'); return }
    if (forgotNewPassword !== forgotConfirmPassword) { setForgotMsg('两次输入密码不一致'); return }
    if (forgotNewPassword.length < 4) { setForgotMsg('密码至少4位'); return }
    setForgotLoading(true)
    setForgotMsg('')
    const { error: rpcErr } = await supabase.rpc('keyflow_reset_password', { p_answerer_id: forgotAnswererId, p_new_password: forgotNewPassword })
    setForgotLoading(false)
    if (rpcErr) { setForgotMsg(rpcErr.message); return }
    setForgotStep('done')
    setForgotMsg('密码重置成功，请使用新密码重新登录。')
    setTimeout(() => {
      const backParams = new URLSearchParams()
      if (redirect) backParams.set('redirect', redirect)
      if (token) backParams.set('token', token)
      if (aid) backParams.set('aid', aid)
      const back = backParams.toString()
      window.location.href = '?login' + (back ? '&' + back : '')
    }, 2000)
  }

  if (forgotMode) { const resetForgot = () => { setForgotMode(false); setForgotMsg(''); setForgotStep('idle'); setForgotAnswererId(null); setForgotNewPassword(''); setForgotConfirmPassword('') }
    return <div className="public-page"><main className="public-card" style={{ maxWidth: '440px' }}>
    <div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 忘记密码</span></div>
    <div className="public-hero"><h1>申请重置密码</h1><span>输入你的知乎用户名，提交申请后等待管理员审核。</span></div>
    {forgotStep === 'idle' ? <form className="public-form" onSubmit={handleForgotPassword}>
      <Field label="知乎用户名" required value={forgotName} placeholder="输入你的知乎用户名" onChange={setForgotName} />
      {forgotMsg && <p className="public-error">{forgotMsg}</p>}
      <button className="primary public-submit" disabled={forgotLoading}>{forgotLoading ? '提交中…' : '提交申请'}</button>
      <a className="forgot-back-link" href="javascript:void(0)" onClick={resetForgot}>← 返回登录</a>
    </form> : forgotStep === 'pending' ? <div className="step-message">
      <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
      <p>等待审核</p>
      <span>页面会自动检测审核结果。</span>
      <button className="outline-button" style={{marginTop:'var(--sp-4)'}} onClick={resetForgot}>返回登录</button>
    </div> : forgotStep === 'approved' ? <form className="public-form" onSubmit={(e) => { e.preventDefault(); forgotResetPassword() }}>
      <div style={{gridColumn:'1 / -1', textAlign:'center', padding:'var(--sp-3) 0'}}>
        <div className="step-message-icon done" style={{margin:'0 auto var(--sp-2)'}}><Icon name="check" size={24}/></div>
        <p style={{fontSize:'var(--fs-section-title)', fontWeight:600, marginBottom:'var(--sp-1)'}}>审核已通过</p>
        <span style={{fontSize:'var(--fs-label)', color:'var(--c-ink-3)'}}>管理员已通过你的申请，请在下方设置新密码。</span>
      </div>
      <div className="field field-wide"><span>新密码<em>*</em></span><input type="password" required value={forgotNewPassword} placeholder="输入新密码（至少4位）" onChange={(e) => setForgotNewPassword(e.target.value)} /></div>
      <div className="field field-wide"><span>确认新密码<em>*</em></span><input type="password" required value={forgotConfirmPassword} placeholder="再次输入新密码" onChange={(e) => setForgotConfirmPassword(e.target.value)} /></div>
      {forgotMsg && <p className="public-error">{forgotMsg}</p>}
      <button className="primary public-submit" disabled={forgotLoading}>{forgotLoading ? '提交中…' : '确认重置'}</button>
      <a className="forgot-back-link" href="javascript:void(0)" onClick={resetForgot}>← 返回登录</a>
    </form> : forgotStep === 'rejected' ? <div className="step-message">
      <div className="step-message-icon rejected"><Icon name="close" size={24}/></div>
      <p>申请被拒绝</p>
      <span>{forgotMsg || '管理员拒绝了你的密码重置申请。'}</span>
      <button className="outline-button" style={{marginTop:'var(--sp-4)'}} onClick={() => { setForgotStep('idle'); setForgotMsg(''); setForgotNewPassword(''); setForgotConfirmPassword('') }}>重新申请</button>
    </div> : forgotStep === 'done' ? <div className="step-message">
      <div className="step-message-icon done"><Icon name="check" size={24}/></div>
      <p>密码重置成功</p>
      <span>请使用新密码重新登录，即将跳转到登录页...</span>
    </div> : null}
  </main></div>}

  return <div className="register-page-wrapper">
    <div className="register-card">
      <div className="register-banner">
        <div className="register-banner-bg" style={{ backgroundImage: `url(${banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <div className="register-banner-content">
          <span className="brand-mark zhihu-mark">知</span>
          <h1>答主登录</h1>
          <p>使用已注册的知乎用户名和密码登录。</p>
        </div>
      </div>
      <form className="register-form" onSubmit={handleLogin}>
        <h2>登录</h2>
        <div className="register-fields">
          <label className="register-field">
            <span>知乎用户名<em>*</em></span>
            <input required value={form.zhihu_name} placeholder="输入注册时的知乎用户名" onChange={(e) => setForm({ ...form, zhihu_name: e.target.value })} />
          </label>
          <label className="register-field">
            <span>密码<em>*</em></span>
            <input type="password" required value={form.password} placeholder="输入密码" onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
        </div>
        {error && <p className="register-error">{error}</p>}
        <button className="register-submit-btn" disabled={loading}>{loading ? '登录中…' : '登录'}</button>
        <p className="register-login-link">还没有账号？<a href={window.location.pathname + '?register' + (aid ? '&aid=' + aid : '') + (redirect ? '&redirect=' + redirect : '')}>去注册</a>　<a href="javascript:void(0)" onClick={() => { setForgotMode(true); setForgotStep('idle'); setForgotMsg(''); setForgotName(''); setForgotAnswererId(null); setForgotNewPassword(''); setForgotConfirmPassword('') }}>忘记密码？</a></p>
      </form>
    </div>
  </div>
}

function AdminLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (event) => {
    event.preventDefault(); setError('')
    if (!username.trim()) { setError('请输入用户名'); return }
    if (!password) { setError('请输入密码'); return }
    setLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('keyflow_admin_login', {
      p_username: username.trim(),
      p_password: password,
    })
    setLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(data))
    window.location.href = window.location.pathname
  }

  return <div className="admin-login-wrapper">
    <div className="admin-login-card">
      <div className="admin-login-header">
        <span className="brand-mark zhihu-mark">知</span>
        <h1>GameJourney 管理后台</h1>
        <p>请输入管理员账号登录</p>
      </div>
      <form className="admin-login-form" onSubmit={handleLogin}>
        <label className="admin-login-field">
          <span>用户名</span>
          <input required value={username} placeholder="请输入管理员用户名" onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label className="admin-login-field">
          <span>密码</span>
          <input type="password" required value={password} placeholder="请输入密码" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="admin-login-error">{error}</p>}
        <button className="admin-login-submit" disabled={loading}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  </div>
}

function AnswererParticipationModal({ answerer, records, onClose, toast }) {
  const completedCount = records.filter((record) => record.keyflow_deliveries?.id).length
  const applicationStatus = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatus = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const exportExcel = () => {
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = records.map((record) => {
      const delivery = record.keyflow_deliveries
      return [answerer.zhihu_name, record.activity?.game_name || '活动已删除', record.activity?.title || '活动已删除', new Date(record.submitted_at).toLocaleString('zh-CN'), applicationStatus[record.status] || record.status, delivery?.id ? deliveryStatus[delivery.status] || delivery.status : '未提交', cleanZhihuAnswerUrl(delivery?.article_url) || ''].map(quote).join(',')
    }).join('\n')
    const blob = new Blob([`\uFEFF答主,游戏,活动,参与时间,报名状态,交付状态,知乎回答链接\n${rows}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${answerer.zhihu_name}_活动参与记录_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    toast('活动参与记录已下载')
  }

  return <Modal title={`${answerer.zhihu_name} · 活动参与记录`} onClose={onClose} className="answerer-participation-modal">
    <div className="answerer-participation">
      <div className="answerer-participation-toolbar"><div className="answerer-participation-summary"><div><strong>{records.filter((r) => r.status === 'selected').length}</strong><span>历史参与次数</span></div><div><strong>{completedCount}</strong><span>完成次数</span></div></div><button className="outline-button compact" onClick={exportExcel}>下载 Excel</button></div>
      <div className="answerer-participation-list">{records.length ? records.map((record) => {
        const delivery = record.keyflow_deliveries
        return <article className="answerer-participation-item" key={record.id}><div><strong>{record.activity ? `${record.activity.game_name} · ${record.activity.title}` : '活动已删除'}</strong><small>参与时间：{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.submitted_at))}</small></div><div className="answerer-participation-meta"><span className={`pill ${record.status === 'selected' ? 'success' : record.status === 'rejected' ? 'muted' : 'warning'}`}>{applicationStatus[record.status] || record.status}</span>{delivery?.id && <span className={`pill ${delivery.status === 'approved' ? 'success' : delivery.status === 'rejected' ? 'muted' : 'warning'}`}>{deliveryStatus[delivery.status] || delivery.status}</span>}</div>{delivery?.article_url ? <a className="profile-link" href={cleanZhihuAnswerUrl(delivery.article_url)} target="_blank" rel="noreferrer">打开知乎回答 <Icon name="arrow" size={13}/></a> : <span className="answerer-participation-empty">尚未提交内容</span>}</article>
      }) : <p className="answerer-participation-empty">暂无活动参与记录。</p>}</div>
    </div>
  </Modal>
}

function PartnerManagement({ codes, answerers, activities, onAddCodes, onRefresh }) {
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [managePartner, setManagePartner] = useState(null) // partner being managed
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }
  const partnerCodes = codes.filter((code) => code.code_type === 'partner')
  const unusedCodes = partnerCodes.filter((code) => !code.application_id && !code.answerer_id)
  const usedCodes = partnerCodes.filter((code) => code.application_id || code.answerer_id)
  const partnerAnswererIds = new Set(partnerCodes.filter((code) => code.answerer_id).map((code) => code.answerer_id))
  const partners = answerers.filter((answerer) => partnerAnswererIds.has(answerer.id))
  const displayCodes = partnerCodes.slice(0, 10)
  const [copiedIds, setCopiedIds] = useState(new Set())

  const generate = async () => {
    setGenerating(true)
    const { data, error } = await supabase.rpc('keyflow_generate_invitation_codes', { p_count: 10, p_code_type: 'partner' })
    setGenerating(false)
    if (error) { toast('生成失败：' + error.message); return }
    if (data) onAddCodes(data)
    toast('已生成 10 个合作方邀请码')
  }
  const copyCode = (code, id) => { navigator.clipboard.writeText(code); setCopiedIds(prev => { const next = new Set(prev); next.add(id); return next }); toast('邀请码已复制') }

  const usedCount = usedCodes.length

  const downloadPastCodes = async () => {
    const { data, error } = await supabase.rpc('keyflow_get_past_invitation_codes', { p_code_type: 'partner' })
    if (error) { toast('获取过往邀请码失败'); return }
    if (!data?.length) { toast('没有过往邀请码记录'); return }
    const header = '\uFEFF邀请码,领取人,领取方式,领取时间'
    const rows = data.map(d => {
      const time = d.used_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d.used_at)) : ''
      return `${d.code},${d.claimer_name || '—'},${d.claimer_type},${time}`
    })
    const csv = header + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `合作方过往邀请码_${fileTimestamp()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('已下载过往邀请码')
  }

  return <div className="answerer-mgmt">
    <section className="metrics answerer-overview"><div className="metric"><strong>{unusedCodes.length}</strong><span>可用邀请码</span></div><div className="metric"><strong>{usedCount}</strong><span>已使用</span></div><div className="metric"><strong>{partners.length}</strong><span>注册合作方</span></div></section>
    <section className="panel"><div className="panel-head"><div><h3>合作方邀请码管理</h3><p>合作方专用邀请码，通过该邀请码注册的用户会归入合作方列表。</p></div><div className="inv-gen-row"><button className="primary compact" onClick={generate} disabled={generating}>{generating ? '生成中…' : '批量生成新的邀请码'}</button><button className="outline-button compact" onClick={downloadPastCodes}>下载过往邀请码</button></div></div>{displayCodes.length ? <div className="invite-grid"><div className="invite-col">{displayCodes.slice(0, 5).map((code) => { const isUsed = code.application_id || code.answerer_id; const isCopied = copiedIds.has(code.id); return <div key={code.id} className={`invite-card${isUsed ? ' used' : ''}${isCopied ? ' copied' : ''}`} onClick={() => !isUsed && copyCode(code.code, code.id)} title={isUsed ? '已使用' : '点击复制'}><span className="invite-card-num">{code.code}</span>{isUsed ? <span className="invite-card-used-badge">已使用</span> : <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(code.created_at))}</small>}</div> })}</div><div className="invite-col">{displayCodes.slice(5, 10).map((code) => { const isUsed = code.application_id || code.answerer_id; const isCopied = copiedIds.has(code.id); return <div key={code.id} className={`invite-card${isUsed ? ' used' : ''}${isCopied ? ' copied' : ''}`} onClick={() => !isUsed && copyCode(code.code, code.id)} title={isUsed ? '已使用' : '点击复制'}><span className="invite-card-num">{code.code}</span>{isUsed ? <span className="invite-card-used-badge">已使用</span> : <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(code.created_at))}</small>}</div> })}</div></div> : <p className="table-empty" style={{ padding: 'var(--sp-8) 0', textAlign: 'center' }}>暂无可用的合作方邀请码，点击「生成」创建新一批。</p>}</section>
    <section className="panel"><div className="panel-head"><div><h3>注册合作方列表</h3><p>所有通过合作方邀请码注册的用户。</p></div><button className="outline-button compact" onClick={() => {
      const headers = ['编号', '知乎用户名', '知乎主页地址', '微信号', '注册时间']
      const rows = partners.map((p) => [p.serial_number != null ? String(p.serial_number).padStart(3, '0') : '—', p.zhihu_name, p.account_address || '未填写', p.wechat_id || '未填写', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(p.created_at))])
      const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `注册合作方列表_${fileTimestamp()}.csv`; a.click()
      URL.revokeObjectURL(url)
      toast('合作方列表已下载')
    }}>下载 Excel</button></div><div className="table-wrap"><table><thead><tr><th>#</th><th>知乎用户名</th><th>知乎主页地址</th><th>微信号</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{partners.length ? partners.map((partner) => { const linkedCount = activities.filter(a => a.partner_answerer_id === partner.id).length; return <tr key={partner.id}><td><span className="serial-number">{partner.serial_number != null ? String(partner.serial_number).padStart(3, '0') : '—'}</span></td><td><div className="person">{partner.avatar_url ? <img className="person-avatar-img" src={partner.avatar_url} alt="" /> : <span className="person-avatar">{partner.zhihu_name[0]}</span>}<div><strong>{partner.zhihu_name}</strong><small>合作方</small></div></div></td><td>{partner.account_address ? <a className="profile-link" href={partner.account_address} target="_blank" rel="noreferrer">查看主页</a> : '未填写'}</td><td>{partner.wechat_id || '未填写'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(partner.created_at))}</td><td><button className="outline-button compact" onClick={() => setManagePartner(partner)}>管理活动{linkedCount > 0 ? ` (${linkedCount})` : ''}</button></td></tr> }) : <tr><td colSpan="6" className="table-empty">暂无注册合作方。</td></tr>}</tbody></table></div></section>
    {managePartner && <PartnerActivityModal partner={managePartner} activities={activities} answerers={answerers} onClose={() => setManagePartner(null)} onRefresh={onRefresh} toast={toast} />}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

function PartnerActivityModal({ partner, activities, answerers, onClose, onRefresh, toast }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [submitting, setSubmitting] = useState(false)
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = [...activities].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    if (!q) return list
    return list.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.game_name.toLowerCase().includes(q)
    )
  }, [activities, search])

  const linkedIds = useMemo(() => new Set(activities.filter(a => a.partner_answerer_id === partner.id).map(a => a.id)), [activities, partner.id])
  const linkedCount = linkedIds.size
  const selectedLinked = [...selected].filter(id => linkedIds.has(id)).length
  const selectedNotLinked = [...selected].filter(id => !linkedIds.has(id)).length

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === filtered.length) { setSelected(new Set()); return }
    setSelected(new Set(filtered.map(a => a.id)))
  }

  const batchLink = async (link) => {
    setSubmitting(true)
    const ids = selected.size ? [...selected] : filtered.map(a => a.id)
    const targetIds = link ? ids.filter(id => !linkedIds.has(id)) : ids.filter(id => linkedIds.has(id))
    if (!targetIds.length) { setSubmitting(false); toast('没有需要变更的活动'); return }
    // Update in batches
    for (const id of targetIds) {
      const { error } = await supabase.from('keyflow_activities').update({ partner_answerer_id: link ? partner.id : null }).eq('id', id)
      if (error) { toast('操作失败：' + error.message); setSubmitting(false); return }
    }
    setSubmitting(false)
    setSelected(new Set())
    await onRefresh()
    toast(link ? `已关联 ${targetIds.length} 个活动到 ${partner.zhihu_name}` : `已取消 ${targetIds.length} 个活动的关联`)
  }

  return <Modal title={`${partner.zhihu_name} · 管理关联活动`} onClose={onClose} className="partner-activity-modal" wide>
    <div className="partner-activity-body">
      <div className="partner-activity-toolbar">
        <div className="partner-search-wrap">
          <Icon name="search" size={15} />
          <input className="partner-search-input" placeholder="搜索活动名称或游戏名…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button className="partner-search-clear" onClick={() => setSearch('')}><Icon name="close" size={14} /></button>}
        </div>
        <div className="partner-activity-actions">
          <span className="partner-selected-hint">
            已选 <strong>{selected.size}</strong> 个
            {selectedLinked > 0 && <span className="partner-selected-linked">（含已关联 {selectedLinked} 个）</span>}
          </span>
          <button className="outline-button compact" onClick={toggleAll}>
            {selected.size === filtered.length ? '取消全选' : '全选'}
          </button>
          <button className="primary compact" onClick={() => batchLink(true)} disabled={submitting || selectedNotLinked === 0}>
            关联选中
          </button>
          <button className="outline-button compact danger" onClick={() => batchLink(false)} disabled={submitting || selectedLinked === 0}>
            取消关联
          </button>
        </div>
      </div>
      <div className="partner-activity-summary">
        当前已关联 <strong>{linkedCount}</strong> 个活动
        {search && <span className="partner-search-result"> — 搜索到 {filtered.length} 个结果</span>}
      </div>
      <div className="partner-activity-grid">
        {filtered.length ? filtered.map(activity => {
          const isLinked = linkedIds.has(activity.id)
          const currentPartner = activity.partner_answerer_id && !isLinked ? answererById[activity.partner_answerer_id] : null
          const isChecked = selected.has(activity.id)
          return <label key={activity.id} className={`partner-card ${isLinked ? 'linked' : ''} ${isChecked ? 'checked' : ''} ${currentPartner ? 'busy' : ''}`}>
            <input type="checkbox" checked={isChecked} onChange={() => toggleSelect(activity.id)} />
            <div className="partner-card-cover">
              {activity.game_cover ? <img src={activity.game_cover} alt="" /> : <span className="partner-card-cover-placeholder">{activity.game_name?.[0] || '?'}</span>}
            </div>
            <div className="partner-card-body">
              <span className="partner-card-game">{activity.game_name}</span>
              <span className="partner-card-title">{activity.title}</span>
            </div>
            {isLinked && <span className="partner-card-badge linked">已关联</span>}
            {currentPartner && <span className="partner-card-badge busy">{currentPartner.zhihu_name}</span>}
          </label>
        }) : <p className="table-empty" style={{ gridColumn: '1/-1' }}>暂无匹配的活动。</p>}
      </div>
    </div>
  </Modal>
}

function AnswererManagement({ codes, answerers, activities, applications, onAddCodes, onRefresh }) {
  const [selectedAnswerer, setSelectedAnswerer] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [search, setSearch] = useState('')
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])
  const activityById = useMemo(() => Object.fromEntries(activities.map((activity) => [activity.id, activity])), [activities])
  const participationByAnswerer = useMemo(() => {
    const records = {}
    applications.forEach((application) => {
      if (!application.answerer_id) return
      if (!records[application.answerer_id]) records[application.answerer_id] = []
      records[application.answerer_id].push({ ...application, activity: activityById[application.activity_id] })
    })
    return records
  }, [applications, activityById])

  const filteredAnswerers = useMemo(() => {
    if (!search.trim()) return answerers
    const kw = search.trim().toLowerCase()
    return answerers.filter(a => a.zhihu_name.toLowerCase().includes(kw) || (a.wechat_id || '').toLowerCase().includes(kw) || (a.account_address || '').toLowerCase().includes(kw))
  }, [answerers, search])

  const answererCodes = codes.filter(c => c.code_type === 'answerer')
  const unusedCodes = answererCodes.filter(c => !c.application_id && !c.answerer_id)
  const usedCodes = answererCodes.filter(c => c.application_id || c.answerer_id)
  const unusedCount = unusedCodes.length
  const usedCount = usedCodes.length
  const displayCodes = answererCodes.slice(0, 10)
  const leftCol = displayCodes.slice(0, 5)
  const rightCol = displayCodes.slice(5, 10)
  const [copiedIds, setCopiedIds] = useState(new Set())

  const generate = async () => {
    setGenerating(true)
    const { data, error } = await supabase.rpc('keyflow_generate_invitation_codes', { p_count: 10 })
    setGenerating(false)
    if (error) { toast('生成失败：' + error.message); return }
    if (data) onAddCodes(data)
    toast('已生成 10 个邀请码')
  }

  const copyCode = (code, id) => { navigator.clipboard.writeText(code); setCopiedIds(prev => { const next = new Set(prev); next.add(id); return next }); toast('邀请码已复制') }

  const deleteAnswerer = async () => {
    if (!confirmDeleteId) return
    const { error: requestError } = await supabase.from('keyflow_answerers').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (requestError) return toast('删除失败：' + requestError.message)
    await onRefresh()
    toast('答主已删除')
  }

  const downloadPastCodes = async () => {
    const { data, error } = await supabase.rpc('keyflow_get_past_invitation_codes')
    if (error) { toast('获取过往邀请码失败'); return }
    if (!data?.length) { toast('没有过往邀请码记录'); return }
    const header = '\uFEFF邀请码,领取人,领取方式,领取时间'
    const rows = data.map(d => {
      const time = d.used_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d.used_at)) : ''
      return `${d.code},${d.claimer_name || '—'},${d.claimer_type},${time}`
    })
    const csv = header + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `过往邀请码_${fileTimestamp()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('已下载过往邀请码')
  }

  const downloadAnswererSharedCodes = async () => {
    const { data, error } = await supabase.rpc('keyflow_get_answerer_shared_codes')
    if (error) { toast('获取答主生成邀请码失败'); return }
    if (!data?.length) { toast('没有答主生成邀请码记录'); return }
    const header = '\uFEFF答主,邀请码,是否使用,新增注册用户,新增用户ID'
    const rows = data.map(d => `${d.answerer_name},${d.code},${d.is_used ? '是' : '否'},${d.new_registered_user || '—'},${d.registered_user_id || '—'}`)
    const csv = header + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `答主生成邀请码_${fileTimestamp()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast('已下载答主生成邀请码')
  }

  const overviewStats = [{ value: unusedCount, label: '可用邀请码' }, { value: usedCount, label: '已使用' }, { value: answerers.length, label: '注册答主' }]

  return <div className="answerer-mgmt">
    <section className="metrics answerer-overview">{overviewStats.map(({ value, label }) => <div className="metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</section>

    <section className="panel">
      <div className="panel-head">
        <div><h3>邀请码管理</h3><p>平台通用凭证，不绑定具体活动，每个仅可使用一次{unusedCount > 10 ? `（当前 ${unusedCount} 个可用，展示最近 10 个）` : ''}。</p></div>
        <div className="inv-gen-row">
          <button className="primary compact" onClick={generate} disabled={generating}>{generating ? '生成中…' : '批量生成新的邀请码'}</button>
          {usedCount > 0 && <button className="outline-button compact" onClick={downloadPastCodes}>下载过往邀请码</button>}
          <button className="outline-button compact" onClick={downloadAnswererSharedCodes}>下载答主生成邀请码</button>
        </div>
      </div>
      {displayCodes.length ? <div className="invite-grid"><div className="invite-col">{leftCol.map(c => { const isUsed = c.application_id || c.answerer_id; const isCopied = copiedIds.has(c.id); return <div key={c.id} className={`invite-card${isUsed ? ' used' : ''}${isCopied ? ' copied' : ''}`} onClick={() => !isUsed && copyCode(c.code, c.id)} title={isUsed ? '已使用' : '点击复制'}><span className="invite-card-num">{c.code}</span>{isUsed ? <span className="invite-card-used-badge">已使用</span> : <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(c.created_at))}</small>}</div> })}</div><div className="invite-col">{rightCol.map(c => { const isUsed = c.application_id || c.answerer_id; const isCopied = copiedIds.has(c.id); return <div key={c.id} className={`invite-card${isUsed ? ' used' : ''}${isCopied ? ' copied' : ''}`} onClick={() => !isUsed && copyCode(c.code, c.id)} title={isUsed ? '已使用' : '点击复制'}><span className="invite-card-num">{c.code}</span>{isUsed ? <span className="invite-card-used-badge">已使用</span> : <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(c.created_at))}</small>}</div> })}</div></div> : <p className="table-empty" style={{ padding: 'var(--sp-8) 0', textAlign: 'center' }}>暂无可用的邀请码，点击「生成」创建新一批。</p>}
    </section>

    <section className="panel">
      <div className="panel-head"><div><h3>注册答主列表</h3><p>所有通过邀请码注册的答主账号。</p></div><div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}><div className="partner-search-wrap" style={{ background: '#fff', minWidth: 220, gap: 'var(--sp-1)', padding: 'var(--sp-1) var(--sp-2)' }}><Icon name="search" size={14} /><input className="partner-search-input" placeholder="搜索答主名称、微信或主页…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="partner-search-clear" onClick={() => setSearch('')}><Icon name="close" size={14} /></button>}</div><button className="outline-button compact" onClick={() => {
        const headers = ['注册用户ID', '知乎用户名', '知乎主页地址', '微信号', '活动参与次数', '成功完成次数', '完成率', '注册时间']
        const rows = answerers.map((a) => {
          const records = participationByAnswerer[a.id] || []
          const selectedRecords = records.filter((r) => r.status === 'selected')
          const completed = records.filter((r) => r.keyflow_deliveries?.article_url).length
          const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'
          return [a.serial_number != null ? String(a.serial_number).padStart(3, '0') : '—', a.zhihu_name, a.account_address || '未填写', a.wechat_id || '未填写', `${selectedRecords.length}`, `${completed}`, rate, new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.created_at))]
        })
        const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = `注册答主列表_${fileTimestamp()}.csv`; a.click()
        URL.revokeObjectURL(url)
        toast('答主列表已下载')
      }}>下载 Excel</button></div></div>
      <div className="table-wrap"><table><thead><tr><th>#</th><th>知乎用户名</th><th>知乎主页地址</th><th>微信号</th><th>活动参与次数</th><th>成功完成次数</th><th>完成率</th><th>参与记录</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{filteredAnswerers.length ? filteredAnswerers.map((a) => {
        const records = participationByAnswerer[a.id] || []
        const selectedRecords = records.filter((r) => r.status === 'selected')
        const completed = records.filter((r) => r.keyflow_deliveries?.article_url).length
        const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'
        return <tr key={a.id}><td><span className="serial-number">{a.serial_number != null ? String(a.serial_number).padStart(3, '0') : '—'}</span></td><td><div className="person">{a.avatar_url ? <img className="person-avatar-img" src={a.avatar_url} alt="" /> : <span className="person-avatar">{a.zhihu_name[0]}</span>}<div><strong>{a.zhihu_name}</strong><small>答主</small></div></div></td><td>{a.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>未填写</span>}</td><td>{a.wechat_id || '未填写'}</td><td>{selectedRecords.length}</td><td>{completed}</td><td>{rate}</td><td><button className="outline-button compact" onClick={() => setSelectedAnswerer(a)}>查看记录</button></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.created_at))}</td><td><button className="delete-action" onClick={() => setConfirmDeleteId(a.id)}>删除</button></td></tr>
      }) : <tr><td colSpan="10" className="table-empty">暂无注册答主。</td></tr>}</tbody></table></div>
    </section>
    {selectedAnswerer && <AnswererParticipationModal answerer={selectedAnswerer} records={participationByAnswerer[selectedAnswerer.id] || []} onClose={() => setSelectedAnswerer(null)} toast={toast} />}
    {confirmDeleteId && <ConfirmDialog message="确定要删除该答主吗？此操作不可撤销。" onConfirm={deleteAnswerer} onCancel={() => setConfirmDeleteId(null)} />}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

const PAGE_SIZE = 20

function DailySubmissionsPage({ submissions, answerers, toast, setDailySubmissions }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return submissions
    return submissions.filter(s => {
      const a = answererById[s.answerer_id]
      return (s.article_url || '').toLowerCase().includes(q)
        || (s.article_title || '').toLowerCase().includes(q)
        || (a?.zhihu_name || '').toLowerCase().includes(q)
    })
  }, [submissions, keyword, answererById])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [keyword])

  const pages = useMemo(() => {
    const result = []
    const total = totalPages
    if (total <= 7) {
      for (let i = 1; i <= total; i++) result.push(i)
    } else {
      result.push(1)
      if (safePage > 3) result.push('…')
      const start = Math.max(2, safePage - 1)
      const end = Math.min(total - 1, safePage + 1)
      for (let i = start; i <= end; i++) result.push(i)
      if (safePage < total - 2) result.push('…')
      result.push(total)
    }
    return result
  }, [safePage, totalPages])

  const formatDate = (v) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v))

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除该投稿吗？此操作不可撤销。')) return
    const { error } = await supabase.from('keyflow_daily_submissions').delete().eq('id', id)
    if (error) { toast?.(error.message); return }
    setDailySubmissions(prev => prev.filter(s => s.id !== id))
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
    toast?.('投稿已删除')
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    if (!window.confirm(`确定要删除选中的 ${selectedIds.size} 条投稿吗？此操作不可撤销。`)) return
    const ids = [...selectedIds]
    const { error } = await supabase.from('keyflow_daily_submissions').delete().in('id', ids)
    if (error) { toast?.(error.message); return }
    setDailySubmissions(prev => prev.filter(s => !selectedIds.has(s.id)))
    setSelectedIds(new Set())
    toast?.(`已删除 ${ids.length} 条投稿`)
  }

  const handleViewSubmission = async (s) => {
    window.open(cleanZhihuAnswerUrl(s.article_url), '_blank')
    // Check if already sent a message for this submission
    const { data: existing } = await supabase.from('keyflow_inbox')
      .select('id').eq('to_id', s.answerer_id).eq('type', 'private_message')
      .eq('data->>submission_id', String(s.id))
      .maybeSingle()
    if (existing) return
    const { error } = await supabase.from('keyflow_inbox').insert({
      type: 'private_message', title: '投稿已收到', body: `您的投稿「${s.article_title || '未知标题'}」已收到，已经进行扶持处理`,
      to_id: s.answerer_id, status: 'unread', data: { submission_id: s.id },
    })
    if (!error) toast?.('已向答主发送投稿确认私信')
  }

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === paged.length) { setSelectedIds(new Set()); return }
    const newSet = new Set(selectedIds)
    paged.forEach(s => newSet.add(s.id))
    setSelectedIds(newSet)
  }

  const downloadExcel = () => {
    const headers = ['答主', '知乎主页', '作品标题', '投稿链接', '投稿时间']
    const rows = filtered.map(s => {
      const a = answererById[s.answerer_id]
      return [a?.zhihu_name || '未知答主', a?.account_address || '', s.article_title || '', cleanZhihuAnswerUrl(s.article_url), formatDate(s.submitted_at)]
    })
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `答主日常投稿_${fileTimestamp()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return <div>
    <section className="panel">
      <div className="application-toolbar">
        <div className="application-controls">
          <input placeholder="搜索投稿链接、标题或答主…" value={keyword} onChange={e => setKeyword(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          {selectedIds.size > 0 && <button className="outline-button compact" style={{ color: 'var(--c-danger)', borderColor: 'var(--c-danger)' }} onClick={handleBatchDelete}>删除选中 ({selectedIds.size})</button>}
          <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--c-ink-4)', whiteSpace: 'nowrap' }}>当前投稿共 {filtered.length} 条</span>
          <button className="outline-button compact" onClick={downloadExcel}>下载 Excel</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}><input type="checkbox" checked={paged.length > 0 && selectedIds.size === paged.length} onChange={toggleSelectAll} /></th>
              <th>答主</th>
              <th>知乎主页</th>
              <th>作品标题</th>
              <th>投稿链接</th>
              <th>投稿时间</th>
              <th style={{ width: 60 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {paged.length ? paged.map(s => {
              const a = answererById[s.answerer_id]
              return <tr key={s.id}>
                <td><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                <td><div className="person">{answererByName[a?.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[a.zhihu_name].avatar_url} alt="" /> : <span className="person-avatar">{a?.zhihu_name?.[0] || '?'}</span>}<div><strong>{a?.zhihu_name || '未知答主'}</strong><small>知乎答主</small></div></div></td>
                <td>{a?.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>未填写</span>}</td>
                <td>{s.article_title || <span style={{ color: 'var(--c-ink-4)' }}>—</span>}</td>
                <td><a className="profile-link" href={cleanZhihuAnswerUrl(s.article_url)} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); handleViewSubmission(s) }}>查看投稿 <Icon name="arrow" size={13} /></a></td>
                <td>{formatDate(s.submitted_at)}</td>
                <td><button className="delete-action" onClick={() => handleDelete(s.id)} title="删除投稿">删除</button></td>
              </tr>
            }) : <tr><td colSpan="7" className="table-empty">{keyword ? '无匹配结果。' : '暂无日常投稿。'}</td></tr>}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && <div className="pagination">
        <div className="page-info">第 {safePage} 页，共 {totalPages} 页，共 {filtered.length} 条</div>
        <div className="page-btns">
          <button className="page-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}><Icon name="arrow" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
          {pages.map((p, i) => p === '…'
            ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span>
            : <button key={p} className={`page-btn${p === safePage ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
          )}
          <button className="page-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}><Icon name="arrow" size={13} /></button>
        </div>
      </div>}
    </section>
  </div>
}

function InboxPage({ messages, requests, answerers, onRefresh, toast, setConfirmState }) {
  const [tab, setTab] = useState('inbox')
  const [expandedId, setExpandedId] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(null)

  // --- compose states ---
  const [composeTitle, setComposeTitle] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [selectAllChecked, setSelectAllChecked] = useState(false)

  const answererById = useMemo(() => {
    const map = {}
    answerers.forEach(a => { map[a.id] = a })
    return map
  }, [answerers])

  // --- compose helpers ---
  const filteredAnswerers = useMemo(() => {
    if (!search.trim()) return answerers
    const kw = search.trim().toLowerCase()
    return answerers.filter(a => a.zhihu_name.toLowerCase().includes(kw) || (a.wechat_id || '').toLowerCase().includes(kw) || (a.account_address || '').toLowerCase().includes(kw))
  }, [answerers, search])

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
    setSelectAllChecked(false)
  }

  const handleSelectAll = () => {
    if (selectAllChecked) {
      setSelectedIds(prev => { const next = new Set(prev); filteredAnswerers.forEach(a => next.delete(a.id)); return next })
    } else {
      setSelectedIds(prev => { const next = new Set(prev); filteredAnswerers.forEach(a => next.add(a.id)); return next })
    }
    setSelectAllChecked(!selectAllChecked)
  }

  const sendMessages = async () => {
    if (!composeTitle.trim()) { toast('请输入私信标题'); return }
    if (!composeBody.trim()) { toast('请输入私信内容'); return }
    if (selectedIds.size === 0) { toast('请至少选择一位答主'); return }
    setSending(true)
    const msgs = Array.from(selectedIds).map(id => ({
      type: 'private_message', title: composeTitle.trim(), body: composeBody.trim(), to_id: id, status: 'unread',
    }))
    const { error } = await supabase.from('keyflow_inbox').insert(msgs)
    setSending(false)
    if (error) { toast(error.message); return }
    toast(`已向 ${selectedIds.size} 位答主发送私信`)
    setComposeTitle(''); setComposeBody(''); setSelectedIds(new Set()); setSelectAllChecked(false)
    onRefresh()
  }

  // Unified list: system messages + grouped sent batches, sorted by time
  const allMessages = useMemo(() => {
    const items = []

    // System messages (password_reset etc.)
    messages.filter(m => m.type !== 'private_message').forEach(msg => {
      items.push({ _key: msg.id, _type: 'recv', ...msg })
    })

    // Group sent private messages by batch
    const sent = messages.filter(m => m.type === 'private_message')
    const groups = new Map()
    sent.forEach(msg => {
      const key = msg.title + '|||' + msg.body + '|||' + msg.created_at
      if (!groups.has(key)) groups.set(key, { ...msg, to_ids: [] })
      groups.get(key).to_ids.push(msg.to_id)
    })
    groups.forEach(batch => {
      const names = batch.to_ids.map(id => answererById[id]?.zhihu_name || '未知').join('、')
      items.push({
        _key: 'sent-' + batch.id,
        _type: 'sent_batch',
        id: batch.id,
        type: 'private_message',
        title: batch.title,
        body: batch.body,
        created_at: batch.created_at,
        status: 'read',
        to_ids: batch.to_ids,
        recipientNames: names,
      })
    })

    return items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [messages, answererById])

  const getRequestByAnswererId = (answererId) => {
    return requests.find(r => r.answerer_id === answererId && r.status === 'pending') || null
  }

  const handleReview = async (msg, approved) => {
    const request = getRequestByAnswererId(msg.from_id)
    if (!request) { toast('未找到对应的密码重置申请'); return }
    setReviewLoading(msg.id)
    const { error } = await supabase.rpc('keyflow_review_password_reset', { p_request_id: request.id, p_approved: approved })
    setReviewLoading(null)
    if (error) { toast(error.message); return }
    toast(approved ? '已通过密码重置申请' : '已拒绝密码重置申请')
    onRefresh()
  }

  const handleDelete = (msg) => {
    // For sent batches, delete all messages in the batch
    if (msg._type === 'sent_batch') {
      setConfirmState({
        message: `确定要删除这条已发送私信吗？此操作不可撤销。`,
        onConfirm: async () => {
          setConfirmState(null)
          const { error } = await supabase.from('keyflow_inbox').delete().in('id', msg.to_ids.map(() => msg.id))
          if (error) { toast(error.message); return }
          toast('私信已删除')
          onRefresh()
        }
      })
      return
    }

    setConfirmState({
      message: '确定要删除这条消息吗？此操作不可撤销。',
      onConfirm: async () => {
        setConfirmState(null)
        const { error } = await supabase.from('keyflow_inbox').delete().eq('id', msg.id)
        if (error) { toast(error.message); return }
        toast('消息已删除')
        onRefresh()
      }
    })
  }

  const unreadCount = messages.filter(m => m.type !== 'private_message' && m.status === 'unread').length

  return <div>
    <section className="panel">
      <div className="panel-head">
        <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
          <button className={`tab-btn ${tab === 'inbox' ? 'active' : ''}`} onClick={() => setTab('inbox')}>消息列表</button>
          <button className={`tab-btn ${tab === 'compose' ? 'active' : ''}`} onClick={() => setTab('compose')}>撰写私信</button>
        </div>
        {tab === 'inbox' && <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button className="outline-button compact" onClick={onRefresh}>刷新</button>
        </div>}
        {tab === 'compose' && <span className="messaging-select-count" style={{ alignSelf: 'center' }}>已选 {selectedIds.size} 人</span>}
      </div>

      {tab === 'compose' && <div className="messaging-compose-body">
        <div className="messaging-select-panel">
          <div className="messaging-search">
            <input placeholder="搜索答主名称…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="messaging-select-actions">
            <label className="messaging-select-all"><input type="checkbox" checked={selectAllChecked && filteredAnswerers.length > 0} onChange={handleSelectAll} disabled={filteredAnswerers.length === 0} /> 全选 ({filteredAnswerers.length})</label>
          </div>
          <div className="messaging-answerer-list">
            {filteredAnswerers.length ? filteredAnswerers.map(a => (
              <label key={a.id} className="messaging-answerer-item">
                <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSelect(a.id)} />
                <span className="messaging-answerer-avatar">{a.avatar_url ? <img src={a.avatar_url} alt="" /> : <span className="person-avatar">{a.zhihu_name?.[0] || '?'}</span>}</span>
                <span className="messaging-answerer-name">{a.zhihu_name}</span>
                {a.wechat_id && <span className="messaging-answerer-wechat">{a.wechat_id}</span>}
              </label>
            )) : <div className="messaging-answerer-empty">没有匹配的答主</div>}
          </div>
        </div>
        <div className="messaging-form-panel">
          <div className="field">
            <span>私信标题</span>
            <input value={composeTitle} onChange={e => setComposeTitle(e.target.value)} placeholder="输入私信标题" />
          </div>
          <div className="field">
            <span>私信内容</span>
            <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="输入私信内容…" />
          </div>
          <button className="primary messaging-send-btn" onClick={sendMessages} disabled={sending || selectedIds.size === 0}>
            {sending ? '发送中…' : `发送给 ${selectedIds.size} 位答主`}
          </button>
        </div>
      </div>}

      {tab === 'inbox' && <div className="inbox-list">
        {allMessages.length ? allMessages.map(msg => {
          const isSent = msg._type === 'sent_batch'
          const answerer = isSent ? null : answererById[msg.from_id]
          const isExpanded = expandedId === msg._key
          const request = isSent ? null : getRequestByAnswererId(msg.from_id)
          return <div key={msg._key} className={`inbox-item ${!isSent && msg.status === 'unread' ? 'unread' : ''} ${isExpanded ? 'expanded' : ''}`}>
            <div className="inbox-item-header" onClick={() => setExpandedId(isExpanded ? null : msg._key)}>
              <div className="inbox-item-left">
                <span className={`inbox-item-dot ${!isSent && msg.status === 'unread' ? 'active' : ''}`}/>
                <div>
                  <strong>
                    <span className={`pill ${isSent ? 'success' : msg.type === 'password_reset' ? 'warning' : 'muted'}`} style={{ marginRight: 6, fontSize: 11 }}>
                      {isSent ? '已发送' : msg.type === 'password_reset' ? '密码重置' : msg.type}
                    </span>
                    {msg.title}
                  </strong>
                  <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(msg.created_at))}</small>
                </div>
              </div>
              <div className="inbox-item-right">
                {isSent && <span className="inbox-item-author">{msg.recipientNames}</span>}
                {!isSent && answerer && <span className="inbox-item-author">{answerer.zhihu_name}</span>}
                <button className="inbox-delete-btn" title="删除消息" onClick={(e) => { e.stopPropagation(); handleDelete(msg) }}><Icon name="close" size={14}/></button>
                <Icon name="arrow" size={14} style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .2s' }}/>
              </div>
            </div>
            {isExpanded && <div className="inbox-item-body">
              <p>{msg.body}</p>
              {isSent && <p className="inbox-item-meta">接收人：{msg.recipientNames}</p>}
              {!isSent && msg.type === 'password_reset' && request && <div className="inbox-review-actions">
                <button className="primary compact" onClick={() => handleReview(msg, true)} disabled={reviewLoading === msg.id}>通过</button>
                <button className="outline-button compact danger" onClick={() => handleReview(msg, false)} disabled={reviewLoading === msg.id}>拒绝</button>
              </div>}
              {!isSent && msg.type === 'password_reset' && !request && <p className="inbox-review-done">此申请已处理。</p>}
            </div>}
          </div>
        }) : <div className="inbox-empty">暂无消息。</div>}
      </div>}
    </section>
  </div>
}

export default App
