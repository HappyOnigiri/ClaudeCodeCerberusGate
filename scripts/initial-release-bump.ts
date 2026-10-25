import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface PullRequest {
  title: string;
  body: string | null;
}

// Keep the initial release consistent with ReleaseActions bump=auto, without a prior Release.
export function initialReleaseBump(prs: PullRequest[]): "minor" | "patch" | undefined {
  const changes = prs.filter((pr) => !/^release(\(.+\))?!?:/u.test(pr.title));
  if (!changes.length) return undefined;
  if (
    changes.some(
      (pr) => /^[a-z]+(\(.+\))?!:/u.test(pr.title) || /(^|\n)BREAKING CHANGE:/u.test(pr.body ?? ""),
    )
  )
    throw new Error(
      "Initial release contains a breaking change; specify major or version explicitly",
    );
  if (changes.some((pr) => /^feat(\(.+\))?:/u.test(pr.title))) return "minor";
  if (
    changes.some((pr) =>
      /^(fix|perf|refactor|chore|ci|docs|build|style|test)(\(.+\))?:/u.test(pr.title),
    )
  )
    return "patch";
  throw new Error("Cannot determine the initial bump from merged PR prefixes");
}

function mergedPullRequests(value: unknown): PullRequest[] {
  if (!Array.isArray(value)) throw new Error("Invalid PR pages response");
  const result: PullRequest[] = [];
  for (const page of value) {
    if (!Array.isArray(page)) throw new Error("Invalid PR page");
    for (const pr of page) {
      if (typeof pr !== "object" || pr === null || !("merged_at" in pr))
        throw new Error("Invalid PR response");
      if (pr.merged_at === null) continue;
      if (
        typeof pr.merged_at !== "string" ||
        !("title" in pr) ||
        typeof pr.title !== "string" ||
        !("body" in pr) ||
        (pr.body !== null && typeof pr.body !== "string")
      )
        throw new Error("Invalid merged PR response");
      result.push({ title: pr.title, body: pr.body });
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const repo = process.env.GH_REPO;
  const output = process.env.GITHUB_OUTPUT;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!repo || !output || !summary) throw new Error("Missing release workflow environment");
  const pages: unknown = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repo}/pulls?state=closed&base=main&per_page=100`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000 },
    ),
  );
  const bump = initialReleaseBump(mergedPullRequests(pages));
  if (!bump) {
    if (process.env.AUTOMATIC_RELEASE !== "true")
      throw new Error("No merged PRs for the initial release");
    appendFileSync(output, "skip=true\n");
    appendFileSync(summary, "初回リリースの対象 PR がないためスキップしました。\n");
  } else {
    appendFileSync(output, `bump=${bump}\n`);
    appendFileSync(summary, `初回リリースもマージ済み PR の規約から ${bump} を選びました。\n`);
  }
}
