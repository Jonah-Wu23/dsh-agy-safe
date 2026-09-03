import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { RetryPolicySchema, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm';

export const SETTINGS_NS = 'llm-agy';
export const PROVIDER_ID = 'agy';
export const PROVIDER_NAME = 'Antigravity CLI';

export function getDefaultScratchDir(): string {
  return join(homedir(), '.dsh', 'llm-agy', 'scratch');
}

export const Config = z.object({
  agyPath: z.string().default('agy').description('Path or executable command for Antigravity CLI (agy)'),
  defaultEffort: z.union(['low', 'medium', 'high'] as const).default('medium').description('Default reasoning effort (low, medium, high)'),
  scratchDir: z.string().default(getDefaultScratchDir()).description('Scratch directory used as cwd for background model agy processes'),
  idleTimeoutMs: z.number().min(1000).default(300_000).description('Idle timeout in milliseconds before releasing cached agy processes'),
  streamIdleTimeoutMs: z.number().min(1000).default(120_000).description('Timeout in milliseconds waiting for streaming output events'),
  retryPolicy: RetryPolicySchema,
});

export type AgyPluginConfig = {
  agyPath?: string;
  defaultEffort?: 'low' | 'medium' | 'high';
  scratchDir?: string;
  idleTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  retryPolicy?: RetryPolicyConfig;
};

export const DEFAULT_CONFIG: Required<AgyPluginConfig> = {
  agyPath: 'agy',
  defaultEffort: 'medium',
  scratchDir: getDefaultScratchDir(),
  idleTimeoutMs: 300_000,
  streamIdleTimeoutMs: 120_000,
  retryPolicy: {
    mode: 'normal',
    maxRetries: 3,
    retryableCodes: ['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER'],
  },
};
