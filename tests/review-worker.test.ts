import { describe, expect, it } from 'vitest';
import { hashPassword, newSalt, saveUsers } from '../cloud/review-worker/src/accounts.js';
import { handle, ReviewPeriod, reviewerId, runKind, scheduledCollect, type DONamespaceLike, type Env, type KVLike } from '../cloud/review-worker/src/handler.js';

class MemKV implements KVLike {
  m = new Map<string, { v: string; meta?: unknown }>();
  lists = 0;
  listQuotaGone = false;
  async get(k: string) { return this.m.get(k)?.v ?? null; }
  async put(k: string, v: string, o?: { metadata?: unknown }) { this.m.set(k, { v, meta: o?.metadata }); }
  async delete(k: string) { this.m.delete(k); }
  async list(o: { prefix: string }) {
    this.lists++;
    if (this.listQuotaGone) throw new Error('KV list() limit exceeded for the day.');
    return { keys: [...this.m.entries()].filter(([k]) => k.startsWith(o.prefix)).map(([name, x]) => ({ name, metadata: x.meta })), list_complete: true };
  }
}
/** session of a seeded admin account (the shared access code was retired on 21/11/2026) */
const ADMIN = 'sess_' + 'a'.repeat(48);
const env = (kv: MemKV = new MemKV()): Env => {
  kv.m.set('cfg:users', { v: JSON.stringify([{ u: 'test-admin', name: 'Quản trị thử', role: 'admin', salt: 'x', hash: 'x', at: '', by: 'seed' }]) });
  kv.m.set(`sess:${ADMIN}`, { v: JSON.stringify({ u: 'test-admin', name: 'Quản trị thử', role: 'admin' }) });
  return { REVIEWS: kv, EXPORT_TOKEN: 'export-secret', ALLOWED_ORIGINS: 'https://bccuong.github.io' };
};
const ORIGIN = 'https://bccuong.github.io';
const post = (e: Env, body: unknown, code = ADMIN) =>
  handle(new Request('https://w.example/labels', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
const label = (p: Record<string, unknown> = {}) => ({ reviewer: 'Nguyễn Văn Đức', reportDate: '2026-11-16', articleId: 'a_1234abcd5678', url: 'https://x.vn/a', title: 'T', sourceId: 'tn', label: 'relevant', ...p });

describe('shared review worker', () => {
  it('rejects a wrong access code; CORS only for the Pages origin', async () => {
    const e = env();
    const r = await post(e, label(), 'wrong');
    expect(r.status).toBe(401);
    const bad = await handle(new Request('https://w.example/health', { headers: { origin: 'https://evil.example' } }), e);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const good = await handle(new Request('https://w.example/health', { headers: { origin: ORIGIN } }), e);
    expect(good.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
  it('stores one vote per reviewer per article, lists all votes of a day', async () => {
    const e = env();
    expect((await post(e, label())).status).toBe(200);
    expect((await post(e, label({ reviewer: 'Trần Thị B', label: 'irrelevant', note: 'tin thể thao' }))).status).toBe(200);
    expect((await post(e, label({ label: 'irrelevant', category: 'FLOOD' }))).status).toBe(200); // same reviewer → overwrite
    const r = await handle(new Request('https://w.example/labels?date=2026-11-16', { headers: { origin: ORIGIN, 'x-review-code': ADMIN } }), e);
    const j = (await r.json()) as { votes: Record<string, Array<{ r: string; l: string; c: string | null }>> };
    const v = j.votes['a_1234abcd5678']!;
    expect(v).toHaveLength(2);
    expect(v.find((x) => x.r === 'Nguyễn Văn Đức')).toMatchObject({ l: 'irrelevant', c: 'FLOOD' });
  });
  it('validates input and clearing a vote deletes it', async () => {
    const e = env();
    expect((await post(e, label({ label: 'maybe' }))).status).toBe(400);
    expect((await post(e, label({ category: 'SPORT' }))).status).toBe(400);
    expect((await post(e, label({ reviewer: '' }))).status).toBe(400);
    expect((await post(e, label({ articleId: '../x' }))).status).toBe(400);
    await post(e, label());
    await post(e, label({ label: null }));
    expect([...(e.REVIEWS as MemKV).m.keys()].filter((k) => k.startsWith('l:'))).toEqual([]);
    const r = await handle(new Request('https://w.example/labels?date=2026-11-16', { headers: { origin: ORIGIN, 'x-review-code': ADMIN } }), e);
    expect(((await r.json()) as { votes: object }).votes).toEqual({});
  });
  it('export needs the bearer token and returns full records', async () => {
    const e = env();
    await post(e, label());
    expect((await handle(new Request('https://w.example/export'), e)).status).toBe(401);
    const r = await handle(new Request('https://w.example/export', { headers: { authorization: 'Bearer export-secret' } }), e);
    const j = (await r.json()) as { count: number; labels: Array<{ reviewerId: string; title: string }> };
    expect(j.count).toBe(1);
    expect(j.labels[0]!.reviewerId).toBe('nguyen-van-duc');
  });
  it('secrets stored with a trailing newline (shell pipe) still match', async () => {
    const e = { ...env(), EXPORT_TOKEN: 'export-secret\n' };
    expect((await handle(new Request('https://w.example/export', { headers: { authorization: 'Bearer export-secret' } }), e)).status).toBe(200);
    expect((await handle(new Request('https://w.example/export', { headers: { authorization: 'Bearer export-secre' } }), e)).status).toBe(401);
  });
  describe('on-demand collection (dispatch GitHub workflow)', () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fakeGitHub = (busy = false) => async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes('/runs?status=')) return new Response(JSON.stringify({ total_count: busy && url.includes('in_progress') ? 1 : 0 }), { status: 200 });
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (url.includes('/runs?per_page')) return new Response(JSON.stringify({ workflow_runs: [{ id: 7, status: 'in_progress', conclusion: null, created_at: 'c', updated_at: 'u', event: 'workflow_dispatch', display_title: 'Thu thập theo yêu cầu', html_url: 'https://github.com/x' }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const genv = (): Env => ({ ...env(), GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'bccuong/news-reporter', COLLECT_WORKFLOW: 'pages.yml' });
    const req = (body: unknown, code = ADMIN) =>
      new Request('https://w.example/collect', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const W = { from: '2026-11-14T17:00+07:00', to: '2026-11-15T08:00+07:00', reviewer: 'A' };

    it('dispatches the workflow with the requested window', async () => {
      calls.length = 0;
      const r = await handle(req(W), genv(), fakeGitHub());
      expect(r.status).toBe(202);
      const d = calls.find((c) => c.url.endsWith('/actions/workflows/pages.yml/dispatches'))!;
      expect(JSON.parse(d.body!)).toEqual({ ref: 'main', inputs: { from: W.from, to: W.to, requested_by: 'A', profile: 'hcm' } });
    });
    it('refuses while another collection runs, bad windows, wrong code, missing token', async () => {
      expect((await handle(req(W), genv(), fakeGitHub(true))).status).toBe(409);
      expect((await handle(req({ ...W, to: W.from }), genv(), fakeGitHub())).status).toBe(400);
      expect((await handle(req({ ...W, from: '2026-11-01T00:00+07:00' }), genv(), fakeGitHub())).status).toBe(400); // > 72 h
      expect((await handle(req({ ...W, from: '2026-11-14 17:00' }), genv(), fakeGitHub())).status).toBe(400);
      expect((await handle(req({ ...W, from: '2099-01-01T00:00+07:00', to: '2099-01-01T05:00+07:00' }), genv(), fakeGitHub())).status).toBe(400);
      expect((await handle(req(W, 'wrong'), genv(), fakeGitHub())).status).toBe(401);
      expect((await handle(req(W), env(), fakeGitHub())).status).toBe(503);
    });
    it('reports recent workflow runs for the progress display', async () => {
      const r = await handle(new Request('https://w.example/collect/status', { headers: { origin: ORIGIN, 'x-review-code': ADMIN } }), genv(), fakeGitHub());
      const j = (await r.json()) as { enabled: boolean; runs: Array<{ id: number; status: string }> };
      expect(j.enabled).toBe(true);
      expect(j.runs[0]).toMatchObject({ id: 7, status: 'in_progress' });
    });
  });
  describe('automatic collection at fixed times (worker cron every 5 min) + public server status', () => {
    const calls: string[] = [];
    let running: Array<Record<string, unknown>> = [];
    const gh = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
      if (url.includes('/runs?status=')) return new Response(JSON.stringify({ total_count: url.includes('in_progress') ? running.length : 0 }), { status: 200 });
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (url.includes('/runs?per_page')) return new Response(JSON.stringify({ workflow_runs: running }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const genv = (): Env => ({ ...env(), GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'bccuong/news-reporter', COLLECT_WORKFLOW: 'pages.yml' });
    const setSlot = (e: Env, slot: unknown, enabled: unknown, code = ADMIN, profile = 'hcm') =>
      handle(new Request('https://w.example/auto', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify({ slot, enabled, reviewer: 'B', profile }) }), e, gh);
    const at = (vn: string) => new Date(`${vn}+07:00`);
    const dispatched = () => calls.filter((c) => c.includes('/dispatches')).map((c) => JSON.parse(c.slice(c.indexOf('{'))).inputs);

    it('08:00 collects 17:00 yesterday → 08:00, 16:30 collects 08:01 → 16:30; once per day; only ticked slots', async () => {
      const e = genv();
      running = [];
      calls.length = 0;
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:05'))).toBeNull(); // nothing ticked
      expect((await setSlot(e, 'morning', true, 'wrong')).status).toBe(401);
      expect((await setSlot(e, 'evening', true)).status).toBe(400);
      expect((await setSlot(e, 'morning', 'yes')).status).toBe(400);
      expect((await setSlot(e, 'morning', true)).status).toBe(200);
      expect((await setSlot(e, 'afternoon', true)).status).toBe(200);
      // outside the dispatch windows: no KV, no GitHub
      expect(await scheduledCollect(e, gh, at('2026-11-17T07:55'))).toBeNull();
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:01'))).toBeNull(); // feeds catch up first (+2 min)
      expect(await scheduledCollect(e, gh, at('2026-11-17T10:05'))).toBeNull(); // window closed (+2 h)
      expect(calls).toEqual([]);
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:02'))).toMatchObject({ result: 'dispatched', profiles: ['hcm'], slot: '08:00' });
      expect(dispatched()[0]).toEqual({ trigger: 'schedule', slot: '08:00', from: '2026-11-16T17:00+07:00', to: '2026-11-17T08:01+07:00', profile: 'hcm', requested_by: '' });
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:07'))).toBeNull(); // already done today
      expect(await scheduledCollect(e, gh, at('2026-11-17T16:35'))).toMatchObject({ result: 'dispatched', slot: '16:30' });
      expect(dispatched()[1]).toMatchObject({ from: '2026-11-17T08:01+07:00', to: '2026-11-17T16:30+07:00' }); // joins the morning period: no minute missed
      // next day again
      expect(await scheduledCollect(e, gh, at('2026-11-18T08:10'))).toMatchObject({ result: 'dispatched' });
      expect(dispatched()[2]).toMatchObject({ from: '2026-11-17T17:00+07:00', to: '2026-11-18T08:01+07:00' }); // the minute 08:00 belongs to the morning period
      // unticked → no run
      await setSlot(e, 'afternoon', false);
      expect(await scheduledCollect(e, gh, at('2026-11-18T16:40'))).toBeNull();
      const st = (await (await handle(new Request('https://w.example/status', { headers: { origin: ORIGIN } }), e, gh)).json()) as { profiles: Array<{ id: string; schedule: object; autoBy: string }>; lastAuto: { result: string; slot: string } };
      expect(st.profiles[0]).toMatchObject({ id: 'hcm', schedule: { morning: true, afternoon: false }, autoBy: 'B' });
      expect(st.lastAuto).toMatchObject({ result: 'dispatched', slot: '08:00' });
    });
    it('times changed in Settings: validated, saved per profile, used by the cron and shown in /status (19/11/2026)', async () => {
      const e = genv();
      running = [];
      calls.length = 0;
      const setTimes = (times: unknown, code = ADMIN) =>
        handle(new Request('https://w.example/auto/times', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify({ times, reviewer: 'C', profile: 'hcm' }) }), e, gh);
      await setSlot(e, 'morning', true);
      expect((await setTimes({ morning: { at: '07:30', from: '17:30' } }, 'wrong')).status).toBe(401);
      expect((await setTimes({ morning: { at: '23:30', from: '17:30' } })).status).toBe(400);
      expect((await setTimes('x')).status).toBe(400);
      expect((await setTimes({ morning: { at: '07:30', from: '17:30', to: '07:30' } })).status).toBe(200); // "Đến" = run time is not stored
      expect(await scheduledCollect(e, gh, at('2026-11-19T08:02'))).toMatchObject({ result: 'dispatched', slot: '07:30' });
      expect(dispatched()[0]).toMatchObject({ slot: '07:30', from: '2026-11-18T17:30+07:00', to: '2026-11-19T07:31+07:00' });
      const st = (await (await handle(new Request('https://w.example/status', { headers: { origin: ORIGIN } }), e, gh)).json()) as { profiles: Array<{ scheduleTimes: object; scheduleDone: string[] }> };
      // (scheduleDone is counted for the REAL today, so it is not checked against the simulated 19/11)
      expect(st.profiles[0]).toMatchObject({ scheduleTimes: { morning: { at: '07:30', from: '17:30' } } });
      // back to the defaults
      expect((await setTimes({})).status).toBe(200);
      expect(await scheduledCollect(e, gh, at('2026-11-20T07:35'))).toBeNull();
      expect(await scheduledCollect(e, gh, at('2026-11-20T08:02'))).toMatchObject({ result: 'dispatched', slot: '08:00' });
    });
    it('busy server → tried again on the next tick (not skipped for the day); status names the running run kind', async () => {
      const e = genv();
      await setSlot(e, 'morning', true);
      running = [{ id: 1, status: 'in_progress', conclusion: null, created_at: 'c', updated_at: 'u', event: 'push', display_title: 'Live data', html_url: 'h' }];
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:02'))).toMatchObject({ result: 'busy' });
      const st = (await (await handle(new Request('https://w.example/status'), e, gh)).json()) as { running: Array<{ kind: string }> };
      expect(st.running[0]!.kind).toBe('deploy');
      running = [];
      expect(await scheduledCollect(e, gh, at('2026-11-17T08:07'))).toMatchObject({ result: 'dispatched' });
      expect(runKind({ event: 'workflow_dispatch', display_title: 'Thu thập theo lịch 08:00: a → b [hcm]' })).toBe('auto');
      expect(runKind({ event: 'workflow_dispatch', display_title: 'Thu thập theo yêu cầu x → y (A)' })).toBe('request');
      const n = genv();
      await setSlot(n, 'morning', true);
      expect(await scheduledCollect({ ...n, GITHUB_TOKEN: '' } as Env, gh, at('2026-11-17T08:02'))).toMatchObject({ result: 'not_configured' });
    });
  });
  describe('accounts: user name + password, managed in Cài đặt › Tài khoản (20/11/2026)', () => {
    const seed = async (e: Env) => {
      const salt = newSalt();
      await saveUsers(e.REVIEWS, [{ u: 'admin', name: 'Quản trị', role: 'admin', salt, hash: await hashPassword('Bcc123@', salt), at: '', by: 'seed' }]);
    };
    const call = (e: Env, path: string, body?: unknown, code?: string) =>
      handle(new Request(`https://w.example${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(code ? { 'x-review-code': code } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    it('login → session token used like the old code; wrong password refused; the retired shared code is refused', async () => {
      const e = env();
      await seed(e);
      expect((await call(e, '/login', { username: 'admin', password: 'sai' })).status).toBe(401);
      const r = (await (await call(e, '/login', { username: 'Admin', password: 'Bcc123@' })).json()) as { token: string; name: string; role: string };
      expect(r).toMatchObject({ name: 'Quản trị', role: 'admin' });
      expect(r.token).toMatch(/^sess_[0-9a-f]{48}$/);
      expect(await (await call(e, '/me', undefined, r.token)).json()).toEqual({ user: 'admin', name: 'Quản trị', role: 'admin' });
      expect((await call(e, '/me', undefined, 'sess_' + '0'.repeat(48))).status).toBe(401);
      // the shared access code was retired (21/11/2026): even with ACCESS_CODE still set on the worker it opens nothing
      expect((await call({ ...e, ACCESS_CODE: 'HCM-test-1234' } as Env, '/me', undefined, 'HCM-test-1234')).status).toBe(401);
      expect(JSON.stringify(await (await call(e, '/users', undefined, r.token)).json())).not.toMatch(/hash|salt/);
      // logout ends the session
      await call(e, '/logout', {}, r.token);
      expect((await call(e, '/me', undefined, r.token)).status).toBe(401);
    });
    it('only an admin manages accounts; at least one admin stays; everyone changes their own password', async () => {
      const e = env();
      await seed(e);
      const admin = ((await (await call(e, '/login', { username: 'admin', password: 'Bcc123@' })).json()) as { token: string }).token;
      expect((await call(e, '/users', { u: 'Nghia', name: 'Nghĩa', password: '123', role: 'reviewer' }, admin)).status).toBe(400); // short password
      expect((await call(e, '/users', { u: 'nghia', name: 'Nghĩa', password: 'matkhau1', role: 'reviewer' }, admin)).status).toBe(200);
      const rev = ((await (await call(e, '/login', { username: 'nghia', password: 'matkhau1' })).json()) as { token: string; role: string });
      expect(rev.role).toBe('reviewer');
      expect((await call(e, '/users', undefined, rev.token)).status).toBe(403);
      expect((await call(e, '/users', { u: 'x', name: 'X', password: 'abcdef' }, rev.token)).status).toBe(403);
      // the reviewer session works for the team's endpoints (e.g. collection status)
      expect((await call(e, '/collect/status', undefined, rev.token)).status).toBe(200);
      // own password
      expect((await call(e, '/users/password', { password: 'moi-123' }, rev.token)).status).toBe(200);
      expect((await call(e, '/login', { username: 'nghia', password: 'matkhau1' })).status).toBe(401);
      expect((await call(e, '/login', { username: 'nghia', password: 'moi-123' })).status).toBe(200);
      // last admin cannot be removed or demoted; self-delete refused
      expect((await call(e, '/users/delete', { u: 'admin' }, admin)).status).toBe(400);
      expect((await call(e, '/users', { u: 'admin', name: 'Quản trị', role: 'reviewer' }, admin)).status).toBe(400);
      // deleting a user ends their sessions at once
      expect((await call(e, '/users/delete', { u: 'nghia' }, admin)).status).toBe(200);
      expect((await call(e, '/me', undefined, rev.token)).status).toBe(401);
    });
  });
  describe('reviewer vs admin (20/11/2026)', () => {
    it('reviewers do the daily work; system-wide changes are refused with 403', async () => {
      const e = env();
      const salt = newSalt();
      await saveUsers(e.REVIEWS, [
        { u: 'admin', name: 'Quản trị', role: 'admin', salt, hash: await hashPassword('Bcc123@', salt), at: '', by: '' },
        { u: 'nghia', name: 'Nghĩa', role: 'reviewer', salt, hash: await hashPassword('matkhau1', salt), at: '', by: '' },
      ]);
      const tok = async (u: string, p: string) => ((await (await handle(new Request('https://w.example/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }), e)).json()) as { token: string }).token;
      const rev = await tok('nghia', 'matkhau1');
      const adm = await tok('admin', 'Bcc123@');
      const post = (code: string, path: string, body: unknown, method = 'POST') => handle(new Request(`https://w.example${path}`, { method, headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
      for (const [path, body, method] of [
        ['/token', { token: 'github_pat_' + 'A'.repeat(40), reviewer: 'Nghĩa' }, 'POST'],
        ['/config', { profile: 'hcm', settings: {}, reviewer: 'Nghĩa' }, 'POST'],
        ['/config/rollback', { profile: 'hcm', id: 'x', reviewer: 'Nghĩa' }, 'POST'],
        ['/profiles', { id: 'da-nang', name: 'Đà Nẵng', reviewer: 'Nghĩa' }, 'POST'],
        ['/profiles/hcm', { name: 'X', reviewer: 'Nghĩa' }, 'PATCH'],
        ['/profiles/hcm', {}, 'DELETE'],
        ['/auto', { slot: 'morning', enabled: true, reviewer: 'Nghĩa', profile: 'hcm' }, 'POST'],
        ['/auto/times', { times: {}, reviewer: 'Nghĩa', profile: 'hcm' }, 'POST'],
        ['/runs/hide', { profile: 'hcm', runId: '2026-11-19', hidden: true, reviewer: 'Nghĩa' }, 'POST'],
      ] as const) {
        const r = await post(rev, path, body, method);
        expect(r.status, `${method} ${path}`).toBe(403);
        expect(((await r.json()) as { error: string }).error).toBe('Chỉ quản trị viên được làm việc này');
      }
      // archiving a run stays open to reviewers; the admin passes the same checks
      expect((await post(rev, '/runs/hide', { profile: 'hcm', runId: '2026-11-19', archived: true, reviewer: 'Nghĩa' })).status).not.toBe(403);
      expect((await post(adm, '/auto', { slot: 'morning', enabled: true, reviewer: 'Quản trị', profile: 'hcm' })).status).toBe(200);
      // the retired shared code is no admin any more
      expect((await post('HCM-test-1234', '/auto', { slot: 'morning', enabled: false, reviewer: 'X', profile: 'hcm' })).status).toBe(401);
    });
  });
  describe('collection token replaced from Cài đặt (20/11/2026)', () => {
    const GOOD = 'github_pat_' + 'A'.repeat(40) + 'gOOd';
    const NOPERM = 'github_pat_' + 'B'.repeat(40) + 'noPm';
    const REVOKED = 'github_pat_' + 'C'.repeat(40) + 'dead';
    const used: string[] = [];
    // fake GitHub: GOOD reads the repo and may dispatch, NOPERM only reads, REVOKED is refused
    const gh = async (url: string, init?: RequestInit) => {
      const tok = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
      used.push(`${init?.method ?? 'GET'} ${url} ${tok.slice(-4)}`);
      if (tok === REVOKED) return new Response('{}', { status: 401 });
      const exp = { 'github-authentication-token-expiration': '2027-11-21 04:06:07 UTC' };
      if (url.endsWith('/dispatches')) return new Response('{}', { status: tok === GOOD ? 422 : 403 });
      if (url.includes('/runs?per_page')) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: exp });
      if (url.includes('/runs?status=')) return new Response(JSON.stringify({ total_count: 0 }), { status: 200 });
      return new Response('{}', { status: 200, headers: exp });
    };
    const genv = (): Env => ({ ...env(), GITHUB_TOKEN: 'github_pat_' + 'S'.repeat(40) + 'srvr', GITHUB_REPO: 'tinbaochi/tinbaochi.github.io', COLLECT_WORKFLOW: 'pages.yml' });
    const post = (e: Env, token: string, code = ADMIN) => handle(new Request('https://w.example/token', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify({ token, reviewer: 'Cường' }) }), e, gh);
    it('checked before saving, never sent back, then used for status / collection; expiry shown', async () => {
      const e = genv();
      expect((await post(e, GOOD, 'wrong')).status).toBe(401);
      expect(((await (await post(e, 'abc')).json()) as { error: string }).error).toMatch(/không đúng dạng/);
      expect(((await (await post(e, REVOKED)).json()) as { error: string }).error).toMatch(/không nhận khóa/);
      expect(((await (await post(e, NOPERM)).json()) as { error: string }).error).toMatch(/Actions: Read and write/);
      // the permission probe dispatches to a branch that does not exist: nothing can run
      expect(used.filter((u) => u.includes('/dispatches'))).toEqual(['POST https://api.github.com/repos/tinbaochi/tinbaochi.github.io/actions/workflows/pages.yml/dispatches noPm']);
      const ok = await post(e, GOOD);
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).not.toContain(GOOD);
      expect(JSON.parse(body).token).toMatchObject({ last4: 'gOOd', by: 'Cường', expiresAt: '2027-11-21T04:06:07.000Z', source: 'web' });
      const info = await (await handle(new Request('https://w.example/token', { headers: { origin: ORIGIN, 'x-review-code': ADMIN } }), e, gh)).text();
      expect(info).not.toContain(GOOD);
      expect(JSON.parse(info)).toMatchObject({ source: 'web', last4: 'gOOd', ok: true, expiresAt: '2027-11-21T04:06:07.000Z' });
      // public status: the saved token is used, only the expiry date is public
      used.length = 0;
      const st = (await (await handle(new Request('https://w.example/status', { headers: { origin: ORIGIN } }), e, gh)).json()) as { token: { expiresAt: string } };
      expect(st.token).toEqual({ expiresAt: '2027-11-21T04:06:07.000Z', rejected: false });
      expect(used.every((u) => u.endsWith('gOOd'))).toBe(true);
    });
    it('without a saved token the wrangler secret is used; a refused token shows on the status', async () => {
      const e = genv();
      used.length = 0;
      await handle(new Request('https://w.example/status', { headers: { origin: ORIGIN } }), e, gh);
      expect(used.every((u) => u.endsWith('srvr'))).toBe(true);
      const st = (await (await handle(new Request('https://w.example/status', { headers: { origin: ORIGIN } }), { ...e, GITHUB_TOKEN: REVOKED }, gh)).json()) as { token: { rejected: boolean } };
      expect(st.token.rejected).toBe(true);
    });
  });
  describe('shared collector configuration + image proxy', () => {
    const H = { origin: ORIGIN, 'x-review-code': ADMIN, 'content-type': 'application/json' };
    const put = (e: Env, settings: unknown, summary: string, code = ADMIN) =>
      handle(new Request('https://w.example/config', { method: 'POST', headers: { ...H, 'x-review-code': code }, body: JSON.stringify({ settings, sources: [{ id: 's1' }], summary, reviewer: 'C' }) }), e);
    it('public read, reviewer write, every save kept in history, rollback restores', async () => {
      const e = env();
      expect(await (await handle(new Request('https://w.example/config'), e)).json()).toEqual({ config: null });
      expect((await put(e, { a: 1 }, 'v1', 'wrong')).status).toBe(401);
      expect((await handle(new Request('https://w.example/config', { method: 'POST', headers: H, body: JSON.stringify({ settings: [], sources: 'x' }) }), e)).status).toBe(400);
      expect((await put(e, { a: 1 }, 'v1')).status).toBe(200);
      await new Promise((r) => setTimeout(r, 5));
      expect((await put(e, { a: 2 }, 'v2')).status).toBe(200);
      const cur = (await (await handle(new Request('https://w.example/config'), e)).json()) as { config: { settings: { a: number }; by: string; summary: string } };
      expect(cur.config).toMatchObject({ settings: { a: 2 }, by: 'C', summary: 'v2' });
      const hist = (await (await handle(new Request('https://w.example/config/history', { headers: H }), e)).json()) as { items: Array<{ id: string; summary: string }> };
      expect(hist.items.map((x) => x.summary)).toEqual(['v1']);
      expect((await handle(new Request('https://w.example/config/rollback', { method: 'POST', headers: H, body: JSON.stringify({ id: hist.items[0]!.id }) }), e)).status).toBe(200);
      const back = (await (await handle(new Request('https://w.example/config'), e)).json()) as { config: { settings: { a: number }; summary: string } };
      expect(back.config.settings.a).toBe(1);
      expect(back.config.summary).toMatch(/^Khôi phục/);
    });
    it('image proxy: reviewers only, https public images only', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const f = async (url: string) => (url.includes('ok.vn') ? new Response(png, { headers: { 'content-type': 'image/png' } }) : new Response('<html>', { headers: { 'content-type': 'text/html' } }));
      const get = (u: string, code = ADMIN) => handle(new Request(`https://w.example/img?url=${encodeURIComponent(u)}`, { headers: { origin: ORIGIN, 'x-review-code': code } }), env(), f);
      const r = await get('https://ok.vn/a.png');
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(png);
      expect((await get('https://ok.vn/a.png', 'wrong')).status).toBe(401);
      expect((await get('http://ok.vn/a.png')).status).toBe(400);
      expect((await get('https://127.0.0.1/a.png')).status).toBe(400);
      expect((await get('https://page.vn/not-image')).status).toBe(502);
    });
  });
  describe('profiles (cấu hình theo địa bàn)', () => {
    const H = { origin: ORIGIN, 'x-review-code': ADMIN, 'content-type': 'application/json' };
    const req = (e: Env, method: string, p: string, body?: unknown, code = ADMIN) =>
      handle(new Request(`https://w.example${p}`, { method, headers: { ...H, 'x-review-code': code }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    it('default TP.HCM (legacy config + switch kept), create / rename / delete, config per profile', async () => {
      const e = env();
      // configuration and hourly switch saved before profiles existed
      await e.REVIEWS.put('cfg:config', JSON.stringify({ settings: { v: 'old' }, sources: [], by: 'X', at: 't', summary: 's' }));
      await e.REVIEWS.put('cfg:auto', JSON.stringify({ enabled: false, by: 'Y', at: 't' }));
      const list = (await (await handle(new Request('https://w.example/profiles'), e)).json()) as { profiles: Array<{ id: string; autoCollect: boolean }> };
      expect(list.profiles).toEqual([expect.objectContaining({ id: 'hcm', autoCollect: false })]);
      expect(((await (await handle(new Request('https://w.example/config?profile=hcm'), e)).json()) as { config: { settings: { v: string } } }).config.settings.v).toBe('old');

      expect((await req(e, 'POST', '/profiles', { name: 'Hà Nội', settings: { v: 'hn' }, sources: [] }, 'wrong')).status).toBe(401);
      expect((await req(e, 'POST', '/profiles', { name: '', settings: {}, sources: [] })).status).toBe(400);
      const hn = (await (await req(e, 'POST', '/profiles', { name: 'Hà Nội', settings: { v: 'hn' }, sources: [], reviewer: 'B' })).json()) as { id: string; autoCollect: boolean };
      expect(hn).toMatchObject({ id: 'ha-noi', autoCollect: false });
      expect(((await (await handle(new Request('https://w.example/config?profile=ha-noi'), e)).json()) as { config: { settings: { v: string } } }).config.settings.v).toBe('hn');
      // config + history are per profile
      expect((await req(e, 'POST', '/config', { profile: 'ha-noi', settings: { v: 'hn2' }, sources: [] })).status).toBe(200);
      const hist = (await (await req(e, 'GET', '/config/history?profile=ha-noi')).json()) as { items: unknown[] };
      expect(hist.items).toHaveLength(1);
      expect(((await (await handle(new Request('https://w.example/config?profile=hcm'), e)).json()) as { config: { settings: { v: string } } }).config.settings.v).toBe('old');
      expect((await req(e, 'POST', '/config', { profile: 'khong-co', settings: {}, sources: [] })).status).toBe(404);
      // fixed collection times per profile
      expect((await req(e, 'POST', '/auto', { slot: 'morning', enabled: true, profile: 'ha-noi', reviewer: 'B' })).status).toBe(200);
      expect(((await (await req(e, 'PATCH', '/profiles/ha-noi', { name: 'Thủ đô' })).json()) as { name: string }).name).toBe('Thủ đô');
      const after = (await (await handle(new Request('https://w.example/profiles'), e)).json()) as { profiles: Array<{ id: string; schedule?: { morning?: boolean }; name: string }> };
      expect(after.profiles.map((p) => [p.id, !!p.schedule?.morning])).toEqual([['hcm', false], ['ha-noi', true]]);
      expect((await req(e, 'DELETE', '/profiles/ha-noi')).status).toBe(200);
      expect((await req(e, 'DELETE', '/profiles/hcm')).status).toBe(400); // never the last one
    });
    it('cron: every profile with the slot ticked gets its own run (one per tick); on-demand names the profile', async () => {
      const e = { ...env(), GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'bccuong/news-reporter', COLLECT_WORKFLOW: 'pages.yml' };
      const calls: string[] = [];
      const f = async (url: string, init?: RequestInit) => {
        calls.push(`${url} ${init?.body ?? ''}`);
        if (url.includes('/runs?status=')) return new Response(JSON.stringify({ total_count: 0 }), { status: 200 });
        return new Response(null, { status: 204 });
      };
      await e.REVIEWS.put('cfg:profiles', JSON.stringify([
        { id: 'hcm', name: 'TP.HCM', description: '', autoCollect: false, schedule: { morning: true }, clonedFrom: null, createdAt: '', updatedAt: '' },
        { id: 'da-nang', name: 'Đà Nẵng', description: '', autoCollect: false, schedule: { morning: true }, clonedFrom: null, createdAt: '', updatedAt: '' },
        { id: 'ha-noi', name: 'Hà Nội', description: '', autoCollect: true, clonedFrom: null, createdAt: '', updatedAt: '' },
      ]));
      const t1 = new Date('2026-11-17T08:02+07:00');
      expect(await scheduledCollect(e, f, t1)).toMatchObject({ result: 'dispatched', profiles: ['hcm'] });
      expect(await scheduledCollect(e, f, new Date('2026-11-17T08:07+07:00'))).toMatchObject({ result: 'dispatched', profiles: ['da-nang'] });
      expect(await scheduledCollect(e, f, new Date('2026-11-17T08:12+07:00'))).toBeNull(); // ha-noi only had the old hourly switch
      const r = await handle(new Request('https://w.example/collect', { method: 'POST', headers: H, body: JSON.stringify({ from: '2026-11-14T17:00+07:00', to: '2026-11-15T08:00+07:00', reviewer: 'A', profile: 'nowhere' }) }), e, f);
      expect(r.status).toBe(400);
    });
  });
  describe('shared editorial review (one decision per article per period, whole team)', () => {
    const rv = (e: Env, body: unknown, code = ADMIN) =>
      handle(new Request('https://w.example/review', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
    const read = async (e: Env, period = 'custom-202611151700-202611161145', profile = 'hcm') =>
      (await (await handle(new Request(`https://w.example/review?profile=${profile}&period=${period}`, { headers: { origin: ORIGIN } }), e)).json()) as { reviews: Record<string, any> };
    const P = 'custom-202611151700-202611161145';
    it('Cloudflare KV reads can be ~60 s old: saved edits were overwritten by the next save (18/11/2026) – the Durable Object keeps every save', async () => {
      /** KV like Cloudflare: a read returns the copy cached by the first read for 60 s */
      class StaleKV extends MemKV {
        cache = new Map<string, string | null>();
        override async get(k: string) {
          if (!this.cache.has(k)) this.cache.set(k, await super.get(k));
          return this.cache.get(k)!;
        }
      }
      /** Durable Object namespace: one object per name, requests one at a time */
      const doNs = (e: Env): DONamespaceLike => {
        const objs = new Map<string, { obj: ReviewPeriod; q: Promise<unknown> }>();
        return {
          idFromName: (n) => n,
          get: (id) => ({
            fetch: (input, init) => {
              let o = objs.get(String(id));
              if (!o) {
                const store = new Map<string, unknown>();
                o = { obj: new ReviewPeriod({ storage: { get: async <T,>(k: string) => structuredClone(store.get(k)) as T | undefined, put: async (k, v) => void store.set(k, structuredClone(v)) } }, e), q: Promise.resolve() };
                objs.set(String(id), o);
              }
              const run = o.q.then(() => o!.obj.fetch(new Request(input, init)));
              o.q = run.catch(() => undefined);
              return run;
            },
          }),
        };
      };
      const A = 'a_0e625d5a32f2d0ce';
      const B = 'a_1234abcd5678';
      const edits = async (e: Env) => {
        await read(e); // the page loads the period (KV caches this copy)
        await rv(e, { profile: 'hcm', period: P, articleId: A, patch: { title: 'Tiêu đề đã sửa' }, reviewer: 'Cường' });
        await rv(e, { profile: 'hcm', period: P, articleId: A, patch: { summary: 'Tóm tắt đã sửa' }, reviewer: 'Cường' });
        await rv(e, { profile: 'hcm', period: P, articleId: B, patch: { included: true }, reviewer: 'Người B' });
        return (await read(e)).reviews;
      };
      // KV only: the stale copy loses the first saves
      const kvOnly = env(new StaleKV());
      const lost = await edits(kvOnly);
      expect(lost[A]?.title).toBeUndefined();
      // with the Durable Object: every save is kept, and KV holds a copy
      const e = env(new StaleKV());
      e.REVIEW_DO = doNs(e);
      const kept = await edits(e);
      expect(kept[A]).toMatchObject({ title: 'Tiêu đề đã sửa', summary: 'Tóm tắt đã sửa', by: 'Cường' });
      expect(kept[B]).toMatchObject({ included: true });
      expect(JSON.parse((await new MemKV().get.call(e.REVIEWS as MemKV, 'rva:hcm:' + P))!).reviews[A].title).toBe('Tiêu đề đã sửa');
      // a period reviewed before the change is imported from KV once
      const old = env();
      await rv(old, { profile: 'hcm', period: P, articleId: B, patch: { excludedByEditor: true }, reviewer: 'Người A' });
      old.REVIEW_DO = doNs(old);
      expect((await read(old)).reviews[B]).toMatchObject({ excludedByEditor: true });
    });
    it('public read, reviewer write; patches merge per article and record who/when', async () => {
      const e = env();
      expect((await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { included: true }, reviewer: 'A' }, 'wrong')).status).toBe(401);
      expect((await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { included: true, order: 3 }, reviewer: 'Người A' })).status).toBe(200);
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { promotedToReady: true, summary: 'Tóm tắt đã sửa' }, reviewer: 'Người B' });
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_9999abcd0000', patch: { excludedByEditor: true, included: false }, reviewer: 'Người A' });
      const r = (await read(e)).reviews;
      expect(r['a_1234abcd5678']).toMatchObject({ included: true, order: 3, promotedToReady: true, summary: 'Tóm tắt đã sửa', by: 'Người B' });
      expect(r['a_9999abcd0000']).toMatchObject({ excludedByEditor: true, included: false, by: 'Người A' });
      // other periods and profiles are separate
      expect((await read(e, 'custom-202611161700-202611170800')).reviews).toEqual({});
      expect((await read(e, P, 'ha-noi')).reviews).toEqual({});
    });
    it('reads never use KV list() (1,000/day on the free plan): F5 keeps working when the quota is used up', async () => {
      const e = env();
      const kv = e.REVIEWS as MemKV;
      // a period saved the old way (one key per article), before the aggregate existed
      await kv.put(`rv:hcm:${P}:a_1111abcd1111`, JSON.stringify({ articleId: 'a_1111abcd1111', included: true, by: 'Cũ', at: '2026-11-16T01:00:00.000Z' }), { metadata: { articleId: 'a_1111abcd1111', included: true, by: 'Cũ', at: '2026-11-16T01:00:00.000Z', txt: false } });
      kv.listQuotaGone = true;
      let j = (await read(e)) as { reviews: Record<string, unknown>; pending?: string };
      expect(j.pending).toBeTruthy(); // old keys wait, no crash
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_2222abcd2222', patch: { included: true }, reviewer: 'Mới' });
      j = (await read(e)) as typeof j;
      expect(Object.keys(j.reviews)).toEqual(['a_2222abcd2222']);
      // quota back: the old decision is merged once, then reads are list-free
      kv.listQuotaGone = false;
      j = (await read(e)) as typeof j;
      expect(Object.keys(j.reviews).sort()).toEqual(['a_1111abcd1111', 'a_2222abcd2222']);
      expect(j.pending).toBeUndefined();
      const before = kv.lists;
      for (let i = 0; i < 5; i++) await read(e);
      expect(kv.lists).toBe(before);
      // labels: same, one get per read
      await post(e, label());
      const l0 = kv.lists;
      for (let i = 0; i < 3; i++) await handle(new Request('https://w.example/labels?date=2026-11-16', { headers: { origin: ORIGIN, 'x-review-code': ADMIN } }), e);
      expect(kv.lists).toBe(l0);
    });
    it('a batch ("Chọn tất cả") is saved in one request: one read + one write, every item validated', async () => {
      const e = env();
      const kv = e.REVIEWS as MemKV;
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_1111abcd1111', patch: { included: true, order: 1 }, reviewer: 'A' });
      let puts = 0;
      const put = kv.put.bind(kv);
      kv.put = async (k, v, o) => (puts++, put(k, v, o));
      const ids = ['a_1111abcd1111', 'a_2222abcd2222', 'a_3333abcd3333'];
      const r = await rv(e, { profile: 'hcm', period: P, items: ids.map((articleId) => ({ articleId, patch: { included: false } })), reviewer: 'B' });
      expect(r.status).toBe(200);
      expect(Object.keys(((await r.json()) as { reviews: object }).reviews)).toEqual(ids);
      expect(puts).toBe(1);
      const all = (await read(e)).reviews;
      expect(all['a_1111abcd1111']).toMatchObject({ included: false, order: 1, by: 'B' }); // merged, not replaced
      expect(all['a_3333abcd3333']).toMatchObject({ included: false });
      // one bad item → nothing saved
      expect((await rv(e, { profile: 'hcm', period: P, items: [{ articleId: 'a_1111abcd1111', patch: { included: true } }, { articleId: 'bad', patch: { included: true } }], reviewer: 'B' })).status).toBe(400);
      expect((await rv(e, { profile: 'hcm', period: P, items: [{ articleId: 'a_1111abcd1111', patch: { hacked: 1 } }], reviewer: 'B' })).status).toBe(400);
      expect((await read(e)).reviews['a_1111abcd1111'].included).toBe(false);
    });
    it('daily suggestions: the nightly job publishes (token), everyone reads, a reviewer dismisses for the team', async () => {
      const e = env();
      const pub = (items: unknown[], token = 'export-secret') => handle(new Request('https://w.example/suggestions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'hcm', generatedAt: '2026-11-17T16:35:00Z', basis: { votes: 3 }, items }) }), e);
      const read = async () => (await (await handle(new Request('https://w.example/suggestions?profile=hcm', { headers: { origin: ORIGIN } }), e)).json()) as { items: Array<{ id: string }>; generatedAt: string; dismissed: string[] };
      const items = [{ id: 'include:lối đi bộ', kind: 'include', phrase: 'lối đi bộ', fixes: 2 }, { id: 'exclude_title:giá vàng', kind: 'exclude_title', phrase: 'giá vàng', fixes: 3 }, { id: 'bad', kind: 'other', phrase: 'x' }];
      expect((await pub(items, 'wrong')).status).toBe(401);
      expect((await pub(items)).status).toBe(200);
      expect((await read()).items.map((i) => i.id)).toEqual(['include:lối đi bộ', 'exclude_title:giá vàng']); // invalid item dropped
      const dis = (id: string, code = ADMIN) => handle(new Request('https://w.example/suggestions/dismiss', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'hcm', id, reviewer: 'A' }) }), e);
      expect((await dis('exclude_title:giá vàng', 'wrong')).status).toBe(401);
      expect((await dis('../x')).status).toBe(400);
      expect((await dis('exclude_title:giá vàng')).status).toBe(200);
      expect((await read()).items.map((i) => i.id)).toEqual(['include:lối đi bộ']);
      // the next nightly publication keeps the team's dismissals
      await pub(items);
      const after = await read();
      expect(after.dismissed).toEqual(['exclude_title:giá vàng']);
      expect(after.items.map((i) => i.id)).toEqual(['include:lối đi bộ']);
      // sector / setting suggestions can be dismissed too (were refused with 400 until 19/11/2026)
      expect((await dis('sector:giảm tốc độ')).status).toBe(200);
      expect((await dis('setting:location.nationalToReady=false')).status).toBe(200);
      expect((await dis('other:x')).status).toBe(400);
    });
    it('judged stories for the impact preview: published by the nightly job (token), public read', async () => {
      const e = env();
      const pub = (token: string) => handle(new Request('https://w.example/golden', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'hcm', articles: [{ id: 'a_1', title: 'T' }], judged: { a_1: true } }) }), e);
      expect((await pub('wrong')).status).toBe(401);
      expect((await pub('export-secret')).status).toBe(200);
      const g = (await (await handle(new Request('https://w.example/golden?profile=hcm', { headers: { origin: ORIGIN } }), e)).json()) as { articles: unknown[]; judged: Record<string, boolean> };
      expect(g.articles).toHaveLength(1);
      expect(g.judged).toEqual({ a_1: true });
      expect(((await (await handle(new Request('https://w.example/golden?profile=ha-noi'), e)).json()) as { articles: unknown[] }).articles).toEqual([]);
    });
    it('saved runs removed by a reviewer: hidden for everyone (public read), restorable, reviewers only', async () => {
      const e = env();
      const hide = (body: unknown, code = ADMIN) => handle(new Request('https://w.example/runs/hide', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': code, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
      const list = async (pid = 'hcm') => ((await (await handle(new Request(`https://w.example/runs/hidden?profile=${pid}`, { headers: { origin: ORIGIN } }), e)).json()) as { hidden: Array<{ runId: string; by: string }> }).hidden;
      expect((await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: true, reviewer: 'A' }, 'wrong')).status).toBe(401);
      expect((await hide({ profile: 'hcm', runId: '../x', hidden: true, reviewer: 'A' })).status).toBe(400);
      expect((await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: 'yes', reviewer: 'A' })).status).toBe(400);
      expect((await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: true, reviewer: '' })).status).toBe(400);
      expect((await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: true, reviewer: 'Cường' })).status).toBe(200);
      await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: true, reviewer: 'Cường' }); // twice = once
      expect(await list()).toEqual([expect.objectContaining({ runId: 'run_live_custom1', by: 'Cường' })]);
      expect(await list('ha-noi')).toEqual([]);
      await hide({ profile: 'hcm', runId: 'run_live_custom1', hidden: false, reviewer: 'B' });
      expect(await list()).toEqual([]);
    });
    it('an unexpected error still answers with CORS headers (the page shows the reason, not "Failed to fetch")', async () => {
      const e = env();
      (e.REVIEWS as MemKV).get = async () => { throw new Error('KV get() limit exceeded for the day.'); };
      const r = await handle(new Request(`https://w.example/review?profile=hcm&period=${P}`, { headers: { origin: ORIGIN } }), e);
      expect(r.status).toBe(503);
      expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(((await r.json()) as { error: string }).error).toContain('hạn mức');
    });
    it('rejects unknown fields / bad values, bad ids, missing reviewer; null clears', async () => {
      const e = env();
      expect((await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { hacked: 1 }, reviewer: 'A' })).status).toBe(400);
      expect((await rv(e, { profile: 'hcm', period: '../x', articleId: 'a_1234abcd5678', patch: { included: true }, reviewer: 'A' })).status).toBe(400);
      expect((await rv(e, { profile: 'hcm', period: P, articleId: 'bad', patch: { included: true }, reviewer: 'A' })).status).toBe(400);
      expect((await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { included: true }, reviewer: ' ' })).status).toBe(400);
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { primaryCategory: 'NOPE', assessment: 'positive', primaryImageUrl: 'http://x/a.jpg', groupId: 'a_5555abcd1111' }, reviewer: 'A' });
      let d = (await read(e)).reviews['a_1234abcd5678'];
      expect(d.primaryCategory).toBeUndefined(); // invalid → ignored
      expect(d.primaryImageUrl).toBeUndefined(); // https only
      expect(d).toMatchObject({ assessment: 'positive', groupId: 'a_5555abcd1111' });
      await rv(e, { profile: 'hcm', period: P, articleId: 'a_1234abcd5678', patch: { groupId: null }, reviewer: 'A' });
      d = (await read(e)).reviews['a_1234abcd5678'];
      expect(d.groupId).toBeNull();
    });
  });

  describe('page proxy for "Dò nguồn / Thử nguồn" on the web', () => {
    const call = (e: Env, target: string, f: (u: string, init?: RequestInit) => Promise<Response>, code = ADMIN) =>
      handle(new Request(`https://w.example/fetch?url=${encodeURIComponent(target)}`, { headers: { origin: ORIGIN, 'x-review-code': code } }), e, f as never);
    it('reviewers only; returns the page as the collector expects; follows public redirects only', async () => {
      const e = env();
      const pages: Record<string, Response> = {
        'https://bao.vn/': new Response(null, { status: 301, headers: { location: '/trang-chu' } }),
        'https://bao.vn/trang-chu': new Response('<html><title>Báo</title></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
        'https://bao.vn/x': new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }),
        'https://bao.vn/img.jpg': new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } }),
      };
      const f = async (u: string) => pages[u] ?? new Response('', { status: 404 });
      expect((await call(e, 'https://bao.vn/', f, 'wrong')).status).toBe(401);
      const ok = (await (await call(e, 'https://bao.vn/', f)).json()) as { status: number; finalUrl: string; body: string; errorCode: string | null };
      expect(ok).toMatchObject({ status: 200, finalUrl: 'https://bao.vn/trang-chu', errorCode: null });
      expect(ok.body).toContain('<title>Báo</title>');
      expect(((await (await call(e, 'https://bao.vn/x', f)).json()) as { errorCode: string }).errorCode).toBe('SSRF_BLOCKED');
      expect(((await (await call(e, 'https://bao.vn/img.jpg', f)).json()) as { errorCode: string }).errorCode).toBe('NOT_TEXT');
      expect(((await (await call(e, 'https://bao.vn/none', f)).json()) as { status: number; errorCode: string })).toMatchObject({ status: 404, errorCode: 'FETCH_404' });
      for (const bad of ['http://127.0.0.1/', 'http://localhost/', 'file:///etc/passwd', 'https://10.0.0.5/', 'https://bao.vn:8080/', 'https://[::1]/']) {
        expect((await call(e, bad, f)).status).toBe(400);
      }
    });
  });

  it('reviewer ids are ascii slugs', () => {
    expect(reviewerId('  Lê Đình Ánh ')).toBe('le-dinh-anh');
  });
});

describe('self-learned model store (nightly publish, public read)', () => {
  it('only the nightly job (token) publishes; anyone reads; bad shapes are refused', async () => {
    const e = env();
    const pub = (body: unknown, token = 'export-secret') => handle(new Request('https://w.example/model', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
    const read = async () => (await handle(new Request('https://w.example/model?profile=hcm', { headers: { origin: ORIGIN } }), e)).json();
    expect(await read()).toBeNull();
    const model = { v: 1, trainedAt: '2026-11-18T16:30:00Z', n: { relevant: 2, irrelevant: 3 }, prior: -0.3, w: { 'giải phóng': 1.2 }, accuracy: null };
    expect((await pub({ profile: 'hcm', model }, 'wrong')).status).toBe(401);
    expect((await pub({ profile: 'hcm', model: { v: 2 } })).status).toBe(400);
    expect((await pub({ profile: 'hcm', model })).status).toBe(200);
    expect(await read()).toMatchObject({ v: 1, prior: -0.3, w: { 'giải phóng': 1.2 } });
  });
});

describe('saved runs: archive (listed in "Lưu trữ") vs delete (final), 18/11/2026', () => {
  it('archive / unarchive; a deleted run stays deleted when someone archives it', async () => {
    const e = env();
    const hide = (body: Record<string, unknown>) => handle(new Request('https://w.example/runs/hide', { method: 'POST', headers: { origin: ORIGIN, 'x-review-code': ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'hcm', reviewer: 'A', ...body }) }), e);
    const list = async () => ((await (await handle(new Request('https://w.example/runs/hidden?profile=hcm', { headers: { origin: ORIGIN } }), e)).json()) as { hidden: Array<{ runId: string; archived?: boolean }> }).hidden;
    expect((await hide({ runId: 'run_live_20261117', archived: true })).status).toBe(200);
    expect(await list()).toEqual([expect.objectContaining({ runId: 'run_live_20261117', archived: true })]);
    await hide({ runId: 'run_live_20261117', archived: false });
    expect(await list()).toEqual([]);
    await hide({ runId: 'run_live_20261116', hidden: true });
    await hide({ runId: 'run_live_20261116', archived: true });
    expect(await list()).toEqual([expect.objectContaining({ runId: 'run_live_20261116' })]);
    expect((await list())[0]!.archived).toBeUndefined();
  });
});
