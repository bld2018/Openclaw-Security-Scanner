# Openclaw Security Scanner

[English](#english-version) | 简体中文

Openclaw安全检查开源工具 - macOS桌面应用，专为检测和清理Openclaw相关安全风险而设计。

## ✨ 功能特性

- 🔍 **智能扫描**：一键深度扫描系统中的Openclaw安全风险
- 📊 **详细报告**：提供具体进程ID、文件路径、网络端口等详细信息
- 🛡️ **风险分级**：按严重等级分类显示风险（严重/警告/信息）
- ⚡ **一键修复**：自动终止进程、卸载应用、清理残留文件
- 🎯 **交互式详情**：点击风险项查看完整详情和修复建议
- 🎨 **极客风格UI**：现代化的深色主题设计，响应式布局
- 💻 **系统信息**：显示macOS版本、主机名等系统信息

## 🚀 快速开始

### 前置要求

- macOS 10.14 或更高版本
- Node.js 16.x 或更高版本
- npm 或 yarn

### 安装步骤

1. **克隆仓库**
   ```bash
   git clone <repository-url>
   cd openclaw-security-scanner
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动应用**
   ```bash
   npm start
   ```

   应用启动后会自动开始扫描，你也可以手动点击"🔍 一键扫描"重新扫描。

### 其他命令

- **UI渲染测试**
  ```bash
  npm run test:ui
  ```

- **打包应用**
  ```bash
  npm run build
  ```

## 🔍 安全扫描项目

### 1. CLI安装检测
- 检测Openclaw CLI是否安装
- 显示完整安装路径、真实路径、NPM全局路径
- 显示版本信息

### 2. 运行进程检测
- 检测所有Openclaw相关进程
- 显示每个进程的**PID**、命令行参数
- 支持批量终止进程

### 3. 网络连接检测
- 检测端口18789占用情况
- 显示所有网络连接的PID、进程名、端口信息
- 阻断网络连接功能

### 4. 系统服务检测
- 检测Launchd服务、登录项、启动代理
- 显示服务文件具体路径
- 移除系统服务

### 5. 配置残留清理
- 检测~/.openclaw配置目录
- 列出配置文件清单
- 彻底清理配置和备份目录

## 🎯 使用指南

### 扫描流程
1. 启动应用后自动开始扫描
2. 等待扫描完成（约15-30秒）
3. 查看左侧风险列表
4. 点击风险项查看详细信息
5. 点击"一键修复"执行清理

### 风险详情弹窗
每个风险项都可以点击查看详情，包含：
- 风险名称和等级
- 详细描述
- 具体技术信息（进程ID、路径、端口等）
- 修复建议和操作按钮

### 一键卸载
点击"一键卸载"按钮可执行完整清理：
- 终止所有Openclaw进程
- 卸载CLI工具
- 移除系统服务
- 清理配置文件和备份目录
- 验证清理结果

## 🛠️ 技术栈

- **Electron 28** - 跨平台桌面应用框架
- **Node.js** - 后端运行时
- **HTML5/CSS3/JavaScript** - 前端技术
- **electron-log** - 日志记录

## 📁 项目结构

```
openclaw-security-scanner/
├── main.js                 # 主进程（Electron）
├── renderer.js             # 渲染进程（UI逻辑）
├── preload.js              # 预加载脚本
├── index.html              # 主界面
├── package.json            # 项目配置
├── SPEC.md                 # 详细规格文档
├── test_ui_rendering.js    # UI测试脚本
└── README.md               # 本文档
```

## 🖥️ 界面预览

应用采用极客风格的深色主题设计：
- **左侧**：安全风险列表（可滚动，按等级分类）
- **右侧**：选中风险的详细信息
- **进度条**：扫描进度可视化
- **状态指示器**：实时显示扫描状态

## 🤝 贡献指南

欢迎提交Issue和Pull Request！

1. Fork本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启Pull Request

## 📝 开发说明

### 代码规范
- 使用ES6+语法
- 遵循JavaScript标准风格
- 添加必要的注释

### 调试
- 使用`electron-log`记录日志
- 日志文件位于应用用户数据目录
- 开发模式下查看控制台输出

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源协议。

## ⚠️ 免责声明

本工具仅用于安全检测和系统清理，使用者应确保遵守当地法律法规。开发者不对使用本工具造成的任何直接或间接损失负责。

## 📞 联系方式

- 提交Issue: [GitHub Issues](<repository-url>/issues)
- 项目主页: <repository-url>

---

## <a name="english-version"></a> English Version

# Openclaw Security Scanner

Openclaw security detection open source tool - macOS desktop application designed for detecting and cleaning Openclaw-related security risks.

## ✨ Features

- 🔍 **Smart Scanning**: One-click deep scan for Openclaw security risks
- 📊 **Detailed Report**: Provides specific process IDs, file paths, network ports, etc.
- 🛡️ **Risk Classification**: Display risks by severity level (Critical/Warning/Info)
- ⚡ **One-click Fix**: Auto terminate processes, uninstall apps, clean residual files
- 🎯 **Interactive Details**: Click risk items to view full details and fix suggestions
- 🎨 **Geek-style UI**: Modern dark theme design with responsive layout
- 💻 **System Info**: Display macOS version, hostname, and other system information

## 🚀 Quick Start

### Prerequisites

- macOS 10.14 or higher
- Node.js 16.x or higher
- npm or yarn

### Installation

1. **Clone Repository**
   ```bash
   git clone <repository-url>
   cd openclaw-security-scanner
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Start Application**
   ```bash
   npm start
   ```

### Commands

- **UI Test**: `npm run test:ui`
- **Build**: `npm run build`

## 🔍 Security Scan Items

1. **CLI Installation Detection**
2. **Running Process Detection**
3. **Network Connection Detection**
4. **System Service Detection**
5. **Configuration Residual Cleanup**

## 🛠️ Tech Stack

- Electron 28
- Node.js
- HTML5/CSS3/JavaScript
- electron-log

## 📄 License

[MIT License](LICENSE)
