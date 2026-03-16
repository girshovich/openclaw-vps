import { spawn } from 'node:child_process';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8_000;

function wrapExternal(content: string): string {
  return `<<EXTERNAL UNTRUSTED CONTEXT>>\n${content}\n<<END OF THE EXTERNAL UNTRUSTED CONTENT>>`;
}

export function executeBash(command: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', command], { timeout: TIMEOUT_MS });

    signal?.addEventListener('abort', () => {
      proc.kill();
      reject(new Error('Aborted'));
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${stdout.slice(0, MAX_OUTPUT)}`);
      if (stderr) parts.push(`stderr:\n${stderr.slice(0, MAX_OUTPUT)}`);
      parts.push(`exit_code: ${code ?? 'null'}`);
      resolve(wrapExternal(parts.join('\n\n')));
    });

    proc.on('error', (err) => reject(err));
  });
}
