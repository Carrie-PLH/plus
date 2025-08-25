// public/lib/toolAccess.js
// Tool access control configuration for PatientLead+ tiered subscriptions

export const TOOL_TIERS = {
  // Free tier (for logged-out or trial expired users)
  free: {
    tools: [
      'symptomPro' // One flagship tool to demonstrate value
    ],
    limits: {
      daily: 3,
      hourly: 1,
      monthly: 20,
      complexTools: 0
    },
    displayName: 'Free Trial',
    price: 0
  },

  // B2C Consumer Tiers
  essential: {
    tools: [
      'symptomPro',
      'appointmentPlanner', 
      'agendaDesigner',
      'actionTracker',
      'storyShaper',
      'conversationFramer'
    ],
    limits: {
      daily: 40,
      hourly: 10,
      monthly: 1200,
      complexTools: 5
    },
    displayName: 'Essential',
    price: 29,
    annualPrice: 23,
    description: 'Core advocacy tools for appointment success',
    trialDays: 7
  },

  professional: {
    tools: [
      // All Essential tools
      'symptomPro',
      'appointmentPlanner',
      'agendaDesigner', 
      'actionTracker',
      'storyShaper',
      'conversationFramer',
      // Additional Professional tools
      'resumeBuilder',
      'careMapper',
      'appealBuilder',
      'rightsBuilder',
      'promptPro',
      'resetPro'
    ],
    limits: {
      daily: 100,
      hourly: 20,
      monthly: 3000,
      complexTools: 20
    },
    displayName: 'Professional',
    price: 49,
    annualPrice: 39,
    description: 'Advanced tools for complex healthcare journeys',
    trialDays: 14,
    popular: true // Flag for UI highlighting
  },

  powerUser: {
    tools: '*', // All tools available
    limits: {
      daily: 250,
      hourly: 50,
      monthly: 7500,
      complexTools: 50
    },
    displayName: 'Power User',
    price: 79,
    annualPrice: 63,
    description: 'Unlimited access for healthcare power users',
    trialDays: 14,
    features: ['earlyAccess', 'advancedAnalytics', 'prioritySupport']
  },
  
  // B2B Business/Clinic Tiers
  clinicStarter: {
    tools: [
      'providerMatch',
      'trendTrack',
      'triageTrack',
      'promptCoach',
      'strategyCoach',
      'accessPro'
    ],
    limits: {
      daily: 500,
      hourly: 100,
      monthly: 15000,
      complexTools: 100
    },
    displayName: 'Clinic Starter',
    price: 199,
    annualPrice: 159,
    description: 'Essential provider tools for small practices',
    seats: 5,
    trialDays: 30,
    features: ['teamAnalytics', 'basicReporting']
  },

  clinicPro: {
    tools: [
      // All Clinic Starter tools
      'providerMatch',
      'trendTrack', 
      'triageTrack',
      'promptCoach',
      'strategyCoach',
      'accessPro',
      // Additional Pro tools
      'peerMatch',
      'resetPro',
      'appealBuilder',
      'rightsBuilder',
      'symptomPro',
      'promptPro'
    ],
    limits: {
      daily: 1000,
      hourly: 200,
      monthly: 30000,
      complexTools: 200  
    },
    displayName: 'Clinic Pro',
    price: 399,
    annualPrice: 319,
    description: 'Complete toolkit for healthcare teams',
    seats: 15,
    trialDays: 30,
    features: ['teamAnalytics', 'advancedReporting', 'populationHealth', 'careGapAnalysis', 'hipaaTools']
  },

  enterprise: {
    tools: '*', // All tools
    limits: {
      daily: -1, // Unlimited
      hourly: -1,
      monthly: -1,
      complexTools: -1
    },
    displayName: 'Enterprise',
    price: 799, // Starting price, custom quotes available
    annualPrice: 639,
    description: 'Unlimited access with enterprise features',
    seats: -1, // Unlimited
    trialDays: 30,
    features: [
      'unlimitedSeats',
      'api',
      'whiteLabel',
      'customIntegration',
      'dedicatedSupport',
      'customReporting',
      'sso',
      'auditLogs',
      'sla'
    ]
  },

  // Special tiers
  grandfathered: {
    // For early adopters - clone from professional but with special pricing
    tools: [
      'symptomPro',
      'appointmentPlanner',
      'agendaDesigner', 
      'actionTracker',
      'storyShaper',
      'conversationFramer',
      'resumeBuilder',
      'careMapper',
      'appealBuilder',
      'rightsBuilder',
      'promptPro',
      'resetPro'
    ],
    limits: {
      daily: 150, // Bonus capacity for early supporters
      hourly: 30,
      monthly: 4500,
      complexTools: 30
    },
    displayName: 'Early Adopter',
    price: 37, // 25% lifetime discount off Professional
    annualPrice: 29,
    description: 'Lifetime discount for our early supporters',
    features: ['earlyAccess', 'grandfatheredPricing'],
    legacy: true
  }
};

// Tool categorization for UI and access logic
export const TOOL_CATEGORIES = {
  preparation: [
    'symptomPro',
    'appointmentPlanner',
    'agendaDesigner',
    'storyShaper',
    'resumeBuilder'
  ],
  communication: [
    'conversationFramer',
    'promptPro',
    'promptCoach',
    'resetPro',
    'careMapper'
  ],
  advocacy: [
    'appealBuilder',
    'rightsBuilder',
    'actionTracker'
  ],
  analytics: [
    'trendTrack',
    'triageTrack',
    'providerMatch',
    'peerMatch'
  ],
  accessibility: [
    'accessPro',
    'strategyCoach'
  ]
};

// Complex tools that count against special limits
export const COMPLEX_TOOLS = [
  'resetPro',      // Uses advanced AI analysis
  'appealBuilder', // Generates legal documents
  'triageTrack',   // Real-time risk assessment
  'promptCoach',   // Interactive AI coaching
  'strategyCoach'  // Deep learning models
];

// Check if user has access to a specific tool
export async function checkToolAccess(toolId, userTier = 'free') {
  const tierConfig = TOOL_TIERS[userTier] || TOOL_TIERS.free;
  
  // Check if tier has unlimited access
  if (tierConfig.tools === '*') return { allowed: true, tier: userTier };
  
  // Check if tool is in allowed list
  const hasAccess = tierConfig.tools.includes(toolId);
  
  if (!hasAccess) {
    // Find minimum tier needed for this tool
    const requiredTier = findMinimumTier(toolId);
    return {
      allowed: false,
      tier: userTier,
      requiredTier: requiredTier,
      upgradeUrl: `/subscribe?tool=${toolId}&from=${userTier}`
    };
  }
  
  return { allowed: true, tier: userTier };
}

// Get all tools available for a tier
export function getToolsForTier(tier) {
  const tierConfig = TOOL_TIERS[tier];
  
  if (!tierConfig) return [];
  if (tierConfig.tools === '*') return getAllTools();
  
  return tierConfig.tools || [];
}

// Get all tools in the system
export function getAllTools() {
  const allTools = new Set();
  
  Object.values(TOOL_TIERS).forEach(tier => {
    if (Array.isArray(tier.tools)) {
      tier.tools.forEach(tool => allTools.add(tool));
    }
  });
  
  return Array.from(allTools);
}

// Find the minimum tier required for a tool
export function findMinimumTier(toolId) {
  // Order tiers by price (cheapest first)
  const tierOrder = ['free', 'essential', 'professional', 'powerUser', 'clinicStarter', 'clinicPro', 'enterprise'];
  
  for (const tierName of tierOrder) {
    const tier = TOOL_TIERS[tierName];
    if (tier.tools === '*' || (Array.isArray(tier.tools) && tier.tools.includes(toolId))) {
      return tierName;
    }
  }
  
  return 'professional'; // Default fallback
}

// Get tier comparison data for upgrade prompts
export function getTierComparison(currentTier, toolId) {
  const requiredTier = findMinimumTier(toolId);
  const current = TOOL_TIERS[currentTier] || TOOL_TIERS.free;
  const required = TOOL_TIERS[requiredTier];
  
  return {
    current: {
      name: current.displayName,
      tools: Array.isArray(current.tools) ? current.tools.length : 'Unlimited',
      dailyLimit: current.limits.daily,
      price: current.price
    },
    required: {
      name: required.displayName,
      tools: Array.isArray(required.tools) ? required.tools.length : 'Unlimited',
      dailyLimit: required.limits.daily,
      price: required.price,
      features: required.features || []
    },
    upgrade: {
      additionalTools: Array.isArray(required.tools) && Array.isArray(current.tools) 
        ? required.tools.filter(t => !current.tools.includes(t))
        : [],
      additionalDailyAnalyses: required.limits.daily - current.limits.daily,
      priceDifference: required.price - current.price
    }
  };
}

// Check if a tool is complex (counts against special limits)
export function isComplexTool(toolId) {
  return COMPLEX_TOOLS.includes(toolId);
}

// Get user's remaining limits
export async function checkUserLimits(uid, tier, usageData) {
  const tierConfig = TOOL_TIERS[tier] || TOOL_TIERS.free;
  const limits = tierConfig.limits;
  
  // Unlimited tier
  if (limits.daily === -1) {
    return {
      allowed: true,
      unlimited: true
    };
  }
  
  const now = Date.now();
  const hourAgo = now - 3600000;
  const dayAgo = now - 86400000;
  
  // Count usage
  const hourlyUsage = usageData.filter(u => u.timestamp > hourAgo).length;
  const dailyUsage = usageData.filter(u => u.timestamp > dayAgo).length;
  const complexUsage = usageData.filter(u => u.timestamp > dayAgo && isComplexTool(u.tool)).length;
  
  // Check limits
  if (hourlyUsage >= limits.hourly) {
    return {
      allowed: false,
      reason: 'hourly_limit',
      limit: limits.hourly,
      used: hourlyUsage,
      resetIn: Math.ceil((hourAgo + 3600000 - now) / 60000) // minutes
    };
  }
  
  if (dailyUsage >= limits.daily) {
    return {
      allowed: false,
      reason: 'daily_limit',
      limit: limits.daily,
      used: dailyUsage,
      resetIn: Math.ceil((dayAgo + 86400000 - now) / 3600000) // hours
    };
  }
  
  if (complexUsage >= limits.complexTools && limits.complexTools > 0) {
    return {
      allowed: false,
      reason: 'complex_limit',
      limit: limits.complexTools,
      used: complexUsage,
      resetIn: Math.ceil((dayAgo + 86400000 - now) / 3600000) // hours
    };
  }
  
  return {
    allowed: true,
    remaining: {
      hourly: limits.hourly - hourlyUsage,
      daily: limits.daily - dailyUsage,
      complex: limits.complexTools - complexUsage
    }
  };
}

// Format tier benefits for display
export function getTierBenefits(tier) {
  const config = TOOL_TIERS[tier];
  if (!config) return [];
  
  const benefits = [];
  
  // Tool count
  if (config.tools === '*') {
    benefits.push('Access to ALL tools');
  } else if (Array.isArray(config.tools)) {
    benefits.push(`${config.tools.length} professional tools`);
  }
  
  // Daily limit
  if (config.limits.daily === -1) {
    benefits.push('Unlimited daily analyses');
  } else {
    benefits.push(`${config.limits.daily} analyses per day`);
  }
  
  // Seats (for business tiers)
  if (config.seats) {
    if (config.seats === -1) {
      benefits.push('Unlimited team seats');
    } else {
      benefits.push(`${config.seats} team seats included`);
    }
  }
  
  // Special features
  if (config.features) {
    const featureNames = {
      earlyAccess: 'Early access to new tools',
      advancedAnalytics: 'Advanced analytics dashboard',
      prioritySupport: 'Priority support',
      teamAnalytics: 'Team usage analytics',
      basicReporting: 'Basic reporting',
      advancedReporting: 'Advanced reporting',
      populationHealth: 'Population health insights',
      careGapAnalysis: 'Care gap analysis',
      hipaaTools: 'HIPAA compliance tools',
      api: 'API access',
      whiteLabel: 'White-label options',
      customIntegration: 'Custom integrations',
      sso: 'Single sign-on (SSO)',
      auditLogs: 'Audit logs',
      sla: 'Service level agreement'
    };
    
    config.features.forEach(f => {
      if (featureNames[f]) {
        benefits.push(featureNames[f]);
      }
    });
  }
  
  return benefits;
}