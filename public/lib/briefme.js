// /lib/briefme.js
import { ensureAuth, saveToVault as coreSave } from "/lib/appBootstrap.js";

/** Call once at page start, survives design rewrites */
export async function initBriefMe() {
  await ensureAuth();
}

/** The only way pages should persist to the Vault */
export async function saveEntryToVault({ type, title, structured, rawOverride, extraTags = [] }) {
  const rawText = rawOverride || JSON.stringify(structured, null, 2);
  return coreSave({
    type,
    title,
    rawText,
    structured,
    tags: ["briefme", type, ...extraTags],
    summarize: true
  });
}

/** Lightweight, boring helpers that won’t change if UI does */
export const formUtils = {
  $: (id) => document.getElementById(id),
  $$: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

  getChecked: (name, root = document) =>
    Array.from(root.querySelectorAll(`[name="${name}"]:checked`)).map(el => el.value),

  attachCounter(id, max) {
    const el = this.$(id), counter = this.$(id + "Count");
    if (!el || !counter) return;
    const update = () => { counter.textContent = `${el.value.length}/${max}`; };
    el.addEventListener("input", update); update();
  },

  bindRange(rangeId, valueId, fmt = (v) => v) {
    const r = this.$(rangeId), v = this.$(valueId);
    if (!r || !v) return;
    const update = () => { v.textContent = fmt(r.value); };
    r.addEventListener("input", update); update();
  },

  /** Serialize a list of “cards” with named inputs */
  serializeCards(wrapEl, fields) {
    if (!wrapEl) return [];
    return Array.from(wrapEl.children).map(card => {
      const obj = {};
      fields.forEach(f => {
        const input = card.querySelector(`[name="${f}"]`);
        obj[f] = (input && input.value ? String(input.value).trim() : "");
      });
      return obj;
    }).filter(rec => Object.values(rec).some(v => v && String(v).length));
  },

  downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }
};