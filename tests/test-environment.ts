const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertLocalUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must target localhost (received ${url.hostname})`);
  }
  return url;
}

export function assertSafeTestDatabase(rawUrl: string | undefined): string {
  if (!rawUrl) {
    throw new Error('TEST_DATABASE_URL is required for destructive local tests');
  }
  const url = assertLocalUrl(rawUrl, 'TEST_DATABASE_URL');
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/(^|[_-])test($|[_-])|test/i.test(databaseName)) {
    throw new Error(
      `TEST_DATABASE_URL database name must contain "test" (received "${databaseName}")`,
    );
  }
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('NODE_ENV=test is required for destructive local tests');
  }
  return rawUrl;
}

export function configureSafeTestDatabase(): string {
  const connectionString = assertSafeTestDatabase(process.env.TEST_DATABASE_URL);
  process.env.DATABASE_URL = connectionString;
  return connectionString;
}

export function assertDestructiveE2EEnvironment(baseUrl: string): void {
  assertLocalUrl(baseUrl, 'E2E_BASE_URL');
  const testDatabaseUrl = assertSafeTestDatabase(process.env.TEST_DATABASE_URL);
  if (process.env.DATABASE_URL !== testDatabaseUrl) {
    throw new Error('DATABASE_URL must exactly match TEST_DATABASE_URL for destructive E2E');
  }
  if (process.env.E2E_ALLOW_DESTRUCTIVE !== '1') {
    throw new Error('E2E_ALLOW_DESTRUCTIVE=1 is required because this script truncates data');
  }
}
