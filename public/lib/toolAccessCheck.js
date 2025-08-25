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
