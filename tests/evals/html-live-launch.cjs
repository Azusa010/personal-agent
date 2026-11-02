// Run the benchmark using the same encrypted settings as the desktop app.
// Secrets stay in memory and are passed only to the local child process.
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
app.setName('PersonalAgent')
app.setPath('userData', path.join(process.env.APPDATA, 'PersonalAgent'))
const logFile = path.join(__dirname, 'reports', 'html-launch.log')
fs.mkdirSync(path.dirname(logFile), { recursive: true })
const log = fs.openSync(logFile, 'w')

app.whenReady().then(() => {
  const file = path.join(process.env.APPDATA, 'PersonalAgent', 'model-settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  const override = process.env.HTML_EVAL_API_KEY
  if ((!override && (!settings.model || !settings.apiKeyEncrypted || !safeStorage.isEncryptionAvailable())) ||
      (override && (!process.env.HTML_EVAL_MODEL || !process.env.HTML_EVAL_BASE_URL))) {
    throw new Error('Desktop model settings or encrypted key are unavailable')
  }
  const env = { ...process.env, OPENAI_MODEL: override ? process.env.HTML_EVAL_MODEL : settings.model,
    OPENAI_API_KEY: override || safeStorage.decryptString(Buffer.from(settings.apiKeyEncrypted, 'base64')),
    OPENAI_BASE_URL: override ? process.env.HTML_EVAL_BASE_URL : (settings.baseUrl || ''),
    OPENAI_API_PROTOCOL: override ? 'responses' : (settings.apiProtocol || 'chat'),
    HTML_EVAL_LIVE: '1', ELECTRON_RUN_AS_NODE: '' }
  delete env.HTML_EVAL_API_KEY
  delete env.PERSONAL_AGENT_SCRIPT
  for (const key of ['ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
    if (/^socks/i.test(env[key] || '')) delete env[key]
  }
  const root = path.resolve(__dirname, '../..')
  const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn('node', [vitest, 'run', 'tests/main/eval/html-live.test.ts', '--config', 'vitest.eval.config.ts'], {
    cwd: path.join(root, 'apps/desktop'), env, stdio: ['ignore', log, log]
  })
  child.on('error', (error) => { fs.writeSync(log, error.message); app.exit(1) })
  child.on('exit', (code) => app.exit(code ?? 1))
}).catch((error) => { fs.writeSync(log, error.message); app.exit(1) })
