#!/bin/bash
# inject-welcome.sh — ensure every public HTML page loads briefmeAuto + welcomeCard

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_DIR="$ROOT_DIR/public"

# What we want to inject (in this order, before </body>)
AUTO='<script type="module" src="/lib/briefmeAuto.js"></script>'
WELCOME='<script type="module" src="/lib/welcomeCard.js"></script>'

# Find all HTML files under public (skip hidden/build dirs if any)
find "$PUBLIC_DIR" -type f -name "*.html" -print0 | while IFS= read -r -d '' f; do
  # Read file once
  content="$(cat "$f")"

  # Skip if there's no </body> (just in case)
  if ! printf '%s' "$content" | grep -qi '</body>'; then
    echo "⚠️  Skipping (no </body>): $f"
    continue
  fi

  changed=0

  # Inject briefmeAuto if missing
  if ! printf '%s' "$content" | grep -q '/lib/briefmeAuto\.js'; then
    content="$(printf '%s' "$content" | perl -0777 -pe "s#</body>#$AUTO\n</body>#i")"
    changed=1
  fi

  # Inject welcomeCard if missing
  if ! printf '%s' "$content" | grep -q '/lib/welcomeCard\.js'; then
    content="$(printf '%s' "$content" | perl -0777 -pe "s#</body>#$WELCOME\n</body>#i")"
    changed=1
  fi

  if [ "$changed" -eq 1 ]; then
    printf '%s' "$content" > "$f"
    echo "✓ Updated: $f"
  else
    echo "• Already ok: $f"
  fi
done

echo "Done."