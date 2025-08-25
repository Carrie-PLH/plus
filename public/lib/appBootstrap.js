// public/lib/appBootstrap.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

import { firebaseConfig, FUNCTIONS_REGION } from "/lib/config.js";
import { makeVaultHelpers } from "/lib/vault.js";

// --- Firebase init (once) ---
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, FUNCTIONS_REGION);

// --- Export Firebase instances for use in other modules ---
export { app, auth, functions };

// --- Create and export vault helpers ---
export const vaultHelpers = makeVaultHelpers(app, FUNCTIONS_REGION);

// --- Lightweight ensure-auth you can await on any page ---
export function ensureAuth() {
  return new Promise((resolve, reject) => {
    let done = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user && !done) {
        done = true;
        unsub();
        resolve(user);
      } else if (!user && !done) {
        try {
          await signInAnonymously(auth);
          // onAuthStateChanged will fire again and resolve
        } catch (e) {
          done = true;
          unsub();
          reject(e);
        }
      }
    });
  });
}

// --- Optional: Export a ready-to-use auth state checker ---
export function getCurrentUser() {
  return auth.currentUser;
}

// --- Optional: Export auth state change listener ---
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// --- Vault helpers (originals) ---
const helpers = makeVaultHelpers(app, FUNCTIONS_REGION);
const _saveToVault = helpers.saveToVault;   // keep original
const { listEpisodes } = helpers;           // pass-through export

// --- CoPilot helpers (tiny, privacy-light) ---
function inferToolFromPath() {
  try {
    const p = (location?.pathname || "").toLowerCase();
    const map = {
      "/briefme/appointmentplanner/": "AppointmentPlanner",
      "/briefme/resumebuilder/":      "ResumeBuilder",
      "/briefme/storyshaper/":        "StoryShaper",
      "/briefme/agendadesigner/":     "AgendaDesigner",
      "/briefme/conversationframer/": "ConversationFramer",
      "/briefme/actiontracker/":      "ActionTracker",
      "/briefme/caremapper/":         "CareMapper",
      "/tools/promptpro/":            "PromptPro",
      "/tools/appealbuilder/":        "AppealBuilder",
      "/tools/peermatch/":            "PeerMatch",
      "/tools/accesspro/":            "AccessPro",
      "/tools/rightsbuilder/":        "RightsBuilder",
      "/tools/trendtrack/":           "TrendTrack",
      "/tools/triagetrack/":          "TriageTrack",
      "/tools/providermatch/":        "ProviderMatch",
      "/tools/strategycoach/":        "StrategyCoach",
      "/tools/resetpro/":             "ResetPro",
    };
    const key = Object.keys(map).sort((a,b)=>b.length-a.length).find(k => p.startsWith(k));
    return key ? map[key] : null;
  } catch { return null; }
}

function summarizeStructured(s) {
  if (!s || typeof s !== "object") return {};
  const out = {};
  if ("severity" in s) out.severity = Number(s.severity) || null;
  if (Array.isArray(s.goals)) out.goalsCount = s.goals.length;
  if (Array.isArray(s.tasks)) out.tasksCount = s.tasks.length;
  if (typeof s.summary === "string") out.hasSummary = s.summary.trim().length > 0;
  if ("diagnoses" in s && Array.isArray(s.diagnoses)) out.dxCount = s.diagnoses.length;
  if ("providers" in s && Array.isArray(s.providers)) out.providersCount = s.providers.length;
  if ("events" in s && Array.isArray(s.events)) out.eventsCount = s.events.length;
  if ("symptoms" in s && Array.isArray(s.symptoms)) out.symptomCount = s.symptoms.length;
  return out;
}

async function tapCoPilot(event) {
  try {
    const uid = auth?.currentUser?.uid;
    await fetch("/copilot/ingest", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(uid ? { "X-User-UID": uid } : {})
      },
      body: JSON.stringify(event)
    });
  } catch {
    // never block the user on analytics/assist failures
  }
}

// --- Wrapped saveToVault that taps CoPilot on success ---
export async function saveToVault(args) {
  // call the original writer
  const res = await _saveToVault(args);

  // best-effort meta event (non-blocking)
  try {
    const { type, title, tags, structured } = args || {};
    const event = {
      ts: Date.now(),
      tool: (structured && structured.__tool) || inferToolFromPath() || "unknown",
      type: String(type || "unknown"),
      title: String(title || ""),
      tags: Array.isArray(tags) ? tags.slice(0, 12) : [],
      meta: summarizeStructured(structured)
    };
    // fire-and-forget
    tapCoPilot(event);
  } catch {
    // ignore
  }

  return res;
}

// --- Exports used by pages ---
export { app, auth, functions, listEpisodes };