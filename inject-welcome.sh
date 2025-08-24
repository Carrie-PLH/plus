#!/bin/bash
# inject-welcome.sh — append briefmeAuto + welcomeCard to all tool pages if missing

find public -type f -name "*.html" -print0 | \
  xargs -0 perl -0777 -i -pe '
    if (index($_, q{/lib/briefmeAuto.js}) < 0) {
      s#</body>#  <script type="module" src="/lib/briefmeAuto.js"></script>\n</body>#i;
    }
    if (index($_, q{/lib/welcomeCard.js}) < 0) {
      s#</body>#  <script type="module" src="/lib/welcomeCard.js"></script>\n</body>#i;
    }
  '