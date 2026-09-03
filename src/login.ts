import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildAgyEnv } from './session.js';

export interface AgyStatusInfo {
  installed: boolean;
  version: string;
  agyPath: string;
  scratchDir: string;
  hasCachedAuth: boolean;
  authenticated?: boolean;
}

export async function detectAgyStatus(agyPath: string, scratchDir: string): Promise<AgyStatusInfo> {
  const geminiDir = join(homedir(), '.gemini');
  const hasCachedAuth = existsSync(geminiDir);

  try {
    if (!existsSync(scratchDir)) {
      mkdirSync(scratchDir, { recursive: true });
    }
  } catch {
    // Ignore mkdir error during status check
  }

  return new Promise((resolve) => {
    execFile(agyPath, ['--version'], { timeout: 4000, env: buildAgyEnv() }, (error, stdout) => {
      if (error) {
        resolve({
          installed: false,
          version: '',
          agyPath,
          scratchDir,
          hasCachedAuth,
        });
      } else {
        const version = stdout.trim();
        resolve({
          installed: true,
          version,
          agyPath,
          scratchDir,
          hasCachedAuth,
        });
      }
    });
  });
}

export function openLoginTerminal(agyPath: string): { started: boolean; error?: string } {
  try {
    const os = platform();
    if (os === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', agyPath], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    } else if (os === 'darwin') {
      const child = spawn('open', ['-a', 'Terminal', agyPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    } else {
      // Linux fallback
      const child = spawn('x-terminal-emulator', ['-e', agyPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { started: true };
    }
  } catch (err) {
    return {
      started: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyCredentials(agyPath: string, scratchDir: string): Promise<{ authenticated: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      agyPath,
      [
        '-p',
        'ping',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--print-timeout',
        '15s',
      ],
      { cwd: scratchDir, timeout: 20_000, env: buildAgyEnv() },
      (error, stdout) => {
        if (error) {
          resolve({
            authenticated: false,
            error: error.message,
          });
          return;
        }

        try {
          const lines = stdout.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const data = JSON.parse(trimmed);
            if (data.event === 'result') {
              if (data.result?.status === 'SUCCESS') {
                resolve({ authenticated: true });
                return;
              } else {
                resolve({
                  authenticated: false,
                  error: data.result?.error?.message || 'Returned error status',
                });
                return;
              }
            }
          }
          resolve({ authenticated: true });
        } catch (e) {
          resolve({
            authenticated: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    );
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers['origin'];
  const host = req.headers['host'];
  if (!origin || !host) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch {
    return false;
  }
}
