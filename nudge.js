/*
  nudge: drag on the running page, hand the intent to Claude Code.

  Loads as a bookmarklet on any localhost dev server. Nothing here writes to
  source; it captures what you did (resize, move, remove), detects what the
  moved thing lined up with, and copies a batch of measurements for the agent.

  Keys: click = select · drag inside selection = move · E/S/SE handles = resize
        arrows = nudge 1px (shift = 10px) · ⌫ = remove · esc = deselect
        hold shift while dragging to disable snapping
*/
(function () {
  'use strict';

  if (window.__nudge) { window.__nudge.destroy(); return; }

  const SNAP = 5;           // px tolerance while dragging
  const RELATE = 1;         // px tolerance when recording relationships
  const Z = 2147483000;

  const state = {
    selected: null,
    changes: new Map(),     // el -> record
    drag: null,
    candidates: [],
  };

  /* ────────────────────────── helpers ────────────────────────── */

  const isTool = (el) => !!(el && el.closest && el.closest('[data-nudge]'));
  const cs = (el) => getComputedStyle(el);
  const rnd = (n) => Math.round(n);
  const px = (n) => rnd(n) + 'px';

  function descriptor(el) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur !== document.body && depth < 3) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) s += '#' + cur.id;
      else {
        const cls = [...cur.classList].filter((c) => !/^(reveal|visible|active|hero-animate)$/.test(c)).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
      }
      parts.unshift(s);
      cur = cur.parentElement; depth++;
    }
    return parts.join(' > ');
  }

  // Astro dev injects these; other stacks fall back to the descriptor alone.
  function source(el) {
    const f = el.getAttribute && el.getAttribute('data-astro-source-file');
    if (!f) return null;
    const l = el.getAttribute('data-astro-source-loc');
    const short = f.replace(/^.*?\/(src\/)/, '$1');
    return short + (l ? ':' + l : '');
  }

  function snippet(el) {
    if (el.tagName === 'IMG') {   // descriptor already ends in "img"
      return el.alt ? `"${el.alt.slice(0, 40)}"` : (el.getAttribute('src') || '').split('/').pop().slice(0, 40);
    }
    const img = el.querySelector && el.querySelector('img');
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t && img) return img.alt ? `contains img "${img.alt.slice(0, 40)}"` : 'contains img';
    if (!t) return '';
    return t.length > 52 ? `"${t.slice(0, 26)}…${t.slice(-22)}"` : `"${t}"`;
  }

  function label(el) {
    const src = source(el);
    return descriptor(el) + (src ? ` (${src})` : '') + (snippet(el) ? ' ' + snippet(el) : '');
  }

  /* ────────────────────────── records ────────────────────────── */

  function rec(el) {
    let r = state.changes.get(el);
    if (r) return r;
    const c = cs(el);
    const rect = el.getBoundingClientRect();
    r = {
      el,
      orig: {
        transform: el.style.transform, width: el.style.width, height: el.style.height,
        maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight,
        display: el.style.display, transition: el.style.transition,
      },
      base: { w: rect.width, h: rect.height, maxW: c.maxWidth, maxH: c.maxHeight, cTransform: c.transform },
      dx: 0, dy: 0, w: null, h: null, removed: false, locked: false, snaps: [],
    };
    el.style.transition = 'none';
    state.changes.set(el, r);
    return r;
  }

  function apply(r) {
    const el = r.el, o = r.orig;
    const baseT = (r.base.cTransform && r.base.cTransform !== 'none') ? ' ' + r.base.cTransform : '';
    el.style.transform = (r.dx || r.dy) ? `translate(${r.dx}px, ${r.dy}px)${baseT}` : o.transform;
    if (r.w != null) { el.style.width = px(r.w); el.style.maxWidth = 'none'; }
    else { el.style.width = o.width; el.style.maxWidth = o.maxWidth; }
    if (r.h != null) { el.style.height = px(r.h); el.style.maxHeight = 'none'; }
    else { el.style.height = o.height; el.style.maxHeight = o.maxHeight; }
    el.style.display = r.removed ? 'none' : o.display;
  }

  // Replaced elements have an intrinsic ratio; changing it stretches the pixels.
  const INTRINSIC = /^(IMG|VIDEO|CANVAS|IFRAME|SVG|PICTURE)$/;

  function ratioNote(r) {
    if (r.w == null && r.h == null) return null;
    const w = r.w != null ? r.w : r.base.w, h = r.h != null ? r.h : r.base.h;
    if (!r.base.w || !r.base.h || !h) return null;
    const before = r.base.w / r.base.h, after = w / h;
    const kept = Math.abs(after - before) / before < 0.01;
    if (r.locked && kept) return `aspect ratio kept, scaled to ${rnd((w / r.base.w) * 100)}% (set one dimension and let the other follow)`;
    if (!kept && INTRINSIC.test(r.el.tagName)) return `aspect ratio changed from ${before.toFixed(2)}:1 to ${after.toFixed(2)}:1; this distorts the image, set one dimension only and let the other follow`;
    return null;
  }

  function isNoop(r) { return !r.dx && !r.dy && r.w == null && r.h == null && !r.removed; }

  function prune(r) {
    if (!isNoop(r)) return;
    r.el.style.transition = r.orig.transition;
    state.changes.delete(r.el);
  }

  function undo(r) {
    const el = r.el, o = r.orig;
    el.style.transform = o.transform; el.style.width = o.width; el.style.height = o.height;
    el.style.maxWidth = o.maxWidth; el.style.maxHeight = o.maxHeight;
    el.style.display = o.display; el.style.transition = o.transition;
    state.changes.delete(el);
  }

  function resetAll() { [...state.changes.values()].forEach(undo); select(null); render(); }

  /* ────────────────────────── snapping ────────────────────────── */

  function collectCandidates(dragged) {
    const out = [], vw = innerWidth, vh = innerHeight;
    document.body.querySelectorAll('*').forEach((el) => {
      if (isTool(el) || el === dragged || dragged.contains(el)) return;
      const st = cs(el);
      if (st.visibility === 'hidden' || st.display === 'contents' || st.display === 'none') return;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > vh || b.right < 0 || b.left > vw) return;
      out.push({ el, l: b.left, r: b.right, t: b.top, b: b.bottom, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2, w: b.width, h: b.height, area: b.width * b.height });
    });
    return out;
  }

  const CROSS = 2;          // px penalty for cross-edge matches (top↔bottom, left↔right)
  const score = (n) => Math.abs(n.d) + (n.same ? 0 : CROSS);
  function better(n, b) {
    if (!b) return true;
    const sn = score(n), sb = score(b);
    if (Math.abs(sn - sb) > 0.01) return sn < sb;
    return n.c.area < b.c.area;   // tie: the smaller, more specific element
  }

  function snap(rect, tol) {
    let bx = null, by = null;
    const cx = (rect.l + rect.r) / 2, cy = (rect.t + rect.b) / 2;
    for (const c of state.candidates) {
      const xs = [
        [rect.l, c.l, 'left', 'left'], [rect.r, c.r, 'right', 'right'],
        [rect.l, c.r, 'left', 'right'], [rect.r, c.l, 'right', 'left'],
        [cx, c.cx, 'centre', 'centre'],
      ];
      for (const [a, b, ea, eb] of xs) {
        const d = b - a;
        const n = { d, at: b, c, ea, eb, same: ea === eb };
        if (Math.abs(d) <= tol && better(n, bx)) bx = n;
      }
      const ys = [
        [rect.t, c.t, 'top', 'top'], [rect.b, c.b, 'bottom', 'bottom'],
        [rect.t, c.b, 'top', 'bottom'], [rect.b, c.t, 'bottom', 'top'],
        [cy, c.cy, 'centre', 'centre'],
      ];
      for (const [a, b, ea, eb] of ys) {
        const d = b - a;
        const n = { d, at: b, c, ea, eb, same: ea === eb };
        if (Math.abs(d) <= tol && better(n, by)) by = n;
      }
    }
    return { x: bx, y: by };
  }

  // Resize on one axis. The moving edge (right or bottom) may snap to a candidate's edge and the
  // size may snap to a candidate's size. The nearer correction is applied; the other survives only
  // if it still holds afterwards, so both can be reported when they genuinely coincide.
  function fitSize(origin, size, axis, tol) {
    const edgeName = axis === 'x' ? 'right' : 'bottom';
    const end = origin + size;
    let edge = null, match = null;
    for (const c of state.candidates) {
      const edges = axis === 'x' ? [[c.l, 'left'], [c.r, 'right']] : [[c.t, 'top'], [c.b, 'bottom']];
      for (const [v, eb] of edges) {
        const n = { d: v - end, at: v, c, ea: edgeName, eb, same: eb === edgeName };
        if (Math.abs(n.d) <= tol && better(n, edge)) edge = n;
      }
      const m = { d: (axis === 'x' ? c.w : c.h) - size, c, same: true };
      if (Math.abs(m.d) <= tol && better(m, match)) match = m;
    }
    let d = 0;
    if (edge && (!match || Math.abs(edge.d) <= Math.abs(match.d))) d = edge.d; else if (match) d = match.d;
    if (edge && Math.abs(edge.d - d) > RELATE) edge = null;
    if (match && Math.abs(match.d - d) > RELATE) match = null;
    return { d, edge, match };
  }

  function sizeRelationships(r) {
    const b = r.el.getBoundingClientRect(), out = [];
    const edgeLine = (f) => `${f.edge.ea} edge aligned with ${f.edge.eb} edge of ${label(f.edge.c.el)}`;
    if (r.w != null) {
      const f = fitSize(b.left, b.width, 'x', RELATE);
      if (f.edge) out.push(edgeLine(f));
      if (f.match) out.push(`width matches width of ${label(f.match.c.el)} (${rnd(f.match.c.w)}px)`);
    }
    if (r.h != null) {
      const f = fitSize(b.top, b.height, 'y', RELATE);
      if (f.edge) out.push(edgeLine(f));
      if (f.match) out.push(`height matches height of ${label(f.match.c.el)} (${rnd(f.match.c.h)}px)`);
    }
    return out;
  }

  function relationships(r) {
    const b = r.el.getBoundingClientRect();
    const s = snap({ l: b.left, r: b.right, t: b.top, b: b.bottom }, RELATE);
    const out = [];
    if (s.x && r.dx) out.push(`${s.x.ea} edge aligned with ${s.x.eb} edge of ${label(s.x.c.el)}`);
    if (s.y && r.dy) out.push(`${s.y.ea} edge aligned with ${s.y.eb} edge of ${label(s.y.c.el)}`);
    return out;
  }

  /* ────────────────────────── overlay ────────────────────────── */

  const overlay = document.createElement('div');
  overlay.setAttribute('data-nudge', '');
  overlay.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font:12px/1.4 -apple-system,system-ui,sans-serif;`;

  const mk = (css) => { const d = document.createElement('div'); d.setAttribute('data-nudge', ''); d.style.cssText = css; overlay.appendChild(d); return d; };
  const hoverBox = mk('position:fixed;display:none;outline:1px dashed #2f6fed;outline-offset:-1px;');
  const selBox   = mk('position:fixed;display:none;outline:2px solid #2f6fed;outline-offset:-2px;');
  const guideH   = mk('position:fixed;display:none;left:0;right:0;height:1px;background:#e0447a;');
  const guideV   = mk('position:fixed;display:none;top:0;bottom:0;width:1px;background:#e0447a;');
  const matchBox = mk('position:fixed;display:none;outline:1px dashed #e0447a;outline-offset:2px;');

  const handles = {};
  for (const h of ['e', 's', 'se']) {
    const d = document.createElement('div');
    d.setAttribute('data-nudge', ''); d.dataset.handle = h;
    d.style.cssText = `position:absolute;width:10px;height:10px;background:#fff;border:2px solid #2f6fed;border-radius:2px;pointer-events:auto;cursor:${h === 'e' ? 'ew' : h === 's' ? 'ns' : 'nwse'}-resize;`;
    selBox.appendChild(d); handles[h] = d;
  }

  function place(box, b) {
    box.style.display = 'block';
    box.style.left = b.left + 'px'; box.style.top = b.top + 'px';
    box.style.width = b.width + 'px'; box.style.height = b.height + 'px';
  }

  function updateBoxes() {
    if (state.selected && document.contains(state.selected)) {
      const b = state.selected.getBoundingClientRect();
      place(selBox, b);
      const pos = (h, x, y) => { h.style.left = x + 'px'; h.style.top = y + 'px'; };
      pos(handles.e, b.width - 5, b.height / 2 - 5);
      pos(handles.s, b.width / 2 - 5, b.height - 5);
      pos(handles.se, b.width - 5, b.height - 5);
    } else selBox.style.display = 'none';
  }

  function showGuides(s) {
    if (s && s.x) { guideV.style.display = 'block'; guideV.style.left = s.x.at + 'px'; } else guideV.style.display = 'none';
    if (s && s.y) { guideH.style.display = 'block'; guideH.style.top = s.y.at + 'px'; } else guideH.style.display = 'none';
    if (s && s.match) place(matchBox, s.match.c.el.getBoundingClientRect());
    else matchBox.style.display = 'none';
  }

  /* ────────────────────────── panel ────────────────────────── */

  const panel = document.createElement('div');
  panel.setAttribute('data-nudge', '');
  panel.style.cssText = `position:fixed;right:16px;bottom:16px;width:360px;max-height:60vh;display:flex;flex-direction:column;
    background:#1c1b19;color:#ece7df;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:${Z + 1};
    font:12px/1.45 -apple-system,system-ui,sans-serif;overflow:hidden;`;
  panel.innerHTML = `
    <div data-nudge style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #2c2a27;">
      <strong style="font-size:13px;letter-spacing:.01em">nudge</strong>
      <span data-nudge id="nudge-status" style="color:#9c958b;flex:1">Click an element to start.</span>
      <button data-nudge id="nudge-close" title="Close (discards uncommitted changes)" style="background:none;border:0;color:#9c958b;font-size:16px;cursor:pointer;line-height:1">×</button>
    </div>
    <div data-nudge id="nudge-list" style="flex:1;overflow:auto;padding:6px 0;"></div>
    <div data-nudge style="padding:10px 14px;display:flex;gap:8px;border-top:1px solid #2c2a27;align-items:center;">
      <button data-nudge id="nudge-copy" style="flex:1;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:8px 10px;font:600 12px system-ui;cursor:pointer">Copy for Claude Code</button>
      <button data-nudge id="nudge-reset" style="background:#2c2a27;color:#ece7df;border:0;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer">Reset</button>
    </div>
    <div data-nudge style="padding:0 14px 10px;color:#6f6a62;font-size:11px">drag to move · handles to resize · ⌫ remove · arrows nudge · shift disables snap · esc deselect</div>`;

  const $ = (id) => panel.querySelector('#' + id);
  const setStatus = (t) => { $('nudge-status').textContent = t; };

  function summary(r) {
    const bits = [];
    if (r.removed) bits.push('remove');
    if (r.w != null) bits.push(`width ${rnd(r.base.w)} → ${rnd(r.w)}px`);
    if (r.h != null) bits.push(`height ${rnd(r.base.h)} → ${rnd(r.h)}px`);
    if (r.locked) bits.push('ratio locked');
    if (r.dx || r.dy) {
      const mv = [];
      if (r.dx) mv.push(`${r.dx > 0 ? 'right' : 'left'} ${Math.abs(rnd(r.dx))}px`);
      if (r.dy) mv.push(`${r.dy > 0 ? 'down' : 'up'} ${Math.abs(rnd(r.dy))}px`);
      bits.push('moved ' + mv.join(', '));
    }
    return bits.join(' · ');
  }

  function render() {
    const list = $('nudge-list');
    list.innerHTML = '';
    const recs = [...state.changes.values()];
    if (!recs.length) {
      list.innerHTML = '<div data-nudge style="padding:10px 14px;color:#6f6a62">No changes yet.</div>';
      return;
    }
    recs.forEach((r, i) => {
      const row = document.createElement('div');
      row.setAttribute('data-nudge', '');
      row.style.cssText = 'padding:8px 14px;display:flex;gap:10px;align-items:flex-start;border-bottom:1px solid #242220;';
      row.innerHTML = `
        <div data-nudge style="color:#6f6a62;width:14px;flex-shrink:0">${i + 1}</div>
        <div data-nudge style="flex:1;min-width:0">
          <div data-nudge style="color:#c9c2b7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${descriptor(r.el)}</div>
          <div data-nudge>${summary(r)}</div>
          ${r.snaps.map((s) => `<div data-nudge style="color:#e0447a">${s}</div>`).join('')}
        </div>
        <button data-nudge style="background:none;border:1px solid #3a3733;color:#9c958b;border-radius:5px;padding:2px 7px;font:11px system-ui;cursor:pointer">undo</button>`;
      row.querySelector('button').addEventListener('click', () => { undo(r); if (state.selected === r.el) updateBoxes(); render(); });
      list.appendChild(row);
    });
  }

  function report() {
    const recs = [...state.changes.values()];
    const lines = [];
    lines.push(`nudge batch · ${location.href} · viewport ${innerWidth}×${innerHeight} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    lines.push('');
    recs.forEach((r, i) => {
      lines.push(`${i + 1}. ${label(r.el)}`);
      if (r.removed) lines.push('   remove this element from the markup');
      if (r.w != null) {
        const cap = r.base.maxW !== 'none' ? ` (was capped by max-width: ${r.base.maxW})` : '';
        lines.push(`   width ${rnd(r.base.w)}px → ${rnd(r.w)}px${cap}`);
      }
      if (r.h != null) lines.push(`   height ${rnd(r.base.h)}px → ${rnd(r.h)}px`);
      const note = ratioNote(r);
      if (note) lines.push(`   ${note}`);
      if (r.dx || r.dy) {
        const mv = [];
        if (r.dx) mv.push(`${r.dx > 0 ? 'right' : 'left'} ${Math.abs(rnd(r.dx))}px`);
        if (r.dy) mv.push(`${r.dy > 0 ? 'down' : 'up'} ${Math.abs(rnd(r.dy))}px`);
        lines.push(`   moved ${mv.join(', ')}`);
      }
      r.snaps.forEach((s) => lines.push(`   ${s}`));
      lines.push('');
    });
    lines.push('Apply these in source CSS and markup, in the files named above where given.');
    lines.push('A move that aligns with another element is a layout intent: express it with align-self, margin auto, grid placement or similar, never a transform or absolute offset.');
    lines.push('A move with no alignment is a spacing intent: adjust margin or gap.');
    lines.push('Widths were measured at this viewport; keep them responsive (max-width or percentage) unless a fixed width is clearly correct.');
    lines.push('Removals delete the element from the markup. Do not add inline styles.');
    return lines.join('\n');
  }

  async function copy() {
    if (!state.changes.size) { setStatus('Nothing to copy yet.'); return; }
    const text = report();
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
    }
    const b = $('nudge-copy'); const old = b.textContent;
    b.textContent = 'Copied'; setStatus(`${state.changes.size} change${state.changes.size > 1 ? 's' : ''} on the clipboard. Paste into Claude Code.`);
    setTimeout(() => { b.textContent = old; }, 1400);
  }

  /* ────────────────────────── selection ────────────────────────── */

  function select(el) {
    state.selected = el;
    updateBoxes();
    if (el) setStatus(descriptor(el));
    else setStatus('Click an element to start.');
  }

  /* ────────────────────────── events ────────────────────────── */

  function onMove(e) {
    if (state.drag) { dragMove(e); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isTool(el) || el === document.body || el === document.documentElement) { hoverBox.style.display = 'none'; return; }
    place(hoverBox, el.getBoundingClientRect());
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const t = e.target;
    if (isTool(t)) {
      if (t.dataset.handle && state.selected) { startResize(e, t.dataset.handle); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) { select(null); return; }
    if (state.selected && (el === state.selected || state.selected.contains(el))) { startMoveDrag(e); return; }
    select(el);
  }

  function onClick(e) { if (!isTool(e.target)) { e.preventDefault(); e.stopPropagation(); } }

  function startMoveDrag(e) {
    const el = state.selected, r = rec(el);
    state.candidates = collectCandidates(el);
    const b = el.getBoundingClientRect();
    state.drag = { kind: 'move', startX: e.clientX, startY: e.clientY, dx0: r.dx, dy0: r.dy, rect: b, r };
    document.body.style.userSelect = 'none';
  }

  function startResize(e, handle) {
    const el = state.selected, r = rec(el);
    const b = el.getBoundingClientRect();
    state.candidates = collectCandidates(el);
    state.drag = { kind: 'resize', handle, startX: e.clientX, startY: e.clientY, w0: b.width, h0: b.height, left: b.left, top: b.top, r };
    document.body.style.userSelect = 'none';
  }

  function dragMove(e) {
    const d = state.drag, r = d.r;
    const ddx = e.clientX - d.startX, ddy = e.clientY - d.startY;
    if (d.kind === 'move') {
      let dx = d.dx0 + ddx, dy = d.dy0 + ddy;
      let s = null;
      if (!e.shiftKey) {
        const sh = dx - d.dx0, sv = dy - d.dy0;
        s = snap({ l: d.rect.left + sh, r: d.rect.right + sh, t: d.rect.top + sv, b: d.rect.bottom + sv }, SNAP);
        if (s.x) dx += s.x.d;
        if (s.y) dy += s.y.d;
      }
      r.dx = rnd(dx); r.dy = rnd(dy); d.shift = e.shiftKey;
      apply(r); showGuides(s); updateBoxes();
      setStatus(summary(r));
    } else {
      const s = { x: null, y: null, match: null };
      d.shift = e.shiftKey;
      // Option is the reliable key on macOS: Control-click is the system secondary click.
      const lock = e.altKey || e.metaKey || e.ctrlKey;
      const ratio = d.h0 > 0 ? d.w0 / d.h0 : 0;
      r.locked = lock && ratio > 0;
      if (r.locked) {
        // One axis drives, the other follows. On the corner the larger movement wins.
        const drive = d.handle === 'se' ? (Math.abs(ddx) >= Math.abs(ddy) ? 'x' : 'y') : (d.handle === 'e' ? 'x' : 'y');
        if (drive === 'x') {
          let w = Math.max(8, d.w0 + ddx);
          if (!e.shiftKey) { const f = fitSize(d.left, w, 'x', SNAP); w += f.d; s.x = f.edge; s.match = f.match; }
          r.w = rnd(w); r.h = rnd(w / ratio);
        } else {
          let h = Math.max(8, d.h0 + ddy);
          if (!e.shiftKey) { const f = fitSize(d.top, h, 'y', SNAP); h += f.d; s.y = f.edge; s.match = f.match; }
          r.h = rnd(h); r.w = rnd(h * ratio);
        }
      } else {
        if (d.handle === 'e' || d.handle === 'se') {
          let w = Math.max(8, d.w0 + ddx);
          if (!e.shiftKey) { const f = fitSize(d.left, w, 'x', SNAP); w += f.d; s.x = f.edge; s.match = f.match; }
          r.w = rnd(w);
        }
        if (d.handle === 's' || d.handle === 'se') {
          let h = Math.max(8, d.h0 + ddy);
          if (!e.shiftKey) { const f = fitSize(d.top, h, 'y', SNAP); h += f.d; s.y = f.edge; s.match = s.match || f.match; }
          r.h = rnd(h);
        }
      }
      apply(r); showGuides(s); updateBoxes();
      setStatus(summary(r));
    }
  }

  function onUp() {
    if (!state.drag) return;
    const { r, shift } = state.drag;
    state.drag = null;
    document.body.style.userSelect = '';
    showGuides(null);
    finish(r, shift);
  }

  function finish(r, exact) {
    if (!exact && !r.removed) state.candidates = collectCandidates(r.el);
    r.snaps = (exact || r.removed) ? [] : [...((r.dx || r.dy) ? relationships(r) : []), ...sizeRelationships(r)];
    prune(r);
    render();
    updateBoxes();
  }

  function onKey(e) {
    if (isTool(e.target) && /INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { select(null); return; }
    if (!state.selected) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const r = rec(state.selected); r.removed = true; apply(r);
      finish(r); select(null); return;
    }
    const step = e.shiftKey ? 10 : 1;
    const map = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    if (map[e.key]) {
      e.preventDefault();
      const r = rec(state.selected);
      state.candidates = collectCandidates(state.selected);
      r.dx += map[e.key][0]; r.dy += map[e.key][1];
      apply(r); finish(r);
      setStatus(summary(r) || descriptor(state.selected));
    }
  }

  function onScroll() { updateBoxes(); hoverBox.style.display = 'none'; }

  function onContext(e) { if (!isTool(e.target)) e.preventDefault(); }

  /* ────────────────────────── mount / destroy ────────────────────────── */

  const opts = { capture: true };
  document.addEventListener('mousemove', onMove, opts);
  document.addEventListener('mousedown', onDown, opts);
  document.addEventListener('mouseup', onUp, opts);
  document.addEventListener('click', onClick, opts);
  document.addEventListener('keydown', onKey, opts);
  document.addEventListener('contextmenu', onContext, opts);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(panel);
  $('nudge-copy').addEventListener('click', copy);
  $('nudge-reset').addEventListener('click', resetAll);
  $('nudge-close').addEventListener('click', () => window.__nudge.destroy());
  render();

  window.__nudge = {
    destroy() {
      resetAll();
      document.removeEventListener('mousemove', onMove, opts);
      document.removeEventListener('mousedown', onDown, opts);
      document.removeEventListener('mouseup', onUp, opts);
      document.removeEventListener('click', onClick, opts);
      document.removeEventListener('keydown', onKey, opts);
      document.removeEventListener('contextmenu', onContext, opts);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      overlay.remove(); panel.remove();
      delete window.__nudge;
    },
    report,
    // Test hook. Read-only view of internal state; no behavioural effect.
    _state: {
      get selected() { return state.selected; },
      get changes() { return [...state.changes.values()]; },
      get candidates() { return state.candidates; },
      get drag() { return state.drag; },
      els: { overlay, panel, selBox, hoverBox, guideH, guideV, matchBox, handles },
    },
  };
})();
