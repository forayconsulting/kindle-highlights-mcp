interface Env {
	KINDLE_KV: KVNamespace;
	OAUTH_KV: KVNamespace;
	DB: D1Database;
	MCP_OBJECT: DurableObjectNamespace;
	/** Present only when the fetch-proxy Container is enabled in wrangler.jsonc. */
	FETCH_PROXY?: DurableObjectNamespace;
	API_SECRET: string;
	/** Fine-grained token with contents read/write on GITHUB_REPO. Optional: without it, sync skips the commit. */
	GITHUB_TOKEN?: string;
	GITHUB_REPO: string;
	GITHUB_BRANCH: string;
	TIMEZONE: string;
	/** Books checked per scheduled run. */
	SYNC_BATCH_SIZE: string;
}
