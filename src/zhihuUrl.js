// 知乎链接统一清洗：入库与导出共用同一套规则，避免“ http://…”这类复制粘贴噪音
// 一路带到知乎后台，导致「保量扶持」等批量操作报 url 非法。

const URL_WRAP_PAIRS = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['［', '］'],
  ['{', '}'],
  ['<', '>'],
  ['《', '》'],
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
]

const INVISIBLE_CHARS = /[\s\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]+/g
const TRAILING_NOISE = /[)\]）\]］}>》〉」』】”’"'，。、；;：:！!？?…]+$/

function cleanZhihuUrlText(url) {
  if (!url) return url
  let clean = String(url)
  // Markdown 链接 [任意文本](https://…)：直接取真实地址
  const markdown = clean.match(/\]\(\s*(https?:\/\/[^)\s"'<>]+)\s*\)/i)
  if (markdown && /^\s*\[[\s\S]*\]\(\s*https?:/i.test(clean)) clean = markdown[1]
  // 去掉所有不可见字符（普通/全角空格、换行、制表、NBSP、零宽字符、BOM 等）
  clean = clean.replace(INVISIBLE_CHARS, '')
  // 剥掉复制时带入的成对包裹符号（可嵌套）
  let changed = true
  while (changed && clean) {
    changed = false
    for (const [open, close] of URL_WRAP_PAIRS) {
      if (clean.startsWith(open) && clean.endsWith(close)) {
        clean = clean.slice(open.length, clean.length - close.length)
        changed = true
        break
      }
    }
  }
  // 去掉行尾容易混入的正文标点/闭合符
  clean = clean.replace(TRAILING_NOISE, '')
  return clean
}

export function cleanZhihuAnswerUrl(url) {
  if (!url) return url
  const clean = cleanZhihuUrlText(url)
  const q = clean.indexOf('?')
  return q > -1 ? clean.slice(0, q) : clean
}

// 与数据库 keyflow_normalize_zhihu_url 规则保持一致：
// 去 query/#、去尾部斜杠、补 www、API 地址转公开地址、去掉答案链接后缀。
export function normalizeZhihuUrl(url) {
  if (!url) return url
  const clean = cleanZhihuUrlText(url).split('#')[0].split('?')[0].replace(/\/+$/, '')
  if (!clean) return clean
  return clean
    .replace(/^https?:\/\/zhihu\.com\//i, 'https://www.zhihu.com/')
    .replace(/^https?:\/\/www\.zhihu\.com\/api\/v4\/questions\/(\d+)$/i, 'https://www.zhihu.com/question/$1')
    .replace(/\/api\/v4\/questions\/(\d+)\/?$/i, '/question/$1')
    .replace(/\/answer(s)?\/\d+$/i, '')
}

export function publicZhihuQuestionUrl(url) {
  const cleanUrl = cleanZhihuAnswerUrl(url)
  if (!cleanUrl) return cleanUrl
  return cleanUrl.replace(/\/api\/v4\/questions\/(\d+)\/?$/, '/question/$1')
}

export function getZhihuQuestionId(url) {
  const cleanUrl = cleanZhihuAnswerUrl(url)
  const matched = cleanUrl?.match(/https?:\/\/(?:www\.)?zhihu\.com\/(?:question|api\/v4\/questions)\/(\d+)(?:\/|$)/i)
  return matched?.[1] || null
}