const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const notifier = require('node-notifier');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = 7171;
const DROP_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'PhoneDrop');
const TEXTS_FILE = path.join(DROP_DIR, '_texts.json');

// Ensure drop directory exists
fs.mkdirSync(DROP_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let bestIp = null;
  let fallbackIp = 'localhost';

  for (const name of Object.keys(interfaces)) {
    // Skip known virtual machine adapters
    if (name.toLowerCase().includes('vbox') || name.toLowerCase().includes('virtual') || name.toLowerCase().includes('wsl') || name.toLowerCase().includes('vmware')) continue;
    
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // VirtualBox often uses 192.168.56.x, avoid it
        if (iface.address.startsWith('192.168.56.')) continue;
        
        fallbackIp = iface.address;
        // Prefer standard home network ranges
        if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
          bestIp = iface.address;
        }
      }
    }
  }
  return bestIp || fallbackIp;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function loadTexts() {
  try {
    return JSON.parse(fs.readFileSync(TEXTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveText(entry) {
  const texts = loadTexts();
  texts.unshift(entry);
  fs.writeFileSync(TEXTS_FILE, JSON.stringify(texts.slice(0, 100), null, 2));
}

// ── Multer Storage ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DROP_DIR),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .slice(0, 40);
    cb(null, `${ts}_${base}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Send text ────────────────────────────────────────────────────────────
app.post('/api/text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Empty text' });

  const entry = {
    id: Date.now(),
    text: text.trim(),
    time: new Date().toISOString()
  };
  saveText(entry);

  // Windows toast notification via node-notifier
  notifier.notify({
    title: '📱 PhoneDrop — Text received',
    message: text.slice(0, 100),
    sound: true,
    appID: 'PhoneDrop'
  });

  broadcast({ type: 'text', entry });
  console.log(`[TEXT] ${entry.time} — ${text.slice(0, 60)}`);
  res.json({ ok: true, entry });
});

// ── API: Upload files ─────────────────────────────────────────────────────────
app.post('/api/files', upload.array('files', 50), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'No files received' });

  const saved = req.files.map(f => ({
    name: f.filename,
    original: f.originalname,
    size: f.size,
    path: f.path,
    time: new Date().toISOString()
  }));

  saved.forEach(f => {
    console.log(`[FILE] ${f.time} — ${f.original} → ${f.name}`);
  });

  broadcast({ type: 'files', files: saved });

  // Windows toast via node-notifier
  const count = saved.length;
  const label = count === 1 ? `"${saved[0].original}"` : `${count} files`;
  notifier.notify({
    title: '📁 PhoneDrop — File received',
    message: `${label} saved to PhoneDrop`,
    sound: true,
    appID: 'PhoneDrop'
  });

  res.json({ ok: true, files: saved });
});

// ── API: Get history ──────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.json({ texts: loadTexts() });
});

// ── API: QR Code ──────────────────────────────────────────────────────────────
app.get('/api/qr', async (req, res) => {
  const url = `http://${getLocalIP()}:${PORT}`;
  const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 300, margin: 2 });
  res.json({ url, qr });
});

// ── API: List dropped files ───────────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(DROP_DIR)
      .filter(f => !f.startsWith('_'))
      .map(name => {
        const stat = fs.statSync(path.join(DROP_DIR, name));
        return { name, size: stat.size, time: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 50);
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  console.log('[WS] Phone connected');
  ws.on('close', () => console.log('[WS] Phone disconnected'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  console.log('\n┌──────────────────────────────────────────┐');
  console.log('│          📱  PhoneDrop is running         │');
  console.log('├──────────────────────────────────────────┤');
  console.log(`│  PC URL : http://localhost:${PORT}          │`);
  console.log(`│  Phone  : ${url.padEnd(31)}│`);
  console.log('│  Drop   : Desktop/PhoneDrop               │');
  console.log('└──────────────────────────────────────────┘');
  console.log('\n  Scan the QR code from your phone browser:\n');

  // Print QR to terminal
  const QRCode2 = require('qrcode');
  const qrText = await QRCode2.toString(url, { type: 'terminal', small: true });
  console.log(qrText);
  console.log(`\n  Or go to: ${url}\n`);

  // Open QR page in default browser
  require('child_process').exec(`start http://localhost:${PORT}/qr.html`);
});
