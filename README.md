# mini-claude-code

一个用 TypeScript 写的 coding agent harness。接上 Anthropic 的 Messages API 之后是一个 REPL：你给一句话，它自己拆活、调工具、改文件、跑命令，直到把事情做完。

我写这个项目想验证一件事：一个能长期干活的 agent harness，把它的子系统一个一个拆出来挂在同一个工具循环上，到底要处理多少问题。下面记的是每个部分我实际做了什么、为什么这么处理。

## 它能做什么

启动后是一个交互式命令行。具体能力：

- 读写改文件、跑 shell、按 glob 找文件
- 会话内维护 todo 列表，跑偏了能拉回来
- 上下文快满时自动压缩，prompt 超长时自动救回
- 429/529 自动退避重试，连续过载切 fallback 模型，max_tokens 自动升档
- 慢命令（install/build/test）丢后台跑，不堵主循环
- 定时任务（cron），到点自动唤醒 agent 跑一轮
- 派一次性子 agent 做隔离的子任务，只回摘要
- 派持久队友并行干活，队友能自己轮询任务板认领活
- 队友提交 plan，lead 审批后才动手；lead 能下 shutdown
- git worktree 隔离，队友认到带 worktree 的任务后文件操作自动切到隔离目录
- 接 MCP server，连上后工具自动并入工具池（`mcp__server__tool`）
- 技能（skill）按需加载，记忆文件注入 system prompt

## 架构

核心是一个工具循环。复杂度都在循环周围，循环本身始终是这个结构：

```
用户输入
  → UserPromptSubmit hooks
  → cron / background 通知注入
  → 上下文压缩管线
  → 用 memory + skills + MCP 状态组装 system prompt
  → 调模型
  → 响应里有 tool_use block?
      否 → Stop hooks → 返回，等下一句
      是 → PreToolUse hooks + 权限
          → 分发到 handler / MCP handler / 后台
          → PostToolUse hooks
          → tool_result / task_notification 回 messages
          → 下一轮
```

这里有个取舍值得说清楚：循环判不继续，看的是响应里有没有实际的 `tool_use` block，而不是 `stop_reason == "tool_use"`。stop_reason 在某些边界情况下会撒谎，但 content block 不会。所以把它当成唯一继续信号。

### 子系统挂在循环的哪里

| 位置 | 子系统 | 做了什么 |
|------|--------|----------|
| 输入前后 | `UserPromptSubmit` hook | 记录用户输入和当前目录 |
| 调模型前 | cron queue | 到点的定时任务以 `[Scheduled] ...` 注入 messages |
| 调模型前 | background 通知 | 后台任务完成后以 `<task_notification>` 注入 |
| 调模型前 | 压缩管线 | 先压超大 tool_result，再裁历史中段，再压旧 tool_result，必要时调模型做摘要 |
| 调模型前 | memory / skills / MCP | 每轮重组 system prompt，让模型看到当前能力和长期上下文 |
| 调模型 | 错误恢复 | 429/529 退避重试、max_tokens 升档、prompt too long 触发 reactive compact |
| 工具执行前 | `PreToolUse` hook + 权限 | 拦危险命令、写越界路径、破坏性 MCP 工具 |
| 工具分发 | `assembleToolPool` | 内置工具 + 已连 MCP 工具合并成一个池 |
| 工具执行时 | 后台分发 | 慢 bash 丢后台，主循环先返回占位结果 |
| 工具执行后 | `PostToolUse` hook | 大输出告警等后处理 |
| 回循环 | tool_result | 每个 tool_use 对应一个 tool_result |
| 本轮无 tool_use | `Stop` hook | 统计本轮工具结果数 |

## 实现的子系统

### 工具与分发（27 个内置工具）

`src/loop/tools.ts` 里工具定义和 handler 是两张显式的表。每轮 `assembleToolPool()` 把内置工具和已连接的 MCP 工具合并：

```
BUILTIN_TOOLS  + connected MCP tools
BUILTIN_HANDLERS + mcp__server__tool handlers
```

所以 `connect_mcp("docs")` 之后，下一轮工具池里就多出 `mcp__docs__search`、`mcp__docs__get_version`，模型可以直接调。我刻意让 handler 统一返回字符串，错误也以字符串形式回给模型，不让异常打断循环——agent 最怕的就是中途崩。

### 权限和 hooks

权限没有写死在每个工具的执行行里，而是作为 `PreToolUse` hook：

```
blocked = await triggerHooks("PreToolUse", block)
if (blocked) → 直接把拒绝原因作为 tool_result 返回，跳过执行
```

这样 permission、log、审计都挂在同一个 hook 点。`bash` 走 deny list（`rm -rf /`、`sudo`、`mkfs` 等）和破坏性命令人工确认；`write_file`/`edit_file` 走路径越界检查；名字带 `deploy` 的 MCP 工具要人工放行。文件工具用 `safePath()` 把所有路径锁在工作区（或队友的 worktree）内，bash 则故意保留能力，由 hook 兜底。

这里有个设计点：权限确认要问用户，但我不想让 hook 层反过来依赖终端 IO 层（那会形成循环依赖）。所以 hook 暴露一个 `setPermissionConfirmer`，CLI 启动时把自己的 `askPermission` 注册进去；没注册时默认拒绝。依赖方向就保持干净了。

### 压缩管线

调模型前依次跑 `src/engine/compaction.ts` 里的四层：

1. `toolResultBudget` — 把最后一条 user message 里超大的 tool_result 写盘换成 `<persisted-output>` 存根
2. `snipCompact` — 消息过多时裁掉中段，保留头尾，且头尾边界会避开 tool_use/tool_result 的配对
3. `microCompact` — 只保留最近 3 个 tool_result 的正文，更早的换成"已压缩"存根
4. `compactHistory` — 还超限就写 transcript、调模型做摘要、用摘要替换历史

为什么要分四层而不是一把梭？因为前面三层是纯本地操作、零延迟、零 token 成本，只有第四层才花一次模型调用。绝大多数情况前两层就够，没必要动模型。另外 `reactiveCompact` 兜底：模型调用直接报 prompt too long 时，保留最近 5 条、对其余部分做摘要后重试。transcript 全部落盘到 `.transcripts/`，可回查。

### 错误恢复

`src/engine/recovery.ts` 包住每次模型调用：

- 429：指数退避 + 抖动重试
- 529：退避重试，连续两次失败切 `FALLBACK_MODEL_ID`
- `max_tokens`：先把 max_tokens 从 8000 升到 16000 重试，再发 continuation prompt 让模型接着说
- prompt too long：触发 reactive compact 后重试

### 后台任务和 cron

慢 bash（命令里含 install/build/test/deploy 等）会被 `shouldRunBackground` 识别，丢到 `startBackgroundTask` 的 Promise 里跑，主循环立刻返回一个占位 tool_result。后台完成后结果攒成 `<task_notification>`，在下一轮循环开头注入 messages。这样装依赖、跑测试就不会卡住主线。

`src/engine/cron.ts` 是一个 5 字段 cron 解析器（支持 `*`、`*/n`、`,`、`-`、范围校验）。`setInterval` 每秒 tick 一次，命中后入队。CLI 监听队列，命中后抢同一把锁跑一轮 agent。`durable` 的任务写到 `.scheduled_tasks.json`，重启后自动加载。

### 任务图和 worktree

`src/state/tasks.ts` 是文件持久化的任务记录（`.tasks/task_*.json`），带依赖和归属。`canStart` 要求所有 blocker 都存在且 completed 才能认领；`completeTask` 完成后会列出因此被解锁的任务。

`src/state/worktrees.ts` 用 `git worktree add` 建独立分支和目录，名字走严格正则校验（在 git 之前拦，不让脏数据进 git）。`removeWorktree` 默认拒绝有未提交改动的目录，必须显式 `discard_changes`。任务有 `worktree` 字段绑定目录。

### 子 agent 和团队

两种 delegation：

- `task`（`src/engine/subagent.ts`）：一次性子 agent，独立 messages，中间过程丢弃，只回最终摘要。解决上下文隔离。
- `spawn_teammate`（`src/engine/teammate.ts`）：持久队友，async 协程。通过 `MessageBus`（`.mailboxes/*.jsonl`，追加写）收发消息，闲时轮询任务板自动认领。解决长期并行。

队友认到带 worktree 的任务后，它的 bash/read/write 自动切到那个隔离目录——通过一个 `wtCtx.path` 在 handler 闭包里透传。队友 idle 时先看 inbox（协议消息优先），再扫任务板。

### 协议

`src/state/bus.ts` + `src/state/protocol.ts`。plan approval 是真门禁：队友 `submit_plan` 后停下，不再跑模型/工具步，直到 lead 回 `plan_approval_response`。响应按 `request_id` 匹配，一个回复批不了另一个请求。shutdown 同理。lead 侧有 `request_plan`/`review_plan`/`request_shutdown`。

### 记忆、技能和 prompt

`assembleSystemPrompt()` 每轮重组：身份、工具说明、工作目录、当前时间、技能目录、`.memory/MEMORY.md` 内容、已连 MCP server。技能只在 prompt 里放目录（name + description），完整内容由 `load_skill(name)` 按需加载，避免一次性塞满上下文。技能是 `skills/<name>/SKILL.md`，带 YAML frontmatter。

### MCP

`src/state/mcp.ts` 把 MCP 建模成"后绑定工具"：先 `connect_mcp(name)` 连上，发现的服务端工具在 `assembleToolPool` 时并入工具池，名字统一成 `mcp__{server}__{tool}`。内置两个 mock server（docs 只读、deploy 带破坏性标记）演示接入和权限拦截。

## 目录结构

源码按依赖方向分层，下层不引用上层。看目录就能知道谁依赖谁：

```
src/
  core/         基础，无内部依赖
    config.ts       环境变量、路径、常量
    util.ts         ANSI 着色、safePath、内容块工具、类型
    client.ts       Anthropic SDK 客户端 + ToolDef 类型
  state/        文件持久化的状态，只依赖 core
    tasks.ts        任务图 + todos
    worktrees.ts    git worktree 增删 + 名字校验（依赖 tasks）
    bus.ts          MessageBus（JSONL 信箱）+ 协议状态
    protocol.ts     shutdown / plan approval 协议（依赖 bus）
    skills.ts       SKILL.md 扫描 + frontmatter + 按需加载
    mcp.ts          MCP 客户端 + mock server + 工具并入
  engine/       驱动一轮对话的机制，依赖 core + state
    hooks.ts        hook 注册 + 权限管线（可插拔 confirmer）
    compaction.ts   四层压缩 + transcript + 摘要
    recovery.ts     重试 / max_tokens / prompt too long
    background.ts   慢操作后台化 + task notification
    cron.ts         5 字段 cron 解析 + 调度 + 持久化
    subagent.ts     一次性子 agent
    teammate.ts     持久队友协程 + idle 轮询 + worktree 透传
    prompt.ts       system prompt 组装 + context 更新
    tools/fs.ts     bash / read / write / edit / glob / todo
  loop/         循环本体 + 工具装配，依赖下面所有层
    tools.ts        27 个内置工具定义 + handler + assembleToolPool
    agent.ts        工具循环本体、callLlm（流式输出）、错误恢复接入
  cli/          入口 + 终端 IO
    io.ts           readline 封装 + 权限确认
    index.ts        REPL + cron 自动运行 + 串行锁（带 shebang）
skills/
  repo-inspector/SKILL.md   示例技能
test/
  loop.test.ts    离线验证工具循环（mock 模型，无需 API key）
```

依赖方向：`cli → loop → engine → state → core`。唯一一个"反向"需求是权限确认要问用户，我用可插拔 confirmer 解决了，所以 `engine/hooks` 不依赖 `cli/io`，而是 `cli/index` 启动时把 asker 注册进去。

## 运行

需要 Node 20+。

### 作为命令行工具（推荐）

发布后可以直接用：

```sh
# 不安装，跑一次
npx mini-claude-code

# 或全局安装
npm install -g mini-claude-code
mini-claude-code
```

它对你**当前所在目录**操作——在哪启动，就改哪的文件。状态目录（`.tasks`、`.worktrees`、`.mailboxes`、`.transcripts` 等）都建在当前目录下。所以 `cd` 到你的项目里再启动就行。

鉴权用环境变量。要么在当前目录放一个 `.env`：

```sh
ANTHROPIC_API_KEY=sk-ant-...
MODEL_ID=claude-sonnet-4-5-20250929
# 可选：连续过载后切的备用模型
FALLBACK_MODEL_ID=claude-haiku-4-5-20251001
# 可选：指向代理或兼容端点
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

要么直接 export 这两个变量：

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export MODEL_ID=claude-sonnet-4-5-20250929
mini-claude-code
```

### 从源码跑

```sh
git clone <repo> && cd mini-claude-code
npm install
cp .env.example .env   # 填 key 和 model
npm run dev            # tsx 直跑，改完即生效
```

构建：

```sh
npm run build          # 输出到 dist/，带 shebang
node dist/cli/index.js # 在任意目录运行
```

### 试几句

1. `列一个 todo 检查这个仓库，然后列出所有 ts 文件`
2. `连上 docs 这个 MCP server，搜一下 agent loop`
3. `建两个任务，各建一个 worktree，然后派 alice 和 bob 两个队友，让他们先提交 plan 再认领`
4. `3 分钟后提醒我开会`（到点会自动唤醒）
5. `后台跑 npm install，同时读 README.md`（install 不阻塞，读完接着干）

观察重点：工具调用前有没有过 hook/权限；`connect_mcp` 后下一轮是否多出 MCP 工具；慢命令是否返回后台占位；到点是否自动提醒；队友是否在审批前停住、批准后才认领；worktree 绑定后队友是否切到对应目录。

## 验证

```sh
npm run typecheck   # 类型检查
npm run build       # 编译到 dist/
npm test            # 离线跑工具循环：mock 模型返回一个 write_file 调用，
                    # 断言文件被写、tool_result 回灌、Stop hook 触发
```

`npm test` 不需要 API key，用它验证 harness 的工具分发、hook、权限、tool_result 回灌这条主干是真的通的。真实模型调用需要你自己填 key。

## 设计取舍

- Python 原版的线程在这里换成 async 协程和 `setInterval`，更贴合 Node 的事件循环；串行锁用一个 promise chain 实现，保证 REPL 交互轮和 cron 自动轮不会同时跑 agent。
- 主循环的助手文本走流式输出（`messages.stream`），子 agent 和队友用非流式 `create`，cron 自动轮也用非流式并通过 `terminalPrint` 回显，避免在用户正打字时直接写 stdout 冲掉输入行。
- 工具定义和 handler 是两张显式表而不是注解/装饰器，加一个能力就在两处各加一行，改动面小、可审查。
- 源码分层而不是摊平：依赖方向写进目录结构里，看一眼就知道某个模块能引用谁、不能引用谁。
