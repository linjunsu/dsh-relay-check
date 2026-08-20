#!/usr/bin/env node
/**
 * 本地 UI 服务。
 *
 * 为什么必须有服务端：浏览器直连 api.deepseek.com / 各中转会被 CORS 挡死
 * （这些端点不给跨域头，也没义务给）。所以页面只管界面，真正的请求由这个
 * 进程发出去。key 由用户在界面上输，只在内存里过一道，不落盘。
 *
 * 只监听 127.0.0.1。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe, verdict, isFullPower, isWeakOnly } from '../src/detect.mjs'
import { PROTOCOL_IDS } from '../src/protocols.mjs'

const ROOT = fileURLToPath(new URL('../web/', import.meta.url))
const PROJECT = fileURLToPath(new URL('../', import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

/** 读 body，限 1MB，防止误发大文件把内存吃掉。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0
    const parts = []
    req.on('data', c => {
      n += c.length
      if (n > 1_000_000) { reject(new Error('请求体过大')); req.destroy(); return }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // ── 静态 ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'))
    res.writeHead(200, { 'content-type': TYPES['.html'] })
    return res.end(html)
  }

  // ── 元信息：只给协议列表。目标一律由用户在界面上填，不读本机文件。 ──
  if (req.method === 'GET' && url.pathname === '/api/meta') {
    return json(res, 200, { protocols: PROTOCOL_IDS })
  }

  // ── 检测：SSE，边跑边推 ──
  if (req.method === 'POST' && url.pathname === '/api/check') {
    let body
    try { body = JSON.parse(await readBody(req)) } catch (e) { return json(res, 400, { error: e.message }) }
    const { targets = [], runs = 6, lang = 'en', effort = 'max' } = body

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const push = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    let aborted = false
    req.on('close', () => { aborted = true })

    for (let ti = 0; ti < targets.length; ti++) {
      if (aborted) break
      const t = { ...targets[ti] }
      push('target-start', { index: ti, label: t.label })
      if (typeof t.key !== 'string' || t.key === '') {
        push('target-done', { index: ti, result: { target: { label: t.label }, error: '没填 Key', verdict: { tag: '打不通', mark: '!', note: '没填 Key' } } })
        continue
      }
      try {
        const r = await probe(t, {
          protocol: t.protocol ?? 'auto', runs, lang, effort,
          onProtocol: (p) => push('protocol', { index: ti, ...p }),
          onSample: (s, i) => push('sample', {
            index: ti, run: i,
            error: s.error ?? null,
            hit: s.error === undefined && isFullPower(s.reasoning),
            weak: s.error === undefined && isWeakOnly(s.reasoning),
            reasoning: (s.reasoning ?? '').slice(0, 400),
            ms: s.ms ?? null,
          }),
        })
        r.verdict = verdict(r)
        // 原始响应体积很大，不推给浏览器
        push('target-done', { index: ti, result: { ...r, samples: undefined, target: { label: t.label, base: t.base, model: t.model } } })
      } catch (e) {
        push('target-done', { index: ti, result: { target: { label: t.label }, error: e.message, verdict: { tag: '打不通', mark: '!', note: e.message } } })
      }
    }
    push('all-done', {})
    return res.end()
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DeepSeek 中转检测 UI  →  http://127.0.0.1:${PORT}\n`)
  console.log('  Ctrl+C 停止\n')
})
