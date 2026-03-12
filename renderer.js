// 全局变量
let isScanning = false;
let currentRisks = [];
let installInfo = null;
let waitingTimer = null;
let waitingSeconds = 0;

// DOM 元素
const btnScan = document.getElementById('btnScan');
const btnUninstall = document.getElementById('btnUninstall');
const terminalContent = document.getElementById('terminalContent');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const scoreValue = document.getElementById('scoreValue');
const progressFill = document.getElementById('progressFill');
const risksSection = document.getElementById('risksSection');
const risksList = document.getElementById('risksList');
const waitingIndicator = document.getElementById('waitingIndicator');
const waitingCountdown = document.getElementById('waitingCountdown');
const btnClearLog = document.getElementById('btnClearLog');
const toast = document.getElementById('toast');

// 模态框元素
const riskModal = document.getElementById('riskModal');
const modalTitle = document.getElementById('modalTitle');
const modalRiskName = document.getElementById('modalRiskName');
const modalRiskLevel = document.getElementById('modalRiskLevel');
const modalDescription = document.getElementById('modalDescription');
const modalDetail = document.getElementById('modalDetail');
const modalFixDescription = document.getElementById('modalFixDescription');
const modalClose = document.getElementById('modalClose');
const modalFix = document.getElementById('modalFix');

const MAX_LOG_ENTRIES = 500;
let pendingLogs = [];
let flushScheduled = false;

// 初始化终端日志监听
function initTerminalListener() {
  if (window.electronAPI && window.electronAPI.onTerminalLog) {
    window.electronAPI.onTerminalLog((logData) => {
      enqueueTerminalLog(logData.message, logData.type);

      // 根据后端日志同步更新时间线
      const message = String(logData.message || '').toLowerCase();

      if (message.includes('步骤1') || message.includes('检测openclaw安装状态')) {
        updateTimeline(0, 'active', '正在扫描系统应用程序目录...');
      } else if (message.includes('步骤2') || message.includes('扫描运行进程')) {
        updateTimeline(0, 'completed', '✓ 已完成安装检测');
        updateTimeline(1, 'active', '正在枚举系统后台进程列表...');
      } else if (message.includes('步骤3') || message.includes('检测网络连接')) {
        updateTimeline(1, 'completed', '✓ 已完成进程扫描');
        updateTimeline(2, 'active', '正在检测网络活动...');
      } else if (message.includes('步骤4') || message.includes('检测系统服务')) {
        updateTimeline(2, 'completed', '✓ 已完成网络检测');
        updateTimeline(3, 'active', '正在扫描系统服务...');
      } else if (message.includes('步骤5') || message.includes('分析扫描结果')) {
        updateTimeline(3, 'completed', '✓ 已完成服务检测');
      }
    });
  }
}

function enqueueTerminalLog(message, type = 'info') {
  pendingLogs.push({ message, type });
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const batch = pendingLogs;
    pendingLogs = [];
    for (const item of batch) addTerminalLog(item.message, item.type);
  });
}

// 添加终端日志
function addTerminalLog(message, type = 'info') {
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${type}`;

  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  let safeMessage = escapeHtml(String(message ?? ''));
  // 如果是 Openclaw 相关信息，整条消息用橙色高亮
  if (/openclaw/i.test(safeMessage)) {
    safeMessage = `<span class="log-accent">${safeMessage}</span>`;
  } else {
    // 否则只高亮关键字：找到 / 发现 / 指向 / Openclaw 版本
    safeMessage = safeMessage.replace(/(找到|发现|指向|Openclaw 版本)/g, '<span class="log-accent">$1</span>');
  }

  logEntry.innerHTML = `
    <span class="timestamp">[${timestamp}]</span>
    <span class="message">${safeMessage}</span>
  `;

  terminalContent.appendChild(logEntry);

  // 控制日志数量，避免长期运行导致渲染越来越卡
  while (terminalContent.children.length > MAX_LOG_ENTRIES) {
    terminalContent.removeChild(terminalContent.firstElementChild);
  }

  terminalContent.scrollTop = terminalContent.scrollHeight;
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 更新时间线
function updateTimeline(step, status, description) {
  const timelineItems = document.querySelectorAll('.timeline-item');
  timelineItems.forEach((item, index) => {
    if (index === step) {
      item.className = `timeline-item ${status}`;
      const desc = item.querySelector('.timeline-desc');
      if (desc) desc.textContent = description;
    }
  });
}

// 重置时间线
function resetTimeline() {
  const timelineItems = document.querySelectorAll('.timeline-item');
  timelineItems.forEach((item) => {
    item.className = 'timeline-item';
    const desc = item.querySelector('.timeline-desc');
    if (desc) desc.textContent = '等待开始...';
  });
}

// 显示等待提示
function showWaitingIndicator() {
  waitingIndicator.classList.add('visible');
  waitingSeconds = 0;
  waitingCountdown.textContent = '0s';
  waitingTimer = setInterval(() => {
    waitingSeconds++;
    waitingCountdown.textContent = waitingSeconds + 's';
  }, 1000);
}

// 隐藏等待提示
function hideWaitingIndicator() {
  waitingIndicator.classList.remove('visible');
  if (waitingTimer) {
    clearInterval(waitingTimer);
    waitingTimer = null;
  }
}

// 显示 Toast
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// 更新安全状态
function updateSecurityStatus(score, level) {
  scoreValue.textContent = score;
  scoreValue.className = `score-value ${level}`;
  progressFill.style.width = score + '%';
  progressFill.className = `progress-fill ${level}`;
}

// 渲染风险列表
function renderRiskList(risks) {
  if (!risks || risks.length === 0) {
    risksSection.style.display = 'none';
    return;
  }

  // 只显示实际风险（不包括 safe 状态）
  const actualRisks = risks.filter((r) => r.level !== 'safe');

  if (actualRisks.length === 0) {
    risksSection.style.display = 'none';
    return;
  }

  risksSection.style.display = 'block';
  risksList.innerHTML = actualRisks
    .map(
      (risk, index) => `
      <div class="risk-item ${risk.level}" data-risk-index="${index}">
        <div class="risk-header">
          <span class="risk-name">${escapeHtml(String(risk.name ?? ''))}</span>
          <span class="risk-level ${risk.level}">${getLevelText(risk.level)}</span>
        </div>
        <div class="risk-desc">${escapeHtml(String(risk.description ?? ''))}</div>
      </div>
    `
    )
    .join('');
  
  // 添加点击事件
  const riskItems = risksList.querySelectorAll('.risk-item');
  riskItems.forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.riskIndex);
      showRiskDetail(actualRisks[index]);
    });
  });
}

// 获取风险等级文本
function getLevelText(level) {
  const levelMap = {
    critical: '严重',
    warning: '警告',
    info: '信息',
  };
  return levelMap[level] || level;
}

// 显示风险详情模态框
function showRiskDetail(risk) {
  if (!risk) return;
  
  // 填充模态框内容
  modalTitle.textContent = '风险详情';
  modalRiskName.textContent = risk.name || '未知风险';
  modalRiskLevel.textContent = getLevelText(risk.level);
  modalRiskLevel.className = `modal-risk-level ${risk.level}`;
  modalDescription.textContent = risk.description || '暂无描述';
  modalDetail.textContent = risk.detail || '暂无详细信息';
  modalFixDescription.textContent = risk.fixDescription || '暂无修复建议';
  
  // 设置一键修复按钮
  modalFix.onclick = () => {
    hideRiskModal();
    if (risk.canFix) {
      // 调用修复函数
      fixRisk();
    } else {
      showToast('此风险无法自动修复', 'warning');
    }
  };
  
  // 显示模态框
  riskModal.classList.add('show');
}

// 隐藏风险详情模态框
function hideRiskModal() {
  riskModal.classList.remove('show');
}

// 执行扫描
async function performScan() {
  if (isScanning) return;

  // #region agent log
  __dbg('H2', 'renderer.js:performScan:entry', 'performScan called', {
    hasElectronAPI: !!window.electronAPI,
    hasPerformScan: !!(window.electronAPI && window.electronAPI.performScan),
    btnUninstallDisabled: !!btnUninstall?.disabled,
  });
  // #endregion

  isScanning = true;
  btnScan.disabled = true;
  btnScan.classList.add('scanning');
  btnScan.querySelector('span').textContent = '扫描中...';

  resetTimeline();
  currentRisks = [];
  risksSection.style.display = 'none';

  showWaitingIndicator();

  try {
    addTerminalLog('开始安全扫描...', 'info');

    if (!window.electronAPI || !window.electronAPI.performScan) {
      throw new Error('后端扫描接口不可用');
    }

    const result = await window.electronAPI.performScan();

    hideWaitingIndicator();

    if (!result || typeof result !== 'object') {
      throw new Error('后端扫描接口不可用');
    }

    const cliInfo = result.cliInfo;
    const systemInfo = result.systemInfo;
    currentRisks = result.risks || [];

    // #region agent log
    __dbg('H3', 'renderer.js:performScan:result', 'performScan result received', {
      cliInfoInstalled: !!cliInfo?.installed,
      risksCount: currentRisks.length,
      counts: { critical: result.critical || 0, warning: result.warning || 0, info: result.info || 0, fixable: result.fixable || 0 },
    });
    // #endregion

    // 更新时间线完成状态
    updateTimeline(3, 'completed', '✓ 扫描完成');

    // 显示系统信息
    if (systemInfo) {
      addTerminalLog('', 'info');
      addTerminalLog('━━━ 系统信息 ━━━', 'info');
      addTerminalLog(`  系统: macOS ${systemInfo.macOSVersion}`, 'info');
      addTerminalLog(`  架构: ${systemInfo.arch}`, 'info');
      addTerminalLog(`  内存: ${systemInfo.totalMemory}GB`, 'info');
      addTerminalLog(`  用户: ${systemInfo.user}`, 'info');
      addTerminalLog('━━━━━━━━━━━━━━━━', 'info');
    }

    // 显示扫描结果
    const critical = result.critical || 0;
    const warning = result.warning || 0;
    const info = result.info || 0;
    const fixable = result.fixable || 0;

    addTerminalLog('', 'info');
    addTerminalLog('扫描完成！分析结果：', 'success');
    addTerminalLog(`- 严重威胁: ${critical} 个`, critical > 0 ? 'error' : 'success');
    addTerminalLog(`- 警告风险: ${warning} 个`, warning > 0 ? 'warning' : 'success');
    addTerminalLog(`- 信息提示: ${info} 个`, 'info');
    addTerminalLog(`- 可修复风险: ${fixable} 个`, fixable > 0 ? 'warning' : 'success');

    // 显示 Openclaw CLI 安装信息
    if (cliInfo && cliInfo.installed) {
      addTerminalLog('', 'info');
      addTerminalLog('━━━ Openclaw CLI 安装信息 ━━━', 'warning');
      addTerminalLog(`  命令路径: ${cliInfo.path || '未找到'}`, 'info');
      if (cliInfo.version) {
        addTerminalLog(`  版本: ${cliInfo.version}`, 'info');
      }
      if (cliInfo.isLink && cliInfo.realPath) {
        addTerminalLog(`  类型: 软链接 → ${cliInfo.realPath}`, 'info');
      }
      if (cliInfo.npmPackage) {
        addTerminalLog(`  npm 包: ${cliInfo.npmPackage}`, 'info');
      }
      if (cliInfo.configExists) {
        addTerminalLog(`  配置目录: ${cliInfo.configPath} (可清理)`, 'warning');
      }
      addTerminalLog('━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
    } else if (cliInfo && cliInfo.configExists) {
      // CLI 已卸载但配置残留
      addTerminalLog('', 'info');
      addTerminalLog('━━━ Openclaw CLI 状态 ━━━', 'warning');
      addTerminalLog('  ✅ 命令已清除', 'success');
      addTerminalLog(`  ⚠️ 配置残留: ${cliInfo.configPath}`, 'warning');
      addTerminalLog('━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
    } else {
      addTerminalLog('- Openclaw CLI: ✅ 已清除', 'success');
    }

    // 渲染风险列表
    renderRiskList(currentRisks);

    // 计算安全评分
    const securityScore = Math.max(0, 100 - critical * 25 - warning * 10 - info * 2);
    let securityLevel = 'safe';

    if (critical > 0) {
      securityLevel = 'danger';
      statusDot.className = 'status-dot danger';
      statusText.textContent = `发现 ${critical} 个严重威胁`;
    } else if (warning > 0) {
      securityLevel = 'warning';
      statusDot.className = 'status-dot warning';
      statusText.textContent = `发现 ${warning} 个警告风险`;
    } else {
      statusDot.className = 'status-dot ready';
      statusText.textContent = '系统安全';
    }

    updateSecurityStatus(securityScore, securityLevel);

    showToast('扫描完成', critical > 0 ? 'error' : warning > 0 ? 'warning' : 'success');
  } catch (error) {
    hideWaitingIndicator();
    addTerminalLog('扫描失败: ' + (error?.message || '未知错误'), 'error');
    showToast('扫描失败', 'error');

    // #region agent log
    __dbg('H4', 'renderer.js:performScan:error', 'performScan threw error', {
      message: String(error?.message || 'unknown'),
      hasElectronAPI: !!window.electronAPI,
    });
    // #endregion
  } finally {
    isScanning = false;
    btnScan.disabled = false;
    btnScan.classList.remove('scanning');
    btnScan.querySelector('span').textContent = '🔍 一键扫描';
    // 扫描结束后卸载按钮恢复可用（无论是否安装），主逻辑内部会自行判断是否已安装
    btnUninstall.disabled = false;
  }
}

// 一键卸载
async function fixRisk() {
  if (!confirm('确定要卸载 Openclaw 吗？这将：\n1. 卸载 CLI 应用\n2. 终止所有相关进程\n3. 清理配置文件残留\n4. （可选）清理系统服务')) {
    return;
  }

  // 保存原始按钮状态
  const originalText = btnUninstall.querySelector('span').textContent;

  try {
    btnUninstall.disabled = true;
    btnUninstall.querySelector('span').textContent = '卸载中...';

    showWaitingIndicator();
    addTerminalLog('========== 开始卸载 Openclaw ==========', 'warning');

    if (!window.electronAPI || !window.electronAPI.fixRisk) {
      throw new Error('后端修复接口不可用');
    }

    // 步骤1: 终止进程（必须先终止进程才能卸载）
    addTerminalLog('步骤1: 终止 Openclaw 进程...', 'info');
    try {
      const killResult = await window.electronAPI.fixRisk('kill_processes');
      if (killResult && killResult.success) {
        addTerminalLog(`  ✓ 已终止 ${killResult.killed || 0} 个进程`, 'success');
      } else {
        addTerminalLog('  ⚠ 无进程或终止失败', 'warning');
      }
    } catch (e) {
      addTerminalLog('  ⚠ 终止进程异常: ' + e.message, 'warning');
    }

    // 步骤2: 卸载应用（包括 CLI）
    addTerminalLog('步骤2: 卸载 Openclaw 应用...', 'info');
    try {
      const uninstallResult = await window.electronAPI.fixRisk('uninstall_app');
      if (uninstallResult && uninstallResult.success) {
        addTerminalLog('  ✓ 已卸载应用程序', 'success');
      } else {
        const errorMsg = uninstallResult?.error || '未知错误';
        addTerminalLog('  ⚠ 卸载: ' + errorMsg, 'warning');
      }
    } catch (e) {
      addTerminalLog('  ⚠ 卸载异常: ' + e.message, 'warning');
    }

    // 步骤3: 扫描并清理配置文件
    addTerminalLog('步骤3: 扫描 Openclaw 配置文件...', 'info');
    try {
      const cleanupResult = await window.electronAPI.fixRisk('cleanup_files');
      
      if (cleanupResult && cleanupResult.success) {
        if (cleanupResult.cleaned && cleanupResult.cleaned.length > 0) {
          addTerminalLog('  ✓ 已删除以下路径:', 'success');
          cleanupResult.cleaned.forEach(item => {
            addTerminalLog(`    📁 ${item}`, 'info');
          });
        } else {
          addTerminalLog('  ✓ 未发现配置文件', 'success');
        }
      } else {
        addTerminalLog('  ✗ 清理配置失败: ' + (cleanupResult?.error || '未知错误'), 'error');
        if (cleanupResult?.configStillExists) {
          addTerminalLog('  ✗ 配置残留仍然存在！', 'error');
        }
      }
    } catch (e) {
      addTerminalLog('  ✗ 清理配置异常: ' + e.message, 'error');
    }

    // 步骤4: 清理系统服务（可选）
    const doCleanupServices = confirm('Openclaw 核心组件已卸载。\n\n是否同时清除所有 Openclaw 相关的系统服务和启动项？\n（建议：仅在确认不再使用时选择）');
    if (doCleanupServices) {
      addTerminalLog('步骤4: 清理系统服务...', 'info');
      try {
        const serviceResult = await window.electronAPI.fixRisk('remove_services');
        if (serviceResult && serviceResult.success) {
          addTerminalLog('  ✓ 已移除相关系统服务', 'success');
        } else {
          addTerminalLog('  ⚠ 移除服务: ' + (serviceResult?.error || '无系统服务或移除失败'), 'warning');
        }
      } catch (e) {
        addTerminalLog('  ⚠ 移除服务异常: ' + e.message, 'warning');
      }
    } else {
      addTerminalLog('用户选择保留 Openclaw 系统服务', 'info');
    }

    hideWaitingIndicator();

    addTerminalLog('========== 卸载流程完成 ==========', 'success');

    // 更新安全状态
    updateSecurityStatus(100, 'safe');
    statusDot.className = 'status-dot ready';
    statusText.textContent = '系统安全';
    scoreValue.textContent = '100';
    progressFill.style.width = '100%';
    progressFill.className = 'progress-fill';

    // 隐藏风险列表
    risksSection.style.display = 'none';
    currentRisks = [];

    // 重置时间线
    resetTimeline();

    showToast('卸载完成', 'success');

    // 卸载完成后按钮恢复原文案和可用状态
    btnUninstall.disabled = false;
    btnUninstall.querySelector('span').textContent = originalText;
  } catch (error) {
    hideWaitingIndicator();
    addTerminalLog('卸载过程出错: ' + (error?.message || '未知错误'), 'error');
    console.error('卸载错误:', error);
    showToast('卸载失败: ' + (error?.message || '未知错误'), 'error');

    // 确保恢复按钮状态和文案
    btnUninstall.disabled = false;
    btnUninstall.querySelector('span').textContent = originalText;
  }
}

// 清空日志
function clearTerminal() {
  terminalContent.innerHTML = `
    <div class="log-entry info">
      <span class="timestamp">[系统]</span>
      <span class="message">日志已清空</span>
    </div>
  `;
}

// 绑定事件
btnScan.addEventListener('click', performScan);
btnUninstall.addEventListener('click', fixRisk);
btnClearLog.addEventListener('click', clearTerminal);

// 模态框事件监听
modalClose.addEventListener('click', hideRiskModal);

// 点击模态框背景关闭
riskModal.addEventListener('click', (e) => {
  if (e.target === riskModal) {
    hideRiskModal();
  }
});

// ESC 键关闭模态框
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && riskModal.classList.contains('show')) {
    hideRiskModal();
  }
});

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  initTerminalListener();
  addTerminalLog('应用已启动，点击“🔍 一键扫描”开始检测', 'info');

  // #region agent log
  __dbg('H1', 'renderer.js:DOMContentLoaded', 'DOMContentLoaded ran', {
    hasBtnScan: !!btnScan,
    hasBtnUninstall: !!btnUninstall,
    btnUninstallDisabled: !!btnUninstall?.disabled,
  });
  // #endregion
});

