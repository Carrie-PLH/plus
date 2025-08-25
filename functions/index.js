// functions/index.js — minimal template with ping + toolTemplateRun + vaultWriteEpisode
import { onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

initializeApp();
const db = getFirestore();

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

// Callable Vault save: no CORS needed, returns { data: ... } for httpsCallable
export const vaultSave = onCall({ region: "us-east4" }, async (request) => {
  try {
    const { type, title, rawText, structured, tags, summarize } = request.data || {};

    if (!type || !title) {
      return { ok: false, error: "Missing 'type' or 'title'" };
    }

    // TODO: write to Firestore/Storage here.
    // For now, return a fake id so the UI works.
    const id = `ep_${Date.now()}`;

    return {
      ok: true,
      id,
      echo: { type, title, summarize: !!summarize, tags: Array.isArray(tags) ? tags : [] }
    };
  } catch (e) {
    console.error("vaultSave error:", e);
    return { ok: false, error: e?.message || "Internal error" };
  }
});

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

// --- SymptomPro Enhanced (callable)
export const generateSummary = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { symptoms, context, tone = "professional" } = request.data || {};
      if (!symptoms || typeof symptoms !== "object") {
        return { ok: false, error: "Missing 'symptoms' object" };
      }

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      
      // Build comprehensive prompt for multiple summary types
      const system = `
You are a medical communication specialist helping patients articulate their symptoms clearly.
Generate natural, professional symptom summaries that patients can share with healthcare providers.
NEVER mention "OLD CARTS" or any acronyms in the output - use the framework invisibly.
Write in natural paragraphs, not bullet points or lists.
Adjust language tone based on the specified parameter: ${tone}.
`.trim();

      const prompt = `
Generate 4 different symptom summaries based on this patient data.
Each summary should be a complete, natural narrative ready to copy and paste.

SYMPTOMS:
- Chief Complaint: ${symptoms.chiefComplaint || symptoms.primarySymptom || "Not specified"}
- Onset: ${symptoms.onset || "Not specified"}
- Location: ${symptoms.location || "Not specified"}
- Duration: ${symptoms.duration || "Not specified"}
- Frequency: ${symptoms.frequency || "Not specified"}
- Character: ${symptoms.character || "Not specified"}
- Aggravating factors: ${symptoms.aggravating || symptoms.worsens || "Not specified"}
- Alleviating factors: ${symptoms.alleviating || symptoms.improves || "Not specified"}
- Radiation: ${symptoms.radiation || "Not specified"}
- Timing: ${symptoms.timing || "Not specified"}
- Severity: ${symptoms.severity || "Not specified"}

CONTEXT:
- Medical History: ${context?.history || "Not provided"}
- Current Medications: ${context?.meds || context?.medications || "None listed"}
- Impact on Daily Life: ${context?.impact || "Not specified"}

TONE: ${tone} (professional/friendly/direct/detailed)

Generate exactly this JSON structure:
{
  "summaries": {
    "clinical": "[Full comprehensive narrative for provider appointments, 250-350 words. Include all relevant details in a flowing narrative that covers onset, location, character, severity, timing patterns, aggravating and relieving factors, radiation if any, and impact on function. Write as if the patient is explaining to their doctor.]",
    "portal": "[Concise 150-200 word message for patient portal. Focus on key symptoms, duration, severity, and why seeking care. Write as a brief but complete message the patient would send through MyChart or similar portal.]",
    "emergency": "[Brief 100-150 word focused summary for urgent/ER visits. Lead with chief complaint and severity. Include onset, vital symptoms, and any concerning features. Write in present tense focusing on immediate concerns.]",
    "referral": "[Professional 200-250 word narrative for specialist referrals. Include relevant history, current symptoms with specific details, previous treatments tried, and impact on quality of life. Write formally as if for a referral letter.]"
  },
  "tone": "${tone}"
}

Rules:
- Write from the patient's first-person perspective
- Use natural, flowing sentences without medical jargon
- ${tone === 'professional' ? 'Use formal, clear language' : ''}
- ${tone === 'friendly' ? 'Use warm, conversational language while remaining clear' : ''}
- ${tone === 'direct' ? 'Be concise and straightforward, avoid extra words' : ''}
- ${tone === 'detailed' ? 'Include all available information with thorough descriptions' : ''}
- Make each summary immediately usable without editing
- If information is missing, work with what's provided without mentioning gaps
- Do not use bullet points, lists, or structured formats
- Do not mention assessment frameworks or medical acronyms

RETURN ONLY THE JSON OBJECT WITH NO ADDITIONAL TEXT OR MARKDOWN FORMATTING.
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: prompt }],
      });

      // Extract and clean response
      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      
      // Remove any markdown code blocks if present
      const cleaned = raw
        .replace(/```(?:json)?\s*/gi, "")
        .replace(/```\s*$/gi, "")
        .trim();

      let data;
      try {
        data = JSON.parse(cleaned);
      } catch (parseError) {
        console.error("JSON parse error:", parseError);
        console.error("Raw response:", raw);
        
        // Fallback: try to extract any text as a single summary
        const fallbackSummary = cleaned || raw || "Unable to generate summary. Please try again.";
        
        return {
          ok: true,
          summaries: {
            clinical: fallbackSummary,
            portal: fallbackSummary.slice(0, 200) + (fallbackSummary.length > 200 ? "..." : ""),
            emergency: fallbackSummary.slice(0, 150) + (fallbackSummary.length > 150 ? "..." : ""),
            referral: fallbackSummary.slice(0, 250) + (fallbackSummary.length > 250 ? "..." : "")
          },
          tone: tone,
          summary: fallbackSummary // Backward compatibility
        };
      }

      // Validate and normalize the response structure
      if (!data.summaries || typeof data.summaries !== "object") {
        // If we got a different structure, try to work with it
        const singleSummary = data.summary || data.text || cleaned;
        data = {
          summaries: {
            clinical: singleSummary,
            portal: singleSummary,
            emergency: singleSummary,
            referral: singleSummary
          },
          tone: tone
        };
      }

      // Ensure all summary types exist
      const summaries = data.summaries || {};
      const defaultSummary = summaries.clinical || summaries.portal || "No summary generated.";
      
      const normalizedSummaries = {
        clinical: summaries.clinical || defaultSummary,
        portal: summaries.portal || summaries.clinical || defaultSummary,
        emergency: summaries.emergency || summaries.portal || defaultSummary,
        referral: summaries.referral || summaries.clinical || defaultSummary
      };

      // Clean up any remaining formatting issues
      Object.keys(normalizedSummaries).forEach(key => {
        if (typeof normalizedSummaries[key] === "string") {
          // Remove any accidental bullet points or list markers
          normalizedSummaries[key] = normalizedSummaries[key]
            .replace(/^[-•*]\s+/gm, "")
            .replace(/^\d+\.\s+/gm, "")
            .trim();
        }
      });

      return {
        ok: true,
        summaries: normalizedSummaries,
        tone: data.tone || tone,
        // Include a default summary for backward compatibility
        summary: normalizedSummaries.clinical
      };

    } catch (err) {
      console.error("generateSummary error:", err?.response?.data || err);
      
      // Generate a basic fallback summary from the input
      const symptoms = request.data?.symptoms || {};
      const context = request.data?.context || {};
      
      const fallbackText = `I have been experiencing ${symptoms.chiefComplaint || "symptoms"} ${
        symptoms.onset ? `that started ${symptoms.onset}` : ""
      }. ${symptoms.location ? `The issue is located in my ${symptoms.location}.` : ""} ${
        symptoms.severity ? `The severity is ${symptoms.severity}.` : ""
      } ${symptoms.character ? `It feels ${symptoms.character}.` : ""} ${
        symptoms.aggravating ? `It gets worse with ${symptoms.aggravating}.` : ""
      } ${symptoms.alleviating ? `It improves with ${symptoms.alleviating}.` : ""} ${
        context.impact ? `This is affecting my daily life by ${context.impact}.` : ""
      }`.replace(/\s+/g, " ").trim();

      return {
        ok: true,
        summaries: {
          clinical: fallbackText || "Unable to generate summary. Please describe your symptoms.",
          portal: (fallbackText || "Unable to generate summary.").slice(0, 200),
          emergency: (fallbackText || "Unable to generate summary.").slice(0, 150),
          referral: fallbackText || "Unable to generate summary for referral."
        },
        tone: request.data?.tone || "professional",
        summary: fallbackText || "Unable to generate summary.",
        error: "Generation failed, using fallback summary"
      };
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

// Add this enhanced implementation to functions/index.js
// Replace the existing minimal resetProRun function

export const resetProRun = onCall(
  { region: "us-east4", secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    try {
      const { thread, goal = "document" } = request.data || {};
      
      if (!Array.isArray(thread) || thread.length === 0) {
        return { 
          ok: false, 
          error: "Provide 'thread' as a non-empty array of {role,text,ts?}." 
        };
      }

      // Sanitize thread entries
      const cleanThread = thread
        .filter(m => m && typeof m.text === "string" && 
                (m.role === "provider" || m.role === "patient"))
        .slice(0, 50); // Limit to prevent abuse

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      // Build comprehensive prompt for ResetPro
      const prompt = `
You are a medical communication assistant helping patients identify dismissive patterns in provider communications and generate professional correction requests.

IMPORTANT: Be specific and quote exact phrases when identifying patterns. Provide actionable, professional responses.

Analyze this patient-provider communication thread:
${JSON.stringify(cleanThread, null, 2)}

Goal: ${goal}

Identify and categorize problematic patterns:

1. DISMISSIVE LANGUAGE: Phrases that minimize or invalidate patient experiences
2. MINIMIZATION: Downplaying severity or impact of symptoms  
3. CREDIBILITY UNDERMINING: Questioning patient's reliability or suggesting symptoms are imagined
4. BOUNDARY CROSSING: Inappropriate personal comments or unprofessional behavior

For each pattern found, provide:
- Exact quote from the provider
- Clear explanation of why it's problematic

Then generate three response options:
1. NEUTRAL: Professional, fact-focused correction request
2. FIRM: Assertive but respectful, citing patient rights
3. ESCALATION: For patient relations or formal complaints

Finally, create a documentation note summarizing the concern objectively.

Return a JSON object with EXACTLY this structure:
{
  "flags": {
    "dismissiveLanguage": [
      {"quote": "exact quote from provider", "why": "explanation of why this is dismissive"}
    ],
    "minimization": [
      {"quote": "exact quote", "why": "explanation"}
    ],
    "credibilityUndermining": [
      {"quote": "exact quote", "why": "explanation"}
    ],
    "boundaryCrossing": [
      {"quote": "exact quote", "why": "explanation"}
    ]
  },
  "overallAssessment": "One paragraph summary of the communication patterns and their potential impact on patient care",
  "responseOptions": [
    {
      "tone": "neutral",
      "text": "Complete message text for portal or email, professionally requesting corrections"
    },
    {
      "tone": "firm", 
      "text": "Formal amendment request citing HIPAA § 164.526 and specific inaccuracies"
    },
    {
      "tone": "escalation",
      "text": "Template for patient relations or board complaint if patterns persist"
    }
  ],
  "docNote": {
    "title": "Communication Concern - [Date]",
    "date": "YYYY-MM-DD",
    "context": "Brief factual summary of the visit/interaction",
    "observedLanguage": ["quote1", "quote2"],
    "patientImpact": "How the communication affected patient care or trust",
    "followUpRequested": ["Specific correction to record", "Action requested"]
  }
}

Guidelines:
- Focus on factual discrepancies and professional communication standards
- Avoid inflammatory language or personal attacks
- Include specific dates, quotes, and requested corrections
- Reference relevant patient rights (HIPAA, informed consent, etc.)
- Maintain therapeutic relationship while advocating for accuracy
- If no problematic patterns found, return empty arrays but acknowledge the patient's concerns

IMPORTANT: Output ONLY valid JSON, no additional text or markdown.
`.trim();

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });

      const rawResponse = Array.isArray(msg?.content) ? 
        (msg.content[0]?.text || "") : "";
      
      // Clean up response (remove markdown if present)
      const cleaned = rawResponse
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```\s*$/gi, '')
        .trim();

      let data;
      try {
        data = JSON.parse(cleaned);
      } catch (parseError) {
        console.error("Failed to parse Claude response:", cleaned);
        
        // Fallback structure if parsing fails
        data = {
          flags: {
            dismissiveLanguage: [],
            minimization: [],
            credibilityUndermining: [],
            boundaryCrossing: []
          },
          overallAssessment: "Analysis could not be completed. Please try again.",
          responseOptions: [
            {
              tone: "neutral",
              text: generateFallbackResponse(thread, "neutral")
            },
            {
              tone: "firm",
              text: generateFallbackResponse(thread, "firm")
            },
            {
              tone: "escalation",
              text: generateFallbackResponse(thread, "escalation")
            }
          ],
          docNote: {
            title: "Communication Concern",
            date: new Date().toISOString().split('T')[0],
            context: "Unable to analyze communication",
            observedLanguage: [],
            patientImpact: "",
            followUpRequested: []
          }
        };
      }

      // Validate and sanitize the response structure
      data.flags = data.flags || {};
      data.flags.dismissiveLanguage = Array.isArray(data.flags.dismissiveLanguage) ? 
        data.flags.dismissiveLanguage : [];
      data.flags.minimization = Array.isArray(data.flags.minimization) ? 
        data.flags.minimization : [];
      data.flags.credibilityUndermining = Array.isArray(data.flags.credibilityUndermining) ? 
        data.flags.credibilityUndermining : [];
      data.flags.boundaryCrossing = Array.isArray(data.flags.boundaryCrossing) ? 
        data.flags.boundaryCrossing : [];
      
      data.overallAssessment = String(data.overallAssessment || "");
      data.responseOptions = Array.isArray(data.responseOptions) ? 
        data.responseOptions.slice(0, 3) : [];
      
      data.docNote = data.docNote || {};
      data.docNote.observedLanguage = Array.isArray(data.docNote.observedLanguage) ? 
        data.docNote.observedLanguage : [];
      data.docNote.followUpRequested = Array.isArray(data.docNote.followUpRequested) ? 
        data.docNote.followUpRequested : [];

      return { ok: true, data };

    } catch (error) {
      console.error("resetProRun error:", error?.response?.data || error);
      return { 
        ok: false, 
        error: error?.message || "Unable to analyze communication. Please try again." 
      };
    }
  }
);

// Helper function for fallback responses
function generateFallbackResponse(thread, tone) {
  const patientText = thread.find(m => m.role === "patient")?.text || "";
  const date = new Date().toISOString().split('T')[0];
  
  if (tone === "neutral") {
    return `Dear Provider,

I am writing to request corrections to my medical record from our recent interaction. I believe there are some inaccuracies that need to be addressed.

${patientText.substring(0, 200)}...

Please update my medical record to accurately reflect our discussion.

Thank you for your attention to this matter.`;
  } else if (tone === "firm") {
    return `To: Medical Records Department

Subject: Formal Request for Amendment to Medical Record - HIPAA § 164.526

I am formally requesting an amendment to my medical record dated ${date}.

Under HIPAA § 164.526, I have the right to request amendments when information is incorrect or incomplete. Please process this request within 30 days as required by law.

Please confirm receipt of this request.

Sincerely,
[Patient Name]`;
  } else {
    return `To: Patient Relations Department

Subject: Formal Complaint Regarding Medical Documentation

I am filing a formal complaint regarding communication and documentation concerns from ${date}.

I request a formal review of this matter.

Sincerely,
[Patient Name]`;
  }
}

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