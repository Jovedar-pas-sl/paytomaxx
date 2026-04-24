// Small utilities used across pages.
// Deliberately tiny — no framework, no build step.

(function () {
  "use strict";

  // Relative time formatter (falls back to absolute if Intl.RelativeTimeFormat unavailable).
  const RTF = (typeof Intl !== "undefined" && Intl.RelativeTimeFormat)
    ? new Intl.RelativeTimeFormat("es", { numeric: "auto" })
    : null;

  function relativeTime(isoTimestamp) {
    const then = new Date(isoTimestamp);
    const diffSec = Math.round((then - Date.now()) / 1000);
    if (!RTF) return then.toLocaleString("es");
    const abs = Math.abs(diffSec);
    if (abs < 60) return RTF.format(diffSec, "second");
    if (abs < 3600) return RTF.format(Math.round(diffSec / 60), "minute");
    if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), "hour");
    return RTF.format(Math.round(diffSec / 86400), "day");
  }

  // Apply to all [data-time] elements on load + after HTMX swaps.
  function applyRelativeTimes(root) {
    (root || document).querySelectorAll("[data-time]").forEach((el) => {
      const iso = el.getAttribute("data-time");
      if (iso) el.textContent = relativeTime(iso);
    });
  }

  document.addEventListener("DOMContentLoaded", () => applyRelativeTimes());
  document.body.addEventListener("htmx:afterSwap", (e) => applyRelativeTimes(e.target));
})();
