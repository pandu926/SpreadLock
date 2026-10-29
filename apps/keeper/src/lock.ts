import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function acquireKeeperLock(path: string): () => void {
  const identity = `${process.pid}:${randomUUID()}`;
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(path, 'utf8');
    const pid = Number(existing.split(':', 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Keeper lock requires operator inspection');
    try { process.kill(pid, 0); throw new Error('Another keeper is running with this database'); }
    catch (signalError) {
      if ((signalError as NodeJS.ErrnoException).code !== 'ESRCH') throw signalError;
    }
    // Exclusive create below still arbitrates concurrent recovery attempts.
    if (readFileSync(path, 'utf8') !== existing) throw new Error('Keeper lock changed during recovery');
    unlinkSync(path);
    descriptor = openSync(path, 'wx', 0o600);
  }
  writeSync(descriptor, identity);
  fsyncSync(descriptor);
  closeSync(descriptor);
  return () => {
    try { if (readFileSync(path, 'utf8') === identity) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}
