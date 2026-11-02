// Separate Electron process: a hung renderer can be terminated by the parent.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const [htmlPath, scenario, screenshotPath, resultPath] = process.argv.slice(2)
  const submissions = []
  const errors = []
  ipcMain.on('eval-submission', (_event, value) => submissions.push(value))
  ipcMain.on('eval-question', () => {})
  const ses = session.fromPartition('html-eval')
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:text/html') })
  })
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'html-page-preload.cjs')
  } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) errors.push(message.slice(0, 500))
  })
  try {
    const html = fs.readFileSync(htmlPath, 'utf8')
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const data = await win.webContents.executeJavaScript(`(async () => {
      const result = { text: document.body?.innerText || '', missing: [] };
      const get = (id) => { const e = document.getElementById(id); if (!e) result.missing.push(id); return e; };
      if (${JSON.stringify(scenario)} === 'reminder-form') {
        const title = get('title'), date = get('date'), time = get('time'), button = get('submit');
        result.title = title?.value; result.date = date?.value;
        if (time) { time.value = '09:30'; time.dispatchEvent(new Event('input', {bubbles:true})); time.dispatchEvent(new Event('change', {bubbles:true})); }
        button?.click();
      } else if (${JSON.stringify(scenario)} === 'csv-chart') {
        const region = get('region'), area = get('results');
        if (region) { region.value = 'North'; region.dispatchEvent(new Event('change', {bubbles:true})); }
        result.filtered = area?.innerText || '';
        const bars = [...document.querySelectorAll('[class*=bar]')].filter(e => {
          const rect = e.getBoundingClientRect(), style = getComputedStyle(e);
          return rect.width > 0 && rect.height > 0 && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        });
        result.hasChart = !!document.querySelector('canvas,svg,[role=img]') || bars.length >= 2;
      } else {
        get('choice-A'); const b = get('choice-B'); get('choice-C'); b?.click();
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      return result;
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(resultPath, JSON.stringify({ data, submissions, errors }))
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ error: String(error), submissions, errors }))
  } finally {
    win.destroy()
    app.quit()
  }
}).catch((error) => { process.stderr.write(String(error)); app.exit(1) })
