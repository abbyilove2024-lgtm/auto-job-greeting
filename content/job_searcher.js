/**
 * job_searcher.js
 * Content Script — Boss直聘搜索结果页抓取岗位列表
 * 注入时机：用户打开搜索页后由 service_worker 触发
 */

(function () {
  'use strict';

  const RUNTIME_VERSION = '2026-04-04-confirm-mode-v9';
  const PAGE_COLLECTOR_SOURCE = 'AUTO_JOB_GREETING_PAGE_COLLECTOR';
  const PAGE_COLLECTOR_SCRIPT = 'content/page_job_collector.js';

  // ── DOM 选择器（多重 fallback，适应页面结构变更）──────────────────────────────
  const SEL = {
    // 覆盖新旧两版 Boss直聘 DOM 结构
    jobCard:       '[data-jobid], .job-card-wrapper, .job-card-body, [class*="job-card"], .job-list-box .job-card-left, .search-job-result li, .job-list li',
    jobTitle:      '.job-name, [class*="job-name"], .job-title, [class*="job-title"]',
    company:       '.company-name, [class*="company-name"]',
    salary:        '.salary, [class*="salary"]',
    recruiterInfo: '.info-public, [class*="info-public"], .recruiter-info, [class*="recruiter"]',
    jobLink:       'a[href*="/job_detail/"], a[href*="job_detail"]',
    nextPageBtn:   '.ui-icon-arrow-right, [class*="next"]:not([disabled]), .options-pages a:last-child, [class*="page-next"]',
    jobCount:      '.job-list-count, [class*="job-count"]',
  };

  let scrapeConfig    = null;
  let scrapedJobs     = [];
  let sentJobIds      = new Set();
  let scrapeStarted   = false;  // 防止重复启动
  let collectorInjected = false;
  let collectorReady = false;
  let latestPageData = null;
  let pendingPageDataResolvers = [];
  let lastSearchSummary = null;
  const NETWORK_SETTLE_MS = 1800;

  window.addEventListener('message', handleCollectorMessage, true);
  ensurePageCollector();

  function isSearchPage(url = window.location.href) {
    return url.includes('zhipin.com/web/geek/jobs');
  }

  function ensurePageCollector() {
    if (!isSearchPage() || collectorInjected) return;

    collectorInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(PAGE_COLLECTOR_SCRIPT);
    script.dataset.autoJobGreeting = 'page-collector';
    script.async = false;
    script.onload = () => script.remove();
    script.onerror = () => {
      collectorInjected = false;
      chrome.runtime.sendMessage({
        type: 'SEARCH_DIAGNOSTIC',
        stage: 'collector_inject_failed',
        page: getCurrentPageNumber(),
        source: 'network',
        reason: 'collector_script_load_error',
      }).catch(() => {});
    };

    const parent = document.head || document.documentElement;
    if (parent) {
      parent.appendChild(script);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.head || document.documentElement || document.body)?.appendChild(script);
      }, { once: true });
    }
  }

  function handleCollectorMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE_COLLECTOR_SOURCE) return;

    if (msg.type === 'PAGE_COLLECTOR_READY') {
      collectorReady = true;
      chrome.runtime.sendMessage({
        type: 'SEARCH_DIAGNOSTIC',
        stage: 'collector_ready',
        source: 'network',
        page: getCurrentPageNumber(),
        reason: msg.version,
      }).catch(() => {});
      return;
    }

    if (msg.type === 'PAGE_NAVIGATION') {
      const incomingPageKey = buildPageKey(msg.href || window.location.href);
      const currentPageKey = buildPageKey(window.location.href);
      if (incomingPageKey !== currentPageKey) {
        latestPageData = null;
        rejectStalePageResolvers();
      }
      return;
    }

    if (msg.type === 'PAGE_COLLECTOR_DIAGNOSTIC') {
      chrome.runtime.sendMessage({
        type: 'SEARCH_DIAGNOSTIC',
        stage: msg.stage || 'collector_diagnostic',
        source: 'network',
        page: getCurrentPageNumber(),
        reason: msg.error || msg.url || '',
        captureMeta: {
          transport: msg.transport || '',
          url: msg.url || '',
        },
      }).catch(() => {});
      return;
    }

    if (msg.type === 'PAGE_JOBS') {
      const pageKey = msg.pageKey || buildPageKey(window.location.href);
      const jobs = Array.isArray(msg.jobs)
        ? msg.jobs.map(normalizeCollectedJob).filter((job) => job?.jobId)
        : [];

      const nextPayload = {
        pageKey,
        jobs,
        rawCount: Number.isFinite(msg.rawCount) ? msg.rawCount : jobs.length,
        captureMeta: normalizeCaptureMeta(msg.captureMeta),
        href: msg.href || window.location.href,
        receivedAt: Date.now(),
      };
      latestPageData = selectBetterPageData(latestPageData, nextPayload, pageKey);

      resolvePendingPageData(latestPageData);
      chrome.runtime.sendMessage({
        type: 'PAGE_JOB_DATA_READY',
        page: getCurrentPageNumber(),
        source: 'network',
        rawCount: latestPageData.rawCount,
        captureMeta: latestPageData.captureMeta,
        jobsPreview: jobs.slice(0, 1),
      }).catch(() => {});
    }
  }

  function waitForPageCollectorData(timeout = 12000) {
    const pageKey = buildPageKey(window.location.href);
    ensurePageCollector();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPageDataResolvers = pendingPageDataResolvers.filter((entry) => {
          if (entry.timer !== timer) return true;
          if (entry.settleTimer) clearTimeout(entry.settleTimer);
          return false;
        });
        resolve(null);
      }, timeout);

      const entry = { resolve, timer, pageKey, settleTimer: null };
      pendingPageDataResolvers.push(entry);

      if (latestPageData?.pageKey === pageKey && isUsableNetworkPayload(latestPageData)) {
        schedulePageDataResolve(entry, latestPageData);
      }
    });
  }

  function resolvePendingPageData(payload) {
    pendingPageDataResolvers = pendingPageDataResolvers.filter((entry) => {
      if (entry.pageKey !== payload.pageKey) return true;
      if (!isUsableNetworkPayload(payload)) return true;
      schedulePageDataResolve(entry, payload);
      return true;
    });
  }

  function schedulePageDataResolve(entry, payload) {
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    entry.settleTimer = setTimeout(() => {
      clearTimeout(entry.timer);
      pendingPageDataResolvers = pendingPageDataResolvers.filter((candidate) => candidate !== entry);
      entry.resolve(latestPageData?.pageKey === entry.pageKey ? latestPageData : payload);
    }, NETWORK_SETTLE_MS);
  }

  function rejectStalePageResolvers() {
    pendingPageDataResolvers.forEach((entry) => {
      clearTimeout(entry.timer);
      if (entry.settleTimer) clearTimeout(entry.settleTimer);
      entry.resolve(null);
    });
    pendingPageDataResolvers = [];
  }

  function buildPageKey(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return [
        parsed.origin + parsed.pathname,
        parsed.searchParams.get('query') || '',
        parsed.searchParams.get('city') || '',
        parsed.searchParams.get('page') || '1',
      ].join('|');
    } catch (_) {
      return String(url || window.location.href);
    }
  }

  function getCurrentPageNumber() {
    return parseInt(new URL(window.location.href).searchParams.get('page') || '1', 10);
  }

  function normalizeCaptureMeta(meta = {}) {
    return {
      transport: meta.transport || '',
      url: meta.url || '',
      captureUrlPattern: meta.captureUrlPattern || '',
      explicitEmpty: Boolean(meta.explicitEmpty),
      arrayPath: meta.arrayPath || '',
      pageInfo: normalizePageInfo(meta.pageInfo),
    };
  }

  function normalizePageInfo(pageInfo = {}) {
    return {
      currentPage: toFiniteNumber(pageInfo.currentPage),
      totalPages: toFiniteNumber(pageInfo.totalPages),
      totalCount: toFiniteNumber(pageInfo.totalCount),
      hasMore: typeof pageInfo.hasMore === 'boolean' ? pageInfo.hasMore : undefined,
    };
  }

  function normalizeCollectedJob(job) {
    if (!job || typeof job !== 'object') return null;
    return {
      jobId: String(job.jobId || '').trim(),
      jobTitle: String(job.jobTitle || '').trim(),
      company: String(job.company || '').trim(),
      salary: String(job.salary || '').trim(),
      city: String(job.city || extractCity()).trim(),
      recruiterName: String(job.recruiterName || '').trim(),
      recruiterId: String(job.recruiterId || job.jobId || '').trim(),
      jobDetailUrl: String(job.jobDetailUrl || '').trim(),
      jobDescription: '',
    };
  }

  function selectBetterPageData(currentPayload, nextPayload, pageKey) {
    if (!currentPayload || currentPayload.pageKey !== pageKey) return nextPayload;
    if (nextPayload.pageKey !== pageKey) return currentPayload;

    const currentScore = scoreNetworkPayload(currentPayload);
    const nextScore = scoreNetworkPayload(nextPayload);
    if (nextScore > currentScore) return nextPayload;
    if (nextScore === currentScore && nextPayload.receivedAt >= currentPayload.receivedAt) return nextPayload;
    return currentPayload;
  }

  function scoreNetworkPayload(payload) {
    if (!payload) return -1;
    const jobCount = payload.jobs?.length || 0;
    const rawCount = Number(payload.rawCount || 0);
    if (jobCount > 0) return 1000 + rawCount * 10 + jobCount;
    if (isExplicitEmptyFromNetwork(payload.captureMeta)) return 500 + rawCount;
    return rawCount;
  }

  function isUsableNetworkPayload(payload) {
    if (!payload) return false;
    return (payload.jobs?.length || 0) > 0 || isExplicitEmptyFromNetwork(payload.captureMeta);
  }

  function getSearchContexts() {
    const contexts = [];
    const queue = [{ doc: document, label: 'top' }];
    const seen = new Set();

    while (queue.length > 0) {
      const { doc, label } = queue.shift();
      if (!doc || seen.has(doc)) continue;
      seen.add(doc);

      contexts.push({
        doc,
        label,
        url: safeGetDocumentUrl(doc),
      });

      let frames = [];
      try {
        frames = Array.from(doc.querySelectorAll('iframe'));
      } catch (_) {}

      frames.forEach((frame, index) => {
        try {
          const frameDoc = frame.contentDocument;
          if (!frameDoc?.body) return;
          const frameLabel = `iframe[${index}] ${frame.src || safeGetDocumentUrl(frameDoc) || 'about:blank'}`;
          queue.push({ doc: frameDoc, label: frameLabel });
        } catch (_) {}
      });
    }

    return contexts;
  }

  function safeGetDocumentUrl(doc) {
    try {
      return doc.URL || doc.location?.href || '';
    } catch (_) {
      return '';
    }
  }

  function queryAllAcrossContexts(selector, contexts = getSearchContexts()) {
    const results = [];
    for (const { doc, label, url } of contexts) {
      try {
        doc.querySelectorAll(selector).forEach((node) => {
          results.push({ node, label, url, doc });
        });
      } catch (_) {}
    }
    return results;
  }

  function queryFirstAcrossContexts(selector, contexts = getSearchContexts()) {
    for (const ctx of contexts) {
      try {
        const node = ctx.doc.querySelector(selector);
        if (node) return { ...ctx, node };
      } catch (_) {}
    }
    return null;
  }

  function getPageMetrics(contexts = getSearchContexts()) {
    let bodyLen = 0;
    let linkCount = 0;
    let jobLinks = 0;
    let listItems = 0;
    const bodyTexts = [];

    for (const { doc } of contexts) {
      const bodyHtml = doc.body?.innerHTML || '';
      const bodyText = doc.body?.innerText || '';
      bodyLen += bodyHtml.length;
      bodyTexts.push(bodyText);
      try { linkCount += doc.querySelectorAll('a[href]').length; } catch (_) {}
      try { jobLinks += doc.querySelectorAll('a[href*="job_detail"], a[href*="/job/"]').length; } catch (_) {}
      try { listItems += doc.querySelectorAll('li').length; } catch (_) {}
    }

    const mergedBodyText = bodyTexts.join('\n').trim();
    return {
      contexts,
      bodyLen,
      bodyText: mergedBodyText,
      textLen: mergedBodyText.length,
      linkCount,
      jobLinks,
      listItems,
      frameCount: Math.max(0, contexts.length - 1),
      contextLabels: contexts.map((ctx) => ctx.label),
    };
  }

  function collectJobRelatedClasses(contexts = getSearchContexts()) {
    const allClasses = new Set();
    for (const { doc } of contexts) {
      try {
        doc.querySelectorAll('[class]').forEach((el) => {
          (el.className || '')
            .toString()
            .split(/\s+/)
            .forEach((cls) => {
              if (cls.length > 2 && cls.length < 60) allClasses.add(cls);
            });
        });
      } catch (_) {}
    }
    return [...allClasses]
      .filter((cls) => /job|card|search|result|list|position|recruit|chat|geek/i.test(cls))
      .slice(0, 40);
  }

  // ── 监听来自 service_worker 的消息指令 ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 启动检索（备用触发方式）
    if (msg.type === 'START_SCRAPING') {
      sendResponse({ ok: true });
      if (!scrapeStarted) {
        scrapeStarted = true;
        scrapeConfig  = msg;
        getSentJobIds().then((ids) => {
          sentJobIds  = ids;
          scrapedJobs = [];
          const currentPage = parseInt(new URL(window.location.href).searchParams.get('page') || '1', 10);
          scrapeSinglePage(currentPage, msg.maxPages || 10);
        });
      }
      return false;
    }

    // 在搜索页内发送打招呼消息（主发送方式）
    if (msg.type === 'SEND_JOB') {
      sendJobGreeting(msg.job, msg.message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message, code: 'EXCEPTION' }));
      return true; // 异步响应
    }

    return false;
  });

  // ── 主动从 storage 读取任务（主触发方式，不依赖消息） ─────────────────────────
  console.log('[JobSearcher] 运行版本:', RUNTIME_VERSION);
  console.log('[JobSearcher] content script 已注入，URL:', window.location.href);
  // 立即发心跳到 SW（诊断用，确认 content script 是否运行）
  chrome.runtime.sendMessage({ type: 'CS_ALIVE', url: window.location.href, version: RUNTIME_VERSION }).catch(() => {});
  autoStartFromStorage();

  async function autoStartFromStorage() {
    // 只在 Boss 直聘 搜索结果页生效
    if (!window.location.href.includes('zhipin.com/web/geek/jobs')) return;

    const result = await new Promise((r) => chrome.storage.local.get('scrapeTask', r));
    const task   = result.scrapeTask;

    if (!task?.active) return;

    // 任务超过 10 分钟视为过期
    if (Date.now() - task.startedAt > 10 * 60 * 1000) {
      console.log('[JobSearcher] 抓取任务已过期，忽略');
      await chrome.storage.local.remove('scrapeTask');
      return;
    }

    if (scrapeStarted) return;  // 已由消息方式启动
    scrapeStarted = true;
    scrapeConfig  = task;
    console.log('[JobSearcher] 从 storage 读取到抓取任务，自动启动');

    // 从 URL 读取当前页码（翻页重载后能正确感知所在页）
    const currentPage = parseInt(new URL(window.location.href).searchParams.get('page') || '1', 10);
    // 读取跨页累积的岗位列表
    scrapedJobs = Array.isArray(task.scrapedJobs) ? task.scrapedJobs : [];

    const ids = await getSentJobIds();
    sentJobIds  = ids;
    await scrapeSinglePage(currentPage, task.maxPages || 10);
  }

  // ── 单页抓取（每次页面加载只处理当前页，通过 storage 跨页累积） ──────────────

  async function scrapeSinglePage(currentPage, maxPages) {
    console.log(`[JobSearcher] 处理第 ${currentPage} 页（共最多 ${maxPages} 页）`);
    ensurePageCollector();
    lastSearchSummary = null;
    const sendMode = await getCurrentSendMode();

    // 上报进度
    chrome.runtime.sendMessage({
      type:    'SEARCH_PROGRESS',
      current: currentPage,
      total:   maxPages,
      found:   scrapedJobs.length,
    });

    // ── 立即诊断 DOM，发送到 service worker 便于查看（绕过Boss直聘反调试）──────
    const diagSelectors = [
      '.search-job-result', '.job-list', '[class*="job-list"]', '[class*="job-card"]',
      '.job-card-wrapper', '[data-jobid]', 'a[href*="job_detail"]', 'ul li', 'li',
    ];
    const initialContexts = getSearchContexts();
    const initialMetrics = getPageMetrics(initialContexts);
    const diagResults = {};
    diagSelectors.forEach((selector) => {
      diagResults[selector] = queryAllAcrossContexts(selector, initialContexts).length;
    });
    const jobRelatedClasses = collectJobRelatedClasses(initialContexts);
    chrome.runtime.sendMessage({
      type: 'DOM_DIAGNOSTIC',
      url:  window.location.href,
      bodyLen: initialMetrics.bodyLen,
      textLen: initialMetrics.textLen,
      linkCount: initialMetrics.linkCount,
      frameCount: initialMetrics.frameCount,
      contexts: initialMetrics.contextLabels,
      selectors: diagResults,
      jobRelatedClasses,
    });
    // ─────────────────────────────────────────────────────────────────────────

    let pageJobs = [];
    let source = 'dom';
    let status = 'data_capture_timeout';
    let captureMeta = null;
    let rawCount = 0;

    const networkPayload = await waitForPageCollectorData(20000);
    if (networkPayload) {
      pageJobs = networkPayload.jobs;
      rawCount = networkPayload.rawCount;
      captureMeta = networkPayload.captureMeta;
      if (pageJobs.length > 0) {
        source = 'network';
        status = 'success_with_jobs';
        console.log(`[JobSearcher] 页面内采集器拿到 ${pageJobs.length} 个岗位，raw=${rawCount}`);
      } else if (isExplicitEmptyFromNetwork(captureMeta)) {
        source = 'network';
        status = 'empty_result_confirmed';
        console.log('[JobSearcher] 页面内采集器确认当前页为空结果');
      } else {
        console.warn('[JobSearcher] 页面内采集器已命中响应，但岗位数为 0，继续 DOM 兜底');
      }
    } else {
      console.warn('[JobSearcher] 页面内采集器等待超时，进入 DOM 兜底');
    }

    if (pageJobs.length === 0 && status !== 'empty_result_confirmed') {
      // 等待列表渲染
      const loaded = await waitForJobList();
      if (!loaded) {
        console.warn(`[JobSearcher] 第 ${currentPage} 页加载失败，提前结束`);
        lastSearchSummary = buildSearchSummary({
          status: 'data_capture_timeout',
          source: networkPayload ? 'network' : 'dom',
          rawCount,
          newCount: 0,
          filteredSentCount: 0,
          captureMeta,
          page: currentPage,
        });
        reportSearchSummary(lastSearchSummary);
        await finishScraping();
        return;
      }

      // 解析当前页岗位
      pageJobs = parseJobsFromPage();
      rawCount = Math.max(rawCount, pageJobs.length);
      if (pageJobs.length === 0 && shouldRetryEmptyResult()) {
        console.warn('[JobSearcher] 首次解析为 0，疑似页面未完成渲染，进入恢复等待');
        pageJobs = await recoverJobsFromDynamicPage();
        rawCount = Math.max(rawCount, pageJobs.length);
      }

      if (pageJobs.length > 0) {
        source = 'dom';
        status = 'success_with_jobs';
      } else if (isExplicitEmptyState(getPageMetrics().bodyText)) {
        source = networkPayload ? 'network' : 'dom';
        status = 'empty_result_confirmed';
      } else if (isBlockedOrShellPage(getPageMetrics(), captureMeta)) {
        source = networkPayload ? 'network' : 'dom';
        status = 'blocked_or_shell_page';
      } else {
        status = networkPayload ? 'data_capture_timeout' : 'blocked_or_shell_page';
      }
    }

    console.log(`[JobSearcher] 第 ${currentPage} 页找到 ${pageJobs.length} 个岗位，来源=${source}，状态=${status}`);

    // 过滤已发送过的岗位，追加到累积列表
    const newJobs = pageJobs.filter((j) => j.jobId && !sentJobIds.has(j.jobId));
    const filteredSentCount = Math.max(0, pageJobs.length - newJobs.length);
    console.log(`[JobSearcher] 过滤结果 raw=${rawCount || pageJobs.length} new=${newJobs.length} filteredSent=${filteredSentCount}`);
    scrapedJobs.push(...newJobs);

    lastSearchSummary = buildSearchSummary({
      status,
      source,
      rawCount: rawCount || pageJobs.length,
      newCount: newJobs.length,
      filteredSentCount,
      captureMeta,
      page: currentPage,
    });
    reportSearchSummary(lastSearchSummary);

    // 判断是否继续翻页
    if (shouldContinueToNextPage(currentPage, maxPages, {
      rawCount: rawCount || pageJobs.length,
      status,
      captureMeta,
      source,
      sendMode,
    })) {
      // 将累积结果写回 storage，供下一页加载后读取
      await new Promise((r) => chrome.storage.local.set({
        scrapeTask: { ...scrapeConfig, scrapedJobs, active: true },
      }, r));
      await randomDelay(1500, 3000);
      goToNextPage(currentPage + 1);  // 导航，当前脚本上下文到此结束
    } else {
      await finishScraping();
    }
  }

  async function finishScraping() {
    console.log(`[JobSearcher] 检索完成，共 ${scrapedJobs.length} 个新岗位`);
    await chrome.storage.local.remove('scrapeTask').catch(() => {});
    chrome.runtime.sendMessage({
      type: 'JOB_LIST_READY',
      jobs: scrapedJobs,
      meta: lastSearchSummary,
    });
  }

  async function recoverJobsFromDynamicPage(timeout = 25000) {
    const start = Date.now();
    let lastBodyLen = getPageMetrics().bodyLen;

    while (Date.now() - start < timeout) {
      await randomDelay(800, 1200);

      const jobs = parseJobsFromPage();
      if (jobs.length > 0) {
        console.log(`[JobSearcher] 恢复等待后解析到 ${jobs.length} 个岗位`);
        return jobs;
      }

      const metrics = getPageMetrics();
      const { bodyLen, bodyText, linkCount } = metrics;

      if (isExplicitEmptyState(bodyText)) {
        console.log('[JobSearcher] 页面明确显示空结果');
        return [];
      }

      if (bodyLen > lastBodyLen + 2000) {
        console.log(`[JobSearcher] DOM 体积增长 ${lastBodyLen} -> ${bodyLen}，继续等待结果注入`);
        lastBodyLen = bodyLen;
      }

      if (hasRenderableJobSignals(metrics)) {
        console.log('[JobSearcher] 检测到岗位页信号，继续下一轮解析');
      }
    }

    reportDomSnapshot('EMPTY_RESULT_RECOVERY_TIMEOUT');
    return [];
  }

  function buildSearchSummary({
    status,
    source,
    rawCount,
    newCount,
    filteredSentCount,
    captureMeta,
    page,
  }) {
    return {
      status,
      source,
      rawCount: rawCount || 0,
      newCount: newCount || 0,
      filteredSentCount: filteredSentCount || 0,
      page: page || getCurrentPageNumber(),
      captureMeta: captureMeta || null,
    };
  }

  function reportSearchSummary(summary) {
    chrome.runtime.sendMessage({
      type: 'SEARCH_DIAGNOSTIC',
      stage: 'page_summary',
      ...summary,
    }).catch(() => {});
  }

  function shouldContinueToNextPage(currentPage, maxPages, summary = {}) {
    if (currentPage >= maxPages) return false;
    if (summary.sendMode === 'auto' && summary.status === 'success_with_jobs' && summary.source === 'network') {
      console.log('[JobSearcher] 自动模式已拿到网络岗位数据，直接结束检索进入发送');
      return false;
    }
    if (summary.sendMode !== 'auto' && summary.status === 'success_with_jobs' && (summary.rawCount || 0) > 0) {
      console.log('[JobSearcher] 确认模式首屏已拿到岗位，直接进入待发列表');
      return false;
    }

    const pageInfo = summary.captureMeta?.pageInfo || {};
    if (typeof pageInfo.hasMore === 'boolean') return pageInfo.hasMore;
    if (Number.isFinite(pageInfo.totalPages)) return currentPage < pageInfo.totalPages;
    if ((summary.rawCount || 0) > 0) return true;
    return hasNextPage();
  }

  function isExplicitEmptyFromNetwork(captureMeta) {
    if (!captureMeta) return false;
    if (captureMeta.explicitEmpty) return true;
    const pageInfo = captureMeta.pageInfo || {};
    return (
      Number.isFinite(pageInfo.totalCount) && pageInfo.totalCount === 0
    ) || (
      Number.isFinite(pageInfo.totalPages) && pageInfo.totalPages === 0
    );
  }

  function isBlockedOrShellPage(metrics, captureMeta) {
    const bodyText = metrics.bodyText || '';
    const blockedKeywords = ['请先登录', '登录后查看', '安全验证', '验证码', '风险', '异常访问', '滑动验证'];
    if (blockedKeywords.some((keyword) => bodyText.includes(keyword))) return true;
    const noNetworkHit = !captureMeta?.url;
    return noNetworkHit && metrics.bodyLen < 5000 && metrics.textLen < 80 && metrics.linkCount === 0;
  }

  function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  async function getCurrentSendMode() {
    if (scrapeConfig?.sendMode) return scrapeConfig.sendMode;
    return new Promise((resolve) => {
      chrome.storage.local.get('sendConfig', (result) => {
        resolve(result.sendConfig?.sendMode || 'manual_review');
      });
    });
  }

  // ── 解析当前页岗位列表 ─────────────────────────────────────────────────────────

  function parseJobsFromPage() {
    const contexts = getSearchContexts();

    // 方案1：用预定义选择器找职位卡
    let cards = queryAllAcrossContexts(SEL.jobCard, contexts);

    // 方案2（fallback）：通过 job_detail 链接向上找卡片容器
    if (cards.length === 0) {
      console.log('[JobSearcher] 预定义选择器无结果，启用 job_detail 链接 fallback');
      const seenNodes = new WeakSet();
      queryAllAcrossContexts('a[href*="job_detail"]', contexts).forEach(({ node: link, label, url, doc }) => {
        let cardNode = null;
        let node = link.parentElement;
        for (let i = 0; i < 6 && node && node !== doc.body; i++) {
          const tag = node.tagName.toLowerCase();
          if (['li', 'article'].includes(tag) ||
              /job|card|item|position/i.test(node.className || '')) {
            cardNode = node; break;
          }
          node = node.parentElement;
        }
        if (!cardNode) cardNode = link.parentElement;
        if (cardNode && !seenNodes.has(cardNode)) {
          seenNodes.add(cardNode);
          cards.push({ node: cardNode, label, url, doc });
        }
      });
      console.log(`[JobSearcher] job_detail 链接 fallback 找到 ${cards.length} 个卡片`);
    }

    // 方案3（最宽松 fallback）：所有含 job 相关链接的 li 元素
    if (cards.length === 0) {
      console.log('[JobSearcher] 启用最宽松 li fallback');
      const seenNodes = new WeakSet();
      queryAllAcrossContexts('li', contexts).forEach(({ node: li, label, url, doc }) => {
        const hasJobLink = li.querySelector('a[href*="job"]') || li.querySelector('a[href*="position"]');
        if (hasJobLink && li.textContent.trim().length > 20 && !seenNodes.has(li)) {
          seenNodes.add(li);
          cards.push({ node: li, label, url, doc });
        }
      });
      console.log(`[JobSearcher] li fallback 找到 ${cards.length} 个候选`);
    }

    // 方案4（直接从链接构造）：扫描所有 a[href] 中包含 job_detail 的链接，直接构造最简 job 对象
    if (cards.length === 0) {
      console.log('[JobSearcher] 启用直接链接扫描模式');
      const jobs = [];
      const seen = new Set();
      queryAllAcrossContexts('a[href]', contexts).forEach(({ node: a }) => {
        const href = a.href || '';
        if (!isLikelyBossJobUrl(href)) return;
        const match = href.match(/job_detail[/\\]([^/?#.]+)/);
        if (!match) return;
        const jobId = match[1];
        if (seen.has(jobId)) return;
        seen.add(jobId);
        // 从父元素挖掘文本信息
        const parent = a.closest('li, article, [class*="card"], [class*="job"]') || a.parentElement;
        const allText = parent?.textContent?.trim() || a.textContent?.trim() || '';
        const job = compactDomJob({
          jobId,
          jobTitle:     a.textContent?.trim() || allText.slice(0, 30) || jobId,
          company:      '',
          salary:       '',
          city:         extractCity(),
          recruiterName:'',
          recruiterId:  '',
          jobDetailUrl: href,
          jobDescription: '',
        });
        if (job) jobs.push(job);
      });
      console.log(`[JobSearcher] 直接链接扫描找到 ${jobs.length} 个岗位`);
      return jobs;
    }

    const jobMap = new Map();
    cards.forEach(({ node: card }) => {
      try {
        const job = parseJobCard(card);
        if (job && job.jobId && !jobMap.has(job.jobId)) {
          jobMap.set(job.jobId, job);
        }
      } catch (e) {
        console.warn('[JobSearcher] 解析岗位卡片失败:', e);
      }
    });
    const jobs = [...jobMap.values()];
    console.log(`[JobSearcher] parseJobsFromPage 最终解析出 ${jobs.length} 个岗位`);
    return jobs;
  }

  function parseJobCard(card) {
    // 优先从 data 属性取 jobId
    const jobId =
      card.dataset?.jobid ||
      card.getAttribute('data-jobid') ||
      extractJobIdFromLink(card);

    if (!jobId) return null;

    const titleEl      = card.querySelector(SEL.jobTitle);
    const companyEl    = card.querySelector(SEL.company);
    const salaryEl     = card.querySelector(SEL.salary);
    const recruiterEl  = card.querySelector(SEL.recruiterInfo);
    const linkEl       = card.querySelector(SEL.jobLink) || card.closest('a');

    // 招聘者信息（格式：姓名 · 职位，如"张三 · HR"）
    const recruiterText = recruiterEl?.textContent?.trim() || '';
    const recruiterName = recruiterText.split('·')[0]?.trim() || '';

    return compactDomJob({
      jobId:        jobId.trim(),
      jobTitle:     titleEl?.textContent?.trim()   || '',
      company:      companyEl?.textContent?.trim() || '',
      salary:       salaryEl?.textContent?.trim()  || '',
      city:         extractCity(),
      recruiterName,
      recruiterId:  extractRecruiterId(card, linkEl),
      jobDetailUrl: linkEl?.href || '',
      jobDescription: '', // 详情页抓取后补充
    });
  }

  function extractJobIdFromLink(card) {
    const link = card.querySelector('a[href*="job_detail"]') || card.querySelector('a[href]');
    if (!link) return null;
    if (!isLikelyBossJobUrl(link.href)) return null;
    // 匹配多种 URL 格式：/job_detail/ID.html 或 /job_detail/ID
    const match = link.href.match(/job_detail[/\\]([^/?#.]+)/);
    if (match) return match[1];
    // 兜底：用链接 href 的 hash 或路径最后部分作为 ID
    try {
      const url = new URL(link.href);
      const pathParts = url.pathname.replace(/\.html$/, '').split('/').filter(Boolean);
      const lastPart  = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.length > 4 && /[A-Za-z0-9]/.test(lastPart)) return lastPart;
    } catch (e) { /* ignore */ }
    return null;
  }

  function extractRecruiterId(card, linkEl) {
    // Boss直聘通常在链接参数中包含 encryptJobId 或 lid
    if (linkEl?.href && isLikelyBossJobUrl(linkEl.href)) {
      const url    = new URL(linkEl.href);
      const encId  = url.searchParams.get('encryptJobId') || url.searchParams.get('lid');
      if (encId) return encId;
    }
    // fallback：使用 jobId 作为 recruiterId
    return card.dataset?.jobid || '';
  }

  function extractCity() {
    // 从当前 URL 的 city 参数获取
    const url    = new URL(window.location.href);
    return url.searchParams.get('city') || '';
  }

  function compactDomJob(job) {
    if (!job?.jobId) return null;
    const normalized = {
      jobId: String(job.jobId || '').trim(),
      jobTitle: String(job.jobTitle || '').trim(),
      company: String(job.company || '').trim(),
      salary: String(job.salary || '').trim(),
      city: String(job.city || '').trim(),
      recruiterName: String(job.recruiterName || '').trim(),
      recruiterId: String(job.recruiterId || job.jobId || '').trim(),
      jobDetailUrl: String(job.jobDetailUrl || '').trim(),
      jobDescription: '',
    };

    if (!isLikelyBossJobUrl(normalized.jobDetailUrl)) return null;

    const infoScore = [
      normalized.jobTitle,
      normalized.company,
      normalized.salary,
      normalized.recruiterName,
    ].filter(Boolean).length;

    if (infoScore === 0) return null;
    if (!normalized.jobTitle && !normalized.company) return null;
    return normalized;
  }

  function isLikelyBossJobUrl(href = '') {
    if (!href) return false;
    try {
      const url = new URL(href, window.location.origin);
      return url.hostname.includes('zhipin.com') && /\/job_detail\//.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  // ── 翻页 ──────────────────────────────────────────────────────────────────────

  function hasNextPage() {
    // 方法1：检查下一页按钮是否存在且可点击
    const contexts = getSearchContexts();
    for (const { doc } of contexts) {
      try {
        const nextBtn = doc.querySelector(SEL.nextPageBtn);
        if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('disabled')) {
          return true;
        }
      } catch (_) {}
    }

    // 方法2：检查当前页码
    for (const { doc } of contexts) {
      try {
        const currentPageEl = doc.querySelector('[class*="current-page"], .active-page');
        if (currentPageEl) {
          const currentPage = parseInt(currentPageEl.textContent, 10);
          const totalPages  = getTotalPages();
          return currentPage < totalPages;
        }
      } catch (_) {}
    }

    return false;
  }

  function getTotalPages() {
    const contexts = getSearchContexts();
    for (const { doc } of contexts) {
      try {
        const pageEls = doc.querySelectorAll('[class*="page-item"], .options-pages a');
        if (pageEls.length > 0) {
          const lastPageEl = pageEls[pageEls.length - 1];
          const num = parseInt(lastPageEl.textContent, 10);
          if (!isNaN(num)) return num;
        }
      } catch (_) {}
    }
    return 1;
  }

  function goToNextPage(pageNum) {
    return new Promise((resolve) => {
      // 方法1：修改 URL 参数跳转（更稳定）
      const url = new URL(window.location.href);
      url.searchParams.set('page', pageNum);
      window.location.href = url.toString();
      // 页面跳转后 content script 重新注入，resolve 立即返回
      setTimeout(resolve, 500);
    });
  }

  // ── 等待列表加载 ───────────────────────────────────────────────────────────────

  function waitForJobList(timeout = 30000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const exactSelectors = [
        '.search-job-result', '.job-list', '[class*="job-list"]',
        '[class*="search-job"]', '.job-card-wrapper', '.job-card-body',
        '[class*="job-card"]', '[data-jobid]',
        'a[href*="/job_detail/"]', 'a[href*="job_detail"]',
      ];

      const check = () => {
        const contexts = getSearchContexts();
        // 1. 精确选择器（新旧版Boss直聘）
        for (const sel of exactSelectors) {
          const matches = queryAllAcrossContexts(sel, contexts);
          if (matches.length > 0) {
            console.log(`[JobSearcher] 列表就绪，命中: "${sel}"，上下文: ${matches[0].label}`);
            resolve(true); return;
          }
        }

        // 2. 降级：页面有大量文字内容就认为已渲染（React已跑完首屏）
        const metrics = getPageMetrics(contexts);
        if (hasRenderableJobSignals(metrics)) {
          console.log(`[JobSearcher] 页面已渲染（text=${metrics.textLen}, links=${metrics.linkCount}, frames=${metrics.frameCount}），尝试解析`);
          resolve(true); return;
        }

        // 2.5 明确空结果时直接继续解析，避免无谓等待
        if (isExplicitEmptyState(metrics.bodyText)) {
          console.log('[JobSearcher] 检测到明确空结果提示');
          resolve(true); return;
        }

        // 3. 超时后强制继续 —— 让 parseJobsFromPage 去处理（不再硬性失败）
        if (Date.now() - start > timeout) {
          console.warn('[JobSearcher] waitForJobList 超时，强制继续');
          reportDomSnapshot('WAIT_FOR_JOB_LIST_TIMEOUT', exactSelectors, metrics.textLen, metrics.linkCount);
          resolve(true); // 强制返回 true，让 parseJobsFromPage 尝试
          return;
        }
        setTimeout(check, 400);
      };

      check(); // 立即开始，不延迟
    });
  }

  function hasRenderableJobSignals({
    bodyText = '',
    textLen = bodyText.trim().length,
    linkCount = 0,
    jobLinks = 0,
    listItems = 0,
    frameCount = 0,
  } = {}) {
    const jobKeywords = ['职位', '招聘', '薪资', '经验', '立即沟通', '公司'];
    const keywordHits = jobKeywords.filter((k) => bodyText.includes(k)).length;
    return (
      (jobLinks >= 3) ||
      (frameCount > 0 && jobLinks >= 1) ||
      (keywordHits >= 2 && linkCount >= 8 && textLen >= 1200) ||
      (listItems >= 8 && textLen >= 1500)
    );
  }

  function isExplicitEmptyState(bodyText = '') {
    const emptyHints = [
      '未找到相关职位',
      '没有找到相关职位',
      '暂无相关职位',
      '为空',
      '搜索结果为空',
      '没有匹配的职位',
    ];
    return emptyHints.some((hint) => bodyText.includes(hint));
  }

  function shouldRetryEmptyResult() {
    const metrics = getPageMetrics();
    const { bodyText, bodyLen, linkCount } = metrics;
    if (isExplicitEmptyState(bodyText)) return false;
    if (queryAllAcrossContexts('[data-jobid], a[href*="job_detail"]').length > 0) return false;
    return bodyLen < 8000 || linkCount < 8 || !hasRenderableJobSignals(metrics);
  }

  function reportDomSnapshot(reason, selectors, textLen, linkCount) {
    const contexts = getSearchContexts();
    const metrics = getPageMetrics(contexts);
    const exactSelectors = selectors || [
      '.search-job-result', '.job-list', '[class*="job-list"]',
      '[class*="search-job"]', '.job-card-wrapper', '.job-card-body',
      '[class*="job-card"]', '[data-jobid]',
      'a[href*="/job_detail/"]', 'a[href*="job_detail"]',
    ];
    const resolvedTextLen = textLen ?? metrics.textLen;
    const resolvedLinkCount = linkCount ?? metrics.linkCount;
    const bodySnippet = contexts
      .map(({ label, doc }) => `[${label}] ${(doc.body?.innerHTML || '').slice(0, 220)}`)
      .filter(Boolean)
      .slice(0, 3)
      .join('\n');

    chrome.runtime.sendMessage({
      type: 'DOM_DIAGNOSTIC',
      url: window.location.href,
      bodyLen: metrics.bodyLen,
      bodySnippet,
      frameCount: metrics.frameCount,
      contexts: metrics.contextLabels,
      selectors: Object.fromEntries(
        exactSelectors.map((s) => {
          try { return [s, queryAllAcrossContexts(s, contexts).length]; } catch { return [s, -1]; }
        })
      ),
      textLen: resolvedTextLen,
      linkCount: resolvedLinkCount,
      reason,
      jobRelatedClasses: collectJobRelatedClasses(contexts),
    }).catch(() => {});
  }

  // ── 从 storage 获取已发送岗位 ID ──────────────────────────────────────────────

  function getSentJobIds() {
    return new Promise((resolve) => {
      chrome.storage.local.get('sendHistory', (result) => {
        const history = result.sendHistory || [];
        const ids = new Set(history.map((r) => r.jobId));
        resolve(ids);
      });
    });
  }

  // ── 随机延迟 ──────────────────────────────────────────────────────────────────

  function randomDelay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 在搜索页内直接发送打招呼消息
  // 流程：点击左侧职位卡 → 右侧预览更新 → 点击「立即沟通」→ 等聊天框 → 发送
  // ═══════════════════════════════════════════════════════════════════════════

  async function sendJobGreeting(job, message) {
    console.log('[Sender] 开始发送:', job.jobTitle, job.company);

    try {
      // Step 1：在左侧列表中找到并点击该职位卡
      const clicked = await clickJobCard(job);
      if (!clicked) {
        return { success: false, code: 'NO_CARD', error: '当前页面未找到职位卡' };
      }

      // Step 2：等待右侧预览面板更新
      await randomDelay(1500, 2500);

      // Step 3：找到并点击「立即沟通」按钮
      const chatOpened = await openChatPanel();
      if (!chatOpened) {
        const loginCheck = detectLoginRequired();
        if (loginCheck) return { success: false, error: '需要登录 Boss 直聘', code: 'NOT_LOGGED_IN' };
        const blockedMsg = detectChatOpenBlocked();
        if (blockedMsg) return { success: false, error: blockedMsg, code: 'CHAT_OPEN_BLOCKED' };
        return { success: false, error: '未找到「立即沟通」按钮', code: 'NO_CHAT_BTN' };
      }

      // Step 4：等待聊天输入框出现
      const inputEl = await waitForChatInputEl(12000);
      if (!inputEl) {
        const limitMsg = detectLimitHint();
        if (limitMsg) return { success: false, error: limitMsg, code: 'LIMIT_REACHED' };
        return { success: false, error: '聊天框未出现', code: 'NO_INPUT' };
      }

      // Step 5：聚焦输入框
      inputEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      await randomDelay(200, 400);
      inputEl.click();
      inputEl.focus();
      await randomDelay(300, 600);

      // Step 6：逐字输入消息
      await typeIntoInput(inputEl, message);
      await randomDelay(500, 900);

      // Step 7：发送（Enter 键 + 点击按钮双保险）
      sendMessage(inputEl);
      await randomDelay(800, 1200);

      console.log('[Sender] 发送成功:', job.jobTitle);
      return { success: true };

    } catch (err) {
      console.error('[Sender] sendJobGreeting 异常:', err);
      return { success: false, error: err.message, code: 'EXCEPTION' };
    }
  }

  // ── 点击左侧职位卡片 ───────────────────────────────────────────────────────────

  async function clickJobCard(job) {
    const contexts = getSearchContexts();

    // 方法1：data-jobid 精确匹配
    const byAttr = queryFirstAcrossContexts(`[data-jobid="${job.jobId}"]`, contexts)?.node;
    if (byAttr && isVisible(byAttr)) {
      byAttr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      await randomDelay(150, 300);
      byAttr.click();
      return true;
    }

    // 方法2：通过 href 中的 jobId 找到 <a> 标签
    const links = queryAllAcrossContexts('a[href*="/job_detail/"]', contexts).map(({ node }) => node);
    for (const link of links) {
      if (link.href.includes(job.jobId)) {
        const card = link.closest('[data-jobid], .job-card-wrapper, .job-card-left') || link;
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randomDelay(150, 300);
        card.click();
        return true;
      }
    }

    // 方法3：通过职位名称 + 公司名匹配
    const cards = queryAllAcrossContexts('.job-card-wrapper, [data-jobid]', contexts).map(({ node }) => node);
    for (const card of cards) {
      const titleEl   = card.querySelector('.job-name, [class*="job-name"]');
      const companyEl = card.querySelector('.company-name, [class*="company-name"]');
      if (
        titleEl?.textContent?.trim() === job.jobTitle &&
        companyEl?.textContent?.trim() === job.company &&
        isVisible(card)
      ) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        await randomDelay(150, 300);
        card.click();
        return true;
      }
    }

    return false;
  }

  // ── 点击「立即沟通」按钮 ───────────────────────────────────────────────────────

  async function openChatPanel(timeout = 12000) {
    const urlBefore = window.location.href;
    const start = Date.now();
    let fallbackHref = null;
    let hrefTried = false;

    while (Date.now() - start < timeout) {
      if (findExistingChatInput()) {
        return true;
      }

      // CSS 选择器优先（精确命中常见 Boss 直聘类名）
      const cssCandidates = [
        '.op-btn-chat',
        '.btn-chat',
        '[class*="chat-btn"]',
        '[class*="btn-chat"]',
        '.start-chat-btn',
        '.link-btn-chat',
        '.communicate-btn',
        '[class*="communicate"]',
        'a[href*="/web/im/"]',
        'a[href*="/web/chat/"]',
        'button[class*="chat"]',
        'a[class*="chat"]',
      ];
      for (const sel of cssCandidates) {
        const btn = queryFirstAcrossContexts(sel)?.node;
        if (btn && isVisible(btn)) {
          console.log('[clickChatButton] CSS选择器命中:', sel);
          fallbackHref = fallbackHref || btn.closest('a[href]')?.href || btn.href || null;
          if (await activateChatEntry(btn, urlBefore)) return true;
        }
      }

      // 文字内容匹配：覆盖所有可点击元素（含普通 span/div）
      const textPatterns = ['立即沟通', '继续沟通', '直接沟通', '联系我'];
      // 先精确匹配（文字恰好等于目标），再模糊匹配（文字包含目标且足够短）
      const elements = queryAllAcrossContexts(
        'a, button, span, div, [role="button"], .op-btn, [class*="btn"]'
      ).map(({ node }) => node);
      let fuzzyMatch = null;
      for (const el of elements) {
        if (!isVisible(el)) continue;
        const text = (el.textContent ?? '').trim();
        if (textPatterns.includes(text)) {
          console.log('[clickChatButton] 文字精确匹配:', text, el.tagName, el.className);
          fallbackHref = fallbackHref || el.closest('a[href]')?.href || el.href || null;
          if (await activateChatEntry(el, urlBefore)) return true;
        }
        // 备用：包含关键词且元素自身文字不超过 15 字（避免匹配大段落）
        if (!fuzzyMatch && text.length <= 15 && textPatterns.some(p => text.includes(p))) {
          fuzzyMatch = el;
        }
      }
      if (fuzzyMatch) {
        console.log('[clickChatButton] 文字模糊匹配:', fuzzyMatch.textContent?.trim(), fuzzyMatch.tagName);
        fallbackHref = fallbackHref || fuzzyMatch.closest('a[href]')?.href || fuzzyMatch.href || null;
        if (await activateChatEntry(fuzzyMatch, urlBefore)) return true;
      }

      if (!hrefTried && fallbackHref && /\/web\/(im|chat)\//.test(fallbackHref)) {
        hrefTried = true;
        window.location.assign(fallbackHref);
        await randomDelay(2200, 3200);
        if (findExistingChatInput()) return true;
      }

      await randomDelay(400, 600);
    }

    console.warn('[clickChatButton] 超时：未找到「立即沟通」按钮');
    return false;
  }

  async function activateChatEntry(el, urlBefore) {
    for (const target of getClickableTargets(el)) {
      fireClick(target);
      await randomDelay(700, 1100);
      if (window.location.href !== urlBefore) {
        console.log('[clickChatButton] URL 已变化，等待聊天页渲染...');
        await randomDelay(1800, 2600);
      }
      if (findExistingChatInput()) return true;
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

  /** 触发点击，同时派发合成 MouseEvent 确保 React/Vue 框架感知 */
  function fireClick(el) {
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

  function findExistingChatInput() {
    return (
      queryFirstAcrossContexts('#chat-input')?.node ||
      queryFirstAcrossContexts('.dialog-textarea')?.node ||
      waitForVisibleInputSync()
    );
  }

  function waitForVisibleInputSync() {
    const selectors = [
      '#chat-input',
      'textarea#chat-input',
      '.dialog-textarea',
      '.editor-content[contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ];
    for (const sel of selectors) {
      const match = queryFirstAcrossContexts(sel);
      if (match?.node && isVisible(match.node)) return match.node;
    }
    return null;
  }

  // ── 等待聊天输入框出现 ─────────────────────────────────────────────────────────

  function waitForChatInputEl(timeout = 10000) {
    const selectors = [
      '#chat-input',                                         // ★ Boss直聘聊天页固定 ID（最可靠）
      'textarea#chat-input',
      '.dialog-textarea',
      '.editor-content[contenteditable="true"]',
      '[contenteditable="true"][class*="editor"]',
      '[contenteditable="true"][placeholder*="输入"]',
      '[contenteditable="true"][placeholder*="说点"]',
      '[contenteditable="true"][placeholder*="聊"]',
      '[contenteditable="true"][placeholder*="消息"]',
      '[contenteditable="true"][placeholder*="给"]',
      '[contenteditable="true"][placeholder*="留言"]',
      '[contenteditable="true"][class*="chat-input"]',
      '[contenteditable="true"][class*="im-input"]',
      '[class*="chat-dialog"] [contenteditable="true"]',
      '[class*="im-dialog"] [contenteditable="true"]',
      '[class*="chat-box"] [contenteditable="true"]',
      '[class*="dialog"] [contenteditable="true"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="说点"]',
      'textarea[placeholder*="给"]',
      'textarea',                                            // 兜底
      '[contenteditable="true"]',
    ];

    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        for (const sel of selectors) {
          const match = queryFirstAcrossContexts(sel);
          if (match?.node && isVisible(match.node)) {
            console.log('[waitForChatInputEl] 找到输入框，选择器:', sel, '上下文:', match.label);
            resolve(match.node);
            return;
          }
        }
        if (Date.now() - start > timeout) {
          console.warn('[waitForChatInputEl] 超时：未找到聊天输入框');
          resolve(null);
          return;
        }
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  // ── 检测日发送上限 ─────────────────────────────────────────────────────────────

  function detectLimitHint() {
    const keywords = [
      '今日招呼次数已用完', '今日已达到', '每日沟通上限',
      '沟通次数上限', '频率限制', '今日打招呼',
    ];
    const bodyText = document.body.innerText || '';
    return keywords.find((k) => bodyText.includes(k)) || null;
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

  // ── 检测是否需要登录 ───────────────────────────────────────────────────────────

  function detectLoginRequired() {
    return (
      window.location.href.includes('/web/user/') ||
      !!document.querySelector('.login-dialog, [class*="login-dialog"]') ||
      (document.body.innerText || '').includes('请先登录')
    );
  }

  // ── 模拟逐字输入 ───────────────────────────────────────────────────────────────

  async function typeIntoInput(el, text) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      // 分块插入，模拟真实打字
      let i = 0;
      while (i < text.length) {
        const chunk = text.slice(i, i + Math.floor(Math.random() * 8) + 4);
        document.execCommand('insertText', false, chunk);
        i += chunk.length;
        await randomDelay(20, 60);
      }
    } else {
      // ★ textarea（如 Boss直聘聊天页 #chat-input）—— 用 React native setter 触发受控组件
      const nativeSetter =
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, text);
      } else {
        el.value = text;
      }
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── 触发发送 ───────────────────────────────────────────────────────────────────

  function sendMessage(inputEl) {
    // Enter 键
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    inputEl.dispatchEvent(new KeyboardEvent('keydown',  opts));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', opts));
    inputEl.dispatchEvent(new KeyboardEvent('keyup',    opts));

    // 点击发送按钮（fallback）
    const sendSelectors = ['.send-msg', '.btn-send', '[class*="send-btn"]', 'button[class*="send"]'];
    for (const sel of sendSelectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) { btn.click(); break; }
    }
  }

  // ── 可见性判断 ─────────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 &&
      style.visibility !== 'hidden' && style.display !== 'none' &&
      style.opacity !== '0'
    );
  }
})();
