import { readFile, rename, writeFile } from 'node:fs/promises'

const config = JSON.parse(await readFile(process.env.HOTSPOTS_CONFIG || '/etc/autokey-hotspots.json', 'utf8'))
const output = process.env.HOTSPOTS_OUTPUT || '/www/wwwroot/39.96.61.144/AutokeyProject/app/hotspots.json'
const rssFeeds = [
  ['机核', 'https://www.gcores.com/rss'],
  ['PC Gamer', 'https://www.pcgamer.com/rss/'],
  ['GamesIndustry.biz', 'https://www.gamesindustry.biz/feed'],
  ['Rock Paper Shotgun', 'https://www.rockpapershotgun.com/feed'],
  ['Eurogamer', 'https://www.eurogamer.net/feed'],
  ['VGC', 'https://www.videogameschronicle.com/feed/'],
  ['Game Informer', 'https://www.gameinformer.com/rss.xml'],
]
const searches = [
  ['游民星空', 'site:gamersky.com/news 游戏 公布 OR 发售 OR 更新 OR 预告'],
  ['3DM', 'site:3dmgame.com/news 游戏 公布 OR 发售 OR 更新 OR 预告'],
  ['Google 新闻', '游戏 新闻 发布 公布 发售 更新'],
]
const eventTerms = /宣布|官宣|公布|发布|上线|发售|定档|预告|实机|更新|补丁|扩展|DLC|停售|收购|裁员|关闭|重启|测试|试玩|登陆|加入|确认|曝光|泄露|改版|联动|获奖|销量|突破|announces?|reveals?|launches?|releases?|delayed|delay|acquires?|acquisition|layoffs?|shuts? down|closure|update|patch|expansion|trailer|date|confirmed|sales|million|beta|early access/i
const excludedTerms = /直播带货|明星|演员|电视剧|综艺|电影票房|博彩|赌场|攻略|配装|社区 ::|Steam 社区 ::|review|hands-on|preview|opinion|interview|feature|guide|what are we playing/i
const trustedPublishers = /游民星空|3DM|机核|GCORES|游研社|触乐|IGN|GameSpot|Polygon|Eurogamer|Kotaku|VGC|Game Informer|PlayStation Blog|Xbox Wire|Nintendo|Epic Games|腾讯游戏|网易游戏|TapTap|篝火营地|GamesIndustry.biz|PC Gamer|Rock Paper Shotgun/i

const decode = (text = '') => text.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/\s+/g, ' ').trim()
const field = (entry, name) => decode(entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '')
const hoursAgo = (date = '') => {
  const relative = date.match(/(\d+)\s*(minute|min|hour|day|分钟|小时|天)/i)
  if (relative) return /minute|min|分钟/i.test(relative[2]) ? Number(relative[1]) / 60 : /hour|小时/i.test(relative[2]) ? Number(relative[1]) : Number(relative[1]) * 24
  const value = Date.parse(date)
  return Number.isFinite(value) ? Math.max(0, (Date.now() - value) / 3600000) : 999
}
const isChineseSource = source => /游民星空|3DM|机核|GCORES|游研社|触乐|腾讯游戏|网易游戏|TapTap|篝火营地/.test(source)
const tagsFor = (source, title, summary) => {
  const text = `${title} ${summary}`
  const tags = [isChineseSource(source) ? '国内' : '海外']
  if (/收购|裁员|关闭|停售|acquisition|layoffs?|shuts? down|closure/i.test(text)) tags.push('行业动态')
  else if (/发售|上线|launches?|releases?|early access|date/i.test(text)) tags.push('发售节点')
  else if (/DLC|扩展|更新|补丁|update|patch|expansion/i.test(text)) tags.push('版本更新')
  else if (/预告|实机|公布|宣布|reveals?|announces?|trailer|gameplay/i.test(text)) tags.push('新品公布')
  else if (/测试|试玩|beta|playtest/i.test(text)) tags.push('测试体验')
  if (/PlayStation|PS[45+]?|Xbox|Switch|任天堂|Steam|主机|platform/i.test(text)) tags.push('平台动态')
  if (/销量|获奖|突破|sales|million|award/i.test(text)) tags.push('市场表现')
  return tags.slice(0, 3)
}
const score = item => Math.round((eventTerms.test(item.title) ? 30 : 0) + (trustedPublishers.test(item.source) ? 20 : 0) + Math.max(0, 50 - hoursAgo(item.publishedAt) / 2))
const valid = (title, summary) => eventTerms.test(title) && !excludedTerms.test(`${title} ${summary}`)

async function fetchRss([source, url]) {
  const response = await fetch(url, { headers: { 'user-agent': 'GameJourneyHotspots/1.0' }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${source}: ${response.status}`)
  const xml = await response.text()
  return (xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) || []).slice(0, 25).map(entry => {
    const title = field(entry, 'title')
    const url = entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || field(entry, 'link')
    const summary = field(entry, 'description') || field(entry, 'summary') || field(entry, 'content')
    const publishedAt = field(entry, 'pubDate') || field(entry, 'published') || field(entry, 'updated')
    return { source, publisher: source, title, url: url.replace(/&amp;/g, '&'), summary, publishedAt, tags: tagsFor(source, title, summary) }
  }).filter(item => item.url.startsWith('http') && item.title.length >= 8 && hoursAgo(item.publishedAt) <= 168 && valid(item.title, item.summary))
}

async function searchNews([source, query]) {
  const response = await fetch('https://google.serper.dev/news', { method: 'POST', headers: { 'x-api-key': config.serperApiKey, 'content-type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn', tbs: 'qdr:d', num: 20 }), signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${source}: ${response.status}`)
  const data = await response.json()
  return (data.news || []).map(news => {
    const title = decode(news.title)
    const itemSource = source === 'Google 新闻' ? (news.source || source) : source
    const summary = decode(news.snippet || '')
    return { source: itemSource, publisher: news.source || itemSource, title, url: news.link || '', summary, publishedAt: news.date || '', tags: tagsFor(itemSource, title, summary) }
  }).filter(item => item.url.startsWith('http') && item.title.length >= 8 && hoursAgo(item.publishedAt) <= 72 && valid(item.title, item.summary) && (source !== 'Google 新闻' || trustedPublishers.test(item.publisher)))
}

function deduplicate(items) {
  const saved = []
  for (const item of [...items].sort((a, b) => score(b) - score(a))) {
    const signature = item.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const duplicate = saved.findIndex(other => {
      const target = other.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      return signature === target || (signature.length > 12 && target.length > 12 && (signature.includes(target) || target.includes(signature)))
    })
    if (duplicate === -1) saved.push(item)
  }
  return saved
}
function selectTop20(items) {
  const result = [], later = [], counts = new Map()
  for (const item of items) {
    const count = counts.get(item.source) || 0
    if (count >= 2) later.push(item)
    else { counts.set(item.source, count + 1); result.push(item) }
    if (result.length === 20) return result
  }
  return [...result, ...later].slice(0, 20)
}
async function translate(items) {
  const targets = items.filter(item => !/[\u4e00-\u9fff]/.test(item.title))
  if (!targets.length) return items
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${config.deepseekApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4-flash', temperature: 0.1, max_tokens: 6000, messages: [{ role: 'system', content: '你是专业游戏新闻编辑。将英文游戏新闻标题和摘要准确翻译成简体中文，保留游戏名、公司名、平台名、DLC、版本号等专有名词。只返回 JSON 对象，包含 translations 数组，每项有 index、title、summary 字段。' }, { role: 'user', content: JSON.stringify(targets.map((item, index) => ({ index, title: item.title, summary: item.summary.slice(0, 250) }))) } ] }), signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`DeepSeek: ${response.status}`)
  const payload = await response.json()
  const content = String(payload.choices?.[0]?.message?.content || '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')
  const translations = JSON.parse(content).translations || []
  for (const translation of translations) {
    const item = targets[translation.index]
    if (item && /[\u4e00-\u9fff]/.test(translation.title || '')) { item.title = decode(translation.title); item.summary = decode(translation.summary || item.summary); item.tags = tagsFor(item.source, item.title, item.summary) }
  }
  return items
}

const settled = await Promise.allSettled([...rssFeeds.map(fetchRss), ...searches.map(searchNews)])
const unavailableSourceCount = settled.filter(result => result.status === 'rejected').length
const seen = new Set()
const candidates = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).filter(item => !seen.has(item.url) && seen.add(item.url))
const items = await translate(selectTop20(deduplicate(candidates))).then(list => list.map((item, index) => ({ ...item, rank: index + 1, heat: score(item) })))
if (!items.length) throw new Error('No high-quality game news')
const payload = { success: true, updatedAt: new Date().toISOString(), items, sources: [...new Set(items.map(item => item.source))], unavailableSourceCount }
await writeFile(`${output}.tmp`, JSON.stringify(payload), 'utf8')
await rename(`${output}.tmp`, output)
console.log(`Updated ${items.length} hotspots from ${payload.sources.length} sources`)
