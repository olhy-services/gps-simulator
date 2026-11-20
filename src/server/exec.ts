import { execFile } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: string | number | null,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Executa um binário sem shell (argumentos nunca são interpretados pelo host).
 * Rejeita com `CommandError` se o processo sair com código ≠ 0 ou não existir.
 */
export function run(file: string, args: readonly string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout || error.message).trim().split('\n').slice(0, 3).join(' ');
        reject(new CommandError(detail, error.code ?? null));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function isMissingBinary(error: unknown): boolean {
  return error instanceof CommandError && error.code === 'ENOENT';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
