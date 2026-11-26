/**
 * Shared review store for News Reporter (Cloudflare Worker + KV, free tier).
 *
 * Reviewers open the GitHub Pages app, sign in with their account (user name + password), and label collected articles:
 * relevant / not relevant, correct sector and editorial assessment, optional note. Labels from all reviewers are
 * visible to each other (vote counts). A nightly GitHub Action pulls everything via /export (EXPORT_TOKEN) into
 * the repo, where reviewer names are replaced by pseudonyms, to tune the collector.
 *
 * KV key:   l:<reportDate>:<articleId>:<reviewerId>
 * metadata: compact label for fast listing (≤ 1 KB)   value: full record (title/url for export)
 */
import { SUGGESTION_ID } from '../../../src/domain/suggestId';
import { getUsers, hashPassword, login, newSalt, publicUser, saveUsers, sessionOf, USER_RE, type Session } from './accounts';
import { dueSlots, SCHEDULE_SLOTS, slotsFor, slotWindow, validateTimes, vnDay, type ScheduleSlot, type ScheduleState, type ScheduleTimes } from '../../../src/domain/schedule';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean; cursor?: string }>;
}
/** the parts of a Cloudflare Durable Object namespace / storage this worker uses */
export interface DONamespaceLike { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } }
export interface DOStorageLike { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }
export interface Env {
  REVIEWS: KVLike;
  /**
   * one Durable Object per (profile, period) holds the team's review: writes are applied one after another on fresh data.
   * KV alone lost edits (18/11/2026): its reads can be up to 60 s old, so a save read a stale copy and overwrote the
   * previous save (title edited, then "Lưu biên tập", then a photo…). Without the binding (tests) KV is used.
   */
  REVIEW_DO?: DONamespaceLike;
  EXPORT_TOKEN: string;
  ALLOWED_ORIGINS: string; // comma separated
  /** fine-grained PAT (this repo only, Actions: read & write) – lets reviewers start an on-demand collection */
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string; // e.g. tinbaochi/tinbaochi.github.io
  COLLECT_WORKFLOW?: string; // e.g. pages.yml
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const VN_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+07:00$/;
export const MAX_WINDOW_HOURS = 72;

export const CATEGORIES = ['LAND', 'BUILD', 'INFRA', 'TRAFFIC', 'REALESTATE', 'FLOOD', 'INVEST', 'POLICY'] as const;
export const ASSESSMENTS = ['needs_attention', 'positive', 'neutral'] as const;

export interface LabelRecord {
  v: 1;
  reportDate: string;
  articleId: string;
  url: string;
  title: string;
  sourceId: string;
  reviewer: string;
  reviewerId: string;
  label: 'relevant' | 'irrelevant' | null;
  category: (typeof CATEGORIES)[number] | null;
  assessment: (typeof ASSESSMENTS)[number] | null;
  note: string;
  at: string;
}
/** what the app needs to show votes (stored as KV metadata) */
export interface Vote { r: string; l: LabelRecord['label']; c: LabelRecord['category']; a: LabelRecord['assessment']; n: string; t: string }

export function reviewerId(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'an-danh';
}

/**
 * Changes that affect the whole system are for admins (20/11/2026): the collection token, profiles (create /
 * rename / delete), the shared configuration (save / roll back), the automatic schedule, deleting a saved run.
 * Reviewers keep the daily work: review, edit, "Thu thập", archive a run, suggestions, export.
 */
export async function adminOnly(req: Request, url: URL): Promise<boolean> {
  const p = url.pathname, post = req.method === 'POST';
  if (post && ['/token', '/config', '/config/rollback', '/profiles', '/auto', '/auto/times'].includes(p)) return true;
  if (/^\/profiles\/[a-z0-9-]{1,40}$/.test(p) && req.method !== 'GET') return true;
  if (post && p === '/runs/hide') {
    const b = (await req.clone().json().catch(() => null)) as { hidden?: unknown } | null;
    return typeof b?.hidden === 'boolean'; // delete / restore; archiving stays open to reviewers
  }
  return false;
}

/**
 * Cài đặt › Tài khoản: an admin lists / creates / updates / deletes accounts; everyone changes their own password.
 * Never returns password hashes.
 */
async function userRoutes(req: Request, url: URL, env: Env, actor: Session, h: Record<string, string>): Promise<Response | null> {
  if (!url.pathname.startsWith('/users')) return null;
  const kv = env.REVIEWS;
  const list = await getUsers(kv);
  if (url.pathname === '/users/password' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { password?: unknown } | null;
    const pw = String(b?.password ?? '');
    if (!actor.u) return json({ error: 'Đăng nhập bằng tài khoản để đổi mật khẩu' }, 400, h);
    if (pw.length < 6) return json({ error: 'Mật khẩu cần ít nhất 6 ký tự' }, 400, h);
    const i = list.findIndex((x) => x.u === actor.u);
    if (i < 0) return json({ error: 'Không tìm thấy tài khoản' }, 404, h);
    const salt = newSalt();
    list[i] = { ...list[i]!, salt, hash: await hashPassword(pw, salt), at: new Date().toISOString(), by: actor.u };
    await saveUsers(kv, list);
    return json({ ok: true }, 200, h);
  }
  if (actor.role !== 'admin') return json({ error: 'Chỉ quản trị viên quản lý tài khoản' }, 403, h);
  if (url.pathname === '/users' && req.method === 'GET') return json({ users: list.map(publicUser) }, 200, h);
  if (url.pathname === '/users' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { u?: unknown; name?: unknown; password?: unknown; role?: unknown } | null;
    const u = String(b?.u ?? '').trim().toLowerCase();
    const name = String(b?.name ?? '').trim().slice(0, 40);
    const pw = String(b?.password ?? '');
    const role = b?.role === 'admin' ? 'admin' : 'reviewer';
    if (!USER_RE.test(u)) return json({ error: 'Tên đăng nhập: 2–32 ký tự a-z, 0-9, dấu chấm, gạch ngang, gạch dưới' }, 400, h);
    if (!name) return json({ error: 'Cần nhập họ tên' }, 400, h);
    const i = list.findIndex((x) => x.u === u);
    if (i < 0 && pw.length < 6) return json({ error: 'Mật khẩu cần ít nhất 6 ký tự' }, 400, h);
    if (pw && pw.length < 6) return json({ error: 'Mật khẩu cần ít nhất 6 ký tự' }, 400, h);
    if (i >= 0 && role !== 'admin' && list[i]!.role === 'admin' && list.filter((x) => x.role === 'admin').length === 1) return json({ error: 'Phải còn ít nhất một quản trị viên' }, 400, h);
    const at = new Date().toISOString();
    const by = actor.u;
    const pass = pw ? await (async () => { const salt = newSalt(); return { salt, hash: await hashPassword(pw, salt) }; })() : null;
    if (i >= 0) list[i] = { ...list[i]!, name, role, ...(pass ?? {}), at, by };
    else list.push({ u, name, role, ...pass!, at, by });
    await saveUsers(kv, list);
    return json({ ok: true, users: list.map(publicUser) }, 200, h);
  }
  if (url.pathname === '/users/delete' && req.method === 'POST') {
    const u = String(((await req.json().catch(() => null)) as { u?: unknown } | null)?.u ?? '');
    if (u === actor.u) return json({ error: 'Không tự xoá tài khoản đang đăng nhập' }, 400, h);
    const rec = list.find((x) => x.u === u);
    if (!rec) return json({ error: 'Không tìm thấy tài khoản' }, 404, h);
    if (rec.role === 'admin' && list.filter((x) => x.role === 'admin').length === 1) return json({ error: 'Phải còn ít nhất một quản trị viên' }, 400, h);
    const next = list.filter((x) => x.u !== u);
    await saveUsers(kv, next);
    return json({ ok: true, users: next.map(publicUser) }, 200, h);
  }
  return json({ error: 'NOT_FOUND' }, 404, h);
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return ok
    ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-review-code', vary: 'origin' }
    : {};
}
const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ART = /^a_[a-z0-9]{6,40}$/;

async function listAll(kv: KVLike, prefix: string) {
  const keys: Array<{ name: string; metadata?: unknown }> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await kv.list({ prefix, cursor, limit: 1000 });
    keys.push(...r.keys);
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return keys;
}

async function gh(env: Env, f: Fetch, path: string, init: RequestInit = {}) {
  return f(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${(env.GITHUB_TOKEN ?? '').trim()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'hcm-news-review-worker',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}
interface RunInfo { id: number; status: string; conclusion: string | null; created_at: string; updated_at: string; event: string; display_title: string; html_url: string }

const ghReady = (env: Env) => !!(env.GITHUB_TOKEN && env.GITHUB_REPO && env.COLLECT_WORKFLOW);

/* ---------- collection token: set by "wrangler secret put GITHUB_TOKEN", or replaced from the web (Cài đặt, 20/11/2026) ---------- */
const TOKEN_KEY = 'cfg:ghToken';
interface StoredToken { token: string; last4: string; by: string; at: string; expiresAt: string | null }
/** "2027-11-21 04:06:07 UTC" (GitHub header) → ISO; null when the token never expires / no header */
export function tokenExpiry(h: Headers): string | null {
  const v = h.get('github-authentication-token-expiration');
  if (!v) return null;
  const d = new Date(v.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
/** the env with the token saved from the web, when there is one (it wins over the wrangler secret) */
async function withToken(env: Env): Promise<Env> {
  const v = await env.REVIEWS.get(TOKEN_KEY);
  if (!v) return env;
  const t = JSON.parse(v) as StoredToken;
  return { ...env, GITHUB_TOKEN: t.token };
}
/**
 * POST /token: a reviewer replaces the collection token. Checked before it is saved – it must read this repository
 * and be allowed to start the collection workflow (a dispatch to a branch that does not exist: 422 = allowed,
 * 403/404 = not allowed; nothing runs). The token is never sent back: only its last 4 characters and expiry.
 */
async function saveToken(req: Request, env: Env, f: Fetch, h: Record<string, string>) {
  const b = (await req.json().catch(() => null)) as { token?: unknown; reviewer?: unknown } | null;
  const token = String(b?.token ?? '').trim();
  const by = String(b?.reviewer ?? '').trim().slice(0, 40);
  if (!by) return json({ error: 'Cần nhập tên người duyệt' }, 400, h);
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/.test(token)) return json({ error: 'Khóa không đúng dạng (bắt đầu bằng github_pat_ …)' }, 400, h);
  if (!env.GITHUB_REPO || !env.COLLECT_WORKFLOW) return json({ error: 'Máy chủ chưa cấu hình repository thu thập' }, 503, h);
  const t = { ...env, GITHUB_TOKEN: token };
  const repo = await gh(t, f, '');
  if (repo.status === 401) return json({ error: 'GitHub không nhận khóa này (sai, đã thu hồi hoặc hết hạn)' }, 400, h);
  if (!repo.ok) return json({ error: `Khóa không đọc được repository ${env.GITHUB_REPO} – khi tạo khóa, chọn đúng chủ sở hữu và repository này` }, 400, h);
  const probe = await gh(t, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/__token-check-does-not-exist__' }) });
  if (probe.status !== 422) return json({ error: 'Khóa thiếu quyền chạy thu thập – đặt "Actions: Read and write" khi tạo khóa' }, 400, h);
  const saved: StoredToken = { token, last4: token.slice(-4), by, at: new Date().toISOString(), expiresAt: tokenExpiry(repo.headers) };
  await env.REVIEWS.put(TOKEN_KEY, JSON.stringify(saved));
  return json({ ok: true, token: { last4: saved.last4, by, at: saved.at, expiresAt: saved.expiresAt, source: 'web' } }, 200, h);
}
/** GET /token: which token is used (never the token itself) */
async function tokenInfo(env: Env, f: Fetch, h: Record<string, string>) {
  const v = await env.REVIEWS.get(TOKEN_KEY);
  const s = v ? (JSON.parse(v) as StoredToken) : null;
  const e = s ? { ...env, GITHUB_TOKEN: s.token } : env;
  if (!e.GITHUB_TOKEN || !e.GITHUB_REPO) return json({ configured: false }, 200, h);
  const r = await gh(e, f, '');
  return json({ configured: true, ok: r.ok, status: r.status, source: s ? 'web' : 'server', last4: s?.last4 ?? (e.GITHUB_TOKEN ?? '').trim().slice(-4), by: s?.by ?? null, at: s?.at ?? null, expiresAt: tokenExpiry(r.headers) ?? s?.expiresAt ?? null, repo: e.GITHUB_REPO }, 200, h);
}

/** is a collection workflow run queued or running? */
async function busy(env: Env, f: Fetch): Promise<boolean> {
  for (const st of ['in_progress', 'queued']) {
    const r = await gh(env, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/runs?status=${st}&per_page=1`);
    if (r.ok && ((await r.json()) as { total_count: number }).total_count > 0) return true;
  }
  return false;
}

/* ---------- profiles (cấu hình theo địa bàn): each has its own configuration, data and hourly switch ---------- */
export interface ProfileMeta {
  id: string; name: string; description: string; autoCollect: boolean; clonedFrom: string | null; createdAt: string; updatedAt: string;
  /** who switched the automatic collection on/off, and when */
  autoBy?: string; autoAt?: string;
  /** fixed daily collection times ticked for this profile (src/domain/schedule.ts); replaces the hourly autoCollect */
  schedule?: ScheduleState;
  /** times of those slots changed in Settings (unset = defaults 08:00 / 16:30) */
  scheduleTimes?: ScheduleTimes;
}
export const DEFAULT_PROFILE = 'hcm';
const PROFILES_KEY = 'cfg:profiles';
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PROFILES = 20;

export async function getProfiles(env: Env): Promise<ProfileMeta[]> {
  const v = await env.REVIEWS.get(PROFILES_KEY);
  if (v) return JSON.parse(v) as ProfileMeta[];
  // before profiles existed: one TP.HCM configuration and one global hourly switch (cfg:auto)
  const legacy = await env.REVIEWS.get('cfg:auto');
  const a = legacy ? (JSON.parse(legacy) as { enabled: boolean; by: string; at: string }) : null;
  return [{
    id: DEFAULT_PROFILE, name: 'TP.HCM', description: 'Cấu hình mặc định: ngành xây dựng TP.HCM', autoCollect: a?.enabled ?? true,
    clonedFrom: null, createdAt: '', updatedAt: '', autoBy: a?.by, autoAt: a?.at,
  }];
}
const saveProfiles = (env: Env, list: ProfileMeta[]) => env.REVIEWS.put(PROFILES_KEY, JSON.stringify(list));

/* ---------- automatic collection at fixed times (Cloudflare cron every 5 min → workflow_dispatch), ticked per profile ---------- */
export interface AutoLast { at: string; result: 'dispatched' | 'off' | 'busy' | 'error' | 'not_configured'; detail?: string; profiles?: string[]; slot?: string }
const AUTO_LAST_KEY = 'cfg:autoLast';
export const AUTO_TITLE = 'Thu thập theo lịch';
const doneKey = (pid: string, slot: ScheduleSlot, now: Date) => `sched:${pid}:${slot.id}:${vnDay(now)}`;

/**
 * Called by the cron trigger every 5 minutes. For each profile, the slots whose dispatch window (time + 2 min → + 2 h,
 * times from Settings or the defaults 08:00 / 16:30) contains now: if ticked and not collected today,
 * dispatch the slot's window (one at a time; while the collection server is busy, the next tick tries again).
 */
export async function scheduledCollect(env: Env, f: Fetch = (i, init) => fetch(i, init), now = new Date()): Promise<AutoLast | null> {
  // times are per profile (Settings), so the profile list is read on every tick (288 KV reads a day)
  const profiles = await getProfiles(env);
  const todo: Array<{ p: ProfileMeta; slot: ScheduleSlot }> = [];
  for (const p of profiles)
    for (const slot of dueSlots(now, slotsFor(p.scheduleTimes))) if (p.schedule?.[slot.id] && !(await env.REVIEWS.get(doneKey(p.id, slot, now)))) todo.push({ p, slot });
  if (!todo.length) return null;
  env = await withToken(env);
  const at = now.toISOString();
  const { p, slot } = todo[0]!;
  let last: AutoLast;
  if (!ghReady(env)) last = { at, result: 'not_configured', slot: slot.at };
  else if (await busy(env, f)) last = { at, result: 'busy', profiles: [p.id], slot: slot.at };
  else {
    const w = slotWindow(slot, now);
    const d = await gh(env, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { trigger: 'schedule', slot: slot.at, from: w.from.slice(0, 16) + '+07:00', to: w.to.slice(0, 16) + '+07:00', profile: p.id, requested_by: '' } }),
    });
    if (d.status === 204) {
      await env.REVIEWS.put(doneKey(p.id, slot, now), at, { expirationTtl: 3 * 86400 });
      last = { at, result: 'dispatched', profiles: [p.id], slot: slot.at };
    } else last = { at, result: 'error', detail: `HTTP ${d.status}`, profiles: [p.id], slot: slot.at };
  }
  await env.REVIEWS.put(AUTO_LAST_KEY, JSON.stringify(last));
  return last;
}

/** what kind of workflow run this is (shown to users) */
export function runKind(x: { event: string; display_title: string }): 'auto' | 'request' | 'deploy' {
  if (x.event === 'schedule' || x.display_title.startsWith(AUTO_TITLE)) return 'auto';
  if (x.event === 'workflow_dispatch') return 'request';
  return 'deploy';
}
const mapRun = (x: RunInfo) => ({
  id: x.id, status: x.status, conclusion: x.conclusion, createdAt: x.created_at, updatedAt: x.updated_at, event: x.event, kind: runKind(x), title: x.display_title, url: x.html_url,
});

/** public server status: per-profile hourly switch + what the collection server is doing right now */
async function serverStatus(env0: Env, f: Fetch, h: Record<string, string>) {
  const env = await withToken(env0);
  const now = new Date();
  const profiles = await Promise.all(
    (await getProfiles(env)).map(async (p) => {
      const done: string[] = [];
      for (const s of slotsFor(p.scheduleTimes)) if (p.schedule?.[s.id] && (await env.REVIEWS.get(doneKey(p.id, s, now)))) done.push(s.id);
      return { ...p, scheduleDone: done };
    }),
  );
  const lv = await env.REVIEWS.get(AUTO_LAST_KEY);
  const lastAuto = lv ? (JSON.parse(lv) as AutoLast) : null;
  if (!ghReady(env)) return json({ collectEnabled: false, profiles, lastAuto, running: [] }, 200, h);
  const r = await gh(env, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/runs?per_page=6`);
  const runs = r.ok ? ((await r.json()) as { workflow_runs: RunInfo[] }).workflow_runs.map(mapRun) : [];
  // expiry of the collection token (public: date only) – the web warns 30 days ahead; 401 = expired / revoked
  const token = { expiresAt: tokenExpiry(r.headers), rejected: r.status === 401 };
  return json({ collectEnabled: true, profiles, lastAuto, running: runs.filter((x) => x.status !== 'completed'), token }, r.ok ? 200 : 502, h);
}

/* ---------- shared collector configuration (settings + sources) per profile, edited on the web, used by the server ---------- */
export interface SharedConfig { settings: Record<string, unknown>; sources: unknown[]; by: string; at: string; summary: string }
const configKey = (pid: string) => `cfg:config:${pid}`;
const histPrefix = (pid: string) => `cfg:hist:${pid}:`;
const KEEP_HISTORY = 30;
const MAX_CONFIG_BYTES = 1_000_000;

async function readConfig(env: Env, pid: string): Promise<string | null> {
  // TP.HCM: configuration saved before profiles existed
  return (await env.REVIEWS.get(configKey(pid))) ?? (pid === DEFAULT_PROFILE ? await env.REVIEWS.get('cfg:config') : null);
}
async function saveConfig(env: Env, pid: string, next: SharedConfig) {
  const prev = await readConfig(env, pid);
  if (prev) {
    const p = JSON.parse(prev) as SharedConfig;
    // history key sorts by time; metadata lets the web list versions without reading values
    await env.REVIEWS.put(`${histPrefix(pid)}${p.at}`, prev, { metadata: { by: p.by, at: p.at, summary: p.summary.slice(0, 200) } });
    // pruning old versions needs list(); when the daily list() quota is used up it waits for the next save
    const old = (await listAll(env.REVIEWS, histPrefix(pid)).catch(() => [])).map((k) => k.name).sort();
    for (const k of old.slice(0, Math.max(0, old.length - KEEP_HISTORY))) await env.REVIEWS.delete(k);
  }
  await env.REVIEWS.put(configKey(pid), JSON.stringify(next));
}
function parseConfigBody(b: { settings?: unknown; sources?: unknown; summary?: unknown; reviewer?: unknown }): SharedConfig | null {
  if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings) || !Array.isArray(b.sources)) return null;
  return {
    settings: b.settings as Record<string, unknown>, sources: b.sources, by: String(b.reviewer ?? '').trim().slice(0, 40) || 'web',
    at: new Date().toISOString(), summary: String(b.summary ?? '').slice(0, 300) || 'Cập nhật cấu hình',
  };
}
function profileSlug(name: string, taken: string[]): string {
  const base = reviewerId(name) === 'an-danh' ? 'cau-hinh' : reviewerId(name).slice(0, 36);
  let id = base;
  for (let k = 2; taken.includes(id); k++) id = `${base}-${k}`;
  return id;
}

/** reviewer-only routes (access code already checked) */
async function profileRoutes(req: Request, url: URL, env: Env, h: Record<string, string>): Promise<Response | null> {
  const body = async <T>() => (await req.json().catch(() => null)) as T | null;
  const pidOf = (v: unknown) => (typeof v === 'string' && PROFILE_ID.test(v) ? v : DEFAULT_PROFILE);

  if (url.pathname === '/config' && req.method === 'POST') {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_CONFIG_BYTES) return json({ error: 'Cấu hình quá lớn' }, 413, h);
    const b = await body<{ profile?: string; settings?: unknown; sources?: unknown; summary?: unknown; reviewer?: unknown }>();
    if (!b) return json({ error: 'INVALID_JSON' }, 400, h);
    const pid = pidOf(b.profile);
    if (!(await getProfiles(env)).some((p) => p.id === pid)) return json({ error: `Không có cấu hình "${pid}"` }, 404, h);
    const cfg = parseConfigBody(b);
    if (!cfg) return json({ error: 'Cấu hình không hợp lệ (cần settings + sources)' }, 400, h);
    await saveConfig(env, pid, cfg);
    return json({ ok: true, by: cfg.by, at: cfg.at }, 200, h);
  }
  if (url.pathname === '/config/history' && req.method === 'GET') {
    const pid = pidOf(url.searchParams.get('profile'));
    const keys = await listAll(env.REVIEWS, histPrefix(pid));
    const items = keys.map((k) => ({ id: k.name.slice(histPrefix(pid).length), ...(k.metadata as { by: string; at: string; summary: string }) })).sort((a, b) => b.id.localeCompare(a.id));
    return json({ items }, 200, h);
  }
  if (url.pathname === '/config/rollback' && req.method === 'POST') {
    const b = (await body<{ id?: string; reviewer?: string; profile?: string }>()) ?? {};
    const pid = pidOf(b.profile);
    const v = b.id ? await env.REVIEWS.get(`${histPrefix(pid)}${b.id}`) : null;
    if (!v) return json({ error: 'Không tìm thấy phiên bản' }, 404, h);
    const old = JSON.parse(v) as SharedConfig;
    await saveConfig(env, pid, { ...old, by: String(b.reviewer ?? '').trim().slice(0, 40) || 'web', at: new Date().toISOString(), summary: `Khôi phục phiên bản ${b.id}` });
    return json({ ok: true }, 200, h);
  }
  // create: the browser builds the configuration (new region from the defaults, or a clone) and sends it
  if (url.pathname === '/profiles' && req.method === 'POST') {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_CONFIG_BYTES) return json({ error: 'Cấu hình quá lớn' }, 413, h);
    const b = await body<{ name?: string; description?: string; clonedFrom?: string; settings?: unknown; sources?: unknown; reviewer?: string }>();
    const name = String(b?.name ?? '').trim().slice(0, 60);
    if (!b || !name) return json({ error: 'Cần tên cấu hình' }, 400, h);
    const cfg = parseConfigBody({ ...b, summary: `Tạo cấu hình "${name}"` });
    if (!cfg) return json({ error: 'Cấu hình không hợp lệ (cần settings + sources)' }, 400, h);
    const list = await getProfiles(env);
    if (list.length >= MAX_PROFILES) return json({ error: `Tối đa ${MAX_PROFILES} cấu hình` }, 400, h);
    const now = new Date().toISOString();
    const meta: ProfileMeta = {
      id: profileSlug(name, list.map((p) => p.id)), name, description: String(b.description ?? '').slice(0, 300), autoCollect: false,
      clonedFrom: b.clonedFrom && PROFILE_ID.test(b.clonedFrom) ? b.clonedFrom : null, createdAt: now, updatedAt: now,
    };
    await saveConfig(env, meta.id, cfg);
    await saveProfiles(env, [...list, meta]);
    return json(meta, 200, h);
  }
  const m = /^\/profiles\/([a-z0-9-]{1,40})$/.exec(url.pathname);
  if (m && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const list = await getProfiles(env);
    const i = list.findIndex((p) => p.id === m[1]);
    if (i < 0) return json({ error: 'Không tìm thấy cấu hình' }, 404, h);
    if (req.method === 'DELETE') {
      if (list.length <= 1) return json({ error: 'Phải còn ít nhất một cấu hình' }, 400, h);
      await saveProfiles(env, list.filter((p) => p.id !== m[1]));
      return json({ ok: true }, 200, h); // configuration + history stay in KV (recoverable by an administrator)
    }
    const b = (await body<{ name?: string; description?: string }>()) ?? {};
    list[i] = { ...list[i]!, ...(b.name?.trim() ? { name: b.name.trim().slice(0, 60) } : {}), ...(b.description !== undefined ? { description: String(b.description).slice(0, 300) } : {}), updatedAt: new Date().toISOString() };
    await saveProfiles(env, list);
    return json(list[i], 200, h);
  }
  return null;
}
/* ---------------- page proxy for "Dò nguồn" / "Thử nguồn" on the web ---------------- */
const FETCH_MAX_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_UA = 'NewsReporter/1.0 (editorial source test; +https://tinbaochi.github.io/)';
/** public web pages only: http(s), default ports, no IP literals of private / local ranges, no localhost */
export function publicPageUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  }
  if (h.includes(':')) return null; // IPv6 literals: not needed for news sites
  return u;
}
/** reviewers only: fetch a public page (redirects re-checked hop by hop), text/HTML/XML ≤ 3 MB, 15 s */
async function pageProxy(url: URL, f: Fetch, h: Record<string, string>) {
  let target = publicPageUrl(url.searchParams.get('url') ?? '');
  if (!target) return json({ error: 'URL không hợp lệ (chỉ trang web công khai http/https)' }, 400, h);
  const requested = target.toString();
  for (let hop = 0; hop < 6; hop++) {
    let r: Response;
    try {
      r = await f(target.toString(), { redirect: 'manual', headers: { 'user-agent': FETCH_UA, accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,text/xml;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      return json({ requestedUrl: requested, finalUrl: target.toString(), status: 0, body: '', contentType: '', errorCode: timeout ? 'TIMEOUT' : 'NETWORK', error: (e as Error).message }, 200, h);
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const next = publicPageUrl(new URL(r.headers.get('location')!, target).toString());
      if (!next) return json({ requestedUrl: requested, finalUrl: target.toString(), status: 0, body: '', contentType: '', errorCode: 'SSRF_BLOCKED', error: 'Chuyển hướng tới địa chỉ không công khai' }, 200, h);
      target = next;
      continue;
    }
    const ct = r.headers.get('content-type') ?? '';
    if (r.status === 200 && ct && !/text\/|xml|json/i.test(ct)) return json({ requestedUrl: requested, finalUrl: target.toString(), status: 0, body: '', contentType: ct, errorCode: 'NOT_TEXT', error: `Không phải trang văn bản (${ct})` }, 200, h);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > FETCH_MAX_BYTES) return json({ requestedUrl: requested, finalUrl: target.toString(), status: 0, body: '', contentType: ct, errorCode: 'TOO_LARGE', error: 'Trang quá lớn (> 3 MB)' }, 200, h);
    const status = r.status;
    return json({
      requestedUrl: requested, finalUrl: target.toString(), status, body: new TextDecoder('utf-8').decode(buf), contentType: ct,
      errorCode: status === 200 ? null : `FETCH_${status}`, error: status === 200 ? null : `HTTP ${status}`,
    }, 200, h);
  }
  return json({ requestedUrl: requested, finalUrl: target.toString(), status: 0, body: '', contentType: '', errorCode: 'REDIRECT_LOOP', error: 'Quá nhiều lần chuyển hướng' }, 200, h);
}

/** Article photo for the report (browser export): https only, real jpeg/png/webp, ≤ 8 MB. */
async function imageProxy(url: URL, f: Fetch, h: Record<string, string>) {
  const target = url.searchParams.get('url') ?? '';
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return json({ error: 'URL không hợp lệ' }, 400, h);
  }
  if (u.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname)) return json({ error: 'Chỉ nhận ảnh https công khai' }, 400, h);
  const r = await f(u.toString(), { headers: { 'user-agent': 'Mozilla/5.0 HCMNewsReporter/0.1', accept: 'image/jpeg,image/png;q=0.9,image/*;q=0.5' }, redirect: 'follow' });
  const type = r.headers.get('content-type') ?? '';
  if (!r.ok || !/^image\//.test(type)) return json({ error: `Không tải được ảnh (HTTP ${r.status})` }, 502, h);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 8_000_000) return json({ error: 'Ảnh quá lớn' }, 413, h);
  return new Response(buf, { status: 200, headers: { 'content-type': type, 'cache-control': 'private, max-age=3600', ...h } });
}

/** On-demand collection for a custom window: dispatch the collection workflow (one at a time). */
async function collect(req: Request, env0: Env, f: Fetch, h: Record<string, string>) {
  const env = await withToken(env0);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.COLLECT_WORKFLOW) return json({ error: 'Máy chủ chưa được cấu hình để thu thập theo yêu cầu' }, 503, h);
  let b: { from?: string; to?: string; reviewer?: string; profile?: string };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return json({ error: 'INVALID_JSON' }, 400, h);
  }
  const from = String(b.from ?? '');
  const to = String(b.to ?? '');
  if (!VN_ISO.test(from) || !VN_ISO.test(to)) return json({ error: 'Ngày giờ phải theo dạng 2026-11-15T17:00+07:00' }, 400, h);
  const a = Date.parse(from);
  const z = Date.parse(to);
  if (!(z > a)) return json({ error: 'Thời điểm kết thúc phải sau thời điểm bắt đầu' }, 400, h);
  if (z - a > MAX_WINDOW_HOURS * 3600_000) return json({ error: `Khung giờ tối đa ${MAX_WINDOW_HOURS} giờ cho mỗi lần thu thập trên web` }, 400, h);
  if (a > Date.now()) return json({ error: 'Thời điểm bắt đầu ở tương lai' }, 400, h);
  const reviewer = String(b.reviewer ?? '').trim().slice(0, 40) || 'web';
  const profile = String(b.profile ?? DEFAULT_PROFILE);
  if (!(await getProfiles(env)).some((p) => p.id === profile)) return json({ error: `Không có cấu hình "${profile}"`}, 400, h);
  // one collection at a time (the workflow also serialises runs)
  if (await busy(env, f)) return json({ error: 'Máy chủ đang chạy một lượt thu thập khác (xem dòng trạng thái máy chủ) – vui lòng chờ lượt đó xong', busy: true }, 409, h);
  const d = await gh(env, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { from, to, requested_by: reviewer, profile } }),
  });
  if (d.status !== 204) return json({ error: `Máy chủ thu thập từ chối yêu cầu (HTTP ${d.status})` }, 502, h);
  return json({ ok: true, from, to, profile, requestedAt: new Date().toISOString() }, 202, h);
}

async function collectStatus(env0: Env, f: Fetch, h: Record<string, string>) {
  const env = await withToken(env0);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.COLLECT_WORKFLOW) return json({ enabled: false, runs: [] }, 200, h);
  const r = await gh(env, f, `/actions/workflows/${env.COLLECT_WORKFLOW}/runs?per_page=6`);
  if (!r.ok) return json({ error: `Máy chủ thu thập không trả lời (HTTP ${r.status})` }, 502, h);
  const runs = ((await r.json()) as { workflow_runs: RunInfo[] }).workflow_runs.map(mapRun);
  return json({ enabled: true, runs }, 200, h);
}

/* ---------------- shared editorial review (one decision per article per period, for the whole team) ---------------- */
/**
 * KV key: rv:<profile>:<period>:<articleId>. Metadata = compact decision (≤ 1 KB) so a period is read with one list;
 * edited texts (title, summary, short label, proposal) live in the value and are fetched only when present.
 * Personal votes (✓/✗, note) stay in the labels store.
 */
const PERIOD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const rvPrefix = (pid: string, period: string) => `rv:${pid}:${period}:`;
const REVIEW_BOOL = ['included', 'promotedToReady', 'excludedByEditor', 'timeVerifiedManually', 'extractionMarkedComplete'] as const;
const REVIEW_TEXT: Record<string, number> = { title: 300, summary: 2000, shortLabel: 80, proposal: 600 };
export interface SharedDecision {
  articleId: string; included?: boolean; order?: number; promotedToReady?: boolean; excludedByEditor?: boolean; timeVerifiedManually?: boolean;
  extractionMarkedComplete?: boolean; groupId?: string | null; primaryImageUrl?: string | null; primaryCategory?: string | null; assessment?: string | null; excludeReason?: string | null;
  title?: string; summary?: string; shortLabel?: string; proposal?: string; by: string; at: string;
}
/** only known fields with valid values; null clears a nullable field */
export function cleanReviewPatch(raw: unknown): Partial<SharedDecision> | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of REVIEW_BOOL) if (typeof o[k] === 'boolean') out[k] = o[k];
  if (typeof o.order === 'number' && Number.isFinite(o.order)) out.order = o.order;
  if (o.groupId === null || (typeof o.groupId === 'string' && ART.test(o.groupId))) out.groupId = o.groupId;
  if (o.primaryImageUrl === null || (typeof o.primaryImageUrl === 'string' && /^https:\/\//.test(o.primaryImageUrl) && o.primaryImageUrl.length <= 600)) out.primaryImageUrl = o.primaryImageUrl;
  if (o.primaryCategory === null || (typeof o.primaryCategory === 'string' && (CATEGORIES as readonly string[]).includes(o.primaryCategory))) out.primaryCategory = o.primaryCategory;
  if (o.assessment === null || (typeof o.assessment === 'string' && (ASSESSMENTS as readonly string[]).includes(o.assessment))) out.assessment = o.assessment;
  if (o.excludeReason === null || (typeof o.excludeReason === 'string' && ['off_topic', 'other_area', 'duplicate', 'minor'].includes(o.excludeReason))) out.excludeReason = o.excludeReason;
  for (const [k, max] of Object.entries(REVIEW_TEXT)) if (typeof o[k] === 'string') out[k] = (o[k] as string).slice(0, max);
  return out as Partial<SharedDecision>;
}
const META_OF = (d: SharedDecision) => {
  // long values (edited texts, photo URL) stay in the value – metadata must fit 1 KB
  const { title, summary, shortLabel, proposal, primaryImageUrl, ...m } = d;
  return { ...m, txt: !!(title || summary || shortLabel || proposal || primaryImageUrl) };
};
/**
 * One KV value per period holds every decision (`rva:<profile>:<period>`): a read is ONE get, never a list().
 * (Cloudflare KV free plan: 1,000 list() per day – a list per page load ran out on 16/11/2026 and broke F5.)
 * Periods written before this change are merged from the old per-article keys once; while list() is
 * unavailable the old keys stay pending (`legacy: false`) and are merged on a later read.
 */
interface ReviewAgg { v: 2; legacy: boolean; reviews: Record<string, SharedDecision> }
const rvAggKey = (pid: string, period: string) => `rva:${pid}:${period}`;
async function loadReviewAgg(env: Env, pid: string, period: string): Promise<{ agg: ReviewAgg; changed: boolean; pending: boolean }> {
  const raw = await env.REVIEWS.get(rvAggKey(pid, period));
  const agg: ReviewAgg = raw ? (JSON.parse(raw) as ReviewAgg) : { v: 2, legacy: false, reviews: {} };
  if (agg.legacy) return { agg, changed: false, pending: false };
  try {
    const old = await readLegacyReviews(env, pid, period);
    // newer decisions (already in the aggregate) win over the old per-article keys
    for (const [id, d] of Object.entries(old)) if (!agg.reviews[id] || agg.reviews[id]!.at < d.at) agg.reviews[id] = d;
    agg.legacy = true;
    return { agg, changed: true, pending: false };
  } catch {
    return { agg, changed: false, pending: true };
  }
}
async function readReviews(env: Env, pid: string, period: string): Promise<{ reviews: Record<string, SharedDecision>; pending: boolean }> {
  if (env.REVIEW_DO) return (await periodObject(env, pid, period, { op: 'read' })) as { reviews: Record<string, SharedDecision>; pending: boolean };
  const { agg, changed, pending } = await loadReviewAgg(env, pid, period);
  if (changed) await env.REVIEWS.put(rvAggKey(pid, period), JSON.stringify(agg)).catch(() => undefined);
  return { reviews: agg.reviews, pending };
}
type ReviewItem = { articleId: string; patch: Partial<SharedDecision> | null };
/** applies the patches to the period's decisions (in place) and returns the new decisions */
function applyReview(agg: ReviewAgg, items: ReviewItem[], reviewer: string): Record<string, SharedDecision> {
  const at = new Date().toISOString();
  const out: Record<string, SharedDecision> = {};
  for (const { articleId, patch } of items) {
    const next: SharedDecision = { ...(agg.reviews[articleId] ?? { articleId }), ...patch!, articleId, by: reviewer, at };
    for (const k of Object.keys(next) as Array<keyof SharedDecision>) if (next[k] === undefined) delete next[k];
    agg.reviews[articleId] = out[articleId] = next;
  }
  return out;
}
async function writeReviews(env: Env, pid: string, period: string, items: ReviewItem[], reviewer: string): Promise<Record<string, SharedDecision>> {
  if (env.REVIEW_DO) return ((await periodObject(env, pid, period, { op: 'patch', items, reviewer })) as { out: Record<string, SharedDecision> }).out;
  const { agg } = await loadReviewAgg(env, pid, period);
  const out = applyReview(agg, items, reviewer);
  await env.REVIEWS.put(rvAggKey(pid, period), JSON.stringify(agg));
  return out;
}
async function periodObject(env: Env, pid: string, period: string, body: Record<string, unknown>): Promise<unknown> {
  const ns = env.REVIEW_DO!;
  const r = await ns.get(ns.idFromName(`${pid}:${period}`)).fetch('https://review-period/op', { method: 'POST', body: JSON.stringify({ ...body, pid, period }) });
  if (!r.ok) throw new Error(`ReviewPeriod ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/**
 * Durable Object: the review of ONE period. Requests to one object run one at a time on its own storage, so every
 * save sees the previous one. The first use imports the period from KV; every save is mirrored to KV (backup, and the
 * fallback when the binding is missing).
 */
export class ReviewPeriod {
  constructor(private readonly state: { storage: DOStorageLike }, private readonly env: Env) {}
  async fetch(req: Request): Promise<Response> {
    const b = (await req.json()) as { op: 'read' | 'patch'; pid: string; period: string; items?: ReviewItem[]; reviewer?: string };
    let agg = await this.state.storage.get<ReviewAgg>('agg');
    let pending = false;
    if (!agg) {
      const r = await loadReviewAgg(this.env, b.pid, b.period);
      agg = r.agg;
      pending = r.pending;
      if (!pending) await this.state.storage.put('agg', agg);
    }
    if (b.op === 'read') return Response.json({ reviews: agg.reviews, pending });
    const out = applyReview(agg, b.items ?? [], String(b.reviewer ?? ''));
    await this.state.storage.put('agg', agg);
    await this.env.REVIEWS.put(rvAggKey(b.pid, b.period), JSON.stringify(agg)).catch(() => undefined);
    return Response.json({ out });
  }
}
async function readLegacyReviews(env: Env, pid: string, period: string): Promise<Record<string, SharedDecision>> {
  const keys = await listAll(env.REVIEWS, rvPrefix(pid, period));
  const out: Record<string, SharedDecision> = {};
  for (const k of keys) {
    const m = k.metadata as (SharedDecision & { txt?: boolean }) | undefined;
    if (m && !m.txt) {
      const { txt: _t, ...d } = m;
      out[d.articleId] = d;
      continue;
    }
    const v = await env.REVIEWS.get(k.name);
    if (v) {
      const d = JSON.parse(v) as SharedDecision;
      out[d.articleId] = d;
    }
  }
  return out;
}

export interface Suggestions { generatedAt: string | null; basis: unknown; items: Array<{ id: string } & Record<string, unknown>>; dismissed: string[] }
async function readSuggestions(env: Env, pid: string): Promise<Suggestions> {
  const v = await env.REVIEWS.get(`sug:${pid}`);
  return v ? { generatedAt: null, basis: null, items: [], dismissed: [], ...(JSON.parse(v) as Partial<Suggestions>) } : { generatedAt: null, basis: null, items: [], dismissed: [] };
}

/** a run removed for the team (deleted), or put away in "Lưu trữ" (archived: still listed there, collapsed) */
export interface HiddenRun { runId: string; by: string; at: string; archived?: boolean }
async function readHiddenRuns(env: Env, pid: string): Promise<HiddenRun[]> {
  const v = await env.REVIEWS.get(`hid:${pid}`);
  return v ? (JSON.parse(v) as HiddenRun[]) : [];
}

/** votes of one day, `la:<date>` = { articleId: { reviewerId: Vote } }; old days merged once from l:<date>:* keys */
interface VoteAgg { v: 2; legacy: boolean; votes: Record<string, Record<string, Vote>> }
async function loadVoteAgg(env: Env, date: string): Promise<{ agg: VoteAgg; changed: boolean }> {
  const raw = await env.REVIEWS.get(`la:${date}`);
  const agg: VoteAgg = raw ? (JSON.parse(raw) as VoteAgg) : { v: 2, legacy: false, votes: {} };
  if (agg.legacy) return { agg, changed: false };
  try {
    for (const k of await listAll(env.REVIEWS, `l:${date}:`)) {
      const [, , articleId, rid] = k.name.split(':');
      const byR = (agg.votes[articleId!] ??= {});
      if (!byR[rid!]) byR[rid!] = k.metadata as Vote;
    }
    agg.legacy = true;
    return { agg, changed: true };
  } catch {
    return { agg, changed: false };
  }
}

/** an unexpected error (e.g. a Cloudflare quota) still answers with CORS headers, so the page shows the reason instead of "Failed to fetch" */
export async function handle(req: Request, env: Env, f: Fetch = (i, init) => fetch(i, init)): Promise<Response> {
  try {
    return await route(req, env, f);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const quota = /limit exceeded/i.test(msg);
    return json({ error: quota ? 'Máy chủ duyệt chung tạm hết hạn mức Cloudflare trong ngày (mở lại lúc 07:00).' : 'Lỗi máy chủ duyệt chung', detail: msg.slice(0, 200) }, quota ? 503 : 500, cors(req, env));
  }
}

async function route(req: Request, env: Env, f: Fetch): Promise<Response> {
  const h = cors(req, env);
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (url.pathname === '/health') return json({ ok: true }, 200, h);
  if (url.pathname === '/status' && req.method === 'GET') return serverStatus(env, f, h);
  // profiles + their collector configuration: public read (the GitHub collector and every browser use them; no secrets)
  if (url.pathname === '/profiles' && req.method === 'GET') return json({ profiles: await getProfiles(env) }, 200, h);
  if (url.pathname === '/config' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    const v = PROFILE_ID.test(pid) ? await readConfig(env, pid) : null;
    return json({ config: v ? JSON.parse(v) : null }, 200, h);
  }

  // shared editorial review of a period: public read (same audience as the published period)
  if (url.pathname === '/review' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    const period = url.searchParams.get('period') ?? '';
    if (!PROFILE_ID.test(pid) || !PERIOD_ID.test(period)) return json({ error: 'INVALID_PERIOD' }, 400, h);
    const r = await readReviews(env, pid, period);
    return json({ period, reviews: r.reviews, ...(r.pending ? { pending: 'Một phần kết quả duyệt cũ đang chờ Cloudflare mở lại hạn mức, sẽ hiện lại sau 07:00.' } : {}) }, 200, h);
  }

  // saved runs ("Lượt đã lưu") a reviewer removed: hidden for the whole team (one KV value per profile, public read)
  if (url.pathname === '/runs/hidden' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    if (!PROFILE_ID.test(pid)) return json({ error: 'INVALID_PROFILE' }, 400, h);
    return json({ hidden: await readHiddenRuns(env, pid) }, 200, h);
  }

  // daily filter suggestions (scripts/suggest-filter.ts): public read, minus the ones the team dismissed
  if (url.pathname === '/suggestions' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    if (!PROFILE_ID.test(pid)) return json({ error: 'INVALID_PROFILE' }, 400, h);
    const s = await readSuggestions(env, pid);
    return json({ ...s, items: s.items.filter((x) => !s.dismissed.includes(x.id)) }, 200, h);
  }
  // published by the nightly job (bearer token, never sent to browsers); the team's dismissals are kept
  if (url.pathname === '/suggestions' && req.method === 'POST') {
    if (!safeEqual((req.headers.get('authorization') ?? '').trim(), `Bearer ${(env.EXPORT_TOKEN ?? '').trim()}`)) return json({ error: 'UNAUTHORIZED' }, 401, {});
    if (Number(req.headers.get('content-length') ?? 0) > 200_000) return json({ error: 'TOO_LARGE' }, 413, {});
    const b = (await req.json().catch(() => null)) as { profile?: string; generatedAt?: string; basis?: unknown; items?: unknown } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    if (!PROFILE_ID.test(pid) || !Array.isArray(b?.items)) return json({ error: 'INVALID' }, 400, {});
    const items = (b!.items as Array<Record<string, unknown>>).slice(0, 30).filter((x) => typeof x.id === 'string' && ['include', 'exclude_title', 'place', 'sector', 'setting'].includes(String(x.kind)) && typeof x.phrase === 'string' && x.phrase.length <= 80);
    const prev = await readSuggestions(env, pid);
    await env.REVIEWS.put(`sug:${pid}`, JSON.stringify({ generatedAt: String(b!.generatedAt ?? new Date().toISOString()), basis: b!.basis ?? null, items, dismissed: prev.dismissed }));
    return json({ ok: true, count: items.length }, 200, {});
  }

  // judged stories ("bộ bài chuẩn") for the impact preview in Cài đặt: published nightly with the suggestions, public read
  // (only published news text + the team's verdicts, no names)
  if (url.pathname === '/golden' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    if (!PROFILE_ID.test(pid)) return json({ error: 'INVALID_PROFILE' }, 400, h);
    const v = await env.REVIEWS.get(`gold:${pid}`);
    return new Response(v ?? JSON.stringify({ articles: [], judged: {} }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...h } });
  }
  if (url.pathname === '/golden' && req.method === 'POST') {
    if (!safeEqual((req.headers.get('authorization') ?? '').trim(), `Bearer ${(env.EXPORT_TOKEN ?? '').trim()}`)) return json({ error: 'UNAUTHORIZED' }, 401, {});
    if (Number(req.headers.get('content-length') ?? 0) > 8_000_000) return json({ error: 'TOO_LARGE' }, 413, {});
    const b = (await req.json().catch(() => null)) as { profile?: string; articles?: unknown; judged?: unknown; generatedAt?: string } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    if (!PROFILE_ID.test(pid) || !Array.isArray(b?.articles) || !b?.judged || typeof b.judged !== 'object') return json({ error: 'INVALID' }, 400, {});
    await env.REVIEWS.put(`gold:${pid}`, JSON.stringify({ generatedAt: b.generatedAt ?? new Date().toISOString(), articles: b.articles, judged: b.judged }));
    return json({ ok: true, count: (b.articles as unknown[]).length }, 200, {});
  }

  // the self-learned second opinion (src/domain/learn.ts): published nightly, public read (word statistics only, no names)
  if (url.pathname === '/model' && req.method === 'GET') {
    const pid = url.searchParams.get('profile') ?? DEFAULT_PROFILE;
    if (!PROFILE_ID.test(pid)) return json({ error: 'INVALID_PROFILE' }, 400, h);
    const v = await env.REVIEWS.get(`model:${pid}`);
    return new Response(v ?? 'null', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...h } });
  }
  if (url.pathname === '/model' && req.method === 'POST') {
    if (!safeEqual((req.headers.get('authorization') ?? '').trim(), `Bearer ${(env.EXPORT_TOKEN ?? '').trim()}`)) return json({ error: 'UNAUTHORIZED' }, 401, {});
    if (Number(req.headers.get('content-length') ?? 0) > 2_000_000) return json({ error: 'TOO_LARGE' }, 413, {});
    const b = (await req.json().catch(() => null)) as { profile?: string; model?: { v?: number; w?: unknown; prior?: unknown } } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    if (!PROFILE_ID.test(pid) || b?.model?.v !== 1 || typeof b.model.prior !== 'number' || !b.model.w || typeof b.model.w !== 'object') return json({ error: 'INVALID' }, 400, {});
    await env.REVIEWS.put(`model:${pid}`, JSON.stringify(b.model));
    return json({ ok: true }, 200, {});
  }

  // nightly export for the GitHub Action (bearer token, never sent to browsers)
  if (url.pathname === '/export' && req.method === 'GET') {
    const auth = req.headers.get('authorization') ?? '';
    // secrets set through a shell pipe may carry a trailing newline – compare trimmed values
    if (!safeEqual(auth.trim(), `Bearer ${(env.EXPORT_TOKEN ?? '').trim()}`)) return json({ error: 'UNAUTHORIZED' }, 401, {});
    const since = url.searchParams.get('since') ?? '';
    const keys = await listAll(env.REVIEWS, since && DATE.test(since) ? `l:${since.slice(0, 7)}` : 'l:');
    const out: LabelRecord[] = [];
    for (const k of keys) {
      const v = await env.REVIEWS.get(k.name);
      if (v) out.push(JSON.parse(v) as LabelRecord);
    }
    return json({ exportedAt: new Date().toISOString(), count: out.length, labels: out }, 200, {});
  }

  // account login (user name + password) → session token, sent afterwards where the shared code used to go
  if (url.pathname === '/login' && req.method === 'POST' && !req.headers.get('x-review-code')) {
    const b = (await req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
    const r = await login(env.REVIEWS, String(b?.username ?? ''), String(b?.password ?? ''));
    if (!r) return json({ error: 'Sai tên đăng nhập hoặc mật khẩu' }, 401, h);
    return json({ ok: true, token: r.token, name: r.session.name, role: r.session.role, user: r.session.u, collectEnabled: !!env.GITHUB_TOKEN }, 200, h);
  }

  // reviewer endpoints: a session of an account only (the shared access code was retired on 21/11/2026)
  const code = (req.headers.get('x-review-code') ?? '').trim();
  const actor: Session | null = await sessionOf(env.REVIEWS, code);
  if (!actor) return json({ error: 'Phiên đăng nhập đã hết hạn – hãy đăng nhập lại' }, 401, h);

  if (url.pathname === '/login' && req.method === 'POST') return json({ ok: true, collectEnabled: !!env.GITHUB_TOKEN }, 200, h);
  if (url.pathname === '/me' && req.method === 'GET') return json({ user: actor.u, name: actor.name, role: actor.role }, 200, h);
  if (url.pathname === '/logout' && req.method === 'POST') {
    if (code.startsWith('sess_')) await env.REVIEWS.delete(`sess:${code}`);
    return json({ ok: true }, 200, h);
  }
  const ur = await userRoutes(req, url, env, actor, h);
  if (ur) return ur;
  if (actor.role !== 'admin' && (await adminOnly(req, url))) return json({ error: 'Chỉ quản trị viên được làm việc này' }, 403, h);
  if (url.pathname === '/collect' && req.method === 'POST') return collect(req, env, f, h);
  if (url.pathname === '/collect/status' && req.method === 'GET') return collectStatus(env, f, h);
  if (url.pathname === '/token' && req.method === 'GET') return tokenInfo(env, f, h);
  if (url.pathname === '/token' && req.method === 'POST') return saveToken(req, env, f, h);
  if (url.pathname === '/img' && req.method === 'GET') return imageProxy(url, f, h);
  if (url.pathname === '/fetch' && req.method === 'GET') return pageProxy(url, f, h);
  const pr = await profileRoutes(req, url, env, h);
  if (pr) return pr;
  // automatic collection at a fixed time (slot) on/off for ONE profile
  if (url.pathname === '/auto' && req.method === 'POST') {
    let b: { enabled?: unknown; reviewer?: unknown; profile?: unknown; slot?: unknown };
    try {
      b = (await req.json()) as typeof b;
    } catch {
      return json({ error: 'INVALID_JSON' }, 400, h);
    }
    if (typeof b.enabled !== 'boolean') return json({ error: 'enabled phải là true/false' }, 400, h);
    const list = await getProfiles(env);
    const i = list.findIndex((p) => p.id === String(b.profile ?? DEFAULT_PROFILE));
    if (i < 0) return json({ error: 'Không tìm thấy cấu hình' }, 404, h);
    const slot = SCHEDULE_SLOTS.find((s) => s.id === b.slot);
    if (!slot) return json({ error: 'Lịch không hợp lệ' }, 400, h);
    list[i] = { ...list[i]!, autoCollect: false, schedule: { ...list[i]!.schedule, [slot.id]: b.enabled }, autoBy: String(b.reviewer ?? '').trim().slice(0, 40) || 'web', autoAt: new Date().toISOString() };
    await saveProfiles(env, list);
    return json({ ok: true, profile: list[i] }, 200, h);
  }
  // times of the automatic slots for ONE profile (Settings › Thời gian); {} = back to the defaults
  if (url.pathname === '/auto/times' && req.method === 'POST') {
    let b: { times?: unknown; reviewer?: unknown; profile?: unknown };
    try {
      b = (await req.json()) as typeof b;
    } catch {
      return json({ error: 'INVALID_JSON' }, 400, h);
    }
    if (!b.times || typeof b.times !== 'object' || Array.isArray(b.times)) return json({ error: 'Thiếu giờ lịch' }, 400, h);
    const times: ScheduleTimes = {};
    for (const s of SCHEDULE_SLOTS) {
      const t = (b.times as Record<string, unknown>)[s.id] as { at?: unknown; from?: unknown; to?: unknown } | undefined;
      // "Đến" equal to the run time is not stored (it follows the run time)
      if (t) times[s.id] = { at: String(t.at ?? ''), from: String(t.from ?? ''), ...(t.to && t.to !== t.at ? { to: String(t.to) } : {}) };
    }
    const bad = validateTimes(times);
    if (bad) return json({ error: bad }, 400, h);
    const list = await getProfiles(env);
    const i = list.findIndex((p) => p.id === String(b.profile ?? DEFAULT_PROFILE));
    if (i < 0) return json({ error: 'Không tìm thấy cấu hình' }, 404, h);
    list[i] = { ...list[i]!, scheduleTimes: times, autoBy: String(b.reviewer ?? '').trim().slice(0, 40) || 'web', autoAt: new Date().toISOString() };
    await saveProfiles(env, list);
    return json({ ok: true, profile: list[i] }, 200, h);
  }

  // "Bỏ qua" a suggestion: hidden for the whole team, never proposed again
  if (url.pathname === '/suggestions/dismiss' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { profile?: string; id?: string; reviewer?: string } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    const id = String(b?.id ?? '');
    if (!PROFILE_ID.test(pid) || !SUGGESTION_ID.test(id)) return json({ error: 'INVALID' }, 400, h);
    if (!String(b?.reviewer ?? '').trim()) return json({ error: 'Cần nhập tên người duyệt' }, 400, h);
    const s = await readSuggestions(env, pid);
    if (!s.dismissed.includes(id)) s.dismissed = [...s.dismissed, id].slice(-500);
    await env.REVIEWS.put(`sug:${pid}`, JSON.stringify(s));
    return json({ ok: true }, 200, h);
  }

  if (url.pathname === '/runs/hide' && req.method === 'POST') {
    const b = (await req.json().catch(() => null)) as { profile?: string; runId?: string; hidden?: unknown; archived?: unknown; reviewer?: string } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    const runId = String(b?.runId ?? '');
    const reviewer = String(b?.reviewer ?? '').trim().slice(0, 40);
    if (!PROFILE_ID.test(pid) || !PERIOD_ID.test(runId) || (typeof b?.hidden !== 'boolean' && typeof b?.archived !== 'boolean')) return json({ error: 'INVALID_RUN' }, 400, h);
    if (!reviewer) return json({ error: 'Cần nhập tên người duyệt' }, 400, h);
    const prev = (await readHiddenRuns(env, pid)).find((x) => x.runId === runId);
    const list = (await readHiddenRuns(env, pid)).filter((x) => x.runId !== runId);
    if (typeof b.archived === 'boolean') {
      // archive / unarchive; a deleted run stays deleted
      if (prev && !prev.archived) list.push(prev);
      else if (b.archived) list.push({ runId, by: reviewer, at: new Date().toISOString(), archived: true });
    } else if (b.hidden) list.push({ runId, by: reviewer, at: new Date().toISOString() });
    await env.REVIEWS.put(`hid:${pid}`, JSON.stringify(list.slice(-500)));
    return json({ ok: true, hidden: list }, 200, h);
  }

  if (url.pathname === '/review' && req.method === 'POST') {
    // one article ({articleId, patch}) or several at once ({items: [{articleId, patch}]}, "Chọn tất cả"): one read + one write
    if (Number(req.headers.get('content-length') ?? 0) > 200_000) return json({ error: 'TOO_LARGE' }, 413, h);
    const b = (await req.json().catch(() => null)) as { profile?: string; period?: string; articleId?: string; patch?: unknown; items?: unknown; reviewer?: string } | null;
    const pid = String(b?.profile ?? DEFAULT_PROFILE);
    const period = String(b?.period ?? '');
    const reviewer = String(b?.reviewer ?? '').trim().slice(0, 40);
    const raw = Array.isArray(b?.items) ? (b!.items as Array<{ articleId?: unknown; patch?: unknown }>) : [{ articleId: b?.articleId, patch: b?.patch }];
    if (!PROFILE_ID.test(pid) || !PERIOD_ID.test(period) || !raw.length || raw.length > 300 || raw.some((x) => !ART.test(String(x?.articleId ?? '')))) return json({ error: 'INVALID_ARTICLE' }, 400, h);
    if (!reviewer) return json({ error: 'Cần nhập tên người duyệt' }, 400, h);
    const items = raw.map((x) => ({ articleId: String(x.articleId), patch: cleanReviewPatch(x.patch) }));
    if (items.some((x) => !x.patch || !Object.keys(x.patch).length)) return json({ error: 'INVALID_PATCH' }, 400, h);
    const out = await writeReviews(env, pid, period, items, reviewer);
    return Array.isArray(b?.items) ? json({ ok: true, reviews: out }, 200, h) : json({ ok: true, review: out[items[0]!.articleId] }, 200, h);
  }

  if (url.pathname === '/labels' && req.method === 'GET') {
    const date = url.searchParams.get('date') ?? '';
    if (!DATE.test(date)) return json({ error: 'INVALID_DATE' }, 400, h);
    const { agg, changed } = await loadVoteAgg(env, date);
    if (changed) await env.REVIEWS.put(`la:${date}`, JSON.stringify(agg)).catch(() => undefined);
    const votes: Record<string, Vote[]> = {};
    for (const [articleId, byReviewer] of Object.entries(agg.votes)) votes[articleId] = Object.values(byReviewer);
    return json({ date, votes }, 200, h);
  }

  if (url.pathname === '/labels' && req.method === 'POST') {
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > 8000) return json({ error: 'TOO_LARGE' }, 413, h);
    let b: Partial<LabelRecord>;
    try {
      b = (await req.json()) as Partial<LabelRecord>;
    } catch {
      return json({ error: 'INVALID_JSON' }, 400, h);
    }
    const reviewer = String(b.reviewer ?? '').trim().slice(0, 40);
    if (!reviewer) return json({ error: 'Cần nhập tên người duyệt' }, 400, h);
    if (!DATE.test(String(b.reportDate)) || !ART.test(String(b.articleId))) return json({ error: 'INVALID_ARTICLE' }, 400, h);
    if (b.label != null && b.label !== 'relevant' && b.label !== 'irrelevant') return json({ error: 'INVALID_LABEL' }, 400, h);
    if (b.category != null && !CATEGORIES.includes(b.category)) return json({ error: 'INVALID_CATEGORY' }, 400, h);
    if (b.assessment != null && !ASSESSMENTS.includes(b.assessment)) return json({ error: 'INVALID_ASSESSMENT' }, 400, h);
    const rec: LabelRecord = {
      v: 1, reportDate: b.reportDate!, articleId: b.articleId!, url: String(b.url ?? '').slice(0, 500), title: String(b.title ?? '').slice(0, 300),
      sourceId: String(b.sourceId ?? '').slice(0, 60), reviewer, reviewerId: reviewerId(reviewer), label: b.label ?? null, category: b.category ?? null,
      assessment: b.assessment ?? null, note: String(b.note ?? '').slice(0, 1000), at: new Date().toISOString(),
    };
    const key = `l:${rec.reportDate}:${rec.articleId}:${rec.reviewerId}`;
    const { agg } = await loadVoteAgg(env, rec.reportDate);
    const saveAgg = () => env.REVIEWS.put(`la:${rec.reportDate}`, JSON.stringify(agg));
    if (!rec.label && !rec.category && !rec.assessment && !rec.note) {
      await env.REVIEWS.delete(key);
      if (agg.votes[rec.articleId]) {
        delete agg.votes[rec.articleId]![rec.reviewerId];
        if (!Object.keys(agg.votes[rec.articleId]!).length) delete agg.votes[rec.articleId];
      }
      await saveAgg();
      return json({ ok: true, deleted: true }, 200, h);
    }
    const vote: Vote = { r: rec.reviewer, l: rec.label, c: rec.category, a: rec.assessment, n: rec.note.slice(0, 200), t: rec.at };
    await env.REVIEWS.put(key, JSON.stringify(rec), { metadata: vote });
    (agg.votes[rec.articleId] ??= {})[rec.reviewerId] = vote;
    await saveAgg();
    return json({ ok: true, vote }, 200, h);
  }
  return json({ error: 'NOT_FOUND' }, 404, h);
}
