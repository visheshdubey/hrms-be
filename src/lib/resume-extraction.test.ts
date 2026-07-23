import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveResumeData,
  extractResume,
  RESUME_MIMES,
} from './resume-extraction.js';

const SAMPLE_TEXT = `
ABHAY TIWARY
Noida, Uttar Pradesh
+91-9997127833
abhay.tiwari3003@gmail.com
https://www.linkedin.com/in/abhay-tiwari-93b412290/
Summary
Results-driven Full Stack Developer with hands-on experience in Java, Spring Boot, Hibernate, MySQL, React, HTML, CSS, JavaScript, and RESTful APIs. Skilled in developing scalable web applications, database management, and front-end/UI design with Bootstrap, Tailwind, and CMS platforms (WordPress, Shopify, Webflow). Proficient in Git, n8n automation workflows, and agile team collaboration.
EDUCATION
Ramwati Rajbahadur Group of Institute Rishibhumi, Prathvipur, Etawah 2023 - 2026
BSC - Computer Science and Engineering(CSE)
Seven Hills school Etawah, Uttar Pradesh 2021 12 th
EXPERIENCE
Zentrix Technology March 2025 - May 2025 Junior Frontend Developer Intern Dehradun, India
CETPA Infotech Pvt. ltd Sep 2024 - March 2025 Java Full Stack Developer Intern Noida, India
Softpro India Computer Technologies (P) Ltd. July 2023 - Sep 2023 Python Full Stack Developer Trainee Lucknow, India
PROJECTS
Bank Management System Application | Java, MySQL, Spring MVC, Spring Boot 2025
TECHNICAL SKILLS
Language: Java, Python Technologies/Frameworks: MongoDb,Tailwind, HTML5, CSS3, JavaScript (ES6+), React.js, TypeScript Tools/VCS: Git, GitHub, VsCode
`.trim();

const MANAS_STYLE_TEXT = `
MANAS GUPTA
New Ashok Nagar, Delhi | 9555998119 | manasmggupta@gmail.com
LinkedIn: linkedin.com/in/manas-gupta-97a4a4256 | GitHub: github.com/manasgupta-14
PROFESSIONAL SUMMARY
Dedicated Full Stack Web Developer and BCA graduate with expertise in building responsive web applications.
WORK EXPERIENCE
MERN Stack Trainee | CETPA Infotech Pvt. Ltd. 01/2026 - Present
• Undergoing Comprehensive, Hands-on Training in Full-stack Web Development Utilizing the MERN Stack.
PROJECTS
Live Link: https://manasgupta-14.github.io/Mera-Safar---Safar-Aapka-Zimmedari-Hamari-/
`.trim();

const AKASH_STYLE_TEXT = `
Akash Mishra
am1703439@gmail.com | +91 9129424384 | Vadodara, Gujarat
linkedin.com/in/akash-mishra-214b122a9
EDUCATION
B.Tech Computer Science
WORK EXPERIENCE
Adxania Cyber Solutions Pvt Ltd, Vadodara (Remote) Jan 2026 - Mar 2026
Software Developer Intern
`.trim();

test('deriveResumeData extracts Abhay resume profile fields', () => {
  const data = deriveResumeData(SAMPLE_TEXT);
  assert.match(data.name, /abhay/i);
  assert.equal(data.email, 'abhay.tiwari3003@gmail.com');
  assert.match(data.phone, /9997127833/);
  assert.match(data.location, /noida/i);
  assert.ok(data.summary.toLowerCase().includes('full stack'));
  assert.match(data.education, /bsc|computer science/i);
  assert.match(data.university, /ramwati|institute/i);
  assert.equal(data.gradYear, '2026');
  assert.match(data.linkedin, /linkedin\.com\/in\/abhay-tiwari/i);
  assert.ok(data.skills.includes('javascript'));
  assert.ok(data.skills.includes('react'));
  assert.ok(data.workHistory.length >= 2);
  assert.ok(data.workHistory.some((role) => /frontend developer intern/i.test(role.title)));
  assert.ok(data.workHistory.some((role) => /zentrix/i.test(role.company)));
  assert.equal(data.certifications.length, 0);
  assert.ok(data.profileScore >= 80);
});

test('extractResume parses local-docs/resume.pdf end-to-end', async () => {
  const resumePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../local-docs/resume.pdf',
  );
  const buffer = readFileSync(resumePath);
  const result = await extractResume(buffer, RESUME_MIMES.pdf);
  assert.match(result.data.name, /abhay/i);
  assert.equal(result.data.email, 'abhay.tiwari3003@gmail.com');
  assert.match(result.data.location, /noida/i);
  assert.ok(result.data.summary.length > 40);
  assert.ok(result.data.workHistory.length >= 1);
  assert.ok(result.data.profileScore >= 70);
});

test('deriveResumeData handles trainee style resume text safely', () => {
  const data = deriveResumeData(MANAS_STYLE_TEXT);
  assert.equal(data.email, 'manasmggupta@gmail.com');
  assert.ok(data.github.includes('github.com/manasgupta-14'));
  assert.ok(data.portfolio.includes('manasgupta-14.github.io'));
  assert.ok(data.workHistory.length >= 1);
  assert.ok(data.workHistory[0].title.length <= 90);
});

test('deriveResumeData does not treat degree tokens as portfolio URL', () => {
  const data = deriveResumeData(AKASH_STYLE_TEXT);
  assert.equal(data.portfolio, '');
  assert.match(data.phone, /9129424384/);
  assert.match(data.linkedin, /linkedin\.com\/in\/akash-mishra/i);
});
