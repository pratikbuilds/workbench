#!/usr/bin/env bash
# Per-boot reconciliation: bring up the local Postgres the hub talks to and
# make sure a .env exists. Idempotent and safe to re-run; it must return so
# the `dev` terminal can start afterwards.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# There is no systemd in the Cloud Agent VM, so the cluster is managed
# directly. Recreate it only if the image never had one.
if [ ! -d /var/lib/postgresql/17/main ]; then
    sudo pg_createcluster 17 main
fi
sudo install -d -o postgres -g postgres /var/run/postgresql
sudo pg_ctlcluster 17 main start || true

for _ in $(seq 1 30); do
    if sudo -u postgres pg_isready -q; then
        break
    fi
    sleep 1
done

# Match the credentials the repo's docker-compose.test.yml / CI use, and
# allow password auth over loopback so postgres://postgres:postgres@localhost
# connects.
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'postgres';" >/dev/null
hba=/etc/postgresql/17/main/pg_hba.conf
grep -q '127.0.0.1/32 md5' "$hba" || echo 'host all all 127.0.0.1/32 md5' | sudo tee -a "$hba" >/dev/null
grep -q '::1/128 md5' "$hba" || echo 'host all all ::1/128 md5' | sudo tee -a "$hba" >/dev/null
sudo pg_ctlcluster 17 main reload || true

# Seed .env from the tracked template on first boot, pointing DATABASE_URL at
# the local Postgres. Never clobber an existing .env.
if [ ! -f .env ]; then
    cp .env.example .env
    sed -i 's#^DATABASE_URL=.*#DATABASE_URL=postgres://postgres:postgres@localhost:5432/workbench#' .env
fi
