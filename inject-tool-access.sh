#!/bin/bash
# inject-tool-access.sh — Add access control to all tool pages

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"

# Create the access check script if it doesn't exist
ACCESS_CHECK_SCRIPT="$PUBLIC_DIR/lib/toolAccessCheck.js"

cat > "$ACCESS_CHECK_SCRIPT" << 'EOF'
// Tool access check - auto-injected
import { checkToolAccess } from "/lib/toolAccess.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { app } from "/lib/appBootstrap.js";

const functions = getFunctions(app, 'us-east4');
const auth = getAuth(app);

async function checkAccess() {
  // Get tool ID from URL path
  const path = window.location.pathname;
  const toolId = path.split('/').filter(Boolean).pop().toLowerCase();
  
  // Skip check for public pages
  const publicPages = ['', 'index', 'subscribe', 'login', 'vault'];
  if (publicPages.includes(toolId)) return true;
  
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      try {
        // Check subscription
        const checkSub = httpsCallable(functions, 'checkSubscription');
        const subResult = await checkSub();
        
        if (!subResult.data.canAccess || !subResult.data.canAccess.includes(toolId)) {
          // Create upgrade overlay
          const overlay = document.createElement('div');
          overlay.className = 'pl-upgrade-overlay';
          overlay.innerHTML = `
            <div class="pl-upgrade-modal">
              <button class="pl-close-btn" onclick="window.location.href='/'">×</button>
              <div class="pl-modal-header">
                <h2>🔒 Upgrade to Access This Tool</h2>
                <p class="pl-tool-name">${toolId.replace(/([A-Z])/g, ' $1').trim()}</p>
              </div>
              <div class="pl-modal-body">
                <div class="pl-access-info">
                  <p>This tool requires a <strong>${subResult.data.requiredTier || 'Professional'}</strong> subscription.</p>
                  <p>You currently have: <strong>${subResult.data.tier || 'Free'}</strong></p>
                </div>
                <div class="pl-tier-options">
                  <a href="/subscribe?tool=${toolId}" class="pl-select-btn">View Plans & Pricing</a>
                </div>
              </div>
            </div>
          `;
          document.body.appendChild(overlay);
          
          // Add CSS if not already present
          if (!document.querySelector('link[href*="upgrade-overlay.css"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = '/css/upgrade-overlay.css';
            document.head.appendChild(link);
          }
          
          resolve(false);
        } else {
          resolve(true);
        }
      } catch (error) {
        console.error('Access check failed:', error);
        resolve(true); // Fail open
      }
    });
  });
}

// Auto-run on page load
(async () => {
  const hasAccess = await checkAccess();
  if (!hasAccess) {
    console.log('Tool access restricted');
  }
})();

// Export for manual use
window.plCheckAccess = checkAccess;
EOF

echo "✓ Created access check script: $ACCESS_CHECK_SCRIPT"

# Define which directories contain tools that need access control
TOOL_DIRS=(
  "BriefMe/AppointmentPlanner"
  "BriefMe/ResumeBuilder"
  "BriefMe/StoryShaper"
  "BriefMe/AgendaDesigner"
  "BriefMe/ConversationFramer"
  "BriefMe/ActionTracker"
  "BriefMe/CareMapper"
  "SymptomPro"
  "PromptPro"
  "AppealBuilder"
  "ProviderMatch"
  "RightsBuilder"
  "TrendTrack"
  "TriageTrack"
  "PeerMatch"
  "PromptCoach"
  "StrategyCoach"
  "AccessPro"
  "ResetPro"
)

# What we want to inject before </body>
ACCESS_CHECK='<script type="module" src="/lib/toolAccessCheck.js"></script>'
CSS_LINK='<link rel="stylesheet" href="/css/upgrade-overlay.css">'

# Process each tool directory
for dir in "${TOOL_DIRS[@]}"; do
  HTML_FILE="$PUBLIC_DIR/$dir/index.html"
  
  if [ ! -f "$HTML_FILE" ]; then
    echo "⚠️  Skipping (not found): $dir"
    continue
  fi
  
  # Read file
  content="$(cat "$HTML_FILE")"
  
  # Check if already has access check
  if echo "$content" | grep -q '/lib/toolAccessCheck\.js'; then
    echo "• Already protected: $dir"
    continue
  fi
  
  # Inject CSS in head if not present
  if ! echo "$content" | grep -q 'upgrade-overlay\.css'; then
    content="$(echo "$content" | perl -0777 -pe "s#</head>#$CSS_LINK\n</head>#i")"
  fi
  
  # Inject script before </body>
  content="$(echo "$content" | perl -0777 -pe "s#</body>#$ACCESS_CHECK\n</body>#i")"
  
  # Write back
  echo "$content" > "$HTML_FILE"
  echo "✓ Protected: $dir"
done

# Also create the CSS file if it doesn't exist
CSS_FILE="$PUBLIC_DIR/css/upgrade-overlay.css"
if [ ! -f "$CSS_FILE" ]; then
  mkdir -p "$PUBLIC_DIR/css"
  cat > "$CSS_FILE" << 'EOF'
/* Upgrade overlay styles */
.pl-upgrade-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.pl-upgrade-modal {
  background: white;
  border-radius: 20px;
  max-width: 520px;
  width: 90%;
  padding: 32px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.3);
  animation: slideUp 0.4s ease;
  position: relative;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.pl-close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  background: none;
  border: none;
  font-size: 32px;
  color: #999;
  cursor: pointer;
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

.pl-close-btn:hover {
  background: #f5f5f5;
  color: #333;
}

.pl-modal-header {
  text-align: center;
  margin-bottom: 24px;
}

.pl-modal-header h2 {
  margin: 0 0 8px;
  font-size: 28px;
  color: #3c5c5e;
}

.pl-tool-name {
  color: #666;
  font-size: 16px;
  margin: 0;
  text-transform: capitalize;
}

.pl-access-info {
  background: #f8f9fa;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
  text-align: center;
}

.pl-select-btn {
  display: inline-block;
  width: 100%;
  padding: 16px;
  background: #c97f6d;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 18px;
  font-weight: 600;
  text-decoration: none;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.pl-select-btn:hover {
  background: #b86f5d;
  transform: translateY(-2px);
}
EOF
  echo "✓ Created CSS file: $CSS_FILE"
fi

echo ""
echo "=== Tool Access Protection Complete ==="
echo "Protected ${#TOOL_DIRS[@]} tool directories"
echo ""
echo "To reverse this, run:"
echo "  find public -name 'index.html' -exec sed -i '' '/<script.*toolAccessCheck/d' {} \;"
echo ""