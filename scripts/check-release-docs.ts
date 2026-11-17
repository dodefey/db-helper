import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8"));
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Excludes only the review record itself, avoiding a self-referential digest. */
export async function candidateFingerprint(
  root: string,
  record: string
): Promise<string> {
  const files = [
    ...new Set(
      git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean)
    )
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) {
    if (file === record) continue;
    const location = path.join(root, file);
    let stat;
    try {
      stat = await lstat(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const data = stat.isSymbolicLink()
      ? await readlink(location)
      : execFileSync("git", ["hash-object", `--path=${file}`, "--stdin"], {
          cwd: root,
          input: await readFile(location),
          stdio: ["pipe", "pipe", "pipe"]
        })
          .toString()
          .trim();
    hash.update(
      JSON.stringify([
        file,
        stat.isSymbolicLink() ? "link" : "file",
        createHash("sha256").update(data).digest("hex")
      ])
    );
  }
  return hash.digest("hex");
}

function headings(markdown: string): Set<string> {
  const used = new Set<string>();
  const clean = markdown.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
  for (const match of clean.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replaceAll(" ", "-");
    let unique = slug,
      index = 0;
    while (used.has(unique)) unique = `${slug}-${++index}`;
    used.add(unique);
  }
  return used;
}

export async function checkLocalLinks(
  root: string,
  files: string[],
  repository: string,
  version: string
): Promise<void> {
  for (const file of files) {
    const source = (await readFile(path.join(root, file), "utf8")).replace(
      /^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm,
      ""
    );
    const links = [
      ...source.matchAll(/\]\(([^)]+)\)|^\s*\[[^\]]+\]:\s*(\S+)/gm)
    ];
    for (const match of links) {
      let target = (match[1] ?? match[2])
        .trim()
        .replace(/^<([^>]+)>.*$/, "$1")
        .replace(/\s+["'].*$/, "");
      const hosted = `${repository}/blob/v${version}/`;
      let base = path.dirname(file);
      if (target.startsWith(hosted)) {
        target = target.slice(hosted.length);
        base = ".";
      } else if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const [name, anchor] = target.split("#");
      const location = name
        ? path.resolve(root, base, decodeURIComponent(name))
        : path.resolve(root, file);
      requireValue(
        location === root || location.startsWith(`${root}${path.sep}`),
        `Link escapes repository in ${file}: ${target}`
      );
      const stat = await lstat(location).catch(() => null);
      requireValue(stat, `Broken local link in ${file}: ${target}`);
      if (anchor && location.endsWith(".md"))
        requireValue(
          headings(await readFile(location, "utf8")).has(
            decodeURIComponent(anchor)
          ),
          `Broken anchor in ${file}: ${target}`
        );
    }
  }
}

export async function checkReleaseDocs(
  root: string,
  ifRelease = false
): Promise<"passed" | "not-release"> {
  root = path.resolve(root);
  const pkg = await json(path.join(root, "package.json"));
  const version = pkg.version;
  requireValue(
    typeof version === "string" &&
      /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version),
    "Invalid package version."
  );
  if (ifRelease) {
    const latest = git(
      root,
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      "v[0-9]*"
    );
    const released = JSON.parse(git(root, "show", `${latest}:package.json`));
    if (released.version === version) return "not-release";
  }
  const notesPath = `docs/releases/${version}.md`;
  const recordPath = `docs/releases/${version}.review.json`;
  const lock = await json(path.join(root, "package-lock.json"));
  const packages = lock.packages as Record<string, { version: string }>;
  requireValue(
    lock.version === version && packages?.[""]?.version === version,
    "Package/lockfile versions differ."
  );
  const source = await readFile(path.join(root, "src/version.ts"), "utf8");
  requireValue(
    source.match(/TOOL_VERSION\s*=\s*["']([^"']+)["']/)?.[1] === version,
    "CLI version differs from package version."
  );
  const changelog = (
    await readFile(path.join(root, "CHANGELOG.md"), "utf8")
  ).replaceAll("\r\n", "\n");
  const section = changelog.split(`## ${version}\n`)[1]?.split(/\n## /)[0];
  requireValue(
    section?.trim(),
    `Missing or empty changelog section for ${version}.`
  );
  const unreleased =
    changelog.split("## Unreleased\n")[1]?.split(/\n## /)[0] ?? "";
  const entries = (body: string) =>
    [...body.matchAll(/^[-*+]\s+(.+(?:\n(?!\s*(?:[-*+]\s|#|$)).+)*)/gm)].map(
      (match) => match[1].replace(/\s+/g, " ").trim()
    );
  const shipped = new Set(entries(section!));
  requireValue(
    !entries(unreleased).some((entry) => shipped.has(entry)),
    "Shipped changelog entries remain under Unreleased."
  );
  const notes = (await readFile(path.join(root, notesPath), "utf8")).replaceAll(
    "\r\n",
    "\n"
  );
  for (const heading of [
    "Changes",
    "Safety and compatibility",
    "Install and verify",
    "Documentation"
  ]) {
    const section = notes.split(`## ${heading}\n`)[1]?.split(/\n## /)[0];
    requireValue(
      section?.trim(),
      `Missing or empty release notes section: ${heading}`
    );
  }
  const review = await json(path.join(root, recordPath));
  requireValue(
    review.version === version &&
      review.result === "pass" &&
      text(review.reviewer),
    "Review requires matching version, reviewer, and pass result."
  );
  requireValue(
    review.editorial === "pass" &&
      Array.isArray(review.openFindings) &&
      review.openFindings.length === 0,
    "Editorial review must pass with no open findings."
  );
  requireValue(
    typeof review.previousTag === "string" &&
      /^v\d+\.\d+\.\d+[\da-z.+-]*$/i.test(review.previousTag) &&
      review.previousTag !== `v${version}`,
    "Review requires the previous release tag."
  );
  git(
    root,
    "merge-base",
    "--is-ancestor",
    `${review.previousTag}^{commit}`,
    "HEAD"
  );
  const previousTag = git(
    root,
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v[0-9]*",
    "--exclude",
    `v${version}`
  );
  requireValue(
    review.previousTag === previousTag,
    "Review must name the nearest previous release tag."
  );
  const surfaces = review.surfaces as Record<
    string,
    { status: string; evidence: string }
  >;
  for (const key of [
    "readme",
    "commands",
    "changelog",
    "releaseNotes",
    "github",
    "package"
  ]) {
    const surface = surfaces?.[key];
    requireValue(
      surface &&
        ["reviewed", "not-applicable"].includes(surface.status) &&
        text(surface.evidence),
      `Missing review evidence for ${key}.`
    );
    if (["readme", "changelog", "releaseNotes"].includes(key))
      requireValue(
        surface.status === "reviewed",
        `${key} cannot be excluded from review.`
      );
  }
  requireValue(
    review.contentSha256 === (await candidateFingerprint(root, recordPath)),
    "Review fingerprint is stale; review the candidate again."
  );
  const repo = pkg.repository as { url: string };
  const repository = repo.url.replace(/^git\+/, "").replace(/\.git$/, "");
  for (const link of [
    `${repository}/blob/v${version}/README.md`,
    `${repository}/blob/v${version}/CHANGELOG.md`,
    `${repository}/compare/${review.previousTag}...v${version}`
  ])
    requireValue(
      notes.includes(link),
      `Missing release documentation link: ${link}`
    );
  const changed = git(
    root,
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    review.previousTag,
    "--",
    "*.md"
  ).split("\n");
  const added = git(
    root,
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "*.md"
  ).split("\n");
  await checkLocalLinks(
    root,
    [
      ...new Set(
        ["README.md", "RECOVERY.md", notesPath, ...changed, ...added].filter(
          Boolean
        )
      )
    ],
    repository,
    version
  );
  return "passed";
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.cwd();
  const args = process.argv.slice(2);
  try {
    requireValue(
      args.every((arg) => ["--if-release", "--fingerprint"].includes(arg)) &&
        args.length <= 1,
      "Use --if-release or --fingerprint, or no flags for a strict release check."
    );
    if (args.includes("--fingerprint")) {
      const pkg = await json(path.join(root, "package.json"));
      requireValue(
        typeof pkg.version === "string" && /^[\da-z.+-]+$/i.test(pkg.version),
        "Invalid package version."
      );
      process.stdout.write(
        `${await candidateFingerprint(root, `docs/releases/${pkg.version}.review.json`)}\n`
      );
    } else {
      const result = await checkReleaseDocs(
        root,
        args.includes("--if-release")
      );
      process.stdout.write(
        result === "passed"
          ? "Release documentation checks passed.\n"
          : "Release documentation check: already-released version; no new release candidate.\n"
      );
    }
  } catch (error) {
    process.stderr.write(
      `Release documentation check failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
