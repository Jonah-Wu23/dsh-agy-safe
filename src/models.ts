import { spawn } from 'node:child_process';
import { LlmError, type LlmModelInfo, type LlmResolvedModelInfo, type ReasoningEffortId } from '@deepseek-ai/dsh-llm';

/** agy models 输出的单行条目：`<id>\t<显示名>`。 */
export interface AgyListedModel {
  id: string;
  name: string;
}

/** 按基础模型归组后的目录条目；efforts 为该模型在 agy 侧实际存在的档位。 */
export interface AgyBaseModel {
  id: string;
  name: string;
  efforts: ReasoningEffortId[];
}

const EFFORT_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 };
const ALL_EFFORTS: readonly ReasoningEffortId[] = ['low', 'medium', 'high'] as ReasoningEffortId[];

const EFFORT_LABELS: Readonly<Record<string, { name: string; description: string }>> = {
  low: { name: 'Low', description: 'Faster responses with light reasoning' },
  medium: { name: 'Medium', description: 'Standard balanced reasoning depth' },
  high: { name: 'High', description: 'Maximum depth for complex problems' },
};

/**
 * 各基础模型的官方最大上下文窗口（token），来自厂商 Model Card：
 * Gemini 3.x 全系 1,048,576；Claude 4.6 双子 1,000,000；GPT-OSS 120B 131,072。
 * thinking 档位不改变上下文窗口。不在表内的模型省略该字段。
 */
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'gemini-3.8-flash': 1_048_576,
  'gemini-3.7-flash': 1_048_576,
  'gemini-3.6-flash': 1_048_576,
  'gemini-3.1-pro': 1_048_576,
  'claude-sonnet-4-6': 1_000_000,
  'claude-opus-4-6-thinking': 1_000_000,
  'gpt-oss-120b': 131_072,
};

const MODELS_TIMEOUT_MS = 30_000;

/**
 * 执行 `agy models` 并返回 stdout 原文。
 * 进度 spinner 走 stderr，stdout 只含 `id\t名称` 数据行。
 */
export function fetchAgyModelsOutput(agyPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin 必须关闭（ignore→NUL）：agy 在 stdin 是打开管道时会挂起等待 EOF
    const child = spawn(agyPath, ['models'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new LlmError(`agy models timed out after ${MODELS_TIMEOUT_MS}ms`, 'TIMEOUT'));
    }, MODELS_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LlmError(`Failed to run "${agyPath} models": ${err.message}`, 'TRANSPORT'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).pop() ?? `exit code ${code}`;
        reject(new LlmError(`agy models exited with code ${code}: ${detail}`, 'SERVER'));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 严格按 `<id>\t<name>` 解析数据行；其余行（空行等）一律跳过。 */
export function parseAgyModelsOutput(output: string): AgyListedModel[] {
  const listed: AgyListedModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0 || tab === line.length - 1) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    listed.push({ id, name });
  }
  return listed;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * 若条目是档位变体（id 以 `-low/-medium/-high` 结尾，且显示名以对应 ` (Low)` 等结尾），
 * 拆出基础 id、基础显示名与档位；否则原样返回、effort 为 null。
 * 两个条件同时匹配才拆，避免误伤以同名后缀结尾的非档位模型。
 */
export function splitEffortVariant(
  id: string,
  name: string,
): { baseId: string; baseName: string; effort: ReasoningEffortId } | null {
  for (const effort of ALL_EFFORTS) {
    const idSuffix = `-${effort}`;
    const nameSuffix = ` (${capitalize(effort)})`;
    if (id.endsWith(idSuffix) && name.endsWith(nameSuffix)) {
      return {
        baseId: id.slice(0, id.length - idSuffix.length),
        baseName: name.slice(0, name.length - nameSuffix.length),
        effort,
      };
    }
  }
  return null;
}

/** 归组为基础模型：合并同基础下的档位集合，档位按 low→high 排序，保持 agy 的首次出现顺序。 */
export function groupBaseModels(listed: readonly AgyListedModel[]): AgyBaseModel[] {
  const bases = new Map<string, { name: string; efforts: Set<ReasoningEffortId> }>();
  for (const { id, name } of listed) {
    const variant = splitEffortVariant(id, name);
    const baseId = variant ? variant.baseId : id;
    const baseName = variant ? variant.baseName : name;
    let base = bases.get(baseId);
    if (!base) {
      base = { name: baseName, efforts: new Set<ReasoningEffortId>() };
      bases.set(baseId, base);
    }
    if (variant) base.efforts.add(variant.effort);
  }
  return Array.from(bases.entries()).map(([id, base]) => ({
    id,
    name: base.name,
    efforts: Array.from(base.efforts).sort((a, b) => EFFORT_ORDER[a] - EFFORT_ORDER[b]),
  }));
}

/** 档位缺省值：优先 medium，否则取可用档位中最深的一档。 */
export function pickDefaultEffort(efforts: readonly ReasoningEffortId[]): ReasoningEffortId {
  if (efforts.includes('medium' as ReasoningEffortId)) return 'medium' as ReasoningEffortId;
  return efforts.reduce((a, b) => (EFFORT_ORDER[b] > EFFORT_ORDER[a] ? b : a));
}

function effortDescriptors(efforts: readonly ReasoningEffortId[]) {
  return efforts.map((id) => ({ id, ...EFFORT_LABELS[id] }));
}

/**
 * 模型目录：运行时执行 `agy models` 获取真实清单（带 TTL 缓存），
 * 归组为基础模型 + 档位集合。agy 不可用或命令失败时按原样抛错，不伪造清单。
 */
export class ModelCatalog {
  private bases: AgyBaseModel[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly agyPath: string,
    private readonly cacheTtlMs = 300_000,
  ) {}

  private async ensureFresh(): Promise<void> {
    if (this.bases.length > 0 && Date.now() - this.fetchedAt < this.cacheTtlMs) return;
    if (!this.inflight) {
      this.inflight = fetchAgyModelsOutput(this.agyPath)
        .then((output) => {
          this.bases = groupBaseModels(parseAgyModelsOutput(output));
          this.fetchedAt = Date.now();
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    await this.inflight;
  }

  /** 仅读缓存；返回该模型的档位集合，未知（缓存未建立）时为 undefined。 */
  peekEfforts(modelId: string): readonly ReasoningEffortId[] | undefined {
    return this.bases.find((b) => b.id === modelId)?.efforts;
  }

  async list(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureFresh();
    return this.bases.map((base) => ({
      provider,
      id: base.id,
      name: base.name,
      inputModalities: ['text'],
    }));
  }

  async resolve(
    provider: string,
    modelId: string,
    configuredDefaultEffort: ReasoningEffortId,
  ): Promise<LlmResolvedModelInfo> {
    await this.ensureFresh();
    const found = this.bases.find((b) => b.id === modelId);
    const contextWindow = found ? MODEL_CONTEXT_WINDOWS[found.id] : undefined;

    // 有档位变体的模型声明档位元数据；无档位模型（如 claude 系）省略 reasoning，
    // 避免 UI 提供 agy 会拒绝的 --effort；未知模型回退全档位以免校验失败。
    let reasoning: { efforts: ReturnType<typeof effortDescriptors>; defaultEffort: ReasoningEffortId } | undefined;
    if (found && found.efforts.length > 0) {
      reasoning = {
        efforts: effortDescriptors(found.efforts),
        defaultEffort: pickDefaultEffort(found.efforts),
      };
    } else if (!found) {
      reasoning = {
        efforts: effortDescriptors(ALL_EFFORTS),
        defaultEffort: (ALL_EFFORTS as readonly string[]).includes(configuredDefaultEffort)
          ? configuredDefaultEffort
          : ('medium' as ReasoningEffortId),
      };
    }

    return {
      provider,
      id: modelId,
      name: found?.name ?? modelId,
      inputModalities: ['text'],
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
}
