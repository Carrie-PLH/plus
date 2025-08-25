// public/lib/briefmeAuto.js

// Ensure a favicon so pages don't 404 /favicon.ico
try {
  if (typeof document !== "undefined" && !document.querySelector('link[rel="icon"]')) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="14" font-size="14">🩺</text></svg>';
    document.head.appendChild(link);
  }
} catch {}

// public/lib/briefmeAuto.js - Add to your existing file
import { checkToolAccess, detectCurrentTool, showUpgradeOverlay, showInlineUpgrade } from './toolAccess.js';

// Auto-check access on page load
(async function initAccessControl() {
  // Skip on non-tool pages
  const excludedPaths = ['/', '/Vault/', '/pricing', '/subscribe', '/login'];
  if (excludedPaths.includes(window.location.pathname)) return;
  
  const toolId = detectCurrentTool();
  
  if (toolId) {
    try {
      const access = await checkToolAccess(toolId);
      
      // Store globally for tool-specific use
      window.briefme = window.briefme || {};
      window.briefme.access = access;
      window.briefme.toolId = toolId;
      
      // Handle different access scenarios
      if (!access.allowed) {
        if (access.hardBlock || access.reason === 'login_required') {
          // Complete block - show overlay
          showUpgradeOverlay(access);
        } else if (access.reason === 'limit_reached') {
          // Soft block - allow viewing but disable actions
          disableToolActions(access);
        }
      } else if (access.anonymous) {
        // Show gentle upgrade prompt for anonymous users
        showAnonPrompt();
      }
      
    } catch (error) {
      console.error('Access control error:', error);
      // Fail open - allow access if check fails
    }
  }
})();

function disableToolActions(access) {
  // Add warning banner
  const header = document.querySelector('header, h1, .container');
  if (header) {
    const warning = document.createElement('div');
    warning.className = 'pl-limit-warning';
    warning.innerHTML = `
      ⚠️ Daily limit reached. You can view this tool but cannot save or generate content. 
      <a href="/subscribe">Upgrade for more</a>
    `;
    header.after(warning);
  }
  
  // Disable submit buttons
  document.querySelectorAll('button[type="submit"], .btn-primary').forEach(btn => {
    btn.disabled = true;
    btn.title = 'Daily limit reached';
    btn.style.opacity = '0.6';
  });
}

function showAnonPrompt() {
  const uses = parseInt(localStorage.getItem('anonToolUses') || '0');
  if (uses === 2) {
    const prompt = document.createElement('div');
    prompt.className = 'pl-anon-prompt';
    prompt.innerHTML = `
      <div>🎁 You have 1 free use remaining. 
      <a href="/login">Sign in</a> for more free uses or 
      <a href="/subscribe">view plans</a></div>
    `;
    document.body.prepend(prompt);
  }
}

import { registerCopilotIngest } from "/lib/briefmeSave.js";

// Infer a friendly tool label from the URL, e.g. /BriefMe/StoryShaper/ => "briefme_storyshaper"
const parts = (location.pathname || "/").split("/").filter(Boolean);
const guess =
  parts.length >= 2 ? (parts[0] + "_" + parts[1]).toLowerCase()
: parts[0] || "site";

registerCopilotIngest({ enabled: true, defaultTool: guess });
// --- Contextual "Need something else?" card (enforced allow-list) ---
(() => {
  // Avoid duplicate mounting if briefmeAuto loads twice
  if (window.__needCardMountedOnce) return;
  window.__needCardMountedOnce = true;

  const path = (location.pathname || "").toLowerCase();
  const toolGuess = (guess || "").toLowerCase();     // e.g., "briefme_storyshaper", "symptompro"
  const leaf = toolGuess.includes("_") ? toolGuess.split("_").slice(-1)[0] : toolGuess;

  // Where we NEVER show (home/hub/landing)
  const denyPaths = new Set([
    "/", "/index.html", "/home", "/welcome",
    "/briefme/", "/briefme/index.html"
  ]);

  // Where we DO show (desktop only)
  const allowTools = new Set([
    "promptcoach",
    "rightsbuilder",
    "appealbuilder",
    "accesspro",
    "strategycoach",
    "peermatch",
  ]);

  const isDesktop = window.matchMedia("(min-width: 768px)").matches;

  // Helper to remove any existing card immediately
  const removeCard = () => {
    const el = document.getElementById("need-something-card");
    if (el) el.remove();
  };

  // Decide visibility (default = HIDE)
  const allowed =
    isDesktop &&
    !denyPaths.has(path) &&
    allowTools.has(leaf);

  // Global guard so any legacy snippet can check too
  window.__needCardAllowed = allowed;

  // If not allowed, force-remove any previously injected card and exit
  if (!allowed) {
    removeCard();
    return;
  }

  // Respect user dismissal (per tool) for 7 days
  const DISMISS_KEY = `needCardDismissed:${leaf}`;
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const dismissed = (() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (!raw) return false;
      const { ts } = JSON.parse(raw);
      return ts && (Date.now() - ts) < TTL;
    } catch { return false; }
  })();
  if (dismissed) return;

  // Build card
  const wrap = document.createElement("div");
  wrap.id = "need-something-card";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-label", "Additional help and options");
  wrap.innerHTML = `
    <div style="
      position: fixed; bottom: 20px; right: 20px;
      background: #fff; border: 1px solid #ccc;
      padding: 12px 16px; max-width: 280px;
      font-family: Roboto, system-ui, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.15);
      border-radius: 12px; z-index: 9999;
    ">
      <div style="display:flex; align-items:flex-start; gap:10px">
        <div style="font-size:18px; line-height:1">💡</div>
        <div style="flex:1">
          <strong style="display:block; margin-bottom:4px;">Need something else?</strong>
          <p style="font-size: 14px; margin: 0 0 8px;">
            Explore more options or tell us what you're trying to do.
          </p>
          <div style="display:flex; gap:8px;">
            <a href="/"
              style="flex:1; text-align:center; text-decoration:none;
                     background:#3c5c5e; color:#fff; border-radius:6px; padding:6px 10px; font-size:13px;">
              Explore
            </a>
            <button data-close
              style="background:#c97f6d; color:#fff; border:none; border-radius:6px;
                     padding:6px 10px; font-size:13px; cursor:pointer;">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.addEventListener("DOMContentLoaded", () => {
    // Final sanity: if something else injected one already, remove it
    const existing = document.getElementById("need-something-card");
    if (existing) existing.remove();

    document.body.appendChild(wrap);
    wrap.querySelector("[data-close]")?.addEventListener("click", () => {
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify({ ts: Date.now() })); } catch {}
      wrap.remove();
    });
  });
})();

// --- Optional welcome card (opt-in, desktop-only, closable) ---
(function () {
  // Only show if page opts-in BEFORE briefmeAuto loads:
  const enabled = !!(window.briefme && window.briefme.welcome && window.briefme.welcome.enabled);

  // Never on landing page
  const isLanding =
    location.pathname === "/" ||
    (/\/index\.html$/i.test(location.pathname) && (parts.length === 0 || parts.length === 1));

  // Desktop-only
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 767px)").matches;

  // Per-tool dismissal key
  const dismissedKey = `welcomeCard:dismissed:${guess}`;
  const dismissed = localStorage.getItem(dismissedKey) === "1";

  if (!enabled || isLanding || isMobile || dismissed) return;

  const card = document.createElement("div");
  card.id = "welcome-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Helper");

  Object.assign(card.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    maxWidth: "360px",
    zIndex: "9999",
    background: "#ffffff",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: "12px",
    boxShadow: "0 6px 24px rgba(0,0,0,0.12)",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    overflow: "hidden",
  });

  card.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:#ebf0eb;">
      <div style="font-weight:600; color:#3c5c5e;">Need something else?</div>
      <button type="button" aria-label="Close" id="welcome-card-close"
        style="all:unset; cursor:pointer; padding:4px 6px; line-height:1; color:#3c5c5e;">✕</button>
    </div>
    <div style="padding:12px 12px 4px 12px; color:#333; font-size:14px;">
      You can switch tasks anytime. I’ll keep your work saved in your Vault.
    </div>
    <div style="display:flex; gap:8px; padding:12px;">
      <a href="/" style="flex:1; text-align:center; text-decoration:none; padding:8px 10px; border-radius:8px; border:1px solid #a3b9a3; color:#3c5c5e;">Browse options</a>
      <button id="welcome-card-hide" type="button"
        style="flex:1; padding:8px 10px; border-radius:8px; border:none; background:#3c5c5e; color:#fff; cursor:pointer;">
        Hide
      </button>
    </div>
  `;

  // Close handlers
  const removeCard = () => card.remove();
  card.querySelector("#welcome-card-close")?.addEventListener("click", removeCard);
  card.querySelector("#welcome-card-hide")?.addEventListener("click", () => {
    try { localStorage.setItem(dismissedKey, "1"); } catch {}
    removeCard();
  });

  document.body.appendChild(card);
})();

// Optional: begin a simple session
try {
  window.briefme?.saveEntryToVaultWithHooks &&
    window.briefme.registerCopilotIngest &&
    console.debug("[CoPilot] auto-init:", guess);
} catch {}
// --- Universal form binder: window.briefme.configureForm(config) ---
(function(){
  const q = (window.briefme = window.briefme || {});
  const queue = (q._cfgQueue = q._cfgQueue || []);

  // Allow pages to call before briefmeAuto is fully ready
  q.configureForm = function(config) {
    queue.push(config);
    // If runtime is already ready, try to apply immediately
    if (q._bindReady) tryApplyAll();
  };

  function tryApplyAll() {
    // requires saveEntryToVaultWithHooks which briefmeAuto wires up
    const saveWithHooks = q.saveEntryToVaultWithHooks || window.briefme?.saveEntryToVaultWithHooks;
    if (!saveWithHooks) return;

    while (queue.length) {
      const cfg = queue.shift();
      try {
        bindOne(cfg, saveWithHooks, q.copilotHooks || {});
      } catch (e) {
        console.warn("configureForm bind failed:", e);
      }
    }
  }

  function bindOne(cfg, saveWithHooks, hooks) {
    const {
      selector,              // e.g. "#symptomForm"
      type,                  // e.g. "symptomPro"
      title,                 // string OR function(data)=>string
      extraTags = [],        // e.g. ["symptom","OLD_CARTS"]
      collect = null         // optional custom collector (form)=>data
    } = cfg || {};

    if (!selector || !type) throw new Error("configureForm: selector and type are required");

    const form = document.querySelector(selector);
    if (!form) {
      console.warn(`configureForm: form not found for ${selector}`);
      return;
    }

    function defaultCollect(f) {
      const fd = new FormData(f);
      const data = Object.fromEntries(fd.entries());
      // also collect any multi-values
      const multiNames = new Set();
      fd.forEach((_, k) => { if (multiNames.has(k)) return; if (fd.getAll(k).length > 1) multiNames.add(k); });
      multiNames.forEach((k) => { data[k] = fd.getAll(k); });
      return data;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = collect ? collect(form) : defaultCollect(form);

      const computedTitle = (typeof title === "function")
        ? title(data)
        : (title || `${type[0].toUpperCase()+type.slice(1)} Entry`);

      try {
        await saveWithHooks(
          {
            type,
            title: computedTitle,
            structured: data,
            rawOverride: JSON.stringify(data, null, 2),
            extraTags
          },
          hooks || {}
        );
        alert("Saved to your Vault.");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) {
        console.error(`${type} save failed:`, err);
        alert("Save failed. Check console for details.");
      }
    });
  }

  // Mark ready after briefmeAuto sets up global functions
  // briefmeAuto should call this once everything is wired
  function markReadyAndApply() {
    q._bindReady = true;
    tryApplyAll();
  }

  // Run after DOM ready to bind any queued configs
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { markReadyAndApply(); }, { once: true });
  } else {
    markReadyAndApply();
  }
})();