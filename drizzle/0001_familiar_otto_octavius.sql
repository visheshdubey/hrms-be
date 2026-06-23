ALTER TABLE `candidates` ADD `source` text DEFAULT 'Internal';--> statement-breakpoint
ALTER TABLE `jobs` ADD `account_id` integer REFERENCES accounts(id);