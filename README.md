# mealie-mcp

Connect Claude to your self-hosted [Mealie](https://github.com/mealie-recipes/mealie). Each person in your household signs in with their own Mealie account, and Claude works with their recipes, meal plans, and shopping lists as them.

> "What's for dinner this week? Add the ingredients to my shopping list."

It is a remote [MCP](https://modelcontextprotocol.io) server that runs next to Mealie in Docker. It works with Claude (web, Desktop, and mobile), Claude Code, and any MCP client that supports OAuth.

## What you need

- Mealie v3 running with Docker Compose. Tested with v3.27 and v3.28.
- Mealie reachable on a public HTTPS address, for example through Cloudflare Tunnel or a reverse proxy. Claude connects from Anthropic's cloud, even when you use Claude Desktop.

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

**Cloudflare Tunnel:** add a public hostname for your Mealie host with path `^/(mcp|\.well-known/oauth-)` and service `http://mealie-mcp:8080` (or `http://<docker-host>:9926`). Put it above your existing Mealie entry for that host. Do not put Cloudflare Access in front of these paths, because it blocks Claude's servers. If you use Cloudflare, also set `TRUST_CLOUDFLARE: "true"`.

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

## 3. Connect Claude

1. In Claude, open Settings, then Connectors, then Add custom connector.
2. Enter `https://mealie.yourdomain.com/mcp` and click Connect.
3. If you are signed in to Mealie in that browser, click Allow. Otherwise sign in to Mealie first, then click Continue.

For Claude Code:

```bash
claude mcp add --transport http mealie https://mealie.yourdomain.com/mcp
```

Each person connects with their own account. Connecting creates a Mealie API token named "Claude MCP: ..." on their profile. To disconnect, delete that token in Mealie under Profile, then API Tokens.

## What Claude can do

- **Recipes:** search, read, create, import from a URL, update, delete, duplicate, suggest from ingredients on hand, parse ingredients, mark as made, bulk tag.
- **Meal plans:** list, see today's meals, add, move, delete, add a random meal.
- **Shopping lists:** list, read, create, delete, add, check off and remove items, add or remove a recipe's ingredients.
- **Catalog:** foods, units, tags, categories, tools, and cookbooks.
- **Anything else:** a guarded raw API tool for other Mealie endpoints. It cannot reach admin, login, or account endpoints.

Everything runs with the signed-in person's Mealie permissions.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PUBLIC_URL` | yes | | Public origin Claude uses, e.g. `https://mealie.yourdomain.com` |
| `MEALIE_URL` | yes | | Mealie as the container sees it, e.g. `http://mealie:9000` |
| `MEALIE_PUBLIC_URL` | no | `MEALIE_URL` | Mealie's public address. When it has the same host as `PUBLIC_URL`, one-click sign-in is on |
| `MCP_ENCRYPTION_KEY` | yes | | Base64 of 32 random bytes. Changing it signs everyone out |
| `TRUST_CLOUDFLARE` | no | `false` | Rate-limit by `CF-Connecting-IP` when behind Cloudflare |
| `AUTH_RATE_LIMIT_PER_MINUTE` | no | `10` | Sign-in and token requests per IP per minute |
| `ALLOWED_REDIRECT_HOSTS` | no | `claude.ai,claude.com,localhost,127.0.0.1` | Apps that may receive sign-in codes |
| `PORT` | no | `8080` | Listen port inside the container |
| `DATA_DIR` | no | `/data` | Where the SQLite database lives |
| `LOG_LEVEL` | no | `info` | Log level |

## Security

- Mealie tokens are encrypted at rest with AES-256-GCM. Claude's tokens are stored only as SHA-256 hashes.
- Claude's refresh tokens rotate on every use. Reusing an old one signs that connection out.
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
