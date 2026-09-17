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
 * @returns {Promise<{urls: string[], total: number, resolvedCount: number, failedAnswerIds: string[]}>}
 *          urls 与入参等长且顺序一致；解析不到的保持原样。
 */
export async function resolveZhihuAnswerUrls(urls) {
  const list = (urls || []).map((url) => cleanZhihuAnswerUrl(url) || '')
  const targets = []
  list.forEach((url, index) => {
    if (needsZhihuQuestionId(url)) targets.push({ index, answerId: getZhihuAnswerId(url) })
  })

  const resolved = new Map()
  const failedAnswerIds = []
  for (let i = 0; i < targets.length; i += RESOLVE_CHUNK_SIZE) {
    const chunk = targets.slice(i, i + RESOLVE_CHUNK_SIZE)
    try {
      const { data, error } = await supabase.functions.invoke('resolve-zhihu-answer', {
        body: { answer_ids: chunk.map((item) => item.answerId) },
      })
      if (error) throw new Error(error.message || '解析服务不可用')
      for (const item of chunk) {
        const hit = data?.results?.[item.answerId]
        if (hit?.canonical_url) resolved.set(item.index, hit.canonical_url)
        else failedAnswerIds.push(item.answerId)
      }
    } catch {
      // 解析服务异常时按“未解析”处理，不影响投稿本身
      for (const item of chunk) failedAnswerIds.push(item.answerId)
    }
  }

  return {
    urls: list.map((url, index) => resolved.get(index) || url),
    total: targets.length,
    resolvedCount: resolved.size,
    failedAnswerIds,
  }
}

/**
 * 面向投稿条目（parseQuestions 的产物）的补全封装。
 * @param {Array<{title: string, zhihu_url: string, content_type: string}>} entries
 */
export async function resolveZhihuEntries(entries) {
  const list = entries || []
  const { urls, total, resolvedCount, failedAnswerIds } = await resolveZhihuAnswerUrls(list.map((item) => item.zhihu_url))
  return {
    entries: list.map((item, index) => ({ ...item, zhihu_url: urls[index] })),
    total,
    resolvedCount,
    failedAnswerIds,
  }
}
