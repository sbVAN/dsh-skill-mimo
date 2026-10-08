# dsh-skill-mimo

一个 DSH 插件,把小米 MiMo(MiMo Desktop / MiMoCode)已有的 skill 引进 DSH 的会话技能目录。该用哪个不用你点,插件按自然语言描述自己匹配。

## 安装

```powershell
dsh plugin add github:sbVAN/dsh-skill-mimo
```

市场收录之后可以在 DSH 插件市场里直接搜。本地开发用 `dsh plugin add "file:$PWD"`,链进 profile,改完重载就生效。装好后 profile 的 `cordis.patch.yml` 里会多出插件自带补丁插的那一行。

HMR 开着时改配置立即生效。换包版本得重启 DSH,HMR 的模块监听默认跳过 `node_modules`。

## 扫描哪些目录

MiMo 的 skill 散在几个地方,都扫:

- `~/.config/mimocode/skills/`:MiMoCode 的全局 skill,目录名就是 skill 名
- `<项目根>/.mimocode/skills/` 和 `<项目根>/.mimocode/skill/`:项目级,允许往下嵌三层
- `engine-config/skills/`(在 MiMo 用户数据目录下):引擎内置的那批
- `extensions.json` 里每个扩展的 `placements.skillDirs`:插件带进来的 skill 目录
- `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.opencode/skills`,但只看 MiMo 自己在 `preferences.json` 里 `skillPathCompat` 开着的那些。MiMo 默认只开 agents,那这里就只扫 agents

引擎内置那批正常由 MiMo 同步到 `engine-config/skills`。这个目录还没有的话(比如刚装完、一次没跑过),插件从 `<MiMo 安装目录>/resources/app.asar` 解出 `/electron/lib/engine/skills`,放到 `<DSH_HOME>/cache/dsh-skill-mimo/`。skill 里写的 `references/xxx.md`、`scripts/xxx.py` 必须是磁盘上真实存在的路径,模型才读得到,指到 asar 内部读不了。

## 目录监听

每个 skill 根递归监听。改 `<root>/<name>/SKILL.md` 的正文或 frontmatter、增删一个 skill 目录,一秒内重新注册。事件做了 120ms 合并,编辑器保存一次常打出好几个事件,不合并会连着重扫好几遍。

根目录还不存在时监听挂不上,比如项目第一次建 `.mimocode/skills`。这种用 3 秒的轮询盯,出现了再补上监听。

上面的数字是在跑着的 DSH 上量的。改正文立即生效,增删目录一秒内反映,启动后才建的根在下一轮轮询时被发现。

Linux 的 `fs.watch` 不支持递归,退回非递归后只有根目录的直接增删能察觉。Windows 和 macOS 没这问题。

## 测试

不装 DSH 也能跑:

```powershell
node test/smoke.mjs
```

挂载插件、打印注册到的 skill,顺带检查名字是否 kebab-case、描述和正文是否为空,以及 `provider`/`invocation`/`resourceBase` 这些字段注册表认不认。

装好后开个新会话,问一句"你有哪些 skill 可用";或者提一个能命中某个 skill 描述的需求,看它会不会加载。

插件只往自己的缓存目录写东西,MiMo 那边一个文件不碰。排查看这三个:

- `mounted.json`:apply 跑过没有、什么时候、哪个 pid
- `last-list.json`:最近一次注册,扫了哪些根、进了哪些 skill、有没有失败的
- `last-error.json`:出错的堆栈,只有出错时才有

## 配置

写 `~/.dsh/skill-mimo.json`,不用改代码:

```json
{
  "includeEngineSkills": true,
  "includeUserSkills": true,
  "includeProjectSkills": true,
  "includeBrandRoots": true,
  "includeExtensions": true,
  "ignoreSkillPathCompatibility": false,
  "extraSkillDirs": [],
  "mimoDataDir": "C:\\Users\\你\\AppData\\Roaming\\Xiaomi MiMo",
  "mimoAppDir": "Z:\\MimoPlatform\\Xiaomi MiMo",
  "watch": true
}
```

`watch: false` 关掉目录监听,`extraSkillDirs` 塞额外的 skill 目录。

## 实现细节

`ctx.skills.registerProvider` 里的 effect 绑在技能服务实例自己的 ctx 上,不是插件的 ctx。插件 fiber 重建时(disable/enable、profile 重载)不会清掉它,于是第一次注册之后每次重载都撞同名、静默失败,表里一直留着第一份 provider。现在改走 `ctx.skills.register`,用 runtime 表,rank 250 也比 provider 的 550 高,撞名时它赢。

取注册表用 `ctx.get('skills')`,不是注入进来的 `ctx.skills`。host 层加 agent preset standing composition 的组合下,俩不一定是同一个对象。注册到错那份,技能面板和快照里都看得见这些 skill,模型的 `skill` 工具却报 unknown。

## 卸载

`plugin_manager` 里移除这个 bundle,或者删掉 profile `cordis.patch.yml` 里的 `skill-mimo` 行,再卸依赖。

## 限制

- 只读,不碰 MiMo 任何文件,唯一写的是 DSH 缓存目录(asar 回退解包那儿)
- `<name>/SKILL.md` 一层目录包和扁平 `<name>.md` 都认
- 名字必须 kebab-case,描述不能为空,不合格的跳过并记日志
- 正文注册时读进来,改了要等 watcher 刷新(一秒内)
- runtime 条目 rank 固定 250,没法像 provider 那样从配置调
