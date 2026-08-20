# deepseek-relay-check

检测中转站提供的 DeepSeek API 是**满血**还是**野鸡**。不看厂商声明、不看模型自述，只看一个客观指纹。

支持三种协议：**OpenAI Chat Completions** / **Anthropic Messages** / **OpenAI Responses**。

## 原理

DeepSeek V4 对**首轮可见工具目录（Schema Surface）** 极度敏感。

在 DeepSeek Harness 的 `minimal` 预设条件下——46 字符人设 + 只暴露 `bash` 和 `str_replace_editor` 两个工具——官方模型会落到 RL 训练时那条思维链轨迹：

```
We need inspect repo. Need find circular dependencies. Need list any. Let's start.
```

注意 `need` 后面**直接跟动词原形、不带 `to`**，主语也常省略。这个省略习惯是训练轨迹的特征，不是通用英语写法。

被降级、换权重或套壳的上游给不出这个语域，只会写：

```
The user wants me to check a repository for circular dependencies. Let me first explore...
Let me start by exploring the repository structure.
```

工具就是把这个夹具原样打 N 次，数命中率。

> 同一个官方端点，把工具目录换成 Standard 的几十个，命中率也会掉到 0。所以 `src/fixture.json` 里的两个 schema **一个字都不能改**，改了指纹就失效。

## 界面版

```bash
npm run ui          # 或 node bin/serve.mjs
```

打开 <http://127.0.0.1:8787>，填四样东西就能测：**Base URL / 模型 ID / 协议 / API Key**。
想对比就点「再加一个一起对比」，多个目标一起跑，跑完出汇总表。

Key 直接在页面上输，不读任何本机凭证文件、不存盘、不预填任何目标——这是个通用工具，
不该知道你机器上有什么。

跑的时候每一次的思维链**实时**逐条出现，当场标 满血 / 弱信号 / 未命中 / 错误。

**为什么需要本地服务而不是一个纯静态 html**：浏览器直连 `api.deepseek.com` 或各中转会被
CORS 挡死（这些端点不给跨域头，也没义务给）。所以页面只管界面，请求由本机 Node 进程发出。
服务只监听 `127.0.0.1`；Key 用 POST body 传（不走 URL，不进浏览器历史），只在内存里过一道。

## 用法

无依赖，Node ≥ 20 直接跑。

```bash
# 单个目标
node bin/check.mjs --base https://api.deepseek.com --model deepseek-v4-flash --key sk-xxx

# key 放环境变量
node bin/check.mjs --base https://某中转/v1 --model deepseek-v4-flash --key-env RELAY_KEY

# 从 KEY: value 形式的文件补充环境变量
node bin/check.mjs ... --creds C:/Users/你/.dsh/.credentials.yaml

# 批量对比（推荐：把官方放进去当基准）
node bin/check.mjs --targets targets.json --creds ~/.dsh/.credentials.yaml --runs 6

# 看每一次的原始思维链
node bin/check.mjs ... --verbose

# 接脚本
node bin/check.mjs ... --json
```

`targets.json` 格式见 `targets.example.json`：

```json
[
  { "label": "官方（基准）", "base": "https://api.deepseek.com", "model": "deepseek-v4-flash", "keyEnv": "DEEPSEEK_API_KEY" },
  { "label": "某中转",       "base": "https://relay.com/v1",     "model": "deepseek-v4-flash", "key": "sk-xxx" },
  { "label": "anthropic 口", "base": "https://relay.com/api/anthropic", "model": "DeepSeek-V4-Flash", "key": "sk-xxx", "protocol": "anthropic" }
]
```

`--protocol` 默认 `auto`，会依次试三种协议和各自的候选路径 / 鉴权头（`x-api-key` 与 `Bearer` 都试），哪个通用哪个。也可以按目标单独指定。

## 判定

| 结论 | 条件 |
|---|---|
| 满血 ✓ | 强命中率 ≥ 60% |
| 可疑 ~ | 0 < 强命中率 < 60% |
| 野鸡 ✗ | 零强命中 |
| 无法判定 ? | 上游不返回思维链原文，或思维链被加密 |

**强信号**只认省略形式（`We need inspect …`、`… . Need find …`）。
**弱信号**（`We need to …`、`Let's …` 起手）单独报出来，不计入满血——几乎所有模型都会写这种通用英语，拿它当判据会把野鸡放进来。

辅助信号（报出来但不打分）：`reasoning_tokens` 会计是否存在、延迟、`prompt_tokens`（分词器差异）、`--identity` 的身份自述。

## 实测结果（2026-08-20）

中转站名字匿名化，只留数据——重点是方法可复现，不是点名。你拿工具跑一遍就知道自己那家是哪一档。

| 目标 | 协议 | 强命中 | 平均延迟 | 判定 |
|---|---|---|---|---|
| 官方端点 `deepseek-v4-flash` | openai | 6/6 | 1094ms | 满血 ✓ |
| 官方端点 `deepseek-v4-flash` | responses | 3/3 | 1262ms | 满血 ✓ |
| 中转 A · 高价 SKU | openai | 6/6 | 2053ms | 满血 ✓ |
| 中转 A · 低价 SKU | openai | 0/6 | 2846ms | 野鸡 ✗ |
| 中转 B · OpenAI 口 | openai | 0/6 | 3256ms | 野鸡 ✗ |
| 中转 B · Anthropic 口 | anthropic | 1/6 | 3444ms | 可疑 ~ |

> 这是**行为指纹**，不是权重比对。命中率低只说明「行为与官方不一致」，成因可能是换权重、量化、套壳，
> 也可能是中转往请求里注入了自己的系统提示。结论只对「base + model + 协议」这个组合成立。

几个值得注意的现象：

- **同一家中转的两个 SKU 可以一个满血一个野鸡。** 上表中转 A 的两个 SKU 差价 2.2–3.3 倍，
  贵的那个满血、便宜的那个零命中。光看厂商名下不了结论。
- **同一家的两个协议口表现也可能不同**（中转 B 的 OpenAI 口 0/6、Anthropic 口 1/6），
  说明后端路由可能不是同一个。
- **官方端点在三种协议下都稳定满血**，所以官方是最可靠的基准线——建议每次都加一行官方对照着跑。

**按「base + model + 协议」逐个测。**

## 目录

```
bin/check.mjs        命令行
bin/serve.mjs        本地 UI 服务（SSE 推进度）
web/index.html       界面（单文件，无构建，浅色）
src/fixture.json     DSH minimal 首轮请求面 —— 改了指纹就失效
src/fixture.mjs
src/protocols.mjs    三个协议适配器 + 自动认协议
src/detect.mjs       指纹判据与打分
```

## 局限

- 这是**行为指纹**，不是权重比对。命中率低只能说明「行为和官方不一致」，造成不一致的原因可能是换权重、量化、套壳，也可能是中转往请求里塞了自己的系统提示。
- 只对**会返回思维链原文**的上游有效。Responses 协议有时只给摘要、Anthropic 可能返回加密的 `redacted_thinking`，这两种情况判「无法判定」而不是野鸡。
- 中文探针命中率天然低于英文（官方实测英文 6/6、中文 2/5），默认用英文判定，`--lang zh` 仅作参考，别拿中文结果判死刑。
- 概率性判据。`--runs` 越大越稳，判「可疑」时务必加大样本复测。
- 指纹随模型版本变化。DeepSeek 换代后需要用官方端点重新校准 `src/detect.mjs` 里的判据。
