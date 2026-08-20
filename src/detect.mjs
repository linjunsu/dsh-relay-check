/**
 * 判定逻辑。
 *
 * 原理：DeepSeek V4 在 DSH minimal 的首轮请求面下，会落到 RL 训练时那条
 * 省冠词的 "We need inspect repo. Need find …" 轨迹；被降级/换权重/套壳的
 * 上游给不出这个语域，只会写 "The user wants me to … Let me first …"。
 * 于是「同一份请求跑 N 次，看命中几次」就是一个不依赖自述、不依赖厂商
 * 声明的客观指纹。
 */
import { PROTOCOLS, PROTOCOL_IDS, send } from './protocols.mjs'
import { SYSTEM, TOOLS, TASKS, IDENTITY_PROMPTS } from './fixture.mjs'

const REDACTED = '\u0000redacted'

/**
 * 满血语域的判据。
 *
 * 关键在**省略**：官方 V4 在这个请求面下写的是 "We need inspect repo. Need find
 * circular dependencies."——`need` 后面直接跟动词原形，不带 `to`，句子也常省主语。
 * 这个省略习惯是 RL 轨迹的特征。而 "We need **to** check the repository" 是几乎
 * 所有模型都会写的通用英语，拿它当判据会把野鸡也放进来（实测 nube 就是这样
 * 混过 50% 的）。所以强信号只认省 `to` 的形式。
 */
const STRONG = [
  /\bwe need (?!to\b)[a-z]/i,                                  // "We need inspect …"
  /(?:^|[.!?]\s+)need (?!to\b)[a-z]+/i,                        // "… . Need find …"
  /\bwe (?:can|should|must|will) (?:use|list|inspect|check|explore|look)\b/i,
]

/** 弱信号：只看起手词。单独出现不算满血，仅作参考列。 */
const WEAK = /^\s*(we\b|let's|let us\b)/i

/** 一条思维链是否带满血指纹（强信号）。 */
export function isFullPower(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return STRONG.some(re => re.test(text))
}

/** 只有起手词像、但没有省略特征——用来解释「可疑」是怎么来的。 */
export function isWeakOnly(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return !isFullPower(text) && WEAK.test(text)
}

/** 自动认协议：每个协议发一发最小请求，谁先通用谁。 */
export async function detectProtocol(target, order = PROTOCOL_IDS) {
  for (const id of order) {
    const proto = PROTOCOLS[id]
    const payload = {
      system: SYSTEM,
      user: 'say ok',
      maxTokens: 64,
      ...id === 'anthropic' ? { thinkingBudget: undefined } : {},
    }
    const r = await send(proto, target, payload)
    if (r.ok) return { id, proto, pinned: r.pinned }
  }
  return null
}

/**
 * 跑一轮指纹检测。
 * @param target - {base, key, model, label}
 * @param options - {protocol, runs, lang, effort, maxTokens}
 * @returns 汇总结果
 */
export async function probe(target, options = {}) {
  const runs = options.runs ?? 6
  const lang = options.lang ?? 'en'
  const effort = options.effort ?? 'max'
  const maxTokens = options.maxTokens ?? 2000

  let chosen
  if (options.protocol !== undefined && options.protocol !== 'auto') {
    const proto = PROTOCOLS[options.protocol]
    if (proto === undefined) throw new Error(`未知协议: ${options.protocol}`)
    chosen = { id: options.protocol, proto, pinned: undefined }
  } else {
    chosen = await detectProtocol(target)
    if (chosen === null) return { target, error: '三种协议都打不通（检查 base / key / 网络）' }
  }

  const payload = {
    system: SYSTEM,
    user: TASKS[lang] ?? TASKS.en,
    tools: TOOLS,
    effort,
    maxTokens,
    // Anthropic 的 budget 必须小于 max_tokens。
    thinkingBudget: chosen.id === 'anthropic' ? Math.floor(maxTokens / 2) : undefined,
  }

  const emit = typeof options.onSample === 'function' ? options.onSample : () => {}
  options.onProtocol?.({ id: chosen.id, label: chosen.proto.label })
  const samples = []
  let pinned = chosen.pinned
  let firstError
  // 打不通就别刷屏：连着两次同样的错就收手，剩下的记成跳过。
  // 一个端点连错两次，第三次到第十二次不会有新信息，只会把真因埋进重复里。
  let lastErr, sameCount = 0, skipped = 0
  for (let i = 0; i < runs; i++) {
    if (sameCount >= 2) { skipped = runs - i; break }
    const r = await send(chosen.proto, target, payload, pinned)
    if (!r.ok) {
      firstError ??= r.error
      // 有的上游不吃 reasoning 参数，摘掉再试一次。
      const retry = await send(chosen.proto, target, { ...payload, effort: undefined, thinkingBudget: undefined }, pinned)
      if (!retry.ok) {
        const bad = { error: r.error }
        sameCount = r.error === lastErr ? sameCount + 1 : 1
        lastErr = r.error
        samples.push(bad); emit(bad, i); continue
      }
      pinned = retry.pinned
      sameCount = 0
      samples.push(retry.data)
      emit(retry.data, i)
      continue
    }
    pinned = r.pinned
    sameCount = 0
    samples.push(r.data)
    emit(r.data, i)
  }

  const ok = samples.filter(s => s.error === undefined)
  const withText = ok.filter(s => s.reasoning !== '' && s.reasoning !== REDACTED)
  const redacted = ok.filter(s => s.reasoning === REDACTED).length
  const hits = withText.filter(s => isFullPower(s.reasoning)).length
  const weak = withText.filter(s => isWeakOnly(s.reasoning)).length
  const avg = (pick) => {
    const v = ok.map(pick).filter(x => typeof x === 'number')
    return v.length === 0 ? null : Math.round(v.reduce((a, b) => a + b, 0) / v.length)
  }

  return {
    target,
    protocol: chosen.id,
    protocolLabel: chosen.proto.label,
    endpoint: pinned?.url ?? null,
    runs,
    lang,
    okCount: ok.length,
    skipped,
    noReasoning: ok.length - withText.length - redacted,
    redacted,
    hits,
    weak,
    judged: withText.length,
    rate: withText.length === 0 ? null : hits / withText.length,
    avgReasoningTokens: avg(s => s.reasoningTokens),
    avgPromptTokens: avg(s => s.promptTokens),
    avgMs: avg(s => s.ms),
    samples,
    firstError: ok.length === 0 ? (firstError ?? samples[0]?.error) : undefined,
  }
}

/** 把命中率翻译成结论。 */
export function verdict(r) {
  if (r.error !== undefined) return { tag: '打不通', mark: '!', note: r.error }
  if (r.okCount === 0) {
    const hint = /invalid api key|authentication|unauthorized|401/i.test(r.firstError ?? '')
      ? '——这个 Key 在该端点上不认，确认 Key 和 Base URL 是同一家'
      : (/not allowed|404|405|HTML/i.test(r.firstError ?? '')
        ? '——路径不对，确认 Base URL 要不要带 /v1，或把协议改回「自动识别」'
        : '')
    return { tag: '打不通', mark: '!', note: (r.firstError ?? '全部请求失败') + hint }
  }
  if (r.redacted > 0 && r.judged === 0) return { tag: '无法判定', mark: '?', note: '思维链被加密（redacted_thinking），拿不到明文' }
  if (r.judged === 0) return { tag: '无法判定', mark: '?', note: '上游不返回思维链原文，指纹不可用' }
  if (r.rate >= 0.6) return { tag: '满血', mark: '✓', note: '' }
  if (r.rate > 0) return { tag: '可疑', mark: '~', note: '部分命中，建议加大 --runs 复测' }
  const why = r.weak > 0
    ? `零强命中；有 ${r.weak} 次只是 we/let's 起手，但没有省略特征`
    : '零命中，语域与官方不一致'
  return { tag: '野鸡', mark: '✗', note: why }
}

/** 辅助信号：让模型自述身份。不参与打分，仅供参考。 */
export async function identity(target, protocolId) {
  const proto = PROTOCOLS[protocolId] ?? PROTOCOLS.openai
  const out = []
  for (const q of IDENTITY_PROMPTS) {
    const r = await send(proto, target, { system: 'You are a helpful assistant.', user: q, maxTokens: 120 })
    if (!r.ok) { out.push({ q, a: `(失败: ${r.error})` }); continue }
    const j = r.data.raw
    const text = j?.choices?.[0]?.message?.content
      ?? (Array.isArray(j?.content) ? j.content.filter(b => b?.type === 'text').map(b => b.text).join('') : undefined)
      ?? (Array.isArray(j?.output) ? j.output.flatMap(i => i?.content ?? []).map(p => p?.text ?? '').join('') : '')
    out.push({ q, a: String(text).trim().slice(0, 200) })
  }
  return out
}
