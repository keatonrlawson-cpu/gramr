// Gramr paste-to-check page logic (content.js provides the checking itself)

const ta = document.getElementById("checkta");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const copyStatus = document.getElementById("copyStatus");

ta.focus();

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ta.value);
    copyStatus.textContent = "Copied ✓ — paste it back where it came from";
  } catch (_) {
    ta.select();
    document.execCommand("copy");
    copyStatus.textContent = "Copied ✓";
  }
  clearTimeout(copyStatus._t);
  copyStatus._t = setTimeout(() => (copyStatus.textContent = ""), 4000);
});

clearBtn.addEventListener("click", () => {
  ta.value = "";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  copyStatus.textContent = "";
});
