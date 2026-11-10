import type { DatabaseSync } from 'node:sqlite';
import { DEMO_DATE } from '../src/data/demoWorkspace';
import type { ClinicalMasterEntries, DiseaseEntry, ProcedureEntry } from '../src/data/officialMasters';
import type { typeBillingCategoryCode } from '../src/types/receipt';
import { CATEGORY_LABELS } from '../src/utils/receiptEngine';

// 令和8年度レイアウトの点数欄集計先識別（入院外）を既存のデモ集計区分に対応させる。
const categories = new Map<string, typeBillingCategoryCode>([
  ['110', '11'], ['120', '11'], ['122', '11'], ['123', '11'], ['124', '11'], ['125', '11'],
  ['130', '13'], ['140', '14'], ['210', '21'], ['230', '21'], ['240', '21'], ['250', '21'],
  ['260', '21'], ['270', '21'], ['300', '30'], ['311', '30'], ['321', '30'], ['331', '30'],
  ['400', '40'], ['600', '60'], ['700', '70'], ['800', '80'],
]);

type ClinicalKind = keyof ClinicalMasterEntries;
type StoredRow = { code: string; name: string; fields: string };

function disease(row: StoredRow, date: string): DiseaseEntry | undefined {
  const fields: string[] = JSON.parse(row.fields);
  if (row.code === '0000999' || ['1', '9'].includes(fields[0]) ||
      fields[18] !== '00' || fields[19] !== '0' ||
      fields[21] > date || fields[22] > date || (fields[23] && fields[23] < date)) return;
  return { code: row.code, name: row.name, icd10: fields[15].trim() || fields[16].trim() };
}

function procedure(row: StoredRow, date: string): ProcedureEntry | undefined {
  const fields: string[] = JSON.parse(row.fields);
  const points = Number(fields[11]);
  const category = categories.get(fields[14]);
  if (!category || ['1', '9'].includes(fields[0]) || fields[10] !== '3' ||
      fields[12] === '1' || fields[15] !== '0' || fields[29] !== '0' ||
      fields[86] > date || (fields[87] && fields[87] < date) ||
      !fields[11].trim() || !Number.isFinite(points) || points <= 0 || points > 100_000) return;
  return {
    code: row.code, name: row.name, category, categoryName: CATEGORY_LABELS[category],
    itemType: 'procedure', points, unit: fields[9].trim() || '回',
  };
}

const toEntry = { b: disease, s: procedure };

export function clinicalMasters(db: DatabaseSync) {
  const base = `
    SELECT code, name, fields FROM master_rows WHERE import_id = (
      SELECT id FROM master_imports WHERE kind = ? AND published_on <= ?
      ORDER BY published_on DESC, id DESC LIMIT 1
    )
  `;
  const lookup = db.prepare(`${base} AND code = ?`);
  const search = db.prepare(`${base}
    AND (instr(code, ?) > 0 OR instr(name, ?) > 0) ORDER BY code`);
  return {
    lookup<K extends ClinicalKind>(kind: K, code: string, date: string) {
      const row = lookup.get(kind, date, code) as StoredRow | undefined;
      return row && toEntry[kind](row, date.replaceAll('-', '')) as ClinicalMasterEntries[K] | undefined;
    },
    search<K extends ClinicalKind>(kind: K, query: string) {
      const result: ClinicalMasterEntries[K][] = [];
      for (const row of search.iterate(kind, DEMO_DATE, query, query)) {
        const entry = toEntry[kind](row as StoredRow, DEMO_DATE.replaceAll('-', '')) as ClinicalMasterEntries[K] | undefined;
        if (entry) result.push(entry);
        if (result.length === 50) break;
      }
      return result;
    },
  };
}
