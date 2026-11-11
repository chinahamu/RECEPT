import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const recept = fileURLToPath(new URL('../../', import.meta.url));
const dencal = resolve(process.env.DENCAL_REPO ?? join(recept, '../DENCAL'));
if (!existsSync(join(dencal, 'server/recept.e2e.test.ts'))) {
  console.error('結合テストを含むDENCALを取得し、DENCAL_REPOにリポジトリのパスを指定してください。');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'server/recept.e2e.test.ts'], {
    cwd: dencal, env: { ...process.env, RECEPT_REPO: recept }, stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
