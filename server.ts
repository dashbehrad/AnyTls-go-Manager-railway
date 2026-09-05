import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import crypto from 'crypto';
import { spawn, ChildProcess, exec, execSync } from 'child_process';
import * as archiverModule from 'archiver';
import { createServer as createViteServer } from 'vite';

function createZipArchive(options?: any) {
  const mod: any = archiverModule;
  if (typeof mod.ZipArchive === 'function') {
    return new mod.ZipArchive(options);
  }
  if (typeof mod.default === 'function') {
    return mod.default('zip', options);
  }
  if (typeof mod === 'function') {
    return mod('zip', options);
  }
  throw new Error('Unable to initialize zip archive');
}

interface StoredConfig {
  id: string;
  remark: string;
  port: number;
  password: string;
  sni: string;
  trafficLimitGB: number;
  trafficUsedBytes: number;
  expireDays: number;
  expireAt: string | null;
  createdAt: string;
  status: 'active' | 'disabled' | 'expired';
  insecure: boolean;
  notes?: string;
  tcpProxyDomain?: string;
  tcpProxyPort?: number;
}

interface AppData {
  admin: {
    username: string;
    passwordHash: string;
    salt: string;
  };
  serverIp: string;
  panelPort: number;
  isStandalone?: boolean;
  tcpProxyDomain?: string;
  tcpProxyPort?: number;
  configs: StoredConfig[];
}

// ----------------------------------------------------
// AnyTLS Server Process Manager
// ----------------------------------------------------
interface ProcessInfo {
  configId: string;
  remark: string;
  port: number;
  process?: ChildProcess;
  pid?: number;
  status: 'running' | 'stopped' | 'failed';
  startedAt?: string;
  logs: string[];
}

const activeProcesses = new Map<string, ProcessInfo>();

function getAnyTlsBinaryPath(): string | null {
  // First check if it's already in system PATH
  try {
    const whichOut = execSync('which anytls-server 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (whichOut && fs.existsSync(whichOut)) {
      try {
        fs.chmodSync(whichOut, 0o755);
      } catch {}
      return whichOut;
    }
  } catch {}

  const candidates = [
    '/usr/local/bin/anytls-server',
    '/usr/bin/anytls-server',
    '/root/anytls-server',
    '/root/anytls/anytls-server',
    '/root/anytls-go/anytls-server',
    '/opt/anytls-panel/anytls-server',
    '/opt/anytls-panel/bin/anytls-server',
    path.join(process.cwd(), 'anytls-server'),
    path.join(process.cwd(), 'bin', 'anytls-server'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {}
      // If it exists in a custom folder, try creating a symlink in /usr/local/bin so the whole OS finds it
      if (p !== '/usr/local/bin/anytls-server' && !fs.existsSync('/usr/local/bin/anytls-server')) {
        try {
          fs.symlinkSync(p, '/usr/local/bin/anytls-server');
        } catch {}
      }
      return p;
    }
  }
  return null;
}

// Auto-download official AnyTLS server binary if missing (critical for Railway and dynamic containers)
async function ensureAnyTlsBinary(): Promise<string | null> {
  const existing = getAnyTlsBinaryPath();
  if (existing) {
    return existing;
  }

  if (os.platform() !== 'linux') {
    return null;
  }

  const rawArch = os.arch();
  const arch = rawArch === 'arm64' ? 'arm64' : 'amd64';
  const releaseVer = '0.0.13';
  const url = `https://github.com/anytls/anytls-go/releases/download/v${releaseVer}/anytls_${releaseVer}_linux_${arch}.zip`;
  const targetBinDir = path.join(process.cwd(), 'bin');
  const targetBin = path.join(targetBinDir, 'anytls-server');

  console.log(`[AnyTLS Supervisor] Binary not found. Auto-downloading v${releaseVer} for linux/${arch} from official release...`);
  try {
    if (!fs.existsSync(targetBinDir)) {
      fs.mkdirSync(targetBinDir, { recursive: true });
    }
    const tempZip = path.join(os.tmpdir(), `anytls-${Date.now()}.zip`);
    const tempExtract = path.join(os.tmpdir(), `anytls-extract-${Date.now()}`);

    execSync(`curl -fsSL "${url}" -o "${tempZip}" && unzip -q -o "${tempZip}" -d "${tempExtract}"`, {
      timeout: 45000,
    });

    const candidateFile = path.join(tempExtract, 'anytls-server');
    if (fs.existsSync(candidateFile)) {
      fs.copyFileSync(candidateFile, targetBin);
      try {
        fs.chmodSync(targetBin, 0o755);
      } catch {}

      try {
        if (!fs.existsSync('/usr/local/bin/anytls-server')) {
          fs.copyFileSync(candidateFile, '/usr/local/bin/anytls-server');
          fs.chmodSync('/usr/local/bin/anytls-server', 0o755);
        }
      } catch {}

      try {
        fs.unlinkSync(tempZip);
        fs.rmSync(tempExtract, { recursive: true, force: true });
      } catch {}

      console.log(`[AnyTLS Supervisor] ✓ Successfully installed anytls-server to ${targetBin}`);
      return targetBin;
    }
  } catch (err: any) {
    console.warn('[AnyTLS Supervisor] Automatic binary download failed:', err.message);
  }
  return null;
}

function addProcessLog(configId: string, message: string) {
  const info = activeProcesses.get(configId);
  if (info) {
    const timestamp = new Date().toLocaleTimeString();
    info.logs.push(`[${timestamp}] ${message}`);
    if (info.logs.length > 100) {
      info.logs.shift();
    }
  }
}

// Kill any old stray processes on the designated port before binding
function killPortOccupant(port: number): Promise<void> {
  return new Promise((resolve) => {
    if (os.platform() === 'linux') {
      exec(`fuser -k ${port}/tcp 2>/dev/null || true`, () => {
        setTimeout(resolve, 150);
      });
    } else {
      resolve();
    }
  });
}

// Check if port is actively listening on the host
function checkPortInListenState(port: number): Promise<{ isListening: boolean; details: string }> {
  return new Promise((resolve) => {
    if (os.platform() === 'linux') {
      exec(`ss -lntp 2>/dev/null | grep ":${port} " || true`, (err, stdout) => {
        const line = stdout.trim();
        if (line) {
          resolve({ isListening: true, details: line });
        } else {
          resolve({ isListening: false, details: 'Port not listed in ss -lntp' });
        }
      });
    } else {
      // Fallback check
      const client = new net.Socket();
      client.setTimeout(400);
      client.once('connect', () => {
        client.destroy();
        resolve({ isListening: true, details: `TCP probe connected to 127.0.0.1:${port}` });
      });
      client.once('timeout', () => {
        client.destroy();
        resolve({ isListening: false, details: 'Connection timed out' });
      });
      client.once('error', (e) => {
        client.destroy();
        resolve({ isListening: false, details: e.message });
      });
      client.connect(port, '127.0.0.1');
    }
  });
}

async function startAnyTlsServer(config: StoredConfig): Promise<boolean> {
  // Stop existing internal handle
  stopAnyTlsServer(config.id);

  if (config.status !== 'active') {
    return false;
  }

  const binaryPath = getAnyTlsBinaryPath();
  const info: ProcessInfo = {
    configId: config.id,
    remark: config.remark,
    port: config.port,
    status: 'stopped',
    logs: [],
  };
  activeProcesses.set(config.id, info);

  if (!binaryPath) {
    info.status = 'failed';
    const warnMsg = `Binary anytls-server not found at /usr/local/bin/anytls-server. On Ubuntu server, please run install.sh.`;
    addProcessLog(config.id, warnMsg);
    console.warn(`[AnyTLS] ${warnMsg} (Config: ${config.remark}, Port: ${config.port})`);
    return false;
  }

  try {
    // Clean up any stray process holding this port
    await killPortOccupant(config.port);

    addProcessLog(config.id, `Starting: ${binaryPath} -l 0.0.0.0:${config.port} -p ******`);
    console.log(`[AnyTLS] Spawning ${binaryPath} -l 0.0.0.0:${config.port} for "${config.remark}"`);

    // Ensure port is open in firewall
    if (os.platform() === 'linux') {
      exec(`ufw allow ${config.port}/tcp >/dev/null 2>&1 || true`, () => {});
    }

    const child = spawn(binaryPath, ['-l', `0.0.0.0:${config.port}`, '-p', config.password], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    info.process = child;
    info.pid = child.pid;
    info.status = 'running';
    info.startedAt = new Date().toISOString();
    addProcessLog(config.id, `Process started successfully (PID: ${child.pid}) listening on 0.0.0.0:${config.port}`);

    // Verify after a short delay that port has actually entered LISTEN mode
    setTimeout(async () => {
      const check = await checkPortInListenState(config.port);
      if (check.isListening) {
        addProcessLog(config.id, `✓ Port ${config.port} confirmed in LISTEN state: ${check.details}`);
      } else if (info.status === 'running') {
        addProcessLog(config.id, `⚠️ Process PID ${child.pid} alive, waiting for port binding...`);
      }
    }, 600);

    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        addProcessLog(config.id, msg);
        console.log(`[AnyTLS ${config.port}] ${msg}`);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        addProcessLog(config.id, msg);
        console.error(`[AnyTLS ${config.port}] ${msg}`);
      }
    });

    child.on('error', (err: Error) => {
      info.status = 'failed';
      addProcessLog(config.id, `Process error: ${err.message}`);
      console.error(`[AnyTLS ${config.port}] Process error:`, err);
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      info.status = 'stopped';
      info.pid = undefined;
      info.process = undefined;
      addProcessLog(config.id, `Process exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`);
      console.log(`[AnyTLS ${config.port}] Process exited with code ${code}`);
    });

    return true;
  } catch (err: any) {
    info.status = 'failed';
    addProcessLog(config.id, `Failed to launch process: ${err.message}`);
    console.error(`[AnyTLS ${config.port}] Failed to launch:`, err);
    return false;
  }
}

function stopAnyTlsServer(configId: string): void {
  const info = activeProcesses.get(configId);
  if (info) {
    if (info.process) {
      try {
        addProcessLog(configId, `Stopping process (PID: ${info.pid})...`);
        info.process.kill('SIGTERM');
        setTimeout(() => {
          if (info.process && !info.process.killed) {
            try {
              info.process.kill('SIGKILL');
            } catch {}
          }
        }, 800);
      } catch (err: any) {
        console.error(`[AnyTLS] Error stopping process ${configId}:`, err);
      }
    }
    // Also ensure port occupant is cleared
    if (info.port) {
      killPortOccupant(info.port);
    }
    info.status = 'stopped';
    info.pid = undefined;
    info.process = undefined;
  }
}

function syncAllAnyTlsProcesses(): void {
  const data = loadData();
  const currentActiveIds = new Set<string>();

  for (const cfg of data.configs) {
    if (cfg.status === 'active') {
      currentActiveIds.add(cfg.id);
      const existing = activeProcesses.get(cfg.id);
      if (!existing || existing.status !== 'running' || existing.port !== cfg.port) {
        startAnyTlsServer(cfg);
      }
    } else {
      stopAnyTlsServer(cfg.id);
    }
  }

  // Stop any orphaned processes
  for (const [id] of activeProcesses.entries()) {
    if (!currentActiveIds.has(id)) {
      stopAnyTlsServer(id);
      activeProcesses.delete(id);
    }
  }
}

// Background Watchdog: Runs every 20 seconds
// 1. Checks and auto-disables expired configurations
// 2. Checks if any active configuration process exited unexpectedly and restarts it
function startProcessWatchdog(): void {
  setInterval(async () => {
    try {
      const data = loadData();
      let changed = false;
      const now = new Date();

      for (const cfg of data.configs) {
        // Expiration check: Date
        const isTimeExpired = cfg.expireAt ? new Date(cfg.expireAt) < now : false;
        // Expiration check: Traffic Limit
        const isTrafficExpired = cfg.trafficLimitGB > 0 && cfg.trafficUsedBytes >= cfg.trafficLimitGB * 1024 * 1024 * 1024;

        if ((isTimeExpired || isTrafficExpired) && cfg.status === 'active') {
          console.log(`[Watchdog] Config "${cfg.remark}" expired (Time: ${isTimeExpired}, Traffic: ${isTrafficExpired}). Stopping process.`);
          cfg.status = 'expired';
          stopAnyTlsServer(cfg.id);
          changed = true;
          continue;
        }

        // Keep-alive check for active configurations
        if (cfg.status === 'active') {
          const proc = activeProcesses.get(cfg.id);
          if (!proc || proc.status !== 'running' || !proc.pid) {
            console.log(`[Watchdog] Active config "${cfg.remark}" (Port: ${cfg.port}) process not running. Auto-restarting...`);
            await startAnyTlsServer(cfg);
          }
        }
      }

      if (changed) {
        saveData(data);
      }
    } catch (err) {
      console.error('[Watchdog] Error during supervisor cycle:', err);
    }
  }, 20000);
}

process.on('SIGTERM', () => {
  for (const [id] of activeProcesses) {
    stopAnyTlsServer(id);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  for (const [id] of activeProcesses) {
    stopAnyTlsServer(id);
  }
  process.exit(0);
});

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'config.json');

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ----------------------------------------------------
// Simplified & Automatic Environment Detection
// Users only need to set USERNAME and PASSWORD.
// All other variables (ports, proxy, SNI) are 100% automatic!
// ----------------------------------------------------
function getEnvAdminCredentials(): {
  username: string;
  password?: string;
  isCustomUser: boolean;
  isCustomPass: boolean;
} {
  const explicitUser = (
    process.env.ADMIN_USERNAME ||
    process.env.USERNAME ||
    process.env.PANEL_USERNAME ||
    process.env.ADMIN_USER ||
    ''
  ).trim();

  let finalUser = 'admin';
  let isCustomUser = false;

  if (explicitUser && explicitUser !== 'root' && explicitUser !== 'node' && explicitUser !== 'runner') {
    finalUser = explicitUser;
    isCustomUser = true;
  } else if (process.env.ADMIN_USERNAME || process.env.PANEL_USERNAME) {
    finalUser = explicitUser;
    isCustomUser = true;
  }

  const rawPass = (
    process.env.ADMIN_PASSWORD ||
    process.env.PASSWORD ||
    process.env.PANEL_PASSWORD ||
    process.env.ADMIN_PASS ||
    process.env.PASS ||
    ''
  ).trim();

  const isCustomPass = Boolean(rawPass);
  const finalPass = rawPass || 'admin123';

  return {
    username: finalUser,
    password: isCustomPass ? finalPass : undefined,
    isCustomUser,
    isCustomPass,
  };
}

function getEnvTcpProxyInfo(data?: AppData): {
  domain: string;
  port: number;
  isAutoDetected: boolean;
} {
  // Railway automatically sets RAILWAY_TCP_PROXY_DOMAIN & RAILWAY_TCP_PROXY_PORT
  // when the user clicks "Add TCP Proxy" on internal port 8080. No manual env needed!
  const railwayDomain = (process.env.RAILWAY_TCP_PROXY_DOMAIN || '').trim();
  const railwayPort = Number(process.env.RAILWAY_TCP_PROXY_PORT || 0);

  const fallbackDomain = (
    process.env.TCP_PROXY_DOMAIN ||
    process.env.TCP_PROXY_HOST ||
    process.env.PROXY_DOMAIN ||
    process.env.PROXY_HOST ||
    data?.tcpProxyDomain ||
    ''
  ).trim();

  const fallbackPort = Number(
    process.env.TCP_PROXY_PORT ||
    process.env.PROXY_PORT ||
    data?.tcpProxyPort ||
    0
  );

  const domain = railwayDomain || fallbackDomain;
  const port = railwayPort || fallbackPort;
  const isAutoDetected = Boolean(railwayDomain && railwayPort > 0);

  return { domain, port, isAutoDetected };
}

function getDefaultData(): AppData {
  const { username: envAdminUser, password: envAdminPass } = getEnvAdminCredentials();
  const envTcpInfo = getEnvTcpProxyInfo();

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(envAdminPass || 'admin123', salt);

  const now = new Date();
  const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const defaultSni = (process.env.SNI_DEFAULT || 'cloudflare.com').trim();
  const defaultPort = Number(process.env.ANYTLS_PORT || 8080);

  return {
    admin: {
      username: envAdminUser || 'admin',
      passwordHash,
      salt,
    },
    serverIp: '127.0.0.1',
    panelPort: 3000,
    tcpProxyDomain: envTcpInfo.domain,
    tcpProxyPort: envTcpInfo.port,
    configs: [
      {
        id: 'cfg-' + crypto.randomBytes(4).toString('hex'),
        remark: 'Railway-AnyTLS-Auto',
        port: defaultPort,
        password: crypto.randomBytes(12).toString('base64url'),
        sni: defaultSni,
        trafficLimitGB: 0,
        trafficUsedBytes: 0,
        expireDays: 30,
        expireAt: thirtyDaysLater.toISOString(),
        createdAt: now.toISOString(),
        status: 'active',
        insecure: true,
        notes: 'Auto-configured AnyTLS profile with automatic Railway TCP Proxy & NekoBox link',
        tcpProxyDomain: envTcpInfo.domain,
        tcpProxyPort: envTcpInfo.port,
      },
    ],
  };
}

function loadData(): AppData {
  ensureDataDir();
  let data: AppData;

  if (!fs.existsSync(DATA_FILE)) {
    data = getDefaultData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return data;
  }

  try {
    const content = fs.readFileSync(DATA_FILE, 'utf-8');
    data = JSON.parse(content);
  } catch (err) {
    console.error('Error loading config.json:', err);
    data = getDefaultData();
  }

  let hasChanges = false;

  // Backward compatibility check
  if (data.admin && (data.admin as any).password && !data.admin.passwordHash) {
    const salt = crypto.randomBytes(16).toString('hex');
    data.admin.passwordHash = hashPassword((data.admin as any).password, salt);
    data.admin.salt = salt;
    delete (data.admin as any).password;
    hasChanges = true;
  }

  // Automatic environment variable synchronization
  // Only USERNAME and PASSWORD are required from user.
  const { username: envAdminUser, password: envAdminPass, isCustomUser, isCustomPass } = getEnvAdminCredentials();
  const envTcpInfo = getEnvTcpProxyInfo(data);

  if (isCustomUser && envAdminUser && data.admin.username !== envAdminUser) {
    data.admin.username = envAdminUser;
    hasChanges = true;
  }

  if (isCustomPass && envAdminPass) {
    if (!data.admin.salt) {
      data.admin.salt = crypto.randomBytes(16).toString('hex');
    }
    const envHash = hashPassword(envAdminPass, data.admin.salt);
    if (data.admin.passwordHash !== envHash) {
      data.admin.passwordHash = envHash;
      hasChanges = true;
    }
  }

  // Auto-update TCP Proxy if Railway injected or provided new variables
  if (envTcpInfo.domain && data.tcpProxyDomain !== envTcpInfo.domain) {
    data.tcpProxyDomain = envTcpInfo.domain;
    hasChanges = true;
  }

  if (envTcpInfo.port > 0 && data.tcpProxyPort !== envTcpInfo.port) {
    data.tcpProxyPort = envTcpInfo.port;
    hasChanges = true;
  }

  if (hasChanges) {
    saveData(data);
  }

  return data;
}

function saveData(data: AppData): void {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// In-memory active tokens
const activeTokens = new Set<string>();

async function startServer() {
  const app = express();
  const initialData = loadData();

  const isStandaloneEnv =
    initialData.isStandalone === true ||
    process.env.STANDALONE_PANEL === 'true' ||
    process.env.VITE_STANDALONE === 'true' ||
    fs.existsSync('/etc/systemd/system/anytls-panel.service');

  // In standalone deployment on Ubuntu/VPS, listen on configured panelPort or process.env.PORT
  // In development / cloud container, port MUST be 3000 as strictly mandated by ingress proxy
  const PORT = isStandaloneEnv
    ? (Number(initialData.panelPort) || Number(process.env.PORT) || 3000)
    : 3000;

  app.use(express.json());

  // Detect public IP once in background
  let cachedServerIp = '127.0.0.1';
  fetch('https://api.ipify.org?format=json')
    .then((r) => r.json())
    .then((res: any) => {
      if (res && res.ip) cachedServerIp = res.ip;
    })
    .catch(() => {
      try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const iface of ifaces[name] || []) {
            if (!iface.internal && iface.family === 'IPv4') {
              cachedServerIp = iface.address;
              return;
            }
          }
        }
      } catch (e) {
        // ignore
      }
    });

  // Simple auth middleware for API routes
  const requireAuth = (req: Request, res: Response, next: () => void) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Please sign in first' });
      return;
    }
    const token = authHeader.split(' ')[1];
    if (!activeTokens.has(token)) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    next();
  };

  // ----------------------------------------------------
  // Auth Endpoints
  // ----------------------------------------------------
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { username, password } = req.body;
    const data = loadData();

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    if (username !== data.admin.username) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const calculatedHash = hashPassword(password, data.admin.salt);
    let isAuthenticated = calculatedHash === data.admin.passwordHash;

    // Check direct match with ADMIN_PASSWORD / PANEL_PASSWORD environment variable
    const envAdminPass = (process.env.ADMIN_PASSWORD || process.env.PANEL_PASSWORD || '').trim();
    if (!isAuthenticated && envAdminPass && password === envAdminPass) {
      isAuthenticated = true;
      data.admin.passwordHash = calculatedHash;
      saveData(data);
    }

    // Backward-compatibility fallback: if hash was created with sha256 or plain text
    if (!isAuthenticated && data.admin.salt) {
      const sha256Hash = crypto.createHash('sha256').update(password + data.admin.salt).digest('hex');
      if (sha256Hash === data.admin.passwordHash) {
        isAuthenticated = true;
        // Automatically upgrade to PBKDF2 sha512
        data.admin.passwordHash = calculatedHash;
        saveData(data);
      }
    }

    if (!isAuthenticated && (data.admin as any).password === password) {
      isAuthenticated = true;
      delete (data.admin as any).password;
      const newSalt = crypto.randomBytes(16).toString('hex');
      data.admin.salt = newSalt;
      data.admin.passwordHash = hashPassword(password, newSalt);
      saveData(data);
    }

    if (!isAuthenticated) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);

    res.json({
      success: true,
      token,
      username: data.admin.username,
    });
  });

  app.get('/api/auth/me', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ isLoggedIn: false });
      return;
    }
    const token = authHeader.split(' ')[1];
    if (!activeTokens.has(token)) {
      res.status(401).json({ isLoggedIn: false });
      return;
    }
    const data = loadData();
    res.json({
      isLoggedIn: true,
      username: data.admin.username,
      panelPort: data.panelPort || 3000,
      adminUsernameFromEnv: Boolean(process.env.ADMIN_USERNAME || process.env.PANEL_USERNAME),
      adminPasswordFromEnv: Boolean(process.env.ADMIN_PASSWORD || process.env.PANEL_PASSWORD),
    });
  });

  app.post('/api/auth/change-password', requireAuth, (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current password and new password are required' });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: 'New password must be at least 6 characters' });
      return;
    }

    const data = loadData();
    const currentHash = hashPassword(currentPassword, data.admin.salt);
    let isAuthed = currentHash === data.admin.passwordHash;
    if (!isAuthed && data.admin.salt) {
      const sha256Hash = crypto.createHash('sha256').update(currentPassword + data.admin.salt).digest('hex');
      if (sha256Hash === data.admin.passwordHash) {
        isAuthed = true;
      }
    }
    if (!isAuthed) {
      res.status(400).json({ error: 'Incorrect current password' });
      return;
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    data.admin.salt = newSalt;
    data.admin.passwordHash = hashPassword(newPassword, newSalt);
    saveData(data);

    res.json({ success: true, message: 'Password changed successfully' });
  });

  // Settings update endpoint (changes password and/or panel port)
  app.post('/api/settings/update', requireAuth, (req: Request, res: Response) => {
    const { currentPassword, newPassword, newPort } = req.body;
    const data = loadData();

    if (!currentPassword) {
      res.status(400).json({ error: 'Current password is required to save changes' });
      return;
    }

    const currentHash = hashPassword(currentPassword, data.admin.salt);
    let isAuthed = currentHash === data.admin.passwordHash;
    if (!isAuthed && data.admin.salt) {
      const sha256Hash = crypto.createHash('sha256').update(currentPassword + data.admin.salt).digest('hex');
      if (sha256Hash === data.admin.passwordHash) {
        isAuthed = true;
      }
    }
    if (!isAuthed) {
      res.status(400).json({ error: 'Incorrect current password' });
      return;
    }

    let passwordChanged = false;
    if (newPassword && newPassword.trim() !== '') {
      if (newPassword.length < 6) {
        res.status(400).json({ error: 'New password must be at least 6 characters' });
        return;
      }
      const newSalt = crypto.randomBytes(16).toString('hex');
      data.admin.salt = newSalt;
      data.admin.passwordHash = hashPassword(newPassword, newSalt);
      passwordChanged = true;
    }

    let portChanged = false;
    let targetPort = data.panelPort || 3000;
    if (newPort !== undefined && newPort !== null && newPort !== '') {
      const parsedPort = parseInt(String(newPort), 10);
      if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        res.status(400).json({ error: 'Panel port must be a number between 1 and 65535' });
        return;
      }
      const collision = data.configs.find((c) => c.port === parsedPort);
      if (collision) {
        res.status(400).json({ error: `Port ${parsedPort} is already assigned to AnyTLS tunnel '${collision.remark}'` });
        return;
      }
      if (parsedPort !== data.panelPort) {
        data.panelPort = parsedPort;
        targetPort = parsedPort;
        portChanged = true;
      }
    }

    saveData(data);

    // If port changed on standalone linux system, update systemd and ufw
    if (portChanged && os.platform() === 'linux') {
      try {
        const servicePath = '/etc/systemd/system/anytls-panel.service';
        if (fs.existsSync(servicePath)) {
          let serviceContent = fs.readFileSync(servicePath, 'utf8');
          if (serviceContent.includes('Environment=PORT=')) {
            serviceContent = serviceContent.replace(/Environment=PORT=\d+/, `Environment=PORT=${targetPort}`);
          } else {
            serviceContent = serviceContent.replace(/\[Service\]/, `[Service]\nEnvironment=PORT=${targetPort}`);
          }
          fs.writeFileSync(servicePath, serviceContent, 'utf8');
          exec(`systemctl daemon-reload && ufw allow ${targetPort}/tcp >/dev/null 2>&1 || true`, () => {});
        }
      } catch (err) {
        console.error('Error updating systemd service port:', err);
      }

      // Schedule graceful restart so new port takes effect
      setTimeout(() => {
        process.exit(0);
      }, 1200);
    }

    res.json({
      success: true,
      passwordChanged,
      portChanged,
      newPort: targetPort,
      message: portChanged
        ? `Settings saved! Port updated to ${targetPort}. The panel service is restarting on the new port.`
        : 'Settings saved successfully.',
    });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      activeTokens.delete(token);
    }
    res.json({ success: true });
  });

  // ----------------------------------------------------
  // Configs CRUD Endpoints
  // ----------------------------------------------------
  app.get('/api/configs', requireAuth, (req: Request, res: Response) => {
    const data = loadData();
    // Auto-update expired status if date passed
    const now = new Date();
    let hasChanges = false;
    data.configs = data.configs.map((cfg) => {
      if (cfg.expireAt && new Date(cfg.expireAt) < now && cfg.status === 'active') {
        hasChanges = true;
        return { ...cfg, status: 'expired' };
      }
      if (
        cfg.trafficLimitGB > 0 &&
        cfg.trafficUsedBytes >= cfg.trafficLimitGB * 1024 * 1024 * 1024 &&
        cfg.status === 'active'
      ) {
        hasChanges = true;
        return { ...cfg, status: 'expired' };
      }
      return cfg;
    });

    if (hasChanges) {
      saveData(data);
    }

    const isRailway = Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN
    );
    const envTcpInfo = getEnvTcpProxyInfo(data);
    const globalTcpDomain = envTcpInfo.domain;
    const globalTcpPort = envTcpInfo.port;

    const configsWithProcess = data.configs.map((cfg) => {
      const proc = activeProcesses.get(cfg.id);
      return {
        ...cfg,
        tcpProxyDomain: cfg.tcpProxyDomain || globalTcpDomain,
        tcpProxyPort: cfg.tcpProxyPort || globalTcpPort,
        processRunning: proc?.status === 'running',
        processPid: proc?.pid,
      };
    });

    res.json({
      configs: configsWithProcess,
      serverIp: cachedServerIp,
      binaryInstalled: Boolean(getAnyTlsBinaryPath()),
      isRailway,
      tcpProxyDomain: globalTcpDomain,
      tcpProxyPort: globalTcpPort,
      hasTcpProxy: Boolean(globalTcpDomain && globalTcpPort > 0),
    });
  });

  app.post('/api/configs', requireAuth, async (req: Request, res: Response) => {
    const {
      remark,
      port,
      password,
      sni,
      trafficLimitGB = 0,
      expireDays = 30,
      notes = '',
      insecure = true,
      tcpProxyDomain,
      tcpProxyPort,
    } = req.body;

    if (!remark || !port) {
      res.status(400).json({ error: 'Remark and port are required' });
      return;
    }

    const numericPort = Number(port);
    if (isNaN(numericPort) || numericPort < 1 || numericPort > 65535) {
      res.status(400).json({ error: 'Invalid port (must be between 1 and 65535)' });
      return;
    }

    const data = loadData();
    const portConflict = data.configs.some((c) => c.port === numericPort);
    if (portConflict) {
      res.status(400).json({ error: `Port ${numericPort} is already in use` });
      return;
    }

    const now = new Date();
    let expireAt: string | null = null;
    const daysNum = Number(expireDays);
    if (daysNum > 0) {
      const exp = new Date(now.getTime() + daysNum * 24 * 60 * 60 * 1000);
      expireAt = exp.toISOString();
    }

    const finalPassword = password && password.trim()
      ? password.trim()
      : crypto.randomBytes(12).toString('base64url');

    const newConfig: StoredConfig = {
      id: 'cfg-' + crypto.randomBytes(6).toString('hex'),
      remark: remark.trim(),
      port: numericPort,
      password: finalPassword,
      sni: (sni !== undefined && typeof sni === 'string') ? sni.trim() : '',
      trafficLimitGB: Number(trafficLimitGB) || 0,
      trafficUsedBytes: 0,
      expireDays: daysNum,
      expireAt,
      createdAt: now.toISOString(),
      status: 'active',
      insecure: insecure !== false,
      notes: notes ? notes.trim() : '',
      tcpProxyDomain: tcpProxyDomain ? String(tcpProxyDomain).trim() : undefined,
      tcpProxyPort: tcpProxyPort ? Number(tcpProxyPort) : undefined,
    };

    data.configs.unshift(newConfig);
    saveData(data);

    // Launch anytls-server process immediately
    await startAnyTlsServer(newConfig);

    res.json({
      success: true,
      config: {
        ...newConfig,
        processRunning: activeProcesses.get(newConfig.id)?.status === 'running',
        processPid: activeProcesses.get(newConfig.id)?.pid,
      },
    });
  });

  app.put('/api/configs/:id', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const {
      remark,
      port,
      password,
      sni,
      trafficLimitGB,
      expireDays,
      notes,
      insecure,
      tcpProxyDomain,
      tcpProxyPort,
    } = req.body;

    const data = loadData();
    const index = data.configs.findIndex((c) => c.id === id);
    if (index === -1) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    const current = data.configs[index];
    const numericPort = Number(port);
    if (numericPort && numericPort !== current.port) {
      const portConflict = data.configs.some((c) => c.id !== id && c.port === numericPort);
      if (portConflict) {
        res.status(400).json({ error: `Port ${numericPort} is already in use` });
        return;
      }
      current.port = numericPort;
    }

    if (remark) current.remark = remark.trim();
    if (password) current.password = password.trim();
    if (sni !== undefined) current.sni = typeof sni === 'string' ? sni.trim() : '';
    if (notes !== undefined) current.notes = notes.trim();
    if (insecure !== undefined) current.insecure = Boolean(insecure);
    if (trafficLimitGB !== undefined) current.trafficLimitGB = Number(trafficLimitGB);
    if (tcpProxyDomain !== undefined) current.tcpProxyDomain = tcpProxyDomain ? String(tcpProxyDomain).trim() : undefined;
    if (tcpProxyPort !== undefined) current.tcpProxyPort = tcpProxyPort ? Number(tcpProxyPort) : undefined;

    if (expireDays !== undefined) {
      const daysNum = Number(expireDays);
      current.expireDays = daysNum;
      if (daysNum > 0) {
        const createdTime = new Date(current.createdAt).getTime();
        current.expireAt = new Date(createdTime + daysNum * 24 * 60 * 60 * 1000).toISOString();
      } else {
        current.expireAt = null;
      }
    }

    data.configs[index] = current;
    saveData(data);

    // Restart process with updated port/password if active
    if (current.status === 'active') {
      await startAnyTlsServer(current);
    } else {
      stopAnyTlsServer(current.id);
    }

    res.json({
      success: true,
      config: {
        ...current,
        processRunning: activeProcesses.get(current.id)?.status === 'running',
        processPid: activeProcesses.get(current.id)?.pid,
      },
    });
  });

  app.post('/api/configs/:id/toggle', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = loadData();
    const config = data.configs.find((c) => c.id === id);
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    if (config.status === 'active') {
      config.status = 'disabled';
      stopAnyTlsServer(config.id);
    } else {
      config.status = 'active';
      await startAnyTlsServer(config);
    }

    saveData(data);
    res.json({ success: true, status: config.status });
  });

  app.post('/api/configs/:id/renew', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { addDays = 30, addTrafficGB = 0, resetTraffic = false } = req.body;

    const data = loadData();
    const config = data.configs.find((c) => c.id === id);
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    // Days extension
    const daysToAdd = Number(addDays) || 0;
    if (daysToAdd > 0) {
      const baseTime = config.expireAt && new Date(config.expireAt) > new Date()
        ? new Date(config.expireAt).getTime()
        : Date.now();
      config.expireAt = new Date(baseTime + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
      config.expireDays += daysToAdd;
    }

    // Traffic extension
    const trafficToAdd = Number(addTrafficGB) || 0;
    if (trafficToAdd > 0 && config.trafficLimitGB > 0) {
      config.trafficLimitGB += trafficToAdd;
    }

    if (resetTraffic) {
      config.trafficUsedBytes = 0;
    }

    config.status = 'active';
    saveData(data);
    await startAnyTlsServer(config);

    res.json({ success: true, config });
  });

  app.delete('/api/configs/:id', requireAuth, (req: Request, res: Response) => {
    const { id } = req.params;
    const data = loadData();
    const initialLen = data.configs.length;
    const removedCfg = data.configs.find((c) => c.id === id);
    data.configs = data.configs.filter((c) => c.id !== id);

    if (data.configs.length === initialLen) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    // Terminate process
    stopAnyTlsServer(id);
    activeProcesses.delete(id);

    if (os.platform() === 'linux' && removedCfg) {
      try {
        exec(`ufw delete allow ${removedCfg.port}/tcp >/dev/null 2>&1 || true`, () => {});
      } catch {}
    }

    saveData(data);
    res.json({ success: true, message: 'Configuration deleted successfully' });
  });

  // ----------------------------------------------------
  // Process Details & Real-Time Logs Endpoints
  // ----------------------------------------------------
  app.get('/api/configs/:id/process', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const binaryPath = getAnyTlsBinaryPath();
    const info = activeProcesses.get(id);
    const data = loadData();
    const config = data.configs.find((c) => c.id === id);
    const targetPort = config ? config.port : (info?.port || 0);

    const portCheck = targetPort ? await checkPortInListenState(targetPort) : { isListening: false, details: '' };

    res.json({
      binaryPath,
      binaryExists: Boolean(binaryPath),
      status: info?.status || (config?.status === 'active' ? 'stopped' : 'disabled'),
      pid: info?.pid,
      port: targetPort,
      isListening: portCheck.isListening,
      listenDetails: portCheck.details,
      startedAt: info?.startedAt,
      logs: info?.logs || [],
    });
  });

  app.post('/api/configs/:id/restart-process', requireAuth, async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = loadData();
    const config = data.configs.find((c) => c.id === id);
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const started = await startAnyTlsServer(config);
    const proc = activeProcesses.get(id);
    res.json({
      success: started,
      status: proc?.status || 'stopped',
      pid: proc?.pid,
    });
  });

  // ----------------------------------------------------
  // Railway & TCP Proxy Endpoints
  // ----------------------------------------------------
  app.get('/api/railway/status', requireAuth, (req: Request, res: Response) => {
    const data = loadData();
    const isRailway = Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN
    );
    const { username: envAdminUser, isCustomUser, isCustomPass } = getEnvAdminCredentials();
    const envTcpInfo = getEnvTcpProxyInfo(data);
    const internalPort = Number(process.env.ANYTLS_PORT || 8080);

    res.json({
      isRailway,
      tcpProxyDomain: envTcpInfo.domain,
      tcpProxyPort: envTcpInfo.port,
      internalPort,
      hasTcpProxy: Boolean(envTcpInfo.domain && envTcpInfo.port > 0),
      isAutoDetected: envTcpInfo.isAutoDetected,
      adminUsername: data.admin.username,
      adminUsernameFromEnv: isCustomUser,
      adminPasswordFromEnv: isCustomPass,
      railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '',
    });
  });

  app.post('/api/railway/tcp-proxy', requireAuth, (req: Request, res: Response) => {
    const { tcpProxyDomain, tcpProxyPort } = req.body;
    const data = loadData();

    if (tcpProxyDomain !== undefined) {
      data.tcpProxyDomain = typeof tcpProxyDomain === 'string' ? tcpProxyDomain.trim() : '';
    }
    if (tcpProxyPort !== undefined) {
      const parsed = parseInt(String(tcpProxyPort), 10);
      data.tcpProxyPort = isNaN(parsed) ? 0 : Math.max(0, Math.min(65535, parsed));
    }

    saveData(data);
    res.json({
      success: true,
      message: 'Railway TCP Proxy configuration saved successfully',
      tcpProxyDomain: data.tcpProxyDomain || '',
      tcpProxyPort: data.tcpProxyPort || 0,
    });
  });

  app.post('/api/railway/test-tcp-proxy', requireAuth, async (req: Request, res: Response) => {
    const { domain, port } = req.body;
    const data = loadData();
    const testHost = (
      domain ||
      data.tcpProxyDomain ||
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.TCP_PROXY_HOST ||
      ''
    ).trim();
    const testPort = Number(
      port ||
      data.tcpProxyPort ||
      process.env.RAILWAY_TCP_PROXY_PORT ||
      process.env.TCP_PROXY_PORT ||
      0
    );

    if (!testHost || !testPort) {
      res.status(400).json({
        success: false,
        reachable: false,
        message: 'TCP Proxy domain and port are required to perform connectivity test',
      });
      return;
    }

    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(4500);

    let finished = false;
    socket.once('connect', () => {
      if (finished) return;
      finished = true;
      const latency = Date.now() - startTime;
      socket.destroy();
      res.json({
        success: true,
        reachable: true,
        latencyMs: latency,
        message: `TCP Proxy is active and responsive! (Latency: ${latency}ms to ${testHost}:${testPort})`,
      });
    });

    socket.once('timeout', () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      res.json({
        success: false,
        reachable: false,
        message: `Connection to ${testHost}:${testPort} timed out (4.5s). Ensure Railway TCP Proxying is added.`,
      });
    });

    socket.once('error', (err) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      res.json({
        success: false,
        reachable: false,
        message: `Failed to connect to ${testHost}:${testPort}: ${err.message}`,
      });
    });

    try {
      socket.connect(testPort, testHost);
    } catch (err: any) {
      if (!finished) {
        finished = true;
        res.json({
          success: false,
          reachable: false,
          message: `Socket connection failed: ${err.message}`,
        });
      }
    }
  });

  // ----------------------------------------------------
  // Server Status & System Info
  // ----------------------------------------------------
  app.get('/api/server/status', requireAuth, (req: Request, res: Response) => {
    const data = loadData();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Check if anytls binary exists on system
    const anytlsInstalled = Boolean(getAnyTlsBinaryPath());

    const isRailway = Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN
    );

    const isStandalone =
      data.isStandalone === true ||
      isRailway ||
      process.env.STANDALONE_PANEL === 'true' ||
      process.env.VITE_STANDALONE === 'true' ||
      fs.existsSync('/etc/systemd/system/anytls-panel.service') ||
      anytlsInstalled ||
      (process.env.NODE_ENV === 'production' && !process.env.K_SERVICE);

    const activeCount = data.configs.filter((c) => c.status === 'active').length;
    const tcpProxyDomain = (
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.TCP_PROXY_HOST ||
      data.tcpProxyDomain ||
      ''
    ).trim();
    const tcpProxyPort = Number(
      process.env.RAILWAY_TCP_PROXY_PORT ||
      process.env.TCP_PROXY_PORT ||
      data.tcpProxyPort ||
      0
    );

    res.json({
      cpuUsage: Math.round((os.loadavg()[0] || 0.15) * 10) / 10,
      memoryUsedMB: Math.round(usedMem / 1024 / 1024),
      memoryTotalMB: Math.round(totalMem / 1024 / 1024),
      uptimeSeconds: Math.round(os.uptime()),
      serverIp: cachedServerIp,
      panelPort: data.panelPort || 3000,
      anytlsInstalled,
      anytlsVersion: anytlsInstalled ? 'v0.0.13 (anytls-go)' : 'Ready to install',
      activeConfigsCount: activeCount,
      totalConfigsCount: data.configs.length,
      osInfo: `${os.type()} ${os.release()} (${os.arch()})`,
      isStandalone: Boolean(isStandalone),
      isRailway,
      tcpProxyDomain,
      tcpProxyPort,
      hasTcpProxy: Boolean(tcpProxyDomain && tcpProxyPort > 0),
      adminUsernameFromEnv: Boolean(process.env.ADMIN_USERNAME || process.env.PANEL_USERNAME),
      adminPasswordFromEnv: Boolean(process.env.ADMIN_PASSWORD || process.env.PANEL_PASSWORD),
      railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '',
    });
  });

  // Public system info route for UI standalone & Railway detection
  app.get('/api/system-info', (req: Request, res: Response) => {
    const data = loadData();
    const isRailway = Boolean(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_PUBLIC_DOMAIN
    );
    const anytlsInstalled = Boolean(getAnyTlsBinaryPath());
    const isStandalone =
      data.isStandalone === true ||
      isRailway ||
      process.env.STANDALONE_PANEL === 'true' ||
      process.env.VITE_STANDALONE === 'true' ||
      fs.existsSync('/etc/systemd/system/anytls-panel.service') ||
      anytlsInstalled ||
      (process.env.NODE_ENV === 'production' && !process.env.K_SERVICE);

    const tcpProxyDomain = (
      process.env.RAILWAY_TCP_PROXY_DOMAIN ||
      process.env.TCP_PROXY_HOST ||
      data.tcpProxyDomain ||
      ''
    ).trim();
    const tcpProxyPort = Number(
      process.env.RAILWAY_TCP_PROXY_PORT ||
      process.env.TCP_PROXY_PORT ||
      data.tcpProxyPort ||
      0
    );

    res.json({
      isStandalone: Boolean(isStandalone),
      isRailway,
      serverIp: cachedServerIp,
      tcpProxyDomain,
      tcpProxyPort,
    });
  });

  // ----------------------------------------------------
  // Download One-Click Ubuntu Package (ZIP)
  // ----------------------------------------------------
  app.get('/api/download-zip', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="anytls-panel-ubuntu.zip"');

    const archive = createZipArchive({
      zlib: { level: 9 },
    });

    archive.on('error', (err) => {
      console.error('Archiver error:', err);
      res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    const projectRoot = process.cwd();

    // Include key files for Ubuntu installation
    const filesToInclude = [
      'install.sh',
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'index.html',
      'server.ts',
      'metadata.json',
      '.env.example',
      '.gitignore',
    ];

    for (const file of filesToInclude) {
      const filePath = path.join(projectRoot, file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
      }
    }

    // Include bin directory (CLI utility)
    const binDir = path.join(projectRoot, 'bin');
    if (fs.existsSync(binDir)) {
      archive.directory(binDir, 'bin');
    }

    // Include src directory
    const srcDir = path.join(projectRoot, 'src');
    if (fs.existsSync(srcDir)) {
      archive.directory(srcDir, 'src');
    }

    // Include public directory if exists
    const publicDir = path.join(projectRoot, 'public');
    if (fs.existsSync(publicDir)) {
      archive.directory(publicDir, 'public');
    }

    // Include README.md
    const readmePath = path.join(projectRoot, 'README.md');
    if (fs.existsSync(readmePath)) {
      archive.file(readmePath, { name: 'README.md' });
    }

    // Include standalone flag for standalone Ubuntu deployment
    archive.append('STANDALONE_PANEL=true\nVITE_STANDALONE=true\n', { name: '.env' });

    archive.finalize();
  });

  // Get raw install.sh script for direct curl execution
  app.get('/api/install.sh', (req: Request, res: Response) => {
    const installScriptPath = path.join(process.cwd(), 'install.sh');
    if (fs.existsSync(installScriptPath)) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(fs.readFileSync(installScriptPath, 'utf-8'));
    } else {
      res.status(404).send('# install.sh not found');
    }
  });

  // ----------------------------------------------------
  // Vite Middleware (Development) / Static Files (Production)
  // ----------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`AnyTLS Manager Panel running on http://0.0.0.0:${PORT}`);
    // Automatically verify binary and launch anytls-server process for each active configuration
    try {
      await ensureAnyTlsBinary();
      syncAllAnyTlsProcesses();
      startProcessWatchdog();
    } catch (err) {
      console.error('Failed to sync AnyTLS processes on startup:', err);
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
