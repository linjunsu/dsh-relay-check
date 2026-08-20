#!/usr/bin/env node
/**
 * dsrc — DeepSeek 中转站满血检测。
 *
 * 用法见 README，或 `node bin/check.mjs --help`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { probe, verdict, identity, isFullPower } from '../src/detect.mjs'
import { PROTOCOL_IDS } from '../src/protocols.mjs'

const HELP = `
dsrc — 检测中转站的 DeepSeek 是满血还是野鸡

  node bin/check.mjs --base <url> --key <key> --model <id> [选项]
  node bin/check.mjs --targets targets.json [选项]

必填（单目标模式）
  --base <url>        API 根地址，如 https://api.deepseek.com
  --model <id>        模型 id，如 deepseek-v4-flash
  --key <key>         API key
  --key-env <NAME>    从环境变量取 key（与 --key 二选一）

选项
  --targets <file>    批量模式：JSON 数组，字段同上，另可加 label
  --protocol <p>      ${PROTOCOL_IDS.join(' | ')} | auto（默认 auto，自动认）
  --runs <n>          每个目标跑几次，默认 6。样本越多结论越稳
  --lang en|zh        探针语言，默认 en（中文命中率天然偏低，别用来判死刑）
  --effort <e>        reasoning effort，默认 max
  --creds <file>      从 KEY: value 形式的文件补充环境变量（如 ~/.dsh/.credentials.yaml）
  --identity          附带身份自述探针（辅助信号，不参与打分）
  --verbose           打印每一次的思维链开头
  --json              输出 JSON，便于接脚本
  --help              显示本帮助

判定
  满血 ✓  命中率 ≥ 60%     野鸡 ✗  零命中
  可疑 ~  0 < 命中率 < 60%  无法判定 ?  拿不到思维链原文
`

function parseArgs(argv) {
  const o = { protocol: 'auto', runs: 6, lang: 'en', effort: 'max' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--base') o.base = next()
    else if (a === '--key') o.key = next()
    else if (a === '--key-env') o.keyEnv = next()
    else if (a === '--model') o.model = next()
    else if (a === '--label') o.label = next()
    else if (a === '--targets') o.targets = next()
    else if (a === '--protocol') o.protocol = next()
    else if (a === '--runs' || a === '-n') o.runs = Number(next())
    else if (a === '--lang') o.lang = next()
    else if (a === '--effort') o.effort = next()
    else if (a === '--creds') o.creds = next()
    else if (a === '--identity') o.identity = true
    else if (a === '--verbose' || a === '-v') o.verbose = true
    else if (a === '--json') o.json = true
    else throw new Error(`未知参数: ${a}`)
  }
  return o
}

/** 把 `NAME: value` 形式的凭证文件读进 process.env，已存在的不覆盖。 */
function loadCreds(file) {
  const text = fs.readFileSync(path.resolve(file), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']?([^"'#]+?)["']?\s*$/.exec(line)
    if (m === null) continue
    process.env[m[1]] ??= m[2].trim()
  }
}

/** key 可以直接给，也可以从环境变量取；批量文件里两种都支持。 */
function resolveKey(t) {
  if (typeof t.key === 'string' && t.key.length > 0) return t.key
  if (typeof t.keyEnv === 'string') {
    const v = process.env[t.keyEnv]
    if (typeof v === 'string' && v.length > 0) return v
    throw new Error(`环境变量 ${t.keyEnv} 没设置或为空`)
  }
  throw new Error(`目标 ${t.label ?? t.model} 缺少 key / keyEnv`)
}

function loadTargets(o) {
  if (o.targets !== undefined) {
    const file = path.resolve(o.targets)
    const list = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(list)) throw new Error('targets 文件必须是 JSON 数组')
    return list.map(t => ({ ...t, key: resolveKey(t), label: t.label ?? `${t.model}` }))
  }
  if (o.base === undefined || o.model === undefined) throw new Error('缺少 --base / --model（或用 --targets）')
  return [{ base: o.base, model: o.model, key: resolveKey(o), label: o.label ?? o.model }]
}

const pad = (s, n) => String(s).padEnd(n)
const padS = (s, n) => String(s).padStart(n)

/** 中文字符占两列，padEnd 会把表格排歪，这里按显示宽度补。 */
function padDisp(s, n) {
  const str = String(s)
  let w = 0
  for (const ch of str) w += /[一-龥＀-￯]/.test(ch) ? 2 : 1
  return str + ' '.repeat(Math.max(0, n - w))
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help === true) { console.log(HELP); return }

  if (o.creds !== undefined) loadCreds(o.creds)
  const targets = loadTargets(o)
  const out = []

  for (const t of targets) {
    const r = await probe(t, { protocol: t.protocol ?? o.protocol, runs: o.runs, lang: o.lang, effort: o.effort })
    const v = verdict(r)
    r.verdict = v
    if (o.identity === true && r.protocol !== undefined) {
      r.identity = await identity(t, r.protocol)
    }
    out.push(r)

    if (o.json !== true) {
      console.log(`\n### ${t.label}`)
      console.log(`    ${t.base}  ·  ${t.model}`)
      if (r.error !== undefined) { console.log(`    ${v.mark} ${v.tag} — ${v.note}`); continue }
      console.log(`    协议 ${r.protocolLabel} (${r.protocol})   端点 ${r.endpoint}`)
      const rateTxt = r.rate === null ? '—' : `${r.hits}/${r.judged} (${Math.round(r.rate * 100)}%)`
      console.log(`    满血命中 ${rateTxt}   平均 reasoning_tokens ${r.avgReasoningTokens ?? '—'}   `
        + `prompt_tokens ${r.avgPromptTokens ?? '—'}   平均延迟 ${r.avgMs ?? '—'}ms`)
      if (r.weak > 0) console.log(`    弱信号 ${r.weak} 次（起手像但无省略特征，不计满血）`)
      if (r.noReasoning > 0) console.log(`    ⚠ 有 ${r.noReasoning} 次没返回思维链`)
      if (r.redacted > 0) console.log(`    ⚠ 有 ${r.redacted} 次思维链被加密`)
      console.log(`    → ${v.mark} ${v.tag}${v.note === '' ? '' : ' — ' + v.note}`)
      if (o.verbose === true) {
        for (const s of r.samples) {
          if (s.error !== undefined) { console.log(`      [错误] ${s.error}`); continue }
          const hit = isFullPower(s.reasoning)
          console.log(`      ${hit ? '>>满血<<' : '        '} ${JSON.stringify((s.reasoning || '(空)').slice(0, 92))}`)
        }
      }
      if (r.identity !== undefined) {
        console.log('    身份自述（辅助信号，模型自述不可全信）:')
        for (const { q, a } of r.identity) console.log(`      Q ${q.slice(0, 60)}\n      A ${a}`)
      }
    }
  }

  if (o.json === true) { console.log(JSON.stringify(out.map(stripRaw), null, 2)); return }

  if (out.length > 1) {
    console.log('\n=== 汇总 ===')
    console.log(padDisp('目标', 26), pad('协议', 12), padS('命中', 12), padS('rt', 6), padS('延迟', 9), '  判定')
    for (const r of out) {
      const rateTxt = r.error !== undefined || r.rate === null ? '—' : `${r.hits}/${r.judged} (${Math.round(r.rate * 100)}%)`
      console.log(padDisp(r.target.label, 26), pad(r.protocol ?? '—', 12), padS(rateTxt, 12),
        padS(r.avgReasoningTokens ?? '—', 6), padS((r.avgMs ?? '—') + 'ms', 9), `  ${r.verdict.mark} ${r.verdict.tag}`)
    }
  }
}

/** JSON 输出里去掉原始响应，否则一个目标就几十 KB。 */
function stripRaw(r) {
  return { ...r, samples: r.samples?.map(({ raw, ...rest }) => rest) }
}

main().catch(e => { console.error('错误:', e.message); process.exitCode = 1 })
