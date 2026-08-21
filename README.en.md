<div align="right"><a href="README.md">简体中文</a> | <b>English</b></div>

# dsh-relay-check

**Find out whether an API relay is serving you the real DeepSeek — or a downgraded stand-in.**

No vendor claims, no asking the model what it is. Just one objective behavioral
fingerprint. Supports **OpenAI / Anthropic / Responses** protocols, ships with both a CLI
and a web UI, zero dependencies.

![UI: same tool, official endpoint at 100%, a relay's cheap SKU at 0%](docs/screenshot.png)

<sub>Screenshot is demo-mode (`?demo=1`) sample data. Run `node docs/shoot.mjs` to regenerate.</sub>

---

## The problem

You paid a relay for `deepseek-v4-pro`. Requests return 200. The `model` field in the
response says `deepseek-v4-pro`.

**So how do you know that's actually what answered?**

A relay can route your request to a cheaper model, a quantized build, or a wrapper around
something else entirely. None of that shows up in the response fields. And the usual
checks don't work either: asking "what model are you" is unreliable (system prompts can be
rewritten, and models frequently misidentify themselves), response shape can be copied, and
latency proves nothing.

This tool uses a **behavioral fingerprint**: it sends one carefully constructed request N
times and looks at which register the model's reasoning falls into.

## How it works

DeepSeek V4 is extremely sensitive to the **tool catalog visible on the first request**
(its "schema surface").

Under DeepSeek Harness's `minimal` preset conditions — a 46-character persona and only two
tools exposed, `bash` and `str_replace_editor` — the genuine model falls back into the
reasoning trajectory it was RL-trained on:

```
We need inspect repo. Need find circular dependencies. Need list any. Let's start.
We need inspect repository. Need understand project. We'll list files.
```

Note that **`need` is followed directly by a bare verb, with no `to`**, and subjects are
frequently dropped. That elision habit is the signature of the training trajectory.

A downgraded, re-weighted or wrapper model cannot produce that register. It writes ordinary
English instead:

```
The user wants me to check a repository for circular dependencies. Let me first explore...
Let me start by exploring the repository structure.
I'll explore the repository structure and check for circular dependencies.
```

The tool fires that exact fixture N times and counts strong hits.

**Swap the tool catalog for a Standard one with dozens of tools and even the official
endpoint drops to zero.** That is why the two schemas in `src/fixture.json` must not be
edited by so much as a character — change them and the fingerprint stops working. Their
contents are taken from the public source of
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).

### Why only the elided form counts

`We need **to** check the repository` is something nearly every model writes. Using it as
the criterion lets impostors through — one relay measured here scored a 50% false hit rate
on exactly that. So:

- **Strong signal**: `We need inspect …` / `… . Need find …` (no `to`) → counts as genuine
- **Weak signal**: opens with `We need to …` / `Let's …` but shows no elision → reported
  separately, **not** counted

## Quick start

Node.js 20+. No dependencies, no `npm install`.

```bash
git clone https://github.com/linjunsu/dsh-relay-check.git
cd dsh-relay-check
```

### CLI

```bash
# Test one target
node bin/check.mjs --base https://api.deepseek.com --model deepseek-v4-flash --key sk-xxx

# Compare several (strongly recommended: include the official endpoint as a baseline)
node bin/check.mjs --targets targets.json --runs 6

# Show the raw reasoning from every run
node bin/check.mjs ... --verbose

# Add the self-identification probe (a supporting signal, not scored)
node bin/check.mjs ... --identity

# JSON output, for scripting
node bin/check.mjs ... --json
```

### Web UI

```bash
npm run ui        # or: node bin/serve.mjs
```

Open <http://127.0.0.1:8787> and fill in four things: **Base URL / model ID / protocol /
API key**. Click "add another to compare" to run several targets together and get a summary
table.

On Windows just double-click **`start.bat`** — it checks the port, starts the server, and
opens the browser once the port actually answers.

No key and just want to see what it looks like? Visit
<http://127.0.0.1:8787/?demo=1> — demo mode renders all three verdicts from sample data
without making a single network request.

The UI streams each run's reasoning **live**, labelling it genuine / weak / miss / error as
it arrives, alongside hit rate, reasoning tokens, prompt tokens and latency.

> The key is typed straight into the page. Nothing reads local credential files, nothing is
> written to disk, no targets are pre-filled. The server binds `127.0.0.1` only, and the key
> travels in the POST body (never the URL, never browser history) and only ever lives in
> memory.

## Options

| Option | Meaning |
|---|---|
| `--base <url>` | API root, e.g. `https://api.deepseek.com` |
| `--model <id>` | Model ID, e.g. `deepseek-v4-flash` |
| `--key <key>` | API key |
| `--key-env <NAME>` | Read the key from an environment variable |
| `--creds <file>` | Load `KEY: value` pairs from a file into the environment |
| `--targets <file>` | Batch mode; see `targets.example.json` |
| `--protocol <p>` | `auto` (default) / `openai` / `anthropic` / `responses` |
| `--runs <n>` | Runs per target, default 6. More samples, steadier verdict |
| `--lang en\|zh` | Probe language, default `en` |
| `--effort <e>` | Reasoning effort, default `max` |
| `--verbose` | Print every run's reasoning |
| `--identity` | Add the self-identification probe |
| `--json` | JSON output |

## Three protocols

`--protocol auto` (the default) tries each protocol in turn, and within each one tries its
candidate paths and auth schemes, taking whichever works:

| Protocol | Endpoints | Auth | Reasoning read from |
|---|---|---|---|
| **OpenAI Chat Completions** | `{base}/chat/completions`<br>`{base}/v1/chat/completions` | `Bearer` | `message.reasoning_content` |
| **Anthropic Messages** | `{base}/v1/messages`<br>`{base}/messages` | `x-api-key`, falls back to `Bearer` | `thinking` content blocks |
| **OpenAI Responses** | `{base}/responses`<br>`{base}/v1/responses` | `Bearer` | `output[].type === 'reasoning'` |

So it doesn't matter whether your Base URL includes `/v1`. **Test each protocol endpoint of
a relay separately** — one relay measured here behaved differently on its OpenAI and
Anthropic endpoints.

## Verdicts

| Verdict | Condition |
|---|---|
| **Genuine ✓** | Strong hit rate ≥ 60% |
| **Suspicious ~** | 0 < strong hit rate < 60% |
| **Impostor ✗** | Zero strong hits |
| **Undecidable ?** | The upstream returns no reasoning text, or the reasoning is encrypted |
| **Unreachable !** | Request failed — reports the exact URL and error, plus what to try next |

Supporting signals (reported, not scored): whether `reasoning_tokens` accounting exists,
latency, `prompt_tokens` (tokenizer differences), and the `--identity` self-report.

## Measured results (2026-08-20)

Relay names are anonymized — the point is that the method reproduces, not naming anyone.
Run the tool and you'll know which tier yours is in.

| Target | Protocol | Strong hits | Avg latency | Verdict |
|---|---|---|---|---|
| Official endpoint `deepseek-v4-flash` | openai | 6/6 | 1094ms | Genuine ✓ |
| Official endpoint `deepseek-v4-flash` | responses | 3/3 | 1262ms | Genuine ✓ |
| Relay A · premium SKU | openai | 6/6 | 2053ms | Genuine ✓ |
| Relay A · cheap SKU | openai | 0/6 | 2846ms | Impostor ✗ |
| Relay B · OpenAI endpoint | openai | 0/6 | 3256ms | Impostor ✗ |
| Relay B · Anthropic endpoint | anthropic | 1/6 | 3444ms | Suspicious ~ |

Three things worth noting:

- **One relay can be genuine on one SKU and an impostor on another.** Relay A's two SKUs
  differ 2.2–3.3× in price; the expensive one is genuine, the cheap one scores zero. You
  cannot draw conclusions from the vendor name alone.
- **The same relay can behave differently across protocols** (Relay B: 0/6 on OpenAI, 1/6
  on Anthropic), which suggests the backend routing isn't the same.
- **The official endpoint is genuine across all three protocols**, making it the most
  reliable baseline — include it as a control row on every run.

**Test per `base + model + protocol` combination.**

## Limitations (please read before drawing conclusions)

- This is a **behavioral fingerprint, not a weight comparison**. A low hit rate only means
  "behavior differs from official." The cause could be different weights, quantization, or
  a wrapper — but it could equally be a relay injecting its own system prompt.
- It only works on upstreams that **return reasoning text**. The Responses protocol
  sometimes returns only summaries, and Anthropic may return encrypted
  `redacted_thinking`; both are reported as "undecidable", not as impostors.
- **Chinese probes have an inherently lower hit rate than English** (measured on the
  official endpoint: 6/6 English, 2/5 Chinese). English is the default; treat `--lang zh`
  results as indicative only, never as grounds for a guilty verdict.
- **The criterion is probabilistic.** Higher `--runs` is steadier; always re-test with a
  larger sample when the verdict is "suspicious".
- **The fingerprint changes with model versions.** After a DeepSeek generation change, the
  criteria in `src/detect.mjs` need recalibrating against the official endpoint.

## Once the endpoint checks out

Confirming the endpoint isn't a distilled or quantized stand-in is only step one. The next
question is **how to shape your requests so that genuine model actually performs** — same
weights, different request surface, very different output quality.

That spec lives here: **[dsh-peak-call](https://github.com/linjunsu/dsh-peak-call)** (rules
only, no code — hand it straight to another developer or their AI agent).

## Relationship to veridrop

[canarybyte/veridrop](https://github.com/canarybyte/veridrop) is a broader project in the
same space, covering Claude / OpenAI / Gemini across cryptographic, protocol-field and
behavioral layers. **Use both.**

This project is **complementary, not a replacement**: veridrop doesn't currently cover
DeepSeek and doesn't fingerprint reasoning register. This one only does DeepSeek, but takes
that one method deep.

## Layout

```
bin/check.mjs        CLI
bin/serve.mjs        local UI server (streams progress over SSE)
web/index.html       the interface (single file, no build step)
src/fixture.json     the minimal first-request surface — edit it and the fingerprint dies
src/fixture.mjs
src/protocols.mjs    three protocol adapters + auto-detection
src/detect.mjs       fingerprint criteria and scoring
start.bat            one-click UI launcher for Windows
```

## FAQ

**Q: Why does the UI need a local server instead of being plain HTML?**
A browser calling `api.deepseek.com` or a relay directly gets blocked by CORS (those
endpoints send no cross-origin headers, and are under no obligation to). So the page only
handles the interface; requests go out from the local Node process.

**Q: What do I do about a "suspicious" verdict?**
Re-test with higher `--runs`. If it stays in the middle tier, the relay may be routing
across several backends — that has been observed.

**Q: Where does my key go?**
Only to the Base URL you typed. There is no telemetry, no reporting, no external
dependency. The whole thing is about 700 lines — you can read it yourself.

**Q: Can it test other models (GPT / Claude / Gemini)?**
No. This fingerprint is specific to DeepSeek V4. Use veridrop for those.

## Contributing

Issues and PRs welcome. Particularly:

- Measurements from new relays (anonymized or not)
- Fingerprint recalibration for new model versions
- Additional protocol adapters

## License

MIT © linjunsu

Fixture contents taken from
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).

---

<sub>Keywords: DeepSeek relay verification · API downgrade detection · model substitution ·
fake model detection · LLM fingerprinting · deepseek-v4 · API proxy audit · 中转站检测 ·
降智检测 · 满血验证</sub>
