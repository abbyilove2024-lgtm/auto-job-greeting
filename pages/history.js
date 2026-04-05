/**
 * history.js
 * 历史记录页逻辑：展示发送历史、筛选、统计、标记回复、导出 CSV
 */

// ── DOM 引用 ───────────────────────────────────────────────────────────────────
const statTotal      = document.getElementById('statTotal');
const statSuccess    = document.getElementById('statSuccess');
const statReply      = document.getElementById('statReply');
const statToday      = document.getElementById('statToday');

const filterStatus   = document.getElementById('filterStatus');
const filterReply    = document.getElementById('filterReply');
const filterDateFrom = document.getElementById('filterDateFrom');
const filterDateTo   = document.getElementById('filterDateTo');

const listContainer  = document.getElementById('listContainer');
const emptyState     = document.getElementById('emptyState');
const loadMore       = document.getElementById('loadMore');
const btnLoadMore    = document.getElementById('btnLoadMore');
const btnExport      = document.getElementById('btnExport');
const btnClearHistory= document.getElementById('btnClearHistory');

// ── 状态 ──────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;
let allHistory   = [];   // 全量数据
let filtered     = [];   // 筛选后的数据
let displayCount = PAGE_SIZE;

// ── 初始化 ────────────────────────────────────────────────────────────────────
async function init() {
  await loadHistory();
  renderStats(allHistory);
  applyFilters();
}

async function loadHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get('sendHistory', (result) => {
      allHistory = result.sendHistory || [];
      resolve();
    });
  });
}

// ── 统计数据 ──────────────────────────────────────────────────────────────────
function renderStats(records) {
  const total        = records.length;
  const successCount = records.filter((r) => r.status === 'success').length;
  const repliedCount = records.filter((r) => r.replyStatus === 'replied').length;
  const successBase  = total > 0 ? successCount : 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = records.filter((r) => r.sentAt >= todayStart.getTime()).length;

  statTotal.textContent   = total;
  statSuccess.textContent = total > 0 ? `${Math.round((successCount / total) * 100)}%` : '0%';
  statReply.textContent   = successBase > 0 ? `${Math.round((repliedCount / successBase) * 100)}%` : '0%';
  statToday.textContent   = todayCount;
}

// ── 筛选 ──────────────────────────────────────────────────────────────────────
function applyFilters() {
  const status    = filterStatus.value;
  const reply     = filterReply.value;
  const dateFrom  = filterDateFrom.value ? new Date(filterDateFrom.value).getTime() : 0;
  const dateTo    = filterDateTo.value   ? new Date(filterDateTo.value + 'T23:59:59').getTime() : Infinity;

  filtered = allHistory.filter((r) => {
    if (status !== 'all' && r.status !== status) return false;
    if (reply  !== 'all' && r.replyStatus !== reply) return false;
    if (r.sentAt < dateFrom || r.sentAt > dateTo) return false;
    return true;
  });

  displayCount = PAGE_SIZE;
  renderList();
}

[filterStatus, filterReply, filterDateFrom, filterDateTo].forEach((el) => {
  el.addEventListener('change', applyFilters);
});

// ── 渲染列表 ──────────────────────────────────────────────────────────────────
function renderList() {
  // 清除旧列表（保留 emptyState）
  [...listContainer.children].forEach((el) => {
    if (el.id !== 'emptyState') el.remove();
  });

  if (filtered.length === 0) {
    emptyState.style.display = 'block';
    loadMore.style.display   = 'none';
    return;
  }

  emptyState.style.display = 'none';
  const toShow = filtered.slice(0, displayCount);

  toShow.forEach((record) => {
    listContainer.appendChild(createRecordItem(record));
  });

  loadMore.style.display = filtered.length > displayCount ? 'block' : 'none';
}

btnLoadMore.addEventListener('click', () => {
  displayCount += PAGE_SIZE;
  renderList();
});

// ── 创建单条记录 DOM ──────────────────────────────────────────────────────────
function createRecordItem(record) {
  const item = document.createElement('div');
  item.className = 'record-item';
  item.dataset.id = record.id;

  const statusBadge = record.status === 'success'
    ? '<span class="badge badge-success">✓ 成功</span>'
    : '<span class="badge badge-failed">✗ 失败</span>';

  const replyBadge = {
    replied:  '<span class="badge badge-replied">已回复</span>',
    no_reply: '<span class="badge badge-unknown">未回复</span>',
    unknown:  '',
  }[record.replyStatus] || '';

  item.innerHTML = `
    <div class="record-header">
      <div class="record-main">
        <div class="record-title">
          ${escHtml(record.jobTitle || '—')}
          ${statusBadge}
          ${replyBadge}
        </div>
        <div class="record-meta">
          ${escHtml(record.company || '—')} &nbsp;·&nbsp;
          招聘者：${escHtml(record.recruiterName || '—')} &nbsp;·&nbsp;
          薪资：${escHtml(record.salary || '面议')}
        </div>
      </div>
      <div class="record-right">
        <div class="record-time">${formatTime(record.sentAt)}</div>
      </div>
    </div>
    <div class="record-detail">
      <div class="detail-message">${escHtml(record.message || '（无消息内容）')}</div>
      <div class="reply-actions">
        <span style="font-size:12px;color:#888;margin-right:4px;">标记回复状态：</span>
        <button class="reply-btn ${record.replyStatus === 'replied' ? 'active' : ''}"
                data-status="replied" data-id="${record.id}">✓ 已回复</button>
        <button class="reply-btn ${record.replyStatus === 'no_reply' ? 'active' : ''}"
                data-status="no_reply" data-id="${record.id}">✗ 未回复</button>
        <button class="reply-btn ${record.replyStatus === 'unknown' ? 'active' : ''}"
                data-status="unknown" data-id="${record.id}">？ 未知</button>
      </div>
    </div>
  `;

  // 点击展开/收起
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('reply-btn')) return;
    item.classList.toggle('expanded');
  });

  // 标记回复状态
  item.querySelectorAll('.reply-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id     = btn.dataset.id;
      const status = btn.dataset.status;
      await updateReplyStatus(id, status);

      // 更新内存数据
      const rec = allHistory.find((r) => r.id === id);
      if (rec) rec.replyStatus = status;
      const fRec = filtered.find((r) => r.id === id);
      if (fRec) fRec.replyStatus = status;

      // 更新按钮样式
      item.querySelectorAll('.reply-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.status === status);
      });

      // 更新 badge
      const titleEl = item.querySelector('.record-title');
      const oldBadge = titleEl.querySelector('.badge-replied, .badge-unknown:not(:empty)');
      if (status === 'replied') {
        if (oldBadge) oldBadge.outerHTML = '<span class="badge badge-replied">已回复</span>';
        else titleEl.insertAdjacentHTML('beforeend', '<span class="badge badge-replied">已回复</span>');
      } else if (status === 'no_reply') {
        if (oldBadge) oldBadge.outerHTML = '<span class="badge badge-unknown">未回复</span>';
      } else {
        if (oldBadge) oldBadge.remove();
      }

      // 刷新统计
      renderStats(allHistory);
    });
  });

  return item;
}

async function updateReplyStatus(id, replyStatus) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('sendHistory', (result) => {
      const history = result.sendHistory || [];
      const idx     = history.findIndex((r) => r.id === id);
      if (idx !== -1) {
        history[idx].replyStatus = replyStatus;
        if (replyStatus === 'replied') {
          history[idx].repliedAt = Date.now();
        }
        chrome.storage.local.set({ sendHistory: history }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// ── 导出 CSV ──────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  if (filtered.length === 0) {
    alert('没有可导出的记录');
    return;
  }

  const headers = ['发送时间', '职位名称', '公司', '薪资', '招聘者', '发送状态', '回复状态', '消息内容'];
  const rows    = filtered.map((r) => [
    formatTime(r.sentAt),
    r.jobTitle   || '',
    r.company    || '',
    r.salary     || '',
    r.recruiterName || '',
    r.status === 'success' ? '成功' : '失败',
    { replied: '已回复', no_reply: '未回复', unknown: '未知' }[r.replyStatus] || '',
    (r.message || '').replace(/"/g, '""'),
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(','))
    .join('\n');

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `job_greeting_history_${formatDate(Date.now())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── 清空历史 ──────────────────────────────────────────────────────────────────
btnClearHistory.addEventListener('click', () => {
  if (!confirm('确定清空所有发送历史记录？此操作不可恢复。')) return;
  chrome.storage.local.set({ sendHistory: [] }, () => {
    allHistory   = [];
    filtered     = [];
    displayCount = PAGE_SIZE;
    renderStats([]);
    renderList();
  });
});

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function formatTime(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
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
