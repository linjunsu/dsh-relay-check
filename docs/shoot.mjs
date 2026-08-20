// 重新生成 README 截图：node docs/shoot.mjs
// 需要先起服务（npm run ui）。用本机 Chrome 无头模式，无需额外依赖。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const browser = CANDIDATES.find(p => fs.existsSync(p))
if (browser === undefined) throw new Error('没找到 Chrome 或 Edge')

const out = new URL('./screenshot.png', import.meta.url).pathname.replace(/^\//, '')
execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',   // 2 倍 DPI，README 里缩放后仍然清晰
  '--virtual-time-budget=2000',      // 让页面把 JS 跑完再拍
  '--window-size=1400,2205',         // 高度切在「满血 vs 野鸡」对比之后
  `--screenshot=${out}`,
  'http://127.0.0.1:8787/?demo=1',   // 演示模式：动画已禁用，抓图结果稳定
], { stdio: 'inherit' })
console.log('写入', out)
