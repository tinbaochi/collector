/**
 * Daily (after the nightly label pull): filter suggestions per profile, learned from the team's review, published to the
 * review worker for Cài đặt › Gợi ý cải thiện. Ground truth: majority ✓/✗ votes (labels/labels.json), else the shared
 * review decision of the period (chosen / moved to Sẵn sàng = relevant, "Loại" = not relevant).
 * Usage: npx tsx scripts/suggest-filter.ts [--dry-run] [--site …]   Env: REVIEW_API_URL, EXPORT_TOKEN (to publish)
 */
import { existsSync, readFileSync } from 'node:fs';
import { SettingsSchema, type Article } from '../src/domain/schemas.js';
import { suggestFilter, statusOf, type Judged } from '../src/domain/suggest.js';
import { scoreStory, trainModel } from '../src/domain/learn.js';

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const SITE = arg('--site', 'https://tinbaochi.github.io/');
const DRY = process.argv.includes('--dry-run');
const API = (process.env.REVIEW_API_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.EXPORT_TOKEN ?? '';
if (!API) {
  console.log('REVIEW_API_URL not configured – nothing to do');
  process.exit(0);
}
const get = async <T>(u: string): Promise<T | null> => {
  const r = await fetch(u, { cache: 'no-store' }).catch(() => null);
  return r?.ok ? ((await r.json()) as T) : null;
};

interface L { articleId: string; label: 'relevant' | 'irrelevant' | null; category: string | null }
const labels = existsSync('labels/labels.json') ? (JSON.parse(readFileSync('labels/labels.json', 'utf8')) as { labels: L[] }).labels : [];
const votes = new Map<string, { yes: number; no: number; cats: string[] }>();
for (const l of labels) {
  const v = votes.get(l.articleId) ?? { yes: 0, no: 0, cats: [] };
  if (l.label === 'relevant') v.yes++;
  if (l.label === 'irrelevant') v.no++;
  if (l.category) v.cats.push(l.category);
  votes.set(l.articleId, v);
}

const profiles = (await get<{ profiles: Array<{ id: string; name: string }> }>(`${API}/profiles`))?.profiles ?? [{ id: 'hcm', name: 'TP.HCM' }];
for (const prof of profiles) {
  const cfg = await get<{ config: { settings: unknown } | null }>(`${API}/config?profile=${prof.id}`);
  if (!cfg?.config) {
    console.log(`[${prof.id}] no shared configuration – skipped`);
    continue;
  }
  const settings = SettingsSchema.parse(cfg.config.settings);
  const index = await get<{ days: Array<{ key?: string; file?: string; reportDate: string }> }>(new URL(`live/${prof.id}/index.json`, SITE).href);
  if (!index) continue;
  const articles = new Map<string, Article>();
  const judged = new Map<string, Judged>();
  let decisions = 0;
  for (const d of index.days) {
    const day = await get<{ articles: any[] }>(new URL(`live/${prof.id}/${d.file ?? `${d.reportDate}.json`}`, SITE).href);
    for (const a of day?.articles ?? []) {
      const body = (a.contentSections ?? []).filter((x: any) => x.type === 'paragraph' || x.type === 'heading').map((x: any) => x.text).join('\n');
      articles.set(a.id, { ...a, bodyText: body, imageCandidates: [] } as Article);
    }
    // the team's decisions of this period (same id as the web: run_live_<key>)
    const period = `run_live_${(d.key ?? d.reportDate).replace(/[^0-9a-z]/gi, '')}`;
    const rv = await get<{ reviews: Record<string, { included?: boolean; promotedToReady?: boolean; excludedByEditor?: boolean; excludeReason?: string | null; groupId?: string | null }> }>(`${API}/review?profile=${prof.id}&period=${period}`);
    for (const [id, r] of Object.entries(rv?.reviews ?? {})) {
      if (judged.has(id)) continue;
      if (r.excludedByEditor) {
        // a duplicate or a minor story is still on topic: only off-topic / other area teach the filter
        if (r.excludeReason !== 'duplicate' && r.excludeReason !== 'minor') (judged.set(id, { relevant: false, why: 'decision' }), decisions++);
      }
      else if (r.included || r.promotedToReady || r.groupId) (judged.set(id, { relevant: true, why: 'decision' }), decisions++);
    }
  }
  // labels win over decisions
  let voted = 0;
  for (const [id, v] of votes) {
    if (!articles.has(id) || v.yes === v.no) continue;
    const cat = v.cats.sort((a, b) => v.cats.filter((x) => x === b).length - v.cats.filter((x) => x === a).length)[0] ?? null;
    judged.set(id, { relevant: v.yes > v.no, why: 'label', category: cat });
    voted++;
  }
  // the self-learned second opinion (src/domain/learn.ts), used by Hỏi nhanh to ask where it disagrees with the rules
  const model = trainModel([...judged].filter(([id]) => articles.has(id)).map(([id, j]) => ({ article: articles.get(id)!, relevant: j.relevant })));
  console.log(`[${prof.id}] learned model: ${model.n.relevant} relevant / ${model.n.irrelevant} not, ${Object.keys(model.w).length} features, cross-validated accuracy ${model.accuracy === null ? '-' : Math.round(model.accuracy * 100) + '%'}, ${(JSON.stringify(model).length / 1024).toFixed(0)} KB`);
  if (process.argv.includes('--disagree')) {
    for (const a of articles.values()) {
      if (judged.has(a.id)) continue;
      const p = scoreStory(model, a), st = statusOf(a, settings);
      if ((st === 'irrelevant' && p >= 0.8) || (st === 'relevant' && p <= 0.2)) console.log(`   ${st.padEnd(10)} p=${p.toFixed(2)}  ${a.title}`);
    }
  }
  const prev = await get<{ dismissed?: string[] }>(`${API}/suggestions?profile=${prof.id}`);
  const t0 = Date.now();
  const items = suggestFilter([...articles.values()], judged, settings, { dismissed: prev?.dismissed ?? [] });
  console.log(`[${prof.id}] ${articles.size} stories, ${voted} judged by votes + ${decisions} by decisions → ${items.length} suggestions (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const x of items) console.log(`  ${x.kind === 'include' ? '+' : '−'} "${x.phrase}"${x.category ? ` [${x.category}]` : ''} fixes ${x.fixes}, side ${x.sideEffects} · ${x.examples[0]}`);
  if (DRY) continue;
  if (!TOKEN) {
    console.log('EXPORT_TOKEN not configured – not published');
    continue;
  }
  const body = { profile: prof.id, generatedAt: new Date().toISOString(), basis: { stories: articles.size, votes: voted, decisions }, items };
  const r = await fetch(`${API}/suggestions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  console.log(`[${prof.id}] published: HTTP ${r.status}`);
  // the judged stories, for the impact preview when settings are edited (only what the filter reads)
  const gold = [...judged.keys()].map((id) => articles.get(id)).filter((a): a is Article => !!a)
    .map((a) => ({ id: a.id, sourceId: a.sourceId, sourceName: a.sourceName, title: a.title, sapo: a.sapo, bodyText: (a.bodyText ?? '').slice(0, 8000) }));
  const g = await fetch(`${API}/golden`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: prof.id, generatedAt: new Date().toISOString(), articles: gold, judged: Object.fromEntries([...judged].filter(([id]) => articles.has(id)).map(([id, j]) => [id, j.relevant])) }),
  });
  console.log(`[${prof.id}] judged stories for the impact preview: ${gold.length} (HTTP ${g.status})`);
  const mr = await fetch(`${API}/model`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ profile: prof.id, model }) });
  console.log(`[${prof.id}] learned model published: HTTP ${mr.status}`);
}
