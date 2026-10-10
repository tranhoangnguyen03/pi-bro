import { execFile } from "node:child_process";
import { mkdir, access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type ReviewTarget = {
	host: string;
	repository: string;
	repositoryId: number;
	number: number;
	title: string;
	body: string;
	url: string;
	base: string;
	head: string;
	baseRef: string;
	headRef: string;
};
export type ReviewSnapshot = {
	target: ReviewTarget;
	mergeBase: string;
	gitDir: string;
	checkout: string;
	capturedAt: string;
	files: { path: string; status: string }[];
	diff: string;
};

export function reviewCommand(
	command: string,
	args: string[],
	signal?: AbortSignal,
	cwd?: string,
	timeout = 120_000,
): Promise<string> {
	const env = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
	};
	for (const key of Object.keys(env))
		if (
			key.startsWith("GIT_") &&
			!["GIT_TERMINAL_PROMPT", "GIT_LFS_SKIP_SMUDGE", "GIT_NO_REPLACE_OBJECTS"].includes(key)
		)
			delete (env as Record<string, string | undefined>)[key];
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ cwd, env, signal, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${command}: ${stderr.trim() || error.message}`));
				else resolve(stdout);
			},
		);
	});
}

export async function resolveReviewTarget(
	value: string,
	cwd: string,
	signal: AbortSignal,
): Promise<ReviewTarget> {
	value = value.trim();
	const match =
		/^https:\/\/([a-zA-Z0-9.-]+)\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/.exec(
			value.trim(),
		);
	if (!match && !/^[1-9]\d*$/.test(value))
		throw Error(
			"Use /bro guided-review <PR number or GitHub PR URL>. Discovery and branch review are not supported.",
		);
	let host = match?.[1] ?? "github.com";
	let repository = match?.[2];
	if (!repository) {
		const current = JSON.parse(
			await reviewCommand("gh", ["repo", "view", "--json", "nameWithOwner,url"], signal, cwd),
		);
		repository = current.nameWithOwner;
		host = new URL(current.url).hostname;
	}
	const number = Number(match?.[3] ?? value);
	const data = JSON.parse(
		await reviewCommand(
			"gh",
			["api", "--hostname", host, `repos/${repository}/pulls/${number}`],
			signal,
			cwd,
		),
	);
	if (
		!data.base?.repo?.id ||
		!/^[a-f0-9]{40,64}$/.test(data.base.sha) ||
		!/^[a-f0-9]{40,64}$/.test(data.head?.sha)
	)
		throw Error("GitHub returned incomplete PR identity.");
	return {
		host,
		repository: data.base.repo.full_name,
		repositoryId: data.base.repo.id,
		number,
		title: data.title,
		body: data.body ?? "",
		url: data.html_url,
		base: data.base.sha,
		head: data.head.sha,
		baseRef: data.base.ref,
		headRef: data.head.ref,
	};
}

export async function captureReview(
	target: ReviewTarget,
	root: string,
	signal: AbortSignal,
	localSource?: string,
): Promise<ReviewSnapshot> {
	for (const sha of [target.base, target.head])
		if (!/^[a-f0-9]{40,64}$/.test(sha)) throw Error("Invalid captured revision.");
	const key = createHash("sha256")
		.update(`${target.host}/${target.repositoryId}/${target.number}`)
		.digest("hex");
	const directory = join(root, "source", key);
	const gitDir = join(directory, "objects.git");
	const checkout = join(directory, target.head);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const hooks = join(directory, "empty-hooks");
	await mkdir(hooks, { recursive: true });
	const git = (...args: string[]) =>
		reviewCommand(
			"git",
			[
				"--git-dir",
				gitDir,
				"-c",
				`core.hooksPath=${hooks}`,
				"-c",
				"credential.helper=",
				"-c",
				"credential.helper=!gh auth git-credential",
				...args,
			],
			signal,
		);
	try {
		await access(join(gitDir, "HEAD"));
	} catch {
		await reviewCommand("git", ["init", "--bare", gitDir], signal);
	}
	const remote = localSource ?? `https://${target.host}/${target.repository}.git`;
	// Resolve ancestry before shallow capture; shallow merge-base can silently choose the wrong ancestor.
	const mergeBase = localSource
		? (
				await reviewCommand(
					"git",
					["-C", localSource, "merge-base", target.base, target.head],
					signal,
				)
			).trim()
		: (
				await reviewCommand(
					"gh",
					[
						"api",
						"--hostname",
						target.host,
						`repos/${target.repository}/compare/${target.base}...${target.head}`,
						"--jq",
						".merge_base_commit.sha",
					],
					signal,
				)
			).trim();
	if (!/^[a-f0-9]{40,64}$/.test(mergeBase))
		throw Error("GitHub returned an invalid merge base; capture was not continued.");
	await reviewCommand(
		"git",
		[
			"--git-dir",
			gitDir,
			"-c",
			`core.hooksPath=${hooks}`,
			"-c",
			"credential.helper=",
			"-c",
			"credential.helper=!gh auth git-credential",
			"fetch",
			"--depth=1",
			"--no-tags",
			"--no-recurse-submodules",
			remote,
			`${mergeBase}:refs/bro/base/${mergeBase}`,
			`${target.head}:refs/bro/head/${target.head}`,
		],
		signal,
		undefined,
		600_000,
	);
	const names = (
		await git(
			"diff",
			"--name-status",
			"-z",
			"--no-renames",
			"--ignore-submodules=none",
			mergeBase,
			target.head,
			"--",
		)
	).split("\0");
	const files: ReviewSnapshot["files"] = [];
	for (let i = 0; i + 1 < names.length; i += 2)
		files.push({ status: names[i]!, path: names[i + 1]! });
	const diff = await git(
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-color",
		"--no-renames",
		"--submodule=short",
		"--ignore-submodules=none",
		mergeBase,
		target.head,
		"--",
	);
	const ready = checkout + ".ready";
	let reusable = false;
	try {
		await access(join(checkout, ".git"));
		const head = (await reviewCommand("git", ["-C", checkout, "rev-parse", "HEAD"], signal)).trim();
		if (head === target.head) {
			const completed = await readFile(ready, "utf8").catch((error) => {
				if (error.code === "ENOENT") return "";
				throw error;
			});
			// Only explicitly completed, clean captures can be reused.
			reusable =
				completed === target.head &&
				(
					await reviewCommand(
						"git",
						["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
						signal,
					)
				).trim() === "";
		}
	} catch {
		signal.throwIfAborted();
	}
	if (!reusable) {
		signal.throwIfAborted();
		await rm(ready, { force: true });
		const recovered = checkout + ".incomplete-" + randomUUID();
		try {
			await rename(checkout, recovered);
			// Preserve interrupted files, including any local edits, rather than deleting them.
			try {
				await access(join(recovered, ".git"));
				await git("worktree", "repair", recovered);
			} catch {
				signal.throwIfAborted();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await git("worktree", "prune", "--expire", "now");
		await git("worktree", "add", "--detach", checkout, target.head);
		const head = (await reviewCommand("git", ["-C", checkout, "rev-parse", "HEAD"], signal)).trim();
		const changes = await reviewCommand("git", ["-C", checkout, "status", "--porcelain"], signal);
		if (head !== target.head || changes.trim())
			throw Error("Captured checkout is incomplete; retry capture.");
	}
	signal.throwIfAborted();
	await writeFile(ready, target.head, { mode: 0o600 });
	return { target, mergeBase, gitDir, checkout, capturedAt: new Date().toISOString(), files, diff };
}

export async function readEvidence(
	snapshot: ReviewSnapshot,
	path: string,
	side: "old" | "new",
	signal?: AbortSignal,
): Promise<string> {
	if (!path || path.startsWith("/") || path.split("/").includes("..") || /[\0\r\n]/.test(path))
		throw Error("Invalid evidence path.");
	const revision = side === "old" ? snapshot.mergeBase : snapshot.target.head;
	const source = await reviewCommand(
		"git",
		["--git-dir", snapshot.gitDir, "cat-file", "blob", `${revision}:${path}`],
		signal,
	);
	if (source.includes("\0")) throw Error("Binary evidence is not available as source text.");
	return source;
}
