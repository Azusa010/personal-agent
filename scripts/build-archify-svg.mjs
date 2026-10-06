import fs from 'node:fs';

const htmlPath = '.archify/architecture-personal-agent-architecture-20261006-135800/personal-agent-architecture.html';
const html = fs.readFileSync(htmlPath, 'utf-8');

// Copy interactive HTML artifact to docs
fs.mkdirSync('docs', { recursive: true });
fs.copyFileSync(htmlPath, 'docs/architecture.html');
console.log('Copied interactive HTML to docs/architecture.html');

// Extract SVG
const svgMatch = html.match(/<svg[\s\S]*?<\/svg>/);
if (!svgMatch) {
  console.error('No SVG found in HTML!');
  process.exit(1);
}

let svg = svgMatch[0];

// Extract styles
const styleMatches = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
const fontCss = styleMatches[0] ? styleMatches[0][1] : '';
const mainCss = styleMatches[1] ? styleMatches[1][1] : '';

// Inject styles into <defs>
const combinedStyles = `
<style>
/* Archify Embedded Styles */
${fontCss}

${mainCss}

/* Standalone SVG overrides for GitHub Markdown */
:root {
  --bg: #0f172a;
  --grid: #1e293b;
  --text: #f8fafc;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --panel: rgba(15, 23, 42, 0.7);
  --panel-border: #334155;
  color-scheme: dark light;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --grid: #e2e8f0;
    --text: #0f172a;
    --text-muted: #475569;
    --text-dim: #94a3b8;
    --panel: rgba(255, 255, 255, 0.9);
    --panel-border: #cbd5e1;
  }
}
</style>
`;

// Insert into <defs>
svg = svg.replace('<defs>', `<defs>${combinedStyles}`);

// Make sure SVG has xmlns attribute for standalone image rendering
if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
  svg = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
}

fs.mkdirSync('docs/images', { recursive: true });
fs.writeFileSync('docs/images/architecture.svg', svg, 'utf-8');
console.log('Successfully generated standalone SVG: docs/images/architecture.svg (' + svg.length + ' bytes)');
