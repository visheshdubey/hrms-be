CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`type` text DEFAULT 'client' NOT NULL,
	`website` text DEFAULT '',
	`description` text DEFAULT '',
	`phone` text DEFAULT '',
	`email` text DEFAULT '',
	`address` text DEFAULT '',
	`city` text DEFAULT '',
	`state` text DEFAULT '',
	`country` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `application_stage_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text DEFAULT '',
	`changed_by` integer,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`candidate_id` integer NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`notes` text DEFAULT '',
	`assigned_to` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_job_candidate` ON `applications` (`job_id`,`candidate_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`color` text DEFAULT 'blue',
	`event_type` text DEFAULT 'general',
	`candidate_id` integer,
	`candidate_name` text DEFAULT '',
	`job_profile` text DEFAULT '',
	`location` text DEFAULT '',
	`description` text DEFAULT '',
	`meeting_link` text DEFAULT '',
	`is_all_day` integer DEFAULT 0,
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'hotlist' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`subject` text DEFAULT '',
	`body` text DEFAULT '',
	`recipients_json` text DEFAULT '[]',
	`recipient_count` integer DEFAULT 0 NOT NULL,
	`scheduled_at` text DEFAULT '',
	`sent_at` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer,
	`filename` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '',
	`location` text DEFAULT '',
	`education` text DEFAULT '',
	`experience` text DEFAULT '',
	`skills` text DEFAULT '[]',
	`match_score` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'New' NOT NULL,
	`linkedin` text DEFAULT '',
	`github` text DEFAULT '',
	`portfolio` text DEFAULT '',
	`certifications` text DEFAULT '[]',
	`languages` text DEFAULT '[]',
	`summary` text DEFAULT '',
	`university` text DEFAULT '',
	`grad_year` text DEFAULT '',
	`work_history` text DEFAULT '[]',
	`fingerprint` text DEFAULT '',
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '',
	`phone` text DEFAULT '',
	`job_title` text DEFAULT '',
	`department` text DEFAULT '',
	`status` text DEFAULT 'active' NOT NULL,
	`linkedin` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_code` text NOT NULL,
	`user_id` integer,
	`candidate_id` integer,
	`application_id` integer,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '',
	`job_title` text DEFAULT '',
	`department` text DEFAULT '',
	`employment_type` text DEFAULT 'full_time' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`reporting_to_id` integer,
	`hire_date` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `interviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer,
	`submission_id` integer,
	`job_id` integer NOT NULL,
	`candidate_id` integer NOT NULL,
	`title` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata',
	`interview_stage` text DEFAULT 'round_1',
	`submission_stage` text DEFAULT 'internal',
	`status` text DEFAULT 'scheduled' NOT NULL,
	`account_name` text DEFAULT '',
	`end_client` text DEFAULT '',
	`interviewer_ids` text DEFAULT '[]',
	`duration_minutes` integer DEFAULT 60,
	`sent_on` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`department` text DEFAULT 'General' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`type` text DEFAULT 'Full-time' NOT NULL,
	`location` text DEFAULT 'Remote' NOT NULL,
	`applicants` integer DEFAULT 0 NOT NULL,
	`description` text DEFAULT '',
	`posted_date` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '',
	`type` text DEFAULT 'info',
	`is_read` integer DEFAULT 0,
	`related_id` integer,
	`related_type` text DEFAULT '',
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `onboarding_workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_code` text NOT NULL,
	`employee_id` integer,
	`candidate_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`tasks_json` text DEFAULT '[]',
	`documents_json` text DEFAULT '[]',
	`notes` text DEFAULT '',
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `org_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` integer NOT NULL,
	`website` text DEFAULT '',
	`description` text DEFAULT '',
	`contact_phone` text DEFAULT '',
	`contact_email` text DEFAULT '',
	`logo_url` text DEFAULT '',
	`favicon_url` text DEFAULT '',
	`primary_color` text DEFAULT '#2563eb',
	`billing_company` text DEFAULT '',
	`billing_address` text DEFAULT '',
	`billing_city` text DEFAULT '',
	`billing_state` text DEFAULT '',
	`billing_country` text DEFAULT '',
	`billing_zip` text DEFAULT '',
	`country` text DEFAULT 'India',
	`currency` text DEFAULT 'INR',
	`timezone` text DEFAULT 'Asia/Kolkata',
	`date_format` text DEFAULT 'DD/MM/YYYY',
	`time_format` text DEFAULT '12h',
	`email_domain` text DEFAULT '',
	`spf_record` text DEFAULT '',
	`dkim_record` text DEFAULT '',
	`dkim_verified` integer DEFAULT 0,
	`inbox_forward_email` text DEFAULT '',
	`parse_resumes` integer DEFAULT 1,
	`configurations_json` text DEFAULT '{}',
	`updated_by` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_settings_organization_id_unique` ON `org_settings` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`logo` text DEFAULT '',
	`defaults` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roles_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` integer NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '',
	`permissions_json` text DEFAULT '{}',
	`members_json` text DEFAULT '[]',
	`ip_addresses_json` text DEFAULT '[]',
	`report_ids_json` text DEFAULT '[]',
	`is_active` integer DEFAULT 1,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `saved_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'pipeline' NOT NULL,
	`filters` text DEFAULT '{}',
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer,
	`job_id` integer NOT NULL,
	`candidate_id` integer NOT NULL,
	`status` text DEFAULT 'internal_submitted' NOT NULL,
	`client_name` text DEFAULT '',
	`job_hiring_type` text DEFAULT 'Direct Client',
	`candidate_ctc_type` text DEFAULT 'annual_salary',
	`candidate_ctc` real DEFAULT 0,
	`reason_for_rejection` text DEFAULT '',
	`rejection_comments` text DEFAULT '',
	`submitted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`organization_id` integer,
	`submitted_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_code` text NOT NULL,
	`title` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`description` text DEFAULT '',
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_date` text DEFAULT '',
	`reminder_at` text DEFAULT '',
	`assigned_to` integer,
	`candidate_id` integer,
	`job_id` integer,
	`organization_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`password` text,
	`is_verified` integer DEFAULT 0,
	`role` text,
	`portal_type` text,
	`organization_id` integer,
	`avatar` text,
	`country` text DEFAULT 'australia',
	`timezone` text DEFAULT 'pst',
	`bio` text,
	`is_active` integer DEFAULT 1,
	`password_otp` text,
	`password_otp_expiry` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);