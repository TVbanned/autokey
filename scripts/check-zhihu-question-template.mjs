import assert from 'node:assert/strict'
import { buildZhihuCsv, parseClipboardGrid, parsePastedTitles } from '../src/zhihuQuestionCsv.js'

assert.deepEqual(
  parsePastedTitles('如何评价游戏 A？\n\n如何评价游戏 B？'),
  ['如何评价游戏 A？', '如何评价游戏 B？'],
)
assert.deepEqual(
  parsePastedTitles('如何评价游戏 A？ - 知乎\nhttps://www.zhihu.com/question/1'),
  ['如何评价游戏 A？'],
)
assert.deepEqual(parsePastedTitles('https://www.zhihu.com/question/1'), [])
assert.deepEqual(
  parsePastedTitles('问题一\n问题一\nhttps://www.zhihu.com/question/2\n问题二'),
  ['问题一', '问题二'],
)

assert.deepEqual(parseClipboardGrid('问题A\t游戏\t5\n问题B\t游戏\t5'), [['问题A', '游戏', '5'], ['问题B', '游戏', '5']])
assert.deepEqual(parseClipboardGrid('标题一\n标题二\n'), [['标题一'], ['标题二']])
assert.deepEqual(parseClipboardGrid(''), [['']])

const csv = buildZhihuCsv([
  { title: '含,逗号"引号', token: '', topics: '游戏', description: '第一行\n第二行', inviteType: '', expectedTopics: '5' },
])
assert.equal(
  csv,
  '问题标题,提问者token(留空自动补充智子账号),话题名(多个使用、分割，留空系统自动补充),问题描述,邀请类型,期望话题数\r\n"含,逗号""引号",,游戏,"第一行\n第二行",,5',
)

console.log('zhihu question template checks passed')
