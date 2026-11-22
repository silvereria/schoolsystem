# Ntake School Management System - Production Installation

This guide covers the supported static SPA + PHP API + MySQL/MariaDB
deployment. cPanel-specific instructions are in
[docs/cpanel-deployment.md](docs/cpanel-deployment.md).

## Prerequisites

| Component | Supported baseline | Purpose |
|---|---|---|
| Node.js | 22 LTS | Frontend build and test tooling |
| npm | npm supplied with Node | Dependency and lockfile management |
| PHP | 8.1+ | API and CLI workers |
| PHP extensions | pdo_mysql, openssl, curl, mbstring, fileinfo | Database, encryption, HTTP, text, uploads |
| MySQL/MariaDB | MySQL 8 or MariaDB 10.4.32+ | Application database |
| TLS | Valid certificate | HTTPS-only browser/API traffic |
| Composer | Provided `composer.phar` or host Composer | PHP dependencies |
| Database clients | `mysqldump`, `mysql` | Verified backup and restore |

Use separate staging and production hostnames, builds, databases, credentials,
keys, upload directories, and backup directories. Do not copy live data into
staging. Development mock mode is never available in production builds.

## 1. Prepare private configuration

Create private directories outside the document root:

```text
/home/<account>/private/ntake/uploads
/home/<account>/private/ntake/backups
/home/<account>/private/ntake/logs
```

Restrict directories to `0700` and configuration files to `0600`. Store:

- runtime database credentials;
- migration database credentials;
- backup and TOTP encryption keys;
- password blocklist;
- SMS credentials;
- cron secrets;
- private upload path.

Example public build variables:

```env
VITE_DATA_SOURCE=api
VITE_API_BASE_URL=https://school.example/backend/api
```

Example server-side variables:

```env
APP_ENV=production
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=ntake_sms
DB_USER=<least-privilege-runtime-account>
DB_PASS=<strong-secret>

UPLOADS_DIR=/absolute/private/path/uploads
PASSWORD_BLOCKLIST_FILE=/absolute/private/path/common-passwords.txt
TOTP_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
BACKUP_STORAGE_DIR=/absolute/private/path/backups
BACKUP_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
BACKUP_RETENTION_DAYS=30
MYSQLDUMP_PATH=/absolute/path/mysqldump
MYSQL_PATH=/absolute/path/mysql

SMS_PROVIDER=africas_talking
SMS_API_URL=https://api.africastalking.com/version1/messaging
SMS_API_KEY=<secret>
SMS_USERNAME=<secret>
SMS_SENDER_ID=NTAKE_SS
CRON_SECRET=<random-secret>
ALLOWED_ORIGINS=https://school.example
```

Never put the password blocklist, database password, TOTP key, backup key,
SMS API key, or cron secret in `VITE_*`, source control, `.env` under the web
root, URLs, or process arguments.

Generate keys:

```powershell
php -r "echo base64_encode(random_bytes(32)), PHP_EOL;"
```

## 2. Provision least-privilege database users

Create a runtime account and migration account. The runtime account should
have application DML privileges and no DDL privilege. The migration account
is CLI-only and should not be available to PHP-FPM. Audit logs require special
review:

```sql
REVOKE UPDATE, DELETE ON *.* FROM '<runtime-user>'@'<runtime-host>';
REVOKE UPDATE, DELETE ON `ntake_sms`.* FROM '<runtime-user>'@'<runtime-host>';
GRANT SELECT, INSERT ON `ntake_sms`.`audit_logs`
  TO '<runtime-user>'@'<runtime-host>';
```

Validate effective privileges after grants are changed:

```powershell
php backend/bin/check-audit-grants.php
```

## 3. Install dependencies and build

```powershell
npm ci
php -d extension=zip backend/composer.phar install `
  --working-dir=backend --no-interaction --prefer-dist

$env:VITE_DATA_SOURCE = 'api'
$env:VITE_API_BASE_URL = 'https://school.example/backend/api'
npm run build
```

Deploy only `dist/` and required `backend/` runtime files and vendor
dependencies. Do not deploy `node_modules/`, `.env`, source maps, logs, local
backups, or test fixtures.

## 4. Apply migrations and create the first administrator

Run migration and installer commands only from a protected CLI environment:

```powershell
$env:APP_ENV = 'production'
$env:DB_HOST = '<migration-host>'
$env:DB_PORT = '3306'
$env:DB_NAME = 'ntake_sms'
$env:DB_USER = '<migration-account>'
$env:DB_PASS = '<migration-password>'
php backend/bin/migrate.php status
php backend/bin/migrate.php migrate
php backend/bin/migrate.php verify

$env:INSTALL_ADMIN_USERNAME = '<approved-admin>'
$env:INSTALL_ADMIN_EMAIL = '<approved-email>'
$env:INSTALL_ADMIN_PASSWORD = '<unique-strong-password>'
$env:INSTALL_ADMIN_PHONE = '+2567XXXXXXXX'
php backend/bin/install.php
```

The installer never resets existing users and does not load demo data. Remove
installer credentials from the runtime environment after the first
administrator is provisioned. The first administrator must immediately rotate
the password and enroll in MFA.

## 5. Configure web server and proxy

Use an exact SPA document root and expose only `backend/api/` publicly.
Keep `backend/core/`, migrations, CLI tools, vendor tests, private files,
configuration, uploads, and backups outside or protected from HTTP access.

For Nginx, review `deploy/nginx/ntake.conf` and
`backend/nginx-security.conf`. Validate and reload:

```sh
nginx -t
nginx -s reload
```

For Apache/cPanel, use [docs/cpanel-deployment.md](docs/cpanel-deployment.md)
and the files in `deploy/cpanel/`. Ensure forwarded HTTPS is recognized by PHP
and that the `X-CSRF-Token` header and session cookie pass unchanged.

The browser credential is HttpOnly. State-changing requests require the
matching in-memory CSRF token. Do not use wildcard CORS for production.

## 6. Configure workers

Run CLI-only workers with the private runtime environment, outside the web
root:

```text
backup worker: every 5 minutes
scheduled backup: once daily
password-reset worker: once per minute
expired-session cleanup: once daily
SMS retry: at the deployment-approved interval
```

Capture worker exit status and logs in protected storage. Do not expose cron
endpoints or put secrets in URLs/process arguments. cPanel scheduling examples
are in [docs/cpanel-deployment.md](docs/cpanel-deployment.md).

## 7. Configure backups

Configure `BACKUP_STORAGE_DIR`, `BACKUP_ENCRYPTION_KEY`,
`BACKUP_RETENTION_DAYS`, `MYSQLDUMP_PATH`, and `MYSQL_PATH` for the PHP API and
workers. Store backup artifacts and the key in separate protected locations.
The key is required to restore any retained backup.

Before live use, perform the full restore drill in
[docs/backup-restore-runbook.md](docs/backup-restore-runbook.md). A backup UI
success is not a restore proof.

## 8. Smoke-test production

- [ ] Load the SPA over HTTPS with no mixed-content errors.
- [ ] Confirm `/backend/api/health.php` reports an accessible database.
- [ ] Sign in with the first administrator and complete MFA/password rotation.
- [ ] Confirm no mock mode or fixture credentials are reachable.
- [ ] Confirm cookie attributes and CSRF reject cross-site attempts.
- [ ] Verify an encryption-keyed backup is created and verified.
- [ ] Complete a scratch-database restore and record the evidence.
- [ ] Verify SMS reset and SMS retry behavior with approved test numbers.
- [ ] Verify audit logging and audit-grant checks.
- [ ] Check private directories return HTTP 404/403.
- [ ] Confirm scheduled workers write protected logs and exit successfully.
- [ ] Archive the release and rollback package outside the web root.

Do not use live payments, users, attendance, or learner records as deployment
smoke tests.
