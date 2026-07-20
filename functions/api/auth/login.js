import { createOAuthState, getOAuthStateCookieName, serializeCookie } from "../../_lib/auth.mjs";
import { safeReturnTo } from "../../_lib/return-to.mjs";

export async function onRequestGet({ request, env }) {
  if (!env.GOOGLE_CLIENT_ID || !env.AUTH_SECRET) {
    return new Response("Google OAuth is not configured", { status: 503 });
  }
  const requestUrl = new URL(request.url);
  const secure = requestUrl.protocol === "https:";
  const returnTo = safeReturnTo(requestUrl.searchParams.get("returnTo"));
  const state = await createOAuthState(env.AUTH_SECRET, returnTo);
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", new URL("/api/auth/callback", request.url).toString());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", requestUrl.searchParams.get("reauthorize") === "1" ? "consent" : "select_account");
  authUrl.searchParams.set("scope", "openid email https://www.googleapis.com/auth/drive.appdata");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": serializeCookie(getOAuthStateCookieName(), state, { maxAge: 600, secure }),
    },
  });
}
