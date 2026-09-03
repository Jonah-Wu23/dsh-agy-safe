import type { LlmModelInfo, LlmResolvedModelInfo, ReasoningEffortId } from '@deepseek-ai/dsh-llm';

export interface CatalogModelDefinition {
  id: string;
  name: string;
  description?: string;
  contextWindow: number;
  defaultEffort?: ReasoningEffortId;
  supportsEffort?: boolean;
}

export const DEFAULT_MODELS: readonly CatalogModelDefinition[] = [
  {
    id: 'gemini-3.1-pro-high',
    name: 'Gemini 3.1 Pro (High)',
    description: 'Deep thinking model for complex reasoning and architecture',
    contextWindow: 1_000_000,
    defaultEffort: 'high' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'gemini-3.1-pro-medium',
    name: 'Gemini 3.1 Pro (Medium)',
    description: 'Balanced thinking model for everyday agentic workflows',
    contextWindow: 1_000_000,
    defaultEffort: 'medium' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    description: 'Fast, lightweight model with huge context window',
    contextWindow: 1_000_000,
    defaultEffort: 'low' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude 3.7 Sonnet',
    description: 'High coding capability and reasoning performance',
    contextWindow: 200_000,
    defaultEffort: 'medium' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude 3.7 Opus',
    description: 'Deep analytical and synthesis capability',
    contextWindow: 200_000,
    defaultEffort: 'high' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    description: 'Flagship general-purpose and coding model',
    contextWindow: 272_000,
    defaultEffort: 'medium' as ReasoningEffortId,
    supportsEffort: true,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT 5.4 Mini',
    description: 'Fast, economical model for focused tasks',
    contextWindow: 272_000,
    defaultEffort: 'low' as ReasoningEffortId,
    supportsEffort: true,
  },
];

export const REASONING_EFFORTS = [
  { id: 'low' as ReasoningEffortId, name: 'Low', description: 'Faster responses with light reasoning' },
  { id: 'medium' as ReasoningEffortId, name: 'Medium', description: 'Standard balanced reasoning depth' },
  { id: 'high' as ReasoningEffortId, name: 'High', description: 'Maximum depth for complex problems' },
] as const;

export class ModelCatalog {
  private readonly models = new Map<string, CatalogModelDefinition>();

  constructor(customModels?: readonly CatalogModelDefinition[]) {
    for (const m of DEFAULT_MODELS) {
      this.models.set(m.id, m);
    }
    if (customModels) {
      for (const m of customModels) {
        this.models.set(m.id, m);
      }
    }
  }

  list(provider: string): readonly LlmModelInfo[] {
    return Array.from(this.models.values()).map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
      inputModalities: ['text'],
    }));
  }

  resolve(provider: string, modelId: string, configuredDefaultEffort: ReasoningEffortId = 'medium' as ReasoningEffortId): LlmResolvedModelInfo {
    const found = this.models.get(modelId);
    const contextWindow = found?.contextWindow ?? 128_000;
    const name = found?.name ?? modelId;
    const description = found?.description;
    const defaultEffort = found?.defaultEffort ?? configuredDefaultEffort;

    return {
      provider,
      id: modelId,
      name,
      description,
      inputModalities: ['text'],
      context: { contextWindow },
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort,
      },
    };
  }
}
