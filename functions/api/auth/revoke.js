import { decryptSecret, deleteUser, getSessionUser, serializeCookie, SESSION_COOKIE } from "../../_lib/auth.mjs";

export async function onRequestPost({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return Response.json({ error: "authorization_required" }, { status: 401 });

  try {
    const refreshToken = await decryptSecret(env.AUTH_SECRET, user.refresh_token_ciphertext);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } finally {
    await deleteUser(env, user.google_sub);
  }

  const secure = new URL(request.url).protocol === "https:";
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure }) },
  });
}
