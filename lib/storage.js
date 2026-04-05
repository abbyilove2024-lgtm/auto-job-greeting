/**
 * storage.js
 * chrome.storage.local 统一封装层
 */

const KEYS = {
  RESUME_DATA:   'resumeData',
  RESUME_FILE_META: 'resumeFileMeta',
  JOB_INTENTION: 'jobIntention',
  SEARCH_CONFIG: 'searchConfig',
  SEND_CONFIG:   'sendConfig',
  AI_CONFIG:     'aiConfig',
  SEND_HISTORY:  'sendHistory',
  PENDING_JOBS:  'pendingJobs',
  PENDING_INDEX: 'pendingIndex',
  PLUGIN_STATE:  'pluginState',
};

const DEFAULT_SEND_CONFIG = {
  sendMode: 'auto', // 'auto' | 'manual_review'
  sendIntervalMin: 1,
  sendIntervalMax: 5,
  maxPerMinute: 5,
};

const AI_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'openrouter',
  'openai_compatible',
]);

const DEFAULT_AI_CONFIG = {
  providerId: 'openai',
  apiKey: '',
  baseUrl: '',
  defaultGreetingTemplate: '',
  enabled: false,
};

/** 通用 get，支持单 key 或 key 数组 */
async function get(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });
}

/** 通用 set */
async function set(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

/** 删除 key */
async function remove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ── 简历数据 ──────────────────────────────────────────────────────────────────

export async function getResumeData() {
  const r = await get(KEYS.RESUME_DATA);
  return r[KEYS.RESUME_DATA] || null;
}

export async function setResumeData(data) {
  await set({ [KEYS.RESUME_DATA]: data });
}

export async function getResumeFileMeta() {
  const r = await get(KEYS.RESUME_FILE_META);
  return r[KEYS.RESUME_FILE_META] || null;
}

export async function setResumeFileMeta(data) {
  await set({ [KEYS.RESUME_FILE_META]: data });
}

// ── 求职意向 ──────────────────────────────────────────────────────────────────

export async function getJobIntention() {
  const r = await get(KEYS.JOB_INTENTION);
  return r[KEYS.JOB_INTENTION] || {
    keyword: '',
    city: '101010100', // 默认北京
    salaryMin: 0,
    salaryMax: 0,
  };
}

export async function setJobIntention(data) {
  await set({ [KEYS.JOB_INTENTION]: data });
}

// ── 检索配置 ──────────────────────────────────────────────────────────────────

export async function getSearchConfig() {
  const r = await get(KEYS.SEARCH_CONFIG);
  return r[KEYS.SEARCH_CONFIG] || { maxPages: 10 };
}

export async function setSearchConfig(data) {
  await set({ [KEYS.SEARCH_CONFIG]: data });
}

// ── 发送配置 ──────────────────────────────────────────────────────────────────

export async function getSendConfig() {
  const r = await get(KEYS.SEND_CONFIG);
  return normalizeSendConfig(r[KEYS.SEND_CONFIG]);
}

export async function setSendConfig(data) {
  await set({ [KEYS.SEND_CONFIG]: normalizeSendConfig(data) });
}

export function normalizeSendConfig(data) {
  if (!data || typeof data !== 'object') {
    return { ...DEFAULT_SEND_CONFIG };
  }

  return {
    sendMode: normalizeSendMode(data.sendMode),
    sendIntervalMin: Number.isFinite(Number(data.sendIntervalMin))
      ? Math.max(1, Number(data.sendIntervalMin))
      : DEFAULT_SEND_CONFIG.sendIntervalMin,
    sendIntervalMax: Number.isFinite(Number(data.sendIntervalMax))
      ? Math.max(1, Number(data.sendIntervalMax))
      : DEFAULT_SEND_CONFIG.sendIntervalMax,
    maxPerMinute: Number.isFinite(Number(data.maxPerMinute))
      ? Math.max(1, Number(data.maxPerMinute))
      : DEFAULT_SEND_CONFIG.maxPerMinute,
  };
}

function normalizeSendMode(sendMode) {
  if (sendMode === 'auto') return 'auto';
  if (['manual_review', 'manual_batch', 'manual_one'].includes(sendMode)) {
    return 'manual_review';
  }
  return DEFAULT_SEND_CONFIG.sendMode;
}

// ── AI 配置 ───────────────────────────────────────────────────────────────────

export async function getAiConfig() {
  const r = await get(KEYS.AI_CONFIG);
  return normalizeAiConfig(r[KEYS.AI_CONFIG]);
}

export async function setAiConfig(data) {
  await set({ [KEYS.AI_CONFIG]: normalizeAiConfig(data) });
}

export function normalizeAiConfig(data) {
  if (!data || typeof data !== 'object') {
    return { ...DEFAULT_AI_CONFIG };
  }

  if (typeof data.openaiApiKey === 'string') {
    const legacyApiKey = data.openaiApiKey.trim();
    return {
      ...DEFAULT_AI_CONFIG,
      providerId: 'openai',
      apiKey: legacyApiKey,
      defaultGreetingTemplate: sanitizeTemplate(data.defaultGreetingTemplate),
      enabled: Boolean(legacyApiKey),
    };
  }

  const providerId = normalizeProviderId(data.providerId || data.provider);
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
  const baseUrl = sanitizeBaseUrl(data.baseUrl);
  const defaultGreetingTemplate = sanitizeTemplate(data.defaultGreetingTemplate);
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : Boolean(apiKey);

  return {
    ...DEFAULT_AI_CONFIG,
    providerId,
    apiKey,
    baseUrl,
    defaultGreetingTemplate,
    enabled,
  };
}

function normalizeProviderId(value) {
  return AI_PROVIDER_IDS.has(value) ? value : DEFAULT_AI_CONFIG.providerId;
}

function sanitizeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed && !/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

function sanitizeTemplate(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// ── 发送历史 ──────────────────────────────────────────────────────────────────

export async function getSendHistory() {
  const r = await get(KEYS.SEND_HISTORY);
  return r[KEYS.SEND_HISTORY] || [];
}

export async function addSendRecord(record) {
  const history = await getSendHistory();
  history.unshift(record); // 最新记录在前
  // 保留最近 500 条，防止 storage 溢出
  const trimmed = history.slice(0, 500);
  await set({ [KEYS.SEND_HISTORY]: trimmed });
}

export async function updateSendRecord(id, updates) {
  const history = await getSendHistory();
  const idx = history.findIndex((r) => r.id === id);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    await set({ [KEYS.SEND_HISTORY]: history });
  }
}

export async function getSentJobIds() {
  const history = await getSendHistory();
  return new Set(history.map((r) => r.jobId));
}

/** 清理 N 天前的历史记录（用于 storage 不足时） */
export async function cleanOldHistory(daysToKeep = 30) {
  const history = await getSendHistory();
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const cleaned = history.filter((r) => r.sentAt > cutoff);
  await set({ [KEYS.SEND_HISTORY]: cleaned });
  return history.length - cleaned.length;
}

// ── 待发队列 ──────────────────────────────────────────────────────────────────

export async function getPendingJobs() {
  const r = await get([KEYS.PENDING_JOBS, KEYS.PENDING_INDEX]);
  return {
    jobs: r[KEYS.PENDING_JOBS] || [],
    index: r[KEYS.PENDING_INDEX] || 0,
  };
}

export async function setPendingJobs(jobs) {
  await set({ [KEYS.PENDING_JOBS]: jobs, [KEYS.PENDING_INDEX]: 0 });
}

export async function advancePendingIndex() {
  const r = await get(KEYS.PENDING_INDEX);
  const newIndex = (r[KEYS.PENDING_INDEX] || 0) + 1;
  await set({ [KEYS.PENDING_INDEX]: newIndex });
  return newIndex;
}

export async function clearPendingJobs() {
  await remove([KEYS.PENDING_JOBS, KEYS.PENDING_INDEX]);
}

// ── 插件状态 ──────────────────────────────────────────────────────────────────

export async function getPluginState() {
  const r = await get(KEYS.PLUGIN_STATE);
  return r[KEYS.PLUGIN_STATE] || 'idle';
}

export async function setPluginState(state) {
  await set({ [KEYS.PLUGIN_STATE]: state });
}
