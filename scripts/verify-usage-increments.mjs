// 真实 agy 两轮集成验证（手动运行，不进 npm test）：
//   node scripts/verify-usage-increments.mjs [--model <id>] [--agy-path agy]
//
// 复现生产组装：同一 sessionId 连续两次 adapter.stream()，消息历史递增满足
// 指纹前缀匹配 → AgySessionManager 复用同一 AgySession（同一 agy 进程）。
// Turn 1 要求长输出，Turn 2 要求极短回复：
//   修复形态  Turn 2 上报本轮增量（个位数量级），断言通过；
//   缺陷形态  Turn 2 上报会话累计值 ≈ Turn 1 + 小量，断言必失败。
// 无兜底文本：任何一步失败都以非零退出码结束。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../lib/adapter.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { fetchAgyModelsOutput, parseAgyModelsOutput, groupBaseModels } from '../lib/models.js';

function parseArgs(argv) {
  const args = { agyPath: DEFAULT_CONFIG.agyPath };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--agy-path') args.agyPath = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

async function pickDefaultModel(agyPath) {
  const bases = groupBaseModels(parseAgyModelsOutput(await fetchAgyModelsOutput(agyPath)));
  const candidate = bases.find((b) => /gemini/i.test(b.id) && b.efforts.length > 0);
  if (!candidate) throw new Error('agy models 中没有带档位的 gemini 模型，请用 --model 显式指定');
  return candidate.id;
}

// dsh Message 的运行时最小形状：适配链路只消费 role 与 content 块
function message(id, role, text, model) {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'agy', model },
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const usageOf = (chunks) => chunks.find((c) => c.type === 'usage')?.usage ?? null;
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')?.reason ?? null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model ?? (await pickDefaultModel(args.agyPath));
  const scratchDir = join(homedir(), '.dsh', 'llm-agy', 'verify-scratch');
  mkdirSync(scratchDir, { recursive: true });
  const adapter = new AgyAdapter({ ...DEFAULT_CONFIG, agyPath: args.agyPath, scratchDir });
  const sessionId = `usage-increment-verify-${Date.now()}`;

  try {
    const prompt1 = 'Count from 1 to 50, one number per line. Output nothing else.';
    console.log(`[verify] Turn 1 (${model})：${prompt1}`);
    const chunks1 = await collect(adapter.stream({
      provider: 'agy',
      model,
      sessionId,
      messages: [message('m1', 'user', prompt1, model)],
    }));
    const text1 = textOf(chunks1);
    const usage1 = usageOf(chunks1);
    const finish1 = finishOf(chunks1);
    console.log(`[verify] Turn 1 finish: ${JSON.stringify(finish1)}`);
    console.log(`[verify] Turn 1 usage:  ${JSON.stringify(usage1)}`);
    console.log(`[verify] Turn 1 text length: ${text1.length}`);

    const prompt2 = 'Reply with exactly: OK';
    console.log(`[verify] Turn 2（复用会话）：${prompt2}`);
    const chunks2 = await collect(adapter.stream({
      provider: 'agy',
      model,
      sessionId,
      messages: [
        message('m1', 'user', prompt1, model),
        message('m2', 'assistant', text1, model),
        message('m3', 'user', prompt2, model),
      ],
    }));
    const usage2 = usageOf(chunks2);
    const finish2 = finishOf(chunks2);
    console.log(`[verify] Turn 2 finish: ${JSON.stringify(finish2)}`);
    console.log(`[verify] Turn 2 usage:  ${JSON.stringify(usage2)}`);

    const failures = [];
    if (!usage1) failures.push('Turn 1 未产出 usage chunk');
    else if (!(usage1.outputTokens > 50)) failures.push(`Turn 1 outputTokens=${usage1.outputTokens}，判别前提（>50）不成立`);
    if (!usage2) failures.push('Turn 2 未产出 usage chunk');
    if (finish1?.kind !== 'stop') failures.push(`Turn 1 finish kind=${finish1?.kind}，期望 stop`);
    if (finish2?.kind !== 'stop') failures.push(`Turn 2 finish kind=${finish2?.kind}，期望 stop`);
    if (usage1 && usage2 && !(usage2.outputTokens < usage1.outputTokens / 2)) {
      failures.push(`Turn 2 outputTokens=${usage2.outputTokens} 未小于 Turn 1 的一半（${usage1.outputTokens / 2}）——疑似仍在上报会话累计值`);
    }

    if (failures.length > 0) {
      console.error('[verify] FAIL');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log('[verify] PASS：Turn 2 上报的是本轮增量而非会话累计值');
  } finally {
    adapter.dispose();
  }
}

main().catch((err) => {
  console.error(`[verify] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
