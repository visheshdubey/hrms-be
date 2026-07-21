import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import authRoutes from './routes/auth.js';
import jobsRoutes from './routes/jobs.js';
import candidatesRoutes from './routes/candidates.js';
import dashboardRoutes from './routes/dashboard.js';
import applicationsRoutes from './routes/applications.js';
import calendarRoutes from './routes/calendar.js';
import notificationsRoutes from './routes/notifications.js';
import reportsRoutes from './routes/reports.js';
import sourcingRoutes from './routes/sourcing.js';
import submissionsRoutes from './routes/submissions.js';
import interviewsRoutes from './routes/interviews.js';
import accountsRoutes from './routes/accounts.js';
import contactsRoutes from './routes/contacts.js';
import employeesRoutes from './routes/employees.js';
import onboardingRoutes from './routes/onboarding.js';
import tasksRoutes from './routes/tasks.js';
import campaignsRoutes from './routes/campaigns.js';
import settingsRoutes from './routes/settings.js';
import candidateGroupsRoutes from './routes/candidateGroups.js';
import uploadsRoutes from './routes/uploads.js';
import queueRoutes from './routes/queue.js';
import { startQueueWorker } from './queue/worker.js';
import { QUEUE_CONFIG } from './queue/config.js';
import { ensureProdSchema } from './db/ensureProdSchema.js';

const app = new Hono({ strict: false });

// Middleware
const defaultOrigins = [
  'http://localhost:5173',
  'https://hrms.devcognito.tech',
  'https://hrms-be.devcognito.tech',
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : defaultOrigins;

app.use('*', cors({
  origin: allowedOrigins,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.use(
  '*',
  bodyLimit({
    // Allow multipart overhead above the largest 10MB document/resume file.
    // Individual upload routes still enforce their stricter per-file limits.
    maxSize: 12 * 1024 * 1024,
    onError: (c) => {
      return c.json({ error: 'Payload size exceeds 12MB request limit' }, 413);
    },
  })
);


// Base Route
app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'APTO Hono API running', version: '2.0' });
});

// Mount Routes (Double-mounting to handle aggressive Nginx proxy_pass stripping)
app.route('/auth', authRoutes);
app.route('/api/hono/auth', authRoutes);
app.route('/jobs', jobsRoutes);
app.route('/api/hono/jobs', jobsRoutes);
app.route('/candidates', candidatesRoutes);
app.route('/api/hono/candidates', candidatesRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/api/hono/dashboard', dashboardRoutes);
app.route('/applications', applicationsRoutes);
app.route('/api/hono/applications', applicationsRoutes);
app.route('/calendar', calendarRoutes);
app.route('/api/hono/calendar', calendarRoutes);
app.route('/notifications', notificationsRoutes);
app.route('/api/hono/notifications', notificationsRoutes);
app.route('/reports', reportsRoutes);
app.route('/api/hono/reports', reportsRoutes);
app.route('/sourcing', sourcingRoutes);
app.route('/api/hono/sourcing', sourcingRoutes);
app.route('/submissions', submissionsRoutes);
app.route('/api/hono/submissions', submissionsRoutes);
app.route('/interviews', interviewsRoutes);
app.route('/api/hono/interviews', interviewsRoutes);
app.route('/accounts', accountsRoutes);
app.route('/api/hono/accounts', accountsRoutes);
app.route('/contacts', contactsRoutes);
app.route('/api/hono/contacts', contactsRoutes);
app.route('/employees', employeesRoutes);
app.route('/api/hono/employees', employeesRoutes);
app.route('/onboarding', onboardingRoutes);
app.route('/api/hono/onboarding', onboardingRoutes);
app.route('/tasks', tasksRoutes);
app.route('/api/hono/tasks', tasksRoutes);
app.route('/campaigns', campaignsRoutes);
app.route('/api/hono/campaigns', campaignsRoutes);
app.route('/settings', settingsRoutes);
app.route('/api/hono/settings', settingsRoutes);
app.route('/candidate-groups', candidateGroupsRoutes);
app.route('/api/hono/candidate-groups', candidateGroupsRoutes);
app.route('/uploads', uploadsRoutes);
app.route('/api/hono/uploads', uploadsRoutes);
app.route('/queue', queueRoutes);
app.route('/api/hono/queue', queueRoutes);

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

async function boot() {
  // Bind HTTP immediately so deploy health checks (nginx / CircleCI) do not race
  // against schema migrations on cold start.
  console.log(`✅ Server is running on port ${port}`);
  serve({ fetch: app.fetch, port });

  try {
    await ensureProdSchema();
  } catch (error) {
    console.error('[boot] ensureProdSchema failed (continuing):', error);
  }

  if (QUEUE_CONFIG.enableWorker) {
    void startQueueWorker();
  }
}

void boot();
