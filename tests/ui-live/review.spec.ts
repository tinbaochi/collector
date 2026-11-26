import { existsSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import JSZip from 'jszip';

/** Two reviewers label the same published (fixture) articles through the shared review store. */
/** the window fields are date + 24-hour selects (not datetime-local): set "YYYY-MM-DDTHH:mm" */
async function setWindowField(p: Page, label: string, v: string) {
  const [d, hm] = v.split('T');
  const [h, m] = hm!.split(':');
  await p.getByLabel(`${label} – ngày`).fill(d!);
  await p.getByLabel(`${label} – giờ`).selectOption(h!);
  await p.getByLabel(`${label} – phút`).selectOption(m!);
}

const FLOOD = /Liên quan: \[Mẫu thử\] Mưa lớn tối 8\.11 khiến/;
const METRO_NO = /^Không liên quan: \[Mẫu thử\] Khánh thành nhà ga metro/;

/** accounts seeded by the fake worker: "Người duyệt X" = duyet-x / test-pass */
const userOf = (name: string) => 'duyet-' + name.slice(-1).toLowerCase();
/** session token of a test account, for direct calls to the fake worker (no shared access code any more) */
async function tokenOf(request: APIRequestContext, name: string) {
  const r = await request.post('http://127.0.0.1:5181/login', { data: { username: userOf(name), password: 'test-pass' } });
  return ((await r.json()) as { token: string }).token;
}
async function login(page: Page, name: string, _code?: string) {
  await page.getByRole('button', { name: 'Đăng nhập duyệt tin' }).click();
  await page.getByLabel('Tên đăng nhập').fill(userOf(name));
  await page.getByLabel('Mật khẩu').fill('test-pass');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
}

test('shared review: login gate, votes from two reviewers, team quality, export', async ({ browser, request }) => {
  const a = await (await browser.newContext()).newPage();
  await a.goto('');
  await expect(a.getByTestId('live-banner')).toBeVisible();
  // labelling without a session opens the login dialog
  await a.getByRole('button', { name: FLOOD }).click();
  await expect(a.getByRole('dialog', { name: 'Đăng nhập' })).toBeVisible();
  await a.getByLabel('Tên đăng nhập').fill('duyet-a');
  await a.getByLabel('Mật khẩu').fill('sai-mat-khau');
  await a.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(a.getByText('Sai tên đăng nhập hoặc mật khẩu')).toBeVisible();
  await a.getByLabel('Mật khẩu').fill('test-pass');
  await a.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(a.getByTestId('reviewer-chip')).toContainText('Người duyệt A');
  await a.getByRole('button', { name: FLOOD }).click();
  await a.getByRole('button', { name: METRO_NO }).click();
  await expect(a.getByText(/Nhóm duyệt: ✓1 ✗0/).first()).toBeVisible();

  // second reviewer in a separate browser sees A's vote and adds their own
  const b = await (await browser.newContext()).newPage();
  await b.goto('');
  await login(b, 'Người duyệt B');
  await expect(b.getByText(/Nhóm duyệt: ✓1 ✗0/).first()).toBeVisible();
  await b.getByRole('button', { name: FLOOD }).click();
  await expect(b.getByText(/Nhóm duyệt: ✓2 ✗0/).first()).toBeVisible();
  // team quality card uses the majority vote
  await b.getByTestId('open-coverage').click();
  await expect(b.getByTestId('quality-card')).toContainText('Độ chính xác tab Sẵn sàng: 50%');
  await b.screenshot({ path: 'docs/screenshots/shared-review.png', fullPage: false });

  // nightly export (what the GitHub Action pulls) contains both reviewers' labels
  const ex = await (await request.get('http://127.0.0.1:5181/export', { headers: { authorization: 'Bearer test-export-token' } })).json();
  expect(ex.count).toBe(3);
  expect(new Set(ex.labels.map((l: { reviewerId: string }) => l.reviewerId))).toEqual(new Set(['nguoi-duyet-a', 'nguoi-duyet-b']));
});

test('automatic collection at 08:00 / 16:30 (ticked per profile) + busy server is visible and blocks "Thu thập"', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('');
  const strip = page.getByTestId('server-status');
  const morning = strip.getByLabel('Tự động lúc 08:00');
  const afternoon = strip.getByLabel('Tự động lúc 16:30');
  await expect(morning).not.toBeChecked();
  await expect(afternoon).not.toBeChecked();
  // switches show only the time; the window is explained on hover
  await expect(strip.locator('label[title^="08:00"]')).toHaveAttribute('title', /17:00 hôm qua → 08:00 hôm nay \(gồm phút 08:00\)/);
  await expect(strip.locator('label[title^="16:30"]')).toHaveAttribute('title', /08:01 → 16:30 hôm nay/);
  await expect(page.getByTestId('server-idle')).toBeVisible();
  await expect(page.getByTestId('live-banner')).toContainText('tự động thu thập đang TẮT');
  // ticking needs a reviewer session
  await morning.click();
  await expect(page.getByRole('dialog', { name: 'Đăng nhập' })).toBeVisible();
  await expect(morning).not.toBeChecked();
  await page.getByLabel('Tên đăng nhập').fill('duyet-d');
  await page.getByLabel('Mật khẩu').fill('test-pass');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await morning.click(); // saved on the worker, then reflected
  await expect(morning).toBeChecked();
  await afternoon.click();
  await expect(afternoon).toBeChecked();
  await expect(page.getByTestId('auto-info')).toContainText('Tiếp:');
  await expect(page.getByTestId('auto-info')).not.toContainText('đổi lúc'); // no technical history on the product page
  await expect(page.getByTestId('live-banner')).toContainText('tự động thu thập lúc 08:00, 16:30');
  // the worker cron at 08:02 collects 17:00 yesterday → 08:00 today for this profile
  const fired = await (await request.get('http://127.0.0.1:5181/__cron')).json();
  expect(fired).toMatchObject({ result: 'dispatched', slot: '08:00', profiles: ['hcm'] });
  await page.reload();
  await expect(page.getByTestId('server-busy')).toContainText('lượt tự động theo lịch');
  await expect(page.getByRole('button', { name: 'Thu thập' })).toBeDisabled();
  await expect(page.getByTestId('server-idle')).toBeVisible({ timeout: 40_000 });
  // untick: no automatic run any more
  await afternoon.click();
  await expect(afternoon).not.toBeChecked();
  await morning.click();
  await expect(morning).not.toBeChecked();
  await expect(page.getByTestId('live-banner')).toContainText('tự động thu thập đang TẮT');
  // another run (e.g. a deploy after a push) occupies the server: shown to everyone, Thu thập disabled with the reason
  await request.get('http://127.0.0.1:5181/__deploy');
  await page.reload();
  await expect(page.getByTestId('server-busy')).toContainText('Máy chủ đang chạy: cập nhật phần mềm & dữ liệu');
  await expect(page.getByRole('button', { name: 'Thu thập' })).toBeDisabled();
  await page.screenshot({ path: 'docs/screenshots/web-server-busy.png' });
  await expect(page.getByTestId('server-idle')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Thu thập' })).toBeEnabled();
});

test('automatic times are changed in Settings (not fixed at 08:00 / 16:30), shown on the strip, back to defaults', async ({ page, request }) => {
  await page.goto('');
  await login(page, 'Người duyệt G');
  const strip = page.getByTestId('server-status');
  await strip.getByTestId('edit-times').click();
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  const box = dlg.getByTestId('schedule-times');
  // 24-hour hour / minute selects on every computer
  const setT = async (l: string, v: string) => {
    await box.getByLabel(`${l} – giờ`, { exact: true }).selectOption(v.slice(0, 2));
    await box.getByLabel(`${l} – phút`, { exact: true }).selectOption(v.slice(3));
  };
  await expect(box.getByRole('group', { name: 'Lượt 1 – giờ chạy', exact: true })).toHaveAttribute('data-value', '08:00');
  await setT('Lượt 1 – giờ chạy', '07:30');
  await expect(box.getByRole('group', { name: 'Lượt 1 – đến', exact: true })).toHaveAttribute('data-value', '07:30'); // "Đến" follows the run time
  await setT('Lượt 1 – từ', '17:30');
  await setT('Lượt 2 – giờ chạy', '17:00');
  await setT('Lượt 2 – từ', '07:31');
  await setT('Lượt 2 – đến', '16:45'); // changed by hand
  await expect(box).toContainText('kỳ 17:30 hôm qua → 07:30 hôm nay');
  await expect(box).toContainText('kỳ 07:31 → 16:45 hôm nay (gồm phút 16:45)');
  await setT('Lượt 2 – đến', '17:30');
  await expect(dlg.getByText(/"Đến" không được muộn hơn giờ chạy/)).toBeVisible();
  await setT('Lượt 2 – đến', '16:45');
  // invalid: same run time → save disabled with the reason
  await setT('Lượt 1 – giờ chạy', '17:00'); // its "Đến" follows (still untouched)
  await expect(dlg.getByText('Hai lượt không được trùng giờ chạy')).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Lưu giờ' })).toBeDisabled();
  await setT('Lượt 1 – giờ chạy', '07:30');
  await expect(box.getByRole('group', { name: 'Lượt 1 – đến', exact: true })).toHaveAttribute('data-value', '07:30');
  await dlg.getByRole('button', { name: 'Lưu giờ' }).click();
  await expect(page.getByText(/Đã lưu giờ thu thập tự động/)).toBeVisible();
  const st = await (await request.get('http://127.0.0.1:5181/status')).json();
  expect(st.profiles.find((p: { id: string }) => p.id === 'hcm').scheduleTimes).toEqual({ morning: { at: '07:30', from: '17:30' }, afternoon: { at: '17:00', from: '07:31', to: '16:45' } });
  await page.screenshot({ path: 'docs/screenshots/web-schedule-times.png' });
  // phone: the three time fields fit inside each card
  await page.setViewportSize({ width: 390, height: 844 });
  for (const b of await box.locator('select').all()) {
    const r = (await b.boundingBox())!;
    const card = (await box.boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(card.x + card.width + 1);
  }
  await box.scrollIntoViewIfNeeded();
  await box.screenshot({ path: 'docs/screenshots/web-schedule-times-phone.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await expect(strip.getByLabel('Tự động lúc 07:30')).toBeVisible();
  await expect(strip.getByLabel('Tự động lúc 17:00')).toBeVisible();
  await strip.screenshot({ path: 'docs/screenshots/web-edit-times-button.png' });
  // back to the defaults
  await strip.getByTestId('edit-times').click();
  await dlg.getByRole('button', { name: 'Về mặc định' }).click();
  await expect(page.getByText(/Đã lưu giờ thu thập tự động/).first()).toBeVisible();
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await expect(strip.getByLabel('Tự động lúc 08:00')).toBeVisible();
  await expect(strip.getByLabel('Tự động lúc 16:30')).toBeVisible();
});

test('web "Thu thập" like the local app: choose from/to → server collection → progress → new period opens', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('');
  // same window controls as the local app
  await page.getByRole('button', { name: 'Tùy chỉnh' }).click();
  await setWindowField(page, 'Từ', '2026-11-08T18:00');
  await setWindowField(page, 'Đến', '2026-11-09T07:00');
  await expect(page.getByTestId('window-range')).toHaveText('18:00 08/11 → 07:00 09/11/2026');
  // collecting requires a reviewer session
  await page.getByRole('button', { name: 'Thu thập' }).click();
  await expect(page.getByRole('dialog', { name: 'Đăng nhập' })).toBeVisible();
  await page.getByLabel('Tên đăng nhập').fill('duyet-c');
  await page.getByLabel('Mật khẩu').fill('test-pass');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByTestId('reviewer-chip')).toBeVisible();
  await page.getByRole('button', { name: 'Thu thập' }).click();
  await expect(page.getByTestId('remote-collect')).toContainText('Đang thu thập trên máy chủ:');
  await expect(page.locator('body')).not.toContainText(/GitHub|Claude/); // product wording only
  await expect(page.getByRole('button', { name: 'Thu thập' })).toBeDisabled(); // one collection at a time
  await page.screenshot({ path: 'docs/screenshots/web-collect-progress.png' });
  // the page polls the workflow and opens the new period when it is published
  await expect(page.getByText(/Đã thu thập xong 18:00 08\/11\/2026 → 07:00 09\/11\/2026/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('remote-collect')).toHaveCount(0);
  // the new period is opened: compact label + who asked for it
  await expect(page.getByTestId('run-picker')).toContainText('08/11 18:00 → 09/11/2026 07:00');
  await expect(page.getByTestId('run-picker')).toContainText('Người duyệt C');
});

/** The Department's template is private (reference/ is git-ignored): the template part runs only where it exists. */
const TEMPLATE = 'reference/hcm-news-reporter-skill/assets/reference-report.pptx';

test('web = local: photos, full article text, shared settings used by the server, export with the original template', async ({ page, request }) => {
  test.setTimeout(120_000);
  const png = await (await request.get('http://127.0.0.1:5181/__png')).body();
  // publisher photo links load straight from the publisher in the browser (fixture domains are served here)
  await page.route(/^https:\/\/fixture-[a-z]\.example\.vn\/img\//, (r) => r.fulfill({ body: png, contentType: 'image/png' }).catch(() => {})); // a photo may still be loading when the page navigates
  await page.goto('');
  const card = page.locator('article').filter({ hasText: 'khiến nhiều tuyến đường ở phường Hiệp Bình' }).first();
  const thumb = card.locator('img').first();
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1200);

  // full text in "Xem chi tiết", like the local app
  await card.getByRole('button', { name: 'Xem chi tiết' }).click();
  await expect(page.getByText('Nhiều điểm ngập kéo dài')).toBeVisible();
  await expect(page.getByText('Lượng mưa theo trạm')).toBeVisible();
  await expect(page.getByText(/Kỳ này được đăng trước khi web có toàn văn/)).toHaveCount(0);
  await page.screenshot({ path: 'docs/screenshots/web-full-text.png' });
  await page.keyboard.press('Escape');
  await page.goto('');

  // settings are SHARED: saved through the worker, which the server collector reads (scripts/cloud-collect.ts)
  await login(page, 'Người duyệt E');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(dlg.getByTestId('shared-config-note')).toBeVisible();
  await dlg.getByRole('button', { name: 'Báo cáo & mẫu', exact: true }).click();
  await dlg.getByLabel('Tên cơ quan trên bìa').fill('SỞ XÂY DỰNG TP.HCM (thử web)');
  if (existsSync(TEMPLATE)) {
    await dlg.locator('input[type=file][accept=".pptx"]').setInputFiles(TEMPLATE);
    await expect(page.getByText(/Đã lưu bản sao mẫu/)).toBeVisible();
  }
  await dlg.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu cài đặt')).toBeVisible();
  const cfg = (await (await request.get('http://127.0.0.1:5181/config')).json()).config;
  expect(cfg.by).toBe('Người duyệt E');
  expect(cfg.settings.report.organization).toBe('SỞ XÂY DỰNG TP.HCM (thử web)');
  expect(cfg.settings.report.templateFile).toBe(''); // the template never leaves this browser
  expect(cfg.sources.length).toBeGreaterThan(0);
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();

  // export: selected story with the real photo, through the worker's image proxy
  await page.getByLabel(/Chọn bài \[Mẫu thử\] Mưa lớn tối 8.11 khiến/).check();
  await page.getByRole('button', { name: /Xuất báo cáo \(1\)/ }).click();
  // capture the generated file in the page (a real browser download makes Playwright+Edge throw at teardown)
  await page.evaluate(() => {
    // one export now downloads the .pptx AND the .docx: __dl = the PowerPoint, __docx = the Word file
    const w = window as unknown as { __dl?: { name: string; b64: string }; __docx?: { name: string; b64: string }; __pdf?: { name: string; b64: string } };
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const name = this.download;
      void fetch(this.href).then((r) => r.arrayBuffer()).then((buf) => {
        let s = '';
        const u = new Uint8Array(buf);
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        if (name.endsWith('.docx')) w.__docx = { name, b64: btoa(s) };
        else if (name.endsWith('.pdf')) w.__pdf = { name, b64: btoa(s) };
        else w.__dl = { name, b64: btoa(s) };
      });
    };
  });
  await page.getByRole('button', { name: 'Xuất báo cáo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __dl?: unknown }).__dl), { timeout: 30_000 }).toBe(true);
  const out = await page.evaluate(() => (window as unknown as { __dl: { name: string; b64: string } }).__dl);
  const file = { suggestedFilename: () => out.name };
  const zip = await JSZip.loadAsync(Buffer.from(out.b64, 'base64'));
  const media = Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/'));
  const slidesXml = (await Promise.all(Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')))).join('');
  expect(slidesXml).toContain('Mưa lớn tối 8.11');
  // default template = the Department's template from the Skill (published with the site), with the real photo
  await expect(page.getByTestId('template-picker').locator('input[value="skill-so-xay-dung"]')).toBeChecked();
  for (const id of ['skill-so-xay-dung', 'hanh-chinh', 'ban-tin', 'toi-gian', 'anh-lon']) await expect(page.getByTestId('template-picker').locator(`input[value="${id}"]`)).toBeVisible(); // Skill template + 4 original designs, all visible
  expect(file.suggestedFilename()).not.toContain('DEMO');
  expect(slidesXml).not.toContain('BẢN DEMO');
  const hasPhoto = async (z: JSZip) => {
    for (const f of Object.keys(z.files).filter((x) => x.startsWith('ppt/media/') && !z.files[x]!.dir)) if ((await z.file(f)!.async('uint8array')).length === png.length) return true;
    return false;
  };
  expect(media.length).toBeGreaterThan(0);
  expect(await hasPhoto(zip)).toBe(true);
  // Word, ticked by default: the Department's .docx template with the same story
  await expect(page.getByRole('checkbox', { name: '.docx' })).toBeChecked();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __docx?: unknown }).__docx), { timeout: 30_000 }).toBe(true);
  const word = await page.evaluate(() => (window as unknown as { __docx: { name: string; b64: string } }).__docx);
  expect(word.name).toBe(out.name.replace(/\.pptx$/, '.docx')); // same file name as the PowerPoint
  await expect(page.getByRole('checkbox', { name: '.pptx' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '.pdf' })).not.toBeChecked();
  const wordXml = await (await JSZip.loadAsync(Buffer.from(word.b64, 'base64'))).file('word/document.xml')!.async('string');
  expect(wordXml).toContain('Mưa lớn tối 8.11');
  expect(wordXml).toContain('TIN CẦN NGHIÊN CỨU, XỬ LÝ');
  expect(wordXml).not.toContain('SÁNG');
  await page.screenshot({ path: 'docs/screenshots/web-export-template.png' });

  // another template, chosen at export: one of the app's original designs
  await page.getByTestId('template-picker').locator('input[value="ban-tin"]').check();
  await expect(page.getByTestId('template-info')).toContainText('16:9');
  await page.evaluate(() => delete (window as unknown as { __dl?: unknown }).__dl);
  // + the app's own PDF, built in the browser (no Office)
  await page.getByRole('checkbox', { name: '.pdf' }).check();
  await page.getByRole('button', { name: 'Xuất báo cáo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __dl?: unknown }).__dl), { timeout: 30_000 }).toBe(true);
  const out2 = await page.evaluate(() => (window as unknown as { __dl: { name: string; b64: string } }).__dl);
  expect(out2.name).toBe(out.name); // the design is not appended to the name: .pptx / .docx / .pdf share one name
  const zip2 = await JSZip.loadAsync(Buffer.from(out2.b64, 'base64'));
  const sz = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(await zip2.file('ppt/presentation.xml')!.async('string'))!;
  expect(Number(sz[1]) / Number(sz[2])).toBeCloseTo(16 / 9, 1); // landscape 16:9 = "Bản tin hiện đại"
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __pdf?: unknown }).__pdf), { timeout: 30_000 }).toBe(true);
  const pdf = await page.evaluate(() => (window as unknown as { __pdf: { name: string; b64: string } }).__pdf);
  expect(pdf.name).toBe(out.name.replace(/\.pptx$/, '.pdf'));
  const pdfBytes = Buffer.from(pdf.b64, 'base64');
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdfBytes.toString('latin1')).toContain('/Subtype /Image'); // the real photo is in the PDF
  expect(await hasPhoto(zip2)).toBe(true);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
test('web profiles: create Đà Nẵng (stored by the worker), own settings + own automatic times, switch back to TP.HCM', async ({ page, request }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('');
  await login(page, 'Người duyệt F');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await dlg.getByRole('button', { name: 'Tạo cấu hình mới', exact: true }).click();
  await dlg.getByLabel('Tên cấu hình').fill('Đà Nẵng');
  await dlg.getByLabel('Tên địa bàn').fill('Đà Nẵng');
  await dlg.getByRole('button', { name: 'Tạo cấu hình', exact: true }).click();
  await expect(page.getByLabel('Cấu hình (profile)')).toHaveValue('da-nang');
  // Settings reopen on the new profile's overview after the reload
  await expect(dlg.getByTestId('nav-this-profile')).toContainText('Đà Nẵng');
  await expect(dlg.getByTestId('nav-profile-hcm')).toBeVisible();
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();
  const cfg = (await (await request.get('http://127.0.0.1:5181/config?profile=da-nang')).json()).config;
  expect(cfg.settings.location.regionName).toBe('Đà Nẵng');
  expect(cfg.by).toBe('Người duyệt F');
  // no data yet for the new profile; its automatic times are its own (none ticked)
  const strip = page.getByTestId('server-status');
  await expect(page.getByLabel('Cấu hình (profile)')).toHaveValue('da-nang');
  const dnMorning = strip.getByLabel('Tự động lúc 08:00');
  await expect(dnMorning).not.toBeChecked();
  await dnMorning.click();
  await expect(dnMorning).toBeChecked();
  const st = (await (await request.get('http://127.0.0.1:5181/status')).json()) as { profiles: Array<{ id: string; schedule?: { morning?: boolean } }> };
  expect(st.profiles.map((p) => [p.id, !!p.schedule?.morning])).toEqual([['hcm', false], ['da-nang', true]]);
  // the 08:00 run is for Đà Nẵng only
  expect((await (await request.get('http://127.0.0.1:5181/__cron')).json()).profiles).toEqual(['da-nang']);
  await page.screenshot({ path: 'docs/screenshots/web-profile-da-nang.png' });
  // Settings say which profile every section edits: sources, rules, location, categories… are grouped under it
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const dlg2 = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(dlg2.getByTestId('settings-profile')).toContainText('Đà Nẵng');
  const own = dlg2.getByTestId('nav-this-profile');
  await expect(own).toContainText('Đà Nẵng');
  for (const l of ['Nguồn tin', 'Từ khóa & quy tắc', 'Địa điểm', 'Lĩnh vực']) await expect(own.getByRole('button', { name: l, exact: true })).toBeVisible();
  await own.getByRole('button', { name: 'Lĩnh vực', exact: true }).click();
  // basic view: name, on/off and keywords; the requirement is shown as a small "cần kèm" chip
  const pol = dlg2.getByTestId('category-POLICY');
  await expect(pol).toContainText('cần kèm: Xây dựng / Giao thông');
  await expect(pol.getByRole('group', { name: /Lĩnh vực bắt buộc đi kèm/ })).toHaveCount(0);
  // "Chính sách, pháp quy" counts only with a construction/transport sector in the title/sapo – a UI setting (Nâng cao), not a file
  await dlg2.getByRole('switch', { name: 'Nâng cao' }).click();
  await expect(pol.getByRole('group', { name: /Lĩnh vực bắt buộc đi kèm/ }).getByLabel('Xây dựng')).toBeChecked();
  await expect(pol.getByRole('group', { name: /Lĩnh vực bắt buộc đi kèm/ }).getByLabel('Giao thông')).toBeChecked();
  await dlg2.getByTestId('category-TRAFFIC').locator('summary').click();
  await expect(dlg2.getByTestId('category-TRAFFIC')).toContainText('yêu cầu');
  await page.screenshot({ path: 'docs/screenshots/web-settings-per-profile.png' });
  await dlg2.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await dnMorning.click();
  await expect(dnMorning).not.toBeChecked();
  await expect(page.getByTestId('server-idle')).toBeVisible({ timeout: 40_000 });
  // back to TP.HCM: its published data is shown again
  await page.getByLabel('Cấu hình (profile)').selectOption('hcm');
  await expect(page.getByLabel('Cấu hình (profile)')).toHaveValue('hcm');
  await expect(page.locator('article').filter({ hasText: 'khiến nhiều tuyến đường ở phường Hiệp Bình' }).first()).toBeVisible();
});
test('web review is ONE for the whole team: what A selects / moves / removes on one machine, B sees on another', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await a.goto('');
  await login(a, 'Người duyệt G');
  await expect(a.getByTestId('reviewer-chip')).toContainText('Người duyệt G');
  await a.reload();
  await a.waitForLoadState('networkidle'); // the team review is loaded (earlier tests already changed it)
  const readyTab = (p: Page) => p.getByRole('button', { name: /^Bài sẵn sàng/ });
  const reviewTab = (p: Page) => p.getByRole('button', { name: /^Cần kiểm tra/ });
  const n = async (l: ReturnType<typeof readyTab>) => Number(/\((\d+)\)/.exec((await l.getAttribute('aria-label')) ?? '')![1]);
  // A: select one ready story for the report, remove another, move one story from Cần kiểm tra
  const stories = a.locator('article');
  const t1 = (await stories.nth(0).locator('h3').innerText()).trim();
  const t2 = (await stories.nth(1).locator('h3').innerText()).trim();
  await stories.nth(0).getByLabel(/^Chọn bài/).check();
  await a.locator('article').filter({ hasText: t2 }).getByRole('button', { name: /^Loại bài:/ }).click();
  await a.locator('article').filter({ hasText: t2 }).getByRole('menuitem', { name: /Trùng tin/ }).click();
  await reviewTab(a).click();
  const review1 = await n(reviewTab(a));
  const t3 = (await a.locator('article').first().locator('h3').innerText()).trim();
  await a.locator('article').first().getByRole('button', { name: /Chuyển sang Bài sẵn sàng/ }).click();
  await expect(reviewTab(a)).toHaveAttribute("aria-label", `Cần kiểm tra (${review1 - 1})`);
  const readyA = (await readyTab(a).getAttribute("aria-label")) ?? "";
  const reviewA = (await reviewTab(a).getAttribute("aria-label")) ?? "";
  const exportA = (await a.getByRole('button', { name: /^Xuất báo cáo/ }).getAttribute("aria-label")) ?? "";
  const nSel = Number(/\((\d+)\)/.exec(exportA ?? "")![1]);

  // B on another machine (fresh browser), not logged in: sees the same team review
  const b = await (await browser.newContext()).newPage();
  await b.goto('');
  await b.waitForLoadState('networkidle');
  await expect(readyTab(b)).toHaveAttribute("aria-label", readyA); // the same lists on the other machine
  await expect(reviewTab(b)).toHaveAttribute("aria-label", reviewA);
  await expect(b.getByRole('button', { name: /^Xuất báo cáo/ })).toHaveText(exportA);
  const s1 = b.locator('article').filter({ hasText: t1 });
  await expect(s1.getByLabel(/^Chọn bài/)).toBeChecked();
  await expect(s1.getByTestId('shared-by')).toContainText('Người duyệt G');
  await expect(b.locator('article').filter({ hasText: t3 }).getByRole('button', { name: /Trả về Cần kiểm tra/ })).toBeVisible();
  await b.getByTestId('excluded-list').locator('summary').click();
  await expect(b.getByTestId('excluded-list')).toContainText(t2);
  await b.screenshot({ path: 'docs/screenshots/web-team-review.png' });
  // without a session B cannot change it (login dialog), with one B's change reaches A
  await s1.getByLabel(/^Chọn bài/).uncheck().catch(() => undefined);
  await expect(b.getByRole('dialog', { name: 'Đăng nhập' })).toBeVisible();
  await b.getByLabel('Tên đăng nhập').fill('duyet-h');
  await b.getByLabel('Mật khẩu').fill('test-pass');
  await b.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(b.getByTestId('reviewer-chip')).toContainText('Người duyệt H');
  await b.locator('article').filter({ hasText: t1 }).getByLabel(/^Chọn bài/).uncheck();
  await expect(b.getByRole('button', { name: /^Xuất báo cáo/ })).toHaveText(`Xuất báo cáo (${nSel - 1})`);
  await a.reload();
  await expect(a.getByRole('button', { name: /^Xuất báo cáo/ })).toHaveText(`Xuất báo cáo (${nSel - 1})`);
  await expect(a.locator('article').filter({ hasText: t1 }).getByTestId('shared-by')).toContainText('Người duyệt H');
});

test('web: "Dò cấu trúc" and "Thử thu thập" run in the browser through the review worker (reviewers only)', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await page.goto('');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await dlg.getByRole('button', { name: 'Nguồn tin', exact: true }).click();
  // not logged in: a clear message (no longer "only in the local app")
  await dlg.getByRole('button', { name: 'Thêm nguồn' }).click();
  await dlg.getByLabel('URL trang chủ báo').fill('https://fixture-a.example.vn/');
  await dlg.getByRole('button', { name: /Dò cấu trúc tự động/ }).click();
  await expect(page.getByText(/Hãy đăng nhập người duyệt để dò \/ thử nguồn trên web/).first()).toBeVisible();
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await login(page, 'Người duyệt T');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await dlg.getByRole('button', { name: 'Nguồn tin', exact: true }).click();
  await dlg.getByRole('button', { name: 'Thêm nguồn' }).click();
  await dlg.getByLabel('URL trang chủ báo').fill('https://fixture-a.example.vn/');
  await dlg.getByRole('button', { name: /Dò cấu trúc tự động/ }).click();
  await expect(dlg.getByText('https://fixture-a.example.vn/rss/thoi-su.rss').first()).toBeVisible({ timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Thêm vào danh sách' }).click();
  const card = dlg.locator('[data-testid^="source-"]').filter({ hasText: 'fixture-a.example.vn' }).first();
  await card.getByRole('button', { name: 'Thử thu thập' }).click();
  await expect(card).toContainText(/Kết quả thử \(\d+ link ứng viên\)/, { timeout: 30_000 });
  await expect(card).toContainText('[rss] ok');
  await expect(card).toContainText('Mưa lớn tối 8.11'); // a sample article really extracted
  await page.screenshot({ path: 'docs/screenshots/web-source-test.png' });
});

test('F5 opens the most recent collection; "Kỳ gần nhất" = latest run; picking a saved run loads its window; reviewers archive / bring back runs', async ({ page }) => {
  await page.goto('');
  await page.waitForLoadState('networkidle');
  const picker = page.getByTestId('run-picker');
  const rows = page.getByRole('listbox', { name: 'Danh sách các lượt' }).getByRole('option');
  const field = async (l: string) => `${await page.getByLabel(`${l} – ngày`).inputValue()}T${await page.getByLabel(`${l} – giờ`).inputValue()}:${await page.getByLabel(`${l} – phút`).inputValue()}`;
  // the on-demand period 18:00 08/11 → 07:00 09/11 (collected in an earlier test) is the most recent collection
  await expect(picker).toContainText('08/11 18:00 → 09/11/2026 07:00'); // compact label
  expect(await field('Từ')).toBe('2026-11-08T18:00');
  expect(await field('Đến')).toBe('2026-11-09T07:00');
  await expect(page.getByRole('button', { name: 'Kỳ gần nhất' })).toHaveClass(/bg-navy-700/); // latest run = "Kỳ gần nhất"
  await picker.click();
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true'); // newest first, current one ticked
  // pick the daily period: Từ / Đến follow
  await rows.filter({ hasText: '08/11 17:00 → 09/11/2026 08:00' }).click();
  await expect.poll(() => field('Từ')).toBe('2026-11-08T17:00');
  expect(await field('Đến')).toBe('2026-11-09T08:00');
  // "Kỳ gần nhất" goes back to the most recent run (not a computed clock window)
  await page.getByRole('button', { name: 'Kỳ gần nhất' }).click();
  await expect(picker).toContainText('08/11 18:00 → 09/11/2026 07:00');
  await expect.poll(() => field('Từ')).toBe('2026-11-08T18:00');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(picker).toContainText('08/11 18:00 → 09/11/2026 07:00'); // F5 → most recent again
  // not logged in: no delete
  await picker.click();
  await expect(page.getByRole('button', { name: /^Xoá lượt/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // a reviewer archives the on-demand run: it moves to "Lưu trữ" (collapsed, at the end) for the team, the latest
  // remaining run opens; it can still be viewed, and brought back (18/11/2026)
  await login(page, 'Người duyệt E');
  await picker.click();
  await page.getByRole('button', { name: 'Lưu trữ lượt 08/11 18:00 → 09/11/2026 07:00' }).click();
  await expect(picker).not.toContainText('08/11 18:00 → 09/11/2026 07:00');
  const other = await page.context().browser()!.newPage();
  await other.goto(page.url());
  await other.waitForLoadState('networkidle');
  await other.getByTestId('run-picker').click();
  const archive = other.getByTestId('run-archive');
  await expect(archive).toContainText('Lưu trữ (1)');
  await archive.locator('summary').click();
  await expect(archive).toContainText('08/11 18:00 → 09/11/2026 07:00');
  await other.close();
  await picker.click();
  await page.getByTestId('run-archive').locator('summary').click();
  await page.getByRole('button', { name: 'Bỏ lưu trữ lượt 08/11 18:00 → 09/11/2026 07:00' }).click();
  await picker.click();
  await expect(rows.filter({ hasText: '08/11 18:00 → 09/11/2026 07:00' })).toHaveCount(1);
  await expect(page.getByTestId('run-archive')).toHaveCount(0);
  // "Xoá" is final: no list of deleted runs to restore from
  await expect(page.getByText(/Lượt đã xoá/)).toHaveCount(0);
});

test('daily suggestions: published by the nightly job, applied (then saved) or dismissed for the whole team', async ({ page, request, browser }) => {
  // what scripts/suggest-filter.ts publishes after the nightly label pull
  const items = [
    { id: 'include:lối đi bộ', kind: 'include', phrase: 'lối đi bộ', category: 'INFRA', fixes: 2, sideEffects: 0, examples: ['Cử tri kiến nghị lát lại lối đi bộ', 'Lát đá lại lối đi bộ phố Nguyễn Huệ'], sideExamples: [] },
    { id: 'exclude_title:trung tâm thương mại', kind: 'exclude_title', phrase: 'trung tâm thương mại', fixes: 2, sideEffects: 1, examples: ['Xây trung tâm thương mại 20 tầng', 'Khởi công trung tâm thương mại mới'], sideExamples: ['Trung tâm thương mại cũ xuống cấp'] },
  ];
  const pub = await request.post('http://127.0.0.1:5181/suggestions', { headers: { authorization: 'Bearer test-export-token' }, data: { profile: 'hcm', generatedAt: '2026-11-17T16:35:00Z', basis: { stories: 120, votes: 30, decisions: 12 }, items } });
  expect(pub.status()).toBe(200);
  await page.goto('');
  await login(page, 'Người duyệt S');
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(dlg.getByTestId('suggest-count')).toHaveText('2'); // badge in the menu
  await dlg.getByRole('button', { name: /^Gợi ý cải thiện/ }).click();
  await expect(dlg.getByTestId('suggest-basis')).toContainText('Học từ 30 phiếu ✓/✗ và 12 quyết định duyệt');
  const cards = dlg.getByTestId('suggestion');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Giữ lại 2 bài nhóm đánh giá liên quan nhưng đang bị loại');
  await expect(cards.nth(1)).toContainText('ảnh hưởng thêm 1 bài chưa chấm');
  // apply the first one → it is in the filter words; Lưu makes it the shared configuration
  await cards.first().getByRole('button', { name: 'Áp dụng' }).click();
  await expect(dlg.getByTestId('save-bar')).toBeVisible();
  await dlg.getByRole('button', { name: 'Từ khóa & quy tắc', exact: true }).click();
  await expect(dlg.getByTestId('basic-include')).toContainText('lối đi bộ');
  await dlg.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu cài đặt')).toBeVisible();
  const cfg = (await (await request.get('http://127.0.0.1:5181/config')).json()).config;
  expect(JSON.stringify(cfg.settings.rules)).toContain('lối đi bộ');
  expect(cfg.settings.categories.find((c: { code: string }) => c.code === 'INFRA').keywords).toContain('lối đi bộ');
  // impact preview: the draft is scored on the stories the team judged, before saving
  const gold = { profile: 'hcm', articles: [
    { id: 'a_gold00000001', sourceId: 'fixture-a', sourceName: 'A', title: 'Khởi công xây dựng cầu Thủ Thiêm 4 ở TP.HCM', sapo: 'Công trình cầu Thủ Thiêm 4 được khởi công, xây dựng tại TP.HCM.', bodyText: '' },
    { id: 'a_gold00000002', sourceId: 'fixture-a', sourceName: 'A', title: 'Khởi công xây dựng trung tâm thương mại mới ở TP.HCM', sapo: 'Công trình trung tâm thương mại được khởi công xây dựng tại phường An Khánh, TP.HCM.', bodyText: '' },
  ], judged: { a_gold00000001: true, a_gold00000002: false } };
  expect((await request.post('http://127.0.0.1:5181/golden', { headers: { authorization: 'Bearer test-export-token' }, data: gold })).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await dlg.getByRole('button', { name: 'Từ khóa & quy tắc', exact: true }).click();
  const ex = dlg.getByTestId('basic-exclude').locator('input');
  await ex.fill('trung tâm thương mại');
  await ex.press('Enter');
  const imp = dlg.getByTestId('impact');
  await expect(imp).toContainText('Trên 2 bài đã chấm');
  await expect(imp).toContainText('đúng chủ đề 50% → 100%');
  await imp.locator('summary').click();
  await expect(imp).toContainText('Khởi công xây dựng trung tâm thương mại mới ở TP.HCM');
  await dlg.getByRole('button', { name: 'Hủy thay đổi' }).click();
  await expect(dlg.getByTestId('save-bar')).toHaveCount(0);
  // dismiss the second one: gone for everyone
  await dlg.getByRole('button', { name: /^Gợi ý cải thiện/ }).click();
  await dlg.getByTestId('suggestion').filter({ hasText: 'trung tâm thương mại' }).getByRole('button', { name: 'Bỏ qua' }).click();
  await expect(dlg.getByTestId('suggestion').filter({ hasText: 'trung tâm thương mại' })).toHaveCount(0);
  const other = await (await browser.newContext()).newPage();
  await other.goto(page.url());
  await other.getByRole('button', { name: 'Cài đặt' }).click();
  await other.getByRole('dialog', { name: 'Cài đặt' }).getByRole('button', { name: /^Gợi ý cải thiện/ }).click();
  await expect(other.getByRole('dialog', { name: 'Cài đặt' }).getByTestId('suggestion').filter({ hasText: 'trung tâm thương mại' })).toHaveCount(0);
  await other.close();
});

test('Hỏi nhanh: an answer moves on at once (save in the background), every vote is saved even when answering fast', async ({ page, request }) => {
  // a slow network to the review worker (~800 ms per request)
  await page.route('http://127.0.0.1:5181/labels', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto('');
  await login(page, 'Người duyệt Q');
  const card = page.getByTestId('quick-ask');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: /Bắt đầu Hỏi nhanh/ }).click(); // a pill in the header (18/11/2026)
  const dlg = page.getByRole('dialog', { name: 'Hỏi nhanh' });
  const total = Number(/\/ (\d+)/.exec(await dlg.innerText())![1]);
  const titles: string[] = [];
  for (let i = 0; i < total; i++) {
    const story = dlg.getByTestId('quick-ask-story');
    titles.push((await story.locator('h3').innerText()).trim());
    const t0 = Date.now();
    if (i % 2) {
      // "✗ Không" asks why: one more click on a reason answers
      await dlg.getByRole('button', { name: '✗ Không' }).click();
      await dlg.getByTestId('ask-reasons').getByRole('button', { name: /Lạc đề/ }).click();
    } else await dlg.getByRole('button', { name: '✓ Liên quan' }).click();
    // the next story (or the end) shows without waiting for the save
    if (i < total - 1) await expect(dlg.getByTestId('quick-ask-story').locator('h3')).not.toHaveText(titles[i]!, { timeout: 500 });
    else await expect(dlg).toContainText(`Đã chấm ${total} bài`, { timeout: 500 });
    expect(Date.now() - t0).toBeLessThan(1200);
  }
  await dlg.getByRole('button', { name: 'Xong' }).click();
  // the round is over: the card says so (no next 8 stories), then closes by itself
  await expect(card).toHaveAttribute('data-state', 'done');
  await expect(card).toContainText(/đã chấm xong/i);
  await expect(card).toBeHidden({ timeout: 8000 });
  // all votes reach the worker (sent one after another in the background)
  const tq = await tokenOf(request, 'Người duyệt Q');
  await expect.poll(async () => {
    const days = ['2026-11-08', '2026-11-09'];
    let n = 0;
    for (const d of days) {
      const r = await request.get(`http://127.0.0.1:5181/labels?date=${d}`, { headers: { 'x-review-code': tq } });
      const v = (await r.json()) as { votes?: Record<string, Array<{ r: string }>> };
      n += Object.values(v.votes ?? {}).filter((list) => list.some((x) => x.r === 'Người duyệt Q')).length;
    }
    return n;
  }, { timeout: 20_000 }).toBe(total);
});

test('a page opened before a new version reloads itself when an on-demand part is gone, then the export works', async ({ page }) => {
  // downloads are captured in the page (survives the reload)
  await page.addInitScript(() => {
    const w = window as unknown as { __files?: string[] };
    w.__files = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__files!.push(this.download);
    };
  });
  // the design part of the OLD version is gone after a publication (404 once, like a page left open)
  let gone = true;
  await page.route(/\/assets\/styles-[^/]+\.js$/, async (route) => (gone ? (gone = false, route.fulfill({ status: 404, body: 'Not Found' })) : route.continue()));
  await page.goto('');
  await login(page, 'Người duyệt U');
  await page.locator('article input[type=checkbox]').first().check();
  await page.getByRole('button', { name: /^Xuất báo cáo/ }).click();
  await page.getByTestId('template-picker').locator('input[value="toi-gian"]').check();
  await page.getByRole('checkbox', { name: '.docx' }).uncheck();
  await page.getByRole('button', { name: 'Xuất báo cáo', exact: true }).click();
  // reloaded once, with the reason
  await expect(page.getByText(/Trang vừa được cập nhật lên phiên bản mới/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Xuất báo cáo/ }).click();
  await page.getByTestId('template-picker').locator('input[value="toi-gian"]').check();
  await page.getByRole('checkbox', { name: '.docx' }).uncheck();
  await page.getByRole('button', { name: 'Xuất báo cáo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __files: string[] }).__files), { timeout: 30_000 }).toEqual([expect.stringMatching(/\.pptx$/)]);
});

test('after a scheduled run finishes, the open page shows the new period by itself (no F5)', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('');
  await expect(page.getByTestId('run-picker')).toBeVisible();
  await request.get('http://127.0.0.1:5181/__scheduled-run');
  await page.reload(); // the page sees the server busy with the scheduled run
  await expect(page.getByTestId('server-busy')).toContainText('lượt tự động theo lịch');
  // no reload from here on: the run finishes, the page looks for the new data and opens it
  await expect(page.getByTestId('server-idle')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('run-picker')).toContainText('10/11/2026 · 08:01–16:30', { timeout: 40_000 });
  await expect(page.getByTestId('run-picker')).toContainText('lịch 16:30');
  await expect(page.getByText(/Có kỳ mới 10\/11\/2026 · 08:01–16:30 – đã mở/)).toBeVisible();
});

test('Biên tập in "Xem chi tiết": edited title / summary are saved for the team and survive a refresh and a later pull', async ({ page }) => {
  await page.goto('');
  await login(page, 'Người duyệt H');
  await page.reload();
  await page.waitForLoadState('networkidle');
  const card = page.locator('article').first();
  await card.getByRole('button', { name: 'Xem chi tiết' }).click();
  const dlg = page.getByRole('dialog', { name: 'Chi tiết bài' });
  const title = dlg.getByLabel(/Tiêu đề trên báo cáo/);
  await title.fill('Tiêu đề đã biên tập H');
  const sum = dlg.getByLabel(/Tóm tắt/);
  await sum.fill('Tóm tắt đã biên tập H.');
  await dlg.getByRole('button', { name: 'Lưu biên tập' }).click();
  await expect(dlg.getByTestId('edit-saved')).toHaveText('✓ Đã lưu cho cả nhóm'); // shown next to the button
  await dlg.getByRole('button', { name: 'Lưu biên tập' }).click();
  await expect(dlg.getByTestId('edit-saved')).toContainText('không có thay đổi mới'); // nothing changed: no new save
  // another photo: the story card shows it
  const photos = dlg.locator('button:has(img)');
  const n = await photos.count();
  const want = n > 1 ? await photos.nth(1).locator('img').getAttribute('src') : null;
  if (n > 1) {
    await photos.nth(1).click();
    await expect(dlg.getByTestId('photo-saved')).toBeVisible();
  }
  await page.keyboard.press('Escape');
  if (want) await expect(page.locator('article').filter({ hasText: 'Tiêu đề đã biên tập H' }).locator('img').first()).toHaveAttribute('src', want);
  await expect(page.locator('article').filter({ hasText: 'Tiêu đề đã biên tập H' })).toBeVisible();
  // another tab focus pulls the team review: the edit stays
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1500);
  await expect(page.locator('article').filter({ hasText: 'Tiêu đề đã biên tập H' })).toBeVisible();
  await page.reload();
  await expect(page.locator('article').filter({ hasText: 'Tiêu đề đã biên tập H' })).toBeVisible();
  await page.locator('article').filter({ hasText: 'Tiêu đề đã biên tập H' }).getByRole('button', { name: 'Xem chi tiết' }).click();
  await expect(page.getByRole('dialog', { name: 'Chi tiết bài' }).getByLabel(/Tóm tắt/)).toHaveValue('Tóm tắt đã biên tập H.');
});

test('source tile "Kiểm tra nhanh": checks the publisher now (1 listing page + 1 sample) and shows the result under the period status', async ({ page, request }) => {
  // the shared configuration lists the fixture publishers (the button needs the source's settings)
  const cur = ((await (await request.get('http://127.0.0.1:5181/config?profile=hcm')).json()) as { config: { settings: unknown } | null }).config;
  const A = 'https://fixture-a.example.vn';
  const saved = await request.post('http://127.0.0.1:5181/config', { headers: { 'x-review-code': await tokenOf(request, 'Người duyệt K'), 'content-type': 'application/json' }, data: { profile: 'hcm', reviewer: 'Người duyệt K', settings: cur?.settings ?? {}, sources: [{ id: 'fixture-a', name: 'Báo mẫu thử A', baseUrl: A, rssUrls: [`${A}/rss/thoi-su.rss`], sectionUrls: [`${A}/thoi-su.htm`] }] } });
  expect(saved.status()).toBe(200);
  await page.goto('');
  const btn = page.getByTestId('source-check-fixture-a');
  await expect(btn).toBeVisible();
  await btn.click(); // not logged in → the login dialog
  await expect(page.getByRole('dialog', { name: 'Đăng nhập' })).toBeVisible();
  await page.keyboard.press('Escape');
  await login(page, 'Người duyệt K');
  const id = (await btn.getAttribute('data-testid'))!.replace('source-check-', '');
  await btn.click();
  const res = page.getByTestId(`source-check-result-${id}`);
  await expect(res).toContainText(/Bây giờ \(\d\d:\d\d\): /, { timeout: 30_000 });
  await expect(res).toContainText(/hoạt động · \d+ link|đường OK|không lấy được tin/);
  await expect(page.getByTestId(`source-tile-${id}`)).toContainText(/✓ OK|Một phần|lỗi/); // the period's own status stays
});

test('collection token: expiry warning for everyone, replaced from Cài đặt after the server checked it (20/11/2026)', async ({ page, request }) => {
  const soon = new Date(Date.now() + 10 * 86400_000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  await request.get(`http://127.0.0.1:5181/__token-expiry?d=${encodeURIComponent(soon)}`);
  await page.goto('');
  const warn = page.getByTestId('token-warning');
  await expect(warn).toContainText(/Khóa thu thập hết hạn sau (9|10) ngày/);
  await login(page, 'Người duyệt H');
  await warn.click(); // opens Cài đặt › Thời gian
  const dlg = page.getByRole('dialog', { name: 'Cài đặt' });
  const box = dlg.getByTestId('collect-token');
  await expect(box).toContainText('Khóa đang dùng: …fake');
  await expect(box).toContainText(/còn (9|10) ngày/);
  // a token without the Actions permission is refused, the old one stays
  await box.getByLabel('Khóa mới').fill('github_pat_noperm_' + 'N'.repeat(30));
  await box.getByRole('button', { name: 'Kiểm tra & lưu' }).click();
  await expect(page.getByText(/Khóa thiếu quyền chạy thu thập/)).toBeVisible();
  await expect(box).toContainText('Khóa đang dùng: …fake');
  // a good token is saved, never shown again (only the last 4 characters)
  const good = 'github_pat_' + 'G'.repeat(36) + 'k3Y9';
  await box.getByLabel('Khóa mới').fill(good);
  await box.getByRole('button', { name: 'Kiểm tra & lưu' }).click();
  await expect(page.getByText(/Đã kiểm tra và lưu khóa mới/)).toBeVisible();
  await expect(box).toContainText('Khóa đang dùng: …k3Y9');
  await expect(box).toContainText('cập nhật bởi Người duyệt H');
  await expect(box).toContainText(/còn (299|300) ngày/);
  await expect(box.getByLabel('Khóa mới')).toHaveValue('');
  expect(await page.content()).not.toContain(good);
  await box.screenshot({ path: 'docs/screenshots/web-collect-token.png' });
  await dlg.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await expect(warn).toHaveCount(0); // the new token is far from expiry
});

test('accounts: admin adds a reviewer in Cài đặt › Tài khoản; the reviewer signs in, changes the password, cannot manage accounts (20/11/2026)', async ({ page }) => {
  await page.goto('');
  await page.getByRole('button', { name: 'Đăng nhập duyệt tin' }).click();
  const dlg = page.getByRole('dialog', { name: 'Đăng nhập' });
  await page.getByLabel('Tên đăng nhập').fill('admin');
  await page.getByLabel('Mật khẩu').fill('sai');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(dlg.getByText('Sai tên đăng nhập hoặc mật khẩu')).toBeVisible();
  await page.getByLabel('Mật khẩu').fill('admin-pass');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByText('Xin chào Quản trị')).toBeVisible();
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const set = page.getByRole('dialog', { name: 'Cài đặt' });
  await set.getByRole('button', { name: 'Tài khoản', exact: true }).click();
  const panel = set.getByTestId('users-panel');
  await expect(panel.getByTestId('users-table')).toContainText('duyet-a');
  await panel.getByLabel('Tên đăng nhập mới').fill('Thu.Ha');
  await panel.getByLabel('Họ tên').fill('Thu Hà');
  await panel.getByLabel('Mật khẩu tài khoản').fill('thuha-123');
  await panel.getByRole('button', { name: 'Thêm' }).click();
  await expect(panel.getByTestId('users-table')).toContainText('thu.ha');
  await panel.screenshot({ path: 'docs/screenshots/web-accounts.png' });
  await set.getByRole('button', { name: 'Đóng cài đặt' }).click();
  // sign out, sign in as the new reviewer
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await page.getByRole('button', { name: 'Đăng nhập duyệt tin' }).click();
  await page.getByLabel('Tên đăng nhập').fill('thu.ha');
  await page.getByLabel('Mật khẩu').fill('thuha-123');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByText('Xin chào Thu Hà')).toBeVisible();
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  await set.getByRole('button', { name: 'Tài khoản', exact: true }).click();
  await expect(panel).toContainText('Người duyệt');
  await expect(panel.getByTestId('users-table')).toHaveCount(0);
  await panel.getByLabel('Mật khẩu mới').fill('moi-thuha');
  await panel.getByRole('button', { name: 'Đổi mật khẩu' }).click();
  await expect(page.getByText('Đã đổi mật khẩu')).toBeVisible();
});

test('reviewer vs admin: a reviewer reviews, while system-wide changes are greyed out "Chỉ quản trị viên" (20/11/2026)', async ({ page }) => {
  await page.goto('');
  await page.getByRole('button', { name: 'Đăng nhập duyệt tin' }).click();
  await page.getByLabel('Tên đăng nhập').fill('nguoi-duyet');
  await page.getByLabel('Mật khẩu').fill('test-pass');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByText('Xin chào Người duyệt thường')).toBeVisible();
  // automatic schedule switches: greyed out
  const strip = page.getByTestId('server-status');
  await expect(strip.getByLabel('Tự động lúc 08:00')).toBeDisabled();
  // daily work still open: mark a story relevant
  await page.getByRole('button', { name: /^Liên quan:/ }).first().click();
  await expect(page.getByRole('button', { name: /^Liên quan:/ }).first()).toHaveAttribute('aria-pressed', 'true');
  // Cài đặt: read-only note, Thời gian › Lưu giờ and Khóa thu thập greyed out
  await page.getByRole('button', { name: 'Cài đặt' }).click();
  const set = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(set.getByTestId('reviewer-readonly')).toBeVisible();
  await set.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await strip.getByTestId('edit-times').click(); // opens Cài đặt › Thời gian
  await expect(set.getByRole('button', { name: 'Về mặc định' })).toBeDisabled();
  await expect(set.getByRole('button', { name: 'Kiểm tra & lưu' })).toBeDisabled();
  await set.getByRole('button', { name: 'Tổng quan', exact: true }).click();
  await expect(set.getByRole('button', { name: 'Đổi tên' }).first()).toBeDisabled();
  await set.screenshot({ path: 'docs/screenshots/web-reviewer-readonly.png' });
});

test('same account on a second device: my Liên quan / Không votes show on the buttons there too (20/11/2026)', async ({ browser }) => {
  const pc = await (await browser.newContext()).newPage();
  await pc.goto('');
  await login(pc, 'Người duyệt V');
  // a story whose title is unique (two sources may carry the same title, in either order)
  await pc.getByRole('button', { name: /^Liên quan:/ }).first().waitFor();
  const labels = await pc.getByRole('button', { name: /^Liên quan:/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const title = labels.find((l) => labels.filter((x) => x === l).length === 1)!.replace(/^Liên quan: /, '');
  const first = pc.getByRole('button', { name: `Liên quan: ${title}`, exact: true });
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await pc.waitForTimeout(1500); // the vote is saved in the background
  // the "phone": a new browser, nothing stored locally; the team review answers AFTER the votes (bug seen on 20/11/2026)
  await fetch('http://127.0.0.1:5181/__slow-review?ms=2500');
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto('');
  await login(phone, 'Người duyệt V');
  await expect(phone.getByText('Xin chào Người duyệt V')).toBeVisible(); // signed in before the reload
  await phone.reload(); // F5 with a session: votes and review load together
  await expect(phone.getByRole('button', { name: `Liên quan: ${title}`, exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await fetch('http://127.0.0.1:5181/__slow-review?ms=0');
  // another reviewer's vote does not press MY button
  const other = await (await browser.newContext()).newPage();
  await other.goto('');
  await login(other, 'Người duyệt W');
  await expect(other.getByRole('button', { name: `Liên quan: ${title}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('shared access code retired (21/11/2026): a browser still holding the old code is asked to sign in with an account', async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem('hcm-demo:reviewer', JSON.stringify({ name: 'Người cũ', code: 'HCM-TEST-CODE' })));
  await page.goto('');
  await expect(page.getByTestId('live-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đăng nhập duyệt tin' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('hcm-demo:reviewer'))).toBe('null');
  // the worker refuses the code itself
  expect((await request.get('http://127.0.0.1:5181/me', { headers: { 'x-review-code': 'HCM-TEST-CODE' } })).status()).toBe(401);
});

test('phone layout (390 px): nothing wider than the screen; Settings = list of sections → one section full screen → back (26/11/2026)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  const page = await ctx.newPage();
  await page.goto('');
  await login(page, 'Người duyệt P');
  await expect(page.getByTestId('reviewer-chip')).toBeVisible();
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await width()).toBeLessThanOrEqual(390);
  // the three tabs share one row
  const tabs = page.getByRole('navigation', { name: 'Các mục' }).getByRole('button');
  const ys = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(ys).size).toBe(1);
  // settings: the list first, a section opens full width, "Các mục" goes back
  await page.getByRole('button', { name: 'Cài đặt', exact: true }).click();
  const nav = page.getByTestId('settings-nav');
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: 'Nguồn tin', exact: true }).click();
  await expect(nav).toBeHidden();
  await expect(page.getByTestId('settings-back')).toContainText('Nguồn tin');
  expect(await width()).toBeLessThanOrEqual(390);
  await page.getByTestId('settings-back').click();
  await expect(nav).toBeVisible();
  // accounts as cards on phones
  await nav.getByRole('button', { name: 'Tài khoản', exact: true }).click();
  await expect(page.getByTestId('users-list')).toContainText('duyet-p');
  await expect(page.getByTestId('users-table')).toBeHidden();
  expect(await width()).toBeLessThanOrEqual(390);
  await ctx.close();
});
