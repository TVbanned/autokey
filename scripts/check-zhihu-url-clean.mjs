// 知乎链接清洗自检：node scripts/check-zhihu-url-clean.mjs
import { cleanZhihuAnswerUrl, normalizeZhihuUrl, publicZhihuQuestionUrl } from '../src/zhihuUrl.js'

const cases = [
  ['http 前多一个空格', cleanZhihuAnswerUrl, ' http://www.zhihu.com/question/123/answer/456?share=1', 'http://www.zhihu.com/question/123/answer/456'],
  ['全角空格开头', cleanZhihuAnswerUrl, '\u3000http://www.zhihu.com/question/123/answer/456', 'http://www.zhihu.com/question/123/answer/456'],
  ['换行/制表混入', cleanZhihuAnswerUrl, '\t\nhttp://www.zhihu.com/question/123/answer/456', 'http://www.zhihu.com/question/123/answer/456'],
  ['中文引号包裹', cleanZhihuAnswerUrl, '\u201chttp://www.zhihu.com/question/123/answer/456\u201d', 'http://www.zhihu.com/question/123/answer/456'],
  ['Markdown 链接语法', cleanZhihuAnswerUrl, '[作品标题](http://www.zhihu.com/question/123/answer/456)', 'http://www.zhihu.com/question/123/answer/456'],
  ['行尾中文句号', cleanZhihuAnswerUrl, 'http://www.zhihu.com/question/123/answer/456\u3002', 'http://www.zhihu.com/question/123/answer/456'],
  ['normalize API 地址转公开地址', normalizeZhihuUrl, ' http://zhihu.com/api/v4/questions/123 ', 'https://www.zhihu.com/question/123'],
  ['normalize 答案链接转问题链接', normalizeZhihuUrl, 'https://www.zhihu.com/question/123/answer/456?x=1', 'https://www.zhihu.com/question/123'],
  ['publicZhihuQuestionUrl 转换', publicZhihuQuestionUrl, 'https://www.zhihu.com/api/v4/questions/123', 'https://www.zhihu.com/question/123'],
  ['纯空格输入返回空串', cleanZhihuAnswerUrl, '  \u3000 ', ''],
]

let failed = 0
for (const [name, fn, input, expected] of cases) {
  const actual = fn(input)
  if (actual !== expected) {
    console.error(`FAIL ${name}: ${JSON.stringify(input)} -> ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
    failed += 1
  }
}
if (failed) {
  console.error(`${failed} case(s) failed`)
  process.exit(1)
}
console.log(`zhihu URL cleaning OK (${cases.length} cases)`)