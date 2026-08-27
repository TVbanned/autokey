import { readFile, rename, writeFile } from 'node:fs/promises'

const config = JSON.parse(await readFile(process.env.HOTSPOTS_CONFIG || '/etc/autokey-hotspots.json', 'utf8'))
const output = process.env.HOTSPOTS_OUTPUT || '/www/wwwroot/39.96.61.144/AutokeyProject/hotspots/hotspots.json'
const rssFeeds = [
  ['机核', 'https://www.gcores.com/rss'],
  ['IGN中国', 'https://cn.ign.com/rss'],
  ['PC Gamer', 'https://www.pcgamer.com/rss/'],
  ['GamesIndustry.biz', 'https://www.gamesindustry.biz/feed'],
  ['Rock Paper Shotgun', 'https://www.rockpapershotgun.com/feed'],
  ['Eurogamer', 'https://www.eurogamer.net/feed'],
  ['VGC', 'https://www.videogameschronicle.com/feed/'],
  ['Game Informer', 'https://www.gameinformer.com/rss.xml'],
]
const searches = [
  ['游民星空', 'site:gamersky.com 游戏'],
  ['3DM', 'site:3dmgame.com 游戏'],
  ['Google 新闻', '游戏 公布 发售 更新 预告'],
]
const eventTerms = /宣布|官宣|公布|发布|上线|发售|定档|预告|实机|更新|补丁|扩展|DLC|停售|收购|裁员|关闭|重启|测试|试玩|登陆|加入|确认|曝光|泄露|改版|联动|获奖|销量|突破|announces?|reveals?|launches?|releases?|delayed|delay|acquires?|acquisition|layoffs?|shuts? down|closure|update|patch|expansion|trailer|date|confirmed|sales|million|beta|early access/i
const excludedTerms = /直播带货|明星|演员|电视剧|综艺|电影票房|博彩|赌场|攻略|配装|社区 ::|Steam 社区 ::|抽奖|福利|送游戏|送激活码|免费领取|抢码|review|hands-on|preview|opinion|interview|feature|guide|what are we playing/i
const trustedPublishers = /游民星空|3DM|机核|GCORES|游研社|触乐|游戏葡萄|IGN中国|IGN|GameSpot|Polygon|Eurogamer|Kotaku|VGC|Game Informer|PlayStation Blog|Xbox Wire|Nintendo|Epic Games|腾讯游戏|网易游戏|TapTap|篝火营地|新浪游戏|GamesIndustry.biz|PC Gamer|Rock Paper Shotgun/i

const decode = (text = '') => text.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const cleanSummary = text => decode(text).replace(/在\[[^\]]*\]搜索|相关链接|分享到|更多内容|热门推荐|关注我们|阅读原文|阅读全文|查看原文|查看全文/g, ' ').replace(/\s+/g, ' ').trim()
const field = (entry, name) => decode(entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '')
const hoursAgo = (date = '') => {
  const relative = date.match(/(\d+)\s*(minute|min|hour|day|分钟|小时|天)/i)
  if (relative) return /minute|min|分钟/i.test(relative[2]) ? Number(relative[1]) / 60 : /hour|小时/i.test(relative[2]) ? Number(relative[1]) : Number(relative[1]) * 24
  const value = Date.parse(date)
  return Number.isFinite(value) ? Math.max(0, (Date.now() - value) / 3600000) : 999
}
const isChineseSource = source => /游民星空|3DM|机核|GCORES|游研社|触乐|IGN中国|腾讯游戏|网易游戏|TapTap|篝火营地/.test(source)
const tagsFor = (title, summary) => {
  const text = `${title} ${summary}`
  const tags = []
  for (const game of title.match(/《([^》]+)》/g) || []) tags.push(`#${game.replace(/[《》]/g, '')}`)
  if (/预告|宣传片|实机演示|trailer|gameplay/i.test(text)) tags.push('#宣传片')
  else if (/预购|预售|pre-?order/i.test(text)) tags.push('#预购')
  else if (/发售|上线|上市|定档|launch|release|early access/i.test(text)) tags.push('#发售')
  else if (/DLC|扩展|资料片|更新|补丁|重制|remake|remaster|update|patch|expansion/i.test(text)) tags.push('#版本更新')
  else if (/收购|裁员|关闭|停售|离职|acquisition|layoffs?|closure/i.test(text)) tags.push('#行业动态')
  else if (/测试|试玩|封测|beta|playtest/i.test(text)) tags.push('#测试体验')
  else if (/公布|宣布|曝光|泄露|reveals?|announces?|leak/i.test(text)) tags.push('#新品公布')
  if (/PlayStation|PS5|PS4/i.test(text)) tags.push('#PlayStation')
  else if (/Xbox/i.test(text)) tags.push('#Xbox')
  else if (/Switch|任天堂|Nintendo/i.test(text)) tags.push('#任天堂')
  else if (/Steam|\bPC\b/i.test(text)) tags.push('#PC')
  return [...new Set(tags)].slice(0, 4)
}
const signatureOf = title => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const stopTokens = /公布|发布|宣布|上线|发售|更新|预告|实机|测试|全新|正式|即将|公开|曝光|确认|泄露|的|了|在|与|和|及|将|已|等|推出|开启|游戏|玩家|官方|the|a|an|and|for|with|from|its|new|first|has|have|into|after|says|more|this|that|you|your|will|can|out|all|get|gets|here|what|when|where|how|about/i
const tokensOf = title => [...new Set(title.replace(/《([^》]+)》/g, ' $1 ').replace(/[^\p{L}\p{N} ]/gu, ' ').toLowerCase().split(/\s+/).filter(t => t.length >= 3 && !stopTokens.test(t)))]
async function fetchHotWords() {
  const words = new Set()
  const grab = async (url, parse) => {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' }, signal: AbortSignal.timeout(8000) })
      if (!response.ok) return
      const data = await response.json()
      for (const word of parse(data)) if (word && word.length >= 2) words.add(word)
    } catch { /* 热榜抓取失败不影响榜单 */ }
  }
  await Promise.all([
    grab('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', d => (d.data || []).map(item => item.Title)),
    grab('https://api.bilibili.com/x/web-interface/search/square?limit=50', d => (d.data?.trending?.list || []).map(item => item.keyword)),
  ])
  return [...words]
}
const score = (item, reportCounts = new Map(), tokenSources = new Map(), hotWords = []) => {
  const reportCount = reportCounts.get(signatureOf(item.title)) || 1
  let collision = 0
  for (const token of tokensOf(item.title)) collision += (tokenSources.get(token)?.size || 1) - 1
  const hotText = `${item.title} ${item.summary}`
  const hotHit = hotWords.filter(word => hotText.includes(word)).length
  return Math.round((eventTerms.test(item.title) ? 30 : 0) + (trustedPublishers.test(item.source) ? 20 : 0) + (isChineseSource(item.source) ? 25 : 0) + Math.min(24, (reportCount - 1) * 12) + Math.min(30, collision * 3) + Math.min(40, hotHit * 15) + Math.max(0, 50 - hoursAgo(item.publishedAt) / 2))
}
const valid = (title, summary) => eventTerms.test(title) && !excludedTerms.test(`${title} ${summary}`)

async function fetchRss([source, url]) {
  const response = await fetch(url, { headers: { 'user-agent': 'GameJourneyHotspots/1.0' }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${source}: ${response.status}`)
  const xml = await response.text()
  return (xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) || []).slice(0, 25).map(entry => {
    const title = field(entry, 'title')
    const itemUrl = entry.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] || field(entry, 'link')
    const summary = cleanSummary(field(entry, 'description') || field(entry, 'summary') || field(entry, 'content'))
    const publishedAt = field(entry, 'pubDate') || field(entry, 'published') || field(entry, 'updated')
    const descriptionRaw = entry.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || ''
    const imageRaw = entry.match(/<enclosure[^>]*url=["']([^"']+)["']/i)?.[1] || entry.match(/<media:content[^>]*url=["']([^"']+)["']/i)?.[1] || entry.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i)?.[1] || (descriptionRaw.match(/<img[^>]*src=["']([^"']+)["']/i)?.[1] || '')
    const image = imageRaw ? (() => { try { return new URL(imageRaw, url).href } catch { return imageRaw.startsWith('http') ? imageRaw : '' } })() : ''
    return { source, publisher: source, title, url: itemUrl.replace(/&amp;/g, '&'), summary, publishedAt, image, tags: tagsFor(title, summary) }
  }).filter(item => item.url.startsWith('http') && item.title.length >= 8 && hoursAgo(item.publishedAt) <= 168 && valid(item.title, item.summary))
}

async function searchNews([source, query]) {
  const response = await fetch('https://google.serper.dev/news', { method: 'POST', headers: { 'x-api-key': config.serperApiKey, 'content-type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn', tbs: 'qdr:d', num: 10 }), signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${source}: ${response.status}`)
  const data = await response.json()
  return (data.news || []).map(news => {
    const title = decode(news.title)
    const itemSource = source === 'Google 新闻' ? (news.source || source) : source
    const summary = cleanSummary(news.snippet || '')
    return { source: itemSource, publisher: news.source || itemSource, title, url: news.link || '', summary, publishedAt: news.date || '', image: news.imageUrl || '', tags: tagsFor(title, summary) }
  }).filter(item => item.url.startsWith('http') && item.title.length >= 8 && hoursAgo(item.publishedAt) <= 72 && valid(item.title, item.summary) && (source !== 'Google 新闻' || trustedPublishers.test(item.publisher)))
}

function deduplicate(items, reportCounts, tokenSources, hotWords) {
  const saved = []
  for (const item of [...items].sort((a, b) => score(b, reportCounts, tokenSources, hotWords) - score(a, reportCounts, tokenSources, hotWords))) {
    const signature = signatureOf(item.title)
    const duplicate = saved.findIndex(other => {
      const target = signatureOf(other.title)
      return signature === target || (signature.length > 12 && target.length > 12 && (signature.includes(target) || target.includes(signature)))
    })
    if (duplicate === -1) saved.push(item)
  }
  return saved
}
function selectTop20(items) {
  const result = [], later = [], counts = new Map(), laterCounts = new Map()
  for (const item of items) {
    const count = counts.get(item.source) || 0
    if (count >= 2) later.push(item)
    else { counts.set(item.source, count + 1); result.push(item) }
    if (result.length === 20) return result
  }
  for (const item of later) {
    const count = laterCounts.get(item.source) || 0
    if (count >= 1) continue
    laterCounts.set(item.source, count + 1)
    result.push(item)
    if (result.length === 20) break
  }
  return result
}
async function enrichImages(items) {
  const missing = items.filter(item => !item.image)
  await Promise.all(missing.slice(0, 10).map(async item => {
    try {
      const response = await fetch(item.url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' }, signal: AbortSignal.timeout(8000), redirect: 'follow' })
      if (!response.ok) return
      const html = await response.text()
      const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1] || ''
      if (og.startsWith('http')) item.image = og
    } catch { /* 单条补图失败不影响榜单 */ }
  }))
  return items
}
async function translate(items) {
  const targets = items.filter(item => /[A-Za-z]{3,}/.test(item.title))
  if (!targets.length) return items
  // 分批翻译避免单次响应超长被截断
  const CHUNK_SIZE = 5
  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE)
    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${config.deepseekApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.1, max_tokens: 4000, messages: [{ role: 'system', content: '你是专业游戏新闻编辑。将新闻标题和摘要中出现的英文内容准确翻译成简体中文：游戏名、公司名、系列名、平台名一律翻译成国内通行译名（例如 Konami→科乐美、Silent Hill→《寂静岭》、Crimson Desert→《红色沙漠》、The Witcher 3→《巫师3》），标题中出现的英文必须全部翻译成中文，禁止保留英文原文，仅 DLC 代号、版本号等可保留。标题中已有的中文部分保持原样。只返回 JSON 对象，包含 translations 数组，每项有 index、title、summary 字段。' }, { role: 'user', content: JSON.stringify(chunk.map((item, index) => ({ index, title: item.title, summary: item.summary.slice(0, 180) }))) } ] }), signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`DeepSeek: ${response.status}`)
      const payload = await response.json()
      const content = String(payload.choices?.[0]?.message?.content || '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')
      const parsed = JSON.parse(content)
      const translations = Array.isArray(parsed) ? parsed : (parsed.translations || [])
      for (const translation of translations) {
        const item = chunk[translation.index]
        if (item && /[\u4e00-\u9fff]/.test(translation.title || '')) { item.title = decode(translation.title); item.summary = cleanSummary(translation.summary || item.summary); item.tags = tagsFor(item.title, item.summary) }
      }
    } catch (error) {
      // 翻译失败时保留原文，保证榜单仍能正常产出，等待下次定时任务重试
      console.error(`translate failed: ${error.message}`)
    }
  }
  return items
}

const settled = await Promise.allSettled([...rssFeeds.map(fetchRss), ...searches.map(searchNews)])
const unavailableSourceCount = settled.filter(result => result.status === 'rejected').length
const seen = new Set()
const candidates = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).filter(item => !seen.has(item.url) && seen.add(item.url))
// 统计同一事件被多少不同来源报道，作为真实热度近似值
const reportCounts = new Map()
for (const item of candidates) reportCounts.set(signatureOf(item.title), (reportCounts.get(signatureOf(item.title)) || 0) + 1)
// 关键词碰撞：统计每个显著关键词被多少不同来源提及
const tokenSources = new Map()
for (const item of candidates) {
  for (const token of tokensOf(item.title)) {
    const set = tokenSources.get(token) || new Set()
    set.add(item.publisher || item.source)
    tokenSources.set(token, set)
  }
}
const hotWords = await fetchHotWords()
const picked = selectTop20(deduplicate(candidates, reportCounts, tokenSources, hotWords)).map((item, index) => ({ ...item, rank: index + 1, heat: score(item, reportCounts, tokenSources, hotWords) }))
const items = await translate(await enrichImages(picked))
if (!items.length) throw new Error('No high-quality game news')
const payload = { success: true, updatedAt: new Date().toISOString(), items, sources: [...new Set(items.map(item => item.source))], unavailableSourceCount }
await writeFile(`${output}.tmp`, JSON.stringify(payload), 'utf8')
await rename(`${output}.tmp`, output)
console.log(`Updated ${items.length} hotspots from ${payload.sources.length} sources`)
