const http = require('http');

async function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log('\n===== HONO API AUDIT =====\n');

  // 1. Register
  const reg = await req('POST', '/auth/register', { name: 'Audit User', email: 'apitest@apto.com', password: 'password123' });
  console.log('1. REGISTER:', reg.status, JSON.stringify(reg.body));

  // 2. Login
  const login = await req('POST', '/auth/login', { email: 'apitest@apto.com', password: 'password123' });
  console.log('2. LOGIN:', login.status, JSON.stringify(login.body));
  const token = login.body?.token;
  if (!token) { console.log('No token, stopping.'); return; }

  // 3. Get /me
  const me = await req('GET', '/auth/me', null, token);
  console.log('3. /me:', me.status, JSON.stringify(me.body));

  // 4. Create job
  const job = await req('POST', '/jobs', {
    title: 'Senior React Developer', department: 'Engineering',
    status: 'Active', type: 'Full-time', location: 'Remote',
    description: '<p>We need a React expert.</p>',
  }, token);
  console.log('4. CREATE JOB:', job.status, JSON.stringify(job.body));

  // 5. List jobs
  const jobs = await req('GET', '/jobs', null, token);
  console.log('5. LIST JOBS:', jobs.status, `${jobs.body?.length ?? 0} jobs`);

  // 6. Update job
  const jobId = job.body?.id;
  if (jobId) {
    const upd = await req('PUT', `/jobs/${jobId}`, { title: 'Lead React Developer', department: 'Engineering', status: 'Active', type: 'Full-time', location: 'Remote', description: '<p>Updated.</p>' }, token);
    console.log('6. UPDATE JOB:', upd.status, JSON.stringify(upd.body));
  }

  // 7. Save candidate
  const cand = await req('POST', '/candidates', {
    filename: 'john_doe.pdf', name: 'John Doe', email: 'john@email.com',
    phone: '+91-9999999999', location: 'Mumbai', education: 'B.Tech CS',
    experience: '5 years', skills: ['React', 'TypeScript', 'Node.js'],
    match_score: 88, status: 'New',
  }, token);
  console.log('7. SAVE CANDIDATE:', cand.status, JSON.stringify(cand.body));

  // 8. List candidates
  const cands = await req('GET', '/candidates', null, token);
  console.log('8. LIST CANDIDATES:', cands.status, `${cands.body?.length ?? 0} candidates`);

  console.log('\n===== AUDIT COMPLETE =====');
}

run().catch(console.error);
