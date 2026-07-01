// Gramr popup script

const RULES_META = [
  // Errors
  { id: "misspelling",            label: "Misspellings (500+)",         severity: "error" },
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
  // Info
  { id: "oxford-comma",           label: "Oxford comma",                severity: "info" },
  { id: "wordy",                  label: "Wordy phrases (50+)",         severity: "info" },
  { id: "redundant-acronym",      label: "Redundant acronyms (ATM machine etc.)", severity: "info" },
];

const toggle = document.getElementById("enableToggle");
const app = document.querySelector(".app");
const errCount = document.getElementById("errCount");
const warnCount = document.getElementById("warnCount");
const infoCount = document.getElementById("infoCount");
const statusText = document.getElementById("statusText");
const ruleList = document.getElementById("ruleList");

// Render rule list
for (const rule of RULES_META) {
  const li = document.createElement("li");
  li.className = "rule-item";
  li.innerHTML = `<span class="rule-dot rule-dot--${rule.severity}"></span>${escHtml(rule.label)}`;
  ruleList.appendChild(li);
}

// Load saved state
chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  toggle.checked = enabled;
  applyEnabledState(enabled);
});

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
