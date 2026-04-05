/**
 * service_worker.js
 * 后台消息总线、状态机与任务调度中心
 */

import {
  getJobIntention,
  getSearchConfig,
  getSendConfig,
  getResumeData,
  getAiConfig,
  getSentJobIds,
  setPendingJobs,
  setPluginState,
  addSendRecord,
  clearPendingJobs,
} from '../lib/storage.js';
import { generateGreetingMessage } from '../lib/ai_client.js';
import { RateLimiter, randomDelay } from '../lib/rate_limiter.js';

const RUNTIME_VERSION = '2026-04-04-confirm-mode-v9';

// ── 全局状态 ──────────────────────────────────────────────────────────────────

let currentState = 'idle'; // idle | searching | pending | sending | paused | done | error
let searchTabId  = null;   // 当前检索 tab 的 ID
let sendQueue    = [];      // 当前自动发送队列
let sendIndex    = 0;       // 队列当前位置
let isPaused     = false;
let rateLimiter  = null;

console.log('[SW] 运行版本:', RUNTIME_VERSION);

// ── 消息监听 ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error('[SW] 消息处理异常:', err);
    sendResponse({ ok: false, error: err.message });
  });
  return true; // 保持消息通道开启（异步响应）
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

    // 用户点击「开始检索」
    case 'START_SEARCH':
      await startSearch();
      return { ok: true };

    // content script 上报检索进度
    case 'SEARCH_PROGRESS':
      broadcastToPopup({
        type: 'STATUS_UPDATE',
        state: 'searching',
        progress: msg,
      });
      return { ok: true };

    // content script 检索完成，返回岗位列表
    case 'JOB_LIST_READY':
      console.log(`[SW] JOB_LIST_READY 收到 ${msg.jobs?.length ?? 0} 个岗位`);
      if (msg.meta) console.log('[SW] JOB_LIST_READY meta:', msg.meta);
      await onJobListReady(msg.jobs, msg.meta);
      return { ok: true };

    // content script 上报页面内采集器抓到的数据
    case 'PAGE_JOB_DATA_READY':
      console.log('[SW] PAGE_JOB_DATA_READY:', {
        page: msg.page,
        source: msg.source,
        rawCount: msg.rawCount,
        captureMeta: msg.captureMeta,
        preview: msg.jobsPreview?.[0] || null,
      });
      return { ok: true };

    // 搜索阶段汇总诊断
    case 'SEARCH_DIAGNOSTIC':
      console.log('[SW] SEARCH_DIAGNOSTIC:', {
        stage: msg.stage,
        page: msg.page,
        status: msg.status,
        source: msg.source,
        rawCount: msg.rawCount,
        newCount: msg.newCount,
        filteredSentCount: msg.filteredSentCount,
        reason: msg.reason,
        captureMeta: msg.captureMeta,
      });
      return { ok: true };

    // content script DOM 诊断（绕过Boss直聘反调试，在此处记录）
    case 'DOM_DIAGNOSTIC':
      console.log('[SW] ══ DOM诊断报告 ══', msg.bodySnippet ? '(超时)' : '(初始)');
      if (msg.reason) console.log('[SW] 诊断原因:', msg.reason);
      console.log('[SW] URL:', msg.url);
      console.log('[SW] body HTML 长度:', msg.bodyLen, '| 文本长:', msg.textLen ?? '-', '| 链接数:', msg.linkCount ?? '-');
      if (typeof msg.frameCount === 'number') console.log('[SW] 可访问 iframe 数:', msg.frameCount);
      if (Array.isArray(msg.contexts) && msg.contexts.length) console.log('[SW] 扫描上下文:', msg.contexts.join(' | '));
      console.log('[SW] 选择器命中数量:', JSON.stringify(msg.selectors));
      if (msg.jobRelatedClasses) console.log('[SW] job相关class名:', msg.jobRelatedClasses.join(', ') || '无');
      if (msg.bodySnippet) console.log('[SW] body前400字符:', msg.bodySnippet);
      return { ok: true };

    // content script 心跳（确认注入成功）
    case 'CS_ALIVE':
      if (msg.version) console.log('[SW] Content script 版本:', msg.version);
      console.log('[SW] ✅ Content script 已注入，URL:', msg.url);
      return { ok: true };

    // 用户点击「暂停/继续」
    case 'TOGGLE_PAUSE':
      await togglePause();
      return { ok: true };

    // 用户点击「停止」
    case 'STOP':
      await stopAll();
      return { ok: true };

    // 手动模式：用户确认发送单条
    case 'USER_SEND':
      await sendSingleJob(msg.jobId, msg.message);
      return { ok: true };

    // 手动模式：用户跳过单条
    case 'USER_SKIP':
      broadcastToPopup({ type: 'JOB_SKIPPED', jobId: msg.jobId });
      return { ok: true };

    // 手动批量模式：用户批量确认
    case 'USER_BATCH_SEND':
      await startBatchSend(msg.jobs);
      return { ok: true };

    // 查询当前状态
    case 'GET_STATE':
      return { ok: true, state: currentState };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ── 检索流程 ──────────────────────────────────────────────────────────────────

async function startSearch() {
  try {
    await setState('searching');

    const intention    = await getJobIntention();
    const searchConfig = await getSearchConfig();
    const sendConfig   = await getSendConfig();

    if (!intention.keyword) {
      await setState('error');
      broadcastToPopup({ type: 'ERROR', message: '请先设置求职意向关键词' });
      return;
    }

    const scrapeTask = {
      active:    true,
      maxPages:  searchConfig.maxPages || 10,
      sendMode:  sendConfig.sendMode || 'manual_review',
      intention,
      startedAt: Date.now(),
    };

    console.log('[SW] startSearch 配置:', {
      maxPages: scrapeTask.maxPages,
      sendMode: scrapeTask.sendMode,
    });

    // 将任务写入 storage —— content script 会主动读取，不依赖消息传递
    await new Promise((r) => chrome.storage.local.set({ scrapeTask }, r));

    // 构造 Boss 直聘搜索 URL
    const searchUrl = buildSearchUrl(intention, 1);
    console.log('[SW] 打开搜索页:', searchUrl);

    // 创建新 Tab
    const tab = await chrome.tabs.create({ url: searchUrl, active: true });
    searchTabId = tab.id;

    // 等待 Tab 加载到搜索结果页后，备用触发一次消息
    chrome.tabs.onUpdated.addListener(async function listener(tabId, info, tabInfo) {
      if (tabId !== searchTabId || info.status !== 'complete') return;

      const url = tabInfo.url || '';

      // 若跳到登录页或其他页，继续等待（不移除监听器）
      if (!url.includes('zhipin.com/web/geek/jobs')) {
        if (url.includes('zhipin.com')) {
          console.warn('[SW] 跳至非搜索页，可能需登录:', url);
          broadcastToPopup({ type: 'ERROR', message: '请先在 Boss 直聘登录账号，登录后重新点击「开始检索」' });
        }
        return;
      }

      chrome.tabs.onUpdated.removeListener(listener);

      // 等待 SPA React/Vue 初始化
      await sleep(2000);

      // 备用消息（主方案是 storage 自启动，此处 catch 静默）
      chrome.tabs.sendMessage(searchTabId, {
        type:     'START_SCRAPING',
        maxPages: searchConfig.maxPages || 10,
        sendMode: sendConfig.sendMode || 'manual_review',
        intention,
      }).catch(() => {});
    });

    // 70 秒超时：搜索页可能存在 iframe/懒加载，给足恢复时间再提示
    setTimeout(() => {
      if (currentState === 'searching') {
        console.warn('[SW] 70s 未完成检索，提示用户检查页面状态');
        broadcastToPopup({
          type: 'ERROR',
          message: '检索超时，请确认：①已登录 Boss 直聘 ②搜索页面已正常打开',
        });
      }
    }, 70000);
  } catch (err) {
    console.error('[SW] startSearch 异常:', err);
    await setState('error');
    broadcastToPopup({ type: 'ERROR', message: `检索启动失败: ${err.message}` });
  }
}

function buildSearchUrl(intention, page) {
  const params = new URLSearchParams({
    query: intention.keyword,
    city:  intention.city || '101010100',
    page:  page,
  });
  // Boss直聘 薪资筛选（salary=203,306 表示具体范围，具体值需参照平台参数）
  return `https://www.zhipin.com/web/geek/jobs?${params.toString()}`;
}

// ── 收到岗位列表 ───────────────────────────────────────────────────────────────

async function onJobListReady(jobs, meta = null) {
  if (!jobs || jobs.length === 0) {
    console.log('[SW] onJobListReady: 0 个岗位，结束');
    if (meta) console.log('[SW] onJobListReady 空结果原因:', meta);
    const statusMessageMap = {
      empty_result_confirmed: '当前搜索条件下未找到岗位',
      data_capture_timeout: '未能从页面捕获到岗位数据',
      blocked_or_shell_page: '页面停留在壳页或受限页，未拿到真实岗位列表',
    };
    const message =
      meta?.status === 'success_with_jobs' && meta?.filteredSentCount > 0
        ? '本页抓到了岗位，但都已在发送历史中'
        : statusMessageMap[meta?.status] || '未找到新岗位';
    await setState('done');
    broadcastToPopup({
      type: 'STATUS_UPDATE',
      state: 'done',
      message,
    });
    return;
  }

  console.log(`[SW] onJobListReady: ${jobs.length} 个岗位，示例:`, jobs[0]);
  if (meta) console.log('[SW] onJobListReady 汇总:', meta);
  const sendConfig = await getSendConfig();
  console.log('[SW] sendMode:', sendConfig.sendMode);

  if (sendConfig.sendMode === 'auto') {
    await startAutoSendQueue(jobs);
  } else {
    // 手动模式：存入待发队列，并自动打开确认页
    await setPendingJobs(jobs);
    await setState('pending');
    broadcastToPopup({
      type: 'STATUS_UPDATE',
      state: 'pending',
      pendingCount: jobs.length,
      sendMode: sendConfig.sendMode,
    });
    // 自动打开待发确认页，无需用户手动找入口
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/pending.html'), active: true });
  }
}

// ── 自动发送队列 ───────────────────────────────────────────────────────────────

async function startAutoSendQueue(jobs) {
  const sendConfig = await getSendConfig();
  rateLimiter = new RateLimiter(sendConfig.maxPerMinute || 5);
  sendQueue   = jobs;
  sendIndex   = 0;
  isPaused    = false;

  await setState('sending');
  broadcastToPopup({
    type: 'STATUS_UPDATE',
    state: 'sending',
    total: jobs.length,
    current: 0,
  });

  await processAutoQueue();
}

async function processAutoQueue() {
  console.log('[SW processAutoQueue] 开始处理队列，共', sendQueue.length, '个岗位');
  const resumeData = await getResumeData();
  const aiConfig   = await getAiConfig();
  const sendConfig = await getSendConfig();

  while (sendIndex < sendQueue.length) {
    if (isPaused) {
      // 暂停状态：轮询等待
      await sleep(500);
      continue;
    }

    const job = sendQueue[sendIndex];
    console.log(`[SW] 处理岗位 ${sendIndex + 1}/${sendQueue.length}: ${job.jobTitle}`);

    try {
      // 1. AI 生成消息
      console.log(`[SW] 正在生成消息: ${job.jobTitle}`);
      const message = await generateGreetingMessage({
        resumeData,
        job,
        aiConfig,
      });
      console.log(`[SW] 消息已生成: ${message.substring(0, 50)}...`);

      // 2. 频率控制
      await rateLimiter.check();

      // 3. 随机延迟
      const delayMin = (sendConfig.sendIntervalMin || 1) * 1000;
      const delayMax = (sendConfig.sendIntervalMax || 5) * 1000;
      console.log(`[SW] 等待延迟: ${delayMin}-${delayMax}ms`);
      await randomDelay(delayMin, delayMax);

      // 4. 在目标 Tab 中执行发送
      console.log(`[SW] 开始发送岗位（new_tab 策略），searchTabId=${searchTabId}`);
      const result = await executeSend(job, message);
      console.log(`[SW] 发送结果:`, result);

      // 5. 记录结果
      await recordResult(job, message, result.success ? 'success' : 'failed');

      broadcastToPopup({
        type:    'SEND_COMPLETE',
        jobId:   job.jobId,
        status:  result.success ? 'success' : 'failed',
        message: result.error || '',
        current: sendIndex + 1,
        total:   sendQueue.length,
      });

      // 6. 特殊错误码处理——遇到无法继续的情况直接停止队列
      if (!result.success) {
        if (result.code === 'LIMIT_REACHED') {
          await setState('paused');
          broadcastToPopup({
            type: 'ERROR',
            message: `今日打招呼次数已用完，已自动暂停。明日可继续。（${result.error}）`,
          });
          return; // 退出队列循环
        }
        if (result.code === 'NOT_LOGGED_IN') {
          await setState('error');
          broadcastToPopup({
            type: 'ERROR',
            message: '检测到未登录状态，已停止发送，请先登录 Boss 直聘后重试。',
          });
          return;
        }
        // 其他失败（NO_CHAT_BTN / TIMEOUT 等）：仅跳过当前岗位，继续下一个
      }

    } catch (err) {
      console.error(`[SW] 发送岗位 ${job.jobId} 异常:`, err);
      console.error(`[SW] 错误堆栈:`, err.stack);
      await recordResult(job, '', 'failed');

      if (err.message === 'API_KEY_INVALID') {
        await setState('error');
        broadcastToPopup({ type: 'ERROR', message: 'API Key 无效，请重新配置' });
        return;
      }
    }

    sendIndex++;
  }

  // 队列处理完毕
  await clearPendingJobs();
  await setState('done');
  broadcastToPopup({
    type: 'STATUS_UPDATE',
    state: 'done',
    total: sendQueue.length,
    successCount: sendQueue.length - sendIndex, // 粗略统计
  });
}

// ── 批量手动发送 ───────────────────────────────────────────────────────────────

async function startBatchSend(jobs) {
  await startAutoSendQueue(jobs);
}

// ── 单条手动发送 ───────────────────────────────────────────────────────────────

async function sendSingleJob(jobId, customMessage) {
  const jobs    = sendQueue.length ? sendQueue : (await getPendingJobs()).jobs;
  const job     = jobs.find((j) => j.jobId === jobId);
  if (!job) return;

  const resumeData = await getResumeData();
  const aiConfig   = await getAiConfig();

  let message = customMessage;
  if (!message) {
    message = await generateGreetingMessage({ resumeData, job, aiConfig });
  }

  const result = await executeSend(job, message);
  await recordResult(job, message, result.success ? 'success' : 'failed');

  broadcastToPopup({
    type: 'SEND_COMPLETE',
    jobId:  job.jobId,
    status: result.success ? 'success' : 'failed',
  });
}

const TRANSIENT_SEND_CODES = new Set([
  'SCRIPT_ERROR',
  'PAGE_TIMEOUT',
  'EXCEPTION',
  'TIMEOUT',
  'NO_RESULT',
  'TAB_NOT_FOUND',
  'TAB_UNSTABLE',
]);

// ── 发送执行 ──────────────────────────────────────────────────────────────────
// 默认直接走详情页新 Tab 发送，减少搜索页复用造成的连接/缓存时序问题。

async function executeSend(job, message) {
  console.log(`[SW] send_strategy=new_tab [${job.jobTitle}]`);
  const firstResult = await executeSendInNewTab(job, message, { attempt: 1 });
  if (firstResult.success) return firstResult;
  if (['LIMIT_REACHED', 'NOT_LOGGED_IN'].includes(firstResult.code)) return firstResult;
  if (!TRANSIENT_SEND_CODES.has(firstResult.code)) return firstResult;

  console.warn(`[SW] 瞬态失败，准备重试一次 [${job.jobTitle}] code=${firstResult.code}`);
  await sleep(1200);

  const secondResult = await executeSendInNewTab(job, message, { attempt: 2 });
  if (secondResult.success) return secondResult;

  return {
    ...secondResult,
    firstError: firstResult.error,
    firstCode: firstResult.code,
    retried: true,
  };
}

async function executeSendInNewTab(job, message, opts = {}) {
  let tabId = null;
  const attempt = opts.attempt || 1;
  try {
    const targetUrl = job.jobDetailUrl;
    if (!targetUrl) {
      console.error('[SW executeSendInNewTab] 缺少职位详情URL');
      return { success: false, error: '缺少职位详情URL', code: 'NO_URL' };
    }
    if (!targetUrl.startsWith('https://www.zhipin.com/')) {
      console.error('[SW executeSendInNewTab] 无效的职位详情URL:', targetUrl);
      return { success: false, error: '无效的职位详情URL', code: 'INVALID_URL' };
    }

    console.log(`[SW executeSendInNewTab] 开始(第${attempt}次)：${job.jobTitle} | ${targetUrl}`);
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    tabId = tab.id;
    console.log('[SW executeSendInNewTab] tab_created:', tabId);

    const stable = await waitForSendTabStable(tabId, targetUrl, 22000);
    if (!stable.ok) {
      console.warn('[SW executeSendInNewTab] tab_stable_ready 失败:', stable);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      tabId = null;
      return {
        success: false,
        error: stable.reason || '页面未稳定',
        code: stable.code || 'TAB_UNSTABLE',
      };
    }

    console.log('[SW executeSendInNewTab] tab_stable_ready:', {
      tabId,
      finalUrl: stable.url,
      status: stable.status,
    });

    await sleep(1200);

    let results;
    try {
      results = await runSendScriptWithRetry(tabId, message);
    } catch (scriptErr) {
      console.error('[SW executeSendInNewTab] 脚本注入异常:', scriptErr);
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      tabId = null;
      return { success: false, error: `脚本注入失败: ${scriptErr.message}`, code: 'SCRIPT_ERROR' };
    }

    console.log('[SW executeSendInNewTab] 脚本注入完成，结果:', results);

    await sleep(1200);
    if (tabId) {
      chrome.tabs.remove(tabId).catch((err) => {
        console.warn('[SW] 关闭Tab失败:', err);
      });
      tabId = null;
    }

    const result = results?.[0]?.result;
    if (!result) {
      console.error('[SW executeSendInNewTab] 脚本返回值为空');
      return { success: false, error: '脚本无返回值', code: 'NO_RESULT' };
    }
    console.log(`[SW executeSendInNewTab] 最终结果 [${job.jobTitle}]`, result);
    return result;

  } catch (err) {
    console.error('[SW executeSendInNewTab] 异常:', err);
    if (tabId) {
      chrome.tabs.remove(tabId).catch(() => {});
    }
    return { success: false, error: err.message, code: 'EXCEPTION' };
  }
}

async function runSendScriptWithRetry(tabId, message) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await ensureTabAlive(tabId);
      return await chrome.scripting.executeScript({
        target: { tabId },
        func: sendGreetingInPage,
        args: [message],
      });
    } catch (err) {
      const transient = isTransientScriptError(err);
      console.warn('[SW] runSendScriptWithRetry 失败:', {
        tabId,
        attempt,
        transient,
        message: err?.message || String(err),
      });
      if (!transient || attempt === 2) throw err;
      await sleep(800);
      const stable = await waitForSendTabStable(tabId, '', 10000);
      if (!stable.ok) throw err;
    }
  }
  throw new Error('SCRIPT_RETRY_EXHAUSTED');
}

async function ensureTabAlive(tabId) {
  try {
    await chrome.tabs.get(tabId);
  } catch (_) {
    throw new Error('No tab with id');
  }
}

function isTransientScriptError(err) {
  const msg = err?.message || String(err);
  return (
    msg.includes('Frame with ID 0 was removed') ||
    msg.includes('Cannot access contents of url') ||
    msg.includes('The tab was closed') ||
    msg.includes('No tab with id')
  );
}

async function waitForSendTabStable(tabId, targetUrl, timeoutMs = 22000) {
  const start = Date.now();
  let stableSince = 0;
  let lastUrl = '';

  while (Date.now() - start < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return {
        ok: false,
        code: 'TAB_NOT_FOUND',
        reason: 'tab 已被关闭',
      };
    }

    const currentUrl = tab?.url || '';
    const currentStatus = tab?.status || 'loading';
    const urlMatches = isExpectedSendUrl(currentUrl, targetUrl);
    const isComplete = currentStatus === 'complete';

    if (urlMatches && isComplete) {
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 900) {
        return { ok: true, url: currentUrl, status: currentStatus };
      }
    } else {
      stableSince = 0;
      lastUrl = currentUrl;
    }

    await sleep(260);
  }

  return {
    ok: false,
    code: 'TAB_UNSTABLE',
    reason: '页面未稳定到可发送状态',
  };
}

function isExpectedSendUrl(currentUrl, targetUrl) {
  if (!currentUrl || currentUrl === 'about:blank') return false;
  if (/\/job_detail\//.test(currentUrl) || /\/web\/geek\/chat/.test(currentUrl)) return true;
  if (!targetUrl) return false;
  return currentUrl.startsWith(targetUrl);
}

// ── 页面内执行函数（序列化注入，不可引用外部变量，数据只通过 args 传入） ───────

async function sendGreetingInPage(message) {
  /* ---- 工具函数（必须自包含） ---- */
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  const err = console.error.bind(console);
  const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
  const randInt   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0
      && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  log('[sendGreetingInPage] 脚本已执行，开始处理，消息长度:', message.length);

  /* ---- 等待职位详情页渲染 ---- */
  async function waitPage(ms = 12000) {
    const sels = ['.job-name', '[class*="job-name"]', '.job-detail', '.job-banner', '.job-info'];
    const chatSelectors = ['#chat-input', 'textarea#chat-input', '[contenteditable="true"]'];
    const t0 = Date.now();
    log('[waitPage] 开始等待页面渲染...');
    while (Date.now() - t0 < ms) {
      // 职位详情页可能会自动跳聊天页，聊天页就绪也视为可发送状态。
      if (/\/web\/geek\/chat/.test(window.location.href)) {
        for (const s of chatSelectors) {
          const e = document.querySelector(s);
          if (e && isVisible(e)) {
            log('[waitPage] 聊天页已就绪:', s);
            return true;
          }
        }
      }
      for (const s of sels) {
        const e = document.querySelector(s);
        if (e && isVisible(e)) {
          log('[waitPage] 找到职位信息元素:', s);
          return true;
        }
      }
      await sleep(400);
    }
    warn('[waitPage] 超时：未找到职位信息');
    return false;
  }

  /* ---- 找「立即沟通」按钮 ---- */
  async function findChatBtn(ms = 10000) {
    const cssSels = [
      '.op-btn-chat', '.btn-chat', '[class*="btn-chat"]', '[class*="chat-btn"]',
      '.start-chat-btn', '.communicate-btn', '[class*="communicate"]',
      'a[href*="/web/im/"]', 'button[class*="chat"]', 'a[class*="chat"]',
    ];
    const textTargets = ['立即沟通', '继续沟通', '直接沟通', '联系我'];
    const t0 = Date.now();
    log('[findChatBtn] 开始查找按钮，超时时间:', ms);
    while (Date.now() - t0 < ms) {
      // CSS 类名精确匹配
      for (const s of cssSels) {
        const e = document.querySelector(s);
        if (e && isVisible(e)) { log('[findChatBtn] CSS命中:', s); return e; }
      }
      // 文字精确 + 模糊匹配（包含普通 span/div）
      let fuzzy = null;
      for (const el of document.querySelectorAll('a,button,span,div,[role="button"],.op-btn,[class*="btn"]')) {
        if (!isVisible(el)) continue;
        const t = (el.textContent ?? '').trim();
        if (textTargets.includes(t)) { log('[findChatBtn] 文字精确:', t); return el; }
        if (!fuzzy && t.length <= 15 && textTargets.some(p => t.includes(p))) fuzzy = el;
      }
      if (fuzzy) { log('[findChatBtn] 文字模糊:', fuzzy.textContent?.trim()); return fuzzy; }
      await sleep(500);
    }
    warn('[findChatBtn] 超时：未找到「立即沟通」按钮');
    return null;
  }

  async function openChatPanel(chatBtn, timeout = 12000) {
    const urlBefore = window.location.href;
    const targets = getClickableTargets(chatBtn);
    const chatHref = targets
      .map((el) => el?.href)
      .find((href) => typeof href === 'string' && /\/web\/(im|chat)\//.test(href));
    const t0 = Date.now();
    let hrefTried = false;

    while (Date.now() - t0 < timeout) {
      if (await findInput(1200)) return true;

      for (const target of targets) {
        activateElement(target);
        await sleep(randInt(700, 1100));

        if (window.location.href !== urlBefore) {
          log('[openChatPanel] URL已变化，等待新页面渲染...');
          await sleep(2200);
        }

        if (await findInput(1800)) return true;
      }

      if (!hrefTried && chatHref) {
        hrefTried = true;
        window.location.assign(chatHref);
        await sleep(2600);
        if (await findInput(2200)) return true;
      }

      await sleep(400);
    }

    return false;
  }

  function getClickableTargets(el) {
    const targets = [];
    const push = (candidate) => {
      if (!candidate || targets.includes(candidate) || !isVisible(candidate)) return;
      targets.push(candidate);
    };

    push(el);
    push(el.closest('a[href]'));
    push(el.closest('button'));
    push(el.closest('[role="button"]'));
    push(el.closest('.op-btn'));
    push(el.closest('[class*="btn"]'));
    push(el.parentElement);

    return targets;
  }

  function activateElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch (_) {}
    });
    try { el.click(); } catch (_) {}
  }

  function detectChatOpenBlocked() {
    const keywords = [
      '你已经有一次请求打开过立即沟通了',
      '已发起过沟通',
      '请勿重复发起沟通',
      '请稍后再试',
    ];
    const bodyText = document.body.innerText || '';
    return keywords.find((k) => bodyText.includes(k)) || null;
  }

  /* ---- 等待聊天输入框 ---- */
  async function findInput(ms = 15000) {
    const sels = [
      '#chat-input',                                      // ★ Boss直聘聊天页固定 ID
      'textarea#chat-input',
      '.dialog-textarea',
      '[contenteditable="true"][placeholder*="输入"]',
      '[contenteditable="true"][placeholder*="说点"]',
      '[contenteditable="true"][placeholder*="聊"]',
      '[contenteditable="true"][placeholder*="消息"]',
      '[contenteditable="true"][data-placeholder*="输入"]',
      '[class*="chat"] [contenteditable="true"]',
      '[class*="dialog"] [contenteditable="true"]',
      'textarea',                                         // 兜底
      '[contenteditable="true"]',
    ];
    const t0 = Date.now();
    log('[findInput] 开始查找输入框，超时时间:', ms);
    while (Date.now() - t0 < ms) {
      for (const s of sels) {
        try {
          const e = document.querySelector(s);
          if (e && isVisible(e)) {
            log('[findInput] 找到输入框:', s);
            return e;
          }
        } catch (_) {}
      }
      await sleep(300);
    }
    warn('[findInput] 超时：未找到聊天输入框');
    return null;
  }

  /* ---- 主流程 ---- */
  try {
    log('[sendGreetingInPage] 主流程开始');
    const ready = await waitPage();
    if (!ready) {
      err('[sendGreetingInPage] 页面加载超时');
      return { success: false, error: '页面加载超时', code: 'PAGE_TIMEOUT' };
    }

    let inputEl = await findInput(2000);

    if (!inputEl) {
      // 不在聊天页时才去找并点击「立即沟通」
      log('[sendGreetingInPage] 查找聊天按钮...');
      const chatBtn = await findChatBtn();
      if (!chatBtn) {
        err('[sendGreetingInPage] 未找到「立即沟通」按钮');
        return { success: false, error: '未找到「立即沟通」按钮', code: 'NO_CHAT_BTN' };
      }

      log('[sendGreetingInPage] 尝试打开聊天窗口...');
      const opened = await openChatPanel(chatBtn);
      if (!opened) {
        const blockedMsg = detectChatOpenBlocked();
        if (blockedMsg) {
          return { success: false, error: blockedMsg, code: 'CHAT_OPEN_BLOCKED' };
        }
      }

      log('[sendGreetingInPage] 查找输入框...');
      inputEl = await findInput();
    } else {
      log('[sendGreetingInPage] 已在聊天页，跳过聊天按钮步骤');
    }

    if (!inputEl) {
      const body = document.body.innerText || '';
      if (body.includes('今日招呼') || body.includes('次数已用完'))
        return { success: false, error: '今日打招呼次数已达上限', code: 'LIMIT_REACHED' };
      if (body.includes('请先登录') || window.location.href.includes('login'))
        return { success: false, error: '需要登录', code: 'NOT_LOGGED_IN' };
      err('[sendGreetingInPage] 聊天框未出现');
      return { success: false, error: '聊天框未出现', code: 'NO_INPUT' };
    }

    log('[sendGreetingInPage] 开始输入消息，长度:', message.length);
    // 聚焦
    inputEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await sleep(300);
    inputEl.click();
    inputEl.focus();
    await sleep(randInt(300, 600));

    // 写入消息
    if (inputEl.isContentEditable) {
      // contenteditable div（搜索页弹框）
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, message);
      log('[sendGreetingInPage] contentEditable 输入完成');
    } else {
      // ★ textarea（聊天页 #chat-input）— 用 React native setter 触发受控组件
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, message);
      } else {
        inputEl.value = message;
      }
      log('[sendGreetingInPage] textarea 输入完成');
    }
    inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(randInt(500, 900));

    log('[sendGreetingInPage] 发送消息...');
    // 方式1：Enter 键（Boss直聘聊天页默认 Enter 发送）
    const kb = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    inputEl.dispatchEvent(new KeyboardEvent('keydown',  kb));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', kb));
    inputEl.dispatchEvent(new KeyboardEvent('keyup',    kb));
    await sleep(300);
    // 方式2：点击发送按钮兜底（含 Boss直聘聊天页常见类名）
    for (const s of [
      '.send-btn', '.btn-send', '.send-message', '[class*="send-btn"]',
      'button[class*="send"]', '.send-msg', '.chat-op .btn',
    ]) {
      const b = document.querySelector(s);
      if (b && isVisible(b)) {
        log('[sendGreetingInPage] 点击发送按钮:', s);
        b.click();
        break;
      }
    }
    await sleep(1000);

    log('[sendGreetingInPage] 发送成功！');
    return { success: true };
  } catch (err) {
    console.error('[sendGreetingInPage] 异常:', err);
    return { success: false, error: err.message, code: 'EXCEPTION' };
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

async function togglePause() {
  isPaused = !isPaused;
  const newState = isPaused ? 'paused' : 'sending';
  await setState(newState);
  broadcastToPopup({ type: 'STATUS_UPDATE', state: newState });
}

async function stopAll() {
  isPaused  = true;
  sendQueue = [];
  sendIndex = 0;
  await clearPendingJobs();
  await setState('idle');
  broadcastToPopup({ type: 'STATUS_UPDATE', state: 'idle' });
}

async function setState(state) {
  currentState = state;
  await setPluginState(state);
}

async function recordResult(job, message, status) {
  await addSendRecord({
    id:           crypto.randomUUID(),
    jobId:        job.jobId,
    jobTitle:     job.jobTitle,
    company:      job.company,
    salary:       job.salary,
    recruiterId:  job.recruiterId,
    recruiterName: job.recruiterName,
    message,
    sentAt:       Date.now(),
    status,
    retryCount:   0,
    replyStatus:  'unknown',
    repliedAt:    null,
  });
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // popup 未打开时会报错，忽略即可
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 超时保护：10 秒
    setTimeout(resolve, 10000);
  });
}

async function getPendingJobs() {
  const { getPendingJobs: get } = await import('../lib/storage.js');
  return get();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
