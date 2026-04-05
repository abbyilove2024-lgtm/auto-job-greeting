/**
 * resume_parser.js
 * 简历文件解析：PDF / Word (.docx/.doc) → 结构化 resumeData
 */

const CONFIDENCE = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

const NAME_BLACKLIST = [
  '电话', '手机', '邮箱', '微信', 'qq', '性别', '年龄', '地址', '求职意向',
  '出生', '籍贯', 'linkedin', 'github', 'email',
];

const EDUCATION_LEVELS = [
  { label: '博士', keywords: ['博士', 'phd', 'ph.d', 'doctor'] },
  { label: '硕士', keywords: ['硕士', 'master', '研究生', 'm.s', 'm.a'] },
  { label: '本科', keywords: ['本科', '学士', 'bachelor', '大学本科'] },
  { label: '大专', keywords: ['大专', '专科', '高职', 'associate'] },
];

const TECH_KEYWORDS = [
  'JavaScript', 'TypeScript', 'Vue', 'React', 'Angular', 'HTML', 'CSS',
  'Webpack', 'Vite', 'Node.js', 'Next.js', 'Nuxt',
  'Java', 'Python', 'Go', 'PHP', 'C++', 'C#', 'Ruby', 'Kotlin', 'Swift',
  'Spring', 'Django', 'Flask', 'FastAPI', 'Express', 'Koa', 'Laravel',
  'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'SQLite',
  'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Linux', 'Nginx', 'Git',
  'CI/CD', 'Jenkins', 'GitHub Actions',
  'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'Spark', 'SQL',
  'Android', 'iOS', 'Flutter', 'React Native', 'UniApp',
  'GraphQL', 'REST', 'gRPC', 'WebSocket', 'Kafka', 'RabbitMQ',
];

/**
 * 解析简历文件
 * @param {File} file
 * @returns {Promise<{
 *   name:string,
 *   skills:string[],
 *   experience:number|null,
 *   education:string,
 *   rawText:string,
 *   confidence:{name:string,skills:string,experience:string,education:string},
 *   warnings:string[]
 * }>}
 */
export async function parseResume(file) {
  const ext = (file?.name || '').split('.').pop().toLowerCase();
  let text = '';

  if (ext === 'pdf') {
    text = await extractTextFromPdf(file);
  } else if (ext === 'docx' || ext === 'doc') {
    text = await extractTextFromWord(file);
  } else {
    throw new Error('UNSUPPORTED_FORMAT');
  }

  const normalizedText = normalizeText(text);
  if (!normalizedText || normalizedText.trim().length < 10) {
    throw new Error('PARSE_FAILED');
  }

  return extractFields(normalizedText);
}

async function extractTextFromPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) throw new Error('PDF_LIB_NOT_READY');

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('lib/vendor/pdf.worker.min.js')
      : '../lib/vendor/pdf.worker.min.js';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }

  return pages.join('\n');
}

async function extractTextFromWord(file) {
  const arrayBuffer = await file.arrayBuffer();
  const mammoth = window.mammoth;
  if (!mammoth) throw new Error('WORD_LIB_NOT_READY');
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || '';
}

function extractFields(text) {
  const nameResult = extractName(text);
  const skillsResult = extractSkills(text);
  const expResult = extractExperience(text);
  const educationResult = extractEducation(text);

  const warnings = [
    nameResult.warning,
    skillsResult.warning,
    expResult.warning,
    educationResult.warning,
  ].filter(Boolean);

  return {
    name: nameResult.value,
    skills: skillsResult.value,
    experience: expResult.value,
    education: educationResult.value,
    rawText: text,
    confidence: {
      name: nameResult.confidence,
      skills: skillsResult.confidence,
      experience: expResult.confidence,
      education: educationResult.confidence,
    },
    warnings,
  };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractName(text) {
  const explicit = text.match(/(?:^|\n)\s*(?:姓\s*名|name)\s*[：:]\s*([^\n]{1,30})/i);
  if (explicit?.[1]) {
    const candidate = sanitizeNameCandidate(explicit[1]);
    const validation = validateNameCandidate(candidate);
    if (validation.ok) {
      return { value: candidate, confidence: CONFIDENCE.HIGH };
    }
    return {
      value: '',
      confidence: CONFIDENCE.LOW,
      warning: `姓名识别命中疑似无效值：${candidate || '空值'}，请手动确认`,
    };
  }

  const lines = splitLines(text).slice(0, 15);
  for (let i = 0; i < lines.length; i++) {
    const candidate = sanitizeNameCandidate(lines[i]);
    const validation = validateNameCandidate(candidate);
    if (!validation.ok) continue;

    const confidence = i <= 2 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;
    return {
      value: confidence === CONFIDENCE.LOW ? '' : candidate,
      confidence,
      warning: confidence === CONFIDENCE.LOW ? `姓名候选不稳定：${candidate}，请手动确认` : '',
    };
  }

  return {
    value: '',
    confidence: CONFIDENCE.LOW,
    warning: '未识别到高置信度姓名，请手动填写',
  };
}

function sanitizeNameCandidate(raw) {
  if (!raw) return '';
  let candidate = String(raw).trim();
  candidate = candidate
    .replace(/(电话|手机|邮箱|微信|qq|性别|年龄|地址|求职意向).*/i, '')
    .split(/[|/，,;；\s]+/)[0]
    .replace(/[：:]/g, '')
    .trim();
  return candidate;
}

function validateNameCandidate(name) {
  if (!name) return { ok: false };
  if (/\d/.test(name)) return { ok: false };

  const lower = name.toLowerCase();
  if (NAME_BLACKLIST.some((kw) => lower.includes(kw.toLowerCase()))) {
    return { ok: false };
  }

  if (/^[\u4e00-\u9fa5]{2,4}$/.test(name)) return { ok: true };
  if (/^[A-Za-z][A-Za-z .'-]{1,29}$/.test(name)) return { ok: true };
  return { ok: false };
}

function extractSkills(text) {
  const found = new Set();
  const lower = text.toLowerCase();

  const sectionMatch = text.match(/(?:技能|技术栈|专业技能)[：:\s]*([\s\S]{0,200})/i);
  const sectionText = sectionMatch?.[1] || '';
  collectSkills(sectionText, found);
  collectSkills(lower, found, true);

  const skills = [...found];
  return {
    value: skills,
    confidence: skills.length > 0 ? CONFIDENCE.HIGH : CONFIDENCE.LOW,
    warning: skills.length > 0 ? '' : '未识别到明确技能关键词，请手动补充',
  };
}

function collectSkills(sourceText, foundSet, sourceIsLower = false) {
  if (!sourceText) return;
  const lowerText = sourceIsLower ? sourceText : sourceText.toLowerCase();
  for (const skill of TECH_KEYWORDS) {
    if (lowerText.includes(skill.toLowerCase())) {
      foundSet.add(skill);
    }
  }
}

function extractExperience(text) {
  const rules = [
    { regex: /(\d{1,2})\s*年\s*(?:以上|\+)/, map: (m) => toYears(m[1]), confidence: CONFIDENCE.HIGH },
    { regex: /(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*年/, map: (m) => Math.max(toYears(m[1]), toYears(m[2])), confidence: CONFIDENCE.MEDIUM },
    { regex: /(?:工作|从业|相关经验)[^\d]{0,6}(\d{1,2})\s*年/, map: (m) => toYears(m[1]), confidence: CONFIDENCE.HIGH },
    { regex: /经验[：:\s]*(\d{1,2})\s*年/, map: (m) => toYears(m[1]), confidence: CONFIDENCE.MEDIUM },
    { regex: /有\s*(\d{1,2})\s*年/, map: (m) => toYears(m[1]), confidence: CONFIDENCE.MEDIUM },
  ];

  for (const rule of rules) {
    const match = text.match(rule.regex);
    if (!match) continue;
    const years = rule.map(match);
    if (years > 0 && years < 50) {
      return { value: years, confidence: rule.confidence };
    }
  }

  return {
    value: null,
    confidence: CONFIDENCE.LOW,
    warning: '未识别到明确工作年限，请手动填写',
  };
}

function toYears(value) {
  return parseInt(String(value || '0'), 10) || 0;
}

function extractEducation(text) {
  const lower = text.toLowerCase();
  for (const level of EDUCATION_LEVELS) {
    for (const kw of level.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        return { value: level.label, confidence: CONFIDENCE.HIGH };
      }
    }
  }

  return {
    value: '',
    confidence: CONFIDENCE.LOW,
    warning: '未识别到学历信息，请手动确认',
  };
}

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
