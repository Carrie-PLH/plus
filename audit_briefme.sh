#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash audit_briefme.sh
#   bash audit_briefme.sh --patch-briefme-index   # adds initAuth import+call to BriefMe hub if missing

PATCH_BRIEFME_INDEX=0
[[ "${1-}" == "--patch-briefme-index" ]] && PATCH_BRIEFME_INDEX=1

# Gather all BriefMe pages
mapfile -d '' FILES < <(find public/BriefMe -type f -name 'index.html' -print0 2>/dev/null || true)

if (( ${#FILES[@]} == 0 )); then
  echo "No BriefMe index.html files found under public/BriefMe"
  exit 0
fi

print_section () {
  local title="$1"
  printf "\n==== %s ====\n" "$title"
}

check_file () {
  local f="$1"
  local dir="${f%/index.html}"; dir="${dir##*/}"

  print_section "$dir"

  # 1) import from briefmeSave.js (initAuth with or without saveEntryToVault)
  printf "imports briefmeSave.js: "
  if grep -qE 'import[[:space:]]*\{[[:space:]]*initAuth([[:space:]]*,[[:space:]]*saveEntryToVault)?[[:space:]]*\}[[:space:]]*from[[:space:]]*"/lib/briefmeSave\.js"' "$f"; then
    echo "OK"
  else
    echo "MISSING"
  fi

  # 2) await initAuth()
  printf "await initAuth(): "
  grep -q 'await initAuth()' "$f" && echo "OK" || echo "MISSING"

  # 3) NO legacy imports (ensureAuth/saveToVault)
  printf "NO legacy imports: "
  if grep -qE 'import[[:space:]]*\{[[:space:]]*ensureAuth|import[[:space:]]*\{[[:space:]]*saveToVault' "$f"; then
    echo "FOUND (fix)"
  else
    echo "OK"
  fi

  # 4) NO local wrapper function (async function saveEntryToVault ...)
  printf "NO local wrapper: "
  if grep -q 'async function saveEntryToVault' "$f"; then
    echo "FOUND (remove)"
  else
    echo "OK"
  fi

  # 5) NO direct saveToVault({... calls
  printf "NO direct saveToVault(): "
  if grep -q 'saveToVault({' "$f"; then
    echo "FOUND (fix)"
  else
    echo "OK"
  fi

  # 6) uses saveEntryToVault() — required for tool pages, optional on hub
  printf "uses saveEntryToVault(): "
  if [[ "$dir" == "BriefMe" ]]; then
    # Hub page doesn't need to save anything
    grep -q 'saveEntryToVault({' "$f" && echo "PRESENT (not required)" || echo "OK (not required)"
  else
    grep -q 'saveEntryToVault({' "$f" && echo "OK" || echo "MISSING (should save via helper)"
  fi

  # 7) Duplicate identifiers sanity check
  # (flags if '$' or 'form' are defined multiple times which can cause redeclaration errors)
  local cnt_dollar cnt_form
  cnt_dollar=$(grep -cE 'const[[:space:]]+\$|const[[:space:]]+bm\$[[:space:]]*=' "$f" || true)
  cnt_form=$(grep -cE 'const[[:space:]]+form[[:space:]]*=' "$f" || true)

  printf "NO duplicate \$ or 'form' ids: "
  if (( cnt_dollar > 1 || cnt_form > 1 )); then
    echo "POTENTIAL DUPES"
  else
    echo "OK"
  fi

  # Optional: Patch BriefMe hub index to ensure import+init if missing
  if (( PATCH_BRIEFME_INDEX == 1 )) && [[ "$dir" == "BriefMe" ]]; then
    if ! grep -qE 'import[[:space:]]*\{[[:space:]]*initAuth([[:space:]]*,[[:space:]]*saveEntryToVault)?[[:space:]]*\}[[:space:]]*from[[:space:]]*"/lib/briefmeSave\.js"' "$f"; then
      echo "- Patching hub: adding <script type=\"module\"> with initAuth() before </body> ..."
      # Insert a small module script before </body>
      tmp="$(mktemp)"
      awk '
        /<\/body>/ && !patched {
          print "  <script type=\"module\">"
          print "    import { initAuth } from \"/lib/briefmeSave.js\";"
          print "    await initAuth();"
          print "  </script>"
          patched=1
        }
        { print }
      ' "$f" > "$tmp" && mv "$tmp" "$f"
      echo "  ✓ Hub patched."
    fi
  fi
}

# Run checks
for f in "${FILES[@]}"; do
  check_file "$f"
done

echo
echo "Audit complete."