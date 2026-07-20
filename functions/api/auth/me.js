import { createAccountId, createSessionCookie, getSessionUser, serializeCookie, SESSION_COOKIE, SESSION_MAX_AGE } from "../../_lib/auth.mjs";

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ authenticated: false });
  const session = await createSessionCookie(env.AUTH_SECRET, user.google_sub);
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.set("Set-Cookie", serializeCookie(SESSION_COOKIE, session, {
    maxAge: SESSION_MAX_AGE,
    secure: new URL(request.url).protocol === "https:",
  }));
  return Response.json({
    authenticated: true,
    accountId: await createAccountId(env.AUTH_SECRET, user.google_sub),
    email: user.email || null,
  }, { headers });
}
