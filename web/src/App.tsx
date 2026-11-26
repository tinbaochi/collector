import { Activity, AlarmClock, AlertTriangle, Archive, ArchiveRestore, HelpCircle, History, Lightbulb, ArrowDown, ArrowRight, ArrowUp, BarChart3, CalendarClock, Clock3, Check, Inbox, LogIn, LogOut, MapPin, QrCode, CheckCircle2, ChevronDown, Download, ExternalLink, FileText, Play, RefreshCw, Search, Settings as Cog, Square, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { suggestAssignment } from '../../src/domain/assignment';
import { ASSESSMENT_LABEL } from '../../src/domain/classify';
import { EXCLUDE_REASONS, EXCLUDE_REASON_LABEL, type AdapterHealth, type Article, type Candidate, type CategoryCode, type EditorialAssessment, type ExcludeReason, type ReviewDecision, type Settings, type Source } from '../../src/domain/schemas';
import { formatVn, lastCompletedWindow, localInputToVnIso, todayWindow, validateWindow, vnIsoToLocalInput, yesterdayWindow } from '../../src/domain/timeWindow';
import { mergePatches, rootOf, secondariesOf } from '../../src/reports/assemble';
import { nextRun, slotsFor, type ScheduleSlot } from '../../src/domain/schedule';
import { uncertainStories, type UncertainStory } from '../../src/domain/suggest';
import { api, adminOnly, ADMIN_HINT, type CollectRun, type ExportFormat, type ExportResult, type ProfilesState, type TemplateOption, type RelevanceQuality, type RunInfo, type ServerStatus, type Vote } from './api';
import { SettingsDrawer } from './Settings';
import { QrDialog } from './QrTool';
import type { AskReply, AskRequest } from './askWorker';

/** one background thread for "Hỏi nhanh" (created on first use; null when the browser has no workers) */
let askWorkerInst: Worker | null | undefined;
function askWorker(): Worker | null {
  if (askWorkerInst !== undefined) return askWorkerInst;
  try {
    askWorkerInst = typeof Worker === 'undefined' ? null : new Worker(new URL('./askWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    askWorkerInst = null;
  }
  return askWorkerInst;
}
import { catStyle, STATE_LABEL, StateChip, useEscape, useToast } from './ui';

type Tab = 'articles' | 'review' | 'export';
const ASSESS: EditorialAssessment[] = ['needs_attention', 'positive', 'neutral'];
const ASSESS_COLOR: Record<EditorialAssessment, string> = { needs_attention: 'text-red-700 border-red-300 bg-red-50', positive: 'text-green-700 border-green-300 bg-green-50', neutral: 'text-slate-700 border-slate-300 bg-slate-50' };

export function App() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  // after switching profile inside Settings the page reloads: reopen Settings on the same section
  const [reopenSection, setReopenSection] = useState<string | null>(() => {
    try {
      const v = sessionStorage.getItem('reopenSettings');
      sessionStorage.removeItem('reopenSettings');
      return v;
    } catch {
      return null;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(!!reopenSection);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [arts, setArts] = useState<Article[]>([]);
  const [reviews, setReviews] = useState<Record<string, ReviewDecision>>({});
  const [tab, setTab] = useState<Tab>('articles');
  /** "Độ phủ & nguồn" of the viewed period: a drawer opened from "Nguồn tin trong kỳ" (user, 18/11/2026) */
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);
  const [preset, setPreset] = useState<'last_completed' | 'today' | 'yesterday' | 'custom'>('last_completed');
  const [from, setFrom] = useState('');
  // date/time editors open on "Tùy chỉnh" or a click on the window shown (closed otherwise: fewer controls on screen)
  const [editWindow, setEditWindow] = useState(false);
  const [to, setTo] = useState('');
  // profiles (cấu hình theo địa bàn): switching reloads everything for the chosen profile
  const [profiles, setProfiles] = useState<ProfilesState | null>(null);
  const activeProfile = profiles?.profiles.find((p) => p.id === profiles.activeId);
  const switchProfile = async (id: string) => {
    try {
      await api.activateProfile(id);
      window.location.reload();
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => (window.removeEventListener('online', on), window.removeEventListener('offline', off));
  }, []);

  const applyPreset = useCallback((p: typeof preset, s: Settings) => {
    setPreset(p);
    const w = presetWindow(p, s);
    setFrom(vnIsoToLocalInput(w.from));
    setTo(vnIsoToLocalInput(w.to));
    return w;
  }, []);

  // several loads can be in flight (startup, run picker, live refresh): only the most recently requested run is shown,
  // otherwise a slow earlier load could display one period while the review is saved to another
  const lastLoad = useRef<string | null>(null);
  /** web: the full text of excluded stories arrives after the first paint (api.bodies) */
  const [bodiesReady, setBodiesReady] = useState(true);
  const shownWindowOf = useRef<string | null>(null);
  useEffect(() => {
    const r = runs.find((x) => x.runId === runId);
    if (!r || !settings || shownWindowOf.current === r.runId) return;
    shownWindowOf.current = r.runId;
    setFrom(vnIsoToLocalInput(r.window.from));
    setTo(vnIsoToLocalInput(r.window.to));
    const same = (p: 'last_completed' | 'today' | 'yesterday') => {
      const w = presetWindow(p, settings);
      return Date.parse(w.from) === Date.parse(r.window.from) && Date.parse(w.to) === Date.parse(r.window.to);
    };
    setPreset(latestRun(runs)?.runId === r.runId ? 'last_completed' : same('today') ? 'today' : same('yesterday') ? 'yesterday' : 'custom');
  }, [runId, runs, settings]);

  /** open a saved run (its window fills Từ / Đến) */
  const pickRun = (id: string) => {
    shownWindowOf.current = null;
    setRunId(id);
  };
  /** "Kỳ gần nhất" = the most recent collection (not a computed clock window); without any run: the last completed window */
  const pickLatest = (s: Settings) => {
    const l = latestRun(runs);
    if (!l) return applyPreset('last_completed', s);
    setPreset('last_completed');
    if (l.runId === runId) {
      setFrom(vnIsoToLocalInput(l.window.from));
      setTo(vnIsoToLocalInput(l.window.to));
    } else pickRun(l.runId);
  };
  /** "Lượt đã lưu" › Xoá (local: deleted; web: hidden for the team, restorable) */
  const removeRun = async (r: RunInfo) => {
    const local = api.mode === 'local';
    const msg = `Xoá lượt ${runLabel(r)}?\n\n` + (local ? 'Dữ liệu thu thập và kết quả duyệt của lượt này sẽ bị xoá khỏi máy (các báo cáo đã xuất vẫn giữ).' : 'Lượt này bị xoá với cả nhóm và KHÔNG khôi phục được.\nMuốn cất đi để xem lại sau, hãy bấm Lưu trữ thay vì Xoá.');
    if (!window.confirm(msg)) return;
    try {
      await api.deleteRun!(r.runId);
      const rs = await api.listRuns();
      setRuns(rs);
      if (r.runId === runId) {
        const l = latestRun(rs);
        if (l) pickRun(l.runId);
        else setRunId(null);
      }
      toast('ok', local ? 'Đã xoá lượt' : 'Đã xoá lượt (ẩn với cả nhóm)');
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  const restoreRun = async (id: string) => {
    try {
      await api.restoreRun!(id);
      setRuns(await api.listRuns());
      toast('ok', 'Đã khôi phục lượt');
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  // web: archiving a run is for every reviewer, deleting it for admins (20/11/2026)
  const canArchiveRuns = !!api.deleteRun && (api.mode === 'local' || !!api.shared?.session());
  const canDeleteRuns = canArchiveRuns && !adminOnly();
  const archiveRun = async (r: RunInfo, on: boolean) => {
    try {
      await api.archiveRun!(r.runId, on);
      const rs = await api.listRuns();
      setRuns(rs);
      // the viewed run put away: open the most recent one still in the list (like Xoá)
      if (on && r.runId === runId) {
        const l = latestRun(rs);
        if (l) pickRun(l.runId);
      }
      toast('ok', on ? `Đã lưu trữ ${runLabel(r)} – xem lại ở mục "Lưu trữ" cuối danh sách` : `Đã đưa ${runLabel(r)} về danh sách`);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };

  const loadRun = useCallback(async (id: string) => {
    lastLoad.current = id;
    const [r, c, a, rv] = await Promise.all([api.getRun(id), api.candidates(id), api.articles(id), api.review(id)]);
    if (lastLoad.current !== id) return;
    setRun(r);
    setCands(c);
    setArts(a);
    setReviews(rv);
    setBodiesReady(false);
    void (api.bodies?.(id) ?? Promise.resolve())
      .then(() => lastLoad.current === id && setArts((x) => [...x]))
      .catch(() => undefined)
      .finally(() => lastLoad.current === id && setBodiesReady(true));
  }, []);

  // after an automatic reload for a new version (main.tsx, vite:preloadError): say why, once
  useEffect(() => {
    try {
      const at = Number(sessionStorage.getItem('hcm-updated-reload') ?? 0);
      if (at && Date.now() - at < 120_000 && sessionStorage.getItem('hcm-updated-shown') !== String(at)) {
        sessionStorage.setItem('hcm-updated-shown', String(at));
        toast('info', 'Trang vừa được cập nhật lên phiên bản mới – vui lòng thực hiện lại thao tác vừa rồi (ví dụ bấm Xuất báo cáo).');
      }
    } catch {
      /* private mode */
    }
  }, [toast]);

  // startup: local state first, then optional auto-collect (once per window, server-enforced)
  useEffect(() => {
    (async () => {
      try {
        const [s, src, rs, pf] = await Promise.all([api.getSettings(), api.getSources(), api.listRuns(), api.profiles()]);
        setProfiles(pf);
        setSettings(s);
        setSources(src);
        setRuns(rs);
        // open the most recent collection (its window fills Từ/Đến, see the effect on runId); no collection yet → default window
        const first = latestRun(rs);
        if (!first) applyPreset(s.reportWindow.defaultPreset, s);
        if (first) {
          setRunId(first.runId);
          await loadRun(first.runId);
        }
        if (api.mode === 'local' && s.startup.autoCollectLastCompletedWindow && navigator.onLine) {
          const w = lastCompletedWindow(new Date(), s.reportWindow.startClock, s.reportWindow.endClock);
          const r = await api.startRun({ from: w.from, to: w.to }, 'auto');
          if (r.runId) {
            toast('info', 'Tự động thu thập kỳ gần nhất…');
            setRunId(r.runId);
          }
        }
      } catch (e) {
        toast('err', `Không tải được dữ liệu: ${(e as Error).message}`);
      }
    })();
  }, [applyPreset, loadRun, toast]);

  // live progress
  useEffect(() => {
    if (!runId) return;
    loadRun(runId).catch(() => {});
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = api.subscribe(runId, (e) => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        loadRun(runId).catch(() => {});
      }, e.type === 'done' ? 0 : 700);
      if (e.type === 'done') api.listRuns().then(setRuns).catch(() => {});
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, [runId, loadRun]);

  // live (GitHub Pages) mode: show the last update and pick up newly published data – every 5 minutes, and every 15 s for
  // 4 minutes right after the collection server finished a run (scheduled 08:00 / 16:30, "Thu thập", a deploy)
  const [live, setLive] = useState<{ generatedAt: string; schedule: string } | null>(null);
  const viewedRunIdRef = useRef<string | null>(null);
  viewedRunIdRef.current = runId;
  const runsRef = useRef<RunInfo[]>([]);
  runsRef.current = runs;
  const liveAtRef = useRef<string | null>(null);
  const checkNewData = useCallback(async () => {
    if (api.mode !== 'live' || !api.meta) return false;
    api.refresh?.();
    const m = await api.meta().catch(() => null);
    if (!m) return false;
    // compare with a ref: a state updater is not run at once inside async code, so it cannot report the change
    const prevAt = liveAtRef.current;
    liveAtRef.current = m.generatedAt;
    setLive(m);
    if (!prevAt || prevAt === m.generatedAt) return false;
    const before = runsRef.current;
    const viewedLatest = !viewedRunIdRef.current || latestRun(before)?.runId === viewedRunIdRef.current;
    const rs = await api.listRuns();
    setRuns(rs);
    const newest = latestRun(rs);
    const isNew = newest && !before.some((r) => r.runId === newest.runId);
    if (newest && viewedLatest) {
      // the reviewer was on the most recent period: open the new / updated one
      shownWindowOf.current = null;
      setRunId(newest.runId);
      loadRun(newest.runId).catch(() => {});
      toast('info', isNew ? `Có kỳ mới ${runLabel(newest)} – đã mở` : `Đã cập nhật dữ liệu (${formatVn(m.generatedAt)})`);
    } else if (viewedRunIdRef.current) {
      // reviewing another period: keep it open, refresh its data, just say a new one is there
      loadRun(viewedRunIdRef.current).catch(() => {});
      if (isNew && newest) toast('info', `Có kỳ mới ${runLabel(newest)} – chọn ở "Lượt đã lưu" để xem`);
    }
    return true;
  }, [loadRun, toast]);
  useEffect(() => {
    if (api.mode !== 'live' || !api.meta) return;
    api
      .meta()
      .then((m) => {
        if (!m) return;
        liveAtRef.current ??= m.generatedAt;
        setLive(m);
      })
      .catch(() => {});
    const t = setInterval(() => void checkNewData(), 5 * 60_000);
    return () => clearInterval(t);
  }, [checkNewData]);

  const windowIso = useMemo(() => {
    try {
      return { from: localInputToVnIso(from), to: localInputToVnIso(to) };
    } catch {
      return null;
    }
  }, [from, to]);
  const windowErr = windowIso ? validateWindow(windowIso) : 'Ngày giờ không hợp lệ';

  // "Thu thập" reacts at once (the request to the server / GitHub takes 1–3 s from Vietnam)
  const [starting, setStarting] = useState(false);
  const collect = async () => {
    if (!windowIso || windowErr || starting) return;
    if (api.mode === 'live' && api.shared && !api.shared.session()) {
      setLoginOpen(true);
      return;
    }
    // reuse a period that is already published for exactly this window (no need to collect again)
    if (api.mode === 'live') {
      const same = runs.find((x) => Date.parse(x.window.from) === Date.parse(windowIso.from) && Date.parse(x.window.to) === Date.parse(windowIso.to) && !x.notes.some((n) => /đang diễn ra/.test(n)));
      if (same && !confirm('Khung giờ này đã có dữ liệu trên web. Thu thập lại? (Kỳ này được cập nhật: giữ các bài đã đọc, tải thêm bài còn thiếu, phân loại lại theo cài đặt hiện tại)')) {
        setRunId(same.runId);
        return;
      }
    }
    setStarting(true);
    try {
      // remember the custom window (local/demo only; on the web settings are SHARED with the server collector)
      if (preset === 'custom' && settings && api.mode !== 'live') {
        const s2 = await api.saveSettings({ ...settings, reportWindow: { ...settings.reportWindow, customFrom: windowIso.from, customTo: windowIso.to } }, 'Lưu khung giờ tùy chỉnh');
        setSettings(s2);
      }
      const r = await api.startRun(windowIso, 'manual');
      if (r.remote) {
        setRemote({ from: windowIso.from, to: windowIso.to, at: Date.now(), status: 'đã gửi yêu cầu', url: null });
        toast('info', `Đã gửi yêu cầu thu thập ${formatVn(windowIso.from)} → ${formatVn(windowIso.to)} lên máy chủ thu thập (thường 5–10 phút)`);
        return;
      }
      if (r.runId) {
        setRunId(r.runId);
        toast('info', `Bắt đầu thu thập ${formatVn(windowIso.from)} → ${formatVn(windowIso.to)}`);
      }
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const [saved, setSaved] = useState(0);
  const patch = async (articleId: string, p: Partial<ReviewDecision>) => {
    if (!run) return;
    // optimistic update: the control reacts immediately; reverted if the save fails
    const prev = reviews[articleId];
    setReviews((x) => ({ ...x, [articleId]: { ...(x[articleId] ?? { articleId, included: false, order: 0, updatedAt: '', changes: [] }), ...p } as ReviewDecision }));
    try {
      const r = await api.patchReview(run.runId, articleId, p);
      setReviews((x) => ({ ...x, [articleId]: r }));
      setSaved((n) => n + 1); // figures computed from the saved review (filter quality) refresh after the save, not before
      return true;
    } catch (e) {
      setReviews((x) => {
        const n = { ...x };
        if (prev) n[articleId] = prev;
        else delete n[articleId];
        return n;
      });
      toast('err', `Không lưu được: ${(e as Error).message}`);
      return false;
    }
  };

  // on-demand collection on GitHub Actions (web): follow the dispatched workflow run, then open the new period
  const [remote, setRemote] = useState<{ from: string; to: string; at: number; status: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!remote || !api.shared) return;
    let stop = false;
    const tick = async () => {
      try {
        const st = await api.shared!.collectStatus();
        const run = st.runs.find((x) => (x.kind ? x.kind === 'request' : x.event === 'workflow_dispatch') && Date.parse(x.createdAt) >= remote.at - 90_000);
        if (!run) return setRemote((r) => (r ? { ...r, status: 'đang chờ máy chủ nhận yêu cầu' } : r));
        if (run.status !== 'completed') {
          return setRemote((r) => (r ? { ...r, status: run.status === 'queued' ? 'đang xếp hàng' : 'đang thu thập', url: run.url } : r));
        }
        if (run.conclusion !== 'success') {
          toast('err', `Lượt thu thập không thành công (${run.conclusion}). Xem chi tiết: ${run.url}`);
          return setRemote(null);
        }
        api.refresh?.();
        const rs = await api.listRuns();
        setRuns(rs);
        const hit = rs.find((x) => Date.parse(x.window.from) === Date.parse(remote.from) && Date.parse(x.window.to) === Date.parse(remote.to));
        if (!hit) return setRemote((r) => (r ? { ...r, status: 'đang cập nhật trang' } : r)); // Pages CDN can lag ~1 min
        setRunId(hit.runId);
        setRemote(null);
        toast('ok', `Đã thu thập xong ${formatVn(remote.from)} → ${formatVn(remote.to)}`);
      } catch (e) {
        setRemote((r) => (r ? { ...r, status: `lỗi kiểm tra tiến độ: ${(e as Error).message}` } : r));
      }
    };
    const t = setInterval(() => !stop && tick(), 20_000);
    tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.at]);

  // collection server (web): hourly automatic mode + whatever run is busy right now (visible to everyone)
  const [server, setServer] = useState<ServerStatus | null>(null);
  const loadServer = useCallback(async () => {
    if (!api.shared) return;
    try {
      setServer(await api.shared.serverStatus());
    } catch {
      /* status strip is informative only */
    }
  }, []);
  // times changed in Settings › Thời gian: the "Tự động" strip shows them at once
  useEffect(() => {
    const on = () => void loadServer();
    window.addEventListener('schedule-changed', on);
    return () => window.removeEventListener('schedule-changed', on);
  }, [loadServer]);
  const serverRunning = (server?.running.length ?? 0) > 0;
  // the server just finished a run: its data reaches the site within a minute or two – look every 15 s for 4 minutes
  const wasRunning = useRef(false);
  useEffect(() => {
    const finished = wasRunning.current && !serverRunning;
    wasRunning.current = serverRunning;
    if (!finished) return;
    let tries = 0;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if ((await checkNewData()) || ++tries >= 16) return;
      setTimeout(() => void tick(), 15_000);
    };
    setTimeout(() => void tick(), 5_000);
    return () => {
      stop = true;
    };
  }, [serverRunning, checkNewData]);
  useEffect(() => {
    if (!api.shared) return;
    loadServer();
    const t = setInterval(loadServer, remote || serverRunning ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [loadServer, !!remote, serverRunning]);
  const busyRun: CollectRun | undefined = server?.running[0];
  // ticked fixed collection times of the active profile, e.g. "08:00, 16:30"
  const activeServerProf = server?.profiles.find((x) => x.id === profiles?.activeId);
  const autoTimes = slotsFor(activeServerProf?.scheduleTimes).filter((s) => activeServerProf?.schedule?.[s.id]).map((s) => s.at).join(', ');
  const toggleAuto = async (slot: ScheduleSlot, enabled: boolean) => {
    if (!api.shared) return;
    if (!api.shared.session()) return setLoginOpen(true);
    try {
      const prof = await api.shared.setSchedule(slot.id, enabled);
      setServer((s) => (s ? { ...s, profiles: s.profiles.map((x) => (x.id === prof.id ? prof : x)) } : s));
      toast('ok', `${enabled ? 'Đã BẬT' : 'Đã TẮT'} thu thập tự động lúc ${slot.at} cho cấu hình "${activeProfile?.name ?? ''}"`);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };

  // shared review (GitHub Pages): reviewer session + the team's votes for the current period
  const [reviewer, setReviewer] = useState(api.shared?.session() ?? null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [votes, setVotes] = useState<Record<string, Vote[]>>({});
  const reloadVotes = useCallback(() => {
    if (!api.shared || !runId || !api.shared.session()) return setVotes({});
    api.shared
      .votes(runId)
      .then(setVotes)
      .catch((e) => toast('err', (e as Error).message));
  }, [runId, toast]);
  // my own votes made on another device (20/11/2026): Liên quan / Không, lĩnh vực, tính chất, ghi chú show here too.
  // Runs whenever the votes OR the review arrive (whichever is last – the review load replaces the whole state).
  // Only fills what this browser has not set: a click made here a moment ago is never overwritten by a slower read.
  useEffect(() => {
    const me = api.shared?.session()?.name;
    if (!me || !Object.keys(votes).length) return;
    setReviews((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [aid, list] of Object.entries(votes)) {
        const own = list.find((x) => x.r === me);
        if (!own) continue;
        const cur = next[aid] ?? { articleId: aid, included: false, order: 0, updatedAt: '', changes: [] };
        const add: Partial<ReviewDecision> = {};
        if (cur.relevanceLabel == null && own.l) add.relevanceLabel = own.l;
        if (cur.primaryCategory == null && own.c) add.primaryCategory = own.c as ReviewDecision['primaryCategory'];
        if (cur.assessment == null && own.a) add.assessment = own.a as ReviewDecision['assessment'];
        if (!cur.reviewNote && own.n) add.reviewNote = own.n;
        if (Object.keys(add).length) {
          next[aid] = { ...cur, ...add };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [votes, reviews, reviewer]);
  useEffect(() => {
    reloadVotes();
    // other reviewers' votes: refresh every 2 minutes (Cloudflare KV listings are eventually consistent, ~60 s)
    const t = setInterval(reloadVotes, 120_000);
    return () => clearInterval(t);
  }, [reloadVotes, reviewer]);
  // the team's shared review (selection, Sẵn sàng/Loại, edits): other reviewers' changes every minute and when the tab gets focus
  useEffect(() => {
    if (!api.shared || !runId) return;
    const id = runId;
    const pull = () => {
      if (document.visibilityState === 'visible') api.review(id).then((rv) => setReviews((cur) => (runIdRef.current === id ? rv : cur))).catch(() => {});
    };
    if (reviewer) pull(); // right after login: this browser's earlier decisions are shared once (api.review), the team's appear
    const t = setInterval(pull, 60_000);
    window.addEventListener('focus', pull);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', pull);
    };
  }, [runId, reviewer]);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  /** in shared mode, labelling requires a reviewer session; the reviewer's own vote is shown immediately */
  const guardedPatch = async (articleId: string, p: Partial<ReviewDecision>) => {
    const reviewKeys = ['relevanceLabel', 'primaryCategory', 'assessment', 'reviewNote'];
    const s = api.shared?.session();
    // web: the review is the team's (selection, Sẵn sàng/Loại, edits too) → every change needs a reviewer session
    if (api.shared && !s) {
      setLoginOpen(true);
      return false;
    }
    const before = reviews[articleId];
    const ok = await patch(articleId, p);
    if (ok && s && reviewKeys.some((k) => k in p)) {
      const cur = { ...(before ?? {}), ...p } as Partial<ReviewDecision>;
      const own: Vote = { r: s.name, l: cur.relevanceLabel ?? null, c: (cur.primaryCategory as string | null) ?? null, a: cur.assessment ?? null, n: (cur.reviewNote ?? '').slice(0, 200), t: new Date().toISOString() };
      setVotes((v) => {
        const others = (v[articleId] ?? []).filter((x) => x.r !== s.name);
        const empty = !own.l && !own.c && !own.a && !own.n;
        return { ...v, [articleId]: empty ? others : [...others, own] };
      });
    }
    return !!ok;
  };

  const merge = async (secondaryId: string, targetId: string) => {
    const ps = mergePatches(secondaryId, targetId, reviews);
    if (!ps.length) return toast('err', 'Không thể gộp: hai bài đã cùng một tin hoặc gộp vào chính nó');
    const ok = await Promise.all(ps.map((p) => patch(p.articleId, p.patch))); // one save on the web
    if (ok.every(Boolean)) toast('ok', 'Đã gộp nguồn vào tin');
  };
  const split = (secondaryId: string) => patch(secondaryId, { groupId: null });

  const artById = useMemo(() => new Map(arts.map((a) => [a.id, a])), [arts]);
  const candByArticle = useMemo(() => new Map(cands.filter((c) => c.articleId).map((c) => [c.articleId!, c])), [cands]);
  const inReviewQueue = (a: Article) => {
    const c = candByArticle.get(a.id);
    return !!c && (['date_unverified', 'parsed_partial'].includes(c.state) || (c.state === 'ready_for_review' && !!c.reasonCode));
  };
  // the editor can move a story from Cần kiểm tra to Bài sẵn sàng (and back)
  const readyPool = arts.filter((a) => (candByArticle.get(a.id)?.state === 'ready_for_review' && !candByArticle.get(a.id)?.reasonCode) || (inReviewQueue(a) && !!reviews[a.id]?.promotedToReady));
  const reviewPool = arts.filter((a) => inReviewQueue(a) && !reviews[a.id]?.promotedToReady);
  // stories the editor removed ("Loại") leave the lists; each tab lists its own under "Đã loại" to restore
  const isOut = (a: Article) => !!reviews[a.id]?.excludedByEditor;
  const ready = readyPool.filter((a) => !isOut(a));
  const reviewQueue = reviewPool.filter((a) => !isOut(a));
  const selected = Object.values(reviews).filter((r) => r.included).length;
  // "Hỏi nhanh": stories nobody judged yet that the filter is least sure about
  // the filter is replayed ONCE per period (when the page is idle), not after every answer: answering only removes stories
  // A period asks ONE round of at most 8 stories, fixed when computed: answering them does not bring the next 8 (the card
  // would never close). When the round is done the card says so for a few seconds, then hides (user, 17/11/2026).
  const [uncertain, setUncertain] = useState<UncertainStory[] | null>(null);
  const askSeq = useRef(0);
  const [askSkipped, setAskSkipped] = useState<Set<string>>(new Set());
  const [askHidden, setAskHidden] = useState(false);
  const judgedRef = useRef<(id: string) => boolean>(() => false);
  judgedRef.current = (id: string) => { const r = reviews[id]; return !!(r?.relevanceLabel || r?.included || r?.excludedByEditor || r?.promotedToReady || r?.groupId || votes[id]?.length); };
  useEffect(() => {
    setUncertain(null);
    setAskSkipped(new Set());
    setAskHidden(false);
    if (!settings || !arts.length || !bodiesReady) return;
    let alive = true;
    const pick = (list: UncertainStory[]) => alive && setUncertain(list.filter((x) => !judgedRef.current(x.article.id)).slice(0, 8));
    const timer = setTimeout(() => {
      const w = askWorker();
      if (!w) {
        // no worker (old browser): same work on the page
        try {
          pick(uncertainStories(arts, settings, new Set(), 40));
        } catch {
          if (alive) setUncertain([]);
        }
        return;
      }
      const id = ++askSeq.current;
      const byId = new Map(arts.map((a) => [a.id, a]));
      const onMsg = (e: MessageEvent<AskReply>) => {
        if (e.data.id !== id) return;
        w.removeEventListener('message', onMsg);
        if (!e.data.ok) return alive && setUncertain([]);
        pick(e.data.items.flatMap((x) => (byId.has(x.articleId) ? [{ article: byId.get(x.articleId)!, status: x.status as UncertainStory['status'], why: x.why, weight: x.weight }] : [])));
      };
      w.addEventListener('message', onMsg);
      void (api.learnedModel?.() ?? Promise.resolve(null)).then((model) => alive && w.postMessage({ id, arts, settings, model } satisfies AskRequest));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [arts, settings, bodiesReady]);
  const askable = useMemo(() => (uncertain ?? []).filter((x) => !judgedRef.current(x.article.id) && !askSkipped.has(x.article.id)), [uncertain, reviews, votes, askSkipped]);
  // nothing (left) to ask: show "done" briefly, then hide the card
  const askDone = uncertain !== null && askable.length === 0;
  useEffect(() => {
    if (!askDone) return;
    const t = setTimeout(() => setAskHidden(true), 4000);
    return () => clearTimeout(t);
  }, [askDone]);
  const [asking, setAsking] = useState<UncertainStory[] | null>(null);
  const startAsk = () => {
    if (api.shared && !api.shared.session()) return setLoginOpen(true);
    setAsking(askable);
  };
  const answerAsk = (x: UncertainStory, relevant: boolean, reason: ExcludeReason = 'off_topic') => {
    if (api.shared && !api.shared.session()) return (setLoginOpen(true), false);
    // ✗ takes a story out of Sẵn sàng / Cần kiểm tra (as "Loại") WITH the reason; ✓ on an excluded story records the miss.
    // "Trùng tin" / "Không quan trọng": in scope for the filter, only not wanted → no "không liên quan" label (the nightly
    // suggestions must not learn to drop such stories). Not awaited: the next story shows at once.
    if (relevant) return void guardedPatch(x.article.id, { relevanceLabel: 'relevant' }), true;
    const inScope = reason === 'duplicate' || reason === 'minor';
    const out = x.status !== 'irrelevant' ? { included: false, excludedByEditor: true } : {};
    void guardedPatch(x.article.id, { ...(inScope ? {} : { relevanceLabel: 'irrelevant' as const }), ...out, excludeReason: reason });
    return true;
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center gap-1.5 px-3 py-2 sm:gap-3 sm:px-4">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" aria-hidden="true" className="h-9 w-9 shrink-0 rounded-xl shadow-sm" data-testid="app-logo" />
          <h1 className="hidden max-w-[22rem] truncate text-[15px] font-bold text-navy-800 md:block" data-testid="app-subtitle" title={settings?.report.subtitle ?? ''}>
            {settings?.report.subtitle || 'Điểm tin báo chí'}
          </h1>
          {profiles && (
            <div className="relative min-w-0 shrink sm:ml-1 sm:shrink-0" title="Địa bàn (cấu hình) – tạo mới/sao chép trong Cài đặt">
              <MapPin className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-teal-600" />
              <select className="w-full max-w-[9rem] cursor-pointer appearance-none truncate rounded-full sm:max-w-none border border-slate-200 bg-slate-50 py-1.5 pl-7 pr-7 text-sm font-semibold text-slate-800 transition hover:border-teal-400" aria-label="Cấu hình (profile)" value={profiles.activeId} onChange={(e) => switchProfile(e.target.value)}>
                {profiles.profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            </div>
          )}
          {/* Hỏi nhanh in the header (user, 18/11/2026): working / N to ask / done – nothing below moves when it changes */}
          {run && arts.length > 0 && !(askDone && askHidden) && (
            <span className="shrink-0" data-testid="quick-ask" data-state={uncertain === null ? 'loading' : askable.length ? 'ready' : 'done'}>
              {uncertain === null ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-500" title="Hỏi nhanh: đang tìm bài máy chưa chắc chắn (chạy nền, không ảnh hưởng thao tác)">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> <span className="hidden sm:inline">Hỏi nhanh…</span>
                </span>
              ) : askable.length ? (
                <button
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 shadow-sm transition hover:bg-amber-100"
                  onClick={startAsk}
                  title={`Hỏi nhanh: ${askable.length} bài máy chưa chắc chắn – chấm giúp vài giây để bộ lọc chính xác hơn mỗi ngày`}
                  aria-label={`Bắt đầu Hỏi nhanh (${askable.length} bài)`}
                >
                  <HelpCircle className="h-4 w-4 text-amber-500" />
                  <span className="hidden sm:inline">Hỏi nhanh</span>
                  <span className="min-w-[1.25rem] rounded-full bg-amber-500 px-1.5 text-center text-[11px] font-bold tabular-nums text-white">{askable.length}</span>
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-2.5 py-1.5 text-xs text-green-800" title="Hỏi nhanh">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  <span className="hidden sm:inline">{uncertain?.length ? 'Đã chấm xong – cảm ơn!' : 'Không có bài cần hỏi'}</span>
                  <span className="sr-only sm:hidden">{uncertain?.length ? 'đã chấm xong' : 'không có bài cần hỏi'}</span>
                </span>
              )}
            </span>
          )}
          <span className="flex-1" />
          {/* one status dot instead of banners: live / demo / online, details on hover */}
          <span className="inline-flex shrink-0 items-center gap-2 rounded-full px-1 py-1 text-xs text-slate-500 sm:px-2" title={api.mode === 'live' ? `DỮ LIỆU THẬT – ${autoTimes ? `tự động thu thập lúc ${autoTimes}` : 'tự động thu thập đang TẮT (chỉ thu thập khi bấm Thu thập)'}${live ? ` · cập nhật lúc ${formatVn(live.generatedAt)}` : ''}` : api.mode === 'demo' ? 'BẢN DEMO – dữ liệu mẫu thử, không phải tin thật' : online ? 'Có Internet' : 'Ngoại tuyến – xem/duyệt/xuất dữ liệu đã lưu'} data-testid="live-banner">
            <span className={`h-2.5 w-2.5 rounded-full ${!online ? 'bg-slate-400' : api.mode === 'demo' ? 'bg-amber-500' : 'dot-live bg-green-500'}`} />
            <span className="hidden lg:inline">{api.mode === 'live' && live ? <>Cập nhật <b className="font-semibold text-slate-700">{hhmm(live.generatedAt)}</b></> : !online ? 'Ngoại tuyến' : api.mode === 'demo' ? 'Bản demo' : 'Trực tuyến'}</span>
            <span className="sr-only">{api.mode === 'live' ? `DỮ LIỆU THẬT – ${autoTimes ? `tự động thu thập lúc ${autoTimes}` : 'tự động thu thập đang TẮT (chỉ thu thập khi bấm Thu thập)'}${live ? ` · cập nhật lúc ${formatVn(live.generatedAt)}` : ''}` : api.mode === 'demo' ? 'BẢN DEMO – dữ liệu mẫu thử, không phải tin thật' : online ? 'Có Internet' : 'Ngoại tuyến – xem/duyệt/xuất dữ liệu đã lưu'}</span>
          </span>
          {api.shared &&
            (reviewer ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 py-0.5 pl-0.5 pr-1 text-sm text-teal-900" data-testid="reviewer-chip" title={`Người duyệt: ${reviewer.name}`}>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-600 text-xs font-bold text-white">{initials(reviewer.name)}</span>
                <span className="hidden max-w-[10rem] truncate font-medium sm:inline">{reviewer.name}</span>
                <button className="rounded-full p-1 text-teal-700 transition hover:bg-teal-100" onClick={() => (api.shared!.logout(), setReviewer(null))} aria-label="Đăng xuất" title="Đăng xuất">
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <button className="btn-teal shrink-0 rounded-full" onClick={() => setLoginOpen(true)} aria-label="Đăng nhập duyệt tin" title="Đăng nhập để duyệt tin và thu thập">
                <LogIn className="h-4 w-4" /> <span className="hidden sm:inline">Đăng nhập</span>
              </button>
            ))}
          <button className="btn-ghost hidden shrink-0 rounded-full px-2.5 sm:inline-flex" onClick={() => setQrOpen(true)} aria-label="Tạo mã QR" title="Tạo mã QR từ một địa chỉ bất kỳ (để chèn vào slide)" data-testid="qr-open">
            <QrCode className="h-4 w-4" /> <span className="hidden xl:inline">QR</span>
          </button>
          <button className="btn-ghost shrink-0 rounded-full px-2.5" onClick={() => setSettingsOpen(true)} aria-label="Cài đặt" title="Cài đặt">
            <Cog className="h-4 w-4" /> <span className="hidden xl:inline">Cài đặt</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-4 px-3 py-4 sm:px-4">
        {api.mode === 'live' && !api.shared ? (
          <section className="card flex flex-wrap items-center gap-3 p-3" data-testid="live-periods">
            <RunPicker runs={runs} runId={runId} onPick={pickRun} />
            {run?.notes.some((x) => /đang diễn ra/.test(x)) && <span className="chip border-amber-300 bg-amber-50 text-amber-800">Kỳ chưa kết thúc – số liệu còn thay đổi</span>}
          </section>
        ) : (
        <section className="card animate-in relative z-20 p-3" data-testid="window-card">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="inline-flex rounded-full bg-slate-100 p-1" role="group" aria-label="Khung giờ">
              {([['last_completed', 'Kỳ gần nhất'], ['today', 'Hôm nay'], ['yesterday', 'Hôm qua'], ['custom', 'Tùy chỉnh']] as const).map(([k, l]) => (
                <button key={k} className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${preset === k ? 'bg-navy-700 text-white shadow-sm' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`} onClick={() => settings && (k === 'custom' ? (setPreset('custom'), setEditWindow(true)) : (setEditWindow(false), k === 'last_completed' ? pickLatest(settings) : applyPreset(k, settings)))}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
            <button
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold tabular-nums transition ${windowErr ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-200 bg-white text-slate-800 hover:border-teal-400'}`}
              onClick={() => setEditWindow((v) => !v)}
              aria-expanded={editWindow}
              title="Bấm để chọn ngày giờ (giờ Việt Nam; giờ kết thúc không tính)"
              data-testid="window-range"
            >
              <CalendarClock className="h-4 w-4 text-teal-600" />
              {windowIso ? windowText(windowIso.from, windowIso.to) : '—'}
              <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition ${editWindow ? 'rotate-180' : ''}`} />
            </button>
            {run?.active ? (
              <button className="btn-danger rounded-full" onClick={() => api.cancel(run.runId)}>
                <Square className="h-4 w-4" /> Dừng
              </button>
            ) : (
              <button
                className="btn-primary rounded-full px-4 shadow-sm"
                disabled={starting || !!windowErr || !online || api.mode === 'demo' || (api.mode === 'live' && (!api.shared || !!remote || !!busyRun))}
                onClick={collect}
                title={
                  api.mode === 'live'
                    ? busyRun
                      ? 'Máy chủ đang chạy một lượt thu thập khác – nút mở lại khi lượt đó xong'
                      : 'Thu thập trên máy chủ (5–10 phút), tối đa 72 giờ mỗi lần; cần đăng nhập người duyệt'
                    : api.mode === 'demo'
                      ? 'Bản demo không thu thập báo thật'
                      : ''
                }
              >
                {starting ? <><RefreshCw className="h-4 w-4 animate-spin" /> Đang gửi…</> : <><Play className="h-4 w-4" /> Thu thập</>}
              </button>
            )}
            </div>
            {api.shared && server && (
              <div className="w-full border-t border-slate-100 pt-2 lg:ml-auto lg:w-auto lg:border-0 lg:pt-0">
                <ServerStrip server={server} profileId={profiles?.activeId ?? 'hcm'} remote={!!remote} onToggle={toggleAuto} onEditTimes={() => { setReopenSection('time'); setSettingsOpen(true); }} />
              </div>
            )}
          </div>
          {/* exact date/time: shown on demand */}
          <div className={editWindow ? 'animate-in mt-3 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-3' : 'hidden'}>
            <DateTime24 label="Từ" value={from} onChange={(v) => (setFrom(v), setPreset('custom'))} />
            <DateTime24 label="Đến" value={to} onChange={(v) => (setTo(v), setPreset('custom'))} />
            {windowErr && <span className="pb-2 text-xs text-red-600">{windowErr}</span>}
          </div>
        </section>
        )}


        {remote && (
          <section className="card animate-in flex flex-wrap items-center gap-3 border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" data-testid="remote-collect">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>
              Đang thu thập trên máy chủ: <b>{windowText(remote.from, remote.to)}</b> · {remote.status}
            </span>
            <span className="text-xs text-blue-700">thường 5–10 phút, trang tự mở kết quả</span>
          </section>
        )}

        {asking && <QuickAsk items={asking} onAnswer={answerAsk} onSkip={(x) => setAskSkipped((s) => new Set(s).add(x.article.id))} onClose={() => setAsking(null)} />}

        {/* sources of the viewed period: one tile per publisher */}
        {run && <SourceStrip run={run} arts={arts} ready={ready} sources={sources} onOpen={() => setCoverageOpen(true)}
          picker={runs.length > 0 ? <RunPicker runs={runs} runId={runId} onPick={pickRun} onDelete={canDeleteRuns ? removeRun : undefined} deleteHint={api.deleteRun && !canDeleteRuns ? (canArchiveRuns ? `${ADMIN_HINT} xoá được lượt (bạn vẫn lưu trữ được)` : 'Đăng nhập người duyệt để xoá / lưu trữ') : undefined} onArchive={api.archiveRun && canArchiveRuns ? archiveRun : undefined} /> : null} canTest={() => (api.shared && !api.shared.session() ? (setLoginOpen(true), false) : true)} />}

        {!run ? (
          <div className="card animate-in flex flex-col items-center gap-2 p-10 text-center text-slate-500">
            <Inbox className="h-10 w-10 text-slate-300" />
            <p className="text-base font-medium text-slate-700">Chưa có dữ liệu</p>
            <p className="text-sm">Chọn khung giờ rồi bấm <b>Thu thập</b>.</p>
          </div>
        ) : (
          <>
            <nav className="grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-100/80 p-1 sm:flex sm:flex-wrap" aria-label="Các mục">
              {(
                [
                  ['articles', 'Bài sẵn sàng', ready.length, CheckCircle2, 'bg-green-600 text-white', 'text-green-700', 'Sẵn sàng'],
                  ['review', 'Cần kiểm tra', reviewQueue.length, AlertTriangle, reviewQueue.length ? 'bg-amber-500 text-white' : 'bg-slate-300 text-slate-700', 'text-amber-600', 'Kiểm tra'],
                  ['export', 'Xuất báo cáo', selected, FileText, selected ? 'bg-navy-700 text-white' : 'bg-slate-300 text-slate-700', 'text-navy-700', 'Xuất'],
                ] as const
              ).map(([k, l, n, Icon, badge, ic, short]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  aria-current={tab === k ? 'page' : undefined}
                  aria-label={n !== null ? `${l} (${n})` : l}
                  className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 text-sm font-semibold transition sm:min-h-0 sm:justify-start sm:gap-2 sm:px-4 ${tab === k ? 'bg-navy-700 text-white shadow-md' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}
                >
                  <Icon className={`hidden h-4 w-4 sm:block ${tab === k ? 'text-white' : ic}`} />
                  <span className="short-label" data-short={short}>{l}</span>
                  {n !== null && (
                    <>
                      <span className="sr-only"> (</span>
                      <span className={`min-w-[1.5rem] rounded-full px-1.5 py-0.5 text-center text-xs font-bold tabular-nums ${tab === k ? 'bg-white text-navy-800' : badge}`}>{n}</span>
                      <span className="sr-only">)</span>
                    </>
                  )}
                </button>
              ))}
            </nav>
            {tab === 'articles' && <ArticleList list={ready} excluded={readyPool.filter(isOut)} reviews={reviews} cands={candByArticle} settings={settings} onInspect={setInspect} onPatch={guardedPatch} votes={votes} />}
            {tab === 'review' && <ArticleList list={reviewQueue} excluded={reviewPool.filter(isOut)} reviews={reviews} cands={candByArticle} settings={settings} onInspect={setInspect} onPatch={guardedPatch} reviewMode votes={votes} />}
            {tab === 'export' && settings && <ExportPanel run={run} arts={artById} reviews={reviews} settings={settings} onPatch={patch} onInspect={setInspect} onMerge={merge} onSplit={split} />}
          </>
        )}
      </main>
      {coverageOpen && run && (
        <CoverageDrawer onClose={() => setCoverageOpen(false)} title={`Độ phủ & nguồn · ${runLabel(run)}`}>
          <Coverage ledger={<Ledger cands={cands} sources={sources} onInspect={(aid) => setInspect(aid)} reviews={reviews} onPatch={patch} />} run={run} cands={cands} reviewsKey={`${saved}`} onOpenSettings={() => setSettingsOpen(true)} onRetry={async (body) => { try { const r = await api.retry(run.runId, body); setRunId(r.runId); toast('info', 'Đang chạy lại…'); } catch (e) { toast('err', (e as Error).message); } }} />
        </CoverageDrawer>
      )}
      {inspect && artById.get(inspect) && settings && (
        <Inspector a={artById.get(inspect)!} c={candByArticle.get(inspect)} r={reviews[inspect]} settings={settings} onClose={() => setInspect(null)} onPatch={(p) => guardedPatch(inspect, p)}
          arts={artById} reviews={reviews} onMerge={merge} onSplit={split} onOpen={setInspect} />
      )}
      {qrOpen && <QrDialog onClose={() => setQrOpen(false)} />}
      {loginOpen && api.shared && (
        <ReviewerLogin
          onClose={() => setLoginOpen(false)}
          onLogin={async (user, password) => {
            const me = await api.shared!.login(user, password);
            setReviewer(api.shared!.session());
            setLoginOpen(false);
            toast('ok', `Xin chào ${me.name}`);
          }}
        />
      )}
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setReopenSection(null); }}
        initialSection={(reopenSection ?? undefined) as Parameters<typeof SettingsDrawer>[0]['initialSection']}
        onSaved={(s, src) => {
          setSettings(s);
          setSources(src);
        }}
      />
    </div>
  );
}

/** Same-event sources of one story: merged secondaries (split), clustering suggestions and manual pick (merge). */
function MergePanel({ primaryId, arts, reviews, onMerge, onSplit }: { primaryId: string; arts: Map<string, Article>; reviews: Record<string, ReviewDecision>; onMerge: (secondaryId: string, primaryId: string) => void; onSplit: (secondaryId: string) => void }) {
  const [pick, setPick] = useState('');
  const primary = arts.get(primaryId);
  if (!primary) return null;
  const merged = secondariesOf(primaryId, reviews).map((id) => arts.get(id)).filter((x): x is Article => !!x);
  const taken = new Set([primaryId, ...merged.map((m) => m.id)]);
  const available = [...arts.values()].filter((a) => !taken.has(a.id) && !reviews[a.id]?.groupId && secondariesOf(a.id, reviews).length === 0);
  const suggested = primary.duplicateGroupId ? available.filter((a) => a.duplicateGroupId === primary.duplicateGroupId) : [];
  const others = available.filter((a) => !suggested.includes(a)).sort((x, y) => x.title.localeCompare(y.title, 'vi'));
  return (
    <div className="rounded border border-purple-200 bg-purple-50/40 p-2 text-xs" data-testid={`merge-${primaryId}`}>
      <div className="mb-1 font-semibold text-purple-900">Nguồn cùng sự kiện ({merged.length + 1} bài)</div>
      <ul className="space-y-0.5">
        <li>
          <b>{primary.sourceName}</b> – {primary.title} <span className="text-slate-500">(bài chính{primary.publishedAt ? `, ${formatVn(primary.publishedAt)}` : ''})</span>
        </li>
        {merged.map((m) => (
          <li key={m.id} className="flex items-center gap-1">
            <span className="flex-1">
              <b>{m.sourceName}</b> – {m.title}
              {m.publishedAt ? <span className="text-slate-500"> ({formatVn(m.publishedAt)})</span> : <span className="text-amber-700"> (chưa rõ giờ đăng)</span>}
            </span>
            <button className="btn-ghost btn-xs" onClick={() => onSplit(m.id)}>Tách ra</button>
          </li>
        ))}
      </ul>
      {suggested.length > 0 && (
        <div className="mt-1">
          <span className="text-purple-900">Gợi ý cùng sự kiện (tiêu đề tương tự):</span>
          {suggested.map((s) => (
            <div key={s.id} className="flex items-center gap-1">
              <span className="flex-1"><b>{s.sourceName}</b> – {s.title}</span>
              <button className="btn-ghost btn-xs" onClick={() => onMerge(s.id, primaryId)}>Gộp vào tin này</button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1 flex gap-1">
        <select className="input py-1 text-xs" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Chọn bài để gộp nguồn">
          <option value="">Gộp thêm bài khác (cùng sự kiện)…</option>
          {others.map((o) => <option key={o.id} value={o.id}>{o.sourceName}: {o.title.slice(0, 90)}</option>)}
        </select>
        <button className="btn-ghost btn-xs" disabled={!pick} onClick={() => (onMerge(pick, primaryId), setPick(''))}>Gộp</button>
      </div>
    </div>
  );
}

/** Per-publisher summary of the viewed period (its last run): status, links found, extracted and ready stories, warnings. */
/** publisher home page from the source configuration (http/https only) */
function homeOf(sources: Source[], id: string): string | null {
  const u = sources.find((x) => x.id === id)?.baseUrl;
  try {
    return u && /^https?:$/.test(new URL(u).protocol) ? new URL(u).origin + '/' : null;
  } catch {
    return null;
  }
}

/** "Kiểm tra nhanh" result of one source, now (not the period's status, which stays as collected) */
interface QuickCheck { busy?: boolean; at?: string; tone?: 'ok' | 'warn' | 'bad'; text?: string; detail?: string }
function summarizeProbe(r: any): QuickCheck {
  const routes: Array<{ method: string; url: string; status: string; error?: string; found: number }> = r?.stats?.routes ?? [];
  const okR = routes.filter((x) => x.status !== 'error');
  const bad = routes.filter((x) => x.status === 'error');
  const sample = r?.samples?.[0];
  const sampleOk = !!sample && !sample.error && sample.completeness !== 'failed';
  const links = r?.stats?.candidates ?? 0;
  const at = new Date().toISOString();
  const badText = bad.map((x) => `${x.method === 'rss' ? 'RSS' : x.method === 'sitemap' ? 'Sitemap' : 'Chuyên mục'} ${x.url.replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/'}: ${x.error ?? 'lỗi'}`);
  const sampleText = sample ? (sampleOk ? `bài mẫu đọc được (${sample.paragraphs} đoạn)` : `bài mẫu lỗi: ${sample.error ?? 'không bóc tách được'}`) : 'chưa có bài mẫu';
  const detail = [`${links} link mới`, sampleText, ...badText].join('\n');
  if (!okR.length || !links) return { at, tone: 'bad', text: 'không lấy được tin', detail };
  if (bad.length || (sample && !sampleOk)) return { at, tone: 'warn', text: `${okR.length}/${routes.length} đường OK`, detail };
  return { at, tone: 'ok', text: `hoạt động · ${links} link`, detail };
}
/** right-side drawer like Cài đặt; ESC / X / the backdrop close it */
function CoverageDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" role="dialog" aria-modal="true" aria-label="Độ phủ & nguồn" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex h-full w-full max-w-[1100px] flex-col bg-slate-50 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <BarChart3 className="h-5 w-5 text-teal-600" />
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold text-navy-800">{title}</h2>
          <button className="btn-ghost rounded-full px-2" onClick={onClose} aria-label="Đóng độ phủ" title="Đóng (Esc)"><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function SourceStrip({ run, arts, ready, sources, onOpen, canTest, picker }: { run: RunInfo; arts: Article[]; ready: Article[]; sources: Source[]; onOpen: () => void; canTest: () => boolean; picker?: ReactNode }) {
  const [checks, setChecks] = useState<Record<string, QuickCheck>>({});
  const quickCheck = async (id: string) => {
    const src = sources.find((x) => x.id === id);
    if (!src || !canTest()) return;
    setChecks((c) => ({ ...c, [id]: { busy: true } }));
    try {
      const r = await api.testSource(src, { quick: true });
      setChecks((c) => ({ ...c, [id]: summarizeProbe(r) }));
    } catch (e) {
      setChecks((c) => ({ ...c, [id]: { at: new Date().toISOString(), tone: 'bad', text: 'lỗi kiểm tra', detail: (e as Error).message } }));
    }
  };
  const live = run.notes?.some((x) => x.startsWith('Kỳ đang diễn ra'));
  const extracted = new Map<string, number>();
  for (const a of arts) extracted.set(a.sourceId, (extracted.get(a.sourceId) ?? 0) + 1);
  const readyBy = new Map<string, number>();
  for (const a of ready) readyBy.set(a.sourceId, (readyBy.get(a.sourceId) ?? 0) + 1);
  const DOT: Record<string, string> = { ok: 'bg-green-500', partial: 'bg-amber-500', failed: 'bg-red-500', running: 'bg-blue-500 animate-pulse', pending: 'bg-slate-300', cancelled: 'bg-slate-400' };
  const shown = run.sources.filter((s) => s.status !== 'skipped_disabled');
  const off = run.sources.length - shown.length;
  return (
    <section className="card animate-in relative z-10 p-3" data-testid="source-strip">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-navy-800">Nguồn tin trong kỳ</h2>
        {picker && <div className="w-full sm:w-auto">{picker}</div>}
        <span className="text-xs text-slate-400" data-testid="source-strip-caption" title={`${formatVn(run.window.from)} → ${formatVn(run.window.to)}${run.finishedAt ? ` · lượt cuối ${formatVn(run.finishedAt)}` : ''}`}>
          {run.finishedAt ? `cập nhật ${formatVn(run.finishedAt)}` : ''}
        </span>
        {run.active ? (
          <span className="chip border-blue-300 bg-blue-50 text-blue-800"><RefreshCw className="h-3 w-3 animate-spin" /> đang chạy</span>
        ) : live ? (
          <span className="chip border-sky-300 bg-sky-50 text-sky-800">đang diễn ra · cập nhật mỗi giờ</span>
        ) : api.mode === 'live' ? (
          <span className="chip border-slate-300 bg-slate-50 text-slate-600">kỳ đã chốt</span>
        ) : null}
        <button className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800 transition hover:bg-teal-100" onClick={onOpen} data-testid="open-coverage" title="Độ phủ từng báo, chất lượng bộ lọc, mọi link đã phát hiện và lý do bị loại">
          <BarChart3 className="h-3.5 w-3.5" /> Độ phủ & nguồn <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {shown.map((s) => {
          const warn = [
            s.adapter?.status === 'degraded' && { t: 'bóc tách suy giảm', c: 'text-red-700', d: s.adapter.reasons.join('; ') },
            s.limitReached && { t: 'chạm giới hạn tải', c: 'text-amber-700', d: 'Còn link chưa tải trong lượt này (Cài đặt › Hiệu năng)' },
            s.status === 'failed' && { t: 'lỗi', c: 'text-red-700', d: s.error ?? '' },
          ].filter(Boolean) as Array<{ t: string; c: string; d: string }>;
          const home = homeOf(sources, s.sourceId);
          return (
            <div
              key={s.sourceId}
              className={`lift flex flex-col rounded-lg border bg-white ${warn.length ? 'border-amber-200' : 'border-slate-200'}`}
              data-testid={`source-tile-${s.sourceId}`}
            >
              {/* the publisher's name opens its home page (new tab); the rest of the tile opens the coverage details */}
              <div className="flex items-center gap-1.5 px-2.5 pt-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.status] ?? 'bg-slate-300'}`} />
                {home ? (
                  <a href={home} target="_blank" rel="noopener noreferrer" className="truncate text-sm font-semibold text-slate-800 hover:text-blue-700 hover:underline" title={`Mở trang chủ ${s.sourceName} (${home})`} data-testid={`source-home-${s.sourceId}`}>
                    {s.sourceName}
                  </a>
                ) : (
                  <span className="truncate text-sm font-semibold text-slate-800">{s.sourceName}</span>
                )}
                {sources.some((x) => x.id === s.sourceId) && (
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-teal-50 hover:text-teal-700 disabled:opacity-60"
                    onClick={() => void quickCheck(s.sourceId)}
                    disabled={checks[s.sourceId]?.busy}
                    title={`Kiểm tra nhanh ${s.sourceName} ngay bây giờ (đọc trang mục lục và 1 bài mẫu, khoảng 5–20 giây)`}
                    aria-label={`Kiểm tra nhanh ${s.sourceName}`}
                    data-testid={`source-check-${s.sourceId}`}
                  >
                    {checks[s.sourceId]?.busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              <button
                onClick={onOpen}
                title={[`${s.sourceName}: ${SRC_STATUS[s.status] ?? s.status}`, ...warn.map((w) => `${w.t}${w.d ? ` – ${w.d}` : ''}`), 'Bấm để xem chi tiết độ phủ'].join('\n')}
                className="flex-1 px-2.5 pb-2 text-left"
              >
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-lg font-bold tabular-nums text-slate-800">{readyBy.get(s.sourceId) ?? 0}</span>
                <span className="text-[11px] text-slate-500">sẵn sàng</span>
              </div>
              <div className="text-[11px] tabular-nums text-slate-500">{s.candidates} link · {extracted.get(s.sourceId) ?? 0} bài đã đọc</div>
              <div className="mt-0.5 min-h-[1rem] text-[11px] font-medium">
                {warn.length ? (
                  warn.map((w) => <span key={w.t} className={`mr-1.5 ${w.c}`}>⚠ {w.t}</span>)
                ) : s.status === 'ok' ? (
                  <span className="text-green-700">✓ OK</span>
                ) : (
                  <span className={s.status === 'partial' ? 'text-amber-700' : 'text-slate-600'}>{SRC_STATUS[s.status] ?? s.status}</span>
                )}
              </div>
              {(() => {
                const q = checks[s.sourceId];
                if (!q || q.busy) return q?.busy ? <div className="mt-1 border-t border-slate-100 pt-1 text-[11px] text-slate-500" data-testid={`source-check-result-${s.sourceId}`}>Đang kiểm tra…</div> : null;
                const tone = q.tone === 'ok' ? 'text-green-700' : q.tone === 'warn' ? 'text-amber-700' : 'text-red-700';
                return (
                  <div className={`mt-1 border-t border-slate-100 pt-1 text-[11px] font-medium ${tone}`} title={q.detail} data-testid={`source-check-result-${s.sourceId}`}>
                    {q.tone === 'ok' ? '✓' : q.tone === 'warn' ? '⚠' : '✗'} Bây giờ ({hhmm(q.at!)}): {q.text}
                    {q.tone !== 'ok' && q.detail && <div className="mt-0.5 whitespace-pre-line break-words font-normal text-slate-500">{q.detail.split('\n').slice(1, 4).join('\n')}</div>}
                  </div>
                );
              })()}
              </button>
            </div>
          );
        })}
      </div>
      {off > 0 && <p className="mt-1.5 text-[11px] text-slate-500">{off} nguồn đang tắt (Cài đặt › Nguồn tin).</p>}
    </section>
  );
}

/**
 * Date + time in 24-hour form on every computer (the browser's datetime-local follows the OS locale, e.g. AM/PM).
 * value / onChange: "YYYY-MM-DDTHH:mm" (local Vietnam time), like datetime-local.
 */
function DateTime24({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [d = '', hm = '00:00'] = value.split('T');
  const [h = '00', m = '00'] = hm.slice(0, 5).split(':');
  const set = (nd: string, nh: string, nm: string) => nd && onChange(`${nd}T${nh}:${nm}`);
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    // "Từ ngày [date]  Giờ [hh]:[mm]"
    <fieldset role="group" aria-label={label} className="flex items-end gap-2">
      <label className="min-w-0 flex-1 sm:flex-none">
        <span className="label">{label} ngày</span>
        <input type="date" className="input min-w-0 sm:w-40" aria-label={`${label} – ngày`} value={d} onChange={(e) => set(e.target.value, h, m)} />
      </label>
      <div>
      <span className="label">Giờ</span>
      <div className="flex items-center gap-1">
        <select className="input w-16 px-1" aria-label={`${label} – giờ`} value={h} onChange={(e) => set(d, e.target.value, m)}>
          {Array.from({ length: 24 }, (_, i) => <option key={i} value={two(i)}>{two(i)}</option>)}
        </select>
        <span className="text-slate-500">:</span>
        <select className="input w-16 px-1" aria-label={`${label} – phút`} value={m} onChange={(e) => set(d, h, e.target.value)}>
          {Array.from({ length: 60 }, (_, i) => <option key={i} value={two(i)}>{two(i)}</option>)}
        </select>
      </div>
      </div>
    </fieldset>
  );
}

/**
 * "Vì sao?" – what the story matched when it was collected (the evidence stored with the article): places, the rule's
 * keywords and where they were found, sector scores, the words behind the suggested assessment, and – for stories that
 * are not ready – the reason. Read-only; nothing is recomputed.
 */
function MatchWhy({ a, reason }: { a: Article; reason?: string | null }) {
  const ev = a.relevance?.evidence ?? [];
  const places = new Map<string, string>();
  for (const e of [...(a.location?.evidence ?? []), ...ev]) {
    const m = /^Địa bàn: "(.+?)"(?: – (.*))?$/.exec(e);
    if (m && !places.has(m[1]!)) places.set(m[1]!, m[2] ?? '');
  }
  const kw = new Map<string, Set<string>>();
  for (const e of ev) {
    const m = /^Từ khóa "(.+?)" \((.+?)\)$/.exec(e);
    if (m) kw.set(m[1]!, (kw.get(m[1]!) ?? new Set()).add(m[2]!));
  }
  const sectors = (a.classificationEvidence ?? []).map((e) => {
    const off = /không tính/.test(e);
    const m = /^(.+?): (.+?)(?: \(điểm (\d+)\))?$/.exec(e);
    return { label: m?.[1] ?? e, words: off ? e.replace(/^.+?: /, '') : (m?.[2] ?? ''), score: Number(m?.[3] ?? 0), off };
  });
  const asm = (a.assessmentEvidence ?? []).filter((e) => !e.startsWith('Độ tin cậy'));
  const confidence = (a.assessmentEvidence ?? []).find((e) => e.startsWith('Độ tin cậy'));
  const other = ev.filter((e) => !/^(Địa bàn|Từ khóa|Bộ quy tắc)/.test(e));
  const where = (f: Set<string>) => [...f].map((x) => (x === 'tiêu đề' ? 'tiêu đề' : x === 'sapo' ? 'sapo' : 'nội dung')).join(', ');
  const row = (icon: string, label: string, body: React.ReactNode) => (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-slate-500">{icon} {label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{body}</div>
    </div>
  );
  return (
    <div className="animate-in mt-2 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs" data-testid="match-why">
      {reason && row('⚠', 'Lý do', <span className="text-amber-800">{reason}</span>)}
      {row('📍', 'Địa bàn', places.size ? [...places].map(([p, snip]) => <span key={p} className="chip border-green-200 bg-white text-green-800" title={snip}>{p}</span>) : <span className="text-slate-500">không thấy địa danh</span>)}
      {row('🔑', 'Từ khóa', kw.size ? [...kw].map(([k, f]) => (
        <span key={k} className={`chip bg-white ${f.has('tiêu đề') ? 'border-teal-300 font-semibold text-teal-800' : 'border-slate-200 text-slate-700'}`} title={`Có trong: ${where(f)}`}>
          {k} <span className="font-normal text-slate-400">· {where(f)}</span>
        </span>
      )) : <span className="text-slate-500">không khớp từ khóa nào</span>)}
      {sectors.length > 0 && row('🏷', 'Lĩnh vực', sectors.map((x, i) => (
        <span key={i} className={`chip bg-white ${x.off ? 'border-slate-200 text-slate-400 line-through' : i === 0 ? 'border-navy-200 font-semibold text-navy-800' : 'border-slate-200 text-slate-600'}`} title={x.off ? x.words : `Từ khóa: ${x.words}`}>
          {x.label}{x.score ? ` · ${x.score} điểm` : ''}
        </span>
      )))}
      {asm.length > 0 && row('⚖', 'Tính chất', <>
        {asm.map((e) => <span key={e} className="chip border-slate-200 bg-white text-slate-700">{e}</span>)}
        {confidence && <span className="text-slate-400">{confidence.replace('Độ tin cậy: ', 'độ tin cậy ')}</span>}
      </>)}
      {other.length > 0 && row('ℹ', 'Khác', <span className="text-slate-600">{other.join(' · ')}</span>)}
      <p className="text-[10px] text-slate-400">Theo cài đặt lúc thu thập bài. Từ khóa đậm = có trong tiêu đề (3 điểm), còn lại = sapo/nội dung (1 điểm).</p>
    </div>
  );
}

/**
 * "Loại" asks why in one click: off-topic / other area teach the filter; a duplicate or a minor story is on topic, so it
 * does not count against the filter (daily suggestions).
 */
function RemoveButton({ title, onRemove, className = '' }: { title: string; onRemove: (reason: ExcludeReason) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) {
        if (e instanceof KeyboardEvent) e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', close));
  }, [open]);
  const ICON: Record<ExcludeReason, string> = { off_topic: '🚫', other_area: '📍', duplicate: '⧉', minor: '↓' };
  return (
    <div className={`relative ${className}`} ref={box}>
      <button className="btn-ghost btn-xs text-red-700" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu" title="Loại bài này khỏi danh sách và báo cáo (khôi phục ở mục Đã loại bên dưới)" aria-label={`Loại bài: ${title}`}>
        <Trash2 className="h-3.5 w-3.5" /> Loại
      </button>
      {open && (
        <div className="animate-in absolute bottom-full right-0 z-20 mb-1 w-48 rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg" role="menu" aria-label="Lý do loại">
          <div className="px-3 pb-1 pt-0.5 text-[11px] text-slate-500">Vì sao loại bài này?</div>
          {EXCLUDE_REASONS.map((k) => (
            <button key={k} role="menuitem" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => (setOpen(false), onRemove(k))}>
              <span className="w-4 text-center" aria-hidden="true">{ICON[k]}</span> {EXCLUDE_REASON_LABEL[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Hỏi nhanh": one story at a time, the ones the filter is least sure about; every answer is a ✓/✗ vote of the team */
function QuickAsk({ items, onAnswer, onSkip, onClose }: { items: UncertainStory[]; onAnswer: (x: UncertainStory, relevant: boolean, reason?: ExcludeReason) => boolean; onSkip: (x: UncertainStory) => void; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [done, setDone] = useState(0);
  // "✗ Không" asks why (one click): the reason is what the nightly suggestions learn from
  const [why, setWhy] = useState(false);
  const busy = false;
  const x = items[i];
  const answer = (rel: boolean, reason?: ExcludeReason) => {
    if (!x) return;
    if (!onAnswer(x, rel, reason)) return onClose(); // no reviewer session: the login dialog opens
    setWhy(false);
    setDone((n) => n + 1);
    setI((n) => n + 1);
  };
  const REASON_ICON: Record<ExcludeReason, string> = { off_topic: '🚫', other_area: '📍', duplicate: '⧉', minor: '↓' };
  // the likely reason first: a story placed outside the city → "Ngoài địa bàn"
  const likely: ExcludeReason = x && x.article.location?.status && x.article.location.status !== 'hcm' ? 'other_area' : 'off_topic';
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3" role="dialog" aria-modal="true" aria-label="Hỏi nhanh">
      <div className="animate-in w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <HelpCircle className="h-5 w-5 text-amber-500" />
          <h2 className="font-bold text-navy-800">Hỏi nhanh</h2>
          <span className="text-xs text-slate-500">{Math.min(i + 1, items.length)} / {items.length}</span>
          <div className="ml-2 h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${(Math.min(i, items.length) / items.length) * 100}%` }} /></div>
          <button className="btn-ghost rounded-full px-2" onClick={onClose} aria-label="Đóng hỏi nhanh"><X className="h-4 w-4" /></button>
        </div>
        {x ? (
          <div key={x.article.id} className="animate-in" data-testid="quick-ask-story">
            <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">🤔 {x.why}</p>
            <div className="text-xs text-slate-500">{x.article.sourceName} · {x.article.publishedAt ? formatVn(x.article.publishedAt) : 'chưa rõ giờ đăng'} · hiện: <b>{x.status === 'relevant' ? 'Sẵn sàng' : x.status === 'review' ? 'Cần kiểm tra' : 'đã loại'}</b></div>
            <h3 className="mt-1 text-lg font-semibold leading-snug">
              <a className="group hover:text-teal-700 hover:underline" href={x.article.canonicalUrl ?? x.article.originalUrl} target="_blank" rel="noreferrer" title={`Mở bài gốc (tab mới): ${x.article.canonicalUrl ?? x.article.originalUrl}`}>
                {x.article.title}
                <ExternalLink className="ml-1 inline h-4 w-4 align-baseline text-slate-400 group-hover:text-teal-600" aria-hidden="true" />
              </a>
            </h3>
            <p className="mt-1 line-clamp-4 text-sm text-slate-600">{x.article.sapo}</p>
            <MatchWhy a={x.article} />
            <p className="mt-3 text-sm font-medium text-slate-700">Bài này có thuộc phạm vi điểm tin không?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn rounded-full border-green-600 bg-green-600 px-5 text-white hover:bg-green-700" disabled={busy} onClick={() => answer(true)}>✓ Liên quan</button>
              <button className={`btn rounded-full border-red-600 px-5 ${why ? 'bg-white text-red-700' : 'bg-red-600 text-white hover:bg-red-700'}`} disabled={busy} aria-expanded={why} onClick={() => setWhy((v) => !v)}>✗ Không</button>
              <button className="btn-ghost rounded-full" disabled={busy} onClick={() => { if (x) onSkip(x); setWhy(false); setI((n) => n + 1); }}>Bỏ qua</button>
            </div>
            {why && (
              <div className="animate-in mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-red-50 px-3 py-2" data-testid="ask-reasons">
                <span className="text-xs font-medium text-red-900">Vì sao?</span>
                {[likely, ...EXCLUDE_REASONS.filter((k) => k !== likely)].map((k) => (
                  <button key={k} className={`btn btn-xs rounded-full ${k === likely ? 'border-red-600 bg-red-600 text-white hover:bg-red-700' : 'border-red-200 bg-white text-red-800 hover:bg-red-100'}`} onClick={() => answer(false, k)}>
                    <span aria-hidden="true">{REASON_ICON[k]}</span> {EXCLUDE_REASON_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="animate-in flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="font-semibold text-slate-800">Cảm ơn! Đã chấm {done} bài.</p>
            <p className="max-w-sm text-xs text-slate-500">Các phiếu này được dùng để gợi ý cải thiện bộ lọc mỗi đêm (Cài đặt › Gợi ý cải thiện).</p>
            <button className="btn-primary mt-2 rounded-full" onClick={onClose}>Xong</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** "17:00 16/11" from an ISO time (Vietnam) */
function shortVn(iso: string): string {
  const [hm, d] = formatVn(iso).split(' ');
  return `${hm} ${(d ?? '').slice(0, 5)}`;
}
/** avatar letters: "Nguyễn Văn Cường" → "C", "Người duyệt D" → "D" */
function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w[w.length - 1]?.[0] ?? '?').toUpperCase();
}
/**
 * compact run window with the year (the app is used over several years, 18/11/2026):
 * "16/11/2026 · 08:01–16:30" (same day), "15/11 17:00 → 16/11/2026 08:00", "31/12/2026 17:00 → 01/01/2027 08:00"
 */
function runLabel(r: { window: { from: string; to: string } }): string {
  const [fh, fd = ''] = formatVn(r.window.from).split(' ');
  const [th, td = ''] = formatVn(r.window.to).split(' ');
  if (fd === td) return `${fd} · ${fh}–${th}`;
  return `${fd.slice(6) === td.slice(6) ? fd.slice(0, 5) : fd} ${fh} → ${td} ${th}`;
}
/** "17:00 17/11 → 08:01 18/11/2026" (year once, on both dates when they differ) */
function windowText(from: string, to: string): string {
  const [fh, fd = ''] = formatVn(from).split(' ');
  const [th, td = ''] = formatVn(to).split(' ');
  return `${fh} ${fd.slice(6) === td.slice(6) ? fd.slice(0, 5) : fd} → ${th} ${td}`;
}
/** requests sent for a reviewer by the assistant were recorded as "Claude (cho X)": shown as X */
function personName(s: string): string {
  return s.replace(/^Claude \(cho (.+)\)$/, '$1').trim();
}
/** who / how: "tự động", the reviewer who asked for it, "đang diễn ra", or a local status */
function runTag(r: RunInfo): { text: string; tone: string } {
  if (r.active) return { text: 'đang chạy', tone: 'border-blue-300 bg-blue-50 text-blue-800' };
  if (r.notes.some((x) => /đang diễn ra/i.test(x))) return { text: 'đang diễn ra', tone: 'border-sky-300 bg-sky-50 text-sky-800' };
  const sch = r.notes.map((x) => /theo lịch (\d{2}:\d{2})/.exec(x)).find(Boolean);
  if (sch) return { text: `lịch ${sch[1]}`, tone: 'border-teal-200 bg-teal-50 text-teal-800' };
  // "Thu thập theo yêu cầu (Cường)" / "… (Claude (cho Cường))" / "… của Cường trên web." → the requester
  const req = r.notes.map((x) => /theo yêu cầu(?: của)?\s*(.*)$/i.exec(x)).find(Boolean);
  if (req) {
    const who = personName((req[1] ?? '').replace(/\s*trên web\.?$/, '').replace(/^\((.*)\)$/, '$1').trim());
    return { text: who || 'theo yêu cầu', tone: 'border-violet-200 bg-violet-50 text-violet-800' };
  }
  if (r.status && r.status !== 'completed') return { text: STATUS_VN[r.status] ?? r.status, tone: 'border-amber-300 bg-amber-50 text-amber-800' };
  return { text: r.trigger === 'manual' ? 'thủ công' : 'tự động', tone: 'border-slate-200 bg-slate-50 text-slate-600' };
}
const STATUS_VN: Record<string, string> = { running: 'đang chạy', cancelled: 'đã dừng', failed: 'lỗi', partial: 'một phần', interrupted: 'bị ngắt' };

/** "Lượt đã lưu": compact list, newest first, current one ticked; delete per run; removed runs (web) can be restored */
function RunPicker({ runs, runId, onPick, onDelete, deleteHint, onArchive }: { runs: RunInfo[]; runId: string | null; onPick: (id: string) => void; onDelete?: (r: RunInfo) => void; deleteHint?: string; onArchive?: (r: RunInfo, on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) {
        if (e instanceof KeyboardEvent) e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', close));
  }, [open]);
  const at = (r: RunInfo) => Date.parse(r.finishedAt ?? r.createdAt) || 0;
  const all = [...runs].sort((a, b) => at(b) - at(a));
  const sorted = all.filter((r) => !r.archived);
  const archived = all.filter((r) => r.archived);
  const cur = runs.find((r) => r.runId === runId);
  const tag = cur && runTag(cur);
  return (
    <div className="relative" ref={box}>
      <button type="button" className="flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-sm transition hover:border-teal-400" aria-label="Lượt đã lưu" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="run-picker" title="Lượt đã lưu">
        <History className="h-4 w-4 shrink-0 text-teal-600" />
        <span className="truncate font-medium tabular-nums">{cur ? runLabel(cur) : 'Chọn lượt…'}</span>
        {tag && <span className={`chip shrink-0 truncate ${tag.tone}`}>{tag.text}</span>}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-slate-500" />
      </button>
      {open && (
        <div className="animate-in absolute left-0 z-30 mt-1 max-h-96 w-[min(24rem,calc(100vw-2rem))] overflow-auto rounded-xl sm:left-auto sm:right-0 border border-slate-200 bg-white py-1 shadow-lg" role="listbox" aria-label="Danh sách các lượt">
          {sorted.map((r) => {
            const tg = runTag(r);
            const sel = r.runId === runId;
            return (
              <div key={r.runId} className={`group flex items-center gap-1 px-1 ${sel ? 'bg-navy-50' : 'hover:bg-slate-50'}`} data-testid={`run-row-${r.runId}`}>
                <button type="button" role="option" aria-selected={sel} className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm" onClick={() => (onPick(r.runId), setOpen(false))}>
                  <Check className={`h-3.5 w-3.5 shrink-0 ${sel ? 'text-navy-700' : 'invisible'}`} />
                  <span className="truncate tabular-nums">{runLabel(r)}</span>
                  <span className={`chip ml-auto shrink-0 ${tg.tone}`}>{tg.text}</span>
                </button>
                {onArchive && (
                  <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-teal-50 hover:text-teal-700 disabled:opacity-30" disabled={r.active} title="Lưu trữ: cất xuống mục Lưu trữ cuối danh sách, xem lại khi cần" aria-label={`Lưu trữ lượt ${runLabel(r)}`} onClick={() => (setOpen(false), onArchive(r, true))}>
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                )}
                {onDelete ? (
                  <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700 disabled:opacity-30" disabled={r.active} title={r.active ? 'Lượt đang chạy – dừng trước khi xoá' : 'Xoá lượt này'} aria-label={`Xoá lượt ${runLabel(r)}`} onClick={() => (setOpen(false), onDelete(r))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : deleteHint ? (
                  <span className="p-1.5 text-slate-300" title={deleteHint}><Trash2 className="h-3.5 w-3.5" /></span>
                ) : null}
              </div>
            );
          })}
          {!sorted.length && <p className="px-3 py-2 text-sm text-slate-500">Chưa có lượt nào.</p>}
          {archived.length > 0 && (
            <details className="mt-1 border-t border-slate-100 px-1 py-1 text-sm" data-testid="run-archive" open={archived.some((r) => r.runId === runId)}>
              <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1 text-xs font-medium text-slate-500">
                <Archive className="h-3.5 w-3.5" /> Lưu trữ ({archived.length})
              </summary>
              {archived.map((r) => {
                const sel = r.runId === runId;
                return (
                  <div key={r.runId} className={`flex items-center gap-1 ${sel ? 'bg-navy-50' : 'hover:bg-slate-50'}`}>
                    <button type="button" role="option" aria-selected={sel} className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs text-slate-600" onClick={() => (onPick(r.runId), setOpen(false))}>
                      <Check className={`h-3 w-3 shrink-0 ${sel ? 'text-navy-700' : 'invisible'}`} />
                      <span className="truncate tabular-nums">{runLabel(r)}</span>
                    </button>
                    {onArchive && (
                      <button type="button" className="rounded p-1.5 text-slate-400 hover:bg-teal-50 hover:text-teal-700" title="Đưa về danh sách chính" aria-label={`Bỏ lưu trữ lượt ${runLabel(r)}`} onClick={() => (setOpen(false), onArchive(r, false))}>
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** the most recent collection: latest finish (or start) time */
function latestRun<T extends { finishedAt: string | null; createdAt: string; archived?: boolean }>(rs: T[]): T | undefined {
  const at = (r: T) => Date.parse(r.finishedAt ?? r.createdAt) || 0;
  const live = rs.filter((r) => !r.archived);
  return [...(live.length ? live : rs)].sort((a, b) => at(b) - at(a))[0];
}

/** window of a preset ("Kỳ gần nhất", "Hôm nay", "Hôm qua", saved custom) */
function presetWindow(p: 'last_completed' | 'today' | 'yesterday' | 'custom', s: Settings): { from: string; to: string } {
  const now = new Date();
  const { startClock: a, endClock: b } = s.reportWindow;
  return p === 'today' ? todayWindow(now, a, b) : p === 'yesterday' ? yesterdayWindow(now, a, b) : p === 'custom' && s.reportWindow.customFrom ? { from: s.reportWindow.customFrom, to: s.reportWindow.customTo } : lastCompletedWindow(now, a, b);
}

const SRC_STATUS: Record<string, string> = { ok: 'OK', partial: 'Một phần', failed: 'Lỗi', running: 'Đang chạy', pending: 'Chờ', skipped_disabled: 'Đã tắt', manual_only: 'Nhập thủ công', cancelled: 'Đã hủy' };


function ArticleList({ list, excluded = [], reviews, cands, settings, onInspect, onPatch, reviewMode, votes }: { list: Article[]; excluded?: Article[]; reviews: Record<string, ReviewDecision>; cands: Map<string, Candidate>; settings: Settings | null; onInspect: (id: string) => void; onPatch: (id: string, p: Partial<ReviewDecision>) => void | Promise<unknown>; reviewMode?: boolean; votes?: Record<string, Vote[]> }) {
  const [q, setQ] = useState('');
  const [bulk, setBulk] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('all');
  // newest first by default (stories without a publication time last); the editor can flip it
  const [newestFirst, setNewestFirst] = useState(true);
  // "Vì sao?" panels open (several at once)
  const [why, setWhy] = useState<Set<string>>(new Set());
  const toggleWhy = (id: string) => setWhy((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ts = (a: Article) => (a.publishedAt ? Date.parse(a.publishedAt) : NaN);
  const shown = list
    .filter((a) => (!q || a.title.toLowerCase().includes(q.toLowerCase())) && (cat === 'all' || (reviews[a.id]?.primaryCategory ?? a.primaryCategory) === cat))
    .sort((x, y) => {
      const a = ts(x), b = ts(y);
      if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
      return newestFirst ? b - a : a - b;
    });
  // stories per sector in this list (shown on the filter chips)
  const catCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of list) {
      const k = (reviews[a.id]?.primaryCategory ?? a.primaryCategory) as string | null;
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [list, reviews]);
  const catLabel = (c: string | null | undefined) => settings?.categories.find((x) => x.code === c)?.label ?? 'Chưa phân loại';
  // bulk actions apply to the stories SHOWN (search + sector filter); stories merged into another one are skipped
  const selectable = shown.filter((a) => !reviews[a.id]?.groupId);
  const nSel = selectable.filter((a) => reviews[a.id]?.included).length;
  const runBulk = async (label: string, ids: string[], p: (id: string) => Partial<ReviewDecision>) => {
    setBulk(label);
    try {
      // all at once: every box changes immediately, the web saves them in ONE request (see api.queueTeamReview)
      await Promise.all(ids.map((id) => onPatch(id, p(id))));
    } finally {
      setBulk(null);
    }
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input className="input pl-7 sm:w-72" type="search" placeholder="Tìm tiêu đề…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="scroll-row -mx-3 order-last flex w-[calc(100%+1.5rem)] gap-1.5 px-3 pb-0.5 sm:order-none sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 [&>button]:shrink-0" data-testid="cat-filters">
        <button className={`chip ${cat === 'all' ? 'border-navy-700 bg-navy-700 text-white' : 'border-slate-300 bg-white'}`} onClick={() => setCat('all')}>Tất cả</button>
        {settings?.categories.filter((c) => c.enabled).map((c) => (
          <button key={c.code} className={`chip ${cat === c.code ? catStyle(c.code).solid + ' shadow-sm' : 'border-slate-300 bg-white hover:bg-slate-50'}`} onClick={() => setCat(cat === c.code ? 'all' : c.code)} aria-pressed={cat === c.code} data-testid={`cat-filter-${c.code}`}>
            <span className={`h-2 w-2 rounded-full ${cat === c.code ? 'bg-white' : catStyle(c.code).dot}`} aria-hidden="true" />
            {c.label}
            {catCount.get(c.code) ? <span className="tabular-nums opacity-70">{catCount.get(c.code)}</span> : null}
          </button>
        ))}
        </div>
        <button className="btn-ghost btn-xs sm:ml-auto" onClick={() => setNewestFirst((v) => !v)} title="Đổi thứ tự theo giờ đăng" data-testid="sort-toggle">
          {newestFirst ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />} {newestFirst ? 'Mới nhất trước' : 'Cũ nhất trước'}
        </button>
      </div>
      {selectable.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 text-sm" data-testid="bulk-bar">
          <label className="flex cursor-pointer items-center gap-2 font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 accent-teal-600"
              aria-label="Chọn tất cả bài đang hiển thị"
              checked={nSel === selectable.length}
              ref={(el) => {
                if (el) el.indeterminate = nSel > 0 && nSel < selectable.length;
              }}
              disabled={!!bulk}
              onChange={(e) => {
                const on = e.target.checked;
                const ids = selectable.filter((a) => !!reviews[a.id]?.included !== on).map((a) => a.id);
                // each newly selected story gets its own place, in the order shown (same order → ↑/↓ could not swap them)
                const base = Date.now() % 1e9;
                void runBulk(on ? 'Đang chọn…' : 'Đang bỏ chọn…', ids, (id) => (on ? { included: true, order: base + ids.indexOf(id) } : { included: false }));
              }}
            />
            Chọn tất cả ({selectable.length}{shown.length < list.length ? ' đang hiển thị' : ''})
          </label>
          {shown.length > selectable.length && (
            <span className="text-xs text-purple-700" data-testid="merged-note" title="Bài đã gộp làm nguồn phụ của tin khác đi cùng tin chính trong báo cáo, không chọn riêng. Bấm Tách trên bài để chọn riêng.">
              + {shown.length - selectable.length} bài đã gộp vào tin khác
            </span>
          )}
          <span className="text-slate-500">· đã chọn {nSel}</span>
          {nSel > 0 && (
            <button className="btn-ghost btn-xs" disabled={!!bulk} onClick={() => void runBulk('Đang bỏ chọn…', selectable.filter((a) => reviews[a.id]?.included).map((a) => a.id), () => ({ included: false }))}>
              Bỏ chọn tất cả
            </button>
          )}
          {reviewMode && (
            <button
              className="btn-teal btn-xs ml-auto"
              disabled={!!bulk}
              title="Chuyển các bài đang hiển thị sang Bài sẵn sàng (bài chưa rõ giờ đăng vẫn phải xác nhận giờ trước khi xuất)"
              onClick={() => {
                const ids = (nSel > 0 ? selectable.filter((a) => reviews[a.id]?.included) : shown).map((a) => a.id);
                if (confirm(`Chuyển ${ids.length} bài${nSel > 0 ? ' đã chọn' : ' đang hiển thị'} sang Bài sẵn sàng?`)) void runBulk('Đang chuyển…', ids, () => ({ promotedToReady: true }));
              }}
            >
              <ArrowRight className="h-3.5 w-3.5" /> Chuyển {nSel > 0 ? `${nSel} bài đã chọn` : 'tất cả'} sang Bài sẵn sàng
            </button>
          )}
          {nSel > 0 && (
            <button
              className={`btn-danger btn-xs ${reviewMode ? '' : 'ml-auto'}`}
              disabled={!!bulk}
              title="Loại các bài đã chọn khỏi danh sách và báo cáo (khôi phục ở mục Đã loại bên dưới)"
              onClick={() => void runBulk('Đang loại…', selectable.filter((a) => reviews[a.id]?.included).map((a) => a.id), () => ({ excludedByEditor: true, included: false }))}
            >
              <Trash2 className="h-3.5 w-3.5" /> Loại {nSel} bài đã chọn
            </button>
          )}
          {bulk && <span className="text-xs text-slate-500">{bulk}</span>}
        </div>
      )}
      {shown.length === 0 && <div className="card p-6 text-center text-sm text-slate-500">{reviewMode ? 'Không có bài cần kiểm tra.' : 'Chưa có bài sẵn sàng trong khung giờ này.'}</div>}
      <div className="space-y-2">
        {shown.map((a) => {
          const r = reviews[a.id];
          const c = cands.get(a.id);
          const asm = r?.assessment ?? a.suggestedAssessment;
          // the photo chosen in Biên tập (null = "Không dùng ảnh"), else the article's first photo
          const img = r?.primaryImageUrl === null ? undefined : r?.primaryImageUrl ? { url: r.primaryImageUrl } : a.imageCandidates[0];
          return (
            <article key={a.id} className={`card animate-in flex gap-2.5 p-3 transition-shadow sm:gap-3 hover:shadow-md ${r?.included ? 'ring-2 ring-teal-500' : ''}`}>
              <label className="flex flex-col items-center gap-1 pt-0.5 text-[10px] text-slate-500 sm:pt-1">
                <input type="checkbox" className="h-5 w-5" disabled={!!r?.groupId} title={r?.groupId ? 'Bài đã gộp làm nguồn phụ của tin khác' : ''} checked={!!r?.included && !r?.groupId} onChange={(e) => onPatch(a.id, { included: e.target.checked, order: r?.order ?? Date.now() % 1e6 })} aria-label={`Chọn bài ${a.title}`} />
                <span className="hidden sm:inline">chọn</span>
              </label>
              {img ? (
                <img src={img.url} alt="" loading="lazy" referrerPolicy="no-referrer" className="hidden h-20 w-28 shrink-0 rounded bg-slate-100 object-cover sm:block" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
              ) : (
                <div className="hidden h-20 w-28 shrink-0 items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400 sm:flex">{r?.primaryImageUrl === null ? 'không dùng ảnh' : 'không có ảnh'}</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
                  <span className="font-semibold text-navy-700">{a.sourceName}</span>
                  <span className="text-slate-500">{a.publishedAt ? formatVn(a.publishedAt) : 'chưa rõ giờ đăng'}</span>
                  <span className={`chip font-medium ${catStyle(r?.primaryCategory ?? a.primaryCategory).soft}`} data-testid="story-cat"><span className={`h-1.5 w-1.5 rounded-full ${catStyle(r?.primaryCategory ?? a.primaryCategory).dot}`} aria-hidden="true" />{catLabel(r?.primaryCategory ?? a.primaryCategory)}</span>
                  {asm && <span className={`chip ${ASSESS_COLOR[asm]}`}>{ASSESSMENT_LABEL[asm]}{!r?.assessment && ' (gợi ý)'}</span>}
                  {c && !['ready_for_review', 'reviewed'].includes(c.state) && <StateChip state={c.state} />}
                  {r?.groupId ? (
                    <span className="chip border-purple-400 bg-purple-100 text-purple-900">
                      đã gộp làm nguồn phụ
                      <button className="ml-1 font-semibold underline" onClick={() => onPatch(a.id, { groupId: null })} title="Tách ra thành tin riêng (chọn được riêng)">Tách</button>
                    </span>
                  ) : a.duplicateGroupId ? (
                    <span className="chip border-purple-300 bg-purple-50 text-purple-800">cùng sự kiện?</span>
                  ) : null}
                  {r && !r.groupId && secondariesOf(a.id, reviews).length > 0 && <span className="chip border-purple-300 bg-purple-50 text-purple-800">+{secondariesOf(a.id, reviews).length} nguồn</span>}
                  {a.extractionWarnings.length > 0 && <span className="chip border-amber-300 bg-amber-50 text-amber-800"><AlertTriangle className="h-3 w-3" /> {a.extractionWarnings.length} cảnh báo</span>}
                </div>
                {img && <img src={img.url} alt="" loading="lazy" referrerPolicy="no-referrer" className="float-right mb-1 ml-2 h-16 w-24 rounded bg-slate-100 object-cover sm:hidden" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
                <h3 className="font-semibold leading-snug">
                  <a className="group hover:text-teal-700 hover:underline" href={a.canonicalUrl ?? a.originalUrl} target="_blank" rel="noreferrer" title={`Mở bài gốc (tab mới): ${a.canonicalUrl ?? a.originalUrl}`} data-testid="story-title-link">
                    {r?.title ?? a.title}
                    <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-baseline text-slate-400 group-hover:text-teal-600" aria-hidden="true" />
                  </a>
                </h3>
                <p className="line-clamp-2 text-sm text-slate-600">{r?.summary ?? a.sapo}</p>
                {reviewMode && c?.reasonDetail && <p className="mt-1 text-xs text-amber-800">Lý do: {c.reasonDetail}</p>}
                <div className="clear-both mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2" data-testid="story-actions">
                  <button className="btn-ghost btn-xs order-1 sm:order-none" onClick={() => onInspect(a.id)}><FileText className="h-3.5 w-3.5" /> <span className="short-label" data-short="Chi tiết">Xem chi tiết</span></button>
                  <button className={`btn-ghost btn-xs order-1 sm:order-none ${why.has(a.id) ? 'border-amber-300 bg-amber-50 text-amber-900' : ''}`} onClick={() => toggleWhy(a.id)} aria-expanded={why.has(a.id)} aria-label={`Vì sao bài này được lấy: ${a.title}`} title="Bài khớp tiêu chí nào: địa bàn, từ khóa, lĩnh vực, tính chất">
                    <Lightbulb className="h-3.5 w-3.5" /> <span className="short-label" data-short="">Vì sao?</span>
                  </button>
                  <RelevanceButtons r={r} onPatch={(p) => onPatch(a.id, p)} title={a.title} votes={votes?.[a.id]} />
                  {reviewMode && (
                    <button className="btn-teal btn-xs" onClick={() => onPatch(a.id, { promotedToReady: true })} title="Chuyển bài này sang Bài sẵn sàng" aria-label={`Chuyển sang Bài sẵn sàng: ${a.title}`}>
                      <ArrowRight className="h-3.5 w-3.5" /> Sẵn sàng
                    </button>
                  )}
                  {!reviewMode && r?.promotedToReady && (
                    <button className="btn-ghost btn-xs" onClick={() => onPatch(a.id, { promotedToReady: false })} title="Trả bài về Cần kiểm tra" aria-label={`Trả về Cần kiểm tra: ${a.title}`}>
                      <Undo2 className="h-3.5 w-3.5" /> Trả về
                    </button>
                  )}
                  {r?.sharedBy && (
                    <span className="ml-auto text-[11px] text-slate-500" title="Kết quả duyệt dùng chung cho cả nhóm" data-testid="shared-by">
                      duyệt chung: {r.sharedBy}{r.sharedAt ? ` · ${formatVn(r.sharedAt)}` : ''}
                    </span>
                  )}
                  <RemoveButton className={`order-2 sm:order-none ${r?.sharedBy ? '' : 'ml-auto'}`} title={a.title} onRemove={(reason) => onPatch(a.id, { excludedByEditor: true, included: false, excludeReason: reason })} />
                </div>
                {why.has(a.id) && <MatchWhy a={a} reason={reviewMode ? c?.reasonDetail : null} />}
              </div>
            </article>
          );
        })}
      </div>
      {excluded.length > 0 && (
        <details className="mt-3 rounded border border-slate-200 bg-white p-2" data-testid="excluded-list">
          <summary className="cursor-pointer text-sm text-slate-600">Đã loại ({excluded.length}) – xem và khôi phục</summary>
          <div className="mt-2 space-y-1">
            {excluded.map((a) => (
              <div key={a.id} className="flex items-center gap-2 border-b border-slate-100 py-1 text-sm">
                <span className="text-xs text-slate-500">{a.sourceName}</span>
                <span className="min-w-0 flex-1 truncate">{reviews[a.id]?.title ?? a.title}</span>
                {reviews[a.id]?.relevanceLabel === 'irrelevant' && <span className="chip border-red-300 bg-red-50 text-red-800">không liên quan</span>}
                {reviews[a.id]?.excludeReason && <span className="chip border-slate-300 bg-slate-50 text-slate-700">{EXCLUDE_REASON_LABEL[reviews[a.id]!.excludeReason!]}</span>}
                <button className="btn-ghost btn-xs" onClick={() => onPatch(a.id, reviews[a.id]?.relevanceLabel === 'irrelevant' ? { excludedByEditor: false, excludeReason: null, relevanceLabel: null } : { excludedByEditor: false, excludeReason: null })} aria-label={`Khôi phục: ${a.title}`}>
                  <Undo2 className="h-3.5 w-3.5" /> Khôi phục
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ReviewerLogin({ onClose, onLogin }: { onClose: () => void; onLogin: (user: string, password: string) => Promise<void> }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Đăng nhập">
      <form
        className="card w-full max-w-sm space-y-3 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await onLogin(user.trim(), pass);
          } catch (x) {
            setErr((x as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-lg font-bold text-navy-700">Đăng nhập</h2>
        <p className="text-xs text-slate-500">Để duyệt tin, thu thập và sửa cài đặt cho cả nhóm.</p>
        <label className="block">
          <span className="label">Tên đăng nhập</span>
          <input className="input" value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus />
        </label>
        <label className="block">
          <span className="label">Mật khẩu</span>
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} required autoComplete="current-password" />
        </label>
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Hủy</button>
          <button className="btn-primary" disabled={busy || !user.trim() || !pass}>{busy ? 'Đang kiểm tra…' : 'Đăng nhập'}</button>
        </div>
      </form>
    </div>
  );
}

/** Editor feedback on the filter: explicit label; including an article in the report counts as "relevant". */
function RelevanceButtons({ r, onPatch, title, votes }: { r?: ReviewDecision; onPatch: (p: Partial<ReviewDecision>) => void; title: string; votes?: Vote[] }) {
  const l = r?.relevanceLabel ?? null;
  const implicit = !l && (r?.included || r?.groupId);
  const yes = votes?.filter((v) => v.l === 'relevant') ?? [];
  const no = votes?.filter((v) => v.l === 'irrelevant') ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="relevance-buttons">
      {votes && votes.length > 0 && (
        <span className="order-last text-[11px] text-slate-600" title={votes.map((v) => `${v.r}: ${v.l === 'relevant' ? 'liên quan' : v.l === 'irrelevant' ? 'không' : '—'}${v.n ? ` (${v.n})` : ''}`).join('\n')}>
          Nhóm duyệt: <b className="text-green-700">✓{yes.length}</b> <b className="text-red-700">✗{no.length}</b>
        </span>
      )}
      <div className="flex gap-1">
        <button
          className={`btn btn-xs ${l === 'relevant' ? 'border-green-600 bg-green-600 text-white' : 'btn-ghost'}`}
          aria-pressed={l === 'relevant'}
          aria-label={`Liên quan: ${title}`}
          title="Đánh giá cho bộ lọc: bài này đúng chủ đề ngành xây dựng TP.HCM"
          onClick={() => onPatch({ relevanceLabel: l === 'relevant' ? null : 'relevant' })}
        >
          ✓ Liên quan
        </button>
        <button
          className={`btn btn-xs ${l === 'irrelevant' ? 'border-red-600 bg-red-600 text-white' : 'btn-ghost'}`}
          aria-pressed={l === 'irrelevant'}
          aria-label={`Không liên quan: ${title}`}
          title="Đánh giá cho bộ lọc: bài này không thuộc phạm vi điểm tin – đồng thời loại khỏi danh sách và báo cáo (khôi phục ở mục Đã loại)"
          onClick={() => onPatch(l === 'irrelevant' ? { relevanceLabel: null } : { relevanceLabel: 'irrelevant', included: false, excludedByEditor: true })}
        >
          ✗ Không
        </button>
      </div>
      {implicit && <span className="text-[11px] text-green-700">đã chọn vào báo cáo = liên quan</span>}
    </div>
  );
}

/**
 * Filter quality per period (team labels): "Đúng chủ đề" = labelled-relevant share of "Bài sẵn sàng", "Không bỏ sót" =
 * labelled-relevant stories not excluded. One y axis (both are %), two series in fixed categorical order, direct labels at
 * the line ends + legend, hover tooltip per period, table view. Periods with fewer than 3 labelled stories are left out.
 */
const TREND = [
  { key: 'precision', label: 'Đúng chủ đề', color: '#2a78d6' },
  { key: 'recall', label: 'Không bỏ sót', color: '#eb6834' },
] as const;
function QualityTrend({ runs }: { runs: RelevanceQuality['runs'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = runs
    .filter((r) => r.labelled >= 3)
    .map((r) => {
      const ready = r.ready.R + r.ready.N;
      const rel = r.ready.R + r.review.R + r.excluded.R;
      return { id: r.runId, to: r.window.to, label: shortVn(r.window.to), n: r.labelled, precision: ready ? r.ready.R / ready : null, recall: rel ? (r.ready.R + r.review.R) / rel : null };
    })
    .sort((a, b) => Date.parse(a.to) - Date.parse(b.to))
    .slice(-14);
  if (pts.length < 2) return <p className="mt-2 text-xs text-slate-500">Biểu đồ theo kỳ hiện khi có từ 2 kỳ, mỗi kỳ ≥ 3 bài đã chấm.</p>;
  const W = 640, H = 170, L = 34, R = 118, T = 12, B = 26;
  const x = (i: number) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const step = Math.ceil(pts.length / 7);
  const last = pts[pts.length - 1]!;
  const endY: Record<string, number> = {};
  {
    const ends = TREND.map((s) => ({ k: s.key as string, v: last[s.key] })).filter((e): e is { k: string; v: number } => e.v != null).map((e) => ({ k: e.k, y: y(e.v) + 4 }));
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 13) ends[i]!.y = ends[i - 1]!.y + 13;
    for (const e of ends) endY[e.k] = e.y;
  }
  return (
    <div className="mt-3" data-testid="quality-trend">
      <div className="mb-1 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <span className="font-semibold text-slate-700">Theo từng kỳ</span>
        {TREND.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: s.color }} /> {s.label}</span>
        ))}
      </div>
      <div className="relative max-w-[740px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Chất lượng bộ lọc theo từng kỳ">
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#898781">{v * 100}%</text>
            </g>
          ))}
          {pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? <text key={p.id} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#898781">{p.label}</text> : null))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />}
          {TREND.map((s) => {
            const seg = pts.map((p, i) => [i, p[s.key]] as const).filter(([, v]) => v != null) as Array<readonly [number, number]>;
            const lastV = last[s.key];
            return (
              <g key={s.key}>
                <polyline points={seg.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {seg.map(([i, v]) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={s.color} stroke="#ffffff" strokeWidth={2} />)}
                {lastV != null && (
                  <text x={x(pts.length - 1) + 10} y={endY[s.key] ?? y(lastV) + 4} fontSize={11} fill="#52514e">
                    {s.label} {pct(lastV)}
                  </text>
                )}
              </g>
            );
          })}
          {/* hit targets: one column per period, wider than the marks */}
          {pts.map((p, i) => (
            <rect key={p.id} x={x(i) - (W - L - R) / (pts.length - 1) / 2} y={T} width={(W - L - R) / (pts.length - 1)} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
        </svg>
        {hover != null && (
          <div className="pointer-events-none absolute top-0 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md" style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > pts.length / 2 ? 'translateX(-105%)' : 'translateX(8px)' }}>
            <div className="font-semibold text-slate-800">Kỳ đến {pts[hover]!.label}</div>
            {TREND.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5 text-slate-700"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} /> {s.label}: <b>{pct(pts[hover]![s.key])}</b></div>
            ))}
            <div className="text-slate-500">{pts[hover]!.n} bài đã chấm</div>
          </div>
        )}
      </div>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-slate-500">Xem bảng số</summary>
        <table className="mt-1 w-full">
          <thead><tr><th className="th">Kỳ đến</th><th className="th">Đúng chủ đề</th><th className="th">Không bỏ sót</th><th className="th">Bài đã chấm</th></tr></thead>
          <tbody>{pts.map((p) => <tr key={p.id}><td className="td">{p.label}</td><td className="td">{pct(p.precision)}</td><td className="td">{pct(p.recall)}</td><td className="td">{p.n}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}

function QualityCard({ reviewsKey }: { reviewsKey: string }) {
  const [q, setQ] = useState<RelevanceQuality | null>(null);
  useEffect(() => {
    api.relevanceQuality().then(setQ).catch(() => setQ(null));
  }, [reviewsKey]);
  if (!q) return null;
  const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const t = q.total;
  return (
    <div className="card p-3 text-sm" data-testid="quality-card">
      <div className="flex flex-wrap items-baseline gap-4">
        <h3 className="font-semibold text-navy-700">Chất lượng bộ lọc (theo đánh giá biên tập viên)</h3>
        <span>Đã đánh giá: <b>{t.labelled}</b> bài · {q.runs.filter((r) => r.labelled).length}/{q.runs.length} lượt</span>
        <span>Độ chính xác tab Sẵn sàng: <b>{pct(q.precisionReady)}</b> ({t.ready.R} đúng / {t.ready.R + t.ready.N})</span>
        <span>Độ phủ (không bỏ sót): <b>{pct(q.recall)}</b></span>
      </div>
      <div className="mt-1 text-xs text-slate-600">
        Sẵn sàng: {t.ready.R} liên quan · {t.ready.N} không · Cần kiểm tra: {t.review.R} liên quan · {t.review.N} không · Bị loại nhưng biên tập viên đánh dấu liên quan: <b className={t.excluded.R ? 'text-red-700' : ''}>{t.excluded.R}</b>
      </div>
      {t.labelled > 0 && <QualityTrend runs={q.runs} />}
      {t.labelled === 0 && <p className="mt-1 text-xs text-slate-500">Chưa có đánh giá. Bấm "✓ Liên quan / ✗ Không" ở các bài, hoặc "Thực ra liên quan?" trong danh sách link (cuối mục Độ phủ & nguồn) cho bài bị loại; bài được chọn vào báo cáo tự tính là liên quan.</p>}
      {q.missed.length > 0 && (
        <details className="mt-2 text-xs" open>
          <summary className="cursor-pointer font-semibold text-red-800">Tin bị bộ lọc loại nhầm ({q.missed.length}) – dùng để chỉnh quy tắc</summary>
          <ul className="mt-1 list-disc pl-5">{q.missed.map((m) => <li key={m.runId + m.articleId}><a className="text-blue-700 underline" href={m.url} target="_blank" rel="noreferrer">{m.title}</a> <span className="text-slate-500">({m.source} · lý do loại: {m.reasonCode})</span></li>)}</ul>
        </details>
      )}
      {q.falseReady.length > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer font-semibold text-amber-800">Tin lạc đề lọt vào tab Sẵn sàng ({q.falseReady.length})</summary>
          <ul className="mt-1 list-disc pl-5">{q.falseReady.map((m) => <li key={m.runId + m.articleId}>{m.title} <span className="text-slate-500">({m.source})</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

function Ledger({ cands, sources, onInspect, reviews, onPatch }: { cands: Candidate[]; sources: Source[]; onInspect: (articleId: string) => void; reviews: Record<string, ReviewDecision>; onPatch: (id: string, p: Partial<ReviewDecision>) => void }) {
  const [state, setState] = useState('all');
  const [src, setSrc] = useState('all');
  const [q, setQ] = useState('');
  const states = [...new Set(cands.map((c) => c.state))];
  const shown = cands.filter((c) => (state === 'all' || c.state === state) && (src === 'all' || c.sourceId === src) && (!q || c.url.includes(q) || (c.reasonCode ?? '').includes(q.toUpperCase())));
  const csv = () => {
    const rows = [['url', 'source', 'state', 'reason', 'detail', 'via', 'http'], ...cands.map((c) => [c.url, c.sourceId, c.state, c.reasonCode ?? '', c.reasonDetail ?? '', c.discoveredVia.map((d) => d.method).join('+'), String(c.httpStatus ?? '')])];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map((x) => `"${x.replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = 'so-ung-vien.csv';
    a.click();
  };
  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap gap-2">
        <select className="input w-56" value={state} onChange={(e) => setState(e.target.value)} aria-label="Lọc trạng thái">
          <option value="all">Mọi trạng thái ({cands.length})</option>
          {states.map((s) => <option key={s} value={s}>{STATE_LABEL[s] ?? s} ({cands.filter((c) => c.state === s).length})</option>)}
        </select>
        <select className="input w-48" value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Lọc nguồn">
          <option value="all">Mọi nguồn</option>
          {[...new Set(cands.map((c) => c.sourceId))].map((s) => <option key={s} value={s}>{sources.find((x) => x.id === s)?.name ?? s}</option>)}
        </select>
        <input className="input w-64" placeholder="Tìm URL hoặc mã lý do…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="flex-1" />
        <button className="btn-ghost" onClick={csv}><Download className="h-4 w-4" /> Tải CSV</button>
      </div>
      <p className="mb-2 text-xs text-slate-500">Mọi link phát hiện đều có trạng thái và lý do – không link nào bị bỏ âm thầm. Hiển thị {Math.min(shown.length, 500)}/{shown.length}.</p>
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0">
            <tr><th className="th">Trạng thái</th><th className="th">URL</th><th className="th">Phát hiện qua</th><th className="th">Lý do</th><th className="th">HTTP</th><th className="th" /></tr>
          </thead>
          <tbody>
            {shown.slice(0, 500).map((c) => (
              <tr key={c.id}>
                <td className="td"><StateChip state={c.state} /></td>
                <td className="td max-w-[28rem] truncate font-mono text-xs" title={c.url}><a href={c.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{c.url.replace(/^https?:\/\//, '')}</a></td>
                <td className="td text-xs">{[...new Set(c.discoveredVia.map((d) => d.method))].join(' + ')}</td>
                <td className="td text-xs"><b>{c.reasonCode ?? ''}</b> {c.reasonDetail ?? ''}</td>
                <td className="td text-xs">{c.httpStatus ?? ''}</td>
                <td className="td whitespace-nowrap">
                  {c.articleId && <button className="btn-ghost btn-xs" onClick={() => onInspect(c.articleId!)}>Xem</button>}
                  {c.articleId && c.state === 'irrelevant_with_evidence' && (
                    <button
                      className={`btn btn-xs ml-1 ${reviews[c.articleId]?.relevanceLabel === 'relevant' ? 'border-green-600 bg-green-600 text-white' : 'btn-ghost'}`}
                      aria-pressed={reviews[c.articleId]?.relevanceLabel === 'relevant'}
                      title="Bộ lọc đã loại bài này – đánh dấu nếu thực ra là tin cần đưa vào điểm tin (dùng để đo bỏ sót)"
                      onClick={() => onPatch(c.articleId!, { relevanceLabel: reviews[c.articleId!]?.relevanceLabel === 'relevant' ? null : 'relevant' })}
                    >
                      {reviews[c.articleId]?.relevanceLabel === 'relevant' ? '✓ Liên quan (bị loại nhầm)' : 'Thực ra liên quan?'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdapterHealthCard({ h, disabled, onRescan, onOpenSettings }: { h: AdapterHealth; disabled: boolean; onRescan: () => void; onOpenSettings: () => void }) {
  const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const tone = h.status === 'degraded' ? 'border-red-300 bg-red-50 text-red-900' : h.status === 'ok' ? 'border-green-200 bg-green-50 text-green-900' : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div className={`mt-2 rounded border p-2 text-xs ${tone}`} data-testid="adapter-health">
      <div className="flex flex-wrap items-center gap-2">
        <b>Bộ bóc tách: {h.status === 'degraded' ? 'SUY GIẢM' : h.status === 'ok' ? 'ổn định' : 'chưa đủ mẫu'}</b>
        <span>lỗi/thiếu/không rõ giờ {pct(h.failRate)} ({h.parseFailed} lỗi · {h.partial} thiếu · {h.dateUnknown} không rõ giờ / {h.fetched} bài tải)</span>
        <span>· mốc {h.baseline.runs} lượt trước: {pct(h.baseline.failRate)}</span>
        <span>· khung nội dung: <code>{h.mainContainer ?? '—'}</code>{h.baseline.mainContainer && h.baseline.mainContainer !== h.mainContainer ? <> (trước: <code>{h.baseline.mainContainer}</code>)</> : null}</span>
      </div>
      {h.reasons.length > 0 && <ul className="mt-1 list-disc pl-5">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {h.status === 'degraded' && (
        <div className="mt-2">
          <b>Cách khắc phục:</b> bài của nguồn này đã chuyển sang hàng <i>Cần kiểm tra</i> và không còn được tự gắn nhãn "đầy đủ".
          <ol className="mt-1 list-decimal pl-5">
            <li>Mở vài bài trong hàng Cần kiểm tra, đối chiếu với bài gốc.</li>
            <li>Vào Cài đặt › Nguồn tin › <i>Thử thu thập</i> để xem khung nội dung mới; nếu cần, đặt "Mẫu URL bài" trong phần Nâng cao.</li>
            <li>Bấm <i>Quét lại nguồn này</i>. Khi một lượt tiếp theo bình thường, nguồn trở lại trạng thái ổn định.</li>
          </ol>
          <div className="mt-1 flex gap-2">
            <button className="btn-ghost btn-xs" onClick={onOpenSettings}>Mở cài đặt nguồn tin</button>
            <button className="btn-ghost btn-xs" disabled={disabled} onClick={onRescan}>Quét lại nguồn này</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Coverage({ run, cands, onRetry, onOpenSettings, reviewsKey, ledger }: { ledger: React.ReactNode; run: RunInfo; cands: Candidate[]; onRetry: (b: { mode: 'failed' | 'source' | 'expand'; sourceId?: string; extraLookbackHours?: number }) => void; onOpenSettings: () => void; reviewsKey: string }) {
  const rec = run.reconciliation;
  return (
    <div className="space-y-3">
      <QualityCard reviewsKey={reviewsKey} />
      <div className="card flex flex-wrap items-center gap-4 p-3 text-sm">
        <div>
          Đối soát link: <b>{rec?.accounted ?? '?'} / {rec?.total ?? '?'}</b> link có trạng thái {rec?.balanced ? <CheckCircle2 className="inline h-4 w-4 text-green-600" /> : <AlertTriangle className="inline h-4 w-4 text-red-600" />}
          {rec && rec.transient > 0 && <span className="text-amber-700"> · {rec.transient} đang xử lý</span>}
        </div>
        <div>
          Mức đầy đủ lượt chạy:{' '}
          <b className={run.completeness === 'complete_within_enumerated_scope' ? 'text-green-700' : 'text-amber-700'}>
            {run.completeness === 'complete_within_enumerated_scope' ? 'Đủ trong phạm vi đã liệt kê' : run.completeness === 'incomplete' ? 'Chưa đầy đủ (xem lỗi/giới hạn bên dưới)' : 'Chưa xác định'}
          </b>
        </div>
        <span className="flex-1" />
        <button className="btn-ghost" disabled={run.active || api.mode !== 'local'} onClick={() => onRetry({ mode: 'failed' })}><RefreshCw className="h-4 w-4" /> Thử lại link lỗi</button>
      </div>
      <p className="text-xs text-slate-500">"Đủ 100%" chỉ có nghĩa mọi link <b>đã phát hiện</b> đều có trạng thái; không khẳng định đã bắt được mọi bài báo đăng (bài không xuất hiện ở RSS/sitemap/chuyên mục sẽ không thấy được).</p>
      {run.sources.map((s) => {
        const mine = cands.filter((c) => c.sourceId === s.sourceId);
        const by = (st: string) => mine.filter((c) => c.state === st).length;
        return (
          <div key={s.sourceId} className="card p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-navy-700">{s.sourceName}</h3>
              <span className="chip border-slate-300">{SRC_STATUS[s.status] ?? s.status}</span>
              {s.limitReached && <span className="chip border-amber-300 bg-amber-50 text-amber-800">Chạm giới hạn quét – có thể còn bài chưa thấy</span>}
              {s.error && <span className="text-xs text-red-700">{s.error}</span>}
              <span className="flex-1" />
              <button className="btn-ghost btn-xs" disabled={run.active || api.mode !== 'local'} onClick={() => onRetry({ mode: 'source', sourceId: s.sourceId })}>Quét lại nguồn này</button>
              <button className="btn-ghost btn-xs" disabled={run.active || api.mode !== 'local'} onClick={() => onRetry({ mode: 'expand', sourceId: s.sourceId, extraLookbackHours: 12 })}>Mở rộng quét (+12 giờ)</button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-8">
              {[['Trang DS đã duyệt', `${s.listingPagesVisited}/${s.listingPageLimit}`], ['Link duy nhất', mine.length], ['Sẵn sàng', by('ready_for_review')], ['Bóc tách thiếu', by('parsed_partial')], ['Chưa rõ giờ', by('date_unverified')], ['Ngoài khung', by('outside_window')], ['Không liên quan', by('irrelevant_with_evidence')], ['Lỗi/chặn', by('fetch_failed') + by('blocked') + by('parse_failed')]].map(([l, v]) => (
                <div key={String(l)} className="rounded bg-slate-50 p-2"><div className="text-slate-500">{l}</div><div className="text-base font-semibold">{v}</div></div>
              ))}
            </div>
            {(s as any).newSinceLast !== undefined && <p className="mt-1 text-xs text-slate-500">Lần quét gần nhất thêm mới: {(s as any).newSinceLast} link</p>}
            {s.adapter && <AdapterHealthCard h={s.adapter} disabled={run.active || api.mode !== 'local'} onRescan={() => onRetry({ mode: 'source', sourceId: s.sourceId })} onOpenSettings={onOpenSettings} />}
            <table className="mt-2 w-full">
              <thead><tr><th className="th">Kênh</th><th className="th">URL</th><th className="th">Kết quả</th><th className="th">Link</th></tr></thead>
              <tbody>
                {s.routes.map((r, i) => (
                  <tr key={i}>
                    <td className="td text-xs">{r.method}</td>
                    <td className="td max-w-md truncate font-mono text-xs" title={r.url}>{r.url}</td>
                    <td className={`td text-xs ${r.status === 'ok' ? 'text-green-700' : r.status === 'limit' ? 'text-amber-700' : 'text-red-700'}`}>{r.status === 'ok' ? `OK (HTTP ${r.httpStatus})${r.retried ? ' · lỗi tạm thời, thử lại cuối lượt thành công' : ''}` : r.status === 'limit' ? r.error : `Lỗi ${r.httpStatus ?? ''} ${r.error ?? ''}`}</td>
                    <td className="td text-xs">{r.found}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {/* every discovered link with its state and reason: kept (no silent omission), folded away from daily work */}
      <details className="card p-3" data-testid="all-links">
        <summary className="cursor-pointer select-none text-sm font-semibold text-navy-700">
          Tất cả link đã phát hiện ({cands.length}) <span className="font-normal text-slate-500">– xem lý do bị loại, đưa lại bài bị loại nhầm</span>
        </summary>
        <div className="mt-3">{ledger}</div>
      </details>
    </div>
  );
}

function Inspector({ a, c, r, settings, onClose, onPatch, arts, reviews, onMerge, onSplit, onOpen }: { a: Article; c?: Candidate; r?: ReviewDecision; settings: Settings; onClose: () => void; onPatch: (p: Partial<ReviewDecision>) => Promise<boolean | void> | void; arts: Map<string, Article>; reviews: Record<string, ReviewDecision>; onMerge: (s: string, p: string) => void; onSplit: (s: string) => void; onOpen: (id: string) => void }) {
  const mergedInto = r?.groupId ? arts.get(rootOf(a.id, reviews)) : undefined;
  const [title, setTitle] = useState(r?.title ?? a.title);
  const [summary, setSummary] = useState(r?.summary ?? a.sapo);
  const [short, setShort] = useState(r?.shortLabel ?? a.title.slice(0, 42));
  const [proposal, setProposal] = useState(r?.proposal ?? '');
  const asm = r?.assessment ?? a.suggestedAssessment;
  const max = asm === 'neutral' ? settings.editorial.summaryMaxChars.TL : asm === 'positive' ? settings.editorial.summaryMaxChars.TC : settings.editorial.summaryMaxChars.TT;
  // numbers in summary that do not appear in source text -> warning (EXT-07)
  const srcText = `${a.title} ${a.sapo} ${a.bodyText}`;
  const missingNums = (summary.match(/\d[\d.,]*/g) ?? []).filter((x) => !srcText.includes(x));
  const toast = useToast();
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'nochange' | 'error'>('idle');
  /** only the fields that differ from the saved review (leaving an unchanged field saves nothing, no history entry) */
  const changed = () => {
    const cur = { title: r?.title ?? a.title, summary: r?.summary ?? a.sapo, shortLabel: r?.shortLabel ?? a.title.slice(0, 42), proposal: r?.proposal ?? '' };
    const next = { title, summary, shortLabel: short, proposal };
    return Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== cur[k as keyof typeof cur])) as Partial<ReviewDecision>;
  };
  // a field saves itself when left; the button then reports that save instead of "no change"
  const editedRef = useRef(false);
  const lastSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  const save = () => {
    const p = changed();
    if (!Object.keys(p).length) return undefined;
    editedRef.current = true;
    const run = Promise.resolve(onPatch(p));
    lastSaveRef.current = run;
    return run;
  };
  const [photoSaved, setPhotoSaved] = useState(false);
  const pickPhoto = async (url: string | null) => {
    setPhotoSaved(false);
    if ((await onPatch({ primaryImageUrl: url })) !== false) {
      setPhotoSaved(true);
      setTimeout(() => setPhotoSaved(false), 3000);
    }
  };
  // the button confirms next to itself (the fields also save when leaving them)
  const saveNow = async () => {
    setSaveState('saving');
    const before = await lastSaveRef.current.catch(() => false); // a field that was just left is still saving
    const p = changed();
    const ok = Object.keys(p).length ? await onPatch(p) : before;
    if (ok === false) setSaveState('error');
    else if (Object.keys(p).length || editedRef.current) {
      setSaveState('saved');
      toast('ok', 'Đã lưu biên tập');
    } else setSaveState('nochange');
    editedRef.current = false;
    setTimeout(() => setSaveState((s) => (s === 'saving' ? s : 'idle')), 3000);
  };
  // "Cần nghiên cứu, xử lý" (formerly "Tồn tại cần khắc phục"): unit suggested from the topic (Cài đặt › Báo cáo & mẫu › Đề xuất giao đơn vị)
  const suggested = suggestAssignment({ title, sapo: a.sapo }, settings);
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" role="dialog" aria-modal="true" aria-label="Chi tiết bài">
      <div className="flex h-full w-full max-w-[1200px] flex-col bg-white shadow-2xl">
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <h2 className="font-bold text-navy-700">Kiểm tra bài viết</h2>
          {c && <StateChip state={c.state} />}
          <span className="flex-1" />
          <a className="btn-ghost" href={a.canonicalUrl ?? a.originalUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Mở bài gốc</a>
          <button className="btn-ghost" onClick={onClose} aria-label="Đóng"><X className="h-4 w-4" /></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2">
          {/* source evidence (read-only) */}
          <div className="space-y-3 border-r p-4 text-sm">
            <h3 className="text-xs font-bold uppercase text-slate-500">Nội dung bóc tách từ báo (chỉ đọc)</h3>
            <div className="text-xs text-slate-600">
              {a.sourceName} · <a className="text-blue-700 underline" href={a.originalUrl} target="_blank" rel="noreferrer">{a.originalUrl}</a>
              {a.author && <> · Tác giả: {a.author}</>}
            </div>
            <div className={`rounded border p-2 text-xs ${a.extractionCompleteness === 'auto_checks_passed' ? 'border-green-200 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
              <b>Độ đầy đủ:</b> {a.extractionCompleteness === 'auto_checks_passed' ? 'Đạt các kiểm tra tự động (chưa phải xác nhận của người duyệt)' : a.extractionCompleteness === 'partial' ? 'Có dấu hiệu thiếu nội dung' : 'Lỗi'}
              {a.extractionWarnings.map((w) => <div key={w} className="text-amber-900">⚠ {w}</div>)}
              {(() => {
                const pub = (a as Article & { publicSections?: { paragraphs: number; headings: number; tables: number; figures: number } }).publicSections;
                const k = pub ?? {
                  paragraphs: a.contentSections.filter((s) => s.type === 'paragraph').length, headings: a.contentSections.filter((s) => s.type === 'heading').length,
                  tables: a.contentSections.filter((s) => s.type === 'table').length, figures: a.contentSections.filter((s) => s.type === 'figure').length,
                };
                return (
                  <div className="mt-1">
                    Bộ bóc tách: {a.extractionAdapterVersion} · {k.paragraphs} đoạn · {k.headings} tiêu đề phụ · {k.tables} bảng · {k.figures} ảnh
                    {(a as Article & { bodyDeferred?: boolean }).bodyDeferred && <div className="mt-1 text-slate-600" data-testid="body-loading">Đang tải toàn văn bài…</div>}
                    {pub && <div className="mt-1 text-slate-600">Kỳ này được đăng trước khi web có toàn văn bài – bấm "Mở bài gốc" để đọc đầy đủ (các lượt thu thập mới có đủ nội dung).</div>}
                  </div>
                );
              })()}
              <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={!!r?.extractionMarkedComplete} onChange={(e) => onPatch({ extractionMarkedComplete: e.target.checked })} /> Tôi đã đối chiếu bài gốc – xác nhận đủ nội dung quan trọng</label>
            </div>
            <div className="rounded border border-slate-200 p-2 text-xs">
              <b>Bằng chứng giờ đăng</b> ({a.dateConfidence === 'verified' ? 'đã xác minh' : a.dateConfidence === 'inferred' ? 'suy đoán' : 'không rõ'}): {a.publishedAt ? formatVn(a.publishedAt) : '—'}
              {a.modifiedAt && <> · cập nhật {formatVn(a.modifiedAt)} (không dùng để lọc)</>}
              <ul className="mt-1">{a.dateEvidence.map((d, i) => <li key={i}>[{d.source}/{d.field}] "{d.raw}" → {d.value ?? 'không đọc được'}</li>)}</ul>
              {a.dateConfidence !== 'verified' && <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={!!r?.timeVerifiedManually} onChange={(e) => onPatch({ timeVerifiedManually: e.target.checked })} /> Tôi đã kiểm tra giờ đăng trên bài gốc</label>}
            </div>
            <div className="rounded border border-slate-200 p-2 text-xs">
              <b>Địa bàn:</b> {a.location.status} – {a.location.evidence.slice(0, 4).join(' · ')}
              <br />
              <b>Lĩnh vực (gợi ý):</b> {a.classificationEvidence.join(' · ') || '—'}
              <br />
              <b>Tính chất (gợi ý):</b> {a.assessmentEvidence.join(' · ')}
            </div>
            <h4 className="text-base font-bold">{a.title}</h4>
            {a.sapo && <p className="font-semibold text-slate-700">{a.sapo}</p>}
            <div className="space-y-2">
              {a.contentSections.map((s) =>
                s.type === 'heading' ? <h5 key={s.ordinal} className="font-bold text-navy-700">{s.text}</h5>
                : s.type === 'table' ? (
                  <table key={s.ordinal} className="w-full border text-xs">
                    {s.caption && <caption className="text-left italic">{s.caption}</caption>}
                    <tbody>{s.rows?.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border px-1">{cell}</td>)}</tr>)}</tbody>
                  </table>
                ) : s.type === 'figure' ? <p key={s.ordinal} className="rounded bg-slate-50 p-1 text-xs italic">[Ảnh] {s.caption || '(không có chú thích)'}</p>
                : s.type === 'list_item' ? <li key={s.ordinal} className="ml-4">{s.text}</li>
                : <p key={s.ordinal}>{s.text}</p>,
              )}
            </div>
          </div>
          {/* editorial overlay */}
          <div className="space-y-3 p-4">
            <h3 className="text-xs font-bold uppercase text-slate-500">Biên tập cho báo cáo (không sửa dữ liệu gốc)</h3>
            {mergedInto ? (
              <div className="rounded border border-purple-200 bg-purple-50 p-2 text-xs">
                Bài này đã được <b>gộp làm nguồn phụ</b> của tin: <button className="text-blue-700 underline" onClick={() => onOpen(mergedInto.id)}>{mergedInto.title}</button>
                <button className="btn-ghost btn-xs ml-2" onClick={() => onSplit(a.id)}>Tách ra thành tin riêng</button>
              </div>
            ) : (
              <>
                <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-600" checked={!!r?.included} onChange={(e) => onPatch({ included: e.target.checked, order: r?.order ?? Date.now() % 1e6 })} /> Đưa vào báo cáo</label>
                <MergePanel primaryId={a.id} arts={arts} reviews={reviews} onMerge={onMerge} onSplit={onSplit} />
              </>
            )}
            <div>
              <span className="label">Tính chất tin</span>
              <div className="flex gap-1">
                {ASSESS.map((x) => <button key={x} className={`chip ${asm === x ? ASSESS_COLOR[x] + ' font-bold' : 'border-slate-300 bg-white'}`} onClick={() => onPatch({ assessment: x })}>{ASSESSMENT_LABEL[x]}</button>)}
              </div>
              {!r?.assessment && <p className="text-xs text-amber-700">Đang là gợi ý tự động – bấm để xác nhận.</p>}
            </div>
            <label className="block">
              <span className="label">Lĩnh vực chính</span>
              <select className="input" value={r?.primaryCategory ?? a.primaryCategory ?? ''} onChange={(e) => onPatch({ primaryCategory: (e.target.value || null) as CategoryCode | null })}>
                <option value="">Chưa phân loại</option>
                {settings.categories.map((c2) => <option key={c2.code} value={c2.code}>{c2.label}</option>)}
              </select>
            </label>
            <label className="block"><span className="label">Tiêu đề trên báo cáo ({title.length}/120)</span><input className={`input ${title.length > 120 ? 'border-amber-500' : ''}`} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} /></label>
            <label className="block"><span className="label">Nhãn ngắn trên bìa ({short.length}/42)</span><input className={`input ${short.length > 42 ? 'border-amber-500' : ''}`} value={short} onChange={(e) => setShort(e.target.value)} onBlur={save} /></label>
            <label className="block">
              <span className="label">Tóm tắt ({summary.length}/{max})</span>
              <textarea className={`input ${summary.length > max ? 'border-amber-500' : ''}`} rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={save} />
              {summary.length > max && <span className="text-xs text-amber-700">Dài hơn khung – rút gọn để tránh tràn trang.</span>}
              {missingNums.length > 0 && <span className="block text-xs text-red-700">⚠ Số liệu không có trong bài gốc: {missingNums.join(', ')} – kiểm tra lại, không thêm dữ kiện ngoài bài.</span>}
            </label>
            {asm === 'needs_attention' && (
              <div className="block" data-testid="proposal-box">
                <label className="block">
                  <span className="label">Đề xuất giao đơn vị (DỰ THẢO – cần lãnh đạo duyệt)</span>
                  <textarea className="input" rows={2} placeholder={suggested.text} value={proposal} onChange={(e) => setProposal(e.target.value)} onBlur={save} aria-label="Đề xuất giao đơn vị" />
                </label>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>
                    Gợi ý{suggested.rule ? ` (nhóm "${suggested.rule}": ${suggested.evidence.slice(0, 4).join(', ')})` : ' (không khớp nhóm nào – câu chung)'}: <i>{suggested.text}</i>
                    {!proposal && ' – để trống thì báo cáo dùng gợi ý này.'}
                  </span>
                  {proposal !== suggested.text && (
                    <button className="btn-ghost btn-xs" onClick={() => (setProposal(suggested.text), onPatch({ title, summary, shortLabel: short, proposal: suggested.text }))}>Dùng gợi ý</button>
                  )}
                </div>
              </div>
            )}
            <div>
              <span className="label">Ảnh báo gốc (chỉ ảnh thật từ bài)</span>
              <div className="grid grid-cols-3 gap-2">
                {a.imageCandidates.map((im) => {
                  const chosen = (r?.primaryImageUrl === undefined ? a.imageCandidates[0]?.url : r.primaryImageUrl) === im.url;
                  return (
                    <button key={im.url} className={`overflow-hidden rounded border text-left text-[10px] ${chosen ? 'ring-2 ring-teal-500' : ''}`} onClick={() => pickPhoto(im.url)}>
                      <img src={im.url} alt={im.caption ?? ''} referrerPolicy="no-referrer" className="h-20 w-full bg-slate-100 object-cover" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
                      <div className="p-1">{im.origin} · quyền: {im.rightsStatus === 'review' ? 'cần xem' : im.rightsStatus}{im.credit && ` · ${im.credit}`}</div>
                    </button>
                  );
                })}
                <button className={`rounded border p-2 text-xs ${r?.primaryImageUrl === null ? 'ring-2 ring-teal-500' : ''}`} onClick={() => pickPhoto(null)}>Không dùng ảnh (bố cục chữ)</button>
                {photoSaved && <span className="self-center text-sm font-medium text-green-700" data-testid="photo-saved">✓ Đã đổi ảnh (thẻ tin và báo cáo dùng ảnh này)</span>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary" onClick={saveNow} disabled={saveState === 'saving'}>{saveState === 'saving' ? 'Đang lưu…' : 'Lưu biên tập'}</button>
              {saveState === 'saved' && <span className="text-sm font-medium text-green-700" data-testid="edit-saved">✓ Đã lưu cho cả nhóm</span>}
              {saveState === 'nochange' && <span className="text-sm text-slate-500" data-testid="edit-saved">✓ Đã lưu – không có thay đổi mới</span>}
              {saveState === 'error' && <span className="text-sm text-red-700">Chưa lưu được – thử lại</span>}
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-2">
              <span className="label">Góp ý cho bộ lọc (vì sao bài này nên/không nên được thu thập, lĩnh vực đúng là gì…)</span>
              <div className="mb-1 flex gap-1">
                <RelevanceButtons r={r} onPatch={onPatch} title={a.title} />
              </div>
              <textarea className="input text-xs" rows={2} defaultValue={r?.reviewNote ?? ''} placeholder="Ví dụ: tin thể thao của Bộ Xây dựng, không phải tin ngành" onBlur={(e) => e.target.value !== (r?.reviewNote ?? '') && onPatch({ reviewNote: e.target.value.slice(0, 1000) })} aria-label="Ghi chú góp ý cho bộ lọc" />
            </div>
            {r?.changes?.length ? (
              <details className="text-xs text-slate-600"><summary>Lịch sử chỉnh sửa ({r.changes.length})</summary>{r.changes.slice(-20).map((ch, i) => <div key={i}>{new Date(ch.at).toLocaleString('vi-VN')} · {ch.field}</div>)}</details>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportPanel({ run, arts, reviews, settings, onPatch, onInspect, onMerge, onSplit }: { run: RunInfo; arts: Map<string, Article>; reviews: Record<string, ReviewDecision>; settings: Settings; onPatch: (id: string, p: Partial<ReviewDecision>) => void; onInspect: (id: string) => void; onMerge: (s: string, p: string) => void; onSplit: (s: string) => void }) {
  const toast = useToast();
  const [res, setRes] = useState<ExportResult | null>(null);
  const [formats, setFormats] = useState<ExportFormat[]>(settings.report.outputFormats);
  const [busy, setBusy] = useState(false);
  // report template: Department template from the Skill (default), 4 original designs, or the uploaded one
  const [tpls, setTpls] = useState<TemplateOption[]>([]);
  const [tplId, setTplId] = useState(settings.report.templateId);
  useEffect(() => {
    api.templates().then((r) => (setTpls(r.templates), setTplId((cur) => (r.templates.some((x) => x.id === cur) ? cur : r.defaultId)))).catch(() => setTpls([]));
  }, []);
  const sel = Object.values(reviews).filter((r) => r.included && !r.groupId).sort((a, b) => a.order - b.order || a.articleId.localeCompare(b.articleId));
  const go = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api.exportRun(run.runId, formats, dryRun, tplId);
      setRes(r);
      if (r.ok) toast('ok', `Đã xuất ${r.files?.length ?? 0} tệp`);
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    go(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(Object.values(reviews).map((s) => [s.articleId, s.included, s.groupId, s.assessment, s.summary, s.timeVerifiedManually]))]);
  /** ↑ / ↓ inside a group (as shown on the slides): swap, then number the group 1..n so equal old numbers cannot block the move */
  const move = (list: ReviewDecision[], i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    const base = Math.min(...list.map((r) => r.order));
    next.forEach((r, k) => r.order !== base + k && onPatch(r.articleId, { order: base + k }));
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <div className="card p-3">
        <h3 className="mb-2 font-semibold text-navy-700">Tin đã chọn ({sel.length}) – thứ tự trên slide</h3>
        {sel.length === 0 && <p className="text-sm text-slate-500">Chưa chọn tin nào. Tích ô "chọn" ở danh sách bài.</p>}
        {ASSESS.map((g) => {
          const list = sel.filter((r) => (r.assessment ?? arts.get(r.articleId)?.suggestedAssessment) === g);
          if (!list.length) return null;
          return (
            <div key={g} className="mb-3">
              <h4 className={`mb-1 text-xs font-bold uppercase ${ASSESS_COLOR[g].split(' ')[0]}`}>{ASSESSMENT_LABEL[g]} ({list.length})</h4>
              {list.map((r) => {
                const a = arts.get(r.articleId);
                const i = list.indexOf(r);
                const nMerged = secondariesOf(r.articleId, reviews).length;
                const pubs = [a?.sourceName, ...secondariesOf(r.articleId, reviews).map((id) => arts.get(id)?.sourceName)].filter(Boolean);
                return (
                  <div key={r.articleId} className="mb-1 rounded border border-slate-200 p-2 text-sm">
                    <div className="flex items-center gap-2">
                      <button className="btn-ghost btn-xs disabled:opacity-30" disabled={i === 0} onClick={() => move(list, i, -1)} aria-label="Lên"><ArrowUp className="h-3 w-3" /></button>
                      <button className="btn-ghost btn-xs disabled:opacity-30" disabled={i === list.length - 1} onClick={() => move(list, i, 1)} aria-label="Xuống"><ArrowDown className="h-3 w-3" /></button>
                      <span className="flex-1">{r.title ?? a?.title}{!r.assessment && <span className="ml-1 text-xs text-amber-700">(tính chất là gợi ý)</span>}</span>
                      <button className="btn-ghost btn-xs" onClick={() => onInspect(r.articleId)}>Biên tập</button>
                      <button className="btn-danger btn-xs" onClick={() => onPatch(r.articleId, { included: false })}>Bỏ</button>
                    </div>
                    <details className="mt-1" open={nMerged > 0 || !!a?.duplicateGroupId}>
                      <summary className="cursor-pointer text-xs text-slate-600">Nguồn: {[...new Set(pubs)].join('  |  ')}{a?.duplicateGroupId && nMerged === 0 ? ' · có bài có thể cùng sự kiện' : ''}</summary>
                      <MergePanel primaryId={r.articleId} arts={arts} reviews={reviews} onMerge={onMerge} onSplit={onSplit} />
                    </details>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="card space-y-3 p-3">
        <h3 className="font-semibold text-navy-700">Xuất báo cáo</h3>
        {/* every template visible at once (tick one) – not hidden in a drop-down */}
        <fieldset className="space-y-1.5" role="radiogroup" aria-label="Mẫu báo cáo" data-testid="template-picker">
          <legend className="label mb-1">Mẫu báo cáo ({tpls.length})</legend>
          {tpls.length === 0 && <p className="text-xs text-red-700">Không tải được danh sách mẫu – tải lại trang.</p>}
          {tpls.map((x) => {
            const on = x.id === tplId;
            return (
              <label key={x.id} className={`flex cursor-pointer items-start gap-2 rounded border p-2 text-sm ${on ? 'border-teal-600 bg-teal-50' : 'border-slate-200 hover:bg-slate-50'} ${x.available === false ? 'cursor-not-allowed opacity-50' : ''}`}>
                <input type="radio" name="report-template" className="mt-1" value={x.id} checked={on} disabled={x.available === false} onChange={() => setTplId(x.id)} aria-label={x.name} />
                <span className="min-w-0">
                  <span className="font-medium">{x.name}</span>
                  <span className="ml-1 text-xs text-slate-500">· {x.orientation === 'landscape' ? 'trang ngang 16:9' : 'A4 dọc'}{x.kind === 'original-pptx' ? ' · tệp PowerPoint gốc' : x.kind === 'upload' ? ' · tệp của bạn' : ''}{x.available === false ? ' · thiếu tệp' : ''}</span>
                  {on && <span className="mt-0.5 block text-xs text-slate-600" data-testid="template-info">{x.description}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="flex gap-4">
          {(['pptx', 'docx', 'pdf'] as const).map((f) => (
            <label key={f} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={formats.includes(f)} onChange={(e) => setFormats(e.target.checked ? [...formats, f] : formats.filter((x) => x !== f))} /> .{f}</label>
          ))}
        </div>
        {res?.blockers?.length ? <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800"><b>Chưa thể xuất:</b>{res.blockers.map((b) => <div key={b}>• {b}</div>)}</div> : null}
        {res?.warnings?.length ? <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><b>Cảnh báo:</b>{res.warnings.map((b) => <div key={b}>• {b}</div>)}</div> : null}
        <button className="btn-teal w-full justify-center" disabled={busy || !!res?.blockers?.length || formats.length === 0} onClick={() => go(false)}>
          <Download className="h-4 w-4" /> {busy ? 'Đang xuất…' : 'Xuất báo cáo'}
        </button>
        {res?.ok && (
          <div className="text-xs">
            <p className="font-semibold text-green-700">Đã tạo:</p>
            {res.files?.map((f) => <a key={f} className="block text-blue-700 underline" href={api.exportUrl(f)}>{f}</a>)}
            {res.pdfStatus && res.pdfStatus !== 'ok' && res.pdfStatus !== 'not_requested' && <p className="text-amber-800">PDF: {res.pdfStatus}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
const RUN_KIND: Record<string, string> = { auto: 'lượt tự động theo lịch', request: 'lượt thu thập theo yêu cầu', deploy: 'cập nhật phần mềm & dữ liệu (sau khi đẩy mã mới)' };

/** web: hourly automatic switch + what the collection server is doing now */
function ServerStrip({ server, profileId, remote, onToggle, onEditTimes }: { server: ServerStatus; profileId: string; remote: boolean; onToggle: (slot: ScheduleSlot, on: boolean) => void; onEditTimes: () => void }) {
  const prof = server.profiles.find((p) => p.id === profileId);
  const slots = slotsFor(prof?.scheduleTimes);
  const next = nextRun(prof?.schedule, new Date(), prof?.scheduleDone, slots);
  const run = server.running[0];
  const who = run?.kind === 'request' ? personName(/\((.*)\)(?:\s*\[[^\]]*\])?\s*$/.exec(run.title)?.[1] ?? '') || undefined : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm" data-testid="server-status">
      <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700" title="Tự động thu thập theo giờ cố định cho địa bàn đang chọn">
        <AlarmClock className="h-4 w-4 text-teal-600" /> Tự động
      </span>
      <div className="flex flex-wrap items-center gap-4" data-testid="auto-schedule">
        {slots.map((s) => (
          <Switch key={s.id} label={s.at} title={adminOnly() ? `${s.at} – ${s.label} (${ADMIN_HINT} bật/tắt)` : `${s.at} – ${s.label}`} ariaLabel={`Tự động lúc ${s.at}`} checked={!!prof?.schedule?.[s.id]} disabled={!server.collectEnabled || adminOnly()} onChange={(on) => onToggle(s, on)} />
        ))}
        <button
          type="button"
          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-teal-300 bg-teal-50 px-3.5 py-1.5 text-sm font-semibold text-teal-800 shadow-sm transition hover:border-teal-400 hover:bg-teal-100 active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
          onClick={onEditTimes}
          data-testid="edit-times"
          title="Đổi giờ chạy và khung giờ lấy tin của từng lượt (Cài đặt › Thời gian)"
        >
          <Clock3 className="h-4 w-4" /> Đổi giờ
        </button>
      </div>
      {(() => {
        // collection token: refused, or expiring within 30 days → everyone sees it, one click opens Cài đặt › Thời gian
        const t = server.token;
        const left = t?.expiresAt ? Math.floor((Date.parse(t.expiresAt) - Date.now()) / 86400_000) : null;
        if (!t || (!t.rejected && (left === null || left >= 30))) return null;
        const text = t.rejected || (left !== null && left < 0) ? 'Khóa thu thập đã hết hạn – Thu thập và lịch tự động đang dừng' : `Khóa thu thập hết hạn sau ${left} ngày – cần làm mới`;
        return (
          <button type="button" onClick={onEditTimes} data-testid="token-warning" className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${t.rejected || (left ?? 0) < 0 ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`} title="Mở Cài đặt › Thời gian › Khóa thu thập">
            <AlertTriangle className="h-3.5 w-3.5" /> {text}
          </button>
        );
      })()}
      <span className="text-xs text-slate-500" data-testid="auto-info" title={next ? 'Dữ liệu có sau khoảng 5–10 phút; máy chủ bận thì tự thử lại' : 'Chỉ thu thập khi có người bấm Thu thập'}>
        {next ? <>Tiếp: <b className="text-slate-700">{next.slot.at} {next.at.slice(8, 10)}/{next.at.slice(5, 7)}/{next.at.slice(0, 4)}</b></> : 'Đang tắt'}
      </span>
      {run ? (
        <span className="inline-flex items-center gap-2 text-xs font-medium text-amber-800" data-testid="server-busy" title={!remote ? 'Nút Thu thập mở lại khi xong' : undefined}>
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Máy chủ đang {run.status === 'queued' ? 'xếp hàng' : 'chạy'}: {RUN_KIND[run.kind ?? 'deploy']}
          {who ? ` (${who})` : ''} · {hhmm(run.createdAt)}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" data-testid="server-idle" title="Có thể bấm Thu thập">
          <span className="h-2 w-2 rounded-full bg-green-500" /> Máy chủ rảnh
        </span>
      )}
    </div>
  );
}

/** on/off switch (a real checkbox underneath: keyboard, screen readers and tests work as before) */
function Switch({ label, title, ariaLabel, checked, disabled, onChange }: { label: string; title?: string; ariaLabel: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`} title={title}>
      <span className="relative inline-flex h-5 w-9 shrink-0">
        <input type="checkbox" className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="absolute inset-0 rounded-full bg-slate-300 transition-colors peer-checked:bg-teal-600 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-400 peer-focus-visible:ring-offset-1" />
        <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
      <span className="font-semibold tabular-nums text-slate-700">{label}</span>
    </label>
  );
}
