/**
 * 扫描 skill 根目录，产出 DSH 技能注册表能接受的候选项。
 */

import fs from 'node:fs'
import path from 'node:path'

import { extractAsarPrefix } from './asar.js'
import { parseSkillDocument } from './frontmatter.js'

/** DSH 的技能名字法：kebab-case。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
/** app.asar 里引擎内置 skill 的归档路径。 */
export const ENGINE_SKILLS_PREFIX = '/electron/lib/engine/skills'
/** 递归扫描时跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build'])

/**
 * 安全列目录，失败返回空数组。
 * @param {string} dir - 目录。
 * @returns {import('node:fs').Dirent[]}
 */
function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 读取一个 skill 目录的 locales/*.json（MiMo 的 Plugins 页面显示元数据）。
 * @param {string} skillDir - skill 目录。
 * @returns {Record<string, { displayName?: string, brief?: string }> | undefined}
 */
function readLocales(skillDir) {
  const localeDir = path.join(skillDir, 'locales')
  const entries = readDir(localeDir).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  if (entries.length === 0) return undefined
  /** @type {Record<string, { displayName?: string, brief?: string }>} */
  const locales = {}
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(localeDir, entry.name), 'utf8'))
      const displayName = typeof parsed?.displayName === 'string' ? parsed.displayName : undefined
      const brief = typeof parsed?.brief === 'string' ? parsed.brief : undefined
      if (displayName === undefined && brief === undefined) continue
      locales[entry.name.replace(/\.json$/u, '')] = { displayName, brief }
    } catch {
      // 单个 locale 坏掉不影响 skill 本体
    }
  }
  return Object.keys(locales).length > 0 ? locales : undefined
}

/**
 * 从一份 SKILL.md 构造候选项；不合法时返回 undefined 并给出原因。
 * @param {object} input - 输入。
 * @param {string} input.file - SKILL.md 路径。
 * @param {string} input.skillDir - skill 的 base 目录（resourceBase）。
 * @param {string} input.fallbackName - frontmatter 缺 name 时的目录名/文件名。
 * @param {{ id: string, label: string, rank: number, source: string }} input.root - 所属根。
 * @returns {{ candidate: object | undefined, problem: string | undefined }}
 */
function buildCandidate({ file, skillDir, fallbackName, root }) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { candidate: undefined, problem: `读取失败：${error.message}` }
  }
  const document = parseSkillDocument(raw)
  const name = (document.name ?? fallbackName ?? '').trim()
  if (!SKILL_NAME.test(name)) {
    return { candidate: undefined, problem: `name「${name}」不是 kebab-case，已跳过` }
  }
  if (typeof document.description !== 'string' || document.description.trim() === '') {
    return { candidate: undefined, problem: `skill「${name}」缺少 description，已跳过` }
  }

  const locales = readLocales(skillDir)
  const metadata = {
    mimo: {
      rootId: root.id,
      rootLabel: root.label,
      source: file,
      ...(document.metadata === undefined ? {} : { frontmatter: document.metadata }),
      ...(locales === undefined ? {} : { locales }),
    },
  }

  return {
    candidate: {
      name,
      description: document.description.trim(),
      ...(typeof document.whenToUse === 'string' && document.whenToUse.trim() !== ''
        ? { whenToUse: document.whenToUse.trim() }
        : {}),
      invocation: {
        modelInvocable: document.modelInvocable !== false,
        userInvocable: document.userInvocable !== false,
      },
      source: root.source,
      rank: root.rank,
      path: file,
      resourceBase: { kind: 'directory', path: skillDir },
      locator: { file, skillDir, name },
      metadata,
    },
    problem: undefined,
  }
}

/**
 * 扫描一个根目录。
 *
 * 两种形态都认：目录包 `<name>/SKILL.md`，扁平文件 `<name>.md`。
 *
 * @param {object} input - 输入。
 * @param {{ id: string, label: string, dir: string, rank: number, source: string, depth?: number }} input.root - 根描述。
 * @param {(message: string) => void} [input.warn] - 警告回调。
 * @returns {{ candidates: object[], found: number, skipped: string[] }}
 */
export function scanSkillRoot({ root, warn }) {
  /** @type {object[]} */
  const candidates = []
  const skipped = []
  const depth = typeof root.depth === 'number' && root.depth > 0 ? root.depth : 1

  const note = (message) => {
    skipped.push(message)
    if (typeof warn === 'function') warn(message)
  }

  const consider = (file, skillDir, fallbackName) => {
    const { candidate, problem } = buildCandidate({ file, skillDir, fallbackName, root })
    if (candidate === undefined) {
      note(`[${root.label}] ${file}: ${problem}`)
      return
    }
    if (candidates.some(existing => existing.name === candidate.name)) return
    candidates.push(candidate)
  }

  const walk = (dir, level) => {
    const entries = readDir(dir)
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        const skillFile = path.join(full, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          consider(skillFile, full, entry.name)
          continue
        }
        if (level < depth) walk(full, level + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.md')) continue
      if (entry.name.toLowerCase() === 'skill.md') continue
      consider(full, dir, entry.name.replace(/\.md$/iu, ''))
    }
  }

  walk(root.dir, 1)
  return { candidates, found: candidates.length, skipped }
}

/**
 * 读取候选项的正文（每次都读当前文件，改正文不需要缓存失效）。
 * @param {object} locator - buildCandidate 产出的 locator。
 * @returns {string | undefined}
 */
export function readSkillBody(locator) {
  try {
    const raw = fs.readFileSync(locator.file, 'utf8')
    return parseSkillDocument(raw).body
  } catch {
    return undefined
  }
}

/**
 * 保证「引擎内置 skill」有一份可读的磁盘副本。
 *
 * 优先用 MiMo 自己同步出来的 `<userData>/engine-config/skills`；缺失时把
 * app.asar 里的 `/electron/lib/engine/skills` 解包到 DSH 缓存目录，
 * 这样 references/scripts 对模型来说就是真实路径。
 *
 * @param {object} input - 输入。
 * @param {string} input.engineSkillsDir - engine-config 下的 skills 目录。
 * @param {string | undefined} input.mimoAppDir - MiMo 安装目录。
 * @param {string} input.cacheDir - DSH 侧缓存目录。
 * @param {(message: string) => void} [input.info] - 信息回调。
 * @param {(message: string) => void} [input.warn] - 警告回调。
 * @returns {string | undefined} 可用的引擎 skill 目录。
 */
export function resolveEngineSkillsDir({ engineSkillsDir, mimoAppDir, cacheDir, info, warn }) {
  const localCount = countSkillFiles(engineSkillsDir)
  if (localCount > 0) {
    if (typeof info === 'function') info(`引擎内置 skill：${engineSkillsDir}（${localCount} 个）`)
    return engineSkillsDir
  }

  if (typeof mimoAppDir !== 'string' || mimoAppDir === '') return undefined
  const asarPath = path.join(mimoAppDir, 'resources', 'app.asar')
  let stat
  // 与 openAsar 同理：Electron 会把 .asar 当目录 stat，拿到的 size/mtime 是
  // 虚拟目录的，用它算 stamp 会让缓存标记和真实归档对不上。关掉 asar 支持取真实元数据。
  const previousNoAsar = process.noAsar
  process.noAsar = true
  try {
    stat = fs.statSync(asarPath)
  } catch {
    return undefined
  } finally {
    process.noAsar = previousNoAsar
  }

  const outDir = path.join(cacheDir, 'engine-skills')
  const markerFile = path.join(cacheDir, 'engine-skills.json')
  const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    if (marker?.stamp === stamp && countSkillFiles(outDir) > 0) {
      if (typeof info === 'function') info(`引擎内置 skill（已解包缓存）：${outDir}`)
      return outDir
    }
  } catch {
    // 没有标记或标记损坏，重新解包
  }

  try {
    const written = extractAsarPrefix(asarPath, ENGINE_SKILLS_PREFIX, outDir)
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(markerFile, JSON.stringify({ stamp, asarPath, written, at: new Date().toISOString() }, undefined, 2))
    if (typeof info === 'function') info(`已从 app.asar 解包引擎内置 skill：${written} 个文件 -> ${outDir}`)
    return outDir
  } catch (error) {
    if (typeof warn === 'function') warn(`解包 app.asar 失败：${error.message}`)
    return undefined
  }
}

/**
 * 数一个目录下有多少个 SKILL.md。
 * @param {string} dir - 目录。
 * @returns {number}
 */
export function countSkillFiles(dir) {
  let count = 0
  for (const entry of readDir(dir)) {
    if (!entry.isDirectory()) continue
    if (fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) count += 1
  }
  return count
}
