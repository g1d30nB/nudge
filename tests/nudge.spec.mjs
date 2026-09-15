// nudge v1 suite. One test per GOOD check in CONTRACT.md.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const NUDGE = path.join(ROOT, 'nudge.js');
const ORIGIN = 'https://nudge.test'; // https so navigator.clipboard exists; page.route fulfils before the network
const FIXTURE = `${ORIGIN}/fixture.html`;

const FOOTER = {
  apply: 'Apply these in source CSS and markup, in the files named above where given. Do not add inline styles.',
  aligned: 'A move that aligns with another element is a layout intent: express it with align-self, margin auto, grid placement or similar, never a transform or absolute offset.',
  spacing: 'A move with no alignment is a spacing intent: adjust margin or gap.',
  widths: 'Widths were measured at this viewport; keep them responsive (max-width or percentage) unless a fixed width is clearly correct.',
  removals: 'Removals delete the element from the markup.',
};

const TAGLINE = '[data-test=tagline]';
const FIG = '[data-test=fig]';
const TARGET = '[data-test=target]';

/* ───────────── harness ───────────── */

let errors = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/fixture.html') return route.fulfill({ contentType: 'text/html', body: await readFile(path.join(here, 'fixture.html'), 'utf8') });
    if (p === '/nudge.js') return route.fulfill({ contentType: 'text/javascript', body: await readFile(NUDGE, 'utf8') });
    if (p === '/elsewhere') return route.fulfill({ contentType: 'text/html', body: '<title>elsewhere</title><p>navigated</p>' });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(FIXTURE);
});

test.afterEach(() => {
  expect(errors, 'console.error / pageerror during test').toEqual([]);
});

/* ───────────── helpers ───────────── */

const inject = (page) => page.addScriptTag({ url: `${ORIGIN}/nudge.js?t=${Date.now()}` });

const rect = (page, sel) => page.evaluate((s) => {
  const b = document.querySelector(s).getBoundingClientRect();
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
}, sel);

const changes = (page) => page.evaluate(() => window.__nudge._state.changes.map((r) => ({
  test: r.el.getAttribute('data-test') || r.el.id || r.el.tagName.toLowerCase(),
  dx: r.dx, dy: r.dy, w: r.w, h: r.h, removed: r.removed, snaps: r.snaps,
})));

const report = (page) => page.evaluate(() => window.__nudge.report());

const selectedIs = (page, sel) => page.evaluate((s) => window.__nudge._state.selected === (s ? document.querySelector(s) : null), sel);

const guidesVisible = (page) => page.evaluate(() => {
  const { guideH, guideV } = window.__nudge._state.els;
  return guideH.style.display !== 'none' || guideV.style.display !== 'none';
});

const cssText = (page, sel) => page.evaluate((s) => document.querySelector(s).style.cssText, sel);
const computed = (page, sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);

// Scroll the element into view first if it is not fully visible, as a user would.
async function into(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s), b = el.getBoundingClientRect();
    if (b.top < 0 || b.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
  }, sel);
}

async function select(page, sel, offset) {
  await into(page, sel);
  const b = await rect(page, sel);
  const x = offset ? b.left + offset[0] : b.cx;
  const y = offset ? b.top + offset[1] : b.cy;
  await page.mouse.click(x, y);
}

// The figure has 6px padding so a click in its corner lands on the figure, not the img.
const selectFig = (page) => select(page, FIG, [3, 3]);

async function drag(page, from, to, { steps = 20, shift = false } = {}) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

async function resizeE(page, sel, dx) {
  const b = await rect(page, sel);
  await drag(page, [b.right, b.cy], [b.right + dx, b.cy]);
}

const scrollWorkIntoView = (page) => page.evaluate(() => document.querySelector('#work').scrollIntoView());

/* ───────────── checks ───────────── */

test('1 syntax: node --check nudge.js exits 0', () => {
  execFileSync('node', ['--check', NUDGE]);
});

test('2 toggle: second inject destroys, tool DOM removed', async ({ page }) => {
  await inject(page);
  expect(await page.evaluate(() => typeof window.__nudge)).toBe('object');
  expect(await page.locator('[data-nudge]').count()).toBeGreaterThan(0);
  await inject(page);
  expect(await page.evaluate(() => typeof window.__nudge)).toBe('undefined');
  expect(await page.locator('[data-nudge]').count()).toBe(0);
});

test('3 no console errors across load, inject, interact', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 40);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('4 resize: E handle +300px on the tagline', async ({ page }) => {
  await inject(page);
  const base = await rect(page, TAGLINE);
  expect(base.width).toBe(540);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 300);
  const [c] = await changes(page);
  expect(c.test).toBe('tagline');
  expect(Math.abs(c.w - (base.width + 300))).toBeLessThanOrEqual(2);
  expect(parseFloat(await computed(page, TAGLINE, 'width'))).toBeCloseTo(c.w, 0);
  expect(await report(page)).toContain('width 540px → 840px (was capped by max-width: 540px)');
});

test('5 move + snap: figure bottom aligns with paragraph bottom', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await selectFig(page);
  const f = await rect(page, FIG), p = await rect(page, TARGET);
  const dy = p.bottom - f.bottom - 3;
  expect(dy).toBeGreaterThan(20);
  await drag(page, [f.cx, f.cy], [f.cx, f.cy + dy]);
  const f2 = await rect(page, FIG), p2 = await rect(page, TARGET);
  expect(Math.abs(f2.bottom - p2.bottom)).toBeLessThanOrEqual(1);
  const text = await report(page);
  expect(text).toMatch(/bottom edge aligned with bottom edge of section#work > div\.case-block > p .*"Our largest programme/);
});

test('6 no false snap: shift held disables guides and alignment', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await selectFig(page);
  const f = await rect(page, FIG), p = await rect(page, TARGET);
  const dy = p.bottom - f.bottom - 3;
  await page.keyboard.down('Shift');
  await page.mouse.move(f.cx, f.cy);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(f.cx, f.cy + (dy * i) / steps);
    expect(await guidesVisible(page), `guide visible at step ${i}`).toBe(false);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const f2 = await rect(page, FIG), p2 = await rect(page, TARGET);
  expect(Math.abs(f2.bottom - p2.bottom)).toBeCloseTo(3, 0);
  expect(await report(page)).not.toContain('aligned with');
});

test('7 remove: Backspace hides the element and reports removal', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await selectFig(page);
  await page.keyboard.press('Backspace');
  expect(await computed(page, FIG, 'display')).toBe('none');
  expect(await report(page)).toContain('remove this element from the markup');
});

test('8 arrow nudge: 1px per press, 10px with shift', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect((await changes(page))[0].dy).toBe(3);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await changes(page))[0].dx).toBe(10);
});

test('9 undo: row undo restores cssText and removes the row', async ({ page }) => {
  await inject(page);
  const before = await cssText(page, TAGLINE);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  const rows = page.locator('#nudge-list button');
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await expect(rows).toHaveCount(1);
  expect(await cssText(page, TAGLINE)).toBe(before);
});

test('10 reset: three changes restored, list empty', async ({ page }) => {
  await inject(page);
  const orig = {
    tagline: await cssText(page, TAGLINE),
    rotated: await cssText(page, '#rotated'),
    fig: await cssText(page, FIG),
  };
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  await scrollWorkIntoView(page);
  await selectFig(page);
  await page.keyboard.press('Backspace');
  expect(await changes(page)).toHaveLength(3);
  await page.locator('#nudge-reset').click();
  expect(await changes(page)).toHaveLength(0);
  expect(await cssText(page, TAGLINE)).toBe(orig.tagline);
  expect(await cssText(page, '#rotated')).toBe(orig.rotated);
  expect(await cssText(page, FIG)).toBe(orig.fig);
  await expect(page.locator('#nudge-list')).toHaveText('No changes yet.');
});

test('11 tool DOM excluded from selection and snap candidates', async ({ page }) => {
  await inject(page);
  const panel = await page.evaluate(() => { const b = window.__nudge._state.els.panel.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 18 }; });
  await page.mouse.move(panel.x, panel.y);
  await page.mouse.down();
  await page.mouse.up();
  expect(await selectedIs(page, null)).toBe(true);

  await select(page, TAGLINE);
  const handle = await page.evaluate(() => { const b = window.__nudge._state.els.selBox.querySelector('[data-handle=e]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.up();
  expect(await selectedIs(page, TAGLINE)).toBe(true);
  expect(await page.evaluate(() => !!window.__nudge._state.selected.closest('[data-nudge]'))).toBe(false);

  await page.keyboard.press('ArrowDown');
  const cand = await page.evaluate(() => {
    const c = window.__nudge._state.candidates;
    return { n: c.length, tool: c.filter((x) => x.el.closest('[data-nudge]')).length };
  });
  expect(cand.n).toBeGreaterThan(0);
  expect(cand.tool).toBe(0);
});

test('12 navigation blocked: clicking a link does not leave the page', async ({ page }) => {
  await inject(page);
  await page.locator('#link').click();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(FIXTURE);
});

test('13 scroll: below-fold resize is correct and selection box tracks', async ({ page }) => {
  await inject(page);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(400);
  const base = await rect(page, '#below');
  expect(base.top).toBeGreaterThan(0);
  expect(base.bottom).toBeLessThan(812);
  await select(page, '#below');
  await resizeE(page, '#below', 100);
  const [c] = await changes(page);
  expect(c.test).toBe('below');
  expect(Math.abs(c.w - (base.width + 100))).toBeLessThanOrEqual(2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(600);
  const tracked = await page.evaluate(() => {
    const el = document.querySelector('#below').getBoundingClientRect();
    const box = window.__nudge._state.els.selBox.getBoundingClientRect();
    return { visible: window.__nudge._state.els.selBox.style.display !== 'none', dl: Math.abs(el.left - box.left), dt: Math.abs(el.top - box.top), dw: Math.abs(el.width - box.width), dh: Math.abs(el.height - box.height) };
  });
  expect(tracked.visible).toBe(true);
  expect(tracked.dl).toBeLessThanOrEqual(1);
  expect(tracked.dt).toBeLessThanOrEqual(1);
  expect(tracked.dw).toBeLessThanOrEqual(1);
  expect(tracked.dh).toBeLessThanOrEqual(1);
});

test('14 existing transform: rotation preserved through a move, undo restores', async ({ page }) => {
  const before = await computed(page, '#rotated', 'transform');
  expect(before).toMatch(/^matrix\(/);
  await inject(page);
  await select(page, '#rotated');
  const r = await rect(page, '#rotated');
  await drag(page, [r.cx, r.cy], [r.cx, r.cy + 50], { shift: true });
  const after = await computed(page, '#rotated', 'transform');
  const m = after.match(/^matrix\(([^)]+)\)$/);
  expect(m, after).not.toBeNull();
  const [a, b, , , e, f] = m[1].split(',').map(Number);
  expect(b).toBeGreaterThan(0.04);          // sin(3°) ≈ 0.052: rotation still present
  expect(Math.abs(f - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(e)).toBeLessThanOrEqual(1);
  await page.locator('#nudge-list button').first().click();
  expect(await cssText(page, '#rotated')).toBe('');
  expect(await computed(page, '#rotated', 'transform')).toBe(before);
});

test('15 escape clears selection', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  expect(await selectedIs(page, TAGLINE)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await selectedIs(page, null)).toBe(true);
  expect(await page.evaluate(() => window.__nudge._state.els.selBox.style.display)).toBe('none');
});

test('16 copy: clipboard equals report(), button reads Copied', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-13T10:41:00Z'));
  await inject(page);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await page.locator('#nudge-copy').click();
  await expect(page.locator('#nudge-copy')).toHaveText('Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(await report(page));
});

test('17 astro source attributes appear in the report line', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  expect(await report(page)).toContain('(src/pages/index.astro:46:13)');
});

// The footer is everything after the last blank line of the report.
const footerOf = (text) => text.slice(text.lastIndexOf('\n\n') + 2).split('\n');

test('18 report footer: only the instruction lines the batch needs', async ({ page }) => {
  await inject(page);
  const reset = () => page.locator('#nudge-reset').click();

  // resize only
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, FOOTER.widths]);
  await reset();

  // move with no alignment (Shift at release records none)
  await select(page, '#rotated');
  const rr = await rect(page, '#rotated');
  await drag(page, [rr.cx, rr.cy], [rr.cx, rr.cy + 30], { shift: true });
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, FOOTER.spacing]);
  await reset();

  // removal only
  await select(page, '#rotated');
  await page.keyboard.press('Backspace');
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, FOOTER.removals]);
  await reset();

  // aligned move, then everything together, in order
  await scrollWorkIntoView(page);
  await selectFig(page);
  const f = await rect(page, FIG), p = await rect(page, TARGET);
  await drag(page, [f.cx, f.cy], [f.cx, f.cy + (p.bottom - f.bottom - 3)]);
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, FOOTER.aligned]);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 60);
  await select(page, '#rotated');
  const rr2 = await rect(page, '#rotated');
  await drag(page, [rr2.cx, rr2.cy], [rr2.cx, rr2.cy + 30], { shift: true });
  await select(page, '#below');
  await page.keyboard.press('Backspace');
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, FOOTER.aligned, FOOTER.spacing, FOOTER.widths, FOOTER.removals]);
});

/* ───────────── resize snapping (checks 19–21) ───────────── */

const CARD_A = '[data-test=card-a]';
const CARD_B = '[data-test=card-b]';

const matchBoxOver = (page, sel) => page.evaluate((s) => {
  const box = window.__nudge._state.els.matchBox;
  if (box.style.display === 'none') return { visible: false };
  const b = box.getBoundingClientRect(), el = document.querySelector(s).getBoundingClientRect();
  return { visible: true, ok: Math.abs(b.left - el.left) <= 1 && Math.abs(b.top - el.top) <= 1 && Math.abs(b.width - el.width) <= 1 && Math.abs(b.height - el.height) <= 1 };
}, sel);

// Drag the E handle in steps; returns what was visible at the last step before release.
async function resizeEStepped(page, sel, dx, { shift = false, each } = {}) {
  await select(page, sel);
  const b = await rect(page, sel);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(b.right, b.cy);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(b.right + (dx * i) / steps, b.cy);
    if (each) await each(i);
  }
  const last = { guides: await guidesVisible(page), match: await matchBoxOver(page, CARD_B) };
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  return last;
}

test('19 resize edge snap: right edge aligns with another right edge', async ({ page }) => {
  await inject(page);
  await into(page, CARD_A);
  const a = await rect(page, CARD_A), b = await rect(page, CARD_B);
  const last = await resizeEStepped(page, CARD_A, b.right - a.right - 3);
  expect(last.guides).toBe(true);
  const a2 = await rect(page, CARD_A), b2 = await rect(page, CARD_B);
  expect(Math.abs(a2.right - b2.right)).toBeLessThanOrEqual(1);
  const text = await report(page);
  expect(text).toContain('right edge aligned with right edge of section#cards > div.card.card-b');
  expect(text).not.toContain('matches');
});

test('20 resize width match: width snaps to another width, dashed box shown', async ({ page }) => {
  await inject(page);
  await into(page, CARD_A);
  const a = await rect(page, CARD_A), b = await rect(page, CARD_B);
  const last = await resizeEStepped(page, CARD_A, b.width - a.width - 3);
  expect(last.match.visible).toBe(true);
  expect(last.match.ok).toBe(true);
  const a2 = await rect(page, CARD_A), b2 = await rect(page, CARD_B);
  expect(Math.abs(a2.width - b2.width)).toBeLessThanOrEqual(1);
  const text = await report(page);
  expect(text).toMatch(/width matches width of section#cards > div\.card\.card-b .*\(520px\)/);
  expect(text).not.toContain('aligned');
});

test('21 shift disables resize snapping', async ({ page }) => {
  await inject(page);
  await into(page, CARD_A);
  const a = await rect(page, CARD_A), b = await rect(page, CARD_B);
  const dx = b.width - a.width - 3;
  await resizeEStepped(page, CARD_A, dx, {
    shift: true,
    each: async (i) => {
      expect(await guidesVisible(page), `guide at step ${i}`).toBe(false);
      expect((await matchBoxOver(page, CARD_B)).visible, `match box at step ${i}`).toBe(false);
    },
  });
  const a2 = await rect(page, CARD_A);
  expect(a2.width).toBe(a.width + dx);
  const text = await report(page);
  expect(text).not.toContain('aligned');
  expect(text).not.toContain('matches');
});

/* ───────────── aspect ratio lock (checks 22–24) ───────────── */

const LOGO = '[data-test=logo]';   // one image, 320×80, ratio 4:1

async function resizeWith(page, sel, handle, [dx, dy], mod) {
  await select(page, sel);
  const b = await rect(page, sel);
  const from = handle === 'e' ? [b.right, b.cy] : handle === 's' ? [b.cx, b.bottom] : [b.right, b.bottom];
  if (mod) await page.keyboard.down(mod);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + dx, from[1] + dy, { steps: 20 });
  await page.mouse.up();
  if (mod) await page.keyboard.up(mod);
}

test('22 aspect lock: Alt (and Control) keep the ratio on the E handle', async ({ page }) => {
  await inject(page);
  await into(page, LOGO);
  const b = await rect(page, LOGO);
  expect(b.width / b.height).toBeCloseTo(4, 2);

  await resizeWith(page, LOGO, 'e', [120, 0], 'Alt');
  const b2 = await rect(page, LOGO);
  expect(b2.width).toBeGreaterThan(b.width + 80);
  expect(b2.width / b2.height).toBeCloseTo(4, 1);
  const text = await report(page);
  expect(text).toMatch(/aspect ratio kept, scaled to \d+%/);
  expect(text).not.toContain('distorts');

  await page.locator('#nudge-reset').click();
  await resizeWith(page, LOGO, 'e', [120, 0], 'Control');
  const b3 = await rect(page, LOGO);
  expect(b3.width / b3.height).toBeCloseTo(4, 1);
});

test('23 aspect lock: corner handle follows the dominant axis', async ({ page }) => {
  await inject(page);
  await into(page, LOGO);
  const b = await rect(page, LOGO);
  await resizeWith(page, LOGO, 'se', [160, 10], 'Alt');
  const b2 = await rect(page, LOGO);
  expect(b2.width).toBeGreaterThan(b.width + 100);
  expect(b2.width / b2.height).toBeCloseTo(4, 1);
});

test('24 unmodified resize of an image reports that it distorts', async ({ page }) => {
  await inject(page);
  await into(page, LOGO);
  const b = await rect(page, LOGO);
  await resizeWith(page, LOGO, 'e', [120, 0], null);
  const b2 = await rect(page, LOGO);
  expect(b2.height).toBeCloseTo(b.height, 0);
  expect(b2.width / b2.height).toBeGreaterThan(4.2);
  const text = await report(page);
  expect(text).toMatch(/aspect ratio changed from 4\.00:1 to \d\.\d\d:1; this distorts the image/);
  expect(text).not.toContain('aspect ratio kept');
});

/* ───────────── sent state, reloads, computed values (checks 25–29) ───────────── */

const SENT = 'Sent. Clear the preview once your agent has applied it.';
const FRESH = 'Cleared the sent preview for this element; this change starts from the live page.';
const RELOAD = 'The page reloaded. Clear the preview to see the real result.';
const tick = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 60)));
const status = (page) => page.locator('#nudge-status');

async function copyAndSettle(page) {
  await page.locator('#nudge-copy').click();
  await expect(page.locator('#nudge-copy')).toHaveText('Copied');
  await expect(page.locator('#nudge-copy')).toHaveText('Clear preview');
}

test('25 copy marks changes as sent, does not revert, Clear preview reverts', async ({ page }) => {
  await inject(page);
  const before = await cssText(page, TAGLINE);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  const previewCss = await cssText(page, TAGLINE);
  expect(previewCss).not.toBe(before);

  await page.locator('#nudge-copy').click();
  await expect(page.locator('#nudge-copy')).toHaveText('Copied');
  await page.locator('#nudge-copy').click({ force: true });          // double-click guard: ignored while "Copied"
  expect(await cssText(page, TAGLINE)).toBe(previewCss);
  await expect(page.locator('#nudge-copy')).toHaveText('Clear preview');

  await expect(status(page)).toHaveText(SENT);
  expect(await cssText(page, TAGLINE)).toBe(previewCss);             // not reverted on copy
  const row = page.locator('#nudge-list [data-sent]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('✓');
  expect(parseFloat(await row.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  await expect(page.locator('#nudge-recopy')).toBeVisible();

  await page.locator('#nudge-copy').click();                          // Clear preview
  expect(await cssText(page, TAGLINE)).toBe(before);
  await expect(page.locator('#nudge-list')).toHaveText('No changes yet.');
  await expect(page.locator('#nudge-recopy')).toBeHidden();
  await expect(page.locator('#nudge-copy')).toHaveText('Copy for Claude Code');
});

test('26 re-copy puts the sent batch on the clipboard again; new changes copy on their own', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-15T09:00:00Z'));
  await inject(page);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await copyAndSettle(page);
  const first = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => navigator.clipboard.writeText('paste failed'));
  await page.locator('#nudge-recopy').click();
  await expect(status(page)).toContainText('Copied again');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // A new change after sending makes Copy primary again, and copies only the new change.
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#nudge-copy')).toHaveText('Copy for Claude Code');
  await copyAndSettle(page);
  const second = await page.evaluate(() => navigator.clipboard.readText());
  expect(second).toContain('div#rotated');
  expect(second).not.toContain('p.tagline');
});

test('27 editing a sent element starts a fresh record from the live page', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await selectFig(page);
  let f = await rect(page, FIG);
  await drag(page, [f.cx, f.cy], [f.cx, f.cy + 40], { shift: true });
  expect((await changes(page))[0].dy).toBe(40);
  await copyAndSettle(page);

  // A click without movement leaves the sent preview alone.
  f = await rect(page, FIG);
  await page.mouse.move(f.cx, f.cy); await page.mouse.down(); await page.mouse.up();
  expect((await changes(page))[0]).toMatchObject({ dy: 40 });
  expect(await page.evaluate(() => window.__nudge._state.changes[0].sent)).toBe(true);

  // A real drag clears the sent change and records only the new movement.
  f = await rect(page, FIG);
  await drag(page, [f.cx, f.cy], [f.cx, f.cy + 20], { shift: true });
  const recs = await page.evaluate(() => window.__nudge._state.changes.map((r) => ({ dy: r.dy, sent: r.sent })));
  expect(recs).toEqual([{ dy: 20, sent: false }]);
  await expect(status(page)).toContainText(FRESH);
  const m = (await computed(page, FIG, 'transform')).match(/matrix\(([^)]+)\)/);
  expect(Number(m[1].split(',')[5])).toBeCloseTo(20, 0);
  await expect(page.locator('#nudge-copy')).toHaveText('Copy for Claude Code');

  // Keyboard edits on a sent element follow the same rule.
  await copyAndSettle(page);
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => window.__nudge._state.changes.map((r) => ({ dy: r.dy, sent: r.sent })))).toEqual([{ dy: 1, sent: false }]);
  await expect(status(page)).toContainText(FRESH);
});

test('28 stylesheet reload while changes are sent shows a warning and does not clear', async ({ page }) => {
  await inject(page);
  const reload = page.locator('#nudge-reload');
  const replaceStyleText = () => page.evaluate(() => { const s = document.querySelector('head style'); s.textContent = s.textContent + '\n'; });

  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await replaceStyleText();                         // reload before anything is sent: no warning, now or after copying
  await tick(page);
  await expect(reload).toBeHidden();
  await copyAndSettle(page);
  await tick(page);
  await expect(reload).toBeHidden();

  // CSS-in-JS style injection is not a reload.
  await page.evaluate(() => { const s = document.createElement('style'); s.textContent = '.x{}'; document.head.appendChild(s); s.appendChild(document.createTextNode('.y{}')); });
  await tick(page);
  await expect(reload).toBeHidden();

  const preview = await cssText(page, TAGLINE);
  await replaceStyleText();                         // Vite-style CSS hot update
  await expect(reload).toBeVisible();
  await expect(reload).toHaveText(RELOAD);
  expect(await cssText(page, TAGLINE)).toBe(preview);   // not cleared automatically

  await page.locator('#nudge-copy').click();         // Clear preview
  await expect(reload).toBeHidden();

  // webpack/Turbopack-style stylesheet link swap also counts.
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 50);
  await copyAndSettle(page);
  await page.evaluate(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'data:text/css,'; document.head.appendChild(l); });
  await expect(reload).toBeVisible();
});

test('29 a computed max-width is not quoted as an authored rule', async ({ page }) => {
  await inject(page);
  await into(page, '[data-test=fluid]');
  const maxW = await computed(page, '[data-test=fluid]', 'maxWidth');
  expect(maxW).toMatch(/^\d+\.\d+px$/);
  const capped = Math.round(parseFloat(maxW));
  await select(page, '[data-test=fluid]');
  await resizeE(page, '[data-test=fluid]', 100);
  const text = await report(page);
  expect(text).toContain(`width ${capped}px → ${capped + 100}px (the element was capped at ${capped}px by a computed max-width, check the source for the rule)`);
  expect(text).not.toContain('was capped by max-width:');
});

test('30 keyboard shortcuts still work after clicking a panel button', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  await page.keyboard.press('ArrowDown');
  await page.locator('#nudge-list button').first().click();      // undo keeps focus on a panel button
  await select(page, '#rotated');
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__nudge._state.changes.map((r) => r.dx))).toEqual([1]);
  await page.locator('#nudge-reset').click();
  await select(page, '#rotated');
  await page.keyboard.press('Escape');
  expect(await selectedIs(page, null)).toBe(true);
});

/* ───────────── text editing (checks 31–36) ───────────── */

const EDIT = '[data-test=edit]';
const TEXT_FOOTER = 'A text change replaces the old string with the new one wherever that copy lives: markup, a component, a content file or a translation.';
const editingEl = (page) => page.evaluate(() => { const e = window.__nudge._state.editing; return e ? (e.getAttribute('data-test') || e.id) : null; });

// Put the caret at the end of the element being edited. The End key does not do this on macOS.
const caretToEnd = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s); const range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  const g = getSelection(); g.removeAllRanges(); g.addRange(range);
}, sel);

// Double-click the middle of an element's first text run, which is where a person would aim.
async function dblclickText(page, sel) {
  await into(page, sel);
  const p = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const range = document.createRange(); range.selectNodeContents(tn);
    const b = range.getClientRects()[0];
    return { x: b.left + Math.min(b.width / 2, 30), y: b.top + b.height / 2 };
  }, sel);
  await page.mouse.dblclick(p.x, p.y);
}

test('31 double-click edits text in place; Escape commits; the batch reports old and new', async ({ page }) => {
  await inject(page);
  await dblclickText(page, EDIT);
  expect(await editingEl(page)).toBe('edit');
  expect(['plaintext-only', 'true']).toContain(await page.evaluate((s) => document.querySelector(s).contentEditable, EDIT));
  await expect(page.locator('#nudge-status')).toHaveText('Editing text. Escape or click elsewhere to finish.');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Plans people read');
  await page.keyboard.press('Escape');
  expect(await editingEl(page)).toBeNull();
  expect(await page.evaluate((s) => document.querySelector(s).hasAttribute('contenteditable'), EDIT)).toBe(false);
  expect(await page.evaluate((s) => document.querySelector(s).textContent, EDIT)).toBe('Plans people read');
  const text = await report(page);
  expect(text).toContain('text "Plans your team will read" → "Plans people read"');
  expect(footerOf(text)).toEqual([FOOTER.apply, TEXT_FOOTER]);
  await expect(page.locator('#nudge-list')).toContainText('text edited');
});

test('32 an element containing other elements is refused with a reason', async ({ page }) => {
  await inject(page);
  await dblclickText(page, '[data-test=mixed]');
  expect(await editingEl(page)).toBeNull();
  await expect(page.locator('#nudge-status')).toHaveText('Cannot edit text: this element contains other elements (strong); double-click the innermost text instead.');
  expect(await page.evaluate(() => document.querySelector('[data-test=mixed]').hasAttribute('contenteditable'))).toBe(false);
  expect(await changes(page)).toHaveLength(0);
});

test('33 no markup can enter: Enter, formatting shortcuts and rich paste stay plain text', async ({ page }) => {
  await inject(page);
  await dblclickText(page, EDIT);
  await caretToEnd(page, EDIT);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+B');
  await page.keyboard.type(' now');
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const dt = new DataTransfer();
    dt.setData('text/html', '<b>bold</b><div>block</div>');
    dt.setData('text/plain', 'bold\nblock');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, EDIT);
  const state = await page.evaluate((s) => { const el = document.querySelector(s); return { children: el.children.length, text: el.textContent }; }, EDIT);
  expect(state.children).toBe(0);
  expect(state.text).not.toContain('\n');
  expect(state.text).toContain('bold block');
  await page.keyboard.press('Escape');
  expect(await page.evaluate((s) => document.querySelector(s).children.length, EDIT)).toBe(0);
});

test('34 a click elsewhere commits; undo restores the original nodes exactly', async ({ page }) => {
  await inject(page);
  const sel = '[data-test=commented]';
  const before = await page.evaluate((s) => document.querySelector(s).innerHTML, sel);
  expect(before).toContain('<!--');
  await dblclickText(page, sel);
  await caretToEnd(page, sel);
  await page.keyboard.type('!');
  await select(page, '#rotated');
  expect(await editingEl(page)).toBeNull();
  expect(await report(page)).toContain('text "Hello world" → "Hello world!"');
  await page.locator('#nudge-list button').first().click();
  expect(await page.evaluate((s) => document.querySelector(s).innerHTML, sel)).toBe(before);
  expect(await changes(page)).toHaveLength(0);
});

test('35 while editing, keys edit the text instead of triggering nudge shortcuts', async ({ page }) => {
  await inject(page);
  await dblclickText(page, EDIT);
  await caretToEnd(page, EDIT);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await computed(page, EDIT, 'display')).not.toBe('none');
  expect(await editingEl(page)).toBe('edit');
  await page.keyboard.press('Escape');
  const [c] = await changes(page);
  expect(c).toMatchObject({ dx: 0, dy: 0, removed: false });
  expect(await page.evaluate((s) => document.querySelector(s).textContent, EDIT)).toBe('Plans your team will rea');
  // After committing, shortcuts work again.
  await page.keyboard.press('ArrowDown');
  expect((await changes(page))[0].dy).toBe(1);
});

test('36 a change hidden by head-and-tail truncation is shown around the difference', async ({ page }) => {
  await inject(page);
  const sel = '[data-test=long]';
  await dblclickText(page, sel);
  await page.evaluate((s) => {
    const tn = document.querySelector(s).firstChild;
    const i = tn.textContent.indexOf('middle');
    const range = document.createRange(); range.setStart(tn, i); range.setEnd(tn, i + 'middle'.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }, sel);
  await page.keyboard.type('centre');
  await page.keyboard.press('Escape');
  const line = (await report(page)).split('\n').find((l) => l.includes('text "'));
  const m = line.match(/text "(.*)" → "(.*)"$/);
  expect(m).not.toBeNull();
  expect(m[1]).not.toBe(m[2]);
  expect(m[1]).toContain('middle');
  expect(m[2]).toContain('centre');
  expect(m[1].length).toBeLessThanOrEqual(53);
});
