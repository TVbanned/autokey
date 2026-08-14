import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { supabase } from './supabase'
import { matchesSearch } from './pinyin.js'
import defaultRegisterBanner from './assets/hero.png'
import './App.css'

const AdminLoginPage = lazy(() => import('./AdminLoginPage.jsx'))

const ADMIN_SESSION_KEY = 'keyflow_admin_session'
const BANNER_CACHE_KEY = 'keyflow_banner'
const HOME_ACTIVITIES_CACHE_KEY = 'keyflow_home_activities'

const getCachedBanner = () => {
  try { const v = sessionStorage.getItem(BANNER_CACHE_KEY); return v && v.length > 100 ? v : null } catch { return null }
}
const setCachedBanner = (v) => {
  try { if (v && v.length > 100) sessionStorage.setItem(BANNER_CACHE_KEY, v) } catch {}
}
const getCachedHomeActivities = () => {
  try { const v = sessionStorage.getItem(HOME_ACTIVITIES_CACHE_KEY); return v ? JSON.parse(v) : null } catch { return null }
}
const setCachedHomeActivities = (v) => {
  try { sessionStorage.setItem(HOME_ACTIVITIES_CACHE_KEY, JSON.stringify(v)) } catch {}
}

const activityStatusRank = { recruiting: 0, key_distribution: 1, delivery: 2, completed: 3 }
const sortActivitiesByPriority = (activities, applications = null) => {
  const now = new Date()
  return [...activities].sort((a, b) => {
    // 有"未处理"报名的活动排到最前面
    if (applications) {
      const hasPendingA = a.status !== 'delivery' && a.status !== 'completed' && applications.some(app => app.activity_id === a.id && app.status === 'pending')
      const hasPendingB = b.status !== 'delivery' && b.status !== 'completed' && applications.some(app => app.activity_id === b.id && app.status === 'pending')
      if (hasPendingA !== hasPendingB) return hasPendingA ? -1 : 1
    }
    const rankDiff = (activityStatusRank[a.status] ?? 99) - (activityStatusRank[b.status] ?? 99)
    if (rankDiff) return rankDiff
    const hasReleaseA = Boolean(a.release_date)
    const hasReleaseB = Boolean(b.release_date)
    if (hasReleaseA !== hasReleaseB) return hasReleaseA ? -1 : 1
    if (hasReleaseA) {
      const releaseDiff = Math.abs(new Date(a.release_date) - now) - Math.abs(new Date(b.release_date) - now)
      if (releaseDiff) return releaseDiff
    }
    return new Date(b.created_at) - new Date(a.created_at)
  })
}

// 将 base64 头像迁移到 Supabase Storage，返回新 URL（失败时返回原值）
const migrateAvatarToStorage = async (answererId, avatarUrl) => {
  if (!avatarUrl || !avatarUrl.startsWith('data:')) return avatarUrl
  try {
    const matches = avatarUrl.match(/^data:(image\/\w+);base64,(.+)$/)
    if (!matches) return avatarUrl
    const mimeType = matches[1]
    const base64Data = matches[2]
    const byteChars = atob(base64Data)
    const byteArrays = new Uint8Array(byteChars.length)
    for (let i = 0; i < byteChars.length; i++) byteArrays[i] = byteChars.charCodeAt(i)
    const blob = new Blob([byteArrays], { type: mimeType })
    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1]
    const filePath = `${answererId}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(filePath, blob, { upsert: true, contentType: mimeType })
    if (uploadErr) return avatarUrl
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath)
    await supabase.from('keyflow_answerers').update({ avatar_url: publicUrl }).eq('id', answererId)
    return publicUrl
  } catch { return avatarUrl }
}

// 模块级预取：JS 解析时立即发出请求，与 React 渲染并行，首访不再空等
let _homeActivitiesData = null
const _homeActivitiesPromise = supabase.from('keyflow_activities')
  .select('id, title, game_name, game_cover, description, status, created_at, release_date, application_deadline, delivery_deadline, target_authors, steam_url')
  .eq('is_online', true)
  .order('created_at', { ascending: false })
  .then(({ data, error }) => {
    if (!error && data) _homeActivitiesData = sortActivitiesByPriority(data)
    return _homeActivitiesData
  })

const initialActivity = {
  title: '', game_name: '', description: '', rules: '', main_question: '',
  sub_questions: '[]',
  review_requirement: '测评要求：图文并茂，主观视角，生动有趣！',
  target_authors: 20, application_deadline: '', delivery_deadline: '',
  release_date: '',
  steam_url: '', ps_url: '', game_cover: '', game_screenshots: '[]',
  exempted_answerer_ids: '[]',
  deferred_answerer_ids: '[]',
  platforms: ['steam'],
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
    alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></>,
    star: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>,
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
    const claimed = apps.filter(a => a.keyflow_keys?.claimed_at).length
    return `${apps.length}人报名 ${claimed}人已获取 KEY`
  }
  if (status === 'delivery') {
    const deadline = act.delivery_deadline ? new Date(act.delivery_deadline) : null
    const daysLeft = deadline ? Math.max(0, Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24))) : '?'
    return `回稿日期${formatDate(act.delivery_deadline)}，还剩${daysLeft}天`
  }
  if (status === 'completed') return '活动已顺利完结，撒花！'
  return ''
}

function parseSteamAppId(value) {
  const url = value.trim()
  if (!url) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    if (parsed.hostname.toLowerCase() !== 'store.steampowered.com') return null
    const match = parsed.pathname.match(/^\/app\/(\d+)(?:\/|$)/)
    return match ? match[1] : null
  } catch {
    return null
  }
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
  return 'steam'
}

function parseKeys(value) {
  const seen = new Set()
  return value.split(/[\n,，;；\t]+/).map((key) => key.trim()).filter((key) => {
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).map((key_value) => ({ key_value, platform: detectKeyPlatform(key_value) }))
}

const platformLabel = { steam: 'Steam', ubi: 'Ubisoft Connect', switch: 'Switch', ps5: 'PlayStation', epic: 'Epic', unknown: '未识别' }
const activityPlatforms = [
  { value: 'steam', label: 'Steam', icon: <g transform="translate(1.5 1.5) scale(1.3125)"><path fill="currentColor" stroke="none" d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.009-8A8.006 8.006 0 0 0 0 7.468l.003.006 4.304 1.769A2.198 2.198 0 0 1 5.62 8.88l1.96-2.844-.001-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.044l-2.804 2a2.223 2.223 0 0 1-3.075 2.11 2.217 2.217 0 0 1-1.312-1.568L.33 10.333Z"/><path fill="var(--c-surface)" stroke="none" d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.705 1.705 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-.99-.41a1.7 1.7 0 0 0 .882.84Zm3.726-6.687a2.03 2.03 0 0 0 2.027 2.029 2.03 2.03 0 0 0 2.027-2.029 2.03 2.03 0 0 0-2.027-2.027 2.03 2.03 0 0 0-2.027 2.027Zm2.03-1.527a1.524 1.524 0 1 1-.002 3.048 1.524 1.524 0 0 1 .002-3.048Z"/></g> },
  { value: 'ps5', label: 'PlayStation', icon: <g transform="translate(1.5 1.5) scale(.041)"><path fill="currentColor" stroke="none" d="M399.77 203c-.8-17.1-3.3-34.5-10.8-50.1a82.45 82.45 0 0 0-16.5-23.2 105.59 105.59 0 0 0-21.3-16.3c-17.1-10.2-37.5-17-84.4-31S192 64 192 64v358.3l79.9 25.7s.1-198.8.1-299.5v-3.8c0-9.3 7.5-16.8 16.1-16.8h.5c8.5 0 15.5 7.5 15.5 16.8V278c11 5.3 29.2 9.3 41.8 9.1a47.79 47.79 0 0 0 24-5.7 49.11 49.11 0 0 0 18.4-17.8 78.64 78.64 0 0 0 9.9-27.3c1.87-10.8 2.27-22.1 1.57-33.3Z"/><path fill="currentColor" stroke="none" d="M86.67 357.8c27.4-9.8 89.3-29.5 89.3-29.5v-47.2S99.47 305.9 64.67 318.2c-8.6 3.1-17.3 5.9-25.7 9.5-9.8 4.1-19.4 8.7-28.1 14.8a26.29 26.29 0 0 0-9.2 10.1 17.36 17.36 0 0 0-.5 13.6c2 5.1 5.8 9.3 10.1 12.6 7.8 5.9 17.1 9.5 26.4 12.2a262.42 262.42 0 0 0 88.4 13.3c14.5-.2 36-1.9 50-4.4v-42s-11 2.5-41.3 12.5c-4.6 1.5-9.2 3.3-14 4.3a104.87 104.87 0 0 1-21.6 2.2c-6.5-.3-13.2-.7-19.3-3.1-2.2-1-4.6-2.2-5.5-4.6-.8-2 .3-4 1.7-5.4 2.4-2.3 6.4-3.9 10.2-5.4Z"/><path fill="currentColor" stroke="none" d="M512 345.9c-.1-6-3.7-11.2-7.9-15-7.1-6.3-15.9-10.3-24.7-13.5-5.5-1.9-9.3-3.3-14.7-5-25.2-8.2-51.9-11.2-78.3-11.3-8 .3-23.1.5-31 1.4-21.9 2-67.3 15.4-67.3 15.4v48.8s67.5-21.6 96.5-31.8a94.43 94.43 0 0 1 30.3-4.6c6.5.2 13.2.7 19.4 3.1 2.2.9 4.5 2.2 5.5 4.5.9 2.6-.9 5-2.9 6.5-4.7 3.8-10.7 5.3-16.2 7.4-41 14.5-132.7 44.7-132.7 44.7v47s117.2-39.6 170.8-58.8c8.9-3.3 17.9-6.1 26.4-10.4 7.9-4 15.8-8.6 21.8-15.3A19.74 19.74 0 0 0 512 345.9Z"/></g> },
  { value: 'switch', label: 'Switch', icon: <><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M12 5v14M8 10h.01M16 14h.01"/></> },
  { value: 'ubi', label: 'Ubisoft Connect', icon: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M9 5.7A7 7 0 0 1 17.5 15"/></> },
  { value: 'epic', label: 'Epic Games', icon: <><path d="M6 4h12l-1 15-5 2-5-2z"/><path d="M8.5 9h7M9 13h6"/></> },
]

function PlatformSelector({ value, onChange }) {
  const selected = Array.isArray(value) && value.length ? value : ['steam']
  const toggle = (platform) => onChange(selected.includes(platform) ? (selected.length > 1 ? selected.filter((item) => item !== platform) : selected) : [...selected, platform])
  return <fieldset className="field platform-selector"><legend>游戏 Key 版本</legend><div className="platform-options">{activityPlatforms.map((platform) => <button type="button" key={platform.value} className={`platform-option ${selected.includes(platform.value) ? 'selected' : ''}`} aria-pressed={selected.includes(platform.value)} onClick={() => toggle(platform.value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{platform.icon}</svg><span>{platform.label}</span></button>)}</div></fieldset>
}

async function fetchSteamInfo(url) {
  const appid = parseSteamAppId(url)
  if (!appid) return { success: false, error: '无法解析 Steam 商店地址，请检查 URL 格式' }
  const capsule = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_236x236.jpg`
  try {
    const { data, error } = await supabase.functions.invoke('steam-appdetails', { body: { appId: appid } })
    if (error) {
      let message = error.message || 'Steam 元数据抓取失败，请稍后重试'
      try {
        const body = await error.context?.json()
        if (body?.error) message = body.error
      } catch {}
      return { success: false, error: message }
    }
    if (!data?.success) return { success: false, error: data?.error || 'Steam 元数据抓取失败，请稍后重试' }
    const g = data.game || {}
    return {
      success: true,
      cover: g.cover || capsule,
      description: g.desc || '',
      game_name: g.title || '',
      release_date: g.release_date || null,
      screenshots: JSON.stringify(g.screenshots || []),
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Steam 元数据抓取失败，请稍后重试' }
  }
}

function parsePSUrl(value) {
  const url = value.trim()
  if (!url) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    if (!parsed.hostname.endsWith('playstation.com')) return null
    const match = parsed.pathname.match(/\/games\/([^/]+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function fetchPSInfo(url) {
  const slug = parsePSUrl(url)
  if (!slug) return { success: false, error: '无法解析 PlayStation 游戏页面地址，请检查 URL 格式' }
  try {
    const { data, error } = await supabase.functions.invoke('ps-appdetails', { body: { url } })
    if (error) {
      let message = error.message || 'PlayStation 元数据抓取失败，请稍后重试'
      try {
        const body = await error.context?.json()
        if (body?.error) message = body.error
      } catch {}
      return { success: false, error: message }
    }
    if (!data?.success) return { success: false, error: data?.error || 'PlayStation 元数据抓取失败，请稍后重试' }
    const g = data.game || {}
    return {
      success: true,
      cover: g.cover || '',
      description: g.desc || '',
      game_name: g.title || '',
      release_date: g.release_date || null,
      screenshots: JSON.stringify(g.screenshots || []),
      publisher: g.publisher || '',
      genre: g.genre || '',
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'PlayStation 元数据抓取失败，请稍后重试' }
  }
}

function App() {
  const [active, setActive] = useState(() => localStorage.getItem('lastActive') || '活动概览')
  const [activities, setActivities] = useState([])
  const [applications, setApplications] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [dailySubmissions, setDailySubmissions] = useState([])
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('lastSelectedId') || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activityModal, setActivityModal] = useState(false)
  const [applicationModal, setApplicationModal] = useState(false)
  const [editActivityModal, setEditActivityModal] = useState(false)
  const [activityForm, setActivityForm] = useState(initialActivity)
  const [applicationForm, setApplicationForm] = useState({ zhihu_id: '', zhihu_name: '', wechat_name: '', profile_url: '', expected_word_count: 800, selected_platform: 'steam' })
  const [steamFetching, setSteamFetching] = useState(false)
  const [psFetching, setPSFetching] = useState(false)
  const [creating, setCreating] = useState(false)
  const [gameCoverUpload, setGameCoverUpload] = useState(null)
  const [keyInput, setKeyInput] = useState('')
  const [keyImporting, setKeyImporting] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [keys, setKeys] = useState([])
  const [invitationCodes, setInvitationCodes] = useState([])
  const [answerers, setAnswerers] = useState([])
  const [inboxMessages, setInboxMessages] = useState([])
  const [passwordResetRequests, setPasswordResetRequests] = useState([])
  const [deliveryNotes, setDeliveryNotes] = useState({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerSearch, setDrawerSearch] = useState('')
  const [boardSearch, setBoardSearch] = useState('')
  const [boardSort, setBoardSort] = useState('pending_first')
  const [boardFavFilter, setBoardFavFilter] = useState(false)
  const [boardStatusFilter, setBoardStatusFilter] = useState(new Set())
  const [boardStatusMenuOpen, setBoardStatusMenuOpen] = useState(false)
  const [batchFillingRelease, setBatchFillingRelease] = useState(false)
  const [batchFillProgress, setBatchFillProgress] = useState('')
  const [editingMainQuestion, setEditingMainQuestion] = useState(false)
  const [mainQuestionDraft, setMainQuestionDraft] = useState('')
  const [editingSubIndex, setEditingSubIndex] = useState(null)
  const [subDraft, setSubDraft] = useState('')
  const [pageAsset, setPageAsset] = useState(null)
  const [pageAssetLoading, setPageAssetLoading] = useState(false)
  const [pageAssetSaving, setPageAssetSaving] = useState(false)
  const pendingImageRef = useRef(null)
  const [confirmState, setConfirmState] = useState(null)
  const [exemptionSearch, setExemptionSearch] = useState('')
  const [exemptionSelected, setExemptionSelected] = useState(new Set())
  const [exemptionAdding, setExemptionAdding] = useState(false)
  const [deferredSearch, setDeferredSearch] = useState('')
  const [deferredSelected, setDeferredSelected] = useState(new Set())
  const [deferredAdding, setDeferredAdding] = useState(false)
  const [overviewSort, setOverviewSort] = useState(null)

  const selectedActivity = activities.find((item) => item.id === selectedId) || activities[0]
  const subQuestions = useMemo(() => {
    try { return JSON.parse(selectedActivity?.sub_questions || '[]') }
    catch { return [] }
  }, [selectedActivity?.sub_questions])
  const parsedKeys = useMemo(() => parseKeys(keyInput), [keyInput])
  const platformCounts = useMemo(() => parsedKeys.reduce((counts, { platform }) => ({ ...counts, [platform]: (counts[platform] || 0) + 1 }), {}), [parsedKeys])
  const filteredApplications = useMemo(() => applications.filter((item) => item.activity_id === selectedActivity?.id), [applications, selectedActivity])
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const activityById = useMemo(() => Object.fromEntries(activities.map((activity) => [activity.id, activity])), [activities])
  const participationByAnswerer = useMemo(() => {
    const records = {}
    const deliveriesByApp = {}
    deliveries.forEach((d) => {
      if (!deliveriesByApp[d.application_id]) deliveriesByApp[d.application_id] = []
      deliveriesByApp[d.application_id].push(d)
    })
    applications.forEach((application) => {
      if (!application.answerer_id) return
      if (!records[application.answerer_id]) records[application.answerer_id] = []
      records[application.answerer_id].push({ ...application, activity: activityById[application.activity_id], all_deliveries: deliveriesByApp[application.id] || [] })
    })
    return records
  }, [applications, activityById, deliveries])
  const [selectedAnswerer, setSelectedAnswerer] = useState(null)
  const partnerAnswerers = useMemo(() => {
    const partnerAnswererIds = new Set((invitationCodes || []).filter(c => c.code_type === 'partner' && c.answerer_id).map(c => c.answerer_id))
    return answerers.filter(a => partnerAnswererIds.has(a.id))
  }, [answerers, invitationCodes])
  const exemptedIds = useMemo(() => {
    try { return JSON.parse(selectedActivity?.exempted_answerer_ids || '[]') }
    catch { return [] }
  }, [selectedActivity?.exempted_answerer_ids])
  const pendingCount = filteredApplications.filter((item) => item.status === 'pending').length
  const selectedCount = filteredApplications.filter((item) => item.status === 'selected').length
  const claimedCount = filteredApplications.filter((item) => item.keyflow_keys?.claimed_at || exemptedIds.includes(item.answerer_id)).length
  const importedKeyCount = keys.filter((k) => k.activity_id === selectedActivity?.id).length
  const deliveredCount = filteredApplications.filter((item) => Array.isArray(item.keyflow_deliveries) ? item.keyflow_deliveries.length > 0 : item.keyflow_deliveries?.id).length

  const overviewApplications = useMemo(() => {
    if (!overviewSort) return filteredApplications
    const { key, dir } = overviewSort
    const rank = (p) => {
      if (key === 'status') return p.status === 'selected' ? 2 : p.status === 'pending' ? 1 : 0
      if (key === 'claimed') return (p.keyflow_keys?.claimed_at || exemptedIds.includes(p.answerer_id)) ? 1 : 0
      if (key === 'delivered') return (Array.isArray(p.keyflow_deliveries) ? p.keyflow_deliveries.length > 0 : p.keyflow_deliveries?.id) ? 1 : 0
      return 0
    }
    return [...filteredApplications].sort((a, b) => (rank(a) - rank(b)) * dir)
  }, [filteredApplications, overviewSort, exemptedIds])

  const toggleOverviewSort = (key) => setOverviewSort((prev) => (prev?.key === key ? { key, dir: -prev.dir } : { key, dir: -1 }))

  // 与看板卡片的“未处理”展示口径保持一致
  const boardPendingCount = useMemo(() => activities.filter((activity) => (
    activity.status !== 'delivery' &&
    activity.status !== 'completed' &&
    applications.some((application) => application.activity_id === activity.id && application.status === 'pending')
  )).length, [activities, applications])
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
    const keyword = drawerSearch.trim()
    const list = keyword ? activities.filter((item) => matchesSearch(`${item.game_name || ''} ${item.title || ''}`, keyword)) : activities
    return sortActivitiesByPriority(list, applications)
  }, [activities, drawerSearch, applications])
  const filteredBoardActivities = useMemo(() => {
    const keyword = boardSearch.trim()
    let list = keyword ? activities.filter((item) => matchesSearch(`${item.game_name || ''} ${item.title || ''}`, keyword)) : [...activities]
    if (boardStatusFilter.size > 0) list = list.filter(item => boardStatusFilter.has(item.status))
    if (boardFavFilter) list = list.filter(item => item.is_favorite)
    if (boardSort === 'pending_first') return sortActivitiesByPriority(list, applications)
    if (boardSort === 'default') return sortActivitiesByPriority(list)
    const sep = boardSort.lastIndexOf('_')
    const field = boardSort.slice(0, sep)
    const asc = boardSort.slice(sep + 1) === 'asc'
    list.sort((a, b) => {
      const va = a[field] || '', vb = b[field] || ''
      if (!va && !vb) return 0
      if (!va) return 1
      if (!vb) return -1
      return asc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0)
    })
    return list
  }, [activities, boardSearch, boardSort, boardFavFilter, boardStatusFilter, applications])
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
    try {
      // 所有查询同时发起，不互相等待
      const pAct = supabase.from('keyflow_activities').select('*').order('created_at', { ascending: false }).limit(1000)
      const pApp = supabase.from('keyflow_applications').select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status, article_url, article_title)').order('submitted_at', { ascending: false }).limit(1000)
      // 其余数据用 then 处理，不阻塞 loading 状态
      Promise.all([
        supabase.from('keyflow_deliveries').select('id, application_id, status, article_url, article_title, reviewer_note, reviewed_at, submitted_at').limit(1000),
        supabase.from('keyflow_daily_submissions').select('id, answerer_id, article_url, article_title, submitted_at, created_at, reviewed, processed, featured').order('submitted_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_keys').select('id, activity_id, platform, application_id, created_at, claimed_at').order('created_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_invitation_codes').select('id, code, code_type, application_id, answerer_id, created_at, used_at').order('created_at', { ascending: false }).order('id').limit(1000),
        supabase.from('keyflow_answerers').select('id, serial_number, zhihu_name, account_address, wechat_id, remark, created_at, updated_at').order('created_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_inbox').select('id, title, body, status, to_id, type, created_at, read_at').neq('type', 'system').order('created_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_password_reset_requests').select('id, answerer_id, status, requested_at, reviewed_at, admin_note').order('requested_at', { ascending: false }).limit(1000),
      ]).then(([d, ds, k, ic, a, ib, r]) => {
        const failure = d.error || ds.error || k.error || ic.error || a.error || ib.error || r.error
        if (failure) setError(failure.message)
        else {
          setDeliveries(d.data || []); setDailySubmissions(ds.data || []); setKeys(k.data || []); setInvitationCodes(ic.data || []); setAnswerers(a.data || []); setInboxMessages(ib.data || []); setPasswordResetRequests(r.data || [])
          // 延后异步加载头像，base64 格式自动迁移到 Supabase Storage
          supabase.from('keyflow_answerers').select('id, avatar_url').limit(1000).then(async ({ data: avatarData }) => {
            if (avatarData) {
              const migrated = await Promise.all(avatarData.map(async (a) => {
                if (a.avatar_url && a.avatar_url.startsWith('data:')) {
                  a.avatar_url = await migrateAvatarToStorage(a.id, a.avatar_url)
                }
                return a
              }))
              setAnswerers(prev => prev.map(aa => { const m = migrated.find(dd => dd.id === aa.id); return m && m.avatar_url ? { ...aa, avatar_url: m.avatar_url } : aa }))
            }
          })
        }
      }).catch((e) => {
        console.error('辅助数据加载失败:', e)
      })
      // 优先等待活动+报名，让看板尽快可用（45 秒超时保护，兼容 Supabase 免费版冷启动）
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('数据加载超时，请检查网络后刷新重试')), 45000))
      const [activityResult, applicationResult] = await Promise.race([
        Promise.all([pAct, pApp]),
        timeout,
      ])
      if (activityResult.error) { setError(activityResult.error.message); setLoading(false); return }
      if (applicationResult.error) { setError(applicationResult.error.message); setLoading(false); return }
      const rawActivities = activityResult.data || []
      const apps = applicationResult.data || []
      const { updated: afterDeadline } = autoAdvanceByDeadline(rawActivities)
      const { updated } = autoAdvanceByCondition(afterDeadline, apps)
      setActivities(updated); setApplications(apps)
      setSelectedId((current) => current || updated?.[0]?.id || '')
      setLoading(false)
    } catch (e) {
      setError(e.message || '数据加载失败，请检查网络后刷新重试')
      setLoading(false)
    }
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
  useEffect(() => { localStorage.setItem('lastSelectedId', selectedId) }, [selectedId])
  useEffect(() => { localStorage.setItem('lastActive', active) }, [active])

  const createActivity = async (event) => {
    event.preventDefault()
    if (creating) return
    setCreating(true)
    try {
      // 自动抓取 Steam 发售时间
      let releaseDate = activityForm.release_date
      let gameCover = activityForm.game_cover
      let gameName = activityForm.game_name
      if (activityForm.steam_url && !releaseDate) {
        const info = await fetchSteamInfo(activityForm.steam_url)
        if (info.success) {
          releaseDate = info.release_date || null
          if (!gameCover) gameCover = info.cover
          if (!gameName) gameName = info.game_name || gameName
        }
      }
      if (activityForm.ps_url && !releaseDate) {
        const info = await fetchPSInfo(activityForm.ps_url)
        if (info.success) {
          releaseDate = releaseDate || info.release_date || null
          if (!gameCover) gameCover = info.cover
          if (!gameName) gameName = info.game_name || gameName
        }
      }
      const payload = {
        ...activityForm,
        game_cover: gameCover || activityForm.game_cover,
        game_name: gameName || activityForm.game_name,
        target_authors: Number(activityForm.target_authors),
        application_deadline: activityForm.application_deadline || null,
        delivery_deadline: activityForm.delivery_deadline || null,
        release_date: releaseDate || null,
        platforms: activityForm.platforms?.length ? activityForm.platforms : ['steam'],
        is_online: false,
      }
      const { data, error: requestError } = await supabase.from('keyflow_activities').insert(payload).select().single()
      if (requestError) { setError(requestError.message); return }
      setActivities((items) => [data, ...items]); setSelectedId(data.id); setActive('活动概览'); setActivityModal(false); setGameCoverUpload(null); setActivityForm({...initialActivity, ...getDefaultDeadlines()}); toast('活动已创建，可开始收集答主报名')
    } finally {
      setCreating(false)
    }
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
    if (selectedActivity.game_cover && selectedActivity.game_cover.startsWith('data:')) {
      setGameCoverUpload(selectedActivity.game_cover)
    } else {
      setGameCoverUpload(null)
    }
    setEditActivityModal(true)
  }

  const handleGameCoverFile = (file) => {
    setError('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    if (file.size > 500 * 1024) { setError('图片大小不能超过 500KB，请压缩后重新选择'); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      setGameCoverUpload(e.target.result)
      setActivityForm((prev) => ({ ...prev, game_cover: e.target.result }))
    }
    reader.readAsDataURL(file)
  }

  const handleSteamFetch = async () => {
    const url = activityForm.steam_url
    if (!url) return
    setSteamFetching(true)
    const info = await fetchSteamInfo(url)
    if (info.success) {
      setGameCoverUpload(null)
      setActivityForm((prev) => ({
        ...prev,
        game_cover: info.cover,
        description: info.description || prev.description,
        game_name: info.game_name || prev.game_name,
        title: prev.title || (info.game_name ? `《${info.game_name}》游戏体验` : prev.title),
        release_date: info.release_date || prev.release_date,
        game_screenshots: info.screenshots || '[]',
      }))
      toast('已从 Steam 抓取封面、截图和简介')
    } else {
      setError(info.error)
    }
    setSteamFetching(false)
  }

  const handlePSFetch = async () => {
    const url = activityForm.ps_url
    if (!url) return
    setPSFetching(true)
    const info = await fetchPSInfo(url)
    if (info.success) {
      setGameCoverUpload(null)
      setActivityForm((prev) => ({
        ...prev,
        game_cover: info.cover || prev.game_cover,
        description: info.description || prev.description,
        game_name: info.game_name || prev.game_name,
        title: prev.title || (info.game_name ? `《${info.game_name}》游戏体验` : prev.title),
        release_date: info.release_date || prev.release_date,
        game_screenshots: info.screenshots || '[]',
      }))
      toast('已从 PlayStation 抓取封面和简介')
    } else {
      setError(info.error)
    }
    setPSFetching(false)
  }

  const batchFillReleaseDates = async () => {
    const candidates = activities.filter(a => a.steam_url && !a.release_date)
    if (candidates.length === 0) { toast('所有活动已有发售时间'); return }
    setBatchFillingRelease(true)
    let filled = 0
    let skipped = 0
    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i]
      setBatchFillProgress(`${i + 1}/${candidates.length}`)
      const info = await fetchSteamInfo(item.steam_url)
      if (info.success && info.release_date) {
        const { error: upErr } = await supabase.from('keyflow_activities').update({ release_date: info.release_date }).eq('id', item.id)
        if (!upErr) filled++
        else skipped++
      } else {
        skipped++
      }
      if (i < candidates.length - 1) await new Promise(r => setTimeout(r, 600))
    }
    setBatchFillingRelease(false)
    setBatchFillProgress('')
    toast(`已更新 ${filled} 款游戏的发售时间${skipped > 0 ? `，${skipped} 款无发售时间或已跳过` : ''}`)
    loadData()
  }

  const updateActivity = async (event) => {
    event.preventDefault()
    // 自动抓取 Steam/PlayStation 发售时间
    let releaseDate = activityForm.release_date
    if (activityForm.steam_url && !releaseDate) {
      const info = await fetchSteamInfo(activityForm.steam_url)
      if (info.success) releaseDate = info.release_date || null
    }
    if (activityForm.ps_url && !releaseDate) {
      const info = await fetchPSInfo(activityForm.ps_url)
      if (info.success) releaseDate = releaseDate || info.release_date || null
    }
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
      release_date: releaseDate || null,
      steam_url: activityForm.steam_url,
      ps_url: activityForm.ps_url,
      game_cover: activityForm.game_cover,
      game_screenshots: activityForm.game_screenshots || '[]',
      partner_answerer_id: activityForm.partner_answerer_id || null,
      platforms: activityForm.platforms?.length ? activityForm.platforms : ['steam'],
    }
    const { error: requestError } = await supabase.from('keyflow_activities').update(payload).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities((items) => items.map((item) => item.id === selectedActivity.id ? { ...item, ...payload } : item)); setEditActivityModal(false); toast('活动已更新')
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

  const toggleFavorite = async (id, isFavorite, event) => {
    event.stopPropagation()
    const newValue = !isFavorite
    setActivities((items) => items.map((item) => item.id === id ? { ...item, is_favorite: newValue } : item))
    const { error: requestError } = await supabase.from('keyflow_activities').update({ is_favorite: newValue }).eq('id', id)
    if (requestError) {
      setActivities((items) => items.map((item) => item.id === id ? { ...item, is_favorite: isFavorite } : item))
      return setError(requestError.message)
    }
  }

  const toggleBoardStatusFilter = (status) => {
    setBoardStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status); else next.add(status)
      return next
    })
  }

  const importKeys = async () => {
    if (!selectedActivity || !parsedKeys.length) return
    setKeyImporting(true); setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_import_keys', { p_activity_id: selectedActivity.id, p_keys: parsedKeys })
    setKeyImporting(false)
    if (requestError) return setError(requestError.message)
    const result = data?.[0]
    // 根据实际入库的 key 版本自动同步活动 platforms 配置
    const { data: dbPlatforms } = await supabase.from('keyflow_keys').select('platform').eq('activity_id', selectedActivity.id)
    if (dbPlatforms?.length) {
      const distinctPlatforms = [...new Set(dbPlatforms.map(k => k.platform))]
      const currentPlatforms = Array.isArray(selectedActivity.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']
      if (JSON.stringify(distinctPlatforms.sort()) !== JSON.stringify([...currentPlatforms].sort())) {
        await supabase.from('keyflow_activities').update({ platforms: distinctPlatforms }).eq('id', selectedActivity.id)
      }
    }
    setKeyInput(''); await loadData()
    toast(`已入库 ${result?.inserted_count || 0} 个 Key${result?.duplicate_count ? `，跳过 ${result.duplicate_count} 个重复项` : ''}`)
  }

  const deleteKeys = async (keyIds) => {
    if (!keyIds.length) return
    setError('')
    const { data, error: requestError } = await supabase.rpc('keyflow_delete_keys', { p_key_ids: keyIds })
    if (requestError) return setError(requestError.message)
    const ids = new Set(keyIds)
    setKeys((items) => items.filter((item) => !ids.has(item.id)))
    toast(`已删除 ${data?.deleted_count ?? 0} 个 Key`)
  }

  const claimKeyRemotely = (keyId) => {
    const now = new Date().toISOString()
    setKeys((items) => items.map((item) => item.id === keyId ? { ...item, claimed_at: now } : item))
  }

  const reviewDelivery = async (delivery, status) => {
    const note = deliveryNotes[delivery.id] ?? delivery.reviewer_note ?? ''
    const { error: requestError } = await supabase.from('keyflow_deliveries').update({ status, reviewer_note: note, reviewed_at: new Date().toISOString() }).eq('id', delivery.id)
    if (requestError) return setError(requestError.message)
    setDeliveries((items) => items.map((item) => item.id === delivery.id ? { ...item, status, reviewer_note: note, reviewed_at: new Date().toISOString() } : item))
    setApplications((items) => items.map((item) => {
      const deliveriesArr = item.keyflow_deliveries
      if (!deliveriesArr) return item
      if (Array.isArray(deliveriesArr)) {
        return deliveriesArr.some(d => d.id === delivery.id)
          ? { ...item, keyflow_deliveries: deliveriesArr.map(d => d.id === delivery.id ? { ...d, status, reviewer_note: note } : d) }
          : item
      }
      return deliveriesArr.id === delivery.id ? { ...item, keyflow_deliveries: { ...deliveriesArr, status, reviewer_note: note } } : item
    }))
    toast(status === 'approved' ? '作品已通过验收' : status === 'revision_required' ? '已退回修改' : '作品已标记为未通过')
  }

  const STAGES = ['recruiting', 'key_distribution', 'delivery', 'completed']
  const STAGE_LABEL = { recruiting: '招募中', key_distribution: '发key中', delivery: '交付/创作中', completed: '项目完结' }

  const STAGE_TRIGGER = {
    recruiting: () => '招募时间截止后需手动推进',
    key_distribution: () => '入选答主全部领Key后需手动推进',
    delivery: () => '全部交稿后自动推进',
  }

  const autoAdvanceByDeadline = (activitiesList) => {
    // 招募中不再自动推进到发key中，改为手动推进
    return { updated: activitiesList, changed: false }
  }

  const autoAdvanceByCondition = (activitiesList, apps) => {
    let changed = false
    const updated = activitiesList.map((act) => {
      const status = act.status || 'recruiting'
      if (status !== 'delivery') return act

      const selectedApps = apps.filter(a => a.activity_id === act.id && a.status === 'selected')
      if (selectedApps.length === 0) return act

      // 交付/创作中 → 项目完结：所有入选答主都已交稿
      if (selectedApps.every(a => Array.isArray(a.keyflow_deliveries) ? a.keyflow_deliveries.length > 0 : a.keyflow_deliveries?.id)) {
        changed = true
        supabase.from('keyflow_activities').update({ status: 'completed' }).eq('id', act.id).then(() => {})
        return { ...act, status: 'completed' }
      }

      return act
    })
    return { updated, changed }
  }

  const goToStage = async (stage) => {
    const current = selectedActivity?.status || 'recruiting'
    if (stage === current) return
    setAdvancing(true)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ status: stage }).eq('id', selectedActivity.id)
    setAdvancing(false)
    if (requestError) return setError(requestError.message)
    setActivities((items) => items.map((item) => item.id === selectedActivity.id ? { ...item, status: stage } : item))
    toast(`阶段已切换：${STAGE_LABEL[stage]}`)
  }

  const resetStage = async () => {
    const { error: requestError } = await supabase.from('keyflow_activities').update({ status: 'recruiting', application_deadline: null }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities((items) => items.map((item) => item.id === selectedActivity.id ? { ...item, status: 'recruiting', application_deadline: null } : item))
    toast('阶段已重置为招募中')
  }

  const exemptedAnswerers = useMemo(() => answerers.filter(a => exemptedIds.includes(a.id)), [answerers, exemptedIds])

  const toggleExemptionSelect = (id) => {
    setExemptionSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const addExemptedAnswerers = async () => {
    if (exemptionSelected.size === 0) return
    const newIds = [...new Set([...exemptedIds, ...exemptionSelected])]
    const json = JSON.stringify(newIds)
    setExemptionAdding(true)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ exempted_answerer_ids: json }).eq('id', selectedActivity.id)
    setExemptionAdding(false)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, exempted_answerer_ids: json } : item))
    setExemptionSelected(new Set())
    setExemptionSearch('')
    toast(`已添加 ${exemptionSelected.size} 位豁免答主`)
  }

  const removeExemptedAnswerer = async (answererId) => {
    const newIds = exemptedIds.filter(id => id !== answererId)
    const json = JSON.stringify(newIds)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ exempted_answerer_ids: json }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, exempted_answerer_ids: json } : item))
    toast('已移除豁免答主')
  }

  const deferredIds = useMemo(() => {
    try { return JSON.parse(selectedActivity?.deferred_answerer_ids || '[]') }
    catch { return [] }
  }, [selectedActivity?.deferred_answerer_ids])

  const deferredAnswerers = useMemo(() => answerers.filter(a => deferredIds.includes(a.id)), [answerers, deferredIds])

  const toggleDeferredSelect = (id) => {
    setDeferredSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const addDeferredAnswerers = async () => {
    if (deferredSelected.size === 0) return
    const newIds = [...new Set([...deferredIds, ...deferredSelected])]
    const json = JSON.stringify(newIds)
    setDeferredAdding(true)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ deferred_answerer_ids: json }).eq('id', selectedActivity.id)
    setDeferredAdding(false)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, deferred_answerer_ids: json } : item))
    setDeferredSelected(new Set())
    setDeferredSearch('')
    toast(`已添加 ${deferredSelected.size} 位延期答主`)
  }

  const removeDeferredAnswerer = async (answererId) => {
    const newIds = deferredIds.filter(id => id !== answererId)
    const json = JSON.stringify(newIds)
    const { error: requestError } = await supabase.from('keyflow_activities').update({ deferred_answerer_ids: json }).eq('id', selectedActivity.id)
    if (requestError) return setError(requestError.message)
    setActivities(items => items.map(item => item.id === selectedActivity.id ? { ...item, deferred_answerer_ids: json } : item))
    toast('已移除延期答主')
  }

  const STAGE_COLOR = { recruiting: 'stage-blue', key_distribution: 'stage-orange', delivery: 'stage-purple', completed: 'stage-green' }

  const nav = [['活动看板', 'calendar'], ['活动概览', 'grid'], ['答主报名', 'users'], ['Key 管理', 'key'], ['交付验收', 'file'], ['答主管理', 'ticket'], ['合作方管理', 'users'], ['全部活动投稿', 'file'], ['答主日常投稿', 'file'], ['剩余KEY管理', 'key'], ['页面编辑', 'image']]
  const statusLabel = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatusLabel = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const activityDeliveries = deliveries.filter((item) => filteredApplications.some((application) => application.id === item.application_id))
  const pendingDeliveries = activityDeliveries.filter((item) => item.status === 'pending').length
  const approvedDeliveries = activityDeliveries.filter((item) => item.status === 'approved').length
  const revisionDeliveries = activityDeliveries.filter((item) => item.status === 'revision_required').length

  const urlParams = new URLSearchParams(window.location.search)
  const homeMode = urlParams.get('home') !== null
  if (homeMode) return <HomePage />
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
  if (adminLoginMode || !adminSession) return <Suspense fallback={<div className="admin-login-wrapper"><div className="admin-login-card"><p style={{textAlign:'center',padding:'2rem',color:'var(--c-ink-3)'}}>加载中…</p></div></div>}><AdminLoginPage /></Suspense>

  const claimLink = selectedActivity ? `${window.location.origin}${window.location.pathname}?apply=${selectedActivity.id}` : ''
  const partnerLink = selectedActivity?.partner_token ? `${window.location.origin}${window.location.pathname}?partner=${selectedActivity.partner_token}` : ''

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href={window.location.pathname + '?home'}><span className="brand-mark zhihu-mark">知</span>GameJourney</a>
      <div className="sidebar-divider" />
      <nav className="nav-section"><p className="nav-label">工作台</p>{nav.map(([label, icon]) => <button key={label} className={`nav-item ${label === '答主管理' ? 'nav-item-after-divider' : ''} ${active === label ? 'active' : ''}`} onClick={() => setActive(label)}>{label === '答主管理' && <small className="nav-global-label">全局管理</small>}<Icon name={icon}/><span>{label}</span>{label === '活动看板' && boardPendingCount > 0 && <b className="nav-alert">{boardPendingCount}</b>}{label === '答主报名' && pendingCount > 0 && <b>{pendingCount}</b>}</button>)}</nav>
      <div className="sidebar-inbox-area">
        <button className={`sidebar-inbox-btn ${active === '收件箱' ? 'active' : ''}`} onClick={() => setActive('收件箱')} title="收件箱">
          <Icon name="inbox" size={20}/>
          <span>收件箱</span>
          {inboxMessages.filter(m => m.type !== 'private_message' && m.type !== 'system' && m.status === 'unread').length > 0 && <b className="nav-alert">{inboxMessages.filter(m => m.type !== 'private_message' && m.type !== 'system' && m.status === 'unread').length}</b>}
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
      <header className="topbar"><a className="mobile-brand" href={window.location.pathname + '?home'}><span className="brand-mark zhihu-mark">知</span> GameJourney</a><div className="crumb">工作台 <span>/</span> {active}</div><div className="topbar-links"><a className="topbar-link-btn" href={window.location.pathname + '?partner'} target="_blank">合作方看板</a><a className="topbar-link-btn" href={window.location.pathname + '?dashboard'} target="_blank">答主看板</a><a className="topbar-link-btn" href={window.location.pathname + '?home'} target="_blank">展示页</a><button className="reload" onClick={loadData}>刷新数据</button></div></header>
      <section className="content">
        <div className="page-title"><div><p className="eyebrow">真实数据工作台</p><h1>{active}{active === '活动看板' && <span className="board-game-count"> 当前已有 <b>{activities.length}</b> 款游戏入库</span>}{active !== '活动看板' && active !== '答主管理' && active !== '合作方管理' && active !== '全部活动投稿' && active !== '答主日常投稿' && active !== '剩余KEY管理' && active !== '页面编辑' && active !== '收件箱' && selectedActivity?.game_name && <><span className="title-divider">|</span>{selectedActivity.game_name}</>}</h1><p className="subtitle">{active === '页面编辑' ? '管理注册页面的展示资源，保存后会实时同步。' : '活动、报名、Key 与交付数据均实时保存至 Supabase。'}</p></div>{active === '答主报名' ? <div style={{ display: 'flex', gap: 'var(--sp-2)' }}><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button></div> : active === '页面编辑' ? null : active === '活动看板' ? <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }}><div className="board-sort-wrap"><select className="board-sort-select" value={boardSort} onChange={e => setBoardSort(e.target.value)}><option value="pending_first">优先未处理</option><option value="default">默认排序</option><option value="created_at_desc">入库时间 ↓</option><option value="created_at_asc">入库时间 ↑</option><option value="release_date_desc">发售时间 ↓</option><option value="release_date_asc">发售时间 ↑</option></select><svg className="board-sort-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></div><button className={`board-fav-filter-btn ${boardFavFilter ? 'active' : ''}`} onClick={() => setBoardFavFilter(v => !v)} title={boardFavFilter ? '显示全部' : '只显示收藏'}><Icon name="star" size={14}/><span>收藏</span></button><div className="board-status-filter"><button className={`board-fav-filter-btn ${boardStatusFilter.size > 0 ? 'active' : ''}`} onClick={() => setBoardStatusMenuOpen(v => !v)} title="按活动阶段筛选"><Icon name="eye" size={14}/><span>只看</span>{boardStatusFilter.size > 0 && <span className="board-status-count">{boardStatusFilter.size}</span>}</button>{boardStatusMenuOpen && <><div className="board-status-backdrop" onClick={() => setBoardStatusMenuOpen(false)} /><div className="board-status-menu">{STAGES.map((status) => <label key={status} className={`board-status-option ${boardStatusFilter.has(status) ? 'active' : ''}`}><input type="checkbox" checked={boardStatusFilter.has(status)} onChange={() => toggleBoardStatusFilter(status)} /><span>{STAGE_LABEL[status]}</span></label>)}</div></>}</div><div className="partner-search-wrap" style={{ background: '#fff', minWidth: 260, gap: 'var(--sp-1)', padding: 'var(--sp-1) var(--sp-2)' }}><Icon name="search" size={14} /><input className="partner-search-input" placeholder="搜索活动名称或游戏名…" value={boardSearch} onChange={e => setBoardSearch(e.target.value)} />{boardSearch && <button className="partner-search-clear" onClick={() => setBoardSearch('')}><Icon name="close" size={14} /></button>}</div>{activities.some(a => a.steam_url && !a.release_date) && <button className="outline-button" onClick={batchFillReleaseDates} disabled={batchFillingRelease}>{batchFillingRelease ? `更新中 ${batchFillProgress}` : '更新发售时间'}</button>}<button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : <button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button>}</div>
        {error && <div className="error-box">数据操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {loading && active !== '页面编辑' ? <div className="empty-state">正在加载活动数据…</div> : active === '活动概览' && !selectedActivity ? <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建第一个测评活动</h2><p>创建后即可收集答主报名、导入 Key 并进行交付验收。</p><button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : active === '活动概览' ? <>
          <section className="activity-picker"><button className="current-activity" onClick={openDrawer}><span>当前活动</span><strong>{selectedActivity.title}</strong><Icon name="arrow" size={14}/></button><div className="activity-picker-right"><span className={`activity-status ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span><button className="outline-button" onClick={() => { navigator.clipboard.writeText(partnerLink); toast('合作方页面链接已复制') }}>复制合作方链接</button><button className="outline-button preview-partner-btn" onClick={() => window.open(partnerLink, '_blank')}>预览合作方页</button><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button><button className="outline-button" onClick={() => setApplicationModal(true)}><Icon name="plus" size={16}/> 新增报名</button></div></section>
          <section className="hero-card real-hero"><div className="hero-top"><div><span className="live-dot"/> <span className={`stage-badge ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span> <span className="divider">|</span> <span className={(selectedActivity?.status === 'recruiting' && selectedActivity?.application_deadline && new Date(selectedActivity.application_deadline) < new Date()) ? 'text-red' : ''}>{getStatusTimeText(selectedActivity, filteredApplications)}</span></div><button className="edit-button" onClick={openEditActivity}><Icon name="edit" size={15}/> 编辑</button></div><div className="game-info"><div className="game-cover">{selectedActivity.game_cover ? <img src={selectedActivity.game_cover} alt={selectedActivity.game_name}/> : <span>{selectedActivity.game_name[0]}</span>}</div><div><p className="game-type">{selectedActivity.game_name}</p><h2>{selectedActivity.title}</h2><p>{selectedActivity.description || '尚未填写游戏简介。'}</p><p className="review-requirement">{selectedActivity.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'}</p></div></div>{(() => { const platforms = Array.isArray(selectedActivity.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return (platforms.length > 1 || platforms[0] !== 'steam') && <div className="admin-platforms"><span>可选版本</span>{platforms.map((value) => { const platform = activityPlatforms.find((item) => item.value === value); return <span key={value} className="admin-platform"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{platform?.icon}</svg>{platformLabel[value] || value}</span> })}</div> })()}<div className="rules-row main-question-row"><strong>测评主问题</strong>{editingMainQuestion ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={mainQuestionDraft} onChange={(e) => setMainQuestionDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={saveMainQuestion}>保存</button><button className="inline-cancel" onClick={() => { setEditingMainQuestion(false) }}>取消</button></div></div> : <div className="inline-display"><span>{selectedActivity.main_question || '尚未设置'}</span><button className="inline-edit-btn" title="编辑主问题" onClick={() => { setMainQuestionDraft(selectedActivity.main_question || ''); setEditingMainQuestion(true) }}><Icon name="edit" size={14}/></button></div>}</div>{subQuestions.map((q, i) => <div className="rules-row sub-question-row" key={i}><strong>相关问题 {i + 1}</strong>{editingSubIndex === i ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={subDraft} onChange={(e) => setSubDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={() => saveSubQuestion(i)}>保存</button><button className="inline-cancel" onClick={() => setEditingSubIndex(null)}>取消</button></div></div> : <div className="inline-display"><span>{q || '空问题'}</span><button className="inline-edit-btn" title="编辑相关问题" onClick={() => { setSubDraft(q); setEditingSubIndex(i) }}><Icon name="edit" size={14}/></button><button className="inline-delete-btn" title="删除相关问题" onClick={() => deleteSubQuestion(i)}><Icon name="close" size={14}/></button></div>}</div>)}<button className="add-sub-btn" onClick={addSubQuestion}><Icon name="plus" size={14}/> 新增相关问题</button></section>
          <section className="metrics">{[[filteredApplications.length,'报名答主',`目标 ${selectedActivity.target_authors} 人`,'答主报名'],[selectedCount,'已入选',`已录入key ${importedKeyCount} 个`,'答主报名'],[claimedCount,'已领取 Key',`${selectedCount - claimedCount}/${selectedCount} 人 未领取key`,'Key 管理'],[deliveredCount,'已提交交付',`${selectedCount - deliveredCount}/${selectedCount} 人未交付`,'交付验收']].map(([number,label,note,target], idx) => <div className="metric clickable" key={label} onClick={() => setActive(target)}><strong style={idx === 1 && selectedCount > importedKeyCount ? {color:'#e53e3e'} : undefined}>{number}</strong><span>{label}</span><small>{note}</small></div>)}</section>
          <div className="exemption-deferred-row">
            <section className="exemption-panel panel half-panel"><div className="panel-head"><div><h3>豁免答主（已豁免 {exemptedAnswerers.length} 人）</h3><p>已完结活动可为指定答主开放投稿豁免，允许其在活动完结后继续提交作品。</p></div></div><div className="exemption-body">{exemptedAnswerers.length > 0 && <div className="exemption-list">{exemptedAnswerers.map(a => <div key={a.id} className="exemption-tag"><span className="exemption-tag-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-tag-name">{a.zhihu_name}</span><button className="exemption-tag-remove" onClick={() => removeExemptedAnswerer(a.id)} title="移除豁免"><Icon name="close" size={12}/></button></div>)}</div>}<div className="exemption-search-wrap"><input className="exemption-search-input" placeholder="搜索答主…" value={exemptionSearch} onChange={e => setExemptionSearch(e.target.value)} /></div>{exemptionSearch.trim() ? (() => { const candidates = answerers.filter(a => !exemptedIds.includes(a.id) && matchesSearch(a.zhihu_name, exemptionSearch)); return <div className="exemption-candidate-list">{candidates.length > 0 ? candidates.map(a => <label key={a.id} className={`exemption-candidate-row ${exemptionSelected.has(a.id) ? 'checked' : ''}`}><input type="checkbox" checked={exemptionSelected.has(a.id)} onChange={() => toggleExemptionSelect(a.id)} /><span className="exemption-candidate-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-candidate-name">{a.zhihu_name}</span></label>) : <div className="exemption-candidate-empty">没有匹配的答主</div>}</div> })() : <div className="exemption-candidate-hint">共 {answerers.filter(a => !exemptedIds.includes(a.id)).length} 位答主可选，输入关键词搜索</div>}<button className="primary exemption-add-btn" onClick={addExemptedAnswerers} disabled={exemptionSelected.size === 0 || exemptionAdding}>{exemptionAdding ? '添加中…' : `添加选中答主${exemptionSelected.size > 0 ? ` (${exemptionSelected.size})` : ''}`}</button></div></section>
            <section className="deferred-panel panel half-panel"><div className="panel-head"><div><h3>延期答主</h3><p>项目关闭后，选定答主仍可提交作品，但会计入一次延期提交。</p></div></div><div className="exemption-body">{deferredAnswerers.length > 0 && <div className="exemption-list">{deferredAnswerers.map(a => <div key={a.id} className="exemption-tag"><span className="exemption-tag-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-tag-name">{a.zhihu_name}</span><button className="exemption-tag-remove" onClick={() => removeDeferredAnswerer(a.id)} title="移除延期"><Icon name="close" size={12}/></button></div>)}</div>}<div className="exemption-search-wrap"><input className="exemption-search-input" placeholder="搜索答主…" value={deferredSearch} onChange={e => setDeferredSearch(e.target.value)} /></div>{deferredSearch.trim() ? (() => { const candidates = answerers.filter(a => !deferredIds.includes(a.id) && matchesSearch(a.zhihu_name, deferredSearch)); return <div className="exemption-candidate-list">{candidates.length > 0 ? candidates.map(a => <label key={a.id} className={`exemption-candidate-row ${deferredSelected.has(a.id) ? 'checked' : ''}`}><input type="checkbox" checked={deferredSelected.has(a.id)} onChange={() => toggleDeferredSelect(a.id)} /><span className="exemption-candidate-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-candidate-name">{a.zhihu_name}</span></label>) : <div className="exemption-candidate-empty">没有匹配的答主</div>}</div> })() : <div className="exemption-candidate-hint">共 {answerers.filter(a => !deferredIds.includes(a.id)).length} 位答主可选，输入关键词搜索</div>}<button className="primary exemption-add-btn" onClick={addDeferredAnswerers} disabled={deferredSelected.size === 0 || deferredAdding}>{deferredAdding ? '添加中…' : `添加选中答主${deferredSelected.size > 0 ? ` (${deferredSelected.size})` : ''}`}</button></div></section>
          </div>
          <section className="stage-progression"><div className="stage-header"><div><h3>阶段推进</h3><span>点击圆点或文字一键切换至对应阶段。</span></div></div><div className="stage-timeline">{STAGES.map((stage, i) => { const currentIdx = STAGES.indexOf(selectedActivity?.status || 'recruiting'); const isCurrent = i === currentIdx; const isPast = i < currentIdx; return <div key={stage} className={`stage-node ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}><button className="stage-dot-btn" disabled={isCurrent || advancing} onClick={() => goToStage(stage)} title={`切换到：${STAGE_LABEL[stage]}`}><span className="stage-dot"/></button><button className="stage-label" disabled={isCurrent || advancing} onClick={() => goToStage(stage)}>{STAGE_LABEL[stage]}</button></div> })}</div></section>
          <section className="panel applicants-panel"><div className="panel-head"><div><h3>答主报名</h3><p>查看答主报名、Key 领取和内容提交状态。</p></div><button className="primary compact" onClick={() => setApplicationModal(true)}><Icon name="plus" size={15}/> 新增报名</button></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>查看主页</th><th className="th-sort" onClick={() => toggleOverviewSort('status')}>入选状态{overviewSort?.key === 'status' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th>{(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? <th>版本</th> : null })()}<th className="th-sort" onClick={() => toggleOverviewSort('claimed')}>是否领取 Key{overviewSort?.key === 'claimed' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th><th className="th-sort" onClick={() => toggleOverviewSort('delivered')}>是否提交内容{overviewSort?.key === 'delivered' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th><th>合作方推荐</th><th>操作</th></tr></thead><tbody>{overviewApplications.length ? overviewApplications.map((person) => <tr key={person.id}><td><div className="person">{answererByName[person.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[person.zhihu_name].avatar_url} alt="" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) setSelectedAnswerer(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) setSelectedAnswerer(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{person.zhihu_name[0]}</span>}<div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td>{(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? <td><span className="pill">{platformLabel[person.selected_platform] || 'Steam'}</span></td> : null })()}<td><span className={`pill ${person.keyflow_keys?.claimed_at || exemptedIds.includes(person.answerer_id) ? 'success' : 'muted'}`}>{person.keyflow_keys?.claimed_at || exemptedIds.includes(person.answerer_id) ? '已领取' : '未领取'}</span></td><td><button className={`pill pill-link ${(Array.isArray(person.keyflow_deliveries) ? person.keyflow_deliveries.length > 0 : person.keyflow_deliveries?.id) ? 'success' : 'muted'}`} onClick={() => setActive('交付验收')}>{(Array.isArray(person.keyflow_deliveries) ? person.keyflow_deliveries.length > 0 : person.keyflow_deliveries?.id) ? '已提交' : '未提交'}</button></td><td>{person.partner_recommended ? <span className="highlight-red">推荐</span> : '—'}</td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => reviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => reviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" disabled={!!person.keyflow_keys?.claimed_at} onClick={() => reviewApplication(person.id, 'pending')}>重新筛选</button>}</div></td></tr>) : <tr><td colSpan={(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? 8 : 7 })()} className="table-empty">还没有报名记录。可添加测试报名，或后续将表单公开给答主填写。</td></tr>}</tbody></table></div></section>
        </> : active === '活动看板' ? <div className="activity-cards">{filteredBoardActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); const creatingCount = apps.filter(a => a.status === 'selected' && a.keyflow_keys?.claimed_at).length; const deliveredCount = apps.filter(a => Array.isArray(a.keyflow_deliveries) ? a.keyflow_deliveries.length > 0 : a.keyflow_deliveries?.id).length; const mainQuestionUrl = item.main_question?.match(/https?:\/\/[^\s]+/)?.[0]; return <div key={item.id} className={`activity-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setActive('活动概览') }}><button className="activity-card-delete" title="删除活动" onClick={(e) => deleteActivity(item.id, e)}><Icon name="close" size={14}/></button><button className={`activity-card-fav ${item.is_favorite ? 'active' : ''}`} title={item.is_favorite ? '取消收藏' : '收藏'} onClick={(e) => toggleFavorite(item.id, item.is_favorite, e)}><Icon name="star" size={14}/></button><div className="activity-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="activity-card-body"><p className="activity-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="activity-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{item.status === 'delivery' ? `${creatingCount} 人创作中` : item.status === 'completed' ? `${deliveredCount} 篇作品` : <>{apps.length} 报名{apps.filter(a => a.status === 'pending').length > 0 && <span className="text-red"> {apps.filter(a => a.status === 'pending').length} 未处理</span>}</>}</span></div><small className={(item.status === 'recruiting' && item.application_deadline && new Date(item.application_deadline) < new Date()) ? 'text-red' : ''}>{getStatusTimeText(item, apps)}</small><div className="activity-card-actions"><div className="activity-card-online" onClick={(e) => toggleOnline(item.id, item.is_online !== false, e)} title={item.is_online !== false ? '已上线，点击下线' : '未上线，点击上线'}><span className={`online-toggle ${item.is_online !== false ? 'active' : ''}`}><span className="online-toggle-knob"/></span><span className="online-label">{item.is_online !== false ? '已上线' : '未上线'}</span></div>{mainQuestionUrl ? <a className="main-question-link" href={mainQuestionUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>跳转主问题</a> : <span className="main-question-unconfigured">暂未配置主问题</span>}</div></div></div> })}</div> : active === '答主报名' ? <ApplicationsPage activity={selectedActivity} applications={filteredApplications} answerers={answerers} authorStats={authorStats} statusLabel={statusLabel} onSelectActivity={openDrawer} onAddApplication={() => setApplicationModal(true)} onReviewApplication={reviewApplication} onDeleteApplication={deleteApplication} toast={toast} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === 'Key 管理' ? <KeyManagement activity={selectedActivity} input={keyInput} parsedKeys={parsedKeys} platformCounts={platformCounts} importedKeys={keys.filter((item) => item.activity_id === selectedActivity?.id)} importing={keyImporting} onInput={setKeyInput} onImport={importKeys} onDeleteKeys={deleteKeys} onSelectActivity={openDrawer} applications={filteredApplications} toast={toast}/> : active === '交付验收' ? <DeliveriesPage activity={selectedActivity} deliveries={activityDeliveries} applications={filteredApplications} answerers={answerers} statusLabel={deliveryStatusLabel} notes={deliveryNotes} onNoteChange={(id, value) => setDeliveryNotes((items) => ({ ...items, [id]: value }))} onReview={reviewDelivery} onSelectActivity={openDrawer} pendingCount={pendingDeliveries} approvedCount={approvedDeliveries} revisionCount={revisionDeliveries} toast={toast} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '答主管理' ? <AnswererManagement codes={invitationCodes} answerers={answerers} setAnswerers={setAnswerers} activities={activities} applications={applications} deliveries={deliveries} dailySubmissions={dailySubmissions} onAddCodes={prependCodes} onDeleteAnswerer={(id) => setAnswerers((items) => items.filter((item) => item.id !== id))} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '合作方管理' ? <PartnerManagement codes={invitationCodes} answerers={answerers} setAnswerers={setAnswerers} activities={activities} setActivities={setActivities} onAddCodes={prependCodes} onRefresh={loadData} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '全部活动投稿' ? <AllActivitySubmissionsPage deliveries={deliveries} applications={applications} activities={activities} answerers={answerers} toast={toast} /> : active === '答主日常投稿' ? <DailySubmissionsPage submissions={dailySubmissions} answerers={answerers} toast={toast} setDailySubmissions={setDailySubmissions} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '剩余KEY管理' ? <RemainingKeyManagement keys={keys} activities={activities} toast={toast} onDeleteKeys={deleteKeys} onClaimKey={claimKeyRemotely} /> : active === '页面编辑' ? <PageEditor asset={pageAsset} loading={pageAssetLoading} saving={pageAssetSaving} onSelectFile={handlePageAssetFile} onSave={savePageAsset} /> : active === '收件箱' ? <InboxPage messages={inboxMessages} requests={passwordResetRequests} answerers={answerers} onRefresh={loadData} onDeleteMessages={(ids) => { const deletedIds = new Set(ids); setInboxMessages((items) => items.filter((item) => !deletedIds.has(item.id))) }} toast={toast} setConfirmState={setConfirmState} /> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>{active}即将开放</h2><p>请先完成活动与答主报名管理。</p></div>}
      </section>
        {selectedAnswerer && <AnswererParticipationModal answerer={selectedAnswerer} records={participationByAnswerer[selectedAnswerer.id] || []} onClose={() => setSelectedAnswerer(null)} toast={toast} />}
      </main>
    {drawerOpen && <div className="drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><h2>切换活动</h2><button onClick={() => setDrawerOpen(false)}><Icon name="close"/></button></header><div className="drawer-search"><Icon name="grid" size={16}/><input placeholder="搜索活动名称或游戏名…" value={drawerSearch} onChange={(event) => setDrawerSearch(event.target.value)} autoFocus/></div><div className="drawer-list">{filteredDrawerActivities.length ? filteredDrawerActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); return <div key={item.id} className={`drawer-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDrawerOpen(false) }}><div className="drawer-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="drawer-card-body"><p className="drawer-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="drawer-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{apps.length} 报名</span></div></div></div> }) : <div className="drawer-empty">没有匹配的活动</div>}</div></aside></div>}
    {activityModal && <Modal title="创建测评活动" onClose={() => setActivityModal(false)}><form onSubmit={createActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field steam-field"><span>PlayStation 游戏页面</span><div className="steam-input-row"><input type="url" placeholder="https://www.playstation.com/.../games/..." value={activityForm.ps_url || ''} onChange={(event) => setActivityForm({ ...activityForm, ps_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handlePSFetch} disabled={psFetching}>{psFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><DateTimeField label="游戏发售时间" value={activityForm.release_date || ''} onChange={(value) => setActivityForm({ ...activityForm, release_date: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/><PlatformSelector value={activityForm.platforms} onChange={(platforms) => setActivityForm({ ...activityForm, platforms })}/><div className="cover-upload-section"><label className="field"><span>游戏封面</span><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>优先从 Steam 或 PlayStation 抓取；如未抓取到封面，可手动上传。图片不超过 500KB。</small></label><div className="cover-upload-row"><label className="outline-button cover-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleGameCoverFile(e.target.files[0])} hidden/></label>{gameCoverUpload && <button type="button" className="btn-secondary" onClick={() => { setGameCoverUpload(null); setActivityForm(prev => ({ ...prev, game_cover: '' })) }}>移除上传</button>}</div>{gameCoverUpload ? <div className="cover-upload-preview"><img src={gameCoverUpload} alt="手动上传封面"/><span>已手动上传封面（{Math.round(gameCoverUpload.length * 0.75 / 1024)}KB）</span></div> : activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}</div><button className="primary form-submit" disabled={creating}>{creating ? '创建中…' : '保存并创建'}</button></form></Modal>}
    {applicationModal && <Modal title="新增答主报名" onClose={() => setApplicationModal(false)}><form onSubmit={createApplication} className="form-grid"><Field label="知乎 ID（可选，用于防重复）" value={applicationForm.zhihu_id} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_id: value })} placeholder="知乎 OAuth 返回的用户 ID"/><Field label="知乎名称" required value={applicationForm.zhihu_name} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_name: value })}/><Field label="微信名" required value={applicationForm.wechat_name} onChange={(value) => setApplicationForm({ ...applicationForm, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={applicationForm.profile_url} onChange={(value) => setApplicationForm({ ...applicationForm, profile_url: value })}/><Field label="预计完成字数" type="number" required value={applicationForm.expected_word_count} onChange={(value) => setApplicationForm({ ...applicationForm, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setApplicationForm({ ...applicationForm, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span>{(() => { const platforms = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return platforms.length > 1 || platforms[0] !== 'steam' ? <label className="field"><span>游戏版本</span><select value={applicationForm.selected_platform || 'steam'} onChange={(e) => setApplicationForm({ ...applicationForm, selected_platform: e.target.value })}>{platforms.map(p => <option key={p} value={p}>{platformLabel[p] || p}</option>)}</select></label> : null })()}<button className="primary form-submit">保存报名</button></form></Modal>}
    {editActivityModal && <Modal title="编辑活动" onClose={() => setEditActivityModal(false)}><form onSubmit={updateActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field steam-field"><span>PlayStation 游戏页面</span><div className="steam-input-row"><input type="url" placeholder="https://www.playstation.com/.../games/..." value={activityForm.ps_url || ''} onChange={(event) => setActivityForm({ ...activityForm, ps_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handlePSFetch} disabled={psFetching}>{psFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field"><span>关联合作方</span><select value={activityForm.partner_answerer_id || ''} onChange={(e) => setActivityForm({ ...activityForm, partner_answerer_id: e.target.value || null })}><option value="">— 不关联合作方 —</option>{partnerAnswerers.map((a) => <option key={a.id} value={a.id}>{a.zhihu_name}{a.wechat_id ? ` (${a.wechat_id})` : ''}</option>)}</select><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>关联后，该合作方登录可查看此活动协作页。需先在「合作方管理」中生成并注册合作方账号。</small></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><DateTimeField label="游戏发售时间" value={activityForm.release_date || ''} onChange={(value) => setActivityForm({ ...activityForm, release_date: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/><PlatformSelector value={activityForm.platforms} onChange={(platforms) => setActivityForm({ ...activityForm, platforms })}/><div className="cover-upload-section"><label className="field"><span>游戏封面</span><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>优先从 Steam 或 PlayStation 抓取；如未抓取到封面，可手动上传。图片不超过 500KB。</small></label><div className="cover-upload-row"><label className="outline-button cover-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleGameCoverFile(e.target.files[0])} hidden/></label>{gameCoverUpload && <button type="button" className="btn-secondary" onClick={() => { setGameCoverUpload(null); setActivityForm(prev => ({ ...prev, game_cover: '' })) }}>移除上传</button>}</div>{gameCoverUpload ? <div className="cover-upload-preview"><img src={gameCoverUpload} alt="手动上传封面"/><span>已手动上传封面（{Math.round(gameCoverUpload.length * 0.75 / 1024)}KB）</span></div> : activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}</div><button className="primary form-submit">保存修改</button></form></Modal>}
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
    return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 合作方协作页</span></a><div className="step-message"><div className="step-message-icon waiting"><Icon name="users" size={24}/></div><p>登录后查看合作方协作页</p><span>使用你注册的合作方账号登录，即可查看活动报名与交稿进展。</span><div className="dashboard-auth-actions"><a href={loginHref} className="primary">去登录</a><a href="?register&redirect=partner" className="outline-button">去注册</a></div></div></main></div>
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

  const reviewDelivery = async (deliveryId, status) => {
    const { error: requestError } = await supabase.rpc('keyflow_partner_review_delivery', { p_partner_token: token, p_delivery_id: deliveryId, p_status: status })
    if (requestError) return setError(requestError.message)
    setSnapshot(prev => prev ? { ...prev, deliveries: prev.deliveries.map(d => d.id === deliveryId ? { ...d, status } : d) } : prev)
    toast(status === 'approved' ? '已标记为通过' : '已标记为不通过')
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
    const ext = avatarFile.name.split('.').pop() || 'png'
    const filePath = `${answerer.id}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(filePath, avatarFile, { upsert: true })
    if (uploadErr) { setAvatarUploading(false); return }
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath)
    const { error: updateErr } = await supabase.from('keyflow_answerers').update({ avatar_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', answerer.id)
    if (updateErr) { setAvatarUploading(false); return }
    const session = { ...answerer, avatar_url: publicUrl }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    setAvatarUploading(false)
    setAvatarModalOpen(false)
    setAvatarPreview(publicUrl)
    toast('头像已更新')
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
    return others.filter(a => matchesSearch(`${a.game_name || ''} ${a.title || ''}`, gameSwitcherSearch))
  }, [partnerActivities, token, gameSwitcherSearch])

  // ---- 加载中 / 非合作方 ----
  if (isPartner === null) return <div className="partner-page"><div className="partner-loading">正在加载合作方协作页…</div></div>
  if (!isPartner) return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 合作方协作页</span></a><div className="step-message"><p>你的账号不是合作方身份</p><span>请使用合作方邀请码注册的账号登录，或联系运营人员获取合作方账号。</span><div className="dashboard-auth-actions"><button className="outline-button" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}>切换账号</button></div></div></main></div>

  // ---- 无 token：显示合作方活动列表 ----
  if (!token) {
    const stageLabel = { recruiting: '招募中', key_distribution: '发 Key 中', delivery: '交付/创作中', completed: '项目完结' }
    const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - new Date()) / 86400000))
    return <div className="partner-page"><header className="partner-header"><a className="partner-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>合作方协作页</small></a><div className="partner-header-right"><button className="reload outline" onClick={() => { window.location.href = '?dashboard' }}>切换到答主看板</button>{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<div className="dashboard-user-area" onClick={() => setDropdownOpen(!dropdownOpen)}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main"><section className="partner-hero" style={{ '--partner-hero-rgb': heroColor }}><div className="partner-hero-content"><h1>我的合作活动</h1><span>点击进入活动协作页查看详情。</span></div></section><section className="dashboard-activity-cards">{partnerActivities === null ? <div className="partner-loading">正在加载活动列表…</div> : !partnerActivities.length ? <div className="panel" style={{gridColumn:'1/-1'}}><div className="step-message"><p>您的游戏如需招募测评，请联系管理员</p><span>vx：cmyk3165</span></div></div> : partnerActivities.map((activity) => <a className="dashboard-activity-card" href={`?partner=${activity.partner_token}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>{activity.status === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}{activity.status === 'key_distribution' && <span className="dashboard-deadline">已有 {activity.key_claimed_count || 0} 人领取key</span>}{activity.status === 'recruiting' && <span className="dashboard-deadline">已有 {activity.application_count || 0} 人报名</span>}</div></div></a>)}</section></main>
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

  return <div className="partner-page"><header className="partner-header"><a className="partner-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>合作方协作页</small></a><div className="partner-header-right"><button className="reload outline" onClick={() => { window.location.href = '?dashboard' }}>切换到答主看板</button>{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<button className="reload" onClick={loadSnapshot}>刷新数据</button>{partnerActivities && partnerActivities.filter(a => a.partner_token !== token).length > 0 && <button className="reload" onClick={() => { setGameSwitcherOpen(true); setGameSwitcherSearch(''); setDropdownOpen(false) }}>切换游戏</button>}<div className="dashboard-user-area" onClick={() => { setDropdownOpen(!dropdownOpen); setGameSwitcherOpen(false) }}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main"><section className="partner-hero" style={{ '--partner-hero-rgb': heroColor }}><div className="partner-hero-content"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>在此补充活动 Key，并实时查看报名与交稿进展。</span><div><span>报名截止 {formatDate(activity.application_deadline)}</span><span>交付截止 {formatDate(activity.delivery_deadline)}</span></div></div>{activity.game_cover && <div className="partner-hero-art" aria-hidden="true"><img src={activity.game_cover} alt="" /></div>}</section>{error && <div className="error-box">操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}<section className="partner-metrics"><div><strong>{keyCount}</strong><span>已入库 Key</span></div><div><strong>{applications.length}</strong><span>累计报名</span></div><div><strong>{selectedCount}</strong><span>已入选答主</span></div><div><strong>{deliveries.length}</strong><span>已交稿</span></div></section><section className="partner-grid"><section className="panel partner-key-panel"><div className="panel-head"><div><h3>添加 Key</h3><p>每行一个，也支持逗号、分号和制表符分隔；平台将自动识别。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => setInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>{parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div></div>}<div className="key-import-footer"><span>重复 Key 将自动跳过，Key 明文不会展示在数据列表中。</span><button className="primary" onClick={importKeys} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section><section className="panel partner-progress"><div className="panel-head"><div><h3>进度说明</h3><p>活动数据由运营方维护，以下信息会实时更新。</p></div></div><div className="progress-list"><div><Icon name="users"/><span>报名情况</span><strong>{applications.length} 人</strong></div><div><Icon name="check"/><span>入选答主</span><strong>{selectedCount} 人</strong></div><div><Icon name="file"/><span>交稿情况</span><strong>{deliveries.length} 篇</strong></div></div><a className="partner-apply-link" href={window.location.origin + window.location.pathname + '?apply=' + activity.id}>点击进入答主报名页面</a></section></section><section className="panel partner-table"><div className="panel-head"><div><h3>报名情况</h3><p>展示答主信息，合作方可标记推荐人选。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>知乎主页</th><th>字数预估</th><th>推荐入选</th><th>报名时间</th><th>状态</th></tr></thead><tbody>{applications.length ? applications.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td><span className="person-name">{item.zhihu_name}</span></td><td><a className="profile-link" href={item.profile_url} target="_blank" rel="noreferrer">查看主页 <Icon name="arrow" size={13}/></a></td><td>{item.expected_word_count ? `${item.expected_word_count.toLocaleString()} 字` : '—'}</td><td><button className={`recommend-toggle ${item.partner_recommended ? 'active' : ''}`} onClick={() => toggleRecommend(item.id)} title={item.partner_recommended ? '取消推荐' : '推荐入选'}>{item.partner_recommended ? '已推荐' : '推荐'}</button></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'selected' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{applicationStatus[item.status]}</span></td></tr>) : <tr><td colSpan="6" className="table-empty">暂无报名记录。</td></tr>}</tbody></table></div></section><section className="panel partner-table"><div className="panel-head"><div><h3>交稿情况</h3><p>合作方可审核作品，标记通过或不通过将直接作用于后台。</p></div></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>交稿时间</th><th>审核状态</th><th>作品</th><th>是否通过</th></tr></thead><tbody>{deliveries.length ? deliveries.map((item, index) => <tr key={`${item.zhihu_name}-${index}`}><td>{item.zhihu_name}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.submitted_at))}</td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' ? 'warning' : 'muted'}`}>{deliveryStatus[item.status]}</span></td><td><a className="profile-link" href={cleanZhihuAnswerUrl(item.article_url)} target="_blank" rel="noreferrer">查看作品</a></td><td>{item.status === 'approved' || item.status === 'rejected' ? <span className={`pill ${item.status === 'approved' ? 'success' : 'muted'}`}>{item.status === 'approved' ? '已通过' : '未通过'}</span> : <div className="partner-review-actions"><button className="compact success" onClick={() => reviewDelivery(item.id, 'approved')}>通过</button><button className="compact danger" onClick={() => reviewDelivery(item.id, 'rejected')}>不通过</button></div>}</td></tr>) : <tr><td colSpan="5" className="table-empty">暂无交稿记录。</td></tr>}</tbody></table></div></section></main>
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

function KeyManagement({ activity, input, parsedKeys, platformCounts, importedKeys, importing, onInput, onImport, onDeleteKeys, onSelectActivity, applications, toast }) {
  const [revealedKeys, setRevealedKeys] = useState({})
  const [revealingKeyId, setRevealingKeyId] = useState('')
  const [exporting, setExporting] = useState(false)
  const [selectedKeyIds, setSelectedKeyIds] = useState(new Set())
  const [deleting, setDeleting] = useState(false)

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
      const status = row.application_id || row.claimed_at ? '已领取' : '待领取'
      const applicant = row.application_id ? (row.applicant_name || '/') : row.claimed_at ? '管理员' : '/'
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

  const availableCount = importedKeys.filter((item) => !item.application_id && !item.claimed_at).length
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
  const toggleKeySelect = (id) => setSelectedKeyIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleKeySelectAll = () => setSelectedKeyIds((prev) => prev.size === importedKeys.length ? new Set() : new Set(importedKeys.map((k) => k.id)))
  const batchDeleteKeys = async () => {
    setDeleting(true)
    await onDeleteKeys([...selectedKeyIds])
    setSelectedKeyIds(new Set())
    setDeleting(false)
  }
  const deleteSingleKey = async (id) => {
    setDeleting(true)
    await onDeleteKeys([id])
    setDeleting(false)
  }

  return <div className="key-management">
    <section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section>
    <section className="key-stats">{[{ count: importedKeys.length, label: '已入库' }, { count: availableCount, label: '待领取' }, { count: claimedCount, label: '已领取', highlight: allClaimed }, { count: applicantCount, label: '报名人数' }, { count: passedCount, label: '通过人数', highlight: allClaimed }, { count: `${unclaimedPassed} / ${availableCount}`, label: '待分发(通过/库存)' }].map(({ count, label, highlight }) => <div className={`key-stat${highlight ? ' matched' : ''}`} key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel key-import-panel"><div className="panel-head"><div><h3>批量导入 Key</h3><p>每行一个 Key，也支持逗号、分号或制表符分隔。系统会自动去重并识别平台。</p></div></div><div className="key-import-body"><textarea className="key-textarea" value={input} onChange={(event) => onInput(event.target.value)} placeholder={'示例：\nABCDE-FGHIJ-KLMNO-PQRST\nABCD-EFGH-IJKL-MNOP\nABCD-EFGH-IJKL\nABCDEFGHIJKL'}/>{parsedKeys.length > 0 && <div className="key-preview"><div className="key-preview-head"><strong>导入预览</strong><span>共 {parsedKeys.length} 个唯一 Key</span></div><div className="platform-summary">{Object.entries(platformCounts).map(([platform, count]) => <span className={`platform-tag ${platform}`} key={platform}>{platformLabel[platform]} {count}</span>)}</div><div className="key-preview-list">{parsedKeys.slice(0, 8).map(({ key_value, platform }) => <div key={key_value}><code>{key_value}</code><span className={`platform-tag ${platform}`}>{platformLabel[platform]}</span></div>)}{parsedKeys.length > 8 && <p>另有 {parsedKeys.length - 8} 个 Key 将一并导入</p>}</div></div>}<div className="key-import-footer"><span>未识别的格式会标记为「未识别」，仍可入库供后续处理。</span><button className="primary" onClick={onImport} disabled={!parsedKeys.length || importing}>{importing ? '入库中…' : `确认入库 ${parsedKeys.length} 个 Key`}</button></div></div></section>
          <section className="panel key-inventory"><div className="panel-head"><div><h3>库存概览</h3><p>点击眼睛图标按需查看 Key 明文。</p></div><button className="outline-button" onClick={handleExportExcel} disabled={exporting}>{exporting ? '导出中…' : '下载Excel'}</button></div>{selectedKeyIds.size > 0 && <div className="batch-actions"><span>已选 <strong>{selectedKeyIds.size}</strong> 项</span><button className="delete-action" onClick={batchDeleteKeys} disabled={deleting}>{deleting ? '删除中…' : '批量删除'}</button><button className="reset-action" onClick={() => setSelectedKeyIds(new Set())}>取消选择</button></div>}<div className="table-wrap"><table><thead><tr><th><input type="checkbox" checked={importedKeys.length > 0 && selectedKeyIds.size === importedKeys.length} onChange={toggleKeySelectAll}/></th><th>#</th><th>Key</th><th>显示key</th><th>平台</th><th>状态</th><th>领取人</th><th>入库时间</th><th>领取时间</th><th>操作</th></tr></thead><tbody>{importedKeys.length ? importedKeys.map((item, i) => <tr key={item.id}><td><input type="checkbox" checked={selectedKeyIds.has(item.id)} onChange={() => toggleKeySelect(item.id)}/></td><td>{i + 1}</td><td><code className="inventory-key">{revealedKeys[item.id] || '••••••••••••••••'}</code></td><td><button className="key-visibility-button" onClick={() => toggleKeyVisibility(item.id)} disabled={revealingKeyId === item.id} aria-label={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'} title={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'}><Icon name={revealedKeys[item.id] ? 'eyeOff' : 'eye'} size={17}/></button></td><td><span className={`platform-tag ${item.platform}`}>{platformLabel[item.platform] || '未识别'}</span></td><td><span className={`pill ${(item.application_id || item.claimed_at) ? 'success' : 'warning'}`}>{(item.application_id || item.claimed_at) ? '已领取' : '待领取'}</span></td><td>{item.application_id ? applicantByAppId[item.application_id] || '/' : item.claimed_at ? '管理员' : '/'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td><td>{item.claimed_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.claimed_at)) : '/'}</td><td><button className="delete-action" onClick={() => deleteSingleKey(item.id)} disabled={deleting} title="删除此 Key">删除</button></td></tr>) : <tr><td colSpan="10" className="table-empty">当前活动尚未导入 Key。</td></tr>}</tbody></table></div></section>
  </div>
}

function RemainingKeyManagement({ keys, activities, toast, onDeleteKeys, onClaimKey }) {
  const [revealedKeys, setRevealedKeys] = useState({})
  const [revealingKeyId, setRevealingKeyId] = useState('')
  const [claimingId, setClaimingId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [localClaimed, setLocalClaimed] = useState({})
  const [tab, setTab] = useState('remaining')

  const activityNameMap = useMemo(() => {
    const map = {}
    activities.forEach(a => { map[a.id] = a.game_name || a.title })
    return map
  }, [activities])

  const remainingKeys = useMemo(() =>
    keys.filter(k => !k.application_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    [keys]
  )

  const manualClaimedKeys = useMemo(() => {
    const fromDB = keys.filter(k => !k.application_id && k.claimed_at)
    const fromLocal = keys.filter(k => localClaimed[k.id] && !k.claimed_at)
    const seen = new Set(fromDB.map(k => k.id))
    const merged = [...fromDB]
    fromLocal.forEach(k => { if (!seen.has(k.id)) merged.push(k) })
    return merged.sort((a, b) => {
      const ta = b.claimed_at || localClaimed[b.id] || ''
      const tb = a.claimed_at || localClaimed[a.id] || ''
      return new Date(ta) - new Date(tb)
    })
  }, [keys, localClaimed])

  const toggleKeyVisibility = async (id) => {
    if (revealedKeys[id]) return setRevealedKeys(prev => ({ ...prev, [id]: '' }))
    setRevealingKeyId(id)
    const { data, error } = await supabase.rpc('keyflow_reveal_key', { p_key_id: id })
    setRevealingKeyId('')
    if (!error) setRevealedKeys(prev => ({ ...prev, [id]: data }))
  }

  const handleClaim = async (id) => {
    const now = new Date()
    setClaimingId(id)
    const { error } = await supabase.from('keyflow_keys').update({ claimed_at: now.toISOString() }).eq('id', id)
    setClaimingId(null)
    if (error) return toast('取用失败: ' + error.message)
    setLocalClaimed(prev => ({ ...prev, [id]: now.toISOString() }))
    onClaimKey(id)
    toast('Key 已标记为已领取')
  }

  const handleDelete = async (id) => {
    if (!window.confirm('确定删除此 Key？此操作不可撤销。')) return
    setDeleting(true)
    await onDeleteKeys([id])
    setDeleting(false)
  }

  const currentList = tab === 'remaining' ? remainingKeys : manualClaimedKeys

  return <div className="key-management">
    <div className="sub-tabs">
      <button className={`sub-tab ${tab === 'remaining' ? 'active' : ''}`} onClick={() => setTab('remaining')}>剩余 KEY 库存</button>
      <button className={`sub-tab ${tab === 'manual' ? 'active' : ''}`} onClick={() => setTab('manual')}>人工领取KEY</button>
    </div>
    <section className="panel key-inventory">
      <div className="panel-head">
        <div>
          <h3>{tab === 'remaining' ? '剩余 KEY 库存' : '人工领取KEY'}</h3>
          <p>{tab === 'remaining' ? '所有游戏中未领取的 Key 一览，可手动取用或删除。' : '由管理员手动取用的 Key 记录。'}</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>游戏名</th>
              <th>KEY</th>
              <th>显示KEY</th>
              <th>平台</th>
              <th>状态</th>
              <th>入库时间</th>
              <th>领取时间</th>
              <th>{tab === 'remaining' ? '取用' : '领取人'}</th>
              <th>删除</th>
            </tr>
          </thead>
          <tbody>
            {currentList.length ? currentList.map((item, i) => {
              const isClaimed = item.claimed_at || localClaimed[item.id]
              return (
              <tr key={item.id}>
                <td>{i + 1}</td>
                <td>{activityNameMap[item.activity_id] || '/'}</td>
                <td><code className="inventory-key">{revealedKeys[item.id] || '••••••••••••••••'}</code></td>
                <td>
                  <button className="key-visibility-button" onClick={() => toggleKeyVisibility(item.id)} disabled={revealingKeyId === item.id} title={revealedKeys[item.id] ? '隐藏 Key 明文' : '显示 Key 明文'}>
                    <Icon name={revealedKeys[item.id] ? 'eyeOff' : 'eye'} size={17}/>
                  </button>
                </td>
                <td><span className={`platform-tag ${item.platform}`}>{platformLabel[item.platform] || '未识别'}</span></td>
                <td><span className={`pill ${tab === 'manual' || isClaimed ? 'success' : 'warning'}`}>{tab === 'manual' || isClaimed ? '已领取' : '未领取'}</span></td>
                <td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.created_at))}</td>
                <td>{isClaimed ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(isClaimed)) : '/'}</td>
                <td>
                  {tab === 'manual'
                    ? <span>管理员</span>
                    : isClaimed
                      ? <span className="pill success" style={{ fontSize: 'var(--fs-label)' }}>已领取</span>
                      : <button className="select-action" onClick={() => handleClaim(item.id)} disabled={claimingId === item.id}>
                          {claimingId === item.id ? '…' : '取用'}
                        </button>
                  }
                </td>
                <td>
                  <button className="delete-action" onClick={() => handleDelete(item.id)} disabled={deleting}>删除</button>
                </td>
              </tr>
            )}) : <tr><td colSpan="10" className="table-empty">{tab === 'remaining' ? '所有 Key 已领取完毕。' : '暂无人工领取记录。'}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  </div>
}

function ApplicationsPage({ activity, applications, answerers, authorStats, statusLabel, onSelectActivity, onAddApplication, onReviewApplication, onDeleteApplication, toast, participationByAnswerer, onViewAnswererParticipation }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const [sort, setSort] = useState({ key: 'submitted_at', dir: -1 })
  const [selectedIds, setSelectedIds] = useState(new Set())
  const visibleApplications = useMemo(() => {
    const value = (person) => {
      const matched = answererByName[person.zhihu_name]
      const records = matched ? (participationByAnswerer[matched.id] || []) : []
      const selectedRecords = records.filter((r) => r.status === 'selected')
      const completed = records.filter((r) => (r.all_deliveries || []).some((d) => d.article_url)).length
      const rate = selectedRecords.length ? completed / selectedRecords.length : -1
      switch (sort.key) {
        case 'expected_word_count': return person.expected_word_count || 0
        case 'completion_rate': return rate
        case 'participations': return selectedRecords.length
        case 'completions': return completed
        case 'delayed': return person.delayed_count || 0
        case 'recommended': return person.partner_recommended ? 1 : 0
        default: return new Date(person.submitted_at).getTime() || 0
      }
    }
    return applications.filter((person) => (statusFilter === 'all' || person.status === statusFilter) && matchesSearch(`${person.zhihu_name || ''} ${person.wechat_name || ''}`, keyword)).sort((a, b) => (value(a) - value(b)) * sort.dir)
  }, [applications, keyword, statusFilter, sort, answererByName, participationByAnswerer])
  const activityPlatforms = Array.isArray(activity?.platforms) && activity.platforms.length ? activity.platforms : ['steam']
  const showVersion = activityPlatforms.length > 1 || activityPlatforms[0] !== 'steam'

  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动后即可收集和筛选答主报名。</p></div>

  const statusCounts = { all: applications.length, pending: applications.filter((person) => person.status === 'pending').length, selected: applications.filter((person) => person.status === 'selected').length, rejected: applications.filter((person) => person.status === 'rejected').length }
  const filters = [['all', '全部'], ['pending', '待筛选'], ['selected', '已入选'], ['rejected', '未入选']]
  const toggleSelect = (id) => setSelectedIds((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleSelectAll = () => setSelectedIds((prev) => prev.size === visibleApplications.length && visibleApplications.every((p) => prev.has(p.id)) ? new Set() : new Set(visibleApplications.map((p) => p.id)))
  const batchReview = async (status) => { for (const id of selectedIds) await onReviewApplication(id, status); setSelectedIds(new Set()) }
  const downloadExcel = () => {
    const headers = showVersion ? ['答主', '知乎主页', '微信名', '版本', '预计字数', '报名时间', '活动参与次数', '成功完成次数', '完成率', '延迟提交', '合作方推荐', '状态'] : ['答主', '知乎主页', '微信名', '预计字数', '报名时间', '活动参与次数', '成功完成次数', '完成率', '延迟提交', '合作方推荐', '状态']
    const rows = visibleApplications.map((p) => {
      const matchedAnswerer = answererByName[p.zhihu_name]
      const records = matchedAnswerer ? (participationByAnswerer[matchedAnswerer.id] || []) : []
      const selectedRecords = records.filter((r) => r.status === 'selected')
      const completed = records.filter((r) => (r.all_deliveries || []).some(d => d.article_url)).length
      const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'
      const base = [p.zhihu_name, p.profile_url, p.wechat_name]
      if (showVersion) base.push(platformLabel[p.selected_platform] || 'Steam')
      base.push(`${p.expected_word_count}`, new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(p.submitted_at)), `${selectedRecords.length}`, `${completed}`, rate, `${p.delayed_count}`, p.partner_recommended ? '推荐' : '—', statusLabel[p.status])
      return base
    })
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activity.title}_报名表.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('报名表已下载')
  }

  const sortTh = (field, label) => (
    <th className="th-sort" onClick={() => setSort((prev) => (prev.key === field ? { key: field, dir: -prev.dir } : { key: field, dir: -1 }))}>{label}{sort.key === field ? <span className="th-sort-arrow">{sort.dir === -1 ? '↑' : '↓'}</span> : null}</th>
  )

  return <section className="applications-workspace">
    <section className="activity-picker">
      <button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button>
    </section>
    <section className="application-summary">{[[applications.length, '累计报名'], [statusCounts.pending, '待筛选'], [`${statusCounts.selected} / ${activity.target_authors}`, '已入选 / 目标人数']].map(([count, label]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</section>
    <section className="panel applications-panel">
      <div className="application-toolbar"><div className="application-filters">{filters.map(([value, label]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>{label}<b>{statusCounts[value]}</b></button>)}</div><div className="application-controls"><input aria-label="搜索答主" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索知乎名或微信名"/><button className="outline-button" onClick={downloadExcel} title="下载当前表格为 Excel">Excel下载</button></div></div>
      {selectedIds.size > 0 && <div className="batch-actions"><span>已选 <strong>{selectedIds.size}</strong> 项</span><button className="select-action" onClick={() => batchReview('selected')}>批量入选</button><button className="reject-action" onClick={() => batchReview('rejected')}>批量不选</button><button className="reset-action" onClick={() => setSelectedIds(new Set())}>取消选择</button></div>}
      <div className="table-wrap"><table className="applications-table"><thead><tr><th><input type="checkbox" checked={visibleApplications.length > 0 && visibleApplications.every((p) => selectedIds.has(p.id))} onChange={toggleSelectAll}/></th><th>答主</th><th>知乎主页</th><th>微信名</th>{showVersion && <th>版本</th>}{sortTh('expected_word_count', '预计字数')}{sortTh('submitted_at', '报名时间')}{sortTh('participations', '活动参与次数')}{sortTh('completions', '成功完成次数')}{sortTh('completion_rate', '完成率')}{sortTh('delayed', '延迟提交')}{sortTh('recommended', '合作方推荐')}<th>状态</th><th>操作</th></tr></thead><tbody>{visibleApplications.length ? visibleApplications.map((person) => { const matchedAnswerer = answererByName[person.zhihu_name]; const records = matchedAnswerer ? (participationByAnswerer[matchedAnswerer.id] || []) : []; const selectedRecords = records.filter((r) => r.status === 'selected'); const completed = records.filter((r) => (r.all_deliveries || []).some(d => d.article_url)).length; const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'; return <tr key={person.id}><td><input type="checkbox" checked={selectedIds.has(person.id)} onChange={() => toggleSelect(person.id)}/></td><td><div className="person">{answererByName[person.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[person.zhihu_name].avatar_url} alt="" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{person.zhihu_name[0]}</span>}<div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td>{(person.wechat_name || matchedAnswerer?.wechat_id) ? <span className="copyable-text" onClick={() => { navigator.clipboard.writeText(person.wechat_name || matchedAnswerer.wechat_id); toast('微信名已复制') }} title="点击复制">{person.wechat_name || matchedAnswerer.wechat_id}</span> : '—'}</td>{showVersion && <td><span className="pill">{platformLabel[person.selected_platform] || 'Steam'}</span></td>}<td><span className={`word-count ${person.expected_word_count >= 1500 ? 'highlight-green' : ''}`}>{person.expected_word_count.toLocaleString()} 字</span></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(person.submitted_at))}</td><td><span className="history-count">{selectedRecords.length} <small>次</small></span></td><td><span className={`history-count ${completed !== selectedRecords.length ? 'highlight-red' : ''}`}>{completed} <small>次</small></span></td><td><span className={`history-count ${rate !== '—' && (() => { const r = parseInt(rate); return r <= 25 ? 'highlight-red' : r >= 90 ? 'highlight-green' : ''; })()}`}>{rate}</span></td><td><span className={`history-count ${person.delayed_count > 0 ? 'highlight-red' : ''}`}>{person.delayed_count} <small>次</small></span></td><td>{person.partner_recommended ? <span className="highlight-red">推荐</span> : '—'}</td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => onReviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => onReviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" onClick={() => onReviewApplication(person.id, 'pending')}>重新筛选</button>}<button className="delete-action" onClick={() => onDeleteApplication(person.id)}>删除</button></div></td></tr> }) : <tr><td colSpan={showVersion ? 14 : 13} className="table-empty">没有符合条件的报名记录。</td></tr>}</tbody></table></div>
    </section>
  </section>
}

function DeliveriesPage({ activity, deliveries, applications, answerers, statusLabel, notes, onNoteChange, onReview, onSelectActivity, pendingCount, approvedCount, revisionCount, toast, participationByAnswerer, onViewAnswererParticipation }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const applicationById = useMemo(() => Object.fromEntries(applications.map((item) => [item.id, item])), [applications])
  const [keyword, setKeyword] = useState('')
  const deliveryWithAuthor = useMemo(() => deliveries.map((item) => ({ ...applicationById[item.application_id], ...item })), [deliveries, applicationById])
  const visibleDeliveries = useMemo(() => deliveryWithAuthor.filter((item) => (statusFilter === 'all' || item.status === statusFilter) && matchesSearch(`${item.zhihu_name || ''} ${item.article_title || ''} ${item.article_url || ''}`, keyword)), [deliveryWithAuthor, keyword, statusFilter])
  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动并收到答主交稿后，即可进行交付验收。</p></div>
  const filters = [['all', '全部', deliveries.length], ['pending', '待审核', pendingCount], ['approved', '已通过', approvedCount], ['revision_required', '需修改', revisionCount], ['rejected', '未通过', deliveries.filter((item) => item.status === 'rejected').length]]
  const downloadExcel = () => {
    const headers = ['答主', '微信名', '作品标题', '作品链接', '提交时间', '字数', '审核备注', '状态']
    const rows = visibleDeliveries.map((item) => [item.zhihu_name || '', item.wechat_name || '', item.article_title || '', cleanZhihuAnswerUrl(item.article_url) || '', new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at)), item.verified_word_count || item.claimed_word_count || '待核对', notes[item.id] ?? item.reviewer_note ?? '', statusLabel[item.status]])
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activity.title}_交付验收表.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('交付验收表已下载')
  }
  return <div className="delivery-workspace"><section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section><section className="delivery-stats"><div><strong>{deliveries.length}</strong><span>已提交</span></div><div><strong>{pendingCount}</strong><span>待审核</span></div><div><strong>{approvedCount}</strong><span>已通过</span></div><div><strong>{revisionCount}</strong><span>需修改</span></div></section><section className="panel"><div className="panel-head"><div><h3>交付验收</h3><p>核对作品链接与实际字数，保存审核结论后会同步展示给答主。</p></div></div><div className="delivery-toolbar"><div className="acceptance-filters">{filters.map(([value, label, count]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}><span>{label}</span><b>{count}</b></button>)}</div><input aria-label="搜索交付" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索答主或作品链接"/><button className="outline-button" onClick={downloadExcel} title="下载当前表格为 Excel">Excel下载</button></div><div className="table-wrap"><table className="deliveries-table"><thead><tr><th>答主</th><th>作品标题</th><th>作品链接</th><th>提交时间</th><th>字数</th><th>审核备注</th><th>状态</th><th>验收操作</th></tr></thead><tbody>{visibleDeliveries.length ? visibleDeliveries.map((item) => <tr key={item.id}><td><div className="person">{answererByName[item.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[item.zhihu_name].avatar_url} alt="" onClick={() => { const a = answererByName[item.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { const a = answererByName[item.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{item.zhihu_name?.[0] || '答'}</span>}<div><strong>{item.zhihu_name || '答主'}</strong><small>{item.wechat_name || '已交稿'}</small></div></div></td><td>{item.article_title || '-'}</td><td><a className="profile-link" href={cleanZhihuAnswerUrl(item.article_url)} target="_blank" rel="noreferrer">查看作品 <Icon name="arrow" size={13}/></a></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at))}</td><td>{item.verified_word_count || item.claimed_word_count ? `${(item.verified_word_count || item.claimed_word_count).toLocaleString()} 字` : '待核对'}</td><td><input className="delivery-note" value={notes[item.id] ?? item.reviewer_note ?? ''} onChange={(event) => onNoteChange(item.id, event.target.value)} placeholder="填写审核意见"/></td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' || item.status === 'revision_required' ? 'warning' : 'muted'}`}>{statusLabel[item.status]}</span></td><td><div className="review-actions"><button className="select-action" onClick={() => onReview(item, 'approved')}>通过</button><button className="reset-action" onClick={() => onReview(item, 'revision_required')}>需修改</button><button className="reject-action" onClick={() => onReview(item, 'rejected')}>不通过</button></div></td></tr>) : <tr><td colSpan="8" className="table-empty">没有符合条件的交付记录。</td></tr>}</tbody></table></div></section></div>
}

function DateTimeField({ label, value, onChange }) {
  const pad = (n) => String(n).padStart(2, '0')
  const toLocal = (v) => { if (!v) return ''; const m = String(v).match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); return m ? m[0] : '' }
  return <label className="field datetime-field"><span>{label}</span><div className="datetime-row"><input type="datetime-local" value={toLocal(value)} onChange={(e) => onChange(e.target.value)} /><button type="button" className="datetime-btn" onClick={() => onChange('')}>清除</button><button type="button" className="datetime-btn" onClick={() => { if (!value) return; const d = new Date(value); if (isNaN(d.getTime())) return; onChange(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`); }}>最晚</button></div></label>
}

function Field({ label, textarea, wide, required, onChange, onBlur, ...props }) { return <label className={`field ${wide ? 'field-wide' : ''}`}><span>{label}{required ? <span className="req">*</span> : null}</span>{textarea ? <textarea required={required} onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/> : <input required={required} onChange={(event) => onChange(event.target.value)} onBlur={onBlur ? (event) => onBlur(event) : undefined} {...props}/>}</label> }
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
  const [avatarMsg, setAvatarMsg] = useState('')
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
  const [dailyUrl, setDailyUrl] = useState('')
  const [dailyTitle, setDailyTitle] = useState('')
  const [dailySubmitting, setDailySubmitting] = useState(false)
  const [dailyMsg, setDailyMsg] = useState('')
  const [dailySuccessOpen, setDailySuccessOpen] = useState(false)
  const [completedModalOpen, setCompletedModalOpen] = useState(false)
  const [participatedModalOpen, setParticipatedModalOpen] = useState(false)
  const [completedActivities, setCompletedActivities] = useState([])
  const [participatedActivities, setParticipatedActivities] = useState([])
  const historicalMoreCovers = useMemo(() => {
    const activities = dashboard?.historical_activities || []
    const rank = (id = '') => [...id].reduce((value, char) => ((value << 5) - value + char.charCodeAt(0)) | 0, 0)
    return activities.slice(3).sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 9)
  }, [dashboard?.historical_activities])

  const loadCompletedActivities = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_answerer_completed_activities', { p_answerer_id: answerer.id })
    setCompletedActivities(data || [])
  }

  const loadParticipatedActivities = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_answerer_participated_activities', { p_answerer_id: answerer.id })
    setParticipatedActivities(data || [])
  }

  const loadDashboard = async () => {
    // #region debug-point C:dashboard-request
    const traceId = crypto.randomUUID(); const dashboardStartedAt = performance.now(); const reportDashboard = (hypothesisId, msg, data = {}) => fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'daily-submit-freeze', runId: 'pre-fix', hypothesisId, traceId, location: 'App.jsx:loadDashboard', msg: `[DEBUG] ${msg}`, data, ts: Date.now() }) }).catch(() => {}); reportDashboard('C', '看板加载开始', { hasAnswerer: !!answerer?.id })
    // #endregion
    if (!answerer?.id) return
    setError('')
    // 第一步：快速加载核心数据，立即渲染页面
    const { data, error: requestError } = await supabase.rpc('keyflow_answerer_dashboard', { p_answerer_id: answerer.id })
    // #region debug-point C:dashboard-response
    reportDashboard('C', '看板核心 RPC 返回', { durationMs: Math.round(performance.now() - dashboardStartedAt), error: requestError?.message ?? null, activities: data?.activities?.length ?? 0 })
    // #endregion
    if (requestError) { setError(requestError.message); return }
    setDashboard(data)
    // 第二步：后台加载扩展数据（more_activities、historical_activities、submissions）
    const { data: extras } = await supabase.rpc('keyflow_answerer_dashboard_extras', { p_answerer_id: answerer.id })
    // #region debug-point D:dashboard-state
    reportDashboard('D', '看板扩展数据返回', { moreActivities: extras?.more_activities?.length ?? 0, historicalActivities: extras?.historical_activities?.length ?? 0, submissions: extras?.submissions?.length ?? 0 })
    // #endregion
    if (extras) setDashboard(current => current ? { ...current, ...extras } : current)
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
    setAvatarMsg('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setAvatarMsg('请选择图片文件'); return }
    if (file.size > 500 * 1024) { setAvatarMsg('图片大小不能超过 500KB，请压缩后重新选择'); return }
    const reader = new FileReader()
    reader.onload = (e) => { setAvatarPreview(e.target.result); setAvatarFile(file) }
    reader.readAsDataURL(file)
  }

  const uploadAvatar = async () => {
    if (!avatarFile) { setAvatarUploading(false); return }
    setAvatarUploading(true)
    const ext = avatarFile.name.split('.').pop() || 'png'
    const filePath = `${answerer.id}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(filePath, avatarFile, { upsert: true })
    if (uploadErr) { setAvatarUploading(false); setAvatarMsg(uploadErr.message); return }
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath)
    const { error: updateErr } = await supabase.from('keyflow_answerers').update({ avatar_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', answerer.id)
    if (updateErr) { setAvatarUploading(false); return }
    const session = { ...answerer, avatar_url: publicUrl }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    setAvatarUploading(false)
    setAvatarModalOpen(false)
    setAvatarPreview(publicUrl)
    setAvatarMsg('头像已更新')
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

  const submitDaily = async (e) => {
    e.preventDefault()
    // #region debug-point A:daily-submit-start
    const traceId = crypto.randomUUID(); const reportDaily = (hypothesisId, msg, data = {}) => fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'daily-submit-freeze', runId: 'pre-fix', hypothesisId, traceId, location: 'App.jsx:submitDaily', msg: `[DEBUG] ${msg}`, data, ts: Date.now() }) }).catch(() => {}); reportDaily('A', '日常投稿开始', { urlLength: dailyUrl.trim().length, titleLength: dailyTitle.trim().length })
    // #endregion
    if (!dailyUrl.trim()) { setDailyMsg('请填写知乎回答链接'); return }
    if (!dailyTitle.trim()) { setDailyMsg('请填写作品标题'); return }
    setDailySubmitting(true)
    setDailyMsg('')
    const activitiesStartedAt = performance.now()
    const { data: activities, error: activitiesErr } = await supabase.from('keyflow_activities').select('game_name').limit(500)
    // #region debug-point A:activities-response
    reportDaily('A', '活动列表查询返回', { durationMs: Math.round(performance.now() - activitiesStartedAt), count: activities?.length ?? 0, error: activitiesErr?.message ?? null })
    // #endregion
    if (activitiesErr) { setDailyMsg(activitiesErr.message); setDailySubmitting(false); return }
    const normalizedTitle = dailyTitle.trim().normalize('NFKC').toLocaleLowerCase()
    if (activities.some(({ game_name }) => game_name?.trim() && normalizedTitle.includes(game_name.trim().normalize('NFKC').toLocaleLowerCase())) && !window.confirm('您的稿件可能是活动稿件，不建议日常投稿。确定要投稿吗？')) { setDailySubmitting(false); return }
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const countStartedAt = performance.now()
    const { count: todayCount, error: countErr } = await supabase.from('keyflow_daily_submissions')
      .select('*', { count: 'exact', head: true }).eq('answerer_id', answerer.id).gte('created_at', todayStart.toISOString())
    // #region debug-point B:daily-count-response
    reportDaily('B', '当日投稿计数返回', { durationMs: Math.round(performance.now() - countStartedAt), count: todayCount ?? null, error: countErr?.message ?? null })
    // #endregion
    if (countErr) { setDailyMsg(countErr.message); setDailySubmitting(false); return }
    if (todayCount >= 1) { setDailyMsg('今日已投稿，每天限投一条'); setDailySubmitting(false); return }
    const insertStartedAt = performance.now()
    const { error: insertErr } = await supabase.from('keyflow_daily_submissions').insert({
      answerer_id: answerer.id,
      article_url: cleanZhihuAnswerUrl(dailyUrl.trim()),
      article_title: dailyTitle.trim(),
    })
    // #region debug-point B:daily-insert-response
    reportDaily('B', '日常投稿写入返回', { durationMs: Math.round(performance.now() - insertStartedAt), error: insertErr?.message ?? null })
    // #endregion
    setDailySubmitting(false)
    if (insertErr) { setDailyMsg(insertErr.message); return }
    setDailyUrl('')
    setDailyTitle('')
    setDailyMsg('投稿成功！')
    setDailySuccessOpen(true)
    setDashboard(current => current ? { ...current, daily_submission_count: (current.daily_submission_count || 0) + 1 } : current)
    // #region debug-point C:daily-submit-complete
    reportDaily('C', '投稿成功并更新本地计数')
    // #endregion
  }

  useEffect(() => {
    // 并行发起所有独立请求，减少串行等待时间
    Promise.all([
      loadDashboard(),
      loadSharedCode(),
      fetchUnreadCount(),
      (async () => { if (answerer?.id) { const { data } = await supabase.rpc('keyflow_is_partner', { p_answerer_id: answerer.id }); setIsPartner(!!data) } })(),
    ])
  }, [])

  useEffect(() => {
    if (!answerer?.id) return
    const channel = supabase
      .channel('answerer-inbox-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'keyflow_inbox', filter: `to_id=eq.${answerer.id}` }, (payload) => {
        if (payload.new.type === 'private_message' && payload.new.status === 'unread') {
          setUnreadInboxCount(prev => prev + 1)
          setAnswererInbox(prev => inboxModalOpen ? [payload.new, ...prev] : prev)
        }
      })
      .subscribe()
    return () => { channel.unsubscribe() }
  }, [answerer?.id, inboxModalOpen])

  if (!answerer) return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主看板</span></a><div className="step-message"><div className="step-message-icon waiting"><Icon name="users" size={24}/></div><p>登录后查看你的测评活动</p><span>注册答主账号后即可查看报名与交稿记录。</span><div className="dashboard-auth-actions"><a href="?login" className="primary">去登录</a><a href="?register" className="outline-button">去注册</a></div></div></main></div>
  if (!dashboard && !error) return <div className="partner-page"><div className="partner-loading">正在加载答主看板…</div></div>
  if (!dashboard) return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主看板</span></a><div className="step-message"><p>{error || '看板加载失败'}</p><button className="outline-button" onClick={loadDashboard}>重新加载</button></div></main></div>

  const stageLabel = { recruiting: '招募中', key_distribution: '发 Key 中', delivery: '交付/创作中', completed: '项目完结' }
  const getPersonalStage = (activity) => { if (activity.application_status === 'selected') return activity.key_claimed ? 'delivery' : 'key_distribution'; return activity.status }
  const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - new Date()) / 86400000))
  const formatSubmittedAt = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

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
  return <div className="partner-page"><header className="partner-header"><a className="partner-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>答主看板</small></a><div className="partner-header-right">{(isPartner || answerer?.zhihu_name === '灰域信风') && <button className="reload outline" onClick={() => { window.location.href = '?partner' }}>切换到合作方看板</button>}{answerer?.zhihu_name === '灰域信风' && <button className="reload outline" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<button className="reload" onClick={loadDashboard}>刷新数据</button><button className="reload" onClick={() => { window.location.href = '?home' }}>回到封面</button><div className="dashboard-user-area" onClick={() => setDropdownOpen(!dropdownOpen)}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name || dashboard?.answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main answerer-dashboard"><section className="partner-hero dashboard-hero"><div className="partner-hero-content"><p>你好，{dashboard.answerer.zhihu_name}</p><h1>我的测评活动</h1><span>查看正在参与的活动和已提交的作品。</span><div className="answerer-stats-row"><div className="hero-shared-code"><div className="hero-shared-code-inner">{sharedCode ? <div className="hero-shared-code-card"><span className="hero-shared-code-value" title="点击复制" onClick={() => { navigator.clipboard.writeText(sharedCode.code); setSharedMsg('邀请码已复制') }}>{sharedCode.code}</span><small>生成于 {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sharedCode.created_at))}</small></div> : <button className="hero-shared-code-btn" onClick={generateSharedCode} disabled={generatingShared}>{generatingShared ? '生成中…' : '分享邀请码'}<small>每日可生成一个</small></button>}{sharedMsg && <span className="hero-shared-code-msg" style={sharedMsg.includes('已生成') || sharedMsg.includes('已复制') ? undefined : { color: '#fca5a5' }}>{sharedMsg}</span>}</div></div><div className="answerer-stats"><div className="answerer-stats-left"><div className="answerer-tier-row"><span className="answerer-tier-icon">Lv{tierInfo.tier}</span><div><span className="answerer-tier-title">{tierInfo.title}</span><span className="answerer-tier-points">{points} 积分</span></div></div><div className="answerer-tier-progress"><div className="answerer-progress-bar"><div className="answerer-progress-fill" style={{width: progressPct + '%'}}></div></div>{tierInfo.nextTitle && <span className="answerer-next-tier">距「{tierInfo.nextTitle}」还需 {tierInfo.nextMin - points} 积分</span>}</div></div></div><div className="answerer-hero-metrics"><div className="answerer-metric answerer-metric-clickable" onClick={() => { setParticipatedModalOpen(true); loadParticipatedActivities() }} title="查看已参与活动详情"><span className="answerer-metric-value">{dashboard.participated_count || 0}</span><span className="answerer-metric-label">已参与活动</span><span className="answerer-metric-note">50 积分/个</span></div><div className="answerer-metric answerer-metric-clickable" onClick={() => { setCompletedModalOpen(true); loadCompletedActivities() }} title="查看已完成活动详情"><span className="answerer-metric-value">{dashboard.submission_count || 0}</span><span className="answerer-metric-label">已完成活动</span><span className="answerer-metric-note">300 积分/个</span></div><div className="answerer-metric"><span className="answerer-metric-value">{dashboard.daily_submission_count || 0}</span><span className="answerer-metric-label">已投稿日常回答</span><span className="answerer-metric-note">80 积分/个</span></div></div></div></div></section><section className="dashboard-daily-form"><div className="panel-head dashboard-section-head"><div><h3>今日创作投稿（非测评活动内容）</h3><p>任何知乎游戏领域回答都可以投稿，可提升积分；每日可投稿1条；灌水投稿会导致账户扣分甚至封禁。</p></div></div><form onSubmit={submitDaily}><div className="daily-form-fields"><input type="url" placeholder="知乎回答链接（必填，不收今日之前老投稿）" value={dailyUrl} onChange={(e) => setDailyUrl(e.target.value)} required/><input type="text" placeholder="作品标题（必填，不收今日之前老投稿）" value={dailyTitle} onChange={(e) => setDailyTitle(e.target.value)} required/><button type="submit" className="primary" disabled={dailySubmitting}>{dailySubmitting ? '投稿中…' : '提交投稿'}</button></div>{dailyMsg && <p className="daily-form-msg">{dailyMsg}</p>}</form></section><section><div className="panel-head dashboard-section-head"><div><h3>正在参与</h3><p>点击活动卡片回到申领页。</p></div></div><div className="dashboard-activity-cards">{dashboard.activities.length ? dashboard.activities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${getPersonalStage(activity) === 'key_distribution' ? 'orange' : getPersonalStage(activity) === 'delivery' ? 'purple' : getPersonalStage(activity) === 'completed' ? 'green' : 'blue'}`}>{stageLabel[getPersonalStage(activity)] || getPersonalStage(activity)}</span>{getPersonalStage(activity) === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">暂无正在参与的活动。</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>更多体验活动</h3><p>后台已上线的活动，点击卡片前往报名。</p></div></div><div className="dashboard-activity-cards">{moreActivities.length ? moreActivities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>{activity.status === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">{dashboard.more_activities === undefined ? '活动卡片加载中，请耐心等候' : '暂无更多可体验的活动。'}</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>历史活动</h3><p>招募已结束的活动回顾。</p></div></div><div className="dashboard-activity-cards">{historicalActivities.length ? (<>{historicalActivities.slice(0, HISTORICAL_VISIBLE).map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div>{activity.application_status === 'rejected' ? <span className="pill muted">未能入选</span> : activity.has_delivery ? <span className="pill stage-green">成功参与</span> : <span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>}</div></div></a>)}{historicalActivities.length > HISTORICAL_VISIBLE && <a className="dashboard-activity-card dashboard-activity-more" href="?home" style={{textDecoration:'none'}}><div className="dashboard-activity-cover dashboard-activity-more-cover">{(() => { const colors = ['#6366f1','#8b5cf6','#3b82f6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#14b8a6']; const picked = historicalMoreCovers; return Array.from({length:9}, (_,i) => { const act = picked[i]; const cover = act?.game_cover; return <div key={i} className="dashboard-activity-more-tile" style={cover ? {backgroundImage:`url(${cover})`} : {background:colors[i%9]}} /> }) })()}</div><div className="dashboard-activity-body"><h3>查看更多</h3><p>还有 {historicalActivities.length - HISTORICAL_VISIBLE} 个历史活动</p></div></a>}</>) : <div className="dashboard-empty">{dashboard.historical_activities === undefined ? '活动卡片加载中，请耐心等候' : '暂无历史活动。'}</div>}</div></section><section className="panel partner-table"><div className="panel-head"><div><h3>曾提交作品</h3><p>已提交的知乎作品记录。</p></div><button className="outline-button compact" onClick={() => { const headers = ['稿件类型', '作品标题', '作品链接']; const rows = (dashboard.submissions || []).map(s => [s.type === 'daily' ? '日常稿件' : '活动稿件', s.article_title || s.activity_title || '-', cleanZhihuAnswerUrl(s.article_url) || '']); const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${dashboard.answerer.zhihu_name}作品集_${fileTimestamp()}.csv`; a.click(); URL.revokeObjectURL(url) }}>下载 Excel</button></div><div className="table-wrap"><table><thead><tr><th>稿件类型</th><th>作品标题</th><th>作品链接</th></tr></thead><tbody>{(dashboard.submissions || []).length ? (dashboard.submissions || []).map((submission, idx) => <tr key={`submission-${idx}`}><td><span className={`submission-type ${submission.type === 'daily' ? 'daily' : 'activity'}`}>{submission.type === 'daily' ? '日常稿件' : '活动稿件'}</span></td><td>{submission.article_title || submission.activity_title || '-'}</td><td>{submission.article_url ? (() => { const u = cleanZhihuAnswerUrl(submission.article_url); return <a href={u} target="_blank" rel="noreferrer" title={u} className="profile-link" style={{wordBreak:'break-all'}}>{u.length > 50 ? u.slice(0, 50) + '...' : u} <Icon name="arrow" size={13}/></a> })() : '-'}</td></tr>) : <tr><td colSpan="3" className="table-empty">尚未提交作品。</td></tr>}</tbody></table></div></section></main>
    {dailySuccessOpen && <Modal title="投稿成功" onClose={() => setDailySuccessOpen(false)}><div className="daily-success-modal"><div className="step-message-icon success"><Icon name="check" size={24}/></div><p>今日创作投稿已提交</p><span>管理员审核后会进行后续处理。</span><button className="primary" onClick={() => setDailySuccessOpen(false)}>知道了</button></div></Modal>}
    {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setAvatarMsg(''); setAvatarFile(null) }}>
      <div className="avatar-upload-body">
        <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{answerer?.zhihu_name?.[0]}</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG 格式，大小不超过 500KB</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
          {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {avatarMsg && <p className="avatar-upload-error">{avatarMsg}</p>}
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
    {completedModalOpen && <Modal title="已完成活动" onClose={() => setCompletedModalOpen(false)} className="answerer-detail-modal" wide>
      <div className="answerer-detail-body">
        {completedActivities.length ? completedActivities.map((item) => {
          const deliveries = item.deliveries || []
          return <article className="answerer-detail-item" key={item.activity_id}>
            <div className="answerer-detail-item-header">
              <div className="answerer-detail-item-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name} loading="lazy"/> : <span>{item.game_name?.[0] || '游'}</span>}</div>
              <div className="answerer-detail-item-info">
                <p>{item.game_name}</p>
                <h4>{item.activity_title}</h4>
              </div>
              <span className={`pill stage-${item.activity_status === 'key_distribution' ? 'orange' : item.activity_status === 'delivery' ? 'purple' : item.activity_status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[item.activity_status] || item.activity_status}</span>
            </div>
            <div className="answerer-detail-deliveries">
              {deliveries.map((d) => (
                <div className="answerer-detail-delivery" key={d.delivery_id}>
                  <span className="answerer-detail-delivery-title">{d.article_title || '无标题'}</span>
                  <div className="answerer-detail-delivery-meta">
                    <span>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(d.submitted_at))}</span>
                    <a className="primary compact" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer">打开知乎回答 <Icon name="arrow" size={12}/></a>
                  </div>
                </div>
              ))}
            </div>
          </article>
        }) : <div className="answerer-detail-empty">暂无已完成的活动记录。</div>}
      </div>
    </Modal>}
    {participatedModalOpen && <Modal title="已参与活动" onClose={() => setParticipatedModalOpen(false)} className="answerer-detail-modal" wide>
      <div className="answerer-detail-body">
        {participatedActivities.length ? participatedActivities.map((item) => (
          <article className="answerer-detail-item" key={item.activity_id}>
            <div className="answerer-detail-item-header">
              <div className="answerer-detail-item-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name} loading="lazy"/> : <span>{item.game_name?.[0] || '游'}</span>}</div>
              <div className="answerer-detail-item-info">
                <p>{item.game_name}</p>
                <h4>{item.activity_title}</h4>
              </div>
              <div className="answerer-detail-item-pills">
                <span className={`pill ${item.application_status === 'selected' ? 'success' : 'muted'}`}>{item.application_status === 'selected' ? '已入选' : '未入选'}</span>
                {item.key_claimed && <span className="pill warning">已领Key</span>}
                {item.has_delivery && <span className="pill success">已提交</span>}
              </div>
            </div>
            <div className="answerer-detail-item-footer">
              <span>报名时间：{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(item.submitted_at))}</span>
              <span className={`pill stage-${item.activity_status === 'key_distribution' ? 'orange' : item.activity_status === 'delivery' ? 'purple' : item.activity_status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[item.activity_status] || item.activity_status}</span>
            </div>
          </article>
        )) : <div className="answerer-detail-empty">暂无已参与的活动记录。</div>}
      </div>
    </Modal>}
  </div>
}

function ClaimPage({ activityId, authCode }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ invitation_code: '', expected_word_count: 800, selected_platform: 'steam' })
  const [application, setApplication] = useState(null)
  const [claimedKey, setClaimedKey] = useState(null)
  const [articleUrl, setArticleUrl] = useState('')
  const [articleTitle, setArticleTitle] = useState('')
  const [claiming, setClaiming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [notice, setNotice] = useState('')
  const [activeShot, setActiveShot] = useState(0)
  const [answerer, setAnswerer] = useState(() => getAnswererSession())
  const [moreActivities, setMoreActivities] = useState([])
  const [platformStock, setPlatformStock] = useState({})
  const isExempted = useMemo(() => {
    if (!activity || !answerer) return false
    try { return JSON.parse(activity.exempted_answerer_ids || '[]').includes(answerer.id) }
    catch { return false }
  }, [activity, answerer])
  const storageKey = `claim_${activityId}`
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }
  const normalizeNested = (app) => {
    if (!app) return app
    const result = { ...app }
    if (result.keyflow_deliveries && !Array.isArray(result.keyflow_deliveries)) result.keyflow_deliveries = [result.keyflow_deliveries]
    if (!result.keyflow_deliveries) result.keyflow_deliveries = []
    if (result.keyflow_keys && !Array.isArray(result.keyflow_keys)) result.keyflow_keys = [result.keyflow_keys]
    return result
  }

  useEffect(() => {
    const init = async () => {
      const { data: act, error: actErr } = await supabase.from('keyflow_activities').select('*').eq('id', activityId).single()
      if (actErr) { setError('该申领页不存在或已失效。'); setLoading(false); return }
      setActivity(act)
      const configuredPlatforms = Array.isArray(act.platforms) && act.platforms.length ? act.platforms : ['steam']
      setForm((current) => ({ ...current, selected_platform: configuredPlatforms.includes(current.selected_platform) ? current.selected_platform : configuredPlatforms[0] }))

      const { data: stockData } = await supabase.rpc('keyflow_platform_stock', { p_activity_id: activityId })
      if (stockData) {
        const stock = {}
        stockData.forEach(s => { stock[s.platform] = { available: Number(s.available), total: Number(s.total) } })
        setPlatformStock(stock)
      }

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
        ? supabase.from('keyflow_applications').select('*, keyflow_deliveries(id, status, article_url, article_title), keyflow_keys(claimed_at)').eq('activity_id', activityId).eq('answerer_id', currentAnswerer.id).maybeSingle()
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
        setApplication(normalizeNested(answererApplication))
        await restoreClaimedKey(answererApplication)
      } else {
        const storedApp = localStorage.getItem(storageKey)
        if (storedApp) {
          try {
            const { application_id } = JSON.parse(storedApp)
            const { data: app } = await supabase.from('keyflow_applications')
              .select('*, keyflow_deliveries(id, status, article_url, article_title), keyflow_keys(claimed_at)')
              .eq('id', application_id).single()
            if (app) {
              setApplication(normalizeNested(app))
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
    if (registering || application) return
    if (!isExempted && (activity.status === 'key_distribution' || activity.status === 'delivery')) {
      setError('活动已进入后续阶段，如需报名请单独联系管理员')
      return
    }
    if (activity.status === 'completed') {
      setError('活动已完结，无法报名')
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
        selected_platform: form.selected_platform,
        ...(isExempted ? { status: 'selected' } : {}),
      }
      const { data, error: requestError } = await supabase.from('keyflow_applications')
        .upsert(payload, { onConflict: 'activity_id,answerer_id' }).select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status)').single()
      setRegistering(false)
      if (requestError) { setError(requestError.message); return }
      setApplication(normalizeNested(data))
      localStorage.setItem(storageKey, JSON.stringify({ application_id: data.id }))
      toast(isExempted ? '报名成功，可直接提交作品' : '报名已提交，等待运营方筛选')
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
        p_selected_platform: form.selected_platform,
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
    if (!articleUrl.trim()) { setError('请填写知乎回答地址'); return }
    if (!articleTitle.trim()) { setError('请填写作品标题'); return }
    setSubmitting(true); setError('')
    const { data, error: requestError } = await supabase.from('keyflow_deliveries')
      .insert({ application_id: application.id, article_url: cleanZhihuAnswerUrl(articleUrl), article_title: articleTitle.trim() }).select('id, status, article_url, article_title').single()
    if (requestError) { setError(requestError.message) }
    else {
      const currentDeliveries = application.keyflow_deliveries || []
      setApplication({ ...application, keyflow_deliveries: [...currentDeliveries, data] })
      setArticleUrl(''); setArticleTitle('')
      toast('作品已提交，可继续提交更多内容')
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
  const configuredPlatforms = Array.isArray(activity.platforms) && activity.platforms.length ? activity.platforms : ['steam']
  const hasApp = !!application
  const isSelected = application?.status === 'selected'
  const isRejected = application?.status === 'rejected'
  const hasKey = !!claimedKey
  const deliveries = Array.isArray(application?.keyflow_deliveries) ? application.keyflow_deliveries : []
  const hasDelivery = deliveries.length > 0
  const showDelivery = hasKey || (isExempted && hasApp)

  const stepStates = [
    hasApp ? 'done' : 'active',
    isExempted ? (hasApp ? 'done' : 'locked') : (hasKey ? 'done' : (hasApp && isSelected ? 'active' : (hasApp && !isSelected && !isRejected ? 'waiting' : 'locked'))),
    hasDelivery ? 'done' : (showDelivery ? 'active' : 'locked'),
  ]
  const stepLabels = ['报名参与', '领取 Key', '提交作品']

  return <div className="public-page"><main className="public-card">
    {screenshots.length > 0 && <div className="public-screenshots"><img className="ss-main" src={screenshots[activeShot] || screenshots[0]} alt="游戏截图"/>{screenshots.length > 1 && <div className="ss-strip">{screenshots.map((url, i) => i !== activeShot ? <img key={i} src={url} alt={`截图 ${i+1}`} onClick={() => setActiveShot(i)}/> : null)}</div>}</div>}
    <div className="public-brand"><a href="?home" style={{display:'flex',alignItems:'center',gap:'var(--sp-2)',textDecoration:'none',color:'inherit'}}><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主游戏KEY申领</span></a>{answerer && <a className="answerer-dashboard-link" href="?dashboard"><span className="answerer-dashboard-avatar" aria-hidden="true">{answerer.avatar_url ? <img src={answerer.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (answerer.zhihu_name?.trim().charAt(0) || '我')}</span>我的看板</a>}</div>
    <div className="public-hero"><p>{activity.game_name}</p><h1>{activity.title}</h1><span>{activity.description || '填写以下信息参与本次游戏测评。'}</span></div>
    <div className="public-requirement">{activity.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'}</div>
    <section className="public-info">{(configuredPlatforms.length > 1 || configuredPlatforms[0] !== 'steam') && <div className="public-platforms"><span>可选版本</span><div>{configuredPlatforms.map((value) => { const platform = activityPlatforms.find((item) => item.value === value); return <span key={value} className="public-platform"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{platform?.icon}</svg>{platformLabel[value] || value}</span> })}</div></div>}<strong>测评主问题</strong><p>{activity.main_question ? renderTextWithLinks(activity.main_question) : '暂无，待后续更新'}</p>{subQuestions.filter(q => q.trim()).length > 0 && <div className="public-sub-questions"><strong>相关问题</strong>{subQuestions.filter(q => q.trim()).map((q, i) => <p key={i} className="public-sub-q">{renderTextWithLinks(q)}</p>)}</div>}<div className="info-deadlines"><small>报名截止：<strong>{formatDate(activity.application_deadline)}</strong></small><div className="reply-deadline"><span>回稿时间：</span><strong>{activity.delivery_deadline ? `${new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(activity.delivery_deadline))} 前` : '待设置'}</strong></div></div></section>

    <div className="stepper">{stepLabels.map((label, i) => <div key={i} className={`step ${stepStates[i]}`}><div className="step-circle">{stepStates[i] === 'done' ? <Icon name="check" size={14}/> : stepStates[i] === 'waiting' ? <Icon name="clock" size={14}/> : i + 1}</div><span className="step-label">{label}</span></div>)}</div>

    <div className="step-body">
      {activity.status === 'completed' && !isExempted ? (
        <div className="step-message">
          <div className="step-message-icon done"><Icon name="check" size={24}/></div>
          <p>活动已结束</p>
          <span>可以参加更多游戏体验</span>
          {moreActivities.length > 0 && (
            <div className="more-activities">
              {moreActivities.map(a => (
                <a key={a.id} href={`?claim=${a.id}`} className="more-activity-card">
                  {a.game_cover ? <img src={a.game_cover} alt={a.game_name} loading="lazy" /> : <div className="more-activity-cover-placeholder" />}
                  <div className="more-activity-info">
                    <span className="more-activity-game">{a.game_name}</span>
                    <span className="more-activity-title">{a.title}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      ) : !hasApp && !isExempted && answerer && activity.status === 'key_distribution' ? (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
          <p>活动已进入发key阶段，如需报名请单独联系管理员</p>
        </div>
      ) : !hasApp && !isExempted && answerer && activity.status === 'delivery' ? (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
          <p>活动已进入创作阶段，如需报名请单独联系管理员</p>
        </div>
      ) : !hasApp && activity.status === 'completed' ? (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
          <p>活动已完结，请联系管理员手动添加报名记录</p>
          <span>你已被添加到豁免名单，管理员为你添加报名后即可提交作品。</span>
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
              {(() => { const platforms = Array.isArray(activity.platforms) && activity.platforms.length ? activity.platforms : ['steam']; const selected = activityPlatforms.find((platform) => platform.value === form.selected_platform); return platforms.length > 1 ? <label className="field platform-select-field"><span>版本选择</span><div className="platform-select-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{selected?.icon}</svg><select value={form.selected_platform} onChange={(event) => setForm({ ...form, selected_platform: event.target.value })}>{platforms.map((platform) => <option key={platform} value={platform}>{platformLabel[platform] || platform}</option>)}</select><Icon name="arrow" size={16}/></div></label> : platforms[0] !== 'steam' ? <label className="field platform-select-field"><span>版本选择</span><div className="platform-select-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{selected?.icon}</svg><span className="platform-readonly">{platformLabel[platforms[0]] || platforms[0]}</span></div></label> : null })()}
              <Field label="预计完成字数" type="number" required value={form.expected_word_count} onChange={(value) => setForm({ ...form, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setForm({ ...form, expected_word_count: 800 }) }}/>
              <span className="word-min-hint">最低 800 字</span>
              {error && <p className="public-error">{error}</p>}
              <button className="primary public-submit" disabled={registering}>{registering ? '提交中…' : '提交报名'}</button>
            </form>
          )}

          {hasApp && !showDelivery && (isRejected ? <div className="step-message"><div className="step-message-icon rejected"><Icon name="close" size={24}/></div><p>本次未入选</p><span>抱歉，您未能取得本游戏的体验资格，请关注其它活动，感谢您的理解！</span></div> : !isSelected ? <div className="step-message"><div className="step-message-icon waiting"><Icon name="clock" size={24}/></div><p>报名已提交，等待筛选</p><span>运营方会根据测评要求筛选答主，入选后可在此页面领取 Key。</span></div> : (() => { const selPlatform = application?.selected_platform || form.selected_platform || 'steam'; const stockInfo = platformStock[selPlatform]; const outOfStock = stockInfo && stockInfo.available === 0; if (outOfStock) { return <div className="step-message"><div className="step-message-icon waiting"><Icon name="alert" size={24}/></div><p>该平台 Key 库存不足，请联系管理员</p><span>{platformLabel[selPlatform] || selPlatform} 版本 Key 已全部发放，如需协助请联系运营方补充库存。</span></div> } return <div className="step-claim"><h2>领取游戏 Key</h2><p>恭喜入选！点击下方按钮领取你的专属 Key。</p><button className="primary claim-btn" onClick={claimKey} disabled={claiming}>{claiming ? '领取中…' : '领取 Key'}</button>{error && <p className="public-error">{error}</p>}</div> })())}

          {showDelivery && (() => { const daysLeft = activity.delivery_deadline ? Math.ceil((new Date(activity.delivery_deadline) - new Date()) / (1000 * 60 * 60 * 24)) : null; return <div className="step-delivery">{hasDelivery && <div className="delivery-submitted-section"><div className="step-message"><div className="step-message-icon done"><Icon name="check" size={24}/></div><p>作品已提交</p><span>可继续提交更多作品</span></div><div className="delivery-list">{deliveries.map((d, i) => <a key={d.id || i} className="delivery-list-item" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer"><span className="delivery-list-status">{d.status === 'approved' ? '已通过' : d.status === 'revision_required' ? '需修改' : d.status === 'rejected' ? '未通过' : '待审核'}</span><span className="delivery-list-title">{d.article_title || d.article_url}</span></a>)}</div></div>}{!isExempted && <div className="key-display"><div className="key-label">你的游戏 Key</div><div className="key-value">{claimedKey.key_value}</div><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimedKey.key_value); toast('Key 已复制') }}>复制 Key</button></div>}<form className="delivery-form" onSubmit={submitDelivery}><h2>提交作品链接{daysLeft !== null && daysLeft > 0 && <span className="deadline-badge">{daysLeft <= 3 ? <span className="deadline-pulse"/> : null}还剩 <strong>{daysLeft}</strong> 天</span>}{daysLeft !== null && daysLeft <= 0 && <span className="deadline-badge expired">已截止</span>}</h2><Field label="知乎回答地址" type="url" required value={articleUrl} placeholder="https://www.zhihu.com/question/.../answer/..." onChange={(value) => setArticleUrl(value)}/><Field label="作品标题" type="text" required value={articleTitle} placeholder="填写对应的知乎问题" onChange={(value) => setArticleTitle(value)}/>{error && <p className="public-error">{error}</p>}<div className="delivery-submit-row"><button className="primary public-submit" disabled={submitting}>{submitting ? '提交中…' : '提交作品'}</button><a className="outline-button dashboard-enter-btn" href="?dashboard">进入我的看板</a></div></form></div> })()}
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
    <a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 忘记密码</span></a>
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

function HomePage() {
  const [activities, setActivities] = useState([])
  const [loading, setLoading] = useState(true)
  const [authMode, setAuthMode] = useState('login')
  const [user, setUser] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(SESSION_KEY)); return s?.id ? s : null }
    catch { return null }
  })
  const [isPartner, setIsPartner] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    try {
      const session = JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY))
      if (session?.id) {
        supabase.from('keyflow_admin_users').select('id').eq('id', session.id).maybeSingle()
          .then(({ data }) => { if (!cancelled && data) setIsAdmin(true) })
      }
    } catch {}
    return () => { cancelled = true }
  }, [])
  const loggedIn = !!user
  const [banner, setBanner] = useState(() => getCachedBanner() || defaultRegisterBanner)
  const [loginForm, setLoginForm] = useState({ zhihu_name: '', password: '' })
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [regForm, setRegForm] = useState({ invitation_code: '', zhihu_name: '', account_address: '', wechat_id: '', password: '', confirm_password: '' })
  const [regLoading, setRegLoading] = useState(false)
  const [regError, setRegError] = useState('')
  const [nameHint, setNameHint] = useState(null)
  const [addressHint, setAddressHint] = useState(null)
  const nameTimer = useRef(null)
  const addressTimer = useRef(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownTimer = useRef(null)
  const [notice, setNotice] = useState('')
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  const [avatarModalOpen, setAvatarModalOpen] = useState(false)
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarMsg, setAvatarMsg] = useState('')

  const [pwdResetModalOpen, setPwdResetModalOpen] = useState(false)
  const [pwdResetStep, setPwdResetStep] = useState('idle')
  const [pwdResetMsg, setPwdResetMsg] = useState('')
  const [pwdResetLoading, setPwdResetLoading] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [inboxModalOpen, setInboxModalOpen] = useState(false)
  const [answererInbox, setAnswererInbox] = useState([])
  const [unreadInboxCount, setUnreadInboxCount] = useState(0)

  useEffect(() => {
    const cached = getCachedHomeActivities()
    if (cached) { setActivities(sortActivitiesByPriority(cached)); setLoading(false) }
    _homeActivitiesPromise.then((sorted) => {
      if (sorted) {
        setCachedHomeActivities(sorted)
        setActivities(sorted)
      } else if (!cached) { setActivities([]) }
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!user?.id) return
    supabase.rpc('keyflow_is_partner', { p_answerer_id: user.id }).then(({ data }) => { setIsPartner(!!data) })
  }, [])

  useEffect(() => {
    const cached = getCachedBanner()
    if (cached) { setBanner(cached); return }
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle()
      .then(({ data }) => { if (data?.image_data?.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) } })
  }, [])

  useEffect(() => {
    const name = regForm.zhihu_name.trim()
    if (!name || name.length < 2) { setNameHint(null); return }
    clearTimeout(nameTimer.current)
    setNameHint({ type: 'checking' })
    nameTimer.current = setTimeout(async () => {
      const { data, error } = await supabase.rpc('keyflow_check_zhihu_name', { p_name: name })
      if (error) { setNameHint(null); return }
      setNameHint(data?.exists ? { type: 'taken', suggestion: data.suggestion } : null)
    }, 500)
    return () => clearTimeout(nameTimer.current)
  }, [regForm.zhihu_name])

  useEffect(() => {
    const addr = regForm.account_address.trim()
    if (!addr || addr.length < 10) { setAddressHint(null); return }
    clearTimeout(addressTimer.current)
    setAddressHint({ type: 'checking' })
    addressTimer.current = setTimeout(async () => {
      const { data, error } = await supabase.rpc('keyflow_check_account_address', { p_address: addr })
      if (error) { setAddressHint(null); return }
      setAddressHint(data?.exists ? { type: 'taken', zhihu_name: data.zhihu_name } : null)
    }, 500)
    return () => clearTimeout(addressTimer.current)
  }, [regForm.account_address])

  const handleLogin = async (e) => {
    e.preventDefault(); setLoginError('')
    if (!loginForm.zhihu_name.trim()) { setLoginError('请输入知乎用户名'); return }
    if (!loginForm.password) { setLoginError('请输入密码'); return }
    setLoginLoading(true)
    const { data, error } = await supabase.rpc('keyflow_login_answerer', { p_zhihu_name: loginForm.zhihu_name.trim(), p_password: loginForm.password })
    setLoginLoading(false)
    if (error) { setLoginError(error.message); return }
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    toast('登录成功')
    window.setTimeout(() => { window.location.href = '?dashboard' }, 800)
  }

  const handleRegister = async (e) => {
    e.preventDefault(); setRegError('')
    if (!regForm.invitation_code.trim()) { setRegError('请输入邀请码'); return }
    if (!regForm.zhihu_name.trim()) { setRegError('请输入知乎用户名'); return }
    if (!regForm.account_address.trim()) { setRegError('请输入知乎主页地址'); return }
    if (!regForm.wechat_id.trim()) { setRegError('请输入微信号'); return }
    if (regForm.password.length < 6) { setRegError('密码至少 6 位'); return }
    if (regForm.password !== regForm.confirm_password) { setRegError('两次输入的密码不一致'); return }
    setRegLoading(true)
    const { data, error } = await supabase.rpc('keyflow_register_answerer', {
      p_code: regForm.invitation_code.trim(), p_zhihu_name: regForm.zhihu_name.trim(),
      p_account_address: regForm.account_address.trim(), p_wechat_id: regForm.wechat_id.trim(), p_password: regForm.password,
    })
    setRegLoading(false)
    if (error) { setRegError(error.message); return }
    localStorage.setItem(SESSION_KEY, JSON.stringify(data))
    toast('注册成功')
    window.setTimeout(() => { window.location.href = '?dashboard' }, 800)
  }

  const STAGE_LABEL = { recruiting: '招募中', key_distribution: '发key中', delivery: '创作中', completed: '已完结' }
  const STAGE_COLOR = { recruiting: 'stage-blue', key_distribution: 'stage-orange', delivery: 'stage-purple', completed: 'stage-green' }

  const handleCardClick = (activityId) => {
    const session = (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null } })()
    if (session?.id) { window.location.href = `?apply=${activityId}`; return }
    window.location.href = window.location.pathname + `?login&aid=${activityId}`
  }

  const handleDropdownEnter = () => {
    clearTimeout(dropdownTimer.current)
    setDropdownOpen(true)
  }
  const handleDropdownLeave = () => {
    dropdownTimer.current = setTimeout(() => setDropdownOpen(false), 200)
  }

  const handleAvatarFile = (file) => {
    setAvatarMsg('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setAvatarMsg('请选择图片文件'); return }
    if (file.size > 500 * 1024) { setAvatarMsg('图片大小不能超过 500KB'); return }
    const reader = new FileReader()
    reader.onload = (e) => { setAvatarPreview(e.target.result); setAvatarFile(file) }
    reader.readAsDataURL(file)
  }

  const uploadAvatar = async () => {
    if (!avatarFile) return
    setAvatarUploading(true)
    const ext = avatarFile.name.split('.').pop() || 'png'
    const filePath = `${user.id}.${ext}`
    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(filePath, avatarFile, { upsert: true })
    if (uploadErr) { setAvatarUploading(false); return }
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath)
    const { error: updateErr } = await supabase.from('keyflow_answerers').update({ avatar_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', user.id)
    if (updateErr) { setAvatarUploading(false); return }
    const session = { ...user, avatar_url: publicUrl }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    setUser(session)
    setAvatarUploading(false)
    setAvatarModalOpen(false)
    toast('头像已更新')
  }

  const loadResetStatus = async () => {
    if (!user?.id) return
    const { data } = await supabase.from('keyflow_password_reset_requests')
      .select('*').eq('answerer_id', user.id)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'pending') setPwdResetStep('pending')
      else if (data.status === 'approved') setPwdResetStep('approved')
      else if (data.status === 'rejected') { setPwdResetStep('rejected'); setPwdResetMsg(data.admin_note || '管理员拒绝了你的密码重置申请。') }
    }
  }

  const requestPasswordReset = async () => {
    setPwdResetLoading(true); setPwdResetMsg('')
    const { error: rpcErr } = await supabase.rpc('keyflow_request_password_reset', { p_answerer_id: user.id })
    setPwdResetLoading(false)
    if (rpcErr) { if (rpcErr.message.includes('已有一个待处理')) { setPwdResetStep('pending'); setPwdResetMsg(rpcErr.message); return }; setPwdResetMsg(rpcErr.message); return }
    setPwdResetStep('pending')
  }

  const checkResetStatus = async () => {
    if (!user?.id) return
    const { data } = await supabase.from('keyflow_password_reset_requests').select('*').eq('answerer_id', user.id).order('requested_at', { ascending: false }).limit(1).maybeSingle()
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
    const { error: rpcErr } = await supabase.rpc('keyflow_reset_password', { p_answerer_id: user.id, p_new_password: newPassword })
    setPwdResetLoading(false)
    if (rpcErr) { setPwdResetMsg(rpcErr.message); return }
    setPwdResetStep('done')
    setTimeout(() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }, 2000)
  }

  const loadInbox = async () => {
    if (!user?.id) return
    const { data } = await supabase.from('keyflow_inbox')
      .select('*').eq('to_id', user.id).eq('type', 'private_message')
      .order('created_at', { ascending: false })
    setAnswererInbox(data || [])
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

  useEffect(() => {
    if (pwdResetStep === 'pending' || pwdResetStep === 'approved') {
      const interval = setInterval(checkResetStatus, 5000)
      return () => clearInterval(interval)
    }
  }, [pwdResetStep])

  const doLogout = () => {
    localStorage.removeItem(SESSION_KEY)
    window.location.href = '?login'
  }

  return <div className="home-page">
    <div className="home-bg">
      <div className="home-orb home-orb-1" />
      <div className="home-orb home-orb-2" />
      <div className="home-orb home-orb-3" />
      <div className="home-grid-overlay" />
    </div>
    <div className="home-main">
      <header className="home-header">
        <a className="home-brand" href="?home"><span className="brand-mark zhihu-mark home-brand-mark">知</span><span>GameJourney</span></a>
        <div className="home-header-actions">
          {isAdmin && <a className="home-admin-link" href={window.location.pathname + '?admin'}>管理后台</a>}
          {loggedIn && (isPartner
            ? <div className="answerer-dashboard-link home-dashboard-btn home-partner-btn" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave} onClick={() => { window.location.href = '?partner' }}>
                <span className="answerer-dashboard-avatar partner-avatar">{user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (user?.zhihu_name?.trim().charAt(0) || '合')}</span>合作方页面<Icon name="arrow" size={12}/>
                {dropdownOpen && <div className="dashboard-dropdown" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave}>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setAvatarPreview(user?.avatar_url || null); setAvatarFile(null); setAvatarMsg(''); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}><Icon name="key" size={16}/> 重置密码</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱</button>
                  <button onClick={(e) => { e.stopPropagation(); doLogout() }}><Icon name="logout" size={16}/> 退出登录</button>
                </div>}
              </div>
            : <div className="answerer-dashboard-link home-dashboard-btn" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave} onClick={() => { window.location.href = '?dashboard' }}>
                <span className="answerer-dashboard-avatar">{user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (user?.zhihu_name?.trim().charAt(0) || '我')}</span>我的看板<Icon name="arrow" size={12}/>
                {dropdownOpen && <div className="dashboard-dropdown" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave}>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setAvatarPreview(user?.avatar_url || null); setAvatarFile(null); setAvatarMsg(''); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}><Icon name="key" size={16}/> 重置密码</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱</button>
                  <button onClick={(e) => { e.stopPropagation(); doLogout() }}><Icon name="logout" size={16}/> 退出登录</button>
                </div>}
              </div>
          )}
        </div>
      </header>
      <section className="home-hero">
        <div className="home-hero-badge">知乎游戏体验计划</div>
        <h1 className="home-hero-title">写真实体验<br />免费玩游戏</h1>
        <p className="home-hero-subtitle">免费领取 Steam 游戏 KEY，用你的文字影响百万玩家。加入 GameJourney，开启你的游戏测评之旅。</p>
        <div className="home-hero-stats">
          <div className="home-stat"><strong>{loading ? '—' : activities.length}</strong><span>款游戏入库</span></div>
          <div className="home-stat"><strong>∞</strong><span>免费 Key</span></div>
          <div className="home-stat"><strong>知乎</strong><span>认证答主</span></div>
        </div>
      </section>
      <section className="home-games">
        <div className="home-games-header"><h2>游戏库</h2><span>{loading ? '加载中…' : `${activities.filter(a => a.status === 'recruiting').length} 款游戏招募中`}</span></div>
        {loading ? <div className="home-games-loading"><div className="home-loading-spinner" />正在加载游戏数据…</div> : activities.length === 0 ? <div className="home-games-empty"><div className="home-empty-icon"><Icon name="grid" size={28} /></div><p>暂无入库游戏</p></div> : (
          <div className="home-game-grid">
            {activities.map((item, i) => (
              <div className="home-game-card" key={item.id} style={{ animationDelay: `${Math.min(i, 25) * 0.06}s` }} onClick={() => handleCardClick(item.id)}>
                <div className="home-game-cover">
                  {item.game_cover ? <img src={item.game_cover} alt={item.game_name} loading="lazy" /> : <span className="home-game-cover-placeholder">{item.game_name?.[0] || '?'}</span>}
                  <span className={`home-game-status ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span>
                </div>
                <div className="home-game-body">
                  <p className="home-game-name">{item.game_name}</p>
                  <h3>{item.title}</h3>
                  <p className="home-game-desc">{item.description || '暂无简介'}</p>
                  {item.steam_url && <a className="home-game-steam" href={item.steam_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Steam 商店 →</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <footer className="home-footer"><p>GameJourney · 知乎游戏体验计划</p></footer>
    </div>
    {!loggedIn && <aside className="home-auth">
      <div className="home-auth-bg" style={{ backgroundImage: `url(${banner})` }} />
      <div className="home-auth-content">
        <div className="home-auth-tabs">
          <button className={`home-auth-tab ${authMode === 'login' ? 'active' : ''}`} onClick={() => { setAuthMode('login'); setLoginError(''); setRegError('') }}>登录</button>
          <button className={`home-auth-tab ${authMode === 'register' ? 'active' : ''}`} onClick={() => { setAuthMode('register'); setLoginError(''); setRegError('') }}>注册</button>
        </div>
        {authMode === 'login' ? (
          <form className="home-auth-form" onSubmit={handleLogin}>
            <h2>欢迎回来</h2>
            <p className="home-auth-sub">登录后即可领取 Key 和提交测评作品。</p>
            <label className="home-field"><span>知乎用户名</span><input required value={loginForm.zhihu_name} placeholder="输入注册时的知乎用户名" onChange={(e) => setLoginForm({ ...loginForm, zhihu_name: e.target.value })} /></label>
            <label className="home-field"><span>密码</span><input type="password" required value={loginForm.password} placeholder="输入密码" onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} /></label>
            {loginError && <p className="home-auth-error">{loginError}</p>}
            <button className="home-auth-submit" disabled={loginLoading}>{loginLoading ? '登录中…' : '登录'}</button>
            <p className="home-auth-switch">还没有账号？<button type="button" onClick={() => { setAuthMode('register'); setLoginError('') }}>立即注册</button></p>
            <a className="home-auth-forgot" href={window.location.pathname + '?login'}>忘记密码？</a>
          </form>
        ) : (
          <form className="home-auth-form" onSubmit={handleRegister}>
            <h2>加入计划</h2>
            <p className="home-auth-sub">邀请码由知乎运营或已注册答主提供，每个邀请码仅可使用一次。</p>
            <label className="home-field"><span>邀请码（联系知乎运营或已注册答主获得）</span><input required value={regForm.invitation_code} placeholder="KF-XXXXXXXX" onChange={(e) => setRegForm({ ...regForm, invitation_code: e.target.value })} /></label>
            <label className="home-field"><span>知乎用户名</span><input required value={regForm.zhihu_name} placeholder="请和你的知乎昵称保持一致，登录页面的唯一账号" onChange={(e) => setRegForm({ ...regForm, zhihu_name: e.target.value })} />{nameHint?.type === 'checking' && <span className="home-field-hint checking">检测中…</span>}{nameHint?.type === 'taken' && <span className="home-field-hint taken">该用户名已被使用，建议 <button type="button" className="home-suggestion-btn" onClick={() => { setRegForm({ ...regForm, zhihu_name: nameHint.suggestion }); setNameHint(null) }}>使用「{nameHint.suggestion}」</button></span>}</label>
            <label className="home-field"><span>知乎主页地址</span><input type="url" required value={regForm.account_address} placeholder="https://www.zhihu.com/people/xxxxxx" onChange={(e) => setRegForm({ ...regForm, account_address: e.target.value })} />{addressHint?.type === 'checking' && <span className="home-field-hint checking">检测中…</span>}{addressHint?.type === 'taken' && <span className="home-field-hint warn">该主页地址已被用户「{addressHint.zhihu_name}」使用，你确定这是你的知乎账户吗？</span>}</label>
            <label className="home-field"><span>微信号</span><input required value={regForm.wechat_id} placeholder="即你的微信唯一ID，不是微信名；如ID无效则账户会被封禁" onChange={(e) => setRegForm({ ...regForm, wechat_id: e.target.value })} /></label>
            <label className="home-field"><span>密码</span><input type="password" required value={regForm.password} placeholder="至少 6 位字符" onChange={(e) => setRegForm({ ...regForm, password: e.target.value })} /></label>
            <label className="home-field"><span>再次输入密码</span><input type="password" required value={regForm.confirm_password} placeholder="请再次输入密码" onChange={(e) => setRegForm({ ...regForm, confirm_password: e.target.value })} /></label>
            {regError && <p className="home-auth-error">{regError}</p>}
            <button className="home-auth-submit" disabled={regLoading}>{regLoading ? '注册中…' : '注册'}</button>
            <p className="home-auth-switch">已有账号？<button type="button" onClick={() => { setAuthMode('login'); setRegError('') }}>去登录</button></p>
          </form>
        )}
      </div>
    </aside>}
    {notice && <div className="toast"><Icon name="check" size={17} />{notice}</div>}
    {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setAvatarMsg(''); setAvatarFile(null) }}>
      <div className="avatar-upload-body">
        <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{user?.zhihu_name?.[0]}</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG 格式，大小不超过 500KB</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
          {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {avatarMsg && <p className="avatar-upload-error">{avatarMsg}</p>}
      </div>
    </Modal>}
    {pwdResetModalOpen && <Modal title="重置密码" onClose={() => { setPwdResetModalOpen(false); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>
      <div className="pwd-reset-body">
        {pwdResetStep === 'idle' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon"><Icon name="key" size={24}/></div><p className="pwd-reset-step-title">申请密码重置</p><p className="pwd-reset-step-desc">将向管理员提交密码重置申请。管理员审核通过后，你可以在此页面设置新密码。</p><button className="primary" onClick={requestPasswordReset} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '提交申请'}</button></div>}
        {pwdResetStep === 'pending' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon waiting"><Icon name="clock" size={24}/></div><p className="pwd-reset-step-title">等待审核</p><p className="pwd-reset-step-desc">申请已提交，等待管理员审核。<br/>页面会自动刷新状态。</p></div>}
        {pwdResetStep === 'approved' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">设置新密码</p><p className="pwd-reset-step-desc">管理员已通过你的申请，请在下方设置新密码。</p><Field label="新密码" type="password" required value={newPassword} placeholder="输入新密码（至少4位）" onChange={setNewPassword} /><Field label="确认新密码" type="password" required value={confirmPassword} placeholder="再次输入新密码" onChange={setConfirmPassword} /><button className="primary" onClick={resetPassword} disabled={pwdResetLoading}>{pwdResetLoading ? '提交中…' : '确认重置'}</button></div>}
        {pwdResetStep === 'rejected' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon rejected"><Icon name="close" size={24}/></div><p className="pwd-reset-step-title">申请被拒绝</p><p className="pwd-reset-step-desc">{pwdResetMsg || '管理员拒绝了你的密码重置申请。'}</p><button className="outline-button" onClick={() => { setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword('') }}>重新申请</button></div>}
        {pwdResetStep === 'done' && <div className="pwd-reset-step"><div className="pwd-reset-step-icon success"><Icon name="check" size={24}/></div><p className="pwd-reset-step-title">密码重置成功</p><p className="pwd-reset-step-desc">请使用新密码重新登录，即将跳转到登录页...</p></div>}
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
              <button className="inbox-delete-btn" title="删除消息" onClick={(e) => { e.stopPropagation(); handleDeleteInbox(msg) }}><Icon name="close" size={14}/></button>
            </div>
            <div className="answerer-inbox-item-body"><div className="answerer-inbox-item-body-inner"><p>{msg.body}</p></div></div>
          </div>
        )) : <div className="answerer-inbox-empty"><div className="answerer-inbox-empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3H10l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><p>暂无消息</p></div>}
      </div>
    </Modal>}
  </div>
}

function AnswererParticipationModal({ answerer, records, onClose, toast }) {
  const selectedCount = records.filter((r) => r.status === 'selected').length
  const completedCount = records.filter((record) => (record.all_deliveries || []).length > 0).length
  const completionRate = selectedCount > 0 ? Math.round((completedCount / selectedCount) * 100) : 0
  const applicationStatus = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatus = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const exportExcel = () => {
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const rows = records.map((record) => {
      const deliveries = record.all_deliveries || []
      const latestDelivery = deliveries[deliveries.length - 1]
      return [answerer.zhihu_name, record.activity?.game_name || '活动已删除', record.activity?.title || '活动已删除', new Date(record.submitted_at).toLocaleString('zh-CN'), applicationStatus[record.status] || record.status, latestDelivery?.id ? deliveryStatus[latestDelivery.status] || latestDelivery.status : '未提交', deliveries.map(d => cleanZhihuAnswerUrl(d.article_url)).filter(Boolean).join(' | ')].map(quote).join(',')
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
      <div className="answerer-participation-toolbar"><div className="answerer-participation-summary"><div><strong>{selectedCount}</strong><span>历史参与次数</span></div><div><strong>{completedCount}</strong><span>完成次数</span></div></div><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}><button className="outline-button compact" onClick={exportExcel}>下载 Excel</button><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>完成率 {completionRate}%</span></div></div>
      <div className="answerer-participation-list">{records.length ? records.map((record) => {
        const deliveries = (record.all_deliveries || []).filter(d => d.article_url)
        const latestDelivery = record.all_deliveries?.[record.all_deliveries.length - 1]
        return <article className="answerer-participation-item" key={record.id}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><strong>{record.activity ? `${record.activity.game_name} · ${record.activity.title}` : '活动已删除'}</strong><small style={{ marginTop: 0, flexShrink: 0 }}>参与时间：{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.submitted_at))}</small></div><div className="answerer-participation-meta"><div className="answerer-participation-links">{deliveries.length > 0 ? deliveries.map((d, i) => <a key={d.id} className="profile-link answerer-participation-link" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer">打开知乎回答{i > 0 ? ` ${i + 1}` : ''} <Icon name="arrow" size={13}/></a>) : <span className="answerer-participation-empty">尚未提交内容</span>}</div><div className="answerer-participation-pills"><span className={`pill ${record.status === 'selected' ? 'success' : record.status === 'rejected' ? 'muted' : 'warning'}`} style={{ fontSize: 12 }}>{applicationStatus[record.status] || record.status}</span>{latestDelivery?.id && <span className={`pill ${latestDelivery.status === 'approved' ? 'success' : latestDelivery.status === 'rejected' ? 'muted' : 'warning'}`} style={{ fontSize: 12 }}>{deliveryStatus[latestDelivery.status] || latestDelivery.status}</span>}</div></div></article>
      }) : <p className="answerer-participation-empty">暂无活动参与记录。</p>}</div>
    </div>
  </Modal>
}

function PartnerManagement({ codes, answerers, setAnswerers, activities, setActivities, onAddCodes, onRefresh, participationByAnswerer, onViewAnswererParticipation }) {
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [managePartner, setManagePartner] = useState(null) // partner being managed
  const [editingRemarkId, setEditingRemarkId] = useState(null)
  const [remarkDraft, setRemarkDraft] = useState('')
  const remarkRef = useRef(null)
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  const saveRemark = async (partnerId) => {
    const text = remarkDraft.trim()
    setAnswerers(prev => prev.map(a => a.id === partnerId ? { ...a, remark: text } : a))
    setEditingRemarkId(null)
    const { error } = await supabase.from('keyflow_answerers').update({ remark: text }).eq('id', partnerId)
    if (error) { toast('保存备注失败：' + error.message); onRefresh() }
  }

  const startEditRemark = (partner) => {
    setEditingRemarkId(partner.id)
    setRemarkDraft(partner.remark || '')
    window.setTimeout(() => remarkRef.current?.focus(), 0)
  }
  const partnerCodes = codes.filter((code) => code.code_type === 'partner')
  const unusedCodes = partnerCodes.filter((code) => !code.application_id && !code.answerer_id)
  const usedCodes = partnerCodes.filter((code) => code.application_id || code.answerer_id)
  const partnerAnswererIds = new Set(partnerCodes.filter((code) => code.answerer_id).map((code) => code.answerer_id))
  const partners = answerers.filter((answerer) => partnerAnswererIds.has(answerer.id))
  const displayCodes = partnerCodes.slice(0, 10)
  const [copiedIds, setCopiedIds] = useState(() => new Set(JSON.parse(localStorage.getItem('copiedInvitationCodeIds') || '[]')))

  const generate = async () => {
    setGenerating(true)
    const { data, error } = await supabase.rpc('keyflow_generate_invitation_codes', { p_count: 10, p_code_type: 'partner' })
    setGenerating(false)
    if (error) { toast('生成失败：' + error.message); return }
    if (data) onAddCodes(data)
    toast('已生成 10 个合作方邀请码')
  }
  const copyCode = (code, id) => { navigator.clipboard.writeText(code); setCopiedIds(prev => { const next = new Set(prev); next.add(id); localStorage.setItem('copiedInvitationCodeIds', JSON.stringify([...next])); return next }); toast('邀请码已复制') }

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
      const headers = ['编号', '知乎用户名', '备注', '知乎主页地址', '微信号', '注册时间']
      const rows = partners.map((p) => [p.serial_number != null ? String(p.serial_number).padStart(3, '0') : '—', p.zhihu_name, p.remark || '', p.account_address || '未填写', p.wechat_id || '未填写', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(p.created_at))])
      const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `注册合作方列表_${fileTimestamp()}.csv`; a.click()
      URL.revokeObjectURL(url)
      toast('合作方列表已下载')
    }}>下载 Excel</button></div><div className="table-wrap"><table><thead><tr><th>#</th><th>知乎用户名</th><th>备注</th><th>知乎主页地址</th><th>微信号</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{partners.length ? partners.map((partner) => { const linkedCount = activities.filter(a => a.partner_answerer_id === partner.id).length; return <tr key={partner.id}><td><span className="serial-number">{partner.serial_number != null ? String(partner.serial_number).padStart(3, '0') : '—'}</span></td><td><div className="person">{partner.avatar_url ? <img className="person-avatar-img" src={partner.avatar_url} alt="" onClick={() => onViewAnswererParticipation(partner)} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => onViewAnswererParticipation(partner)} title="查看活动参与记录" style={{cursor:'pointer'}}>{partner.zhihu_name[0]}</span>}<div><strong>{partner.zhihu_name}</strong><small>合作方</small></div></div></td><td className="remark-cell" onClick={() => startEditRemark(partner)}>{editingRemarkId === partner.id ? <input ref={remarkRef} className="remark-input" value={remarkDraft} onChange={(e) => setRemarkDraft(e.target.value)} onBlur={() => saveRemark(partner.id)} onKeyDown={(e) => { if (e.key === 'Enter') saveRemark(partner.id); if (e.key === 'Escape') setEditingRemarkId(null) }} onClick={(e) => e.stopPropagation()} /> : <span className="remark-text">{partner.remark || <span className="remark-placeholder">点击添加备注</span>}</span>}</td><td>{partner.account_address ? <a className="profile-link" href={partner.account_address} target="_blank" rel="noreferrer">查看主页</a> : '未填写'}</td><td>{partner.wechat_id || '未填写'}</td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(partner.created_at))}</td><td><button className="outline-button compact" onClick={() => setManagePartner(partner)}>管理活动{linkedCount > 0 ? ` (${linkedCount})` : ''}</button></td></tr> }) : <tr><td colSpan="7" className="table-empty">暂无注册合作方。</td></tr>}</tbody></table></div></section>
    {managePartner && <PartnerActivityModal partner={managePartner} activities={activities} setActivities={setActivities} answerers={answerers} onClose={() => setManagePartner(null)} toast={toast} />}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

function PartnerActivityModal({ partner, activities, setActivities, answerers, onClose, toast }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [submitting, setSubmitting] = useState(false)
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])

  const filtered = useMemo(() => {
    const q = search.trim()
    const list = [...activities].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    if (!q) return list
    return list.filter(a => matchesSearch(`${a.title || ''} ${a.game_name || ''}`, q))
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
    // 本地更新 activities，避免全量刷新
    const targetSet = new Set(targetIds)
    setActivities(prev => prev.map(a => targetSet.has(a.id) ? { ...a, partner_answerer_id: link ? partner.id : null } : a))
    setSubmitting(false)
    setSelected(new Set())
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
              {activity.game_cover ? <img src={activity.game_cover} alt="" loading="lazy" /> : <span className="partner-card-cover-placeholder">{activity.game_name?.[0] || '?'}</span>}
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

function AnswererManagement({ codes, answerers, setAnswerers, activities, applications, deliveries, dailySubmissions, onAddCodes, onDeleteAnswerer, participationByAnswerer, onViewAnswererParticipation }) {
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [search, setSearch] = useState('')
  const [editingRemarkId, setEditingRemarkId] = useState(null)
  const [remarkDraft, setRemarkDraft] = useState('')
  const remarkRef = useRef(null)
  const toast = (msg) => { setNotice(msg); window.setTimeout(() => setNotice(''), 2800) }

  const saveRemark = async (answererId) => {
    const text = remarkDraft.trim()
    setAnswerers(prev => prev.map(a => a.id === answererId ? { ...a, remark: text } : a))
    setEditingRemarkId(null)
    const { error } = await supabase.from('keyflow_answerers').update({ remark: text }).eq('id', answererId)
    if (error) toast('保存备注失败：' + error.message)
  }

  const startEditRemark = (answerer) => {
    setEditingRemarkId(answerer.id)
    setRemarkDraft(answerer.remark || '')
    window.setTimeout(() => remarkRef.current?.focus(), 0)
  }
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])
  const lastSubmissionByAnswerer = useMemo(() => {
    const latest = {}
    deliveries.forEach((delivery) => {
      const answererId = applications.find((application) => application.id === delivery.application_id)?.answerer_id
      if (answererId && (!latest[answererId] || new Date(delivery.submitted_at) > new Date(latest[answererId]))) latest[answererId] = delivery.submitted_at
    })
    dailySubmissions.forEach((submission) => {
      if (!latest[submission.answerer_id] || new Date(submission.submitted_at) > new Date(latest[submission.answerer_id])) latest[submission.answerer_id] = submission.submitted_at
    })
    return latest
  }, [applications, deliveries, dailySubmissions])
  const delayedByAnswerer = useMemo(() => {
    const map = {}
    applications.forEach((app) => {
      if (!app.answerer_id) return
      if (!map[app.answerer_id]) map[app.answerer_id] = 0
      map[app.answerer_id] += (app.delayed_count || 0)
    })
    return map
  }, [applications])
  const formatLastSubmission = (submittedAt) => {
    if (!submittedAt) return '未提交'
    return `${Math.floor((Date.now() - new Date(submittedAt)) / 86400000)} 天前`
  }

  const filteredAnswerers = useMemo(() => {
    if (!search.trim()) return answerers
    return answerers.filter(a => matchesSearch(`${a.zhihu_name || ''} ${a.wechat_id || ''} ${a.account_address || ''}`, search))
  }, [answerers, search])

  const answererCodes = codes.filter(c => c.code_type === 'answerer')
  const unusedCodes = answererCodes.filter(c => !c.application_id && !c.answerer_id)
  const usedCodes = answererCodes.filter(c => c.application_id || c.answerer_id)
  const unusedCount = unusedCodes.length
  const usedCount = usedCodes.length
  const displayCodes = answererCodes.slice(0, 10)
  const leftCol = displayCodes.slice(0, 5)
  const rightCol = displayCodes.slice(5, 10)
  const [copiedIds, setCopiedIds] = useState(() => new Set(JSON.parse(localStorage.getItem('copiedInvitationCodeIds') || '[]')))

  const generate = async () => {
    setGenerating(true)
    const { data, error } = await supabase.rpc('keyflow_generate_invitation_codes', { p_count: 10 })
    setGenerating(false)
    if (error) { toast('生成失败：' + error.message); return }
    if (data) onAddCodes(data)
    toast('已生成 10 个邀请码')
  }

  const copyCode = (code, id) => { navigator.clipboard.writeText(code); setCopiedIds(prev => { const next = new Set(prev); next.add(id); localStorage.setItem('copiedInvitationCodeIds', JSON.stringify([...next])); return next }); toast('邀请码已复制') }

  const deleteAnswerer = async () => {
    if (!confirmDeleteId) return
    const { error: requestError } = await supabase.from('keyflow_answerers').delete().eq('id', confirmDeleteId)
    setConfirmDeleteId(null)
    if (requestError) return toast('删除失败：' + requestError.message)
    onDeleteAnswerer(confirmDeleteId)
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
        const headers = ['注册用户ID', '知乎用户名', '备注', '知乎主页地址', '微信号', '活动参与次数', '成功完成次数', '完成率', '延迟提交', '上次提交作品', '注册时间']
        const rows = answerers.map((a) => {
          const records = participationByAnswerer[a.id] || []
          const selectedRecords = records.filter((r) => r.status === 'selected')
          const completed = records.filter((r) => (r.all_deliveries || []).some(d => d.article_url)).length
          const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'
          return [a.serial_number != null ? String(a.serial_number).padStart(3, '0') : '—', a.zhihu_name, a.remark || '', a.account_address || '未填写', a.wechat_id || '未填写', `${selectedRecords.length}`, `${completed}`, rate, `${delayedByAnswerer[a.id] || 0}`, formatLastSubmission(lastSubmissionByAnswerer[a.id]), new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.created_at))]
        })
        const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = `注册答主列表_${fileTimestamp()}.csv`; a.click()
        URL.revokeObjectURL(url)
        toast('答主列表已下载')
      }}>下载 Excel</button></div></div>
      <div className="table-wrap answerer-table-wrap"><table className="answerer-table"><colgroup><col className="answerer-col-id" /><col className="answerer-col-name" /><col className="answerer-col-remark" /><col className="answerer-col-profile" /><col className="answerer-col-wechat" /><col className="answerer-col-count" /><col className="answerer-col-count" /><col className="answerer-col-rate" /><col className="answerer-col-delay" /><col className="answerer-col-submission" /><col className="answerer-col-records" /><col className="answerer-col-created" /><col className="answerer-col-action" /></colgroup><thead><tr><th>#</th><th>知乎用户名</th><th>备注</th><th>知乎主页地址</th><th>微信号</th><th>活动参与次数</th><th>成功完成次数</th><th>完成率</th><th>延迟提交</th><th>上次提交作品</th><th>参与记录</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{filteredAnswerers.length ? filteredAnswerers.map((a) => {
        const records = participationByAnswerer[a.id] || []
        const selectedRecords = records.filter((r) => r.status === 'selected')
        const completed = records.filter((r) => (r.all_deliveries || []).some(d => d.article_url)).length
        const rate = selectedRecords.length ? `${Math.round(completed / selectedRecords.length * 100)}%` : '—'
        const delayedTotal = delayedByAnswerer[a.id] || 0
        return <tr key={a.id}><td><span className="serial-number">{a.serial_number != null ? String(a.serial_number).padStart(3, '0') : '—'}</span></td><td><div className="person">{a.avatar_url ? <img className="person-avatar-img" src={a.avatar_url} alt="" onClick={() => onViewAnswererParticipation(a)} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => onViewAnswererParticipation(a)} title="查看活动参与记录" style={{cursor:'pointer'}}>{a.zhihu_name[0]}</span>}<div><strong>{a.zhihu_name}</strong></div></div></td><td className="remark-cell" onClick={() => startEditRemark(a)}>{editingRemarkId === a.id ? <input ref={remarkRef} className="remark-input" value={remarkDraft} onChange={(e) => setRemarkDraft(e.target.value)} onBlur={() => saveRemark(a.id)} onKeyDown={(e) => { if (e.key === 'Enter') saveRemark(a.id); if (e.key === 'Escape') setEditingRemarkId(null) }} onClick={(e) => e.stopPropagation()} /> : <span className="remark-text">{a.remark || <span className="remark-placeholder">点击添加备注</span>}</span>}</td><td>{a.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>未填写</span>}</td><td className="wechat-copy-cell" onClick={() => { if (a.wechat_id) { navigator.clipboard.writeText(a.wechat_id); toast('微信号已复制') } }} title={a.wechat_id ? '点击复制微信号' : ''}>{a.wechat_id || '未填写'}</td><td>{selectedRecords.length}</td><td>{completed}</td><td><span className={`${rate !== '—' && (() => { const r = parseInt(rate); return r <= 25 ? 'highlight-red' : r >= 90 ? 'highlight-green' : ''; })()}`}>{rate}</span></td><td><span className={`history-count ${delayedTotal > 0 ? 'highlight-red' : ''}`}>{delayedTotal} <small>次</small></span></td><td>{formatLastSubmission(lastSubmissionByAnswerer[a.id])}</td><td><button className="outline-button compact" onClick={() => onViewAnswererParticipation(a)}>查看记录</button></td><td>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(a.created_at))}</td><td><button className="delete-action" onClick={() => setConfirmDeleteId(a.id)}>删除</button></td></tr>
      }) : <tr><td colSpan="13" className="table-empty">暂无注册答主。</td></tr>}</tbody></table></div>
    </section>
    {confirmDeleteId && <ConfirmDialog message="确定要删除该答主吗？此操作不可撤销。" onConfirm={deleteAnswerer} onCancel={() => setConfirmDeleteId(null)} />}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </div>
}

const PAGE_SIZE = 20

function AllActivitySubmissionsPage({ deliveries, applications, activities, answerers, toast }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')

  const activityById = useMemo(() => Object.fromEntries(activities.map(a => [a.id, a])), [activities])
  const applicationById = useMemo(() => Object.fromEntries(applications.map(a => [a.id, a])), [applications])
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])

  // 聚合所有活动投稿：以 delivery 为主体，关联 application → activity → answerer
  const aggregated = useMemo(() => {
    return deliveries.map(d => {
      const app = applicationById[d.application_id]
      const act = app ? activityById[app.activity_id] : null
      const ans = app ? answererById[app.answerer_id] : null
      return {
        ...d,
        activity_title: act?.title || '未知活动',
        game_name: act?.game_name || '未知游戏',
        answerer_name: ans?.zhihu_name || app?.zhihu_name || '未知答主',
        answerer_account: ans?.account_address || '',
        application_status: app?.status || '',
      }
    }).sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0))
  }, [deliveries, applicationById, activityById, answererById])

  const filtered = useMemo(() => {
    if (!keyword.trim()) return aggregated
    return aggregated.filter(d =>
      matchesSearch(`${d.activity_title} ${d.game_name} ${d.answerer_name} ${d.article_title || ''} ${d.article_url || ''}`, keyword)
    )
  }, [aggregated, keyword])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [keyword])

  const pages = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const result = [1]
    if (safePage > 3) result.push('…')
    for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) result.push(i)
    if (safePage < totalPages - 2) result.push('…')
    result.push(totalPages)
    return result
  }, [safePage, totalPages])

  const formatDate = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

  const deliveryStatusLabel = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const statusPillClass = { pending: 'warning', approved: 'success', revision_required: 'warning', rejected: 'muted' }

  const downloadExcel = () => {
    if (!filtered.length) { toast?.('暂无投稿数据'); return }
    const headers = ['活动名称', '游戏名称', '答主', '知乎主页', '作品标题', '投稿链接', '审核状态', '投稿时间']
    const rows = filtered.map(d => [
      d.activity_title,
      d.game_name,
      d.answerer_name,
      d.answerer_account,
      d.article_title || '',
      cleanZhihuAnswerUrl(d.article_url) || '',
      deliveryStatusLabel[d.status] || d.status,
      formatDate(d.submitted_at),
    ])
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `全部活动投稿_${fileTimestamp()}.csv`; link.click()
    URL.revokeObjectURL(url)
  }

  return <section className="panel">
    <div className="application-toolbar">
      <div className="application-controls"><input placeholder="搜索活动、游戏、答主、标题或链接…" value={keyword} onChange={e => setKeyword(e.target.value)} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--c-ink-4)', whiteSpace: 'nowrap' }}>共 {filtered.length} 条投稿</span>
        <button className="outline-button compact" onClick={downloadExcel}>下载 Excel</button>
      </div>
    </div>
    <div className="table-wrap"><table><thead><tr>
      <th style={{ width: 150 }}>活动名称</th>
      <th style={{ width: 100 }}>游戏名称</th>
      <th style={{ width: 100 }}>答主</th>
      <th style={{ width: 80 }}>知乎主页</th>
      <th>作品标题</th>
      <th style={{ width: 80 }}>投稿链接</th>
      <th style={{ width: 80 }}>审核状态</th>
      <th style={{ width: 150 }}>投稿时间</th>
    </tr></thead><tbody>
      {paged.length ? paged.map(d => <tr key={d.id}>
        <td><span title={d.activity_title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{d.activity_title}</span></td>
        <td>{d.game_name}</td>
        <td><strong>{d.answerer_name}</strong></td>
        <td>{d.answerer_account ? <a className="profile-link" href={d.answerer_account} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>—</span>}</td>
        <td>{d.article_title || <span style={{ color: 'var(--c-ink-4)' }}>—</span>}</td>
        <td>{d.article_url ? <a className="profile-link" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer">查看投稿</a> : '—'}</td>
        <td><span className={`pill ${statusPillClass[d.status] || 'muted'}`}>{deliveryStatusLabel[d.status] || d.status}</span></td>
        <td>{formatDate(d.submitted_at)}</td>
      </tr>) : <tr><td colSpan="8" className="table-empty">{keyword ? '无匹配结果。' : '暂无活动投稿。'}</td></tr>}
    </tbody></table></div>
    {totalPages > 1 && <div className="pagination"><div className="page-info">第 {safePage} 页，共 {totalPages} 页，共 {filtered.length} 条</div><div className="page-btns"><button className="page-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}><Icon name="arrow" size={13} style={{ transform: 'rotate(180deg)' }} /></button>{pages.map((p, i) => p === '…' ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span> : <button key={p} className={`page-btn${p === safePage ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>)}<button className="page-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}><Icon name="arrow" size={13} /></button></div></div>}
  </section>
}

function DailySubmissionsCalendar({ submissions, selectedDate, onSelectDate }) {
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth())

  const submissionByDate = useMemo(() => {
    const map = {}
    submissions.forEach(s => {
      const d = new Date(s.submitted_at)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!map[key]) map[key] = { total: 0, unprocessed: 0 }
      map[key].total++
      if (!s.processed) map[key].unprocessed++
    })
    return map
  }, [submissions])

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay()
  const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`

  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) } else setViewMonth(m => m - 1) }
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) } else setViewMonth(m => m + 1) }

  const cells = []
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ day: d, key, info: submissionByDate[key] })
  }

  return <div className="daily-calendar">
    <div className="daily-calendar-head">
      <button className="daily-calendar-nav" onClick={prevMonth}>&lt;</button>
      <span>{viewYear}年{viewMonth + 1}月</span>
      <button className="daily-calendar-nav" onClick={nextMonth}>&gt;</button>
    </div>
    <div className="daily-calendar-grid">
      {['日', '一', '二', '三', '四', '五', '六'].map(w => <div key={w} className="daily-calendar-weekday">{w}</div>)}
      {cells.map((cell, i) => <div key={i} className={`daily-calendar-cell${!cell ? ' empty' : ''}${cell && cell.key === selectedDate ? ' selected' : ''}${cell && cell.key === today ? ' today' : ''}`} onClick={() => cell && onSelectDate(cell.key === selectedDate ? null : cell.key)}>
        {cell && <>
          <span className="daily-calendar-day">{cell.day}</span>
          {cell.info && <span className={`daily-calendar-dot${cell.info.unprocessed > 0 ? ' unreviewed' : ''}`}>{cell.info.total}</span>}
        </>}
      </div>)}
    </div>
    {selectedDate && <div className="daily-calendar-clear" onClick={() => onSelectDate(null)}>清除日期筛选</div>}
  </div>
}

function DailySubmissionsPage({ submissions, answerers, toast, setDailySubmissions, participationByAnswerer, onViewAnswererParticipation }) {
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [selectedDate, setSelectedDate] = useState(null)
  const answererById = useMemo(() => Object.fromEntries(answerers.map(a => [a.id, a])), [answerers])

  const filtered = useMemo(() => {
    let list = submissions
    if (selectedDate) {
      list = list.filter(s => {
        const d = new Date(s.submitted_at)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        return key === selectedDate
      })
    }
    if (!keyword.trim()) return list
    return list.filter(s => {
      const a = answererById[s.answerer_id]
      return matchesSearch(`${s.article_url || ''} ${s.article_title || ''} ${a?.zhihu_name || ''}`, keyword)
    })
  }, [submissions, keyword, answererById, selectedDate])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [keyword, selectedDate])

  const pages = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const result = [1]
    if (safePage > 3) result.push('…')
    for (let i = Math.max(2, safePage - 1); i <= Math.min(totalPages - 1, safePage + 1); i++) result.push(i)
    if (safePage < totalPages - 2) result.push('…')
    result.push(totalPages)
    return result
  }, [safePage, totalPages])

  const formatSubmissionDate = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

  const handleDelete = async (id) => {
    if (!window.confirm('确定要删除该投稿吗？此操作不可撤销。')) return
    const { error } = await supabase.from('keyflow_daily_submissions').delete().eq('id', id)
    if (error) { toast?.(error.message); return }
    setDailySubmissions(prev => prev.filter(s => s.id !== id))
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
    toast?.('投稿已删除')
  }

  const handleBatchDelete = async () => {
    if (!selectedIds.size || !window.confirm(`确定要删除选中的 ${selectedIds.size} 条投稿吗？此操作不可撤销。`)) return
    const ids = [...selectedIds]
    const { error } = await supabase.from('keyflow_daily_submissions').delete().in('id', ids)
    if (error) { toast?.(error.message); return }
    setDailySubmissions(prev => prev.filter(s => !selectedIds.has(s.id)))
    setSelectedIds(new Set())
    toast?.(`已删除 ${ids.length} 条投稿`)
  }

  const handleViewSubmission = async (submission) => {
    window.open(cleanZhihuAnswerUrl(submission.article_url), '_blank')
    if (!submission.reviewed) {
      setDailySubmissions(prev => prev.map(s => s.id === submission.id ? { ...s, reviewed: true } : s))
      supabase.from('keyflow_daily_submissions').update({ reviewed: true }).eq('id', submission.id).then(() => {})
    }
  }

  const handleProcess = async (submission) => {
    const { data: existing } = await supabase.from('keyflow_inbox').select('id').eq('to_id', submission.answerer_id).in('type', ['system', 'private_message']).eq('data->>submission_id', String(submission.id)).maybeSingle()
    if (!existing) {
      await supabase.from('keyflow_inbox').insert({
        type: 'system', title: '投稿已收到', body: `您的投稿《${submission.article_title || '未知标题'}》已收到，已经进行扶持处理。`,
        to_id: submission.answerer_id, status: 'unread', data: { submission_id: submission.id },
      })
      toast?.('已向答主发送投稿确认私信')
    }
    setDailySubmissions(prev => prev.map(s => s.id === submission.id ? { ...s, processed: true, reviewed: true } : s))
    supabase.from('keyflow_daily_submissions').update({ processed: true, reviewed: true }).eq('id', submission.id).then(() => {})
  }

  const handleBatchProcess = async () => {
    if (!selectedIds.size || !window.confirm(`确定要批量处理选中的 ${selectedIds.size} 条投稿吗？`)) return
    const ids = [...selectedIds]
    let sentCount = 0
    for (const id of ids) {
      const s = submissions.find(sub => sub.id === id)
      if (!s || s.processed) continue
      const { data: existing } = await supabase.from('keyflow_inbox').select('id').eq('to_id', s.answerer_id).in('type', ['system', 'private_message']).eq('data->>submission_id', String(s.id)).maybeSingle()
      if (!existing) {
        await supabase.from('keyflow_inbox').insert({
          type: 'system', title: '投稿已收到', body: `您的投稿《${s.article_title || '未知标题'}》已收到，已经进行扶持处理。`,
          to_id: s.answerer_id, status: 'unread', data: { submission_id: s.id },
        })
        sentCount++
      }
      setDailySubmissions(prev => prev.map(sub => sub.id === id ? { ...sub, processed: true, reviewed: true } : sub))
      supabase.from('keyflow_daily_submissions').update({ processed: true, reviewed: true }).eq('id', id).then(() => {})
    }
    toast?.(`已处理 ${sentCount} 条投稿`)
  }

  const toggleFeatured = async (submission) => {
    const newVal = !submission.featured
    setDailySubmissions(prev => prev.map(s => s.id === submission.id ? { ...s, featured: newVal } : s))
    const { error } = await supabase.from('keyflow_daily_submissions').update({ featured: newVal }).eq('id', submission.id)
    if (error) toast?.(error.message)
  }

  const toggleSelect = (id) => setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleSelectAll = () => setSelectedIds(prev => {
    const next = new Set(prev)
    const allSelected = paged.length > 0 && paged.every(s => next.has(s.id))
    paged.forEach(s => allSelected ? next.delete(s.id) : next.add(s.id))
    return next
  })

  const handleOpenAllUnprocessed = () => {
    const unprocessed = filtered.filter(s => !s.processed && s.article_url)
    if (!unprocessed.length) { toast?.('没有未处理的投稿'); return }
    unprocessed.forEach(s => window.open(cleanZhihuAnswerUrl(s.article_url), '_blank'))
    toast?.(`已在浏览器打开 ${unprocessed.length} 条未处理投稿`)
  }

  const downloadTodayCsv = () => {
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const todaySubs = filtered.filter(s => {
      const d = new Date(s.submitted_at)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayKey
    })
    if (!todaySubs.length) { toast?.('今日暂无投稿'); return }
    const headers = ['答主', '知乎主页', '作品标题', '投稿链接', '投稿时间']
    const rows = todaySubs.map(s => {
      const a = answererById[s.answerer_id]
      return [a?.zhihu_name || '未知答主', a?.account_address || '', s.article_title || '', cleanZhihuAnswerUrl(s.article_url), formatSubmissionDate(s.submitted_at)]
    })
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `答主日常投稿_今日_${fileTimestamp()}.csv`; link.click()
    URL.revokeObjectURL(url)
  }

  const downloadAllCsv = () => {
    const headers = ['答主', '知乎主页', '作品标题', '投稿链接', '投稿时间']
    const rows = filtered.map(s => {
      const a = answererById[s.answerer_id]
      return [a?.zhihu_name || '未知答主', a?.account_address || '', s.article_title || '', cleanZhihuAnswerUrl(s.article_url), formatSubmissionDate(s.submitted_at)]
    })
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `答主日常投稿_${fileTimestamp()}.csv`; link.click()
    URL.revokeObjectURL(url)
  }

  return <section className="panel">
    <DailySubmissionsCalendar submissions={submissions} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
    <div className="application-toolbar">
      <div className="application-controls"><input placeholder="搜索投稿链接、标题或答主…" value={keyword} onChange={e => setKeyword(e.target.value)} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        {selectedIds.size > 0 && <>
          <button className="outline-button compact" style={{ color: 'var(--c-danger)', borderColor: 'var(--c-danger)' }} onClick={handleBatchDelete}>删除选中 ({selectedIds.size})</button>
          <button className="outline-button compact" onClick={handleBatchProcess}>批量处理 ({selectedIds.size})</button>
        </>}
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--c-ink-4)', whiteSpace: 'nowrap' }}>当前投稿共 {filtered.length} 条</span>
        <button className="outline-button compact" onClick={handleOpenAllUnprocessed}>浏览器一键打开所有未处理投稿</button>
        <button className="outline-button compact" onClick={downloadTodayCsv}>下载今日作品</button>
        <button className="outline-button compact" onClick={downloadAllCsv}>下载历史全部作品</button>
      </div>
    </div>
    <div className="table-wrap"><table><thead><tr><th style={{ width: 40 }}><input type="checkbox" checked={paged.length > 0 && paged.every(s => selectedIds.has(s.id))} onChange={toggleSelectAll} /></th><th style={{ width: 120 }}>答主</th><th style={{ width: 90 }}>知乎主页</th><th>作品标题</th><th style={{ width: 90 }}>投稿链接</th><th style={{ width: 80 }}>处理</th><th style={{ width: 150 }}>投稿时间</th><th style={{ width: 50 }}>精华</th><th style={{ width: 60 }}>操作</th></tr></thead><tbody>
      {paged.length ? paged.map(s => { const a = answererById[s.answerer_id]; return <tr key={s.id}><td><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td><td><div className="person">{a?.avatar_url ? <img className="person-avatar-img" src={a.avatar_url} alt="" onClick={() => { if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{a?.zhihu_name?.[0] || '?'}</span>}<div><strong>{a?.zhihu_name || '未知答主'}</strong><small>知乎答主</small></div></div></td><td>{a?.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>未填写</span>}</td><td>{s.article_title || <span style={{ color: 'var(--c-ink-4)' }}>—</span>}</td><td>{s.article_url ? <a className="profile-link" href={cleanZhihuAnswerUrl(s.article_url)} target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); handleViewSubmission(s) }}>查看投稿 <Icon name="arrow" size={13} /></a> : '—'}</td><td>{s.processed ? <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>已处理</span> : <button className="outline-button compact" onClick={() => handleProcess(s)}>处理</button>}</td><td>{formatSubmissionDate(s.submitted_at)}</td><td><button className="featured-toggle" onClick={() => toggleFeatured(s)} title={s.featured ? '取消精华' : '标记精华'} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', padding: 0, lineHeight: 1, color: s.featured ? '#f0a500' : undefined }}>{s.featured ? '★' : '☆'}</button></td><td><button className="delete-action" onClick={() => handleDelete(s.id)} title="删除投稿">删除</button></td></tr> }) : <tr><td colSpan="9" className="table-empty">{keyword ? '无匹配结果。' : '暂无日常投稿。'}</td></tr>}
    </tbody></table></div>
    {totalPages > 1 && <div className="pagination"><div className="page-info">第 {safePage} 页，共 {totalPages} 页，共 {filtered.length} 条</div><div className="page-btns"><button className="page-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}><Icon name="arrow" size={13} style={{ transform: 'rotate(180deg)' }} /></button>{pages.map((p, i) => p === '…' ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span> : <button key={p} className={`page-btn${p === safePage ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>)}<button className="page-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}><Icon name="arrow" size={13} /></button></div></div>}
  </section>
}

function InboxPage({ messages, requests, answerers, onRefresh, onDeleteMessages, toast, setConfirmState }) {
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
    return answerers.filter(a => matchesSearch(`${a.zhihu_name || ''} ${a.wechat_id || ''} ${a.account_address || ''}`, search))
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
      if (!groups.has(key)) groups.set(key, { ...msg, to_ids: [], messageIds: [] })
      groups.get(key).to_ids.push(msg.to_id)
      groups.get(key).messageIds.push(msg.id)
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
        messageIds: batch.messageIds,
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
          const { error } = await supabase.from('keyflow_inbox').delete().in('id', msg.messageIds)
          if (error) { toast(error.message); return }
          onDeleteMessages(msg.messageIds)
          toast('私信已删除')
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
        onDeleteMessages([msg.id])
        toast('消息已删除')
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
          <button className="outline-button compact" onClick={() => {
            const rows = messages.filter(m => m.type === 'private_message').map(m => [m.title, m.body, answererById[m.to_id]?.zhihu_name || '未知', m.created_at, m.status])
            const csv = '\uFEFF' + [['标题', '内容', '接收人', '发送时间', '状态'], ...rows].map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
            const d = new Date(); const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            const a = document.createElement('a'); a.href = url; a.download = `私信列表_${date}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
          }}>下载 Excel</button>
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
