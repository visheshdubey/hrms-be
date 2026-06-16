import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const users = sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    password: text("password"),
    isVerified: integer("is_verified").default(0),
    createdAt: text("created_at").default(sql `CURRENT_TIMESTAMP`).notNull(),
});
export const jobs = sqliteTable("jobs", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    department: text("department").notNull().default("General"),
    status: text("status", { enum: ["Active", "Draft", "Closed"] }).notNull().default("Active"),
    type: text("type", { enum: ["Full-time", "Part-time", "Contract"] }).notNull().default("Full-time"),
    location: text("location", { enum: ["Remote", "On-site", "Hybrid"] }).notNull().default("Remote"),
    applicants: integer("applicants").notNull().default(0),
    description: text("description").default(""),
    postedDate: text("posted_date").default(sql `CURRENT_TIMESTAMP`).notNull(),
    createdBy: integer("created_by").references(() => users.id),
});
export const candidates = sqliteTable("candidates", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").references(() => jobs.id),
    filename: text("filename").notNull(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    phone: text("phone").default(""),
    location: text("location").default(""),
    education: text("education").default(""),
    experience: text("experience").default(""),
    skills: text("skills").default("[]"), // JSON array stored as text
    matchScore: real("match_score").notNull().default(0),
    status: text("status").notNull().default("New"),
    // New 18-layer fields
    linkedin: text("linkedin").default(""),
    github: text("github").default(""),
    portfolio: text("portfolio").default(""),
    certifications: text("certifications").default("[]"), // JSON array stored as text
    languages: text("languages").default("[]"), // JSON array stored as text
    summary: text("summary").default(""),
    university: text("university").default(""),
    gradYear: text("grad_year").default(""),
    workHistory: text("work_history").default("[]"), // JSON array stored as text
    fingerprint: text("fingerprint").default(""),
    createdAt: text("created_at").default(sql `CURRENT_TIMESTAMP`).notNull(),
    createdBy: integer("created_by").references(() => users.id),
});
