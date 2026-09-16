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

  // A click without movement leaves the sent preview alone. (On the figure's padding: since v1.2.1 a click
  // inside the selection selects the element under the pointer, and the centre is the img.)
  f = await rect(page, FIG);
  await page.mouse.move(f.left + 3, f.top + 3); await page.mouse.down(); await page.mouse.up();
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

/* ───────────── type controls (checks 37–42) ───────────── */

const TYPE_T = '[data-test=type]';
const TYPE_FOOTER = "A type change that matches another element should share that element's type style or token rather than repeat the value; an unmatched value may need a new step in the type scale.";
const typeField = (page, key) => page.locator(`#nudge-props input[data-prop="${key}"]`);
const reportLines = async (page) => (await report(page)).split('\n').map((l) => l.trim());

test('37 type controls appear only for a selected element with its own text', async ({ page }) => {
  await inject(page);
  await expect(page.locator('#nudge-type')).toBeHidden();
  await select(page, TYPE_T);
  await expect(page.locator('#nudge-type')).toBeVisible();
  await select(page, '[data-test=logo]');
  await expect(page.locator('#nudge-props')).toBeHidden();
  await select(page, '[data-test=wrapper]', [2, 2]);
  expect(await selectedIs(page, '[data-test=wrapper]')).toBe(true);
  await expect(page.locator('#nudge-props')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nudge-props')).toBeHidden();
});

test('38 controls are populated from computed style', async ({ page }) => {
  await inject(page);
  await select(page, TYPE_T);
  await expect(typeField(page, 'fontSize')).toHaveValue('17');
  await expect(typeField(page, 'lineHeight')).toHaveValue('25.5');   // the fixture body sets line-height 1.5
  await expect(typeField(page, 'letterSpacing')).toHaveValue('normal');
  await expect(typeField(page, 'fontWeight')).toHaveValue('400');
  await select(page, '[data-test=lede]');
  await expect(typeField(page, 'fontSize')).toHaveValue('21');
  await expect(typeField(page, 'lineHeight')).toHaveValue('30');
});

test('39 arrows step font size and snap to another element, which the batch names', async ({ page }) => {
  await inject(page);
  await select(page, TYPE_T);
  await typeField(page, 'fontSize').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
  // 20px is the case-study heading; the next step must leave it rather than stick.
  await expect(typeField(page, 'fontSize')).toHaveValue('20');
  await page.keyboard.press('ArrowUp');
  await expect(typeField(page, 'fontSize')).toHaveValue('21');
  expect(await computed(page, TYPE_T, 'fontSize')).toBe('21px');
  await expect(page.locator('#nudge-type-match')).toHaveText('size matches .type-lede');
  const box = await page.evaluate(() => { const m = window.__nudge._state.els.matchBox; const a = m.getBoundingClientRect(), b = document.querySelector('[data-test=lede]').getBoundingClientRect(); return m.style.display !== 'none' && Math.abs(a.top - b.top) <= 1 && Math.abs(a.width - b.width) <= 1; });
  expect(box).toBe(true);
  expect(await reportLines(page)).toContain('font size 17px → 21px (now matches .type-lede)');
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, TYPE_FOOTER]);
  // Stepping on to a value nobody uses clears the match.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#nudge-type-match')).toBeHidden();
  expect(await reportLines(page)).toContain('font size 17px → 22px');
  // Arrow keys in the field never moved the element.
  expect((await changes(page))[0]).toMatchObject({ dx: 0, dy: 0 });
});

test('40 modifiers: Shift steps 10, Alt steps finely without snapping; each property reports its own line', async ({ page }) => {
  await inject(page);
  await select(page, TYPE_T);
  await typeField(page, 'fontSize').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(typeField(page, 'fontSize')).toHaveValue('27');
  await typeField(page, 'fontSize').press('ArrowUp');
  await expect(typeField(page, 'fontSize')).toHaveValue('28');
  await typeField(page, 'fontSize').press('Alt+ArrowDown');
  await expect(typeField(page, 'fontSize')).toHaveValue('27.9');
  await typeField(page, 'letterSpacing').press('Alt+ArrowUp');
  await expect(typeField(page, 'letterSpacing')).toHaveValue('0.1');
  await typeField(page, 'fontWeight').press('ArrowUp');
  await expect(typeField(page, 'fontWeight')).toHaveValue('500');
  const lines = await reportLines(page);
  expect(lines).toContain('font size 17px → 27.9px');
  expect(lines).toContain('letter spacing normal → 0.1px');
  expect(lines).toContain('weight 400 → 500');
  expect(lines.filter((l) => /^(font size|line height|letter spacing|weight) /.test(l))).toHaveLength(3);
});

test('41 a typed value applies on Enter; undo restores the original inline type', async ({ page }) => {
  await inject(page);
  const before = await cssText(page, TYPE_T);
  await select(page, TYPE_T);
  await typeField(page, 'lineHeight').fill('30');
  await typeField(page, 'lineHeight').press('Enter');
  expect(await computed(page, TYPE_T, 'lineHeight')).toBe('30px');
  expect(await reportLines(page)).toContain('line height 25.5px → 30px, 1.5 → 1.76 × font size (now matches .type-lede)');
  await typeField(page, 'fontWeight').fill('700');
  await typeField(page, 'fontWeight').press('Enter');
  expect(await reportLines(page)).toContain('weight 400 → 700 (now matches .type-title)');
  await page.locator('#nudge-list button').first().click();
  expect(await cssText(page, TYPE_T)).toBe(before);
  expect(await changes(page)).toHaveLength(0);
});

test('42 clicking the page after using a field sends arrows back to moving elements', async ({ page }) => {
  await inject(page);
  await select(page, TYPE_T);
  await typeField(page, 'fontSize').focus();
  await page.keyboard.press('ArrowUp');
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  const recs = await page.evaluate(() => window.__nudge._state.changes.map((r) => ({ id: r.el.id || r.el.dataset.test, dy: r.dy, type: Object.keys(r.type) })));
  expect(recs).toEqual([{ id: 'type', dy: 0, type: ['fontSize'] }, { id: 'rotated', dy: 1, type: [] }]);
  expect(await computed(page, TYPE_T, 'fontSize')).toBe('18px');
});

/* ───────────── token-aware colour (checks 43–48) ───────────── */

const CARD = '[data-test=card]';
const COLOUR_FOOTER = 'A colour change names a design token: use that token. A value with no token is a question for the design system, not an instruction to hard-code it.';
const NO_TOKEN = 'no token matched this value, check whether one should exist';
const chip = (page, key) => page.locator(`#nudge-chips button[data-colour="${key}"]`);
const swatch = (page, name) => page.locator(`#nudge-swatches button[data-token="${name}"]`);

test('43 colour controls appear only where they apply', async ({ page }) => {
  await inject(page);
  await select(page, CARD);
  await expect(page.locator('#nudge-chips button')).toHaveCount(2);
  await select(page, '[data-test=plain]');
  await expect(page.locator('#nudge-chips button')).toHaveCount(1);
  await expect(chip(page, 'color')).toBeVisible();
  await select(page, '[data-test=wrapper]', [2, 2]);
  await expect(page.locator('#nudge-props')).toBeHidden();
  await select(page, '[data-test=logo]');
  await expect(page.locator('#nudge-props')).toBeHidden();
});

test('44 the palette is built from colour tokens on :root and marks the current match', async ({ page }) => {
  await inject(page);
  await select(page, CARD);
  await expect(chip(page, 'color')).toContainText('text --ink-muted');
  await expect(chip(page, 'backgroundColor')).toContainText('background --surface-2');
  await expect(page.locator('#nudge-palette')).toBeHidden();
  await chip(page, 'color').click();
  const names = await page.locator('#nudge-swatches button').evaluateAll((els) => els.map((e) => e.dataset.token));
  expect(names.sort()).toEqual(['--accent', '--alias-ink', '--ink', '--ink-muted', '--surface', '--surface-2']);
  await expect(page.locator('#nudge-swatches [data-match]')).toHaveCount(1);
  await expect(swatch(page, '--ink-muted')).toHaveAttribute('data-match', '');
  // The palette comes before the picker.
  const order = await page.evaluate(() => { const s = document.querySelector('#nudge-swatches'), p = document.querySelector('#nudge-picker'); return !!(s.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING); });
  expect(order).toBe(true);
});

test('45 choosing a token previews it as var() and the batch reports token names', async ({ page }) => {
  await inject(page);
  const before = await cssText(page, CARD);
  await select(page, CARD);
  await chip(page, 'color').click();
  await swatch(page, '--ink').click();
  expect(await page.evaluate((s) => document.querySelector(s).style.color, CARD)).toBe('var(--ink)');
  expect(await computed(page, CARD, 'color')).toBe('rgb(31, 33, 36)');
  await chip(page, 'backgroundColor').click();
  await swatch(page, '--surface').click();
  const lines = await reportLines(page);
  expect(lines).toContain('colour var(--ink-muted) → var(--ink)');
  expect(lines).toContain('background colour var(--surface-2) → var(--surface)');
  expect(footerOf(await report(page))).toEqual([FOOTER.apply, COLOUR_FOOTER]);
  await page.locator('#nudge-list button').first().click();
  expect(await cssText(page, CARD)).toBe(before);
});

test('46 tokens sharing a value are all named', async ({ page }) => {
  await inject(page);
  await select(page, '[data-test=ink]');
  await expect(chip(page, 'color')).toContainText('text --ink +1');
  await chip(page, 'color').click();
  await expect(page.locator('#nudge-swatches [data-match]')).toHaveCount(2);
  await swatch(page, '--accent').click();
  expect(await reportLines(page)).toContain('colour var(--ink) or var(--alias-ink) → var(--accent)');
});

test('47 the picker is a fallback: a matching value reports its token, anything else says no token matched', async ({ page }) => {
  await inject(page);
  await select(page, CARD);
  await chip(page, 'color').click();
  await page.locator('#nudge-picker').fill('#3a7bd5');
  expect(await computed(page, CARD, 'color')).toBe('rgb(58, 123, 213)');
  expect(await reportLines(page)).toContain(`colour var(--ink-muted) → #3a7bd5 (${NO_TOKEN})`);
  await page.locator('#nudge-picker').fill('#2f6fed');
  expect(await reportLines(page)).toContain('colour var(--ink-muted) → var(--accent)');
  expect(await page.evaluate((s) => document.querySelector(s).style.color, CARD)).toBe('var(--accent)');
});

test('48 with no custom properties on :root the panel says so and offers the picker with the warning', async ({ page }) => {
  await page.evaluate(() => {
    const sheet = document.styleSheets[0];
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) if (sheet.cssRules[i].selectorText === ':root') sheet.deleteRule(i);
  });
  await inject(page);
  await select(page, '[data-test=plain]');
  await chip(page, 'color').click();
  await expect(page.locator('#nudge-no-tokens')).toHaveText('No custom properties are declared on :root.');
  await expect(page.locator('#nudge-swatches')).toHaveCount(0);
  await expect(page.locator('#nudge-picker')).toBeVisible();
  await expect(page.locator('#nudge-picker-note')).toHaveText('A colour that matches no token is reported as such in the batch.');
  await page.locator('#nudge-picker').fill('#123456');
  expect(await reportLines(page)).toContain(`colour #222222 (no token) → #123456 (${NO_TOKEN})`);
});

/* ───────────── type steppers (check 49) ───────────── */

test('49 stepper arrows appear on hover or focus and step like the arrow keys', async ({ page }) => {
  await inject(page);
  await select(page, TYPE_T);
  const col = page.locator('#nudge-props [data-steppers="fontSize"]');
  const up = col.locator('[data-step="up"]'), down = col.locator('[data-step="down"]');
  await expect(col).toBeHidden();                                  // panel at rest is unchanged
  await typeField(page, 'fontSize').hover();
  await expect(col).toBeVisible();

  // Click steps 1 and snaps like ArrowUp: 17 → 18 → 19 → 20 (heading) → 21 (lede).
  for (let i = 0; i < 4; i++) await up.click();
  await expect(typeField(page, 'fontSize')).toHaveValue('21');
  await expect(page.locator('#nudge-type-match')).toHaveText('size matches .type-lede');
  await up.click({ modifiers: ['Shift'] });
  await expect(typeField(page, 'fontSize')).toHaveValue('31');
  await down.click({ modifiers: ['Alt'] });
  await expect(typeField(page, 'fontSize')).toHaveValue('30.9');

  // Focus stays in a focused field, so the keyboard carries on working.
  await typeField(page, 'fontWeight').focus();
  const wcol = page.locator('#nudge-props [data-steppers="fontWeight"]');
  await expect(wcol).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(wcol).toBeVisible();                                // still shown while focused
  await wcol.locator('[data-step="up"]').click();
  expect(await page.evaluate(() => document.activeElement.dataset.prop)).toBe('fontWeight');
  await page.keyboard.press('ArrowUp');
  await expect(typeField(page, 'fontWeight')).toHaveValue('600');

  // Holding repeats.
  const box = await wcol.locator('[data-step="down"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const w = Number(await typeField(page, 'fontWeight').inputValue());
  expect(w).toBeLessThanOrEqual(300);

  expect((await changes(page))[0]).toMatchObject({ dx: 0, dy: 0 });
});

/* ───────────── batch accuracy (checks 50–51) ───────────── */

test('50 the max-width note appears only when the max-width was holding the width down', async ({ page }) => {
  await inject(page);
  await select(page, '[data-test=roomy]');
  await resizeE(page, '[data-test=roomy]', 100);
  let text = await report(page);
  expect(text).toContain('width 300px → 400px');
  expect(text).not.toContain('capped');

  await page.locator('#nudge-reset').click();
  await select(page, '[data-test=pct]');
  await resizeE(page, '[data-test=pct]', 100);
  text = await report(page);
  expect(text).toContain('width 300px → 400px (was capped by max-width: 50%)');

  // Measuring the cap leaves no trace on the element once undone.
  await page.locator('#nudge-list button').first().click();
  expect(await cssText(page, '[data-test=pct]')).toBe('');
});

test('51 computed font size and letter spacing come with rem and em equivalents', async ({ page }) => {
  await inject(page);
  const EM = '[data-test=em]';
  await select(page, EM);
  await expect(typeField(page, 'fontSize')).toHaveValue('32');
  await expect(typeField(page, 'letterSpacing')).toHaveValue('-1.12');
  await typeField(page, 'letterSpacing').press('ArrowUp');
  let lines = await reportLines(page);
  expect(lines).toContain('letter spacing -1.12px → -0.12px');
  expect(lines).toContain('as em of the font size: -0.035em → -0.0038em');   // -0.12 / 32, rounded to 4 places
  await typeField(page, 'fontSize').press('ArrowUp');
  lines = await reportLines(page);
  const i = lines.indexOf('font size 32px → 33px');
  expect(i).toBeGreaterThan(-1);
  expect(lines[i + 1]).toBe('as rem at a 16px root: 2rem → 2.0625rem');
  // Letter spacing in em is now measured against the new font size.
  expect(lines).toContain('as em of the font size: -0.035em → -0.0036em');
  expect(lines.indexOf('letter spacing -1.12px → -0.12px')).toBeGreaterThan(i + 1);
});

/* ───────────── dormant mode, the dot, the hostname guard (checks 52–60) ───────────── */

const LOCAL = 'http://localhost:4173';

// Serve the fixture from any origin with the dormant script tag in <head> or at the end of <body>.
async function serveDormant(page, origin, place = 'body') {
  await page.route(`${origin}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/nudge.js') return route.fulfill({ contentType: 'text/javascript', body: await readFile(NUDGE, 'utf8') });
    if (p === '/elsewhere') return route.fulfill({ contentType: 'text/html', body: '<title>elsewhere</title><p>navigated</p>' });
    let html = await readFile(path.join(here, 'fixture.html'), 'utf8');
    const tag = `<script src="${origin}/nudge.js" data-nudge-dormant></script>`;
    html = place === 'head' ? html.replace('<style>', tag + '\n<style>') : html.replace('</body>', tag + '\n</body>');
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto(`${origin}/fixture.html`);
}

const dotEl = (page) => page.locator('[data-nudge-dot]');
const mode = (page) => page.evaluate(() => (window.__nudge ? { mode: window.__nudge._state.mode, awake: window.__nudge._state.awake } : null));
const panelVisible = (page) => page.evaluate(() => { const p = window.__nudge && window.__nudge._state.els.panel; return !!p && p.isConnected && getComputedStyle(p).display !== 'none'; });
const dotRect = (page) => page.evaluate(() => { const d = document.querySelector('[data-nudge-dot]'); if (!d || d.hidden) return null; const b = d.getBoundingClientRect(); return { left: b.left, bottom: b.bottom, width: b.width, height: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2, vh: innerHeight, vw: innerWidth }; });

test('52 dormant load: a dot, not a panel; the page behaves normally until the dot is clicked', async ({ page }) => {
  await serveDormant(page, LOCAL, 'body');
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  expect(await panelVisible(page)).toBe(false);
  const d = await dotRect(page);
  expect(d.width).toBe(10);
  expect(d.left).toBe(14);
  expect(d.vh - d.bottom).toBe(14);
  await expect(dotEl(page)).toHaveAttribute('title', 'nudge');

  // Asleep, nudge does not capture the page: links navigate.
  await page.locator('#link').click();
  await page.waitForURL('**/elsewhere');
  await page.goto(`${LOCAL}/fixture.html`);
  await expect(dotEl(page)).toBeVisible();

  // Click the dot: the panel opens exactly as the bookmarklet's does, and a gesture works.
  await dotEl(page).click();
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: true });
  expect(await panelVisible(page)).toBe(true);
  await expect(dotEl(page)).toBeHidden();
  const before = await cssText(page, TAGLINE);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  expect(await report(page)).toContain('width 540px → 640px');

  // Close: back to the dot, previews discarded, page free again.
  await page.locator('#nudge-close').click();
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  expect(await panelVisible(page)).toBe(false);
  await expect(dotEl(page)).toBeVisible();
  expect(await cssText(page, TAGLINE)).toBe(before);
  await page.locator('#link').click();
  await page.waitForURL('**/elsewhere');
});

test('53 the bookmarklet toggles a dormant instance; loading the file twice does nothing', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await page.addScriptTag({ url: `${LOCAL}/nudge.js?bm=1` });          // bookmarklet: no attribute
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: true });
  expect(await panelVisible(page)).toBe(true);
  await page.addScriptTag({ url: `${LOCAL}/nudge.js?bm=2` });
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  await expect(dotEl(page)).toBeVisible();
  await expect(dotEl(page)).toHaveCount(1);
  await page.evaluate((u) => new Promise((r) => { const s = document.createElement('script'); s.src = u; s.setAttribute('data-nudge-dormant', ''); s.onload = r; document.head.appendChild(s); }), `${LOCAL}/nudge.js?again=1`);
  await expect(dotEl(page)).toHaveCount(1);
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
});

test('54 hostname guard: the script tag refuses to run off a local host; the bookmarklet is unaffected', async ({ page }) => {
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  await serveDormant(page, ORIGIN);                                   // https://nudge.test
  expect(await page.evaluate(() => typeof window.__nudge)).toBe('undefined');
  await expect(dotEl(page)).toHaveCount(0);
  expect(await page.locator('[data-nudge]').count()).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('nudge: not running on "nudge.test"');
  await inject(page);                                                   // bookmarklet path on the same host
  expect(await mode(page)).toEqual({ mode: 'bookmarklet', awake: true });
  await expect(dotEl(page)).toHaveCount(0);

  for (const origin of ['http://app.local', 'http://127.0.0.1:4173']) {
    await serveDormant(page, origin);
    expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
    await expect(dotEl(page)).toBeVisible();
  }
  expect(warnings).toHaveLength(1);
});

test('55 a script tag in <head>, before <body> exists, still ends up as a dot', async ({ page }) => {
  await serveDormant(page, LOCAL, 'head');
  await expect(dotEl(page)).toBeVisible();
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  await dotEl(page).click();
  expect(await panelVisible(page)).toBe(true);
  await expect(page.locator('#nudge-list')).toHaveText('No changes yet.');
});

test('56 the dot and panel sit above a page overlay at the maximum z-index and outside transformed ancestors', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await page.evaluate(() => { document.querySelector('#modal').hidden = false; });
  let d = await dotRect(page);
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).hasAttribute('data-nudge-dot'), [d.cx, d.cy])).toBe(true);
  await dotEl(page).click();
  const b = await page.locator('#nudge-copy').boundingBox();
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).id, [b.x + b.width / 2, b.y + b.height / 2])).toBe('nudge-copy');
  await page.locator('#nudge-close').click();
  await page.evaluate(() => { document.querySelector('#modal').hidden = true; document.body.style.transform = 'translateZ(0)'; document.body.style.filter = 'contrast(1)'; });
  d = await dotRect(page);
  expect(d.left).toBe(14);
  expect(d.vh - d.bottom).toBe(14);
});

test('57 narrow viewport: the dot is reachable and the panel stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 });
  await serveDormant(page, LOCAL);
  const d = await dotRect(page);
  expect(d.left).toBeGreaterThanOrEqual(0);
  expect(d.bottom).toBeLessThanOrEqual(700);
  await dotEl(page).click();
  const p = await page.evaluate(() => { const b = window.__nudge._state.els.panel.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; });
  expect(p.left).toBeGreaterThanOrEqual(0);
  expect(p.right).toBeLessThanOrEqual(380);
  expect(p.top).toBeGreaterThanOrEqual(0);
  expect(p.bottom).toBeLessThanOrEqual(700);
});

test('58 Option-click hides the dot until the page reloads', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await dotEl(page).click({ modifiers: ['Alt'] });
  await expect(dotEl(page)).toBeHidden();
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  await page.addScriptTag({ url: `${LOCAL}/nudge.js?bm=1` });          // the bookmarklet still opens it
  expect(await panelVisible(page)).toBe(true);
  await page.locator('#nudge-close').click();
  await expect(dotEl(page)).toBeHidden();                              // stays hidden after closing
  await page.reload();
  await expect(dotEl(page)).toBeVisible();
});

test('59 a client-side route change keeps the dot and drops records on removed elements', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await dotEl(page).click();
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  expect(await changes(page)).toHaveLength(1);
  await page.evaluate(() => { history.pushState({}, '', '/about'); document.body.innerHTML = '<main><h1 id="about">About</h1></main>'; });
  await page.waitForTimeout(400);
  expect(await changes(page)).toHaveLength(0);
  expect(await selectedIs(page, null)).toBe(true);
  expect(await panelVisible(page)).toBe(true);
  await expect(page.locator('#nudge-list')).toHaveText('No changes yet.');
  await select(page, '#about');
  expect(await selectedIs(page, '#about')).toBe(true);
  // Removing nudge's nodes from <html>, as a framework swapping the whole document might, brings them back.
  await page.locator('#nudge-close').click();
  await page.evaluate(() => document.querySelectorAll('[data-nudge]').forEach((n) => n.parentNode === document.documentElement && n.remove()));
  await page.waitForTimeout(50);
  await expect(dotEl(page)).toHaveCount(1);
  await expect(dotEl(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await page.waitForTimeout(400);
  await expect(dotEl(page)).toHaveCount(1);
});

test('60 the reload warning still fires for a panel opened from the dot', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await dotEl(page).click();
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 100);
  await copyAndSettle(page);
  await page.evaluate(() => { const s = document.querySelector('head style'); s.textContent = s.textContent + '\n'; });
  await expect(page.locator('#nudge-reload')).toBeVisible();
  await page.locator('#nudge-close').click();
  await expect(dotEl(page)).toBeVisible();
  expect(await changes(page)).toHaveLength(0);
});

/* ───────────── collapsible panel (checks 61–62) ───────────── */

const panelH = (page) => page.evaluate(() => Math.round(window.__nudge._state.els.panel.getBoundingClientRect().height));
const collapsed = (page) => page.evaluate(() => window.__nudge._state.collapsed);

test('61 clicking the header collapses the panel to its header and buttons; changes update a badge', async ({ page }) => {
  await inject(page);
  await select(page, TAGLINE);
  await resizeE(page, TAGLINE, 40);
  const open = await panelH(page);
  await expect(page.locator('#nudge-props')).toBeVisible();
  await page.locator('#nudge-head').click();
  expect(await collapsed(page)).toBe(true);
  await expect(page.locator('#nudge-list')).toBeHidden();
  await expect(page.locator('#nudge-props')).toBeHidden();
  await expect(page.locator('#nudge-hint')).toBeHidden();
  await expect(page.locator('#nudge-copy')).toBeVisible();
  await expect(page.locator('#nudge-count')).toHaveText('1');
  expect(await panelH(page)).toBeLessThan(open / 2);
  expect(await panelH(page)).toBeLessThan(110);

  // Working while collapsed keeps it collapsed; the badge counts; selecting text does not reveal the controls.
  await select(page, '#rotated');
  await page.keyboard.press('ArrowDown');
  expect(await collapsed(page)).toBe(true);
  await expect(page.locator('#nudge-count')).toHaveText('2');
  await select(page, TYPE_T);
  await expect(page.locator('#nudge-props')).toBeHidden();
  await expect(page.locator('#nudge-list')).toBeHidden();

  // Copy still works collapsed; the reload warning still shows.
  await copyAndSettle(page);
  await expect(page.locator('#nudge-copy')).toHaveText('Clear preview');
  await page.evaluate(() => { const s = document.querySelector('head style'); s.textContent = s.textContent + '\n'; });
  await expect(page.locator('#nudge-reload')).toBeVisible();

  // Expand: everything comes back, badge goes.
  await page.locator('#nudge-head').click();
  expect(await collapsed(page)).toBe(false);
  await expect(page.locator('#nudge-list')).toBeVisible();
  await expect(page.locator('#nudge-props')).toBeVisible();
  await expect(page.locator('#nudge-count')).toBeHidden();
});

test('62 the close button does not toggle collapse, and the collapsed state survives sleep and wake', async ({ page }) => {
  await serveDormant(page, LOCAL);
  await dotEl(page).click();
  await page.locator('#nudge-head').click();
  expect(await collapsed(page)).toBe(true);
  await page.locator('#nudge-close').click();
  expect(await mode(page)).toEqual({ mode: 'dormant', awake: false });
  await dotEl(page).click();
  expect(await collapsed(page)).toBe(true);
  await expect(page.locator('#nudge-list')).toBeHidden();
  await page.locator('#nudge-head').click();
  expect(await collapsed(page)).toBe(false);
});

/* ───────────── click selects, drag moves; select the parent (checks 63–64) ───────────── */

test('63 inside a selection, a click selects what was clicked and only a drag moves', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await select(page, TARGET);
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selectedIs(page, '#work')).toBe(true);
  // A click on a paragraph inside the selected section selects the paragraph and records nothing.
  const p = await rect(page, TARGET);
  await page.mouse.click(p.cx, p.cy);
  expect(await selectedIs(page, TARGET)).toBe(true);
  expect(await changes(page)).toHaveLength(0);
  // A 2px wobble is still a click.
  await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowUp');
  expect(await selectedIs(page, '#work')).toBe(true);
  await page.mouse.move(p.cx, p.cy); await page.mouse.down(); await page.mouse.move(p.cx + 2, p.cy + 1); await page.mouse.up();
  expect(await selectedIs(page, TARGET)).toBe(true);
  expect(await changes(page)).toHaveLength(0);
  // A real drag from the same spot moves the selected section, not the paragraph.
  await page.keyboard.press('Alt+ArrowUp'); await page.keyboard.press('Alt+ArrowUp');
  await drag(page, [p.cx, p.cy], [p.cx, p.cy + 30], { shift: true });
  expect(await changes(page)).toEqual([expect.objectContaining({ test: 'work', dy: 30 })]);
  expect(await selectedIs(page, '#work')).toBe(true);
});

test('64 Option+ArrowUp selects the parent, Option+ArrowDown comes back down, never body', async ({ page }) => {
  await scrollWorkIntoView(page);
  await inject(page);
  await select(page, TARGET);
  await page.keyboard.press('Alt+ArrowUp');
  expect(await page.evaluate(() => window.__nudge._state.selected.className)).toBe('case-block');
  await expect(page.locator('#nudge-status')).toHaveText('section#work > div.case-block');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selectedIs(page, '#work')).toBe(true);
  await page.keyboard.press('Alt+ArrowUp');                       // parent is body: stays put
  expect(await selectedIs(page, '#work')).toBe(true);
  await expect(page.locator('#nudge-status')).toContainText('already at the top');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await page.evaluate(() => window.__nudge._state.selected.className)).toBe('case-block');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await selectedIs(page, TARGET)).toBe(true);
  await page.keyboard.press('Alt+ArrowDown');                     // nothing below the start
  expect(await selectedIs(page, TARGET)).toBe(true);
  // A plain arrow still nudges, and a fresh click resets the path.
  await page.keyboard.press('ArrowDown');
  expect((await changes(page))[0]).toMatchObject({ test: 'target', dy: 1 });
  await page.keyboard.press('Alt+ArrowUp');
  await select(page, TAGLINE);
  await page.keyboard.press('Alt+ArrowDown');
  expect(await selectedIs(page, TAGLINE)).toBe(true);
});
