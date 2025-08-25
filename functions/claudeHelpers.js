// functions/lib/claudeHelpers.js
// Shared utilities for all PatientLead+ tools using Claude AI

import { getFirestore } from "firebase-admin/firestore";

const db = getFirestore();

// Configuration
export const claudeConfig = {
  model: "claude-sonnet-4-20250514",
  defaultMaxTokens: 1500,
  temperature: 0.7,
  retryAttempts: 2,
  retryDelay: 1000
};

// JSON cleaning and parsing
export function cleanJSON(text) {
  if (!text) return "";
  return text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*$/gi, '')
    .replace(/^[^{[]*/, '') // Remove any text before JSON
    .replace(/[^}\]]*$/, '') // Remove any text after JSON
    .trim();
}

export function parseJSONSafely(text, fallback = {}) {
  try {
    const cleaned = cleanJSON(text);
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("JSON parse failed:", text?.substring(0, 200));
    return fallback;
  }
}

// Prompt builders
export function buildSystemPrompt(role, options = {}) {
  const base = `You are a ${role} assistant for PatientLead+, helping patients with healthcare advocacy.`;
  const rules = [
    "Always return valid JSON without markdown formatting",
    "Be specific and actionable in your responses",
    "Use professional medical terminology appropriately",
    "Never provide diagnoses or treatment recommendations",
    "Focus on communication and documentation support"
  ];
  
  if (options.additionalRules) {
    rules.push(...options.additionalRules);
  }
  
  return `${base}\n\nRules:\n${rules.map(r => `- ${r}`).join('\n')}`;
}

// Rate limiting with better UX
const rateLimitCache = new Map();

export async function checkRateLimit(uid, toolName, options = {}) {
  const {
    maxPerHour = 10,
    maxPerDay = 50,
    bypassForPremium = false
  } = options;
  
  if (!uid) uid = "anonymous";
  
  // Check if user is premium (if implemented)
  if (bypassForPremium) {
    const userDoc = await db.collection("users").doc(uid).get();
    if (userDoc.exists && userDoc.data()?.isPremium) {
      return { allowed: true, remaining: 999, resetIn: null };
    }
  }
  
  const now = Date.now();
  const hourKey = `${uid}:${toolName}:hour`;
  const dayKey = `${uid}:${toolName}:day`;
  
  // Check hourly limit
  let hourLimit = rateLimitCache.get(hourKey) || { 
    count: 0, 
    resetAt: now + 3600000 
  };
  
  if (now > hourLimit.resetAt) {
    hourLimit = { count: 0, resetAt: now + 3600000 };
  }
  
  // Check daily limit
  let dayLimit = rateLimitCache.get(dayKey) || { 
    count: 0, 
    resetAt: now + 86400000 
  };
  
  if (now > dayLimit.resetAt) {
    dayLimit = { count: 0, resetAt: now + 86400000 };
  }
  
  // Calculate remaining calls
  const hourlyRemaining = maxPerHour - hourLimit.count;
  const dailyRemaining = maxPerDay - dayLimit.count;
  const remaining = Math.min(hourlyRemaining, dailyRemaining);
  
  if (remaining <= 0) {
    const resetIn = Math.min(
      hourLimit.resetAt - now,
      dayLimit.resetAt - now
    );
    
    return {
      allowed: false,
      remaining: 0,
      resetIn: Math.ceil(resetIn / 60000), // minutes
      message: hourlyRemaining <= 0 
        ? `You've used all ${maxPerHour} analyses this hour. Try again in ${Math.ceil((hourLimit.resetAt - now) / 60000)} minutes.`
        : `You've reached the daily limit of ${maxPerDay} analyses. Reset at midnight.`
    };
  }
  
  // Update counts
  hourLimit.count++;
  dayLimit.count++;
  rateLimitCache.set(hourKey, hourLimit);
  rateLimitCache.set(dayKey, dayLimit);
  
  return {
    allowed: true,
    remaining: remaining - 1,
    resetIn: null,
    message: remaining <= 3 
      ? `${remaining - 1} analyses remaining this hour` 
      : null
  };
}

// Usage tracking and analytics
export async function trackClaudeUsage(toolName, uid, data = {}) {
  try {
    await db.collection("claudeUsage").add({
      tool: toolName,
      uid: uid || "anonymous",
      timestamp: Date.now(),
      date: new Date().toISOString().split('T')[0],
      success: data.success || false,
      error: data.error || null,
      tokensUsed: data.tokensUsed || 0,
      responseTime: data.responseTime || 0,
      retries: data.retries || 0
    });
  } catch (error) {
    console.error("Failed to track usage:", error);
    // Don't throw - tracking failure shouldn't break the tool
  }
}

// Smart retry logic for Claude API
export async function callClaudeWithRetry(client, params, options = {}) {
  const maxAttempts = options.retryAttempts || claudeConfig.retryAttempts;
  const delay = options.retryDelay || claudeConfig.retryDelay;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const startTime = Date.now();
      const response = await client.messages.create(params);
      
      return {
        response,
        metadata: {
          responseTime: Date.now() - startTime,
          attempts: attempt,
          tokensUsed: response.usage?.total_tokens || 0
        }
      };
      
    } catch (error) {
      lastError = error;
      console.error(`Claude API attempt ${attempt} failed:`, error.message);
      
      // Don't retry on certain errors
      if (error.status === 400 || error.status === 401) {
        throw error;
      }
      
      // Wait before retrying
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  
  throw lastError;
}

// Response validation
export function validateResponse(data, requiredFields) {
  const missing = [];
  
  for (const field of requiredFields) {
    if (!data[field]) {
      missing.push(field);
    }
  }
  
  if (missing.length > 0) {
    console.warn("Response missing fields:", missing);
    return false;
  }
  
  return true;
}

// Error response builder
export function buildErrorResponse(error, toolName) {
  console.error(`${toolName} error:`, error);
  
  // User-friendly error messages
  if (error.message?.includes("rate limit")) {
    return {
      ok: false,
      error: "You've made too many requests. Please wait a few minutes and try again.",
      code: "RATE_LIMIT"
    };
  }
  
  if (error.status === 503) {
    return {
      ok: false,
      error: "The AI service is temporarily unavailable. Please try again in a moment.",
      code: "SERVICE_UNAVAILABLE"
    };
  }
  
  if (error.status === 401) {
    return {
      ok: false,
      error: "Configuration error. Please contact support.",
      code: "AUTH_ERROR"
    };
  }
  
  // Generic fallback
  return {
    ok: false,
    error: "Unable to process your request. Please try again.",
    code: "UNKNOWN_ERROR"
  };
}

// Cache for frequently used prompts/responses
const responseCache = new Map();
const CACHE_TTL = 300000; // 5 minutes

export function getCachedResponse(cacheKey) {
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

export function setCachedResponse(cacheKey, data) {
  responseCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
  
  // Cleanup old entries
  if (responseCache.size > 100) {
    const sortedEntries = [...responseCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    // Remove oldest 20 entries
    for (let i = 0; i < 20; i++) {
      responseCache.delete(sortedEntries[i][0]);
    }
  }
}