# dsh-models-dev

用**活的** [models.dev](https://models.dev) 目录维护 DSH 提供方的模型目录。

DeepSeek Harness 里已配置的提供方，其模型行的模态（图片输入）与思考档位会随版本
发布逐渐过时，新模型也不会出现。本插件刷新你**已在使用**的提供方的 `models`
数组——补入新模型、就地更新已有模型的能力，用户手加的模型行保持不动。它
**不注册任何路由**：不产生重复的提供方。

## 工作方式

1. 抓取 `https://models.dev/api.json`（24 小时 TTL 缓存于
   `$DSH_HOME/plugins/dsh-models-dev/models.dev.json`，断网时回退到缓存）。
2. 对每个已接入的路由（可配置提供方目录中的 llm-pi-ai 系列行）把 models.dev
   记录映射为 `models` 条目：`modalities.input` → `input`（图片输入开关），
   `reasoning_options` 档位值 → `reasoningEfforts`（思考档位及其发送值）。
3. 用设置接口的路径写入与修订号围栏把合并后的数组写回
   `providers.<route>.models`——与「模型能力」编辑器的写入完全一致。

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
