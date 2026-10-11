/*
  nudge: drag on the running page, hand the intent to Claude Code.

  Loads as a bookmarklet on any page, or from a script tag carrying
  data-nudge-dormant, which loads it asleep as a small dot on local hosts only.
  Nothing here writes to source; it captures what you did (resize, move,
  remove), detects what the moved thing lined up with, and copies a batch of
  measurements for the agent.

  Keys: click = select · drag inside selection = move · E/S/SE handles = resize
        arrows = nudge 1px (shift = 10px) · ⌫ = remove · esc = deselect
        hold shift while dragging to disable snapping
*/
(function () {
  'use strict';

  // The mode comes from the script element that loaded this file. `data-nudge-dormant` is the script-tag
  // path: load asleep as a dot, and only on a local host. No attribute is the bookmarklet path, unchanged.
  const ownScript = document.currentScript;
  const DORMANT = !!(ownScript && ownScript.hasAttribute && ownScript.hasAttribute('data-nudge-dormant'));

  if (window.__nudge) {
    // Loaded twice: the first instance stands. A bookmarklet click on a dormant page toggles the panel.
    if (!DORMANT) window.__nudge.toggle();
    return;
  }

  const isLocalHost = (h) => /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(h) || /\.(localhost|local)$/i.test(h);
  if (DORMANT && !isLocalHost(location.hostname)) {
    console.warn(`nudge: not running on "${location.hostname}". The script tag runs only on localhost, 127.0.0.1, ::1, a .localhost or a .local host. Use the bookmarklet on a live site.`);
    return;
  }

  const SNAP = 5;           // px tolerance while dragging
  const RELATE = 1;         // px tolerance when recording relationships
  // Highest possible z-index for the panel and dot, so a page's own maximum only ties, and ties go to the
  // later node in the document: nudge's nodes are the last children of <html>. The top layer (a native
  // <dialog> shown modally, or a popover) still paints above everything and cannot be beaten.
  const Z = 2147483646;

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
    tokens: null,           // colour tokens read from :root, once per selection
    palette: null,          // which colour property's palette is open: 'color' | 'backgroundColor'
    awake: false,           // panel open and page listeners attached
    dotHidden: false,       // Option-click on the dot hides it until the page reloads
    collapsed: false,       // panel folded to its header and buttons, so the page stays visible while working
    climbed: [],            // elements passed on the way up with Option+ArrowUp, so Option+ArrowDown can return
    bp: null,               // breakpoints read from the page's stylesheets, cached until they reload
    bpLines: false,         // breakpoint lines drawn on the overlay
    verdict: null,          // after a reload or a cleared preview: what the agent applied of the last batch
    expect: null,           // the last sent batch's expected measurements, mirrored in sessionStorage
    xray: false,            // outlines on every container, to find wrappers that have no surface of their own
    pin: null,              // the element "m" matches the selection to
    measure: false,         // rulers and gap drags without holding Option, from the Measure button
    matching: false,        // true while matchPin drives the setters, so they keep the match note
    history: [],            // every batch sent this page load: { batch, at, text }
    recopies: 0,            // Re-copy presses since the last batch, for the nudge when a paste keeps failing
  };

  const SENT = 'Sent. Clear the preview once your agent has applied it.';
  const FRESH = 'Cleared the sent preview for this element; this change starts from the live page.';
  const FOOTER = {
    apply: 'Apply these in source CSS and markup, in the files named above where given. Do not add inline styles.',
    aligned: 'A move that aligns with another element is a layout intent: express it with align-self, margin auto, grid placement or similar, never a transform or absolute offset.',
    spacing: 'A move with no alignment is a spacing intent: adjust margin or gap.',
    widths: 'Widths were measured at this viewport; keep them responsive (max-width or percentage) unless a fixed width is clearly correct.',
    type: 'A type change that matches another element should share that element\'s type style or token rather than repeat the value; an unmatched value may need a new step in the type scale.',
    colour: 'A colour change names a design token: use that token. A value with no token is a question for the design system, not an instruction to hard-code it.',
    text: 'A text change replaces the old string with the new one wherever that copy lives: markup, a component, a content file or a translation.',
    removals: 'Removals delete the element from the markup.',
    match: 'A "make this match" change should share the matched element\'s rule, class or token rather than copy its values.',
    gap: 'A gap change edits the rule that produced the space, named on its line, not the element\'s position.',
    siblings: 'A change applied to siblings belongs on their shared rule or component, not on each instance.',
    responsive: 'Where an element has different rules at other widths, change the rule for the range it was measured in unless the intent clearly applies everywhere.',
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

  // The component that rendered this element, from the framework's own dev internals where it leaves any:
  // React's fiber on the node, Vue 3's parent component, Vue 2's instance. Nearest named component wins;
  // host nodes, fragments, providers and anonymous functions are skipped. Null where nothing is readable.
  function componentName(el) {
    const named = (t) => {
      if (!t) return null;
      if (typeof t === 'function') return t.displayName || t.name || null;
      if (typeof t === 'object') return t.displayName || named(t.render) || named(t.type) || null;
      return null;
    };
    const bad = /^(Fragment|Provider|Consumer|Suspense|StrictMode|Profiler|Context|Anonymous|_?default|[a-z]\w*)$/;
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const key = Object.keys(cur).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) {
        for (let f = cur[key]; f; f = f.return) { const n = named(f.type); if (n && !bad.test(n)) return n; }
        return null;
      }
      if (cur.__vueParentComponent) {
        for (let c = cur.__vueParentComponent; c; c = c.parent) { const t = c.type || {}; const n = t.name || t.__name; if (n && !bad.test(n)) return n; }
        return null;
      }
      if (cur.__vue__) {
        for (let v = cur.__vue__; v; v = v.$parent) { const o = v.$options || {}; const n = o.name || o._componentTag; if (n && !bad.test(n)) return n; }
        return null;
      }
    }
    return null;
  }

  function label(el) {
    const src = source(el), comp = componentName(el);
    return descriptor(el) + (comp ? ` in <${comp}>` : '') + (src ? ` (${src})` : '') + (snippet(el) ? ' ' + snippet(el) : '');
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
        color: el.style.color, backgroundColor: el.style.backgroundColor,
      },
      base: { w: rect.width, h: rect.height, maxW: c.maxWidth, maxH: c.maxHeight, cTransform: c.transform, capped: false },
      dx: 0, dy: 0, w: null, h: null, removed: false, locked: false, snaps: [], moveAligned: false,
      text: null, baseText: null, origNodes: null,
      type: {}, baseType: null, colour: {}, baseColour: {},
      sent: false, sentBatch: 0, sentSeq: 0,
    };
    el.style.transition = 'none';
    if (c.maxWidth !== 'none') r.base.capped = heldByMaxWidth(el);
    state.changes.set(el, r);
    if (state.verdict) { state.verdict = null; render(); }
    return r;
  }

  // Is max-width what holds this element's width down? Lift it for one synchronous measurement: no frame is
  // painted in between, so nothing flickers. This works for px, %, calc() and clamp() alike, and an element
  // narrower than its cap no longer gets told it was capped.
  function heldByMaxWidth(el) {
    const before = parseFloat(cs(el).width);
    const prev = el.style.getPropertyValue('max-width'), pri = el.style.getPropertyPriority('max-width');
    el.style.setProperty('max-width', 'none', 'important');
    const free = parseFloat(cs(el).width);
    el.style.setProperty('max-width', prev, pri);
    return free > before + 0.5;
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
    COLOUR.forEach((d) => { const c = r.colour[d.key]; el.style[d.key] = c ? c.css : o[d.key]; });
    if (r.gap) r.gap.target.style[r.gap.prop] = px(r.gap.propFrom + (r.gap.to - r.gap.from));
    syncSiblings(r);
  }

  /* ────────────────────────── gap ────────────────────────── */

  // Option-drag on another element, with one selected, changes the space between them rather than moving
  // either. The preview edits the rule that produced the space, which is what the agent will edit: the
  // parent's gap when both are children of a flex or grid parent, else the larger of the two facing margins.
  // When neither exists the dragged element's facing margin stands in, and the batch says so.
  function gapBetween(a, b) {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const gx = Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right);
    const gy = Math.max(ra.top, rb.top) - Math.min(ra.bottom, rb.bottom);
    if (gx <= 0 && gy <= 0) return null;
    const axis = gx > 0 && (gy <= 0 || gx >= gy) ? 'x' : 'y';
    const after = axis === 'x' ? rb.left >= ra.right : rb.top >= ra.bottom;   // b sits after a along the axis
    return { axis, after, value: axis === 'x' ? gx : gy };
  }
  function gapSource(a, b, axis, after) {
    const p = b.parentElement;
    if (p && a.parentElement === p && /flex|grid/.test(cs(p).display)) {
      const prop = axis === 'x' ? 'columnGap' : 'rowGap';
      const v = parseFloat(cs(p)[prop]) || 0;
      return { target: p, prop, propFrom: v, text: `set by ${axis === 'x' ? 'column-gap' : 'row-gap'} ${rnd(v)}px on ${descriptor(p)}` };
    }
    const bProp = axis === 'x' ? (after ? 'marginLeft' : 'marginRight') : (after ? 'marginTop' : 'marginBottom');
    const aProp = axis === 'x' ? (after ? 'marginRight' : 'marginLeft') : (after ? 'marginBottom' : 'marginTop');
    const bv = parseFloat(cs(b)[bProp]) || 0, av = parseFloat(cs(a)[aProp]) || 0;
    const css = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    if (bv >= av && bv > 0) return { target: b, prop: bProp, propFrom: bv, text: `set by ${css(bProp)} ${rnd(bv)}px on this element` };
    if (av > 0) return { target: a, prop: aProp, propFrom: av, text: `set by ${css(aProp)} ${rnd(av)}px on ${descriptor(a)}` };
    return { target: b, prop: bProp, propFrom: 0, text: `no gap or margin found, previewed as ${css(bProp)} on this element; the space may be padding on a wrapper` };
  }
  function startGapDrag(e, other) {
    const g = gapBetween(state.selected, other);
    if (!g) { setStatus('These two overlap; there is no gap between them to drag.'); return; }
    startDrag(e, { kind: 'gap', other, axis: g.axis, after: g.after, gap0: g.value });
  }

  // "a" extends a record to the siblings that share its tag and classes: the same size, type and colour
  // values, never a move or a text edit. Each sibling keeps its own inline values for the properties the
  // record leaves alone, and gets them back when the record goes.
  const SIB_PROPS = ['width', 'maxWidth', 'height', 'maxHeight', 'display', 'fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'color', 'backgroundColor'];
  const siblingsOf = (el) => {
    const p = el.parentElement; if (!p) return [];
    const cls = [...el.classList].sort().join(' ');
    return [...p.children].filter((x) => x !== el && !isTool(x) && x.tagName === el.tagName && [...x.classList].sort().join(' ') === cls);
  };
  function syncSiblings(r) {
    if (!r.also) return;
    const on = { width: r.w != null, maxWidth: r.w != null, height: r.h != null, maxHeight: r.h != null, display: r.removed };
    TYPE.forEach((d) => { on[d.key] = !!r.type[d.key]; }); COLOUR.forEach((d) => { on[d.key] = !!r.colour[d.key]; });
    r.also.forEach(({ el: x, orig }) => SIB_PROPS.forEach((k) => { x.style[k] = on[k] ? r.el.style[k] : orig[k]; }));
  }
  function releaseSiblings(r) {
    if (!r.also) return;
    r.also.forEach(({ el: x, orig }) => SIB_PROPS.forEach((k) => { x.style[k] = orig[k]; }));
    r.also = null;
  }
  function toggleSiblings() {
    const el = state.selected, r = state.changes.get(el);
    if (!r || isNoop(r) || r.removed) { setStatus('Change this element first, then press a to apply the same to its siblings.'); return; }
    if (r.also) { releaseSiblings(r); render(); setStatus(withNotice(summary(r))); return; }
    const sibs = siblingsOf(el);
    if (!sibs.length) { setStatus('No sibling shares this element\'s tag and classes.'); return; }
    r.also = sibs.map((x) => { const orig = {}; SIB_PROPS.forEach((k) => { orig[k] = x.style[k]; }); return { el: x, orig }; });
    syncSiblings(r); render(); updateBoxes();
    setStatus(withNotice(summary(r)));
  }

  /* ────────────────────────── match a pinned element ────────────────────────── */

  // "p" pins the selection; "m" on another element gives it the pin's width, height, type and colours,
  // through the same setters a hand change uses, so the batch reads as it would after matching by hand,
  // plus one line naming the intent.
  const isTextEl = (el) => /^(P|H[1-6]|SPAN|A|LI|LABEL|SMALL|STRONG|EM|B|I|BLOCKQUOTE|FIGCAPTION|DT|DD|TD|TH|LEGEND|SUMMARY)$/.test(el.tagName) && ownText(el);
  function togglePin() {
    const el = state.selected;
    state.pin = state.pin === el ? null : el;
    updatePin(); renderActions();
    setStatus(state.pin ? `Pinned ${descriptor(el)}. Select another element and press m, or its Match button.` : 'Pin removed.');
  }
  function updatePin() {
    if (state.pin && document.contains(state.pin) && state.awake) place(pinBox, state.pin.getBoundingClientRect());
    else { if (!document.contains(state.pin)) state.pin = null; pinBox.style.display = 'none'; }
  }
  function matchPin() {
    const el = state.selected, pin = state.pin;
    if (!pin) { setStatus('Nothing pinned. Select the element to copy from and press p.'); return; }
    if (pin === el) { setStatus('That is the pinned element. Select the one to change and press m.'); return; }
    const pb = pin.getBoundingClientRect(), eb = el.getBoundingClientRect(), pc = cs(pin), ec = cs(el);
    const props = [];
    // A paragraph's box is its content, so for text elements only type and colour are matched; a card, an
    // image or a wrapper takes the pin's size as well.
    const sizes = !isTextEl(el);
    state.matching = true;
    try {
      if (sizes && Math.abs(pb.width - eb.width) >= 0.5) { setSize(SIZE[0], pb.width, 'typed'); props.push('width'); }
      if (sizes && Math.abs(pb.height - eb.height) >= 0.5) { setSize(SIZE[1], pb.height, 'typed'); props.push('height'); }
      if (ownText(el) && ownText(pin)) {
        const pt = readType(pc);
        TYPE.forEach((d) => {
          const r = state.changes.get(el);
          const cur = r && r.baseType ? typeFrom(r, d) : readType(ec)[d.key];
          if (pt[d.key] != null && cur != null && Math.abs(pt[d.key] - cur) >= 0.005) { setType(d, pt[d.key], 'typed'); props.push(d.name); }
        });
        const fg = toRGBA(pc.color);
        if (fg && !sameRGBA(fg, toRGBA(ec.color))) { setColour(COLOUR[0], { hex: hexOf(fg) }); props.push('colour'); }
      }
      const bg = toRGBA(pc.backgroundColor);
      if (bg && bg[3] > 0 && !sameRGBA(bg, toRGBA(ec.backgroundColor))) { setColour(COLOUR[1], { hex: hexOf(bg) }); props.push('background'); }
    } finally { state.matching = false; }
    const r = state.changes.get(el);
    if (!props.length || !r) { setStatus(`Already matches ${descriptor(pin)}.`); return; }
    r.matched = { el: pin, props };
    render();
    setStatus(withNotice(`matched ${props.join(', ')} to ${descriptor(pin)}`));
  }

  /* ────────────────────────── guardrails ────────────────────────── */

  // Two checks an agent would not make from the numbers alone: text that became too small, and a colour
  // change that left the text below WCAG AA contrast against the background it sits on.
  const luminance = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function effectiveBg(el) {
    for (let cur = el; cur; cur = cur.parentElement) { const c = toRGBA(cs(cur).backgroundColor); if (c && c[3] >= 128) return c; }
    return [255, 255, 255, 255];
  }
  function guardLines(r) {
    const out = [], el = r.el;
    if (r.removed || !ownText(el)) return out;
    const c = cs(el), fs = parseFloat(c.fontSize);
    if (r.type.fontSize && fs < 12) out.push(`font size ${fmt(fs)}px is below 12px, small for body text`);
    if (r.colour.color || r.colour.backgroundColor) {
      const fg = toRGBA(c.color), bg = effectiveBg(el);
      if (fg && bg) {
        const large = fs >= 24 || (parseInt(c.fontWeight, 10) >= 700 && fs >= 18.66), need = large ? 3 : 4.5;
        const ratio = contrast(fg, bg);
        if (ratio < need) out.push(`contrast ${ratio.toFixed(1)}:1 after this change, below the ${need}:1 AA minimum for this text size`);
      }
    }
    return out;
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
  // Width and height as typed or stepped values, snapping to other elements' edges and sizes like a drag.
  const SIZE = [
    { kind: 'size', key: 'w', label: 'width', name: 'width', unit: 'px', step: 1, big: 10, fine: 0.5, min: 8, tol: 0.5, axis: 'x' },
    { kind: 'size', key: 'h', label: 'height', name: 'height', unit: 'px', step: 1, big: 10, fine: 0.5, min: 8, tol: 0.5, axis: 'y' },
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
    if (!state.matching) r.matched = null;
    apply(r); prune(r); render(); updateBoxes();
    if (match) place(matchBox, match.getBoundingClientRect()); else matchBox.style.display = 'none';
    renderProps();
    const guard = guardLines(r);
    setStatus(withNotice(guard.length ? `${guard[0]} · ${summary(r)}` : (summary(r) || descriptor(el))));
  }

  // Computed line height is always in pixels even when the source is unitless, so give the ratio too.
  // Computed font size and letter spacing are always px. Give the rem and em equivalents on their own line
  // so the agent can match whichever unit the source uses, instead of hard-coding pixels.
  const fmt4 = (n) => String(Math.round(n * 10000) / 10000);
  function typeUnitsLine(r, d) {
    const t = r.type[d.key], b = r.baseType[d.key];
    if (d.key === 'fontSize') {
      const root = parseFloat(cs(document.documentElement).fontSize) || 16;
      return `as rem at a ${fmt(root)}px root: ${fmt4(b / root)}rem → ${fmt4(t.to / root)}rem`;
    }
    if (d.key === 'letterSpacing') {
      const fsBase = r.baseType.fontSize, fsNow = r.type.fontSize ? r.type.fontSize.to : fsBase;
      return `as em of the font size: ${b == null ? 'normal' : fmt4(b / fsBase) + 'em'} → ${fmt4(t.to / fsNow)}em`;
    }
    return null;
  }

  function typeLine(r, d) {
    const t = r.type[d.key], b = r.baseType[d.key];
    let line = `${d.name} ${b == null ? 'normal' : fmt(b) + d.unit} → ${fmt(t.to)}${d.unit}`;
    if (d.key === 'lineHeight' && b != null) {
      const fsNow = r.type.fontSize ? r.type.fontSize.to : r.baseType.fontSize;
      line += `, ${fmt(b / r.baseType.fontSize)} → ${fmt(t.to / fsNow)} × font size`;
    }
    return line + (t.match ? ` (now matches ${shortName(t.match)})` : '');
  }

  /* ────────────────────────── colour ────────────────────────── */

  // Text colour applies to an element with its own text. Background colour applies only where a background
  // already exists: giving a transparent element one is adding, and nudge corrects what is there.
  const COLOUR = [
    { key: 'color', label: 'text', name: 'colour', relevant: (el) => ownText(el) },
    { key: 'backgroundColor', label: 'background', name: 'background colour', relevant: (el) => { const c = toRGBA(cs(el).backgroundColor); return !!c && c[3] > 0; } },
  ];
  const NO_TOKEN = 'no token matched this value, check whether one should exist';

  let colourCtx = null;
  // Any CSS colour, in any colour space, to sRGB bytes, by painting one pixel.
  function toRGBA(v) {
    if (!colourCtx) { const c = document.createElement('canvas'); c.width = c.height = 1; colourCtx = c.getContext('2d', { willReadFrequently: true }); }
    const ctx = colourCtx;
    ctx.fillStyle = '#010203'; ctx.fillStyle = v;
    if (ctx.fillStyle === '#010203' && !/^#010203$/i.test(String(v).trim())) return null;
    ctx.clearRect(0, 0, 1, 1); ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }
  const sameRGBA = (a, b) => !!a && !!b && a.every((x, i) => Math.abs(x - b[i]) <= 2);
  const hexOf = (c) => (c[3] >= 253 ? '#' + c.slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join('') : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${fmt(c[3] / 255)})`);

  // Custom properties declared on :root, including inside @media, @supports and @layer, resolved against
  // the page as it renders now so theme overrides apply. Stylesheets from other origins cannot be read.
  function readTokens() {
    const names = new Set();
    let unreadable = 0;
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText != null && rule.selectorText.split(',').some((x) => x.trim() === ':root')) {
          for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop);
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (_) { unreadable++; continue; }
      if (rules) visit(rules);
    }
    for (const prop of document.documentElement.style) if (prop.startsWith('--')) names.add(prop);
    const root = cs(document.documentElement);
    const list = [];
    names.forEach((name) => {
      const raw = root.getPropertyValue(name).trim();
      if (!raw || /^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(raw) || !CSS.supports('color', raw)) return;
      const rgba = toRGBA(raw);
      if (rgba) list.push({ name, rgba });
    });
    return { list, declared: names.size, unreadable };
  }

  const tokensNow = () => (state.tokens || (state.tokens = readTokens()));
  const matchNames = (rgba) => tokensNow().list.filter((t) => sameRGBA(t.rgba, rgba)).map((t) => t.name);
  const varList = (names) => names.map((n) => `var(${n})`).join(' or ');

  function setColour(d, choice) {
    const el = state.selected;
    if (!el) return;
    state.notice = null;
    const r = rec(el);
    if (!r.baseColour[d.key]) { const rgba = toRGBA(cs(el)[d.key]); r.baseColour[d.key] = { rgba, names: matchNames(rgba) }; }
    const base = r.baseColour[d.key];
    let next;
    if (choice.token) {
      next = { css: `var(${choice.token})`, names: [choice.token], rgba: tokensNow().list.find((t) => t.name === choice.token).rgba };
    } else {
      const rgba = toRGBA(choice.hex), names = matchNames(rgba);
      next = names.length ? { css: `var(${names[0]})`, names, rgba } : { css: choice.hex, names: [], rgba };
    }
    const unchanged = sameRGBA(next.rgba, base.rgba) && (base.names.length <= 1 || next.names.length !== 1);
    if (unchanged) delete r.colour[d.key]; else r.colour[d.key] = next;
    if (!state.matching) r.matched = null;
    apply(r); prune(r); render(); updateBoxes(); renderProps();
    const guard = guardLines(r);
    setStatus(withNotice(guard.length ? `${guard[0]} · ${summary(r)}` : (summary(r) || descriptor(el))));
  }

  function colourLine(r, d) {
    const c = r.colour[d.key], b = r.baseColour[d.key];
    const before = b.names.length ? varList(b.names) : `${hexOf(b.rgba)} (no token)`;
    const after = c.names.length ? varList(c.names) : `${c.css} (${NO_TOKEN})`;
    return `${d.name} ${before} → ${after}`;
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

  function isNoop(r) { return !r.dx && !r.dy && r.w == null && r.h == null && !r.removed && r.text == null && !r.gap && !Object.keys(r.type).length && !Object.keys(r.colour).length; }

  function prune(r) {
    if (!isNoop(r)) return;
    r.el.style.transition = r.orig.transition;
    releaseSiblings(r);
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
    COLOUR.forEach((d) => { el.style[d.key] = o[d.key]; });
    if (r.gap) { r.gap.target.style[r.gap.prop] = r.gap.origInline; r.gap = null; }
    releaseSiblings(r);
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
  // `origin` is the fixed edge: left/top when the end edge moves, right/bottom when the start edge does.
  // `d` is always the size correction that lands the moving edge on the match.
  function fitSize(origin, size, axis, tol, side = 'end') {
    const start = side === 'start';
    const edgeName = axis === 'x' ? (start ? 'left' : 'right') : (start ? 'top' : 'bottom');
    const moving = start ? origin - size : origin + size;
    let edge = null, match = null;
    for (const c of state.candidates) {
      const edges = axis === 'x' ? [[c.l, 'left'], [c.r, 'right']] : [[c.t, 'top'], [c.b, 'bottom']];
      for (const [v, eb] of edges) {
        const n = { d: start ? moving - v : v - moving, at: v, c, ea: edgeName, eb, same: eb === edgeName };
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
      if (r.dx) { const g = fitSize(b.right, b.width, 'x', RELATE, 'start'); if (g.edge) out.push(edgeLine(g)); }
    }
    if (r.h != null) {
      const f = fitSize(b.top, b.height, 'y', RELATE);
      if (f.edge) out.push(edgeLine(f));
      if (f.match) out.push(`height matches height of ${label(f.match.c.el)} (${rnd(f.match.c.h)}px)`);
      if (r.dy) { const g = fitSize(b.bottom, b.height, 'y', RELATE, 'start'); if (g.edge) out.push(edgeLine(g)); }
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

  /* ────────────────────────── breakpoints ────────────────────────── */

  // The page's own width breakpoints, read from its stylesheets. Each is the first viewport width at which a
  // different set of rules applies: min-width 768px and max-width 767px both mean 768. Tailwind v4 writes
  // range syntax in rem, so both forms are parsed and rem and em resolve against the root font size.
  const rootPx = () => parseFloat(cs(document.documentElement).fontSize) || 16;
  function lengthPx(v) {
    const m = /^\s*(-?\d*\.?\d+)\s*(px|r?em)?\s*$/i.exec(v);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] && /em/i.test(m[2]) ? n * rootPx() : n;
  }
  // Each "(…)" width condition → the ranges [lo, hi] of viewport widths it covers. hi is inclusive.
  function widthRange(q) {
    let m;
    if ((m = /\(\s*min-width\s*:\s*([^)]+)\)/i.exec(q))) { const n = lengthPx(m[1]); return n == null ? null : [Math.ceil(n), Infinity]; }
    if ((m = /\(\s*max-width\s*:\s*([^)]+)\)/i.exec(q))) { const n = lengthPx(m[1]); return n == null ? null : [0, Math.floor(n)]; }
    if ((m = /\(\s*([^<>=()]+?)\s*(<=|<)\s*width\s*(<=|<)\s*([^<>=()]+?)\s*\)/i.exec(q))) {
      const a = lengthPx(m[1]), b = lengthPx(m[4]);
      if (a == null || b == null) return null;
      return [m[2] === '<' ? Math.floor(a) + 1 : Math.ceil(a), m[3] === '<' ? Math.ceil(b) - 1 : Math.floor(b)];
    }
    if ((m = /\(\s*width\s*(>=|>|<=|<)\s*([^)]+)\)/i.exec(q))) {
      const n = lengthPx(m[2]); if (n == null) return null;
      if (m[1] === '>=') return [Math.ceil(n), Infinity];
      if (m[1] === '>') return [Math.floor(n) + 1, Infinity];
      if (m[1] === '<=') return [0, Math.floor(n)];
      return [0, Math.ceil(n) - 1];
    }
    if ((m = /\(\s*([^<>=()]+?)\s*(>=|>)\s*width\s*\)/i.exec(q))) { const n = lengthPx(m[1]); return n == null ? null : [0, m[2] === '>' ? Math.ceil(n) - 1 : Math.floor(n)]; }
    if ((m = /\(\s*([^<>=()]+?)\s*(<=|<)\s*width\s*\)/i.exec(q))) { const n = lengthPx(m[1]); return n == null ? null : [m[2] === '<' ? Math.floor(n) + 1 : Math.ceil(n), Infinity]; }
    return null;
  }
  // A media list is comma-separated alternatives; each alternative's width conditions intersect.
  function mediaRanges(text) {
    const out = [];
    for (const alt of text.split(',')) {
      const conds = alt.match(/\([^()]*\)/g) || [];
      let lo = 0, hi = Infinity, any = false;
      for (const c of conds) { const r = widthRange(c); if (r) { any = true; lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]); } }
      if (any && lo <= hi) out.push([lo, hi]);
    }
    return out;
  }

  function readBreakpoints() {
    const rules = [];      // { lo, hi, selectors[] }
    let unreadable = 0;
    const walk = (list, inherited) => {
      for (const rule of list) {
        if (rule.type === 4 || rule.type === 3) {        // @media, @import
          const text = rule.media ? rule.media.mediaText : '';
          const ranges = mediaRanges(text);
          const inner = rule.cssRules || (rule.styleSheet && safeRules(rule.styleSheet));
          if (!inner) { if (rule.type === 3) unreadable++; continue; }
          // Only widths matter here; a query with no width condition inherits the enclosing range.
          const scope = ranges.length ? ranges : (inherited ? [inherited] : []);
          if (ranges.length) ranges.forEach(([lo, hi]) => { if (lo > 0 || hi < Infinity) rules.push({ lo, hi, selectors: collectSelectors(inner) }); });
          scope.length ? scope.forEach((r) => walk(inner, r)) : walk(inner, inherited);
        } else if (rule.cssRules) walk(rule.cssRules, inherited);  // @supports, @layer and friends
      }
    };
    const collectSelectors = (list) => { const out = []; for (const r of list) { if (r.selectorText) out.push(r.selectorText); else if (r.cssRules && r.type !== 4) out.push(...collectSelectors(r.cssRules)); } return out; };
    const safeRules = (sheet) => { try { return sheet.cssRules; } catch (_) { return null; } };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && isTool(sheet.ownerNode)) continue;
      const list = safeRules(sheet);
      if (!list) { unreadable++; continue; }
      const own = sheet.media && sheet.media.mediaText ? mediaRanges(sheet.media.mediaText) : [];
      if (own.length) own.forEach(([lo, hi]) => { if (lo > 0 || hi < Infinity) rules.push({ lo, hi, selectors: collectSelectors(list) }); walk(list, [lo, hi]); });
      else walk(list, null);
    }
    const points = new Set();
    rules.forEach(({ lo, hi }) => { if (lo > 0) points.add(lo); if (hi < Infinity) points.add(hi + 1); });
    return { points: [...points].sort((a, b) => a - b), rules, unreadable };
  }
  const breakpoints = () => (state.bp || (state.bp = readBreakpoints()));

  // The range the current width sits in, described in words: "768px and up", "below 600px", "600px to 899px".
  function rangeOf(width, points = breakpoints().points) {
    let lo = 0, hi = Infinity;
    for (const p of points) { if (p <= width) lo = p; else { hi = p; break; } }
    return { lo, hi, text: hi === Infinity ? (lo ? `${lo}px and up` : 'all widths') : lo ? `${lo}px to ${hi - 1}px` : `below ${hi}px` };
  }

  // Widths at which this element's rules differ from the current range, as a sentence or ''.
  function responsiveNote(el, width = innerWidth) {
    const { rules } = breakpoints();
    const cur = rangeOf(width);
    const below = new Set(), above = new Set();
    for (const { lo, hi, selectors } of rules) {
      if (lo <= width && width <= hi) continue;                    // these rules already apply at this width
      if (!selectors.some((s) => { try { return el.matches(s); } catch (_) { return false; } })) continue;
      if (hi < width) below.add(hi + 1); else above.add(lo);
    }
    const bits = [];
    if (below.size) bits.push(`below ${Math.max(...below)}px`);
    if (above.size) bits.push(`from ${Math.min(...above)}px`);
    return bits.length ? `different rules apply ${bits.join(' and ')}; this was measured in the ${cur.text} range` : '';
  }

  function viewportLine() {
    const { points, unreadable } = breakpoints();
    const w = innerWidth;
    if (!points.length) return unreadable ? `measured at ${w}px wide; ${unreadable} stylesheet${unreadable > 1 ? 's' : ''} could not be read for breakpoints` : `measured at ${w}px wide; the page has no width breakpoints`;
    return `measured at ${w}px wide, in the ${rangeOf(w).text} range (breakpoints at ${points.join(', ')}px${unreadable ? `, ${unreadable} stylesheet${unreadable > 1 ? 's' : ''} unreadable` : ''})`;
  }

  /* ────────────────────────── verify ────────────────────────── */

  // When a batch is sent, nudge remembers what the page should look like once the agent has applied it: the
  // sizes, positions, text and values measured with the previews in place. After the page reloads, or when
  // the preview is cleared, it measures again and says what was applied and what was not. The record lives
  // in sessionStorage so it survives a full reload, and dies with the tab.
  const EXPECT_KEY = 'nudge:expect', EXPECT_TTL = 30 * 60 * 1000;
  const VERIFY_KEYS = ['fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'color', 'backgroundColor'];

  // A selector that finds the element again after a reload: the nearest id, then nth-child steps.
  function pathTo(el) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      const parent = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${[...parent.children].indexOf(cur) + 1})`);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function expectation(r) {
    const el = r.el;
    const item = { path: pathTo(el), desc: descriptor(el), name: descriptor(el) + (snippet(el) ? ' ' + snippet(el) : ''), checks: {} };
    if (r.removed) { item.checks.removed = true; return item; }
    const b = el.getBoundingClientRect(), c = cs(el);
    if (r.w != null) item.checks.width = rnd(b.width);
    if (r.h != null) item.checks.height = rnd(b.height);
    if (r.dx) item.checks.left = rnd(b.left + scrollX);
    if (r.dy) item.checks.top = rnd(b.top + scrollY);
    if (r.text != null) item.checks.text = collapse(r.text);
    if (r.gap) item.checks.gap = { other: pathTo(r.gap.other), to: r.gap.to };
    VERIFY_KEYS.forEach((k) => { if ((r.type && r.type[k]) || (r.colour && r.colour[k])) item.checks[k] = c[k]; });
    return item;
  }

  const expectUrl = () => location.pathname + location.search;
  function loadExpect() {
    try {
      const d = JSON.parse(sessionStorage.getItem(EXPECT_KEY) || 'null');
      return d && d.url === expectUrl() && Date.now() - d.at < EXPECT_TTL ? d : null;
    } catch (_) { return null; }
  }
  function saveExpect(d) { try { if (d) sessionStorage.setItem(EXPECT_KEY, JSON.stringify(d)); else sessionStorage.removeItem(EXPECT_KEY); } catch (_) { /* storage blocked */ } }

  // Called as a batch is sent. A later batch for the same element supersedes the earlier expectation.
  function remember(recs) {
    const prev = state.expect || loadExpect();
    const items = recs.map(expectation);
    const paths = new Set(items.map((i) => i.path));
    const kept = prev ? prev.items.filter((i) => !paths.has(i.path)) : [];
    state.expect = { url: expectUrl(), at: Date.now(), width: innerWidth, items: [...kept, ...items] };
    state.verdict = null;
    saveExpect(state.expect);
  }

  function sameValue(k, have, want) {
    const a = parseFloat(have), b = parseFloat(want);
    if (/px$/.test(want) && !Number.isNaN(a) && !Number.isNaN(b)) return Math.abs(a - b) <= 0.6;
    return have === want;
  }
  function checkItem(it) {
    let el = null;
    try { el = document.querySelector(it.path); } catch (_) { el = null; }
    const found = el && descriptor(el) === it.desc;
    const c = it.checks;
    if (c.removed) return { name: it.name, ok: !found, why: 'still in the page' };
    if (!found) return { name: it.name, ok: false, why: 'element not found; the page structure changed' };
    const b = el.getBoundingClientRect(), s = cs(el);
    const near = (x, y) => Math.abs(x - y) <= 1.5;
    const miss = [];
    if (c.width != null && !near(b.width, c.width)) miss.push(`width is ${rnd(b.width)}px, wanted ${c.width}px`);
    if (c.height != null && !near(b.height, c.height)) miss.push(`height is ${rnd(b.height)}px, wanted ${c.height}px`);
    if (c.left != null && !near(b.left + scrollX, c.left)) miss.push(`left edge is at ${rnd(b.left + scrollX)}px, wanted ${c.left}px`);
    if (c.top != null && !near(b.top + scrollY, c.top)) miss.push(`top edge is at ${rnd(b.top + scrollY)}px, wanted ${c.top}px`);
    if (c.text != null && collapse(el.innerText) !== c.text) miss.push(`text is still "${trunc(collapse(el.innerText))}"`);
    if (c.gap) {
      let other = null; try { other = document.querySelector(c.gap.other); } catch (_) { other = null; }
      const g = other && gapBetween(other, el);
      if (!g) miss.push('the other element of the gap was not found');
      else if (!near(g.value, c.gap.to)) miss.push(`gap is ${rnd(g.value)}px, wanted ${c.gap.to}px`);
    }
    VERIFY_KEYS.forEach((k) => { if (c[k] != null && !sameValue(k, s[k], c[k])) miss.push(`${k.replace(/[A-Z]/g, (m) => ' ' + m.toLowerCase())} is ${s[k]}, wanted ${c[k]}`); });
    return { name: it.name, ok: !miss.length, why: miss.join('; ') };
  }

  // Measures the page against the last sent batch. Returns null when there is nothing to check.
  function verify(when = 'now') {
    const data = state.expect || loadExpect();
    if (!data || !data.items.length) return null;
    const items = data.items.map(checkItem);
    const applied = items.filter((x) => x.ok).length;
    const lead = when === 'reload' ? 'After the reload' : when === 'clear' ? 'Preview cleared' : 'Checked';
    const width = data.width !== innerWidth ? ` (measured at ${innerWidth}px wide; the batch was at ${data.width}px)` : '';
    const lines = [`${lead}: ${applied} of ${items.length} applied${width}.`];
    items.filter((x) => !x.ok).forEach((x) => lines.push(`not applied: ${x.name}: ${x.why}`));
    state.verdict = lines.join('\n');
    if (applied === items.length) { state.expect = null; saveExpect(null); }   // the job is done; a later reload has nothing to re-check
    else state.expect = data;
    render();
    return { applied, total: items.length, text: state.verdict, items };
  }

  // After a full reload nudge starts afresh; if a batch was sent from this URL, check it once the page has
  // settled. The bookmarklet is re-run by hand after a reload, so the same path serves both modes.
  function verifyAfterLoad() {
    if (!loadExpect()) return;
    const go = () => setTimeout(() => { if (window.__nudge) verify('reload'); }, 250);
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
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
  const bpLayer  = mk('position:fixed;inset:0;display:none;');
  const xrayLayer = mk('position:fixed;inset:0;display:none;');
  const rulerLayer = mk('position:fixed;inset:0;display:none;');
  const pinBox   = mk('position:fixed;display:none;outline:2px dashed #e0a030;outline-offset:2px;');
  pinBox.appendChild(node('div', 'position:absolute;right:0;top:-18px;background:#e0a030;color:#1c1b19;border-radius:3px;padding:0 5px;font:600 10px/16px system-ui;', 'pin'));
  const hoverTag = document.createElement('div');
  hoverTag.setAttribute('data-nudge', '');
  hoverTag.style.cssText = 'position:absolute;left:0;top:-19px;background:#2f6fed;color:#fff;border-radius:3px;padding:0 5px;font:10px/16px ui-monospace,Menlo,monospace;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;';
  hoverBox.appendChild(hoverTag);

  // What the pointer is over and how big it is, so a wrapper can be told from its child before clicking.
  function showHover(el, b) {
    place(hoverBox, b);
    const short = descriptor(el).split(' > ').pop();
    hoverTag.textContent = `${short} · ${rnd(b.width)}×${rnd(b.height)}`;
    hoverTag.style.top = b.top < 22 ? '2px' : '-19px';
  }

  // X-ray: a faint outline on every container in view, so the boxes that have no surface of their own can
  // be seen and clicked. Containers only: an element with element children and a box in the viewport.
  function drawXray() {
    xrayLayer.textContent = '';
    xrayLayer.style.display = state.xray && state.awake ? 'block' : 'none';
    if (!state.xray || !state.awake) return;
    let n = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (n >= 600) break;
      if (isTool(el) || !el.children.length) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
      const box = node('div', `position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;outline:1px dashed rgba(47,111,237,.35);outline-offset:-1px;`);
      box.dataset.xray = '';
      xrayLayer.appendChild(box); n++;
    }
  }

  // Rulers: with an element selected, Option-hover on another shows the distance between them. Beside each
  // other: the gap on the axis where they do not overlap. One inside the other: the inset on each side.
  function ruler(x1, y1, x2, y2, text) {
    const horizontal = y1 === y2;
    const len = horizontal ? x2 - x1 : y2 - y1;
    const line = node('div', `position:fixed;left:${x1}px;top:${y1}px;${horizontal ? `width:${len}px;height:0;border-top:1px solid #e0447a` : `height:${len}px;width:0;border-left:1px solid #e0447a`};`);
    line.dataset.ruler = text;
    const tag = node('div', `position:absolute;${horizontal ? 'left:50%;top:-9px' : 'top:50%;left:4px'};transform:${horizontal ? 'translate(-50%,-100%)' : 'translateY(-50%)'};background:#e0447a;color:#fff;border-radius:3px;padding:0 4px;font:600 10px/16px ui-monospace,Menlo,monospace;white-space:nowrap;`, text);
    line.appendChild(tag);
    rulerLayer.appendChild(line);
  }
  function drawRulers(other) {
    rulerLayer.textContent = '';
    const sel = state.selected;
    if (!other || !sel || other === sel) { rulerLayer.style.display = 'none'; return; }
    const a = sel.getBoundingClientRect(), b = other.getBoundingClientRect();
    const inner = sel.contains(other) ? b : other.contains(sel) ? a : null;
    const outer = inner === a ? b : inner === b ? a : null;
    if (inner) {
      const midX = inner.left + inner.width / 2, midY = inner.top + inner.height / 2;
      if (inner.left - outer.left >= 1) ruler(outer.left, midY, inner.left, midY, `${rnd(inner.left - outer.left)}`);
      if (outer.right - inner.right >= 1) ruler(inner.right, midY, outer.right, midY, `${rnd(outer.right - inner.right)}`);
      if (inner.top - outer.top >= 1) ruler(midX, outer.top, midX, inner.top, `${rnd(inner.top - outer.top)}`);
      if (outer.bottom - inner.bottom >= 1) ruler(midX, inner.bottom, midX, outer.bottom, `${rnd(outer.bottom - inner.bottom)}`);
    } else {
      const gapX = Math.max(a.left, b.left) - Math.min(a.right, b.right);
      const gapY = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom);
      if (gapX > 0) { const y = (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2; const y2 = gapY > 0 ? b.top + b.height / 2 : y; ruler(Math.min(a.right, b.right), y2, Math.max(a.left, b.left), y2, `${rnd(gapX)}`); }
      if (gapY > 0) { const x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2; const x2 = gapX > 0 ? b.left + b.width / 2 : x; ruler(x2, Math.min(a.bottom, b.bottom), x2, Math.max(a.top, b.top), `${rnd(gapY)}`); }
      if (gapX <= 0 && gapY <= 0) { rulerLayer.style.display = 'none'; return; }
    }
    rulerLayer.style.display = 'block';
  }

  // One dashed line per breakpoint within the viewport, labelled at the top, so a layout can be read against
  // the widths at which its rules change.
  function drawBreakpoints() {
    bpLayer.textContent = '';
    const { points } = breakpoints();
    const show = state.bpLines && state.awake && points.length;
    bpLayer.style.display = show ? 'block' : 'none';
    if (!show) return;
    points.filter((p) => p <= innerWidth).forEach((p) => {
      const line = node('div', `position:absolute;top:0;bottom:0;left:${p - 1}px;width:0;border-left:1px dashed #a07cf0;`);
      line.dataset.breakpoint = String(p);
      const tag = node('div', 'position:absolute;top:6px;left:3px;background:#a07cf0;color:#fff;border-radius:3px;padding:0 4px;font:600 10px/16px ui-monospace,Menlo,monospace;white-space:nowrap;', `${p}`);
      line.appendChild(tag); bpLayer.appendChild(line);
    });
  }

  const handles = {};
  const CURSOR = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw' };
  for (const h of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const d = document.createElement('div');
    d.setAttribute('data-nudge', ''); d.dataset.handle = h;
    d.style.cssText = `position:absolute;width:10px;height:10px;background:#fff;border:2px solid #2f6fed;border-radius:2px;pointer-events:auto;cursor:${CURSOR[h]}-resize;`;
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
      pos(handles.n, b.width / 2 - 5, -5); pos(handles.s, b.width / 2 - 5, b.height - 5);
      pos(handles.e, b.width - 5, b.height / 2 - 5); pos(handles.w, -5, b.height / 2 - 5);
      pos(handles.nw, -5, -5); pos(handles.ne, b.width - 5, -5);
      pos(handles.sw, -5, b.height - 5); pos(handles.se, b.width - 5, b.height - 5);
    } else selBox.style.display = 'none';
    updatePin();
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
  panel.style.cssText = `position:fixed;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));max-height:60vh;display:flex;flex-direction:column;
    background:#1c1b19;color:#ece7df;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:${Z + 1};
    font:12px/1.45 -apple-system,system-ui,sans-serif;overflow:hidden;`;
  panel.innerHTML = `
    <div data-nudge id="nudge-head" title="Collapse" style="padding:10px 14px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #2c2a27;cursor:pointer;user-select:none;">
      <span data-nudge id="nudge-chev" style="color:#6f6a62;font-size:10px;width:8px;flex-shrink:0">▾</span>
      <strong style="font-size:13px;letter-spacing:.01em">nudge</strong>
      <span data-nudge id="nudge-count" style="display:none;background:#2f6fed;color:#fff;border-radius:9px;padding:0 6px;font:600 11px/17px system-ui;flex-shrink:0"></span>
      <button data-nudge id="nudge-xray" type="button" title="Outline every container (x)" style="background:none;border:1px solid #3a3733;color:#9c958b;border-radius:4px;padding:0 5px;font:11px/17px system-ui;cursor:pointer;flex-shrink:0;white-space:nowrap">x-ray</button>
      <span data-nudge id="nudge-status" style="color:#9c958b;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Click an element to start.</span>
      <button data-nudge id="nudge-vp" type="button" style="background:none;border:1px solid #3a3733;color:#9c958b;border-radius:4px;padding:0 5px;font:11px/17px ui-monospace,Menlo,monospace;cursor:pointer;flex-shrink:0;white-space:nowrap"></button>
      <button data-nudge id="nudge-close" title="Close (discards uncommitted changes)" style="background:none;border:0;color:#9c958b;font-size:16px;cursor:pointer;line-height:1">×</button>
    </div>
    <div data-nudge id="nudge-reload" style="display:none;padding:8px 14px;background:#3a2f12;color:#f2c86b;border-bottom:1px solid #2c2a27;">The page reloaded. Clear the preview to see the real result.</div>
    <div data-nudge id="nudge-verdict" style="display:none;padding:8px 14px;background:#1f2e22;color:#9fd3a8;border-bottom:1px solid #2c2a27;white-space:pre-wrap;"></div>
    <div data-nudge id="nudge-actions" style="display:none;padding:7px 14px 0;gap:6px;flex-wrap:wrap;"></div>
    <div data-nudge id="nudge-list" style="flex:1;overflow:auto;padding:6px 0;"></div>
    <div data-nudge id="nudge-size" style="display:none;padding:8px 14px;border-top:1px solid #2c2a27;">
      <div data-nudge style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        ${['w:width', 'h:height'].map((x) => { const [k, l] = x.split(':'); return `<label data-nudge style="display:flex;flex-direction:column;gap:2px;color:#6f6a62;font-size:10px;">${l}<input data-nudge data-prop="${k}" inputmode="decimal" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin:0;background:#242220;border:1px solid #3a3733;border-radius:4px;color:#ece7df;padding:3px 5px;font:12px ui-monospace,Menlo,monospace;"></label>`; }).join('')}
      </div>
    </div>
    <div data-nudge id="nudge-props" style="display:none;padding:8px 14px;border-top:1px solid #2c2a27;">
      <div data-nudge id="nudge-type" style="display:none;">
        <div data-nudge style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
          ${['fontSize:size', 'lineHeight:line', 'letterSpacing:spacing', 'fontWeight:weight'].map((x) => { const [k, l] = x.split(':'); return `<label data-nudge style="display:flex;flex-direction:column;gap:2px;color:#6f6a62;font-size:10px;">${l}<input data-nudge data-prop="${k}" inputmode="decimal" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin:0;background:#242220;border:1px solid #3a3733;border-radius:4px;color:#ece7df;padding:3px 5px;font:12px ui-monospace,Menlo,monospace;"></label>`; }).join('')}
        </div>
        <div data-nudge id="nudge-type-match" style="visibility:hidden;min-height:15px;margin-top:5px;color:#e0447a;font-size:11px;line-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      </div>
      <div data-nudge id="nudge-colour" style="display:none;">
        <div data-nudge id="nudge-chips" style="display:flex;gap:6px;"></div>
        <div data-nudge id="nudge-palette" style="display:none;margin-top:6px;"></div>
      </div>
    </div>
    <div data-nudge style="padding:10px 14px;display:flex;gap:8px;border-top:1px solid #2c2a27;align-items:center;">
      <button data-nudge id="nudge-copy" style="flex:1;background:#2f6fed;color:#fff;border:0;border-radius:6px;padding:8px 10px;font:600 12px system-ui;cursor:pointer">Copy for Claude Code</button>
      <button data-nudge id="nudge-recopy" style="display:none;background:#2c2a27;color:#ece7df;border:0;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer">Re-copy</button>
      <button data-nudge id="nudge-reset" style="background:#2c2a27;color:#ece7df;border:0;border-radius:6px;padding:8px 10px;font:12px system-ui;cursor:pointer">Reset</button>
    </div>
    <div data-nudge id="nudge-hint" style="padding:0 14px 10px;color:#6f6a62;font-size:11px">drag to move · handles to resize · double-click edits text · ⌫ remove · arrows nudge · ⌥↑ parent · ⌥-hover measures, ⌥-drag sets the gap · p pin, m match · a siblings · x x-ray · shift disables snap · esc deselect</div>`;

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
    COLOUR.forEach((d) => { const c = r.colour[d.key]; if (c) bits.push(`${d.label} ${c.names.length ? c.names[0] : c.css}`); });
    if (r.w != null) bits.push(`width ${rnd(r.base.w)} → ${rnd(r.w)}px`);
    if (r.h != null) bits.push(`height ${rnd(r.base.h)} → ${rnd(r.h)}px`);
    if (r.locked) bits.push('ratio locked');
    if (r.gap) bits.push(`gap ${r.gap.from} → ${r.gap.to}px`);
    if (r.matched) bits.push(`matches ${descriptor(r.matched.el).split(' > ').pop()}`);
    if (r.also) bits.push(`+${r.also.length} sibling${r.also.length > 1 ? 's' : ''}`);
    if (r.dx || r.dy) {
      const mv = [];
      if (r.dx) mv.push(`${r.dx > 0 ? 'right' : 'left'} ${Math.abs(rnd(r.dx))}px`);
      if (r.dy) mv.push(`${r.dy > 0 ? 'down' : 'up'} ${Math.abs(rnd(r.dy))}px`);
      bits.push('moved ' + mv.join(', '));
    }
    return bits.join(' · ');
  }

  // Collapsed, the panel is its header and its buttons. The list, the property controls and the hint fold
  // away, and a badge on the header carries the change count so nothing is lost from view.
  function setCollapsed(v) {
    state.collapsed = !!v;
    $('nudge-chev').textContent = state.collapsed ? '▸' : '▾';
    $('nudge-head').title = state.collapsed ? 'Expand' : 'Collapse';
    render(); renderProps();
  }

  // The action row: the selection's own verbs, shown only when they apply, so it holds two to five small
  // buttons and never becomes a toolbar. The keys they stand for keep working.
  function renderActions() {
    const row = $('nudge-actions');
    const el = state.selected;
    row.textContent = '';
    if (!el || !document.contains(el) || state.collapsed) { row.style.display = 'none'; return; }
    const r = state.changes.get(el);
    const items = [];
    items.push(state.pin === el ? ['Unpin', togglePin, 'Remove the pin (p)'] : ['Pin', togglePin, 'Pin this element, then Match another to it (p)']);
    if (state.pin && state.pin !== el && document.contains(state.pin)) items.push(['Match', matchPin, `Make this match ${descriptor(state.pin)} (m)`]);
    if (r && !isNoop(r) && !r.removed && (r.also || siblingsOf(el).length)) items.push(r.also ? ['Release siblings', toggleSiblings, 'Take the change off the siblings (a)'] : ['Siblings', toggleSiblings, 'Apply this change to the siblings with the same tag and classes (a)']);
    items.push([state.measure ? 'Stop measuring' : 'Measure', toggleMeasure, 'Hover another element for the distance, drag it to set the gap (or hold Option)']);
    items.push(['Remove', removeSelected, 'Remove this element (Backspace)']);
    items.forEach(([text, fn, title]) => {
      const lit = (text === 'Unpin') || (text === 'Stop measuring') || (text === 'Release siblings');
      const b = node('button', `background:${lit ? '#2c2a27' : 'none'};border:1px solid ${lit ? '#6f6a62' : '#3a3733'};color:${lit ? '#ece7df' : '#9c958b'};border-radius:5px;padding:2px 8px;font:11px system-ui;cursor:pointer;`, text);
      b.type = 'button'; b.dataset.action = text.toLowerCase().replace(/ .*/, ''); b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      row.appendChild(b);
    });
    row.style.display = 'flex';
  }
  function toggleXray() {
    state.xray = !state.xray;
    drawXray();
    const b = $('nudge-xray');
    b.style.color = state.xray ? '#c9d8f7' : '#9c958b'; b.style.borderColor = state.xray ? '#2f6fed' : '#3a3733';
    if (state.xray) setStatus('X-ray on: every container outlined. Press x to turn it off.');
    else if (state.selected) showCrumbs(state.selected); else setStatus(idleStatus());
  }
  function toggleMeasure() {
    state.measure = !state.measure;
    if (!state.measure) drawRulers(null);
    renderActions();
    if (state.measure) setStatus('Measuring: hover another element for the distance, drag it to set the gap. Escape stops.');
    else if (state.selected) showCrumbs(state.selected);
  }
  function removeSelected() {
    if (!state.selected) return;
    state.notice = null;
    const r = rec(state.selected); r.removed = true; apply(r);
    finish(r); select(null);
    if (state.notice) setStatus(state.notice);
  }

  // The badge reads "1280 · 1200+" : the viewport width, then the range it falls in. It is a button: click
  // draws the breakpoint lines.
  function renderViewport() {
    const b = $('nudge-vp');
    const { points, unreadable } = breakpoints();
    const r = rangeOf(innerWidth);
    const range = !points.length ? '' : r.hi === Infinity ? `${r.lo}+` : r.lo ? `${r.lo}–${r.hi - 1}` : `<${r.hi}`;
    b.textContent = range ? `${innerWidth} · ${range}` : `${innerWidth}`;
    b.title = points.length ? `${innerWidth}px wide, in the ${r.text} range. Breakpoints at ${points.join(', ')}px. Click to ${state.bpLines ? 'hide' : 'show'} the lines.`
      : unreadable ? `${innerWidth}px wide. ${unreadable} stylesheet${unreadable > 1 ? 's' : ''} could not be read, so breakpoints are unknown.` : `${innerWidth}px wide. The page has no width breakpoints.`;
    b.style.color = state.bpLines ? '#c9b6f7' : '#9c958b';
    b.style.borderColor = state.bpLines ? '#7a5fd0' : '#3a3733';
    drawBreakpoints();
  }

  function render() {
    renderViewport();
    renderActions();
    const sent = sentRecs(), unsent = unsentRecs();
    $('nudge-list').style.display = state.collapsed ? 'none' : '';
    $('nudge-hint').style.display = state.collapsed ? 'none' : '';
    const n = state.changes.size, badge = $('nudge-count');
    badge.textContent = String(n);
    badge.style.display = state.collapsed && n ? '' : 'none';
    $('nudge-copy').textContent = state.copyLock ? 'Copied' : (sent.length && !unsent.length ? 'Clear preview' : 'Copy for Claude Code');
    $('nudge-recopy').style.display = sent.length ? '' : 'none';
    $('nudge-reload').style.display = sent.some((r) => r.sentSeq < state.reloadSeq) ? 'block' : 'none';
    const v = $('nudge-verdict');
    v.style.display = state.verdict && !state.collapsed ? 'block' : 'none';
    v.textContent = state.verdict || '';
    v.style.background = state.verdict && /not applied/.test(state.verdict) ? '#3a2f12' : '#1f2e22';
    v.style.color = state.verdict && /not applied/.test(state.verdict) ? '#f2c86b' : '#9fd3a8';

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
    if (!m || m === 'none' || !r.base.capped) return '';
    const n = /^(\d+(?:\.\d+)?)px$/.exec(m);
    if (n && !Number.isInteger(parseFloat(n[1]))) return ` (the element was capped at ${rnd(parseFloat(n[1]))}px by a computed max-width, check the source for the rule)`;
    return ` (was capped by max-width: ${m})`;
  }

  function report(recs = allRecs()) {
    const lines = [];
    lines.push(`nudge batch · ${location.href} · viewport ${innerWidth}×${innerHeight} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    lines.push(viewportLine());
    lines.push('');
    let responsive = false;
    recs.forEach((r, i) => {
      lines.push(`${i + 1}. ${label(r.el)}`);
      if (r.matched && !r.removed && document.contains(r.matched.el)) lines.push(`   make this match ${label(r.matched.el)}: ${r.matched.props.join(', ')}`);
      if (r.removed) lines.push('   remove this element from the markup');
      else if (r.text != null) lines.push(`   ${textChange(collapse(r.baseText), collapse(r.text))}`);
      if (r.w != null) {
        lines.push(`   width ${rnd(r.base.w)}px → ${rnd(r.w)}px${capNote(r)}`);
      }
      if (r.h != null) lines.push(`   height ${rnd(r.base.h)}px → ${rnd(r.h)}px`);
      if (!r.removed) TYPE.forEach((d) => {
        if (!r.type[d.key]) return;
        lines.push(`   ${typeLine(r, d)}`);
        const units = typeUnitsLine(r, d);
        if (units) lines.push(`   ${units}`);
      });
      if (!r.removed) COLOUR.forEach((d) => { if (r.colour[d.key]) lines.push(`   ${colourLine(r, d)}`); });
      const note = ratioNote(r);
      if (note) lines.push(`   ${note}`);
      if (r.dx || r.dy) {
        const mv = [];
        if (r.dx) mv.push(`${r.dx > 0 ? 'right' : 'left'} ${Math.abs(rnd(r.dx))}px`);
        if (r.dy) mv.push(`${r.dy > 0 ? 'down' : 'up'} ${Math.abs(rnd(r.dy))}px`);
        lines.push(`   moved ${mv.join(', ')}`);
      }
      r.snaps.forEach((s) => lines.push(`   ${s}`));
      if (r.gap && !r.removed) lines.push(`   gap to ${label(r.gap.other)} ${r.gap.from}px → ${r.gap.to}px (${r.gap.source})`);
      guardLines(r).forEach((g) => lines.push(`   ${g}`));
      if (r.also) lines.push(`   apply the same to its ${r.also.length} sibling${r.also.length > 1 ? 's' : ''} (${r.also.length + 1} × ${descriptor(r.el).split(' > ').pop()} in total)`);
      if (!r.removed) { const rn = responsiveNote(r.el); if (rn) { lines.push(`   ${rn}`); responsive = true; } }
      lines.push('');
    });
    // Only the guidance this batch needs.
    const moved = (r) => !r.removed && (r.dx || r.dy);
    lines.push(FOOTER.apply);
    if (recs.some((r) => moved(r) && r.moveAligned)) lines.push(FOOTER.aligned);
    if (recs.some((r) => moved(r) && !r.moveAligned)) lines.push(FOOTER.spacing);
    if (recs.some((r) => !r.removed && (r.w != null || r.h != null))) lines.push(FOOTER.widths);
    if (recs.some((r) => !r.removed && Object.keys(r.type).length)) lines.push(FOOTER.type);
    if (recs.some((r) => !r.removed && Object.keys(r.colour).length)) lines.push(FOOTER.colour);
    if (recs.some((r) => !r.removed && r.text != null)) lines.push(FOOTER.text);
    if (recs.some((r) => r.removed)) lines.push(FOOTER.removals);
    if (recs.some((r) => r.gap && !r.removed)) lines.push(FOOTER.gap);
    if (recs.some((r) => r.matched && !r.removed)) lines.push(FOOTER.match);
    if (recs.some((r) => r.also)) lines.push(FOOTER.siblings);
    if (responsive) lines.push(FOOTER.responsive);
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
    const text = report(recs);
    if (!(await writeClipboard(text))) { setStatus('Copy failed. Nothing was marked as sent.'); return; }
    remember(recs);
    state.batch++;
    state.history.push({ batch: state.batch, at: new Date().toISOString(), text });
    state.recopies = 0;
    recs.forEach((r) => { r.sent = true; r.sentBatch = state.batch; r.sentSeq = state.reloadSeq; });
    state.notice = null;
    state.copyLock = true;
    render();
    setStatus(SENT);
    setTimeout(() => { state.copyLock = false; render(); }, 900);
  }

  // Hands the unsent batch to a caller that is not the clipboard (Claude Code's own mod reads it through the
  // browser), and marks those changes sent exactly as Copy does. Returns null when there is nothing new.
  function take() {
    const recs = unsentRecs();
    if (!recs.length) return null;
    const text = report(recs);
    remember(recs);
    state.batch++;
    state.history.push({ batch: state.batch, at: new Date().toISOString(), text });
    state.recopies = 0;
    recs.forEach((r) => { r.sent = true; r.sentBatch = state.batch; r.sentSeq = state.reloadSeq; });
    state.notice = null;
    render();
    setStatus(SENT);
    return text;
  }

  async function recopy() {
    let recs = sentRecs().filter((r) => r.sentBatch === state.batch);
    if (!recs.length) recs = sentRecs();
    if (!recs.length) return;
    if (!(await writeClipboard(report(recs)))) { setStatus('Copy failed. Try again.'); return; }
    state.recopies++;
    setStatus(state.recopies >= 2 ? `Copied again (${state.recopies}×). If the agent is not applying it, paste the batch as the whole message, with nothing before it.` : 'Copied again. Clear the preview once your agent has applied it.');
  }

  function clearPreview() {
    sentRecs().forEach(undo);
    state.notice = null;
    render(); updateBoxes();
    setStatus('Preview cleared. This is the live page.');
    verify('clear');
  }

  function primary() {
    if (state.copyLock) return;
    if (unsentRecs().length) copy();
    else if (sentRecs().length) clearPreview();
    else setStatus('Nothing to copy yet.');
  }

  const typeInput = (key) => panel.querySelector(`input[data-prop="${key}"]`);
  const FIELDS = [...TYPE, ...SIZE];
  const fieldDef = (key) => FIELDS.find((x) => x.key === key);

  function setSize(d, value, how) {
    const el = state.selected;
    if (!el || !isFinite(value)) return;
    state.notice = null;
    const r = rec(el);
    const b = el.getBoundingClientRect();
    let v = Math.max(d.min, value);
    if (how === 'step') {
      state.candidates = collectCandidates(el);
      const f = fitSize(d.axis === 'x' ? b.left : b.top, v, d.axis, d.tol);
      v += f.d;
    }
    const base = r.base[d.key];
    r[d.key] = Math.abs(v - base) < 0.5 ? null : rnd(v);
    if (!state.matching) r.matched = null;
    apply(r);
    finish(r, false);
    renderProps();
    setStatus(withNotice(summary(r) || descriptor(el)));
  }

  function sizeFrom(d) {
    const el = state.selected, r = state.changes.get(el);
    if (r && r[d.key] != null) return r[d.key];
    const b = el.getBoundingClientRect();
    return d.key === 'w' ? b.width : b.height;
  }

  // Controls appear only for the selected element and only when they apply to it.
  function renderProps() {
    const el = state.selected;
    const ok = !!el && document.contains(el) && !INTRINSIC.test(el.tagName.toUpperCase());
    const showType = ok && ownText(el);
    const colours = ok ? COLOUR.filter((d) => d.relevant(el) || (state.changes.get(el) && state.changes.get(el).colour[d.key])) : [];
    const showSize = !!el && document.contains(el) && !state.collapsed;
    $('nudge-size').style.display = showSize ? '' : 'none';
    if (showSize) { const r = el && state.changes.get(el); SIZE.forEach((d) => { const i = typeInput(d.key); if (document.activeElement !== i || (r && r[d.key] != null)) i.value = fmt(sizeFrom(d)); }); }
    $('nudge-type').style.display = showType ? '' : 'none';
    $('nudge-colour').style.display = colours.length ? '' : 'none';
    $('nudge-colour').style.marginTop = showType && colours.length ? '8px' : '0';
    $('nudge-props').style.display = (showType || colours.length) && !state.collapsed ? '' : 'none';
    renderColour(el, colours);
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
    if (d.kind === 'size') {
      const size = mods.altKey ? d.fine : mods.shiftKey ? d.big : d.step;
      setSize(d, sizeFrom(d) + dir * size, mods.altKey ? 'fine' : 'step');
      return;
    }
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

  // Chips show each relevant colour and its token. The palette opens from a chip, tokens first, the picker last.
  function renderColour(el, colours) {
    const chips = $('nudge-chips'), pal = $('nudge-palette');
    if (!colours.length) { chips.textContent = ''; pal.textContent = ''; pal.style.display = 'none'; pal.dataset.for = ''; return; }
    if (state.palette && !colours.some((d) => d.key === state.palette)) state.palette = null;
    const r = state.changes.get(el);
    const current = (d) => {
      const c = r && r.colour[d.key];
      if (c) return { css: c.css, names: c.names, rgba: c.rgba };
      const rgba = toRGBA(cs(el)[d.key]);
      return { css: hexOf(rgba), names: matchNames(rgba), rgba };
    };
    chips.textContent = '';
    colours.forEach((d) => {
      const cur = current(d);
      const b = node('button', `flex:1;min-width:0;display:flex;align-items:center;gap:6px;background:${state.palette === d.key ? '#34312d' : '#242220'};border:1px solid #3a3733;border-radius:4px;padding:3px 6px;color:#c9c2b7;font:11px ui-monospace,Menlo,monospace;cursor:pointer;text-align:left;`);
      b.dataset.colour = d.key;
      b.appendChild(node('span', `flex-shrink:0;width:12px;height:12px;border-radius:2px;border:1px solid rgba(255,255,255,.25);background:${hexOf(cur.rgba)};`));
      b.appendChild(node('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', `${d.label} ${cur.names.length ? cur.names[0] + (cur.names.length > 1 ? ' +' + (cur.names.length - 1) : '') : cur.css}`));
      b.addEventListener('click', () => { state.palette = state.palette === d.key ? null : d.key; renderProps(); });
      chips.appendChild(b);
    });
    const d = COLOUR.find((x) => x.key === state.palette);
    if (!d) { pal.style.display = 'none'; pal.textContent = ''; pal.dataset.for = ''; return; }
    pal.style.display = '';
    const cur = current(d);
    // Rebuild only when a different palette opens, so the native colour picker is never torn down mid-use.
    const id = `${d.key}`;
    if (pal.dataset.for !== id || pal._el !== el) {
      pal.textContent = ''; pal.dataset.for = id; pal._el = el;
      const { list, declared, unreadable } = tokensNow();
      if (list.length) {
        const grid = node('div', 'display:flex;flex-wrap:wrap;gap:4px;max-height:84px;overflow:auto;padding:2px;');
        grid.id = 'nudge-swatches';
        list.forEach((t) => {
          const sw = node('button', `width:18px;height:18px;padding:0;border-radius:3px;border:1px solid rgba(255,255,255,.25);background:${hexOf(t.rgba)};cursor:pointer;`);
          sw.dataset.token = t.name; sw.title = t.name;
          sw.addEventListener('click', () => setColour(d, { token: t.name }));
          sw.addEventListener('mouseenter', () => { $('nudge-token-name').textContent = t.name; });
          grid.appendChild(sw);
        });
        pal.appendChild(grid);
        pal.appendChild(node('div', 'margin-top:4px;color:#9c958b;font:11px ui-monospace,Menlo,monospace;min-height:14px;')).id = 'nudge-token-name';
      } else {
        const why = declared ? 'None of the custom properties on :root are colours.' : 'No custom properties are declared on :root.';
        pal.appendChild(node('div', 'color:#c9c2b7;font-size:11px;', why + (unreadable ? ` ${unreadable} stylesheet${unreadable > 1 ? 's' : ''} from other sites could not be read.` : ''))).id = 'nudge-no-tokens';
      }
      const row = node('label', 'display:flex;align-items:center;gap:6px;margin-top:6px;color:#6f6a62;font-size:11px;');
      row.appendChild(document.createTextNode(list.length ? 'Other colour' : 'Pick a colour'));
      const picker = node('input', 'width:28px;height:18px;padding:0;border:0;background:none;cursor:pointer;');
      picker.type = 'color'; picker.id = 'nudge-picker';
      picker.addEventListener('input', () => setColour(d, { hex: picker.value }));
      row.appendChild(picker);
      pal.appendChild(row);
      pal.appendChild(node('div', 'color:#e0a44a;font-size:11px;margin-top:2px;', 'A colour that matches no token is reported as such in the batch.')).id = 'nudge-picker-note';
    }
    const picker = $('nudge-picker');
    if (picker && document.activeElement !== picker) picker.value = hexOf([...cur.rgba.slice(0, 3), 255]);
    pal.querySelectorAll('[data-token]').forEach((sw) => {
      const on = cur.names.includes(sw.dataset.token);
      sw.toggleAttribute('data-match', on);
      sw.style.outline = on ? '2px solid #ece7df' : 'none';
      sw.style.outlineOffset = '1px';
    });
    const nameLine = $('nudge-token-name');
    if (nameLine) nameLine.textContent = cur.names.length ? `${d.label}: ${varList(cur.names)}` : `${d.label}: ${cur.css}, no token`;
  }

  function onTypeKey(e) {
    const d = fieldDef(e.target.dataset.prop);
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
    const d = fieldDef(e.target.dataset.prop);
    if (!d || !state.selected) return;
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) { renderProps(); return; }
    if (d.kind === 'size') { if (Math.abs(sizeFrom(d) - v) >= 0.5) setSize(d, v, 'typed'); return; }
    // A change event also fires when the field loses focus. If nothing changed, do not re-render: rebuilding
    // the rows under the pointer would swallow the click that took the focus away, such as a row's undo.
    const r = state.changes.get(state.selected);
    const cur = r && r.baseType ? typeFrom(r, d) : readType(cs(state.selected))[d.key];
    if (cur != null && Math.abs(cur - v) < 0.005) return;
    setType(d, v, 'typed');
  }

  /* ────────────────────────── selection ────────────────────────── */

  function select(el, keepClimb) {
    if (el !== state.selected) { state.typeCands = null; state.tokens = null; state.palette = null; matchBox.style.display = 'none'; rulerLayer.style.display = 'none'; }
    if (!keepClimb) state.climbed = [];
    state.selected = el;
    updateBoxes();
    renderProps();
    renderActions();
    if (el) showCrumbs(el);
    else setStatus(idleStatus());
  }

  // The selection's ancestry as clickable crumbs in the status line: the same path the descriptor prints,
  // but each step selects. Any later status message simply replaces it.
  function showCrumbs(el) {
    const st = $('nudge-status');
    st.textContent = '';
    const chain = [];
    for (let cur = el, depth = 0; cur && cur !== document.body && cur !== document.documentElement && depth < 3; cur = cur.parentElement, depth++) chain.unshift(cur);
    chain.forEach((cur, i) => {
      if (i) st.appendChild(node('span', 'color:#6f6a62;white-space:pre', ' > '));   // the status still reads as the descriptor
      const crumb = node('span', `cursor:pointer;${cur === el ? 'color:#ece7df' : ''}`, descriptor(cur).split(' > ').pop());
      crumb.dataset.crumb = '';
      crumb.title = cur === el ? 'selected' : 'select this element';
      crumb.addEventListener('click', (e) => { e.stopPropagation(); if (document.contains(cur)) select(cur); });
      st.appendChild(crumb);
    });
    // The pin, when it is not the selection: its name selects it, the × removes it.
    if (state.pin && state.pin !== el && document.contains(state.pin)) {
      const pin = state.pin;
      st.appendChild(node('span', 'color:#6f6a62;white-space:pre', ' · pin: '));
      const name = node('span', 'cursor:pointer;color:#e0a030', descriptor(pin).split(' > ').pop());
      name.dataset.pinned = ''; name.title = 'select the pinned element';
      name.addEventListener('click', (e) => { e.stopPropagation(); select(pin); });
      const off = node('span', 'cursor:pointer;color:#6f6a62;white-space:pre', ' ×');
      off.dataset.unpin = ''; off.title = 'remove the pin';
      off.addEventListener('click', (e) => { e.stopPropagation(); state.pin = null; updatePin(); renderActions(); showCrumbs(el); });
      st.appendChild(name); st.appendChild(off);
    }
  }

  /* ────────────────────────── events ────────────────────────── */

  function onMove(e) {
    if (state.drag) { dragMove(e); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isTool(el) || el === document.body || el === document.documentElement) { hoverBox.style.display = 'none'; rulerLayer.style.display = 'none'; return; }
    showHover(el, el.getBoundingClientRect());
    if ((e.altKey || state.measure) && state.selected) drawRulers(el); else drawRulers(null);
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
    if (state.selected && (el === state.selected || state.selected.contains(el))) { startMoveDrag(e, el); return; }
    if ((e.altKey || state.measure) && state.selected && !el.contains(state.selected)) { startGapDrag(e, el); return; }
    select(el);
  }

  function onClick(e) { if (!isTool(e.target)) { e.preventDefault(); e.stopPropagation(); } }

  // Bind the drag to a record and measure its starting geometry.
  function prime(d) {
    const r = rec(d.el);
    const b = d.el.getBoundingClientRect();
    state.candidates = collectCandidates(d.el);
    d.r = r;
    d.dx0 = r.dx; d.dy0 = r.dy;
    if (d.kind === 'move') d.rect = b;
    else if (d.kind === 'gap') {
      const src = gapSource(state.selected, d.other, d.axis, d.after);
      r.gap = { other: state.selected, axis: d.axis, from: rnd(d.gap0), to: rnd(d.gap0), target: src.target, prop: src.prop, propFrom: src.propFrom, origInline: src.target.style[src.prop], source: src.text };
    } else { d.w0 = b.width; d.h0 = b.height; d.left = b.left; d.top = b.top; d.right = b.right; d.bottom = b.bottom; }
  }

  function startDrag(e, d) {
    d.el = d.kind === 'gap' ? d.other : state.selected; d.startX = e.clientX; d.startY = e.clientY; d.r = null;
    state.notice = null;
    const existing = state.changes.get(d.el);
    // Every drag waits for real movement: a click that does not move selects what was clicked (see onUp), and a
    // click on a handle or on a sent element records nothing and clears nothing.
    void existing;
    state.drag = d;
    document.body.style.userSelect = 'none';
  }

  // The element under the pointer is remembered so a click inside the selection can select it.
  function startMoveDrag(e, target) { startDrag(e, { kind: 'move', target }); }
  function startResize(e, handle) { startDrag(e, { kind: 'resize', handle }); }

  function dragMove(e) {
    const d = state.drag;
    if (!d.r) {
      // Under 3px is a click, not a drag: it should not become a 1px move.
      if (Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return;
      prime(d);
    }
    const r = d.r;
    const ddx = e.clientX - d.startX, ddy = e.clientY - d.startY;
    if (d.kind === 'gap') {
      const along = d.axis === 'x' ? ddx : ddy;
      r.gap.to = Math.max(0, rnd(d.gap0 + (d.after ? along : -along)));
      d.shift = true;   // a gap has no alignment to record
      apply(r); updateBoxes(); drawRulers(d.other);
      setStatus(withNotice(summary(r)));
      return;
    }
    if (d.kind === 'move') {
      let dx = d.dx0 + ddx, dy = d.dy0 + ddy;
      let s = null;
      if (e.shiftKey) { if (Math.abs(ddx) >= Math.abs(ddy)) dy = d.dy0; else dx = d.dx0; }   // Shift: one axis, no snap
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
      const hd = d.handle;
      const hasW = hd.includes('w'), hasE = hd.includes('e'), hasN = hd.includes('n'), hasS = hd.includes('s');
      const driveX = hasW || hasE, driveY = hasN || hasS;
      // Option (or Control) locks the ratio. Command resizes from the centre, so the opposite edge moves too.
      const centre = e.metaKey;
      const lock = e.altKey || e.ctrlKey;
      const ratio = d.h0 > 0 ? d.w0 / d.h0 : 0;
      r.locked = lock && ratio > 0;
      // Size change asked for by the dragged edge; from the centre, both edges move so it doubles.
      const sx = (hasE ? ddx : hasW ? -ddx : 0) * (centre ? 2 : 1);
      const sy = (hasS ? ddy : hasN ? -ddy : 0) * (centre ? 2 : 1);
      let w = d.w0, h = d.h0, setW = false, setH = false;
      const fitX = (val) => { if (e.shiftKey || centre) return val; const f = fitSize(hasW ? d.right : d.left, val, 'x', SNAP, hasW ? 'start' : 'end'); s.x = f.edge; s.match = s.match || f.match; return val + f.d; };
      const fitY = (val) => { if (e.shiftKey || centre) return val; const f = fitSize(hasN ? d.bottom : d.top, val, 'y', SNAP, hasN ? 'start' : 'end'); s.y = f.edge; s.match = s.match || f.match; return val + f.d; };
      if (r.locked) {
        // One axis drives, the other follows. On a corner the larger movement wins.
        const drive = driveX && driveY ? (Math.abs(ddx) >= Math.abs(ddy) ? 'x' : 'y') : (driveX ? 'x' : 'y');
        if (drive === 'x') { w = fitX(Math.max(8, d.w0 + sx)); h = w / ratio; }
        else { h = fitY(Math.max(8, d.h0 + sy)); w = h * ratio; }
        setW = setH = true;
      } else {
        if (driveX) { w = fitX(Math.max(8, d.w0 + sx)); setW = true; }
        if (driveY) { h = fitY(Math.max(8, d.h0 + sy)); setH = true; }
      }
      if (setW) r.w = rnd(w);
      if (setH) r.h = rnd(h);
      // Where the box now sits: a start edge that moved, or both edges around a fixed centre.
      const gw = (setW ? r.w : d.w0) - d.w0, gh = (setH ? r.h : d.h0) - d.h0;
      r.dx = rnd(centre ? d.dx0 - gw / 2 : hasW ? d.dx0 - gw : d.dx0);
      r.dy = rnd(centre ? d.dy0 - gh / 2 : hasN ? d.dy0 - gh : d.dy0);
      apply(r); showGuides(s); updateBoxes();
      setStatus(withNotice(summary(r)));
    }
  }

  function onUp() {
    if (!state.drag) return;
    const { r, shift, kind, target, other } = state.drag;
    state.drag = null;
    document.body.style.userSelect = '';
    showGuides(null);
    if (r) finish(r, shift);
    else if (kind === 'move' && target) { if (target !== state.selected) select(target); else if (state.selected) showCrumbs(state.selected); }   // a click, not a drag; on the selection it restores the crumbs
    else if (kind === 'gap' && state.drag === null && other) select(other);             // a click while measuring selects
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
    if (e.key === 'Escape') { if (state.measure) toggleMeasure(); else select(null); return; }
    if ((e.key === 'x' || e.key === 'X') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleXray(); return; }
    if (!state.selected) return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePin(); return; }
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); matchPin(); return; }
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleSiblings(); return; }
    }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeSelected(); return; }
    // Option+ArrowUp climbs to the parent, which is the only way to reach a wrapper whose surface is all children.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const cur = state.selected;
      if (e.key === 'ArrowUp') {
        const parent = cur.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) { setStatus(`${descriptor(cur)} · already at the top`); return; }
        state.climbed.push(cur); select(parent, true);
      } else {
        const child = state.climbed.pop();
        if (!child || child.parentElement !== cur) { state.climbed = []; setStatus(`${descriptor(cur)} · nothing to go back down to`); return; }
        select(child, true);
      }
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

  let xrayFrame = 0;
  function onScroll() { updateBoxes(); hoverBox.style.display = 'none'; rulerLayer.style.display = 'none'; if (state.xray && !xrayFrame) xrayFrame = requestAnimationFrame(() => { xrayFrame = 0; drawXray(); }); }

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
    state.bp = null;
    render(); updateBoxes();
  });

  /* ────────────────────────── dot ────────────────────────── */

  // The launcher for dormant mode. Bottom left, away from the panel and from the chat widgets and cookie
  // banners that cluster bottom right. A white ring and a dark halo keep it visible on light and dark pages.
  const dot = document.createElement('button');
  dot.type = 'button';
  dot.setAttribute('data-nudge', ''); dot.setAttribute('data-nudge-dot', '');
  dot.title = 'nudge'; dot.setAttribute('aria-label', 'Open nudge');
  dot.style.cssText = `position:fixed;left:14px;bottom:14px;width:10px;height:10px;padding:0;margin:0;border:0;border-radius:50%;
    background:#2f6fed;box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(0,0,0,.4);opacity:.5;cursor:pointer;z-index:${Z + 1};
    transition:${matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity .15s'};`;
  const dotOpacity = () => { dot.style.opacity = (dot.matches(':hover') || dot.matches(':focus-visible')) ? '1' : '.5'; };
  ['mouseenter', 'mouseleave', 'focus', 'blur'].forEach((ev) => dot.addEventListener(ev, dotOpacity));
  dot.addEventListener('click', (e) => {
    if (e.altKey) { state.dotHidden = true; dot.hidden = true; return; }   // Option-click: gone until reload, for screenshots
    wake();
  });

  /* ────────────────────────── mount / wake / sleep ────────────────────────── */

  const pageListeners = [
    [document, 'mousemove', onMove], [document, 'mousedown', onDown], [document, 'mouseup', onUp],
    [document, 'click', onClick], [document, 'keydown', onKey], [document, 'contextmenu', onContext],
    [document, 'dblclick', onDblClick], [document, 'beforeinput', onBeforeInput], [document, 'paste', onPaste],
    [document, 'drop', onDrop], [window, 'scroll', onScroll], [window, 'resize', onResize],
  ];
  function onResize() { onScroll(); renderViewport(); }

  let headTarget = null;
  function observeHead() {
    headObserver.disconnect();
    headTarget = document.head;
    if (headTarget) headObserver.observe(headTarget, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
  }

  function wake() {
    if (state.awake) return;
    state.awake = true;
    pageListeners.forEach(([t, ev, fn]) => t.addEventListener(ev, fn, true));
    observeHead();
    overlay.style.display = ''; panel.style.display = 'flex';
    dot.hidden = true;
    state.bp = null;
    render(); updateBoxes(); renderProps();
  }

  // Sleeping discards previews, as closing does, so nothing invisible is left masking the real page.
  function sleep() {
    if (!state.awake) return;
    state.measure = false;
    resetAll();
    pageListeners.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn, true));
    headObserver.disconnect(); headTarget = null;
    state.awake = false;
    hoverBox.style.display = 'none'; showGuides(null); bpLayer.style.display = 'none'; xrayLayer.style.display = 'none'; rulerLayer.style.display = 'none'; pinBox.style.display = 'none';
    overlay.style.display = 'none'; panel.style.display = 'none';
    dot.hidden = state.dotHidden;
  }

  const close = () => (DORMANT ? sleep() : destroy());
  const toggle = () => (DORMANT ? (state.awake ? sleep() : wake()) : destroy());

  // A single-page app changes the page without reloading it. Keep nudge's nodes on <html>, re-observe a
  // replaced <head>, and drop records and the selection when their elements have left the document.
  const rootObserver = new MutationObserver(() => keepMounted());
  function keepMounted() {
    const root = document.documentElement;
    (DORMANT ? [overlay, panel, dot] : [overlay, panel]).forEach((n) => { if (n.parentNode !== root) root.appendChild(n); });
    if (state.awake && document.head !== headTarget) observeHead();
  }
  function reconcile() {
    keepMounted();
    let dropped = false;
    allRecs().forEach((r) => { if (!document.contains(r.el)) { state.changes.delete(r.el); dropped = true; } });
    if (state.editing && !document.contains(state.editing.el)) exitEditMode();
    if (state.selected && !document.contains(state.selected)) select(null);
    if (dropped) render();
    updateBoxes();
  }
  const afterNav = () => { setTimeout(reconcile, 0); setTimeout(reconcile, 300); };   // frameworks render after the URL changes
  const origPush = history.pushState, origReplace = history.replaceState;
  function hookHistory() {
    history.pushState = function () { const r = origPush.apply(this, arguments); afterNav(); return r; };
    history.replaceState = function () { const r = origReplace.apply(this, arguments); afterNav(); return r; };
    window.addEventListener('popstate', afterNav);
  }
  function unhookHistory() {
    if (history.pushState !== origPush) history.pushState = origPush;
    if (history.replaceState !== origReplace) history.replaceState = origReplace;
    window.removeEventListener('popstate', afterNav);
  }

  function mount() {
    if (panel.parentNode) return;
    const root = document.documentElement;
    root.appendChild(overlay); root.appendChild(panel);
    if (DORMANT) root.appendChild(dot);   // the bookmarklet path has no dot at all
    $('nudge-copy').addEventListener('click', primary);
    $('nudge-recopy').addEventListener('click', recopy);
    $('nudge-reset').addEventListener('click', resetAll);
    $('nudge-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    $('nudge-head').addEventListener('click', () => setCollapsed(!state.collapsed));
    $('nudge-vp').addEventListener('click', (e) => { e.stopPropagation(); state.bpLines = !state.bpLines; renderViewport(); });
    $('nudge-xray').addEventListener('click', (e) => { e.stopPropagation(); toggleXray(); });
    FIELDS.forEach((d) => { const i = typeInput(d.key); i.addEventListener('keydown', onTypeKey); i.addEventListener('change', onTypeChange); addSteppers(d); });
    rootObserver.observe(root, { childList: true });
    hookHistory();
    overlay.style.display = 'none'; panel.style.display = 'none';
    if (DORMANT) render(); else wake();
    verifyAfterLoad();
  }

  function destroy() {
    if (state.awake) { resetAll(); pageListeners.forEach(([t, ev, fn]) => t.removeEventListener(ev, fn, true)); }
    state.awake = false;
    headObserver.disconnect(); rootObserver.disconnect(); unhookHistory();
    overlay.remove(); panel.remove(); dot.remove();
    delete window.__nudge;
  }

  // A script tag in <head> runs before <body> exists; nothing here needs the body until then.
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  window.__nudge = {
    destroy, wake, sleep, toggle, close, report, take, verify,
    history: () => state.history.slice(),
    breakpoints: () => ({ points: breakpoints().points.slice(), unreadable: breakpoints().unreadable, range: rangeOf(innerWidth).text }),
    // Test hook. Read-only view of internal state; no behavioural effect.
    _state: {
      get selected() { return state.selected; },
      get changes() { return [...state.changes.values()]; },
      get candidates() { return state.candidates; },
      get drag() { return state.drag; },
      get batch() { return state.batch; },
      get reloadSeq() { return state.reloadSeq; },
      get editing() { return state.editing && state.editing.el; },
      get awake() { return state.awake; },
      get mode() { return DORMANT ? 'dormant' : 'bookmarklet'; },
      get collapsed() { return state.collapsed; },
      get bpLines() { return state.bpLines; },
      get xray() { return state.xray; },
      get pin() { return state.pin; },
      get measure() { return state.measure; },
      get verdict() { return state.verdict; },
      els: { overlay, panel, selBox, hoverBox, guideH, guideV, matchBox, handles, dot, bpLayer, xrayLayer, rulerLayer, hoverTag, pinBox },
    },
  };
})();
