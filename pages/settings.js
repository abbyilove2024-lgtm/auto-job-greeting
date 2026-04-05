/**
 * settings.js
 * 设置页面逻辑：简历上传解析、表单回显、保存
 */

import { parseResume } from '../lib/resume_parser.js';
import { normalizeAiConfig } from '../lib/storage.js';
import { DEFAULT_GREETING_TEMPLATE } from '../lib/ai_client.js';

// ── DOM 引用 ───────────────────────────────────────────────────────────────────
const resumeUpload  = document.getElementById('resumeUpload');
const loadedFileNameBtn = document.getElementById('loadedFileNameBtn');
const replaceResumeBtn  = document.getElementById('replaceResumeBtn');
const resumeFileEl  = document.getElementById('resumeFile');
const parseProgress = document.getElementById('parseProgress');

const resumeName   = document.getElementById('resumeName');
const resumeExp    = document.getElementById('resumeExp');
const resumeSkills = document.getElementById('resumeSkills');
const resumeEdu    = document.getElementById('resumeEdu');

const intentKeyword = document.getElementById('intentKeyword');
const intentCity    = document.getElementById('intentCity');
const salaryMin     = document.getElementById('salaryMin');
const salaryMax     = document.getElementById('salaryMax');
const keywordError  = document.getElementById('keywordError');
const salaryError   = document.getElementById('salaryError');

const maxPagesEl   = document.getElementById('maxPages');
const intervalMin  = document.getElementById('intervalMin');
const intervalMax  = document.getElementById('intervalMax');
const maxPerMin    = document.getElementById('maxPerMin');
const aiProviderEl = document.getElementById('aiProvider');
const apiBaseUrlRow = document.getElementById('apiBaseUrlRow');
const apiBaseUrlEl  = document.getElementById('apiBaseUrl');
const apiKeyEl     = document.getElementById('apiKey');
const apiKeyHint   = document.getElementById('apiKeyHint');
const defaultGreetingTemplateEl = document.getElementById('defaultGreetingTemplate');

const modeCards    = document.querySelectorAll('.mode-card');
const modeRadios   = document.querySelectorAll('input[name="sendMode"]');

const btnSave  = document.getElementById('btnSave');
const btnReset = document.getElementById('btnReset');
const toast    = document.getElementById('toast');
const dragState = { depth: 0 };
let currentResumeFileMeta = null;

// ── 城市代码映射 ───────────────────────────────────────────────────────────────
const CITY_MAP = {
  '北京': '101010100', '上海': '101020100', '广州': '101280100',
  '深圳': '101280600', '杭州': '101210100', '成都': '101270100',
  '武汉': '101200100', '西安': '101110100', '南京': '101190100',
  '苏州': '101190400', '天津': '101030100', '重庆': '101040100',
  '长沙': '101250100', '郑州': '101180100', '合肥': '101220100',
  '厦门': '101230200', '青岛': '101120200', '大连': '101070200',
};

// ── 初始化：加载已有配置 ───────────────────────────────────────────────────────
async function init() {
  chrome.storage.local.get(
    ['resumeData', 'resumeFileMeta', 'jobIntention', 'searchConfig', 'sendConfig', 'aiConfig'],
    (result) => {
      fillResumeForm(result.resumeData || {});
      fillResumeFileMeta(result.resumeFileMeta || null);
      fillIntentionForm(result.jobIntention || {});
      fillSearchConfig(result.searchConfig || {});
      fillSendConfig(result.sendConfig || {});
      fillAiConfig(result.aiConfig || {});
    }
  );
}

function fillResumeForm(data) {
  if (data.name)       resumeName.value   = data.name;
  if (data.experience) resumeExp.value    = data.experience;
  if (data.skills)     resumeSkills.value = Array.isArray(data.skills) ? data.skills.join(', ') : String(data.skills);
  if (data.education)  resumeEdu.value    = data.education;
}

function fillIntentionForm(data) {
  if (data.keyword)    intentKeyword.value = data.keyword;
  if (data.cityName)   intentCity.value    = data.cityName;
  if (data.salaryMin)  salaryMin.value     = data.salaryMin;
  if (data.salaryMax)  salaryMax.value     = data.salaryMax;
}

function fillSearchConfig(data) {
  if (data.maxPages) maxPagesEl.value = data.maxPages;
}

function fillSendConfig(data) {
  const normalizedSendMode = normalizeSendMode(data.sendMode);
  if (normalizedSendMode) {
    modeRadios.forEach((r) => { if (r.value === normalizedSendMode) r.checked = true; });
    updateModeCardSelection(normalizedSendMode);
  }
  if (data.sendIntervalMin) intervalMin.value = data.sendIntervalMin;
  if (data.sendIntervalMax) intervalMax.value = data.sendIntervalMax;
  if (data.maxPerMinute)    maxPerMin.value   = data.maxPerMinute;
}

function fillAiConfig(data) {
  const aiConfig = normalizeAiConfig(data);
  aiProviderEl.value = aiConfig.providerId;
  apiKeyEl.value = aiConfig.apiKey || '';
  apiBaseUrlEl.value = aiConfig.baseUrl || '';
  defaultGreetingTemplateEl.value = aiConfig.defaultGreetingTemplate || DEFAULT_GREETING_TEMPLATE;
  updateAiProviderFields(aiConfig.providerId);
}

function fillResumeFileMeta(meta) {
  if (meta && typeof meta.fileName === 'string' && meta.fileName.trim()) {
    currentResumeFileMeta = {
      fileName: meta.fileName.trim(),
      updatedAt: Number(meta.updatedAt) || Date.now(),
    };
    setResumeUploadState('loaded');
    return;
  }

  currentResumeFileMeta = null;
  setResumeUploadState('idle');
}

function updateAiProviderFields(providerId = aiProviderEl.value) {
  const isCompatible = providerId === 'openai_compatible';
  apiBaseUrlRow.style.display = isCompatible ? '' : 'none';
  apiBaseUrlEl.disabled = !isCompatible;

  if (isCompatible) {
    apiKeyHint.textContent = '支持 OpenAI 兼容接口。Base URL 仅保存在本地；当前扩展仍受 manifest host 权限限制。';
    apiKeyEl.placeholder = '输入兼容提供商的 API Key';
  } else {
    apiKeyHint.textContent = '仅存储在本地，不上传服务器。不填则使用默认消息模板。';
    apiKeyEl.placeholder = '输入所选提供商的 API Key';
    apiBaseUrlEl.value = '';
  }
}

// ── 简历上传与解析 ─────────────────────────────────────────────────────────────
// 注：上传区域由 <label for="resumeFile"> 驱动，原生点击即可触发文件选择

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  if (!resumeUpload.contains(e.target)) e.preventDefault();
});

resumeUpload.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragState.depth += 1;
  resumeUpload.classList.add('drag-over');
});

resumeUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  resumeUpload.classList.add('drag-over');
});

resumeUpload.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragState.depth = Math.max(0, dragState.depth - 1);
  if (dragState.depth === 0) resumeUpload.classList.remove('drag-over');
});

resumeUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  dragState.depth = 0;
  resumeUpload.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleResumeFile(file);
});

loadedFileNameBtn.addEventListener('click', () => {
  resumeFileEl.click();
});

replaceResumeBtn.addEventListener('click', () => {
  resumeFileEl.click();
});

resumeFileEl.addEventListener('click', () => {
  resumeFileEl.value = '';
});

resumeFileEl.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleResumeFile(file);
});

async function handleResumeFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'doc', 'docx'].includes(ext)) {
    showToast('仅支持 PDF 和 Word 格式', 'error');
    return;
  }

  setResumeUploadState('parsing', file.name);

  try {
    const data = await parseResume(file);
    applyParsedResumeData(data);
    currentResumeFileMeta = {
      fileName: file.name,
      updatedAt: Date.now(),
    };
    await saveResumeFileMeta(currentResumeFileMeta);
    setResumeUploadState('loaded');
    showToast(`简历加载成功：${file.name}`, 'success');
  } catch (err) {
    showToast(mapParseError(err), 'error');
    setResumeUploadState(currentResumeFileMeta ? 'loaded' : 'idle');
  } finally {
    resumeFileEl.value = '';
  }
}

function applyParsedResumeData(data) {
  const confidence = data.confidence || {};

  applyIfConfident(resumeName, data.name, confidence.name);
  applyIfConfident(resumeExp, data.experience, confidence.experience);
  applyIfConfident(resumeSkills, Array.isArray(data.skills) ? data.skills.join(', ') : '', confidence.skills);
  applyIfConfident(resumeEdu, data.education, confidence.education);
}

function applyIfConfident(input, value, confidence) {
  if (value === null || value === undefined || value === '') return;
  if ((confidence || 'high') === 'low') return;
  input.value = String(value);
}

function mapParseError(err) {
  const message = err?.message || '';
  if (message === 'UNSUPPORTED_FORMAT') return '仅支持 PDF 和 Word 格式';
  if (message === 'PARSE_FAILED') return '简历内容过少或无法识别，请检查文件内容';
  if (message === 'PDF_LIB_NOT_READY' || message === 'WORD_LIB_NOT_READY') return '解析组件未就绪，请刷新设置页重试';
  return '简历解析失败，请手动填写信息';
}

function setResumeUploadState(state, fileName = '') {
  const normalized = ['idle', 'parsing', 'loaded'].includes(state) ? state : 'idle';
  resumeUpload.dataset.state = normalized;
  parseProgress.classList.toggle('show', normalized === 'parsing');
  if (normalized === 'parsing') {
    parseProgress.textContent = `⏳ 正在解析：${fileName || '简历文件'}`;
    return;
  }
  parseProgress.classList.remove('show');

  if (normalized === 'loaded' && currentResumeFileMeta?.fileName) {
    loadedFileNameBtn.textContent = currentResumeFileMeta.fileName;
  }
}

async function saveResumeFileMeta(meta) {
  await new Promise((resolve, reject) => {
    chrome.storage.local.set({ resumeFileMeta: meta }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ── 发送模式切换 ───────────────────────────────────────────────────────────────

modeCards.forEach((card) => {
  card.addEventListener('click', () => {
    const radio = card.querySelector('input[type="radio"]');
    radio.checked = true;
    updateModeCardSelection(radio.value);
  });
});

aiProviderEl.addEventListener('change', () => {
  updateAiProviderFields(aiProviderEl.value);
});

function updateModeCardSelection(selectedValue) {
  modeCards.forEach((card) => {
    const radio = card.querySelector('input[type="radio"]');
    card.classList.toggle('selected', radio.value === selectedValue);
  });
}

// ── 校验 ──────────────────────────────────────────────────────────────────────

function validate() {
  let valid = true;

  // 职位关键词必填
  if (!intentKeyword.value.trim()) {
    keywordError.classList.add('show');
    intentKeyword.classList.add('error');
    valid = false;
  } else {
    keywordError.classList.remove('show');
    intentKeyword.classList.remove('error');
  }

  // 薪资：最高 > 最低
  const min = parseFloat(salaryMin.value);
  const max = parseFloat(salaryMax.value);
  if (salaryMin.value && salaryMax.value && min >= max) {
    salaryError.classList.add('show');
    salaryMax.classList.add('error');
    valid = false;
  } else {
    salaryError.classList.remove('show');
    salaryMax.classList.remove('error');
  }

  return valid;
}

// ── 保存 ──────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  if (!validate()) return;

  btnSave.disabled = true;

  const cityName = intentCity.value.trim();
  const cityCode  = CITY_MAP[cityName] || cityName || '101010100';

  const resumeData = {
    name:       resumeName.value.trim(),
    experience: parseFloat(resumeExp.value) || null,
    skills:     resumeSkills.value.split(',').map((s) => s.trim()).filter(Boolean),
    education:  resumeEdu.value.trim(),
  };

  const jobIntention = {
    keyword:    intentKeyword.value.trim(),
    cityName,
    city:       cityCode,
    salaryMin:  parseFloat(salaryMin.value) || 0,
    salaryMax:  parseFloat(salaryMax.value) || 0,
  };

  const searchConfig = {
    maxPages: parseInt(maxPagesEl.value, 10) || 10,
  };

  const selectedMode = document.querySelector('input[name="sendMode"]:checked')?.value || 'auto';
  const sendConfig = {
    sendMode:       normalizeSendMode(selectedMode),
    sendIntervalMin: parseFloat(intervalMin.value) || 1,
    sendIntervalMax: parseFloat(intervalMax.value) || 5,
    maxPerMinute:   parseInt(maxPerMin.value, 10) || 5,
  };

  const aiConfig = {
    providerId: aiProviderEl.value || 'openai',
    apiKey:     apiKeyEl.value.trim(),
    baseUrl:    apiBaseUrlEl.value.trim(),
    defaultGreetingTemplate: defaultGreetingTemplateEl.value.trim(),
    enabled:    Boolean(apiKeyEl.value.trim()),
  };

  if (aiConfig.providerId === 'openai_compatible' && aiConfig.apiKey && !aiConfig.baseUrl) {
    showToast('OpenAI 兼容提供商需填写 Base URL', 'error');
    btnSave.disabled = false;
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.storage.local.set(
        { resumeData, resumeFileMeta: currentResumeFileMeta, jobIntention, searchConfig, sendConfig, aiConfig },
        () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        }
      );
    });
    showToast('设置已保存 ✓', 'success');
  } catch (err) {
    showToast('保存失败，请重试', 'error');
  } finally {
    btnSave.disabled = false;
  }
});

// ── 重置 ──────────────────────────────────────────────────────────────────────

btnReset.addEventListener('click', () => {
  if (!confirm('确定要重置所有设置吗？')) return;
  chrome.storage.local.clear(() => {
    location.reload();
  });
});

function normalizeSendMode(sendMode) {
  if (sendMode === 'auto') return 'auto';
  if (['manual_review', 'manual_batch', 'manual_one'].includes(sendMode)) {
    return 'manual_review';
  }
  return 'auto';
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
updateAiProviderFields(aiProviderEl.value);
init();
