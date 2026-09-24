# dsh-models-dev

用**活的** [models.dev](https://models.dev) 目录维护 DSH 提供方的模型目录。

DeepSeek Harness 里已配置的提供方，其模型行的模态（图片输入）与思考档位会随版本
发布逐渐过时，新模型也不会出现。本插件刷新你**已在使用**的提供方的 `models`
数组——补入新模型、就地更新已有模型的能力，用户手加的模型行保持不动。它
**不注册任何路由**：不产生重复的提供方。

## 安装

要求：Node.js >= 22.19，且 `pnpm` 在 `PATH` 上（`dsh plugin` 的包操作会转发到
profile 目录中的 pnpm）。推荐安装到 Web profile：

```sh
dsh plugin --profile web add dsh-models-dev
```

`--profile web` 必填——`dsh plugin add ...` 不是受支持的完整形式。命令背后的
DSH 插件管理器会读取本包的 `dsh.bundle.patch: ./cordis.patch.yml`，把
`dsh-models-dev` 加入 profile 的 `dsh.profile.bundles`
（`~/.dsh/profiles/web/package.json`），并把补丁组合进 profile 树。不需要复制
补丁，也不需要传 `--patch`：单跑 `pnpm add dsh-models-dev` 只会安装文件——未被
选中的依赖不会挂载，安装本身并不等于 bundle 选中。

安装完成后用 `dsh web` 启动。如果 Web 已在运行，新加的 bundle 在启用 HMR 的
profile 里通过实时重载生效；未启用 HMR 则需重启。替换已加载包的版本始终需要
重启进程。

可选的源码安装：

```sh
dsh plugin --profile web add github:M4cd1r/dsh-models-dev
```

Web 侧边栏的 **Plugins**（插件）页面是等价的 UI 入口：可把同样的 npm 包名或
GitHub 规格安装进当前管理的 profile。

包清单中的 `dsh.engines.dsh` 只是记录最低 DSH 版本的包元数据；当前 CLI 的兼容
性门槛检查的是声明的 peer dependency 范围，而非该字段。

## 工作方式

1. 抓取 `https://models.dev/api.json`（24 小时 TTL 缓存于
   `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`，断网时回退到缓存）。
2. 对每个已接入的路由（可配置提供方目录中的 llm-pi-ai 系列行）把 models.dev
   记录映射为 `models` 条目：`modalities.input` → `input`（图片输入开关），
   `reasoning_options` 档位值 → `reasoningEfforts`（思考档位及其发送值）。
3. 用设置接口的路径写入与修订号围栏把合并后的数组写回
   `providers.<route>.models`——与「模型能力」编辑器的写入完全一致。

路由的 `api`/`baseURL`（线上端点）比模型行谨慎得多，因为它决定请求发往哪个
端点、落在哪份账单上。缺失的字段一律保持缺失：llm-pi-ai 的内置目录通常已经
解析出该字段，用 models.dev 的端点去覆盖正是「把能用的路由指错口味」的根源
（models.dev 的 `zai` 是 Z.AI **开放平台**，而 pi-ai 的 `zai` 路由是 Z.AI
**Coding Plan**——钉住开放平台端点后每次调用都会变成
`429 Insufficient balance or no resource package`）。只有当 llm-pi-ai 的严格
校验拒绝写入（`needs an api` / `needs a baseURL`）时才写入线上字段；0.1.5–
0.1.7 留下的错误钉值，会在 `sources` 指明该路由实际订阅的 models.dev 提供方
后被自动修复。

> **从 0.1.5–0.1.7 升级：** 如果升级后某条路由开始报「余额/资源包」形状的 429，
> 请到 *设置 → 模型 →（提供方）编辑 → 自定义设置* 检查它的 `baseURL`。这些版本
> 会钉住同名 models.dev 提供方的端点；GLM Coding Plan 的密钥请在下方配置
> `sources: { zai: zai-coding-plan }`（或把 Base URL 改为
> `https://api.z.ai/api/coding/paas/v4`），下一次刷新即会修复。

## 入口

- **自动检查**——启动时一次、此后每 `refreshHours` 一次，覆盖所有已接入提供方
  （`autoSync`）。
- **刷新按钮**——位于 *设置 → 模型 →（提供方）编辑 → 模型能力* 的标题栏：
  一个地球图标（"update models from models.dev API"）。悬停时图标旋转 360°，
  移开后平滑归位；点击后地球平滑过渡为加载图标，等待期间持续旋转。完成后弹出
  通知卡片：成功卡片显示各路由的统计（`opencode-go: +2/~28`），失败卡片显示
  错误信息、主机日志与堆栈跟踪。点击立即刷新该提供方的模型行。

```
POST /api/dsh-models-dev/refresh   body: { "route": "opencode-go" }   # 或 {} 刷新全部
```

该端点与其他内置 `/api` 路由一样仅限 loopback（受信任的 LAN 请求由 dsh-lan
重放为 loopback）。

## 设置

```yaml
# ~/.dsh/settings.yaml
dsh-models-dev:
  refreshHours: 24        # 自动刷新周期（小时）
  autoSync: true          # 启动时与定时的自动检查
  modelsDevUrl: https://models.dev/api.json   # 可选
  cachePath: ...          # 可选：目录缓存位置
  sources:                # 可选：路由 -> models.dev 提供方 id 映射
    my-gateway: opencode-go
    zai: zai-coding-plan  # GLM Coding Plan 密钥：models.dev 的 `zai` 是开放平台
```

作用范围：**llm-pi-ai 系列**（`settingsNs: llm-pi-ai`）——本插件写入的模型形状
（`input`、`reasoningEfforts`）即该系列的 schema。其他适配器（如 DeepSeek）声明的
形状不同，保持不动。

启动链路的追踪记录保存在 `$DSH_HOME/plugins/dsh-models-dev/bootstrap.log`
（模块导入 → apply → 各步骤 → 失败堆栈）：没有日志 exporter 的部署里，
"Running" 状态会掩盖一切失败。

## 开发

```
npm install
npm run verify      # 语法 + 单元测试 + 线上 smoke
npm run bootstrap   # 用桩 ctx 重放宿主组合
```
