// thinking_tokens 与 output_tokens 关系实测探针（真实 agy 进程，手动运行，不进 npm test）：
//   node scripts/probe-usage-semantics.mjs [--model <id>] [--effort high] [--agy-path agy] [--turn-timeout 300000]
//
// 目的：agy 官方 headless 字段表只把 thinking_tokens 与 output_tokens 并列列为 token
// counts，未定义两者的包含关系。本探针在同一持续会话里跑两轮——校准轮（极短回复）
// 与重思考轮（深思考、极短可见输出）——用 agent_response step 的 output−thinking
// 残差与该步可见 token 的对照判定 thinking 是否被计入 output：
//   BRANCH1  每个思考步都有 output ≥ thinking，且残差 ≈ 可见 token（模型调用 agy
//            内置工具的轮次残差还会包含工具请求 token）→ thinking ⊆ output，
//            隐藏思考构成 DSH TPS 的第二个虚高源（分子含思考 token、分母的 decode
//            窗口从首个可见 token 起算，不含思考时间），需要从 output 中扣除 thinking；
//   BRANCH2  思考步 output ≈ 可见 token、远小于 thinking → 两者独立计数，映射无需改动。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { buildAgyEnv } from '../lib/session.js';
import { fetchAgyModelsOutput, parseAgyModelsOutput, groupBaseModels } from '../lib/models.js';

function parseArgs(argv) {
  const args = { effort: 'high', agyPath: 'agy', turnTimeout: 300_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--effort') args.effort = argv[++i];
    else if (argv[i] === '--agy-path') args.agyPath = argv[++i];
    else if (argv[i] === '--turn-timeout') args.turnTimeout = Number(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

async function pickDefaultModel(agyPath) {
  const bases = groupBaseModels(parseAgyModelsOutput(await fetchAgyModelsOutput(agyPath)));
  const candidate = bases.find((b) => /gemini/i.test(b.id) && b.efforts.length > 0);
  if (!candidate) {
    throw new Error('agy models 中没有带思考档位的 gemini 模型，请用 --model 显式指定');
  }
  return candidate.id;
}

const CALIBRATION_PROMPT = 'Reply with exactly the word OK and nothing else.';
const HEAVY_THINKING_PROMPT =
  'Compute the sum of all prime numbers below 1000. Do the arithmetic carefully in your head, ' +
  'verify the result twice by a different grouping, then reply with ONLY the final number and nothing else.';

// 失败时也要能拿到全事件日志（由 main().catch 落盘）
let runLog = null;
let runScratchDir = null;

/** 按 step_index 归组 step_update，还原每个 step 的文本与 usage。 */
function groupSteps(events) {
  const steps = new Map();
  for (const e of events) {
    const p = e.parsed;
    if (p?.event !== 'step_update') continue;
    const u = p.step_update;
    const idx = typeof u.step_index === 'number' ? u.step_index : steps.size;
    let s = steps.get(idx);
    if (!s) {
      s = { step_index: idx, step_type: u.step_type, state: null, text: '', usage: null, duration_seconds: null, tool_name: u.tool_name ?? null };
      steps.set(idx, s);
    }
    if (u.state) s.state = u.state;
    if (typeof u.text_delta === 'string') s.text += u.text_delta;
    if (u.usage) s.usage = u.usage;
    if (u.duration_seconds !== undefined) s.duration_seconds = u.duration_seconds;
  }
  return [...steps.values()].sort((a, b) => a.step_index - b.step_index);
}

function analyze(turn) {
  const steps = groupSteps(turn.events);
  const result = turn.result ?? {};
  const usage = result.usage ?? {};
  const agentSteps = steps.filter((s) => s.step_type === 'agent_response' && s.usage);
  const stepRows = agentSteps.map((s, i) => {
    const output = s.usage.output_tokens ?? 0;
    const thinking = s.usage.thinking_tokens ?? 0;
    const next = steps[steps.indexOf(s) + 1];
    return {
      step_index: s.step_index,
      output_tokens: output,
      thinking_tokens: thinking,
      remainder: output - thinking,
      visible_chars: s.text.length,
      visible_tokens_estimate: Math.max(s.text.trim() ? 1 : 0, Math.ceil(s.text.length / 4)),
      followed_by_tool_step: next?.step_type === 'tool',
      duration_seconds: s.duration_seconds ?? null,
    };
  });
  return {
    status: result.status ?? null,
    num_turns: result.num_turns ?? null,
    duration_seconds: result.duration_seconds ?? null,
    firstTextDeltaRelMs: turn.firstTextDeltaAt !== null ? turn.firstTextDeltaAt - turn.startedAt : null,
    usage: {
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      thinking_tokens: usage.thinking_tokens ?? null,
      cache_read_tokens: usage.cache_read_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    },
    stepRows,
  };
}

function decideVerdict(analyses) {
  const rows = analyses.flatMap((a) => a.stepRows);
  const thinkingRows = rows.filter((r) => r.thinking_tokens > 0);
  if (thinkingRows.length === 0) return 'INCONCLUSIVE_NO_THINKING_OBSERVED';
  if (thinkingRows.every((r) => r.output_tokens >= r.thinking_tokens)) {
    return 'BRANCH1_THINKING_INCLUDED_IN_OUTPUT';
  }
  // 出现 output < thinking 的思考步：若其 output 贴着可见 token 量级，判独立计数
  const violating = thinkingRows.filter((r) => r.output_tokens < r.thinking_tokens);
  if (violating.every((r) => r.output_tokens <= Math.max(30, r.visible_tokens_estimate * 3))) {
    return 'BRANCH2_THINKING_SEPARATE';
  }
  return 'INCONCLUSIVE_AMBIGUOUS';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model ?? (await pickDefaultModel(args.agyPath));
  const scratchDir = join(homedir(), '.dsh', 'llm-agy', 'probe-scratch');
  mkdirSync(scratchDir, { recursive: true });

  const spawnArgs = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', model,
  ];
  if (args.effort) spawnArgs.push('--effort', args.effort);

  console.log(`[probe] model=${model} effort=${args.effort || '(none)'} scratch=${scratchDir}`);

  const child = spawn(args.agyPath, spawnArgs, {
    cwd: scratchDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: buildAgyEnv(),
  });

  const sessionStartedAt = Date.now();
  const log = [];
  runLog = log;
  runScratchDir = scratchDir;
  let pending = null;

  const onStdoutLine = (line) => {
    const ts = Date.now();
    let parsed = null;
    try { parsed = JSON.parse(line.trim()); } catch { /* 非 JSON 行原样记录 */ }
    const entry = { ts, relMs: ts - sessionStartedAt, dir: 'stdout', parsed, raw: parsed ? undefined : line };
    log.push(entry);
    if (!pending) return;
    const turn = pending.turn;
    turn.events.push(entry);
    if (parsed?.event === 'step_update') {
      const u = parsed.step_update;
      if (u.step_type === 'agent_response' && typeof u.text_delta === 'string' && u.text_delta.length > 0 && turn.firstTextDeltaAt === null) {
        turn.firstTextDeltaAt = ts;
      }
    }
    if (parsed?.event === 'result') {
      turn.result = parsed.result;
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(turn);
    }
  };

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', onStdoutLine);
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) log.push({ ts: Date.now(), relMs: Date.now() - sessionStartedAt, dir: 'stderr', raw: line });
    }
  });
  child.on('error', (err) => {
    if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(new Error(`agy 进程错误：${err.message}`)); }
    else throw new Error(`agy 进程错误：${err.message}`);
  });
  child.on('close', (code) => {
    if (pending) {
      const stderrTail = log.filter((e) => e.dir === 'stderr').slice(-5).map((e) => e.raw).join('\n');
      if (stderrTail) console.error(`[probe] agy stderr 末尾：\n${stderrTail}`);
      const p = pending; pending = null; clearTimeout(p.timer); p.reject(new Error(`agy 进程在 result 事件前退出（code ${code}）`));
    }
  });

  function sendTurn(prompt) {
    return new Promise((resolve, reject) => {
      const turn = { prompt, startedAt: Date.now(), events: [], firstTextDeltaAt: null, result: null };
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`turn 在 ${args.turnTimeout}ms 内未产生 result 事件`));
      }, args.turnTimeout);
      pending = { turn, resolve, reject, timer };
      child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
    });
  }

  try {
    console.log('[probe] Turn A（校准：极短回复）…');
    const turnA = await sendTurn(CALIBRATION_PROMPT);
    console.log('[probe] Turn B（重思考、极短可见输出）…');
    const turnB = await sendTurn(HEAVY_THINKING_PROMPT);

    const a = analyze(turnA);
    const b = analyze(turnB);
    const verdict = decideVerdict([a, b]);

    const totalIdentity = (s) => (s.usage.total_tokens !== null && s.usage.input_tokens !== null && s.usage.output_tokens !== null
      ? s.usage.total_tokens - (s.usage.input_tokens + s.usage.output_tokens) : null);

    console.log('\n===== Turn A（校准轮） =====');
    console.log(JSON.stringify(a, null, 2));
    console.log('\n===== Turn B（重思考轮，usage 为会话累计值） =====');
    console.log(JSON.stringify(b, null, 2));
    console.log('\n===== 交叉验证 =====');
    console.log(JSON.stringify({
      total_minus_input_minus_output_turnA: totalIdentity(a),
      total_minus_input_minus_output_turnB: totalIdentity(b),
      first_text_delta_rel_ms_turnA: a.firstTextDeltaRelMs,
      first_text_delta_rel_ms_turnB: b.firstTextDeltaRelMs,
      turn_duration_seconds: { A: a.duration_seconds, B: b.duration_seconds },
    }, null, 2));
    console.log(`\nVERDICT: ${verdict}`);
    if (verdict === 'BRANCH1_THINKING_INCLUDED_IN_OUTPUT') {
      console.log('结论：thinking_tokens 被计入 output_tokens。隐藏思考构成 DSH TPS 第二虚高源（分子含思考 token，分母 decode 窗口不含思考时间），需在映射中从 output 扣除 thinking。');
    } else if (verdict === 'BRANCH2_THINKING_SEPARATE') {
      console.log('结论：thinking_tokens 独立于 output_tokens 计数，output 只含可见输出。现有映射不构成 TPS 第二虚高源，无需修改。');
    } else {
      console.log('结论：本次实验数据不足以判定，不做任何猜测性修改。可换模型/提高 effort 重跑。');
    }

    const logPath = join(scratchDir, `probe-usage-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(logPath, JSON.stringify({ model, effort: args.effort, verdict, turnA: a, turnB: b, log }, null, 2));
    console.log(`[probe] 全事件日志已写入 ${logPath}`);
  } finally {
    try { child.stdin.end(); } catch { /* 进程可能已退出 */ }
    try { child.kill(); } catch { /* 同上 */ }
  }
}

main().catch((err) => {
  console.error(`[probe] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (runLog && runScratchDir) {
    try {
      const crashPath = join(runScratchDir, `probe-usage-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(crashPath, JSON.stringify({ error: String(err instanceof Error ? err.stack : err), log: runLog }, null, 2));
      console.error(`[probe] 失败现场已写入 ${crashPath}`);
    } catch { /* 落盘失败不再掩盖原始错误 */ }
  }
  process.exit(1);
});
