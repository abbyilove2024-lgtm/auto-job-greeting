# Auto Job Greeting — Boss直聘自动打招呼插件

## 项目简介

浏览器插件（Chrome Manifest V3），实现：
1. **主动检索** Boss直聘岗位（手动触发，默认抓取 10 页，可配置）
2. **AI 生成**个性化打招呼消息（基于简历 + 职位描述）
3. **两种发送模式**：全自动 / 待发列表确认（支持逐条或批量发送）
4. **历史记录**：发送状态追踪、回复标记、CSV 导出

---

## 目录结构

```
auto_job_greeting/
├── manifest.json               # MV3 插件配置
├── background/
│   └── service_worker.js       # 消息总线、状态机、发送调度
├── content/
│   ├── job_searcher.js         # 检索页 DOM 解析（分页抓取岗位）
│   └── sender.js               # 聊天页模拟发送
├── lib/
│   ├── storage.js              # chrome.storage 封装
│   ├── rate_limiter.js         # 滑动窗口频率控制
│   ├── ai_client.js            # OpenAI GPT-4 调用
│   └── resume_parser.js        # PDF / Word 简历解析
├── popup/
│   ├── index.html              # 主面板 UI
│   └── popup.js                # 主面板逻辑
└── pages/
    ├── settings.html/js        # 设置页（简历 + 意向 + 配置）
    ├── pending.html/js         # 待发队列页（逐条 + 批量）
    └── history.html/js         # 历史记录页（筛选 + 统计 + 导出）
```

---

## 安装与使用

### 1. 加载插件（开发者模式）
1. 打开 Chrome → `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择本目录

### 2. 初始化配置（首次使用）
1. 点击插件图标 → 主面板 → 底部「设置」
2. 上传简历（PDF / Word），系统自动解析并填充
3. 填写求职意向（职位关键词必填）
4. 配置发送模式、发送间隔、最大检索页数
5. 选填 AI 提供商 API Key（不填则使用默认消息模板）
6. 点击「保存设置」

### 3. 开始检索与发送
1. 点击插件图标 → 主面板 → 「🔍 开始检索」
2. 插件自动打开 Boss直聘搜索页并抓取岗位
3. 检索完成后根据发送模式分支：
   - **全自动**：直接依次发送
   - **待发列表确认**：打开待发页后可逐条确认/跳过，或勾选后批量发送

### 4. 查看历史
- 主面板底部「历史」→ 查看发送记录
- 可按状态/回复情况/日期筛选
- 可手动标记每条记录的回复状态
- 支持导出 CSV（兼容 Excel）

---

## 核心配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `maxPages` | 检索最大页数 | 10（范围：1-50）|
| `sendMode` | 发送模式 | `auto` |
| `sendIntervalMin` | 最小发送间隔（秒） | 1 |
| `sendIntervalMax` | 最大发送间隔（秒） | 5 |
| `maxPerMinute` | 每分钟最多发送条数 | 5 |
| `aiConfig.providerId` | AI 提供商 | `openai` |
| `aiConfig.apiKey` | 提供商 API Key | 空（使用默认模板）|
| `aiConfig.baseUrl` | 自定义 OpenAI 兼容地址 | 空 |
| `aiConfig.enabled` | 是否启用 AI 生成 | `false` |

---

## 重要说明

- **数据安全**：所有数据（简历、API Key、历史记录）仅存储在本地 `chrome.storage.local`，不上传任何服务器
- **合规使用**：请遵守目标平台的服务条款、自动化规则与当地法律法规。使用者需自行承担账号与合规风险
- **频率控制**：内置发送间隔（1-5 秒）与每分钟上限（≤5 条），用于降低误操作与过载风险
- **选择器维护**：Boss直聘页面结构如有变更，需更新 `content/job_searcher.js` 中的 `SEL` 常量
- **AI 提供商**：当前内置支持 `OpenAI`、`Anthropic`、`OpenRouter`，并提供 `OpenAI 兼容` 类型
- **API Key**：调用费用由用户自行承担，不填则使用内置默认消息模板
- **安全反馈**：如发现安全问题，请参考 [SECURITY.md](./SECURITY.md)

---

## 相关需求文档

- [PRD](../../documents/product_requirements/auto_job_greeting/prd.md)
- [业务流程图](../../documents/product_requirements/auto_job_greeting/flowchart.md)
- [用户故事](../../documents/product_requirements/auto_job_greeting/user_story.md)
- [原型说明](../../documents/product_requirements/auto_job_greeting/prototype.md)

---

## License

本项目采用 **Non-Commercial License**：仅允许非商用使用，禁止未授权商用。  
详情见 [LICENSE](./LICENSE)。

---

## Third-Party Notices

第三方依赖及许可证信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
