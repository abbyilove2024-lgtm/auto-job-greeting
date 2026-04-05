/**
 * pending.js
 * 待发队列页面逻辑：逐条确认模式 + 批量确认模式
 */

// ── DOM 引用 ───────────────────────────────────────────────────────────────────
const topbarCount   = document.getElementById('topbarCount');
const loadingState  = document.getElementById('loadingState');
const emptyState    = document.getElementById('emptyState');
const viewOne       = document.getElementById('viewOne');
const viewBatch     = document.getElementById('viewBatch');
const actionBarOne  = document.getElementById('actionBarOne');
const actionBarBatch= document.getElementById('actionBarBatch');
const tabOne        = document.getElementById('tabOne');
const tabBatch      = document.getElementById('tabBatch');

// 逐条模式
const oneProgress  = document.getElementById('oneProgress');
const oneJobTitle  = document.getElementById('oneJobTitle');
const oneCompany   = document.getElementById('oneCompany');
const oneCity      = document.getElementById('oneCity');
const oneSalary    = document.getElementById('oneSalary');
const oneRecruiter = document.getElementById('oneRecruiter');
const oneMessage   = document.getElementById('oneMessage');
const btnSkip      = document.getElementById('btnSkip');
const btnSendOne   = document.getElementById('btnSendOne');

// 批量模式
const batchList    = document.getElementById('batchList');
const checkAll     = document.getElementById('checkAll');
const selectedCount= document.getElementById('selectedCount');
const btnSendBatch = document.getElementById('btnSendBatch');
const btnClearBatch= document.getElementById('btnClearBatch');

const toast = document.getElementById('toast');

// ── 状态 ──────────────────────────────────────────────────────────────────────
let allJobs      = [];
let currentIndex = 0;
let currentMode  = 'one'; // 'one' | 'batch'
let generatedMessages = {}; // jobId → message

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function init() {
  const result = await storageGet(['pendingJobs', 'pendingIndex', 'sendConfig', 'resumeData', 'aiConfig']);
  allJobs      = result.pendingJobs  || [];
  currentIndex = result.pendingIndex || 0;

  const sendConfig = result.sendConfig || {};

  loadingState.style.display = 'none';

  if (allJobs.length === 0) {
    emptyState.style.display = 'block';
    topbarCount.textContent  = '无待发岗位';
    return;
  }

  topbarCount.textContent = `共 ${allJobs.length} 个岗位`;

  // 新模式 manual_review 默认进入批量视图，旧 manual_one 仍兼容逐条视图
  const preferredMode = sendConfig.sendMode === 'manual_one' ? 'one' : 'batch';
  switchMode(preferredMode);

  // 预生成消息
  await preGenerateMessages(allJobs, result.resumeData, result.aiConfig);
}

// ── 模式切换 ──────────────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;

  tabOne.classList.toggle('active', mode === 'one');
  tabBatch.classList.toggle('active', mode === 'batch');

  viewOne.style.display   = mode === 'one'   ? 'block' : 'none';
  viewBatch.style.display = mode === 'batch' ? 'block' : 'none';

  actionBarOne.style.display   = mode === 'one'   ? 'flex' : 'none';
  actionBarBatch.style.display = mode === 'batch' ? 'flex' : 'none';

  if (mode === 'one') {
    renderOneMode();
  } else {
    renderBatchMode();
  }
}

tabOne.addEventListener('click',  () => switchMode('one'));
tabBatch.addEventListener('click', () => switchMode('batch'));

// ── 逐条模式 ──────────────────────────────────────────────────────────────────
function renderOneMode() {
  // 跳过已处理（index 以前的）
  if (currentIndex >= allJobs.length) {
    viewOne.style.display = 'none';
    actionBarOne.style.display = 'none';
    emptyState.style.display = 'block';
    emptyState.querySelector('p').textContent = '所有岗位已处理完毕！';
    return;
  }

  const job = allJobs[currentIndex];
  const remaining = allJobs.length - currentIndex;

  oneProgress.textContent = `第 ${currentIndex + 1} / ${allJobs.length} 条（剩余 ${remaining} 条）`;
  oneJobTitle.textContent  = job.jobTitle  || '—';
  oneCompany.textContent   = job.company   || '—';
  oneCity.textContent      = job.city      || '';
  oneSalary.textContent    = job.salary    || '面议';
  oneRecruiter.textContent = job.recruiterName || '—';

  // 填入预生成的消息
  const msg = generatedMessages[job.jobId] || '';
  oneMessage.value = msg;
  if (!msg) oneMessage.placeholder = '正在生成消息…';
}

// 发送当前条
btnSendOne.addEventListener('click', async () => {
  if (currentIndex >= allJobs.length) return;

  const job     = allJobs[currentIndex];
  const message = oneMessage.value.trim();

  if (!message) {
    showToast('请先填写打招呼消息', 'error');
    return;
  }

  btnSendOne.disabled = true;
  btnSendOne.textContent = '发送中…';

  try {
    await chrome.runtime.sendMessage({ type: 'USER_SEND', jobId: job.jobId, message });
    showToast('已发送 ✓', 'success');
    await advanceIndex();
    renderOneMode();
  } catch (err) {
    showToast('发送失败，请重试', 'error');
  } finally {
    btnSendOne.disabled = false;
    btnSendOne.textContent = '发送此条';
  }
});

// 跳过当前条
btnSkip.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'USER_SKIP', jobId: allJobs[currentIndex]?.jobId });
  await advanceIndex();
  renderOneMode();
});

async function advanceIndex() {
  currentIndex++;
  await storageSet({ pendingIndex: currentIndex });
}

// ── 批量模式 ──────────────────────────────────────────────────────────────────
function renderBatchMode() {
  batchList.innerHTML = '';

  allJobs.forEach((job, idx) => {
    const item = document.createElement('div');
    item.className = 'job-list-item';
    item.dataset.idx = idx;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.jobid = job.jobId;
    checkbox.addEventListener('change', updateSelectedCount);

    const info = document.createElement('div');
    info.className = 'job-list-info';
    info.innerHTML = `
      <div class="job-list-title">${escHtml(job.jobTitle || '—')} · ${escHtml(job.salary || '面议')}</div>
      <div class="job-list-meta">${escHtml(job.company || '—')} &nbsp;|&nbsp; 招聘者：${escHtml(job.recruiterName || '—')}</div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
      item.classList.toggle('checked', checkbox.checked);
      updateSelectedCount();
    });

    item.appendChild(checkbox);
    item.appendChild(info);
    batchList.appendChild(item);
  });

  updateSelectedCount();
}

checkAll.addEventListener('change', () => {
  const checked = checkAll.checked;
  document.querySelectorAll('#batchList input[type="checkbox"]').forEach((cb) => {
    cb.checked = checked;
    cb.closest('.job-list-item').classList.toggle('checked', checked);
  });
  updateSelectedCount();
});

function updateSelectedCount() {
  const total    = document.querySelectorAll('#batchList input[type="checkbox"]').length;
  const checked  = document.querySelectorAll('#batchList input[type="checkbox"]:checked').length;
  selectedCount.textContent = `已选 ${checked} / ${total} 条`;
  btnSendBatch.textContent  = `批量发送选中（${checked} 条）`;
  btnSendBatch.disabled     = checked === 0;
  checkAll.indeterminate    = checked > 0 && checked < total;
  checkAll.checked          = checked === total && total > 0;
}

btnSendBatch.addEventListener('click', async () => {
  const checkedBoxes = document.querySelectorAll('#batchList input[type="checkbox"]:checked');
  const selectedJobIds = [...checkedBoxes].map((cb) => cb.dataset.jobid);
  const selectedJobs   = allJobs.filter((j) => selectedJobIds.includes(j.jobId));

  if (selectedJobs.length === 0) return;

  btnSendBatch.disabled = true;
  btnSendBatch.textContent = '发送中…';

  try {
    await chrome.runtime.sendMessage({ type: 'USER_BATCH_SEND', jobs: selectedJobs });
    showToast(`已提交 ${selectedJobs.length} 条发送任务`, 'success');

    // 从列表移除已发送的
    allJobs = allJobs.filter((j) => !selectedJobIds.includes(j.jobId));
    await storageSet({ pendingJobs: allJobs });
    topbarCount.textContent = `共 ${allJobs.length} 个岗位`;

    if (allJobs.length === 0) {
      renderBatchMode();
      viewBatch.style.display = 'none';
      actionBarBatch.style.display = 'none';
      emptyState.style.display = 'block';
    } else {
      renderBatchMode();
    }
  } catch (err) {
    showToast('提交失败，请重试', 'error');
  } finally {
    btnSendBatch.disabled = false;
    updateSelectedCount();
  }
});

btnClearBatch.addEventListener('click', async () => {
  if (!confirm('确定清空全部待发队列？')) return;
  await storageSet({ pendingJobs: [], pendingIndex: 0 });
  allJobs = [];
  viewBatch.style.display = 'none';
  actionBarBatch.style.display = 'none';
  emptyState.style.display = 'block';
  topbarCount.textContent = '无待发岗位';
});

// ── 预生成消息 ─────────────────────────────────────────────────────────────────
async function preGenerateMessages(jobs, resumeData, aiConfig) {
  // 只预生成前 5 条，减少 API 消耗
  const preloadCount = Math.min(jobs.length, 5);

  for (let i = 0; i < preloadCount; i++) {
    const job = jobs[i];
    if (generatedMessages[job.jobId]) continue;

    try {
      const msg = await generateMessage(job, resumeData, aiConfig);
      generatedMessages[job.jobId] = msg;

      // 如果是当前显示的逐条，实时更新
      if (currentMode === 'one' && i === currentIndex) {
        oneMessage.value = msg;
        oneMessage.placeholder = 'AI 生成中…';
      }
    } catch (e) {
      // 生成失败不影响流程
    }
  }
}

async function generateMessage(job, resumeData, aiConfig) {
  // 从 background 请求生成（避免 API Key 暴露在 page 中）
  // 这里使用简化的默认模板逻辑
  const skills  = (resumeData?.skills || []).slice(0, 3).join('、') || '相关技术';
  const exp     = resumeData?.experience ? `${resumeData.experience}年` : '多年';
  return `您好！我对${job.company || '贵公司'}的${job.jobTitle || '该岗位'}很感兴趣。我有${exp}相关经验，擅长${skills}，期待进一步了解！`;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className   = `toast ${type}`;
  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
init();
