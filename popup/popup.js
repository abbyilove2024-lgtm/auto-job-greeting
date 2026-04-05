/**
 * popup.js
 * Popup 主面板逻辑：状态展示、按钮控制、实时消息监听
 */

// ── DOM 元素引用 ───────────────────────────────────────────────────────────────
const statusBadge  = document.getElementById('statusBadge');
const statusText   = document.getElementById('statusText');
const progressText = document.getElementById('progressText');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const errorMsg     = document.getElementById('errorMsg');
const pendingBar   = document.getElementById('pendingBar');
const pendingText  = document.getElementById('pendingText');
const pendingLink  = document.getElementById('pendingLink');

const btnSearch = document.getElementById('btnSearch');
const btnPause  = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnStop   = document.getElementById('btnStop');

const navSettings = document.getElementById('navSettings');
const navHistory  = document.getElementById('navHistory');

// ── 状态配置 ──────────────────────────────────────────────────────────────────
const STATE_CONFIG = {
  idle:      { label: '待机中',   cls: 'state-idle',      btns: ['search'] },
  searching: { label: '检索中…', cls: 'state-searching', btns: ['stop'], progress: true },
  pending:   { label: '待确认',   cls: 'state-pending',   btns: ['stop'] },
  sending:   { label: '发送中',   cls: 'state-sending',   btns: ['pause', 'stop'], progress: true },
  paused:    { label: '已暂停',   cls: 'state-paused',    btns: ['resume', 'stop'] },
  done:      { label: '完成',     cls: 'state-done',      btns: ['search'] },
  error:     { label: '错误',     cls: 'state-error',     btns: ['search'] },
};

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function init() {
  // 从 background 查询当前状态
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (resp?.state) applyState(resp.state);
  } catch (e) {
    applyState('idle');
  }

  // 查询待发队列数量
  chrome.storage.local.get(['pendingJobs', 'pluginState'], (result) => {
    const jobs  = result.pendingJobs || [];
    const state = result.pluginState || 'idle';
    if (state === 'pending' && jobs.length > 0) {
      showPendingBar(jobs.length);
    }
  });
}

// ── 状态渲染 ──────────────────────────────────────────────────────────────────
function applyState(state, extra = {}) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.idle;

  // 更新 Badge
  statusBadge.className = `status-badge ${cfg.cls}`;
  statusText.textContent = cfg.label;

  // 进度区域
  const showProgress = cfg.progress && (extra.total > 0);
  progressText.style.display = showProgress ? 'block' : 'none';
  progressWrap.style.display = showProgress ? 'block' : 'none';

  if (showProgress) {
    const pct = extra.total > 0 ? Math.round((extra.current / extra.total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressText.textContent = extra.progressLabel || `${extra.current || 0} / ${extra.total}`;
  }

  // 按钮显示逻辑
  btnSearch.style.display = cfg.btns.includes('search') ? '' : 'none';
  btnPause.style.display  = cfg.btns.includes('pause')  ? '' : 'none';
  btnResume.style.display = cfg.btns.includes('resume') ? '' : 'none';
  btnStop.style.display   = cfg.btns.includes('stop')   ? '' : 'none';

  // 错误信息
  if (state === 'error' && extra.message) {
    errorMsg.textContent = extra.message;
    errorMsg.classList.remove('hidden');
  } else {
    errorMsg.classList.add('hidden');
  }

  // 挂载状态到 actions flex 布局（只有一个按钮时撑满宽度）
  const visibleBtns = [btnSearch, btnPause, btnResume, btnStop].filter(
    (b) => b.style.display !== 'none'
  );
  visibleBtns.forEach((b) => (b.style.flex = visibleBtns.length === 1 ? '1' : ''));
}

// ── 待发提示栏 ─────────────────────────────────────────────────────────────────
function showPendingBar(count) {
  pendingText.textContent = `${count} 个岗位待发送`;
  pendingBar.classList.remove('hidden');
}

function hidePendingBar() {
  pendingBar.classList.add('hidden');
}

// ── 按钮事件 ──────────────────────────────────────────────────────────────────
btnSearch.addEventListener('click', async () => {
  btnSearch.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'START_SEARCH' });
    applyState('searching');
  } catch (e) {
    applyState('error', { message: '启动检索失败，请重试' });
  } finally {
    btnSearch.disabled = false;
  }
});

btnPause.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE' });
  applyState('paused');
});

btnResume.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE' });
  applyState('sending');
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP' });
  applyState('idle');
  hidePendingBar();
});

// ── 待发列表入口 ───────────────────────────────────────────────────────────────
pendingLink.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/pending.html') });
});

// ── 导航按钮 ──────────────────────────────────────────────────────────────────
navSettings.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') });
});

navHistory.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/history.html') });
});

// ── 监听来自 service_worker 的实时消息 ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'STATUS_UPDATE':
      handleStatusUpdate(msg);
      break;

    case 'SEND_COMPLETE':
      // 单条发完，更新进度
      if (msg.current !== undefined) {
        applyState('sending', {
          current: msg.current,
          total:   msg.total,
          progressLabel: `发送中 ${msg.current} / ${msg.total}`,
        });
      }
      break;

    case 'ERROR':
      applyState('error', { message: msg.message });
      break;
  }
});

function handleStatusUpdate(msg) {
  switch (msg.state) {
    case 'idle':
      applyState('idle');
      hidePendingBar();
      break;

    case 'searching':
      if (msg.progress) {
        const { current, total, found } = msg.progress;
        applyState('searching', {
          current,
          total,
          progressLabel: `已扫描 ${current}/${total} 页，找到 ${found} 个岗位`,
        });
      } else {
        applyState('searching');
      }
      break;

    case 'pending':
      applyState('pending');
      showPendingBar(msg.pendingCount || 0);
      break;

    case 'sending':
      applyState('sending', {
        current: msg.current || 0,
        total:   msg.total || 0,
        progressLabel: `发送中 ${msg.current || 0} / ${msg.total || 0}`,
      });
      break;

    case 'paused':
      applyState('paused');
      break;

    case 'done':
      applyState('done');
      hidePendingBar();
      if (msg.message) {
        statusText.textContent = msg.message;
      }
      break;

    case 'error':
      applyState('error', { message: msg.message });
      break;
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
init();
