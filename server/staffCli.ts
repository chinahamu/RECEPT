import { staffRoles, type StaffRole } from '../src/types/staff';
import { openWorkspace } from './workspace';

try {
  const [operation, id, role] = process.argv.slice(2);
  const create = operation === 'create';
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      (create ? process.argv.length !== 5 || !staffRoles.includes(role as StaffRole)
        : !['reset', 'disable'].includes(operation) || process.argv.length !== 4)) {
    throw new Error('使い方: npm run staff -- create <職員ID> <reception|nurse|physician|admin> | reset <職員ID> | disable <職員ID>');
  }
  const store = openWorkspace();
  try {
    if (operation === 'disable') {
      store.accounts.disable(id);
      console.log(`${id} を無効化しました。`);
    } else {
      const password = create ? store.accounts.create(id, role as StaffRole) : store.accounts.reset(id);
      console.log(`職員ID ${id}\n初期パスワード ${password}`);
    }
  } finally {
    store.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '職員アカウント操作に失敗しました。');
  process.exitCode = 1;
}
