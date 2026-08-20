/**
 * 指纹夹具：DSH minimal 预设的首轮真实请求面。
 *
 * 为什么是这个组合——V4 对首轮可见工具目录（Schema Surface）极度敏感。
 * 只暴露 Minimal 的 bash + str_replace_editor 时，模型会落到 RL 训练时的
 * "We need …" 轨迹；换成 Standard 的几十个工具，同一个官方端点也会退回
 * "The user wants me to … Let me …"。所以这两个 schema 一字都不能改，
 * 改了指纹就失效。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const raw = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./fixture.json', import.meta.url)), 'utf8'),
)

/** 46 字符的 Minimal 人设，与官方 minimal 预设逐字节一致。 */
export const SYSTEM = raw.system

/** Minimal 双工具的中立描述（协议适配器再转成各自的 schema 形状）。 */
export const TOOLS = raw.tools

/**
 * 探针任务。英文命中率明显高于中文（实测官方 flash 英文 6/6、中文 2/5），
 * 所以默认用英文判定，中文只作参考。
 */
export const TASKS = {
  en: 'Check this repository for circular dependencies and list any you find.',
  zh: '帮我看下这个仓库里有没有循环依赖，有的话列出来。',
}

/** 身份自述探针（辅助信号，不参与打分）。 */
export const IDENTITY_PROMPTS = [
  'What model are you? Answer with just the model name and the company that made you.',
  'What is your knowledge cutoff date? Answer in one short line.',
]
