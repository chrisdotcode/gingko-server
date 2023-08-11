#!/bin/bash -x

# Ensure script stops when commands fail.
set -e

# Backup & compress our database to the temp directory.
sqlite3 /home/deployer/production/data/data.sqlite "VACUUM INTO '/tmp/db-backup'"
gzip /tmp/db-backup

# Upload backup to Backblaze B2 using a rolling daily naming scheme.
# Daily backups are kept for 1 month.
# Monthly backups are kept for 1 year.
day=$(date +%d)
if [ "$day" -eq 01 ]
then
  b2 upload-file --noProgress --contentType "application/x-gzip" \
    gingkowriter-rolling-backups /tmp/db-backup.gz monthly/`date +%m`.gz
else
  b2 upload-file --noProgress --contentType "application/x-gzip" \
    gingkowriter-rolling-backups /tmp/db-backup.gz daily/`date +%d`.gz
fi

rm /tmp/db-backup
rm /tmp/db-backup.gz

# Notify dead man that back up completed successfully.
curl -d s=$? https://nosnch.in/0c1978ce6e &> /dev/null