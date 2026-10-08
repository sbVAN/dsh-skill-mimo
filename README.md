# dsh-skill-mimo

DSH 插件。装上之后，小米 MiMo（MiMo Desktop / MiMoCode）里已有的 skill 会进到 DSH 的会话技能目录里。什么时候该用哪个 skill 由你的自然语言描述决定，不用点名。

## 扫描范围

MiMo 的 skill 不在一处，插件把这些地方都扫一遍：

- `~/.config/mimocode/skills/`：MiMoCode 的全局 skill，目录名就是 skill 名
- `<项目根>/.mimocode/skills/` 和 `<项目根>/.mimocode/skill/`：项目级，允许往下嵌三层
- `engine-config/skills/`（在 MiMo 用户数据目录下）：引擎内置的那批
- `extensions.json` 里每个扩展的 `placements.skillDirs`：插件带进来的 skill 目录
- `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.opencode/skills`，但只看 MiMo 自己在 `preferences.json` 的 `skillPathCompat` 里开着的那些。MiMo 默认只开 agents，那这里就只扫 agents

引擎内置那批正常是 MiMo 自己同步到 `engine-config/skills` 的。如果这个目录还没有（比如 MiMo 刚装完还没跑过一次），插件会去 `<MiMo 安装目录>/resources/app.asar` 里把 `/electron/lib/engine/skills` 解出来，落在 `<DSH_HOME>/cache/dsh-skill-mimo/`。这么做是为了 skill 里写的 `references/xxx.md`、`scripts/xxx.py` 仍然是磁盘上找得到的真实路径，模型按需读得到；直接指 asar 内部是读不了的。

## 安装

市场收录之后能在 DSH 的插件市场里搜到。在那之前：

```powershell
dsh plugin add github:sbVAN/dsh-skill-mimo
```

本地开发用 `dsh plugin add "file:$PWD"`，链进 profile，改完重载就生效。

装好后 profile 的 `cordis.patch.yml` 里会多出插件自带补丁插的那一行。

HMR 开着的时候改配置立即生效。但换包版本得重启 DSH，HMR 的模块监听默认跳过 `node_modules`。

## 变了会不会跟上

会。每个 skill 根都是递归监听的，所以改 `<root>/<name>/SKILL.md` 的正文或 frontmatter、新增或删掉一个 skill 目录，都会在一秒内重新注册。事件做了 120ms 合并，编辑器保存一次常常打出好几个事件，不合并就会连着重扫好几遍。

根目录本身还不存在的话是没法监听的（比如项目第一次建 `.mimocode/skills`），这个靠一个 3 秒的轮询盯着，出现了就补上监听。

这些是在跑着的 DSH 上量的：改正文立即生效，增删目录一秒内反映，启动后才建的根在下一轮轮询时被发现。

Linux 上 `fs.watch` 不支持递归，会退回非递归的，那边只有根目录的直接增删能察觉到。Windows 和 macOS 没有这个问题。

## 验一下

不装 DSH 也能跑：

```powershell
node test/smoke.mjs
```

它会挂载插件、打印注册到的 skill，顺便检查名字是不是 kebab-case、描述和正文有没有空、`provider`/`invocation`/`resourceBase` 这些字段注册表认不认。

装好之后开个新会话，问一句"你有哪些 skill 可用"，或者直接提一个能命中某个 skill 描述的需求，看它会不会去加载。

插件只在自己缓存目录写东西，MiMo 那边一个文件都不碰。要排查的时候看这三个：

- `mounted.json`：apply 跑过没有、什么时候、哪个 pid
- `last-list.json`：最近一次注册，扫了哪些根、进了哪些 skill、有没有失败的
- `last-error.json`：出错的堆栈，只有出错时才有

## 配置

写 `~/.dsh/skill-mimo.json`，不用改代码：

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

`watch: false` 关掉目录监听，`extraSkillDirs` 可以塞额外的 skill 目录。

## 两个踩过的坑

这两处跟直觉不一样，写下来免得以后又踩：

`ctx.skills.registerProvider` 里那个 effect 是绑在技能服务实例自己的 ctx 上的，不是插件的 ctx。插件 fiber 重建的时候（disable/enable、profile 重载）不会把它清掉，于是第一次注册之后每次重载都撞同名、静默失败，表里一直留着第一份 provider。所以现在改用 `ctx.skills.register` 走 runtime 表，那里没有这个问题，rank 也更高（250 对 550），撞名的时候是它赢。

取注册表用的是 `ctx.get('skills')`，不是注入进来的 `ctx.skills`。在 host 层加 agent preset standing composition 这种组合下这两个不一定是同一个对象；注册到错的那份，技能面板和快照里都看得见这些 skill，偏偏模型的 `skill` 工具报 unknown。

## 卸载

`plugin_manager` 里移除这个 bundle，或者删掉 profile `cordis.patch.yml` 里的 `skill-mimo` 行，再把依赖卸掉。

## 已知边界

- 只读。不写 MiMo 的任何文件，唯一会写的是 DSH 自己的缓存目录（asar 回退解包那里）。
- 一层目录包（`<name>/SKILL.md`）和扁平 `<name>.md` 都认。
- 名字必须是 kebab-case，描述不能为空，不合格的跳过并记日志。
- 正文是注册时读进来的，改了要等 watcher 触发一次刷新（一秒内）。
- runtime 条目的 rank 固定 250，没法像 provider 那样从配置调。
