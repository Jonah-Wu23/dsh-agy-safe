import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import readline from 'node:readline';
import { LlmError, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { TranscriptFlattener, type FlattenedTurn } from './flatten.js';
import { UsageBaseline, type UsageTracker } from './usage.js';
import type { AgyUsage } from './chunks.js';

export interface SessionConfig {
  agyPath: string;
  scratchDir: string;
  idleTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/**
 * 会话池键：dsh 的标题/压缩辅助调用（purpose='session-title'/'compaction'）
 * 与主对话共享同一个 sessionId，但历史完全不同且可能并发；按 purpose 隔离
 * 成独立 agy 进程，避免辅助调用的指纹不匹配把正在流式的主进程杀掉。
 */
export function sessionKeyFor(sessionId: string, purpose?: string): string {
  return `${sessionId}::${purpose !== undefined && purpose !== '' ? purpose : 'conversation'}`;
}

/**
 * agy 子进程的最小环境白名单：只放行 Windows 基础变量和 agy 自家前缀
 * （`AGY_` 与 `AV_` 前缀），避免模型后端进程把 dsh 宿主环境的密钥等通读走。
 */
const ENV_WHITELIST = [
  'PATH',
  'SystemRoot',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
] as const;

export function buildAgyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith('AGY_') || key.startsWith('AV_')) env[key] = value;
  }
  return env;
}

export class AgySession implements UsageTracker {
  readonly sessionId: string;
  readonly model: string;
  readonly effort: string;
  private child: ChildProcess | null = null;
  private historyFingerprints: string[] = [];
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private usageBaseline = new UsageBaseline();

  constructor(
    sessionId: string,
    model: string,
    effort: string,
    private readonly config: SessionConfig,
  ) {
    this.sessionId = sessionId;
    this.model = model;
    this.effort = effort;
    this.spawnProcess();
  }

  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * 会话级 usage 差分：agy 持续会话的 result.usage 是本进程的累计值，
   * 基线与进程同生命周期，跨 stream() 调用持久。
   */
  takeUsageDelta(usage: AgyUsage): TokenUsage {
    return this.usageBaseline.takeUsageDelta(usage);
  }

  getHistoryFingerprints(): readonly string[] {
    return this.historyFingerprints;
  }

  setHistoryFingerprints(fps: string[]): void {
    this.historyFingerprints = [...fps];
  }

  touch(): void {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.dispose();
      }, this.config.idleTimeoutMs);
      if (typeof this.idleTimer.unref === 'function') {
        this.idleTimer.unref();
      }
    }
  }

  private spawnProcess(): void {
    // 新进程 = 新 agy 会话，usage 累计计数器从零开始，差分基线必须同步归零
    //（覆盖 streamTurn 里进程死亡后的 respawn 竞态路径，否则差分会算错）
    this.usageBaseline = new UsageBaseline();

    if (!existsSync(this.config.scratchDir)) {
      mkdirSync(this.config.scratchDir, { recursive: true });
    }

    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      this.model,
    ];

    if (this.effort) {
      args.push('--effort', this.effort);
    }

    try {
      this.child = spawn(this.config.agyPath, args, {
        cwd: this.config.scratchDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: buildAgyEnv(),
      });

      this.child.on('error', (err) => {
        // Child process error will be caught during turn streaming
      });

      this.resetIdleTimer();
    } catch (err) {
      throw new LlmError(
        `Failed to spawn Antigravity CLI process: ${err instanceof Error ? err.message : String(err)}`,
        'TRANSPORT',
      );
    }
  }

  async *streamTurn(prompt: string, signal?: AbortSignal): AsyncIterable<string> {
    if (!this.isAlive()) {
      this.spawnProcess();
    }

    const child = this.child!;
    this.touch();

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    let streamIdleWatchdog: NodeJS.Timeout | null = null;
    let turnFinished = false;
    let terminalError: Error | null = null;

    const lineQueue: string[] = [];
    let lineResolve: (() => void) | null = null;

    const resetWatchdog = () => {
      if (streamIdleWatchdog) clearTimeout(streamIdleWatchdog);
      if (this.config.streamIdleTimeoutMs > 0) {
        streamIdleWatchdog = setTimeout(() => {
          if (!turnFinished) {
            terminalError = new LlmError(
              `Antigravity CLI stream idle timeout exceeded (${this.config.streamIdleTimeoutMs}ms)`,
              'TIMEOUT',
            );
            this.dispose();
            lineResolve?.();
          }
        }, this.config.streamIdleTimeoutMs);
        if (typeof streamIdleWatchdog.unref === 'function') {
          streamIdleWatchdog.unref();
        }
      }
    };

    resetWatchdog();

    const onLine = (line: string) => {
      resetWatchdog();
      lineQueue.push(line);
      lineResolve?.();
      lineResolve = null;

      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.event === 'result') {
          turnFinished = true;
          if (streamIdleWatchdog) clearTimeout(streamIdleWatchdog);
        }
      } catch {
        // Non-JSON line from stdout
      }
    };

    const onError = (err: Error) => {
      terminalError = new LlmError(`Agy process error: ${err.message}`, 'TRANSPORT');
      lineResolve?.();
      lineResolve = null;
    };

    const onClose = (code: number | null) => {
      if (!turnFinished && !terminalError) {
        terminalError = new LlmError(
          `Antigravity CLI process exited unexpectedly with code ${code}`,
          'TRANSPORT',
        );
      }
      lineResolve?.();
      lineResolve = null;
    };

    const onAbort = () => {
      terminalError = new LlmError('Generation aborted by signal', 'ABORTED');
      this.dispose();
      lineResolve?.();
      lineResolve = null;
    };

    rl.on('line', onLine);
    child.once('error', onError);
    child.once('close', onClose);

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Send the turn payload to stdin
    const userPayload = JSON.stringify({
      event: 'user',
      message: { content: prompt },
    });

    try {
      child.stdin!.write(userPayload + '\n');
    } catch (writeErr) {
      terminalError = new LlmError(
        `Failed to write message to Antigravity CLI stdin: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        'TRANSPORT',
      );
    }

    try {
      while (!turnFinished && !terminalError) {
        if (lineQueue.length === 0) {
          await new Promise<void>((res) => {
            lineResolve = res;
          });
        }

        while (lineQueue.length > 0) {
          const l = lineQueue.shift()!;
          yield l;
        }
      }

      while (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      }

      if (terminalError) {
        throw terminalError;
      }
    } finally {
      if (streamIdleWatchdog) clearTimeout(streamIdleWatchdog);
      rl.off('line', onLine);
      child.off('error', onError);
      child.off('close', onClose);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      this.touch();
    }
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child) {
      try {
        if (!this.child.stdin?.destroyed) {
          this.child.stdin?.end();
        }
        this.child.kill();
      } catch {
        // Ignore kill error
      }
      this.child = null;
    }
  }
}

export class AgySessionManager {
  private readonly sessions = new Map<string, AgySession>();

  constructor(private readonly config: SessionConfig) {}

  resolvePromptAndSession(
    options: GenerateOptions,
    effort: string,
  ): { session: AgySession; prompt: string } {
    const sessionId = options.sessionId ? String(options.sessionId) : 'default';
    const sessionKey = sessionKeyFor(sessionId, options.purpose);
    const model = options.model;
    const normalizedEffort = effort.toLowerCase();

    const flattenedTurns = TranscriptFlattener.flattenTurns(options.messages);
    const incomingFps = flattenedTurns.map((t) => t.fingerprint);

    let session = this.sessions.get(sessionKey);

    // Check if existing session matches model, effort, and history
    if (session && session.isAlive() && session.model === model && session.effort === normalizedEffort) {
      const existingFps = session.getHistoryFingerprints();
      // Check prefix match
      if (
        existingFps.length > 0 &&
        existingFps.length < incomingFps.length &&
        existingFps.every((fp, idx) => fp === incomingFps[idx])
      ) {
        // Prefix match! Send only incremental turns
        const newTurns = flattenedTurns.slice(existingFps.length);
        const incrementalPrompt = TranscriptFlattener.buildIncrementalPrompt(newTurns);
        session.setHistoryFingerprints(incomingFps);
        return { session, prompt: incrementalPrompt };
      }
    }

    // Mismatch, fork, dead, or first turn: kill old session and spawn a fresh one
    if (session) {
      session.dispose();
      this.sessions.delete(sessionKey);
    }

    session = new AgySession(sessionId, model, normalizedEffort, this.config);
    this.sessions.set(sessionKey, session);
    session.setHistoryFingerprints(incomingFps);

    const fullPrompt = TranscriptFlattener.buildFullPrompt(options.system, options.tools, flattenedTurns);
    return { session, prompt: fullPrompt };
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}
