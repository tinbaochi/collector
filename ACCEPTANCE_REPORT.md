# ACCEPTANCE_REPORT — Evidence log (2026-11-16, session 13 update)

## Session 14x changes in status (2026-11-26)
| ID | Status | Evidence |
|---|---|---|
| UI – web app usable on a phone (390 px) | PASS (emulated) | Playwright Edge at 390×844 isMobile/hasTouch: home, Tùy chỉnh, Đổi giờ, Độ phủ & nguồn, Xem chi tiết, Hỏi nhanh, Xuất báo cáo, Kiểm tra and 8 Settings sections – document width 390 on every screen (was 391–405), screenshots reviewed. tests/ui-live "phone layout (390 px)": no horizontal overflow, tabs on one row, Settings list → section → back, accounts as cards. Real-iPhone check by the user pending. |

## Session 14w changes in status (2026-11-26)
| ID | Status | Evidence |
|---|---|---|
| Web site at the root URL (https://tinbaochi.github.io/), old links kept | PASS | Repo renamed to tinbaochi.github.io; Pages run 45748342194 success; Edge on the live site: / app shown, /collector/ and /collector/?x=1#h → / (query + hash kept), bccuong.github.io/news-reporter/ → /; worker 3e5cc244 /status 200 with token accepted; test:ui:live 20/20 with base /. Scheduled dispatch after the rename not yet observed. |

## Session 14v changes in status (2026-11-21)
| ID | Status | Evidence |
|---|---|---|
| SEC – web review access: personal accounts only (shared ACCESS_CODE retired) | PASS | tests/review-worker.test.ts: retired code → 401 on /me and /auto even with ACCESS_CODE still set; all endpoints exercised with an admin session; vitest 203/203. tests/ui-live/review.spec.ts "shared access code retired": stored old code dropped, login button shown, worker 401; live suite 20/20. Live: worker f887687d deployed, /me with a non-session code → 401; Pages deploy of 2adb48f success; live site (Edge) drops a stored old code and shows the login button. |

## Session 13 changes in status
| ID | Status | Evidence |
|---|---|---|
| UI responsiveness on the web (bulk select, Thu thập) | PASS (fixed) | Cause measured: sequential worker requests (0.3–1.2 s each), render 2–23 ms. Batch save + immediate feedback; measured 55 ms / 1 request for select-all and 54 ms for Thu thập with 350 ms simulated latency; worker batch test. |
| UI – "Lượt đã lưu" compact + delete; "Kỳ gần nhất" = latest run | PASS | Live E2E review.spec.ts (compact label, latest run highlighted as Kỳ gần nhất and re-opened from another run, reviewer delete hidden for a second browser, restore); server.test (DELETE run 401 without token, 404, removed, exports kept); worker test (hide/restore, reviewers only). |
| Web shared review – F5 resilience (Cloudflare KV free quota) | PASS (fixed) | F5 showed "Failed to fetch": worker threw "KV list() limit exceeded for the day" (wrangler tail). Reads now one get per period/day (no list), legacy keys merged once, errors answered with CORS. tests/review-worker.test.ts (list counter unchanged over repeated reads; quota-gone → 200 + pending; 503 with CORS). Live: GET /review of the custom period 500 → 200 after deploy. |
| UI – publisher home page link | PASS | Source tile name = link to the source's home page (new tab, noopener); tests/ui/app.spec.ts. |
| REP – PDF without Office (built-in) + one file name | PASS | `src/reports/pdf.ts` (pdf-lib, Tinos OFL): local + browser; tests/pdf.test.ts (A4, every source URL + mailto as link annotations, flows over pages, non-JPEG/PNG photo noted), server.test (pptx/docx/pdf same stem, %PDF), live E2E (web names equal, .pptx/.docx ticked by default, PDF with the real photo). Rendered pages checked visually. |
| REP – 4 original designs reworked (user: "slides rời rạc, nội dung trống nhiều") | PASS | `src/reports/styles.ts`: measured flow layout (text height estimated per font, bold factor), cover with counts + "TIÊU ĐIỂM" headlines + first real photo, groups flow continuously with inline headings kept with their first story (no half-empty page per group), 2 columns on 16:9, last page balanced, "Đề xuất" box per Tồn tại story, Kiến nghị page = table STT/Tin/Đề xuất giao + contact + totals. "Ảnh lớn": a full photo page only for stories with a real photo. Visual QA with PowerPoint PNG export of an 11-story set: hành chính 5, bản tin 4, tối giản 5, ảnh lớn 7 slides, no overlapping text. Original designs (no third-party free templates: licence/attribution on a public repo). typecheck, vitest 130/130, playwright 11/11, live 8/8. |
| LED-01 / no silent omission (hourly web runs) | **PASS (fixed regression)** | Defect found from team labels: each hourly cloud run started empty, so with the 50/publisher limit stories extracted in an earlier hour fell back to `retry_pending FETCH_LIMIT` or left the RSS feed and vanished from the published period (10 of 17 labelled stories gone). Fix: `seedFromPublished` in `scripts/cloud-collect.ts` resumes the run from the same period's publication (same window + settings hash). `tests/collector.test.ts` "hourly cloud runs continue…" (ids kept, story not re-downloaded, limit spent on new links, fresh run on changed settings/window). Real 2-pass dry run on live sources: pass 1 119 articles → pass 2 166, **0 lost**, retry_pending 548→379, ready 23→30, all adapters ok. |
| DIS-06 / LED-02 duplicate by canonical | PASS (improved) | A link that is the canonical page of an already extracted story → `duplicate` DUPLICATE_CANONICAL, no fetch, its discovery evidence merged into the story; `tests/collector.test.ts` "a link that is already the canonical page…" (fails without the fix). vitest 90/90, playwright 9/9. |
| UI – profile scope & template choice (user feedback) | PASS | Settings show the active profile and group its sections; export + Settings list all 5 templates as radio cards. Live E2E 5/5 (`tests/ui-live/review.spec.ts`: per-profile nav for "Đà Nẵng", 5 built-in templates visible, Skill template default, export with "ban-tin"). Screenshots in docs/screenshots. |
| DIS-08 false degraded after carry-over | PASS (fixed) | 09:12 live run falsely degraded 3 sources; fix 7649d00, 09:49 live run: 6/6 ok, ready 35. |
| Web shared review (team) | **PASS** | One decision per article per period on the review worker (deployed); two-browser E2E: A selects/removes/moves → B (another machine, not logged in) sees the same lists, report selection and "duyệt chung: A"; B cannot change without login; B's change reaches A. vitest worker tests (merge, validation, separation per period/profile). |
| DIS-08 | PASS (adjusted) | Container drift share now counts only articles with a recorded container (carried-over articles from older data have none) – `tests/health.test.ts` green. |


## Session 4 changes in status
| ID | New status | Evidence |
|---|---|---|
| DIS-08 | **PASS** | `tests/health.test.ts` (baseline → container change → broken markup → recovery; degraded runs never become baseline), Playwright DIS-08 (redesign → coverage tab "SUY GIẢM" + reasons + recovery, articles in review queue), screenshot `docs/screenshots/adapter-degraded.png`; live baseline for 5 real sources |
| DIS-06 | PASS (improved) | `tests/cluster.test.ts` transitive 4-publisher event, no chaining of unrelated news; live eval 19 multi-publisher events |

# Session 3 update

## Session 3 changes in status
| ID | New status | Evidence |
|---|---|---|
| DIS-06 | **PASS** | `tests/assemble.test.ts`, `tests/server.test.ts` (fixture A+D clustered, merged, manifest has both sources), Playwright merge→export→manifest→split; real-data render check with Thanh Niên+VnExpress / Thanh Niên+SGGP |
| RPT-01 | **PASS (PowerPoint)** | Exported PPTX opened in Microsoft PowerPoint (COM, no repair) and exported to PDF by PowerPoint; visually inspected |
| PDF parity | **PASS** | PowerPoint PDF and LibreOffice PDF of the same PPTX match page-by-page |

# Session 2 update

## Session 2 changes in status
| ID | New status | Evidence |
|---|---|---|
| UI-01 | **PASS** | `tests/ui/app.spec.ts` (Playwright, real clicks): wizard, bad-URL block, RSS added, persists after reload |
| UI-03 | **PASS** | UI toggle → reload → still off; collector test: disabled source never fetched |
| UI-04 | **PASS** | UI adds NOT term, explanation + preview "Không khớp", persists after reload |
| UI-05 | **PASS** | UI test: ward match, new place added in editor matches, persists |
| UI-06 | **PASS** | UI test: custom from/to shows `[17:00 08/11/2026, 08:00 09/11/2026)`, invalid range blocked |
| UI-07 | **PASS** | UI test: retries/per-host edited, warning shown, persists |
| UI-08 | **PARTIAL→PASS (local)** | template upload API + original-template export + LibreOffice PDF; upload click-through not automated (file chooser) |
| RPT-01 | **PASS (LibreOffice render)** | Real articles 15/11/2026 → PPTX from original template → PDF inspected page by page (docs/TEMPLATE_INTEGRATION.md). Not opened in MS PowerPoint. |
| RPT-02 | **PASS** | `tests/template.test.ts` text-only path; failed photo → text layout in live export |
| RPT-03 | **PASS** | template copy stored, original untouched; mismatching template refused (`TemplateMismatchError` → 422) |
| E2E | **PASS** | UI test collects fixtures, ledger shows `OUTSIDE_DATE_WINDOW`/`FETCH_403`, reconciliation 11/11, selects article, exports PPTX |

Defects found by these tests and fixed: SSE double-`done` crashed the server process; review checkbox lagged (now optimistic); template hyperlink XML corruption; JSZip folder removal deleted all images; stale footer date in layout; weak-topic articles marked ready (now `WEAK_TOPIC_EVIDENCE` review queue).

---

# Session 1 log

`PASS` = automated test or reproducible command executed this session. `PARTIAL` = implemented & wired, evidence incomplete. `BLOCKED` = missing tool/asset.

| ID | Status | Evidence | Notes |
|---|---|---|---|
| UI-01 add source, persist restart | PARTIAL | `tests/server.test.ts` (PUT sources → restart → present); wizard in `web/src/SourcesPanel.tsx` | No automated click-through test yet |
| UI-02 RSS/sitemap/section + preview | PARTIAL | `/api/sources/detect`, `/api/sources/test`; verified/hypothesis chips | Manual UI check pending |
| UI-03 disabled source not fetched | PASS | `collector.test.ts` asserts no request to source C; failing B doesn't block A | |
| UI-04 include + OR + NOT | PASS (logic) | `domain.test.ts` Boolean rule builder; builder UI + preview wired | UI click test pending |
| UI-05 HCMC aliases | PASS (logic) | `domain.test.ts` location; unknown → review | |
| UI-06 from/to, VN tz, [from,to) | PASS (logic) | `domain.test.ts` time window (8 cases); custom window persisted via settings | |
| UI-07 retry/concurrency/depth | PASS (logic) | `collector.test.ts` page-limit → `PAGINATION_LIMIT` surfaced; settings persisted (server test) | |
| UI-08 upload PPTX, test render | PARTIAL | `/api/templates` stores copy; export works with DEMO renderer | Uploaded template not used by renderer |
| UI-09 import websites.txt / restore | PASS (logic) | `domain.test.ts` import; rollback in `server.test.ts`; UI never overwrites existing ids | |
| DIS-01 RSS+sitemap overlap | PASS | `collector.test.ts` | |
| DIS-02 pagination late article | PASS | page-2 article found; limit case flagged | |
| DIS-03 only on section page | PASS | | |
| DIS-04 403/429/timeout | PASS | 403 → `blocked`; 503 source → `failed`; retry/backoff covered | 429 Retry-After path not fixture-tested |
| DIS-05 no publish time | PASS | `date_unverified`; export blocked unless manually verified (server test) | |
| DIS-06 same event | PARTIAL | Jaccard clustering flags "cùng sự kiện?" | Manual merge/split UI missing |
| DIS-07 out-of-window | PASS | feed date + exact 08:00 boundary → `outside_window` | |
| DIS-08 selector change → degraded | NOT STARTED | | |
| EXT-01 sapo + 8 paragraphs + 2 subheads | PASS | `collector.test.ts` ground truth | |
| EXT-02 numeric table | PASS | rows/caption exact | |
| EXT-03 caption/credit, 2 images | PASS | credit + og:image + body image, rights=review | |
| EXT-04 continuation | PASS | rel=next + "(Còn tiếp)" → partial | Pages not auto-merged |
| EXT-05 posted vs updated | PASS | publishedAt used, modifiedAt kept | |
| EXT-06 extractor disagreement | PASS | JSON-LD articleBody mismatch warning | |
| EXT-07 summary changes figure | PARTIAL | Inspector warns on numbers absent from source | No automated UI test |
| LED-01 interrupted run | PASS | abort mid-run → balanced ledger → resume completes | |
| LED-02 rejection reason visible | PASS | every non-ready state has reasonCode; ledger tab + CSV | Override = inspect + include |
| LED-03 retry delta | PARTIAL | `newSinceLast` per source shown | |
| RPT-01..03 template fidelity / PDF parity | **BLOCKED** | Demo renderer only; no LibreOffice | Not a pass |
| OFF-01 offline review/export | PASS (API) | export from stored run without network in server test | |
| SEC-01 SSRF / loopback | PASS | private IP/redirect refused; Host/Origin/token guard tests; listen 127.0.0.1 | |

## Latest verified commands
```text
npx tsc -p tsconfig.json --noEmit     -> exit 0
npx vitest run                        -> 3 files, 33 tests passed
npx vite build                        -> built OK
npm run spike                         -> 5/5 direct sources reachable, 10/10 sample extractions verified date
scripts/live-run.ps1                  -> 1227 candidates, 1227 accounted, completeness=incomplete (VnExpress fetch limit)
```

## Real source checks
See `docs/SOURCE_SUPPORT.md`.

## PPTX/PDF verification
- Demo PPTX generated (valid ZIP, downloaded via API in test). Not rendered/inspected visually (no renderer). Original template `reference-report.pptx` not yet used.

## Release recommendation
NOT READY for production: template fidelity (M5) and UI automation (M1/M6) outstanding.
