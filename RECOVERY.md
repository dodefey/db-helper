# Recovery Guide

The executable is `dbh`. These examples assume configured environments named
`production` and `development`; use your own environment names and replace the
example backup name with one returned by `dbh backup list`.

## Create a production backup

```bash
# create a production backup before risky work
dbh backup create --from production --tag known-clean
```

## Restore a known clean backup into development

```bash
# inspect recent backups first
dbh backup list --tag known-clean
```

```bash
# restore a known clean backup into development
dbh restore full --backup 2026-03-16T10-30-00-production --to development --yes
```

## Restore a known clean backup into production safely

```bash
# inspect the backup you intend to use
dbh backup inspect --backup 2026-03-16T10-30-00-production
```

```bash
# restore into production with the extra protection flag
dbh restore full --backup 2026-03-16T10-30-00-production --to production --force-production-restore
```

Production restore triggers an automatic pre-restore production backup unless `--skip-pre-backup` is passed.

## Restore a single collection

```bash
# restore one collection from a backup
dbh restore collection --backup 2026-03-16T10-30-00-production --collection orders --to development --yes
```

## Guided recovery

```bash
# use the guided recovery flow
dbh recover
```
