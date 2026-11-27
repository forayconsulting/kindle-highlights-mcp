/**
 * Commit files to the repo in one commit, through GitHub's Git Data API.
 */
const API = "https://api.github.com";

export interface RepoFile {
	path: string;
	content: string;
}

async function gh<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "kindle-highlights-mcp",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`GitHub ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`,
		);
	}
	return (await response.json()) as T;
}

/** Returns the new commit's SHA. */
export async function commitFiles(
	token: string,
	repo: string,
	branch: string,
	files: RepoFile[],
	message: string,
): Promise<string> {
	const ref = await gh<{ object: { sha: string } }>(
		token,
		"GET",
		`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
	);
	const parent = ref.object.sha;
	const parentCommit = await gh<{ tree: { sha: string } }>(
		token,
		"GET",
		`/repos/${repo}/git/commits/${parent}`,
	);
	const tree = await gh<{ sha: string }>(
		token,
		"POST",
		`/repos/${repo}/git/trees`,
		{
			base_tree: parentCommit.tree.sha,
			tree: files.map((f) => ({
				path: f.path,
				mode: "100644",
				type: "blob",
				content: f.content,
			})),
		},
	);
	if (tree.sha === parentCommit.tree.sha) return parent;
	const commit = await gh<{ sha: string }>(
		token,
		"POST",
		`/repos/${repo}/git/commits`,
		{ message, tree: tree.sha, parents: [parent] },
	);
	await gh(
		token,
		"PATCH",
		`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
		{ sha: commit.sha },
	);
	return commit.sha;
}
