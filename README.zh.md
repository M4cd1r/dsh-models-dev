# dsh-models-dev

**为 DeepSeek Harness LLM 提供商提供实时 [models.dev](https://models.dev) 目录。**

`dsh-llm-pi-ai` 使用 pi-ai **内置**的目录解析提供商和模型 —— 那是 models.dev 在构建时的快照，会在版本之间过时。当 OpenCode Go 添加 `mimo-v2.6-pro`（2026-09-22）时，所有已安装的 pi-ai 目录都没有它，dsh 拒绝了该路由：*„provider "opencode-go" model "mimo-v2.6-pro" needs an api; the installed catalog does not describe it"*。

本插件为其所拥有的路由替换该快照机制：在启动时及每隔 `refreshHours` 获取 `https://models.dev/api.json`，把已配置提供商的模型映射为 pi-ai 模型条目（协议、端点、价格、限制、模态），并通过 `llm-pi-ai` 使用的同一个 `ctx.llm` seam 注册路由。models.dev 上的新模型无需等待 pi-ai 发版即可出现。

## 安装

```
dsh plugin --profile web add dsh-models-dev
```

之后重启 dsh（插件通过 profile bundle patch 挂载）。

## 配置

`~/.dsh/settings.yaml` 中的 `dsh-models-dev` 段：

```yaml
dsh-models-dev:
  refreshHours: 24          # 目录刷新间隔（可选）
  providers:
    opencode-go:            # dsh 路由键 —— 该键决定共存还是替换
      source: opencode-go   # models.dev 提供商 id（默认等于路由键）
      apiKeyEnv: OPENCODE_GO_API_KEY
```

这样就够了：models.dev 为 `opencode-go` 列出的每个可用模型（`tool_call` 且非 deprecated）都会成为可选的 dsh 模型。

**替换模式** —— 复用 llm-pi-ai 正在服务的键（`opencode-go`），但要先从 `llm-pi-ai.providers` *删除*该路由；一个路由键只能被一个 adapter 注册。

**共存模式** —— 选一个 llm-pi-ai 未使用的键：

```yaml
dsh-models-dev:
  providers:
    opencode-go-live:
      source: opencode-go
      apiKeyEnv: OPENCODE_GO_API_KEY
      models:                       # 可选：只服务子集 / 覆盖字段
        - id: mimo-v2.6-pro
          name: MiMo V2.6 Pro
          maxTokens: 131072         # 显式 maxTokens 同时成为请求的默认上限
```

路由字段：`source`、`displayName`、`apiKeyEnv`、`baseURL`、`api`（为所有模型强制一种线协议）、`defaultContextWindow`、`defaultMaxTokens`、`models`（id + 可选的 `name`/`contextWindow`/`maxTokens`/`input`/`reasoning` 覆盖；一旦提供，只服务列出的 id）。

## 工作原理

1. **获取** —— 启动时及每隔 `refreshHours` 获取 `models.dev/api.json`，缓存在 `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`；网络故障时继续服务最后缓存的目录（并记为 stale）。
2. **映射** —— 纯映射（`lib/map.mjs`），遵循 pi-ai `generate-models.ts` 的规则：`provider.npm`（可按模型覆盖）决定线协议（`@ai-sdk/anthropic` → `anthropic-messages`、`@ai-sdk/openai` → `openai-responses`，其余 → `openai-completions`）；`provider.api` 是基址（Anthropic 路由调整为 SDK 追加 `/v1/messages` 的形状）；价格/限制/模态 1:1 映射；交错的 `reasoning_content` 标记 replay 兼容性。pi-ai 能从提供商 id + baseURL 推断的兼容开关一律留空，由它自行检测。
3. **注册** —— 单个 `PiAiAdapter`（复用自 `@deepseek-ai/dsh-llm-pi-ai`）通过 `ctx.llm.registerAdapter` 服务所有路由，并注册 `registerConfigurableProviders`（设置界面）与 `registerModelDiscovery`（基于 models.dev 的「获取模型」）。宿主类从正在运行的 dsh 自身的模块实例解析，保证 seam 看到一致的类标识。

## 限制（0.1.0）

- 尚未映射 `thinkingLevelMap` / `reasoning_options` 推理级别（仅 `reasoning: true|false`）。
- `google-generative-ai` 模型会被报告为不可用（列出但无法派发）。
- 缺少 `tool_call: true` 的模型以及 `status: deprecated` 的模型会被跳过（编码代理用不了它们）。

## 开发

```
npm run verify   # 语法检查 + 单元测试 + smoke（models.dev 实测尽力而为）
```

## 许可证

MIT
