/**
 * 极简 SKILL.md frontmatter 解析器（零依赖）。
 *
 * 只解析我们真正需要的顶层键：name / description / whenToUse /
 * disable-model-invocation / user-invocable / metadata。
 * 支持 YAML 的三种常见标量写法：
 *   key: 普通值            （含行内 # 注释会被剥掉）
 *   key: "带引号的值"        （支持 \" \n \\ 转义）
 *   key: >  或  key: |      （块标量，> 折叠成空格，| 保留换行）
 * 缩进的嵌套结构（metadata: 下面那几行）一律跳过，不参与解析。
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * 把 SKILL.md 拆成 frontmatter 文本与正文。
 * @param {string} raw - 文件原文。
 * @returns {{ frontmatter: string | undefined, body: string }}
 */
export function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/u, '')
  const match = FRONTMATTER.exec(text)
  if (match === null) return { frontmatter: undefined, body: text }
  return { frontmatter: match[1], body: text.slice(match[0].length) }
}

/**
 * 解析 frontmatter 文本里的顶层键。
 * @param {string | undefined} frontmatter - 不含 `---` 行的 frontmatter 文本。
 * @returns {Record<string, string>} 键 -> 字符串值（块标量已合并）。
 */
export function parseFrontmatter(frontmatter) {
  /** @type {Record<string, string>} */
  const out = {}
  if (typeof frontmatter !== 'string') return out
  const lines = frontmatter.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s/u.test(line) || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (key === '') continue
    const rest = line.slice(separator + 1).trim()

    // 块标量：key: >  或 key: |  或 key: >-  等等
    if (/^[|>][-+]?\d*$/u.test(rest)) {
      const folded = rest.startsWith('>')
      const chunk = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]
        if (next.trim() !== '' && !/^\s/u.test(next)) break
        chunk.push(next.replace(/^\s{1,}/u, ''))
      }
      while (chunk.length > 0 && chunk[chunk.length - 1].trim() === '') chunk.pop()
      index = cursor - 1
      out[key] = folded ? chunk.join(' ').replace(/\s+/gu, ' ').trim() : chunk.join('\n')
      continue
    }

    out[key] = unquote(rest)
  }
  return out
}

/**
 * 去掉一层引号并处理基本转义；未加引号时剥掉行尾注释。
 * @param {string} value - 原始值文本。
 * @returns {string}
 */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\n/gu, '\n')
      .replace(/\\t/gu, '\t')
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/gu, "'")
  }
  const comment = /\s#/u.exec(text)
  return (comment === null ? text : text.slice(0, comment.index)).trim()
}

/**
 * 严格解析 YAML 布尔写法；无法判定时返回 undefined。
 * 与 DSH 的 dsh-skill-filesystem 使用同一套文法。
 * @param {string | undefined} value - 待解析文本。
 * @returns {boolean | undefined}
 */
export function parseBoolean(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

/**
 * 解析一份 SKILL.md，产出 skill 元数据与正文。
 * @param {string} raw - 文件原文。
 * @returns {{
 *   name: string | undefined,
 *   description: string | undefined,
 *   whenToUse: string | undefined,
 *   modelInvocable: boolean | undefined,
 *   userInvocable: boolean | undefined,
 *   metadata: Record<string, unknown> | undefined,
 *   body: string,
 *   hasFrontmatter: boolean,
 * }}
 */
export function parseSkillDocument(raw) {
  const { frontmatter, body } = splitFrontmatter(raw)
  const attributes = parseFrontmatter(frontmatter)
  const reserved = new Set([
    'name',
    'description',
    'whenToUse',
    'disable-model-invocation',
    'user-invocable',
  ])
  const metadata = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (reserved.has(key)) continue
    metadata[key] = value
  }
  return {
    name: attributes.name,
    description: attributes.description,
    whenToUse: attributes.whenToUse,
    modelInvocable: parseBoolean(attributes['disable-model-invocation']) === true ? false : undefined,
    userInvocable: parseBoolean(attributes['user-invocable']) === false ? false : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    body: body.trim(),
    hasFrontmatter: frontmatter !== undefined,
  }
}
