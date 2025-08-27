// functions/index.js
import { onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

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
      const { 
        mode = 'practice',  // practice, simulate, live, debrief
        thread = [],        // conversation history
        context = {},       // symptoms, goals, conditions, etc.
        persona = 'pcp_rushed', // provider personality
        coachingLevel = 'light', // light or deep
        visitTime = 10      // visit length in minutes
      } = request.data || {};

      // Validate thread
      if (!Array.isArray(thread) || thread.length === 0) {
        return { 
          ok: false, 
          error: "Provide 'thread' as array with at least one message" 
        };
      }

      // Clean thread entries
      const cleanThread = thread
        .filter(m => m && typeof m.text === "string" && 
                (m.speaker === "patient" || m.speaker === "provider"))
        .slice(0, 50); // Limit for context window

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

      // Build persona descriptions
      const personas = {
        pcp_rushed: "Primary care doctor who is running 45 minutes behind, has 7 minutes for this visit, interrupts frequently, and defaults to 'wait and see' approaches. Often suggests anxiety or lifestyle changes before testing.",
        specialist_thorough: "Subspecialist who asks detailed questions, takes methodical notes, but is bound by insurance criteria and institutional protocols. Open to discussion but needs evidence.",
        gatekeeper: "Provider who strictly follows guidelines, frequently cites insurance requirements, defensive about referrals, tends to minimize symptoms that don't fit clear diagnostic criteria.",
        kind_dismissive: "Warm and friendly doctor who genuinely cares but unconsciously minimizes chronic/invisible illness. Uses phrases like 'you look healthy' and 'have you tried yoga?'"
      };

      // Build coaching depth instructions
      const coachingInstructions = coachingLevel === 'deep' ? `
Provide DETAILED coaching with:
- Specific language rewrites with exact phrasing
- Tone and delivery notes (pace, pauses, emphasis)
- Body language and nonverbal communication tips  
- Psychological tactics (validation, mirroring, authority citing)
- Evidence integration strategies
- Power dynamic management
- Alternative approaches if first attempt fails
- Rights-based language when appropriate
` : `
Provide LIGHT coaching with:
- Simple, actionable tips (2-3 key points)
- One suggested rephrase if needed
- Basic timing reminder
- Single follow-up question to ask
`;

      const systemPrompt = `You are a medical communication coach helping patients practice conversations with healthcare providers.

CURRENT SCENARIO:
- Provider persona: ${personas[persona] || personas.pcp_rushed}
- Visit time: ${visitTime} minutes total
- Coaching level: ${coachingLevel}
- Mode: ${mode}

SAFETY RULES:
- Never provide medical advice or treatment recommendations
- Never suggest dishonesty or exaggeration
- Never name specific medications or dosages
- Focus only on communication techniques and structure

APPOINTMENT LEADERSHIP PRINCIPLES:
1. Agenda-setting: State purpose and top 2 priorities within 90 seconds
2. Evidence-based: Reference specific symptoms, timelines, and impacts
3. Criteria-seeking: Ask "What findings would indicate need for [test/referral]?"
4. Decision-focus: Every question should aim for a decision or action
5. Safety-netting: Confirm return precautions and follow-up timeline
6. Documentation: Request specific notes in chart

${coachingInstructions}

RESPONSE FORMAT:
Always return valid JSON with this structure:
{
  "providerResponse": "What the provider says next based on persona",
  "pushbackType": "none|time|anxiety|policy|skeptical|deflection",
  "coaching": {
    "immediate": ["Real-time tip for this moment"],
    "whatWorked": ["What the patient did well"],
    "improvements": ["Specific things to improve"],
    "techniques": ["Communication techniques to try"],
    "timing": "Time check: X minutes used, Y remaining"
  },
  "responseOptions": [
    {
      "label": "Acknowledge & Redirect",
      "text": "I hear your concern about X. However, I'm experiencing Y which affects Z...",
      "strategy": "Validates provider while maintaining focus"
    },
    {
      "label": "Evidence-Based Counter",
      "text": "According to my symptom diary from the past 3 months...",
      "strategy": "Uses objective data to support need"
    },
    {
      "label": "Criteria Question", 
      "text": "What specific findings or thresholds would indicate the need for...",
      "strategy": "Shifts from whether to when"
    }
  ],
  "nextTurnPrompt": "Hint for next exchange",
  "appointmentProgress": {
    "minutesElapsed": 3,
    "minutesRemaining": 7,
    "agendaItemsCovered": 1,
    "agendaItemsRemaining": 2,
    "goalsAchieved": []
  },
  "metadata": {
    "pushbackIntensity": 1-5,
    "collaborationLevel": 1-5,
    "patientConfidence": 1-5,
    "progressTowardGoal": "0-100%"
  }
}`;

      const userPrompt = `CONVERSATION THREAD:
${JSON.stringify(cleanThread, null, 2)}

PATIENT CONTEXT:
- Symptoms: ${context.symptoms || "Not specified"}
- Goals: ${context.goals || "Get help with symptoms"}
- Conditions: ${context.conditions?.join(", ") || "None specified"}
- Previous attempts: ${context.previousAttempts || "None mentioned"}

TASK: Generate the next provider response based on the ${persona} persona, then provide ${coachingLevel} coaching to help the patient navigate this conversation effectively.

The patient needs coaching on:
1. How to respond to the provider's statement
2. How to keep the conversation productive
3. How to work toward their stated goals
4. How to handle any dismissiveness or pushback

Remember: ${visitTime} minute visit, currently ${Math.min(cleanThread.length * 2, visitTime-2)} minutes in.`;

      const msg = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      });

      // Parse Claude's response
      const raw = Array.isArray(msg?.content) ? (msg.content[0]?.text || "") : "";
      const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();

      let data;
      try { 
        data = JSON.parse(cleaned);
      } catch {
        // Fallback structure if parsing fails
        data = {
          providerResponse: generateCoachingFallbackResponse(persona, cleanThread),
          pushbackType: "time",
          coaching: {
            immediate: ["Stay focused on your main concern"],
            whatWorked: ["Clear symptom description"],
            improvements: ["Be more specific about timeline"],
            techniques: ["Use 'Yes, and...' to acknowledge while redirecting"],
            timing: `Time check: ${Math.min(cleanThread.length * 2, visitTime-2)} minutes used, ${Math.max(2, visitTime - cleanThread.length * 2)} remaining`
          },
          responseOptions: [
            {
              label: "Acknowledge time pressure",
              text: "I understand you're running behind. Let me focus on my main concern...",
              strategy: "Shows respect for constraints"
            },
            {
              label: "Ask for specific next step",
              text: "Given the time, what's the one most important test we should start with?",
              strategy: "Forces prioritization"
            },
            {
              label: "Request follow-up",
              text: "Can we schedule a longer appointment to properly address this?",
              strategy: "Acknowledges limitations"
            }
          ],
          nextTurnPrompt: "Make your primary ask before time runs out",
          appointmentProgress: {
            minutesElapsed: Math.min(cleanThread.length * 2, visitTime-2),
            minutesRemaining: Math.max(2, visitTime - cleanThread.length * 2),
            agendaItemsCovered: Math.floor(cleanThread.length / 4),
            agendaItemsRemaining: 2,
            goalsAchieved: []
          },
          metadata: {
            pushbackIntensity: 3,
            collaborationLevel: 2,
            patientConfidence: 3,
            progressTowardGoal: "25%"
          }
        };
      }

      // Ensure arrays are properly formatted
      const ensureArray = (val) => Array.isArray(val) ? val : [];
      
      data.coaching = data.coaching || {};
      data.coaching.immediate = ensureArray(data.coaching.immediate);
      data.coaching.whatWorked = ensureArray(data.coaching.whatWorked);
      data.coaching.improvements = ensureArray(data.coaching.improvements);
      data.coaching.techniques = ensureArray(data.coaching.techniques);
      
      data.responseOptions = ensureArray(data.responseOptions).slice(0, 3);

      // Add mode-specific enhancements
      if (mode === 'debrief') {
        data.debriefReport = generateCoachDebriefReport(cleanThread, context);
      }

      return { 
        ok: true, 
        data: data,
        mode: mode,
        sessionId: `coach_${Date.now()}`
      };

    } catch (error) {
      console.error("promptCoachRun error:", error?.response?.data || error);
      return { 
        ok: false, 
        error: error?.message || "Unable to generate coaching response" 
      };
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
// functions/index.js - Add this new function
export const checkToolAccess = onCall(
  { region: "us-east4" },
  async (request) => {
    try {
      const { toolId } = request.data;
      const uid = request.auth?.uid || null;
      
      // Get user subscription data
      let subscription = { tier: 'free', limits: { daily: 3, monthly: 20 } };
      
      if (uid) {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          subscription = userData.subscription || subscription;
        }
      }
      
      // Check if tool is accessible based on tier
      const toolTiers = {
        'symptomPro': ['core_patient', 'advanced_patient', 'clinic_lite', 'clinic_pro'],
        'resetPro': ['advanced_patient', 'clinic_pro'],
        'appealBuilder': ['advanced_patient', 'clinic_pro'],
        // ... add all tools
      };
      
      const allowedTiers = toolTiers[toolId] || ['clinic_pro'];
      const hasAccess = allowedTiers.includes(subscription.tier) || subscription.tier === 'clinic_pro';
      
      if (!hasAccess) {
        return {
          allowed: false,
          reason: 'tier_required',
          currentTier: subscription.tier,
          requiredTiers: allowedTiers
        };
      }
      
      // Check usage limits
      const today = new Date().toISOString().substring(0, 10);
      const usageDoc = await db.collection('usage').doc(`${uid}_${today}`).get();
      const usage = usageDoc.exists ? usageDoc.data() : { count: 0 };
      
      if (usage.count >= subscription.limits.daily) {
        const now = new Date();
        const midnight = new Date();
        midnight.setDate(midnight.getDate() + 1);
        midnight.setHours(0, 0, 0, 0);
        const hoursLeft = Math.floor((midnight - now) / (1000 * 60 * 60));
        const minutesLeft = Math.floor(((midnight - now) % (1000 * 60 * 60)) / (1000 * 60));
        
        return {
          allowed: false,
          reason: 'limit_reached',
          dailyLimit: subscription.limits.daily,
          currentUsage: usage.count,
          resetTime: `${hoursLeft}h ${minutesLeft}m`,
          currentTier: subscription.tier
        };
      }
      
      // Update usage count
      await db.collection('usage').doc(`${uid}_${today}`).set({
        count: usage.count + 1,
        lastUsed: Date.now()
      }, { merge: true });
      
      return {
        allowed: true,
        currentTier: subscription.tier,
        remainingToday: subscription.limits.daily - usage.count - 1
      };
      
    } catch (error) {
      console.error('checkToolAccess error:', error);
      return { 
        allowed: true, // Fail open
        error: error.message 
      };
    }
  }
);
// Add these to functions/index.js

export const getUserDashboardData = onCall(
  { region: "us-east4" },
  async (request) => {
    const { uid } = request.data;
    // Return user subscription, tier, limits, trial status
  }
);

export const getUserUsage = onCall(
  { region: "us-east4" },
  async (request) => {
    const { uid } = request.data;
    // Return daily/monthly usage stats
  }
);

export const getUserUsageHistory = onCall(
  { region: "us-east4" },
  async (request) => {
    const { uid, limit = 10 } = request.data;
    // Return recent tool usage history
  }
);

export const getUsageChartData = onCall(
  { region: "us-east4" },
  async (request) => {
    const { period } = request.data;
    // Return chart data for week/month/year
  }
);
// Import stripe functions and wrap them
import * as stripeFunctions from './stripe.js';

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

export const createCheckoutSession = onCall(
  { region: "us-east4", secrets: [STRIPE_SECRET_KEY] },
  stripeFunctions.createCheckoutSession
);

export const stripeWebhook = onRequest(
  { region: "us-east4", secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  stripeFunctions.stripeWebhook
);

export const checkSubscription = onCall(
  { region: "us-east4" },
  stripeFunctions.checkSubscription
);
// Add this to your functions/index.js file

export const promptProRun = onCall(
  { 
    region: "us-east4",
    secrets: [ANTHROPIC_API_KEY]
  },
  async (request) => {
    try {
      const { symptoms, context, visit_time_min = 10, ui_prefs } = request.data;
      
      if (!symptoms) {
        throw new Error("Symptoms are required");
      }
      
      const anthropic = new Anthropic({
        apiKey: ANTHROPIC_API_KEY.value()
      });
      
      // Build the compose prompt
      const composeSystemPrompt = `You are PromptPro, a clinical communication planner that converts symptoms into concise, bias-aware questions for clinicians. You never diagnose or recommend specific treatments. You produce questions that clarify decisions, criteria, next steps, and safety. Prefer plain language. Tie each question to a one-line why with a citation label if available. Respect time limits. If the user provides meds or comorbidities, avoid risky phrasing and focus on decision-relevant questions. Output structured JSON using the provided schema.`;
      
      const composeUserPrompt = `
Patient symptoms: ${symptoms}
Context:
- Conditions: ${context.conditions?.join(', ') || 'None specified'}
- Medications: ${context.meds?.join(', ') || 'None specified'}
- Allergies: ${context.allergies?.join(', ') || 'None specified'}
- Key findings or logs: ${context.key_findings || 'None'}
Patient goals for this visit: ${context.goals || 'Not specified'}
Visit time available: ${visit_time_min} minutes
Requested specialty context: ${context.specialty || 'auto'}
Selected pack (optional): ${context.pack || 'none'}
Preferences: reading_level=${ui_prefs?.reading_level || 'standard'}, tone=${ui_prefs?.tone || 'neutral'}, brain_fog_mode=${ui_prefs?.brain_fog_mode || false}

Tasks:
1) Draft a 90-second opener that is objective and functional-impact oriented.
2) Generate question candidates across categories: diagnostic_clarity, testing, treatment_options, safety_netting, process_access.
3) For each question provide: text, why (≤ 20 words), category, priority (1 highest), ask_time_sec estimate, bias_safe flag, and zero to two citation labels.
4) Rank to fit the time limit. Build intro_90s, core_5min, close_60s blocks. Add a safety-net checklist.
5) Produce two follow-up rules for likely clinician replies.
6) Provide a short portal message seed for unanswered items.

Return exactly this JSON structure:
{
  "opener": "string - 90 second opener script",
  "priority_blocks": {
    "intro_90s": [
      {
        "id": "q1",
        "text": "question text",
        "why": "brief reason",
        "category": "diagnostic_clarity|testing|treatment_options|safety_netting|process_access",
        "priority": 1,
        "ask_time_sec": 25,
        "citation_ids": ["c1"],
        "bias_safe": true,
        "phrasing_variants": ["alternative phrasing"]
      }
    ],
    "core_5min": [],
    "close_60s": []
  },
  "categories": {
    "diagnostic_clarity": [],
    "testing": [],
    "treatment_options": [],
    "safety_netting": [],
    "process_access": []
  },
  "timeline": [
    {
      "label": "Opening",
      "start_sec": 0,
      "end_sec": 90,
      "question_ids": ["q1"]
    }
  ],
  "citations": [
    {
      "id": "c1",
      "label": "citation label",
      "year": 2024,
      "source": "guideline|review|trial",
      "url": "https://...",
      "strength": "high|moderate|emerging"
    }
  ],
  "followups": [
    {
      "if_phrase": "let's watch and wait",
      "then_questions": ["q3"]
    }
  ],
  "pack_used": "${context.pack || null}",
  "safety_net": [
    "safety checklist item 1",
    "safety checklist item 2"
  ],
  "portal_message_seed": "template for portal follow-up",
  "metadata": {
    "specialty": "pcp|specialist|ed",
    "confidence": 0.75,
    "created_at": "${new Date().toISOString()}",
    "model": "claude-3"
  }
}

Return JSON only, no other text.`;
      
      // Step 1: Compose questions
      const composeResponse = await anthropic.messages.create({
        model: "claude-3-opus-20240229",
        max_tokens: 4000,
        system: composeSystemPrompt,
        messages: [{
          role: "user",
          content: composeUserPrompt
        }]
      });
      
      let questionsData;
      try {
        const responseText = composeResponse.content[0].text;
        // Clean any markdown formatting if present
        const cleanedText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        questionsData = JSON.parse(cleanedText);
      } catch (parseError) {
        console.error("Parse error:", parseError);
        // Return fallback structure
        questionsData = generateFallbackQuestions(symptoms, context, visit_time_min);
      }
      
      // Step 2: Apply ranking (simplified for now - could be another AI call)
      questionsData = applyRanking(questionsData, visit_time_min);
      
      // Enhance with pack-specific questions if selected
      if (context.pack) {
        questionsData = enhanceWithPack(questionsData, context.pack);
      }
      
      // Add safety banner
      questionsData.safety_banner = "Communication support only. No diagnosis or treatment advice.";
      
      return questionsData;
      
    } catch (error) {
      console.error("promptProRun error:", error);
      throw new Error(`Failed to generate questions: ${error.message}`);
    }
  }
);

// Helper function to apply time-based ranking
function applyRanking(data, timeLimit) {
  // Calculate total time budget in seconds
  const totalSeconds = timeLimit * 60;
  
  // Allocate time blocks
  const intro_budget = 90; // 90 seconds
  const close_budget = 60; // 60 seconds
  const core_budget = Math.max(totalSeconds - intro_budget - close_budget, 180); // At least 3 minutes
  
  // Ensure we have the right number of questions in each block
  if (data.priority_blocks) {
    // Limit intro questions
    if (data.priority_blocks.intro_90s && data.priority_blocks.intro_90s.length > 2) {
      data.priority_blocks.intro_90s = data.priority_blocks.intro_90s.slice(0, 2);
    }
    
    // Limit core questions based on time
    if (data.priority_blocks.core_5min) {
      const maxCoreQuestions = Math.floor(core_budget / 30); // ~30 seconds per question
      if (data.priority_blocks.core_5min.length > maxCoreQuestions) {
        data.priority_blocks.core_5min = data.priority_blocks.core_5min.slice(0, maxCoreQuestions);
      }
    }
    
    // Limit close questions
    if (data.priority_blocks.close_60s && data.priority_blocks.close_60s.length > 2) {
      data.priority_blocks.close_60s = data.priority_blocks.close_60s.slice(0, 2);
    }
  }
  
  return data;
}

// Helper function to enhance with condition-specific pack
function enhanceWithPack(data, packName) {
  const packQuestions = getPackQuestions(packName);
  
  if (packQuestions && data.priority_blocks) {
    // Add pack-specific questions to core block
    if (data.priority_blocks.core_5min) {
      data.priority_blocks.core_5min.push(...packQuestions);
    }
  }
  
  data.pack_used = packName;
  
  return data;
}

// Get pack-specific questions
function getPackQuestions(packName) {
  const packs = {
    pots: [
      {
        id: "pots1",
        text: "Can we capture orthostatic vitals today and repeat if borderline?",
        why: "Documents objective change and guides next steps",
        category: "diagnostic_clarity",
        priority: 1,
        ask_time_sec: 30,
        citation_ids: ["c_pots1"],
        bias_safe: true
      },
      {
        id: "pots2",
        text: "What non-pharmacological strategies should I try first, and how long before expecting improvement?",
        why: "Establishes conservative management timeline",
        category: "treatment_options",
        priority: 2,
        ask_time_sec: 25,
        citation_ids: ["c_pots2"],
        bias_safe: true
      }
    ],
    heds: [
      {
        id: "heds1",
        text: "Which joints show hypermobility on Beighton scoring, and should we document this today?",
        why: "Objective criteria for diagnosis",
        category: "diagnostic_clarity",
        priority: 1,
        ask_time_sec: 40,
        citation_ids: ["c_heds1"],
        bias_safe: true
      }
    ],
    mcas: [
      {
        id: "mcas1",
        text: "What baseline tryptase level would suggest mast cell involvement, and when should we test?",
        why: "Establishes diagnostic threshold",
        category: "testing",
        priority: 1,
        ask_time_sec: 25,
        citation_ids: ["c_mcas1"],
        bias_safe: true
      }
    ],
    "long-covid": [
      {
        id: "lc1",
        text: "Which post-COVID symptoms meet criteria for long COVID diagnosis, and what documentation do we need?",
        why: "Ensures proper coding and treatment access",
        category: "diagnostic_clarity",
        priority: 1,
        ask_time_sec: 30,
        citation_ids: ["c_lc1"],
        bias_safe: true
      }
    ]
  };
  
  return packs[packName] || [];
}

// Fallback question generation if AI fails
function generateFallbackQuestions(symptoms, context, timeLimit) {
  const firstSymptom = symptoms.split('.')[0] || symptoms.substring(0, 100);
  
  return {
    opener: `I'm experiencing ${firstSymptom}. This has been affecting my daily activities and I'd like to understand what's happening and discuss next steps.`,
    priority_blocks: {
      intro_90s: [
        {
          id: "fb1",
          text: "What are the most likely causes of these symptoms based on my history?",
          why: "Establishes differential diagnosis",
          category: "diagnostic_clarity",
          priority: 1,
          ask_time_sec: 30,
          citation_ids: [],
          bias_safe: true
        }
      ],
      core_5min: [
        {
          id: "fb2",
          text: "What tests would help narrow down the diagnosis?",
          why: "Clarifies diagnostic pathway",
          category: "testing",
          priority: 1,
          ask_time_sec: 25,
          citation_ids: [],
          bias_safe: true
        },
        {
          id: "fb3",
          text: "What initial treatment options are available while we investigate?",
          why: "Addresses symptom management",
          category: "treatment_options",
          priority: 2,
          ask_time_sec: 30,
          citation_ids: [],
          bias_safe: true
        }
      ],
      close_60s: [
        {
          id: "fb4",
          text: "What symptoms would require urgent evaluation before our next visit?",
          why: "Establishes safety plan",
          category: "safety_netting",
          priority: 1,
          ask_time_sec: 20,
          citation_ids: [],
          bias_safe: true
        }
      ]
    },
    categories: {
      diagnostic_clarity: [],
      testing: [],
      treatment_options: [],
      safety_netting: [],
      process_access: []
    },
    timeline: [],
    citations: [],
    followups: [],
    pack_used: context.pack || null,
    safety_net: [
      "Clarify when to seek urgent care",
      "Document today's findings",
      "Schedule follow-up if symptoms persist"
    ],
    portal_message_seed: "Following up on our visit, I have additional questions about my symptoms and next steps.",
    metadata: {
      specialty: context.specialty || "auto",
      confidence: 0.5,
      created_at: new Date().toISOString(),
      model: "fallback"
    }
  };
}

// Helper function for fallback responses - renamed to avoid conflict
function generateCoachingFallbackResponse(persona, thread) {
  const responses = {
    pcp_rushed: [
      "I understand you're concerned, but we need to focus on one issue today. Have you tried lifestyle modifications?",
      "We're running quite behind. Let's start with basic labs and see you back in 3 months.",
      "That sounds like it could be stress-related. Are you getting enough sleep?",
      "I have about 2 more minutes. What's your most pressing concern?"
    ],
    specialist_thorough: [
      "Tell me more about when these symptoms occur. Any pattern you've noticed?",
      "I'd like to review your previous testing. What evaluations have been done so far?",
      "The symptoms you describe could fit several conditions. Let's be systematic.",
      "Insurance typically requires we document failed conservative treatment first."
    ],
    gatekeeper: [
      "Your insurance requires three months of documented symptoms before that referral.",
      "We don't typically order that test unless criteria are met. Let me check the guidelines.",
      "Have you tried physical therapy? That's the required first step.",
      "I can't justify that to insurance without more objective findings."
    ],
    kind_dismissive: [
      "You look quite healthy to me! Sometimes our bodies just need time to heal.",
      "Have you been under stress lately? That can cause all sorts of symptoms.",
      "At your age, some of this is normal. Have you tried yoga or meditation?",
      "I don't see anything concerning on exam. Maybe try some vitamins?"
    ]
  };

  const personaResponses = responses[persona] || responses.pcp_rushed;
  const turn = Math.min(thread.length, personaResponses.length - 1);
  return personaResponses[turn];
}

// Helper function for debrief report generation - renamed to avoid conflict
function generateCoachDebriefReport(thread, context) {
  const patientMessages = thread.filter(m => m.speaker === 'patient');
  const providerMessages = thread.filter(m => m.speaker === 'provider');
  
  return {
    summary: {
      totalExchanges: thread.length,
      patientTurns: patientMessages.length,
      providerTurns: providerMessages.length,
      estimatedDuration: `${Math.min(thread.length * 2, 15)} minutes`
    },
    strengths: [
      "Clear initial symptom description",
      "Maintained professional tone",
      "Asked at least one clarifying question"
    ],
    improvements: [
      "State your main ask within first 90 seconds",
      "Prepare specific evidence (dates, measurements)",
      "Practice the 'broken record' technique for key requests"
    ],
    keyPhrases: {
      effective: [
        "My primary concern today is...",
        "What criteria would indicate...",
        "Can we document that..."
      ],
      avoid: [
        "Sorry to bother you...",
        "I know you're busy but...",
        "It's probably nothing..."
      ]
    },
    nextSteps: [
      "Practice with 'specialist_thorough' persona",
      "Prepare a one-page symptom summary",
      "Role-play with timer set to actual appointment length"
    ],
    portalTemplate: `Dear Dr. [Name],

Thank you for our discussion today about ${context.symptoms || 'my symptoms'}.

As we discussed:
1. Primary concern: [Specific symptom and impact]
2. Requested action: [Test/referral/treatment]
3. Timeline: [When to follow up]

Please confirm receipt and next steps.

Best regards,
[Your name]`
  };
}