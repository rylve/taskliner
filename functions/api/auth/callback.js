import {
  createSessionCookie,
  getOAuthStateCookieName,
  parseCookies,
  readOAuthState,
  serializeCookie,
  upsertUser,
  SESSION_COOKIE,
} from "../../_lib/auth.mjs";
import { safeReturnTo } from "../../_lib/return-to.mjs";

function redirectWithError(request, returnTo, code, clearState = null) {
  const target = new URL(returnTo || "/", request.url);
  target.searchParams.set("oauth_error", code);
  const headers = new Headers({ Location: target.toString() });
  if (clearState) headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const cookies = parseCookies(request);
  const state = await readOAuthState(env.AUTH_SECRET, cookies[getOAuthStateCookieName()]);
  const clearState = serializeCookie(getOAuthStateCookieName(), "", { maxAge: 0, secure });
  if (!state) return new Response("Invalid OAuth state", { status: 400, headers: { "Set-Cookie": clearState } });
  const returnTo = safeReturnTo(state.returnTo);
  if (url.searchParams.get("error")) return redirectWithError(request, returnTo, url.searchParams.get("error"), clearState);
  const code = url.searchParams.get("code");
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.DB) {
    return new Response("Google OAuth is not configured", { status: 503, headers: { "Set-Cookie": clearState } });
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL("/api/auth/callback", request.url).toString(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return redirectWithError(request, returnTo, "token_exchange_failed", clearState);
  const token = await tokenResponse.json();
  const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userResponse.ok) return redirectWithError(request, returnTo, "userinfo_failed", clearState);
  const user = await userResponse.json();
  if (typeof user.sub !== "string" || !user.sub) return redirectWithError(request, returnTo, "missing_google_account", clearState);

  try {
    await upsertUser(env, { googleSub: user.sub, email: user.email, refreshToken: token.refresh_token });
    const session = await createSessionCookie(env.AUTH_SECRET, user.sub);
    const headers = new Headers({ Location: returnTo });
    headers.append("Set-Cookie", clearState);
    headers.append("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { maxAge: 60 * 60 * 24 * 30, secure }));
    return new Response(null, {
      status: 302,
      headers,
    });
  } catch {
    return redirectWithError(request, returnTo, "session_setup_failed", clearState);
  }
}
