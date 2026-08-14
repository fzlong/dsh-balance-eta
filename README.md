# dsh-balance-eta

DeepSeek Harness (DSH) Web GUI 的极简余额插件：顶部胶囊条显示**余额 + 今日消耗 + 可用时长预测 + 低余额告警**。

```
DeepSeek 余额 ¥7.76 CNY · 今日 ¥0.12 · 约可用 49.0 天（日均 ¥0.16）
```

## 与其他 dsh-plugin 的区别

| | dsh-balance-eta（本插件） | dsh-balance-meter / dsh-cost-meter / dsh-deepseek-quota 等 |
|---|---|---|
| 数据源 | **只看官方余额数字的变化** | 读 tokenUsage × 价格表 |
| 官方调价（含峰谷） | **无需更新，自动适应** | 需内置价格引擎/定期抓定价页/发版同步 |
| 可用时长预测 | ✅ 「还能用几天/几小时」（生态独有） | ❌ 大多只显示"现在" |
| 低余额主动告警 | ✅ 变色 + 浏览器通知 | ❌ 少数只有被动展示 |
| 依赖 | 无（单文件，只注入 webServer） | 客户端 bundle/价格引擎/slot 系统 |
| 维护成本 | 价格无关，永久免维护 | 跟随官方政策 |

核心原理一句话：**不计算费用，只观察余额下降速度**——官方涨价/降价会实时反映在余额下降速率上，预测自动跟随，插件一行代码都不用改。

## 功能

- **余额 + 今日消耗**：官方 `/user/balance` 真实数据，今日消耗 = 当日开盘余额 − 当前余额（官方实际扣费结果）
- **可用时长预测**：安装当天即可用（今日消耗 ÷ 今日已过时间占比），跨天后 EWMA 平滑；天/小时/分钟自动切换，点击胶囊条手动刷新
- **低余额告警**：余额 < 阈值（默认 ¥5）变红；可用 < 3 天变黄；首次触发弹浏览器通知（不打扰，只弹一次）
- **隐私**：API key 只在服务端使用，绝不进入浏览器；不收集任何遥测

## 安装

1. 把 `dsh-balance-eta.mjs` 复制到 `~/.dsh/profiles/web/`（Windows: `%USERPROFILE%\.dsh\profiles\web\`）
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: balance-eta
      name: './dsh-balance-eta.mjs'
```

3. 刷新页面（补丁层热重载，无需重启 dsh web）

> 前提：已配置 DeepSeek API key（DSH 设置 → Models 页，或导出 `DEEPSEEK_API_KEY` 环境变量）。

## 配置（可选）

```yaml
- insert:
    - id: balance-eta
      name: './dsh-balance-eta.mjs'
      config:
        refreshMs: 60000      # 刷新间隔毫秒
        lowBalanceCny: 5      # 低余额告警阈值（元）
        warnDaysLeft: 3       # 可用天数告警阈值（天）
        notify: true          # 浏览器通知
        ewmaAlpha: 0.3        # EWMA 平滑系数（越大越跟手）
        apiKeyEnv: DEEPSEEK_API_KEY   # 凭据 ref 名
```

## 如何工作

```
官方余额接口（真实人民币余额）
    ↓ 每次刷新记一个点
今日消耗 = 今日开盘余额 − 当前余额          ← 官方实际扣费
    ↓
今日日均 = 今日消耗 ÷ 今日已过时间占比       ← 当天即可预测
    ↓（跨天后）
EWMA 指数加权平滑                           ← 近期用量权重更高
    ↓
可用时长 = 余额 ÷ 日均消耗                  ← 天/小时/分钟
```

价格无关键：涨价/降价/峰谷调整只改变余额下降的速度，不改变算法，因此**官方调价对本插件零影响**。

## 限制

- **仅支持 CNY（人民币）账户**：插件读取官方余额中的 `CNY` 行。非人民币账户会得到明确提示而非错误数字，不会伪装成 ¥0.00。
- 预测是线性外推（假设未来消耗速率 ≈ 近期），用量波动大时会有偏差；数据积累越久越准。

## 许可

MIT
