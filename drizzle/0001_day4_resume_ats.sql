ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_resumes" (
  "id" serial PRIMARY KEY NOT NULL,
  "candidate_id" integer NOT NULL,
  "organization_id" integer,
  "created_by" integer NOT NULL,
  "original_filename" text NOT NULL,
  "storage_path" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "content_hash" text NOT NULL,
  "parse_status" text DEFAULT 'pending' NOT NULL,
  "parse_error" text,
  "extracted_text" text DEFAULT '',
  "extracted_data" text DEFAULT '{}',
  "created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "candidate_resumes_storage_path_unique" UNIQUE("storage_path"),
  CONSTRAINT "candidate_resumes_candidate_id_candidates_id_fk"
    FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade,
  CONSTRAINT "candidate_resumes_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade,
  CONSTRAINT "candidate_resumes_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_resumes_candidate_created_idx"
  ON "candidate_resumes" ("candidate_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_job_scores" (
  "id" serial PRIMARY KEY NOT NULL,
  "candidate_id" integer NOT NULL,
  "resume_id" integer,
  "job_id" integer NOT NULL,
  "organization_id" integer,
  "created_by" integer NOT NULL,
  "resume_hash" text NOT NULL,
  "job_hash" text NOT NULL,
  "algorithm_version" text NOT NULL,
  "total_score" real NOT NULL,
  "components" text DEFAULT '{}' NOT NULL,
  "matched_requirements" text DEFAULT '[]' NOT NULL,
  "missing_requirements" text DEFAULT '[]' NOT NULL,
  "warnings" text DEFAULT '[]' NOT NULL,
  "created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "candidate_job_score_unique" UNIQUE("candidate_id", "job_id"),
  CONSTRAINT "candidate_job_scores_candidate_id_candidates_id_fk"
    FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade,
  CONSTRAINT "candidate_job_scores_resume_id_candidate_resumes_id_fk"
    FOREIGN KEY ("resume_id") REFERENCES "public"."candidate_resumes"("id") ON DELETE set null,
  CONSTRAINT "candidate_job_scores_job_id_jobs_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade,
  CONSTRAINT "candidate_job_scores_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade,
  CONSTRAINT "candidate_job_scores_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_job_scores_job_score_idx"
  ON "candidate_job_scores" ("job_id", "total_score");
