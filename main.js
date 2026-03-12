const electron = require('electron');
if (!electron || typeof electron === 'string') {
  // 当 Electron 以 “run as node” 模式启动时，require('electron') 会变成可执行文件路径字符串
  // 这会导致 app/ipcMain 等 API 不存在，程序必然崩溃。直接给出清晰提示。
  // 常见原因：环境变量 ELECTRON_RUN_AS_NODE=1
  console.error('Electron API 不可用：请使用 `npm start` 启动（不要用 node 直接运行 main.js）。');
  console.error('如果你手动设置过环境变量，请确保 ELECTRON_RUN_AS_NODE=0。');
  process.exit(1);
}

const { app, BrowserWindow, ipcMain } = electron;
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const log = require('electron-log');

// 配置日志
log.transports.file.level = 'info';
// 某些环境（例如受限权限/沙盒）写入 ~/Library/Logs 可能会 EPERM；改为写入 app userData
try {
  log.transports.file.resolvePathFn = () => {
    const base = app && typeof app.getPath === 'function' ? app.getPath('userData') : __dirname;
    return path.join(base, 'logs', 'main.log');
  };
} catch {
  // 忽略：不影响主要功能
}
log.info('应用启动...');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 900,
      minHeight: 620,
      backgroundColor: '#0D1117',
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 注意：开启 sandbox 会让 preload 失去 Node 能力（require/electron API），会导致应用无法运行。
        // 在此项目中通过关闭 nodeIntegration + 开启 contextIsolation + 严格 IPC 白名单来实现主要安全边界。
        sandbox: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: path.join(__dirname, 'preload.js')
      },
      frame: true,
      titleBarStyle: 'default'
    });

  mainWindow.loadFile('index.html');

  // 阻止新窗口/跳转，避免外部导航导致的意外代码执行面
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  
  // 窗口最大化时调整内容
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized', true);
  });
  
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });
}

function safeExecFile(file, args = [], options = {}) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      ...options,
    });
  } catch (e) {
    const err = e && typeof e === 'object' ? e : new Error(String(e));
    err._safeExec = { file, args };
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  // 避免 busy-wait，占用 CPU，同时保持同步流程（用于“杀进程后再验证”）
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    // fallback: 尽量缩短窗口（仍可能消耗 CPU，但只在极端环境触发）
    while (Date.now() < end) {}
  }
}

// 排除自身应用的关键字
const SELF_EXCLUDE_PATTERNS = [
  /openclaw-security-scanner/i,
  /WorkBuddy\/\d{14}/i,
];

// 获取系统信息
function getSystemInfo() {
  try {
    const os = require('os');
    
    // 获取 macOS 版本
    let macOSVersion = '未知';
    try {
      // 使用 sw_vers 命令获取准确的 macOS 版本
      const result = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 });
      macOSVersion = result.trim();
    } catch (e) {
      // 如果命令失败，使用 os.release()
      macOSVersion = os.release();
    }
    
    // 获取主机名
    const hostname = os.hostname();
    
    // 获取系统架构
    const arch = os.arch();
    
    // 获取 CPU 信息
    const cpuModel = os.cpus()[0]?.model || '未知';
    
    // 获取内存信息（GB）
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    
    log.info(`系统信息: macOS ${macOSVersion}, ${arch}, ${totalMemory}GB RAM`);
    
    return {
      platform: os.platform(),
      macOSVersion,
      hostname,
      arch,
      cpuModel,
      totalMemory,
      user: process.env.USER || process.env.USERNAME || '未知'
    };
  } catch (error) {
    log.warn('获取系统信息失败:', error.message);
    return {
      platform: 'darwin',
      macOSVersion: '未知',
      hostname: '未知',
      arch: '未知',
      cpuModel: '未知',
      totalMemory: 0,
      user: '未知'
    };
  }
}

function isLikelyOpenclawHit(text) {
  const s = String(text || '');
  if (!/openclaw/i.test(s)) return false;
  // 排除本应用自身
  for (const pattern of SELF_EXCLUDE_PATTERNS) {
    if (pattern.test(s)) return false;
  }
  return true;
}

// 检测Openclaw桌面应用是否安装 (已禁用)
function checkOpenclawInstalled() {
  return { installed: false, path: null };
}

// 检测Openclaw进程是否运行 - 对齐 ps aux | grep "[o]penclaw"
function checkOpenclawRunning() {
  try {
    // 获取当前进程 PID
    const currentPid = process.pid;
    const selfUserData = (() => {
      try {
        return app.getPath('userData');
      } catch {
        return null;
      }
    })();
    
    log.info('🔍 开始扫描Openclaw运行进程...');
    
    // 对齐命令: ps aux | grep "[o]penclaw"
    let result;
    try {
      result = safeExecFile('ps', ['aux'], { timeout: 3000 });
    } catch (e) {
      log.info('✅ 无运行进程');
      return { running: false, count: 0, processes: [], detailedProcesses: [] };
    }
    
    // 过滤包含 openclaw 的行，排除 grep 自身和本应用
    const processes = result
      .trim()
      .split('\n')
      .filter((line) => {
        // 必须包含 openclaw（不区分大小写）
        if (!/openclaw/i.test(line)) return false;
        // 排除 grep 命令自身
        if (/grep.*openclaw/i.test(line)) return false;
        // 排除本应用
        for (const pattern of SELF_EXCLUDE_PATTERNS) {
          if (pattern.test(line)) return false;
        }
        return true;
      });
    
    if (processes.length > 0) {
      log.info(`❌ 未干净 - 发现Openclaw进程运行中: ${processes.length}个`);
      processes.forEach((proc, index) => {
        const parts = proc.trim().split(/\s+/);
        log.info(`  进程${index + 1}: PID=${parts[1]}, 命令=${parts[10] || parts[0]}`);
      });
    } else {
      log.info('✅ 无运行进程');
    }
    
    return { 
      running: processes.length > 0, 
      count: processes.length, 
      processes: processes,
      detailedProcesses: processes.map(proc => {
        const parts = proc.trim().split(/\s+/);
        return {
          pid: parts[1],
          command: parts[10] || parts[0],
          args: parts.slice(10).join(' ')
        };
      })
    };
  } catch (e) {
    log.error('❌ 进程扫描失败:', e.message);
    return { running: false, count: 0, processes: [], detailedProcesses: [] };
  }
}

// 检测Openclaw网络连接 - 对齐 lsof -i :18789
function checkOpenclawNetwork() {
  try {
    log.info('🌐 开始扫描Openclaw网络连接...');
    
    let connections = [];
    let port18789InUse = false;
    
    // 1. 检查端口 18789: lsof -i :18789
    try {
      const portResult = safeExecFile('lsof', ['-i', ':18789'], { timeout: 3000 });
      if (portResult && portResult.trim()) {
        // 排除本应用自身
        const portLines = portResult.trim().split('\n')
          .filter((l) => !SELF_EXCLUDE_PATTERNS.some(p => p.test(l)));
        
        if (portLines.length > 0) {
          port18789InUse = true;
          log.info(`❌ 未干净 - 端口 18789 被占用:`);
          portLines.forEach(line => log.info(`  ${line}`));
          connections.push(...portLines);
        }
      }
    } catch {
      // 端口未被占用
    }
    
    if (!port18789InUse) {
      log.info('✅ 端口已释放 (18789)');
    }
    
    // 2. 额外检查 Openclaw 相关网络连接
    try {
      const lsofAll = safeExecFile('lsof', ['-i', '-P'], { timeout: 3000 });
      const openclawConn = lsofAll
        .trim()
        .split('\n')
        .filter((c) => {
          if (!/openclaw/i.test(c)) return false;
          return !SELF_EXCLUDE_PATTERNS.some(p => p.test(c));
        });
      
      if (openclawConn.length > 0) {
        log.info(`❌ 未干净 - 发现Openclaw网络连接: ${openclawConn.length}个`);
        connections.push(...openclawConn.filter(c => !connections.includes(c)));
      }
    } catch {
      // 无网络连接
    }
    
    if (connections.length === 0) {
      log.info('✅ 端口已释放');
    }
    
    return { 
      connected: connections.length > 0, 
      connections: connections,
      port18789InUse: port18789InUse,
      detailedConnections: connections.map(conn => {
        const parts = conn.trim().split(/\s+/);
        return {
          command: parts[0],
          pid: parts[1],
          user: parts[2],
          fd: parts[3],
          type: parts[4],
          device: parts[5],
          size: parts[6],
          node: parts[7],
          name: parts[8]
        };
      })
    };
  } catch (e) {
    log.error('❌ 网络连接扫描失败:', e.message);
    return { connected: false, connections: [], port18789InUse: false, detailedConnections: [] };
  }
}

// 退出Openclaw进程
function quitOpenclaw() {
  try {
    safeExecFile('pkill', ['-f', 'Openclaw'], { timeout: 3000, stdio: 'ignore' });
    log.info('已尝试退出Openclaw进程');
    return { success: true };
  } catch (error) {
    log.error('退出Openclaw进程失败:', error);
    return { success: false, error: error.message };
  }
}

// 卸载Openclaw
async function uninstallOpenclaw() {
  try {
    log.info('开始卸载Openclaw...');
    
    // 步骤1: 检查安装状态
    const installInfo = checkOpenclawInstalled();
    if (!installInfo.path) {
      return { success: false, error: '未找到Openclaw安装路径' };
    }
    
    // 步骤2: 终止运行进程
    try {
      safeExecFile('pkill', ['-f', '[Oo]penclaw'], { timeout: 3000, stdio: 'ignore' });
      log.info('已尝试终止Openclaw进程');
      // 等待进程完全退出
      await sleep(1000);
    } catch (e) {
      log.info('没有找到运行的Openclaw进程');
    }
    
    // 步骤3: 删除应用程序
    try {
      fs.rmSync(installInfo.path, { recursive: true, force: true });
      log.info(`已删除Openclaw: ${installInfo.path}`);
    } catch (error) {
      log.error('删除应用程序失败:', error);
      return { success: false, error: '删除应用程序失败: ' + error.message };
    }
    
    // 步骤4: 清理残留文件
    const cleanupResult = cleanupResidualFiles();
    if (cleanupResult.success) {
      log.info('清理残留文件成功');
    }
    
    // 验证卸载结果
    await sleep(500);
    const verifyInfo = checkOpenclawInstalled();
    
    if (!verifyInfo.installed) {
      log.info('Openclaw卸载验证成功');
      return { 
        success: true, 
        message: 'Openclaw已成功卸载',
        cleaned: cleanupResult.cleaned || []
      };
    } else {
      return { 
        success: false, 
        error: '卸载验证失败，Openclaw可能仍然存在'
      };
    }
    
  } catch (error) {
    log.error('卸载Openclaw失败:', error);
    return { success: false, error: '卸载过程出错: ' + error.message };
  }
}

// 终止Openclaw进程
function killOpenclawProcesses() {
  try {
    log.info('开始终止Openclaw进程...');
    
    // 获取当前进程 PID，避免误杀自己
    const currentPid = process.pid;
    log.info(`当前进程 PID: ${currentPid}`);
    
    // 首先获取 Openclaw 相关进程列表
    let targetPids = [];
    try {
      const psResult = safeExecFile('ps', ['-eo', 'pid,comm'], { timeout: 3000 });
      const lines = psResult.trim().split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        if (!/[Oo]penclaw/.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const comm = parts.slice(1).join(' ');
        
        // 排除当前进程
        if (pid !== currentPid && !isNaN(pid)) {
          targetPids.push(pid);
          log.info(`  发现目标进程: PID=${pid}, 命令=${comm}`);
        }
      }
    } catch (e) {
      log.info('未发现 Openclaw 进程');
      return { success: true, killed: 0, message: '没有发现运行的进程' };
    }
    
    if (targetPids.length === 0) {
      log.info('没有需要终止的进程');
      return { success: true, killed: 0, message: '没有发现运行的进程' };
    }
    
    // 逐个终止目标进程
    let killedCount = 0;
    for (const pid of targetPids) {
      try {
        process.kill(pid, 'SIGTERM');
        log.info(`  已发送终止信号到进程 ${pid}`);
        killedCount++;
      } catch (e) {
        // 如果温和终止失败，尝试强制终止
        try {
          process.kill(pid, 'SIGKILL');
          log.info(`  已强制终止进程 ${pid}`);
          killedCount++;
        } catch (e2) {
          log.warn(`  无法终止进程 ${pid}`);
        }
      }
    }
    
    // 等待进程退出
    // 给系统一点时间回收进程
    sleepSync(1500);
    
    // 验证是否还有进程在运行
    let remainingCount = 0;
    try {
      const verifyResult = safeExecFile('ps', ['-eo', 'pid,comm'], { timeout: 3000 });
      const verifyLines = verifyResult.trim().split('\n').filter(l => l.trim());
      
      for (const line of verifyLines) {
        if (!/[Oo]penclaw/.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        if (pid !== currentPid && !isNaN(pid)) {
          remainingCount++;
        }
      }
    } catch (e) {
      // 没有剩余进程
    }
    
    if (remainingCount === 0) {
      log.info(`成功终止所有 Openclaw 进程 (${killedCount} 个)`);
      return { success: true, killed: killedCount };
    } else {
      log.warn(`仍有 ${remainingCount} 个进程在运行`);
      return { 
        success: true, // 改为 true，因为已经尽力终止了
        killed: killedCount,
        warning: `仍有 ${remainingCount} 个进程在运行，可能需要管理员权限`
      };
    }
  } catch (error) {
    log.error('终止进程失败:', error);
    return { success: false, error: error.message };
  }
}

// 阻断网络连接
function blockOpenclawNetwork() {
  try {
    log.info('开始阻断Openclaw网络连接...');
    
    // 检查当前网络连接
    const networkInfo = checkOpenclawNetwork();
    
    if (networkInfo.connected) {
      // 使用lsof找到进程并终止
      try {
        const pids = networkInfo.connections.map(conn => {
          const parts = conn.trim().split(/\s+/);
          return parseInt(parts[1], 10); // PID
        }).filter(pid => Number.isInteger(pid) && pid > 0);
        
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (e) {
            // 忽略错误
          }
        }
      } catch (e) {
        // 忽略错误
      }
    }
    
    // 验证网络连接是否已阻断
    setTimeout(() => {}, 500);
    const newNetworkInfo = checkOpenclawNetwork();
    
    if (!newNetworkInfo.connected) {
      log.info('成功阻断Openclaw网络连接');
      return { success: true, blockedConnections: networkInfo.connections.length };
    } else {
      return { 
        success: false, 
        error: '网络连接阻断失败',
        remaining: newNetworkInfo
      };
    }
  } catch (error) {
    log.error('阻断网络连接失败:', error);
    return { success: false, error: error.message };
  }
}

// 移除系统服务
function removeOpenclawServices() {
  try {
    log.info('开始移除Openclaw系统服务...');
    
    let removedServices = [];
    const removedFiles = [];
    
    // 移除launchd服务
    try {
      const launchdList = safeExecFile('launchctl', ['list'], { timeout: 3000 });
      const lines = launchdList
        .split('\n')
        .filter((l) => /openclaw/i.test(l));
      if (lines.length) {
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 2) {
            const serviceId = parts[2];
            // 注：launchctl unload 通常需要 plist 路径；这里尽量做“最小破坏”处理
            safeExecFile('launchctl', ['remove', serviceId], { timeout: 3000, stdio: 'ignore' });
            removedServices.push(serviceId);
          }
        }
      }
    } catch (e) {
      // 没有launchd服务
    }
    
    // 移除登录项
    try {
      safeExecFile(
        'osascript',
        ['-e', 'tell application "System Events" to delete every login item whose name contains "Openclaw"'],
        { timeout: 10000, stdio: 'ignore' }
      );
      removedServices.push('login_item');
    } catch (e) {
      // 忽略错误
    }

    // 删除 LaunchAgents / LaunchDaemons 中的 Openclaw 启动文件
    const launchPaths = [
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      `${process.env.HOME}/Library/LaunchAgents`,
    ];

    for (const launchPath of launchPaths) {
      if (!launchPath) continue;
      try {
        const agentsOutput = safeExecFile(
          'find',
          [launchPath, '-name', '*openclaw*', '-o', '-name', '*OpenClaw*'],
          { timeout: 3000 }
        );
        const agents = agentsOutput
          .trim()
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const agent of agents) {
          try {
            if (fs.existsSync(agent)) {
              fs.rmSync(agent, { force: true });
              removedFiles.push(agent);
              log.info(`已删除 Openclaw 启动文件: ${agent}`);
            }
          } catch (e) {
            log.warn(`删除启动文件失败: ${agent}`, e.message);
          }
        }
      } catch (e) {
        // 忽略单个目录错误
      }
    }
    
    log.info(`[✓] 已移除 ${removedServices.length} 个服务，删除 ${removedFiles.length} 个启动文件`);
    return { success: true, removed: removedServices, removedFiles };
  } catch (error) {
    log.error('移除系统服务失败:', error);
    return { success: false, error: error.message };
  }
}

// 使用 sudo 删除文件或目录
async function deleteWithSudo(targetPath) {
  return new Promise((resolve) => {
    const script = `do shell script "rm -rf '${targetPath}'" with administrator privileges`;
    try {
      log.info('  请求管理员权限删除:', targetPath);
      safeExecFile('osascript', ['-e', script], { timeout: 60000 });
      log.info('  ✓ 已删除:', targetPath);
      resolve({ success: true });
    } catch (error) {
      log.warn('  sudo 删除失败:', targetPath, error.message);
      resolve({ success: false, error: error.message });
    }
  });
}

// 获取所有可能的 npm 全局 bin 目录
function getNpmGlobalBinDirs() {
  const dirs = new Set();
  
  // 1. 通过 npm root -g 获取全局 node_modules 目录
  try {
    const npmRoot = safeExecFile('npm', ['root', '-g'], { timeout: 5000 });
    if (npmRoot && npmRoot.trim()) {
      // bin 目录通常是 ../bin
      const binDir = path.join(path.dirname(npmRoot.trim()), 'bin');
      if (fs.existsSync(binDir)) {
        dirs.add(binDir);
      }
    }
  } catch (e) {
    // 忽略
  }
  
  // 2. 通过 npm bin -g 获取全局 bin 目录
  try {
    const npmBin = safeExecFile('npm', ['bin', '-g'], { timeout: 5000 });
    if (npmBin && npmBin.trim()) {
      dirs.add(npmBin.trim());
    }
  } catch (e) {
    // 忽略
  }
  
  // 3. 常见的 npm 全局 bin 目录
  const commonDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    path.join(process.env.HOME, '.npm-global/bin'),
    path.join(process.env.HOME, 'node_modules/.bin'),
  ];
  
  // 4. NVM 相关目录
  try {
    const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME, '.nvm');
    if (fs.existsSync(nvmDir)) {
      // 查找所有版本的 bin 目录
      const versionsDir = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(versionsDir)) {
        const versions = fs.readdirSync(versionsDir);
        for (const version of versions) {
          const binDir = path.join(versionsDir, version, 'bin');
          if (fs.existsSync(binDir)) {
            dirs.add(binDir);
          }
        }
      }
    }
  } catch (e) {
    // 忽略
  }
  
  for (const d of commonDirs) {
    if (d && fs.existsSync(d)) {
      dirs.add(d);
    }
  }
  
  return Array.from(dirs);
}

// 在目录中查找 openclaw 相关文件
function findOpenclawFilesInDir(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (/openclaw/i.test(entry)) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.lstatSync(fullPath);
          files.push({
            path: fullPath,
            isLink: stat.isSymbolicLink(),
            isDir: stat.isDirectory(),
          });
        } catch (e) {
          // 忽略
        }
      }
    }
  } catch (e) {
    // 忽略
  }
  return files;
}

// 查找 npm 缓存中的 openclaw 相关文件
function findOpenclawInNpmCache() {
  const cacheFiles = [];
  const cacheDirs = [
    path.join(process.env.HOME, '.npm/_cacache'),
    path.join(process.env.HOME, '.npm-cache'),
  ];
  
  for (const cacheDir of cacheDirs) {
    if (fs.existsSync(cacheDir)) {
      try {
        // 使用 find 命令查找包含 openclaw 的文件
        const result = safeExecFile('find', [cacheDir, '-name', '*openclaw*', '-type', 'f'], { timeout: 10000 });
        if (result && result.trim()) {
          result.trim().split('\n').forEach(f => {
            if (f.trim()) {
              cacheFiles.push(f.trim());
            }
          });
        }
      } catch (e) {
        // 忽略
      }
    }
  }
  
  return cacheFiles;
}

// 按官方脚本逻辑卸载 Openclaw CLI（全局命令 + npm 包 + 缓存）
async function uninstallOpenclawCli() {
  try {
    log.info('========== 开始卸载 Openclaw CLI ==========');

    // 1. 先通过 which 找到 openclaw 命令的实际路径
    let cliPaths = [];
    try {
      const whichResult = safeExecFile('which', ['openclaw'], { timeout: 3000 });
      if (whichResult && whichResult.toString().trim()) {
        const foundPath = whichResult.toString().trim();
        cliPaths.push(foundPath);
        log.info('[✓] which 找到 openclaw:', foundPath);
      }
    } catch (e) {
      log.info('[i] which openclaw 未找到命令');
    }

    // 2. 扫描所有 npm 全局 bin 目录
    log.info('[i] 扫描 npm 全局 bin 目录...');
    const binDirs = getNpmGlobalBinDirs();
    let foundAnyFile = false;
    
    for (const dir of binDirs) {
      const files = findOpenclawFilesInDir(dir);
      for (const f of files) {
        if (!cliPaths.includes(f.path)) {
          cliPaths.push(f.path);
          log.info(`[✓] 在 ${dir} 找到: ${path.basename(f.path)}`);
          foundAnyFile = true;
        }
      }
    }
    
    if (!foundAnyFile) {
      log.info('[✓] 未找到 Openclaw 相关文件');
    }

    // 3. 删除所有找到的 CLI 文件
    let deletedCount = 0;
    let needSudo = [];
    
    for (const cliPath of cliPaths) {
      try {
        if (!fs.existsSync(cliPath)) continue;
        
        const stat = fs.lstatSync(cliPath);
        
        if (stat.isSymbolicLink()) {
          const realPath = fs.readlinkSync(cliPath);
          log.info(`    软链接指向: ${realPath}`);
        }
        
        // 尝试直接删除
        try {
          if (stat.isDirectory()) {
            fs.rmSync(cliPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(cliPath);
          }
          log.info(`    ✓ 已删除: ${cliPath}`);
          deletedCount++;
        } catch (e) {
          // 权限不足，记录下来稍后用 sudo 删除
          log.info(`    需要管理员权限: ${cliPath}`);
          needSudo.push(cliPath);
        }
      } catch (e) {
        log.warn(`    处理失败: ${cliPath}`, e.message);
      }
    }

    // 输出删除结果
    if (deletedCount > 0 || needSudo.length > 0) {
      log.info(`[✓] 已删除 ${deletedCount} 个 CLI 文件`);
    } else if (cliPaths.length === 0) {
      log.info('[✓] 未找到 Openclaw CLI 文件');
    }

    // 4. 使用 sudo 删除需要权限的文件
    if (needSudo.length > 0) {
      log.info(`[i] 需要管理员权限删除 ${needSudo.length} 个文件，将弹出密码框...`);
      for (const p of needSudo) {
        const result = await deleteWithSudo(p);
        if (result.success) {
          deletedCount++;
        }
      }
    }

    // 5. 尝试卸载 npm 包
    log.info('[i] 尝试卸载 npm 全局包...');
    const pkgNames = ['openclaw-cn', 'openclaw', '@qingchencloud/openclaw-zh', '@openclaw/openclaw'];
    let uninstalledAny = false;
    
    for (const name of pkgNames) {
      try {
        // 先检查包是否存在
        const listResult = safeExecFile('npm', ['list', '-g', '--depth=0'], { timeout: 5000 });
        if (listResult.includes(name)) {
          // 包存在，执行卸载
          safeExecFile('npm', ['uninstall', '-g', name], { timeout: 15000 });
          log.info(`    ✓ 已卸载 npm 包: ${name}`);
          uninstalledAny = true;
        }
      } catch (e) {
        // 包不存在，忽略
      }
    }
    
    if (uninstalledAny) {
      log.info('[✓] 已卸载 npm 全局包');
    } else {
      log.info('[✓] 未找到 Openclaw npm 包');
    }

    // 6. 查找并删除 npm 全局 node_modules 中的 openclaw 目录
    log.info('[i] 清理 npm 全局 node_modules...');
    let cleanedAny = false;
    try {
      const npmRoot = safeExecFile('npm', ['root', '-g'], { timeout: 5000 });
      if (npmRoot && npmRoot.trim()) {
        const modulesDir = npmRoot.trim();
        const pkgDirs = [
          path.join(modulesDir, 'openclaw'),
          path.join(modulesDir, 'openclaw-cn'),
          path.join(modulesDir, '@qingchencloud'),
          path.join(modulesDir, '@openclaw'),
        ];
        
        for (const pkgDir of pkgDirs) {
          if (fs.existsSync(pkgDir)) {
            try {
              fs.rmSync(pkgDir, { recursive: true, force: true });
              cleanedAny = true;
              log.info(`    ✓ 已删除: ${pkgDir}`);
              deletedCount++;
            } catch (e) {
              // 尝试 sudo
              await deleteWithSudo(pkgDir);
              deletedCount++;
            }
          }
        }
      }
    } catch (e) {
      log.warn('    清理 npm modules 失败:', e.message);
    }
    
    if (cleanedAny) {
      log.info('[✓] 已删除 npm 全局模块中的 Openclaw 目录');
    } else {
      log.info('[✓] 未找到 Openclaw 全局模块');
    }

    // 7. 清理 npm 缓存中的 openclaw 相关内容
    log.info('[i] 清理 npm 缓存...');
    try {
      safeExecFile('npm', ['cache', 'clean', '--force'], { timeout: 30000 });
      log.info('    ✓ npm 缓存清理完成');
    } catch (e) {
      log.warn('    npm 缓存清理失败:', e.message);
    }

    // 8. 查找并清理缓存目录中的 openclaw 文件
    const cacheFiles = findOpenclawInNpmCache();
    if (cacheFiles.length > 0) {
      log.info(`[i] 找到 ${cacheFiles.length} 个缓存文件需要清理`);
      for (const cf of cacheFiles.slice(0, 20)) { // 限制数量避免太慢
        try {
          fs.unlinkSync(cf);
          log.info(`    ✓ 已删除缓存: ${path.basename(cf)}`);
        } catch (e) {
          // 忽略
        }
      }
    }

    // 9. 清理 NVM 中的 openclaw（如果存在）
    log.info('[i] 检查 NVM 目录...');
    try {
      const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME, '.nvm');
      const versionsDir = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(versionsDir)) {
        const versions = fs.readdirSync(versionsDir);
        for (const version of versions) {
          const libDir = path.join(versionsDir, version, 'lib', 'node_modules');
          const nvmPkgDirs = [
            path.join(libDir, 'openclaw'),
            path.join(libDir, 'openclaw-cn'),
            path.join(libDir, '@qingchencloud'),
          ];
          for (const pkgDir of nvmPkgDirs) {
            if (fs.existsSync(pkgDir)) {
              try {
                fs.rmSync(pkgDir, { recursive: true, force: true });
                log.info(`    ✓ 已删除 NVM 包: ${pkgDir}`);
                deletedCount++;
              } catch (e) {
                await deleteWithSudo(pkgDir);
                deletedCount++;
              }
            }
          }
        }
      }
    } catch (e) {
      log.warn('    检查 NVM 目录失败:', e.message);
    }

    // 10. 最终验证
    let stillExists = false;
    let remainingPath = null;
    try {
      const whichResult = safeExecFile('which', ['openclaw'], { timeout: 3000 });
      if (whichResult && whichResult.toString().trim()) {
        stillExists = true;
        remainingPath = whichResult.toString().trim();
      }
    } catch {
      // which 抛错表示命令不存在
    }

    log.info('========== CLI 卸载完成 ==========');
    log.info(`删除文件数: ${deletedCount}`);
    
    if (stillExists) {
      log.warn(`[!] 警告: 系统中仍存在 openclaw 命令: ${remainingPath}`);
      log.warn('[!] 可能需要重启终端或检查 PATH 环境变量');
    } else {
      log.info('[✓] openclaw CLI 已完全卸载');
    }

    return {
      success: !stillExists,
      stillExists,
      remainingPath,
      deletedCount,
    };
  } catch (error) {
    log.error('卸载 Openclaw CLI 过程出错:', error);
    return { success: false, error: error.message };
  }
}

// 扫描 Openclaw CLI 安装情况并返回结构化数据
// 对齐检查命令:
// 1. which openclaw
// 2. npm list -g --depth=0 | grep openclaw
// 3. ls /opt/homebrew/bin/openclaw
// 4. ls ~/.openclaw (配置)
function scanOpenclawCli() {
  const cliInfo = {
    installed: false,
    path: null,
    version: null,
    realPath: null,
    isLink: false,
    packageName: null,
    packageVersion: null,
    configExists: false,
    configPath: null,
    npmPackage: null
  };

  try {
    log.info('[i] 扫描 Openclaw CLI 安装信息...');

    // 1. 命令检查: which openclaw
    try {
      const whichResult = safeExecFile('which', ['openclaw'], { timeout: 3000 });
      if (whichResult && whichResult.toString().trim()) {
        cliInfo.path = whichResult.toString().trim();
        cliInfo.installed = true;
        log.info(`[✓] 命令路径: ${cliInfo.path}`);
      } else {
        log.info('[✗] 命令 "openclaw" 不在 PATH 中');
      }
    } catch {
      log.info('[✗] 命令 "openclaw" 不在 PATH 中');
    }

    // 2. 主文件检查: ls /opt/homebrew/bin/openclaw
    const mainPaths = [
      '/opt/homebrew/bin/openclaw',
      '/usr/local/bin/openclaw',
      '/usr/bin/openclaw',
    ];
    
    for (const p of mainPaths) {
      try {
        if (fs.existsSync(p)) {
          cliInfo.path = p;
          cliInfo.installed = true;
          log.info(`[✓] 主文件: ${p}`);
          break;
        }
      } catch {
        // 忽略
      }
    }

    // 3. npm bin 目录扫描
    log.info('[i] 扫描 npm 全局 bin 目录...');
    const binDirs = getNpmGlobalBinDirs();
    let foundAnyFile = false;
    
    for (const dir of binDirs) {
      const files = findOpenclawFilesInDir(dir);
      for (const f of files) {
        if (!cliInfo.path || !cliInfo.path.includes(f.path)) {
          log.info(`[✓] bin 目录文件: ${f.path}`);
          foundAnyFile = true;
        }
      }
    }
    
    if (foundAnyFile) {
      log.info('[✓] 已找到 Openclaw 相关文件');
    } else {
      log.info('[✓] 未找到 Openclaw 相关文件');
    }

    // 4. npm 包检查: npm list -g --depth=0 | grep openclaw
    try {
      const npmList = safeExecFile('npm', ['list', '-g', '--depth=0'], { timeout: 5000 });
      const npmMatch = npmList.match(/openclaw[^@\n]*@(\S+)/i);
      if (npmMatch) {
        cliInfo.npmPackage = npmMatch[0].trim();
        cliInfo.packageVersion = npmMatch[1];
        log.info(`[✓] npm 包: ${cliInfo.npmPackage}`);
      }
    } catch {
      // 没有安装 npm 包
    }

    // 4. 版本信息
    if (cliInfo.installed && cliInfo.path) {
      try {
        const version = safeExecFile('openclaw', ['-v'], { timeout: 5000 });
        cliInfo.version = version.toString().trim();
        log.info(`[✓] 版本: ${cliInfo.version}`);
      } catch {
        log.info('[!] 无法获取版本信息');
      }

      // 5. 检查是否是软链接
      try {
        const stat = fs.lstatSync(cliInfo.path);
        cliInfo.isLink = stat.isSymbolicLink();
        
        if (stat.isSymbolicLink()) {
          cliInfo.realPath = fs.readlinkSync(cliInfo.path);
          log.info(`    软链接 → ${cliInfo.realPath}`);
          
          // 从 package.json 获取包信息
          const realDir = path.dirname(cliInfo.realPath);
          const pkgJson = path.join(realDir, '../package.json');
          if (fs.existsSync(pkgJson)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
              cliInfo.packageName = pkg.name || null;
              cliInfo.packageVersion = pkg.version || null;
            } catch {
              // 忽略
            }
          }
        }
      } catch {
        // 忽略
      }
    }

    // 6. 配置检查: ls ~/.openclaw
    const configPath = path.join(process.env.HOME, '.openclaw');
    try {
      if (fs.existsSync(configPath)) {
        cliInfo.configExists = true;
        cliInfo.configPath = configPath;
        log.info(`[⚠] 配置残留: ${configPath}`);
      }
    } catch {
      // 忽略
    }

  } catch (error) {
    log.warn('扫描 Openclaw CLI 安装状态时出错:', error.message);
  }

  return cliInfo;
}

// 使用 sudo 卸载应用（弹出密码框）
async function uninstallWithSudo(appPath) {
  return new Promise((resolve) => {
    // 使用 AppleScript 弹出密码框并执行 sudo 命令
    const escapedPath = String(appPath ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    const script = `do shell script "rm -rf " & quoted form of "${escapedPath}" with administrator privileges`;
    
    try {
      log.info('请求管理员权限卸载应用...');
      safeExecFile('osascript', ['-e', script], {
        timeout: 60000 // 60秒超时
      });
      log.info(`已使用 sudo 删除应用: ${appPath}`);
      resolve({ success: true });
    } catch (error) {
      log.error('sudo 卸载失败:', error.message);
      resolve({ success: false, error: '用户取消或密码错误' });
    }
  });
}

// 卸载Openclaw应用
async function uninstallOpenclawApp() {
  try {
    log.info('开始卸载Openclaw应用...');
    
    // 先终止进程
    killOpenclawProcesses();
    
    // 等待进程退出
    await sleep(1000);
    
    // 检查安装状态
    const installInfo = checkOpenclawInstalled();
    if (!installInfo.installed || !installInfo.path) {
      log.info('未找到Openclaw安装路径，可能已经卸载，仅执行 CLI 卸载逻辑');
      const cliResult = uninstallOpenclawCli();

      if (cliResult.success) {
        return {
          success: true,
          message: '未检测到桌面应用，仅卸载了 Openclaw CLI（命令与 npm 包）',
        };
      }

      return {
        success: false,
        error: '未检测到桌面应用，且 CLI 卸载可能失败，请查看日志并手动检查 /opt/homebrew/bin/openclaw',
      };
    }
    
    const appPath = installInfo.path;
    log.info(`目标应用路径: ${appPath}`);
    
    // 尝试普通删除
    let deleteSuccess = false;
    try {
      fs.rmSync(appPath, { recursive: true, force: true });
      
      // 验证是否删除成功
      await sleep(500);
      const verifyInfo = checkOpenclawInstalled();
      
      if (!verifyInfo.installed) {
        deleteSuccess = true;
        log.info('普通删除成功');
      }
    } catch (error) {
      log.info('普通删除失败，需要管理员权限');
    }
    
    // 如果普通删除失败，使用 sudo
    if (!deleteSuccess) {
      log.info('尝试使用管理员权限删除...');
      const sudoResult = await uninstallWithSudo(appPath);
      
      if (!sudoResult.success) {
        return { 
          success: false, 
          error: sudoResult.error || '需要管理员权限，请输入密码确认卸载'
        };
      }
    }
    
    // 等待文件系统同步
    await sleep(500);
    
    // 验证卸载结果
    const verifyInfo = checkOpenclawInstalled();
    
    // 额外执行 CLI 卸载逻辑（全局命令 + npm 包 + 缓存）
    const cliResult = uninstallOpenclawCli();

    if (!verifyInfo.installed && cliResult.success) {
      log.info('Openclaw 应用与 CLI 均已成功卸载');
      return { success: true, message: 'Openclaw 应用与 CLI 已成功卸载' };
    }

    if (verifyInfo.installed) {
      return { 
        success: false, 
        error: '卸载验证失败，Openclaw应用可能仍然存在，请手动删除'
      };
    }

    if (!cliResult.success && cliResult.stillExists) {
      return {
        success: false,
        error: 'Openclaw CLI 可能仍然存在，请根据日志提示手动删除 openclaw 命令',
      };
    }

    return {
      success: true,
      message: 'Openclaw 应用已卸载，CLI 卸载过程可能部分失败，请查看日志确认',
    };
  } catch (error) {
    log.error('卸载Openclaw应用失败:', error);
    return { success: false, error: '卸载过程出错: ' + error.message };
  }
}

// 扫描 Openclaw 相关路径（终极版）
function scanOpenclawPaths() {
  const homeDir = process.env.HOME;
  const foundPaths = {
    directories: [],
    files: [],
    configDir: null,
    backupDirs: []  // 新增：专门记录备份目录
  };
  
  // 需要检查的路径列表（全面覆盖）
  const checkPaths = [
    // 配置目录（主目录）
    `${homeDir}/.openclaw`,
    `${homeDir}/.Openclaw`,
    
    // macOS 应用支持文件
    `${homeDir}/Library/Application Support/Openclaw`,
    `${homeDir}/Library/Application Support/OpenClaw`,
    `${homeDir}/Library/Caches/Openclaw`,
    `${homeDir}/Library/Caches/OpenClaw`,
    `${homeDir}/Library/Logs/Openclaw`,
    `${homeDir}/Library/Logs/OpenClaw`,
    
    // WebKit 数据（Electron 应用常见）
    `${homeDir}/Library/WebKit/Openclaw`,
    `${homeDir}/Library/WebKit/OpenClaw`,
    `${homeDir}/Library/WebKit/ai.openclaw.clawpanel`,
    
    // 偏好设置（通配符在后面处理）
    `${homeDir}/Library/Preferences/com.openclaw`,
    `${homeDir}/Library/Preferences/com.OpenClaw`,
  ];
  
  // 扫描目录（排除我们自己的应用）
  for (const p of checkPaths) {
    try {
      // 排除我们自己的应用
      if (p.includes('openclaw-security-scanner')) continue;
      
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          foundPaths.directories.push(p);
          if (p.includes('.openclaw') && p.includes(homeDir) && !p.includes('backup')) {
            foundPaths.configDir = p;
          }
          log.info(`扫描到目录: ${p}`);
        } else {
          foundPaths.files.push(p);
          log.info(`扫描到文件: ${p}`);
        }
      }
    } catch (e) {
      log.warn(`扫描路径失败: ${p} - ${e.message}`);
    }
  }
  
  // 扫描备份目录（包括所有 openclaw-backup、openclaw-autoclaw、openclaw.backup 等）
  try {
    log.info('开始扫描备份目录...');
    // 使用 find 命令扫描所有备份目录
    const backupDirs = safeExecFile('find', [homeDir, '-maxdepth', '2', '-name', '.openclaw*', '-type', 'd'], { timeout: 5000 });
    if (backupDirs && backupDirs.trim()) {
      const dirs = backupDirs.trim().split('\n').filter(Boolean);
      for (const dir of dirs) {
        // 排除我们自己的应用和主配置目录（主目录已经在上面扫描过了）
        if (!dir.includes('openclaw-security-scanner') && 
            !dir.endsWith('.openclaw') && 
            !dir.endsWith('.Openclaw')) {
          foundPaths.directories.push(dir);
          foundPaths.backupDirs.push(dir);
          log.info(`扫描到备份目录: ${dir}`);
        }
      }
    } else {
      log.info('未找到备份目录');
    }
  } catch (e) {
    log.warn('扫描备份目录失败:', e.message);
  }
  
  // 扫描偏好设置文件
  try {
    const prefsDir = `${homeDir}/Library/Preferences`;
    if (fs.existsSync(prefsDir)) {
      const files = fs.readdirSync(prefsDir);
      for (const file of files) {
        if (file.toLowerCase().includes('openclaw') && file.endsWith('.plist') && 
            !file.includes('openclaw-security-scanner')) {
          const fullPath = path.join(prefsDir, file);
          foundPaths.files.push(fullPath);
          log.info(`扫描到偏好设置: ${fullPath}`);
        }
      }
    }
  } catch (e) {
    log.warn('扫描偏好设置失败:', e.message);
  }
  
  // 扫描 WebKit 目录
  try {
    const webkitDir = `${homeDir}/Library/WebKit`;
    if (fs.existsSync(webkitDir)) {
      const files = fs.readdirSync(webkitDir);
      for (const file of files) {
        if (file.toLowerCase().includes('openclaw') && !file.includes('openclaw-security-scanner')) {
          const fullPath = path.join(webkitDir, file);
          foundPaths.directories.push(fullPath);
          log.info(`扫描到 WebKit 数据: ${fullPath}`);
        }
      }
    }
  } catch (e) {
    log.warn('扫描 WebKit 目录失败:', e.message);
  }
  
  // 扫描 Saved Application State
  try {
    const stateDir = `${homeDir}/Library/Saved Application State`;
    if (fs.existsSync(stateDir)) {
      const files = fs.readdirSync(stateDir);
      for (const file of files) {
        if (file.toLowerCase().includes('openclaw') && !file.includes('openclaw-security-scanner')) {
          const fullPath = path.join(stateDir, file);
          foundPaths.directories.push(fullPath);
          log.info(`扫描到应用状态: ${fullPath}`);
        }
      }
    }
  } catch (e) {
    log.warn('扫描应用状态失败:', e.message);
  }
  
  log.info(`扫描完成: 发现 ${foundPaths.directories.length} 个目录, ${foundPaths.files.length} 个文件`);
  if (foundPaths.backupDirs.length > 0) {
    log.info(`其中备份目录: ${foundPaths.backupDirs.length} 个`);
  }
  return foundPaths;
}

// 使用 rm -rf 命令删除路径（终极版，包含验证和重试）
function deleteWithRmRf(paths) {
  const { execFileSync } = require('child_process');
  const cleaned = [];
  const failed = [];
  
  // 过滤掉我们自己的应用和空路径
  const pathsToDelete = paths.filter(p => p && !p.includes('openclaw-security-scanner'));
  
  log.info(`========== 使用 rm -rf 删除 ${pathsToDelete.length} 个路径 ==========`);
  
  for (const p of pathsToDelete) {
    try {
      log.info(`删除路径: ${p}`);
      
      // 检查路径是否存在
      if (!fs.existsSync(p)) {
        log.info(`  - 路径不存在，跳过: ${p}`);
        cleaned.push(p); // 视为已清理
        continue;
      }
      
      // 获取路径信息（用于日志）
      try {
        const stat = fs.statSync(p);
        log.info(`  - 路径类型: ${stat.isDirectory() ? '目录' : '文件'}, 大小: ${stat.size} bytes`);
      } catch (e) {
        log.warn(`  - 无法获取路径信息: ${e.message}`);
      }
      
      // 如果是配置目录或备份目录，强制删除
      if (p.includes('.openclaw')) {
        const isConfig = p.endsWith('.openclaw') || p.endsWith('.Openclaw');
        const isBackup = p.includes('.openclaw-backup') || p.includes('.openclaw.autoclaw') || p.includes('.openclaw.backup');
        
        if (isConfig || isBackup) {
          log.info(`  → 发现${isConfig ? '配置' : '备份'}目录，执行强制删除: ${p}`);
          
          // 先尝试普通 rm -rf
          try {
            execFileSync('rm', ['-rf', p], {
              encoding: 'utf8',
              timeout: 10000,
              stdio: 'pipe'
            });
            
            // 验证是否删除成功
            if (!fs.existsSync(p)) {
              log.info(`  ✓ rm -rf 成功: ${p}`);
              cleaned.push(p);
              continue;
            } else {
              log.warn(`  ⚠ rm -rf 执行后目录仍然存在`);
            }
          } catch (rmError) {
            log.warn(`  ⚠ rm -rf 失败: ${rmError.message}`);
          }
          
          // 如果普通 rm -rf 失败，尝试 sudo rm -rf
          log.info(`  → 尝试 sudo rm -rf: ${p}`);
          try {
            execFileSync('sudo', ['rm', '-rf', p], {
              encoding: 'utf8',
              timeout: 10000,
              stdio: 'pipe'
            });
            
            // 验证是否删除成功
            if (!fs.existsSync(p)) {
              log.info(`  ✓ sudo rm -rf 成功: ${p}`);
              cleaned.push(p);
              continue;
            } else {
              log.error(`  ✗ sudo rm -rf 执行后目录仍然存在`);
              failed.push(`${p} (sudo rm -rf 执行后目录仍然存在)`);
              continue;
            }
          } catch (sudoError) {
            log.error(`  ✗ sudo rm -rf 失败: ${sudoError.message}`);
            failed.push(`${p} (rm -rf 和 sudo rm -rf 都失败: ${sudoError.message})`);
            continue;
          }
        }
      }
      
      // 其他路径的正常删除流程
      // 先尝试普通 rm -rf
      try {
        execFileSync('rm', ['-rf', p], {
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // 验证是否删除成功
        if (!fs.existsSync(p)) {
          log.info(`  ✓ rm -rf 成功: ${p}`);
          cleaned.push(p);
          continue;
        } else {
          log.warn(`  ⚠ rm -rf 执行后路径仍然存在`);
        }
      } catch (rmError) {
        log.warn(`  ⚠ rm -rf 失败: ${rmError.message}，尝试 sudo rm -rf`);
      }
      
      // 如果普通 rm -rf 失败，尝试 sudo rm -rf
      try {
        execFileSync('sudo', ['rm', '-rf', p], {
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // 验证是否删除成功
        if (!fs.existsSync(p)) {
          log.info(`  ✓ sudo rm -rf 成功: ${p}`);
          cleaned.push(p);
        } else {
          log.error(`  ✗ sudo rm -rf 执行后路径仍然存在`);
          failed.push(`${p} (sudo rm -rf 执行后路径仍然存在)`);
        }
      } catch (sudoError) {
        log.error(`  ✗ sudo rm -rf 也失败: ${sudoError.message}`);
        failed.push(`${p} (rm -rf 和 sudo rm -rf 都失败)`);
      }
    } catch (e) {
      log.error(`  ✗ 删除异常: ${p} - ${e.message}`);
      failed.push(`${p} (${e.message})`);
    }
  }
  
  log.info(`删除完成: ${cleaned.length} 个成功, ${failed.length} 个失败`);
  
  const result = { success: true, cleaned, failed };
  if (failed.length > 0) {
    result.success = false;
    result.error = `部分路径删除失败: ${failed.join(', ')}`;
  }
  
  return result;
}

// 清理残留文件（新版：先扫描，再使用命令删除）
function cleanupResidualFiles() {
  try {
    log.info('开始扫描 Openclaw 相关路径...');
    
    // 步骤1: 扫描所有相关路径
    const pathsToDelete = scanOpenclawPaths();
    
    if (pathsToDelete.directories.length === 0 && pathsToDelete.files.length === 0) {
      log.info('未发现 Openclaw 相关路径，无需清理');
      return { success: true, cleaned: [], message: '未发现需要清理的路径' };
    }
    
    // 显示将要删除的路径
    log.info(`发现 ${pathsToDelete.directories.length} 个目录和 ${pathsToDelete.files.length} 个文件需要删除`);
    pathsToDelete.directories.forEach(p => log.info(`待删除目录: ${p}`));
    pathsToDelete.files.forEach(p => log.info(`待删除文件: ${p}`));
    
    // 步骤2: 使用 rm -rf 命令删除所有路径
    const allPaths = [...pathsToDelete.directories, ...pathsToDelete.files];
    const deleteResult = deleteWithRmRf(allPaths);
    
    // 步骤3: 验证配置目录是否已删除
    if (pathsToDelete.configDir) {
      const configExists = fs.existsSync(pathsToDelete.configDir);
      if (configExists) {
        log.error(`验证失败: 配置目录仍然存在 - ${pathsToDelete.configDir}`);
        deleteResult.success = false;
        deleteResult.configStillExists = true;
        if (!deleteResult.error) {
          deleteResult.error = `配置目录删除失败: ${pathsToDelete.configDir}`;
        }
      } else {
        log.info(`验证成功: 配置目录已删除 - ${pathsToDelete.configDir}`);
      }
    }
    
    return deleteResult;
  } catch (error) {
    log.error('清理残留文件失败:', error);
    log.error('错误堆栈:', error.stack);
    return { success: false, error: error.message, stack: error.stack };
  }
}

// 一键修复所有风险
async function fixAllRisks() {
  try {
    log.info('开始一键修复所有风险...');
    
    const results = [];
    
    // 按风险等级顺序修复
    const fixOrder = [
      'kill_processes',    // 先终止进程
      'block_network',     // 再阻断网络
      'remove_services',   // 移除服务
      'uninstall_app',     // 卸载应用
      'cleanup_files'      // 最后清理文件
    ];
    
    for (const fixType of fixOrder) {
      try {
        let result;
        switch (fixType) {
          case 'kill_processes':
            result = killOpenclawProcesses(); // 同步函数
            log.info(`终止进程结果: ${result.success ? '成功' : '失败'}`);
            break;
          case 'block_network':
            result = blockOpenclawNetwork(); // 同步函数
            log.info(`阻断网络结果: ${result.success ? '成功' : '失败'}`);
            break;
          case 'remove_services':
            result = removeOpenclawServices(); // 同步函数
            log.info(`移除服务结果: ${result.success ? '成功' : '失败'}`);
            break;
          case 'uninstall_app':
            result = await uninstallOpenclawApp(); // 异步函数
            log.info(`卸载应用结果: ${result.success ? '成功' : '失败'}`);
            break;
          case 'cleanup_files':
            result = cleanupResidualFiles(); // 同步函数
            log.info(`清理文件结果: ${result.success ? '成功' : '失败'}`);
            break;
        }
        
        results.push({
          fixType,
          success: result.success,
          message: result.message || result.error || '完成'
        });
        
        // 每个修复之间等待一下
        await new Promise(r => setTimeout(r, 500));
        
      } catch (error) {
        log.error(`修复 ${fixType} 失败:`, error);
        results.push({
          fixType,
          success: false,
          message: error.message
        });
      }
    }
    
    // 验证修复结果 - 使用正确的风险过滤逻辑
    const finalScan = await performScan();
    
    // 正确计算剩余风险：只计算实际的风险（critical, warning, info），不包括safe状态
    const remainingRisks = finalScan.risks.filter(r => 
      r.level === 'critical' || r.level === 'warning' || r.level === 'info'
    );
    
    log.info('一键修复完成，剩余风险:', remainingRisks.length);
    
    return {
      success: remainingRisks.length === 0,
      results,
      remainingRisks: remainingRisks.length,
      finalScan: finalScan
    };
  } catch (error) {
    log.error('一键修复失败:', error);
    return { success: false, error: error.message };
  }
}

// 检测Openclaw启动项和系统服务 - 使用mac命令实时扫描
function checkOpenclawServices() {
  try {
    // 实时日志：开始扫描系统服务
    log.info('🔧 开始扫描Openclaw系统服务...');
    
    const services = [];
    
    // 1. 检查launchd服务
    log.info('📋 步骤1: 扫描launchd服务...');
    try {
      const launchdList = safeExecFile('launchctl', ['list'], { timeout: 3000 });
      const launchdResult = launchdList
        .split('\n')
        .filter((l) => /openclaw/i.test(l))
        .join('\n');
      if (launchdResult.trim()) {
        log.info('🚨 发现Openclaw launchd服务');
        launchdResult.trim().split('\n').forEach(service => {
          log.info(`  服务: ${service}`);
          services.push({
            type: 'launchd',
            name: 'Openclaw Launchd服务',
            description: '系统启动时自动运行的服务',
            details: service,
            level: 'critical'
          });
        });
      }
    } catch (e) {
      log.info('✓ launchd服务扫描完成');
    }
    
    // 2. 检查登录项
    log.info('📋 步骤2: 扫描登录项...');
    try {
      const loginItems = safeExecFile(
        'osascript',
        ['-e', 'tell application "System Events" to get the name of every login item'],
        { timeout: 5000 }
      );
      if (loginItems.toLowerCase().includes('openclaw')) {
        log.info('🚨 发现Openclaw登录项');
        services.push({
          type: 'login_item',
          name: 'Openclaw登录项',
          description: '用户登录时自动启动',
          details: loginItems.trim(),
          level: 'critical'
        });
      }
    } catch (e) {
      log.info('✓ 登录项扫描完成');
    }
    
    // 3. 检查启动代理和守护进程文件
    const launchPaths = [
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      `${process.env.HOME}/Library/LaunchAgents`
    ];
    
    for (const launchPath of launchPaths) {
      try {
        const agents = safeExecFile(
          'find',
          [launchPath, '-name', '*openclaw*', '-o', '-name', '*OpenClaw*'],
          { timeout: 3000 }
        );
        if (agents.trim()) {
          agents.trim().split('\n').forEach(agent => {
            if (agent.trim()) {
              log.info(`  启动文件: ${agent}`);
              services.push({
                type: launchPath.includes('Daemon') ? 'launch_daemon' : 'launch_agent',
                name: `Openclaw ${launchPath.includes('Daemon') ? '守护进程' : '启动代理'}`,
                description: `系统启动时自动运行的${launchPath.includes('Daemon') ? '守护进程' : '代理'}`,
                details: agent,
                level: 'critical'
              });
            }
          });
        }
      } catch (e) {
        // 忽略错误
      }
    }
    
    // 统计扫描结果
    const criticalServices = services.filter(s => s.level === 'critical').length;
    const warningServices = services.filter(s => s.level === 'warning').length;
    
    log.info(`📊 系统服务扫描完成:`);
    log.info(`  - 总计发现: ${services.length} 个服务/启动项`);
    log.info(`  - 严重风险: ${criticalServices} 个`);
    log.info(`  - 警告风险: ${warningServices} 个`);
    
    return { 
      services, 
      count: services.length,
      critical: criticalServices,
      warning: warningServices 
    };
  } catch (error) {
    log.error('❌ 系统服务扫描失败:', error.message);
    return { 
      services: [], 
      count: 0, 
      critical: 0,
      warning: 0,
      error: error.message 
    };
  }
}

// 综合验证卸载结果 - 对齐用户提供的6个检查命令
function verifyUninstallComplete() {
  const results = {
    commandCleared: true,
    npmPackageCleared: true,
    mainFileDeleted: true,
    noRunningProcess: true,
    portReleased: true,
    noConfig: true,
    details: []
  };

  try {
    log.info('========== 验证卸载结果 ==========');

    // 1. 命令检查: which openclaw
    try {
      const whichResult = safeExecFile('which', ['openclaw'], { timeout: 3000 });
      if (whichResult && whichResult.toString().trim()) {
        results.commandCleared = false;
        results.details.push(`❌ 命令未清除: ${whichResult.toString().trim()}`);
        log.info(`❌ 未干净 - 命令仍存在: ${whichResult.toString().trim()}`);
      } else {
        results.details.push('✅ 命令已清除');
        log.info('✅ 命令已清除');
      }
    } catch {
      results.details.push('✅ 命令已清除');
      log.info('✅ 命令已清除');
    }

    // 2. npm 包检查: npm list -g --depth=0 | grep openclaw
    try {
      const npmList = safeExecFile('npm', ['list', '-g', '--depth=0'], { timeout: 5000 });
      if (/openclaw/i.test(npmList)) {
        results.npmPackageCleared = false;
        const match = npmList.match(/openclaw[^\n]*/i);
        results.details.push(`❌ npm包未清除: ${match ? match[0] : '未知'}`);
        log.info(`❌ 未干净 - npm包仍存在`);
      } else {
        results.details.push('✅ npm包已清除');
        log.info('✅ npm包已清除');
      }
    } catch {
      results.details.push('✅ npm包已清除');
      log.info('✅ npm包已清除');
    }

    // 3. 主文件检查: ls /opt/homebrew/bin/openclaw
    const mainPaths = ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw'];
    for (const p of mainPaths) {
      try {
        if (fs.existsSync(p)) {
          results.mainFileDeleted = false;
          results.details.push(`❌ 主文件未删除: ${p}`);
          log.info(`❌ 未干净 - 主文件仍存在: ${p}`);
          break;
        }
      } catch {
        // 忽略
      }
    }
    if (results.mainFileDeleted) {
      results.details.push('✅ 主文件已删除');
      log.info('✅ 主文件已删除');
    }

    // 4. 进程检查: ps aux | grep "[o]penclaw"
    try {
      const psResult = safeExecFile('ps', ['aux'], { timeout: 3000 });
      const hasProcess = psResult
        .split('\n')
        .some((line) => {
          if (!/openclaw/i.test(line)) return false;
          if (/grep.*openclaw/i.test(line)) return false;
          return !SELF_EXCLUDE_PATTERNS.some(p => p.test(line));
        });
      
      if (hasProcess) {
        results.noRunningProcess = false;
        results.details.push('❌ 有运行进程');
        log.info('❌ 未干净 - 有运行进程');
      } else {
        results.details.push('✅ 无运行进程');
        log.info('✅ 无运行进程');
      }
    } catch {
      results.details.push('✅ 无运行进程');
      log.info('✅ 无运行进程');
    }

    // 5. 端口检查: lsof -i :18789
    try {
      const portResult = safeExecFile('lsof', ['-i', ':18789'], { timeout: 3000 });
      if (portResult && portResult.trim()) {
        results.portReleased = false;
        results.details.push('❌ 端口18789未释放');
        log.info('❌ 未干净 - 端口18789未释放');
      } else {
        results.details.push('✅ 端口已释放');
        log.info('✅ 端口已释放');
      }
    } catch {
      results.details.push('✅ 端口已释放');
      log.info('✅ 端口已释放');
    }

    // 6. 配置检查: ls ~/.openclaw
    const configPath = path.join(process.env.HOME, '.openclaw');
    try {
      if (fs.existsSync(configPath)) {
        results.noConfig = false;
        results.details.push('⚠️  配置残留（可选清理）');
        log.info(`⚠️  配置残留: ${configPath}（可选清理）`);
      } else {
        results.details.push('✅ 无配置');
        log.info('✅ 无配置');
      }
    } catch {
      results.details.push('✅ 无配置');
      log.info('✅ 无配置');
    }

    // 汇总结果
    const allClean = results.commandCleared && 
                     results.npmPackageCleared && 
                     results.mainFileDeleted && 
                     results.noRunningProcess && 
                     results.portReleased;
    
    results.success = allClean;
    
    if (allClean) {
      log.info('========== ✅ 验证通过 ==========');
    } else {
      log.info('========== ❌ 验证未通过 ==========');
    }

  } catch (error) {
    log.error('验证过程出错:', error.message);
    results.error = error.message;
    results.success = false;
  }

  return results;
}

// 执行安全扫描 - 对齐6项检查（已禁用桌面应用检查）
async function performScan() {
  log.info('开始安全扫描...');
  
  try {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('扫描超时')), 15000)
    );
    
    const scanPromise = (async () => {
      log.info('开始扫描步骤...');
      
      // 步骤0: 获取系统信息
      log.info('步骤0: 获取系统信息');
      const systemInfo = getSystemInfo();
      
      // 步骤1: 扫描 CLI 安装信息 (命令/npm包/配置)
      log.info('步骤1: 扫描Openclaw CLI');
      const cliInfo = scanOpenclawCli();
      
      // 步骤2: 扫描运行进程
      log.info('步骤2: 扫描运行进程');
      const processInfo = checkOpenclawRunning();
      
      // 步骤3: 检测网络连接和端口
      log.info('步骤3: 检测网络连接');
      const networkInfo = checkOpenclawNetwork();
      
      // 步骤4: 检测系统服务
      log.info('步骤4: 检测系统服务');
      const serviceInfo = checkOpenclawServices();
      
      // 分析风险
      const risks = [];
      
      // 1. CLI 风险
      if (cliInfo.installed) {
        const installPaths = [
          cliInfo.path && `安装路径: ${cliInfo.path}`,
          cliInfo.realPath && `真实路径: ${cliInfo.realPath}`,
          cliInfo.npmGlobalPath && `NPM全局路径: ${cliInfo.npmGlobalPath}`
        ].filter(Boolean).join('\n');
        
        risks.push({
          id: 'cli_installed',
          name: 'Openclaw CLI 已安装',
          level: 'critical',
          description: `路径: ${cliInfo.path}`,
          detail: `Openclaw CLI 已安装在系统中\n版本: ${cliInfo.version || '未知'}\n${installPaths}`,
          canFix: true,
          fixType: 'uninstall_cli',
          fixDescription: '卸载 Openclaw CLI'
        });
      }
      
      // 2. 运行进程风险
      if (processInfo.running && processInfo.count > 0) {
        const processDetails = processInfo.detailedProcesses.map(proc => 
          `PID: ${proc.pid} | 命令: ${proc.command} ${proc.args}`
        ).join('\n');
        
        risks.push({
          id: 'running_processes',
          name: 'Openclaw进程正在运行',
          level: 'critical',
          description: `检测到 ${processInfo.count} 个活跃进程`,
          detail: `发现 ${processInfo.count} 个Openclaw相关进程在后台运行:\n${processDetails}`,
          canFix: true,
          fixType: 'kill_processes',
          fixDescription: '终止所有Openclaw进程'
        });
      }
      
      // 3. 网络连接/端口风险
      if (networkInfo.connected || networkInfo.port18789InUse) {
        const networkDetails = networkInfo.detailedConnections.map(conn => {
          const portInfo = conn.name || '未知端口';
          return `PID: ${conn.pid} | 进程: ${conn.command} | 连接: ${portInfo}`;
        }).join('\n');
        
        const connectionCount = networkInfo.detailedConnections.length;
        
        risks.push({
          id: 'network_connections',
          name: 'Openclaw网络活动',
          level: 'critical',
          description: networkInfo.port18789InUse ? '端口 18789 被占用' : `检测到 ${connectionCount} 个网络连接`,
          detail: `Openclaw正在使用网络资源:\n${networkDetails}`,
          canFix: true,
          fixType: 'block_network',
          fixDescription: '阻断网络连接'
        });
      }
      
      // 4. 系统服务风险
      if (serviceInfo.count > 0) {
        const criticalServices = serviceInfo.services.filter(s => s.level === 'critical');
        if (criticalServices.length > 0) {
          const serviceDetails = criticalServices.map(service => {
            const servicePath = service.details || service.name;
            return `${service.type}: ${servicePath}`;
          }).join('\n');
          
          risks.push({
            id: 'critical_services',
            name: 'Openclaw系统服务',
            level: 'critical',
            description: `发现 ${criticalServices.length} 个关键系统服务`,
            detail: `发现 ${criticalServices.length} 个关键系统服务/启动项:\n${serviceDetails}`,
            canFix: true,
            fixType: 'remove_services',
            fixDescription: '移除系统服务'
          });
        }
      }
      
      // 5. 配置残留风险
      if (cliInfo.configExists) {
        const configFiles = [];
        try {
          const files = fs.readdirSync(cliInfo.configPath).slice(0, 10); // 显示前10个文件
          configFiles.push(...files.map(f => `  - ${f}`));
          if (fs.readdirSync(cliInfo.configPath).length > 10) {
            configFiles.push('  ... (更多文件)');
          }
        } catch (e) {
          configFiles.push('  (无法读取目录内容)');
        }
        
        risks.push({
          id: 'config_residual',
          name: '配置文件残留',
          level: 'warning',
          description: `配置目录: ${cliInfo.configPath}`,
          detail: `Openclaw CLI 已卸载但配置文件仍存在\n\n配置文件列表:\n${configFiles.join('\n')}`,
          canFix: true,
          fixType: 'cleanup_files',
          fixDescription: '清理配置文件'
        });
      }
      
      // 6. 安全状态
      const hasActualRisks = risks.length > 0 && risks.some(r => r.level === 'critical' || r.level === 'warning' || r.level === 'info');
      if (!hasActualRisks) {
        risks.push({
          id: 'safe_status',
          name: '系统安全',
          level: 'safe',
          description: '未发现Openclaw相关风险',
          detail: '当前系统已清除所有Openclaw相关组件',
          canFix: false,
          fixDescription: '无需修复'
        });
      }
      
      // 计算统计信息
      const criticalRisks = risks.filter(r => r.level === 'critical').length;
      const warningRisks = risks.filter(r => r.level === 'warning').length;
      const infoRisks = risks.filter(r => r.level === 'info').length;
      const fixableRisks = risks.filter(r => r.canFix).length;
      const totalActualRisks = criticalRisks + warningRisks + infoRisks;
      
      log.info('扫描完成，发现风险:', totalActualRisks, '可修复风险:', fixableRisks);
      
      return {
        scanTime: new Date().toISOString(),
        systemInfo,
        cliInfo,
        processInfo,
        networkInfo,
        serviceInfo,
        risks,
        critical: criticalRisks,
        warning: warningRisks,
        info: infoRisks,
        fixable: fixableRisks,
        totalRisks: totalActualRisks
      };
    })();
    
    return await Promise.race([scanPromise, timeoutPromise]);
    
  } catch (error) {
    log.error('扫描过程出错:', error);
    
    return {
      scanTime: new Date().toISOString(),
      systemInfo: getSystemInfo(),
      cliInfo: { installed: false },
      processInfo: { running: false, count: 0, processes: [], detailedProcesses: [] },
      networkInfo: { connected: false, connections: [], port18789InUse: false },
      serviceInfo: { services: [], count: 0 },
      risks: [
        {
          id: 'scan_error',
          name: '扫描过程出错',
          level: 'warning',
          description: error.message || '扫描过程中发生错误',
          detail: '请检查系统权限或重试扫描。',
          canFix: false
        }
      ],
      totalRisks: 0,
      error: error.message
    };
  }
}

// 实时日志传递函数
function sendTerminalLog(message, type = 'info') {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('terminal-log', {
      message: message,
      type: type,
      timestamp: new Date().toISOString()
    });
  }
}

// 重写日志函数，确保所有日志都传递给前端
const originalLogInfo = log.info;
const originalLogError = log.error;
const originalLogWarn = log.warn;

log.info = function(...args) {
  originalLogInfo.apply(log, args);
  const message = args.map(arg => String(arg)).join(' ');
  sendTerminalLog(message, 'info');
};

log.error = function(...args) {
  originalLogError.apply(log, args);
  const message = args.map(arg => String(arg)).join(' ');
  sendTerminalLog(message, 'error');
};

log.warn = function(...args) {
  originalLogWarn.apply(log, args);
  const message = args.map(arg => String(arg)).join(' ');
  sendTerminalLog(message, 'warning');
};

// 添加自定义日志级别
log.success = function(...args) {
  const message = args.map(arg => String(arg)).join(' ');
  originalLogInfo.apply(log, ['✓ ' + message]);
  sendTerminalLog('✓ ' + message, 'success');
};

// IPC处理器
ipcMain.handle('perform-scan', async () => {
  return performScan();
});

ipcMain.handle('fix-risk', async (event, fixType) => {
  log.info('执行修复:', fixType);
  
  switch (fixType) {
    case 'kill_processes':
      return killOpenclawProcesses();
    case 'block_network':
      return blockOpenclawNetwork();
    case 'remove_services':
      return removeOpenclawServices();
    case 'uninstall_app':
      return uninstallOpenclawApp();
    case 'cleanup_files':
      return cleanupResidualFiles();
    case 'fix_all':
      return fixAllRisks();
    default:
      return { success: false, error: '未知的修复类型' };
  }
});



app.whenReady().then(() => {
  createWindow();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
