import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { unzipSync } from 'fflate';

export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_MIMES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export type ResumeMime = typeof RESUME_MIMES[keyof typeof RESUME_MIMES];

export class ResumeInputError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ResumeWorkHistoryEntry {
  title: string;
  company: string;
  duration: string;
}

export interface ExtractedResumeData {
  name: string;
  email: string;
  emails: string[];
  phone: string;
  phones: string[];
  location: string;
  education: string;
  experience: string;
  skills: string[];
  linkedin: string;
  github: string;
  portfolio: string;
  summary: string;
  university: string;
  gradYear: string;
  certifications: string[];
  languages: string[];
  workHistory: ResumeWorkHistoryEntry[];
  links: string[];
  fingerprint: string;
  missingFields: string[];
  warnings: string[];
  ocrRecommended: boolean;
  profileScore: number;
  textLength: number;
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedMime(file: File): ResumeMime {
  const name = file.name.toLowerCase();
  if (file.type === RESUME_MIMES.pdf || name.endsWith('.pdf')) return RESUME_MIMES.pdf;
  if (file.type === RESUME_MIMES.docx || name.endsWith('.docx')) return RESUME_MIMES.docx;
  throw new ResumeInputError('Only PDF and DOCX resumes are supported', 'unsupported_type');
}

function validateDocx(buffer: Buffer): void {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ResumeInputError('File content is not a valid DOCX archive', 'signature_mismatch');
  }

  for (let offset = 0; offset + 8 < buffer.length;) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    if ((buffer.readUInt16LE(offset + 6) & 1) !== 0) {
      throw new ResumeInputError('Password-protected DOCX files are not supported', 'password_protected');
    }
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    offset += 30 + nameLength + extraLength + compressed;
  }

  try {
    let entries = 0;
    let expandedBytes = 0;
    const files = unzipSync(buffer, {
      filter: (entry) => {
        entries += 1;
        expandedBytes += entry.originalSize;
        if (entries > 250 || expandedBytes > 30 * 1024 * 1024) {
          throw new ResumeInputError('DOCX archive expands beyond safe limits', 'unsafe_archive');
        }
        return entry.name === '[Content_Types].xml' || entry.name === 'word/document.xml';
      },
    });
    if (!files['[Content_Types].xml'] || !files['word/document.xml']) {
      throw new ResumeInputError('Archive is not a valid DOCX document', 'malformed_docx');
    }
  } catch (error) {
    if (error instanceof ResumeInputError) throw error;
    throw new ResumeInputError('DOCX archive is malformed or password-protected', 'malformed_docx');
  }
}

export function validateResumeFile(file: File, buffer: Buffer): ResumeMime {
  if (file.size === 0 || buffer.length === 0) {
    throw new ResumeInputError('Resume file is empty', 'empty_file');
  }
  if (file.size > RESUME_MAX_BYTES || buffer.length > RESUME_MAX_BYTES) {
    throw new ResumeInputError('Resume file must be 10MB or smaller', 'file_too_large');
  }
  const mime = normalizedMime(file);
  if (mime === RESUME_MIMES.pdf) {
    if (buffer.length < 8 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
      throw new ResumeInputError('File content is not a valid PDF', 'signature_mismatch');
    }
  } else {
    validateDocx(buffer);
  }
  return mime;
}

function cleanText(text: string): string {
  return text
    .replace(/\0/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false });
    const document = await loading.promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const rows = new Map<number, Array<{ x: number; text: string }>>();

      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const transform = 'transform' in item && Array.isArray(item.transform) ? item.transform : null;
        const x = typeof transform?.[4] === 'number' ? transform[4] : 0;
        const y = typeof transform?.[5] === 'number' ? Math.round(transform[5]) : 0;
        const bucket = rows.get(y) ?? [];
        bucket.push({ x, text: item.str });
        rows.set(y, bucket);
      }

      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, parts]) => parts
          .sort((a, b) => a.x - b.x)
          .map((part) => part.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim())
        .filter(Boolean);

      pages.push(lines.join('\n'));
    }

    await loading.destroy();
    return cleanText(pages.join('\n\n'));
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (error?.name === 'PasswordException' || /password/i.test(message)) {
      throw new ResumeInputError('Password-protected PDF files are not supported', 'password_protected');
    }
    throw new ResumeInputError('PDF is malformed and could not be read', 'malformed_pdf');
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return cleanText(result.value);
  } catch {
    throw new ResumeInputError('DOCX is malformed and could not be read', 'malformed_docx');
  }
}

const KNOWN_SKILLS = [
  'javascript', 'typescript', 'python', 'java', 'c#', 'c++', 'go', 'rust', 'php', 'ruby',
  'html', 'html5', 'css', 'css3', 'sass', 'bootstrap', 'tailwind', 'react', 'react.js',
  'angular', 'vue', 'node.js', 'nodejs', 'express', 'hono', 'django', 'flask', 'spring',
  'spring boot', 'spring mvc', 'hibernate', 'aws', 'azure', 'gcp', 'docker', 'kubernetes',
  'terraform', 'postgresql', 'mysql', 'mongodb', 'redis', 'sql', 'git', 'github', 'linux',
  'rest', 'restful', 'graphql', 'wordpress', 'shopify', 'webflow', 'n8n', 'agile', 'scrum',
  'machine learning', 'data analysis', 'power bi', 'tableau', 'salesforce', 'figma',
] as const;

const INDIAN_CITIES = [
  'noida', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'mumbai', 'pune', 'bangalore', 'bengaluru',
  'hyderabad', 'chennai', 'kolkata', 'ahmedabad', 'jaipur', 'lucknow', 'kanpur', 'indore', 'bhopal',
  'chandigarh', 'dehradun', 'etawah', 'faridabad', 'ghaziabad', 'coimbatore', 'kochi', 'trivandrum',
  'thiruvananthapuram', 'vadodara', 'surat', 'nagpur', 'patna', 'ranchi', 'bhubaneswar', 'visakhapatnam',
] as const;

const INDIAN_STATES = [
  'uttar pradesh', 'uttarakhand', 'maharashtra', 'karnataka', 'tamil nadu', 'telangana',
  'andhra pradesh', 'west bengal', 'gujarat', 'rajasthan', 'madhya pradesh', 'bihar',
  'odisha', 'kerala', 'punjab', 'haryana', 'delhi', 'india',
] as const;

const SECTION_HEADERS = [
  'summary', 'professional summary', 'career objective', 'objective', 'about me', 'profile',
  'education', 'academic', 'qualification',
  'experience', 'work experience', 'professional experience', 'employment',
  'projects', 'project',
  'technical skills', 'skills', 'technologies',
  'achievements', 'extracurricular', 'certifications', 'languages',
] as const;

const JOB_TITLE_HINTS = [
  'developer', 'engineer', 'intern', 'trainee', 'architect', 'manager', 'analyst',
  'consultant', 'specialist', 'lead', 'fullstack', 'full stack', 'frontend', 'backend',
] as const;

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, 'i').test(text);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9&.()-]+$/.test(word) ? word : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

function looksLikePersonName(value: string): boolean {
  const cleaned = value.replace(/[^A-Za-z\s.'-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 60) return false;
  const words = cleaned.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  if (words.some((word) => word.length < 2)) return false;
  if (SECTION_HEADERS.some((header) => cleaned.toLowerCase() === header)) return false;
  if (/resume|curriculum|vitae|cv|profile|candidate/i.test(cleaned)) return false;
  return words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word));
}

function sectionBody(text: string, headers: string[], stopHeaders: string[], options?: { flatten?: boolean }): string {
  const source = text.replace(/\r/g, '');
  const start = headers
    .map((header) => {
      const match = new RegExp(`(?:^|\\n)\\s*${header.replace(/\s+/g, '\\s+')}\\s*[:\\-]?\\s*`, 'i').exec(source)
        ?? new RegExp(`\\b${header.replace(/\s+/g, '\\s+')}\\s*[:\\-]?\\s*`, 'i').exec(source);
      return match ? match.index + match[0].length : -1;
    })
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (start == null || start < 0) return '';

  const remainder = source.slice(start);
  const stop = stopHeaders
    .map((header) => {
      const match = new RegExp(`(?:^|\\n)\\s*${header.replace(/\s+/g, '\\s+')}\\b`, 'i').exec(remainder)
        ?? new RegExp(`\\b${header.replace(/\s+/g, '\\s+')}\\b`, 'i').exec(remainder);
      return match ? match.index : -1;
    })
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];

  const body = remainder.slice(0, stop ?? remainder.length).trim();
  return options?.flatten === false ? body : collapseSpaces(body);
}

function extractEmails(text: string): string[] {
  return [...new Set(text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [])]
    .map((email) => email.toLowerCase())
    .filter((email) => !/linkedin\.com|github\.com/.test(email));
}

function extractPhones(text: string): string[] {
  const phones = new Set<string>();
  for (const match of text.matchAll(/\+?91(?:[\s.-]?\d){10}\b/g)) {
    const digits = match[0].replace(/[^\d+]/g, '');
    phones.add(digits.startsWith('+91') ? digits : `+${digits}`);
  }
  for (const match of text.matchAll(/\+\d{1,3}[\s.-]?\d{6,12}\b/g)) phones.add(match[0].replace(/\s+/g, ' ').trim());
  for (const match of text.matchAll(/(?<!\d)\d{10}(?!\d)/g)) phones.add(match[0]);
  return [...phones];
}

function extractLinks(text: string): string[] {
  return [...new Set(text.match(/\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi) ?? [])]
    .map((link) => link.replace(/[),.;]+$/, ''));
}

function extractUrls(text: string): { linkedin: string; github: string; portfolio: string } {
  const repaired = text
    .replace(/linked\s*in\s*\.\s*com/gi, 'linkedin.com')
    .replace(/git\s*hub\s*\.\s*com/gi, 'github.com')
    .replace(/https?\s*:\s*\/\s*\//gi, 'https://');

  const linkedinMatch = repaired.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]+)/i);
  const githubMatch = repaired.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9\-_]+)/i);
  const portfolioLabelMatch = repaired.match(/(?:portfolio|website|live\s*link)\s*[:\-]?\s*(https?:\/\/[^\s]+)/i);
  const portfolioHttpMatch = repaired.match(/\bhttps?:\/\/[^\s]+\.(?:dev|io|me|design|tech|codes|website|site|app|com|in)(?:\/[^\s]*)?/i);
  const portfolioWwwMatch = repaired.match(/\bwww\.[^\s]+\.(?:dev|io|me|design|tech|codes|website|site|app|com|in)(?:\/[^\s]*)?/i);

  const githubUser = githubMatch?.[1] ?? '';
  const blockedGithub = new Set(['topics', 'explore', 'settings', 'notifications', 'about', 'pricing', 'features']);

  return {
    linkedin: linkedinMatch ? `https://www.linkedin.com/in/${linkedinMatch[1].replace(/\/$/, '')}` : '',
    github: githubMatch && !blockedGithub.has(githubUser.toLowerCase())
      ? `https://github.com/${githubMatch[1]}`
      : '',
    portfolio: (() => {
      const candidate = portfolioLabelMatch?.[1] ?? portfolioHttpMatch?.[0] ?? portfolioWwwMatch?.[0] ?? '';
      const cleaned = candidate.replace(/[),.;]+$/, '');
      if (!cleaned || /linkedin\.com|github\.com/i.test(cleaned)) return '';
      if (!/^https?:\/\//i.test(cleaned)) return `https://${cleaned}`;
      return cleaned;
    })(),
  };
}

function extractName(text: string, email: string): string {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    const beforeContact = line
      .split(/(?:\+|@|https?:\/\/|www\.|linkedin|github|email|phone|mobile)/i)[0]
      .trim();
    const candidate = beforeContact
      .replace(/\b(?:noida|delhi|mumbai|pune|bangalore|bengaluru|hyderabad|chennai|lucknow|dehradun|etawah|india|uttar pradesh|uttarakhand)[, ]*/gi, ' ')
      .replace(/[^A-Za-z\s.'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (looksLikePersonName(candidate)) return titleCase(candidate);
  }

  const header = collapseSpaces(text.slice(0, 220));
  const headerName = header.match(/^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\b/);
  if (headerName && looksLikePersonName(headerName[1])) return titleCase(headerName[1]);

  if (email.includes('@')) {
    const local = email.split('@')[0].replace(/[0-9._+-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (looksLikePersonName(local) || local.split(' ').length >= 2) return titleCase(local);
  }
  return '';
}

function extractLocation(text: string): string {
  const header = collapseSpaces(text.slice(0, 500)).toLowerCase();
  for (const city of INDIAN_CITIES) {
    for (const state of INDIAN_STATES) {
      const pattern = new RegExp(`\\b${city}\\b\\s*,\\s*${state}\\b`, 'i');
      if (pattern.test(header) || pattern.test(text)) {
        return titleCase(`${city}, ${state}`);
      }
    }
  }

  const labeled = text.match(/(?:location|address|city)\s*[:\-]\s*([^\n,]{3,60})/i);
  if (labeled) return titleCase(labeled[1].trim());

  for (const city of INDIAN_CITIES) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(header)) return titleCase(city);
  }
  return '';
}

function extractEducation(text: string): string {
  const lower = text.toLowerCase();
  const educationSection = sectionBody(
    text,
    ['education', 'academic', 'qualification'],
    ['experience', 'work experience', 'projects', 'technical skills', 'skills', 'achievements'],
  );
  const degreeLine = (educationSection || text).match(
    /\b((?:B\.?\s*SC|B\.?\s*Tech|Bachelors?|Master'?s?|M\.?\s*Tech|MCA|MBA|Diploma)\s*[-–:]?\s*[A-Za-z0-9()&./+\s]{0,80}?)(?=\s+(?:Seven|School|EXPERIENCE|PROJECTS|TECHNICAL|\d{4}\b)|$)/i,
  );
  if (degreeLine) return collapseSpaces(degreeLine[1]);

  if (/\b(ph\.?\s*d|doctorate)\b/.test(lower)) return "Doctorate / PhD";
  if (/\b(master'?s?|m\.?\s*tech|mtech|m\.?\s*sc|msc|mca|mba|m\.?\s*com)\b/.test(lower)) return "Master's Degree / PG";
  if (/\b(bachelor'?s?|b\.?\s*tech|btech|b\.?\s*sc|bsc|bca|bba|b\.?\s*com|computer science)\b/.test(lower)) {
    return "Bachelor's Degree";
  }
  if (/\b(diploma|polytechnic)\b/.test(lower)) return 'Diploma';
  return '';
}

function extractExperienceLabel(text: string, workHistory: ResumeWorkHistoryEntry[]): string {
  const lower = text.toLowerCase();
  const explicitYears = lower.match(/(\d+)\s*\+?\s*(?:years?|yrs?)(?:\s+of\s+experience)?/);
  if (explicitYears && Number(explicitYears[1]) > 0) return `${explicitYears[1]} Years`;

  const explicitMonths = lower.match(/(\d+)\s*(?:months?|mos?)(?:\s+of\s+experience)?/);
  if (explicitMonths) {
    const months = Number(explicitMonths[1]);
    if (months >= 12) return `${Math.floor(months / 12)} Years`;
    if (months > 0) return `${months} Months`;
  }

  if (/\b(intern|internship|trainee|apprentice)\b/.test(lower) || workHistory.some((role) => /intern|trainee/i.test(role.title))) {
    return 'Internship / < 1 Year';
  }

  if (workHistory.length > 0) {
    const years = workHistory
      .map((role) => [...role.duration.matchAll(/(20\d{2})/g)].map((match) => Number(match[1])))
      .filter((values) => values.length >= 2)
      .map((values) => Math.max(...values) - Math.min(...values));
    if (years.length > 0) {
      const maxYears = Math.max(...years);
      if (maxYears > 0) return `~${maxYears} Years`;
    }
  }

  return workHistory.length > 0 ? 'Experience available' : 'Fresher';
}

function extractSummary(text: string): string {
  const body = sectionBody(
    text,
    ['professional summary', 'profile summary', 'career objective', 'summary', 'objective', 'about me', 'profile'],
    ['education', 'experience', 'work experience', 'technical skills', 'skills', 'projects', 'employment'],
  );
  if (body.length >= 40) return body.slice(0, 700);

  const inline = text.match(/\bSummary\s+(.{80,700}?)(?=\s+(?:EDUCATION|EXPERIENCE|TECHNICAL SKILLS|PROJECTS)\b)/i);
  return inline ? collapseSpaces(inline[1]).slice(0, 700) : '';
}

function extractUniversity(text: string): string {
  const education = sectionBody(
    text,
    ['education', 'academic', 'qualification'],
    ['experience', 'work experience', 'projects', 'technical skills', 'skills', 'achievements'],
    { flatten: false },
  ) || text;
  const match = education.match(
    /([A-Z][A-Za-z0-9&.()' -]{2,80}(?:Institute|University|College|School|Academy|IIT|NIT|IIIT))/,
  );
  return match ? collapseSpaces(match[1]) : '';
}

function extractGradYear(text: string): string {
  const education = sectionBody(
    text,
    ['education', 'academic', 'qualification'],
    ['experience', 'work experience', 'projects', 'technical skills', 'skills', 'achievements'],
    { flatten: false },
  ) || text.slice(0, 1200);
  const years = [...education.matchAll(/\b(19[89]\d|20[0-3]\d)\b/g)].map((match) => Number(match[1]));
  if (years.length === 0) return '';
  const current = new Date().getFullYear();
  const valid = years.filter((year) => year <= current + 4);
  return valid.length ? String(Math.max(...valid)) : '';
}

function extractWorkHistory(text: string): ResumeWorkHistoryEntry[] {
  const experience = sectionBody(
    text,
    ['work experience', 'professional experience', 'employment history', 'experience'],
    ['projects', 'education', 'technical skills', 'skills', 'achievements', 'certifications'],
    { flatten: false },
  );
  if (!experience) return [];

  const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const dateToken = `(?:${month}\\s+20\\d{2}|20\\d{2})`;
  const rangeRe = new RegExp(`(${dateToken})\\s*[-–—to]+\\s*(${dateToken}|Present|Current|Now)`, 'i');
  const lines = experience
    .split(/\n+/)
    .map((line) => collapseSpaces(line))
    .filter((line) => line && !/^experience$/i.test(line));

  if (lines.length >= 2) {
    const entries: ResumeWorkHistoryEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const range = line.match(rangeRe);
      if (!range) continue;
      let company = collapseSpaces(line.slice(0, range.index ?? 0).replace(/\bEXPERIENCE\b/gi, ''));
      company = company.replace(/[|•-]\s*$/, '').trim();
      const next = lines[index + 1] ?? '';
      const nextHasDate = rangeRe.test(next);
      const titleLine = !nextHasDate ? next : '';
      const pipeParts = company.split('|').map((part) => collapseSpaces(part)).filter(Boolean);
      let title = JOB_TITLE_HINTS
        .map((hint) => {
          const pattern = new RegExp(`([A-Za-z][A-Za-z0-9 /+#-]*${hint}[A-Za-z0-9 /+#-]*)`, 'i');
          return (titleLine || line).match(pattern)?.[1]?.trim() ?? '';
        })
        .filter(Boolean)
        .sort((a, b) => a.length - b.length)[0]
        ?? '';
      if (pipeParts.length >= 2) {
        const [left, right] = pipeParts;
        const leftHasRole = JOB_TITLE_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`, 'i').test(left));
        const rightHasRole = JOB_TITLE_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`, 'i').test(right));
        if (leftHasRole && !rightHasRole) {
          title = title || left;
          company = right;
        } else if (!leftHasRole && rightHasRole) {
          title = title || right;
          company = left;
        }
      }
      company = company
        .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?\s*$/i, '')
        .replace(/\b\d{1,2}\/\s*$/i, '')
        .trim();
      if (!title && titleLine) {
        title = titleLine.split(/\b(?:Dehradun|Noida|Lucknow|India|Remote)\b/i)[0].trim();
      }
      if (!title && line.includes('|')) {
        title = line.split('|')[0].trim();
      }
      title = title
        .replace(/^[-•]\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      title = title.replace(/\b(?:Dehradun|Noida|Lucknow|India)\b/gi, '').trim();

      if (!company && !title) continue;
      if (/undergoing|comprehensive|hands-on training/i.test(title) && title.length > 70) {
        title = title.match(/(?:mern|full\s*stack).*?(?:trainee|intern)/i)?.[0] ?? 'Trainee';
      }
      entries.push({
        title: titleCase((title || 'Role').slice(0, 90)),
        company: titleCase(company || 'Company'),
        duration: `${range[1]} - ${range[2]}`,
      });
    }
    if (entries.length > 0) return entries.slice(0, 6);
  }

  const matches = [...experience.matchAll(new RegExp(rangeRe.source, 'gi'))];
  const entries: ResumeWorkHistoryEntry[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = Math.max(0, (match.index ?? 0) - 90);
    const end = Math.min(experience.length, (matches[index + 1]?.index ?? (match.index ?? 0) + match[0].length + 90));
    const context = collapseSpaces(experience.slice(start, end));
    const company = collapseSpaces(context.slice(0, context.toLowerCase().indexOf(match[1].toLowerCase())));
    const after = collapseSpaces(context.slice(context.toLowerCase().indexOf(match[0].toLowerCase()) + match[0].length));
    const title = JOB_TITLE_HINTS
      .map((hint) => {
        const pattern = new RegExp(`([A-Za-z][A-Za-z0-9 /+#-]*${hint}[A-Za-z0-9 /+#-]*)`, 'i');
        return after.match(pattern)?.[1]?.trim() ?? '';
      })
      .filter(Boolean)
      .sort((a, b) => a.length - b.length)[0] ?? '';
    if (!company && !title) continue;
    entries.push({
      title: titleCase(title || 'Role'),
      company: titleCase(company || 'Company'),
      duration: `${match[1]} - ${match[2]}`,
    });
  }
  return entries.slice(0, 6);
}

function extractSkills(text: string): string[] {
  return KNOWN_SKILLS.filter((skill) => containsPhrase(text, skill));
}

function extractCertifications(text: string): string[] {
  const body = sectionBody(
    text,
    ['certifications', 'certificates', 'licenses', 'credentials'],
    ['languages', 'projects', 'skills', 'education', 'experience', 'achievements'],
  );
  if (!body) return [];
  return body
    .split(/[•●\n]|(?<=\.)\s+/)
    .map((line) => line.replace(/^[\-\d.)\s]+/, '').trim())
    .filter((line) => line.length > 8 && line.length < 120)
    .filter((line) => !/extracurricular|achievement/i.test(line))
    .slice(0, 8);
}

function extractLanguages(text: string): string[] {
  const known = ['english', 'hindi', 'spanish', 'french', 'german', 'tamil', 'telugu', 'marathi', 'bengali'];
  const body = sectionBody(text, ['languages', 'language'], ['hobbies', 'interests', 'declaration', 'skills', 'projects']);
  const source = (body || text).toLowerCase();
  return known.filter((language) => new RegExp(`\\b${language}\\b`).test(source)).map(titleCase);
}

function computeMissingFields(data: {
  name: string;
  email: string;
  phone: string;
  location: string;
  education: string;
  experience: string;
  summary: string;
  university: string;
  gradYear: string;
  linkedin: string;
  skills: string[];
  workHistory: ResumeWorkHistoryEntry[];
}): string[] {
  const missing: string[] = [];
  if (!data.name) missing.push('name');
  if (!data.email) missing.push('email');
  if (!data.phone) missing.push('phone');
  if (!data.location) missing.push('location');
  if (!data.education) missing.push('education');
  if (!data.experience) missing.push('experience');
  if (!data.summary) missing.push('summary');
  if (!data.university) missing.push('university');
  if (!data.gradYear) missing.push('gradYear');
  if (!data.linkedin) missing.push('linkedin');
  if (data.skills.length === 0) missing.push('skills');
  if (data.workHistory.length === 0) missing.push('workHistory');
  return missing;
}

function profileScore(data: Omit<ExtractedResumeData, 'profileScore' | 'textLength' | 'emails' | 'phones' | 'links'>): number {
  const checks = [
    Boolean(data.name),
    Boolean(data.email),
    Boolean(data.phone),
    Boolean(data.location),
    data.skills.length > 0,
    Boolean(data.summary),
    Boolean(data.education),
    Boolean(data.experience),
    Boolean(data.linkedin || data.github || data.portfolio),
    Boolean(data.university),
    Boolean(data.gradYear),
    data.workHistory.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

export function deriveResumeData(text: string): ExtractedResumeData {
  const emails = extractEmails(text);
  const phones = extractPhones(text);
  const links = extractLinks(text);
  const urls = extractUrls(text);
  const email = emails[0] ?? '';
  const phone = phones[0] ?? '';
  const name = extractName(text, email);
  const location = extractLocation(text);
  const education = extractEducation(text);
  const summary = extractSummary(text);
  const university = extractUniversity(text);
  const gradYear = extractGradYear(text);
  const workHistory = extractWorkHistory(text);
  const experience = extractExperienceLabel(text, workHistory);
  const skills = extractSkills(text);
  const certifications = extractCertifications(text);
  const languages = extractLanguages(text);
  const fingerprint = sha256(`${name.toLowerCase()}|${email.toLowerCase()}|${phone}`);
  const missingFields = computeMissingFields({
    name,
    email,
    phone,
    location,
    education,
    experience,
    summary,
    university,
    gradYear,
    linkedin: urls.linkedin,
    skills,
    workHistory,
  });
  const warnings: string[] = [];
  if (missingFields.length > 0) {
    warnings.push(`Some profile fields are missing: ${missingFields.join(', ')}`);
  }

  const base = {
    name,
    email,
    emails,
    phone,
    phones,
    location,
    education,
    experience,
    skills,
    linkedin: urls.linkedin,
    github: urls.github,
    portfolio: urls.portfolio,
    summary,
    university,
    gradYear,
    certifications,
    languages,
    workHistory,
    links,
    fingerprint,
    missingFields,
    warnings,
    ocrRecommended: false,
  };

  const textLength = text.length;
  const ocrRecommended = textLength < 300 || missingFields.length >= 5;
  if (ocrRecommended) {
    base.warnings.push('Low text quality detected. OCR or manual correction is recommended.');
  }

  return {
    ...base,
    ocrRecommended,
    profileScore: profileScore(base),
    textLength,
  };
}

export async function extractResume(buffer: Buffer, mime: ResumeMime): Promise<{
  text: string;
  data: ExtractedResumeData;
}> {
  const text = mime === RESUME_MIMES.pdf ? await extractPdf(buffer) : await extractDocx(buffer);
  const effectiveLength = text.replace(/\s/g, '').length;
  if (effectiveLength < 10) {
    throw new ResumeInputError(
      'Resume contains too little extractable text; scanned documents require OCR, which is not supported',
      'insufficient_text',
    );
  }
  const data = deriveResumeData(text);
  if (effectiveLength < 80) {
    data.ocrRecommended = true;
    data.warnings.push('Structured text is very limited; OCR/manual correction required.');
  }
  return { text, data };
}
