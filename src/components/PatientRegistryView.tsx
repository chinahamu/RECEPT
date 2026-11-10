import React, { useState, useMemo } from 'react';
import { Plus, Search, UserPlus, ArrowRight } from 'lucide-react';
import {
  CopayRatio,
  InsuranceCategory,
  PatientRecord,
} from '../types/receipt';
import { DEMO_DATE } from '../data/demoWorkspace';
import type { PatientView } from '../types/workspace';

interface PatientRegistryViewProps {
  patients: PatientView[];
  onRegisterPatient: (newPatient: PatientRecord) => Promise<boolean>;
  onSelectAndOpenWorkstation: (patientId: string) => void;
}

export const PatientRegistryView: React.FC<PatientRegistryViewProps> = ({
  patients,
  onRegisterPatient,
  onSelectAndOpenWorkstation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [insuranceFilter, setInsuranceFilter] = useState<'ALL' | InsuranceCategory>('ALL');
  const [isFormOpen, setIsFormOpen] = useState(false);

  // New Patient Form State
  const [name, setName] = useState('');
  const [kana, setKana] = useState('');
  const [birthDate, setBirthDate] = useState('1975-06-15');
  const [sex, setSex] = useState<'男' | '女'>('男');
  const [insuranceCategory, setInsuranceCategory] = useState<InsuranceCategory>('社保');
  const [insurerNumber, setInsurerNumber] = useState('01130012');
  const [symbolNumber, setSymbolNumber] = useState('4510-00128');
  const [copayRatio, setCopayRatio] = useState<CopayRatio>(0.3);
  const [formError, setFormError] = useState<string | null>(null);

  const filteredPatients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return patients.filter((pt) => {
      const matchesIns = insuranceFilter === 'ALL' || pt.insuranceCategory === insuranceFilter;
      const matchesQuery =
        !q ||
        pt.name.toLowerCase().includes(q) ||
        pt.kana.toLowerCase().includes(q) ||
        pt.chartNumber.toLowerCase().includes(q) ||
        pt.insurerNumber.includes(q);
      return matchesIns && matchesQuery;
    });
  }, [patients, searchQuery, insuranceFilter]);

  const handleSubmitNewPatient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !kana.trim()) {
      setFormError('患者氏名およびフリガナは必須入力項目です。');
      return;
    }
    if (!/^\d{6,8}$/.test(insurerNumber.trim())) {
      setFormError('保険者番号（6〜8桁）を正しく入力してください。');
      return;
    }
    if (!symbolNumber.trim()) {
      setFormError('被保険者証の記号・番号を入力してください。');
      return;
    }

    const nextNumber = 1210 + patients.length;
    const newPatient: PatientRecord = {
      id: `pt-${Date.now()}`,
      chartNumber: `PT-00${nextNumber}`,
      name: name.trim(),
      kana: kana.trim(),
      birthDate,
      sex,
      insuranceCategory,
      insurerNumber: insurerNumber.trim(),
      symbolNumber: symbolNumber.trim(),
      copayRatio,
      mynaVerified: false,
      lastVisitDate: DEMO_DATE,
      visitCountThisMonth: 1,
      previousMonthTotalPoints: 0,
      auditStatus: '点検済・適正',
      diagnoses: [],
      billingItems: [],
    };

    if (!await onRegisterPatient(newPatient)) return;
    setName('');
    setKana('');
    setFormError(null);
    setIsFormOpen(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-bold text-slate-900">
            患者台帳・保険情報（デモ）
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            架空患者の保険情報・公費情報・来院履歴をSQLiteに保存します
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsFormOpen((prev) => !prev)}
          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          <span>{isFormOpen ? '新規患者登録フォームを閉じる' : '新規患者・保険証登録'}</span>
        </button>
      </div>

      {/* Collapsible New Patient Registration Form */}
      {isFormOpen && (
        <form
          onSubmit={handleSubmitNewPatient}
          aria-label="新規患者・保険証登録フォーム"
          className="bg-white border border-slate-300 rounded-lg p-5 flex flex-col gap-4"
        >
          <div className="border-b border-slate-200 pb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              新規患者・被保険者証情報の登録（初診受付）
            </h2>
            <span className="text-xs text-slate-500">
              登録と同時に初診料（291点）＋医療DX推進体制整備加算（11点）が自動初期セットされます
            </span>
          </div>

          {formError && (
            <div
              role="alert"
              className="p-3 bg-rose-50 border border-rose-200 rounded-md text-xs text-rose-800 font-medium"
            >
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <label htmlFor="pt-name" className="block font-medium text-slate-700 mb-1">
                患者氏名（漢字） *
              </label>
              <input
                id="pt-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 中村 健太郎"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="pt-kana" className="block font-medium text-slate-700 mb-1">
                フリガナ（全角カナ） *
              </label>
              <input
                id="pt-kana"
                type="text"
                value={kana}
                onChange={(e) => setKana(e.target.value)}
                placeholder="例: ナカムラ ケンタロウ"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="pt-birth" className="block font-medium text-slate-700 mb-1">
                生年月日
              </label>
              <input
                id="pt-birth"
                type="date"
                value={birthDate}
                onChange={(e) => setBirthDate(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="pt-sex" className="block font-medium text-slate-700 mb-1">
                性別
              </label>
              <select
                id="pt-sex"
                value={sex}
                onChange={(e) => setSex(e.target.value as '男' | '女')}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              >
                <option value="男">男</option>
                <option value="女">女</option>
              </select>
            </div>

            <div>
              <label htmlFor="pt-ins-cat" className="block font-medium text-slate-700 mb-1">
                保険種別
              </label>
              <select
                id="pt-ins-cat"
                value={insuranceCategory}
                onChange={(e) => setInsuranceCategory(e.target.value as InsuranceCategory)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              >
                <option value="社保">社保（協会けんぽ・組合健保・共済）</option>
                <option value="国保">国保（国民健康保険）</option>
                <option value="後期高齢者">後期高齢者医療広域連合</option>
              </select>
            </div>

            <div>
              <label htmlFor="pt-ins-num" className="block font-medium text-slate-700 mb-1">
                保険者番号 (6〜8桁) *
              </label>
              <input
                id="pt-ins-num"
                type="text"
                value={insurerNumber}
                onChange={(e) => setInsurerNumber(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="pt-sym-num" className="block font-medium text-slate-700 mb-1">
                被保険者証 記号・番号 *
              </label>
              <input
                id="pt-sym-num"
                type="text"
                value={symbolNumber}
                onChange={(e) => setSymbolNumber(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono tabular-nums focus:outline-none focus:border-slate-900"
              />
            </div>

            <div>
              <label htmlFor="pt-copay" className="block font-medium text-slate-700 mb-1">
                窓口一部負担割合
              </label>
              <select
                id="pt-copay"
                value={String(copayRatio)}
                onChange={(e) => setCopayRatio(Number(e.target.value) as CopayRatio)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
              >
                <option value="0.3">3割負担（現役世代等）</option>
                <option value="0.2">2割負担（70〜74歳・後期一定所得）</option>
                <option value="0.1">1割負担（後期高齢者一般）</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4 pt-2 border-t border-slate-100">
            <p className="text-xs text-slate-600">傷病名と診療行為は、登録後に会計・診療入力画面で追加します。</p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsFormOpen(false);
                  setFormError(null);
                }}
                className="px-4 py-2 border border-slate-300 text-slate-700 text-xs font-medium rounded-md hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-md inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>患者台帳へ登録して受付開始</span>
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Search & Filter Bar + Patient Table */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="患者台帳検索"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="氏名・フリガナ・カルテ番号・保険者番号で検索..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-slate-900"
            />
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-md">
            {(['ALL', '社保', '国保', '後期高齢者'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setInsuranceFilter(cat)}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  insuranceFilter === cat
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {cat === 'ALL' ? '全保険種別' : cat}
              </button>
            ))}
          </div>
        </div>

        <div className="border border-slate-200 rounded-md overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <th className="py-2.5 px-3 font-medium">カルテ番号</th>
                <th className="py-2.5 px-3 font-medium">氏名 / フリガナ</th>
                <th className="py-2.5 px-2.5 font-medium">生年月日・性別</th>
                <th className="py-2.5 px-2.5 font-medium">保険種別・保険者番号・記号番号</th>
                <th className="py-2.5 px-2.5 font-medium">主傷病名</th>
                <th className="py-2.5 px-2.5 text-right font-medium">当月点数 / 負担金</th>
                <th className="py-2.5 px-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPatients.map((pt) => {
                const calc = pt.calculation;
                const findings = pt.findings;
                const mainDiag = pt.diagnoses.find((d) => d.isMain) || pt.diagnoses[0];

                return (
                  <tr key={pt.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono tabular-nums font-semibold text-slate-900">
                      {pt.chartNumber}
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-slate-900">{pt.name}</div>
                      <div className="text-[11px] text-slate-500">{pt.kana}</div>
                    </td>
                    <td className="py-2.5 px-2.5 font-mono tabular-nums text-slate-700">
                      {pt.birthDate} · {pt.sex}
                    </td>
                    <td className="py-2.5 px-2.5 font-mono tabular-nums text-slate-700">
                      <div>
                        {pt.insuranceCategory} · {Math.round(pt.copayRatio * 10)}割負担
                      </div>
                      <div className="text-[11px] text-slate-500">
                        保険者 {pt.insurerNumber} · 記号 {pt.symbolNumber}
                      </div>
                    </td>
                    <td className="py-2.5 px-2.5 text-slate-800">
                      {mainDiag ? `${mainDiag.diseaseName} (${mainDiag.icd10})` : '未登録'}
                      {pt.diagnoses.length > 1 && (
                        <span className="text-slate-500"> 他{pt.diagnoses.length - 1}件</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono tabular-nums">
                      <div className="font-semibold text-slate-900">
                        {calc.totalPoints.toLocaleString()}点 (¥{calc.copayRoundedYen.toLocaleString()})
                      </div>
                      <div className="text-[11px] text-slate-500">
                        指摘 {findings.length}件
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => onSelectAndOpenWorkstation(pt.id)}
                        className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded inline-flex items-center gap-1 whitespace-nowrap"
                      >
                        <span>診療会計を開く</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
