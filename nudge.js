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
    batch: 0,               // number of the most recent copied batch
    reloadSeq: 0,           // bumped each time the page's stylesheets reload
    notice: null,           // status prefix while re-recording a sent element
    copyLock: false,        // brief lock after Copy so a double-click cannot clear the preview
    editing: null,          // { el, r, attr, userSelect } while an element's text is being edited
    typeCands: null,        // other text elements' type values, collected once per selection
  };

  const SENT = 'Sent. Clear the preview once your agent has applied it.';
  const FRESH = 'Cleared the sent preview for this element; this change starts from the live page.';
  const FOOTER = {
    apply: 'Apply these in source CSS and markup, in the files named above where given. Do not add inline styles.',
    aligned: 'A move that aligns with another element is a layout intent: express it with align-self, margin auto, grid placement or similar, never a transform or absolute offset.',
    spacing: 'A move with no alignment is a spacing intent: adjust margin or gap.',
    widths: 'Widths were measured at this viewport; keep them responsive (max-width or percentage) unless a fixed width is clearly correct.',
    type: 'A type change that matches another element should share that element\'s type style or token rather than repeat the value; an unmatched value may need a new step in the type scale.',
    text: 'A text change replaces the old string with the new one wherever that copy lives: markup, a component, a content file or a translation.',
    removals: 'Removals delete the element from the markup.',
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

  const collapse = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const trunc = (t) => (t.length > 52 ? `${t.slice(0, 26)}…${t.slice(-22)}` : t);

  function textChange(a, b) {
    let x = trunc(a), y = trunc(b);
    if (x === y && a !== b) {
      // Head-and-tail truncation hides a change in the middle, so centre both strings on the first difference.
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      const start = Math.max(0, i - 20);
      const win = (t) => (start > 0 ? '…' : '') + t.slice(start, start + 50) + (start + 50 < t.length ? '…' : '');
      x = win(a); y = win(b);
    }
    return `text "${x}" → "${y}"`;
  }

  function label(el) {
    const src = source(el);
    return descriptor(el) + (src ? ` (${src})` : '') + (snippet(el) ? ' ' + snippet(el) : '');
  }

  /* ────────────────────────── records ────────────────────────── */

  function rec(el) {
    let r = state.changes.get(el);
    if (r && r.sent) {
      // The agent may already have applied this change, so its baseline no longer exists in the code.
      undo(r); r = null; state.notice = FRESH;
    }
    if (r) return r;
    const c = cs(el);
    const rect = el.getBoundingClientRect();
    r = {
      el,
      orig: {
        transform: el.style.transform, width: el.style.width, height: el.style.height,
        maxWidth: el.style.maxWidth, maxHeight: el.style.maxHeight,
        display: el.style.display, transition: el.style.transition,
        fontSize: el.style.fontSize, lineHeight: el.style.lineHeight,
        letterSpacing: el.style.letterSpacing, fontWeight: el.style.fontWeight,
      },
      base: { w: rect.width, h: rect.height, maxW: c.maxWidth, maxH: c.maxHeight, cTransform: c.transform },
      dx: 0, dy: 0, w: null, h: null, removed: false, locked: false, snaps: [], moveAligned: false,
      text: null, baseText: null, origNodes: null,
      type: {}, baseType: null,
      sent: false, sentBatch: 0, sentSeq: 0,
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
    TYPE.forEach((d) => { const t = r.type[d.key]; el.style[d.key] = t ? fmt(t.to) + d.unit : o[d.key]; });
  }

  /* ────────────────────────── type ────────────────────────── */

  // Font family is deliberately absent: nudge cannot see which fonts are installed or loaded.
  // Plain arrows step by 1 (weight by 100), Shift by 10, Alt by a fine step that never snaps.
  const TYPE = [
    { key: 'fontSize', label: 'size', name: 'font size', unit: 'px', step: 1, big: 10, fine: 0.1, min: 1, tol: 0.5 },
    { key: 'lineHeight', label: 'line', name: 'line height', unit: 'px', step: 1, big: 10, fine: 0.1, min: 1, tol: 0.5 },
    { key: 'letterSpacing', label: 'spacing', name: 'letter spacing', unit: 'px', step: 1, big: 10, fine: 0.1, min: -100, tol: 0.05 },
    { key: 'fontWeight', label: 'weight', name: 'weight', unit: '', step: 100, big: 100, fine: 10, min: 1, max: 1000, tol: 0 },
  ];
  const fmt = (n) => String(Math.round(n * 100) / 100);
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  // "normal" line height and letter spacing are kept as null so the batch can say "normal".
  function readType(st) {
    const num = (v) => (v === 'normal' ? null : parseFloat(v));
    return { fontSize: parseFloat(st.fontSize), lineHeight: num(st.lineHeight), letterSpacing: num(st.letterSpacing), fontWeight: parseFloat(st.fontWeight) };
  }

  function typeFrom(r, d) {
    if (r.type[d.key]) return r.type[d.key].to;
    const b = r.baseType[d.key];
    if (b != null) return b;
    return d.key === 'lineHeight' ? Math.round(r.baseType.fontSize * 1.2) : 0;
  }

  // The batch names a match by the part of the selector a person would recognise: ".lede" rather than a path.
  function shortName(el) {
    const seg = descriptor(el).split(' > ').pop();
    const m = /^[a-z0-9-]+([.#].+)$/i.exec(seg);
    return m ? m[1] : descriptor(el);
  }

  function typeCandidates(sel) {
    const out = [];
    document.body.querySelectorAll('*').forEach((el) => {
      if (isTool(el) || el === sel || el.contains(sel) || sel.contains(el) || !ownText(el)) return;
      const st = cs(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      out.push({ el, v: readType(st) });
    });
    return out;
  }

  // Nearest other element's value within tolerance, never the value being stepped away from.
  function typeSnap(d, v, from, sel) {
    let best = null;
    for (const c of state.typeCands) {
      const cv = c.v[d.key];
      if (cv == null || Math.abs(cv - v) > d.tol || Math.abs(cv - from) < 0.005) continue;
      const score = Math.abs(cv - v) - (c.el.tagName === sel.tagName ? 0.001 : 0);
      if (!best || score < best.score) best = { v: cv, el: c.el, score };
    }
    return best;
  }

  // Same preference as snapping: an element of the same kind wins a tie.
  function typeExact(d, v, sel) {
    const hits = state.typeCands.filter((x) => x.v[d.key] != null && Math.abs(x.v[d.key] - v) < 0.005);
    const c = hits.find((x) => x.el.tagName === sel.tagName) || hits[0];
    return c ? c.el : null;
  }

  function setType(d, value, how) {
    const el = state.selected;
    if (!el || !ownText(el) || !isFinite(value)) return;
    state.notice = null;
    const r = rec(el);
    if (!r.baseType) r.baseType = readType(cs(el));
    if (!state.typeCands) state.typeCands = typeCandidates(el);
    const from = typeFrom(r, d);
    let v = Math.min(d.max ?? Infinity, Math.max(d.min, value));
    let match = null;
    if (how === 'step') { const c = typeSnap(d, v, from, el); if (c) { v = c.v; match = c.el; } }
    if (!match) match = typeExact(d, v, el);
    const base = r.baseType[d.key];
    if (base != null && Math.abs(v - base) < 0.005) delete r.type[d.key];
    else r.type[d.key] = { to: v, match };
    apply(r); prune(r); render(); updateBoxes();
    if (match) place(matchBox, match.getBoundingClientRect()); else matchBox.style.display = 'none';
    renderProps();
    setStatus(withNotice(summary(r) || descriptor(el)));
  }

  // Computed line height is always in pixels even when the source is unitless, so give the ratio too.
  function typeLine(r, d) {
    const t = r.type[d.key], b = r.baseType[d.key];
    let line = `${d.name} ${b == null ? 'normal' : fmt(b) + d.unit} → ${fmt(t.to)}${d.unit}`;
    if (d.key === 'lineHeight' && b != null) {
      const fsNow = r.type.fontSize ? r.type.fontSize.to : r.baseType.fontSize;
      line += `, ${fmt(b / r.baseType.fontSize)} → ${fmt(t.to / fsNow)} × font size`;
    }
    return line + (t.match ? ` (now matches ${shortName(t.match)})` : '');
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

  function isNoop(r) { return !r.dx && !r.dy && r.w == null && r.h == null && !r.removed && r.text == null && !Object.keys(r.type).length; }

  function prune(r) {
    if (!isNoop(r)) return;
    r.el.style.transition = r.orig.transition;
    state.changes.delete(r.el);
  }

  function undo(r) {
    const el = r.el, o = r.orig;
    if (state.editing && state.editing.el === el) exitEditMode();
    if (r.origNodes) el.replaceChildren(...r.origNodes.map((n) => n.cloneNode(true)));
    el.style.transform = o.transform; el.style.width = o.width; el.style.height = o.height;
    el.style.maxWidth = o.maxWidth; el.style.maxHeight = o.maxHeight;
    el.style.display = o.display; el.style.transition = o.transition;
    TYPE.forEach((d) => { el.style[d.key] = o[d.key]; });
    state.changes.delete(el);
  }

  const allRecs = () => [...state.changes.values()];
  const sentRecs = () => allRecs().filter((r) => r.sent);
  const unsentRecs = () => allRecs().filter((r) => !r.sent);

  function resetAll() { if (state.editing) endEdit(); allRecs().forEach(undo); state.notice = null; select(null); render(); }

  /* ────────────────────────── text editing ────────────────────────── */

  // Only text can be edited: an element with child elements would let an edit restructure markup.
  // Comment nodes are allowed because React inserts <!-- --> between text segments.
  function cannotEdit(el) {
    if (INTRINSIC.test(el.tagName.toUpperCase())) return 'this element has no text to edit';
    const child = el.children[0];
    if (child) return `this element contains other elements (${child.tagName.toLowerCase()}); double-click the innermost text instead`;
    if (!el.textContent.trim()) return 'this element has no text to edit';
    return null;
  }

  function startEdit(el, x, y) {
    const why = cannotEdit(el);
    if (why) { setStatus(`Cannot edit text: ${why}.`); return; }
    state.notice = null;
    const r = rec(el);
    if (!r.origNodes) { r.origNodes = [...el.childNodes].map((n) => n.cloneNode(true)); r.baseText = el.textContent; }
    state.editing = { el, r, attr: el.getAttribute('contenteditable'), userSelect: el.style.userSelect };
    // plaintext-only blocks formatting shortcuts and rich paste; the fallback relies on the input guards below.
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.style.userSelect = 'text';
    el.focus({ preventScroll: true });
    const range = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    if (range && el.contains(range.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    updateBoxes();
    setStatus(withNotice('Editing text. Escape or click elsewhere to finish.'));
  }

  function exitEditMode() {
    const ed = state.editing;
    if (!ed) return null;
    state.editing = null;
    if (ed.attr == null) ed.el.removeAttribute('contenteditable'); else ed.el.setAttribute('contenteditable', ed.attr);
    ed.el.style.userSelect = ed.userSelect;
    if (document.activeElement === ed.el) ed.el.blur();
    return ed;
  }

  function endEdit() {
    const ed = exitEditMode();
    if (!ed || state.changes.get(ed.el) !== ed.r) return;
    const r = ed.r, now = ed.el.textContent;
    r.text = now === r.baseText ? null : now;
    // Typing and deleting back can still merge text nodes or drop React's comment markers; put them back.
    if (r.text == null) ed.el.replaceChildren(...r.origNodes.map((n) => n.cloneNode(true)));
    prune(r);
    render(); updateBoxes();
    setStatus(withNotice(summary(r) || descriptor(ed.el)));
  }

  const inEdit = (t) => !!(state.editing && t && state.editing.el.contains(t));

  function onDblClick(e) {
    if (isTool(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    if (state.editing || !state.selected) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || (el !== state.selected && !state.selected.contains(el))) return;
    startEdit(state.selected, e.clientX, e.clientY);
  }

  const STRUCTURAL = /^(format|insertParagraph$|insertLineBreak$|insertFromDrop$|insertHorizontalRule$|insertOrderedList$|insertUnorderedList$|insertLink$)/;
  function onBeforeInput(e) { if (inEdit(e.target) && STRUCTURAL.test(e.inputType)) e.preventDefault(); }

  function onPaste(e) {
    if (!inEdit(e.target)) return;
    e.preventDefault();
    const text = collapse(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    if (text) document.execCommand('insertText', false, text);
  }

  function onDrop(e) { if (inEdit(e.target)) e.preventDefault(); }

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
    <div data-nudge id="nudge-reload" style="display:none;padding:8px 14px;background:#3a2f12;color:#f2c86b;border-bottom:1px solid #2c2a27;">The page reloaded. Clear the preview to see the real result.</div>
    <div data-nudge id="nudge-list" style="flex:1;overflow:auto;padding:6px 0;"></div>
    <div data-nudge id="nudge-props" style="display:none;padding:8px 14px;border-top:1px solid #2c2a27;">
      <div data-nudge id="nudge-type" style="display:none;">
        <div data-nudge style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
          ${['fontSize:size', 'lineHeight:line', 'letterSpacing:spacing', 'fontWeight:weight'].map((x) => { const [k, l] = x.split(':'); return `<label data-nudge style="display:flex;flex-direction:column;gap:2px;color:#6f6a62;font-size:10px;">${l}<input data-nudge data-prop="${k}" inputmode="decimal" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin:0;background:#242220;border:1px solid #3a3733;border-radius:4px;color:#ece7df;padding:3px 5px;font:12px ui-monospace,Menlo,monospace;"></label>`; }).join('')}
        </div>
        <div data-nudge id="nudge-type-match" style="visibility:hidden;min-height:15px;margin-top:5px;color:#e0447a;font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      </div>
    </div>
    <div data-nudge style="padding:10px 14px;display:flex;gap:8px;border-top:1px solid #2c2a27;align-items:center;">
      <button data-nudge id="nudge-copy" style="flex:1;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:8px 10px;font:600 12px system-ui;cursor:pointer">Copy for Claude Code</button>
      <button data-nudge id="nudge-recopy" style="display:none;background:#2c2a27;color:#ece7df;border:0;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer">Re-copy</button>
      <button data-nudge id="nudge-reset" style="background:#2c2a27;color:#ece7df;border:0;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer">Reset</button>
    </div>
    <div data-nudge style="padding:0 14px 10px;color:#6f6a62;font-size:11px">drag to move · handles to resize · ⌫ remove · arrows nudge · shift disables snap · esc deselect</div>`;

  const $ = (id) => panel.querySelector('#' + id);
  const setStatus = (t) => { $('nudge-status').textContent = t; };
  const withNotice = (t) => (state.notice ? (t ? `${state.notice} · ${t}` : state.notice) : t);
  const idleStatus = () => (sentRecs().length && !unsentRecs().length ? SENT : 'Click an element to start.');

  // Page text reaches the panel through textContent only, so markup in a snippet renders as text.
  function node(tag, css, text) {
    const n = document.createElement(tag);
    n.setAttribute('data-nudge', '');
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function summary(r) {
    const bits = [];
    if (r.removed) bits.push('remove');
    if (r.text != null) bits.push('text edited');
    TYPE.forEach((d) => { if (r.type[d.key]) bits.push(`${d.label} ${fmt(r.type[d.key].to)}${d.unit}`); });
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
    const sent = sentRecs(), unsent = unsentRecs();
    $('nudge-copy').textContent = state.copyLock ? 'Copied' : (sent.length && !unsent.length ? 'Clear preview' : 'Copy for Claude Code');
    $('nudge-recopy').style.display = sent.length ? '' : 'none';
    $('nudge-reload').style.display = sent.some((r) => r.sentSeq < state.reloadSeq) ? 'block' : 'none';

    const list = $('nudge-list');
    list.textContent = '';
    const recs = allRecs();
    if (!recs.length) { list.appendChild(node('div', 'padding:10px 14px;color:#6f6a62', 'No changes yet.')); return; }
    recs.forEach((r, i) => {
      const row = node('div', 'padding:8px 14px;display:flex;gap:10px;align-items:flex-start;border-bottom:1px solid #242220;' + (r.sent ? 'opacity:.5;' : ''));
      if (r.sent) row.setAttribute('data-sent', '');
      row.appendChild(node('div', `width:14px;flex-shrink:0;color:${r.sent ? '#8fd18f' : '#6f6a62'}`, r.sent ? '✓' : String(i + 1)));
      const body = node('div', 'flex:1;min-width:0');
      body.appendChild(node('div', 'color:#c9c2b7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', descriptor(r.el)));
      body.appendChild(node('div', '', summary(r)));
      r.snaps.forEach((t) => body.appendChild(node('div', 'color:#e0447a', t)));
      row.appendChild(body);
      const btn = node('button', 'background:none;border:1px solid #3a3733;color:#9c958b;border-radius:5px;padding:2px 7px;font:11px system-ui;cursor:pointer', 'undo');
      btn.addEventListener('click', () => { undo(r); if (state.selected === r.el) updateBoxes(); render(); });
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  // A max-width that is not a whole pixel came from clamp(), a percentage or similar. Quoting it as a rule
  // invites the agent to hard-code it, so say it was computed instead.
  function capNote(r) {
    const m = r.base.maxW;
    if (!m || m === 'none') return '';
    const n = /^(\d+(?:\.\d+)?)px$/.exec(m);
    if (n && !Number.isInteger(parseFloat(n[1]))) return ` (the element was capped at ${rnd(parseFloat(n[1]))}px by a computed max-width, check the source for the rule)`;
    return ` (was capped by max-width: ${m})`;
  }

  function report(recs = allRecs()) {
    const lines = [];
    lines.push(`nudge batch · ${location.href} · viewport ${innerWidth}×${innerHeight} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    lines.push('');
    recs.forEach((r, i) => {
      lines.push(`${i + 1}. ${label(r.el)}`);
      if (r.removed) lines.push('   remove this element from the markup');
      else if (r.text != null) lines.push(`   ${textChange(collapse(r.baseText), collapse(r.text))}`);
      if (r.w != null) {
        lines.push(`   width ${rnd(r.base.w)}px → ${rnd(r.w)}px${capNote(r)}`);
      }
      if (r.h != null) lines.push(`   height ${rnd(r.base.h)}px → ${rnd(r.h)}px`);
      if (!r.removed) TYPE.forEach((d) => { if (r.type[d.key]) lines.push(`   ${typeLine(r, d)}`); });
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
    // Only the guidance this batch needs.
    const moved = (r) => !r.removed && (r.dx || r.dy);
    lines.push(FOOTER.apply);
    if (recs.some((r) => moved(r) && r.moveAligned)) lines.push(FOOTER.aligned);
    if (recs.some((r) => moved(r) && !r.moveAligned)) lines.push(FOOTER.spacing);
    if (recs.some((r) => !r.removed && (r.w != null || r.h != null))) lines.push(FOOTER.widths);
    if (recs.some((r) => !r.removed && Object.keys(r.type).length)) lines.push(FOOTER.type);
    if (recs.some((r) => !r.removed && r.text != null)) lines.push(FOOTER.text);
    if (recs.some((r) => r.removed)) lines.push(FOOTER.removals);
    return lines.join('\n');
  }

  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = node('textarea', 'position:fixed;top:0;left:0;opacity:0;');
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // Copy sends only what has not been sent yet, so the agent never applies the same change twice.
  // It does not revert: if the paste fails the user needs the preview to copy again.
  async function copy() {
    const recs = unsentRecs();
    if (!recs.length) { setStatus('Nothing to copy yet.'); return; }
    if (!(await writeClipboard(report(recs)))) { setStatus('Copy failed. Nothing was marked as sent.'); return; }
    state.batch++;
    recs.forEach((r) => { r.sent = true; r.sentBatch = state.batch; r.sentSeq = state.reloadSeq; });
    state.notice = null;
    state.copyLock = true;
    render();
    setStatus(SENT);
    setTimeout(() => { state.copyLock = false; render(); }, 900);
  }

  async function recopy() {
    let recs = sentRecs().filter((r) => r.sentBatch === state.batch);
    if (!recs.length) recs = sentRecs();
    if (!recs.length) return;
    setStatus((await writeClipboard(report(recs))) ? 'Copied again. Clear the preview once your agent has applied it.' : 'Copy failed. Try again.');
  }

  function clearPreview() {
    sentRecs().forEach(undo);
    state.notice = null;
    render(); updateBoxes();
    setStatus('Preview cleared. This is the live page.');
  }

  function primary() {
    if (state.copyLock) return;
    if (unsentRecs().length) copy();
    else if (sentRecs().length) clearPreview();
    else setStatus('Nothing to copy yet.');
  }

  const typeInput = (key) => panel.querySelector(`input[data-prop="${key}"]`);

  // Controls appear only for the selected element and only when they apply to it.
  function renderProps() {
    const el = state.selected;
    const showType = !!el && document.contains(el) && !INTRINSIC.test(el.tagName.toUpperCase()) && ownText(el);
    $('nudge-type').style.display = showType ? '' : 'none';
    $('nudge-props').style.display = showType ? '' : 'none';
    if (!showType) return;
    const r = state.changes.get(el);
    const live = readType(cs(el));
    TYPE.forEach((d) => {
      const input = typeInput(d.key);
      if (document.activeElement === input) { if (r && r.type[d.key]) input.value = fmt(r.type[d.key].to); return; }
      const t = r && r.type[d.key];
      input.value = t ? fmt(t.to) : (live[d.key] == null ? 'normal' : fmt(live[d.key]));
    });
    const line = $('nudge-type-match');
    const matched = r ? TYPE.filter((d) => r.type[d.key] && r.type[d.key].match) : [];
    line.textContent = matched.map((d) => `${d.label} matches ${shortName(r.type[d.key].match)}`).join(' · ');
    // Reserve the line's space even when empty: the panel is anchored to the bottom, so a line appearing
    // would push the fields up from under the pointer mid-click.
    line.style.visibility = matched.length ? 'visible' : 'hidden';
  }

  // One step up or down, shared by the arrow keys and the stepper buttons so both follow the same rules.
  function stepType(d, dir, mods) {
    if (!state.selected) return;
    const r = state.changes.get(state.selected);
    const from = r && r.baseType ? typeFrom(r, d) : (() => { const t = readType(cs(state.selected)); return t[d.key] ?? (d.key === 'lineHeight' ? Math.round(t.fontSize * 1.2) : 0); })();
    const size = mods.altKey ? d.fine : mods.shiftKey ? d.big : d.step;
    setType(d, from + dir * size, mods.altKey ? 'fine' : 'step');
  }

  // Steppers sit inside each field and appear only on hover or focus, like a browser's own number field,
  // so the panel at rest looks the same. Holding one repeats. Clicking keeps focus where it was.
  function addSteppers(d) {
    const input = typeInput(d.key);
    const wrap = node('div', 'position:relative;');
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.paddingRight = '16px';
    const col = node('div', 'position:absolute;top:1px;right:1px;bottom:1px;width:14px;display:none;flex-direction:column;border-left:1px solid #3a3733;');
    col.dataset.steppers = d.key;
    let hovered = false;
    const sync = () => { col.style.display = hovered || document.activeElement === input ? 'flex' : 'none'; };
    wrap.addEventListener('mouseenter', () => { hovered = true; sync(); });
    wrap.addEventListener('mouseleave', () => { hovered = false; sync(); });
    input.addEventListener('focus', sync);
    input.addEventListener('blur', sync);
    [['up', 1], ['down', -1]].forEach(([name, dir]) => {
      const b = node('button', `flex:1;display:flex;align-items:center;justify-content:center;padding:0;margin:0;border:0;${dir < 0 ? 'border-top:1px solid #3a3733;' : ''}background:transparent;color:#9c958b;cursor:pointer;`);
      b.dataset.step = name; b.tabIndex = -1; b.setAttribute('aria-label', `${d.name} ${name}`);
      b.appendChild(node('span', `width:0;height:0;border-left:3px solid transparent;border-right:3px solid transparent;${dir > 0 ? 'border-bottom' : 'border-top'}:4px solid currentColor;`));
      b.addEventListener('mouseenter', () => { b.style.color = '#ece7df'; });
      b.addEventListener('mouseleave', () => { b.style.color = '#9c958b'; });
      b.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const mods = { shiftKey: e.shiftKey, altKey: e.altKey };
        stepType(d, dir, mods);
        let timer = setTimeout(function repeat() { stepType(d, dir, mods); timer = setTimeout(repeat, 70); }, 400);
        const stop = () => { clearTimeout(timer); document.removeEventListener('mouseup', stop, true); b.removeEventListener('mouseleave', stop); };
        document.addEventListener('mouseup', stop, true);
        b.addEventListener('mouseleave', stop);
      });
      col.appendChild(b);
    });
    wrap.appendChild(col);
  }

  function onTypeKey(e) {
    const d = TYPE.find((x) => x.key === e.target.dataset.prop);
    if (!d || !state.selected) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepType(d, e.key === 'ArrowUp' ? 1 : -1, e);
    } else if (e.key === 'Enter') {
      e.preventDefault(); onTypeChange(e);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.target.blur(); renderProps();
    }
  }

  function onTypeChange(e) {
    const d = TYPE.find((x) => x.key === e.target.dataset.prop);
    if (!d || !state.selected) return;
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) { renderProps(); return; }
    // A change event also fires when the field loses focus. If nothing changed, do not re-render: rebuilding
    // the rows under the pointer would swallow the click that took the focus away, such as a row's undo.
    const r = state.changes.get(state.selected);
    const cur = r && r.baseType ? typeFrom(r, d) : readType(cs(state.selected))[d.key];
    if (cur != null && Math.abs(cur - v) < 0.005) return;
    setType(d, v, 'typed');
  }

  /* ────────────────────────── selection ────────────────────────── */

  function select(el) {
    if (el !== state.selected) { state.typeCands = null; matchBox.style.display = 'none'; }
    state.selected = el;
    updateBoxes();
    renderProps();
    if (el) setStatus(descriptor(el));
    else setStatus(idleStatus());
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
    if (state.editing) {
      if (!isTool(t) && inEdit(t)) return;   // caret placement and text selection stay native
      endEdit();
    }
    if (isTool(t)) {
      if (t.dataset.handle && state.selected) { startResize(e, t.dataset.handle); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    // Cancelling the mousedown keeps focus where it was; a focused panel field would keep taking the arrow keys.
    const ae = document.activeElement;
    if (ae && isTool(ae) && ae !== document.body && ae.blur) ae.blur();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.body || el === document.documentElement) { select(null); return; }
    if (state.selected && (el === state.selected || state.selected.contains(el))) { startMoveDrag(e); return; }
    select(el);
  }

  function onClick(e) { if (!isTool(e.target)) { e.preventDefault(); e.stopPropagation(); } }

  // Bind the drag to a record and measure its starting geometry.
  function prime(d) {
    const r = rec(d.el);
    const b = d.el.getBoundingClientRect();
    state.candidates = collectCandidates(d.el);
    d.r = r;
    if (d.kind === 'move') { d.dx0 = r.dx; d.dy0 = r.dy; d.rect = b; }
    else { d.w0 = b.width; d.h0 = b.height; d.left = b.left; d.top = b.top; }
  }

  function startDrag(e, d) {
    d.el = state.selected; d.startX = e.clientX; d.startY = e.clientY; d.r = null;
    state.notice = null;
    const existing = state.changes.get(d.el);
    // A click on a sent element must not clear its preview, so wait for real movement before re-recording it.
    if (!(existing && existing.sent)) prime(d);
    state.drag = d;
    document.body.style.userSelect = 'none';
  }

  function startMoveDrag(e) { startDrag(e, { kind: 'move' }); }
  function startResize(e, handle) { startDrag(e, { kind: 'resize', handle }); }

  function dragMove(e) {
    const d = state.drag;
    if (!d.r) {
      if (e.clientX === d.startX && e.clientY === d.startY) return;
      prime(d);
    }
    const r = d.r;
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
      setStatus(withNotice(summary(r)));
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
      setStatus(withNotice(summary(r)));
    }
  }

  function onUp() {
    if (!state.drag) return;
    const { r, shift } = state.drag;
    state.drag = null;
    document.body.style.userSelect = '';
    showGuides(null);
    if (r) finish(r, shift);
  }

  function finish(r, exact) {
    if (!exact && !r.removed) state.candidates = collectCandidates(r.el);
    const moves = (exact || r.removed || !(r.dx || r.dy)) ? [] : relationships(r);
    const sizes = (exact || r.removed) ? [] : sizeRelationships(r);
    r.snaps = [...moves, ...sizes];
    r.moveAligned = moves.length > 0;
    prune(r);
    render();
    updateBoxes();
  }

  function onKey(e) {
    if (state.editing) {
      if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
      else if (e.key === 'Enter') e.preventDefault();
      return;   // every other key edits the text
    }
    // Panel buttons keep focus after a click because page mousedowns are cancelled, so only text fields may swallow keys.
    if (isTool(e.target) && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'Escape') { select(null); return; }
    if (!state.selected) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      state.notice = null;
      const r = rec(state.selected); r.removed = true; apply(r);
      finish(r); select(null);
      if (state.notice) setStatus(state.notice);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const map = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    if (map[e.key]) {
      e.preventDefault();
      state.notice = null;
      const r = rec(state.selected);
      state.candidates = collectCandidates(state.selected);
      r.dx += map[e.key][0]; r.dy += map[e.key][1];
      apply(r); finish(r);
      setStatus(withNotice(summary(r) || descriptor(state.selected)));
    }
  }

  function onScroll() { updateBoxes(); hoverBox.style.display = 'none'; }

  function onContext(e) { if (!isTool(e.target)) e.preventDefault(); }

  // A CSS-only hot reload keeps the DOM node, so nudge's inline styles survive it and hide whether the
  // agent's change worked. Vite replaces a style element's text; webpack and Turbopack swap stylesheet
  // links. Pure additions of style elements or rules are what CSS-in-JS does on every mount, so they
  // do not count.
  const isSheet = (n) => !!n && n.nodeType === 1 &&
    (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/i.test(n.getAttribute('rel') || '')));

  function stylesheetsReloaded(muts) {
    for (const m of muts) {
      if (m.type === 'attributes') { if (isSheet(m.target)) return true; continue; }
      if (m.type === 'characterData') { if (isSheet(m.target.parentNode)) return true; continue; }
      if (isSheet(m.target)) { if (m.removedNodes.length) return true; continue; }
      if ([...m.removedNodes].some(isSheet)) return true;
      if ([...m.addedNodes].some((n) => isSheet(n) && n.tagName === 'LINK')) return true;
    }
    return false;
  }

  const headObserver = new MutationObserver((muts) => {
    if (!stylesheetsReloaded(muts)) return;
    state.reloadSeq++;
    render(); updateBoxes();
  });

  /* ────────────────────────── mount / destroy ────────────────────────── */

  const opts = { capture: true };
  document.addEventListener('mousemove', onMove, opts);
  document.addEventListener('mousedown', onDown, opts);
  document.addEventListener('mouseup', onUp, opts);
  document.addEventListener('click', onClick, opts);
  document.addEventListener('keydown', onKey, opts);
  document.addEventListener('contextmenu', onContext, opts);
  document.addEventListener('dblclick', onDblClick, opts);
  document.addEventListener('beforeinput', onBeforeInput, opts);
  document.addEventListener('paste', onPaste, opts);
  document.addEventListener('drop', onDrop, opts);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(panel);
  if (document.head) headObserver.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
  $('nudge-copy').addEventListener('click', primary);
  $('nudge-recopy').addEventListener('click', recopy);
  $('nudge-reset').addEventListener('click', resetAll);
  $('nudge-close').addEventListener('click', () => window.__nudge.destroy());
  TYPE.forEach((d) => { const i = typeInput(d.key); i.addEventListener('keydown', onTypeKey); i.addEventListener('change', onTypeChange); addSteppers(d); });
  render();

  window.__nudge = {
    destroy() {
      resetAll();
      headObserver.disconnect();
      document.removeEventListener('mousemove', onMove, opts);
      document.removeEventListener('mousedown', onDown, opts);
      document.removeEventListener('mouseup', onUp, opts);
      document.removeEventListener('click', onClick, opts);
      document.removeEventListener('keydown', onKey, opts);
      document.removeEventListener('contextmenu', onContext, opts);
      document.removeEventListener('dblclick', onDblClick, opts);
      document.removeEventListener('beforeinput', onBeforeInput, opts);
      document.removeEventListener('paste', onPaste, opts);
      document.removeEventListener('drop', onDrop, opts);
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
      get batch() { return state.batch; },
      get reloadSeq() { return state.reloadSeq; },
      get editing() { return state.editing && state.editing.el; },
      els: { overlay, panel, selBox, hoverBox, guideH, guideV, matchBox, handles },
    },
  };
})();
