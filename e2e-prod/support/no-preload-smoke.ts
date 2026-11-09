import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function noPreloadSmoke(root: string, environment: NodeJS.ProcessEnv, directory: string, port: number) {
  const started = performance.now(), logFile = path.join(directory, 'no-preload.log');
  const out = fs.openSync(logFile, 'a');
  const env: NodeJS.ProcessEnv = { ...environment, WORKER_ENABLED: 'false' };
  // Do not inherit a process-wide preload through NODE_OPTIONS either.
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['server.ts'], { cwd: root, env, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  const controller = new AbortController();
  const kill = () => { controller.abort(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  process.once('exit', kill);
  process.on('SIGINT', kill); process.on('SIGTERM', kill);
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const ready = async () => {
      const deadline = performance.now() + 120_000;
      while (!controller.signal.aborted && performance.now() < deadline) {
        try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) }); await response.text(); if (response.status === 200) return 200; } catch { /* Startup in progress. */ }
        await delay(100, undefined, { signal: controller.signal });
      }
      throw new Error('Production smoke startup timed out');
    };
    const health = await Promise.race([ready(), exited.then(code => { throw new Error(`Production smoke exited before readiness: ${code}`); })]);
    const page = await fetch(`http://127.0.0.1:${port}/principles`, { headers: { Host: new URL(env.BETTER_AUTH_URL!).host, 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(30_000) });
    const html = await page.text();
    if (page.status !== 200 || !/<h1\b/.test(html)) throw new Error('Production smoke failed to render its Markdown document');
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null;
    try {
      exitCode = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Production smoke shutdown timed out')), 30_000); })]);
    } finally { clearTimeout(timer); }
    if (exitCode !== 0) throw new Error('Production smoke did not stop cleanly');
    return { health, document: page.status, exitCode, durationMs: Math.round(performance.now() - started) };
  } finally {
    process.off('exit', kill); process.off('SIGINT', kill); process.off('SIGTERM', kill);
    kill();
    await exited.catch(() => {});
  }
}
