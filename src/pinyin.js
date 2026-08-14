// 拼音首字母查询：使用 pinyin-pro 提供完整汉字首字母映射，替代此前手写的不完整字符表
import { pinyin } from 'pinyin-pro'

/**
 * 取字符串的拼音首字母
 * 例如: getPinyinInitials('灰域信风') → 'hyxf'
 *       非中文字符保留原样（统一转小写）
 */
export function getPinyinInitials(str) {
  return pinyin(str, { pattern: 'first', type: 'array' }).join('').toLowerCase()
}

/**
 * 检查搜索关键词是否匹配中文名称（支持拼音首字母）
 * @param {string} name - 中文名称
 * @param {string} keyword - 搜索关键词
 */
export function matchesSearch(name, keyword) {
  const kw = keyword.toLowerCase().trim()
  if (!kw) return true
  // 直接名称匹配
  if (name.toLowerCase().includes(kw)) return true
  // 拼音首字母匹配（仅当关键词全为字母时生效，避免中文输入中途误匹配）
  if (/^[a-z]+$/.test(kw)) {
    return getPinyinInitials(name).includes(kw)
  }
  return false
}
