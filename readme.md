# Dokploy CLI

Dokploy CLI is a command-line tool to manage your Dokploy server remotely. It provides **524 commands** auto-generated from the Dokploy OpenAPI spec, covering every API endpoint.

## Installation

```bash
npm install -g @dokploy/cli
```

## Authentication

### Option 1: Using the `auth` command

```bash
dokploy auth -u https://panel.dokploy.com -t YOUR_API_KEY
```

### Option 2: Environment variables

```bash
export DOKPLOY_URL="https://panel.dokploy.com"
export DOKPLOY_API_KEY="YOUR_API_KEY"
```

### Option 3: `.env` file

Create a `.env` file in your working directory:

```env
DOKPLOY_URL="https://panel.dokploy.com"
DOKPLOY_API_KEY="YOUR_API_KEY"
```

The CLI loads it automatically. Shell environment variables take priority over the `.env` file.

## Usage

```bash
dokploy <group> <action> [options]
```

### Examples

```bash
# List all projects
dokploy project all

# Get a specific project
dokploy project one --projectId abc123

# Create an application
dokploy application create --name "my-app" --environmentId env123

# Deploy an application
dokploy application deploy --applicationId app123

# Create a postgres database
dokploy postgres create --name "my-db" --environmentId env123

# Stop a database
dokploy postgres stop --postgresId pg123

# Get raw JSON output
dokploy project all --json

# Read bounded deployment logs from the latest application deployment
dokploy deployment read-logs --applicationId app123 --tail 200 --json
```

### Getting help

```bash
# List all groups
dokploy --help

# List actions in a group
dokploy application --help

# See options for a specific action
dokploy application deploy --help
```

## Available command groups

| Group | Commands | Group | Commands |
|---|---|---|---|
| `admin` | 1 | `mysql` | 16 |
| `ai` | 12 | `notification` | 41 |
| `application` | 31 | `organization` | 11 |
| `audit-log` | 1 | `patch` | 12 |
| `backup` | 12 | `port` | 4 |
| `bitbucket` | 7 | `postgres` | 16 |
| `certificates` | 5 | `preview-deployment` | 4 |
| `cluster` | 4 | `project` | 9 |
| `compose` | 30 | `redirects` | 4 |
| `custom-role` | 6 | `redis` | 16 |
| `deployment` | 8 | `registry` | 7 |
| `destination` | 6 | `rollback` | 2 |
| `docker` | 12 | `schedule` | 6 |
| `domain` | 9 | `security` | 4 |
| `environment` | 7 | `server` | 17 |
| `gitea` | 8 | `settings` | 51 |
| `github` | 6 | `ssh-key` | 7 |
| `gitlab` | 7 | `sso` | 10 |
| `git-provider` | 4 | `stripe` | 8 |
| `libsql` | 14 | `swarm` | 4 |
| `license-key` | 6 | `tag` | 8 |
| `mariadb` | 16 | `user` | 23 |
| `mongo` | 16 | `volume-backups` | 6 |
| `mounts` | 6 | `whitelabeling` | 4 |

## Development

```bash
# Install dependencies
pnpm install

# Run in dev mode
pnpm run dev -- project all

# Regenerate commands from OpenAPI spec
pnpm run generate

# Build
pnpm run build

# Check lint and types
pnpm run check

# Format source files
pnpm run fmt
```

### Updating commands

Commands are auto-generated from `openapi.json`. To update:

1. Replace `openapi.json` with the latest spec from the [Dokploy repo](https://github.com/Dokploy/dokploy)
2. Run `pnpm run generate`
3. Build with `pnpm run build`

## Contributing

If you want to contribute to Dokploy CLI, please check out our [Contributing Guide](https://github.com/Dokploy/cli/blob/main/CONTRIBUTING.md).

## Support

If you encounter any issues or have any questions, please [open an issue](https://github.com/Dokploy/cli/issues) in our GitHub repository.

## License

This project is licensed under the [MIT License](LICENSE).
