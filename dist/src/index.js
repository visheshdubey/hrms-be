import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import authRoutes from './routes/auth.js';
import jobsRoutes from './routes/jobs.js';
import candidatesRoutes from './routes/candidates.js';
import dashboardRoutes from './routes/dashboard.js';
const app = new Hono({ strict: false });
// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://147.93.18.45', 'http://localhost:5173', 'https://devcognito.tech'];
app.use('*', cors({
    origin: allowedOrigins,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
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
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`✅ Server is running on port ${port}`);
serve({ fetch: app.fetch, port });
