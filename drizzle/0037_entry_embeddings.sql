CREATE TABLE "entry_embeddings" (
	"entry_id" bigint NOT NULL,
	"model" text NOT NULL,
	"dim" integer NOT NULL,
	"embedding" vector(768) NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_embeddings_entry_id_model_pk" PRIMARY KEY("entry_id","model"),
	CONSTRAINT "entry_embeddings_dim_check" CHECK ("entry_embeddings"."dim" = 768)
);
--> statement-breakpoint
ALTER TABLE "entry_embeddings" ADD CONSTRAINT "entry_embeddings_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_embeddings_embedding_idx" ON "entry_embeddings" USING hnsw ("embedding" vector_cosine_ops);