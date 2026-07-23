import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreCandidateForJob } from './ats-scoring.js';
import { ResumeInputError, validateResumeFile } from './resume-extraction.js';

test('ATS scoring is deterministic and job-specific', () => {
  const input = {
    jobTitle: 'Senior TypeScript Engineer',
    jobDescription: '- Must have 5 years TypeScript experience\n- AWS knowledge required\n- Bachelor degree required',
    resumeText: 'Senior engineer with 6 years TypeScript, React and AWS experience. Bachelor of Technology.',
    candidate: {
      name: 'A Candidate',
      email: 'candidate@example.com',
      phone: '+1 555 555 1212',
      location: 'Remote',
      education: 'Bachelor of Technology',
      experience: '6 years',
      skills: '["TypeScript","React","AWS"]',
      summary: 'Senior TypeScript engineer',
    },
  };
  const first = scoreCandidateForJob(input);
  const second = scoreCandidateForJob(input);
  assert.deepEqual(first, second);
  assert.equal(first.totalScore, 100);
  assert.equal(first.missingRequirements.length, 0);

  const changedJob = scoreCandidateForJob({ ...input, jobDescription: 'Must have 8 years Java experience' });
  assert.notEqual(changedJob.jobHash, first.jobHash);
  assert.ok(changedJob.totalScore < first.totalScore);
});

test('resume validation rejects extension spoofing', () => {
  const file = new File([Buffer.from('not a pdf')], 'resume.pdf', { type: 'application/pdf' });
  assert.throws(
    () => validateResumeFile(file, Buffer.from('not a pdf')),
    (error) => error instanceof ResumeInputError && error.code === 'signature_mismatch',
  );
});
