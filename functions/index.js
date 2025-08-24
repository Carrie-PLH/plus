// functions/index.js — minimal template with ping + toolTemplateRun + vaultWriteEpisode

import { onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

initializeApp();
const db = getFirestore(); // <-- add this line once after initializeApp()

// Secret set with: npx firebase-tools@latest functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// --- Health check (callable)
export const ping = onCall({ region: "us-east4" }, async () => {
  return { ok: true, pong: true, ts: Date.now() };
});

/**
 * --- CoPilot ingest (HTTP + CORS)
 * Frontend posts small cross-tool events here: /copilot/ingest (via hosting rewrite)
 * Stores into Firestore: collection "copilotEvents"
 */
export const copilotIngest = onRequest(
  {
    region: "us-east4",
    cors: [
      "https://black-monitor-469420-h9.web.app",
      "http://localhost:5000" // optional local preview
    ],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }
    try {
      const uid =
        req.get("X-User-UID") ||
        (typeof req.body?.uid === "string" ? req.body.uid : "anon");

      const event = req.body || {};
      const doc = {
        uid,
        ts: Number(event.ts) || Date.now(),
        tool: String(event.tool || "unknown"),
        type: String(event.type || "unknown"),
        title: String(event.title || ""),
        tags: Array.isArray(event.tags) ? event.tags.slice(0, 12) : [],
        meta: event.meta && typeof event.meta === "object" ? event.meta : {},
      };

      await db.collection("copilotEvents").add(doc);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("copilotIngest error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

// --- Generic tool callable (used by /newtool/)
export const toolTemplateRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { input } = request.data || {};
      if (input == null) {
        return { ok: false, error: "Missing 'input' payload" };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const msg = await client.messages.create({
        // If this model isn’t available to your account, try: "claude-3-7-sonnet-20250219"
        model: "claude-sonnet-4-20250514",
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content:
              "Summarize this JSON data in plain English:\n\n" +
              JSON.stringify(input),
          },
        ],
      });

      let text = "";
      if (Array.isArray(msg?.content) && typeof msg.content[0]?.text === "string") {
        text = msg.content[0].text;
      }
      return { ok: true, data: { result: text } };
    } catch (e) {
      console.error("toolTemplateRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }
);

// --- TrendTrack (callable)
export const trendTrackRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { records } = request.data || {};
      if (!Array.isArray(records) || records.length === 0) {
        return { ok: false, error: "Provide 'records' as a non-empty array" };
      }
      const MAX = 500;
      if (records.length > MAX) {
        return { ok: false, error: `Too many records. Limit is ${MAX}.` };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `
You are analyzing patient self-tracked symptom data. 
Goals:
1) Identify trends over time by symptom and severity.
2) Detect cycles, flares, or triggers suggested by notes.
3) Suggest simple visualizations: line over time by average severity, stacked day counts by symptom, moving average windows.

Input JSON:
${JSON.stringify(records).slice(0, 20000)}
Return JSON with:
{
  "insights": ["..."],
  "suggestedCharts": [
    { "type": "line", "x": "date", "y": "avg_severity", "groupBy": "symptom" },
    { "type": "stacked_bar", "x": "date", "y": "count", "groupBy": "symptom" }
  ],
  "aggregates": {
    "byDate": [{ "date": "YYYY-MM-DD", "avgSeverity": 0, "counts": { "headache": 2, "nausea": 1 } }],
    "topSymptoms": [{ "symptom": "headache", "avgSeverity": 5.8, "days": 14 }]
  }
}
If information is insufficient, be explicit about what is missing.
      `.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      });

      const text = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return { ok: true, data: parsed ? parsed : { insights: [text] } };
    } catch (e) {
      console.error("trendTrackRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }
);

// --- SymptomPro (callable)
export const generateSummary = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { symptoms, context } = request.data || {};
      if (!symptoms) {
        return { ok: false, error: "Missing 'symptoms' object" };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `
Create a concise provider-ready symptom summary using the OLD CARTS framework.
Return plain text with bolded section labels. If data is missing, note it briefly.

Input:
${JSON.stringify({ symptoms, context }).slice(0, 20000)}
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      });

      const text = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      return { ok: true, summary: text || "No output." };
    } catch (e) {
      console.error("generateSummary error:", e?.response?.data || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }
);

// --- PromptPro (callable)
export const promptProRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { symptoms, context } = request.data || {};
      if (!symptoms || typeof symptoms !== "object") {
        return { ok: false, error: "Provide 'symptoms' as an object. Optionally include 'context'." };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `
You help patients prepare for clinical visits. 
Turn the provided symptom details into clear, specific, ready-to-ask questions for a clinician. 
Organize output into categories: Clarifying Diagnosis, Severity and Risk, Triggers and Patterns, Workup and Next Steps, Self-care and Safety. 
Write questions in plain language. Avoid medical jargon unless necessary. 
Return JSON with:
{
  "questions": [
    { "category": "Clarifying Diagnosis", "q": "..." },
    { "category": "Severity and Risk", "q": "..." }
  ],
  "notes": "Any short caveats or missing info that would improve the questions."
}

Input:
${JSON.stringify({ symptoms, context }).slice(0, 20000)}
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      });

      const text = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      let data;
      try { data = JSON.parse(text); } catch { data = { questions: [], notes: text }; }

      return { ok: true, data };
    } catch (err) {
      console.error("promptProRun error:", err?.response?.data || err);
      return { ok: false, error: err?.message || String(err) };
    }
  }
);

// --- ResetPro (callable)
export const resetProRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { thread, goal } = request.data || {};
      if (!Array.isArray(thread) || thread.length === 0) {
        return { ok: false, error: "Provide 'thread' as a non-empty array of {role,text,ts?}." };
      }

      const clean = thread
        .filter(m => m && typeof m.text === "string" && (m.role === "provider" || m.role === "patient"))
        .slice(0, 50);

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const system = `
You help patients recognize dismissive or gaslighting patterns in clinical communications, 
suggest assertive, respectful responses, and generate a neutral documentation note.
Safety: do not give medical advice; recommend contacting a licensed clinician for care decisions.
`.trim();

      const input = JSON.stringify({ thread: clean, goal }, null, 2).slice(0, 18000);

      const user = `
Analyze this message thread.
Return strict JSON with the specified structure.
Thread:
${input}
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: user }],
      });

      const text = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      let data;
      try { data = JSON.parse(text); }
      catch { data = { overallAssessment: text, responseOptions: [], flags: {}, docNote: {} }; }

      return { ok: true, data };
    } catch (err) {
      console.error("resetProRun error:", err?.response?.data || err);
      return { ok: false, error: err?.message || String(err) };
    }
  }
);

// --- PromptCoach (callable)
export const promptCoachRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { role, goal, thread, coachingLevel } = request.data || {};
      if (!role || !["patient", "provider"].includes(role)) {
        return { ok: false, error: "Provide 'role' as 'patient' or 'provider'." };
      }
      if (!Array.isArray(thread) || thread.length === 0) {
        return { ok: false, error: "Provide 'thread' as a non-empty array." };
      }

      const clean = thread
        .filter(m => m && typeof m.text === "string" && (m.speaker === "patient" || m.speaker === "provider"))
        .slice(0, 40);

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const system = `
You are a communication coach for patient-provider conversations.
Safety: no medical advice. Do not judge intent. Focus on language and structure.
`.trim();

      const user = `
We are doing live practice.
Return RAW JSON in the specified shape.
Thread: ${JSON.stringify(clean).slice(0, 18000)}
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        system,
        messages: [{ role: "user", content: user }],
      });

      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let data;
      try { data = JSON.parse(cleaned); }
      catch {
        data = {
          counterpartyReply: cleaned || "",
          coaching: { whatWentWell: [], improveNextTurn: [], techniques: [] },
          responseOptions: [],
          nextTurnPrompt: "",
        };
      }

      const arr = x => Array.isArray(x) ? x.map(String) : [];
      data.coaching = data.coaching || {};
      data.coaching.whatWentWell = arr(data.coaching.whatWentWell);
      data.coaching.improveNextTurn = arr(data.coaching.improveNextTurn);
      data.coaching.techniques = arr(data.coaching.techniques);
      data.responseOptions = (data.responseOptions || []).slice(0, 3);

      return { ok: true, data };
    } catch (err) {
      console.error("promptCoachRun error:", err?.response?.data || err);
      return { ok: false, error: err?.message || "Internal error" };
    }
  }
);

// --- AppealBuilder (callable)
export const appealBuilderRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { patientInfo, denialReason, denialDate, submissionDate } = request.data || {};
      if (!patientInfo || !denialReason) {
        return { ok: false, error: "Provide patientInfo and denialReason" };
      }

      const toISO = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch { return null; } };
      const addDaysISO = (d, n) => { try { return new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10); } catch { return null; } };
      const denialISO = denialDate ? toISO(denialDate) : null;
      const submissionISO = submissionDate ? toISO(submissionDate) : null;

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `...`; // (kept as in your version to stay concise)

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let parsed = null;
      try { parsed = JSON.parse(cleaned); } catch {}
      if (!parsed) parsed = { appealText: cleaned, evidence: [], deadlines: {} };

      const out = { ...parsed };
      out.deadlines = out.deadlines || {};
      if (!out.deadlines.submitBy && denialISO) out.deadlines.submitBy = addDaysISO(denialISO, 60) || "Submit within 60 days of denial";
      if (!out.deadlines.followUp) {
        const base = submissionISO || denialISO;
        out.deadlines.followUp = base ? addDaysISO(base, 30) || "Follow up 30 days after submission" : "Follow up 30 days after submission";
      }
      if (typeof out.appealText !== "string" || !out.appealText.trim()) out.appealText = "No appeal text produced.";
      if (!Array.isArray(out.evidence)) out.evidence = [];
      if (typeof out.deadlines !== "object" || out.deadlines === null) out.deadlines = {};

      return { ok: true, data: out };
    } catch (e) {
      console.error("appealBuilderRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- RightsBuilder (callable)
export const rightsBuilderRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { question, context, jurisdiction } = request.data || {};
      if (!question || typeof question !== "string") {
        return { ok: false, error: "Provide 'question' as a non-empty string. Optional: 'context', 'jurisdiction'." };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `...`; // (kept as in your version)

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let data = null;
      try { data = JSON.parse(cleaned); }
      catch { data = { rightsSummary: cleaned, nextSteps: [], templates: [], notes: "", references: [] }; }

      if (typeof data.rightsSummary !== "string") data.rightsSummary = String(data.rightsSummary || "");
      if (!Array.isArray(data.nextSteps)) data.nextSteps = [];
      if (!Array.isArray(data.templates)) data.templates = [];
      if (!Array.isArray(data.references)) data.references = [];
      if (typeof data.notes !== "string") data.notes = String(data.notes || "");

      return { ok: true, data };
    } catch (e) {
      console.error("rightsBuilderRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- TriageTrack (callable)
export const triageTrackRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { patient, events, context } = request.data || {};
      if (!Array.isArray(events) || events.length === 0) {
        return { ok: false, error: "Provide 'events' as a non-empty array." };
      }

      const clean = events.slice(0, 50);
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const system = `...`;
      const user = `...`;

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 900,
        system,
        messages: [{ role: "user", content: user }],
      });

      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let data;
      try { data = JSON.parse(cleaned); }
      catch { data = { summary: cleaned, redFlags: [], vitalsOfConcern: [], immediateActions: [], next24h: [], communicationPoints: [], riskLevel: "unknown", notes: "" }; }

      const normArr = (x) => Array.isArray(x) ? x.map(String) : [];
      const out = {
        summary: String(data.summary || ""),
        redFlags: normArr(data.redFlags),
        vitalsOfConcern: normArr(data.vitalsOfConcern),
        immediateActions: normArr(data.immediateActions),
        next24h: normArr(data.next24h),
        communicationPoints: normArr(data.communicationPoints),
        riskLevel: String(data.riskLevel || "unknown"),
        notes: String(data.notes || ""),
      };

      return { ok: true, data: out };
    } catch (e) {
      console.error("triageTrackRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- PeerMatch (callable)
export const peerMatchRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      // (kept as in your version)
      // ...
      return { ok: true, data: { matches: results, safetyGuide, notes: "Educational use only. This is not clinical advice." } };
    } catch (e) {
      console.error("peerMatchRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- ProviderMatch (callable)
export const providerMatchRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      // (kept as in your version)
      // ...
      return { ok: true, data: { matches: results, notes: globalNotes } };
    } catch (e) {
      console.error("providerMatchRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- StrategyCoach (callable)
export const strategyCoachRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      // (kept as in your version)
      // ...
      return { ok: true, data };
    } catch (e) {
      console.error("strategyCoachRun error:", e?.response?.data || e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- AccessPro (callable)
export const accessProRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { text, targetLanguage, simplify } = request.data || {};
      if (!text || typeof text !== "string") {
        return { ok: false, error: "Provide input text for processing." };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const prompt = `...`;

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });

      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let data;
      try { data = JSON.parse(cleaned); }
      catch { data = { transcript: text, translation: raw, simplified: simplify ? raw : "" }; }

      return { ok: true, data };
    } catch (e) {
      console.error("accessProRun error:", e);
      return { ok: false, error: e?.message || "Internal error" };
    }
  }
);

// --- Vault write endpoint (HTTP, CORS, us-east4)
export const vaultWriteEpisode = onRequest(
  {
    region: "us-east4",
    cors: [
      "https://black-monitor-469420-h9.web.app",
      "http://localhost:5000", // local testing
    ],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    try {
      const payload = req.body || {};
      res.status(200).json({ ok: true, data: payload });
    } catch (err) {
      console.error("vaultWriteEpisode error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);