export interface Config {
  publicUrl: URL;
  mealieUrl: string;
  mealiePublicUrl: string;
  mealieSessionLogin: boolean;
  encryptionKey: Buffer;
  allowedRedirectHosts: string[];
  trustCloudflare: boolean;
  authRateLimitPerMinute: number;
  port: number;
  dataDir: string;
  logLevel: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'localhost', '127.0.0.1'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const publicUrl = parseUrl('PUBLIC_URL', env.PUBLIC_URL, problems);
  if (publicUrl) {
    if (publicUrl.protocol !== 'https:' && !LOCAL_HOSTS.has(publicUrl.hostname)) {
      problems.push('PUBLIC_URL must use https:// (http:// is allowed only for localhost)');
    }
    if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      problems.push('PUBLIC_URL must be an origin without a path, e.g. https://mealie-mcp.example.com');
    }
  }
  const mealieUrl = parseUrl('MEALIE_URL', env.MEALIE_URL, problems);
  const mealiePublicUrl = env.MEALIE_PUBLIC_URL
    ? parseUrl('MEALIE_PUBLIC_URL', env.MEALIE_PUBLIC_URL, problems)
    : mealieUrl;
  const encryptionKey = parseKey(env.MCP_ENCRYPTION_KEY, problems);
  const port = parseIntVar('PORT', env.PORT, 8080, 1, 65535, problems);
  const authRateLimitPerMinute = parseIntVar('AUTH_RATE_LIMIT_PER_MINUTE', env.AUTH_RATE_LIMIT_PER_MINUTE, 10, 1, 100000, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    publicUrl: publicUrl!,
    mealieUrl: stripSlash(mealieUrl!.href),
    mealiePublicUrl: stripSlash(mealiePublicUrl!.href),
    // Same-origin deployment: the browser sends Mealie's own session cookie to our endpoints too,
    // so we can offer "sign in with your Mealie session" instead of only a pasted API token.
    mealieSessionLogin: mealiePublicUrl!.host === publicUrl!.host,
    encryptionKey: encryptionKey!,
    allowedRedirectHosts: parseList(env.ALLOWED_REDIRECT_HOSTS) ?? DEFAULT_REDIRECT_HOSTS,
    trustCloudflare: env.TRUST_CLOUDFLARE === 'true',
    authRateLimitPerMinute,
    port,
    dataDir: env.DATA_DIR ?? '/data',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

function parseUrl(name: string, value: string | undefined, problems: string[]): URL | undefined {
  if (!value) {
    problems.push(`${name} is required`);
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${name} must be an http:// or https:// URL`);
      return undefined;
    }
    return url;
  } catch {
    problems.push(`${name} is not a valid URL`);
    return undefined;
  }
}

function parseKey(value: string | undefined, problems: string[]): Buffer | undefined {
  if (!value) {
    problems.push('MCP_ENCRYPTION_KEY is required (generate with: openssl rand -base64 32)');
    return undefined;
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    problems.push('MCP_ENCRYPTION_KEY must be base64 for exactly 32 bytes (generate with: openssl rand -base64 32)');
    return undefined;
  }
  return key;
}

function parseIntVar(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  problems: string[]
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
