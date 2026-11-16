# 初回セットアップ：公式マスター7種類の配置

RECEPTの初回DB構築は **ユーザーが正規配布元からダウンロードした全件マスター** を所定のフォルダから読み込む方式です。**実マスター本体はGitHubに含めません。**

```text
RECEPT/
├─ setup-input/
│  ├─ README.md
│  ├─ published-on.example.json
│  └─ masters/
│     ├─ s_YYYYMMDD.csv  # 医科診療行為
│     ├─ y_YYYYMMDD.csv  # 医薬品
│     ├─ t_YYYYMMDD.csv  # 特定器材
│     ├─ b_YYYYMMDD.txt  # 傷病名
│     ├─ z_YYYYMMDD.txt  # 修飾語
│     ├─ c_YYYYMMDD.csv  # コメント
│     ├─ k.csv           # 病棟コード（k_YYYYMMDD.csv も可）
│     └─ published-on.json
└─ data/
   ├─ recept.sqlite3
   └─ initial-setup-report.json
```

**セットアップ前に行うこと**

1. [厚労省の医科向け基本マスター](https://shinryohoshu.mhlw.go.jp/shinryohoshu/downloadMenu/)および[傷病名・修飾語マスター](https://shinryohoshu.mhlw.go.jp/shinryohoshu/standardMenu/doStandardMasterBz/)から7種類の全件版を取得します。詳細は [出典一覧](../docs/official-masters.md) にあります。
2. ZIPを展開してCSV/TXTだけを `setup-input/masters/` に配置します。**Excelで開いて保存し直したりファイル名を変更したりしない**でください。
3. 日付がファイル名にない `k.csv` を使用する場合は、配布元の実際の更新日を調べ、`setup-input/published-on.example.json` を参考に `setup-input/masters/published-on.json` を作成します。例：

   ```json
   {
     "k.csv": "2026-07-03"
   }
   ```

   これは記載形式の例です。**実際に配置した配布版の更新日を優先**してください。`k_YYYYMMDD.csv` 形式なら追加の指定は不要です。

**初回作成コマンド（リポジトリ直下）**

```sh
npm ci
npm run db:init
npm run staff -- create demo-admin admin
npm run dev
```

`db:init` 1回で **RECEPTの現行スキーマv7、初期デモ患者、公式マスター7種類、検索用データ** を `data/recept.sqlite3` に一括作成します。`staff` は管理者ユーザーを登録する別コマンドです。

- 取り込み件数、ファイル別更新日、ハッシュは `data/initial-setup-report.json` に記録されます。
- 複数の版を配置した場合は古い日付から順に取り込み、RECEPTにはすべての版を保存します。
- 7種類のいずれかが欠けている場合、マスターの形式が不正な場合、またはファイルが20 MiBを超えている場合は中断し、**完成していないDBは配置しません**。
- 既存の `data/recept.sqlite3` は**上書きしません**。再初期化のために実患者データを含むDBを削除しないでください。既存DBへのマスターの追加・更新は引き続き「公式マスターの取り込み・参照」画面を使えます。
- DBは単一のSQLiteファイルです。別の初期DBを作成する場合は `npm run db:init -- --db ./data/recept-test.sqlite3` を使い、起動時の `RECEPT_DB` も同じ値にしてください。
- 別の入力フォルダから取り込む場合は `npm run db:init -- --input /path/to/setup-input` を使えます。Windowsでは `RECEPT_PYTHON` 環境変数でPython 3.10以降の実行ファイルを指定できます。
- 取り込んだファイルの出典および配布日の確認は利用者が行います。正式な算定・請求が可能になるわけではありません。

**権利・公開範囲:** ツール・スキーマ・テストデータのみをGitで公開し、ダウンロード済みマスターや生成DBをGit管理しないようにしています。医療機関の実運用前に利用許諾・最新コード・診療報酬の規則を確認してください。
