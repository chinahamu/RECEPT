import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  officialFilename, type MasterImport, type MasterKind, type MasterRow,
} from '../src/data/officialMasters';
import { WorkspaceError } from './errors';

// One-based field numbers from the FY2026 layouts. Ward codes use the medical procedure layout.
const layouts = {
  s: { marker: 'S', columns: 150, code: 3, name: 113, shortName: 5, pattern: /^1\d{8}$/ },
  y: { marker: 'Y', columns: 42, code: 3, name: 35, shortName: 5, pattern: /^6\d{8}$/ },
  t: { marker: 'T', columns: 38, code: 3, name: 37, shortName: 5, pattern: /^7\d{8}$/ },
  b: { marker: 'B', columns: 46, code: 3, name: 6, shortName: 8, pattern: /^\d{7}$/ },
  z: { marker: 'Z', columns: 19, code: 3, name: 7, shortName: 7, pattern: /^\d{4}$/ },
  c: { marker: 'C', columns: 30, code: 23, name: 7, shortName: 7, pattern: /^8\d{8}$/ },
  k: { marker: 'S', columns: 150, code: 3, name: 113, shortName: 5, pattern: /^190\d{6}$/ },
};

const commentLabels = new Map([['10', '自由記載'], ['90', '修飾語（部位）コード']]);

export function masterFileParams(filename: string, publishedOn: string) {
  const match = officialFilename.exec(filename);
  if (!match) {
    throw new WorkspaceError(400, '公式の全件マスターを解凍し、元のファイル名のCSVまたはTXTを選んでください。');
  }
  const date = new Date(publishedOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedOn) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== publishedOn) {
    throw new WorkspaceError(400, '公式配布ページに記載された更新日を入力してください。');
  }
  if (match[2] && publishedOn !== `${match[2]}-${match[3]}-${match[4]}`) {
    throw new WorkspaceError(400, '入力した更新日がファイル名の日付と一致しません。');
  }
  return { filename, publishedOn, kind: match[1].toLowerCase() as MasterKind };
}

function decodeMaster(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
    } catch {
      throw new WorkspaceError(400, '文字コードを読み取れません。解凍したファイルをそのまま選んでください。');
    }
  }
}

function parseRows(kind: MasterKind, bytes: Buffer) {
  const layout = layouts[kind];
  const rows = new Map<string, { name: string; fields: string[] }>();
  const lines = decodeMaster(bytes).split(/\r\n|\n|\r/);
  // The official files use either bare fields or CSV fields with double-quote escaping.
  const csvField = /(?:"((?:[^"]|"")*)"|([^",]*))(,|$)/gy;
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) continue;
    const fields: string[] = [];
    csvField.lastIndex = 0;
    let field: RegExpExecArray | null;
    while ((field = csvField.exec(line))) {
      fields.push(field[1] === undefined ? field[2] : field[1].replaceAll('""', '"'));
      if (field[3] === '') break;
    }
    const code = fields[layout.code - 1];
    const commentLabel = kind === 'c' ? commentLabels.get(fields[3]) : undefined;
    const name = fields[layout.name - 1]?.trim() || fields[layout.shortName - 1]?.trim() || commentLabel;
    if (!field || fields.length !== layout.columns || !/^[012359]$/.test(fields[0]) ||
        fields[1] !== layout.marker || !layout.pattern.test(code) || !name ||
        rows.has(code) || line.includes('\0')) {
      throw new WorkspaceError(400, `${index + 1}行目が対象マスターの書式と一致しないか、コードが重複しています。`);
    }
    rows.set(code, { name, fields });
  }
  if (!rows.size) throw new WorkspaceError(400, 'マスターにデータがありません。');
  return rows;
}

const importColumns = `id, kind, filename, published_on AS publishedOn, imported_at AS importedAt,
                       sha256, row_count AS rowCount`;

export function officialMasters(db: DatabaseSync, transaction: <T>(work: () => T) => T) {
  return {
    list: () => db.prepare(`SELECT ${importColumns} FROM master_imports ORDER BY published_on DESC, id DESC`)
      .all() as unknown as MasterImport[],
    search: (id: number, query: string) => db.prepare(`
      SELECT code, name FROM master_rows
      WHERE import_id = ? AND (instr(code, ?) > 0 OR instr(name, ?) > 0)
      ORDER BY code LIMIT 100
    `).all(id, query, query) as unknown as MasterRow[],
    import: (params: ReturnType<typeof masterFileParams>, bytes: Buffer) => {
      const { kind, filename, publishedOn } = params;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const rows = parseRows(kind, bytes);
      return transaction(() => {
        const existing = db.prepare(`SELECT ${importColumns} FROM master_imports
          WHERE kind = ? AND published_on = ? AND sha256 = ?`).get(kind, publishedOn, sha256) as
          unknown as MasterImport | undefined;
        if (existing) return { entry: existing, duplicate: true };

        const importedAt = new Date().toISOString();
        const result = db.prepare(`INSERT INTO master_imports
          (kind, filename, published_on, imported_at, sha256, row_count) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(kind, filename, publishedOn, importedAt, sha256, rows.size);
        const id = Number(result.lastInsertRowid);
        const insert = db.prepare('INSERT INTO master_rows (import_id, code, name, fields) VALUES (?, ?, ?, ?)');
        for (const [code, row] of rows) insert.run(id, code, row.name, JSON.stringify(row.fields));
        const entry: MasterImport = { id, kind, filename, publishedOn, importedAt, sha256, rowCount: rows.size };
        return { entry, duplicate: false };
      });
    },
  };
}
