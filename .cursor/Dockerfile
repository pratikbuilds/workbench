FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System toolchain plus PostgreSQL 17 and pgvector from the PGDG apt repo.
# Workbench needs a Postgres 17 with the pgvector extension available; the
# stock Ubuntu repo ships neither, so the PGDG repo is added here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
        sudo \
        git \
        build-essential \
        unzip \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-17 postgresql-17-pgvector \
    && rm -rf /var/lib/apt/lists/*

# The Cloud Agent runs as the `ubuntu` user; give it passwordless sudo so the
# per-boot start script can manage the Postgres cluster (no systemd here).
RUN if ! id ubuntu >/dev/null 2>&1; then useradd -m -s /bin/bash ubuntu; fi \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu

USER ubuntu

# Bun, pinned to the version in the repo's .bun-version. Keep these in sync.
ENV BUN_INSTALL=/home/ubuntu/.bun
ENV PATH=/home/ubuntu/.bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
