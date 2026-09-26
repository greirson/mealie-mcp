# mealie-mcp

Connect your AI app (Claude, ChatGPT, Cursor, VS Code, and others) to your self-hosted [Mealie](https://github.com/mealie-recipes/mealie). Each person in your household signs in with their own Mealie account, and their app works with their recipes, meal plans, and shopping lists as them.

> "What's for dinner this week? Add the ingredients to my shopping list."

It is a remote [MCP](https://modelcontextprotocol.io) server that runs next to Mealie in Docker, using Streamable HTTP and OAuth 2.1 with dynamic client registration and PKCE. It works with Claude (web, Desktop, and mobile), Claude Code, ChatGPT, Cursor, VS Code, Gemini CLI, Codex CLI, and any other MCP client that supports OAuth.

## What you need

- Mealie v3 running with Docker Compose. Tested with v3.27 and v3.28.
- Mealie reachable on a public HTTPS address, for example through Cloudflare Tunnel or a reverse proxy. Cloud apps such as Claude and ChatGPT connect from their provider's servers, so they need this public address. Desktop and CLI apps such as Claude Desktop, Cursor, and Codex CLI connect from your own machine, but they use the same public URL.

## 1. Add it to your compose file

Add the `mealie-mcp` service and its volume to the compose file that runs Mealie. This is Mealie's [PostgreSQL example](https://docs.mealie.io/documentation/getting-started/installation/postgres/) with the additions:

```yaml
services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:v3.28.0
    container_name: mealie
    # ... everything else unchanged from Mealie's docs ...
    environment:
      BASE_URL: https://mealie.yourdomain.com
      # ...

  postgres:
    # ... unchanged ...

  mealie-mcp:
    image: ghcr.io/greirson/mealie-mcp:latest
    container_name: mealie-mcp
    restart: always
    ports:
      - "9926:8080"   # only needed if your proxy or tunnel reaches it through the host
    volumes:
      - mealie-mcp-data:/data
    environment:
      PUBLIC_URL: https://mealie.yourdomain.com         # same as Mealie's BASE_URL
      MEALIE_URL: http://mealie:9000
      MEALIE_PUBLIC_URL: https://mealie.yourdomain.com
      MCP_ENCRYPTION_KEY: ${MCP_ENCRYPTION_KEY}
    depends_on:
      - mealie

volumes:
  mealie-data:
  mealie-pgdata:
  mealie-mcp-data:
```

The full file is in [docker-compose.example.yml](docker-compose.example.yml).

Create the encryption key once, in the same folder as the compose file, and keep it safe:

```bash
echo "MCP_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

## 2. Send `/mcp` to it

Serve the MCP on Mealie's own address. Your proxy sends these two path prefixes to `mealie-mcp` on port 8080, and everything else to Mealie as before:

- `/mcp`
- `/.well-known/oauth-`

Sharing Mealie's address is what lets people connect with one click, using the Mealie login they already have.

**Cloudflare Tunnel:** add a public hostname for your Mealie host with path `^/(mcp|\.well-known/oauth-)` and service `http://mealie-mcp:8080` (or `http://<docker-host>:9926`). Put it above your existing Mealie entry for that host. Do not put Cloudflare Access in front of these paths, because it blocks cloud apps' servers (Claude, ChatGPT, and similar). If you use Cloudflare, also set `TRUST_CLOUDFLARE: "true"`.

**Caddy:**

```
mealie.yourdomain.com {
    @mcp path /mcp /mcp/* /.well-known/oauth-*
    reverse_proxy @mcp mealie-mcp:8080
    reverse_proxy mealie:9000
}
```

**Traefik:** route ``PathPrefix(`/mcp`) || PathPrefix(`/.well-known/oauth-`)`` on your Mealie host to `mealie-mcp:8080`, with a higher priority than the Mealie router.

Check it: this should return JSON whose endpoints start with `https://mealie.yourdomain.com/mcp/oauth/`.

```bash
curl https://mealie.yourdomain.com/.well-known/oauth-authorization-server
```

You can also give the MCP its own hostname instead. Set `PUBLIC_URL` to that hostname. People then connect by pasting a Mealie API token instead of clicking Allow.

## 3. Connect your app

### Claude (web, Desktop, mobile)

1. In Claude, open Settings, then Connectors, then Add custom connector.
2. Enter `https://mealie.yourdomain.com/mcp` and click Connect.
3. If you are signed in to Mealie in that browser, click Allow. Otherwise sign in to Mealie first, then click Continue.

### Claude Code

```bash
claude mcp add --transport http mealie https://mealie.yourdomain.com/mcp
```

### ChatGPT

Mealie's write tools (create, update, delete) need [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode), available on Pro, Plus, Business, Enterprise, and Education plans on the web. Open Settings, then Security and login, and turn on Developer mode. Go to ChatGPT Plugins, select the plus button, and add `https://mealie.yourdomain.com/mcp` as a developer-mode app. Approve the OAuth sign-in when prompted.

### Codex CLI

Add an `[mcp_servers.mealie]` table to `~/.codex/config.toml` (or a project's `.codex/config.toml`):

```toml
[mcp_servers.mealie]
url = "https://mealie.yourdomain.com/mcp"
```

Then sign in:

```bash
codex mcp login mealie
```

The ChatGPT desktop app and the Codex IDE extension read the same configuration.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mealie": {
      "url": "https://mealie.yourdomain.com/mcp"
    }
  }
}
```

Cursor opens a browser for the OAuth sign-in the first time you use a tool.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "mealie": {
      "type": "http",
      "url": "https://mealie.yourdomain.com/mcp"
    }
  }
}
```

VS Code prompts for the OAuth sign-in the first time you use a tool.

### Gemini CLI

Add to `~/.gemini/settings.json` (or a project's `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "mealie": {
      "httpUrl": "https://mealie.yourdomain.com/mcp"
    }
  }
}
```

Gemini CLI discovers the OAuth configuration automatically and opens a browser to sign in.

### Other apps

Any MCP client with Streamable HTTP and OAuth support can connect the same way: add a remote server with URL `https://mealie.yourdomain.com/mcp`. For a client that only launches local (stdio) servers, bridge it with [mcp-remote](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "mealie": {
      "command": "npx",
      "args": ["mcp-remote", "https://mealie.yourdomain.com/mcp"]
    }
  }
}
```

Each person connects with their own account. Connecting creates a Mealie API token named `MCP: <app name> <YYYY-MM-DD>` on their profile; the name shows which app connected. To disconnect, delete that token in Mealie under Profile, then API Tokens. Tokens created before this change keep their old `Claude MCP: ...` name.

## What it can do

- **Recipes:** search, read, create, import from a URL, update, delete, duplicate, suggest from ingredients on hand, parse ingredients, mark as made, bulk tag.
- **Meal plans:** list, see today's meals, add, move, delete, add a random meal.
- **Shopping lists:** list, read, create, delete, add, check off and remove items, add or remove a recipe's ingredients.
- **Catalog:** foods, units, tags, categories, tools, and cookbooks.
- **Anything else:** a guarded raw API tool for other Mealie endpoints. It cannot reach admin, login, or account endpoints.

Everything runs with the signed-in person's Mealie permissions.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PUBLIC_URL` | yes | | Public origin apps use, e.g. `https://mealie.yourdomain.com` |
| `MEALIE_URL` | yes | | Mealie as the container sees it, e.g. `http://mealie:9000` |
| `MEALIE_PUBLIC_URL` | no | `MEALIE_URL` | Mealie's public address. When it has the same host as `PUBLIC_URL`, one-click sign-in is on |
| `MCP_ENCRYPTION_KEY` | yes | | Base64 of 32 random bytes. Changing it signs everyone out |
| `TRUST_CLOUDFLARE` | no | `false` | Rate-limit by `CF-Connecting-IP` when behind Cloudflare |
| `AUTH_RATE_LIMIT_PER_MINUTE` | no | `10` | Sign-in and token requests per IP per minute |
| `ALLOWED_REDIRECT_HOSTS` | no | `claude.ai,claude.com,chatgpt.com,vscode.dev` | Web apps (https) that may receive sign-in codes; loopback and app URL schemes are handled by `ALLOW_NATIVE_APP_REDIRECTS` |
| `ALLOW_NATIVE_APP_REDIRECTS` | no | `true` | Allow loopback redirects (`localhost`, `127.0.0.1`, `[::1]`, any port) and app URL schemes (e.g. `cursor://`) by default. Set to `false` to only allow apps listed in `ALLOWED_REDIRECT_HOSTS` |
| `PORT` | no | `8080` | Listen port inside the container |
| `DATA_DIR` | no | `/data` | Where the SQLite database lives |
| `LOG_LEVEL` | no | `info` | Log level |

To allow another web app to sign in, find its redirect host (the sign-in error names it) and add it to `ALLOWED_REDIRECT_HOSTS`.

## Security

- Mealie tokens are encrypted at rest with AES-256-GCM. Tokens issued to apps are stored only as SHA-256 hashes.
- Refresh tokens rotate on every use. Reusing an old one signs that connection out.
- The sign-in page shows which app is asking and where the code goes, and only accepts submissions from the page itself.
- Recipe text imported from websites is untrusted. The raw API tool blocks endpoints that could create credentials, invite users, or change passwords, even if a prompt injection asks for them.

## Development

Requires Node 24 and Docker.

```bash
npm install
npm test            # unit and end-to-end tests with a mocked Mealie
npm run typecheck
npm run live:up     # throwaway Mealie on :9925 plus this server on :8080
npm run test:live   # exercise every tool against the real Mealie
npm run live:down
```

## License

[MIT](LICENSE). Not affiliated with the Mealie project.
