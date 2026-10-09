/**
 * 定位「小米 MiMo」的全部 skill 来源。
 *
 * 一个 skill 在 MiMo 里有五类来源（按 MiMo 自己的约定）：
 *
 *   1. 引擎内置 skill   <userData>/engine-config/skills/<id>/SKILL.md
 *                       （MiMo 把 app.asar 里的 /electron/lib/engine/skills 同步到这里；
 *                         若该目录缺失，插件会回退到直接解包 app.asar）
 *   2. 全局 skill       ~/.config/mimocode/skills/<id>/SKILL.md
 *   3. 项目 skill       <project>/.mimocode/skills/<id>/SKILL.md（也认单数 skill/）
 *   4. 品牌兼容根       ~/.agents/skills、~/.claude/skills、~/.codex/skills、~/.opencode/skills
 *                       （由 MiMo 设置里的 skillPathCompat 开关决定是否扫描）
 *   5. 插件贡献目录     <userData>/extensions.json 里每个扩展 placements.skillDirs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 品牌兼容根：MiMo 设置键 -> 目录名。 */
const BRAND_ROOTS = [
  { key: 'agents', dir: '.agents' },
  { key: 'claude', dir: '.claude' },
  { key: 'codex', dir: '.codex' },
  { key: 'opencode', dir: '.opencode' },
]

/** MiMo 默认只扫描 ~/.agents/skills。 */
const DEFAULT_COMPATIBILITY = { agents: true, claude: false, codex: false, opencode: false }

/**
 * 判断一个路径是不是存在的目录。
 * @param {string | undefined} target - 待检查路径。
 * @returns {boolean}
 */
function isDirectory(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 判断一个路径是不是存在的文件。
 * @param {string | undefined} target - 待检查路径。
 * @returns {boolean}
 */
function isFile(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * 判断一个路径是否存在。
 *
 * 不能用 isFile：DSH 的 host 进程是 Electron，它的 fs 被 Electron 的 asar 支持
 * 打过补丁，`.asar` 路径被当作**目录**处理（isFile() 为 false），而且路径不存在时
 * 抛的还是 Electron 特有的 `Invalid package`。纯 Node 下同一个路径 stat 得到的是
 * 普通文件 —— 两边行为不一致，判定"asar 在不在"只能看存不存在。
 *
 * @param {string | undefined} target - 待检查路径。
 * @returns {boolean}
 */
function pathExists(target) {
  if (typeof target !== 'string' || target === '') return false
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * 读取一个 JSON 文件；失败返回 undefined。
 * @param {string} file - 文件路径。
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解析 MiMo 的用户数据目录（Windows 上是 %APPDATA%\Xiaomi MiMo）。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {string}
 */
export function resolveMimoDataDir(env = process.env) {
  if (typeof env.MIMO_DATA_DIR === 'string' && env.MIMO_DATA_DIR !== '') return env.MIMO_DATA_DIR
  if (typeof env.MIMO_HOME === 'string' && env.MIMO_HOME !== '') return env.MIMO_HOME
  const home = os.homedir()
  if (process.platform === 'win32' && typeof env.APPDATA === 'string' && env.APPDATA !== '') {
    return path.join(env.APPDATA, 'Xiaomi MiMo')
  }
  return path.join(home, '.mimo')
}

/**
 * 解析 MiMo 的安装目录；只有需要回退解包 app.asar 时才用到。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {string | undefined}
 */
export function resolveMimoAppDir(env = process.env) {
  const candidates = []
  if (typeof env.MIMO_APP_DIR === 'string' && env.MIMO_APP_DIR !== '') candidates.push(env.MIMO_APP_DIR)
  const home = os.homedir()
  candidates.push(
    path.join(home, 'AppData', 'Local', 'Programs', 'Xiaomi MiMo'),
    'C:\\Program Files\\Xiaomi MiMo',
    'Z:\\MimoPlatform\\Xiaomi MiMo',
  )
  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, 'resources', 'app.asar'))) return candidate
  }
  return undefined
}

/**
 * 解析 MiMoCode 的全局配置目录（全局 skill 的权威写根）。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {string}
 */
export function resolveMimoConfigDir(env = process.env) {
  if (typeof env.MIMOCODE_CONFIG_DIR === 'string' && env.MIMOCODE_CONFIG_DIR !== '') {
    return env.MIMOCODE_CONFIG_DIR
  }
  return path.join(os.homedir(), '.config', 'mimocode')
}

/**
 * 解析 DSH 主目录，用于放缓存与可选配置文件。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') return env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/**
 * 从 cwd 向上找项目根：优先最近的 .git，其次最近的 .mimocode，都没有就用 cwd。
 * @param {string | undefined} cwd - 会话工作目录。
 * @returns {string | undefined}
 */
export function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  let current = path.resolve(cwd)
  let withMimocode
  for (;;) {
    if (isDirectory(path.join(current, '.git'))) return current
    if (withMimocode === undefined && isDirectory(path.join(current, '.mimocode'))) {
      withMimocode = current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return withMimocode ?? path.resolve(cwd)
}

/**
 * 读取 MiMo 的品牌兼容根开关。
 * @param {string} mimoDataDir - MiMo 用户数据目录。
 * @returns {{ agents: boolean, claude: boolean, codex: boolean, opencode: boolean }}
 */
export function readSkillPathCompatibility(mimoDataDir) {
  const preferences = readJson(path.join(mimoDataDir, 'preferences.json'))
  const configured = preferences?.skillPathCompat
  if (configured === undefined || configured === null || typeof configured !== 'object') {
    return { ...DEFAULT_COMPATIBILITY }
  }
  const resolved = { ...DEFAULT_COMPATIBILITY }
  for (const { key } of BRAND_ROOTS) {
    if (typeof configured[key] === 'boolean') resolved[key] = configured[key]
  }
  return resolved
}

/**
 * 读取 MiMo 的扩展清单，收集它们贡献的 skill 目录。
 * @param {string} mimoDataDir - MiMo 用户数据目录。
 * @returns {Array<{ extension: string, dir: string }>}
 */
export function readExtensionSkillDirs(mimoDataDir) {
  const manifest = readJson(path.join(mimoDataDir, 'extensions.json'))
  const out = []
  if (!Array.isArray(manifest?.extensions)) return out
  for (const extension of manifest.extensions) {
    const dirs = extension?.placements?.skillDirs
    if (!Array.isArray(dirs)) continue
    for (const dir of dirs) {
      if (typeof dir !== 'string' || dir.trim() === '') continue
      out.push({ extension: String(extension.id ?? 'extension'), dir })
    }
  }
  return out
}

/**
 * 装载插件可选的 JSON 配置（`<dshHome>/skill-mimo.json`）。
 * @param {string} dshHome - DSH 主目录。
 * @returns {Record<string, any>}
 */
export function readPluginConfig(dshHome) {
  const configured = readJson(path.join(dshHome, 'skill-mimo.json'))
  return configured !== null && typeof configured === 'object' ? configured : {}
}

/**
 * 汇总本次会话可见的全部 MiMo skill 根目录。
 *
 * @param {object} options - 输入。
 * @param {string | undefined} options.cwd - 会话工作目录。
 * @param {Record<string, any>} options.config - 插件配置（默认值 + JSON 配置）。
 * @param {Record<string, string | undefined>} [options.env] - 环境变量表。
 * @returns {{
 *   roots: Array<{ id: string, label: string, dir: string, rank: number, source: string }>,
 *   mimoDataDir: string,
 *   mimoAppDir: string | undefined,
 *   mimoConfigDir: string,
 *   dshHome: string,
 *   engineSkillsDir: string,
 *   compatibility: Record<string, boolean>,
 * }}
 */
export function collectSkillRoots({ cwd, config = {}, env = process.env }) {
  const mimoDataDir = config.mimoDataDir ?? resolveMimoDataDir(env)
  const mimoAppDir = config.mimoAppDir ?? resolveMimoAppDir(env)
  const mimoConfigDir = config.mimoConfigDir ?? resolveMimoConfigDir(env)
  const dshHome = config.dshHome ?? resolveDshHome(env)
  const rank = typeof config.rank === 'number' && Number.isFinite(config.rank) ? config.rank : 550
  const projectRank = typeof config.projectRank === 'number' && Number.isFinite(config.projectRank)
    ? config.projectRank
    : 150

  /** @type {Array<{ id: string, label: string, dir: string, rank: number, source: string }>} */
  const roots = []
  const push = (id, label, dir, rootRank, source) => {
    if (typeof dir !== 'string' || dir === '') return
    if (roots.some(root => root.dir === dir)) return
    roots.push({ id, label, dir, rank: rootRank, source })
  }

  // 1. 项目级
  if (config.includeProjectSkills !== false) {
    const projectRoot = resolveProjectRoot(cwd)
    if (projectRoot !== undefined) {
      push('project-skills', '项目 .mimocode/skills', path.join(projectRoot, '.mimocode', 'skills'), projectRank, 'project-agents')
      push('project-skill', '项目 .mimocode/skill', path.join(projectRoot, '.mimocode', 'skill'), projectRank, 'project-agents')
    }
  }

  // 2. 插件（扩展）贡献的目录
  if (config.includeExtensions !== false) {
    for (const { extension, dir } of readExtensionSkillDirs(mimoDataDir)) {
      push(`extension:${extension}:${dir}`, `扩展 ${extension}`, dir, rank, 'custom')
    }
  }

  // 3. 引擎内置 skill（engine-config 优先，缺失时由上层回退解包 app.asar）
  const engineSkillsDir = path.join(mimoDataDir, 'engine-config', 'skills')
  if (config.includeEngineSkills !== false) {
    push('engine-config', 'MiMo 引擎内置', engineSkillsDir, rank, 'bundled')
  }

  // 4. 全局 MiMoCode skill
  if (config.includeUserSkills !== false) {
    push('mimocode-global', 'MiMoCode 全局', path.join(mimoConfigDir, 'skills'), rank, 'custom')
  }

  // 5. 品牌兼容根
  const compatibility = readSkillPathCompatibility(mimoDataDir)
  if (config.includeBrandRoots !== false) {
    for (const { key, dir } of BRAND_ROOTS) {
      if (config.ignoreSkillPathCompatibility !== true && compatibility[key] !== true) continue
      push(`brand:${key}`, `兼容根 ~/${dir}/skills`, path.join(os.homedir(), dir, 'skills'), rank, 'user-agents')
    }
  }

  // 6. 用户显式追加
  if (Array.isArray(config.extraSkillDirs)) {
    for (const dir of config.extraSkillDirs) {
      push(`extra:${dir}`, '自定义目录', dir, rank, 'custom')
    }
  }

  return {
    roots,
    mimoDataDir,
    mimoAppDir: isDirectory(mimoAppDir) ? mimoAppDir : undefined,
    mimoConfigDir,
    dshHome,
    engineSkillsDir,
    compatibility,
  }
}

export { isDirectory, isFile }
