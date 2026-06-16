import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { sendVerificationEmail, sendInviteEmail } from '../utils/email.js';

const auth = new Hono({ strict: false });
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
});

const inviteSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  role: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const verifySchema = z.object({
  token: z.string(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const resendSchema = z.object({
  email: z.string().email("Invalid email address"),
});

// RESEND VERIFICATION
auth.post('/resend-verification', zValidator('json', resendSchema), async (c) => {
  try {
    const { email } = c.req.valid('json');

    const user = await db.select().from(users).where(eq(users.email, email));
    if (user.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (user[0].isVerified === 1) {
      return c.json({ error: 'User is already verified' }, 400);
    }

    const verifyToken = jwt.sign({ email: user[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    const emailSent = await sendVerificationEmail(email, verifyToken);

    return c.json({ message: 'Verification email resent successfully.', emailSent }, 200);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// REGISTER (No Password)
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  try {
    const { name, email } = c.req.valid('json');

    // Check if user exists
    const existingUser = await db.select().from(users).where(eq(users.email, email));
    if (existingUser.length > 0) {
      return c.json({ error: 'User already exists' }, 400);
    }

    // Insert user without password, isVerified = 0 by default
    const newUser = await db.insert(users).values({
      name,
      email,
      password: null,
      isVerified: 0,
    }).returning({ id: users.id, name: users.name, email: users.email });

    // Generate Verify Token (valid for 24h)
    const verifyToken = jwt.sign({ email: newUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });

    // Send the real email
    const emailSent = await sendVerificationEmail(email, verifyToken);

    return c.json({ 
      message: 'User registered successfully. Please verify your email.', 
      user: newUser[0],
      emailSent
    }, 201);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// INVITE TEAM MEMBER (Protected)
auth.post('/invite', zValidator('json', inviteSchema), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const { name, email } = c.req.valid('json');
    const tokenStr = authHeader.split(' ')[1];
    const decoded = jwt.verify(tokenStr, JWT_SECRET) as { id: number; email: string };
    
    const existingUser = await db.select().from(users).where(eq(users.email, email));
    if (existingUser.length > 0) {
      return c.json({ error: 'User already exists' }, 400);
    }

    const newUser = await db.insert(users).values({
      name,
      email,
      password: null,
      isVerified: 0,
    }).returning({ id: users.id, name: users.name, email: users.email });

    const verifyToken = jwt.sign({ email: newUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    
    const inviter = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    const inviterName = inviter.length > 0 ? inviter[0].name : "A team member";

    // Send the real email
    const emailSent = await sendInviteEmail(email, inviterName, verifyToken);

    return c.json({ 
      message: 'Invitation sent successfully. They will receive an email shortly.',
      emailSent
    }, 201);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// VERIFY AND SET PASSWORD
auth.post('/verify-link', zValidator('json', verifySchema), async (c) => {
  try {
    const { token, password } = c.req.valid('json');

    // Decode token
    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; type: string };
    if (decoded.type !== 'verify') {
      return c.json({ error: 'Invalid token type' }, 400);
    }

    const user = await db.select().from(users).where(eq(users.email, decoded.email));
    if (user.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    // Hash password & Update user
    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await db.update(users).set({
      password: hashedPassword,
      isVerified: 1,
    }).where(eq(users.email, decoded.email))
    .returning({ id: users.id, name: users.name, email: users.email });

    // Generate JWT for automatic login
    const loginToken = jwt.sign({ id: updatedUser[0].id, email: updatedUser[0].email }, JWT_SECRET, { expiresIn: '1d' });

    return c.json({ message: 'Password set successfully', token: loginToken, user: updatedUser[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// LOGIN
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  try {
    const { email, password } = c.req.valid('json');

    // Find user
    const user = await db.select().from(users).where(eq(users.email, email));
    if (user.length === 0) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Check verification status
    if (user[0].isVerified === 0 || !user[0].password) {
      return c.json({ error: 'Please verify your email to set a password before logging in' }, 403);
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user[0].password);
    if (!validPassword) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Generate JWT
    const token = jwt.sign({ id: user[0].id, email: user[0].email }, JWT_SECRET, { expiresIn: '1d' });

    return c.json({ message: 'Login successful', token }, 200);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// PROTECTED ROUTE (Get my profile)
auth.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    const user = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, decoded.id));
    
    if (user.length === 0) return c.json({ error: 'User not found' }, 404);
    
    return c.json({ user: user[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

const updateSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6, "Password must be at least 6 characters").optional(),
});

// PROTECTED ROUTE (Update my profile)
auth.put('/me', zValidator('json', updateSchema), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    const { name, currentPassword, newPassword } = c.req.valid('json');
    
    const user = await db.select().from(users).where(eq(users.id, decoded.id));
    if (user.length === 0) return c.json({ error: 'User not found' }, 404);

    let passwordHash = user[0].password;
    if (currentPassword && newPassword) {
      if (!user[0].password) {
        return c.json({ error: 'No password set on this account' }, 400);
      }
      const validPassword = await bcrypt.compare(currentPassword, user[0].password);
      if (!validPassword) {
        return c.json({ error: 'Invalid current password' }, 400);
      }
      passwordHash = await bcrypt.hash(newPassword, 10);
    }

    const updatedUser = await db.update(users)
      .set({
        name: name || user[0].name,
        password: passwordHash,
      })
      .where(eq(users.id, decoded.id))
      .returning({ id: users.id, name: users.name, email: users.email });

    return c.json({ message: 'Profile updated', user: updatedUser[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

export default auth;