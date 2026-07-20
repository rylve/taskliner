import { SESSION_COOKIE, serializeCookie } from "../../_lib/auth.mjs";

export async function onRequestPost({ request }) {
  const secure = new URL(request.url).protocol === "https:";
  return new Response(null, { status: 204, headers: { "Set-Cookie": serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure }) } });
}
