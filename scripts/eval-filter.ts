/**
 * Replay the relevance filter on published articles and score it against the team's ✓/✗ labels (labels/labels.json):
 *   precision = labelled-relevant share of the stories put in "Bài sẵn sàng"
 *   recall    = labelled-relevant stories that are kept (ready or "Cần kiểm tra"), not excluded
 * Compares the shared web configuration (as saved) with the same configuration after the schema's one-time upgrades
 * (new default keywords etc.). Usage: npx tsx scripts/eval-filter.ts [--review-api <worker url>] [--profile hcm]
 */
import { readFileSync } from 'node:fs';
import { SettingsSchema, type Article, type Settings } from '../src/domain/schemas.js';
import { annotateArticle } from '../src/domain/relevance.js';

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const SITE = arg('--site', 'https://tinbaochi.github.io/');
const PROFILE = arg('--profile', 'hcm');
const API = arg('--review-api', process.env.REVIEW_API_URL ?? '');

interface L { articleId: string; title: string; label: 'relevant' | 'irrelevant' | null }
const labels = (JSON.parse(readFileSync('labels/labels.json', 'utf8')) as { labels: L[] }).labels;
const votes = new Map<string, { yes: number; no: number; title: string }>();
for (const l of labels) {
  if (!l.label) continue;
  const v = votes.get(l.articleId) ?? { yes: 0, no: 0, title: l.title };
  if (l.label === 'relevant') v.yes++;
  else v.no++;
  votes.set(l.articleId, v);
}
const truth = new Map([...votes].filter(([, v]) => v.yes !== v.no).map(([id, v]) => [id, { rel: v.yes > v.no, title: v.title }]));

const index = (await (await fetch(new URL(`live/${PROFILE}/index.json`, SITE))).json()) as { days: Array<{ file?: string; reportDate: string }> };
const arts = new Map<string, any>();
for (const d of index.days) {
  const r = await fetch(new URL(`live/${PROFILE}/${d.file ?? `${d.reportDate}.json`}`, SITE));
  if (!r.ok) continue;
  for (const a of ((await r.json()) as { articles: any[] }).articles) arts.set(a.id, a);
}
const raw = API ? ((await (await fetch(`${API}/config?profile=${PROFILE}`)).json()) as { config: { settings: Record<string, unknown> } }).config.settings : {};

function score(name: string, s: Settings) {
  let tp = 0, fp = 0, kept = 0, rel = 0, dropped: string[] = [], wrongReady: string[] = [];
  let ready = 0, review = 0, out = 0;
  for (const a of arts.values()) {
    const art = { ...a, bodyText: (a.contentSections ?? []).filter((x: any) => x.type === 'paragraph' || x.type === 'heading').map((x: any) => x.text).join('\n'), imageCandidates: [] } as unknown as Article;
    const an = annotateArticle(art, s);
    const st = an.relevance.status;
    const nat = an.relevance.evidence.find((e) => e.startsWith('Tin chung') || e.startsWith('Chính sách / tin toàn ngành, không gắn'));
    if (nat && process.argv.includes('--national')) console.log(`   [${truth.get(a.id) ? (truth.get(a.id)!.rel ? 'ĐÚNG' : 'SAI ') : '  ? '}] ${a.title}  ← ${nat}`);
    if (st === 'relevant') ready++;
    else if (st === 'review') review++;
    else out++;
    const t = truth.get(a.id);
    if (!t) continue;
    if (st === 'relevant') (t.rel ? tp++ : (fp++, wrongReady.push(a.title)));
    if (t.rel) {
      rel++;
      if (st !== 'irrelevant') kept++;
      else dropped.push(a.title);
    }
  }
  console.log(`\n== ${name}: ${arts.size} bài · sẵn sàng ${ready} · cần kiểm tra ${review} · loại ${out}`);
  console.log(`   độ chính xác "Sẵn sàng": ${tp}/${tp + fp} = ${tp + fp ? Math.round((100 * tp) / (tp + fp)) : '-'}%   ·   không bỏ sót: ${kept}/${rel} = ${rel ? Math.round((100 * kept) / rel) : '-'}%`);
  if (wrongReady.length) console.log('   lạc đề trong Sẵn sàng:\n' + wrongReady.map((x) => `     - ${x}`).join('\n'));
  if (dropped.length) console.log('   liên quan nhưng bị loại:\n' + dropped.map((x) => `     - ${x}`).join('\n'));
}
console.log(`nhãn có kết luận (đa số): ${truth.size} bài, trong đó liên quan ${[...truth.values()].filter((t) => t.rel).length}`);
score('Cấu hình web hiện tại (sau nâng cấp mặc định của phiên bản này)', SettingsSchema.parse(raw));
