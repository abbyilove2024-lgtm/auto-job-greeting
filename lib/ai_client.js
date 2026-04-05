/**
 * ai_client.js
 * AI API 封装，按 provider + protocol 组织请求，而不是写死具体模型分支。
 */

const MAX_RETRIES = 2;
const DEFAULT_PROVIDER_ID = 'openai';
const ALLOWED_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'openrouter',
  'openai_compatible',
]);
export const DEFAULT_GREETING_TEMPLATE = '您好！我对{公司}的{岗位}岗位非常感兴趣。我有{经验}相关工作经验，擅长{技能}，希望有机会进一步了解，期待与您交流！';

// ── Provider 注册表 ──────────────────────────────────────────────────────────
const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    authType: 'bearer',
    defaultModel: 'gpt-4o',
    extraHeaders: {},
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic_messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    chatPath: '/v1/messages',
    authType: 'x-api-key',
    defaultModel: 'claude-3-5-sonnet-20241022',
    extraHeaders: {
      'anthropic-version': '2023-06-01',
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai_compatible',
    defaultBaseUrl: 'https://openrouter.ai/api',
    chatPath: '/v1/chat/completions',
    authType: 'bearer',
    defaultModel: 'openai/gpt-4o',
    extraHeaders: {
      'HTTP-Referer': 'https://www.zhipin.com',
      'X-Title': 'Auto Job Greeting',
    },
  },
  openai_compatible: {
    id: 'openai_compatible',
    label: 'OpenAI Compatible',
    protocol: 'openai_compatible',
    defaultBaseUrl: '',
    chatPath: '/v1/chat/completions',
    authType: 'bearer',
    defaultModel: 'gpt-4o',
    extraHeaders: {},
  },
};

/**
 * 生成个性化打招呼消息
 * @param {object} context
 * @param {object} context.resumeData   - 简历数据 { name, skills, experience, education }
 * @param {object} context.job          - 岗位信息 { jobTitle, company, jobDescription, salary }
 * @param {object} [context.aiConfig]   - AI 配置
 * @param {string} [context.apiKey]     - 兼容旧结构的 API Key
 * @param {string} [context.provider]   - 兼容旧结构的 provider
 * @returns {Promise<string>} 生成的消息文本
 */
export async function generateGreetingMessage(context) {
  const { resumeData, job } = context;
  const aiConfig = normalizeAiConfigInput(context.aiConfig || {
    providerId: context.provider,
    apiKey: context.apiKey,
  });

  if (!aiConfig.enabled || !aiConfig.apiKey) {
    console.warn('[AI] 未配置 API Key，使用默认模板');
    return buildDefaultMessage(resumeData, job, aiConfig.defaultGreetingTemplate);
  }

  const provider = resolveProvider(aiConfig.providerId);
  const prompt = buildPrompt(resumeData, job);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await callProvider(provider, aiConfig, prompt);
      return message.length > 500 ? message.slice(0, 497) + '...' : message;
    } catch (err) {
      if (err.message === 'API_KEY_INVALID' || err.message === 'BASE_URL_REQUIRED') throw err;
      console.warn(`[AI] 第 ${attempt + 1} 次尝试失败：${err.message}`);
      if (attempt === MAX_RETRIES) {
        console.warn('[AI] 达到最大重试次数，使用默认模板');
        return buildDefaultMessage(resumeData, job, aiConfig.defaultGreetingTemplate);
      }
      await sleep(2000 * (attempt + 1));
    }
  }

  return buildDefaultMessage(resumeData, job, aiConfig.defaultGreetingTemplate);
}

// ── Provider 调用 ─────────────────────────────────────────────────────────────

async function callProvider(provider, aiConfig, prompt) {
  if (provider.protocol === 'anthropic_messages') {
    return callAnthropicMessages(provider, aiConfig, prompt);
  }
  return callOpenAICompatible(provider, aiConfig, prompt);
}

async function callOpenAICompatible(provider, aiConfig, prompt) {
  const baseUrl = resolveBaseUrl(provider, aiConfig);
  const res = await fetch(joinUrl(baseUrl, provider.chatPath), {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${aiConfig.apiKey}`,
      'Content-Type':  'application/json',
      ...provider.extraHeaders,
    },
    body: JSON.stringify({
      model:       provider.defaultModel,
      messages: [
        { role: 'system',  content: '你是一个专业的求职助手，帮助求职者生成简洁有吸引力的打招呼消息。' },
        { role: 'user',    content: prompt },
      ],
      max_tokens:  200,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) throw new Error('API_KEY_INVALID');
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '5', 10);
    await sleep(wait * 1000);
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty response');
  return text;
}

async function callAnthropicMessages(provider, aiConfig, prompt) {
  const baseUrl = resolveBaseUrl(provider, aiConfig);
  const res = await fetch(joinUrl(baseUrl, provider.chatPath), {
    method:  'POST',
    headers: {
      'x-api-key':         aiConfig.apiKey,
      'Content-Type':      'application/json',
      ...provider.extraHeaders,
    },
    body: JSON.stringify({
      model:      provider.defaultModel,
      max_tokens: 200,
      system:     '你是一个专业的求职助手，帮助求职者生成简洁有吸引力的打招呼消息。',
      messages: [
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) throw new Error('API_KEY_INVALID');
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('retry-after') || '5', 10);
    await sleep(wait * 1000);
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${errBody?.error?.message || ''}`);
  }

  const data = await res.json();
  // Anthropic 响应：{ content: [{ type: 'text', text: '...' }] }
  const text = data.content?.find((c) => c.type === 'text')?.text?.trim();
  if (!text) throw new Error('Empty response');
  return text;
}

// ── Prompt 构建 ───────────────────────────────────────────────────────────────

function buildPrompt(resumeData, job) {
  const skills     = (resumeData?.skills || []).slice(0, 5).join('、') || '相关技术';
  const experience = resumeData?.experience ? `${resumeData.experience}年` : '若干年';
  const jdSummary  = (job?.jobDescription || '').slice(0, 300);

  return `请根据以下信息，生成一条简洁有吸引力的求职打招呼消息（100字以内），语气专业友好，突出求职者与职位的匹配点，不要过于模板化：

求职者信息：
- 核心技能：${skills}
- 工作年限：${experience}

目标岗位：
- 职位名称：${job?.jobTitle || '未知'}
- 公司名称：${job?.company || '贵公司'}
- 薪资范围：${job?.salary || '面议'}
- 职位描述摘要：${jdSummary || '无'}

只输出消息内容本身，不需要任何额外说明或格式。`;
}

// ── 默认模板 ─────────────────────────────────────────────────────────────────

export function buildDefaultMessage(resumeData, job, customTemplate = '') {
  const template = resolveGreetingTemplate(customTemplate);
  return renderGreetingTemplate(template, resumeData, job);
}

export function renderGreetingTemplate(template, resumeData, job) {
  const skills     = (resumeData?.skills || []).slice(0, 3).join('、') || '相关技术';
  const experience = resumeData?.experience ? `${resumeData.experience}年` : '多年';
  const education  = resumeData?.education || '相关专业';
  const name       = resumeData?.name || '我';
  const jobTitle   = job?.jobTitle || '该';
  const company    = job?.company || '贵公司';
  const salary     = job?.salary || '面议';

  const replacements = {
    姓名: name,
    公司: company,
    岗位: jobTitle,
    技能: skills,
    经验: experience,
    学历: education,
    薪资: salary,
  };

  return Object.entries(replacements).reduce((message, [key, value]) => (
    message.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, 'g'), value)
  ), template);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveProvider(providerId) {
  return PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER_ID];
}

function resolveBaseUrl(provider, aiConfig) {
  const customBaseUrl = sanitizeBaseUrl(aiConfig.baseUrl);
  const baseUrl = customBaseUrl || provider.defaultBaseUrl;
  if (!baseUrl) {
    throw new Error('BASE_URL_REQUIRED');
  }
  return baseUrl;
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function sanitizeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed && !/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

function normalizeAiConfigInput(data) {
  if (!data || typeof data !== 'object') {
    return {
      providerId: DEFAULT_PROVIDER_ID,
      apiKey: '',
      baseUrl: '',
      defaultGreetingTemplate: '',
      enabled: false,
    };
  }

  const legacyApiKey = typeof data.openaiApiKey === 'string' ? data.openaiApiKey.trim() : '';
  const apiKey = legacyApiKey || (typeof data.apiKey === 'string' ? data.apiKey.trim() : '');
  const providerId = normalizeProviderId(data.providerId || data.provider);
  const baseUrl = sanitizeBaseUrl(data.baseUrl);
  const defaultGreetingTemplate = typeof data.defaultGreetingTemplate === 'string'
    ? data.defaultGreetingTemplate.trim()
    : '';
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : Boolean(apiKey);

  return {
    providerId,
    apiKey,
    baseUrl,
    defaultGreetingTemplate,
    enabled,
  };
}

function normalizeProviderId(value) {
  return ALLOWED_PROVIDER_IDS.has(value) ? value : DEFAULT_PROVIDER_ID;
}

function resolveGreetingTemplate(template) {
  if (typeof template === 'string' && template.trim()) return template.trim();
  return DEFAULT_GREETING_TEMPLATE;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
