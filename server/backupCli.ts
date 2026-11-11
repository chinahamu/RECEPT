import { createBackup, restoreBackup, verifyBackup } from './databaseBackup';

async function main(args: string[]) {
  const [command, path, output] = args;
  if (!path || (command === 'restore' ? args.length !== 3 || !output : args.length !== 2) ||
      (command !== 'create' && command !== 'verify' && command !== 'restore')) {
    throw new Error('使い方: npm run --silent db:backup -- create <保存先> | verify <世代フォルダー> | restore <世代フォルダー> <新しいDB.sqlite3>');
  }
  const result = command === 'create' ? await createBackup(path)
    : command === 'verify' ? await verifyBackup(path) : await restoreBackup(path, output);
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'バックアップ・復元処理に失敗しました。');
  process.exitCode = 1;
});
