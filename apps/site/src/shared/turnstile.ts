// Server-side Turnstile check (Law 19). The widget alone does not protect a form.
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | undefined,
  expectedHostname: string,
): Promise<boolean> {
  // Tokens are at most 2048 characters long.
  if (!token || token.length > 2048) {
    return false;
  }
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const result = (await response.json()) as SiteverifyResult;
    // The hostname check stops a token issued on another site from being reused here.
    return result.success === true && result.hostname === expectedHostname;
  } catch {
    // Fail closed: if the check cannot run, signup does not go ahead.
    return false;
  }
}
