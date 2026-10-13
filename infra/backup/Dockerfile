# syntax=docker/dockerfile:1
# Backup image for the Loomcast production compose project: the Postgres 17 client tools (from
# the same image as the database, so pg_dump always matches the server), the S3 command line
# client, age for encryption, and the backup scripts. Build context: this directory.
#
#   docker build -t loomcast-backup:local infra/backup
FROM postgres:17-alpine

RUN apk add --no-cache age aws-cli bash curl jq

COPY lib.sh backup.sh aws-config /usr/local/lib/loomcast-backup/
RUN cd /usr/local/lib/loomcast-backup \
  && chown -R root:root . && chmod 0755 . backup.sh && chmod 0644 lib.sh aws-config \
  && ln -s /usr/local/lib/loomcast-backup/backup.sh /usr/local/bin/backup.sh \
  # The bind-mounted host directory replaces this in production; it keeps a plain
  # `docker run` working. 0711: the api may read last-success.json but not list backups.
  && install -d -o postgres -g postgres -m 0711 /backups

ENV BACKUP_DIR=/backups \
    HOME=/tmp \
    AWS_CONFIG_FILE=/usr/local/lib/loomcast-backup/aws-config \
    AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_PAGER=""

LABEL org.opencontainers.image.source="https://github.com/theetaz/loomcast" \
      org.opencontainers.image.description="Loomcast database backups"

# The image's postgres user (uid 70). No root at run time.
USER postgres
WORKDIR /tmp

# Replace the server entry point inherited from the base image.
ENTRYPOINT []
CMD ["backup.sh", "run"]
