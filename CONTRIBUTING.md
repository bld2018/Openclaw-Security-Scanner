# 贡献指南

感谢您对 Openclaw Security Scanner 项目的关注！我们欢迎各种形式的贡献。

## 🎯 贡献方式

### 报告问题

如果您发现了bug或有功能建议：

1. 请先搜索现有的 [Issues](https://github.com/your-username/openclaw-security-scanner/issues)
2. 如果没有找到相关问题，请创建新的Issue
3. 提供详细的描述、复现步骤和环境信息

### 代码贡献

#### 开发环境搭建

1. Fork本仓库到您的GitHub账户
2. 克隆您的fork到本地
   ```bash
   git clone https://github.com/YOUR_USERNAME/openclaw-security-scanner.git
   cd openclaw-security-scanner
   ```

3. 添加上游仓库
   ```bash
   git remote add upstream https://github.com/original-owner/openclaw-security-scanner.git
   ```

4. 创建特性分支
   ```bash
   git checkout -b feature/your-feature-name
   ```

5. 安装依赖并开发
   ```bash
   npm install
   npm start
   ```

#### 代码规范

- 使用ES6+语法
- 遵循JavaScript标准风格
- 使用有意义的变量和函数名
- 添加必要的注释
- 保持代码简洁可读

#### 提交规范

- 使用清晰的提交信息
- 格式：`类型: 简短描述`
- 类型包括：`feat`（新功能）、`fix`（修复）、`docs`（文档）、`style`（样式）、`refactor`（重构）、`test`（测试）

示例：
```bash
git commit -m "feat: 添加网络连接详情显示"
git commit -m "fix: 修复进程扫描中的内存泄漏"
```

### 文档贡献

- 修复README中的错误或过时信息
- 添加使用示例
- 完善SPEC.md文档
- 创建Wiki页面（如果有）

## 🔍 测试

在提交PR之前，请确保：

1. 代码可以在您的环境中正常运行
2. 没有引入新的bug
3. 主要功能正常工作：
   - 扫描功能
   - 一键修复
   - 风险详情显示

### 手动测试清单

- [ ] 应用可以正常启动
- [ ] 扫描功能正常工作
- [ ] 风险列表正确显示
- [ ] 点击风险项显示详情弹窗
- [ ] 一键修复功能有效
- [ ] 一键卸载彻底清理
- [ ] 日志输出正常

## 📦 Pull Request流程

1. 确保您的代码是最新的
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. 推送到您的fork
   ```bash
   git push origin feature/your-feature-name
   ```

3. 创建Pull Request
   - 登录GitHub
   - 进入您的fork仓库
   - 点击"New pull request"
   - 填写PR标题和描述
   - 提交PR

### PR描述模板

```markdown
## 描述
简要描述这个PR的目的和改动

## 类型
- [ ] Bug修复
- [ ] 新功能
- [ ] 文档更新
- [ ] 代码重构
- [ ] 其他

## 改动内容
- 改动1
- 改动2
- 改动3

## 测试
- [ ] 已进行手动测试
- [ ] 功能正常工作
- [ ] 无控制台错误

## 截图（如适用）
如果涉及UI改动，请添加截图
```

## 🎨 UI/UX贡献

如果您想改进UI/UX：

1. 参考SPEC.md中的设计规范
2. 保持极客风格的深色主题
3. 确保响应式布局
4. 测试不同窗口尺寸
5. 提供设计说明和截图

## 🌍 国际化

如果您想添加多语言支持：

1. 创建语言文件（如`locales/en.json`, `locales/zh-CN.json`）
2. 使用i18n库实现国际化
3. 确保文本与代码分离

## 🐛 Bug修复

修复bug时：

1. 在Issue中描述bug
2. 创建修复分支
3. 修复问题
4. 添加测试（如适用）
5. 提交PR

## 📝 文档改进

改进文档时：

1. 检查现有文档的准确性
2. 更新过时的信息
3. 添加使用示例
4. 完善API文档
5. 提交PR

## 💡 功能建议

如果您有新功能建议：

1. 创建Issue并标记为"enhancement"
2. 描述您的想法和用例
3. 等待维护者反馈
4. 如果接受，可以开始实现

## ❓ 常见问题

### 如何开始贡献？

从"good first issue"标签的Issue开始，这些通常比较简单。

### 需要多长时间回复？

我们会在1-3个工作日内回复Issue和PR。

### 可以贡献哪些内容？

- 代码改进
- Bug修复
- 文档完善
- UI/UX优化
- 功能增强
- 测试用例

## 📞 联系

如有问题，请通过以下方式联系：

- 创建Issue
- 项目讨论区

## 🙏 感谢

感谢所有贡献者的努力！您的贡献让这个项目变得更好。

---

Last updated: 2024
