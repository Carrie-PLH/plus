/**
 * Generates CSS variables and a Tailwind color map
 * from base brand colors, including accessible tints/shades.
 */
const fs = require('fs');
const path = require('path');
const tinycolor = require('tinycolor2');

const TOKENS = JSON.parse(fs.readFileSync('tokens/brand.json', 'utf8'));

const LEVELS = [50,100,200,300,400,500,600,700,800,900];
function tone(hex, level){
  const c = tinycolor(hex);
  const idx = LEVELS.indexOf(level);
  // lighter for 50..400, base ~500, darker for 600..900
  const pct = [38,30,22,14,8,0,8,16,24,32][idx];
  return (level <= 500) ? c.lighten(pct).toHexString() : c.darken(pct).toHexString();
}

function makeScale(name, hex){
  const out = {};
  LEVELS.forEach(l=> out[l] = tone(hex, l));
  // prefer 600 as "brand/default" for contrast
  out['DEFAULT'] = out[600];
  return { name, hex, scale: out };
}

const groups = [
  ...Object.entries(TOKENS.brand).map(([k,v]) => makeScale(k, v.value)),
  ...Object.entries(TOKENS.accents).map(([k,v]) => makeScale(k, v.value))
];

// --- CSS variables ---
let css = `/* AUTO-GENERATED: do not edit by hand */
:root{
`;
for(const g of groups){
  for(const [lvl,hex] of Object.entries(g.scale)){
    const key = lvl === 'DEFAULT' ? `${g.name}` : `${g.name}-${lvl}`;
    css += `  --${key}: ${hex};\n`;
  }
}
css += `}
`;
css += `
/* Semantic aliases (customize as needed) */
:root{
  --color-bg: var(--lightestMint-50, #f7faf7);
  --color-text: var(--pineyGreen-900);
  --color-primary: var(--softSage-600);
  --color-primary-contrast: #ffffff;
  --color-accent: var(--warmClay-600);
  --color-muted: var(--lightPink-100);
  --color-info: var(--dustyTeal-600);
  --color-success: var(--mossyGreen-600);
  --color-warning: var(--mutedTerraCotta-600);
}
`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/brand.css', css);

// --- Tailwind theme export (optional) ---
const tw = {};
for(const g of groups){
  tw[g.name] = { ...g.scale };
}
fs.writeFileSync('dist/brand.tailwind.cjs',
  `// AUTO-GENERATED
module.exports = ${JSON.stringify(tw, null, 2)};\n`
);

console.log('✅ Generated dist/brand.css and dist/brand.tailwind.cjs');
