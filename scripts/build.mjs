import { build } from 'esbuild';
import { mkdir, access } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const name of ['api', 'indexer', 'keeper', 'cli']) {
  const entry = `apps/${name}/src/main.ts`;
  await access(entry);
  await build({ entryPoints: [entry], outfile: `dist/${name}.mjs`, bundle: true,
    platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: true });
}
