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
const excludedTerms = /直播带货|明星|演员|电视剧|综艺|票房|博彩|赌场|攻略|配装|社区 ::|Steam 社区 ::|抽奖|福利|送游戏|送激活码|免费领取|抢码|review|hands-on|preview|opinion|interview|feature|guide|what are we playing|输入法|大模型|AI服务|AI产品|AI助手|智能助手|语音助手|浏览器|操作系统|智能手机|手机发布|新手机|平板电脑|笔记本电脑|网剧|剧集|导演|歌手|演唱会|家电|无人机|加密货币|比特币/i
const trustedPublishers = /游民星空|3DM|机核|GCORES|游研社|触乐|游戏葡萄|IGN中国|IGN|GameSpot|Polygon|Eurogamer|Kotaku|VGC|Game Informer|PlayStation Blog|Xbox Wire|Nintendo|Epic Games|腾讯游戏|网易游戏|TapTap|篝火营地|新浪游戏|GamesIndustry.biz|PC Gamer|Rock Paper Shotgun/i
const gameTerms = /游戏|玩家|Steam|PS4|PS5|PlayStation|Xbox|Switch|任天堂|Nintendo|DLC|RPG|电竞|电子竞技|手游|主机|卡普空|Capcom|育碧|Ubisoft|暴雪|Blizzard|索尼|Sony|Square Enix|FromSoftware|GTA|英雄联盟|原神|赛博朋克|黑神话|塞尔达|怪物猎人|宝可梦|Pokémon|Pokemon|米哈游|腾讯游戏|网易游戏|Valve|Riot|Bethesda|Fortnite|Minecraft|科隆游戏展|东京电玩展|gamescom|TGS|ChinaJoy|E3|State of Play|直面会|游戏展|游戏大奖|The Game Awards|TGA|Epic|Playdate|game|gaming|艾尔登法环|Elden Ring|博德之门|Baldur's Gate|暗黑破坏神|Diablo|最终幻想|Final Fantasy|荒野大镖客|Red Dead|巫师|Witcher|生化危机|Resident Evil|刺客信条|Assassin's Creed|使命召唤|Call of Duty|战地|Battlefield|光环|Halo|战神|God of War|马里奥|Mario|动物森友会|Animal Crossing|双人成行|It Takes Two|星露谷物语|Stardew Valley|空洞骑士|Hollow Knight|死亡搁浅|Death Stranding|只狼|Sekiro|上古卷轴|Elder Scrolls|辐射|Fallout|侠盗猎车手|Grand Theft Auto|地铁|Metro|孤岛惊魂|Far Cry|看门狗|Watch Dogs|绝地求生|PUBG|无畏契约|Valorant|守望先锋|Overwatch|炉石传说|Hearthstone|魔兽世界|World of Warcraft|星际争霸|StarCraft|Warframe|命运2|Destiny 2|王者荣耀|和平精英|崩坏|明日方舟|星穹铁道|绝区零|鸣潮|幻塔|蛋仔派对|光遇|第五人格|鹰角|库洛|叠纸|完美世界|西山居|莉莉丝|肉鸽|Roguelike|Roguelite|魂系|Soulslike|开放世界|沙盒|MOBA|FPS|大逃杀|吃鸡|MMO|视觉小说|音游|格斗游戏|RTS|模拟经营|云游戏|新游|Game Pass|PSN/i
const gameContextTerms = /游戏|玩家|Steam|PS4|PS5|PlayStation|Xbox|Switch|任天堂|Nintendo|DLC|RPG|电竞|手游|主机|试玩|实机|发售|更新|补丁|预告|演示|测试|联动|版本|资料片|重制|移植|跳票|延期|推迟|工作室|开发商|发行商|销量|获奖|上线|登陆|登录|评测|游戏展|直面会|发布会|宣传片|预告片|截图|MOD|联机|多人|单机|独占|平台|试玩版|demo|beta/i

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
// 游戏站点也会发布科技/影视等非游戏新闻，站点内搜索命中的条目须与游戏相关才收录
const isGameRelated = (title, summary) => gameTerms.test(title) || (/《[^》]{2,}》/.test(title) && gameContextTerms.test(`${title} ${summary}`))

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
    return { source: itemSource, publisher: news.source || itemSource, title, url: news.link || '', summary, publishedAt: news.date || '', image: news.imageUrl || '', tags: tagsFor(title, summary), fromSearch: true, gameSignal: isGameRelated(title, summary) }
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

async function verifyGameRelevance(items) {
  const targets = items.filter(item => item.fromSearch && !item.gameSignal)
  if (!targets.length) return { items, checked: 0, status: 'no-targets' }
  const apiKey = config.deepseekApiKey
  if (!apiKey) return { items: items.filter(item => !item.fromSearch || item.gameSignal), checked: 0, status: 'missing-key' }
  const CHUNK_SIZE = 10
  const keep = new Set()
  let checked = 0
  let failures = 0
  for (let offset = 0; offset < targets.length; offset += CHUNK_SIZE) {
    const chunk = targets.slice(offset, offset + CHUNK_SIZE)
    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', temperature: 0, max_tokens: 800, messages: [{ role: 'system', content: '你是专业游戏新闻编辑。判断每条新闻是否与电子游戏或游戏行业相关：游戏发售/更新/DLC/评测/电竞/厂商动态/游戏硬件等算相关；输入法、AI产品、手机、影视、汽车、财经等与游戏无关的科技或娱乐新闻不算。只返回 JSON 对象，格式：{"results":[{"index":0,"isGame":true}]}。' }, { role: 'user', content: JSON.stringify(chunk.map((item, index) => ({ index, title: item.title, summary: (item.summary || "").slice(0, 250) }))) }] }), signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`DeepSeek relevance failed (${response.status})`)
      const payload = await response.json()
      const content = String(payload.choices?.[0]?.message?.content || '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')
      const parsed = JSON.parse(content)
      const results = Array.isArray(parsed) ? parsed : (parsed.results || [])
      for (const result of results) {
        const index = Number(result.index)
        const item = Number.isInteger(index) ? chunk[index] : undefined
        if (item && result.isGame === true) keep.add(item.url)
      }
      checked += chunk.length
    } catch (error) {
      failures += 1
      console.error(`relevance check failed: ${error.message}`)
    }
  }
  const verified = items.filter(item => !item.fromSearch || item.gameSignal || keep.has(item.url))
  return { items: verified, checked, status: failures ? 'partial' : 'ok' }
}

const settled = await Promise.allSettled([...rssFeeds.map(fetchRss), ...searches.map(searchNews)])
const unavailableSourceCount = settled.filter(result => result.status === 'rejected').length
const seen = new Set()
const candidates = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []).filter(item => !seen.has(item.url) && seen.add(item.url))
// AI 相关性校验：站点搜索来源里关键词未命中的条目，交给模型二次判断是否与游戏相关
const relevance = await verifyGameRelevance(candidates)
const gameItems = relevance.items
// 统计同一事件被多少不同来源报道，作为真实热度近似值
const reportCounts = new Map()
for (const item of gameItems) reportCounts.set(signatureOf(item.title), (reportCounts.get(signatureOf(item.title)) || 0) + 1)
// 关键词碰撞：统计每个显著关键词被多少不同来源提及
const tokenSources = new Map()
for (const item of gameItems) {
  for (const token of tokensOf(item.title)) {
    const set = tokenSources.get(token) || new Set()
    set.add(item.publisher || item.source)
    tokenSources.set(token, set)
  }
}
const hotWords = await fetchHotWords()
const picked = selectTop20(deduplicate(gameItems, reportCounts, tokenSources, hotWords)).map((item, index) => ({ ...item, rank: index + 1, heat: score(item, reportCounts, tokenSources, hotWords) }))
const items = await translate(await enrichImages(picked))
if (!items.length) throw new Error('No high-quality game news')
const payload = { success: true, updatedAt: new Date().toISOString(), items, sources: [...new Set(items.map(item => item.source))], unavailableSourceCount }
await writeFile(`${output}.tmp`, JSON.stringify(payload), 'utf8')
await rename(`${output}.tmp`, output)
console.log(`Updated ${items.length} hotspots from ${payload.sources.length} sources`)
