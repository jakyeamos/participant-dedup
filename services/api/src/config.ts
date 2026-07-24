export interface ApiConfig {
  apiKey: string;
  googleServiceAccountJson: string;
  port: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadApiConfig(): ApiConfig {
  return {
    apiKey: requireEnv("API_KEY"),
    googleServiceAccountJson: requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
    port: Number(process.env.PORT ?? 3000),
  };
}
