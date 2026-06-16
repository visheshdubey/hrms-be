import { db } from './src/db/index.js';
import { jobs, candidates, users } from './src/db/schema.js';

async function seed() {
  try {
    let allUsers = await db.select().from(users);
    
    if (allUsers.length === 0) {
      console.log("No users found. Creating a test user...");
      await db.insert(users).values({
        name: 'Test Admin',
        email: 'admin@test.com',
        password: 'password123',
        isVerified: 1
      });
      allUsers = await db.select().from(users);
    }
    
    const user = allUsers[allUsers.length - 1];
    const userId = user.id;
    
    console.log(`Seeding data for user: ${user.email} (ID: ${userId})`);

    // Add jobs
    await db.insert(jobs).values({
      title: 'Senior Frontend Developer',
      department: 'Engineering',
      status: 'Ready to accept applications',
      type: 'Full-time',
      location: 'Remote',
      createdBy: userId
    });
    
    await db.insert(jobs).values({
      title: 'Backend Engineer',
      department: 'Engineering',
      status: 'Ready to accept applications',
      type: 'Full-time',
      location: 'On-site',
      createdBy: userId
    });

    // Add candidates
    await db.insert(candidates).values({
      name: 'Alice Johnson',
      email: 'alice.johnson@example.com',
      filename: 'alice_resume_2026.pdf',
      status: 'Shortlisted',
      matchScore: 92.5,
      createdBy: userId
    });

    await db.insert(candidates).values({
      name: 'Bob Smith',
      email: 'bob.smith@example.com',
      filename: 'bob_smith_cv.docx',
      status: 'Applied',
      matchScore: 78.0,
      createdBy: userId
    });
    
    await db.insert(candidates).values({
      name: 'Charlie Brown',
      email: 'charlie@example.com',
      filename: 'charlie_resume.pdf',
      status: 'Interview Scheduled',
      matchScore: 88.0,
      createdBy: userId
    });

    console.log("✅ Successfully seeded 2 jobs and 3 candidates.");
  } catch (err) {
    console.error("Failed to seed:", err);
  }
}

seed();
