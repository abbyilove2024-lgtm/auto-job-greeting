/**
 * page_job_collector.js
 * 注入到页面主世界，拦截搜索页 fetch/XHR，提取岗位数据并桥接给 content script
 */

(function () {
  'use strict';

  if (window.__AUTO_JOB_GREETING_PAGE_COLLECTOR__) return;
  window.__AUTO_JOB_GREETING_PAGE_COLLECTOR__ = true;

  const COLLECTOR_VERSION = '2026-04-03-search-network-v5';
  const BRIDGE_SOURCE = 'AUTO_JOB_GREETING_PAGE_COLLECTOR';
  const SEARCH_PATH_HINTS = ['/web/geek/jobs', '/wapi/zpgeek/search/joblist', '/search/joblist', '/joblist.json'];
  const JOB_PATH_HINTS = ['job', 'position', 'geek', 'search'];

  emit('PAGE_COLLECTOR_READY', {
    href: window.location.href,
    version: COLLECTOR_VERSION,
  });

  installFetchHook();
  installXhrHook();
  installHistoryHook();
  scheduleBootstrapScan();

  function installFetchHook() {
    if (typeof window.fetch !== 'function' || window.fetch.__autoJobGreetingPatched) return;
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = getRequestUrl(args[0], response?.url);
      handleResponseCandidate({
        url,
        transport: 'fetch',
        response,
      });
      return response;
    };
    wrappedFetch.__autoJobGreetingPatched = true;
    window.fetch = wrappedFetch;
  }

  function installXhrHook() {
    if (typeof window.XMLHttpRequest !== 'function' || window.XMLHttpRequest.__autoJobGreetingPatched) return;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__autoJobGreetingUrl = typeof url === 'string' ? url : '';
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener('loadend', () => {
        handleXhrCandidate(this);
      });
      return originalSend.apply(this, args);
    };

    window.XMLHttpRequest.__autoJobGreetingPatched = true;
  }

  function installHistoryHook() {
    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    window.addEventListener('popstate', () => {
      emit('PAGE_NAVIGATION', { href: window.location.href });
    });
  }

  function patchHistoryMethod(name) {
    const original = history[name];
    if (typeof original !== 'function' || original.__autoJobGreetingPatched) return;
    const wrapped = function patchedHistory(...args) {
      const result = original.apply(this, args);
      emit('PAGE_NAVIGATION', {
        href: window.location.href,
        method: name,
      });
      return result;
    };
    wrapped.__autoJobGreetingPatched = true;
    history[name] = wrapped;
  }

  function scheduleBootstrapScan() {
    const scan = () => {
      try {
        const candidates = [];
        const globals = [
          window.__INITIAL_STATE__,
          window.__NEXT_DATA__,
          window.__NUXT__,
          window.__APP_DATA__,
          window.__SEARCH_STATE__,
        ];

        globals.forEach((item, index) => {
          if (item && typeof item === 'object') {
            candidates.push({
              transport: 'bootstrap',
              url: `window_global_${index}`,
              payload: item,
            });
          }
        });

        candidates.forEach((candidate) => {
          inspectPayload(candidate.payload, candidate.url, candidate.transport, true);
        });
      } catch (_) {}
    };

    setTimeout(scan, 0);
    setTimeout(scan, 1500);
  }

  async function handleResponseCandidate({ url, transport, response }) {
    try {
      if (!response) return;

      const contentType = response.headers?.get?.('content-type') || '';
      const shouldAttempt =
        isLikelySearchResponse(url) ||
        contentType.includes('json') ||
        contentType.includes('javascript') ||
        contentType.includes('text/plain');

      if (!shouldAttempt) return;

      const cloned = response.clone();
      let payload = null;

      if (contentType.includes('json')) {
        payload = await cloned.json().catch(() => null);
      } else {
        const text = await cloned.text().catch(() => '');
        payload = tryParseJson(text);
      }

      if (!payload) return;
      inspectPayload(payload, url, transport, false);
    } catch (error) {
      emit('PAGE_COLLECTOR_DIAGNOSTIC', {
        stage: 'handle_response_error',
        transport,
        url,
        error: error?.message || String(error),
      });
    }
  }

  function handleXhrCandidate(xhr) {
    try {
      const url = xhr.__autoJobGreetingUrl || xhr.responseURL || '';
      const contentType = xhr.getResponseHeader?.('content-type') || '';
      const shouldAttempt =
        isLikelySearchResponse(url) ||
        contentType.includes('json') ||
        (typeof xhr.responseText === 'string' && xhr.responseText.includes('job'));

      if (!shouldAttempt) return;

      let payload = null;
      if (xhr.responseType === 'json' && xhr.response) {
        payload = xhr.response;
      } else if (!xhr.responseType || xhr.responseType === 'text') {
        payload = tryParseJson(xhr.responseText);
      }

      if (!payload) return;
      inspectPayload(payload, url, 'xhr', false);
    } catch (error) {
      emit('PAGE_COLLECTOR_DIAGNOSTIC', {
        stage: 'handle_xhr_error',
        transport: 'xhr',
        url: xhr?.responseURL || xhr?.__autoJobGreetingUrl || '',
        error: error?.message || String(error),
      });
    }
  }

  function inspectPayload(payload, url, transport, fromBootstrap) {
    const analysis = analyzePayload(payload, url);
    if (!analysis) {
      if (isLikelySearchResponse(url)) {
        emit('PAGE_COLLECTOR_DIAGNOSTIC', {
          stage: 'payload_seen_no_jobs',
          transport,
          fromBootstrap,
          url,
        });
      }
      return;
    }

    emit('PAGE_JOBS', {
      href: window.location.href,
      pageKey: buildPageKey(window.location.href),
      jobs: analysis.jobs,
      rawCount: analysis.rawCount,
      captureMeta: {
        url,
        transport,
        fromBootstrap,
        captureUrlPattern: compactUrl(url),
        explicitEmpty: analysis.explicitEmpty,
        pageInfo: analysis.pageInfo,
        arrayPath: analysis.arrayPath,
      },
    });
  }

  function analyzePayload(payload, url) {
    const candidates = [];
    const emptySignals = [];
    const pageInfo = extractPageInfo(payload, url);

    walk(payload, [], 0);

    function walk(node, path, depth) {
      if (!node || depth > 6) return;

      if (Array.isArray(node)) {
        if (node.length === 0 && looksLikeJobPath(path)) {
          emptySignals.push(path.join('.'));
        }

        const normalizedJobs = node
          .map((item) => normalizeJobItem(item, url))
          .filter(Boolean);

        if (normalizedJobs.length > 0) {
          candidates.push({
            path: path.join('.'),
            jobs: dedupeJobs(normalizedJobs),
            score: scoreJobArray(node, normalizedJobs, path),
          });
        }

        node.slice(0, 50).forEach((child, index) => walk(child, path.concat(String(index)), depth + 1));
        return;
      }

      if (typeof node !== 'object') return;

      Object.entries(node).slice(0, 60).forEach(([key, value]) => {
        walk(value, path.concat(key), depth + 1);
      });
    }

    const best = candidates.sort((a, b) => b.score - a.score || b.jobs.length - a.jobs.length)[0];
    const explicitEmpty = best ? false : isExplicitEmptyPayload(payload) || emptySignals.length > 0 || isPageInfoEmpty(pageInfo);

    if (!best && !explicitEmpty && !isLikelySearchResponse(url)) {
      return null;
    }

    return {
      jobs: best?.jobs || [],
      rawCount: best?.jobs?.length || 0,
      explicitEmpty,
      pageInfo,
      arrayPath: best?.path || emptySignals[0] || '',
    };
  }

  function scoreJobArray(rawArray, normalizedJobs, path) {
    const pathText = path.join('.').toLowerCase();
    let score = normalizedJobs.length * 10;
    if (pathText.includes('job')) score += 30;
    if (pathText.includes('list')) score += 20;
    if (pathText.includes('search')) score += 15;
    if (normalizedJobs.length === rawArray.length) score += 10;
    return score;
  }

  function normalizeJobItem(item, sourceUrl) {
    if (!item || typeof item !== 'object') return null;

    const jobId = firstValue(item, [
      ['encryptJobId'],
      ['jobId'],
      ['securityId'],
      ['positionId'],
      ['postId'],
      ['id'],
      ['job', 'encryptJobId'],
      ['job', 'jobId'],
    ]);

    const jobTitle = firstValue(item, [
      ['jobName'],
      ['jobTitle'],
      ['positionName'],
      ['postName'],
      ['name'],
      ['job', 'jobName'],
      ['job', 'title'],
    ]);

    const company = firstValue(item, [
      ['brandName'],
      ['companyName'],
      ['company'],
      ['brand', 'brandName'],
      ['brandInfo', 'brandName'],
      ['bossCompany', 'name'],
    ]);

    const salary = firstValue(item, [
      ['salaryDesc'],
      ['salary'],
      ['salaryStr'],
      ['payDesc'],
      ['job', 'salaryDesc'],
    ]);

    const city = firstValue(item, [
      ['cityName'],
      ['city'],
      ['locationName'],
      ['areaDistrict'],
      ['address'],
      ['job', 'cityName'],
    ]);

    const recruiterName = firstValue(item, [
      ['bossName'],
      ['recruiterName'],
      ['friendName'],
      ['userName'],
      ['boss', 'name'],
      ['bossInfo', 'name'],
    ]);

    const recruiterId = firstValue(item, [
      ['encryptBossId'],
      ['bossId'],
      ['recruiterId'],
      ['uid'],
      ['boss', 'encryptBossId'],
      ['bossInfo', 'encryptBossId'],
    ]);

    const jobUrl = firstValue(item, [
      ['jobUrl'],
      ['positionUrl'],
      ['url'],
      ['href'],
      ['job', 'jobUrl'],
    ]) || buildJobDetailUrl(jobId, sourceUrl);

    if (!jobId && !jobTitle) return null;
    if (!jobTitle && !company && !salary) return null;

    return compactJob({
      jobId: stringify(jobId || ''),
      jobTitle: stringify(jobTitle || ''),
      company: stringify(company || ''),
      salary: stringify(salary || ''),
      city: stringify(city || ''),
      recruiterName: stringify(recruiterName || ''),
      recruiterId: stringify(recruiterId || jobId || ''),
      jobDetailUrl: stringify(jobUrl || ''),
      jobDescription: '',
    });
  }

  function compactJob(job) {
    if (!job.jobId) return null;
    return {
      jobId: job.jobId,
      jobTitle: job.jobTitle,
      company: job.company,
      salary: job.salary,
      city: job.city,
      recruiterName: job.recruiterName,
      recruiterId: job.recruiterId,
      jobDetailUrl: job.jobDetailUrl,
      jobDescription: '',
    };
  }

  function dedupeJobs(jobs) {
    const map = new Map();
    jobs.forEach((job) => {
      if (job?.jobId && !map.has(job.jobId)) map.set(job.jobId, job);
    });
    return [...map.values()];
  }

  function buildJobDetailUrl(jobId, sourceUrl) {
    const cleanedId = stringify(jobId || '').replace(/\.html$/, '');
    if (!cleanedId) return '';
    try {
      const source = new URL(sourceUrl || window.location.href, window.location.origin);
      return `${source.origin}/job_detail/${cleanedId}.html`;
    } catch (_) {
      return `https://www.zhipin.com/job_detail/${cleanedId}.html`;
    }
  }

  function firstValue(obj, paths) {
    for (const path of paths) {
      let value = obj;
      for (const key of path) {
        value = value?.[key];
      }
      if (value !== undefined && value !== null && stringify(value)) return value;
    }
    return '';
  }

  function stringify(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function extractPageInfo(payload, url) {
    const pageInfo = {
      currentPage: toNumber(firstDeepValue(payload, ['page', 'curPage', 'currentPage', 'pageNo'])),
      totalPages: toNumber(firstDeepValue(payload, ['totalPage', 'pageCount', 'totalPages', 'pages'])),
      totalCount: toNumber(firstDeepValue(payload, ['totalCount', 'total', 'count', 'jobCount'])),
      hasMore: toBoolean(firstDeepValue(payload, ['hasMore', 'hasNext', 'more'])),
    };

    if (!Number.isFinite(pageInfo.currentPage)) {
      try {
        pageInfo.currentPage = Number(new URL(url || window.location.href, window.location.origin).searchParams.get('page') || '1');
      } catch (_) {}
    }

    if (typeof pageInfo.hasMore !== 'boolean' && Number.isFinite(pageInfo.currentPage) && Number.isFinite(pageInfo.totalPages)) {
      pageInfo.hasMore = pageInfo.currentPage < pageInfo.totalPages;
    }

    return pageInfo;
  }

  function firstDeepValue(root, keys) {
    const seen = new Set();
    const queue = [root];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      for (const key of keys) {
        if (node[key] !== undefined && node[key] !== null) return node[key];
      }

      Object.values(node).slice(0, 60).forEach((value) => {
        if (value && typeof value === 'object') queue.push(value);
      });
    }

    return undefined;
  }

  function isPageInfoEmpty(pageInfo) {
    return (
      Number.isFinite(pageInfo.totalCount) && pageInfo.totalCount === 0
    ) || (
      Number.isFinite(pageInfo.totalPages) && pageInfo.totalPages === 0
    );
  }

  function isExplicitEmptyPayload(payload) {
    const text = JSON.stringify(payload).slice(0, 5000);
    return ['未找到相关职位', '暂无相关职位', '搜索结果为空', 'jobList":[]', '"totalCount":0'].some((hint) => text.includes(hint));
  }

  function looksLikeJobPath(path) {
    const pathText = path.join('.').toLowerCase();
    return pathText.includes('job') || pathText.includes('position') || pathText.includes('search');
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  function toBoolean(value) {
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  function getRequestUrl(input, fallbackUrl) {
    if (typeof input === 'string') return input;
    if (input?.url) return input.url;
    return fallbackUrl || '';
  }

  function tryParseJson(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }

  function isLikelySearchResponse(url = '') {
    const normalized = url.toLowerCase();
    return SEARCH_PATH_HINTS.some((hint) => normalized.includes(hint)) ||
      (normalized.includes('/search') && JOB_PATH_HINTS.some((hint) => normalized.includes(hint)));
  }

  function compactUrl(url = '') {
    try {
      const parsed = new URL(url, window.location.origin);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return url;
    }
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

  function emit(type, payload) {
    window.postMessage({
      source: BRIDGE_SOURCE,
      type,
      ...payload,
    }, '*');
  }
})();
