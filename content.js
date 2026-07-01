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
  let sessionStats = { errors: 0, warnings: 0, info: 0, seen: new Set() };

  // ─── Settings ────────────────────────────────────────────────────────────────
  const DEBOUNCE_MS = 800;
  const SEVERITY_COLORS = {
    error: "#ef4444",
    warning: "#f59e0b",
    info: "#3b82f6",
  };

  // ─── Init ─────────────────────────────────────────────────────────────────────
  chrome.storage.sync.get({ enabled: true }, (res) => {
    enabled = res.enabled;
    if (enabled) attachListeners();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (!enabled) {
        removeAllHighlights();
        closeTooltip();
      } else {
        attachListeners();
      }
    }
  });

  function attachListeners() {
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("click", onDocClick, true);
  }

  // ─── Focus / blur ────────────────────────────────────────────────────────────
  function onFocusIn(e) {
    const el = e.target;
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
    if (activeTooltip && !activeTooltip.contains(e.target)) {
      closeTooltip();
    }
  }

  // ─── Text extraction ─────────────────────────────────────────────────────────
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "email", "url", "tel", "password", ""].includes(t);
    }
    if (el.tagName === "TEXTAREA") return true;
    return false;
  }

  function getText(el) {
    if (el.isContentEditable) return el.innerText || "";
    return el.value || "";
  }

  // ─── Analysis ────────────────────────────────────────────────────────────────
  function scheduleCheck(el) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runCheck(el), DEBOUNCE_MS);
  }

  function runCheck(el) {
    if (!enabled) return;
    const text = getText(el);
    if (!text.trim()) {
      removeAllHighlights();
      return;
    }
    findings = [];
    for (const rule of RULES) {
      try {
        const ruleFindings = rule.check(text);
        findings.push(...ruleFindings);
      } catch (_) {}
    }
    // Deduplicate by position
    const seen = new Set();
    findings = findings.filter((f) => {
      const key = `${f.index}:${f.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Update stats
    for (const f of findings) {
      if (!sessionStats.seen.has(`${f.index}:${f.type}:${text.slice(f.index, f.index + f.length)}`)) {
        sessionStats[f.severity] = (sessionStats[f.severity] || 0) + 1;
        sessionStats.seen.add(`${f.index}:${f.type}:${text.slice(f.index, f.index + f.length)}`);
      }
    }
    // Broadcast stats to popup
    chrome.runtime.sendMessage({
      type: "stats",
      stats: {
        errors: sessionStats.errors,
        warnings: sessionStats.warnings,
        info: sessionStats.info,
        total: findings.length,
      },
    }).catch(() => {});

    renderHighlights(el, text, findings);
  }

  // ─── Highlight rendering ──────────────────────────────────────────────────────
  function removeAllHighlights() {
    if (highlightContainer) {
      highlightContainer.remove();
      highlightContainer = null;
    }
    closeTooltip();
  }

  function renderHighlights(el, text, allFindings) {
    removeAllHighlights();
    if (!allFindings.length) return;

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

    // SVG overlay
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    Object.assign(svg.style, {
      position: "fixed",
      top: rect.top + window.scrollY + "px",
      left: rect.left + window.scrollX + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      pointerEvents: "none",
      zIndex: "2147483640",
      overflow: "hidden",
    });
    svg.style.top = rect.top + "px";
    svg.style.left = rect.left + "px";
    svg.style.position = "fixed";

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
    const paddingLeft = parseFloat(style.paddingLeft);
    const paddingTop = parseFloat(style.paddingTop);

    for (const finding of allFindings) {
      const color = SEVERITY_COLORS[finding.severity] || "#6b7280";

      // Measure position using mirror
      mirror.textContent = text.slice(0, finding.index);
      const spanBefore = document.createElement("span");
      spanBefore.textContent = text.slice(finding.index, finding.index + finding.length);
      mirror.appendChild(spanBefore);

      const markerRect = spanBefore.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();

      const relTop = markerRect.top - mirrorRect.top + paddingTop - scrollTop;
      const relLeft = markerRect.left - mirrorRect.left + paddingLeft - scrollLeft;
      const w = markerRect.width;
      const lineH = markerRect.height;

      // Wavy underline via SVG
      const y = relTop + lineH - 2;
      if (y < 0 || y > rect.height || relLeft < 0) {
        mirror.textContent = "";
        continue;
      }

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", wavyPath(relLeft, y, w));
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      svg.appendChild(path);

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
    // For contenteditable, use a simpler approach: show a floating badge
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;

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

    tip.innerHTML = `
      <div class="gramr-tip-header" style="border-left-color:${severityColor}">
        <span class="gramr-tip-icon" style="color:${severityColor}">${severityIcon}</span>
        <span class="gramr-tip-label">${escHtml(finding.label)}</span>
        <button class="gramr-tip-close" aria-label="Close">×</button>
      </div>
      <div class="gramr-tip-body">
        <p class="gramr-tip-message">${escHtml(finding.message)}</p>
        <details class="gramr-tip-details" open>
          <summary>Why does this matter?</summary>
          <p>${escHtml(finding.explanation)}</p>
        </details>
        <details class="gramr-tip-details">
          <summary>Examples</summary>
          <pre class="gramr-tip-example">${escHtml(finding.example)}</pre>
        </details>
        <div class="gramr-tip-fix">
          <strong>How to fix:</strong> ${escHtml(finding.fix)}
        </div>
      </div>
    `;

    tip.querySelector(".gramr-tip-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTooltip();
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

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Inline RULES (copy from rules.js so we don't need a separate import) ────
  // We paste rules.js inline here so the content script is self-contained.

  function hasVerb(text) {
    return /\b(is|are|was|were|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must|be|been|being|\w+s|\w+ed|\w+ing)\b/i.test(text);
  }

  const RULES = [
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
    {
      id: "intro-clause-comma",
      check(text) {
        const findings = [];
        const introWords = [
          "however", "therefore", "furthermore", "moreover", "nevertheless",
          "consequently", "additionally", "meanwhile", "otherwise", "thus",
          "hence", "indeed", "instead", "similarly", "accordingly",
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
            type: "intro-clause-comma",
            severity: "warning",
            label: "Missing comma",
            message: `"${word}" at the start of a sentence usually needs a comma after it.`,
            explanation:
              'Conjunctive adverbs like "however," "therefore," and "furthermore" need a comma after them when they appear at the start of a sentence.',
            example: `❌  However I disagree.\n✅  However, I disagree.`,
            fix: `Add a comma after "${word}".`,
          });
        }
        return findings;
      },
    },
    {
      id: "its-its",
      check(text) {
        const findings = [];
        const reContraction = /\bit's\s+(?:own|name|size|color|colour|way|form|place|role|part|turn|job|purpose|effect)\b/gi;
        let m;
        while ((m = reContraction.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            type: "its-its",
            severity: "error",
            label: "its vs it's",
            message: `"it's" here should be "its" (possessive).`,
            explanation:
              '"it\'s" is a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form.',
            example:
              '❌  The dog wagged it\'s tail.\n✅  The dog wagged its tail.',
            fix: 'Replace "it\'s" with "its."',
          });
        }
        const reIts = /\bits\s+(?:a|an|the|not|been|going|time|easy|hard|true|false|clear|possible|impossible|okay|ok)\b/gi;
        while ((m = reIts.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 3,
            type: "its-its",
            severity: "error",
            label: "its vs it's",
            message: `"its" here looks like it should be "it's" (it is / it has).`,
            explanation:
              '"it\'s" is a contraction of "it is" or "it has." "its" (no apostrophe) is the possessive form.',
            example:
              '❌  Its going to rain.\n✅  It\'s going to rain.',
            fix: 'Replace "its" with "it\'s."',
          });
        }
        return findings;
      },
    },
    {
      id: "there-their-theyre",
      check(text) {
        const findings = [];
        const reTheirThere = /\b(is|are|was|were|over|out|down|up|back|right|left|away)\s+their\b/gi;
        let m;
        while ((m = reTheirThere.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 5,
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: `"their" may be wrong here — did you mean "there"?`,
            explanation:
              '"there" refers to a place or introduces a sentence. "their" shows possession. "they\'re" = they are.',
            example:
              '❌  Is their a problem?\n✅  Is there a problem?',
            fix: 'Use "there" to refer to a place.',
          });
        }
        const reTherePoss = /\bthere\s+(?:own|house|car|dog|cat|team|school|book|bag|job|idea|plan|group|family|friend|phone)\b/gi;
        while ((m = reTherePoss.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 5,
            type: "there-their-theyre",
            severity: "error",
            label: "their / there / they're",
            message: `"there" looks like it should be "their" (possessive).`,
            explanation:
              '"their" shows possession. "there" refers to a place.',
            example:
              '❌  I like there house.\n✅  I like their house.',
            fix: 'Replace "there" with "their."',
          });
        }
        return findings;
      },
    },
    {
      id: "your-youre",
      check(text) {
        const findings = [];
        const reYour = /\byour\s+(?:a|an|the|not|going|welcome|right|wrong|sure|ready|done|able|allowed|supposed|trying|kidding|joking|serious|crazy|awesome|amazing|great|terrible|correct|late|early|free|busy|tired|sick|excited|happy|sad|angry|nervous|lucky|smart|funny)\b/gi;
        let m;
        while ((m = reYour.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: `"your" here looks like it should be "you're" (you are).`,
            explanation:
              '"you\'re" = "you are." "your" is possessive.',
            example:
              '❌  Your going to love this.\n✅  You\'re going to love this.',
            fix: 'Replace "your" with "you\'re."',
          });
        }
        const reYoure = /\byou're\s+(?:friend|dog|cat|car|house|phone|bag|book|team|school|job|idea|plan|family|boss|teacher|mom|dad|brother|sister|name|email|number|address|account|password|choice|decision|problem|fault|responsibility|turn|time|money|life|story|opinion|point|question|answer)\b/gi;
        while ((m = reYoure.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 6,
            type: "your-youre",
            severity: "error",
            label: "your vs you're",
            message: `"you're" here looks like it should be "your" (possessive).`,
            explanation:
              '"your" shows possession. "you\'re" = you are.',
            example:
              "❌  I love you're dog.\n✅  I love your dog.",
            fix: 'Replace "you\'re" with "your."',
          });
        }
        return findings;
      },
    },
    {
      id: "double-negative",
      check(text) {
        const findings = [];
        const re = /\b(can't|cannot|couldn't|don't|doesn't|didn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't|never|no)\s+(?:\w+\s+){0,3}(nobody|no one|nothing|nowhere|neither|never|none|no)\b/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[0].length,
            type: "double-negative",
            severity: "warning",
            label: "Double negative",
            message: "Two negatives make a positive in standard English.",
            explanation:
              "In standard written English, two negative words cancel each other out, resulting in a positive meaning.",
            example:
              "❌  I don't know nothing. (= I know something)\n✅  I don't know anything.\n✅  I know nothing.",
            fix: "Replace one of the negatives with its positive equivalent.",
          });
        }
        return findings;
      },
    },
    {
      id: "affect-effect",
      check(text) {
        const findings = [];
        const reEffectVerb = /\b(effect(?:s|ed|ing)?)\s+(?:the|a|an|my|your|his|her|its|our|their|this|that)\b/gi;
        let m;
        while ((m = reEffectVerb.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: m[1].length,
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: `"${m[1]}" might be wrong here — did you mean "affect"?`,
            explanation:
              '"Affect" is almost always a verb. "Effect" is almost always a noun.',
            example:
              '❌  The rain effected our plans.\n✅  The rain affected our plans.\n✅  The rain had an effect on our plans.',
            fix: 'If you mean "to influence," use "affect." If you mean "the result," use "effect."',
          });
        }
        const reAffectNoun = /\bthe\s+affect\s+of\b/gi;
        while ((m = reAffectNoun.exec(text)) !== null) {
          findings.push({
            index: m.index + 4,
            length: 6,
            type: "affect-effect",
            severity: "warning",
            label: "affect vs effect",
            message: '"affect" here should probably be "effect" (noun).',
            explanation: '"Effect" is the noun form meaning result or outcome.',
            example:
              '❌  the affect of the medicine\n✅  the effect of the medicine',
            fix: 'Replace "affect" with "effect."',
          });
        }
        return findings;
      },
    },
    {
      id: "who-whom",
      check(text) {
        const findings = [];
        const reWhom = /\b(to|for|with|of|by|from|about|at|on|in|through|without|between|among|around)\s+who\b/gi;
        let m;
        while ((m = reWhom.exec(text)) !== null) {
          findings.push({
            index: m.index + m[1].length + 1,
            length: 3,
            type: "who-whom",
            severity: "warning",
            label: "who vs whom",
            message: `After "${m[1]}," use "whom" not "who."`,
            explanation:
              '"Who" is a subject pronoun (like "he"). "Whom" is an object pronoun (like "him"). After a preposition, always use "whom."',
            example:
              '❌  To who did you send it?\n✅  To whom did you send it?',
            fix: 'Replace "who" with "whom."',
          });
        }
        return findings;
      },
    },
    {
      id: "fewer-less",
      check(text) {
        const findings = [];
        const countableNouns = [
          "people", "items", "words", "sentences", "books", "cars", "dogs",
          "cats", "students", "employees", "errors", "mistakes", "problems",
          "issues", "pages", "steps", "points", "calories", "grams", "pounds",
          "miles", "hours", "minutes", "days", "weeks", "months", "years",
          "dollars", "votes", "seats", "rooms", "options", "choices",
          "questions", "answers", "letters", "numbers", "files", "games",
        ];
        const re = new RegExp(`\\bless\\s+(${countableNouns.join("|")})\\b`, "gi");
        let m;
        while ((m = re.exec(text)) !== null) {
          findings.push({
            index: m.index,
            length: 4,
            type: "fewer-less",
            severity: "warning",
            label: "fewer vs less",
            message: `Use "fewer" with countable nouns like "${m[1]}".`,
            explanation:
              '"Fewer" is for things you can count. "Less" is for uncountable amounts.',
            example: `❌  less ${m[1]}\n✅  fewer ${m[1]}`,
            fix: `Replace "less" with "fewer" before "${m[1]}."`,
          });
        }
        return findings;
      },
    },
    {
      id: "wordy",
      check(text) {
        const findings = [];
        const wordyPhrases = {
          "at this point in time": "now",
          "due to the fact that": "because",
          "in order to": "to",
          "in the event that": "if",
          "on account of": "because",
          "with the exception of": "except",
          "for the purpose of": "to",
          "in the near future": "soon",
          "at the present time": "now",
          "in close proximity to": "near",
          "a large number of": "many",
          "a small number of": "few",
          "make a decision": "decide",
          "come to a conclusion": "conclude",
          "take into consideration": "consider",
          "in my personal opinion": "in my opinion",
          "past history": "history",
          "end result": "result",
          "future plans": "plans",
          "added bonus": "bonus",
          "unexpected surprise": "surprise",
        };
        for (const [phrase, suggestion] of Object.entries(wordyPhrases)) {
          const re = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi");
          let m;
          while ((m = re.exec(text)) !== null) {
            const sug = suggestion ? `"${suggestion}"` : "(remove it)";
            findings.push({
              index: m.index,
              length: m[0].length,
              type: "wordy",
              severity: "info",
              label: "Wordy phrase",
              message: `"${m[0]}" is wordy.`,
              explanation:
                "Concise writing is stronger. Long filler phrases can be replaced with shorter equivalents.",
              example: `❌  "${phrase}"\n✅  ${sug}`,
              fix: `Replace "${phrase}" with ${sug}.`,
            });
          }
        }
        return findings;
      },
    },
    {
      id: "misspelling",
      check(text) {
        const findings = [];
        const misspellings = {
          "accomodate": "accommodate", "acheive": "achieve", "aquire": "acquire",
          "arguement": "argument", "beleive": "believe", "calender": "calendar",
          "catagory": "category", "cemetary": "cemetery", "commitee": "committee",
          "concious": "conscious", "consistant": "consistent",
          "definately": "definitely", "embarass": "embarrass",
          "enviroment": "environment", "existance": "existence",
          "familier": "familiar", "finaly": "finally", "foriegn": "foreign",
          "freind": "friend", "goverment": "government", "grammer": "grammar",
          "greatful": "grateful", "guarentee": "guarantee",
          "happend": "happened", "ignorence": "ignorance",
          "immediatly": "immediately", "independant": "independent",
          "knowlege": "knowledge", "liason": "liaison", "lisence": "license",
          "maintanance": "maintenance", "medeval": "medieval",
          "millenium": "millennium", "mischievious": "mischievous",
          "neccessary": "necessary", "noticable": "noticeable",
          "occurance": "occurrence", "occured": "occurred", "ommit": "omit",
          "orignal": "original", "paralel": "parallel", "passtime": "pastime",
          "peice": "piece", "percieve": "perceive", "persistant": "persistent",
          "posession": "possession", "prefered": "preferred",
          "privelege": "privilege", "probly": "probably",
          "pronounciation": "pronunciation", "questionaire": "questionnaire",
          "recieve": "receive", "recomend": "recommend", "relavant": "relevant",
          "relevent": "relevant", "religous": "religious",
          "repitition": "repetition", "resistence": "resistance",
          "restaraunt": "restaurant", "rythm": "rhythm", "seperate": "separate",
          "similer": "similar", "successfull": "successful",
          "supercede": "supersede", "suprise": "surprise",
          "temperture": "temperature", "tendancy": "tendency",
          "tommorrow": "tomorrow", "tounge": "tongue",
          "transfered": "transferred", "truely": "truly", "untill": "until",
          "vaccuum": "vacuum", "wierd": "weird", "writting": "writing",
          "alot": "a lot", "amature": "amateur", "apparant": "apparent",
          "basicly": "basically", "buisness": "business",
          "collegue": "colleague", "comming": "coming",
          "completly": "completely", "curiousity": "curiosity",
          "developement": "development", "differnce": "difference",
          "dilema": "dilemma", "disapoint": "disappoint",
          "disasterous": "disastrous", "discription": "description",
          "dissapear": "disappear", "electorial": "electoral",
          "eligable": "eligible", "embarrasment": "embarrassment",
          "entrepeneur": "entrepreneur", "enviromental": "environmental",
          "explaination": "explanation", "facinating": "fascinating",
          "flourescent": "fluorescent", "fullfill": "fulfill",
          "glamourous": "glamorous", "heirarchy": "hierarchy",
          "humerous": "humorous", "hygeine": "hygiene",
          "hypocracy": "hypocrisy", "incidently": "incidentally",
          "indispensible": "indispensable", "interupt": "interrupt",
          "irrelevent": "irrelevant", "jewlery": "jewelry",
          "labratory": "laboratory", "lenght": "length",
          "lightening": "lightning", "manuever": "maneuver",
          "miniscule": "minuscule", "mispell": "misspell",
          "momento": "memento", "naieve": "naive", "naturaly": "naturally",
          "nowledge": "knowledge", "occassion": "occasion",
          "oportunity": "opportunity", "outragous": "outrageous",
          "pamflet": "pamphlet", "parallell": "parallel",
          "particuarly": "particularly", "peculier": "peculiar",
          "permanant": "permanent", "perseverence": "perseverance",
          "phenominon": "phenomenon", "plagarism": "plagiarism",
          "plausable": "plausible", "preceed": "precede",
          "presense": "presence", "prevailent": "prevalent",
          "principel": "principle", "priviledge": "privilege",
          "procede": "proceed", "profesional": "professional",
          "prominant": "prominent", "propoganda": "propaganda",
          "pursuade": "persuade", "quanity": "quantity",
          "quarentine": "quarantine", "recognise": "recognize",
          "recomendation": "recommendation", "rehersal": "rehearsal",
          "releive": "relieve", "reluctent": "reluctant",
          "rescent": "recent", "resturant": "restaurant",
          "rediculous": "ridiculous", "roomate": "roommate",
          "schedual": "schedule", "secratary": "secretary",
          "sensable": "sensible", "sophmore": "sophomore",
          "speach": "speech", "succede": "succeed", "suficient": "sufficient",
          "superscede": "supersede", "symetry": "symmetry", "tatoo": "tattoo",
          "technolgy": "technology", "therefor": "therefore",
          "treshhold": "threshold", "tommorow": "tomorrow",
          "totaly": "totally", "tounament": "tournament",
          "tradgedy": "tragedy", "trully": "truly", "tyrany": "tyranny",
          "tyranical": "tyrannical", "unnecessery": "unnecessary",
          "usefull": "useful", "usualy": "usually",
          "valueable": "valuable", "vegatable": "vegetable",
          "visability": "visibility", "volunter": "volunteer",
          "vunerable": "vulnerable", "wether": "whether",
          "wich": "which", "yeild": "yield",
        };
        const misspellingRe = new RegExp(
          `\\b(${Object.keys(misspellings).join("|")})\\b`,
          "gi"
        );
        let m;
        while ((m = misspellingRe.exec(text)) !== null) {
          const wrong = m[1].toLowerCase();
          const correct = misspellings[wrong];
          if (!correct) continue;
          findings.push({
            index: m.index,
            length: m[1].length,
            type: "misspelling",
            severity: "error",
            label: "Misspelling",
            message: `"${m[1]}" is misspelled.`,
            explanation: `"${m[1]}" is a common misspelling. The correct spelling is "${correct}."`,
            example: `❌  ${m[1]}\n✅  ${correct}`,
            fix: `Change "${m[1]}" to "${correct}."`,
          });
        }
        return findings;
      },
    },
  ];
})();
