import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapPythonExtracted, candidateRecordForPythonScore } from './ats-python-client.js';

describe('ats-python-client mapper', () => {
  it('maps camelCase extracted payload from Python', () => {
    const data = mapPythonExtracted({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+91 9876543210',
      skills: ['Python', 'Math'],
      workHistory: [{ title: 'Engineer', company: 'Analytical', duration: '2 years' }],
      gradYear: '1842',
      profileScore: 88,
      textLength: 1200,
    }, 'full resume text');

    assert.equal(data.name, 'Ada Lovelace');
    assert.equal(data.email, 'ada@example.com');
    assert.deepEqual(data.emails, ['ada@example.com']);
    assert.deepEqual(data.skills, ['Python', 'Math']);
    assert.equal(data.workHistory[0]?.company, 'Analytical');
    assert.equal(data.gradYear, '1842');
    assert.equal(data.profileScore, 88);
    assert.equal(data.textLength, 1200);
  });

  it('maps snake_case legacy candidate fields', () => {
    const data = mapPythonExtracted({
      name: 'Alan Turing',
      email: 'alan@example.com',
      work_history: [{ title: 'Cryptographer', company: 'Bletchley', duration: '4 years' }],
      grad_year: '1938',
      missing_fields: ['phone'],
    });
    assert.equal(data.gradYear, '1938');
    assert.equal(data.workHistory[0]?.title, 'Cryptographer');
    assert.deepEqual(data.missingFields, ['phone']);
  });

  it('builds python score payload from candidate row', () => {
    const payload = candidateRecordForPythonScore({
      name: 'Test',
      email: 't@example.com',
      skills: '["Go","Redis"]',
      workHistory: '[{"title":"Dev","company":"Acme","duration":"1 year"}]',
      matchScore: 70,
    });
    assert.deepEqual(payload.skills, ['Go', 'Redis']);
    assert.equal((payload.work_history as unknown[])[0] && true, true);
    assert.equal(payload.match_score, 70);
  });
});
