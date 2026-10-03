const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const svgContent = `
<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mintGrad" x1="120" y1="120" x2="390" y2="390" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="50%" stop-color="#0f9d8f"/>
      <stop offset="100%" stop-color="#0b7e73"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="256" y1="40" x2="256" y2="472" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#f6f3ec"/>
    </linearGradient>
    <filter id="shadow" x="0" y="8" width="512" height="504" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#4a3e28" flood-opacity="0.14"/>
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#4a3e28" flood-opacity="0.08"/>
    </filter>
    <filter id="sparkGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>

  <!-- Squircle App Container -->
  <rect x="44" y="44" width="424" height="424" rx="104" fill="url(#cardGrad)" stroke="#e4ddcf" stroke-width="4" filter="url(#shadow)"/>

  <!-- Logo Group Scaled and Centered (viewBox 0 0 120 120 scaled ~2.65x at center 256, 256) -->
  <g transform="translate(97, 97) scale(2.65)">
    <!-- Base Paper Page Fill -->
    <path d="M34 26 C34 21.5 37.5 18 42 18 L73 18 L94 39 L94 94 C94 98.5 90.5 102 86 102 L42 102 C37.5 102 34 98.5 34 94 Z" 
          fill="#fbf9f4" stroke="#3a372f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    
    <!-- 45 deg Fold -->
    <path d="M73 18 L73 39 L94 39" 
          stroke="#3a372f" stroke-width="4.5" stroke-linejoin="round"/>

    <!-- P & A Dynamic Ribbon Stroke -->
    <path d="M49 84 L49 38 C49 38 73 35 73 53 C73 68 49 67 49 67 L77 84" 
          stroke="url(#mintGrad)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Crossbar -->
    <path d="M43 67 L64 67" 
          stroke="url(#mintGrad)" stroke-width="4" stroke-linecap="round"/>

    <!-- Agent Prism Spark -->
    <circle cx="61" cy="53" r="6" fill="url(#mintGrad)" filter="url(#sparkGlow)"/>
    <path d="M61 46 Q61 53 68 53 Q61 53 61 60 Q61 53 54 53 Q61 53 61 46 Z" fill="#ffffff"/>
  </g>
</svg>
`;

function createIco(pngList) {
  const count = pngList.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const entries = [];
  for (const item of pngList) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += item.buffer.length;
  }
  return Buffer.concat([header, ...entries, ...pngList.map((p) => p.buffer)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:transparent;overflow:hidden;">${svgContent}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  await new Promise((r) => setTimeout(r, 400));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const png512 = image.toPNG();

  const resIconPath = path.join(ROOT, 'apps/desktop/resources/icon.png');
  const buildIconPngPath = path.join(ROOT, 'apps/desktop/build/icon.png');
  fs.writeFileSync(resIconPath, png512);
  fs.writeFileSync(buildIconPngPath, png512);
  console.log('Saved 512x512 icon.png to resources/ and build/');

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngList = sizes.map((size) => {
    const resized = image.resize({ width: size, height: size, quality: 'best' });
    return { width: size, height: size, buffer: resized.toPNG() };
  });

  const icoBuffer = createIco(pngList);
  const buildIconIcoPath = path.join(ROOT, 'apps/desktop/build/icon.ico');
  fs.writeFileSync(buildIconIcoPath, icoBuffer);
  console.log('Saved multi-resolution icon.ico to build/ (sizes: ' + sizes.join(', ') + ')');

  app.quit();
});
