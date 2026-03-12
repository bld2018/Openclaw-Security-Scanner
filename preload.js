const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  performScan: () => ipcRenderer.invoke('perform-scan'),
  fixRisk: (fixType) => ipcRenderer.invoke('fix-risk', fixType),
  
  // 添加终端日志监听
  onTerminalLog: (callback) => {
    ipcRenderer.on('terminal-log', (event, logData) => {
      callback(logData);
    });
  },
  
  // 移除监听器
  removeTerminalLogListener: () => {
    ipcRenderer.removeAllListeners('terminal-log');
  }
});
