// 知乎短链接自动补全
// 答主用知乎【分享 - 链接】拿到的是 https://www.zhihu.com/answer/<回答ID>，不含题目 ID，
// 只靠正则判定不了是否命中综合活动题库。这里在投稿提交前调用 Supabase 边缘函数
// resolve-zhihu-answer（服务端带知乎登录 Cookie）把链接补全成
// https://www.zhihu.com/question/<问题ID>/answer/<回答ID>，再走原有命中判定。
//
// 约定：解析失败不阻塞投稿——仍按答主填写的链接入库（照发经验、算活跃），只是不计活动进度。
import { supabase } from './supabase'
import { cleanZhihuAnswerUrl, getZhihuQuestionId } from './zhihuUrl.js'

const ANSWER_ID_PATTERN = /zhihu\.com\/(?:api\/v4\/)?(?:question\/\d+\/)?answers?\/(\d{6,})/i
const RESOLVE_CHUNK_SIZE = 40

export function getZhihuAnswerId(url) {
  if (!url) return null
  return cleanZhihuAnswerUrl(url)?.match(ANSWER_ID_PATTERN)?.[1] ?? null
}

// 需要补全：是知乎回答链接，但链接里没有题目 ID（短链接）
export function needsZhihuQuestionId(url) {
  return Boolean(url) && !getZhihuQuestionId(url) && Boolean(getZhihuAnswerId(url))
}

/**
 * 批量补全知乎短链接。
 * @param {string[]} urls
 * @param {{retries?: number, retryDelayMs?: number}} [options]
 *        刚发布的回答知乎接口可能还没收录，retries > 0 时会对没解析到的链接重试（默认不重试）。
 * @returns {Promise<{urls: string[], total: number, resolvedCount: number, failedAnswerIds: string[]}>}
 *          urls 与入参等长且顺序一致；解析不到的保持原样。
 */
export async function resolveZhihuAnswerUrls(urls, options = {}) {
  const retries = Math.max(0, Number(options.retries) || 0)
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0)
  const list = (urls || []).map((url) => cleanZhihuAnswerUrl(url) || '')
  let pending = []
  list.forEach((url, index) => {
    if (needsZhihuQuestionId(url)) pending.push({ index, answerId: getZhihuAnswerId(url) })
  })
  const total = pending.length

  const resolved = new Map()
  for (let attempt = 0; attempt <= retries && pending.length; attempt += 1) {
    if (attempt > 0 && retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    const stillPending = []
    for (let i = 0; i < pending.length; i += RESOLVE_CHUNK_SIZE) {
      const chunk = pending.slice(i, i + RESOLVE_CHUNK_SIZE)
      try {
        const { data, error } = await supabase.functions.invoke('resolve-zhihu-answer', {
          body: { answer_ids: chunk.map((item) => item.answerId) },
        })
        if (error) throw new Error(error.message || '解析服务不可用')
        for (const item of chunk) {
          const hit = data?.results?.[item.answerId]
          if (hit?.canonical_url) resolved.set(item.index, hit.canonical_url)
          else stillPending.push(item)
        }
      } catch {
        // 解析服务异常时按“未解析”处理，不影响投稿本身
        stillPending.push(...chunk)
      }
    }
    pending = stillPending
  }

  return {
    urls: list.map((url, index) => resolved.get(index) || url),
    total,
    resolvedCount: resolved.size,
    failedAnswerIds: pending.map((item) => item.answerId),
  }
}

/**
 * 面向投稿条目（parseQuestions 的产物）的补全封装。
 * @param {Array<{title: string, zhihu_url: string, content_type: string}>} entries
 * @param {{retries?: number, retryDelayMs?: number}} [options]
 */
export async function resolveZhihuEntries(entries, options) {
  const list = entries || []
  const { urls, total, resolvedCount, failedAnswerIds } = await resolveZhihuAnswerUrls(list.map((item) => item.zhihu_url), options)
  return {
    entries: list.map((item, index) => ({ ...item, zhihu_url: urls[index] })),
    total,
    resolvedCount,
    failedAnswerIds,
  }
}

/**
 * 服务端兜底补全：把库里还没补全的短链（含标题、题目链接）补回来，并重算活动命中。
 * 用于「提交时知乎还没收录这条刚发布的回答」的场景，过一会儿自动重试即可修好。
 * @param {{answererId?: string, limit?: number}} [options]
 * @returns {Promise<{updated?: number, resolved?: number, pending?: number} | null>} 失败返回 null，不抛错
 */
export async function repairZhihuLinks({ answererId, limit } = {}) {
  try {
    const body = {}
    if (answererId) body.answerer_id = answererId
    if (limit) body.limit = limit
    const { data, error } = await supabase.functions.invoke('repair-zhihu-links', { body })
    if (error) return null
    return data || null
  } catch {
    return null
  }
}

// 提交后过一会儿再补：20 秒 / 1 分钟 / 2.5 分钟各试一次，补到就停。
export const ZHIHU_REPAIR_DELAYS = [20_000, 60_000, 150_000]

/**
 * 提交后安排若干次兜底补全；一旦有链接被补全就回调（用于刷新活动进度、更新提示文案）。
 * @param {{answererId?: string, delays?: number[], onRepaired?: (result: any) => void}} [options]
 * @returns {() => void} 取消函数
 */
export function scheduleZhihuLinkRepair({ answererId, delays = ZHIHU_REPAIR_DELAYS, onRepaired } = {}) {
  let stopped = false
  const timers = []
  const run = async (index) => {
    if (stopped) return
    const result = await repairZhihuLinks({ answererId })
    if (stopped) return
    if (result && Number(result.updated) > 0) {
      try { onRepaired?.(result) } catch { /* 回调出错不影响主流程 */ }
      return
    }
    if (index + 1 < delays.length) timers.push(setTimeout(() => run(index + 1), delays[index + 1]))
  }
  if (delays.length) timers.push(setTimeout(() => run(0), delays[0]))
  return () => {
    stopped = true
    timers.forEach((timer) => clearTimeout(timer))
  }
}
