// Gramr popup script

const RULES_META = [
  // Errors
  { id: "misspelling",            label: "Spelling (50,000-word dictionary)", severity: "error" },
  { id: "past-participle",        label: "Past participles (have went → gone)", severity: "error" },
  { id: "double-comparative",     label: "Double comparatives (more better)", severity: "error" },
  { id: "whose-whos",             label: "whose vs who's",              severity: "error" },
  { id: "eggcorn",                label: "Misheard idioms (for all intensive purposes)", severity: "error" },
  { id: "its-its",                label: "its vs it's",                 severity: "error" },
  { id: "there-their-theyre",     label: "their / there / they're",     severity: "error" },
  { id: "your-youre",             label: "your vs you're",              severity: "error" },
  { id: "modal-of",               label: "could/would/should of → have",severity: "error" },
  { id: "then-than",              label: "then vs than",                severity: "error" },
  { id: "to-too",                 label: "to vs too",                   severity: "error" },
  { id: "a-an",                   label: "a vs an",                     severity: "error" },
  // Warnings
  { id: "comma-splice",           label: "Comma splices",               severity: "warning" },
  { id: "intro-clause-comma",     label: "Missing intro-clause comma",  severity: "warning" },
  { id: "affect-effect",          label: "affect vs effect",            severity: "warning" },
  { id: "who-whom",               label: "who vs whom",                 severity: "warning" },
  { id: "fewer-less",             label: "fewer vs less",               severity: "warning" },
  { id: "loose-lose",             label: "loose vs lose",               severity: "warning" },
  { id: "accept-except",          label: "accept vs except",            severity: "warning" },
  { id: "good-well",              label: "good vs well",                severity: "warning" },
  { id: "pronoun-case",           label: "Pronoun case (between you and me)", severity: "warning" },
  { id: "complement-compliment",  label: "complement vs compliment",    severity: "warning" },
  { id: "principal-principle",    label: "principal vs principle",      severity: "warning" },
  { id: "further-farther",        label: "further vs farther",          severity: "warning" },
  { id: "imply-infer",            label: "imply vs infer",              severity: "warning" },
  { id: "lay-lie",                label: "lay vs lie",                  severity: "warning" },
  { id: "double-negative",        label: "Double negatives",            severity: "warning" },
  { id: "subject-verb",           label: "Subject–verb agreement",      severity: "warning" },
  { id: "passive-voice",          label: "Passive voice",               severity: "warning" },
  { id: "tense-shift",            label: "Tense consistency",           severity: "warning" },
  { id: "repeated-word",          label: "Repeated words (the the)",    severity: "warning" },
  { id: "me-subject",             label: '"Me and…" as subject',        severity: "warning" },
  { id: "could-care-less",        label: "could care less",             severity: "warning" },
  { id: "amount-number",          label: "amount vs number",            severity: "warning" },
  { id: "between-and",            label: "between … and",               severity: "warning" },
  { id: "missing-question-mark",  label: "Questions ending in periods", severity: "warning" },
  { id: "question-phrasing",      label: "Question phrasing (whose name is yours)", severity: "warning" },
  { id: "unidiomatic",            label: "Unidiomatic phrasing (am agree, open the light)", severity: "warning" },
  // Info
  { id: "oxford-comma",           label: "Oxford comma",                severity: "info" },
  { id: "wordy",                  label: "Wordy phrases (50+)",         severity: "info" },
  { id: "redundant-acronym",      label: "Redundant acronyms (ATM machine etc.)", severity: "info" },
  { id: "dialect-spelling",       label: "Regional spelling (US/UK/AU/CA)", severity: "info" },
  { id: "try-and",                label: '"try and" vs "try to"',       severity: "info" },
  { id: "redundant-pair",         label: "Redundant pairs (return back, discuss about)", severity: "info" },
];

// ── Learning model (mirrors content.js) ─────────────────────────────────────
const SLIP_RULES = new Set(["misspelling", "repeated-word"]);
const HABIT_RULES = new Set([
  "wordy", "passive-voice", "oxford-comma", "try-and",
  "dialect-spelling", "redundant-acronym", "redundant-pair",
]);
function ruleKind(type) {
  if (SLIP_RULES.has(type)) return "slip";
  if (HABIT_RULES.has(type)) return "habit";
  return "gap";
}

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

const BAND_RANK = { learning: 0, improving: 1, mastered: 2 };
const BAND_EMOJI = { learning: "🌱", improving: "📈", mastered: "⭐" };

// ── Levels ──────────────────────────────────────────────────────────────────
const LEVELS = [
  { xp: 0,    title: "Novice" },
  { xp: 50,   title: "Apprentice" },
  { xp: 150,  title: "Scribe" },
  { xp: 300,  title: "Wordsmith" },
  { xp: 500,  title: "Stylist" },
  { xp: 800,  title: "Editor" },
  { xp: 1200, title: "Grammarian" },
  { xp: 1700, title: "Rhetorician" },
  { xp: 2300, title: "Virtuoso" },
  { xp: 3000, title: "Word Master" },
];
function levelFor(xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++;
  let next = i + 1 < LEVELS.length ? LEVELS[i + 1].xp : LEVELS[i].xp + 800 * (Math.floor((xp - LEVELS[i].xp) / 800) + 1);
  let n = i + 1;
  let title = LEVELS[i].title;
  if (i === LEVELS.length - 1) {
    const extra = Math.floor((xp - LEVELS[i].xp) / 800);
    n += extra;
    const cur = LEVELS[i].xp + extra * 800;
    return { n, title, cur, next: cur + 800 };
  }
  return { n, title, cur: LEVELS[i].xp, next };
}

// ── Focus-of-the-week lessons (knowledge-gap rules) ─────────────────────────
const LESSONS = {
  "its-its":            { lesson: "“Its” shows possession; “it's” is only ever short for “it is” or “it has.”", trick: "Quick test: expand it. If “it is” fits, write it's. If not, its." },
  "there-their-theyre": { lesson: "“There” is a place, “their” shows ownership, “they're” means “they are.”", trick: "Quick test: substitute “they are.” If it fits, use they're. If ownership, their. Otherwise there." },
  "your-youre":         { lesson: "“Your” shows ownership; “you're” is short for “you are.”", trick: "Quick test: read it as “you are.” Works? → you're. Doesn't? → your." },
  "modal-of":           { lesson: "“Could of” isn't English — it's a mishearing of “could've” (could have).", trick: "After could/would/should, always write have, never of." },
  "then-than":          { lesson: "“Than” compares things; “then” orders them in time.", trick: "Comparison? → than. Time or sequence? → then." },
  "to-too":             { lesson: "“Too” means “also” or “excessively”; “to” is the preposition and infinitive marker.", trick: "If you can say “also” or “very,” you need the extra o: too." },
  "a-an":               { lesson: "A/an follows the SOUND of the next word, not its first letter: an hour, a university, an MBA.", trick: "Say the word aloud. Vowel sound → an. Consonant sound → a." },
  "comma-splice":       { lesson: "Two complete sentences can't be joined by just a comma.", trick: "Fix three ways: a period, a semicolon, or a comma + and/but/so." },
  "intro-clause-comma": { lesson: "An introductory phrase gets a comma before the main sentence starts.", trick: "If the sentence starts with However/Although/After…, put a comma when the intro part ends." },
  "affect-effect":      { lesson: "“Affect” is almost always the verb; “effect” is almost always the noun.", trick: "RAVEN: Remember, Affect = Verb, Effect = Noun." },
  "who-whom":           { lesson: "“Who” does the action; “whom” receives it — especially after prepositions (to whom).", trick: "Answer with him/he: him → whom, he → who." },
  "fewer-less":         { lesson: "Countable things take “fewer” (fewer errors); uncountable quantities take “less” (less time).", trick: "Can you count them one by one? → fewer." },
  "loose-lose":         { lesson: "“Lose” (one o) is the verb — to misplace or be defeated. “Loose” rhymes with goose and means not tight.", trick: "Losing something makes the word itself lose an o." },
  "accept-except":      { lesson: "“Accept” means to receive or agree; “except” means excluding.", trick: "EXcept EXcludes." },
  "good-well":          { lesson: "“Good” describes things; “well” describes how you do something (or your health).", trick: "After “doing,” use well: I'm doing well." },
  "pronoun-case":       { lesson: "After prepositions like “between,” use object pronouns: between you and me.", trick: "Drop the other person: “for me” not “for I” → “for you and me.”" },
  "complement-compliment": { lesson: "A compliment is praise; a complement completes something.", trick: "ComplEment complEtes. ComplIment = I like it." },
  "principal-principle": { lesson: "A principle is a rule or belief; principal means main (or the school head).", trick: "Your princiPAL is your pal; a princiPLE is a rule." },
  "further-farther":    { lesson: "“Farther” is physical distance; “further” is figurative progress.", trick: "FARther = how FAR. Everything else → further." },
  "imply-infer":        { lesson: "Speakers imply (hint); listeners infer (conclude).", trick: "The sender implies; the receiver infers." },
  "lay-lie":            { lesson: "“Lay” needs an object (lay the book down); “lie” doesn't (go lie down).", trick: "Lay = place something. Lie = recline yourself." },
  "double-negative":    { lesson: "Two negatives cancel out: “don't know nothing” literally means you know something.", trick: "One negative per thought: “don't know anything.”" },
  "subject-verb":       { lesson: "The verb agrees with the true subject, even when other words come between them.", trick: "Find the real subject, ignore the phrase after “of”: “The box of tools IS heavy.”" },
  "tense-shift":        { lesson: "Time words set the tense: “yesterday” needs past-tense verbs, “tomorrow” needs future.", trick: "Match every verb to the time word that opened the sentence." },
  "past-participle":    { lesson: "Perfect tenses (have/has/had) need the participle: have gone, not have went.", trick: "“Have went” never happens — if “have” is there, use the third form: go/went/GONE." },
  "double-comparative": { lesson: "Use -er OR “more,” never both: better, not more better.", trick: "If the word already ends in -er/-est, delete the more/most." },
  "whose-whos":         { lesson: "“Who's” = who is. “Whose” = belonging to whom.", trick: "Expand it: if “who is” fits, use who's." },
  "could-care-less":    { lesson: "The idiom is “couldn't care less” — caring is at zero and can't drop lower.", trick: "If you COULD care less, you still care. Keep the n't." },
  "amount-number":      { lesson: "Countable things take “number” (a number of people); uncountable take “amount” (an amount of water).", trick: "Same test as fewer/less: countable → number." },
  "between-and":        { lesson: "“Between” always pairs with “and”: between 5 and 10.", trick: "“To” belongs to “from”: from 5 to 10." },
  "me-subject":         { lesson: "The doer of the action is “I,” not “me” — and the other person goes first: “Sarah and I went.”", trick: "Drop the other person: “Me went” fails, “I went” works." },
  "missing-question-mark": { lesson: "Direct questions — sentences starting with who/what/where/how + a verb — end with a question mark, not a period.", trick: "If you could answer the sentence out loud, it needs a “?”." },
  "question-phrasing":  { lesson: "Ask for a thing with “what”: “What is your name?” — “whose” asks who owns something, and “how” asks in what way.", trick: "Want the thing itself? → what. Want the owner? → whose. Want the method? → how." },
  "eggcorn":            { lesson: "Idioms are fixed phrases; misheard versions (“for all intensive purposes”) look wrong to readers who know the original (“for all intents and purposes”).", trick: "If an idiom's words seem oddly literal, look up the original phrase." },
  "unidiomatic":        { lesson: "English pairs certain verbs with certain nouns: you take photos, turn on lights, and “agree” without “am” — even when your other language does it differently.", trick: "Collocations are habits, not logic — learn the pair, not the rule." },
};

// ── Practice questions (spaced repetition, one per rule) ────────────────────
// choices[0] is always the correct answer; order is shuffled at render time.
const QUIZ = {
  "its-its":            { q: "The dog wagged ___ tail.", choices: ["its", "it's"] },
  "there-their-theyre": { q: "___ going to love this.", choices: ["They're", "Their", "There"] },
  "your-youre":         { q: "___ the best!", choices: ["You're", "Your"] },
  "modal-of":           { q: "You should ___ seen it.", choices: ["have", "of"] },
  "then-than":          { q: "She's taller ___ me.", choices: ["than", "then"] },
  "to-too":             { q: "It's ___ late to call now.", choices: ["too", "to"] },
  "a-an":               { q: "She earned ___ MBA last year.", choices: ["an", "a"] },
  "comma-splice":       { q: "Which is correct?", choices: ["I ran home. It rained.", "I ran home, it rained."] },
  "intro-clause-comma": { q: "Which is correct?", choices: ["However, the test failed.", "However the test failed."] },
  "affect-effect":      { q: "The rain didn't ___ my mood.", choices: ["affect", "effect"] },
  "who-whom":           { q: "To ___ should I address this?", choices: ["whom", "who"] },
  "fewer-less":         { q: "We had ___ errors this week.", choices: ["fewer", "less"] },
  "loose-lose":         { q: "Don't ___ your keys.", choices: ["lose", "loose"] },
  "accept-except":      { q: "Everyone came ___ Dan.", choices: ["except", "accept"] },
  "good-well":          { q: "“How are you?” “I'm doing ___.”", choices: ["well", "good"] },
  "pronoun-case":       { q: "Between you and ___, it's a secret.", choices: ["me", "I"] },
  "complement-compliment": { q: "The wine ___s the fish nicely.", choices: ["complement", "compliment"] },
  "principal-principle": { q: "It's a matter of ___.", choices: ["principle", "principal"] },
  "further-farther":    { q: "We drove ___ down the road.", choices: ["farther", "further"] },
  "imply-infer":        { q: "From her tone, I ___red she was upset.", choices: ["infer", "imply"] },
  "lay-lie":            { q: "I'm dizzy — I need to ___ down.", choices: ["lie", "lay"] },
  "double-negative":    { q: "Correct: “I don't know ___ about it.”", choices: ["anything", "nothing"] },
  "subject-verb":       { q: "The box of tools ___ heavy.", choices: ["is", "are"] },
  "tense-shift":        { q: "Yesterday she ___ to work.", choices: ["walked", "walks"] },
  "past-participle":    { q: "I have ___ there before.", choices: ["gone", "went"] },
  "double-comparative": { q: "This design is ___.", choices: ["better", "more better"] },
  "whose-whos":         { q: "___ coat is this?", choices: ["Whose", "Who's"] },
  "could-care-less":    { q: "The idiom: “I ___ care less.”", choices: ["couldn't", "could"] },
  "amount-number":      { q: "A large ___ of people came.", choices: ["number", "amount"] },
  "between-and":        { q: "Pick a number between 1 ___ 10.", choices: ["and", "to"] },
  "me-subject":         { q: "___ went to the park.", choices: ["Sarah and I", "Me and Sarah"] },
  "missing-question-mark": { q: "Which is correct?", choices: ["What is your name?", "What is your name."] },
  "question-phrasing":  { q: "You want to know someone's name. You ask:", choices: ["What is your name?", "Whose name is yours?"] },
  "eggcorn":            { q: "The idiom is “for all ___ purposes.”", choices: ["intents and", "intensive"] },
  "unidiomatic":        { q: "Which is natural English?", choices: ["I agree with you.", "I am agree with you."] },
};

// Leitner boxes: review after 1 / 3 / 7 / 21 days
const QUIZ_INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 21 };

const toggle = document.getElementById("enableToggle");
const app = document.querySelector(".app");
const errCount = document.getElementById("errCount");
const warnCount = document.getElementById("warnCount");
const infoCount = document.getElementById("infoCount");
const statusText = document.getElementById("statusText");
const ruleList = document.getElementById("ruleList");
const dialectSelect = document.getElementById("dialectSelect");
const historySection = document.getElementById("historySection");
const historyList = document.getElementById("historyList");
const historyApplied = document.getElementById("historyApplied");
const clearHistoryBtn = document.getElementById("clearHistory");

// Render rule list (click a rule to enable/disable it)
let disabledRules = new Set();
chrome.storage.sync.get({ disabledRules: [] }, (res) => {
  disabledRules = new Set(res.disabledRules);
  renderRuleList();
});

function renderRuleList() {
  ruleList.innerHTML = "";
  for (const rule of RULES_META) {
    const li = document.createElement("li");
    const off = disabledRules.has(rule.id);
    li.className = "rule-item rule-item--toggle" + (off ? " rule-item--off" : "");
    li.title = off ? "Click to enable this check" : "Click to disable this check";
    li.innerHTML = `<span class="rule-dot rule-dot--${rule.severity}"></span><span class="rule-name">${escHtml(rule.label)}</span><span class="rule-state">${off ? "off" : "on"}</span>`;
    li.addEventListener("click", () => {
      if (disabledRules.has(rule.id)) disabledRules.delete(rule.id);
      else disabledRules.add(rule.id);
      chrome.storage.sync.set({ disabledRules: [...disabledRules] });
      renderRuleList();
    });
    ruleList.appendChild(li);
  }
}

// Per-site disable toggle
const siteRow = document.getElementById("siteRow");
const siteHost = document.getElementById("siteHost");
const siteToggle = document.getElementById("siteToggle");
let currentHost = null;

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  try {
    const url = new URL(tabs[0]?.url || "");
    if (!["http:", "https:"].includes(url.protocol)) return;
    currentHost = url.hostname;
    siteHost.textContent = currentHost;
    siteRow.hidden = false;
    chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
      siteToggle.checked = disabledSites.includes(currentHost);
    });
  } catch (_) {}
});

siteToggle.addEventListener("change", () => {
  if (!currentHost) return;
  chrome.storage.sync.get({ disabledSites: [] }, ({ disabledSites }) => {
    const set = new Set(disabledSites);
    if (siteToggle.checked) set.add(currentHost);
    else set.delete(currentHost);
    chrome.storage.sync.set({ disabledSites: [...set] });
  });
});

// Load saved state
chrome.storage.sync.get({ enabled: true, dialect: "us" }, ({ enabled, dialect }) => {
  toggle.checked = enabled;
  applyEnabledState(enabled);
  dialectSelect.value = dialect;
});

dialectSelect.addEventListener("change", () => {
  chrome.storage.sync.set({ dialect: dialectSelect.value });
});

// ── Optional-feature preferences ────────────────────────────────────────────
const PREF_DEFAULTS = { gamification: true, badges: true, focus: true, history: true, adaptive: true, quiz: true, proveIt: false };
let prefs = { ...PREF_DEFAULTS };
const prefInputs = {
  gamification: document.getElementById("optGamification"),
  badges: document.getElementById("optBadges"),
  focus: document.getElementById("optFocus"),
  history: document.getElementById("optHistory"),
  adaptive: document.getElementById("optAdaptive"),
  quiz: document.getElementById("optQuiz"),
  proveIt: document.getElementById("optProveIt"),
};

chrome.storage.sync.get({ prefs: PREF_DEFAULTS }, (res) => {
  prefs = { ...PREF_DEFAULTS, ...res.prefs };
  for (const [key, input] of Object.entries(prefInputs)) {
    input.checked = prefs[key];
    input.addEventListener("change", () => {
      prefs[key] = input.checked;
      chrome.storage.sync.set({ prefs });
      applyPrefVisibility();
      if (input.checked && (key === "history" || key === "focus" || key === "gamification" || key === "badges" || key === "quiz")) {
        loadProgress(); // re-render sections that were hidden
      }
    });
  }
  applyPrefVisibility();
  loadProgress();
});

function applyPrefVisibility() {
  document.getElementById("progressSection").hidden = !prefs.gamification;
  if (!prefs.focus) document.getElementById("focusCard").hidden = true;
  if (!prefs.history) historySection.hidden = true;
  if (!prefs.quiz) document.getElementById("quizCard").hidden = true;
}
clearHistoryBtn.addEventListener("click", () => {
  chrome.storage.local.set({ history: {}, correctionsApplied: 0, bands: {}, focus: null, quiz: {} });
  historySection.hidden = true;
  document.getElementById("focusCard").hidden = true;
  document.getElementById("quizCard").hidden = true;
});

function loadProgress() {
  chrome.storage.local.get(
    { history: {}, correctionsApplied: 0, xp: 0, streak: { current: 0, best: 0, lastDay: null }, bands: {}, focus: null, quiz: {} },
    (data) => {
      const { history, correctionsApplied, streak, bands, quiz } = data;
      let { xp, focus } = data;
      const now = Date.now();
      const week = Math.floor(now / 604800000);

      // ── Band promotions: award XP when a rule you struggled with levels up ──
      const bandByRule = {};
      let promoted = [];
      for (const [type, h] of Object.entries(history)) {
        if (ruleKind(type) === "slip" || !h.count) continue;
        const band = bandFor(computeMastery(h, now));
        bandByRule[type] = band;
        const best = bands[type] ?? 0;
        const rank = BAND_RANK[band];
        if (rank > best) {
          if (prefs.gamification) {
            if (best < 1 && rank >= 1) xp += 10;
            if (best < 2 && rank >= 2) xp += 25;
          }
          bands[type] = rank;
          if (rank === 2) promoted.push(h.label || type);
        }
      }

      // ── Streak (grace: yesterday's streak still shows as alive today) ──
      if (prefs.gamification) {
      const dayMs = 86400000;
      const today = new Date();
      const localDay = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const streakAlive = streak.lastDay === localDay(today) ||
                          streak.lastDay === localDay(new Date(now - dayMs));
      const streakDaysEl = document.getElementById("streakDays");
      const streakBadge = document.getElementById("streakBadge");
      if (streakAlive && streak.current > 0) {
        streakBadge.hidden = false;
        streakDaysEl.textContent = streak.current;
      }

      // ── Level + XP bar ──
      const lv = levelFor(xp);
      document.getElementById("levelTitle").textContent = `Lv ${lv.n} · ${lv.title}`;
      document.getElementById("xpText").textContent = `${xp} XP`;
      const pct = Math.min(100, Math.round(((xp - lv.cur) / (lv.next - lv.cur)) * 100));
      document.getElementById("xpBarFill").style.width = pct + "%";
      document.getElementById("xpNext").textContent =
        (promoted.length ? `⭐ Mastered: ${promoted.join(", ")} · ` : "") +
        `${lv.next - xp} XP to level ${lv.n + 1}`;
      } // end gamification

      // ── Focus of the week: worst recent knowledge-gap rule ──
      if (prefs.focus) {
      if (!focus || focus.week !== week) {
        let bestType = null, bestWeight = 0;
        for (const [type, h] of Object.entries(history)) {
          if (ruleKind(type) !== "gap" || !LESSONS[type]) continue;
          const weight = 2 * ((h.weeks && h.weeks[week]) || 0) + ((h.weeks && h.weeks[week - 1]) || 0);
          if (weight > bestWeight) { bestWeight = weight; bestType = type; }
        }
        focus = bestWeight >= 2 ? { week, ruleId: bestType } : { week, ruleId: null };
      }
      if (focus.ruleId && LESSONS[focus.ruleId]) {
        const card = document.getElementById("focusCard");
        card.hidden = false;
        document.getElementById("focusRule").textContent =
          history[focus.ruleId]?.label || focus.ruleId;
        const fex = history[focus.ruleId]?.examples?.[0];
        const fexEl = document.getElementById("focusExample");
        if (fex) {
          fexEl.hidden = false;
          fexEl.textContent = `You wrote: “${fex}”`;
        }
        document.getElementById("focusLesson").textContent = LESSONS[focus.ruleId].lesson;
        document.getElementById("focusTrick").textContent = "💡 " + LESSONS[focus.ruleId].trick;
      }
      } // end focus

      // ── Practice question: rules you've erred on enter the review pool a
      // day later; right answers push the next review further out ──
      if (prefs.quiz && !quizAnsweredThisOpen) {
        for (const [type, h] of Object.entries(history)) {
          if (ruleKind(type) !== "gap" || !QUIZ[type] || quiz[type] || !h.count) continue;
          quiz[type] = { box: 1, next: now + 86400000, right: 0, wrong: 0 };
        }
        const due = Object.entries(quiz)
          .filter(([t, s]) => s.next <= now && QUIZ[t])
          .sort((a, b) => a[1].next - b[1].next);
        if (due.length) renderQuizCard(due[0][0], quiz, history);
      }

      chrome.storage.local.set({ xp, bands, focus, quiz });

      // ── Top mistakes list with mastery badges and weekly trends ──
      if (!prefs.history) return;
      const entries = Object.entries(history).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
      if (!entries.length && !correctionsApplied) {
        historySection.hidden = true;
        return;
      }
      historySection.hidden = false;
      historyList.innerHTML = "";
      let totalThis = 0, totalLast = 0;
      for (const h of Object.values(history)) {
        totalThis += h.weeks?.[week] || 0;
        totalLast += h.weeks?.[week - 1] || 0;
      }
      for (const [type, h] of entries) {
        const thisWk = h.weeks?.[week] || 0;
        const lastWk = h.weeks?.[week - 1] || 0;
        let trend = "";
        if (lastWk > 0 && thisWk < lastWk) trend = `<span class="history-trend history-trend--down">▼</span>`;
        else if (lastWk > 0 && thisWk > lastWk) trend = `<span class="history-trend history-trend--up">▲</span>`;
        const badge = prefs.badges && bandByRule[type]
          ? `<span class="history-band" title="${bandByRule[type]}">${BAND_EMOJI[bandByRule[type]]}</span>`
          : "";
        const li = document.createElement("li");
        li.className = "history-item";
        li.innerHTML =
          `<span class="rule-dot rule-dot--${escHtml(h.severity || "info")}"></span>` +
          `<span class="history-label">${escHtml(h.label || type)}</span>` +
          badge + trend +
          `<span class="history-count">×${h.count}</span>`;
        historyList.appendChild(li);
      }
      const parts = [];
      if (correctionsApplied) {
        parts.push(`✓ ${correctionsApplied} correction${correctionsApplied !== 1 ? "s" : ""} applied`);
      }
      if (totalLast > 0 && totalThis !== totalLast) {
        const pct2 = Math.round(Math.abs(totalThis - totalLast) / totalLast * 100);
        parts.push(totalThis < totalLast
          ? `mistakes down ${pct2}% vs last week 🎉`
          : `mistakes up ${pct2}% vs last week`);
      }
      historyApplied.textContent = parts.join(" · ");
    }
  );
}

// Load latest stats (stored by background.js)
const statsStorage = chrome.storage.session ?? chrome.storage.local;
statsStorage.get("latestStats", ({ latestStats }) => {
  if (latestStats) updateStats(latestStats);
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.sync.set({ enabled });
  applyEnabledState(enabled);
});

// Listen for live stats from the active tab
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stats") updateStats(msg.stats);
});

// ── Quiz card ───────────────────────────────────────────────────────────────
let quizAnsweredThisOpen = false;

function renderQuizCard(type, quizState, history) {
  const def = QUIZ[type];
  document.getElementById("quizCard").hidden = false;
  const ctx = document.getElementById("quizContext");
  const example = history?.[type]?.examples?.[0];
  if (example) {
    ctx.hidden = false;
    ctx.textContent = `From your writing: “${example}”`;
  } else {
    ctx.hidden = true;
  }
  document.getElementById("quizQ").textContent = def.q;
  document.getElementById("quizResult").hidden = true;
  const box = document.getElementById("quizChoices");
  box.innerHTML = "";
  const correct = def.choices[0];
  const shuffled = [...def.choices].sort(() => Math.random() - 0.5);
  for (const choice of shuffled) {
    const b = document.createElement("button");
    b.className = "quiz-choice";
    b.textContent = choice;
    b.addEventListener("click", () => answerQuiz(type, choice === correct, quizState, b, correct));
    box.appendChild(b);
  }
}

function answerQuiz(type, correct, quizState, btn, correctText) {
  if (quizAnsweredThisOpen) return;
  quizAnsweredThisOpen = true;
  const s = quizState[type];
  for (const b of document.querySelectorAll(".quiz-choice")) {
    b.disabled = true;
    if (!correct && b.textContent === correctText) b.classList.add("quiz-choice--right");
  }
  btn.classList.add(correct ? "quiz-choice--right" : "quiz-choice--wrong");
  if (correct) {
    s.box = Math.min(4, (s.box || 1) + 1);
    s.right = (s.right || 0) + 1;
  } else {
    s.box = 1;
    s.wrong = (s.wrong || 0) + 1;
  }
  s.next = Date.now() + QUIZ_INTERVALS[s.box] * 86400000;

  const result = document.getElementById("quizResult");
  result.hidden = false;
  if (correct) {
    result.textContent = prefs.gamification ? "✓ Correct! +8 XP" : "✓ Correct!";
    result.className = "quiz-result quiz-result--right";
  } else {
    const trick = LESSONS[type] ? LESSONS[type].trick : "";
    result.textContent = "✗ Not quite. 💡 " + trick;
    result.className = "quiz-result quiz-result--wrong";
  }

  chrome.storage.local.get({ quiz: {}, xp: 0 }, (res) => {
    res.quiz[type] = s;
    const update = { quiz: res.quiz };
    if (correct && prefs.gamification) {
      update.xp = res.xp + 8;
      updateXpDisplay(update.xp);
    }
    chrome.storage.local.set(update);
  });
}

function updateXpDisplay(xp) {
  const lv = levelFor(xp);
  document.getElementById("levelTitle").textContent = `Lv ${lv.n} · ${lv.title}`;
  document.getElementById("xpText").textContent = `${xp} XP`;
  const pct = Math.min(100, Math.round(((xp - lv.cur) / (lv.next - lv.cur)) * 100));
  document.getElementById("xpBarFill").style.width = pct + "%";
  document.getElementById("xpNext").textContent = `${lv.next - xp} XP to level ${lv.n + 1}`;
}

function applyEnabledState(enabled) {
  if (enabled) {
    app.classList.remove("disabled");
  } else {
    app.classList.add("disabled");
    statusText.textContent = "Gramr is paused. Toggle the switch to resume.";
  }
}

function updateStats(stats) {
  errCount.textContent = stats.errors ?? 0;
  warnCount.textContent = stats.warnings ?? 0;
  infoCount.textContent = stats.info ?? 0;

  document.getElementById("statErrors").classList.toggle("has-items", (stats.errors ?? 0) > 0);
  document.getElementById("statWarnings").classList.toggle("has-items", (stats.warnings ?? 0) > 0);
  document.getElementById("statInfo").classList.toggle("has-items", (stats.info ?? 0) > 0);

  const total = stats.total ?? 0;
  if (total === 0) {
    statusText.textContent = "No issues found — great writing!";
  } else {
    statusText.textContent = `${total} suggestion${total !== 1 ? "s" : ""} found. Click the underlines to learn more.`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
