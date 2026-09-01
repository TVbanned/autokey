export const ZHIHU_CSV_HEADERS = [
  '问题标题',
  '提问者token(留空自动补充智子账号)',
  '话题名(多个使用、分割，留空系统自动补充)',
  '问题描述',
  '邀请类型',
  '期望话题数',
]

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function parseClipboardGrid(text) {
  const lines = String(text || '').split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.map((line) => line.split('\t'))
}

export function parsePastedTitles(text) {
  const titles = []
  const seen = new Set()
  const lines = String(text || '').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let title = line
    const urlMatch = line.match(/https?:\/\/[^\s]+/i)
    if (urlMatch) {
      const before = line.slice(0, urlMatch.index).trim()
      if (!before) continue
      title = before
    }
    title = title.replace(/\s*-\s*知乎\s*$/i, '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    const key = title.toLocaleLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      titles.push(title)
    }
  }
  return titles
}

export function buildZhihuCsv(rows) {
  const headers = ZHIHU_CSV_HEADERS.map(csvCell).join(',')
  const lines = rows.map((row) => [
    row.title,
    row.token,
    row.topics,
    row.description,
    row.inviteType,
    row.expectedTopics,
  ].map(csvCell).join(','))
  return [headers, ...lines].join('\r\n')
}
