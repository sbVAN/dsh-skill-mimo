/**
 * 冒烟测试：不依赖 DSH 运行时，挂载插件并检查它把 MiMo 的 skill 注册成了什么。
 *
 *   node test/smoke.mjs
 */

import { apply, PROVIDER_NAME } from '../lib/index.js'

/** @type {Map<string, object>} */
const registered = new Map()
const infoLines = []
const warnLines = []

const ctx = {
  logger: {
    info: message => infoLines.push(String(message)),
    warn: message => warnLines.push(String(message)),
  },
  // 插件用 ctx.get('skills') 取它要注册到的那份注册表。
  get: serviceName => (serviceName === 'skills' ? ctx.skills : undefined),
  skills: {
    register(skill) {
      registered.set(skill.name, skill)
      return () => registered.delete(skill.name)
    },
  },
  effect(callback) {
    const dispose = callback()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

apply(ctx, {})

if (infoLines.length > 0) console.log(infoLines.map(line => `[info] ${line}`).join('\n'))
if (warnLines.length > 0) console.log(warnLines.map(line => `[warn] ${line}`).join('\n'))

const skills = [...registered.values()].sort((a, b) => a.name.localeCompare(b.name))
console.log(`\n共注册 ${skills.length} 个 skill（provider=${PROVIDER_NAME}）\n`)

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
for (const skill of skills) {
  const description = String(skill.description ?? '').replace(/\s+/gu, ' ')
  console.log(`- ${skill.name.padEnd(30)} ${description.slice(0, 66)}`)
}

// 校验 DSH 注册表的硬约束
for (const skill of skills) {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`非法名字：${skill.name}`)
  if (typeof skill.description !== 'string' || skill.description === '') {
    throw new Error(`缺少描述：${skill.name}`)
  }
  if (typeof skill.content !== 'string' || skill.content === '') {
    throw new Error(`正文为空：${skill.name}`)
  }
  if (typeof skill.invocation?.modelInvocable !== 'boolean') {
    throw new Error(`invocation 不对：${skill.name}`)
  }
  if (skill.provider !== PROVIDER_NAME) throw new Error(`provider 字段不对：${skill.name}`)
  if (skill.source === undefined) throw new Error(`source 缺失：${skill.name}`)
  if (skill.resourceBase?.kind === 'directory' && typeof skill.resourceBase.path !== 'string') {
    throw new Error(`resourceBase 不对：${skill.name}`)
  }
}

const expected = [
  '3d-creation',
  'figma',
  'imagegen',
  'lieflat-less-ai-tone',
  'mimo-desktop-guide',
  'mimo-skill-authoring',
  'session-chat',
  'threejs-game-skills',
  'visualizer',
  'websearch',
  'windows-powershell-reference',
]
const names = new Set(skills.map(skill => skill.name))
const missing = expected.filter(skillName => !names.has(skillName))
console.log(`\nMiMo 引擎内置 11 个 skill 命中 ${expected.length - missing.length}/${expected.length}`)
if (missing.length > 0) console.log(`缺失：${missing.join(', ')}`)

// 轮询定时器会吊住事件循环，测完直接退。
process.exit(missing.length > 0 || skills.length === 0 ? 1 : 0)
