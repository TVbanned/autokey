import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import DorocoBadgePreview from './DorocoBadgePreview.jsx'
import { supabase } from './supabase'
import { matchesSearch } from './pinyin.js'
import { trackAnswererDashboardView, trackPageView } from './analytics.js'
import { buildZhihuCsv, parseClipboardGrid, parsePastedTitles } from './zhihuQuestionCsv.js'
import './App.css'

const AdminLoginPage = lazy(() => import('./AdminLoginPage.jsx'))

const ADMIN_SESSION_KEY = 'keyflow_admin_session'
const BANNER_CACHE_KEY = 'keyflow_banner'
const TENCENT_TOKEN_EXPIRES_AT = '2026-09-27T09:20:39+08:00'
const TENCENT_TOKEN_REMINDER_KEY = 'keyflow_tencent_token_reminder'

const getAdminToken = () => {
  try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY))?.session_token || null } catch { return null }
}
const isPasswordResetApprovalExpired = (request) => !request?.reviewed_at || Date.now() - new Date(request.reviewed_at).getTime() > 30 * 60 * 1000
const PWD_RESET_FORGOT_KEY = 'keyflow_pwd_reset_forgot'
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
    const { error: updateErr } = await supabase.rpc('keyflow_answerer_update_avatar', { p_answerer_id: answererId, p_avatar_url: publicUrl })
    if (updateErr) return avatarUrl
    return publicUrl
  } catch { return avatarUrl }
}

// 客户端压缩图片：等比缩放到 maxDim 内并转 WebP，降低存储体积与出站流量（egress）
async function compressImageFile(file, maxDim = 256, quality = 0.85) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error('图片读取失败'))
    r.readAsDataURL(file)
  })
  const img = await new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('图片解析失败'))
    i.src = dataUrl
  })
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(img, 0, 0, width, height)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
  if (!blob) return file
  const isPng = blob.type === 'image/png'
  const mime = isPng ? 'image/png' : 'image/webp'
  const ext = isPng ? 'png' : 'webp'
  const base = (file.name || 'avatar').replace(/\.[^.]+$/, '')
  return new File([blob], `${base}.${ext}`, { type: mime })
}

async function uploadMediaFile(file, token, kind) {
  if (!token) throw new Error('登录状态已过期，请重新登录后重试')
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  const response = await fetch('https://palewinds.com/media-upload.php', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.url) throw new Error(result.error || '图片上传失败')
  return result.url
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

const parseAnswererIds = (value) => {
  if (Array.isArray(value)) return value
  try { return JSON.parse(value || '[]') }
  catch { return [] }
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
    reload: <><path d="M20 11a8 8 0 1 0 1 4"/><path d="M20 4v7h-7"/></>,
    alert: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></>,
    star: <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>,
    wrench: <><path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3.5 17.5a2.12 2.12 0 1 0 3 3l6-6a4 4 0 0 0 5.2-5.2l-2.2 2.2-2.5-.5-.5-2.5z"/></>,
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

// 与数据库 keyflow_normalize_zhihu_url 规则保持一致：
// 去 query/#、去尾部斜杠、补 www、API 地址转公开地址、去掉答案链接后缀。
function normalizeZhihuUrl(url) {
  if (!url) return url
  let clean = url.trim().split('#')[0].split('?')[0].replace(/\/+$/, '')
  clean = clean.replace(/^https?:\/\/zhihu\.com\//i, 'https://www.zhihu.com/')
  clean = clean.replace(/^https?:\/\/www\.zhihu\.com\/api\/v4\/questions\/(\d+)$/i, 'https://www.zhihu.com/question/$1')
  clean = clean.replace(/\/api\/v4\/questions\/(\d+)\/?$/i, '/question/$1')
  clean = clean.replace(/\/answer(s)?\/\d+$/i, '')
  return clean || url
}

function publicZhihuQuestionUrl(url) {
  const cleanUrl = cleanZhihuAnswerUrl(url)
  if (!cleanUrl) return cleanUrl
  return cleanUrl.replace(/\/api\/v4\/questions\/(\d+)\/?$/, '/question/$1')
}

function badgeImageUrl(gameName) {
  const prompt = `精致3D风格游戏成就徽章，主题「${gameName}」，金属浮雕质感，深色渐变背景，游戏元素，平面图标，高细节，居中构图`
  return `https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=${encodeURIComponent(prompt)}&image_size=square`
}

function fileTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
}

const ANSWERER_TIERS = [
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

function getTierInfo(pts) {
  let info = ANSWERER_TIERS[0]
  for (const t of ANSWERER_TIERS) { if (pts >= t.min) info = t }
  const next = ANSWERER_TIERS.find(t => t.min > pts)
  return { ...info, nextMin: next?.min ?? null, nextTitle: next?.title ?? null }
}

function parseQuestions(value) {
  const urlPattern = /https?:\/\/(?:www\.)?zhihu\.com\/(?:question|answer)\/\d+[^\s`，,。；;：:！!？?、】【】）》〉>」』"'\)\]\}]*/gi
  const matches = [...value.matchAll(urlPattern)]
  return matches.map((match, index) => {
    const before = value.slice(index ? matches[index - 1].index + matches[index - 1][0].length : 0, match.index)
    const zhihu_url = cleanZhihuAnswerUrl(match[0])
    // 优先取链接同一行的前置文本；链接独占一行时用整段前置文本（知乎分享格式）
    const lineBefore = (before.split(/\r?\n/).pop() || '').trim()
    let title = lineBefore || before
    // 表格导出格式（标题\t描述\t分类\tID\t链接\t状态）：标题是第一个以问号结尾的列，其余列丢弃
    if (lineBefore && lineBefore.includes('\t')) {
      const segments = lineBefore.split(/\t/).map((s) => s.trim()).filter(Boolean)
      const questionSeg = segments.find((s) => /[？?]/.test(s))
      title = questionSeg || segments[0] || lineBefore
    }
    // 标题以问号收尾：问号之后（如 Excel 数字 ID）的内容丢弃
    const lastQ = Math.max(title.lastIndexOf('？'), title.lastIndexOf('?'))
    if (lastQ >= 0) title = title.slice(0, lastQ + 1)
    title = title.replace(/[\r\n\t]+/g, ' ').replace(/^[,，;；\s-]+|[,，;；\s-]+$/g, '').replace(/\s*-\s*知乎\s*$/, '').trim()
    return { title, zhihu_url, content_type: /\/answer\/\d+/.test(zhihu_url) ? 'answer' : 'question' }
  }).filter((item) => item.title)
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

async function fetchZhihuAnswerWordCount(articleUrl) {
  // #region debug-point A:word-count-request
  const traceId = crypto.randomUUID(); fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'zhihu-word-count-403', runId: 'pre-fix', hypothesisId: 'A', traceId, location: 'App.jsx:fetchZhihuAnswerWordCount', msg: '[DEBUG] 字数核对请求开始', data: { articleUrl: String(articleUrl || '').replace(/\/answer\/\d+/, '/answer/:id') }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  try {
    const { data, error } = await supabase.functions.invoke('zhihu-answer-word-count', { body: { articleUrl } })
    // #region debug-point A:word-count-response
    fetch('http://127.0.0.1:7777/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'zhihu-word-count-403', runId: 'pre-fix', hypothesisId: 'A', traceId, location: 'App.jsx:fetchZhihuAnswerWordCount', msg: '[DEBUG] 字数核对请求返回', data: { hasData: !!data, success: data?.success ?? null, errorMessage: error?.message ?? null, status: error?.context?.status ?? null }, ts: Date.now() }) }).catch(() => {})
    // #endregion
    if (error) {
      let message = error.message || '知乎回答字数抓取失败，请稍后重试'
      try {
        const body = await error.context?.json()
        if (body?.error) message = body.error
      } catch {}
      return { success: false, error: message }
    }
    if (!data?.success) return { success: false, error: data?.error || '知乎回答字数抓取失败，请稍后重试' }
    return { success: true, wordCount: data.wordCount }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '知乎回答字数抓取失败，请稍后重试' }
  }
}

async function fetchSteamInfo(url) {
  const appid = parseSteamAppId(url)
  if (!appid) return { success: false, error: '无法解析 Steam 商店地址，请检查 URL 格式' }
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
    const coverResult = await fetch('https://palewinds.com/steam-cover.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: appid, sourceUrl: g.cover || '' }),
    }).then(async (response) => ({ ok: response.ok, ...(await response.json().catch(() => ({})) ) }))
    return {
      success: true,
      cover: coverResult.ok && coverResult.url ? coverResult.url : g.cover || '',
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
  const [dailyQuestions, setDailyQuestions] = useState([])
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('lastSelectedId') || '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tokenReminderOpen, setTokenReminderOpen] = useState(false)
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
  const [badgesEnabled, setBadgesEnabled] = useState(false)
  const [badgesSaving, setBadgesSaving] = useState(false)
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
    return parseAnswererIds(selectedActivity?.exempted_answerer_ids)
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
    const { data: badgeData } = await supabase.from('keyflow_page_assets').select('image_data').eq('key', 'show_badges').maybeSingle()
    setBadgesEnabled(badgeData?.image_data === '1')
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

  const saveBadgesEnabled = async (enabled) => {
    setBadgesSaving(true); setError('')
    const { error: requestError } = await supabase.from('keyflow_page_assets').upsert({ key: 'show_badges', image_data: enabled ? '1' : '0', updated_at: new Date().toISOString() })
    setBadgesSaving(false)
    if (requestError) return setError(requestError.message)
    setBadgesEnabled(enabled)
    toast(enabled ? '我的徽章模块已开启' : '我的徽章模块已关闭')
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
      const pApp = supabase.from('keyflow_applications').select('*, keyflow_keys(claimed_at), keyflow_deliveries(id, status, article_url, article_title, claimed_word_count, verified_word_count)').order('submitted_at', { ascending: false }).limit(1000)
      // 其余数据用 then 处理，不阻塞 loading 状态
      Promise.all([
        supabase.from('keyflow_deliveries').select('id, application_id, status, article_url, article_title, claimed_word_count, verified_word_count, reviewer_note, reviewed_at, submitted_at').limit(1000),
        supabase.from('keyflow_daily_submissions').select('id, answerer_id, article_url, article_title, submitted_at, created_at, reviewed, processed, featured').order('submitted_at', { ascending: false }).limit(1000),
        supabase.rpc('keyflow_admin_daily_questions', { p_token: getAdminToken() }),
        supabase.from('keyflow_keys').select('id, activity_id, platform, application_id, created_at, claimed_at').order('created_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_invitation_codes').select('id, code, code_type, application_id, answerer_id, created_at, used_at').order('created_at', { ascending: false }).order('id').limit(1000),
        supabase.rpc('keyflow_admin_answerer_summaries', { p_token: getAdminToken() }),
        supabase.from('keyflow_inbox').select('id, title, body, status, from_id, to_id, type, created_at, read_at').neq('type', 'system').order('created_at', { ascending: false }).limit(1000),
        supabase.from('keyflow_password_reset_requests').select('id, answerer_id, status, requested_at, reviewed_at, admin_note').order('requested_at', { ascending: false }).limit(1000),
      ]).then(([d, ds, dq, k, ic, a, ib, r]) => {
        const failure = d.error || ds.error || dq.error || k.error || ic.error || a.error || ib.error || r.error
        if (failure) setError(failure.message)
        else {
          setDeliveries(d.data || []); setDailySubmissions(ds.data || []); setDailyQuestions(dq.data || []); setKeys(k.data || []); setInvitationCodes(ic.data || []); setAnswerers(a.data || []); setInboxMessages(ib.data || []); setPasswordResetRequests(r.data || [])
          // 延后迁移 base64 头像，答主列表由管理员 RPC 返回。
          Promise.all((a.data || []).map(async (answerer) => ({
            ...answerer,
            avatar_url: await migrateAvatarToStorage(answerer.id, answerer.avatar_url),
          }))).then((migrated) => setAnswerers(migrated))
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
  const STAGE_LABEL = { recruiting: '招募中', key_distribution: '招募截止请等待', delivery: '交付/创作中', completed: '项目完结' }

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

  const adminSessionBase = (() => { try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY)) } catch { return null } })()
  const [adminSessionState, setAdminSessionState] = useState(null)
  const adminSession = adminSessionState || adminSessionBase
  const adminToken = getAdminToken()
  useEffect(() => {
    const expiresAt = new Date(TENCENT_TOKEN_EXPIRES_AT).getTime()
    const shouldRemind = expiresAt - Date.now() <= 24 * 60 * 60 * 1000
    let remindedFor = null
    try { remindedFor = localStorage.getItem(TENCENT_TOKEN_REMINDER_KEY) } catch {}
    if (shouldRemind && remindedFor !== TENCENT_TOKEN_EXPIRES_AT) setTokenReminderOpen(true)
  }, [])
  const SUPER_ADMIN_USERNAMES = new Set(['admin', '灰域信风'])
  const isSuperAdmin = adminSession?.role === 'super_admin' || (!adminSession?.role && SUPER_ADMIN_USERNAMES.has(adminSession?.username))
  const adminSubTabs = [['个人设置', 'user'], ['管理员管理', 'users']]
  const [adminTab, setAdminTab] = useState('个人设置')
  const statusLabel = { pending: '待筛选', selected: '已入选', rejected: '未入选' }
  const deliveryStatusLabel = { pending: '待审核', approved: '已通过', revision_required: '需修改', rejected: '未通过' }
  const activityDeliveries = deliveries.filter((item) => filteredApplications.some((application) => application.id === item.application_id))
  const pendingDeliveries = activityDeliveries.filter((item) => item.status === 'pending').length
  const approvedDeliveries = activityDeliveries.filter((item) => item.status === 'approved').length
  const revisionDeliveries = activityDeliveries.filter((item) => item.status === 'revision_required').length

  const nav = [['活动看板', 'calendar'], ['活动概览', 'grid'], ['答主报名', 'users'], ['Key 管理', 'key'], ['交付验收', 'file'], ['答主管理', 'ticket'], ['合作方管理', 'users'], ['数据概览', 'grid'], ['全部活动投稿', 'inbox'], ['答主日常投稿', 'file'], ['日常问题运营', 'calendar'], ['游戏热点看板', 'eye'], ['剩余KEY管理', 'key'], ['页面编辑', 'image'], ['小工具', 'wrench']]

  const urlParams = new URLSearchParams(window.location.search)
  const pathname = window.location.pathname.replace(/\/+$/, '')

  const homePath = pathname === '/autokey/home' || pathname === '/autokey'
  if (urlParams.get('badge3d') === 'doroco') return <DorocoBadgePreview />
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

  const homeMode = !urlParams.has('admin') && (homePath || urlParams.get('home') !== null)
  if (homeMode) return <HomePage />

  // 管理员登录门控：无有效会话或旧session(id是伪UUID/缺role/session_token)时强制重登录。
  const SESSION_UPGRADE_REQUIRED = adminSession && (
    !adminSession?.role ||
    !adminSession?.session_token ||
    !adminSession?.id ||
    /^00000000-0000-0000-0000-00000000000[01]$/.test(adminSession?.id || '')
  )
  if (SESSION_UPGRADE_REQUIRED) {
    if (typeof window !== 'undefined') { localStorage.removeItem(ADMIN_SESSION_KEY); window.location.reload() }
    return null
  }
  // 自动跨答主/管理员登录：如果当前管理员 session 不存在，
  // 但答主身份是超级管理员白名单（admin / 灰域信风），就免密码自动拿管理员 session 写入 localStorage
  // 这样从答主看板点「切换到管理员后台」不需要再输账号密码。
  // ⚠️ 但是如果用户主动点了后台左下角「退出」按钮（KEYFLOW_ADMIN_FORCE_LOGIN=1），则强制进入管理员登录页，不自动跨身份。
  const [autoAdminLogging, setAutoAdminLogging] = useState(false)
  if (!adminSession && typeof window !== 'undefined' && !autoAdminLogging) {
    let forceLoginPage = false
    try { forceLoginPage = sessionStorage.getItem('KEYFLOW_ADMIN_FORCE_LOGIN') === '1' } catch {}
    if (!forceLoginPage) {
      let answerer = null
      try {
        const raw = localStorage.getItem('keyflow_answerer_session') || localStorage.getItem('keyflow_session') || localStorage.getItem('SESSION_KEY')
        if (raw) answerer = JSON.parse(raw)
      } catch {}
      const zhihuName = answerer?.zhihu_name || answerer?.name || answerer?.username
      if (['admin', '灰域信风'].includes(zhihuName)) {
        ;(async () => {
          setAutoAdminLogging(true)
          const { data, error } = await supabase.rpc('keyflow_admin_login_as_username', { p_username: zhihuName })
          if (!error && data) {
            localStorage.setItem(ADMIN_SESSION_KEY, typeof data === 'string' ? data : JSON.stringify(data))
            if (typeof window !== 'undefined') window.location.reload()
          } else {
            setAutoAdminLogging(true)
          }
        })()
        return <div className="admin-login-wrapper"><div className="admin-login-card"><p style={{textAlign:'center',padding:'2rem',color:'var(--c-ink-3)'}}>正在登录管理员后台…</p></div></div>
      }
    } else {
      // 用户点了退出：强制走 AdminLoginPage，并且等用户手动点了登录按钮成功之后
      // 我们在 AdminLoginPage 会清掉这个 flag；这里就不渲染自动登录卡，直接渲染 Suspense + AdminLoginPage
      // 所以什么额外的都不写，让下面一行 Suspense 接住
    }
  }
  if (!adminSession) return <Suspense fallback={<div className="admin-login-wrapper"><div className="admin-login-card"><p style={{textAlign:'center',padding:'2rem',color:'var(--c-ink-3)'}}>加载中…</p></div></div>}><AdminLoginPage /></Suspense>

  const claimLink = selectedActivity ? `${window.location.origin}${window.location.pathname}?apply=${selectedActivity.id}` : ''
  const partnerLink = selectedActivity?.partner_token ? `${window.location.origin}${window.location.pathname}?partner=${selectedActivity.partner_token}` : ''
  // 移动端：底部折叠导航面板开关（≤850px 时侧边栏隐藏，改由底部「菜单」弹出）
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const inboxUnreadCount = inboxMessages.filter(m => m.type === 'password_reset' && m.status === 'unread').length

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href={window.location.pathname + '?home'}><span className="brand-mark zhihu-mark">知</span>GameJourney</a>
      <div className="sidebar-divider" />
      <nav className="nav-section"><p className="nav-label">工作台</p>{nav.map(([label, icon]) => { const disabled = !hasAdminPermission(adminSession, isSuperAdmin, label); return <button key={label} className={`nav-item ${label === '答主管理' ? 'nav-item-after-divider' : ''} ${active === label ? 'active' : ''} ${disabled ? 'nav-item-disabled' : ''}`} onClick={() => setActive(label)} style={disabled ? { opacity: active === label ? 1 : 0.45 } : undefined}>{label === '答主管理' && <small className="nav-global-label">全局管理</small>}<Icon name={icon}/><span>{label}</span>{label === '活动看板' && boardPendingCount > 0 && <b className="nav-alert">{boardPendingCount}</b>}{label === '答主报名' && pendingCount > 0 && <b>{pendingCount}</b>}</button> })}</nav>
      <div className="sidebar-inbox-area">
        {(() => { const inboxDisabled = !hasAdminPermission(adminSession, isSuperAdmin, '收件箱'); return <button className={`sidebar-inbox-btn ${active === '收件箱' ? 'active' : ''}`} onClick={() => setActive('收件箱')} title="收件箱" style={inboxDisabled && active !== '收件箱' ? { opacity: 0.45 } : undefined}>
          <Icon name="inbox" size={20}/>
          <span>收件箱</span>
          {inboxMessages.filter(m => m.type === 'password_reset' && m.status === 'unread').length > 0 && <b className="nav-alert">{inboxMessages.filter(m => m.type === 'password_reset' && m.status === 'unread').length}</b>}
        </button> })()}
      </div>
      <div className={`profile ${active === '管理员中心' ? 'profile-active' : ''}`} onClick={() => setActive('管理员中心')} title="管理员中心">
        <span className="avatar">{adminSession?.avatar_url ? <img src={adminSession.avatar_url} alt=""/> : (adminSession?.display_name?.[0] || '管')}</span>
        <div className="profile-info">
          <strong>{adminSession?.display_name || '管理员'}</strong>
          <small>{adminSession?.role === 'super_admin' ? '超级管理员' : '运营方'}</small>
        </div>
        <button className="admin-logout-btn" title="退出登录" onClick={(e) => { e.stopPropagation(); localStorage.removeItem(ADMIN_SESSION_KEY); try { sessionStorage.setItem('KEYFLOW_ADMIN_FORCE_LOGIN', '1') } catch {}; window.location.href = window.location.pathname + '?admin' }}>退出</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><a className="mobile-brand" href={window.location.pathname + '?home'}><span className="brand-mark zhihu-mark">知</span> GameJourney</a><div className="crumb">工作台 <span>/</span> {active}</div><div className="topbar-links"><a className="topbar-link-btn" href={window.location.pathname + '?partner'} target="_blank">合作方看板</a><a className="topbar-link-btn" href={window.location.pathname + '?dashboard'} target="_blank">答主看板</a><a className="topbar-link-btn" href={window.location.pathname + '?home'} target="_blank">展示页</a><button className="reload" onClick={loadData}>刷新数据</button></div></header>
      <section className="content">
        <div className="page-title"><div><p className="eyebrow">真实数据工作台</p><h1>{active}{active === '活动看板' && <span className="board-game-count"> 当前已有 <b>{activities.length}</b> 款游戏入库</span>}{['活动概览', '答主报名', 'Key 管理', '交付验收'].includes(active) && selectedActivity?.game_name && <><span className="title-divider">|</span>{selectedActivity.game_name}</>}</h1><p className="subtitle">{active === '页面编辑' ? '管理注册页面的展示资源，保存后会实时同步。' : active === '小工具' ? '文本本地处理，AI 生成仅当次使用，不会保存内容。' : '活动、报名、Key 与交付数据均实时保存至 Supabase。'}</p></div>{active === '答主报名' ? <div style={{ display: 'flex', gap: 'var(--sp-2)' }}><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button></div> : ['页面编辑', '小工具'].includes(active) ? null : active === '活动看板' ? <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center' }} className="page-title-actions"><div className="board-sort-wrap"><select className="board-sort-select" value={boardSort} onChange={e => setBoardSort(e.target.value)}><option value="pending_first">优先未处理</option><option value="default">默认排序</option><option value="created_at_desc">入库时间 ↓</option><option value="created_at_asc">入库时间 ↑</option><option value="release_date_desc">发售时间 ↓</option><option value="release_date_asc">发售时间 ↑</option></select><svg className="board-sort-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></div><button className={`board-fav-filter-btn ${boardFavFilter ? 'active' : ''}`} onClick={() => setBoardFavFilter(v => !v)} title={boardFavFilter ? '显示全部' : '只显示收藏'}><Icon name="star" size={14}/><span>收藏</span></button><div className="board-status-filter"><button className={`board-fav-filter-btn ${boardStatusFilter.size > 0 ? 'active' : ''}`} onClick={() => setBoardStatusMenuOpen(v => !v)} title="按活动阶段筛选"><Icon name="eye" size={14}/><span>只看</span>{boardStatusFilter.size > 0 && <span className="board-status-count">{boardStatusFilter.size}</span>}</button>{boardStatusMenuOpen && <><div className="board-status-backdrop" onClick={() => setBoardStatusMenuOpen(false)} /><div className="board-status-menu">{STAGES.map((status) => <label key={status} className={`board-status-option ${boardStatusFilter.has(status) ? 'active' : ''}`}><input type="checkbox" checked={boardStatusFilter.has(status)} onChange={() => toggleBoardStatusFilter(status)} /><span>{STAGE_LABEL[status]}</span></label>)}</div></>}</div><div className="partner-search-wrap" style={{ background: '#fff', minWidth: 260, gap: 'var(--sp-1)', padding: 'var(--sp-1) var(--sp-2)' }}><Icon name="search" size={14} /><input className="partner-search-input" placeholder="搜索活动名称或游戏名…" value={boardSearch} onChange={e => setBoardSearch(e.target.value)} />{boardSearch && <button className="partner-search-clear" onClick={() => setBoardSearch('')}><Icon name="close" size={14} /></button>}</div>{activities.some(a => a.steam_url && !a.release_date) && <button className="outline-button" onClick={batchFillReleaseDates} disabled={batchFillingRelease}>{batchFillingRelease ? `更新中 ${batchFillProgress}` : '更新发售时间'}</button>}<button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : <button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button>}</div>
        {error && <div className="error-box">数据操作失败：{error}<button onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {!hasAdminPermission(adminSession, isSuperAdmin, active) && active !== '管理员中心' && active !== '小工具'
          ? <PermissionBlockedPlaceholder />
          : loading && !['页面编辑', '小工具'].includes(active) ? <div className="empty-state">正在加载活动数据…</div> : active === '活动概览' && !selectedActivity ? <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建第一个测评活动</h2><p>创建后即可收集答主报名、导入 Key 并进行交付验收。</p><button className="primary" onClick={() => { setActivityForm({...initialActivity, ...getDefaultDeadlines()}); setGameCoverUpload(null); setActivityModal(true); }}><Icon name="plus"/> 创建活动</button></div> : active === '活动概览' ? <>
          <section className="activity-picker"><button className="current-activity" onClick={openDrawer}><span>当前活动</span><strong>{selectedActivity.title}</strong><Icon name="arrow" size={14}/></button><div className="activity-picker-right"><span className={`activity-status ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span><button className="outline-button" onClick={() => { navigator.clipboard.writeText(partnerLink); toast('合作方页面链接已复制') }}>复制合作方链接</button><button className="outline-button preview-partner-btn" onClick={() => window.open(partnerLink, '_blank')}>预览合作方页</button><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimLink); toast('申领链接已复制，可直接发送给答主') }}>复制申领链接</button><button className="outline-button preview-claim-btn" onClick={() => window.open(claimLink, '_blank')}>预览申领页</button><button className="outline-button" onClick={() => setApplicationModal(true)}><Icon name="plus" size={16}/> 新增报名</button></div></section>
          <section className="hero-card real-hero"><div className="hero-top"><div><span className="live-dot"/> <span className={`stage-badge ${STAGE_COLOR[selectedActivity.status] || ''}`}>{STAGE_LABEL[selectedActivity.status] || selectedActivity.status}</span> <span className="divider">|</span> <span className={(selectedActivity?.status === 'recruiting' && selectedActivity?.application_deadline && new Date(selectedActivity.application_deadline) < new Date()) ? 'text-red' : ''}>{getStatusTimeText(selectedActivity, filteredApplications)}</span></div><button className="edit-button" onClick={openEditActivity}><Icon name="edit" size={15}/> 编辑</button></div><div className="game-info"><div className="game-cover">{selectedActivity.game_cover ? <img src={selectedActivity.game_cover} alt={selectedActivity.game_name}/> : <span>{selectedActivity.game_name[0]}</span>}</div><div><p className="game-type">{selectedActivity.game_name}</p><h2>{selectedActivity.title}</h2><p>{selectedActivity.description || '尚未填写游戏简介。'}</p><p className="review-requirement">{selectedActivity.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'}</p></div></div>{(() => { const platforms = Array.isArray(selectedActivity.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return (platforms.length > 1 || platforms[0] !== 'steam') && <div className="admin-platforms"><span>可选版本</span>{platforms.map((value) => { const platform = activityPlatforms.find((item) => item.value === value); return <span key={value} className="admin-platform"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{platform?.icon}</svg>{platformLabel[value] || value}</span> })}</div> })()}<div className="rules-row main-question-row"><strong>测评主问题</strong>{editingMainQuestion ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={mainQuestionDraft} onChange={(e) => setMainQuestionDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={saveMainQuestion}>保存</button><button className="inline-cancel" onClick={() => { setEditingMainQuestion(false) }}>取消</button></div></div> : <div className="inline-display"><span>{selectedActivity.main_question || '尚未设置'}</span><button className="inline-edit-btn" title="编辑主问题" onClick={() => { setMainQuestionDraft(selectedActivity.main_question || ''); setEditingMainQuestion(true) }}><Icon name="edit" size={14}/></button></div>}</div>{subQuestions.map((q, i) => <div className="rules-row sub-question-row" key={i}><strong>相关问题 {i + 1}</strong>{editingSubIndex === i ? <div className="inline-edit-wrap"><textarea className="inline-textarea" value={subDraft} onChange={(e) => setSubDraft(e.target.value)} autoFocus rows={2}/><div className="inline-edit-actions"><button className="inline-save" onClick={() => saveSubQuestion(i)}>保存</button><button className="inline-cancel" onClick={() => setEditingSubIndex(null)}>取消</button></div></div> : <div className="inline-display"><span>{q || '空问题'}</span><button className="inline-edit-btn" title="编辑相关问题" onClick={() => { setSubDraft(q); setEditingSubIndex(i) }}><Icon name="edit" size={14}/></button><button className="inline-delete-btn" title="删除相关问题" onClick={() => deleteSubQuestion(i)}><Icon name="close" size={14}/></button></div>}</div>)}<button className="add-sub-btn" onClick={addSubQuestion}><Icon name="plus" size={14}/> 新增相关问题</button></section>
          <section className="metrics">{[[filteredApplications.length,'报名答主',`目标 ${selectedActivity.target_authors} 人`,'答主报名'],[selectedCount,'已入选',`已录入key ${importedKeyCount} 个`,'答主报名'],[claimedCount,'已领取 Key',`${selectedCount - claimedCount}/${selectedCount} 人 未领取key`,'Key 管理'],[deliveredCount,'已提交交付',`${selectedCount - deliveredCount}/${selectedCount} 人未交付`,'交付验收']].map(([number,label,note,target], idx) => <div className="metric clickable" key={label} onClick={() => setActive(target)}><strong style={idx === 1 && selectedCount > importedKeyCount ? {color:'#e53e3e'} : undefined}>{number}</strong><span>{label}</span><small>{note}</small></div>)}</section>
          <div className="exemption-deferred-row">
            <section className="exemption-panel panel half-panel"><div className="panel-head"><div><h3>豁免答主（已豁免 {exemptedAnswerers.length} 人）</h3><p>已完结活动可为指定答主开放投稿豁免，允许其在活动完结后继续提交作品。</p></div></div><div className="exemption-body">{exemptedAnswerers.length > 0 && <div className="exemption-list">{exemptedAnswerers.map(a => <div key={a.id} className="exemption-tag"><span className="exemption-tag-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-tag-name">{a.zhihu_name}</span><button className="exemption-tag-remove" onClick={() => removeExemptedAnswerer(a.id)} title="移除豁免"><Icon name="close" size={12}/></button></div>)}</div>}<div className="exemption-search-wrap"><input className="exemption-search-input" placeholder="搜索答主…" value={exemptionSearch} onChange={e => setExemptionSearch(e.target.value)} /></div>{exemptionSearch.trim() ? (() => { const candidates = answerers.filter(a => !exemptedIds.includes(a.id) && matchesSearch(a.zhihu_name, exemptionSearch)); return <div className="exemption-candidate-list">{candidates.length > 0 ? candidates.map(a => <label key={a.id} className={`exemption-candidate-row ${exemptionSelected.has(a.id) ? 'checked' : ''}`}><input type="checkbox" checked={exemptionSelected.has(a.id)} onChange={() => toggleExemptionSelect(a.id)} /><span className="exemption-candidate-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-candidate-name">{a.zhihu_name}</span></label>) : <div className="exemption-candidate-empty">没有匹配的答主</div>}</div> })() : <div className="exemption-candidate-hint">共 {answerers.filter(a => !exemptedIds.includes(a.id)).length} 位答主可选，输入关键词搜索</div>}<button className="primary exemption-add-btn" onClick={addExemptedAnswerers} disabled={exemptionSelected.size === 0 || exemptionAdding}>{exemptionAdding ? '添加中…' : `添加选中答主${exemptionSelected.size > 0 ? ` (${exemptionSelected.size})` : ''}`}</button></div></section>
            <section className="deferred-panel panel half-panel"><div className="panel-head"><div><h3>延期答主</h3><p>项目关闭后，选定答主仍可提交作品，但会计入一次延期提交。</p></div></div><div className="exemption-body">{deferredAnswerers.length > 0 && <div className="exemption-list">{deferredAnswerers.map(a => <div key={a.id} className="exemption-tag"><span className="exemption-tag-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-tag-name">{a.zhihu_name}</span><button className="exemption-tag-remove" onClick={() => removeDeferredAnswerer(a.id)} title="移除延期"><Icon name="close" size={12}/></button></div>)}</div>}<div className="exemption-search-wrap"><input className="exemption-search-input" placeholder="搜索答主…" value={deferredSearch} onChange={e => setDeferredSearch(e.target.value)} /></div>{deferredSearch.trim() ? (() => { const candidates = answerers.filter(a => !deferredIds.includes(a.id) && matchesSearch(a.zhihu_name, deferredSearch)); return <div className="exemption-candidate-list">{candidates.length > 0 ? candidates.map(a => <label key={a.id} className={`exemption-candidate-row ${deferredSelected.has(a.id) ? 'checked' : ''}`}><input type="checkbox" checked={deferredSelected.has(a.id)} onChange={() => toggleDeferredSelect(a.id)} /><span className="exemption-candidate-avatar">{a.avatar_url ? <img src={a.avatar_url} alt=""/> : a.zhihu_name?.charAt(0)}</span><span className="exemption-candidate-name">{a.zhihu_name}</span></label>) : <div className="exemption-candidate-empty">没有匹配的答主</div>}</div> })() : <div className="exemption-candidate-hint">共 {answerers.filter(a => !deferredIds.includes(a.id)).length} 位答主可选，输入关键词搜索</div>}<button className="primary exemption-add-btn" onClick={addDeferredAnswerers} disabled={deferredSelected.size === 0 || deferredAdding}>{deferredAdding ? '添加中…' : `添加选中答主${deferredSelected.size > 0 ? ` (${deferredSelected.size})` : ''}`}</button></div></section>
          </div>
          <section className="stage-progression"><div className="stage-header"><div><h3>阶段推进</h3><span>点击圆点或文字一键切换至对应阶段。</span></div></div><div className="stage-timeline">{STAGES.map((stage, i) => { const currentIdx = STAGES.indexOf(selectedActivity?.status || 'recruiting'); const isCurrent = i === currentIdx; const isPast = i < currentIdx; return <div key={stage} className={`stage-node ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}><button className="stage-dot-btn" disabled={isCurrent || advancing} onClick={() => goToStage(stage)} title={`切换到：${STAGE_LABEL[stage]}`}><span className="stage-dot"/></button><button className="stage-label" disabled={isCurrent || advancing} onClick={() => goToStage(stage)}>{STAGE_LABEL[stage]}</button></div> })}</div></section>
          <section className="panel applicants-panel"><div className="panel-head"><div><h3>答主报名</h3><p>查看答主报名、Key 领取和内容提交状态。</p></div><button className="primary compact" onClick={() => setApplicationModal(true)}><Icon name="plus" size={15}/> 新增报名</button></div><div className="table-wrap"><table><thead><tr><th>答主</th><th>查看主页</th><th className="th-sort" onClick={() => toggleOverviewSort('status')}>入选状态{overviewSort?.key === 'status' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th>{(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? <th>版本</th> : null })()}<th className="th-sort" onClick={() => toggleOverviewSort('claimed')}>是否领取 Key{overviewSort?.key === 'claimed' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th><th className="th-sort" onClick={() => toggleOverviewSort('delivered')}>是否提交内容{overviewSort?.key === 'delivered' ? <span className="th-sort-arrow">{overviewSort.dir === -1 ? '↑' : '↓'}</span> : null}</th><th>合作方推荐</th><th>操作</th></tr></thead><tbody>{overviewApplications.length ? overviewApplications.map((person) => <tr key={person.id}><td><div className="person">{answererByName[person.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[person.zhihu_name].avatar_url} alt="" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) setSelectedAnswerer(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { const a = answererByName[person.zhihu_name]; if (a) setSelectedAnswerer(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{person.zhihu_name[0]}</span>}<div><strong>{person.zhihu_name}</strong><small>知乎答主</small></div></div></td><td><a className="profile-link" href={person.profile_url} target="_blank" rel="noreferrer">查看主页</a></td><td><span className={`pill ${person.status === 'selected' ? 'success' : person.status === 'pending' ? 'warning' : 'muted'}`}>{statusLabel[person.status]}</span></td>{(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? <td><span className="pill">{platformLabel[person.selected_platform] || 'Steam'}</span></td> : null })()}<td><span className={`pill ${person.keyflow_keys?.claimed_at || exemptedIds.includes(person.answerer_id) ? 'success' : 'muted'}`}>{person.keyflow_keys?.claimed_at || exemptedIds.includes(person.answerer_id) ? '已领取' : '未领取'}</span></td><td><button className={`pill pill-link ${(Array.isArray(person.keyflow_deliveries) ? person.keyflow_deliveries.length > 0 : person.keyflow_deliveries?.id) ? 'success' : 'muted'}`} onClick={() => setActive('交付验收')}>{(Array.isArray(person.keyflow_deliveries) ? person.keyflow_deliveries.length > 0 : person.keyflow_deliveries?.id) ? '已提交' : '未提交'}</button></td><td>{person.partner_recommended ? <span className="highlight-red">推荐</span> : '—'}</td><td><div className="review-actions">{person.status === 'pending' ? <><button className="select-action" onClick={() => reviewApplication(person.id, 'selected')}>入选</button><button className="reject-action" onClick={() => reviewApplication(person.id, 'rejected')}>不选</button></> : <button className="reset-action" disabled={!!person.keyflow_keys?.claimed_at} onClick={() => reviewApplication(person.id, 'pending')}>重新筛选</button>}</div></td></tr>) : <tr><td colSpan={(() => { const ap = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return ap.length > 1 || ap[0] !== 'steam' ? 8 : 7 })()} className="table-empty">还没有报名记录。可添加测试报名，或后续将表单公开给答主填写。</td></tr>}</tbody></table></div></section>
        </> : active === '活动看板' ? <div className="activity-cards">{filteredBoardActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); const creatingCount = apps.filter(a => a.status === 'selected' && a.keyflow_keys?.claimed_at).length; const deliveredCount = apps.filter(a => Array.isArray(a.keyflow_deliveries) ? a.keyflow_deliveries.length > 0 : a.keyflow_deliveries?.id).length; const mainQuestionUrl = item.main_question?.match(/https?:\/\/[^\s]+/)?.[0]; return <div key={item.id} className={`activity-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setActive('活动概览') }}><button className="activity-card-delete" title="删除活动" onClick={(e) => deleteActivity(item.id, e)}><Icon name="close" size={14}/></button><button className={`activity-card-fav ${item.is_favorite ? 'active' : ''}`} title={item.is_favorite ? '取消收藏' : '收藏'} onClick={(e) => toggleFavorite(item.id, item.is_favorite, e)}><Icon name="star" size={14}/></button><div className="activity-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="activity-card-body"><p className="activity-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="activity-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{item.status === 'delivery' ? `${creatingCount} 人创作中` : item.status === 'completed' ? `${deliveredCount} 篇作品` : <>{apps.length} 报名{apps.filter(a => a.status === 'pending').length > 0 && <span className="text-red"> {apps.filter(a => a.status === 'pending').length} 未处理</span>}</>}</span></div><small className={(item.status === 'recruiting' && item.application_deadline && new Date(item.application_deadline) < new Date()) ? 'text-red' : ''}>{getStatusTimeText(item, apps)}</small><div className="activity-card-actions"><div className="activity-card-online" onClick={(e) => toggleOnline(item.id, item.is_online !== false, e)} title={item.is_online !== false ? '已上线，点击下线' : '未上线，点击上线'}><span className={`online-toggle ${item.is_online !== false ? 'active' : ''}`}><span className="online-toggle-knob"/></span><span className="online-label">{item.is_online !== false ? '已上线' : '未上线'}</span></div>{mainQuestionUrl ? <a className="main-question-link" href={mainQuestionUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>跳转主问题</a> : <span className="main-question-unconfigured">暂未配置主问题</span>}</div></div></div> })}</div> : active === '答主报名' ? <ApplicationsPage activity={selectedActivity} applications={filteredApplications} answerers={answerers} authorStats={authorStats} statusLabel={statusLabel} onSelectActivity={openDrawer} onAddApplication={() => setApplicationModal(true)} onReviewApplication={reviewApplication} onDeleteApplication={deleteApplication} toast={toast} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === 'Key 管理' ? <KeyManagement activity={selectedActivity} input={keyInput} parsedKeys={parsedKeys} platformCounts={platformCounts} importedKeys={keys.filter((item) => item.activity_id === selectedActivity?.id)} importing={keyImporting} onInput={setKeyInput} onImport={importKeys} onDeleteKeys={deleteKeys} onSelectActivity={openDrawer} applications={filteredApplications} toast={toast}/> : active === '交付验收' ? <DeliveriesPage activity={selectedActivity} deliveries={activityDeliveries} applications={filteredApplications} answerers={answerers} statusLabel={deliveryStatusLabel} notes={deliveryNotes} onNoteChange={(id, value) => setDeliveryNotes((items) => ({ ...items, [id]: value }))} onReview={reviewDelivery} onSelectActivity={openDrawer} pendingCount={pendingDeliveries} approvedCount={approvedDeliveries} revisionCount={revisionDeliveries} toast={toast} participationByAnswerer={participationByAnswerer} onWordCountUpdate={(id, wordCount) => setDeliveries((items) => items.map((item) => item.id === id ? { ...item, verified_word_count: wordCount } : item))} /> : active === '答主管理' ? <AnswererManagement codes={invitationCodes} answerers={answerers} setAnswerers={setAnswerers} activities={activities} applications={applications} deliveries={deliveries} dailySubmissions={dailySubmissions} onAddCodes={prependCodes} onDeleteAnswerer={(id) => setAnswerers((items) => items.filter((item) => item.id !== id))} adminToken={adminToken} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '关注问题看板' ? <ZhihuFollowingQuestions adminToken={adminToken} /> : active === '收藏问题后台' ? <ZhihuFavoriteQuestions adminToken={adminToken} /> : active === '游戏热点看板' ? <GameHotTopicsBoard /> : active === '合作方管理' ? <PartnerManagement codes={invitationCodes} answerers={answerers} setAnswerers={setAnswerers} activities={activities} setActivities={setActivities} onAddCodes={prependCodes} onRefresh={loadData} adminToken={adminToken} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} /> : active === '数据概览' ? <AnalyticsOverview adminToken={adminToken} /> : active === '全部活动投稿' ? <AllActivitySubmissionsPage deliveries={deliveries} applications={applications} activities={activities} answerers={answerers} toast={toast} /> : active === '答主日常投稿' ? <DailySubmissionsPage submissions={dailySubmissions} answerers={answerers} toast={toast} setDailySubmissions={setDailySubmissions} participationByAnswerer={participationByAnswerer} onViewAnswererParticipation={setSelectedAnswerer} setConfirmState={setConfirmState} /> : active === '日常问题运营' ? <DailyQuestionOperationsPage questions={dailyQuestions} setQuestions={setDailyQuestions} adminToken={adminToken} toast={toast} setDailySubmissions={setDailySubmissions} /> : active === '剩余KEY管理' ? <RemainingKeyManagement keys={keys} activities={activities} toast={toast} onDeleteKeys={deleteKeys} onClaimKey={claimKeyRemotely} /> : active === '页面编辑' ? <PageEditor asset={pageAsset} loading={pageAssetLoading} saving={pageAssetSaving} onSelectFile={handlePageAssetFile} onSave={savePageAsset} badgesEnabled={badgesEnabled} badgesSaving={badgesSaving} onToggleBadges={saveBadgesEnabled} adminToken={adminToken} toast={toast} setError={setError} /> : active === '小工具' ? <TextFormatter /> : active === '收件箱' ? <InboxPage messages={inboxMessages} requests={passwordResetRequests} answerers={answerers} adminToken={adminToken} onRefresh={loadData} onMessageRead={(id) => setInboxMessages((items) => items.map((item) => item.id === id ? { ...item, status: 'read', read_at: new Date().toISOString() } : item))} onDeleteMessages={(ids) => { const deletedIds = new Set(ids); setInboxMessages((items) => items.filter((item) => !deletedIds.has(item.id))) }} toast={toast} setConfirmState={setConfirmState} /> : active === '管理员中心' ? <AdminManagementPage adminSession={adminSession} isSuperAdmin={isSuperAdmin} adminSubTabs={adminSubTabs} adminTab={adminTab} setAdminTab={setAdminTab} onUpdateAdminSession={(next, opts) => {
  const raw = localStorage.getItem(ADMIN_SESSION_KEY) || '{}'
  let base = {}
  try { base = JSON.parse(raw) } catch {}
  const merged = { ...base, ...next }
  localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(merged))
  setAdminSessionState(merged)
  if (opts?.reload) window.location.reload()
}} toast={toast} setConfirmState={setConfirmState} setError={setError} /> : <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>{active}即将开放</h2><p>请先完成活动与答主报名管理。</p></div>}
      </section>
        {selectedAnswerer && <AnswererParticipationModal answerer={selectedAnswerer} records={participationByAnswerer[selectedAnswerer.id] || []} onClose={() => setSelectedAnswerer(null)} toast={toast} />}
      </main>
    <nav className="mobile-nav">
      <button className={`mobile-nav-menu-btn ${mobileNavOpen ? 'active' : ''}`} onClick={() => { window.getSelection?.()?.removeAllRanges(); setMobileNavOpen(true) }}>
        <Icon name="grid" size={18}/><span>菜单</span>
        {(boardPendingCount > 0 || pendingCount > 0 || inboxUnreadCount > 0) && <b className="mobile-nav-badge">{boardPendingCount + pendingCount + inboxUnreadCount}</b>}
      </button>
      <span className="mobile-nav-crumb">{active}</span>
      <button className="mobile-nav-profile" title="管理员中心" onClick={() => setActive('管理员中心')}><span className="avatar">{adminSession?.avatar_url ? <img src={adminSession.avatar_url} alt=""/> : (adminSession?.display_name?.[0] || '管')}</span></button>
    </nav>
    {mobileNavOpen && <>
      <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />
      <div className="mobile-nav-sheet">
        <div className="mobile-nav-sheet-grabber" />
        <header className="mobile-nav-sheet-head"><h2>菜单</h2><button onClick={() => setMobileNavOpen(false)} title="收起"><Icon name="close" size={16}/></button></header>
        <div className="mobile-nav-sheet-list">
          {nav.map(([label, icon]) => { const disabled = !hasAdminPermission(adminSession, isSuperAdmin, label); const badge = label === '活动看板' ? boardPendingCount : label === '答主报名' ? pendingCount : 0; return <div key={label}>{label === '答主管理' && <div className="mobile-nav-group"><small>全局管理</small></div>}<button className={`mobile-nav-item ${active === label ? 'active' : ''}`} style={disabled ? { opacity: active === label ? 1 : 0.45 } : undefined} onClick={() => { setActive(label); setMobileNavOpen(false) }}><Icon name={icon}/><span>{label}</span>{badge > 0 && <b>{badge}</b>}</button></div> })}
        </div>
        <footer className="mobile-nav-sheet-foot">
          <button className={`mobile-nav-inbox ${active === '收件箱' ? 'active' : ''}`} onClick={() => { setActive('收件箱'); setMobileNavOpen(false) }}><Icon name="inbox" size={18}/><span>收件箱</span>{inboxUnreadCount > 0 && <b className="nav-alert">{inboxUnreadCount}</b>}</button>
          <div className="mobile-nav-profile-row">
            <span className="avatar">{adminSession?.avatar_url ? <img src={adminSession.avatar_url} alt=""/> : (adminSession?.display_name?.[0] || '管')}</span>
            <div className="profile-info"><strong>{adminSession?.display_name || '管理员'}</strong><small>{adminSession?.role === 'super_admin' ? '超级管理员' : '运营方'}</small></div>
            <button className="admin-logout-btn" title="退出登录" onClick={(e) => { e.stopPropagation(); localStorage.removeItem(ADMIN_SESSION_KEY); try { sessionStorage.setItem('KEYFLOW_ADMIN_FORCE_LOGIN', '1') } catch {}; window.location.href = window.location.pathname + '?admin' }}>退出</button>
          </div>
        </footer>
      </div>
    </>}
    {drawerOpen && <div className="drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><header className="drawer-header"><h2>切换活动</h2><button onClick={() => setDrawerOpen(false)}><Icon name="close"/></button></header><div className="drawer-search"><Icon name="grid" size={16}/><input placeholder="搜索活动名称或游戏名…" value={drawerSearch} onChange={(event) => setDrawerSearch(event.target.value)} autoFocus/></div><div className="drawer-list">{filteredDrawerActivities.length ? filteredDrawerActivities.map((item) => { const apps = applications.filter((a) => a.activity_id === item.id); return <div key={item.id} className={`drawer-card ${item.id === selectedId ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setDrawerOpen(false) }}><div className="drawer-card-cover">{item.game_cover ? <img src={item.game_cover} alt={item.game_name}/> : <span>{item.game_name[0]}</span>}</div><div className="drawer-card-body"><p className="drawer-card-game">{item.game_name}</p><h3>{item.title}</h3><div className="drawer-card-meta"><span className={`pill ${STAGE_COLOR[item.status] || ''}`}>{STAGE_LABEL[item.status] || item.status}</span><span>{apps.length} 报名</span></div></div></div> }) : <div className="drawer-empty">没有匹配的活动</div>}</div></aside></div>}
    {activityModal && <Modal title="创建测评活动" onClose={() => setActivityModal(false)}><form onSubmit={createActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field steam-field"><span>PlayStation 游戏页面</span><div className="steam-input-row"><input type="url" placeholder="https://www.playstation.com/.../games/..." value={activityForm.ps_url || ''} onChange={(event) => setActivityForm({ ...activityForm, ps_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handlePSFetch} disabled={psFetching}>{psFetching ? '抓取中…' : '抓取'}</button></div></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><DateTimeField label="游戏发售时间" value={activityForm.release_date || ''} onChange={(value) => setActivityForm({ ...activityForm, release_date: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/><PlatformSelector value={activityForm.platforms} onChange={(platforms) => setActivityForm({ ...activityForm, platforms })}/><div className="cover-upload-section"><label className="field"><span>游戏封面</span><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>优先从 Steam 或 PlayStation 抓取；如未抓取到封面，可手动上传。图片不超过 500KB。</small></label><div className="cover-upload-row"><label className="outline-button cover-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleGameCoverFile(e.target.files[0])} hidden/></label>{gameCoverUpload && <button type="button" className="btn-secondary" onClick={() => { setGameCoverUpload(null); setActivityForm(prev => ({ ...prev, game_cover: '' })) }}>移除上传</button>}</div>{gameCoverUpload ? <div className="cover-upload-preview"><img src={gameCoverUpload} alt="手动上传封面"/><span>已手动上传封面（{Math.round(gameCoverUpload.length * 0.75 / 1024)}KB）</span></div> : activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}</div><button className="primary form-submit" disabled={creating}>{creating ? '创建中…' : '保存并创建'}</button></form></Modal>}
    {applicationModal && <Modal title="新增答主报名" onClose={() => setApplicationModal(false)}><form onSubmit={createApplication} className="form-grid"><Field label="知乎 ID（可选，用于防重复）" value={applicationForm.zhihu_id} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_id: value })} placeholder="知乎 OAuth 返回的用户 ID"/><Field label="知乎名称" required value={applicationForm.zhihu_name} onChange={(value) => setApplicationForm({ ...applicationForm, zhihu_name: value })}/><Field label="微信名" required value={applicationForm.wechat_name} onChange={(value) => setApplicationForm({ ...applicationForm, wechat_name: value })}/><Field label="知乎主页地址" type="url" required value={applicationForm.profile_url} onChange={(value) => setApplicationForm({ ...applicationForm, profile_url: value })}/><Field label="预计完成字数" type="number" required value={applicationForm.expected_word_count} onChange={(value) => setApplicationForm({ ...applicationForm, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setApplicationForm({ ...applicationForm, expected_word_count: 800 }) }}/><span className="word-min-hint">最低 800 字</span>{(() => { const platforms = Array.isArray(selectedActivity?.platforms) && selectedActivity.platforms.length ? selectedActivity.platforms : ['steam']; return platforms.length > 1 || platforms[0] !== 'steam' ? <label className="field"><span>游戏版本</span><select value={applicationForm.selected_platform || 'steam'} onChange={(e) => setApplicationForm({ ...applicationForm, selected_platform: e.target.value })}>{platforms.map(p => <option key={p} value={p}>{platformLabel[p] || p}</option>)}</select></label> : null })()}<button className="primary form-submit">保存报名</button></form></Modal>}
    {editActivityModal && <Modal title="编辑活动" onClose={() => setEditActivityModal(false)}><form onSubmit={updateActivity} className="form-grid"><Field label="活动标题" required value={activityForm.title} onChange={(value) => setActivityForm({ ...activityForm, title: value })}/><Field label="游戏名称" required value={activityForm.game_name} onChange={(value) => setActivityForm({ ...activityForm, game_name: value })}/><label className="field steam-field"><span>Steam 商店地址</span><div className="steam-input-row"><input type="url" placeholder="https://store.steampowered.com/app/..." value={activityForm.steam_url || ''} onChange={(event) => setActivityForm({ ...activityForm, steam_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handleSteamFetch} disabled={steamFetching}>{steamFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field steam-field"><span>PlayStation 游戏页面</span><div className="steam-input-row"><input type="url" placeholder="https://www.playstation.com/.../games/..." value={activityForm.ps_url || ''} onChange={(event) => setActivityForm({ ...activityForm, ps_url: event.target.value })}/><button type="button" className="btn-secondary steam-fetch-btn" onClick={handlePSFetch} disabled={psFetching}>{psFetching ? '抓取中…' : '抓取'}</button></div></label><label className="field"><span>关联合作方</span><select value={activityForm.partner_answerer_id || ''} onChange={(e) => setActivityForm({ ...activityForm, partner_answerer_id: e.target.value || null })}><option value="">— 不关联合作方 —</option>{partnerAnswerers.map((a) => <option key={a.id} value={a.id}>{a.zhihu_name}{a.wechat_id ? ` (${a.wechat_id})` : ''}</option>)}</select><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>关联后，该合作方登录可查看此活动协作页。需先在「合作方管理」中生成并注册合作方账号。</small></label><Field label="目标答主数" type="number" required value={activityForm.target_authors} onChange={(value) => setActivityForm({ ...activityForm, target_authors: value })}/><DateTimeField label="报名截止时间" value={activityForm.application_deadline} onChange={(value) => setActivityForm({ ...activityForm, application_deadline: value })}/><DateTimeField label="交付截止时间" value={activityForm.delivery_deadline} onChange={(value) => setActivityForm({ ...activityForm, delivery_deadline: value })}/><DateTimeField label="游戏发售时间" value={activityForm.release_date || ''} onChange={(value) => setActivityForm({ ...activityForm, release_date: value })}/><Field label="游戏简介" textarea value={activityForm.description || ''} onChange={(value) => setActivityForm({ ...activityForm, description: value })}/><Field label="测评要求" textarea value={activityForm.review_requirement || '测评要求：图文并茂，主观视角，生动有趣！'} onChange={(value) => setActivityForm({ ...activityForm, review_requirement: value })}/><PlatformSelector value={activityForm.platforms} onChange={(platforms) => setActivityForm({ ...activityForm, platforms })}/><div className="cover-upload-section"><label className="field"><span>游戏封面</span><small style={{color:'var(--c-ink-3)',fontSize:'var(--fs-label)',marginTop:'4px'}}>优先从 Steam 或 PlayStation 抓取；如未抓取到封面，可手动上传。图片不超过 500KB。</small></label><div className="cover-upload-row"><label className="outline-button cover-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleGameCoverFile(e.target.files[0])} hidden/></label>{gameCoverUpload && <button type="button" className="btn-secondary" onClick={() => { setGameCoverUpload(null); setActivityForm(prev => ({ ...prev, game_cover: '' })) }}>移除上传</button>}</div>{gameCoverUpload ? <div className="cover-upload-preview"><img src={gameCoverUpload} alt="手动上传封面"/><span>已手动上传封面（{Math.round(gameCoverUpload.length * 0.75 / 1024)}KB）</span></div> : activityForm.game_cover && <div className="steam-preview"><img src={activityForm.game_cover} alt="封面预览"/><span>已抓取游戏封面</span></div>}</div><button className="primary form-submit">保存修改</button></form></Modal>}
    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
    {tokenReminderOpen && <Modal title="腾讯文档令牌提醒" onClose={() => { setTokenReminderOpen(false); try { localStorage.setItem(TENCENT_TOKEN_REMINDER_KEY, TENCENT_TOKEN_EXPIRES_AT) } catch {} }}><div className="token-reminder-body"><p>腾讯文档同步令牌将在 2026 年 9 月 27 日 09:20 到期。</p><p>请提前更新 Access Token，否则投稿状态和新投稿可能无法同步到腾讯文档。</p><button className="primary" onClick={() => { setTokenReminderOpen(false); try { localStorage.setItem(TENCENT_TOKEN_REMINDER_KEY, TENCENT_TOKEN_EXPIRES_AT) } catch {} }}>知道了</button></div></Modal>}
    {confirmState && <ConfirmDialog message={confirmState.message} confirmLabel={confirmState.confirmLabel} onConfirm={confirmState.onConfirm} onCancel={() => setConfirmState(null)} />}
  </div>
}

function ConfirmDialog({ message, confirmLabel = '确认删除', onConfirm, onCancel }) {
  return <div className="modal-backdrop" onMouseDown={onCancel}><section className="modal confirm-dialog" onMouseDown={(e) => e.stopPropagation()}><header><h2>确认操作</h2></header><div className="confirm-body"><p>{message}</p><div className="confirm-actions"><button className="outline-button" onClick={onCancel}>取消</button><button className="primary danger" onClick={onConfirm}>{confirmLabel}</button></div></div></section></div>
}

function HomeTrendChart({ data }) {
  const [activeIndex, setActiveIndex] = useState(null)
  const days = data || []
  const width = 720
  const height = 200
  const padX = 18
  const padTop = 16
  const padBottom = 30
  const innerH = height - padTop - padBottom
  const maxValue = Math.max(...days.map((d) => Math.max(Number(d.pv) || 0, Number(d.uv) || 0)), 1)
  const stepX = days.length > 1 ? (width - padX * 2) / (days.length - 1) : 0
  const xAt = (i) => padX + i * stepX
  const yAt = (v) => padTop + innerH - (v / maxValue) * innerH
  const pvPoints = days.map((d, i) => `${xAt(i)},${yAt(Number(d.pv) || 0)}`).join(' ')
  const uvPoints = days.map((d, i) => `${xAt(i)},${yAt(Number(d.uv) || 0)}`).join(' ')
  const gridYs = [0, 0.5, 1].map((f) => padTop + innerH * f)
  const labelEvery = Math.ceil(days.length / 6)
  const xLabels = days.map((d, i) => ({ i, text: String(d.day || '').slice(5) })).filter((l) => l.i % labelEvery === 0)
  const activeDay = activeIndex === null ? null : days[activeIndex]
  const tooltipX = activeIndex === null ? 0 : Math.min(Math.max(xAt(activeIndex), 74), width - 74)
  const updateActiveDay = (event) => {
    if (days.length < 1) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointerX = (event.clientX - bounds.left) / bounds.width * width
    setActiveIndex(Math.min(days.length - 1, Math.max(0, Math.round((pointerX - padX) / stepX))))
  }
  return <svg className="analytics-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近 30 天首页 PV 和 UV 趋势" onMouseMove={updateActiveDay} onMouseLeave={() => setActiveIndex(null)}>
    {gridYs.map((y) => <line key={y} x1={padX} x2={width - padX} y1={y} y2={y} className="analytics-chart-grid" />)}
    <polyline className="analytics-chart-line analytics-chart-line-uv" points={uvPoints} />
    <polyline className="analytics-chart-line analytics-chart-line-pv" points={pvPoints} />
    {activeDay && <><line x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1={padTop} y2={padTop + innerH} className="analytics-chart-cursor" /><circle className="analytics-chart-point analytics-chart-point-pv" cx={xAt(activeIndex)} cy={yAt(Number(activeDay.pv) || 0)} r="4" /><circle className="analytics-chart-point analytics-chart-point-uv" cx={xAt(activeIndex)} cy={yAt(Number(activeDay.uv) || 0)} r="4" /><g className="analytics-chart-tooltip" transform={`translate(${tooltipX - 64} ${padTop + 4})`}><rect width="128" height="48" rx="4" /><text x="8" y="15">{String(activeDay.day || '').slice(5)}</text><text x="8" y="33">PV {Number(activeDay.pv) || 0} · UV {Number(activeDay.uv) || 0}</text></g></>}
    {xLabels.map((l) => <text key={l.i} x={xAt(l.i)} y={height - 8} className="analytics-chart-axis" textAnchor="middle">{l.text}</text>)}
  </svg>
}

function GameHotTopicsBoard() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const [date, setDate] = useState(today)
  const [brief, setBrief] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [boardTab, setBoardTab] = useState("topics")
  const [hotCsvRows, setHotCsvRows] = useState(() => {
    try { const saved = window.localStorage.getItem("zq-rows-hot"); return saved ? JSON.parse(saved) : [] } catch { return [] }
  })
  const [csvHint, setCsvHint] = useState("")

  const loadBrief = async (requestedDate = date) => {
    setLoading(true); setError('')
    try {
      const endpoint = requestedDate === today ? '/api/brief/latest' : `/api/brief/${requestedDate}`
      const response = await fetch(`http://127.0.0.1:8790${endpoint}`)
      if (!response.ok) throw new Error(`接口请求失败（${response.status}）`)
      setBrief(await response.json())
    } catch (requestError) {
      setBrief(null)
      setError(requestError instanceof Error ? requestError.message : '接口请求失败')
    }
    setLoading(false)
  }

  useEffect(() => { loadBrief() }, [])
  useEffect(() => {
    try { window.localStorage.setItem("zq-rows-hot", JSON.stringify(hotCsvRows)) } catch {}
  }, [hotCsvRows])
  const topics = Array.isArray(brief?.topics) ? brief.topics : Array.isArray(brief?.items) ? brief.items : []
  const signals = Array.isArray(brief?.early_signals) ? brief.early_signals : Array.isArray(brief?.signals) ? brief.signals : []
  const sources = Array.isArray(brief?.sources) ? brief.sources : []
  const zhihuItems = Array.isArray(brief?.zhihu) ? brief.zhihu : []
  const deepDives = Array.isArray(brief?.deep_dives) ? brief.deep_dives : []
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
  const topicTitle = (topic) => topic.title || topic.name || topic.topic || topic.headline || '未命名热点'
  const topicSummary = (topic) => topic.summary || topic.description || topic.reason || topic.insight || ''
  const topicUrl = (topic) => topic.url || topic.link || topic.source_url
const topicSource = (item) => {
  const raw = item.source ?? item.source_name ?? item.site ?? item.media ?? item.feed ?? (Array.isArray(item.sources) ? item.sources[0] : null)
  let name = raw
  if (Array.isArray(raw)) name = raw[0]
  else if (raw && typeof raw === 'object') name = raw.name || raw.title || raw.url || ''
  if (typeof name === 'string' && name.trim()) return name.trim()
  const url = item.url || item.link || item.source_url
  if (url && /^https?:\/\//i.test(url)) {
    try { return new URL(url).hostname.replace(/^www[.]/, '') } catch { return '' }
  }
  return ''
}
const sourceRow = (item) => {
  const source = topicSource(item)
  if (!source) return null
  return <div className="game-hot-topic-source"><span className="game-hot-topic-source-label">来源</span><span className="pill hot-source" title={source}>{source}</span></div>
}
  const addHotQuestion = (title) => {
    const text = String(title || "").trim()
    if (!text) return
    const existing = new Set(hotCsvRows.map((row) => row.title.trim().toLocaleLowerCase()))
    if (existing.has(text.toLocaleLowerCase())) {
      setCsvHint("该问题已在热点提问csv中")
      window.setTimeout(() => setCsvHint(""), 2500)
      return
    }
    const maxId = hotCsvRows.reduce((max, row) => Math.max(max, row.id), 0)
    setHotCsvRows((prev) => [...prev, { id: maxId + 1, title: text, token: "", topics: "游戏", description: "", inviteType: "", expectedTopics: "5" }])
    setCsvHint("已加入热点提问csv：" + text)
    window.setTimeout(() => setCsvHint(""), 2500)
  }

  return <section className="game-hot-topics">
    <div className="analytics-tabs game-hot-topics-tabs">
      <button className={boardTab === "topics" ? "active" : ""} onClick={() => setBoardTab("topics")}>热点选题</button>
      <button className={boardTab === "csv" ? "active" : ""} onClick={() => setBoardTab("csv")}>热点提问csv</button>
    </div>
    {csvHint && <p className="zq-notice">{csvHint}</p>}
    {boardTab === "csv" ? <ZhihuQuestionTemplate storageKey="zq-rows-hot" colWidthsKey="zq-col-widths-hot" controlledRows={hotCsvRows} onRowsChange={setHotCsvRows} title="热点提问csv" /> : <>
    <div className="game-hot-topics-toolbar">
      <label><span>简报日期</span><input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} /></label>
      <button className="primary" onClick={() => loadBrief()} disabled={loading}>{loading ? '加载中…' : '刷新热点'}</button>
    </div>
    {error ? <div className="game-hot-topics-error"><strong>未能连接游戏消息源</strong><p>{error}。请启动消息服务后刷新页面。</p><code>python intel/serve.py</code></div> : loading ? <div className="empty-state"><div className="empty-icon"><Icon name="clock" size={26}/></div><h2>正在加载游戏热点</h2></div> : <>
      <div className="game-hot-topics-stats"><div><strong>{topics.length}</strong><span>热点选题</span></div><div><strong>{signals.length}</strong><span>早期信号</span></div><div><strong>{sources.length}</strong><span>消息来源</span></div><div><strong>{brief?.date || date}</strong><span>简报日期</span></div></div>
      {brief?.summary && <section className="panel game-hot-topics-summary"><div className="panel-head"><div><h3>今日摘要</h3><p>{formatDate(brief.generated_at || brief.created_at)}</p></div></div><p>{brief.summary}</p></section>}
      <section className="panel game-hot-topics-list"><div className="panel-head"><div><h3>热点选题</h3><p>按消息源简报优先级展示，可直接打开原始来源。</p></div></div>{topics.length ? <div>{topics.map((topic, index) => <article className="game-hot-topic" key={topic.id || topic.url || `${topicTitle(topic)}-${index}`}><div className="game-hot-topic-rank">{topic.rank || index + 1}</div><div><h4>{topicTitle(topic)}</h4>{topic.question && <p className="game-hot-topic-question"><span className="game-hot-topic-question-label">提问建议</span><span className="game-hot-topic-question-text">{topic.question}</span></p>}{topic.angle && <p>{topic.angle}</p>}<div className="game-hot-topic-meta">{(topic.categories || (topic.category ? [topic.category] : [])).map((category) => <span key={category}>{category}</span>)}{topic.form && <span>{topic.form}</span>}{topic.score != null && <span>评分 {topic.score}</span>}</div>{sourceRow(topic)}</div><div className="game-hot-topic-actions">{topicUrl(topic) && <a className="outline-button" href={topicUrl(topic)} target="_blank" rel="noreferrer">查看来源</a>}<button className="primary" onClick={() => addHotQuestion(topic.question || topicTitle(topic))}>一键生成问题</button></div></article>)}</div> : <p className="table-empty">该日期暂无热点选题。</p>}</section>
      {signals.length > 0 && <section className="panel game-hot-topics-list"><div className="panel-head"><div><h3>早期信号</h3><p>供选题预研和跟踪使用。</p></div></div><div>{signals.map((signal, index) => <article className="game-hot-topic" key={signal.id || signal.url || `${signal.title || signal.name}-${index}`}><div className="game-hot-topic-rank">{index + 1}</div><div><h4>{signal.title || signal.name || signal.signal || '早期信号'}</h4>{(signal.evidence || signal.summary || signal.description || signal.reason) && <p>{signal.evidence || signal.summary || signal.description || signal.reason}</p>}{signal.verify && <p className="game-hot-topic-verify">验证方向：{signal.verify}</p>}{sourceRow(signal)}</div>{(signal.url || signal.link) && <a className="outline-button" href={signal.url || signal.link} target="_blank" rel="noreferrer">查看来源</a>}</article>)}</div></section>}
      {zhihuItems.length > 0 && <section className="panel game-hot-topics-list"><div className="panel-head"><div><h3>知乎动态</h3><p>知乎平台动向与内容机会，供选题和运营参考。</p></div></div><div>{zhihuItems.map((item, index) => <article className="game-hot-topic" key={item.id || item.url || `${item.title}-${index}`}><div className="game-hot-topic-rank">{index + 1}</div><div><h4>{item.title}</h4>{item.note && <p>{item.note}</p>}{sourceRow(item)}</div></article>)}</div></section>}
      {deepDives.length > 0 && <section className="panel game-hot-topics-list"><div className="panel-head"><div><h3>深挖建议</h3><p>值得进一步调研和成文的选题方向。</p></div></div><div>{deepDives.map((item, index) => <article className="game-hot-topic" key={item.id || item.url || `${item.title}-${index}`}><div className="game-hot-topic-rank">{index + 1}</div><div><h4>{item.title}</h4>{item.question && <p className="game-hot-topic-question"><span className="game-hot-topic-question-label">深挖问题</span><span>{item.question}</span></p>}{sourceRow(item)}</div></article>)}</div></section>}
    </>}
    </>}
  </section>
}

function AnalyticsOverview({ adminToken }) {
  const [data, setData] = useState(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState('users')
  const [showAllActivities, setShowAllActivities] = useState(false)
  const [selectedUser, setSelectedUser] = useState(null)
  const [userSort, setUserSort] = useState({ key: null, dir: -1 })
  const [levelSort, setLevelSort] = useState({ key: 'points', dir: -1 })
  const loadOverview = async () => {
    setLoading(true); setError('')
    const { data: result, error: requestError } = await supabase.rpc('keyflow_admin_analytics_overview', { p_token: adminToken, p_search: '' })
    if (requestError) setError(requestError.message)
    else setData(result || { claim_heatmap: [], user_activity: [] })
    setLoading(false)
  }
  useEffect(() => { loadOverview() }, [])
  const heatmap = data?.claim_heatmap || []
  const users = data?.user_activity || []
  const activities = [...new Map(heatmap.map((item) => [item.activity_id, { id: item.activity_id, title: item.activity_title, game_name: item.game_name }])).values()]
    .map((activity) => ({ ...activity, views: heatmap.filter((item) => item.activity_id === activity.id).reduce((sum, item) => sum + Number(item.page_views || 0), 0) }))
    .sort((a, b) => b.views - a.views)
  const visibleActivities = showAllActivities ? activities : activities.slice(0, 20)
  const homeTotal = data?.home_total || { pv: 0, uv: 0 }
  const homeDaily = data?.home_daily || []
  const formatDailyAverage = (value) => (Number(value || 0) / 30).toFixed(1)
  const totalUsers = users.length
  const dailyActiveAnswerers = users.reduce((sum, user) => sum + Number(user.active_days || 0), 0)
  const maxActivityViews = Math.max(...activities.map((item) => item.views), 1)
  const filteredUsers = users.filter((item) => matchesSearch(`${item.zhihu_name || ''} ${item.account_address || ''}`, search))
  const levels = data?.answerer_levels || []
  const levelById = Object.fromEntries(levels.map((item) => [item.id, item]))
  const tierDistribution = ANSWERER_TIERS.map((t) => ({ ...t, count: levels.filter((item) => getTierInfo(Number(item.points) || 0).tier === t.tier).length }))
  const maxTierCount = Math.max(...tierDistribution.map((t) => t.count), 1)
  const filteredLevels = levels.filter((item) => matchesSearch(`${item.zhihu_name || ''} ${item.account_address || ''}`, search))
  const levelSortValue = (item) => levelSort.key === 'zhihu_name' ? (item.zhihu_name || '') : levelSort.key === 'tier' ? getTierInfo(Number(item.points) || 0).tier : Number(item[levelSort.key]) || 0
  const sortedLevels = levelSort.key ? [...filteredLevels].sort((a, b) => { const va = levelSortValue(a), vb = levelSortValue(b); return typeof va === 'string' ? va.localeCompare(vb, 'zh-CN') * levelSort.dir : (va - vb) * levelSort.dir }) : filteredLevels
  const levelSortTh = (field, label) => (
    <th className="th-sort" onClick={() => setLevelSort((prev) => (prev.key === field ? { key: field, dir: -prev.dir } : { key: field, dir: -1 }))}>{label}{levelSort.key === field ? <span className="th-sort-arrow">{levelSort.dir === -1 ? '↑' : '↓'}</span> : null}</th>
  )
  const userSortValue = (item) => userSort.key === 'zhihu_name' ? (item.zhihu_name || '') : userSort.key === 'last_activity' ? new Date(item.last_activity).getTime() || 0 : userSort.key === 'level' ? Number(levelById[item.id]?.points) || 0 : Number(item[userSort.key]) || 0
  const sortedUsers = userSort.key ? [...filteredUsers].sort((a, b) => { const va = userSortValue(a), vb = userSortValue(b); return typeof va === 'string' ? va.localeCompare(vb, 'zh-CN') * userSort.dir : (va - vb) * userSort.dir }) : filteredUsers
  const sortTh = (field, label) => (
    <th className="th-sort" onClick={() => setUserSort((prev) => (prev.key === field ? { key: field, dir: -prev.dir } : { key: field, dir: -1 }))}>{label}{userSort.key === field ? <span className="th-sort-arrow">{userSort.dir === -1 ? '↑' : '↓'}</span> : null}</th>
  )
  const formatDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
  const eventLabels = (item) => (item.event_labels || []).filter((event) => Number(event.count) > 0).map((event) => `${event.label} ${event.count}`).join(' · ') || '—'
  const activeDates = new Set((selectedUser?.active_dates || []).map((date) => String(date).slice(0, 10)))
  const calendarDays = Array.from({ length: 30 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (29 - index))
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, active: activeDates.has(key), weekday: (date.getDay() + 6) % 7 }
  })
  const calendarLeadingDays = Array.from({ length: calendarDays[0]?.weekday || 0 })
  return <div className="analytics-overview">
    <section className="analytics-hero">
      <div className="analytics-stats-grid">
        <div className="analytics-stat"><strong>{homeTotal.pv}</strong><span>首页 PV · 近 30 天</span></div>
        <div className="analytics-stat"><strong>{homeTotal.uv}</strong><span>首页 UV · 近 30 天</span></div>
        <div className="analytics-stat"><strong>{formatDailyAverage(homeTotal.pv)}</strong><span>首页 PV 日均 · 近 30 天</span></div>
        <div className="analytics-stat"><strong>{formatDailyAverage(homeTotal.uv)}</strong><span>首页 UV 日均 · 近 30 天</span></div>
        <div className="analytics-stat"><strong>{totalUsers}</strong><span>活跃答主数 · 近 30 天</span></div>
        <div className="analytics-stat"><strong>{formatDailyAverage(dailyActiveAnswerers)}</strong><span>日均活跃答主数 · 近 30 天</span></div>
      </div>
      <div className="analytics-chart">
        <div className="analytics-chart-head"><h3>近 30 天首页访问趋势</h3><div className="analytics-chart-legend"><span className="analytics-legend analytics-legend-pv">PV</span><span className="analytics-legend analytics-legend-uv">UV</span></div></div>
        <HomeTrendChart data={homeDaily} />
      </div>
    </section>
    <section className="panel analytics-panel">
      <div className="panel-head analytics-panel-head"><div><div className="analytics-tabs" role="tablist"><button className={activeTab === 'users' ? 'active' : ''} onClick={() => setActiveTab('users')} role="tab" aria-selected={activeTab === 'users'}><Icon name="users" size={16}/><span>用户活动</span><b>{totalUsers}</b></button><button className={activeTab === 'games' ? 'active' : ''} onClick={() => setActiveTab('games')} role="tab" aria-selected={activeTab === 'games'}><Icon name="grid" size={16}/><span>游戏访问</span><b>{activities.length}</b></button><button className={activeTab === 'levels' ? 'active' : ''} onClick={() => setActiveTab('levels')} role="tab" aria-selected={activeTab === 'levels'}><Icon name="ticket" size={16}/><span>等级一览</span><b>{levels.length}</b></button></div><p>{activeTab === 'games' ? '默认展示访问量最高的 20 个活动，按访问量排序。' : activeTab === 'levels' ? '按全量积分统计全部答主的等级分布与明细，积分 = 参与活动×50 + 完成活动×300 + 日常投稿×80。' : '汇总页面访问、报名、领取 Key 和交付；点击用户名查看活跃日期。'}</p></div>{activeTab === 'games' ? <button className="outline-button compact" onClick={() => setShowAllActivities((value) => !value)}>{showAllActivities ? '收起' : `查看全部（${activities.length}）`}</button> : <div className="analytics-search"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名、拼音或首字母" />{search && <button className="analytics-search-clear" onClick={() => setSearch('')} aria-label="清除搜索">×</button>}</div>}</div>
      {error && <p className="analytics-error">加载失败：{error}</p>}
      {activeTab === 'games' ? <div className="analytics-game-list">{loading ? <p className="table-empty">正在加载统计数据…</p> : visibleActivities.length ? visibleActivities.map((activity) => <div className="analytics-game-row" key={activity.id}><div className="analytics-game-name"><strong>{activity.game_name || activity.title || '未命名活动'}</strong><small>{activity.title || '—'}</small></div><div className="analytics-game-bar"><i style={{ width: `${Math.max(3, Math.round(activity.views / maxActivityViews * 100))}%` }} /></div><b>{activity.views}</b><span>PV</span></div>) : <p className="table-empty">暂无申领页访问数据。</p>}</div> : activeTab === 'levels' ? <div className="analytics-levels"><div className="analytics-level-chart"><div className="analytics-level-chart-head"><h4>答主等级分布</h4><span>共 {levels.length} 位答主</span></div><div className="analytics-level-list">{tierDistribution.map((t) => <div className="analytics-level-row" key={t.tier}><div className="analytics-level-name"><span className="level-badge">Lv{t.tier}</span><div><strong>{t.title}</strong><small>{t.min} 积分起</small></div></div><div className="analytics-level-track"><i style={{ width: `${t.count ? Math.max(3, Math.round(t.count / maxTierCount * 100)) : 0}%` }} /></div><div className="analytics-level-count"><b>{t.count}</b><span>人</span></div></div>)}</div></div><div className="table-wrap"><table><thead><tr>{levelSortTh('zhihu_name', '答主')}{levelSortTh('tier', '等级')}{levelSortTh('points', '积分')}{levelSortTh('participated_count', '已参与活动')}{levelSortTh('submission_count', '已完成活动')}{levelSortTh('daily_submission_count', '日常投稿')}</tr></thead><tbody>{loading ? <tr><td colSpan="6" className="table-empty">正在加载统计数据…</td></tr> : sortedLevels.length ? sortedLevels.map((item) => { const t = getTierInfo(Number(item.points) || 0); return <tr key={item.id}><td><div className="analytics-level-user">{item.avatar_url ? <img className="analytics-level-avatar" src={item.avatar_url} alt="" /> : <span className="analytics-level-avatar analytics-level-avatar-fallback">{(item.zhihu_name || '?')[0]}</span>}<div><strong>{item.zhihu_name || '—'}</strong><div className="analytics-address">{item.account_address || '—'}</div></div></div></td><td><span className="level-cell"><span className="level-badge">Lv{t.tier}</span>{t.title}</span></td><td><b>{item.points}</b></td><td>{item.participated_count}</td><td>{item.submission_count}</td><td>{item.daily_submission_count}</td></tr> }) : <tr><td colSpan="6" className="table-empty">暂无符合条件的答主。</td></tr>}</tbody></table></div></div> : <div className="table-wrap"><table><thead><tr>{sortTh('zhihu_name', '答主')}{sortTh('page_views', '页面访问')}{sortTh('applications', '报名')}{sortTh('claimed_keys', '领取 Key')}{sortTh('deliveries', '交付')}{sortTh('active_days', '活跃天数')}{sortTh('score', '活跃总分')}{sortTh('level', '当前积分等级')}{sortTh('last_activity', '最近活动')}<th>事件标签</th></tr></thead><tbody>{loading ? <tr><td colSpan="10" className="table-empty">正在加载统计数据…</td></tr> : sortedUsers.length ? sortedUsers.map((item) => <tr key={item.id}><td><button className="analytics-user-name" onClick={() => setSelectedUser(item)}>{item.zhihu_name || '—'}</button><div className="analytics-address">{item.account_address || '—'}</div></td><td>{item.page_views}</td><td>{item.applications}</td><td>{item.claimed_keys}</td><td>{item.deliveries}</td><td>{item.active_days}</td><td><b>{item.score}</b></td><td>{(() => { const l = levelById[item.id]; if (!l) return '—'; const t = getTierInfo(Number(l.points) || 0); return <span className="level-cell"><span className="level-badge">Lv{t.tier}</span>{t.title}</span> })()}</td><td>{formatDate(item.last_activity)}</td><td className="analytics-event-labels">{eventLabels(item)}</td></tr>) : <tr><td colSpan="10" className="table-empty">暂无符合条件的用户活动。</td></tr>}</tbody></table></div>}
    </section>
    {selectedUser && <Modal title={`${selectedUser.zhihu_name || '答主'} · 近 30 天活跃日期`} onClose={() => setSelectedUser(null)} className="analytics-activity-modal"><div className="analytics-calendar-weekdays">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => <span key={day}>{day}</span>)}</div><div className="analytics-activity-calendar">{calendarLeadingDays.map((_, index) => <div key={`leading-${index}`} className="analytics-calendar-day placeholder" />)}{calendarDays.map((day) => <div key={day.key} className={`analytics-calendar-day ${day.active ? 'active' : ''}`}><span>{day.label}</span><small>{day.active ? '活跃' : '—'}</small></div>)}</div><p className="analytics-activity-summary">近 30 天活跃 {selectedUser.active_days || 0} 天</p></Modal>}
  </div>
}

function PageEditor({ asset, loading, saving, onSelectFile, onSave, badgesEnabled, badgesSaving, onToggleBadges, adminToken, toast, setError }) {
  const image = asset?.image_data
  const [quotaSummaries, setQuotaSummaries] = useState([])
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [quotaSearch, setQuotaSearch] = useState('')
  const [quotaDrafts, setQuotaDrafts] = useState({})
  const [quotaSavingId, setQuotaSavingId] = useState(null)

  const loadQuotaSummaries = async () => {
    if (quotaLoading || quotaSummaries.length) return
    setQuotaLoading(true)
    const { data, error } = await supabase.rpc('keyflow_admin_hd2d_quota_summaries', { p_token: adminToken })
    setQuotaLoading(false)
    if (error) { setError(error.message); return }
    setQuotaSummaries(data || [])
  }

  const visibleQuotaSummaries = useMemo(() => {
    const keyword = quotaSearch.trim()
    if (!keyword) return []
    return quotaSummaries.filter((item) => matchesSearch(`${item.zhihu_name || ''} ${item.account_address || ''}`, keyword))
  }, [quotaSummaries, quotaSearch])

  const updateQuotaDraft = (userId, field, value) => setQuotaDrafts((current) => ({ ...current, [userId]: { ...(current[userId] || { amount: '', note: '' }), [field]: value } }))

  const addQuota = async (item) => {
    const draft = quotaDrafts[item.user_id] || {}
    const amount = Number(draft.amount)
    if (!Number.isInteger(amount) || amount <= 0) { setError('充值额度必须是大于 0 的整数'); return }
    setQuotaSavingId(item.user_id)
    const { data, error } = await supabase.rpc('keyflow_admin_hd2d_add_quota', {
      p_token: adminToken,
      p_answerer_id: item.user_id,
      p_amount: amount,
      p_note: draft.note || null,
    })
    setQuotaSavingId(null)
    if (error) { setError(error.message); return }
    setQuotaSummaries((items) => items.map((current) => current.user_id === item.user_id ? { ...current, ...data } : current))
    setQuotaDrafts((current) => ({ ...current, [item.user_id]: { amount: '', note: '' } }))
    toast(`已为 ${item.zhihu_name || '该答主'} 充值 ${amount} 点额度`)
  }

  return <section className="page-editor">
    <div className="panel page-editor-card"><div className="panel-head"><div><h3>用户注册界面头图</h3><p>支持本地图片，使用 data URL 保存到 Supabase，不依赖 Storage。</p></div><span className="pill success">register_banner</span></div>
      <div className="page-editor-body">{loading ? <div className="page-asset-loading">正在加载头图…</div> : <img className="page-asset-preview" src={image} alt="注册页头图预览" />}
        <div className="page-editor-actions"><label className="outline-button page-file-button"><Icon name="image" size={16}/> 选择图片<input type="file" accept="image/*" onChange={(event) => onSelectFile(event.target.files[0])} /></label><button className="primary" disabled={saving || loading} onClick={() => onSave(asset?.image_data || '')}>{saving ? '保存中…' : '保存头图'}</button><button className="outline-button" disabled={saving || loading} onClick={() => onSave('')}>恢复默认</button></div>
        <p className="page-editor-hint">未保存的选择仅在当前页面预览；恢复默认会移除数据库中的自定义图片。</p>
      </div>
    </div>
    <div className="panel page-editor-card" style={{ marginTop: 'var(--sp-4)' }}><div className="panel-head"><div><h3>我的徽章模块</h3><p>控制答主看板是否展示「我的徽章」区块。</p></div><span className="pill success">show_badges</span></div>
      <div className="page-editor-body"><div className="page-editor-toggle-row"><div><h4>{badgesEnabled ? '已开启' : '已关闭'}</h4><p>{badgesEnabled ? '答主看板会展示我的徽章。' : '答主看板已隐藏我的徽章。'}</p></div><button type="button" className={`online-toggle ${badgesEnabled ? 'active' : ''}`} onClick={() => onToggleBadges(!badgesEnabled)} disabled={badgesSaving} aria-pressed={badgesEnabled}><span className="online-toggle-knob"/></button></div></div>
    </div>
    <div className="panel page-editor-card hd2d-quota-card" style={{ marginTop: 'var(--sp-4)' }}><div className="panel-head"><div><h3>HD-2D 生成额度</h3><p>查看答主的等级基础额度、手动充值和生成使用情况。</p></div><span className="pill success">HD-2D</span></div>
      <div className="page-editor-body"><div className="hd2d-quota-toolbar"><div className="partner-search-wrap"><Icon name="search" size={14}/><input className="partner-search-input" placeholder="搜索答主、账号或拼音…" value={quotaSearch} onChange={(event) => { setQuotaSearch(event.target.value); loadQuotaSummaries() }}/>{quotaSearch && <button className="partner-search-clear" onClick={() => setQuotaSearch('')} title="清除搜索"><Icon name="close" size={14}/></button>}</div></div>
        {quotaSearch.trim() ? <div className="table-wrap hd2d-quota-table"><table><thead><tr><th>答主</th><th>等级</th><th>基础</th><th>充值</th><th>已用</th><th>剩余</th><th>手动加额度</th></tr></thead><tbody>{quotaLoading ? <tr><td colSpan="7" className="table-empty">正在加载 HD-2D 额度…</td></tr> : visibleQuotaSummaries.length ? visibleQuotaSummaries.map((item) => { const draft = quotaDrafts[item.user_id] || { amount: '', note: '' }; return <tr key={item.user_id}><td><strong>{item.zhihu_name || '未命名答主'}</strong><small className="hd2d-account-address">{item.account_address || '—'}</small></td><td>{item.level}</td><td>{item.base_quota}</td><td>{item.manual_quota}</td><td>{item.used_quota}</td><td><b>{item.remaining_quota}</b></td><td><div className="hd2d-quota-add"><input type="number" min="1" step="1" inputMode="numeric" placeholder="数量" value={draft.amount} onChange={(event) => updateQuotaDraft(item.user_id, 'amount', event.target.value)}/><input placeholder="备注（可选）" value={draft.note} onChange={(event) => updateQuotaDraft(item.user_id, 'note', event.target.value)}/><button className="primary compact" onClick={() => addQuota(item)} disabled={quotaSavingId === item.user_id}>{quotaSavingId === item.user_id ? '充值中…' : '充值'}</button></div></td></tr> }) : <tr><td colSpan="7" className="table-empty">没有匹配的答主。</td></tr>}</tbody></table></div> : <p className="page-editor-hint">输入关键词搜索答主后，即可查看额度并手动充值。</p>}
      </div>
    </div>
  </section>
}

function TextFormatter() {
  const [tool, setTool] = useState('url')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [copied, setCopied] = useState(false)

  const format = () => {
    const questions = parseQuestions(input)
    const formatted = questions.length
      ? questions.map(({ title, zhihu_url }) => `${title} - 知乎\n${zhihu_url}`).join('\n\n')
      : input.replace(/https?:\/\/[^\s]+/gi, (url) => `\n${url}\n`).replace(/[^\S\r\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    setOutput(formatted)
    setCopied(false)
  }

  const clear = () => {
    setInput('')
    setOutput('')
    setCopied(false)
  }

  const copy = async () => {
    if (!output) return
    await navigator.clipboard.writeText(output)
    setCopied(true)
  }

  return <section className="panel text-formatter">
    <div className="text-formatter-tabs" role="tablist" aria-label="小工具">
      <button type="button" role="tab" aria-selected={tool === 'url'} className={tool === 'url' ? 'active' : ''} onClick={() => setTool('url')}><Icon name="file" size={15}/> URL 换行格式化</button>
      <button type="button" role="tab" aria-selected={tool === 'zhihu'} className={tool === 'zhihu' ? 'active' : ''} onClick={() => setTool('zhihu')}><Icon name="edit" size={15}/> 知乎提问模板</button>
    </div>
    {tool === 'zhihu' ? <ZhihuQuestionTemplate /> : <>
      <div className="text-formatter-intro"><div className="text-formatter-icon"><Icon name="wrench" size={20}/></div><div><div className="text-formatter-kicker">文本工具</div><h2>URL 换行格式化</h2><p>将文本中的每个 URL 单独换行，便于复制和整理。</p></div></div>
      <div className="text-formatter-grid">
        <label className="text-formatter-panel"><div className="text-formatter-panel-head"><span>输入内容</span><small>{input.length} 字符</small></div><textarea value={input} onChange={(event) => { setInput(event.target.value); setCopied(false) }} placeholder="粘贴包含 URL 的文本…" rows={14} /></label>
        <label className="text-formatter-panel text-formatter-output"><div className="text-formatter-panel-head"><span>输出结果</span><small>{output.length} 字符</small></div><textarea value={output} onChange={(event) => setOutput(event.target.value)} placeholder="格式化后的内容将显示在这里" rows={14} /></label>
      </div>
      <div className="text-formatter-actions"><button className="secondary" onClick={clear} disabled={!input && !output}><Icon name="close" size={16}/> 清空</button><button className="secondary" onClick={copy} disabled={!output}><Icon name={copied ? 'check' : 'file'} size={16}/> {copied ? '已复制' : '复制结果'}</button><button className="primary" onClick={format} disabled={!input.trim()}><Icon name="check" size={16}/> 格式化</button></div>
    </>}
  </section>
}

const ZHIHU_GRID_COLUMNS = [
  { key: 'title', label: '问题标题', minWidth: 240, defaultWidth: 320, placeholder: '问题标题（≤50字）' },
  { key: 'token', label: '提问者token', minWidth: 120, defaultWidth: 150, placeholder: '留空自动补充' },
  { key: 'topics', label: '话题名', minWidth: 110, defaultWidth: 150, placeholder: '多个用、分割' },
  { key: 'description', label: '问题描述', minWidth: 280, defaultWidth: 360, placeholder: 'AI 生成或手动填写 50–200 字' },
  { key: 'inviteType', label: '邀请类型', minWidth: 90, defaultWidth: 110, placeholder: '留空' },
  { key: 'expectedTopics', label: '期望话题数', minWidth: 80, defaultWidth: 100, placeholder: '5' },
]

const ZHIHU_HELPER_URL = 'http://127.0.0.1:8791'
function ZhihuQuestionTemplate({ storageKey = 'zq-rows', colWidthsKey = 'zq-col-widths', controlledRows = null, onRowsChange = null, title = '知乎提问模板' }) {
  const [paste, setPaste] = useState('')
  const [localRows, setLocalRows] = useState(() => {
    try { const saved = window.localStorage.getItem(storageKey); return saved ? JSON.parse(saved) : [] } catch { return [] }
  })
  const rows = controlledRows !== null ? controlledRows : localRows
  const setRows = controlledRows !== null ? onRowsChange : setLocalRows

  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [copied, setCopied] = useState(false)
  const idRef = useRef(1)
  const [linkInput, setLinkInput] = useState('')
  const [converting, setConverting] = useState(false)
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(rows)) } catch {}
    idRef.current = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  }, [rows])

  const showNotice = (message, isError = false) => {
    setNotice(message)
    setNoticeError(isError)
  }

  const makeRow = (title = '') => ({ id: idRef.current++, title, token: '', topics: '游戏', description: '', inviteType: '', expectedTopics: '5' })

  const applyPaste = (text) => {
    const titles = parsePastedTitles(text)
    if (!titles.length) { showNotice('没有识别到问题文本', true); return }
    setRows((prev) => {
      const existing = new Set(prev.map((row) => row.title.trim().toLocaleLowerCase()))
      const fresh = titles.filter((title) => !existing.has(title.toLocaleLowerCase()))
      if (!fresh.length) return prev
      return [...prev, ...fresh.map((title) => makeRow(title))]
    })
    showNotice('已填入 ' + titles.length + ' 个问题')
  }

  const updateRow = (id, field, value) => setRows((prev) => prev.map((row) => row.id === id ? { ...row, [field]: value } : row))
  const removeRow = (id) => setRows((prev) => prev.filter((row) => row.id !== id))
  const clearAll = () => { setRows([]); showNotice('已清空全部问题') }
  const addRow = () => { setRows((prev) => [...prev, makeRow()]) }

  const convertLink = async () => {
    const input = linkInput.trim()
    if (!input) return
    setConverting(true); showNotice('')
    try {
      let sourceTitle = input
      let sourceContent = ""
      if (/^https?:\/\//i.test(input)) {
        const { data, error } = await supabase.functions.invoke('fetch-page-title', { body: { url: input } })
        if (error) {
          let message = error.message || '获取文章标题失败，请稍后重试'
          try { const body = await error.context?.json(); if (body?.error) message = body.error } catch {}
          throw new Error(message)
        }
        if (!data?.success || !data.title) throw new Error(data?.error || '未能识别到文章标题')
        sourceTitle = data.title
        sourceContent = data.content || ""
      }
      const { data: aiData, error: aiError } = await supabase.functions.invoke('zhihu-question-ai', { body: { action: 'ask', texts: [{ id: 1, title: sourceTitle, content: sourceContent }] } })
      if (aiError) {
        let message = aiError.message || 'AI 转换失败，请稍后重试'
        try { const body = await aiError.context?.json(); if (body?.error) message = body.error } catch {}
        throw new Error(message)
      }
      if (!aiData?.success) throw new Error(aiData?.error || 'AI 转换失败，请稍后重试')
      const question = aiData.results?.[0]?.title
      if (!question) throw new Error('未能生成问题，请重试')
      setRows((prev) => [...prev, makeRow(question)])
      setLinkInput('')
      showNotice('已添加问题：' + question)
    } catch (error) { showNotice(error.message, true) } finally { setConverting(false) }
  }

  const callAi = async (action, items) => {
    const results = []
    const warnings = []
    const CHUNK = 20
    for (let start = 0; start < items.length; start += CHUNK) {
      const chunk = items.slice(start, start + CHUNK)
      const { data, error } = await supabase.functions.invoke('zhihu-question-ai', { body: { action, texts: chunk } })
      if (error) {
        let message = error.message || 'AI 处理失败，请稍后重试'
        try { const body = await error.context?.json(); if (body?.error) message = body.error } catch {}
        throw new Error(message)
      }
      if (!data?.success) throw new Error(data?.error || 'AI 处理失败，请稍后重试')
      results.push(...(data.results || []))
      if (data.warning) warnings.push(data.warning)
    }
    return { results, warnings }
  }

  const shortenAll = async () => {
    const targets = rows.filter((row) => row.title.trim().length > 50)
    if (!targets.length) return
    setBusy('shorten'); showNotice('')
    try {
      const { results, warnings } = await callAi('shorten', targets.map((row) => ({ id: row.id, title: row.title })))
      const byId = new Map(results.map((result) => [result.id, result.title]).filter(([, title]) => title))
      setRows((prev) => prev.map((row) => byId.has(row.id) ? { ...row, title: byId.get(row.id) } : row))
      showNotice('已为 ' + byId.size + ' 个问题完成缩题' + (warnings.length ? '；' + warnings[warnings.length - 1] : ''))
    } catch (error) { showNotice(error.message, true) } finally { setBusy('') }
  }

  const describeAll = async (mode = 'describe') => {
    const targets = rows.filter((row) => row.title.trim() && !row.description.trim())
    if (!targets.length) return
    setBusy(mode); showNotice('')
    try {
      const { results, warnings } = await callAi(mode, targets.map((row) => ({ id: row.id, title: row.title })))
      const byId = new Map(results.map((result) => [result.id, result.description]).filter(([, description]) => description))
      setRows((prev) => prev.map((row) => byId.has(row.id) ? { ...row, description: byId.get(row.id) } : row))
      showNotice('已为 ' + byId.size + ' 个问题生成描述' + (mode === 'describe-raw' ? '（激进版）' : '') + (warnings.length ? '；' + warnings[warnings.length - 1] : ''))
    } catch (error) { showNotice(error.message, true) } finally { setBusy('') }
  }

  const downloadCsv = () => {
    if (!rows.some((row) => row.title.trim())) return
    const csv = '\uFEFF' + buildZhihuCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = '知乎提问模板_' + fileTimestamp() + '.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const copyCsv = async () => {
    if (!rows.some((row) => row.title.trim())) return
    await navigator.clipboard.writeText(buildZhihuCsv(rows))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const runZhihuChain = async () => {
    const items = rows.filter((row) => row.title.trim())
    if (!items.length) { showNotice('请先填写问题', true); return }
    setBusy('zhihu-upload'); showNotice('正在连接本地助手…')
    try {
      const healthRes = await fetch(ZHIHU_HELPER_URL + '/health', { signal: AbortSignal.timeout(5000) })
      const health = await healthRes.json().catch(() => ({}))
      if (!healthRes.ok || !health.ok) throw new Error('本地助手未启动，请先运行 zhihu-upload-helper 下的 start-helper.bat')
      if (!health.loggedIn) throw new Error('知乎未登录，请在弹出的 Chrome 窗口扫码登录')
      const csv = '\uFEFF' + buildZhihuCsv(items)
      setBusy('zhihu-upload'); showNotice('正在上传到知乎…')
      const uploadRes = await fetch(ZHIHU_HELPER_URL + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }), signal: AbortSignal.timeout(90000) })
      const upload = await uploadRes.json().catch(() => ({}))
      if (!uploadRes.ok || !upload.ok) throw new Error(upload.error || '上传失败，请查看浏览器窗口')
      if (!window.confirm('已在知乎解析出 ' + (upload.pending ?? '?') + ' 条问题，确认发布？自动邀请将保持关闭。')) {
        setBusy(''); showNotice('已取消，未发布'); return
      }
      setBusy('zhihu-publish'); showNotice('正在发布…')
      const pubRes = await fetch(ZHIHU_HELPER_URL + '/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoInvite: false }), signal: AbortSignal.timeout(90000) })
      const pub = await pubRes.json().catch(() => ({}))
      if (!pubRes.ok || !pub.ok) throw new Error(pub.error || '发布失败，请查看浏览器窗口')
      setBusy('zhihu-result'); showNotice('发布成功，正在下载结果…')
      const resRes = await fetch(ZHIHU_HELPER_URL + '/api/result', { method: 'POST', signal: AbortSignal.timeout(90000) })
      const result = await resRes.json().catch(() => ({}))
      if (!resRes.ok || !result.ok) throw new Error(result.error || '下载结果失败')
      const adminToken = getAdminToken()
      if (!adminToken) throw new Error('未获取到管理员凭证，请刷新后台重新登录')
      const entries = (result.rows || []).map((r) => ({ title: r.title, zhihu_url: cleanZhihuAnswerUrl(r.url), content_type: 'question' }))
      let saved = 0
      if (entries.length) {
        const { data, error } = await supabase.rpc('keyflow_admin_create_daily_questions', { p_token: adminToken, p_questions: entries })
        if (error) throw new Error('回填日常问题运营失败：' + error.message)
        saved = data?.length || 0
      }
      setBusy('')
      showNotice('完成：发布 ' + (pub.published ?? entries.length) + ' 条，回填日常问题运营 ' + saved + ' 条')
      if ((result.rows || []).length) window.alert((result.rows || []).map((r) => r.title + '\n' + r.url).join('\n\n'))
    } catch (error) {
      setBusy('')
      showNotice(error.message || '流程执行失败', true)
    }
  }
  const overCount = rows.filter((row) => row.title.trim().length > 50).length

  const [colWidths, setColWidths] = useState(() => {
    try {
      const saved = window.localStorage.getItem(colWidthsKey)
      return saved ? JSON.parse(saved) : {}
    } catch { return {} }
  })

  useEffect(() => {
    try { window.localStorage.setItem(colWidthsKey, JSON.stringify(colWidths)) } catch {}
  }, [colWidths])

  const getColWidth = (col) => colWidths[col.key] || col.defaultWidth

  const startResize = (event, key) => {
    event.preventDefault()
    const col = ZHIHU_GRID_COLUMNS.find((item) => item.key === key)
    const startX = event.clientX
    const startWidth = getColWidth(col)
    const onMove = (moveEvent) => {
      setColWidths((prev) => ({ ...prev, [key]: Math.max(col.minWidth, Math.round(startWidth + moveEvent.clientX - startX)) }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('zq-resizing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('zq-resizing')
  }

  const resetColWidth = (key) => setColWidths((prev) => { const next = { ...prev }; delete next[key]; return next })

  const focusCell = (rowIndex, colIndex) => {
    const cell = document.querySelector('[data-zq-cell="' + rowIndex + '-' + colIndex + '"]')
    if (cell) cell.focus()
  }

  const handleCellKeyDown = (event, rowIndex, colIndex) => {
    const isDesc = ZHIHU_GRID_COLUMNS[colIndex].key === 'description'
    const commitDown = (event.key === 'Enter' && !isDesc) || (event.key === 'Enter' && isDesc && (event.ctrlKey || event.metaKey))
    if (!commitDown) return
    event.preventDefault()
    if (rowIndex === rows.length - 1) {
      setRows((prev) => [...prev, makeRow()])
      window.setTimeout(() => focusCell(rows.length, colIndex), 0)
    } else {
      focusCell(rowIndex + 1, colIndex)
    }
  }

  const handleCellPaste = (event, rowIndex, colIndex) => {
    const text = event.clipboardData.getData('text')
    if (!text) return
    const col = ZHIHU_GRID_COLUMNS[colIndex]
    const grid = parseClipboardGrid(text)
    const rowCount = grid.length
    const colCount = Math.max(...grid.map((cells) => cells.length))
    const isBlock = colCount > 1 || rowCount > 1
    if (!isBlock || col.key === 'description') return
    event.preventDefault()
    setRows((prev) => {
      const next = [...prev]
      const need = rowIndex + rowCount
      while (next.length < need) next.push(makeRow())
      grid.forEach((cells, dr) => {
        const target = next[rowIndex + dr]
        ZHIHU_GRID_COLUMNS.slice(colIndex, Math.min(colIndex + colCount, ZHIHU_GRID_COLUMNS.length)).forEach((gridCol, dc) => {
          const value = cells[dc]
          if (value !== undefined) target[gridCol.key] = value
        })
      })
      return next
    })
  }

  return <div className="zq">
    <div className="text-formatter-intro"><div className="text-formatter-icon"><Icon name="edit" size={20}/></div><div><div className="text-formatter-kicker">知乎运营工具</div><h2>{title}</h2><p>粘贴问题文本自动填入表格；AI 缩题、生成描述后导出 CSV，上传知乎后台即可批量提问。</p></div></div>
    <div className="zq-body">
      <div className="zq-paste-wrap">
        <label className="text-formatter-panel"><div className="text-formatter-panel-head"><span>粘贴问题文本</span><small>每行一个问题，也支持「标题 - 知乎 + 链接」；表格里可拖动列宽、批量粘贴</small></div><textarea className="zq-paste" value={paste} onChange={(event) => setPaste(event.target.value)} onPaste={(event) => { const text = event.clipboardData.getData('text'); window.setTimeout(() => applyPaste(text), 0) }} placeholder={'例如：\n如何评价游戏《黑神话：悟空》？\n如何评价《星露谷物语》1.7 版本更新？'} rows={6}/></label>
        <div className="zq-paste-actions"><button className="primary" onClick={() => applyPaste(paste)} disabled={!paste.trim()}><Icon name="plus" size={15}/> 填入表格</button><button className="secondary" onClick={addRow}><Icon name="plus" size={15}/> 添加一行</button></div>
      </div>
      <div className="zq-link-convert">
        <input value={linkInput} onChange={(event) => setLinkInput(event.target.value)} placeholder="粘贴公众号 / 小红书链接，或直接输入标题文本，自动转成问题" />
        <button className="primary" onClick={convertLink} disabled={converting || !linkInput.trim()}><Icon name="arrow" size={15}/> {converting ? '转换中…' : '一键转提问'}</button>
      </div>
      <div className="zq-toolbar">
        <div className="zq-toolbar-left">
          <button className="secondary" onClick={shortenAll} disabled={!overCount || busy !== ''} title={overCount ? '有 ' + overCount + ' 个问题超过 50 字' : '当前没有超过 50 字的问题'}><Icon name="edit" size={15}/> {busy === 'shorten' ? '缩题中…' : '一键缩短'}{overCount > 0 && <span className="zq-badge">{overCount}</span>}</button>
          <button className="secondary" onClick={() => describeAll('describe')} disabled={!rows.length || busy !== ''} title="为尚未填写描述的问题生成 AI 描述（普通版）"><Icon name="edit" size={15}/> {busy === 'describe' ? '生成中…' : 'AI 生成描述普通版'}</button>
          <button className="secondary" onClick={() => describeAll('describe-raw')} disabled={!rows.length || busy !== ''} title="为尚未填写描述的问题生成更随意的 AI 描述（激进版）"><Icon name="edit" size={15}/> {busy === 'describe-raw' ? '生成中…' : 'AI 生成描述激进版'}</button>
        </div>
        <div className="zq-toolbar-right">
          <button className="secondary" onClick={clearAll} disabled={!rows.length} title="清空表格中已录入的全部问题"><Icon name="close" size={15}/> 一键清空</button>
          <button className="secondary" onClick={copyCsv} disabled={!rows.some((row) => row.title.trim())}><Icon name={copied ? 'check' : 'file'} size={15}/> {copied ? '已复制' : '复制 CSV'}</button>
          <button className="primary zq-chain-btn" onClick={runZhihuChain} disabled={!rows.some((row) => row.title.trim()) || busy !== ''} title="上传到知乎批量提问、发布并回填「日常问题运营」（需本地助手运行、Chrome 已登录知乎）"><Icon name="upload" size={15}/> {busy === 'zhihu-upload' ? '上传中…' : busy === 'zhihu-publish' ? '发布中…' : busy === 'zhihu-result' ? '回填中…' : '一键发布并回填'}</button><button className="primary" onClick={downloadCsv} disabled={!rows.some((row) => row.title.trim())}><Icon name="file" size={15}/> 下载 CSV</button>
        </div>
      </div>
      {notice && <p className={'zq-notice' + (noticeError ? ' error' : '')}>{notice}</p>}
            <div className="table-wrap zq-table-wrap">
        <table className="zq-table">
          <colgroup>
            <col style={{ width: 44 }}/>
            {ZHIHU_GRID_COLUMNS.map((col) => <col key={col.key} style={{ width: getColWidth(col) }}/>)}
          </colgroup>
          <thead><tr>
            <th className="zq-row-head">#</th>
            {ZHIHU_GRID_COLUMNS.map((col) => <th key={col.key} style={{ width: getColWidth(col) }} title={col.label + '（拖动右侧边缘调整列宽，双击恢复默认）'}><span className="zq-th-label">{col.label}</span><span className="zq-resize" onMouseDown={(event) => startResize(event, col.key)} onDoubleClick={() => resetColWidth(col.key)} title="拖动调整列宽，双击恢复默认"/></th>)}

          </tr></thead>
          <tbody>
            {rows.length ? rows.map((row, ri) => {
              const titleOver = row.title.trim().length > 50
              const descOver = row.description.trim().length > 200
              return <tr key={row.id} className={titleOver ? 'zq-over-row' : ''}>
                <td className="zq-row-head"><div className="zq-row-head-inner"><span>{ri + 1}</span><button className="zq-delete" title="删除该行" onClick={() => removeRow(row.id)}><Icon name="close" size={13}/></button></div></td>
                {ZHIHU_GRID_COLUMNS.map((col, ci) => {
                  const isOver = col.key === 'title' ? titleOver : col.key === 'description' ? descOver : false
                  return <td key={col.key}>
                    {col.key === 'description'
                      ? <textarea data-zq-cell={ri + '-' + ci} rows={3} value={row.description} placeholder={col.placeholder} className={isOver ? 'over' : ''} onChange={(event) => updateRow(row.id, 'description', event.target.value)} onKeyDown={(event) => handleCellKeyDown(event, ri, ci)} onPaste={(event) => handleCellPaste(event, ri, ci)}/>
                      : <input data-zq-cell={ri + '-' + ci} value={row[col.key]} placeholder={col.placeholder} className={(isOver ? 'over ' : '') + (col.key === 'expectedTopics' ? 'zq-num' : '')} inputMode={col.key === 'expectedTopics' ? 'numeric' : undefined} onChange={(event) => updateRow(row.id, col.key, event.target.value)} onKeyDown={(event) => handleCellKeyDown(event, ri, ci)} onPaste={(event) => handleCellPaste(event, ri, ci)}/>}
                    {isOver && <span className="zq-over-tip">{col.key === 'title' ? '已超 ' + (row.title.trim().length - 50) + ' 字' : '已超 ' + (row.description.trim().length - 200) + ' 字'}</span>}
                  </td>
                })}

              </tr>
            }) : <tr><td colSpan="7" className="table-empty">粘贴问题文本，或点击「添加一行」开始；也可以直接在表格里批量粘贴 Excel 数据。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  </div>
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
  const handleAvatarFile = async (file) => {
    setError('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    if (file.size > 10 * 1024 * 1024) { setError('图片大小不能超过 10MB'); return }
    try {
      const compressed = await compressImageFile(file, 256, 0.85)
      setAvatarFile(compressed)
      const reader = new FileReader()
      reader.onload = (e) => setAvatarPreview(e.target.result)
      reader.readAsDataURL(compressed)
    } catch {
      setError('图片处理失败，请重新选择')
    }
  }

  const uploadAvatar = async () => {
    if (!avatarFile) { setAvatarUploading(false); return }
    setAvatarUploading(true)
    let publicUrl
    try {
      publicUrl = await uploadMediaFile(avatarFile, answerer.media_upload_token, 'avatar')
    } catch (error) {
      setAvatarUploading(false)
      setError(error.message)
      return
    }
    const { error: updateErr } = await supabase.rpc('keyflow_answerer_update_avatar', { p_answerer_id: answerer.id, p_avatar_url: publicUrl })
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
    const unreadIds = (data || []).filter(m => m.status === 'unread').map(m => m.id)
    const readAt = new Date().toISOString()
    setAnswererInbox((data || []).map(m => unreadIds.includes(m.id) ? { ...m, status: 'read', read_at: readAt } : m))
    setUnreadInboxCount(0)
    if (unreadIds.length) {
      await supabase.from('keyflow_inbox').update({ status: 'read', read_at: readAt }).in('id', unreadIds)
    }
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
      else if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
      if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
  if (isPartner === null) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="loading-public">正在加载合作方协作页…</div></main></div>
  if (!isPartner) return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 合作方协作页</span></a><div className="step-message"><p>你的账号不是合作方身份</p><span>请使用合作方邀请码注册的账号登录，或联系运营人员获取合作方账号。</span><div className="dashboard-auth-actions"><button className="outline-button" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}>切换账号</button></div></div></main></div>

  // ---- 无 token：显示合作方活动列表 ----
  if (!token) {
    const stageLabel = { recruiting: '招募中', key_distribution: '招募截止请等待', delivery: '交付/创作中', completed: '项目完结' }
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
          <p className="avatar-upload-hint">支持 JPG、PNG、WebP，将自动压缩（原图不超过 10MB）</p>
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
  if (!snapshot && !error) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="loading-public">正在加载活动协作页…</div></main></div>
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
        <p className="avatar-upload-hint">支持 JPG、PNG、WebP，将自动压缩（原图不超过 10MB）</p>
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
    setClaimingId(id)
    const { data, error } = await supabase.rpc('keyflow_mark_key_claimed', { p_key_id: id })
    setClaimingId(null)
    if (error) return toast('取用失败: ' + error.message)
    const claimedAt = data?.claimed_at || new Date().toISOString()
    setLocalClaimed(prev => ({ ...prev, [id]: claimedAt }))
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

function DeliveriesPage({ activity, deliveries, applications, answerers, statusLabel, notes, onNoteChange, onReview, onSelectActivity, pendingCount, approvedCount, revisionCount, toast, participationByAnswerer, onViewAnswererParticipation, onWordCountUpdate }) {
  const [statusFilter, setStatusFilter] = useState('all')
  const [checkingId, setCheckingId] = useState(null)
  const answererByName = useMemo(() => { const m = {}; answerers.forEach(a => { if (a.zhihu_name) m[a.zhihu_name] = a }); return m }, [answerers])
  const applicationById = useMemo(() => Object.fromEntries(applications.map((item) => [item.id, item])), [applications])
  const [keyword, setKeyword] = useState('')
  const deliveryWithAuthor = useMemo(() => deliveries.map((item) => ({ ...applicationById[item.application_id], ...item })), [deliveries, applicationById])
  const visibleDeliveries = useMemo(() => deliveryWithAuthor.filter((item) => (statusFilter === 'all' || item.status === statusFilter) && matchesSearch(`${item.zhihu_name || ''} ${item.article_title || ''} ${item.article_url || ''}`, keyword)), [deliveryWithAuthor, keyword, statusFilter])
  if (!activity) return <div className="empty-state"><div className="empty-icon"><Icon name="calendar" size={26}/></div><h2>先创建测评活动</h2><p>创建活动并收到答主交稿后，即可进行交付验收。</p></div>
  const filters = [['all', '全部', deliveries.length], ['pending', '待审核', pendingCount], ['approved', '已通过', approvedCount], ['revision_required', '需修改', revisionCount], ['rejected', '未通过', deliveries.filter((item) => item.status === 'rejected').length]]
  const checkWordCount = async (item) => {
    setCheckingId(item.id)
    const result = await fetchZhihuAnswerWordCount(item.article_url)
    if (result.success) {
      const { error: requestError } = await supabase.from('keyflow_deliveries').update({ verified_word_count: result.wordCount }).eq('id', item.id)
      if (requestError) toast(requestError.message)
      else onWordCountUpdate(item.id, result.wordCount)
    } else toast(result.error)
    setCheckingId(null)
  }
  const downloadExcel = () => {
    const headers = ['答主', '微信名', '作品标题', '作品链接', '提交时间', '字数', '审核备注', '状态']
    const rows = visibleDeliveries.map((item) => [item.zhihu_name || '', item.wechat_name || '', item.article_title || '', cleanZhihuAnswerUrl(item.article_url) || '', new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at)), item.verified_word_count ?? item.claimed_word_count ?? '待核对', notes[item.id] ?? item.reviewer_note ?? '', statusLabel[item.status]])
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${activity.title}_交付验收表.csv`; a.click()
    URL.revokeObjectURL(url)
    toast('交付验收表已下载')
  }
  return <div className="delivery-workspace"><section className="activity-picker"><button className="current-activity" onClick={onSelectActivity}><span>当前活动</span><strong>{activity.title}</strong><Icon name="arrow" size={14}/></button></section><section className="delivery-stats"><div><strong>{deliveries.length}</strong><span>已提交</span></div><div><strong>{pendingCount}</strong><span>待审核</span></div><div><strong>{approvedCount}</strong><span>已通过</span></div><div><strong>{revisionCount}</strong><span>需修改</span></div></section><section className="panel"><div className="panel-head"><div><h3>交付验收</h3><p>核对作品链接与实际字数，保存审核结论后会同步展示给答主。</p></div></div><div className="delivery-toolbar"><div className="acceptance-filters">{filters.map(([value, label, count]) => <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}><span>{label}</span><b>{count}</b></button>)}</div><input aria-label="搜索交付" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索答主或作品链接"/><button className="outline-button" onClick={downloadExcel} title="下载当前表格为 Excel">Excel下载</button></div><div className="table-wrap"><table className="deliveries-table"><thead><tr><th>答主</th><th>作品标题</th><th>作品链接</th><th>提交时间</th><th>字数</th><th>审核备注</th><th>状态</th><th>验收操作</th></tr></thead><tbody>{visibleDeliveries.length ? visibleDeliveries.map((item) => <tr key={item.id}><td><div className="person">{answererByName[item.zhihu_name]?.avatar_url ? <img className="person-avatar-img" src={answererByName[item.zhihu_name].avatar_url} alt="" onClick={() => { const a = answererByName[item.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { const a = answererByName[item.zhihu_name]; if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{item.zhihu_name?.[0] || '答'}</span>}<div><strong>{item.zhihu_name || '答主'}</strong><small>{item.wechat_name || '已交稿'}</small></div></div></td><td>{item.article_title || '-'}</td><td><a className="profile-link" href={cleanZhihuAnswerUrl(item.article_url)} target="_blank" rel="noreferrer">查看作品 <Icon name="arrow" size={13}/></a></td><td>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.submitted_at))}</td><td>{item.verified_word_count != null ? `${item.verified_word_count.toLocaleString()} 字` : item.article_url ? <>{item.claimed_word_count != null && `${item.claimed_word_count.toLocaleString()} 字 `}<button className="outline-button compact" onClick={() => checkWordCount(item)} disabled={checkingId === item.id}>{checkingId === item.id ? '核对中…' : '自动核对'}</button></> : item.claimed_word_count != null ? `${item.claimed_word_count.toLocaleString()} 字` : '待核对'}</td><td><input className="delivery-note" value={notes[item.id] ?? item.reviewer_note ?? ''} onChange={(event) => onNoteChange(item.id, event.target.value)} placeholder="填写审核意见"/></td><td><span className={`pill ${item.status === 'approved' ? 'success' : item.status === 'pending' || item.status === 'revision_required' ? 'warning' : 'muted'}`}>{statusLabel[item.status]}</span></td><td><div className="review-actions"><button className="select-action" onClick={() => onReview(item, 'approved')}>通过</button><button className="reset-action" onClick={() => onReview(item, 'revision_required')}>需修改</button><button className="reject-action" onClick={() => onReview(item, 'rejected')}>不通过</button></div></td></tr>) : <tr><td colSpan="8" className="table-empty">没有符合条件的交付记录。</td></tr>}</tbody></table></div></section></div>
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

const DAILY_GAME_HOTSPOTS = []

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
  const [coverModalOpen, setCoverModalOpen] = useState(false)
  const [coverFile, setCoverFile] = useState(null)
  const [coverPreview, setCoverPreview] = useState('')
  const [coverUploading, setCoverUploading] = useState(false)
  const [coverMsg, setCoverMsg] = useState('')
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
  const [qMode, setQMode] = useState('link') // 'link' 填写链接+文本 | 'paste' 知乎标准分享格式
  const [qUrl, setQUrl] = useState('')
  const [qTitle, setQTitle] = useState('')
  const [qPaste, setQPaste] = useState('')
  const [qSubmitting, setQSubmitting] = useState(false)
  const [qMsg, setQMsg] = useState('')
  const [qSuccessOpen, setQSuccessOpen] = useState(false)
  const [qErrorOpen, setQErrorOpen] = useState(false)
  const [completedModalOpen, setCompletedModalOpen] = useState(false)
  const [participatedModalOpen, setParticipatedModalOpen] = useState(false)
  const [completedActivities, setCompletedActivities] = useState([])
  const [participatedActivities, setParticipatedActivities] = useState([])
  const [badges, setBadges] = useState([])
  const [showBadges, setShowBadges] = useState(false)
  const [selectedBadge, setSelectedBadge] = useState(null)
  const [activeTab, setActiveTab] = useState('create') // 'create' | 'activities' | 'submissions'
  const [dashboardContentMode, setDashboardContentMode] = useState('favorites')
  const gameHotspotsScrollRef = useRef(null)
  const toggleDashboardContentMode = () => {
    gameHotspotsScrollRef.current = window.scrollY
    setDashboardContentMode((prev) => (prev === 'favorites' ? 'hotspots' : 'favorites'))
  }
  useEffect(() => {
    if (gameHotspotsScrollRef.current === null) return
    const target = gameHotspotsScrollRef.current
    gameHotspotsScrollRef.current = null
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, target)))
  }, [dashboardContentMode])
  const [dashboardFavoriteQuestions, setDashboardFavoriteQuestions] = useState([])
  const [gameHotspots, setGameHotspots] = useState([])
  const [hotspotsUpdatedAt, setHotspotsUpdatedAt] = useState('')
  const [hotspotsLoading, setHotspotsLoading] = useState(false)
  const [hotspotsError, setHotspotsError] = useState('')
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

  const loadBadges = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_answerer_badges', { p_answerer_id: answerer.id })
    setBadges(data || [])
  }

  const loadShowBadges = async () => {
    const { data } = await supabase.from('keyflow_page_assets').select('image_data').eq('key', 'show_badges').maybeSingle()
    setShowBadges(data?.image_data === '1')
  }

  const loadParticipatedActivities = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_answerer_participated_activities', { p_answerer_id: answerer.id })
    setParticipatedActivities(data || [])
  }

  const loadDashboardFavorites = async () => {
    if (!answerer?.id) return
    const { data } = await supabase.rpc('keyflow_answerer_zhihu_question_favorites', { p_answerer_id: answerer.id })
    setDashboardFavoriteQuestions(data || [])
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

  const handleAvatarFile = async (file) => {
    setAvatarMsg('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setAvatarMsg('请选择图片文件'); return }
    if (file.size > 10 * 1024 * 1024) { setAvatarMsg('图片大小不能超过 10MB'); return }
    try {
      const compressed = await compressImageFile(file, 256, 0.85)
      setAvatarFile(compressed)
      const reader = new FileReader()
      reader.onload = (e) => setAvatarPreview(e.target.result)
      reader.readAsDataURL(compressed)
    } catch {
      setAvatarMsg('图片处理失败，请重新选择')
    }
  }

  const handleCoverFile = (file) => {
    setCoverMsg('')
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setCoverMsg('请选择 JPG、PNG 或 WebP 图片'); return }
    if (file.size > 800 * 1024) { setCoverMsg('封面图片大小不能超过 800KB，请压缩后重新选择'); return }
    const reader = new FileReader()
    reader.onload = (e) => { setCoverPreview(e.target.result); setCoverFile(file) }
    reader.readAsDataURL(file)
  }

  const uploadDashboardCover = async () => {
    if (!coverFile) return
    setCoverUploading(true)
    setCoverMsg('')
    const extension = coverFile.type === 'image/jpeg' ? 'jpg' : coverFile.type.split('/')[1]
    const filePath = `${answerer.id}/cover.${extension}`
    const { error: uploadErr } = await supabase.storage
      .from('answerer-dashboard-covers')
      .upload(filePath, coverFile, { upsert: true, contentType: coverFile.type })
    if (uploadErr) {
      setCoverUploading(false)
      setCoverMsg(`图片上传失败：${uploadErr.message}`)
      return
    }
    const { data: { publicUrl } } = supabase.storage.from('answerer-dashboard-covers').getPublicUrl(filePath)
    const { error: updateErr } = await supabase.rpc('keyflow_answerer_update_dashboard_cover', { p_answerer_id: answerer.id, p_dashboard_cover_url: publicUrl })
    setCoverUploading(false)
    if (updateErr) { setCoverMsg(updateErr.message); return }
    setDashboard(current => current ? { ...current, answerer: { ...current.answerer, dashboard_cover_url: publicUrl } } : current)
    setCoverPreview(publicUrl)
    setCoverFile(null)
    setCoverModalOpen(false)
  }

  const uploadAvatar = async () => {
    if (!avatarFile) { setAvatarUploading(false); return }
    setAvatarUploading(true)
    let publicUrl
    try {
      publicUrl = await uploadMediaFile(avatarFile, answerer.media_upload_token, 'avatar')
    } catch (error) {
      setAvatarUploading(false)
      setAvatarMsg(error.message)
      return
    }
    const { error: updateErr } = await supabase.rpc('keyflow_answerer_update_avatar', { p_answerer_id: answerer.id, p_avatar_url: publicUrl })
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
      else if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
      if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
    const unreadIds = (data || []).filter(m => m.status === 'unread').map(m => m.id)
    const readAt = new Date().toISOString()
    setAnswererInbox((data || []).map(m => unreadIds.includes(m.id) ? { ...m, status: 'read', read_at: readAt } : m))
    setUnreadInboxCount(0)
    if (unreadIds.length) {
      await supabase.from('keyflow_inbox').update({ status: 'read', read_at: readAt }).in('id', unreadIds)
    }
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

  // 合并投稿：识别出「回答」格式的条目进入答主日常投稿（keyflow_daily_submissions），
  // 识别出「问题」格式的条目进入日常问题运营（keyflow_daily_questions）。
  const submitQuestion = async (e) => {
    e.preventDefault()
    const entries = qMode === 'paste'
      ? parseQuestions(qPaste)
      : parseQuestions(`${qTitle.trim()}\n${qUrl.trim()}`)
    if (!entries.length) {
      setQMsg(qMode === 'paste' ? '未检测到有效内容：请同时包含标题与知乎链接' : '请填写链接和问题（作品标题）文本')
      setQErrorOpen(true)
      return
    }
    setQSubmitting(true)
    setQMsg('')
    const answerEntries = entries.filter((item) => item.content_type === 'answer')
    const questionEntries = entries.filter((item) => item.content_type !== 'answer')
    let answerSaved = 0, answerSkipped = 0, answerNote = ''
    if (answerEntries.length) {
      const { data: activities } = await supabase.from('keyflow_activities').select('game_name').limit(500)
      const titles = answerEntries.map((item) => (item.title || '').trim().normalize('NFKC').toLocaleLowerCase())
      const isActivityLike = (activities || []).some(({ game_name }) => game_name?.trim() && titles.some((t) => t.includes(game_name.trim().normalize('NFKC').toLocaleLowerCase())))
      if (isActivityLike && !window.confirm('您的稿件可能是活动稿件，不建议日常投稿。确定要投稿吗？')) {
        answerSkipped = answerEntries.length
      } else {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
        const { count: todayCount } = await supabase.from('keyflow_daily_submissions')
          .select('*', { count: 'exact', head: true }).eq('answerer_id', answerer.id).gte('created_at', todayStart.toISOString())
        const dailyLimit = Math.max(1, tierInfo.tier || 1)
        const remaining = dailyLimit - (todayCount || 0)
        if (remaining <= 0) {
          answerSkipped = answerEntries.length
          answerNote = `今日已回答投稿已达上限（Lv${dailyLimit} 每天限投${dailyLimit}条回答）`
        } else {
          const toInsert = answerEntries.slice(0, remaining)
          const { error: insertErr } = await supabase.from('keyflow_daily_submissions').insert(toInsert.map((item) => ({
            answerer_id: answerer.id,
            article_url: cleanZhihuAnswerUrl(item.zhihu_url),
            article_title: item.title,
          })))
          if (insertErr) { answerNote = insertErr.message }
          else { answerSaved = toInsert.length; answerSkipped = answerEntries.length - toInsert.length }
        }
      }
      if (answerSaved) setDashboard(current => current ? { ...current, daily_submission_count: (current.daily_submission_count || 0) + answerSaved } : current)
    }
    let questionSaved = 0, questionError = ''
    if (questionEntries.length) {
      const { data, error } = await supabase.rpc('keyflow_answerer_create_daily_questions', { p_answerer_id: answerer.id, p_questions: questionEntries })
      if (error) questionError = error.message
      else questionSaved = data?.length || 0
    }
    setQSubmitting(false)
    setQUrl(''); setQTitle(''); setQPaste('')
    if (!answerSaved && !questionSaved) {
      setQMsg(answerNote || questionError || '投稿失败，请检查内容后重试')
      setQErrorOpen(true)
      return
    }
    const parts = []
    if (questionSaved) parts.push(`${questionSaved} 条问题`)
    if (answerSaved) parts.push(`${answerSaved} 条回答`)
    setQMsg(`投稿成功！已提交 ${parts.join('、')}${answerNote ? `（${answerNote}）` : ''}`)
    setQSuccessOpen(true)
  }

  const loadGameHotspots = async (attempt = 1) => {
    setHotspotsError('')
    if (attempt === 1) setHotspotsLoading(true)
    try {
      const response = await fetch(`/autokey/hotspots.json?ts=${Date.now()}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('热点聚合服务暂不可用，请稍后重试。')
      let data
      try {
        data = JSON.parse(await response.text())
      } catch (parseError) {
        throw new Error('热点数据暂未生成，请稍后刷新。')
      }
      if (!data?.success) throw new Error(data?.error || '热点加载失败')
      setGameHotspots(data.items || [])
      setHotspotsUpdatedAt(data.updatedAt || '')
      setHotspotsLoading(false)
    } catch (requestError) {
      if (attempt < 3) {
        setTimeout(() => loadGameHotspots(attempt + 1), 1500)
        return
      }
      setHotspotsLoading(false)
      setHotspotsError(requestError.message || '热点加载失败，请稍后重试。')
    }
  }

  useEffect(() => {
    loadGameHotspots()
  }, [])

  useEffect(() => {
    trackAnswererDashboardView(answerer?.id)
    // 并行发起所有独立请求，减少串行等待时间
    Promise.all([
      loadDashboard(),
      loadDashboardFavorites(),
      loadSharedCode(),
      fetchUnreadCount(),
      loadBadges(),
      loadShowBadges(),
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
  if (!dashboard && !error) return <div className="public-page"><main className="public-card dashboard-login-card"><div className="loading-public">正在加载答主看板…</div></main></div>
  if (!dashboard) return <div className="public-page"><main className="public-card dashboard-login-card"><a className="public-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney · 答主看板</span></a><div className="step-message"><p>{error || '看板加载失败'}</p><button className="outline-button" onClick={loadDashboard}>重新加载</button></div></main></div>

  const stageLabel = { recruiting: '招募中', key_distribution: '招募截止请等待', claim_key: '请领取key', delivery: '交付/创作中', completed: '项目完结' }
  const getPersonalStage = (activity) => { if (activity.application_status === 'selected') return activity.key_claimed ? 'delivery' : 'claim_key'; return activity.status }
  const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - new Date()) / 86400000))
  const formatSubmittedAt = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  const formatShortDate = (value) => { const t = new Date(value); return `${String(t.getFullYear()).slice(2)}年${t.getMonth() + 1}月${t.getDate()}日` }

  const moreActivities = dashboard.more_activities || []
  const historicalActivities = dashboard.historical_activities || []
  const HISTORICAL_VISIBLE = 3
  const points = (dashboard.participated_count || 0) * 50 + (dashboard.submission_count || 0) * 300 + (dashboard.daily_submission_count || 0) * 80
  const tierInfo = getTierInfo(points)
  const prevMin = tierInfo.min, nextMin = tierInfo.nextMin || prevMin + 500
  const progressPct = prevMin === 0 && points === 0 ? 0 : Math.min(100, Math.round(((points - prevMin) / (nextMin - prevMin)) * 100))
  return <div className="partner-page"><header className="partner-header"><a className="partner-brand" href="?home"><span className="brand-mark zhihu-mark">知</span><span>GameJourney</span><small>答主看板</small></a><div className="partner-header-right">{(isPartner || answerer?.zhihu_name === '灰域信风') && <button className="reload outline dashboard-switch-btn" onClick={() => { window.location.href = '?partner' }}>切换到合作方看板</button>}{answerer?.zhihu_name === '灰域信风' && <button className="reload outline dashboard-switch-btn" onClick={() => { window.location.href = '?admin' }}>切换到管理员后台</button>}<button className="reload" onClick={loadDashboard}>刷新数据</button><button className="reload" onClick={() => { window.location.href = '?home' }}>回到封面</button><div className="dashboard-user-area" onClick={() => setDropdownOpen(!dropdownOpen)}><div className="dashboard-avatar-wrap">{answerer?.avatar_url ? <img className="dashboard-avatar-img" src={answerer.avatar_url} alt="" /> : <span className="dashboard-avatar-placeholder">{answerer?.zhihu_name?.[0] || '?'}</span>}</div>{unreadInboxCount > 0 && <span className="dashboard-avatar-dot"/>}<span className="dashboard-username">{answerer?.zhihu_name || dashboard?.answerer?.zhihu_name}<Icon name="arrow" size={12}/></span>{dropdownOpen && <><div className="dashboard-dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setDropdownOpen(false) }}/><div className="dashboard-dropdown"><button onClick={() => { setDropdownOpen(false); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button><button onClick={() => { setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button><button onClick={() => { setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱{unreadInboxCount > 0 && <span className="dashboard-dropdown-dot"/>}</button><button className="dashboard-logout-btn" onClick={() => { localStorage.removeItem(SESSION_KEY); window.location.href = '?login' }}><Icon name="logout" size={16}/> 退出登录</button></div></>}</div></div></header><main className="partner-main answerer-dashboard"><section className="partner-hero dashboard-hero" style={{ '--dashboard-hero-cover': dashboard.answerer.dashboard_cover_url ? `url("${dashboard.answerer.dashboard_cover_url}")` : 'none' }}><div className="partner-hero-content"><p>你好，{dashboard.answerer.zhihu_name}</p><h1>我的测评活动</h1><span>查看正在参与的活动和已提交的作品。</span><button className="dashboard-cover-upload" onClick={() => { setCoverPreview(dashboard.answerer.dashboard_cover_url || ''); setCoverFile(null); setCoverMsg(''); setCoverModalOpen(true) }}><Icon name="image" size={16}/> 设置封面</button><div className="answerer-stats-row"><div className="hero-shared-code"><div className="hero-shared-code-inner">{sharedCode ? <div className="hero-shared-code-card"><span className="hero-shared-code-value" title="点击复制" onClick={() => { navigator.clipboard.writeText(sharedCode.code); setSharedMsg('邀请码已复制') }}>{sharedCode.code}</span><small>生成于 {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sharedCode.created_at))}</small></div> : <button className="hero-shared-code-btn" onClick={generateSharedCode} disabled={generatingShared}>{generatingShared ? '生成中…' : '分享邀请码'}<small>每日可生成一个</small></button>}{sharedMsg && <span className="hero-shared-code-msg" style={sharedMsg.includes('已生成') || sharedMsg.includes('已复制') ? undefined : { color: '#fca5a5' }}>{sharedMsg}</span>}</div></div><div className="answerer-stats"><div className="answerer-stats-left"><div className="answerer-tier-row"><span className="answerer-tier-icon">Lv{tierInfo.tier}</span><div><span className="answerer-tier-title">{tierInfo.title}</span><span className="answerer-tier-points">{points} 积分</span></div></div><div className="answerer-tier-progress"><div className="answerer-progress-bar"><div className="answerer-progress-fill" style={{width: progressPct + '%'}}></div></div>{tierInfo.nextTitle && <span className="answerer-next-tier">距「{tierInfo.nextTitle}」还需 {tierInfo.nextMin - points} 积分</span>}</div></div></div><div className="answerer-hero-metrics"><div className="answerer-metric answerer-metric-clickable" onClick={() => { setParticipatedModalOpen(true); loadParticipatedActivities() }} title="查看已参与活动详情"><span className="answerer-metric-value">{dashboard.participated_count || 0}</span><span className="answerer-metric-label">已参与活动</span><span className="answerer-metric-note">50 积分/个</span></div><div className="answerer-metric answerer-metric-clickable" onClick={() => { setCompletedModalOpen(true); loadCompletedActivities() }} title="查看已完成活动详情"><span className="answerer-metric-value">{dashboard.submission_count || 0}</span><span className="answerer-metric-label">已完成活动</span><span className="answerer-metric-note">300 积分/个</span></div><div className="answerer-metric"><span className="answerer-metric-value">{dashboard.daily_submission_count || 0}</span><span className="answerer-metric-label">已投稿日常回答</span><span className="answerer-metric-note">80 积分/个</span></div></div></div>{showBadges && <div className="answerer-hero-badges"><div className="answerer-hero-badges-head"><span>我的徽章</span><small>已解锁 {badges.length} 枚</small></div>{badges.length ? <div className="answerer-hero-badge-list">{badges.map((b) => <button key={b.game_name} className="answerer-hero-badge" onClick={() => setSelectedBadge(b)} title={`查看${b.game_name}徽章详情`}><img src={b.image_url || badgeImageUrl(b.game_name)} alt={b.name} loading="lazy"/></button>)}</div> : <small className="answerer-hero-badges-empty">提交交付物即可解锁</small>}</div>}</div></section><nav className="answerer-dashboard-tabs" role="tablist" aria-label="答主看板页卡"><div className="answerer-dashboard-tabs-inner">{[{k:'create',label:'今日投稿 & 热点',icon:'file'},{k:'activities',label:'我的活动',icon:'calendar'},{k:'submissions',label:'曾提交作品',icon:'inbox'}].map((t,i)=>(<button key={t.k} type="button" role="tab" aria-selected={activeTab===t.k} data-tabidx={i} className={`answerer-dashboard-tab ${activeTab===t.k?'active':''}`} onClick={()=>setActiveTab(t.k)}><span className="answerer-dashboard-tab-ripple"/><Icon name={t.icon} size={14}/> <span className="answerer-dashboard-tab-label">{t.label}</span></button>))}</div></nav><div className="answerer-dashboard-tabpanel" key={activeTab}>{activeTab==='create' && <><section className="dashboard-daily-form"><div className="panel-head dashboard-section-head"><div><h3>今日创作/提问投稿（非测评活动内容）</h3><p>回答投稿可提升积分（<span style={{color:'#e53e3e',fontWeight:600}}>每日限{tierInfo.tier}条</span>，随积分等级提升）；问题将进入「日常问题运营」后台。下方两种填写格式任选一种输入，激活其中一种时另一种自动置灰。</p></div></div><form onSubmit={submitQuestion}><div className="daily-question-form"><div className={`daily-question-form-row${qMode === 'link' ? ' active' : ''}`}><input type="url" placeholder="填写链接（必填，知乎回答或问题链接）" value={qUrl} onFocus={() => setQMode('link')} onChange={(e) => setQUrl(e.target.value)}/><input type="text" placeholder="问题（作品标题）文本（必填）" value={qTitle} onFocus={() => setQMode('link')} onChange={(e) => setQTitle(e.target.value)}/></div><div className="daily-question-form-paste-row"><textarea className={`daily-question-form-paste${qMode === 'paste' ? ' active' : ''}`} placeholder={'知乎标准分享格式（PC端 点【分享】-【链接】复制，可多填），例如：\n如何评价《黑神话：悟空》？ - 知乎\nhttps://www.zhihu.com/question/123456789\nhttps://www.zhihu.com/question/123456789/answer/987654321\nhttps://www.zhihu.com/answer/987654321'} value={qPaste} onFocus={() => setQMode('paste')} onChange={(e) => setQPaste(e.target.value)}/><button type="submit" className="primary" disabled={qSubmitting}>{qSubmitting ? '投稿中…' : '提交投稿'}</button></div></div>{qMsg && <p className="daily-form-msg">{qMsg}</p>}</form></section>{dashboardContentMode === 'favorites' ? <section className="dashboard-game-hotspots"><div className="panel-head dashboard-section-head dashboard-game-hotspots-head"><div><h3>游戏问题集散中心</h3><p>默认展示后台已收藏的问题，方便你快速打开并参与创作。</p></div><div className="game-hotspots-switch" role="switch" aria-checked={dashboardContentMode === 'hotspots'} aria-label="切换问题集散中心与每日游戏热点" tabIndex={0} onClick={toggleDashboardContentMode} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDashboardContentMode() } }}><span className={`game-hotspots-switch-label${dashboardContentMode === 'favorites' ? ' active' : ''}`}>问题集散中心</span><span className={`game-hotspots-switch-track${dashboardContentMode === 'hotspots' ? ' on' : ''}`}><span className="game-hotspots-switch-thumb"/></span><span className={`game-hotspots-switch-label${dashboardContentMode === 'hotspots' ? ' active' : ''}`}>每日游戏热点</span></div></div><div className="dashboard-favorite-list">{dashboardFavoriteQuestions.length ? dashboardFavoriteQuestions.slice(0, 20).map(item => <a key={item.id} className="dashboard-favorite-item" href={publicZhihuQuestionUrl(item.zhihu_url)} target="_blank" rel="noreferrer"><span className="dashboard-favorite-title-wrap">{item.answerer_name ? <em className="question-asker-tag">来自 <b className="question-asker-name">@{item.answerer_name}</b> 的提问，求回答！</em> : null}<span>{item.title || item.zhihu_url}</span></span><small>直达问题</small><Icon name="arrow" size={14}/></a>) : <div className="dashboard-empty">暂无收藏问题。</div>}</div></section> : <section className="dashboard-game-hotspots"><div className="panel-head dashboard-section-head dashboard-game-hotspots-head"><div><h3>每日游戏热点 · Top 20</h3><p>汇总国内游戏媒体与海外行业资讯，按事件热度、时效和来源覆盖度排序。</p></div><div className="game-hotspots-meta"><div className="game-hotspots-switch" role="switch" aria-checked={dashboardContentMode === 'hotspots'} aria-label="切换问题集散中心与每日游戏热点" tabIndex={0} onClick={toggleDashboardContentMode} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDashboardContentMode() } }}><span className={`game-hotspots-switch-label${dashboardContentMode === 'favorites' ? ' active' : ''}`}>问题集散中心</span><span className={`game-hotspots-switch-track${dashboardContentMode === 'hotspots' ? ' on' : ''}`}><span className="game-hotspots-switch-thumb"/></span><span className={`game-hotspots-switch-label${dashboardContentMode === 'hotspots' ? ' active' : ''}`}>每日游戏热点</span></div><span className="game-hotspots-update">{hotspotsUpdatedAt ? `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(hotspotsUpdatedAt))}` : '正在获取'}</span><button className="game-hotspots-refresh" onClick={loadGameHotspots} disabled={hotspotsLoading} title="刷新热点"><Icon name="clock" size={14}/> {hotspotsLoading ? '刷新中…' : '刷新'}</button></div></div>{hotspotsError ? <div className="dashboard-empty">{hotspotsError}</div> : hotspotsLoading && !gameHotspots.length ? <div className="dashboard-empty">正在抓取游戏热点…</div> : <ol className="game-hotspots-list">{gameHotspots.map((item) => { const isTop3 = item.rank <= 3; const rankColors = { 1: 'hot-gold', 2: 'hot-silver', 3: 'hot-bronze' }; const heatBarWidth = Math.min(100, Math.max(20, item.heat)) + '%'; return <li key={item.url} className={`game-hotspot-item${isTop3 ? ' top3' : ''}`}><div className="game-hotspot-rank"><span className={`hotspot-rank-badge ${isTop3 ? rankColors[item.rank] : ''}`}>{item.rank}</span></div><div className="game-hotspot-body"><div className="game-hotspot-thumb">{item.image ? <a href={item.url} target="_blank" rel="noreferrer" aria-label="查看原文"><img src={item.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.closest('.game-hotspot-thumb').classList.add('no-image') }}/></a> : <span className="game-hotspot-thumb-placeholder">{item.title?.[0] || '游'}</span>}</div><div className="game-hotspot-content"><div className="game-hotspot-header"><h4 className="game-hotspot-title"><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></h4><div className="game-hotspot-heat"><div className="heat-bar"><div className="heat-bar-fill" style={{width: heatBarWidth}}/></div><span className="heat-value">{item.heat}</span></div></div><p className="game-hotspot-summary">{item.summary}</p><div className="game-hotspot-footer"><div className="game-hotspot-tags">{(item.tags || []).map(tag => <span key={tag} className="pill hot-tag">{tag}</span>)}</div><div className="game-hotspot-sources"><span className="hot-sources-label">来源</span><a className="pill hot-source" href={item.url} target="_blank" rel="noreferrer">{item.source}</a></div></div></div></div></li> })}</ol>}</section>}{false && <section className="dashboard-game-hotspots"><div className="panel-head dashboard-section-head dashboard-game-hotspots-head"><div><h3>每日游戏热点 · Top 10</h3><p>从游民星空、3DM、Steam社区、NGA、Reddit 等站点实时抓取汇总，每小时更新。</p></div><div className="game-hotspots-meta"><span className="game-hotspots-update">{(() => { const now = new Date(); const pad = n => String(n).padStart(2, '0'); return `更新于 ${pad(now.getHours())}:${pad(now.getMinutes())}`; })()}</span><button className="game-hotspots-refresh" title="刷新热点"><Icon name="clock" size={14}/> 刷新</button></div></div><ol className="game-hotspots-list">{gameHotspots.map((item) => { const isTop3 = item.rank <= 3; const rankColors = { 1: 'hot-gold', 2: 'hot-silver', 3: 'hot-bronze' }; const heatPercent = Math.min(100, Math.max(20, item.heat)); const heatBarWidth = heatPercent + '%'; return <li key={item.rank} className={`game-hotspot-item${isTop3 ? ' top3' : ''}`}><div className="game-hotspot-rank"><span className={`hotspot-rank-badge ${isTop3 ? rankColors[item.rank] : ''}`}>{item.rank}</span></div><div className="game-hotspot-body"><div className="game-hotspot-header"><h4 className="game-hotspot-title">{item.title}</h4><div className="game-hotspot-heat"><div className="heat-bar"><div className="heat-bar-fill" style={{width: heatBarWidth}}/></div><span className="heat-value">{item.heat}</span></div></div><p className="game-hotspot-summary">{item.summary}</p><div className="game-hotspot-footer"><div className="game-hotspot-tags">{item.tags.map(tag => <span key={tag} className="pill hot-tag">#{tag}</span>)}</div><div className="game-hotspot-heat game-hotspot-heat-mobile" aria-hidden="true"><div className="heat-bar"><div className="heat-bar-fill" style={{width: heatBarWidth}}/></div><span className="heat-value">{item.heat}</span></div><div className="game-hotspot-sources"><span className="hot-sources-label">来源</span>{item.sources.map(src => <span key={src} className="pill hot-source">{src}</span>)}</div></div></div></li>; })}</ol></section>}</>}{activeTab==='activities' && <><section><div className="panel-head dashboard-section-head"><div><h3>正在参与</h3><p>点击活动卡片回到申领页。</p></div></div><div className="dashboard-activity-cards">{dashboard.activities.length ? dashboard.activities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${getPersonalStage(activity) === 'claim_key' || getPersonalStage(activity) === 'key_distribution' ? 'orange' : getPersonalStage(activity) === 'delivery' ? 'purple' : getPersonalStage(activity) === 'completed' ? 'green' : 'blue'}`}>{stageLabel[getPersonalStage(activity)] || getPersonalStage(activity)}</span>{getPersonalStage(activity) === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">暂无正在参与的活动。</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>更多体验活动</h3><p>后台已上线的活动，点击卡片前往报名。</p></div></div><div className="dashboard-activity-cards">{moreActivities.length ? moreActivities.map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div><span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>{activity.status === 'delivery' && activity.delivery_deadline && <span className="dashboard-deadline">距截稿还剩 {daysLeft(activity.delivery_deadline)} 天</span>}</div></div></a>) : <div className="dashboard-empty">{dashboard.more_activities === undefined ? '活动卡片加载中，请耐心等候' : '暂无更多可体验的活动。'}</div>}</div></section><section><div className="panel-head dashboard-section-head"><div><h3>历史活动</h3><p>招募已结束的活动回顾。</p></div></div><div className="dashboard-activity-cards">{historicalActivities.length ? (<>{historicalActivities.slice(0, HISTORICAL_VISIBLE).map((activity) => <a className="dashboard-activity-card" href={`?apply=${activity.id}`} key={activity.id}><div className="dashboard-activity-cover">{activity.game_cover ? <img src={activity.game_cover} alt={activity.game_name} loading="lazy"/> : <span>{activity.game_name?.[0] || '游'}</span>}</div><div className="dashboard-activity-body"><p>{activity.game_name}</p><h3>{activity.title}</h3><div>{activity.application_status === 'rejected' ? <span className="pill muted">未能入选</span> : activity.has_delivery ? <span className="pill stage-green">成功参与</span> : <span className={`pill stage-${activity.status === 'key_distribution' ? 'orange' : activity.status === 'delivery' ? 'purple' : activity.status === 'completed' ? 'green' : 'blue'}`}>{stageLabel[activity.status] || activity.status}</span>}</div></div></a>)}{historicalActivities.length > HISTORICAL_VISIBLE && <a className="dashboard-activity-card dashboard-activity-more" href="?home" style={{textDecoration:'none'}}><div className="dashboard-activity-cover dashboard-activity-more-cover">{(() => { const colors = ['#6366f1','#8b5cf6','#3b82f6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#14b8a6']; const picked = historicalMoreCovers; return Array.from({length:9}, (_,i) => { const act = picked[i]; const cover = act?.game_cover; return <div key={i} className="dashboard-activity-more-tile" style={cover ? {backgroundImage:`url(${cover})`} : {background:colors[i%9]}} /> }) })()}</div><div className="dashboard-activity-body"><h3>查看更多</h3><p>还有 {historicalActivities.length - HISTORICAL_VISIBLE} 个历史活动</p></div></a>}</>) : <div className="dashboard-empty">{dashboard.historical_activities === undefined ? '活动卡片加载中，请耐心等候' : '暂无历史活动。'}</div>}</div></section></>}{activeTab==='submissions' && <><section className="panel partner-table answerer-dashboard-submissions"><div className="panel-head dashboard-section-head"><div><h3>曾提交作品</h3><p>已提交的知乎作品记录。</p></div><button className="outline-button compact" onClick={() => { const headers = ['稿件类型', '作品标题', '作品链接']; const rows = (dashboard.submissions || []).map(s => [s.type === 'daily' ? '日常稿件' : '活动稿件', s.article_title || s.activity_title || '-', cleanZhihuAnswerUrl(s.article_url) || '']); const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${dashboard.answerer.zhihu_name}作品集_${fileTimestamp()}.csv`; a.click(); URL.revokeObjectURL(url) }}>下载 Excel</button></div><div className="table-wrap"><table><thead><tr><th>稿件类型</th><th>作品标题</th><th>作品链接</th></tr></thead><tbody>{(dashboard.submissions || []).length ? (dashboard.submissions || []).map((submission, idx) => <tr key={`submission-${idx}`}><td><span className={`submission-type ${submission.type === 'daily' ? 'daily' : 'activity'}`}>{submission.type === 'daily' ? '日常稿件' : '活动稿件'}</span></td><td>{submission.article_title || submission.activity_title || '-'}</td><td>{submission.article_url ? (() => { const u = cleanZhihuAnswerUrl(submission.article_url); return <a href={u} target="_blank" rel="noreferrer" title={u} className="profile-link" style={{wordBreak:'break-all'}}>{u.length > 50 ? u.slice(0, 50) + '...' : u} <Icon name="arrow" size={13}/></a> })() : '-'}</td></tr>) : <tr><td colSpan="3" className="table-empty">尚未提交作品。</td></tr>}</tbody></table></div></section></>}</div></main>
    {qSuccessOpen && <Modal title="投稿成功" onClose={() => setQSuccessOpen(false)}><div className="daily-success-modal"><div className="step-message-icon success"><Icon name="check" size={24}/></div><p>今日创作/提问投稿已提交</p><span>问题已进入「日常问题运营」后台，回答已进入「答主日常投稿」后台，管理员处理后会进行后续跟进。</span><button className="primary" onClick={() => setQSuccessOpen(false)}>知道了</button></div></Modal>}
    {qErrorOpen && <Modal title="检测失败" onClose={() => setQErrorOpen(false)}><div className="daily-success-modal"><div className="step-message-icon waiting"><Icon name="alert" size={24}/></div><p>{qMsg}</p><span>请同时包含标题与有效的知乎链接，再重新提交。</span><button className="primary" onClick={() => setQErrorOpen(false)}>知道了</button></div></Modal>}
    {selectedBadge && <Modal title="徽章详情" onClose={() => setSelectedBadge(null)}><div className="badge-detail-body"><img src={selectedBadge.image_url || badgeImageUrl(selectedBadge.game_name)} alt={selectedBadge.name}/><h3>{selectedBadge.game_name}</h3><p>解锁时间：{selectedBadge.awarded_at ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(selectedBadge.awarded_at)) : '-'}</p></div></Modal>}
    {avatarModalOpen && <Modal title="修改头像" onClose={() => { setAvatarModalOpen(false); setAvatarMsg(''); setAvatarFile(null) }}>
      <div className="avatar-upload-body">
        <div className="avatar-upload-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="dashboard-avatar-placeholder" style={{width:96,height:96,fontSize:40}}>{answerer?.zhihu_name?.[0]}</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG、WebP，将自动压缩（原图不超过 10MB）</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden/></label>
          {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {avatarMsg && <p className="avatar-upload-error">{avatarMsg}</p>}
      </div>
    </Modal>}
    {coverModalOpen && <Modal title="设置看板封面" onClose={() => { setCoverModalOpen(false); setCoverMsg(''); setCoverFile(null) }}>
      <div className="dashboard-cover-upload-body">
        <div className="dashboard-cover-preview">{coverPreview ? <img src={coverPreview} alt="看板封面预览"/> : <span>暂无封面</span>}</div>
        <p className="avatar-upload-hint">支持 JPG、PNG、WebP 格式，大小不超过 800KB</p>
        <div className="avatar-upload-actions">
          <label className="outline-button avatar-upload-btn"><Icon name="upload" size={16}/> 选择图片<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleCoverFile(e.target.files[0])} hidden/></label>
          {coverFile && <button className="primary" onClick={uploadDashboardCover} disabled={coverUploading}>{coverUploading ? '上传中…' : '确认上传'}</button>}
        </div>
        {coverMsg && <p className="avatar-upload-error">{coverMsg}</p>}
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
                    <span>{formatShortDate(d.submitted_at)}</span>
                    <a className="primary compact" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer">打开 <Icon name="arrow" size={12}/></a>
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
    return parseAnswererIds(activity.exempted_answerer_ids).some((id) => String(id) === String(answerer.id))
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
    trackPageView('claim', activityId, getAnswererSession()?.id || null)
    const init = async () => {
      const { data: act, error: actErr } = await supabase.from('keyflow_activities').select('*').eq('id', activityId).single()
      if (actErr) { setError('该申领页不存在或已失效。'); setLoading(false); return }
      let currentAnswerer = getAnswererSession()
      if (currentAnswerer?.zhihu_name) {
        const { data: canonicalAnswerer } = await supabase.from('keyflow_answerers').select('id, zhihu_name, account_address, avatar_url').eq('zhihu_name', currentAnswerer.zhihu_name).maybeSingle()
        if (canonicalAnswerer) {
          currentAnswerer = { ...currentAnswerer, ...canonicalAnswerer }
          setAnswerer(currentAnswerer)
          localStorage.setItem(SESSION_KEY, JSON.stringify(currentAnswerer))
        }
      }
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
      const applicationQuery = currentAnswerer?.id
        ? supabase.from('keyflow_applications').select('*, keyflow_deliveries(id, status, article_url, article_title, claimed_word_count, verified_word_count), keyflow_keys(claimed_at)').eq('activity_id', activityId).eq('answerer_id', currentAnswerer.id).maybeSingle()
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
              .select('*, keyflow_deliveries(id, status, article_url, article_title, claimed_word_count, verified_word_count), keyflow_keys(claimed_at)')
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
    if (!isExempted && activity.status === 'completed') {
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
    <div className="public-brand"><a href="?home" style={{display:'flex',alignItems:'center',gap:'var(--sp-2)',textDecoration:'none',color:'inherit'}}><span className="brand-mark zhihu-mark">知</span><span>答主游戏KEY申领</span></a>{answerer && <a className="answerer-dashboard-link" href="?dashboard"><span className="answerer-dashboard-avatar" aria-hidden="true">{answerer.avatar_url ? <img src={answerer.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (answerer.zhihu_name?.trim().charAt(0) || '我')}</span>我的看板</a>}</div>
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
                <a key={a.id} href={`?apply=${a.id}`} className="more-activity-card">
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
          <p>活动招募已截止，如需报名请单独联系管理员</p>
        </div>
      ) : !hasApp && !isExempted && answerer && activity.status === 'delivery' ? (
        <div className="step-message">
          <div className="step-message-icon waiting"><Icon name="clock" size={24}/></div>
          <p>活动已进入创作阶段，如需报名请单独联系管理员</p>
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
              <label className="field"><span>GameJourney用户名</span><input value={answerer.zhihu_name} disabled /></label>
              {(() => { const platforms = Array.isArray(activity.platforms) && activity.platforms.length ? activity.platforms : ['steam']; const selected = activityPlatforms.find((platform) => platform.value === form.selected_platform); return platforms.length > 1 ? <label className="field platform-select-field"><span>版本选择</span><div className="platform-select-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{selected?.icon}</svg><select value={form.selected_platform} onChange={(event) => setForm({ ...form, selected_platform: event.target.value })}>{platforms.map((platform) => <option key={platform} value={platform}>{platformLabel[platform] || platform}</option>)}</select><Icon name="arrow" size={16}/></div></label> : platforms[0] !== 'steam' ? <label className="field platform-select-field"><span>版本选择</span><div className="platform-select-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{selected?.icon}</svg><span className="platform-readonly">{platformLabel[platforms[0]] || platforms[0]}</span></div></label> : null })()}
              <Field label="预计完成字数" type="number" required value={form.expected_word_count} onChange={(value) => setForm({ ...form, expected_word_count: value })} onBlur={(event) => { const numberValue = Number(event.target.value) || 800; if (numberValue < 800) setForm({ ...form, expected_word_count: 800 }) }}/>
              <span className="word-min-hint">最低 800 字</span>
              {error && <p className="public-error">{error}</p>}
              <button className="primary public-submit" disabled={registering}>{registering ? '提交中…' : '提交报名'}</button>
            </form>
          )}

          {hasApp && !showDelivery && (isRejected ? <div className="step-message"><div className="step-message-icon rejected"><Icon name="close" size={24}/></div><p>本次未入选</p><span>抱歉，您未能取得本游戏的体验资格，请关注其它活动，感谢您的理解！</span></div> : !isSelected ? <div className="step-message"><div className="step-message-icon waiting"><Icon name="clock" size={24}/></div><p>报名已提交，等待筛选</p><span>运营方会根据测评要求筛选答主，入选后可在此页面领取 Key。</span></div> : (() => { const selPlatform = application?.selected_platform || form.selected_platform || 'steam'; const stockInfo = platformStock[selPlatform]; const outOfStock = stockInfo && stockInfo.available === 0; if (outOfStock) { return <div className="step-message"><div className="step-message-icon waiting"><Icon name="alert" size={24}/></div><p>该平台 Key 库存不足，请联系管理员</p><span>{platformLabel[selPlatform] || selPlatform} 版本 Key 已全部发放，如需协助请联系运营方补充库存。</span></div> } return <div className="step-claim"><h2>领取游戏 Key</h2><p>恭喜入选！点击下方按钮领取你的专属 Key。</p><button className="primary claim-btn" onClick={claimKey} disabled={claiming}>{claiming ? '领取中…' : '领取 Key'}</button>{error && <p className="public-error">{error}</p>}</div> })())}

          {showDelivery && (() => { const daysLeft = activity.delivery_deadline ? Math.ceil((new Date(activity.delivery_deadline) - new Date()) / (1000 * 60 * 60 * 24)) : null; return <div className="step-delivery">{hasDelivery && <div className="delivery-submitted-section"><div className="step-message"><div className="step-message-icon done"><Icon name="check" size={24}/></div><p>作品已提交</p><span>可继续提交更多作品</span></div><div className="delivery-list">{deliveries.map((d, i) => <a key={d.id || i} className="delivery-list-item" href={cleanZhihuAnswerUrl(d.article_url)} target="_blank" rel="noreferrer"><span className="delivery-list-status">{d.status === 'approved' ? '已通过' : d.status === 'revision_required' ? '需修改' : d.status === 'rejected' ? '未通过' : '待审核'}</span><span className="delivery-list-title">{d.article_title || d.article_url}</span></a>)}</div></div>}{!isExempted && <div className="key-display"><div className="key-label">你的游戏 Key</div><div className="key-value">{claimedKey.key_value}</div><button className="outline-button" onClick={() => { navigator.clipboard.writeText(claimedKey.key_value); toast('Key 已复制') }}>复制 Key</button></div>}<form className="delivery-form" onSubmit={submitDelivery}><h2>提交作品链接{hasDelivery ? <span className="delivery-congrats">恭喜您完成本次活动！</span> : <>{daysLeft !== null && daysLeft > 0 && <span className="deadline-badge">{daysLeft <= 3 ? <span className="deadline-pulse"/> : null}还剩 <strong>{daysLeft}</strong> 天</span>}{daysLeft !== null && daysLeft <= 0 && <span className="deadline-badge expired">已截止</span>}</>}</h2><Field label="知乎回答地址" type="url" required value={articleUrl} placeholder="https://www.zhihu.com/question/.../answer/..." onChange={(value) => setArticleUrl(value)}/><Field label="作品标题" type="text" required value={articleTitle} placeholder="填写对应的知乎问题" onChange={(value) => setArticleTitle(value)}/>{error && <p className="public-error">{error}</p>}<div className="delivery-submit-row"><button className="primary public-submit" disabled={submitting}>{submitting ? '提交中…' : '提交作品'}</button><a className="outline-button dashboard-enter-btn" href="?dashboard">进入我的看板</a></div></form></div> })()}
        </>
      )}
    </div>

    {notice && <div className="toast"><Icon name="check" size={17}/>{notice}</div>}
  </main></div>
}

function RegisterPage({ aid, redirect }) {
  const [banner, setBanner] = useState(() => getCachedBanner())
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
    if (banner) return
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle().then(({ data, error: requestError }) => {
      if (requestError) { console.error('[RegisterPage] 读取头图失败:', requestError.message, requestError); return }
      if (data?.image_data && data.image_data.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) }
    }).catch((err) => { console.error('[RegisterPage] 查询异常:', err) })
  }, [banner])

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
    if (!form.zhihu_name.trim()) { setError('请输入 GameJourney 用户名'); return }
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
        {banner && <div className="register-banner-bg" style={{ backgroundImage: `url(${banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
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
            <span>GameJourney用户名<em>*</em></span>
            <input required value={form.zhihu_name} placeholder="保持和知乎用户名一样即可" onChange={(e) => setForm({ ...form, zhihu_name: e.target.value })} />
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
  const [banner, setBanner] = useState(() => getCachedBanner())
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

  useEffect(() => {
    if (banner) return
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle()
      .then(({ data }) => { if (data?.image_data?.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) } })
  }, [])

  const handleLogin = async (event) => {
    event.preventDefault(); setError('')
    if (!form.zhihu_name.trim()) { setError('请输入 GameJourney 用户名'); return }
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
    if (!forgotName.trim()) { setForgotMsg('请输入 GameJourney 用户名'); return }
    setForgotLoading(true)
    const { data: answererId, error: lookupErr } = await supabase.rpc('keyflow_answerer_id_by_zhihu_name', { p_zhihu_name: forgotName.trim() })
    if (lookupErr || !answererId) { setForgotLoading(false); setForgotMsg('未找到该用户名，请确认输入'); return }
    setForgotAnswererId(answererId)
    const { error: rpcErr } = await supabase.rpc('keyflow_request_password_reset', { p_answerer_id: answererId })
    setForgotLoading(false)
    if (rpcErr) {
      if (rpcErr.message.includes('已有一个待处理')) { setForgotStep('pending'); localStorage.setItem(PWD_RESET_FORGOT_KEY, JSON.stringify({ answererId, name: forgotName.trim() })); return }
      if (rpcErr.message.includes('已通过审核')) { setForgotStep('approved'); localStorage.setItem(PWD_RESET_FORGOT_KEY, JSON.stringify({ answererId, name: forgotName.trim() })); return }
      setForgotMsg(rpcErr.message); return
    }
    localStorage.setItem(PWD_RESET_FORGOT_KEY, JSON.stringify({ answererId, name: forgotName.trim() }))
    setForgotStep('pending')
  }

  const forgotCheckStatus = async () => {
    if (!forgotAnswererId) return
    const { data } = await supabase.from('keyflow_password_reset_requests')
      .select('*').eq('answerer_id', forgotAnswererId)
      .order('requested_at', { ascending: false }).limit(1).maybeSingle()
    if (data) {
      if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setForgotStep('idle'); setForgotMsg('审批已过期，请重新提交密码重置申请。'); localStorage.removeItem(PWD_RESET_FORGOT_KEY) }
        else setForgotStep('approved')
      }
      else if (data.status === 'rejected') { setForgotStep('rejected'); setForgotMsg(data.admin_note || '管理员拒绝了你的密码重置申请。'); localStorage.removeItem(PWD_RESET_FORGOT_KEY) }
      else if (data.status === 'completed') { setForgotStep('done'); setForgotMsg('密码重置成功，请使用新密码重新登录。'); localStorage.removeItem(PWD_RESET_FORGOT_KEY) }
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
    let stored = null
    try { stored = JSON.parse(localStorage.getItem(PWD_RESET_FORGOT_KEY)) } catch {}
    if (stored?.answererId) {
      setForgotMode(true)
      setForgotName(stored.name || '')
      setForgotAnswererId(stored.answererId)
      setForgotStep('pending')
    }
  }, [])

  useEffect(() => {
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle().then(({ data }) => {
      if (data?.image_data && data.image_data.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) }
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
    localStorage.removeItem(PWD_RESET_FORGOT_KEY)
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
    <div className="public-hero"><h1>申请重置密码</h1><span>输入你的 GameJourney 用户名，提交申请后等待管理员审核。</span></div>
    {forgotStep === 'idle' ? <form className="public-form" onSubmit={handleForgotPassword}>
      <Field label="GameJourney用户名" required value={forgotName} placeholder="输入你的 GameJourney 用户名" onChange={setForgotName} />
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
        {banner && <div className="register-banner-bg" style={{ backgroundImage: `url(${banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
        <div className="register-banner-content">
          <span className="brand-mark zhihu-mark">知</span>
          <h1>答主登录</h1>
          <p>使用已注册的 GameJourney 用户名和密码登录。</p>
        </div>
      </div>
      <form className="register-form" onSubmit={handleLogin}>
        <h2>登录</h2>
        <div className="register-fields">
          <label className="register-field">
            <span>GameJourney用户名<em>*</em></span>
            <input required value={form.zhihu_name} placeholder="输入注册时的 GameJourney 用户名" onChange={(e) => setForm({ ...form, zhihu_name: e.target.value })} />
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

  useEffect(() => {
    trackPageView('home')
  }, [])
  const [authMode, setAuthMode] = useState('login')
  const [mobileAuthOpen, setMobileAuthOpen] = useState(false)
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
  const [banner, setBanner] = useState(() => getCachedBanner())
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
    if (banner) return
    supabase.from('keyflow_page_assets').select('image_data').eq('key', 'register_banner').maybeSingle()
      .then(({ data }) => { if (data?.image_data?.length > 100) { setBanner(data.image_data); setCachedBanner(data.image_data) } })
  }, [banner])

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
    if (!loginForm.zhihu_name.trim()) { setLoginError('请输入 GameJourney 用户名'); return }
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
    if (!regForm.zhihu_name.trim()) { setRegError('请输入 GameJourney 用户名'); return }
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

  const STAGE_LABEL = { recruiting: '招募中', key_distribution: '招募截止请等待', delivery: '创作中', completed: '已完结' }
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

  const handleAvatarFile = async (file) => {
    setAvatarMsg('')
    if (!file) return
    if (!file.type.startsWith('image/')) { setAvatarMsg('请选择图片文件'); return }
    if (file.size > 10 * 1024 * 1024) { setAvatarMsg('图片大小不能超过 10MB'); return }
    try {
      const compressed = await compressImageFile(file, 256, 0.85)
      setAvatarFile(compressed)
      const reader = new FileReader()
      reader.onload = (e) => setAvatarPreview(e.target.result)
      reader.readAsDataURL(compressed)
    } catch {
      setAvatarMsg('图片处理失败，请重新选择')
    }
  }

  const uploadAvatar = async () => {
    if (!avatarFile) return
    setAvatarUploading(true)
    let publicUrl
    try {
      publicUrl = await uploadMediaFile(avatarFile, user.media_upload_token, 'avatar')
    } catch (error) {
      setAvatarUploading(false)
      setAvatarMsg(error.message)
      return
    }
    const { error: updateErr } = await supabase.rpc('keyflow_answerer_update_avatar', { p_answerer_id: user.id, p_avatar_url: publicUrl })
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
      else if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
      if (data.status === 'approved') {
        if (isPasswordResetApprovalExpired(data)) { setPwdResetStep('idle'); setPwdResetMsg('审批已过期，请重新提交密码重置申请。') }
        else setPwdResetStep('approved')
      }
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
          {!loggedIn && <button className="home-mobile-login-btn" onClick={() => { setAuthMode('login'); setLoginError(''); setRegError(''); setMobileAuthOpen(true) }}>登录</button>}
          {loggedIn && (isPartner
            ? <div className="answerer-dashboard-link home-dashboard-btn home-partner-btn" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave} onClick={() => { window.location.href = '?partner' }}>
                <span className="answerer-dashboard-avatar partner-avatar">{user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (user?.zhihu_name?.trim().charAt(0) || '合')}</span>合作方页面<Icon name="arrow" size={12}/>
                {dropdownOpen && <div className="dashboard-dropdown" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave}>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setAvatarPreview(user?.avatar_url || null); setAvatarFile(null); setAvatarMsg(''); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setInboxModalOpen(true); loadInbox() }}><Icon name="inbox" size={16}/> 收件箱</button>
                  <button onClick={(e) => { e.stopPropagation(); doLogout() }}><Icon name="logout" size={16}/> 退出登录</button>
                </div>}
              </div>
            : <div className="answerer-dashboard-link home-dashboard-btn" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave} onClick={() => { window.location.href = '?dashboard' }}>
                <span className="answerer-dashboard-avatar">{user?.avatar_url ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : (user?.zhihu_name?.trim().charAt(0) || '我')}</span>我的看板<Icon name="arrow" size={12}/>
                {dropdownOpen && <div className="dashboard-dropdown" onMouseEnter={handleDropdownEnter} onMouseLeave={handleDropdownLeave}>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setAvatarPreview(user?.avatar_url || null); setAvatarFile(null); setAvatarMsg(''); setAvatarModalOpen(true) }}><Icon name="image" size={16}/> 修改头像</button>
                  <button onClick={(e) => { e.stopPropagation(); setDropdownOpen(false); setPwdResetModalOpen(true); setPwdResetStep('idle'); setPwdResetMsg(''); setNewPassword(''); setConfirmPassword(''); loadResetStatus() }}><Icon name="key" size={16}/> 重置密码</button>
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
    {!loggedIn && <aside className={`home-auth ${mobileAuthOpen ? 'mobile-open' : ''}`}>
      <button className="home-auth-close" aria-label="关闭登录窗口" onClick={() => setMobileAuthOpen(false)}><Icon name="close" size={20}/></button>
      {banner && <div className="home-auth-bg" style={{ backgroundImage: `url(${banner})` }} />}
      <div className="home-auth-content">
        <div className="home-auth-tabs">
          <button className={`home-auth-tab ${authMode === 'login' ? 'active' : ''}`} onClick={() => { setAuthMode('login'); setLoginError(''); setRegError('') }}>登录</button>
          <button className={`home-auth-tab ${authMode === 'register' ? 'active' : ''}`} onClick={() => { setAuthMode('register'); setLoginError(''); setRegError('') }}>注册</button>
        </div>
        {authMode === 'login' ? (
          <form className="home-auth-form" onSubmit={handleLogin}>
            <h2>欢迎回来</h2>
            <p className="home-auth-sub">登录后即可领取 Key 和提交测评作品。</p>
            <label className="home-field"><span>GameJourney用户名</span><input required value={loginForm.zhihu_name} placeholder="输入注册时的 GameJourney 用户名" onChange={(e) => setLoginForm({ ...loginForm, zhihu_name: e.target.value })} /></label>
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
            <label className="home-field"><span>GameJourney用户名</span><input required value={regForm.zhihu_name} placeholder="保持和知乎用户名一样即可" onChange={(e) => setRegForm({ ...regForm, zhihu_name: e.target.value })} />{nameHint?.type === 'checking' && <span className="home-field-hint checking">检测中…</span>}{nameHint?.type === 'taken' && <span className="home-field-hint taken">该用户名已被使用，建议 <button type="button" className="home-suggestion-btn" onClick={() => { setRegForm({ ...regForm, zhihu_name: nameHint.suggestion }); setNameHint(null) }}>使用「{nameHint.suggestion}」</button></span>}</label>
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
        <p className="avatar-upload-hint">支持 JPG、PNG、WebP，将自动压缩（原图不超过 10MB）</p>
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

function PartnerManagement({ codes, answerers, setAnswerers, activities, setActivities, onAddCodes, onRefresh, adminToken, participationByAnswerer, onViewAnswererParticipation }) {
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
    const { error } = await supabase.rpc('keyflow_admin_update_answerer_remark', { p_token: adminToken, p_answerer_id: partnerId, p_remark: text })
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

function AnswererManagement({ codes, answerers, setAnswerers, activities, applications, deliveries, dailySubmissions, onAddCodes, onDeleteAnswerer, adminToken, participationByAnswerer, onViewAnswererParticipation }) {
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
    const { error } = await supabase.rpc('keyflow_admin_update_answerer_remark', { p_token: adminToken, p_answerer_id: answererId, p_remark: text })
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
    const { error: requestError } = await supabase.rpc('keyflow_admin_delete_answerer', { p_token: adminToken, p_answerer_id: confirmDeleteId })
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
        <button className="outline-button compact" onClick={() => window.open('https://docs.qq.com/sheet/DWEZxb0RpRmtVZ1Nk?tab=BB08J2', '_blank', 'noopener')}>打开腾讯文档</button>
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

function DailyQuestionOperationsPage({ questions, setQuestions, adminToken, toast, setDailySubmissions }) {
  const [paste, setPaste] = useState('')
  const [selectedDate, setSelectedDate] = useState(null)
  const [saving, setSaving] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [opsTab, setOpsTab] = useState("questions")
  const toDateKey = (value) => new Date(value).toLocaleDateString('sv-SE')
  // 粘贴区仍支持问题与回答：识别为「回答」的条目写入答主日常投稿（keyflow_daily_submissions），
  // 「问题」条目写入本页（keyflow_daily_questions）。
  const savePasted = async () => {
    const entries = parseQuestions(paste)
    if (!entries.length) { toast?.('请按“标题 + 知乎问题/回答 URL”粘贴内容'); return }
    setSaving(true)
    const answerEntries = entries.filter((item) => item.content_type === 'answer')
    const questionEntries = entries.filter((item) => item.content_type !== 'answer')
    let answerSaved = 0, questionSaved = 0
    if (answerEntries.length) {
      const { data: inserted, error: answerErr } = await supabase.from('keyflow_daily_submissions').insert(answerEntries.map((item) => ({
        answerer_id: null,
        article_url: cleanZhihuAnswerUrl(item.zhihu_url),
        article_title: item.title,
      }))).select()
      if (answerErr) { setSaving(false); toast?.(answerErr.message); return }
      answerSaved = inserted?.length || 0
      if (answerSaved) setDailySubmissions?.((items) => [...(inserted || []), ...items].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)))
    }
    if (questionEntries.length) {
      const { data, error } = await supabase.rpc('keyflow_admin_create_daily_questions', { p_token: adminToken, p_questions: questionEntries })
      if (error) { setSaving(false); toast?.(error.message); return }
      questionSaved = data?.length || 0
      if (questionSaved) setQuestions((items) => [...(data || []), ...items.filter((item) => !(data || []).some((saved) => saved.id === item.id))].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)))
    }
    setSaving(false)
    setPaste('')
    const parts = []
    if (questionSaved) parts.push(`${questionSaved} 条问题`)
    if (answerSaved) parts.push(`${answerSaved} 条回答`)
    toast?.(`已保存 ${parts.join('、') || '0 条'}`)
  }
  const visible = (selectedDate ? questions.filter((item) => toDateKey(item.created_at) === selectedDate) : questions).filter((item) => item.content_type !== 'answer')
  useEffect(() => {
    supabase.rpc('keyflow_admin_zhihu_question_favorites', { p_token: adminToken }).then(({ data }) => {
      setFavoriteIds(new Set((data || []).filter(item => item.source === 'daily').map(item => questions.find(question => normalizeZhihuUrl(question.zhihu_url) === item.zhihu_url)?.id).filter(Boolean)))
    })
  }, [adminToken, questions])
  const toggleQuestionFavorite = async (item, favoriteOverride = null) => {
    const favorite = favoriteOverride === null ? !favoriteIds.has(item.id) : favoriteOverride
    setFavoriteIds(prev => { const next = new Set(prev); favorite ? next.add(item.id) : next.delete(item.id); return next })
    const { error } = await supabase.rpc('keyflow_admin_toggle_zhihu_question_favorite', { p_token: adminToken, p_zhihu_url: item.zhihu_url, p_title: item.title, p_source: 'daily', p_favorite: favorite })
    if (error) {
      setFavoriteIds(prev => { const next = new Set(prev); favorite ? next.delete(item.id) : next.add(item.id); return next })
      toast?.(error.message)
    }
  }
  const batchFavoriteQuestions = async () => {
    const items = [...selectedIds].map((id) => questions.find((q) => q.id === id)).filter(Boolean)
    if (!items.length) { toast?.('请先选择问题'); return }
    const { error } = await supabase.rpc('keyflow_admin_batch_favorite_zhihu_questions', { p_token: adminToken, p_items: items.map((q) => ({ zhihu_url: q.zhihu_url, title: q.title })), p_source: 'daily', p_favorite: true })
    if (error) { toast?.(error.message); return }
    setFavoriteIds((prev) => new Set([...prev, ...items.map((q) => q.id)]))
    setSelectedIds(new Set())
    toast?.(`已收藏 ${items.length} 条问题`)
  }
  const processQuestions = async (ids) => {
    const pendingIds = ids.filter((id) => !questions.find((item) => item.id === id)?.processed)
    if (!pendingIds.length) { toast?.('所选问题均已处理'); return }
    const { error } = await supabase.rpc('keyflow_admin_process_daily_questions', { p_token: adminToken, p_ids: pendingIds })
    if (error) { toast?.(error.message); return }
    const processedAt = new Date().toISOString()
    setQuestions((items) => items.map((item) => pendingIds.includes(item.id) ? { ...item, processed: true, processed_at: processedAt } : item))
    setSelectedIds(new Set())
    toast?.(`已处理 ${pendingIds.length} 条问题`)
  }
  const processToday = () => {
    const targetDate = selectedDate || toDateKey(new Date())
    const targetItems = selectedDate ? visible : questions.filter((item) => toDateKey(item.created_at) === targetDate)
    const targetIds = targetItems.filter((item) => !item.processed).map((item) => item.id)
    if (!targetIds.length) { toast?.(`${targetDate} 没有未处理的问题`); return }
    processQuestions(targetIds)
  }
  const copyQuestion = async (question) => {
    try { await navigator.clipboard.writeText(question.zhihu_url); toast?.('知乎链接已复制') }
    catch { toast?.('复制失败，请检查浏览器权限') }
  }
  const openUnprocessed = () => {
    const pending = visible.filter((item) => !item.processed)
    if (!pending.length) { toast?.('没有未处理的问题'); return }
    pending.forEach((item) => window.open(item.zhihu_url, '_blank', 'noopener,noreferrer'))
    toast?.(`已打开 ${pending.length} 条未处理问题`)
  }
  const exportCsv = () => {
    if (!visible.length) { toast?.('当前没有可导出的问题'); return }
    const rows = [['标题', '知乎 URL', '状态', '创建时间'], ...visible.map((item) => [item.title, item.zhihu_url, item.processed ? '已处理' : '未处理', new Date(item.created_at).toLocaleString('zh-CN')])]
    const csv = '\uFEFF' + rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `日常问题运营_${selectedDate || '全部'}_${fileTimestamp()}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  const daySummary = useMemo(() => questions.filter((item) => item.content_type !== 'answer').reduce((map, item) => {
    const key = toDateKey(item.created_at)
    map[key] = map[key] || { total: 0, pending: 0 }
    map[key].total++; if (!item.processed) map[key].pending++
    return map
  }, {}), [questions])
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const today = toDateKey(new Date())
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay()
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = [...Array(firstDay).fill(null), ...Array.from({ length: days }, (_, i) => {
    const date = new Date(month.getFullYear(), month.getMonth(), i + 1)
    return { day: i + 1, key: toDateKey(date), summary: daySummary[toDateKey(date)] }
  })]
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selectedIds.has(item.id))
  return <div className="daily-question-operations">
    <section className="daily-question-entry panel"><div className="panel-head"><div><h3>粘贴日常问题/回答</h3><p>每条内容包含标题和知乎问题/回答 URL，支持多条连续粘贴；识别为「回答」的条目将自动进入「答主日常投稿」并同步至每日投稿腾讯文档。</p></div><button className="primary" onClick={savePasted} disabled={saving}>{saving ? '保存中…' : '清洗并保存'}</button></div><textarea className="daily-question-paste" value={paste} onChange={(event) => setPaste(event.target.value)} placeholder={'标题\nhttps://www.zhihu.com/question/123456789\n\n回答标题 https://www.zhihu.com/question/123456789/answer/987654321'} /></section>
    <div className="analytics-tabs daily-question-tabs"><button className={opsTab === "questions" ? "active" : ""} onClick={() => setOpsTab("questions")}>日常问题运营</button><button className={opsTab === "following" ? "active" : ""} onClick={() => setOpsTab("following")}>关注问题看板</button><button className={opsTab === "favorites" ? "active" : ""} onClick={() => setOpsTab("favorites")}>收藏问题后台</button></div>
    {opsTab === "questions" && <section className="daily-question-workspace"><aside className="daily-question-calendar panel"><div className="daily-calendar-head"><button className="daily-calendar-nav" title="上个月" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1))}>&lt;</button><strong>{month.getFullYear()}年{month.getMonth() + 1}月</strong><button className="daily-calendar-nav" title="下个月" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1))}>&gt;</button></div><div className="daily-calendar-grid">{['日', '一', '二', '三', '四', '五', '六'].map((day) => <div className="daily-calendar-weekday" key={day}>{day}</div>)}{cells.map((cell, index) => <button key={index} className={`daily-calendar-cell${!cell ? ' empty' : ''}${cell?.key === selectedDate ? ' selected' : ''}${cell?.key === today ? ' today' : ''}`} disabled={!cell} onClick={() => setSelectedDate(cell.key === selectedDate ? null : cell.key)}>{cell && <><span className="daily-calendar-day">{cell.day}</span>{cell.summary && <span className={`daily-calendar-dot${cell.summary.pending ? ' unreviewed' : ''}`}>{cell.summary.total}</span>}</>}</button>)}</div>{selectedDate && <button className="daily-calendar-clear" onClick={() => setSelectedDate(null)}>清除日期筛选</button>}</aside>
      <section className="panel"><div className="application-toolbar"><span className="daily-question-count">{selectedDate ? `${selectedDate}：` : ''}共 {visible.length} 条，未处理 {visible.filter((item) => !item.processed).length} 条</span><div className="daily-question-actions"><button className="outline-button compact" onClick={() => window.open('https://docs.qq.com/sheet/DWFFweEVIaVNrc3Bz', '_blank', 'noopener')}>打开腾讯文档</button><button className="outline-button compact" onClick={openUnprocessed}>打开未处理</button><button className="outline-button compact" onClick={processToday}>一键处理当日</button><button className="outline-button compact" onClick={exportCsv}>导出 CSV</button>{selectedIds.size > 0 && <button className="outline-button compact" onClick={batchFavoriteQuestions}>批量收藏 ({selectedIds.size})</button>}{selectedIds.size > 0 && <button className="primary compact" onClick={() => processQuestions([...selectedIds])}>处理选中 ({selectedIds.size})</button>}</div></div><div className="table-wrap"><table><thead><tr><th><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds(allVisibleSelected ? new Set() : new Set(visible.map((item) => item.id)))} /></th><th>标题</th><th>知乎 URL</th><th>创建时间</th><th>状态</th><th>收藏</th><th>操作</th></tr></thead><tbody>{visible.length ? visible.map((item) => <tr key={item.id}><td><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((ids) => { const next = new Set(ids); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })} /></td><td className="daily-question-title">{item.title}</td><td><a className="profile-link" href={item.zhihu_url} target="_blank" rel="noreferrer">打开链接</a></td><td>{new Date(item.created_at).toLocaleString('zh-CN')}</td><td><span className={`pill ${item.processed ? 'success' : 'warning'}`}>{item.processed ? '已处理' : '未处理'}</span></td><td><button className={`question-favorite-btn ${favoriteIds.has(item.id) ? 'active' : ''}`} onClick={() => toggleQuestionFavorite(item)} title="收藏问题"><Icon name="star" size={15}/></button></td><td><div className="daily-question-row-actions"><button className="outline-button compact" onClick={() => copyQuestion(item)}>复制</button>{!item.processed && <button className="primary compact" onClick={() => processQuestions([item.id])}>处理</button>}</div></td></tr>) : <tr><td colSpan="7" className="table-empty">当前日期没有日常问题。</td></tr>}</tbody></table></div></section></section>}
    {opsTab === "following" && <ZhihuFollowingQuestions adminToken={adminToken} />}
    {opsTab === "favorites" && <ZhihuFavoriteQuestions adminToken={adminToken} />}
  </div>
}

function DailySubmissionsPage({ submissions, answerers, toast, setDailySubmissions, participationByAnswerer, onViewAnswererParticipation, setConfirmState }) {
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

  const handleDelete = (id) => {
    setConfirmState({
      message: '确定要删除该投稿吗？此操作不可撤销。',
      onConfirm: async () => {
        setConfirmState(null)
        const { error } = await supabase.from('keyflow_daily_submissions').delete().eq('id', id)
        if (error) { toast?.(error.message); return }
        setDailySubmissions(prev => prev.filter(s => s.id !== id))
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
        toast?.('投稿已删除')
      },
    })
  }

  const handleBatchDelete = () => {
    if (!selectedIds.size) return
    const ids = [...selectedIds]
    setConfirmState({
      message: `确定要删除选中的 ${ids.length} 条投稿吗？此操作不可撤销。`,
      onConfirm: async () => {
        setConfirmState(null)
        const { error } = await supabase.from('keyflow_daily_submissions').delete().in('id', ids)
        if (error) { toast?.(error.message); return }
        setDailySubmissions(prev => prev.filter(s => !ids.includes(s.id)))
        setSelectedIds(new Set())
        toast?.(`已删除 ${ids.length} 条投稿`)
      },
    })
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
        type: 'private_message', title: '投稿已收到', body: `您的投稿《${submission.article_title || '未知标题'}》已收到，已经进行扶持处理。`,
        to_id: submission.answerer_id, status: 'unread', data: { submission_id: submission.id },
      })
      toast?.('已向答主发送投稿确认私信')
    }
    setDailySubmissions(prev => prev.map(s => s.id === submission.id ? { ...s, processed: true, reviewed: true } : s))
    supabase.from('keyflow_daily_submissions').update({ processed: true, reviewed: true }).eq('id', submission.id).then(() => {})
  }

  const processIds = async (ids) => {
    let sentCount = 0
    for (const id of ids) {
      const s = submissions.find(sub => sub.id === id)
      if (!s || s.processed) continue
      const { data: existing } = await supabase.from('keyflow_inbox').select('id').eq('to_id', s.answerer_id).in('type', ['system', 'private_message']).eq('data->>submission_id', String(s.id)).maybeSingle()
      if (!existing) {
        await supabase.from('keyflow_inbox').insert({
          type: 'private_message', title: '投稿已收到', body: `您的投稿《${s.article_title || '未知标题'}》已收到，已经进行扶持处理。`,
          to_id: s.answerer_id, status: 'unread', data: { submission_id: s.id },
        })
        sentCount++
      }
      setDailySubmissions(prev => prev.map(sub => sub.id === id ? { ...sub, processed: true, reviewed: true } : sub))
      supabase.from('keyflow_daily_submissions').update({ processed: true, reviewed: true }).eq('id', id).then(() => {})
    }
    return sentCount
  }

  const handleBatchProcess = () => {
    if (!selectedIds.size) return
    const ids = [...selectedIds]
    setConfirmState({
      message: `确定要批量处理选中的 ${ids.length} 条投稿吗？`,
      confirmLabel: '确认处理',
      onConfirm: async () => {
        setConfirmState(null)
        const sentCount = await processIds(ids)
        toast?.(`已处理 ${sentCount} 条投稿`)
      },
    })
  }

  const handleProcessToday = () => {
    const today = new Date()
    const todayKey = selectedDate || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const todayIds = submissions.filter((s) => {
      if (s.processed) return false
      const d = new Date(s.submitted_at)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayKey
    }).map((s) => s.id)
    if (!todayIds.length) { toast?.('当日没有未处理的投稿'); return }
    setConfirmState({
      message: `确定要一键处理当日 ${todayIds.length} 条未处理投稿吗？`,
      confirmLabel: '确认处理',
      onConfirm: async () => {
        setConfirmState(null)
        const sentCount = await processIds(todayIds)
        toast?.(`已处理 ${sentCount} 条投稿`)
      },
    })
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
    const todayKey = selectedDate || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const todaySubs = submissions.filter(s => {
      const d = new Date(s.submitted_at)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayKey
    })
    if (!todaySubs.length) { toast?.('当日暂无投稿'); return }
    const headers = ['答主', '知乎主页', '作品标题', '投稿链接', '投稿时间']
    const rows = todaySubs.map(s => {
      const a = answererById[s.answerer_id]
      const isAdmin = !s.answerer_id
      return [isAdmin ? '管理员' : (a?.zhihu_name || '未知答主'), isAdmin ? '' : (a?.account_address || ''), s.article_title || '', cleanZhihuAnswerUrl(s.article_url), formatSubmissionDate(s.submitted_at)]
    })
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = url; link.download = `答主日常投稿_${todayKey}_${fileTimestamp()}.csv`; link.click()
    URL.revokeObjectURL(url)
  }

  const downloadAllCsv = () => {
    const headers = ['答主', '知乎主页', '作品标题', '投稿链接', '投稿时间']
    const rows = filtered.map(s => {
      const a = answererById[s.answerer_id]
      const isAdmin = !s.answerer_id
      return [isAdmin ? '管理员' : (a?.zhihu_name || '未知答主'), isAdmin ? '' : (a?.account_address || ''), s.article_title || '', cleanZhihuAnswerUrl(s.article_url), formatSubmissionDate(s.submitted_at)]
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
        <button className="outline-button compact" onClick={() => window.open('https://docs.qq.com/sheet/DWHdGQ3htWnJJZ1NI?tab=BB08J2', '_blank', 'noopener')}>打开腾讯文档</button>
        <button className="outline-button compact" onClick={handleOpenAllUnprocessed}>打开未处理</button>
        <button className="outline-button compact" onClick={handleProcessToday}>一键处理当日</button>
        <button className="outline-button compact" onClick={downloadTodayCsv}>下载今日作品</button>
        <button className="outline-button compact" onClick={downloadAllCsv}>下载历史全部作品</button>
      </div>
    </div>
    <div className="table-wrap"><table><thead><tr><th style={{ width: 40 }}><input type="checkbox" checked={paged.length > 0 && paged.every(s => selectedIds.has(s.id))} onChange={toggleSelectAll} /></th><th style={{ width: 120 }}>答主</th><th style={{ width: 90 }}>知乎主页</th><th>作品标题</th><th style={{ width: 90 }}>投稿链接</th><th style={{ width: 80 }}>处理</th><th style={{ width: 150 }}>投稿时间</th><th style={{ width: 50 }}>精华</th><th style={{ width: 60 }}>操作</th></tr></thead><tbody>
      {paged.length ? paged.map(s => { const a = answererById[s.answerer_id]; const isAdmin = !s.answerer_id; return <tr key={s.id}><td><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td><td><div className="person">{isAdmin ? <span className="person-avatar">管</span> : (a?.avatar_url ? <img className="person-avatar-img" src={a.avatar_url} alt="" onClick={() => { if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}} /> : <span className="person-avatar" onClick={() => { if (a) onViewAnswererParticipation(a) }} title="查看活动参与记录" style={{cursor:'pointer'}}>{a?.zhihu_name?.[0] || '?'}</span>)}<div><strong>{isAdmin ? '管理员' : (a?.zhihu_name || '未知答主')}</strong><small>{isAdmin ? '后台录入' : '知乎答主'}</small></div></div></td><td>{isAdmin ? <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>—</span> : (a?.account_address ? <a className="profile-link" href={a.account_address} target="_blank" rel="noreferrer">查看主页</a> : <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>未填写</span>)}</td><td>{s.article_title || <span style={{ color: 'var(--c-ink-4)' }}>—</span>}</td><td>{s.article_url ? <a className="profile-link" href={cleanZhihuAnswerUrl(s.article_url)} target="_blank" rel="noreferrer" onClick={e => { e.preventDefault(); handleViewSubmission(s) }}>查看投稿 <Icon name="arrow" size={13} /></a> : '—'}</td><td>{s.processed ? <span style={{ color: 'var(--c-ink-4)', fontSize: 'var(--fs-meta)' }}>已处理</span> : <button className="outline-button compact" onClick={() => handleProcess(s)}>处理</button>}</td><td>{formatSubmissionDate(s.submitted_at)}</td><td><button className="featured-toggle" onClick={() => toggleFeatured(s)} title={s.featured ? '取消精华' : '标记精华'} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '18px', padding: 0, lineHeight: 1, color: s.featured ? '#f0a500' : undefined }}>{s.featured ? '★' : '☆'}</button></td><td><button className="delete-action" onClick={() => handleDelete(s.id)} title="删除投稿">删除</button></td></tr> }) : <tr><td colSpan="9" className="table-empty">{keyword ? '无匹配结果。' : '暂无日常投稿。'}</td></tr>}
    </tbody></table></div>
    {totalPages > 1 && <div className="pagination"><div className="page-info">第 {safePage} 页，共 {totalPages} 页，共 {filtered.length} 条</div><div className="page-btns"><button className="page-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}><Icon name="arrow" size={13} style={{ transform: 'rotate(180deg)' }} /></button>{pages.map((p, i) => p === '…' ? <span key={`ellipsis-${i}`} className="page-ellipsis">…</span> : <button key={p} className={`page-btn${p === safePage ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>)}<button className="page-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}><Icon name="arrow" size={13} /></button></div></div>}
  </section>
}

function InboxPage({ messages, requests, answerers, adminToken, onRefresh, onMessageRead, onDeleteMessages, toast, setConfirmState }) {
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

  const markMessageRead = async (msg) => {
    if (msg._type === 'sent_batch' || msg.status !== 'unread') return
    const { error } = await supabase.from('keyflow_inbox').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', msg.id)
    if (!error) onMessageRead(msg.id)
  }

  const markAllRead = async () => {
    const unreadIds = messages.filter(m => m._type !== 'sent_batch' && m.status === 'unread').map(m => m.id)
    if (!unreadIds.length) return
    const { error } = await supabase.from('keyflow_inbox').update({ status: 'read', read_at: new Date().toISOString() }).in('id', unreadIds)
    if (error) return toast(error.message)
    unreadIds.forEach(onMessageRead)
  }

  const handleReview = async (msg, approved) => {
    const request = getRequestByAnswererId(msg.from_id)
    if (!request) { toast('未找到对应的密码重置申请'); return }
    setReviewLoading(msg.id)
    const { error } = await supabase.rpc('keyflow_review_password_reset', { p_token: adminToken, p_request_id: request.id, p_approved: approved })
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

  const unreadCount = messages.filter(m => m.status === 'unread').length

  return <div>
    <section className="panel">
      <div className="panel-head">
        <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
          <button className={`tab-btn ${tab === 'inbox' ? 'active' : ''}`} onClick={() => setTab('inbox')}>消息列表</button>
          <button className={`tab-btn ${tab === 'compose' ? 'active' : ''}`} onClick={() => setTab('compose')}>撰写私信</button>
        </div>
        {tab === 'inbox' && <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button className="outline-button compact" onClick={onRefresh}>刷新</button>
          {unreadCount > 0 && <button className="outline-button compact" onClick={markAllRead}>全部标为已读 ({unreadCount})</button>}
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
            <div className="inbox-item-header" onClick={() => { if (!isExpanded) markMessageRead(msg); setExpandedId(isExpanded ? null : msg._key) }}>
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

function ZhihuFavoriteQuestions({ adminToken }) {
  const [favorites, setFavorites] = useState([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const loadFavorites = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('keyflow_admin_zhihu_question_favorites', { p_token: adminToken })
    if (!error) setFavorites(data || [])
    setLoading(false)
  }
  const removeFavorite = async (item) => {
    const { error } = await supabase.rpc('keyflow_admin_toggle_zhihu_question_favorite', { p_token: adminToken, p_zhihu_url: item.zhihu_url, p_favorite: false })
    if (!error) setFavorites(prev => prev.filter(value => value.id !== item.id))
  }
  useEffect(() => { loadFavorites() }, [])
  const visible = favorites.filter(item => matchesSearch(`${item.title} ${item.zhihu_url}`, keyword))
  return <div className="zhihu-following-questions"><section className="panel"><div className="panel-head zhihu-questions-head"><div><h3>收藏问题后台</h3><p>集中管理关注页与日常问题中的收藏内容。</p></div><div className="zhihu-questions-actions"><div className="analytics-search"><input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索问题标题或链接" /></div><button className="outline-button compact" onClick={loadFavorites}>刷新</button></div></div><div className="table-wrap"><table className="zhihu-questions-table"><thead><tr><th>问题</th><th>来源</th><th>收藏时间</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan="4" className="table-empty">加载中…</td></tr> : visible.length ? visible.map(item => <tr key={item.id}><td><a className="zhihu-question-title" href={item.zhihu_url} target="_blank" rel="noreferrer">{item.title || item.zhihu_url}<Icon name="arrow" size={14}/></a></td><td>直达问题</td><td>{new Date(item.created_at).toLocaleString('zh-CN')}</td><td><button className="outline-button compact" onClick={() => removeFavorite(item)}>取消收藏</button></td></tr>) : <tr><td colSpan="4" className="table-empty">暂无收藏问题。</td></tr>}</tbody></table></div></section></div>
}

function ZhihuFollowingQuestions({ adminToken }) {
  const [questions, setQuestions] = useState([])
  const [favorites, setFavorites] = useState([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())

  const loadQuestions = async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      const { data: result, error: requestError } = await supabase.functions.invoke('zhihu-following-questions', { body: { adminToken, forceRefresh } })
      if (requestError) throw new Error(requestError.message || '请求失败')
      if (!result?.success) throw new Error(result?.error || '接口返回失败')
      if (!Array.isArray(result.questions)) throw new Error('接口返回格式不正确')
      setQuestions(result.questions)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '关注问题加载失败')
    } finally {
      setLoading(false)
    }
  }

  const loadFavorites = async () => {
    const { data } = await supabase.rpc('keyflow_admin_zhihu_question_favorites', { p_token: adminToken })
    setFavorites(data || [])
  }
  const toggleFavorite = async (question, favorite) => {
    const url = question.url || question.zhihu_url
    setFavorites(prev => favorite ? [...prev, { zhihu_url: url, title: question.title || '' }] : prev.filter(item => item.zhihu_url !== url))
    const { error: requestError } = await supabase.rpc('keyflow_admin_toggle_zhihu_question_favorite', { p_token: adminToken, p_zhihu_url: url, p_title: question.title || '', p_source: 'following', p_favorite: favorite })
    if (requestError) { setError(requestError.message); loadFavorites() }
  }
  useEffect(() => { loadQuestions(); loadFavorites() }, [])

  const filteredQuestions = questions.filter((question) => matchesSearch(`${question.title || ''} ${question.url || ''}`, keyword))
  const allFilteredSelected = filteredQuestions.length > 0 && filteredQuestions.every((question) => selectedIds.has(question.url || question.zhihu_url))
  const batchToggleFavorite = async (favorite) => {
    const selected = filteredQuestions.filter(question => selectedIds.has(question.url || question.zhihu_url))
    for (const question of selected) {
      const url = question.url || question.zhihu_url
      const isFavorite = favorites.some(item => item.zhihu_url === url)
      if (isFavorite !== favorite) await toggleFavorite(question, favorite)
    }
    setSelectedIds(new Set())
  }
  return <div className="zhihu-following-questions">
    <section className="panel">
      <div className="panel-head zhihu-questions-head">
        <div><h3>我关注的问题</h3><p>从当前配置的知乎账号同步，最多展示 100 条。</p></div>
        <div className="zhihu-questions-actions"><div className="analytics-search"><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索问题标题或链接" />{keyword && <button className="analytics-search-clear" onClick={() => setKeyword('')} aria-label="清除搜索">×</button>}</div><button className="outline-button compact" onClick={() => loadQuestions(true)} disabled={loading}><Icon name="reload" size={15}/>{loading ? '同步中…' : '刷新最新数据'}</button></div>
      </div>
      {error && <div className="zhihu-questions-error">加载失败：{error}</div>}
      <div className="application-toolbar"><span style={{ fontSize: 'var(--fs-meta)', color: 'var(--c-ink-4)', whiteSpace: 'nowrap' }}>共 {filteredQuestions.length} 条</span><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>{selectedIds.size > 0 && <><span style={{ fontSize: 'var(--fs-meta)', color: 'var(--c-ink-3)', whiteSpace: 'nowrap' }}>已选 <strong>{selectedIds.size}</strong> 项</span><button className="outline-button compact" onClick={() => batchToggleFavorite(true)}>批量收藏 ({selectedIds.size})</button><button className="outline-button compact" onClick={() => batchToggleFavorite(false)}>批量取消收藏</button><button className="outline-button compact" onClick={() => setSelectedIds(new Set())}>取消选择</button></>}</div></div>
      <div className="table-wrap"><table className="zhihu-questions-table"><thead><tr><th style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={allFilteredSelected} onChange={() => setSelectedIds(allFilteredSelected ? new Set() : new Set(filteredQuestions.map(question => question.url || question.zhihu_url)))} />问题</th><th>回答数</th><th>关注数</th><th>浏览量</th></tr></thead><tbody>{loading ? <tr><td colSpan="4" className="table-empty">正在同步知乎关注问题…</td></tr> : filteredQuestions.length ? filteredQuestions.map((question, index) => { const url = question.url || question.zhihu_url; const isFavorite = favorites.some(item => item.zhihu_url === url); return <tr key={`${url || question.title}-${index}`}><td><div className="zhihu-question-cell"><input type="checkbox" checked={selectedIds.has(url)} onChange={() => setSelectedIds(ids => { const next = new Set(ids); next.has(url) ? next.delete(url) : next.add(url); return next })} /><button className={`question-favorite-btn ${isFavorite ? 'active' : ''}`} title={isFavorite ? '取消收藏' : '收藏'} onClick={() => toggleFavorite(question, !isFavorite)}><Icon name="star" size={15}/></button><a className="zhihu-question-title" href={url} target="_blank" rel="noreferrer">{question.title || '未命名问题'}<Icon name="arrow" size={14}/></a></div></td><td>{Number(question.answerCount ?? question.answer_count) || 0}</td><td>{Number(question.followerCount ?? question.follower_count) || 0}</td><td>{Number(question.viewCount ?? question.view_count ?? question.visit_count) || 0} 浏览</td></tr> }) : <tr><td colSpan="4" className="table-empty">{keyword ? '没有匹配的问题。' : '当前账号没有关注的问题。'}</td></tr>}</tbody></table></div>
    </section>
  </div>
}

const ADMIN_PERMISSIONS = [
  { value: 'activity_manage', label: '活动管理', desc: '创建/编辑/删除活动', icon: '🎯' },
  { value: 'application_manage', label: '报名审核', desc: '筛选答主、审核报名', icon: '📋' },
  { value: 'key_manage', label: 'Key 管理', desc: '导入、分配、删除 Key', icon: '🔑' },
  { value: 'delivery_manage', label: '交付验收', desc: '审核作品、通过/退回', icon: '✅' },
  { value: 'answerer_manage', label: '答主管理', desc: '答主信息、豁免延期', icon: '👥' },
  { value: 'partner_manage', label: '合作方管理', desc: '合作方账号、分配活动', icon: '🤝' },
  { value: 'daily_submissions', label: '日常投稿运营', desc: '日常投稿/问题运营', icon: '📝' },
  { value: 'page_edit', label: '页面编辑', desc: '头图、徽章开关', icon: '🎨' },
  { value: 'inbox_send', label: '收件箱/私信', desc: '批量发送、审核密码重置', icon: '📬' },
  { value: 'analytics_view', label: '数据概览', desc: '访问统计、用户活动', icon: '📊' },
]

const PAGE_PERMISSION_MAP = {
  '活动看板': 'activity_manage',
  '活动概览': 'activity_manage',
  '答主报名': 'application_manage',
  'Key 管理': 'key_manage',
  '交付验收': 'delivery_manage',
  '答主管理': 'answerer_manage',
  '合作方管理': 'partner_manage',
  '数据概览': 'analytics_view',
  '全部活动投稿': 'delivery_manage',
  '答主日常投稿': 'daily_submissions',
  '日常问题运营': 'daily_submissions',
  '收藏问题后台': 'daily_submissions',
  '游戏热点看板': 'analytics_view',
  '剩余KEY管理': 'key_manage',
  '页面编辑': 'page_edit',
  '收件箱': 'inbox_send',
}

const hasAdminPermission = (adminSession, isSuperAdmin, pageLabel) => {
  if (isSuperAdmin) return true
  const perm = PAGE_PERMISSION_MAP[pageLabel]
  if (!perm) return true
  return Array.isArray(adminSession?.permissions) && adminSession.permissions.includes(perm)
}

function PermissionBlockedPlaceholder() {
  return <div className="empty-state" style={{ minHeight: 320 }}>
    <div className="empty-icon" style={{ opacity: 0.5 }}><Icon name="lock" size={30}/></div>
    <h2 style={{ color: 'var(--c-ink-3)' }}>该权限未开放</h2>
    <p style={{ color: 'var(--c-ink-4)', marginTop: 4 }}>请联系超级管理员为你分配对应功能权限。</p>
  </div>
}

function AdminManagementPage({ adminSession, isSuperAdmin, adminSubTabs, adminTab, setAdminTab, onUpdateAdminSession, toast, setConfirmState, setError }) {
  const [avatarFile, setAvatarFile] = useState(null)
  const [avatarPreview, setAvatarPreview] = useState(adminSession?.avatar_url || '')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [displayName, setDisplayName] = useState(adminSession?.display_name || '')
  const [displayNameSaving, setDisplayNameSaving] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const [pwdMsg, setPwdMsg] = useState('')

  const [adminList, setAdminList] = useState([])
  const [adminListLoading, setAdminListLoading] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newAdmin, setNewAdmin] = useState({ username: '', password: '', display_name: '', role: 'admin', permissions: [] })
  const [createSaving, setCreateSaving] = useState(false)
  const [editModal, setEditModal] = useState(null) // {admin, role, permissions}
  const [editSaving, setEditSaving] = useState(false)
  const [resetModal, setResetModal] = useState(null) // {admin, newPwd}
  const [resetSaving, setResetSaving] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')

  const loadAdminList = async () => {
    if (!isSuperAdmin) return
    setAdminListLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('keyflow_admin_list', { p_super_admin_id: adminSession?.username })
    setAdminListLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setAdminList(data || [])
  }
  useEffect(() => { if (adminTab === '管理员管理') loadAdminList() }, [adminTab])

  // ---- 头像上传 ----
  const handleAvatarFile = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('请选择图片文件'); return }
    if (file.size > 10 * 1024 * 1024) { setError('图片大小不能超过 10MB'); return }
    try {
      const compressed = await compressImageFile(file, 256, 0.85)
      setAvatarFile(compressed)
      const reader = new FileReader()
      reader.onload = (e) => setAvatarPreview(e.target.result)
      reader.readAsDataURL(compressed)
    } catch {
      setError('图片处理失败，请重新选择')
    }
  }

  const uploadAvatar = async () => {
    if (!avatarFile) return
    setAvatarUploading(true)
    let publicUrl
    try {
      // ⚠️ 管理员头像不依赖 PHP media-upload（那边鉴权逻辑改不动），
      //    直接把 compressImageFile 压缩好的 256px WebP 转 base64 存 avatar_url 列。
      //    压缩后 WebP 约 10~30KB，base64 文本完全可以放在 text 列里。
      publicUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('图片读失败'))
        reader.onload = () => resolve(reader.result)
        reader.readAsDataURL(avatarFile)
      })
    } catch (e) {
      setAvatarUploading(false)
      setError('媒体上传失败：' + (e.message || String(e)))
      return
    }
    const { error: updateErr } = await supabase.rpc('keyflow_admin_update_avatar', { p_admin_id: adminSession?.username, p_avatar_url: publicUrl })
    setAvatarUploading(false)
    if (updateErr) { setError('保存头像失败：' + updateErr.message); return }
    setAvatarFile(null)
    toast('头像已更新')
    onUpdateAdminSession({ avatar_url: publicUrl })
  }

  // ---- 显示名修改 ----
  const saveDisplayName = async () => {
    if (displayName.trim() === adminSession?.display_name) return
    setDisplayNameSaving(true)
    const { error: updateErr } = await supabase.rpc('keyflow_admin_update_display_name', { p_admin_id: adminSession?.username, p_display_name: displayName.trim() })
    setDisplayNameSaving(false)
    if (updateErr) { setError(updateErr.message); return }
    toast('显示名已更新')
    onUpdateAdminSession({ display_name: displayName.trim() })
  }

  // ---- 密码修改 ----
  const changePassword = async () => {
    setPwdMsg('')
    if (!oldPwd) { setPwdMsg('请输入原密码'); return }
    if (newPwd.length < 4) { setPwdMsg('新密码至少 4 位'); return }
    if (newPwd !== confirmPwd) { setPwdMsg('两次输入的新密码不一致'); return }
    setPwdSaving(true)
    const { error: rpcErr } = await supabase.rpc('keyflow_admin_change_password', { p_admin_id: adminSession?.username, p_old_password: oldPwd, p_new_password: newPwd })
    setPwdSaving(false)
    if (rpcErr) { setPwdMsg(rpcErr.message); return }
    setOldPwd(''); setNewPwd(''); setConfirmPwd('')
    setPwdMsg('密码已更新，请使用新密码重新登录。')
    setTimeout(() => { localStorage.removeItem(ADMIN_SESSION_KEY); window.location.href = window.location.pathname + '?admin' }, 1800)
  }

  // ---- 新建管理员 ----
  const openCreateModal = () => {
    setNewAdmin({ username: '', password: '', display_name: '', role: 'admin', permissions: [] })
    setCreateModalOpen(true)
  }
  const toggleNewPerm = (p) => setNewAdmin(prev => {
    const set = new Set(prev.permissions)
    if (set.has(p)) set.delete(p); else set.add(p)
    return { ...prev, permissions: [...set] }
  })
  const createAdmin = async () => {
    if (newAdmin.username.trim().length < 2) { setError('用户名至少 2 位'); return }
    if (newAdmin.password.length < 4) { setError('密码至少 4 位'); return }
    if (!newAdmin.display_name.trim()) { setError('请填写显示名'); return }
    setCreateSaving(true)
    const { error: rpcErr } = await supabase.rpc('keyflow_admin_create', {
      p_super_admin_id: adminSession?.username,
      p_username: newAdmin.username.trim(),
      p_password: newAdmin.password,
      p_display_name: newAdmin.display_name.trim(),
      p_role: newAdmin.role,
      p_permissions: newAdmin.permissions,
    })
    setCreateSaving(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setCreateModalOpen(false)
    toast('管理员已创建')
    loadAdminList()
  }

  // ---- 修改管理员权限/角色 ----
  const openEditModal = (admin) => setEditModal({ admin, role: admin.role, permissions: new Set(admin.permissions || []) })
  const toggleEditPerm = (p) => setEditModal(prev => { if (!prev) return prev; const s = new Set(prev.permissions); if (s.has(p)) s.delete(p); else s.add(p); return { ...prev, permissions: s } })
  const saveEditRole = async () => {
    if (!editModal) return
    setEditSaving(true)
    const { error: rpcErr } = await supabase.rpc('keyflow_admin_update_role', {
      p_super_admin_id: adminSession?.username,
      p_target_admin_id: editModal.admin.id,
      p_role: editModal.role,
      p_permissions: [...editModal.permissions],
    })
    setEditSaving(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setEditModal(null)
    toast('权限已更新')
    loadAdminList()
  }

  // ---- 删除管理员 ----
  const deleteAdmin = (admin) => {
    setConfirmState({
      message: `确定要删除管理员「${admin.display_name}」(${admin.username})吗？此操作不可撤销。`,
      confirmLabel: '确认删除',
      onConfirm: async () => {
        setConfirmState(null)
        const { error: rpcErr } = await supabase.rpc('keyflow_admin_delete', { p_super_admin_id: adminSession?.username, p_target_admin_id: admin.id })
        if (rpcErr) { setError(rpcErr.message); return }
        toast('管理员已删除')
        loadAdminList()
      },
    })
  }

  // ---- 重置管理员密码 ----
  const openResetModal = (admin) => setResetModal({ admin, newPwd: '' })
  const saveResetPwd = async () => {
    if (!resetModal) return
    if (resetModal.newPwd.length < 4) { setError('新密码至少 4 位'); return }
    setResetSaving(true)
    const { error: rpcErr } = await supabase.rpc('keyflow_admin_reset_password', {
      p_super_admin_id: adminSession?.username,
      p_target_admin_id: resetModal.admin.id,
      p_new_password: resetModal.newPwd,
    })
    setResetSaving(false)
    if (rpcErr) { setError(rpcErr.message); return }
    setResetModal(null)
    toast(`已重置 ${resetModal.admin.display_name} 的密码`)
  }

  const visibleAdmins = useMemo(() => {
    const k = searchKeyword.trim()
    if (!k) return adminList
    return adminList.filter(a => matchesSearch(`${a.username || ''} ${a.display_name || ''}`, k))
  }, [adminList, searchKeyword])

  return <div className="admin-management">
    {isSuperAdmin && <div className="admin-tabs">
      {adminSubTabs.map(([label, icon]) => <button key={label} className={`admin-tab-btn ${adminTab === label ? 'active' : ''}`} onClick={() => setAdminTab(label)}>
        <Icon name={icon} size={16} /><span>{label}</span>
      </button>)}
    </div>}

    {(!isSuperAdmin || adminTab === '个人设置') && <div className="admin-settings-grid">
      <section className="panel admin-settings-card">
        <div className="panel-head"><div><h3>个人资料</h3><p>设置你的头像和显示名称，展示在左下角区域。</p></div></div>
        <div className="admin-avatar-section">
          <div className="admin-avatar-preview">{avatarPreview ? <img src={avatarPreview} alt="" /> : <span>{(displayName || adminSession?.display_name || '管').charAt(0)}</span>}</div>
          <div className="admin-avatar-actions">
            <label className="outline-button"><Icon name="upload" size={16} /> 选择头像<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => handleAvatarFile(e.target.files[0])} hidden /></label>
            {avatarFile && <button className="primary" onClick={uploadAvatar} disabled={avatarUploading}>{avatarUploading ? '上传中…' : '确认上传'}</button>}
            <p className="hint">支持 JPG / PNG / WebP，原图不超过 10MB，将自动压缩到 256px。</p>
          </div>
        </div>
        <div className="admin-field-row">
          <Field label="用户名" value={adminSession?.username || ''} onChange={() => {}} disabled />
          <Field label="显示名称" required value={displayName} onChange={setDisplayName} placeholder="显示在界面上的名称" />
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button className="primary" onClick={saveDisplayName} disabled={displayNameSaving || displayName.trim() === adminSession?.display_name}>{displayNameSaving ? '保存中…' : '保存显示名'}</button>
          </div>
        </div>
        <div className="admin-field-row">
          <div className="field"><span>角色</span><span className={`pill ${isSuperAdmin ? 'success' : 'warning'}`} style={{ alignSelf: 'flex-start' }}>{isSuperAdmin ? '超级管理员' : '普通管理员'}</span></div>
          <div className="field"><span>{isSuperAdmin ? '权限范围' : '当前权限'}</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {isSuperAdmin ? <span className="pill success" style={{ fontSize: 11 }}>全部权限（含管理员系统管理）</span>
              : (adminSession?.permissions || []).length ? (adminSession?.permissions || []).map(p => {
              const meta = ADMIN_PERMISSIONS.find(x => x.value === p)
              return <span key={p} className="pill muted" style={{ fontSize: 11 }}>{meta?.label || p}</span>
            }) : <span className="pill muted" style={{ fontSize: 11 }}>未分配具体权限</span>}
          </div></div>
        </div>
      </section>

      <section className="panel admin-settings-card">
        <div className="panel-head"><div><h3>修改密码</h3><p>定期修改密码可提升账号安全性。</p></div></div>
        <div className="form-grid admin-pwd-grid">
          <Field label="原密码" type="password" required value={oldPwd} onChange={setOldPwd} placeholder="输入当前登录密码" />
          <Field label="新密码" type="password" required value={newPwd} onChange={setNewPwd} placeholder="至少 4 位字符" />
          <Field label="确认新密码" type="password" required value={confirmPwd} onChange={setConfirmPwd} placeholder="再次输入新密码" />
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
            <button className="primary" onClick={changePassword} disabled={pwdSaving}>{pwdSaving ? '提交中…' : '更新密码'}</button>
            {pwdMsg && <span className={`pwd-msg ${pwdMsg.includes('成功') || pwdMsg.includes('已更新') ? 'success-msg' : 'error-msg'}`}>{pwdMsg}</span>}
          </div>
        </div>
      </section>
    </div>}

    {adminTab === '管理员管理' && isSuperAdmin && <>
      <div className="admin-toolbar-row">
        <div className="partner-search-wrap" style={{ background: '#fff', minWidth: 280 }}>
          <Icon name="search" size={14} />
          <input className="partner-search-input" placeholder="搜索管理员用户名或显示名…" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)} />
          {searchKeyword && <button className="partner-search-clear" onClick={() => setSearchKeyword('')}><Icon name="close" size={14} /></button>}
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
          <button className="outline-button" onClick={loadAdminList} disabled={adminListLoading}>{adminListLoading ? '加载中…' : '刷新列表'}</button>
          <button className="primary" onClick={openCreateModal}><Icon name="plus" size={16} /> 新建管理员</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h3>管理员列表</h3><p>共 {adminList.length} 位管理员。仅超级管理员可查看和编辑此列表。</p></div></div>
        <div className="table-wrap"><table><thead><tr><th>管理员</th><th>用户名</th><th>角色</th><th>权限数</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
          {adminListLoading ? <tr><td colSpan="6" className="table-empty">正在加载管理员列表…</td></tr> : visibleAdmins.length ? visibleAdmins.map(a => <tr key={a.id}>
            <td><div className="person"><span className="person-avatar">{a.avatar_url ? <img className="person-avatar-img" src={a.avatar_url} alt="" /> : a.display_name?.charAt(0) || a.username?.charAt(0) || '管'}</span><div><strong>{a.display_name}</strong><small>{a.id === adminSession?.id ? '（当前登录）' : '管理员账号'}</small></div></div></td>
            <td>{a.username}</td>
            <td><span className={`pill ${a.role === 'super_admin' ? 'success' : 'warning'}`}>{a.role === 'super_admin' ? '超级管理员' : '普通管理员'}</span></td>
            <td>{(a.permissions || []).length > 0 ? `${a.permissions.length} 项` : <span className="pill muted" style={{ fontSize: 11 }}>继承角色默认</span>}</td>
            <td>{new Date(a.created_at).toLocaleDateString('zh-CN')}</td>
            <td><div style={{ display: 'flex', gap: 'var(--sp-1)' }}>
              <button className="outline-button compact" onClick={() => openEditModal(a)}>权限设置</button>
              <button className="outline-button compact" onClick={() => openResetModal(a)}>重置密码</button>
              {a.id !== adminSession?.id && <button className="outline-button compact danger" onClick={() => deleteAdmin(a)}>删除</button>}
            </div></td>
          </tr>) : <tr><td colSpan="6" className="table-empty">没有匹配的管理员。</td></tr>}
        </tbody></table></div>
      </section>
    </>}

    {createModalOpen && <Modal title="新建管理员账号" onClose={() => setCreateModalOpen(false)} wide>
      <div className="admin-create-form">
        <div className="form-grid">
          <Field label="用户名" required value={newAdmin.username} onChange={(v) => setNewAdmin(p => ({ ...p, username: v }))} placeholder="用于登录的账号，至少 2 位" />
          <Field label="显示名称" required value={newAdmin.display_name} onChange={(v) => setNewAdmin(p => ({ ...p, display_name: v }))} placeholder="展示在界面上的名称" />
          <Field label="初始密码" type="password" required value={newAdmin.password} onChange={(v) => setNewAdmin(p => ({ ...p, password: v }))} placeholder="至少 4 位，创建后可自行修改" />
          <label className="field"><span>角色</span>
            <div className="role-select-wrap">
              <select value={newAdmin.role} onChange={(e) => setNewAdmin(p => ({ ...p, role: e.target.value, permissions: e.target.value === 'super_admin' ? ['all'] : p.permissions }))}>
                <option value="admin">普通管理员</option>
                <option value="super_admin">超级管理员</option>
              </select>
            </div>
            {newAdmin.role === 'super_admin' && <div className="super-admin-tip"><span className="tip-icon">⚡</span>超级管理员拥有全部权限，并可管理其他管理员账号。</div>}
          </label>
        </div>
        {newAdmin.role !== 'super_admin' && <div className="field field-wide permissions-section"><span className="permissions-label"><span className="perms-title">功能权限</span><span className="perms-sub">可多选，已选 {newAdmin.permissions.length} 项</span></span>
          <div className="permissions-grid">
            {ADMIN_PERMISSIONS.map(p => <label key={p.value} className={`permission-card ${newAdmin.permissions.includes(p.value) ? 'checked' : ''}`}>
              <div className="perm-check">
                <input type="checkbox" checked={newAdmin.permissions.includes(p.value)} onChange={() => toggleNewPerm(p.value)} />
              </div>
              <div className="perm-body">
                <span className="perm-icon">{p.icon}</span>
                <div className="perm-text">
                  <span className="perm-label">{p.label}</span>
                  <small className="perm-desc">{p.desc}</small>
                </div>
              </div>
            </label>)}
          </div>
        </div>}
        <div className="modal-actions">
          <button className="outline-button" onClick={() => setCreateModalOpen(false)}>取消</button>
          <button className="primary" onClick={createAdmin} disabled={createSaving}>{createSaving ? '创建中…' : '确认创建'}</button>
        </div>
      </div>
    </Modal>}

    {editModal && <Modal title={`编辑权限：${editModal.admin.display_name}`} onClose={() => setEditModal(null)} wide>
      <div className="admin-create-form">
        <div className="form-grid">
          <label className="field"><span>角色</span>
            <div className="role-select-wrap">
              <select value={editModal.role} onChange={(e) => setEditModal(p => p ? { ...p, role: e.target.value, permissions: e.target.value === 'super_admin' ? new Set(['all']) : p.permissions } : p)}>
                <option value="admin">普通管理员</option>
                <option value="super_admin">超级管理员</option>
              </select>
            </div>
            {editModal.admin.id === adminSession?.id && <div className="self-downgrade-tip"><span className="tip-icon">⚠️</span>注意：将自己降级为普通管理员后，将无法再管理管理员列表（必须保留至少一个超级管理员）。</div>}
            {editModal.role === 'super_admin' && editModal.admin.id !== adminSession?.id && <div className="super-admin-tip"><span className="tip-icon">⚡</span>超级管理员拥有全部权限，并可管理其他管理员账号。</div>}
          </label>
        </div>
        {editModal.role !== 'super_admin' && <div className="field field-wide permissions-section"><span className="permissions-label"><span className="perms-title">功能权限</span><span className="perms-sub">可多选，已选 {editModal.permissions.size} 项</span></span>
          <div className="permissions-grid">
            {ADMIN_PERMISSIONS.map(p => <label key={p.value} className={`permission-card ${editModal.permissions.has(p.value) ? 'checked' : ''}`}>
              <div className="perm-check">
                <input type="checkbox" checked={editModal.permissions.has(p.value)} onChange={() => toggleEditPerm(p.value)} />
              </div>
              <div className="perm-body">
                <span className="perm-icon">{p.icon}</span>
                <div className="perm-text">
                  <span className="perm-label">{p.label}</span>
                  <small className="perm-desc">{p.desc}</small>
                </div>
              </div>
            </label>)}
          </div>
        </div>}
        <div className="modal-actions">
          <button className="outline-button" onClick={() => setEditModal(null)}>取消</button>
          <button className="primary" onClick={saveEditRole} disabled={editSaving}>{editSaving ? '保存中…' : '保存更改'}</button>
        </div>
      </div>
    </Modal>}

    {resetModal && <Modal title={`重置密码：${resetModal.admin.display_name}`} onClose={() => setResetModal(null)}>
      <div className="form-grid">
        <Field label="新密码" type="password" required value={resetModal.newPwd} onChange={(v) => setResetModal(p => p ? { ...p, newPwd: v } : p)} placeholder="至少 4 位字符" />
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
          <button className="outline-button" onClick={() => setResetModal(null)}>取消</button>
          <button className="primary" onClick={saveResetPwd} disabled={resetSaving}>{resetSaving ? '重置中…' : '确认重置'}</button>
        </div>
      </div>
    </Modal>}
  </div>
}

export default App


