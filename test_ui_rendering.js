// UI渲染测试脚本
const electron = require('electron');
if (!electron || typeof electron === 'string' || !electron.app) {
  console.error('请使用 Electron 运行此脚本：npm run test:ui');
  process.exit(1);
}

const { app, BrowserWindow } = electron;
const path = require('path');

// 创建测试窗口来验证UI渲染
function createTestWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // 加载主页面
  mainWindow.loadFile('index.html');

  // 窗口准备好后执行测试
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('=== 测试UI渲染状态 ===');
    
    // 模拟扫描完成后的数据
    const mockScanResult = {
      risks: [
        {
          id: 'openclaw_service_1',
          name: 'Openclaw系统服务',
          description: '检测到Openclaw后台服务正在运行',
          level: 'critical',
          canFix: true,
          fixType: 'stop_service'
        },
        {
          id: 'openclaw_launchd_1',
          name: 'Openclaw启动代理',
          description: '检测到Openclaw启动代理文件',
          level: 'critical',
          canFix: true,
          fixType: 'remove_file'
        }
      ],
      critical: 2,
      warning: 0,
      info: 0,
      fixable: 2,
      totalRisks: 2,
      installInfo: { installed: true, path: '/Applications/Openclaw.app' }
    };

    // 注入测试数据到前端
    mainWindow.webContents.executeJavaScript(`
      console.log('注入测试数据...');
      
      // 模拟扫描完成状态
      currentRisks = ${JSON.stringify(mockScanResult.risks)};
      renderRiskList(currentRisks);
      
      // 更新安全评分（与当前 UI 逻辑一致）
      const securityScore = Math.max(0, 100 - (${mockScanResult.critical} * 25) - (${mockScanResult.warning} * 10) - (${mockScanResult.info} * 2));
      updateSecurityStatus(securityScore, ${mockScanResult.critical} > 0 ? 'danger' : (${mockScanResult.warning} > 0 ? 'warning' : 'safe'));
      
      // 更新状态
      const statusDot = document.getElementById('statusDot');
      const statusText = document.getElementById('statusText');
      
      statusDot.className = 'status-dot danger';
      statusText.textContent = '发现 2 个严重威胁';
      
      console.log('测试数据注入完成');
      console.log('风险列表元素:', document.getElementById('risksList').innerHTML);
      console.log('状态文本:', statusText.textContent);
    `);
  });
}

// 启动应用
app.whenReady().then(() => {
  createTestWindow();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createTestWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});