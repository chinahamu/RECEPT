export const MASTER_DOWNLOAD = 'https://shinryohoshu.mhlw.go.jp/shinryohoshu/downloadMenu/';
export const MASTER_DISEASE_DOWNLOAD = 'https://shinryohoshu.mhlw.go.jp/shinryohoshu/standardMenu/doStandardMasterBz/';
export const MASTER_GUIDE = 'https://github.com/chinahamu/RECEPT/blob/main/docs/official-masters.md';
export const MASTER_MAX_BYTES = 20 * 1024 * 1024;

export const OFFICIAL_MASTERS = {
  s: '医科診療行為',
  y: '医薬品',
  t: '特定器材',
  b: '傷病名',
  z: '修飾語',
  c: 'コメント',
  k: '病棟コード',
} as const;

export type MasterKind = keyof typeof OFFICIAL_MASTERS;

export interface MasterImport {
  id: number;
  kind: MasterKind;
  filename: string;
  publishedOn: string;
  importedAt: string;
  sha256: string;
  rowCount: number;
}

export interface MasterRow {
  code: string;
  name: string;
}

export const officialFilename = /^(s|y|t|b|z|c|k)(?:_(\d{4})(\d{2})(\d{2}))?\.(?:csv|txt)$/i;
