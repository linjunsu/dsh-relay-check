/**
 * 三种协议的适配器：OpenAI Chat Completions / Anthropic Messages /
 * OpenAI Responses。
 *
 * 每个适配器只负责三件事：把同一份夹具翻译成本协议的请求体、试出可用的
 * 端点路径、再把响应里的思维链和用量抠回统一形状。判定逻辑一概不在这里。
 */

const JSON_CT = { 'content-type': 'application/json' }

/** 去掉结尾斜杠，避免拼出 //v1 这种路径。 */
const trim = (base) => base.replace(/\/+$/, '')

/** 统一的探测结果。 */
function result({ reasoning, reasoningTokens, promptTokens, outputTokens, cachedTokens, finish, ms, raw }) {
  return {
    reasoning: reasoning ?? '',
    reasoningTokens: reasoningTokens ?? null,
    promptTokens: promptTokens ?? null,
    outputTokens: outputTokens ?? null,
    cachedTokens: cachedTokens ?? null,
    finish: finish ?? null,
    ms,
    raw,
  }
}

/** 从 JSON 里挖出错误信息，各家壳子不一样。 */
export function errorOf(json, status) {
  if (json === null || typeof json !== 'object') return `HTTP ${status}`
  const e = json.error ?? json
  const msg = e?.message ?? e?.msg ?? (typeof e === 'string' ? e : undefined)
  return msg === undefined ? `HTTP ${status}` : String(msg)
}

/**
 * 把响应体压成一行可读的错误。
 * 反向代理（nginx 等）会吐整页 HTML，原样显示既刷屏又盖住真因。
 * @param text - 响应体原文。
 * @param status - HTTP 状态码。
 * @returns 单行错误描述。
 */
function briefBody(text, status) {
  const t = String(text ?? '')
  const looksHtml = /^\s*<(!doctype|html)/i.test(t) || /<title>/i.test(t)
  if (looksHtml) {
    const title = /<title>([^<]*)<\/title>/i.exec(t) ?? /<h1>([^<]*)<\/h1>/i.exec(t)
    return `HTTP ${status} ${title === null ? '(HTML 错误页)' : title[1].trim()}`
  }
  const one = t.replace(/\s+/g, ' ').trim()
  return one === '' ? `HTTP ${status}` : `HTTP ${status}: ${one.slice(0, 160)}`
}

// ── OpenAI Chat Completions ────────────────────────────────────────────────

const openai = {
  id: 'openai',
  label: 'OpenAI Chat Completions',
  candidates: (base) => [`${trim(base)}/chat/completions`, `${trim(base)}/v1/chat/completions`],
  headerSets: (key) => [{ authorization: `Bearer ${key}`, ...JSON_CT }],
  body: ({ model, system, user, tools, effort, maxTokens }) => ({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    ...tools === undefined ? {} : {
      tools: tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    },
    ...effort === undefined ? {} : { reasoning_effort: effort },
    max_tokens: maxTokens,
  }),
  // 有的中转把思维链放 reasoning_content（DeepSeek 原生），有的放 reasoning。
  parse: (j, ms) => {
    const m = j?.choices?.[0]?.message ?? {}
    const r = m.reasoning_content ?? m.reasoning
    return result({
      reasoning: typeof r === 'string' ? r : '',
      reasoningTokens: j?.usage?.completion_tokens_details?.reasoning_tokens,
      promptTokens: j?.usage?.prompt_tokens,
      outputTokens: j?.usage?.completion_tokens,
      cachedTokens: j?.usage?.prompt_tokens_details?.cached_tokens ?? j?.usage?.prompt_cache_hit_tokens,
      finish: j?.choices?.[0]?.finish_reason,
      ms,
      raw: j,
    })
  },
}

// ── Anthropic Messages ─────────────────────────────────────────────────────

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic Messages',
  candidates: (base) => [`${trim(base)}/v1/messages`, `${trim(base)}/messages`],
  // 先试官方的 x-api-key，不行再退 Bearer——不少中转只认后者。
  headerSets: (key) => [
    { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...JSON_CT },
    { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', ...JSON_CT },
  ],
  body: ({ model, system, user, tools, maxTokens, thinkingBudget }) => ({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    ...tools === undefined ? {} : {
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    },
    // budget 必须严格小于 max_tokens，否则上游直接 400。
    ...thinkingBudget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: thinkingBudget } },
    max_tokens: maxTokens,
  }),
  parse: (j, ms) => {
    const blocks = Array.isArray(j?.content) ? j.content : []
    const think = blocks.find(b => b?.type === 'thinking')
    const redacted = blocks.some(b => b?.type === 'redacted_thinking')
    // Anthropic 把命中缓存的输入单列在 cache_read_input_tokens 里，input_tokens
    // 只剩未命中的部分。要和 OpenAI 的 prompt_tokens 可比就得加回来，否则同一份
    // 请求在两个协议下的 token 数会差一个数量级。
    const u = j?.usage ?? {}
    const promptTotal = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
      .filter(n => typeof n === 'number').reduce((a, b) => a + b, 0)
    return result({
      // 加密的 thinking 块拿不到明文，标记出来让上层降级判定。
      reasoning: typeof think?.thinking === 'string' ? think.thinking : (redacted ? '\u0000redacted' : ''),
      promptTokens: promptTotal === 0 ? undefined : promptTotal,
      outputTokens: u.output_tokens,
      cachedTokens: u.cache_read_input_tokens,
      finish: j?.stop_reason,
      ms,
      raw: j,
    })
  },
}

// ── OpenAI Responses ───────────────────────────────────────────────────────

const responses = {
  id: 'responses',
  label: 'OpenAI Responses',
  candidates: (base) => [`${trim(base)}/responses`, `${trim(base)}/v1/responses`],
  headerSets: (key) => [{ authorization: `Bearer ${key}`, ...JSON_CT }],
  body: ({ model, system, user, tools, effort, maxTokens }) => ({
    model,
    instructions: system,
    input: user,
    ...tools === undefined ? {} : {
      tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    },
    ...effort === undefined ? {} : { reasoning: { effort } },
    max_output_tokens: maxTokens,
  }),
  parse: (j, ms) => {
    const items = Array.isArray(j?.output) ? j.output : []
    const think = items.filter(i => i?.type === 'reasoning')
    // Responses 有时只给摘要不给原文；两处都捞一遍。
    const text = think.flatMap(i => [
      ...(Array.isArray(i.summary) ? i.summary : []),
      ...(Array.isArray(i.content) ? i.content : []),
    ]).map(p => p?.text ?? '').filter(Boolean).join('\n')
    return result({
      reasoning: text,
      reasoningTokens: j?.usage?.output_tokens_details?.reasoning_tokens,
      promptTokens: j?.usage?.input_tokens,
      outputTokens: j?.usage?.output_tokens,
      cachedTokens: j?.usage?.input_tokens_details?.cached_tokens,
      finish: j?.status,
      ms,
      raw: j,
    })
  },
}

export const PROTOCOLS = { openai, anthropic, responses }
export const PROTOCOL_IDS = Object.keys(PROTOCOLS)

/**
 * 发一次请求，自动在候选路径 × 候选鉴权头里找出能用的组合。
 * @param proto - 协议适配器。
 * @param target - {base, key, model}。
 * @param payload - 传给 proto.body 的参数。
 * @param pinned - 已经试出来的 {url, headerIndex}，命中后直接复用，省掉重复探测。
 * @returns {ok, data|error, pinned}
 */
export async function send(proto, target, payload, pinned) {
  const urls = pinned?.url === undefined ? proto.candidates(target.base) : [pinned.url]
  const heads = proto.headerSets(target.key)
  const headIdxs = pinned?.headerIndex === undefined ? heads.map((_, i) => i) : [pinned.headerIndex]
  // 收集每次尝试的失败，最后按信息量挑一条报出去。
  // 之前直接用最后一次的 `last`，结果永远是兜底候选路径（比如 nginx 的 405 HTML），
  // 把第一个候选的真因（401 invalid api key 之类）盖得死死的。
  const fails = []
  for (let ui = 0; ui < urls.length; ui++) {
    const url = urls[ui]
    for (const hi of headIdxs) {
      const t0 = Date.now()
      let status = 0
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: heads[hi],
          body: JSON.stringify(proto.body({ ...payload, model: target.model })),
        })
        status = r.status
        const txt = await r.text()
        let j = null
        try { j = JSON.parse(txt) } catch { /* 非 JSON，多半是代理的 HTML 错误页 */ }
        // Responses 协议成功时也会带 error 字段，值是 null——只有非空才算真错。
        const errored = j !== null && j.error !== undefined && j.error !== null
        if (r.ok && j !== null && !errored) {
          return { ok: true, data: proto.parse(j, Date.now() - t0), pinned: { url, headerIndex: hi } }
        }
        fails.push({ ui, url, status, structured: j !== null, message: j === null ? briefBody(txt, status) : errorOf(j, status) })
      } catch (e) {
        fails.push({ ui, url, status, structured: false, message: e.message })
      }
    }
  }
  if (fails.length === 0) return { ok: false, error: 'no attempt' }
  // 上游返回的结构化 JSON 错误才说明请求真到了模型服务；HTML / 连接错误多半只是路径猜错。
  // 同类里取候选序号最小的（第一个候选是最可能正确的路径）。
  const rank = f => (f.structured ? 0 : 1) * 100 + f.ui
  fails.sort((a, b) => rank(a) - rank(b))
  const best = fails[0]
  const others = fails.filter(f => f.url !== best.url).length
  return {
    ok: false,
    error: best.message + `（${best.url}${others > 0 ? `；另外 ${others} 个候选路径也没通` : ''}）`,
  }
}
