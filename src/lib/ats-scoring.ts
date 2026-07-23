import { sha256 } from './resume-extraction.js';

export const ATS_ALGORITHM_VERSION = 'ats-deterministic-v1';

export interface AtsScoreResult {
  algorithmVersion: string;
  totalScore: number;
  components: {
    requirements: number;
    experience: number;
    education: number;
    titleAlignment: number;
  };
  matchedRequirements: string[];
  missingRequirements: string[];
  warnings: string[];
  resumeHash: string;
  jobHash: string;
}

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'but', 'for', 'from', 'have', 'into', 'must',
  'our', 'that', 'the', 'their', 'this', 'with', 'will', 'you', 'your', 'years', 'year',
  'required', 'preferred', 'requirements', 'responsibilities', 'experience', 'knowledge',
  'skills', 'ability', 'role', 'work', 'working', 'strong', 'excellent', 'degree',
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).split(' ').filter(
    (token) => token.length >= 3 && !/^\d+(?:\.\d+)?$/.test(token) && !STOP_WORDS.has(token),
  ))];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function extractRequirements(description: string): string[] {
  const lineRequirements = description
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*•\-\d.)]+/, '').trim())
    .filter((line) => line.length >= 4 && line.length <= 180)
    .filter((line) => /\b(required|must|minimum|proficien|experience|knowledge|skill|degree|certif|familiar)\b/i.test(line));

  if (lineRequirements.length > 0) return [...new Set(lineRequirements)].slice(0, 30);
  return tokens(description).slice(0, 25);
}

function requirementMatches(requirement: string, resumeText: string): boolean {
  const requirementTokens = tokens(requirement);
  if (requirementTokens.length === 0) return false;
  const resumeTokens = new Set(tokens(resumeText));
  const matched = requirementTokens.filter((token) => resumeTokens.has(token)).length;
  return matched / requirementTokens.length >= (requirementTokens.length <= 2 ? 1 : 0.6);
}

function yearsIn(value: string): number {
  const values = [...value.matchAll(/(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : 0;
}

function educationLevel(value: string): number {
  const normalized = normalize(value);
  if (/\b(phd|doctorate)\b/.test(normalized)) return 4;
  if (/\b(master|masters|mba|mtech|m\.tech|msc|m\.sc)\b/.test(normalized)) return 3;
  if (/\b(bachelor|bachelors|btech|b\.tech|bsc|b\.sc|degree)\b/.test(normalized)) return 2;
  if (/\b(diploma|associate)\b/.test(normalized)) return 1;
  return 0;
}

export function scoreCandidateForJob(input: {
  jobTitle: string;
  jobDescription: string;
  resumeText: string;
  candidate: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    location?: string | null;
    education?: string | null;
    experience?: string | null;
    skills?: string | null;
    summary?: string | null;
  };
  resumeHash?: string;
}): AtsScoreResult {
  const candidateProfile = [
    input.resumeText,
    input.candidate.education,
    input.candidate.experience,
    input.candidate.skills,
    input.candidate.summary,
  ].filter(Boolean).join('\n');
  const requirements = extractRequirements(input.jobDescription);
  const matchedRequirements = requirements.filter((requirement) => requirementMatches(requirement, candidateProfile));
  const missingRequirements = requirements.filter((requirement) => !matchedRequirements.includes(requirement));
  const warnings: string[] = [];

  const requirementsScore = requirements.length === 0
    ? 0
    : 55 * (matchedRequirements.length / requirements.length);
  if (requirements.length === 0) warnings.push('Job description has no identifiable requirements');

  const requiredYears = yearsIn(input.jobDescription);
  const candidateYears = yearsIn(`${input.candidate.experience ?? ''}\n${input.resumeText}`);
  const experienceScore = requiredYears === 0
    ? (candidateYears > 0 ? 20 : 10)
    : 20 * Math.min(candidateYears / requiredYears, 1);
  if (requiredYears > 0 && candidateYears === 0) warnings.push('Candidate experience duration could not be determined');

  const requiredEducation = educationLevel(input.jobDescription);
  const candidateEducation = educationLevel(`${input.candidate.education ?? ''}\n${input.resumeText}`);
  const educationScore = requiredEducation === 0
    ? (candidateEducation > 0 ? 10 : 5)
    : 10 * Math.min(candidateEducation / requiredEducation, 1);

  const titleTokens = tokens(input.jobTitle);
  const profileTokens = new Set(tokens(candidateProfile));
  const titleAlignmentScore = titleTokens.length === 0
    ? 0
    : 15 * (titleTokens.filter((token) => profileTokens.has(token)).length / titleTokens.length);

  const components = {
    requirements: round(requirementsScore),
    experience: round(experienceScore),
    education: round(educationScore),
    titleAlignment: round(titleAlignmentScore),
  };
  const totalScore = round(Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0)));
  const jobCanonical = `${normalize(input.jobTitle)}\n${normalize(input.jobDescription)}`;

  return {
    algorithmVersion: ATS_ALGORITHM_VERSION,
    totalScore,
    components,
    matchedRequirements,
    missingRequirements,
    warnings,
    resumeHash: input.resumeHash ?? sha256(normalize(candidateProfile)),
    jobHash: sha256(jobCanonical),
  };
}
