import { CheckCircle, ChevronDown, ChevronLeft, ChevronRight, Download, FileUp, History, Info, MapPin, Minus, Plus, Sparkles, RotateCcw, Save, Search, SlidersHorizontal, Tag, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { defaultSettings } from '../../src/domain/defaults';
import { detectLocation } from '../../src/domain/location';
import { SettingsSchema, withoutSkillNote, type Article, type CategoryCode, type LocationArea, type RuleGroup, type RuleNode, type RuleTerm, type Settings, type Source } from '../../src/domain/schemas';
import { formatVn, lastCompletedWindow } from '../../src/domain/timeWindow';
import { LATEST_RUN, SCHEDULE_SLOTS, SLOT_NAMES, slotsFor, validateTimes, type ScheduleSlotId, type ScheduleTimes } from '../../src/domain/schedule';
import { uid } from '../../src/domain/text';
import { api, type GoldenSet, type HistoryEntry, type PreviewResult, type ProfilesState, type SuggestionsState, type TemplateOption, type TokenInfo, type UserInfo, type UserRole, adminOnly, ADMIN_HINT } from './api';
import { alreadyApplied, applySuggestion, impactOf, type FilterSuggestion, type Judged } from '../../src/domain/suggest';
import { RuleBuilder } from './RuleBuilder';
import { SourcesPanel } from './SourcesPanel';
import { ChipEditor, Field, NumberField, Section, Select, Time24, Toggle, useEscape, useToast } from './ui';

const NAV = [
  ['profiles', 'Tổng quan'],
  ['suggest', 'Gợi ý cải thiện'],
  ['sources', 'Nguồn tin'],
  ['rules', 'Từ khóa & quy tắc'],
  ['location', 'Địa điểm'],
  ['categories', 'Lĩnh vực'],
  ['time', 'Thời gian'],
  ['quality', 'Chất lượng thu thập & ảnh'],
  ['report', 'Báo cáo & mẫu'],
  ['users', 'Tài khoản'],
  ['performance', 'Hiệu năng'],
  ['backup', 'Sao lưu & lịch sử'],
] as const;
type NavKey = (typeof NAV)[number][0] | 'newProfile';
/** technical sections, shown with the "Nâng cao" switch (everything stays editable in the UI) */
const ADVANCED: ReadonlyArray<NavKey> = ['time', 'quality', 'performance', 'backup'];
const ADV_KEY = 'hcm-settings-advanced';
const readAdvanced = () => {
  try {
    return localStorage.getItem(ADV_KEY) === '1';
  } catch {
    return false;
  }
};

export function SettingsDrawer({ open, onClose, onSaved, initialSection }: { open: boolean; onClose: () => void; onSaved: (s: Settings, src: Source[]) => void; initialSection?: NavKey }) {
  const toast = useToast();
  const [saved, setSaved] = useState<{ s: Settings; src: Source[] } | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [src, setSrc] = useState<Source[]>([]);
  const [nav, setNavState] = useState<NavKey>(initialSection ?? 'sources');
  /** phones: 'list' = the sections, 'detail' = one section full screen (md and wider show both) */
  const [pane, setPane] = useState<'list' | 'detail'>(initialSection ? 'detail' : 'list');
  const setNav = (k: NavKey) => {
    setNavState(k);
    setPane('detail');
  };
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvancedState] = useState(readAdvanced);
  const [sugCount, setSugCount] = useState(0);
  useEffect(() => {
    if (open && api.suggestions) api.suggestions().then((r) => setSugCount(r.items.length)).catch(() => undefined);
  }, [open]);
  const setAdvanced = (v: boolean) => {
    setAdvancedState(v);
    try {
      localStorage.setItem(ADV_KEY, v ? '1' : '0');
    } catch {
      /* private mode: per session only */
    }
  };

  /** all profiles; every section edits the open (active) one */
  const [profs, setProfs] = useState<ProfilesState | null>(null);
  const profName = profs ? (profs.profiles.find((x) => x.id === profs.activeId)?.name ?? profs.activeId) : '';
  const load = async () => {
    api.profiles().then(setProfs).catch(() => setProfs(null));
    const [a, b] = await Promise.all([api.getSettings(), api.getSources()]);
    setSaved({ s: a, src: b });
    setS(structuredClone(a));
    setSrc(structuredClone(b));
  };
  useEffect(() => {
    if (open) load().catch((e) => toast('err', e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (initialSection && open) setNav(initialSection);
    else if (open) setPane('list');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection, open]);

  const dirtyS = !!s && !!saved && JSON.stringify(s) !== JSON.stringify(saved.s);
  const dirtySrc = !!saved && JSON.stringify(src) !== JSON.stringify(saved.src);
  const validation = useMemo(() => (s ? SettingsSchema.safeParse(s) : null), [s]);
  // impact preview: the draft vs the saved settings on the stories the team judged ("bộ bài chuẩn")
  const [gold, setGold] = useState<GoldenSet | null>(null);
  const [impact, setImpact] = useState<ReturnType<typeof impactOf> | null>(null);
  useEffect(() => {
    if (dirtyS && !gold && api.golden) api.golden().then(setGold).catch(() => setGold({ articles: [], judged: {} }));
  }, [dirtyS, gold]);
  useEffect(() => {
    if (!dirtyS || !gold?.articles.length || !saved || !validation?.success) return setImpact(null);
    const timer = setTimeout(() => {
      const arts = gold.articles.map((x) => ({ ...x, contentSections: [], imageCandidates: [] }) as unknown as Article);
      const judged = new Map(Object.entries(gold.judged).map(([k, v]) => [k, { relevant: v, why: 'label' } as Judged]));
      setImpact(impactOf(arts, judged, SettingsSchema.parse(saved.s), validation.data));
    }, 400);
    return () => clearTimeout(timer);
  }, [dirtyS, gold, saved, validation]);
  useEscape(() => close(), open); // same as the X button (asks before dropping unsaved changes)
  if (!open) return null;

  /** open another profile: it becomes the active one, the page reloads and Settings reopen on the same section */
  const switchProfile = async (id: string, label: string) => {
    if ((dirtyS || dirtySrc) && !confirm(`Có thay đổi chưa lưu. Chuyển sang cấu hình "${label}" và bỏ thay đổi?`)) return;
    try {
      await api.activateProfile(id);
      reopenSettingsAfterReload(nav === 'newProfile' ? 'profiles' : nav);
      window.location.reload();
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  const close = () => {
    if ((dirtyS || dirtySrc) && !confirm('Có thay đổi chưa lưu. Đóng và bỏ thay đổi?')) return;
    onClose();
  };
  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      let ns = saved!.s;
      let nsrc = saved!.src;
      if (dirtyS) ns = await api.saveSettings(s, `Cập nhật mục ${NAV.find((n) => n[0] === nav)?.[1]}`);
      if (dirtySrc) nsrc = await api.saveSources(src, 'Cập nhật nguồn tin');
      setSaved({ s: ns, src: nsrc });
      setS(structuredClone(ns));
      setSrc(structuredClone(nsrc));
      onSaved(ns, nsrc);
      toast('ok', 'Đã lưu cài đặt');
    } catch (e) {
      toast('err', `Không lưu được: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  const up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => setS((p) => (p ? { ...p, [k]: Array.isArray(p[k]) ? v : { ...(p[k] as object), ...v } } : p));
  const resetSection = () => {
    const d = defaultSettings();
    const map: Partial<Record<NavKey, Array<keyof Settings>>> = {
      rules: ['keywords', 'rules'], location: ['location'], categories: ['categories'], time: ['reportWindow', 'startup'],
      quality: ['quality', 'discovery', 'editorial'], report: ['report'], performance: ['collection', 'performance'],
    };
    const keys = map[nav];
    if (!keys || !s || !confirm('Đặt lại mục này về mặc định? (Chưa lưu cho tới khi bấm Lưu)')) return;
    setS({ ...s, ...Object.fromEntries(keys.map((k) => [k, d[k]])) });
  };

  // Tài khoản: only on the web with the shared server (the local app has no accounts)
  const navItems = NAV.filter(([k]) => k !== 'users' || !!api.shared).filter(([, l]) => !filter || l.toLowerCase().includes(filter.toLowerCase()) || SEARCH_INDEX[NAV.find((n) => n[1] === l)![0]]?.some((w) => w.includes(filter.toLowerCase())));
  // advanced sections are listed when the switch is on, while searching, or when one of them is open
  const showAdvanced = advanced || !!filter || ADVANCED.includes(nav);
  const navBtn = ([k, l]: (typeof NAV)[number]) => (
    <button key={k} onClick={() => setNav(k)} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-[15px] transition md:px-2.5 md:py-1.5 md:text-sm ${nav === k ? 'md:bg-navy-700 md:text-white md:shadow-sm' : ''} text-slate-700 hover:bg-slate-100 ${nav === k ? 'md:hover:bg-navy-700' : ''}`}>
      {l}
      {k === 'suggest' && sugCount > 0 && <span className="ml-auto min-w-[1.25rem] rounded-full bg-amber-500 px-1.5 text-center text-[11px] font-bold text-white" data-testid="suggest-count">{sugCount}</span>}
      <ChevronRight className={`h-4 w-4 shrink-0 text-slate-300 md:hidden ${k === 'suggest' && sugCount > 0 ? '' : 'ml-auto'}`} />
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" role="dialog" aria-modal="true" aria-label="Cài đặt">
      <div className="flex h-full w-full max-w-[1100px] flex-col bg-slate-50 shadow-2xl">
        <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
          <SlidersHorizontal className="hidden h-5 w-5 text-teal-600 sm:block" />
          <h2 className="shrink-0 whitespace-nowrap text-lg font-bold text-navy-800">Cài đặt</h2>
          {profName && (
            <span className="chip min-w-0 whitespace-nowrap border-navy-100 bg-navy-50 text-navy-800" data-testid="settings-profile" title="Nguồn tin, từ khóa & quy tắc, địa điểm, lĩnh vực, thời gian, chất lượng, báo cáo và hiệu năng thuộc riêng cấu hình này. Đổi cấu hình ở mục Cấu hình (profile).">
              <span className="hidden sm:inline">Cấu hình:</span> <b className="truncate sm:ml-1">{profName}</b>
            </span>
          )}
          {api.mode === 'live' && api.shared && (
            <details className="relative" data-testid="shared-config-note">
              <summary className="chip cursor-pointer list-none whitespace-nowrap border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100" aria-label="Áp dụng cho cả nhóm">
                <Users className="h-3 w-3" /> <span className="hidden sm:inline">Áp dụng cho cả nhóm</span><span className="sm:hidden">Cả nhóm</span> <Info className="h-3 w-3" />
              </summary>
              <div className="animate-in fixed left-3 right-3 top-14 z-10 mt-2 rounded-xl sm:absolute sm:left-0 sm:right-auto sm:top-auto sm:w-80 border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-700 shadow-lg">
                Cài đặt của cấu hình <b>{profName}</b> dùng chung cho cả nhóm: bấm <b>Lưu</b> (cần đăng nhập người duyệt) là áp dụng cho máy chủ thu thập từ lượt kế tiếp. Mỗi lần lưu được ghi vào lịch sử, có thể khôi phục. Riêng mẫu PPTX tải lên chỉ lưu trong trình duyệt này.
              </div>
            </details>
          )}
          <span className="flex-1" />
          <button className="btn-ghost rounded-full px-2.5" onClick={resetSection} disabled={nav === 'profiles' || nav === 'newProfile' || nav === 'sources' || nav === 'backup' || nav === 'users'} title="Đặt mục này về mặc định" aria-label="Mặc định mục này">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button className="btn-ghost rounded-full px-2.5" onClick={close} aria-label="Đóng cài đặt" title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </header>
        {adminOnly() && (
          <div className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-900" data-testid="reviewer-readonly">
            Bạn đăng nhập với quyền <b>người duyệt</b>: xem được mọi cài đặt; lưu cài đặt dùng chung, cấu hình địa bàn, lịch tự động và khóa thu thập là việc của quản trị viên.
          </div>
        )}
        {validation && !validation.success && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-800">
            {validation.error.issues.slice(0, 5).map((i) => (
              <div key={i.path.join('.')}>{i.path.join(' › ')}: {i.message}</div>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <nav className={`${pane === 'detail' ? 'hidden' : 'flex-1'} overflow-auto bg-white p-3 md:block md:w-56 md:flex-none md:shrink-0 md:border-r md:border-slate-200 md:p-2`} data-testid="settings-nav">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-slate-400" />
              <input className="input pl-7 text-xs" type="search" placeholder="Tìm cài đặt…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {/* one tree: every profile, the open one expanded with ALL its sections (overview, sources, rules, …) */}
            <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cấu hình</div>
            {(profs?.profiles ?? [{ id: '', name: profName || '…' }]).map((p) =>
              !profs || p.id === profs.activeId ? (
                <div key={p.id || 'active'} className="mb-1" data-testid="nav-this-profile">
                  <div className="flex items-center gap-1 px-2 py-1.5 text-sm font-semibold text-navy-800">
                    <ChevronDown className="h-4 w-4 shrink-0" /> <span className="truncate">{p.name}</span>
                    <span className="chip ml-auto border-teal-300 bg-teal-50 px-1.5 text-[10px] text-teal-900">đang mở</span>
                  </div>
                  <div className="ml-3 border-l-2 border-navy-100 pl-1">
                    {navItems.filter(([k]) => !ADVANCED.includes(k)).map(navBtn)}
                    {showAdvanced && navItems.some(([k]) => ADVANCED.includes(k)) && (
                      <div className="mt-2 border-t border-dashed border-slate-200 pt-2" data-testid="nav-advanced">
                        <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Nâng cao</div>
                        {navItems.filter(([k]) => ADVANCED.includes(k)).map(navBtn)}
                      </div>
                    )}
                    {navItems.length === 0 && <p className="px-2 py-1 text-xs text-slate-500">Không có mục khớp "{filter}"</p>}
                  </div>
                </div>
              ) : (
                <button
                  key={p.id}
                  onClick={() => switchProfile(p.id, p.name)}
                  className="mb-0.5 flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100"
                  title={`Mở cấu hình "${p.name}" để xem và sửa`}
                  data-testid={`nav-profile-${p.id}`}
                >
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" /> <span className="truncate">{p.name}</span>
                </button>
              ),
            )}
            <button
              onClick={() => setNav('newProfile')}
              className={`mt-1 flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-sm ${nav === 'newProfile' ? 'bg-navy-700 text-white' : 'text-teal-700 hover:bg-slate-100'}`}
            >
              <Plus className="h-4 w-4" /> Tạo cấu hình mới
            </button>
            <div className="mt-4 border-t border-slate-100 px-2 pt-3">
              <Toggle checked={advanced} onChange={setAdvanced} label="Nâng cao" help="Hiện thêm các mục kỹ thuật: thời gian, chất lượng thu thập & ảnh, hiệu năng, sao lưu & lịch sử." />
            </div>
          </nav>
          <main className={`${pane === 'list' ? 'hidden' : ''} min-w-0 flex-1 overflow-auto p-3 sm:p-4 md:block`}>
            <button className="-mx-1 mb-2 flex items-center gap-1 rounded-lg px-1 py-1.5 text-[15px] font-medium text-teal-700 md:hidden" onClick={() => setPane('list')} data-testid="settings-back">
              <ChevronLeft className="h-5 w-5" /> Các mục
              <span className="ml-1 font-semibold text-navy-800">· {nav === 'newProfile' ? 'Tạo cấu hình mới' : NAV.find((n) => n[0] === nav)?.[1]}</span>
            </button>
            {!s ? (
              <p>Đang tải…</p>
            ) : nav === 'profiles' || nav === 'newProfile' ? (
              <ProfilesPanel dirty={dirtyS || dirtySrc} view={nav === 'profiles' ? 'overview' : 'create'} onCreate={() => setNav('newProfile')} onChanged={() => api.profiles().then(setProfs).catch(() => undefined)} />
            ) : nav === 'suggest' ? (
              <SuggestPanel s={s} setS={setS} onCount={setSugCount} />
            ) : nav === 'sources' ? (
              <SourcesPanel sources={src} setSources={setSrc} />
            ) : nav === 'rules' ? (
              <RulesPanel s={s} setS={setS} sources={src} advanced={advanced} />
            ) : nav === 'location' ? (
              <LocationPanel s={s} up={up} advanced={advanced} />
            ) : nav === 'categories' ? (
              <CategoriesPanel s={s} setS={setS} advanced={advanced} />
            ) : nav === 'time' ? (
              <TimePanel s={s} up={up} />
            ) : nav === 'quality' ? (
              <QualityPanel s={s} up={up} />
            ) : nav === 'report' ? (
              <ReportPanel s={s} up={up} advanced={advanced} />
            ) : nav === 'performance' ? (
              <PerfPanel s={s} up={up} />
            ) : nav === 'users' ? (
              <UsersPanel />
            ) : (
              <BackupPanel onRestored={load} />
            )}
          </main>
        </div>
        {(dirtyS || dirtySrc) && (
          <div className="animate-in flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-amber-200 bg-amber-50 px-4 py-2.5" data-testid="save-bar">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span className="text-sm font-medium text-amber-900">Có thay đổi chưa lưu</span>
            {impact && <ImpactLine impact={impact} />}
            <span className="flex-1" />
            <button className="btn-ghost rounded-full" onClick={() => saved && (setS(structuredClone(saved.s)), setSrc(structuredClone(saved.src)))}>
              Hủy thay đổi
            </button>
            <button className="btn-primary rounded-full px-5 shadow-sm" disabled={saving || adminOnly() || (validation ? !validation.success : true)} title={adminOnly() ? `${ADMIN_HINT} lưu được cài đặt dùng chung` : undefined} onClick={save}>
              <Save className="h-4 w-4" /> {saving ? 'Đang lưu…' : 'Lưu'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const SEARCH_INDEX: Record<string, string[]> = {
  users: ['tài khoản', 'mật khẩu', 'đăng nhập', 'người dùng', 'admin', 'quản trị'],
  suggest: ['gợi ý', 'học', 'cải thiện', 'đề xuất từ khóa'],
  profiles: ['profile', 'cấu hình', 'hà nội', 'đà nẵng', 'tỉnh', 'thành phố', 'sao chép', 'clone'],
  sources: ['rss', 'sitemap', 'chuyên mục', 'báo', 'website', 'phân trang', 'độ sâu'],
  rules: ['từ khóa', 'đồng nghĩa', 'and', 'or', 'not', 'loại trừ', 'quy tắc'],
  location: ['phường', 'xã', 'tp.hcm', 'địa bàn', 'bí danh', 'tỉnh'],
  categories: ['lĩnh vực', 'phân loại', 'đất đai', 'giao thông'],
  time: ['giờ', 'khung', '17:00', '08:00', 'tự động'],
  quality: ['ảnh', 'bảng', 'chú thích', 'ngưỡng', 'bóc tách', 'bản quyền'],
  report: ['pptx', 'docx', 'word', 'pdf', 'mẫu', 'libreoffice', 'tên tệp'],
  performance: ['đồng thời', 'timeout', 'thử lại', 'cache', 'robots'],
  backup: ['khôi phục', 'sao lưu', 'lịch sử', 'nhập', 'xuất'],
};

type Up = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => void;

/* ---------------- Rules ---------------- */
function RulesPanel({ s, setS, sources, advanced }: { s: Settings; setS: (fn: (p: Settings | null) => Settings | null) => void; sources: Source[]; advanced: boolean }) {
  const toast = useToast();
  const preset = s.rules.presets.find((p) => p.id === s.rules.activePresetId) ?? s.rules.presets[0];
  const [sample, setSample] = useState({ title: 'Mưa lớn khiến đường ở phường Hiệp Bình ngập sâu', body: '' });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const setKw = (p: Partial<Settings['keywords']>) => setS((x) => (x ? { ...x, keywords: { ...x.keywords, ...p } } : x));
  const setPreset = (patch: Partial<NonNullable<typeof preset>>) =>
    setS((x) => (x ? { ...x, rules: { ...x.rules, presets: x.rules.presets.map((p) => (p.id === preset?.id ? { ...p, ...patch } : p)) } } : x));
  const addPreset = () => {
    const id = uid('preset');
    setS((x) => (x ? { ...x, rules: { ...x.rules, activePresetId: id, presets: [...x.rules.presets, { id, name: 'Bộ quy tắc mới', sourceIds: [], root: { kind: 'group', id: uid('g'), op: 'AND', negate: false, children: [] } }] } } : x));
  };
  const run = async () => {
    if (!preset) return;
    try {
      setPreview(await api.previewRule(preset.root, s, sample));
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  // basic view: the active rule's "one of these words" list and the title exclusions, as chips (the rule really filters;
  // the old "Từ khóa chủ đề" list was only a reference and is kept in step)
  const root = preset?.root as RuleGroup | undefined;
  const first = root && root.op === 'AND' && !root.negate ? root.children[0] : undefined;
  const incGroup = first && first.kind === 'group' && first.op === 'OR' && !first.negate ? first : null;
  const incTerms = incGroup ? incGroup.children.filter((c): c is RuleTerm => c.kind === 'term' && !c.negate).map((c) => c.value) : [];
  const setInclude = (vals: string[]) => {
    if (!incGroup || !root) return;
    const byVal = new Map(incGroup.children.filter((c): c is RuleTerm => c.kind === 'term' && !c.negate).map((c) => [c.value.toLowerCase(), c]));
    const kids: RuleNode[] = [
      ...incGroup.children.filter((c) => c.kind !== 'term' || c.negate),
      ...vals.map((v) => byVal.get(v.toLowerCase()) ?? ({ kind: 'term', id: uid('t'), field: 'any', match: 'word', value: v, negate: false } as RuleTerm)),
    ];
    setPreset({ root: { ...root, children: [{ ...incGroup, children: kids }, ...root.children.slice(1)] } });
    setKw({ topicKeywords: vals });
  };
  return (
    <div>
      <Section title="Lấy bài có một trong các từ" help="Tìm trong tiêu đề, sapo và nội dung bài. Gõ từ rồi Enter để thêm, bấm × để bỏ. Bài còn phải đúng địa bàn (mục Địa điểm).">
        {incGroup ? (
          <div data-testid="basic-include">
            <ChipEditor values={incTerms} onChange={setInclude} placeholder="thêm từ, ví dụ: chống ngập" />
          </div>
        ) : (
          <p className="text-sm text-slate-600">Bộ quy tắc đang dùng đã được tùy chỉnh – sửa ở chế độ <b>Nâng cao</b>.</p>
        )}
      </Section>
      <Section title="Bỏ bài có tiêu đề chứa" help="Bài có cụm này trong tiêu đề bị loại (vẫn xem được kèm lý do trong danh sách link ở mục Độ phủ & nguồn).">
        <div data-testid="basic-exclude">
          <ChipEditor values={s.keywords.excludePhrases} onChange={(v) => setKw({ excludePhrases: v })} placeholder="thêm cụm, ví dụ: giá vàng" />
        </div>
      </Section>
      {!advanced && (
        <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
          Bật <b>Nâng cao</b> (cột trái) để sửa từ đồng nghĩa, chuyên mục loại trừ và bộ quy tắc AND / OR / NOT.
        </p>
      )}
      {advanced && (
        <>
      <Section title="Chuyên mục URL loại trừ" help="Ví dụ the-thao, giai-tri">
        <ChipEditor values={s.keywords.excludeUrlSections} onChange={(v) => setKw({ excludeUrlSections: v })} validate={(v) => (/^[a-z0-9-]+$/.test(v) ? null : 'Chỉ a-z, 0-9, dấu gạch')} />
      </Section>
      <Section title="Nhóm từ đồng nghĩa" actions={<button className="btn-ghost btn-xs" onClick={() => setKw({ synonyms: [...s.keywords.synonyms, { canonical: 'từ mới', aliases: [] }] })}><Plus className="h-3 w-3" /> Thêm nhóm</button>}>
        {s.keywords.synonyms.map((g, i) => (
          <div key={i} className="flex items-start gap-2">
            <input className="input w-40" value={g.canonical} onChange={(e) => setKw({ synonyms: s.keywords.synonyms.map((x, j) => (j === i ? { ...x, canonical: e.target.value } : x)) })} aria-label="Từ chuẩn" />
            <div className="flex-1"><ChipEditor values={g.aliases} onChange={(v) => setKw({ synonyms: s.keywords.synonyms.map((x, j) => (j === i ? { ...x, aliases: v } : x)) })} placeholder="đồng nghĩa…" /></div>
            <button className="btn-danger btn-xs" onClick={() => setKw({ synonyms: s.keywords.synonyms.filter((_, j) => j !== i) })} aria-label="Xóa nhóm"><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </Section>
      <Section title="Bộ quy tắc AND / OR / NOT" actions={<button className="btn-ghost btn-xs" onClick={addPreset}><Plus className="h-3 w-3" /> Bộ mới</button>}>
        <div className="grid gap-3 md:grid-cols-3">
          <Select label="Bộ quy tắc đang dùng" value={s.rules.activePresetId} onChange={(v) => setS((x) => (x ? { ...x, rules: { ...x.rules, activePresetId: v } } : x))} options={s.rules.presets.map((p) => [p.id, p.name])} />
          {preset && (
            <Field label="Tên bộ quy tắc">
              <input className="input" value={preset.name} onChange={(e) => setPreset({ name: e.target.value })} />
            </Field>
          )}
          <Select label="Khi không khớp quy tắc nhưng đúng địa bàn" value={s.rules.unknownRelevancePolicy} onChange={(v) => setS((x) => (x ? { ...x, rules: { ...x.rules, unknownRelevancePolicy: v } } : x))} options={[['review', 'Đưa vào hàng Cần kiểm tra'], ['exclude_with_reason', 'Loại kèm lý do']]} />
        </div>
        <Toggle
          checked={s.rules.requireSectorInLead}
          onChange={(v) => setS((x) => (x ? { ...x, rules: { ...x.rules, requireSectorInLead: v } } : x))}
          label="Tiêu đề hoặc sapo phải có từ khóa của một lĩnh vực (bài không có bị loại kèm lý do NO_SECTOR_IN_LEAD, vẫn xem được trong danh sách link (Độ phủ & nguồn))"
          help="Đo trên dữ liệu thật 15/11/2026: hàng Cần kiểm tra giảm 37 → 4 bài, không loại nhầm bài liên quan nào. Tắt nếu thấy bỏ sót."
        />
        <NumberField
          label="…nhưng nếu thân bài có điểm lĩnh vực từ mức này trở lên thì đưa vào Cần kiểm tra thay vì loại (0 = tắt)"
          value={s.rules.bodySectorScoreForReview}
          min={0}
          max={50}
          onChange={(n) => setS((x) => (x ? { ...x, rules: { ...x.rules, bodySectorScoreForReview: n } } : x))}
        />
        {preset && (
          <>
            <div>
              <span className="label">Áp dụng riêng cho nguồn (để trống = mọi nguồn)</span>
              <div className="flex flex-wrap gap-2">
                {sources.map((x) => (
                  <label key={x.id} className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={preset.sourceIds.includes(x.id)} onChange={(e) => setPreset({ sourceIds: e.target.checked ? [...preset.sourceIds, x.id] : preset.sourceIds.filter((y) => y !== x.id) })} /> {x.name}
                  </label>
                ))}
              </div>
            </div>
            <RuleBuilder root={preset.root as RuleGroup} onChange={(root) => setPreset({ root })} />
            {s.rules.presets.length > 1 && (
              <button className="btn-danger btn-xs" onClick={() => confirm('Xóa bộ quy tắc này?') && setS((x) => (x ? { ...x, rules: { ...x.rules, presets: x.rules.presets.filter((p) => p.id !== preset.id), activePresetId: x.rules.presets.find((p) => p.id !== preset.id)!.id } } : x))}>
                Xóa bộ quy tắc
              </button>
            )}
          </>
        )}
      </Section>
        </>
      )}
      <Section title="Xem thử kết quả (chưa lưu vẫn thử được)">
        <Field label="Tiêu đề thử">
          <input className="input" value={sample.title} onChange={(e) => setSample({ ...sample, title: e.target.value })} />
        </Field>
        <Field label="Nội dung thử (tùy chọn)">
          <textarea className="input" rows={2} value={sample.body} onChange={(e) => setSample({ ...sample, body: e.target.value })} />
        </Field>
        <button className="btn-teal" onClick={run}>Xem thử trên bài mẫu + bài đã thu thập</button>
        {preview && (
          <div className="text-xs">
            {preview.errors.length > 0 && <div className="mb-2 rounded bg-red-50 p-2 text-red-800">{preview.errors.join('; ')}</div>}
            <p className="mb-1">
              Khớp <b>{preview.results.filter((r) => r.matched).length}</b> / {preview.results.length} bài
            </p>
            <div className="max-h-80 space-y-1 overflow-auto">
              {preview.results.map((r) => (
                <details key={r.id} className={`rounded border p-1.5 ${r.matched ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white'}`}>
                  <summary className="cursor-pointer">
                    {r.matched ? '✔ Khớp' : '✘ Không khớp'} – {r.title} {r.location && <span className="text-slate-500">[địa bàn: {r.location}]</span>}
                  </summary>
                  <pre className="whitespace-pre-wrap text-[11px] text-slate-700">{r.lines.slice(0, 60).join('\n')}</pre>
                </details>
              ))}
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ---------------- Location ---------------- */
const KIND_LABEL: Record<LocationArea['kind'], string> = {
  city: 'Thành phố', ward: 'Phường', commune: 'Xã', special_zone: 'Đặc khu', landmark: 'Địa danh/công trình', legacy_district: 'Quận/huyện cũ', custom: 'Tùy chỉnh', connected_area: 'Liên vùng (cần kiểm tra)',
};
function LocationPanel({ s, up, advanced }: { s: Settings; up: Up; advanced: boolean }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [test, setTest] = useState('Kẹt xe kéo dài trên đường Phạm Văn Đồng');
  const areas = s.location.areas;
  const shown = areas.filter((a) => (kind === 'all' || a.kind === kind) && (!q || [a.name, ...a.aliases].some((x) => x.toLowerCase().includes(q.toLowerCase()))));
  const setAreas = (list: LocationArea[]) => up('location', { areas: list });
  const r = detectLocation(test, '', s.location);
  const R = s.location.regionName;
  return (
    <div>
      <Section title="Địa bàn">
        <Field label="Tên địa bàn" help="Ví dụ TP.HCM, Hà Nội, Đà Nẵng – hiện trong ứng dụng và báo cáo. Bộ lọc dùng danh sách địa danh & bí danh bên dưới."><input className="input" value={R} onChange={(e) => up('location', { regionName: e.target.value })} /></Field>
      </Section>
      <Section title="Thử một câu" help="Gõ một tiêu đề để xem bộ lọc nhận ra địa bàn thế nào.">
        <input className="input" value={test} onChange={(e) => setTest(e.target.value)} aria-label="Câu thử địa bàn" />
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Kết quả:{' '}
          <span className={`chip text-xs font-semibold ${r.status === 'hcm' ? 'border-green-300 bg-green-50 text-green-800' : r.status === 'other_province' ? 'border-red-300 bg-red-50 text-red-700' : 'border-amber-300 bg-amber-50 text-amber-800'}`}>
            {r.status === 'hcm' ? `✓ ${R}` : r.status === 'connected' ? 'Liên vùng – cần kiểm tra' : r.status === 'other_province' ? '✗ Địa phương khác' : 'Chưa rõ – vào hàng Cần kiểm tra'}
          </span>
          <span className="text-xs text-slate-500">{r.evidence.join(' · ')}</span>
        </p>
      </Section>
      {!advanced && (
        <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">Bật <b>Nâng cao</b> (cột trái) để chỉnh quy tắc địa bàn (bắt buộc có địa danh, tin liên vùng, địa phương khác, cụm từ không phải địa danh).</p>
      )}
      {advanced && (
      <Section title="Quy tắc địa bàn">
        <Toggle checked={s.location.requireHcmEvidence} onChange={(v) => up('location', { requireHcmEvidence: v })} label={`Bắt buộc có bằng chứng địa bàn ${R} để vào nhóm sẵn sàng (không có → Cần kiểm tra, không bị bỏ)`} />
        <Toggle checked={s.location.connectedAreasForReview} onChange={(v) => up('location', { connectedAreasForReview: v })} label="Dự án liên vùng (Vành đai 3, Long Thành…) đưa vào Cần kiểm tra" />
        <Toggle checked={s.location.connectedNeedsLead} onChange={(v) => up('location', { connectedNeedsLead: v })} label={`Dự án liên vùng chỉ có trong thân bài (không ở tiêu đề/sapo, không có địa danh ${R}) → loại kèm lý do`} />
        <Select
          label={`Bài không có địa danh ${R} nào: giữ lại (Cần kiểm tra)`}
          value={s.location.noPlaceKeep}
          onChange={(v) => up('location', { noPlaceKeep: v })}
          options={[['policy_only', 'Chỉ chính sách, pháp quy chung của ngành (khuyên dùng)'], ['strong_sector', 'Cả bài có từ khóa lĩnh vực mạnh ở tiêu đề + sapo']]}
        />
        <Select
          label={`Bài không có bất kỳ dấu hiệu địa bàn ${R} nào (kể cả phường, xã, địa danh)`}
          value={s.location.noEvidencePolicy}
          onChange={(v) => up('location', { noEvidencePolicy: v })}
          options={[['exclude_with_reason', 'Loại kèm lý do NO_HCM_EVIDENCE (xem được trong danh sách link (Độ phủ & nguồn))'], ['review', 'Đưa vào hàng Cần kiểm tra']]}
        />
        <NumberField
          label={`${R} không có ở tiêu đề/sapo: số địa danh ${R} tối thiểu trong thân bài để vào nhóm Sẵn sàng`}
          value={s.location.minBodyAreasWithoutLead}
          min={1}
          max={10}
          onChange={(n) => up('location', { minBodyAreasWithoutLead: n })}
          help="Ít hơn → bài vào hàng Cần kiểm tra (HCM_ONLY_IN_BODY), không bị loại."
        />
        {s.location.noPlaceKeep === 'strong_sector' && <NumberField
          label={`Bài không có địa danh ${R} nào: điểm lĩnh vực tối thiểu ở tiêu đề + sapo để giữ lại (Cần kiểm tra)`}
          value={s.location.noPlaceMinLeadScore}
          min={1}
          max={20}
          onChange={(n) => up('location', { noPlaceMinLeadScore: n })}
          help="Từ khóa có trong tiêu đề = 3 điểm, chỉ có trong sapo = 1 điểm. 4 = cần thêm bằng chứng ngoài một từ ở tiêu đề; 3 = một từ ở tiêu đề là đủ. Chính sách, pháp quy của ngành luôn được giữ."
        />}
        <Toggle checked={s.location.nationalToReady} onChange={(v) => up('location', { nationalToReady: v })} label={`Tin chung (chính sách cả nước, hoặc chỉ nhắc ${R} trong thân bài) có từ khóa lĩnh vực ngay ở TIÊU ĐỀ → vào Bài sẵn sàng (tắt: Cần kiểm tra)`} />
        {s.location.nationalToReady && <ChipEditor values={s.location.nationalBlockWords ?? []} onChange={(v) => up('location', { nationalBlockWords: v })} label="…trừ khi tiêu đề có các từ này (tin nước ngoài, chứng khoán, vụ án, tai nạn) – vẫn ở Cần kiểm tra" />}
        <ChipEditor values={s.location.otherProvinces} onChange={(v) => up('location', { otherProvinces: v })} label={`Địa phương / miền khác (nêu trong tiêu đề mà tiêu đề và sapo không có ${R} → loại kèm lý do)`} />
        <ChipEditor values={s.location.policyPhrases ?? []} onChange={(v) => up('location', { policyPhrases: v })} label={`Từ chỉ chính sách, pháp quy, chương trình toàn quốc (bài không có địa danh ${R}: có từ này + từ khóa lĩnh vực ở tiêu đề/sapo thì giữ lại)`} />
        <ChipEditor values={s.location.nationalSectorPhrases ?? []} onChange={(v) => up('location', { nationalSectorPhrases: v })} label={`Cụm từ tin toàn ngành (bài không có địa danh ${R} nhưng tiêu đề/sapo có cụm này vẫn vào Cần kiểm tra, ví dụ "Bộ Xây dựng")`} />
        <ChipEditor values={s.location.excludePhrases ?? []} onChange={(v) => up('location', { excludePhrases: v })} label={`Cụm từ không phải địa bàn (bỏ qua khi tìm ${R}, ví dụ "giải thưởng Hồ Chí Minh", "ngân hàng Sài Gòn - Hà Nội")`} />
      </Section>
      )}
      <Section
        title={`Địa danh & bí danh (${areas.length})`}
        help="Nguồn: danh sách đơn vị hành chính (NQ 1685/NQ-UBTVQH15). Tên dễ nhầm cần tiền tố phường/xã."
        actions={<button className="btn-ghost btn-xs" onClick={() => setAreas([{ id: uid('loc'), name: 'Địa danh mới', kind: 'custom', aliases: [], requirePrefix: false }, ...areas])}><Plus className="h-3 w-3" /> Thêm địa danh</button>}
      >
        <div className="flex gap-2">
          <input className="input" placeholder="Tìm tên/bí danh…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-56" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Loại">
            <option value="all">Tất cả loại</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-auto">
          {shown.slice(0, 150).map((a) => (
            <div key={a.id} className="flex flex-wrap items-start gap-2 rounded border border-slate-200 bg-white p-1.5">
              <input className="input w-44" value={a.name} onChange={(e) => setAreas(areas.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x)))} aria-label="Tên" />
              <select className="input w-40" value={a.kind} onChange={(e) => setAreas(areas.map((x) => (x.id === a.id ? { ...x, kind: e.target.value as LocationArea['kind'] } : x)))} aria-label="Loại địa danh">
                {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <div className="min-w-[14rem] flex-1"><ChipEditor values={a.aliases} onChange={(v) => setAreas(areas.map((x) => (x.id === a.id ? { ...x, aliases: v } : x)))} placeholder="bí danh / tên cũ…" /></div>
              {(a.kind === 'ward' || a.kind === 'commune') && <Toggle checked={a.requirePrefix} onChange={(v) => setAreas(areas.map((x) => (x.id === a.id ? { ...x, requirePrefix: v } : x)))} label="cần tiền tố" />}
              <button className="btn-danger btn-xs" onClick={() => setAreas(areas.filter((x) => x.id !== a.id))} aria-label={`Xóa ${a.name}`}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {shown.length > 150 && <p className="text-xs text-slate-500">Hiển thị 150/{shown.length} – dùng ô tìm để lọc.</p>}
        </div>
      </Section>
    </div>
  );
}

/* ---------------- Categories ---------------- */
function CategoriesPanel({ s, setS, advanced }: { s: Settings; setS: (fn: (p: Settings | null) => Settings | null) => void; advanced: boolean }) {
  const set = (code: string, p: Partial<Settings['categories'][number]>) => setS((x) => (x ? { ...x, categories: x.categories.map((c) => (c.code === code ? { ...c, ...p } : c)) } : x));
  return (
    <div>
    <Section title="Lĩnh vực" help="Bài được xếp vào lĩnh vực có từ khóa khớp nhiều nhất (chỉ là gợi ý, biên tập viên luôn đổi được). Tắt một lĩnh vực để không dùng nữa.">
      <div className="grid gap-2">
      {[...s.categories].sort((a, b) => a.priority - b.priority).map((c) => (
        <div key={c.code} className={`card animate-in p-3 ${c.enabled ? '' : 'bg-slate-50 opacity-70'}`} data-testid={`category-${c.code}`}>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <Toggle checked={c.enabled} onChange={(v) => set(c.code, { enabled: v })} label="" />
            {advanced ? (
              <>
                <input className="input w-56" value={c.label} onChange={(e) => set(c.code, { label: e.target.value })} aria-label="Tên lĩnh vực" />
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  Ưu tiên <input className="input w-16" type="number" min={1} max={99} value={c.priority} onChange={(e) => set(c.code, { priority: e.target.valueAsNumber })} aria-label="Ưu tiên" />
                </label>
                <span className="chip border-slate-200 bg-slate-50 font-mono text-[10px] text-slate-500">{c.code}</span>
              </>
            ) : (
              <span className="font-semibold text-slate-800">{c.label}</span>
            )}
            {(c.requiresCategories ?? []).length > 0 && (
              <span className="chip border-sky-200 bg-sky-50 text-[11px] text-sky-800" title="Chỉ tính khi tiêu đề/sapo có lĩnh vực đi kèm">
                cần kèm: {c.requiresCategories.map((r) => s.categories.find((o) => o.code === r)?.label ?? r).join(' / ')}
              </span>
            )}
          </div>
          <ChipEditor values={c.keywords} onChange={(v) => set(c.code, { keywords: v })} placeholder="thêm từ khóa…" />
          {advanced && (
          <details className="mt-1" open={(c.requiresCategories ?? []).length > 0}>
            <summary className="cursor-pointer text-xs text-slate-600">
              Điều kiện thêm{(c.requiresCategories ?? []).length ? ` · chỉ tính khi tiêu đề/sapo có lĩnh vực khác (${c.requiresCategories.length})` : ''}{(c.excludePhrases ?? []).length ? ` · bỏ qua ${c.excludePhrases.length} cụm từ` : ''}
            </summary>
            <div className="mt-1 space-y-2 pl-1">
              <div>
                <div className="text-xs text-slate-700">
                  Chỉ xếp vào lĩnh vực này khi <b>tiêu đề hoặc sapo</b> cũng có từ khóa của ít nhất một lĩnh vực được tích (bỏ trống = không điều kiện). Ví dụ "Chính sách, pháp quy" phải là nghị định, luật… về xây dựng, giao thông.
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={`Lĩnh vực bắt buộc đi kèm – ${c.label}`}>
                  {s.categories.filter((o) => o.code !== c.code).map((o) => (
                    <label key={o.code} className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={(c.requiresCategories ?? []).includes(o.code)}
                        onChange={(e) => set(c.code, { requiresCategories: e.target.checked ? [...(c.requiresCategories ?? []), o.code] : (c.requiresCategories ?? []).filter((x) => x !== o.code) })}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-700">Bỏ qua cụm từ (chứa từ khóa nhưng nghĩa khác, ví dụ "yêu cầu" không phải cây cầu):</div>
                <ChipEditor values={c.excludePhrases ?? []} onChange={(v) => set(c.code, { excludePhrases: v })} placeholder="cụm từ bỏ qua…" />
              </div>
            </div>
          </details>
          )}
        </div>
      ))}
      </div>
    </Section>
      {!advanced && (
        <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">Bật <b>Nâng cao</b> (cột trái) để đổi tên, thứ tự ưu tiên, lĩnh vực bắt buộc đi kèm và cụm từ bỏ qua của từng lĩnh vực.</p>
      )}
    </div>
  );
}

/* ---------------- Time ---------------- */
function TimePanel({ s, up }: { s: Settings; up: Up }) {
  let preview = '';
  try {
    const w = lastCompletedWindow(new Date(), s.reportWindow.startClock, s.reportWindow.endClock);
    preview = `Kỳ gần nhất: từ ${formatVn(w.from)} (gồm) đến trước ${formatVn(w.to)} (không gồm) – giờ Việt Nam (Asia/Ho_Chi_Minh)`;
  } catch (e) {
    preview = (e as Error).message;
  }
  return (
    <div>
      <Section title="Khung giờ báo cáo mặc định">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <span className="label">Giờ bắt đầu (hôm trước)</span>
            <Time24 label="Giờ bắt đầu (hôm trước)" value={s.reportWindow.startClock} onChange={(v) => up('reportWindow', { startClock: v })} />
          </div>
          <div>
            <span className="label">Giờ kết thúc (ngày báo cáo)</span>
            <Time24 label="Giờ kết thúc (ngày báo cáo)" value={s.reportWindow.endClock} onChange={(v) => up('reportWindow', { endClock: v })} />
          </div>
          <Select label="Khung mở mặc định" help="Dùng khi chưa có lượt thu thập nào; có lượt rồi thì mở lượt gần nhất." value={s.reportWindow.defaultPreset} onChange={(v) => up('reportWindow', { defaultPreset: v })} options={[['last_completed', 'Kỳ gần nhất (đã kết thúc)'], ['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['custom', 'Tùy chỉnh đã lưu']]} />
        </div>
        <p className="rounded bg-teal-50 p-2 text-xs text-teal-900">{preview}</p>
        <NumberField label="Biên dò thêm quanh khung giờ" value={s.reportWindow.lookbackMarginHours} min={0} max={72} suffix="giờ" onChange={(n) => up('reportWindow', { lookbackMarginHours: n })} help="Bài có ngày RSS nằm ngoài khung ± biên này được ghi nhận Ngoài khung mà không tải. Bài trong biên vẫn được tải để xác minh giờ đăng thật." />
        <p className="text-xs text-slate-600">Ngày dùng để lọc: <b>giờ đăng gốc</b> (không thay bằng giờ cập nhật hay giờ thu thập). Múi giờ cố định: Asia/Ho_Chi_Minh (UTC+07:00).</p>
      </Section>
      {api.shared && <ScheduleTimesSection />}
      {api.shared && <CollectTokenSection />}
      <Section title="Tự động khi mở ứng dụng">
        <Toggle checked={s.startup.autoCollectLastCompletedWindow} onChange={(v) => up('startup', { autoCollectLastCompletedWindow: v })} label="Tự thu thập kỳ gần nhất khi mở ứng dụng (cần Internet)" />
        <Toggle checked={s.startup.oncePerWindow} onChange={(v) => up('startup', { oncePerWindow: v })} label="Mỗi khung giờ chỉ tự chạy một lần (tải lại trang không tạo lượt trùng)" />
      </Section>
    </div>
  );
}

/**
 * web (shared): times of the automatic collection slots of the active profile, saved on the review worker at once
 * (own "Lưu giờ" button – not part of the settings Save). The on/off switches stay on the main page.
 */
function ScheduleTimesSection() {
  const shared = api.shared!;
  const toast = useToast();
  type T = { at: string; from: string; to: string };
  const [times, setTimes] = useState<Record<ScheduleSlotId, T> | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fromProfile = (st?: ScheduleTimes) => {
    // "Đến" shows the stored end, else the run time (the default afternoon window ends at 16:30 too)
    const v = Object.fromEntries(slotsFor(st).map((s) => [s.id, { at: s.at, from: s.from.time, to: st?.[s.id]?.to || s.at }])) as Record<ScheduleSlotId, T>;
    setTimes(v);
    setSaved(JSON.stringify(v));
  };
  useEffect(() => {
    shared.serverStatus().then((s) => fromProfile(s.profiles.find((p) => p.id === shared.profileId())?.scheduleTimes)).catch((e: Error) => setErr(e.message));
  }, []);
  if (!times) return <Section title="Giờ thu thập tự động">{err ? <p className="text-xs text-red-700">{err}</p> : <p className="text-xs text-slate-500">Đang tải…</p>}</Section>;
  const problem = validateTimes(times);
  const preview = slotsFor(times);
  const save = async (v: ScheduleTimes) => {
    if (!shared.session()) return toast('err', 'Hãy đăng nhập người duyệt (nút Đăng nhập ở đầu trang) để đổi giờ lịch');
    setBusy(true);
    try {
      const p = await shared.setScheduleTimes(v);
      fromProfile(p.scheduleTimes);
      window.dispatchEvent(new Event('schedule-changed'));
      toast('ok', 'Đã lưu giờ thu thập tự động – áp dụng từ lượt kế tiếp');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const isDefault = SCHEDULE_SLOTS.every((d) => times[d.id].at === d.at && times[d.id].from === d.from.time && times[d.id].to === d.at);
  const set = (id: ScheduleSlotId, k: keyof T, v: string) => {
    const cur = times[id];
    // "Đến" follows the run time until it is changed by hand
    setTimes({ ...times, [id]: k === 'at' && cur.to === cur.at ? { ...cur, at: v, to: v } : { ...cur, [k]: v } });
  };
  const timeField = (id: ScheduleSlotId, k: keyof T, label: string) => (
    <div className="min-w-0">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <Time24 label={`${SLOT_NAMES[id]} – ${label.toLowerCase()}`} value={times[id][k]} maxHour={k === 'at' ? Number(LATEST_RUN.slice(0, 2)) : 23} onChange={(v) => set(id, k, v)} />
    </div>
  );
  return (
    <Section title="Giờ thu thập tự động" help="Máy chủ tự thu thập vào các giờ này cho cấu hình đang chọn (bật/tắt từng lượt bằng công tắc Tự động ở trang chính). Áp dụng cho cả nhóm.">
      <div className="grid gap-3 lg:grid-cols-2" data-testid="schedule-times">
        {SCHEDULE_SLOTS.map((d, i) => (
          <div key={d.id} className="min-w-0 rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 text-sm font-semibold text-navy-800">{SLOT_NAMES[d.id]}</div>
            {/* one row when there is room, one field per row on a phone */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
              {timeField(d.id, 'at', 'Giờ chạy')}
              {timeField(d.id, 'from', 'Từ')}
              {timeField(d.id, 'to', 'Đến')}
            </div>
            <p className="mt-2 text-xs text-slate-600">{preview[i]!.label}</p>
          </div>
        ))}
      </div>
      {problem ? <p className="text-xs text-red-700">{problem}</p> : <p className="text-xs text-slate-500">"Đến" mặc định bằng giờ chạy, đổi được nhưng không muộn hơn giờ chạy. "Từ" muộn hơn "Đến" nghĩa là từ hôm trước. Giờ chạy muộn nhất {LATEST_RUN}. Dữ liệu có sau giờ chạy khoảng 5–10 phút.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-teal" disabled={busy || adminOnly() || !!problem || JSON.stringify(times) === saved} title={adminOnly() ? ADMIN_HINT : undefined} onClick={() => void save(times)}>
          <Save className="h-4 w-4" /> {busy ? 'Đang lưu…' : 'Lưu giờ'}
        </button>
        <button className="btn-ghost" disabled={busy || isDefault || adminOnly()} onClick={() => void save({})} title="Về 08:00 (17:00 hôm qua → 08:00) và 16:30 (08:01 → 16:30)">
          <RotateCcw className="h-4 w-4" /> Về mặc định
        </button>
      </div>
    </Section>
  );
}

/* ---------------- Accounts (web) ---------------- */
function UsersPanel() {
  const shared = api.shared!;
  const toast = useToast();
  const me = shared.session() as ({ name: string; user?: string } | null);
  const isAdmin = shared.role() === 'admin';
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<{ u: string; name: string; password: string; role: UserRole; editing: boolean }>({ u: '', name: '', password: '', role: 'reviewer', editing: false });
  const [myPw, setMyPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isAdmin) shared.users().then(setUsers).catch((e: Error) => setErr(e.message));
  }, []);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast('ok', ok);
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!me) return <Section title="Tài khoản"><p className="text-sm text-slate-600">Đăng nhập để xem và đổi mật khẩu.</p></Section>;
  const roleLabel = (r: UserRole) => (r === 'admin' ? 'Quản trị viên' : 'Người duyệt');
  const actions = (x: UserInfo) => (
    <>
      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setForm({ u: x.u, name: x.name, password: '', role: x.role, editing: true })} aria-label={`Sửa tài khoản ${x.u}`}>Sửa</button>
      <button
        className="btn-ghost px-2 py-1 text-xs text-red-700"
        disabled={busy || x.u === me.user}
        aria-label={`Xoá tài khoản ${x.u}`}
        onClick={() => {
          if (confirm(`Xoá tài khoản "${x.u}"?`)) void run(async () => setUsers(await shared.deleteUser(x.u)), `Đã xoá ${x.u}`);
        }}
      >
        Xoá
      </button>
    </>
  );
  return (
    <div data-testid="users-panel">
      <Section title="Tài khoản của tôi">
        <p className="text-sm text-slate-700">
          Đang đăng nhập: <b>{me.name}</b>
          {me.user ? <span className="text-slate-500"> ({me.user})</span> : null} · {isAdmin ? 'Quản trị viên' : 'Người duyệt'}
        </p>
        {me.user ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block w-full min-w-0 sm:w-auto sm:flex-1">
              <span className="label">Mật khẩu mới</span>
              <input className="input" type="password" autoComplete="new-password" value={myPw} onChange={(e) => setMyPw(e.target.value)} />
            </label>
            <button className="btn-teal w-full justify-center sm:w-auto" disabled={busy || myPw.length < 6} onClick={() => void run(async () => { await shared.changePassword(myPw); setMyPw(''); }, 'Đã đổi mật khẩu')}>
              <Save className="h-4 w-4" /> Đổi mật khẩu
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Không đọc được tài khoản của phiên này – hãy đăng xuất rồi đăng nhập lại.</p>
        )}
      </Section>
      {isAdmin && (
        <Section title="Quản lý tài khoản" help="Tài khoản dùng chung cho bản web, lưu trên máy chủ duyệt tin (mật khẩu được mã hoá một chiều). Quản trị viên quản lý tài khoản; người duyệt duyệt tin, thu thập và sửa cài đặt.">
          {err && <p className="text-xs text-red-700">{err}</p>}
          {/* phones: one card per account */}
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white sm:hidden" data-testid="users-list">
            {(users ?? []).map((x) => (
              <li key={x.u} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white" aria-hidden="true">{(x.name || x.u).trim().split(/\s+/).pop()!.charAt(0).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-800">{x.name}</div>
                  <div className="truncate text-xs text-slate-500"><span className="font-mono">{x.u}</span> · {roleLabel(x.role)}</div>
                </div>
                <div className="flex shrink-0 gap-1">{actions(x)}</div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm" data-testid="users-table">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1 pr-3">Tên đăng nhập</th>
                  <th className="py-1 pr-3">Họ tên</th>
                  <th className="py-1 pr-3">Quyền</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {(users ?? []).map((x) => (
                  <tr key={x.u} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 font-mono">{x.u}</td>
                    <td className="py-1.5 pr-3">{x.name}</td>
                    <td className="py-1.5 pr-3">{roleLabel(x.role)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">{actions(x)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-2 text-sm font-semibold text-navy-800">{form.editing ? `Sửa tài khoản ${form.u}` : 'Thêm tài khoản'}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="label">Tên đăng nhập</span>
                <input className="input font-mono" aria-label="Tên đăng nhập mới" value={form.u} disabled={form.editing} autoCapitalize="none" spellCheck={false} onChange={(e) => setForm({ ...form, u: e.target.value.toLowerCase() })} placeholder="vd: nghia" />
              </label>
              <label className="block">
                <span className="label">Họ tên</span>
                <input className="input" aria-label="Họ tên" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">{form.editing ? 'Mật khẩu mới (để trống = giữ nguyên)' : 'Mật khẩu'}</span>
                <input className="input" type="password" aria-label="Mật khẩu tài khoản" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <Select<UserRole> label="Quyền" value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={[['reviewer', 'Người duyệt'], ['admin', 'Quản trị viên']]} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn-teal"
                disabled={busy || !form.u.trim() || !form.name.trim() || (!form.editing && form.password.length < 6)}
                onClick={() =>
                  void run(async () => {
                    setUsers(await shared.saveUser({ u: form.u.trim(), name: form.name.trim(), role: form.role, ...(form.password ? { password: form.password } : {}) }));
                    setForm({ u: '', name: '', password: '', role: 'reviewer', editing: false });
                  }, form.editing ? 'Đã lưu tài khoản' : 'Đã thêm tài khoản')
                }
              >
                <Save className="h-4 w-4" /> {form.editing ? 'Lưu' : 'Thêm'}
              </button>
              {form.editing && <button className="btn-ghost" onClick={() => setForm({ u: '', name: '', password: '', role: 'reviewer', editing: false })}>Huỷ sửa</button>}
            </div>
            <p className="mt-2 text-xs text-slate-500">Mật khẩu ít nhất 6 ký tự. Xoá tài khoản thì người đó bị đăng xuất ngay.</p>
          </div>
        </Section>
      )}
    </div>
  );
}

const vnDate = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const daysLeft = (iso: string) => Math.floor((Date.parse(iso) - Date.now()) / 86400_000);

/**
 * web (shared): the GitHub token the server uses for "Thu thập" and the automatic runs. A new one is pasted here,
 * checked by the server (reads the repository, may start the workflow) and only then saved; it is never shown again.
 */
function CollectTokenSection() {
  const shared = api.shared!;
  const toast = useToast();
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [err, setErr] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (!shared.session()) return setErr('Đăng nhập người duyệt để xem và đổi khóa thu thập.');
    setErr('');
    shared.tokenInfo().then(setInfo).catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);
  const save = async () => {
    setBusy(true);
    try {
      setInfo(await shared.setToken(value.trim()));
      setValue('');
      window.dispatchEvent(new Event('schedule-changed'));
      toast('ok', 'Đã kiểm tra và lưu khóa mới – thu thập dùng khóa này từ bây giờ');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const left = info?.expiresAt ? daysLeft(info.expiresAt) : null;
  const repo = info?.repo ?? 'repository thu thập';
  return (
    <Section title="Khóa thu thập (GitHub)" help="Máy chủ dùng khóa này để chạy Thu thập và các lượt tự động. Khóa có hạn tối đa 1 năm: tạo khóa mới rồi dán vào đây trước khi hết hạn.">
      <div className="space-y-3 text-sm" data-testid="collect-token">
        {err && <p className="text-xs text-slate-600">{err}</p>}
        {info && !info.configured && <p className="text-xs text-red-700">Máy chủ chưa có khóa – nút Thu thập và lịch tự động chưa chạy được.</p>}
        {info?.configured && (
          <div className={`rounded-lg border p-3 ${!info.ok || (left !== null && left < 30) ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
            <div>
              Khóa đang dùng: <b className="font-mono">…{info.last4}</b>
              {info.source === 'web' && info.by && info.at ? <span className="text-slate-500"> · cập nhật bởi {info.by}, {vnDate(info.at)}</span> : <span className="text-slate-500"> · đặt trên máy chủ</span>}
            </div>
            {!info.ok ? (
              <div className="mt-1 font-semibold text-red-700">GitHub không nhận khóa này (hết hạn hoặc đã thu hồi) – hãy dán khóa mới.</div>
            ) : info.expiresAt ? (
              <div className={`mt-1 ${left !== null && left < 30 ? 'font-semibold text-amber-800' : 'text-slate-600'}`}>
                Hết hạn: <b>{vnDate(info.expiresAt)}</b> ({left !== null && left >= 0 ? `còn ${left} ngày` : 'đã hết hạn'})
              </div>
            ) : (
              <div className="mt-1 text-slate-600">Khóa không có ngày hết hạn.</div>
            )}
          </div>
        )}
        <details className="rounded-lg border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer font-medium text-teal-800">Cách tạo khóa mới</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-700">
            <li>Mở <a className="text-blue-700 underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">github.com › Fine-grained token mới</a> (đăng nhập tài khoản quản lý repository).</li>
            <li><b>Resource owner</b>: chủ của <b>{repo}</b>; <b>Repository access</b>: Only select repositories → <b>{repo.split('/')[1] ?? repo}</b>.</li>
            <li><b>Permissions › Actions</b>: <b>Read and write</b>. Hạn dùng: tối đa 366 ngày.</li>
            <li>Bấm Generate token, chép khóa và dán vào ô dưới. Nếu GitHub báo chờ duyệt, chủ tổ chức bấm Approve.</li>
          </ol>
        </details>
        <div className="flex flex-wrap gap-2">
          <input className="input min-w-0 flex-1 font-mono" type="password" autoComplete="off" spellCheck={false} placeholder="github_pat_…" aria-label="Khóa mới" value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="btn-teal" disabled={busy || value.trim().length < 20 || !shared.session() || adminOnly()} title={adminOnly() ? ADMIN_HINT : undefined} onClick={() => void save()}>
            <Save className="h-4 w-4" /> {busy ? 'Đang kiểm tra…' : 'Kiểm tra & lưu'}
          </button>
        </div>
        <p className="text-xs text-slate-500">Khóa được kiểm tra với GitHub trước khi lưu (đọc được repository, có quyền chạy thu thập); khóa sai hoặc thiếu quyền thì giữ nguyên khóa cũ. Sau khi lưu, khóa không bao giờ hiện lại – chỉ 4 ký tự cuối.</p>
      </div>
    </Section>
  );
}

/* ---------------- Quality & images ---------------- */
function QualityPanel({ s, up }: { s: Settings; up: Up }) {
  return (
    <div>
      <Section title="Kênh dò link (toàn cục)">
        {(['rss', 'sitemap', 'section', 'search'] as const).map((m) => (
          <Toggle key={m} checked={s.discovery.enabledMethods.includes(m)} onChange={(v) => up('discovery', { enabledMethods: v ? [...s.discovery.enabledMethods, m] : s.discovery.enabledMethods.filter((x) => x !== m) })} label={{ rss: 'RSS/Atom', sitemap: 'Sitemap', section: 'Trang chuyên mục + phân trang', search: 'Tìm kiếm của báo' }[m]} />
        ))}
        <Toggle checked={s.discovery.showIncompleteWarnings} onChange={(v) => up('discovery', { showIncompleteWarnings: v })} label="Hiện cảnh báo khi chạm giới hạn quét (chưa quét hết)" />
      </Section>
      <Section title="Kiểm tra độ đầy đủ khi bóc tách" help="Không bao giờ coi là đầy đủ 100% chỉ dựa vào độ dài; các cảnh báo dưới đây đưa bài vào hàng Bóc tách thiếu để người duyệt xem">
        <NumberField label="Số ký tự nội dung tối thiểu" value={s.quality.minBodyChars} min={0} max={20000} step={50} onChange={(n) => up('quality', { minBodyChars: n })} />
        <NumberField label="Số đoạn tối thiểu" value={s.quality.minParagraphs} min={0} max={100} onChange={(n) => up('quality', { minParagraphs: n })} />
        <NumberField label="Ngưỡng lệch so với articleBody (JSON-LD)" value={Math.round(s.quality.jsonLdMismatchRatio * 100)} min={0} max={100} suffix="%" onChange={(n) => up('quality', { jsonLdMismatchRatio: n / 100 })} />
        <Toggle checked={s.quality.flagMissingTables} onChange={(v) => up('quality', { flagMissingTables: v })} label="Cảnh báo bảng biểu chưa trích được" />
        <Toggle checked={s.quality.flagMissingCaptions} onChange={(v) => up('quality', { flagMissingCaptions: v })} label="Cảnh báo ảnh thiếu chú thích" />
        <Toggle checked={s.quality.flagPagination} onChange={(v) => up('quality', { flagPagination: v })} label="Phát hiện bài nhiều trang / đọc tiếp" />
        <Toggle checked disabled onChange={() => {}} label="Bài không xác minh được giờ đăng luôn vào hàng Cần kiểm tra (bắt buộc)" />
      </Section>
      <Section title="Ảnh báo gốc">
        <Toggle checked disabled onChange={() => {}} label="Chỉ dùng ảnh thật từ bài báo gốc – không bao giờ dùng ảnh AI (bắt buộc)" />
        <Select label="Chính sách dùng ảnh" value={s.editorial.photoPolicy} onChange={(v) => up('editorial', { photoPolicy: v })} options={[['review_then_use', 'Người duyệt chọn ảnh, ghi nguồn'], ['strict_verified_only', 'Chỉ ảnh đã xác minh quyền sử dụng'], ['link_only', 'Không nhúng ảnh, chỉ dẫn link bài gốc']]} />
        <Select label="Khi không có ảnh dùng được" value={s.editorial.noImagePolicy} onChange={(v) => up('editorial', { noImagePolicy: v })} options={[['text_only', 'Dùng bố cục chỉ có chữ'], ['block_slide', 'Chặn xuất, yêu cầu xử lý']]} />
        <NumberField label="Số ảnh ứng viên tối đa mỗi bài" value={s.editorial.maxImagesPerArticle} min={0} max={5} onChange={(n) => up('editorial', { maxImagesPerArticle: n })} />
        <NumberField label="Chiều rộng ảnh tối thiểu" value={s.editorial.minImageWidth} min={100} max={4000} step={50} suffix="px" onChange={(n) => up('editorial', { minImageWidth: n })} />
      </Section>
      <Section title="Độ dài tóm tắt (cảnh báo tràn khung)">
        <div className="grid gap-3 md:grid-cols-3">
          <NumberField label="Cần nghiên cứu, xử lý" value={s.editorial.summaryMaxChars.TT} min={80} max={800} onChange={(n) => up('editorial', { summaryMaxChars: { ...s.editorial.summaryMaxChars, TT: n } })} />
          <NumberField label="Tích cực" value={s.editorial.summaryMaxChars.TC} min={80} max={800} onChange={(n) => up('editorial', { summaryMaxChars: { ...s.editorial.summaryMaxChars, TC: n } })} />
          <NumberField label="Trung lập" value={s.editorial.summaryMaxChars.TL} min={80} max={800} onChange={(n) => up('editorial', { summaryMaxChars: { ...s.editorial.summaryMaxChars, TL: n } })} />
        </div>
      </Section>
    </div>
  );
}

/* ---------------- Report ---------------- */
function ReportPanel({ s, up, advanced }: { s: Settings; up: Up; advanced: boolean }) {
  const toast = useToast();
  const upEditorial = (p: Partial<Settings['editorial']>) => up('editorial', p);
  const [caps, setCaps] = useState<{ pdf: boolean; soffice: string | null; powerpoint?: string | null } | null>(null);
  const [tpls, setTpls] = useState<TemplateOption[]>([]);
  useEffect(() => {
    api.capabilities().then(setCaps).catch(() => setCaps(null));
    api.templates().then((r) => setTpls(r.templates)).catch(() => setTpls([]));
  }, []);
  const upload = async (f: File) => {
    if (!f.name.toLowerCase().endsWith('.pptx')) return toast('err', 'Chỉ nhận tệp .pptx');
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      const r = await api.uploadTemplate(f.name, btoa(bin));
      up('report', { templateFile: r.templateFile });
      toast('ok', `Đã lưu bản sao mẫu: ${r.templateFile} (tệp gốc của bạn không bị sửa)`);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  return (
    <div>
      <Section title="Mẫu mặc định" help="Mẫu dùng khi xuất báo cáo; lúc xuất vẫn chọn được mẫu khác cho từng lần.">
        <div className="space-y-1.5" role="radiogroup" aria-label="Mẫu mặc định khi xuất" data-testid="default-template-picker">
          {tpls.map((x) => (
            <label key={x.id} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm transition ${x.id === s.report.templateId ? 'border-teal-600 bg-teal-50 shadow-sm' : 'border-slate-200 bg-white hover:border-teal-300'}`}>
              <input type="radio" name="default-template" className="mt-1" value={x.id} checked={x.id === s.report.templateId} onChange={() => up('report', { templateId: x.id })} aria-label={x.name} />
              <span>
                <span className="font-medium">{x.name}</span>
                <span className="ml-1 text-xs text-slate-500">· {x.orientation === 'landscape' ? 'trang ngang 16:9' : 'A4 dọc'}{x.id === s.report.templateId ? ' · mặc định' : ''}</span>
                <span className="block text-xs text-slate-600">{x.description}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="btn-ghost mt-2 w-fit cursor-pointer rounded-full text-xs" title="Chỉ cần khi muốn dùng một tệp .pptx khác (cùng cấu trúc mẫu Sở)">
          <FileUp className="h-3.5 w-3.5" /> Dùng tệp mẫu .pptx riêng…
          <input type="file" accept=".pptx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
      </Section>
      <Section title="Thông tin trên báo cáo">
        <Field label="Tên cơ quan trên bìa"><input className="input" value={s.report.organization} onChange={(e) => up('report', { organization: e.target.value })} /></Field>
        <Field label="Email phúc đáp (trang Kiến nghị)"><input className="input" value={s.report.contactEmail} onChange={(e) => up('report', { contactEmail: e.target.value })} /></Field>
        <div>
          <span className="label">Tệp xuất ra (tích sẵn khi xuất)</span>
          <div className="flex flex-wrap gap-2">
            {(['pptx', 'docx', 'pdf'] as const).map((f) => {
              const on = s.report.outputFormats.includes(f);
              return (
                <label key={f} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${on ? 'border-teal-600 bg-teal-50 text-teal-900' : 'border-slate-200 bg-white text-slate-600'}`}>
                  <input type="checkbox" className="accent-teal-600" checked={on} onChange={(e) => up('report', { outputFormats: e.target.checked ? [...s.report.outputFormats, f] : s.report.outputFormats.filter((x) => x !== f) })} /> .{f}
                </label>
              );
            })}
          </div>
        </div>
      </Section>
      {s.report.templateFile && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-xs text-green-900">
          <b>Có thêm mẫu riêng của bạn:</b> báo cáo được dựng bằng cách nhân bản đúng các trang của mẫu (Bìa → Cần nghiên cứu, xử lý → Tích cực → Trung lập → Kiến nghị), thay nội dung trong các khung sẵn có và giữ nguyên định dạng. Nếu mẫu khác cấu trúc, xuất báo cáo sẽ báo <b>BLOCKED</b> thay vì tạo tệp sai.
        </div>
      )}
      <Section title="Đề xuất giao đơn vị cho tin Cần nghiên cứu, xử lý" help="Mỗi tin Cần nghiên cứu, xử lý được gợi ý giao đơn vị của nhóm khớp nhất theo từ khóa (có trong tiêu đề = 3 điểm, chỉ trong sapo = 1 điểm). Biên tập viên vẫn sửa được từng tin.">
        <details>
        <summary className="cursor-pointer select-none text-sm text-teal-700">{(s.editorial.assignmentRules ?? []).length} nhóm đơn vị – bấm để xem / sửa</summary>
        <div className="mt-2 space-y-2" data-testid="assignment-rules">
          {(s.editorial.assignmentRules ?? []).map((r, i) => {
            const set = (p: Partial<typeof r>) => upEditorial({ assignmentRules: s.editorial.assignmentRules.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <div key={i} className="rounded border border-slate-200 bg-white p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input className="input w-72" aria-label={`Nhóm ${i + 1}`} value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Tên nhóm (ví dụ: Ngập lụt, cây xanh)" />
                  <button className="btn-danger btn-xs ml-auto" onClick={() => upEditorial({ assignmentRules: s.editorial.assignmentRules.filter((_, j) => j !== i) })}>Xóa nhóm</button>
                </div>
                <div className="mt-1 text-xs text-slate-600">Từ khóa</div>
                <ChipEditor values={r.keywords} onChange={(v) => set({ keywords: v })} placeholder="từ khóa…" />
                <label className="mt-1 block text-xs text-slate-600">
                  Giao (đơn vị + việc)
                  <input className="input" aria-label={`Đơn vị nhóm ${i + 1}`} value={r.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="Phòng … tham mưu, xử lý" />
                </label>
              </div>
            );
          })}
          <button className="btn-ghost w-fit" onClick={() => upEditorial({ assignmentRules: [...(s.editorial.assignmentRules ?? []), { name: '', keywords: [], unit: '' }] })}>
            <Plus className="h-4 w-4" /> Thêm nhóm
          </button>
          <Field label="Khi không khớp nhóm nào" help="Câu đề xuất chung (sau chữ 'Đề xuất:').">
            <input className="input" value={s.editorial.assignmentFallback} onChange={(e) => upEditorial({ assignmentFallback: e.target.value })} />
          </Field>
        </div>
        </details>
      </Section>
      {!advanced && (
        <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">Bật <b>Nâng cao</b> (cột trái) để chỉnh tên tệp, số tin mỗi trang, bộ xuất PDF và các tùy chọn khác.</p>
      )}
      {advanced && (
      <>
      <Section title="Trình bày">
        <p className="text-xs">Mẫu riêng đang có: <b>{s.report.templateFile || 'không có – vẫn xuất bình thường bằng các mẫu có sẵn'}</b>{api.mode !== 'local' ? ' (bản web: mẫu riêng chỉ lưu trong trình duyệt này)' : ''}</p>
        <Field label="Tên hiển thị trên đầu trang"><input className="input" value={s.report.subtitle} onChange={(e) => up('report', { subtitle: e.target.value })} /></Field>
        <NumberField label="Số tin mỗi trang" value={s.report.storiesPerPage} min={1} max={4} onChange={(n) => up('report', { storiesPerPage: n })} />
        <Select label="Khi nội dung quá dài" value={s.report.overflowPolicy} onChange={(v) => up('report', { overflowPolicy: v })} options={[['new_slide', 'Thêm trang cùng loại'], ['warn_only', 'Chỉ cảnh báo, người duyệt rút gọn']]} />
      </Section>
      <Section title="Tệp & PDF">
        <Field label="Mẫu tên tệp" help="{date} = ngày báo cáo, {from}/{to} = giờ khung (HHmm)" error={!s.report.filenamePattern.includes('{date}') ? 'Nên có {date} để tránh trùng tên' : null}>
          <input className="input font-mono text-xs" value={s.report.filenamePattern} onChange={(e) => up('report', { filenamePattern: e.target.value })} />
        </Field>
        <Select label="Bộ xuất PDF" value={s.report.pdfRenderer} onChange={(v) => up('report', { pdfRenderer: v })} options={[['builtin', 'Tích hợp sẵn (khuyên dùng): PDF khổ A4 dạng văn bản, có ảnh, link bấm được – không cần Office'], ['auto', 'Chuyển từ PowerPoint: Microsoft PowerPoint, nếu không có thì LibreOffice'], ['powerpoint', 'Chuyển từ PowerPoint: chỉ Microsoft PowerPoint'], ['libreoffice', 'Chuyển từ PowerPoint: chỉ LibreOffice'], ['none', 'Không xuất PDF']]} help="Tích hợp sẵn chạy cả trên web lẫn máy không cài Office. Muốn PDF giống hệt từng slide thì chọn chuyển từ PowerPoint (chỉ bản local; ứng dụng mở tệp ở chế độ chỉ đọc, không đóng các bản trình chiếu khác của bạn)." />
        <Field label="Đường dẫn POWERPNT.EXE (tùy chọn)"><input className="input font-mono text-xs" placeholder="C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE" value={s.report.powerPointPath} onChange={(e) => up('report', { powerPointPath: e.target.value })} /></Field>
        <Field label="Đường dẫn soffice.exe (tùy chọn)"><input className="input font-mono text-xs" placeholder="C:\Program Files\LibreOffice\program\soffice.exe" value={s.report.libreOfficePath} onChange={(e) => up('report', { libreOfficePath: e.target.value })} /></Field>
        <p className="text-xs">
          {s.report.pdfRenderer === 'builtin'
            ? 'PDF dùng bộ xuất tích hợp sẵn – không cần PowerPoint hay LibreOffice.'
            : caps
            ? caps.pdf
              ? [caps.powerpoint && `Microsoft PowerPoint: ${caps.powerpoint}`, caps.soffice && `LibreOffice: ${caps.soffice}`].filter(Boolean).join(' · ')
              : 'Chưa tìm thấy PowerPoint hay LibreOffice – xuất PDF sẽ báo không khả dụng.'
            : 'Không kiểm tra được bộ chuyển PDF.'}
        </p>
      </Section>
      </>
      )}
    </div>
  );
}

/* ---------------- Impact preview (save bar) ---------------- */
const STATUS_VN: Record<string, string> = { relevant: 'Sẵn sàng', review: 'Cần kiểm tra', irrelevant: 'Loại' };
function ImpactLine({ impact }: { impact: ReturnType<typeof impactOf> }) {
  const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const cmp = (a: number | null, b: number | null) => (a == null || b == null || Math.round(a * 100) === Math.round(b * 100) ? 'text-slate-600' : b > a ? 'text-green-700' : 'text-red-700');
  const { before: b, after: a, changes } = impact;
  const worse = changes.some((c) => !c.better);
  return (
    <details className="relative" data-testid="impact">
      <summary className={`flex cursor-pointer list-none flex-wrap items-center gap-x-2 rounded-full px-2 py-0.5 text-xs hover:bg-amber-100 ${worse ? 'text-red-800' : 'text-slate-700'}`} title="Đo trên các bài nhóm đã chấm – bấm để xem bài thay đổi">
        {changes.length === 0 ? (
          <span>Không đổi kết quả trên {b.judged} bài đã chấm</span>
        ) : (
          <>
            <span>Trên {b.judged} bài đã chấm:</span>
            <span>đúng chủ đề <b className={cmp(b.precision, a.precision)}>{pct(b.precision)} → {pct(a.precision)}</b></span>
            <span>· không bỏ sót <b className={cmp(b.recall, a.recall)}>{pct(b.recall)} → {pct(a.recall)}</b></span>
            <span className="underline">· {changes.length} bài thay đổi</span>
          </>
        )}
      </summary>
      {changes.length > 0 && (
        <div className="animate-in absolute bottom-full left-0 z-20 mb-2 max-h-72 w-[min(32rem,90vw)] overflow-auto rounded-xl border border-slate-200 bg-white p-2 text-xs shadow-lg">
          {changes.map((c) => (
            <div key={c.id} className="flex items-start gap-2 border-b border-slate-100 py-1.5 last:border-0">
              <span className={`mt-0.5 shrink-0 font-bold ${c.better ? 'text-green-600' : 'text-red-600'}`}>{c.better ? '✓' : '✗'}</span>
              <span className="min-w-0 flex-1">
                {c.title}
                <span className="block text-slate-500">nhóm chấm: {c.relevant ? 'liên quan' : 'không liên quan'} · {STATUS_VN[c.before]} → <b>{STATUS_VN[c.after]}</b></span>
              </span>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/* ---------------- Daily filter suggestions ---------------- */
/** suggestion kinds: include (teal) · place (sky) · sector keyword (amber) · rule setting (violet) · title exclusion (rose) */
const KIND_COLOR: Record<string, string> = { include: 'bg-teal-600', place: 'bg-sky-600', sector: 'bg-amber-500', setting: 'bg-violet-600', exclude_title: 'bg-rose-500' };
function SuggestPanel({ s, setS, onCount }: { s: Settings; setS: (fn: (p: Settings | null) => Settings | null) => void; onCount: (n: number) => void }) {
  const toast = useToast();
  const [st, setSt] = useState<SuggestionsState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'applied' | 'dismissed'>>({});
  const [cat, setCat] = useState<Record<string, CategoryCode>>({});
  useEffect(() => {
    if (!api.suggestions) return setSt({ generatedAt: null, basis: null, items: [] });
    api.suggestions().then(setSt).catch((e) => setErr((e as Error).message));
  }, []);
  // applied (and saved) ones disappear at once, not only after the nightly list is renewed
  const open = (st?.items ?? []).filter((x) => !done[x.id] && !alreadyApplied(s, x));
  useEffect(() => onCount(open.length), [open.length, onCount]);
  const apply = (x: FilterSuggestion) => {
    setS((p) => (p ? applySuggestion(p, { ...x, category: x.kind === 'include' || x.kind === 'sector' ? (cat[x.id] ?? x.category) : undefined }) : p));
    setDone((d) => ({ ...d, [x.id]: 'applied' }));
    toast('ok', `Đã áp dụng "${x.kind === 'setting' ? x.setting?.label ?? x.phrase : x.phrase}" – bấm Lưu để dùng từ lượt thu thập sau`);
  };
  const dismiss = async (x: FilterSuggestion) => {
    try {
      await api.dismissSuggestion?.(x.id);
      setDone((d) => ({ ...d, [x.id]: 'dismissed' }));
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (!st) return <p className="text-sm text-slate-500">Đang phân tích…</p>;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500" data-testid="suggest-basis">
        <Sparkles className="h-4 w-4 text-amber-500" />
        {st.basis ? (
          <span>
            Học từ <b>{st.basis.votes}</b> phiếu ✓/✗ và <b>{st.basis.decisions}</b> quyết định duyệt trên {st.basis.stories} bài
            {st.generatedAt ? ` · cập nhật ${formatVn(st.generatedAt)}` : ''}
          </span>
        ) : (
          <span>Gợi ý được tính mỗi đêm từ phiếu ✓/✗ và quyết định duyệt của nhóm.</span>
        )}
      </div>
      {open.length === 0 && (
        <div className="card flex flex-col items-center gap-2 p-8 text-center" data-testid="suggest-empty">
          <CheckCircle className="h-8 w-8 text-green-500" />
          <p className="font-medium text-slate-700">Chưa có gợi ý mới</p>
          <p className="max-w-md text-xs text-slate-500">Bộ lọc đang khớp với các bài nhóm đã chấm (cả phiếu ✓/✗ lẫn bài nhóm tự chuyển lên Sẵn sàng hay Loại). Gợi ý chỉ xuất hiện khi một thay đổi sửa được ít nhất 2 bài và không làm sai bài đã chấm (đổi quy tắc: đúng ít nhất gấp 4 lần sai).</p>
        </div>
      )}
      <div className="grid gap-2">
        {open.map((x) => (
          <div key={x.id} className="card animate-in p-4" data-testid="suggestion">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`flex h-8 w-8 items-center justify-center rounded-full text-white ${KIND_COLOR[x.kind] ?? 'bg-slate-500'}`} aria-hidden="true">
                {x.kind === 'include' ? <Plus className="h-4 w-4" /> : x.kind === 'place' ? <MapPin className="h-4 w-4" /> : x.kind === 'sector' ? <Tag className="h-4 w-4" /> : x.kind === 'setting' ? <SlidersHorizontal className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-800">
                  {x.kind === 'setting' ? (
                    <>Đổi quy tắc: <span className="font-normal">{x.setting?.label ?? x.phrase}</span></>
                  ) : (
                    <>
                      {x.kind === 'include' ? 'Lấy thêm bài có' : x.kind === 'place' ? `Nhận là địa bàn ${s.location.regionName}:` : x.kind === 'sector' ? 'Thêm từ khóa lĩnh vực' : 'Bỏ bài có tiêu đề chứa'} <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm">{x.phrase}</span>
                    </>
                  )}
                </div>
                <div className="text-xs text-slate-600">
                  {x.kind === 'include'
                    ? `Giữ lại ${x.fixes} bài nhóm đánh giá liên quan nhưng đang bị loại`
                    : x.kind === 'place'
                      ? `Đưa ${x.fixes} bài liên quan chưa nhận ra địa bàn lên (thêm vào mục Địa điểm)`
                      : x.kind === 'sector'
                        ? `Đưa ${x.fixes} bài nhóm đã chuyển tay lên Sẵn sàng (máy để ở Cần kiểm tra) vào thẳng Bài sẵn sàng`
                        : x.kind === 'setting'
                          ? `Đúng thêm ${x.fixes} bài đã chấm`
                          : `Loại ${x.fixes} bài lạc đề đang lọt vào Bài sẵn sàng`}
                  {x.kind === 'setting' && (x.harms ? <b className="text-amber-700">{` · sai ${x.harms} bài đã chấm`}</b> : ' · không làm sai bài đã chấm nào')}
                  {x.sideEffects > 0 ? ` · ảnh hưởng thêm ${x.sideEffects} bài chưa chấm` : ' · không ảnh hưởng bài nào khác'}
                </div>
              </div>
              {(x.kind === 'include' || x.kind === 'sector') && (
                <select className="input w-44 text-xs" value={cat[x.id] ?? x.category ?? 'BUILD'} onChange={(e) => setCat((c) => ({ ...c, [x.id]: e.target.value as CategoryCode }))} aria-label={`Lĩnh vực cho "${x.phrase}"`} title="Từ này cũng được thêm vào lĩnh vực đã chọn">
                  {s.categories.filter((c) => c.enabled).map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              )}
              <button className="btn-teal rounded-full" disabled={adminOnly()} title={adminOnly() ? `${ADMIN_HINT} áp dụng gợi ý` : undefined} onClick={() => apply(x)}>Áp dụng</button>
              <button className="btn-ghost rounded-full" onClick={() => dismiss(x)}>Bỏ qua</button>
            </div>
            <details className="mt-2 text-xs text-slate-600">
              <summary className="cursor-pointer select-none text-teal-700">Xem bài liên quan</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {x.examples.map((t) => <li key={t}>{x.links?.[t] ? <a className="text-teal-700 hover:underline" href={x.links[t]} target="_blank" rel="noreferrer" title="Mở bài gốc (tab mới)">{t} ↗</a> : t}</li>)}
              </ul>
              {(x.harmExamples?.length ?? 0) > 0 && (
                <>
                  <div className="mt-1 text-amber-800">Bài đã chấm sẽ bị xếp sai:</div>
                  <ul className="list-disc space-y-0.5 pl-5 text-amber-800">{x.harmExamples!.map((t) => <li key={t}>{x.links?.[t] ? <a className="hover:underline" href={x.links[t]} target="_blank" rel="noreferrer">{t} ↗</a> : t}</li>)}</ul>
                </>
              )}
              {x.sideExamples.length > 0 && (
                <>
                  <div className="mt-1 text-slate-500">Bài chưa chấm bị ảnh hưởng:</div>
                  <ul className="list-disc space-y-0.5 pl-5 text-slate-500">{x.sideExamples.map((t) => <li key={t}>{x.links?.[t] ? <a className="hover:underline" href={x.links[t]} target="_blank" rel="noreferrer">{t} ↗</a> : t}</li>)}</ul>
                </>
              )}
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Performance ---------------- */
function PerfPanel({ s, up }: { s: Settings; up: Up }) {
  return (
    <Section title="Mạng & hiệu năng">
      <NumberField label="Tối đa bài tải mỗi báo / lượt thu thập" value={s.collection.maxArticlesPerSource} min={1} max={2000} onChange={(n) => up('collection', { maxArticlesPerSource: n })} />
      <NumberField
        label="Link không có ngày đăng: dừng sau số bài liên tiếp đã xác minh là cũ hơn khung giờ"
        value={s.collection.undatedStopAfterOld}
        min={0}
        max={100}
        onChange={(n) => up('collection', { undatedStopAfterOld: n })}
        help="Link từ trang chuyên mục sâu thường không có ngày; hệ thống đọc bài mới nhất trước. Sau số bài liên tiếp này đều cũ hơn khung giờ, các link không ngày cũ hơn được ghi “ngoài khung giờ” (lý do OLDER_THAN_CHECKED, vẫn bấm Thử lại được) thay vì tải hết. 0 = tắt."
      />
      <p className="-mt-1 text-xs text-slate-500">Áp dụng cho mọi báo; ưu tiên tải bài có ngày trong khung giờ, mới nhất trước. Mỗi nguồn (Nguồn tin) có thể đặt giới hạn thấp hơn. Bài vượt giới hạn ghi "FETCH_LIMIT" trong danh sách link (Độ phủ & nguồn).</p>
      <NumberField label="Tổng yêu cầu đồng thời" value={s.collection.maxConcurrentRequests} min={1} max={16} onChange={(n) => up('collection', { maxConcurrentRequests: n })} />
      <NumberField label="Yêu cầu đồng thời mỗi báo" value={s.collection.maxRequestsPerHost} min={1} max={8} onChange={(n) => up('collection', { maxRequestsPerHost: n })} help="Giữ 1–2 để lịch sự với máy chủ báo" />
      {s.collection.maxRequestsPerHost > 3 && <p className="text-xs text-amber-700">Cảnh báo: nhiều kết nối/báo có thể khiến báo chặn IP.</p>}
      <NumberField label="Thời gian chờ mỗi yêu cầu" value={s.collection.timeoutMs} min={2000} max={120000} step={1000} suffix="ms" onChange={(n) => up('collection', { timeoutMs: n })} />
      <NumberField label="Số lần thử lại" value={s.collection.maxRetries} min={0} max={6} onChange={(n) => up('collection', { maxRetries: n })} />
      <NumberField label="Độ trễ thử lại cơ sở (lũy thừa + ngẫu nhiên)" value={s.collection.backoffBaseMs} min={100} max={30000} step={100} suffix="ms" onChange={(n) => up('collection', { backoffBaseMs: n })} />
      <Field label="User-Agent"><input className="input font-mono text-xs" value={s.collection.userAgent} onChange={(e) => up('collection', { userAgent: e.target.value })} /></Field>
      <Toggle checked={s.collection.respectRobotsTxt} onChange={(v) => up('collection', { respectRobotsTxt: v })} label="Tôn trọng robots.txt và điều khoản của báo (không vượt chặn/paywall/CAPTCHA)" />
      <NumberField label="Bộ nhớ đệm HTTP" value={s.performance.httpCacheMinutes} min={0} max={1440} suffix="phút" onChange={(n) => up('performance', { httpCacheMinutes: n })} />
      <NumberField label="Giữ dữ liệu lượt chạy" value={s.performance.keepRunsDays} min={1} max={3650} suffix="ngày" onChange={(n) => up('performance', { keepRunsDays: n })} />
    </Section>
  );
}

/* ---------------- Backup & history ---------------- */
function BackupPanel({ onRestored }: { onRestored: () => void }) {
  const toast = useToast();
  const [hist, setHist] = useState<HistoryEntry[]>([]);
  const reload = () => api.history().then(setHist).catch((e) => toast('err', e.message));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const download = async () => {
    const b = await api.backup();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }));
    a.download = `news-reporter-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  const restore = async (f: File) => {
    try {
      const j = JSON.parse(await f.text());
      if (!confirm('Khôi phục sẽ thay cài đặt và nguồn tin hiện tại bằng bản sao lưu (bản hiện tại được lưu vào lịch sử để hoàn tác). Tiếp tục?')) return;
      await api.restore(j);
      toast('ok', 'Đã khôi phục');
      onRestored();
      reload();
    } catch (e) {
      toast('err', `Không khôi phục được: ${(e as Error).message}`);
    }
  };
  return (
    <div>
      <Section title="Sao lưu / khôi phục">
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={download}><Download className="h-4 w-4" /> Tải bản sao lưu</button>
          <label className="btn-ghost cursor-pointer"><FileUp className="h-4 w-4" /> Khôi phục từ tệp…<input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} /></label>
        </div>
      </Section>
      <Section title="Lịch sử thay đổi" actions={<button className="btn-ghost btn-xs" onClick={reload}><History className="h-3 w-3" /> Tải lại</button>}>
        {hist.length === 0 && <p className="text-xs text-slate-500">Chưa có thay đổi nào.</p>}
        <table className="w-full">
          <tbody>
            {hist.map((h) => (
              <tr key={h.id}>
                <td className="td text-xs">{new Date(h.at).toLocaleString('vi-VN')}</td>
                <td className="td text-xs">{h.kind === 'settings' ? 'Cài đặt' : 'Nguồn tin'}</td>
                <td className="td text-xs">Trạng thái trước khi: {h.summary}</td>
                <td className="td">
                  <button className="btn-ghost btn-xs" disabled={adminOnly()} title={adminOnly() ? ADMIN_HINT : undefined} onClick={async () => { if (!confirm('Khôi phục về phiên bản này? Bản hiện tại sẽ được lưu vào lịch sử.')) return; try { await api.rollback(h.id); toast('ok', 'Đã hoàn tác'); onRestored(); reload(); } catch (e) { toast('err', (e as Error).message); } }}>
                    <RotateCcw className="h-3 w-3" /> Khôi phục
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

/* ---------------- Profiles (cấu hình theo địa bàn) ---------------- */
/** the page reloads after a profile change: App reopens Settings on this section */
function reopenSettingsAfterReload(section: string) {
  try {
    sessionStorage.setItem('reopenSettings', section);
  } catch {
    /* private mode: Settings simply stay closed */
  }
}

/** overview = the open profile (rename, copy, delete); create = new profile form */
function ProfilesPanel({ dirty, view, onCreate, onChanged }: { dirty: boolean; view: 'overview' | 'create'; onCreate: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [st, setSt] = useState<ProfilesState | null>(null);
  const reload = (changed = true) => (changed && onChanged(), api.profiles().then(setSt).catch((e) => toast('err', (e as Error).message)));
  useEffect(() => {
    reload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [mode, setMode] = useState<'region' | 'clone'>('region');
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [aliases, setAliases] = useState('');
  const [cloneFrom, setCloneFrom] = useState('hcm');
  const [desc, setDesc] = useState('');
  const [useNow, setUseNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const activate = async (id: string) => {
    if (dirty && !confirm('Có thay đổi cài đặt chưa lưu. Chuyển cấu hình và bỏ thay đổi?')) return;
    await api.activateProfile(id);
    reopenSettingsAfterReload('profiles');
    window.location.reload();
  };
  const create = async () => {
    if (!name.trim()) return toast('err', 'Nhập tên cấu hình');
    setBusy(true);
    try {
      const meta = await api.createProfile({
        name: name.trim(), description: desc, cloneFrom: mode === 'clone' ? cloneFrom : null,
        regionName: mode === 'region' ? region.trim() : '', regionAliases: aliases.split(',').map((x) => x.trim()).filter(Boolean),
      });
      toast('ok', `Đã tạo cấu hình "${meta.name}"`);
      setName('');
      setRegion('');
      setAliases('');
      setDesc('');
      if (useNow) return activate(meta.id);
      reload();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rename = async () => {
    if (!renaming?.name.trim()) return;
    try {
      await api.updateProfile(renaming.id, { name: renaming.name.trim() });
      setRenaming(null);
      reload();
      toast('ok', 'Đã đổi tên cấu hình');
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  const remove = async (id: string, label: string) => {
    if (!confirm(`Xóa cấu hình "${label}"? Dữ liệu đã thu thập của cấu hình này không hiện trong danh sách nữa.`)) return;
    try {
      await api.deleteProfile(id);
      if (id === st?.activeId) return reopenSettingsAfterReload('profiles'), window.location.reload();
      reload();
      toast('ok', `Đã xóa cấu hình "${label}"`);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };

  return (
    <div>
      {view === 'overview' && (
      <Section
        title="Tổng quan cấu hình"
        help="Mỗi cấu hình là một bộ đầy đủ: nguồn báo, từ khóa & quy tắc, địa danh, lĩnh vực, báo cáo… – các mục nằm ngay dưới tên cấu hình ở cột trái. Cấu hình khác: bấm tên của nó ở cột trái. Thêm Hà Nội, Đà Nẵng…: bấm + Tạo cấu hình mới."
      >
        <table className="w-full text-sm" data-testid="profiles-table">
          <tbody>
            {st?.profiles.filter((p) => p.id === st.activeId).map((p) => (
              <tr key={p.id} className="border-b border-slate-100">
                <td className="py-2 pr-2">
                  {renaming?.id === p.id ? (
                    <span className="flex gap-1">
                      <input className="input" aria-label="Tên mới" value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                      <button className="btn-primary btn-xs" onClick={rename}>Lưu tên</button>
                      <button className="btn-ghost btn-xs" onClick={() => setRenaming(null)}>Hủy</button>
                    </span>
                  ) : (
                    <>
                      <b>{p.name}</b> <span className="text-xs text-slate-500">({p.id})</span>
                      {p.id === st.activeId && <span className="chip ml-2 border-teal-300 bg-teal-50 text-teal-900">đang dùng</span>}
                      {api.mode !== 'local' && p.autoCollect && <span className="chip ml-1 border-green-300 bg-green-50 text-green-800">tự động mỗi giờ</span>}
                      {p.clonedFrom && <span className="ml-1 text-xs text-slate-500">· sao chép từ {st.profiles.find((x) => x.id === p.clonedFrom)?.name ?? p.clonedFrom}</span>}
                      {p.description && <div className="text-xs text-slate-500">{withoutSkillNote(p.description)}</div>}
                    </>
                  )}
                </td>
                <td className="whitespace-nowrap py-2 text-right">
                  {p.id !== st.activeId && <button className="btn-teal btn-xs" onClick={() => activate(p.id)}>Dùng cấu hình này</button>}
                  <button className="btn-ghost btn-xs" onClick={() => (setMode('clone'), setCloneFrom(p.id), setName(`${p.name} (bản sao)`), onCreate())}>Sao chép thành cấu hình mới</button>
                  <button className="btn-ghost btn-xs" disabled={adminOnly()} title={adminOnly() ? ADMIN_HINT : undefined} onClick={() => setRenaming({ id: p.id, name: p.name })}>Đổi tên</button>
                  {st.profiles.length > 1 && <button className="btn-danger btn-xs" disabled={adminOnly()} title={adminOnly() ? ADMIN_HINT : undefined} onClick={() => remove(p.id, p.name)}>Xóa</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {st && st.profiles.length > 1 && <p className="mt-2 text-xs text-slate-500">Còn {st.profiles.length - 1} cấu hình khác: {st.profiles.filter((p) => p.id !== st.activeId).map((p) => p.name).join(', ')} – bấm tên ở cột trái để mở.</p>}
      </Section>
      )}
      {view === 'create' && (
      <Section title="Tạo cấu hình mới">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'region'} onChange={() => setMode('region')} /> Địa bàn mới (từ cấu hình chuẩn)</label>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === 'clone'} onChange={() => setMode('clone')} /> Sao chép từ cấu hình có sẵn</label>
        </div>
        <Field label="Tên cấu hình"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Hà Nội" /></Field>
        {mode === 'region' ? (
          <>
            <Field label="Tên địa bàn" help="Dùng để lọc bài theo địa bàn; thêm phường/xã/địa danh sau ở mục Địa điểm."><input className="input" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Hà Nội" /></Field>
            <Field label="Cách viết khác của địa bàn (cách nhau bằng dấu phẩy)"><input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="TP Hà Nội, Thủ đô, thành phố Hà Nội" /></Field>
            <p className="text-xs text-slate-500">Cấu hình mới giữ nguyên nguồn báo, từ khóa ngành, lĩnh vực và quy tắc chuẩn; TP.HCM được xem là "địa phương khác".</p>
          </>
        ) : (
          <Field label="Sao chép từ">
            <select className="input" value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)} aria-label="Sao chép từ">
              {st?.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Mô tả (không bắt buộc)"><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} /> Dùng cấu hình mới ngay sau khi tạo</label>
        <button className="btn-primary w-fit" disabled={busy || adminOnly()} title={adminOnly() ? ADMIN_HINT : undefined} onClick={create}><Plus className="h-4 w-4" /> Tạo cấu hình</button>
      </Section>
      )}
    </div>
  );
}