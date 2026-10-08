/**
 * dsh-skill-mimo —— 把「小米 MiMo」（MiMo Desktop / MiMoCode）里的全部 skill
 * 读进 DeepSeek Harness 的会话技能目录。
 *
 * 做法：扫描 MiMo 的全部 skill 来源（引擎内置、MiMoCode 全局与项目根、
 * 扩展贡献目录、MiMo 自己启用的品牌兼容根），把每个 SKILL.md 注册成
 * DSH 的 runtime skill —— 模型在会话开头就会拿到它们的名字与描述，
 * 用自然语言提到对应场景即可命中并由 `skill` 工具加载完整说明。
 */

import fs from 'node:fs'
import path from 'node:path'

import { readSkillBody, resolveEngineSkillsDir, scanSkillRoot } from './catalog.js'
import { collectSkillRoots, readPluginConfig, resolveDshHome } from './roots.js'

/** Cordis 插件身份。 */
export const name = 'skill-mimo'
/** 依赖的技能注册表服务。 */
export const inject = ['skills']
/** 注册时写在 skill 上的 provider 名。 */
export const PROVIDER_NAME = 'mimo'

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {Record<string, any>} [config] - 加载器传入的配置（可选）。
 */
export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const info = typeof log.info === 'function' ? message => log.info(message) : () => {}
  const warn = typeof log.warn === 'function' ? message => log.warn(message) : () => {}

  // 可选的外部配置：<DSH_HOME>/skill-mimo.json，便于不改代码调整范围。
  const settings = { ...readPluginConfig(resolveDshHome()), ...(config ?? {}) }
  const diagnosticDir = path.join(resolveDshHome(), 'cache', 'dsh-skill-mimo')
  const writeDiagnostic = (file, payload) => {
    try {
      fs.mkdirSync(diagnosticDir, { recursive: true })
      fs.writeFileSync(path.join(diagnosticDir, file), JSON.stringify(payload, undefined, 2))
    } catch {
      // 诊断写不出去不影响功能
    }
  }

  writeDiagnostic('mounted.json', {
    at: new Date().toISOString(),
    plugin: name,
    provider: PROVIDER_NAME,
    pid: process.pid,
    settings,
  })

  // 用 ctx.get 取注册表，而不是只靠注入的 ctx.skills。
  //
  // 在「host 层 + agent preset standing composition」这类部署里，两处解析到的
  // 未必是同一个对象；model 侧的工具（dsh-tool-skill）用的是它自己那份。
  // 注册到错的那一份时，技能面板和快照里都能看见这些 skill，可模型的 `skill`
  // 工具偏偏报 unknown —— 这正是本项目踩过的坑。
  const skills = (typeof ctx.get === 'function' ? ctx.get('skills') : undefined) ?? ctx.skills

  /**
   * 解析本次要扫描的根目录（含 app.asar 回退）。
   * @param {string | undefined} cwd - 会话工作目录。
   * @returns {Array<{ id: string, label: string, dir: string, rank: number, source: string, depth?: number }>}
   */
  const resolveRoots = (cwd) => {
    const snapshot = collectSkillRoots({ cwd, config: settings })
    const cacheDir = path.join(snapshot.dshHome, 'cache', 'dsh-skill-mimo')
    let engineDir
    if (settings.includeEngineSkills !== false) {
      engineDir = resolveEngineSkillsDir({
        engineSkillsDir: snapshot.engineSkillsDir,
        mimoAppDir: snapshot.mimoAppDir,
        cacheDir,
        info,
        warn,
      })
    }
    const roots = []
    for (const root of snapshot.roots) {
      if (root.id === 'engine-config') {
        if (engineDir === undefined) continue
        roots.push({ ...root, dir: engineDir })
        continue
      }
      roots.push(root)
    }
    // 项目级按 MiMo 的约定允许嵌套（.mimocode/{skill,skills}/**）
    for (const root of roots) if (root.id.startsWith('project-')) root.depth = 3
    return roots
  }

  /**
   * 现存且是目录的根。
   * @param {Array<{ dir: string }>} roots - resolveRoots 的结果。
   * @returns {string[]}
   */
  const existingDirs = roots => roots
    .map(root => root.dir)
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory()
      } catch {
        return false
      }
    })

  /** @type {Map<string, () => void>} */
  const disposers = new Map()

  const disposeRegistered = () => {
    for (const dispose of disposers.values()) {
      try {
        dispose()
      } catch {
        // 单个取消失败不影响其余
      }
    }
    disposers.clear()
  }

  /**
   * 全量注册：先清掉上一轮，再按当前根目录注册一遍。
   *
   * 用 runtime 注册（skills.register）而不是 registerProvider，原因是
   * registerProvider 的 effect 绑定在「服务实例自己的 ctx」上，插件 fiber 重建
   * （disable/enable、profile 重载）不会清掉它 —— 之后每次注册都撞同名静默失败，
   * 表里永远留着第一份旧 provider。runtime 表没有这个问题，且 rank 更高。
   *
   * @param {string | undefined} cwd - 会话工作目录，决定项目级 skill。
   */
  const registerAll = (cwd) => {
    disposeRegistered()
    let added = 0
    const registered = []
    const failures = []
    try {
      const roots = resolveRoots(cwd)
      for (const root of roots) {
        try {
          if (!fs.statSync(root.dir).isDirectory()) continue
        } catch {
          continue
        }
        for (const candidate of scanSkillRoot({ root, warn }).candidates) {
          if (disposers.has(candidate.name)) continue
          const content = readSkillBody(candidate.locator)
          if (content === undefined || content === '') {
            failures.push(`${candidate.name}: 正文读不出来`)
            continue
          }
          try {
            disposers.set(candidate.name, skills.register({
              name: candidate.name,
              description: candidate.description,
              ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
              invocation: candidate.invocation,
              source: candidate.source,
              provider: PROVIDER_NAME,
              ...(candidate.path === undefined ? {} : { path: candidate.path }),
              resourceBase: candidate.resourceBase,
              content,
            }))
            registered.push(candidate.name)
            added += 1
          } catch (error) {
            failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      writeDiagnostic('last-list.json', {
        at: new Date().toISOString(),
        count: added,
        names: registered.sort(),
        roots: roots.map(root => root.dir),
        failures,
      })
      if (added > 0) info(`dsh-skill-mimo：已注册 ${added} 个 MiMo skill`)
    } catch (error) {
      writeDiagnostic('last-error.json', {
        at: new Date().toISOString(),
        registered: registered.length,
        failures,
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      })
      warn(`dsh-skill-mimo：注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 目录监听：MiMo 那边增删 skill 时刷新注册 ────────────────────────────
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  const watchers = new Map()
  let currentCwd

  const closeWatchers = () => {
    for (const watcher of watchers.values()) {
      try {
        watcher.close()
      } catch {
        // 忽略
      }
    }
    watchers.clear()
  }

  const syncWatchers = (dirs) => {
    if (settings.watch === false) return
    const wanted = new Set(dirs)
    for (const [dir, watcher] of watchers) {
      if (wanted.has(dir)) continue
      try {
        watcher.close()
      } catch {
        // 忽略
      }
      watchers.delete(dir)
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue
      try {
        const watcher = fs.watch(dir, () => registerAll(currentCwd))
        watcher.on('error', () => {
          try {
            watcher.close()
          } catch {
            // 忽略
          }
          watchers.delete(dir)
        })
        watchers.set(dir, watcher)
      } catch {
        // 该平台/目录不支持 watch，忽略
      }
    }
  }

  const applyRoots = (cwd) => {
    currentCwd = cwd
    registerAll(cwd)
    syncWatchers(existingDirs(resolveRoots(cwd)))
  }

  applyRoots(undefined)

  // ── 会话出现后补上项目级 skill ──────────────────────────────────────────
  // 插件加载时还没有 agent，拿不到工作目录；agent 出现后用它重扫一次。
  const handled = new WeakSet()
  const sweep = () => {
    try {
      const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agents = typeof agentsService?.list === 'function' ? agentsService.list() : []
      for (const agent of agents) {
        if (agent === null || agent === undefined || handled.has(agent)) continue
        handled.add(agent)
        const cwd = agent?.session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') applyRoots(cwd)
        break
      }
    } catch {
      // 拿不到 agents 就下次再试
    }
  }
  sweep()
  const sweepTimer = setInterval(sweep, 3000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  // fiber 销毁时收摊：停掉轮询、关掉 watcher、注销已注册的 skill。
  ctx.effect(() => () => {
    clearInterval(sweepTimer)
    closeWatchers()
    disposeRegistered()
  })

  info('dsh-skill-mimo：MiMo 技能提供器已挂载')
}
