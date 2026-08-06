import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabase'
import './App.css'

const ADMIN_SESSION_KEY = 'keyflow_admin_session'

const initialActivity = {
  title: '', game_name: '', description: '', rules: '', main_question: '',
  sub_questions: '[]',
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
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    eyeOff: <><path d="m3 3 18 18"/><path d="M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a18.7 18.7 0 0 1-3 3.8M6.1 6.1A18.8 18.8 0 0 0 2.5 12s3.5 6 9.5 6c1.2 0 2.3-.2 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
    ticket: <><path d="M4 4h16v4a2 2 0 1 0 0 4v4H4v-4a2 2 0 1 0 0-4V4z"/><path d="M9 4v16"/></>,  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(value)) : '未设置'
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
  const [deliveryNotes, setDeliveryNotes] = useState({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerSearch, setDrawerSearch] = useState('')
  const [editingMainQuestion, setEditingMainQuestion] = useState(false)
  const [mainQuestionDraft, setMainQuestionDraft] = useState('')
  const [editingSubIndex, setEditingSubIndex] = useState(null)
  const [subDraft, setSubDraft] = useState('')

  const selectedActivity = activities.find((item) => item.id === selectedId) || activities[0]
  const subQuestions = useMemo(() => {
    try { return JSON.parse(selectedActivity?.sub_questions || '[]') }
    catch { return [] }
  }, [selectedActivity?.sub_questions])
  const parsedKeys = useMemo(() => parseKeys(keyInput), [keyInput])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const filteredApplications = useMemo(() => applications.filter((item) => item.activity_id === selectedActivity?.id), [applications, selectedActivity])
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

  // 当前选中的活动是否已全部领Key待推进
  const currentActivityKeyReady = selectedActivity?.status === 'key_distribution' &&
    selectedCount > 0 && selectedCount === claimedCount
  const authorStats = useMemo(() => {
    const stats = {}
    applications.forEach((app) => {
      const key = app.zhihu_id || app.profile_url
      if (!key || app.activity_id === selectedActivity?.id) return
      if (!stats[key]) stats[key] = { participated: 0, completed: 0 }
      stats[key].participated++
      if (app.keyflow_deliveries?.id) stats[key].completed++
    })
    return stats
  }, [applications, selectedActivity])

  const filteredDrawerActivities = useMemo(() => {
    const keyword = drawerSearch.trim().toLowerCase()
    return keyword ? activities.filter((item) => `${item.game_name} ${item.title}`.toLowerCase().includes(keyword)) : activities
  }, [activities, drawerSearch])
  const openDrawer = () => { setDrawerSearch(''); setDrawerOpen(true) }

  const toast = (message) => { setNotice(message); window.setTimeout(() => setNotice(''), 2800) }

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

  const loadData = async () => {
    setLoading(true); setError('')
    const [activityResult, applicationResult, deliveryResult, keyResult, invitationResult, answererResult] = await Promise.all([
      supabase.from('keyflow_activities').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_applications').select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').order('submitted_at', { ascending: false }),
      supabase.from('keyflow_deliveries').select('*'),
      supabase.from('keyflow_keys').select('id, activity_id, platform, application_id, created_at, claimed_at').order('created_at', { ascending: false }),
      supabase.from('keyflow_invitation_codes').select('*').order('created_at', { ascending: false }),
      supabase.from('keyflow_answerers').select('*').order('created_at', { ascending: false }),
    ])
    const failure = activityResult.error || applicationResult.error || deliveryResult.error || keyResult.error
    if (failure) setError(failure.message)
    else {
      const rawActivities = activityResult.data || []
      const apps = applicationResult.data || []
      const { updated: afterDeadline } = autoAdvanceByDeadline(rawActivities)
      const { updated } = autoAdvanceByCondition(afterDeadline, apps)
      setActivities(updated); setApplications(apps); setDeliveries(deliveryResult.data || []); setKeys(keyResult.data || []); setInvitationCodes(invitationResult.data || []); setAnswerers(answererResult.data || [])
      setSelectedId((current) => current || updated?.[0]?.id || '')
    }
    setLoading(false)
  }

  useEffect(() => { loadData() }, [])
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
    }
    // #region debug-point C:request
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'activity-create-duplicate', runId: 'pre-fix', hypothesisId: 'C', traceId, location: 'App.jsx:createActivity', msg: '[DEBUG] 创建活动请求发送', data: { payloadHasId: Object.hasOwn(payload, 'id'), fieldNames: Object.keys(payload).sort() } }) }).catch(() => {})
    // #endregion
    const { data, error: requestError } = await supabase.from('keyflow_activities').insert(payload).select().single()
    // #region debug-point B:response
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'activity-create-duplicate', runId: 'pre-fix', hypothesisId: requestError ? 'D' : 'A', traceId, location: 'App.jsx:createActivity', msg: '[DEBUG] 创建活动请求完成', data: { id: data?.id, errorCode: requestError?.code, errorMessage: requestError?.message } }) }).catch(() => {})
    // #endregion
    if (requestError) return setError(requestError.message)
    setActivities((items) => [data, ...items]); setSelectedId(data.id); setActive('活动概览'); setActivityModal(false); setActivityForm(initialActivity); toast('活动已创建，可开始收集答主报名')
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

  const deleteApplication = async (id) => {
    if (!window.confirm('确定要删除该答主的报名信息吗？此操作不可撤销。')) return
    const { error: requestError } = await supabase.from('keyflow_applications').delete().eq('id', id)
    if (requestError) return setError(requestError.message)
    setApplications((items) => items.filter((item) => item.id !== id)); toast('报名信息已删除')
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

  const nav = [['活动看板', 'calendar'], ['活动概览', 'grid'], ['答主报名', 'users'], ['Key 管理', 'key'], ['交付验收', 'file'], ['答主管理', 'ticket']]
  const statusLabel = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatusLabel = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const activityDeliveries = deliveries.filter((item) => filteredApplications.some((application) => application.id === item.application_id))
  const pendingDeliveries = activityDeliveries.filter((item) => item.status === 'pending').length
  const approvedDeliveries = activityDeliveries.filter((item) => item.status === 'approved').length
  const revisionDeliveries = activityDeliveries.filter((item) => item.status === 'revision_required').length

  const urlParams = new URLSearchParams(window.location.search)
  const registerMode = urlParams.get('register') !== null
  if (registerMode) return <RegisterPage aid={urlParams.get('aid')} />
  const loginMode = urlParams.get('login') !== null
  if (loginMode) return <LoginPage aid={urlParams.get('aid')} />
  const partnerToken = urlParams.get('partner')
  if (partnerToken) return <PartnerPage token={partnerToken} />
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
      <nav className="nav-section"><p className="nav-label">工作台</p>{nav.map(([label, icon]) => <button key={label} className={`nav-item ${active === label ? 'active' : ''}`} onClick={() => setActive(label)}><Icon name={icon}/><span>{label}</span>{label === '活动看板' && keyReadyCount > 0 && <b className="nav-alert">{keyReadyCount}</b>}{label === '答主报名' && pendingCount > 0 && <b>{pendingCount}</b>}</button>)}</nav>
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
        <div className="page-title"><div><p className="eyebrow">真实数据工作台</p><h1>{active}{active !== '活动看板' && selectedActivity?.game_name && <><span className="title-divider">|</span>{selectedActivity.game_name}</>}</h1><p className="subtitle">活动、报名、Key 与交付数据均实时保存至 Supabase。</p></div>{active === '答主报名' ? <div style={{ display: 'flex', gap: 'var(--sp-2)' }}><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button></div> : <button className="primary" onClick={() => setActivityModal(true)}><Icon name="plus"/> 创建活动</button>}</div>
        {error && <div className="error-box">数据操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {loading ? <div className="empty-state">正在加载活动数据…</div> : active === '活动概览' && !selectedActivity ? <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建第一个测评活动</h2><p>创建后即可收集答主报名、导入 Key 并进行交付验收。</p><button className="primary" onClick={() => setActivityModal(true)}><Icon name="plus"/> 创建活动</button></div> : active === '活动概览' ? <>
          <section className="activity-picker"><button className="current-activity" onClick={openDrawer}><span>当前活动</span><strong>{selectedActivity.title}</strong><Icon name="arrow" size={14}/></button><div className="activity-picker-right"><span className={`activity-status ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span><button className="outline-button" onClick={() => { navigator.clipboard.writeText(partnerLink); toast('合作方页面链接已复制') }}>复制合作方链接</button><button className="outline-button preview-partner-btn" onClick={() => window.open(partnerLink, '_blank')}>预览合作方页</button><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button><button className="outline-button" onClick={() => setApplicationModal(true)}><Icon name="plus" size={16}/> 新增报名</button></div></section>
          <section className="hero-card real-hero"><div className="hero-top"><div><span className="live-dot"/> <span className={`stage-badge ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span> <span className="divider">|</span> <span className={currentActivityKeyReady ? 'text-alert-flash' : ''}>{getStatusTimeText(selectedActivity, filteredApplications)}</span></div><button className="edit-button" onClick={openEditActivity}><Icon name="edit" size={15}/> 编辑</button></div><div className="game-info"><div className="game-cover">{selectedActivity.game_cover ? <img src={selectedActivity.game_cover} alt={selectedActivity.game_name}/> : <span>{selectedActivity.game_name[0]}</span>}</div><div><p className="game-type">{selectedActivity.game_name}</p><h2>{selectedActivity.title}</h2><p>{selectedActivity.description || '尚未填写游戏简介。'}</p><p className="review-requirement">{selectedActivity.review_requirement || '测评要求：图文并茂，生动有趣'}</p></div></div><div className="rules-row main-question-row"><strong>测评主问题</strong>{editingMainQuestion ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={mainQuestionDraft} onChange={(e) => setMainQuestionDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={saveMainQuestion}>保存</button><button className="inline-cancel" onClick={() => { setEditingMainQuestion(false) }}>取消</button></div></div> : <div className="inline-display"><span>{selectedActivity.main_question || '尚未设置'}</span><button className="inline-edit-btn" title="编辑主问题" onClick={() => { setMainQuestionDraft(selectedActivity.main_question || ''); setEditingMainQuestion(true) }}><Icon name="edit" size={14}/></button></div>}</div>{subQuestions.map((q, i) => <div className="rules-row sub-question-row" key={i}><strong>相关问题 {i + 1}</strong>{editingSubIndex === i ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={subDraft} onChange={(e) => setSubDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={() => saveSubQuestion(i)}>保存</button><button className="inline-cancel" onClick={() => setEditingSubIndex(null)}>取消</button></div></div> : <div className="inline-display"><span>{q || '空问题'}</span><button className="inline-edit-btn" title="编辑相关问题" onClick={() => { setSubDraft(q); setEditingSubIndex(i) }}><Icon name="edit" size={14}/></button><button className="inline-delete-btn" title="删除相关问题" onClick={() => deleteSubQuestion(i)}><Icon name="close" size={14}/></button></div>}</div>)}<button className="add-sub-btn" onClick={addSubQuestion}><Icon name="plus" size={14}/> 新增相关问题</button></section>
          <section className="metrics">{[[filteredApplications.length,'报名答主','全部报名','答主报名'],[selectedCount,'已入选',`目标 ${selectedActivity.target_authors} 人`,'答主报名'],[claimedCount,'已领取 Key',`${selectedCount - claimedCount}/${selectedCount} 人 未领取key`,'Key 管理'],[deliveredCount,'已提交交付',`${selectedCount - deliveredCount}/${selectedCount} 人未交付`,'交付验收']].map(([number,label,note,target]) => <div className="metric clickable" key={label} onClick={() => setActive(target)}><strong>{number}</strong><span>{label}</span><small>{note}</small></div>)}</section>
          <section className="panel applicants-panel"><div className="panel-head"><div><h3>答主报名</h3><p>查看答主报名、Key 领取和内容提交状态。</p></div><button className="primary compact" onClick={() => setApplicationModal(true)}><Icon name="plus" size={15}/> 新增报名</button></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>查看主页</th><th>入选状态</th><th>是否领取 Key</th><th>是否提交内容</th><th>操作</th></tr></thead><tbody>{filteredApplications.length ? filteredApplications.map((person) => <tr key={person.id}><td><div className="person"><span className="person-avatar">{person.zhihu_name[0]}</span><div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td><span className={`pill ${person.keyflow_keys?.claimed_at ? 'success' : 'muted'}`}>{person.keyflow_keys?.claimed_at ? '已领取' : '未领取'}</span></td><td><button className={`pill pill-link ${person.keyflow_deliveries?.id ? 'success' : 'muted'}`} onClick={() => setActive('交付验收')}>{person.keyflow_deliveries?.id ? '已提交' : '未提交'}</button></td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => reviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => reviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" disabled={!!person.keyflow_keys?.claimed_at} onClick={() => reviewApplication(person.id, 'pending')}>重新筛选</button>}</div></td></tr>) : <tr><td colSpan="6" className="table-empty">还没有报名记录。可添加测试报名，或后续将表单公开给答主填写。</td></tr>}</tbody></table></div></section>
          <section className="stage-progression"><div className="stage-header"><div><h3>阶段推进</h3><span>截止时间到期或全部交稿后自动推进，全部领Key后可手动点击「推进」</span></div><button className="outline-button stage-reset-btn" onClick={resetStage}>重置阶段</button></div><div className="stage-timeline">{STAGES.map((stage, i) => { const currentIdx = STAGES.indexOf(selectedActivity?.status || 'recruiting'); const isCurrent = i === currentIdx; const isPast = i < currentIdx; const isNext = i === currentIdx + 1; const trigger = STAGE_TRIGGER[stage] ? STAGE_TRIGGER[stage](selectedActivity) : ''; return <div key={stage} className={`stage-node ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''} ${isNext ? 'next' : ''}`}><button className="stage-dot-btn" disabled={i !== currentIdx + 1} onClick={i === currentIdx + 1 ? advanceStage : undefined}><span className="stage-dot"/></button><span className="stage-label">{STAGE_LABEL[stage]}</span>{isNext ? <button className={`stage-action ${currentActivityKeyReady ? 'pulse' : ''}`} onClick={advanceStage} disabled={advancing}>{advancing ? '...' : '推进'}</button> : i > currentIdx ? <span className="stage-action muted">推进</span> : isCurrent && i > 0 && i < STAGES.length - 1 ? <><span className="stage-action manual-advance disabled">...</span><span className="stage-action current-hint">{trigger}</span></> : isCurrent && i === 0 ? <span className="stage-action current-hint">{trigger}</span> : isPast ? <span className="stage-action"><Icon name="check" size={12}/></span> : null}</div> })}</div></section>
        </> : active === '活动看板' ? <div className="activity-cards">{activities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); const creatingCount = apps.filter(a => a.status === 'selected' && a.keyflow_keys?.claimed_at).length; const deliveredCount = apps.filter(a => a.keyflow_deliveries?.id).length; const isKeyReady = item.status === 'key_distribution' && apps.filter(a => a.status === 'selected').length > 0 && apps.filter(a => a.status === 'selected').every(a => a.keyflow_keys?.claimed_at); return <div key={item.id} className={`activity-card ${item.id === selectedId ? 'selected' : ''} ${isKeyReady ? 'alert' : ''}`} onClick={() => { setSelectedId(item.id); setActive('活动概览') }}><div className="activity-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="activity-card-body"><p className="activity-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="activity-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{item.status === 'delivery' ? `${creatingCount} 人创作中` : item.status === 'completed' ? `${deliveredCount} 篇作品` : `${apps.length} 报名`}</span></div><small>{getStatusTimeText(item, apps)}</small></div></div> })}</div> : active === '答主报名' ? <ApplicationsPage activity={selectedActivity} applications={filteredApplications} authorStats={authorStats} statusLabel={statusLabel} onSelectActivity={openDrawer} onAddApplication={() => setApplicationModal(true)} onReviewApplication={reviewApplication} onDeleteApplication={deleteApplication} /> : active === 'Key 管理' ? <KeyManagement activity={selectedActivity} input={keyInput} parsedKeys={parsedKeys} platformCounts={platformCounts} importedKeys={keys.filter((item) => item.activity_id === selectedActivity?.id)} importing={keyImporting} onInput={setKeyInput} onImport={importKeys} onSelectActivity={openDrawer} applications={filteredApplications}/> : active === '交付验收' ? <DeliveriesPage activity={selectedActivity} deliveries={activityDeliveries} applications={filteredApplications} statusLabel={deliveryStatusLabel} notes={deliveryNotes} onNoteChange={(id, value) => setDeliveryNotes((items) => ({ ...items, [id]: value }))} onReview={reviewDelivery} onSelectActivity={openDrawer} pendingCount={pendingDeliveries} approvedCount={approvedDeliveries} revisionCount={revisionDeliveries} /> : active === '答主管理' ? <AnswererManagement codes={invitationCodes} answerers={answerers} activities={activities} applications={applications} onRefresh={loadData} /> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>{active}即将开放</h2><p>请先完成活动与答主报名管理。</p></div>}
      </section>
    </main>
    {drawerOpen && <div className="drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><h2>切换活动</h2><button onClick={() => setDrawerOpen(false)}><Icon name="close"/></button></header><div className="drawer-search"><Icon name="grid" size={16}/><input placeholder="搜索活动名称或游戏名…" value={drawerSearch} onChange={(event) => setDrawerSearch(event.target.value)} autoFocus/></div><div className="drawer-list">{filteredDrawerActivities.length ? filteredDrawerActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); return <div key={item.id} className={`drawer-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDrawerOpen(false) }}><div className="drawer-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="drawer-card-body"><p className="drawer-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="drawer-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{apps.length} 报名</span></div></div></div> }) : <div className="drawer-empty">没有匹配的活动</div>}</div></aside></div>}
    {activityModal && <Modal title="创建测评活动" onClose={() => setActivityModal(false)}><form onSubmit={createActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><Field label="报名截止时间" type="datetime-local" value={activityForm.application_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><Field label="交付截止时间" type="datetime-local" value={activityForm.delivery_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，生动有趣'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/>{activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}<button className="primary form-submit">保存并创建</button></form></Modal>}
    {applicationModal && <Modal title="新增答主报名" onClose={() => setApplicationModal(false)}><form onSubmit={createApplication} className="form-grid"><Field label="知乎 ID（可选，用于防重复）" value={applicationForm.zhihu_id} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_id: value })} placeholder="知乎 OAuth 返回的用户 ID"/><Field label="知乎名称" required value={applicationForm.zhihu_name} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_name: value })}/><Field label="微信名" required value={applicationForm.wechat_name} onChange={(value) => setApplicationForm({ ...applicationForm, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={applicationForm.profile_url} onChange={(value) => setApplicationForm({ ...applicationForm, profile_url: value })}/><Field label="预计完成字数" type="number" required value={applicationForm.expected_word_count} onChange={(value) => setApplicationForm({ ...applicationForm, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setApplicationForm({ ...applicationForm, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span><button className="primary form-submit">保存报名</button></form></Modal>}
    {editActivityModal && <Modal title="编辑活动" onClose={() => setEditActivityModal(false)}><form onSubmit={updateActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><Field label="报名截止时间" type="datetime-local" value={activityForm.application_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><Field label="交付截止时间" type="datetime-local" value={activityForm.delivery_deadline || ''} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，生动有趣'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/>{activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}<button className="primary form-submit">保存修改</button></form></Modal>}
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

  const toggleRecommend = async (applicationId) => {
    const { error: requestError } = await supabase.rpc('keyflow_partner_toggle_recommend', { p_partner_token: token, p_application_id: applicationId })
    if (requestError) return setError(requestError.message)
    await loadSnapshot()
  }

  if (!snapshot && !error) return <div className="partner-page"><div className="partner-loading">正在加载活动协作页…</div></div>
  if (!snapshot) return <div className="partner-page"><div className="partner-loading">{error || '该合作方页面不存在或已失效。'}</div></div>

  const { activity, applications, deliveries, key_count: keyCount } = snapshot
  const selectedCount = applications.filter((item) => item.status === 'selected').length
  const applicationStatus = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatus = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }

  return <div className="partner-page"><header className="partner-header"><div className="partner-brand"><span className="brand-mark">G</span><span>GameJourney</span><small>合作方协作页</small></div><button className="reload" onClick={loadSnapshot}>刷新数据</button></header><main className="partner-main"><section className="partner-hero"><div className="partner-hero-content"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>在此补充活动 Key，并实时查看报名与交稿进展。</span><div><span>报名截止 {formatDate(activity.application_deadline)}</span><span>交付截止 {formatDate(activity.delivery_deadline)}</span></div></div>{activity.game_cover && <div className="partner-hero-art" aria-hidden="true"><img src={activity.game_cover} alt="" /></div>}</section>{error && <div className="error-box">操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}<section className="partner-metrics"><div><strong>{keyCount}</strong><span>已入库 Key</span></div><div><strong>{applications.length}</strong><span>累计报名</span></div><div><strong>{selectedCount}</strong><span>已入选答主</span></div><div><strong>{deliveries.length}</strong><span>已交稿</span></div></section><section className="partner-grid"><section className="panel partner-key-panel"><div className="panel-head"><div><h3>添加 Key</h3><p>每行一个，也支持逗号、分号和制表符分隔；平台将自动识别。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>{parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div></div>}<div className="key-import-footer"><span>重复 Key 将自动跳过，Key 明文不会展示在数据列表中。</span><button className="primary" onClick={importKeys} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section><section className="panel partner-progress"><div className="panel-head"><div><h3>进度说明</h3><p>活动数据由运营方维护，以下信息会实时更新。</p></div></div><div className="progress-list"><div><Icon name="users"/><span>报名情况</span><strong>{applications.length} 人</strong></div><div><Icon name="check"/><span>入选答主</span><strong>{selectedCount} 人</strong></div><div><Icon name="file"/><span>交稿情况</span><strong>{deliveries.length} 篇</strong></div></div><a className="partner-apply-link" href={window.location.origin + window.location.pathname + '?apply=' + activity.id}>点击进入答主报名页面</a></section></section><section className="panel partner-table"><div className="panel-head"><div><h3>报名情况</h3><p>展示答主信息，合作方可标记推荐人选。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>知乎主页</th><th>字数预估</th><th>推荐入选</th><th>报名时间</th><th>状态</th></tr></thead><tbody>{applications.length ? applications.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td><span className="person-name">{item.zhihu_name}</span></td><td><a className="profile-link" href={item.profile_url} target="_blank" rel="noreferrer">查看主页 <Icon name="arrow" size={13}/></a></td><td>{item.expected_word_count ? `${item.expected_word_count.toLocaleString()} 字` : '—'}</td><td><button className={`recommend-toggle ${item.partner_recommended ? 'active' : ''}`} onClick={() => toggleRecommend(item.id)} title={item.partner_recommended ? '取消推荐' : '推荐入选'}>{item.partner_recommended ? '已推荐' : '推荐'}</button></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'selected' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{applicationStatus[item.status]}</span></td></tr>) : <tr><td colSpan="6" className="table-empty">暂无报名记录。</td></tr>}</tbody></table></div></section><section className="panel partner-table"><div className="panel-head"><div><h3>交稿情况</h3><p>合作方可查看已提交作品的审核进度。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>交稿时间</th><th>审核状态</th><th>作品</th></tr></thead><tbody>{deliveries.length ? deliveries.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td>{item.zhihu_name}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{deliveryStatus[item.status]}</span></td><td><a className="profile-link" href={item.article_url} target="_blank" rel="noreferrer">查看作品</a></td></tr>) : <tr><td colSpan="4" className="table-empty">暂无交稿记录。</td></tr>}</tbody></table></div></section></main>{notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}</div>
}

function KeyManagement({ activity, input, parsedKeys, platformCounts, importedKeys, importing, onInput, onImport, onSelectActivity, applications }) {
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
  }
  const applicantByAppId = useMemo(() => Object.fromEntries((applications || []).map((app) => [app.id, app.zhihu_name])), [applications])

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可批量导入游戏 Key。</p></div>

  const availableCount = importedKeys.filter((item) => !item.application_id).length
  const toggleKeyVisibility = async (id) => {
    if (revealedKeys[id]) return setRevealedKeys((items) => ({ ...items, [id]: '' }))
    setRevealingKeyId(id)
    const { data, error } = await supabase.rpc('keyflow_reveal_key', { p_key_id: id })
    setRevealingKeyId('')
    if (!error) setRevealedKeys((items) => ({ ...items, [id]: data }))
  }

  return <div className="key-management">
    <section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section>
    <section className="key-stats">{[[importedKeys.length, '已入库'], [availableCount, '待领取'], [importedKeys.length - availableCount, '已领取']].map(([count, label]) => <div className="key-stat" key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel key-import-panel"><div className="panel-head"><div><h3>批量导入 Key</h3><p>每行一个 Key，也支持逗号、分号或制表符分隔。系统会自动去重并识别平台。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => onInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP\nABCD-EFGH-IJKL\nABCDEFGHIJKL'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>共 {parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div><div className="key-preview-list">{parsedKeys.slice(0, 8).map(({ key_value, platform }) => <div key={key_value}><code>{key_value}</code><span className={`platform-tag ${platform}`}>{platformLabel[platform]}</span></div>)}{parsedKeys.length > 8 && <p>另有 {parsedKeys.length - 8} 个 Key 将一并导入</p>}</div></div>}<div className="key-import-footer"><span>未识别的格式会标记为「未识别」，仍可入库供后续处理。</span><button className="primary" onClick={onImport} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section>
          <section className="panel key-inventory"><div className="panel-head"><div><h3>库存概览</h3><p>点击眼睛图标按需查看 Key 明文。</p></div><button className="outline-button" onClick={handleExportExcel} disabled={exporting}>{exporting ? '导出中…' : '下载Excel'}</button></div><div className="table-wrap"><table><thead><tr><th>Key</th><th>显示key</th><th>平台</th><th>状态</th><th>领取人</th><th>入库时间</th><th>领取时间</th></tr></thead><tbody>{importedKeys.length ? importedKeys.slice(0, 20).map((item) => <tr key={item.id}><td><code className="inventory-key">{revealedKeys[item.id] || '••••••••••••••••'}</code></td><td><button className="key-visibility-button" onClick={() => toggleKeyVisibility(item.id)} disabled={revealingKeyId === item.id} aria-label={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'} title={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'}><Icon name={revealedKeys[item.id] ? 'eyeOff' : 'eye'} size={17}/></button></td><td><span className={`platform-tag ${item.platform}`}>{platformLabel[item.platform] || '未识别'}</span></td><td><span className={`pill ${item.application_id ? 'success' : 'warning'}`}>{item.application_id ? '已领取' : '待领取'}</span></td><td>{item.application_id ? applicantByAppId[item.application_id] || '/' : '/'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td><td>{item.claimed_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.claimed_at)) : '/'}</td></tr>) : <tr><td colSpan="7" className="table-empty">当前活动尚未导入 Key。</td></tr>}</tbody></table></div></section>
  </div>
}

function ApplicationsPage({ activity, applications, authorStats, statusLabel, onSelectActivity, onAddApplication, onReviewApplication, onDeleteApplication }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [sortBy, setSortBy] = useState('submitted_at')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const visibleApplications = useMemo(() => applications.filter((person) => (statusFilter === 'all' || person.status === statusFilter) && `${person.zhihu_name} ${person.wechat_name}`.toLowerCase().includes(keyword.trim().toLowerCase())).sort((a, b) => sortBy === 'expected_word_count' ? b.expected_word_count - a.expected_word_count : new Date(b.submitted_at) - new Date(a.submitted_at)), [applications, keyword, sortBy, statusFilter])

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可收集和筛选答主报名。</p></div>

  const statusCounts = { all: applications.length, pending: applications.filter((person) => person.status === 'pending').length, selected: applications.filter((person) => person.status === 'selected').length, rejected: applications.filter((person) => person.status === 'rejected').length }
  const filters = [['all', '全部'], ['pending', '待筛选'], ['selected', '已入选'], ['rejected', '未入选']]
  const toggleSelect = (id) => setSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleSelectAll = () => setSelectedIds((prev) => prev.size === visibleApplications.length && visibleApplications.every((p) => prev.has(p.id)) ? new Set() : new Set(visibleApplications.map((p) => p.id)))
  const batchReview = async (status) => { for (const id of selectedIds) await onReviewApplication(id, status); setSelectedIds(new Set()) }

  return <section className="applications-workspace">
    <section className="activity-picker">
      <button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button>
    </section>
    <section className="application-summary">{[[applications.length, '累计报名'], [statusCounts.pending, '待筛选'], [`${statusCounts.selected} / ${activity.target_authors}`, '已入选 / 目标人数']].map(([count, label]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel applications-panel">
      <div className="application-toolbar"><div className="application-filters">{filters.map(([value, label]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>{label}<b>{statusCounts[value]}</b></button>)}</div><div className="application-controls"><input aria-label="搜索答主" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索知乎名或微信名"/><select aria-label="排序方式" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="submitted_at">按报名时间</option><option value="expected_word_count">按预计字数</option></select></div></div>
      {selectedIds.size > 0 && <div className="batch-actions"><span>已选 <strong>{selectedIds.size}</strong> 项</span><button className="select-action" onClick={() => batchReview('selected')}>批量入选</button><button className="reject-action" onClick={() => batchReview('rejected')}>批量不选</button><button className="reset-action" onClick={() => setSelectedIds(new Set())}>取消选择</button></div>}
      <div className="table-wrap"><table className="applications-table"><thead><tr><th><input type="checkbox" checked={visibleApplications.length > 0 && visibleApplications.every((p) => selectedIds.has(p.id))} onChange={toggleSelectAll}/></th><th>答主</th><th>知乎主页</th><th>微信名</th><th>预计字数</th><th>报名时间</th><th>历史参加活动</th><th>历史完成活动</th><th>延迟提交</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleApplications.length ? visibleApplications.map((person) => { const history = authorStats[person.zhihu_id || person.profile_url] || { participated: 0, completed: 0 }; return <tr key={person.id}><td><input type="checkbox" checked={selectedIds.has(person.id)} onChange={() => toggleSelect(person.id)}/></td><td><div className="person"><span className="person-avatar">{person.zhihu_name[0]}</span><div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td>{person.wechat_name}</td><td><span className="word-count">{person.expected_word_count.toLocaleString()} 字</span></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(person.submitted_at))}</td><td><span className="history-count">{history.participated} <small>次</small></span></td><td><span className={`history-count ${history.participated !== history.completed ? 'highlight-red' : ''}`}>{history.completed} <small>次</small></span></td><td><span className={`history-count ${person.delayed_count > 0 ? 'highlight-red' : ''}`}>{person.delayed_count} <small>次</small></span></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => onReviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => onReviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" onClick={() => onReviewApplication(person.id, 'pending')}>重新筛选</button>}<button className="delete-action" onClick={() => onDeleteApplication(person.id)}>删除</button></div></td></tr> }) : <tr><td colSpan="11" className="table-empty">没有符合条件的报名记录。</td></tr>}</tbody></table></div>
    </section>
  </section>
}

function DeliveriesPage({ activity, deliveries, applications, statusLabel, notes, onNoteChange, onReview, onSelectActivity, pendingCount, approvedCount, revisionCount }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const applicationById = useMemo(() => Object.fromEntries(applications.map((item) => [item.id, item])), [applications])
  const [keyword, setKeyword] = useState('')
  const deliveryWithAuthor = useMemo(() => deliveries.map((item) => ({ ...applicationById[item.application_id], ...item })), [deliveries, applicationById])
  const visibleDeliveries = useMemo(() => deliveryWithAuthor.filter((item) => (statusFilter === 'all' || item.status === statusFilter) && `${item.zhihu_name} ${item.article_url}`.toLowerCase().includes(keyword.trim().toLowerCase())), [deliveryWithAuthor, keyword, statusFilter])
  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动并收到答主交稿后，即可进行交付验收。</p></div>
  const filters = [['all', '全部', deliveries.length], ['pending', '待审核', pendingCount], ['approved', '已通过', approvedCount], ['revision_required', '需修改', revisionCount], ['rejected', '未通过', deliveries.filter((item) => item.status === 'rejected').length]]
  return <div className="delivery-workspace"><section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section><section className="delivery-stats"><div><strong>{deliveries.length}</strong><span>已提交</span></div><div><strong>{pendingCount}</strong><span>待审核</span></div><div><strong>{approvedCount}</strong><span>已通过</span></div><div><strong>{revisionCount}</strong><span>需修改</span></div></section><section className="panel"><div className="panel-head"><div><h3>交付验收</h3><p>核对作品链接与实际字数，保存审核结论后会同步展示给答主。</p></div></div><div className="delivery-toolbar"><div className="acceptance-filters">{filters.map(([value, label, count]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}><span>{label}</span><b>{count}</b></button>)}</div><input aria-label="搜索交付" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索答主或作品链接"/></div><div className="table-wrap"><table className="deliveries-table"><thead><tr><th>答主</th><th>作品</th><th>提交时间</th><th>字数</th><th>审核备注</th><th>状态</th><th>验收操作</th></tr></thead><tbody>{visibleDeliveries.length ? visibleDeliveries.map((item) => <tr key={item.id}><td><div className="person"><span className="person-avatar">{item.zhihu_name?.[0] || '答'}</span><div><strong>{item.zhihu_name || '答主'}</strong><small>{item.wechat_name || '已交稿'}</small></div></div></td><td><a className="profile-link" href={item.article_url} target="_blank" rel="noreferrer">查看作品 <Icon name="arrow" size={13}/></a></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at))}</td><td>{item.verified_word_count || item.claimed_word_count ? `${(item.verified_word_count || item.claimed_word_count).toLocaleString()} 字` : '待核对'}</td><td><input className="delivery-note" value={notes[item.id] ?? item.reviewer_note ?? ''} onChange={(event) => onNoteChange(item.id, event.target.value)} placeholder="填写审核意见"/></td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' || item.status === 'revision_required' ? 'warning' : 'muted'}`}>{statusLabel[item.status]}</span></td><td className="review-actions"><button className="select-action" onClick={() => onReview(item, 'approved')}>通过</button><button className="reset-action" onClick={() => onReview(item, 'revision_required')}>需修改</button><button className="reject-action" onClick={() => onReview(item, 'rejected')}>不通过</button></td></tr>) : <tr><td colSpan="7" className="table-empty">没有符合条件的交付记录。</td></tr>}</tbody></table></div></section></div>
}

function Field({ label, textarea, wide, onChange, onBlur, ...props }) { return <label className={`field ${wide ? 'field-wide' : ''}`}><span>{label}</span>{textarea ? <textarea onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/> : <input onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/>}</label> }
function Modal({ title, children, onClose }) { return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><header><h2>{title}</h2><button onClick={onClose}><Icon name="close"/></button></header>{children}</section></div> }

const SESSION_KEY = 'keyflow_answerer_session'
function getAnswererSession() {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null } catch { return null }
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
  const storageKey = `claim_${activityId}`
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  useEffect(() => {
    const init = async () => {
      const { data: act, error: actErr } = await supabase.from('keyflow_activities').select('*').eq('id', activityId).single()
      if (actErr) { setError('该申领页不存在或已失效。'); setLoading(false); return }
      setActivity(act)

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
      setLoading(false)
    }
    init()
  }, [activityId, authCode])

  const submitApplication = async (event) => {
    event.preventDefault(); setError('')
    const curAnswerer = answerer || getAnswererSession()
    if (curAnswerer) {
      // 已登录答主：直接创建报名（无需邀请码）
      setRegistering(true)
      const payload = {
        activity_id: activityId,
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
    <div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主游戏KEY申领</span></div>
    <div className="public-hero"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>{activity.description || '填写以下信息参与本次游戏测评。'}</span></div>
    <div className="public-requirement">{activity.review_requirement || '测评要求：图文并茂，生动有趣'}</div>
    <section className="public-info"><strong>测评主问题</strong><p>{activity.main_question ? renderTextWithLinks(activity.main_question) : '暂无，待后续更新'}</p>{subQuestions.filter(q => q.trim()).length > 0 && <div className="public-sub-questions"><strong>相关问题</strong>{subQuestions.filter(q => q.trim()).map((q, i) => <p key={i} className="public-sub-q">{renderTextWithLinks(q)}</p>)}</div>}<div className="info-deadlines"><small>报名截止：<strong>{formatDate(activity.application_deadline)}</strong></small><div className="reply-deadline"><span>回稿时间：</span><strong>{activity.delivery_deadline ? `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(activity.delivery_deadline))} 前` : '待设置'}</strong></div></div></section>

    <div className="stepper">{stepLabels.map((label, i) => <div key={i} className={`step ${stepStates[i]}`}><div className="step-circle">{stepStates[i] === 'done' ? <Icon name="check" size={14}/> : stepStates[i] === 'waiting' ? <Icon name="clock" size={14}/> : i + 1}</div><span className="step-label">{label}</span></div>)}</div>

    <div className="step-body">
      {!hasApp && !answerer && (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="users" size={24}/></div>
          <p>请先注册或登录</p>
          <span>注册答主账号后方可报名参与活动。</span>
          <div style={{ display: 'flex', gap: 'var(--sp-3)', justifyContent: 'center', marginTop: 'var(--sp-4)' }}>
            <a href={`?register&aid=${activityId}`} className="primary" style={{ textDecoration: 'none' }}>注册答主</a>
            <a href={`?login&aid=${activityId}`} className="outline-button" style={{ textDecoration: 'none' }}>已有账号？登录</a>
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

      {hasKey && !hasDelivery && <div className="step-delivery"><div className="key-display"><div className="key-label">你的游戏 Key</div><div className="key-value">{claimedKey.key_value}</div><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimedKey.key_value); toast('Key 已复制') }}>复制 Key</button></div><form className="delivery-form" onSubmit={submitDelivery}><h2>提交作品链接</h2><Field label="知乎回答地址" type="url" required value={articleUrl} placeholder="https://www.zhihu.com/question/.../answer/..." onChange={(value) => setArticleUrl(value)}/>{activity.main_question && <a href={activity.main_question} target="_blank" rel="noreferrer">跳转游戏相关问题</a>}{error && <p className="public-error">{error}</p>}<button className="primary public-submit" disabled={submitting}>{submitting ? '提交中…' : '提交作品'}</button></form></div>}

      {hasDelivery && <div className="step-message"><div className="step-message-icon done"><Icon name="check" size={24}/></div><p>作品已提交</p><span>{delivery.status === 'approved' ? '审核通过，感谢参与！' : delivery.status === 'revision_required' ? '需要修改，请查看运营方通知' : '等待运营方审核中…'}</span>{claimedKey && <div className="key-display compact"><div className="key-label">你的 Key</div><div className="key-value">{claimedKey.key_value}</div></div>}</div>}
    </div>

    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </main></div>
}

function RegisterPage({ aid }) {
  const [form, setForm] = useState({ invitation_code: '', zhihu_name: '', account_address: '', wechat_id: '', password: '', confirm_password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  const handleRegister = async (event) => {
    event.preventDefault(); setError('')
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
    if (rpcErr) { setError(rpcErr.message); return }
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    toast('注册成功')
    window.setTimeout(() => {
      if (aid) window.location.href = `?apply=${aid}`
      else window.location.href = '/'
    }, 800)
  }

  return <div className="register-page-wrapper">
    <div className="register-card">
      <div className="register-banner">
        <div className="register-banner-bg" />
        <div className="register-banner-content">
          <span className="brand-mark zhihu-mark">知</span>
          <h1>加入答主计划</h1>
          <p>成为 GameJourney 认证答主，抢先体验最新游戏，用你的文字影响千万玩家。</p>
        </div>
      </div>
      <form className="register-form" onSubmit={handleRegister}>
        <h2>创建账号</h2>
        <p className="register-form-sub">邀请码为平台通用凭证，由知乎运营提供，每个邀请码仅可使用一次。</p>
        <div className="register-fields">
          <label className="register-field">
            <span>邀请码（联系知乎运营获得）<em>*</em></span>
            <input required value={form.invitation_code} placeholder="KF-XXXXXXXX" onChange={(e) => setForm({ ...form, invitation_code: e.target.value })} />
          </label>
          <label className="register-field">
            <span>知乎用户名<em>*</em></span>
            <input required value={form.zhihu_name} placeholder="你的知乎昵称" onChange={(e) => setForm({ ...form, zhihu_name: e.target.value })} />
          </label>
          <label className="register-field">
            <span>知乎主页地址<em>*</em></span>
            <input type="url" required value={form.account_address} placeholder="https://www.zhihu.com/people/xxxxxx" onChange={(e) => setForm({ ...form, account_address: e.target.value })} />
          </label>
          <label className="register-field">
            <span>微信号<em>*</em></span>
            <input required value={form.wechat_id} placeholder="微信号即你的微信唯一ID，不是微信名" onChange={(e) => setForm({ ...form, wechat_id: e.target.value })} />
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
        {error && <p className="register-error">{error}</p>}
        <button className="register-submit-btn" disabled={loading}>{loading ? '注册中…' : '注册'}</button>
        <p className="register-login-link">已有账号？<a href={`?login${aid ? `&aid=${aid}` : ''}`}>去登录</a></p>
      </form>
    </div>
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

function LoginPage({ aid }) {
  const [form, setForm] = useState({ zhihu_name: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    if (aid) window.location.href = `?apply=${aid}`
    else window.location.href = '/'
  }

  return <div className="public-page"><main className="public-card" style={{ maxWidth: '440px' }}>
    <div className="public-brand"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主登录</span></div>
    <div className="public-hero"><h1>登录</h1><span>使用已注册的知乎用户名和密码登录。</span></div>
    <form className="public-form" onSubmit={handleLogin}>
      <Field label="知乎用户名" required value={form.zhihu_name} placeholder="输入注册时的知乎用户名" onChange={(value) => setForm({ ...form, zhihu_name: value })} />
      <Field label="密码" type="password" required value={form.password} placeholder="输入密码" onChange={(value) => setForm({ ...form, password: value })} />
      {error && <p className="public-error">{error}</p>}
      <button className="primary public-submit" disabled={loading}>{loading ? '登录中…' : '登录'}</button>
      <p style={{ textAlign: 'center', marginTop: 'var(--sp-4)', fontSize: 'var(--fs-sm)' }}>
        还没有账号？<a href={`?register${aid ? `&aid=${aid}` : ''}`}>去注册</a>
      </p>
    </form>
  </main></div>
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
    window.location.reload()
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

function AnswererManagement({ codes, answerers, activities, applications, onRefresh }) {
  const [count, setCount] = useState(5)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }
  const applicantByAppId = useMemo(() => Object.fromEntries(applications.map((app) => [app.id, app.zhihu_name])), [applications])
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])

  const generate = async () => {
    setGenerating(true)
    const { error } = await supabase.rpc('keyflow_generate_invitation_codes', { p_count: count })
    setGenerating(false)
    if (error) return
    await onRefresh()
    toast(`已生成 ${count} 个邀请码`)
  }

  const copyCode = (code) => { navigator.clipboard.writeText(code); toast('邀请码已复制') }
  const copyAllUnused = () => {
    const unused = codes.filter(c => !c.application_id && !c.answerer_id).map(c => c.code).join('\n')
    if (!unused) { toast('没有未使用的邀请码'); return }
    navigator.clipboard.writeText(unused)
    toast(`已复制 ${codes.filter(c => !c.application_id && !c.answerer_id).length} 个未使用邀请码`)
  }

  const unusedCount = codes.filter(c => !c.application_id && !c.answerer_id).length
  const usedCount = codes.filter(c => c.application_id || c.answerer_id).length

  const getCodeUser = (c) => {
    if (c.answerer_id && answererById[c.answerer_id]) return answererById[c.answerer_id].zhihu_name
    if (c.application_id && applicantByAppId[c.application_id]) return applicantByAppId[c.application_id]
    return null
  }

  return <div>
    <section className="panel inv-codes-panel">
      <div className="panel-head"><div><h3>邀请码管理</h3><p>邀请码为平台通用凭证，不绑定具体游戏活动。每个邀请码仅可使用一次。</p></div></div>
      <div className="inv-codes-header">
        <div className="key-stats inv-stats">{[{value: codes.length, label: '总邀请码'}, {value: unusedCount, label: '未使用'}, {value: usedCount, label: '已使用'}].map(({value, label}) => <div className="key-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
        <div className="inv-gen-row">
          <div className="inv-count-input"><span>数量</span><input type="number" min="1" max="100" value={count} onChange={e => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></div>
          <button className="primary compact" onClick={generate} disabled={generating}>{generating ? '生成中…' : `生成 ${count} 个`}</button>
          {unusedCount > 0 && <button className="outline-button compact" onClick={copyAllUnused}>复制全部未使用</button>}
        </div>
      </div>
      <div className="table-wrap"><table><thead><tr><th>邀请码</th><th>状态</th><th>绑定用户</th><th>生成时间</th></tr></thead><tbody>{codes.length ? codes.slice(0, 30).map((c) => <tr key={c.id}><td><code className={`invite-code ${c.application_id || c.answerer_id ? 'used' : ''}`} onClick={() => !c.application_id && !c.answerer_id && copyCode(c.code)} title={c.application_id || c.answerer_id ? '已使用' : '点击复制'}>{c.code}</code></td><td><span className={`pill ${c.application_id || c.answerer_id ? 'success' : 'warning'}`}>{c.application_id || c.answerer_id ? '已使用' : '可用'}</span></td><td>{getCodeUser(c) || '—'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(c.created_at))}</td></tr>) : <tr><td colSpan="4" className="table-empty">尚未生成邀请码。设置数量后点击「生成 N 个」。</td></tr>}</tbody></table></div>
    </section>

    <section className="panel" style={{ marginTop: 'var(--sp-6)' }}>
      <div className="panel-head"><div><h3>注册答主列表</h3><p>所有通过邀请码注册的答主账号。</p></div></div>
      <div className="key-stats" style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>{[{value: answerers.length, label: '注册答主'}].map(({value, label}) => <div className="key-stat" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
      <div className="table-wrap"><table><thead><tr><th>#</th><th>知乎用户名</th><th>知乎主页地址</th><th>微信号</th><th>注册时间</th></tr></thead><tbody>{answerers.length ? answerers.map((a) => <tr key={a.id}><td><span className="serial-number">{a.serial_number != null ? String(a.serial_number).padStart(3, '0') : '—'}</span></td><td><div className="person"><span className="person-avatar">{a.zhihu_name[0]}</span><div><strong>{a.zhihu_name}</strong><small>答主</small></div></div></td><td>{a.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--gray-400)', fontSize: 'var(--fs-xs)' }}>未填写</span>}</td><td>{a.wechat_id || '未填写'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.created_at))}</td></tr>) : <tr><td colSpan="5" className="table-empty">暂无注册答主。</td></tr>}</tbody></table></div>
    </section>
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

export default App
