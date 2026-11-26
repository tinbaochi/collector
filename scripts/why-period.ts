/**
 * Why did the filter put each story the team acted on (moved to "Sẵn sàng", removed, "✗ Không") where it did?
 * Replays the current shared configuration on one published period. Usage:
 *   npx tsx scripts/why-period.ts --review-api <worker url> --key custom-202611171700-202611180801 [--profile hcm]
 */
import { SettingsSchema, type Article } from '../src/domain/schemas.js';
import { annotateArticle } from '../src/domain/relevance.js';
import { classifyCategory } from '../src/domain/classify.js';

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const SITE = arg('--site', 'https://tinbaochi.github.io/');
const PROFILE = arg('--profile', 'hcm');
const API = arg('--review-api', process.env.REVIEW_API_URL ?? '');
const KEY = arg('--key', '');

const period = (await (await fetch(new URL(`live/${PROFILE}/${KEY}.json?t=${Date.now()}`, SITE))).json()) as { articles: any[] };
const reviews = ((await (await fetch(`${API}/review?profile=${PROFILE}&period=run_live_${KEY.replace(/[^0-9a-z]/gi, '')}`)).json()) as { reviews: Record<string, any> }).reviews;
const raw = ((await (await fetch(`${API}/config?profile=${PROFILE}`)).json()) as { config: { settings: Record<string, unknown> } }).config.settings;
const s = SettingsSchema.parse(raw);
const label = (v: any) => (v.promotedToReady ? 'LÊN SẴN SÀNG' : v.relevanceLabel === 'relevant' ? '✓' : v.excludedByEditor || v.excludeReason ? `LOẠI ${v.excludeReason ?? ''}` : JSON.stringify(v));
for (const a of period.articles) {
  const v = reviews[a.id];
  if (!v) continue;
  const art = { ...a, bodyText: (a.contentSections ?? []).filter((x: any) => x.type === 'paragraph' || x.type === 'heading').map((x: any) => x.text).join('\n'), imageCandidates: [] } as unknown as Article;
  const r = annotateArticle(art, s);
  const best = (x: { scores: Record<string, number | undefined> }) => Math.max(0, ...Object.values(x.scores).map((y) => y ?? 0));
  const tc = classifyCategory(a.title, '', s.categories);
  console.log(`\n[${label(v)}] tiêu đề=${best(tc)}${JSON.stringify(tc.scores)} · ${(r as any)._verdict.reasonCode} · máy: ${r.relevance.status} · ${r.location?.status} · ${a.sourceName}\n  ${a.title}`);
  for (const e of [...(r.location?.evidence ?? []).slice(0, 2), ...r.relevance.evidence.slice(-3)]) console.log('   - ' + String(e).slice(0, 200));
}
