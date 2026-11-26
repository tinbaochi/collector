/**
 * Hourly cloud collection for the public read-only dashboard (GitHub Actions → GitHub Pages).
 *
 *  - Collects the IN-PROGRESS window (17:00 → 08:00, when one is running) and the LAST COMPLETED window
 *    (re-collected until 2 h after it ended, then frozen).
 *  - Publishes the dataset to web/public/live/: titles, links, sapo, FULL article text (owner's decision, 15/11/2026,
 *    so the web matches the local app), publication time, classification, candidate ledger, coverage and adapter health.
 *    Photos are published as LINKS only (loaded from the publisher, like the local app), never copied.
 *  - Previous days are carried over from the currently deployed site (and give the adapter-health baseline).
 *  - One dataset per PROFILE (cấu hình theo địa bàn) under live/<profileId>/, list in live/profiles.json. Config per
 *    profile from the web (review worker), else deploy/config.json / repo defaults for the default TP.HCM profile.
 *
 * Usage: npx tsx scripts/cloud-collect.ts [--site <deployed site>] [--out web/public/live] [--profile <id>] [--from … --to … --requested-by …]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpClient } from '../src/collector/http.js';
import { reconcile, runCollection, stateFor } from '../src/collector/run.js';
import { annotateArticle } from '../src/domain/relevance.js';
import { defaultSettings, defaultSources } from '../src/domain/defaults.js';
import { DEFAULT_PROFILE_ID, SettingsSchema, SourceSchema, type Article, type Candidate, type ImageCandidate, type RunManifest, type Settings, type Source } from '../src/domain/schemas.js';
import { hash32 } from '../src/domain/text.js';
import { lastCompletedWindow, toVnIso, vnDate, windowForReportDate } from '../src/domain/timeWindow.js';
import { makePaths, Stores } from '../src/storage/stores.js';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : def;
};
const SITE = arg('--site', 'https://tinbaochi.github.io/');
const OUT = arg('--out', 'web/public/live');
const KEEP_DAYS = 14;
const FREEZE_AFTER_H = 2;

export interface PublicArticle {
  id: string; sourceId: string; sourceName: string; url: string; title: string; sapo: string; /** full text (bodyText is rebuilt from these in the browser) */ contentSections: Article['contentSections']; author: string | null; publishedAt: string | null; modifiedAt: string | null;
  dateConfidence: Article['dateConfidence']; extractionCompleteness: Article['extractionCompleteness']; extractionWarnings: string[];
  sections: { paragraphs: number; headings: number; tables: number; figures: number }; location: Article['location']; relevance: Article['relevance'];
  primaryCategory: Article['primaryCategory']; classificationEvidence: string[]; suggestedAssessment: Article['suggestedAssessment']; assessmentEvidence: string[];
  duplicateGroupId: string | null; dateEvidence: Article['dateEvidence'];
  /** body container used by the extractor (adapter-drift detection when the article is carried into the next hourly run); absent in data published before 17/11/2026 */
  extractionContainer?: string | null;
  /** photo LINKS only (the browser loads them from the publisher, like the local app); no copies are published */
  images: Array<Pick<ImageCandidate, 'url' | 'caption' | 'credit' | 'origin' | 'rightsStatus'>>;
}
export interface PublicDay {
  kind: 'hcm-live-day'; reportDate: string; provisional: boolean; generatedAt: string;
  /** file stem: "2026-11-16" for daily periods, "custom-202611141700-202611150800" for on-demand windows */
  key?: string; custom?: boolean; requestedBy?: string; scheduled?: string;
  manifest: RunManifest & { reconciliation: ReturnType<typeof reconcile> }; candidates: Array<Omit<Candidate, 'history'>>; articles: PublicArticle[];
}
export interface PublicIndex {
  kind: 'hcm-live-index'; generatedAt: string; schedule: string;
  days: Array<{ reportDate: string; key?: string; file?: string; lite?: string; custom?: boolean; requestedBy?: string; scheduled?: string; window: { from: string; to: string }; provisional: boolean; generatedAt: string; counts: Record<string, number>; completeness: RunManifest['completeness'] }>;
}
const KEEP_CUSTOM = 10;
const keyOf = (d: { key?: string; reportDate: string }) => d.key ?? d.reportDate;
/** the period without the full text of excluded stories (marked bodyDeferred) */
export function liteDay<T extends { articles: Array<{ relevance?: { status?: string }; contentSections?: unknown[] }> }>(d: T): T {
  return { ...d, articles: d.articles.map((a) => (a.relevance?.status === 'irrelevant' && a.contentSections?.length ? { ...a, contentSections: [], bodyDeferred: true } : a)) };
}
const stamp = (iso: string) => iso.slice(0, 16).replace(/[-:T]/g, '');
const VN_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+07:00$/;

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(' ', n - 1) > n / 2 ? s.lastIndexOf(' ', n - 1) : n - 1)}…`);

export function toPublicArticle(a: Article): PublicArticle {
  const count = (t: string) => a.contentSections.filter((s) => s.type === t).length;
  return {
    id: a.id, sourceId: a.sourceId, sourceName: a.sourceName, url: a.canonicalUrl ?? a.originalUrl, title: a.title, sapo: a.sapo, contentSections: a.contentSections, author: a.author,
    publishedAt: a.publishedAt, modifiedAt: a.modifiedAt, dateConfidence: a.dateConfidence, extractionCompleteness: a.extractionCompleteness,
    extractionWarnings: a.extractionWarnings, sections: { paragraphs: count('paragraph'), headings: count('heading'), tables: count('table'), figures: count('figure') },
    location: a.location, relevance: a.relevance, primaryCategory: a.primaryCategory, classificationEvidence: a.classificationEvidence,
    suggestedAssessment: a.suggestedAssessment, assessmentEvidence: a.assessmentEvidence, duplicateGroupId: a.duplicateGroupId, dateEvidence: a.dateEvidence,
    // undefined (carried-over article, container unknown) stays absent – null would read as "no container found" = false drift
    extractionContainer: a.extractionContainer,
    images: a.imageCandidates.filter((i) => /^https:\/\//.test(i.url) && i.rightsStatus !== 'not_usable').slice(0, 3)
      .map((i) => ({ url: i.url, caption: i.caption ? cut(i.caption, 200) : undefined, credit: i.credit, origin: i.origin, rightsStatus: i.rightsStatus })),
  };
}

/** Published article → stored Article (same rule as web/src/api.ts fromPublic). Only the published photo links survive; bodyText is rebuilt like the extractor does. */
export function fromPublicArticle(p: PublicArticle, runId: string, collectedAt: string): Article {
  return {
    id: p.id, runId, sourceId: p.sourceId, sourceName: p.sourceName, originType: 'website', originalUrl: p.url, canonicalUrl: p.url, title: p.title, sapo: p.sapo,
    bodyText: (p.contentSections ?? []).filter((s) => s.type !== 'figure').map((s) => s.text).join('\n'), contentSections: p.contentSections ?? [], articleLinks: [],
    author: p.author, publishedAt: p.publishedAt, modifiedAt: p.modifiedAt, collectedAt, dateConfidence: p.dateConfidence, dateEvidence: p.dateEvidence ?? [],
    // container: undefined = not evidence for this run's adapter-health check (only articles fetched in this run are).
    // A previous run's ADAPTER_DEGRADED downgrade is undone; this run re-assesses health and re-applies it if still degraded.
    extractionAdapterVersion: 'carried-over', extractionContainer: undefined,
    extractionCompleteness: (p.extractionWarnings ?? []).some((w) => w.startsWith('ADAPTER_DEGRADED')) && p.extractionCompleteness === 'partial' && (p.extractionWarnings ?? []).every((w) => w.startsWith('ADAPTER_DEGRADED')) ? 'auto_checks_passed' : p.extractionCompleteness,
    extractionWarnings: (p.extractionWarnings ?? []).filter((w) => !w.startsWith('ADAPTER_DEGRADED')),
    continuation: { detected: false, urls: [] }, location: p.location, relevance: p.relevance, primaryCategory: p.primaryCategory, secondaryCategories: [],
    classificationEvidence: p.classificationEvidence ?? [], suggestedAssessment: p.suggestedAssessment, assessmentEvidence: p.assessmentEvidence ?? [],
    imageCandidates: (p.images ?? []).map((i) => ({ ...i, sourceArticleUrl: p.url })), duplicateGroupId: p.duplicateGroupId, warnings: [],
  };
}

/**
 * Hourly runs of the SAME period continue the previous publication instead of starting empty: its ledger and articles are
 * loaded into the run store under the same run id, so runCollection resumes – extracted stories stay (with their ids, so
 * team labels stay attached) and the per-publisher fetch limit is spent on links not fetched yet.
 * Without this, a story extracted at 21:07 could fall back to "retry_pending (FETCH_LIMIT)" or leave the RSS feed by 06:07
 * and disappear from the published period. Only when the window and settings are unchanged (otherwise: fresh run).
 * Returns the number of carried-over articles, or null when not seeded.
 */
export async function seedFromPublished(
  stores: Stores, runId: string, day: PublicDay | undefined, window: { from: string; to: string }, settings: Settings,
): Promise<{ carried: number; reclassified: boolean } | null> {
  if (!day?.manifest || !Array.isArray(day.candidates)) return null;
  if (day.manifest.window.from !== window.from || day.manifest.window.to !== window.to) return null;
  const hash = hash32(JSON.stringify(settings));
  const reclassified = day.manifest.settingsHash !== hash;
  let arts = (day.articles ?? []).map((p) => fromPublicArticle(p, runId, day.generatedAt));
  const verdicts = new Map<string, ReturnType<typeof annotateArticle>['_verdict']>();
  if (reclassified) {
    // the settings changed (keywords, places, rules…): the stories already read are judged again with the new settings – no download
    arts = arts.map((a) => {
      const { _verdict, ...b } = annotateArticle(a, settings);
      verdicts.set(b.id, _verdict);
      return { ...b, extractionContainer: undefined };
    });
  }
  const byId = new Map(arts.map((a) => [a.id, a]));
  // extracted-but-unpublished (outside the window) keep their terminal state; their article was never published
  const cands: Candidate[] = day.candidates.map((c) => {
    const base: Candidate = {
      ...c, runId, history: [], articleId: c.articleId && byId.has(c.articleId) ? c.articleId : null,
      // stale "adapter degraded" flag from the previous run → cleared, re-assessed in this run
      ...(c.reasonCode === 'ADAPTER_DEGRADED' ? { reasonCode: null, reasonDetail: null } : {}),
    };
    if (!reclassified) return base;
    const a = base.articleId ? byId.get(base.articleId) : undefined;
    if (a) {
      const [state, reasonCode, reasonDetail] = stateFor(a, verdicts.get(a.id)!, window);
      return { ...base, state, reasonCode, reasonDetail };
    }
    // excluded from the URL alone (section / not an article page) → looked at again with the new settings
    if (base.state === 'irrelevant_with_evidence') return { ...base, state: 'discovered', reasonCode: null, reasonDetail: null };
    return base;
  });
  const { reconciliation: _r, ...m } = day.manifest;
  await stores.saveManifest({ ...m, runId, sources: [], notes: [], counts: {}, settingsHash: hash });
  await stores.saveCandidates(runId, cands);
  if (arts.length) await stores.appendArticles(runId, arts);
  return { carried: arts.length, reclassified };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache' } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** profiles published on the web (worker store); without a worker: the default TP.HCM profile only */
export interface PublicProfile { id: string; name: string; description: string; autoCollect: boolean; regionName?: string }
const API = () => process.env.REVIEW_API_URL?.trim().replace(/\/$/, '') ?? '';

async function loadProfiles(): Promise<PublicProfile[]> {
  const fallback = [{ id: DEFAULT_PROFILE_ID, name: 'TP.HCM', description: '', autoCollect: true }];
  if (!API()) return fallback;
  const j = await getJson<{ profiles: PublicProfile[] }>(`${API()}/profiles`);
  return j?.profiles?.length ? j.profiles : fallback;
}

/**
 * Configuration of one profile, in priority order: (1) the shared configuration edited on the web (Cài đặt, stored by
 * the review worker), (2) deploy/config.json (TP.HCM only), (3) repo defaults (TP.HCM only). An invalid web
 * configuration is reported and skipped, never half-applied. Other profiles without a configuration are not collected.
 */
async function loadConfig(profileId: string): Promise<{ settings: Settings; sources: Source[]; origin: string } | null> {
  if (API()) {
    const j = await getJson<{ config: { settings: unknown; sources: unknown; by: string; at: string } | null }>(`${API()}/config?profile=${encodeURIComponent(profileId)}`);
    if (j?.config) {
      const s = SettingsSchema.safeParse(j.config.settings);
      const src = SourceSchema.array().safeParse(j.config.sources);
      if (s.success && src.success) return { settings: s.data, sources: src.data, origin: `web config (${j.config.by}, ${j.config.at})` };
      console.warn(`[${profileId}] web config ignored (invalid): ${(s.error ?? src.error)?.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
  }
  if (profileId !== DEFAULT_PROFILE_ID) return null;
  const f = 'deploy/config.json';
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { settings: SettingsSchema.parse(j.settings), sources: SourceSchema.array().parse(j.sources), origin: f };
  }
  return { settings: defaultSettings(), sources: defaultSources(readFileSync('src/domain/data/skill-websites.txt', 'utf8')), origin: 'repo defaults (Skill)' };
}

/** periods already published for a profile (TP.HCM: also the pre-profile location live/index.json) */
async function previousDays(profileId: string): Promise<Map<string, PublicDay>> {
  const dirs = profileId === DEFAULT_PROFILE_ID ? [`live/${profileId}/`, 'live/'] : [`live/${profileId}/`];
  const prevDays = new Map<string, PublicDay>();
  for (const dir of dirs) {
    const prevIndex = await getJson<PublicIndex>(new URL(`${dir}index.json`, SITE).toString());
    if (!prevIndex) continue;
    for (const d of prevIndex.days ?? []) {
      const day = await getJson<PublicDay>(new URL(`${dir}${d.file ?? `${d.reportDate}.json`}`, SITE).toString());
      if (day) prevDays.set(keyOf(d), { ...day, key: keyOf(d), custom: d.custom, requestedBy: d.requestedBy });
    }
    break;
  }
  return prevDays;
}

async function collectProfile(profile: PublicProfile, collect: boolean, now: Date): Promise<{ regionName?: string; periods: number }> {
  const out = path.join(OUT, profile.id);
  mkdirSync(out, { recursive: true });
  const prevDays = await previousDays(profile.id);
  const published = new Map<string, PublicDay>(prevDays);
  const cfg = collect ? await loadConfig(profile.id) : null;
  if (collect && !cfg) console.warn(`[${profile.id}] no configuration saved on the web yet – not collected`);
  console.log(`[${profile.id}] ${collect && cfg ? `collect; config: ${cfg.origin}` : 'carry over only'}; previously published periods: ${prevDays.size}`);

  if (cfg) {
    const { settings, sources, origin } = cfg;
    const { startClock, endClock } = settings.reportWindow;
    // windows to collect now: an on-demand window (--from/--to from the web "Thu thập" button) OR the hourly periods
    const reqFrom = arg('--from', '');
    const reqTo = arg('--to', '');
    const requestedBy = arg('--requested-by', '').slice(0, 40);
    // automatic run at a fixed time (review worker cron, src/domain/schedule.ts): "08:00" / "16:30"
    const scheduled = /^\d{2}:\d{2}$/.test(arg('--scheduled', '')) ? arg('--scheduled', '') : '';
    const jobs: Array<{ key: string; reportDate: string; window: { from: string; to: string }; provisional: boolean; custom?: boolean }> = [];
    if (reqFrom || reqTo) {
      if (!VN_ISO.test(reqFrom) || !VN_ISO.test(reqTo) || !(Date.parse(reqTo) > Date.parse(reqFrom)) || Date.parse(reqTo) - Date.parse(reqFrom) > 72 * 3600_000) {
        throw new Error(`invalid on-demand window: ${reqFrom} → ${reqTo}`);
      }
      const window = { from: toVnIso(new Date(reqFrom)), to: toVnIso(new Date(reqTo)) };
      // exactly the window of a published daily period → that period is refreshed in place (continued + re-classified),
      // e.g. to clear a stale warning after its freeze; any other window → an on-demand ("custom") period
      const daily = [...prevDays.values()].find((d) => !d.custom && Date.parse(d.manifest.window.from) === Date.parse(window.from) && Date.parse(d.manifest.window.to) === Date.parse(window.to));
      if (daily) jobs.push({ key: keyOf(daily), reportDate: daily.reportDate, window: daily.manifest.window, provisional: Date.parse(reqTo) > now.getTime() });
      else jobs.push({ key: `custom-${stamp(window.from)}-${stamp(window.to)}`, reportDate: vnDate(new Date(window.to)), window, provisional: Date.parse(reqTo) > now.getTime(), custom: true });
    } else {
      const last = lastCompletedWindow(now, startClock, endClock);
      const todays = windowForReportDate(vnDate(now), startClock, endClock);
      const tomorrow = windowForReportDate(vnDate(new Date(now.getTime() + 86400_000)), startClock, endClock);
      const inProgress = [todays, tomorrow].find((w) => new Date(w.from) <= now && now < new Date(w.to));
      if (inProgress) jobs.push({ key: vnDate(new Date(inProgress.to)), reportDate: vnDate(new Date(inProgress.to)), window: inProgress, provisional: true });
      const lastFrozen = prevDays.get(last.reportDate) && !prevDays.get(last.reportDate)!.provisional && now.getTime() - new Date(last.to).getTime() > FREEZE_AFTER_H * 3600_000;
      if (!lastFrozen) jobs.push({ key: last.reportDate, reportDate: last.reportDate, window: { from: last.from, to: last.to }, provisional: false });
    }

    const http = new HttpClient({
      maxConcurrent: settings.collection.maxConcurrentRequests, perHost: settings.collection.maxRequestsPerHost, timeoutMs: settings.collection.timeoutMs,
      maxRetries: settings.collection.maxRetries, backoffBaseMs: settings.collection.backoffBaseMs, userAgent: settings.collection.userAgent,
      hostOverrides: Object.fromEntries(sources.map((s) => [new URL(s.baseUrl).hostname.replace(/^www\./, ''), { concurrency: s.maxConcurrency, pauseMs: s.pauseMs }])),
    });

    for (const job of jobs) {
      const stores = new Stores(makePaths(mkdtempSync(path.join(tmpdir(), 'hcm-cloud-'))), '');
      // seed history with previously published manifests (adapter-health baseline)
      for (const d of prevDays.values()) if (!d.custom) await stores.saveManifest({ ...d.manifest, runId: `run_hist_${d.reportDate.replace(/-/g, '')}` });
      const runId = `run_live_${job.key.replace(/[^0-9a-z]/gi, '')}`;
      const t0 = Date.now();
      const carried = await seedFromPublished(stores, runId, prevDays.get(job.key), job.window, settings);
      const m = await runCollection({ runId, window: job.window, trigger: 'auto', settings, sources, stores, http, profileId: profile.id });
      const cands = await stores.getCandidates(runId);
      const arts = await stores.getArticles(runId);
      const keep = new Set(cands.filter((c) => c.articleId && !['outside_window'].includes(c.state)).map((c) => c.articleId));
      m.notes.push(`Thu thập trên máy chủ lúc ${toVnIso(now)} (${((Date.now() - t0) / 1000).toFixed(0)} giây); cấu hình "${profile.name}": ${origin}.`);
      if (scheduled && (reqFrom || reqTo)) m.notes.push(`Thu thập theo lịch ${scheduled}.`);
      else if (job.custom) m.notes.push(`Thu thập theo yêu cầu${requestedBy ? ` của ${requestedBy}` : ''} trên web.`);
      if (job.provisional) m.notes.push('Kỳ đang diễn ra – tạm thời');
      if (carried) m.notes.push(`Tiếp nối lần đăng trước của kỳ này: giữ ${carried.carried} bài đã bóc tách${carried.reclassified ? ' và phân loại lại theo cài đặt mới' : ''}, chỉ tải thêm link chưa tải.`);
      published.set(job.key, {
        kind: 'hcm-live-day', reportDate: job.reportDate, key: job.key, custom: job.custom, requestedBy: job.custom && !scheduled ? requestedBy : undefined, scheduled: scheduled && (reqFrom || reqTo) ? scheduled : prevDays.get(job.key)?.scheduled, provisional: job.provisional, generatedAt: toVnIso(new Date()),
        manifest: { ...m, reconciliation: reconcile(cands) },
        candidates: cands.map(({ history: _h, ...c }) => c),
        articles: arts.filter((a) => keep.has(a.id)).map(toPublicArticle),
      });
      console.log(`[${profile.id}] ${job.key}${job.provisional ? ' (đang diễn ra)' : ''}: ${cands.length} link, counts=${JSON.stringify(m.counts)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      for (const s of m.sources) console.log(`  ${s.sourceName.padEnd(20)} ${s.status.padEnd(16)} ${s.candidates} link  adapter=${s.adapter?.status ?? '-'} ${s.error ?? ''}`);
    }
  }

  const all = [...published.values()];
  const daily = all.filter((d) => !d.custom).sort((a, b) => b.reportDate.localeCompare(a.reportDate)).slice(0, KEEP_DAYS);
  const customs = all.filter((d) => d.custom).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).slice(0, KEEP_CUSTOM);
  const days = [...customs, ...daily].sort((a, b) => b.manifest.window.to.localeCompare(a.manifest.window.to) || (a.custom ? -1 : 1));
  for (const d of days) {
    writeFileSync(path.join(out, `${keyOf(d)}.json`), JSON.stringify(d));
    // light copy for the web's first paint (F5 on a phone, 18/11/2026): the full text of excluded stories (~60 % of the
    // file) is left out and loaded afterwards from the full file, which every other reader keeps using
    writeFileSync(path.join(out, `${keyOf(d)}.lite.json`), JSON.stringify(liteDay(d)));
  }
  const index: PublicIndex = {
    kind: 'hcm-live-index', generatedAt: toVnIso(new Date()), schedule: 'Mỗi giờ (nếu bật tự động) + theo yêu cầu (nút "Thu thập" trên web)',
    days: days.map((d) => ({
      reportDate: d.reportDate, key: keyOf(d), file: `${keyOf(d)}.json`, lite: `${keyOf(d)}.lite.json`, custom: d.custom, requestedBy: d.requestedBy, scheduled: d.scheduled, window: d.manifest.window,
      provisional: d.provisional, generatedAt: d.generatedAt, counts: d.manifest.counts, completeness: d.manifest.completeness,
    })),
  };
  writeFileSync(path.join(out, 'index.json'), JSON.stringify(index));
  console.log(`[${profile.id}] published ${days.length} period(s) to ${out}`);
  return { regionName: cfg?.settings.location.regionName, periods: days.length };
}

/**
 * Every run republishes ALL profiles (GitHub Pages replaces the whole site): profiles collected now get new periods,
 * the others are carried over unchanged. Which profiles are collected: --profile <id> (on-demand "Thu thập" on the
 * web), otherwise every profile with "Tự động thu thập mỗi giờ" switched on.
 */
async function main() {
  const now = new Date();
  mkdirSync(OUT, { recursive: true });
  const profiles = await loadProfiles();
  const only = arg('--profile', '');
  if (only && !profiles.some((p) => p.id === only)) throw new Error(`unknown profile: ${only}`);
  const out: Array<PublicProfile & { periods: number }> = [];
  for (const p of profiles) {
    const collect = only ? p.id === only : p.autoCollect;
    const r = await collectProfile(p, collect, now);
    out.push({ id: p.id, name: p.name, description: p.description ?? '', autoCollect: p.autoCollect, regionName: r.regionName ?? p.regionName, periods: r.periods });
  }
  writeFileSync(path.join(OUT, 'profiles.json'), JSON.stringify({ kind: 'hcm-live-profiles', generatedAt: toVnIso(new Date()), profiles: out }));
}
if (process.argv[1] && /cloud-collect/.test(process.argv[1])) await main();
