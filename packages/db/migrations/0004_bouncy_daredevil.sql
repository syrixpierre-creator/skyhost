ALTER TABLE "services" ADD COLUMN "domain_label" text;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_domain_label_unique" UNIQUE("domain_label");