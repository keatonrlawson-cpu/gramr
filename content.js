// Gramr content script — injected into every page

(function () {
  "use strict";

  // ─── State ──────────────────────────────────────────────────────────────────
  let enabled = true;
  let activeTooltip = null;
  let highlightContainer = null;
  let currentInput = null;
  let debounceTimer = null;
  let findings = [];
  let findingsTarget = null;   // the element whose text was last analyzed
  let sessionStats = { errors: 0, warnings: 0, info: 0, seen: new Set() };
  let dialect = "us";
  let dialectCache = null;     // { map, re } built lazily per dialect
  let overlaySvg = null;       // SVG underline layer (paired with highlightContainer)
  let currentRender = null;    // { el, text, findings } of the visible overlay
  let repositionQueued = false;
  let siteDisabled = false;
  let disabledRules = new Set();
  let ignoredFindings = new Set(); // "type:matched text" the user chose to ignore
  let lastCheckedText = null;
  let historyLocal = {};           // mirror of chrome.storage.local history
  let streakTouchedDay = null;
  // Optional features — all on by default, toggleable in the popup
  let prefs = { gamification: true, badges: true, focus: true, history: true, adaptive: true, quiz: true, proveIt: false };

  // ─── Learning model ──────────────────────────────────────────────────────────
  // Every rule is a "slip" (typing accident — don't teach), a "habit" (style
  // pattern — nudge gently), or a knowledge "gap" (teachable rule — the default).
  const SLIP_RULES = new Set(["misspelling", "repeated-word"]);
  const HABIT_RULES = new Set([
    "wordy", "passive-voice", "oxford-comma", "try-and",
    "dialect-spelling", "redundant-acronym", "redundant-pair",
    "informal-abbreviation",
  ]);
  function ruleKind(type) {
    if (SLIP_RULES.has(type)) return "slip";
    if (HABIT_RULES.has(type)) return "habit";
    return "gap";
  }

  // Mastery 0–1 from the rule's history: recent error rate pulls it down,
  // quiet days and applied corrections push it up. New errors after a quiet
  // stretch automatically drop the score again (regression reopens teaching).
  function computeMastery(h, now = Date.now()) {
    if (!h || !h.count) return 1;
    const week = Math.floor(now / 604800000);
    const w0 = (h.weeks && h.weeks[week]) || 0;
    const w1 = (h.weeks && h.weeks[week - 1]) || 0;
    const daysQuiet = h.last ? (now - h.last) / 86400000 : 999;
    let base = 1 - Math.min(1, w0 * 0.2 + w1 * 0.1);
    base += 0.15 * Math.min(1, (h.applied || 0) / h.count);
    base = Math.min(1, base);
    const quietFactor = Math.min(1, 0.5 + daysQuiet * 0.07);
    return Math.max(0, Math.min(1, base * quietFactor));
  }

  function bandFor(score) {
    return score < 0.4 ? "learning" : score < 0.8 ? "improving" : "mastered";
  }

  // ─── Settings ────────────────────────────────────────────────────────────────
  const DEBOUNCE_MS = 800;
  const SEVERITY_COLORS = {
    error: "#ef4444",
    warning: "#f59e0b",
    info: "#3b82f6",
  };

  // ─── Init ─────────────────────────────────────────────────────────────────────
  chrome.storage.sync.get(
    { enabled: true, dialect: "us", disabledSites: [], disabledRules: [], prefs: null },
    (res) => {
      enabled = res.enabled;
      dialect = res.dialect;
      siteDisabled = res.disabledSites.includes(location.hostname);
      disabledRules = new Set(res.disabledRules);
      if (res.prefs) prefs = { ...prefs, ...res.prefs };
      if (enabled && !siteDisabled) attachListeners();
    }
  );
  chrome.storage.local.get({ ignoredFindings: [], history: {} }, (res) => {
    ignoredFindings = new Set(res.ignoredFindings);
    historyLocal = res.history;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      if (changes.enabled) {
        enabled = changes.enabled.newValue;
        if (!enabled) {
          removeAllHighlights();
        } else if (!siteDisabled) {
          attachListeners();
        }
      }
      if (changes.dialect) {
        dialect = changes.dialect.newValue;
        dialectCache = null;
        recheck();
      }
      if (changes.disabledSites) {
        siteDisabled = changes.disabledSites.newValue.includes(location.hostname);
        if (siteDisabled) {
          removeAllHighlights();
        } else if (enabled) {
          attachListeners();
          recheck();
        }
      }
      if (changes.disabledRules) {
        disabledRules = new Set(changes.disabledRules.newValue);
        recheck();
      }
      if (changes.prefs) {
        prefs = { ...prefs, ...(changes.prefs.newValue || {}) };
      }
    }
    if (area === "local") {
      if (changes.ignoredFindings) ignoredFindings = new Set(changes.ignoredFindings.newValue);
      if (changes.history) historyLocal = changes.history.newValue || {};
    }
  });

  function recheck() {
    lastCheckedText = null;
    if (enabled && !siteDisabled && currentInput) scheduleCheck(currentInput);
  }

  let listenersAttached = false;
  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    loadDictionary();
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("click", onDocClick, true);
    // Capture-phase scroll catches both page scroll and scrolling inside the
    // field itself (scroll doesn't bubble, but capture still sees it).
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && activeTooltip) closeTooltip();
    }, true);
    // If a field was already focused before our listeners attached (autofocus
    // pages, or the extension enabling mid-session), adopt it now — focusin
    // will never fire for it.
    const active = document.activeElement;
    if (active && isEditable(active) && active !== currentInput) {
      currentInput = active;
      active.addEventListener("input", onInput);
      scheduleCheck(active);
    }
  }

  function onViewportChange(e) {
    // Ignore scrolls inside our own tooltip
    if (activeTooltip && e.target instanceof Node && activeTooltip.contains(e.target)) return;
    if (!currentRender || repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      if (!currentRender) return;
      const { el, text, findings: fs } = currentRender;
      if (!el.isConnected) {
        removeAllHighlights();
        return;
      }
      // Scrolling inside the field changes which lines are visible → re-render.
      // Page scroll / resize just moves the field → re-render too (it also
      // handles reflow-induced wrapping changes). rAF keeps this cheap enough.
      renderHighlights(el, text, fs);
    });
  }

  // ─── Focus / blur ────────────────────────────────────────────────────────────
  function onFocusIn(e) {
    // composedPath()[0] reaches the real target inside shadow roots, where
    // e.target is retargeted to the shadow host
    const el = (e.composedPath ? e.composedPath()[0] : e.target);
    if (!isEditable(el)) return;
    currentInput = el;
    el.addEventListener("input", onInput);
    // Run immediately on focus so existing text is checked
    scheduleCheck(el);
  }

  function onFocusOut(e) {
    if (e.target === currentInput) {
      clearTimeout(debounceTimer);
      // Keep highlights visible after blur
    }
  }

  function onInput(e) {
    scheduleCheck(e.target);
  }

  function onDocClick(e) {
    const target = (e.composedPath ? e.composedPath()[0] : e.target);
    if (activeTooltip && !activeTooltip.contains(target)) {
      closeTooltip();
    }
  }

  // ─── Text extraction ─────────────────────────────────────────────────────────
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      // Never touch password fields — reading or underlining them is a privacy hazard
      return ["text", "search", "email", "url", "tel", ""].includes(t);
    }
    if (el.tagName === "TEXTAREA") return true;
    return false;
  }

  function getText(el) {
    if (el.isContentEditable) return buildEditableMap(el).text;
    return el.value || "";
  }

  // Canonical text extraction for contenteditable: walks the DOM building the
  // exact string we analyze AND a map from string offsets back to text nodes.
  // (innerText's newline rules differ from text-node concatenation, so using it
  // for analysis while walking nodes for replacement causes offset drift.)
  const BLOCK_TAGS = new Set([
    "DIV", "P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
    "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "FIGCAPTION",
  ]);
  const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

  function buildEditableMap(el) {
    const parts = [];
    const map = [];   // { node, start, length } per text node
    let pos = 0;
    (function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        if (t.length) {
          map.push({ node, start: pos, length: t.length });
          parts.push(t);
          pos += t.length;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) return;
      if (node.tagName === "BR") {
        parts.push("\n");
        pos += 1;
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (BLOCK_TAGS.has(node.tagName) && pos > 0 && parts[parts.length - 1] !== "\n" && !parts[parts.length - 1].endsWith("\n")) {
        parts.push("\n");
        pos += 1;
      }
    })(el);
    return { text: parts.join(""), map };
  }

  // String offset → {node, offset}. Offsets landing on synthetic newlines snap
  // to the end of the previous node (for range ends) or the next node's start.
  function posToNodeOffset(map, index, isEnd) {
    for (let i = 0; i < map.length; i++) {
      const e = map[i];
      if (index < e.start) {
        return isEnd && i > 0
          ? { node: map[i - 1].node, offset: map[i - 1].length }
          : { node: e.node, offset: 0 };
      }
      if (index <= e.start + e.length) {
        if (index === e.start + e.length && !isEnd && i + 1 < map.length) continue;
        return { node: e.node, offset: index - e.start };
      }
    }
    const last = map[map.length - 1];
    return last ? { node: last.node, offset: isEnd ? last.length : last.length } : null;
  }

  // ─── Analysis ────────────────────────────────────────────────────────────────
  function scheduleCheck(el) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(el), DEBOUNCE_MS);
  }

  // Above this size, only the region around the cursor is analyzed
  const LONG_TEXT_LIMIT = 20000;
  const LONG_TEXT_WINDOW = 10000;

  function runCheck(el) {
    if (!enabled || siteDisabled) return;
    const text = getText(el);

    // Nothing changed since the last analysis of this element → skip
    if (el === findingsTarget && text === lastCheckedText && highlightContainer) return;

    findingsTarget = el;
    lastCheckedText = text;
    if (!text.trim()) {
      removeAllHighlights();
      return;
    }
    touchStreak();

    // For very long texts, analyze a window around the cursor (snapped to
    // paragraph boundaries) instead of the whole document.
    let checkText = text;
    let windowStart = 0;
    if (text.length > LONG_TEXT_LIMIT) {
      let cursor = 0;
      try { cursor = el.selectionStart ?? 0; } catch (_) {}
      let start = Math.max(0, cursor - LONG_TEXT_WINDOW / 2);
      let end = Math.min(text.length, cursor + LONG_TEXT_WINDOW / 2);
      const nlBefore = text.lastIndexOf("\n", start);
      if (nlBefore !== -1) start = nlBefore + 1;
      const nlAfter = text.indexOf("\n", end);
      if (nlAfter !== -1) end = nlAfter;
      checkText = text.slice(start, end);
      windowStart = start;
    }

    findings = [];
    for (const rule of RULES) {
      if (disabledRules.has(rule.id)) continue;
      try {
        const ruleFindings = rule.check(checkText);
        findings.push(...ruleFindings);
      } catch (_) {}
    }
    if (windowStart) {
      for (const f of findings) f.index += windowStart;
    }
    // Drop findings the user chose to ignore, then deduplicate by position
    const seen = new Set();
    findings = findings.filter((f) => {
      const matched = text.slice(f.index, f.index + f.length).toLowerCase();
      if (ignoredFindings.has(`${f.type}:${matched}`)) return false;
      const key = `${f.index}:${f.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Document order, so tooltip prev/next moves naturally through the text
    findings.sort((a, b) => a.index - b.index);

    // Record newly seen findings in the mistake history (once per unique occurrence)
    for (const f of findings) {
      const histKey = `${f.index}:${f.type}:${text.slice(f.index, f.index + f.length)}`;
      if (!sessionStats.seen.has(histKey)) {
        sessionStats.seen.add(histKey);
        recordHistory(f, text);
      }
    }

    // Broadcast the counts currently outstanding in this field
    const counts = { errors: 0, warnings: 0, info: 0 };
    for (const f of findings) {
      if (f.severity === "error") counts.errors++;
      else if (f.severity === "warning") counts.warnings++;
      else counts.info++;
    }
    chrome.runtime.sendMessage({
      type: "stats",
      stats: { ...counts, total: findings.length },
    }).catch(() => {});

    renderHighlights(el, text, findings);
  }

  // ─── Highlight rendering ──────────────────────────────────────────────────────
  function removeOverlays() {
    if (highlightContainer) {
      highlightContainer.remove();
      highlightContainer = null;
    }
    if (overlaySvg) {
      overlaySvg.remove();
      overlaySvg = null;
    }
    currentRender = null;
  }

  function removeAllHighlights() {
    removeOverlays();
    closeTooltip();
  }

  function renderHighlights(el, text, allFindings) {
    // Overlays only — the tooltip survives repositioning re-renders
    removeOverlays();
    if (!allFindings.length) return;
    currentRender = { el, text, findings: allFindings };

    // Only underline for textarea / input (contenteditable is harder to overlay)
    if (!el.isContentEditable && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      renderInputHighlights(el, text, allFindings);
    } else if (el.isContentEditable) {
      renderContentEditableHighlights(el, allFindings);
    }
  }

  function renderInputHighlights(el, text, allFindings) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const style = window.getComputedStyle(el);

    // Create an invisible mirror div to measure character positions
    const mirror = document.createElement("div");
    const mirrorStyle = {
      position: "absolute",
      top: "-9999px",
      left: "-9999px",
      width: rect.width + "px",
      height: "auto",
      padding: style.padding,
      border: style.border,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      whiteSpace: el.tagName === "TEXTAREA" ? "pre-wrap" : "pre",
      wordWrap: el.tagName === "TEXTAREA" ? "break-word" : "normal",
      overflowWrap: style.overflowWrap,
      boxSizing: "border-box",
      tabSize: style.tabSize,
    };
    Object.assign(mirror.style, mirrorStyle);
    document.body.appendChild(mirror);

    // SVG overlay — fixed positioning uses pure viewport coordinates
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483640",
      overflow: "hidden",
    });
    overlaySvg = svg;

    // We use clickable spans on top of the SVG for interactivity
    highlightContainer = document.createElement("div");
    Object.assign(highlightContainer.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483641",
      overflow: "hidden",
    });
    highlightContainer.dataset.gramrContainer = "1";
    document.body.appendChild(svg);
    document.body.appendChild(highlightContainer);

    const scrollTop = el.scrollTop;
    const scrollLeft = el.scrollLeft;

    for (const finding of allFindings) {
      const color = SEVERITY_COLORS[finding.severity] || "#6b7280";

      // Measure position using mirror
      mirror.textContent = text.slice(0, finding.index);
      const spanBefore = document.createElement("span");
      spanBefore.textContent = text.slice(finding.index, finding.index + finding.length);
      mirror.appendChild(spanBefore);

      const markerRect = spanBefore.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();

      // markerRect - mirrorRect already accounts for the mirror's border + padding
      // (mirror has identical styling to the textarea), so no extra offset needed.
      const relTop = markerRect.top - mirrorRect.top - scrollTop;
      const relLeft = markerRect.left - mirrorRect.left - scrollLeft;
      const w = markerRect.width;
      const lineH = markerRect.height;

      // Wavy underline via SVG
      const y = relTop + lineH - 2;
      if (y < 0 || y > rect.height || relLeft < 0) {
        mirror.textContent = "";
        continue;
      }

      svg.appendChild(underlinePath(relLeft, y, w, finding.severity, color));

      // Invisible click target
      const clickTarget = document.createElement("div");
      Object.assign(clickTarget.style, {
        position: "absolute",
        top: relTop + "px",
        left: relLeft + "px",
        width: Math.max(w, 10) + "px",
        height: lineH + "px",
        cursor: "pointer",
        pointerEvents: "all",
      });
      clickTarget.dataset.findingIndex = allFindings.indexOf(finding);
      clickTarget.addEventListener("click", (e) => {
        e.stopPropagation();
        showTooltip(finding, e.clientX, e.clientY);
      });
      highlightContainer.appendChild(clickTarget);

      mirror.textContent = "";
    }

    mirror.remove();
  }

  function renderContentEditableHighlights(el, allFindings) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const { map } = buildEditableMap(el);

    // Same overlay pair as inputs: SVG for the squiggles, div for click targets,
    // both fixed at the element's viewport rect with overflow clipping.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483640",
      overflow: "hidden",
    });

    const container = document.createElement("div");
    container.dataset.gramrContainer = "1";
    Object.assign(container.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483641",
      overflow: "hidden",
    });

    let drawn = 0;
    for (const finding of allFindings) {
      const startPos = posToNodeOffset(map, finding.index, false);
      const endPos = posToNodeOffset(map, finding.index + finding.length, true);
      if (!startPos || !endPos) continue;
      const range = document.createRange();
      try {
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
      } catch (_) {
        continue;
      }
      const color = SEVERITY_COLORS[finding.severity] || "#6b7280";
      for (const r of range.getClientRects()) {
        if (!r.width || !r.height) continue;
        const relLeft = r.left - rect.left;
        const relTop = r.top - rect.top;
        const y = relTop + r.height - 2;
        if (y < 0 || y > rect.height || relLeft + r.width < 0 || relLeft > rect.width) continue;

        svg.appendChild(underlinePath(relLeft, y, r.width, finding.severity, color));

        const clickTarget = document.createElement("div");
        Object.assign(clickTarget.style, {
          position: "absolute",
          top: relTop + "px",
          left: relLeft + "px",
          width: Math.max(r.width, 10) + "px",
          height: r.height + "px",
          cursor: "pointer",
          pointerEvents: "all",
        });
        clickTarget.addEventListener("click", (e) => {
          e.stopPropagation();
          showTooltip(finding, e.clientX, e.clientY);
        });
        container.appendChild(clickTarget);
        drawn++;
      }
    }

    if (!drawn) {
      // Range resolution failed (exotic editor DOM) — fall back to the badge
      renderBadgeFallback(el, rect, allFindings);
      return;
    }

    overlaySvg = svg;
    highlightContainer = container;
    document.body.appendChild(svg);
    document.body.appendChild(container);
  }

  function renderBadgeFallback(el, rect, allFindings) {
    highlightContainer = document.createElement("div");
    highlightContainer.dataset.gramrContainer = "1";
    Object.assign(highlightContainer.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + rect.width - 32 + "px",
      zIndex: "2147483641",
      pointerEvents: "all",
    });

    const badge = document.createElement("div");
    badge.className = "gramr-badge";
    badge.textContent = allFindings.length;
    badge.title = `${allFindings.length} suggestion${allFindings.length !== 1 ? "s" : ""}`;
    badge.style.background = allFindings.some((f) => f.severity === "error")
      ? SEVERITY_COLORS.error
      : allFindings.some((f) => f.severity === "warning")
      ? SEVERITY_COLORS.warning
      : SEVERITY_COLORS.info;

    let idx = 0;
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      showTooltip(allFindings[idx % allFindings.length], e.clientX, e.clientY);
      idx++;
    });

    highlightContainer.appendChild(badge);
    document.body.appendChild(highlightContainer);
  }

  // Severity is encoded in the pattern, not just the color, so color-blind
  // users can tell them apart: error = wavy, warning = dashed, info = dotted
  function underlinePath(x, y, width, severity, color) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (severity === "error") {
      path.setAttribute("d", wavyPath(x, y, width));
    } else {
      path.setAttribute("d", `M ${x} ${y} L ${x + width} ${y}`);
      path.setAttribute("stroke-dasharray", severity === "warning" ? "6 3" : "2 4");
      if (severity !== "warning") path.setAttribute("stroke-linecap", "round");
    }
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("fill", "none");
    return path;
  }

  function wavyPath(x, y, width) {
    const amp = 2;
    const freq = 6;
    let d = `M ${x} ${y}`;
    for (let i = 0; i <= width; i += freq / 2) {
      const cx1 = x + i;
      const cy1 = y + amp * (i % freq < freq / 2 ? 1 : -1);
      d += ` Q ${cx1} ${cy1} ${x + i + freq / 4} ${y}`;
    }
    return d;
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────────
  function showTooltip(finding, clientX, clientY) {
    closeTooltip();

    const tip = document.createElement("div");
    tip.className = "gramr-tooltip";

    const severityIcon = { error: "✗", warning: "⚠", info: "ℹ" }[finding.severity] || "•";
    const severityColor = SEVERITY_COLORS[finding.severity];

    const hasCorrection = finding.correction !== undefined;
    const corrPreview = hasCorrection
      ? (finding.correction === ""
          ? "(remove)"
          : `"${finding.correction.length > 28 ? finding.correction.slice(0, 28) + "…" : finding.correction}"`)
      : "";

    // Fading scaffolds: how much teaching this tooltip shows depends on how
    // well the user knows this rule. Slips get minimal treatment always.
    const kind = ruleKind(finding.type);
    let band = kind === "slip" ? "slip" : bandFor(computeMastery(historyLocal[finding.type]));
    if (!prefs.adaptive) band = "learning";        // adaptive off: always full teaching
    const whyOpen = band === "learning";           // full lesson for rules still being learned
    const showLessonSections = band !== "slip";    // slips: message + actions only
    const masteredChip = prefs.badges && band === "mastered"
      ? '<span class="gramr-tip-band" title="You rarely make this mistake anymore">⭐ mastered</span>'
      : "";

    const navIdx = findings.indexOf(finding);
    const navHtml = findings.length > 1 && navIdx !== -1 ? `
        <span class="gramr-tip-nav">
          <button class="gramr-nav-btn" data-nav="-1" aria-label="Previous issue">‹</button>
          <span class="gramr-nav-count">${navIdx + 1}/${findings.length}</span>
          <button class="gramr-nav-btn" data-nav="1" aria-label="Next issue">›</button>
        </span>` : "";

    // Prove-it mode (opt-in): on rules still being learned, Apply is gated
    // behind picking the correct form — the choices are the user's own text
    // vs the correction, so every check uses their real sentence
    const matchedText = findingsTarget
      ? getText(findingsTarget).slice(finding.index, finding.index + finding.length)
      : "";
    const needsProof = prefs.proveIt && hasCorrection && finding.correction !== "" &&
      kind === "gap" && band === "learning" && matchedText &&
      matchedText.toLowerCase() !== finding.correction.toLowerCase();
    const proveChoices = needsProof
      ? (Math.random() < 0.5
          ? [["wrong", matchedText], ["right", finding.correction]]
          : [["right", finding.correction], ["wrong", matchedText]])
      : [];
    const proveHtml = needsProof ? `
        <div class="gramr-prove">
          <div class="gramr-prove-title">🧠 Which is correct?</div>
          ${proveChoices.map(([kindC, txt]) =>
            `<button class="gramr-prove-btn" data-prove-choice="${kindC}">${escHtml(txt)}</button>`).join("")}
          <div class="gramr-prove-hint" data-prove-hint hidden></div>
        </div>` : "";

    tip.innerHTML = `
      <div class="gramr-tip-header" style="border-left-color:${severityColor}">
        <span class="gramr-tip-icon" style="color:${severityColor}">${severityIcon}</span>
        <span class="gramr-tip-label">${escHtml(finding.label)}</span>
        ${masteredChip}${navHtml}
        <button class="gramr-tip-close" aria-label="Close">×</button>
      </div>
      <div class="gramr-tip-body">
        <p class="gramr-tip-message">${escHtml(finding.message)}</p>
        ${proveHtml}
        ${hasCorrection ? `
        <button class="gramr-apply-btn" data-apply="1"${needsProof ? " hidden" : ""}>
          <span class="gramr-apply-check">✓</span>
          <span class="gramr-apply-text">Apply correction</span>
          <span class="gramr-apply-preview">${escHtml(corrPreview)}</span>
        </button>` : ""}
        <button class="gramr-ignore-btn" data-ignore="1" title="Stop flagging this exact word or phrase">Ignore — I meant this</button>
        ${showLessonSections ? `
        <details class="gramr-tip-details"${whyOpen ? " open" : ""}>
          <summary>Why does this matter?</summary>
          <p>${escHtml(finding.explanation)}</p>
        </details>
        <details class="gramr-tip-details">
          <summary>Examples</summary>
          <pre class="gramr-tip-example">${escHtml(finding.example)}</pre>
        </details>` : ""}
        <div class="gramr-tip-fix">
          <strong>How to fix:</strong> ${escHtml(finding.fix)}
        </div>
      </div>
    `;

    tip.querySelector(".gramr-tip-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTooltip();
    });

    for (const nb of tip.querySelectorAll("[data-nav]")) {
      nb.addEventListener("click", (e) => {
        e.stopPropagation();
        const delta = Number(nb.dataset.nav);
        const next = findings[(navIdx + delta + findings.length) % findings.length];
        if (next) showTooltip(next, clientX, clientY);
      });
    }

    if (hasCorrection) {
      tip.querySelector("[data-apply]").addEventListener("click", (e) => {
        e.stopPropagation();
        applyCorrection(finding, tip);
      });
    }

    if (needsProof) {
      const applyBtn = tip.querySelector("[data-apply]");
      const hint = tip.querySelector("[data-prove-hint]");
      for (const pb of tip.querySelectorAll("[data-prove-choice]")) {
        pb.addEventListener("click", (e) => {
          e.stopPropagation();
          const right = pb.dataset.proveChoice === "right";
          for (const b of tip.querySelectorAll("[data-prove-choice]")) {
            b.disabled = true;
            if (b.dataset.proveChoice === "right") b.classList.add("gramr-prove-btn--right");
          }
          if (!right) pb.classList.add("gramr-prove-btn--wrong");
          hint.hidden = false;
          if (right) {
            hint.textContent = "✓ Correct!";
            applyBtn.hidden = false;
            applyCorrection(finding, tip);
          } else {
            hint.textContent = `✗ Not quite — “${finding.correction}” is correct. ${finding.fix}`;
            applyBtn.hidden = false; // let them apply now that they've seen the answer
          }
        });
      }
    }

    tip.querySelector("[data-ignore]").addEventListener("click", (e) => {
      e.stopPropagation();
      ignoreFinding(finding);
    });

    document.body.appendChild(tip);
    activeTooltip = tip;

    // Position: prefer below/right of click, stay in viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipW = 340;
    const tipH = tip.offsetHeight || 300;

    let left = clientX + 12;
    let top = clientY + 12;

    if (left + tipW > vw - 12) left = clientX - tipW - 12;
    if (left < 12) left = 12;
    if (top + tipH > vh - 12) top = clientY - tipH - 12;
    if (top < 12) top = 12;

    tip.style.left = left + "px";
    tip.style.top = top + "px";

    // Animate in
    requestAnimationFrame(() => tip.classList.add("gramr-tooltip--visible"));
  }

  function closeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  // ─── Ignore a finding ─────────────────────────────────────────────────────────
  function ignoreFinding(finding) {
    const el = findingsTarget;
    if (!el) { closeTooltip(); return; }
    const matched = getText(el).slice(finding.index, finding.index + finding.length).toLowerCase();
    ignoredFindings.add(`${finding.type}:${matched}`);
    chrome.storage.local.set({ ignoredFindings: [...ignoredFindings] });
    closeTooltip();
    lastCheckedText = null;
    runCheck(el);
  }

  // ─── Apply correction ─────────────────────────────────────────────────────────
  function applyCorrection(finding, tipEl) {
    const el = findingsTarget;
    if (!el || finding.correction === undefined) return;

    const text = getText(el);
    const before = text.slice(0, finding.index);
    const after  = text.slice(finding.index + finding.length);
    const newText = before + finding.correction + after;

    // Flash the button green before closing
    if (tipEl) {
      const btn = tipEl.querySelector("[data-apply]");
      if (btn) {
        btn.classList.add("gramr-apply-btn--done");
        btn.querySelector(".gramr-apply-text").textContent = prefs.gamification ? "Applied! +5 XP" : "Applied!";
      }
    }

    // The remaining findings' indexes are stale the moment the text changes,
    // so drop them and re-check immediately rather than waiting for the debounce.
    findings = [];
    removeOverlays();

    setTimeout(() => {
      if (el.isContentEditable) {
        replaceInContentEditable(el, finding.index, finding.length, finding.correction);
      } else {
        // Select the target text and use execCommand so the browser's undo
        // stack survives — assigning .value would wipe it
        const cursorPos = finding.index + finding.correction.length;
        el.focus();
        let ok = false;
        try {
          el.setSelectionRange(finding.index, finding.index + finding.length);
          ok = document.execCommand(
            finding.correction === "" ? "delete" : "insertText",
            false,
            finding.correction || undefined
          );
        } catch (_) {}
        if (!ok && getText(el) !== newText) {
          el.value = newText; // fallback (kills undo, but the text is right)
        }
        try { el.setSelectionRange(cursorPos, cursorPos); } catch (_) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      closeTooltip();
      clearTimeout(debounceTimer);
      runCheck(el);
    }, 350);

    // +5 XP per fix; also count the fix against this rule for the mastery model
    chrome.storage.local.get(
      { correctionsApplied: 0, xp: 0, history: {} },
      ({ correctionsApplied, xp, history }) => {
        const h = history[finding.type] || { count: 1, label: finding.label, severity: finding.severity };
        h.applied = (h.applied || 0) + 1;
        history[finding.type] = h;
        const update = { correctionsApplied: correctionsApplied + 1, history };
        if (prefs.gamification) update.xp = xp + 5;
        chrome.storage.local.set(update);
      }
    );
  }

  // ─── Daily streak ─────────────────────────────────────────────────────────────
  function localDay(d) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function touchStreak() {
    if (!prefs.gamification) return;
    const day = localDay(new Date());
    if (streakTouchedDay === day) return;
    streakTouchedDay = day;
    chrome.storage.local.get({ streak: { current: 0, best: 0, lastDay: null }, xp: 0 }, ({ streak, xp }) => {
      if (streak.lastDay === day) return; // another tab already counted today
      const yday = localDay(new Date(Date.now() - 86400000));
      streak.current = streak.lastDay === yday ? streak.current + 1 : 1;
      streak.best = Math.max(streak.best, streak.current);
      streak.lastDay = day;
      // Daily activity XP, with a growing streak bonus (capped at +7)
      chrome.storage.local.set({ streak, xp: xp + 3 + Math.min(streak.current, 7) });
    });
  }

  // ─── Mistake history ──────────────────────────────────────────────────────────
  let historyBuffer = {};
  let historyFlushTimer = null;

  // The sentence fragment around a finding — stored locally so lessons and
  // practice questions can quote the user's own writing back to them
  function snippetFor(text, f) {
    const bounds = /[.!?\n]/;
    let start = f.index;
    while (start > 0 && start > f.index - 120 && !bounds.test(text[start - 1])) start--;
    let end = f.index + f.length;
    while (end < text.length && end < f.index + f.length + 120 && !bounds.test(text[end])) end++;
    let snip = text.slice(start, Math.min(end + 1, text.length)).trim();
    if (snip.length > 90) {
      const mid = f.index - start;
      const from = Math.max(0, mid - 25);
      snip = (from > 0 ? "…" : "") + snip.slice(from, from + 80).trim() + "…";
    }
    return snip;
  }

  function recordHistory(f, text) {
    const entry = historyBuffer[f.type] || (historyBuffer[f.type] = { count: 0, label: f.label, severity: f.severity });
    entry.count++;
    const snip = snippetFor(text, f);
    if (snip) entry.examples = [snip];
    clearTimeout(historyFlushTimer);
    historyFlushTimer = setTimeout(flushHistory, 1500);
  }

  function flushHistory() {
    const buf = historyBuffer;
    historyBuffer = {};
    if (!Object.keys(buf).length) return;
    const week = String(Math.floor(Date.now() / 604800000)); // epoch week number
    chrome.storage.local.get({ history: {} }, ({ history }) => {
      for (const [type, v] of Object.entries(buf)) {
        const h = history[type] || { count: 0 };
        h.count += v.count;
        h.label = v.label;
        h.severity = v.severity;
        h.last = Date.now();
        if (v.examples) h.examples = v.examples.concat(h.examples || []).slice(0, 2);
        h.weeks = h.weeks || {};
        h.weeks[week] = (h.weeks[week] || 0) + v.count;
        // Keep only the last 8 weeks of buckets
        for (const k of Object.keys(h.weeks)) {
          if (Number(week) - Number(k) > 8) delete h.weeks[k];
        }
        history[type] = h;
      }
      chrome.storage.local.set({ history });
    });
  }

  function replaceInContentEditable(el, index, length, replacement) {
    el.focus();
    const { map } = buildEditableMap(el);
    const startPos = posToNodeOffset(map, index, false);
    const endPos = posToNodeOffset(map, index + length, true);

    if (!startPos || !endPos) {
      // Fallback: replace innerText directly
      el.innerText = getText(el).slice(0, index) + replacement + getText(el).slice(index + length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const range = document.createRange();
    try {
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
    } catch (_) {
      return;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // execCommand keeps undo history in the browser
    document.execCommand(replacement === "" ? "delete" : "insertText", false, replacement || undefined);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Grammar rules ────────────────────────────────────────────────────────────

  function hasVerb(text) {
    return /\b(is|are|was|were|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must|be|been|being|\w+s|\w+ed|\w+ing)\b/i.test(text);
  }

  // ─── Misspellings dictionary (500+) ─────────────────────────────────────────
  const MISSPELLINGS = {
    // A
    "absense":"absence","accidently":"accidentally","accomodate":"accommodate",
    "acheive":"achieve","accross":"across","adress":"address","adiquate":"adequate",
    "advertisment":"advertisement","agressive":"aggressive","allegience":"allegiance",
    "alotted":"allotted","alot":"a lot","alltogether":"altogether","ambigious":"ambiguous",
    "anaylsis":"analysis","anonimous":"anonymous","antecedant":"antecedent",
    "appearence":"appearance","apropriate":"appropriate","aproximately":"approximately",
    "aquire":"acquire","arguement":"argument","aritmetic":"arithmetic",
    "arrangment":"arrangement","assasination":"assassination","assesment":"assessment",
    "assistanse":"assistance","attendence":"attendance","attitide":"attitude",
    "audiance":"audience","autority":"authority","availible":"available",
    "aukward":"awkward","amature":"amateur","apparant":"apparent",
    // B
    "baloon":"balloon","bankrupcy":"bankruptcy","basicly":"basically",
    "beautifull":"beautiful","beutiful":"beautiful","becuase":"because",
    "becomming":"becoming","begining":"beginning","beggining":"beginning",
    "benificial":"beneficial","benifit":"benefit","beleive":"believe",
    "buisness":"business",
    // C
    "calender":"calendar","catagory":"category","cemetary":"cemetery",
    "celeberate":"celebrate","certian":"certain","challange":"challenge",
    "charcter":"character","cheif":"chief","choclate":"chocolate",
    "cieling":"ceiling","collegue":"colleague","colum":"column",
    "comfortible":"comfortable","comming":"coming","commitee":"committee",
    "committment":"commitment","comunication":"communication",
    "competiton":"competition","completly":"completely","concieve":"conceive",
    "concious":"conscious","consequense":"consequence","consistant":"consistent",
    "continueing":"continuing","conveniance":"convenience","convienence":"convenience",
    "counterfiet":"counterfeit","courtous":"courteous","critisism":"criticism",
    "curiousity":"curiosity","curriculem":"curriculum",
    // D
    "decieve":"deceive","decisoin":"decision","definate":"definite",
    "definately":"definitely","democrasy":"democracy","desparate":"desperate",
    "developement":"development","differnce":"difference","dilema":"dilemma",
    "disapoint":"disappoint","disasterous":"disastrous","discription":"description",
    "discribe":"describe","dissapear":"disappear","dissappoint":"disappoint",
    "distanse":"distance","divison":"division","dominat":"dominant",
    // E
    "easly":"easily","elimentary":"elementary","ellaborate":"elaborate",
    "embarass":"embarrass","embarrasment":"embarrassment","encunter":"encounter",
    "enought":"enough","entrepeneur":"entrepreneur","enviroment":"environment",
    "enviromental":"environmental","especialy":"especially","expecially":"especially",
    "essencial":"essential","exagerate":"exaggerate","excellant":"excellent",
    "excercise":"exercise","exersize":"exercise","exaust":"exhaust",
    "existance":"existence","experiance":"experience","explaination":"explanation",
    "extrodinary":"extraordinary","electorial":"electoral","eligable":"eligible",
    // F
    "familier":"familiar","facinating":"fascinating","Febuary":"February",
    "ficticious":"fictitious","finaly":"finally","flourescent":"fluorescent",
    "foriegn":"foreign","fourty":"forty","foward":"forward","freind":"friend",
    "fullfill":"fulfill",
    // G
    "generaly":"generally","genuis":"genius","genuiene":"genuine",
    "glamourous":"glamorous","goverment":"government","grammer":"grammar",
    "greatful":"grateful","guarentee":"guarantee","gaurd":"guard",
    "guidanse":"guidance",
    // H
    "hankerchief":"handkerchief","happend":"happened","hight":"height",
    "heros":"heroes","hopefull":"hopeful","humerous":"humorous","hygeine":"hygiene",
    "heirarchy":"hierarchy","hypocracy":"hypocrisy",
    // I
    "ignorence":"ignorance","imagenary":"imaginary","immitate":"imitate",
    "imediate":"immediate","immediatly":"immediately","importent":"important",
    "independant":"independent","indispensible":"indispensable",
    "influense":"influence","ingrediant":"ingredient","inteligence":"intelligence",
    "intresting":"interesting","interupt":"interrupt","iland":"island",
    "incidently":"incidentally","irrelevent":"irrelevant",
    // J
    "jelous":"jealous","jewlery":"jewelry",
    // K
    "knowlege":"knowledge","nowledge":"knowledge",
    // L
    "langauge":"language","liesure":"leisure","lenght":"length",
    "libary":"library","liberry":"library","lisence":"license",
    "lightening":"lightning","liason":"liaison","loveable":"lovable",
    // M
    "mariage":"marriage","mathmatics":"mathematics","medecine":"medicine",
    "medeval":"medieval","minimun":"minimum","miscelaneous":"miscellaneous",
    "mischievious":"mischievous","mispell":"misspell","momento":"memento",
    "morgage":"mortgage","mucsle":"muscle","manuever":"maneuver",
    "maintanance":"maintenance","millenium":"millennium","miniscule":"minuscule",
    // N
    "naieve":"naive","naturaly":"naturally","neccessary":"necessary",
    "neice":"niece","nervious":"nervous","neverthless":"nevertheless",
    "nickle":"nickel","ninty":"ninety","noticable":"noticeable",
    // O
    "ocasionally":"occasionally","ocassionally":"occasionally",
    "occurance":"occurrence","occured":"occurred","offical":"official",
    "omision":"omission","ommit":"omit","oportunity":"opportunity",
    "oposition":"opposition","ordenary":"ordinary","orignal":"original",
    "outragous":"outrageous",
    // P
    "pamflet":"pamphlet","parallell":"parallel","paralel":"parallel",
    "parliment":"parliament","particuarly":"particularly","passtime":"pastime",
    "patiance":"patience","peculier":"peculiar","peice":"piece",
    "percieve":"perceive","permanant":"permanent","permited":"permitted",
    "perseverence":"perseverance","phenominon":"phenomenon",
    "physican":"physician","plagarism":"plagiarism","plausable":"plausible",
    "playright":"playwright","pleasent":"pleasant","posession":"possession",
    "posible":"possible","postion":"position","practicle":"practical",
    "preceed":"precede","prefered":"preferred","preperation":"preparation",
    "presense":"presence","prevailent":"prevalent","principel":"principle",
    "privelege":"privilege","priviledge":"privilege","probly":"probably",
    "problam":"problem","profesional":"professional","professer":"professor",
    "prominant":"prominent","pronounciation":"pronunciation","propoganda":"propaganda",
    "pursuade":"persuade","persue":"pursue","persistant":"persistent",
    "publically":"publicly",
    // Q
    "quanity":"quantity","quarentine":"quarantine","questionaire":"questionnaire",
    // R
    "rediculous":"ridiculous","recomend":"recommend","recomendation":"recommendation",
    "recieve":"receive","referance":"reference","rehersal":"rehearsal",
    "releive":"relieve","relavant":"relevant","relevent":"relevant",
    "religous":"religious","reluctent":"reluctant","repitition":"repetition",
    "resistence":"resistance","rescent":"recent","resturant":"restaurant",
    "restaraunt":"restaurant","roomate":"roommate","routeen":"routine",
    "rythm":"rhythm",
    // S
    "sallary":"salary","schedual":"schedule","sissors":"scissors",
    "sisors":"scissors","secratary":"secretary","sensable":"sensible",
    "sentance":"sentence","seperate":"separate","sargent":"sergeant",
    "similer":"similar","sincerly":"sincerely","sophmore":"sophomore",
    "specail":"special","specefic":"specific","speach":"speech",
    "stomack":"stomach","strenght":"strength","studing":"studying",
    "succede":"succeed","sucess":"success","suficient":"sufficient",
    "supercede":"supersede","superscede":"supersede","suprise":"surprise",
    "suspicous":"suspicious","symetry":"symmetry",
    // T
    "tatoo":"tattoo","technicle":"technical","technolgy":"technology",
    "temperture":"temperature","tendancy":"tendency","therefor":"therefore",
    "thoroough":"thorough","throuh":"through","tommorrow":"tomorrow",
    "tommorow":"tomorrow","tounge":"tongue","tounament":"tournament",
    "tradgedy":"tragedy","transfered":"transferred","treshhold":"threshold",
    "totaly":"totally","trully":"truly","truely":"truly","tyrany":"tyranny",
    "tyranical":"tyrannical",
    // U
    "unfortunatley":"unfortunately","unnecessery":"unnecessary","untill":"until",
    "usualy":"usually","usefull":"useful",
    // V
    "vaccuum":"vacuum","valueable":"valuable","vegatable":"vegetable",
    "vengence":"vengeance","visable":"visible","visability":"visibility",
    "volunter":"volunteer","vunerable":"vulnerable",
    // W
    "Wendsday":"Wednesday","Wensday":"Wednesday","wieght":"weight",
    "wierd":"weird","wether":"whether","wich":"which","writting":"writing",
    // Y
    "yatch":"yacht","yeild":"yield",
    // Additional entries to reach 500+
    // A (more)
    "absense":"absence","accidentaly":"accidentally","acomodate":"accommodate",
    "adaquate":"adequate","aggrieve":"aggrieve","agravate":"aggravate",
    "agreable":"agreeable","alledge":"allege","allready":"already",
    "allways":"always","almoust":"almost","alot":"a lot","altough":"although",
    "analagous":"analogous","anual":"annual","apologise":"apologize",
    "appal":"appall","aquaintance":"acquaintance","archetect":"architect",
    "artefact":"artifact","assit":"assist","atribute":"attribute",
    "awfull":"awful",
    // B (more)
    "barbarian":"barbarian","begginer":"beginner","benivolent":"benevolent",
    "besige":"besiege","bogus":"bogus","boundry":"boundary",
    "briliant":"brilliant","brutaly":"brutally","buget":"budget",
    // C (more)
    "camoflage":"camouflage","capabilty":"capability","carear":"career",
    "carful":"careful","carribean":"Caribbean","cataloge":"catalog",
    "catagories":"categories","centry":"century","certin":"certain",
    "chalenging":"challenging","champain":"champagne","charecter":"character",
    "charming":"charming","circomstance":"circumstance","citezenship":"citizenship",
    "clasify":"classify","colaberative":"collaborative","colaege":"colleague",
    "comision":"commission","comparason":"comparison","compatable":"compatible",
    "compitition":"competition","conceed":"concede","condescendng":"condescending",
    "conected":"connected","consious":"conscious","contibute":"contribute",
    "controvercial":"controversial","convience":"convenience","corect":"correct",
    "councel":"council","crital":"critical","culter":"culture",
    // D (more)
    "dacision":"decision","decipher":"decipher","definiton":"definition",
    "delibrate":"deliberate","dependance":"dependence","desicion":"decision",
    "diferent":"different","disapproval":"disapproval","discepline":"discipline",
    "disscuss":"discuss","distructive":"destructive","divert":"divert",
    "dominence":"dominance","dramaticly":"dramatically","duely":"duly",
    // E (more)
    "effectivly":"effectively","embaressed":"embarrassed","eminant":"eminent",
    "emision":"emission","emporer":"emperor","encourge":"encourage",
    "enormus":"enormous","enthusiasim":"enthusiasm","entrence":"entrance",
    "enviornment":"environment","epidemy":"epidemic","equaly":"equally",
    "equiptment":"equipment","estatic":"ecstatic","evidant":"evident",
    "exactely":"exactly","excede":"exceed","excelerate":"accelerate",
    "exilarate":"exhilarate","expereince":"experience","expession":"expression",
    "extraordinery":"extraordinary",
    // F (more)
    "fameous":"famous","fasinating":"fascinating","favorit":"favorite",
    "firey":"fiery","flexable":"flexible","focuss":"focus",
    "forceful":"forceful","forfit":"forfeit","foriegner":"foreigner",
    "fourm":"forum","frequecy":"frequency","friendley":"friendly",
    "futher":"further",
    // G (more)
    "gastly":"ghastly","generouse":"generous","graceous":"gracious",
    "gradiant":"gradient","gratuitus":"gratuitous","greif":"grief",
    "guidence":"guidance","guily":"guilty",
    // H (more)
    "habitual":"habitual","harasment":"harassment","harrasment":"harassment",
    "headach":"headache","heavaly":"heavily","hierchy":"hierarchy",
    "higharchy":"hierarchy","histiry":"history","horible":"horrible",
    "hostility":"hostility","houraglass":"hourglass",
    // I (more)
    "identiy":"identity","ilustrate":"illustrate","imbalanced":"imbalanced",
    "immoveable":"immovable","impeed":"impede","impliment":"implement",
    "impresive":"impressive","improvment":"improvement","inadaquate":"inadequate",
    "increadible":"incredible","indespensable":"indispensable",
    "indivdual":"individual","infered":"inferred","innappropriate":"inappropriate",
    "inspiraton":"inspiration","instaled":"installed","intrest":"interest",
    "intrduced":"introduced","irresponsible":"irresponsible",
    // J (more)
    "jeopardy":"jeopardy","jouney":"journey","jugment":"judgment",
    // K (more)
    "knowledgeable":"knowledgeable",
    // L (more)
    "labrytinth":"labyrinth","layed":"laid","leagal":"legal",
    "learnng":"learning","legitamate":"legitimate","liitle":"little",
    "limitting":"limiting","logicaly":"logically","lonley":"lonely",
    // M (more)
    "magnifcent":"magnificent","maintian":"maintain","managment":"management",
    "manipualte":"manipulate","manufacter":"manufacturer","marginaly":"marginally",
    "mastermined":"mastermind","medeival":"medieval","memoreable":"memorable",
    "mesage":"message","miliary":"military","milenium":"millennium",
    "mimiking":"mimicking","mispresent":"misrepresent","mistakenly":"mistakenly",
    "modefied":"modified","momentaraly":"momentarily","monestary":"monastery",
    "monkies":"monkeys","monotonous":"monotonous","moraly":"morally",
    "motovation":"motivation","mountian":"mountain","mulitple":"multiple",
    // N (more)
    "narative":"narrative","negotation":"negotiation","neibourhood":"neighborhood",
    "neightbour":"neighbor","niether":"neither","nominate":"nominate",
    "noteable":"notable","noticeble":"noticeable","nusance":"nuisance",
    // O (more)
    "objection":"objection","observaton":"observation","obsticle":"obstacle",
    "ocasion":"occasion","ommision":"omission","operaton":"operation",
    "opponant":"opponent","opressive":"oppressive","orginal":"original",
    "organsation":"organisation","orignally":"originally",
    // P (more)
    "pacifist":"pacifist","painfull":"painful","palce":"palace",
    "papaer":"paper","pasenger":"passenger","peaceble":"peaceable",
    "penultimte":"penultimate","performence":"performance","physcial":"physical",
    "picutre":"picture","polotical":"political","posession":"possession",
    "possiblity":"possibility","potentail":"potential","powerfull":"powerful",
    "pratically":"practically","precisley":"precisely","predicament":"predicament",
    "premiss":"premise","prevous":"previous","principaly":"principally",
    "probelem":"problem","professer":"professor","progres":"progress",
    "projetc":"project","promonent":"prominent","provied":"provided",
    "pshycology":"psychology","pubilc":"public","purposly":"purposely",
    // Q (more)
    "qualety":"quality","qucik":"quick","questionare":"questionnaire",
    // R (more)
    "realise":"realize","reaserch":"research","reccomend":"recommend",
    "recieve":"receive","recognse":"recognise","recomendation":"recommendation",
    "redicule":"ridicule","refrendum":"referendum","regualar":"regular",
    "relivent":"relevant","remembrance":"remembrance","renoun":"renown",
    "reoccur":"recur","resevoir":"reservoir","resposiblity":"responsibility",
    "retreive":"retrieve","reverence":"reverence","ridiculus":"ridiculous",
    "rigourous":"rigorous",
    // S (more)
    "sacrafice":"sacrifice","saftey":"safety","sargeant":"sergeant",
    "scenary":"scenery","sceince":"science","scisors":"scissors",
    "seige":"siege","sentance":"sentence","sepperate":"separate",
    "siez":"seize","signifcant":"significant","sincerely":"sincerely",
    "slaught":"slaughter","soluton":"solution","somthing":"something",
    "sophmoric":"sophomoric","spefically":"specifically","sponcered":"sponsored",
    "staight":"straight","stament":"statement","steriotype":"stereotype",
    "stratagy":"strategy","strucure":"structure","stubbern":"stubborn",
    "subjectve":"subjective","sumon":"summon","suplied":"supplied",
    "surreptiously":"surreptitiously","suceeded":"succeeded",
    // T (more)
    "tanamount":"tantamount","techincal":"technical","tenatious":"tenacious",
    "therom":"theorem","thoughtfull":"thoughtful","threshhold":"threshold",
    "togather":"together","tollerance":"tolerance","tomorrrow":"tomorrow",
    "tomorow":"tomorrow","torturous":"torturous","totatly":"totally",
    "tradional":"traditional","trancript":"transcript","transfering":"transferring",
    "tremandous":"tremendous","truely":"truly","tubercolosis":"tuberculosis",
    "twelvth":"twelfth","tyranical":"tyrannical",
    // U (more)
    "unbeleivable":"unbelievable","underlining":"underlying","undesireable":"undesirable",
    "unfortuanately":"unfortunately","uninamous":"unanimous","univeristy":"university",
    "unkown":"unknown","unpresedented":"unprecedented","unreliabe":"unreliable",
    "uterly":"utterly",
    // V (more)
    "vacum":"vacuum","vaguley":"vaguely","vandelism":"vandalism",
    "variuos":"various","vegtable":"vegetable","verbosly":"verbosely",
    "verteran":"veteran","vigourous":"vigorous","villan":"villain",
    "vincible":"vincible","voilate":"violate","voltaire":"Voltaire",
    "vunreable":"vulnerable",
    // W (more)
    "warrent":"warrant","welath":"wealth","wellfare":"welfare",
    "wepon":"weapon","whith":"with","withold":"withhold",
    "wonderfull":"wonderful","worreid":"worried","worthwile":"worthwhile",
    "woudl":"would",
    // Z (more)
    "zealos":"zealous","zenophobia":"xenophobia",
  };

  const MISSPELLING_RE = new RegExp(
    `\\b(${Object.keys(MISSPELLINGS).join("|")})\\b`, "gi"
  );

  // ─── Regional spelling variants ──────────────────────────────────────────────
  // [usForm, ukForm, isIzeFamily] — Canadian English keeps US -ize/-yze spellings
  // but follows UK for -our / -re / -ce / misc.
  const DIALECT_PAIRS = [
    // -or / -our
    ["color","colour"],["colors","colours"],["colored","coloured"],["colorful","colourful"],
    ["honor","honour"],["honors","honours"],["honored","honoured"],["honorable","honourable"],
    ["behavior","behaviour"],["behaviors","behaviours"],["behavioral","behavioural"],
    ["favorite","favourite"],["favorites","favourites"],
    ["favor","favour"],["favors","favours"],["favored","favoured"],["favorable","favourable"],
    ["neighbor","neighbour"],["neighbors","neighbours"],["neighborhood","neighbourhood"],
    ["flavor","flavour"],["flavors","flavours"],["flavored","flavoured"],
    ["humor","humour"],["humorous","humourous"],
    ["labor","labour"],["labors","labours"],["labored","laboured"],
    ["rumor","rumour"],["rumors","rumours"],
    ["armor","armour"],["armored","armoured"],
    ["endeavor","endeavour"],["endeavors","endeavours"],
    ["harbor","harbour"],["harbors","harbours"],
    ["vigor","vigour"],["rigor","rigour"],["valor","valour"],["splendor","splendour"],
    // -er / -re
    ["center","centre"],["centers","centres"],["centered","centred"],
    ["theater","theatre"],["theaters","theatres"],
    ["meter","metre"],["meters","metres"],
    ["liter","litre"],["liters","litres"],
    ["fiber","fibre"],["fibers","fibres"],
    ["caliber","calibre"],["somber","sombre"],["luster","lustre"],
    // -ense / -ence
    ["defense","defence"],["defenses","defences"],
    ["offense","offence"],["offenses","offences"],
    ["pretense","pretence"],
    // -ize / -ise (Canadian keeps the US form)
    ["organize","organise",true],["organizes","organises",true],["organized","organised",true],
    ["organizing","organising",true],["organization","organisation",true],["organizations","organisations",true],
    ["realize","realise",true],["realizes","realises",true],["realized","realised",true],["realizing","realising",true],
    ["recognize","recognise",true],["recognizes","recognises",true],["recognized","recognised",true],
    ["apologize","apologise",true],["apologized","apologised",true],["apologizing","apologising",true],
    ["criticize","criticise",true],["criticized","criticised",true],
    ["emphasize","emphasise",true],["emphasized","emphasised",true],
    ["summarize","summarise",true],["summarized","summarised",true],
    ["minimize","minimise",true],["maximize","maximise",true],
    ["specialize","specialise",true],["specialized","specialised",true],
    ["analyze","analyse",true],["analyzed","analysed",true],["analyzing","analysing",true],["analyzes","analyses",true],
    ["paralyze","paralyse",true],["paralyzed","paralysed",true],
    // doubled L
    ["traveled","travelled"],["traveling","travelling"],["traveler","traveller"],["travelers","travellers"],
    ["canceled","cancelled"],["canceling","cancelling"],
    ["modeled","modelled"],["modeling","modelling"],
    ["labeled","labelled"],["labeling","labelling"],
    ["fueled","fuelled"],["marveled","marvelled"],
    // misc
    ["gray","grey"],["grays","greys"],
    ["catalog","catalogue"],["catalogs","catalogues"],
    ["dialog","dialogue"],["dialogs","dialogues"],
    ["jewelry","jewellery"],
    ["tire","tyre"],["tires","tyres"],
    ["aluminum","aluminium"],
    ["mustache","moustache"],
    ["pajamas","pyjamas"],
    ["plow","plough"],["plows","ploughs"],
    ["skeptic","sceptic"],["skeptical","sceptical"],["skepticism","scepticism"],
    ["mold","mould"],["molds","moulds"],
    ["gotten","got"],
    ["donut","doughnut"],["donuts","doughnuts"],
    ["check","cheque"],  // only flagged UK→US direction is unsafe; handled below
  ];

  const DIALECT_NAMES = { us: "American", uk: "British", au: "Australian", ca: "Canadian" };

  // ─── Dictionary spellchecker ─────────────────────────────────────────────────
  // 50k-word frequency-ordered dictionary bundled with the extension. Any word
  // not in it is a candidate misspelling; suggestions are dictionary words one
  // edit away, ranked by frequency (Norvig's classic approach).
  let DICT = null;        // Map word → frequency rank (lower = more common)
  let dictLoading = false;

  // Common abbreviations, tech vocabulary, and file-format names the base
  // dictionary lacks — merged in as valid words (with low suggestion priority)
  const EXTRA_WORDS = [
    // abbreviations
    "approx", "vs", "misc", "etc", "aka", "asap", "fyi", "faq", "faqs", "diy",
    "eta", "rsvp", "mph", "kph", "kg", "km", "cm", "mm", "ml", "oz", "lbs",
    "hrs", "mins", "secs", "min", "max", "avg", "qty", "dept", "depts", "est",
    "intro", "memo", "memos", "rep", "reps", "temp", "temps", "stats", "specs",
    // texting shorthand — valid tokens here so the spellchecker stays quiet
    // and the informal-abbreviation rule does the coaching instead
    "thx", "pls", "plz", "ppl", "msg", "msgs", "pic", "pics", "tho", "thru",
    "cuz", "coz", "wanna", "gotta", "kinda", "sorta", "dunno", "idk", "imo",
    "imho", "btw", "tbh", "nvm", "omw",
    // file formats & extensions
    "json", "html", "css", "js", "jsx", "ts", "tsx", "xml", "csv", "tsv",
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "mp3", "mp4",
    "mov", "avi", "wav", "flac", "zip", "gz", "rar", "exe", "dmg", "iso",
    "apk", "sql", "php", "py", "rb", "md", "txt", "yml", "yaml", "toml",
    "ini", "cfg", "env", "bak", "tmp", "docx", "xlsx", "pptx", "ttf", "otf",
    "woff", "webm", "heic",
    // tech vocabulary
    "config", "configs", "repo", "repos", "dev", "devs", "prod", "app",
    "apps", "api", "apis", "url", "urls", "http", "https", "www", "admin",
    "admins", "auth", "login", "logins", "logout", "signup", "username",
    "usernames", "backend", "frontend", "fullstack", "localhost", "db",
    "ui", "ux", "id", "ids", "os", "ip", "ips", "cpu", "gpu", "ram", "ssd",
    "hdd", "usb", "wifi", "hotspot", "email", "emails", "inbox", "unread",
    "screenshot", "screenshots", "favicon", "webpage", "webpages", "website",
    "websites", "webserver", "online", "offline", "plugin", "plugins",
    "addon", "addons", "dropdown", "dropdowns", "checkbox", "checkboxes",
    "tooltip", "tooltips", "popup", "popups", "sidebar", "navbar", "footer",
    "header", "homepage", "hyperlink", "hyperlinks", "metadata", "filename",
    "filenames", "subfolder", "subfolders", "timestamp", "timestamps",
    "uptime", "downtime", "regex", "regexes", "bool", "int", "str", "var",
    "vars", "const", "enum", "async", "sync", "cron", "sudo", "npm", "git",
    "github", "gitlab", "linux", "ubuntu", "macos", "ios", "android",
    "chrome", "firefox", "gmail", "google", "youtube", "facebook",
    "instagram", "tiktok", "twitter", "linkedin", "reddit", "wiki", "wikis",
    "blog", "blogs", "vlog", "vlogs", "podcast", "podcasts", "hashtag",
    "hashtags", "selfie", "selfies", "emoji", "emojis", "meme", "memes",
    "unfollow", "retweet", "livestream", "webinar", "webinars", "ebook",
    "ebooks", "smartphone", "smartphones", "smartwatch", "chromebook",
    "bluetooth", "airdrop", "screenshare", "whiteboard", "spreadsheet",
    "spreadsheets", "slideshow", "slideshows", "textbox", "autofill",
    "autocorrect", "autosave", "undo", "redo", "clipboard", "keybinding",
    "keybindings", "shortcut", "shortcuts", "changelog", "readme", "todo",
    "todos", "backlog", "standup", "sprint", "sprints", "roadmap", "roadmaps",
  ];

  // Spans the spellchecker should never look inside: URLs, email addresses,
  // `inline code`, and filenames like config.json or photo.JPG
  const SPELL_MASK_RE = /(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b|`[^`\n]*`|\b[\w-]+\.(?:js|jsx|ts|tsx|json|html?|css|scss|md|txt|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|pptx?|csv|tsv|zip|tar|gz|rar|7z|exe|dmg|iso|apk|py|rb|java|cpp|cs|go|rs|php|sh|bat|yml|yaml|toml|ini|cfg|env|xml|sql|log|tmp|bak|mp3|mp4|mov|avi|wav|flac|webm|heic|ttf|otf|woff2?)\b/gi;

  function loadDictionary() {
    if (DICT || dictLoading) return;
    dictLoading = true;
    fetch(chrome.runtime.getURL("dict/words.txt"))
      .then((r) => r.text())
      .then((txt) => {
        const map = new Map();
        let rank = 0;
        for (const w of txt.split("\n")) {
          if (w) map.set(w, rank++);
        }
        // Tech/abbreviation vocabulary: valid words, but ranked low enough
        // that they rarely beat everyday words as typo suggestions
        for (const w of EXTRA_WORDS) {
          if (!map.has(w)) map.set(w, rank + 50000);
        }
        DICT = map;
        recheck();
      })
      .catch(() => { dictLoading = false; });
  }

  const LETTERS = "abcdefghijklmnopqrstuvwxyz";

  // All strings one edit away (delete, transpose, replace, insert)
  function edits1(word) {
    const out = [];
    for (let i = 0; i <= word.length; i++) {
      const a = word.slice(0, i);
      const b = word.slice(i);
      if (b) out.push(a + b.slice(1));                              // delete
      if (b.length > 1) out.push(a + b[1] + b[0] + b.slice(2));     // transpose
      for (const c of LETTERS) {
        if (b) out.push(a + c + b.slice(1));                        // replace
        out.push(a + c + b);                                        // insert
      }
    }
    return out;
  }

  function suggestFor(word) {
    let best = null;
    let bestRank = Infinity;
    for (const cand of edits1(word)) {
      const rank = DICT.get(cand);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        best = cand;
      }
    }
    // Prefer the current dialect's form (e.g. "colour" over "color" in UK mode)
    if (best) {
      const { map } = buildDialectData();
      if (map[best]) best = map[best];
    }
    return best;
  }

  function buildDialectData() {
    if (dialectCache) return dialectCache;
    // map: wrongForm(lowercase) → correctForm
    const map = {};
    for (const [us, uk, ize] of DIALECT_PAIRS) {
      // Ambiguous words we only flag in one direction
      if (us === "check") continue;          // "cheque"/"check" too context-dependent
      // "got" is valid everywhere; only flag "gotten" in UK/AU mode
      if (us === "gotten" && dialect !== "uk" && dialect !== "au") continue;
      const wantUS = dialect === "us" || (dialect === "ca" && ize);
      const expected = wantUS ? us : uk;
      const wrong = wantUS ? uk : us;
      if (wrong !== expected) map[wrong] = expected;
    }
    const keys = Object.keys(map);
    const re = keys.length
      ? new RegExp(`\\b(${keys.join("|")})\\b`, "gi")
      : null;
    dialectCache = { map, re };
    return dialectCache;
  }

  const RULES = [
    // ── Wordy phrases ───────────────────────────────────────────────────────
    {
      id: "wordy",
      check(text) {
        const findings = [];
        const wordyPhrases = {
          "at this point in time": "now",
          "at the present time": "now",
          "at the current time": "now",
          "at this moment in time": "now",
          "due to the fact that": "because",
          "in light of the fact that": "because",
          "on account of the fact that": "because",
          "in spite of the fact that": "although",
          "in order to": "to",
          "in order for": "for",
          "in the event that": "if",
          "in the event of": "if",
          "on account of": "because",
          "with the exception of": "except",
          "for the purpose of": "to",
          "for the reason that": "because",
          "in the near future": "soon",
          "in close proximity to": "near",
          "a large number of": "many",
          "a small number of": "few",
          "a majority of": "most",
          "the majority of": "most",
          "make a decision": "decide",
          "make a choice": "choose",
          "make an assumption": "assume",
          "make a determination": "determine",
          "come to a conclusion": "conclude",
          "reach a conclusion": "conclude",
          "come to an agreement": "agree",
          "take into consideration": "consider",
          "take into account": "consider",
          "give consideration to": "consider",
          "in my personal opinion": "in my opinion",
          "in my own personal opinion": "in my opinion",
          "personally, i think": "I think",
          "past history": "history",
          "end result": "result",
          "final outcome": "outcome",
          "future plans": "plans",
          "added bonus": "bonus",
          "unexpected surprise": "surprise",
          "free gift": "gift",
          "true fact": "fact",
          "basic fundamentals": "fundamentals",
          "new innovation": "innovation",
          "advance warning": "warning",
          "first and foremost": "first",
          "each and every": "every",
          "any and all": "all",
          "null and void": "void",
          "cease and desist": "stop",
          "basic necessities": "necessities",
          "completely eliminate": "eliminate",
          "completely destroy": "destroy",
          "successfully completed": "completed",
          "in terms of": "",
          "with regard to": "about",
          "with respect to": "about",
          "in relation to": "about",
          "as a result of": "because of",
          "as a consequence of": "because of",
          "despite the fact that": "although",
          "regardless of the fact that": "although",
          "it is worth noting that": "",
          "it is important to note that": "",
          "it should be noted that": "",
          "needless to say": "",
          "it goes without saying": "",
          "the fact that": "",
          "as a matter of fact": "in fact",
          "in actual fact": "in fact",
          "for all intents and purposes": "practically",
          "to all intents and purposes": "practically",
          "in the final analysis": "finally",
          "at the end of the day": "ultimately",
          "when all is said and done": "ultimately",
        };
        // Compile the ~80 phrase regexes once, not on every keystroke
        if (!this.compiled) {
          this.compiled = Object.entries(wordyPhrases).map(([phrase, suggestion]) => ({
            phrase,
            suggestion,
            re: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "gi"),
          }));
        }
        for (const { phrase, suggestion, re } of this.compiled) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            const sug = suggestion ? `"${suggestion}"` : "remove it";
            findings.push({
              index: m.index,
              length: m[0].length,
              correction: suggestion,
              type: "wordy",
              severity: "info",
              label: "Wordy phrase",
              message: `"${m[0]}" is wordy.`,
              explanation:
                "Concise writing is stronger and clearer. Long filler phrases can almost always be replaced with a single word without losing any meaning.",
              example: `❌  "${phrase}"\n✅  ${sug}`,
              fix: suggestion ? `Replace with ${sug}.` : `Remove "${phrase}" — it adds no meaning.`,
            });
          }
        }
        return findings;
      },
    },

    // ── could/would/should of ───────────────────────────────────────────────
    {
      id: "modal-of",
      check(text) {
        const findings = [];
        const re = /\b(could|would|should|must|might|may|ought\s+to\s+have|used\s+to\s+have)\s+of\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          const modal = m[1].replace(/\s+/g, " ");
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[0].replace(/\bof$/, "have"),
            type: "modal-of",
            severity: "error",
            label: `"${modal} of"`,
            message: `"${m[0]}" is not standard — did you mean "${modal} have"?`,
            explanation:
              'The error happens because "could\'ve," "would\'ve," and "should\'ve" sound like "could of" when spoken aloud. But "of" is a preposition, not a verb — "have" is required after modal verbs.',
            example:
              `❌  I ${modal} of done it differently.\n✅  I ${modal} have done it differently.\n✅  I ${modal.replace(/\b(could|would|should|might|may|must)\b/, "$1've")} done it.`,
            fix: `Replace "of" with "have": "${modal} have."`,
          });
        }
        return findings;
      },
    },

    // ── then vs than ────────────────────────────────────────────────────────
    {
      id: "then-than",
      check(text) {
        const findings = [];
        const comparatives = [
          "better","more","less","rather","other","greater","sooner","longer",
          "faster","older","newer","bigger","smaller","higher","lower",
          "stronger","weaker","harder","easier","closer","worse","later",
          "earlier","louder","quieter","heavier","lighter","darker","brighter",
          "hotter","colder","wider","narrower","taller","shorter","deeper",
          "sweeter","richer","poorer","happier","sadder","angrier","busier",
          "further","farther","cheaper","cleaner","smarter","slower",
        ];
        const re = new RegExp(`\\b(${comparatives.join("|")})\\s+then\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 4,
            correction: "than",
            type: "then-than",
            severity: "error",
            label: "then vs than",
            message: `After a comparative like "${m[1]}", use "than" not "then."`,
            explanation:
              '"Than" is used for comparisons ("bigger than a house"). "Then" refers to time ("first this, then that"). They sound alike but serve completely different purposes.',
            example:
              `❌  She is smarter then him.\n✅  She is smarter than him.\n✅  First study, then relax. (time)`,
            fix: 'Replace "then" with "than."',
          });
        }
        return findings;
      },
    },

    // ── to vs too ───────────────────────────────────────────────────────────
    {
      id: "to-too",
      check(text) {
        const findings = [];
        const adjectives = [
          "much","many","long","short","late","early","far","fast","slow",
          "big","small","loud","quiet","hot","cold","hard","easy","busy",
          "tired","old","young","soon","little","often","heavy","light",
          "dark","bright","high","low","wide","narrow","tall","deep","thick",
          "thin","sweet","rich","poor","happy","sad","angry","serious",
          "expensive","cheap","clean","dirty","safe","dangerous","strong",
          "weak","smart","dumb","close","far","quick","simple","complex",
        ];
        const re = new RegExp(`\\bto\\s+(${adjectives.join("|")})\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          // Skip if preceded by a verb or "go/want/need/have/try" (legitimate "to + adj" constructions are rare)
          const before = text.slice(Math.max(0, m.index - 20), m.index).trim();
          if (/\b(go|want|need|have|try|seem|appear|get|become|turn|grow|come|be|is|are|was|were)\s*$/i.test(before)) continue;
          findings.push({
            index: m.index,
            length: 2,
            correction: "too",
            type: "to-too",
            severity: "error",
            label: "to vs too",
            message: `"to ${m[1]}" — did you mean "too ${m[1]}"?`,
            explanation:
              '"Too" (with two o\'s) means "excessively" or "also." "To" is a preposition or part of an infinitive. When you mean "excessively," always use "too."',
            example:
              `❌  It is to ${m[1]}.\n✅  It is too ${m[1]}.\n✅  I went to the store. (preposition)`,
            fix: 'Replace "to" with "too."',
          });
        }
        return findings;
      },
    },

    // ── loose vs lose ───────────────────────────────────────────────────────
    {
      id: "loose-lose",
      check(text) {
        const findings = [];
        // "loose" used as a verb (preceded by aux verbs)
        const re = /\b(will|would|could|should|might|may|must|can|can't|won't|don't|didn't|doesn't|never|always|often|sometimes|want\s+to|need\s+to|going\s+to|try\s+to|hate\s+to|afraid\s+to)\s+loose\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].length - 5,
            length: 5,
            correction: "lose",
            type: "loose-lose",
            severity: "error",
            label: "loose vs lose",
            message: '"loose" here should be "lose" (to fail to keep or win).',
            explanation:
              '"Lose" (one o) is the verb meaning to misplace something or to be defeated. "Loose" (two o\'s) is an adjective meaning not tight, or a verb meaning to release. They\'re spelled differently and mean different things.',
            example:
              "❌  I always loose my keys.\n✅  I always lose my keys.\n✅  The dog is loose. (adjective — not tight)",
            fix: 'Replace "loose" with "lose."',
          });
        }
        return findings;
      },
    },

    // ── accept vs except ────────────────────────────────────────────────────
    {
      id: "accept-except",
      check(text) {
        const findings = [];
        // "except" used where "accept" is needed
        const reExcept = /\b(I|we|they|he|she|you|please|will|would|can|could|must|should|don't|didn't|won't|wouldn't)\s+except\s+(?:the|this|that|it|them|him|her|your|my|our|their|an?)\b/gi;
        let m;
        while ((m = reExcept.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 6,
            correction: "accept",
            type: "accept-except",
            severity: "warning",
            label: "accept vs except",
            message: '"except" here might be "accept" (to receive or agree to).',
            explanation:
              '"Accept" is a verb meaning to receive or agree to something. "Except" is a preposition or conjunction meaning "not including." They sound similar but have very different meanings.',
            example:
              "❌  Please except my apology.\n✅  Please accept my apology.\n✅  Everyone came except John. (not including)",
            fix: 'If you mean "to receive or agree to," use "accept."',
          });
        }
        // "accept" used as "except" (everyone accept X)
        const reAccept = /\b(everyone|everybody|everything|all|anyone|anybody|nothing|no\s+one|nobody)\s+accept\s+(?!for\b)(\w+)/gi;
        while ((m = reAccept.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 6,
            correction: "except",
            type: "accept-except",
            severity: "warning",
            label: "accept vs except",
            message: '"accept" here should likely be "except" (not including).',
            explanation:
              '"Except" means "not including." "Accept" means to receive or agree. When listing exclusions, you need "except."',
            example:
              "❌  Everyone accept John was there.\n✅  Everyone except John was there.",
            fix: 'Replace "accept" with "except."',
          });
        }
        return findings;
      },
    },

    // ── a vs an ─────────────────────────────────────────────────────────────
    {
      id: "a-an",
      check(text) {
        const findings = [];
        // "a" before a vowel sound
        const vowelWords = [
          "apple","orange","elephant","umbrella","oven","ice","ant","hour",
          "honor","honest","heir","error","example","email","idea","issue",
          "offer","open","award","onion","ounce","ocean","action","answer",
          "argument","article","author","event","effort","object","obligation",
          "office","opinion","option","outcome","evidence","experience",
          "examination","explanation","egg","ear","eye","arm","army","angle",
          "apple","area","artist","uncle","upset","account","address","update",
          "upgrade","upload","annual","honest","hour","hourly",
        ];
        const reA = this.reA || (this.reA = new RegExp(`\\ba\\s+(${vowelWords.join("|")})\\b`, "gi"));
        reA.lastIndex = 0;
        let m;
        while ((m = reA.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 1,
            correction: "an",
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "an" before "${m[1]}" (vowel sound).`,
            explanation:
              'Use "a" before consonant sounds and "an" before vowel sounds. The rule is about the sound, not the letter — "an hour" (silent h, vowel sound) but "a university" (sounds like "yoo").',
            example: `❌  a ${m[1]}\n✅  an ${m[1]}`,
            fix: `Change "a" to "an" before "${m[1]}."`,
          });
        }
        // "an" before a consonant sound
        const consonantWords = [
          "book","car","dog","flower","game","job","kid","letter","man",
          "number","person","race","start","time","vote","war","bag","ball",
          "bank","bird","boy","cake","company","computer","country","cup",
          "day","deal","decision","dream","face","fact","family","field",
          "film","fire","fish","floor","food","force","future","garden",
          "girl","goal","group","hair","hand","head","heart","high","hill",
          "history","home","human","kind","king","knowledge","law","level",
          "life","line","list","look","loss","machine","map","meal","meeting",
          "model","moment","money","month","morning","music","name","need",
          "night","note","pain","paper","park","part","path","peace","plan",
          "point","pool","power","problem","process","product","project",
          "reason","result","road","role","rule","scene","school","season",
          "sign","single","social","song","sort","sound","space","speed",
          "stage","state","step","store","strength","structure","study",
          "summer","support","system","task","team","test","theory","thing",
          "thought","trade","tree","type","view","way","week","window",
          "winter","word","work","world","year","table","chair","house",
          "room","door","street","city","town","building","phone","laptop",
          "computer","tablet","keyboard","mouse","screen","desk",
        ];
        const reAn = this.reAn || (this.reAn = new RegExp(`\\ban\\s+(${consonantWords.join("|")})\\b`, "gi"));
        reAn.lastIndex = 0;
        while ((m = reAn.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 2,
            correction: "a",
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "a" not "an" before "${m[1]}" (consonant sound).`,
            explanation:
              '"An" is used before vowel sounds. "' + m[1] + '" begins with a consonant sound, so it needs "a."',
            example: `❌  an ${m[1]}\n✅  a ${m[1]}`,
            fix: `Change "an" to "a" before "${m[1]}."`,
          });
        }
        // "an" before words that sound like consonants (u as "yoo")
        const consonantSoundVowelWords = ["university","unicorn","unit","union","unique","user","usual","utility","uniform","European","euphemism","ukulele","usage","uterus"];
        const reAnYoo = this.reAnYoo || (this.reAnYoo = new RegExp(`\\ban\\s+(${consonantSoundVowelWords.join("|")})\\b`, "gi"));
        reAnYoo.lastIndex = 0;
        while ((m = reAnYoo.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 2,
            correction: "a",
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "a" not "an" before "${m[1]}" — it starts with a "y" sound.`,
            explanation:
              `Although "${m[1]}" starts with the letter U, it is pronounced with a "y" sound (like "you"), which is a consonant sound. So you need "a," not "an."`,
            example: `❌  an ${m[1]}\n✅  a ${m[1]}`,
            fix: `Change "an" to "a" before "${m[1]}."`,
          });
        }
        // "a" before acronyms / proper nouns that start with a vowel SOUND
        const vowelSoundNames = [
          "FBI","MBA","MRI","NFL","NBA","NGO","SEO","API","LED","LCD","IOU",
          "HTML","HTTP","HTTPS","HR","MP3","ATM","SMS","IQ","MVP","FYI","NDA",
          "IPO","ETA","RSS","XML","FM","AM","SQL","FAQ","EU","LLC","EPA","IRS",
          "ISP","NPC","SUV","STD","MC","MP","X-ray","Xbox","iPhone","iPad",
          "SVG","EXE","XLS","XLSX","MP4","FTP","SSH","SSL","SDK","IDE","OS",
          "IP","ID","NFT","LLM","AI",
          "Emmy","Oscar","Uber","Airbnb","Olympic","American","African","Asian",
          "Australian","Austrian","Italian","Indian","Indonesian","Iranian",
          "Iraqi","Irish","Israeli","Icelandic","English","Englishman","Egyptian",
          "Ethiopian","Estonian","Eagle",
        ];
        const reAcronymA = this.reAcronymA || (this.reAcronymA = new RegExp(`\\b([Aa])\\s+(${vowelSoundNames.join("|")})\\b`, "g"));
        reAcronymA.lastIndex = 0;
        while ((m = reAcronymA.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 1,
            correction: m[1] === "A" ? "An" : "an",
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "an" before "${m[2]}" — it starts with a vowel sound.`,
            explanation:
              `The a/an rule follows the sound, not the letter. "${m[2]}" is pronounced starting with a vowel sound (spell it out loud: "FBI" starts with "ef"), so it takes "an." This applies to acronyms read letter-by-letter and to names like "an MBA," "an Italian."`,
            example: `❌  a ${m[2]}\n✅  an ${m[2]}`,
            fix: `Change "a" to "an" before "${m[2]}."`,
          });
        }
        // "an" before acronyms / proper nouns that start with a consonant SOUND
        const consonantSoundNames = [
          "URL","UFO","USB","UK","US","UN","UI","UX","GPS","DVD","TV","CEO",
          "CV","PhD","VIP","GIF","JPEG","PNG","NASA","NATO","UNESCO","W3C",
          "BBC","PC","DJ","Ukrainian","Utah","Euro","Eurozone","Yale","Jeep",
          "PDF","CSV","JPG","DOC","DOCX","ZIP","CPU","GPU","JSON","YAML",
          "VPN","PPT","PPTX","TXT","RAM","WAV","DB","CLI",
          "one-time","one-way","one-off",
        ];
        const reAcronymAn = this.reAcronymAn || (this.reAcronymAn = new RegExp(`\\b([Aa])n\\s+(${consonantSoundNames.join("|")})\\b`, "g"));
        reAcronymAn.lastIndex = 0;
        while ((m = reAcronymAn.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 2,
            correction: m[1] === "A" ? "A" : "a",
            type: "a-an",
            severity: "error",
            label: "a vs an",
            message: `Use "a" before "${m[2]}" — it starts with a consonant sound.`,
            explanation:
              `The a/an rule follows the sound, not the letter. "${m[2]}" is pronounced starting with a consonant sound ("URL" starts with "you," "NASA" starts with "nah"), so it takes "a" even though it may be spelled with a vowel.`,
            example: `❌  an ${m[2]}\n✅  a ${m[2]}`,
            fix: `Change "an" to "a" before "${m[2]}."`,
          });
        }
        return findings;
      },
    },

    // ── good vs well ────────────────────────────────────────────────────────
    {
      id: "good-well",
      check(text) {
        const findings = [];
        const re = /\b(am|is|are|was|were)\s+doing\s+good\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].length - 4,
            length: 4,
            correction: "well",
            type: "good-well",
            severity: "warning",
            label: "good vs well",
            message: '"doing good" describing health or performance should be "doing well."',
            explanation:
              '"Good" is an adjective (describes a noun). "Well" is an adverb (describes a verb or describes health). When describing how someone is performing or feeling, use "well." Exception: "doing good" meaning "doing charitable acts" is correct.',
            example:
              '❌  "How are you?" "I am doing good."\n✅  "How are you?" "I am doing well."\n✅  She is doing good work. (adjective modifying "work")',
            fix: 'Replace "good" with "well" when describing performance or health.',
          });
        }
        return findings;
      },
    },

    // ── between/for/with + me/I ──────────────────────────────────────────────
    {
      id: "pronoun-case",
      check(text) {
        const findings = [];
        // "between you and I" → "between you and me"
        const re = /\b(between|for|with|to|from|of|by|about|at|in|on|through|without|among|around|except|besides|including)\s+(?:\w+\s+and\s+I|I\s+and\s+\w+)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[0].replace(/\bI\b/, "me"),
            type: "pronoun-case",
            severity: "warning",
            label: "Pronoun case",
            message: `After "${m[1]}", use "me" not "I."`,
            explanation:
              'After a preposition (between, for, with, to, etc.), use the object pronoun "me," not the subject pronoun "I." Test: remove the other person — "between I" sounds wrong; "between me" is correct.',
            example:
              '❌  between you and I\n✅  between you and me\n❌  for my friend and I\n✅  for my friend and me',
            fix: 'Replace "I" with "me" after the preposition.',
          });
        }
        return findings;
      },
    },

    // ── complement vs compliment ─────────────────────────────────────────────
    {
      id: "complement-compliment",
      check(text) {
        const findings = [];
        // "complimentary" colors/flavors → "complementary"
        const re1 = /\bcomplimentary\s+(?:colors|colours|flavors|flavours|tones|shades|angles|skills|styles|traits|features)\b/gi;
        let m;
        while ((m = re1.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 13,
            correction: "complementary",
            type: "complement-compliment",
            severity: "warning",
            label: "complement vs compliment",
            message: `"complimentary ${m[0].split(" ").slice(1).join(" ")}" should be "complementary."`,
            explanation:
              '"Complement" (with an e) means to complete or go well with something. "Compliment" (with an i) means to praise. Complementary colors complete each other on the color wheel.',
            example:
              "❌  complimentary colors\n✅  complementary colors\n✅  She paid me a compliment. (praise)",
            fix: 'Use "complementary" when meaning "completing or going well with."',
          });
        }
        // "compliment each other" in non-praise sense
        const re2 = /\bcompliment\s+each\s+other\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 10,
            correction: "complement",
            type: "complement-compliment",
            severity: "info",
            label: "complement vs compliment",
            message: '"compliment each other" — did you mean "complement each other"?',
            explanation:
              'If you mean they go well together or complete each other, use "complement." If you mean they say nice things to each other, "compliment" is correct.',
            example:
              "The flavors complement each other. (go well together)\nThey complimented each other. (said nice things)",
            fix: 'Use "complement" if you mean they go well together.',
          });
        }
        return findings;
      },
    },

    // ── principal vs principle ───────────────────────────────────────────────
    {
      id: "principal-principle",
      check(text) {
        const findings = [];
        // "the principle reason/concern/..." → "principal"
        const re = /\bthe\s+principle\s+(reason|concern|goal|objective|cause|role|source|purpose|component|factor|issue|benefit|advantage|difference|focus|aim|challenge|problem|effect|feature|function|agent|investigator|designer|architect|engineer)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 9,
            correction: "principal",
            type: "principal-principle",
            severity: "warning",
            label: "principal vs principle",
            message: `"the principle ${m[1]}" — did you mean "principal" (main)?`,
            explanation:
              '"Principal" (ends in -al) means main or most important, or refers to a person in charge (school principal). "Principle" (ends in -le) is a rule, belief, or fundamental truth. Memory tip: your principal is your pal.',
            example:
              `❌  the principle reason\n✅  the principal reason (= the main reason)\n✅  a moral principle (= a rule or belief)`,
            fix: 'Use "principal" when you mean "main" or "most important."',
          });
        }
        return findings;
      },
    },

    // ── further vs farther ───────────────────────────────────────────────────
    {
      id: "further-farther",
      check(text) {
        const findings = [];
        // "farther" before abstract nouns → "further"
        const re = /\bfarther\s+(research|discussion|development|investigation|analysis|reading|study|notice|action|delay|information|detail|consideration|review|thought|explanation|context|evidence|work|progress|assistance|help|comment|debate|argument|planning|preparation|training|education|examination|testing|processing|exploration|inquiry|negotiation)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 7,
            correction: "further",
            type: "further-farther",
            severity: "info",
            label: "further vs farther",
            message: `"farther ${m[1]}" — for abstract concepts, "further" is preferred.`,
            explanation:
              '"Farther" refers to physical distance ("the store is farther away"). "Further" refers to degree, extent, or metaphorical distance ("further research needed"). Many style guides distinguish them this way.',
            example:
              `❌  farther ${m[1]}\n✅  further ${m[1]}\n✅  The cabin is farther down the road. (physical distance)`,
            fix: 'Use "further" for non-physical extension; "farther" for literal distance.',
          });
        }
        return findings;
      },
    },

    // ── imply vs infer ───────────────────────────────────────────────────────
    {
      id: "imply-infer",
      check(text) {
        const findings = [];
        // "I/you/we infer" used when speaker is implying
        const re = /\b(I|we)\s+(?:can\s+)?implied?\s+(?:that\s+)?(?:from\b|by\b|through\b)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[0].replace(/\bimp(ly|lied)\b/i, (_, s) => s.toLowerCase() === "ly" ? "infer" : "inferred"),
            type: "imply-infer",
            severity: "warning",
            label: "imply vs infer",
            message: "The speaker implies; the listener infers.",
            explanation:
              '"Imply" means to hint or suggest something without saying it directly (the speaker does this). "Infer" means to draw a conclusion from evidence (the listener does this). You cannot infer something outward — you imply it.',
            example:
              '❌  I implied from his tone that he was angry.\n✅  I inferred from his tone that he was angry.\n✅  His tone implied he was angry.',
            fix: 'Use "infer" when you are drawing a conclusion from evidence.',
          });
        }
        // "can infer from" where speaker is the source
        const re2 = /\bcan\s+imply\s+from\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[0].replace("imply", "infer"),
            type: "imply-infer",
            severity: "warning",
            label: "imply vs infer",
            message: '"can imply from" — did you mean "can infer from"?',
            explanation:
              'You infer something from evidence you observe. You imply something by your own words or actions.',
            example:
              '❌  We can imply from this data that…\n✅  We can infer from this data that…',
            fix: 'Replace "imply" with "infer."',
          });
        }
        return findings;
      },
    },

    // ── lay vs lie ───────────────────────────────────────────────────────────
    {
      id: "lay-lie",
      check(text) {
        const findings = [];
        const re = /\b(?:going\s+to|gonna|need\s+to|want\s+to|have\s+to|will|must)\s+lay\s+down\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].lastIndexOf("lay"),
            length: 3,
            correction: "lie",
            type: "lay-lie",
            severity: "warning",
            label: "lay vs lie",
            message: '"lay down" here should be "lie down."',
            explanation:
              '"Lie" (intransitive) means to recline — the subject rests. "Lay" (transitive) means to put something down — you lay an object somewhere. "Lay down" is wrong when no object follows. The confusion is made worse by the fact that "lay" is also the past tense of "lie."',
            example:
              "❌  I'm going to lay down.\n✅  I'm going to lie down.\n✅  Lay the book on the table. (object: \"book\")\n✅  I lay down yesterday. (past tense of lie)",
            fix: 'Use "lie down" when talking about reclining yourself.',
          });
        }
        // "I/he/she was laying down" → "was lying down"
        const re2 = /\b(I|he|she|it|we|they|you)\s+(?:was|were|am|is|are)\s+laying\s+down\b/gi;
        while ((m = re2.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].lastIndexOf("laying"),
            length: 6,
            correction: "lying",
            type: "lay-lie",
            severity: "warning",
            label: "lay vs lie",
            message: '"laying down" here should be "lying down."',
            explanation:
              '"Lying" is the present participle of "lie" (to recline). "Laying" is the present participle of "lay" (to place an object).',
            example:
              "❌  She was laying down on the couch.\n✅  She was lying down on the couch.",
            fix: 'Replace "laying" with "lying."',
          });
        }
        return findings;
      },
    },

    // ── Redundant acronyms ──────────────────────────────────────────────────
    {
      id: "redundant-acronym",
      check(text) {
        const findings = [];
        const pairs = {
          "ATM machine": { full: "Automated Teller Machine", redundant: "machine" },
          "PIN number": { full: "Personal Identification Number", redundant: "number" },
          "HIV virus": { full: "Human Immunodeficiency Virus", redundant: "virus" },
          "LCD display": { full: "Liquid Crystal Display", redundant: "display" },
          "ISBN number": { full: "International Standard Book Number", redundant: "number" },
          "RAM memory": { full: "Random Access Memory", redundant: "memory" },
          "VIN number": { full: "Vehicle Identification Number", redundant: "number" },
          "UPC code": { full: "Universal Product Code", redundant: "code" },
          "SAT test": { full: "Scholastic Assessment Test", redundant: "test" },
          "GPS system": { full: "Global Positioning System", redundant: "system" },
          "PDF format": { full: "Portable Document Format", redundant: "format" },
          "AC current": { full: "Alternating Current", redundant: "current" },
          "DC current": { full: "Direct Current", redundant: "current" },
          "RSVP please": { full: "Répondez s'il vous plaît", redundant: "please" },
          "ABS brakes": { full: "Anti-lock Brake System", redundant: "brakes" },
          "CAD design": { full: "Computer-Aided Design", redundant: "design" },
          "GIF format": { full: "Graphics Interchange Format", redundant: "format" },
          "JPEG format": { full: "Joint Photographic Experts Group", redundant: "format" },
          "WiFi internet": { full: "Wireless Fidelity", redundant: "internet" },
        };
        for (const [phrase, info] of Object.entries(pairs)) {
          const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi");
          let m;
          while ((m = re.exec(text)) !== null) {
            const acronym = phrase.split(" ")[0];
            findings.push({
              index: m.index,
              length: m[0].length,
              correction: acronym,
              type: "redundant-acronym",
              severity: "info",
              label: "Redundant acronym",
              message: `"${m[0]}" repeats itself — ${acronym} already stands for "${info.full}."`,
              explanation:
                `RAS syndrome (Redundant Acronym Syndrome) occurs when a word in the acronym is repeated after it. "${acronym}" already contains the word "${info.redundant}," so adding it again is redundant.`,
              example: `❌  ${phrase}\n✅  ${acronym} (the "${info.redundant}" is already in the acronym)`,
              fix: `Just write "${acronym}" — drop the extra "${info.redundant}."`,
            });
          }
        }
        return findings;
      },
    },

    // ── Subject–verb agreement ───────────────────────────────────────────────
    {
      id: "subject-verb",
      check(text) {
        const findings = [];
        // Indefinite pronouns that take singular verbs
        const singularSubjects = [
          "everyone","everybody","everything","someone","somebody","something",
          "anyone","anybody","anything","nobody","nothing","each","either",
          "neither","no one",
        ];
        const re = new RegExp(
          `\\b(${singularSubjects.join("|")})\\s+(are|were|have|don't|aren't|weren't|haven't|do)\\b`,
          "gi"
        );
        let m;
        while ((m = re.exec(text)) !== null) {
          const subject = m[1];
          const verb = m[2];
          const correctVerb = {
            "are":"is","were":"was","have":"has","don't":"doesn't",
            "aren't":"isn't","weren't":"wasn't","haven't":"hasn't","do":"does",
          }[verb.toLowerCase()] || verb;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[1] + " " + correctVerb,
            type: "subject-verb",
            severity: "warning",
            label: "Subject–verb agreement",
            message: `"${subject}" is singular and takes "${correctVerb}", not "${verb}."`,
            explanation:
              `Indefinite pronouns like "everyone," "somebody," "each," and "neither" are grammatically singular in English, even when they refer to multiple people. They require singular verbs.`,
            example:
              `❌  ${subject} ${verb} ready.\n✅  ${subject} ${correctVerb} ready.`,
            fix: `Replace "${verb}" with "${correctVerb}."`,
          });
        }
        // "The news/mathematics/economics are" → "is"
        const massSingular = ["news","mathematics","physics","economics","statistics","ethics","politics","linguistics","athletics","acoustics","genetics","phonetics"];
        const re2 = new RegExp(`\\b(${massSingular.join("|")})\\s+(are|were)\\b`, "gi");
        while ((m = re2.exec(text)) !== null) {
          const correct = m[2].toLowerCase() === "are" ? "is" : "was";
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[1] + " " + correct,
            type: "subject-verb",
            severity: "warning",
            label: "Subject–verb agreement",
            message: `"${m[1]}" is treated as singular and takes "${correct}", not "${m[2]}."`,
            explanation:
              `Fields of study and certain nouns ending in -s (like "news," "mathematics," "economics") look plural but are grammatically singular. They always take singular verbs.`,
            example:
              `❌  ${m[1]} ${m[2]} fascinating.\n✅  ${m[1]} ${correct} fascinating.`,
            fix: `Replace "${m[2]}" with "${correct}."`,
          });
        }
        return findings;
      },
    },

    // ── Passive voice (informational) ────────────────────────────────────────
    {
      id: "passive-voice",
      check(text) {
        const findings = [];
        const re = /\b(is|are|was|were|be|been|being)\s+(accomplished|achieved|addressed|affected|allowed|announced|applied|approved|assigned|assumed|avoided|believed|brought|built|called|carried|caused|chosen|claimed|completed|confirmed|considered|created|decided|declared|defined|delivered|designed|determined|developed|distributed|done|driven|established|examined|expected|explained|expressed|found|given|handled|identified|improved|included|indicated|introduced|investigated|issued|known|led|made|managed|measured|noted|obtained|offered|organized|performed|placed|planned|prepared|presented|produced|proposed|provided|published|put|raised|recognized|released|reported|required|resolved|reviewed|said|seen|sent|set|shown|solved|started|studied|submitted|suggested|supported|taken|tested|told|treated|understood|used|viewed|written)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "passive-voice",
            severity: "info",
            label: "Passive voice",
            message: `"${m[0]}" is passive voice.`,
            explanation:
              "In passive voice, the subject receives the action rather than performing it. Active voice is usually shorter, clearer, and more engaging. Passive isn't wrong — it's sometimes the right choice — but overuse makes writing feel evasive or dull.",
            example:
              "❌ (passive)  Mistakes were made by the team.\n✅ (active)   The team made mistakes.\n\n(Passive is fine when the actor is unknown or unimportant.)",
            fix: "Ask: who or what is doing the action? Make that the subject.",
          });
        }
        return findings;
      },
    },

    // ── Comma splice ─────────────────────────────────────────────────────────
    {
      id: "comma-splice",
      check(text) {
        const findings = [];
        const re = /([A-Z][^.!?]*[a-z]),\s+([A-Z][^.!?]*[a-z])/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (hasVerb(m[1]) && hasVerb(m[2])) {
            findings.push({
              index: m.index + m[1].length,
              length: 1,
              type: "comma-splice",
              severity: "warning",
              label: "Comma splice",
              message: "A comma is joining two complete sentences here.",
              explanation:
                "A comma splice happens when two independent clauses (sentences that could stand alone) are joined with just a comma. This is considered a grammatical error in formal writing.",
              example:
                "❌  I went to the store, I bought milk.\n✅  I went to the store. I bought milk.\n✅  I went to the store, and I bought milk.\n✅  I went to the store; I bought milk.",
              fix: "Replace the comma with a period, a semicolon, or add a coordinating conjunction (and, but, or, nor, for, yet, so).",
            });
          }
        }
        return findings;
      },
    },

    // ── Oxford comma ─────────────────────────────────────────────────────────
    {
      id: "oxford-comma",
      check(text) {
        const findings = [];
        const re = /(\b\w+),\s+(\w+)\s+and\s+(\w+)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[0].lastIndexOf(" and"),
            length: 4,
            correction: ", and",
            type: "oxford-comma",
            severity: "info",
            label: "Oxford comma",
            message: `Consider adding a comma before "and" in this list.`,
            explanation:
              'The Oxford (serial) comma is a comma placed before the final "and" or "or" in a list of three or more items. Many style guides (APA, Chicago) require it to prevent ambiguity.',
            example:
              "Without: I love my parents, Lady Gaga and Humpty Dumpty.\n  (Are Lady Gaga and Humpty Dumpty your parents?)\nWith: I love my parents, Lady Gaga, and Humpty Dumpty.",
            fix: `Add a comma before "and": "…${m[2]}, and ${m[3]}…"`,
          });
        }
        return findings;
      },
    },

    // ── Intro-clause comma ───────────────────────────────────────────────────
    {
      id: "intro-clause-comma",
      check(text) {
        const findings = [];
        const introWords = [
          "however","therefore","furthermore","moreover","nevertheless",
          "consequently","additionally","meanwhile","otherwise","thus",
          "hence","indeed","instead","similarly","accordingly","subsequently",
          "nonetheless","notwithstanding","conversely","alternatively",
          "incidentally","fortunately","unfortunately","importantly",
          "surprisingly","interestingly","admittedly","certainly","clearly",
          "obviously","undoubtedly","frankly","honestly","briefly",
          "ultimately","finally","initially","specifically","generally",
          "technically","essentially","basically","literally","theoretically",
        ];
        const re = new RegExp(
          `(?:^|[.!?]\\s+)(${introWords.join("|")})(\\s+[a-z])`,
          "gi"
        );
        let m;
        while ((m = re.exec(text)) !== null) {
          const word = m[1];
          findings.push({
            index: m.index + (m[0].length - m[2].length - word.length),
            length: word.length,
            correction: word + ",",
            type: "intro-clause-comma",
            severity: "warning",
            label: "Missing comma",
            message: `"${word}" at the start of a sentence usually needs a comma after it.`,
            explanation:
              'Conjunctive adverbs and sentence adverbs like "however," "therefore," "furthermore," and "consequently" need a comma after them when they open a sentence. This signals a pause and clearly separates the transitional word from the main clause.',
            example: `❌  ${word.charAt(0).toUpperCase() + word.slice(1)} I disagree.\n✅  ${word.charAt(0).toUpperCase() + word.slice(1)}, I disagree.`,
            fix: `Add a comma after "${word}".`,
          });
        }
        return findings;
      },
    },

    // ── its vs it's ──────────────────────────────────────────────────────────
    {
      id: "its-its",
      check(text) {
        const findings = [];
        const reContraction = /\bit's\s+(?:own|name|size|color|colour|way|form|place|role|part|turn|job|purpose|effect|shape|design|core|basis|roots|peak|end|start|beginning|strength|weakness|merit|value|worth|price|cost|nature|essence|identity|style|mark|character|appeal|charm|flaw|limit|scope|range|use)\b/gi;
        let m;
        while ((m = reContraction.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            correction: "its",
            type: "its-its",
            severity: "error",
            label: "its vs it's",
            message: `"it's" here should be "its" (possessive).`,
            explanation:
              '"it\'s" is always a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form. Test: read the sentence replacing "it\'s" with "it is" — if it sounds wrong, you want "its."',
            example:
              "❌  The cat licked it's paw.\n✅  The cat licked its paw.\n✅  It's raining. (= It is raining)",
            fix: 'Replace "it\'s" with "its."',
          });
        }
        const reIts = /\bits\s+(?:a|an|the|not|been|going|time|easy|hard|true|false|clear|possible|impossible|okay|ok|fine|great|good|bad|over|done|likely|unlikely|obvious|important|necessary|worth|strange|odd|weird|funny|nice|awful|terrible)\b/gi;
        while ((m = reIts.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 3,
            correction: "it's",
            type: "its-its",
            severity: "error",
            label: "its vs it's",
            message: `"its" here looks like it should be "it's" (it is / it has).`,
            explanation:
              '"it\'s" is a contraction of "it is" or "it has." When you can substitute "it is," use "it\'s." "its" without an apostrophe is possessive only.',
            example:
              "❌  Its going to rain.\n✅  It's going to rain. (= It is going to rain)",
            fix: 'Replace "its" with "it\'s."',
          });
        }
        return findings;
      },
    },

    // ── their / there / they're ─────────────────────────────────────────────
    {
      id: "there-their-theyre",
      check(text) {
        const findings = [];
        const reTheirThere = /\b(is|are|was|were|over|out|down|up|back|right|left|away|goes|went|stands|lives|lies|sits)\s+their\b/gi;
        let m;
        while ((m = reTheirThere.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 5,
            correction: "there",
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: `"their" after "${m[1]}" — did you mean "there"?`,
            explanation:
              '"there" refers to a place or introduces a clause ("There is…"). "their" is the possessive of "they." "they\'re" = they are. All three sound identical but have completely different functions.',
            example:
              "❌  Is their a problem?\n✅  Is there a problem?\n✅  Their car is blue. (possession)\n✅  They're coming over. (= They are)",
            fix: 'Use "there" to refer to a place or to introduce a clause.',
          });
        }
        const reTherePoss = /\bthere\s+(?:own|house|car|dog|cat|team|school|book|bag|job|idea|plan|group|family|friend|phone|class|room|office|desk|laptop|teacher|boss|child|kid|son|daughter|mom|dad|opinion|decision|choice|problem|fault|mistake|success|failure|goal|dream)\b/gi;
        while ((m = reTherePoss.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 5,
            correction: "their",
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: '"there" here should be "their" (possessive).',
            explanation:
              '"their" is the possessive pronoun for "they" — it shows ownership. "there" refers to a place.',
            example:
              "❌  I visited there house.\n✅  I visited their house.",
            fix: 'Replace "there" with "their."',
          });
        }
        return findings;
      },
    },

    // ── your vs you're ───────────────────────────────────────────────────────
    {
      id: "your-youre",
      check(text) {
        const findings = [];
        const reYour = /\byour\s+(?:a|an|the|not|going|welcome|right|wrong|sure|ready|done|able|allowed|supposed|trying|kidding|joking|serious|crazy|awesome|amazing|great|terrible|correct|late|early|free|busy|tired|sick|excited|happy|sad|angry|nervous|lucky|smart|funny|aware|afraid|welcome|mistaken|confused|interested|bored|surprised|shocked|wrong|right|safe|lost|okay|fine|good)\b/gi;
        let m;
        while ((m = reYour.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            correction: "you're",
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: '"your" here should be "you\'re" (you are).',
            explanation:
              '"you\'re" is a contraction of "you are." "your" is possessive (something belongs to you). Test: replace with "you are" — if it makes sense, use "you\'re."',
            example:
              "❌  Your going to love this.\n✅  You're going to love this.\n✅  Your dog is cute. (possession)",
            fix: 'Replace "your" with "you\'re."',
          });
        }
        const reYoure = /\byou're\s+(?:friend|dog|cat|car|house|phone|bag|book|team|school|job|idea|plan|family|boss|teacher|mom|dad|brother|sister|name|email|number|address|account|password|choice|decision|problem|fault|responsibility|turn|time|money|life|story|opinion|point|question|answer|work|project|assignment|task|goal|dream|success|failure|loss|gain)\b/gi;
        while ((m = reYoure.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 6,
            correction: "your",
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: '"you\'re" here should be "your" (possessive).',
            explanation:
              '"your" shows possession. "you\'re" = you are. They sound the same but mean completely different things.',
            example:
              "❌  I love you're dog.\n✅  I love your dog.",
            fix: 'Replace "you\'re" with "your."',
          });
        }
        return findings;
      },
    },

    // ── Double negative ──────────────────────────────────────────────────────
    {
      id: "double-negative",
      check(text) {
        const findings = [];
        const re = /\b(can't|cannot|couldn't|don't|doesn't|didn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|never|no\s+one|nobody)\s+(?:\w+\s+){0,4}(nobody|no\s+one|nothing|nowhere|neither|never|none|no\b)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "double-negative",
            severity: "warning",
            label: "Double negative",
            message: "Two negatives create a positive — opposite of what you likely meant.",
            explanation:
              "In standard written English, two negative words cancel each other out, resulting in a positive meaning. Double negatives are natural in some dialects but are avoided in formal writing.",
            example:
              "❌  I don't know nothing. (= I know something)\n✅  I don't know anything.\n✅  I know nothing.",
            fix: "Replace one negative with its positive equivalent.",
          });
        }
        return findings;
      },
    },

    // ── affect vs effect ─────────────────────────────────────────────────────
    {
      id: "affect-effect",
      check(text) {
        const findings = [];
        const reEffectVerb = /\b(effect(?:s|ed|ing)?)\s+(?:the|a|an|my|your|his|her|its|our|their|this|that|these|those|each|every|any|some|no)\b/gi;
        let m;
        while ((m = reEffectVerb.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[1].length,
            correction: m[1].replace(/^[Ee]ffect/, s => s[0] === "E" ? "Affect" : "affect"),
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: `"${m[1]}" used as a verb — did you mean "affect"?`,
            explanation:
              '"Affect" is almost always a verb (to influence). "Effect" is almost always a noun (the result). "Effect" as a verb is rare and means "to bring about" (e.g., "to effect change").',
            example:
              "❌  The rain effected our plans.\n✅  The rain affected our plans.\n✅  The rain had an effect on our plans.",
            fix: 'Use "affect" if you mean "to influence." Use "effect" for the noun (the result).',
          });
        }
        const reAffectNoun = /\bthe\s+affect\s+of\b/gi;
        while ((m = reAffectNoun.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 6,
            correction: "effect",
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: '"the affect of" — did you mean "the effect of"?',
            explanation:
              '"Effect" is the noun. "Affect" as a noun is a psychology term for emotional state — rarely used outside clinical writing.',
            example:
              "❌  the affect of the medicine\n✅  the effect of the medicine",
            fix: 'Replace "affect" with "effect."',
          });
        }
        return findings;
      },
    },

    // ── who vs whom ──────────────────────────────────────────────────────────
    {
      id: "who-whom",
      check(text) {
        const findings = [];
        const re = /\b(to|for|with|of|by|from|about|at|on|in|through|without|between|among|around|after|before|beside|beyond|despite|except|toward|towards|upon|within|against|along|underneath|underneath|regarding|concerning|following|including|excluding)\s+who\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 3,
            correction: "whom",
            type: "who-whom",
            severity: "warning",
            label: "who vs whom",
            message: `After "${m[1]}," use "whom" not "who."`,
            explanation:
              '"Who" is a subject pronoun (like "he/she/they"). "Whom" is an object pronoun (like "him/her/them"). After a preposition, always use the object form "whom." Quick test: substitute "him" — if it fits, use "whom."',
            example:
              "❌  To who did you give it?\n✅  To whom did you give it?\n   (You gave it to him → him = object → whom)",
            fix: 'Replace "who" with "whom."',
          });
        }
        return findings;
      },
    },

    // ── fewer vs less ─────────────────────────────────────────────────────────
    {
      id: "fewer-less",
      check(text) {
        const findings = [];
        const countableNouns = [
          "people","items","words","sentences","books","cars","dogs","cats",
          "students","employees","errors","mistakes","problems","issues","pages",
          "steps","points","calories","grams","pounds","miles","kilometers",
          "hours","minutes","days","weeks","months","years","dollars","cents",
          "votes","seats","rooms","options","choices","questions","answers",
          "letters","numbers","files","folders","games","players","teams",
          "countries","cities","towns","streets","houses","buildings","floors",
          "windows","doors","chairs","tables","cups","plates","bottles","bags",
          "boxes","lines","rows","columns","paragraphs","chapters","sections",
          "articles","posts","comments","emails","messages","calls","texts",
          "photos","images","videos","songs","movies","shows","episodes",
          "seasons","rounds","levels","stages","steps","attempts","trials",
          "tests","exams","assignments","projects","tasks","goals","meetings",
          "appointments","events","concerts","games","matches","races","trips",
          "flights","tickets","passengers","customers","users","members",
          "accounts","reports","documents","forms","applications","requests",
        ];
        const re = this.re || (this.re = new RegExp(`\\bless\\s+(${countableNouns.join("|")})\\b`, "gi"));
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            correction: "fewer",
            type: "fewer-less",
            severity: "warning",
            label: "fewer vs less",
            message: `Use "fewer" with countable nouns like "${m[1]}", not "less."`,
            explanation:
              '"Fewer" is for things you can count individually (fewer apples, fewer people). "Less" is for uncountable quantities (less water, less time, less information). Quick test: can you say "one ___"? If yes, use "fewer."',
            example:
              `❌  less ${m[1]}\n✅  fewer ${m[1]}\n✅  less water (uncountable)`,
            fix: `Replace "less" with "fewer" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── Irregular past participles ───────────────────────────────────────────
    {
      id: "past-participle",
      check(text) {
        const findings = [];
        const participles = {
          went: "gone", came: "come", saw: "seen", did: "done", ate: "eaten",
          wrote: "written", broke: "broken", spoke: "spoken", took: "taken",
          drank: "drunk", began: "begun", ran: "run", swam: "swum",
          chose: "chosen", drove: "driven", fell: "fallen", flew: "flown",
          froze: "frozen", gave: "given", knew: "known", rode: "ridden",
          rose: "risen", sang: "sung", stole: "stolen", threw: "thrown",
          wore: "worn", woke: "woken", drew: "drawn", grew: "grown",
          rang: "rung", shook: "shaken", sank: "sunk", tore: "torn",
          bit: "bitten", blew: "blown", forgot: "forgotten", hid: "hidden",
          beat: "beaten",
        };
        const re = this.re || (this.re = new RegExp(
          `\\b(have|has|had|having|\\w+['’](?:ve|d))\\s+(${Object.keys(participles).join("|")})\\b`, "gi"
        ));
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const verb = m[2].toLowerCase();
          const part = participles[verb];
          findings.push({
            index: m.index + m[1].length + (m[0].length - m[1].length - m[2].length),
            length: m[2].length,
            correction: part,
            type: "past-participle",
            severity: "error",
            label: "Past participle",
            message: `After "${m[1]}," use "${part}" not "${m[2]}."`,
            explanation:
              `Perfect tenses (have/has/had + verb) need the past participle, not the simple past. Irregular verbs have different forms for each: "I went" (simple past) but "I have gone" (participle). "${m[2]}" is the simple past of this verb; its participle is "${part}."`,
            example: `❌  I have ${m[2]} there.\n✅  I have ${part} there.\n✅  I ${m[2]} there. (simple past, no "have")`,
            fix: `Change "${m[2]}" to "${part}" after "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── Repeated word ────────────────────────────────────────────────────────
    {
      id: "repeated-word",
      check(text) {
        const findings = [];
        // "had had" and "that that" are often legitimate
        const allowed = new Set(["had", "that"]);
        const re = /\b([A-Za-z]+)(\s+)\1\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (allowed.has(m[1].toLowerCase())) continue;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[1],
            type: "repeated-word",
            severity: "warning",
            label: "Repeated word",
            message: `"${m[1]}" appears twice in a row.`,
            explanation:
              "Accidentally typing a word twice is one of the most common editing slips — the eye tends to skip over it, especially across a line break. (A few doubles are legitimate, like “had had”.)",
            example: `❌  the ${m[1].toLowerCase()} ${m[1].toLowerCase()}\n✅  the ${m[1].toLowerCase()}`,
            fix: `Delete the duplicate "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── "Me and X" as subject ────────────────────────────────────────────────
    {
      id: "me-subject",
      check(text) {
        const findings = [];
        const re = /\b[Mm]e\s+and\s+([A-Za-z]+)\s+(?=(?:am|are|was|were|went|go|have|had|will|would|can|could|do|did|think|want|like|need|decided|played|worked|made|got|took|saw)\b)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const other = m[1];
          const fixTo = `${other} and I`;
          findings.push({
            index: m.index,
            length: m[0].trimEnd().length,
            correction: fixTo,
            type: "me-subject",
            severity: "warning",
            label: '"Me and…" as subject',
            message: `"Me and ${other}" is doing the action — use "${fixTo}."`,
            explanation:
              `"Me" is an object pronoun; the subject of a sentence needs "I." Convention also puts the other person first. Quick test: drop the other person — "Me went to the store" sounds wrong, "I went to the store" is right.`,
            example: `❌  Me and ${other} went out.\n✅  ${other} and I went out.\n✅  She saw ${other} and me. (object — "me" is correct)`,
            fix: `Change "me and ${other}" to "${fixTo}."`,
          });
        }
        return findings;
      },
    },

    // ── Double comparatives / superlatives ───────────────────────────────────
    {
      id: "double-comparative",
      check(text) {
        const findings = [];
        const re = this.re || (this.re = /\b(more|most)\s+(better|worse|faster|slower|easier|harder|bigger|smaller|stronger|weaker|smarter|nicer|taller|shorter|older|younger|richer|poorer|happier|sadder|busier|cheaper|cleaner|safer|louder|quieter|simpler|best|worst|fastest|easiest|biggest|smallest|strongest|smartest|nicest|tallest|oldest|youngest|happiest|cheapest|safest|loudest|simplest)\b/gi);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: m[2],
            type: "double-comparative",
            severity: "error",
            label: "Double comparative",
            message: `"${m[0]}" doubles up — "${m[2]}" is already ${m[2].endsWith("st") || ["best","worst"].includes(m[2].toLowerCase()) ? "superlative" : "comparative"}.`,
            explanation:
              `English forms comparatives one way or the other: add -er/-est to short words (bigger, biggest) or put more/most before long ones (more interesting). Combining both ("more better") doubles the comparison and is a grammar error.`,
            example: `❌  ${m[0]}\n✅  ${m[2]}`,
            fix: `Drop "${m[1]}" — say just "${m[2]}."`,
          });
        }
        return findings;
      },
    },

    // ── whose vs who's ───────────────────────────────────────────────────────
    {
      id: "whose-whos",
      check(text) {
        const findings = [];
        const rePoss = /\b[Ww]ho['’]s\s+(book|car|house|idea|turn|fault|phone|name|job|dog|cat|responsibility|decision|money|team|side|bag|desk|coat|seat|room|birthday|round)\b/g;
        let m;
        while ((m = rePoss.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 5,
            correction: m[0][0] === "W" ? "Whose" : "whose",
            type: "whose-whos",
            severity: "error",
            label: "whose vs who's",
            message: `"Who's ${m[1]}" should be "whose ${m[1]}" — it shows possession.`,
            explanation:
              `"Who's" is always the contraction of "who is" or "who has." The possessive form is "whose." Quick test: expand it — "who is ${m[1]}?" makes no sense, so you need "whose."`,
            example: `❌  Who's ${m[1]} is this?\n✅  Whose ${m[1]} is this?\n✅  Who's coming tonight? (= who is)`,
            fix: `Change "who's" to "whose" before "${m[1]}."`,
          });
        }
        const reContr = /\b[Ww]hose\s+(going|coming|responsible|ready|next|calling|talking|winning|first|there|available|attending|joining|paying)\b/g;
        while ((m = reContr.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 5,
            correction: m[0][0] === "W" ? "Who's" : "who's",
            type: "whose-whos",
            severity: "error",
            label: "whose vs who's",
            message: `"Whose ${m[1]}" should be "who's ${m[1]}" (= who is).`,
            explanation:
              `"Whose" shows possession (whose coat is this?). Here you mean "who is ${m[1]}," which contracts to "who's." Quick test: if "who is" fits, use "who's."`,
            example: `❌  Whose ${m[1]}?\n✅  Who's ${m[1]}? (= who is ${m[1]})`,
            fix: `Change "whose" to "who's" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },

    // ── could care less ──────────────────────────────────────────────────────
    {
      id: "could-care-less",
      check(text) {
        const findings = [];
        const re = /\b[Cc]ould\s+care\s+less\b/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: (m[0][0] === "C" ? "Couldn't" : "couldn't") + " care less",
            type: "could-care-less",
            severity: "warning",
            label: '"could care less"',
            message: `"Could care less" says the opposite of what you mean.`,
            explanation:
              `If you COULD care less, you still care some amount. The idiom is "couldn't care less" — your caring is already at zero and cannot go lower. The dropped "n't" flips the meaning.`,
            example: `❌  I could care less about that.\n✅  I couldn't care less about that.`,
            fix: `Add the negative: "couldn't care less."`,
          });
        }
        return findings;
      },
    },

    // ── amount of vs number of ───────────────────────────────────────────────
    {
      id: "amount-number",
      check(text) {
        const findings = [];
        const re = this.re || (this.re = /\b([Aa])mount\s+of\s+(people|persons|items|words|students|cars|books|errors|things|friends|days|hours|minutes|dollars|votes|users|files|questions|problems|times|emails|messages|pages|steps|reasons|options|children|employees|customers)\b/g);
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[1].length + 5,
            correction: m[1] === "A" ? "Number" : "number",
            type: "amount-number",
            severity: "warning",
            label: "amount vs number",
            message: `Use "number of ${m[2]}," not "amount of" — ${m[2]} are countable.`,
            explanation:
              `"Amount" is for uncountable quantities (an amount of water, of time, of effort). Countable things take "number" (a number of people, of errors). Same logic as fewer/less.`,
            example: `❌  amount of ${m[2]}\n✅  number of ${m[2]}\n✅  amount of water (uncountable)`,
            fix: `Change "amount" to "number" before "of ${m[2]}."`,
          });
        }
        return findings;
      },
    },

    // ── between X and Y ──────────────────────────────────────────────────────
    {
      id: "between-and",
      check(text) {
        const findings = [];
        const re = /\b([Bb]etween)\s+(\w+)\s+(to|or)\s+(\w+)\b/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: `${m[1]} ${m[2]} and ${m[4]}`,
            type: "between-and",
            severity: "warning",
            label: "between … and",
            message: `"Between" pairs with "and," not "${m[3]}."`,
            explanation:
              `The construction is always "between X and Y." Ranges tempt people into "between 5 to 10," but "to" belongs with "from" ("from 5 to 10"). Pick one pattern: "between 5 and 10" or "from 5 to 10."`,
            example: `❌  between ${m[2]} ${m[3]} ${m[4]}\n✅  between ${m[2]} and ${m[4]}\n✅  from ${m[2]} to ${m[4]}`,
            fix: `Change "${m[3]}" to "and" (or use "from … to").`,
          });
        }
        return findings;
      },
    },

    // ── try and ──────────────────────────────────────────────────────────────
    {
      id: "try-and",
      check(text) {
        const findings = [];
        const re = /\b([Tt])ry\s+and\s+(?=[a-z]+\b)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].trimEnd().length,
            correction: `${m[1]}ry to`,
            type: "try-and",
            severity: "info",
            label: '"try and" vs "try to"',
            message: `"Try and" is casual — "try to" is the standard form.`,
            explanation:
              `"Try and do it" literally describes two actions (trying, and doing). "Try to do it" expresses the intended meaning — attempting the action. "Try and" is fine in speech but "try to" is preferred in writing.`,
            example: `❌  I will try and finish today.\n✅  I will try to finish today.`,
            fix: `Change "try and" to "try to."`,
          });
        }
        return findings;
      },
    },

    // ── Question ending in a period ──────────────────────────────────────────
    {
      id: "missing-question-mark",
      check(text) {
        const findings = [];
        const AUX = "(?:is|are|was|were|am|do|does|did|can|could|will|would|should|shall|have|has|had)";
        // Direct: "How are you." / "What is your name." — aux right after the
        // question word, so declaratives like "What matters is effort." don't fire.
        // Determiner: "Whose name is yours." / "Which one do you want."
        // Yes/no questions: aux + pronoun at sentence start ("Can you help me.").
        // Should/Were/Had are excluded — they open conditionals ("Should you
        // need anything, call me."), and bare "Do it." is imperative.
        const YNAUX = "(?:Can|Could|Would|Will|Do(?!\\s+it\\b)|Does|Did|Is|Are|Am|May|Shall|Don['’]t|Doesn['’]t|Didn['’]t|Isn['’]t|Aren['’]t|Can['’]t|Couldn['’]t|Wouldn['’]t|Won['’]t|Shouldn['’]t)";
        const res = this.res || (this.res = [
          new RegExp(`(^|[.!?]\\s+|\\n\\s*)(Who|What|Where|When|Why|How|Whose|Which)\\s+${AUX}\\b(?!\\s+more,|\\s+worse,)[^.!?\\n]*?(\\.)`, "g"),
          new RegExp(`(^|[.!?]\\s+|\\n\\s*)(Whose|Which)\\s+\\w+\\s+${AUX}\\b[^.!?\\n]*?(\\.)`, "g"),
          new RegExp(`(^|[.!?]\\s+|\\n\\s*)(${YNAUX})\\s+(?:you|we|they|he|she|it|I|anyone|anybody|someone|somebody|there)\\b[^.!?\\n]*?(\\.)`, "g"),
        ]);
        const seen = new Set();
        for (const re of res) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            const periodIndex = m.index + m[0].length - 1;
            if (seen.has(periodIndex)) continue;
            seen.add(periodIndex);
            const sentence = m[0].slice(m[1].length);
            findings.push({
              index: periodIndex,
              length: 1,
              correction: "?",
              type: "missing-question-mark",
              severity: "warning",
              label: "Question mark",
              message: `This looks like a question — end it with "?" instead of a period.`,
              explanation:
                `Sentences that start with a question word (who, what, where, how…) followed by a verb are direct questions, and direct questions end with a question mark. A period makes the sentence read as a flat statement.`,
              example: `❌  ${sentence}\n✅  ${sentence.slice(0, -1)}?`,
              fix: `Change the period to a question mark.`,
            });
          }
        }
        return findings;
      },
    },

    // ── Unnatural question phrasing ──────────────────────────────────────────
    {
      id: "question-phrasing",
      check(text) {
        const findings = [];
        // "Whose name is yours?" asks who owns something while answering it —
        // the natural question is "What is your name?"
        const possMap = { yours: "your", mine: "my", his: "his", hers: "her", theirs: "their", ours: "our" };
        const reWhose = /\b([Ww])hose\s+(\w+)\s+(is|are)\s+(yours|mine|his|hers|theirs|ours)\b/g;
        let m;
        while ((m = reWhose.exec(text)) !== null) {
          const poss = possMap[m[4].toLowerCase()];
          const fixTo = `${m[1] === "W" ? "What" : "what"} ${m[3]} ${poss} ${m[2]}`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "question-phrasing",
            severity: "warning",
            label: "Question phrasing",
            message: `"${m[0]}" is a tangled question — the natural form is "${fixTo}."`,
            explanation:
              `"Whose" asks who something belongs to, but "${m[4]}" already answers that — so the sentence asks and answers at once. When you want to know the thing itself, ask with "what": "${fixTo}?"`,
            example: `❌  ${m[0]}?\n✅  ${fixTo}?`,
            fix: `Rephrase as "${fixTo}?"`,
          });
        }
        // "How do you call this?" → "What do you call this?"
        const reHowCall = /\b([Hh])ow\s+do\s+(you|we|they)\s+call\b/g;
        while ((m = reHowCall.exec(text)) !== null) {
          const fixTo = `${m[1] === "H" ? "What" : "what"} do ${m[2]} call`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "question-phrasing",
            severity: "warning",
            label: "Question phrasing",
            message: `English asks "what do ${m[2]} call…," not "how do ${m[2]} call…"`,
            explanation:
              `"How" asks about manner (in what way); names are things, so English uses "what." Many languages phrase this with "how," which makes this one of the most common phrasing slips for multilingual writers.`,
            example: `❌  How do ${m[2]} call this?\n✅  What do ${m[2]} call this?`,
            fix: `Change "how" to "what."`,
          });
        }
        // "How does it look like?" → "What does it look like?"
        const reLookLike = /\b([Hh])ow\s+(does|do|did)\s+(\w+)\s+look\s+like\b/g;
        while ((m = reLookLike.exec(text)) !== null) {
          const fixTo = `${m[1] === "H" ? "What" : "what"} ${m[2]} ${m[3]} look like`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "question-phrasing",
            severity: "warning",
            label: "Question phrasing",
            message: `Use "what … look like" or "how … look" — not both.`,
            explanation:
              `Two patterns got blended: "How does it look?" and "What does it look like?" both work, but "how … look like" mixes them. "Like" pairs with "what."`,
            example: `❌  How does it look like?\n✅  What does it look like?\n✅  How does it look?`,
            fix: `Change "how" to "what" (or drop "like").`,
          });
        }
        // Uninverted questions: "Why you are sad?" → "Why are you sad?"
        // Anchored to sentence start so embedded clauses ("Do you know what
        // you are doing?") don't fire; requires the trailing "?"
        const reUninv = /(^|[.!?]\s+|\n\s*)(Where|What|When|Why|How|Who)\s+(you|we|they|he|she|it|i)\s+(am|is|are|was|were|do|does|did|can|could|will|would|should)\b([^.!?\n]*)\?/gm;
        while ((m = reUninv.exec(text)) !== null) {
          const pron = m[3] === "i" ? "I" : m[3];
          const fixTo = `${m[2]} ${m[4]} ${pron}${m[5]}?`;
          const start = m.index + m[1].length;
          findings.push({
            index: start,
            length: m[0].length - m[1].length,
            correction: fixTo,
            type: "question-phrasing",
            severity: "warning",
            label: "Question phrasing",
            message: `Questions invert the verb: "${m[2]} ${m[4]} ${pron}…?"`,
            explanation:
              `Direct questions in English swap the subject and auxiliary verb: "you are" becomes "are you." Keeping statement order ("Why you are sad?") is a very common carry-over from languages that form questions by intonation alone.`,
            example: `❌  ${m[2]} ${m[3]} ${m[4]}…?\n✅  ${m[2]} ${m[4]} ${pron}…?`,
            fix: `Swap them: "${m[2]} ${m[4]} ${pron}…?"`,
          });
        }
        // "Can you borrow me your pen?" → "lend me"
        const reBorrow = /\b([Bb])orrow\s+(me|us|him|her|them)\b/g;
        while ((m = reBorrow.exec(text)) !== null) {
          const fixTo = `${m[1] === "B" ? "Lend" : "lend"} ${m[2]}`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "question-phrasing",
            severity: "warning",
            label: "borrow vs lend",
            message: `The giver lends; the receiver borrows — here you want "${fixTo}."`,
            explanation:
              `"Borrow" means to take temporarily; "lend" means to give temporarily. You borrow FROM someone and lend TO someone, so "borrow me your pen" reverses the direction — the person with the pen lends it.`,
            example: `❌  Can you borrow me your pen?\n✅  Can you lend me your pen?\n✅  Can I borrow your pen?`,
            fix: `Change "borrow ${m[2]}" to "${fixTo}."`,
          });
        }
        return findings;
      },
    },

    // ── Eggcorns (misheard idioms) ───────────────────────────────────────────
    {
      id: "eggcorn",
      check(text) {
        const findings = [];
        const eggcorns = {
          "for all intensive purposes": "for all intents and purposes",
          "one in the same": "one and the same",
          "nip it in the butt": "nip it in the bud",
          "case and point": "case in point",
          "peaked my interest": "piqued my interest",
          "peaked your interest": "piqued your interest",
          "deep seeded": "deep-seated",
          "escape goat": "scapegoat",
          "mute point": "moot point",
          "doggy dog world": "dog-eat-dog world",
          "supposably": "supposedly",
          "irregardless": "regardless",
          "on tenderhooks": "on tenterhooks",
          "baited breath": "bated breath",
          "wet your appetite": "whet your appetite",
          "free reign": "free rein",
          "sneak peak": "sneak peek",
          "piece of mind": "peace of mind",
          "tow the line": "toe the line",
          "beckon call": "beck and call",
          "pass mustard": "pass muster",
          "expresso": "espresso",
          "statue of limitations": "statute of limitations",
          "self-depreciating": "self-deprecating",
          "worse comes to worse": "worst comes to worst",
          "extract revenge": "exact revenge",
          "hunger pains": "hunger pangs",
          "in one foul swoop": "in one fell swoop",
          "per say": "per se",
          "day in age": "day and age",
          "chock it up": "chalk it up",
          "all of the sudden": "all of a sudden",
          "by in large": "by and large",
          "hone in on": "home in on",
          "make due": "make do",
          "made due": "made do",
          "making due": "making do",
          "peak your interest": "pique your interest",
          "peak my interest": "pique my interest",
          "peaks my interest": "piques my interest",
          "peaks your interest": "piques your interest",
          "sneak peaks": "sneak peeks",
          "beyond the pail": "beyond the pale",
          "reign in": "rein in",
          "reign it in": "rein it in",
          "shoe-in": "shoo-in",
          "tongue and cheek": "tongue-in-cheek",
          "scot free": "scot-free",
          "scott free": "scot-free",
          "another words": "in other words",
          "flush out the details": "flesh out the details",
          "flush out the idea": "flesh out the idea",
          "doesn't phase": "doesn't faze",
          "didn't phase": "didn't faze",
          "won't phase": "won't faze",
          "wreck havoc": "wreak havoc",
          "wrecking havoc": "wreaking havoc",
          "without further adieu": "without further ado",
          "take for granite": "take for granted",
          "curve your appetite": "curb your appetite",
          "curve your enthusiasm": "curb your enthusiasm",
          "bare in mind": "bear in mind",
          "bare with me": "bear with me",
          "jive with": "jibe with",
          "step foot in": "set foot in",
          "on route to": "en route to",
          "segway into": "segue into",
          "prostrate cancer": "prostate cancer",
          "conversate": "converse",
          "conversating": "conversing",
          "excetera": "et cetera",
        };
        if (!this.compiled) {
          this.compiled = Object.entries(eggcorns).map(([wrong, right]) => ({
            wrong,
            right,
            re: new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "gi"),
          }));
        }
        for (const { wrong, right, re } of this.compiled) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            const corrected = m[0][0] === m[0][0].toUpperCase() && m[0][0] !== m[0][0].toLowerCase()
              ? right[0].toUpperCase() + right.slice(1) : right;
            findings.push({
              index: m.index,
              length: m[0].length,
              correction: corrected,
              type: "eggcorn",
              severity: "error",
              label: "Misheard idiom",
              message: `The idiom is "${right}," not "${wrong}."`,
              explanation:
                `This is an "eggcorn" — a phrase misheard as similar-sounding words that seem to make sense. The established idiom is "${right}"; the misheard version stands out to readers who know it.`,
              example: `❌  ${wrong}\n✅  ${right}`,
              fix: `Replace with "${right}."`,
            });
          }
        }
        return findings;
      },
    },

    // ── Redundant pairs ──────────────────────────────────────────────────────
    {
      id: "redundant-pair",
      check(text) {
        const findings = [];
        const pairs = {
          "return back": "return", "returned back": "returned", "returning back": "returning",
          "revert back": "revert", "reverted back": "reverted",
          "repeat again": "repeat", "repeated again": "repeated",
          "discuss about": "discuss", "discussed about": "discussed", "discussing about": "discussing",
          "in regards to": "regarding",
          "join together": "join", "joined together": "joined",
          "combine together": "combine", "combined together": "combined",
          "merge together": "merge", "merged together": "merged",
          "advance planning": "planning",
          "raise up": "raise", "lower down": "lower",
          "absolutely essential": "essential",
          "brief moment": "moment",
          "close scrutiny": "scrutiny",
          "collaborate together": "collaborate", "collaborated together": "collaborated",
          "completely finished": "finished",
          "consensus of opinion": "consensus",
          "general consensus": "consensus",
          "continue on": "continue", "continued on": "continued",
          "current status quo": "status quo",
          "empty out": "empty", "emptied out": "emptied",
          "exact same": "same",
          "final conclusion": "conclusion",
          "first began": "began",
          "foreign imports": "imports",
          "past experience": "experience",
          "personal opinion": "opinion",
          "plan in advance": "plan",
          "postpone until later": "postpone",
          "refer back": "refer", "referred back": "referred",
          "reply back": "reply", "replied back": "replied",
          "sum total": "total",
          "warn in advance": "warn", "warned in advance": "warned",
          "whether or not": "whether",
          "added together": "added",
          "blend together": "blend", "blended together": "blended",
          "connect together": "connect", "connected together": "connected",
          "cooperate together": "cooperate",
          "meet together": "meet",
          "still remains": "remains",
        };
        if (!this.compiled) {
          this.compiled = Object.entries(pairs).map(([wrong, right]) => ({
            wrong,
            right,
            re: new RegExp(`\\b${wrong.replace(/\s+/g, "\\s+")}\\b`, "gi"),
          }));
        }
        for (const { wrong, right, re } of this.compiled) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) !== null) {
            const corrected = m[0][0] === m[0][0].toUpperCase() && m[0][0] !== m[0][0].toLowerCase()
              ? right[0].toUpperCase() + right.slice(1) : right;
            findings.push({
              index: m.index,
              length: m[0].length,
              correction: corrected,
              type: "redundant-pair",
              severity: "info",
              label: "Redundant pair",
              message: `"${m[0]}" says it twice — "${right}" already contains the idea.`,
              explanation:
                `The second word repeats meaning already in the first: you can only return by going back, and discussing is always "about" something. Dropping the extra word tightens the sentence without losing anything.`,
              example: `❌  ${wrong}\n✅  ${right}`,
              fix: `Use just "${right}."`,
            });
          }
        }
        return findings;
      },
    },

    // ── Unidiomatic constructions ────────────────────────────────────────────
    {
      id: "unidiomatic",
      check(text) {
        const findings = [];
        // "I am agree" → "I agree" (agree is a verb, not an adjective)
        const agreeMap = { am: "agree", are: "agree", is: "agrees", was: "agreed", were: "agreed" };
        const reAgree = /\b(am|are|is|was|were)\s+agree\b/gi;
        let m;
        while ((m = reAgree.exec(text)) !== null) {
          const fixTo = agreeMap[m[1].toLowerCase()];
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `"${m[0]}" — "agree" is a verb, so no "${m[1]}" is needed: "${fixTo}."`,
            explanation:
              `In English, "agree" works like "run" or "know" — it IS the verb, so it can't follow am/is/are the way an adjective would. Say "I agree," not "I am agree." (The adjective form is "agreeable," which means something different.)`,
            example: `❌  I ${m[1].toLowerCase()} agree with you.\n✅  I agree with you.`,
            fix: `Drop "${m[1]}" — say "${fixTo}."`,
          });
        }
        // "make a photo" → "take a photo"
        const reMake = /\b([Mm])ake\s+(a|an|some)\s+(photo|photos|picture|pictures)\b/g;
        while ((m = reMake.exec(text)) !== null) {
          const fixTo = `${m[1] === "M" ? "Take" : "take"} ${m[2]} ${m[3]}`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `English "takes" photos rather than "making" them.`,
            explanation:
              `Verb–noun pairings (collocations) are conventions: English takes photos, makes decisions, and does homework. Many languages "make" a photo, so this is a very common carry-over.`,
            example: `❌  make ${m[2]} ${m[3]}\n✅  take ${m[2]} ${m[3]}`,
            fix: `Change "make" to "take."`,
          });
        }
        // "open the light" → "turn on the light"
        const reLight = /\b([Oo]pen|[Cc]lose)\s+the\s+(light|lights|TV|tv|radio)\b/g;
        while ((m = reLight.exec(text)) !== null) {
          const isOpen = m[1].toLowerCase() === "open";
          const verb = isOpen ? "turn on" : "turn off";
          const fixTo = `${m[1][0] === m[1][0].toUpperCase() ? verb[0].toUpperCase() + verb.slice(1) : verb} the ${m[2]}`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `English "${verb}s" the ${m[2]} — "open/close" is for doors and containers.`,
            explanation:
              `Devices and lights are turned on and off in English; open/close describes physical objects like doors, windows, and boxes. Many languages use open/close for both, so this is a common carry-over.`,
            example: `❌  ${m[1].toLowerCase()} the ${m[2]}\n✅  ${verb} the ${m[2]}`,
            fix: `Use "${verb}" instead of "${m[1].toLowerCase()}."`,
          });
        }
        // "explain me the rule" → "explain to me the rule"
        const reExplain = /\b(explain|explains|explained|describe|describes|described|suggest|suggests|suggested|recommend|recommends|recommended)\s+(me|us|him|her|them)\b(?=\s+(?:the|this|that|a|an|how|what|why|your|my|our|his|her|their|it))/gi;
        while ((m = reExplain.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: `${m[1]} to ${m[2]}`,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `"${m[1]}" needs "to" before the person: "${m[1]} to ${m[2]}."`,
            explanation:
              `Verbs like tell and show take the person directly ("tell me the rule"), but explain, describe, suggest, and recommend need "to": "explain the rule to me" or "explain to me the rule." Mixing the two patterns is a classic carry-over.`,
            example: `❌  Explain me the rule.\n✅  Explain the rule to me.\n✅  Explain to me how it works.`,
            fix: `Add "to": "${m[1]} to ${m[2]}."`,
          });
        }
        // "say me the truth" → "tell me"
        const sayMap = { say: "tell", says: "tells", said: "told", saying: "telling" };
        const reSay = /\b(say|says|said|saying)\s+(me|us|him|her|them)\b/gi;
        while ((m = reSay.exec(text)) !== null) {
          const verb = sayMap[m[1].toLowerCase()];
          const fixTo = `${m[1][0] === m[1][0].toUpperCase() ? verb[0].toUpperCase() + verb.slice(1) : verb} ${m[2]}`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "say vs tell",
            message: `You "tell" a person and "say" words — here you want "${fixTo}."`,
            explanation:
              `"Tell" takes the listener directly (tell me, tell her); "say" takes the words (say something, say that…). "Say me" mixes them — English never puts the person right after "say."`,
            example: `❌  Say me the truth.\n✅  Tell me the truth.\n✅  Say what you mean.`,
            fix: `Change "${m[1].toLowerCase()}" to "${verb}."`,
          });
        }
        // "listening music" → "listening to music"
        const reListen = /\b(listen|listens|listened|listening)\b(?=\s+(?:music|songs|podcasts|the\s+(?:radio|music|song|podcast)))/gi;
        while ((m = reListen.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[1].length,
            correction: `${m[1]} to`,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `"Listen" needs "to" before the thing you hear.`,
            explanation:
              `"Hear" takes its object directly (hear music), but "listen" always needs "to": listen to music, listen to the radio. Dropping the "to" is one of the most common preposition slips.`,
            example: `❌  I love listening music.\n✅  I love listening to music.`,
            fix: `Add "to" after "${m[1].toLowerCase()}."`,
          });
        }
        // "depends of" → "depends on"
        const reDepend = /\b(depend|depends|depended|depending)\s+of\b/gi;
        while ((m = reDepend.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: `${m[1]} on`,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `English says "${m[1]} on," not "${m[1]} of."`,
            explanation:
              `Many languages pair their "depend" with "of" (depende de, dépend de), but English fixed on "on": it depends on the weather. Prepositions after verbs are conventions to memorize, not logic.`,
            example: `❌  It depends of the weather.\n✅  It depends on the weather.`,
            fix: `Change "of" to "on."`,
          });
        }
        // "married with John" → "married to John" (but "married with children" stays)
        const reMarried = /\bmarried\s+with\b(?=\s+(?:him|her|them|[A-Z]))/g;
        while ((m = reMarried.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: "married to",
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `You're "married to" a person, not "married with."`,
            explanation:
              `English uses "to" for the spouse: married to Alex. "With" describes what accompanies the marriage — "married with children" means having kids, not being wed to them.`,
            example: `❌  She is married with John.\n✅  She is married to John.\n✅  Married, with two children.`,
            fix: `Change "with" to "to."`,
          });
        }
        // "make homework" → "do homework"
        const reHomework = /\b([Mm])ake\s+((?:my|your|his|her|their|our|the|some)\s+)?homework\b/g;
        while ((m = reHomework.exec(text)) !== null) {
          const fixTo = `${m[1] === "M" ? "Do" : "do"} ${m[2] || ""}homework`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `English "does" homework rather than "making" it.`,
            explanation:
              `Do vs. make is a collocation minefield: you do homework, work, and the dishes; you make decisions, mistakes, and dinner. There's no rule — each pairing is a convention.`,
            example: `❌  make ${m[2] || ""}homework\n✅  do ${m[2] || ""}homework`,
            fix: `Change "make" to "do."`,
          });
        }
        // "make a party" → "throw a party"
        const reParty = /\b([Mm])ake\s+a\s+party\b/g;
        while ((m = reParty.exec(text)) !== null) {
          const fixTo = `${m[1] === "M" ? "Throw" : "throw"} a party`;
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: fixTo,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `English "throws" or "has" a party rather than "making" one.`,
            explanation:
              `Collocation again: parties are thrown, held, or had in English. "Make a party" is understandable but marks the sentence as non-native.`,
            example: `❌  We will make a party.\n✅  We will throw a party.\n✅  We will have a party.`,
            fix: `Change "make" to "throw" (or "have").`,
          });
        }
        // "cousin brother" → "cousin" (standard in Indian English; flagged for
        // international-audience writing)
        const reCousin = /\b([Cc])ousin\s+(brother|sister)\b/g;
        while ((m = reCousin.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            correction: `${m[1]}ousin`,
            type: "unidiomatic",
            severity: "warning",
            label: "Unidiomatic phrasing",
            message: `Outside Indian English, it's just "cousin" — no "${m[2]}."`,
            explanation:
              `"Cousin ${m[2]}" is standard in Indian English to mark the cousin's gender. International English uses plain "cousin" for both, adding "male/female cousin" only when the distinction matters.`,
            example: `❌  my cousin ${m[2]}\n✅  my cousin`,
            fix: `Drop "${m[2]}" — say "cousin."`,
          });
        }
        // "take a decision" → "make a decision" (fine in British English)
        if (dialect === "us" || dialect === "ca") {
          const reDecision = /\b([Tt])ake\s+(a|the)\s+(decision|decisions)\b/g;
          while ((m = reDecision.exec(text)) !== null) {
            const fixTo = `${m[1] === "T" ? "Make" : "make"} ${m[2]} ${m[3]}`;
            findings.push({
              index: m.index,
              length: m[0].length,
              correction: fixTo,
              type: "unidiomatic",
              severity: "info",
              label: "Unidiomatic phrasing",
              message: `American English "makes" decisions ("take a decision" is British).`,
              explanation:
                `Both are correct somewhere: British English happily "takes decisions," while American English almost always "makes" them. Since your dialect is set to ${DIALECT_NAMES[dialect]}, "make" is the expected form.`,
              example: `❌  take ${m[2]} ${m[3]} (US)\n✅  make ${m[2]} ${m[3]}`,
              fix: `Change "take" to "make."`,
            });
          }
        }
        return findings;
      },
    },

    // ── Texting shorthand ────────────────────────────────────────────────────
    {
      id: "informal-abbreviation",
      check(text) {
        const findings = [];
        const shorthand = {
          "u r": "you are", "r u": "are you", "u": "you", "ur": "your",
          "thx": "thanks", "pls": "please", "plz": "please", "ppl": "people",
          "msg": "message", "msgs": "messages", "pic": "picture", "pics": "pictures",
          "tho": "though", "thru": "through", "cuz": "because", "coz": "because",
          "bc": "because", "b/c": "because", "w/o": "without", "w/": "with",
          "gonna": "going to", "wanna": "want to", "gotta": "have to",
          "kinda": "kind of", "sorta": "sort of", "dunno": "don't know",
          "idk": "I don't know", "imo": "in my opinion", "imho": "in my humble opinion",
          "btw": "by the way", "fyi": "for your information",
          "asap": "as soon as possible", "tbh": "to be honest",
          "rn": "right now", "nvm": "never mind", "omw": "on my way",
          "ty": "thank you", "yw": "you're welcome",
          "l8r": "later", "gr8": "great", "2day": "today",
          "2morrow": "tomorrow", "b4": "before",
        };
        if (!this.compiled) {
          // Longest keys first so "u r" wins over "u", "w/o" over "w/"
          const keys = Object.keys(shorthand).sort((a, b) => b.length - a.length)
            .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
          this.compiled = new RegExp(`(?<![\\w/])(${keys.join("|")})(?![\\w/])`, "gi");
          this.map = shorthand;
        }
        this.compiled.lastIndex = 0;
        let m;
        while ((m = this.compiled.exec(text)) !== null) {
          const token = m[1];
          // ALL-CAPS forms (FYI, ASAP, BC) read as established initialisms or
          // other meanings — only coach the lowercase texting style
          if (token.length >= 2 && token === token.toUpperCase() && /[A-Z]/.test(token)) continue;
          const expansion = this.map[token.toLowerCase().replace(/\s+/g, " ")];
          if (!expansion) continue;
          const corrected = token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase()
            ? expansion[0].toUpperCase() + expansion.slice(1) : expansion;
          findings.push({
            index: m.index,
            length: token.length,
            correction: corrected,
            type: "informal-abbreviation",
            severity: "info",
            label: "Texting shorthand",
            message: `"${token}" is texting shorthand — in most writing, spell out "${expansion}."`,
            explanation:
              `Shorthand like "${token}" is fine in chats but reads as rushed or too casual in email, schoolwork, and anything professional. Spelling it out ("${expansion}") costs a second and changes how the writing is received.`,
            example: `❌  ${token}\n✅  ${expansion}`,
            fix: `Write "${expansion}" in full.`,
          });
        }
        return findings;
      },
    },

    // ── Regional spelling (dialect) ──────────────────────────────────────────
    {
      id: "dialect-spelling",
      check(text) {
        const findings = [];
        const { map, re } = buildDialectData();
        if (!re) return findings;
        const target = DIALECT_NAMES[dialect] || "American";
        let m;
        while ((m = re.exec(text)) !== null) {
          const wrong = m[1].toLowerCase();
          const correct = map[wrong];
          if (!correct) continue;
          const corrected = m[1][0] === m[1][0].toUpperCase() && m[1][0] !== m[1][0].toLowerCase()
            ? correct[0].toUpperCase() + correct.slice(1) : correct;
          findings.push({
            index: m.index,
            length: m[1].length,
            correction: corrected,
            type: "dialect-spelling",
            severity: "info",
            label: `Regional spelling (${target})`,
            message: `"${m[1]}" isn't the ${target} English spelling — use "${correct}."`,
            explanation:
              `English spelling differs by region. In ${target} English the standard spelling is "${correct}." Common patterns: -our/-or (colour/color), -re/-er (centre/center), -ise/-ize (organise/organize), and doubled L (travelled/traveled). You can change your dialect in the Gramr popup.`,
            example: `❌  ${m[1]}\n✅  ${corrected}`,
            fix: `Change "${m[1]}" to "${corrected}" for ${target} English.`,
          });
        }
        re.lastIndex = 0;
        return findings;
      },
    },

    // ── Tense consistency ────────────────────────────────────────────────────
    {
      id: "tense-shift",
      check(text) {
        const findings = [];
        const presentToPast = {
          is: "was", are: "were", am: "was", goes: "went", comes: "came",
          says: "said", sees: "saw", eats: "ate", walks: "walked",
          runs: "ran", gets: "got", takes: "took", makes: "made",
          wants: "wanted", knows: "knew", thinks: "thought", tells: "told",
          asks: "asked", gives: "gave", finds: "found", feels: "felt",
          becomes: "became", leaves: "left", starts: "started", begins: "began",
          buys: "bought", meets: "met", decides: "decided", arrives: "arrived",
        };
        const pastAdverbial = "(?:yesterday|last\\s+(?:night|week|month|year|summer|winter))(?!['’]s)";
        const rePast = this.rePast || (this.rePast = new RegExp(
          `\\b(?<!since\\s)(${pastAdverbial})\\b([^.!?\\n]{0,60}?)\\b(${Object.keys(presentToPast).join("|")})\\b`,
          "gi"
        ));
        rePast.lastIndex = 0;
        let m;
        while ((m = rePast.exec(text)) !== null) {
          const verb = m[3].toLowerCase();
          findings.push({
            index: m.index + m[1].length + m[2].length,
            length: m[3].length,
            correction: presentToPast[verb],
            type: "tense-shift",
            severity: "warning",
            label: "Tense consistency",
            message: `"${m[1]}" signals past time, but "${m[3]}" is present tense.`,
            explanation:
              `Time markers like "yesterday" or "last week" put the sentence in the past, so its verbs should be in past tense. Shifting tense mid-sentence confuses the reader about when things happened. Keep the tense consistent with the time frame you set.`,
            example: `❌  ${m[1]} she ${m[3]} to the store.\n✅  ${m[1]} she ${presentToPast[verb]} to the store.`,
            fix: `Change "${m[3]}" to "${presentToPast[verb]}" to match the past time frame.`,
          });
        }
        const pastToFuture = {
          was: "will be", were: "will be", went: "will go", came: "will come",
          said: "will say", saw: "will see", ate: "will eat",
          walked: "will walk", ran: "will run", took: "will take",
          made: "will make", bought: "will buy", met: "will meet",
          arrived: "will arrive", started: "will start", left: "will leave",
        };
        const futureAdverbial = "(?:tomorrow|next\\s+(?:week|month|year|summer|winter))(?!['’]s)";
        const reFuture = this.reFuture || (this.reFuture = new RegExp(
          `\\b(${futureAdverbial})\\b([^.!?\\n]{0,60}?)\\b(${Object.keys(pastToFuture).join("|")})\\b`,
          "gi"
        ));
        reFuture.lastIndex = 0;
        while ((m = reFuture.exec(text)) !== null) {
          const verb = m[3].toLowerCase();
          findings.push({
            index: m.index + m[1].length + m[2].length,
            length: m[3].length,
            correction: pastToFuture[verb],
            type: "tense-shift",
            severity: "warning",
            label: "Tense consistency",
            message: `"${m[1]}" signals future time, but "${m[3]}" is past tense.`,
            explanation:
              `Time markers like "tomorrow" or "next week" put the sentence in the future, so past-tense verbs clash with them. Use "will" + verb (or present tense for scheduled events: "the train leaves tomorrow").`,
            example: `❌  ${m[1]} we ${m[3]} to the beach.\n✅  ${m[1]} we ${pastToFuture[verb]} to the beach.`,
            fix: `Change "${m[3]}" to "${pastToFuture[verb]}" to match the future time frame.`,
          });
        }
        return findings;
      },
    },

    // ── Misspellings ─────────────────────────────────────────────────────────
    {
      id: "misspelling",
      check(text) {
        const findings = [];
        let m;
        while ((m = MISSPELLING_RE.exec(text)) !== null) {
          const wrong = m[1].toLowerCase();
          const correct = MISSPELLINGS[wrong];
          if (!correct) continue;
          const corrected = m[1][0] === m[1][0].toUpperCase() && m[1][0] !== m[1][0].toLowerCase()
            ? correct[0].toUpperCase() + correct.slice(1) : correct;
          findings.push({
            index: m.index,
            length: m[1].length,
            correction: corrected,
            type: "misspelling",
            severity: "error",
            label: "Misspelling",
            message: `"${m[1]}" is misspelled.`,
            explanation:
              `"${m[1]}" is a common misspelling. The correct spelling is "${correct}." Misspellings like this often occur because the word sounds different from how it is written, or because a common pattern is incorrectly applied.`,
            example: `❌  ${m[1]}\n✅  ${correct}`,
            fix: `Change "${m[1]}" to "${correct}."`,
          });
        }
        MISSPELLING_RE.lastIndex = 0;
        return findings;
      },
    },

    // ── Dictionary spellcheck ────────────────────────────────────────────────
    // Runs after the curated misspelling list (dedup keeps the curated finding
    // when both fire on the same word). Same id so the popup toggle covers both.
    {
      id: "misspelling",
      check(text) {
        const findings = [];
        if (!DICT) return findings;
        // Never spellcheck inside URLs, emails, inline code, or filenames
        const masks = [];
        SPELL_MASK_RE.lastIndex = 0;
        let mk;
        while ((mk = SPELL_MASK_RE.exec(text)) !== null) {
          masks.push([mk.index, mk.index + mk[0].length]);
        }
        const inMask = (i, len) => masks.some(([s, e]) => i < e && i + len > s);
        const tokenRe = /[A-Za-z']+/g;
        let m;
        while ((m = tokenRe.exec(text)) !== null && findings.length < 40) {
          const word = m[0];
          if (masks.length && inMask(m.index, word.length)) continue;
          // Skip: short words, anything with an apostrophe (contractions,
          // possessives), capitalized words (names, sentence starts are
          // checked lowercased), and ALL-CAPS acronyms
          if (word.length < 4 || word.length > 24) continue;
          if (word.includes("'")) continue;
          if (word === word.toUpperCase()) continue;
          const lower = word.toLowerCase();
          if (word[0] !== lower[0]) continue;
          if (DICT.has(lower)) continue;
          const suggestion = suggestFor(lower);
          findings.push({
            index: m.index,
            length: word.length,
            ...(suggestion !== null && suggestion !== undefined ? { correction: suggestion } : {}),
            type: "misspelling",
            severity: "error",
            label: "Possible misspelling",
            message: suggestion
              ? `"${word}" doesn't look like a word — did you mean "${suggestion}"?`
              : `"${word}" doesn't appear in the dictionary.`,
            explanation:
              suggestion
                ? `"${word}" isn't in Gramr's 50,000-word dictionary. The closest common word is "${suggestion}." If this is a name or specialist term you use often, click "Ignore — I meant this" and Gramr will remember it.`
                : `"${word}" isn't in Gramr's 50,000-word dictionary and no close match was found. If it's a real word, name, or technical term, click "Ignore — I meant this" and Gramr will remember it.`,
            example: suggestion ? `❌  ${word}\n✅  ${suggestion}` : `❓  ${word}`,
            fix: suggestion
              ? `Change "${word}" to "${suggestion}."`
              : `Double-check the spelling of "${word}."`,
          });
        }
        return findings;
      },
    },
  ];
})();
