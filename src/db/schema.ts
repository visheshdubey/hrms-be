import { sqliteTable, integer, text, real, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  logo: text("logo").default(""),
  defaults: text("defaults").default("{}"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  password: text("password"),
  isVerified: integer("is_verified").default(0),
  role: text("role", {
    enum: ["recruiter_admin", "recruited_staff", "org_admin", "org_staff"],
  }),
  portalType: text("portal_type", { enum: ["org", "recruiter"] }),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const savedReports = sqliteTable("saved_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("pipeline"),
  filters: text("filters").default("{}"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  department: text("department").notNull().default("General"),
  status: text("status", {
    enum: ["new", "draft", "ready", "submission_in_progress", "closed"],
  }).notNull().default("new"),
  type: text("type", { enum: ["Full-time", "Part-time", "Contract"] }).notNull().default("Full-time"),
  location: text("location", { enum: ["Remote", "On-site", "Hybrid"] }).notNull().default("Remote"),
  applicants: integer("applicants").notNull().default(0),
  description: text("description").default(""),
  postedDate: text("posted_date").default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdBy: integer("created_by").references(() => users.id),
});

export const APP_STATUSES = [
  "applied",
  "in_review",
  "shortlisted",
  "rejected",
  "interview_scheduled",
  "hold",
  "offer",
  "no_offer",
] as const;

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id),
    candidateId: integer("candidate_id").notNull().references(() => candidates.id),
    status: text("status", { enum: APP_STATUSES }).notNull().default("applied"),
    notes: text("notes").default(""),
    assignedTo: integer("assigned_to").references(() => users.id),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    uniqueJobCandidate: unique("unique_job_candidate").on(t.jobId, t.candidateId),
  })
);

export const applicationStageHistory = sqliteTable("application_stage_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  applicationId: integer("application_id").notNull().references(() => applications.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status", { enum: APP_STATUSES }).notNull(),
  note: text("note").default(""),
  changedBy: integer("changed_by").references(() => users.id),
  changedAt: text("changed_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Submissions (candidate → client pipeline) ── */
export const SUBMISSION_STATUSES = [
  "internal_submitted",
  "client_review",
  "client_interview_scheduled",
  "client_rejected",
  "client_accepted",
  "withdrawn",
] as const;

export const submissions = sqliteTable("submissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  applicationId: integer("application_id").references(() => applications.id),
  jobId: integer("job_id").notNull().references(() => jobs.id),
  candidateId: integer("candidate_id").notNull().references(() => candidates.id),
  status: text("status", { enum: SUBMISSION_STATUSES }).notNull().default("internal_submitted"),
  clientName: text("client_name").default(""),
  jobHiringType: text("job_hiring_type").default("Direct Client"),
  candidateCtcType: text("candidate_ctc_type").default("annual_salary"),
  candidateCtc: real("candidate_ctc").default(0),
  reasonForRejection: text("reason_for_rejection").default(""),
  rejectionComments: text("rejection_comments").default(""),
  submittedAt: text("submitted_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  organizationId: integer("organization_id").references(() => organizations.id),
  submittedBy: integer("submitted_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Interviews (scheduling + feedback) ── */
export const INTERVIEW_STATUSES = [
  "scheduled",
  "completed",
  "cancelled",
  "no_show",
] as const;

export const interviews = sqliteTable("interviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  applicationId: integer("application_id").references(() => applications.id),
  submissionId: integer("submission_id").references(() => submissions.id),
  jobId: integer("job_id").notNull().references(() => jobs.id),
  candidateId: integer("candidate_id").notNull().references(() => candidates.id),
  title: text("title").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  timezone: text("timezone").default("Asia/Kolkata"),
  interviewStage: text("interview_stage").default("round_1"),
  submissionStage: text("submission_stage").default("internal"),
  status: text("status", { enum: INTERVIEW_STATUSES }).notNull().default("scheduled"),
  accountName: text("account_name").default(""),
  endClient: text("end_client").default(""),
  interviewerIds: text("interviewer_ids").default("[]"),
  durationMinutes: integer("duration_minutes").default(60),
  sentOn: text("sent_on").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const calendarEvents = sqliteTable("calendar_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  color: text("color").default("blue"),
  eventType: text("event_type").default("general"),
  candidateId: integer("candidate_id"),
  candidateName: text("candidate_name").default(""),
  jobProfile: text("job_profile").default(""),
  location: text("location").default(""),
  description: text("description").default(""),
  meetingLink: text("meeting_link").default(""),
  isAllDay: integer("is_all_day").default(0),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  body: text("body").default(""),
  type: text("type").default("info"),
  isRead: integer("is_read").default(0),
  relatedId: integer("related_id"),
  relatedType: text("related_type").default(""),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
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
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdBy: integer("created_by").references(() => users.id),
});

/* ── CRM: Accounts (client companies) ── */
export const ACCOUNT_STATUSES = ["active", "inactive", "on_hold"] as const;
export const ACCOUNT_TYPES = ["client", "client_vendor", "vendor", "prospect"] as const;

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status", { enum: ACCOUNT_STATUSES }).notNull().default("active"),
  type: text("type", { enum: ACCOUNT_TYPES }).notNull().default("client"),
  website: text("website").default(""),
  description: text("description").default(""),
  phone: text("phone").default(""),
  email: text("email").default(""),
  address: text("address").default(""),
  city: text("city").default(""),
  state: text("state").default(""),
  country: text("country").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── CRM: Contacts (people at accounts) ── */
export const CONTACT_STATUSES = ["active", "inactive"] as const;

export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull().default(""),
  email: text("email").default(""),
  phone: text("phone").default(""),
  jobTitle: text("job_title").default(""),
  department: text("department").default(""),
  status: text("status", { enum: CONTACT_STATUSES }).notNull().default("active"),
  linkedin: text("linkedin").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── HRM: Employees (post-hire master records) ── */
export const EMPLOYEE_STATUSES = ["active", "offboarded", "on_bench"] as const;
export const EMPLOYMENT_TYPES = ["full_time", "contractor", "part_time", "intern"] as const;

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employeeCode: text("employee_code").notNull(),
  userId: integer("user_id").references(() => users.id),
  candidateId: integer("candidate_id").references(() => candidates.id),
  applicationId: integer("application_id").references(() => applications.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").default(""),
  jobTitle: text("job_title").default(""),
  department: text("department").default(""),
  employmentType: text("employment_type", { enum: EMPLOYMENT_TYPES }).notNull().default("full_time"),
  status: text("status", { enum: EMPLOYEE_STATUSES }).notNull().default("active"),
  reportingToId: integer("reporting_to_id"),
  hireDate: text("hire_date").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── HRM: Onboarding workflows (tasks + documents state) ── */
export const ONBOARDING_STATUSES = [
  "draft",
  "request",
  "in_progress",
  "awaiting_confirmation",
  "completed",
  "discontinued",
  "washed_away",
  "pending_approvals",
  "profile_update",
] as const;

export const onboardingWorkflows = sqliteTable("onboarding_workflows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowCode: text("workflow_code").notNull(),
  employeeId: integer("employee_id").references(() => employees.id),
  candidateId: integer("candidate_id").references(() => candidates.id),
  status: text("status", { enum: ONBOARDING_STATUSES }).notNull().default("draft"),
  tasksJson: text("tasks_json").default("[]"),
  documentsJson: text("documents_json").default("[]"),
  notes: text("notes").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Ops: Tasks (recruiter productivity) ── */
export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export const TASK_CATEGORIES = [
  "general",
  "interview",
  "follow_up",
  "submission",
  "client_call",
  "screening",
] as const;

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskCode: text("task_code").notNull(),
  title: text("title").notNull(),
  category: text("category", { enum: TASK_CATEGORIES }).notNull().default("general"),
  description: text("description").default(""),
  priority: text("priority", { enum: TASK_PRIORITIES }).notNull().default("medium"),
  status: text("status", { enum: TASK_STATUSES }).notNull().default("pending"),
  dueDate: text("due_date").default(""),
  reminderAt: text("reminder_at").default(""),
  assignedTo: integer("assigned_to").references(() => users.id),
  candidateId: integer("candidate_id").references(() => candidates.id),
  jobId: integer("job_id").references(() => jobs.id),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Ops: Campaigns (email hotlists) ── */
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sent"] as const;
export const CAMPAIGN_TYPES = ["hotlist", "job_campaign"] as const;

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: CAMPAIGN_TYPES }).notNull().default("hotlist"),
  status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
  subject: text("subject").default(""),
  body: text("body").default(""),
  recipientsJson: text("recipients_json").default("[]"),
  recipientCount: integer("recipient_count").notNull().default(0),
  scheduledAt: text("scheduled_at").default(""),
  sentAt: text("sent_at").default(""),
  organizationId: integer("organization_id").references(() => organizations.id),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Settings: Organization profile & configurations ── */
export const orgSettings = sqliteTable("org_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: integer("organization_id").notNull().unique().references(() => organizations.id),
  website: text("website").default(""),
  description: text("description").default(""),
  contactPhone: text("contact_phone").default(""),
  contactEmail: text("contact_email").default(""),
  logoUrl: text("logo_url").default(""),
  faviconUrl: text("favicon_url").default(""),
  primaryColor: text("primary_color").default("#2563eb"),
  billingCompany: text("billing_company").default(""),
  billingAddress: text("billing_address").default(""),
  billingCity: text("billing_city").default(""),
  billingState: text("billing_state").default(""),
  billingCountry: text("billing_country").default(""),
  billingZip: text("billing_zip").default(""),
  country: text("country").default("India"),
  currency: text("currency").default("INR"),
  timezone: text("timezone").default("Asia/Kolkata"),
  dateFormat: text("date_format").default("DD/MM/YYYY"),
  timeFormat: text("time_format").default("12h"),
  emailDomain: text("email_domain").default(""),
  spfRecord: text("spf_record").default(""),
  dkimRecord: text("dkim_record").default(""),
  dkimVerified: integer("dkim_verified").default(0),
  inboxForwardEmail: text("inbox_forward_email").default(""),
  parseResumes: integer("parse_resumes").default(1),
  configurationsJson: text("configurations_json").default("{}"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/* ── Settings: Access control (teams, groups, IP, report access) ── */
export const ACCESS_CONTROL_TYPES = [
  "team",
  "user_group",
  "report_access",
  "ip_restriction",
  "security_policy",
] as const;

export const rolesPermissions = sqliteTable("roles_permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: integer("organization_id").notNull().references(() => organizations.id),
  type: text("type", { enum: ACCESS_CONTROL_TYPES }).notNull(),
  name: text("name").notNull(),
  description: text("description").default(""),
  permissionsJson: text("permissions_json").default("{}"),
  membersJson: text("members_json").default("[]"),
  ipAddressesJson: text("ip_addresses_json").default("[]"),
  reportIdsJson: text("report_ids_json").default("[]"),
  isActive: integer("is_active").default(1),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});