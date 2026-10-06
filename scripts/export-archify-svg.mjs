import fs from 'node:fs';

const htmlPath = '.archify/architecture-personal-agent-architecture-20261006-135800/personal-agent-architecture.html';
const html = fs.readFileSync(htmlPath, 'utf-8');
console.log('HTML length:', html.length);

// Also copy the interactive HTML into docs/architecture.html for rich interactive preview!
fs.mkdirSync('docs', { recursive: true });
fs.copyFileSync(htmlPath, 'docs/architecture.html');
console.log('Copied interactive HTML to docs/architecture.html');

// Check if there is an embedded SVG in the HTML
const svgMatch = html.match(/<svg[\s\S]*?<\/svg>/);
if (svgMatch) {
  console.log('Found SVG of length:', svgMatch[0].length);
  fs.mkdirSync('docs/images', { recursive: true });
  fs.writeFileSync('docs/images/architecture.svg', svgMatch[0], 'utf-8');
  console.log('Saved SVG to docs/images/architecture.svg');
} else {
  console.log('SVG not directly embedded as raw text, checking template structure...');
}
