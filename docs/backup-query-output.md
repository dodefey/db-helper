# Backup Query Output, Schema Version 1

This contract applies to `dbh backup list --json` and `dbh backup usage --json`.
Both are local queries. They do not contact MongoDB or SSH, inspect archive
contents, create configured directories, or delete backup artifacts. Diagnostic
logs are written directly into the OS temporary directory.

## Common Envelope

| Field           | Type           | Meaning                                                                                                                               |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | number         | Currently `1`; incompatible contract changes require a new version                                                                    |
| `command`       | string         | `backup.list` or `backup.usage`                                                                                                       |
| `observedAt`    | UTC ISO string | Time collection finished; the scan is not an atomic snapshot                                                                          |
| `status`        | string         | `ok`, `partial`, or `error`                                                                                                           |
| `data`          | object or null | Command-specific result; null for argument/config/unexpected failures                                                                 |
| `issues`        | array          | `{ code, path, message, systemCode }`; path is an absolute string or null, systemCode is the underlying filesystem error code or null |
| `debugLogPath`  | string or null | Retained diagnostic log, present with `--log` or non-ok results                                                                       |

Stdout contains exactly one JSON document, including on failure. Diagnostic log
notifications go to stderr. `--quiet` and `--verbose` do not change the JSON
document's shape; they remain mutually exclusive. JSON is supported only on
list/usage, takes no value, and cannot be combined with help/version. Unknown
flags, missing flag values, and unexpected positional arguments are errors.

Exit status:

- `0`: collection completed without issues. This does not promise archive integrity.
- `2`: useful results remain, but entries or measurements have issues.
- `1`: backup root enumeration failed, both capacity locations failed, or an
  argument/config/unexpected command failure occurred.

Consumers must inspect fields rather than parse human messages, tolerate unknown
additive fields and issue codes, and check exit status. Per-entry filesystem
changes during a query are reported as observed failures; results do not reserve
storage or lock artifacts.

## List Data

| Field                 | Type    | Meaning                                                                                |
| --------------------- | ------- | -------------------------------------------------------------------------------------- |
| `backupRoot`          | object  | Absolute `path` and `status`: `available`, `missing`, `not-directory`, or `unreadable` |
| `filters`             | object  | `from` and `tag`, each a string or null                                                |
| `backups`             | array   | Observed directory and symlink entries, described below                                |
| `knownAllocatedBytes` | number  | Sum of measured allocations for returned entries only                                  |
| `allocationComplete`  | boolean | False if root enumeration or any returned allocation measurement failed                |

Regular files directly under the root are outside the backup-directory catalog.
A missing root is an error; an existing empty root is an ok result with no
backups. Valid manifests sort newest first using normalized UTC timestamps;
entries without valid metadata sort last by name, with name breaking date ties.

Each backup entry contains:

- `name`: directory entry name; use this identifier for inspect/restore only if
  it satisfies normal backup-name rules.
- `path`: absolute path.
- `manifest`: validated known backup metadata or null. Contains `backupName`,
  `sourceEnvironment`, `databaseName`, `createdAt` normalized to UTC, `tags` as an
  array, `collectionList` as an array, `toolVersion`, `archiveFile`, and optional
  `note`, `collectionCounts`, and `collectionSizes`. Unknown stored fields are
  not part of the public projection. Manifests are not modified on disk.
- `manifestStatus`: `valid`, `missing`, `invalid`, `unreadable`, `symlink`, or
  `not-inspected`. Valid metadata must match the directory identity and use
  the supported `dump.archive.gz` artifact name.
- `matchesFilters`: true for matching valid metadata; null when metadata cannot
  establish a match. Known nonmatches are excluded. Unclassifiable entries remain
  visible even with filters, and the report is partial. `--from` accepts a
  configured environment, consistent with the CLI's existing environment rules.
- `archive`: absolute `path`, `status`, `sizeBytes`, and `verification`.
  Status is `present`, `missing`, `empty`, `not-file`, `unreadable`, `symlink`, or
  `not-inspected`. Size is the regular archive file's logical byte length, or null
  when unavailable. `present` only means a nonempty regular file was observed;
  contents were not read. `verification` is always `not-performed` in version 1.
- `diskUsage`: `status` (`measured` or `unavailable`) and `allocatedBytes` (number
  or null). This is filesystem allocation for the whole directory, not the
  archive's logical length. Directory allocation and symlink entries are counted;
  symlink targets are not traversed. Hard links are counted once within an entry.

An explicitly configured root symlink is supported. Child backup, manifest, and
archive symlinks are reported without inspecting their targets. Incomplete
directories are observations, not proof that a writer has failed or stopped.

Allocation can include blocks shared by separate backups or copy-on-write clones.
The total is not a guaranteed reclaimable-space estimate. `allocationComplete`
only concerns measuring the returned entries, not manifest or archive validity.

## Usage Data

`locations` contains two entries, in `backupRoot`, `tempRoot` order. The temp root
is the local configured path, even when other operations also use that path on
remote hosts. No remote capacity is queried.

Each entry contains `kind`, absolute `path`, `status` (`available`, `missing`,
`not-directory`, or `unavailable`), and `filesystem` (object or null).

Filesystem fields:

- `id`: device identifier as a string, for comparison within this observation.
- `totalBytes`: `statfs.blocks * statfs.bsize`.
- `freeBytes`: `statfs.bfree * statfs.bsize`, including space reserved from ordinary users.
- `availableBytes`: `statfs.bavail * statfs.bsize`, available to ordinary users.

`sharedFilesystem` is true when both locations have equal filesystem IDs, false
when IDs differ, or null if either measurement failed. Capacity is never summed.
Distinct filesystems can still share an underlying storage pool; this report does
not determine storage-pool topology. Available space is an observation, not an
estimate of a future backup's required space or a reservation.

Text output shows each location's available space and capacity in binary units.
`--verbose` adds filesystem IDs and exact available/free bytes. `--quiet` emits
two tab-separated rows: kind, path, status, filesystem ID, total bytes, available
bytes, free bytes. Unavailable measurements use `unknown` in text and null in JSON.

## Issue Codes

- `ROOT_MISSING`, `ROOT_NOT_DIRECTORY`, `ROOT_UNREADABLE`: cannot enumerate backup root.
- `INVALID_BACKUP_NAME`: observed directory cannot be used as a normal backup identifier.
- `MANIFEST_MISSING`, `MANIFEST_INVALID`, `MANIFEST_UNREADABLE`: metadata could not be established.
- `ARCHIVE_MISSING`, `ARCHIVE_EMPTY`, `ARCHIVE_NOT_FILE`, `ARCHIVE_UNREADABLE`: archive metadata issue.
- `SYMLINK_NOT_FOLLOWED`: backup or artifact is a symlink; target was not inspected.
- `DISK_USAGE_UNAVAILABLE`: allocated-byte measurement failed; no partial directory total is presented as complete.
- `FILESYSTEM_UNAVAILABLE`: capacity failed; location status describes missing/not-directory/unavailable.
- `INVALID_ARGUMENTS`, `CONFIG_ERROR`, `COMMAND_FAILED`: fatal command-level failures.
