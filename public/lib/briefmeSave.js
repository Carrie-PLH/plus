// public/lib/briefmeSave.js
// Canonical BriefMe helpers: auth, save wrapper, cross-tool handoff, and CoPilot hooks.

import { ensureAuth, saveToVault, auth } from "/lib/appBootstrap.js";

/* =========================
   Auth (idempotent)
   ========================= */
let __briefmeInited = false;
/** Initialize auth once per page. Safe to call multiple times. */
export async function initAuth() {
  if (__briefmeInited) return;
  await ensureAuth();
  __briefmeInited = true;
}

/* =========================
   CoPilot ingest (config + helpers)
   Default endpoint uses Hosting rewrite: /copilot/ingest
   ========================= */
let __copilotCfg = {
  enabled: false,
  endpoint: "/copilot/ingest",   // override with full CF URL if you prefer
  defaultTool: "unknown",
};

async function __sendCopilot(event, payload = {}) {
  if (!__copilotCfg.enabled) return;
  try {
    const body = {
      event,
      tool: __copilotCfg.defaultTool,
      uid: (typeof auth !== "undefined" && auth?.currentUser?.uid) || null,
      payload,
      ts: Date.now(),
      meta: {
        path: (typeof location !== "undefined" ? location.pathname : "") || "",
        ref: (typeof document !== "undefined" ? document.referrer : "") || "",
        ua: (typeof navigator !== "undefined" ? navigator.userAgent : "") || "",
      },
    };
    await fetch(__copilotCfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (e) {
    // Never break the page if telemetry fails
    console.warn("CoPilot ingest failed (non-blocking):", e);
  }
}

/** Public convenience to emit arbitrary CoPilot events (uses current defaults). */
export async function copilotIngest(event, payload = {}) {
  return __sendCopilot(event, payload);
}

/**
 * Enable CoPilot telemetry and get reusable save hooks.
 * Call once per page (e.g., on hub or a tool page):
 *   registerCopilotIngest({ enabled:true, defaultTool:"briefme" })
 *
 * Options:
 * - enabled: boolean (default true)
 * - defaultTool: string label for this page/tool
 * - endpoint: keep "/copilot/ingest" if using Hosting rewrite,
 *             or set full URL to the function.
 */
export function registerCopilotIngest(opts = {}) {
  __copilotCfg = {
    ...__copilotCfg,
    enabled: opts.enabled !== false,
    defaultTool: opts.defaultTool || __copilotCfg.defaultTool,
    endpoint: opts.endpoint || __copilotCfg.endpoint,
  };

  const hooks = {
    beforeSave: async (p) => {
      await __sendCopilot("save_start", {
        type: p?.type, title: p?.title, tags: p?.extraTags || [],
      });
    },
    afterSave: async (result, p) => {
      await __sendCopilot("save_ok", {
        type: p?.type, title: p?.title, id: result?.id ?? null,
      });
    },
    onError: async (err, p) => {
      await __sendCopilot("save_error", {
        type: p?.type, title: p?.title, error: String(err?.message || err),
      });
    },
  };

  try {
    // Make hooks available globally for easy one-liners in tools
    window.briefme = Object.assign(window.briefme || {}, { copilotHooks: hooks });
  } catch {}
  return hooks;
}

/* =========================
   Unified Vault save wrapper
   ========================= */
export async function saveEntryToVault({
  type,
  title,
  structured,
  rawOverride,
  extraTags = [],
}) {
  if (typeof type !== "string" || !type.trim()) {
    throw new Error("saveEntryToVault: 'type' is required and must be a non-empty string.");
  }
  if (typeof title !== "string" || !title.trim()) {
    throw new Error("saveEntryToVault: 'title' is required and must be a non-empty string.");
  }

  // Ensure auth even if a page forgot to call initAuth()
  await initAuth();

  const body = structured ?? {};
  const rawText =
    typeof rawOverride === "string" && rawOverride.length
      ? rawOverride
      : JSON.stringify(body, null, 2);

  const tags = Array.from(new Set(["briefme", String(type), ...(extraTags || [])]));

  return await saveToVault({
    type,
    title,
    rawText,
    structured: body,
    tags,
    summarize: true,
  });
}

/* =========================
   Hooks-enhanced save (emits CoPilot events)
   ========================= */
export async function saveEntryToVaultWithHooks(params, opts = {}) {
  const { beforeSave, afterSave } = opts;

  // Emit start (non-blocking)
  __sendCopilot("save_start", {
    type: params?.type, title: params?.title, tags: params?.extraTags || [],
  });

  if (beforeSave) await beforeSave(params);

  try {
    const result = await saveEntryToVault(params);

    // Emit success (non-blocking)
    __sendCopilot("save_ok", {
      type: params?.type, title: params?.title, id: result?.id || null,
    });

    if (afterSave) await afterSave(result, params);
    return result;
  } catch (err) {
    // Emit error (non-blocking)
    __sendCopilot("save_error", {
      type: params?.type, title: params?.title, error: String(err?.message || err),
    });
    throw err;
  }
}

/* =========================
   Cross-tool handoff (sessionStorage)
   ========================= */
const HANDOFF_KEY = "global_handoff_payload";

export function setGlobalHandoff(payload) {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload ?? {}));
  } catch {}
}

export function getGlobalHandoff(clear = true) {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    if (clear) sessionStorage.removeItem(HANDOFF_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Register a handoff + navigate helper other tools can call.
 * Example:
 *   registerToolHandoff("storyShaper", "/BriefMe/StoryShaper/", (data) => ({
 *     location: data.location,
 *     severity: data.severity
 *   }));
 */
export function registerToolHandoff(toolName, targetUrl, mapFn) {
  if (!toolName || !targetUrl || typeof mapFn !== "function") {
    console.warn("registerToolHandoff: invalid args");
    return () => {};
  }
  const fn = (data) => {
    try {
      const payload = mapFn(data) || {};
      setGlobalHandoff(payload);
      const url = new URL(targetUrl, location.origin);
      // carry a breadcrumb
      url.searchParams.set("from", String(toolName));
      location.href = url.toString();
    } catch (e) {
      console.error("handoff failed:", e);
    }
  };
  try {
    window.briefme = Object.assign(window.briefme || {}, {
      handoff: Object.assign({}, (window.briefme && window.briefme.handoff) || {}, {
        [toolName]: fn,
      }),
    });
  } catch {}
  return fn;
}

/* =========================
   Auto-prefill (URL params + handoff)
   ========================= */
(function autoPrefillOnce() {
  try {
    if (typeof document === "undefined") return;
    const params = new URLSearchParams(location.search);
    if (params.get("noprefill") === "1") return;

    const fillFromParams = () => {
      const fields = document.querySelectorAll(
        'input[id], textarea[id], select[id], input[name], textarea[name], select[name]'
      );
      fields.forEach((el) => {
        const key = el.id || el.name;
        if (!key) return;
        const v = params.get(key);
        if (v == null) return;

        if (el.type === "checkbox" || el.type === "radio") {
          if (el.value === v || v === "on") el.checked = true;
        } else {
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    };

    const fillFromHandoff = () => {
      const blob = getGlobalHandoff(true);
      if (!blob || typeof blob !== "object") return;

      Object.entries(blob).forEach(([key, value]) => {
        if (value == null) return;

        // Try exact id, then name
        let el = document.getElementById(key);
        if (!el) el = document.querySelector(`[name="${CSS.escape(key)}"]`);
        if (!el) return;

        // Radio/checkbox groups (by shared name)
        if ((el.type === "radio" || el.type === "checkbox") && el.name) {
          const group = document.querySelectorAll(`[name="${CSS.escape(el.name)}"]`);
          const values = Array.isArray(value) ? value.map(String) : [String(value)];
          group.forEach((node) => {
            if (values.includes(node.value)) node.checked = true;
          });
          return;
        }

        // Simple assignment
        el.value = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    const run = () => { fillFromParams(); fillFromHandoff(); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  } catch {
    // never break pages on prefill errors
  }
})();

/* =========================
   Expose on window for non-module pages
   ========================= */
try {
  window.briefme = Object.assign(window.briefme || {}, {
    initAuth,
    saveEntryToVault,
    saveEntryToVaultWithHooks,
    setGlobalHandoff,
    getGlobalHandoff,
    registerToolHandoff,
    copilotIngest,
    registerCopilotIngest,
  });
} catch {}

/* =========================
   Final default export
   ========================= */
export default {
  initAuth,
  saveEntryToVault,
  saveEntryToVaultWithHooks,
  setGlobalHandoff,
  getGlobalHandoff,
  registerToolHandoff,
  copilotIngest,
  registerCopilotIngest,
};